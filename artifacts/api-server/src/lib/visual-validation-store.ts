import { randomUUID } from "node:crypto";
import type {
  VisualValidationDiscrepancyReport,
  VisualValidationReview,
  VisualValidationReviewStatus,
  VisualValidationSet,
  VisualValidationSnapshot,
} from "./visual-validation.js";

type StoredVisualValidationSet = {
  set: VisualValidationSet;
  reviews: Map<string, VisualValidationReview>;
  lastAccessedAt: number;
};

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
      ? { status: review.status, note: review.note, reviewedAt: review.reviewedAt }
      : { status: "unreviewed", note: null, reviewedAt: null },
  };
}

export function storeVisualValidationSet(set: Omit<VisualValidationSet, "reviewSetId" | "createdAt">): VisualValidationSet {
  prune();
  const stored: StoredVisualValidationSet = {
    set: { ...set, reviewSetId: randomUUID(), createdAt: new Date().toISOString() },
    reviews: new Map(),
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
  return {
    ...stored.set,
    snapshots: stored.set.snapshots.map((snapshot) => hydratedSnapshot(snapshot, stored.reviews.get(snapshot.snapshotId))),
  };
}

export function recordVisualValidationReview(
  reviewSetId: string,
  snapshotId: string,
  status: Exclude<VisualValidationReviewStatus, "unreviewed">,
  note: string | null,
): VisualValidationReview | null {
  prune();
  const stored = sets.get(reviewSetId);
  if (!stored || !stored.set.snapshots.some((snapshot) => snapshot.snapshotId === snapshotId)) return null;
  const review: VisualValidationReview = {
    reviewId: randomUUID(),
    reviewSetId,
    snapshotId,
    status,
    note: note?.trim() ? note.trim().slice(0, 2000) : null,
    reviewedAt: new Date().toISOString(),
  };
  stored.reviews.set(snapshotId, review);
  stored.lastAccessedAt = Date.now();
  return review;
}

export function buildVisualValidationDiscrepancyReport(reviewSetId: string): VisualValidationDiscrepancyReport | null {
  prune();
  const stored = sets.get(reviewSetId);
  if (!stored) return null;
  stored.lastAccessedAt = Date.now();
  const discrepancies = stored.set.snapshots.flatMap((snapshot) => {
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
  return {
    reviewSetId,
    generatedAt: new Date().toISOString(),
    formulaHash: stored.set.formulaHash,
    totalSnapshots: stored.set.snapshots.length,
    reviewedSnapshots: stored.reviews.size,
    discrepancies,
  };
}
