import { Router, type IRouter } from "express";
import { GetDashboardOverviewResponse, GetMarketSnapshotQueryParams, GetMarketSnapshotResponse } from "@workspace/api-zod";
import { db, journalEntriesTable, riskSettingsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { createMarketSnapshot } from "../lib/market-data";

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
  const [risk] = await db.select().from(riskSettingsTable).limit(1);
  res.json(GetMarketSnapshotResponse.parse(createMarketSnapshot(parsed.data.symbol, parsed.data.session, risk)));
});

router.get("/dashboard/overview", async (_req, res): Promise<void> => {
  const [risk] = await db.select().from(riskSettingsTable).limit(1);
  const entries = await db.select().from(journalEntriesTable).orderBy(desc(journalEntriesTable.createdAt)).limit(5);
  const pnl = entries.reduce((total, entry) => total + (entry.pnl ?? 0), 0);
  const wins = entries.filter((entry) => (entry.pnl ?? 0) > 0).length;
  const data = {
    sessionPnl: Number(pnl.toFixed(2)),
    sessionPnlPercent: risk && risk.accountSize > 0 ? Number(((pnl / risk.accountSize) * 100).toFixed(2)) : 0,
    maxDailyLoss: risk?.maxDailyLoss ?? 500,
    dailyLossUsed: risk?.dailyLossUsed ?? 0,
    tradeCount: entries.length,
    winRate: entries.length ? Number(((wins / entries.length) * 100).toFixed(1)) : 0,
    checklistCompleted: 4,
    checklistTotal: 5,
    recentEntries: entries.map(toApiJournalEntry),
  };
  res.json(GetDashboardOverviewResponse.parse(data));
});

export default router;