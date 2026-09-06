import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STRATEGY_CONFIG } from "./strategy/config.js";
import {
  DEFAULT_VISUAL_REVIEW_EARLY_ORB_MOMENTUM,
  normalizeVisualReviewEarlyOrbMomentum,
  strategyConfigForVisualReview,
} from "./visual-validation-settings.js";

test("Visual Review Early ORB defaults on without changing persistent strategy configuration", () => {
  const settings = normalizeVisualReviewEarlyOrbMomentum();
  assert.deepEqual(settings, DEFAULT_VISUAL_REVIEW_EARLY_ORB_MOMENTUM);
  assert.equal(DEFAULT_STRATEGY_CONFIG.earlyOrbMomentumContinuationEnabled, false);

  const disabled = normalizeVisualReviewEarlyOrbMomentum({ enabled: false });
  const reviewConfig = strategyConfigForVisualReview(DEFAULT_STRATEGY_CONFIG, disabled);
  assert.equal(disabled.enabled, false);
  assert.equal(reviewConfig.earlyOrbMomentumContinuationEnabled, false);
  assert.equal(DEFAULT_STRATEGY_CONFIG.earlyOrbMomentumContinuationEnabled, false);
});

test("Visual Review Early ORB accepts only its fixed server-governed thresholds", () => {
  assert.throws(
    () => normalizeVisualReviewEarlyOrbMomentum({ enabled: "yes" as unknown as boolean }),
    /enabled must be boolean/,
  );
  assert.throws(
    () => normalizeVisualReviewEarlyOrbMomentum({ eligibilityCutoffMinutes: 629 }),
    /fixed at 630/,
  );
  assert.throws(
    () => normalizeVisualReviewEarlyOrbMomentum({ minimumCloseDistanceTicks: 2 }),
    /fixed at 1/,
  );
  assert.throws(
    () => normalizeVisualReviewEarlyOrbMomentum({ maxAttemptsPerDirection: 2 }),
    /exactly 1/,
  );
});