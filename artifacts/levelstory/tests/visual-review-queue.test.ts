import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewQueue } from "../src/lib/visual-review-queue.ts";
import type {
  VisualValidationSet,
  VisualValidationSnapshot,
  VisualValidationTradeCandidate,
} from "@workspace/api-client-react";

function candidate(id: string, snapshotId: string, strategy = "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION"): VisualValidationTradeCandidate {
  return {
    candidateId: id,
    snapshotId,
    signalOccurrenceId: `${id}-occurrence`,
    contractSymbol: "MESZ6",
    tradingDate: "2026-09-10",
    entryCandleOpenTime: `2026-09-10T14:${id === "c1" ? "25" : "30"}:00.000Z`,
    entryCandleCloseTime: `2026-09-10T14:${id === "c1" ? "30" : "35"}:00.000Z`,
    direction: "long",
    entryTriggerPrice: 5000,
    primaryEdge: strategy,
    matchedEdges: [strategy],
    supportingConfluences: [],
    setupGrade: "A",
    period: "in_sample",
    outcome: "win",
    causalEvidence: [],
  };
}

function snapshot(snapshotId: string, strategyKey: VisualValidationSnapshot["strategyKey"]): VisualValidationSnapshot {
  return {
    snapshotId,
    sampleIndex: 1,
    category: "qualified_trade",
    categoryLabel: "Qualified trade",
    machineLabel: "Trade",
    strategyKey,
    formulaHash: "a".repeat(64),
    formulaVersion: "test",
    symbol: "MES",
    contractSymbol: "MESZ6",
    contractMonth: "2026-12",
    tradingDate: "2026-09-10",
    entryWindow: "primary",
    selectionReason: "test",
    period: "in_sample",
    evaluationCursor: {
      openTime: "2026-09-10T14:25:00.000Z",
      closeTime: "2026-09-10T14:30:00.000Z",
      newYork: "10:30 AM EDT",
      utc: "2026-09-10T14:30:00.000Z",
      visibleCandleCount: 1,
      futureCandleAccess: false,
    },
    reviewCursor: {
      closeTime: "2026-09-10T14:30:00.000Z",
      newYork: "10:30 AM EDT",
      utc: "2026-09-10T14:30:00.000Z",
    },
    machineCandles: [],
    reviewCandles: [],
    premarketCandles: [],
    indicatorSeries: [],
    tradeEvents: [],
    coverage: [],
    outcomeContextEnd: "2026-09-10T15:00:00.000Z",
    futureCandleAccess: false,
    categoryAnchor: {
      kind: "trade",
      label: "Trade",
      tradingDate: "2026-09-10",
      contractSymbol: "MESZ6",
      direction: "long",
      price: 5000,
      openTime: "2026-09-10T14:25:00.000Z",
      closeTime: "2026-09-10T14:30:00.000Z",
      relatedCandles: [],
      auditId: "audit",
    },
    annotations: [],
    machineEvidence: {
      quotesAvailable: false,
      sourceSchema: "historical_ohlcv",
      audit: {} as VisualValidationSnapshot["machineEvidence"]["audit"],
      trade: null,
      market: {} as VisualValidationSnapshot["machineEvidence"]["market"],
    },
    review: { status: "unreviewed", note: null, reviewedAt: null },
  };
}

function snapshotForCandidate(
  snapshotId: string,
  strategyKey: VisualValidationSnapshot["strategyKey"],
  candidateId: string,
): VisualValidationSnapshot {
  const value = snapshot(snapshotId, strategyKey);
  value.machineEvidence.trade = {
    candidateId,
    signalOccurrenceId: `${candidateId}-occurrence`,
  } as NonNullable<VisualValidationSnapshot["machineEvidence"]["trade"]>;
  return value;
}

function data(candidates: VisualValidationTradeCandidate[], snapshots: VisualValidationSnapshot[]): VisualValidationSet {
  return {
    reviewSetId: "00000000-0000-0000-0000-000000000001",
    createdAt: "2026-09-10T15:00:00.000Z",
    buildId: "local-development",
    currentBuildId: "local-development",
    stale: false,
    formulaHash: "a".repeat(64),
    formulaVersion: "test",
    sourceFingerprint: "b".repeat(64),
    generationOrigin: "fresh",
    cacheKey: "c".repeat(64),
    cacheKeyVersion: "test",
    strategyVersion: "test",
    candidateProjectionVersion: "test",
    executionManagementVersion: "test",
    accountPositionStateVersion: "test",
    snapshotProjectionVersion: "test",
    chartProjectionVersion: "test",
    sessionCalendarVersion: "test",
    source: "simulated",
    symbol: "MES",
    request: {} as VisualValidationSet["request"],
    reviewPeriod: { startDate: "2026-09-10", endDate: "2026-09-10" },
    processedDates: ["2026-09-10"],
    snapshots,
    tradeCandidates: candidates,
    accountReplayTrades: [],
    categoryCoverage: [],
    defaultSelectionReason: "test",
  };
}

test("review queue counts only unique candidates with reviewable snapshots", () => {
  const candidates = [candidate("c1", "s1"), candidate("c2", "s2"), candidate("c3", "missing")];
  const model = buildReviewQueue(data(candidates, [snapshot("s1", "ORB_PULLBACK_CONTINUATION"), snapshot("s2", "ORB_PULLBACK_CONTINUATION"), snapshot("other", "ORB_PULLBACK_CONTINUATION")]), null);
  assert.equal(model.candidates.length, 3);
  assert.equal(model.items.length, 2);
  assert.equal(model.unreviewableCandidates.length, 1);
  assert.deepEqual(model.items.map((item) => item.candidate.candidateId), ["c1", "c2"]);
});

test("overlapping strategy matches remain one row and empty filters have no active item", () => {
  const overlapping = candidate("c1", "s1");
  overlapping.matchedEdges = ["ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION", "EARLY_ORB_MOMENTUM_CONTINUATION"];
  const set = data([overlapping], [snapshot("s1", "ORB_PULLBACK_CONTINUATION")]);
  assert.equal(buildReviewQueue(set, "ORB_PULLBACK_CONTINUATION").items.length, 1);
  assert.equal(buildReviewQueue(set, "EARLY_ORB_MOMENTUM_CONTINUATION").items.length, 1);
  assert.equal(buildReviewQueue(set, "PEAK_RETRACEMENT_REVERSAL").items.length, 0);
});

test("strategy filters select the matching causal snapshot for an overlapping candidate", () => {
  const overlapping = candidate("c1", "orb-snapshot");
  overlapping.matchedEdges = [
    "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
    "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
  ];
  const set = data(overlapping ? [overlapping] : [], [
    snapshotForCandidate("orb-snapshot", "ORB_PULLBACK_CONTINUATION", "c1"),
    snapshotForCandidate("consolidation-snapshot", "CONSOLIDATION_BREAKOUT_CONTINUATION", "c1"),
  ]);
  const model = buildReviewQueue(set, "CONSOLIDATION_BREAKOUT_CONTINUATION");
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0]?.snapshot.snapshotId, "consolidation-snapshot");
  assert.equal(model.unreviewableCandidates.length, 0);
});