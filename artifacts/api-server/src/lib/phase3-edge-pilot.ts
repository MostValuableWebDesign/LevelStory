import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { BacktestWorkerInput } from "./backtest-worker-client.js";
import { runBacktestInWorker } from "./backtest-worker-client.js";
import {
  buildHistoricalOccurrenceLedger,
  calculateBacktestMetrics,
  historicalReplayDiagnostics,
  projectHistoricalTradeCandidates,
  reduceHistoricalPullbackLifecycles,
  type BacktestMetrics,
  type BacktestReport,
  type BacktestRequest,
  type BacktestTrade,
  type CausalReplayDataset,
  type HistoricalOccurrence,
  type HistoricalTradeCandidate,
  type OrphanModeledTrade,
  type RejectedCandidateSignal,
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
import {
  parseMesContractSymbol,
  validateMultiContractContentFingerprint,
} from "./futures/multi-contract-replay.js";

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
  reconciliation: Phase3SignalReconciliationReport;
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

export type Phase3SignalDisposition =
  | "candidate_entered_finalized"
  | "candidate_entered_open"
  | "candidate_entry_ambiguous"
  | "candidate_unscored"
  | "candidate_not_entered"
  | "candidate_missing_management"
  | "candidate_invalid_management"
  | "rejected_missing_edge_requirement"
  | "rejected_outside_primary_entry_window"
  | "rejected_invalid_causal_identity"
  | "rejected_multiple_predicates"
  | "unexplained_confirmed_signal"
  | "contradictory_projection";

export type Phase3SignalLevelEvidence = {
  levelIdentifier: string;
  timestamp: string | null;
  value: number | null;
  distanceTicks: number | null;
  toleranceTicks: number | null;
  interactionTypes: string[];
  ruleResult: "QUALIFIED";
  auditIds: string[];
};

export type Phase3SignalEdgePredicate = {
  predicateName: string;
  result: "PASS" | "FAIL" | "EVIDENCE_UNAVAILABLE";
  reason: string;
  sourceAuditId: string | null;
  evidenceTimestamp: string | null;
};

export type Phase3ConfluenceEvidence = {
  confluenceType: string;
  evidenceTimestamp: string | null;
  evidenceValue: number | null;
  ruleState: string;
  sourceAuditId: string | null;
  predicateResult: "PASS" | "FAIL" | "UNVERIFIED_CONFLUENCE_LABEL";
  gradeEligible: boolean;
};

export type Phase3SignalReconciliation = {
  signalOccurrenceId: string;
  period: "in_sample" | "out_of_sample";
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  direction: "long" | "short" | null;
  causalIdentity: {
    lTimestamp: string | null;
    pOpenTimestamp: string | null;
    eOpenTimestamp: string | null;
    entryObservationTimestamp: string | null;
  };
  threshold: {
    confirmationThreshold: number | null;
    confirmationExcursion: number | null;
    confirmationBufferTicks: number | null;
    reached: boolean | null;
  };
  directionSource: string | null;
  directionSources: string[];
  primaryEdge: string | null;
  matchedEdges: string[];
  levelEvidence: Phase3SignalLevelEvidence[];
  edgePredicates: Record<Phase3Edge, Phase3SignalEdgePredicate[]>;
  confluenceEvidence: Phase3ConfluenceEvidence[];
  timing: {
    entryTimeBucket: keyof Phase3PilotMetrics["entryTimeBuckets"] | null;
    beforeExclusiveCutoff: boolean;
  };
  rejection: {
    reasonCodes: string[];
    details: string[];
  } | null;
  candidate: {
    candidateId: string;
    executionStatus: HistoricalTradeCandidate["executionStatus"];
    managementEvidenceStatus: string | null;
  } | null;
  trade: {
    tradeId: string;
    outcome: BacktestTrade["outcome"];
    netPnl: number;
    ambiguityLabel: string | null;
  } | null;
  disposition: Phase3SignalDisposition;
};

export type Phase3OrphanReconciliation = OrphanModeledTrade & {
  period: "in_sample" | "out_of_sample";
  tradingDate: string;
  contractSymbol: string;
  exactSignalMatch: boolean;
  resolution: "resolved_exact_candidate" | "excluded_no_exact_candidate" | "excluded_candidate_conflict";
};

export type Phase3SignalReconciliationReport = {
  version: "phase3-signal-reconciliation-v1";
  reconciliationErrors: Array<{
    code: "PHASE3_PARTITION_MISSING" | "PHASE3_AUDIT_STREAM_MISSING" | "PHASE3_LIFECYCLE_RECONCILIATION_UNAVAILABLE";
    tradingDate: string;
    contractSymbol: string;
    detail: string;
  }>;
  confirmedSignalCount: number;
  dispositionCounts: Record<Phase3SignalDisposition, number>;
  dispositionReconciles: boolean;
  invariantViolations: string[];
  signals: Phase3SignalReconciliation[];
  candidateConfluences: Array<{
    candidateId: string;
    signalOccurrenceId: string;
    evidence: Phase3SignalLevelEvidence[];
    structuredEvidence: Phase3ConfluenceEvidence[];
    genericLabelsWithoutStructuredEvidence: string[];
  }>;
  edgeAudit: Array<{
    edge: Phase3Edge;
    primaryCount: number;
    matchedCount: number;
    candidateCount: number;
    independentPrimaryPopulation: "reported" | "empty";
    explanation: string;
  }>;
  orphanTrades: Phase3OrphanReconciliation[];
  timeBuckets: Record<string, {
    confirmed: number;
    candidates: number;
    rejected: number;
    entered: number;
  }>;
  sourceFingerprint: {
    fingerprints: string[];
    components: Array<{ filename: string; contractSymbol: string; fingerprint: string }>;
    allSame: boolean;
    validShape: boolean;
    malformedSignals: string[];
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
  reports: Array<{
    tradingDate: string;
    contractSymbol: string;
    period: "in_sample" | "out_of_sample";
    report: BacktestReport;
    syntheticFixture?: true;
  }>;
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

type Phase3PilotReportItem = Phase3Checkpoint["reports"][number];
type Phase3ReportWithOrphanHistory = BacktestReport & {
  phase3OrphanHistory?: readonly OrphanModeledTrade[];
  syntheticFixture?: true;
};

const RECONCILIATION_BUCKETS = [
  "09:30-10:00",
  "10:00-11:00",
  "11:00-12:00",
  "12:00-13:00",
  "OUTSIDE_ENTRY_WINDOW",
] as const;

function emptyDispositionCounts(): Record<Phase3SignalDisposition, number> {
  return {
    candidate_entered_finalized: 0,
    candidate_entered_open: 0,
    candidate_entry_ambiguous: 0,
    candidate_unscored: 0,
    candidate_not_entered: 0,
    candidate_missing_management: 0,
    candidate_invalid_management: 0,
    rejected_missing_edge_requirement: 0,
    rejected_outside_primary_entry_window: 0,
    rejected_invalid_causal_identity: 0,
    rejected_multiple_predicates: 0,
    unexplained_confirmed_signal: 0,
    contradictory_projection: 0,
  };
}

function levelEvidenceForOccurrence(occurrence: HistoricalOccurrence): Phase3SignalLevelEvidence[] {
  const auditIds = [...new Set(occurrence.auditIds ?? [occurrence.auditId])].sort();
  return occurrence.levelIdentifiers.map((levelIdentifier) => ({
    levelIdentifier,
    timestamp: occurrence.lTimestamp,
    value: occurrence.levelValues[levelIdentifier] ?? null,
    distanceTicks: occurrence.levelDistancesTicks[levelIdentifier] ?? null,
    toleranceTicks: occurrence.levelToleranceTicks[levelIdentifier] ?? null,
    interactionTypes: [...(occurrence.levelInteractionTypes[levelIdentifier] ?? [])].sort(),
    ruleResult: "QUALIFIED",
    auditIds,
  }));
}

function dispositionForSignal(
  candidate: HistoricalTradeCandidate | null,
  rejection: RejectedCandidateSignal | null,
  trade: BacktestTrade | null,
): Phase3SignalDisposition {
  if (candidate && rejection) return "contradictory_projection";
  if (rejection) {
    const reasons = new Set(rejection.reasonCodes);
    if (reasons.size > 1) return "rejected_multiple_predicates";
    if (reasons.has("MISSING_EDGE_REQUIREMENT")) return "rejected_missing_edge_requirement";
    if (reasons.has("OUTSIDE_PRIMARY_ENTRY_WINDOW")) return "rejected_outside_primary_entry_window";
    if (reasons.has("INVALID_CAUSAL_IDENTITY")) return "rejected_invalid_causal_identity";
    return "rejected_multiple_predicates";
  }
  if (!candidate) return "unexplained_confirmed_signal";
  if (candidate.executionStatus === "ENTRY_AMBIGUOUS") return "candidate_entry_ambiguous";
  if (candidate.executionStatus === "INSUFFICIENT_CANDLE_DATA") return "candidate_unscored";
  if (candidate.executionStatus === "ENTRY_NOT_REACHED") return "candidate_not_entered";
  if (candidate.executionStatus === "MODELED_TRADE_CREATED" && !isValidCandidateManagementContext(candidate)) {
    return candidate.managementContext?.managementEvidenceStatus === "invalid"
      ? "candidate_invalid_management"
      : "candidate_missing_management";
  }
  if (!trade) return "candidate_unscored";
  if (trade.outcome === "open") return "candidate_entered_open";
  if (isAmbiguousTrade(trade)) return "candidate_entry_ambiguous";
  return "candidate_entered_finalized";
}

const EDGE_PREDICATE_NAMES: Record<Phase3Edge, string[]> = {
  ORB_PULLBACK_CONTINUATION: [
    "finalized_orb_or_ntz",
    "directional_break_completed",
    "qualifying_pullback",
    "permitted_level_within_tolerance",
    "valid_p_candle",
    "immediate_e_confirmation_buffer",
    "e_completed_before_cutoff",
  ],
  PATIENCE_CANDLE_CONTINUATION: [
    "confirmed_15m_trend",
    "valid_continuation_context",
    "valid_p_candle",
    "immediate_e_confirmation_buffer",
    "e_completed_before_cutoff",
  ],
  CONSOLIDATION_BREAKOUT_CONTINUATION: [
    "frozen_causal_consolidation_range",
    "governed_consolidation_stability",
    "directional_breakout_closed_outside_range",
    "continuation_evidence",
    "valid_p_immediate_e_confirmation",
    "e_completed_before_cutoff",
  ],
  EQUIVALENT_CANDLE_REVERSAL: [
    "equivalent_candle_reversal_evidence",
    "reversal_direction_confirmed",
    "valid_p_immediate_e_confirmation",
    "e_completed_before_cutoff",
  ],
};

type StoredPredicate = {
  predicateName: string;
  result: "PASS" | "FAIL" | "EVIDENCE_UNAVAILABLE";
  reason: string;
  sourceAuditId: string | null;
  evidenceTimestamp: string | null;
};

function storedPredicate(
  occurrence: HistoricalOccurrence,
  predicateName: string,
  predicate: RegExp,
): StoredPredicate {
  const evidence = occurrence.causalEvidence;
  const matchingRule = evidence?.ruleEvidence.find((item) => predicate.test(item));
  if (matchingRule) {
    const passed = matchingRule.startsWith("PASS ");
    return {
      predicateName,
      result: passed ? "PASS" : "FAIL",
      reason: matchingRule.replace(/^(PASS|FAIL)\s+/, ""),
      sourceAuditId: evidence?.sourceAuditId ?? null,
      evidenceTimestamp: evidence?.evidenceTimestamp ?? null,
    };
  }
  return {
    predicateName,
    result: "EVIDENCE_UNAVAILABLE",
    reason: `Stored audit evidence does not contain a result for ${predicateName}.`,
    sourceAuditId: evidence?.sourceAuditId ?? null,
    evidenceTimestamp: evidence?.evidenceTimestamp ?? null,
  };
}

function storedPredicateKeys(
  occurrence: HistoricalOccurrence,
  predicateName: string,
  keys: string[],
): StoredPredicate {
  const predicates = keys.map((key) => storedPredicate(occurrence, predicateName, new RegExp(`^(PASS|FAIL)\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "i")));
  const result = predicates.some((item) => item.result === "FAIL")
    ? "FAIL"
    : predicates.some((item) => item.result === "EVIDENCE_UNAVAILABLE")
      ? "EVIDENCE_UNAVAILABLE"
      : "PASS";
  return {
    predicateName,
    result,
    reason: predicates.map((item) => item.reason).join("; "),
    sourceAuditId: predicates.find((item) => item.sourceAuditId !== null)?.sourceAuditId ?? null,
    evidenceTimestamp: predicates.find((item) => item.evidenceTimestamp !== null)?.evidenceTimestamp ?? null,
  };
}

function directPredicate(
  occurrence: HistoricalOccurrence,
  predicateName: string,
  passed: boolean | null,
  reason: string,
  timestamp: string | null = occurrence.entryObservationTimestamp,
): StoredPredicate {
  const evidence = occurrence.causalEvidence;
  return {
    predicateName,
    result: passed === null ? "EVIDENCE_UNAVAILABLE" : passed ? "PASS" : "FAIL",
    reason,
    sourceAuditId: evidence?.sourceAuditId ?? null,
    evidenceTimestamp: timestamp ?? evidence?.evidenceTimestamp ?? null,
  };
}

function edgePredicatesForOccurrence(occurrence: HistoricalOccurrence): Record<Phase3Edge, Phase3SignalEdgePredicate[]> {
  const exactRule = (key: string) => new RegExp(`^(PASS|FAIL)\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "i");
  const pExists = occurrence.patienceCandle !== null && occurrence.pOpenTimestamp !== null;
  const beforeCutoff = occurrence.entryObservationTimestamp
    ? Number.isFinite(Date.parse(occurrence.entryObservationTimestamp))
      && wallClockMinutesForTimestamp(Date.parse(occurrence.entryObservationTimestamp)) < PHASE3_ENTRY_CUTOFF_MINUTES
    : null;
  const commonFor = (target: HistoricalOccurrence): Record<string, StoredPredicate> => ({
    immediate_e_confirmation_buffer: storedPredicate(target, "immediate_e_confirmation_buffer", exactRule("immediateTrigger")),
    e_completed_before_cutoff: directPredicate(target, "e_completed_before_cutoff", beforeCutoff,
      beforeCutoff === null ? "Completed E timestamp is unavailable."
        : beforeCutoff ? "Completed E observation is before the exclusive 1:00 p.m. ET cutoff." : "Completed E observation is at or after the exclusive 1:00 p.m. ET cutoff.",
      target.entryObservationTimestamp),
  });
  const combinedConfirmation = (p: StoredPredicate, e: StoredPredicate): StoredPredicate => {
    const result = p.result === "FAIL" || e.result === "FAIL"
      ? "FAIL"
      : p.result === "EVIDENCE_UNAVAILABLE" || e.result === "EVIDENCE_UNAVAILABLE"
        ? "EVIDENCE_UNAVAILABLE"
        : "PASS";
    return {
      predicateName: "valid_p_immediate_e_confirmation",
      result,
      reason: result === "PASS" ? "Exact stored P and immediate-E rules both passed." : `${p.reason}; ${e.reason}`,
      sourceAuditId: p.sourceAuditId ?? e.sourceAuditId,
      evidenceTimestamp: e.evidenceTimestamp ?? p.evidenceTimestamp,
    };
  };
  const evidence = (name: string, key: string) => storedPredicate(occurrence, name, exactRule(key));
  const evaluate = (edge: Phase3Edge): Phase3SignalEdgePredicate[] => {
    const source = occurrence.causalEvidenceByAudit?.find((item) => item.sourceEdge === edge)
      ?? (occurrence.causalEvidence?.sourceEdge === edge ? occurrence.causalEvidence : undefined);
    const sourceOccurrence = source === occurrence.causalEvidence ? occurrence : { ...occurrence, causalEvidence: source };
    const common = commonFor(sourceOccurrence);
    const map: Record<string, StoredPredicate> = { ...common };
    const edgeEvidence = (name: string, key: string) => storedPredicate(sourceOccurrence, name, exactRule(key));
    if (edge === "ORB_PULLBACK_CONTINUATION") {
      map.valid_p_candle = edgeEvidence("valid_p_candle", "validPatienceCandle");
      map.finalized_orb_or_ntz = edgeEvidence("finalized_orb_or_ntz", "ntzComplete");
      map.directional_break_completed = storedPredicateKeys(sourceOccurrence, "directional_break_completed", ["closeOutsideNtz", "breakoutContinuation"]);
      map.qualifying_pullback = edgeEvidence("qualifying_pullback", "genuinePullback");
      map.permitted_level_within_tolerance = edgeEvidence("permitted_level_within_tolerance", "levelContext");
    } else if (edge === "PATIENCE_CANDLE_CONTINUATION") {
      map.valid_p_candle = edgeEvidence("valid_p_candle", "patienceEligible");
      map.confirmed_15m_trend = edgeEvidence("confirmed_15m_trend", "confirmedTrend");
      map.valid_continuation_context = edgeEvidence("valid_continuation_context", "continuationContext");
    } else if (edge === "CONSOLIDATION_BREAKOUT_CONTINUATION") {
      map.valid_p_candle = edgeEvidence("valid_p_candle", "validPatienceNearLevel");
      map.frozen_causal_consolidation_range = edgeEvidence("frozen_causal_consolidation_range", "extendedConsolidation");
      map.governed_consolidation_stability = edgeEvidence("governed_consolidation_stability", "rangeStable");
      map.directional_breakout_closed_outside_range = edgeEvidence("directional_breakout_closed_outside_range", "strongBreakout");
      map.continuation_evidence = edgeEvidence("continuation_evidence", "postBreakoutContext");
    } else {
      map.valid_p_candle = edgeEvidence("valid_p_candle", "validPatienceCandle");
      map.equivalent_candle_reversal_evidence = edgeEvidence("equivalent_candle_reversal_evidence", "equivalentContext");
      map.reversal_direction_confirmed = edgeEvidence("reversal_direction_confirmed", "directionalConfirmation");
    }
    if (edge === "CONSOLIDATION_BREAKOUT_CONTINUATION" || edge === "EQUIVALENT_CANDLE_REVERSAL") {
      map.valid_p_immediate_e_confirmation = combinedConfirmation(
        map.valid_p_candle!,
        map.immediate_e_confirmation_buffer!,
      );
    }
    return EDGE_PREDICATE_NAMES[edge].map((name) => map[name] ?? storedPredicate(occurrence, name, exactRule(name)));
  };
  return Object.fromEntries(PHASE3_EDGES.map((edge) => [edge, evaluate(edge)])) as Record<Phase3Edge, Phase3SignalEdgePredicate[]>;
}

function confluenceEvidenceForOccurrence(occurrence: HistoricalOccurrence): Phase3ConfluenceEvidence[] {
  const structured = levelEvidenceForOccurrence(occurrence).map((evidence) => ({
    confluenceType: evidence.levelIdentifier,
    evidenceTimestamp: evidence.timestamp,
    evidenceValue: evidence.value,
    ruleState: evidence.ruleResult,
    sourceAuditId: evidence.auditIds[0] ?? null,
    predicateResult: "PASS" as const,
    gradeEligible: true,
  }));
  const structuredTypes = new Set(structured.map((evidence) => evidence.confluenceType));
  const unverified = (occurrence.supportingConfluences ?? [])
    .filter((label) => !structuredTypes.has(label))
    .map((label) => ({
      confluenceType: label,
      evidenceTimestamp: null,
      evidenceValue: null,
      ruleState: "UNAVAILABLE",
      sourceAuditId: null,
      predicateResult: "UNVERIFIED_CONFLUENCE_LABEL" as const,
      gradeEligible: false,
    }));
  return [...structured, ...unverified];
}

function confluenceEvidenceForCandidate(
  candidate: HistoricalTradeCandidate,
  occurrence: HistoricalOccurrence | undefined,
): Phase3ConfluenceEvidence[] {
  const structured = occurrence ? confluenceEvidenceForOccurrence(occurrence) : [];
  const structuredTypes = new Set(structured.map((evidence) => evidence.confluenceType));
  const unverified = candidate.supportingConfluences
    .filter((label) => !structuredTypes.has(label))
    .map((label) => ({
      confluenceType: label,
      evidenceTimestamp: null,
      evidenceValue: null,
      ruleState: "UNAVAILABLE",
      sourceAuditId: null,
      predicateResult: "UNVERIFIED_CONFLUENCE_LABEL" as const,
      gradeEligible: false,
    }));
  return [...structured, ...unverified.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.confluenceType === item.confluenceType) === index)];
}

function physicalIdentityForOccurrence(occurrence: HistoricalOccurrence): string {
  return [
    occurrence.sourceFingerprint || "<missing-source>",
    occurrence.formulaHash || "<missing-formula>",
    occurrence.contractSymbol || "<missing-contract>",
    occurrence.tradingDate || "<missing-date>",
    occurrence.direction || "<missing-direction>",
    occurrence.pOpenTimestamp || "<missing-p>",
    occurrence.eOpenTimestamp || "<missing-e>",
  ].join("|");
}

function physicalIdentityForCandidate(candidate: HistoricalTradeCandidate): string {
  return [
    candidate.sourceFingerprint,
    candidate.formulaHash,
    candidate.contractSymbol,
    candidate.tradingDate,
    candidate.direction,
    candidate.pOpenTimestamp,
    candidate.eOpenTimestamp,
  ].join("|");
}

function reconciliationInvariantViolations(input: {
  confirmed: readonly HistoricalOccurrence[];
  candidates: readonly HistoricalTradeCandidate[];
  rejected: readonly RejectedCandidateSignal[];
  trades: readonly BacktestTrade[];
  signals: readonly Phase3SignalReconciliation[];
}): string[] {
  const violations: string[] = [];
  const confirmedIds = new Set(input.confirmed.map((occurrence) => occurrence.occurrenceId));
  const confirmedById = new Map(input.confirmed.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const candidateSignalCounts = new Map<string, number>();
  for (const candidate of input.candidates) {
    candidateSignalCounts.set(candidate.signalOccurrenceId, (candidateSignalCounts.get(candidate.signalOccurrenceId) ?? 0) + 1);
    if (input.confirmed.length > 0 && (!candidate.signalOccurrenceId || !confirmedIds.has(candidate.signalOccurrenceId))) {
      violations.push(`CANDIDATE_WITHOUT_CONFIRMED_SIGNAL:${candidate.candidateId}`);
    }
  }
  const rejectionSignalCounts = new Map<string, number>();
  for (const rejection of input.rejected) {
    rejectionSignalCounts.set(rejection.signalOccurrenceId, (rejectionSignalCounts.get(rejection.signalOccurrenceId) ?? 0) + 1);
    if (input.confirmed.length > 0 && (!rejection.signalOccurrenceId || !confirmedIds.has(rejection.signalOccurrenceId))) {
      violations.push(`REJECTION_WITHOUT_CONFIRMED_SIGNAL:${rejection.signalOccurrenceId || "<missing>"}`);
    }
  }
  for (const signalId of confirmedIds) {
    const candidateCount = candidateSignalCounts.get(signalId) ?? 0;
    const rejectionCount = rejectionSignalCounts.get(signalId) ?? 0;
    if (candidateCount > 0 && rejectionCount > 0) {
      violations.push(`CONTRADICTORY_PROJECTION:${signalId}`);
    } else if (candidateCount === 0 && rejectionCount === 0) {
      violations.push(`UNEXPLAINED_CONFIRMED_SIGNAL:${signalId}`);
    } else if (candidateCount > 1 || rejectionCount > 1) {
      violations.push(`DUPLICATE_PROJECTION_RESULT:${signalId}`);
    }
  }
  const uniqueCandidateSignals = new Set(input.candidates.map((candidate) => candidate.signalOccurrenceId));
  const uniqueRejectedSignals = new Set(input.rejected.map((rejection) => rejection.signalOccurrenceId));
  for (const signalId of uniqueCandidateSignals) {
    if (uniqueRejectedSignals.has(signalId)) {
      violations.push(`CANDIDATE_REJECTION_SIGNAL_OVERLAP:${signalId}`);
    }
  }
  if (input.confirmed.length > 0 && (
    input.confirmed.length !== uniqueCandidateSignals.size + uniqueRejectedSignals.size
    || uniqueCandidateSignals.size + uniqueRejectedSignals.size !== input.signals.length
  )) {
    violations.push(
      `CONFIRMED_SIGNAL_PROJECTION_TOTAL_MISMATCH:${input.confirmed.length}:${uniqueCandidateSignals.size}:${uniqueRejectedSignals.size}`,
    );
  }
  const candidatePhysicalBySignal = new Map<string, string>();
  for (const candidate of input.candidates) {
    const physical = physicalIdentityForCandidate(candidate);
    const previous = candidatePhysicalBySignal.get(candidate.signalOccurrenceId);
    if (previous && previous !== physical) {
      violations.push(`DUPLICATE_CANDIDATE_PHYSICAL_IDENTITY:${candidate.signalOccurrenceId}`);
    }
    candidatePhysicalBySignal.set(candidate.signalOccurrenceId, physical);
  }
  const confirmedPhysical = new Map<string, string>();
  for (const occurrence of input.confirmed) {
    const physical = physicalIdentityForOccurrence(occurrence);
    if (confirmedPhysical.has(physical)) {
      violations.push(`DUPLICATE_CONFIRMED_PHYSICAL_IDENTITY:${physical}`);
    }
    confirmedPhysical.set(physical, occurrence.occurrenceId);
  }
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const tradeIds = new Set<string>();
  const tradeCountByCandidate = new Map<string, number>();
  for (const trade of input.trades) {
    if (tradeIds.has(trade.id)) continue;
    tradeIds.add(trade.id);
    if (!trade.candidateId || !candidateById.has(trade.candidateId)) {
      violations.push(`TRADE_WITHOUT_EXACT_CANDIDATE:${trade.id}`);
      continue;
    }
    tradeCountByCandidate.set(trade.candidateId, (tradeCountByCandidate.get(trade.candidateId) ?? 0) + 1);
  }
  for (const [candidateId, count] of tradeCountByCandidate) {
    if (count > 1) violations.push(`MULTIPLE_AUTHORITATIVE_TRADES_FOR_CANDIDATE:${candidateId}`);
  }
  for (const signal of input.signals) {
    if (signal.candidate && signal.rejection) {
      violations.push(`SIGNAL_HAS_CANDIDATE_AND_REJECTION:${signal.signalOccurrenceId}`);
    }
    if (!signal.candidate && !signal.rejection) {
      violations.push(`SIGNAL_HAS_NO_PROJECTION:${signal.signalOccurrenceId}`);
    }
    if (signal.trade && (!signal.candidate || signal.trade.tradeId.length === 0)) {
      violations.push(`TRADE_LINKAGE_WITHOUT_CANDIDATE:${signal.signalOccurrenceId}`);
    }
  }
  for (const candidate of input.candidates) {
    const occurrence = confirmedById.get(candidate.signalOccurrenceId);
    if (!occurrence) continue;
    if (candidate.contractSymbol !== occurrence.contractSymbol
      || candidate.tradingDate !== occurrence.tradingDate
      || candidate.direction !== occurrence.direction) {
      violations.push(`CANDIDATE_IDENTITY_MISMATCH:${candidate.candidateId}`);
    }
  }
  return [...new Set(violations)];
}

function sourceFingerprintAudit(
  contentFingerprint: string,
  files: readonly {
    filename: string;
    contractSymbol: string;
    contentFingerprint: string;
  }[] | undefined,
): Phase3SignalReconciliationReport["sourceFingerprint"] {
  if (files?.length) {
    const validation = validateMultiContractContentFingerprint({ contentFingerprint, files });
    return {
      fingerprints: files.map((file) => file.contentFingerprint),
      components: validation.components,
      allSame: new Set(files.map((file) => file.contentFingerprint)).size === 1,
      validShape: validation.valid,
      malformedSignals: validation.errors,
    };
  }
  const components = contentFingerprint.split("|").filter(Boolean).map((component) => {
    const pieces = component.split(":");
    return {
      filename: pieces.slice(0, -2).join(":"),
      contractSymbol: pieces.at(-2) ?? "",
      fingerprint: pieces.at(-1) ?? "",
    };
  });
  const validShape = /^[0-9a-f]{64}$/i.test(contentFingerprint)
    || (components.length > 0
      && components.every((component) =>
        Boolean(parseMesContractSymbol(component.contractSymbol))
        && /^[0-9a-f]{64}$/i.test(component.fingerprint)
        && component.filename.length > 0)
      && new Set(components.map((component) => component.contractSymbol)).size === components.length);
  return {
    fingerprints: components.map((component) => component.fingerprint),
    components,
    allSame: new Set(components.map((component) => component.fingerprint)).size === 1,
    validShape,
    malformedSignals: validShape ? [] : ["CONTENT_FINGERPRINT_COMPONENTS_MALFORMED"],
  };
}

function reconcileReportItem(
  item: Phase3PilotReportItem,
  partition: Phase3PilotPartition | undefined,
): {
  item: Phase3PilotReportItem;
  occurrences: HistoricalOccurrence[];
  candidates: HistoricalTradeCandidate[];
  rejected: RejectedCandidateSignal[];
  trades: BacktestTrade[];
  orphans: OrphanModeledTrade[];
  reconciliationErrors: Phase3SignalReconciliationReport["reconciliationErrors"];
} {
  const isSyntheticFixture = item.syntheticFixture === true
    || (item.report as Phase3ReportWithOrphanHistory).syntheticFixture === true;
  if (isSyntheticFixture) {
    return {
      item,
      occurrences: item.report.occurrences,
      candidates: item.report.tradeCandidates,
      rejected: item.report.rejectedCandidateSignals ?? [],
      trades: item.report.trades,
      orphans: item.report.orphanModeledTrades ?? [],
      reconciliationErrors: [],
    };
  }
  const missingPartition = !partition;
  const missingAudit = item.report.audit.length === 0;
  if (missingPartition || missingAudit) {
    const reconciliationErrors: Phase3SignalReconciliationReport["reconciliationErrors"] = [];
    if (missingPartition) {
      reconciliationErrors.push({
        code: "PHASE3_PARTITION_MISSING",
        tradingDate: item.tradingDate,
        contractSymbol: item.contractSymbol,
        detail: `No matching historical Phase 3 partition exists for ${item.tradingDate}|${item.contractSymbol}.`,
      });
    }
    if (missingAudit) {
      reconciliationErrors.push({
        code: "PHASE3_AUDIT_STREAM_MISSING",
        tradingDate: item.tradingDate,
        contractSymbol: item.contractSymbol,
        detail: `The historical Phase 3 report for ${item.tradingDate}|${item.contractSymbol} has no raw audit records.`,
      });
    }
    reconciliationErrors.push({
      code: "PHASE3_LIFECYCLE_RECONCILIATION_UNAVAILABLE",
      tradingDate: item.tradingDate,
      contractSymbol: item.contractSymbol,
      detail: "Canonical lifecycle reduction is unavailable, so prior candidates and trades cannot remain authoritative.",
    });
    const rejected = item.report.occurrences
      .filter((occurrence) =>
        occurrence.kind === "patience"
        && occurrence.canonicalOccurrence === true
        && occurrence.status === "SIGNAL_CONFIRMED")
      .map((occurrence) => ({
        signalOccurrenceId: occurrence.occurrenceId,
        reasonCodes: reconciliationErrors.map((error) => error.code),
        details: reconciliationErrors.map((error) => error.detail),
      }));
    const empty = calculateBacktestMetrics([]);
    const correctedReport: Phase3ReportWithOrphanHistory = {
      ...item.report,
      metrics: empty,
      inSample: empty,
      outOfSample: empty,
      executionSummary: {
        eligibleCandidateCount: 0,
        enteredTradeCount: 0,
        finalizedTradeCount: 0,
        openTradeCount: 0,
        ambiguousEntryCount: 0,
        unresolvedAmbiguousTradeCount: 0,
        conservativelyResolvedTradeCount: 0,
        unscoredTradeCount: 0,
      },
      trades: [],
      tradeCandidates: [],
      rejectedCandidateSignals: rejected,
      orphanModeledTrades: [],
      occurrences: item.report.occurrences,
      diagnostics: item.report.diagnostics
        ? {
          ...item.report.diagnostics,
          tradeCandidates: 0,
          modeledTrades: 0,
          confirmedSignalsWithoutCandidates: rejected.length,
          candidatesWithoutModeledTrades: 0,
          candidatesWithoutConfirmedSignals: 0,
          modeledTradesWithoutCandidates: 0,
          candidateRejectionReasons: Object.fromEntries(
            rejected.map((rejection) => [rejection.signalOccurrenceId, rejection.reasonCodes.join(",")]),
          ),
          candidateInvariantViolations: [
            ...item.report.diagnostics.candidateInvariantViolations,
            ...reconciliationErrors.map((error) => error.code),
          ],
        }
        : undefined,
    };
    return {
      item: { ...item, report: correctedReport },
      occurrences: correctedReport.occurrences,
      candidates: [],
      rejected,
      trades: [],
      orphans: [],
      reconciliationErrors,
    };
  }
  const priorOccurrence = item.report.occurrences.find((occurrence) =>
    occurrence.sourceFingerprint && occurrence.kind === "patience");
  const occurrences = buildHistoricalOccurrenceLedger(
    partition.dataset,
    item.report.audit,
    item.report.trades,
    item.report.formulaHash,
    priorOccurrence?.sourceFingerprint,
  );
  const projection = projectHistoricalTradeCandidates(occurrences, item.report.trades, {
    dataset: partition.dataset,
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
    lifecycle: reduceHistoricalPullbackLifecycles(item.report.audit, undefined, occurrences),
  });
  const trades = projection.authoritativeTrades;
  const rejected = projection.rejected;
  const metrics = calculateBacktestMetrics(trades, rejected.length, item.report.audit);
  const inSampleTrades = trades.filter((trade) => trade.period === "in_sample");
  const outOfSampleTrades = trades.filter((trade) => trade.period === "out_of_sample");
  const orphanHistory = [
    ...((item.report as Phase3ReportWithOrphanHistory).phase3OrphanHistory ?? []),
    ...(item.report.orphanModeledTrades ?? []),
  ].filter((orphan, index, all) =>
    all.findIndex((candidate) => candidate.tradeId === orphan.tradeId) === index);
  const correctedReport: Phase3ReportWithOrphanHistory = {
    ...item.report,
    phase3OrphanHistory: orphanHistory,
    metrics,
    inSample: calculateBacktestMetrics(inSampleTrades, rejected.length, item.report.audit),
    outOfSample: calculateBacktestMetrics(outOfSampleTrades, rejected.length, item.report.audit),
    executionSummary: {
      ...item.report.executionSummary,
      eligibleCandidateCount: projection.candidates.length,
      enteredTradeCount: trades.length,
      finalizedTradeCount: trades.filter((trade) => trade.outcome !== "open").length,
      openTradeCount: trades.filter((trade) => trade.outcome === "open").length,
      ambiguousEntryCount: projection.candidates.filter((candidate) => candidate.executionStatus === "ENTRY_AMBIGUOUS").length,
      unresolvedAmbiguousTradeCount: trades.filter((trade) => trade.ambiguityLabel !== null).length,
      conservativelyResolvedTradeCount: trades.filter((trade) => trade.ambiguityLabel !== null && trade.outcome !== "open").length,
      unscoredTradeCount: trades.filter((trade) => trade.outcome === "open" || trade.ambiguityLabel !== null).length,
    },
    trades,
    tradeCandidates: projection.candidates,
    rejectedCandidateSignals: rejected,
    orphanModeledTrades: projection.orphans,
    occurrences,
    diagnostics: historicalReplayDiagnostics(
      item.report.audit,
      occurrences,
      projection.candidates,
      trades,
      rejected,
      projection.orphans,
    ),
  };
  return {
    item: { ...item, report: correctedReport },
    occurrences,
    candidates: projection.candidates,
    rejected,
    trades,
    orphans: projection.orphans,
    reconciliationErrors: [],
  };
}

export function reconcilePhase3SignalFunnel(input: {
  manifest: Phase3PilotManifest;
  reports: readonly Phase3PilotReportItem[];
  partitions: readonly Phase3PilotPartition[];
  sourceFingerprintFiles?: readonly {
    filename: string;
    contractSymbol: string;
    contentFingerprint: string;
  }[];
}): {
  reports: Phase3PilotReportItem[];
  reconciliation: Phase3SignalReconciliationReport;
} {
  const partitionByKey = new Map(input.partitions.map((partition) =>
    [`${partition.tradingDate}|${partition.contractSymbol}`, partition]));
  const normalized = input.reports.map((item) =>
    reconcileReportItem(item, partitionByKey.get(`${item.tradingDate}|${item.contractSymbol}`)));
  const allOccurrences = normalized.flatMap((item) => item.occurrences);
  const allCandidates = normalized.flatMap((item) => item.candidates);
  const allRejected = normalized.flatMap((item) => item.rejected);
  const allTrades = normalized.flatMap((item) => item.trades);
  const candidateBySignal = new Map(allCandidates.map((candidate) => [candidate.signalOccurrenceId, candidate]));
  const rejectionBySignal = new Map(allRejected.map((rejection) => [rejection.signalOccurrenceId, rejection]));
  const tradeByCandidate = new Map(
    allTrades.flatMap((trade) => trade.candidateId ? [[trade.candidateId, trade] as const] : []),
  );
  const confirmed = allOccurrences.filter((occurrence) =>
    occurrence.kind === "patience"
    && occurrence.canonicalOccurrence === true
    && occurrence.status === "SIGNAL_CONFIRMED");
  const periodByKey = new Map(input.reports.map((item) => [
    `${item.tradingDate}|${item.contractSymbol}`,
    item.period,
  ]));
  const signals: Phase3SignalReconciliation[] = confirmed
    .map((occurrence) => {
      const candidate = candidateBySignal.get(occurrence.occurrenceId) ?? null;
      const rejection = rejectionBySignal.get(occurrence.occurrenceId) ?? null;
      const trade = candidate ? tradeByCandidate.get(candidate.candidateId) ?? null : null;
      const period = periodByKey.get(`${occurrence.tradingDate}|${occurrence.contractSymbol}`) ?? "in_sample";
      const bucket = occurrence.entryObservationTimestamp ? timeBucket(occurrence.entryObservationTimestamp) : null;
      const minutes = occurrence.entryObservationTimestamp
        ? wallClockMinutesForTimestamp(Date.parse(occurrence.entryObservationTimestamp))
        : Number.NaN;
      return {
        signalOccurrenceId: occurrence.occurrenceId,
        period,
        tradingDate: occurrence.tradingDate,
        contractSymbol: occurrence.contractSymbol,
        contractMonth: occurrence.contractMonth,
        direction: occurrence.direction,
        causalIdentity: {
          lTimestamp: occurrence.lTimestamp,
          pOpenTimestamp: occurrence.pOpenTimestamp,
          eOpenTimestamp: occurrence.eOpenTimestamp,
          entryObservationTimestamp: occurrence.entryObservationTimestamp,
        },
        threshold: {
          confirmationThreshold: occurrence.confirmationThreshold,
          confirmationExcursion: occurrence.confirmationExcursion,
          confirmationBufferTicks: occurrence.confirmationBufferTicks,
          reached: occurrence.confirmationThreshold !== null && occurrence.confirmationExcursion !== null
            ? occurrence.direction === "long"
              ? (typeof occurrence.entryCandle?.high === "number" ? occurrence.entryCandle.high : Number.NEGATIVE_INFINITY) >= occurrence.confirmationThreshold
              : (typeof occurrence.entryCandle?.low === "number" ? occurrence.entryCandle.low : Number.POSITIVE_INFINITY) <= occurrence.confirmationThreshold
            : null,
        },
        directionSource: occurrence.directionSource ?? null,
        directionSources: [...new Set(occurrence.directionSources ?? [])].sort(),
        primaryEdge: occurrence.primaryEdge ?? occurrence.strategyCandidate ?? null,
        matchedEdges: [...new Set(occurrence.matchedEdges ?? [])].sort(),
        levelEvidence: levelEvidenceForOccurrence(occurrence),
        edgePredicates: edgePredicatesForOccurrence(occurrence),
        confluenceEvidence: confluenceEvidenceForOccurrence(occurrence),
        timing: {
          entryTimeBucket: bucket,
          beforeExclusiveCutoff: Number.isFinite(minutes) && minutes < PHASE3_ENTRY_CUTOFF_MINUTES,
        },
        rejection: rejection
          ? { reasonCodes: [...rejection.reasonCodes], details: [...rejection.details] }
          : null,
        candidate: candidate
          ? {
            candidateId: candidate.candidateId,
            executionStatus: candidate.executionStatus,
            managementEvidenceStatus: candidate.managementContext?.managementEvidenceStatus ?? null,
          }
          : null,
        trade: trade
          ? {
            tradeId: trade.id,
            outcome: trade.outcome,
            netPnl: trade.netPnl,
            ambiguityLabel: trade.ambiguityLabel,
          }
          : null,
        disposition: dispositionForSignal(candidate, rejection, trade),
      };
    })
    .sort((left, right) =>
      left.tradingDate.localeCompare(right.tradingDate)
      || left.contractSymbol.localeCompare(right.contractSymbol)
      || left.causalIdentity.pOpenTimestamp?.localeCompare(right.causalIdentity.pOpenTimestamp ?? "") || 0);
  const dispositionCounts = emptyDispositionCounts();
  for (const signal of signals) dispositionCounts[signal.disposition] += 1;
  const timeBuckets = Object.fromEntries(RECONCILIATION_BUCKETS.map((bucket) => [
    bucket,
    { confirmed: 0, candidates: 0, rejected: 0, entered: 0 },
  ]));
  for (const signal of signals) {
    const bucket = signal.timing.entryTimeBucket ?? "OUTSIDE_ENTRY_WINDOW";
    timeBuckets[bucket]!.confirmed += 1;
    if (signal.candidate) timeBuckets[bucket]!.candidates += 1;
    if (signal.rejection) timeBuckets[bucket]!.rejected += 1;
    if (signal.trade) timeBuckets[bucket]!.entered += 1;
  }
  const candidateConfluences = allCandidates.map((candidate) => {
    const occurrence = allOccurrences.find((item) => item.occurrenceId === candidate.signalOccurrenceId);
    const evidence = occurrence ? levelEvidenceForOccurrence(occurrence) : [];
    return {
      candidateId: candidate.candidateId,
      signalOccurrenceId: candidate.signalOccurrenceId,
      evidence,
      structuredEvidence: confluenceEvidenceForCandidate(candidate, occurrence),
      genericLabelsWithoutStructuredEvidence: candidate.supportingConfluences.filter((label) =>
        !evidence.some((item) => item.levelIdentifier === label)),
    };
  });
  const edgeAudit = PHASE3_EDGES.map((edge) => {
    const primary = signals.filter((signal) => signal.primaryEdge === edge).length;
    const matched = signals.filter((signal) => signal.matchedEdges.includes(edge)).length;
    const candidateCount = allCandidates.filter((candidate) => candidate.primaryEdge === edge).length;
    return {
      edge,
      primaryCount: primary,
      matchedCount: matched,
      candidateCount,
      independentPrimaryPopulation: primary > 0 ? "reported" as const : "empty" as const,
      explanation: primary > 0
        ? "Signals are counted once under the canonical primary edge; secondary matches remain confluence evidence."
        : matched > 0
          ? "The edge matched the same physical sequences as a secondary strategy and therefore did not create duplicate candidates."
          : "No canonical confirmed signal matched this edge in the audited partitions.",
    };
  });
  const oldOrphans = input.reports.flatMap((item) => (
    ((item.report as Phase3ReportWithOrphanHistory).phase3OrphanHistory
      ?? item.report.orphanModeledTrades
      ?? []).map((orphan) => ({
    ...orphan,
    period: item.period,
    tradingDate: item.tradingDate,
    contractSymbol: item.contractSymbol,
  }))));
  const currentOrphans = normalized.flatMap((item) => item.orphans.map((orphan) => ({
    ...orphan,
    period: item.item.period,
    tradingDate: item.item.tradingDate,
    contractSymbol: item.item.contractSymbol,
  })));
  const orphanByTrade = new Map<string, Phase3OrphanReconciliation>();
  for (const orphan of [...oldOrphans, ...currentOrphans]) {
    const rawTrade = input.reports
      .find((item) => item.tradingDate === orphan.tradingDate && item.contractSymbol === orphan.contractSymbol)
      ?.report.trades.find((trade) => trade.id === orphan.tradeId);
    const exactCandidate = allCandidates.find((candidate) =>
      candidate.signalOccurrenceId === orphan.matchingSignalOccurrenceId
      || Boolean(rawTrade
        && candidate.contractSymbol === rawTrade.contractSymbol
        && candidate.tradingDate === rawTrade.tradingDate
        && candidate.direction === rawTrade.direction
        && rawTrade.audit?.patienceCandleOpenTime === candidate.patienceTimestamp
        && rawTrade.audit?.triggerCandleOpenTime === candidate.eOpenTimestamp));
    orphanByTrade.set(orphan.tradeId, {
      ...orphan,
      exactSignalMatch: Boolean(exactCandidate),
      resolution: exactCandidate
        ? "resolved_exact_candidate"
        : orphan.matchingSignalOccurrenceId
          ? "excluded_candidate_conflict"
          : "excluded_no_exact_candidate",
    });
  }
  const invariantViolations = reconciliationInvariantViolations({
    confirmed,
    candidates: allCandidates,
    rejected: allRejected,
    trades: allTrades,
    signals,
  });
  const reconciliationErrors = normalized
    .flatMap((item) => item.reconciliationErrors)
    .sort((left, right) =>
      left.tradingDate.localeCompare(right.tradingDate)
      || left.contractSymbol.localeCompare(right.contractSymbol)
      || left.code.localeCompare(right.code));
  const evidenceErrors = reconciliationErrors.map((error) =>
    `${error.code}:${error.tradingDate}|${error.contractSymbol}`);
  const sourceFingerprint = sourceFingerprintAudit(
    input.manifest.source.contentFingerprint,
    input.sourceFingerprintFiles,
  );
  return {
    reports: normalized.map((item) => item.item),
    reconciliation: {
      version: "phase3-signal-reconciliation-v1",
      reconciliationErrors,
      confirmedSignalCount: signals.length,
      dispositionCounts,
      invariantViolations: [...new Set([...evidenceErrors, ...invariantViolations])],
      dispositionReconciles: reconciliationErrors.length === 0
        && invariantViolations.length === 0
        && signals.length === confirmed.length
        && signals.length === Object.values(dispositionCounts).reduce((sum, count) => sum + count, 0)
        && new Set(signals.map((signal) => signal.signalOccurrenceId)).size === signals.length,
      signals,
      candidateConfluences,
      edgeAudit,
      orphanTrades: [...orphanByTrade.values()].sort((left, right) => left.tradeId.localeCompare(right.tradeId)),
      timeBuckets,
      sourceFingerprint: {
        ...sourceFingerprint,
        allSame: sourceFingerprint.allSame,
      },
    },
  };
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
  reconciliation: Phase3SignalReconciliationReport,
): Phase3PilotGate {
  const violations: string[] = [];
  if (!reconciliation.dispositionReconciles) {
    violations.push("SIGNAL_RECONCILIATION_GATE_FAILED");
    violations.push(...reconciliation.invariantViolations);
  }
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
    sourceFingerprintFiles?: readonly {
      filename: string;
      contractSymbol: string;
      contentFingerprint: string;
    }[];
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
  const reconciled = reconcilePhase3SignalFunnel({
    manifest: input.manifest,
    reports,
    partitions: input.partitions,
    sourceFingerprintFiles: input.sourceFingerprintFiles,
  });
  const reportList = reconciled.reports.map((item) => item.report);
  const deduped = deduplicateCandidates(reportList);
  const occurrences = reportList.flatMap((report) => report.occurrences);
  const gate = gateReports(reportList, deduped.candidates, reconciled.reconciliation);
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
    reconciliation: reconciled.reconciliation,
    diagnostics: {
      candidateCount: deduped.candidates.length,
      tradeCount: uniqueTradeKeys.size,
      occurrenceCount: occurrences.length,
      auditCount: reportList.reduce((sum, report) => sum + report.audit.length, 0),
      duplicateCandidateCount: deduped.duplicateCount,
      duplicateTradeCount: duplicateTradeIds.size,
      lateEntryCount,
      futureAccessViolationCount: reportList.filter((report) => report.replay.futureCandleAccess).length,
      invariantViolations: reconciled.reconciliation.invariantViolations,
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
    await options.saveCheckpoint({
      pilotId,
      manifest: input.manifest,
      reports: reconciled.reports,
      updatedAt: new Date(completedAtMs).toISOString(),
    });
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