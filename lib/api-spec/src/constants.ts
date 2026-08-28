/**
 * The single-run replay ceiling is intentionally shared by the API and the
 * LevelStory form. Batch validation has its own, larger partition limit.
 */
export const MAX_BACKTEST_SESSIONS = 22 as const;