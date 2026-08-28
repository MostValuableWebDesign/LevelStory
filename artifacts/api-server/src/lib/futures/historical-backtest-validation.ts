import type { BacktestRequest } from "../phase9.js";
import { MULTI_CONTRACT_SOURCE } from "./multi-contract-replay.js";

export class HistoricalBacktestValidationError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "HistoricalBacktestValidationError";
  }
}

export function validateHistoricalBacktestSource(
  request: Pick<BacktestRequest, "source" | "symbol" | "executionMode">,
): void {
  const source = request.source ?? "simulated";
  const symbol = request.symbol.trim().toUpperCase();
  if (source === "historical_databento" || source === MULTI_CONTRACT_SOURCE) {
    if (symbol !== "MES") {
      throw new HistoricalBacktestValidationError(
        `Historical source ${source} only supports the exact MES root symbol.`,
      );
    }
    if (request.executionMode && request.executionMode !== "ohlcv_modeled") {
      throw new HistoricalBacktestValidationError(
        "Historical Databento replay requires modeled OHLCV execution; quote-based Shadow fills are unavailable.",
      );
    }
  }
  if (source === MULTI_CONTRACT_SOURCE && symbol !== "MES") {
    throw new HistoricalBacktestValidationError(
      "Multi-contract historical replay only supports MES.",
    );
  }
}