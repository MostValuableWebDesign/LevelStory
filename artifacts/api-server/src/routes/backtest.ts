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

const router: IRouter = Router();

router.get("/historical-data", async (req, res): Promise<void> => {
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

router.post("/backtest", async (req, res): Promise<void> => {
  const parsed = RunBacktestBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid backtest request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
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
    const resolvedReport = await report;
    res.json(RunBacktestResponse.parse(resolvedReport));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to run the causal backtest.";
    req.log.warn({ error: message }, "Rejected backtest request");
    res.status(400).json({ error: message });
  }
});

export default router;