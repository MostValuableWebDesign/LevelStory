import { Router, type IRouter } from "express";
import {
  CreateVisualValidationSetBody,
  GetVisualValidationSetQueryParams,
  GetVisualValidationSetResponse,
  RecordVisualValidationReviewBody,
  RecordVisualValidationReviewResponse,
  ExportVisualValidationDiscrepanciesQueryParams,
  ExportVisualValidationDiscrepanciesResponse,
  AnalyzeVisualValidationTeachingBody,
  AnalyzeVisualValidationTeachingResponse,
} from "@workspace/api-zod";
import { requestRateLimit } from "../lib/security.js";
import { requireRole } from "../middlewares/authMiddleware.js";
import { persistTeachingEvidence } from "../lib/governance-store.js";
import {
  buildHistoricalVisualValidationSet,
  buildVisualValidationSet,
} from "../lib/visual-validation.js";
import {
  buildVisualValidationDiscrepancyReport,
  getLatestVisualValidationSet,
  getVisualValidationSet,
  analyzeVisualValidationTeaching,
  recordVisualValidationReview,
  storeVisualValidationSet,
} from "../lib/visual-validation-store.js";

const defaultRequest = {
  symbol: "MES" as const,
  endDate: "2026-08-26",
  inSampleDays: 5,
  outOfSampleDays: 2,
  seed: undefined,
  premarketAvailable: true,
  source: "historical_databento" as const,
  reviewMode: "trades_only" as const,
};

export function createVisualValidationRouter(): IRouter {
  const router: IRouter = Router();
  const reviewRateLimit = requestRateLimit({
    windowMs: 60_000,
    max: 120,
    message: "Review updates are temporarily limited. Try again shortly.",
  });

  router.get("/backtest/visual-validation", async (req, res): Promise<void> => {
    const parsed = GetVisualValidationSetQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (parsed.data.reviewSetId || getLatestVisualValidationSet()) {
      const existing = parsed.data.reviewSetId
        ? getVisualValidationSet(parsed.data.reviewSetId)
        : getLatestVisualValidationSet();
      if (!existing) {
        res.status(404).json({ error: "Visual-validation set not found or expired." });
        return;
      }
      res.json(GetVisualValidationSetResponse.parse(existing));
      return;
    }
    const request = {
      ...defaultRequest,
      ...(parsed.data.symbol ? { symbol: parsed.data.symbol } : {}),
      ...(parsed.data.endDate ? { endDate: parsed.data.endDate } : {}),
      ...(parsed.data.inSampleDays ? { inSampleDays: parsed.data.inSampleDays } : {}),
      ...(parsed.data.outOfSampleDays ? { outOfSampleDays: parsed.data.outOfSampleDays } : {}),
      ...(parsed.data.seed !== undefined ? { seed: parsed.data.seed } : {}),
       ...(parsed.data.reviewMode ? { reviewMode: parsed.data.reviewMode } : {}),
    };
    try {
      const built = request.source === "historical_databento"
        ? await buildHistoricalVisualValidationSet(request)
        : buildVisualValidationSet(request);
      const set = storeVisualValidationSet(built);
      res.json(GetVisualValidationSetResponse.parse(set));
    } catch (error) {
      req.log?.error({ error: error instanceof Error ? error.message : "unknown" }, "Visual-validation generation failed");
      const detail = error instanceof Error ? error.message : "Unable to generate the visual-validation set.";
      const unavailable = detail.includes("unavailable") || detail.includes("ready multi-contract index");
      res.status(unavailable ? 503 : 500).json({ error: detail });
    }
  });

  router.post("/backtest/visual-validation", async (req, res): Promise<void> => {
    const parsed = CreateVisualValidationSetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const request = {
        ...parsed.data,
        premarketAvailable: parsed.data.premarketAvailable ?? true,
      };
      const built = request.source === "historical_databento"
        ? await buildHistoricalVisualValidationSet(request)
        : buildVisualValidationSet(request);
      const set = storeVisualValidationSet(built);
      res.json(GetVisualValidationSetResponse.parse(set));
    } catch (error) {
      req.log?.error({ error: error instanceof Error ? error.message : "unknown" }, "Visual-validation generation failed");
      const detail = error instanceof Error ? error.message : "Unable to generate the visual-validation set.";
      const unavailable = detail.includes("unavailable") || detail.includes("ready multi-contract index");
      res.status(unavailable ? 503 : 500).json({ error: detail });
    }
  });

  router.post("/backtest/visual-validation/reviews", reviewRateLimit, requireRole("reviewer"), async (req, res): Promise<void> => {
    const parsed = RecordVisualValidationReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (parsed.data.status === "unreviewed") {
      res.status(400).json({ error: "Choose a human judgment before saving a review." });
      return;
    }
    try {
      const teaching = parsed.data.teaching
        ? {
            ...parsed.data.teaching,
            entryCandleOpenTime: parsed.data.teaching.entryCandleOpenTime.toISOString(),
            entryCandleCloseTime: parsed.data.teaching.entryCandleCloseTime.toISOString(),
            patienceCandleOpenTime: parsed.data.teaching.patienceCandleOpenTime.toISOString(),
            patienceCandleCloseTime: parsed.data.teaching.patienceCandleCloseTime.toISOString(),
          }
        : undefined;
      if (parsed.data.status === "false_positive_trade" && (!teaching || teaching.judgment !== "false_positive_trade")) {
        throw new Error("False-positive reviews require structured false-positive teaching evidence.");
      }
      const activeSet = getVisualValidationSet(parsed.data.reviewSetId);
      const snapshot = activeSet?.snapshots.find((item) => item.snapshotId === parsed.data.snapshotId);
      if (!snapshot) {
        res.status(404).json({ error: "Visual-validation set or snapshot not found." });
        return;
      }
      if (parsed.data.status === "false_positive_trade" && !snapshot.machineEvidence.trade) {
        throw new Error("A false-positive review must link to an exact machine-qualified trade.");
      }
      const review = recordVisualValidationReview(
        parsed.data.reviewSetId,
        parsed.data.snapshotId,
        parsed.data.status,
        parsed.data.note ?? null,
        teaching,
      );
      if (!review) {
        res.status(404).json({ error: "Visual-validation set or snapshot not found." });
        return;
      }
       if (parsed.data.status === "false_positive_trade" && (!review.teaching || !review.teaching.validation.valid)) {
         throw new Error("False-positive teaching evidence failed causal validation.");
       }
       if (review.teaching) {
         const key = req.header("Idempotency-Key") ?? `${parsed.data.reviewSetId}:${parsed.data.snapshotId}:${JSON.stringify(parsed.data.teaching)}`;
         await persistTeachingEvidence({
           actor: { id: req.user!.id },
           reviewSetId: parsed.data.reviewSetId,
           snapshot,
           review,
           idempotencyKey: key.slice(0, 200),
         });
       }
       res.json(RecordVisualValidationReviewResponse.parse(review));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to save this teaching judgment." });
    }
  });

  router.post("/backtest/visual-validation/proposed-rule-analysis", reviewRateLimit, (req, res): void => {
    const parsed = AnalyzeVisualValidationTeachingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const analysis = analyzeVisualValidationTeaching(parsed.data.reviewSetId, parsed.data.teachingId);
    if (!analysis) {
      res.status(404).json({ error: "Visual-validation set not found or expired." });
      return;
    }
    res.json(AnalyzeVisualValidationTeachingResponse.parse(analysis));
  });

  router.get("/backtest/visual-validation/discrepancies", reviewRateLimit, (req, res): void => {
    const parsed = ExportVisualValidationDiscrepanciesQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const report = buildVisualValidationDiscrepancyReport(parsed.data.reviewSetId);
    if (!report) {
      res.status(404).json({ error: "Visual-validation set not found or expired." });
      return;
    }
    res.json(ExportVisualValidationDiscrepanciesResponse.parse(report));
  });

  return router;
}

export default createVisualValidationRouter();
