import { DatabaseSync } from "node:sqlite";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { HistoricalCsvImportSummary, HistoricalCsvImport } from "./historical-csv-import.js";
import type { NormalizedCandle } from "./market-data-provider.js";
import { tradingDateForTimestamp, type FuturesSessionCalendar } from "./session-calendar.js";

export const HISTORICAL_INDEX_SCHEMA_VERSION = 4 as const;
export const HISTORICAL_INDEX_MANIFEST_VERSION = 2 as const;

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

  static create(path: string): HistoricalIndexStore {
    const database = new DatabaseSync(path);
    const store = new HistoricalIndexStore(database, path);
    store.initialize();
    return store;
  }

  static async createAtomic(path: string): Promise<HistoricalIndexStore> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    const database = new DatabaseSync(temporaryPath);
    const store = new HistoricalIndexStore(database, path);
    store.initialize();
    store.temporaryPath = temporaryPath;
    return store;
  }

  private temporaryPath: string | null = null;

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
      CREATE INDEX IF NOT EXISTS candles_by_date
        ON candles (trading_date, contract_symbol, timeframe, open_time);
      CREATE INDEX IF NOT EXISTS candles_by_contract_time
        ON candles (contract_symbol, timeframe, open_time);
    `);
    const manifestColumns = this.database.prepare("PRAGMA table_info(index_manifest_files)").all() as Array<{ name: string }>;
    if (!manifestColumns.some((column) => column.name === "detected_contracts_json")) {
      this.database.exec("ALTER TABLE index_manifest_files ADD COLUMN detected_contracts_json TEXT");
    }
    if (existingVersion > 0 && existingVersion < HISTORICAL_INDEX_SCHEMA_VERSION) {
      this.database.exec("DELETE FROM index_metadata; DELETE FROM index_manifest; DELETE FROM index_manifest_files; DELETE FROM source_files; DELETE FROM candle_partitions; DELETE FROM candles;");
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
    const integrity = this.database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    if (integrity.integrity_check !== "ok") errors.push("SQLITE_INTEGRITY_CHECK_FAILED");
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
}