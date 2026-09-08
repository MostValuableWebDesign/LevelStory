import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKeyLevelTargetPlan,
  filterEligibleKeyLevelInputs,
  primaryLossExitReferenceForPatience,
} from "./key-level-targets.js";

test("long key-level targets select the nearest forward level within 20 points", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "behind", type: "ORB", price: 99 },
      { id: "exact-buffer", type: "VWAP", price: 103 },
      { id: "near", type: "EMA200", price: 102.75 },
        { id: "next", type: "prior-high", price: 119 },
    ],
  });
  assert.equal(plan.selectedTargetLevel?.id, "exact-buffer|near");
  assert.equal(plan.targetPrice, 100.75);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["behind"]);
  assert.equal(plan.subsequentTargetLevels[0]?.id, "next");
  assert.ok(plan.availableLevels.every((level) => level.id !== "behind"));
  assert.equal(plan.skippedLevels[0]?.reason, "TARGET_LEVEL_SKIPPED_WRONG_DIRECTION");
  assert.equal(plan.bufferPoints, 20);
  assert.equal(plan.bufferTicks, 80);
});

test("short key-level targets select close levels and skip distant levels", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "short",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "behind", type: "ORB", price: 101 },
      { id: "exact-buffer", type: "VWAP", price: 97 },
       { id: "next", type: "major-resistance", rangeLow: 77, rangeHigh: 79 },
    ],
  });
  assert.equal(plan.selectedTargetLevel?.id, "exact-buffer");
  assert.equal(plan.selectedTargetLevel?.price, 97);
  assert.equal(plan.targetPrice, 99);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["behind"]);
  assert.equal(plan.subsequentTargetLevels[0]?.id, "next");
});

test("short entries inside a support zone target the zone's lower boundary", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "short",
    entryPrice: 6786.5,
    initialRiskPoints: 6.75,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    levels: [{
      id: "major-support",
      type: "support",
      price: 6783.06,
      rangeLow: 6772.87,
      rangeHigh: 6793.26,
    }],
  });
  assert.equal(plan.selectedTargetLevel?.id, "major-support");
  assert.equal(plan.selectedTargetLevel?.price, 6772.75);
  assert.equal(plan.targetPrice, 6774.75);
  assert.equal(plan.fallbackUsed, false);
  assert.ok(Math.abs((plan.targetR ?? 0) - (11.75 / 6.75)) < 1e-12);
});

test("only levels within the maximum entry distance can become targets", () => {
  const entryPrice = 7527.75;
  const plan = buildKeyLevelTargetPlan({
    direction: "short",
    entryPrice,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "ema-200", type: "EMA200", price: 7523 },
       { id: "vwap", type: "VWAP", price: 7499.5 },
    ],
  });
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["vwap"]);
  assert.equal(plan.selectedTargetLevel?.id, "ema-200");
  assert.equal(plan.targetPrice, 7525);
});

test("dynamite or duplicate prices become one frozen close target level", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "dynamite-vwap", type: "DYNAMITE", rangeLow: 104, rangeHigh: 105, price: 104.5 },
      { id: "dynamite-ema", type: "DYNAMITE", rangeLow: 104, rangeHigh: 105, price: 104.5 },
       { id: "farther", type: "prior-high", price: 125 },
    ],
  });
  assert.equal(plan.availableLevels.length, 2);
  assert.equal(plan.selectedTargetLevel?.id, "dynamite-ema|dynamite-vwap");
  assert.equal(plan.selectedTargetLevel?.price, 104);
  assert.equal(plan.targetPrice, 102);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["farther"]);
});

test("overlapping and within-Dynamite-tolerance aliases become one physical target area", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "major-resistance", type: "major resistance", rangeLow: 104, rangeHigh: 105 },
      { id: "vwap", type: "VWAP", price: 105.5 },
      { id: "ema-200", type: "EMA200", price: 106 },
       { id: "separate-prior-high", type: "previous-day-high", price: 123 },
    ],
  });
  assert.equal(plan.availableLevels.length, 2);
  assert.equal(plan.selectedTargetLevel?.id, "ema-200|major-resistance|vwap");
  assert.equal(plan.selectedTargetLevel?.rangeLow, 104);
  assert.equal(plan.selectedTargetLevel?.rangeHigh, 106);
  assert.equal(plan.selectedTargetLevel?.price, 104);
  assert.equal(plan.targetPrice, 102);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["separate-prior-high"]);
});

test("a structural confluence member remains the target driver over indicator evidence", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "major-resistance", type: "major resistance", rangeLow: 104, rangeHigh: 105 },
      { id: "vwap", type: "VWAP", price: 105.5 },
    ],
  });
  assert.equal(plan.dynamicTargetSource, null);
  assert.equal(plan.targetDrivingMember?.id, "major-resistance");
  assert.equal(plan.targetDrivingMember?.dynamicSource, null);
  assert.equal(plan.selectedLevelPrice, 104);
  assert.equal(plan.targetPrice, 102);
});

test("an indicator-only confluence selects the independently qualifying VWAP driver", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "vwap", type: "VWAP", price: 105 },
      { id: "vwap-alias", type: "VWAP", price: 105.5 },
    ],
  });
  assert.equal(plan.targetDrivingMember?.dynamicSource, "VWAP");
  assert.equal(plan.dynamicTargetSource, "VWAP");
  assert.equal(plan.targetDrivingMember?.rawPrice, 105);
  assert.equal(plan.targetPrice, 103);
});

test("VWAP and EMA200 choose one deterministic driver by executable distance then identity", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "z-ema", type: "EMA200", price: 105 },
      { id: "a-vwap", type: "VWAP", price: 105 },
    ],
  });
  assert.equal(plan.targetDrivingMember?.id, "a-vwap");
  assert.equal(plan.targetDrivingMember?.dynamicSource, "VWAP");
  assert.equal(plan.targetPrice, 103);
  assert.equal(plan.selectedTargetLevel?.targetDrivingMember?.id, "a-vwap");
});

test("legacy exact-level placement is rejected as stale", () => {
  assert.throws(
    () => buildKeyLevelTargetPlan({
      direction: "long",
      entryPrice: 100,
      placementMode: "EXACT_LEVEL",
      levels: [{ id: "prior-high", type: "previous-day-high", price: 105 }],
    }),
    /stale; regenerate/,
  );
});

test("candidate near-side placement stays 8 ticks in front of a directional level", () => {
  const longPlan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [{ id: "resistance", type: "major resistance", price: 105 }],
  });
  const shortPlan = buildKeyLevelTargetPlan({
    direction: "short",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [{ id: "support", type: "major support", price: 95 }],
  });
  assert.equal(longPlan.targetPrice, 103);
  assert.equal(shortPlan.targetPrice, 97);
  assert.equal(longPlan.placementTicks, 8);
});

test("near-side placement skips a close level whose target would not be profitable", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    placementMode: "NEAR_SIDE_8_TICKS",
    levels: [
      { id: "too-close", type: "VWAP", price: 102 },
      { id: "profitable", type: "major resistance", price: 104.25 },
    ],
  });
  assert.equal(plan.selectedTargetLevel?.id, "profitable");
  assert.equal(plan.targetPrice, 102.25);
  assert.equal(plan.skippedLevels[0]?.id, "too-close");
  assert.equal(plan.skippedLevels[0]?.reason, "TARGET_NOT_PROFITABLE");
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
    { id: "major-resistance", type: "major resistance", price: 105 },
  ]);
  assert.deepEqual(filtered.map((level) => level.id), ["major-resistance"]);
  assert.equal(buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    targetBufferTicks: 8,
    levels: [
      { id: "fib-618", type: "Fibonacci", price: 105 },
      { id: "major-resistance", type: "major resistance", price: 105 },
    ],
  }).selectedTargetLevel?.id, "major-resistance");
});

test("a plan with no eligible level is explicit and cannot create a target", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    targetBufferTicks: 8,
    levels: [{ id: "previous-day-close", type: "PREVIOUS_DAY", price: 120 }],
  });
  assert.equal(plan.disposition, "NO_ELIGIBLE_KEY_LEVEL");
  assert.equal(plan.selectedTargetLevel, null);
  assert.equal(plan.targetPrice, null);
});

test("a distant valid key level forces the 1R fallback", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 7474.5,
    placementMode: "NEAR_SIDE_8_TICKS",
     levels: [{ id: "two-sessions-high", type: "two days ago high", price: 7497.5 }],
  });
  assert.equal(plan.disposition, "NO_ELIGIBLE_KEY_LEVEL");
  assert.equal(plan.selectedTargetLevel, null);
  assert.equal(plan.targetPrice, null);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["two-sessions-high"]);
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

test("causal search skips a buffered level below 1R and selects the next eligible level", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    initialRiskPoints: 3,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    levels: [
      { id: "near-indicator", type: "VWAP", price: 102 },
      { id: "next-major", type: "major resistance", price: 106 },
    ],
  });
  assert.equal(plan.selectedTargetLevel?.id, "next-major");
  assert.equal(plan.targetPrice, 104);
  assert.equal(plan.targetR, 1.3333333333333333);
  assert.equal(plan.skippedLevels.find((level) => level.id === "near-indicator")?.reason, "TARGET_LEVEL_SKIPPED_BELOW_1R");
  assert.equal(plan.fallbackUsed, false);
});

test("causal search allows a buffered level above 1.5R when it is within 20 points", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    initialRiskPoints: 2,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
   levels: [{ id: "too-far-for-r", type: "previous-day-high", price: 106.5 }],
  });
   assert.equal(plan.selectedTargetLevel?.id, "too-far-for-r");
   assert.equal(plan.targetPrice, 106.5);
   assert.equal(plan.targetR, 3.25);
   assert.equal(plan.placementTicks, 0);
   assert.equal(plan.maximumTargetR, null);
   assert.equal(plan.searchRangeTicks, 80);
});

test("causal search classifies a level beyond 20 MES points as beyond the achievable range", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
     initialRiskPoints: 30,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
     levels: [{ id: "outside-twenty-points", type: "previous-day-high", price: 123 }],
  });
  assert.equal(plan.skippedLevels[0]?.reason, "TARGET_LEVEL_SKIPPED_BEYOND_ACHIEVABLE_RANGE");
});

test("fixed target planning always uses the eight-tick near-side mode", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    atr14Ticks: 20,
    levels: [{ id: "resistance", type: "major resistance", price: 103 }],
  });
  assert.equal(plan.placementMode, "NEAR_SIDE_8_TICKS");
  assert.equal(plan.targetBufferTicks, 8);
  assert.equal(plan.targetBufferPoints, 2);
  assert.doesNotThrow(() => buildKeyLevelTargetPlan({ direction: "long", entryPrice: 100, levels: [] }));
});

test("frozen target inputs preserve timestamps and report missing provenance", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    targetBufferTicks: 8,
    levels: [
      { id: "vwap", type: "VWAP", price: 103, sourceTimestamp: "2026-08-25T13:35:00.000Z" },
      { id: "premarket-high", type: "PREMARKET", price: 104, sourceTimestamp: null },
    ],
  });
  assert.equal(plan.availableLevels[0]?.sourceTimestamp, "2026-08-25T13:35:00.000Z");
  assert.deepEqual(plan.missingSourceTimestampLevelIds, ["premarket-high"]);
});

test("causal search evaluates the buffered executable price, not the raw level", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    initialRiskPoints: 4,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    levels: [
      { id: "raw-above-one-r", type: "VWAP", price: 105.75 },
      { id: "eligible", type: "previous-day-high", price: 108 },
    ],
  });
  assert.equal(plan.skippedLevels.find((level) => level.id === "raw-above-one-r")?.reason, "TARGET_LEVEL_SKIPPED_BELOW_1R");
  assert.equal(plan.selectedTargetLevel?.id, "eligible");
   assert.equal(plan.targetPrice, 108);
});

test("causal search falls back to exactly 1R when no level is within 20 points", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    initialRiskPoints: 2,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
     levels: [{ id: "too-far", type: "previous-day-high", price: 123 }],
  });
  assert.equal(plan.disposition, "NO_ELIGIBLE_KEY_LEVEL");
  assert.equal(plan.targetPrice, 102);
  assert.equal(plan.targetR, 1);
  assert.equal(plan.fallbackUsed, true);
  assert.equal(plan.fallbackReason, "ONE_R_FALLBACK_NO_ELIGIBLE_LEVEL");
});

test("a too-close major level is skipped and the next eligible level is selected", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    initialRiskPoints: 2,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    levels: [
      { id: "hard-resistance", type: "major resistance", price: 101.5 },
      { id: "farther-level", type: "previous-day-high", price: 104.75 },
    ],
  });
  assert.equal(plan.rejectionReason, null);
  assert.equal(plan.obstructingLevel, null);
  assert.equal(plan.selectedTargetLevel?.id, "farther-level");
  assert.equal(plan.targetPrice, 104.75);
  assert.equal(plan.fallbackUsed, false);
});

test("a major level exactly at 1R falls back to the full 1R price", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "long",
    entryPrice: 100,
    initialRiskPoints: 2,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    levels: [{ id: "one-r-resistance", type: "major resistance", price: 102 }],
  });
  assert.equal(plan.selectedTargetLevel, null);
  assert.equal(plan.skippedLevels[0]?.reason, "TARGET_LEVEL_SKIPPED_BELOW_1R");
  assert.equal(plan.fallbackUsed, true);
  assert.equal(plan.targetPrice, 102);
  assert.equal(plan.targetR, 1);
});

test("short search is symmetric and retains wrong-direction diagnostics", () => {
  const plan = buildKeyLevelTargetPlan({
    direction: "short",
    entryPrice: 100,
    initialRiskPoints: 3,
    placementMode: "NEAR_SIDE_8_TICKS",
    targetBufferTicks: 8,
    levels: [
      { id: "behind", type: "VWAP", price: 101 },
      { id: "near", type: "VWAP", price: 98 },
      { id: "next", type: "major support", price: 94.5 },
    ],
  });
  assert.equal(plan.selectedTargetLevel?.id, "next");
  assert.equal(plan.targetPrice, 96.5);
  assert.equal(plan.skippedLevels.find((level) => level.id === "behind")?.reason, "TARGET_LEVEL_SKIPPED_WRONG_DIRECTION");
});