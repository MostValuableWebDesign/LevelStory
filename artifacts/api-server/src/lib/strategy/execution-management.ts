import type { Direction } from "./types.js";

export const EXECUTION_MANAGEMENT_ATR_PERIOD = 14;
export const MIN_TARGET_BUFFER_TICKS = 1;
export const MAX_TARGET_BUFFER_TICKS = 2;
export const MIN_STOP_BUFFER_TICKS = 4;
export const MAX_STOP_BUFFER_TICKS = 8;
export const MIN_STRUCTURAL_RISK_TICKS = 20;
export const MAX_STRUCTURAL_RISK_TICKS = 40;
export const MIN_TARGET_R_ONE_CONTRACT = 0.75;
export const MIN_TARGET_R_TWO_CONTRACTS = 0.5;
export const MAX_KEY_LEVEL_TARGET_R = 1.5;
export const BREAKEVEN_EVALUATION_BARS = 6;
export const BREAKEVEN_FAVORABLE_EXCURSION_R = 0.5;
export const DEFAULT_FIXED_CONTRACTS = 1;
export const RUNNER_BUFFER_MIN_TICKS = 4;
export const RUNNER_BUFFER_MAX_TICKS = 8;

export type ManagementCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  isComplete?: boolean;
};

export type AdaptiveExecutionManagement = {
  atrTicks: number;
  targetBufferTicks: number;
  stopBufferTicks: number;
  maximumRiskTicks: number;
  runnerBufferTicks: number;
};

function boundedCeil(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.ceil(value)));
}

/**
 * Computes a simple ATR from only completed candles. The first true range is
 * the candle range because there is no prior close in the causal window.
 */
export function causalAtrTicks(
  candles: readonly ManagementCandle[],
  tickSize: number,
  period = EXECUTION_MANAGEMENT_ATR_PERIOD,
): number | null {
  if (!Number.isFinite(tickSize) || tickSize <= 0 || !Number.isInteger(period) || period <= 0) return null;
  const completed = candles.filter((candle) =>
    candle.isComplete !== false
    && [candle.high, candle.low, candle.close].every(Number.isFinite),
  );
  if (completed.length < period) return null;
  const window = completed.slice(-period);
  let previousClose: number | null = null;
  const ranges = window.map((candle) => {
    const range = previousClose === null
      ? candle.high - candle.low
      : Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
    previousClose = candle.close;
    return range;
  });
  const atr = ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
  return Number.isFinite(atr) && atr >= 0 ? atr / tickSize : null;
}

export function adaptiveExecutionManagement(atrTicks: number | null): AdaptiveExecutionManagement {
  const safeAtrTicks = Number.isFinite(atrTicks) ? Math.max(0, atrTicks!) : 0;
  return {
    atrTicks: safeAtrTicks,
    targetBufferTicks: boundedCeil(safeAtrTicks * 0.05, MIN_TARGET_BUFFER_TICKS, MAX_TARGET_BUFFER_TICKS),
    stopBufferTicks: boundedCeil(safeAtrTicks * 0.10, MIN_STOP_BUFFER_TICKS, MAX_STOP_BUFFER_TICKS),
    maximumRiskTicks: boundedCeil(safeAtrTicks * 1.50, MIN_STRUCTURAL_RISK_TICKS, MAX_STRUCTURAL_RISK_TICKS),
    runnerBufferTicks: boundedCeil(safeAtrTicks * 0.10, RUNNER_BUFFER_MIN_TICKS, RUNNER_BUFFER_MAX_TICKS),
  };
}

export function targetMinimumR(contracts: number): number {
  return contracts === 1 ? MIN_TARGET_R_ONE_CONTRACT : MIN_TARGET_R_TWO_CONTRACTS;
}

export function initialStopForPatience(
  direction: Direction,
  patienceLow: number,
  patienceHigh: number,
  stopBufferTicks: number,
  tickSize: number,
): number {
  const raw = direction === "long"
    ? patienceLow - stopBufferTicks * tickSize
    : patienceHigh + stopBufferTicks * tickSize;
  return Number((Math.round(raw / tickSize) * tickSize).toFixed(10));
}

export function structuralRiskTicks(
  direction: Direction,
  entryPrice: number,
  stopPrice: number,
  tickSize: number,
): number {
  const distance = direction === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
  return Math.ceil(distance / tickSize - 1e-9);
}

export function favorableClose(
  direction: Direction,
  close: number,
  entry: number,
): boolean {
  return direction === "long" ? close > entry : close < entry;
}