import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  CancelBatchBacktestResponse,
  GetBatchBacktestStatusResponse,
  GetBatchFunnelQueryParams,
  GetBatchFunnelResponse,
  GetHistoricalDataResponse,
  GetHistoricalDataIndexStatusResponse,
  GetHistoricalEmaComparisonResponse,
  RunBacktestBody,
  RunBacktestResponse,
  StartBatchBacktestBody,
  StartBatchBacktestResponse,
  StartEdgeValidationPilotBody,
  StartEdgeValidationPilotResponse,
  GetEdgeValidationPilotStatusQueryParams,
  GetEdgeValidationPilotStatusResponse,
  CancelEdgeValidationPilotQueryParams,
  CancelEdgeValidationPilotResponse,
} from "@workspace/api-zod";
import { db, riskSettingsTable } from "@workspace/db";
import { getFuturesContractSpecification } from "../lib/futures/contracts.js";
import {
  getHistoricalCsvImport,
  historicalImportToReplayDataset,
  publicHistoricalImportSummary,
} from "../lib/futures/historical-csv-import.js";
import {
  importHistoricalMultiContract,
  multiContractImportToReplayDataset,
  MULTI_CONTRACT_SOURCE,
  getHistoricalMultiContractIndexStatus,
  getReadyHistoricalMultiContractIndex,
  assertMultiContractCoverageReconciles,
} from "../lib/futures/multi-contract-replay.js";
import {
  BacktestRequestAbortedError,
  BacktestTimeoutError,
  runBacktestInWorker,
  type BacktestWorkerInput,
  type BacktestWorkerOptions,
} from "../lib/backtest-worker-client.js";
import type { BacktestReport } from "../lib/phase9.js";
import { buildReplayDataset, type BacktestRequest } from "../lib/phase9.js";
import {
  runBatchBacktest,
  type BatchBacktestReport,
  type BatchBacktestRequest,
  type BatchBacktestProgress,
} from "../lib/batch-backtest.js";
import {
  compactBacktestReport,
  buildBacktestCacheKey,
  getCachedBacktestReport,
  getBacktestAuditPage,
  storeBacktestReport,
} from "../lib/backtest-store.js";
import { requestRateLimit, requestTimeout } from "../lib/security.js";
import { formulaConfigurationHash } from "../lib/formula-hash.js";
import { activeShadowStrategySnapshot } from "../lib/active-shadow-strategy.js";
import { HistoricalBacktestValidationError, validateHistoricalBacktestSource } from "../lib/futures/historical-backtest-validation.js";
import { MAX_BACKTEST_SESSIONS } from "@workspace/api-spec/constants";
import type { NormalizedCandle } from "../lib/futures/market-data-provider.js";
import {
  buildPhase3PilotManifest,
  buildPhase3PilotPartitions,
  createPhase3PilotCheckpointStore,
  PHASE3_IN_SAMPLE_DAYS,
  PHASE3_OUT_OF_SAMPLE_DAYS,
  PHASE3_TOTAL_DAYS,
  runPhase3EdgePilot,
  type Phase3PilotProgress,
  type Phase3PilotReport,
} from "../lib/phase3-edge-pilot.js";

const MAX_CALENDAR_RANGE_MS = 45 * 86_400_000;
const MAX_MULTI_CONTRACT_RANGE_MS = 400 * 86_400_000;
export const BACKTEST_REQUEST_TIMEOUT_MS = 120_000;
export const BACKTEST_WORKER_DEADLINE_MS = 110_000;
export const BATCH_BACKTEST_MAX_PARTITIONS = 60;
const EMA_COMPARISON_PERIOD = 200;
const EMA_COMPARISON_MAX_SELECTIONS = 3;

type EmaComparisonSeries = {
  contract: string;
  candles: NormalizedCandle[];
  values: Map<number, number>;
  warmup: Map<number, number>;
};

function independentlyCalculateEma(candles: NormalizedCandle[], period: number): EmaComparisonSeries {
  const sorted = candles
    .filter((candle) => candle.isComplete && candle.intervalMinutes === 5 && Number.isFinite(candle.close))
    .sort((left, right) => left.openTime - right.openTime);
  const values = new Map<number, number>();
  const warmup = new Map<number, number>();
  let ema: number | null = null;
  let sum = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    sum += sorted[index].close;
    if (index === period - 1) ema = sum / period;
    else if (index >= period) {
      const multiplier = 2 / (period + 1);
      ema = sorted[index].close * multiplier + ema! * (1 - multiplier);
    }
    if (ema !== null) {
      values.set(sorted[index].openTime, ema);
      warmup.set(sorted[index].openTime, index + 1);
    }
  }
  return { contract: sorted[0]?.contractSymbol ?? "MES", candles: sorted, values, warmup };
}

function buildHistoricalEmaComparison(
  source: "historical_databento" | typeof MULTI_CONTRACT_SOURCE,
  series: EmaComparisonSeries[],
  requestedTimestamps: string[],
) {
  const candidates = series.flatMap((item) => [...item.values.keys()].map((timestamp) => ({
    timestamp: new Date(timestamp).toISOString(),
    contract: item.contract,
    available: true,
  }))).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const selected = (requestedTimestamps.length ? requestedTimestamps : candidates.slice(-3).map((item) => item.timestamp))
    .slice(0, EMA_COMPARISON_MAX_SELECTIONS);
  const rows = selected.map((isoTimestamp) => {
    const timestamp = Date.parse(isoTimestamp);
    const item = series.find((candidate) => candidate.values.has(timestamp));
    const candle = item?.candles.find((candidate) => candidate.openTime === timestamp);
    const independentEma = item?.values.get(timestamp) ?? null;
    const sourceClose = candle?.close ?? null;
    return {
      timestamp: new Date(timestamp).toISOString(),
      contract: item?.contract ?? "MES",
      cmeSessionTemplate: "CME equity-index / America/New_York · 04:00–16:00 ET with 16:00–18:00 maintenance",
      warmupCount: item?.warmup.get(timestamp) ?? 0,
      period: EMA_COMPARISON_PERIOD,
      sourceRange: {
        earliest: item?.candles[0] ? new Date(item.candles[0].openTime).toISOString() : null,
        latest: item?.candles.at(-1) ? new Date(item.candles.at(-1)!.openTime).toISOString() : null,
      },
      available: Boolean(candle && independentEma !== null),
      sourceClose,
      independentEma,
      differencePoints: sourceClose !== null && independentEma !== null ? sourceClose - independentEma : null,
      differenceTicks: sourceClose !== null && independentEma !== null ? (sourceClose - independentEma) / 0.25 : null,
    };
  });
  return {
    source,
    methodology: "Independent 200-period EMA, seeded with the SMA of the first 200 complete uploaded 5-minute closes; no NinjaTrader calculation was imported.",
    inputMatch: false,
    inputMatchNote: "NinjaTrader inputs are not available in this report. This uses uploaded Databento OHLCV, a fixed 5-minute interval, and the CME session template shown per row; it does not claim broker or platform equivalence.",
    candidates: candidates.slice(-12),
    rows,
  };
}

type RiskSnapshot = NonNullable<BacktestWorkerInput["risk"]>;
type BacktestRunner = (
  input: BacktestWorkerInput,
  options: BacktestWorkerOptions,
) => Promise<BacktestReport>;
type BatchPartitionRunner = BacktestRunner;

export type BacktestRouteConfig = {
  requestTimeoutMs?: number;
  workerDeadlineMs?: number;
  loadRisk?: () => Promise<RiskSnapshot | undefined>;
  runBacktest?: BacktestRunner;
  runBatchPartition?: BatchPartitionRunner;
  runPilotPartition?: BatchPartitionRunner;
};

type BatchRecord = {
  batchId: string;
  controller: AbortController;
  progress: BatchBacktestProgress;
  report: BatchBacktestReport | null;
  cacheKey: string | null;
};

const batchRuns = new Map<string, BatchRecord>();
const completedBatchCache = new Map<string, BatchBacktestReport>();

type PilotRecord = {
  controller: AbortController;
  progress: Phase3PilotProgress;
};

const pilotRuns = new Map<string, PilotRecord>();
const pilotCheckpointStore = createPhase3PilotCheckpointStore();

type RequestDeadline = {
  signal: AbortSignal;
  workerDeadlineAt: number;
  dispose: () => void;
};

function canWriteResponse(res: Response): boolean {
  return !res.headersSent && !res.writableEnded && !res.destroyed;
}

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new BacktestRequestAbortedError();
}

function createRequestDeadline(
  req: Request,
  res: Response,
  requestTimeoutMs: number,
  workerDeadlineMs: number,
): RequestDeadline {
  const startedAt = Date.now();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new BacktestTimeoutError());
  }, Math.max(0, requestTimeoutMs));
  const onRequestAborted = (): void => {
    if (!controller.signal.aborted) controller.abort(new BacktestRequestAbortedError());
  };
  const onResponseClosed = (): void => {
    if (!res.writableEnded) onRequestAborted();
  };
  req.once("aborted", onRequestAborted);
  res.once("close", onResponseClosed);
  return {
    signal: controller.signal,
    workerDeadlineAt: startedAt + Math.min(workerDeadlineMs, Math.max(1, requestTimeoutMs - 1)),
    dispose: () => {
      clearTimeout(deadlineTimer);
      req.removeListener("aborted", onRequestAborted);
      res.removeListener("close", onResponseClosed);
    },
  };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signalError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signalError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function validateBacktestRange(request: { source?: string; startDate?: string; endDate: string; inSampleDays: number; outOfSampleDays: number }): string | null {
  if (request.inSampleDays + request.outOfSampleDays > MAX_BACKTEST_SESSIONS) {
    return `A backtest may include at most ${MAX_BACKTEST_SESSIONS} selected sessions.`;
  }
  if (request.startDate) {
    const start = Date.parse(`${request.startDate}T00:00:00Z`);
    const end = Date.parse(`${request.endDate}T00:00:00Z`);
    const maximumRange = request.source === MULTI_CONTRACT_SOURCE
      ? MAX_MULTI_CONTRACT_RANGE_MS
      : MAX_CALENDAR_RANGE_MS;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > maximumRange) {
      return request.source === MULTI_CONTRACT_SOURCE
        ? "The requested multi-contract historical range is invalid or exceeds the 400-day safety limit."
        : "The requested date range is invalid or exceeds the 45-day safety limit.";
    }
  }
  return null;
}

function validateBatchRequest(request: BatchBacktestRequest): string | null {
  if (request.selectedDates && request.selectedDates.length > BATCH_BACKTEST_MAX_PARTITIONS) {
    return `A batch may include at most ${BATCH_BACKTEST_MAX_PARTITIONS} selected trading dates.`;
  }
  if (request.selectedDates) {
    const sorted = [...request.selectedDates].sort();
    const dates = [...new Set(request.selectedDates)];
    if (dates.length < 2 || dates.length !== request.selectedDates.length) {
      return "A batch requires at least two unique selected trading dates.";
    }
    if (sorted.some((date, index) => date !== request.selectedDates?.[index])) {
      return "Selected trading dates must be sorted in ascending order.";
    }
    if (request.outOfSampleDays >= dates.length) {
      return "A batch must include at least one in-sample trading date.";
    }
  }
  // An explicit sparse sample is already the caller's selected set. The
  // continuous-range safety limit must not reject valid distant holdouts.
  return request.selectedDates ? null : validateBacktestRange(request);
}

function batchStatus(record: BatchRecord) {
  return {
    batchId: record.batchId,
    ...record.progress,
    report: record.report,
    error: record.progress.status === "failed" || record.progress.status === "timed_out"
      ? record.progress.message
      : null,
  };
}

export function createBacktestRouter(config: BacktestRouteConfig = {}): IRouter {
  const router: IRouter = Router();
  const historicalRateLimit = requestRateLimit({
    windowMs: 60_000,
    max: 6,
    message: "Historical data requests are temporarily limited. Try again shortly.",
  });
  const backtestRateLimit = requestRateLimit({
    windowMs: 120_000,
    max: 3,
    message: "Backtest requests are temporarily limited. Try again shortly.",
  });
  const batchStatusRateLimit = requestRateLimit({
    windowMs: 60_000,
    max: 120,
    message: "Batch status polling is temporarily limited. Try again shortly.",
  });
  const auditRateLimit = requestRateLimit({
    windowMs: 60_000,
    max: 60,
    message: "Audit page requests are temporarily limited. Try again shortly.",
  });
  const requestTimeoutMs = config.requestTimeoutMs ?? BACKTEST_REQUEST_TIMEOUT_MS;
  const workerDeadlineMs = config.workerDeadlineMs ?? BACKTEST_WORKER_DEADLINE_MS;
  let activeBacktests = 0;
  const loadRisk = config.loadRisk ?? (async (): Promise<RiskSnapshot | undefined> => {
    const [risk] = await db.select().from(riskSettingsTable).limit(1);
    return risk;
  });
  const runBacktest = config.runBacktest ?? ((input, options) => runBacktestInWorker(input, options));

  router.post("/backtest/batch", backtestRateLimit, async (req, res): Promise<void> => {
    const parsed = StartBatchBacktestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const request = parsed.data as BatchBacktestRequest;
    try {
      validateHistoricalBacktestSource(request);
    } catch (error) {
      if (error instanceof HistoricalBacktestValidationError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      throw error;
    }
    const rangeError = validateBatchRequest(request);
    if (rangeError) {
      res.status(422).json({ error: rangeError });
      return;
    }
    const active = [...batchRuns.values()].filter((run) => run.progress.status === "queued" || run.progress.status === "running");
    if (active.length >= 1) {
      res.setHeader("Retry-After", "30");
      res.status(429).json({ error: "One qualification batch is already running. Try again shortly." });
      return;
    }
    const batchId = randomUUID();
    const controller = new AbortController();
    const selectedDates = request.selectedDates ?? [];
    const record: BatchRecord = {
      batchId,
      controller,
      progress: {
        status: "queued",
        totalPartitions: selectedDates.length,
        completedPartitions: 0,
        currentTradingDate: null,
        currentContractSymbol: null,
        message: "Batch accepted; preparing the causal dataset.",
      },
      report: null,
      cacheKey: null,
    };
    batchRuns.set(batchId, record);
    if (canWriteResponse(res)) res.status(202).json(StartBatchBacktestResponse.parse(batchStatus(record)));

    void (async () => {
      try {
        const risk = await loadRisk();
        if (controller.signal.aborted) throw new BacktestRequestAbortedError();
        const source = request.source ?? "simulated";
        validateHistoricalBacktestSource(request);
        const specification = getFuturesContractSpecification(
          source === MULTI_CONTRACT_SOURCE ? "MES" : request.symbol,
        );
        const selected = request.selectedDates?.slice().sort();
        const batchStart = selected?.[0] ?? request.startDate ?? request.endDate;
        const batchEnd = selected?.at(-1) ?? request.endDate;
        const batchInSampleDays = selected
          ? Math.max(1, selected.length - request.outOfSampleDays)
          : request.inSampleDays;
        const datasetRequest = {
          ...request,
          startDate: batchStart,
          endDate: batchEnd,
          inSampleDays: batchInSampleDays,
          outOfSampleDays: selected ? request.outOfSampleDays : request.outOfSampleDays,
        } satisfies BacktestRequest;
        const imported = source === "historical_databento"
          ? await getHistoricalCsvImport(specification)
          : null;
        const multiContract = source === MULTI_CONTRACT_SOURCE
          ? await importHistoricalMultiContract()
          : null;
        const replayDataset = imported
          ? historicalImportToReplayDataset(imported, batchStart, batchEnd, batchInSampleDays, request.outOfSampleDays, selected)
          : multiContract
            ? multiContractImportToReplayDataset(multiContract, batchStart, batchEnd, batchInSampleDays, request.outOfSampleDays, selected)
            : buildReplayDataset(request.symbol, datasetRequest);
        const cacheKey = buildBacktestCacheKey({
          cacheVersion: "qualification-batch-v2-walk-forward",
          formulaHash: formulaConfigurationHash(request, activeShadowStrategySnapshot().config),
          request,
          risk,
          contract: specification,
          executionPolicy: {
            entryBufferTicks: request.ohlcvEntryBufferTicks ?? 4,
            stopBufferTicks: request.ohlcvStopBufferTicks ?? 1,
            slippageTicks: request.ohlcvSlippageTicks ?? 1,
            commissionPerContract: request.ohlcvCommissionPerContract ?? null,
          },
          historicalSource: imported
            ? {
                fingerprint: imported.contentFingerprint,
                filename: imported.summary.filename,
                detectedSymbol: imported.summary.detectedSymbol,
                latestTimestamp: imported.summary.latestTimestamp,
              }
            : multiContract
              ? {
                  fingerprint: multiContract.contentFingerprint,
                  scheduleVersion: multiContract.summary.scheduleVersion,
                  files: multiContract.summary.files.map((file) => ({
                    contractSymbol: file.contractSymbol,
                    fingerprint: file.contentFingerprint,
                  })),
                }
              : null,
        });
        record.cacheKey = cacheKey;
        const cached = completedBatchCache.get(cacheKey);
        if (cached) {
          record.report = cached;
          record.progress = {
            status: "completed",
            totalPartitions: cached.batch.totalPartitions,
            completedPartitions: cached.batch.completedPartitions,
            currentTradingDate: null,
            currentContractSymbol: null,
            message: "Identical completed batch loaded from cache.",
          };
          return;
        }
        record.progress = {
          ...record.progress,
          status: "running",
          totalPartitions: selected?.length ?? batchInSampleDays + request.outOfSampleDays,
          message: "Causal batch is running.",
        };
        const report = await runBatchBacktest(
          { request, risk, replayDataset },
          {
            timeoutMs: workerDeadlineMs,
            signal: controller.signal,
            runPartition: config.runBatchPartition,
            onProgress: (progress) => { record.progress = progress; },
          },
        );
        if (controller.signal.aborted) throw new BacktestRequestAbortedError();
        completedBatchCache.set(cacheKey, report);
        record.report = report;
        record.progress = {
          status: "completed",
          totalPartitions: report.batch.totalPartitions,
          completedPartitions: report.batch.completedPartitions,
          currentTradingDate: null,
          currentContractSymbol: null,
          message: "All causal partitions completed; result is ready.",
        };
      } catch (error) {
        const timedOut = error instanceof BacktestTimeoutError || (error instanceof Error && error.message === "BACKTEST_TIMEOUT");
        const cancelled = controller.signal.aborted && !timedOut;
        record.report = null;
        record.progress = {
          ...record.progress,
          status: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
          currentTradingDate: null,
          currentContractSymbol: null,
          message: timedOut
            ? "Batch timed out before completion; no result was persisted."
            : cancelled
              ? "Batch cancelled before completion; no result was persisted."
              : `Batch failed before completion; no result was persisted. ${error instanceof Error ? error.message : "The selected sample is not replayable."}`,
        };
      }
    })();
  });

  router.get("/backtest/batch-status", batchStatusRateLimit, (req, res): void => {
    const batchId = typeof req.query.batchId === "string" ? req.query.batchId : "";
    const record = batchRuns.get(batchId);
    if (!record) {
      res.status(404).json({ error: "Batch not found or expired." });
      return;
    }
    res.json(GetBatchBacktestStatusResponse.parse(batchStatus(record)));
  });

  router.delete("/backtest/batch-cancel", backtestRateLimit, (req, res): void => {
    const batchId = typeof req.query.batchId === "string" ? req.query.batchId : "";
    const record = batchRuns.get(batchId);
    if (!record) {
      res.status(404).json({ error: "Batch not found." });
      return;
    }
    if (record.progress.status === "queued" || record.progress.status === "running") {
      record.controller.abort(new BacktestRequestAbortedError());
      record.progress = {
        ...record.progress,
        status: "cancelled",
        currentTradingDate: null,
        currentContractSymbol: null,
        message: "Cancellation requested; active worker is being terminated.",
      };
    }
    res.json(CancelBatchBacktestResponse.parse(batchStatus(record)));
  });

  router.post("/backtest/edge-pilot", backtestRateLimit, async (req, res): Promise<void> => {
    const parsed = StartEdgeValidationPilotBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const request = parsed.data;
    const selectedDates = [...request.selectedDates];
    if (selectedDates.some((date, index) => date !== [...selectedDates].sort()[index])) {
      res.status(400).json({ error: "Phase 3 dates must be sorted chronologically." });
      return;
    }
    const active = [...pilotRuns.values()].some((run) =>
      run.progress.status === "queued" || run.progress.status === "running");
    if (active) {
      res.setHeader("Retry-After", "30");
      res.status(409).json({ error: "A Phase 3 edge-validation pilot is already running." });
      return;
    }
    const readyIndex = await getReadyHistoricalMultiContractIndex();
    if (!readyIndex) {
      res.status(503).json({ error: "The ready multi-contract historical index is unavailable; no pilot was started." });
      return;
    }
    let dataset;
    try {
      dataset = multiContractImportToReplayDataset(
        readyIndex,
        selectedDates[0]!,
        selectedDates.at(-1)!,
        PHASE3_IN_SAMPLE_DAYS,
        PHASE3_OUT_OF_SAMPLE_DAYS,
        selectedDates,
      );
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "The selected pilot dates are not replayable." });
      return;
    }
    const pilotRequest: BacktestRequest = {
      symbol: "MES",
      source: "historical_databento_multicontract",
      startDate: selectedDates[0],
      endDate: selectedDates.at(-1)!,
      inSampleDays: PHASE3_IN_SAMPLE_DAYS,
      outOfSampleDays: PHASE3_OUT_OF_SAMPLE_DAYS,
      executionMode: "ohlcv_modeled",
      ohlcvEntryBufferTicks: request.ohlcvEntryBufferTicks,
      ohlcvStopBufferTicks: request.ohlcvStopBufferTicks,
      ohlcvSlippageTicks: request.ohlcvSlippageTicks,
      ohlcvCommissionPerContract: request.ohlcvCommissionPerContract,
    };
    let manifest;
    try {
      manifest = buildPhase3PilotManifest({
        dataset,
        request: pilotRequest,
        indexKey: readyIndex.summary.indexKey,
      });
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "The pilot manifest could not be frozen." });
      return;
    }
    const existingCheckpoint = await pilotCheckpointStore.load(manifest.manifestHash);
    const pilotId = existingCheckpoint?.pilotId ?? randomUUID();
    const controller = new AbortController();
    const record: PilotRecord = {
      controller,
      progress: {
        status: "queued",
        pilotId,
        totalPartitions: PHASE3_TOTAL_DAYS,
        completedPartitions: existingCheckpoint?.reports.length ?? 0,
        currentTradingDate: null,
        currentContractSymbol: null,
        manifestHash: manifest.manifestHash,
        message: existingCheckpoint
          ? "Pilot checkpoint found; resuming completed causal partitions."
          : "Pilot accepted; preparing the immutable research manifest.",
        report: undefined,
        error: null,
      },
    };
    pilotRuns.set(pilotId, record);
    if (canWriteResponse(res)) res.status(202).json(StartEdgeValidationPilotResponse.parse({
      ...record.progress,
      report: null,
    }));
    void (async () => {
      try {
        const risk = await loadRisk();
        const report = await runPhase3EdgePilot(
          {
            manifest,
            request: pilotRequest,
            partitions: buildPhase3PilotPartitions(dataset),
            risk,
            sourceFingerprintFiles: readyIndex.summary.files.map((file) => ({
              filename: file.filename,
              contractSymbol: file.contractSymbol,
              contentFingerprint: file.contentFingerprint,
            })),
          },
          {
            pilotId,
            timeoutMs: workerDeadlineMs,
            signal: controller.signal,
            loadCheckpoint: (hash) => pilotCheckpointStore.load(hash),
            saveCheckpoint: (checkpoint) => pilotCheckpointStore.save(checkpoint),
            runPartition: config.runPilotPartition ?? runBacktest,
            onProgress: (progress) => {
              record.progress = { ...record.progress, ...progress, report: progress.report ?? record.progress.report };
            },
          },
        );
        record.progress = {
          ...record.progress,
          status: "completed",
          completedPartitions: report.completedPartitions,
          currentTradingDate: null,
          currentContractSymbol: null,
          message: "Phase 3 edge-validation pilot completed.",
          report,
          error: null,
        };
      } catch (error) {
        const cancelled = controller.signal.aborted;
        record.progress = {
          ...record.progress,
          status: cancelled ? "cancelled" : "failed",
          currentTradingDate: null,
          currentContractSymbol: null,
          message: cancelled ? "Pilot cancellation requested." : "Phase 3 pilot failed before completion.",
          error: error instanceof Error ? error.message : "The pilot could not be completed.",
        };
      }
    })();
  });

  router.get("/backtest/edge-pilot-status", batchStatusRateLimit, (req, res): void => {
    const parsed = GetEdgeValidationPilotStatusQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const record = pilotRuns.get(parsed.data.pilotId);
    if (!record) {
      res.status(404).json({ error: "Phase 3 pilot not found or expired." });
      return;
    }
    res.json(GetEdgeValidationPilotStatusResponse.parse({
      ...record.progress,
      report: record.progress.report ?? null,
    }));
  });

  router.delete("/backtest/edge-pilot-cancel", backtestRateLimit, (req, res): void => {
    const parsed = CancelEdgeValidationPilotQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const record = pilotRuns.get(parsed.data.pilotId);
    if (!record) {
      res.status(404).json({ error: "Phase 3 pilot not found." });
      return;
    }
    if (record.progress.status === "queued" || record.progress.status === "running") {
      record.controller.abort(new BacktestRequestAbortedError());
      record.progress = {
        ...record.progress,
        status: "cancelled",
        currentTradingDate: null,
        currentContractSymbol: null,
        message: "Pilot cancellation requested; the active worker is being terminated.",
      };
    }
    res.json(CancelEdgeValidationPilotResponse.parse({
      ...record.progress,
      report: record.progress.report ?? null,
    }));
  });

  router.get("/backtest/batch-funnel", auditRateLimit, (req, res): void => {
    const parsed = GetBatchFunnelQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const record = batchRuns.get(parsed.data.batchId);
    if (!record?.report) {
      res.status(404).json({ error: "Completed batch not found or expired." });
      return;
    }
    const safePage = Math.max(1, Math.floor(parsed.data.page ?? 1));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(parsed.data.pageSize ?? 50)));
    const candidates = parsed.data.stage
      ? record.report.funnel.candidates.filter((candidate) => candidate.reachedStage === parsed.data.stage || (
        parsed.data.stage !== "final_exit"
        && candidate.primaryRejectionStage === parsed.data.stage
      ))
      : record.report.funnel.candidates;
    const start = (safePage - 1) * safePageSize;
    res.json(GetBatchFunnelResponse.parse({
      batchId: record.batchId,
      stage: parsed.data.stage ?? null,
      page: safePage,
      pageSize: safePageSize,
      total: candidates.length,
      hasMore: start + safePageSize < candidates.length,
      candidates: candidates.slice(start, start + safePageSize),
    }));
  });

router.get("/historical-data", historicalRateLimit, requestTimeout(120_000), async (req, res): Promise<void> => {
  try {
    const source = String(req.query.source ?? "historical_databento");
    const symbol = String(req.query.symbol ?? "MES").trim().toUpperCase();
    if (source === MULTI_CONTRACT_SOURCE) {
      if (symbol !== "MES") {
        res.status(422).json({ error: "Multi-contract historical replay only supports the exact MES root symbol." });
        return;
      }
      const imported = await importHistoricalMultiContract();
      if (res.headersSent) return;
      assertMultiContractCoverageReconciles(imported.summary);
      res.json(GetHistoricalDataResponse.parse(imported.summary));
      return;
    }
    const specification = getFuturesContractSpecification(symbol);
    const imported = await getHistoricalCsvImport(specification);
    if (res.headersSent) return;
    res.json(GetHistoricalDataResponse.parse(publicHistoricalImportSummary(imported)));
  } catch (error) {
    if (res.headersSent) return;
    const message = error instanceof Error ? error.message : "Unable to import the historical CSV.";
    req.log.warn({ error: message }, "Historical CSV import failed");
    res.status(400).json({ error: message });
  }
});

router.get("/historical-data/ema-comparison", historicalRateLimit, requestTimeout(120_000), async (req, res): Promise<void> => {
  try {
    const source = String(req.query.source ?? MULTI_CONTRACT_SOURCE) as "historical_databento" | typeof MULTI_CONTRACT_SOURCE;
    if (source !== "historical_databento" && source !== MULTI_CONTRACT_SOURCE) {
      res.status(400).json({ error: "Unsupported historical EMA comparison source." });
      return;
    }
    const requestedTimestamps = typeof req.query.timestamps === "string"
      ? req.query.timestamps.split(",").map((value) => value.trim()).filter((value) => value.length > 0 && Number.isFinite(Date.parse(value))).slice(0, EMA_COMPARISON_MAX_SELECTIONS)
      : [];
    const series: EmaComparisonSeries[] = [];
    if (source === MULTI_CONTRACT_SOURCE) {
      const imported = await importHistoricalMultiContract();
      for (const contract of imported.contracts.values()) {
        const calculated = independentlyCalculateEma(contract.fiveMinute, EMA_COMPARISON_PERIOD);
        if (calculated.values.size > 0) series.push(calculated);
      }
    } else {
      const imported = await getHistoricalCsvImport(getFuturesContractSpecification("MES"));
      series.push(independentlyCalculateEma(imported.fiveMinute, EMA_COMPARISON_PERIOD));
    }
    res.json(GetHistoricalEmaComparisonResponse.parse(buildHistoricalEmaComparison(source, series, requestedTimestamps)));
  } catch (error) {
    if (res.headersSent) return;
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to calculate the historical EMA comparison." });
  }
});

  router.get("/historical-data/status", historicalRateLimit, async (_req, res): Promise<void> => {
    const status = await getHistoricalMultiContractIndexStatus();
    res.status(status.state === "failed" ? 503 : 200).json(
      GetHistoricalDataIndexStatusResponse.parse(status),
    );
  });

router.get("/backtest/audit", auditRateLimit, (req, res): void => {
  const parsePositiveInteger = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const ambiguity = req.query.ambiguity;
  const filters = {
    decision: typeof req.query.decision === "string" ? req.query.decision.slice(0, 80) : undefined,
    date: typeof req.query.date === "string" ? req.query.date.slice(0, 10) : undefined,
    setup: typeof req.query.setup === "string" ? req.query.setup.slice(0, 100) : undefined,
    patience: typeof req.query.patience === "string" ? req.query.patience.slice(0, 80) : undefined,
    category: typeof req.query.category === "string" && ["WAITING", "FAILURE", "EXPIRED", "AMBIGUITY", "RISK_REJECTION", "POSITION_ACTIVE", "QUALIFIED"].includes(req.query.category)
      ? req.query.category as "WAITING" | "FAILURE" | "EXPIRED" | "AMBIGUITY" | "RISK_REJECTION" | "POSITION_ACTIVE" | "QUALIFIED"
      : undefined,
    ambiguity: ambiguity === "true" ? true : ambiguity === "false" ? false : undefined,
  };
  const page = getBacktestAuditPage(
    typeof req.query.runId === "string" ? req.query.runId : "",
    parsePositiveInteger(req.query.page, 1),
    parsePositiveInteger(req.query.pageSize, 50),
    filters,
  );
  if (!page) {
    res.status(404).json({ error: "Backtest run not found or expired." });
    return;
  }
  res.json(page);
});

  router.post("/backtest", backtestRateLimit, async (req, res): Promise<void> => {
    const deadline = createRequestDeadline(req, res, requestTimeoutMs, workerDeadlineMs);
    const requestStartedAt = Date.now();
    const preparationStartedAt = requestStartedAt;
    let counted = false;
    try {
      const parsed = RunBacktestBody.safeParse(req.body);
      if (!parsed.success) {
        req.log?.warn({ errors: parsed.error.message }, "Invalid backtest request");
        if (canWriteResponse(res)) res.status(400).json({ error: parsed.error.message });
        return;
      }
      const rangeError = validateBacktestRange(parsed.data);
      if (rangeError) {
        if (canWriteResponse(res)) res.status(422).json({ error: rangeError });
        return;
      }
      validateHistoricalBacktestSource(parsed.data);
      if (activeBacktests >= 2) {
        if (canWriteResponse(res)) {
          res.setHeader("Retry-After", "30");
          res.status(429).json({ error: "Two backtests are already running. Try again shortly." });
        }
        return;
      }
      activeBacktests += 1;
      counted = true;
      const risk = await abortable(Promise.resolve().then(() => loadRisk()), deadline.signal);
      if (deadline.signal.aborted) throw signalError(deadline.signal);
      const specification = getFuturesContractSpecification(
        parsed.data.source === MULTI_CONTRACT_SOURCE ? "MES" : parsed.data.symbol,
      );
      const imported = parsed.data.source === "historical_databento"
        ? await abortable(
            Promise.resolve().then(() => getHistoricalCsvImport(specification)),
            deadline.signal,
          )
        : null;
      const multiContract = parsed.data.source === MULTI_CONTRACT_SOURCE
        ? await abortable(
            Promise.resolve().then(() => importHistoricalMultiContract()),
            deadline.signal,
          )
        : null;
      if (deadline.signal.aborted) throw signalError(deadline.signal);
      const preparationMs = Date.now() - preparationStartedAt;
      const cacheLookupStartedAt = Date.now();
      const cacheKey = buildBacktestCacheKey({
        cacheVersion: "causal-backtest-v3-formula-hash",
        formulaHash: formulaConfigurationHash(parsed.data, activeShadowStrategySnapshot().config),
        request: parsed.data,
        risk,
        contract: specification,
        executionPolicy: {
          entryBufferTicks: parsed.data.ohlcvEntryBufferTicks ?? 4,
          stopBufferTicks: parsed.data.ohlcvStopBufferTicks ?? 1,
          slippageTicks: parsed.data.ohlcvSlippageTicks ?? 1,
          commissionPerContract: parsed.data.ohlcvCommissionPerContract ?? null,
        },
        historicalSource: imported
          ? {
              fingerprint: imported.contentFingerprint,
              filename: imported.summary.filename,
              detectedSymbol: imported.summary.detectedSymbol,
              latestTimestamp: imported.summary.latestTimestamp,
            }
          : multiContract
            ? {
                fingerprint: multiContract.contentFingerprint,
                scheduleVersion: multiContract.summary.scheduleVersion,
                files: multiContract.summary.files.map((file) => ({
                  contractSymbol: file.contractSymbol,
                  fingerprint: file.contentFingerprint,
                })),
              }
            : null,
      });
      const cached = getCachedBacktestReport(cacheKey);
      const cacheLookupMs = Date.now() - cacheLookupStartedAt;
      if (cached) {
        if (canWriteResponse(res)) {
          const validationStartedAt = Date.now();
          const response = RunBacktestResponse.parse(compactBacktestReport({
            ...cached.report,
            timing: {
              ...(cached.report.timing ?? {
                preparationMs: 0,
                cacheLookupMs: 0,
                cacheStoreMs: 0,
                workerStartupMs: 0,
                workerMs: 0,
                responseValidationMs: 0,
                totalMs: 0,
              }),
              preparationMs,
              cacheLookupMs,
              cacheStoreMs: 0,
              workerStartupMs: 0,
              responseValidationMs: Date.now() - validationStartedAt,
              totalMs: Date.now() - requestStartedAt,
            },
          }, cached.runId));
          res.json(response);
        }
        return;
      }
      const replayDataset = imported
        ? historicalImportToReplayDataset(
            imported,
            parsed.data.startDate ?? "2026-07-27",
            parsed.data.endDate,
            parsed.data.inSampleDays,
            parsed.data.outOfSampleDays,
          )
        : multiContract
          ? multiContractImportToReplayDataset(
              multiContract,
              parsed.data.startDate ?? "2025-08-27",
              parsed.data.endDate,
              parsed.data.inSampleDays,
              parsed.data.outOfSampleDays,
            )
        : undefined;
      if (deadline.signal.aborted) throw signalError(deadline.signal);
      const remainingWorkerMs = Math.min(
        workerDeadlineMs,
        deadline.workerDeadlineAt - Date.now(),
      );
      if (remainingWorkerMs <= 0) throw new BacktestTimeoutError();
      const workerStartedAt = Date.now();
      let workerStartupMs = 0;
      const resolvedReport = await runBacktest(
        { request: parsed.data, risk, replayDataset },
        {
          timeoutMs: remainingWorkerMs,
          signal: deadline.signal,
          onTiming: (timing) => {
            workerStartupMs = timing.workerStartupMs;
          },
        },
      );
      if (deadline.signal.aborted) throw signalError(deadline.signal);
      const workerMs = Date.now() - workerStartedAt;
      const cacheStoreStartedAt = Date.now();
      const runId = storeBacktestReport({
        ...resolvedReport,
        timing: {
          preparationMs,
          cacheLookupMs,
          cacheStoreMs: 0,
          workerStartupMs,
          workerMs,
          responseValidationMs: 0,
          totalMs: 0,
        },
      }, cacheKey);
      const cacheStoreMs = Date.now() - cacheStoreStartedAt;
      if (canWriteResponse(res)) {
        const validationStartedAt = Date.now();
        const response = RunBacktestResponse.parse(compactBacktestReport({
          ...resolvedReport,
          timing: {
            preparationMs,
            cacheLookupMs,
            cacheStoreMs,
            workerStartupMs,
            workerMs,
            responseValidationMs: Date.now() - validationStartedAt,
            totalMs: Date.now() - requestStartedAt,
          },
        }, runId));
        res.json(response);
      }
    } catch (error) {
      const timedOut = error instanceof BacktestTimeoutError
        || (error instanceof Error && error.message === "BACKTEST_TIMEOUT");
      const requestAborted = error instanceof BacktestRequestAbortedError
        || (deadline.signal.aborted && !timedOut);
      if (requestAborted || !canWriteResponse(res)) return;
      const message = error instanceof HistoricalBacktestValidationError
        ? error.message
        : timedOut
        ? "Backtest timed out. Reduce the historical range and try again."
        : "Unable to run the causal backtest with the supplied constraints.";
      req.log?.warn({ error: error instanceof Error ? error.message : "unknown" }, "Rejected backtest request");
      res.status(error instanceof HistoricalBacktestValidationError ? error.statusCode : timedOut ? 408 : 500).json({ error: message });
    } finally {
      if (counted) activeBacktests -= 1;
      deadline.dispose();
    }
  });

  return router;
}

export default createBacktestRouter();