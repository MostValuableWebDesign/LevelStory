import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  aggregateBatchReports,
  clearCatalogedSessionResultCache,
  getCatalogedSessionResultCacheStats,
  runBatchBacktest,
  type BatchBacktestReport,
  type BatchBacktestRequest,
} from "./batch-backtest.js";
import type {
  BacktestReport,
  CausalReplayDataset,
  HistoricalOccurrence,
  HistoricalTradeCandidate,
} from "./phase9.js";
import type { BacktestWorkerInput } from "./backtest-worker-client.js";
import { persistentSessionAnalysisStore } from "./session-analysis-store.js";

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

function trade(
  id: string,
  period: "in_sample" | "out_of_sample",
  outcome: string,
  candidateId = `${id}-candidate`,
): BacktestReport["trades"][number] {
  const tradingDate = period === "in_sample" ? "2022-08-10" : "2022-08-11";
  const entryTime = `${tradingDate}T14:00:00.000Z`;
  return {
    id,
    candidateId,
    signalOccurrenceId: `${candidateId}-signal`,
    tradingDate,
    contractSymbol: "MESU2",
    period,
    outcome,
    entryTime,
    exitTime: outcome === "open" ? null : `${tradingDate}T14:30:00.000Z`,
    ambiguityLabel: null,
    segmentation: {} as BacktestReport["trades"][number]["segmentation"],
  } as BacktestReport["trades"][number];
}

function candidate(id: string, period: "in_sample" | "out_of_sample" = "in_sample"): HistoricalTradeCandidate {
  const tradingDate = period === "in_sample" ? "2022-08-10" : "2022-08-11";
  return {
    candidateId: id,
    signalOccurrenceId: `${id}-signal`,
    tradingDate,
    contractSymbol: "MESU2",
    contractMonth: "U2",
    direction: "long",
    primaryEdge: "ORB_PULLBACK_CONTINUATION",
    period,
    entryObservationTimestamp: `${tradingDate}T14:00:00.000Z`,
    executionStatus: "MODELED_TRADE_CREATED",
    entryReachedThreshold: true,
  } as unknown as HistoricalTradeCandidate;
}

function sessionReport(tradingDate: string, period: "in_sample" | "out_of_sample"): BacktestReport {
  const base = report({
    dataset: {
      ...report({}).dataset,
      startDate: tradingDate,
      endDate: tradingDate,
      requestedStartDate: tradingDate,
      requestedEndDate: tradingDate,
      selectedDates: [tradingDate],
      inSampleDates: period === "in_sample" ? [tradingDate] : [],
      outOfSampleDates: period === "out_of_sample" ? [tradingDate] : [],
      activeContractByDate: [{ tradingDate, contractSymbol: "MESU2" }],
    },
  });
  return base;
}

function catalogEntry(tradingDate: string): import("./futures/historical-index-store.js").HistoricalSessionCatalogEntry {
  return {
    tradingDate,
    contractSymbol: "MESU2",
    sessionType: "cme_equity_index_globex",
    timeZone: "America/New_York",
    calendarIdentity: "calendar",
    partitionIdentity: `partition-${tradingDate}`,
    availableTimeframes: [1, 5],
    candleCounts: { oneMinute: 1, fiveMinute: 1, fifteenMinute: 0, oneHour: 0 },
    tickCoverage: "not_indexed",
    earliestTimestamp: `${tradingDate}T14:00:00.000Z`,
    latestTimestamp: `${tradingDate}T14:05:00.000Z`,
    coverageStatus: "complete",
    completenessStatus: "complete",
    validationStatus: "validated",
    sourceFingerprint: `source-${tradingDate}`,
    ingestionVersion: "ingestion-v1",
    normalizationVersion: "normalization-v1",
    schemaVersion: 1,
  };
}

function sessionDataset(dates: readonly string[]): CausalReplayDataset {
  return {
    candles: dates.map((tradingDate) => ({
      timestamp: Date.parse(`${tradingDate}T14:00:00.000Z`),
      openTime: Date.parse(`${tradingDate}T14:00:00.000Z`),
      closeTime: Date.parse(`${tradingDate}T14:05:00.000Z`),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      bid: 100,
      ask: 100,
      bidSize: 1,
      askSize: 1,
      contractSymbol: "MESU2",
      isComplete: true,
    })),
    oneMinute: [],
    contractSymbol: "MESU2",
    contractMonth: "U2",
    inSampleDates: dates.slice(0, -1),
    outOfSampleDates: dates.slice(-1),
    selectedDates: dates,
    source: "historical_databento_multicontract",
    contentFingerprint: "dataset-fingerprint",
    contractSchedule: {
      version: "schedule-v1",
      activeContractByDate: dates.map((tradingDate) => ({ tradingDate, contractSymbol: "MESU2" })),
      boundaries: [],
    },
  };
}

function batchRequest(selectedDates: readonly string[]): BatchBacktestRequest {
  return {
    symbol: "MES",
    startDate: selectedDates[0]!,
    endDate: selectedDates.at(-1)!,
    inSampleDays: selectedDates.length - 1,
    outOfSampleDays: 1,
    seed: 1,
    source: "historical_databento_multicontract",
    executionMode: "ohlcv_modeled",
    selectedDates: [...selectedDates],
  };
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

test("batch aggregation retains populated partition evidence and detects conflicting duplicate occurrences", () => {
  const first = report({
    trades: [trade("trade-final", "in_sample", "target", "candidate-final")],
    candidateExecutionEvidence: [trade("trade-final", "in_sample", "target", "candidate-final")],
    tradeCandidates: [candidate("candidate-final")],
    rejectedCandidateSignals: [{
      signalOccurrenceId: "rejected-final",
      reasonCodes: ["REJECTED_TEST"],
      details: ["first partition rejection"],
    }],
    orphanModeledTrades: [{
      tradeId: "orphan-final",
      matchingSignalOccurrenceId: "rejected-final",
      reason: "test orphan",
    }],
    occurrences: [occurrence("occ-shared"), occurrence("occ-final")],
    dataset: {
      ...report({}).dataset,
      activeContractByDate: [{ tradingDate: "2022-08-10", contractSymbol: "MESU2" }],
    },
    executionSummary: {
      ...report({}).executionSummary,
      detectedCandidateCount: 2,
      eligibleCandidateCount: 1,
      rejectedCandidateCount: 1,
      nonEnteredCandidateCount: 0,
      enteredTradeCount: 1,
      finalizedTradeCount: 1,
      openTradeCount: 0,
    },
  });
  const second = report({
    trades: [trade("trade-open", "out_of_sample", "open", "candidate-open")],
    candidateExecutionEvidence: [trade("trade-open", "out_of_sample", "open", "candidate-open")],
    tradeCandidates: [candidate("candidate-open", "out_of_sample")],
    rejectedCandidateSignals: [{
      signalOccurrenceId: "rejected-open",
      reasonCodes: ["REJECTED_TEST_2"],
      details: ["second partition rejection"],
    }],
    orphanModeledTrades: [{
      tradeId: "orphan-open",
      matchingSignalOccurrenceId: "rejected-open",
      reason: "second test orphan",
    }],
    occurrences: [
      { ...occurrence("occ-shared"), status: "conflicting-duplicate" } as HistoricalOccurrence,
      occurrence("occ-open"),
    ],
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
    executionSummary: {
      ...report({}).executionSummary,
      detectedCandidateCount: 2,
      eligibleCandidateCount: 1,
      rejectedCandidateCount: 1,
      nonEnteredCandidateCount: 0,
      enteredTradeCount: 1,
      finalizedTradeCount: 0,
      openTradeCount: 1,
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

  assert.deepEqual(result.trades.map((item) => item.id), ["trade-final", "trade-open"]);
  assert.deepEqual(result.candidateExecutionEvidence?.map((item) => item.id), ["trade-final", "trade-open"]);
  assert.equal(result.rejectedCandidateSignals.length, 2);
  assert.equal(result.orphanModeledTrades.length, 2);
  assert.equal(result.executionSummary.detectedCandidateCount, 4);
  assert.equal(result.executionSummary.eligibleCandidateCount, 2);
  assert.equal(result.executionSummary.rejectedCandidateCount, 2);
  assert.equal(result.executionSummary.enteredTradeCount, 2);
  assert.equal(result.executionSummary.finalizedTradeCount, 1);
  assert.equal(result.executionSummary.openTradeCount, 1);
  assert.equal(result.inSample.tradeCount, 1);
  assert.equal(result.outOfSample.tradeCount, 0);
  assert.equal(result.trades.filter((item) => item.period === "in_sample").length, 1);
  assert.equal(result.trades.filter((item) => item.period === "out_of_sample").length, 1);
  assert.equal(
    result.assumptions.find((assumption) => assumption.startsWith("Historical replay uses exactly ")),
    "Historical replay uses exactly 2 selected available trading dates; excluded dates are reported separately.",
  );
  assert.equal(result.occurrences.length, 3);
  assert.equal(
    result.diagnostics?.candidateInvariantViolations.includes("BATCH_DUPLICATE_OCCURRENCE_CONFLICT:occ-shared"),
    true,
  );
});

function executableCandidate(
  candidateId: string,
  tradingDate: string,
  contractSymbol = "MESU2",
): HistoricalTradeCandidate {
  return {
    candidateId,
    signalOccurrenceId: `${candidateId}-signal`,
    tradingDate,
    contractSymbol,
    contractMonth: contractSymbol.slice(-2),
    direction: "long",
    primaryEdge: "ORB_PULLBACK_CONTINUATION",
    period: tradingDate === "2022-08-10" ? "in_sample" : "out_of_sample",
    entryObservationTimestamp: `${tradingDate}T14:00:00.000Z`,
    executionStatus: "MODELED_TRADE_CREATED",
    entryReachedThreshold: true,
  } as unknown as HistoricalTradeCandidate;
}

test("batch account gating carries active positions across partitions unless a scheduled boundary resets them", () => {
  const firstCandidate = executableCandidate("partition-first", "2022-08-10");
  const secondCandidate = executableCandidate("partition-second", "2022-08-11");
  const firstTrade = trade("partition-first-trade", "in_sample", "open", firstCandidate.candidateId);
  const secondTrade = trade("partition-second-trade", "out_of_sample", "target", secondCandidate.candidateId);
  const first = report({
    trades: [firstTrade],
    candidateExecutionEvidence: [firstTrade],
    tradeCandidates: [firstCandidate],
    dataset: {
      ...report({}).dataset,
      activeContractByDate: [{ tradingDate: "2022-08-10", contractSymbol: "MESU2" }],
    },
  });
  const second = report({
    trades: [secondTrade],
    candidateExecutionEvidence: [secondTrade],
    tradeCandidates: [secondCandidate],
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

  assert.equal(result.executionSummary.accountEntryBlockedCandidateCount, 1);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0]?.candidateId, firstCandidate.candidateId);
  assert.equal(
    result.tradeCandidates.find((candidate) => candidate.candidateId === secondCandidate.candidateId)?.accountEntryStatus,
    "BLOCKED_ACTIVE_POSITION",
  );
});

test("overlapping cataloged ranges reuse valid session analysis and preserve the combined result", async () => {
  clearCatalogedSessionResultCache();
  const dates = ["2022-08-10", "2022-08-11", "2022-08-12"];
  const dataset = sessionDataset(dates);
  const context = {
    catalogEntries: dates.map(catalogEntry),
    sourceIdentity: { source: "catalog-source", calendar: "calendar-v1" },
    strategyIdentity: { strategy: "test-strategy", version: "v1", formulaHash: "formula" },
    initialState: { accountPosition: "flat", arbitration: "combined-chronological" },
  };
  const run = async (input: BacktestWorkerInput) => {
    const replayDataset = input.replayDataset!;
    const tradingDate = replayDataset.selectedDates?.[0] ?? dates[0]!;
    const period = replayDataset.inSampleDates.includes(tradingDate)
      ? "in_sample"
      : "out_of_sample";
    return sessionReport(tradingDate, period);
  };
  let calls = 0;
  const countedRun = async (input: BacktestWorkerInput) => {
    calls += 1;
    return run(input);
  };
  const options: Parameters<typeof runBatchBacktest>[1] = {
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    runPartition: countedRun,
    sessionCache: context,
  };
  await runBatchBacktest({
    request: batchRequest(dates),
    replayDataset: dataset,
  }, options);
  assert.equal(calls, 9);
  const cached = await runBatchBacktest({
    request: batchRequest(dates.slice(1)),
    replayDataset: dataset,
  }, options);
  assert.equal(calls, 9);
  assert.equal(getCatalogedSessionResultCacheStats().entries, 9);
  clearCatalogedSessionResultCache();
  const fresh = await runBatchBacktest({
    request: batchRequest(dates.slice(1)),
    replayDataset: dataset,
  }, options);
  assert.equal(calls, 15);
  assert.deepEqual(cached, fresh);
});

test("persisted session evidence survives cache eviction while combined replay remains chronological", async () => {
  clearCatalogedSessionResultCache();
  const dates = ["2022-08-10", "2022-08-11", "2022-08-12"];
  const dataset = sessionDataset(dates);
  const sourceRun = randomUUID();
  const context = {
    catalogEntries: dates.map(catalogEntry),
    sourceIdentity: { source: "persistent-session-test", run: sourceRun, calendar: "calendar-v1" },
    strategyIdentity: { strategy: "test-strategy", version: "v1", formulaVersion: "formula-v1", formulaHash: "formula" },
    initialState: { accountPosition: "flat", arbitration: "combined-chronological" },
  };
  const run = async (input: BacktestWorkerInput) => {
    const replayDataset = input.replayDataset!;
    const tradingDate = replayDataset.selectedDates?.[0] ?? dates[0]!;
    const period = replayDataset.inSampleDates.includes(tradingDate) ? "in_sample" : "out_of_sample";
    return sessionReport(tradingDate, period);
  };
  let calls = 0;
  const options: Parameters<typeof runBatchBacktest>[1] = {
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    runPartition: async (input) => {
      calls += 1;
      return run(input);
    },
    sessionCache: context,
    persistentSessionCache: persistentSessionAnalysisStore,
    includeSensitivity: false,
  };
  const first = await runBatchBacktest({ request: batchRequest(dates), replayDataset: dataset }, options);
  assert.equal(calls, dates.length);
  clearCatalogedSessionResultCache();
  const persisted = await runBatchBacktest({ request: batchRequest(dates), replayDataset: dataset }, options);
  assert.equal(calls, dates.length);
  assert.deepEqual(persisted.trades, first.trades);
  assert.deepEqual(persisted.accountReplay, first.accountReplay);
});

test("a changed earlier exit changes downstream account arbitration without recomputing session evidence", () => {
  const firstCandidate = executableCandidate("changed-first", "2022-08-10");
  const secondCandidate = executableCandidate("changed-second", "2022-08-11");
  const openFirst = report({
    trades: [trade("changed-first-trade", "in_sample", "open", firstCandidate.candidateId)],
    candidateExecutionEvidence: [trade("changed-first-trade", "in_sample", "open", firstCandidate.candidateId)],
    tradeCandidates: [firstCandidate],
  });
  const later = report({
    trades: [trade("changed-second-trade", "out_of_sample", "target", secondCandidate.candidateId)],
    candidateExecutionEvidence: [trade("changed-second-trade", "out_of_sample", "target", secondCandidate.candidateId)],
    tradeCandidates: [secondCandidate],
    dataset: { ...report({}).dataset, selectedDates: ["2022-08-11"], inSampleDates: [], outOfSampleDates: ["2022-08-11"] },
  });
  const openResult = aggregateBatchReports(
    [openFirst, later],
    [
      { tradingDate: "2022-08-10", contractSymbol: "MESU2", period: "in_sample", dataset: {} as never },
      { tradingDate: "2022-08-11", contractSymbol: "MESU2", period: "out_of_sample", dataset: {} as never },
    ],
    ["2022-08-10", "2022-08-11"],
    {} as BatchBacktestReport["walkForward"],
  );
  const closedFirst = report({
    trades: [trade("changed-first-trade", "in_sample", "target", firstCandidate.candidateId)],
    candidateExecutionEvidence: [trade("changed-first-trade", "in_sample", "target", firstCandidate.candidateId)],
    tradeCandidates: [firstCandidate],
  });
  const closedResult = aggregateBatchReports(
    [closedFirst, later],
    [
      { tradingDate: "2022-08-10", contractSymbol: "MESU2", period: "in_sample", dataset: {} as never },
      { tradingDate: "2022-08-11", contractSymbol: "MESU2", period: "out_of_sample", dataset: {} as never },
    ],
    ["2022-08-10", "2022-08-11"],
    {} as BatchBacktestReport["walkForward"],
  );
  assert.equal(openResult.trades.length, 1);
  assert.equal(closedResult.trades.length, 2);
  assert.equal(openResult.accountReplay.blockedCandidateCount, 1);
  assert.equal(closedResult.accountReplay.blockedCandidateCount, 0);
});

test("an empty cataloged range fails without producing a partial combined result", async () => {
  await assert.rejects(
    runBatchBacktest({
      request: {
        symbol: "MES",
        startDate: "2022-08-10",
        endDate: "2022-08-10",
        inSampleDays: 1,
        outOfSampleDays: 0,
        seed: 1,
        source: "historical_databento_multicontract",
        executionMode: "ohlcv_modeled",
        selectedDates: ["2022-08-10"],
      },
      replayDataset: {
        ...sessionDataset([]),
        contractSchedule: {
          version: "schedule-v1",
          activeContractByDate: [{ tradingDate: "2022-08-10", contractSymbol: "MESU2" }],
          boundaries: [],
        },
      },
    }, { timeoutMs: 100, signal: new AbortController().signal }),
    /no completed candles/,
  );
});