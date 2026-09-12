export function sortedEligibleDates(eligibleDates: readonly string[] | undefined): string[] | undefined {
  return eligibleDates === undefined ? undefined : [...new Set(eligibleDates)].sort();
}

export function relativeEligibleDate(
  current: string,
  direction: -1 | 1,
  eligibleDates: readonly string[],
): string | null {
  const dates = [...new Set(eligibleDates)].sort();
  if (direction < 0) dates.reverse();
  return dates.find((candidate) => direction < 0 ? candidate < current : candidate > current) ?? null;
}

export function latestEligibleDate(eligibleDates: readonly string[] | undefined): string | null {
  const dates = sortedEligibleDates(eligibleDates);
  return dates?.at(-1) ?? null;
}

export function historicalDateReason(
  dateValue: string,
  eligibleDates: readonly string[] | undefined,
  minDate: string | null | undefined,
  maxDate: string | null | undefined,
  disabledDateReasons?: ReadonlyMap<string, string>,
): string | null {
  if (minDate && dateValue < minDate) return "Before the indexed historical coverage.";
  if (maxDate && dateValue > maxDate) return "After the indexed historical coverage.";
  if (!eligibleDates) return "Indexed eligible-date metadata is still loading.";
  return disabledDateReasons?.get(dateValue)
    ?? (eligibleDates.includes(dateValue) ? null : "This date is not an eligible indexed trading date.");
}

export function restoreLastEligibleDate(
  lastValidDate: string,
  eligibleDates: readonly string[] | undefined,
): string {
  return eligibleDates?.includes(lastValidDate) ? lastValidDate : "";
}