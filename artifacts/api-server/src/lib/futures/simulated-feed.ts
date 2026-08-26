import { roundToTick, type FuturesContractSpecification } from "./contracts.js";
import { classifyFuturesSession, type FuturesSessionCalendar } from "./session-calendar.js";

export type SimulatedFuturesCandle = {
  timestamp: number;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  contractSymbol: string;
  isComplete: boolean;
};

export type SimulatedFeedOptions = {
  startDate?: number;
  days?: number;
  seed?: number;
  includePremarket?: boolean;
  calendar: FuturesSessionCalendar;
};

const DAY = 86_400_000;
const MINUTE = 60_000;

const referencePrices: Record<string, number> = {
  MES: 6_800,
  ES: 6_800,
  MNQ: 24_000,
  NQ: 24_000,
};

function referencePrice(specification: FuturesContractSpecification): number {
  return referencePrices[specification.rootSymbol] ?? 1_000;
}

function seededWave(index: number, seed: number): number {
  return Math.sin(index * 0.71 + seed * 0.13) * 0.55 + Math.sin(index * 0.19 + seed) * 0.22;
}

function sessionMinutes(calendar: FuturesSessionCalendar, kind: "premarket" | "regular"): [number, number] {
  const hours = calendar[kind];
  const parse = (value: string) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  };
  return [parse(hours.start), parse(hours.end)];
}

export function generateSimulatedFuturesFeed(
  specification: FuturesContractSpecification,
  options: SimulatedFeedOptions,
): SimulatedFuturesCandle[] {
  const startDate = options.startDate ?? Date.UTC(2026, 7, 25);
  const days = Math.max(1, Math.floor(options.days ?? 3));
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed!) : 1;
  const candles: SimulatedFuturesCandle[] = [];
  const base = referencePrice(specification);
  const [regularStart, regularEnd] = sessionMinutes(options.calendar, "regular");
  const [premarketStart] = sessionMinutes(options.calendar, "premarket");
  const interval = 5 * MINUTE;

  for (let dayOffset = -(days - 1); dayOffset <= 0; dayOffset++) {
    const day = startDate + dayOffset * DAY;
    const start = options.includePremarket ? premarketStart : regularStart;
    for (let minute = start; minute < regularEnd; minute += 5) {
      const index = Math.max(0, Math.round((minute - regularStart) / 5));
      const premarket = minute < regularStart;
      const drift = dayOffset * -0.42 + (premarket ? 0.12 : 1 + index * 0.035);
      const wave = seededWave(index + dayOffset * 97, seed);
      const close = roundToTick(base + drift + wave, specification);
      const open = roundToTick(close - seededWave(index + 11, seed) * 0.22, specification);
      const high = roundToTick(Math.max(open, close) + 0.18 + (index % 3) * 0.03, specification);
      const low = roundToTick(Math.min(open, close) - 0.16 - (index % 2) * 0.03, specification);
      const openTime = day + minute * MINUTE;
      const closeTime = openTime + interval;
      const spreadTicks = 1 + ((index + seed) % 2);
      const spread = spreadTicks * specification.tickSize;
      const volume = Math.round(
        1_000 + Math.max(index, 0) * 42 + ((index + seed) % 5) * 130 +
          (dayOffset === 0 && index >= 3 && index < 9 ? 900 : 0),
      );
      candles.push({
        timestamp: openTime,
        openTime,
        closeTime,
        open,
        high,
        low,
        close,
        volume,
        bid: roundToTick(close - spread, specification),
        ask: close,
        bidSize: 10 + ((index + seed) % 8) * 5,
        askSize: 10 + ((index + seed * 2) % 8) * 5,
        contractSymbol: specification.fullContractSymbol,
        isComplete: true,
      });
    }
  }
  return candles.sort((first, second) => first.timestamp - second.timestamp);
}

export function completedSimulatedCandles(
  candles: readonly SimulatedFuturesCandle[],
  cursor: number,
): SimulatedFuturesCandle[] {
  return candles
    .filter((candle) => candle.isComplete && candle.closeTime <= cursor)
    .sort((first, second) => first.closeTime - second.closeTime)
    .map((candle) => ({ ...candle }));
}

export function feedSession(
  candle: SimulatedFuturesCandle,
  calendar: FuturesSessionCalendar,
): "premarket" | "regular" | "closed" | "replay" {
  return classifyFuturesSession(candle.timestamp, calendar);
}