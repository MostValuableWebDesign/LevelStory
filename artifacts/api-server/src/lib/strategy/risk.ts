import type { Direction } from "./types.js";
import {
  dollarsForTicks,
  notionalValue,
  ticksBetween,
  type FuturesContractSpecification,
} from "../futures/contracts.js";

export type RiskState = { dailyLoss: number; trades: number; locked: boolean };
export type PositionPlan = {
  contracts: number;
  stopDistance: number;
  stopTicks: number;
  risk: number;
  value: number;
  allowed: boolean;
  reason: string;
};

export function positionSize(
  entry: number,
  stop: number,
  equity: number,
  state: RiskState,
  config: { riskPerTrade: number; dailyLossLimit: number; maxPositionValue: number; maxRiskTrades: number },
  specification: FuturesContractSpecification,
): PositionPlan {
  const stopDistance = Math.abs(entry - stop);
  const empty = (reason: string): PositionPlan => ({
    contracts: 0,
    stopDistance,
    stopTicks: 0,
    risk: 0,
    value: 0,
    allowed: false,
    reason,
  });
  if (state.locked || state.dailyLoss >= config.dailyLossLimit) return empty("daily loss lockout");
  if (state.trades >= config.maxRiskTrades) return empty("maximum daily risk trades reached");
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(equity) || equity <= 0) return empty("invalid account or entry value");
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return empty("invalid stop distance");

  let stopTicks: number;
  try {
    stopTicks = ticksBetween(entry, stop, specification);
  } catch {
    return empty("stop distance is not aligned to contract ticks");
  }
  if (stopTicks <= 0) return empty("invalid stop distance");
  const riskPerContract = dollarsForTicks(stopTicks, 1, specification);
  const valuePerContract = notionalValue(entry, 1, specification);
  const contracts = Math.max(
    0,
    Math.floor(
      Math.min(
        config.riskPerTrade / riskPerContract,
        config.maxPositionValue / valuePerContract,
        equity / valuePerContract,
      ),
    ),
  );
  return {
    contracts,
    stopDistance,
    stopTicks,
    risk: contracts * riskPerContract,
    value: contracts * valuePerContract,
    allowed: contracts > 0,
    reason: contracts ? "risk gates passed" : "insufficient account or position capacity",
  };
}