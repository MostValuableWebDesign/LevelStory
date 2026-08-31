import { parentPort, workerData } from "node:worker_threads";
import {
  buildHistoricalVisualValidationSetFromReport,
  type VisualValidationRequest,
} from "./visual-validation.js";
import {
  getReadyHistoricalMultiContractIndex,
  multiContractImportToReplayDataset,
  MULTI_CONTRACT_SOURCE,
} from "./futures/multi-contract-replay.js";
import { runCausalBacktest } from "./phase9.js";

if (!parentPort) {
  throw new Error("Visual-validation worker must be started by a parent thread.");
}

try {
  const request = workerData as VisualValidationRequest;
  if (request.symbol !== "MES") {
    throw new Error("Historical Databento visual review supports MES only.");
  }
  const imported = await getReadyHistoricalMultiContractIndex();
  if (!imported) {
    throw new Error("Historical Databento visual review is unavailable because the ready multi-contract index was not found. Load the existing historical index before generating a review set.");
  }
  const firstEligibleDate = imported.summary.eligibleTradingDates[0];
  if (!firstEligibleDate) {
    throw new Error("Historical Databento visual review is unavailable because the ready index contains no eligible MES trading dates.");
  }
  const dataset = multiContractImportToReplayDataset(
    imported,
    firstEligibleDate,
    request.endDate,
    request.inSampleDays,
    request.outOfSampleDays,
  );
  const report = runCausalBacktest({
    symbol: request.symbol,
    endDate: request.endDate,
    inSampleDays: request.inSampleDays,
    outOfSampleDays: request.outOfSampleDays,
    premarketAvailable: request.premarketAvailable,
    source: MULTI_CONTRACT_SOURCE,
    executionMode: "ohlcv_modeled",
  }, undefined, dataset);
  const set = buildHistoricalVisualValidationSetFromReport(request, dataset, report);
  parentPort.postMessage({ type: "result", set });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : "Visual-validation worker failed.",
  });
} finally {
  parentPort.close();
}