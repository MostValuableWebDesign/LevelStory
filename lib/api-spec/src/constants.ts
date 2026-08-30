/**
 * The single-run replay ceiling is intentionally shared by the API and the
 * LevelStory form. Batch validation has its own, larger partition limit.
 */
export const MAX_BACKTEST_SESSIONS = 22 as const;

/** MES contract constants shared by API validation, replay, and LevelStory. */
export const MES_TICK_SIZE = 0.25 as const;
export const LEVEL_TOLERANCE_TICKS = [4, 8, 12] as const;
export const DEFAULT_LEVEL_TOLERANCE_TICKS = 12 as const;
export const DEFAULT_LEVEL_TOLERANCE_POINTS = DEFAULT_LEVEL_TOLERANCE_TICKS * MES_TICK_SIZE;

export type LevelToleranceTicks = typeof LEVEL_TOLERANCE_TICKS[number];

export function levelTolerancePoints(ticks: number): number {
  return ticks * MES_TICK_SIZE;
}