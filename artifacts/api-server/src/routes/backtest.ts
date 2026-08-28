import { Router, type IRouter } from "express";
import { GetHistoricalDataResponse, RunBacktestBody, RunBacktestResponse } from "@workspace/api-zod";
import { db, riskSettingsTable } from "@workspace/db";
import { getFuturesContractSpecification } from "../lib/futures/contracts.js";
import {
  getHistoricalCsvImport,
  historicalImportToReplayDataset,
  publicHistoricalImportSummary,
} from "../lib/futures/historical-csv-import.js";
import { runCausalBacktest } from "../lib/phase9";
import {
  compactBacktestReport,
  getBacktestAuditPage,
  storeBacktestReport,
} from "../lib/backtest-store.js";
import { requestRateLimit, requestTimeout } from "../lib/security.js";

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
const MAX_BACKTEST_SESSIONS = 22;
const MAX_CALENDAR_RANGE_MS = 45 * 86_400_000;
const BACKTEST_TIMEOUT_MS = 120_000;
let activeBacktests = 0;

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

async function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("BACKTEST_TIMEOUT")), milliseconds);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

router.get("/historical-data", historicalRateLimit, requestTimeout(30_000), async (req, res): Promise<void> => {
  try {
    const specification = getFuturesContractSpecification(String(req.query.symbol ?? "MES"));
    const imported = await getHistoricalCsvImport(specification);
    res.json(GetHistoricalDataResponse.parse(publicHistoricalImportSummary(imported)));
  } catch (error) {
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

router.post("/backtest", backtestRateLimit, requestTimeout(BACKTEST_TIMEOUT_MS), async (req, res): Promise<void> => {
  const parsed = RunBacktestBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid backtest request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rangeError = validateBacktestRange(parsed.data);
  if (rangeError) {
    res.status(422).json({ error: rangeError });
    return;
  }
  if (activeBacktests >= 2) {
    res.setHeader("Retry-After", "30");
    res.status(429).json({ error: "Two backtests are already running. Try again shortly." });
    return;
  }
  activeBacktests += 1;
  try {
    const [risk] = await db.select().from(riskSettingsTable).limit(1);
    const report = parsed.data.source === "historical_databento"
      ? (() => {
          const specification = getFuturesContractSpecification(parsed.data.symbol);
          return getHistoricalCsvImport(specification).then((imported) => runCausalBacktest(
            parsed.data,
            risk,
            historicalImportToReplayDataset(
              imported,
              parsed.data.startDate ?? "2026-07-27",
              parsed.data.endDate,
              parsed.data.inSampleDays,
              parsed.data.outOfSampleDays,
            ),
          ));
        })()
      : Promise.resolve(runCausalBacktest(parsed.data, risk));
    const resolvedReport = await withTimeout(report, BACKTEST_TIMEOUT_MS);
    const runId = storeBacktestReport(resolvedReport);
    res.json(RunBacktestResponse.parse(compactBacktestReport(resolvedReport, runId)));
  } catch (error) {
    const message = error instanceof Error && error.message === "BACKTEST_TIMEOUT"
      ? "Backtest timed out. Reduce the historical range and try again."
      : "Unable to run the causal backtest with the supplied constraints.";
    req.log.warn({ error: error instanceof Error ? error.message : "unknown" }, "Rejected backtest request");
    res.status(error instanceof Error && error.message === "BACKTEST_TIMEOUT" ? 408 : 400).json({ error: message });
  } finally {
    activeBacktests -= 1;
  }
});

export default router;