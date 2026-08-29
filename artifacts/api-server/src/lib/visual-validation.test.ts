import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVisualValidationSet,
  buildHistoricalVisualValidationSetFromReport,
  categoriesFor,
  matchingTrade,
  type VisualValidationRequest,
  type VisualValidationCategory,
} from "./visual-validation.js";
import { createVisualValidationFixtures } from "./visual-validation-fixtures.js";
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

test("simulated visual-validation requests default their persisted source", () => {
  const set = buildVisualValidationSet(request);
  assert.equal(set.source, "simulated");
  assert.equal(set.request.source, "simulated");
});

test("historical projection keeps contract-local candles and truthful category gaps", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "strong_breakout");
  assert.ok(fixture);
  const firstCandle = fixture.dataset.candles[0];
  assert.ok(firstCandle);
  const foreignContractCandle = { ...firstCandle, contractSymbol: "MESH6" };
  const dataset = {
    ...fixture.dataset,
    source: "historical_databento_multicontract" as const,
    candles: [...fixture.dataset.candles, foreignContractCandle],
  };
  const set = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento" },
    dataset,
    {
      symbol: "MES",
      formulaHash: fixture.audit.id.padEnd(64, "0").slice(0, 64),
      executionMode: "ohlcv_modeled",
      audit: [fixture.audit],
      trades: fixture.trade ? [fixture.trade] : [],
    },
  );
  assert.equal(set.source, "historical_databento");
  assert.ok(set.snapshots.length >= 1);
  assert.ok(set.snapshots.some((snapshot) => snapshot.category === "strong_breakout"));
  assert.ok(set.snapshots.every((snapshot) => snapshot.reviewCandles.every((candle) => candle.contractSymbol === fixture.audit.contractSymbol)));
  assert.ok(set.snapshots.every((snapshot) => snapshot.machineCandles.every((candle) => candle.contractSymbol === fixture.audit.contractSymbol)));
  assert.equal(set.categoryCoverage.find((item) => item.category === "qualified_trade")?.available, false);
  assert.equal(set.categoryCoverage.find((item) => item.category === "strong_breakout")?.count, 1);
  assert.equal(set.snapshots[0]?.evaluationCursor.futureCandleAccess, false);
  assert.equal(set.snapshots[0]?.futureCandleAccess, false);
});

test("visual-validation provides twelve distinct valid five-minute MES fixtures", () => {
  const set = buildVisualValidationSet(request);
  assert.equal(set.snapshots.length, 12);
  assert.deepEqual(
    set.snapshots.map((snapshot) => snapshot.category),
    [
      "qualified_trade",
      "rejected_setup",
      "bullish_patience_candle",
      "bearish_patience_candle",
      "weak_orb_probe",
      "strong_breakout",
      "pullback",
      "consolidation",
      "ambiguous_candle",
      "stop_exit",
      "target_exit",
      "runner_exit",
    ],
  );
  const fingerprints = new Set<string>();
  for (const snapshot of set.snapshots) {
    assert.equal(snapshot.symbol, "MES");
    assert.equal(snapshot.machineCandles.length, snapshot.evaluationCursor.visibleCandleCount);
    assert.ok(snapshot.reviewCandles.length >= snapshot.machineCandles.length);
    assert.equal(snapshot.outcomeContextEnd, snapshot.reviewCursor.closeTime);
    assert.ok(snapshot.machineCandles.length >= 35 && snapshot.machineCandles.length <= 50);
    const opens = snapshot.machineCandles.map((candle) => Date.parse(candle.openTime));
    for (let index = 0; index < snapshot.machineCandles.length; index += 1) {
      const candle = snapshot.machineCandles[index]!;
      assert.equal(Date.parse(candle.closeTime) - opens[index]!, 5 * 60_000);
      if (index > 0) assert.equal(opens[index]! - opens[index - 1]!, 5 * 60_000);
      assert.ok(candle.high >= Math.max(candle.open, candle.close));
      assert.ok(candle.low <= Math.min(candle.open, candle.close));
      assert.ok(candle.volume > 0);
    }
    assert.ok(new Set(snapshot.machineCandles.map((candle) => `${candle.open}:${candle.close}`)).size >= 12);
    assert.ok(new Set(snapshot.machineCandles.map((candle) => candle.volume)).size >= 12);
    fingerprints.add(snapshot.machineCandles.map((candle) => `${candle.openTime}:${candle.open}:${candle.high}:${candle.low}:${candle.close}:${candle.volume}`).join("|"));
  }
  assert.equal(fingerprints.size, set.snapshots.length);
  assert.ok(set.categoryCoverage.every((coverage) => coverage.available && coverage.count === 1));
});

test("patience fixtures align direction and category evidence", () => {
  const set = buildVisualValidationSet(request);
  const bullish = set.snapshots.find((snapshot) => snapshot.category === "bullish_patience_candle");
  const bearish = set.snapshots.find((snapshot) => snapshot.category === "bearish_patience_candle");
  assert.ok(bullish);
  assert.ok(bearish);
  assert.equal(bullish.machineEvidence.audit.direction, "long");
  assert.match(bullish.machineEvidence.audit.trendEvidence, /^bullish:/);
  assert.equal(bullish.machineEvidence.audit.patienceState, "PATIENCE_CANDLE_VALID");
  assert.equal(bearish.machineEvidence.audit.direction, "short");
  assert.match(bearish.machineEvidence.audit.trendEvidence, /^bearish:/);
  assert.equal(bearish.machineEvidence.audit.patienceState, "PATIENCE_CANDLE_VALID");
  assert.notEqual(bullish.evaluationCursor.openTime, bearish.evaluationCursor.openTime);
  assert.notDeepEqual(bullish.machineCandles, bearish.machineCandles);
});

test("ORB, pullback, consolidation, and ambiguity fixtures expose explicit machine states", () => {
  const set = buildVisualValidationSet(request);
  const snapshot = (category: VisualValidationCategory) => {
    const result = set.snapshots.find((item) => item.category === category);
    assert.ok(result);
    return result;
  };
  assert.equal(snapshot("weak_orb_probe").machineEvidence.audit.orbState, "ORB_PROBE_WAIT");
  assert.match(snapshot("weak_orb_probe").machineEvidence.audit.volumeEvidence, /below the confirmation threshold/i);
  assert.match(snapshot("strong_breakout").machineEvidence.audit.breakoutEvidence, /closed beyond ORB/i);
  assert.match(snapshot("pullback").machineEvidence.audit.pullbackEvidence, /ORB high/i);
  assert.match(snapshot("pullback").machineEvidence.audit.criticalLevelEvidence, /recognized retracement level/i);
  assert.match(snapshot("consolidation").machineEvidence.audit.pullbackEvidence, /14 completed candles consolidated/i);
  assert.match(snapshot("ambiguous_candle").machineEvidence.audit.rejectionReason ?? "", /AMBIGUOUS_STOP_FIRST/);
  assert.deepEqual(snapshot("ambiguous_candle").machineEvidence.audit.ambiguityLabels, ["AMBIGUOUS_STOP_FIRST"]);
});

test("exit fixtures retain exact audit identity and outcome evidence", () => {
  const set = buildVisualValidationSet(request);
  const expectations: Array<[VisualValidationCategory, string]> = [
    ["stop_exit", "STRATEGY_STOP_REACHED"],
    ["target_exit", "TARGET_REACHED"],
    ["runner_exit", "RUNNER_EXITED"],
  ];
  for (const [category, eventLabel] of expectations) {
    const snapshot = set.snapshots.find((item) => item.category === category);
    assert.ok(snapshot);
    const audit = snapshot.machineEvidence.audit;
    const trade = snapshot.machineEvidence.trade;
    assert.ok(trade);
    assert.equal(matchingTrade(audit, [trade])?.id, trade.id);
    assert.equal(audit.exitCandleOpenTime, trade.audit?.exitCandleOpenTime);
    assert.equal(audit.exitCandleCloseTime, trade.audit?.exitCandleCloseTime);
    assert.ok(trade.audit?.eventLabels.includes(eventLabel));
  }
});

test("visual-validation snapshots never expose candles beyond their review cursor", () => {
  const set = buildVisualValidationSet(request);
  for (const snapshot of set.snapshots) {
    const reviewCursor = Date.parse(snapshot.reviewCursor.closeTime);
    for (const candle of snapshot.reviewCandles) {
      assert.ok(Date.parse(candle.closeTime) <= reviewCursor, `${candle.closeTime} is after ${snapshot.reviewCursor.closeTime}`);
    }
    for (const item of snapshot.annotations) {
      if (item.openTime) assert.ok(Date.parse(item.openTime) <= reviewCursor);
      if (item.closeTime) assert.ok(Date.parse(item.closeTime) <= reviewCursor);
    }
    assert.equal(snapshot.evaluationCursor.futureCandleAccess, false);
    assert.equal(snapshot.futureCandleAccess, false);
    assert.ok(snapshot.machineCandles.every((candle) => Date.parse(candle.closeTime) <= Date.parse(snapshot.evaluationCursor.closeTime)));
    assert.equal(snapshot.outcomeContextEnd, snapshot.reviewCursor.closeTime);
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
   assert.deepEqual(afterSnapshot.machineCandles, beforeSnapshot.machineCandles);
   assert.deepEqual(afterSnapshot.reviewCandles, beforeSnapshot.reviewCandles);
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

test("trade matching rejects an unrelated exit or causal timestamp", () => {
  const record = audit({
    modeledFillObservationTime: "2026-08-26T13:35:00.000Z",
    exitCandleOpenTime: "2026-08-26T13:55:00.000Z",
    exitCandleCloseTime: "2026-08-26T14:00:00.000Z",
  });
  const exact = trade({
    audit: {
      patienceCandleOpenTime: record.patienceCandleOpenTime,
      patienceCandleCloseTime: record.patienceCandleCloseTime,
      triggerCandleOpenTime: record.triggerCandleOpenTime,
      triggerCandleCloseTime: record.triggerCandleCloseTime,
      modeledFillObservationTime: record.modeledFillObservationTime,
      exitCandleOpenTime: record.exitCandleOpenTime,
      exitCandleCloseTime: record.exitCandleCloseTime,
    } as BacktestTrade["audit"],
  });
  assert.equal(matchingTrade(record, [exact])?.id, "trade-1");
  assert.equal(matchingTrade(record, [{
    ...exact,
    audit: {
      ...exact.audit!,
      exitCandleCloseTime: "2026-08-26T14:05:00.000Z",
    } as BacktestTrade["audit"],
  }]), null);
  assert.equal(matchingTrade({ ...record, modeledFillObservationTime: "2026-08-26T13:40:00.000Z" }, [exact]), null);
  assert.equal(matchingTrade({ ...record, triggerCandleOpenTime: "2026-08-26T13:30:00.000Z" }, [exact]), null);
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
