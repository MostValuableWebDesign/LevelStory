import type { FuturesContractSpecification } from "../futures/contracts.js";
import type { StrategyConfig } from "./config.js";
import type { SessionLevels } from "./levels.js";
import type { Candle, Direction, Level } from "./types.js";
import { causalEmaValueAt, regularSessionVwap } from "./indicators.js";
import {
  DEFAULT_LEVEL_TOLERANCE_POINTS,
  MES_TICK_SIZE,
} from "@workspace/api-spec/constants";
import {
  DEFAULT_FUTURES_SESSION_CALENDAR,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "../futures/session-calendar.js";

export type BreakoutEvent = {
  detected: boolean;
  direction: Direction | null;
  time: number | null;
  candleOpenTime: number | null;
  state: OrbBreakoutState;
  candidateTime: number | null;
  candidateCandleOpenTime: number | null;
  distanceOutside: number | null;
  meaningfulDistance: number | null;
  breakoutVolume: number | null;
  baselineVolume: number | null;
  volumeRatio: number | null;
  volumeSupported: boolean;
  bodyRatio: number | null;
  closeLocationRatio: number | null;
  candleStructureSupported: boolean;
  continuationConfirmed: boolean;
  continuationCondition: BreakoutContinuationCondition | null;
  failed: boolean;
  detail: string;
};

export type OrbBreakoutState =
  | "ORB_FORMING"
  | "INSIDE_ORB"
  | "ORB_PROBE_WAIT"
  | "WEAK_BREAK_WAIT"
  | "BREAKOUT_CANDIDATE"
  | "WAITING_FOR_CONTINUATION"
  | "QUALIFIED_BREAKOUT"
  | "WAITING_FOR_PULLBACK"
  | "PULLBACK_IN_PROGRESS"
  | "WAITING_FOR_PATIENCE_CANDLE"
  | "PATIENCE_CANDLE_VALID"
  | "TRIGGER_CANDLE_ACTIVE"
  | "ENTRY_TRIGGERED"
  | "BREAKOUT_FAILED"
  | "SETUP_EXPIRED";

export type BreakoutContinuationCondition =
  | "IMMEDIATE_DIRECTIONAL_EXTENSION"
  | "ADDITIONAL_MEANINGFUL_MOVEMENT"
  | "TWO_CONSECUTIVE_CLOSES_OUTSIDE_ORB"
  | "OUTSIDE_ORB_CONSOLIDATION"
  | "STRONG_SINGLE_CANDLE_EXCEPTION";

export type BreakoutQualityMetrics = {
  distanceOutside: number;
  meaningfulDistance: number;
  distancePassed: boolean;
  baselineVolume: number | null;
  breakoutVolume: number;
  volumeRatio: number | null;
  volumePassed: boolean;
  bodyRatio: number | null;
  bodyPassed: boolean;
  closeLocationRatio: number | null;
  closeLocationPassed: boolean;
  strongSingleCandle: boolean;
};

export type PullbackEventType = "touch" | "proximity" | "break and reclaim" | "hold" | "consolidation" | "break through";
export type PullbackEvent = {
  type: PullbackEventType;
  time: number;
  level: string;
  price: number;
  distancePoints: number;
  distanceTicks: number;
  tolerancePoints: number;
  toleranceTicks: number;
  qualifies: boolean;
  candle?: {
    openTime: number;
    closeTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  detail: string;
};

export type QualifyingLevelInteraction = {
  distancePoints: number;
  distanceTicks: number;
  tolerancePoints: number;
  toleranceTicks: number;
  qualifies: boolean;
};

export const LEVEL_QUALIFICATION_EPSILON = 1e-10;

export type PullbackAnalysisOptions = {
  /**
   * Historical contract-local candles used to resolve dynamic levels at each
   * L candle. The source may contain future rows; they are filtered by the
   * evaluated candle close before use.
   */
  causalCandles?: readonly Candle[];
  calendar?: FuturesSessionCalendar;
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
  specification?: FuturesContractSpecification,
): BreakoutEvent {
  const completed = completedCandles(candles);
  if (!ntz?.complete) return pendingBreakout("ORB_FORMING: waiting for the finalized NTZ/ORB range.");
  if (completed.length < 4) return pendingBreakout("ORB_FORMING: waiting for a completed candle after NTZ/ORB completion.");
  return evaluateOrbBreakoutQuality(completed, ntz, config, specification);
}

export function evaluateOrbBreakoutQuality(
  candles: readonly Candle[],
  ntz: SessionLevels["ntz"],
  config: StrategyConfig,
  specification?: FuturesContractSpecification,
): BreakoutEvent {
  const completed = completedCandles(candles);
  if (!ntz?.complete) return pendingBreakout("ORB_FORMING: waiting for the finalized NTZ/ORB range.");
  const completionTime = ntz.completedAt ?? completed[2]?.closeTime ?? completed[0]?.closeTime;
  if (completionTime === undefined) return pendingBreakout("ORB_FORMING: waiting for the ORB completion candle.");
  const afterOrb = completed.filter((candle) => candle.openTime >= completionTime);
  if (!afterOrb.length) return pendingBreakout("INSIDE_ORB: no completed five-minute candle has tested the finalized ORB.");

  const tickSize = specification?.tickSize ?? 0.25;
  const firstAttempt = afterOrb.find((candle) => candle.high > ntz.high || candle.low < ntz.low);
  if (!firstAttempt) return pendingBreakout("INSIDE_ORB: completed candles remain inside the finalized ORB.");

  const attemptDirection = directionForAttempt(firstAttempt, ntz);
  if (attemptDirection === null) return pendingBreakout("ORB_PROBE_WAIT: a two-sided test is ambiguous; waiting for directional confirmation.");
  const firstCloseOutside = closesOutside(firstAttempt, ntz, attemptDirection);
  if (!firstCloseOutside) {
    const later = findLaterQualityCandidate(afterOrb, firstAttempt, ntz, completed, config, tickSize);
    if (later) return evaluateCandidateContinuation(later.candle, later.direction, completed, ntz, config, tickSize, later.quality);
    return probeBreakout(firstAttempt, attemptDirection, ntz, "ORB_PROBE_WAIT: price tested the boundary intrabar but did not close beyond it.");
  }

  const firstQuality = breakoutQuality(firstAttempt, attemptDirection, completed, ntz, config, tickSize);
  if (!qualityPassed(firstQuality)) {
    const later = findLaterQualityCandidate(afterOrb, firstAttempt, ntz, completed, config, tickSize);
    if (later) return evaluateCandidateContinuation(later.candle, later.direction, completed, ntz, config, tickSize, later.quality);
    return weakBreak(firstAttempt, attemptDirection, ntz, firstQuality, "WEAK_BREAK_WAIT: the close is outside the ORB but lacks meaningful distance, volume, or candle structure.");
  }

  return evaluateCandidateContinuation(firstAttempt, attemptDirection, completed, ntz, config, tickSize, firstQuality);
}

function evaluateCandidateContinuation(
  candidate: Candle,
  direction: Direction,
  completed: readonly Candle[],
  ntz: NonNullable<SessionLevels["ntz"]>,
  config: StrategyConfig,
  tickSize: number,
  quality: BreakoutQualityMetrics,
): BreakoutEvent {
  const candidateIndex = completed.findIndex((candle) => candle.openTime === candidate.openTime);
  const following = completed.slice(candidateIndex + 1);
  const exception = config.phase4AllowStrongSingleCandleException && quality.strongSingleCandle;
  if (exception) {
    return qualifiedBreakout(candidate, direction, quality, "STRONG_SINGLE_CANDLE_EXCEPTION", "The exceptionally strong breakout candle satisfies continuation without waiting for another close.");
  }
  const firstBackInsideIndex = following.findIndex((candle) => closesBackInside(candle, ntz, direction));
  const next = following[0];
  const continuationCandles = firstBackInsideIndex >= 0 ? following.slice(0, firstBackInsideIndex) : following;
  const continuation = continuationCandles.find((candle, index) => {
    if (closesBackInside(candle, ntz, direction)) return false;
    const prior = completed[candidateIndex + index];
    const continuationThreshold = continuationDistance(candidate, completed.slice(0, candidateIndex), config, tickSize);
    const extended = direction === "long" ? candle.close > candidate.close : candle.close < candidate.close;
    const additional = direction === "long"
      ? candle.close >= candidate.close + continuationThreshold
      : candle.close <= candidate.close - continuationThreshold;
    const twoCloses = index === 0 && closesOutside(candle, ntz, direction);
    const consolidated = index === 0 && twoCloses && Math.abs(candle.close - candidate.close) <= continuationThreshold;
    return extended || additional || twoCloses || consolidated || prior?.close !== undefined && twoCloses;
  });
  if (continuation) {
    const index = following.indexOf(continuation);
    const prior = completed[candidateIndex + index];
    const threshold = continuationDistance(candidate, completed.slice(0, candidateIndex), config, tickSize);
    const condition: BreakoutContinuationCondition =
      index === 0 && (direction === "long" ? continuation.close > candidate.close : continuation.close < candidate.close)
        ? "IMMEDIATE_DIRECTIONAL_EXTENSION"
        : direction === "long"
          ? continuation.close >= candidate.close + threshold
            ? "ADDITIONAL_MEANINGFUL_MOVEMENT"
            : prior && closesOutside(prior, ntz, direction) && closesOutside(continuation, ntz, direction)
              ? "TWO_CONSECUTIVE_CLOSES_OUTSIDE_ORB"
              : "OUTSIDE_ORB_CONSOLIDATION"
          : continuation.close <= candidate.close - threshold
            ? "ADDITIONAL_MEANINGFUL_MOVEMENT"
            : prior && closesOutside(prior, ntz, direction) && closesOutside(continuation, ntz, direction)
              ? "TWO_CONSECUTIVE_CLOSES_OUTSIDE_ORB"
              : "OUTSIDE_ORB_CONSOLIDATION";
    return qualifiedBreakout(candidate, direction, quality, condition, `Continuation confirmed by ${condition}.`);
  }
  if (config.phase4FailureReclaimRequired && firstBackInsideIndex >= 0) {
    return failedBreakout(candidate, direction, quality, "BREAKOUT_FAILED: the qualifying candle was followed by a close back inside the ORB before acceptable continuation.");
  }
  return {
    ...candidateEvent(candidate, direction, quality),
    state: next ? "WAITING_FOR_CONTINUATION" : "BREAKOUT_CANDIDATE",
    detail: next
      ? "WAITING_FOR_CONTINUATION: breakout quality passed; waiting for directional acceptance outside the ORB."
      : "BREAKOUT_CANDIDATE: quality passed; the immediately following completed candle is required for continuation.",
  };
}

function findLaterQualityCandidate(
  candles: readonly Candle[],
  first: Candle,
  ntz: NonNullable<SessionLevels["ntz"]>,
  completed: readonly Candle[],
  config: StrategyConfig,
  tickSize: number,
): { candle: Candle; direction: Direction; quality: BreakoutQualityMetrics } | null {
  for (const candle of candles.slice(candles.indexOf(first) + 1)) {
    const direction = directionForAttempt(candle, ntz);
    if (!direction || !closesOutside(candle, ntz, direction)) continue;
    const quality = breakoutQuality(candle, direction, completed, ntz, config, tickSize);
    if (qualityPassed(quality)) return { candle, direction, quality };
  }
  return null;
}

function breakoutQuality(
  candle: Candle,
  direction: Direction,
  completed: readonly Candle[],
  ntz: NonNullable<SessionLevels["ntz"]>,
  config: StrategyConfig,
  tickSize: number,
): BreakoutQualityMetrics {
  const index = completed.findIndex((item) => item.openTime === candle.openTime);
  const prior = completed.slice(Math.max(0, index - 6), index);
  const baseline = averageVolume(prior);
  const atr = averageTrueRange(completed.slice(0, index), config.phase4AtrPeriod);
  const meaningfulDistance = Math.max(tickSize * config.phase4BreakoutMeaningfulDistanceTicks, atr * config.phase4BreakoutMeaningfulDistanceAtrFactor);
  const range = candle.high - candle.low;
  const bodyRatio = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
  const closeLocationRatio = range > 0 ? (candle.close - candle.low) / range : 0.5;
  const distanceOutside = direction === "long"
    ? candle.close - ntz.high
    : ntz.low - candle.close;
  const volumeRatio = baseline ? candle.volume / baseline : NaN;
  const closeLocationPassed = direction === "long"
    ? closeLocationRatio >= 1 - config.phase4BreakoutCloseLocationRatio
    : closeLocationRatio <= config.phase4BreakoutCloseLocationRatio;
  const directionalBody = direction === "long" ? candle.close > candle.open : candle.close < candle.open;
  const strongSingleCandle = directionalBody && Number.isFinite(volumeRatio)
    && volumeRatio >= config.phase4StrongVolumeRatio
    && bodyRatio >= config.phase4StrongBodyRatio
    && closeLocationPassedFor(candle, direction, config.phase4StrongCloseLocationRatio)
    && distanceOutside >= meaningfulDistance;
  return {
    distanceOutside: Number(distanceOutside.toFixed(2)),
    meaningfulDistance,
    distancePassed: distanceOutside >= meaningfulDistance,
    baselineVolume: finiteOrNull(baseline),
    breakoutVolume: candle.volume,
    volumeRatio: finiteOrNull(volumeRatio),
    volumePassed: Number.isFinite(volumeRatio) && volumeRatio >= config.phase4BreakoutVolumeRatio,
    bodyRatio: finiteOrNull(bodyRatio),
    bodyPassed: directionalBody && bodyRatio >= config.phase4BreakoutBodyRatio,
    closeLocationRatio: finiteOrNull(closeLocationRatio),
    closeLocationPassed,
    strongSingleCandle,
  };
}

function qualityPassed(quality: BreakoutQualityMetrics): boolean {
  return quality.distancePassed && quality.volumePassed && quality.bodyPassed && quality.closeLocationPassed;
}

function directionForAttempt(candle: Candle, ntz: NonNullable<SessionLevels["ntz"]>): Direction | null {
  if (candle.close > ntz.high) return "long";
  if (candle.close < ntz.low) return "short";
  if (candle.high > ntz.high && candle.low <= ntz.low) return null;
  return candle.high > ntz.high ? "long" : candle.low < ntz.low ? "short" : null;
}

function closesOutside(candle: Candle, ntz: NonNullable<SessionLevels["ntz"]>, direction: Direction): boolean {
  return direction === "long" ? candle.close > ntz.high : candle.close < ntz.low;
}

function closesBackInside(candle: Candle, ntz: NonNullable<SessionLevels["ntz"]>, direction: Direction): boolean {
  return direction === "long" ? candle.close <= ntz.high : candle.close >= ntz.low;
}

function closeLocationPassedFor(candle: Candle, direction: Direction, outerRatio: number): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const location = (candle.close - candle.low) / range;
  return direction === "long" ? location >= 1 - outerRatio : location <= outerRatio;
}

function continuationDistance(
  candle: Candle,
  priorCandles: readonly Candle[],
  config: StrategyConfig,
  tickSize: number,
): number {
  const atr = averageTrueRange([...priorCandles, candle], config.phase4AtrPeriod);
  return Math.max(tickSize * config.phase4ContinuationMoveTicks, atr * config.phase4ContinuationAtrFactor);
}

function candidateEvent(candle: Candle, direction: Direction, quality: BreakoutQualityMetrics): BreakoutEvent {
  return {
    detected: false,
    direction,
    time: null,
    candleOpenTime: null,
    state: "BREAKOUT_CANDIDATE",
    candidateTime: candle.closeTime,
    candidateCandleOpenTime: candle.openTime,
    distanceOutside: Number(quality.distanceOutside.toFixed(2)),
    meaningfulDistance: Number(quality.meaningfulDistance.toFixed(2)),
    breakoutVolume: quality.breakoutVolume,
    baselineVolume: quality.baselineVolume,
    volumeRatio: quality.volumeRatio,
    volumeSupported: quality.volumePassed,
    bodyRatio: quality.bodyRatio,
    closeLocationRatio: quality.closeLocationRatio,
    candleStructureSupported: quality.bodyPassed && quality.closeLocationPassed,
    continuationConfirmed: false,
    continuationCondition: null,
    failed: false,
    detail: "",
  };
}

function probeBreakout(
  candle: Candle,
  direction: Direction,
  ntz: NonNullable<SessionLevels["ntz"]>,
  detail: string,
): BreakoutEvent {
  const distanceOutside = direction === "long" ? Math.max(0, candle.high - ntz.high) : Math.max(0, ntz.low - candle.low);
  return {
    ...pendingBreakout(detail),
    direction,
    state: "ORB_PROBE_WAIT",
    candidateTime: candle.closeTime,
    candidateCandleOpenTime: candle.openTime,
    distanceOutside: Number(distanceOutside.toFixed(2)),
    detail,
  };
}

function weakBreak(
  candle: Candle,
  direction: Direction,
  ntz: NonNullable<SessionLevels["ntz"]>,
  quality: BreakoutQualityMetrics,
  detail: string,
): BreakoutEvent {
  return {
    ...candidateEvent(candle, direction, quality),
    state: "WEAK_BREAK_WAIT",
    distanceOutside: Number((direction === "long" ? candle.close - ntz.high : ntz.low - candle.close).toFixed(2)),
    detail: `${detail} Weak breaks remain waiting and cannot start pullback or patience analysis.`,
  };
}

function qualifiedBreakout(
  candle: Candle,
  direction: Direction,
  quality: BreakoutQualityMetrics,
  condition: BreakoutContinuationCondition,
  detail: string,
): BreakoutEvent {
  return {
    ...candidateEvent(candle, direction, quality),
    detected: true,
    state: "QUALIFIED_BREAKOUT",
    time: candle.closeTime,
    candleOpenTime: candle.openTime,
    continuationConfirmed: true,
    continuationCondition: condition,
    detail: `QUALIFIED_BREAKOUT: ${detail} The later qualifying candle is the frozen impulse anchor.`,
  };
}

function failedBreakout(
  candle: Candle,
  direction: Direction,
  quality: BreakoutQualityMetrics,
  detail: string,
): BreakoutEvent {
  return {
    ...candidateEvent(candle, direction, quality),
    state: "BREAKOUT_FAILED",
    failed: true,
    detail: `${detail} No continuation entry is permitted; only the separate reversal path may use this evidence.`,
  };
}

export function analyzePullback(
  candles: readonly Candle[],
  breakout: BreakoutEvent,
  levels: readonly Level[],
  specification: FuturesContractSpecification,
  config: StrategyConfig,
  options: PullbackAnalysisOptions = {},
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
  // This is the executable qualifying-level tolerance. ATR remains exposed
  // below as diagnostic evidence, but can never widen or replace this zone.
  const proximityTolerance = Number((config.levelTolerance || DEFAULT_LEVEL_TOLERANCE_POINTS).toFixed(2));
  const events: PullbackEvent[] = [];
  const nearStreak = new Map<string, number>();
  const validLevels = levels.filter((level) =>
    Number.isFinite(level.price) || isDynamicPullbackLevel(level),
  );
  const calendar = options.calendar ?? DEFAULT_FUTURES_SESSION_CALENDAR;

  for (const candle of postBreakout) {
    for (const level of validLevels) {
      const resolved = resolvePullbackLevel(level, candle, candles, options.causalCandles, config, calendar);
      if (!resolved) continue;
      const distance = levelInteractionDistance(
        resolved.price,
        candle.high,
        candle.low,
        resolved.rangeLow,
        resolved.rangeHigh,
      );
      const interaction = qualifyLevelInteraction(distance, proximityTolerance, MES_TICK_SIZE);
      const touched = interaction.distancePoints === 0;
      const near = interaction.qualifies;
      const streak = near ? (nearStreak.get(level.name) ?? 0) + 1 : 0;
      nearStreak.set(level.name, streak);
      const favorable = breakout.direction === "long" ? candle.close >= resolved.price : candle.close <= resolved.price;
      const lowerBoundary = resolved.rangeLow ?? resolved.price;
      const upperBoundary = resolved.rangeHigh ?? resolved.price;
      const reclaim = breakout.direction === "long"
        ? candle.low < lowerBoundary - proximityTolerance && candle.close >= lowerBoundary
        : candle.high > upperBoundary + proximityTolerance && candle.close <= upperBoundary;
      const through = breakout.direction === "long"
        ? candle.close < lowerBoundary - proximityTolerance
        : candle.close > upperBoundary + proximityTolerance;
      const distanceDetail = `${interaction.distanceTicks} ticks / ${distance.toFixed(2)} points from ${level.name}; tolerance is ${proximityTolerance.toFixed(2)} points.`;

      const resolvedLevel: Level = { ...level, price: resolved.price };
      if (touched) events.push(event("touch", candle, resolvedLevel, interaction, `Completed range interacted with ${level.name}; ${distanceDetail}`));
      else if (near) events.push(event("proximity", candle, resolvedLevel, interaction, `Completed range came within the qualifying zone; ${distanceDetail}`));
      if (reclaim) events.push(event("break and reclaim", candle, resolvedLevel, interaction, `${level.name} was breached intrabar and reclaimed on the completed close; ${distanceDetail}`));
      if (touched && favorable) events.push(event("hold", candle, resolvedLevel, interaction, `Completed close held ${breakout.direction === "long" ? "above" : "below"} ${level.name}; ${distanceDetail}`));
      if (streak >= 2) events.push(event("consolidation", candle, resolvedLevel, interaction, `${streak} consecutive completed candles consolidated near ${level.name}; ${distanceDetail}`));
      if (through) events.push(event("break through", candle, resolvedLevel, interaction, `Completed close broke through ${level.name} against the ${breakout.direction} breakout; ${distanceDetail}`));
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

/**
 * Distance from a candle's complete high-low range to a point or zone.
 * Overlap is always zero; otherwise only the nearest wick matters.
 */
export function levelInteractionDistance(
  level: number,
  candleHigh: number,
  candleLow: number,
  rangeLow?: number | null,
  rangeHigh?: number | null,
): number {
  const low = rangeLow ?? level;
  const high = rangeHigh ?? level;
  if (candleHigh >= low && candleLow <= high) return 0;
  if (candleHigh < low) return low - candleHigh;
  return candleLow - high;
}

export function qualifyLevelInteraction(
  distancePoints: number,
  tolerancePoints: number,
  tickSize: number = MES_TICK_SIZE,
): QualifyingLevelInteraction {
  const distanceTicks = Number.isFinite(distancePoints)
    ? distanceInTicks(distancePoints, tickSize)
    : Number.POSITIVE_INFINITY;
  const toleranceTicks = Number.isFinite(tolerancePoints)
    ? Math.round(tolerancePoints / tickSize)
    : Number.POSITIVE_INFINITY;
  const qualifies = Number.isFinite(distancePoints)
    && Number.isFinite(tolerancePoints)
    && distancePoints <= tolerancePoints + LEVEL_QUALIFICATION_EPSILON;
  return {
    distancePoints,
    distanceTicks: qualifies ? Math.min(distanceTicks, toleranceTicks) : distanceTicks,
    tolerancePoints,
    toleranceTicks,
    qualifies,
  };
}

function distanceInTicks(distance: number, tickSize: number): number {
  return Math.max(0, Math.ceil(Math.max(0, distance) / tickSize - LEVEL_QUALIFICATION_EPSILON));
}

function resolvePullbackLevel(
  level: Level,
  candle: Candle,
  visibleCandles: readonly Candle[],
  causalCandles: readonly Candle[] | undefined,
  config: StrategyConfig,
  calendar: FuturesSessionCalendar,
): { price: number; rangeLow: number | null; rangeHigh: number | null } | null {
  const dynamic = level.name.trim().toLowerCase();
  if (!causalCandles) {
    return Number.isFinite(level.price)
      ? { price: level.price, rangeLow: level.rangeLow ?? null, rangeHigh: level.rangeHigh ?? null }
      : null;
  }
  const source = [...causalCandles, ...visibleCandles]
    .filter((item) => item.isComplete && item.closeTime <= candle.closeTime)
    .filter((item) => sameContract(item, candle))
    .sort((first, second) => first.closeTime - second.closeTime || first.openTime - second.openTime);
  const deduped = [...new Map(source.map((item) => [item.openTime, item])).values()];
  if (dynamic === "vwap") {
    const price = regularSessionVwap(deduped, calendar, tradingDateForTimestamp(candle.openTime, calendar));
    return Number.isFinite(price) ? { price, rangeLow: null, rangeHigh: null } : null;
  }
  if (dynamic === "ema 200" || dynamic === "ema200") {
    const price = causalEmaValueAt(deduped, config.emaPeriod, candle.openTime);
    return price === null || !Number.isFinite(price) ? null : { price, rangeLow: null, rangeHigh: null };
  }
  return Number.isFinite(level.price)
    ? { price: level.price, rangeLow: level.rangeLow ?? null, rangeHigh: level.rangeHigh ?? null }
    : null;
}

function isDynamicPullbackLevel(level: Level): boolean {
  const name = level.name.trim().toLowerCase();
  return name === "vwap" || name === "ema 200" || name === "ema200";
}

function sameContract(first: Candle, second: Candle): boolean {
  const firstContract = (first as Candle & { contractSymbol?: string }).contractSymbol;
  const secondContract = (second as Candle & { contractSymbol?: string }).contractSymbol;
  return firstContract === undefined || secondContract === undefined || firstContract === secondContract;
}

export function advanceOrbBreakoutState(
  breakout: BreakoutEvent,
  pullback: PullbackAnalysis,
  patienceState?: string,
): BreakoutEvent {
  if (!breakout.detected) return breakout;
  const state: OrbBreakoutState = patienceState === "ENTRY_TRIGGERED"
    ? "ENTRY_TRIGGERED"
    : patienceState === "TRIGGER_CANDLE_ACTIVE" || patienceState === "BREAK_DETECTED_WAITING_FOR_BUFFER" || patienceState === "ENTRY_BUFFER_REACHED"
      ? "TRIGGER_CANDLE_ACTIVE"
      : patienceState === "PATIENCE_CANDLE_VALID"
        ? "PATIENCE_CANDLE_VALID"
        : patienceState === "PATIENCE_CANDLE_EXPIRED"
          || patienceState === "OPPOSITE_SIDE_INVALIDATION"
          || patienceState === "AMBIGUOUS_EVENT_ORDER"
          || patienceState === "PATIENCE_TREND_MISMATCH"
          ? "SETUP_EXPIRED"
          : pullback.events.length
            ? "PULLBACK_IN_PROGRESS"
            : pullback.evaluatedCandles > 0
              ? "WAITING_FOR_PULLBACK"
              : "QUALIFIED_BREAKOUT";
  return {
    ...breakout,
    state,
    detail: state === "PULLBACK_IN_PROGRESS"
      ? `${breakout.detail} Pullback analysis is active from the qualifying breakout.`
      : state === "SETUP_EXPIRED"
        ? `${breakout.detail} The downstream patience window is no longer eligible.`
        : breakout.detail,
  };
}

export function fibonacciAnalysis(
  candles: readonly Candle[],
  breakout: BreakoutEvent,
  manual?: ManualFibAnchors,
  pullback?: PullbackAnalysis,
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
  // The impulse begins at the qualifying breakout candle. Earlier probes are
  // evidence of hesitation, not valid Fibonacci anchors.
  const impulse = completed.slice(breakoutIndex, breakoutIndex + 1);
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

function event(
  type: PullbackEventType,
  candle: Candle,
  level: Level,
  interaction: QualifyingLevelInteraction,
  detail: string,
): PullbackEvent {
  return {
    type,
    time: candle.closeTime,
    level: level.name,
    price: level.price,
    ...interaction,
    candle: {
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    },
    detail,
  };
}

function pendingBreakout(detail: string): BreakoutEvent {
  return {
    detected: false,
    direction: null,
    time: null,
    candleOpenTime: null,
    state: detail.startsWith("ORB_FORMING") ? "ORB_FORMING" : detail.startsWith("INSIDE_ORB") ? "INSIDE_ORB" : "ORB_PROBE_WAIT",
    candidateTime: null,
    candidateCandleOpenTime: null,
    distanceOutside: null,
    meaningfulDistance: null,
    breakoutVolume: null,
    baselineVolume: null,
    volumeRatio: null,
    volumeSupported: false,
    bodyRatio: null,
    closeLocationRatio: null,
    candleStructureSupported: false,
    continuationConfirmed: false,
    continuationCondition: null,
    failed: false,
    detail,
  };
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