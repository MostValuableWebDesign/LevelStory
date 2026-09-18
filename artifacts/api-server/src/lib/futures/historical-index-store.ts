import { DatabaseSync } from "node:sqlite";
import { mkdir, rename, unlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { HistoricalCsvImportSummary, HistoricalCsvImport } from "./historical-csv-import.js";
import type { NormalizedCandle } from "./market-data-provider.js";
import { tradingDateForTimestamp, type FuturesSessionCalendar } from "./session-calendar.js";

export const HISTORICAL_INDEX_SCHEMA_VERSION = 4 as const;
export const HISTORICAL_INDEX_MANIFEST_VERSION = 2 as const;
export const HISTORICAL_SESSION_CATALOG_VERSION = 1 as const;

export type HistoricalSessionCatalogEntry = {
  tradingDate: string;
  contractSymbol: string;
  sessionType: string;
  timeZone: string;
  calendarIdentity: string;
  partitionIdentity: string;
  availableTimeframes: number[];
  candleCounts: {
    oneMinute: number;
    fiveMinute: number;
    fifteenMinute: number;
    oneHour: number;
  };
  tickCoverage: "not_indexed" | "available";
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
  coverageStatus: "complete" | "incomplete";
  completenessStatus: "complete" | "incomplete";
  validationStatus: "validated" | "failed";
  sourceFingerprint: string;
  ingestionVersion: string;
  schemaVersion: number;
};

export type HistoricalIndexMetadata = {
  indexKey: string;
  contentFingerprint: string;
  summary: unknown;
  importerVersion: string;
  scheduleVersion: string;
  indexedAt: string;
  schemaVersion?: number;
  sessionCalendarVersion?: string;
};

export type HistoricalIndexManifestFile = {
  ordinal: number;
  filename: string;
  contractSymbol: string | null;
  detectedContracts?: string[];
  objectPath: string | null;
  materializedPath: string | null;
  expectedCompression: "none" | "zstd";
  contentFingerprint: string | null;
  sizeBytes: number | null;
  status: "accepted" | "rejected";
  rejectionReason: string | null;
};

export type HistoricalIndexManifest = {
  indexKey: string;
  source: string;
  rootSymbol: string;
  contentFingerprint: string;
  importerVersion: string;
  scheduleVersion: string;
  sessionCalendarVersion: string;
  summary: unknown;
  indexedAt: string;
  committedAt: string;
  files: readonly HistoricalIndexManifestFile[];
};

export type HistoricalIndexCheckpoint = {
  sourceFingerprint: string;
  currentFile: string | null;
  currentContract: string | null;
  currentTradingDate: string | null;
  sourceOffset: number | null;
  completedPartitions: readonly string[];
  completedFiles: ReadonlyArray<{
    filename: string;
    path: string;
    contractSymbol: string;
    fingerprint: string;
    summary: HistoricalCsvImportSummary;
  }>;
  rowsProcessed: number;
  acceptedRows: number;
  rejectedRows: number;
  stagingIndexPath: string;
  heartbeatAt: string;
  resumeNote: string | null;
};

type CandleRow = {
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  contract_symbol: string;
  is_complete: number;
  quality_codes: string;
};

const TIMEFRAMES = [1, 5, 15, 60] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

export class HistoricalIndexStore {
  private constructor(
    private readonly database: DatabaseSync,
    readonly path: string,
  ) {}

  static create(path: string, options: { readOnly?: boolean } = {}): HistoricalIndexStore {
    const database = new DatabaseSync(path, options.readOnly
      ? { readOnly: true, timeout: 30_000 }
      : { timeout: 30_000 });
    const existingVersion = Number(
      (database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0,
    );
    if (existingVersion > 0 && existingVersion !== HISTORICAL_INDEX_SCHEMA_VERSION) {
      database.close();
      throw new Error(
        `Historical index schema ${existingVersion} is incompatible with supported schema ${HISTORICAL_INDEX_SCHEMA_VERSION}; `
        + "regeneration is required and the existing index was preserved.",
      );
    }
    const store = new HistoricalIndexStore(database, path);
    if (!options.readOnly) store.initialize();
    return store;
  }

  static async createAtomic(path: string, resumePath?: string | null): Promise<HistoricalIndexStore> {
    await mkdir(dirname(path), { recursive: true });
    let temporaryPath = resumePath ?? `${path}.${process.pid}.${Date.now()}.tmp`;
    if (resumePath) {
      try {
        await stat(resumePath);
      } catch {
        temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      }
    }
    const database = new DatabaseSync(temporaryPath);
    const store = new HistoricalIndexStore(database, path);
    store.initialize();
    // Checkpoints and atomic replacement preserve process-crash recovery; NORMAL
    // synchronous mode avoids an fsync for every large staging transaction.
    database.exec("PRAGMA synchronous = NORMAL;");
    store.temporaryPath = temporaryPath;
    return store;
  }

  private temporaryPath: string | null = null;

  get stagingPath(): string | null {
    return this.temporaryPath;
  }

  private initialize(): void {
    const existingVersion = Number((this.database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
    if (existingVersion > HISTORICAL_INDEX_SCHEMA_VERSION) {
      throw new Error(
        `Historical index schema ${existingVersion} is newer than supported schema ${HISTORICAL_INDEX_SCHEMA_VERSION}; regeneration is required.`,
      );
    }
    this.database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS index_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_manifest (
        index_key TEXT PRIMARY KEY NOT NULL,
        manifest_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        root_symbol TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        importer_version TEXT NOT NULL,
        schedule_version TEXT NOT NULL,
        session_calendar_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'committed'),
        summary_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        committed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_manifest_files (
        index_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        filename TEXT NOT NULL,
        contract_symbol TEXT,
        detected_contracts_json TEXT,
        object_path TEXT,
        materialized_path TEXT,
        expected_compression TEXT NOT NULL CHECK (expected_compression IN ('none', 'zstd')),
        content_fingerprint TEXT,
        size_bytes INTEGER,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
        rejection_reason TEXT,
        PRIMARY KEY (index_key, ordinal),
        UNIQUE (index_key, filename),
        FOREIGN KEY (index_key) REFERENCES index_manifest(index_key) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS source_files (
        filename TEXT PRIMARY KEY NOT NULL,
        contract_symbol TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        earliest_timestamp TEXT,
        latest_timestamp TEXT,
        total_rows INTEGER NOT NULL,
        valid_rows INTEGER NOT NULL,
        rejected_rows INTEGER NOT NULL,
        duplicate_rows_removed INTEGER NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candle_partitions (
        contract_symbol TEXT NOT NULL,
        trading_date TEXT NOT NULL,
        timeframe INTEGER NOT NULL,
        candle_count INTEGER NOT NULL,
        PRIMARY KEY (contract_symbol, trading_date, timeframe)
      );
      CREATE TABLE IF NOT EXISTS session_catalog (
        trading_date TEXT NOT NULL,
        contract_symbol TEXT NOT NULL,
        session_type TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        calendar_identity TEXT NOT NULL,
        partition_identity TEXT NOT NULL,
        available_timeframes_json TEXT NOT NULL,
        one_minute_candle_count INTEGER NOT NULL,
        five_minute_candle_count INTEGER NOT NULL,
        fifteen_minute_candle_count INTEGER NOT NULL,
        one_hour_candle_count INTEGER NOT NULL,
        tick_coverage TEXT NOT NULL CHECK (tick_coverage IN ('not_indexed', 'available')),
        earliest_timestamp TEXT,
        latest_timestamp TEXT,
        coverage_status TEXT NOT NULL CHECK (coverage_status IN ('complete', 'incomplete')),
        completeness_status TEXT NOT NULL CHECK (completeness_status IN ('complete', 'incomplete')),
        validation_status TEXT NOT NULL CHECK (validation_status IN ('validated', 'failed')),
        source_fingerprint TEXT NOT NULL,
        ingestion_version TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (trading_date, contract_symbol)
      );
      CREATE TABLE IF NOT EXISTS candles (
        contract_symbol TEXT NOT NULL,
        trading_date TEXT NOT NULL,
        timeframe INTEGER NOT NULL,
        open_time INTEGER NOT NULL,
        close_time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL,
        bid REAL,
        ask REAL,
        bid_size REAL,
        ask_size REAL,
        is_complete INTEGER NOT NULL,
        quality_codes TEXT NOT NULL,
        PRIMARY KEY (contract_symbol, trading_date, timeframe, open_time),
        FOREIGN KEY (contract_symbol, trading_date, timeframe)
          REFERENCES candle_partitions(contract_symbol, trading_date, timeframe)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS import_checkpoint (
        checkpoint_id INTEGER PRIMARY KEY CHECK (checkpoint_id = 1),
        checkpoint_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS candles_by_date
        ON candles (trading_date, contract_symbol, timeframe, open_time);
      CREATE INDEX IF NOT EXISTS candles_by_contract_time
        ON candles (contract_symbol, timeframe, open_time);
    `);
    const manifestColumns = this.database.prepare("PRAGMA table_info(index_manifest_files)").all() as Array<{ name: string }>;
    if (!manifestColumns.some((column) => column.name === "detected_contracts_json")) {
      this.database.exec("ALTER TABLE index_manifest_files ADD COLUMN detected_contracts_json TEXT");
    }
    this.database.exec(`PRAGMA user_version = ${HISTORICAL_INDEX_SCHEMA_VERSION}`);
  }

  writeMetadata(metadata: HistoricalIndexMetadata): void {
    const statement = this.database.prepare(
      "INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)",
    );
    const entries: Array<[string, string]> = [
      ["indexKey", metadata.indexKey],
      ["contentFingerprint", metadata.contentFingerprint],
      ["summary", JSON.stringify(metadata.summary)],
      ["importerVersion", metadata.importerVersion],
      ["scheduleVersion", metadata.scheduleVersion],
      ["indexedAt", metadata.indexedAt],
      ["schemaVersion", String(metadata.schemaVersion ?? HISTORICAL_INDEX_SCHEMA_VERSION)],
      ["sessionCalendarVersion", metadata.sessionCalendarVersion ?? "unknown"],
    ];
    for (const [key, value] of entries) statement.run(key, value);
  }

  writeCheckpoint(checkpoint: HistoricalIndexCheckpoint): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO import_checkpoint (checkpoint_id, checkpoint_json)
      VALUES (1, ?)
    `).run(JSON.stringify(checkpoint));
  }

  readCheckpoint(): HistoricalIndexCheckpoint | null {
    const row = this.database.prepare(
      "SELECT checkpoint_json FROM import_checkpoint WHERE checkpoint_id = 1",
    ).get() as { checkpoint_json?: string } | undefined;
    return row?.checkpoint_json ? JSON.parse(row.checkpoint_json) as HistoricalIndexCheckpoint : null;
  }

  readMetadata(): HistoricalIndexMetadata | null {
    const rows = this.database.prepare("SELECT key, value FROM index_metadata").all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const indexKey = values.get("indexKey");
    const contentFingerprint = values.get("contentFingerprint");
    const summary = values.get("summary");
    const importerVersion = values.get("importerVersion");
    const scheduleVersion = values.get("scheduleVersion");
    const indexedAt = values.get("indexedAt");
    if (!indexKey || !contentFingerprint || !summary || !importerVersion || !scheduleVersion || !indexedAt) return null;
    return {
      indexKey,
      contentFingerprint,
      summary: JSON.parse(summary),
      importerVersion,
      scheduleVersion,
      indexedAt,
      schemaVersion: Number(values.get("schemaVersion") ?? HISTORICAL_INDEX_SCHEMA_VERSION),
      sessionCalendarVersion: values.get("sessionCalendarVersion") ?? "unknown",
    };
  }

  writeManifest(manifest: HistoricalIndexManifest): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT OR REPLACE INTO index_manifest
        (index_key, manifest_version, source, root_symbol, content_fingerprint,
         importer_version, schedule_version, session_calendar_version, state,
         summary_json, indexed_at, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)
      `).run(
        manifest.indexKey,
        HISTORICAL_INDEX_MANIFEST_VERSION,
        manifest.source,
        manifest.rootSymbol,
        manifest.contentFingerprint,
        manifest.importerVersion,
        manifest.scheduleVersion,
        manifest.sessionCalendarVersion,
        JSON.stringify(manifest.summary),
        manifest.indexedAt,
        manifest.committedAt,
      );
      this.database.prepare("DELETE FROM index_manifest_files WHERE index_key = ?").run(manifest.indexKey);
      const statement = this.database.prepare(`
        INSERT INTO index_manifest_files
        (index_key, ordinal, filename, contract_symbol, detected_contracts_json, object_path, materialized_path,
         expected_compression, content_fingerprint, size_bytes, status, rejection_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of manifest.files) {
        statement.run(
          manifest.indexKey,
          file.ordinal,
          file.filename,
          file.contractSymbol,
          file.detectedContracts ? JSON.stringify(file.detectedContracts) : null,
          file.objectPath,
          file.materializedPath,
          file.expectedCompression,
          file.contentFingerprint,
          file.sizeBytes,
          file.status,
          file.rejectionReason,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  readManifest(): HistoricalIndexManifest | null {
    const row = this.database.prepare(`
      SELECT index_key, manifest_version, source, root_symbol, content_fingerprint,
             importer_version, schedule_version, session_calendar_version, state,
             summary_json, indexed_at, committed_at
      FROM index_manifest
      WHERE state = 'committed'
      ORDER BY committed_at DESC
      LIMIT 1
    `).get() as {
      index_key: string;
      manifest_version: number;
      source: string;
      root_symbol: string;
      content_fingerprint: string;
      importer_version: string;
      schedule_version: string;
      session_calendar_version: string;
      state: string;
      summary_json: string;
      indexed_at: string;
      committed_at: string;
    } | undefined;
    if (!row || row.manifest_version !== HISTORICAL_INDEX_MANIFEST_VERSION || row.state !== "committed") return null;
    const rows = this.database.prepare(`
      SELECT ordinal, filename, contract_symbol, detected_contracts_json, object_path, materialized_path,
             expected_compression, content_fingerprint, size_bytes, status, rejection_reason
      FROM index_manifest_files
      WHERE index_key = ?
      ORDER BY ordinal
    `).all(row.index_key) as Array<{
      ordinal: number;
      filename: string;
      contract_symbol: string | null;
      detected_contracts_json: string | null;
      object_path: string | null;
      materialized_path: string | null;
      expected_compression: "none" | "zstd";
      content_fingerprint: string | null;
      size_bytes: number | null;
      status: "accepted" | "rejected";
      rejection_reason: string | null;
    }>;
    const files: HistoricalIndexManifestFile[] = rows.map((file) => ({
      ordinal: file.ordinal,
      filename: file.filename,
      contractSymbol: file.contract_symbol,
      detectedContracts: file.detected_contracts_json ? JSON.parse(file.detected_contracts_json) as string[] : undefined,
      objectPath: file.object_path,
      materializedPath: file.materialized_path,
      expectedCompression: file.expected_compression,
      contentFingerprint: file.content_fingerprint,
      sizeBytes: file.size_bytes,
      status: file.status,
      rejectionReason: file.rejection_reason,
    }));
    return {
      indexKey: row.index_key,
      source: row.source,
      rootSymbol: row.root_symbol,
      contentFingerprint: row.content_fingerprint,
      importerVersion: row.importer_version,
      scheduleVersion: row.schedule_version,
      sessionCalendarVersion: row.session_calendar_version,
      summary: JSON.parse(row.summary_json),
      indexedAt: row.indexed_at,
      committedAt: row.committed_at,
      files,
    };
  }

  validateCommittedManifest(expected?: {
    indexKey?: string;
    contentFingerprint?: string;
    importerVersion?: string;
    scheduleVersion?: string;
  }): string[] {
    const errors: string[] = [];
    const manifest = this.readManifest();
    if (!manifest) errors.push("COMMITTED_MANIFEST_MISSING_OR_INCOMPATIBLE");
    if (manifest && expected) {
      if (expected.indexKey && manifest.indexKey !== expected.indexKey) errors.push("MANIFEST_INDEX_KEY_MISMATCH");
      if (expected.contentFingerprint && manifest.contentFingerprint !== expected.contentFingerprint) errors.push("MANIFEST_CONTENT_FINGERPRINT_MISMATCH");
      if (expected.importerVersion && manifest.importerVersion !== expected.importerVersion) errors.push("MANIFEST_IMPORTER_VERSION_MISMATCH");
      if (expected.scheduleVersion && manifest.scheduleVersion !== expected.scheduleVersion) errors.push("MANIFEST_SCHEDULE_VERSION_MISMATCH");
    }
    return errors;
  }

  /**
   * Expensive checks are deliberately separate from routine status polling.
   * This verifies SQLite integrity and every persisted partition count.
   */
  runMaintenanceValidation(expectedSummary?: {
    aggregationCounts?: {
      oneMinute: number;
      fiveMinute: number;
      fifteenMinute: number;
      oneHour: number;
    };
  }): string[] {
    const errors: string[] = [];
    const integrity = this.database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    if (integrity.integrity_check !== "ok") errors.push("SQLITE_INTEGRITY_CHECK_FAILED");
    const mismatches = this.database.prepare(`
      SELECT p.contract_symbol, p.trading_date, p.timeframe, p.candle_count,
             COUNT(c.open_time) AS actual_count
      FROM candle_partitions p
      LEFT JOIN candles c
        ON c.contract_symbol = p.contract_symbol
       AND c.trading_date = p.trading_date
       AND c.timeframe = p.timeframe
      GROUP BY p.contract_symbol, p.trading_date, p.timeframe, p.candle_count
      HAVING p.candle_count <> COUNT(c.open_time)
    `).all() as Array<{ contract_symbol: string; trading_date: string; timeframe: number; candle_count: number; actual_count: number }>;
    for (const mismatch of mismatches) {
      errors.push(
        `PARTITION_COUNT_MISMATCH:${mismatch.contract_symbol}:${mismatch.trading_date}:${mismatch.timeframe}:${mismatch.candle_count}:${mismatch.actual_count}`,
      );
    }
    const orphan = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM candles c
      LEFT JOIN candle_partitions p
        ON p.contract_symbol = c.contract_symbol
       AND p.trading_date = c.trading_date
       AND p.timeframe = c.timeframe
      WHERE p.contract_symbol IS NULL
    `).get() as { count?: number };
    if (Number(orphan.count ?? 0) > 0) errors.push(`ORPHAN_CANDLE_ROWS:${Number(orphan.count)}`);
    if (expectedSummary?.aggregationCounts) {
      const expected = expectedSummary.aggregationCounts;
      const actual = this.database.prepare(`
        SELECT timeframe, COUNT(*) AS count
        FROM candles
        GROUP BY timeframe
      `).all() as Array<{ timeframe: number; count: number }>;
      const actualByTimeframe = new Map(actual.map((row) => [row.timeframe, Number(row.count)]));
      for (const [timeframe, expectedCount] of [
        [1, expected.oneMinute],
        [5, expected.fiveMinute],
        [15, expected.fifteenMinute],
        [60, expected.oneHour],
      ] as const) {
        const actualCount = actualByTimeframe.get(timeframe) ?? 0;
        if (actualCount !== expectedCount) {
          errors.push(`AGGREGATION_COUNT_MISMATCH:${timeframe}:${expectedCount}:${actualCount}`);
        }
      }
    }
    return errors;
  }

  writeSourceSummary(summary: HistoricalCsvImportSummary, contentFingerprint: string): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO source_files
      (filename, contract_symbol, content_fingerprint, earliest_timestamp, latest_timestamp,
       total_rows, valid_rows, rejected_rows, duplicate_rows_removed, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      summary.filename,
      summary.detectedSymbol ?? "MES",
      contentFingerprint,
      summary.earliestTimestamp,
      summary.latestTimestamp,
      summary.totalRows,
      summary.validRows,
      summary.rejectedRows,
      summary.duplicateRowsRemoved,
      new Date().toISOString(),
    );
  }

  upsertSessionCatalog(entries: readonly HistoricalSessionCatalogEntry[], indexedAt = new Date().toISOString()): void {
    if (!entries.length) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.database.prepare(`
        INSERT INTO session_catalog
        (trading_date, contract_symbol, session_type, time_zone, calendar_identity,
         partition_identity, available_timeframes_json, one_minute_candle_count,
         five_minute_candle_count, fifteen_minute_candle_count, one_hour_candle_count,
         tick_coverage, earliest_timestamp, latest_timestamp, coverage_status,
         completeness_status, validation_status, source_fingerprint, ingestion_version,
         schema_version, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trading_date, contract_symbol)
        DO UPDATE SET
          session_type = excluded.session_type,
          time_zone = excluded.time_zone,
          calendar_identity = excluded.calendar_identity,
          partition_identity = excluded.partition_identity,
          available_timeframes_json = excluded.available_timeframes_json,
          one_minute_candle_count = excluded.one_minute_candle_count,
          five_minute_candle_count = excluded.five_minute_candle_count,
          fifteen_minute_candle_count = excluded.fifteen_minute_candle_count,
          one_hour_candle_count = excluded.one_hour_candle_count,
          tick_coverage = excluded.tick_coverage,
          earliest_timestamp = excluded.earliest_timestamp,
          latest_timestamp = excluded.latest_timestamp,
          coverage_status = excluded.coverage_status,
          completeness_status = excluded.completeness_status,
          validation_status = excluded.validation_status,
          source_fingerprint = excluded.source_fingerprint,
          ingestion_version = excluded.ingestion_version,
          schema_version = excluded.schema_version,
          indexed_at = excluded.indexed_at
      `);
      for (const entry of entries) {
        statement.run(
          entry.tradingDate,
          entry.contractSymbol,
          entry.sessionType,
          entry.timeZone,
          entry.calendarIdentity,
          entry.partitionIdentity,
          JSON.stringify(entry.availableTimeframes),
          entry.candleCounts.oneMinute,
          entry.candleCounts.fiveMinute,
          entry.candleCounts.fifteenMinute,
          entry.candleCounts.oneHour,
          entry.tickCoverage,
          entry.earliestTimestamp,
          entry.latestTimestamp,
          entry.coverageStatus,
          entry.completenessStatus,
          entry.validationStatus,
          entry.sourceFingerprint,
          entry.ingestionVersion,
          entry.schemaVersion,
          indexedAt,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeSessionCatalogEntries(filter: { tradingDates?: readonly string[]; contractSymbols?: readonly string[] }): number {
    const dates = [...new Set(filter.tradingDates ?? [])];
    const contracts = [...new Set(filter.contractSymbols ?? [])];
    if (!dates.length && !contracts.length) return 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const clauses: string[] = [];
      const parameters: string[] = [];
      if (dates.length) {
        clauses.push(`trading_date IN (${dates.map(() => "?").join(", ")})`);
        parameters.push(...dates);
      }
      if (contracts.length) {
        clauses.push(`contract_symbol IN (${contracts.map(() => "?").join(", ")})`);
        parameters.push(...contracts);
      }
      const result = this.database.prepare(
        `DELETE FROM session_catalog WHERE ${clauses.join(" OR ")}`,
      ).run(...parameters);
      this.database.exec("COMMIT");
      return Number(result.changes ?? 0);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getSessionCatalogEntries(options: {
    startDate?: string;
    endDate?: string;
    contractSymbol?: string;
    includeIncomplete?: boolean;
  } = {}): HistoricalSessionCatalogEntry[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (options.startDate) {
      clauses.push("trading_date >= ?");
      parameters.push(options.startDate);
    }
    if (options.endDate) {
      clauses.push("trading_date <= ?");
      parameters.push(options.endDate);
    }
    if (options.contractSymbol) {
      clauses.push("contract_symbol = ?");
      parameters.push(options.contractSymbol);
    }
    if (options.includeIncomplete === false) clauses.push("coverage_status = 'complete'");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT trading_date, contract_symbol, session_type, time_zone, calendar_identity,
             partition_identity, available_timeframes_json, one_minute_candle_count,
             five_minute_candle_count, fifteen_minute_candle_count, one_hour_candle_count,
             tick_coverage, earliest_timestamp, latest_timestamp, coverage_status,
             completeness_status, validation_status, source_fingerprint, ingestion_version,
             schema_version
      FROM session_catalog
      ${where}
      ORDER BY trading_date, contract_symbol
    `).all(...parameters) as Array<{
      trading_date: string;
      contract_symbol: string;
      session_type: string;
      time_zone: string;
      calendar_identity: string;
      partition_identity: string;
      available_timeframes_json: string;
      one_minute_candle_count: number;
      five_minute_candle_count: number;
      fifteen_minute_candle_count: number;
      one_hour_candle_count: number;
      tick_coverage: "not_indexed" | "available";
      earliest_timestamp: string | null;
      latest_timestamp: string | null;
      coverage_status: "complete" | "incomplete";
      completeness_status: "complete" | "incomplete";
      validation_status: "validated" | "failed";
      source_fingerprint: string;
      ingestion_version: string;
      schema_version: number;
    }>;
    return rows.map((row) => ({
      tradingDate: row.trading_date,
      contractSymbol: row.contract_symbol,
      sessionType: row.session_type,
      timeZone: row.time_zone,
      calendarIdentity: row.calendar_identity,
      partitionIdentity: row.partition_identity,
      availableTimeframes: JSON.parse(row.available_timeframes_json) as number[],
      candleCounts: {
        oneMinute: row.one_minute_candle_count,
        fiveMinute: row.five_minute_candle_count,
        fifteenMinute: row.fifteen_minute_candle_count,
        oneHour: row.one_hour_candle_count,
      },
      tickCoverage: row.tick_coverage,
      earliestTimestamp: row.earliest_timestamp,
      latestTimestamp: row.latest_timestamp,
      coverageStatus: row.coverage_status,
      completenessStatus: row.completeness_status,
      validationStatus: row.validation_status,
      sourceFingerprint: row.source_fingerprint,
      ingestionVersion: row.ingestion_version,
      schemaVersion: row.schema_version,
    }));
  }

  getSessionCatalogDates(options: { startDate?: string; endDate?: string } = {}): string[] {
    const catalogExists = this.database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'session_catalog' LIMIT 1",
    ).get() as { present?: number } | undefined;
    if (!catalogExists?.present) {
      const clauses: string[] = [];
      const parameters: string[] = [];
      if (options.startDate) {
        clauses.push("trading_date >= ?");
        parameters.push(options.startDate);
      }
      if (options.endDate) {
        clauses.push("trading_date <= ?");
        parameters.push(options.endDate);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return (this.database.prepare(
        `SELECT DISTINCT trading_date FROM candle_partitions ${where} ORDER BY trading_date`,
      ).all(...parameters) as Array<{ trading_date: string }>).map((row) => row.trading_date);
    }
    return [...new Set(this.getSessionCatalogEntries(options).map((entry) => entry.tradingDate))];
  }

  getSessionCatalogContractSymbolsForDate(tradingDate: string): string[] {
    const catalogExists = this.database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'session_catalog' LIMIT 1",
    ).get() as { present?: number } | undefined;
    if (!catalogExists?.present) return this.getContractSymbolsForDate(tradingDate, 1);
    return this.getSessionCatalogEntries({ startDate: tradingDate, endDate: tradingDate })
      .map((entry) => entry.contractSymbol);
  }

  getPartitionCoverage(contractSymbol: string, tradingDate: string): {
    candleCounts: HistoricalSessionCatalogEntry["candleCounts"];
    availableTimeframes: number[];
    earliestTimestamp: string | null;
    latestTimestamp: string | null;
  } {
    const rows = this.database.prepare(`
      SELECT p.timeframe, p.candle_count,
             MIN(c.open_time) AS earliest_timestamp,
             MAX(c.close_time) AS latest_timestamp
      FROM candle_partitions p
      LEFT JOIN candles c
        ON c.contract_symbol = p.contract_symbol
       AND c.trading_date = p.trading_date
       AND c.timeframe = p.timeframe
      WHERE p.contract_symbol = ? AND p.trading_date = ?
      GROUP BY p.timeframe, p.candle_count
      ORDER BY p.timeframe
    `).all(contractSymbol, tradingDate) as Array<{
      timeframe: number;
      candle_count: number;
      earliest_timestamp: number | null;
      latest_timestamp: number | null;
    }>;
    const countFor = (timeframe: number): number => rows.find((row) => row.timeframe === timeframe)?.candle_count ?? 0;
    const timestamps = rows.flatMap((row) => [
      row.earliest_timestamp,
      row.latest_timestamp,
    ]).filter((value): value is number => value !== null);
    return {
      candleCounts: {
        oneMinute: countFor(1),
        fiveMinute: countFor(5),
        fifteenMinute: countFor(15),
        oneHour: countFor(60),
      },
      availableTimeframes: rows.filter((row) => row.candle_count > 0).map((row) => row.timeframe),
      earliestTimestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
      latestTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    };
  }

  /**
   * Append one bounded parser batch without materializing the source file.
   * Partition counts are recomputed only for dates touched by this batch, so
   * repeated batches remain idempotent without deleting prior partitions.
   */
  writeCandleBatch(
    contractSymbol: string,
    candles: readonly NormalizedCandle[],
    timeframe: Timeframe,
    calendar: FuturesSessionCalendar,
    signal?: AbortSignal,
  ): number {
    if (!candles.length) return 0;
    if (signal?.aborted) throw new Error("Historical index write was cancelled.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const touchedDates = new Set<string>();
      const candleStatement = this.database.prepare(`
        INSERT OR REPLACE INTO candles
        (contract_symbol, trading_date, timeframe, open_time, close_time, open, high, low, close,
         volume, bid, ask, bid_size, ask_size, is_complete, quality_codes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const partitionStatement = this.database.prepare(`
        INSERT OR IGNORE INTO candle_partitions
        (contract_symbol, trading_date, timeframe, candle_count)
        VALUES (?, ?, ?, 0)
      `);
      for (const candle of candles) {
        if (signal?.aborted) throw new Error("Historical index write was cancelled.");
        if (candle.contractSymbol !== contractSymbol) {
          throw new Error(
            `Historical index partition contract mismatch: partition=${contractSymbol}, candle=${candle.contractSymbol}.`,
          );
        }
        touchedDates.add(tradingDateForTimestamp(candle.openTime, calendar));
      }
      for (const tradingDate of touchedDates) {
        partitionStatement.run(contractSymbol, tradingDate, timeframe);
      }
      const existingByKey = new Map<string, Partial<CandleRow>>();
      if (touchedDates.size > 0) {
        const datePlaceholders = [...touchedDates].map(() => "?").join(", ");
        const existingRows = this.database.prepare(`
          SELECT trading_date, open_time, close_time, open, high, low, close, volume, bid, ask, bid_size,
                 ask_size, is_complete, quality_codes
          FROM candles
          WHERE contract_symbol = ? AND timeframe = ? AND trading_date IN (${datePlaceholders})
        `).all(contractSymbol, timeframe, ...touchedDates) as Array<Partial<CandleRow> & { trading_date: string }>;
        for (const existing of existingRows) {
          existingByKey.set(`${existing.trading_date}:${existing.open_time}`, existing);
        }
      }
      for (const candle of candles) {
        if (candle.contractSymbol !== contractSymbol) {
          throw new Error(
            `Historical index partition contract mismatch: partition=${contractSymbol}, candle=${candle.contractSymbol}.`,
          );
        }
        const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
        touchedDates.add(tradingDate);
        const existing = existingByKey.get(`${tradingDate}:${candle.openTime}`);
        if (existing && (
          existing.close_time !== candle.closeTime
          || existing.open !== candle.open
          || existing.high !== candle.high
          || existing.low !== candle.low
          || existing.close !== candle.close
          || (existing.volume ?? null) !== (candle.volume ?? null)
        )) {
          throw new Error(
            `Conflicting historical candle at ${contractSymbol} ${tradingDate} ${candle.openTime}.`,
          );
        }
        candleStatement.run(
          contractSymbol,
          tradingDate,
          timeframe,
          candle.openTime,
          candle.closeTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.bid,
          candle.ask,
          candle.bidSize,
          candle.askSize,
          candle.isComplete ? 1 : 0,
          JSON.stringify(candle.quality.codes),
        );
      }
      const updatePartitionStatement = this.database.prepare(`
        INSERT INTO candle_partitions
        (contract_symbol, trading_date, timeframe, candle_count)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(contract_symbol, trading_date, timeframe)
        DO UPDATE SET candle_count = excluded.candle_count
      `);
      const countStatement = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM candles
        WHERE contract_symbol = ? AND trading_date = ? AND timeframe = ?
      `);
      for (const tradingDate of touchedDates) {
        const row = countStatement.get(contractSymbol, tradingDate, timeframe) as { count?: number };
        updatePartitionStatement.run(contractSymbol, tradingDate, timeframe, Number(row.count ?? 0));
      }
      this.database.exec("COMMIT");
      return 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  writeImport(imported: HistoricalCsvImport, contentFingerprint: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.writeSourceSummary(imported.summary, contentFingerprint);
      this.writeCandles(imported.specification.fullContractSymbol, imported.oneMinute, 1, imported.calendar);
      this.writeCandles(imported.specification.fullContractSymbol, imported.fiveMinute, 5, imported.calendar);
      this.writeCandles(imported.specification.fullContractSymbol, imported.fifteenMinute, 15, imported.calendar);
      this.writeCandles(imported.specification.fullContractSymbol, imported.oneHour, 60, imported.calendar);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeCandles(
    contractSymbol: string,
    candles: readonly NormalizedCandle[],
    timeframe: Timeframe,
    calendar: FuturesSessionCalendar,
  ): void {
    const partitionStatement = this.database.prepare(`
      INSERT OR REPLACE INTO candle_partitions
      (contract_symbol, trading_date, timeframe, candle_count)
      VALUES (?, ?, ?, ?)
    `);
    const candleStatement = this.database.prepare(`
      INSERT OR REPLACE INTO candles
      (contract_symbol, trading_date, timeframe, open_time, close_time, open, high, low, close,
       volume, bid, ask, bid_size, ask_size, is_complete, quality_codes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let currentDate: string | null = null;
    let partition: NormalizedCandle[] = [];
    const flush = (): void => {
      if (!currentDate || !partition.length) return;
      partitionStatement.run(contractSymbol, currentDate, timeframe, partition.length);
      this.database.prepare(
        "DELETE FROM candles WHERE contract_symbol = ? AND trading_date = ? AND timeframe = ?",
      ).run(contractSymbol, currentDate, timeframe);
      for (const candle of partition) {
        if (candle.contractSymbol !== contractSymbol) {
          throw new Error(
            `Historical index partition contract mismatch: partition=${contractSymbol}, candle=${candle.contractSymbol}.`,
          );
        }
        candleStatement.run(
          contractSymbol,
          currentDate,
          timeframe,
          candle.openTime,
          candle.closeTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.bid,
          candle.ask,
          candle.bidSize,
          candle.askSize,
          candle.isComplete ? 1 : 0,
          JSON.stringify(candle.quality.codes),
        );
      }
      partition = [];
    };
    for (const candle of candles) {
      if (candle.contractSymbol !== contractSymbol) {
        throw new Error(
          `Historical index partition contract mismatch: partition=${contractSymbol}, candle=${candle.contractSymbol}.`,
        );
      }
      const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
      if (currentDate && tradingDate < currentDate) {
        throw new Error(`Historical candles for ${contractSymbol} are not ordered by trading date.`);
      }
      if (currentDate !== tradingDate) {
        flush();
        currentDate = tradingDate;
      }
      partition.push(candle);
    }
    flush();
  }

  getCandles(contractSymbol: string, tradingDate: string, timeframe: Timeframe): NormalizedCandle[] {
    const rows = this.database.prepare(`
      SELECT open_time, close_time, open, high, low, close, volume, bid, ask, bid_size, ask_size,
             contract_symbol, is_complete, quality_codes
      FROM candles
      WHERE contract_symbol = ? AND trading_date = ? AND timeframe = ?
      ORDER BY open_time
    `).all(contractSymbol, tradingDate, timeframe) as CandleRow[];
    return rows.map((row) => ({
      timestamp: row.open_time,
      openTime: row.open_time,
      closeTime: row.close_time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      bid: row.bid,
      ask: row.ask,
      bidSize: row.bid_size,
      askSize: row.ask_size,
      contractSymbol: row.contract_symbol,
      isComplete: row.is_complete === 1,
      intervalMinutes: timeframe,
      quality: { valid: true, codes: JSON.parse(row.quality_codes) as string[] },
    }));
  }

  getContractSymbolsForDate(tradingDate: string, timeframe: Timeframe = 1): string[] {
    return (this.database.prepare(`
      SELECT DISTINCT contract_symbol
      FROM candles
      WHERE trading_date = ? AND timeframe = ?
      ORDER BY contract_symbol
    `).all(tradingDate, timeframe) as Array<{ contract_symbol: string }>)
      .map((row) => row.contract_symbol);
  }

  getPartitionCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM candle_partitions").get() as { count: number };
    return Number(row.count);
  }

  close(): void {
    this.database.close();
  }

  async commitAtomic(): Promise<void> {
    if (!this.temporaryPath) throw new Error("This index store is not an atomic staging store.");
    this.close();
    await rename(this.temporaryPath, this.path);
    this.temporaryPath = null;
  }

  async abortAtomic(): Promise<void> {
    const temporaryPath = this.temporaryPath;
    this.close();
    this.temporaryPath = null;
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
  }

  preserveAtomic(): string | null {
    const temporaryPath = this.temporaryPath;
    this.close();
    this.temporaryPath = null;
    return temporaryPath;
  }
}