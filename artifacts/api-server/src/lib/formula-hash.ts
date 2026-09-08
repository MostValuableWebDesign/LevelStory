import { createHash } from "node:crypto";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategy/config.js";
import type { BacktestRequest } from "./phase9.js";
import { KEY_LEVEL_TARGET_PLAN_VERSION } from "./strategy/key-level-targets.js";
import { DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION } from "./strategy/ohlcv-execution.js";

export const FIXED_FORMULA_VERSION = "phase9-fixed-formula-v19-causal-replay-context-driving-member-pending";

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
      patienceEntryBufferTicks: config.patienceEntryBufferTicks,
      ohlcvAmbiguityRule: "adverse-first-stop",
      runnerRetracementRatio: null,
      patienceStopFormula: "patience-extreme-buffered-by-causal-atr-stop-buffer",
      adaptiveManagement: {
        atrPeriod: config.executionManagementAtrPeriod,
         targetBuffer: "fixed 8 MES ticks (2.00 points), near side",
        stopBuffer: "clamp(ceil(atrTicks*0.10),4,8)",
        maximumRisk: "clamp(ceil(atrTicks*1.50),20,40)",
        breakevenBars: 6,
        breakevenExcursionR: 0.5,
        runnerBuffer: "clamp(ceil(atrTicks*0.10),4,8)",
        fixedContracts: config.executionManagementFixedContracts,
      },
      keyLevelTarget: {
          targetPlanVersion: KEY_LEVEL_TARGET_PLAN_VERSION,
          dynamicTargetCalculationVersion: DYNAMIC_TARGET_UPDATE_CALCULATION_VERSION,
         candidatePlacementMode: "NEAR_SIDE_8_TICKS",
         executableTargetBuffer: "8 MES ticks (2.00 points), entry-facing side",
        minimumTargetR: 1,
        maximumSearchDistance: "20 MES points",
         fallback: "exactly 1R when no eligible level",
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
      earlyOrbMomentum: {
        enabled: config.earlyOrbMomentumContinuationEnabled,
        eligibilityCutoffMinutes: config.earlyOrbMomentumEligibilityCutoffMinutes,
        minimumCloseDistanceTicks: config.earlyOrbMomentumMinimumCloseDistanceTicks,
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