import type { Direction } from "./types.js";

/**
 * Versioned rule identity for the Strong Breakout midpoint-reentry stop.
 * Keep this separate from raw candle/cache identity: only strategy-derived
 * results need invalidation when this changes.
 */
export const CONSOLIDATION_MIDPOINT_STOP_CALCULATION_VERSION =
  "strong-breakout-midpoint-reentry-v1-integer-ticks";

export type FrozenConsolidationZone = {
  high: number;
  low: number;
};

export type ConsolidationMidpointStop = {
  direction: Direction;
  zoneHigh: number;
  zoneLow: number;
  rawMidpoint: number;
  strategyStop: number;
  tickSize: number;
  calculationVersion: typeof CONSOLIDATION_MIDPOINT_STOP_CALCULATION_VERSION;
};

/**
 * Calculate the first valid contract tick strictly beyond the frozen zone
 * midpoint. Prices are converted to integer tick coordinates before the
 * midpoint and strict inequalities are applied, so a half-tick midpoint is
 * never rounded first.
 */
export function consolidationMidpointStop(
  input: FrozenConsolidationZone & { direction: Direction; tickSize: number },
): ConsolidationMidpointStop | null {
  const { direction, high, low, tickSize } = input;
  if (
    !Number.isFinite(high)
    || !Number.isFinite(low)
    || !Number.isFinite(tickSize)
    || tickSize <= 0
    || high <= low
  ) return null;

  const lowTicks = Math.round(low / tickSize);
  const highTicks = Math.round(high / tickSize);
  if (!Number.isSafeInteger(lowTicks) || !Number.isSafeInteger(highTicks) || highTicks <= lowTicks) return null;

  const midpointNumeratorTicks = lowTicks + highTicks;
  const midpointTickFloor = Math.floor(midpointNumeratorTicks / 2);
  const midpointTickCeil = Math.ceil(midpointNumeratorTicks / 2);
  const strategyStopTicks = direction === "long"
    ? midpointTickCeil - 1
    : midpointTickFloor + 1;
  const rawMidpoint = (midpointNumeratorTicks / 2) * tickSize;
  const strategyStop = strategyStopTicks * tickSize;
  if (!Number.isFinite(rawMidpoint) || !Number.isFinite(strategyStop)) return null;

  return {
    direction,
    zoneHigh: high,
    zoneLow: low,
    rawMidpoint: Number(rawMidpoint.toFixed(10)),
    strategyStop: Number(strategyStop.toFixed(10)),
    tickSize,
    calculationVersion: CONSOLIDATION_MIDPOINT_STOP_CALCULATION_VERSION,
  };
}