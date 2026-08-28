import type { BacktestWorkerInput } from "./backtest-worker-client.js";
import { runBacktestInWorker } from "./backtest-worker-client.js";
import {
  buildSegments,
  buildQualificationFunnel,
  calculateBacktestMetrics,
  type BacktestGapReport,
  type BacktestReport,
  type BacktestRequest,
  type BacktestTrade,
  type CausalReplayDataset,
  type QualificationFunnel,
} from "./phase9.js";
import { FIXED_FORMULA_VERSION } from "./formula-hash.js";
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
};

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
};

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
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

function aggregateBatchReports(
  reports: readonly BacktestReport[],
  partitions: readonly BatchPartition[],
  selectedDates: readonly string[],
  walkForward: WalkForwardReport,
): BatchBacktestReport {
  const first = reports[0];
  if (!first) throw new Error("The batch produced no completed replay partitions.");
  const trades = reports.flatMap((report) => report.trades);
  const audit = reports.flatMap((report) => report.audit);
  const funnel = buildQualificationFunnel(reports);
  const rejectionCount = funnel.candidates.filter((candidate) => candidate.primaryRejectionStage !== null).length;
  const inSampleTrades = trades.filter((trade) => trade.period === "in_sample");
  const outOfSampleTrades = trades.filter((trade) => trade.period === "out_of_sample");
  const selected = uniqueSorted(selectedDates);
  const activeContractByDate = partitions.map(({ tradingDate, contractSymbol }) => ({ tradingDate, contractSymbol }));
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
    inSample: calculateBacktestMetrics(inSampleTrades, funnel.candidates.filter((candidate) => candidate.period === "in_sample" && candidate.primaryRejectionStage !== null).length, audit.filter((record) => record.period === "in_sample")),
    outOfSample: calculateBacktestMetrics(outOfSampleTrades, funnel.candidates.filter((candidate) => candidate.period === "out_of_sample" && candidate.primaryRejectionStage !== null).length, audit.filter((record) => record.period === "out_of_sample")),
    segments: buildSegments(trades, rejectionCount),
    trades,
    audit,
    auditPage: {
      runId: BATCH_AUDIT_RUN_ID,
      page: 1,
      pageSize: 50,
      total: audit.length,
      hasMore: audit.length > 50,
    },
    assumptions: [...new Set(reports.flatMap((report) => report.assumptions))],
    gapReport: combineGapReports(reports),
    batch: {
      totalPartitions: partitions.length,
      completedPartitions: reports.length,
      selectedDates: selected,
      contractPartitions: partitions.map(({ tradingDate, contractSymbol, period }) => ({ tradingDate, contractSymbol, period })),
    },
    funnel,
    walkForward,
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
    const report = await runPartition(
      { request: backtestRequest, risk, replayDataset: partition.dataset },
      { timeoutMs: options.timeoutMs, signal: options.signal },
    );
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