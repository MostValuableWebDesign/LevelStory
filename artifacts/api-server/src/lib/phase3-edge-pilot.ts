import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { BacktestWorkerInput } from "./backtest-worker-client.js";
import { runBacktestInWorker } from "./backtest-worker-client.js";
import {
  calculateBacktestMetrics,
  type BacktestMetrics,
  type BacktestReport,
  type BacktestRequest,
  type BacktestTrade,
  type CausalReplayDataset,
  type HistoricalOccurrence,
  type HistoricalTradeCandidate,
} from "./phase9.js";
import { isValidCandidateManagementContext } from "./phase9.js";
import { FIXED_FORMULA_VERSION, formulaConfigurationHash } from "./formula-hash.js";
import {
  getFuturesContractSpecification,
  type FuturesContractSpecification,
} from "./futures/contracts.js";
import {
  sessionCalendarForContract,
  tradingDateForTimestamp,
  wallClockMinutesForTimestamp,
  type FuturesSessionCalendar,
} from "./futures/session-calendar.js";
import { activeShadowStrategySnapshot, type ActiveShadowStrategy } from "./active-shadow-strategy.js";
import { parseMesContractSymbol } from "./futures/multi-contract-replay.js";

export const PHASE3_PILOT_VERSION = "phase3-edge-validation-v1" as const;
export const PHASE3_IN_SAMPLE_DAYS = 20;
export const PHASE3_OUT_OF_SAMPLE_DAYS = 10;
export const PHASE3_TOTAL_DAYS = PHASE3_IN_SAMPLE_DAYS + PHASE3_OUT_OF_SAMPLE_DAYS;
export const PHASE3_ENTRY_CUTOFF_MINUTES = 13 * 60;

export const PHASE3_EDGES = [
  "ORB_PULLBACK_CONTINUATION",
  "PATIENCE_CANDLE_CONTINUATION",
  "CONSOLIDATION_BREAKOUT_CONTINUATION",
  "EQUIVALENT_CANDLE_REVERSAL",
] as const;
export type Phase3Edge = (typeof PHASE3_EDGES)[number];

export type Phase3PilotManifest = {
  manifestVersion: typeof PHASE3_PILOT_VERSION;
  manifestHash: string;
  createdAt: string;
  source: {
    kind: "historical_databento_multicontract";
    contentFingerprint: string;
    indexKey: string | null;
    selectedDates: string[];
    inSampleDates: string[];
    outOfSampleDates: string[];
  };
  formula: {
    version: string;
    hash: string;
    strategyKey: string;
    strategyVersionId: string | null;
    strategyVersionNumber: number | null;
    configuration: ActiveShadowStrategy["config"];
  };
  calendar: {
    timeZone: string;
    sessionTemplate: string;
    regularSessionStartMinutes: number;
    regularSessionEndMinutes: number;
    rolloverScheduleVersion: string | null;
  };
  candidateIdentity: {
    version: string;
    physicalOccurrenceKey: string;
    oneCandidatePerPhysicalSequence: true;
    immediateNextCandleOnly: true;
  };
  execution: {
    mode: "ohlcv_modeled";
    fillModel: "OHLCV_CONFIRMATION_THRESHOLD";
    confirmationBufferTicks: number;
    stopBufferTicks: number;
    entrySlippageTicks: number;
    exitSlippageTicks: number;
    commissionPerContract: number;
    entryWindow: {
      timeZone: string;
      startMinutes: number;
      endMinutesExclusive: number;
    };
  };
  assumptions: {
    costModel: string;
    noOptimization: true;
    untouchedOutOfSample: true;
    noFutureCandleAccess: true;
  };
};

export type Phase3PilotGate = {
  passed: boolean;
  violations: string[];
};

export type Phase3PilotCandidateEvidence = {
  candidate: HistoricalTradeCandidate;
  occurrences: HistoricalOccurrence[];
  trade: BacktestTrade | null;
  disposition:
    | "not_entered"
    | "entered_finalized"
    | "entered_open"
    | "entry_ambiguous"
    | "ambiguous_outcome"
    | "missing_management_context"
     | "invalid_management_context"
    | "unscored";
  exclusionReason: string | null;
};

export type Phase3PilotMetrics = {
  candidateCount: number;
  enteredCount: number;
  finalizedCount: number;
  openCount: number;
  ambiguousCount: number;
  missingContextCount: number;
  invalidContextCount: number;
  unscoredCount: number;
  excludedCount: number;
  realized: BacktestMetrics;
  grades: Record<"A" | "A+" | "A++", number>;
  directions: Record<"long" | "short", number>;
  entryTimeBuckets: Record<"09:30-10:00" | "10:00-11:00" | "11:00-12:00" | "12:00-13:00", number>;
  exclusionReasons: Record<string, number>;
};

export type Phase3PilotEdgeResult = {
  edge: Phase3Edge;
  all: Phase3PilotMetrics;
  inSample: Phase3PilotMetrics;
  outOfSample: Phase3PilotMetrics;
  candidates: Phase3PilotCandidateEvidence[];
};

export type Phase3PilotReport = {
  pilotId: string;
  status: "completed";
  manifest: Phase3PilotManifest;
  gate: Phase3PilotGate;
  selectedDates: string[];
  completedPartitions: number;
  totalPartitions: number;
  edgeResults: Phase3PilotEdgeResult[];
  overall: {
    all: Phase3PilotMetrics;
    inSample: Phase3PilotMetrics;
    outOfSample: Phase3PilotMetrics;
  };
  diagnostics: {
    candidateCount: number;
    tradeCount: number;
    occurrenceCount: number;
    auditCount: number;
    duplicateCandidateCount: number;
    duplicateTradeCount: number;
    lateEntryCount: number;
    futureAccessViolationCount: number;
    invariantViolations: string[];
  };
  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    resumedPartitions: number;
    newlyComputedPartitions: number;
  };
  compute: {
    partitionCount: number;
    candleCount: number;
    auditCount: number;
    boundedPartitionSize: 1;
  };
};

export type Phase3PilotProgress = {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  pilotId: string;
  totalPartitions: number;
  completedPartitions: number;
  currentTradingDate: string | null;
  currentContractSymbol: string | null;
  manifestHash: string;
  message: string;
  report?: Phase3PilotReport;
  error?: string | null;
};

export type Phase3PilotPartition = {
  tradingDate: string;
  contractSymbol: string;
  period: "in_sample" | "out_of_sample";
  dataset: CausalReplayDataset;
};

export type Phase3PilotRunOptions = {
  pilotId?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  now?: () => number;
  runPartition?: (
    input: BacktestWorkerInput,
    options: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<BacktestReport>;
  loadCheckpoint?: (manifestHash: string) => Promise<Phase3Checkpoint | null>;
  saveCheckpoint?: (checkpoint: Phase3Checkpoint) => Promise<void>;
  onProgress?: (progress: Phase3PilotProgress) => void;
};

export type Phase3Checkpoint = {
  pilotId: string;
  manifest: Phase3PilotManifest;
  reports: Array<{ tradingDate: string; contractSymbol: string; period: "in_sample" | "out_of_sample"; report: BacktestReport }>;
  updatedAt: string;
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashManifest(manifest: Omit<Phase3PilotManifest, "manifestHash" | "createdAt">): string {
  return createHash("sha256").update(stableSerialize(manifest)).digest("hex");
}

function assertSortedUniqueDates(dates: readonly string[], label: string): void {
  const sorted = [...dates].sort();
  if (dates.length !== new Set(dates).size || sorted.some((date, index) => date !== dates[index])) {
    throw new Error(`${label} must be sorted and contain unique trading dates.`);
  }
}

export function buildPhase3PilotManifest(input: {
  dataset: CausalReplayDataset;
  request: BacktestRequest;
  strategy?: ActiveShadowStrategy;
  createdAt?: string;
  indexKey?: string | null;
}): Phase3PilotManifest {
  const strategy = input.strategy ?? activeShadowStrategySnapshot();
  const inSampleDates = [...input.dataset.inSampleDates];
  const outOfSampleDates = [...input.dataset.outOfSampleDates];
  const selectedDates = [...(input.dataset.selectedDates ?? [...inSampleDates, ...outOfSampleDates])];
  assertSortedUniqueDates(inSampleDates, "In-sample dates");
  assertSortedUniqueDates(outOfSampleDates, "Out-of-sample dates");
  assertSortedUniqueDates(selectedDates, "Selected dates");
  if (inSampleDates.length !== PHASE3_IN_SAMPLE_DAYS || outOfSampleDates.length !== PHASE3_OUT_OF_SAMPLE_DAYS) {
    throw new Error(`Phase 3 requires exactly ${PHASE3_IN_SAMPLE_DAYS} in-sample and ${PHASE3_OUT_OF_SAMPLE_DAYS} out-of-sample sessions.`);
  }
  if (selectedDates.length !== PHASE3_TOTAL_DAYS
    || selectedDates.join("|") !== [...inSampleDates, ...outOfSampleDates].join("|")) {
    throw new Error("Phase 3 selected dates must be the exact chronological 20/10 split.");
  }
  if (input.dataset.source !== "historical_databento_multicontract" || !input.dataset.contentFingerprint) {
    throw new Error("Phase 3 requires the ready multi-contract historical index fingerprint.");
  }
  const specification = getFuturesContractSpecification("MES");
  const config = strategy.config;
  const formulaHash = formulaConfigurationHash(input.request, config);
  const partial: Omit<Phase3PilotManifest, "manifestHash" | "createdAt"> = {
    manifestVersion: PHASE3_PILOT_VERSION,
    source: {
      kind: "historical_databento_multicontract",
      contentFingerprint: input.dataset.contentFingerprint,
      indexKey: input.indexKey ?? null,
      selectedDates,
      inSampleDates,
      outOfSampleDates,
    },
    formula: {
      version: strategy.formulaVersion || FIXED_FORMULA_VERSION,
      hash: formulaHash,
      strategyKey: strategy.strategyKey,
      strategyVersionId: strategy.versionId,
      strategyVersionNumber: strategy.versionNumber,
      configuration: config,
    },
    calendar: {
      timeZone: config.sessionTimeZone,
      sessionTemplate: "CME equity-index / America/New_York · 04:00–16:00 ET",
      regularSessionStartMinutes: config.sessionStartMinutes,
      regularSessionEndMinutes: config.primaryEntryEndMinutes,
      rolloverScheduleVersion: input.dataset.contractSchedule?.version ?? null,
    },
    candidateIdentity: {
      version: "physical-p-to-e-sequence-v2",
      physicalOccurrenceKey: "sourceFingerprint|formulaHash|contractSymbol|tradingDate|direction|pOpenTimestamp|eOpenTimestamp",
      oneCandidatePerPhysicalSequence: true,
      immediateNextCandleOnly: true,
    },
    execution: {
      mode: "ohlcv_modeled",
      fillModel: "OHLCV_CONFIRMATION_THRESHOLD",
      confirmationBufferTicks: input.request.ohlcvEntryBufferTicks ?? config.patienceEntryBufferTicks,
      stopBufferTicks: input.request.ohlcvStopBufferTicks ?? config.patienceStopBufferTicks,
      entrySlippageTicks: input.request.ohlcvSlippageTicks ?? config.phase7NormalSlippageTicks,
      exitSlippageTicks: input.request.ohlcvSlippageTicks ?? config.phase7NormalSlippageTicks,
      commissionPerContract: input.request.ohlcvCommissionPerContract
        ?? 2 * (specification.commissionPerContract + specification.exchangeAndRegulatoryFeesPerContract),
      entryWindow: {
        timeZone: config.sessionTimeZone,
        startMinutes: config.primaryEntryStartMinutes,
        endMinutesExclusive: config.primaryEntryEndMinutes,
      },
    },
    assumptions: {
      costModel: "Configured MES OHLCV modeled fill, commission, and adverse slippage assumptions.",
      noOptimization: true,
      untouchedOutOfSample: true,
      noFutureCandleAccess: true,
    },
  };
  return {
    ...partial,
    manifestHash: hashManifest(partial),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function buildPhase3PilotPartitions(
  dataset: CausalReplayDataset,
): Phase3PilotPartition[] {
  const calendar = sessionCalendarForContract(getFuturesContractSpecification("MES"));
  const dates = [...dataset.inSampleDates, ...dataset.outOfSampleDates];
  const holdout = new Set(dataset.outOfSampleDates);
  const contractByDate = new Map(
    dataset.contractSchedule?.activeContractByDate?.map((item) => [item.tradingDate, item.contractSymbol]) ?? [],
  );
  return dates.map((tradingDate) => {
    const contractSymbol = contractByDate.get(tradingDate)
      ?? dataset.candles.find((candle) => tradingDateForTimestamp(candle.openTime, calendar) === tradingDate)?.contractSymbol
      ?? dataset.contractSymbol;
    if (!contractSymbol) throw new Error(`No contract is available for Phase 3 date ${tradingDate}.`);
    const candles = dataset.candles.filter((candle) =>
      candle.contractSymbol === contractSymbol
      && tradingDateForTimestamp(candle.openTime, calendar) === tradingDate,
    );
    if (!candles.length) throw new Error(`Phase 3 date ${tradingDate} has no completed candles for ${contractSymbol}.`);
    const identity = parseMesContractSymbol(contractSymbol);
    return {
      tradingDate,
      contractSymbol,
      period: holdout.has(tradingDate) ? "out_of_sample" : "in_sample",
      dataset: {
        ...dataset,
        candles,
        oneMinute: (dataset.oneMinute ?? []).filter((bar) => tradingDateForTimestamp(bar.openTime, calendar) === tradingDate),
        contractSymbol,
        contractMonth: identity?.contractMonth ?? dataset.contractMonth,
        selectedDates: [tradingDate],
        inSampleDates: holdout.has(tradingDate) ? [] : [tradingDate],
        outOfSampleDates: holdout.has(tradingDate) ? [tradingDate] : [],
        requestedStartDate: tradingDate,
        requestedEndDate: tradingDate,
        excludedDates: [],
        contractSchedule: dataset.contractSchedule
          ? {
              version: dataset.contractSchedule.version,
              activeContractByDate: [{ tradingDate, contractSymbol }],
              boundaries: dataset.contractSchedule.boundaries,
            }
          : undefined,
      },
    };
  });
}

function timeBucket(timestamp: string): keyof Phase3PilotMetrics["entryTimeBuckets"] | null {
  const minutes = wallClockMinutesForTimestamp(Date.parse(timestamp));
  if (minutes < 570 || minutes >= PHASE3_ENTRY_CUTOFF_MINUTES) return null;
  if (minutes < 600) return "09:30-10:00";
  if (minutes < 660) return "10:00-11:00";
  if (minutes < 720) return "11:00-12:00";
  return "12:00-13:00";
}

function emptyMetrics(): Phase3PilotMetrics {
  return {
    candidateCount: 0,
    enteredCount: 0,
    finalizedCount: 0,
    openCount: 0,
    ambiguousCount: 0,
    missingContextCount: 0,
    invalidContextCount: 0,
    unscoredCount: 0,
    excludedCount: 0,
    realized: calculateBacktestMetrics([]),
    grades: { A: 0, "A+": 0, "A++": 0 },
    directions: { long: 0, short: 0 },
    entryTimeBuckets: { "09:30-10:00": 0, "10:00-11:00": 0, "11:00-12:00": 0, "12:00-13:00": 0 },
    exclusionReasons: {},
  };
}

function addReason(metrics: Phase3PilotMetrics, reason: string): void {
  metrics.exclusionReasons[reason] = (metrics.exclusionReasons[reason] ?? 0) + 1;
}

function isAmbiguousTrade(trade: BacktestTrade): boolean {
  return Boolean(trade.ambiguityLabel)
    || Boolean(trade.audit?.ambiguityLabels.length);
}

function summarizeEvidence(
  candidates: readonly HistoricalTradeCandidate[],
  reports: readonly { report: BacktestReport; period: "in_sample" | "out_of_sample" }[],
  occurrences: readonly HistoricalOccurrence[],
): Phase3PilotCandidateEvidence[] {
  const tradeByCandidate = new Map<string, BacktestTrade>();
  for (const item of reports) {
    for (const trade of item.report.trades) {
      if (trade.candidateId && !tradeByCandidate.has(trade.candidateId)) tradeByCandidate.set(trade.candidateId, trade);
    }
  }
  const occurrenceBySignal = new Map<string, HistoricalOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = occurrenceBySignal.get(occurrence.occurrenceId) ?? [];
    list.push(occurrence);
    occurrenceBySignal.set(occurrence.occurrenceId, list);
  }
  return candidates.map((candidate) => {
    const trade = tradeByCandidate.get(candidate.candidateId) ?? null;
    let disposition: Phase3PilotCandidateEvidence["disposition"] = "not_entered";
    let exclusionReason: string | null = null;
    if (candidate.executionStatus === "ENTRY_AMBIGUOUS") {
      disposition = "entry_ambiguous";
      exclusionReason = "ENTRY_AMBIGUOUS";
    } else if (candidate.executionStatus === "INSUFFICIENT_CANDLE_DATA") {
      disposition = "unscored";
      exclusionReason = "INSUFFICIENT_CANDLE_DATA";
    } else if (candidate.executionStatus === "MODELED_TRADE_CREATED") {
      if (!isValidCandidateManagementContext(candidate)) {
        const status = candidate.managementContext?.managementEvidenceStatus;
        disposition = status === "invalid" ? "invalid_management_context" : "missing_management_context";
        exclusionReason = status === "invalid"
          ? candidate.managementContext?.missingEvidenceReasons.join(", ") || "INVALID_MANAGEMENT_GEOMETRY"
          : candidate.managementContext?.missingEvidenceReasons.join(", ") || "MISSING_MANAGEMENT_CONTEXT";
      } else if (!trade) {
        disposition = "unscored";
        exclusionReason = "MODELED_TRADE_MISSING";
      } else if (trade.outcome === "open") {
        disposition = "entered_open";
        exclusionReason = "OPEN_TRADE";
      } else if (isAmbiguousTrade(trade)) {
        disposition = "ambiguous_outcome";
        exclusionReason = trade.ambiguityLabel ?? "UNRESOLVED_EXIT_AMBIGUITY";
      } else {
        disposition = "entered_finalized";
      }
    } else if (candidate.executionStatus === "ENTRY_NOT_REACHED") {
      exclusionReason = "ENTRY_NOT_REACHED";
    }
    return {
      candidate,
      occurrences: occurrenceBySignal.get(candidate.signalOccurrenceId) ?? [],
      trade,
      disposition,
      exclusionReason,
    };
  });
}

function metricsForEvidence(evidence: readonly Phase3PilotCandidateEvidence[]): Phase3PilotMetrics {
  const result = emptyMetrics();
  const realized: BacktestTrade[] = [];
  for (const item of evidence) {
    result.candidateCount += 1;
    result.grades[item.candidate.grade] += 1;
    result.directions[item.candidate.direction] += 1;
    const bucket = timeBucket(item.candidate.entryObservationTimestamp);
    if (bucket) result.entryTimeBuckets[bucket] += 1;
    if (item.disposition === "not_entered") {
      result.excludedCount += 1;
      if (item.exclusionReason) addReason(result, item.exclusionReason);
      continue;
    }
    if (item.disposition === "entry_ambiguous" || item.disposition === "ambiguous_outcome") {
      result.ambiguousCount += 1;
      result.excludedCount += 1;
      addReason(result, item.exclusionReason ?? "AMBIGUOUS_OUTCOME");
      continue;
    }
    if (item.disposition === "unscored") {
      result.unscoredCount += 1;
      result.excludedCount += 1;
      addReason(result, item.exclusionReason ?? "UNSCORED");
      continue;
    }
    if (item.disposition === "missing_management_context") {
      result.missingContextCount += 1;
      result.excludedCount += 1;
      addReason(result, item.exclusionReason ?? "MISSING_MANAGEMENT_CONTEXT");
      continue;
    }
    if (item.disposition === "invalid_management_context") {
      result.invalidContextCount += 1;
      result.excludedCount += 1;
      addReason(result, item.exclusionReason ?? "INVALID_MANAGEMENT_GEOMETRY");
      continue;
    }
    result.enteredCount += 1;
    if (item.disposition === "entered_open") {
      result.openCount += 1;
      result.excludedCount += 1;
      addReason(result, "OPEN_TRADE");
    } else if (item.trade) {
      result.finalizedCount += 1;
      realized.push(item.trade);
    }
  }
  result.realized = calculateBacktestMetrics(realized);
  return result;
}

function matchesEdge(candidate: HistoricalTradeCandidate, edge: Phase3Edge): boolean {
  // Edge totals are independent primary-edge populations. Secondary matches
  // remain in the candidate evidence as confluence, but must not multiply the
  // same physical P→E sequence into every edge result.
  return candidate.primaryEdge === edge;
}

function deduplicateCandidates(reports: readonly BacktestReport[]): {
  candidates: HistoricalTradeCandidate[];
  duplicateCount: number;
} {
  const byPhysical = new Map<string, HistoricalTradeCandidate>();
  let duplicateCount = 0;
  for (const report of reports) {
    for (const candidate of report.tradeCandidates) {
      const key = [
        candidate.sourceFingerprint,
        candidate.formulaHash,
        candidate.contractSymbol,
        candidate.tradingDate,
        candidate.direction,
        candidate.pOpenTimestamp,
        candidate.eOpenTimestamp,
      ].join("|");
      const previous = byPhysical.get(key);
      if (previous) {
        duplicateCount += 1;
        previous.matchedEdges = [...new Set([...previous.matchedEdges, ...candidate.matchedEdges, candidate.primaryEdge])];
        previous.supportingConfluences = [...new Set([...previous.supportingConfluences, ...candidate.supportingConfluences])];
        previous.qualifyingLevelIdentifiers = [...new Set([
          ...previous.qualifyingLevelIdentifiers,
          ...candidate.qualifyingLevelIdentifiers,
        ])].sort();
        previous.qualifyingLevelValues = {
          ...candidate.qualifyingLevelValues,
          ...previous.qualifyingLevelValues,
        };
      } else {
        byPhysical.set(key, { ...candidate, matchedEdges: [...candidate.matchedEdges] });
      }
    }
  }
  return { candidates: [...byPhysical.values()], duplicateCount };
}

function gateReports(
  reports: readonly BacktestReport[],
  candidates: readonly HistoricalTradeCandidate[],
): Phase3PilotGate {
  const violations: string[] = [];
  for (const report of reports) {
    if (!report.replay.causal || report.replay.futureCandleAccess) violations.push("REPLAY_CAUSALITY_GATE_FAILED");
    if (report.dataset.untouchedOutOfSample !== true || report.dataset.optimizationApplied !== false) {
      violations.push("HOLDOUT_INTEGRITY_GATE_FAILED");
    }
    for (const candidate of report.tradeCandidates) {
      const entryTimestamp = Date.parse(candidate.entryObservationTimestamp);
      if (!Number.isFinite(entryTimestamp) || wallClockMinutesForTimestamp(entryTimestamp) >= PHASE3_ENTRY_CUTOFF_MINUTES) {
        violations.push(`LATE_ENTRY:${candidate.candidateId}`);
      }
      if (candidate.executionStatus === "MODELED_TRADE_CREATED" && !isValidCandidateManagementContext(candidate)) {
        // This is a reportable exclusion, not a reason to fabricate a realized result.
        continue;
      }
    }
  }
  const physicalKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = [
      candidate.sourceFingerprint,
      candidate.formulaHash,
      candidate.contractSymbol,
      candidate.tradingDate,
      candidate.direction,
      candidate.pOpenTimestamp,
      candidate.eOpenTimestamp,
    ].join("|");
    if (physicalKeys.has(key)) violations.push(`DUPLICATE_PHYSICAL_CANDIDATE:${key}`);
    physicalKeys.add(key);
  }
  return { passed: violations.length === 0, violations: [...new Set(violations)] };
}

function buildMetrics(
  candidates: readonly HistoricalTradeCandidate[],
  reports: readonly { report: BacktestReport; period: "in_sample" | "out_of_sample" }[],
  occurrences: readonly HistoricalOccurrence[],
  edge: Phase3Edge | null,
): { all: Phase3PilotMetrics; inSample: Phase3PilotMetrics; outOfSample: Phase3PilotMetrics; candidates: Phase3PilotCandidateEvidence[] } {
  const filtered = edge ? candidates.filter((candidate) => matchesEdge(candidate, edge)) : candidates;
  const evidence = summarizeEvidence(filtered, reports, occurrences);
  const inSampleIds = new Set(reports.filter((item) => item.period === "in_sample").flatMap((item) => item.report.tradeCandidates.map((candidate) => candidate.candidateId)));
  const inSample = evidence.filter((item) => inSampleIds.has(item.candidate.candidateId));
  return {
    all: metricsForEvidence(evidence),
    inSample: metricsForEvidence(inSample),
    outOfSample: metricsForEvidence(evidence.filter((item) => !inSampleIds.has(item.candidate.candidateId))),
    candidates: evidence,
  };
}

export async function runPhase3EdgePilot(
  input: {
    manifest: Phase3PilotManifest;
    request: BacktestRequest;
    partitions: readonly Phase3PilotPartition[];
    risk?: BacktestWorkerInput["risk"];
  },
  options: Phase3PilotRunOptions,
): Promise<Phase3PilotReport> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const pilotId = options.pilotId ?? randomUUID();
  const signal = options.signal ?? new AbortController().signal;
  const runPartition = options.runPartition ?? ((workerInput, workerOptions) => runBacktestInWorker(workerInput, workerOptions));
  const checkpoint = options.loadCheckpoint ? await options.loadCheckpoint(input.manifest.manifestHash) : null;
  const completed = new Map(
    checkpoint?.reports.map((item) => [`${item.tradingDate}|${item.contractSymbol}`, item]) ?? [],
  );
  const reports: Array<{ tradingDate: string; contractSymbol: string; period: "in_sample" | "out_of_sample"; report: BacktestReport }> = [];
  for (const partition of input.partitions) {
    const key = `${partition.tradingDate}|${partition.contractSymbol}`;
    const cached = completed.get(key);
    if (cached) {
      reports.push(cached);
      continue;
    }
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("PHASE3_PILOT_CANCELLED");
    options.onProgress?.({
      status: "running",
      pilotId,
      totalPartitions: input.partitions.length,
      completedPartitions: reports.length,
      currentTradingDate: partition.tradingDate,
      currentContractSymbol: partition.contractSymbol,
      manifestHash: input.manifest.manifestHash,
      message: `Replaying Phase 3 edge pilot date ${partition.tradingDate}.`,
    });
    const report = await runPartition(
      {
        request: {
          ...input.request,
          startDate: partition.tradingDate,
          endDate: partition.tradingDate,
          inSampleDays: 1,
          outOfSampleDays: 0,
          source: "historical_databento_multicontract",
          executionMode: "ohlcv_modeled",
        },
        risk: input.risk,
        replayDataset: partition.dataset,
      },
      { timeoutMs: options.timeoutMs, signal },
    );
    if (report.tradeCandidates.some((candidate) => Date.parse(candidate.entryObservationTimestamp) >= 0
      && wallClockMinutesForTimestamp(Date.parse(candidate.entryObservationTimestamp)) >= PHASE3_ENTRY_CUTOFF_MINUTES)) {
      throw new Error(`Phase 3 refuses late entry evidence on ${partition.tradingDate}.`);
    }
    const item = { tradingDate: partition.tradingDate, contractSymbol: partition.contractSymbol, period: partition.period, report };
    reports.push(item);
    if (options.saveCheckpoint) {
      await options.saveCheckpoint({
        pilotId,
        manifest: input.manifest,
        reports,
        updatedAt: new Date(now()).toISOString(),
      });
    }
    options.onProgress?.({
      status: "running",
      pilotId,
      totalPartitions: input.partitions.length,
      completedPartitions: reports.length,
      currentTradingDate: partition.tradingDate,
      currentContractSymbol: partition.contractSymbol,
      manifestHash: input.manifest.manifestHash,
      message: `Completed Phase 3 edge pilot date ${partition.tradingDate}.`,
    });
  }
  const reportList = reports.map((item) => item.report);
  const deduped = deduplicateCandidates(reportList);
  const occurrences = reportList.flatMap((report) => report.occurrences);
  const gate = gateReports(reportList, deduped.candidates);
  if (!gate.passed) throw new Error(`Phase 3 prerequisite gate failed: ${gate.violations.join(", ")}`);
  const overall = buildMetrics(deduped.candidates, reports, occurrences, null);
  const edgeResults = PHASE3_EDGES.map((edge) => {
    const result = buildMetrics(deduped.candidates, reports, occurrences, edge);
    return { edge, ...result };
  });
  const duplicateTradeIds = new Set<string>();
  const trades = reportList.flatMap((report) => report.trades);
  const uniqueTradeKeys = new Set<string>();
  for (const trade of trades) {
    const key = trade.candidateId ?? trade.signalOccurrenceId ?? trade.id;
    if (uniqueTradeKeys.has(key)) duplicateTradeIds.add(key);
    uniqueTradeKeys.add(key);
  }
  const lateEntryCount = reportList.flatMap((report) => report.tradeCandidates)
    .filter((candidate) => {
    const timestamp = Date.parse(candidate.entryObservationTimestamp);
      return Number.isFinite(timestamp) && wallClockMinutesForTimestamp(timestamp) >= PHASE3_ENTRY_CUTOFF_MINUTES;
    }).length;
  const completedAtMs = now();
  const result: Phase3PilotReport = {
    pilotId,
    status: "completed",
    manifest: input.manifest,
    gate,
    selectedDates: input.manifest.source.selectedDates,
    completedPartitions: reports.length,
    totalPartitions: input.partitions.length,
    edgeResults,
    overall,
    diagnostics: {
      candidateCount: deduped.candidates.length,
      tradeCount: uniqueTradeKeys.size,
      occurrenceCount: occurrences.length,
      auditCount: reportList.reduce((sum, report) => sum + report.audit.length, 0),
      duplicateCandidateCount: deduped.duplicateCount,
      duplicateTradeCount: duplicateTradeIds.size,
      lateEntryCount,
      futureAccessViolationCount: reportList.filter((report) => report.replay.futureCandleAccess).length,
      invariantViolations: [],
    },
    timing: {
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      resumedPartitions: checkpoint?.reports.length ?? 0,
      newlyComputedPartitions: reports.length - (checkpoint?.reports.length ?? 0),
    },
    compute: {
      partitionCount: reports.length,
      candleCount: reportList.reduce((sum, report) => sum + report.replay.totalCandleCount, 0),
      auditCount: reportList.reduce((sum, report) => sum + report.audit.length, 0),
      boundedPartitionSize: 1,
    },
  };
  if (options.saveCheckpoint) {
    await options.saveCheckpoint({ pilotId, manifest: input.manifest, reports, updatedAt: new Date(completedAtMs).toISOString() });
  }
  options.onProgress?.({
    status: "completed",
    pilotId,
    totalPartitions: input.partitions.length,
    completedPartitions: reports.length,
    currentTradingDate: null,
    currentContractSymbol: null,
    manifestHash: input.manifest.manifestHash,
    message: "Phase 3 edge validation pilot completed.",
    report: result,
  });
  return result;
}

export function createPhase3PilotCheckpointStore(root = join(process.cwd(), ".cache", "levelstory-phase3-pilots")) {
  return {
    async load(manifestHash: string): Promise<Phase3Checkpoint | null> {
      try {
        const raw = await readFile(join(root, `${manifestHash}.json`), "utf8");
        const checkpoint = JSON.parse(raw) as Phase3Checkpoint;
        if (checkpoint.manifest.manifestHash !== manifestHash) return null;
        return checkpoint;
      } catch {
        return null;
      }
    },
    async save(checkpoint: Phase3Checkpoint): Promise<void> {
      await mkdir(root, { recursive: true });
      const target = join(root, `${checkpoint.manifest.manifestHash}.json`);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(checkpoint), "utf8");
      await rename(temporary, target);
    },
  };
}