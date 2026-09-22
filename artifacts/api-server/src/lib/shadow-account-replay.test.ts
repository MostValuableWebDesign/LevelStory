import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildShadowAccountReplay,
  DEFAULT_SHADOW_ACCOUNT_STARTING_BALANCE,
} from "./shadow-account-replay.js";
import type { BacktestTrade } from "./phase9.js";
import type {
  VisualValidationReplayExecutionInput,
  VisualValidationSet,
  VisualValidationSnapshot,
  VisualValidationTradeCandidate,
} from "./visual-validation.js";
import { buildKeyLevelTargetPlan } from "./strategy/key-level-targets.js";

const reviewSetId = "00000000-0000-0000-0000-000000000001";

function candidate(id: string, period: VisualValidationTradeCandidate["period"] = "in_sample"): VisualValidationTradeCandidate {
  return {
    candidateId: id,
    snapshotId: `snapshot-${id}`,
    signalOccurrenceId: `occurrence-${id}`,
    contractSymbol: "MESU26",
    tradingDate: "2026-08-25",
    entryCandleOpenTime: "2026-08-25T13:30:00.000Z",
    entryCandleCloseTime: "2026-08-25T13:35:00.000Z",
    direction: "long",
    entryTriggerPrice: 100,
    primaryEdge: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
    matchedEdges: ["ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION"],
    supportingConfluences: ["VWAP"],
    setupGrade: "A+",
    period,
    outcome: "target",
    causalEvidence: [],
  };
}

function trade(
  id: string,
  netPnl: number,
  candidateId: string,
  overrides: Partial<BacktestTrade> = {},
): BacktestTrade {
  return {
    id,
    tradingDate: "2026-08-25",
    contractSymbol: "MESU26",
    contractMonth: "2026-09",
    period: "in_sample",
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long",
    entryTime: "2026-08-25T13:35:00.000Z",
    exitTime: "2026-08-25T14:00:00.000Z",
    entryPrice: 100,
    exitPrice: 105,
    contracts: 1,
    grossPnl: netPnl,
    fees: 0,
    slippage: 0,
    netPnl,
    outcome: netPnl >= 0 ? "target" : "strategy stop",
    ambiguityLabel: null,
    source: "tick",
    segmentation: {
      contract: "MESU26",
      contractMonth: "2026-09",
      setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
      direction: "long",
      timeOfDay: "open",
      trend: "bullish",
      fibonacciDepth: "normal",
      volumeCondition: "supported",
      levelType: "ORB",
      confluence: "normal",
      patienceCharacteristic: "ENTRY_TRIGGERED",
      orbState: "ENTRY_TRIGGERED",
      marketRegime: "trend",
    },
    candidateId,
    signalOccurrenceId: `occurrence-${candidateId}`,
    ...overrides,
  };
}

function snapshot(tradeRecord: BacktestTrade | null): VisualValidationSnapshot {
  return { machineEvidence: { trade: tradeRecord } } as unknown as VisualValidationSnapshot;
}

function replaySet(
  candidates: VisualValidationTradeCandidate[],
  snapshots: VisualValidationSnapshot[],
  stale = false,
): VisualValidationSet {
  return {
    reviewSetId,
    stale,
    cacheKey: "cache-key",
    formulaHash: "formula-hash",
    sourceFingerprint: "source-fingerprint",
    candidateProjectionVersion: "candidate-v1",
    executionManagementVersion: "execution-v1",
    tradeCandidates: candidates,
    snapshots,
  } as unknown as VisualValidationSet;
}

test("two wins and one loss update the fixed-size ending balance", () => {
  const candidates = ["a", "b", "c"].map((id) => candidate(id));
  const result = buildShadowAccountReplay(replaySet(candidates, [
    snapshot(trade("trade-a", 100, "a")),
    snapshot(trade("trade-b", -50, "b", { entryTime: "2026-08-25T14:35:00.000Z" })),
    snapshot(trade("trade-c", 200, "c", { entryTime: "2026-08-25T15:35:00.000Z" })),
  ]));

  assert.equal(result.startingBalance, DEFAULT_SHADOW_ACCOUNT_STARTING_BALANCE);
  assert.equal(result.endingRealizedBalance, 10250);
  assert.equal(result.realizedNetPnl, 250);
  assert.equal(result.wins, 2);
  assert.equal(result.losses, 1);
  assert.equal(result.maxConsecutiveWins, 1);
  assert.equal(result.maxConsecutiveLosses, 1);
});

test("open trades are listed but excluded from realized account metrics", () => {
  const open = trade("open", 0, "open", { exitTime: null, exitPrice: null, outcome: "open" });
  const result = buildShadowAccountReplay(replaySet(
    [candidate("open"), candidate("closed")],
    [snapshot(open), snapshot(trade("closed", 100, "closed", { entryTime: "2026-08-25T14:35:00.000Z" }))],
  ));

  assert.equal(result.enteredTrades, 1);
  assert.equal(result.openTrades, 1);
  assert.equal(result.closedTrades, 0);
  assert.equal(result.blockedCandidates.length, 1);
  assert.equal(result.blockedCandidates[0]?.reason, "ACCOUNT_ENTRY_BLOCKED_ACTIVE_POSITION");
  assert.equal(result.blockedCandidates[0]?.blockingCandidateId, "open");
  assert.equal(result.realizedNetPnl, 0);
  assert.equal(result.ledger[0]?.netPnl, null);
  assert.equal(result.equityCurve[0]?.status, "start");
  assert.equal(result.equityCurve[1]?.status, "open");
});

test("ambiguous outcomes remain visible as unscored without changing realized balance", () => {
  const result = buildShadowAccountReplay(replaySet(
    [candidate("ambiguous")],
    [snapshot(trade("ambiguous-trade", 100, "ambiguous", { ambiguityLabel: "AMBIGUOUS_STOP_FIRST" }))],
  ));

  assert.equal(result.enteredTrades, 1);
  assert.equal(result.unscoredTrades, 1);
  assert.equal(result.closedTrades, 0);
  assert.equal(result.realizedNetPnl, 0);
  assert.equal(result.ledger[0]?.status, "unscored");
  assert.equal(result.ledger[0]?.netPnl, null);
});

test("an ambiguous adverse-first full exit releases the account while remaining unscored", () => {
  const exitTime = "2026-08-25T14:00:00.000Z";
  const ambiguous = trade("ambiguous-flat-trade", -40, "ambiguous-flat", {
    ambiguityLabel: "AMBIGUOUS_STOP_FIRST",
    outcome: "strategy stop",
    exitTime,
    exitPrice: 99,
    audit: {
      remainingQuantity: 0,
      exitCandleCloseTime: exitTime,
      ambiguityLabels: ["AMBIGUOUS_STOP_FIRST"],
      legs: [{
        kind: "full",
        quantity: 1,
        referencePrice: 99,
        fillPrice: 99,
        grossPnl: -40,
        slippage: 0,
        fees: 0,
        netPnl: -40,
        exitReason: "stop",
        exitCandleCloseTime: exitTime,
      }],
    } as NonNullable<BacktestTrade["audit"]>,
  });
  const later = trade("after-ambiguous-flat", 75, "after-ambiguous-flat", {
    entryTime: "2026-08-25T14:35:00.000Z",
  });
  const result = buildShadowAccountReplay(replaySet(
    [candidate("ambiguous-flat"), candidate("after-ambiguous-flat")],
    [snapshot(ambiguous), snapshot(later)],
  ));

  assert.equal(result.enteredTrades, 2);
  assert.equal(result.blockedCandidates.length, 0);
  assert.equal(result.unscoredTrades, 1);
  assert.equal(result.closedTrades, 1);
  assert.equal(result.realizedNetPnl, 75);
  assert.equal(result.ledger[0]?.exitTime, exitTime);
});

test("candidates without modeled trades do not affect the account", () => {
  const result = buildShadowAccountReplay(replaySet(
    [candidate("modeled"), candidate("missing")],
    [snapshot(trade("modeled-trade", 75, "modeled"))],
  ));

  assert.equal(result.candidateTrades, 2);
  assert.equal(result.nonEnteredCandidates, 1);
  assert.equal(result.enteredTrades, 1);
  assert.equal(result.realizedNetPnl, 75);
});

test("orphan and mismatched legacy trades are ignored", () => {
  const linked = trade("linked", 100, "linked");
  const orphan = trade("orphan", 999, "orphan");
  const mismatched = trade("mismatched", 500, "linked", { signalOccurrenceId: "wrong-occurrence" });
  const result = buildShadowAccountReplay(replaySet(
    [candidate("linked")],
    [snapshot(orphan), snapshot(mismatched), snapshot(linked)],
  ));

  assert.equal(result.enteredTrades, 1);
  assert.equal(result.realizedNetPnl, 100);
  assert.equal(result.ledger[0]?.candidateId, "linked");
});

test("in-sample and out-of-sample metrics remain separated", () => {
  const inSample = candidate("in", "in_sample");
  const outOfSample = candidate("out", "out_of_sample");
  const result = buildShadowAccountReplay(replaySet(
    [inSample, outOfSample],
    [
      snapshot(trade("in-trade", 100, "in")),
      snapshot(trade("out-trade", -40, "out", {
        period: "out_of_sample",
        entryTime: "2026-08-25T14:35:00.000Z",
      })),
    ],
  ));

  assert.equal(result.inSample.netPnl, 100);
  assert.equal(result.inSample.wins, 1);
  assert.equal(result.outOfSample.netPnl, -40);
  assert.equal(result.outOfSample.losses, 1);
  assert.equal(result.realizedNetPnl, 60);
});

test("replay source has no broker, live-order, or paper-trading path", () => {
  const source = readFileSync(new URL("./shadow-account-replay.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createOrder|placeOrder|submitOrder|paper trading/i);
});

test("fixed-size replay reruns frozen execution instead of scaling stored P/L", () => {
  const replayCandidate = candidate("rerun");
  const frozenTargetPlan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    levels: [{ id: "major-resistance", type: "major resistance", price: 102 }],
    tickSize: 0.25,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    initialRiskPoints: 1,
    contracts: 1,
  });
  const sourceTrade = trade("rerun-trade", 999, "rerun", { targetPlan: frozenTargetPlan });
  const replayInput: VisualValidationReplayExecutionInput = {
    entryPrice: 100,
    patienceCandle: {
      openTime: "2026-08-25T13:30:00.000Z",
      closeTime: "2026-08-25T13:35:00.000Z",
      timestamp: "2026-08-25T13:35:00.000Z",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
      bid: 100,
      ask: 100,
      bidSize: 1,
      askSize: 1,
      contractSymbol: "MESU26",
      isComplete: true,
    },
    immediateTriggerCandle: {
      openTime: "2026-08-25T13:35:00.000Z",
      closeTime: "2026-08-25T13:40:00.000Z",
      timestamp: "2026-08-25T13:40:00.000Z",
      open: 100,
      high: 100.25,
      low: 99.75,
      close: 100,
      volume: 1_000,
      bid: 100,
      ask: 100,
      bidSize: 1,
      askSize: 1,
      contractSymbol: "MESU26",
      isComplete: true,
    },
    subsequentCompletedCandles: [{
      openTime: "2026-08-25T13:40:00.000Z",
      closeTime: "2026-08-25T13:45:00.000Z",
      timestamp: "2026-08-25T13:45:00.000Z",
      open: 100,
      high: 102,
      low: 100,
      close: 101,
      volume: 1_000,
      bid: 101,
      ask: 101,
      bidSize: 1,
      askSize: 1,
      contractSymbol: "MESU26",
      isComplete: true,
    }],
    sessionCloseCandle: null,
    strategyStopPrice: 99,
    targetPrice: 102,
    primaryLossExitLevel: null,
    runnerBufferTicks: 4,
  };
  const set = {
    ...replaySet([replayCandidate], []),
    accountReplayTrades: [{
      candidate: replayCandidate,
      trade: sourceTrade,
      snapshotId: replayCandidate.snapshotId,
      replayInput,
    }],
  } as unknown as VisualValidationSet;

  const one = buildShadowAccountReplay(set, { contractsPerTrade: 1 });
  const two = buildShadowAccountReplay(set, { contractsPerTrade: 2 });

  assert.equal(one.ledger[0]?.contracts, 1);
  assert.equal(two.ledger[0]?.contracts, 2);
  assert.notEqual(one.ledger[0]?.netPnl, 999);
  assert.notEqual(two.ledger[0]?.netPnl, (one.ledger[0]?.netPnl ?? 0) * 2);
});

test("rebuilds a target plan and uses the explicit 1R fallback for both contract modes", () => {
  const replayCandidate = candidate("target-disposition");
  const frozenTargetPlan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    levels: [{ id: "near-vwap", type: "VWAP", price: 100.75 }],
    tickSize: 0.25,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    initialRiskPoints: 1,
    contracts: 2,
  });
  const sourceTrade = trade("target-disposition-trade", 999, "target-disposition", {
    contracts: 2,
    targetPlan: frozenTargetPlan,
  });
  const replayInput = {
    entryPrice: 100,
    patienceCandle: {
      openTime: "2026-08-25T13:30:00.000Z",
      closeTime: "2026-08-25T13:35:00.000Z",
      timestamp: "2026-08-25T13:35:00.000Z",
      open: 100, high: 101, low: 99, close: 100, volume: 1_000,
      bid: 100, ask: 100, bidSize: 1, askSize: 1, contractSymbol: "MESU26", isComplete: true,
    },
    immediateTriggerCandle: {
      openTime: "2026-08-25T13:35:00.000Z",
      closeTime: "2026-08-25T13:40:00.000Z",
      timestamp: "2026-08-25T13:40:00.000Z",
      open: 100, high: 100.25, low: 99.75, close: 100, volume: 1_000,
      bid: 100, ask: 100, bidSize: 1, askSize: 1, contractSymbol: "MESU26", isComplete: true,
    },
    subsequentCompletedCandles: [],
    sessionCloseCandle: null,
    strategyStopPrice: 99,
    targetPrice: 100.5,
    primaryLossExitLevel: null,
    runnerBufferTicks: 4,
  } satisfies VisualValidationReplayExecutionInput;
  const set = {
    ...replaySet([replayCandidate], []),
    accountReplayTrades: [{
      candidate: replayCandidate,
      trade: sourceTrade,
      snapshotId: replayCandidate.snapshotId,
      replayInput,
    }],
  } as unknown as VisualValidationSet;

  const two = buildShadowAccountReplay(set, { contractsPerTrade: 2 });
  assert.equal(two.enteredTrades, 1);
  assert.equal(two.rejectedCandidates.length, 0);

  const one = buildShadowAccountReplay(set, { contractsPerTrade: 1 });
  assert.equal(one.enteredTrades, 1);
  assert.equal(one.rejectedCandidates.length, 0);
});

test("rejects legacy and mismatched Strong replay chronology instead of changing execution semantics", () => {
  const replayCandidate = candidate("strong-replay-contract");
  replayCandidate.primaryEdge = "STRONG_BREAKOUT_AFTER_CONSOLIDATION";
  const sourceTrade = trade("strong-replay-contract-trade", -10, "strong-replay-contract", {
    specificStrategyId: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
    audit: {
      strategyStopPrice: 99,
      triggerCandleOpenTime: "2026-08-25T13:35:00.000Z",
      triggerCandleCloseTime: "2026-08-25T13:40:00.000Z",
      consolidationMidpointStop: {
        frozenZoneHigh: 101,
        frozenZoneLow: 99,
        rawMidpoint: 100,
        tickAlignedStop: 98.75,
        direction: "long",
        calculationVersion: "strong-breakout-midpoint-reentry-v1-integer-ticks",
      },
    } as NonNullable<BacktestTrade["audit"]>,
  });
  const replayInput = {
    entryPrice: 100,
    patienceCandle: {
      openTime: "2026-08-25T13:30:00.000Z",
      closeTime: "2026-08-25T13:35:00.000Z",
      timestamp: "2026-08-25T13:35:00.000Z",
      open: 100, high: 101, low: 99, close: 100, volume: 1_000,
      bid: 100, ask: 100, bidSize: 1, askSize: 1, contractSymbol: "MESU26", isComplete: true,
    },
    immediateTriggerCandle: {
      openTime: "2026-08-25T13:35:00.000Z",
      closeTime: "2026-08-25T13:40:00.000Z",
      timestamp: "2026-08-25T13:40:00.000Z",
      open: 100, high: 101, low: 98, close: 100, volume: 1_000,
      bid: 100, ask: 100, bidSize: 1, askSize: 1, contractSymbol: "MESU26", isComplete: true,
    },
    subsequentCompletedCandles: [],
    sessionCloseCandle: null,
    strategyStopPrice: 99,
    targetPrice: null,
    primaryLossExitLevel: null,
    runnerBufferTicks: 4,
  } satisfies VisualValidationReplayExecutionInput;
  const staleSet = {
    ...replaySet([replayCandidate], []),
    sourceFingerprint: "source-fingerprint",
    formulaVersion: "phase9-fixed-formula-v2",
    accountReplayTrades: [{ candidate: replayCandidate, trade: sourceTrade, snapshotId: replayCandidate.snapshotId, replayInput }],
  } as unknown as VisualValidationSet;
  assert.throws(
    () => buildShadowAccountReplay(staleSet),
    /complete immutable ordered execution evidence/i,
  );

  const mismatchedEvidence = {
    schemaVersion: "ordered-execution-evidence-v1-entry-and-interval-scoped" as const,
    source: "tick" as const,
    sourceFingerprint: "source-fingerprint",
    contractSymbol: "MESU26",
    tradingDate: "2026-08-25",
    entryCandleOpenTime: Date.parse("2026-08-25T13:35:00.000Z"),
    entryCandleCloseTime: Date.parse("2026-08-25T13:40:00.000Z"),
    coverageStart: Date.parse("2026-08-25T13:35:00.000Z"),
    coverageEnd: Date.parse("2026-08-25T13:40:00.000Z"),
    ordering: "timestamp_ascending" as const,
    equalTimestampSemantics: "conservative" as const,
    entryPoints: [{ timestamp: Date.parse("2026-08-25T13:36:00.000Z"), price: 100 }],
    laterIntervals: [],
    entryEvent: { timestamp: Date.parse("2026-08-25T13:36:00.000Z"), price: 100 },
    entryFillTimestamp: Date.parse("2026-08-25T13:36:00.000Z"),
    stopEvent: null,
    strategyId: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
    direction: "long" as const,
    frozenZoneIdentity: "99|101|strong-breakout-midpoint-reentry-v1-integer-ticks",
    occurrenceId: "wrong-occurrence",
    candidateId: "strong-replay-contract",
    formulaVersion: "phase9-fixed-formula-v2",
  };
  const mismatchedSet = {
    ...staleSet,
    accountReplayTrades: [{
      candidate: replayCandidate,
      trade: sourceTrade,
      snapshotId: replayCandidate.snapshotId,
      replayInput: {
        ...replayInput,
        replaySchemaVersion: "visual-review-replay-input-v3-immutable-ordered-execution-evidence" as const,
        sourceFingerprint: "source-fingerprint",
        formulaVersion: "phase9-fixed-formula-v2",
        orderedExecutionEvidence: mismatchedEvidence,
      },
    }],
  } as unknown as VisualValidationSet;
  assert.throws(
    () => buildShadowAccountReplay(mismatchedSet),
    /complete immutable ordered execution evidence/i,
  );

  const canonicalFrozenZoneIdentity = "frozen-consolidation-identity-v2:test";
  const currentOrderedEvidence = {
    schemaVersion: "ordered-execution-evidence-v3-exact-selected-stop" as const,
    chronologyMode: "ORDERED_INTRABAR" as const,
    source: "tick" as const,
    sourceFingerprint: "source-fingerprint",
    contractSymbol: "MESU26",
    tradingDate: "2026-08-25",
    entryCandleOpenTime: Date.parse("2026-08-25T13:35:00.000Z"),
    entryCandleCloseTime: Date.parse("2026-08-25T13:40:00.000Z"),
    coverageStart: Date.parse("2026-08-25T13:35:00.000Z"),
    coverageEnd: Date.parse("2026-08-25T13:40:00.000Z"),
    ordering: "timestamp_ascending" as const,
    equalTimestampSemantics: "conservative" as const,
    entryPoints: [{ timestamp: Date.parse("2026-08-25T13:36:00.000Z"), price: 100, sequence: 1 }],
    laterIntervals: [],
    entryEvent: { timestamp: Date.parse("2026-08-25T13:36:00.000Z"), price: 100, sequence: 1 },
    entryFillTimestamp: Date.parse("2026-08-25T13:36:00.000Z"),
    stopEvent: null,
    strategyId: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
    direction: "long" as const,
    frozenZoneIdentity: canonicalFrozenZoneIdentity,
    occurrenceId: "occurrence-strong-replay-contract",
    candidateId: "strong-replay-contract",
    formulaVersion: "phase9-fixed-formula-current",
  };
  const modeMismatchTrade = {
    ...sourceTrade,
    audit: {
      ...sourceTrade.audit!,
      modeledFillTimestamp: "2026-08-25T13:36:00.000Z",
      executionChronologyMode: "ORDERED_INTRABAR" as const,
      executionChronology: currentOrderedEvidence,
      orderedExecutionEvidence: currentOrderedEvidence,
      causalIdentity: { canonicalFrozenZoneIdentity },
    },
  };
  const modeMismatchSet = {
    ...staleSet,
    formulaVersion: "phase9-fixed-formula-current",
    accountReplayTrades: [{
      candidate: replayCandidate,
      trade: modeMismatchTrade,
      snapshotId: replayCandidate.snapshotId,
      replayInput: {
        ...replayInput,
        replaySchemaVersion: "visual-review-replay-input-v5-bound-chronology-evidence" as const,
        sourceFingerprint: "source-fingerprint",
        formulaVersion: "phase9-fixed-formula-current",
        executionChronologyMode: "DETERMINISTIC_LATER_CANDLE" as const,
        executionChronology: currentOrderedEvidence,
        orderedExecutionEvidence: currentOrderedEvidence,
      },
    }],
  } as unknown as VisualValidationSet;
  assert.throws(
    () => buildShadowAccountReplay(modeMismatchSet),
    /complete immutable ordered execution evidence or compatible deterministic execution chronology/i,
  );
});

test("rejects a stale candidate whose long stop is above entry", () => {
  const sourceTrade = trade("invalid-stop-trade", 100, "invalid-stop", {
    audit: { strategyStopPrice: 101 } as NonNullable<BacktestTrade["audit"]>,
  });

  assert.throws(
    () => buildShadowAccountReplay(replaySet([candidate("invalid-stop")], [snapshot(sourceTrade)])),
    /strategy stop on the wrong side of its long entry/i,
  );
});

test("replays a Strong gap-open trade with bound deterministic chronology", () => {
  const candidateId = "strong-gap-replay";
  const replayCandidate = {
    ...candidate(candidateId),
    entryTriggerPrice: 105,
    primaryEdge: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
    matchedEdges: ["STRONG_BREAKOUT_AFTER_CONSOLIDATION"],
    outcome: "strategy stop" as const,
  };
  const entryOpen = Date.parse("2026-08-25T13:35:00.000Z");
  const entryClose = Date.parse("2026-08-25T13:40:00.000Z");
  const exitOpen = entryClose;
  const exitClose = Date.parse("2026-08-25T13:45:00.000Z");
  const formulaVersion = "phase9-fixed-formula-v23.21-bound-chronology-evidence";
  const canonicalFrozenZoneIdentity = "frozen-consolidation-identity-v2:strong-gap-replay";
  const targetPlan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 105,
    levels: [{ id: "major-resistance", type: "major resistance", price: 112 }],
    tickSize: 0.25,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    initialRiskPoints: 3.25,
    contracts: 1,
  });
  const chronology = {
    mode: "DETERMINISTIC_CANDLE_OPEN" as const,
    sourceFingerprint: "source-fingerprint",
    contractSymbol: "MESU26",
    tradingDate: "2026-08-25",
    entryCandleOpenTime: entryOpen,
    entryCandleCloseTime: entryClose,
    entryFillTimestamp: entryOpen,
    exitCandleOpenTime: exitOpen,
    exitCandleCloseTime: exitClose,
    exitTimestamp: exitOpen,
    selectedStopPrice: 101.75,
    strategyId: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
    direction: "long" as const,
    frozenZoneIdentity: canonicalFrozenZoneIdentity,
    occurrenceId: `occurrence-${candidateId}`,
    candidateId,
    formulaVersion,
  };
  const sourceTrade = trade("strong-gap-replay-trade", -17.5, candidateId, {
    specificStrategyId: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
    setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
    primaryEdge: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
    entryTime: new Date(entryOpen).toISOString(),
    exitTime: new Date(exitOpen).toISOString(),
    entryPrice: 105,
    exitPrice: 101.5,
    outcome: "strategy stop",
    targetPlan,
    audit: {
      entryTriggerPrice: 105,
      modeledFillPrice: 105,
      modeledFillTimestamp: new Date(entryOpen).toISOString(),
      modeledExitTimestamp: new Date(exitOpen).toISOString(),
      stopPrice: 101.75,
      strategyStopPrice: 101.75,
      targetPrice: targetPlan.targetPrice,
      targetPlan,
      stopLevel: "strategy",
      stopHitTimestampSource: "CANDLE_OPEN",
      triggerCandleOpenTime: new Date(entryOpen).toISOString(),
      triggerCandleCloseTime: new Date(entryClose).toISOString(),
      patienceCandleOpenTime: "2026-08-25T13:30:00.000Z",
      patienceCandleCloseTime: new Date(entryOpen).toISOString(),
      modeledFillObservationTime: new Date(entryClose).toISOString(),
      exitCandleOpenTime: new Date(exitOpen).toISOString(),
      exitCandleCloseTime: new Date(exitClose).toISOString(),
      assumptions: [],
      eventLabels: ["STRATEGY_STOP_REACHED", "GAP_THROUGH_STOP"],
      ambiguityLabels: [],
      targetHit: false,
      runnerActivated: false,
      runnerExited: false,
      consolidationMidpointStop: {
        frozenZoneHigh: 104,
        frozenZoneLow: 100,
        rawMidpoint: 102,
        tickAlignedStop: 101.75,
        direction: "long",
        calculationVersion: "strong-breakout-midpoint-reentry-v1-integer-ticks",
        activationTimestamp: new Date(entryOpen).toISOString(),
        stopHitTimestamp: new Date(exitOpen).toISOString(),
      },
      causalIdentity: {
        signalOccurrenceId: `occurrence-${candidateId}`,
        eligibilityArmId: null,
        activeConsolidationZoneId: null,
        canonicalFrozenZoneIdentity,
      },
      executionChronologyMode: "DETERMINISTIC_CANDLE_OPEN",
      executionChronology: chronology,
      exitReason: "CONSOLIDATION_MIDPOINT_REENTRY_STOP",
      legs: [],
    } as NonNullable<BacktestTrade["audit"]>,
  });
  const replayInput = {
    replaySchemaVersion: "visual-review-replay-input-v5-bound-chronology-evidence" as const,
    sourceFingerprint: "source-fingerprint",
    formulaVersion,
    entryPrice: 105,
    patienceCandle: {
      openTime: "2026-08-25T13:30:00.000Z", closeTime: new Date(entryOpen).toISOString(),
      timestamp: new Date(entryOpen).toISOString(), open: 103, high: 104, low: 100, close: 103,
      volume: 1_000, bid: 103, ask: 103, bidSize: 1, askSize: 1, contractSymbol: "MESU26", isComplete: true,
    },
    immediateTriggerCandle: {
      openTime: new Date(entryOpen).toISOString(), closeTime: new Date(entryClose).toISOString(),
      timestamp: new Date(entryClose).toISOString(), open: 105, high: 105.25, low: 104.75, close: 105,
      volume: 1_000, bid: 105, ask: 105, bidSize: 1, askSize: 1, contractSymbol: "MESU26", isComplete: true,
    },
    subsequentCompletedCandles: [{
      openTime: new Date(exitOpen).toISOString(), closeTime: new Date(exitClose).toISOString(),
      timestamp: new Date(exitClose).toISOString(), open: 101.5, high: 102, low: 101, close: 101.25,
      volume: 1_000, bid: 101.25, ask: 101.25, bidSize: 1, askSize: 1, contractSymbol: "MESU26", isComplete: true,
    }],
    sessionCloseCandle: null,
    strategyStopPrice: 101.75,
    catastropheStopPrice: null,
    consolidationMidpointStop: sourceTrade.audit!.consolidationMidpointStop,
    targetPrice: targetPlan.targetPrice,
    primaryLossExitLevel: null,
    runnerBufferTicks: 4,
    executionChronologyMode: "DETERMINISTIC_CANDLE_OPEN" as const,
    executionChronology: chronology,
  } satisfies VisualValidationReplayExecutionInput;
  const set = {
    ...replaySet([replayCandidate], []),
    formulaVersion,
    sourceFingerprint: "source-fingerprint",
    accountReplayTrades: [{ candidate: replayCandidate, trade: sourceTrade, snapshotId: replayCandidate.snapshotId, replayInput }],
  } as unknown as VisualValidationSet;

  const replay = buildShadowAccountReplay(set, { contractsPerTrade: 1 });
  assert.equal(replay.rejectedCandidates.length, 0);
  assert.equal(replay.ledger[0]?.exitTime, sourceTrade.exitTime);
  assert.equal(replay.ledger[0]?.exitPrice, sourceTrade.exitPrice);
  assert.equal(replay.ledger[0]?.exitReason, "CONSOLIDATION_MIDPOINT_REENTRY_STOP");
});

test("aggregates authoritative trades across dates with carried balance and zero-trade coverage", () => {
  const first = candidate("first");
  const second = { ...candidate("second"), tradingDate: "2026-08-26", entryCandleOpenTime: "2026-08-26T13:30:00.000Z", entryCandleCloseTime: "2026-08-26T13:35:00.000Z" };
  const third = { ...candidate("third"), tradingDate: "2026-08-28", entryCandleOpenTime: "2026-08-28T13:30:00.000Z", entryCandleCloseTime: "2026-08-28T13:35:00.000Z", direction: "short" as const, primaryEdge: "STRONG_BREAKOUT_AFTER_CONSOLIDATION" };
  const firstTrade = trade("trade-first", 100, "first");
  const secondTrade = trade("trade-second", -40, "second", {
    tradingDate: "2026-08-26",
    entryTime: "2026-08-26T13:35:00.000Z",
    exitTime: "2026-08-26T14:00:00.000Z",
  });
  const thirdTrade = trade("trade-third", 75, "third", {
    tradingDate: "2026-08-28",
    entryTime: "2026-08-28T13:35:00.000Z",
    exitTime: "2026-08-28T14:00:00.000Z",
    direction: "short",
    primaryEdge: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
  });
  const replaySetWithDates = {
    ...replaySet([first, second, third], []),
    processedDates: ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"],
    accountReplayTrades: [
      { candidate: first, trade: firstTrade, snapshotId: first.snapshotId },
      { candidate: second, trade: secondTrade, snapshotId: second.snapshotId },
      { candidate: third, trade: thirdTrade, snapshotId: null },
      { candidate: third, trade: thirdTrade, snapshotId: null },
    ],
  } as unknown as VisualValidationSet;

  const result = buildShadowAccountReplay(replaySetWithDates, { startingBalance: 10_000, contractsPerTrade: 1 });

  assert.deepEqual(result.processedDates, ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]);
  assert.deepEqual(result.datesWithTrades, ["2026-08-25", "2026-08-26", "2026-08-28"]);
  assert.deepEqual(result.datesWithoutTrades, ["2026-08-27"]);
  assert.deepEqual(result.ledger.map((item) => item.candidateId), ["first", "second", "third"]);
  assert.deepEqual(result.ledger.map((item) => item.runningBalance), [10100, 10060, 10135]);
  assert.equal(result.equityCurve[0]?.balance, 10_000);
  assert.equal(result.equityCurve.length, 4);
  assert.equal(result.byDate.length, 4);
  assert.equal(result.byDate.find((item) => item.value === "2026-08-27")?.enteredTrades, 0);
  assert.equal(result.byDirection.find((item) => item.value === "short")?.netPnl, 75);
  assert.equal(result.byPrimaryEdge.find((item) => item.value === "STRONG_BREAKOUT_AFTER_CONSOLIDATION")?.netPnl, 75);
  assert.equal(result.bestTrade?.candidateId, "first");
  assert.equal(result.worstTrade?.candidateId, "second");
  assert.equal(result.bestTradingDay?.value, "2026-08-25");
  assert.equal(result.worstTradingDay?.value, "2026-08-26");
  assert.equal(result.byDate.reduce((total, item) => total + item.netPnl, 0), result.realizedNetPnl);
});
