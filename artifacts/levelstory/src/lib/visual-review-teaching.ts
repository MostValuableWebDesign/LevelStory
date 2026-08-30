import type { VisualValidationQualifyingLevel } from "@workspace/api-client-react";

const MES_TICK_SIZE = 0.25;

function isMesTick(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value / MES_TICK_SIZE - Math.round(value / MES_TICK_SIZE)) < 1e-8;
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