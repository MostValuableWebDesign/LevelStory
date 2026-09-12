import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { createZstdDecompress } from "node:zlib";
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
import { HistoricalNoDataError, MAX_HISTORICAL_SESSIONS } from "./historical-session-range.js";
import { boundedCsvPath } from "../security.js";

const MINUTE = 60_000;
const REQUIRED_HEADERS = ["ts_event", "open", "high", "low", "close", "volume", "symbol"] as const;
const DEFAULT_FILENAME_PREFIX = "glbx-mdp3-";
const MAX_REPORTED_ERRORS = 25;
const MONTH_CODE_TO_NUMBER = {
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6,
  N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12,
} as const;

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
  /**
   * Data-quality failures keyed by the exact trading date they can affect.
   * Aggregate rejectedRows is intentionally not used as a date eligibility gate.
   */
  untrustedTradingDates?: Record<string, string[]>;
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

export type HistoricalCsvBatchImport = {
  imports: ReadonlyMap<string, HistoricalCsvImport>;
  rejectedRows: Array<{ row: number; symbol: string | null; reason: string }>;
  rowsRead?: number;
  flushCount?: number;
};

export type HistoricalCsvCandleBatch = {
  contractSymbol: string;
  candles: readonly NormalizedCandle[];
};

export type HistoricalCsvProgress = {
  phase: "reading" | "coverage" | "aggregating";
  rowsRead: number;
  validRows: number;
  rejectedRows: number;
  percent: number;
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

function createSummary(filename: string): HistoricalCsvImportSummary {
  return {
    source: "historical_databento",
    filename,
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
    untrustedTradingDates: {},
    aggregationCounts: { oneMinute: 0, fiveMinute: 0, fifteenMinute: 0, oneHour: 0 },
  };
}

function markUntrustedDate(
  summary: HistoricalCsvImportSummary,
  tradingDate: string | null,
  reason: string,
): void {
  if (!tradingDate) return;
  const reasons = summary.untrustedTradingDates?.[tradingDate] ?? [];
  if (!reasons.includes(reason)) reasons.push(reason);
  summary.untrustedTradingDates = {
    ...(summary.untrustedTradingDates ?? {}),
    [tradingDate]: reasons,
  };
}

function unsupportedCompression(filePath: string): void {
  if (/\.(?:csv\.(?:gz|zip)|zip)$/i.test(filePath)) {
    throw new Error("Unsupported historical CSV compression: only plain CSV and streaming .csv.zst inputs are supported.");
  }
}

/**
 * Databento puts the instrument symbol between the dataset and schema
 * portions of its filename.  Generic fixture names are deliberately allowed;
 * when the Databento shape is present, however, the name is authoritative.
 */
export function historicalCsvFilenameSymbol(filePath: string): string | null {
  const filename = basename(filePath);
  const match = filename.match(/(?:^|[._-])(MES[A-Z]\d{1,2})(?=[._-]|$)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function candleValuesEqual(first: NormalizedCandle, second: NormalizedCandle): boolean {
  return first.open === second.open
    && first.high === second.high
    && first.low === second.low
    && first.close === second.close
    && first.volume === second.volume
    && first.contractSymbol === second.contractSymbol;
}

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

export function aggregate(
  candles: readonly NormalizedCandle[],
  intervalMinutes: 5 | 15 | 60,
  specification: FuturesContractSpecification,
): NormalizedCandle[] {
  const interval = intervalMinutes * MINUTE;
  const groups = new Map<number, NormalizedCandle[]>();
  for (const candle of candles) {
    if (candle.contractSymbol !== specification.fullContractSymbol) {
      throw new Error(
        `Historical aggregation contract mismatch: expected ${specification.fullContractSymbol}, got ${candle.contractSymbol}.`,
      );
    }
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
        for (const maintenance of calendar.maintenanceClosures.default ?? []) {
          maintenanceMinutesInGap += overlapMinutes(gapStart, gapEnd, {
            openTime: newYorkTimeToUtc(date, maintenance.start),
            closeTime: newYorkTimeToUtc(date, maintenance.end),
          });
        }
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
  startDate: string | undefined,
  endDate: string,
  inSampleDays: number,
  outOfSampleDays: number,
  selectedDatesOverride?: readonly string[],
): CausalReplayDataset {
  const requestedDates = imported.summary.availableTradingDates.filter((date) =>
    (!startDate || date >= startDate) && date <= endDate);
  const requiredDates = inSampleDays + outOfSampleDays;
  if (requiredDates > MAX_HISTORICAL_SESSIONS || (startDate && requestedDates.length > MAX_HISTORICAL_SESSIONS)) {
    throw new Error(`Historical range resolves to ${requestedDates.length} stored trading sessions; shorten the range to at most ${MAX_HISTORICAL_SESSIONS} sessions.`);
  }
  const exactDates = selectedDatesOverride
    ? [...new Set(selectedDatesOverride)].filter((date) => requestedDates.includes(date)).sort()
    : null;
  if (requestedDates.length === 0 || (exactDates && exactDates.length === 0)) {
    throw new HistoricalNoDataError(`No historical data available${startDate ? ` between ${startDate} and` : " before"} ${endDate}.`);
  }
  if (exactDates && exactDates.length < requiredDates) {
    throw new Error(`Historical range contains ${exactDates.length} stored trading sessions; ${requiredDates} are required.`);
  }
  if (!exactDates && requestedDates.length < requiredDates) {
    throw new Error(`Historical range contains ${requestedDates.length} stored trading sessions; ${requiredDates} are required.`);
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
    requestedStartDate: startDate ?? availableDates[0] ?? endDate,
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
    expectedSymbol?: string;
    skipOtherSymbols?: boolean;
    onProgress?: (progress: HistoricalCsvProgress) => void;
  } = {},
): Promise<HistoricalCsvImport> {
  unsupportedCompression(filePath);
  const filenameSymbol = historicalCsvFilenameSymbol(filePath);
  const calendar = sessionCalendarForContract(specification);
  const summary = createSummary(basename(filePath));
  const candles: NormalizedCandle[] = [];
  const candleByTimestamp = new Map<number, NormalizedCandle>();
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

  const compressed = filePath.toLowerCase().endsWith(".zst");
  const fileStream = createReadStream(filePath);
  const sourceSize = (await stat(filePath)).size;
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
    if (summary.totalRows % 10_000 === 0) {
      options.onProgress?.({
        phase: "reading",
        rowsRead: summary.totalRows,
        validRows: summary.validRows,
        rejectedRows: summary.rejectedRows,
        percent: sourceSize > 0 ? Math.min(99, Math.round((fileStream.bytesRead / sourceSize) * 100)) : 0,
      });
    }
    if (!values || values.length !== headers.length) {
      reasonFor(summary, row, "MALFORMED_ROW");
      return;
    }
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const timestampValue = record["ts_event"] || record["timestamp"] || record["event_time"] || "";
    const symbol = record["symbol"]?.trim() ?? "";
    const parsedTimestamp = validIsoTimestamp(timestampValue) ? Date.parse(timestampValue) : null;
    const reject = (reason: string): void => {
      reasonFor(summary, row, reason);
      if (parsedTimestamp !== null) {
        markUntrustedDate(summary, tradingDateForTimestamp(parsedTimestamp, calendar), reason);
      }
    };
    if (!validIsoTimestamp(timestampValue)) {
      reject("INVALID_ISO_TIMESTAMP");
      return;
    }
    if (symbol.includes("-")) {
      reject("CALENDAR_SPREAD_REJECTED");
      return;
    }
    if (!outrightMesSymbol(symbol)) {
      reject("NON_MES_OUTRIGHT_SYMBOL");
      return;
    }
    if (options.expectedSymbol && symbol !== options.expectedSymbol) {
      if (options.skipOtherSymbols) return;
       reject("MULTIPLE_OUTRIGHT_SYMBOLS");
      return;
    }
    if (summary.detectedSymbol === null) summary.detectedSymbol = options.expectedSymbol ?? symbol;
    if (filenameSymbol && symbol !== filenameSymbol) {
       reject("FILENAME_SYMBOL_MISMATCH");
      return;
    }
    if (!options.expectedSymbol && symbol !== summary.detectedSymbol) {
       reject("MULTIPLE_OUTRIGHT_SYMBOLS");
      return;
    }
    const numericValues = ["open", "high", "low", "close", "volume"].map((key) => requiredNumber(record[key] ?? ""));
    if (numericValues.some((value) => value === null)) {
       reject("NON_NUMERIC_OHLCV");
      return;
    }
    const [open, high, low, close, volume] = numericValues as number[];
    if (high < open || high < close || high < low || low > open || low > close || low > high) {
       reject("INVALID_OHLC_RELATIONSHIP");
      return;
    }
    if (volume < 0) {
       reject("NEGATIVE_VOLUME");
      return;
    }
    const timestamp = Date.parse(timestampValue);
    if (timestamp % MINUTE !== 0) {
       reject("MISALIGNED_MINUTE_TIMESTAMP");
      return;
    }
    if (previousTimestamp !== null && timestamp < previousTimestamp) {
       reject("OUT_OF_ORDER_TIMESTAMP");
      return;
    }
    const existing = candleByTimestamp.get(timestamp);
    if (existing) {
      if (!candleValuesEqual(existing, {
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
      })) {
         reject("CONFLICTING_DUPLICATE_TIMESTAMP");
      } else {
        summary.duplicateRowsRemoved += 1;
      }
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
    candleByTimestamp.set(timestamp, candle);
    summary.validRows += 1;
    summary.earliestTimestamp ??= new Date(timestamp).toISOString();
    summary.latestTimestamp = new Date(timestamp).toISOString();
    const date = tradingDateForRow(timestamp);
    if (isTradingDate(date, calendar)) tradingDates.add(date);
    if (sessionForRow(timestamp) === "regular") summary.regularSessionCandleCount += 1;
    else if (overnightOwnerDate(timestamp, calendar)) summary.overnightCandleCount += 1;
  };
  fileStream.on("data", (chunk) => contentHash.update(chunk));
  const decompressed = compressed ? fileStream.pipe(createZstdDecompress()) : fileStream;
  const input = createInterface({ input: decompressed, crlfDelay: Infinity });
  for await (const rawLine of input) processLine(String(rawLine));
  if (!headers) throw new Error("CSV file is empty.");
  const gapReport = options.analyzeCoverage === false
    ? {
        ...countSessionAwareGaps([], calendar),
        coverageScope: "full_file" as const,
      }
    : countSessionAwareGaps(candles, calendar);
  options.onProgress?.({
    phase: "coverage",
    rowsRead: summary.totalRows,
    validRows: summary.validRows,
    rejectedRows: summary.rejectedRows,
    percent: 90,
  });
  Object.assign(summary, gapReport);
  summary.availableTradingDates = [...tradingDates].sort();
  const aggregationSet = new Set(options.aggregations ?? [5, 15, 60]);
  const resolvedSpecification = summary.detectedSymbol && !options.expectedSymbol
    ? specificationForDetectedSymbol(specification, summary.detectedSymbol)
    : specification;
  const fiveMinute = aggregationSet.has(5) ? aggregate(candles, 5, resolvedSpecification) : [];
  const fifteenMinute = aggregationSet.has(15) ? aggregate(candles, 15, resolvedSpecification) : [];
  const oneHour = aggregationSet.has(60) ? aggregate(candles, 60, resolvedSpecification) : [];
  options.onProgress?.({
    phase: "aggregating",
    rowsRead: summary.totalRows,
    validRows: summary.validRows,
    rejectedRows: summary.rejectedRows,
    percent: 98,
  });
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
    specification: resolvedSpecification,
    calendar: sessionCalendarForContract(resolvedSpecification),
  };
}

async function discoverHistoricalCsvSymbols(filePath: string): Promise<{
  symbols: string[];
  rejectedRows: Array<{ row: number; symbol: string | null; reason: string }>;
}> {
  unsupportedCompression(filePath);
  const compressed = filePath.toLowerCase().endsWith(".zst");
  const fileStream = createReadStream(filePath);
  const sourceSize = (await stat(filePath)).size;
  const decompressed = compressed ? fileStream.pipe(createZstdDecompress()) : fileStream;
  const input = createInterface({ input: decompressed, crlfDelay: Infinity });
  let headers: string[] | null = null;
  let rowNumber = 0;
  const symbols = new Set<string>();
  const rejectedRows: Array<{ row: number; symbol: string | null; reason: string }> = [];
  for await (const rawLine of input) {
    const values = parseCsvLine(String(rawLine).trim());
    if (!values || values.length === 0) continue;
    if (!headers) {
      headers = values.map((header) => header.toLowerCase());
      if (!REQUIRED_HEADERS.every((header) => headers!.includes(header))) {
        throw new Error(`CSV is missing required Databento columns: ${REQUIRED_HEADERS.filter((header) => !headers!.includes(header)).join(", ")}.`);
      }
      continue;
    }
    rowNumber += 1;
    if (values.length !== headers.length) {
      rejectedRows.push({ row: rowNumber + 1, symbol: null, reason: "MALFORMED_ROW" });
      continue;
    }
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const symbol = record["symbol"]?.trim() || null;
    if (!symbol || !outrightMesSymbol(symbol)) {
      rejectedRows.push({
        row: rowNumber + 1,
        symbol,
        reason: symbol?.includes("-") ? "CALENDAR_SPREAD_REJECTED" : "NON_MES_OUTRIGHT_SYMBOL",
      });
      continue;
    }
    symbols.add(symbol.toUpperCase());
  }
  if (!headers) throw new Error("CSV file is empty.");
  return { symbols: [...symbols].sort(), rejectedRows };
}

type BatchImportState = {
  summary: HistoricalCsvImportSummary;
  specification: FuturesContractSpecification;
  calendar: FuturesSessionCalendar;
  candles: NormalizedCandle[];
  lastCandle: NormalizedCandle | null;
  tradingDates: Set<string>;
  previousTimestamp: number | null;
  fastDateCache: Map<number, string>;
  fastSessionCache: Map<number, string>;
  streamingGapState: StreamingGapState | null;
  streamingAggregationCounts: HistoricalCsvImportSummary["aggregationCounts"];
  streamingAggregationBuckets: Map<5 | 15 | 60, number | null>;
};

type StreamingGapState = {
  previousOpenTime: number | null;
  tradingDates: Set<string>;
  regularCounts: Map<string, number>;
  overnightCounts: Map<string, number>;
  earlyCloseDates: Set<string>;
  regularMissingByDate: Map<string, number>;
  missingMinuteGaps: number;
  missingGapSegments: number;
  regularSessionGapSegments: number;
  overnightGapSegments: number;
  unexpectedOvernightMissingMinutes: number;
  maintenanceGapMinutes: number;
  weekendHolidayClosedMinutes: number;
  earlyCloseMinutes: number;
  overnightCoverageObserved: boolean;
};

function createStreamingGapState(): StreamingGapState {
  return {
    previousOpenTime: null,
    tradingDates: new Set(),
    regularCounts: new Map(),
    overnightCounts: new Map(),
    earlyCloseDates: new Set(),
    regularMissingByDate: new Map(),
    missingMinuteGaps: 0,
    missingGapSegments: 0,
    regularSessionGapSegments: 0,
    overnightGapSegments: 0,
    unexpectedOvernightMissingMinutes: 0,
    maintenanceGapMinutes: 0,
    weekendHolidayClosedMinutes: 0,
    earlyCloseMinutes: 0,
    overnightCoverageObserved: false,
  };
}

function addStreamingGapCandle(
  state: StreamingGapState,
  candle: NormalizedCandle,
  calendar: FuturesSessionCalendar,
): void {
  const date = tradingDateForTimestamp(candle.openTime, calendar);
  if (isTradingDate(date, calendar)) state.tradingDates.add(date);
  const regular = sessionWindow(date, "regular", calendar);
  if (regular && candle.openTime >= regular.openTime && candle.openTime < regular.closeTime) {
    state.regularCounts.set(date, (state.regularCounts.get(date) ?? 0) + 1);
    if (regular.earlyClose) state.earlyCloseDates.add(date);
  }
  const overnightDate = overnightOwnerDate(candle.openTime, calendar);
  if (overnightDate) {
    state.overnightCounts.set(overnightDate, (state.overnightCounts.get(overnightDate) ?? 0) + 1);
  }
  const previousOpenTime = state.previousOpenTime;
  if (previousOpenTime !== null) {
    const gapStart = previousOpenTime + MINUTE;
    const gapEnd = candle.openTime;
    const missing = Math.max(0, Math.round((gapEnd - gapStart) / MINUTE));
    if (missing > 0) {
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
        const gapDate = new Date(cursor).toISOString().slice(0, 10);
        const gapRegularWindow = sessionWindow(gapDate, "regular", calendar);
        if (gapRegularWindow) {
          const regularMinutes = overlapMinutes(gapStart, gapEnd, gapRegularWindow);
          if (regularMinutes > 0) {
            gapRegular = true;
            regularMinutesInGap += regularMinutes;
            state.regularMissingByDate.set(
              gapDate,
              (state.regularMissingByDate.get(gapDate) ?? 0) + regularMinutes,
            );
          }
          if (gapRegularWindow.earlyClose) {
            earlyMinutesInGap += overlapMinutes(gapStart, gapEnd, {
              openTime: gapRegularWindow.closeTime,
              closeTime: newYorkTimeToUtc(gapDate, calendar.regular.end),
            });
          }
        }
        if (isTradingDate(gapDate, calendar)) {
          for (const maintenance of calendar.maintenanceClosures.default ?? []) {
            maintenanceMinutesInGap += overlapMinutes(gapStart, gapEnd, {
              openTime: newYorkTimeToUtc(previousCalendarDate(gapDate), maintenance.start),
              closeTime: newYorkTimeToUtc(gapDate, maintenance.end),
            });
          }
          const overnightMinutes = overlapMinutes(gapStart, gapEnd, {
            openTime: newYorkTimeToUtc(previousCalendarDate(gapDate), "18:00"),
            closeTime: newYorkTimeToUtc(gapDate, "04:00"),
          });
          if (overnightMinutes > 0) {
            gapOvernight = true;
            overnightMinutesInGap += overnightMinutes;
          }
        }
      }
      const classified = regularMinutesInGap + earlyMinutesInGap + overnightMinutesInGap + maintenanceMinutesInGap;
      if (classified > missing) {
        throw new Error("Historical gap classification overlapped its missing-minute interval.");
      }
      state.missingMinuteGaps += missing;
      state.missingGapSegments += 1;
      state.regularSessionGapSegments += gapRegular ? 1 : 0;
      state.overnightGapSegments += gapOvernight ? 1 : 0;
      state.unexpectedOvernightMissingMinutes += overnightMinutesInGap;
      state.maintenanceGapMinutes += maintenanceMinutesInGap;
      state.weekendHolidayClosedMinutes += Math.max(0, missing - classified);
      state.earlyCloseMinutes += earlyMinutesInGap;
    }
  }
  state.previousOpenTime = candle.openTime;
}

function finalizeStreamingGapState(
  state: StreamingGapState,
  calendar: FuturesSessionCalendar,
): ReturnType<typeof countSessionAwareGaps> {
  const sortedDates = [...state.tradingDates].sort();
  if (sortedDates.length > 0) {
    for (
      let cursor = Date.parse(`${sortedDates[0]}T12:00:00Z`);
      cursor <= Date.parse(`${sortedDates.at(-1)!}T12:00:00Z`);
      cursor += 86_400_000
    ) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      if (isTradingDate(date, calendar)) state.tradingDates.add(date);
    }
  }
  const allTradingDates = [...state.tradingDates].sort();
  const inactiveContractThresholdPercent = Number(process.env.LEVELSTORY_INACTIVE_RTH_THRESHOLD_PERCENT ?? 50);
  const missingRegularSessionDates: string[] = [];
  const missingOvernightSessionDates: string[] = [];
  const completeRegularSessionDates: string[] = [];
  const inactiveDates = new Set<string>();
  const earlyCloseDates = new Set(state.earlyCloseDates);
  let regularSessionMissingMinutes = 0;
  let inactiveContractMinutes = 0;
  let unexpectedRegularSessionMissingMinutes = 0;
  for (const date of allTradingDates) {
    const regular = sessionWindow(date, "regular", calendar);
    const expectedRegularMinutes = regular ? Math.round((regular.closeTime - regular.openTime) / MINUTE) : 0;
    const regularCount = state.regularCounts.get(date) ?? 0;
    if (regularCount === 0 || regularCount < expectedRegularMinutes * inactiveContractThresholdPercent / 100) {
      missingRegularSessionDates.push(date);
      inactiveDates.add(date);
    }
    if (regularCount >= expectedRegularMinutes) completeRegularSessionDates.push(date);
    if (state.overnightCoverageObserved && (state.overnightCounts.get(date) ?? 0) === 0) {
      missingOvernightSessionDates.push(date);
    }
    if (calendar.earlyCloses[date]) earlyCloseDates.add(date);
    const missingForDate = state.regularMissingByDate.get(date) ?? 0;
    regularSessionMissingMinutes += missingForDate;
    if (inactiveDates.has(date)) inactiveContractMinutes += missingForDate;
    else unexpectedRegularSessionMissingMinutes += missingForDate;
  }
  const unexpectedMissingMinutes = unexpectedRegularSessionMissingMinutes
    + state.unexpectedOvernightMissingMinutes;
  const expectedClosedMinutes = state.maintenanceGapMinutes
    + state.weekendHolidayClosedMinutes
    + state.earlyCloseMinutes;
  if (
    unexpectedMissingMinutes + inactiveContractMinutes + expectedClosedMinutes !== state.missingMinuteGaps
  ) {
    throw new Error("Historical gap classification did not reconcile its missing-minute totals.");
  }
  return {
    missingMinuteGaps: state.missingMinuteGaps,
    missingGapSegments: state.missingGapSegments,
    unexpectedOpenSessionMissingMinutes: unexpectedRegularSessionMissingMinutes,
    unexpectedOvernightMissingMinutes: state.unexpectedOvernightMissingMinutes,
    unexpectedRegularSessionMissingMinutes,
    unexpectedMissingMinutes,
    regularSessionGapSegments: state.regularSessionGapSegments,
    overnightGapSegments: state.overnightGapSegments,
    regularSessionMissingMinutes,
    expectedClosedMarketMinutes: expectedClosedMinutes,
    expectedClosedMinutes,
    weekendHolidayClosedMinutes: state.weekendHolidayClosedMinutes,
    earlyCloseMinutes: state.earlyCloseMinutes,
    inactiveContractMinutes,
    lowLiquidityInactiveMinutes: inactiveContractMinutes,
    coverageScope: "full_file",
    inactiveContractThresholdPercent,
    inactiveContractDays: missingRegularSessionDates.length,
    missingRegularSessionDates,
    missingOvernightSessionDates,
    completeRegularSessionDates,
    maintenanceGapMinutes: state.maintenanceGapMinutes,
    weekendHolidayGapMinutes: state.weekendHolidayClosedMinutes,
    earlyCloseDates: [...earlyCloseDates].sort(),
    overnightCoverageObserved: state.overnightCounts.size > 0,
  };
}

function specificationForDetectedSymbol(
  base: FuturesContractSpecification,
  symbol: string,
): FuturesContractSpecification {
  const identity = /^MES([FGHJKMNQUVXZ])(\d{1,2})$/i.exec(symbol);
  const month = identity
    ? MONTH_CODE_TO_NUMBER[identity[1]!.toUpperCase() as keyof typeof MONTH_CODE_TO_NUMBER]
    : undefined;
  const yearToken = identity?.[2] ?? "";
  const year = yearToken.length === 1 ? 2020 + Number(yearToken) : 2000 + Number(yearToken);
  return {
    ...base,
    fullContractSymbol: symbol,
    contractMonth: month ? `${year}-${String(month).padStart(2, "0")}` : base.contractMonth,
    regularSessionHours: { ...base.regularSessionHours },
  };
}

function finalizeBatchState(
  state: BatchImportState,
  options: {
    analyzeCoverage?: boolean;
    aggregations?: readonly (5 | 15 | 60)[];
    contentFingerprint: string;
    retainCandles: boolean;
  },
): HistoricalCsvImport {
  const gapReport = options.analyzeCoverage === false
    ? { ...countSessionAwareGaps([], state.calendar), coverageScope: "full_file" as const }
    : options.retainCandles
      ? countSessionAwareGaps(state.candles, state.calendar)
      : finalizeStreamingGapState(state.streamingGapState!, state.calendar);
  Object.assign(state.summary, gapReport);
  state.summary.availableTradingDates = [...state.tradingDates].sort();
  const aggregationSet = new Set(options.aggregations ?? [5, 15, 60]);
  const fiveMinute = options.retainCandles && aggregationSet.has(5)
    ? aggregate(state.candles, 5, state.specification)
    : [];
  const fifteenMinute = options.retainCandles && aggregationSet.has(15)
    ? aggregate(state.candles, 15, state.specification)
    : [];
  const oneHour = options.retainCandles && aggregationSet.has(60)
    ? aggregate(state.candles, 60, state.specification)
    : [];
  state.summary.aggregationCounts = {
    oneMinute: options.retainCandles ? state.candles.length : state.summary.validRows,
    fiveMinute: options.retainCandles ? fiveMinute.length : state.streamingAggregationCounts.fiveMinute,
    fifteenMinute: options.retainCandles ? fifteenMinute.length : state.streamingAggregationCounts.fifteenMinute,
    oneHour: options.retainCandles ? oneHour.length : state.streamingAggregationCounts.oneHour,
  };
  return {
    summary: state.summary,
    contentFingerprint: options.contentFingerprint,
    oneMinute: state.candles,
    fiveMinute,
    fifteenMinute,
    oneHour,
    specification: state.specification,
    calendar: state.calendar,
  };
}

/**
 * Reads a generic Databento batch once and keeps validation state independent
 * for every discovered outright contract. The per-symbol ordering and
 * duplicate maps are the important correctness boundary: interleaved symbols
 * must not poison one another's chronology or partitions.
 */
export async function importHistoricalCsvBatch(
  filePath: string,
  specification: FuturesContractSpecification,
  options: {
    analyzeCoverage?: boolean;
    aggregations?: readonly (5 | 15 | 60)[];
    fastParse?: boolean;
    contentFingerprint?: string;
    onProgress?: (progress: HistoricalCsvProgress) => void;
    onBatch?: (batch: HistoricalCsvCandleBatch) => void | Promise<void>;
    batchSize?: number;
    retainCandles?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<HistoricalCsvBatchImport> {
  unsupportedCompression(filePath);
  const compressed = filePath.toLowerCase().endsWith(".zst");
  const fileStream = createReadStream(filePath);
  const sourceSize = (await stat(filePath)).size;
  const decompressed = compressed ? fileStream.pipe(createZstdDecompress()) : fileStream;
  const input = createInterface({ input: decompressed, crlfDelay: Infinity });
  const contentHash = createHash("sha256");
  fileStream.on("data", (chunk) => contentHash.update(chunk));
  const states = new Map<string, BatchImportState>();
  const pending = new Map<string, NormalizedCandle[]>();
  let flushCount = 0;
  const rejectedRows: Array<{ row: number; symbol: string | null; reason: string }> = [];
  let headers: string[] | null = null;
  let rowsRead = 0;
  const filenameSymbol = historicalCsvFilenameSymbol(filePath);

  const stateFor = (symbol: string): BatchImportState => {
    const existing = states.get(symbol);
    if (existing) return existing;
    const contract = specificationForDetectedSymbol(specification, symbol);
    const state: BatchImportState = {
      summary: createSummary(basename(filePath)),
      specification: contract,
      calendar: sessionCalendarForContract(contract),
      candles: [],
      lastCandle: null,
      tradingDates: new Set(),
      previousTimestamp: null,
      fastDateCache: new Map(),
      fastSessionCache: new Map(),
      streamingGapState: options.retainCandles === false ? createStreamingGapState() : null,
      streamingAggregationCounts: {
        oneMinute: 0,
        fiveMinute: 0,
        fifteenMinute: 0,
        oneHour: 0,
      },
      streamingAggregationBuckets: new Map([
        [5, null],
        [15, null],
        [60, null],
      ]),
    };
    state.summary.detectedSymbol = symbol;
    states.set(symbol, state);
    return state;
  };

  const reject = (state: BatchImportState | undefined, row: number, symbol: string | null, reason: string, date?: string | null) => {
    rejectedRows.push({ row, symbol, reason });
    if (state) {
      reasonFor(state.summary, row, reason);
      markUntrustedDate(state.summary, date ?? null, reason);
    }
  };

  for await (const rawLine of input) {
    if (options.signal?.aborted) throw new Error("Historical CSV import was cancelled.");
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
    rowsRead += 1;
    if (rowsRead % 10_000 === 0) {
      options.onProgress?.({
        phase: "reading",
        rowsRead,
        validRows: [...states.values()].reduce((sum, state) => sum + state.summary.validRows, 0),
        rejectedRows: rejectedRows.length,
        percent: sourceSize > 0 ? Math.min(99, Math.round((fileStream.bytesRead / sourceSize) * 100)) : 0,
      });
    }
    const row = rowsRead + 1;
    const symbolIndex = headers.indexOf("symbol");
    const rowSymbol = values && symbolIndex >= 0 ? values[symbolIndex]?.trim() || null : null;
    const symbol = rowSymbol?.toUpperCase() ?? null;
    const validSymbol = symbol && outrightMesSymbol(symbol) && !symbol.includes("-") ? symbol : null;
    const state = validSymbol ? stateFor(validSymbol) : undefined;
    if (state) state.summary.totalRows += 1;
    if (!values || values.length !== headers.length) {
      reject(state, row, symbol, "MALFORMED_ROW");
      continue;
    }
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const timestampValue = record["ts_event"] || record["timestamp"] || record["event_time"] || "";
    const parsedTimestamp = validIsoTimestamp(timestampValue) ? Date.parse(timestampValue) : null;
    const date = parsedTimestamp === null || !state
      ? null
      : tradingDateForTimestamp(parsedTimestamp, state.calendar);
    if (!parsedTimestamp) {
      reject(state, row, symbol, "INVALID_ISO_TIMESTAMP");
      continue;
    }
    if (!validSymbol) {
      reject(undefined, row, symbol, symbol?.includes("-") ? "CALENDAR_SPREAD_REJECTED" : "NON_MES_OUTRIGHT_SYMBOL");
      continue;
    }
    if (!state) {
      reject(undefined, row, validSymbol, "INTERNAL_SYMBOL_STATE_UNAVAILABLE");
      continue;
    }
    if (filenameSymbol && filenameSymbol !== validSymbol) {
      reject(state, row, validSymbol, "FILENAME_SYMBOL_MISMATCH", date);
      continue;
    }
    const numericValues = ["open", "high", "low", "close", "volume"].map((key) => requiredNumber(record[key] ?? ""));
    if (numericValues.some((value) => value === null)) {
      reject(state, row, validSymbol, "NON_NUMERIC_OHLCV", date);
      continue;
    }
    const [open, high, low, close, volume] = numericValues as number[];
    if (high < open || high < close || high < low || low > open || low > close || low > high) {
      reject(state, row, validSymbol, "INVALID_OHLC_RELATIONSHIP", date);
      continue;
    }
    if (volume < 0) {
      reject(state, row, validSymbol, "NEGATIVE_VOLUME", date);
      continue;
    }
    if (parsedTimestamp % MINUTE !== 0) {
      reject(state, row, validSymbol, "MISALIGNED_MINUTE_TIMESTAMP", date);
      continue;
    }
    if (state.previousTimestamp !== null && parsedTimestamp < state.previousTimestamp) {
      reject(state, row, validSymbol, "OUT_OF_ORDER_TIMESTAMP", date);
      continue;
    }
    const candle: NormalizedCandle = {
      timestamp: parsedTimestamp,
      openTime: parsedTimestamp,
      closeTime: parsedTimestamp + MINUTE,
      open,
      high,
      low,
      close,
      volume,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      contractSymbol: validSymbol,
      isComplete: true,
      intervalMinutes: 1,
      quality: { valid: true, codes: ["MISSING_BID_ASK"] },
    };
    const existing = state.lastCandle?.timestamp === parsedTimestamp ? state.lastCandle : undefined;
    if (existing) {
      if (candleValuesEqual(existing, candle)) {
        state.summary.duplicateRowsRemoved += 1;
      } else {
        reject(state, row, validSymbol, "CONFLICTING_DUPLICATE_TIMESTAMP", date);
      }
      continue;
    }
    state.previousTimestamp = parsedTimestamp;
    state.lastCandle = candle;
    if (options.retainCandles !== false) state.candles.push(candle);
    if (state.streamingGapState) {
      addStreamingGapCandle(state.streamingGapState, candle, state.calendar);
      for (const interval of [5, 15, 60] as const) {
        if (!(options.aggregations ?? [5, 15, 60]).includes(interval)) continue;
        const bucket = Math.floor(candle.openTime / (interval * MINUTE));
        if (state.streamingAggregationBuckets.get(interval) !== bucket) {
          state.streamingAggregationBuckets.set(interval, bucket);
          const key = interval === 5 ? "fiveMinute" : interval === 15 ? "fifteenMinute" : "oneHour";
          state.streamingAggregationCounts[key] += 1;
        }
      }
    }
    const batch = pending.get(validSymbol) ?? [];
    batch.push(candle);
    pending.set(validSymbol, batch);
    if (batch.length >= (options.batchSize ?? 10_000) && options.onBatch) {
      await options.onBatch({ contractSymbol: validSymbol, candles: batch });
      flushCount += 1;
      pending.set(validSymbol, []);
    }
    state.summary.validRows += 1;
    state.summary.earliestTimestamp ??= new Date(parsedTimestamp).toISOString();
    state.summary.latestTimestamp = new Date(parsedTimestamp).toISOString();
    if (date && isTradingDate(date, state.calendar)) state.tradingDates.add(date);
    const session = state.fastSessionCache.get(Math.floor(parsedTimestamp / (60 * MINUTE)))
      ?? classifyFuturesSession(parsedTimestamp, state.calendar);
    state.fastSessionCache.set(Math.floor(parsedTimestamp / (60 * MINUTE)), session);
    if (session === "regular") state.summary.regularSessionCandleCount += 1;
    else if (overnightOwnerDate(parsedTimestamp, state.calendar)) state.summary.overnightCandleCount += 1;
  }
  if (!headers) throw new Error("CSV file is empty.");
  if (options.onBatch) {
    for (const [contractSymbol, batch] of pending) {
      if (!batch.length) continue;
      if (options.signal?.aborted) throw new Error("Historical CSV import was cancelled.");
      await options.onBatch({ contractSymbol, candles: batch });
      flushCount += 1;
    }
  }
  const contentFingerprint = options.contentFingerprint ?? contentHash.digest("hex");
  const imports = new Map<string, HistoricalCsvImport>();
  for (const [symbol, state] of [...states.entries()].sort(([first], [second]) => first.localeCompare(second))) {
    imports.set(symbol, finalizeBatchState(state, {
      analyzeCoverage: options.analyzeCoverage,
      aggregations: options.aggregations,
      contentFingerprint,
      retainCandles: options.retainCandles !== false,
    }));
  }
  return { imports, rejectedRows, rowsRead, flushCount };
}

/**
 * Merges fragment metadata without touching candle arrays. This is the
 * aggregation path used by bounded imports, where SQLite already owns the
 * normalized candles and the parser intentionally retained none in memory.
 */
export function mergeHistoricalCsvImportSummaries(
  fragments: readonly HistoricalCsvImportSummary[],
  specification: FuturesContractSpecification,
  calendar: FuturesSessionCalendar,
  contentFingerprint: string,
): HistoricalCsvImport {
  if (!fragments.length) throw new Error("At least one historical CSV summary is required.");
  const first = fragments[0];
  const sum = (selector: (summary: HistoricalCsvImportSummary) => number): number =>
    fragments.reduce((total, summary) => total + selector(summary), 0);
  const union = (selector: (summary: HistoricalCsvImportSummary) => readonly string[]): string[] =>
    [...new Set(fragments.flatMap(selector))].sort();
  const earliest = fragments
    .map((summary) => summary.earliestTimestamp)
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? null;
  const latest = fragments
    .map((summary) => summary.latestTimestamp)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const rejectionReasons = Object.fromEntries(
    fragments.flatMap((summary) => Object.entries(summary.rejectionReasons))
      .reduce((counts, [reason, count]) => counts.set(reason, (counts.get(reason) ?? 0) + count), new Map<string, number>()),
  );
  const errors = fragments.flatMap((summary) => summary.errors).slice(0, MAX_REPORTED_ERRORS);
  const untrustedTradingDates = Object.fromEntries(
    [...fragments.flatMap((summary) => Object.entries(summary.untrustedTradingDates ?? {}))
      .reduce((dates, [date, reasons]) => {
        const current = dates.get(date) ?? new Set<string>();
        for (const reason of reasons) current.add(reason);
        dates.set(date, current);
        return dates;
      }, new Map<string, Set<string>>()).entries()]
      .map(([date, reasons]) => [date, [...reasons].sort()]),
  );
  const summary: HistoricalCsvImportSummary = {
    ...first,
    filename: fragments.map((fragment) => fragment.filename).sort().join(","),
    detectedSymbol: fragments.map((fragment) => fragment.detectedSymbol).find(Boolean) ?? null,
    earliestTimestamp: earliest,
    latestTimestamp: latest,
    totalRows: sum((item) => item.totalRows),
    validRows: sum((item) => item.validRows),
    rejectedRows: sum((item) => item.rejectedRows),
    duplicateRowsRemoved: sum((item) => item.duplicateRowsRemoved),
    missingMinuteGaps: sum((item) => item.missingMinuteGaps),
    missingGapSegments: sum((item) => item.missingGapSegments),
    unexpectedMissingMinutes: sum((item) => item.unexpectedMissingMinutes),
    unexpectedOpenSessionMissingMinutes: sum((item) => item.unexpectedOpenSessionMissingMinutes),
    unexpectedOvernightMissingMinutes: sum((item) => item.unexpectedOvernightMissingMinutes),
    unexpectedRegularSessionMissingMinutes: sum((item) => item.unexpectedRegularSessionMissingMinutes),
    regularSessionGapSegments: sum((item) => item.regularSessionGapSegments),
    overnightGapSegments: sum((item) => item.overnightGapSegments),
    regularSessionMissingMinutes: sum((item) => item.regularSessionMissingMinutes),
    expectedClosedMarketMinutes: sum((item) => item.expectedClosedMarketMinutes),
    expectedClosedMinutes: sum((item) => item.expectedClosedMinutes),
    weekendHolidayClosedMinutes: sum((item) => item.weekendHolidayClosedMinutes),
    earlyCloseMinutes: sum((item) => item.earlyCloseMinutes),
    inactiveContractMinutes: sum((item) => item.inactiveContractMinutes),
    lowLiquidityInactiveMinutes: sum((item) => item.lowLiquidityInactiveMinutes),
    inactiveContractDays: union((item) => item.missingRegularSessionDates).length,
    missingRegularSessionDates: union((item) => item.missingRegularSessionDates),
    missingOvernightSessionDates: union((item) => item.missingOvernightSessionDates),
    completeRegularSessionDates: union((item) => item.completeRegularSessionDates),
    maintenanceGapMinutes: sum((item) => item.maintenanceGapMinutes),
    weekendHolidayGapMinutes: sum((item) => item.weekendHolidayGapMinutes),
    earlyCloseDates: union((item) => item.earlyCloseDates),
    overnightCoverageObserved: fragments.some((item) => item.overnightCoverageObserved),
    regularSessionCandleCount: sum((item) => item.regularSessionCandleCount),
    overnightCandleCount: sum((item) => item.overnightCandleCount),
    availableTradingDates: union((item) => item.availableTradingDates),
    rejectionReasons,
    errors,
    untrustedTradingDates,
    aggregationCounts: {
      oneMinute: sum((item) => item.aggregationCounts.oneMinute),
      fiveMinute: sum((item) => item.aggregationCounts.fiveMinute),
      fifteenMinute: sum((item) => item.aggregationCounts.fifteenMinute),
      oneHour: sum((item) => item.aggregationCounts.oneHour),
    },
  };
  return {
    summary,
    contentFingerprint,
    oneMinute: [],
    fiveMinute: [],
    fifteenMinute: [],
    oneHour: [],
    specification,
    calendar,
  };
}

/**
 * Deterministically joins fragments of one contract.  Fragments may overlap
 * (the Databento download API commonly emits adjacent/overlapping pages), but
 * disagreement at an event timestamp is never silently resolved.
 */
export function mergeHistoricalCsvImports(
  fragments: readonly HistoricalCsvImport[],
): HistoricalCsvImport {
  if (!fragments.length) throw new Error("At least one historical CSV import is required.");
  const first = fragments[0];
  for (const fragment of fragments) {
    if (fragment.specification.fullContractSymbol !== first.specification.fullContractSymbol) {
      throw new Error("Historical CSV fragments must belong to the same contract.");
    }
    if (fragment.summary.detectedSymbol && first.summary.detectedSymbol
      && fragment.summary.detectedSymbol !== first.summary.detectedSymbol) {
      throw new Error("Historical CSV fragments contain incompatible symbols.");
    }
  }
  const byTimestamp = new Map<number, NormalizedCandle>();
  let duplicateRowsRemoved = 0;
  for (const fragment of fragments) {
    for (const candle of fragment.oneMinute) {
      const existing = byTimestamp.get(candle.openTime);
      if (!existing) {
        byTimestamp.set(candle.openTime, candle);
      } else if (candleValuesEqual(existing, candle)) {
        duplicateRowsRemoved += 1;
      } else {
        throw new Error(`Conflicting OHLCV rows at timestamp ${new Date(candle.openTime).toISOString()}.`);
      }
    }
  }
  const oneMinute = [...byTimestamp.values()].sort((a, b) => a.openTime - b.openTime);
  const fiveMinute = aggregate(oneMinute, 5, first.specification);
  const fifteenMinute = aggregate(oneMinute, 15, first.specification);
  const oneHour = aggregate(oneMinute, 60, first.specification);
  const summary: HistoricalCsvImportSummary = {
    ...first.summary,
    filename: fragments.map((fragment) => fragment.summary.filename).sort().join(","),
    detectedSymbol: first.summary.detectedSymbol
      ?? fragments.map((fragment) => fragment.summary.detectedSymbol).find(Boolean)
      ?? null,
    totalRows: fragments.reduce((sum, fragment) => sum + fragment.summary.totalRows, 0),
    validRows: oneMinute.length,
    rejectedRows: fragments.reduce((sum, fragment) => sum + fragment.summary.rejectedRows, 0),
    duplicateRowsRemoved: fragments.reduce((sum, fragment) => sum + fragment.summary.duplicateRowsRemoved, 0)
      + duplicateRowsRemoved,
    rejectionReasons: Object.fromEntries(
      fragments.flatMap((fragment) => Object.entries(fragment.summary.rejectionReasons))
        .reduce((counts, [reason, count]) => counts.set(reason, (counts.get(reason) ?? 0) + count), new Map<string, number>()),
    ),
    errors: fragments.flatMap((fragment) => fragment.summary.errors).slice(0, MAX_REPORTED_ERRORS),
    untrustedTradingDates: Object.fromEntries(
      [...fragments.flatMap((fragment) => Object.entries(fragment.summary.untrustedTradingDates ?? {}))
        .reduce((dates, [date, reasons]) => {
          const current = dates.get(date) ?? new Set<string>();
          for (const reason of reasons) current.add(reason);
          dates.set(date, current);
          return dates;
        }, new Map<string, Set<string>>()).entries()]
        .map(([date, reasons]) => [date, [...reasons]]),
    ),
    aggregationCounts: {
      oneMinute: oneMinute.length,
      fiveMinute: fiveMinute.length,
      fifteenMinute: fifteenMinute.length,
      oneHour: oneHour.length,
    },
  };
  summary.earliestTimestamp = oneMinute[0] ? new Date(oneMinute[0].openTime).toISOString() : null;
  summary.latestTimestamp = oneMinute.at(-1) ? new Date(oneMinute.at(-1)!.openTime).toISOString() : null;
  const tradingDates = new Set<string>();
  summary.regularSessionCandleCount = 0;
  summary.overnightCandleCount = 0;
  for (const candle of oneMinute) {
    const date = tradingDateForTimestamp(candle.openTime, first.calendar);
    if (isTradingDate(date, first.calendar)) tradingDates.add(date);
    const session = classifyFuturesSession(candle.openTime, first.calendar);
    if (session === "regular") summary.regularSessionCandleCount += 1;
    else if (overnightOwnerDate(candle.openTime, first.calendar)) summary.overnightCandleCount += 1;
  }
  Object.assign(summary, countSessionAwareGaps(oneMinute, first.calendar));
  summary.availableTradingDates = [...tradingDates].sort();
  const contentFingerprint = fragments
    .map((fragment) => `${fragment.summary.filename}:${fragment.contentFingerprint}`)
    .sort()
    .join("|");
  return {
    summary,
    contentFingerprint,
    oneMinute,
    fiveMinute,
    fifteenMinute,
    oneHour,
    specification: first.specification,
    calendar: first.calendar,
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
  if (filePath) unsupportedCompression(filePath);
  const resolvedPath = filePath ? boundedCsvPath(filePath) : await resolveImportPath();
  const hash = createHash("sha256");
  const stream = createReadStream(resolvedPath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}