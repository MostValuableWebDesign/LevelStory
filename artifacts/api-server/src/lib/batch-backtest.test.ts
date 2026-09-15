import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateBatchReports,
  type BatchBacktestReport,
} from "./batch-backtest.js";
import type {
  BacktestReport,
  HistoricalOccurrence,
  HistoricalTradeCandidate,
} from "./phase9.js";

function report(overrides: Partial<BacktestReport>): BacktestReport {
  return {
    mode: "SHADOW MODE — NO LIVE ORDERS",
    dataSource: "historical_databento_multicontract",
    symbol: "MES",
    formulaHash: "formula",
    contract: { fullContractSymbol: "MESU2" } as BacktestReport["contract"],
    dataResolution: "one-minute-fallback",
    dataset: {
      startDate: "2022-08-10",
      endDate: "2022-08-10",
      requestedStartDate: "2022-08-10",
      requestedEndDate: "2022-08-10",
      selectedDates: ["2022-08-10"],
      inSampleDates: ["2022-08-10"],
      outOfSampleDates: [],
      excludedDates: [],
      untouchedOutOfSample: true,
      optimizationApplied: false,
    },
    replay: {
      cursor: 1,
      visibleCandleCount: 1,
      visibleCandleCloseTime: null,
      mode: "replay",
      totalCandleCount: 1,
      causal: true,
      futureCandleAccess: false,
    },
    metrics: {} as BacktestReport["metrics"],
    executionSummary: {
      detectedCandidateCount: 2,
      eligibleCandidateCount: 1,
      rejectedCandidateCount: 1,
      nonEnteredCandidateCount: 1,
      accountEntryBlockedCandidateCount: 0,
      accountPositionStateVersion: "test",
      enteredTradeCount: 0,
      finalizedTradeCount: 0,
      openTradeCount: 0,
      ambiguousEntryCount: 0,
      unresolvedAmbiguousTradeCount: 0,
      conservativelyResolvedTradeCount: 0,
      unscoredTradeCount: 0,
    },
    inSample: {} as BacktestReport["inSample"],
    outOfSample: {} as BacktestReport["outOfSample"],
    segments: [],
    trades: [],
    candidateExecutionEvidence: [],
    tradeCandidates: [],
    rejectedCandidateSignals: [],
    orphanModeledTrades: [],
    audit: [],
    occurrences: [],
    assumptions: [],
    executionMode: "ohlcv_modeled",
    fillLabel: "OHLCV",
    executionPolicy: {
      entryBufferTicks: 4,
      immediateNextCandleOnly: true,
      entrySlippageTicks: 0,
      exitSlippageTicks: 0,
      stopRule: "test",
      ambiguityRule: "test",
      commissionPerContract: 0,
    },
    gapReport: {} as BacktestReport["gapReport"],
    ...overrides,
  };
}

function occurrence(id: string): HistoricalOccurrence {
  return { occurrenceId: id, kind: "risk" } as HistoricalOccurrence;
}

function candidate(id: string): HistoricalTradeCandidate {
  return { candidateId: id, signalOccurrenceId: `${id}-signal` } as HistoricalTradeCandidate;
}

test("batch aggregation preserves execution and occurrence data from every partition", () => {
  const first = report({
    occurrences: [occurrence("occ-1")],
    tradeCandidates: [candidate("candidate-1")],
    dataset: {
      ...report({}).dataset,
      activeContractByDate: [{ tradingDate: "2022-08-10", contractSymbol: "MESU2" }],
    },
  });
  const second = report({
    occurrences: [occurrence("occ-2")],
    tradeCandidates: [candidate("candidate-2")],
    dataset: {
      ...report({}).dataset,
      startDate: "2022-08-11",
      endDate: "2022-08-11",
      requestedStartDate: "2022-08-11",
      requestedEndDate: "2022-08-11",
      selectedDates: ["2022-08-11"],
      inSampleDates: [],
      outOfSampleDates: ["2022-08-11"],
      activeContractByDate: [{ tradingDate: "2022-08-11", contractSymbol: "MESU2" }],
    },
  });
  const result = aggregateBatchReports(
    [first, second],
    [
      { tradingDate: "2022-08-10", contractSymbol: "MESU2", period: "in_sample", dataset: {} as never },
      { tradingDate: "2022-08-11", contractSymbol: "MESU2", period: "out_of_sample", dataset: {} as never },
    ],
    ["2022-08-10", "2022-08-11"],
    {} as BatchBacktestReport["walkForward"],
  );

  assert.equal(result.executionSummary.detectedCandidateCount, 4);
  assert.equal(result.executionSummary.eligibleCandidateCount, 2);
  assert.equal(result.executionSummary.nonEnteredCandidateCount, 2);
  assert.deepEqual(result.occurrences.map((item) => item.occurrenceId), ["occ-1", "occ-2"]);
  assert.deepEqual(result.tradeCandidates.map((item) => item.candidateId), ["candidate-1", "candidate-2"]);
  assert.equal(result.diagnostics?.tradeCandidates, 2);
});