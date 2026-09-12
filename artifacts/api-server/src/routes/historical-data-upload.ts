import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireRole } from "../middlewares/authMiddleware.js";
import { requestRateLimit } from "../lib/security.js";
import {
  newHistoricalObjectPath,
  materializeHistoricalObject,
  MAX_HISTORICAL_UPLOAD_BYTES,
  signHistoricalObjectUrl,
} from "../lib/futures/historical-upload-storage.js";
import {
  getHistoricalMultiContractIndexStatus,
  importHistoricalMultiContract,
  validateHistoricalMultiContractIndexMaintenance,
  type HistoricalIndexSourceFile,
} from "../lib/futures/multi-contract-replay.js";
import { getHistoricalCsvFingerprint } from "../lib/futures/historical-csv-import.js";
import {
  HistoricalImportJobStore,
  type PersistedHistoricalImportFile,
  type PersistedHistoricalImportJob,
} from "../lib/futures/historical-import-job-store.js";

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
    sizeBytes: z.number().int().positive().max(MAX_HISTORICAL_UPLOAD_BYTES).optional(),
  })).min(1).max(100),
});

function supportedFilename(filename: string): boolean {
  return /\.csv(?:\.zst)?$/i.test(filename);
}

const router: IRouter = Router();

const importJobStore = new HistoricalImportJobStore();
const runningJobs = new Set<string>();
const jobControllers = new Map<string, AbortController>();
const ACTIVE_IMPORT_STATES = [
  "queued",
  "materializing",
  "validating",
  "indexing",
  "aggregating",
  "reconciling",
  "committing",
] as const;
const RESUMABLE_IMPORT_STATES = ["paused", "cancelled_resumable"] as const;
const LEASE_OWNER = `api-${process.pid}`;
const LEASE_MS = 5 * 60_000;

const recoveredJobIds: string[] = [];
for (const job of importJobStore.listActive()) {
  importJobStore.update(job.jobId, {
    state: "queued",
    currentFilename: null,
    currentContract: null,
    currentTradingDate: null,
    error: "Recovered after API restart; queued work will resume.",
  });
  recoveredJobIds.push(job.jobId);
}

function jobResponse(job: PersistedHistoricalImportJob): PersistedHistoricalImportJob {
  return { ...job, files: job.files.map((file) => ({ ...file })) };
}

function getJob(jobId: string): PersistedHistoricalImportJob | null {
  return importJobStore.get(jobId);
}

function updateJob(jobId: string, patch: Partial<PersistedHistoricalImportJob>): PersistedHistoricalImportJob {
  return importJobStore.updateIfState(jobId, ACTIVE_IMPORT_STATES, patch) ?? getJob(jobId)!;
}

async function runImportJob(jobId: string): Promise<void> {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  const initial = getJob(jobId);
  if (!initial) {
    runningJobs.delete(jobId);
    return;
  }
  const controller = new AbortController();
  jobControllers.set(jobId, controller);
  if (!importJobStore.updateIfState(jobId, ["queued"], {
    state: "materializing",
    startedAt: initial.startedAt ?? new Date().toISOString(),
    error: null,
    leaseOwner: LEASE_OWNER,
    leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
    heartbeatAt: new Date().toISOString(),
  })) {
    runningJobs.delete(jobId);
    jobControllers.delete(jobId);
    return;
  }
  const materialized: HistoricalIndexSourceFile[] = [];
  try {
    const job = getJob(jobId)!;
    for (const [fileIndex, file] of job.files.entries()) {
      updateJob(jobId, {
        state: "materializing",
        currentFilename: file.originalFilename,
        phaseProgress: Math.round((fileIndex / Math.max(1, job.files.length)) * 100),
        progress: Math.round((fileIndex / Math.max(1, job.files.length)) * 20),
      });
      if (getJob(jobId)?.state === "cancelled") throw new Error("Historical import was cancelled.");
      const reused = await reusableMaterializedFile(file);
      const stored = reused ?? await materializeHistoricalObject(
        file.objectPath,
        file.originalFilename,
        { expectedSizeBytes: file.declaredSizeBytes },
      );
      materialized.push({
        ...stored,
        sizeBytes: stored.sizeBytes,
        contentFingerprint: stored.contentFingerprint,
        contractSymbol: null,
      });
      const latest = getJob(jobId)!;
      const nextFiles = latest.files.map((candidate, index) => index === fileIndex
        ? {
            ...candidate,
            materializedPath: stored.path,
            expectedCompression: stored.expectedCompression,
            contentFingerprint: stored.contentFingerprint,
            sizeBytes: stored.sizeBytes,
            declaredSizeBytes: candidate.declaredSizeBytes,
            state: "materialized" as const,
          }
        : candidate);
      updateJob(jobId, {
        files: nextFiles,
        materializedFileCount: fileIndex + 1,
        phaseProgress: Math.round(((fileIndex + 1) / Math.max(1, job.files.length)) * 100),
        progress: Math.round(((fileIndex + 1) / Math.max(1, job.files.length)) * 20),
      });
    }
      if (controller.signal.aborted || getJob(jobId)?.state === "cancelled") throw new Error("Historical import was cancelled.");
    const sourceFingerprint = materialized
      .map((file) => file.contentFingerprint)
      .filter((fingerprint): fingerprint is string => Boolean(fingerprint))
      .sort()
      .join("|");
    updateJob(jobId, {
      sourceFingerprint,
      stagingIndexPath: getJob(jobId)?.stagingIndexPath ?? null,
      heartbeatAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
    });
    updateJob(jobId, { state: "validating", phaseProgress: 0, progress: 25 });
    const resumeJob = getJob(jobId)!;
    const imported = await importHistoricalMultiContract({
      sources: materialized,
      stagingPath: resumeJob.stagingIndexPath,
      onProgress: (progress) => {
        if (controller.signal.aborted || getJob(jobId)?.state === "cancelled") return;
        updateJob(jobId, {
          state: progress.phase === "aggregating" ? "aggregating" : "indexing",
          progress: Math.max(25, Math.min(90, progress.percent)),
          phaseProgress: Math.min(100, progress.percent),
          rowsProcessed: progress.rowsRead,
          acceptedRows: progress.validRows,
          rejectedRows: progress.rejectedRows,
          currentFilename: progress.currentFile ?? null,
          currentContract: progress.currentContract ?? null,
          currentTradingDate: progress.currentTradingDate ?? null,
          sourceOffset: progress.sourceOffset ?? null,
          stagingIndexPath: progress.stagingIndexPath ?? null,
          completedPartitions: [...(progress.completedPartitions ?? getJob(jobId)?.completedPartitions ?? [])],
          heartbeatAt: new Date().toISOString(),
          leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
        });
      },
      signal: controller.signal,
    });
    if (controller.signal.aborted || getJob(jobId)?.state === "cancelled") {
      throw new Error("Historical import was cancelled.");
    }
    updateJob(jobId, {
      state: "reconciling",
      phaseProgress: 75,
      progress: 92,
      status: await getHistoricalMultiContractIndexStatus({ sources: materialized }),
      indexKey: imported.summary.indexKey,
    });
    const completedAt = new Date().toISOString();
    const completed = importJobStore.updateIfState(jobId, ACTIVE_IMPORT_STATES, {
      state: imported.summary.indexingState === "ready" ? "ready" : "failed",
      progress: imported.summary.indexingState === "ready" ? 100 : 0,
      phaseProgress: imported.summary.indexingState === "ready" ? 100 : 0,
      completedAt,
      currentFilename: null,
      error: imported.summary.indexingState === "ready" ? null : "Historical index did not become ready.",
    });
    if (!completed) return;
  } catch (error) {
    const completedAt = new Date().toISOString();
    const cancelled = getJob(jobId)?.state === "cancelled" || (error instanceof Error && error.message === "Historical import was cancelled.");
    const current = getJob(jobId);
    if (!current || ["ready", "failed", "cancelled", "cancelled_resumable", "paused"].includes(current.state)) {
      jobControllers.delete(jobId);
      runningJobs.delete(jobId);
      return;
    }
    importJobStore.updateIfState(jobId, ACTIVE_IMPORT_STATES, {
      state: cancelled ? "cancelled_resumable" : "failed",
      error: cancelled ? "Import paused at the last verified checkpoint; resume to continue without replacing the ready library." : error instanceof Error ? error.message : "Historical import failed.",
      completedAt,
      progress: cancelled ? current.progress : 0,
    });
  } finally {
    jobControllers.delete(jobId);
    runningJobs.delete(jobId);
  }
}

for (const jobId of recoveredJobIds) {
  queueMicrotask(() => { void runImportJob(jobId); });
}

async function reusableMaterializedFile(
  file: PersistedHistoricalImportFile,
): Promise<Awaited<ReturnType<typeof materializeHistoricalObject>> | null> {
  if (!file.materializedPath || file.sizeBytes === null || file.sizeBytes === undefined || !file.contentFingerprint) return null;
  try {
    const fileStats = await stat(file.materializedPath);
    if (fileStats.size !== file.sizeBytes) return null;
    const fingerprint = await getHistoricalCsvFingerprint(file.materializedPath);
    if (fingerprint !== file.contentFingerprint) return null;
    return {
      path: file.materializedPath,
      objectPath: file.objectPath,
      originalFilename: file.originalFilename,
      expectedCompression: file.expectedCompression ?? (file.originalFilename.toLowerCase().endsWith(".zst") ? "zstd" : "none"),
      contentFingerprint: fingerprint,
      sizeBytes: fileStats.size,
    };
  } catch {
    return null;
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
    const active = importJobStore.listActive()[0];
    if (active) {
      res.status(409).json({ error: "An equivalent historical import is already active.", jobId: active.jobId });
      return;
    }
    const now = new Date().toISOString();
    const job: PersistedHistoricalImportJob = {
      jobId: `hist_${randomUUID()}`,
      state: "queued",
      files: parsed.data.files.map((file): PersistedHistoricalImportFile => ({
        ...file,
        state: "queued",
        rowsProcessed: 0,
        acceptedRows: 0,
        rejectedRows: 0,
      })),
      materializedFileCount: 0,
      currentFilename: null,
      currentContract: null,
      currentTradingDate: null,
      progress: 0,
      phaseProgress: 0,
      rowsProcessed: 0,
      acceptedRows: 0,
      rejectedRows: 0,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      error: null,
      status: null,
      indexKey: null,
      stagingIndexPath: null,
      sourceFingerprint: null,
      sourceOffset: null,
      completedPartitions: [],
      leaseOwner: null,
      leaseUntil: null,
      heartbeatAt: null,
    };
    importJobStore.create(job);
    void runImportJob(job.jobId);
    res.status(202).json({
      jobId: job.jobId,
      state: job.state,
      requestedFileCount: job.files.length,
      statusUrl: `/api/historical-data/import/${job.jobId}`,
      createdAt: job.createdAt,
    });
  },
);

router.post("/historical-data/import/:jobId/cancel", requireRole("reviewer"), async (req, res) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Historical import job was not found in durable job storage." });
    return;
  }
  if (["ready", "failed", "cancelled"].includes(job.state)) {
    res.status(409).json({ error: `Historical import is already ${job.state}.` });
    return;
  }
  const cancelled = importJobStore.updateIfState(jobId, ACTIVE_IMPORT_STATES, {
    state: "cancelled_resumable",
    completedAt: null,
    error: "Cancellation requested; the staging index will be retained at the last safe checkpoint.",
  });
  jobControllers.get(jobId)?.abort();
  if (!cancelled) {
    res.status(409).json({ error: `Historical import is already ${getJob(jobId)?.state ?? "finished"}.` });
    return;
  }
  res.json(jobResponse(cancelled));
});

router.post("/historical-data/import/:jobId/resume", requireRole("reviewer"), async (req, res) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const resumed = importJobStore.updateIfState(jobId, RESUMABLE_IMPORT_STATES, {
    state: "queued",
    completedAt: null,
    error: null,
    leaseOwner: null,
    leaseUntil: null,
    heartbeatAt: null,
  });
  if (!resumed) {
    const existing = getJob(jobId);
    res.status(existing ? 409 : 404).json({
      error: existing ? `Historical import is not resumable from state ${existing.state}.` : "Historical import job was not found in durable job storage.",
    });
    return;
  }
  void runImportJob(jobId);
  res.json(jobResponse(resumed));
});

router.get("/historical-data/import/:jobId", requireRole("reviewer"), async (req, res) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  let job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Historical import job was not found in durable job storage." });
    return;
  }
  res.json(jobResponse(job));
});

router.post("/historical-data/maintenance/validate", requireRole("reviewer"), async (_req, res) => {
  try {
    const result = await validateHistoricalMultiContractIndexMaintenance();
    res.json({ ...result, message: "Historical source, SQLite integrity, and partition validation completed." });
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : "Historical maintenance validation failed." });
  }
});

export default router;