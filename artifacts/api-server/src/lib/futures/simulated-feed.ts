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

export type SimulatedHourlyCandle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  applyDeterministicAPlusScenario(candles, specification, tradingDates.at(-1)!, options.calendar, seed);
  return candles.sort((first, second) => first.timestamp - second.timestamp);
}

function applyDeterministicAPlusScenario(
  candles: SimulatedFuturesCandle[],
  specification: FuturesContractSpecification,
  tradingDate: string,
  calendar: FuturesSessionCalendar,
  seed: number,
): void {
  const regularWindow = sessionWindow(tradingDate, "regular", calendar);
  if (!regularWindow) return;
  const regular = candles
    .filter((candle) =>
      candle.openTime >= regularWindow.openTime
      && candle.openTime < regularWindow.closeTime
      && tradingDateForTimestamp(candle.openTime, calendar) === tradingDate,
    )
    .sort((first, second) => first.openTime - second.openTime);
  if (regular.length < 38) return;

  const base = referencePrice(specification);
  const bullish = Math.abs(seed) % 2 === 1;
  const set = (
    index: number,
    values: { open: number; high: number; low: number; close: number; volume: number },
  ): void => {
    const candle = regular[index];
    candle.open = roundToTick(values.open, specification);
    candle.high = roundToTick(values.high, specification);
    candle.low = roundToTick(values.low, specification);
    candle.close = roundToTick(values.close, specification);
    candle.bid = roundToTick(candle.close - specification.tickSize, specification);
    candle.ask = candle.close;
    candle.volume = values.volume;
  };

  if (bullish) {
    set(0, { open: base, high: base + 1, low: base - 1, close: base, volume: 1_000 });
    set(1, { open: base, high: base + 1.25, low: base - 0.75, close: base + 0.5, volume: 1_000 });
    set(2, { open: base + 0.5, high: base + 1.5, low: base - 0.5, close: base + 1, volume: 1_000 });
    for (let index = 3; index < 30; index += 1) {
      const group = Math.floor(index / 3);
      const close = base + 0.5 + group * 0.1;
      const lowByGroup: Record<number, number> = {
        1: -0.75,
        2: -0.5,
        3: -0.25,
        4: -0.25,
        5: 0,
        6: 0.25,
        7: 0.5,
        8: 0.75,
        9: 1,
      };
      set(index, {
        open: close - 0.1,
        high: base + 1.5 + group * 0.4 + (index % 3) * 0.05,
        low: base + (lowByGroup[group] ?? -0.25) + (index % 3) * 0.02,
        close,
        volume: 1_000,
      });
    }
    set(30, { open: base + 1.5, high: base + 9, low: base + 1.25, close: base + 8, volume: 10_000 });
    set(31, { open: base + 8, high: base + 8.5, low: base + 1.25, close: base + 8, volume: 1_000 });
    set(32, { open: base + 8, high: base + 9.5, low: base + 7.75, close: base + 9, volume: 1_000 });
    set(33, { open: base + 9, high: base + 10.5, low: base + 8.75, close: base + 10, volume: 1_000 });
    set(34, { open: base + 10, high: base + 11, low: base + 9.5, close: base + 10.5, volume: 1_000 });
    set(35, { open: base + 10.5, high: base + 10.75, low: base + 9, close: base + 10.5, volume: 1_000 });
    set(36, { open: base + 10.5, high: base + 12, low: base + 10, close: base + 11.75, volume: 2_000 });
    set(37, { open: base + 11.75, high: base + 27, low: base + 11.5, close: base + 26, volume: 2_000 });
    return;
  }

  set(0, { open: base, high: base + 1, low: base - 1, close: base, volume: 1_000 });
  set(1, { open: base, high: base + 0.75, low: base - 1.25, close: base - 0.5, volume: 1_000 });
  set(2, { open: base - 0.5, high: base + 0.5, low: base - 1.5, close: base - 1, volume: 1_000 });
  for (let index = 3; index < 30; index += 1) {
    const group = Math.floor(index / 3);
    const close = base - 0.5 - group * 0.1;
    const highByGroup: Record<number, number> = {
      1: 0.75,
      2: 0.5,
      3: 0.25,
      4: 0,
      5: -0.25,
      6: -0.5,
      7: -0.75,
      8: -1,
      9: -1.25,
    };
    const lowByGroup: Record<number, number> = {
      1: -1.75,
      2: -2,
      3: -2.25,
      4: -2.5,
      5: -2.75,
      6: -3,
      7: -3.25,
      8: -3.5,
      9: -3.75,
    };
    set(index, {
      open: close + 0.1,
      high: base + (highByGroup[group] ?? 0.5) - (index % 3) * 0.02,
      low: base + (lowByGroup[group] ?? -2.5) - (index % 3) * 0.02,
      close,
      volume: 1_000,
    });
  }
  set(30, { open: base - 1.5, high: base - 1.5, low: base - 9, close: base - 8, volume: 10_000 });
  set(31, { open: base - 8, high: base - 1.5, low: base - 8.5, close: base - 8, volume: 1_000 });
  set(32, { open: base - 8, high: base - 7.75, low: base - 8.5, close: base - 8.5, volume: 1_000 });
  set(33, { open: base - 8.5, high: base - 8.75, low: base - 9.5, close: base - 9, volume: 1_000 });
  set(34, { open: base - 9, high: base - 9.5, low: base - 10, close: base - 9.5, volume: 1_000 });
  set(35, { open: base - 9.5, high: base - 9, low: base - 9.75, close: base - 9.5, volume: 1_000 });
  set(36, { open: base - 9.5, high: base - 9.25, low: base - 11, close: base - 10.75, volume: 2_000 });
  set(37, { open: base - 10.75, high: base - 10.5, low: base - 26, close: base - 25.75, volume: 2_000 });
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

export function completedSimulatedHourlyCandles(
  candles: readonly SimulatedFuturesCandle[],
  calendar: FuturesSessionCalendar,
): SimulatedHourlyCandle[] {
  const groups = new Map<string, SimulatedFuturesCandle[]>();
  const dateCache = new Map<number, string>();
  const windowCache = new Map<string, ReturnType<typeof sessionWindow>>();
  for (const candle of candles) {
    if (!candle.isComplete) continue;
    const utcDateKey = Math.floor(candle.openTime / (24 * 60 * MINUTE));
    const tradingDate = dateCache.get(utcDateKey) ?? tradingDateForTimestamp(candle.openTime, calendar);
    dateCache.set(utcDateKey, tradingDate);
    let regularWindow = windowCache.get(tradingDate);
    if (regularWindow === undefined) {
      regularWindow = sessionWindow(tradingDate, "regular", calendar);
      windowCache.set(tradingDate, regularWindow);
    }
    if (!regularWindow) continue;
    if (candle.openTime < regularWindow.openTime || candle.openTime >= regularWindow.closeTime) continue;
    const hourIndex = Math.floor((candle.openTime - regularWindow.openTime) / (60 * MINUTE));
    const key = `${tradingDate}:${hourIndex}`;
    const group = groups.get(key) ?? [];
    group.push(candle);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group) => group.length === 12)
    .map((group) => {
      const sorted = [...group].sort((first, second) => first.openTime - second.openTime);
      return {
        openTime: sorted[0].openTime,
        closeTime: sorted.at(-1)!.closeTime,
        open: sorted[0].open,
        high: Math.max(...sorted.map((candle) => candle.high)),
        low: Math.min(...sorted.map((candle) => candle.low)),
        close: sorted.at(-1)!.close,
        volume: sorted.reduce((sum, candle) => sum + candle.volume, 0),
        isComplete: sorted.every((candle) => candle.isComplete),
      };
    })
    .sort((first, second) => first.openTime - second.openTime);
}

export function feedSession(
  candle: SimulatedFuturesCandle,
  calendar: FuturesSessionCalendar,
): "premarket" | "regular" | "closed" | "replay" {
  return classifyFuturesSession(candle.timestamp, calendar);
}