import assert from "node:assert/strict";
import test from "node:test";
import { AMBIGUOUS_OHLCV_SEQUENCE_LABEL, MODELED_OHLCV_FILL_LABEL, simulateOhlcvExecution } from "./ohlcv-execution.js";

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