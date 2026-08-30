import type { VisualValidationQualifyingLevel } from "@workspace/api-client-react";

const MES_TICK_SIZE = 0.25;

function isMesTick(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value / MES_TICK_SIZE - Math.round(value / MES_TICK_SIZE)) < 1e-8;
}

export type DynamicLevelInteraction = {
  value: number | null;
  distancePoints: number;
  distanceTicks: number;
  toleranceTicks: number;
  tolerancePoints: number;
  qualifies: boolean;
  reason: string;
};

export function evaluateDynamicLevelInteraction(
  value: number | null | undefined,
  candleHigh: number | null | undefined,
  candleLow: number | null | undefined,
  toleranceTicks: number,
): DynamicLevelInteraction {
  const tolerancePoints = toleranceTicks * MES_TICK_SIZE;
  if (!Number.isFinite(value) || !Number.isFinite(candleHigh) || !Number.isFinite(candleLow)) {
    return {
      value: value ?? null,
      distancePoints: Number.POSITIVE_INFINITY,
      distanceTicks: Number.POSITIVE_INFINITY,
      toleranceTicks,
      tolerancePoints,
      qualifies: false,
      reason: "No complete causal indicator value or L candle range is available.",
    };
  }
  const high = candleHigh as number;
  const low = candleLow as number;
  const indicatorValue = value as number;
  const distancePoints = high >= indicatorValue && low <= indicatorValue
    ? 0
    : high < indicatorValue ? indicatorValue - high : low - indicatorValue;
  const distanceTicks = Math.max(0, Math.ceil(Math.max(0, distancePoints) / MES_TICK_SIZE - 1e-10));
  const qualifies = distancePoints <= tolerancePoints + 1e-10;
  return {
    value: value!,
    distancePoints,
    distanceTicks,
    toleranceTicks,
    tolerancePoints,
    qualifies,
    reason: qualifies
      ? `Qualifies: ${distanceTicks} ticks from the L range.`
      : `Does not qualify: ${distanceTicks} ticks from the L range exceeds the ${toleranceTicks}-tick tolerance.`,
  };
}

export function deriveTeachingCompatibilityFields(levels: VisualValidationQualifyingLevel[] | undefined): {
  pullbackLevels: number[];
  qualifyingLevelId?: string;
  qualifyingLevelRangeLow?: number | null;
  qualifyingLevelRangeHigh?: number | null;
} {
  const fixedLevels = (levels ?? []).filter((level) =>
    level.levelType !== "dynamic_indicator" && isMesTick(level.valueAtInteraction));
  const firstFixed = fixedLevels[0];
  return {
    pullbackLevels: [...new Set(fixedLevels.map((level) => level.valueAtInteraction))].sort((a, b) => a - b),
    qualifyingLevelId: firstFixed?.levelId,
    qualifyingLevelRangeLow: firstFixed?.rangeLow ?? null,
    qualifyingLevelRangeHigh: firstFixed?.rangeHigh ?? null,
  };
}

export function normalizeTeachingQualifyingLevels(levels: VisualValidationQualifyingLevel[] | undefined): VisualValidationQualifyingLevel[] {
  return (levels ?? []).map((level) => ({
    ...level,
    valueAtInteraction: Number(level.valueAtInteraction),
    rangeLow: level.levelType === "dynamic_indicator" ? null : level.rangeLow ?? null,
    rangeHigh: level.levelType === "dynamic_indicator" ? null : level.rangeHigh ?? null,
  }));
}