import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDynamiteFamily, dynamiteLevels } from "./major-levels.js";

test("Dynamite normalizes aliases into the canonical family taxonomy", () => {
  assert.equal(canonicalDynamiteFamily({ name: "ORB high", family: "orb-high" }), "orb-ntz-high");
  assert.equal(canonicalDynamiteFamily({ name: "Prior day low" }), "previous-day-low");
  assert.equal(canonicalDynamiteFamily({ name: "Two days ago high" }), "two-days-ago-high");
  assert.equal(canonicalDynamiteFamily({ name: "Major resistance 5000.00" }), "resistance-zone");
  assert.equal(canonicalDynamiteFamily({ name: "Fib 0.618" }), "fibonacci");
});

test("Dynamite clusters validate the complete lower-to-upper span and retain causal interaction provenance", () => {
  const clusters = dynamiteLevels(
    [
      { name: "Prior day high", price: 100, family: "previous-day-high", id: "prior-high" },
      { name: "VWAP", price: 102, family: "vwap", id: "vwap" },
      { name: "EMA 200", price: 104, family: "ema-200", id: "ema" },
      { name: "Major support", price: 106, family: "support-zone", id: "support" },
    ],
    8,
    0.25,
    123,
    [{ eventId: "pullback-1", eventTime: 90, candleOpenTime: 60, price: 102, level: "VWAP" }],
  );
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((cluster) => cluster.sourceFamilies), [
    ["previous-day-high", "vwap"],
    ["ema-200", "support-zone"],
  ]);
  assert.notEqual(clusters[0]?.id, clusters[1]?.id);
  assert.equal(clusters[0]?.pullbackInteracted, true);
  assert.deepEqual(clusters[0]?.pullbackInteractions, [{
    eventId: "pullback-1",
    eventTime: 90,
    candleOpenTime: 60,
    price: 102,
    level: "VWAP",
  }]);
});