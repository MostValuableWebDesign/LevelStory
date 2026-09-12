import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { historicalDataPath } from "./historical-storage-paths.js";

export type HistoricalImportPhase =
  | "queued"
  | "materializing"
  | "validating"
  | "indexing"
  | "aggregating"
  | "reconciling"
  | "committing"
  | "ready"
  | "failed"
  | "cancelled";

export type PersistedHistoricalImportFile = {
  objectPath: string;
  originalFilename: string;
  materializedPath?: string | null;
  expectedCompression?: "none" | "zstd";
  contentFingerprint?: string | null;
  sizeBytes?: number | null;
  declaredSizeBytes?: number | null;
  state?: "queued" | "materialized" | "accepted" | "rejected" | "failed";
  detectedContracts?: string[];
  rowsProcessed?: number;
  acceptedRows?: number;
  rejectedRows?: number;
  rejectionReason?: string | null;
};

export type PersistedHistoricalImportJob = {
  jobId: string;
  state: HistoricalImportPhase;
  files: PersistedHistoricalImportFile[];
  materializedFileCount: number;
  currentFilename: string | null;
  currentContract: string | null;
  currentTradingDate: string | null;
  progress: number;
  phaseProgress: number;
  rowsProcessed: number;
  acceptedRows: number;
  rejectedRows: number;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  status: unknown | null;
  indexKey: string | null;
  stagingIndexPath: string | null;
  sourceFingerprint: string | null;
  sourceOffset: number | null;
  completedPartitions: string[];
  leaseOwner: string | null;
  leaseUntil: string | null;
  heartbeatAt: string | null;
};

const defaultPath = historicalDataPath("historical-import-jobs.sqlite");
export const HISTORICAL_IMPORT_JOB_SCHEMA_VERSION = 3 as const;

export class HistoricalImportJobStore {
  private readonly database: DatabaseSync;

  constructor(path = defaultPath) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    const existingVersion = Number((this.database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
    if (existingVersion > HISTORICAL_IMPORT_JOB_SCHEMA_VERSION) {
      throw new Error(`Historical import job schema ${existingVersion} is newer than supported schema ${HISTORICAL_IMPORT_JOB_SCHEMA_VERSION}.`);
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS import_jobs (
        job_id TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL,
        files_json TEXT NOT NULL,
        materialized_file_count INTEGER NOT NULL,
        current_filename TEXT,
        current_contract TEXT,
        current_trading_date TEXT,
        progress REAL NOT NULL,
        phase_progress REAL NOT NULL,
        rows_processed INTEGER NOT NULL,
        accepted_rows INTEGER NOT NULL,
        rejected_rows INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        status_json TEXT,
         index_key TEXT,
         staging_index_path TEXT,
         source_fingerprint TEXT,
         source_offset INTEGER,
         completed_partitions_json TEXT NOT NULL DEFAULT '[]',
         lease_owner TEXT,
         lease_until TEXT,
         heartbeat_at TEXT
      );
      CREATE INDEX IF NOT EXISTS import_jobs_state ON import_jobs(state, updated_at);
    `);
    const columns = new Set((this.database.prepare("PRAGMA table_info(import_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    for (const column of [
      "lease_owner", "lease_until", "heartbeat_at", "source_fingerprint", "source_offset",
    ]) {
      if (!columns.has(column)) this.database.exec(`ALTER TABLE import_jobs ADD COLUMN ${column} TEXT`);
    }
    if (!columns.has("completed_partitions_json")) {
      this.database.exec("ALTER TABLE import_jobs ADD COLUMN completed_partitions_json TEXT NOT NULL DEFAULT '[]'");
    }
    this.database.exec(`PRAGMA user_version = ${HISTORICAL_IMPORT_JOB_SCHEMA_VERSION}`);
  }

  create(job: PersistedHistoricalImportJob): void {
    this.database.prepare(`
      INSERT INTO import_jobs
      (job_id, state, files_json, materialized_file_count, current_filename,
       current_contract, current_trading_date, progress, phase_progress,
       rows_processed, accepted_rows, rejected_rows, created_at, started_at,
       updated_at, completed_at, error, status_json, index_key, staging_index_path,
        source_fingerprint, source_offset, completed_partitions_json,
        lease_owner, lease_until, heartbeat_at)
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
    `).run(
      job.jobId,
      job.state,
      JSON.stringify(job.files),
      job.materializedFileCount,
      job.currentFilename,
      job.currentContract,
      job.currentTradingDate,
      job.progress,
      job.phaseProgress,
      job.rowsProcessed,
      job.acceptedRows,
      job.rejectedRows,
      job.createdAt,
      job.startedAt,
      job.updatedAt,
      job.completedAt,
      job.error,
      job.status === null ? null : JSON.stringify(job.status),
      job.indexKey,
      job.stagingIndexPath,
      job.sourceFingerprint,
      job.sourceOffset,
      JSON.stringify(job.completedPartitions),
      job.leaseOwner,
      job.leaseUntil,
      job.heartbeatAt,
    );
  }

  get(jobId: string): PersistedHistoricalImportJob | null {
    const row = this.database.prepare("SELECT * FROM import_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  update(jobId: string, patch: Partial<PersistedHistoricalImportJob>): PersistedHistoricalImportJob {
    const current = this.get(jobId);
    if (!current) throw new Error(`Historical import job ${jobId} was not found.`);
    const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    this.persist(next, jobId);
    return next;
  }

  updateIfState(
    jobId: string,
    expectedStates: readonly HistoricalImportPhase[],
    patch: Partial<PersistedHistoricalImportJob>,
  ): PersistedHistoricalImportJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(jobId);
      if (!current || !expectedStates.includes(current.state)) {
        this.database.exec("ROLLBACK");
        return null;
      }
      const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      this.persist(next, jobId);
      this.database.exec("COMMIT");
      return next;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private persist(next: PersistedHistoricalImportJob, jobId: string): void {
    this.database.prepare(`
      UPDATE import_jobs SET
        state = ?, files_json = ?, materialized_file_count = ?, current_filename = ?,
        current_contract = ?, current_trading_date = ?, progress = ?, phase_progress = ?,
        rows_processed = ?, accepted_rows = ?, rejected_rows = ?, created_at = ?,
        started_at = ?, updated_at = ?, completed_at = ?, error = ?, status_json = ?,
        index_key = ?, staging_index_path = ?
        , source_fingerprint = ?, source_offset = ?, completed_partitions_json = ?
        , lease_owner = ?, lease_until = ?, heartbeat_at = ?
      WHERE job_id = ?
    `).run(
      next.state,
      JSON.stringify(next.files),
      next.materializedFileCount,
      next.currentFilename,
      next.currentContract,
      next.currentTradingDate,
      next.progress,
      next.phaseProgress,
      next.rowsProcessed,
      next.acceptedRows,
      next.rejectedRows,
      next.createdAt,
      next.startedAt,
      next.updatedAt,
      next.completedAt,
      next.error,
      next.status === null ? null : JSON.stringify(next.status),
      next.indexKey,
      next.stagingIndexPath,
      next.sourceFingerprint,
      next.sourceOffset,
      JSON.stringify(next.completedPartitions),
      next.leaseOwner,
      next.leaseUntil,
      next.heartbeatAt,
      jobId,
    );
  }

  listActive(): PersistedHistoricalImportJob[] {
    return (this.database.prepare(`
      SELECT * FROM import_jobs
      WHERE state IN ('queued', 'materializing', 'validating', 'indexing', 'aggregating', 'reconciling', 'committing')
      ORDER BY created_at
    `).all() as JobRow[]).map(rowToJob);
  }

  close(): void {
    this.database.close();
  }
}

type JobRow = {
  job_id: string;
  state: HistoricalImportPhase;
  files_json: string;
  materialized_file_count: number;
  current_filename: string | null;
  current_contract: string | null;
  current_trading_date: string | null;
  progress: number;
  phase_progress: number;
  rows_processed: number;
  accepted_rows: number;
  rejected_rows: number;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
  status_json: string | null;
  index_key: string | null;
  staging_index_path: string | null;
  source_fingerprint: string | null;
  source_offset: number | null;
  completed_partitions_json: string;
  lease_owner: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
};

function rowToJob(row: JobRow): PersistedHistoricalImportJob {
  return {
    jobId: row.job_id,
    state: row.state,
    files: JSON.parse(row.files_json) as PersistedHistoricalImportFile[],
    materializedFileCount: row.materialized_file_count,
    currentFilename: row.current_filename,
    currentContract: row.current_contract,
    currentTradingDate: row.current_trading_date,
    progress: row.progress,
    phaseProgress: row.phase_progress,
    rowsProcessed: row.rows_processed,
    acceptedRows: row.accepted_rows,
    rejectedRows: row.rejected_rows,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.error,
    status: row.status_json ? JSON.parse(row.status_json) : null,
    indexKey: row.index_key,
    stagingIndexPath: row.staging_index_path,
    sourceFingerprint: row.source_fingerprint,
    sourceOffset: row.source_offset,
    completedPartitions: JSON.parse(row.completed_partitions_json || "[]") as string[],
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    heartbeatAt: row.heartbeat_at,
  };
}
