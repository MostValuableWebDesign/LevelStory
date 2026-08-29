import { createHash } from "node:crypto";
import { DEFAULT_STRATEGY_CONFIG } from "./strategy/config.js";
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

export function formulaConfiguration(request: Pick<BacktestRequest, "symbol">): Record<string, unknown> {
  return {
    version: FIXED_FORMULA_VERSION,
    symbol: request.symbol,
    strategy: DEFAULT_STRATEGY_CONFIG,
    fixedConstraints: {
      completedBarOnly: true,
      immediateNextCandleOnly: true,
      noFutureData: true,
      noParameterOptimization: true,
      ohlcvAmbiguityRule: "adverse-first-stop",
      runnerRetracementRatio: 0.4,
    },
  };
}

export function formulaConfigurationHash(request: Pick<BacktestRequest, "symbol">): string {
  return createHash("sha256").update(stableSerialize(formulaConfiguration(request))).digest("hex");
}