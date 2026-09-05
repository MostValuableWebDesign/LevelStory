import type { Direction } from "./types.js";
import type { PrimaryLossExitReference } from "./key-level-targets.js";
import {
  BREAKEVEN_EVALUATION_BARS,
  BREAKEVEN_FAVORABLE_EXCURSION_R,
  favorableClose,
} from "./execution-management.js";

export const MODELED_OHLCV_FILL_LABEL = "Modeled OHLCV Fill — Not a Quote-Based Fill";
export const AMBIGUOUS_OHLCV_SEQUENCE_LABEL = "Ambiguous intrabar sequence — adverse-first policy applied";
export const AMBIGUOUS_STOP_FIRST_LABEL = "AMBIGUOUS_STOP_FIRST";
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
  isComplete?: boolean;
};

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
  targetHit: boolean;
  runnerActivated: boolean;
  runnerExited: boolean;
  strategyStopPrice: number | null;
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
};

export type ModeledOhlcvExecution = {
  entryTrigger: number | null;
  modeledFill: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  exitPrice: number | null;
  exitReason: "target" | "runner" | "stop" | "breakeven" | "breakeven_recovery" | "manual" | "session_close" | "not filled";
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
  patienceCandle: OhlcvCandle;
  immediateTriggerCandle?: OhlcvCandle | null;
  /**
   * Candidate-driven entries are observed at the trigger close. Their
   * trigger candle is evidence for entry only; exits begin on the next
   * completed candle.
   */
  evaluateEntryCandleForExit?: boolean;
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
  /** Candidate-owned runner management: use confirmed five-minute swings. */
  structureTrailing?: boolean;
  trailingBufferTicks?: number;
  /** Governed post-entry completed-bar delay before no-target breakeven management. */
  noLevelBreakevenActivationBars?: number;
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

function emptyResult(input: OhlcvExecutionInput, labels: string[] = []): ModeledOhlcvExecution {
  const noForwardLevelAtEntry = input.oneRProfitRule === true
    && (input.targetPrice ?? input.target ?? null) === null;
  const breakevenActivationBars = BREAKEVEN_EVALUATION_BARS;
  const assumptions = [
    MODELED_OHLCV_FILL_LABEL,
    "Historical OHLCV has no bid/ask; candle barriers are evaluated conservatively.",
  ];
  return {
    entryTrigger: null, modeledFill: null, stopPrice: input.stopPrice ?? input.stop ?? null,
    targetPrice: input.targetPrice ?? input.target ?? null, exitPrice: null, exitReason: "not filled",
    legs: [], accounting: { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 },
    audit: {
      eventLabels: labels, labels, ambiguityLabels: [], assumptions, entryCandle: null, exitCandle: null, targetHit: false,
      runnerActivated: false, runnerExited: false,
      strategyStopPrice: input.strategyStop ?? input.stopPrice ?? input.stop ?? null,
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
    },
    ambiguityLabels: [], eventLabels: labels, assumptions,
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
  validCandle(input.patienceCandle);
  const trigger = input.immediateTriggerCandle ?? null;
  if (trigger) validCandle(trigger);
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
  const target = convertedTarget == null ? null : tick(convertedTarget, size);
  const oneRProfitRule = input.oneRProfitRule === true && target === null;
  const noForwardLevelAtEntry = oneRProfitRule;
  const breakevenActivationBars = BREAKEVEN_EVALUATION_BARS;
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
    "Stops are evaluated before targets when both are touched in one candle.",
    ...(input.oneRProfitRule
      ? ["No eligible key-level target: 1R is the actual modeled fill-to-initial-stop distance; one contract exits fully at +1R, while multi-contract positions take one contract at +1R before trailing the remainder."]
      : []),
     `Progress-based breakeven/recovery is evaluated after ${breakevenActivationBars} completed post-entry candles; changes are effective on the following candle.`,
    ...(input.structureTrailing
      ? [`Structure trailing uses the most recent completed three-candle five-minute swing with an ${input.trailingBufferTicks ?? 8}-tick buffer and never widens.`]
      : []),
  ];
  const entryTouched = trigger !== null
    && (input.direction === "long" ? trigger.high >= entryReference : trigger.low <= entryReference);
  if (!trigger || !entryTouched || quantity === 0) {
    return emptyResult(
      { ...input, targetPrice: target, stopPrice },
      noForwardLevelAtEntry ? [NO_FORWARD_LEVEL_1R_PLAN_LABEL] : [],
    );
  }
  const modeledFill = tick(
    input.direction === "long"
      ? (trigger.open > entryReference ? trigger.open : entryReference) + (input.entrySlippageTicks ?? 0) * size
      : (trigger.open < entryReference ? trigger.open : entryReference) - (input.entrySlippageTicks ?? 0) * size,
    size,
  );
  const initialRiskPoints = initialStop === null ? null : Math.abs(modeledFill - initialStop);
  const oneRPrice = initialRiskPoints === null
    ? null
    : tick(input.direction === "long" ? modeledFill + initialRiskPoints : modeledFill - initialRiskPoints, size);
  const candles = [
    ...(input.evaluateEntryCandleForExit === false ? [] : (trigger ? [trigger] : [])),
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
  // Keep it null until the sixth-candle confirmation actually arms breakeven.
  let breakevenPrice: number | null = null;
  let breakevenDisposition: BreakevenDisposition = "PENDING";
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
  if (noForwardLevelAtEntry) eventLabels.push(NO_FORWARD_LEVEL_1R_PLAN_LABEL);
  const legs: ModeledExecutionLeg[] = [];
  let resolvedStopLevel: "strategy" | "catastrophe" | "structure_trailing" | "breakeven" | null = null;
  const multiplier = input.pointMultiplier ?? 1;
  const tickValue = input.tickValue ?? size * multiplier;
  const feePerSide = Object.values(input.fees ?? input.feeComponents ?? {}).reduce((sum, value) => sum + (value ?? 0), 0);
  const makeLeg = (kind: ModeledExecutionLeg["kind"], qty: number, reference: number, fill: number, reason: ModeledExecutionLeg["exitReason"], candle: OhlcvCandle): ModeledExecutionLeg => {
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
      if (!noLevelTimerStarted && noForwardLevelAtEntry) {
        noLevelTimerStarted = true;
        eventLabels.push(NO_LEVEL_BAR_TIMER_STARTED_LABEL);
      }
    }
    const activeTrailingStop = trailingStopActive && trailingStopPrice !== null ? trailingStopPrice : null;
    const breakevenStopArmed = breakevenMode === "stop";
    const recoveryExitArmed = breakevenMode === "recovery";
    const strategyHit = !breakevenStopArmed
      && activeTrailingStop === null
      && strategyStop !== null
      && (input.direction === "long" ? candle.low <= strategyStop : candle.high >= strategyStop);
    const catastropheHit = catastropheStop !== null
      && (input.direction === "long" ? candle.low <= catastropheStop : candle.high >= catastropheStop);
    const trailingHit = !breakevenStopArmed
      && activeTrailingStop !== null
      && (input.direction === "long" ? candle.low <= activeTrailingStop : candle.high >= activeTrailingStop);
    const breakevenHit = breakevenStopArmed
      && (input.direction === "long" ? candle.low <= modeledFill : candle.high >= modeledFill);
    const originalStopHit = strategyHit || catastropheHit || trailingHit;
    const adverse = catastropheHit || breakevenHit || originalStopHit;
    const favorable = target !== null && (input.direction === "long" ? candle.high >= target : candle.low <= target);
    const targetReachedInCandle = !targetHit && favorable;
    const oneRReachedInCandle = oneRProfitRule
      && !oneRReached
      && oneRPrice !== null
      && (input.direction === "long" ? candle.high >= oneRPrice : candle.low <= oneRPrice);
    const recoveryReached = recoveryExitArmed
      && (input.direction === "long"
        ? candle.open <= modeledFill && candle.high >= modeledFill
        : candle.open >= modeledFill && candle.low <= modeledFill);
    if (adverse) {
      if (favorable || oneRReachedInCandle || recoveryReached) {
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
      ));
      if ((targetHit || oneRReached) && runnerQuantity > 0) runnerExited = true;
      originalStopStillActive = level.level !== "breakeven";
      remaining = 0;
      exitPrice = fill;
      exitCandle = candle;
      exitReason = level.level === "breakeven" ? "breakeven" : "stop";
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
        const fill = tick(input.direction === "long" ? target! - (input.exitSlippageTicks ?? 0) * size : target! + (input.exitSlippageTicks ?? 0) * size, size);
         legs.push(makeLeg("target", checkpointQuantity, target!, fill, "target", candle));
        remaining -= checkpointQuantity; exitPrice = fill; exitCandle = candle; exitReason = "target";
      }
      runnerBest = target!;
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
        legs.push(makeLeg("target", checkpointQuantity, oneRPrice!, fill, "target", candle));
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
  return {
    entryTrigger: entryReference, modeledFill, stopPrice: resolvedStopPrice, targetPrice: target, exitPrice, exitReason, legs, accounting,
    audit: {
      eventLabels, labels: eventLabels, ambiguityLabels, assumptions, entryCandle: trigger, exitCandle, targetHit,
       runnerActivated: (targetHit || oneRReached) && runnerQuantity > 0, runnerExited,
      strategyStopPrice: strategyStop === null ? null : tick(strategyStop, size),
      catastropheStopPrice: catastropheStop === null ? null : tick(catastropheStop, size),
       stopLevel: exitReason === "stop" || exitReason === "breakeven" ? resolvedStopLevel : null,
      primaryLossExitLevel: input.primaryLossExitLevel ?? null,
       initialRiskPoints,
       oneRPrice,
       oneRReached,
       profitCheckpointPrice: profitCheckpointPrice ?? (targetHit ? target : null),
       trailingStopPrice,
       trailingStopActive,
       trailingStopSource,
       runnerReferencePrice: (targetHit || oneRReached) && runnerQuantity > 0 ? (targetHit ? target : oneRPrice) : null,
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
    },
     ambiguityLabels, eventLabels, assumptions,
  };
}