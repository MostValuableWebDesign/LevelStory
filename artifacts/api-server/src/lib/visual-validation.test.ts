import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVisualValidationSet,
  categoriesFor,
  matchingTrade,
  type VisualValidationRequest,
} from "./visual-validation.js";
import type { BacktestAuditRecord, BacktestTrade } from "./phase9.js";
import {
  buildVisualValidationDiscrepancyReport,
  getVisualValidationSet,
  recordVisualValidationReview,
  storeVisualValidationSet,
} from "./visual-validation-store.js";

const request: VisualValidationRequest = {
  symbol: "MES",
  endDate: "2026-08-26",
  inSampleDays: 2,
  outOfSampleDays: 1,
  seed: 11,
  premarketAvailable: true,
};

test("visual-validation sample selection is deterministic", () => {
  const first = buildVisualValidationSet(request);
  const second = buildVisualValidationSet(request);
  assert.deepEqual(first, second);
  assert.ok(first.snapshots.length > 0);
  assert.equal(first.formulaHash, second.formulaHash);
});

test("visual-validation snapshots never expose candles beyond their review cursor", () => {
  const set = buildVisualValidationSet(request);
  for (const snapshot of set.snapshots) {
    const reviewCursor = Date.parse(snapshot.reviewCursor.closeTime);
    for (const candle of snapshot.rawCandles) {
      assert.ok(Date.parse(candle.closeTime) <= reviewCursor, `${candle.closeTime} is after ${snapshot.reviewCursor.closeTime}`);
    }
    for (const item of snapshot.annotations) {
      if (item.openTime) assert.ok(Date.parse(item.openTime) <= reviewCursor);
      if (item.closeTime) assert.ok(Date.parse(item.closeTime) <= reviewCursor);
    }
    assert.equal(snapshot.evaluationCursor.futureCandleAccess, false);
  }
});

test("visual-validation cursors carry distinct New York and UTC timestamps", () => {
  const set = buildVisualValidationSet(request);
  const cursor = set.snapshots[0]?.evaluationCursor;
  assert.ok(cursor);
  assert.notEqual(cursor.newYork, cursor.utc);
  assert.match(cursor.newYork, /2026/);
  assert.match(cursor.utc, /2026/);
});

test("human reviews remain separate from immutable machine evidence", () => {
  const stored = storeVisualValidationSet(buildVisualValidationSet(request));
  const snapshot = stored.snapshots[0];
  assert.ok(snapshot);
  const before = getVisualValidationSet(stored.reviewSetId);
  assert.ok(before);
  const review = recordVisualValidationReview(stored.reviewSetId, snapshot.snapshotId, "incorrect", "The level is not respected.");
  assert.ok(review);
  const after = getVisualValidationSet(stored.reviewSetId);
  assert.ok(after);
  const beforeSnapshot = before.snapshots.find((item) => item.snapshotId === snapshot.snapshotId);
  const afterSnapshot = after.snapshots.find((item) => item.snapshotId === snapshot.snapshotId);
  assert.ok(beforeSnapshot);
  assert.ok(afterSnapshot);
  assert.deepEqual(afterSnapshot.machineEvidence, beforeSnapshot.machineEvidence);
  assert.deepEqual(afterSnapshot.rawCandles, beforeSnapshot.rawCandles);
  assert.equal(afterSnapshot.review.status, "incorrect");
  assert.equal(beforeSnapshot.review.status, "unreviewed");
});

test("review export contains the full ledger and filters discrepancies to incorrect or uncertain", () => {
  const stored = storeVisualValidationSet(buildVisualValidationSet(request));
  const [first, second] = stored.snapshots;
  assert.ok(first);
  assert.ok(second);
  recordVisualValidationReview(stored.reviewSetId, first.snapshotId, "rule_needs_clarification", "Clarify the pullback tolerance.");
  const report = buildVisualValidationDiscrepancyReport(stored.reviewSetId);
  assert.ok(report);
  assert.equal(report.reviewedSnapshots, 1);
  assert.equal(report.reviews.length, 1);
  assert.equal(report.reviews[0]?.snapshotId, first.snapshotId);
  assert.equal(report.reviews[0]?.reviewerStatus, "rule_needs_clarification");
  assert.equal(report.reviews[0]?.note, "Clarify the pullback tolerance.");
  assert.equal(report.discrepancies.length, 0);
  assert.ok(second);
});

function audit(overrides: Partial<BacktestAuditRecord> = {}): BacktestAuditRecord {
  return {
    id: "audit-1",
    tradingDate: "2026-08-26",
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    period: "in_sample",
    evaluatedCandleOpenTime: "2026-08-26T13:30:00.000Z",
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long",
    decision: "SETUP QUALIFIED",
    alertOnly: false,
    rejectionReason: null,
    rejectionCategory: "QUALIFIED",
    rejectionSummary: null,
    ruleEvidence: [],
    orbState: "ENTRY_TRIGGERED",
    breakoutEvidence: "Strong confirmed breakout.",
    volumeEvidence: "Supported volume.",
    pullbackEvidence: "touch at VWAP (pullback interaction).",
    criticalLevelEvidence: "No critical level evidence.",
    trendEvidence: "bullish: higher highs / higher lows.",
    patienceState: "PATIENCE_CANDLE_VALID",
    patienceCandle: { openTime: 100, closeTime: 200, close: 101 },
    triggerCandle: { openTime: 200, closeTime: 300, close: 102 },
    patienceCandleOpenTime: "2026-08-26T13:20:00.000Z",
    patienceCandleCloseTime: "2026-08-26T13:25:00.000Z",
    triggerCandleOpenTime: "2026-08-26T13:25:00.000Z",
    triggerCandleCloseTime: "2026-08-26T13:30:00.000Z",
    modeledFillObservationTime: null,
    exitCandleOpenTime: null,
    exitCandleCloseTime: null,
    entryTriggerPrice: 102,
    strategyStopPrice: 99,
    catastropheStopPrice: 98,
    targetPrice: 108,
    eventLabels: [],
    ambiguityLabels: [],
    executionMode: "quote_based_shadow",
    fees: 0,
    slippage: 0,
    grossPnl: null,
    netPnl: null,
    exitReason: null,
    ...overrides,
  };
}

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    id: "trade-1",
    tradingDate: "2026-08-26",
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    period: "in_sample",
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long",
    entryTime: "2026-08-26T13:30:00.000Z",
    exitTime: "2026-08-26T14:00:00.000Z",
    entryPrice: 102,
    exitPrice: 108,
    contracts: 1,
    grossPnl: 300,
    fees: 5,
    slippage: 1,
    netPnl: 294,
    outcome: "target",
    ambiguityLabel: null,
    source: "tick",
    segmentation: {} as BacktestTrade["segmentation"],
    ...overrides,
  };
}

test("trade matching requires an exact unique causal anchor", () => {
  const record = audit();
  const exact = trade({
    audit: {
      patienceCandleOpenTime: record.patienceCandleOpenTime,
      patienceCandleCloseTime: record.patienceCandleCloseTime,
      triggerCandleOpenTime: record.triggerCandleOpenTime,
      triggerCandleCloseTime: record.triggerCandleCloseTime,
      modeledFillObservationTime: null,
    } as BacktestTrade["audit"],
  });
  assert.equal(matchingTrade(record, [exact])?.id, "trade-1");
  assert.equal(matchingTrade(record, [exact, { ...exact, id: "trade-2", entryTime: "2026-08-26T13:31:00.000Z" }]), null);
  assert.equal(matchingTrade(record, [{ ...exact, contractSymbol: "MESH6" }]), null);
});

test("category gates use explicit trend, mapped-level, and measured-state evidence", () => {
  const aligned = audit();
  assert.deepEqual(categoriesFor(aligned, null), [
    "bullish_patience_candle",
    "strong_breakout",
    "pullback",
  ]);
  assert.equal(categoriesFor({ ...aligned, trendEvidence: "bearish: lower highs / lower lows." }, null).includes("bullish_patience_candle"), false);
  assert.equal(categoriesFor({ ...aligned, pullbackEvidence: "Pullback observed." }, null).includes("pullback"), false);
  assert.equal(categoriesFor({ ...aligned, pullbackEvidence: "consolidation pending near VWAP" }, null).includes("consolidation"), false);
  assert.equal(categoriesFor({ ...aligned, pullbackEvidence: "2 consecutive completed candles consolidated near VWAP." }, null).includes("consolidation"), true);
});

test("exit annotations expose explicit machine and human-only event markers", () => {
  const set = buildVisualValidationSet(request);
  const labels = set.snapshots.flatMap((snapshot) => snapshot.annotations.map((item) => item.label));
  assert.ok(labels.includes("Entry trigger"));
  assert.ok(labels.includes("Modeled fill"));
  assert.ok(labels.some((label) => ["Strategy stop hit", "Catastrophe stop hit", "Target hit", "Runner activation", "Runner exit"].includes(label)));
  for (const snapshot of set.snapshots) {
    const cursor = Date.parse(snapshot.evaluationCursor.closeTime);
    for (const marker of snapshot.annotations.filter((item) => item.visibility === "human_only")) {
      assert.ok(marker.openTime);
      assert.ok(Date.parse(marker.openTime) > cursor);
    }
  }
});
