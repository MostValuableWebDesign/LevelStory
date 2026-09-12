import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireRole } from "../middlewares/authMiddleware.js";
import { requestRateLimit } from "../lib/security.js";
import {
  newHistoricalObjectPath,
  materializeHistoricalObject,
  signHistoricalObjectUrl,
} from "../lib/futures/historical-upload-storage.js";
import {
  getHistoricalMultiContractIndexStatus,
  importHistoricalMultiContract,
} from "../lib/futures/multi-contract-replay.js";

const MAX_HISTORICAL_UPLOAD_BYTES = 512 * 1024 * 1024;
const filenameSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/);
const uploadMetadataSchema = z.object({
  originalFilename: filenameSchema,
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().positive().max(MAX_HISTORICAL_UPLOAD_BYTES),
});
const importRequestSchema = z.object({
  files: z.array(z.object({
    objectPath: z.string(),
    originalFilename: filenameSchema,
  })).min(1).max(100),
});

function supportedFilename(filename: string): boolean {
  return /\.csv(?:\.zst)?$/i.test(filename);
}

const router: IRouter = Router();

router.post(
  "/historical-data/uploads/request-url",
  requireRole("reviewer"),
  requestRateLimit({ windowMs: 60_000, max: 50, message: "Historical uploads are temporarily limited." }),
  async (req, res) => {
    const parsed = uploadMetadataSchema.safeParse(req.body);
    if (!parsed.success || !supportedFilename(parsed.data?.originalFilename ?? "")) {
      res.status(400).json({
        error: "Historical uploads must use a safe .csv or .csv.zst filename and stay under 512 MB.",
      });
      return;
    }
    if (!["text/csv", "application/octet-stream", "application/zstd", ""].includes(parsed.data.mimeType)) {
      res.status(415).json({ error: "Only CSV and Zstandard-compressed CSV inputs are supported." });
      return;
    }
    try {
      const objectPath = newHistoricalObjectPath();
      const uploadUrl = await signHistoricalObjectUrl(objectPath, "PUT");
      res.json({
        uploadUrl,
        objectPath,
        maxBytes: MAX_HISTORICAL_UPLOAD_BYTES,
        acceptedExtensions: [".csv", ".csv.zst"],
      });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Historical upload storage is unavailable." });
    }
  },
);

router.post(
  "/historical-data/import",
  requireRole("reviewer"),
  requestRateLimit({ windowMs: 60_000, max: 10, message: "Historical indexing is temporarily limited." }),
  async (req, res) => {
    const parsed = importRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "At least one uploaded .csv or .csv.zst file is required." });
      return;
    }
    try {
      const paths: string[] = [];
      for (const file of parsed.data.files) {
        if (!supportedFilename(file.originalFilename)) {
          res.status(415).json({ error: `Unsupported historical filename: ${file.originalFilename}.` });
          return;
        }
        paths.push(await materializeHistoricalObject(file.objectPath, file.originalFilename));
      }
      const imported = await importHistoricalMultiContract();
      res.status(202).json({
        state: imported.summary.indexingState,
        filesMaterialized: paths.length,
        status: await getHistoricalMultiContractIndexStatus(),
        summary: {
          acceptedContracts: imported.summary.acceptedContracts,
          eligibleTradingDateCount: imported.summary.eligibleTradingDates.length,
          ineligibleScheduledDateCount: imported.summary.ineligibleScheduledDateCount,
          fullRangeReady: imported.summary.ineligibleScheduledDateCount === 0,
        },
      });
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Historical import failed." });
    }
  },
);

export default router;