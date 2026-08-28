import type { Direction } from "./types.js";

export const MODELED_OHLCV_FILL_LABEL = "Modeled OHLCV Fill — Not a Quote-Based Fill";
export const AMBIGUOUS_OHLCV_SEQUENCE_LABEL = "Ambiguous intrabar sequence — adverse-first policy applied";

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
  exitReason: "target" | "runner" | "stop" | "manual";
};

export type ModeledExecutionAccounting = {
  grossPnl: number;
  slippage: number;
  fees: number;
  netPnl: number;
};

export type OhlcvExecutionAudit = {
  labels: string[];
  assumptions: string[];
  entryCandle: OhlcvCandle | null;
  exitCandle: OhlcvCandle | null;
  targetHit: boolean;
  runnerActivated: boolean;
  runnerExited: boolean;
};

export type ModeledOhlcvExecution = {
  entryTrigger: number | null;
  modeledFill: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  exitPrice: number | null;
  exitReason: "target" | "runner" | "stop" | "manual" | "not filled";
  legs: ModeledExecutionLeg[];
  accounting: ModeledExecutionAccounting;
  audit: OhlcvExecutionAudit;
  ambiguityLabels: string[];
  assumptions: string[];
};
export type ModeledExecution = ModeledOhlcvExecution;
export type ModeledExecutionAudit = OhlcvExecutionAudit;

export type OhlcvExecutionInput = {
  direction: Direction;
  entry: number;
  patienceCandle: OhlcvCandle;
  immediateTriggerCandle?: OhlcvCandle | null;
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
  targetDollars?: number | null;
  tickSize: number;
  tickValue?: number;
  pointMultiplier?: number;
  entrySlippageTicks?: number;
  exitSlippageTicks?: number;
  fees?: OhlcvFeeComponents;
  feeComponents?: OhlcvFeeComponents;
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
  ];
  return {
    entryTrigger: null, modeledFill: null, stopPrice: input.stopPrice ?? input.stop ?? null,
    targetPrice: input.targetPrice ?? input.target ?? null, exitPrice: null, exitReason: "not filled",
    legs: [], accounting: { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 },
    audit: { labels, assumptions, entryCandle: null, exitCandle: null, targetHit: false, runnerActivated: false, runnerExited: false },
    ambiguityLabels: labels, assumptions,
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
  const stop = input.stopPrice ?? input.stop;
  const convertedTarget = input.targetDollars == null
    ? (input.targetPrice ?? input.target ?? null)
    : (input.direction === "long"
      ? entryReference + (input.targetDollars / (input.tickValue ?? size * (input.pointMultiplier ?? 1))) * size
      : entryReference - (input.targetDollars / (input.tickValue ?? size * (input.pointMultiplier ?? 1))) * size);
  const target = convertedTarget == null ? null : tick(convertedTarget, size);
  const stopPrice = stop == null ? null : tick(stop, size);
  const labels: string[] = [];
  const assumptions = [
    MODELED_OHLCV_FILL_LABEL,
    "Historical OHLCV has no bid/ask; candle barriers are evaluated conservatively.",
    "Stops are evaluated before targets when both are touched in one candle.",
  ];
  const entryTouched = trigger !== null
    && (input.direction === "long" ? trigger.high >= entryReference : trigger.low <= entryReference);
  if (!trigger || !entryTouched || quantity === 0) return emptyResult({ ...input, targetPrice: target, stopPrice }, labels);
  const modeledFill = tick(
    input.direction === "long"
      ? (trigger.open > entryReference ? trigger.open : entryReference) + (input.entrySlippageTicks ?? 0) * size
      : (trigger.open < entryReference ? trigger.open : entryReference) - (input.entrySlippageTicks ?? 0) * size,
    size,
  );
  const candles = [trigger, ...subsequentCandles];
  const runnerQuantity = quantity - targetQuantity;
  let remaining = quantity;
  let targetHit = false;
  let runnerExited = false;
  let exitReason: ModeledOhlcvExecution["exitReason"] = "manual";
  let exitPrice: number | null = null;
  let exitCandle: OhlcvCandle | null = null;
  let runnerBest = modeledFill;
  let targetCandle: OhlcvCandle | null = null;
  const legs: ModeledExecutionLeg[] = [];
  const multiplier = input.pointMultiplier ?? 1;
  const tickValue = input.tickValue ?? size * multiplier;
  const feePerSide = Object.values(input.fees ?? input.feeComponents ?? {}).reduce((sum, value) => sum + (value ?? 0), 0);
  const makeLeg = (kind: ModeledExecutionLeg["kind"], qty: number, reference: number, fill: number, reason: ModeledExecutionLeg["exitReason"]): ModeledExecutionLeg => {
    const sign = input.direction === "long" ? 1 : -1;
    const gross = (reference - entryReference) * qty * multiplier * sign;
    const entrySlip = Math.abs(modeledFill - entryReference) * qty * multiplier;
    const exitSlip = Math.abs(fill - reference) * qty * multiplier;
    const slip = entrySlip + exitSlip;
    const fees = feePerSide * qty * 2;
    return { kind, quantity: qty, referencePrice: tick(reference, size), fillPrice: tick(fill, size), grossPnl: money(gross), slippage: money(slip), fees: money(fees), netPnl: money(gross - slip - fees), exitReason: reason };
  };
  for (const candle of candles) {
    const adverse = stopPrice !== null && (input.direction === "long" ? candle.low <= stopPrice : candle.high >= stopPrice);
    const favorable = target !== null && (input.direction === "long" ? candle.high >= target : candle.low <= target);
    if (adverse) {
      if (favorable) labels.push(AMBIGUOUS_OHLCV_SEQUENCE_LABEL);
      const fill = tick(input.direction === "long" ? stopPrice! - (input.exitSlippageTicks ?? 0) * size : stopPrice! + (input.exitSlippageTicks ?? 0) * size, size);
      legs.push(makeLeg(targetHit ? "runner" : "full", targetHit ? runnerQuantity : remaining, stopPrice!, fill, "stop"));
      if (targetHit && runnerQuantity > 0) runnerExited = true;
      remaining = 0; exitPrice = fill; exitCandle = candle; exitReason = "stop"; break;
    }
    if (!targetHit && favorable) {
      targetHit = true; targetCandle = candle;
      if (targetQuantity > 0) {
        const fill = tick(input.direction === "long" ? target! - (input.exitSlippageTicks ?? 0) * size : target! + (input.exitSlippageTicks ?? 0) * size, size);
        legs.push(makeLeg("target", targetQuantity, target!, fill, "target"));
        remaining -= targetQuantity; exitPrice = fill; exitCandle = candle; exitReason = "target";
      }
      runnerBest = target!;
      if (runnerQuantity === 0) break;
      continue;
    }
    if (targetHit && runnerQuantity > 0) {
      runnerBest = input.direction === "long" ? Math.max(runnerBest, candle.high) : Math.min(runnerBest, candle.low);
      const current = tick(candle.close, size);
      const impulse = Math.abs(runnerBest - modeledFill);
      const retracement = input.direction === "long" ? runnerBest - current : current - runnerBest;
      if (impulse > 0 && retracement >= impulse * 0.4) {
        const fill = tick(input.direction === "long" ? current - (input.exitSlippageTicks ?? 0) * size : current + (input.exitSlippageTicks ?? 0) * size, size);
        legs.push(makeLeg("runner", runnerQuantity, current, fill, "runner"));
        remaining = 0; runnerExited = true; exitPrice = fill; exitCandle = candle; exitReason = "runner"; break;
      }
    }
  }
  if (remaining > 0 && targetHit && runnerQuantity > 0) exitReason = "target";
  const accounting = legs.reduce<ModeledExecutionAccounting>((a, leg) => ({
    grossPnl: money(a.grossPnl + leg.grossPnl), slippage: money(a.slippage + leg.slippage),
    fees: money(a.fees + leg.fees), netPnl: money(a.netPnl + leg.netPnl),
  }), { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 });
  return {
    entryTrigger: entryReference, modeledFill, stopPrice, targetPrice: target, exitPrice, exitReason, legs, accounting,
    audit: { labels, assumptions, entryCandle: trigger, exitCandle, targetHit, runnerActivated: targetHit && runnerQuantity > 0, runnerExited },
    ambiguityLabels: labels, assumptions,
  };
}