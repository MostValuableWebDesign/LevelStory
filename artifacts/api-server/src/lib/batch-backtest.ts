import type { BacktestWorkerInput } from "./backtest-worker-client.js";
import { runBacktestInWorker } from "./backtest-worker-client.js";
import {
  buildSegments,
  buildQualificationFunnel,
  calculateBacktestMetrics,
  historicalReplayDiagnostics,
  applyHistoricalAccountPositionGate,
  QUALIFICATION_FUNNEL_VERSION,
  type BacktestAuditRecord,
  type BacktestGapReport,
  type BacktestReport,
  type BacktestRequest,
  type BacktestTrade,
  type CausalReplayDataset,
  type HistoricalOccurrence,
  type QualificationFunnel,
} from "./phase9.js";
import { FIXED_FORMULA_VERSION } from "./formula-hash.js";
import {
  buildVersionedAnalysisCacheKey,
  BATCH_AGGREGATION_CACHE_KEY_VERSION,
  LIFECYCLE_RECONCILIATION_VERSION,
  STRATEGY_RESULT_CACHE_KEY_VERSION,
  VersionedAnalysisCache,
} from "./analysis-cache.js";
import type { HistoricalSessionCatalogEntry } from "./futures/historical-index-store.js";
import {
  buildSensitivityCase,
  evaluateWalkForward,
  type WalkForwardReport,
} from "./walk-forward.js";
import { parseMesContractSymbol } from "./futures/multi-contract-replay.js";
import { tradingDateForTimestamp, sessionCalendarForContract } from "./futures/session-calendar.js";
import { getFuturesContractSpecification } from "./futures/contracts.js";
import type { PersistentSessionAnalysisStore } from "./session-analysis-store.js";

export type BatchBacktestRequest = BacktestRequest & {
  selectedDates?: string[];
};

export type BatchBacktestProgress = {
  status: "queued" | "running" | "completed" | "cancelled" | "timed_out" | "failed";
  totalPartitions: number;
  completedPartitions: number;
  currentTradingDate: string | null;
  currentContractSymbol: string | null;
  message: string | null;
};

export type BatchBacktestReport = BacktestReport & {
  batch: {
    totalPartitions: number;
    completedPartitions: number;
    selectedDates: string[];
    contractPartitions: Array<{ tradingDate: string; contractSymbol: string; period: "in_sample" | "out_of_sample" }>;
    duplicateOccurrenceConflicts: BatchOccurrenceConflict[];
  };
  funnel: QualificationFunnel;
  walkForward: WalkForwardReport;
  accountReplay: BatchAccountReplay;
};

export type BatchAccountReplay = {
  startingBalance: number;
  endingBalance: number;
  realizedNetPnl: number;
  equityCurve: Array<{
    tradeNumber: number;
    entryTime: string;
    balance: number;
    netPnl: number | null;
    status: "start" | "win" | "loss" | "flat" | "open";
  }>;
  blockedCandidateCount: number;
  blockedCandidateIds: string[];
};

export type CatalogedSessionCacheContext = {
  catalogEntries?: readonly HistoricalSessionCatalogEntry[];
  sourceIdentity?: unknown;
  strategyIdentity?: unknown;
  initialState?: unknown;
};

export type SessionResultCacheDescriptor = {
  cacheKey: string;
  cacheKeyVersion: string;
  sourceFingerprint: string;
  lookbackFingerprint: string;
  strategyIdentity: unknown;
  formulaVersion: string;
  formulaHash: string;
  executionSettings: unknown;
  initialState: unknown;
  dependencyIdentity: Record<string, unknown>;
};

const sessionResultCache = new VersionedAnalysisCache<BacktestReport>({
  maxEntries: 512,
  ttlMs: 60 * 60_000,
});

export function clearCatalogedSessionResultCache(): void {
  sessionResultCache.clear();
}

export function getCatalogedSessionResultCacheStats(): { entries: number; pending: number } {
  return sessionResultCache.getStats();
}

type BatchPartition = {
  tradingDate: string;
  contractSymbol: string;
  period: "in_sample" | "out_of_sample";
  dataset: CausalReplayDataset;
};

const BATCH_AUDIT_RUN_ID = "00000000-0000-0000-0000-000000000011";

export type BatchRunnerOptions = {
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (progress: BatchBacktestProgress) => void;
  runPartition?: (input: BacktestWorkerInput, options: { timeoutMs: number; signal: AbortSignal }) => Promise<BacktestReport>;
  sessionCache?: CatalogedSessionCacheContext;
  persistentSessionCache?: PersistentSessionAnalysisStore;
  includeSensitivity?: boolean;
};

export type CatalogedSessionCacheDiagnostic = {
  tradingDate: string;
  contractSymbol: string;
  cacheKey: string | null;
  memoryHit: boolean;
  persistentHit: boolean;
  recomputed: boolean;
  durationMs: number;
};

export type CatalogedBatchCacheDiagnostics = {
  startedAt: string;
  completedAt: string;
  totalMs: number;
  aggregationMs: number;
  sessionCount: number;
  memoryHits: number;
  persistentHits: number;
  recomputations: number;
  rawIndexSessionReuseCount: number;
  sessions: CatalogedSessionCacheDiagnostic[];
};

let lastCatalogedBatchCacheDiagnostics: CatalogedBatchCacheDiagnostics | null = null;
let lastCatalogedBatchResultCacheLookup: {
  cacheKey: string;
  hit: boolean;
  lookedUpAt: string;
} | null = null;

export function getCatalogedBatchCacheDiagnostics(): CatalogedBatchCacheDiagnostics | null {
  return lastCatalogedBatchCacheDiagnostics
    ? structuredClone(lastCatalogedBatchCacheDiagnostics)
    : null;
}

export function recordCatalogedBatchResultCacheLookup(cacheKey: string, hit: boolean): void {
  lastCatalogedBatchResultCacheLookup = {
    cacheKey,
    hit,
    lookedUpAt: new Date().toISOString(),
  };
}

export function getCatalogedBatchResultCacheLookup(): {
  cacheKey: string;
  hit: boolean;
  lookedUpAt: string;
} | null {
  return lastCatalogedBatchResultCacheLookup
    ? { ...lastCatalogedBatchResultCacheLookup }
    : null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function jsonSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => entry === undefined ? null : jsonSafe(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

export type BatchOccurrenceConflict = {
  occurrenceId: string;
  differingFields: string[];
  classification: "compatible_enrichment" | "contradiction";
  sourcePartitions: string[];
};

type OccurrenceWithSource = {
  occurrence: HistoricalOccurrence;
  sourcePartition: string;
};

const SAFE_UNION_ARRAY_FIELDS = new Set([
  "identityInvariantViolations",
  "secondaryStrategyMatches",
  "matchedEdges",
  "supportingConfluences",
]);
const SAFE_UNION_ARRAY_FIELD_NAMES = [
  "identityInvariantViolations",
  "secondaryStrategyMatches",
  "matchedEdges",
  "supportingConfluences",
] as const;

function isMissingOccurrenceValue(value: unknown): boolean {
  return value === undefined || value === null;
}

function deepDifferencePaths(left: unknown, right: unknown, path: string): string[] {
  if (stableSerialize(left) === stableSerialize(right)) return [];
  if (isMissingOccurrenceValue(left) || isMissingOccurrenceValue(right)) return [path];
  if (Array.isArray(left) || Array.isArray(right)) return [path];
  if (left && typeof left === "object" && right && typeof right === "object") {
    const keys = new Set([
      ...Object.keys(left as Record<string, unknown>),
      ...Object.keys(right as Record<string, unknown>),
    ]);
    return [...keys]
      .sort()
      .flatMap((key) => deepDifferencePaths(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}.${key}`,
      ));
  }
  return [path];
}

function compareCausalEvidenceArrays(
  left: unknown,
  right: unknown,
  path: string,
): string[] {
  if (isMissingOccurrenceValue(left) || isMissingOccurrenceValue(right)) return [];
  if (!Array.isArray(left) || !Array.isArray(right)) return [path];
  const leftByAudit = new Map<string, unknown>();
  const rightByAudit = new Map<string, unknown>();
  for (const evidence of left) {
    if (!evidence || typeof evidence !== "object") return [path];
    const sourceAuditId = (evidence as Record<string, unknown>).sourceAuditId;
    if (typeof sourceAuditId !== "string") return [path];
    leftByAudit.set(sourceAuditId, evidence);
  }
  for (const evidence of right) {
    if (!evidence || typeof evidence !== "object") return [path];
    const sourceAuditId = (evidence as Record<string, unknown>).sourceAuditId;
    if (typeof sourceAuditId !== "string") return [path];
    rightByAudit.set(sourceAuditId, evidence);
  }
  const paths: string[] = [];
  for (const sourceAuditId of new Set([...leftByAudit.keys(), ...rightByAudit.keys()])) {
    const leftEvidence = leftByAudit.get(sourceAuditId);
    const rightEvidence = rightByAudit.get(sourceAuditId);
    if (leftEvidence === undefined || rightEvidence === undefined) continue;
    paths.push(...deepDifferencePaths(leftEvidence, rightEvidence, `${path}[${sourceAuditId}]`));
  }
  return paths;
}

function occurrenceFieldDifferencePaths(
  field: string,
  left: unknown,
  right: unknown,
): string[] {
  if (stableSerialize(left) === stableSerialize(right)) return [];
  if (field === "auditId" || field === "auditIds") return [];
  if (field === "evaluationCursor") {
    const leftTime = typeof left === "string" ? Date.parse(left) : Number.NaN;
    const rightTime = typeof right === "string" ? Date.parse(right) : Number.NaN;
    return (isMissingOccurrenceValue(left) || isMissingOccurrenceValue(right))
      || (Number.isFinite(leftTime) && Number.isFinite(rightTime))
      ? []
      : [`${field}`];
  }
  if (SAFE_UNION_ARRAY_FIELDS.has(field)) return [];
  if (field === "causalEvidence") {
    return isMissingOccurrenceValue(left) || isMissingOccurrenceValue(right)
      ? []
      : deepDifferencePaths(left, right, field);
  }
  if (field === "causalEvidenceByAudit") return compareCausalEvidenceArrays(left, right, field);
  return deepDifferencePaths(left, right, field);
}

function mergeOccurrenceEnrichment(
  occurrences: readonly OccurrenceWithSource[],
): HistoricalOccurrence {
  const completeness = (occurrence: HistoricalOccurrence): number =>
    Object.values(occurrence).reduce<number>((score, value) => score + (isMissingOccurrenceValue(value) ? 0 : 1), 0);
  const ordered = [...occurrences].sort((left, right) =>
    completeness(right.occurrence) - completeness(left.occurrence)
    || left.sourcePartition.localeCompare(right.sourcePartition)
    || stableSerialize(left.occurrence).localeCompare(stableSerialize(right.occurrence)));
  const merged = structuredClone(ordered[0]!.occurrence);
  const auditIds = ordered.flatMap(({ occurrence }) => [
    occurrence.auditId,
    ...(occurrence.auditIds ?? []),
  ]).filter((value): value is string => typeof value === "string" && value.length > 0).sort();
  if (auditIds.length > 0) {
    merged.auditId = ordered[0]!.occurrence.auditId ?? auditIds[0]!;
    merged.auditIds = [...new Set(auditIds)];
  }
  const evaluationCursors = ordered
    .map(({ occurrence }) => Date.parse(occurrence.evaluationCursor ?? ""))
    .filter(Number.isFinite);
  if (evaluationCursors.length > 0) {
    merged.evaluationCursor = new Date(Math.max(...evaluationCursors)).toISOString();
  }
  for (const field of SAFE_UNION_ARRAY_FIELD_NAMES) {
    const values = ordered.flatMap(({ occurrence }) => {
      const value = occurrence[field];
      return Array.isArray(value) ? value : [];
    });
    if (values.length > 0) {
      merged[field] = [...new Set(values)].sort();
    }
  }
  if (merged.causalEvidence === undefined || merged.causalEvidence === null) {
    const evidence = ordered.find(({ occurrence }) => occurrence.causalEvidence)?.occurrence.causalEvidence;
    if (evidence) merged.causalEvidence = structuredClone(evidence);
  }
  const causalEvidence = ordered.flatMap(({ occurrence }) => occurrence.causalEvidenceByAudit ?? []);
  if (causalEvidence.length > 0) {
    const byAudit = new Map(causalEvidence.map((evidence) => [evidence.sourceAuditId, evidence]));
    merged.causalEvidenceByAudit = [...byAudit.values()]
      .sort((left, right) => left.sourceAuditId.localeCompare(right.sourceAuditId))
      .map((evidence) => structuredClone(evidence));
  }
  return merged;
}

function mergeBatchOccurrences(
  reports: readonly BacktestReport[],
  partitions: readonly BatchPartition[],
): {
  occurrences: HistoricalOccurrence[];
  conflicts: string[];
  conflictedOccurrenceIds: Set<string>;
  conflictDetails: BatchOccurrenceConflict[];
  conflictedAuditIds: Set<string>;
  conflictedPhysicalIdentities: Set<string>;
} {
  const byId = new Map<string, HistoricalOccurrence>();
  const grouped = new Map<string, OccurrenceWithSource[]>();
  reports.forEach((report, reportIndex) => {
    const partition = partitions[reportIndex];
    const sourcePartition = partition
      ? `${partition.tradingDate}/${partition.contractSymbol}/${partition.period}`
      : `report-${reportIndex}`;
    for (const occurrence of report.occurrences) {
      const items = grouped.get(occurrence.occurrenceId) ?? [];
      items.push({ occurrence, sourcePartition });
      grouped.set(occurrence.occurrenceId, items);
    }
  });
  for (const items of grouped.values()) {
    items.sort((left, right) =>
      left.sourcePartition.localeCompare(right.sourcePartition)
      || stableSerialize(left.occurrence).localeCompare(stableSerialize(right.occurrence)));
  }
  const conflicts: string[] = [];
  const conflictDetails: BatchOccurrenceConflict[] = [];
  const conflictedOccurrenceIds = new Set<string>();
  const conflictedAuditIds = new Set<string>();
  const conflictedPhysicalIdentities = new Set<string>();
  for (const [occurrenceId, items] of grouped) {
    const occurrences = items.map(({ occurrence }) => occurrence);
    const allFields = [...new Set(occurrences.flatMap((occurrence) => Object.keys(occurrence)))].sort();
    const allDifferingFields = new Set<string>();
    const differingFields = new Set<string>();
    for (let leftIndex = 0; leftIndex < occurrences.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < occurrences.length; rightIndex += 1) {
        const left = occurrences[leftIndex]!;
        const right = occurrences[rightIndex]!;
        for (const field of allFields) {
          const leftValue = left[field as keyof HistoricalOccurrence];
          const rightValue = right[field as keyof HistoricalOccurrence];
          if (stableSerialize(leftValue) === stableSerialize(rightValue)) continue;
          allDifferingFields.add(field);
          for (const path of occurrenceFieldDifferencePaths(field, leftValue, rightValue)) {
            differingFields.add(path);
          }
        }
      }
    }
    const allDifferingFieldList = [...allDifferingFields].sort();
    const differingFieldList = [...differingFields].sort();
    const classification = differingFieldList.length === 0
      ? "compatible_enrichment"
      : "contradiction";
    const sourcePartitions = [...new Set(items.map((item) => item.sourcePartition))].sort();
    if (allDifferingFieldList.length > 0) {
      conflictDetails.push({
        occurrenceId,
        differingFields: classification === "compatible_enrichment" ? allDifferingFieldList : differingFieldList,
        classification,
        sourcePartitions,
      });
    }
    if (classification === "contradiction") {
      conflictedOccurrenceIds.add(occurrenceId);
      conflicts.push(
        `BATCH_DUPLICATE_OCCURRENCE_REJECTED:${occurrenceId}`,
        `BATCH_DUPLICATE_OCCURRENCE_REJECTED_FIELDS:${occurrenceId}:${sourcePartitions.join("|")}:${differingFieldList.join(",")}`,
      );
      for (const item of items) {
        if (item.occurrence.auditId) conflictedAuditIds.add(item.occurrence.auditId);
        const identity = [
          item.occurrence.contractSymbol,
          item.occurrence.tradingDate,
          item.occurrence.pOpenTimestamp,
          item.occurrence.eOpenTimestamp,
        ].join("|");
        conflictedPhysicalIdentities.add(identity);
      }
    }
    byId.set(
      occurrenceId,
      allDifferingFieldList.length > 0 && classification === "compatible_enrichment"
        ? mergeOccurrenceEnrichment(items)
        : items[0]!.occurrence,
    );
  }
  return {
    occurrences: [...byId.values()].sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId)),
    conflicts: [...new Set(conflicts)].sort(),
    conflictedOccurrenceIds,
    conflictDetails: conflictDetails.sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId)),
    conflictedAuditIds,
    conflictedPhysicalIdentities,
  };
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("BACKTEST_REQUEST_ABORTED");
  }
}

function emptyGapReport(): BacktestGapReport {
  return {
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
    coverageScope: "selected_dates",
    inactiveContractThresholdPercent: 50,
    inactiveContractDays: 0,
    missingRegularSessionDates: [],
    missingOvernightSessionDates: [],
    completeRegularSessionDates: [],
    maintenanceGapMinutes: 0,
    weekendHolidayGapMinutes: 0,
    earlyCloseDates: [],
    overnightCoverageObserved: false,
  };
}

function combineGapReports(reports: readonly BacktestReport[]): BacktestGapReport {
  const source = reports[0]?.gapReport ?? emptyGapReport();
  return {
    ...source,
    missingRegularSessionDates: uniqueSorted(source.missingRegularSessionDates),
    missingOvernightSessionDates: uniqueSorted(source.missingOvernightSessionDates),
    completeRegularSessionDates: uniqueSorted(source.completeRegularSessionDates),
    earlyCloseDates: uniqueSorted(source.earlyCloseDates),
  };
}

function partitionDataset(
  dataset: CausalReplayDataset,
  tradingDate: string,
  contractSymbol: string,
  period: "in_sample" | "out_of_sample",
): CausalReplayDataset | null {
  const calendar = sessionCalendarForContract(getFuturesContractSpecification("MES"));
  const candles = dataset.candles.filter((candle) =>
    candle.contractSymbol === contractSymbol
    && tradingDateForTimestamp(candle.openTime, calendar) === tradingDate,
  );
  if (!candles.length) return null;
  const oneMinute = (dataset.oneMinute ?? []).filter((candle) =>
    tradingDateForTimestamp(candle.openTime, calendar) === tradingDate,
  );
  const identity = parseMesContractSymbol(contractSymbol);
  return {
    candles,
    oneMinute,
    contractSymbol,
    contractMonth: identity?.contractMonth ?? dataset.contractMonth,
    inSampleDates: period === "in_sample" ? [tradingDate] : [],
    outOfSampleDates: period === "out_of_sample" ? [tradingDate] : [],
    requestedStartDate: tradingDate,
    requestedEndDate: tradingDate,
    selectedDates: [tradingDate],
    excludedDates: [],
    source: dataset.source,
    orderedIntrabarEvidenceComplete: dataset.orderedIntrabarEvidenceComplete,
    orderedIntrabarEvidence: dataset.orderedIntrabarEvidence,
    quotesAvailable: dataset.quotesAvailable,
    gapReport: dataset.gapReport,
    contractSchedule: dataset.contractSchedule
      ? {
          version: dataset.contractSchedule.version,
          activeContractByDate: [{ tradingDate, contractSymbol }],
          boundaries: dataset.contractSchedule.boundaries,
        }
      : undefined,
  };
}

function createPartitions(
  request: BatchBacktestRequest,
  dataset: CausalReplayDataset,
): BatchPartition[] {
  const requestedDates = uniqueSorted(
    request.selectedDates?.length
      ? request.selectedDates
      : dataset.selectedDates?.length
        ? dataset.selectedDates
        : [...dataset.inSampleDates, ...dataset.outOfSampleDates],
  );
  const holdoutDates = new Set(requestedDates.slice(-request.outOfSampleDays));
  const contractByDate = new Map(
    dataset.contractSchedule?.activeContractByDate?.map((item) => [item.tradingDate, item.contractSymbol]) ?? [],
  );
  const fallbackContract = dataset.contractSymbol;
  const partitions = requestedDates.flatMap((tradingDate) => {
    const contractSymbol = contractByDate.get(tradingDate)
      ?? (dataset.source === "historical_databento_multicontract"
        ? undefined
        : dataset.candles.find((candle) => tradingDateForTimestamp(candle.openTime, sessionCalendarForContract(getFuturesContractSpecification("MES"))) === tradingDate)?.contractSymbol
          ?? fallbackContract);
    if (!contractSymbol) {
      throw new Error(`No scheduled contract is available for batch trading date ${tradingDate}.`);
    }
    const period = holdoutDates.has(tradingDate) ? "out_of_sample" : "in_sample";
    const partition = partitionDataset(dataset, tradingDate, contractSymbol, period);
    if (!partition) {
      throw new Error(`Batch trading date ${tradingDate} has no completed candles for ${contractSymbol}.`);
    }
    return [{ tradingDate, contractSymbol, period: period as BatchPartition["period"], dataset: partition }];
  });
  if (partitions.length !== requestedDates.length) {
    throw new Error("The batch could not construct every requested replay partition.");
  }
  return partitions;
}

function sessionCatalogEntry(
  context: CatalogedSessionCacheContext | undefined,
  partition: BatchPartition,
): HistoricalSessionCatalogEntry | undefined {
  return context?.catalogEntries?.find((entry) =>
    entry.tradingDate === partition.tradingDate
    && entry.contractSymbol === partition.contractSymbol);
}

function buildSessionResultCacheDescriptor(
  partition: BatchPartition,
  request: BatchBacktestRequest,
  risk: BacktestWorkerInput["risk"],
  context: CatalogedSessionCacheContext | undefined,
): SessionResultCacheDescriptor | null {
  const catalog = sessionCatalogEntry(context, partition);
  if (catalog && (
    catalog.coverageStatus !== "complete"
    || catalog.completenessStatus !== "complete"
    || catalog.validationStatus !== "validated"
  )) return null;
  const strategyIdentity = jsonSafe(context?.strategyIdentity ?? {
    formulaVersion: FIXED_FORMULA_VERSION,
    strategyResultVersion: STRATEGY_RESULT_CACHE_KEY_VERSION,
  });
  const initialState = jsonSafe(context?.initialState ?? {
    accountPosition: "flat-for-session-analysis",
    combinedReplayGate: "required",
  });
  const sourceFingerprint = catalog?.sourceFingerprint
    ?? partition.dataset.contentFingerprint
    ?? "source-fingerprint-unavailable";
  const lookbackFingerprint = buildVersionedAnalysisCacheKey("cataloged-session-lookback", {
    tradingDate: partition.tradingDate,
    contractSymbol: partition.contractSymbol,
    partitionIdentity: catalog?.partitionIdentity ?? null,
    sourceFingerprint,
    datasetFingerprint: partition.dataset.contentFingerprint ?? null,
    contractSchedule: partition.dataset.contractSchedule ?? null,
    initialState,
  });
  const {
    selectedDates: _selectedDates,
    startDate: _startDate,
    endDate: _endDate,
    inSampleDays: _inSampleDays,
    outOfSampleDays: _outOfSampleDays,
    ...rawSessionIndependentRequest
  } = request;
  const sessionIndependentRequest = jsonSafe(rawSessionIndependentRequest) as Record<string, unknown>;
  const normalizedRisk = jsonSafe(risk ?? null);
  const executionSettings = { request: sessionIndependentRequest, risk: normalizedRisk };
  const dependencyIdentity = {
    cacheKeyVersion: `${STRATEGY_RESULT_CACHE_KEY_VERSION}-session`,
    aggregationVersion: BATCH_AGGREGATION_CACHE_KEY_VERSION,
    lifecycleVersion: LIFECYCLE_RECONCILIATION_VERSION,
    qualificationFunnelVersion: QUALIFICATION_FUNNEL_VERSION,
    session: {
      tradingDate: partition.tradingDate,
      contractSymbol: partition.contractSymbol,
      period: partition.period,
      partitionIdentity: catalog?.partitionIdentity ?? null,
      sourceFingerprint,
      ingestionVersion: catalog?.ingestionVersion ?? null,
      normalizationVersion: catalog?.normalizationVersion ?? null,
      schemaVersion: catalog?.schemaVersion ?? null,
      datasetFingerprint: partition.dataset.contentFingerprint ?? null,
      source: partition.dataset.source ?? null,
      timeframe: catalog?.availableTimeframes ?? [1, 5],
    },
    strategy: strategyIdentity,
    request: sessionIndependentRequest,
    risk: normalizedRisk,
    source: {
      ...(jsonSafe(context?.sourceIdentity && typeof context.sourceIdentity === "object"
        ? context.sourceIdentity as Record<string, unknown>
        : { value: context?.sourceIdentity ?? null }) as Record<string, unknown>),
      lookbackFingerprint,
    },
    initialState,
  };
  const strategyRecord = strategyIdentity && typeof strategyIdentity === "object"
    ? strategyIdentity as Record<string, unknown>
    : {};
  return {
    cacheKey: buildVersionedAnalysisCacheKey("cataloged-session-strategy-result", dependencyIdentity),
    cacheKeyVersion: dependencyIdentity.cacheKeyVersion,
    sourceFingerprint,
    lookbackFingerprint,
    strategyIdentity,
    formulaVersion: typeof strategyRecord.formulaVersion === "string"
      ? strategyRecord.formulaVersion
      : FIXED_FORMULA_VERSION,
    formulaHash: typeof strategyRecord.formulaHash === "string"
      ? strategyRecord.formulaHash
      : "formula-hash-unavailable",
    executionSettings,
    initialState,
    dependencyIdentity,
  };
}

function buildSessionResultCacheKey(
  partition: BatchPartition,
  request: BatchBacktestRequest,
  risk: BacktestWorkerInput["risk"],
  context: CatalogedSessionCacheContext | undefined,
): string | null {
  return buildSessionResultCacheDescriptor(partition, request, risk, context)?.cacheKey ?? null;
}

function buildBatchAccountReplay(
  trades: readonly BacktestReport["trades"][number][],
  tradeCandidates: readonly BacktestReport["tradeCandidates"][number][],
  startingBalance = 100_000,
): BatchAccountReplay {
  let balance = startingBalance;
  let closedPnl = 0;
  const equityCurve: BatchAccountReplay["equityCurve"] = [{
    tradeNumber: 0,
    entryTime: trades[0]?.entryTime ?? new Date(0).toISOString(),
    balance,
    netPnl: null,
    status: "start",
  }];
  for (const [index, trade] of [...trades].sort((left, right) =>
    Date.parse(left.entryTime) - Date.parse(right.entryTime)
    || left.id.localeCompare(right.id),
  ).entries()) {
    const closed = trade.outcome !== "open" && trade.exitTime !== null;
    const netPnl = closed ? trade.netPnl : null;
    if (netPnl !== null) {
      closedPnl += netPnl;
      balance += netPnl;
    }
    equityCurve.push({
      tradeNumber: index + 1,
      entryTime: trade.entryTime,
      balance,
      netPnl,
      status: netPnl === null ? "open" : netPnl > 0 ? "win" : netPnl < 0 ? "loss" : "flat",
    });
  }
  const blockedCandidateIds = tradeCandidates
    .filter((candidate) => candidate.accountEntryStatus === "BLOCKED_ACTIVE_POSITION")
    .map((candidate) => candidate.candidateId)
    .sort();
  return {
    startingBalance,
    endingBalance: balance,
    realizedNetPnl: closedPnl,
    equityCurve,
    blockedCandidateCount: blockedCandidateIds.length,
    blockedCandidateIds,
  };
}

export function aggregateBatchReports(
  reports: readonly BacktestReport[],
  partitions: readonly BatchPartition[],
  selectedDates: readonly string[],
  walkForward: WalkForwardReport,
): BatchBacktestReport {
  const first = reports[0];
  if (!first) throw new Error("The batch produced no completed replay partitions.");
  const mergedOccurrences = mergeBatchOccurrences(reports, partitions);
  const conflictedOccurrenceIds = mergedOccurrences.conflictedOccurrenceIds;
  const belongsToConflictedOccurrence = (occurrenceId: string | undefined): boolean =>
    occurrenceId !== undefined && conflictedOccurrenceIds.has(occurrenceId);
  const belongsToConflictedAudit = (record: BacktestAuditRecord): boolean => {
    if (mergedOccurrences.conflictedAuditIds.has(record.id)) return true;
    const physicalIdentity = [
      record.contractSymbol,
      record.tradingDate,
      record.patienceCandleOpenTime,
      record.triggerCandleOpenTime,
    ].join("|");
    return mergedOccurrences.conflictedPhysicalIdentities.has(physicalIdentity);
  };
  const filteredReports = reports.map((report) => ({
    ...report,
    audit: report.audit.filter((record) => !belongsToConflictedAudit(record)),
    occurrences: report.occurrences.filter((occurrence) => !belongsToConflictedOccurrence(occurrence.occurrenceId)),
    trades: report.trades.filter((trade) => !belongsToConflictedOccurrence(trade.signalOccurrenceId)),
  }));
  const audit = filteredReports.flatMap((report) => report.audit);
  const candidateExecutionEvidence = reports
    .flatMap((report) => report.candidateExecutionEvidence ?? [])
    .filter((trade) => !belongsToConflictedOccurrence(trade.signalOccurrenceId));
  const partitionTrades = filteredReports
    .flatMap((report) => report.trades)
    .filter((trade) => !belongsToConflictedOccurrence(trade.signalOccurrenceId));
  const partitionCandidates = filteredReports
    .flatMap((report) => report.tradeCandidates)
    .filter((candidate) => !belongsToConflictedOccurrence(candidate.signalOccurrenceId));
  const schedule = partitions.find((partition) => partition.dataset.contractSchedule)?.dataset.contractSchedule;
  const globalAccountGate = candidateExecutionEvidence.length > 0
    ? applyHistoricalAccountPositionGate(partitionCandidates, candidateExecutionEvidence, {
      resetAtContractBoundary: Boolean(schedule),
      contractBoundaries: schedule?.boundaries,
    })
    : null;
  const trades = globalAccountGate?.authoritativeTrades ?? partitionTrades;
  const tradeCandidates = globalAccountGate?.candidates ?? partitionCandidates;
  const rejectedCandidateSignals = filteredReports
    .flatMap((report) => report.rejectedCandidateSignals)
    .filter((rejection) => !belongsToConflictedOccurrence(rejection.signalOccurrenceId));
  const orphanModeledTrades = filteredReports
    .flatMap((report) => report.orphanModeledTrades)
    .filter((trade) => !belongsToConflictedOccurrence(trade.matchingSignalOccurrenceId));
  const occurrences = mergedOccurrences.occurrences.filter((occurrence) =>
    !conflictedOccurrenceIds.has(occurrence.occurrenceId));
  const enteredCandidateIds = new Set(trades.map((trade) => trade.candidateId));
  const blockedCandidateCount = tradeCandidates.filter(
    (candidate) => candidate.accountEntryStatus === "BLOCKED_ACTIVE_POSITION",
  ).length;
  const executionSummary = {
    detectedCandidateCount: tradeCandidates.length + rejectedCandidateSignals.length,
    eligibleCandidateCount: tradeCandidates.length,
    rejectedCandidateCount: rejectedCandidateSignals.length,
    accountEntryBlockedCandidateCount: blockedCandidateCount,
    accountPositionStateVersion: reports[0]?.executionSummary.accountPositionStateVersion ?? "unknown",
    enteredTradeCount: trades.length,
    finalizedTradeCount: trades.filter((trade) => trade.outcome !== "open").length,
    openTradeCount: trades.filter((trade) => trade.outcome === "open").length,
    ambiguousEntryCount: tradeCandidates.filter((candidate) => candidate.executionStatus === "ENTRY_AMBIGUOUS").length,
    unresolvedAmbiguousTradeCount: trades.filter((trade) => trade.ambiguityLabel !== null).length,
    conservativelyResolvedTradeCount: trades.filter((trade) => trade.ambiguityLabel !== null && trade.outcome !== "open").length,
    unscoredTradeCount: trades.filter((trade) => trade.outcome === "open" || trade.ambiguityLabel !== null).length,
    nonEnteredCandidateCount: tradeCandidates.filter((candidate) =>
      !enteredCandidateIds.has(candidate.candidateId)
      && candidate.accountEntryStatus !== "BLOCKED_ACTIVE_POSITION",
    ).length,
  };
  const diagnostics = historicalReplayDiagnostics(
    audit,
    occurrences,
    tradeCandidates,
    trades,
    rejectedCandidateSignals,
    orphanModeledTrades,
  );
  diagnostics.candidateInvariantViolations.push(...mergedOccurrences.conflicts);
  const funnel = buildQualificationFunnel(filteredReports);
  const rejectionCount = funnel.candidates.filter((candidate) => candidate.primaryRejectionStage !== null).length;
  const inSampleTrades = trades.filter((trade) => trade.period === "in_sample");
  const outOfSampleTrades = trades.filter((trade) => trade.period === "out_of_sample");
  const selected = uniqueSorted(selectedDates);
  const activeContractByDate = partitions.map(({ tradingDate, contractSymbol }) => ({ tradingDate, contractSymbol }));
  const assumptions = [
    ...new Set(reports.flatMap((report) => report.assumptions)),
  ].filter((assumption) => !/^Historical replay uses exactly \d+ selected available trading dates;/.test(assumption));
  assumptions.push(
    `Historical replay uses exactly ${selected.length} selected available trading dates; excluded dates are reported separately.`,
  );
  const reportContract = {
    ...first.contract,
    fullContractSymbol: "MES multi-contract",
    contractMonth: "multi-contract",
  };
  return {
    ...first,
    symbol: first.symbol,
    contract: reportContract,
    dataset: {
      ...first.dataset,
      startDate: selected[0] ?? first.dataset.startDate,
      endDate: selected.at(-1) ?? first.dataset.endDate,
      requestedStartDate: selected[0] ?? first.dataset.requestedStartDate,
      requestedEndDate: selected.at(-1) ?? first.dataset.requestedEndDate,
      selectedDates: selected,
      inSampleDates: partitions.filter((partition) => partition.period === "in_sample").map((partition) => partition.tradingDate),
      outOfSampleDates: partitions.filter((partition) => partition.period === "out_of_sample").map((partition) => partition.tradingDate),
      excludedDates: [],
      scheduleVersion: first.dataset.scheduleVersion ?? null,
      rolloverBoundaries: first.dataset.rolloverBoundaries ?? [],
      activeContractByDate,
    },
    replay: {
      ...first.replay,
      cursor: Math.max(...reports.map((report) => report.replay.cursor)),
      visibleCandleCount: reports.reduce((sum, report) => sum + report.replay.visibleCandleCount, 0),
      totalCandleCount: reports.reduce((sum, report) => sum + report.replay.totalCandleCount, 0),
      visibleCandleCloseTime: reports.at(-1)?.replay.visibleCandleCloseTime ?? null,
    },
    metrics: calculateBacktestMetrics(trades, rejectionCount, audit),
    executionSummary,
    inSample: calculateBacktestMetrics(inSampleTrades, funnel.candidates.filter((candidate) => candidate.period === "in_sample" && candidate.primaryRejectionStage !== null).length, audit.filter((record) => record.period === "in_sample")),
    outOfSample: calculateBacktestMetrics(outOfSampleTrades, funnel.candidates.filter((candidate) => candidate.period === "out_of_sample" && candidate.primaryRejectionStage !== null).length, audit.filter((record) => record.period === "out_of_sample")),
    segments: buildSegments(trades, rejectionCount),
    trades,
    candidateExecutionEvidence,
    tradeCandidates,
    rejectedCandidateSignals,
    orphanModeledTrades,
    audit,
    occurrences,
    diagnostics,
    auditPage: {
      runId: BATCH_AUDIT_RUN_ID,
      page: 1,
      pageSize: 50,
      total: audit.length,
      hasMore: audit.length > 50,
    },
    assumptions,
    gapReport: combineGapReports(reports),
    batch: {
      totalPartitions: partitions.length,
      completedPartitions: reports.length,
      selectedDates: selected,
      contractPartitions: partitions.map(({ tradingDate, contractSymbol, period }) => ({ tradingDate, contractSymbol, period })),
      duplicateOccurrenceConflicts: mergedOccurrences.conflictDetails,
    },
    funnel,
    walkForward,
    accountReplay: buildBatchAccountReplay(trades, tradeCandidates),
  };
}

async function runPartitionSet(
  partitions: readonly BatchPartition[],
  backtestRequest: BacktestRequest,
  risk: BacktestWorkerInput["risk"],
  options: BatchRunnerOptions,
  emitProgress: boolean,
  sessionDiagnostics?: CatalogedSessionCacheDiagnostic[],
): Promise<BacktestReport[]> {
  const runPartition = options.runPartition ?? ((partitionInput, partitionOptions) => runBacktestInWorker(partitionInput, partitionOptions));
  const reports: BacktestReport[] = [];
  for (const [index, partition] of partitions.entries()) {
    abortIfNeeded(options.signal);
    if (emitProgress) {
      options.onProgress?.({
        status: "running",
        totalPartitions: partitions.length,
        completedPartitions: index,
        currentTradingDate: partition.tradingDate,
        currentContractSymbol: partition.contractSymbol,
        message: `Replaying ${partition.tradingDate} on ${partition.contractSymbol}.`,
      });
    }
    const run = () => runPartition(
      { request: backtestRequest, risk, replayDataset: partition.dataset },
      { timeoutMs: options.timeoutMs, signal: options.signal },
    );
    const descriptor = buildSessionResultCacheDescriptor(partition, backtestRequest, risk, options.sessionCache);
    const cacheKey = descriptor?.cacheKey ?? null;
    const sessionStartedAt = Date.now();
    let memoryHit = false;
    let persistentHit = false;
    let recomputed = false;
    let report: BacktestReport;
    try {
      report = descriptor && options.persistentSessionCache
        ? await options.persistentSessionCache.getOrCompute(
          descriptor,
          async () => sessionResultCache.getOrCompute(
            descriptor.cacheKey,
            run,
            (resolution) => {
              memoryHit = resolution === "memory_hit" || resolution === "pending_reuse";
              recomputed = resolution === "computed";
            },
          ),
          (resolution) => {
            persistentHit = resolution === "persistent_hit";
          },
        )
        : cacheKey
          ? await sessionResultCache.getOrCompute(cacheKey, run, (resolution) => {
            memoryHit = resolution === "memory_hit" || resolution === "pending_reuse";
            recomputed = resolution === "computed";
          })
          : await (async () => {
            recomputed = true;
            return run();
          })();
      if (descriptor && options.persistentSessionCache) {
        sessionResultCache.setComplete(descriptor.cacheKey, report);
      }
    } catch (error) {
      if (cacheKey && options.signal.aborted) {
        sessionResultCache.setIncomplete(
          cacheKey,
          error instanceof Error ? error.message : "Session computation did not complete.",
        );
      }
      throw error;
    }
    sessionDiagnostics?.push({
      tradingDate: partition.tradingDate,
      contractSymbol: partition.contractSymbol,
      cacheKey,
      memoryHit,
      persistentHit,
      recomputed,
      durationMs: Date.now() - sessionStartedAt,
    });
    reports.push(report);
    if (emitProgress) {
      options.onProgress?.({
        status: "running",
        totalPartitions: partitions.length,
        completedPartitions: index + 1,
        currentTradingDate: partition.tradingDate,
        currentContractSymbol: partition.contractSymbol,
        message: `Completed ${partition.tradingDate} on ${partition.contractSymbol}.`,
      });
    }
  }
  return reports;
}

export async function runBatchBacktest(
  input: {
    request: BatchBacktestRequest;
    risk?: BacktestWorkerInput["risk"];
    replayDataset: CausalReplayDataset;
  },
  options: BatchRunnerOptions,
): Promise<BatchBacktestReport> {
  const batchStartedAt = Date.now();
  const cacheStartedAt = new Date(batchStartedAt).toISOString();
  const sessionDiagnostics: CatalogedSessionCacheDiagnostic[] = [];
  const partitions = createPartitions(input.request, input.replayDataset);
  if (!partitions.length) throw new Error("No replay partitions contain completed candles.");
  const { selectedDates, ...backtestRequest } = input.request;
  options.onProgress?.({
    status: "running",
    totalPartitions: partitions.length,
    completedPartitions: 0,
    currentTradingDate: null,
    currentContractSymbol: null,
    message: "Batch queued; waiting for the first causal partition.",
  });
  const reports = await runPartitionSet(partitions, backtestRequest, input.risk, options, true, sessionDiagnostics);
  abortIfNeeded(options.signal);
  const dates = selectedDates ?? partitions.map((partition) => partition.tradingDate);
  const first = reports[0];
  if (!first) throw new Error("The batch produced no completed replay partitions.");
  const normalEvaluation = evaluateWalkForward({
    reports,
    partitions,
    selectedDates: dates,
    formulaHash: first.formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
  }, input.request.inSampleDays, input.request.outOfSampleDays);
  const specification = getFuturesContractSpecification(input.request.symbol);
  const baseCommission = input.request.ohlcvCommissionPerContract
    ?? 2 * (specification.commissionPerContract + specification.exchangeAndRegulatoryFeesPerContract);
  const baseSlippage = input.request.ohlcvSlippageTicks ?? 1;
  const higherCostRequest: BacktestRequest = {
    ...backtestRequest,
    slippageMode: "abnormal_spread",
    ohlcvSlippageTicks: baseSlippage + 1,
    ohlcvCommissionPerContract: Number((baseCommission * 1.5).toFixed(2)),
  };
  const adverseSlippageRequest: BacktestRequest = {
    ...backtestRequest,
    slippageMode: "abnormal_spread",
    ohlcvSlippageTicks: baseSlippage + 2,
    ohlcvCommissionPerContract: Number((baseCommission * 1.25).toFixed(2)),
  };
  if (options.includeSensitivity !== false) {
    const higherReports = await runPartitionSet(partitions, higherCostRequest, input.risk, options, false);
    const adverseReports = await runPartitionSet(partitions, adverseSlippageRequest, input.risk, options, false);
    const higherEvaluation = evaluateWalkForward({
      reports: higherReports,
      partitions,
      selectedDates: dates,
      formulaHash: first.formulaHash,
      formulaVersion: FIXED_FORMULA_VERSION,
    }, input.request.inSampleDays, input.request.outOfSampleDays);
    const adverseEvaluation = evaluateWalkForward({
      reports: adverseReports,
      partitions,
      selectedDates: dates,
      formulaHash: first.formulaHash,
      formulaVersion: FIXED_FORMULA_VERSION,
    }, input.request.inSampleDays, input.request.outOfSampleDays);
    normalEvaluation.sensitivity = [
      buildSensitivityCase(normalEvaluation, "normal", "Normal costs", [
        "The requested commission and slippage assumptions are unchanged.",
        "This is the descriptive baseline; it is not selected over the stress cases.",
      ]),
      buildSensitivityCase(higherEvaluation, "higher_cost", "Higher cost", [
        `Commission is increased to ${higherCostRequest.ohlcvCommissionPerContract?.toFixed(2)} per contract.`,
        `Adverse slippage is increased to ${higherCostRequest.ohlcvSlippageTicks} ticks per side.`,
        "The same dates, contracts, formula, and untouched holdout windows are replayed independently.",
      ]),
      buildSensitivityCase(adverseEvaluation, "adverse_slippage", "Adverse slippage", [
        `Commission is increased to ${adverseSlippageRequest.ohlcvCommissionPerContract?.toFixed(2)} per contract.`,
        `Adverse slippage is increased to ${adverseSlippageRequest.ohlcvSlippageTicks} ticks per side.`,
        "The same dates, contracts, formula, and untouched holdout windows are replayed independently.",
      ]),
    ];
  } else {
    normalEvaluation.sensitivity = [];
  }
  const aggregationStartedAt = Date.now();
  const result = aggregateBatchReports(reports, partitions, dates, normalEvaluation);
  const completedAt = new Date().toISOString();
  lastCatalogedBatchCacheDiagnostics = {
    startedAt: cacheStartedAt,
    completedAt,
    totalMs: Date.now() - batchStartedAt,
    aggregationMs: Date.now() - aggregationStartedAt,
    sessionCount: sessionDiagnostics.length,
    memoryHits: sessionDiagnostics.filter((session) => session.memoryHit).length,
    persistentHits: sessionDiagnostics.filter((session) => session.persistentHit).length,
    recomputations: sessionDiagnostics.filter((session) => session.recomputed).length,
    rawIndexSessionReuseCount: sessionDiagnostics.filter((session) => session.memoryHit || session.persistentHit).length,
    sessions: sessionDiagnostics,
  };
  options.onProgress?.({
    status: "completed",
    totalPartitions: partitions.length,
    completedPartitions: reports.length,
    currentTradingDate: null,
    currentContractSymbol: null,
    message: "All causal partitions completed; result is ready.",
  });
  return result;
}