import { Router, type IRouter } from "express";
import { RunBacktestBody, RunBacktestResponse } from "@workspace/api-zod";
import { db, riskSettingsTable } from "@workspace/db";
import { runCausalBacktest } from "../lib/phase9";

const router: IRouter = Router();

router.post("/backtest", async (req, res): Promise<void> => {
  const parsed = RunBacktestBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid backtest request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [risk] = await db.select().from(riskSettingsTable).limit(1);
    const report = runCausalBacktest(parsed.data, risk);
    res.json(RunBacktestResponse.parse(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to run the causal backtest.";
    req.log.warn({ error: message }, "Rejected backtest request");
    res.status(400).json({ error: message });
  }
});

export default router;