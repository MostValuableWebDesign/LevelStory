import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
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
import { boundedCsvPath } from "../security.js";

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
  unexpectedMissingMinutes: number;
  unexpectedOpenSessionMissingMinutes: number;
  unexpectedOvernightMissingMinutes: number;
  unexpectedRegularSessionMissingMinutes: number;
  regularSessionGapSegments: number;
  overnightGapSegments: number;
  regularSessionMissingMinutes: number;
  expectedClosedMarketMinutes: number;
  expectedClosedMinutes: number;
  weekendHolidayClosedMinutes: number;
  earlyCloseMinutes: number;
  inactiveContractMinutes: number;
  lowLiquidityInactiveMinutes: number;
  coverageScope: "full_file";
  inactiveContractThresholdPercent: number;
  inactiveContractDays: number;
  missingRegularSessionDates: string[];
  missingOvernightSessionDates: string[];
  completeRegularSessionDates: string[];
  maintenanceGapMinutes: number;
  weekendHolidayGapMinutes: number;
  earlyCloseDates: string[];
  overnightCoverageObserved: boolean;
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
  contentFingerprint: string;
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

function overlapMinutes(start: number, end: number, window: { openTime: number; closeTime: number } | null): number {
  if (!window) return 0;
  return Math.max(0, Math.round((Math.min(end, window.closeTime) - Math.max(start, window.openTime)) / MINUTE));
}

function previousCalendarDate(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function overnightOwnerDate(timestamp: number, calendar: FuturesSessionCalendar): string | null {
  const date = tradingDateForTimestamp(timestamp, calendar);
  const candidates = [date, new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)];
  for (const candidate of candidates) {
    if (!isTradingDate(candidate, calendar)) continue;
    const previousDate = previousCalendarDate(candidate);
    const window = {
      openTime: newYorkTimeToUtc(previousDate, "18:00"),
      closeTime: newYorkTimeToUtc(candidate, "04:00"),
    };
    if (timestamp >= window.openTime && timestamp < window.closeTime) return candidate;
  }
  return null;
}

export function countSessionAwareGaps(
  candles: readonly NormalizedCandle[],
  calendar: FuturesSessionCalendar,
): {
  missingMinuteGaps: number;
  missingGapSegments: number;
  unexpectedOpenSessionMissingMinutes: number;
  unexpectedOvernightMissingMinutes: number;
  unexpectedRegularSessionMissingMinutes: number;
  unexpectedMissingMinutes: number;
  regularSessionGapSegments: number;
  overnightGapSegments: number;
  regularSessionMissingMinutes: number;
  expectedClosedMarketMinutes: number;
  expectedClosedMinutes: number;
  weekendHolidayClosedMinutes: number;
  earlyCloseMinutes: number;
  inactiveContractMinutes: number;
  lowLiquidityInactiveMinutes: number;
  coverageScope: "full_file" | "selected_dates";
  inactiveContractThresholdPercent: number;
  inactiveContractDays: number;
  missingRegularSessionDates: string[];
  missingOvernightSessionDates: string[];
  completeRegularSessionDates: string[];
  maintenanceGapMinutes: number;
  weekendHolidayGapMinutes: number;
  earlyCloseDates: string[];
  overnightCoverageObserved: boolean;
} {
  let unexpectedOpenSessionMissingMinutes = 0;
  let missingMinuteGaps = 0;
  let missingGapSegments = 0;
  let unexpectedOvernightMissingMinutes = 0;
  let unexpectedRegularSessionMissingMinutes = 0;
  let unexpectedMissingMinutes = 0;
  let regularSessionGapSegments = 0;
  let overnightGapSegments = 0;
  let regularSessionMissingMinutes = 0;
  let expectedClosedMarketMinutes = 0;
  let expectedClosedMinutes = 0;
  let weekendHolidayClosedMinutes = 0;
  let earlyCloseMinutes = 0;
  let inactiveContractMinutes = 0;
  let lowLiquidityInactiveMinutes = 0;
  let maintenanceGapMinutes = 0;
  let weekendHolidayGapMinutes = 0;
  const regularCounts = new Map<string, number>();
  const overnightCounts = new Map<string, number>();
  const tradingDates = new Set<string>();
  const earlyCloseDates = new Set<string>();
  for (const candle of candles) {
    const date = tradingDateForTimestamp(candle.openTime, calendar);
    if (isTradingDate(date, calendar)) tradingDates.add(date);
    const regular = sessionWindow(date, "regular", calendar);
    if (regular && candle.openTime >= regular.openTime && candle.openTime < regular.closeTime) {
      regularCounts.set(date, (regularCounts.get(date) ?? 0) + 1);
      if (regular.earlyClose) earlyCloseDates.add(date);
    }
    const overnightDate = overnightOwnerDate(candle.openTime, calendar);
    if (overnightDate) {
      overnightCounts.set(overnightDate, (overnightCounts.get(overnightDate) ?? 0) + 1);
    }
  }
  const overnightCoverageObserved = overnightCounts.size > 0;
  const sortedDates = [...tradingDates].sort();
  if (sortedDates.length > 0) {
    const firstDate = sortedDates[0];
    const lastDate = sortedDates.at(-1)!;
    for (
      let cursor = Date.parse(`${firstDate}T12:00:00Z`);
      cursor <= Date.parse(`${lastDate}T12:00:00Z`);
      cursor += 86_400_000
    ) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      if (isTradingDate(date, calendar)) tradingDates.add(date);
    }
  }
  const allTradingDates = [...tradingDates].sort();
  const inactiveContractThresholdPercent = Number(process.env.LEVELSTORY_INACTIVE_RTH_THRESHOLD_PERCENT ?? 50);
  const missingRegularSessionDates: string[] = [];
  const missingOvernightSessionDates: string[] = [];
  const completeRegularSessionDates: string[] = [];
  for (const date of allTradingDates) {
    const regular = sessionWindow(date, "regular", calendar);
    const expectedRegularMinutes = regular ? Math.round((regular.closeTime - regular.openTime) / MINUTE) : 0;
    const regularCount = regularCounts.get(date) ?? 0;
    if (regularCount === 0 || regularCount < expectedRegularMinutes * inactiveContractThresholdPercent / 100) {
      missingRegularSessionDates.push(date);
    }
    if (regularCount >= expectedRegularMinutes) completeRegularSessionDates.push(date);
    if (overnightCoverageObserved && (overnightCounts.get(date) ?? 0) === 0) missingOvernightSessionDates.push(date);
    if (calendar.earlyCloses[date]) earlyCloseDates.add(date);
  }
  const inactiveDates = new Set(missingRegularSessionDates);
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    const gapStart = previous.openTime + MINUTE;
    const gapEnd = current.openTime;
    const missing = Math.max(0, Math.round((gapEnd - gapStart) / MINUTE));
    if (!missing) continue;
    missingMinuteGaps += missing;
    missingGapSegments += 1;
    let gapRegular = false;
    let gapOvernight = false;
    let regularMinutesInGap = 0;
    let earlyMinutesInGap = 0;
    let overnightMinutesInGap = 0;
    let maintenanceMinutesInGap = 0;
    const firstDate = tradingDateForTimestamp(gapStart, calendar);
    const lastDate = tradingDateForTimestamp(Math.max(gapStart, gapEnd - MINUTE), calendar);
    for (
      let cursor = Date.parse(`${firstDate}T12:00:00Z`) - 2 * 86_400_000;
      cursor <= Date.parse(`${lastDate}T12:00:00Z`) + 2 * 86_400_000;
      cursor += 86_400_000
    ) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      const regular = sessionWindow(date, "regular", calendar);
      if (regular) {
        const regularMinutes = overlapMinutes(gapStart, gapEnd, regular);
        if (regularMinutes > 0) {
          gapRegular = true;
          regularMinutesInGap += regularMinutes;
          regularSessionMissingMinutes += regularMinutes;
          if (inactiveDates.has(date)) inactiveContractMinutes += regularMinutes;
          else {
            unexpectedRegularSessionMissingMinutes += regularMinutes;
            unexpectedOpenSessionMissingMinutes += regularMinutes;
            unexpectedMissingMinutes += regularMinutes;
          }
        }
        if (regular.earlyClose) {
          earlyMinutesInGap += overlapMinutes(gapStart, gapEnd, {
            openTime: regular.closeTime,
            closeTime: newYorkTimeToUtc(date, calendar.regular.end),
          });
        }
      }
      if (isTradingDate(date, calendar)) {
        maintenanceMinutesInGap += overlapMinutes(gapStart, gapEnd, {
          openTime: newYorkTimeToUtc(date, "16:00"),
          closeTime: newYorkTimeToUtc(date, "18:00"),
        });
        overnightMinutesInGap += overlapMinutes(gapStart, gapEnd, {
          openTime: newYorkTimeToUtc(previousCalendarDate(date), "18:00"),
          closeTime: newYorkTimeToUtc(date, "04:00"),
        });
      }
    }
    const classified = regularMinutesInGap + earlyMinutesInGap + overnightMinutesInGap + maintenanceMinutesInGap;
    if (classified > missing) {
      throw new Error("Historical gap classification overlapped its missing-minute interval.");
    }
    const weekendMinutesInGap = Math.max(0, missing - classified);
    gapOvernight = overnightMinutesInGap > 0;
    earlyCloseMinutes += earlyMinutesInGap;
    unexpectedOvernightMissingMinutes += overnightMinutesInGap;
    unexpectedMissingMinutes += overnightMinutesInGap;
    maintenanceGapMinutes += maintenanceMinutesInGap;
    weekendHolidayClosedMinutes += weekendMinutesInGap;
    expectedClosedMinutes += earlyMinutesInGap + maintenanceMinutesInGap + weekendMinutesInGap;
    if (
      unexpectedRegularSessionMissingMinutes
      + unexpectedOvernightMissingMinutes
      + inactiveContractMinutes
      + maintenanceGapMinutes
      + weekendHolidayClosedMinutes
      + earlyCloseMinutes !== missingMinuteGaps
    ) {
      throw new Error("Historical gap classification did not reconcile its missing-minute totals.");
    }
    if (gapRegular) regularSessionGapSegments += 1;
    if (gapOvernight) overnightGapSegments += 1;
  }
  lowLiquidityInactiveMinutes = inactiveContractMinutes;
  expectedClosedMarketMinutes = expectedClosedMinutes;
  return {
    missingMinuteGaps,
    missingGapSegments,
    unexpectedOpenSessionMissingMinutes,
    unexpectedOvernightMissingMinutes,
    unexpectedRegularSessionMissingMinutes,
    unexpectedMissingMinutes,
    regularSessionGapSegments,
    overnightGapSegments,
    regularSessionMissingMinutes,
    expectedClosedMarketMinutes,
    expectedClosedMinutes,
    weekendHolidayClosedMinutes,
    earlyCloseMinutes,
    inactiveContractMinutes,
    lowLiquidityInactiveMinutes,
    coverageScope: "full_file",
    inactiveContractThresholdPercent,
    inactiveContractDays: missingRegularSessionDates.length,
    missingRegularSessionDates,
    missingOvernightSessionDates,
    completeRegularSessionDates,
    maintenanceGapMinutes,
    weekendHolidayGapMinutes: weekendHolidayClosedMinutes,
    earlyCloseDates: [...earlyCloseDates].sort(),
    overnightCoverageObserved,
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
  selectedDatesOverride?: readonly string[],
): CausalReplayDataset {
  const requestedDates = imported.summary.availableTradingDates.filter((date) => date >= startDate && date <= endDate);
  const requiredDates = inSampleDays + outOfSampleDays;
  const exactDates = selectedDatesOverride
    ? [...new Set(selectedDatesOverride)].filter((date) => requestedDates.includes(date)).sort()
    : null;
  if (exactDates && exactDates.length < requiredDates) {
    throw new Error(`Historical range contains ${exactDates.length} selected trading dates; ${requiredDates} are required.`);
  }
  if (!exactDates && requestedDates.length < requiredDates) {
    throw new Error(`Historical range contains ${requestedDates.length} trading dates; ${requiredDates} are required.`);
  }
  // Use the latest exact N+M available dates ending on or before endDate.
  // Earlier available dates remain explicitly excluded rather than silently
  // becoming part of the replay.
  const availableDates = exactDates ?? requestedDates.slice(-requiredDates);
  const selectedDates = new Set(availableDates);
  const fiveMinute = imported.fiveMinute.filter((candle) => selectedDates.has(tradingDateForTimestamp(candle.openTime, imported.calendar)));
  const oneMinute = imported.oneMinute.filter((candle) => selectedDates.has(tradingDateForTimestamp(candle.openTime, imported.calendar)));
  const selectedGapReport = countSessionAwareGaps(oneMinute, imported.calendar);
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
      ...selectedGapReport,
      coverageScope: "selected_dates",
    },
  };
}

export function publicHistoricalImportSummary(imported: HistoricalCsvImport): HistoricalCsvImportSummary {
  return imported.summary;
}

async function resolveImportPath(): Promise<string> {
  const configured = process.env["LEVELSTORY_HISTORICAL_CSV_PATH"] ?? process.env["LEVELSTORY_CSV_REPLAY_PATH"];
  if (configured) return boundedCsvPath(configured);
  const assetDirectories = [
    join(process.cwd(), "attached_assets"),
    join(process.cwd(), "..", "attached_assets"),
    join(process.cwd(), "..", "..", "attached_assets"),
  ];
  for (const assetsDirectory of assetDirectories) {
    try {
      const files = await readdir(assetsDirectory);
      const match = files
        .filter((file) => file.endsWith(".csv")
          && file.startsWith(DEFAULT_FILENAME_PREFIX)
          && /^glbx-mdp3-.*\.ohlcv-1m\.MESU6(?:_\d+)?\.csv$/.test(file))
        .sort()[0];
      if (match) return boundedCsvPath(join(assetsDirectory, match));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("No uploaded MESU6 Databento CSV was found in attached_assets.");
}

export async function importHistoricalCsv(
  filePath: string,
  specification: FuturesContractSpecification,
  options: {
    analyzeCoverage?: boolean;
    aggregations?: readonly (5 | 15 | 60)[];
    fastParse?: boolean;
    contentFingerprint?: string;
  } = {},
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
    unexpectedMissingMinutes: 0,
    unexpectedOpenSessionMissingMinutes: 0,
    unexpectedOvernightMissingMinutes: 0,
    unexpectedRegularSessionMissingMinutes: 0,
    regularSessionGapSegments: 0,
    overnightGapSegments: 0,
    regularSessionMissingMinutes: 0,
    expectedClosedMarketMinutes: 0,
    expectedClosedMinutes: 0,
    weekendHolidayClosedMinutes: 0,
    earlyCloseMinutes: 0,
    inactiveContractMinutes: 0,
    lowLiquidityInactiveMinutes: 0,
    coverageScope: "full_file",
    inactiveContractThresholdPercent: 50,
    inactiveContractDays: 0,
    missingRegularSessionDates: [],
    missingOvernightSessionDates: [],
    completeRegularSessionDates: [],
    maintenanceGapMinutes: 0,
    weekendHolidayGapMinutes: 0,
    earlyCloseDates: [],
    overnightCoverageObserved: false,
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
  const fastDateCache = new Map<number, string>();
  const fastSessionCache = new Map<number, string>();
  const tradingDateForRow = (timestamp: number): string => {
    if (!options.fastParse) return tradingDateForTimestamp(timestamp, calendar);
    const hour = Math.floor(timestamp / (60 * MINUTE));
    const cached = fastDateCache.get(hour);
    if (cached) return cached;
    const date = tradingDateForTimestamp(timestamp, calendar);
    fastDateCache.set(hour, date);
    return date;
  };
  const sessionForRow = (timestamp: number): string => {
    if (!options.fastParse) return classifyFuturesSession(timestamp, calendar);
    const hour = Math.floor(timestamp / (60 * MINUTE));
    const cached = fastSessionCache.get(hour);
    if (cached) return cached;
    const session = classifyFuturesSession(timestamp, calendar);
    fastSessionCache.set(hour, session);
    return session;
  };

  const fileStream = options.fastParse ? null : createReadStream(filePath);
  const contentHash = createHash("sha256");
  const processLine = (rawLine: string): void => {
    const line = String(rawLine).trim();
    if (!line) return;
    const values = parseCsvLine(line);
    if (!headers) {
      if (!values) throw new Error("CSV header contains an unterminated quoted field.");
      headers = values.map((header) => header.toLowerCase());
      const missing = REQUIRED_HEADERS.filter((header) => !headers!.includes(header));
      if (missing.length) throw new Error(`CSV is missing required Databento columns: ${missing.join(", ")}.`);
      return;
    }
    summary.totalRows += 1;
    const row = summary.totalRows + 1;
    if (!values || values.length !== headers.length) {
      reasonFor(summary, row, "MALFORMED_ROW");
      return;
    }
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const timestampValue = record["ts_event"] || record["timestamp"] || record["event_time"] || "";
    const symbol = record["symbol"]?.trim() ?? "";
    if (!validIsoTimestamp(timestampValue)) {
      reasonFor(summary, row, "INVALID_ISO_TIMESTAMP");
      return;
    }
    if (symbol.includes("-")) {
      reasonFor(summary, row, "CALENDAR_SPREAD_REJECTED");
      return;
    }
    if (!outrightMesSymbol(symbol)) {
      reasonFor(summary, row, "NON_MES_OUTRIGHT_SYMBOL");
      return;
    }
    if (summary.detectedSymbol === null) summary.detectedSymbol = symbol;
    if (symbol !== summary.detectedSymbol) {
      reasonFor(summary, row, "MULTIPLE_OUTRIGHT_SYMBOLS");
      return;
    }
    const numericValues = ["open", "high", "low", "close", "volume"].map((key) => requiredNumber(record[key] ?? ""));
    if (numericValues.some((value) => value === null)) {
      reasonFor(summary, row, "NON_NUMERIC_OHLCV");
      return;
    }
    const [open, high, low, close, volume] = numericValues as number[];
    if (high < open || high < close || high < low || low > open || low > close || low > high) {
      reasonFor(summary, row, "INVALID_OHLC_RELATIONSHIP");
      return;
    }
    if (volume < 0) {
      reasonFor(summary, row, "NEGATIVE_VOLUME");
      return;
    }
    const timestamp = Date.parse(timestampValue);
    if (previousTimestamp !== null && timestamp < previousTimestamp) {
      reasonFor(summary, row, "OUT_OF_ORDER_TIMESTAMP");
      return;
    }
    if (previousTimestamp !== null && timestamp === previousTimestamp) {
      summary.duplicateRowsRemoved += 1;
      return;
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
    const date = tradingDateForRow(timestamp);
    if (isTradingDate(date, calendar)) tradingDates.add(date);
    if (sessionForRow(timestamp) === "regular") summary.regularSessionCandleCount += 1;
    else if (overnightOwnerDate(timestamp, calendar)) summary.overnightCandleCount += 1;
  };
  if (options.fastParse) {
    const content = await readFile(filePath, "utf8");
    contentHash.update(content);
    for (const rawLine of content.split(/\r?\n/)) processLine(rawLine);
  } else {
    fileStream!.on("data", (chunk) => contentHash.update(chunk));
    const input = createInterface({ input: fileStream!, crlfDelay: Infinity });
    for await (const rawLine of input) processLine(String(rawLine));
  }
  if (!headers) throw new Error("CSV file is empty.");
  const gapReport = options.analyzeCoverage === false
    ? {
        ...countSessionAwareGaps([], calendar),
        coverageScope: "full_file" as const,
      }
    : countSessionAwareGaps(candles, calendar);
  Object.assign(summary, gapReport);
  summary.availableTradingDates = [...tradingDates].sort();
  const aggregationSet = new Set(options.aggregations ?? [5, 15, 60]);
  const fiveMinute = aggregationSet.has(5) ? aggregate(candles, 5, specification) : [];
  const fifteenMinute = aggregationSet.has(15) ? aggregate(candles, 15, specification) : [];
  const oneHour = aggregationSet.has(60) ? aggregate(candles, 60, specification) : [];
  summary.aggregationCounts = {
    oneMinute: candles.length,
    fiveMinute: fiveMinute.length,
    fifteenMinute: fifteenMinute.length,
    oneHour: oneHour.length,
  };
  return {
    summary,
    contentFingerprint: options.contentFingerprint ?? contentHash.digest("hex"),
    oneMinute: candles,
    fiveMinute,
    fifteenMinute,
    oneHour,
    specification,
    calendar,
  };
}

let cachedImport: { path: string; modifiedAt: number; value: HistoricalCsvImport } | null = null;
let importPromise: Promise<HistoricalCsvImport> | null = null;

export async function getHistoricalCsvImport(
  specification: FuturesContractSpecification,
): Promise<HistoricalCsvImport> {
  if (importPromise) return importPromise;
  const filePath = await resolveImportPath();
  const modifiedAt = (await stat(filePath)).mtimeMs;
  if (cachedImport?.path === filePath && cachedImport.modifiedAt === modifiedAt) {
    const fingerprint = await getHistoricalCsvFingerprint(filePath);
    if (cachedImport.value.contentFingerprint === fingerprint) return cachedImport.value;
  }
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

export async function getHistoricalCsvFingerprint(filePath?: string): Promise<string> {
  const resolvedPath = filePath ? boundedCsvPath(filePath) : await resolveImportPath();
  const hash = createHash("sha256");
  const stream = createReadStream(resolvedPath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}