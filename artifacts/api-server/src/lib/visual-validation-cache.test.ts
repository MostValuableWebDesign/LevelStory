import assert from "node:assert/strict";
import test from "node:test";
import {
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
});