import assert from "node:assert/strict";
import test from "node:test";
import { estimateWorkRemainingMs as estimate } from "./generation-estimate.js";

test("ETA waits for measurable work and elapsed time", () => {
  assert.equal(estimate(1999, 20, 100, null), null);
  assert.equal(estimate(10000, 15, 100, null), null);
  assert.equal(estimate(10000, 20, 100, null), 40000);
});
test("stalls and slower phases cannot increase or exhaust ETA", () => {
  assert.equal(estimate(60000, 20, 100, 40000), 40000);
  assert.equal(estimate(120000, 40, 100, 40000), 40000);
});
test("ETA decreases with completed work and stays positive until storage", () => {
  assert.equal(estimate(30000, 60, 100, 40000), 20000);
  assert.equal(estimate(31000, 99, 100, 20000), 1000);
  assert.equal(estimate(600000, 99, 100, 1000), 1000);
});
