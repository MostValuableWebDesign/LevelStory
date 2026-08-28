import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
  classifyFuturesSession,
  isTradingDate,
  newYorkTimeToUtc,
  sessionCalendarForContract,
  sessionWindow,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "./session-calendar.js";
import type { FuturesContractSpecification } from "./contracts.js";
import type { NormalizedCandle } from "./market-data-provider.js";
import type { CausalReplayDataset } from "../phase9.js";
import type { SimulatedFuturesCandle } from "./simulated-feed.js";

const MINUTE = 60_000;
const REQUIRED_HEADERS = ["ts_event", "open", "high", "low", "close", "volume", "symbol"] as const;
const DEFAULT_FILENAME_PREFIX = "glbx-mdp3-";
const MAX_REPORTED_ERRORS = 25;

export type HistoricalAggregation = {
  intervalMinutes: 1 | 5 | 15 | 60;
  candles: NormalizedCandle[];
};

export type HistoricalCsvImportSummary = {
  source: "historical_databento";
  filename: string;
  detectedSymbol: string | null;
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  duplicateRowsRemoved: number;
  missingMinuteGaps: number;
  missingGapSegments: number;
  unexpectedOpenSessionMissingMinutes: number;
  unexpectedOvernightMissingMinutes: number;
  unexpectedRegularSessionMissingMinutes: number;
  regularSessionGapSegments: number;
  overnightGapSegments: number;
  regularSessionMissingMinutes: number;
  expectedClosedMarketMinutes: number;
  lowLiquidityInactiveMinutes: number;
  regularSessionCandleCount: number;
  overnightCandleCount: number;
  availableTradingDates: string[];
  rejectionReasons: Record<string, number>;
  errors: Array<{ row: number; reason: string }>;
  aggregationCounts: {
    oneMinute: number;
    fiveMinute: number;
    fifteenMinute: number;
    oneHour: number;
  };
};

export type HistoricalCsvImport = {
  summary: HistoricalCsvImportSummary;
  oneMinute: NormalizedCandle[];
  fiveMinute: NormalizedCandle[];
  fifteenMinute: NormalizedCandle[];
  oneHour: NormalizedCandle[];
  specification: FuturesContractSpecification;
  calendar: FuturesSessionCalendar;
};

type ParsedRow = {
  timestamp: number;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function reasonFor(summary: HistoricalCsvImportSummary, row: number, reason: string): void {
  summary.rejectedRows += 1;
  summary.rejectionReasons[reason] = (summary.rejectionReasons[reason] ?? 0) + 1;
  if (summary.errors.length < MAX_REPORTED_ERRORS) summary.errors.push({ row, reason });
}

function parseCsvLine(line: string): string[] | null {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) return null;
  values.push(value.trim());
  return values;
}

function validIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function requiredNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function outrightMesSymbol(value: string): boolean {
  return /^MES[A-Z]\d{1,2}$/.test(value);
}

function aggregate(
  candles: readonly NormalizedCandle[],
  intervalMinutes: 5 | 15 | 60,
  specification: FuturesContractSpecification,
): NormalizedCandle[] {
  const interval = intervalMinutes * MINUTE;
  const groups = new Map<number, NormalizedCandle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(candle.openTime / interval) * interval;
    const group = groups.get(bucket) ?? [];
    group.push(candle);
    groups.set(bucket, group);
  }
  return [...groups.entries()].sort(([first], [second]) => first - second).map(([openTime, group]) => {
    const ordered = [...group].sort((first, second) => first.openTime - second.openTime);
    const first = ordered[0];
    const last = ordered.at(-1)!;
    const complete = ordered.length === intervalMinutes
      && ordered.every((candle, index) => candle.openTime === openTime + index * MINUTE);
    const qualityCodes = new Set(ordered.flatMap((candle) => candle.quality.codes));
    if (!complete) qualityCodes.add("INCOMPLETE_AGGREGATED_BUCKET");
    return {
      timestamp: openTime,
      openTime,
      closeTime: openTime + interval,
      open: first.open,
      high: Math.max(...ordered.map((candle) => candle.high)),
      low: Math.min(...ordered.map((candle) => candle.low)),
      close: last.close,
      volume: ordered.reduce((sum, candle) => sum + (candle.volume ?? 0), 0),
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      contractSymbol: first.contractSymbol || specification.fullContractSymbol,
      isComplete: complete && ordered.every((candle) => candle.isComplete),
      intervalMinutes,
      quality: { valid: complete && ordered.every((candle) => candle.quality.valid), codes: [...qualityCodes] },
    };
  });
}

function countMissingMinutes(
  candles: readonly NormalizedCandle[],
  calendar: FuturesSessionCalendar,
): { missingMinutes: number; segments: number } {
  let missingMinutes = 0;
  let segments = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    const previousDate = tradingDateForTimestamp(previous.openTime, calendar);
    const currentDate = tradingDateForTimestamp(current.openTime, calendar);
    if (previousDate !== currentDate) continue;
    const difference = current.openTime - previous.openTime;
    const missing = Math.max(0, Math.round(difference / MINUTE) - 1);
    if (missing > 0) {
      missingMinutes += missing;
      segments += 1;
    }
  }
  return { missingMinutes, segments };
}

function overlapMinutes(start: number, end: number, window: { openTime: number; closeTime: number } | null): number {
  if (!window) return 0;
  return Math.max(0, Math.round((Math.min(end, window.closeTime) - Math.max(start, window.openTime)) / MINUTE));
}

function countSessionAwareGaps(
  candles: readonly NormalizedCandle[],
  calendar: FuturesSessionCalendar,
): {
  unexpectedOpenSessionMissingMinutes: number;
  unexpectedOvernightMissingMinutes: number;
  unexpectedRegularSessionMissingMinutes: number;
  regularSessionGapSegments: number;
  overnightGapSegments: number;
  regularSessionMissingMinutes: number;
  expectedClosedMarketMinutes: number;
  lowLiquidityInactiveMinutes: number;
} {
  let unexpectedOpenSessionMissingMinutes = 0;
  let unexpectedOvernightMissingMinutes = 0;
  let unexpectedRegularSessionMissingMinutes = 0;
  let regularSessionGapSegments = 0;
  let overnightGapSegments = 0;
  let regularSessionMissingMinutes = 0;
  let expectedClosedMarketMinutes = 0;
  let lowLiquidityInactiveMinutes = 0;
  for (const candle of candles) {
    if (candle.volume === 0) lowLiquidityInactiveMinutes += 1;
  }
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    const previousDate = tradingDateForTimestamp(previous.openTime, calendar);
    const currentDate = tradingDateForTimestamp(current.openTime, calendar);
    if (previousDate !== currentDate) continue;
    const gapStart = previous.openTime + MINUTE;
    const gapEnd = current.openTime;
    const missing = Math.max(0, Math.round((gapEnd - gapStart) / MINUTE));
    if (!missing) continue;
    const regular = sessionWindow(previousDate, "regular", calendar);
    const premarket = sessionWindow(previousDate, "premarket", calendar);
    const regularMinutes = overlapMinutes(gapStart, gapEnd, regular);
    const premarketMinutes = overlapMinutes(gapStart, gapEnd, premarket);
    const openMinutes = regularMinutes + premarketMinutes;
    regularSessionMissingMinutes += regularMinutes;
    if (regularMinutes > 0) regularSessionGapSegments += 1;
    unexpectedOpenSessionMissingMinutes += openMinutes;

    // Overnight data is optional. Only count an overnight gap when both
    // endpoints are inside the same expected overnight window; this prevents
    // the CME maintenance break and the closed 16:00–18:00 period from being
    // reported as missing market data.
    const overnightStart = newYorkTimeToUtc(previousDate, "18:00");
    const nextDate = new Date(newYorkTimeToUtc(previousDate, "18:00") + 86_400_000)
      .toISOString().slice(0, 10);
    const overnightEnd = newYorkTimeToUtc(nextDate, "04:00");
    if (previous.openTime >= overnightStart && current.openTime <= overnightEnd) {
      unexpectedOvernightMissingMinutes += missing;
      overnightGapSegments += 1;
    }
    expectedClosedMarketMinutes += Math.max(
      0,
      missing - openMinutes - (previous.openTime >= overnightStart && current.openTime <= overnightEnd ? missing : 0),
    );
  }
  return {
    unexpectedOpenSessionMissingMinutes,
    unexpectedOvernightMissingMinutes,
    unexpectedRegularSessionMissingMinutes: regularSessionMissingMinutes,
    regularSessionGapSegments,
    overnightGapSegments,
    regularSessionMissingMinutes,
    expectedClosedMarketMinutes,
    lowLiquidityInactiveMinutes,
  };
}

function toReplayCandle(candle: NormalizedCandle): SimulatedFuturesCandle {
  // The strategy consumes a quote-shaped candle for descriptive calculations.
  // runCausalBacktest checks quotesAvailable before any fill is simulated, so
  // these analysis-only values can never become an execution quote.
  return {
    timestamp: candle.timestamp,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? 0,
    bid: candle.bid ?? candle.close,
    ask: candle.ask ?? candle.close,
    bidSize: candle.bidSize ?? 0,
    askSize: candle.askSize ?? 0,
    contractSymbol: candle.contractSymbol,
    isComplete: candle.isComplete,
  };
}

export function historicalImportToReplayDataset(
  imported: HistoricalCsvImport,
  startDate: string,
  endDate: string,
  inSampleDays: number,
  outOfSampleDays: number,
): CausalReplayDataset {
  const requestedDates = imported.summary.availableTradingDates.filter((date) => date >= startDate && date <= endDate);
  const requiredDates = inSampleDays + outOfSampleDays;
  if (requestedDates.length < requiredDates) {
    throw new Error(`Historical range contains ${requestedDates.length} trading dates; ${requiredDates} are required.`);
  }
  // Use the latest exact N+M available dates ending on or before endDate.
  // Earlier available dates remain explicitly excluded rather than silently
  // becoming part of the replay.
  const availableDates = requestedDates.slice(-requiredDates);
  const selectedDates = new Set(availableDates);
  const fiveMinute = imported.fiveMinute.filter((candle) => selectedDates.has(tradingDateForTimestamp(candle.openTime, imported.calendar)));
  const oneMinute = imported.oneMinute.filter((candle) => selectedDates.has(tradingDateForTimestamp(candle.openTime, imported.calendar)));
  const selectedGapReport = countSessionAwareGaps(oneMinute, imported.calendar);
  const adjacentGaps = countMissingMinutes(oneMinute, imported.calendar);
  return {
    candles: fiveMinute.map(toReplayCandle),
    oneMinute: oneMinute.map((candle) => ({
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      source: "one-minute" as const,
      sequenceKnown: false,
    })),
    contractSymbol: imported.summary.detectedSymbol ?? imported.specification.fullContractSymbol,
    contractMonth: imported.specification.contractMonth,
    inSampleDates: availableDates.slice(0, inSampleDays),
    outOfSampleDates: availableDates.slice(-outOfSampleDays),
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    selectedDates: availableDates,
    excludedDates: requestedDates.filter((date) => !selectedDates.has(date)),
    source: "historical_databento",
    quotesAvailable: false,
    gapReport: {
      missingMinuteGaps: adjacentGaps.missingMinutes,
      missingGapSegments: adjacentGaps.segments,
      unexpectedOpenSessionMissingMinutes: selectedGapReport.unexpectedOpenSessionMissingMinutes,
      unexpectedOvernightMissingMinutes: selectedGapReport.unexpectedOvernightMissingMinutes,
      unexpectedRegularSessionMissingMinutes: selectedGapReport.unexpectedRegularSessionMissingMinutes,
      regularSessionGapSegments: selectedGapReport.regularSessionGapSegments,
      overnightGapSegments: selectedGapReport.overnightGapSegments,
      regularSessionMissingMinutes: selectedGapReport.regularSessionMissingMinutes,
      expectedClosedMarketMinutes: selectedGapReport.expectedClosedMarketMinutes,
      lowLiquidityInactiveMinutes: selectedGapReport.lowLiquidityInactiveMinutes,
    },
  };
}

export function publicHistoricalImportSummary(imported: HistoricalCsvImport): HistoricalCsvImportSummary {
  return imported.summary;
}

async function resolveImportPath(): Promise<string> {
  const configured = process.env["LEVELSTORY_HISTORICAL_CSV_PATH"] ?? process.env["LEVELSTORY_CSV_REPLAY_PATH"];
  if (configured) return configured;
  const assetDirectories = [
    join(process.cwd(), "attached_assets"),
    join(process.cwd(), "..", "attached_assets"),
    join(process.cwd(), "..", "..", "attached_assets"),
  ];
  for (const assetsDirectory of assetDirectories) {
    try {
      const files = await readdir(assetsDirectory);
      const match = files
        .filter((file) => file.endsWith(".csv") && file.startsWith(DEFAULT_FILENAME_PREFIX) && file.includes("MESU6"))
        .sort()[0];
      if (match) return join(assetsDirectory, match);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("No uploaded MESU6 Databento CSV was found in attached_assets.");
}

export async function importHistoricalCsv(
  filePath: string,
  specification: FuturesContractSpecification,
): Promise<HistoricalCsvImport> {
  const calendar = sessionCalendarForContract(specification);
  const summary: HistoricalCsvImportSummary = {
    source: "historical_databento",
    filename: basename(filePath),
    detectedSymbol: null,
    earliestTimestamp: null,
    latestTimestamp: null,
    totalRows: 0,
    validRows: 0,
    rejectedRows: 0,
    duplicateRowsRemoved: 0,
    missingMinuteGaps: 0,
    missingGapSegments: 0,
    unexpectedOpenSessionMissingMinutes: 0,
    unexpectedOvernightMissingMinutes: 0,
    unexpectedRegularSessionMissingMinutes: 0,
    regularSessionGapSegments: 0,
    overnightGapSegments: 0,
    regularSessionMissingMinutes: 0,
    expectedClosedMarketMinutes: 0,
    lowLiquidityInactiveMinutes: 0,
    regularSessionCandleCount: 0,
    overnightCandleCount: 0,
    availableTradingDates: [],
    rejectionReasons: {},
    errors: [],
    aggregationCounts: { oneMinute: 0, fiveMinute: 0, fifteenMinute: 0, oneHour: 0 },
  };
  const candles: NormalizedCandle[] = [];
  const tradingDates = new Set<string>();
  let headers: string[] | null = null;
  let previousTimestamp: number | null = null;

  const input = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const rawLine of input) {
    const line = String(rawLine).trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    if (!headers) {
      if (!values) throw new Error("CSV header contains an unterminated quoted field.");
      headers = values.map((header) => header.toLowerCase());
      const missing = REQUIRED_HEADERS.filter((header) => !headers!.includes(header));
      if (missing.length) throw new Error(`CSV is missing required Databento columns: ${missing.join(", ")}.`);
      continue;
    }
    summary.totalRows += 1;
    const row = summary.totalRows + 1;
    if (!values || values.length !== headers.length) {
      reasonFor(summary, row, "MALFORMED_ROW");
      continue;
    }
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const timestampValue = record["ts_event"] || record["timestamp"] || record["event_time"] || "";
    const symbol = record["symbol"]?.trim() ?? "";
    if (!validIsoTimestamp(timestampValue)) {
      reasonFor(summary, row, "INVALID_ISO_TIMESTAMP");
      continue;
    }
    if (symbol.includes("-")) {
      reasonFor(summary, row, "CALENDAR_SPREAD_REJECTED");
      continue;
    }
    if (!outrightMesSymbol(symbol)) {
      reasonFor(summary, row, "NON_MES_OUTRIGHT_SYMBOL");
      continue;
    }
    if (summary.detectedSymbol === null) summary.detectedSymbol = symbol;
    if (symbol !== summary.detectedSymbol) {
      reasonFor(summary, row, "MULTIPLE_OUTRIGHT_SYMBOLS");
      continue;
    }
    const numericValues = ["open", "high", "low", "close", "volume"].map((key) => requiredNumber(record[key] ?? ""));
    if (numericValues.some((value) => value === null)) {
      reasonFor(summary, row, "NON_NUMERIC_OHLCV");
      continue;
    }
    const [open, high, low, close, volume] = numericValues as number[];
    if (high < open || high < close || high < low || low > open || low > close || low > high) {
      reasonFor(summary, row, "INVALID_OHLC_RELATIONSHIP");
      continue;
    }
    if (volume < 0) {
      reasonFor(summary, row, "NEGATIVE_VOLUME");
      continue;
    }
    const timestamp = Date.parse(timestampValue);
    if (previousTimestamp !== null && timestamp < previousTimestamp) {
      reasonFor(summary, row, "OUT_OF_ORDER_TIMESTAMP");
      continue;
    }
    if (previousTimestamp !== null && timestamp === previousTimestamp) {
      summary.duplicateRowsRemoved += 1;
      continue;
    }
    previousTimestamp = timestamp;
    const candle: NormalizedCandle = {
      timestamp,
      openTime: timestamp,
      closeTime: timestamp + MINUTE,
      open,
      high,
      low,
      close,
      volume,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      contractSymbol: symbol,
      isComplete: true,
      intervalMinutes: 1,
      quality: { valid: true, codes: ["MISSING_BID_ASK"] },
    };
    candles.push(candle);
    summary.validRows += 1;
    summary.earliestTimestamp ??= new Date(timestamp).toISOString();
    summary.latestTimestamp = new Date(timestamp).toISOString();
    const date = tradingDateForTimestamp(timestamp, calendar);
    if (isTradingDate(date, calendar)) tradingDates.add(date);
    if (classifyFuturesSession(timestamp, calendar) === "regular") summary.regularSessionCandleCount += 1;
    else summary.overnightCandleCount += 1;
  }
  if (!headers) throw new Error("CSV file is empty.");
  const gaps = countMissingMinutes(candles, calendar);
  summary.missingMinuteGaps = gaps.missingMinutes;
  summary.missingGapSegments = gaps.segments;
  Object.assign(summary, countSessionAwareGaps(candles, calendar));
  summary.availableTradingDates = [...tradingDates].sort();
  const fiveMinute = aggregate(candles, 5, specification);
  const fifteenMinute = aggregate(candles, 15, specification);
  const oneHour = aggregate(candles, 60, specification);
  summary.aggregationCounts = {
    oneMinute: candles.length,
    fiveMinute: fiveMinute.length,
    fifteenMinute: fifteenMinute.length,
    oneHour: oneHour.length,
  };
  return { summary, oneMinute: candles, fiveMinute, fifteenMinute, oneHour, specification, calendar };
}

let cachedImport: { path: string; modifiedAt: number; value: HistoricalCsvImport } | null = null;
let importPromise: Promise<HistoricalCsvImport> | null = null;

export async function getHistoricalCsvImport(
  specification: FuturesContractSpecification,
): Promise<HistoricalCsvImport> {
  const filePath = await resolveImportPath();
  const modifiedAt = (await stat(filePath)).mtimeMs;
  if (cachedImport?.path === filePath && cachedImport.modifiedAt === modifiedAt) return cachedImport.value;
  if (!importPromise) {
    importPromise = importHistoricalCsv(filePath, specification)
      .then((value) => {
        cachedImport = { path: filePath, modifiedAt, value };
        return value;
      })
      .finally(() => {
        importPromise = null;
      });
  }
  return importPromise;
}