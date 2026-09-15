import assert from "node:assert/strict";
import test from "node:test";
import { estimateRunDurationMs, remainingUntilDeadline } from "./generation-estimate.js";
test("calibration requires completed timings", () => {
  assert.equal(estimateRunDurationMs([]), null);
  assert.equal(estimateRunDurationMs([NaN, Infinity, -1, 0]), null);
  assert.equal(estimateRunDurationMs([210000, 180000, 200000]), 210000);
});
test("countdown advances through stalled work and exposes overruns", () => {
  assert.equal(remainingUntilDeadline(null, 10000), null);
  assert.equal(remainingUntilDeadline(210000, 120000), 90000);
  assert.equal(remainingUntilDeadline(210000, 121000), 89000);
  assert.equal(remainingUntilDeadline(210000, 211000), 0);
  assert.equal(remainingUntilDeadline(210000, 300000), 0);
});
