import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/authMiddleware.js";
import {
  activateCandidate,
  approveProposal,
  createProposal,
  getProposalDetail,
  GovernanceError,
  listProposals,
  listStrategyVersions,
  listTeachingExamples,
  getTeachingHistory,
  publishCandidate,
  rejectProposal,
  requestClarification,
  requestValidation,
  retireProposal,
  rollbackProposal,
  supersedeTeachingEvidence,
} from "../lib/governance-store.js";
import {
  activateStrategyShadow,
  getStrategyReadiness,
  listStrategyCatalog,
  pauseStrategy,
  resumeStrategy,
  setStrategyThresholds,
  validateStrategyReadiness,
  type StrategyThresholds,
} from "../lib/strategy/readiness.js";
import { isStrategyId } from "../lib/strategy/taxonomy.js";

const router: IRouter = Router();
const idempotency = (value: unknown) => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 200) : null;
const proposalInput = z.object({
  title: z.string().min(1).max(200),
  hypothesis: z.string().min(1).max(2000),
  rationale: z.string().min(1).max(4000),
  sourceTeachingIds: z.array(z.string().min(1)).min(1).max(100),
  proposalPayload: z.record(z.string(), z.unknown()).default({}),
});
const reasonInput = z.object({ reason: z.string().min(1).max(4000) });
const supersedeTeachingInput = z.object({
  judgment: z.string().min(1).max(100),
  explanation: z.string().min(10).max(4000),
});
const strategyThresholds = z.object({
  minSetupCount: z.number().int().min(1),
  minCompletedTrades: z.number().int().min(1),
  minHoldoutCount: z.number().int().min(1),
  minExpectancy: z.number(),
  maxDrawdown: z.number().min(0),
  maxAmbiguityRate: z.number().min(0).max(1),
  minReviewedExampleAgreement: z.number().min(0).max(1),
});
const pauseInput = z.object({ reason: z.string().min(1).max(4000) });

function actor(req: Request) {
  return { id: req.user!.id };
}

function respondError(res: Response, error: unknown) {
  if (error instanceof GovernanceError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "Unable to complete governance action." });
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? "" : value;
}

export function createGovernanceRouter(): IRouter {
  const router: IRouter = Router();
  router.get("/teaching-examples", requireAuth, async (_req, res) => {
    res.json(await listTeachingExamples());
  });
  router.get("/teaching-examples/:reviewSetId/:snapshotId/history", requireAuth, async (req, res) => {
    res.json(await getTeachingHistory(param(req, "reviewSetId"), param(req, "snapshotId")));
  });
  router.post("/teaching-examples/:id/supersede", requireRole("reviewer"), async (req, res) => {
    const parsed = supersedeTeachingInput.safeParse(req.body);
    const key = idempotency(req.header("Idempotency-Key"));
    if (!parsed.success || !key) { res.status(400).json({ error: "A replacement judgment, explanation, and Idempotency-Key are required." }); return; }
    try {
      res.status(201).json(await supersedeTeachingEvidence({ id: param(req, "id"), actor: actor(req), ...parsed.data, idempotencyKey: key }));
    } catch (error) { respondError(res, error); }
  });
  router.get("/strategy-proposals", requireAuth, async (_req, res) => {
    res.json(await listProposals());
  });
  router.get("/strategy-proposals/:id", requireAuth, async (req, res) => {
    try { res.json(await getProposalDetail(param(req, "id"))); } catch (error) { respondError(res, error); }
  });
  router.get("/strategy-proposals/:id/audit", requireAuth, async (req, res) => {
    try { res.json((await getProposalDetail(param(req, "id"))).auditEvents); } catch (error) { respondError(res, error); }
  });
  router.get("/strategy-versions", requireAuth, async (_req, res) => {
    res.json(await listStrategyVersions());
  });
  router.get("/strategy-catalog", async (_req, res) => {
    try { res.json(await listStrategyCatalog()); } catch (error) { respondError(res, error); }
  });
  router.get("/strategy-catalog/:strategyKey", async (req, res) => {
    try { res.json(await getStrategyReadiness(param(req, "strategyKey"))); } catch (error) { respondError(res, error); }
  });
  router.patch("/strategy-catalog/:strategyKey/thresholds", requireRole("owner"), async (req, res) => {
    const key = param(req, "strategyKey");
    const parsed = strategyThresholds.safeParse(req.body);
    if (!isStrategyId(key) || !parsed.success) { res.status(400).json({ error: "A canonical strategy key and complete owner-approved fitness thresholds are required." }); return; }
    try { res.json(await setStrategyThresholds(key, parsed.data as StrategyThresholds)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-catalog/:strategyKey/validate", requireRole("reviewer"), async (req, res) => {
    const key = param(req, "strategyKey");
    if (!isStrategyId(key)) { res.status(400).json({ error: "A canonical strategy key is required." }); return; }
    try { res.json(await validateStrategyReadiness(key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-catalog/:strategyKey/activate-shadow", requireRole("activator"), async (req, res) => {
    const key = param(req, "strategyKey");
    if (!isStrategyId(key)) { res.status(400).json({ error: "A canonical strategy key is required." }); return; }
    try { res.json(await activateStrategyShadow(key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-catalog/:strategyKey/pause", requireRole("activator"), async (req, res) => {
    const key = param(req, "strategyKey");
    const parsed = pauseInput.safeParse(req.body);
    if (!isStrategyId(key) || !parsed.success) { res.status(400).json({ error: "A canonical strategy key and pause reason are required." }); return; }
    try { res.json(await pauseStrategy(key, parsed.data.reason)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-catalog/:strategyKey/resume", requireRole("activator"), async (req, res) => {
    const key = param(req, "strategyKey");
    if (!isStrategyId(key)) { res.status(400).json({ error: "A canonical strategy key is required." }); return; }
    try { res.json(await resumeStrategy(key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals", requireRole("reviewer"), async (req, res) => {
    const parsed = proposalInput.safeParse(req.body);
    const key = idempotency(req.header("Idempotency-Key"));
    if (!parsed.success || !key) { res.status(400).json({ error: "A valid proposal and Idempotency-Key are required." }); return; }
    try { res.status(201).json(await createProposal({ actor: actor(req), ...parsed.data, idempotencyKey: key })); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals/:id/clarification", requireRole("reviewer"), async (req, res) => {
    const parsed = reasonInput.safeParse(req.body);
    const key = idempotency(req.header("Idempotency-Key"));
    if (!parsed.success || !key) { res.status(400).json({ error: "A reason and Idempotency-Key are required." }); return; }
    try { res.json(await requestClarification(param(req, "id"), actor(req), parsed.data.reason, key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals/:id/validate", requireRole("reviewer"), async (req, res) => {
    const key = idempotency(req.header("Idempotency-Key"));
    if (!key) { res.status(400).json({ error: "Idempotency-Key is required." }); return; }
    try { res.status(202).json(await requestValidation({ id: param(req, "id"), actor: actor(req), idempotencyKey: key })); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals/:id/approve", requireRole("approver"), async (req, res) => {
    const parsed = reasonInput.safeParse(req.body);
    const key = idempotency(req.header("Idempotency-Key"));
    if (!parsed.success || !key) { res.status(400).json({ error: "A reason and Idempotency-Key are required." }); return; }
    try { res.json(await approveProposal(param(req, "id"), actor(req), parsed.data.reason, key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals/:id/reject", requireRole("approver"), async (req, res) => {
    const parsed = reasonInput.safeParse(req.body);
    const key = idempotency(req.header("Idempotency-Key"));
    if (!parsed.success || !key) { res.status(400).json({ error: "A reason and Idempotency-Key are required." }); return; }
    try { res.json(await rejectProposal(param(req, "id"), actor(req), parsed.data.reason, key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals/:id/publish", requireRole("approver"), async (req, res) => {
    const key = idempotency(req.header("Idempotency-Key"));
    if (!key) { res.status(400).json({ error: "Idempotency-Key is required." }); return; }
    try { res.json(await publishCandidate(param(req, "id"), actor(req), key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals/:id/activate", requireRole("activator"), async (req, res) => {
    const key = idempotency(req.header("Idempotency-Key"));
    if (!key) { res.status(400).json({ error: "Idempotency-Key is required." }); return; }
    try { res.json(await activateCandidate(param(req, "id"), actor(req), key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals/:id/retire", requireRole("activator"), async (req, res) => {
    const key = idempotency(req.header("Idempotency-Key"));
    if (!key) { res.status(400).json({ error: "Idempotency-Key is required." }); return; }
    try { res.json(await retireProposal(param(req, "id"), actor(req), key)); } catch (error) { respondError(res, error); }
  });
  router.post("/strategy-proposals/:id/rollback", requireRole("activator"), async (req, res) => {
    const parsed = reasonInput.safeParse(req.body);
    const key = idempotency(req.header("Idempotency-Key"));
    if (!parsed.success || !key) { res.status(400).json({ error: "A reason and Idempotency-Key are required." }); return; }
    try { res.json(await rollbackProposal(param(req, "id"), actor(req), parsed.data.reason, key)); } catch (error) { respondError(res, error); }
  });
  return router;
}

export default createGovernanceRouter();