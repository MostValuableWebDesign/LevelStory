import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKeyLevelTargetPlan,
  filterEligibleKeyLevelInputs,
  primaryLossExitReferenceForPatience,
} from "./key-level-targets.js";

test("long key-level targets bypass nearby and behind levels", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    levels: [
      { id: "behind", type: "ORB", price: 99 },
      { id: "exact-buffer", type: "VWAP", price: 103 },
      { id: "near", type: "EMA200", price: 102.75 },
      { id: "next", type: "prior-high", price: 108 },
    ],
  });
  assert.equal(plan.selectedTargetLevel?.id, "next");
  assert.equal(plan.targetPrice, 108);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["exact-buffer|near"]);
  assert.ok(plan.availableLevels.every((level) => level.id !== "behind"));
  assert.equal(plan.skippedLevels[0]?.reason, "ENTRY_WITHIN_12_TICKS");
});

test("short key-level targets use the upper zone boundary and bypass nearby levels", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "short",
    entryPrice: 100,
    levels: [
      { id: "behind", type: "ORB", price: 101 },
      { id: "exact-buffer", type: "VWAP", price: 97 },
      { id: "next", type: "major-resistance", rangeLow: 91, rangeHigh: 93 },
    ],
  });
  assert.equal(plan.selectedTargetLevel?.id, "next");
  assert.equal(plan.selectedTargetLevel?.price, 93);
  assert.equal(plan.targetPrice, 93);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["exact-buffer"]);
});

test("only levels outside the entry buffer are selected and raw levels become targets", () => {
  const entryPrice = 7527.75;
  const vwap = 7522.565477738259;
  const plan = buildKeyLevelTargetPlan({
    direction: "short",
    entryPrice,
    levels: [
      { id: "ema-200", type: "EMA200", price: 7526.092528248642 },
      { id: "vwap", type: "VWAP", price: vwap },
    ],
  });
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["ema-200"]);
  assert.equal(plan.selectedTargetLevel?.id, "vwap");
  assert.equal(plan.targetPrice, vwap);
});

test("dynamite or duplicate prices become one frozen target level", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    levels: [
      { id: "dynamite-vwap", type: "DYNAMITE", rangeLow: 109, rangeHigh: 111, price: 110 },
      { id: "dynamite-ema", type: "DYNAMITE", rangeLow: 109, rangeHigh: 111, price: 110 },
      { id: "farther", type: "prior-high", price: 115 },
    ],
  });
  assert.equal(plan.availableLevels.length, 2);
  assert.equal(plan.selectedTargetLevel?.id, "dynamite-ema|dynamite-vwap");
  assert.equal(plan.selectedTargetLevel?.price, 109);
  assert.equal(plan.targetPrice, 109);
  assert.equal(plan.subsequentTargetLevels[0]?.id, "farther");
});

test("overlapping and within-Dynamite-tolerance aliases become one physical target area", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    levels: [
      { id: "major-resistance", type: "major resistance", rangeLow: 108, rangeHigh: 109 },
      { id: "vwap", type: "VWAP", price: 109.5 },
      { id: "ema-200", type: "EMA200", price: 110 },
      { id: "separate-prior-high", type: "previous-day-high", price: 111 },
    ],
  });
  assert.equal(plan.availableLevels.length, 2);
  assert.equal(plan.selectedTargetLevel?.id, "ema-200|major-resistance|vwap");
  assert.equal(plan.selectedTargetLevel?.rangeLow, 108);
  assert.equal(plan.selectedTargetLevel?.rangeHigh, 110);
  assert.equal(plan.selectedTargetLevel?.price, 108);
  assert.equal(plan.targetPrice, 108);
  assert.equal(plan.subsequentTargetLevels[0]?.id, "separate-prior-high");
});

test("exact-level placement is an explicit comparison mode", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "EXACT_LEVEL",
    levels: [{ id: "prior-high", type: "previous-day-high", price: 108 }],
  });
  assert.equal(plan.targetPrice, 108);
  assert.equal(plan.bufferTicks, 12);
  assert.equal(plan.bufferPoints, 3);
});

test("allowlist excludes Fibonacci, close, critical, and management artifacts", () => {
  const filtered = filterEligibleKeyLevelInputs([
    { id: "fib-618", type: "Fibonacci", price: 105 },
    { id: "critical-fib", type: "Critical · Fib", price: 106 },
    { id: "previous-day-close", type: "PREVIOUS_DAY", price: 107 },
    { id: "entry-buffer", type: "confirmation buffer", price: 108 },
    { id: "strategy-stop", type: "stop", price: 95 },
    { id: "runner-threshold", type: "runner", price: 110 },
    { id: "generic-critical", type: "critical", price: 111 },
    { id: "major-resistance", type: "major resistance", price: 115 },
  ]);
  assert.deepEqual(filtered.map((level) => level.id), ["major-resistance"]);
  assert.equal(buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    levels: [
      { id: "fib-618", type: "Fibonacci", price: 115 },
      { id: "major-resistance", type: "major resistance", price: 115 },
    ],
  }).selectedTargetLevel?.id, "major-resistance");
});

test("a plan with no eligible level is explicit and cannot create a target", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    levels: [{ id: "previous-day-close", type: "PREVIOUS_DAY", price: 120 }],
  });
  assert.equal(plan.disposition, "NO_ELIGIBLE_KEY_LEVEL");
  assert.equal(plan.selectedTargetLevel, null);
  assert.equal(plan.targetPrice, null);
});

test("long loss exits prefer the nearest adverse primary level within the patience wick vicinity", () => {
  const reference = primaryLossExitReferenceForPatience({
    direction: "long",
    entryPrice: 100,
    patienceLow: 98,
    patienceHigh: 101,
    levels: [
      { id: "above-entry", type: "VWAP", price: 100.25 },
      { id: "farther-support", type: "major support", price: 96 },
      { id: "near-vwap", type: "VWAP", price: 99.5 },
    ],
  });
  assert.equal(reference?.id, "near-vwap");
  assert.equal(reference?.distanceTicks, 6);
  assert.equal(reference?.stopPrice, 97.5);
});

test("short loss exits use the adverse upper primary level and ignore lower levels", () => {
  const reference = primaryLossExitReferenceForPatience({
    direction: "short",
    entryPrice: 100,
    patienceLow: 99,
    patienceHigh: 102,
    levels: [
      { id: "below-entry", type: "EMA200", price: 99.75 },
      { id: "farther-resistance", type: "major resistance", price: 104 },
      { id: "near-ema", type: "EMA200", price: 102.5 },
    ],
  });
  assert.equal(reference?.id, "farther-resistance|near-ema");
  assert.equal(reference?.distanceTicks, 2);
  assert.equal(reference?.stopPrice, 104.5);
});

test("a primary loss reference between 8 and 12 ticks now qualifies", () => {
  const longReference = primaryLossExitReferenceForPatience({
    direction: "long",
    entryPrice: 100,
    patienceLow: 98,
    patienceHigh: 101,
    levels: [{ id: "support", type: "major support", price: 95.5 }],
  });
  const shortReference = primaryLossExitReferenceForPatience({
    direction: "short",
    entryPrice: 100,
    patienceLow: 99,
    patienceHigh: 102,
    levels: [{ id: "resistance", type: "major resistance", price: 104.5 }],
  });
  assert.equal(longReference?.distanceTicks, 10);
  assert.equal(shortReference?.distanceTicks, 10);
});