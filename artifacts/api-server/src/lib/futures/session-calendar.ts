import type { FuturesContractSpecification, SessionHours } from "./contracts.js";

export type FuturesSessionKind = "premarket" | "regular" | "closed" | "replay";
export type TradingDate = `${number}-${number}-${number}`;

export type FuturesSessionCalendar = {
  timeZone: "America/New_York";
  premarket: SessionHours;
  regular: SessionHours;
  holidays: readonly string[];
  earlyCloses: Readonly<Record<string, string>>;
};

export type FuturesSessionWindow = {
  tradingDate: string;
  openTime: number;
  closeTime: number;
  kind: Exclude<FuturesSessionKind, "closed" | "replay">;
  earlyClose: boolean;
};

const DEFAULT_HOLIDAYS = [
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
] as const;

const DEFAULT_EARLY_CLOSES = {
  "2026-07-03": "13:00",
  "2026-11-27": "13:00",
  "2026-12-24": "13:00",
} as const;

export const DEFAULT_FUTURES_SESSION_CALENDAR: Readonly<FuturesSessionCalendar> = {
  timeZone: "America/New_York",
  premarket: { timeZone: "America/New_York", start: "04:00", end: "09:30" },
  regular: { timeZone: "America/New_York", start: "09:30", end: "16:00" },
  holidays: DEFAULT_HOLIDAYS,
  earlyCloses: DEFAULT_EARLY_CLOSES,
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function invalid(message: string): never {
  throw new Error(`Invalid futures session calendar: ${message}`);
}

function minutes(value: string): number {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function parseDateInput(date: string | number, timeZone: string): string {
  if (typeof date === "string") {
    if (!validDate(date)) invalid(`date "${date}" must use YYYY-MM-DD.`);
    return date;
  }
  if (!Number.isFinite(date)) invalid("date must be a finite timestamp or YYYY-MM-DD.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(date));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateParts(timestamp: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function wallClockAsUtc(date: string, time: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

/**
 * Converts a New York wall-clock time to an instant without a third-party
 * timezone database.  The session times are outside the DST transition hour,
 * so the offset found from Intl is unambiguous for this calendar.
 */
export function newYorkTimeToUtc(date: string, time: string): number {
  if (!validDate(date)) invalid(`date "${date}" must use YYYY-MM-DD.`);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) invalid(`time "${time}" must use HH:mm.`);
  const desiredWallClock = wallClockAsUtc(date, time);
  const parts = dateParts(desiredWallClock, "America/New_York");
  const localWallClock = Date.UTC(parts.year, parts.month - 1, parts.day, new Date(desiredWallClock).getUTCHours(), new Date(desiredWallClock).getUTCMinutes());
  const offset = localWallClock - desiredWallClock;
  return desiredWallClock - offset;
}

export function tradingDateForTimestamp(
  timestamp: number,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): string {
  if (!Number.isFinite(timestamp)) invalid("timestamp must be finite.");
  return DATE_FORMATTER.format(new Date(timestamp));
}

export function isWeekend(tradingDate: string): boolean {
  const day = new Date(`${tradingDate}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function isTradingDate(
  tradingDate: string,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): boolean {
  return validDate(tradingDate) && !isWeekend(tradingDate) && !calendar.holidays.includes(tradingDate);
}

export function previousTradingDate(
  tradingDate: string,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): string {
  let cursor = new Date(`${tradingDate}T12:00:00Z`);
  do {
    cursor = new Date(cursor.getTime() - 86_400_000);
    const candidate = cursor.toISOString().slice(0, 10);
    if (isTradingDate(candidate, calendar)) return candidate;
  } while (cursor.getUTCFullYear() > 1970);
  invalid(`could not find a prior trading date for ${tradingDate}.`);
}

export function listTradingDates(
  lastDate: string,
  count: number,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): string[] {
  if (!Number.isInteger(count) || count < 1) invalid("count must be a positive integer.");
  const result: string[] = [];
  let cursor = lastDate;
  while (result.length < count) {
    if (isTradingDate(cursor, calendar)) result.unshift(cursor);
    cursor = previousCalendarDate(cursor);
  }
  return result;
}

function previousCalendarDate(tradingDate: string): string {
  const date = new Date(`${tradingDate}T12:00:00Z`);
  return new Date(date.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export function sessionCalendarForContract(
  specification: FuturesContractSpecification,
): FuturesSessionCalendar {
  return {
    ...DEFAULT_FUTURES_SESSION_CALENDAR,
    timeZone: "America/New_York",
    premarket: { timeZone: "America/New_York", start: "04:00", end: "09:30" },
    regular: {
      timeZone: "America/New_York",
      start: specification.regularSessionHours.start,
      end: specification.regularSessionHours.end,
    },
  };
}

export function sessionWindow(
  date: string | number,
  kind: Exclude<FuturesSessionKind, "closed" | "replay">,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): FuturesSessionWindow | null {
  const tradingDate = parseDateInput(date, calendar.timeZone);
  if (!isTradingDate(tradingDate, calendar)) return null;
  const hours = calendar[kind];
  const closeTimeText = kind === "regular" ? calendar.earlyCloses[tradingDate] ?? hours.end : hours.end;
  const openTime = newYorkTimeToUtc(tradingDate, hours.start);
  const closeTime = newYorkTimeToUtc(tradingDate, closeTimeText);
  if (closeTime <= openTime) invalid(`${kind} session must close after it opens.`);
  return { tradingDate, openTime, closeTime, kind, earlyClose: kind === "regular" && closeTimeText !== hours.end };
}

export function timestampForTradingDate(
  tradingDate: string,
  time: string,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): number {
  if (!isTradingDate(tradingDate, calendar)) invalid(`${tradingDate} is not a trading date.`);
  return newYorkTimeToUtc(tradingDate, time);
}

export function classifyFuturesSession(
  timestamp: number,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): FuturesSessionKind {
  if (!Number.isFinite(timestamp)) return "closed";
  const tradingDate = tradingDateForTimestamp(timestamp, calendar);
  const premarket = sessionWindow(tradingDate, "premarket", calendar);
  const regular = sessionWindow(tradingDate, "regular", calendar);
  if (!premarket || !regular) return "closed";
  if (timestamp >= premarket.openTime && timestamp < premarket.closeTime) return "premarket";
  if (timestamp >= regular.openTime && timestamp < regular.closeTime) return "regular";
  return "closed";
}