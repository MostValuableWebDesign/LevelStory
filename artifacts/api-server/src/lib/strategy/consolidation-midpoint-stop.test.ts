import assert from "node:assert/strict";
import test from "node:test";
import { consolidationMidpointStop } from "./consolidation-midpoint-stop.js";

test("uses the first tick strictly below or above an exact midpoint", () => {
  const long = consolidationMidpointStop({ direction: "long", high: 104, low: 100, tickSize: 0.25 });
  const short = consolidationMidpointStop({ direction: "short", high: 104, low: 100, tickSize: 0.25 });
  assert.equal(long?.rawMidpoint, 102);
  assert.equal(long?.strategyStop, 101.75);
  assert.equal(short?.rawMidpoint, 102);
  assert.equal(short?.strategyStop, 102.25);
});

test("does not round the raw midpoint before applying strict tick arithmetic", () => {
  const result = consolidationMidpointStop({ direction: "long", high: 103.25, low: 100, tickSize: 0.25 });
  assert.equal(result?.rawMidpoint, 101.625);
  assert.equal(result?.strategyStop, 101.5);
  const short = consolidationMidpointStop({ direction: "short", high: 103.25, low: 100, tickSize: 0.25 });
  assert.equal(short?.strategyStop, 101.75);
});

test("fails closed for invalid frozen zones", () => {
  assert.equal(consolidationMidpointStop({ direction: "long", high: 100, low: 100, tickSize: 0.25 }), null);
  assert.equal(consolidationMidpointStop({ direction: "long", high: Number.NaN, low: 99, tickSize: 0.25 }), null);
  assert.equal(consolidationMidpointStop({ direction: "short", high: 104, low: 100, tickSize: 0 }), null);
});