import type { Candle, Level } from "./types.js";
import { ema, fibonacci, rsi, volumeRatio, vwap } from "./indicators.js";
import type { StrategyConfig } from "./config.js";

export type SessionWindows = { premarket: readonly Candle[]; regular: readonly Candle[] };
export type SessionLevels = {
  levels: Level[];
  orb: { high: number; low: number } | null;
  ntz: { high: number; low: number } | null;
  vwap: number;
  ema: number;
  rsi: number;
  volumeRatio: number;
  fibonacci: Level[];
};

export function sessionLevels(candles: readonly Candle[], windows: SessionWindows, config: StrategyConfig): SessionLevels {
  const regular = windows.regular;
  const dayMap = new Map<number, Candle[]>();
  for (const c of candles) { const day = Math.floor(c.openTime / 86_400_000); const list = dayMap.get(day) ?? []; list.push(c); dayMap.set(day, list); }
  const days = [...dayMap.keys()].sort((a, b) => b - a);
  const previous = days.slice(1, 3).flatMap(d => dayMap.get(d) ?? []);
  const orbCandle = aggregateCandles(regular, config.orbMinutes).find(c => c.isComplete);
  const orb = orbCandle ? { high: orbCandle.high, low: orbCandle.low } : null;
  const ntzStart = orbCandle?.openTime;
  const ntzCandles = ntzStart === undefined ? [] : regular.filter(c => c.isComplete && c.closeTime <= ntzStart + config.ntzMinutes * 60_000);
  const ntz = ntzCandles.length ? { high: Math.max(...ntzCandles.map(c => c.high)), low: Math.min(...ntzCandles.map(c => c.low)) } : null;
  const levels: Level[] = [];
  if (windows.premarket.length) levels.push({ name: "Premarket high", price: Math.max(...windows.premarket.map(c => c.high)) }, { name: "Premarket low", price: Math.min(...windows.premarket.map(c => c.low)) });
  const priorLevels: Array<[string, number]> = [
    ["Prior day high", previous.length ? Math.max(...(dayMap.get(days[1]) ?? []).map(c => c.high)) : NaN],
    ["Prior day low", previous.length ? Math.min(...(dayMap.get(days[1]) ?? []).map(c => c.low)) : NaN],
    ["Two days ago high", days[2] !== undefined ? Math.max(...(dayMap.get(days[2]) ?? []).map(c => c.high)) : NaN],
    ["Two days ago low", days[2] !== undefined ? Math.min(...(dayMap.get(days[2] ?? 0) ?? []).map(c => c.low)) : NaN],
  ];
  for (const [name, value] of priorLevels) if (Number.isFinite(value)) levels.push({ name, price: value });
  if (orb) levels.push({ name: "ORB high", price: orb.high }, { name: "ORB low", price: orb.low });
  if (ntz) levels.push({ name: "NTZ high", price: ntz.high }, { name: "NTZ low", price: ntz.low });
  const indicatorCandles = [...previous, ...regular];
  const emaValues = ema(indicatorCandles.map(c => c.close), config.emaPeriod);
  return {
    levels,
    orb,
    ntz,
    vwap: vwap(regular),
    ema: emaValues.at(-1) ?? NaN,
    rsi: rsi(indicatorCandles.map(c => c.close), config.rsiPeriod).at(-1) ?? 50,
    volumeRatio: volumeRatio(regular, config.volumeLookback),
    fibonacci: fibonacci(regular),
  };
}

function aggregateCandles(candles: readonly Candle[], minutes: number): Candle[] {
  const size = Math.max(1, Math.round(minutes / 5));
  const groups: Candle[][] = [];
  for (let index = 0; index < candles.length; index += size) groups.push(candles.slice(index, index + size) as Candle[]);
  return groups.filter(group => group.length === size).map(group => ({
    openTime: group[0].openTime,
    closeTime: group[group.length - 1].closeTime,
    open: group[0].open,
    high: Math.max(...group.map(c => c.high)),
    low: Math.min(...group.map(c => c.low)),
    close: group[group.length - 1].close,
    volume: group.reduce((sum, c) => sum + c.volume, 0),
    isComplete: group.every(c => c.isComplete),
  }));
}