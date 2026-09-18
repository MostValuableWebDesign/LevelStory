import { parentPort, workerData } from "node:worker_threads";
import {
  buildHistoricalVisualValidationPartialSet,
  buildHistoricalVisualValidationSetFromReport,
  type VisualValidationRequest,
} from "./visual-validation.js";
import { runBatchBacktest } from "./batch-backtest.js";
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
  if (!imported.summary.allObservedTradingDates.length) {
    throw new Error("No historical data available in the ready MES index.");
  }
  const dataset = multiContractImportToReplayDataset(
    imported,
    undefined,
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
  parentPort.postMessage({ type: "partial", set: buildHistoricalVisualValidationPartialSet(request, dataset, []) });
  const abortController = new AbortController();
  const report = await runBatchBacktest({
    request: {
      symbol: request.symbol,
      endDate: request.endDate,
      inSampleDays: request.inSampleDays,
      outOfSampleDays: request.outOfSampleDays,
      premarketAvailable: request.premarketAvailable,
      source: MULTI_CONTRACT_SOURCE,
      executionMode: "ohlcv_modeled",
      visualReviewEarlyOrbMomentum: request.earlyOrbMomentum,
      visualReviewEnabledStrategies: request.enabledStrategies,
      strategyConfigOverride: request.governedStrategy?.config,
      selectedDates: dataset.selectedDates ? [...dataset.selectedDates] : undefined,
    },
    replayDataset: dataset,
  }, {
    timeoutMs: 300_000,
    signal: abortController.signal,
    includeSensitivity: false,
    onProgress: ({ completedPartitions, totalPartitions, message }) => {
      emitProgress({
        phase: "replaying_sessions",
        completedUnits: totalPartitions > 0 ? 15 + Math.round((completedPartitions / totalPartitions) * 60) : 15,
        completedSessions: completedPartitions,
        totalSessions: totalPartitions,
        message: message ?? "Replaying historical session partitions.",
      });
    },
    runPartition: async ({ request: partitionRequest, risk, replayDataset }) => (
      runCausalBacktest(partitionRequest, risk, replayDataset)
    ),
    sessionCache: {
      catalogEntries: imported.summary.sessionCatalog,
      sourceIdentity: {
        source: MULTI_CONTRACT_SOURCE,
        contentFingerprint: imported.contentFingerprint,
        calendarVersion: imported.calendar.calendarVersion,
      },
      strategyIdentity: {
        version: request.governedStrategy?.versionId ?? "active",
        formulaHash: request.governedStrategy?.formulaHash ?? "active",
        enabledStrategies: request.enabledStrategies ?? null,
      },
    },
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
  const set = buildHistoricalVisualValidationSetFromReport(
    request,
    dataset,
    report,
    (snapshots, totalSnapshots) => {
      const snapshotCount = snapshots.length;
      emitProgress({
        phase: "building_snapshots",
        completedUnits: 90 + (totalSnapshots > 0 ? Math.floor(snapshotCount / totalSnapshots * 9) : 0),
        completedSessions: totalSessions, totalSessions,
        message: `Building chart review snapshots ${snapshotCount} of ${totalSnapshots}`,
      });
      if (snapshotCount !== 1 && snapshotCount !== totalSnapshots && snapshotCount % 5 !== 0) return;
      parentPort!.postMessage({
        type: "partial",
        set: buildHistoricalVisualValidationPartialSet(request, dataset, snapshots),
      });
    },
  );
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
