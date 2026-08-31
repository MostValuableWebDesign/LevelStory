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

const emitProgress = (progress: {
  phase: "preparing" | "loading_sessions" | "replaying_sessions" | "building_ledger" | "projecting_candidates" | "building_snapshots";
  completedUnits: number;
  completedSessions: number;
  totalSessions: number;
  message: string;
}): void => {
  parentPort!.postMessage({
    type: "progress",
    progress: { ...progress, totalUnits: 100 },
  });
};

try {
  const request = workerData as VisualValidationRequest;
  emitProgress({
    phase: "preparing",
    completedUnits: 0,
    completedSessions: 0,
    totalSessions: 0,
    message: "Preparing historical replay",
  });
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
  const totalSessions = dataset.selectedDates?.length ?? 0;
  emitProgress({
    phase: "loading_sessions",
    completedUnits: 15,
    completedSessions: 0,
    totalSessions,
    message: `Loading ${totalSessions} trading session${totalSessions === 1 ? "" : "s"}`,
  });
  const report = runCausalBacktest({
    symbol: request.symbol,
    endDate: request.endDate,
    inSampleDays: request.inSampleDays,
    outOfSampleDays: request.outOfSampleDays,
    premarketAvailable: request.premarketAvailable,
    source: MULTI_CONTRACT_SOURCE,
    executionMode: "ohlcv_modeled",
  }, undefined, dataset, ({ completedSessions: completed, totalSessions: total }) => {
    emitProgress({
      phase: "replaying_sessions",
      completedUnits: total > 0 ? 15 + Math.round((completed / total) * 60) : 15,
      completedSessions: completed,
      totalSessions: total,
      message: `Replaying session ${Math.min(completed + 1, total)} of ${total}`,
    });
  });
  emitProgress({
    phase: "building_ledger",
    completedUnits: 80,
    completedSessions: totalSessions,
    totalSessions,
    message: "Finding confirmed P → E signals",
  });
  emitProgress({
    phase: "projecting_candidates",
    completedUnits: 90,
    completedSessions: totalSessions,
    totalSessions,
    message: "Creating authoritative trade candidates",
  });
  const set = buildHistoricalVisualValidationSetFromReport(request, dataset, report);
  emitProgress({
    phase: "building_snapshots",
    completedUnits: 99,
    completedSessions: totalSessions,
    totalSessions,
    message: "Building chart review snapshots",
  });
  parentPort.postMessage({ type: "result", set });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : "Visual-validation worker failed.",
  });
} finally {
  // Give the parent thread a turn to receive the final result/error message.
  setImmediate(() => parentPort?.close());
}