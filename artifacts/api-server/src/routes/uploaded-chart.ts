import crypto from "node:crypto";
import { raw, Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, uploadedChartAnalysesTable } from "@workspace/db";
import { requireRole } from "../middlewares/authMiddleware.js";
import { requestRateLimit } from "../lib/security.js";
import {
  analyzeChartImage,
  imageChecksum,
  uploadedChartDuplicateWarning,
  uploadedChartReplayEligibility,
  uploadedChartMetadataSchema,
  validateUploadedChartBytes,
  type UploadedChartMetadata,
} from "../lib/uploaded-chart-analysis.js";
import {
  newUploadedChartObjectPath,
  readUploadedChartObject,
  signUploadedChartObjectUrl,
} from "../lib/uploaded-chart-storage.js";
import { z } from "zod";

const router: IRouter = Router();
const MAX_BYTES = 10 * 1024 * 1024;

const requestUrlSchema = z.object({
  originalFilename: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive().max(MAX_BYTES),
});

const reviewSchema = z.object({
  status: z.enum(["unreviewed", "confirmed", "rejected", "uncertain"]),
  note: z.string().max(2000).nullable().optional(),
  corrections: z.record(z.string(), z.unknown()).nullable().optional(),
  includeInCombinedReplay: z.boolean().optional(),
});

function imagePayload(record: typeof uploadedChartAnalysesTable.$inferSelect, imageUrl: string) {
  return {
    analysisId: record.id,
    attachmentId: record.attachmentId,
    source: "uploaded_chart" as const,
    imageUrl,
    tradingDate: record.tradingDate,
    symbol: record.symbol,
    timeframe: record.timeframe,
    timezone: record.timezone,
    session: record.session,
    visibleStart: record.visibleStart,
    visibleEnd: record.visibleEnd,
    chartNote: record.chartNote,
    status: record.status,
    machineExtraction: record.machineExtraction,
    reviewerCorrections: record.reviewerCorrections,
    candidate: record.candidate,
    reviewerStatus: record.reviewerStatus,
    reviewerNote: record.reviewerNote,
    includeInCombinedReplay: record.includeInCombinedReplay,
    duplicateWarning: record.duplicateWarning,
    checksumSha256: record.checksumSha256,
    sizeBytes: record.sizeBytes,
    mimeType: record.mimeType,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function getOwnedRecord(id: string, userId: string) {
  const [record] = await db.select().from(uploadedChartAnalysesTable).where(and(eq(uploadedChartAnalysesTable.id, id), eq(uploadedChartAnalysesTable.ownerId, userId))).limit(1);
  return record;
}

function routeParam(value: string | string[] | undefined): string | null {
  const result = Array.isArray(value) ? value[0] : value;
  return result?.trim() || null;
}

router.post("/uploaded-chart/request-url", requireRole("reviewer"), requestRateLimit({ windowMs: 60_000, max: 30, message: "Chart uploads are temporarily limited." }), async (req, res) => {
  const parsed = requestUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "PNG, JPEG, and WebP uploads must be 10 MB or smaller." });
    return;
  }
  try {
    const objectPath = newUploadedChartObjectPath();
    res.json({ uploadUrl: "/api/uploaded-chart/upload", objectPath, maxBytes: MAX_BYTES, acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp"] });
  } catch (error) {
    req.log?.error({ error }, "Uploaded chart URL generation failed");
    res.status(500).json({ error: "Unable to prepare private chart storage." });
  }
});

router.put(
  "/uploaded-chart/upload",
  requireRole("reviewer"),
  raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "10mb" }),
  async (req, res) => {
    const objectPath = typeof req.headers["x-object-path"] === "string" ? req.headers["x-object-path"] : "";
    const declaredMime = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].split(";")[0] : "";
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || !objectPath || !["image/png", "image/jpeg", "image/webp"].includes(declaredMime)) {
      res.status(400).json({ error: "A valid chart image and upload path are required." });
      return;
    }
    try {
      validateUploadedChartBytes(bytes, declaredMime as "image/png" | "image/jpeg" | "image/webp");
      const uploadUrl = await signUploadedChartObjectUrl(objectPath, "PUT");
      const stored = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": declaredMime },
        body: bytes,
        signal: AbortSignal.timeout(30_000),
      });
      if (!stored.ok) throw new Error(`Private object storage rejected the upload (${stored.status}).`);
      res.status(201).json({ objectPath, sizeBytes: bytes.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Chart upload failed.";
      res.status(/10 MB/.test(message) ? 413 : 422).json({ error: message });
    }
  },
);

router.post("/uploaded-chart/analyze", requireRole("reviewer"), requestRateLimit({ windowMs: 60_000, max: 20, message: "Chart analysis is temporarily limited." }), async (req, res) => {
  const parsed = uploadedChartMetadataSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Chart date, metadata, storage path, and image type are required." });
    return;
  }
  const metadata: UploadedChartMetadata = parsed.data;
  try {
    const stored = await readUploadedChartObject(metadata.objectPath);
    if (stored.bytes.length > MAX_BYTES) {
      res.status(413).json({ error: "The uploaded chart exceeds the 10 MB limit." });
      return;
    }
    let detected: "image/png" | "image/jpeg" | "image/webp";
    try {
      detected = validateUploadedChartBytes(stored.bytes, metadata.mimeType);
    } catch (error) {
      res.status(error instanceof Error && /10 MB/.test(error.message) ? 413 : 415).json({ error: error instanceof Error ? error.message : "The uploaded bytes are invalid." });
      return;
    }
    const checksum = imageChecksum(stored.bytes);
    const { extraction, evaluation } = await analyzeChartImage(stored.bytes, metadata);
    const id = `uca_${crypto.randomUUID()}`;
    const duplicateWarning = uploadedChartDuplicateWarning(metadata, evaluation.candidate);
    const [record] = await db.insert(uploadedChartAnalysesTable).values({
      id,
      attachmentId: `att_${crypto.randomUUID()}`,
      ownerId: req.user!.id,
      objectPath: metadata.objectPath,
      originalFilename: metadata.originalFilename,
      mimeType: detected,
      sizeBytes: stored.bytes.length,
      checksumSha256: checksum,
      tradingDate: metadata.tradingDate,
      symbol: metadata.symbol,
      timeframe: metadata.timeframe,
      timezone: metadata.timezone,
      session: metadata.session,
      visibleStart: metadata.visibleStart ?? null,
      visibleEnd: metadata.visibleEnd ?? null,
      chartNote: metadata.chartNote ?? null,
      status: evaluation.status,
      machineExtraction: { modelVersion: "gpt-5.4-mini", extraction, evaluation },
      reviewerCorrections: null,
      candidate: evaluation.candidate,
      reviewerStatus: "unreviewed",
      reviewerNote: null,
      includeInCombinedReplay: false,
      duplicateWarning,
    }).returning();
    if (!record) throw new Error("Uploaded chart analysis was not saved.");
    res.json(imagePayload(record, `/api/uploaded-chart/${record.id}/image`));
  } catch (error) {
    req.log?.error({ error }, "Uploaded chart analysis failed");
    res.status(422).json({ error: error instanceof Error ? error.message : "Chart analysis failed." });
  }
});

router.get("/uploaded-chart/:id", requireRole("reviewer"), async (req, res) => {
  const id = routeParam(req.params.id);
  const record = id ? await getOwnedRecord(id, req.user!.id) : undefined;
  if (!record) {
    res.status(404).json({ error: "Uploaded chart analysis not found." });
    return;
  }
  res.json(imagePayload(record, `/api/uploaded-chart/${record.id}/image`));
});

router.get("/uploaded-chart/:id/image", requireRole("reviewer"), async (req, res) => {
  const id = routeParam(req.params.id);
  const record = id ? await getOwnedRecord(id, req.user!.id) : undefined;
  if (!record) {
    res.status(404).json({ error: "Uploaded chart image not found." });
    return;
  }
  try {
    const url = await signUploadedChartObjectUrl(record.objectPath, "GET", 300);
    res.redirect(307, url);
  } catch {
    res.status(404).json({ error: "Uploaded chart image is unavailable." });
  }
});

router.patch("/uploaded-chart/:id/review", requireRole("reviewer"), async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Review status or correction payload is invalid." });
    return;
  }
  const id = routeParam(req.params.id);
  const record = id ? await getOwnedRecord(id, req.user!.id) : undefined;
  if (!record) {
    res.status(404).json({ error: "Uploaded chart analysis not found." });
    return;
  }
  const candidate = record.candidate as { entryActivated?: boolean; riskDollars?: number } | null;
  const calibrated = Boolean((record.machineExtraction as { extraction?: { calibration?: { pricesCalibrated?: boolean; timestampsCalibrated?: boolean } } }).extraction?.calibration?.pricesCalibrated
    && (record.machineExtraction as { extraction?: { calibration?: { pricesCalibrated?: boolean; timestampsCalibrated?: boolean } } }).extraction?.calibration?.timestampsCalibrated);
  const eligibleForReplay = uploadedChartReplayEligibility({ reviewerStatus: parsed.data.status, candidate, calibrated });
  const requestedReplay = parsed.data.includeInCombinedReplay === true;
  if (requestedReplay && !eligibleForReplay) {
    res.status(400).json({ error: "Only confirmed, activated, calibrated, risk-approved candidates can enter Combined Shadow Replay." });
    return;
  }
  const [updated] = await db.update(uploadedChartAnalysesTable)
    .set({
      reviewerStatus: parsed.data.status,
      reviewerNote: parsed.data.note ?? null,
      reviewerCorrections: parsed.data.corrections ?? record.reviewerCorrections,
      includeInCombinedReplay: requestedReplay,
      updatedAt: new Date(),
    })
    .where(eq(uploadedChartAnalysesTable.id, record.id))
    .returning();
  res.json(imagePayload(updated!, `/api/uploaded-chart/${record.id}/image`));
});

export default router;