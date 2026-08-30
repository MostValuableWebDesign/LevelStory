import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import {
  getFuturesContractSpecification,
  type FuturesContractSpecification,
} from "./contracts.js";
import {
  getHistoricalCsvFingerprint,
  importHistoricalCsv,
  countSessionAwareGaps,
  type HistoricalCsvImport,
  type HistoricalCsvImportSummary,
} from "./historical-csv-import.js";
import {
  sessionCalendarForContract,
  tradingDateForTimestamp,
  isTradingDate,
  DEFAULT_FUTURES_SESSION_CALENDAR,
  type FuturesSessionCalendar,
} from "./session-calendar.js";
import type { CausalReplayDataset, BacktestGapReport, IntrabarBar } from "../phase9.js";
import type { SimulatedFuturesCandle } from "./simulated-feed.js";
import type { NormalizedCandle } from "./market-data-provider.js";

const DAY = 86_400_000;
const CONTRACT_FILE = /\.((?:MES)[FGHJKMNQUVXZ]\d{1,2})(?:_\d+)?\.csv$/i;
const SPREAD_FILE = /\.MES[A-Z]\d{1,2}-MES[A-Z]\d{1,2}(?:_\d+)?\.csv$/i;
const execFileAsync = promisify(execFile);

export const MULTI_CONTRACT_SOURCE = "historical_databento_multicontract" as const;
export const MES_ROLLOVER_SCHEDULE_VERSION = "MES_QUARTERLY_2026_01" as const;
export const MULTI_CONTRACT_IMPORTER_VERSION = "multi-contract-index-v3" as const;

const MONTH_CODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"] as const;
const MONTH_BY_CODE = new Map(MONTH_CODES.map((code, index) => [code, index + 1]));

/**
 * This schedule is intentionally explicit and versioned. It is a modeling
 * input for deterministic research replay, not an exchange-authoritative
 * rollover recommendation.
 */
export const MES_ROLLOVER_SCHEDULE = [
  { effectiveDate: "2025-08-27", contractSymbol: "MESU5" },
  { effectiveDate: "2025-09-11", contractSymbol: "MESZ5" },
  { effectiveDate: "2025-12-11", contractSymbol: "MESH6" },
  { effectiveDate: "2026-03-12", contractSymbol: "MESM6" },
  { effectiveDate: "2026-06-11", contractSymbol: "MESU6" },
] as const;

export type MesContractIdentity = {
  rootSymbol: "MES";
  contractSymbol: string;
  monthCode: (typeof MONTH_CODES)[number];
  contractMonth: string;
  year: number;
  quarter: number;
};

export type RolloverBoundary = {
  effectiveDate: string;
  fromContractSymbol: string | null;
  toContractSymbol: string;
  scheduleVersion: typeof MES_ROLLOVER_SCHEDULE_VERSION;
};

export type MultiContractFileSummary = {
  filename: string;
  contractSymbol: string;
  contractMonth: string;
  contentFingerprint: string;
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  availableTradingDates: string[];
  activeSelectedDates: string[];
  selected: boolean;
  status: "accepted" | "inactive" | "rejected" | "duplicate";
  rejectionReason: string | null;
  coverageStatus: "calculated" | "not_calculated";
  regularSessionCandleCount: number | null;
  overnightCandleCount: number | null;
  missingMinuteGaps: number | null;
  missingGapSegments: number | null;
  unexpectedMissingMinutes: number | null;
  regularSessionMissingMinutes: number | null;
  inactiveContractMinutes: number | null;
  missingRegularSessionDates: string[] | null;
  completeRegularSessionDates: string[] | null;
  activePeriod: {
    firstDate: string | null;
    lastDate: string | null;
    sufficient: boolean;
    reason: string | null;
  };
};

export type MultiContractEligibility = {
  tradingDate: string;
  scheduledContractSymbol: string | null;
  scheduleVersion: typeof MES_ROLLOVER_SCHEDULE_VERSION;
  rolloverReason: string;
  status:
    | "eligible"
    | "missing_scheduled_file"
    | "no_scheduled_contract_candles"
    | "insufficient_rth_coverage"
    | "invalid_or_rejected_source_data"
    | "duplicate_or_overlapping_active_contract_data"
    | "no_scheduled_contract";
  coverageStatus:
    | "eligible"
    | "missing_scheduled_file"
    | "no_scheduled_contract_candles"
    | "insufficient_rth_coverage"
    | "invalid_or_rejected_source_data"
    | "duplicate_or_overlapping_active_contract_data"
    | "outside_configured_rollover_schedule";
  reason: string | null;
  observedInAnyFile: boolean;
  scheduledContractFileAvailable: boolean;
  scheduledContractDataAvailable: boolean;
  availableOnContract: boolean;
  regularSessionComplete: boolean;
  backtestEligible: boolean;
};

export type MultiContractIndexState = "not_started" | "indexing" | "ready" | "failed";

export type MultiContractIndexStatus = {
  state: MultiContractIndexState;
  indexKey: string | null;
  progress: number;
  discoveredFileCount: number;
  indexedFileCount: number;
  message: string | null;
  error: string | null;
  updatedAt: string;
};

export type HistoricalMultiContractImportSummary = Omit<
  HistoricalCsvImportSummary,
  "source" | "filename" | "detectedSymbol" | "coverageScope"
> & {
  source: typeof MULTI_CONTRACT_SOURCE;
  filename: string;
  detectedSymbol: string | null;
  coverageScope: "multi_contract";
  scheduleVersion: typeof MES_ROLLOVER_SCHEDULE_VERSION;
  acceptedContracts: string[];
  inactiveContracts: string[];
  rejectedFiles: Array<{ filename: string; reason: string }>;
  files: MultiContractFileSummary[];
  rolloverBoundaries: RolloverBoundary[];
  activeContractByDate: Array<{ tradingDate: string; contractSymbol: string }>;
  eligibleTradingDates: string[];
  ineligibleDates: MultiContractEligibility[];
  allObservedTradingDates: string[];
  ineligibleObservedDates: MultiContractEligibility[];
  dateEligibility: MultiContractEligibility[];
  acceptedOutrightFileCount: number;
  scheduledActiveContractCount: number;
  inactiveFutureContractCount: number;
  rejectedSpreadOrDuplicateFileCount: number;
  missingScheduledContractFileCount: number;
  allObservedDateCount: number;
  eligibleScheduledReplayDateCount: number;
  ineligibleObservedDateCount: number;
  ineligibleScheduledDateCount: number;
  coverageReconciles: boolean;
  indexingState: "ready";
  indexKey: string;
  importerVersion: typeof MULTI_CONTRACT_IMPORTER_VERSION;
  indexedAt: string;
};

export type HistoricalMultiContractImport = {
  summary: HistoricalMultiContractImportSummary;
  contentFingerprint: string;
  contracts: ReadonlyMap<string, HistoricalCsvImport>;
  specification: FuturesContractSpecification;
  calendar: FuturesSessionCalendar;
};

export function parseMesContractSymbol(value: string): MesContractIdentity | null {
  const normalized = value.trim().toUpperCase();
  const match = /^(MES)([FGHJKMNQUVXZ])(\d{1,2})$/.exec(normalized);
  if (!match) return null;
  const monthCode = match[2] as MesContractIdentity["monthCode"];
  const month = MONTH_BY_CODE.get(monthCode);
  if (!month) return null;
  const yearToken = match[3];
  const year = yearToken.length === 1 ? 2020 + Number(yearToken) : 2000 + Number(yearToken);
  if (year < 2000 || year > 2099) return null;
  return {
    rootSymbol: "MES",
    contractSymbol: normalized,
    monthCode,
    contractMonth: `${year}-${String(month).padStart(2, "0")}`,
    year,
    quarter: Math.ceil(month / 3),
  };
}

export function compareMesContractSymbols(first: string, second: string): number {
  const left = parseMesContractSymbol(first);
  const right = parseMesContractSymbol(second);
  if (!left || !right) return first.localeCompare(second);
  return left.contractMonth.localeCompare(right.contractMonth) || left.contractSymbol.localeCompare(right.contractSymbol);
}

export function contractSpecificationForMesSymbol(symbol: string): FuturesContractSpecification {
  const identity = parseMesContractSymbol(symbol);
  if (!identity) throw new Error(`Unknown MES contract symbol "${symbol}".`);
  const base = getFuturesContractSpecification("MES");
  return {
    ...base,
    fullContractSymbol: identity.contractSymbol,
    contractMonth: identity.contractMonth,
    rolloverDate: MES_ROLLOVER_SCHEDULE.find((item) => item.contractSymbol === identity.contractSymbol)?.effectiveDate
      ?? base.rolloverDate,
    regularSessionHours: { ...base.regularSessionHours },
  };
}

export function scheduledMesContractForDate(tradingDate: string): string | null {
  let selected: string | null = null;
  for (const item of MES_ROLLOVER_SCHEDULE) {
    if (tradingDate >= item.effectiveDate) selected = item.contractSymbol;
    else break;
  }
  return selected;
}

export function buildRolloverBoundaries(): RolloverBoundary[] {
  return MES_ROLLOVER_SCHEDULE.map((item, index) => ({
    effectiveDate: item.effectiveDate,
    fromContractSymbol: MES_ROLLOVER_SCHEDULE[index - 1]?.contractSymbol ?? null,
    toContractSymbol: item.contractSymbol,
    scheduleVersion: MES_ROLLOVER_SCHEDULE_VERSION,
  }));
}

function assetDirectories(): string[] {
  return [
    join(process.cwd(), "attached_assets"),
    join(process.cwd(), "..", "attached_assets"),
    join(process.cwd(), "..", "..", "attached_assets"),
  ];
}

async function resolveMultiContractFiles(): Promise<{
  accepted: Array<{ filename: string; contractSymbol: string; path: string }>;
  rejectedFiles: Array<{ filename: string; reason: string }>;
}> {
  const allNames = new Set<string>();
  const availableDirectories = new Map<string, Set<string>>();
  for (const directory of assetDirectories()) {
    try {
      const files = new Set(await readdir(directory));
      availableDirectories.set(directory, files);
      for (const file of files) allNames.add(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // The supplied archive remains the source of truth for rejected spread
  // inventory, while only extracted outright files are ever opened.
  for (const directory of assetDirectories()) {
    const archive = join(directory, "GLBX-20260828-J97RW6Q77A_1787916207144.zip");
    try {
      const listing = await execFileAsync("unzip", ["-Z1", archive]);
      for (const file of listing.stdout.split(/\r?\n/).map((item) => basename(item.trim())).filter(Boolean)) {
        if (file.endsWith(".csv")) allNames.add(file);
      }
      break;
    } catch {
      // An extracted server-side fixture is still sufficient when the archive
      // is unavailable in a deployment.
    }
  }
  const rejectedFiles: Array<{ filename: string; reason: string }> = [];
  const candidates = [...allNames]
    .filter((file) => file.endsWith(".csv"))
    .filter((file) => file.startsWith("glbx-mdp3-"))
    .sort();
  const byContract = new Map<string, string>();
  for (const filename of candidates) {
    if (SPREAD_FILE.test(filename)) {
      rejectedFiles.push({ filename, reason: "CALENDAR_SPREAD_REJECTED" });
      continue;
    }
    const match = CONTRACT_FILE.exec(filename);
    if (!match) {
      rejectedFiles.push({ filename, reason: "UNKNOWN_OR_MALFORMED_CONTRACT" });
      continue;
    }
    const contractSymbol = match[1].toUpperCase();
    if (!parseMesContractSymbol(contractSymbol)) {
      rejectedFiles.push({ filename, reason: "UNKNOWN_OR_MALFORMED_CONTRACT" });
      continue;
    }
    const previous = byContract.get(contractSymbol);
    if (previous) {
      // Prefer the canonical archive filename over a duplicate upload suffix.
      if (filename.includes(`.${contractSymbol}.csv`) && !previous.includes(`.${contractSymbol}.csv`)) {
        rejectedFiles.push({ filename: previous, reason: "DUPLICATE_CONTRACT_FILE" });
        byContract.set(contractSymbol, filename);
      } else {
        rejectedFiles.push({ filename, reason: "DUPLICATE_CONTRACT_FILE" });
      }
      continue;
    }
    byContract.set(contractSymbol, filename);
  }
  const directory = assetDirectories().find((candidate) => {
    const files = availableDirectories.get(candidate);
    return files && [...byContract.values()].every((file) => files.has(file));
  }) ?? assetDirectories()[0];
  const accepted = [...byContract.entries()]
    .sort(([first], [second]) => compareMesContractSymbols(first, second))
    .map(([contractSymbol, filename]) => ({ filename, contractSymbol, path: join(directory, filename) }));
  return { accepted, rejectedFiles };
}

function emptyAggregate(): Omit<HistoricalMultiContractImportSummary, "source" | "filename" | "detectedSymbol" | "coverageScope" | "scheduleVersion" | "acceptedContracts" | "inactiveContracts" | "rejectedFiles" | "files" | "rolloverBoundaries" | "activeContractByDate" | "eligibleTradingDates" | "ineligibleDates" | "allObservedTradingDates" | "ineligibleObservedDates" | "dateEligibility" | "acceptedOutrightFileCount" | "scheduledActiveContractCount" | "inactiveFutureContractCount" | "rejectedSpreadOrDuplicateFileCount" | "missingScheduledContractFileCount" | "allObservedDateCount" | "eligibleScheduledReplayDateCount" | "ineligibleObservedDateCount" | "ineligibleScheduledDateCount" | "coverageReconciles" | "indexingState" | "indexKey" | "importerVersion" | "indexedAt"> {
  return {
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
}

function aggregateSummaries(summaries: HistoricalCsvImportSummary[]): ReturnType<typeof emptyAggregate> {
  const result = emptyAggregate();
  const dateSets = {
    missingRegularSessionDates: new Set<string>(),
    missingOvernightSessionDates: new Set<string>(),
    completeRegularSessionDates: new Set<string>(),
    earlyCloseDates: new Set<string>(),
    availableTradingDates: new Set<string>(),
  };
  for (const summary of summaries) {
    for (const key of [
      "totalRows", "validRows", "rejectedRows", "duplicateRowsRemoved", "missingMinuteGaps",
      "missingGapSegments", "unexpectedMissingMinutes", "unexpectedOpenSessionMissingMinutes",
      "unexpectedOvernightMissingMinutes", "unexpectedRegularSessionMissingMinutes",
      "regularSessionGapSegments", "overnightGapSegments", "regularSessionMissingMinutes",
      "expectedClosedMarketMinutes", "expectedClosedMinutes", "weekendHolidayClosedMinutes",
      "earlyCloseMinutes", "inactiveContractMinutes", "lowLiquidityInactiveMinutes",
      "inactiveContractDays", "maintenanceGapMinutes", "weekendHolidayGapMinutes",
      "regularSessionCandleCount", "overnightCandleCount",
    ] as const) result[key] += summary[key];
    result.earliestTimestamp = !result.earliestTimestamp || (summary.earliestTimestamp && summary.earliestTimestamp < result.earliestTimestamp)
      ? summary.earliestTimestamp : result.earliestTimestamp;
    result.latestTimestamp = !result.latestTimestamp || (summary.latestTimestamp && summary.latestTimestamp > result.latestTimestamp)
      ? summary.latestTimestamp : result.latestTimestamp;
    result.overnightCoverageObserved ||= summary.overnightCoverageObserved;
    for (const [key, target] of Object.entries(dateSets) as Array<[keyof typeof dateSets, Set<string>]>) {
      for (const date of summary[key]) target.add(date);
    }
    for (const [key, count] of Object.entries(summary.rejectionReasons)) {
      result.rejectionReasons[key] = (result.rejectionReasons[key] ?? 0) + count;
    }
    result.errors.push(...summary.errors.map((error) => ({ ...error, row: error.row })));
  }
  result.errors = result.errors.slice(0, 25);
  result.missingRegularSessionDates = [...dateSets.missingRegularSessionDates].sort();
  result.missingOvernightSessionDates = [...dateSets.missingOvernightSessionDates].sort();
  result.completeRegularSessionDates = [...dateSets.completeRegularSessionDates].sort();
  result.earlyCloseDates = [...dateSets.earlyCloseDates].sort();
  result.availableTradingDates = [...dateSets.availableTradingDates].sort();
  return result;
}

function selectedDatesInRange(dates: string[], startDate: string, endDate: string, count: number): string[] {
  const requested = dates.filter((date) => date >= startDate && date <= endDate);
  if (requested.length < count) {
    throw new Error(`Multi-contract historical range contains ${requested.length} trading dates; ${count} are required.`);
  }
  return requested.slice(-count);
}

function toReplayCandle(candle: SimulatedFuturesCandle | HistoricalCsvImport["oneMinute"][number]): SimulatedFuturesCandle {
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

function selectedGapReport(
  candles: readonly SimulatedFuturesCandle[],
  normalizedOneMinute: readonly NormalizedCandle[],
): BacktestGapReport {
  const analyzed = countSessionAwareGaps(normalizedOneMinute, sessionCalendarForContract(getFuturesContractSpecification("MES")));
  return {
    ...analyzed,
    coverageScope: "selected_dates",
  };
}

export function multiContractImportToReplayDataset(
  imported: HistoricalMultiContractImport,
  startDate: string,
  endDate: string,
  inSampleDays: number,
  outOfSampleDays: number,
  selectedDatesOverride?: readonly string[],
): CausalReplayDataset {
  const eligibleDates = imported.summary.eligibleTradingDates;
  const requestedDates = eligibleDates.filter((date) => date >= startDate && date <= endDate);
  const requiredDates = inSampleDays + outOfSampleDays;
  const exactDates = selectedDatesOverride ? [...new Set(selectedDatesOverride)].sort() : null;
  if (exactDates) {
    const eligibilityByDate = new Map(
      (imported.summary.ineligibleDates ?? []).map((item) => [item.tradingDate, item]),
    );
    const unavailable = exactDates.filter((date) => !requestedDates.includes(date));
    if (unavailable.length) {
      const details = unavailable.map((date) => {
        const reason = eligibilityByDate.get(date)?.reason ?? "DATE_OUTSIDE_ELIGIBLE_HISTORY";
        return `${date} (${reason})`;
      });
      throw new Error(`Selected historical dates are not eligible: ${details.join(", ")}.`);
    }
    if (exactDates.length < requiredDates) {
      throw new Error(`Historical range contains ${exactDates.length} eligible selected trading dates; ${requiredDates} are required.`);
    }
  }
  const selectedDates = exactDates ?? selectedDatesInRange(
    eligibleDates,
    startDate,
    endDate,
    requiredDates,
  );
  const selectedDateSet = new Set(selectedDates);
  const activeContractByDate = selectedDates.map((tradingDate) => ({
    tradingDate,
    contractSymbol: scheduledMesContractForDate(tradingDate) ?? "",
  }));
  const candles: SimulatedFuturesCandle[] = [];
  const oneMinute: IntrabarBar[] = [];
  const normalizedSelectedOneMinute: NormalizedCandle[] = [];
  const activeSelectedDates = new Map<string, string[]>();
  const oneMinuteByContractDate = new Map<string, Map<string, NormalizedCandle[]>>();
  const fiveMinuteByContractDate = new Map<string, Map<string, SimulatedFuturesCandle[]>>();
  for (const item of activeContractByDate) {
    if (!item.contractSymbol) {
      throw new Error(`No MES contract is scheduled for eligible date ${item.tradingDate}.`);
    }
    const contract = imported.contracts.get(item.contractSymbol);
    if (!contract) throw new Error(`Rollover schedule selects ${item.contractSymbol}, but that contract file is unavailable.`);
    const calendar = contract.calendar;
    if (!oneMinuteByContractDate.has(item.contractSymbol)) {
      const oneMinuteByDate = new Map<string, NormalizedCandle[]>();
      for (const candle of contract.oneMinute) {
        const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
        if (!selectedDateSet.has(tradingDate)) continue;
        const dateCandles = oneMinuteByDate.get(tradingDate) ?? [];
        dateCandles.push(candle);
        oneMinuteByDate.set(tradingDate, dateCandles);
      }
      oneMinuteByContractDate.set(item.contractSymbol, oneMinuteByDate);
      const fiveMinuteByDate = new Map<string, SimulatedFuturesCandle[]>();
      for (const candle of contract.fiveMinute) {
        const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
        if (!selectedDateSet.has(tradingDate) || !candle.isComplete) continue;
        const dateCandles = fiveMinuteByDate.get(tradingDate) ?? [];
        dateCandles.push(toReplayCandle(candle));
        fiveMinuteByDate.set(tradingDate, dateCandles);
      }
      fiveMinuteByContractDate.set(item.contractSymbol, fiveMinuteByDate);
    }
    const selected = oneMinuteByContractDate.get(item.contractSymbol)?.get(item.tradingDate) ?? [];
    if (!selected.length) {
      throw new Error(`Scheduled contract ${item.contractSymbol} has no eligible one-minute candles for ${item.tradingDate}.`);
    }
    if (selected.length) {
      const regularFiveMinute = fiveMinuteByContractDate.get(item.contractSymbol)?.get(item.tradingDate) ?? [];
      if (!regularFiveMinute.length) {
        throw new Error(`Scheduled contract ${item.contractSymbol} has no completed replay candles for ${item.tradingDate}.`);
      }
      candles.push(...regularFiveMinute);
      oneMinute.push(...selected.map((candle) => ({
        openTime: candle.openTime,
        closeTime: candle.closeTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        source: "one-minute" as const,
        sequenceKnown: false,
      })));
      normalizedSelectedOneMinute.push(...selected);
      activeSelectedDates.set(item.contractSymbol, [...(activeSelectedDates.get(item.contractSymbol) ?? []), item.tradingDate]);
    }
  }
  if (!candles.length) throw new Error("The multi-contract rollover schedule produced no selected candles.");
  return {
    candles: candles.sort((first, second) => first.closeTime - second.closeTime),
    oneMinute: oneMinute.sort((first, second) => first.openTime - second.openTime),
    contractSymbol: activeContractByDate.at(-1)?.contractSymbol ?? imported.summary.acceptedContracts.at(-1)!,
    contractMonth: "multi-contract",
    inSampleDates: selectedDates.slice(0, inSampleDays),
    outOfSampleDates: selectedDates.slice(-outOfSampleDays),
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    selectedDates,
    excludedDates: eligibleDates.filter((date) => date >= startDate && date <= endDate && !selectedDateSet.has(date)),
    source: MULTI_CONTRACT_SOURCE,
    contentFingerprint: imported.contentFingerprint,
    quotesAvailable: false,
    gapReport: selectedGapReport(candles, normalizedSelectedOneMinute),
    contractSchedule: {
      version: MES_ROLLOVER_SCHEDULE_VERSION,
      activeContractByDate,
      boundaries: buildRolloverBoundaries(),
    },
  };
}

const INDEX_CACHE_PATH = join(process.cwd(), ".cache", "levelstory-multi-contract-index.json");

type MultiContractIdentity = {
  resolved: Awaited<ReturnType<typeof resolveMultiContractFiles>>;
  fingerprints: string[];
  contentFingerprint: string;
  indexKey: string;
};

type PersistedMultiContractIndex = {
  indexKey: string;
  contentFingerprint: string;
  summary: HistoricalMultiContractImportSummary;
  contracts: Array<{ contractSymbol: string; imported: HistoricalCsvImport }>;
};

let cachedImport: { indexKey: string; value: HistoricalMultiContractImport } | null = null;
let importPromise: Promise<HistoricalMultiContractImport> | null = null;
let activeIndexKey: string | null = null;
let indexStatus: MultiContractIndexStatus = {
  state: "not_started",
  indexKey: null,
  progress: 0,
  discoveredFileCount: 0,
  indexedFileCount: 0,
  message: "Historical MES index has not been started.",
  error: null,
  updatedAt: new Date(0).toISOString(),
};

function updateIndexStatus(update: Partial<MultiContractIndexStatus>): void {
  indexStatus = { ...indexStatus, ...update, updatedAt: new Date().toISOString() };
}

async function resolveMultiContractIdentity(): Promise<MultiContractIdentity> {
  const resolved = await resolveMultiContractFiles();
  if (resolved.accepted.length === 0) {
    throw new Error("No uploaded outright MES contract CSVs were found in attached_assets.");
  }
  const fingerprints = await Promise.all(
    resolved.accepted.map((file) => getHistoricalCsvFingerprint(file.path)),
  );
  const contentFingerprint = resolved.accepted
    .map((file, index) => `${file.filename}:${file.contractSymbol}:${fingerprints[index]}`)
    .join("|");
  const indexKey = createHash("sha256").update(JSON.stringify({
    source: MULTI_CONTRACT_SOURCE,
    rootSymbol: "MES",
    scheduleVersion: MES_ROLLOVER_SCHEDULE_VERSION,
    sessionCalendarVersion: DEFAULT_FUTURES_SESSION_CALENDAR.calendarVersion,
    importerVersion: MULTI_CONTRACT_IMPORTER_VERSION,
    files: resolved.accepted.map((file, index) => ({
      filename: file.filename,
      contractSymbol: file.contractSymbol,
      fingerprint: fingerprints[index],
    })),
    rejectedFiles: resolved.rejectedFiles,
  })).digest("hex");
  return { resolved, fingerprints, contentFingerprint, indexKey };
}

function dateRange(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  for (
    let cursor = Date.parse(`${startDate}T12:00:00Z`);
    cursor <= Date.parse(`${endDate}T12:00:00Z`);
    cursor += DAY
  ) {
    result.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return result;
}

function rolloverContextForDate(tradingDate: string): {
  scheduledContractSymbol: string | null;
  rolloverReason: string;
} {
  let selectedIndex = -1;
  for (const [index, item] of MES_ROLLOVER_SCHEDULE.entries()) {
    if (tradingDate >= item.effectiveDate) selectedIndex = index;
    else break;
  }
  if (selectedIndex < 0) {
    return {
      scheduledContractSymbol: null,
      rolloverReason: `Outside the configured ${MES_ROLLOVER_SCHEDULE_VERSION} schedule before ${MES_ROLLOVER_SCHEDULE[0]?.effectiveDate ?? "the first effective date"}.`,
    };
  }
  const selected = MES_ROLLOVER_SCHEDULE[selectedIndex];
  const previous = MES_ROLLOVER_SCHEDULE[selectedIndex - 1];
  return {
    scheduledContractSymbol: selected.contractSymbol,
    rolloverReason: previous
      ? `Rollover effective ${selected.effectiveDate}: ${previous.contractSymbol} → ${selected.contractSymbol}.`
      : `Initial scheduled contract effective ${selected.effectiveDate}: ${selected.contractSymbol}.`,
  };
}

export function buildMultiContractDateEligibility(
  importedContracts: ReadonlyMap<string, HistoricalCsvImport>,
  uploadedDates: readonly string[],
  calendar: FuturesSessionCalendar,
): MultiContractEligibility[] {
  const firstDate = uploadedDates[0];
  const lastDate = uploadedDates.at(-1);
  if (!firstDate || !lastDate) return [];
  const result: MultiContractEligibility[] = [];
  for (const tradingDate of dateRange(firstDate, lastDate)) {
    if (!isTradingDate(tradingDate, calendar)) continue;
    const schedule = rolloverContextForDate(tradingDate);
    const scheduledContractSymbol = schedule.scheduledContractSymbol;
    if (!scheduledContractSymbol) {
      result.push({
        tradingDate,
        scheduledContractSymbol: null,
        scheduleVersion: MES_ROLLOVER_SCHEDULE_VERSION,
        rolloverReason: schedule.rolloverReason,
        status: "no_scheduled_contract",
        coverageStatus: "outside_configured_rollover_schedule",
        reason: "NO_SCHEDULED_MES_CONTRACT",
        observedInAnyFile: uploadedDates.includes(tradingDate),
        scheduledContractFileAvailable: false,
        scheduledContractDataAvailable: false,
        availableOnContract: false,
        regularSessionComplete: false,
        backtestEligible: false,
      });
      continue;
    }
    const contract = importedContracts.get(scheduledContractSymbol);
    if (!contract) {
      result.push({
        tradingDate,
        scheduledContractSymbol,
        scheduleVersion: MES_ROLLOVER_SCHEDULE_VERSION,
        rolloverReason: schedule.rolloverReason,
        status: "missing_scheduled_file",
        coverageStatus: "missing_scheduled_file",
        reason: `MISSING_SCHEDULED_CONTRACT_FILE:${scheduledContractSymbol}`,
        observedInAnyFile: uploadedDates.includes(tradingDate),
        scheduledContractFileAvailable: false,
        scheduledContractDataAvailable: false,
        availableOnContract: false,
        regularSessionComplete: false,
        backtestEligible: false,
      });
      continue;
    }
    const availableOnContract = contract.summary.availableTradingDates.includes(tradingDate);
    const regularSessionComplete = contract.summary.completeRegularSessionDates.includes(tradingDate);
    const hasInvalidSourceData = contract.summary.rejectedRows > 0;
    const hasDuplicateSourceData = contract.summary.duplicateRowsRemoved > 0;
    const status = hasInvalidSourceData
      ? "invalid_or_rejected_source_data"
      : hasDuplicateSourceData
        ? "duplicate_or_overlapping_active_contract_data"
        : !availableOnContract
          ? "no_scheduled_contract_candles"
          : !regularSessionComplete
            ? "insufficient_rth_coverage"
            : "eligible";
    const coverageStatus = status;
    result.push({
      tradingDate,
      scheduledContractSymbol,
      scheduleVersion: MES_ROLLOVER_SCHEDULE_VERSION,
      rolloverReason: schedule.rolloverReason,
      status,
      coverageStatus,
      reason: status === "eligible"
        ? null
        : status === "invalid_or_rejected_source_data"
          ? `INVALID_OR_REJECTED_SOURCE_DATA:${scheduledContractSymbol}`
          : status === "duplicate_or_overlapping_active_contract_data"
            ? `DUPLICATE_OR_OVERLAPPING_ACTIVE_CONTRACT_DATA:${scheduledContractSymbol}`
            : status === "no_scheduled_contract_candles"
              ? `MISSING_SCHEDULED_CANDLES:${scheduledContractSymbol}`
              : `INSUFFICIENT_REGULAR_SESSION_COVERAGE:${scheduledContractSymbol}`,
      observedInAnyFile: uploadedDates.includes(tradingDate),
      scheduledContractFileAvailable: true,
      scheduledContractDataAvailable: availableOnContract,
      availableOnContract,
      regularSessionComplete,
      backtestEligible: status === "eligible",
    });
  }
  return result;
}

function fileSummaryFor(
  filename: string,
  contractSymbol: string,
  fingerprint: string,
  imported: HistoricalCsvImport,
): MultiContractFileSummary {
  const summary = imported.summary;
  const firstDate = summary.availableTradingDates[0] ?? null;
  const lastDate = summary.availableTradingDates.at(-1) ?? null;
  return {
    filename,
    contractSymbol,
    contractMonth: parseMesContractSymbol(contractSymbol)!.contractMonth,
    contentFingerprint: fingerprint,
    earliestTimestamp: summary.earliestTimestamp,
    latestTimestamp: summary.latestTimestamp,
    totalRows: summary.totalRows,
    validRows: summary.validRows,
    rejectedRows: summary.rejectedRows,
    availableTradingDates: summary.availableTradingDates,
    activeSelectedDates: [],
    selected: false,
    status: "inactive",
    rejectionReason: null,
    coverageStatus: "calculated",
    regularSessionCandleCount: summary.regularSessionCandleCount,
    overnightCandleCount: summary.overnightCandleCount,
    missingMinuteGaps: summary.missingMinuteGaps,
    missingGapSegments: summary.missingGapSegments,
    unexpectedMissingMinutes: summary.unexpectedMissingMinutes,
    regularSessionMissingMinutes: summary.regularSessionMissingMinutes,
    inactiveContractMinutes: summary.inactiveContractMinutes,
    missingRegularSessionDates: summary.missingRegularSessionDates,
    completeRegularSessionDates: summary.completeRegularSessionDates,
    activePeriod: {
      firstDate,
      lastDate,
      sufficient: false,
      reason: "NOT_SCHEDULED_ACTIVE",
    },
  };
}

export function assertMultiContractCoverageReconciles(
  summary: Pick<
    HistoricalMultiContractImportSummary,
    | "allObservedTradingDates"
    | "eligibleTradingDates"
    | "ineligibleObservedDates"
    | "allObservedDateCount"
    | "eligibleScheduledReplayDateCount"
    | "ineligibleObservedDateCount"
    | "coverageReconciles"
  >,
): void {
  if (
    !Array.isArray(summary.allObservedTradingDates)
    || !Array.isArray(summary.eligibleTradingDates)
    || !Array.isArray(summary.ineligibleObservedDates)
  ) {
    throw new Error("Historical multi-contract coverage summary is missing reconciliation metadata.");
  }
  const observedCount = new Set(summary.allObservedTradingDates).size;
  const eligibleCount = new Set(summary.eligibleTradingDates).size;
  const ineligibleObservedCount = new Set(
    summary.ineligibleObservedDates
      .filter((item) => item.observedInAnyFile && !item.backtestEligible)
      .map((item) => item.tradingDate),
  ).size;
  const reconciles = observedCount === eligibleCount + ineligibleObservedCount
    && summary.allObservedDateCount === observedCount
    && summary.eligibleScheduledReplayDateCount === eligibleCount
    && summary.ineligibleObservedDateCount === ineligibleObservedCount;
  if (!reconciles || !summary.coverageReconciles) {
    throw new Error(
      `Historical multi-contract coverage totals do not reconcile: observed=${observedCount}, eligible=${eligibleCount}, ineligibleObserved=${ineligibleObservedCount}.`,
    );
  }
}

async function readPersistedIndex(identity: MultiContractIdentity): Promise<HistoricalMultiContractImport | null> {
  try {
    const raw = await readFile(INDEX_CACHE_PATH, "utf8");
    const persisted = JSON.parse(raw) as PersistedMultiContractIndex;
    if (persisted.indexKey !== identity.indexKey || !Array.isArray(persisted.contracts)) return null;
    assertMultiContractCoverageReconciles(persisted.summary);
    const base = getFuturesContractSpecification("MES");
    const contracts = new Map<string, HistoricalCsvImport>();
    for (const item of persisted.contracts) {
      if (!item?.contractSymbol || !item.imported?.summary) return null;
      contracts.set(item.contractSymbol, {
        ...item.imported,
        specification: contractSpecificationForMesSymbol(item.contractSymbol),
        calendar: sessionCalendarForContract(contractSpecificationForMesSymbol(item.contractSymbol)),
      });
    }
    return {
      summary: persisted.summary,
      contentFingerprint: persisted.contentFingerprint,
      contracts,
      specification: base,
      calendar: sessionCalendarForContract(base),
    };
  } catch {
    return null;
  }
}

async function persistIndex(
  identity: MultiContractIdentity,
  value: HistoricalMultiContractImport,
): Promise<void> {
  await mkdir(join(process.cwd(), ".cache"), { recursive: true });
  const temporary = `${INDEX_CACHE_PATH}.${process.pid}.tmp`;
  const serialized: PersistedMultiContractIndex = {
    indexKey: identity.indexKey,
    contentFingerprint: identity.contentFingerprint,
    summary: value.summary,
    contracts: [...value.contracts.entries()].map(([contractSymbol, imported]) => ({
      contractSymbol,
      imported,
    })),
  };
  await writeFile(temporary, JSON.stringify(serialized), "utf8");
  await rename(temporary, INDEX_CACHE_PATH);
}

async function buildMultiContractIndex(identity: MultiContractIdentity): Promise<HistoricalMultiContractImport> {
  const persisted = await readPersistedIndex(identity);
  if (persisted) {
    updateIndexStatus({
      state: "ready",
      indexKey: identity.indexKey,
      progress: 100,
      discoveredFileCount: identity.resolved.accepted.length,
      indexedFileCount: identity.resolved.accepted.length,
      message: "Historical MES index loaded from the persistent cache.",
      error: null,
    });
    return persisted;
  }

  const base = getFuturesContractSpecification("MES");
  const importedContracts = new Map<string, HistoricalCsvImport>();
  for (const [index, file] of identity.resolved.accepted.entries()) {
    const imported = await importOneContractForIndex(
      file.path,
      contractSpecificationForMesSymbol(file.contractSymbol),
      identity.fingerprints[index],
    );
    importedContracts.set(file.contractSymbol, imported);
    updateIndexStatus({
      progress: Math.round(((index + 1) / identity.resolved.accepted.length) * 90),
      indexedFileCount: index + 1,
      message: `Indexed ${index + 1} of ${identity.resolved.accepted.length} MES contract files.`,
    });
  }

  const aggregate = aggregateSummaries([...importedContracts.values()].map((item) => item.summary));
  const allObservedTradingDates = [...new Set(
    [...importedContracts.values()].flatMap((item) => item.summary.availableTradingDates),
  )].sort();
  const acceptedContracts = [...importedContracts.keys()].sort(compareMesContractSymbols);
  const scheduledSymbols = new Set<string>(MES_ROLLOVER_SCHEDULE.map((item) => item.contractSymbol));
  const inactiveContracts = acceptedContracts.filter((symbol) => !scheduledSymbols.has(symbol));
  const eligibility = buildMultiContractDateEligibility(importedContracts, allObservedTradingDates, sessionCalendarForContract(base));
  const eligibleTradingDates = eligibility
    .filter((item) => item.backtestEligible)
    .map((item) => item.tradingDate);
  const activeContractByDate = eligibility
    .filter((item): item is MultiContractEligibility & { scheduledContractSymbol: string } =>
      item.backtestEligible && item.scheduledContractSymbol !== null)
    .map((item) => ({ tradingDate: item.tradingDate, contractSymbol: item.scheduledContractSymbol }));
  const ineligibleDates = eligibility.filter((item) => !item.backtestEligible);
  const ineligibleObservedDates = ineligibleDates.filter((item) => item.observedInAnyFile);
  const fileSummaries = identity.resolved.accepted.map((file, index) => {
    const imported = importedContracts.get(file.contractSymbol)!;
    const summary = fileSummaryFor(file.filename, file.contractSymbol, identity.fingerprints[index], imported);
    const selectedDates = activeContractByDate
      .filter((item) => item.contractSymbol === file.contractSymbol)
      .map((item) => item.tradingDate);
    summary.activeSelectedDates = selectedDates;
    summary.selected = selectedDates.length > 0;
    summary.status = summary.selected ? "accepted" : "inactive";
    summary.activePeriod = {
      firstDate: selectedDates[0] ?? null,
      lastDate: selectedDates.at(-1) ?? null,
      sufficient: selectedDates.length > 0,
      reason: selectedDates.length ? null : "NO_ELIGIBLE_SCHEDULED_DATES",
    };
    return summary;
  });
  const indexedAt = new Date().toISOString();
  const allObservedDateCount = allObservedTradingDates.length;
  const eligibleScheduledReplayDateCount = eligibleTradingDates.length;
  const ineligibleObservedDateCount = ineligibleObservedDates.length;
  const ineligibleScheduledDateCount = ineligibleDates.length;
  const coverageReconciles = allObservedDateCount
    === eligibleScheduledReplayDateCount + ineligibleObservedDateCount;
  const summary: HistoricalMultiContractImportSummary = {
    source: MULTI_CONTRACT_SOURCE,
    filename: `${fileSummaries.length} outright MES contract files`,
    detectedSymbol: "MES",
    coverageScope: "multi_contract",
    ...aggregate,
    scheduleVersion: MES_ROLLOVER_SCHEDULE_VERSION,
    acceptedContracts,
    inactiveContracts,
    rejectedFiles: identity.resolved.rejectedFiles,
    files: fileSummaries,
    rolloverBoundaries: buildRolloverBoundaries(),
    activeContractByDate,
    eligibleTradingDates,
    ineligibleDates,
    allObservedTradingDates,
    ineligibleObservedDates,
    dateEligibility: eligibility,
    acceptedOutrightFileCount: fileSummaries.length,
    scheduledActiveContractCount: new Set(activeContractByDate.map((item) => item.contractSymbol)).size,
    inactiveFutureContractCount: inactiveContracts.length,
    rejectedSpreadOrDuplicateFileCount: identity.resolved.rejectedFiles.filter((file) =>
      file.reason === "CALENDAR_SPREAD_REJECTED" || file.reason === "DUPLICATE_CONTRACT_FILE"
    ).length,
    missingScheduledContractFileCount: new Set(
      ineligibleDates
        .filter((item) => item.status === "missing_scheduled_file")
        .map((item) => item.scheduledContractSymbol)
        .filter((symbol): symbol is string => symbol !== null),
    ).size,
    allObservedDateCount,
    eligibleScheduledReplayDateCount,
    ineligibleObservedDateCount,
    ineligibleScheduledDateCount,
    coverageReconciles,
    indexingState: "ready",
    indexKey: identity.indexKey,
    importerVersion: MULTI_CONTRACT_IMPORTER_VERSION,
    indexedAt,
  };
  assertMultiContractCoverageReconciles(summary);
  const value: HistoricalMultiContractImport = {
    summary,
    contentFingerprint: identity.contentFingerprint,
    contracts: importedContracts,
    specification: base,
    calendar: sessionCalendarForContract(base),
  };
  await persistIndex(identity, value);
  updateIndexStatus({
    state: "ready",
    indexKey: identity.indexKey,
    progress: 100,
    indexedFileCount: identity.resolved.accepted.length,
    message: "Historical MES index is ready.",
    error: null,
  });
  return value;
}

async function importOneContractForIndex(
  filePath: string,
  specification: FuturesContractSpecification,
  fingerprint: string,
): Promise<HistoricalCsvImport> {
  // The source-module path is used by unit tests, where the worker entry is
  // intentionally not compiled. The deployed bundle always uses the worker.
  if (import.meta.url.endsWith(".ts")) {
    return importHistoricalCsv(filePath, specification, {
      analyzeCoverage: true,
      aggregations: [5],
      fastParse: true,
      contentFingerprint: fingerprint,
    });
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./lib/futures/multi-contract-index-worker.mjs", import.meta.url), {
        workerData: { filePath, specification, fingerprint },
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
      void worker.terminate();
    };
    worker.once("message", (message: { ok: boolean; value?: HistoricalCsvImport; error?: string }) => {
      finish(() => {
        if (message.ok && message.value) resolve(message.value);
        else reject(new Error(message.error ?? "Historical CSV indexing failed."));
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`Historical index worker exited with code ${code}.`)));
    });
  });
}

function startIndexing(identity: MultiContractIdentity): Promise<HistoricalMultiContractImport> {
  if (importPromise && activeIndexKey === identity.indexKey) return importPromise;
  activeIndexKey = identity.indexKey;
  updateIndexStatus({
    state: "indexing",
    indexKey: identity.indexKey,
    progress: 0,
    discoveredFileCount: identity.resolved.accepted.length,
    indexedFileCount: 0,
    message: "Indexing historical MES contract files.",
    error: null,
  });
  importPromise = buildMultiContractIndex(identity)
    .then((value) => {
      cachedImport = { indexKey: identity.indexKey, value };
      return value;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Historical MES index failed.";
      updateIndexStatus({
        state: "failed",
        indexKey: identity.indexKey,
        message: "Historical MES index failed.",
        error: message,
      });
      throw error;
    })
    .finally(() => {
      importPromise = null;
      activeIndexKey = null;
    });
  return importPromise;
}

export async function getHistoricalMultiContractIndexStatus(): Promise<MultiContractIndexStatus> {
  try {
    const identity = await resolveMultiContractIdentity();
    if (cachedImport?.indexKey === identity.indexKey && indexStatus.state === "ready") return { ...indexStatus };
    if (importPromise && activeIndexKey === identity.indexKey) return { ...indexStatus };
    const promise = startIndexing(identity);
    void promise.catch(() => undefined);
    return { ...indexStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical MES index could not be discovered.";
    updateIndexStatus({ state: "failed", progress: 0, error: message, message: "Historical MES index discovery failed." });
    return { ...indexStatus };
  }
}

/**
 * Read only the already-persisted multi-contract index. Unlike
 * getHistoricalMultiContractIndexStatus/importHistoricalMultiContract this
 * accessor never starts discovery or indexing, which keeps visual review
 * generation from rebuilding the historical source.
 */
export async function getReadyHistoricalMultiContractIndex(): Promise<HistoricalMultiContractImport | null> {
  try {
    const identity = await resolveMultiContractIdentity();
    if (cachedImport?.indexKey === identity.indexKey) return cachedImport.value;
    const persisted = await readPersistedIndex(identity);
    if (!persisted) return null;
    cachedImport = { indexKey: identity.indexKey, value: persisted };
    updateIndexStatus({
      state: "ready",
      indexKey: identity.indexKey,
      progress: 100,
      discoveredFileCount: identity.resolved.accepted.length,
      indexedFileCount: identity.resolved.accepted.length,
      message: "Historical MES index loaded from the persistent cache.",
      error: null,
    });
    return persisted;
  } catch {
    return null;
  }
}

export async function importHistoricalMultiContract(): Promise<HistoricalMultiContractImport> {
  const identity = await resolveMultiContractIdentity();
  if (cachedImport?.indexKey === identity.indexKey) return cachedImport.value;
  return startIndexing(identity);
}