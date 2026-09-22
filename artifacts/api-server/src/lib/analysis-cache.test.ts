import assert from "node:assert/strict";
import test from "node:test";
import {
  BATCH_AGGREGATION_CACHE_KEY_VERSION,
  buildVersionedAnalysisCacheKey,
  STRATEGY_RESULT_CACHE_KEY_VERSION,
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

test("strategy-switch cache versions reject the immediately previous behavior", () => {
  const previousStrategyVersion = "strategy-result-cache-v11-causal-source-identity";
  const previousBatchVersion = "batch-aggregation-v7-causal-source-identity";
  assert.notEqual(STRATEGY_RESULT_CACHE_KEY_VERSION, previousStrategyVersion);
  assert.notEqual(BATCH_AGGREGATION_CACHE_KEY_VERSION, previousBatchVersion);

  const currentKey = buildVersionedAnalysisCacheKey("cataloged-session-strategy-result", {
    cacheKeyVersion: STRATEGY_RESULT_CACHE_KEY_VERSION,
    aggregationVersion: BATCH_AGGREGATION_CACHE_KEY_VERSION,
    request: {
      enabledStrategies: {
        ORB_PULLBACK_CONTINUATION: true,
        PATIENCE_CANDLE_CONTINUATION: true,
      },
    },
  });
  const previousKey = buildVersionedAnalysisCacheKey("cataloged-session-strategy-result", {
    cacheKeyVersion: previousStrategyVersion,
    aggregationVersion: previousBatchVersion,
    request: {
      enabledStrategies: {
        ORB_PULLBACK_CONTINUATION: true,
        PATIENCE_CANDLE_CONTINUATION: true,
      },
    },
  });
  assert.notEqual(currentKey, previousKey);
  const cache = new VersionedAnalysisCache<{ version: string }>();
  cache.setComplete(currentKey, { version: "current" });
  assert.deepEqual(cache.get(currentKey), { version: "current" });
});

test("strategy result cache identity separates ORB-only and Patience-only analysis", () => {
  const orbOnlyKey = buildVersionedAnalysisCacheKey("cataloged-session-strategy-result", {
    cacheKeyVersion: STRATEGY_RESULT_CACHE_KEY_VERSION,
    aggregationVersion: BATCH_AGGREGATION_CACHE_KEY_VERSION,
    request: {
      enabledStrategies: {
        ORB_PULLBACK_CONTINUATION: true,
        PATIENCE_CANDLE_CONTINUATION: false,
      },
    },
  });
  const patienceOnlyKey = buildVersionedAnalysisCacheKey("cataloged-session-strategy-result", {
    cacheKeyVersion: STRATEGY_RESULT_CACHE_KEY_VERSION,
    aggregationVersion: BATCH_AGGREGATION_CACHE_KEY_VERSION,
    request: {
      enabledStrategies: {
        ORB_PULLBACK_CONTINUATION: false,
        PATIENCE_CANDLE_CONTINUATION: true,
      },
    },
  });
  assert.notEqual(orbOnlyKey, patienceOnlyKey);
});

test("previous result versions are rejected while the current version reuses its result", async () => {
  const cache = new VersionedAnalysisCache<{ version: string }>();
  const request = { source: "same-source", formula: "same-formula", projection: "same-projection" };
  const previousKey = buildVersionedAnalysisCacheKey("strategy-result", {
    ...request,
    resultVersion: "entry-candle-gap-exit-v1",
  });
  const currentKey = buildVersionedAnalysisCacheKey("strategy-result", {
    ...request,
    resultVersion: "entry-candle-gap-exit-v2",
  });
  cache.setComplete(previousKey, { version: "previous" });
  let computations = 0;
  const compute = async () => {
    computations += 1;
    return { version: "current" };
  };
  assert.equal(cache.get(currentKey), null);
  assert.deepEqual(await cache.getOrCompute(currentKey, compute), { version: "current" });
  assert.deepEqual(await cache.getOrCompute(currentKey, compute), { version: "current" });
  assert.equal(computations, 1);
  assert.deepEqual(cache.get(previousKey), { version: "previous" });
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