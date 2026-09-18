import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVersionedAnalysisCacheKey,
  VersionedAnalysisCache,
} from "./analysis-cache.js";

test("versioned analysis keys separate source, lookback, strategy, and execution dependencies", () => {
  const base = {
    source: { session: "session-a", lookback: "lookback-a" },
    strategy: { formulaVersion: "formula-a", candidateProjectionVersion: "projection-a" },
    execution: { mode: "ohlcv_modeled", slippageTicks: 1, fees: 2 },
  };
  const same = buildVersionedAnalysisCacheKey("strategy-result", base);
  assert.equal(same, buildVersionedAnalysisCacheKey("strategy-result", {
    execution: base.execution,
    strategy: base.strategy,
    source: base.source,
  }));
  assert.notEqual(same, buildVersionedAnalysisCacheKey("strategy-result", {
    ...base,
    source: { ...base.source, lookback: "lookback-b" },
  }));
  assert.notEqual(same, buildVersionedAnalysisCacheKey("strategy-result", {
    ...base,
    strategy: { ...base.strategy, formulaVersion: "formula-b" },
  }));
  assert.notEqual(same, buildVersionedAnalysisCacheKey("strategy-result", {
    ...base,
    execution: { ...base.execution, slippageTicks: 2 },
  }));
});

test("complete empty results are valid hits while failed and incomplete records are not", async () => {
  const cache = new VersionedAnalysisCache<{ trades: unknown[] }>({ maxEntries: 4 });
  const emptyKey = "empty-result";
  const empty = { trades: [] };
  cache.setComplete(emptyKey, empty);
  assert.deepEqual(cache.get(emptyKey), empty);
  assert.equal(cache.getRecord(emptyKey)?.status, "complete");

  cache.setIncomplete("partial-result", "timed out");
  cache.setFailed("failed-result", "worker exited");
  assert.equal(cache.get("partial-result"), null);
  assert.equal(cache.get("failed-result"), null);
  assert.equal(cache.getRecord("partial-result")?.status, "incomplete");
  assert.equal(cache.getRecord("failed-result")?.status, "failed");

  let calls = 0;
  const retry = await cache.getOrCompute("failed-result", async () => {
    calls += 1;
    return empty;
  });
  assert.deepEqual(retry, empty);
  assert.equal(calls, 1);
});

test("equivalent concurrent computations share one atomic completion", async () => {
  const cache = new VersionedAnalysisCache<{ value: number }>();
  let calls = 0;
  const compute = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: 42 };
  };
  const [first, second] = await Promise.all([
    cache.getOrCompute("same-request", compute),
    cache.getOrCompute("same-request", compute),
  ]);
  assert.deepEqual(first, { value: 42 });
  assert.deepEqual(second, { value: 42 });
  assert.equal(calls, 1);
  assert.equal(cache.getRecord("same-request")?.status, "complete");
});

test("failed computations never become valid cache hits and can be retried", async () => {
  const cache = new VersionedAnalysisCache<{ value: number }>();
  let calls = 0;
  await assert.rejects(cache.getOrCompute("unstable", async () => {
    calls += 1;
    throw new Error("partial worker failure");
  }), /partial worker failure/);
  assert.equal(cache.get("unstable"), null);
  assert.equal(cache.getRecord("unstable")?.status, "failed");

  const recovered = await cache.getOrCompute("unstable", async () => {
    calls += 1;
    return { value: 7 };
  });
  assert.deepEqual(recovered, { value: 7 });
  assert.equal(calls, 2);
});