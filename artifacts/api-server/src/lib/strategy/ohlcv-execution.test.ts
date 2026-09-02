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
    subsequentCompletedCandles: [candle(100.5, 100.75, 99.25, 99.5)],
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
      stopPrice: 99.75,
    },
  });
  assert.equal(result.exitReason, "stop");
  assert.equal(result.stopPrice, 99.75);
  assert.equal(result.audit.stopLevel, "primary_level");
  assert.equal(result.legs[0]?.referencePrice, 99.75);
  assert.ok(result.audit.eventLabels.includes(PRIMARY_LEVEL_EXIT_REACHED_LABEL));
});

test("uses the short primary level before the upper patience opposite-wick stop", () => {
  const result = simulateOhlcvExecution({
    ...base,
    direction: "short",
    immediateTriggerCandle: candle(100, 100, 99, 99.5),
    subsequentCompletedCandles: [candle(99.5, 102.75, 99.25, 102)],
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
      stopPrice: 102.25,
    },
  });
  assert.equal(result.exitReason, "stop");
  assert.equal(result.stopPrice, 102.25);
  assert.equal(result.audit.stopLevel, "primary_level");
  assert.equal(result.legs[0]?.referencePrice, 102.25);
});

test("falls back to the patience opposite-wick stop when the armed primary level has not broken", () => {
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
  assert.equal(result.exitReason, "stop");
  assert.equal(result.stopPrice, 99.5);
  assert.equal(result.audit.stopLevel, "strategy");
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