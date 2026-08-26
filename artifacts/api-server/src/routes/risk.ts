import { Router, type IRouter } from "express";
import { db, riskSettingsTable } from "@workspace/db";
import { GetRiskSettingsResponse, UpdateRiskSettingsBody, UpdateRiskSettingsResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

async function getOrCreateRiskSettings() {
  const [existing] = await db.select().from(riskSettingsTable).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(riskSettingsTable).values({
    accountSize: 25000,
    riskPercent: 0.5,
    maxDailyLoss: 500,
    dailyLossUsed: 0,
    isLocked: false,
  }).returning();
  return created;
}

router.get("/risk/settings", async (_req, res): Promise<void> => {
  res.json(GetRiskSettingsResponse.parse(await getOrCreateRiskSettings()));
});

router.patch("/risk/settings", async (req, res): Promise<void> => {
  const parsed = UpdateRiskSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await getOrCreateRiskSettings();
  if (existing.isLocked) {
    res.status(400).json({ error: "Risk settings are locked for this session." });
    return;
  }
  const [updated] = await db.update(riskSettingsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(riskSettingsTable.id, existing.id))
    .returning();
  res.json(UpdateRiskSettingsResponse.parse(updated));
});

export default router;