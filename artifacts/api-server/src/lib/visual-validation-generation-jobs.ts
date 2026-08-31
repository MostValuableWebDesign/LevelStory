import { randomUUID } from "node:crypto";
import {
  buildHistoricalVisualValidationSet,
  buildVisualValidationSet,
  type VisualValidationRequest,
  type VisualValidationSet,
} from "./visual-validation.js";
import {
  buildHistoricalVisualValidationSetInWorker,
  type VisualValidationWorkerProgress,
} from "./visual-validation-worker-client.js";
import { storeVisualValidationSet } from "./visual-validation-store.js";

export type CandidateGenerationPhase =
  | "preparing"
  | "loading_sessions"
  | "replaying_sessions"
  | "building_ledger"
  | "projecting_candidates"
  | "building_snapshots"
  | "completed";

export type CandidateGenerationStatus = "queued" | "running" | "completed" | "failed";

export type CandidateGenerationJob = {
  jobId: string;
  status: CandidateGenerationStatus;
  phase: CandidateGenerationPhase;
  completedUnits: number;
  totalUnits: number;
  percent: number;
  completedSessions: number;
  totalSessions: number;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  message: string;
  error: string | null;
  reviewSetId: string | null;
  result?: VisualValidationSet;
};

type JobRecord = CandidateGenerationJob & {
  requestKey: string;
  request: VisualValidationRequest;
  startedAt: number | null;
  completedAt: number | null;
};

const JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 12;
const jobs = new Map<string, JobRecord>();
const activeByRequest = new Map<string, string>();
const completedByRequest = new Map<string, string>();
let latestJobId: string | null = null;
let generationTail = Promise.resolve();

function requestKey(request: VisualValidationRequest): string {
  return JSON.stringify({
    symbol: request.symbol,
    endDate: request.endDate,
    inSampleDays: request.inSampleDays,
    outOfSampleDays: request.outOfSampleDays,
    seed: request.seed,
    premarketAvailable: request.premarketAvailable !== false,
    source: request.source ?? "historical_databento",
    reviewMode: request.reviewMode ?? "trades_only",
  });
}

function pruneJobs(): void {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    const finishedAt = job.completedAt ?? job.startedAt;
    if (finishedAt !== null && now - finishedAt > JOB_TTL_MS) {
      jobs.delete(jobId);
      if (activeByRequest.get(job.requestKey) === jobId) activeByRequest.delete(job.requestKey);
      if (completedByRequest.get(job.requestKey) === jobId) completedByRequest.delete(job.requestKey);
      if (latestJobId === jobId) latestJobId = null;
    }
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()]
      .filter((job) => job.jobId !== latestJobId && job.status !== "queued" && job.status !== "running")
      .sort((first, second) => (first.completedAt ?? 0) - (second.completedAt ?? 0))[0];
    if (!oldest) break;
    jobs.delete(oldest.jobId);
    if (completedByRequest.get(oldest.requestKey) === oldest.jobId) completedByRequest.delete(oldest.requestKey);
  }
}

function publicJob(job: JobRecord): CandidateGenerationJob {
  const elapsedMs = job.startedAt === null
    ? 0
    : Math.max(0, (job.completedAt ?? Date.now()) - job.startedAt);
  const estimatedRemainingMs = job.status === "running"
    && job.completedUnits >= 20
    && elapsedMs >= 2_000
    ? Math.max(0, Math.round((elapsedMs / job.completedUnits) * (job.totalUnits - job.completedUnits)))
    : null;
  return {
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    completedUnits: job.completedUnits,
    totalUnits: job.totalUnits,
    percent: job.status === "completed" ? 100 : Math.min(99, Math.round((job.completedUnits / job.totalUnits) * 100)),
    completedSessions: job.completedSessions,
    totalSessions: job.totalSessions,
    elapsedMs,
    estimatedRemainingMs,
    message: job.message,
    error: job.error,
    reviewSetId: job.reviewSetId,
    ...(job.result ? { result: job.result } : {}),
  };
}

function updateJob(job: JobRecord, update: Partial<Omit<VisualValidationWorkerProgress, "phase">> & {
  status?: CandidateGenerationStatus;
  phase?: CandidateGenerationPhase;
  message?: string;
  error?: string | null;
}): void {
  job.status = update.status ?? job.status;
  job.phase = update.phase ?? job.phase;
  job.completedUnits = Math.max(job.completedUnits, update.completedUnits ?? job.completedUnits);
  job.completedSessions = Math.max(job.completedSessions, update.completedSessions ?? job.completedSessions);
  job.totalSessions = Math.max(job.totalSessions, update.totalSessions ?? job.totalSessions);
  job.message = update.message ?? job.message;
  job.error = update.error === undefined ? job.error : update.error;
}

async function runJob(job: JobRecord): Promise<void> {
  const previous = generationTail;
  let release!: () => void;
  generationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  job.status = "running";
  job.startedAt = Date.now();
  updateJob(job, {
    phase: "preparing",
    completedUnits: 0,
    completedSessions: 0,
    totalSessions: 0,
    message: "Preparing historical replay",
    error: null,
  });
  try {
    let built: Omit<VisualValidationSet, "reviewSetId" | "createdAt">;
    if (job.request.source === "simulated") {
      updateJob(job, { phase: "loading_sessions", completedUnits: 15, message: "Loading deterministic fixture sessions" });
      updateJob(job, { phase: "replaying_sessions", completedUnits: 75, completedSessions: 1, totalSessions: 1, message: "Replaying fixture session 1 of 1" });
      updateJob(job, { phase: "building_ledger", completedUnits: 80, message: "Finding confirmed P → E signals" });
      updateJob(job, { phase: "projecting_candidates", completedUnits: 90, message: "Creating authoritative trade candidates" });
      built = buildVisualValidationSet(job.request);
      updateJob(job, { phase: "building_snapshots", completedUnits: 99, message: "Building chart review snapshots" });
    } else {
      built = await buildHistoricalVisualValidationSetInWorker(job.request, 300_000, (progress) => {
        updateJob(job, progress);
      });
    }
    const stored = storeVisualValidationSet(built);
    job.result = stored;
    job.reviewSetId = stored.reviewSetId;
    job.completedAt = Date.now();
    updateJob(job, {
      status: "completed",
      phase: "completed",
      completedUnits: 100,
      completedSessions: job.totalSessions,
      message: "Trade candidates ready",
      error: null,
    });
    completedByRequest.set(job.requestKey, job.jobId);
  } catch (error) {
    job.completedAt = Date.now();
    updateJob(job, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unable to generate the visual-validation set.",
      message: "Historical replay could not be completed.",
    });
  } finally {
    if (activeByRequest.get(job.requestKey) === job.jobId) activeByRequest.delete(job.requestKey);
    release();
    pruneJobs();
  }
}

export function startVisualValidationGenerationJob(request: VisualValidationRequest): CandidateGenerationJob {
  pruneJobs();
  const key = requestKey(request);
  const activeJobId = activeByRequest.get(key);
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (active) return publicJob(active);
  }
  const completedJobId = completedByRequest.get(key);
  if (completedJobId) {
    const completed = jobs.get(completedJobId);
    if (completed) return publicJob(completed);
  }
  const job: JobRecord = {
    jobId: randomUUID(),
    requestKey: key,
    request,
    status: "queued",
    phase: "preparing",
    completedUnits: 0,
    totalUnits: 100,
    percent: 0,
    completedSessions: 0,
    totalSessions: 0,
    elapsedMs: 0,
    estimatedRemainingMs: null,
    message: "Queued for historical replay",
    error: null,
    reviewSetId: null,
    startedAt: null,
    completedAt: null,
  };
  jobs.set(job.jobId, job);
  activeByRequest.set(key, job.jobId);
  latestJobId = job.jobId;
  void runJob(job);
  return publicJob(job);
}

export function getVisualValidationGenerationJob(jobId: string): CandidateGenerationJob | null {
  pruneJobs();
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}

export function getLatestVisualValidationGenerationJob(): CandidateGenerationJob | null {
  pruneJobs();
  return latestJobId ? getVisualValidationGenerationJob(latestJobId) : null;
}