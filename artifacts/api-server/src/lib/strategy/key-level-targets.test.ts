import assert from "node:assert/strict";
import test from "node:test";
import { buildKeyLevelTargetPlan } from "./key-level-targets.js";

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
  assert.equal(plan.targetPrice, 105);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["near", "exact-buffer"]);
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
  assert.equal(plan.targetPrice, 96);
  assert.deepEqual(plan.skippedLevels.map((level) => level.id), ["exact-buffer"]);
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
  assert.equal(plan.targetPrice, 106);
  assert.equal(plan.subsequentTargetLevels[0]?.id, "farther");
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