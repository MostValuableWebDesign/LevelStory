import {
  createMarketSnapshot,
  type MarketSnapshot,
} from "./market-data";
import {
  getFuturesContractSpecification,
  type FuturesContractSpecification,
} from "./futures/contracts.js";
import {
  sessionCalendarForContract,
  sessionWindow,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "./futures/session-calendar.js";
import {
  completedSimulatedHourlyCandles,
  generateSimulatedFuturesFeed,
  type SimulatedHourlyCandle,
  type SimulatedFuturesCandle,
} from "./futures/simulated-feed.js";
import { simulatePhase8ShadowExecution } from "./strategy/phase8.js";
import { targetPriceForDollars } from "./strategy/phase7.js";
import { isExecutionAmbiguityLabel, MODELED_OHLCV_FILL_LABEL, simulateOhlcvExecution } from "./strategy/ohlcv-execution.js";
import type { ModeledExecutionLeg } from "./strategy/ohlcv-execution.js";
import type { OrbBreakoutState } from "./strategy/phase4.js";
import type { PatienceOccurrence } from "./strategy/phase5.js";
import type { Direction } from "./strategy/types.js";
import { canonicalStrategyId } from "./strategy/taxonomy.js";
import { parseMesContractSymbol } from "./futures/multi-contract-replay.js";
import { FIXED_FORMULA_VERSION, formulaConfigurationHash } from "./formula-hash.js";
import { createHash } from "node:crypto";
import { activeShadowStrategySnapshot } from "./active-shadow-strategy.js";
import { consolidationThresholds, type ConsolidationThresholds } from "./strategy/config.js";

export type ReplayCursor = {
  cursor: number;
  visibleCandleCount: number;
  visibleCandleCloseTime: number | null;
  mode: "replay";
};

export type IntrabarBar = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  source: "tick" | "one-minute";
  /**
   * A one-minute OHLC bar can still contain an unknowable order between its
   * high and low. Tick points are ordered observations; bars are not.
   */
  sequenceKnown?: boolean;
};

export type IntrabarPoint = {
  timestamp: number;
  price: number;
  source: "tick";
};

export type IntrabarResolution = {
  status: "open" | "target" | "stop" | "ambiguous";
  source: "tick" | "one-minute" | "ohlc";
  timestamp: number | null;
  price: number | null;
  ambiguityLabel: "AMBIGUOUS_STOP_FIRST" | null;
  detail: string;
};

export type EntryResolution = {
  status: "accepted" | "ambiguous";
  price: number | null;
  label: "AMBIGUOUS_ENTRY_INVALIDATION" | null;
  detail: string;
};

export type CausalReplayDataset = {
  candles: readonly SimulatedFuturesCandle[];
  ticks?: readonly IntrabarPoint[];
  oneMinute?: readonly IntrabarBar[];
  contractSymbol: string;
  contractMonth: string;
  inSampleDates: readonly string[];
  outOfSampleDates: readonly string[];
  requestedStartDate?: string;
  requestedEndDate?: string;
  selectedDates?: readonly string[];
  excludedDates?: readonly string[];
  source?: "simulated" | "historical_databento" | "historical_databento_multicontract";
  contentFingerprint?: string;
  quotesAvailable?: boolean;
  gapReport?: BacktestGapReport;
  contractSchedule?: {
    version: string;
    activeContractByDate: readonly { tradingDate: string; contractSymbol: string }[];
    boundaries: readonly {
      effectiveDate: string;
      fromContractSymbol: string | null;
      toContractSymbol: string;
      scheduleVersion: string;
    }[];
  };
};

export type BacktestGapReport = {
  missingMinuteGaps: number;
  missingGapSegments: number;
  unexpectedMissingMinutes: number;
  unexpectedOpenSessionMissingMinutes: number;
  unexpectedOvernightMissingMinutes: number;
  unexpectedRegularSessionMissingMinutes: number;
  regularSessionGapSegments: number;
  overnightGapSegments: number;
  regularSessionMissingMinutes: number;
  expectedClosedMarketMinutes: number;
  expectedClosedMinutes: number;
  weekendHolidayClosedMinutes: number;
  earlyCloseMinutes: number;
  inactiveContractMinutes: number;
  lowLiquidityInactiveMinutes: number;
  coverageScope: "full_file" | "selected_dates" | "multi_contract";
  inactiveContractThresholdPercent: number;
  inactiveContractDays: number;
  missingRegularSessionDates: string[];
  missingOvernightSessionDates: string[];
  completeRegularSessionDates: string[];
  maintenanceGapMinutes: number;
  weekendHolidayGapMinutes: number;
  earlyCloseDates: string[];
  overnightCoverageObserved: boolean;
};

export type ReplayDatasetOptions = {
  endDate: string;
  inSampleDays: number;
  outOfSampleDays: number;
  seed?: number;
  premarketAvailable?: boolean;
};

export type BacktestRequest = ReplayDatasetOptions & {
  symbol: string;
  startDate?: string;
  source?: "simulated" | "historical_databento" | "historical_databento_multicontract";
  targetDollars?: number;
  slippageMode?: "normal" | "fast" | "abnormal_spread";
  executionMode?: "quote_based_shadow" | "ohlcv_modeled";
  ohlcvEntryBufferTicks?: 3 | 4;
  ohlcvStopBufferTicks?: number;
  ohlcvSlippageTicks?: number;
  ohlcvCommissionPerContract?: number;
};

export type BacktestTrade = {
  id: string;
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  period: "in_sample" | "out_of_sample";
  setupType: string;
  direction: Direction;
  entryTime: string;
  exitTime: string | null;
  entryPrice: number;
  exitPrice: number | null;
  contracts: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  outcome: "target" | "strategy stop" | "catastrophe stop" | "session close" | "manual" | "open";
  ambiguityLabel: string | null;
  source: "tick" | "one-minute" | "ohlc";
  segmentation: BacktestSegmentation;
  executionMode?: "quote_based_shadow" | "ohlcv_modeled";
  fillLabel?: string | null;
  primaryEdge?: string;
  matchedEdges?: string[];
  supportingConfluences?: string[];
  setupGrade?: "A" | "A+" | "A++";
  patienceCandle?: Record<string, number | boolean> | null;
  entryCandle?: Record<string, number | boolean> | null;
  audit?: {
    entryTriggerPrice: number | null;
    modeledFillPrice: number | null;
    stopPrice: number | null;
    targetPrice: number | null;
    strategyStopPrice?: number | null;
    catastropheStopPrice?: number | null;
    stopLevel?: "strategy" | "catastrophe" | null;
    patienceCandleOpenTime: string | null;
    patienceCandleCloseTime: string | null;
    triggerCandleOpenTime: string | null;
    triggerCandleCloseTime: string | null;
    modeledFillObservationTime: string | null;
    exitCandleOpenTime: string | null;
    exitCandleCloseTime: string | null;
    assumptions: string[];
    eventLabels: string[];
    ambiguityLabels: string[];
    targetHit: boolean;
    runnerActivated: boolean;
    runnerExited: boolean;
    runnerReferencePrice?: number | null;
    runnerImpulse?: number | null;
    runnerMostFavorablePrice?: number | null;
    remainingQuantity?: number;
    exitReason: string;
    legs: ModeledExecutionLeg[];
  };
};

export type BacktestAuditRecord = {
  id: string;
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  period: "in_sample" | "out_of_sample";
  evaluatedCandleOpenTime: string;
  setupType: string;
  direction: Direction | null;
  decision: string;
  alertOnly: boolean;
  rejectionReason: string | null;
  rejectionCategory: "WAITING" | "FAILURE" | "EXPIRED" | "AMBIGUITY" | "RISK_REJECTION" | "POSITION_ACTIVE" | "QUALIFIED";
  rejectionSummary: string | null;
  ruleEvidence: string[];
  orbState: string;
  breakoutEvidence: string;
  volumeEvidence: string;
  pullbackEvidence: string;
  criticalLevelEvidence: string;
  trendEvidence: string;
  patienceState: string;
  patienceCandle: Record<string, number | boolean> | null;
  triggerCandle: Record<string, number | boolean> | null;
  patienceCandleOpenTime: string | null;
  patienceCandleCloseTime: string | null;
  triggerCandleOpenTime: string | null;
  triggerCandleCloseTime: string | null;
  modeledFillObservationTime: string | null;
  exitCandleOpenTime: string | null;
  exitCandleCloseTime: string | null;
  entryTriggerPrice: number | null;
  strategyStopPrice: number | null;
  catastropheStopPrice: number | null;
  targetPrice: number | null;
  eventLabels: string[];
  ambiguityLabels: string[];
  executionMode: "quote_based_shadow" | "ohlcv_modeled";
  fees: number;
  slippage: number;
  grossPnl: number | null;
  netPnl: number | null;
  exitReason: string | null;
  confirmationBufferTicks?: number;
  consolidationThresholds: ConsolidationThresholds;
  pullbackOccurrences?: Array<{
    eventId?: string;
    type: string;
    time: string;
    level: string;
    price: number;
    distancePoints?: number;
    distanceTicks?: number;
    tolerancePoints?: number;
    toleranceTicks?: number;
    qualifies?: boolean;
    candle?: { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number };
    detail: string;
  }>;
  patienceOccurrences?: PatienceOccurrence[];
};

export type BacktestSegmentation = {
  contract: string;
  contractMonth: string;
  setupType: string;
  direction: Direction;
  timeOfDay: "open" | "midday" | "close";
  trend: "bullish" | "bearish" | "neutral";
  fibonacciDepth: string;
  volumeCondition: "supported" | "warning" | "neutral";
  levelType: "NTZ" | "ORB" | "major level" | "Fibonacci" | "mixed" | "unmapped";
  confluence: "normal" | "strong" | "dynamite";
  patienceCharacteristic: string;
  orbState: OrbBreakoutState;
  marketRegime: "trend" | "range" | "transition";
};

export type BacktestMetrics = {
  tradeCount: number;
  winRate: number;
  averageWin: number | null;
  averageLoss: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  maximumDrawdown: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  ambiguousTradeCount: number;
  rejectedSetupCount: number;
  setupsDetected: number;
  setupsRejected: number;
  patienceCandles: number;
  entryTriggers: number;
  modeledFills: number;
  stopExits: number;
  targetExits: number;
  runnerExits: number;
  ambiguityCount: number;
  ambiguousExitCount: number;
  expiredPatienceSetups: number;
  ambiguousEntryCount: number;
  strategyStopExits: number;
  catastropheStopExits: number;
  sessionCloseExits: number;
  partialTargetExits: number;
  consecutiveLosses: number;
};

export type BacktestSegment = BacktestMetrics & {
  dimension: string;
  value: string;
};

export type BacktestRuntimeTiming = {
  preparationMs: number;
  cacheLookupMs: number;
  cacheStoreMs: number;
  workerStartupMs: number;
  workerMs: number;
  responseValidationMs: number;
  totalMs: number;
};

export type BacktestReport = {
  mode: "SHADOW MODE — NO LIVE ORDERS";
  dataSource: "simulated" | "historical_databento" | "historical_databento_multicontract";
  symbol: string;
  formulaHash: string;
  contract: FuturesContractSpecification;
  dataResolution: "tick" | "one-minute-fallback";
  dataset: {
    startDate: string;
    endDate: string;
    requestedStartDate: string;
    requestedEndDate: string;
    selectedDates: string[];
    inSampleDates: string[];
    outOfSampleDates: string[];
    excludedDates: string[];
    untouchedOutOfSample: true;
    optimizationApplied: false;
    scheduleVersion?: string | null;
    rolloverBoundaries?: readonly {
      effectiveDate: string;
      fromContractSymbol: string | null;
      toContractSymbol: string;
      scheduleVersion: string;
    }[];
    activeContractByDate?: readonly { tradingDate: string; contractSymbol: string }[];
  };
  replay: ReplayCursor & {
    totalCandleCount: number;
    causal: true;
    futureCandleAccess: false;
  };
  metrics: BacktestMetrics;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  segments: BacktestSegment[];
  trades: BacktestTrade[];
  audit: BacktestAuditRecord[];
  occurrences: HistoricalOccurrence[];
  auditPage?: {
    runId: string;
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
  timing?: BacktestRuntimeTiming;
  assumptions: string[];
  executionMode: "quote_based_shadow" | "ohlcv_modeled";
  fillLabel: string;
  executionPolicy: {
    entryBufferTicks: number;
    immediateNextCandleOnly: true;
    entrySlippageTicks: number;
    exitSlippageTicks: number;
    stopRule: string;
    ambiguityRule: string;
    commissionPerContract: number;
  };
  gapReport: BacktestGapReport;
};

export type HistoricalOccurrence = {
  occurrenceId: string;
  auditId: string;
  kind: "pullback" | "patience" | "risk" | "trade";
  strategyCandidate: string;
  secondaryStrategyMatches: string[];
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  direction: Direction | null;
  lTimestamp: string | null;
  lEventId: string | null;
  lInteractionType: string | null;
  lCandle: Record<string, number | boolean> | null;
  previousComparisonTimestamp: string | null;
  patienceTimestamp: string | null;
  patienceCandle: Record<string, number | boolean> | null;
  candidateShapeResult: boolean | null;
  expectedEntryTimestamp: string | null;
  confirmationThreshold: number | null;
  confirmationExcursion: number | null;
  entryTimestamp: string | null;
  entryCandle: Record<string, number | boolean> | null;
  levelIdentifiers: string[];
  levelValues: Record<string, number>;
  levelDistancesTicks: Record<string, number>;
  levelTolerancePoints: Record<string, number>;
  levelToleranceTicks: Record<string, number>;
  levelInteractionTypes: Record<string, string[]>;
  confirmationBufferTicks: number | null;
  nextObservedCandle: Record<string, number | boolean> | null;
  consolidationThresholds: ConsolidationThresholds;
  status: string;
  reasonCode: string;
  evaluationCursor: string;
  formulaVersion: string;
  formulaHash: string;
  sourceFingerprint: string;
  canonicalTrade: boolean;
  primaryEdge?: string;
  matchedEdges?: string[];
  supportingConfluences?: string[];
  setupGrade?: "A" | "A+" | "A++";
  entryPrice?: number | null;
  patienceEntryPrice?: number | null;
  confirmationEntryPrice?: number | null;
  signalStatus?: "SIGNAL_CONFIRMED" | "ENTRY_CONFIRMATION_FAILED" | "ENTRY_CONFIRMED";
  eligibilityArmId?: string;
  eligibilityArmState?: "active" | "consumed" | "invalidated" | "superseded";
  eligibilityArmStateReason?: string;
  eligibilityProvenance?: {
    eventId: string | null;
    reason: "pullback" | "consolidation" | "ntz consolidation";
    time: string;
    detail: string | null;
  };
};

export const QUALIFICATION_FUNNEL_STAGES = [
  "session_loaded",
  "ntz_orb_completed",
  "strong_breakout_candidate",
  "strong_continuation_confirmed",
  "pullback_or_consolidation",
  "critical_level_interaction",
  "fibonacci_context_available",
  "volume_condition_passed",
  "valid_trend_aligned_patience_candle",
  "immediate_next_candle_confirmation",
  "risk_approved",
  "modeled_entry",
  "final_exit",
] as const;

export type QualificationFunnelStage = typeof QUALIFICATION_FUNNEL_STAGES[number];

export type QualificationFunnelStageCount = {
  stage: QualificationFunnelStage;
  count: number;
  percentOfPreceding: number;
  percentOfSessions: number;
};

export type QualificationCandidate = {
  candidateId: string;
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  period: "in_sample" | "out_of_sample";
  direction: Direction | null;
  setupType: string;
  timeOfDay: BacktestSegmentation["timeOfDay"];
  marketRegime: BacktestSegmentation["marketRegime"];
  volumeRegime: "normal" | "high";
  reachedStage: QualificationFunnelStage;
  primaryRejectionStage: QualificationFunnelStage | null;
  rejectionDetail: string | null;
  evidence: {
    evaluatedCandleOpenTime: string;
    orbLevels: string;
    breakout: string;
    volume: string;
    pullback: string;
    criticalLevel: string;
    trend: string;
    patience: string;
    trigger: string;
    patienceCandle: Record<string, number | boolean> | null;
    triggerCandle: Record<string, number | boolean> | null;
    patienceCandleOpenTime: string | null;
    patienceCandleCloseTime: string | null;
    triggerCandleOpenTime: string | null;
    triggerCandleCloseTime: string | null;
    entryTriggerPrice: number | null;
    strategyStopPrice: number | null;
    catastropheStopPrice: number | null;
    targetPrice: number | null;
    decision: string;
    rejectionCategory: BacktestAuditRecord["rejectionCategory"];
    ruleEvidence: string[];
    finalOutcome: BacktestTrade["outcome"] | null;
    exitCandleOpenTime: string | null;
    exitCandleCloseTime: string | null;
    netPnl: number | null;
  };
};

export type QualificationFunnelComparison = {
  dimension: "contract" | "month" | "direction" | "period" | "market_regime" | "volume_regime";
  value: string;
  candidateCount: number;
  stageCounts: QualificationFunnelStageCount[];
};

export type QualificationFunnel = {
  sessionCount: number;
  candidateCount: number;
  occurrenceCount: number;
  stages: QualificationFunnelStageCount[];
  rejectionCounts: Array<{ stage: QualificationFunnelStage; count: number }>;
  comparisons: QualificationFunnelComparison[];
  candidates: QualificationCandidate[];
};

const MINUTE = 60_000;

function money(value: number): number {
  return Number(value.toFixed(2));
}

function sortedCandles(candles: readonly SimulatedFuturesCandle[]): SimulatedFuturesCandle[] {
  return [...candles].sort((first, second) => first.closeTime - second.closeTime);
}

export function visibleReplayPrefix(
  candles: readonly SimulatedFuturesCandle[],
  cursor: number,
): SimulatedFuturesCandle[] {
  return sortedCandles(candles)
    .filter((candle) => candle.isComplete && candle.closeTime <= cursor)
    .map((candle) => ({ ...candle }));
}

export function createCausalReplay(
  dataset: Pick<CausalReplayDataset, "candles">,
  cursor: number,
): ReplayCursor & { candles: SimulatedFuturesCandle[] } {
  const candles = visibleReplayPrefix(dataset.candles, cursor);
  return {
    cursor,
    visibleCandleCount: candles.length,
    visibleCandleCloseTime: candles.at(-1)?.closeTime ?? null,
    mode: "replay",
    candles,
  };
}

export function assertCausalVisibility(
  visible: readonly { closeTime: number }[],
  cursor: number,
): void {
  if (visible.some((candle) => candle.closeTime > cursor)) {
    throw new Error("Causal replay attempted to expose a future candle.");
  }
}

/**
 * This is intentionally a conservative fallback for the deterministic feed:
 * the generated five-minute candle has a synthetic one-minute path, but any
 * high/low collision inside one minute remains unresolved and is stop-first.
 */
export function buildSyntheticOneMinuteBars(candle: SimulatedFuturesCandle): IntrabarBar[] {
  const bullish = candle.close >= candle.open;
  const points = bullish
    ? [candle.open, candle.low, candle.high, candle.high, candle.close]
    : [candle.open, candle.high, candle.low, candle.low, candle.close];
  return points.map((open, index) => {
    const close = points[index + 1] ?? candle.close;
    const high = Math.max(open, close, index === (bullish ? 2 : 1) ? candle.high : -Infinity);
    const low = Math.min(open, close, index === (bullish ? 1 : 2) ? candle.low : Infinity);
    return {
      openTime: candle.openTime + index * MINUTE,
      closeTime: candle.openTime + (index + 1) * MINUTE,
      open,
      high,
      low,
      close,
      source: "one-minute",
      sequenceKnown: false,
    };
  });
}

function touches(direction: Direction, price: number, target: number | null, stop: number | null): { target: boolean; stop: boolean } {
  return {
    target: target !== null && (direction === "long" ? price >= target : price <= target),
    stop: stop !== null && (direction === "long" ? price <= stop : price >= stop),
  };
}

function barTouches(
  direction: Direction,
  bar: Pick<IntrabarBar, "high" | "low">,
  target: number | null,
  stop: number | null,
): { target: boolean; stop: boolean } {
  return {
    target: target !== null && (direction === "long" ? bar.high >= target : bar.low <= target),
    stop: stop !== null && (direction === "long" ? bar.low <= stop : bar.high >= stop),
  };
}

export function resolveIntrabarOutcome(input: {
  direction: Direction;
  target: number | null;
  stop: number | null;
  candle: SimulatedFuturesCandle;
  ticks?: readonly IntrabarPoint[];
  oneMinute?: readonly IntrabarBar[];
}): IntrabarResolution {
  const ticks = [...(input.ticks ?? [])].filter((tick) =>
    tick.timestamp >= input.candle.openTime && tick.timestamp <= input.candle.closeTime,
  ).sort((first, second) => first.timestamp - second.timestamp);
  if (ticks.length) {
    for (const tick of ticks) {
      const hit = touches(input.direction, tick.price, input.target, input.stop);
      if (hit.stop && hit.target) {
        return {
          status: "ambiguous",
          source: "tick",
          timestamp: tick.timestamp,
          price: tick.price,
          ambiguityLabel: "AMBIGUOUS_STOP_FIRST",
          detail: "Tick data touched the stop and target at the same observation; the conservative stop-first policy was applied.",
        };
      }
      if (hit.stop) return { status: "stop", source: "tick", timestamp: tick.timestamp, price: tick.price, ambiguityLabel: null, detail: "Tick data resolved the stop before any target." };
      if (hit.target) return { status: "target", source: "tick", timestamp: tick.timestamp, price: tick.price, ambiguityLabel: null, detail: "Tick data resolved the target." };
    }
    return { status: "open", source: "tick", timestamp: null, price: null, ambiguityLabel: null, detail: "Tick data did not reach a target or stop." };
  }

  const bars = [...(input.oneMinute ?? [])]
    .filter((bar) => bar.openTime >= input.candle.openTime && bar.closeTime <= input.candle.closeTime)
    .sort((first, second) => first.closeTime - second.closeTime);
  if (bars.length) {
    for (const bar of bars) {
      const hit = barTouches(input.direction, bar, input.target, input.stop);
      if (hit.stop && hit.target) {
        return {
          status: "ambiguous",
          source: "one-minute",
          timestamp: bar.closeTime,
          price: input.stop,
          ambiguityLabel: "AMBIGUOUS_STOP_FIRST",
          detail: "One-minute OHLC touched both barriers inside the same minute; the conservative stop-first policy was applied.",
        };
      }
      if (hit.stop) return { status: "stop", source: "one-minute", timestamp: bar.closeTime, price: input.stop, ambiguityLabel: null, detail: "One-minute data resolved the stop." };
      if (hit.target) return { status: "target", source: "one-minute", timestamp: bar.closeTime, price: input.target, ambiguityLabel: null, detail: "One-minute data resolved the target." };
    }
    return { status: "open", source: "one-minute", timestamp: null, price: null, ambiguityLabel: null, detail: "One-minute data did not reach a target or stop." };
  }

  const hit = barTouches(input.direction, input.candle, input.target, input.stop);
  if (hit.stop || hit.target) {
    const ambiguous = hit.stop && hit.target;
    return {
      status: ambiguous ? "ambiguous" : hit.stop ? "stop" : "target",
      source: "ohlc",
      timestamp: input.candle.closeTime,
      price: hit.stop ? input.stop : input.target,
      ambiguityLabel: ambiguous ? "AMBIGUOUS_STOP_FIRST" : null,
      detail: hit.stop
        ? ambiguous
          ? "Only five-minute OHLC is available and both barriers were touched; stop-first was applied."
          : "Five-minute OHLC reached the stop without also reaching the target."
        : "Five-minute OHLC reached the target without also reaching the stop.",
    };
  }
  return { status: "open", source: "ohlc", timestamp: null, price: null, ambiguityLabel: null, detail: "Five-minute OHLC did not reach a target or stop." };
}

export function resolveEntryAndInvalidation(input: {
  direction: Direction;
  candle: Pick<SimulatedFuturesCandle, "open" | "high" | "low" | "close">;
  entry: number;
  invalidation: number | null;
  sequenceKnown: boolean;
}): EntryResolution {
  const entryTouched = input.direction === "long" ? input.candle.high >= input.entry : input.candle.low <= input.entry;
  const invalidationTouched = input.invalidation !== null
    && (input.direction === "long" ? input.candle.low <= input.invalidation : input.candle.high >= input.invalidation);
  if (entryTouched && invalidationTouched && !input.sequenceKnown) {
    return {
      status: "ambiguous",
      price: null,
      label: "AMBIGUOUS_ENTRY_INVALIDATION",
      detail: "Entry and invalidation occurred in the same unresolved candle; the setup was rejected instead of inventing an order.",
    };
  }
  return {
    status: "accepted",
    price: entryTouched ? input.entry : null,
    label: null,
    detail: entryTouched ? "Entry sequence was resolved without look-ahead." : "The entry was not touched.",
  };
}

function datesForDataset(
  candles: readonly SimulatedFuturesCandle[],
  calendar: FuturesSessionCalendar,
): string[] {
  return [...new Set(candles.map((candle) => tradingDateForTimestamp(candle.openTime, calendar)))].sort();
}

type ReplayIndexes = {
  candlesByContract: Map<string, SimulatedFuturesCandle[]>;
  candleIndexByContractOpenTime: Map<string, Map<number, number>>;
  hourlyByContract: Map<string, SimulatedHourlyCandle[]>;
  regularCandlesByContractDate: Map<string, SimulatedFuturesCandle[]>;
  regularIndexByContractOpenTime: Map<string, Map<number, number>>;
  ticksByCandleOpenTime: Map<number, IntrabarPoint[]>;
  oneMinuteByContractCandle: Map<string, IntrabarBar[]>;
};

function lowerBound<T>(values: readonly T[], target: number, value: (item: T) => number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (value(values[middle]) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function buildReplayIndexes(
  candles: readonly SimulatedFuturesCandle[],
  ticks: readonly IntrabarPoint[],
  oneMinute: readonly IntrabarBar[],
  calendar: FuturesSessionCalendar,
): ReplayIndexes {
  const candlesByContract = new Map<string, SimulatedFuturesCandle[]>();
  const candleIndexByContractOpenTime = new Map<string, Map<number, number>>();
  const regularCandlesByContractDate = new Map<string, SimulatedFuturesCandle[]>();
  const regularIndexByContractOpenTime = new Map<string, Map<number, number>>();

  for (const candle of candles) {
    const contractCandles = candlesByContract.get(candle.contractSymbol) ?? [];
    contractCandles.push(candle);
    candlesByContract.set(candle.contractSymbol, contractCandles);

    const contractIndex = candleIndexByContractOpenTime.get(candle.contractSymbol) ?? new Map<number, number>();
    contractIndex.set(candle.openTime, contractCandles.length - 1);
    candleIndexByContractOpenTime.set(candle.contractSymbol, contractIndex);

    const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
    const window = sessionWindow(tradingDate, "regular", calendar);
    if (candle.isComplete && window && candle.openTime >= window.openTime && candle.closeTime <= window.closeTime) {
      const dateKey = `${candle.contractSymbol}:${tradingDate}`;
      const regular = regularCandlesByContractDate.get(dateKey) ?? [];
      regular.push(candle);
      regularCandlesByContractDate.set(dateKey, regular);
      const regularIndex = regularIndexByContractOpenTime.get(dateKey) ?? new Map<number, number>();
      regularIndex.set(candle.openTime, regular.length - 1);
      regularIndexByContractOpenTime.set(dateKey, regularIndex);
    }
  }

  const hourlyByContract = new Map<string, SimulatedHourlyCandle[]>();
  for (const [contractSymbol, contractCandles] of candlesByContract) {
    hourlyByContract.set(contractSymbol, completedSimulatedHourlyCandles(contractCandles, calendar));
  }

  const sortedTicks = [...ticks].sort((first, second) => first.timestamp - second.timestamp);
  const ticksByCandleOpenTime = new Map<number, IntrabarPoint[]>();
  for (const candle of candles) {
    const start = lowerBound(sortedTicks, candle.openTime, (item) => item.timestamp);
    const end = lowerBound(sortedTicks, candle.closeTime + 1, (item) => item.timestamp);
    if (end > start) ticksByCandleOpenTime.set(candle.openTime, sortedTicks.slice(start, end));
  }

  const oneMinuteByContract = new Map<string, IntrabarBar[]>();
  const sortedOneMinute = [...oneMinute].sort((first, second) => first.closeTime - second.closeTime);
  if (candlesByContract.size > 1) {
    const assignedBars = new Set<string>();
    for (const [contractSymbol, contractCandles] of candlesByContract) {
      for (const item of sortedOneMinute) {
        const candleIndex = lowerBound(contractCandles, item.openTime + 1, (value) => value.openTime) - 1;
        const enclosing = contractCandles[candleIndex];
        if (!enclosing) continue;
        const sameTradingDate = tradingDateForTimestamp(item.openTime, calendar)
          === tradingDateForTimestamp(enclosing.openTime, calendar);
        const enclosedByFiveMinute = item.openTime >= enclosing.openTime
          && item.closeTime <= enclosing.closeTime;
        if (!sameTradingDate || !enclosedByFiveMinute) continue;
        const barIdentity = `${item.openTime}:${item.closeTime}`;
        if (assignedBars.has(barIdentity)) continue;
        const partition = oneMinuteByContract.get(contractSymbol) ?? [];
        partition.push(item);
        oneMinuteByContract.set(contractSymbol, partition);
        assignedBars.add(barIdentity);
      }
    }
  }

  const oneMinuteByContractCandle = new Map<string, IntrabarBar[]>();
  for (const [contractSymbol, contractCandles] of candlesByContract) {
    const contractBars = candlesByContract.size === 1
      ? sortedOneMinute
      : oneMinuteByContract.get(contractSymbol) ?? [];
    let cursor = 0;
    for (const candle of contractCandles) {
      while (cursor < contractBars.length && contractBars[cursor].closeTime <= candle.openTime) cursor += 1;
      const bars: IntrabarBar[] = [];
      for (let index = cursor; index < contractBars.length; index += 1) {
        const bar = contractBars[index];
        if (bar.openTime >= candle.openTime && bar.closeTime <= candle.closeTime) bars.push(bar);
        if (bar.openTime > candle.closeTime) break;
      }
      if (bars.length) oneMinuteByContractCandle.set(`${contractSymbol}:${candle.openTime}`, bars);
    }
  }

  return {
    candlesByContract,
    candleIndexByContractOpenTime,
    hourlyByContract,
    regularCandlesByContractDate,
    regularIndexByContractOpenTime,
    ticksByCandleOpenTime,
    oneMinuteByContractCandle,
  };
}

export function buildReplayDataset(
  symbol: string,
  options: ReplayDatasetOptions,
): CausalReplayDataset {
  if (options.inSampleDays < 1 || options.outOfSampleDays < 1) {
    throw new Error("Replay requires at least one in-sample day and one out-of-sample day.");
  }
  const specification = getFuturesContractSpecification(symbol);
  const calendar = sessionCalendarForContract(specification);
  const candles = generateSimulatedFuturesFeed(specification, {
    calendar,
    days: options.inSampleDays + options.outOfSampleDays,
    seed: options.seed ?? 11,
    includePremarket: options.premarketAvailable !== false,
    startDate: options.endDate,
  });
  const dates = datesForDataset(candles, calendar);
  const inSampleDates = dates.slice(0, options.inSampleDays);
  const outOfSampleDates = dates.slice(-options.outOfSampleDays);
  return {
    candles,
    contractSymbol: specification.fullContractSymbol,
    contractMonth: specification.contractMonth,
    inSampleDates,
    outOfSampleDates,
  };
}

function periodForDate(date: string, dataset: CausalReplayDataset): "in_sample" | "out_of_sample" {
  return dataset.outOfSampleDates.includes(date) ? "out_of_sample" : "in_sample";
}

function timeOfDay(timestamp: number): BacktestSegmentation["timeOfDay"] {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp)));
  return hour < 11 ? "open" : hour < 14 ? "midday" : "close";
}

function levelType(snapshot: MarketSnapshot): BacktestSegmentation["levelType"] {
  const levelNames = snapshot.setupAnalysis.evaluations
    .flatMap((evaluation) => evaluation.rules.filter((rule) => rule.passed).map((rule) => rule.key));
  const types = [
    levelNames.some((name) => name.includes("ntz")) ? "NTZ" : null,
    levelNames.some((name) => name.includes("pullback") || name.includes("level")) ? "major level" : null,
    snapshot.fibonacci.frozen ? "Fibonacci" : null,
  ].filter((value): value is string => value !== null);
  return types.length > 1 ? "mixed" : (types[0] as BacktestSegmentation["levelType"] | undefined) ?? "unmapped";
}

function segmentation(
  snapshot: MarketSnapshot,
  setupType: string,
  direction: Direction,
  candle: SimulatedFuturesCandle,
  contractSymbol = snapshot.contract.fullContractSymbol,
  contractMonth = snapshot.contract.contractMonth,
): BacktestSegmentation {
  const confluence = snapshot.majorLevels.reduce<BacktestSegmentation["confluence"]>((strongest, level) => {
    const rank = { normal: 0, strong: 1, dynamite: 2 };
    return rank[level.confluence] > rank[strongest] ? level.confluence : strongest;
  }, "normal");
  return {
    contract: contractSymbol,
    contractMonth,
    setupType,
    direction,
    timeOfDay: timeOfDay(candle.openTime),
    trend: snapshot.trend.direction,
    fibonacciDepth: snapshot.fibonacci.classification,
    volumeCondition: snapshot.volumeAnalysis.reversalWarning ? "warning" : snapshot.volumeAnalysis.supportingBreakoutVolume ? "supported" : "neutral",
    levelType: levelType(snapshot),
    confluence,
    patienceCharacteristic: snapshot.patience.state,
    orbState: snapshot.breakout.state,
    marketRegime: snapshot.trend.direction === "neutral" ? "range" : snapshot.volumeAnalysis.reversalWarning ? "transition" : "trend",
  };
}

function emptyMetrics(rejectedSetupCount = 0): BacktestMetrics {
  return {
    tradeCount: 0,
    winRate: 0,
    averageWin: null,
    averageLoss: null,
    expectancy: null,
    profitFactor: null,
    maximumDrawdown: 0,
    grossPnl: 0,
    fees: 0,
    slippage: 0,
    netPnl: 0,
    ambiguousTradeCount: 0,
    rejectedSetupCount,
    setupsDetected: 0,
    setupsRejected: rejectedSetupCount,
    patienceCandles: 0,
    entryTriggers: 0,
    modeledFills: 0,
    stopExits: 0,
    targetExits: 0,
    runnerExits: 0,
    ambiguityCount: 0,
    ambiguousExitCount: 0,
    expiredPatienceSetups: 0,
    ambiguousEntryCount: 0,
    strategyStopExits: 0,
    catastropheStopExits: 0,
    sessionCloseExits: 0,
    partialTargetExits: 0,
    consecutiveLosses: 0,
  };
}

export function calculateBacktestMetrics(
  trades: readonly BacktestTrade[],
  rejectedSetupCount = 0,
  audits: readonly BacktestAuditRecord[] = [],
): BacktestMetrics {
  if (!trades.length) {
    const empty = emptyMetrics(rejectedSetupCount);
    empty.expiredPatienceSetups = audits.filter((record) => record.patienceState === "PATIENCE_CANDLE_EXPIRED").length;
    empty.ambiguousEntryCount = audits.filter((record) => record.rejectionReason === "AMBIGUOUS_ENTRY_INVALIDATION").length;
    empty.ambiguityCount = empty.ambiguousEntryCount;
    return empty;
  }
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  let consecutiveLosses = 0;
  let currentLosses = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
    currentLosses = trade.netPnl < 0 ? currentLosses + 1 : 0;
    consecutiveLosses = Math.max(consecutiveLosses, currentLosses);
  }
  const grossWins = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  return {
    tradeCount: trades.length,
    winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
    averageWin: wins.length ? money(grossWins / wins.length) : null,
    averageLoss: losses.length ? money(losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length) : null,
    expectancy: money(trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length),
    profitFactor: grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? null : 0,
    maximumDrawdown: money(maximumDrawdown),
    grossPnl: money(trades.reduce((sum, trade) => sum + trade.grossPnl, 0)),
    fees: money(trades.reduce((sum, trade) => sum + trade.fees, 0)),
    slippage: money(trades.reduce((sum, trade) => sum + trade.slippage, 0)),
    netPnl: money(trades.reduce((sum, trade) => sum + trade.netPnl, 0)),
     ambiguousTradeCount: trades.filter((trade) => (trade.audit?.ambiguityLabels.length ?? 0) > 0).length,
    rejectedSetupCount,
    setupsDetected: trades.length,
    setupsRejected: rejectedSetupCount,
     patienceCandles: trades.filter((trade) => trade.audit?.patienceCandleOpenTime !== null).length,
    entryTriggers: trades.filter((trade) => trade.audit?.entryTriggerPrice !== null).length,
    modeledFills: trades.filter((trade) => trade.executionMode === "ohlcv_modeled").length,
    stopExits: trades.filter((trade) => trade.outcome === "strategy stop" || trade.outcome === "catastrophe stop").length,
    targetExits: trades.filter((trade) => trade.audit?.targetHit === true).length,
     runnerExits: trades.filter((trade) => trade.audit?.runnerExited === true || trade.audit?.legs?.some((leg) => leg.kind === "runner") === true).length,
     ambiguityCount: audits.filter((record) => record.rejectionReason === "AMBIGUOUS_ENTRY_INVALIDATION").length
       + trades.filter((trade) => (trade.audit?.ambiguityLabels.length ?? 0) > 0).length,
     ambiguousExitCount: trades.filter((trade) => (trade.audit?.ambiguityLabels.length ?? 0) > 0).length,
    expiredPatienceSetups: audits.filter((record) => record.patienceState === "PATIENCE_CANDLE_EXPIRED").length,
    ambiguousEntryCount: audits.filter((record) => record.rejectionReason === "AMBIGUOUS_ENTRY_INVALIDATION").length,
    strategyStopExits: trades.filter((trade) => trade.outcome === "strategy stop").length,
    catastropheStopExits: trades.filter((trade) => trade.outcome === "catastrophe stop").length,
    sessionCloseExits: trades.filter((trade) => trade.outcome === "session close").length,
     partialTargetExits: trades.filter((trade) => trade.audit?.legs?.some((leg) => leg.kind === "target") && trade.audit?.legs?.some((leg) => leg.kind === "runner")).length,
     consecutiveLosses,
  };
}

export function buildSegments(trades: readonly BacktestTrade[], rejectedSetupCount: number): BacktestSegment[] {
  const dimensions: Array<keyof BacktestSegmentation> = [
    "contract", "contractMonth", "setupType", "direction", "timeOfDay", "trend",
    "fibonacciDepth", "volumeCondition", "levelType", "confluence", "patienceCharacteristic", "orbState", "marketRegime",
  ];
  const dimensionalSegments = dimensions.flatMap((dimension) => {
    const values = [...new Set(trades.map((trade) => String(trade.segmentation[dimension])))];
    return values.map((value) => {
      const matching = trades.filter((trade) => String(trade.segmentation[dimension]) === value);
      return { dimension, value, ...calculateBacktestMetrics(matching, matching.length ? 0 : rejectedSetupCount) };
    });
  });
  const periodSegments = (["in_sample", "out_of_sample"] as const)
    .map((value) => {
      const matching = trades.filter((trade) => trade.period === value);
      return { dimension: "period", value, ...calculateBacktestMetrics(matching) };
    })
    .filter((segment) => segment.tradeCount > 0);
  return [...dimensionalSegments, ...periodSegments];
}

function evidenceCandle(candle: SimulatedFuturesCandle | null | undefined): Record<string, number | boolean> | null {
  if (!candle) return null;
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    isComplete: candle.isComplete,
  };
}

function classifyRejection(reason: string | null, decision: string): BacktestAuditRecord["rejectionCategory"] {
  if (decision === "SETUP QUALIFIED" && reason === null) return "QUALIFIED";
  if (!reason) return "FAILURE";
  if (reason === "POSITION_ACTIVE") return "POSITION_ACTIVE";
  if (reason.startsWith("AMBIGUOUS")) return "AMBIGUITY";
  if (reason.includes("EXPIRED")) return "EXPIRED";
  if (reason.includes("WAIT") || reason.includes("NOT_COMPLETED") || reason.includes("NOT_AT_CURSOR")) return "WAITING";
  if (reason.includes("RISK") || reason.includes("CONTRACT") || reason.includes("DAILY")) return "RISK_REJECTION";
  return "FAILURE";
}

function setAuditRejection(record: BacktestAuditRecord, reason: string | null, summary = reason): void {
  record.rejectionReason = reason;
  record.rejectionCategory = classifyRejection(reason, record.decision);
  record.rejectionSummary = summary;
}

function auditForEvaluation(
  evaluation: MarketSnapshot["setupAnalysis"]["evaluations"][number],
  snapshot: MarketSnapshot,
  candle: SimulatedFuturesCandle,
  tradingDate: string,
  period: "in_sample" | "out_of_sample",
  executionMode: "quote_based_shadow" | "ohlcv_modeled",
  contractSymbol: string,
  contractMonth: string,
  governedConsolidation: ConsolidationThresholds,
): BacktestAuditRecord {
  const rejectionReason = evaluation.decision === "SETUP QUALIFIED" ? null : `RULES_NOT_QUALIFIED:${evaluation.setupType}`;
  return {
    id: `${tradingDate}-${candle.openTime}-${evaluation.setupType}`,
    tradingDate,
    contractSymbol,
    contractMonth,
    period,
    evaluatedCandleOpenTime: new Date(candle.openTime).toISOString(),
    setupType: evaluation.setupType,
    direction: evaluation.direction,
    decision: evaluation.decision,
    alertOnly: evaluation.alertOnly,
    rejectionReason,
    rejectionCategory: classifyRejection(rejectionReason, evaluation.decision),
    rejectionSummary: evaluation.decision === "SETUP QUALIFIED"
      ? null
      : evaluation.rules.filter((rule) => !rule.passed).map((rule) => `${rule.key}: ${rule.detail}`).join("; ") || evaluation.explanation,
    ruleEvidence: evaluation.rules.map((rule) => `${rule.passed ? "PASS" : "FAIL"} ${rule.key}: ${rule.detail}`),
    orbState: snapshot.breakout.state,
    breakoutEvidence: snapshot.breakout.detail,
    volumeEvidence: snapshot.volumeAnalysis.reversalWarning
      ?? (snapshot.volumeAnalysis.supportingBreakoutVolume ? "Breakout volume supported." : "Breakout volume neutral or unavailable."),
    pullbackEvidence: snapshot.pullback.events.length
      ? snapshot.pullback.events.map((event) => `${event.type} at ${event.level} (${event.price}): ${event.detail}`).join("; ")
      : snapshot.pullback.detail,
    criticalLevelEvidence: snapshot.levels.critical.map((level) => `${level.name} ${level.price}`).join("; ") || "No critical level evidence.",
    trendEvidence: `${snapshot.trend.direction}: ${snapshot.trend.evidence.join("; ")}`,
    patienceState: snapshot.patience.state,
    patienceCandle: evidenceCandle(snapshot.patience.patienceCandle as SimulatedFuturesCandle | null),
    triggerCandle: evidenceCandle(snapshot.patience.triggerCandle as SimulatedFuturesCandle | null),
    patienceCandleOpenTime: snapshot.patience.patienceCandle?.openTime ?? null,
    patienceCandleCloseTime: snapshot.patience.patienceCandle?.closeTime ?? null,
    triggerCandleOpenTime: snapshot.patience.triggerCandle?.openTime ?? null,
    triggerCandleCloseTime: snapshot.patience.triggerCandle?.closeTime ?? null,
    modeledFillObservationTime: null,
    exitCandleOpenTime: null,
    exitCandleCloseTime: null,
    entryTriggerPrice: snapshot.patience.entryBufferPrice,
    strategyStopPrice: snapshot.riskPlan.strategyStop,
    catastropheStopPrice: snapshot.riskPlan.catastropheStop,
    targetPrice: snapshot.riskPlan.target,
    eventLabels: [],
    ambiguityLabels: [],
    executionMode,
    fees: 0,
    slippage: 0,
    grossPnl: null,
    netPnl: null,
    exitReason: null,
    confirmationBufferTicks: snapshot.patience.entryBufferTicks,
    consolidationThresholds: governedConsolidation,
    pullbackOccurrences: snapshot.pullback.events.map((event) => ({ ...event })),
    patienceOccurrences: [...(snapshot.patience.occurrences ?? [])],
  };
}

function stageRank(stage: QualificationFunnelStage): number {
  return QUALIFICATION_FUNNEL_STAGES.indexOf(stage);
}

function passedRule(record: BacktestAuditRecord, pattern: RegExp): boolean {
  return record.ruleEvidence.some((evidence) => evidence.startsWith("PASS ") && pattern.test(evidence));
}

function stageEvidence(
  record: BacktestAuditRecord,
  trade: BacktestTrade | undefined,
): boolean[] {
  const ruleText = record.ruleEvidence.join(" ");
  const marketText = `${record.breakoutEvidence} ${record.trendEvidence} ${record.pullbackEvidence}`;
  const orbCompleted = passedRule(record, /(?:ntz|orb)/i)
    || !/(?:NOT_COMPLETED|INCOMPLETE|WAITING)/i.test(record.orbState);
  const strongBreakout = passedRule(record, /(?:breakout|orb|impulse|strong)/i)
    || /(?:strong|confirmed|breakout|impulse)/i.test(record.breakoutEvidence);
  const continuation = passedRule(record, /(?:continuation|trend|alignment|follow)/i)
    || /(?:continuation|aligned|follow-through|follow through)/i.test(marketText);
  const pullback = passedRule(record, /(?:pullback|consolidation|retest)/i)
    || /(?:pullback|consolidation|retest)/i.test(record.pullbackEvidence);
  const criticalLevel = passedRule(record, /(?:critical|level|ntz|orb)/i)
    || (record.criticalLevelEvidence !== "No critical level evidence." && record.criticalLevelEvidence.length > 0);
  const fibonacci = passedRule(record, /fibonacci|fib/i)
    || /fibonacci|fib/i.test(ruleText);
  const volume = passedRule(record, /volume/i)
    || /supported|confirmed/i.test(record.volumeEvidence);
  const patience = record.patienceCandle !== null
    || /valid|confirmed|ready|aligned/i.test(record.patienceState);
  const trigger = record.triggerCandle !== null
    || record.modeledFillObservationTime !== null
    || /trigger|confirmed/i.test(record.patienceState);
  const risk = trade !== undefined
    || (record.rejectionReason !== "RISK_REJECTED"
      && (record.decision === "SETUP QUALIFIED" || passedRule(record, /risk|stop|target|contract|daily/i)));
  const entry = trade !== undefined;
  const exit = trade !== undefined && trade.exitTime !== null;
  return [
    true,
    orbCompleted,
    strongBreakout,
    continuation,
    pullback,
    criticalLevel,
    fibonacci,
    volume,
    patience,
    trigger,
    risk,
    entry,
    exit,
  ];
}

function contiguousStage(stageFlags: readonly boolean[]): QualificationFunnelStage {
  let rank = 0;
  for (let index = 1; index < stageFlags.length; index += 1) {
    if (!stageFlags[index]) break;
    rank = index;
  }
  return QUALIFICATION_FUNNEL_STAGES[rank];
}

function candidateKey(record: Pick<BacktestAuditRecord, "tradingDate" | "contractSymbol" | "setupType" | "direction" | "evaluatedCandleOpenTime">): string {
  return [
    record.tradingDate,
    record.contractSymbol,
    record.setupType,
    record.direction ?? "unknown",
    record.evaluatedCandleOpenTime,
  ].join("|");
}

function tradeForRecord(record: BacktestAuditRecord, trades: readonly BacktestTrade[]): BacktestTrade | undefined {
  return trades.find((trade) => (
    trade.tradingDate === record.tradingDate
    && trade.contractSymbol === record.contractSymbol
    && trade.setupType === record.setupType
    && trade.direction === record.direction
    && (
      trade.audit?.triggerCandleOpenTime === record.triggerCandleOpenTime
      || trade.entryTime === record.triggerCandleCloseTime
      || trade.entryTime === record.evaluatedCandleOpenTime
    )
  ));
}

function occurrenceCandle(candle: { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume?: number; isComplete?: boolean } | null | undefined): Record<string, number | boolean> | null {
  if (!candle) return null;
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    ...(candle.volume === undefined ? {} : { volume: candle.volume }),
    isComplete: candle.isComplete ?? true,
  };
}

function occurrenceId(seed: string): string {
  return `occ-${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

function governedOccurrenceId(value: HistoricalOccurrence): string {
  const actualObservedE = value.nextObservedCandle && typeof value.nextObservedCandle.openTime === "number"
    ? value.nextObservedCandle.openTime
    : null;
  return occurrenceId([
    "historical-occurrence-v2",
    value.sourceFingerprint,
    value.formulaHash,
    value.formulaVersion,
    value.contractSymbol,
    value.tradingDate,
    value.kind,
    value.strategyCandidate,
    value.direction,
    value.lEventId,
    value.lTimestamp,
    value.patienceTimestamp,
    value.expectedEntryTimestamp,
    actualObservedE,
    value.entryTimestamp,
    value.status,
    value.signalStatus,
    value.eligibilityArmId,
  ].map((part) => part ?? "absent").join("|"));
}

export function sourceFingerprint(dataset: CausalReplayDataset): string {
  const digest = createHash("sha256");
  digest.update("levelstory-causal-source-v2|");
  if (dataset.contentFingerprint) digest.update(`importer:${dataset.contentFingerprint}|`);
  const candles = [...dataset.candles].sort((first, second) =>
    first.contractSymbol.localeCompare(second.contractSymbol)
    || first.openTime - second.openTime
    || first.closeTime - second.closeTime,
  );
  for (const candle of candles) {
    digest.update(JSON.stringify({
      contract: candle.contractSymbol,
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      isComplete: candle.isComplete,
    }));
    digest.update("\n");
  }
  digest.update(JSON.stringify({
    source: dataset.source ?? "simulated",
    contractSymbol: dataset.contractSymbol,
    contractMonth: dataset.contractMonth,
    selectedDates: dataset.selectedDates ?? [...dataset.inSampleDates, ...dataset.outOfSampleDates],
    schedule: dataset.contractSchedule?.version ?? null,
  }));
  return digest.digest("hex");
}

type HistoricalPullbackEvent = NonNullable<BacktestAuditRecord["pullbackOccurrences"]>[number];

const QUALIFYING_PULLBACK_EVENT_TYPES = new Set([
  "touch",
  "proximity",
  "consolidation",
  "break and reclaim",
  "hold",
]);

function pullbackEventId(event: HistoricalPullbackEvent): string {
  return event.eventId ?? `pullback|${event.type}|${event.time}|${event.level}|${event.price}`;
}

function pullbackEventOpenTime(event: HistoricalPullbackEvent): number {
  return event.candle?.openTime ?? Date.parse(event.time);
}

function linkedPullbackEvents(
  record: BacktestAuditRecord,
  patience: PatienceOccurrence,
): HistoricalPullbackEvent[] {
  const events = (record.pullbackOccurrences ?? []).filter((event) =>
    event.qualifies !== false && QUALIFYING_PULLBACK_EVENT_TYPES.has(event.type),
  );
  const exact = patience.eligibilityEventId
    ? events.find((event) => pullbackEventId(event) === patience.eligibilityEventId)
    : undefined;
  const anchor = exact ?? events.find((event) => Date.parse(event.time) === patience.eligibilityTime);
  if (!anchor) return [];
  const anchorOpenTime = pullbackEventOpenTime(anchor);
  return events.filter((event) => pullbackEventOpenTime(event) === anchorOpenTime);
}

function levelEvidence(events: readonly HistoricalPullbackEvent[]): {
  identifiers: string[];
  values: Record<string, number>;
  distancesTicks: Record<string, number>;
  tolerancePoints: Record<string, number>;
  toleranceTicks: Record<string, number>;
  interactionTypes: Record<string, string[]>;
} {
  const identifiers: string[] = [];
  const values: Record<string, number> = {};
  const distancesTicks: Record<string, number> = {};
  const tolerancePoints: Record<string, number> = {};
  const toleranceTicks: Record<string, number> = {};
  const interactionTypes: Record<string, string[]> = {};
  for (const event of events) {
    if (!identifiers.includes(event.level)) identifiers.push(event.level);
    values[event.level] ??= event.price;
    distancesTicks[event.level] = Math.min(distancesTicks[event.level] ?? Number.POSITIVE_INFINITY, event.distanceTicks ?? 0);
    if (event.tolerancePoints !== undefined) tolerancePoints[event.level] = event.tolerancePoints;
    if (event.toleranceTicks !== undefined) toleranceTicks[event.level] = event.toleranceTicks;
    interactionTypes[event.level] = [...new Set([...(interactionTypes[event.level] ?? []), event.type])];
  }
  return { identifiers, values, distancesTicks, tolerancePoints, toleranceTicks, interactionTypes };
}

export function buildHistoricalOccurrenceLedger(
  dataset: CausalReplayDataset,
  audits: readonly BacktestAuditRecord[],
  trades: readonly BacktestTrade[],
  reportFormulaHash?: string,
): HistoricalOccurrence[] {
  const fingerprint = sourceFingerprint(dataset);
  const formulaHash = reportFormulaHash ?? createHash("sha256").update(FIXED_FORMULA_VERSION).digest("hex");
  const byIdentity = new Map<string, HistoricalOccurrence>();
  const auditsAtCursor = new Map<string, BacktestAuditRecord[]>();
  for (const record of audits) {
    const key = `${record.tradingDate}|${record.contractSymbol}|${record.evaluatedCandleOpenTime}|${record.direction ?? "unknown"}`;
    auditsAtCursor.set(key, [...(auditsAtCursor.get(key) ?? []), record]);
  }
  const upsert = (identity: string, value: HistoricalOccurrence) => {
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, { ...value, occurrenceId: governedOccurrenceId(value) });
      return;
    }
    const precedence = (setupType: string): number => [
      "ORB_PULLBACK_CONTINUATION",
      "CONSOLIDATION_BREAKOUT_CONTINUATION",
      "EQUIVALENT_CANDLE_REVERSAL",
      "PATIENCE_CANDLE_CONTINUATION",
    ].indexOf(canonicalStrategyId(setupType) ?? setupType);
    const primary = precedence(value.strategyCandidate) < precedence(existing.strategyCandidate) ? value : existing;
    const matches = [...new Set([
      existing.strategyCandidate,
      value.strategyCandidate,
      ...existing.secondaryStrategyMatches,
      ...value.secondaryStrategyMatches,
    ])];
    const merged = {
      ...primary,
      secondaryStrategyMatches: matches.filter((match) => match !== primary.strategyCandidate),
      canonicalTrade: existing.canonicalTrade || value.canonicalTrade,
    };
    byIdentity.set(identity, { ...merged, occurrenceId: governedOccurrenceId(merged) });
  };
  for (const record of audits) {
    const trade = tradeForRecord(record, trades);
    const cursor = record.evaluatedCandleOpenTime;
    const auditKey = `${record.tradingDate}|${record.contractSymbol}|${cursor}|${record.direction ?? "unknown"}`;
    const secondary = (auditsAtCursor.get(auditKey) ?? [])
      .filter((candidate) => candidate.id !== record.id && candidate.decision === "SETUP QUALIFIED")
      .map((candidate) => canonicalStrategyId(candidate.setupType) ?? candidate.setupType);
    for (const event of record.pullbackOccurrences ?? []) {
      const identity = [
        "pullback",
        fingerprint,
        formulaHash,
        FIXED_FORMULA_VERSION,
        record.tradingDate,
        record.contractSymbol,
        record.direction ?? "absent",
        pullbackEventId(event),
        event.candle ? new Date(event.candle.openTime).toISOString() : event.time,
        event.type,
      ].join("|");
      const id = occurrenceId(identity);
      const evidence = levelEvidence([event]);
      upsert(identity, {
        occurrenceId: id,
        auditId: record.id,
        kind: "pullback",
        strategyCandidate: canonicalStrategyId(record.setupType) ?? record.setupType,
        secondaryStrategyMatches: secondary,
        tradingDate: record.tradingDate,
        contractSymbol: record.contractSymbol,
        contractMonth: record.contractMonth,
        direction: record.direction,
        lTimestamp: event.candle ? new Date(event.candle.openTime).toISOString() : event.time,
        lEventId: pullbackEventId(event),
        lInteractionType: event.type,
        lCandle: occurrenceCandle(event.candle),
        previousComparisonTimestamp: null,
        patienceTimestamp: null,
        patienceCandle: null,
        candidateShapeResult: null,
        expectedEntryTimestamp: null,
        confirmationThreshold: null,
        confirmationExcursion: null,
        entryTimestamp: null,
        entryCandle: null,
        levelIdentifiers: evidence.identifiers,
        levelValues: evidence.values,
        levelDistancesTicks: evidence.distancesTicks,
        levelTolerancePoints: evidence.tolerancePoints,
        levelToleranceTicks: evidence.toleranceTicks,
        levelInteractionTypes: evidence.interactionTypes,
        confirmationBufferTicks: null,
        nextObservedCandle: null,
        consolidationThresholds: record.consolidationThresholds,
         status: "EDGE_FOUND",
        reasonCode: event.detail,
        evaluationCursor: cursor,
        formulaVersion: FIXED_FORMULA_VERSION,
        formulaHash,
        sourceFingerprint: fingerprint,
        canonicalTrade: false,
      });
    }
    for (const patience of record.patienceOccurrences ?? []) {
      const linkedEvents = linkedPullbackEvents(record, patience);
      const linkedPullback = linkedEvents[0];
      const linkedEvidence = levelEvidence(linkedEvents);
      const expectedEntryCandleOpenTime = patience.expectedEntryCandleOpenTime ?? patience.patienceCandle.closeTime;
      const outcomeStatus = (patience.outcomeStatus === "CONFIRMED" ? "SIGNAL_CONFIRMED" : patience.outcomeStatus) ?? (
        patience.status === "ENTRY_TRIGGERED"
           ? "SIGNAL_CONFIRMED"
          : patience.status === "OPPOSITE_SIDE_INVALIDATION"
            ? "EXPIRED_WRONG_DIRECTION"
            : patience.status === "PATIENCE_CANDLE_EXPIRED"
              ? "EXPIRED_NO_IMMEDIATE_CONFIRMATION"
              : patience.status === "AMBIGUOUS_EVENT_ORDER"
                ? "INVALIDATED"
                : "CANDIDATE"
      );
      const observedImmediate = patience.triggerCandle?.isComplete
        ? patience.triggerCandle
        : patience.nextObservedCandle ?? null;
       const confirmedEntry = outcomeStatus === "SIGNAL_CONFIRMED"
        && patience.triggerCandle?.isComplete
        && patience.triggerCandle.openTime === expectedEntryCandleOpenTime
        ? patience.triggerCandle
        : null;
      const confirmationThreshold = patience.confirmationThreshold ?? (
        patience.direction === "long"
          ? patience.patienceCandle.high + patience.entryBufferTicks * 0.25
          : patience.patienceCandle.low - patience.entryBufferTicks * 0.25
      );
      const confirmationExcursion = patience.actualConfirmationExcursion ?? (
        observedImmediate
          ? patience.direction === "long"
            ? Math.max(0, observedImmediate.high - patience.patienceCandle.high)
            : Math.max(0, patience.patienceCandle.low - observedImmediate.low)
          : null
      );
      const linkedTrade = trade
        && confirmedEntry
        && trade.audit?.patienceCandleOpenTime === new Date(patience.patienceCandle.openTime).toISOString()
        && trade.audit?.triggerCandleOpenTime === new Date(confirmedEntry.openTime).toISOString()
        ? trade
        : undefined;
      const identity = [
        "patience",
        fingerprint,
        formulaHash,
        FIXED_FORMULA_VERSION,
        record.tradingDate,
        record.contractSymbol,
        patience.direction,
        linkedPullback ? pullbackEventId(linkedPullback) : patience.eligibilityEventId ?? "absent",
        linkedPullback?.candle ? new Date(linkedPullback.candle.openTime).toISOString() : linkedPullback ? new Date(linkedPullback.time).toISOString() : "absent",
        new Date(patience.patienceCandle.openTime).toISOString(),
        new Date(expectedEntryCandleOpenTime).toISOString(),
        confirmedEntry ? new Date(confirmedEntry.openTime).toISOString() : "absent",
        outcomeStatus,
      ].join("|");
      const id = occurrenceId(identity);
      upsert(identity, {
        occurrenceId: id,
        auditId: record.id,
        kind: "patience",
        strategyCandidate: canonicalStrategyId(record.setupType) ?? record.setupType,
        secondaryStrategyMatches: secondary,
        tradingDate: record.tradingDate,
        contractSymbol: record.contractSymbol,
        contractMonth: record.contractMonth,
        direction: patience.direction,
        lTimestamp: linkedPullback?.candle ? new Date(linkedPullback.candle.openTime).toISOString() : linkedPullback ? new Date(linkedPullback.time).toISOString() : null,
        lEventId: linkedPullback ? pullbackEventId(linkedPullback) : patience.eligibilityEventId ?? null,
        lInteractionType: linkedPullback?.type ?? null,
        lCandle: occurrenceCandle(linkedPullback?.candle),
        previousComparisonTimestamp: new Date(patience.previousComparisonTimestamp ?? patience.previousCandle.openTime).toISOString(),
        patienceTimestamp: new Date(patience.patienceCandle.openTime).toISOString(),
        patienceCandle: occurrenceCandle(patience.patienceCandle),
        candidateShapeResult: patience.candidateShapeResult ?? true,
        expectedEntryTimestamp: new Date(expectedEntryCandleOpenTime).toISOString(),
        confirmationThreshold,
        confirmationExcursion,
        entryTimestamp: confirmedEntry ? new Date(confirmedEntry.openTime).toISOString() : null,
        entryCandle: occurrenceCandle(confirmedEntry),
        levelIdentifiers: linkedEvidence.identifiers,
        levelValues: linkedEvidence.values,
        levelDistancesTicks: linkedEvidence.distancesTicks,
        levelTolerancePoints: linkedEvidence.tolerancePoints,
        levelToleranceTicks: linkedEvidence.toleranceTicks,
        levelInteractionTypes: linkedEvidence.interactionTypes,
        confirmationBufferTicks: record.confirmationBufferTicks ?? 4,
        nextObservedCandle: occurrenceCandle(confirmedEntry ? null : observedImmediate),
        consolidationThresholds: record.consolidationThresholds,
        status: outcomeStatus,
        reasonCode: patience.reasonCode,
        evaluationCursor: new Date(patience.evaluationCursor).toISOString(),
        formulaVersion: FIXED_FORMULA_VERSION,
        formulaHash,
        sourceFingerprint: fingerprint,
        canonicalTrade: linkedTrade !== undefined,
         ...(linkedTrade ? {
           primaryEdge: linkedTrade.primaryEdge ?? linkedTrade.setupType,
           matchedEdges: linkedTrade.matchedEdges ?? [linkedTrade.setupType],
           supportingConfluences: linkedTrade.supportingConfluences ?? [],
           setupGrade: linkedTrade.setupGrade ?? "A",
           entryPrice: linkedTrade.entryPrice,
           patienceEntryPrice: linkedTrade.audit?.entryTriggerPrice ?? null,
           confirmationEntryPrice: linkedTrade.entryPrice,
         } : {}),
         ...(outcomeStatus !== "CANDIDATE"
            ? { signalStatus: outcomeStatus === "SIGNAL_CONFIRMED" ? "SIGNAL_CONFIRMED" as const : "ENTRY_CONFIRMATION_FAILED" as const }
           : {}),
         ...(patience.eligibilityArmId ? { eligibilityArmId: patience.eligibilityArmId } : {}),
         ...(patience.eligibilityArmState ? { eligibilityArmState: patience.eligibilityArmState } : {}),
         ...(patience.eligibilityArmStateReason ? { eligibilityArmStateReason: patience.eligibilityArmStateReason } : {}),
         ...(patience.eligibilityProvenance ? {
           eligibilityProvenance: {
             ...patience.eligibilityProvenance,
             time: new Date(patience.eligibilityProvenance.time).toISOString(),
           },
         } : {}),
      });
    }
    if (record.patienceState === "ENTRY_TRIGGERED" || record.rejectionCategory === "RISK_REJECTION" || trade) {
      const identity = [
        "decision",
        fingerprint,
        formulaHash,
        FIXED_FORMULA_VERSION,
        record.tradingDate,
        record.contractSymbol,
        record.direction ?? "absent",
        record.id,
        record.patienceCandleOpenTime ?? "absent",
        record.patienceCandleCloseTime ?? "absent",
        record.triggerCandleOpenTime ?? "absent",
        record.patienceState ?? "absent",
        record.rejectionCategory ?? "absent",
        trade?.id ?? "none",
      ].join("|");
       const decisionStatus: HistoricalOccurrence["status"] = trade
         ? (trade.outcome === "open" ? "TRADE_TAKEN" : "TRADE_OUTCOME")
         : record.patienceState === "ENTRY_TRIGGERED"
           ? "SIGNAL_CONFIRMED"
           : "PATIENCE_FOUND";
      upsert(identity, {
        occurrenceId: occurrenceId(identity),
        auditId: record.id,
         kind: trade ? "trade" : "patience",
        strategyCandidate: canonicalStrategyId(record.setupType) ?? record.setupType,
        secondaryStrategyMatches: secondary,
        tradingDate: record.tradingDate,
        contractSymbol: record.contractSymbol,
        contractMonth: record.contractMonth,
        direction: record.direction,
        lTimestamp: null,
        lEventId: null,
        lInteractionType: null,
        lCandle: null,
        previousComparisonTimestamp: null,
        patienceTimestamp: record.patienceCandleOpenTime,
        patienceCandle: record.patienceCandle,
        candidateShapeResult: record.patienceCandle !== null,
        expectedEntryTimestamp: record.patienceCandleCloseTime,
        confirmationThreshold: record.entryTriggerPrice,
        confirmationExcursion: null,
        entryTimestamp: record.triggerCandleOpenTime,
        entryCandle: record.triggerCandle,
        levelIdentifiers: [],
        levelValues: {},
        levelDistancesTicks: {},
        levelTolerancePoints: {},
        levelToleranceTicks: {},
        levelInteractionTypes: {},
        confirmationBufferTicks: record.confirmationBufferTicks ?? 4,
        nextObservedCandle: null,
        consolidationThresholds: record.consolidationThresholds,
        status: decisionStatus,
        reasonCode: record.rejectionSummary ?? record.decision,
        evaluationCursor: cursor,
        formulaVersion: FIXED_FORMULA_VERSION,
        formulaHash,
        sourceFingerprint: fingerprint,
        canonicalTrade: trade !== undefined,
         ...(trade ? {
           primaryEdge: trade.primaryEdge ?? trade.setupType,
           matchedEdges: trade.matchedEdges ?? [trade.setupType],
           supportingConfluences: trade.supportingConfluences ?? [],
           setupGrade: trade.setupGrade ?? "A",
           entryPrice: trade.entryPrice,
           patienceEntryPrice: trade.audit?.entryTriggerPrice ?? null,
           confirmationEntryPrice: trade.entryPrice,
         } : {}),
      });
    }
  }
  const stageRank: Record<HistoricalOccurrence["kind"], number> = { pullback: 0, patience: 1, risk: 2, trade: 3 };
  return [...byIdentity.values()].sort((first, second) => {
    const firstTime = first.lTimestamp ?? first.patienceTimestamp ?? first.entryTimestamp ?? first.evaluationCursor;
    const secondTime = second.lTimestamp ?? second.patienceTimestamp ?? second.entryTimestamp ?? second.evaluationCursor;
    return `${first.tradingDate}|${firstTime}|${first.patienceTimestamp ?? "absent"}|${stageRank[first.kind]}|${first.occurrenceId}`
      .localeCompare(`${second.tradingDate}|${secondTime}|${second.patienceTimestamp ?? "absent"}|${stageRank[second.kind]}|${second.occurrenceId}`);
  });
}

function candidateDimensionValue(
  candidate: QualificationCandidate,
  dimension: QualificationFunnelComparison["dimension"],
): string {
  switch (dimension) {
    case "contract": return candidate.contractSymbol;
    case "month": return candidate.contractMonth;
    case "direction": return candidate.direction ?? "unknown";
    case "period": return candidate.period;
    case "market_regime": return candidate.marketRegime;
    case "volume_regime": return candidate.volumeRegime;
  }
}

function funnelStageCounts(
  candidates: readonly QualificationCandidate[],
  sessionCount: number,
  useCandidateSessionDenominator = false,
): QualificationFunnelStageCount[] {
  const candidateSessionCount = new Set(candidates.map((candidate) => `${candidate.tradingDate}|${candidate.contractSymbol}`)).size;
  const sessionDenominator = useCandidateSessionDenominator ? candidateSessionCount : sessionCount;
  return QUALIFICATION_FUNNEL_STAGES.map((stage, index) => {
    const count = candidates.filter((candidate) => stageRank(candidate.reachedStage) >= index).length;
    const preceding = index === 0
      ? candidates.length
      : candidates.filter((candidate) => stageRank(candidate.reachedStage) >= index - 1).length;
    const reachedSessions = new Set(
      candidates
        .filter((candidate) => stageRank(candidate.reachedStage) >= index)
        .map((candidate) => `${candidate.tradingDate}|${candidate.contractSymbol}`),
    ).size;
    return {
      stage,
      count,
      percentOfPreceding: preceding === 0 ? 0 : Number(((count / preceding) * 100).toFixed(1)),
      percentOfSessions: sessionDenominator === 0 ? 0 : Number(((reachedSessions / sessionDenominator) * 100).toFixed(1)),
    };
  });
}

export function buildQualificationFunnel(
  reports: readonly (Pick<BacktestReport, "audit" | "trades" | "dataset" | "contract"> & Partial<Pick<BacktestReport, "occurrences">>)[],
): QualificationFunnel {
  const allAudits = reports.flatMap((report) => report.audit);
  const allTrades = reports.flatMap((report) => report.trades);
  // Every completed causal evaluation is an independent funnel occurrence.
  // Do not select the strongest/latest record: later qualification failure
  // must not erase an earlier pullback or patience observation.
  const occurrenceRecords = [...new Map(
    allAudits.map((record) => [candidateKey(record), record]),
  ).values()];

  const sessionKeys = new Set<string>();
  for (const report of reports) {
    for (const date of report.dataset.selectedDates) {
      const activeContract = report.dataset.activeContractByDate?.find((item) => item.tradingDate === date)?.contractSymbol
        ?? report.trades.find((trade) => trade.tradingDate === date)?.contractSymbol
        ?? report.audit.find((record) => record.tradingDate === date)?.contractSymbol
        ?? report.contract.fullContractSymbol;
      sessionKeys.add(`${date}|${activeContract}`);
    }
  }

  const candidates = occurrenceRecords
    .sort((first, second) => candidateKey(first).localeCompare(candidateKey(second)))
    .map((record): QualificationCandidate => {
      const trade = tradeForRecord(record, allTrades);
      const flags = stageEvidence(record, trade);
      const reachedStage = contiguousStage(flags);
      const firstRejectedIndex = flags.findIndex((passed, index) => index > 0 && !passed);
      const primaryRejectionStage = firstRejectedIndex < 0 || trade
        ? null
        : QUALIFICATION_FUNNEL_STAGES[firstRejectedIndex];
      const evaluatedTime = Date.parse(record.evaluatedCandleOpenTime);
      const hourTime = Number.isFinite(evaluatedTime) ? timeOfDay(evaluatedTime) : "close";
      const marketRegime: BacktestSegmentation["marketRegime"] = /^neutral:/i.test(record.trendEvidence)
        ? "range"
        : /reversal|warning|transition/i.test(`${record.trendEvidence} ${record.volumeEvidence}`)
          ? "transition"
          : "trend";
      const volumeRegime: "normal" | "high" = /supported|high volume|confirmed/i.test(record.volumeEvidence)
        ? "high"
        : "normal";
      return {
        candidateId: candidateKey(record),
        tradingDate: record.tradingDate,
        contractSymbol: record.contractSymbol,
        contractMonth: record.contractMonth,
        period: record.period,
        direction: record.direction,
        setupType: record.setupType,
        timeOfDay: hourTime,
        marketRegime,
        volumeRegime,
        reachedStage,
        primaryRejectionStage,
        rejectionDetail: primaryRejectionStage ? record.rejectionSummary ?? record.rejectionReason : null,
        evidence: {
          evaluatedCandleOpenTime: record.evaluatedCandleOpenTime,
          orbLevels: record.orbState,
          breakout: record.breakoutEvidence,
          volume: record.volumeEvidence,
          pullback: record.pullbackEvidence,
          criticalLevel: record.criticalLevelEvidence,
          trend: record.trendEvidence,
          patience: record.patienceState,
          trigger: record.triggerCandle ? "Entry candle (E) completed." : "No completed immediate-next entry candle.",
          patienceCandle: record.patienceCandle,
          triggerCandle: record.triggerCandle,
          patienceCandleOpenTime: record.patienceCandleOpenTime,
          patienceCandleCloseTime: record.patienceCandleCloseTime,
          triggerCandleOpenTime: record.triggerCandleOpenTime,
          triggerCandleCloseTime: record.triggerCandleCloseTime,
          entryTriggerPrice: record.entryTriggerPrice,
          strategyStopPrice: record.strategyStopPrice,
          catastropheStopPrice: record.catastropheStopPrice,
          targetPrice: record.targetPrice,
          decision: record.decision,
          rejectionCategory: record.rejectionCategory,
          ruleEvidence: [...record.ruleEvidence],
          finalOutcome: trade?.outcome ?? null,
          exitCandleOpenTime: trade?.audit?.exitCandleOpenTime ?? record.exitCandleOpenTime,
          exitCandleCloseTime: trade?.audit?.exitCandleCloseTime ?? record.exitCandleCloseTime,
          netPnl: trade?.netPnl ?? record.netPnl,
        },
      };
    });
  const stages = funnelStageCounts(candidates, sessionKeys.size);
  const dimensions: QualificationFunnelComparison["dimension"][] = [
    "contract", "month", "direction", "period", "market_regime", "volume_regime",
  ];
  const comparisons = dimensions.flatMap((dimension) => {
    const values = [...new Set(candidates.map((candidate) => candidateDimensionValue(candidate, dimension)))].sort();
    return values.map((value) => {
      const matching = candidates.filter((candidate) => candidateDimensionValue(candidate, dimension) === value);
      return {
        dimension,
        value,
        candidateCount: matching.length,
        stageCounts: funnelStageCounts(matching, sessionKeys.size, true),
      };
    });
  });
  const rejectionCounts = QUALIFICATION_FUNNEL_STAGES
    .map((stage) => ({ stage, count: candidates.filter((candidate) => candidate.primaryRejectionStage === stage).length }))
    .filter((item) => item.count > 0);
  return {
    sessionCount: sessionKeys.size,
    candidateCount: candidates.length,
    occurrenceCount: reports.reduce((total, report) => total + (report.occurrences?.length ?? 0), 0),
    stages,
    rejectionCounts,
    comparisons,
    candidates,
  };
}

export function runCausalBacktest(
  request: BacktestRequest,
  riskInput?: { accountSize: number; riskPercent: number; maxDailyLoss: number; dailyLossUsed: number; isLocked: boolean },
  providedDataset?: CausalReplayDataset,
): BacktestReport {
  const specification = getFuturesContractSpecification(request.symbol);
  const activeStrategy = activeShadowStrategySnapshot();
  const governedConsolidation = consolidationThresholds(activeStrategy.config);
  const calendar = sessionCalendarForContract(specification);
  const dataset = providedDataset ?? buildReplayDataset(request.symbol, request);
  const executionMode = request.executionMode
    ?? (dataset.quotesAvailable === false ? "ohlcv_modeled" : "quote_based_shadow");
  if (executionMode === "quote_based_shadow" && dataset.quotesAvailable === false) {
    throw new Error("Quote-based Shadow execution requires genuine bid/ask data; this dataset is OHLCV-only.");
  }
  if (executionMode === "ohlcv_modeled"
    && !["historical_databento", "historical_databento_multicontract"].includes(dataset.source ?? "")
    && dataset.quotesAvailable !== false) {
    throw new Error("Modeled OHLCV execution is reserved for explicitly historical OHLCV datasets.");
  }
  const entryBufferTicks = request.ohlcvEntryBufferTicks ?? 4;
  const stopBufferTicks = request.ohlcvStopBufferTicks ?? 1;
  const modeledSlippageTicks = request.ohlcvSlippageTicks ?? 1;
  const commissionPerContract = request.ohlcvCommissionPerContract
    ?? 2 * (specification.commissionPerContract + specification.exchangeAndRegulatoryFeesPerContract);
  const candles = sortedCandles(dataset.candles);
  const ticks = dataset.ticks ?? [];
  const oneMinute = dataset.oneMinute ?? candles.flatMap(buildSyntheticOneMinuteBars);
  const candleIndexByOpenTime = new Map(candles.map((item, index) => [item.openTime, index]));
  const replayIndexes = buildReplayIndexes(candles, ticks, oneMinute, calendar);
  const finalRegularIndexByContractDate = new Map<string, number>();
  for (const [index, item] of candles.entries()) {
    const date = tradingDateForTimestamp(item.openTime, calendar);
    const window = sessionWindow(date, "regular", calendar);
    if (item.isComplete && window && item.openTime >= window.openTime && item.closeTime <= window.closeTime) {
      finalRegularIndexByContractDate.set(`${item.contractSymbol}:${date}`, index);
    }
  }
  const rejectedByPeriod = { in_sample: 0, out_of_sample: 0 };
  const trades: BacktestTrade[] = [];
  const audit: BacktestAuditRecord[] = [];
  const historicalContractSymbol = dataset.source === "historical_databento" || dataset.source === "historical_databento_multicontract"
    ? dataset.contractSymbol
    : specification.fullContractSymbol;
  const reportContract = dataset.source === "historical_databento" || dataset.source === "historical_databento_multicontract"
    ? { ...specification, fullContractSymbol: dataset.contractSymbol }
    : specification;
  let lastExitIndex = -1;
  const executedEntryKeys = new Set<string>();
  let finalReplay: ReplayCursor = { cursor: 0, visibleCandleCount: 0, visibleCandleCloseTime: null, mode: "replay" };
  let previousContractSymbol: string | null = null;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const currentContractSymbol = dataset.contractSchedule
      ? candle.contractSymbol
      : historicalContractSymbol;
    const currentContractMonth = dataset.contractSchedule
      ? parseMesContractSymbol(currentContractSymbol)?.contractMonth ?? dataset.contractMonth
      : dataset.contractMonth;
    if (dataset.contractSchedule && previousContractSymbol !== null && previousContractSymbol !== currentContractSymbol) {
      // Never carry a position, indicators, or execution state through a
      // scheduled contract boundary.
      lastExitIndex = index - 1;
    }
    previousContractSymbol = currentContractSymbol;
    const contractCandles = dataset.contractSchedule
      ? replayIndexes.candlesByContract.get(currentContractSymbol) ?? []
      : candles;
    const contractCandleIndex = dataset.contractSchedule
      ? replayIndexes.candleIndexByContractOpenTime.get(currentContractSymbol)?.get(candle.openTime) ?? -1
      : candleIndexByOpenTime.get(candle.openTime) ?? -1;
    const visibleContractCandles = contractCandles.slice(0, Math.max(0, contractCandleIndex) + 1);
    const historicalHourly = replayIndexes.hourlyByContract.get(currentContractSymbol)
      ?? replayIndexes.hourlyByContract.get(dataset.contractSchedule ? currentContractSymbol : candle.contractSymbol)
      ?? completedSimulatedHourlyCandles(contractCandles, calendar);
    const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
    const period = periodForDate(tradingDate, dataset);
    const regularWindow = sessionWindow(tradingDate, "regular", calendar);
    if (!regularWindow || candle.openTime < regularWindow.openTime || candle.openTime >= regularWindow.closeTime) continue;
     if (!candle.isComplete || !candle.closeTime) continue;
     const positionActive = lastExitIndex >= index;
    const cursor = {
      cursor: candle.closeTime,
      visibleCandleCount: visibleContractCandles.length,
      visibleCandleCloseTime: visibleContractCandles.at(-1)?.closeTime ?? null,
      mode: "replay" as const,
      candles: visibleContractCandles,
    };
    assertCausalVisibility(cursor.candles, candle.closeTime);
    finalReplay = cursor;
    const snapshot = createMarketSnapshot(
      request.symbol,
      "regular",
      riskInput,
      undefined,
      { targetDollars: request.targetDollars, slippageMode: request.slippageMode },
      {
        tradingDate,
        cursor: candle.closeTime,
        allCandles: visibleContractCandles,
        historicalFeed: visibleContractCandles,
        historicalHourly,
        allCandlesCompleted: true,
        strategyConfigOverrides: activeStrategy.config,
        premarketAvailable: request.premarketAvailable !== false,
        executionMode,
        // The active Shadow configuration is authoritative for ordinary backtests.
        ohlcvStopBufferTicks: executionMode === "ohlcv_modeled" ? stopBufferTicks : undefined,
      },
    );
    const evaluations = snapshot.setupAnalysis.evaluations;
    const evaluationAudits = evaluations.map((evaluation) => {
      const record = auditForEvaluation(
        evaluation,
        snapshot,
        candle,
        tradingDate,
        period,
        executionMode,
        currentContractSymbol,
        currentContractMonth,
        governedConsolidation,
      );
      audit.push(record);
      return record;
    });
    for (const evaluation of evaluations) {
      if (evaluation.decision !== "SETUP QUALIFIED") {
        rejectedByPeriod[period] += 1;
      }
    }
    const selected = ([
      "ORB_PULLBACK_CONTINUATION",
      "CONSOLIDATION_BREAKOUT_CONTINUATION",
      "EQUIVALENT_CANDLE_REVERSAL",
      "PATIENCE_CANDLE_CONTINUATION",
      "PEAK_RETRACEMENT_REVERSAL",
    ] as const)
      .map((setupType) => evaluations.find((evaluation) => evaluation.setupType === setupType && evaluation.decision === "SETUP QUALIFIED" && !evaluation.alertOnly))
      .find((evaluation) => evaluation !== undefined);
    const matchedEdges = evaluations
      .filter((evaluation) => evaluation.decision === "SETUP QUALIFIED" && !evaluation.alertOnly)
      .map((evaluation) => evaluation.setupType);
    const supportingConfluences = selected
      ? selected.rules.filter((item) => item.passed).map((item) => item.label)
      : [];
    const setupGrade: BacktestTrade["setupGrade"] = matchedEdges.length >= 3
      ? "A++"
      : matchedEdges.length === 2 ? "A+" : "A";
    const selectedPatience = selected && ["EQUIVALENT_CANDLE_REVERSAL", "PEAK_RETRACEMENT_REVERSAL"].includes(selected.setupType)
      ? snapshot.reversalPatience ?? snapshot.patience
      : snapshot.patience;
    const selectedAudit = selected
      ? evaluationAudits.find((record) => record.setupType === selected.setupType)
      : undefined;
    if (!selected?.direction) {
      if (selectedAudit) setAuditRejection(
        selectedAudit,
        "NO_QUALIFIED_SETUP",
        "No non-alert qualified setup was available.",
      );
      continue;
    }
     if (positionActive) {
       if (selectedAudit) setAuditRejection(selectedAudit, "POSITION_ACTIVE", "An earlier position remains active; this candle was audited but cannot open an overlapping entry.");
       rejectedByPeriod[period] += 1;
       continue;
     }
    if (executionMode === "ohlcv_modeled") {
       const patienceSummary = selectedPatience?.patienceCandle;
       const triggerSummary = selectedPatience?.triggerCandle;
       const contractCandleIndexByOpenTime = dataset.contractSchedule
         ? replayIndexes.candleIndexByContractOpenTime.get(currentContractSymbol)
         : candleIndexByOpenTime;
       const trigger = triggerSummary
          ? contractCandles[contractCandleIndexByOpenTime?.get(Date.parse(triggerSummary.openTime)) ?? -1]
         : undefined;
       const patienceCandle = patienceSummary
          ? contractCandles[contractCandleIndexByOpenTime?.get(Date.parse(patienceSummary.openTime)) ?? -1]
         : undefined;
      if (!trigger || !patienceCandle || trigger.closeTime > candle.closeTime) {
        if (selectedAudit) setAuditRejection(selectedAudit, "PATIENCE_TRIGGER_NOT_COMPLETED", "The required patience trigger was not complete at this candle.");
        rejectedByPeriod[period] += 1;
        continue;
      }
        const entry = selectedPatience?.entryBufferPrice
         ?? snapshot.riskPlan.entry
         ?? (selected.direction === "long"
           ? patienceCandle.high + entryBufferTicks * specification.tickSize
           : patienceCandle.low - entryBufferTicks * specification.tickSize);
       const strategyStop = selectedPatience?.strategyStopPrice
         ?? snapshot.riskPlan.strategyStop
         ?? (selected.direction === "long"
           ? patienceCandle.low - stopBufferTicks * specification.tickSize
           : patienceCandle.high + stopBufferTicks * specification.tickSize);
       const target = snapshot.riskPlan.target
         ?? targetPriceForDollars(selected.direction, entry, request.targetDollars ?? 75, specification);
       const contracts = Math.max(1, snapshot.riskPlan.contracts);
       const entryKey = `${currentContractSymbol}|${tradingDate}|${selected.direction}|${trigger.openTime}|${Math.round(entry / specification.tickSize)}`;
       if (executedEntryKeys.has(entryKey)) continue;
       const entryResolution = resolveEntryAndInvalidation({
        direction: selected.direction,
        candle: trigger,
         entry,
         invalidation: strategyStop,
        sequenceKnown: false,
      });
      if (entryResolution.status === "ambiguous") {
        if (selectedAudit) {
          setAuditRejection(selectedAudit, entryResolution.label, entryResolution.detail);
          selectedAudit.ambiguityLabels = [entryResolution.label ?? "AMBIGUOUS_ENTRY_INVALIDATION"];
        }
        rejectedByPeriod[period] += 1;
        continue;
      }
        const triggerIndex = contractCandleIndexByOpenTime?.get(trigger.openTime) ?? -1;
        const regularKey = `${currentContractSymbol}:${tradingDate}`;
        const regularCandles = replayIndexes.regularCandlesByContractDate.get(regularKey) ?? [];
        const regularIndex = replayIndexes.regularIndexByContractOpenTime.get(regularKey)?.get(trigger.openTime) ?? -1;
        const postTrigger = regularIndex >= 0
          ? regularCandles.slice(regularIndex + 1)
          : contractCandles
            .slice(triggerIndex + 1)
            .filter((item) => tradingDateForTimestamp(item.openTime, calendar) === tradingDate
              && item.isComplete
              && item.closeTime <= regularWindow.closeTime);
        const sessionCloseCandle = regularCandles.at(-1)
          ?? contractCandles
            .filter((item) => item.isComplete
              && tradingDateForTimestamp(item.openTime, calendar) === tradingDate
              && item.openTime >= regularWindow.openTime
              && item.closeTime <= regularWindow.closeTime)
            .at(-1);
      const modeled = simulateOhlcvExecution({
        direction: selected.direction,
         entry,
        patienceCandle,
        immediateTriggerCandle: trigger,
        subsequentCompletedCandles: postTrigger,
         contracts,
         targetQuantity: 1,
         target,
         strategyStop,
         catastropheStop: snapshot.riskPlan.catastropheStop,
        sessionCloseCandle,
        tickSize: specification.tickSize,
        tickValue: specification.dollarValuePerTick,
        pointMultiplier: specification.pointValue * specification.contractMultiplier,
        entrySlippageTicks: modeledSlippageTicks,
        exitSlippageTicks: modeledSlippageTicks,
        fees: request.ohlcvCommissionPerContract === undefined
          ? {
              commission: specification.commissionPerContract,
              exchange: specification.exchangeFeePerContract ?? specification.exchangeAndRegulatoryFeesPerContract,
              regulatory: specification.regulatoryFeePerContract,
              clearing: specification.clearingFeePerContract,
            }
          : { commission: request.ohlcvCommissionPerContract / 2 },
      });
       if (modeled.modeledFill === null) {
         if (selectedAudit) setAuditRejection(selectedAudit, "NO_MODELED_FILL", "The confirmed entry did not produce a finite OHLCV trigger fill.");
        continue;
      }
       const isOpen = modeled.exitPrice === null || !modeled.legs.length;
       const exitCandle = modeled.audit.exitCandle ?? trigger;
      const outcome = modeled.exitReason === "target"
        ? "target"
        : modeled.exitReason === "stop"
          ? modeled.audit.stopLevel === "catastrophe" ? "catastrophe stop" : "strategy stop"
           : modeled.exitReason === "session_close" ? "session close" : isOpen ? "open" : "manual";
       const ambiguityLabel = modeled.ambiguityLabels.find(isExecutionAmbiguityLabel) ?? null;
      const segment = segmentation(snapshot, selected.setupType, selected.direction, trigger, currentContractSymbol, currentContractMonth);
      trades.push({
        id: `${tradingDate}-${triggerIndex}-${selected.setupType}-ohlcv`,
        tradingDate,
        contractSymbol: currentContractSymbol,
        contractMonth: currentContractMonth,
        period,
        setupType: selected.setupType,
        direction: selected.direction,
         entryTime: new Date(trigger.closeTime).toISOString(),
          exitTime: isOpen ? null : new Date(exitCandle.closeTime ?? trigger.closeTime).toISOString(),
        entryPrice: modeled.modeledFill,
          exitPrice: modeled.exitPrice,
         contracts,
        grossPnl: modeled.accounting.grossPnl,
        fees: modeled.accounting.fees,
        slippage: modeled.accounting.slippage,
        netPnl: modeled.accounting.netPnl,
        outcome,
        ambiguityLabel,
        source: "ohlc",
        segmentation: segment,
        executionMode,
        fillLabel: MODELED_OHLCV_FILL_LABEL,
         primaryEdge: selected.setupType,
         matchedEdges,
         supportingConfluences,
         setupGrade,
         patienceCandle: occurrenceCandle(patienceCandle),
         entryCandle: occurrenceCandle(trigger),
        audit: {
          entryTriggerPrice: modeled.entryTrigger,
          modeledFillPrice: modeled.modeledFill,
          stopPrice: modeled.stopPrice,
          strategyStopPrice: modeled.audit.strategyStopPrice,
          catastropheStopPrice: modeled.audit.catastropheStopPrice,
          stopLevel: modeled.audit.stopLevel,
          targetPrice: modeled.targetPrice,
           patienceCandleOpenTime: patienceCandle.openTime === undefined ? null : new Date(patienceCandle.openTime).toISOString(),
           patienceCandleCloseTime: patienceCandle.closeTime === undefined ? null : new Date(patienceCandle.closeTime).toISOString(),
           triggerCandleOpenTime: trigger.openTime === undefined ? null : new Date(trigger.openTime).toISOString(),
           triggerCandleCloseTime: trigger.closeTime === undefined ? null : new Date(trigger.closeTime).toISOString(),
           modeledFillObservationTime: trigger.closeTime === undefined ? null : new Date(trigger.closeTime).toISOString(),
          exitCandleOpenTime: exitCandle.openTime === undefined ? null : new Date(exitCandle.openTime).toISOString(),
           exitCandleCloseTime: exitCandle.closeTime === undefined ? null : new Date(exitCandle.closeTime).toISOString(),
          assumptions: modeled.assumptions,
           eventLabels: modeled.eventLabels,
          ambiguityLabels: modeled.ambiguityLabels,
          targetHit: modeled.audit.targetHit,
          runnerActivated: modeled.audit.runnerActivated,
          runnerExited: modeled.audit.runnerExited,
          runnerReferencePrice: modeled.audit.runnerReferencePrice ?? null,
          runnerImpulse: modeled.audit.runnerImpulse ?? null,
          runnerMostFavorablePrice: modeled.audit.runnerMostFavorablePrice ?? null,
          remainingQuantity: modeled.audit.remainingQuantity,
          exitReason: modeled.exitReason,
          legs: modeled.legs,
        },
      });
      executedEntryKeys.add(entryKey);
      if (selectedAudit) {
        setAuditRejection(selectedAudit, null);
         selectedAudit.eventLabels = modeled.eventLabels;
         selectedAudit.ambiguityLabels = modeled.ambiguityLabels;
        selectedAudit.modeledFillObservationTime = new Date(trigger.closeTime).toISOString();
        selectedAudit.exitCandleOpenTime = exitCandle.openTime === undefined ? null : new Date(exitCandle.openTime).toISOString();
         selectedAudit.exitCandleCloseTime = exitCandle.closeTime === undefined ? null : new Date(exitCandle.closeTime).toISOString();
        selectedAudit.fees = modeled.accounting.fees;
        selectedAudit.slippage = modeled.accounting.slippage;
        selectedAudit.grossPnl = modeled.accounting.grossPnl;
        selectedAudit.netPnl = modeled.accounting.netPnl;
        selectedAudit.exitReason = modeled.exitReason;
      }
       lastExitIndex = Math.max(lastExitIndex, candleIndexByOpenTime.get(exitCandle.openTime ?? candle.openTime) ?? index);
      continue;
    }
    const entryReference = snapshot.riskPlan.entry ?? candle.close;
    const entryResolution = resolveEntryAndInvalidation({
      direction: selected.direction,
      candle,
      entry: entryReference,
      invalidation: snapshot.riskPlan.strategyStop,
      sequenceKnown: true,
    });
    if (entryResolution.status === "ambiguous") {
      if (selectedAudit) {
        selectedAudit.rejectionReason = entryResolution.label;
        selectedAudit.rejectionCategory = "AMBIGUITY";
        selectedAudit.rejectionSummary = entryResolution.detail;
        selectedAudit.ambiguityLabels = [entryResolution.label ?? "AMBIGUOUS_ENTRY_INVALIDATION"];
      }
      rejectedByPeriod[period] += 1;
      continue;
    }
    let exitIndex = index + 1;
    let resolution: IntrabarResolution = { status: "open", source: "ohlc", timestamp: null, price: null, ambiguityLabel: null, detail: "Trade remains open." };
    const finalRegularIndex = finalRegularIndexByContractDate.get(`${currentContractSymbol}:${tradingDate}`) ?? index;
    for (; exitIndex <= finalRegularIndex; exitIndex += 1) {
      const next = candles[exitIndex];
      resolution = resolveIntrabarOutcome({
        direction: selected.direction,
        target: snapshot.riskPlan.target,
        stop: snapshot.riskPlan.catastropheStop ?? snapshot.riskPlan.strategyStop,
        candle: next,
        ticks: replayIndexes.ticksByCandleOpenTime.get(next.openTime),
        oneMinute: replayIndexes.oneMinuteByContractCandle.get(`${currentContractSymbol}:${next.openTime}`),
      });
      if (resolution.status !== "open") break;
    }
    if (resolution.status === "open") exitIndex = finalRegularIndex;
    const exitCandle = candles[Math.min(exitIndex, candles.length - 1)] ?? candle;
    const exitReference = resolution.price ?? exitCandle.close;
    const simulated = simulatePhase8ShadowExecution({
      direction: selected.direction,
      entryQuote: candle,
      exitQuote: { ...exitCandle, bid: exitCandle.bid, ask: exitCandle.ask },
      entryReferencePrice: entryReference,
      exitReferencePrice: exitReference,
      currentPrice: exitReference,
      high: exitReference,
      low: exitReference,
      contracts: snapshot.riskPlan.contracts,
      targetContracts: snapshot.riskPlan.targetContracts,
      runnerContracts: snapshot.riskPlan.runnerContracts,
      target: resolution.status === "target" ? snapshot.riskPlan.target : null,
      strategyStop: resolution.status === "stop" ? snapshot.riskPlan.strategyStop : null,
      catastropheStop: resolution.status === "stop" ? snapshot.riskPlan.catastropheStop : null,
      specification,
      slippageMode: request.slippageMode,
      observedSpreadTicks: (candle.ask - candle.bid) / specification.tickSize,
    });
     const resolvedStop = resolution.status === "stop" || resolution.status === "ambiguous";
     const outcome = resolution.status === "target"
      ? "target"
       : resolvedStop
        ? snapshot.riskPlan.catastropheStop !== null ? "catastrophe stop" : "strategy stop"
        : "session close";
     const eventLabels = resolution.status === "target"
       ? ["TARGET_REACHED"]
       : resolvedStop
         ? ["STRATEGY_STOP_REACHED", ...(snapshot.riskPlan.catastropheStop !== null ? ["CATASTROPHE_STOP_REACHED"] : []), ...(resolution.status === "ambiguous" ? ["AMBIGUOUS_STOP_FIRST"] : [])]
         : ["SESSION_CLOSE"];
     const ambiguityLabels = resolution.ambiguityLabel ? [resolution.ambiguityLabel] : [];
    const segment = segmentation(snapshot, selected.setupType, selected.direction, candle, currentContractSymbol, currentContractMonth);
    trades.push({
      id: `${tradingDate}-${index}-${selected.setupType}`,
      tradingDate,
      contractSymbol: currentContractSymbol,
      contractMonth: currentContractMonth,
      period,
      setupType: selected.setupType,
      direction: selected.direction,
      entryTime: new Date(candle.closeTime).toISOString(),
      exitTime: new Date(resolution.timestamp ?? exitCandle.closeTime).toISOString(),
      entryPrice: simulated.entryFillPrice,
      exitPrice: simulated.exitFillPrice ?? exitReference,
      contracts: simulated.contracts,
      grossPnl: simulated.accounting.grossPnl,
      fees: simulated.accounting.fees,
      slippage: simulated.accounting.slippage,
      netPnl: simulated.accounting.netPnl,
      outcome,
       ambiguityLabel: resolution.ambiguityLabel,
      source: resolution.source,
      segmentation: segment,
      executionMode,
      fillLabel: "Quote-based Shadow fill",
       audit: {
         entryTriggerPrice: entryReference,
         modeledFillPrice: simulated.entryFillPrice,
         stopPrice: snapshot.riskPlan.catastropheStop ?? snapshot.riskPlan.strategyStop,
         targetPrice: snapshot.riskPlan.target,
         strategyStopPrice: snapshot.riskPlan.strategyStop,
         catastropheStopPrice: snapshot.riskPlan.catastropheStop,
         stopLevel: resolvedStop ? snapshot.riskPlan.catastropheStop !== null ? "catastrophe" : "strategy" : null,
         patienceCandleOpenTime: null,
         patienceCandleCloseTime: null,
         triggerCandleOpenTime: new Date(candle.openTime).toISOString(),
         triggerCandleCloseTime: new Date(candle.closeTime).toISOString(),
         modeledFillObservationTime: null,
         exitCandleOpenTime: new Date(exitCandle.openTime).toISOString(),
         exitCandleCloseTime: new Date(exitCandle.closeTime).toISOString(),
         assumptions: ["Quote-based Shadow fill uses genuine bid/ask observations."],
         eventLabels,
         ambiguityLabels,
         targetHit: resolution.status === "target",
         runnerActivated: false,
         runnerExited: false,
         runnerReferencePrice: null,
         runnerImpulse: null,
         runnerMostFavorablePrice: null,
         remainingQuantity: 0,
         exitReason: resolution.status === "ambiguous" ? "stop" : resolution.status,
         legs: [],
       },
    });
    lastExitIndex = Math.min(exitIndex, candles.length - 1);
  }

  if (candles.length) {
    finalReplay = createCausalReplay(dataset, candles.at(-1)!.closeTime);
  }
  const inSampleTrades = trades.filter((trade) => trade.period === "in_sample");
  const outOfSampleTrades = trades.filter((trade) => trade.period === "out_of_sample");
  const allMetrics = calculateBacktestMetrics(trades, rejectedByPeriod.in_sample + rejectedByPeriod.out_of_sample, audit);
  const reportFormulaHash = formulaConfigurationHash(request, activeStrategy.config);
  const occurrences = buildHistoricalOccurrenceLedger(dataset, audit, trades, reportFormulaHash);
  return {
    mode: "SHADOW MODE — NO LIVE ORDERS",
    dataSource: dataset.source ?? "simulated",
    symbol: dataset.source === "historical_databento" || dataset.source === "historical_databento_multicontract"
      ? historicalContractSymbol
      : specification.rootSymbol,
    formulaHash: reportFormulaHash,
    contract: reportContract,
    dataResolution: dataset.ticks?.length ? "tick" : "one-minute-fallback",
    dataset: {
      startDate: dataset.inSampleDates[0],
      endDate: dataset.outOfSampleDates.at(-1) ?? dataset.inSampleDates.at(-1)!,
      requestedStartDate: dataset.requestedStartDate ?? request.startDate ?? dataset.inSampleDates[0],
      requestedEndDate: dataset.requestedEndDate ?? request.endDate,
      selectedDates: [...(dataset.selectedDates ?? [...dataset.inSampleDates, ...dataset.outOfSampleDates])],
      inSampleDates: [...dataset.inSampleDates],
      outOfSampleDates: [...dataset.outOfSampleDates],
      excludedDates: [...(dataset.excludedDates ?? [])],
      untouchedOutOfSample: true,
      optimizationApplied: false,
      scheduleVersion: dataset.contractSchedule?.version ?? null,
      rolloverBoundaries: dataset.contractSchedule?.boundaries
        ? [...dataset.contractSchedule.boundaries]
        : [],
      activeContractByDate: dataset.contractSchedule?.activeContractByDate
        ? [...dataset.contractSchedule.activeContractByDate]
        : [],
    },
    replay: {
      ...finalReplay,
      totalCandleCount: candles.length,
      causal: true,
      futureCandleAccess: false,
    },
    metrics: allMetrics,
    inSample: calculateBacktestMetrics(inSampleTrades, rejectedByPeriod.in_sample, audit.filter((record) => record.period === "in_sample")),
    outOfSample: calculateBacktestMetrics(outOfSampleTrades, rejectedByPeriod.out_of_sample, audit.filter((record) => record.period === "out_of_sample")),
    segments: buildSegments(trades, allMetrics.rejectedSetupCount),
    trades,
    audit,
    occurrences,
    assumptions: [
      "Every strategy decision is recomputed from the visible candle prefix at that historical cursor.",
      "No current or future candle, indicator, volume value, level reaction, or setup state is available before its close time.",
      "Tick observations take precedence over one-minute bars; one-minute bars are the deterministic intrabar fallback.",
      "Unknown entry/invalidation order rejects the setup; unknown stop/target order applies stop first and is labeled AMBIGUOUS_STOP_FIRST.",
      "Each contract month keeps its own tick economics and fees; contract rollover boundaries are never blended.",
      "The out-of-sample dates are immutable holdout data and are not used for optimization.",
      `Historical replay uses exactly ${dataset.inSampleDates.length + dataset.outOfSampleDates.length} selected available trading dates; excluded dates are reported separately.`,
      ...(executionMode === "ohlcv_modeled"
        ? [
          MODELED_OHLCV_FILL_LABEL,
          "Only completed candles are visible. The entry uses the immediate next candle after the patience candle; later candles cannot trigger entry.",
          `Entry and exit slippage are ${modeledSlippageTicks} adverse tick${modeledSlippageTicks === 1 ? "" : "s"} per side.`,
          `The patience stop buffer is ${stopBufferTicks} tick${stopBufferTicks === 1 ? "" : "s"} and the confirmation buffer is ${entryBufferTicks} ticks.`,
          "OHLCV barriers that share one candle are resolved adverse-first and labeled.",
          `Fees use the configurable ${commissionPerContract.toFixed(2)} per-contract round-trip assumption.`,
        ]
        : []),
      "This report is simulated futures analysis only. No live or paper order was created.",
    ],
    executionMode,
    fillLabel: executionMode === "ohlcv_modeled" ? MODELED_OHLCV_FILL_LABEL : "Quote-based Shadow fill",
    executionPolicy: {
      entryBufferTicks,
      immediateNextCandleOnly: true,
      entrySlippageTicks: executionMode === "ohlcv_modeled" ? modeledSlippageTicks : 1,
      exitSlippageTicks: executionMode === "ohlcv_modeled" ? modeledSlippageTicks : 1,
      stopRule: executionMode === "ohlcv_modeled"
        ? `${stopBufferTicks} tick${stopBufferTicks === 1 ? "" : "s"} beyond the patience candle`
        : "Quote-based strategy and catastrophe stops",
      ambiguityRule: executionMode === "ohlcv_modeled"
        ? "Adverse-first when stop and target are both touched inside one OHLCV candle"
        : "Quote/tick order first; unresolved bars use stop-first",
      commissionPerContract,
    },
    gapReport: dataset.gapReport ?? {
      missingMinuteGaps: 0,
      missingGapSegments: 0,
      unexpectedMissingMinutes: 0,
      unexpectedOpenSessionMissingMinutes: 0,
      unexpectedOvernightMissingMinutes: 0,
      unexpectedRegularSessionMissingMinutes: 0,
      regularSessionGapSegments: 0,
      overnightGapSegments: 0,
      regularSessionMissingMinutes: 0,
      expectedClosedMarketMinutes: 0,
      expectedClosedMinutes: 0,
      weekendHolidayClosedMinutes: 0,
      earlyCloseMinutes: 0,
      inactiveContractMinutes: 0,
      lowLiquidityInactiveMinutes: 0,
      coverageScope: "selected_dates",
      inactiveContractThresholdPercent: 50,
      inactiveContractDays: 0,
      missingRegularSessionDates: [],
      missingOvernightSessionDates: [],
      completeRegularSessionDates: [],
      maintenanceGapMinutes: 0,
      weekendHolidayGapMinutes: 0,
      earlyCloseDates: [],
      overnightCoverageObserved: false,
    },
  };
}