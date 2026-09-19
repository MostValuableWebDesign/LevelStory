import type { Direction } from "./types.js";
import type { PrimaryLossExitReference } from "./key-level-targets.js";
import { causalEmaSeries, regularSessionVwap, vwap } from "./indicators.js";
import type { Candle } from "./types.js";
import { createHash } from "node:crypto";
import {
  BREAKEVEN_EVALUATION_BARS,
  BREAKEVEN_FAVORABLE_EXCURSION_R,
  favorableClose,
} from "./execution-management.js";

export const MODELED_OHLCV_FILL_LABEL = "Modeled OHLCV Fill — Not a Quote-Based Fill";
export const AMBIGUOUS_OHLCV_SEQUENCE_LABEL = "Ambiguous intrabar sequence — adverse-first policy applied";
export const AMBIGUOUS_STOP_FIRST_LABEL = "AMBIGUOUS_STOP_FIRST";
export const AMBIGUOUS_ENTRY_EXIT_ORDER_LABEL = "AMBIGUOUS_ENTRY_EXIT_ORDER";
export const AMBIGUOUS_RUNNER_SEQUENCE_LABEL = "AMBIGUOUS_RUNNER_SEQUENCE";
export const PRIMARY_LEVEL_EXIT_ARMED_LABEL = "PRIMARY_LEVEL_EXIT_ARMED";
export const PRIMARY_LEVEL_EXIT_REACHED_LABEL = "PRIMARY_LEVEL_EXIT_REACHED";
export const NO_FORWARD_LEVEL_1R_PLAN_LABEL = "NO_FORWARD_LEVEL_1R_PLAN";
export const NO_LEVEL_BAR_TIMER_STARTED_LABEL = "NO_LEVEL_BAR_TIMER_STARTED";
export const NO_LEVEL_BREAKEVEN_ACTIVATED_LABEL = "NO_LEVEL_BREAKEVEN_ACTIVATED";
export const BREAKEVEN_STOP_ARMED_LABEL = "BREAKEVEN_STOP_ARMED";
export const BREAKEVEN_RECOVERY_EXIT_ARMED_LABEL = "BREAKEVEN_RECOVERY_EXIT_ARMED";
export const BREAKEVEN_EXIT_REACHED_LABEL = "BREAKEVEN_EXIT_REACHED";
export const BREAKEVEN_RECOVERY_EXIT_REACHED_LABEL = "BREAKEVEN_RECOVERY_EXIT_REACHED";
export const ENTRY_PRICE_RECOVERY_EXIT_LABEL = "ENTRY_PRICE_RECOVERY_EXIT";
export const ONE_R_REACHED_BEFORE_BREAKEVEN_LABEL = "ONE_R_REACHED_BEFORE_BREAKEVEN";
export const ORIGINAL_STOP_REACHED_BEFORE_BREAKEVEN_LABEL = "ORIGINAL_STOP_REACHED_BEFORE_BREAKEVEN";
export const DYNAMIC_TARGET_TIGHTENED_LABEL = "DYNAMIC_TARGET_TIGHTENED";
export const DYNAMIC_TARGET_FARTHER_UPDATE_IGNORED_LABEL = "DYNAMIC_TARGET_FARTHER_UPDATE_IGNORED";
export const DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION = "causal-dynamic-target-v2-replay-context-pending-next-candle";
export const CONSOLIDATION_MIDPOINT_REENTRY_STOP_EXIT_REASON = "CONSOLIDATION_MIDPOINT_REENTRY_STOP";

export type DynamicTargetSource = "VWAP" | "EMA200";

export type IndicatorReplayContext = {
  source: DynamicTargetSource;
  calculationVersion: typeof DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION;
  period: number | null;
  tradingDate: string | null;
  sessionCalendarVersion: string | null;
  sourceStartTime: number | null;
  sourceEndTime: number | null;
  warmupCount: number;
  initialized: boolean;
  sourceFingerprint: string;
  candidateIdentity: string | null;
  candles: readonly OhlcvCandle[];
};

export type DynamicTargetUpdate = {
  candleOpenTime: number | null;
  candleCloseTime: number | null;
  indicator: DynamicTargetSource;
  previousIndicatorValue: number | null;
  recalculatedIndicatorValue: number;
  proposedTarget: number;
  previousEffectiveTarget: number;
  resultingEffectiveTarget: number;
  effectiveFromTimestamp: number | null;
  pending: boolean;
  tightened: boolean;
  fartherAwayIgnored: boolean;
  reason:
    | "TIGHTENED"
    | "PENDING_NO_NEXT_CANDLE"
    | "NO_CHANGE"
    | "IGNORED_FARTHER_AWAY"
    | "IGNORED_WOULD_CROSS_ENTRY";
  calculationVersion: string;
  sourceFingerprint: string | null;
};

export type BreakevenDisposition =
  | "NOT_APPLICABLE"
  | "PENDING"
  | "ONE_R_REACHED_BEFORE_BREAKEVEN"
  | "ORIGINAL_STOP_REACHED_BEFORE_BREAKEVEN"
  | "BREAKEVEN_STOP_ARMED"
  | "BREAKEVEN_RECOVERY_EXIT_ARMED"
  | "BREAKEVEN_EXIT_REACHED"
  | "BREAKEVEN_RECOVERY_EXIT_REACHED";

export type BreakevenCloseDisposition = "favorable" | "adverse" | "neutral";

export function isExecutionAmbiguityLabel(label: string): boolean {
  return label === AMBIGUOUS_OHLCV_SEQUENCE_LABEL
    || label === AMBIGUOUS_STOP_FIRST_LABEL
    || label === AMBIGUOUS_ENTRY_EXIT_ORDER_LABEL
    || label === "AMBIGUOUS_ENTRY_INVALIDATION"
    || label === "AMBIGUOUS_RUNNER_RETRACE"
    || label === AMBIGUOUS_RUNNER_SEQUENCE_LABEL;
}

export type OhlcvCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  openTime?: number;
  closeTime?: number;
  volume?: number;
  isComplete?: boolean;
};

export type OrderedIntrabarPoint = {
  timestamp: number;
  price: number;
};

export type OrderedIntrabarEvidenceInterval = {
  startTime: number;
  endTime: number;
  points: readonly OrderedIntrabarPoint[];
};

export function buildIndicatorReplayContext(input: {
  source: DynamicTargetSource;
  candles: readonly OhlcvCandle[];
  tradingDate?: string | null;
  emaPeriod?: number;
  sessionCalendarVersion?: string | null;
  candidateIdentity?: string | null;
}): IndicatorReplayContext {
  const ordered = input.candles
    .filter((candle) =>
      candle.isComplete !== false
      && Number.isFinite(candle.openTime)
      && Number.isFinite(candle.closeTime)
      && Number.isFinite(candle.volume ?? 0)
      && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite),
    )
    .map((candle) => ({ ...candle }))
    .sort((first, second) => first.closeTime! - second.closeTime! || first.openTime! - second.openTime!);
  const unique = [...new Map(ordered.map((candle) => [
    `${candle.openTime}:${candle.closeTime}`,
    candle,
  ])).values()];
  const indicatorCandles = unique.map(toIndicatorCandle).filter((item): item is Candle => item !== null);
  const period = input.source === "EMA200" ? input.emaPeriod ?? 200 : null;
  const emaSeries = period === null ? null : causalEmaSeries(indicatorCandles, period);
  const initialized = period === null
    ? Number.isFinite(regularSessionVwap(indicatorCandles, undefined, input.tradingDate ?? undefined))
    : emaSeries?.initialized === true;
  const warmupCount = period === null ? indicatorCandles.length : emaSeries?.warmupCount ?? 0;
  const sourceFingerprint = createHash("sha256").update(JSON.stringify(unique.map((candle) => [
    candle.openTime,
    candle.closeTime,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume ?? 0,
    candle.isComplete !== false,
  ]))).digest("hex");
  return {
    source: input.source,
    calculationVersion: DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION,
    period,
    tradingDate: input.tradingDate ?? null,
    sessionCalendarVersion: input.sessionCalendarVersion ?? null,
    sourceStartTime: unique[0]?.openTime ?? null,
    sourceEndTime: unique.at(-1)?.closeTime ?? null,
    warmupCount,
    initialized,
    sourceFingerprint,
    candidateIdentity: input.candidateIdentity ?? null,
    candles: unique,
  };
}

export function validateIndicatorReplayContext(
  context: IndicatorReplayContext,
  source: DynamicTargetSource,
  emaPeriod = 200,
): void {
  if (
    context.source !== source
    || context.calculationVersion !== DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION
    || !context.sourceFingerprint
    || !context.candles.length
    || !context.initialized
    || (source === "EMA200" && (
      context.period !== emaPeriod
      || context.warmupCount < emaPeriod
    ))
  ) {
    throw new Error("Dynamic target indicator replay context is stale or missing required causal warmup.");
  }
}

export type OhlcvFeeComponents = {
  commission?: number;
  exchange?: number;
  regulatory?: number;
  clearing?: number;
  commissionPerContract?: number;
  exchangeFeePerContract?: number;
  regulatoryFeePerContract?: number;
  clearingFeePerContract?: number;
};

export type ModeledExecutionLeg = {
  kind: "target" | "runner" | "full";
  quantity: number;
  referencePrice: number;
  fillPrice: number;
  grossPnl: number;
  slippage: number;
  fees: number;
  netPnl: number;
  exitReason: "target" | "runner" | "stop" | "breakeven" | "breakeven_recovery" | "manual" | "session_close";
  /** Exact ordered intrabar exit time when the source provides it. */
  exitTimestamp?: number;
  exitCandleOpenTime?: string;
  exitCandleCloseTime?: string;
};

export type ModeledExecutionAccounting = {
  grossPnl: number;
  slippage: number;
  fees: number;
  netPnl: number;
};

export type OhlcvExecutionAudit = {
  eventLabels: string[];
  /** @deprecated Use eventLabels. Retained for internal callers during migration. */
  labels: string[];
  ambiguityLabels: string[];
  assumptions: string[];
  entryCandle: OhlcvCandle | null;
  exitCandle: OhlcvCandle | null;
  /** Exact ordered intrabar exit time; null means candle-close timing remains the policy. */
  modeledExitTimestamp?: number | null;
  targetHit: boolean;
  runnerActivated: boolean;
  runnerExited: boolean;
  strategyStopPrice: number | null;
  consolidationMidpointStop?: {
    frozenZoneHigh: number;
    frozenZoneLow: number;
    rawMidpoint: number;
    tickAlignedStop: number;
    direction: Direction;
    calculationVersion: string;
    activationTimestamp: number | null;
    stopHitTimestamp: number | null;
    sourceOccurrenceId?: string | null;
    sourceAuditId?: string | null;
  } | null;
  catastropheStopPrice: number | null;
  stopLevel: "primary_level" | "strategy" | "catastrophe" | "structure_trailing" | "breakeven" | null;
  primaryLossExitLevel: PrimaryLossExitReference | null;
  initialRiskPoints: number | null;
  oneRPrice: number | null;
  oneRReached: boolean;
  profitCheckpointPrice: number | null;
  trailingStopPrice: number | null;
  trailingStopActive: boolean;
  trailingStopSource: string | null;
  runnerReferencePrice: number | null;
  runnerImpulse: number | null;
  runnerMostFavorablePrice: number | null;
  remainingQuantity: number;
  noForwardLevelAtEntry: boolean;
  postEntryCompletedBars: number;
  breakevenActivationBars: number | null;
  breakevenActivated: boolean;
  breakevenActivationTimestamp: number | null;
  breakevenEffectiveFromTimestamp: number | null;
  breakevenPrice: number | null;
  breakevenDisposition: BreakevenDisposition;
  breakevenMfePrice: number | null;
  breakevenMfePoints: number | null;
  breakevenMfeTicks: number | null;
  breakevenMfeR: number | null;
  breakevenEvaluationClose: number | null;
  breakevenEvaluationCloseDisposition: BreakevenCloseDisposition | null;
  breakevenRecoveryExitTimestamp: number | null;
  runnerBreakevenPendingTimestamp: number | null;
  runnerBreakevenQualificationTimestamp: number | null;
  runnerBreakevenEffectiveFromTimestamp: number | null;
  runnerBreakevenPreviousStopPrice: number | null;
  runnerBreakevenStopPrice: number | null;
  runnerBreakevenTightened: boolean;
  runnerBreakevenIgnoredForTighterStop: boolean;
  originalStopStillActive: boolean;
  dynamicTargetSource: DynamicTargetSource | null;
  dynamicTargetReplayContext: IndicatorReplayContext | null;
  initialTargetPrice: number | null;
  effectiveTargetPrice: number | null;
  targetUpdateLedger: DynamicTargetUpdate[];
};

export type ModeledOhlcvExecution = {
  entryTrigger: number | null;
  modeledFill: number | null;
  /** Exact threshold-crossing time when ordered intrabar evidence exists. */
  modeledFillTimestamp: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  exitPrice: number | null;
  exitReason: "target" | "runner" | "stop" | "breakeven" | "breakeven_recovery" | "manual" | "session_close" | "not filled" | typeof CONSOLIDATION_MIDPOINT_REENTRY_STOP_EXIT_REASON;
  legs: ModeledExecutionLeg[];
  accounting: ModeledExecutionAccounting;
  audit: OhlcvExecutionAudit;
  ambiguityLabels: string[];
  eventLabels: string[];
  assumptions: string[];
};
export type ModeledExecution = ModeledOhlcvExecution;
export type ModeledExecutionAudit = OhlcvExecutionAudit;

export type OhlcvExecutionInput = {
  direction: Direction;
  entry: number;
  patienceCandle?: OhlcvCandle | null;
  immediateTriggerCandle?: OhlcvCandle | null;
  /**
   * Candidate-driven entries are observed at the trigger close. Their
   * trigger candle is evidence for entry only; exits begin on the next
   * completed candle.
   */
  evaluateEntryCandleForExit?: boolean;
  /** Ordered tick observations for the trigger candle, when available. */
  orderedIntrabarPoints?: readonly OrderedIntrabarPoint[];
  /** Ordered tick observations after entry, used only when exact exit chronology is known. */
  orderedPostEntryPoints?: readonly OrderedIntrabarPoint[];
  /**
   * Verified ordered evidence for individual post-entry candle intervals.
   * An interval absent from this list must use the normal OHLC policy.
   */
  orderedPostEntryEvidenceIntervals?: readonly OrderedIntrabarEvidenceInterval[];
  /**
   * The caller has verified that the ordered points cover the complete
   * competing-barrier sequence for the candles being simulated. A non-empty
   * point array alone is not sufficient evidence to override OHLC ambiguity.
   */
  orderedIntrabarEvidenceComplete?: boolean;
  /** Explicit threshold-crossing timestamp, when already established causally. */
  entryFillTimestamp?: number | null;
  subsequentCompletedCandles?: readonly OhlcvCandle[];
  /** Alias retained for callers that describe these simply as completed candles. */
  completedCandles?: readonly OhlcvCandle[];
  contracts?: number;
  quantity?: number;
  contractQuantity?: number;
  targetQuantity?: number;
  target?: number | null;
  stop?: number | null;
  targetPrice?: number | null;
  stopPrice?: number | null;
  strategyStop?: number | null;
  strategyStopExitReason?: typeof CONSOLIDATION_MIDPOINT_REENTRY_STOP_EXIT_REASON;
  consolidationMidpointStop?: Omit<
    NonNullable<OhlcvExecutionAudit["consolidationMidpointStop"]>,
    "activationTimestamp" | "stopHitTimestamp"
  >;
  catastropheStop?: number | null;
  targetDollars?: number | null;
  tickSize: number;
  tickValue?: number;
  pointMultiplier?: number;
  entrySlippageTicks?: number;
  exitSlippageTicks?: number;
  fees?: OhlcvFeeComponents;
  feeComponents?: OhlcvFeeComponents;
  sessionCloseCandle?: OhlcvCandle | null;
  primaryLossExitLevel?: PrimaryLossExitReference | null;
  /** Candidate-owned no-target management: take full 1R with one contract, or one contract at 1R before structure trailing. */
  oneRProfitRule?: boolean;
  /** The supplied target is the planner's explicit exactly-1R fallback, not a causal key-level target. */
  targetIsOneR?: boolean;
  /** Candidate-owned runner management: use confirmed five-minute swings. */
  structureTrailing?: boolean;
  trailingBufferTicks?: number;
  /** Governed post-entry completed-bar delay before no-target breakeven management. */
  noLevelBreakevenActivationBars?: number;
  /**
   * A selected VWAP/EMA 200 target remains identity-frozen, but its
   * executable price may ratchet closer after completed candles. The history
   * must include all causal indicator candles through each post-entry candle.
   */
  dynamicTarget?: {
    source: DynamicTargetSource;
    indicatorCandles: readonly OhlcvCandle[];
    tradingDate?: string;
    emaPeriod?: number;
    initialIndicatorValue?: number | null;
    sourceFingerprint?: string | null;
     replayContext?: IndicatorReplayContext;
  };
};

function money(value: number): number {
  return Number(value.toFixed(2));
}

function tick(price: number, size: number): number {
  return Number((Math.round(price / size) * size).toFixed(10));
}

function validCandle(candle: OhlcvCandle): void {
  if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) {
    throw new Error("OHLCV candles must contain finite OHLC prices.");
  }
}

function toIndicatorCandle(candle: OhlcvCandle): Candle | null {
  if (
    !Number.isFinite(candle.openTime)
    || !Number.isFinite(candle.closeTime)
    || !Number.isFinite(candle.volume ?? 0)
  ) return null;
  return {
    openTime: candle.openTime!,
    closeTime: candle.closeTime!,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? 0,
    isComplete: candle.isComplete !== false,
  };
}

function dynamicIndicatorValueAt(
  dynamicTarget: NonNullable<OhlcvExecutionInput["dynamicTarget"]>,
  candle: OhlcvCandle,
): number | null {
  const replayContext = dynamicTarget.replayContext;
  if (replayContext) validateIndicatorReplayContext(replayContext, dynamicTarget.source, dynamicTarget.emaPeriod ?? 200);
  const indicatorCandles = (replayContext?.candles ?? dynamicTarget.indicatorCandles)
    .filter((item) =>
      item.isComplete !== false
      && Number.isFinite(item.closeTime)
      && item.closeTime! <= (candle.closeTime ?? Number.POSITIVE_INFINITY),
    )
    .map(toIndicatorCandle)
    .filter((item): item is Candle => item !== null)
    .sort((first, second) => first.closeTime - second.closeTime || first.openTime - second.openTime);
  if (!indicatorCandles.length) return null;
  if (dynamicTarget.source === "EMA200") {
    const series = causalEmaSeries(indicatorCandles, dynamicTarget.emaPeriod ?? 200);
    return series.points.at(-1)?.value ?? null;
  }
  const calculated = dynamicTarget.tradingDate
    ? regularSessionVwap(indicatorCandles, undefined, dynamicTarget.tradingDate)
    : vwap(indicatorCandles);
  return Number.isFinite(calculated) ? calculated : null;
}

function completedSwing(
  candles: readonly OhlcvCandle[],
  currentIndex: number,
  direction: Direction,
): { price: number; candle: OhlcvCandle } | null {
  if (currentIndex < 2) return null;
  const left = candles[currentIndex - 2];
  const pivot = candles[currentIndex - 1];
  const right = candles[currentIndex];
  if (!left || !pivot || !right) return null;
  if (direction === "long" && pivot.low < left.low && pivot.low < right.low) {
    return { price: pivot.low, candle: pivot };
  }
  if (direction === "short" && pivot.high > left.high && pivot.high > right.high) {
    return { price: pivot.high, candle: pivot };
  }
  return null;
}

function emptyResult(
  input: OhlcvExecutionInput,
  labels: string[] = [],
  ambiguityLabels: string[] = [],
): ModeledOhlcvExecution {
  const noForwardLevelAtEntry = input.oneRProfitRule === true;
  const breakevenActivationBars = noForwardLevelAtEntry
    ? input.noLevelBreakevenActivationBars ?? BREAKEVEN_EVALUATION_BARS
    : null;
  const initialTargetPrice = input.targetPrice ?? input.target ?? null;
  const assumptions = [
    MODELED_OHLCV_FILL_LABEL,
    "Historical OHLCV has no bid/ask; candle barriers are evaluated conservatively.",
  ];
  return {
    entryTrigger: null, modeledFill: null, modeledFillTimestamp: null, stopPrice: input.stopPrice ?? input.stop ?? null,
    targetPrice: initialTargetPrice, exitPrice: null, exitReason: "not filled",
    legs: [], accounting: { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 },
    audit: {
      eventLabels: labels, labels, ambiguityLabels, assumptions, entryCandle: null, exitCandle: null, modeledExitTimestamp: null, targetHit: false,
      runnerActivated: false, runnerExited: false,
      strategyStopPrice: input.strategyStop ?? input.stopPrice ?? input.stop ?? null,
      consolidationMidpointStop: input.consolidationMidpointStop
        ? { ...input.consolidationMidpointStop, activationTimestamp: null, stopHitTimestamp: null }
        : null,
      catastropheStopPrice: input.catastropheStop ?? null,
      stopLevel: null, primaryLossExitLevel: input.primaryLossExitLevel ?? null,
      initialRiskPoints: null, oneRPrice: null, oneRReached: false, profitCheckpointPrice: null,
      trailingStopPrice: null, trailingStopActive: false, trailingStopSource: null,
      runnerReferencePrice: null, runnerImpulse: null,
      runnerMostFavorablePrice: null, remainingQuantity: input.quantity ?? input.contractQuantity ?? input.contracts ?? 0,
      noForwardLevelAtEntry,
      postEntryCompletedBars: 0,
      breakevenActivationBars,
      breakevenActivated: false,
      breakevenActivationTimestamp: null,
      breakevenEffectiveFromTimestamp: null,
      breakevenPrice: null,
      breakevenDisposition: noForwardLevelAtEntry ? "PENDING" : "NOT_APPLICABLE",
      breakevenMfePrice: null,
      breakevenMfePoints: null,
      breakevenMfeTicks: null,
      breakevenMfeR: null,
      breakevenEvaluationClose: null,
      breakevenEvaluationCloseDisposition: null,
      breakevenRecoveryExitTimestamp: null,
      runnerBreakevenPendingTimestamp: null,
      runnerBreakevenQualificationTimestamp: null,
      runnerBreakevenEffectiveFromTimestamp: null,
      runnerBreakevenPreviousStopPrice: null,
      runnerBreakevenStopPrice: null,
      runnerBreakevenTightened: false,
      runnerBreakevenIgnoredForTighterStop: false,
      originalStopStillActive: false,
      dynamicTargetSource: input.dynamicTarget?.source ?? null,
       dynamicTargetReplayContext: input.dynamicTarget?.replayContext ?? null,
      initialTargetPrice,
      effectiveTargetPrice: initialTargetPrice,
      targetUpdateLedger: [],
    },
    ambiguityLabels, eventLabels: labels, assumptions,
  };
}

/**
 * Simulates a historical fill without treating OHLC prices as executable quotes.
 * When both barriers occur in a candle, the adverse barrier is deliberately first.
 */
export function simulateOhlcvExecution(input: OhlcvExecutionInput): ModeledOhlcvExecution {
  if (!Number.isFinite(input.entry) || !Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    throw new Error("Entry and tickSize must be finite, and tickSize must be positive.");
  }
  const quantity = input.quantity ?? input.contractQuantity ?? input.contracts ?? 0;
  const targetQuantity = input.targetQuantity ?? (quantity > 1 ? 1 : quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || !Number.isInteger(targetQuantity) || targetQuantity < 0 || targetQuantity > quantity) {
    throw new Error("OHLCV quantities must be whole, non-negative, and target quantity cannot exceed total quantity.");
  }
  if (input.patienceCandle) validCandle(input.patienceCandle);
  const trigger = input.immediateTriggerCandle ?? null;
  if (trigger) validCandle(trigger);
  const orderedPoints = trigger && input.orderedIntrabarPoints
    ? input.orderedIntrabarPoints
      .filter((point) =>
        Number.isFinite(point.timestamp)
        && Number.isFinite(point.price)
        && point.timestamp >= (trigger.openTime ?? Number.NEGATIVE_INFINITY)
        && point.timestamp <= (trigger.closeTime ?? Number.POSITIVE_INFINITY),
      )
      .sort((first, second) => first.timestamp - second.timestamp)
    : [];
  const intervalEvidence = input.orderedPostEntryEvidenceIntervals;
  const orderedPostEntryPoints = intervalEvidence !== undefined
    ? intervalEvidence.flatMap((interval) => interval.points)
    : [...(input.orderedPostEntryPoints ?? [])]
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.price))
    .sort((first, second) => first.timestamp - second.timestamp);
  const orderedEvidenceComplete = input.orderedIntrabarEvidenceComplete === true;
  const entryOrderedEvidenceComplete = orderedEvidenceComplete;
  const orderedExitPoints = intervalEvidence !== undefined
    ? orderedPostEntryPoints
    : orderedEvidenceComplete
    ? (orderedPostEntryPoints.length > 0 ? orderedPostEntryPoints : orderedPoints)
    : [];
  const subsequentCandles = [
    ...(input.subsequentCompletedCandles ?? []),
    ...(input.completedCandles ?? []),
  ];
  subsequentCandles.forEach(validCandle);
  const size = input.tickSize;
  const entryReference = tick(input.entry, size);
  const strategyStop = input.strategyStop ?? input.stopPrice ?? input.stop ?? null;
  const catastropheStop = input.catastropheStop ?? null;
  const stopCandidates = [
    strategyStop === null ? null : { price: strategyStop, level: "strategy" as const },
    catastropheStop === null ? null : { price: catastropheStop, level: "catastrophe" as const },
  ].filter((item): item is { price: number; level: "strategy" | "catastrophe" } => item !== null);
  const fallbackStop = stopCandidates.sort((first, second) =>
    input.direction === "long" ? second.price - first.price : first.price - second.price,
  )[0] ?? null;
  // Structural R is always anchored to the frozen strategy stop. The
  // catastrophe stop remains a separate collision barrier and must not
  // silently change target distance or breakeven progress.
  const initialStop = strategyStop ?? catastropheStop;
  const convertedTarget = input.targetDollars == null
    ? (input.targetPrice ?? input.target ?? null)
    : (input.direction === "long"
      ? entryReference + (input.targetDollars / (input.tickValue ?? size * (input.pointMultiplier ?? 1))) * size
      : entryReference - (input.targetDollars / (input.tickValue ?? size * (input.pointMultiplier ?? 1))) * size);
  const initialTarget = convertedTarget == null ? null : tick(convertedTarget, size);
  let effectiveTarget = initialTarget;
  const oneRProfitRule = input.oneRProfitRule === true
    && (initialTarget === null || input.targetIsOneR === true);
  const noForwardLevelAtEntry = oneRProfitRule;
  const breakevenActivationBars = noForwardLevelAtEntry
    ? input.noLevelBreakevenActivationBars ?? BREAKEVEN_EVALUATION_BARS
    : null;
  if (breakevenActivationBars !== null
    && (!Number.isInteger(breakevenActivationBars) || breakevenActivationBars <= 0)) {
    throw new Error("No-level breakeven activation bars must be a positive whole number.");
  }
  const structureTrailing = input.structureTrailing === true;
  const trailingBufferTicks = input.trailingBufferTicks ?? 8;
  if (!Number.isInteger(trailingBufferTicks) || trailingBufferTicks <= 0) {
    throw new Error("Structure trailing buffer must be a positive whole number of ticks.");
  }
  const stopPrice = fallbackStop === null ? null : tick(fallbackStop.price, size);
  const eventLabels: string[] = [];
  const ambiguityLabels: string[] = [];
  const assumptions = [
    MODELED_OHLCV_FILL_LABEL,
    "Historical OHLCV has no bid/ask; candle barriers are evaluated conservatively.",
    entryOrderedEvidenceComplete
      ? "Complete ordered intrabar evidence selects the first timestamped executable event; equal timestamps remain adverse-first ambiguous."
      : "Stops are evaluated before targets when both are touched in one candle.",
    ...(input.oneRProfitRule
      ? ["No eligible key-level target: 1R is the actual modeled fill-to-initial-stop distance; one contract exits fully at +1R, while multi-contract positions take one contract at +1R before trailing the remainder."]
      : []),
     ...(breakevenActivationBars !== null
       ? [`Progress-based breakeven/recovery is evaluated after ${breakevenActivationBars} completed post-entry candles; changes are effective on the following candle.`]
       : []),
    ...(input.structureTrailing
      ? [`Structure trailing uses the most recent completed three-candle five-minute swing with an ${input.trailingBufferTicks ?? 8}-tick buffer and never widens.`]
      : []),
  ];
  const entryTouched = trigger !== null
    && (input.direction === "long" ? trigger.high >= entryReference : trigger.low <= entryReference);
  if (!trigger || !entryTouched || quantity === 0) {
    return emptyResult(
      { ...input, targetPrice: initialTarget, stopPrice },
      noForwardLevelAtEntry ? [NO_FORWARD_LEVEL_1R_PLAN_LABEL] : [],
    );
  }
  const orderedEntryPoint = entryOrderedEvidenceComplete && orderedPoints.length > 0
    ? orderedPoints.find((point) =>
      input.direction === "long" ? point.price >= entryReference : point.price <= entryReference,
    ) ?? null
    : null;
  const entryTimestamp = orderedEntryPoint?.timestamp
    ?? (entryOrderedEvidenceComplete
      && typeof input.entryFillTimestamp === "number"
      && Number.isFinite(input.entryFillTimestamp)
      ? input.entryFillTimestamp
      : null);
  const entryKnownAtOpen = input.direction === "long"
    ? trigger.open >= entryReference
    : trigger.open <= entryReference;
  const triggerExitTouched = (initialStop !== null
    && (input.direction === "long" ? trigger.low <= initialStop : trigger.high >= initialStop))
    || (initialTarget !== null
      && (input.direction === "long" ? trigger.high >= initialTarget : trigger.low <= initialTarget));
  if (
    input.evaluateEntryCandleForExit === true
    && !entryOrderedEvidenceComplete
    && !entryKnownAtOpen
    && triggerExitTouched
  ) {
    return emptyResult(
      input,
      ["ENTRY_EXIT_ORDER_UNRESOLVED"],
      [AMBIGUOUS_ENTRY_EXIT_ORDER_LABEL, AMBIGUOUS_OHLCV_SEQUENCE_LABEL],
    );
  }
  let modeledFill = tick(
    input.direction === "long"
      ? (trigger.open > entryReference ? trigger.open : entryReference) + (input.entrySlippageTicks ?? 0) * size
      : (trigger.open < entryReference ? trigger.open : entryReference) - (input.entrySlippageTicks ?? 0) * size,
    size,
  );
  let triggerForExecution = trigger;
  let modeledFillTimestamp: number | null = null;
  if (orderedEntryPoint !== null) {
    modeledFill = tick(
      input.direction === "long"
        ? orderedEntryPoint.price + (input.entrySlippageTicks ?? 0) * size
        : orderedEntryPoint.price - (input.entrySlippageTicks ?? 0) * size,
      size,
    );
    modeledFillTimestamp = entryTimestamp;
    const postEntryPoints = orderedPoints.filter((point) =>
      point.timestamp > orderedEntryPoint.timestamp,
    );
    const firstExitIndex = postEntryPoints.findIndex((point) => {
      const stopHit = initialStop !== null
        && (input.direction === "long" ? point.price <= initialStop : point.price >= initialStop);
      const targetHit = initialTarget !== null
        && (input.direction === "long" ? point.price >= initialTarget : point.price <= initialTarget);
      return stopHit || targetHit;
    });
    const firstExitTimestamp = firstExitIndex >= 0 ? postEntryPoints[firstExitIndex]!.timestamp : null;
    const firstExitEndIndex = firstExitTimestamp === null
      ? -1
      : postEntryPoints.reduce(
        (last, point, index) => point.timestamp === firstExitTimestamp ? index : last,
        firstExitIndex,
      );
    const path = firstExitIndex >= 0
      ? postEntryPoints.slice(0, firstExitEndIndex + 1)
      : postEntryPoints;
    const pathPrices = [modeledFill, ...path.map((point) => point.price)];
    triggerForExecution = {
      ...trigger,
      open: modeledFill,
      high: Math.max(...pathPrices),
      low: Math.min(...pathPrices),
      close: path.at(-1)?.price ?? modeledFill,
    };
  }
  const orderedExecutionPoints = orderedEntryPoint === null && !entryKnownAtOpen
    ? entryOrderedEvidenceComplete
      ? orderedExitPoints.filter((point) =>
        point.timestamp > (trigger.closeTime ?? Number.NEGATIVE_INFINITY))
      : []
    : orderedExitPoints;
  const initialRiskPoints = initialStop === null ? null : Math.abs(modeledFill - initialStop);
  const oneRPrice = initialRiskPoints === null
    ? null
    : tick(input.direction === "long" ? modeledFill + initialRiskPoints : modeledFill - initialRiskPoints, size);
  const candles = [
    ...(input.evaluateEntryCandleForExit === false ? [] : [triggerForExecution]),
    ...subsequentCandles,
  ];
  const firstPostEntryCandleIndex = input.evaluateEntryCandleForExit === false || trigger === null ? 0 : 1;
  const checkpointQuantity = oneRProfitRule ? Math.min(1, quantity) : targetQuantity;
  const runnerQuantity = quantity - checkpointQuantity;
  let remaining = quantity;
  let targetHit = false;
  let oneRReached = false;
  let trailingStopActive = false;
  let trailingStopPrice: number | null = null;
  let trailingStopSource: string | null = null;
  let runnerExited = false;
  let exitReason: ModeledOhlcvExecution["exitReason"] = "manual";
  let exitPrice: number | null = null;
  let exitCandle: OhlcvCandle | null = null;
  let resolvedStopPrice = stopPrice;
  let runnerBest = modeledFill;
  let targetCandle: OhlcvCandle | null = null;
  let profitCheckpointPrice: number | null = null;
  let postEntryCompletedBars = 0;
  let noLevelTimerStarted = false;
  let breakevenActivated = false;
  let breakevenActivationTimestamp: number | null = null;
  let breakevenEffectiveFromTimestamp: number | null = null;
  // This is an active stop level, not the planned no-target checkpoint price.
  // Keep it null until the configured target or no-level trigger arms breakeven.
  let breakevenPrice: number | null = null;
  let breakevenDisposition: BreakevenDisposition =
    breakevenActivationBars !== null ? "PENDING" : "NOT_APPLICABLE";
  let breakevenMfePrice: number | null = null;
  let breakevenMfePoints: number | null = null;
  let breakevenMfeTicks: number | null = null;
  let breakevenMfeR: number | null = null;
  let breakevenEvaluationClose: number | null = null;
  let breakevenEvaluationCloseDisposition: BreakevenCloseDisposition | null = null;
  let breakevenRecoveryExitTimestamp: number | null = null;
  let breakevenMode: "none" | "stop" | "recovery" = "none";
  let breakevenEvaluated = false;
  let runnerBreakevenPending = false;
  let runnerBreakevenPendingCandleIndex: number | null = null;
  let runnerBreakevenPendingTimestamp: number | null = null;
  let runnerBreakevenQualificationTimestamp: number | null = null;
  let runnerBreakevenEffectiveFromTimestamp: number | null = null;
  let runnerBreakevenPreviousStopPrice: number | null = null;
  let runnerBreakevenStopPrice: number | null = null;
  let runnerBreakevenTightened = false;
  let runnerBreakevenIgnoredForTighterStop = false;
  let originalStopStillActive = initialStop !== null;
  const targetUpdateLedger: DynamicTargetUpdate[] = [];
  let previousIndicatorValue = input.dynamicTarget?.initialIndicatorValue ?? null;
  if (noForwardLevelAtEntry) eventLabels.push(NO_FORWARD_LEVEL_1R_PLAN_LABEL);
  const legs: ModeledExecutionLeg[] = [];
  let resolvedStopLevel: "strategy" | "catastrophe" | "structure_trailing" | "breakeven" | null = null;
  const multiplier = input.pointMultiplier ?? 1;
  const tickValue = input.tickValue ?? size * multiplier;
  const feePerSide = Object.values(input.fees ?? input.feeComponents ?? {}).reduce((sum, value) => sum + (value ?? 0), 0);
  const makeLeg = (kind: ModeledExecutionLeg["kind"], qty: number, reference: number, fill: number, reason: ModeledExecutionLeg["exitReason"], candle: OhlcvCandle, orderedExitPoint: OrderedIntrabarPoint | null = null): ModeledExecutionLeg => {
    const sign = input.direction === "long" ? 1 : -1;
    const gross = (reference - entryReference) * qty * multiplier * sign;
    const entrySlip = Math.abs(modeledFill - entryReference) * qty * multiplier;
    const exitSlip = Math.abs(fill - reference) * qty * multiplier;
    const slip = entrySlip + exitSlip;
    const fees = feePerSide * qty * 2;
    const exitCandleOpenTime = typeof candle.openTime === "number" ? new Date(candle.openTime).toISOString() : undefined;
    const exitCandleCloseTime = typeof candle.closeTime === "number" ? new Date(candle.closeTime).toISOString() : undefined;
    return {
      kind,
      quantity: qty,
      referencePrice: tick(reference, size),
      fillPrice: tick(fill, size),
      grossPnl: money(gross),
      slippage: money(slip),
      fees: money(fees),
      netPnl: money(gross - slip - fees),
      exitReason: reason,
      ...(orderedExitPoint ? { exitTimestamp: orderedExitPoint.timestamp } : {}),
      ...(exitCandleOpenTime ? { exitCandleOpenTime } : {}),
      ...(exitCandleCloseTime ? { exitCandleCloseTime } : {}),
    };
  };
  for (let candleIndex = 0; candleIndex < candles.length; candleIndex += 1) {
    const candle = candles[candleIndex]!;
    const postEntryBar = candleIndex >= firstPostEntryCandleIndex
      ? candleIndex - firstPostEntryCandleIndex + 1
      : 0;
    if (postEntryBar > 0) {
      postEntryCompletedBars = postEntryBar;
      if (!noLevelTimerStarted && breakevenActivationBars !== null) {
        noLevelTimerStarted = true;
        eventLabels.push(NO_LEVEL_BAR_TIMER_STARTED_LABEL);
      }
    }
    const activeTrailingStop = trailingStopActive && trailingStopPrice !== null ? trailingStopPrice : null;
    const breakevenStopArmed = breakevenMode === "stop";
    const recoveryExitArmed = breakevenMode === "recovery";
    const candleEvidenceInterval = intervalEvidence?.find((interval) =>
      (typeof candle.openTime !== "number" || interval.startTime <= candle.openTime)
      && (typeof candle.closeTime !== "number" || interval.endTime >= candle.closeTime),
    );
    const candleOrderedPoints = intervalEvidence !== undefined
      ? candleEvidenceInterval?.points.filter((point) =>
        point.timestamp > (modeledFillTimestamp ?? Number.NEGATIVE_INFINITY)
        && (typeof candle.openTime !== "number" || point.timestamp >= candle.openTime)
        && (typeof candle.closeTime !== "number" || point.timestamp <= candle.closeTime),
      ) ?? []
      : orderedExecutionPoints.length > 0
      ? orderedExecutionPoints.filter((point) =>
        point.timestamp > (modeledFillTimestamp ?? Number.NEGATIVE_INFINITY)
        && (typeof candle.openTime !== "number" || point.timestamp >= candle.openTime)
        && (typeof candle.closeTime !== "number" || point.timestamp <= candle.closeTime),
      )
      : [];
    const candleOrderedEvidenceComplete = candleOrderedPoints.length > 0
      && (intervalEvidence !== undefined ? candleEvidenceInterval !== undefined : orderedEvidenceComplete);
    const orderedEvent = (() => {
      type OrderedEvent = {
        kind: "target" | "oneR" | "recovery" | "stop";
        point: OrderedIntrabarPoint;
        stopLevel?: "strategy" | "catastrophe" | "structure_trailing" | "breakeven";
        ambiguous?: boolean;
      };
      const events = candleOrderedPoints.map((point): OrderedEvent | null => {
        const target = !oneRProfitRule
          && !targetHit
          && effectiveTarget !== null
          && (input.direction === "long" ? point.price >= effectiveTarget : point.price <= effectiveTarget);
        const oneR = oneRProfitRule
          && !oneRReached
          && oneRPrice !== null
          && (input.direction === "long" ? point.price >= oneRPrice : point.price <= oneRPrice);
        const recovery = recoveryExitArmed
          && (input.direction === "long" ? point.price >= modeledFill : point.price <= modeledFill);
        const catastrophe = catastropheStop !== null
          && (input.direction === "long" ? point.price <= catastropheStop : point.price >= catastropheStop);
        const breakeven = breakevenStopArmed
          && (input.direction === "long" ? point.price <= modeledFill : point.price >= modeledFill);
        const trailing = !breakevenStopArmed
          && activeTrailingStop !== null
          && (input.direction === "long" ? point.price <= activeTrailingStop : point.price >= activeTrailingStop);
        const strategy = !breakevenStopArmed
          && activeTrailingStop === null
          && strategyStop !== null
          && (input.direction === "long" ? point.price <= strategyStop : point.price >= strategyStop);
        const adverseLevel = catastrophe
          ? "catastrophe"
          : breakeven
            ? "breakeven"
            : trailing
              ? "structure_trailing"
              : strategy
                ? "strategy"
                : undefined;
        const favorableKind = target ? "target" : oneR ? "oneR" : recovery ? "recovery" : null;
        if (!adverseLevel && !favorableKind) return null;
        return adverseLevel
          ? { kind: "stop", point, stopLevel: adverseLevel, ambiguous: Boolean(favorableKind) }
          : { kind: favorableKind!, point };
      }).filter((event): event is OrderedEvent => event !== null);
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        const sameTimestamp = events.filter((candidate) => candidate.point.timestamp === event.point.timestamp);
        const hasAdverse = sameTimestamp.some((candidate) => candidate.kind === "stop");
        const hasFavorable = sameTimestamp.some((candidate) => candidate.kind !== "stop");
        if (hasAdverse && hasFavorable) {
          const adverseEvent = sameTimestamp.find((candidate) => candidate.kind === "stop")!;
          return { ...adverseEvent, ambiguous: true };
        }
        return event;
      }
      return null;
    })();
    const orderedStopLevel = orderedEvent?.kind === "stop" ? orderedEvent.stopLevel : null;
    const orderedAmbiguousStop = orderedEvent?.kind === "stop" && orderedEvent.ambiguous === true;
    const strategyHit = candleOrderedEvidenceComplete
      ? orderedStopLevel === "strategy"
      : !breakevenStopArmed
        && activeTrailingStop === null
        && strategyStop !== null
        && (input.direction === "long" ? candle.low <= strategyStop : candle.high >= strategyStop);
    const catastropheHit = candleOrderedEvidenceComplete
      ? orderedStopLevel === "catastrophe"
      : catastropheStop !== null
        && (input.direction === "long" ? candle.low <= catastropheStop : candle.high >= catastropheStop);
    const trailingHit = candleOrderedEvidenceComplete
      ? orderedStopLevel === "structure_trailing"
      : !breakevenStopArmed
        && activeTrailingStop !== null
        && (input.direction === "long" ? candle.low <= activeTrailingStop : candle.high >= activeTrailingStop);
    const breakevenHit = candleOrderedEvidenceComplete
      ? orderedStopLevel === "breakeven"
      : breakevenStopArmed
        && (input.direction === "long" ? candle.low <= modeledFill : candle.high >= modeledFill);
    const originalStopHit = strategyHit || catastropheHit || trailingHit;
    const adverse = orderedAmbiguousStop || catastropheHit || breakevenHit || originalStopHit;
    const favorable = candleOrderedEvidenceComplete
      ? orderedEvent?.kind === "target"
      : effectiveTarget !== null
        && (input.direction === "long" ? candle.high >= effectiveTarget : candle.low <= effectiveTarget);
    const targetReachedInCandle = !oneRProfitRule && !targetHit && favorable;
    const oneRReachedInCandle = candleOrderedEvidenceComplete
      ? orderedEvent?.kind === "oneR"
      : oneRProfitRule
        && !oneRReached
        && oneRPrice !== null
        && (input.direction === "long" ? candle.high >= oneRPrice : candle.low <= oneRPrice);
    const recoveryReached = candleOrderedEvidenceComplete
      ? orderedEvent?.kind === "recovery"
      : recoveryExitArmed
        && (input.direction === "long"
          ? candle.open <= modeledFill && candle.high >= modeledFill
          : candle.open >= modeledFill && candle.low <= modeledFill);
    if (adverse) {
      if (favorable || oneRReachedInCandle || recoveryReached || orderedAmbiguousStop) {
        eventLabels.push(AMBIGUOUS_STOP_FIRST_LABEL);
        ambiguityLabels.push(AMBIGUOUS_STOP_FIRST_LABEL, AMBIGUOUS_OHLCV_SEQUENCE_LABEL);
      }
      const level = catastropheHit
        ? { price: catastropheStop!, level: "catastrophe" as const }
        : breakevenHit
        ? { price: modeledFill, level: "breakeven" as const }
        : trailingHit
          ? { price: activeTrailingStop!, level: "structure_trailing" as const }
          : fallbackStop!;
      resolvedStopPrice = tick(level.price, size);
      resolvedStopLevel = level.level;
       if (level.level === "structure_trailing") eventLabels.push("STRUCTURE_TRAILING_STOP_REACHED");
      else if (level.level === "breakeven") {
        eventLabels.push(BREAKEVEN_EXIT_REACHED_LABEL);
        breakevenDisposition = "BREAKEVEN_EXIT_REACHED";
      } else {
        eventLabels.push(level.level === "strategy" ? "STRATEGY_STOP_REACHED" : "CATASTROPHE_STOP_REACHED");
        if (!breakevenActivated && breakevenMode !== "recovery") {
          eventLabels.push(ORIGINAL_STOP_REACHED_BEFORE_BREAKEVEN_LABEL);
          breakevenDisposition = "ORIGINAL_STOP_REACHED_BEFORE_BREAKEVEN";
        }
      }
      const gapThrough = input.direction === "long" ? candle.open <= resolvedStopPrice! : candle.open >= resolvedStopPrice!;
      const reference = gapThrough ? candle.open : resolvedStopPrice!;
      if (gapThrough) eventLabels.push("GAP_THROUGH_STOP");
      const fill = tick(input.direction === "long" ? reference - (input.exitSlippageTicks ?? 0) * size : reference + (input.exitSlippageTicks ?? 0) * size, size);
      legs.push(makeLeg(
        targetHit || oneRReached ? "runner" : "full",
        targetHit || oneRReached ? runnerQuantity : remaining,
        reference,
        fill,
        level.level === "breakeven" ? "breakeven" : "stop",
        candle,
        orderedEvent?.kind === "stop" ? orderedEvent.point : null,
      ));
      if ((targetHit || oneRReached) && runnerQuantity > 0) runnerExited = true;
      originalStopStillActive = level.level !== "breakeven";
      remaining = 0;
      exitPrice = fill;
      exitCandle = candle;
      exitReason = level.level === "strategy" && input.strategyStopExitReason
        ? input.strategyStopExitReason
        : level.level === "breakeven" ? "breakeven" : "stop";
      break;
    }
    if (recoveryReached) {
      eventLabels.push(BREAKEVEN_RECOVERY_EXIT_REACHED_LABEL);
      breakevenDisposition = "BREAKEVEN_RECOVERY_EXIT_REACHED";
      breakevenRecoveryExitTimestamp = typeof candle.closeTime === "number" && Number.isFinite(candle.closeTime)
        ? candle.closeTime
        : null;
      const quantityToExit = targetHit || oneRReached ? runnerQuantity : remaining;
      legs.push(makeLeg(
        targetHit || oneRReached ? "runner" : "full",
        quantityToExit,
        modeledFill,
        modeledFill,
        "breakeven_recovery",
        candle,
        orderedEvent?.kind === "recovery" ? orderedEvent.point : null,
      ));
      if ((targetHit || oneRReached) && runnerQuantity > 0) runnerExited = true;
      originalStopStillActive = false;
      remaining = 0;
      exitPrice = modeledFill;
      exitCandle = candle;
      exitReason = "breakeven_recovery";
      break;
    }
    if (targetReachedInCandle) {
      targetHit = true; targetCandle = candle;
      eventLabels.push("TARGET_REACHED");
      if (checkpointQuantity > 0) {
         const fill = tick(input.direction === "long" ? effectiveTarget! - (input.exitSlippageTicks ?? 0) * size : effectiveTarget! + (input.exitSlippageTicks ?? 0) * size, size);
          legs.push(makeLeg("target", checkpointQuantity, effectiveTarget!, fill, "target", candle, orderedEvent?.kind === "target" ? orderedEvent.point : null));
        remaining -= checkpointQuantity; exitPrice = fill; exitCandle = candle; exitReason = "target";
      }
       runnerBest = effectiveTarget!;
      trailingStopActive = structureTrailing && runnerQuantity > 0;
      if (trailingStopActive) {
        trailingStopPrice = initialStop === null ? null : tick(initialStop, size);
      }
      if (runnerQuantity > 0) eventLabels.push("RUNNER_ACTIVATED");
      if (runnerQuantity > 0) {
        runnerBreakevenPending = true;
        runnerBreakevenPendingCandleIndex = candleIndex;
        runnerBreakevenPendingTimestamp = typeof candle.closeTime === "number" && Number.isFinite(candle.closeTime)
          ? candle.closeTime
          : null;
      }
      if (runnerQuantity === 0) break;
    }
    if (oneRReachedInCandle) {
      oneRReached = true;
      trailingStopActive = structureTrailing && runnerQuantity > 0;
      profitCheckpointPrice = oneRPrice;
      if (trailingStopActive) {
        trailingStopPrice = initialStop === null ? null : tick(initialStop, size);
      }
      eventLabels.push("ONE_R_REACHED");
      if (noForwardLevelAtEntry && !breakevenActivated) {
        eventLabels.push(ONE_R_REACHED_BEFORE_BREAKEVEN_LABEL);
        breakevenDisposition = "ONE_R_REACHED_BEFORE_BREAKEVEN";
      }
      if (checkpointQuantity > 0) {
        const fill = tick(input.direction === "long" ? oneRPrice! - (input.exitSlippageTicks ?? 0) * size : oneRPrice! + (input.exitSlippageTicks ?? 0) * size, size);
        legs.push(makeLeg("target", checkpointQuantity, oneRPrice!, fill, "target", candle, orderedEvent?.kind === "oneR" ? orderedEvent.point : null));
        remaining -= checkpointQuantity;
        exitPrice = fill;
        exitCandle = candle;
        exitReason = "target";
      }
      if (runnerQuantity > 0) eventLabels.push("RUNNER_ACTIVATED");
      if (runnerQuantity > 0) {
        runnerBreakevenPending = true;
        runnerBreakevenPendingCandleIndex = candleIndex;
        runnerBreakevenPendingTimestamp = typeof candle.closeTime === "number" && Number.isFinite(candle.closeTime)
          ? candle.closeTime
          : null;
      }
      if (runnerQuantity === 0) break;
    }
    if (
      candleOrderedEvidenceComplete
      && runnerQuantity > 0
      && remaining > 0
      && (targetReachedInCandle || oneRReachedInCandle)
      && orderedEvent?.point
    ) {
      const runnerStopPoint = candleOrderedPoints
        .filter((point) =>
          point.timestamp > orderedEvent.point.timestamp
          && (typeof candle.openTime !== "number" || point.timestamp >= candle.openTime)
          && (typeof candle.closeTime !== "number" || point.timestamp <= candle.closeTime),
        )
        .find((point) => {
          const catastrophe = catastropheStop !== null
            && (input.direction === "long" ? point.price <= catastropheStop : point.price >= catastropheStop);
          const trailing = trailingStopActive
            && trailingStopPrice !== null
            && (input.direction === "long" ? point.price <= trailingStopPrice : point.price >= trailingStopPrice);
          const strategy = strategyStop !== null
            && (input.direction === "long" ? point.price <= strategyStop : point.price >= strategyStop);
          return catastrophe || trailing || strategy;
        });
      if (runnerStopPoint) {
        const catastrophe = catastropheStop !== null
          && (input.direction === "long" ? runnerStopPoint.price <= catastropheStop : runnerStopPoint.price >= catastropheStop);
        const trailing = !catastrophe
          && trailingStopActive
          && trailingStopPrice !== null
          && (input.direction === "long" ? runnerStopPoint.price <= trailingStopPrice : runnerStopPoint.price >= trailingStopPrice);
        const level = catastrophe
          ? { price: catastropheStop!, level: "catastrophe" as const }
          : trailing
            ? { price: trailingStopPrice!, level: "structure_trailing" as const }
            : { price: strategyStop!, level: "strategy" as const };
        resolvedStopPrice = tick(level.price, size);
        resolvedStopLevel = level.level;
        eventLabels.push(level.level === "catastrophe"
          ? "CATASTROPHE_STOP_REACHED"
          : level.level === "structure_trailing"
            ? "STRUCTURE_TRAILING_STOP_REACHED"
            : "STRATEGY_STOP_REACHED");
        const fill = tick(
          input.direction === "long"
            ? resolvedStopPrice - (input.exitSlippageTicks ?? 0) * size
            : resolvedStopPrice + (input.exitSlippageTicks ?? 0) * size,
          size,
        );
        legs.push(makeLeg("runner", remaining, resolvedStopPrice, fill, "stop", candle, runnerStopPoint));
        remaining = 0;
        runnerExited = true;
        originalStopStillActive = level.level !== "structure_trailing";
        exitPrice = fill;
        exitCandle = candle;
        exitReason = level.level === "strategy" && input.strategyStopExitReason
          ? input.strategyStopExitReason
          : "stop";
        break;
      }
    }
    const activatedThisCandle = oneRReachedInCandle || targetReachedInCandle;
    if (!activatedThisCandle && (targetHit || oneRReached) && runnerQuantity > 0 && !structureTrailing) {
      const candidateBest = input.direction === "long" ? Math.max(runnerBest, candle.high) : Math.min(runnerBest, candle.low);
      const impulse = Math.abs(runnerBest - modeledFill);
      const retracementThreshold = input.direction === "long"
        ? runnerBest - impulse * 0.4
        : runnerBest + impulse * 0.4;
      const thresholdTouched = input.direction === "long"
        ? candle.low <= retracementThreshold
        : candle.high >= retracementThreshold;
      if (impulse > 0 && thresholdTouched) {
        if (candidateBest !== runnerBest) {
          ambiguityLabels.push(AMBIGUOUS_RUNNER_SEQUENCE_LABEL, AMBIGUOUS_OHLCV_SEQUENCE_LABEL);
          eventLabels.push(AMBIGUOUS_RUNNER_SEQUENCE_LABEL);
        }
        const gapThrough = input.direction === "long"
          ? candle.open <= retracementThreshold
          : candle.open >= retracementThreshold;
        const reference = gapThrough ? candle.open : retracementThreshold;
        const fill = tick(input.direction === "long"
          ? reference - (input.exitSlippageTicks ?? 0) * size
          : reference + (input.exitSlippageTicks ?? 0) * size, size);
         legs.push(makeLeg("runner", runnerQuantity, reference, fill, "runner", candle));
        remaining = 0; runnerExited = true; eventLabels.push("RUNNER_EXITED"); exitPrice = fill; exitCandle = candle; exitReason = "runner"; break;
      }
      runnerBest = candidateBest;
    }
    if (structureTrailing && trailingStopActive) {
      const swing = completedSwing(candles, candleIndex, input.direction);
      if (swing) {
        const candidateStop = tick(
          input.direction === "long"
            ? swing.price - trailingBufferTicks * size
            : swing.price + trailingBufferTicks * size,
          size,
        );
        const advances = trailingStopPrice === null
          || (input.direction === "long" ? candidateStop > trailingStopPrice : candidateStop < trailingStopPrice);
        if (advances) {
          trailingStopPrice = candidateStop;
          trailingStopSource = `swing-${input.direction === "long" ? "low" : "high"}:${swing.price.toFixed(2)}`;
          eventLabels.push("STRUCTURE_TRAILING_STOP_ADVANCED");
        }
      }
    }
    if (
      runnerBreakevenPending
      && runnerQuantity > 0
      && runnerBreakevenPendingCandleIndex !== null
      && candleIndex > runnerBreakevenPendingCandleIndex
      && favorableClose(input.direction, candle.close, modeledFill)
    ) {
      runnerBreakevenQualificationTimestamp = typeof candle.closeTime === "number" && Number.isFinite(candle.closeTime)
        ? candle.closeTime
        : null;
      runnerBreakevenPreviousStopPrice = trailingStopPrice;
      const improves = trailingStopPrice === null
        || (input.direction === "long" ? modeledFill > trailingStopPrice : modeledFill < trailingStopPrice);
      if (improves) {
        trailingStopPrice = modeledFill;
        runnerBreakevenStopPrice = modeledFill;
        runnerBreakevenTightened = true;
        const nextCandle = candles[candleIndex + 1];
        runnerBreakevenEffectiveFromTimestamp = nextCandle
          && typeof nextCandle.openTime === "number"
          && Number.isFinite(nextCandle.openTime)
          ? nextCandle.openTime
          : null;
        trailingStopSource = "runner-breakeven-after-favorable-completed-candle";
        eventLabels.push(BREAKEVEN_STOP_ARMED_LABEL);
      } else {
        runnerBreakevenIgnoredForTighterStop = true;
      }
      runnerBreakevenPending = false;
      runnerBreakevenPendingCandleIndex = null;
    }
    if (
      breakevenActivationBars !== null
      &&
      !breakevenEvaluated
      && !targetHit
      && !oneRReached
      && remaining > 0
      && postEntryBar === breakevenActivationBars
    ) {
      breakevenEvaluated = true;
      breakevenActivationTimestamp = typeof candle.closeTime === "number" && Number.isFinite(candle.closeTime)
        ? candle.closeTime
        : null;
      const nextCandle = subsequentCandles[postEntryBar];
      breakevenEffectiveFromTimestamp = nextCandle
        && typeof nextCandle.openTime === "number"
        && Number.isFinite(nextCandle.openTime)
        ? nextCandle.openTime
        : null;
      const favorableExtreme = input.direction === "long"
        ? Math.max(modeledFill, ...candles.slice(firstPostEntryCandleIndex, candleIndex + 1).map((item) => item.high))
        : Math.min(modeledFill, ...candles.slice(firstPostEntryCandleIndex, candleIndex + 1).map((item) => item.low));
      const favorableExcursionR = initialRiskPoints && initialRiskPoints > 0
        ? Math.abs(favorableExtreme - modeledFill) / initialRiskPoints
        : 0;
      breakevenMfePrice = tick(favorableExtreme, size);
      breakevenMfePoints = Number(Math.abs(favorableExtreme - modeledFill).toFixed(10));
      breakevenMfeTicks = Number((breakevenMfePoints / size).toFixed(10));
      breakevenMfeR = Number(favorableExcursionR.toFixed(10));
      breakevenEvaluationClose = tick(candle.close, size);
      breakevenEvaluationCloseDisposition = favorableClose(input.direction, candle.close, modeledFill)
        ? "favorable"
        : candle.close === modeledFill
          ? "neutral"
          : "adverse";
      if (favorableExcursionR >= BREAKEVEN_FAVORABLE_EXCURSION_R
        && favorableClose(input.direction, candle.close, modeledFill)) {
        breakevenMode = "stop";
        breakevenActivated = true;
        breakevenPrice = modeledFill;
        originalStopStillActive = true;
        breakevenDisposition = "BREAKEVEN_STOP_ARMED";
        eventLabels.push(BREAKEVEN_STOP_ARMED_LABEL);
      } else if (favorableExcursionR < BREAKEVEN_FAVORABLE_EXCURSION_R
        && !favorableClose(input.direction, candle.close, modeledFill)) {
        breakevenMode = "recovery";
        originalStopStillActive = true;
        breakevenDisposition = "BREAKEVEN_RECOVERY_EXIT_ARMED";
        eventLabels.push(BREAKEVEN_RECOVERY_EXIT_ARMED_LABEL);
      }
    }
    if (
      input.dynamicTarget
      && !targetHit
      && !oneRReached
      && remaining > 0
      && effectiveTarget !== null
    ) {
      const recalculatedIndicatorValue = dynamicIndicatorValueAt(input.dynamicTarget, candle);
      if (recalculatedIndicatorValue !== null) {
        const proposedTarget = tick(
          input.direction === "long"
            ? recalculatedIndicatorValue - 8 * size
            : recalculatedIndicatorValue + 8 * size,
          size,
        );
        const previousEffectiveTarget = effectiveTarget;
        const nextCandle = candles[candleIndex + 1];
        const hasFollowingCandle = nextCandle !== undefined
          && typeof nextCandle.openTime === "number"
          && Number.isFinite(nextCandle.openTime);
        const effectiveFromTimestamp = hasFollowingCandle
          ? nextCandle.openTime!
          : null;
        const crossesEntry = input.direction === "long"
          ? proposedTarget <= modeledFill
          : proposedTarget >= modeledFill;
        const fartherAway = input.direction === "long"
          ? proposedTarget > previousEffectiveTarget
          : proposedTarget < previousEffectiveTarget;
        const canTighten = !crossesEntry && !fartherAway && proposedTarget !== previousEffectiveTarget;
        const pending = canTighten && !hasFollowingCandle;
        const tightened = canTighten && hasFollowingCandle;
        const reason: DynamicTargetUpdate["reason"] = crossesEntry
          ? "IGNORED_WOULD_CROSS_ENTRY"
          : fartherAway
            ? "IGNORED_FARTHER_AWAY"
            : pending
              ? "PENDING_NO_NEXT_CANDLE"
            : tightened
              ? "TIGHTENED"
              : "NO_CHANGE";
        const resultingEffectiveTarget = tightened ? proposedTarget : previousEffectiveTarget;
        targetUpdateLedger.push({
          candleOpenTime: typeof candle.openTime === "number" ? candle.openTime : null,
          candleCloseTime: typeof candle.closeTime === "number" ? candle.closeTime : null,
          indicator: input.dynamicTarget.source,
          previousIndicatorValue,
          recalculatedIndicatorValue,
          proposedTarget,
          previousEffectiveTarget,
          resultingEffectiveTarget,
          effectiveFromTimestamp,
          pending,
          tightened,
          fartherAwayIgnored: fartherAway,
          reason,
          calculationVersion: DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION,
          sourceFingerprint: input.dynamicTarget.sourceFingerprint ?? null,
        });
        previousIndicatorValue = recalculatedIndicatorValue;
        if (tightened) {
          effectiveTarget = resultingEffectiveTarget;
          eventLabels.push(DYNAMIC_TARGET_TIGHTENED_LABEL);
        } else if (fartherAway) {
          eventLabels.push(DYNAMIC_TARGET_FARTHER_UPDATE_IGNORED_LABEL);
        }
      }
    }
  }
  if (remaining > 0 && input.sessionCloseCandle) {
    const closeCandle = input.sessionCloseCandle;
    validCandle(closeCandle);
    const reference = tick(closeCandle.close, size);
    const fill = tick(
      input.direction === "long"
        ? reference - (input.exitSlippageTicks ?? 0) * size
        : reference + (input.exitSlippageTicks ?? 0) * size,
      size,
    );
     legs.push(makeLeg(targetHit || oneRReached ? "runner" : "full", remaining, reference, fill, "session_close", closeCandle));
    remaining = 0;
     runnerExited = (targetHit || oneRReached) && runnerQuantity > 0;
     originalStopStillActive = false;
    eventLabels.push("SESSION_CLOSE");
    if (runnerExited) eventLabels.push("RUNNER_EXITED");
    exitPrice = fill;
    exitCandle = closeCandle;
    exitReason = "session_close";
  }
  if (remaining > 0 && (targetHit || oneRReached) && runnerQuantity > 0) exitReason = "target";
  const accounting = legs.reduce<ModeledExecutionAccounting>((a, leg) => ({
    grossPnl: money(a.grossPnl + leg.grossPnl), slippage: money(a.slippage + leg.slippage),
    fees: money(a.fees + leg.fees), netPnl: money(a.netPnl + leg.netPnl),
  }), { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 });
  const modeledExitTimestamp = legs.at(-1)?.exitTimestamp ?? null;
  return {
     entryTrigger: entryReference, modeledFill, modeledFillTimestamp, stopPrice: resolvedStopPrice, targetPrice: effectiveTarget, exitPrice, exitReason, legs, accounting,
     audit: {
       eventLabels, labels: eventLabels, ambiguityLabels, assumptions, entryCandle: trigger, exitCandle, modeledExitTimestamp, targetHit,
       runnerActivated: (targetHit || oneRReached) && runnerQuantity > 0, runnerExited,
      strategyStopPrice: strategyStop === null ? null : tick(strategyStop, size),
      catastropheStopPrice: catastropheStop === null ? null : tick(catastropheStop, size),
       consolidationMidpointStop: input.consolidationMidpointStop
         ? {
           ...input.consolidationMidpointStop,
           activationTimestamp: modeledFillTimestamp
             ?? (typeof trigger.closeTime === "number" && Number.isFinite(trigger.closeTime) ? trigger.closeTime : null),
           stopHitTimestamp: input.strategyStopExitReason === CONSOLIDATION_MIDPOINT_REENTRY_STOP_EXIT_REASON
             ? modeledExitTimestamp
               ?? (typeof exitCandle?.closeTime === "number" && Number.isFinite(exitCandle.closeTime)
                 ? exitCandle.closeTime
                 : null)
             : null,
         }
         : null,
        stopLevel: exitReason === "stop"
          || exitReason === CONSOLIDATION_MIDPOINT_REENTRY_STOP_EXIT_REASON
          || exitReason === "breakeven"
          ? resolvedStopLevel
          : null,
      primaryLossExitLevel: input.primaryLossExitLevel ?? null,
       initialRiskPoints,
       oneRPrice,
       oneRReached,
        profitCheckpointPrice: profitCheckpointPrice ?? (targetHit ? effectiveTarget : null),
       trailingStopPrice,
       trailingStopActive,
       trailingStopSource,
        runnerReferencePrice: (targetHit || oneRReached) && runnerQuantity > 0 ? (targetHit ? effectiveTarget : oneRPrice) : null,
       runnerImpulse: (targetHit || oneRReached) && runnerQuantity > 0 ? Math.abs(runnerBest - modeledFill) : null,
       runnerMostFavorablePrice: (targetHit || oneRReached) && runnerQuantity > 0 ? runnerBest : null,
      remainingQuantity: remaining,
       noForwardLevelAtEntry,
       postEntryCompletedBars,
       breakevenActivationBars,
       breakevenActivated,
       breakevenActivationTimestamp,
       breakevenEffectiveFromTimestamp,
       breakevenPrice,
       breakevenDisposition,
        breakevenMfePrice,
        breakevenMfePoints,
        breakevenMfeTicks,
        breakevenMfeR,
        breakevenEvaluationClose,
        breakevenEvaluationCloseDisposition,
        breakevenRecoveryExitTimestamp,
        runnerBreakevenPendingTimestamp,
        runnerBreakevenQualificationTimestamp,
        runnerBreakevenEffectiveFromTimestamp,
        runnerBreakevenPreviousStopPrice,
        runnerBreakevenStopPrice,
        runnerBreakevenTightened,
        runnerBreakevenIgnoredForTighterStop,
       originalStopStillActive,
        dynamicTargetSource: input.dynamicTarget?.source ?? null,
         dynamicTargetReplayContext: input.dynamicTarget?.replayContext ?? null,
        initialTargetPrice: initialTarget,
        effectiveTargetPrice: effectiveTarget,
        targetUpdateLedger,
    },
     ambiguityLabels, eventLabels, assumptions,
  };
}