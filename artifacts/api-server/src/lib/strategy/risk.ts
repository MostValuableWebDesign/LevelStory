import type { Direction } from "./types.js";

export type RiskState = { dailyLoss: number; trades: number; locked: boolean };
export type PositionPlan = { shares: number; stopDistance: number; risk: number; value: number; allowed: boolean; reason: string };
export function positionSize(entry: number, stop: number, equity: number, state: RiskState, config: { riskPerTrade: number; dailyLossLimit: number; maxPositionValue: number; maxRiskTrades: number }): PositionPlan {
  const stopDistance = Math.abs(entry - stop);
  if (state.locked || state.dailyLoss >= config.dailyLossLimit) return { shares: 0, stopDistance, risk: 0, value: 0, allowed: false, reason: "daily loss lockout" };
  if (state.trades >= config.maxRiskTrades) return { shares: 0, stopDistance, risk: 0, value: 0, allowed: false, reason: "maximum daily risk trades reached" };
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return { shares: 0, stopDistance, risk: 0, value: 0, allowed: false, reason: "invalid stop distance" };
  const shares = Math.max(0, Math.floor(Math.min(config.riskPerTrade / stopDistance, config.maxPositionValue / entry, equity / entry)));
  return { shares, stopDistance, risk: shares * stopDistance, value: shares * entry, allowed: shares > 0, reason: shares ? "risk gates passed" : "insufficient equity" };
}