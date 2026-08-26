import type { Candle, Level } from "./types.js";
import {
  classifyFuturesSession,
  DEFAULT_FUTURES_SESSION_CALENDAR,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "../futures/session-calendar.js";

export function ema(values: readonly number[], period: number): number[] {
  if (period <= 0) throw new Error("EMA period must be positive");
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) result.push(values[i] * alpha + result[i - 1] * (1 - alpha));
  return result;
}

export function completedEma(candles: readonly Candle[], period: number): number[] {
  const completed = candles
    .filter((candle) => candle.isComplete)
    .sort((first, second) => first.closeTime - second.closeTime);
  return ema(completed.map((candle) => candle.close), period);
}

export function emaSlope(
  candles: readonly Candle[],
  period: number,
  window: number,
): number {
  if (!Number.isInteger(window) || window <= 0) throw new Error("EMA slope window must be a positive integer");
  const series = completedEma(candles, period);
  if (series.length <= window) return NaN;
  return series.at(-1)! - series.at(-(window + 1))!;
}

export function rsi(values: readonly number[], period = 14): number[] {
  if (period <= 0) throw new Error("RSI period must be positive");
  if (values.length < 2) return values.map(() => 50);
  const out = values.map(() => 50);
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0); loss += Math.max(-change, 0);
    if (i > period) {
      const prior = values[i - period] - values[i - period - 1];
      gain -= Math.max(prior, 0); loss -= Math.max(-prior, 0);
    }
    const rs = loss === 0 ? Infinity : gain / loss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

export function vwap(candles: readonly Candle[]): number {
  let pv = 0, volume = 0;
  for (const c of candles) { const typical = (c.high + c.low + c.close) / 3; pv += typical * c.volume; volume += c.volume; }
  return volume ? pv / volume : NaN;
}

export function regularSessionVwap(
  candles: readonly Candle[],
  calendar: FuturesSessionCalendar = DEFAULT_FUTURES_SESSION_CALENDAR,
  tradingDate?: string,
): number {
  const completedRegular = candles
    .filter((candle) => candle.isComplete && classifyFuturesSession(candle.openTime, calendar) === "regular")
    .sort((first, second) => first.closeTime - second.closeTime);
  const date = tradingDate ?? (
    completedRegular.length
      ? tradingDateForTimestamp(completedRegular.at(-1)!.openTime, calendar)
      : undefined
  );
  return vwap(completedRegular.filter((candle) =>
    date === undefined || tradingDateForTimestamp(candle.openTime, calendar) === date,
  ));
}

export function volumeRatio(candles: readonly Candle[], lookback = 20): number {
  if (!candles.length) return NaN;
  const current = candles[candles.length - 1].volume;
  const prior = candles.slice(Math.max(0, candles.length - lookback - 1), -1);
  const average = prior.length ? prior.reduce((s, c) => s + c.volume, 0) / prior.length : current;
  return average ? current / average : NaN;
}

export function fibonacci(candles: readonly Candle[], manual?: { high: number; low: number }): Level[] {
  const swing = manual ?? (() => {
    if (!candles.length) return { high: NaN, low: NaN };
    return { high: Math.max(...candles.map(c => c.high)), low: Math.min(...candles.map(c => c.low)) };
  })();
  const range = swing.high - swing.low;
  return [
    { name: "Fib 0", price: swing.high }, { name: "Fib 0.236", price: swing.high - range * .236 },
    { name: "Fib 0.382", price: swing.high - range * .382 }, { name: "Fib 0.5", price: swing.high - range * .5 },
    { name: "Fib 0.618", price: swing.high - range * .618 }, { name: "Fib 0.786", price: swing.high - range * .786 },
    { name: "Fib 1", price: swing.low },
  ];
}