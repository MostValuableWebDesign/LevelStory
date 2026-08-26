import type { FuturesContractSpecification, SessionHours } from "./contracts.js";

export type FuturesSessionKind = "premarket" | "regular" | "closed" | "replay";

export type FuturesSessionCalendar = {
  timeZone: string;
  premarket: SessionHours;
  regular: SessionHours;
};

export const DEFAULT_FUTURES_SESSION_CALENDAR: Readonly<FuturesSessionCalendar> = {
  timeZone: "UTC",
  premarket: { timeZone: "UTC", start: "04:00", end: "09:30" },
  regular: { timeZone: "UTC", start: "09:30", end: "16:00" },
};

function minutes(value: string): number {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
}

function minutesOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

export function sessionCalendarForContract(
  specification: FuturesContractSpecification,
): FuturesSessionCalendar {
  return {
    ...DEFAULT_FUTURES_SESSION_CALENDAR,
    timeZone: specification.regularSessionHours.timeZone,
    regular: { ...specification.regularSessionHours },
  };
}

export function classifyFuturesSession(
  timestamp: number,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): FuturesSessionKind {
  if (!Number.isFinite(timestamp)) return "closed";
  const current = minutesOfUtcDay(timestamp);
  const premarketStart = minutes(calendar.premarket.start);
  const premarketEnd = minutes(calendar.premarket.end);
  const regularStart = minutes(calendar.regular.start);
  const regularEnd = minutes(calendar.regular.end);
  if (current >= premarketStart && current < premarketEnd) return "premarket";
  if (current >= regularStart && current < regularEnd) return "regular";
  return "closed";
}

export function sessionWindow(
  date: number,
  kind: Exclude<FuturesSessionKind, "closed" | "replay">,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
): { openTime: number; closeTime: number; kind: Exclude<FuturesSessionKind, "closed" | "replay"> } {
  const hours = calendar[kind];
  const [openHour, openMinute] = hours.start.split(":").map(Number);
  const [closeHour, closeMinute] = hours.end.split(":").map(Number);
  const day = Date.UTC(new Date(date).getUTCFullYear(), new Date(date).getUTCMonth(), new Date(date).getUTCDate());
  return {
    openTime: day + (openHour * 60 + openMinute) * 60_000,
    closeTime: day + (closeHour * 60 + closeMinute) * 60_000,
    kind,
  };
}