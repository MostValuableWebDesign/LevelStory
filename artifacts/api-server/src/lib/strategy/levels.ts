import type { Candle, Level } from "./types.js";
import { completedEma, emaSlope, fibonacci, regularSessionVwap, rsi, volumeRatio } from "./indicators.js";
import type { StrategyConfig } from "./config.js";
import { FUTURES_CONTRACT_SPECS, type FuturesContractSpecification } from "../futures/contracts.js";
import type { SimulatedHourlyCandle } from "../futures/simulated-feed.js";
import { majorLevels as detectMajorLevels, type MajorLevel } from "./major-levels.js";
import {
  classifyFuturesSession,
  DEFAULT_FUTURES_SESSION_CALENDAR,
  sessionWindow,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "../futures/session-calendar.js";

export type SessionWindows = {
  premarket: readonly Candle[];
  regular: readonly Candle[];
  tradingDate?: string;
  replayCursor?: number;
  premarketAvailable?: boolean;
  historicalHourly?: readonly SimulatedHourlyCandle[];
};

export type NtzEventType =
  | "NTZ forming"
  | "NTZ completed"
  | "Price inside"
  | "Close outside"
  | "Break and reentry"
  | "Break and retest"
  | "Failed breakout"
  | "Consolidation inside NTZ";

export type NtzEvent = {
  type: NtzEventType;
  time: number;
  detail: string;
};

export type NtzPhase = "pending" | "forming" | "completed";
export type NtzPosition = "unknown" | "inside" | "outside";
export type NtzRange = { high: number; low: number; complete: boolean; completedAt?: number };

export type SessionLevels = {
  levels: Level[];
  orb: { high: number; low: number } | null;
  orbComplete: boolean;
  ntz: NtzRange | null;
  ntzPhase: NtzPhase;
  ntzPosition: NtzPosition;
  ntzEvents: NtzEvent[];
  vwap: number;
  ema: number;
  rsi: number;
  volumeRatio: number;
  fibonacci: Level[];
  emaSlope: number;
  majorLevels: MajorLevel[];
  previousDayClose: number | null;
};

const FIVE_MINUTES = 5 * 60_000;

export function sessionLevels(
  candles: readonly Candle[],
  windows: SessionWindows,
  config: StrategyConfig,
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
  specification: FuturesContractSpecification = FUTURES_CONTRACT_SPECS.MES,
): SessionLevels {
  const regular = [...windows.regular].sort((first, second) => first.openTime - second.openTime);
  const currentTradingDate = windows.tradingDate
    ?? (regular[0] ? tradingDateForTimestamp(regular[0].openTime, calendar) : undefined)
    ?? (candles[0] ? tradingDateForTimestamp(candles[0].openTime, calendar) : undefined);
  const regularCandles = candles
    .filter((candle) => classifyFuturesSession(candle.openTime, calendar) === "regular")
    .sort((first, second) => first.openTime - second.openTime);
  const dayMap = new Map<string, Candle[]>();
  for (const candle of regularCandles) {
    const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
    const day = dayMap.get(tradingDate) ?? [];
    day.push(candle);
    dayMap.set(tradingDate, day);
  }
  const tradingDays = [...dayMap.keys()].sort((first, second) => second.localeCompare(first));
  const currentDate = currentTradingDate ?? tradingDays[0];
  const priorDays = tradingDays.filter((date) => date < (currentDate ?? ""));
  const previousDay = priorDays[0] ? dayMap.get(priorDays[0]) ?? [] : [];
  const dayBeforeYesterday = priorDays[1] ? dayMap.get(priorDays[1]) ?? [] : [];

  const currentSessionWindow = currentDate ? sessionWindow(currentDate, "regular", calendar) : null;
  const openingRangeStart = currentSessionWindow?.openTime;
  const openingRangeCandles = openingRangeStart === undefined ? [] : exactOpeningCandles(regular, openingRangeStart);
  const orbComplete = openingRangeCandles.length === 3;
  const partialRangeCandles = openingRangeCandles;
  const ntz = partialRangeCandles.length
    ? {
        high: Math.max(...partialRangeCandles.map((candle) => candle.high)),
        low: Math.min(...partialRangeCandles.map((candle) => candle.low)),
        complete: orbComplete,
        completedAt: orbComplete ? partialRangeCandles[2].closeTime : undefined,
      }
    : null;
  const ntzPhase: NtzPhase = orbComplete ? "completed" : partialRangeCandles.length ? "forming" : "pending";
  const orb = orbComplete ? { high: ntz!.high, low: ntz!.low } : null;
  const ntzEvents = buildNtzEvents(regular, openingRangeCandles, ntz, openingRangeStart);

  const levels: Level[] = [];
  if (windows.premarket.length && windows.premarketAvailable !== false) {
    levels.push(
      { name: "Premarket high", price: Math.max(...windows.premarket.map((candle) => candle.high)) },
      { name: "Premarket low", price: Math.min(...windows.premarket.map((candle) => candle.low)) },
    );
  }
  const priorLevels: Array<[string, number]> = [
    ["Prior day high", high(previousDay)],
    ["Prior day low", low(previousDay)],
    ["Two days ago high", high(dayBeforeYesterday)],
    ["Two days ago low", low(dayBeforeYesterday)],
  ];
  for (const [name, price] of priorLevels) {
    if (Number.isFinite(price)) levels.push({ name, price });
  }
  if (orb) levels.push({ name: "ORB high", price: orb.high }, { name: "ORB low", price: orb.low });
  if (ntz) levels.push({ name: "NTZ high", price: ntz.high }, { name: "NTZ low", price: ntz.low });

  const indicatorCandles = [...previousDay, ...regular];
  const emaValues = completedEma(candles, config.emaPeriod);
  const currentEma = emaValues.at(-1) ?? NaN;
  const currentVwap = regularSessionVwap(candles, calendar, currentDate);
  const fibonacciLevels = fibonacci(regular);
  const referenceComponents = [
    ...levels,
    { name: "VWAP", price: currentVwap },
    { name: "EMA 200", price: currentEma },
    ...fibonacciLevels,
  ];
  const detectedMajorLevels = detectMajorLevels(
    windows.historicalHourly ?? [],
    specification,
    config,
    referenceComponents,
  );
  const position = ntz && orbComplete && regular.length
    ? regular.at(-1)!.close >= ntz.low && regular.at(-1)!.close <= ntz.high ? "inside" : "outside"
    : "unknown";
  return {
    levels,
    orb,
    orbComplete,
    ntz,
    ntzPhase,
    ntzPosition: position,
    ntzEvents,
    previousDayClose: previousDay.at(-1)?.close ?? null,
    vwap: currentVwap,
    ema: currentEma,
    emaSlope: emaSlope(candles, config.emaPeriod, config.emaSlopeWindow),
    rsi: rsi(indicatorCandles.map((candle) => candle.close), config.rsiPeriod).at(-1) ?? 50,
    volumeRatio: volumeRatio(regular, config.volumeLookback),
    fibonacci: fibonacciLevels,
    majorLevels: detectedMajorLevels,
  };
}

function high(candles: readonly Candle[]): number {
  return candles.length ? Math.max(...candles.map((candle) => candle.high)) : NaN;
}

function low(candles: readonly Candle[]): number {
  return candles.length ? Math.min(...candles.map((candle) => candle.low)) : NaN;
}

function exactOpeningCandles(candles: readonly Candle[], openingRangeStart: number): Candle[] {
  const result: Candle[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const expectedOpen = openingRangeStart + offset * FIVE_MINUTES;
    const candidate = candles.find((candle) =>
      candle.openTime === expectedOpen
      && candle.closeTime === expectedOpen + FIVE_MINUTES
      && candle.isComplete,
    );
    if (!candidate) break;
    result.push(candidate);
  }
  return result;
}

function buildNtzEvents(
  regular: readonly Candle[],
  openingRangeCandles: readonly Candle[],
  ntz: NtzRange | null,
  openingRangeStart: number | undefined,
): NtzEvent[] {
  if (!openingRangeStart || !ntz) return [];
  const events: NtzEvent[] = [];
  if (openingRangeCandles.length < 3) {
    events.push({
      type: "NTZ forming",
      time: openingRangeCandles.at(-1)?.closeTime ?? openingRangeStart,
      detail: `${openingRangeCandles.length}/3 opening candles completed; NTZ is not final.`,
    });
    return events;
  }
  const completedAt = openingRangeCandles[2].closeTime;
  events.push({ type: "NTZ completed", time: completedAt, detail: "The 9:40–9:45 ET candle closed; NTZ/ORB is final." });

  const afterRange = regular.filter((candle) => candle.openTime >= completedAt && candle.isComplete);
  let previousPosition: NtzPosition = "unknown";
  let lastBreak: { side: "above" | "below"; time: number; retested: boolean } | null = null;
  let insideStreak = 0;
  for (const candle of afterRange) {
    const inside = candle.close >= ntz.low && candle.close <= ntz.high;
    const side: "above" | "below" | null = candle.close > ntz.high ? "above" : candle.close < ntz.low ? "below" : null;
    if (inside) {
      insideStreak += 1;
      if (previousPosition !== "inside") {
        events.push({ type: "Price inside", time: candle.closeTime, detail: "Completed close is inside the finalized NTZ." });
      }
      if (previousPosition === "outside") {
        events.push({ type: "Break and reentry", time: candle.closeTime, detail: "Price broke outside NTZ and closed back inside." });
        if (lastBreak) events.push({ type: "Failed breakout", time: candle.closeTime, detail: `The ${lastBreak.side} breakout failed on reentry.` });
      }
      if (insideStreak === 2) {
        events.push({ type: "Consolidation inside NTZ", time: candle.closeTime, detail: "Two consecutive completed closes remain inside NTZ." });
      }
      previousPosition = "inside";
      continue;
    }

    insideStreak = 0;
    if (previousPosition !== "outside") {
      events.push({ type: "Close outside", time: candle.closeTime, detail: `Completed close is ${side === "above" ? "above" : "below"} NTZ.` });
      lastBreak = side ? { side, time: candle.closeTime, retested: false } : null;
    } else if (lastBreak && !lastBreak.retested && side === lastBreak.side && touchesBrokenEdge(candle, ntz, lastBreak.side)) {
      events.push({ type: "Break and retest", time: candle.closeTime, detail: `Price retested the ${lastBreak.side} NTZ boundary and held outside.` });
      lastBreak.retested = true;
    }
    previousPosition = "outside";
  }
  return events;
}

function touchesBrokenEdge(candle: Candle, ntz: NtzRange, side: "above" | "below"): boolean {
  return side === "above"
    ? candle.low <= ntz.high && candle.high > ntz.high
    : candle.high >= ntz.low && candle.low < ntz.low;
}