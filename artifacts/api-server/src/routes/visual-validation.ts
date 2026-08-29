import { Router, type IRouter } from "express";
import {
  CreateVisualValidationSetBody,
  GetVisualValidationSetQueryParams,
  GetVisualValidationSetResponse,
  RecordVisualValidationReviewBody,
  RecordVisualValidationReviewResponse,
  ExportVisualValidationDiscrepanciesQueryParams,
  ExportVisualValidationDiscrepanciesResponse,
} from "@workspace/api-zod";
import { requestRateLimit } from "../lib/security.js";
import {
  buildHistoricalVisualValidationSet,
  buildVisualValidationSet,
} from "../lib/visual-validation.js";
import {
  buildVisualValidationDiscrepancyReport,
  getLatestVisualValidationSet,
  getVisualValidationSet,
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
  const generationRateLimit = requestRateLimit({
    windowMs: 120_000,
    max: 3,
    message: "Visual-validation generation is temporarily limited. Try again shortly.",
  });
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

  router.post("/backtest/visual-validation", generationRateLimit, async (req, res): Promise<void> => {
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

  router.post("/backtest/visual-validation/reviews", reviewRateLimit, (req, res): void => {
    const parsed = RecordVisualValidationReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const review = recordVisualValidationReview(
      parsed.data.reviewSetId,
      parsed.data.snapshotId,
      parsed.data.status,
      parsed.data.note ?? null,
    );
    if (!review) {
      res.status(404).json({ error: "Visual-validation set or snapshot not found." });
      return;
    }
    res.json(RecordVisualValidationReviewResponse.parse(review));
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
