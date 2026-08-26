import type { FuturesContractSpecification } from "../futures/contracts.js";
import type { StrategyConfig } from "./config.js";
import type { SessionLevels } from "./levels.js";
import type { Candle, Direction, Level } from "./types.js";

export type BreakoutEvent = {
  detected: boolean;
  direction: Direction | null;
  time: number | null;
  candleOpenTime: number | null;
  distanceOutside: number | null;
  breakoutVolume: number | null;
  baselineVolume: number | null;
  volumeRatio: number | null;
  volumeSupported: boolean;
  detail: string;
};

export type PullbackEventType = "touch" | "proximity" | "break and reclaim" | "hold" | "consolidation" | "break through";
export type PullbackEvent = {
  type: PullbackEventType;
  time: number;
  level: string;
  price: number;
  detail: string;
};

export type PullbackAnalysis = {
  status: "pending" | "observed" | "expired";
  events: PullbackEvent[];
  evaluatedCandles: number;
  maxCandles: number;
  maxDurationMinutes: number;
  elapsedMinutes: number;
  proximityTolerance: number | null;
  atr14: number | null;
  qualifyingLevelCount: number;
  detail: string;
};

export type FibonacciDirection = "bullish" | "bearish";
export type ManualFibAnchors = { high: number; low: number };
export type FibonacciLevel = { name: string; label: string; ratio: number; price: number };
export type FibonacciAnalysis = {
  direction: FibonacciDirection | null;
  impulseLow: number | null;
  impulseHigh: number | null;
  breakoutTime: number | null;
  frozen: boolean;
  frozenAt: number | null;
  manualCorrection: boolean;
  levels: FibonacciLevel[];
  retracementPercent: number | null;
  classification: "shallow" | "normal" | "deep" | "elevated failure risk" | "fully retraced" | "unavailable";
  detail: string;
};

export type Phase4VolumeAnalysis = {
  baselineCandleCount: number;
  recentSixAverage: number | null;
  breakoutVolume: number | null;
  breakoutRatio: number | null;
  supportingBreakoutVolume: boolean;
  averageImpulseVolume: number | null;
  pullbackAverageVolume: number | null;
  pullbackToBreakoutRatio: number | null;
  pullbackToImpulseRatio: number | null;
  pullbackToRecentRatio: number | null;
  opposingPullbackVolume: number | null;
  reversalWarning: string | null;
};

export function detectInitialBreakout(
  candles: readonly Candle[],
  ntz: SessionLevels["ntz"],
  config: StrategyConfig,
): BreakoutEvent {
  const completed = completedCandles(candles);
  if (!ntz?.complete) return pendingBreakout("Waiting for the finalized NTZ/ORB range.");
  if (completed.length < 4) return pendingBreakout("Waiting for a completed candle after NTZ/ORB completion.");
  const completionTime = ntz.completedAt ?? completed[2]?.closeTime ?? completed[0].closeTime;
  const candidate = completed.find((candle) => candle.openTime >= completionTime && (candle.close > ntz.high || candle.close < ntz.low));
  if (!candidate) return pendingBreakout("No completed five-minute close outside the finalized NTZ/ORB.");
  const direction: Direction = candidate.close > ntz.high ? "long" : "short";
  const distanceOutside = direction === "long" ? candidate.close - ntz.high : ntz.low - candidate.close;
  const baseline = averageVolume(completed.filter((candle) => candle.closeTime <= candidate.openTime).slice(-6));
  const volumeRatio = baseline ? candidate.volume / baseline : NaN;
  return {
    detected: true,
    direction,
    time: candidate.closeTime,
    candleOpenTime: candidate.openTime,
    distanceOutside: Number(distanceOutside.toFixed(2)),
    breakoutVolume: candidate.volume,
    baselineVolume: finiteOrNull(baseline),
    volumeRatio: finiteOrNull(volumeRatio),
    volumeSupported: Number.isFinite(volumeRatio) && volumeRatio >= config.phase4BreakoutVolumeRatio,
    detail: `${direction === "long" ? "Bullish" : "Bearish"} breakout closed ${distanceOutside.toFixed(2)} points outside NTZ/ORB.`,
  };
}

export function analyzePullback(
  candles: readonly Candle[],
  breakout: BreakoutEvent,
  levels: readonly Level[],
  specification: FuturesContractSpecification,
  config: StrategyConfig,
): PullbackAnalysis {
  const completed = completedCandles(candles);
  if (!breakout.detected || breakout.candleOpenTime === null || breakout.direction === null) {
    return {
      status: "pending",
      events: [],
      evaluatedCandles: 0,
      maxCandles: config.phase4PullbackMaxCandles,
      maxDurationMinutes: config.phase4PullbackMaxMinutes,
      elapsedMinutes: 0,
      proximityTolerance: null,
      atr14: null,
      qualifyingLevelCount: levels.filter((level) => Number.isFinite(level.price)).length,
      detail: "Pullback analysis starts only after a valid completed-candle breakout.",
    };
  }
  const breakoutIndex = completed.findIndex((candle) => candle.openTime === breakout.candleOpenTime);
  if (breakoutIndex < 0) return { status: "pending", events: [], evaluatedCandles: 0, maxCandles: config.phase4PullbackMaxCandles, maxDurationMinutes: config.phase4PullbackMaxMinutes, elapsedMinutes: 0, proximityTolerance: null, atr14: null, qualifyingLevelCount: levels.length, detail: "Breakout candle is not visible in the completed replay." };
  const breakoutCandle = completed[breakoutIndex];
  const postBreakout = completed.slice(breakoutIndex + 1).filter((candle) =>
    (candle.openTime - breakoutCandle.closeTime) <= config.phase4PullbackMaxMinutes * 60_000,
  ).slice(0, config.phase4PullbackMaxCandles);
  const atr14 = averageTrueRange(completed.slice(0, breakoutIndex + 1), config.phase4AtrPeriod);
  const proximityTolerance = Number(Math.max(specification.tickSize * config.phase4ProximityTicks, atr14 * config.phase4ProximityAtrFactor).toFixed(2));
  const events: PullbackEvent[] = [];
  const nearStreak = new Map<string, number>();
  const validLevels = levels.filter((level) => Number.isFinite(level.price));

  for (const candle of postBreakout) {
    for (const level of validLevels) {
      const distance = Math.min(
        Math.abs(candle.close - level.price),
        Math.abs(candle.high - level.price),
        Math.abs(candle.low - level.price),
      );
      const touched = candle.low <= level.price && candle.high >= level.price;
      const near = touched || distance <= proximityTolerance;
      const streak = near ? (nearStreak.get(level.name) ?? 0) + 1 : 0;
      nearStreak.set(level.name, streak);
      const favorable = breakout.direction === "long" ? candle.close >= level.price : candle.close <= level.price;
      const reclaim = breakout.direction === "long"
        ? candle.low < level.price - proximityTolerance && candle.close >= level.price
        : candle.high > level.price + proximityTolerance && candle.close <= level.price;
      const through = breakout.direction === "long"
        ? candle.close < level.price - proximityTolerance
        : candle.close > level.price + proximityTolerance;

      if (touched) events.push(event("touch", candle, level, `Completed close interacted with ${level.name} within ${proximityTolerance.toFixed(2)} points.`));
      else if (near) events.push(event("proximity", candle, level, `Price came within ${proximityTolerance.toFixed(2)} points of ${level.name}.`));
      if (reclaim) events.push(event("break and reclaim", candle, level, `${level.name} was breached intrabar and reclaimed on the completed close.`));
      if (touched && favorable) events.push(event("hold", candle, level, `Completed close held ${breakout.direction === "long" ? "above" : "below"} ${level.name}.`));
      if (streak >= 2) events.push(event("consolidation", candle, level, `${streak} consecutive completed candles consolidated near ${level.name}.`));
      if (through) events.push(event("break through", candle, level, `Completed close broke through ${level.name} against the ${breakout.direction} breakout.`));
    }
  }

  const elapsedMinutes = postBreakout.length
    ? Math.round((postBreakout.at(-1)!.closeTime - breakoutCandle.closeTime) / 60_000)
    : 0;
  const status = postBreakout.length >= config.phase4PullbackMaxCandles || elapsedMinutes >= config.phase4PullbackMaxMinutes ? "expired" : "observed";
  return {
    status,
    events,
    evaluatedCandles: postBreakout.length,
    maxCandles: config.phase4PullbackMaxCandles,
    maxDurationMinutes: config.phase4PullbackMaxMinutes,
    elapsedMinutes,
    proximityTolerance,
    atr14: finiteOrNull(atr14),
    qualifyingLevelCount: validLevels.length,
    detail: events.length ? `${events.length} pullback observations across ${postBreakout.length} completed candles.` : "No qualifying pullback interaction in the bounded window.",
  };
}

export function fibonacciAnalysis(
  candles: readonly Candle[],
  breakout: BreakoutEvent,
  manual?: ManualFibAnchors,
): FibonacciAnalysis {
  if (!breakout.detected || breakout.direction === null || breakout.candleOpenTime === null) {
    return {
      direction: null,
      impulseLow: null,
      impulseHigh: null,
      breakoutTime: null,
      frozen: false,
      frozenAt: null,
      manualCorrection: false,
      levels: [],
      retracementPercent: null,
      classification: "unavailable",
      detail: "Fibonacci anchors are unavailable until a breakout is detected.",
    };
  }
  const completed = completedCandles(candles);
  const breakoutIndex = completed.findIndex((candle) => candle.openTime === breakout.candleOpenTime);
  if (breakoutIndex < 0) return fibonacciAnalysis([], { ...breakout, detected: false });
  const impulse = completed.slice(0, breakoutIndex + 1);
  const auto = { low: Math.min(...impulse.map((candle) => candle.low)), high: Math.max(...impulse.map((candle) => candle.high)) };
  const anchors = manual ?? auto;
  if (!Number.isFinite(anchors.low) || !Number.isFinite(anchors.high) || anchors.high <= anchors.low) {
    throw new Error("Manual Fibonacci anchors require finite high and low values with high greater than low.");
  }
  const range = anchors.high - anchors.low;
  const levels = [0, 0.236, 0.382, 0.4, 0.5, 0.618, 0.786, 1].map((ratio) => ({
    name: `Fib ${ratio === 0 ? "0" : ratio}`,
    label: `${(ratio * 100).toFixed(ratio === 0 || ratio === 1 ? 0 : 1)}%`,
    ratio,
    price: Number((anchors.high - range * ratio).toFixed(2)),
  }));
  const firstPullbackCandle = completed[breakoutIndex + 1];
  const latestPrice = firstPullbackCandle?.close ?? completed[breakoutIndex].close;
  const rawDepth = breakout.direction === "long"
    ? (anchors.high - latestPrice) / range * 100
    : (latestPrice - anchors.low) / range * 100;
  const retracementPercent = Number(Math.max(0, Math.min(100, rawDepth)).toFixed(1));
  return {
    direction: breakout.direction === "long" ? "bullish" : "bearish",
    impulseLow: Number(anchors.low.toFixed(2)),
    impulseHigh: Number(anchors.high.toFixed(2)),
    breakoutTime: breakout.time,
    frozen: true,
    frozenAt: firstPullbackCandle?.openTime ?? breakout.time,
    manualCorrection: manual !== undefined,
    levels,
    retracementPercent,
    classification: classifyRetracement(retracementPercent),
    detail: manual
      ? "Manual Fibonacci anchors are active and frozen for this pullback."
      : "Impulse anchors were frozen when the pullback began; depth alone is not reversal proof.",
  };
}

export function phase4Volume(
  candles: readonly Candle[],
  breakout: BreakoutEvent,
  config: StrategyConfig,
): Phase4VolumeAnalysis {
  const completed = completedCandles(candles);
  if (!breakout.detected || breakout.candleOpenTime === null || breakout.direction === null) {
    return emptyVolumeAnalysis();
  }
  const breakoutIndex = completed.findIndex((candle) => candle.openTime === breakout.candleOpenTime);
  if (breakoutIndex < 0) return emptyVolumeAnalysis();
  const baseline = completed.slice(Math.max(0, breakoutIndex - 6), breakoutIndex);
  const pullback = completed.slice(breakoutIndex + 1, breakoutIndex + 1 + 6);
  const baselineAverage = averageVolume(baseline);
  const breakoutCandle = completed[breakoutIndex];
  const breakoutRatio = baselineAverage ? breakoutCandle.volume / baselineAverage : NaN;
  const impulse = completed.slice(Math.max(0, breakoutIndex - config.volumeLookback), breakoutIndex);
  const impulseAverage = averageVolume(impulse);
  const pullbackAverage = averageVolume(pullback);
  const opposingVolumes = pullback
    .filter((candle) => breakout.direction === "long" ? candle.close < candle.open : candle.close > candle.open)
    .map((candle) => candle.volume);
  const opposingPullbackVolume = opposingVolumes.length ? Math.max(...opposingVolumes) : 0;
  return {
    baselineCandleCount: baseline.length,
    recentSixAverage: finiteOrNull(baselineAverage),
    breakoutVolume: breakoutCandle.volume,
    breakoutRatio: finiteOrNull(breakoutRatio),
    supportingBreakoutVolume: Number.isFinite(breakoutRatio) && breakoutRatio >= config.phase4BreakoutVolumeRatio,
    averageImpulseVolume: finiteOrNull(impulseAverage),
    pullbackAverageVolume: finiteOrNull(pullbackAverage),
    pullbackToBreakoutRatio: finiteOrNull(safeRatio(pullbackAverage, breakoutCandle.volume)),
    pullbackToImpulseRatio: finiteOrNull(safeRatio(pullbackAverage, impulseAverage)),
    pullbackToRecentRatio: finiteOrNull(safeRatio(pullbackAverage, baselineAverage)),
    opposingPullbackVolume: finiteOrNull(opposingPullbackVolume),
    reversalWarning: opposingPullbackVolume >= breakoutCandle.volume ? "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" : null,
  };
}

export function classifyRetracement(percent: number): FibonacciAnalysis["classification"] {
  if (percent >= 100) return "fully retraced";
  if (percent > 61.8) return "elevated failure risk";
  if (percent >= 50) return "deep";
  if (percent >= 38.2) return "normal";
  return "shallow";
}

function completedCandles(candles: readonly Candle[]): Candle[] {
  return candles.filter((candle) => candle.isComplete).sort((first, second) => first.closeTime - second.closeTime);
}

function averageVolume(candles: readonly Candle[]): number {
  return candles.length ? candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length : NaN;
}

function averageTrueRange(candles: readonly Candle[], period: number): number {
  if (!candles.length) return NaN;
  const ranges: number[] = [];
  for (let index = Math.max(0, candles.length - period); index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    ranges.push(previous ? Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close)) : candle.high - candle.low);
  }
  return ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
}

function event(type: PullbackEventType, candle: Candle, level: Level, detail: string): PullbackEvent {
  return { type, time: candle.closeTime, level: level.name, price: level.price, detail };
}

function pendingBreakout(detail: string): BreakoutEvent {
  return { detected: false, direction: null, time: null, candleOpenTime: null, distanceOutside: null, breakoutVolume: null, baselineVolume: null, volumeRatio: null, volumeSupported: false, detail };
}

function emptyVolumeAnalysis(): Phase4VolumeAnalysis {
  return {
    baselineCandleCount: 0,
    recentSixAverage: null,
    breakoutVolume: null,
    breakoutRatio: null,
    supportingBreakoutVolume: false,
    averageImpulseVolume: null,
    pullbackAverageVolume: null,
    pullbackToBreakoutRatio: null,
    pullbackToImpulseRatio: null,
    pullbackToRecentRatio: null,
    opposingPullbackVolume: null,
    reversalWarning: null,
  };
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : NaN;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}