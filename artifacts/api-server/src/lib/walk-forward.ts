import {
  buildSegments,
  calculateBacktestMetrics,
  type BacktestAuditRecord,
  type BacktestMetrics,
  type BacktestReport,
  type BacktestSegmentation,
  type BacktestSegment,
  type BacktestTrade,
} from "./phase9.js";

export const WALK_FORWARD_MIN_TRADES = 100;
export const WALK_FORWARD_MIN_HOLDOUT_TRADES = 20;
export const WALK_FORWARD_MIN_SEGMENT_TRADES = 5;
export const WALK_FORWARD_RISK_TOLERANCE_DOLLARS = 300;

export type WalkForwardEdgeStatus =
  | "insufficient_evidence"
  | "negative_observed_expectancy"
  | "mixed_inconclusive"
  | "positive_observed_expectancy_requires_further_validation";

export type WalkForwardSampleStatus = "sufficient" | "insufficient_sample";

export type WalkForwardSegment = BacktestSegment & {
  sampleStatus: WalkForwardSampleStatus;
  edgeStatus: WalkForwardEdgeStatus;
};

export type WalkForwardFold = {
  foldId: string;
  sequence: number;
  formulaHash: string;
  startDate: string;
  endDate: string;
  inSampleDates: string[];
  outOfSampleDates: string[];
  contractPartitions: Array<{
    tradingDate: string;
    contractSymbol: string;
    period: "in_sample" | "out_of_sample";
  }>;
  metrics: BacktestMetrics;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  segments: WalkForwardSegment[];
  edgeStatus: WalkForwardEdgeStatus;
};

export type WalkForwardSensitivityCase = {
  scenario: "normal" | "higher_cost" | "adverse_slippage";
  label: string;
  assumptions: string[];
  formulaHash: string;
  metrics: BacktestMetrics;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  edgeStatus: WalkForwardEdgeStatus;
};

export type WalkForwardReport = {
  formulaHash: string;
  formulaVersion: string;
  foldCount: number;
  folds: WalkForwardFold[];
  metrics: BacktestMetrics;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  segments: WalkForwardSegment[];
  edgeStatus: WalkForwardEdgeStatus;
  minimumEvidence: {
    totalTrades: number;
    holdoutTrades: number;
    requiredTotalTrades: number;
    requiredHoldoutTrades: number;
    riskToleranceDollars: number;
  };
  sensitivity: WalkForwardSensitivityCase[];
};

type PartitionLike = {
  tradingDate: string;
  contractSymbol: string;
  period: "in_sample" | "out_of_sample";
};

type EvaluationInput = {
  reports: readonly BacktestReport[];
  partitions: readonly PartitionLike[];
  selectedDates: readonly string[];
  formulaHash: string;
  formulaVersion: string;
};

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function periodForDate(date: string, inSampleDates: ReadonlySet<string>): "in_sample" | "out_of_sample" {
  return inSampleDates.has(date) ? "in_sample" : "out_of_sample";
}

function reclassifyTrades(
  reports: readonly BacktestReport[],
  inSampleDates: ReadonlySet<string>,
  selectedDates: ReadonlySet<string>,
): BacktestTrade[] {
  return reports
    .flatMap((report) => report.trades)
    .filter((trade) => selectedDates.has(trade.tradingDate))
    .map((trade) => ({ ...trade, period: periodForDate(trade.tradingDate, inSampleDates) }))
    .sort((left, right) => left.entryTime.localeCompare(right.entryTime) || left.id.localeCompare(right.id));
}

function reclassifyAudits(
  reports: readonly BacktestReport[],
  inSampleDates: ReadonlySet<string>,
  selectedDates: ReadonlySet<string>,
): BacktestAuditRecord[] {
  return reports
    .flatMap((report) => report.audit)
    .filter((record) => selectedDates.has(record.tradingDate))
    .map((record) => ({ ...record, period: periodForDate(record.tradingDate, inSampleDates) }))
    .sort((left, right) => left.evaluatedCandleOpenTime.localeCompare(right.evaluatedCandleOpenTime) || left.id.localeCompare(right.id));
}

function segmentsFor(
  trades: readonly BacktestTrade[],
  rejectedSetupCount: number,
): WalkForwardSegment[] {
  return buildSegments(trades, rejectedSetupCount).map((segment) => ({
    ...segment,
    sampleStatus: segment.tradeCount >= WALK_FORWARD_MIN_SEGMENT_TRADES ? "sufficient" : "insufficient_sample",
    edgeStatus: classifyEdge(segment, segment.tradeCount, 0),
  }));
}

function aggregateMetrics(
  trades: readonly BacktestTrade[],
  audits: readonly BacktestAuditRecord[],
  rejectedSetupCount: number,
): { metrics: BacktestMetrics; inSample: BacktestMetrics; outOfSample: BacktestMetrics } {
  const inSampleTrades = trades.filter((trade) => trade.period === "in_sample");
  const outOfSampleTrades = trades.filter((trade) => trade.period === "out_of_sample");
  return {
    metrics: calculateBacktestMetrics(trades, rejectedSetupCount, audits),
    inSample: calculateBacktestMetrics(
      inSampleTrades,
      audits.filter((record) => record.period === "in_sample").filter((record) => record.rejectionCategory !== "QUALIFIED").length,
      audits.filter((record) => record.period === "in_sample"),
    ),
    outOfSample: calculateBacktestMetrics(
      outOfSampleTrades,
      audits.filter((record) => record.period === "out_of_sample").filter((record) => record.rejectionCategory !== "QUALIFIED").length,
      audits.filter((record) => record.period === "out_of_sample"),
    ),
  };
}

function concentratedInDimension(segments: readonly WalkForwardSegment[], dimension: keyof BacktestSegmentation, totalTrades: number): boolean {
  if (totalTrades <= 0) return false;
  const values = segments.filter((segment) => segment.dimension === dimension && segment.tradeCount > 0);
  const largest = Math.max(...values.map((segment) => segment.tradeCount), 0);
  return largest / totalTrades > 0.8;
}

export function classifyEdge(
  metrics: Pick<BacktestMetrics, "tradeCount" | "expectancy" | "profitFactor" | "maximumDrawdown">,
  holdoutTradeCount: number,
  concentrationWarning = 0,
): WalkForwardEdgeStatus {
  if (metrics.tradeCount < WALK_FORWARD_MIN_TRADES || holdoutTradeCount < WALK_FORWARD_MIN_HOLDOUT_TRADES) {
    return "insufficient_evidence";
  }
  if (metrics.expectancy !== null && metrics.expectancy < 0) return "negative_observed_expectancy";
  if (
    metrics.expectancy === null
    || metrics.profitFactor === null
    || metrics.profitFactor <= 1
    || metrics.maximumDrawdown > WALK_FORWARD_RISK_TOLERANCE_DOLLARS
    || concentrationWarning > 0
  ) {
    return "mixed_inconclusive";
  }
  return "positive_observed_expectancy_requires_further_validation";
}

function classifyEvaluationEdge(
  metrics: BacktestMetrics,
  inSample: BacktestMetrics,
  outOfSample: BacktestMetrics,
  concentrationWarning: number,
): WalkForwardEdgeStatus {
  const status = classifyEdge(metrics, outOfSample.tradeCount, concentrationWarning);
  if (status === "insufficient_evidence") return status;
  if (outOfSample.expectancy !== null && outOfSample.expectancy < 0) return "negative_observed_expectancy";
  if (
    inSample.expectancy !== null
    && outOfSample.expectancy !== null
    && ((inSample.expectancy > 0 && outOfSample.expectancy <= 0)
      || (inSample.expectancy <= 0 && outOfSample.expectancy > 0))
  ) {
    return "mixed_inconclusive";
  }
  return status;
}

function foldStarts(dateCount: number, inSampleDays: number, outOfSampleDays: number): number[] {
  const foldLength = inSampleDays + outOfSampleDays;
  const starts: number[] = [];
  for (let start = 0; start + foldLength <= dateCount; start += outOfSampleDays) starts.push(start);
  return starts;
}

function evaluateFold(
  input: EvaluationInput,
  dates: readonly string[],
  start: number,
  inSampleDays: number,
  outOfSampleDays: number,
  sequence: number,
): WalkForwardFold {
  const inSampleDates = dates.slice(start, start + inSampleDays);
  const outOfSampleDates = dates.slice(start + inSampleDays, start + inSampleDays + outOfSampleDays);
  const foldDates = [...inSampleDates, ...outOfSampleDates];
  const selectedSet = new Set(foldDates);
  const inSampleSet = new Set(inSampleDates);
  const trades = reclassifyTrades(input.reports, inSampleSet, selectedSet);
  const audits = reclassifyAudits(input.reports, inSampleSet, selectedSet);
  const rejected = audits.filter((record) => record.rejectionCategory !== "QUALIFIED").length;
  const aggregated = aggregateMetrics(trades, audits, rejected);
  const segments = segmentsFor(trades, rejected);
  const concentrationWarning = (["contract", "contractMonth", "direction"] as Array<keyof BacktestSegmentation>)
    .filter((dimension) => concentratedInDimension(segments, dimension, aggregated.metrics.tradeCount)).length;
  return {
    foldId: `fold-${String(sequence + 1).padStart(2, "0")}`,
    sequence: sequence + 1,
    formulaHash: input.formulaHash,
    startDate: foldDates[0]!,
    endDate: foldDates.at(-1)!,
    inSampleDates,
    outOfSampleDates,
    contractPartitions: input.partitions
      .filter((partition) => selectedSet.has(partition.tradingDate))
      .map((partition) => ({
        tradingDate: partition.tradingDate,
        contractSymbol: partition.contractSymbol,
        period: periodForDate(partition.tradingDate, inSampleSet),
      })),
    ...aggregated,
    segments,
    edgeStatus: classifyEvaluationEdge(aggregated.metrics, aggregated.inSample, aggregated.outOfSample, concentrationWarning),
  };
}

export function evaluateWalkForward(input: EvaluationInput, inSampleDays: number, outOfSampleDays: number): WalkForwardReport {
  const dates = uniqueSorted(input.selectedDates);
  const selectedSet = new Set(dates);
  const inSampleSet = new Set(dates.slice(0, Math.max(0, dates.length - outOfSampleDays)));
  const trades = reclassifyTrades(input.reports, inSampleSet, selectedSet);
  const audits = reclassifyAudits(input.reports, inSampleSet, selectedSet);
  const rejected = audits.filter((record) => record.rejectionCategory !== "QUALIFIED").length;
  const aggregated = aggregateMetrics(trades, audits, rejected);
  const segments = segmentsFor(trades, rejected);
  const concentrationWarning = (["contract", "contractMonth", "direction"] as Array<keyof BacktestSegmentation>)
    .filter((dimension) => concentratedInDimension(segments, dimension, aggregated.metrics.tradeCount)).length;
  const folds = foldStarts(dates.length, inSampleDays, outOfSampleDays).map((start, index) =>
    evaluateFold(input, dates, start, inSampleDays, outOfSampleDays, index));
  return {
    formulaHash: input.formulaHash,
    formulaVersion: input.formulaVersion,
    foldCount: folds.length,
    folds,
    ...aggregated,
    segments,
    edgeStatus: classifyEvaluationEdge(aggregated.metrics, aggregated.inSample, aggregated.outOfSample, concentrationWarning),
    minimumEvidence: {
      totalTrades: aggregated.metrics.tradeCount,
      holdoutTrades: aggregated.outOfSample.tradeCount,
      requiredTotalTrades: WALK_FORWARD_MIN_TRADES,
      requiredHoldoutTrades: WALK_FORWARD_MIN_HOLDOUT_TRADES,
      riskToleranceDollars: WALK_FORWARD_RISK_TOLERANCE_DOLLARS,
    },
    sensitivity: [],
  };
}

export function buildSensitivityCase(
  evaluation: WalkForwardReport,
  scenario: WalkForwardSensitivityCase["scenario"],
  label: string,
  assumptions: string[],
): WalkForwardSensitivityCase {
  return {
    scenario,
    label,
    assumptions,
    formulaHash: evaluation.formulaHash,
    metrics: evaluation.metrics,
    inSample: evaluation.inSample,
    outOfSample: evaluation.outOfSample,
    edgeStatus: evaluation.edgeStatus,
  };
}