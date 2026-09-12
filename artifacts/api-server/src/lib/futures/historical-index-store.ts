import { DatabaseSync } from "node:sqlite";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { HistoricalCsvImportSummary, HistoricalCsvImport } from "./historical-csv-import.js";
import type { NormalizedCandle } from "./market-data-provider.js";
import { tradingDateForTimestamp, type FuturesSessionCalendar } from "./session-calendar.js";

export type HistoricalIndexMetadata = {
  indexKey: string;
  contentFingerprint: string;
  summary: unknown;
  importerVersion: string;
  scheduleVersion: string;
  indexedAt: string;
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
    this.database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS index_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
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
    };
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
    const partitions = new Map<string, NormalizedCandle[]>();
    for (const candle of candles) {
      const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
      const partition = partitions.get(tradingDate) ?? [];
      partition.push(candle);
      partitions.set(tradingDate, partition);
    }
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
    for (const [tradingDate, partition] of partitions) {
      partitionStatement.run(contractSymbol, tradingDate, timeframe, partition.length);
      for (const candle of partition) {
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
    }
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