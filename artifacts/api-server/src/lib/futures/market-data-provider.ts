import { readFile } from "node:fs/promises";
import { generateSimulatedFuturesFeed, type SimulatedFuturesCandle } from "./simulated-feed.js";
import {
  classifyFuturesSession,
  previousTradingDate,
  sessionCalendarForContract,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "./session-calendar.js";
import type { FuturesContractSpecification } from "./contracts.js";

const MINUTE = 60_000;
const FIVE_MINUTES = 5 * MINUTE;
const DEFAULT_DATASET = "GLBX.MDP3";
const DEFAULT_STALE_SECONDS = 90;

export type MarketDataProviderKind = "simulated" | "csv" | "databento";
export type MarketDataFeedState = "simulated" | "csv_replay" | "live_shadow" | "delayed_shadow" | "disconnected";
export type MarketStatus = "premarket" | "open" | "closed";

export type NormalizedQuote = {
  timestamp: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  contractSymbol: string;
};

export type NormalizedTrade = {
  timestamp: number;
  price: number | null;
  size: number | null;
  aggressor: "buy" | "sell" | "unknown" | null;
  contractSymbol: string;
};

export type NormalizedCandle = {
  timestamp: number;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  contractSymbol: string;
  isComplete: boolean;
  intervalMinutes: 1 | 5 | 15 | 60;
  quality: {
    valid: boolean;
    codes: string[];
  };
};

export type MarketDataQuality = {
  valid: boolean;
  stale: boolean;
  delayed: boolean;
  completeCandleCount: number;
  incompleteCandleCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  gapCount: number;
  missingBidAskCount: number;
  missingVolumeCount: number;
  contractMismatchCount: number;
  codes: string[];
};

export type ProviderHealth = {
  provider: MarketDataProviderKind;
  state: MarketDataFeedState;
  connected: boolean;
  authenticated: boolean;
  delayed: boolean;
  lastEventAt: number | null;
  checkedAt: number;
  message: string;
  quality: MarketDataQuality | null;
};

export type ProviderMetadata = {
  provider: MarketDataProviderKind;
  displayName: string;
  dataset: string | null;
  delayed: boolean;
  dataOnly: true;
  executionEnabled: false;
  contractSymbol: string;
  contractMonth: string;
  rolloverDate: string;
};

export type HistoricalCandleRequest = {
  specification: FuturesContractSpecification;
  startTime: number;
  endTime: number;
  intervalMinutes?: 1 | 5;
};

export type Subscription = { unsubscribe: () => Promise<void> };
export type QuoteHandler = (quote: NormalizedQuote) => void;
export type TradeHandler = (trade: NormalizedTrade) => void;
export type CandleHandler = (candle: NormalizedCandle) => void;

export interface MarketDataProvider {
  readonly kind: MarketDataProviderKind;
  readonly metadata: ProviderMetadata;
  getHistoricalCandles(request: HistoricalCandleRequest): Promise<NormalizedCandle[]>;
  subscribeQuotes(handler: QuoteHandler): Promise<Subscription>;
  subscribeTrades(handler: TradeHandler): Promise<Subscription>;
  subscribeFiveMinuteCandles(handler: CandleHandler): Promise<Subscription>;
  getMarketStatus(at?: number): MarketStatus;
  health(): Promise<ProviderHealth>;
  disconnect(): Promise<void>;
}

function finiteOrNull(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function timestampMillis(value: unknown): number | null {
  const numeric = finiteOrNull(value);
  if (numeric !== null) {
    if (numeric > 100_000_000_000_000) return Math.round(numeric / 1_000_000);
    if (numeric > 100_000_000_000) return Math.round(numeric);
    return Math.round(numeric * 1_000);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  if (record[key] !== undefined) return record[key];
  const header = record.hd;
  return header && typeof header === "object" && !Array.isArray(header)
    ? (header as Record<string, unknown>)[key]
    : undefined;
}

function databentoContractSymbol(specification: FuturesContractSpecification): string {
  const [, month] = specification.contractMonth.split("-").map(Number);
  const monthCodes = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
  return `${specification.rootSymbol}${monthCodes[month - 1]}${specification.contractMonth.slice(-1)}`;
}

function normalizeRecord(
  record: Record<string, unknown>,
  specification: FuturesContractSpecification,
  intervalMinutes: 1 | 5,
  priceScale = 1,
): NormalizedCandle | null {
  const openTime = timestampMillis(recordValue(record, "ts_event") ?? record.timestamp ?? record.openTime ?? record.time);
  if (openTime === null) return null;
  const openValue = finiteOrNull(recordValue(record, "open"));
  const highValue = finiteOrNull(recordValue(record, "high"));
  const lowValue = finiteOrNull(recordValue(record, "low"));
  const closeValue = finiteOrNull(recordValue(record, "close"));
  const open = openValue === null ? null : openValue / priceScale;
  const high = highValue === null ? null : highValue / priceScale;
  const low = lowValue === null ? null : lowValue / priceScale;
  const close = closeValue === null ? null : closeValue / priceScale;
  if (open === null || high === null || low === null || close === null) return null;
  const closeTime = openTime + intervalMinutes * MINUTE;
  const rawContractSymbol = String(recordValue(record, "symbol") ?? record.contractSymbol ?? specification.fullContractSymbol);
  const contractSymbol = rawContractSymbol === databentoContractSymbol(specification)
    ? specification.fullContractSymbol
    : rawContractSymbol;
  const codes: string[] = [];
  if (recordValue(record, "volume") === undefined || recordValue(record, "volume") === null) codes.push("MISSING_VOLUME");
  if (recordValue(record, "bid") === undefined || recordValue(record, "ask") === undefined) codes.push("MISSING_BID_ASK");
  return {
    timestamp: openTime,
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume: finiteOrNull(recordValue(record, "volume")),
    bid: finiteOrNull(recordValue(record, "bid")),
    ask: finiteOrNull(recordValue(record, "ask")),
    bidSize: finiteOrNull(record.bidSize ?? record.bidsize ?? record.bid_size),
    askSize: finiteOrNull(record.askSize ?? record.asksize ?? record.ask_size),
    contractSymbol,
    isComplete: record.isComplete !== false && closeTime <= Date.now(),
    intervalMinutes,
    quality: { valid: true, codes },
  };
}

export function normalizeProviderCandle(
  record: Record<string, unknown>,
  specification: FuturesContractSpecification,
  intervalMinutes: 1 | 5 = 1,
): NormalizedCandle | null {
  return normalizeRecord(record, specification, intervalMinutes);
}

export function aggregateFiveMinuteCandles(
  candles: readonly NormalizedCandle[],
  specification: FuturesContractSpecification,
): NormalizedCandle[] {
  const groups = new Map<number, NormalizedCandle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(candle.openTime / FIVE_MINUTES) * FIVE_MINUTES;
    const group = groups.get(bucket) ?? [];
    group.push(candle);
    groups.set(bucket, group);
  }
  return [...groups.entries()].sort(([first], [second]) => first - second).map(([openTime, group]) => {
    const ordered = [...group].sort((first, second) => first.openTime - second.openTime);
    const codes = new Set(ordered.flatMap((candle) => candle.quality.codes));
    if (ordered.length !== 5 || ordered.some((candle, index) => candle.openTime !== openTime + index * MINUTE)) {
      codes.add("INCOMPLETE_FIVE_MINUTE_BUCKET");
    }
    if (ordered.some((candle) => candle.contractSymbol !== specification.fullContractSymbol)) codes.add("CONTRACT_SYMBOL_MISMATCH");
    const first = ordered[0];
    const last = ordered.at(-1)!;
    return {
      timestamp: openTime,
      openTime,
      closeTime: openTime + FIVE_MINUTES,
      open: first.open,
      high: Math.max(...ordered.map((candle) => candle.high)),
      low: Math.min(...ordered.map((candle) => candle.low)),
      close: last.close,
      volume: ordered.every((candle) => candle.volume !== null)
        ? ordered.reduce((sum, candle) => sum + (candle.volume ?? 0), 0)
        : null,
      bid: [...ordered].reverse().find((candle) => candle.bid !== null)?.bid ?? null,
      ask: [...ordered].reverse().find((candle) => candle.ask !== null)?.ask ?? null,
      bidSize: [...ordered].reverse().find((candle) => candle.bidSize !== null)?.bidSize ?? null,
      askSize: [...ordered].reverse().find((candle) => candle.askSize !== null)?.askSize ?? null,
      contractSymbol: first.contractSymbol,
      isComplete: ordered.length === 5 && ordered.every((candle) => candle.isComplete),
      intervalMinutes: 5,
      quality: { valid: codes.size === 0, codes: [...codes] },
    };
  });
}

export function validateCandleSeries(
  candles: readonly NormalizedCandle[],
  specification: FuturesContractSpecification,
  now = Date.now(),
  staleSeconds = DEFAULT_STALE_SECONDS,
): MarketDataQuality {
  const ordered = [...candles].sort((first, second) => first.openTime - second.openTime);
  const codes = new Set<string>();
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let gapCount = 0;
  let incompleteCandleCount = 0;
  let missingBidAskCount = 0;
  let missingVolumeCount = 0;
  let contractMismatchCount = 0;
  let previous: NormalizedCandle | undefined;
  for (const candle of candles) {
    if (previous && candle.openTime < previous.openTime) outOfOrderCount += 1;
    previous = candle;
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const candle = ordered[index];
    if (index > 0) {
      const delta = candle.openTime - ordered[index - 1].openTime;
      if (delta === 0) duplicateCount += 1;
      else if (delta > candle.intervalMinutes * MINUTE) gapCount += 1;
    }
    if (!candle.isComplete) incompleteCandleCount += 1;
    if (candle.bid === null || candle.ask === null) missingBidAskCount += 1;
    if (candle.volume === null) missingVolumeCount += 1;
    if (candle.contractSymbol !== specification.fullContractSymbol) contractMismatchCount += 1;
    for (const code of candle.quality.codes) codes.add(code);
  }
  if (duplicateCount) codes.add("DUPLICATE_CANDLE");
  if (outOfOrderCount) codes.add("OUT_OF_ORDER_CANDLE");
  if (gapCount) codes.add("CANDLE_GAP");
  if (incompleteCandleCount) codes.add("INCOMPLETE_CANDLE");
  if (contractMismatchCount) codes.add("CONTRACT_SYMBOL_MISMATCH");
  const lastEventAt = ordered.at(-1)?.closeTime ?? null;
  const stale = lastEventAt === null || now - lastEventAt > staleSeconds * 1_000;
  if (stale) codes.add("STALE_DATA");
  return {
    valid: codes.size === 0,
    stale,
    delayed: false,
    completeCandleCount: ordered.filter((candle) => candle.isComplete).length,
    incompleteCandleCount,
    duplicateCount,
    outOfOrderCount,
    gapCount,
    missingBidAskCount,
    missingVolumeCount,
    contractMismatchCount,
    codes: [...codes],
  };
}

function metadata(kind: MarketDataProviderKind, specification: FuturesContractSpecification, delayed: boolean, dataset: string | null): ProviderMetadata {
  return {
    provider: kind,
    displayName: kind === "databento" ? "Databento CME futures" : kind === "csv" ? "CSV replay" : "Deterministic simulator",
    dataset,
    delayed,
    dataOnly: true,
    executionEnabled: false,
    contractSymbol: specification.fullContractSymbol,
    contractMonth: specification.contractMonth,
    rolloverDate: specification.rolloverDate,
  };
}

function unsupportedSubscription(kind: MarketDataProviderKind, stream: string): Promise<Subscription> {
  return Promise.reject(new Error(`${kind} ${stream} subscription is not connected. Historical data remains available without an execution connection.`));
}

function pollingSubscription(run: () => Promise<void>): Promise<Subscription> {
  let running = false;
  const execute = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await run();
    } finally {
      running = false;
    }
  };
  void execute();
  const timer = setInterval(() => void execute(), 5_000);
  return Promise.resolve({
    unsubscribe: async () => {
      clearInterval(timer);
    },
  });
}

function normalizeQuoteRecord(record: Record<string, unknown>, specification: FuturesContractSpecification): NormalizedQuote | null {
  const timestamp = timestampMillis(recordValue(record, "ts_event") ?? record.timestamp);
  if (timestamp === null) return null;
  return {
    timestamp,
    bid: finiteOrNull(record.bid_px ?? record.bid) === null ? null : finiteOrNull(record.bid_px ?? record.bid)! / 1_000_000_000,
    ask: finiteOrNull(record.ask_px ?? record.ask) === null ? null : finiteOrNull(record.ask_px ?? record.ask)! / 1_000_000_000,
    bidSize: finiteOrNull(record.bid_sz ?? record.bidSize),
    askSize: finiteOrNull(record.ask_sz ?? record.askSize),
    contractSymbol: String(recordValue(record, "symbol") ?? specification.fullContractSymbol) === databentoContractSymbol(specification)
      ? specification.fullContractSymbol
      : String(recordValue(record, "symbol") ?? specification.fullContractSymbol),
  };
}

function normalizeTradeRecord(record: Record<string, unknown>, specification: FuturesContractSpecification): NormalizedTrade | null {
  const timestamp = timestampMillis(recordValue(record, "ts_event") ?? record.timestamp);
  if (timestamp === null) return null;
  const action = String(record.side ?? record.action ?? "").toUpperCase();
  return {
    timestamp,
    price: finiteOrNull(record.price ?? record.px) === null ? null : finiteOrNull(record.price ?? record.px)! / 1_000_000_000,
    size: finiteOrNull(record.size ?? record.qty),
    aggressor: action === "B" || action === "BUY" ? "buy" : action === "A" || action === "S" || action === "SELL" ? "sell" : "unknown",
    contractSymbol: String(recordValue(record, "symbol") ?? specification.fullContractSymbol) === databentoContractSymbol(specification)
      ? specification.fullContractSymbol
      : String(recordValue(record, "symbol") ?? specification.fullContractSymbol),
  };
}

class SimulatedMarketDataProvider implements MarketDataProvider {
  readonly kind = "simulated" as const;
  readonly metadata: ProviderMetadata;
  constructor(private readonly specification: FuturesContractSpecification, private readonly calendar: FuturesSessionCalendar) {
    this.metadata = metadata(this.kind, specification, false, "deterministic");
  }
  async getHistoricalCandles(request: HistoricalCandleRequest): Promise<NormalizedCandle[]> {
    const source = generateSimulatedFuturesFeed(this.specification, {
      calendar: this.calendar,
      startDate: tradingDateForTimestamp(request.endTime, this.calendar),
      days: 3,
      includePremarket: true,
    });
    return source
      .filter((candle) => candle.openTime >= request.startTime && candle.closeTime <= request.endTime)
      .map((candle) => normalizeRecord(candle as unknown as Record<string, unknown>, this.specification, 5))
      .filter((candle): candle is NormalizedCandle => candle !== null);
  }
  subscribeQuotes(): Promise<Subscription> { return unsupportedSubscription(this.kind, "quote"); }
  subscribeTrades(): Promise<Subscription> { return unsupportedSubscription(this.kind, "trade"); }
  subscribeFiveMinuteCandles(): Promise<Subscription> { return unsupportedSubscription(this.kind, "candle"); }
  getMarketStatus(at = Date.now()): MarketStatus {
    const session = classifyFuturesSession(at, this.calendar);
    return session === "premarket" ? "premarket" : session === "regular" ? "open" : "closed";
  }
  async health(): Promise<ProviderHealth> {
    return { provider: this.kind, state: "simulated", connected: true, authenticated: true, delayed: false, lastEventAt: null, checkedAt: Date.now(), message: "Deterministic data source is available.", quality: null };
  }
  async disconnect(): Promise<void> {}
}

export function parseCsvCandles(
  csv: string,
  specification: FuturesContractSpecification,
  intervalMinutes: 1 | 5 = 5,
): NormalizedCandle[] {
  const rows = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!rows.length) return [];
  const headers = rows[0].split(",").map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((line) => {
    const values = line.split(",");
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim()]));
    return normalizeRecord(record, specification, intervalMinutes);
  }).filter((candle): candle is NormalizedCandle => candle !== null);
}

class CsvReplayMarketDataProvider implements MarketDataProvider {
  readonly kind = "csv" as const;
  readonly metadata: ProviderMetadata;
  constructor(private readonly specification: FuturesContractSpecification) {
    this.metadata = metadata(this.kind, specification, false, "csv");
  }
  async getHistoricalCandles(request: HistoricalCandleRequest): Promise<NormalizedCandle[]> {
    const path = process.env["LEVELSTORY_CSV_REPLAY_PATH"];
    if (!path) throw new Error("CSV replay is not configured. Set LEVELSTORY_CSV_REPLAY_PATH on the server.");
    const contents = await readFile(path, "utf8");
    const candles = parseCsvCandles(contents, this.specification, request.intervalMinutes ?? 5);
    return candles.filter((candle) => candle.openTime >= request.startTime && candle.closeTime <= request.endTime);
  }
  subscribeQuotes(): Promise<Subscription> { return unsupportedSubscription(this.kind, "quote"); }
  subscribeTrades(): Promise<Subscription> { return unsupportedSubscription(this.kind, "trade"); }
  subscribeFiveMinuteCandles(): Promise<Subscription> { return unsupportedSubscription(this.kind, "candle"); }
  getMarketStatus(): MarketStatus { return "closed"; }
  async health(): Promise<ProviderHealth> {
    const configured = Boolean(process.env["LEVELSTORY_CSV_REPLAY_PATH"]);
    return { provider: this.kind, state: configured ? "csv_replay" : "disconnected", connected: configured, authenticated: true, delayed: false, lastEventAt: null, checkedAt: Date.now(), message: configured ? "CSV replay source is configured." : "CSV replay path is not configured.", quality: null };
  }
  async disconnect(): Promise<void> {}
}

class DatabentoMarketDataProvider implements MarketDataProvider {
  readonly kind = "databento" as const;
  readonly metadata: ProviderMetadata;
  private lastEventAt: number | null = null;
  private lastQuality: MarketDataQuality | null = null;
  private connected = false;
  private lastRawRecordCount = 0;
  private lastNormalizableRecordCount = 0;
  private lastNormalizedRecordCount = 0;
  private lastRecordKeySummary = "";
  constructor(private readonly specification: FuturesContractSpecification, private readonly calendar: FuturesSessionCalendar) {
    this.metadata = metadata(this.kind, specification, true, DEFAULT_DATASET);
  }
  private async request(body: URLSearchParams): Promise<string> {
    const key = process.env["DATABENTO_API_KEY"];
    if (!key) throw new Error("DATABENTO_API_KEY is not configured.");
    const response = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
      throw new Error(`Databento historical request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.`);
    }
    this.connected = true;
    return response.text();
  }
  private async requestRecords(schema: string, startTime: number, endTime: number, trackDiagnostics = true): Promise<Record<string, unknown>[]> {
    const text = await this.request(new URLSearchParams({
      dataset: DEFAULT_DATASET,
      schema,
      symbols: `${this.specification.rootSymbol}.FUT`,
      stype_in: "parent",
      start: new Date(startTime).toISOString(),
      end: new Date(endTime).toISOString(),
      encoding: "json",
      compression: "none",
    }));
    const records: Record<string, unknown>[] = [];
    const lines = text.trim().startsWith("[")
      ? [text.trim()]
      : text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | Record<string, unknown>[];
        if (Array.isArray(parsed)) records.push(...parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"));
        else if (parsed && typeof parsed === "object") records.push(parsed);
      } catch {
        // JSONL header and non-record lines are intentionally ignored.
      }
    }
    if (trackDiagnostics) {
      this.lastRawRecordCount = records.length;
      this.lastRecordKeySummary = Object.keys(records[0] ?? {}).slice(0, 12).join(",");
    }
    return records;
  }
  async getHistoricalCandles(request: HistoricalCandleRequest): Promise<NormalizedCandle[]> {
    this.lastNormalizableRecordCount = 0;
    this.lastNormalizedRecordCount = 0;
    const delayedEndTime = Math.min(request.endTime, Date.now() - 8 * 60 * MINUTE);
    if (delayedEndTime <= request.startTime) return [];
    const rawRecords = await this.requestRecords("ohlcv-1m", request.startTime, delayedEndTime);
    const quoteRecords = request.intervalMinutes === 5
      ? await this.requestRecords("bbo-1s", request.startTime, delayedEndTime, false).catch(() => [])
      : [];
    const quotes = quoteRecords
      .map((record) => normalizeQuoteRecord(record, this.specification))
      .filter((quote): quote is NormalizedQuote => quote !== null && quote.contractSymbol === this.specification.fullContractSymbol)
      .sort((first, second) => first.timestamp - second.timestamp);
    const records: NormalizedCandle[] = [];
    for (const parsed of rawRecords) {
      const candle = normalizeRecord(parsed, this.specification, 1, 1_000_000_000);
      if (candle) {
        this.lastNormalizableRecordCount += 1;
        if (candle.contractSymbol === this.specification.fullContractSymbol) {
          const quote = quotes.filter((item) => item.timestamp >= candle.openTime && item.timestamp <= candle.closeTime).at(-1);
          if (quote) {
            records.push({
              ...candle,
              bid: quote.bid,
              ask: quote.ask,
              bidSize: quote.bidSize,
              askSize: quote.askSize,
              quality: { valid: candle.quality.codes.filter((code) => code !== "MISSING_BID_ASK").length === 0, codes: candle.quality.codes.filter((code) => code !== "MISSING_BID_ASK") },
            });
          } else {
            records.push(candle);
          }
        }
      }
    }
    this.lastNormalizedRecordCount = records.length;
    const result = request.intervalMinutes === 5 ? aggregateFiveMinuteCandles(records, this.specification) : records;
    this.lastEventAt = result.at(-1)?.closeTime ?? null;
    this.lastQuality = validateCandleSeries(result, this.specification);
    return result;
  }
  subscribeQuotes(handler: QuoteHandler): Promise<Subscription> {
    return pollingSubscription(async () => {
      const now = Date.now();
      for (const record of await this.requestRecords("bbo-1s", now - 5_000, now)) {
        const quote = normalizeQuoteRecord(record, this.specification);
        if (quote) {
          this.lastEventAt = quote.timestamp;
          handler(quote);
        }
      }
    });
  }
  subscribeTrades(handler: TradeHandler): Promise<Subscription> {
    return pollingSubscription(async () => {
      const now = Date.now();
      for (const record of await this.requestRecords("trades", now - 5_000, now)) {
        const trade = normalizeTradeRecord(record, this.specification);
        if (trade) {
          this.lastEventAt = trade.timestamp;
          handler(trade);
        }
      }
    });
  }
  subscribeFiveMinuteCandles(handler: CandleHandler): Promise<Subscription> {
    return pollingSubscription(async () => {
      const now = Date.now();
      const candles = await this.getHistoricalCandles({
        specification: this.specification,
        startTime: now - 10 * MINUTE,
        endTime: now,
        intervalMinutes: 5,
      });
      const latest = candles.at(-1);
      if (latest) handler(latest);
    });
  }
  getMarketStatus(at = Date.now()): MarketStatus {
    const session = classifyFuturesSession(at, this.calendar);
    return session === "premarket" ? "premarket" : session === "regular" ? "open" : "closed";
  }
  async health(): Promise<ProviderHealth> {
    const keyConfigured = Boolean(process.env["DATABENTO_API_KEY"]);
    return {
      provider: this.kind,
      state: !keyConfigured ? "disconnected" : this.connected ? "delayed_shadow" : "disconnected",
      connected: this.connected,
      authenticated: keyConfigured,
      delayed: true,
      lastEventAt: this.lastEventAt,
      checkedAt: Date.now(),
      message: keyConfigured ? this.connected ? `Databento historical data is reachable; parsed ${this.lastRawRecordCount} records (${this.lastRecordKeySummary || "no fields"}), recognized ${this.lastNormalizableRecordCount} OHLCV records, and selected ${this.lastNormalizedRecordCount} contract bars. No execution connection exists.` : "Databento key is configured; run a historical request to establish connectivity." : "DATABENTO_API_KEY is not configured.",
      quality: this.lastQuality,
    };
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.lastEventAt = null;
  }
}

export function selectFrontMonthContract(
  specification: FuturesContractSpecification,
  tradingDate: string,
): FuturesContractSpecification {
  if (tradingDate < specification.rolloverDate) return { ...specification, regularSessionHours: { ...specification.regularSessionHours } };
  const [year, month] = specification.contractMonth.split("-").map(Number);
  const nextMonth = month + 3 > 12 ? month - 9 : month + 3;
  const nextYear = month + 3 > 12 ? year + 1 : year;
  const monthCodes = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
  const contractMonth = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
  return {
    ...specification,
    contractMonth,
    fullContractSymbol: `${specification.rootSymbol}${monthCodes[nextMonth - 1]}${String(nextYear).slice(-2)}`,
    rolloverDate: `${nextYear}-${String(nextMonth).padStart(2, "0")}-10`,
    regularSessionHours: { ...specification.regularSessionHours },
    verificationNote: `${specification.verificationNote} Front-month selection advanced after the configured rollover date.`,
  };
}

export function createMarketDataProvider(
  kind: MarketDataProviderKind,
  specification: FuturesContractSpecification,
): MarketDataProvider {
  const calendar = sessionCalendarForContract(specification);
  if (kind === "databento") return new DatabentoMarketDataProvider(specification, calendar);
  if (kind === "csv") return new CsvReplayMarketDataProvider(specification);
  return new SimulatedMarketDataProvider(specification, calendar);
}

export function providerKindFromEnvironment(): MarketDataProviderKind {
  const value = process.env["LEVELSTORY_DATA_PROVIDER"]?.trim().toLowerCase();
  return value === "databento" || value === "csv" ? value : "simulated";
}

export function providerRequestWindow(
  tradingDate: string,
  calendar: FuturesSessionCalendar,
  lookbackTradingDays = 3,
): { startTime: number; endTime: number } {
  let startDate = tradingDate;
  for (let index = 1; index < lookbackTradingDays; index += 1) startDate = previousTradingDate(startDate, calendar);
  const startTime = new Date(`${startDate}T00:00:00Z`).getTime();
  const endTime = new Date(`${tradingDate}T23:59:59.999Z`).getTime();
  return { startTime, endTime };
}

export function normalizedToSimulatedCandle(candle: NormalizedCandle): SimulatedFuturesCandle | null {
  if (candle.volume === null || candle.bid === null || candle.ask === null || candle.bidSize === null || candle.askSize === null) return null;
  return {
    timestamp: candle.timestamp,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    bid: candle.bid,
    ask: candle.ask,
    bidSize: candle.bidSize,
    askSize: candle.askSize,
    contractSymbol: candle.contractSymbol,
    isComplete: candle.isComplete,
  };
}