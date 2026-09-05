import { createHash } from "node:crypto";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategy/config.js";
import type { BacktestRequest } from "./phase9.js";

export const FIXED_FORMULA_VERSION = "phase9-fixed-formula-v11-adaptive-target-runner-audit";

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formulaConfiguration(
  request: Pick<BacktestRequest, "symbol">,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): Record<string, unknown> {
  return {
    version: FIXED_FORMULA_VERSION,
    symbol: request.symbol,
    strategy: config,
    fixedConstraints: {
      completedBarOnly: true,
      immediateNextCandleOnly: true,
      noFutureData: true,
      noParameterOptimization: true,
      ohlcvAmbiguityRule: "adverse-first-stop",
      runnerRetracementRatio: null,
      patienceStopFormula: "patience-extreme-buffered-by-causal-atr-stop-buffer",
      adaptiveManagement: {
        atrPeriod: config.executionManagementAtrPeriod,
        targetBuffer: "clamp(ceil(atrTicks*0.05),1,2)",
        stopBuffer: "clamp(ceil(atrTicks*0.10),4,8)",
        maximumRisk: "clamp(ceil(atrTicks*1.50),20,40)",
        breakevenBars: 6,
        breakevenExcursionR: 0.5,
        runnerBuffer: "clamp(ceil(atrTicks*0.10),4,8)",
        fixedContracts: config.executionManagementFixedContracts,
      },
      keyLevelTarget: {
        candidatePlacementMode: "NEAR_SIDE_ADAPTIVE_TICKS",
        maximumTargetR: 1.5,
        minimumTargetR: { oneContract: 0.75, twoContracts: 0.5 },
      },
      shadowContractsPerTrade: config.executionManagementFixedContracts,
      qualifyingKeyLevelInteraction: {
        persisted: true,
        causalTimestamp: "L",
        allowedInteractionTypes: ["touch", "proximity", "consolidation", "break and reclaim", "hold"],
        fibonacciOnly: false,
      },
      primaryEntryWindow: {
        version: config.primaryEntryWindowVersion,
        timeZone: config.sessionTimeZone,
        startMinutes: config.primaryEntryStartMinutes,
        endMinutes: config.primaryEntryEndMinutes,
        completedFiveMinuteCandlesOnly: true,
      },
    },
  };
}

export function formulaConfigurationHash(
  request: Pick<BacktestRequest, "symbol">,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): string {
  return createHash("sha256").update(stableSerialize(formulaConfiguration(request, config))).digest("hex");
}