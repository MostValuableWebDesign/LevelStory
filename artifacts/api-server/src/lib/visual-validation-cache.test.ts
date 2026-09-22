import assert from "node:assert/strict";
import test from "node:test";
import {
  VISUAL_VALIDATION_CACHE_KEY_VERSION,
  VISUAL_VALIDATION_CANDIDATE_PROJECTION_VERSION,
  VISUAL_VALIDATION_CHART_PROJECTION_VERSION,
  VISUAL_VALIDATION_SNAPSHOT_PROJECTION_VERSION,
  VISUAL_VALIDATION_STRATEGY_ENGINE_VERSION,
  visualValidationCacheMetadata,
} from "./visual-validation-cache.js";

const request = {
  symbol: "MES" as const,
  endDate: "2026-08-26",
  inSampleDays: 5,
  outOfSampleDays: 2,
  seed: 11,
  premarketAvailable: true,
  source: "simulated" as const,
  reviewMode: "trades_only" as const,
};

test("visual review cache identity changes for output-affecting request or source inputs", () => {
  const base = visualValidationCacheMetadata(request, "source-a");
  assert.match(base.cacheKey, /^[0-9a-f]{64}$/);
  assert.equal(
    base.cacheKey,
    visualValidationCacheMetadata({ ...request, regenerateFresh: true }, "source-a").cacheKey,
  );
  assert.notEqual(base.cacheKey, visualValidationCacheMetadata({ ...request, endDate: "2026-08-25" }, "source-a").cacheKey);
  assert.notEqual(base.cacheKey, visualValidationCacheMetadata({ ...request, premarketAvailable: false }, "source-a").cacheKey);
  assert.notEqual(base.cacheKey, visualValidationCacheMetadata({ ...request, reviewMode: "confirmed_signals" }, "source-a").cacheKey);
  assert.notEqual(base.cacheKey, visualValidationCacheMetadata(request, "source-b").cacheKey);
  assert.notEqual(base.cacheKey, visualValidationCacheMetadata(request, "source-a", "calendar-v2").cacheKey);
  assert.notEqual(
    base.cacheKey,
    visualValidationCacheMetadata({
      ...request,
      earlyOrbMomentum: {
        enabled: false,
        eligibilityCutoffMinutes: 630,
        minimumCloseDistanceTicks: 1,
      },
    }, "source-a").cacheKey,
  );
  assert.equal(
    base.cacheKey,
    visualValidationCacheMetadata({
      ...request,
      earlyOrbMomentum: {
        enabled: true,
        eligibilityCutoffMinutes: 630,
        minimumCloseDistanceTicks: 1,
      },
    }, "source-a").cacheKey,
  );
});

test("independent Patience strategy switches invalidate the current Visual Review cache identity", () => {
  const allEnabled = {
    ORB_PULLBACK_CONTINUATION: true,
    EARLY_ORB_MOMENTUM_CONTINUATION: true,
    CONSOLIDATION_BREAKOUT_CONTINUATION: true,
    PATIENCE_CANDLE_CONTINUATION: true,
    EQUIVALENT_CANDLE_REVERSAL: true,
    PEAK_RETRACEMENT_REVERSAL: true,
  } as const;
  const orbOnly = { ...allEnabled, PATIENCE_CANDLE_CONTINUATION: false };
  const patienceOnly = { ...allEnabled, ORB_PULLBACK_CONTINUATION: false };
  const base = visualValidationCacheMetadata({ ...request, enabledStrategies: allEnabled }, "source-a");
  const orbOnlyCache = visualValidationCacheMetadata({ ...request, enabledStrategies: orbOnly }, "source-a");
  const patienceOnlyCache = visualValidationCacheMetadata({ ...request, enabledStrategies: patienceOnly }, "source-a");

  assert.equal(base.cacheKeyVersion, VISUAL_VALIDATION_CACHE_KEY_VERSION);
  assert.equal(base.candidateProjectionVersion, VISUAL_VALIDATION_CANDIDATE_PROJECTION_VERSION);
  assert.equal(base.snapshotProjectionVersion, VISUAL_VALIDATION_SNAPSHOT_PROJECTION_VERSION);
  assert.equal(base.chartProjectionVersion, VISUAL_VALIDATION_CHART_PROJECTION_VERSION);
  assert.equal(VISUAL_VALIDATION_STRATEGY_ENGINE_VERSION, "phase12-strategy-engine-v22-authoritative-target-wick-1r");
  assert.notEqual(base.cacheKey, orbOnlyCache.cacheKey);
  assert.notEqual(base.cacheKey, patienceOnlyCache.cacheKey);
  assert.notEqual(orbOnlyCache.cacheKey, patienceOnlyCache.cacheKey);
  assert.equal(
    visualValidationCacheMetadata({ ...request, enabledStrategies: orbOnly }, "source-a").cacheKey,
    orbOnlyCache.cacheKey,
  );

  assert.notEqual(VISUAL_VALIDATION_CACHE_KEY_VERSION, "visual-review-cache-v25-patience-edge-projection");
  assert.notEqual(VISUAL_VALIDATION_STRATEGY_ENGINE_VERSION, "phase12-strategy-engine-v20-patience-edge-projection");
  assert.notEqual(VISUAL_VALIDATION_CANDIDATE_PROJECTION_VERSION, "candidate-projection-v25-patience-edge-projection");
  assert.notEqual(VISUAL_VALIDATION_SNAPSHOT_PROJECTION_VERSION, "snapshot-projection-v20-patience-edge-projection");
  assert.notEqual(VISUAL_VALIDATION_CHART_PROJECTION_VERSION, "chart-projection-v15-patience-edge-projection");
});