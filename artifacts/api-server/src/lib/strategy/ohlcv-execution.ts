import type { Direction } from "./types.js";
import type { PrimaryLossExitReference } from "./key-level-targets.js";

export const MODELED_OHLCV_FILL_LABEL = "Modeled OHLCV Fill — Not a Quote-Based Fill";
export const AMBIGUOUS_OHLCV_SEQUENCE_LABEL = "Ambiguous intrabar sequence — adverse-first policy applied";
export const AMBIGUOUS_STOP_FIRST_LABEL = "AMBIGUOUS_STOP_FIRST";
export const AMBIGUOUS_RUNNER_SEQUENCE_LABEL = "AMBIGUOUS_RUNNER_SEQUENCE";
export const PRIMARY_LEVEL_EXIT_ARMED_LABEL = "PRIMARY_LEVEL_EXIT_ARMED";
export const PRIMARY_LEVEL_EXIT_REACHED_LABEL = "PRIMARY_LEVEL_EXIT_REACHED";

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
  exitReason: "target" | "runner" | "stop" | "manual" | "session_close";
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
  stopLevel: "primary_level" | "strategy" | "catastrophe" | null;
  primaryLossExitLevel: PrimaryLossExitReference | null;
  runnerReferencePrice: number | null;
  runnerImpulse: number | null;
  runnerMostFavorablePrice: number | null;
  remainingQuantity: number;
};

export type ModeledOhlcvExecution = {
  entryTrigger: number | null;
  modeledFill: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  exitPrice: number | null;
  exitReason: "target" | "runner" | "stop" | "manual" | "session_close" | "not filled";
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

function emptyResult(input: OhlcvExecutionInput, labels: string[] = []): ModeledOhlcvExecution {
  const assumptions = [
    MODELED_OHLCV_FILL_LABEL,
    "Historical OHLCV has no bid/ask; candle barriers are evaluated conservatively.",
    ...(input.primaryLossExitLevel
      ? [`Primary loss exit ${input.primaryLossExitLevel.id} is armed before the patience opposite-wick strategy stop; vicinity is ${input.primaryLossExitLevel.distanceTicks} ticks.`]
      : []),
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
      runnerReferencePrice: null, runnerImpulse: null,
      runnerMostFavorablePrice: null, remainingQuantity: input.quantity ?? input.contractQuantity ?? input.contracts ?? 0,
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
  const primaryStop = input.primaryLossExitLevel
    ? { price: input.primaryLossExitLevel.stopPrice, level: "primary_level" as const }
    : null;
  const stopCandidates = [
    primaryStop,
    strategyStop === null ? null : { price: strategyStop, level: "strategy" as const },
    catastropheStop === null ? null : { price: catastropheStop, level: "catastrophe" as const },
  ].filter((item): item is { price: number; level: "primary_level" | "strategy" | "catastrophe" } => item !== null);
  const fallbackStop = stopCandidates.filter((item) => item.level !== "primary_level").sort((first, second) =>
    input.direction === "long" ? second.price - first.price : first.price - second.price,
  )[0] ?? null;
  const convertedTarget = input.targetDollars == null
    ? (input.targetPrice ?? input.target ?? null)
    : (input.direction === "long"
      ? entryReference + (input.targetDollars / (input.tickValue ?? size * (input.pointMultiplier ?? 1))) * size
      : entryReference - (input.targetDollars / (input.tickValue ?? size * (input.pointMultiplier ?? 1))) * size);
  const target = convertedTarget == null ? null : tick(convertedTarget, size);
  const stopPrice = fallbackStop === null ? null : tick(fallbackStop.price, size);
  const eventLabels: string[] = [];
  const ambiguityLabels: string[] = [];
  const assumptions = [
    MODELED_OHLCV_FILL_LABEL,
    "Historical OHLCV has no bid/ask; candle barriers are evaluated conservatively.",
    "Stops are evaluated before targets when both are touched in one candle.",
    ...(input.primaryLossExitLevel
      ? [`Primary loss exit ${input.primaryLossExitLevel.id} is armed before the patience opposite-wick strategy stop; the strategy stop remains secondary.`]
      : []),
  ];
  const entryTouched = trigger !== null
    && (input.direction === "long" ? trigger.high >= entryReference : trigger.low <= entryReference);
  if (!trigger || !entryTouched || quantity === 0) return emptyResult({ ...input, targetPrice: target, stopPrice }, []);
  const modeledFill = tick(
    input.direction === "long"
      ? (trigger.open > entryReference ? trigger.open : entryReference) + (input.entrySlippageTicks ?? 0) * size
      : (trigger.open < entryReference ? trigger.open : entryReference) - (input.entrySlippageTicks ?? 0) * size,
    size,
  );
  const candles = [
    ...(input.evaluateEntryCandleForExit === false ? [] : (trigger ? [trigger] : [])),
    ...subsequentCandles,
  ];
  const runnerQuantity = quantity - targetQuantity;
  let remaining = quantity;
  let targetHit = false;
  let runnerExited = false;
  let exitReason: ModeledOhlcvExecution["exitReason"] = "manual";
  let exitPrice: number | null = null;
  let exitCandle: OhlcvCandle | null = null;
  let resolvedStopPrice = stopPrice;
  let runnerBest = modeledFill;
  let targetCandle: OhlcvCandle | null = null;
  const legs: ModeledExecutionLeg[] = [];
  let resolvedStopLevel: "primary_level" | "strategy" | "catastrophe" | null = null;
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
  for (const candle of candles) {
    const strategyHit = strategyStop !== null && (input.direction === "long" ? candle.low <= strategyStop : candle.high >= strategyStop);
    const catastropheHit = catastropheStop !== null && (input.direction === "long" ? candle.low <= catastropheStop : candle.high >= catastropheStop);
    const primaryHit = primaryStop !== null && (input.direction === "long" ? candle.low <= primaryStop.price : candle.high >= primaryStop.price);
    const adverse = primaryHit || strategyHit || catastropheHit;
    const favorable = target !== null && (input.direction === "long" ? candle.high >= target : candle.low <= target);
    if (adverse) {
      if (favorable) {
        eventLabels.push(AMBIGUOUS_STOP_FIRST_LABEL);
        ambiguityLabels.push(AMBIGUOUS_STOP_FIRST_LABEL, AMBIGUOUS_OHLCV_SEQUENCE_LABEL);
      }
      const level = primaryHit ? primaryStop! : fallbackStop!;
      resolvedStopPrice = tick(level.price, size);
      resolvedStopLevel = level.level;
      if (level.level === "primary_level") eventLabels.push(PRIMARY_LEVEL_EXIT_REACHED_LABEL);
      else eventLabels.push(level.level === "strategy" ? "STRATEGY_STOP_REACHED" : "CATASTROPHE_STOP_REACHED");
      const gapThrough = input.direction === "long" ? candle.open <= resolvedStopPrice! : candle.open >= resolvedStopPrice!;
      const reference = gapThrough ? candle.open : resolvedStopPrice!;
      if (gapThrough) eventLabels.push("GAP_THROUGH_STOP");
      const fill = tick(input.direction === "long" ? reference - (input.exitSlippageTicks ?? 0) * size : reference + (input.exitSlippageTicks ?? 0) * size, size);
       legs.push(makeLeg(targetHit ? "runner" : "full", targetHit ? runnerQuantity : remaining, reference, fill, "stop", candle));
      if (targetHit && runnerQuantity > 0) runnerExited = true;
      remaining = 0; exitPrice = fill; exitCandle = candle; exitReason = "stop"; break;
    }
    if (!targetHit && favorable) {
      targetHit = true; targetCandle = candle;
      eventLabels.push("TARGET_REACHED");
      if (targetQuantity > 0) {
        const fill = tick(input.direction === "long" ? target! - (input.exitSlippageTicks ?? 0) * size : target! + (input.exitSlippageTicks ?? 0) * size, size);
         legs.push(makeLeg("target", targetQuantity, target!, fill, "target", candle));
        remaining -= targetQuantity; exitPrice = fill; exitCandle = candle; exitReason = "target";
      }
      runnerBest = target!;
      if (runnerQuantity > 0) eventLabels.push("RUNNER_ACTIVATED");
      if (runnerQuantity === 0) break;
      continue;
    }
    if (targetHit && runnerQuantity > 0) {
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
     legs.push(makeLeg(targetHit ? "runner" : "full", remaining, reference, fill, "session_close", closeCandle));
    remaining = 0;
    runnerExited = targetHit && runnerQuantity > 0;
    eventLabels.push("SESSION_CLOSE");
    if (runnerExited) eventLabels.push("RUNNER_EXITED");
    exitPrice = fill;
    exitCandle = closeCandle;
    exitReason = "session_close";
  }
  if (remaining > 0 && targetHit && runnerQuantity > 0) exitReason = "target";
  const accounting = legs.reduce<ModeledExecutionAccounting>((a, leg) => ({
    grossPnl: money(a.grossPnl + leg.grossPnl), slippage: money(a.slippage + leg.slippage),
    fees: money(a.fees + leg.fees), netPnl: money(a.netPnl + leg.netPnl),
  }), { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 });
  return {
    entryTrigger: entryReference, modeledFill, stopPrice: resolvedStopPrice, targetPrice: target, exitPrice, exitReason, legs, accounting,
    audit: {
      eventLabels, labels: eventLabels, ambiguityLabels, assumptions, entryCandle: trigger, exitCandle, targetHit,
      runnerActivated: targetHit && runnerQuantity > 0, runnerExited,
      strategyStopPrice: strategyStop === null ? null : tick(strategyStop, size),
      catastropheStopPrice: catastropheStop === null ? null : tick(catastropheStop, size),
      stopLevel: exitReason === "stop" ? resolvedStopLevel : null,
      primaryLossExitLevel: input.primaryLossExitLevel ?? null,
      runnerReferencePrice: targetHit && runnerQuantity > 0 ? modeledFill : null,
      runnerImpulse: targetHit && runnerQuantity > 0 ? Math.abs(runnerBest - modeledFill) : null,
      runnerMostFavorablePrice: targetHit && runnerQuantity > 0 ? runnerBest : null,
      remainingQuantity: remaining,
    },
     ambiguityLabels, eventLabels, assumptions,
  };
}