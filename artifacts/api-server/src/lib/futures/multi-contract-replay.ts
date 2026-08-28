import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
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
  status: "accepted" | "inactive" | "rejected";
  rejectionReason: string | null;
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

function emptyAggregate(): Omit<HistoricalMultiContractImportSummary, "source" | "filename" | "detectedSymbol" | "coverageScope" | "scheduleVersion" | "acceptedContracts" | "inactiveContracts" | "rejectedFiles" | "files" | "rolloverBoundaries" | "activeContractByDate"> {
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
  const requestedDates = imported.summary.availableTradingDates.filter((date) => date >= startDate && date <= endDate);
  const requiredDates = inSampleDays + outOfSampleDays;
  const exactDates = selectedDatesOverride
    ? [...new Set(selectedDatesOverride)].filter((date) => requestedDates.includes(date)).sort()
    : null;
  if (exactDates && exactDates.length < requiredDates) {
    throw new Error(`Historical range contains ${exactDates.length} selected trading dates; ${requiredDates} are required.`);
  }
  const selectedDates = exactDates ?? selectedDatesInRange(
    imported.summary.availableTradingDates,
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
  for (const item of activeContractByDate) {
    if (!item.contractSymbol) continue;
    const contract = imported.contracts.get(item.contractSymbol);
    if (!contract) throw new Error(`Rollover schedule selects ${item.contractSymbol}, but that contract file is unavailable.`);
    const calendar = contract.calendar;
    const selected = contract.oneMinute.filter((candle) => selectedDateSet.has(tradingDateForTimestamp(candle.openTime, calendar))
      && tradingDateForTimestamp(candle.openTime, calendar) === item.tradingDate);
    if (selected.length) {
      candles.push(...contract.fiveMinute
        .filter((candle) => tradingDateForTimestamp(candle.openTime, calendar) === item.tradingDate)
        .map(toReplayCandle));
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
    excludedDates: imported.summary.availableTradingDates.filter((date) => date >= startDate && date <= endDate && !selectedDateSet.has(date)),
    source: MULTI_CONTRACT_SOURCE,
    quotesAvailable: false,
    gapReport: selectedGapReport(candles, normalizedSelectedOneMinute),
    contractSchedule: {
      version: MES_ROLLOVER_SCHEDULE_VERSION,
      activeContractByDate,
      boundaries: buildRolloverBoundaries(),
    },
  };
}

let cachedImport: { fingerprint: string; value: HistoricalMultiContractImport } | null = null;
let importPromise: Promise<HistoricalMultiContractImport> | null = null;

export async function importHistoricalMultiContract(): Promise<HistoricalMultiContractImport> {
  const resolved = await resolveMultiContractFiles();
  if (resolved.accepted.length === 0) throw new Error("No uploaded outright MES contract CSVs were found in attached_assets.");
  const fingerprints = await Promise.all(resolved.accepted.map((file) => getHistoricalCsvFingerprint(file.path)));
  const combinedFingerprint = fingerprints.map((fingerprint, index) => `${resolved.accepted[index].contractSymbol}:${fingerprint}`).join("|");
  if (cachedImport?.fingerprint === combinedFingerprint) return cachedImport.value;
  if (importPromise) return importPromise;
  importPromise = (async () => {
    const base = getFuturesContractSpecification("MES");
    const importedContracts = new Map<string, HistoricalCsvImport>();
    const importedResults: HistoricalCsvImport[] = [];
    for (const [index, file] of resolved.accepted.entries()) {
      importedResults[index] = await importHistoricalCsv(file.path, base, {
        analyzeCoverage: false,
        aggregations: [5],
        fastParse: true,
        contentFingerprint: fingerprints[index],
      });
    }
    const fileSummaries: MultiContractFileSummary[] = [];
    for (const [index, file] of resolved.accepted.entries()) {
      const imported = importedResults[index];
      importedContracts.set(file.contractSymbol, imported);
      fileSummaries.push({
        filename: file.filename,
        contractSymbol: file.contractSymbol,
        contractMonth: parseMesContractSymbol(file.contractSymbol)!.contractMonth,
        contentFingerprint: fingerprints[index],
        earliestTimestamp: imported.summary.earliestTimestamp,
        latestTimestamp: imported.summary.latestTimestamp,
        totalRows: imported.summary.totalRows,
        validRows: imported.summary.validRows,
        rejectedRows: imported.summary.rejectedRows,
        availableTradingDates: imported.summary.availableTradingDates,
        activeSelectedDates: [],
        selected: false,
        status: "inactive",
        rejectionReason: null,
      });
    }
    const aggregate = aggregateSummaries([...importedContracts.values()].map((item) => item.summary));
    const acceptedContracts = [...importedContracts.keys()].sort(compareMesContractSymbols);
    const scheduleDates = new Set<string>(MES_ROLLOVER_SCHEDULE.map((item) => item.contractSymbol));
    const inactiveContracts = acceptedContracts.filter((symbol) => !scheduleDates.has(symbol));
    const activeContractByDate = aggregate.availableTradingDates
      .map((tradingDate) => ({ tradingDate, contractSymbol: scheduledMesContractForDate(tradingDate) }))
      .filter((item): item is { tradingDate: string; contractSymbol: string } => item.contractSymbol !== null);
    for (const file of fileSummaries) {
      const selectedDates = activeContractByDate.filter((item) => item.contractSymbol === file.contractSymbol).map((item) => item.tradingDate);
      file.activeSelectedDates = selectedDates;
      file.selected = selectedDates.length > 0;
      file.status = file.selected ? "accepted" : "inactive";
    }
    const summary: HistoricalMultiContractImportSummary = {
      source: MULTI_CONTRACT_SOURCE,
      filename: `${fileSummaries.length} outright MES contract files`,
      detectedSymbol: "MES multi-contract",
      coverageScope: "multi_contract",
      ...aggregate,
      scheduleVersion: MES_ROLLOVER_SCHEDULE_VERSION,
      acceptedContracts,
      inactiveContracts,
      rejectedFiles: resolved.rejectedFiles,
      files: fileSummaries,
      rolloverBoundaries: buildRolloverBoundaries(),
      activeContractByDate,
    };
    const value: HistoricalMultiContractImport = {
      summary,
      contentFingerprint: combinedFingerprint,
      contracts: importedContracts,
      specification: base,
      calendar: sessionCalendarForContract(base),
    };
    cachedImport = { fingerprint: combinedFingerprint, value };
    return value;
  })().finally(() => {
    importPromise = null;
  });
  return importPromise;
}