import { Router, type IRouter } from "express";
import { GetDashboardOverviewQueryParams, GetDashboardOverviewResponse, GetMarketSnapshotQueryParams, GetMarketSnapshotResponse, ListFuturesContractSpecificationsResponse } from "@workspace/api-zod";
import { db, journalEntriesTable, riskSettingsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { createMarketSnapshot } from "../lib/market-data";
import { recordSnapshotEvaluations, toApiJournalEntry } from "../lib/phase8-journal";
import { summarizeDashboardEntries } from "../lib/dashboard-metrics";
import { getFuturesContractSpecification, listFuturesContractSpecifications } from "../lib/futures/contracts";
import { isTradingDate, previousTradingDate, sessionCalendarForContract, tradingDateForTimestamp } from "../lib/futures/session-calendar";

const router: IRouter = Router();

function parseOptionalQueryBoolean(value: unknown, fallback?: boolean): boolean | undefined {
  if (value === undefined) return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === true || raw === false) return raw;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`Boolean query value must be true or false, received "${String(raw)}".`);
}

router.get("/market/snapshot", async (req, res): Promise<void> => {
  const parsed = GetMarketSnapshotQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid market snapshot query");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [risk] = await db.select().from(riskSettingsTable).limit(1);
    const hasManualHigh = parsed.data.fibHigh !== undefined;
    const hasManualLow = parsed.data.fibLow !== undefined;
    if (hasManualHigh !== hasManualLow) {
      res.status(400).json({ error: "Manual Fibonacci correction requires both fibHigh and fibLow." });
      return;
    }
    const manualFibAnchors = hasManualHigh && hasManualLow
      ? { high: parsed.data.fibHigh!, low: parsed.data.fibLow! }
      : undefined;
     const premarketAvailable = parseOptionalQueryBoolean(
       req.query.premarketAvailable,
       parsed.data.premarketAvailable,
     );
     const snapshot = createMarketSnapshot(
       parsed.data.symbol,
       parsed.data.session,
       risk,
       manualFibAnchors,
       { targetDollars: parsed.data.targetDollars, slippageMode: parsed.data.slippageMode },
       {
         tradingDate: parsed.data.tradingDate,
         cursor: parsed.data.cursor,
         premarketAvailable,
       },
      );
      await recordSnapshotEvaluations(snapshot);
      res.json(GetMarketSnapshotResponse.parse(snapshot));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid futures contract.";
    req.log.warn({ error: message }, "Rejected market snapshot request");
    res.status(400).json({ error: message });
  }
});

router.get("/futures/contracts", (_req, res): void => {
  res.json(ListFuturesContractSpecificationsResponse.parse(listFuturesContractSpecifications()));
});

router.get("/dashboard/overview", async (req, res): Promise<void> => {
  try {
    const parsed = GetDashboardOverviewQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const calendar = sessionCalendarForContract(getFuturesContractSpecification("MES"));
    let tradingDate = parsed.data.tradingDate ?? tradingDateForTimestamp(Date.now(), calendar);
    if (!isTradingDate(tradingDate, calendar)) {
      if (parsed.data.tradingDate) {
        res.status(400).json({ error: `${tradingDate} is not a trading date.` });
        return;
      }
      tradingDate = previousTradingDate(tradingDate, calendar);
    }
    const [risk] = await db.select().from(riskSettingsTable).limit(1);
    const allEntries = await db.select().from(journalEntriesTable).orderBy(desc(journalEntriesTable.createdAt));
    const summary = summarizeDashboardEntries(allEntries, tradingDate);
    const data = {
      sessionPnl: summary.sessionPnl,
      sessionPnlPercent: risk && risk.accountSize > 0 ? Number(((summary.sessionPnl / risk.accountSize) * 100).toFixed(2)) : 0,
      maxDailyLoss: risk?.maxDailyLoss ?? 500,
      dailyLossUsed: risk?.dailyLossUsed ?? 0,
      tradeCount: summary.triggeredTradeCount,
      reviewCount: summary.reviewCount,
      triggeredTradeCount: summary.triggeredTradeCount,
      openTradeCount: summary.openTradeCount,
      closedTradeCount: summary.closedTradeCount,
      winCount: summary.winCount,
      lossCount: summary.lossCount,
      breakevenCount: summary.breakevenCount,
      winRate: summary.winRate,
      setupPerformance: summary.setupPerformance,
      checklistCompleted: 4,
      checklistTotal: 5,
      recentEntries: summary.recentEntries.map(toApiJournalEntry),
    };
    res.json(GetDashboardOverviewResponse.parse(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load dashboard overview.";
    req.log.warn({ error: message }, "Rejected dashboard overview request");
    res.status(400).json({ error: message });
  }
});

export default router;