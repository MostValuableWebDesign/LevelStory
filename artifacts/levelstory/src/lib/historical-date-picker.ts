function canonicalToDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export const CALENDAR_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function clampDisplayMonth(date: Date, minDate: string, maxDate: string): Date {
  const month = monthStart(date);
  const minMonth = monthStart(canonicalToDate(minDate) ?? new Date(2021, 0, 1));
  const maxMonth = monthStart(canonicalToDate(maxDate) ?? new Date(2026, 11, 1));
  if (month < minMonth) return minMonth;
  if (month > maxMonth) return maxMonth;
  return month;
}

export function resolveOpeningMonth({
  value,
  lastValidValue,
  eligibleDates,
  minDate,
  maxDate,
  today,
}: {
  value?: string | null;
  lastValidValue?: string | null;
  eligibleDates?: readonly string[];
  minDate: string;
  maxDate: string;
  today: string;
}): Date {
  const eligible = new Set(eligibleDates ?? []);
  const candidates = [
    value && (!eligibleDates || eligible.has(value)) ? value : null,
    lastValidValue && (!eligibleDates || eligible.has(lastValidValue)) ? lastValidValue : null,
    latestEligibleDate(eligibleDates),
    maxDate,
    today,
  ];
  const selected = candidates.find((candidate): candidate is string => Boolean(candidate && canonicalToDate(candidate)));
  return clampDisplayMonth(canonicalToDate(selected ?? today) ?? new Date(), minDate, maxDate);
}

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

export function monthSelection(
  year: number,
  monthIndex: number,
  minDate: string,
  maxDate: string,
): Date {
  return clampDisplayMonth(new Date(year, monthIndex, 1), minDate, maxDate);
}

export function yearSelection(
  year: number,
  currentMonthIndex: number,
  minDate: string,
  maxDate: string,
): Date {
  return monthSelection(year, currentMonthIndex, minDate, maxDate);
}