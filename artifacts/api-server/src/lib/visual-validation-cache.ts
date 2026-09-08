import { createHash } from "node:crypto";
import { activeShadowStrategySnapshot } from "./active-shadow-strategy.js";
import { FIXED_FORMULA_VERSION, formulaConfigurationHash } from "./formula-hash.js";
import { DEFAULT_FUTURES_SESSION_CALENDAR } from "./futures/session-calendar.js";
import type { VisualValidationRequest } from "./visual-validation.js";
import { normalizeVisualReviewEarlyOrbMomentum, strategyConfigForVisualReview } from "./visual-validation-settings.js";
import { KEY_LEVEL_TARGET_PLAN_VERSION } from "./strategy/key-level-targets.js";
import { DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION } from "./strategy/ohlcv-execution.js";

export const VISUAL_VALIDATION_CACHE_KEY_VERSION = "visual-review-cache-v14-causal-replay-context-driving-member-pending";
export const VISUAL_VALIDATION_STRATEGY_ENGINE_VERSION = "phase12-strategy-engine-v9-causal-replay-context-driving-member-pending";
export const VISUAL_VALIDATION_CANDIDATE_PROJECTION_VERSION = "candidate-projection-v13-causal-replay-context-driving-member-pending";
export const VISUAL_VALIDATION_EXECUTION_MANAGEMENT_VERSION = "execution-management-v12-causal-replay-context-driving-member-pending";
export const VISUAL_VALIDATION_SNAPSHOT_PROJECTION_VERSION = "snapshot-projection-v11-causal-replay-context-driving-member-pending";
export const VISUAL_VALIDATION_CHART_PROJECTION_VERSION = "chart-projection-v5-causal-replay-context-driving-member-pending";

export type VisualValidationCacheMetadata = {
  cacheKey: string;
  cacheKeyVersion: string;
  strategyVersion: string;
  formulaHash: string;
  formulaVersion: string;
  candidateProjectionVersion: string;
  executionManagementVersion: string;
  snapshotProjectionVersion: string;
  chartProjectionVersion: string;
  sessionCalendarVersion: string;
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

export function simulatedVisualValidationSourceFingerprint(request: VisualValidationRequest): string {
  return digest({
    source: "simulated-fixtures",
    symbol: request.symbol,
    seed: request.seed ?? 11,
    endDate: request.endDate,
    inSampleDays: request.inSampleDays,
    outOfSampleDays: request.outOfSampleDays,
  });
}

export function visualValidationCacheMetadata(
  request: VisualValidationRequest,
  sourceFingerprint: string,
  sessionCalendarVersion = DEFAULT_FUTURES_SESSION_CALENDAR.calendarVersion,
  processedDates: readonly string[] = [],
): VisualValidationCacheMetadata {
  const active = activeShadowStrategySnapshot();
  const earlyOrbMomentum = normalizeVisualReviewEarlyOrbMomentum(request.earlyOrbMomentum);
  const effectiveConfig = strategyConfigForVisualReview(active.config, earlyOrbMomentum);
  const formulaHash = formulaConfigurationHash({ symbol: request.symbol }, effectiveConfig);
  const strategyVersion = active.versionId
    ? `${active.strategyKey}:${active.versionId}:${active.versionNumber ?? "unknown"}`
    : `baseline:${active.formulaVersion}:${active.formulaHash}`;
  const normalizedProcessedDates = [...new Set(processedDates)].sort();
  const cacheInput = {
    cacheKeyVersion: VISUAL_VALIDATION_CACHE_KEY_VERSION,
    sourceFingerprint,
    formulaHash,
    formulaVersion: active.formulaVersion || FIXED_FORMULA_VERSION,
    targetPlanVersion: KEY_LEVEL_TARGET_PLAN_VERSION,
    dynamicTargetCalculationVersion: DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION,
    strategyEngineVersion: VISUAL_VALIDATION_STRATEGY_ENGINE_VERSION,
    strategyVersion,
    candidateProjectionVersion: VISUAL_VALIDATION_CANDIDATE_PROJECTION_VERSION,
    executionManagementVersion: VISUAL_VALIDATION_EXECUTION_MANAGEMENT_VERSION,
    snapshotProjectionVersion: VISUAL_VALIDATION_SNAPSHOT_PROJECTION_VERSION,
    chartProjectionVersion: VISUAL_VALIDATION_CHART_PROJECTION_VERSION,
    sessionCalendarVersion,
    symbol: request.symbol,
    contract: "MES",
    selectedDateRange: {
      endDate: request.endDate,
      inSampleDays: request.inSampleDays,
      outOfSampleDays: request.outOfSampleDays,
    },
    processedDates: normalizedProcessedDates,
    displaySettings: {
      premarketAvailable: request.premarketAvailable !== false,
      reviewMode: request.reviewMode ?? "trades_only",
      earlyOrbMomentum,
    },
    governedThresholds: effectiveConfig,
  };
  return {
    cacheKey: digest(cacheInput),
    cacheKeyVersion: VISUAL_VALIDATION_CACHE_KEY_VERSION,
    strategyVersion,
    formulaHash,
    formulaVersion: active.formulaVersion || FIXED_FORMULA_VERSION,
    candidateProjectionVersion: VISUAL_VALIDATION_CANDIDATE_PROJECTION_VERSION,
    executionManagementVersion: VISUAL_VALIDATION_EXECUTION_MANAGEMENT_VERSION,
    snapshotProjectionVersion: VISUAL_VALIDATION_SNAPSHOT_PROJECTION_VERSION,
    chartProjectionVersion: VISUAL_VALIDATION_CHART_PROJECTION_VERSION,
    sessionCalendarVersion,
  };
}