import { Router, type IRouter, type Request, type Response } from "express";
import { GetHistoricalDataResponse, RunBacktestBody, RunBacktestResponse } from "@workspace/api-zod";
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
} from "../lib/futures/multi-contract-replay.js";
import {
  BacktestRequestAbortedError,
  BacktestTimeoutError,
  runBacktestInWorker,
  type BacktestWorkerInput,
  type BacktestWorkerOptions,
} from "../lib/backtest-worker-client.js";
import type { BacktestReport } from "../lib/phase9.js";
import {
  compactBacktestReport,
  buildBacktestCacheKey,
  getCachedBacktestReport,
  getBacktestAuditPage,
  storeBacktestReport,
} from "../lib/backtest-store.js";
import { requestRateLimit, requestTimeout } from "../lib/security.js";

const MAX_BACKTEST_SESSIONS = 22;
const MAX_CALENDAR_RANGE_MS = 45 * 86_400_000;
export const BACKTEST_REQUEST_TIMEOUT_MS = 120_000;
export const BACKTEST_WORKER_DEADLINE_MS = 110_000;

type RiskSnapshot = NonNullable<BacktestWorkerInput["risk"]>;
type BacktestRunner = (
  input: BacktestWorkerInput,
  options: BacktestWorkerOptions,
) => Promise<BacktestReport>;

export type BacktestRouteConfig = {
  requestTimeoutMs?: number;
  workerDeadlineMs?: number;
  loadRisk?: () => Promise<RiskSnapshot | undefined>;
  runBacktest?: BacktestRunner;
};

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

function validateBacktestRange(request: { startDate?: string; endDate: string; inSampleDays: number; outOfSampleDays: number }): string | null {
  if (request.inSampleDays + request.outOfSampleDays > MAX_BACKTEST_SESSIONS) {
    return `A backtest may include at most ${MAX_BACKTEST_SESSIONS} selected sessions.`;
  }
  if (request.startDate) {
    const start = Date.parse(`${request.startDate}T00:00:00Z`);
    const end = Date.parse(`${request.endDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > MAX_CALENDAR_RANGE_MS) {
      return "The requested date range is invalid or exceeds the 45-day safety limit.";
    }
  }
  return null;
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

router.get("/historical-data", historicalRateLimit, requestTimeout(120_000), async (req, res): Promise<void> => {
  try {
    const source = String(req.query.source ?? "historical_databento");
    if (source === MULTI_CONTRACT_SOURCE) {
      const imported = await importHistoricalMultiContract();
      if (res.headersSent) return;
      res.json(GetHistoricalDataResponse.parse(imported.summary));
      return;
    }
    const specification = getFuturesContractSpecification(String(req.query.symbol ?? "MES"));
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
      const specification = getFuturesContractSpecification(parsed.data.symbol);
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
      const cacheKey = buildBacktestCacheKey({
        cacheVersion: "causal-backtest-v2",
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
      if (cached) {
        if (canWriteResponse(res)) {
          res.json(RunBacktestResponse.parse(compactBacktestReport(cached.report, cached.runId)));
        }
        return;
      }
      const remainingWorkerMs = Math.min(
        workerDeadlineMs,
        deadline.workerDeadlineAt - Date.now(),
      );
      if (remainingWorkerMs <= 0) throw new BacktestTimeoutError();
      const resolvedReport = await runBacktest(
        { request: parsed.data, risk, replayDataset },
        { timeoutMs: remainingWorkerMs, signal: deadline.signal },
      );
      if (deadline.signal.aborted) throw signalError(deadline.signal);
      const runId = storeBacktestReport(resolvedReport, cacheKey);
      if (canWriteResponse(res)) {
        res.json(RunBacktestResponse.parse(compactBacktestReport(resolvedReport, runId)));
      }
    } catch (error) {
      const timedOut = error instanceof BacktestTimeoutError
        || (error instanceof Error && error.message === "BACKTEST_TIMEOUT");
      const requestAborted = error instanceof BacktestRequestAbortedError
        || (deadline.signal.aborted && !timedOut);
      if (requestAborted || !canWriteResponse(res)) return;
      const message = timedOut
        ? "Backtest timed out. Reduce the historical range and try again."
        : "Unable to run the causal backtest with the supplied constraints.";
      req.log?.warn({ error: error instanceof Error ? error.message : "unknown" }, "Rejected backtest request");
      res.status(timedOut ? 408 : 500).json({ error: message });
    } finally {
      if (counted) activeBacktests -= 1;
      deadline.dispose();
    }
  });

  return router;
}

export default createBacktestRouter();