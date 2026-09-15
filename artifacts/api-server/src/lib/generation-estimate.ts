/** Complete-run timings include loading, replay, snapshots and storage. */
export function estimateRunDurationMs(samples: number[]): number | null {
  const valid = samples.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  return valid.length ? Math.ceil(valid[Math.ceil(valid.length * 0.9) - 1]) : null;
}
export function remainingUntilDeadline(durationMs: number | null, elapsedMs: number): number | null {
  return durationMs === null ? null : Math.max(0, durationMs - Math.max(0, elapsedMs));
}
