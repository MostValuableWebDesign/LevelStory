/** Work-based estimate: time alone never advances progress or exhausts the ETA. */
export function estimateWorkRemainingMs(elapsedMs: number, completedUnits: number, totalUnits: number, previousMs: number | null): number | null {
  if (completedUnits < 20 || elapsedMs < 2000 || totalUnits <= completedUnits) return previousMs;
  const remaining = Math.max(1000, Math.ceil(elapsedMs / completedUnits * (totalUnits - completedUnits)));
  return previousMs === null ? remaining : Math.min(previousMs, remaining);
}
