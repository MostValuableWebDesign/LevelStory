import type { BacktestWorkerInput } from "./backtest-worker-client.js";
import { runBacktestInWorker } from "./backtest-worker-client.js";
import {
  buildSegments,
  buildQualificationFunnel,
  calculateBacktestMetrics,
  historicalReplayDiagnostics,
  applyHistoricalAccountPositionGate,
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
};

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

function mergeBatchOccurrences(
  reports: readonly BacktestReport[],
): { occurrences: HistoricalOccurrence[]; conflicts: string[] } {
  const byId = new Map<string, HistoricalOccurrence>();
  const conflicts: string[] = [];
  for (const occurrence of reports.flatMap((report) => report.occurrences)) {
    const existing = byId.get(occurrence.occurrenceId);
    if (!existing) {
      byId.set(occurrence.occurrenceId, occurrence);
      continue;
    }
    if (stableSerialize(existing) !== stableSerialize(occurrence)) {
      conflicts.push(
        `BATCH_DUPLICATE_OCCURRENCE_CONFLICT:${occurrence.occurrenceId}`,
      );
    }
  }
  return {
    occurrences: [...byId.values()],
    conflicts: [...new Set(conflicts)].sort(),
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

function buildSessionResultCacheKey(
  partition: BatchPartition,
  request: BatchBacktestRequest,
  risk: BacktestWorkerInput["risk"],
  context: CatalogedSessionCacheContext | undefined,
): string | null {
  const catalog = sessionCatalogEntry(context, partition);
  if (catalog && (
    catalog.coverageStatus !== "complete"
    || catalog.completenessStatus !== "complete"
    || catalog.validationStatus !== "validated"
  )) return null;
  const {
    selectedDates: _selectedDates,
    startDate: _startDate,
    endDate: _endDate,
    inSampleDays: _inSampleDays,
    outOfSampleDays: _outOfSampleDays,
    ...sessionIndependentRequest
  } = request;
  return buildVersionedAnalysisCacheKey("cataloged-session-strategy-result", {
    cacheKeyVersion: `${STRATEGY_RESULT_CACHE_KEY_VERSION}-session`,
    session: {
      tradingDate: partition.tradingDate,
      contractSymbol: partition.contractSymbol,
      period: partition.period,
      partitionIdentity: catalog?.partitionIdentity ?? null,
      sourceFingerprint: catalog?.sourceFingerprint ?? null,
      ingestionVersion: catalog?.ingestionVersion ?? null,
      normalizationVersion: catalog?.normalizationVersion ?? null,
      schemaVersion: catalog?.schemaVersion ?? null,
      datasetFingerprint: partition.dataset.contentFingerprint ?? null,
      source: partition.dataset.source ?? null,
      timeframe: catalog?.availableTimeframes ?? [1, 5],
    },
    strategy: context?.strategyIdentity ?? {
      formulaVersion: FIXED_FORMULA_VERSION,
      strategyResultVersion: STRATEGY_RESULT_CACHE_KEY_VERSION,
    },
    request: sessionIndependentRequest,
    risk,
    source: context?.sourceIdentity ?? null,
    initialState: context?.initialState ?? {
      accountPosition: "flat-for-session-analysis",
      combinedReplayGate: "required",
    },
  });
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
  const audit = reports.flatMap((report) => report.audit);
  const candidateExecutionEvidence = reports.flatMap((report) => report.candidateExecutionEvidence ?? []);
  const partitionTrades = reports.flatMap((report) => report.trades);
  const partitionCandidates = reports.flatMap((report) => report.tradeCandidates);
  const schedule = partitions.find((partition) => partition.dataset.contractSchedule)?.dataset.contractSchedule;
  const globalAccountGate = candidateExecutionEvidence.length > 0
    ? applyHistoricalAccountPositionGate(partitionCandidates, candidateExecutionEvidence, {
      resetAtContractBoundary: Boolean(schedule),
      contractBoundaries: schedule?.boundaries,
    })
    : null;
  const trades = globalAccountGate?.authoritativeTrades ?? partitionTrades;
  const tradeCandidates = globalAccountGate?.candidates ?? partitionCandidates;
  const rejectedCandidateSignals = reports.flatMap((report) => report.rejectedCandidateSignals);
  const orphanModeledTrades = reports.flatMap((report) => report.orphanModeledTrades);
  const mergedOccurrences = mergeBatchOccurrences(reports);
  const occurrences = mergedOccurrences.occurrences;
  const executionSummary = {
    detectedCandidateCount: reports.reduce((sum, report) => sum + (report.executionSummary.detectedCandidateCount ?? 0), 0),
    eligibleCandidateCount: reports.reduce((sum, report) => sum + report.executionSummary.eligibleCandidateCount, 0),
    rejectedCandidateCount: reports.reduce((sum, report) => sum + (report.executionSummary.rejectedCandidateCount ?? 0), 0),
    accountEntryBlockedCandidateCount: tradeCandidates.filter(
      (candidate) => candidate.accountEntryStatus === "BLOCKED_ACTIVE_POSITION",
    ).length,
    accountPositionStateVersion: reports[0]?.executionSummary.accountPositionStateVersion ?? "unknown",
    enteredTradeCount: trades.length,
    finalizedTradeCount: trades.filter((trade) => trade.outcome !== "open").length,
    openTradeCount: trades.filter((trade) => trade.outcome === "open").length,
    ambiguousEntryCount: reports.reduce((sum, report) => sum + report.executionSummary.ambiguousEntryCount, 0),
    unresolvedAmbiguousTradeCount: trades.filter((trade) => trade.ambiguityLabel !== null).length,
    conservativelyResolvedTradeCount: trades.filter((trade) => trade.ambiguityLabel !== null && trade.outcome !== "open").length,
    unscoredTradeCount: trades.filter((trade) => trade.outcome === "open" || trade.ambiguityLabel !== null).length,
    nonEnteredCandidateCount: reports.reduce((sum, report) => sum + (report.executionSummary.nonEnteredCandidateCount ?? 0), 0),
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
  const funnel = buildQualificationFunnel(reports);
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
    const cacheKey = buildSessionResultCacheKey(partition, backtestRequest, risk, options.sessionCache);
    let report: BacktestReport;
    try {
      report = cacheKey
        ? await sessionResultCache.getOrCompute(cacheKey, run)
        : await run();
    } catch (error) {
      if (cacheKey && options.signal.aborted) {
        sessionResultCache.setIncomplete(
          cacheKey,
          error instanceof Error ? error.message : "Session computation did not complete.",
        );
      }
      throw error;
    }
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
  const reports = await runPartitionSet(partitions, backtestRequest, input.risk, options, true);
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
  const result = aggregateBatchReports(reports, partitions, dates, normalEvaluation);
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