import { roundToTick, type FuturesContractSpecification } from "./contracts.js";
import {
  classifyFuturesSession,
  listTradingDates,
  sessionWindow,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "./session-calendar.js";

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
  startDate?: string | number;
  days?: number;
  seed?: number;
  includePremarket?: boolean;
  premarketAvailable?: boolean;
  calendar: FuturesSessionCalendar;
};

const MINUTE = 60_000;
const INTERVAL = 5 * MINUTE;

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

export function generateSimulatedFuturesFeed(
  specification: FuturesContractSpecification,
  options: SimulatedFeedOptions,
): SimulatedFuturesCandle[] {
  const startDate = options.startDate ?? "2026-08-25";
  const days = Math.max(1, Math.floor(options.days ?? 3));
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed!) : 1;
  const candles: SimulatedFuturesCandle[] = [];
  const base = referencePrice(specification);
  const lastTradingDate = typeof startDate === "string"
    ? startDate
    : tradingDateForTimestamp(startDate, options.calendar);
  const tradingDates = listTradingDates(lastTradingDate, days, options.calendar);
  const includePremarket = options.includePremarket === true && options.premarketAvailable !== false;

  for (const [dayIndex, tradingDate] of tradingDates.entries()) {
    const regularWindow = sessionWindow(tradingDate, "regular", options.calendar);
    if (!regularWindow) continue;
    const premarketWindow = includePremarket ? sessionWindow(tradingDate, "premarket", options.calendar) : null;
    const start = premarketWindow?.openTime ?? regularWindow.openTime;
    for (let openTime = start; openTime < regularWindow.closeTime; openTime += INTERVAL) {
      const premarket = premarketWindow !== null && openTime < regularWindow.openTime;
      const index = Math.max(0, Math.round((openTime - regularWindow.openTime) / INTERVAL));
      const drift = (dayIndex - tradingDates.length + 1) * -0.42 + (premarket ? 0.12 : 1 + index * 0.035);
      const wave = seededWave(index + (dayIndex - tradingDates.length + 1) * 97, seed);
      const close = roundToTick(base + drift + wave, specification);
      const open = roundToTick(close - seededWave(index + 11, seed) * 0.22, specification);
      const high = roundToTick(Math.max(open, close) + 0.18 + (index % 3) * 0.03, specification);
      const low = roundToTick(Math.min(open, close) - 0.16 - (index % 2) * 0.03, specification);
      const spreadTicks = 1 + ((index + seed) % 2);
      const spread = spreadTicks * specification.tickSize;
      const volume = Math.round(
        1_000 + Math.max(index, 0) * 42 + ((index + seed) % 5) * 130 +
          (dayIndex === tradingDates.length - 1 && index >= 3 && index < 9 ? 900 : 0),
      );
      candles.push({
        timestamp: openTime,
        openTime,
        closeTime: openTime + INTERVAL,
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