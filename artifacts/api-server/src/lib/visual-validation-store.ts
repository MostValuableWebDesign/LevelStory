import { randomUUID } from "node:crypto";
import type {
  VisualValidationProposedRuleAnalysis,
  VisualValidationDiscrepancyReport,
  VisualValidationReview,
  VisualValidationReviewStatus,
  VisualValidationSet,
  VisualValidationSnapshot,
  VisualValidationTeachingInput,
} from "./visual-validation.js";
import {
  buildProposedRuleAnalysis,
  createVisualValidationTeachingExample,
} from "./visual-validation.js";
import { canonicalStrategyId } from "./strategy/taxonomy.js";
import { APPLICATION_BUILD_ID } from "./build-metadata.js";
import {
  visualValidationCacheMetadata,
} from "./visual-validation-cache.js";

type StoredVisualValidationSet = {
  set: VisualValidationSet;
  reviews: Map<string, VisualValidationReview>;
  reviewHistory: VisualValidationReview[];
  lastAccessedAt: number;
};

export function resolveObservedEntryCandle(
  snapshot: VisualValidationSnapshot,
  machineTrade: { entryTime: string; audit?: { triggerCandleOpenTime?: string | null; triggerCandleCloseTime?: string | null } },
): VisualValidationSnapshot["reviewCandles"][number] | undefined {
  const triggerOpen = machineTrade.audit?.triggerCandleOpenTime;
  const triggerClose = machineTrade.audit?.triggerCandleCloseTime;
  if (triggerOpen && triggerClose) {
    const audited = snapshot.reviewCandles.find((candle) =>
      candle.isComplete && candle.openTime === triggerOpen && candle.closeTime === triggerClose);
    if (audited) return audited;
  }
  const entryTime = Date.parse(machineTrade.entryTime);
  if (!Number.isFinite(entryTime)) return undefined;
  return snapshot.reviewCandles.find((candle) => candle.isComplete && Date.parse(candle.closeTime) === entryTime)
    ?? snapshot.reviewCandles.find((candle) =>
      candle.isComplete
      && Date.parse(candle.openTime) < entryTime
      && entryTime <= Date.parse(candle.closeTime));
}

const MAX_STORED_SETS = 6;
const SET_TTL_MS = 30 * 60_000;
const sets = new Map<string, StoredVisualValidationSet>();
let latestSetId: string | null = null;

function prune(): void {
  const now = Date.now();
  for (const [id, stored] of sets) {
    if (now - stored.lastAccessedAt > SET_TTL_MS) {
      sets.delete(id);
      if (id === latestSetId) latestSetId = null;
    }
  }
  while (sets.size > MAX_STORED_SETS) {
    const oldest = [...sets.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
    if (!oldest) return;
    sets.delete(oldest[0]);
    if (oldest[0] === latestSetId) latestSetId = null;
  }
}

function hydratedSnapshot(snapshot: VisualValidationSnapshot, review: VisualValidationReview | undefined): VisualValidationSnapshot {
  return {
    ...snapshot,
    review: review
      ? { status: review.status, note: review.note, reviewedAt: review.reviewedAt, ...(review.teaching ? { teaching: review.teaching } : {}) }
      : { status: "unreviewed", note: null, reviewedAt: null },
  };
}

function currentVersionsMatch(set: Omit<VisualValidationSet, "reviewSetId" | "createdAt">): boolean {
  const expected = visualValidationCacheMetadata(set.request, set.sourceFingerprint, set.sessionCalendarVersion);
  return set.cacheKeyVersion === expected.cacheKeyVersion
    && set.strategyVersion === expected.strategyVersion
    && set.formulaHash === expected.formulaHash
    && set.formulaVersion === expected.formulaVersion
    && set.candidateProjectionVersion === expected.candidateProjectionVersion
    && set.executionManagementVersion === expected.executionManagementVersion
    && set.snapshotProjectionVersion === expected.snapshotProjectionVersion
    && set.chartProjectionVersion === expected.chartProjectionVersion
    && set.sessionCalendarVersion === expected.sessionCalendarVersion;
}

export function storeVisualValidationSet(
  set: Omit<VisualValidationSet, "reviewSetId" | "createdAt">,
  options: Partial<Pick<VisualValidationSet, "generationOrigin" | "cacheKey" | "cacheKeyVersion" | "strategyVersion" | "formulaHash" | "formulaVersion" | "candidateProjectionVersion" | "executionManagementVersion" | "snapshotProjectionVersion" | "chartProjectionVersion" | "sessionCalendarVersion">> = {},
): VisualValidationSet {
  prune();
  const stored: StoredVisualValidationSet = {
    set: {
      ...set,
       ...options,
      reviewSetId: randomUUID(),
      createdAt: new Date().toISOString(),
      currentBuildId: APPLICATION_BUILD_ID,
       stale: set.buildId !== APPLICATION_BUILD_ID || !currentVersionsMatch({ ...set, ...options }),
    },
    reviews: new Map(),
    reviewHistory: [],
    lastAccessedAt: Date.now(),
  };
  sets.set(stored.set.reviewSetId, stored);
  latestSetId = stored.set.reviewSetId;
  return getVisualValidationSet(stored.set.reviewSetId)!;
}

export function getLatestVisualValidationSet(): VisualValidationSet | null {
  prune();
  return latestSetId ? getVisualValidationSet(latestSetId) : null;
}

export function getVisualValidationSet(reviewSetId: string): VisualValidationSet | null {
  prune();
  const stored = sets.get(reviewSetId);
  if (!stored) return null;
  stored.lastAccessedAt = Date.now();
  const clonedSet = structuredClone(stored.set);
  return {
    ...clonedSet,
    snapshots: clonedSet.snapshots.map((snapshot) => hydratedSnapshot(snapshot, stored.reviews.get(snapshot.snapshotId))),
  };
}

export function recordVisualValidationReview(
  reviewSetId: string,
  snapshotId: string,
  status: Exclude<VisualValidationReviewStatus, "unreviewed">,
  note: string | null,
  teachingInput?: VisualValidationTeachingInput,
): VisualValidationReview | null {
  prune();
  const stored = sets.get(reviewSetId);
  const snapshot = stored?.set.snapshots.find((item) => item.snapshotId === snapshotId);
  if (!stored || !snapshot) return null;
  if ((status === "missed_trade" || status === "false_positive_trade") && !teachingInput) throw new Error("A structured teaching form is required before submission.");
  if (teachingInput && teachingInput.judgment !== "missed_trade" && teachingInput.judgment !== "false_positive_trade") {
    throw new Error("Teaching judgment must be missed_trade or false_positive_trade.");
  }
  if (status === "missed_trade" && teachingInput?.judgment !== "missed_trade") {
    throw new Error("Missed trade submissions must include a missed_trade teaching judgment.");
  }
  if (status === "false_positive_trade" && teachingInput?.judgment !== "false_positive_trade") {
    throw new Error("False-positive submissions must include a false_positive_trade teaching judgment.");
  }
  const previous = stored.reviews.get(snapshotId);
  const reviewId = randomUUID();
  const teaching = teachingInput
    ? createVisualValidationTeachingExample(snapshot, teachingInput, previous?.reviewId ?? null)
    : undefined;
  if (status === "missed_trade" && teaching && !teaching.validation.valid) {
    throw new Error(`This missed-trade correction is invalid. Submit Rule needs clarification instead: ${teaching.validation.messages.join(" ")}`);
  }
  if (status === "false_positive_trade") {
    const machineTrade = snapshot.machineEvidence.trade;
    if (!machineTrade) throw new Error("False-positive trade requires an exact machine trade in this snapshot.");
    if (!teaching || !teaching.validation.valid) throw new Error("False-positive teaching evidence failed causal validation.");
    const observedEntryCandle = resolveObservedEntryCandle(snapshot, machineTrade);
    const expectedEntryOpen = machineTrade.audit?.triggerCandleOpenTime ?? observedEntryCandle?.openTime ?? machineTrade.entryTime;
    const expectedEntryClose = machineTrade.audit?.triggerCandleCloseTime ?? observedEntryCandle?.closeTime ?? null;
    if (
      teaching.machineTradeId && teaching.machineTradeId !== machineTrade.id
      || teaching.direction !== machineTrade.direction
      || teaching.entryCandleOpenTime !== expectedEntryOpen
      || (expectedEntryClose !== null && teaching.entryCandleCloseTime !== expectedEntryClose)
      || stored.set.snapshots.find((candidate) => candidate.snapshotId === snapshotId)?.contractSymbol !== machineTrade.contractSymbol
      || canonicalStrategyId(teaching.setupType) !== canonicalStrategyId(machineTrade.setupType)
    ) {
      throw new Error("False-positive teaching must match the exact machine trade identity, contract, strategy, direction, and entry interval.");
    }
    if (Math.abs(teaching.calculatedEntryPrice - machineTrade.entryPrice) > 0.01) {
      throw new Error("False-positive teaching entry price must match the machine trade.");
    }
  }
  const review: VisualValidationReview = {
    reviewId,
    reviewSetId,
    snapshotId,
    status,
    note: note?.trim() ? note.trim().slice(0, 2000) : null,
    reviewedAt: new Date().toISOString(),
    ...(teaching ? { teaching } : {}),
    supersedesReviewId: previous?.reviewId ?? null,
    revision: (previous?.revision ?? 0) + 1,
  };
  stored.reviews.set(snapshotId, review);
  stored.reviewHistory.push(structuredClone(review));
  stored.lastAccessedAt = Date.now();
  return review;
}

export function analyzeVisualValidationTeaching(
  reviewSetId: string,
  teachingId?: string,
): VisualValidationProposedRuleAnalysis | null {
  prune();
  const stored = sets.get(reviewSetId);
  if (!stored) return null;
  stored.lastAccessedAt = Date.now();
  return buildProposedRuleAnalysis(reviewSetId, stored.set.formulaHash, stored.set.formulaVersion, [...stored.reviews.values()], teachingId);
}

export function buildVisualValidationDiscrepancyReport(reviewSetId: string): VisualValidationDiscrepancyReport | null {
  prune();
  const stored = sets.get(reviewSetId);
  if (!stored) return null;
  stored.lastAccessedAt = Date.now();
  const reviews = stored.set.snapshots.flatMap((snapshot) => {
    const review = stored.reviews.get(snapshot.snapshotId);
    if (!review) return [];
    return [{
      snapshotId: snapshot.snapshotId,
      category: snapshot.category,
      categoryLabel: snapshot.categoryLabel,
      machineLabel: snapshot.machineLabel,
      reviewerStatus: review.status,
      note: review.note,
      tradingDate: snapshot.tradingDate,
      evaluationCursor: snapshot.evaluationCursor,
      machineEvidence: {
        decision: snapshot.machineEvidence.audit.decision,
        rejectionCategory: snapshot.machineEvidence.audit.rejectionCategory,
        setupType: snapshot.machineEvidence.audit.setupType,
        direction: snapshot.machineEvidence.audit.direction,
        eventLabels: snapshot.machineEvidence.audit.eventLabels,
        ambiguityLabels: snapshot.machineEvidence.audit.ambiguityLabels,
      },
    }];
  });
  const discrepancies = reviews.filter((review) => review.reviewerStatus === "incorrect" || review.reviewerStatus === "uncertain");
  return {
    reviewSetId,
    generatedAt: new Date().toISOString(),
    formulaHash: stored.set.formulaHash,
    totalSnapshots: stored.set.snapshots.length,
    reviewedSnapshots: stored.reviews.size,
    reviews,
    discrepancies,
    reviewHistory: structuredClone(stored.reviewHistory),
  };
}
