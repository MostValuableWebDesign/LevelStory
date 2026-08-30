import { createHash } from "node:crypto";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategy/config.js";
import type { BacktestRequest } from "./phase9.js";

export const FIXED_FORMULA_VERSION = "phase9-fixed-formula-v2";

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
      runnerRetracementRatio: 0.4,
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