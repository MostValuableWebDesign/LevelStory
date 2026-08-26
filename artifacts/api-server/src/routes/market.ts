import { Router, type IRouter } from "express";
import { GetDashboardOverviewResponse, GetMarketSnapshotQueryParams, GetMarketSnapshotResponse, ListFuturesContractSpecificationsResponse } from "@workspace/api-zod";
import { db, journalEntriesTable, riskSettingsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { createMarketSnapshot } from "../lib/market-data";
import { listFuturesContractSpecifications } from "../lib/futures/contracts";
import type { SetupType } from "../lib/strategy/phase6";

const router: IRouter = Router();

function toApiJournalEntry(entry: typeof journalEntriesTable.$inferSelect) {
  return { ...entry, createdAt: entry.createdAt.toISOString() };
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
     res.json(GetMarketSnapshotResponse.parse(createMarketSnapshot(
       parsed.data.symbol,
       parsed.data.session,
       risk,
       manualFibAnchors,
       { targetDollars: parsed.data.targetDollars, slippageMode: parsed.data.slippageMode },
     )));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid futures contract.";
    req.log.warn({ error: message }, "Rejected market snapshot request");
    res.status(400).json({ error: message });
  }
});

router.get("/futures/contracts", (_req, res): void => {
  res.json(ListFuturesContractSpecificationsResponse.parse(listFuturesContractSpecifications()));
});

router.get("/dashboard/overview", async (_req, res): Promise<void> => {
  const [risk] = await db.select().from(riskSettingsTable).limit(1);
  const entries = await db.select().from(journalEntriesTable).orderBy(desc(journalEntriesTable.createdAt)).limit(5);
  const performanceEntries = await db.select().from(journalEntriesTable);
  const pnl = entries.reduce((total, entry) => total + (entry.pnl ?? 0), 0);
  const wins = entries.filter((entry) => (entry.pnl ?? 0) > 0).length;
  const setupTypes: SetupType[] = [
    "ORB_BREAK_PULLBACK_CONTINUATION",
    "EXTENDED_NTZ_CONSOLIDATION_BREAKOUT",
    "BONUS_REVERSAL",
  ];
  const setupPerformance = setupTypes.map((setupType) => {
    const setupEntries = performanceEntries.filter((entry) => entry.setup === setupType);
    const closed = setupEntries.filter((entry) => entry.pnl !== null);
    const setupWins = closed.filter((entry) => (entry.pnl ?? 0) > 0).length;
    return {
      setupType,
      reviewCount: setupEntries.length,
      closedCount: closed.length,
      wins: setupWins,
      losses: closed.filter((entry) => (entry.pnl ?? 0) < 0).length,
      winRate: closed.length ? Number(((setupWins / closed.length) * 100).toFixed(1)) : 0,
      netPnl: Number(setupEntries.reduce((total, entry) => total + (entry.pnl ?? 0), 0).toFixed(2)),
    };
  });
  const data = {
    sessionPnl: Number(pnl.toFixed(2)),
    sessionPnlPercent: risk && risk.accountSize > 0 ? Number(((pnl / risk.accountSize) * 100).toFixed(2)) : 0,
    maxDailyLoss: risk?.maxDailyLoss ?? 500,
    dailyLossUsed: risk?.dailyLossUsed ?? 0,
    tradeCount: entries.length,
    winRate: entries.length ? Number(((wins / entries.length) * 100).toFixed(1)) : 0,
    setupPerformance,
    checklistCompleted: 4,
    checklistTotal: 5,
    recentEntries: entries.map(toApiJournalEntry),
  };
  res.json(GetDashboardOverviewResponse.parse(data));
});

export default router;