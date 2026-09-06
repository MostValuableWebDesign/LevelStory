import { strategyConfig, type StrategyConfig } from "./strategy/config.js";

export type VisualReviewEarlyOrbMomentumSettings = {
  enabled: boolean;
  eligibilityCutoffMinutes: number;
  minimumCloseDistanceTicks: number;
};

export const DEFAULT_VISUAL_REVIEW_EARLY_ORB_MOMENTUM: VisualReviewEarlyOrbMomentumSettings = {
  enabled: true,
  eligibilityCutoffMinutes: 630,
  minimumCloseDistanceTicks: 1,
};

export function normalizeVisualReviewEarlyOrbMomentum(
  input?: Partial<VisualReviewEarlyOrbMomentumSettings> | null,
): VisualReviewEarlyOrbMomentumSettings {
  const settings = {
    ...DEFAULT_VISUAL_REVIEW_EARLY_ORB_MOMENTUM,
    ...(input ?? {}),
  };
  if (typeof settings.enabled !== "boolean") {
    throw new Error("Visual Review Early ORB Momentum enabled must be boolean.");
  }
  if (settings.eligibilityCutoffMinutes !== 630) {
    throw new Error("Visual Review Early ORB Momentum P-open cutoff is fixed at 630 minutes / 10:30 ET.");
  }
  if (settings.minimumCloseDistanceTicks !== 1) {
    throw new Error("Visual Review Early ORB Momentum minimum distance is fixed at 1 MES tick.");
  }
  return DEFAULT_VISUAL_REVIEW_EARLY_ORB_MOMENTUM.enabled === settings.enabled
    ? DEFAULT_VISUAL_REVIEW_EARLY_ORB_MOMENTUM
    : { ...DEFAULT_VISUAL_REVIEW_EARLY_ORB_MOMENTUM, enabled: settings.enabled };
}

export function strategyConfigForVisualReview(
  base: StrategyConfig,
  settings: VisualReviewEarlyOrbMomentumSettings,
): StrategyConfig {
  return strategyConfig({
    ...base,
    earlyOrbMomentumContinuationEnabled: settings.enabled,
    earlyOrbMomentumEligibilityCutoffMinutes: settings.eligibilityCutoffMinutes,
    earlyOrbMomentumMinimumCloseDistanceTicks: settings.minimumCloseDistanceTicks,
  });
}