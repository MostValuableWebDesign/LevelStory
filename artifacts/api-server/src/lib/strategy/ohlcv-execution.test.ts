import assert from "node:assert/strict";
import test from "node:test";
import { AMBIGUOUS_OHLCV_SEQUENCE_LABEL, MODELED_OHLCV_FILL_LABEL, PRIMARY_LEVEL_EXIT_REACHED_LABEL, simulateOhlcvExecution } from "./ohlcv-execution.js";

const candle = (open: number, high: number, low: number, close: number) => ({ open, high, low, close });
const base = { direction: "long" as const, entry: 100, patienceCandle: candle(99, 100, 98, 99), tickSize: 0.25, tickValue: 1.25, pointMultiplier: 5, contracts: 1 };

test("models bullish entry, open gap and slippage on ticks", () => {
  const result = simulateOhlcvExecution({ ...base, immediateTriggerCandle: candle(101, 102, 100.5, 101), target: 102, stop: 99, entrySlippageTicks: 1 });
  assert.equal(result.modeledFill, 101.25);
  assert.equal(result.entryTrigger, 100);
  assert.equal(result.audit.entryCandle?.open, 101);
});

test("expires when the immediate trigger does not reach entry", () => {
  const result = simulateOhlcvExecution({ ...base, immediateTriggerCandle: candle(99, 99.5, 98, 99), subsequentCompletedCandles: [candle(99, 100, 98, 99)] });
  assert.equal(result.audit.entryCandle, null);
  assert.equal(result.exitReason, "not filled");
});

test("candidate entry observation does not evaluate exits inside the entry candle", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 102, 98, 100.5),
    evaluateEntryCandleForExit: false,
    target: 101,
    stop: 99,
    subsequentCompletedCandles: [candle(100.5, 100.75, 100.25, 100.5)],
  });
  assert.equal(result.modeledFill, 100);
  assert.equal(result.exitReason, "manual");
  assert.equal(result.audit.exitCandle, null);
});

test("models bearish entry and stop-first ambiguity", () => {
  const result = simulateOhlcvExecution({ ...base, direction: "short", immediateTriggerCandle: candle(99, 101.5, 98, 99), target: 98, stop: 101, exitSlippageTicks: 1 });
  assert.equal(result.modeledFill, 99);
  assert.equal(result.exitReason, "stop");
  assert.ok(result.ambiguityLabels.includes(AMBIGUOUS_OHLCV_SEQUENCE_LABEL));
});

test("rounds prices, converts dollar target, and accounts for partial runner and fees", () => {
  const result = simulateOhlcvExecution({
    ...base, entry: 100.13, immediateTriggerCandle: candle(100, 101, 99.5, 100),
    targetDollars: 2.5, contracts: 2, targetQuantity: 1, stop: 98,
    subsequentCompletedCandles: [candle(101, 102, 101, 101.2), candle(101.2, 101.5, 100.5, 100.7)],
    fees: { commission: 0.5 },
  });
  assert.equal(result.targetPrice, 100.75);
  assert.equal(result.legs[0]?.kind, "target");
  assert.equal(result.legs[1]?.kind, "runner");
  assert.equal(result.legs[0]?.fees, 1);
  assert.ok(result.assumptions.includes(MODELED_OHLCV_FILL_LABEL));
});

test("records a target leg and a stopped runner as separate outcomes", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(100.5, 100.75, 99, 99.25)],
    contracts: 2,
    targetQuantity: 1,
    target: 101,
    stop: 99,
  });
  assert.equal(result.audit.targetHit, true);
  assert.equal(result.audit.runnerExited, true);
  assert.deepEqual(result.legs.map((leg) => [leg.kind, leg.exitReason]), [["target", "target"], ["runner", "stop"]]);
  assert.equal(result.exitReason, "stop");
});

test("returns no fill when no candle triggers", () => {
  const result = simulateOhlcvExecution({ ...base, immediateTriggerCandle: candle(99, 99.5, 98, 99) });
  assert.equal(result.exitReason, "not filled");
  assert.equal(result.modeledFill, null);
});

test("selects the closer protective stop and records its category", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(100.5, 100.75, 99.5, 100)],
    strategyStop: 99.5,
    catastropheStop: 99.75,
    target: 103,
  });
  assert.equal(result.stopPrice, 99.75);
  assert.equal(result.audit.stopLevel, "catastrophe");
  assert.equal(result.exitReason, "stop");
  assert.equal(result.legs[0]?.referencePrice, 99.75);
});

test("honors a primary level loss exit before the patience opposite-wick stop", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(100.5, 100.75, 97.5, 98)],
    strategyStop: 99.5,
    target: 103,
    primaryLossExitLevel: {
      id: "vwap",
      type: "VWAP",
      price: 99.75,
      rangeLow: null,
      rangeHigh: null,
      distancePoints: 0.25,
      distanceTicks: 1,
      stopPrice: 97.75,
    },
  });
  assert.equal(result.exitReason, "stop");
  assert.equal(result.stopPrice, 97.75);
  assert.equal(result.exitPrice, 97.75);
  assert.equal(result.audit.stopLevel, "primary_level");
  assert.equal(result.legs[0]?.referencePrice, 97.75);
  assert.equal(result.legs[0]?.fillPrice, 97.75);
  assert.ok(result.audit.eventLabels.includes(PRIMARY_LEVEL_EXIT_REACHED_LABEL));
});

test("primary level stop remains the exact exit even when the stop candle gaps through it", () => {
  const result = simulateOhlcvExecution({
    ...base,
    direction: "short",
    immediateTriggerCandle: candle(100, 100, 99, 99.5),
    subsequentCompletedCandles: [candle(101.5, 102, 101, 101.75)],
    strategyStop: 102.5,
    primaryLossExitLevel: {
      id: "premarket-high|vwap",
      type: "PREMARKET|VWAP",
      price: 101.5,
      rangeLow: 101.5,
      rangeHigh: 101.5,
      distancePoints: 0.25,
      distanceTicks: 1,
      stopPrice: 101.5,
    },
    exitSlippageTicks: 4,
  });
  assert.equal(result.audit.stopLevel, "primary_level");
  assert.equal(result.stopPrice, 101.5);
  assert.equal(result.exitPrice, 101.5);
  assert.equal(result.legs[0]?.referencePrice, 101.5);
  assert.equal(result.legs[0]?.fillPrice, 101.5);
  assert.equal(result.audit.eventLabels.includes("GAP_THROUGH_STOP"), false);
});

test("uses the short primary level before the upper patience opposite-wick stop", () => {
  const result = simulateOhlcvExecution({
    ...base,
    direction: "short",
    immediateTriggerCandle: candle(100, 100, 99, 99.5),
    subsequentCompletedCandles: [candle(99.5, 104.5, 99.25, 102)],
    strategyStop: 102.5,
    target: 97,
    primaryLossExitLevel: {
      id: "ema-200",
      type: "EMA200",
      price: 102.25,
      rangeLow: null,
      rangeHigh: null,
      distancePoints: 0.25,
      distanceTicks: 1,
      stopPrice: 104.25,
    },
  });
  assert.equal(result.exitReason, "stop");
  assert.equal(result.stopPrice, 104.25);
  assert.equal(result.audit.stopLevel, "primary_level");
  assert.equal(result.legs[0]?.referencePrice, 104.25);
});

test("keeps the qualified primary stop authoritative until its barrier breaks", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(100.5, 100.75, 99.25, 99.5)],
    strategyStop: 99.5,
    target: 103,
    primaryLossExitLevel: {
      id: "support",
      type: "major support",
      price: 96,
      rangeLow: null,
      rangeHigh: null,
      distancePoints: 2,
      distanceTicks: 8,
      stopPrice: 96,
    },
  });
  assert.equal(result.exitReason, "manual");
  assert.equal(result.stopPrice, 99.5);
  assert.equal(result.audit.stopLevel, null);
});

test("uses the opening price for a gap-through stop and closes remaining quantity at session close", () => {
  const gap = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(98, 99, 97, 98)],
    strategyStop: 99,
    catastropheStop: 98.5,
    target: 103,
  });
  assert.equal(gap.legs[0]?.referencePrice, 98);

  const close = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(100.5, 101, 100.25, 100.75)],
    strategyStop: 98,
    target: 103,
    sessionCloseCandle: candle(100.75, 101, 100.5, 100.75),
  });
  assert.equal(close.exitReason, "session_close");
  assert.equal(close.legs.at(-1)?.exitReason, "session_close");
  assert.equal(close.audit.remainingQuantity, 0);
});

test("exits a long runner when the candle low reaches the exact causal 40% threshold", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(101, 101.5, 100.6, 101), candle(101, 101.2, 100.6, 100.9)],
    contracts: 2,
    targetQuantity: 1,
    target: 101,
    stop: 98,
  });
  assert.equal(result.exitReason, "runner");
  assert.equal(result.audit.runnerExited, true);
  assert.equal(result.legs.at(-1)?.referencePrice, 100.5);
});

test("uses a short runner's high and resolves its retracement", () => {
  const result = simulateOhlcvExecution({
    ...base,
    direction: "short",
    immediateTriggerCandle: candle(100, 100, 99, 99.5),
    subsequentCompletedCandles: [candle(99, 98.5, 97, 97.5), candle(97.5, 98.25, 97, 97.5)],
    contracts: 2,
    targetQuantity: 1,
    target: 99,
    stop: 103,
  });
  assert.equal(result.exitReason, "runner");
  assert.equal(result.audit.runnerExited, true);
  assert.equal(result.legs.at(-1)?.referencePrice, 98.25);
});

test("uses the candle open for a long runner gap-through retracement", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(100, 101.25, 99.5, 100.1)],
    contracts: 2,
    targetQuantity: 1,
    target: 101,
    stop: 98,
  });
  assert.equal(result.exitReason, "runner");
  assert.equal(result.legs.at(-1)?.referencePrice, 100);
});

test("labels a long same-candle new extreme and retracement without changing the conservative threshold", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 101, 100, 100.5),
    subsequentCompletedCandles: [candle(100.5, 102, 100.5, 101)],
    contracts: 2,
    targetQuantity: 1,
    target: 101,
    stop: 98,
  });
  assert.equal(result.exitReason, "runner");
  assert.ok(result.ambiguityLabels.includes("AMBIGUOUS_RUNNER_SEQUENCE"));
  assert.equal(result.audit.eventLabels.includes("RUNNER_EXITED"), true);
  assert.equal(result.audit.ambiguityLabels.includes("GAP_THROUGH_STOP"), false);
});

test("labels a short same-candle new extreme and retracement", () => {
  const result = simulateOhlcvExecution({
    ...base,
    direction: "short",
    immediateTriggerCandle: candle(100, 100, 99, 99.5),
    subsequentCompletedCandles: [candle(99.5, 99.5, 98.5, 99)],
    contracts: 2,
    targetQuantity: 1,
    target: 99,
    stop: 103,
  });
  assert.equal(result.exitReason, "runner");
  assert.ok(result.ambiguityLabels.includes("AMBIGUOUS_RUNNER_SEQUENCE"));
  assert.equal(result.audit.eventLabels.includes("RUNNER_EXITED"), true);
});

test("one contract exits fully at +1R when no key-level target exists", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 100.5, 99.5, 100),
    stop: 98,
    target: null,
    oneRProfitRule: true,
    structureTrailing: true,
    subsequentCompletedCandles: [
      candle(100, 101, 99, 100.5),
      candle(100.5, 101.5, 98.5, 101),
      candle(101, 103, 101, 102.5),
      candle(102.5, 104, 100.5, 103),
      candle(103, 103.5, 101.5, 102.5),
      candle(102.5, 103, 98.5, 99),
    ],
  });
  assert.equal(result.audit.initialRiskPoints, 2);
  assert.equal(result.audit.oneRPrice, 102);
  assert.equal(result.audit.oneRReached, true);
  assert.equal(result.audit.profitCheckpointPrice, 102);
  assert.equal(result.audit.trailingStopActive, false);
  assert.equal(result.exitPrice, 102);
  assert.equal(result.exitReason, "target");
  assert.deepEqual(result.legs.map((leg) => [leg.kind, leg.quantity, leg.exitReason]), [["target", 1, "target"]]);
});

test("one contract keeps an eligible key-level target instead of replacing it with 1R", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 100.5, 99.5, 100),
    stop: 98,
    target: 104,
    oneRProfitRule: false,
    subsequentCompletedCandles: [
      candle(100, 101, 99, 100.5),
      candle(100.5, 104.5, 100.5, 104),
    ],
  });
  assert.equal(result.audit.initialRiskPoints, 2);
  assert.equal(result.audit.oneRPrice, 102);
  assert.equal(result.audit.oneRReached, false);
  assert.equal(result.audit.profitCheckpointPrice, 104);
  assert.equal(result.exitPrice, 104);
  assert.equal(result.exitReason, "target");
  assert.deepEqual(result.legs.map((leg) => [leg.kind, leg.quantity, leg.referencePrice]), [["target", 1, 104]]);
});

test("multiple no-target contracts take one at +1R and trail the runner", () => {
  const result = simulateOhlcvExecution({
    ...base,
    immediateTriggerCandle: candle(100, 100.5, 99.5, 100),
    contracts: 2,
    stop: 98,
    target: null,
    oneRProfitRule: true,
    structureTrailing: true,
    subsequentCompletedCandles: [
      candle(100, 101, 99, 100.5),
      candle(100.5, 102, 99.5, 101.5),
      candle(101.5, 103, 101, 102.5),
      candle(102.5, 104, 100.5, 103),
      candle(103, 103.5, 101.5, 102.5),
      candle(102.5, 103, 98, 99),
    ],
  });
  assert.equal(result.audit.oneRReached, true);
  assert.equal(result.audit.runnerActivated, true);
  assert.deepEqual(result.legs.map((leg) => [leg.kind, leg.quantity, leg.exitReason]), [
    ["target", 1, "target"],
    ["runner", 1, "stop"],
  ]);
  assert.equal(result.legs[0]?.referencePrice, 102);
  assert.equal(result.legs[1]?.referencePrice, 98.5);
});

test("short structure trailing uses swing highs and never widens", () => {
  const result = simulateOhlcvExecution({
    ...base,
    direction: "short",
    immediateTriggerCandle: candle(100, 100.5, 99.5, 100),
    contracts: 2,
    stop: 102,
    target: null,
    oneRProfitRule: true,
    structureTrailing: true,
    subsequentCompletedCandles: [
      candle(100, 101, 99, 99.5),
      candle(99.5, 101.5, 98.5, 99),
      candle(99, 100, 97, 98),
      candle(98, 97, 96, 97),
      candle(97, 97.5, 96.5, 97),
      candle(97, 97, 96, 96.5),
      candle(96.5, 100, 95.5, 99),
    ],
  });
  assert.equal(result.audit.oneRPrice, 98);
  assert.equal(result.audit.trailingStopPrice, 99.5);
  assert.equal(result.audit.stopLevel, "structure_trailing");
  assert.equal(result.exitPrice, 99.5);
});