import { randomUUID } from "node:crypto";
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
  type HistoricalIndexSourceFile,
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

type ImportJobState = "queued" | "materializing" | "indexing" | "ready" | "failed" | "cancelled";
type HistoricalImportJob = {
  jobId: string;
  state: ImportJobState;
  files: Array<{ objectPath: string; originalFilename: string }>;
  materializedFileCount: number;
  currentFilename: string | null;
  progress: number;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  status: Awaited<ReturnType<typeof getHistoricalMultiContractIndexStatus>> | null;
};

const importJobs = new Map<string, HistoricalImportJob>();
let activeJobId: string | null = null;

function jobResponse(job: HistoricalImportJob): HistoricalImportJob {
  return { ...job, files: job.files.map((file) => ({ ...file })) };
}

async function runImportJob(job: HistoricalImportJob): Promise<void> {
  job.state = "materializing";
  job.startedAt = new Date().toISOString();
  job.updatedAt = job.startedAt;
  const materialized: HistoricalIndexSourceFile[] = [];
  try {
    for (const file of job.files) {
      job.currentFilename = file.originalFilename;
      const stored = await materializeHistoricalObject(file.objectPath, file.originalFilename);
      materialized.push(stored);
      job.materializedFileCount += 1;
      job.progress = Math.round((job.materializedFileCount / job.files.length) * 20);
      job.updatedAt = new Date().toISOString();
    }
    job.state = "indexing";
    job.progress = 25;
    job.updatedAt = new Date().toISOString();
    const imported = await importHistoricalMultiContract({ sources: materialized });
    job.status = await getHistoricalMultiContractIndexStatus({ sources: materialized });
    job.state = imported.summary.indexingState === "ready" ? "ready" : "failed";
    job.progress = job.state === "ready" ? 100 : 0;
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    if (job.state === "ready") job.currentFilename = null;
  } catch (error) {
    job.state = "failed";
    job.error = error instanceof Error ? error.message : "Historical import failed.";
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
  } finally {
    if (activeJobId === job.jobId) activeJobId = null;
  }
}

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
    for (const file of parsed.data.files) {
      if (!supportedFilename(file.originalFilename)) {
        res.status(415).json({ error: `Unsupported historical filename: ${file.originalFilename}.` });
        return;
      }
    }
    if (activeJobId) {
      const active = importJobs.get(activeJobId);
      if (active && ["queued", "materializing", "indexing"].includes(active.state)) {
        res.status(409).json({ error: "An equivalent historical import is already active.", jobId: active.jobId });
        return;
      }
    }
    const now = new Date().toISOString();
    const job: HistoricalImportJob = {
      jobId: `hist_${randomUUID()}`,
      state: "queued",
      files: parsed.data.files,
      materializedFileCount: 0,
      currentFilename: null,
      progress: 0,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      error: null,
      status: null,
    };
    importJobs.set(job.jobId, job);
    activeJobId = job.jobId;
    void runImportJob(job);
    res.status(202).json({
      jobId: job.jobId,
      state: job.state,
      requestedFileCount: job.files.length,
      statusUrl: `/api/historical-data/import/${job.jobId}`,
      createdAt: job.createdAt,
    });
  },
);

router.get("/historical-data/import/:jobId", requireRole("reviewer"), async (req, res) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = importJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Historical import job was not found in this server process." });
    return;
  }
  res.json(jobResponse(job));
});

export default router;