import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhase3PilotManifest,
  buildPhase3PilotPartitions,
  runPhase3EdgePilot,
  PHASE3_EDGES,
  PHASE3_IN_SAMPLE_DAYS,
  PHASE3_OUT_OF_SAMPLE_DAYS,
  PHASE3_TOTAL_DAYS,
  reconcilePhase3SignalFunnel,
  type Phase3Checkpoint,
} from "./phase3-edge-pilot.js";
import type {
  BacktestReport,
  BacktestRequest,
  BacktestTrade,
  CausalReplayDataset,
  HistoricalTradeCandidate,
} from "./phase9.js";
import { activeShadowStrategySnapshot } from "./active-shadow-strategy.js";

const dates = Array.from({ length: PHASE3_TOTAL_DAYS }, (_, index) =>
  `2026-07-${String(index + 1).padStart(2, "0")}`);

function dataset(overrides: Partial<CausalReplayDataset> = {}): CausalReplayDataset {
  return {
    source: "historical_databento_multicontract",
    contentFingerprint: "a".repeat(64),
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    candles: dates.map((tradingDate) => {
      const openTime = Date.parse(`${tradingDate}T14:00:00.000Z`);
      return {
        timestamp: openTime,
        openTime,
        closeTime: openTime + 300_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
        bid: 99.75,
        ask: 100.25,
        bidSize: 1,
        askSize: 1,
        contractSymbol: "MESU6",
        isComplete: true,
      };
    }),
    selectedDates: dates,
    inSampleDates: dates.slice(0, PHASE3_IN_SAMPLE_DAYS),
    outOfSampleDates: dates.slice(PHASE3_IN_SAMPLE_DAYS),
    excludedDates: [],
    contractSchedule: {
      version: "MES_QUARTERLY_2026_01",
      activeContractByDate: dates.map((tradingDate) => ({ tradingDate, contractSymbol: "MESU6" })),
      boundaries: [],
    },
    ...overrides,
  };
}

const request: BacktestRequest = {
  symbol: "MES",
  source: "historical_databento_multicontract",
  endDate: dates.at(-1)!,
  inSampleDays: PHASE3_IN_SAMPLE_DAYS,
  outOfSampleDays: PHASE3_OUT_OF_SAMPLE_DAYS,
  executionMode: "ohlcv_modeled",
};

function candidate(overrides: Partial<HistoricalTradeCandidate> = {}): HistoricalTradeCandidate {
  return {
    candidateId: "candidate-1",
    signalOccurrenceId: "signal-1",
    sourceFingerprint: "a".repeat(64),
    formulaHash: "b".repeat(64),
    formulaVersion: "phase9-fixed-formula-v2",
    contractSymbol: "MESU6",
    tradingDate: dates[0]!,
    direction: "long",
    primaryEdge: "ORB_PULLBACK_CONTINUATION",
    matchedEdges: ["PATIENCE_CANDLE_CONTINUATION"],
    supportingConfluences: ["volume"],
    qualifyingLevelIdentifiers: ["ORB"],
    qualifyingLevelValues: { ORB: 100 },
    pOpenTimestamp: "2026-07-01T14:55:00.000Z",
    eOpenTimestamp: "2026-07-01T15:00:00.000Z",
    entryObservationTimestamp: "2026-07-01T15:05:00.000Z",
    patienceTimestamp: "2026-07-01T14:55:00.000Z",
    expectedEntryTimestamp: "2026-07-01T15:00:00.000Z",
    confirmationPrice: 101,
    confirmationBufferTicks: 8,
    grade: "A+",
    causalIdentity: {
      signalOccurrenceId: "signal-1",
      eligibilityArmId: null,
      activeConsolidationZoneId: null,
    },
    eligible: true,
    executionStatus: "MODELED_TRADE_CREATED",
    fillModelType: "OHLCV_CONFIRMATION_THRESHOLD",
    patienceHigh: 101,
    patienceLow: 99,
    entryHigh: 103,
    entryLow: 100,
    entryReachedThreshold: true,
    managementContext: {
      candidateId: "candidate-1",
      causalIdentity: {
        signalOccurrenceId: "signal-1",
        eligibilityArmId: null,
        activeConsolidationZoneId: null,
      },
      signalOccurrenceId: "signal-1",
      patienceCandleOpenTime: "2026-07-01T14:55:00.000Z",
      patienceCandleHigh: 101,
      patienceCandleLow: 99,
      stopBufferTicks: 12,
      tickSize: 0.25,
      derivedStrategyStop: 97,
      frozenAt: "2026-07-01T15:00:00.000Z",
      direction: "long",
      contracts: 1,
      entryPrice: 101,
      strategyStopPrice: 99,
      catastropheStopPrice: 98,
      targetPrice: 105,
      runnerActivationPrice: null,
      runnerExitRule: null,
      sessionCloseTime: "2026-07-01T20:00:00.000Z",
      sourceAuditId: "audit-1",
      managementEvidenceStatus: "complete",
      missingEvidenceReasons: [],
    },
    ...overrides,
  };
}

function report(
  replayDataset: CausalReplayDataset,
  candidates: HistoricalTradeCandidate[] = [],
  options: { syntheticFixture?: boolean; audit?: any[] } = {},
): BacktestReport {
  return {
    dataset: {
      startDate: replayDataset.selectedDates?.[0] ?? dates[0]!,
      endDate: replayDataset.selectedDates?.[0] ?? dates[0]!,
      requestedStartDate: replayDataset.selectedDates?.[0] ?? dates[0]!,
      requestedEndDate: replayDataset.selectedDates?.[0] ?? dates[0]!,
      selectedDates: replayDataset.selectedDates ?? [],
      inSampleDates: replayDataset.inSampleDates,
      outOfSampleDates: replayDataset.outOfSampleDates,
      excludedDates: [],
      untouchedOutOfSample: true,
      optimizationApplied: false,
    },
    replay: {
      cursor: 1,
      visibleCandleCount: 1,
      visibleCandleCloseTime: 300_000,
      mode: "replay",
      totalCandleCount: 1,
      causal: true,
      futureCandleAccess: false,
    },
    tradeCandidates: candidates,
    trades: [],
    occurrences: [],
    audit: options.audit ?? [],
    ...(options.syntheticFixture === true ? { syntheticFixture: true } : {}),
  } as unknown as BacktestReport;
}

function confirmedSignal(overrides: Record<string, unknown> = {}): any {
  return {
    occurrenceId: "signal-1",
    auditId: "audit-1",
    auditIds: ["audit-1"],
    kind: "patience",
    canonicalOccurrence: true,
    status: "SIGNAL_CONFIRMED",
    strategyCandidate: "ORB_PULLBACK_CONTINUATION",
    primaryEdge: "ORB_PULLBACK_CONTINUATION",
    matchedEdges: ["ORB_PULLBACK_CONTINUATION"],
    secondaryStrategyMatches: [],
    tradingDate: dates[0],
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    direction: "long",
    directionSource: "ORB_BREAKOUT",
    directionSources: ["ORB_BREAKOUT"],
    lTimestamp: "2026-07-01T14:50:00.000Z",
    pOpenTimestamp: "2026-07-01T14:55:00.000Z",
    eOpenTimestamp: "2026-07-01T15:00:00.000Z",
    entryObservationTimestamp: "2026-07-01T15:05:00.000Z",
    patienceTimestamp: "2026-07-01T14:55:00.000Z",
    levelIdentifiers: ["ORB"],
    levelValues: { ORB: 100 },
    levelDistancesTicks: { ORB: 0 },
    levelToleranceTicks: { ORB: 12 },
    levelInteractionTypes: { ORB: ["touch"] },
    confirmationThreshold: 101,
    confirmationExcursion: 1,
    confirmationBufferTicks: 8,
    entryCandle: { high: 102 },
    ...overrides,
  };
}

function orbEvidence(overrides: Record<string, unknown> = {}) {
  return {
    sourceAuditId: "audit-orb",
    sourceEdge: "ORB_PULLBACK_CONTINUATION",
    evidenceTimestamp: "2026-07-01T14:55:00.000Z",
    ruleEvidence: [
      "PASS ntzComplete: finalized ORB",
      "PASS closeOutsideNtz: breakout completed",
      "PASS breakoutContinuation: continuation confirmed",
      "PASS genuinePullback: pullback qualified",
      "PASS levelContext: level tolerance interaction",
      "PASS validPatienceCandle: valid P candle",
      "PASS immediateTrigger: immediate E reached buffer",
    ],
    orbState: "COMPLETED",
    breakoutEvidence: "Directional breakout completed.",
    pullbackEvidence: "Qualifying pullback recorded.",
    criticalLevelEvidence: "ORB within governed tolerance.",
    trendEvidence: "bullish: confirmed",
    patienceState: "ENTRY_TRIGGERED",
    patienceCandleOpenTime: "2026-07-01T14:55:00.000Z",
    patienceCandleCloseTime: "2026-07-01T15:00:00.000Z",
    triggerCandleOpenTime: "2026-07-01T15:00:00.000Z",
    triggerCandleCloseTime: "2026-07-01T15:05:00.000Z",
    ...overrides,
  };
}

function reconcileFixture(input: {
  occurrence?: any;
  candidates?: HistoricalTradeCandidate[];
  rejectedCandidateSignals?: Array<{ signalOccurrenceId: string; reasonCodes: string[]; details: string[] }>;
  trades?: BacktestTrade[];
  partitions?: any[];
  audit?: any[];
}, options: { allowSyntheticFixtures?: boolean } = {}) {
  const replayDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: replayDataset, request, createdAt: "2026-08-30T12:00:00.000Z" });
  const base = report(replayDataset, input.candidates ?? [], {
    audit: input.audit,
  });
  return reconcilePhase3SignalFunnel({
    manifest,
    reports: [{
      tradingDate: dates[0]!,
      contractSymbol: "MESU6",
      period: "in_sample",
      report: {
        ...base,
        occurrences: [input.occurrence ?? confirmedSignal()],
        rejectedCandidateSignals: input.rejectedCandidateSignals ?? [],
        trades: input.trades ?? [],
      },
    }],
    partitions: input.partitions ?? [],
  }, options);
}

function reconcileSyntheticFixture(input: Parameters<typeof reconcileFixture>[0]) {
  return reconcileFixture(input, { allowSyntheticFixtures: true });
}

test("Phase 3 manifest is immutable and stable across creation timestamps", () => {
  const first = buildPhase3PilotManifest({ dataset: dataset(), request, createdAt: "2026-08-30T12:00:00.000Z" });
  const second = buildPhase3PilotManifest({ dataset: dataset(), request, createdAt: "2026-08-30T12:01:00.000Z" });
  assert.equal(first.manifestVersion, "phase3-edge-validation-v1");
  assert.equal(first.manifestHash, second.manifestHash);
  assert.equal(first.source.selectedDates.length, 30);
  assert.equal(first.source.inSampleDates.length, 20);
  assert.equal(first.source.outOfSampleDates.length, 10);
  assert.equal(
    first.candidateIdentity.physicalOccurrenceKey,
    "sourceFingerprint|formulaHash|contractSymbol|tradingDate|direction|pOpenTimestamp|eOpenTimestamp",
  );
  assert.equal(first.candidateIdentity.oneCandidatePerPhysicalSequence, true);
  assert.equal(first.assumptions.noOptimization, true);
  assert.equal(first.execution.entryWindow.endMinutesExclusive, 780);
});

test("Phase 3 partitions isolate one contract/date and preserve the 20/10 split", () => {
  const partitions = buildPhase3PilotPartitions(dataset());
  assert.equal(partitions.length, 30);
  assert.deepEqual(partitions.slice(0, 20).map((item) => item.period), Array(20).fill("in_sample"));
  assert.deepEqual(partitions.slice(20).map((item) => item.period), Array(10).fill("out_of_sample"));
  assert.ok(partitions.every((item) => item.dataset.selectedDates?.length === 1));
});

test("Phase 3 reconciliation gives each confirmed signal one disposition and keeps zero buckets", () => {
  const replayDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: replayDataset, request, createdAt: "2026-08-30T12:00:00.000Z" });
  const confirmedOccurrence = {
    occurrenceId: "signal-1",
    auditId: "audit-1",
    auditIds: ["audit-1"],
    kind: "patience",
    canonicalOccurrence: true,
    status: "SIGNAL_CONFIRMED",
    strategyCandidate: "ORB_PULLBACK_CONTINUATION",
    primaryEdge: "ORB_PULLBACK_CONTINUATION",
    matchedEdges: ["ORB_PULLBACK_CONTINUATION"],
    secondaryStrategyMatches: [],
    tradingDate: dates[0],
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    direction: "long",
    directionSource: "ORB_BREAKOUT",
    directionSources: ["ORB_BREAKOUT"],
    lTimestamp: "2026-07-01T14:50:00.000Z",
    pOpenTimestamp: "2026-07-01T14:55:00.000Z",
    eOpenTimestamp: "2026-07-01T15:00:00.000Z",
    entryObservationTimestamp: "2026-07-01T15:05:00.000Z",
    patienceTimestamp: "2026-07-01T14:55:00.000Z",
    levelIdentifiers: ["ORB"],
    levelValues: { ORB: 100 },
    levelDistancesTicks: { ORB: 0 },
    levelToleranceTicks: { ORB: 12 },
    levelInteractionTypes: { ORB: ["touch"] },
    confirmationThreshold: 101,
    confirmationExcursion: 1,
    confirmationBufferTicks: 8,
    entryCandle: { high: 102 },
  } as never;
  const item = {
    tradingDate: dates[0]!,
    contractSymbol: "MESU6",
    period: "in_sample" as const,
    report: {
      ...report(replayDataset, [candidate()]),
      occurrences: [confirmedOccurrence],
      rejectedCandidateSignals: [],
      orphanModeledTrades: [],
    },
  };
  const result = reconcilePhase3SignalFunnel({
    manifest,
    reports: [item],
    partitions: [],
  }, { allowSyntheticFixtures: true });
  assert.equal(result.reconciliation.confirmedSignalCount, 1);
  assert.equal(result.reconciliation.dispositionReconciles, true);
  assert.equal(Object.values(result.reconciliation.dispositionCounts).reduce((sum, count) => sum + count, 0), 1);
  assert.equal(result.reconciliation.timeBuckets["09:30-10:00"].confirmed, 0);
  assert.equal(result.reconciliation.signals[0]!.signalOccurrenceId, "signal-1");
});

test("Phase 3 real reports fail closed when the matching partition is missing", () => {
  const staleTrade = {
    id: "stale-trade",
    candidateId: "candidate-1",
    signalOccurrenceId: "signal-1",
    outcome: "target",
    netPnl: 125,
  } as unknown as BacktestTrade;
  const result = reconcileFixture({
    audit: [{ id: "raw-audit" }],
    candidates: [candidate()],
    trades: [staleTrade],
  });
  const corrected = result.reports[0]!.report;
  assert.equal(corrected.tradeCandidates.length, 0);
  assert.equal(corrected.trades.length, 0);
  assert.equal(corrected.metrics.tradeCount, 0);
  assert.equal(corrected.metrics.netPnl, 0);
  assert.equal(corrected.inSample.netPnl, 0);
  assert.equal(corrected.outOfSample.netPnl, 0);
  assert.deepEqual(
    result.reconciliation.reconciliationErrors.map((error) => error.code),
    ["PHASE3_LIFECYCLE_RECONCILIATION_UNAVAILABLE", "PHASE3_PARTITION_MISSING"],
  );
  assert.ok(result.reconciliation.invariantViolations.includes("PHASE3_PARTITION_MISSING:2026-07-01|MESU6"));
  assert.equal(result.reconciliation.signals[0]?.disposition, "rejected_multiple_predicates");
});

test("Phase 3 real reports fail closed when the raw audit stream is empty", () => {
  const replayDataset = dataset();
  const result = reconcileFixture({
    candidates: [candidate()],
    trades: [{
      id: "stale-trade",
      candidateId: "candidate-1",
      signalOccurrenceId: "signal-1",
      outcome: "target",
      netPnl: 125,
    } as unknown as BacktestTrade],
    partitions: buildPhase3PilotPartitions(replayDataset).slice(0, 1),
  });
  const corrected = result.reports[0]!.report;
  assert.equal(corrected.tradeCandidates.length, 0);
  assert.equal(corrected.trades.length, 0);
  assert.equal(corrected.metrics.netPnl, 0);
  assert.ok(result.reconciliation.reconciliationErrors.some((error) =>
    error.code === "PHASE3_AUDIT_STREAM_MISSING"));
  assert.ok(result.reconciliation.invariantViolations.includes("PHASE3_AUDIT_STREAM_MISSING:2026-07-01|MESU6"));
});

test("Phase 3 internal test-mode authorization retains compatibility without raw evidence", () => {
  const staleTrade = {
    id: "fixture-trade",
    candidateId: "candidate-1",
    signalOccurrenceId: "signal-1",
    outcome: "open",
    netPnl: 0,
  } as unknown as BacktestTrade;
  const result = reconcileFixture({
    candidates: [candidate()],
    trades: [staleTrade],
  }, { allowSyntheticFixtures: true });
  assert.equal(result.reports[0]!.report.tradeCandidates.length, 1);
  assert.equal(result.reports[0]!.report.trades.length, 1);
  assert.deepEqual(result.reconciliation.reconciliationErrors, []);
});

test("Phase 3 ignores a persisted synthetic marker during production reconciliation", () => {
  const staleTrade = {
    id: "persisted-stale-trade",
    candidateId: "candidate-1",
    signalOccurrenceId: "signal-1",
    outcome: "target",
    netPnl: 125,
  } as unknown as BacktestTrade;
  const replayDataset = dataset();
  const base = report(replayDataset, [candidate()], { syntheticFixture: true });
  const result = reconcilePhase3SignalFunnel({
    manifest: buildPhase3PilotManifest({ dataset: replayDataset, request }),
    reports: [{
      tradingDate: dates[0]!,
      contractSymbol: "MESU6",
      period: "in_sample",
      report: {
        ...base,
        syntheticFixture: true,
        occurrences: [confirmedSignal()],
        trades: [staleTrade],
      } as unknown as BacktestReport,
    }],
    partitions: [],
  });
  const corrected = result.reports[0]!.report;
  assert.equal(corrected.tradeCandidates.length, 0);
  assert.equal(corrected.trades.length, 0);
  assert.equal(corrected.segments.length, 0);
  assert.equal(corrected.metrics.netPnl, 0);
  assert.ok(result.reconciliation.reconciliationErrors.some((error) =>
    error.code === "PHASE3_PARTITION_MISSING"));
});

test("Phase 3 clears stale segments and profitable metrics on reconciliation failure", () => {
  const replayDataset = dataset();
  const staleTrade = {
    id: "stale-segment-trade",
    candidateId: "candidate-1",
    signalOccurrenceId: "signal-1",
    outcome: "target",
    netPnl: 125,
  } as unknown as BacktestTrade;
  const base = report(replayDataset, [candidate()], { audit: [{ id: "raw-audit" }] });
  const result = reconcilePhase3SignalFunnel({
    manifest: buildPhase3PilotManifest({ dataset: replayDataset, request }),
    reports: [{
      tradingDate: dates[0]!,
      contractSymbol: "MESU6",
      period: "in_sample",
      report: {
        ...base,
        metrics: {
          tradeCount: 1,
          winRate: 100,
          averageWin: 125,
          averageLoss: null,
          expectancy: 125,
          profitFactor: null,
          maximumDrawdown: 0,
          grossPnl: 125,
          fees: 5,
          slippage: 2,
          netPnl: 118,
        },
        inSample: { netPnl: 118, tradeCount: 1 },
        outOfSample: { netPnl: 118, tradeCount: 1 },
        executionSummary: {
          eligibleCandidateCount: 1,
          enteredTradeCount: 1,
          finalizedTradeCount: 1,
          openTradeCount: 0,
          ambiguousEntryCount: 0,
          unresolvedAmbiguousTradeCount: 0,
          conservativelyResolvedTradeCount: 0,
          unscoredTradeCount: 0,
        },
        segments: [{ dimension: "direction", value: "long", tradeCount: 1, netPnl: 118 }],
        trades: [staleTrade],
      } as unknown as BacktestReport,
    }],
    partitions: [],
  });
  const corrected = result.reports[0]!.report;
  assert.deepEqual(corrected.trades, []);
  assert.deepEqual(corrected.tradeCandidates, []);
  assert.deepEqual(corrected.segments, []);
  assert.equal(corrected.metrics.tradeCount, 0);
  assert.equal(corrected.metrics.netPnl, 0);
  assert.equal(corrected.metrics.maximumDrawdown, 0);
  assert.equal(corrected.metrics.fees, 0);
  assert.equal(corrected.metrics.slippage, 0);
  assert.equal(corrected.inSample.tradeCount, 0);
  assert.equal(corrected.outOfSample.tradeCount, 0);
  assert.equal(corrected.executionSummary.eligibleCandidateCount, 0);
  assert.ok(result.reconciliation.reconciliationErrors.some((error) =>
    error.code === "PHASE3_LIFECYCLE_RECONCILIATION_UNAVAILABLE"));
});

function historicalAuditRecord(tradingDate: string): any {
  const lOpen = Date.parse(`${tradingDate}T14:50:00.000Z`);
  const pOpen = Date.parse(`${tradingDate}T14:55:00.000Z`);
  const eOpen = Date.parse(`${tradingDate}T15:00:00.000Z`);
  const lCandle = { openTime: lOpen, closeTime: lOpen + 300_000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10, isComplete: true };
  const pCandle = { openTime: pOpen, closeTime: pOpen + 300_000, open: 100, high: 101, low: 99, close: 100.5, volume: 11, isComplete: true };
  const eCandle = { openTime: eOpen, closeTime: eOpen + 300_000, open: 100.5, high: 101.25, low: 100, close: 101, volume: 12, isComplete: true };
  return {
    id: "historical-audit",
    tradingDate,
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    period: "in_sample",
    evaluatedCandleOpenTime: new Date(eOpen).toISOString(),
    setupType: "ORB_PULLBACK_CONTINUATION",
    direction: "long",
    decision: "SETUP QUALIFIED",
    alertOnly: true,
    rejectionReason: null,
    rejectionCategory: "QUALIFIED",
    rejectionSummary: null,
    ruleEvidence: [],
    orbState: "ENTRY_TRIGGERED",
    breakoutEvidence: "Directional breakout completed.",
    volumeEvidence: "",
    pullbackEvidence: "Qualifying pullback recorded.",
    criticalLevelEvidence: "ORB retest touched the causal level.",
    trendEvidence: "bullish: confirmed",
    patienceState: "ENTRY_TRIGGERED",
    patienceCandle: pCandle,
    triggerCandle: eCandle,
    patienceCandleOpenTime: new Date(pOpen).toISOString(),
    patienceCandleCloseTime: new Date(pOpen + 300_000).toISOString(),
    triggerCandleOpenTime: new Date(eOpen).toISOString(),
    triggerCandleCloseTime: new Date(eOpen + 300_000).toISOString(),
    modeledFillObservationTime: new Date(eOpen + 300_000).toISOString(),
    exitCandleOpenTime: null,
    exitCandleCloseTime: null,
    entryTriggerPrice: 101,
    strategyStopPrice: 97,
    catastropheStopPrice: 95,
    targetPrice: 105,
    eventLabels: [],
    ambiguityLabels: [],
    executionMode: "ohlcv_modeled",
    fees: 0,
    slippage: 0,
    grossPnl: null,
    netPnl: null,
    exitReason: null,
    confirmationBufferTicks: 8,
    consolidationThresholds: {},
    pullbackOccurrences: [{
      type: "touch",
      time: new Date(lOpen).toISOString(),
      level: "ORB",
      price: 100,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      candle: lCandle,
      detail: "ORB retest touched the causal level.",
    }],
    patienceOccurrences: [{
      occurrenceId: "historical-p1",
      direction: "long",
      entryBufferTicks: 8,
      stopBufferTicks: 12,
      eligibilityReason: "pullback",
      eligibilityTime: lOpen,
      previousComparisonTimestamp: lOpen,
      candidateShapeResult: true,
      expectedEntryCandleOpenTime: eOpen,
      confirmationThreshold: 101,
      actualConfirmationExcursion: 1.25,
      previousCandle: lCandle,
      patienceCandle: pCandle,
      triggerCandle: eCandle,
      nextObservedCandle: null,
      outcomeStatus: "CONFIRMED",
      qualificationStatus: "SIGNAL_CONFIRMED",
      status: "ENTRY_TRIGGERED",
      reasonCode: "Immediate next candle reached the confirmation buffer.",
      evaluationCursor: eOpen + 300_000,
    }],
  };
}

test("Phase 3 valid historical reports rebuild lifecycle and candidate evidence", () => {
  const replayDataset = dataset({
    selectedDates: [dates[0]!],
    inSampleDates: [dates[0]!],
    outOfSampleDates: [],
    candles: [
      {
        timestamp: Date.parse(`${dates[0]}T14:50:00.000Z`),
        openTime: Date.parse(`${dates[0]}T14:50:00.000Z`),
        closeTime: Date.parse(`${dates[0]}T14:55:00.000Z`),
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 10,
        bid: 99.75,
        ask: 100.25,
        bidSize: 1,
        askSize: 1,
        contractSymbol: "MESU6",
        isComplete: true,
      },
      {
        timestamp: Date.parse(`${dates[0]}T14:55:00.000Z`),
        openTime: Date.parse(`${dates[0]}T14:55:00.000Z`),
        closeTime: Date.parse(`${dates[0]}T15:00:00.000Z`),
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 11,
        bid: 99.75,
        ask: 100.25,
        bidSize: 1,
        askSize: 1,
        contractSymbol: "MESU6",
        isComplete: true,
      },
      {
        timestamp: Date.parse(`${dates[0]}T15:00:00.000Z`),
        openTime: Date.parse(`${dates[0]}T15:00:00.000Z`),
        closeTime: Date.parse(`${dates[0]}T15:05:00.000Z`),
        open: 100.5,
        high: 101.25,
        low: 100,
        close: 101,
        volume: 12,
        bid: 100.25,
        ask: 100.75,
        bidSize: 1,
        askSize: 1,
        contractSymbol: "MESU6",
        isComplete: true,
      },
    ],
  });
  const manifest = buildPhase3PilotManifest({ dataset: dataset(), request, createdAt: "2026-08-30T12:00:00.000Z" });
  const result = reconcilePhase3SignalFunnel({
    manifest,
    reports: [{
      tradingDate: dates[0]!,
      contractSymbol: "MESU6",
      period: "in_sample",
      report: {
        ...report(replayDataset, [], { syntheticFixture: false, audit: [historicalAuditRecord(dates[0]!)] }),
        occurrences: [],
      },
    }],
    partitions: [{
      tradingDate: dates[0]!,
      contractSymbol: "MESU6",
      period: "in_sample",
      dataset: replayDataset,
    }],
  });
  const corrected = result.reports[0]!.report;
  assert.equal(result.reconciliation.reconciliationErrors.length, 0);
  assert.equal(corrected.tradeCandidates.length, 1);
  assert.equal(corrected.tradeCandidates[0]?.pOpenTimestamp, `${dates[0]}T14:55:00.000Z`);
  assert.equal(corrected.tradeCandidates[0]?.eOpenTimestamp, `${dates[0]}T15:00:00.000Z`);
  assert.equal(corrected.trades.length, 1);
  assert.equal(corrected.trades[0]?.candidateId, corrected.tradeCandidates[0]?.candidateId);
});

test("Phase 3 fails closed when a confirmed signal has neither candidate nor rejection", () => {
  const result = reconcileSyntheticFixture({});
  assert.equal(result.reconciliation.dispositionReconciles, false);
  assert.ok(result.reconciliation.invariantViolations.includes("UNEXPLAINED_CONFIRMED_SIGNAL:signal-1"));
  assert.equal(result.reconciliation.signals[0]?.disposition, "unexplained_confirmed_signal");
});

test("Phase 3 fails closed when a signal has both candidate and rejection", () => {
  const result = reconcileSyntheticFixture({
    candidates: [candidate()],
    rejectedCandidateSignals: [{
      signalOccurrenceId: "signal-1",
      reasonCodes: ["MISSING_EDGE_REQUIREMENT"],
      details: ["edge requirement failed"],
    }],
  });
  assert.equal(result.reconciliation.dispositionReconciles, false);
  assert.ok(result.reconciliation.invariantViolations.includes("CONTRADICTORY_PROJECTION:signal-1"));
  assert.equal(result.reconciliation.signals[0]?.disposition, "contradictory_projection");
});

test("Phase 3 fails closed when a candidate references no confirmed signal", () => {
  const result = reconcileSyntheticFixture({
    candidates: [candidate({ signalOccurrenceId: "nonexistent-signal" })],
  });
  assert.equal(result.reconciliation.dispositionReconciles, false);
  assert.ok(result.reconciliation.invariantViolations.includes("CANDIDATE_WITHOUT_CONFIRMED_SIGNAL:candidate-1"));
});

test("Phase 3 fails closed when an authoritative trade has no exact candidate", () => {
  const result = reconcileSyntheticFixture({
    trades: [{
      id: "orphan-trade",
      candidateId: "missing-candidate",
      signalOccurrenceId: "signal-1",
    } as unknown as BacktestTrade],
  });
  assert.equal(result.reconciliation.dispositionReconciles, false);
  assert.ok(result.reconciliation.invariantViolations.includes("TRADE_WITHOUT_EXACT_CANDIDATE:orphan-trade"));
});

test("Phase 3 preserves unverified confluence labels and audits every edge predicate", () => {
  const result = reconcileSyntheticFixture({ candidates: [candidate()] });
  const signal = result.reconciliation.signals[0]!;
  const confluence = result.reconciliation.candidateConfluences[0]!;
  assert.equal(result.reconciliation.dispositionReconciles, true);
  assert.deepEqual(Object.keys(signal.edgePredicates).sort(), [...PHASE3_EDGES].sort());
  assert.equal(signal.edgePredicates.ORB_PULLBACK_CONTINUATION.every((predicate) =>
    predicate.result === "PASS"), false);
  assert.ok(confluence.genericLabelsWithoutStructuredEvidence.includes("volume"));
  assert.equal(confluence.structuredEvidence.find((item) => item.confluenceType === "volume")?.predicateResult, "UNVERIFIED_CONFLUENCE_LABEL");
  assert.equal(confluence.structuredEvidence.find((item) => item.confluenceType === "volume")?.gradeEligible, false);
  assert.equal(confluence.structuredEvidence.find((item) => item.confluenceType === "ORB")?.gradeEligible, true);
});

test("Phase 3 does not infer an edge pass from labels alone", () => {
  const result = reconcileSyntheticFixture({
    occurrence: confirmedSignal({
      primaryEdge: "ORB_PULLBACK_CONTINUATION",
      matchedEdges: ["ORB_PULLBACK_CONTINUATION"],
    }),
    candidates: [candidate()],
  });
  const predicates = result.reconciliation.signals[0]!.edgePredicates.ORB_PULLBACK_CONTINUATION;
  assert.equal(predicates.every((predicate) => predicate.result === "PASS"), false);
  assert.ok(predicates.some((predicate) => predicate.result === "EVIDENCE_UNAVAILABLE"));
});

test("Phase 3 records one failed stored requirement without converting it to unavailable", () => {
  const result = reconcileSyntheticFixture({
    occurrence: confirmedSignal({
      causalEvidence: orbEvidence({
        sourceEdge: "ORB_PULLBACK_CONTINUATION",
        ruleEvidence: [
          "PASS ntzComplete: finalized ORB",
          "PASS closeOutsideNtz: breakout completed",
          "PASS breakoutContinuation: continuation confirmed",
          "FAIL levelContext: no qualifying level interaction",
        ],
      }),
    }),
    candidates: [candidate()],
  });
  const pullback = result.reconciliation.signals[0]!.edgePredicates.ORB_PULLBACK_CONTINUATION
    .find((predicate) => predicate.predicateName === "qualifying_pullback");
  assert.equal(pullback?.result, "FAIL");
  assert.match(pullback?.reason ?? "", /levelContext/);
});

test("Phase 3 keeps the ORB directional-break predicate passed when optional continuation evidence fails", () => {
  const result = reconcileSyntheticFixture({
    occurrence: confirmedSignal({
      causalEvidence: orbEvidence({
        sourceEdge: "ORB_PULLBACK_CONTINUATION",
        ruleEvidence: [
          "PASS ntzComplete: finalized ORB",
          "PASS closeOutsideNtz: breakout completed",
          "FAIL breakoutContinuation: continuation failed",
          "PASS levelContext: level tolerance interaction",
          "PASS validPatienceCandle: valid P candle",
          "PASS immediateTrigger: immediate E reached buffer",
        ],
      }),
    }),
    candidates: [candidate()],
  });
  const predicate = result.reconciliation.signals[0]!.edgePredicates.ORB_PULLBACK_CONTINUATION
    .find((item) => item.predicateName === "directional_break_completed");
  assert.equal(predicate?.result, "PASS");
});

test("Phase 3 uses the patience eligibility rule for continuation P evidence", () => {
  const result = reconcileSyntheticFixture({
    occurrence: confirmedSignal({
      causalEvidence: orbEvidence({
        sourceEdge: "PATIENCE_CANDLE_CONTINUATION",
        ruleEvidence: [
          "PASS confirmedTrend: trend confirmed",
          "PASS continuationContext: continuation context",
          "PASS patienceEligible: valid P candle",
          "PASS immediateTrigger: immediate E reached buffer",
        ],
      }),
    }),
    candidates: [candidate()],
  });
  const predicate = result.reconciliation.signals[0]!.edgePredicates.PATIENCE_CANDLE_CONTINUATION
    .find((item) => item.predicateName === "valid_p_candle");
  assert.equal(predicate?.result, "PASS");
});

test("Phase 3 uses consolidation-specific P evidence for the combined confirmation", () => {
  const complete = reconcileSyntheticFixture({
    occurrence: confirmedSignal({
      causalEvidence: orbEvidence({
        sourceEdge: "CONSOLIDATION_BREAKOUT_CONTINUATION",
        ruleEvidence: [
          "PASS extendedConsolidation: frozen range",
          "PASS rangeStable: governed stability",
          "PASS strongBreakout: close outside range",
          "PASS postBreakoutContext: continuation context",
          "PASS validPatienceNearLevel: valid P candle",
          "PASS immediateTrigger: immediate E reached buffer",
        ],
      }),
    }),
    candidates: [candidate()],
  });
  const completePredicate = complete.reconciliation.signals[0]!.edgePredicates.CONSOLIDATION_BREAKOUT_CONTINUATION
    .find((item) => item.predicateName === "valid_p_immediate_e_confirmation");
  assert.equal(completePredicate?.result, "PASS");

  const unrelated = reconcileSyntheticFixture({
    occurrence: confirmedSignal({
      causalEvidence: orbEvidence({
        sourceEdge: "CONSOLIDATION_BREAKOUT_CONTINUATION",
        ruleEvidence: [
          "PASS extendedConsolidation: frozen range",
          "PASS rangeStable: governed stability",
          "PASS strongBreakout: close outside range",
          "PASS postBreakoutContext: continuation context",
          "FAIL validPatienceNearLevel: missing level context",
          "PASS validPatienceCandle: unrelated P evidence",
          "PASS immediateTrigger: immediate E reached buffer",
        ],
      }),
    }),
    candidates: [candidate()],
  });
  const unrelatedPredicate = unrelated.reconciliation.signals[0]!.edgePredicates.CONSOLIDATION_BREAKOUT_CONTINUATION
    .find((item) => item.predicateName === "valid_p_immediate_e_confirmation");
  assert.equal(unrelatedPredicate?.result, "FAIL");
});

test("Phase 3 selects merged edge evidence by exact source edge in either audit order", () => {
  const patienceEvidence = {
    ...orbEvidence(),
    sourceAuditId: "audit-patience",
    sourceEdge: "PATIENCE_CANDLE_CONTINUATION",
    ruleEvidence: [
      "PASS confirmedTrend: trend confirmed",
      "PASS continuationContext: continuation context",
      "PASS patienceEligible: valid P candle",
      "PASS immediateTrigger: immediate E reached buffer",
    ],
  };
  for (const causalEvidenceByAudit of [
    [orbEvidence(), patienceEvidence],
    [patienceEvidence, orbEvidence()],
  ]) {
    const result = reconcileSyntheticFixture({
      occurrence: confirmedSignal({
        causalEvidence: causalEvidenceByAudit[0],
        causalEvidenceByAudit,
      }),
      candidates: [candidate()],
    });
    const signals = result.reconciliation.signals[0]!;
    const orb = signals.edgePredicates.ORB_PULLBACK_CONTINUATION
      .find((item) => item.predicateName === "finalized_orb_or_ntz");
    const patience = signals.edgePredicates.PATIENCE_CANDLE_CONTINUATION
      .find((item) => item.predicateName === "confirmed_15m_trend");
    assert.equal(orb?.sourceAuditId, "audit-orb");
    assert.equal(orb?.result, "PASS");
    assert.equal(patience?.sourceAuditId, "audit-patience");
    assert.equal(patience?.result, "PASS");
  }
});

test("Phase 3 does not reuse an ORB audit for unrelated edge confirmation", () => {
  const result = reconcileSyntheticFixture({
    occurrence: confirmedSignal({ causalEvidence: orbEvidence() }),
    candidates: [candidate()],
  });
  const reversal = result.reconciliation.signals[0]!.edgePredicates.EQUIVALENT_CANDLE_REVERSAL;
  const confirmation = reversal.find((item) => item.predicateName === "valid_p_immediate_e_confirmation");
  assert.equal(confirmation?.result, "EVIDENCE_UNAVAILABLE");
  assert.equal(confirmation?.sourceAuditId, null);
});

test("Phase 3 marks missing stored evidence as EVIDENCE_UNAVAILABLE", () => {
  const result = reconcileSyntheticFixture({
    occurrence: confirmedSignal({
      causalEvidence: orbEvidence({
        sourceEdge: "CONSOLIDATION_BREAKOUT_CONTINUATION",
        ruleEvidence: [],
      }),
    }),
    candidates: [candidate()],
  });
  const predicates = result.reconciliation.signals[0]!.edgePredicates.CONSOLIDATION_BREAKOUT_CONTINUATION;
  assert.ok(predicates.some((predicate) => predicate.result === "EVIDENCE_UNAVAILABLE"));
  assert.ok(predicates.every((predicate) =>
    predicate.sourceAuditId === "audit-orb" || predicate.sourceAuditId === null));
});

test("Phase 3 marks a fully evidenced ORB sequence PASS only when every predicate passes", () => {
  const result = reconcileSyntheticFixture({
    occurrence: confirmedSignal({ causalEvidence: orbEvidence() }),
    candidates: [candidate()],
  });
  const predicates = result.reconciliation.signals[0]!.edgePredicates.ORB_PULLBACK_CONTINUATION;
  assert.deepEqual(predicates.map((predicate) => predicate.predicateName), [
    "finalized_orb_or_ntz",
    "directional_break_completed",
    "qualifying_pullback",
    "permitted_level_within_tolerance",
    "valid_p_candle",
    "immediate_e_confirmation_buffer",
    "e_completed_before_cutoff",
  ]);
  assert.ok(predicates.every((predicate) => predicate.result === "PASS"));
  assert.ok(predicates.every((predicate) => predicate.sourceAuditId === "audit-orb"));
});

test("Phase 3 exposes the complete required predicate set for all four edges", () => {
  const result = reconcileSyntheticFixture({
    occurrence: confirmedSignal({ causalEvidence: orbEvidence() }),
    candidates: [candidate()],
  });
  const signals = result.reconciliation.signals[0]!;
  assert.deepEqual(PHASE3_EDGES.map((edge) => signals.edgePredicates[edge].length), [7, 5, 6, 4]);
  assert.ok(PHASE3_EDGES.every((edge) =>
    signals.edgePredicates[edge].every((predicate) =>
      predicate.predicateName.length > 0
      && predicate.reason.length > 0
      && (predicate.sourceAuditId === "audit-orb" || predicate.sourceAuditId === null)
      && (predicate.evidenceTimestamp !== null || predicate.sourceAuditId === null))));
});

test("Phase 3 reconciles a complete confirmed signal collection exactly once", () => {
  const result = reconcileSyntheticFixture({
    candidates: [candidate()],
    trades: [{
      id: "trade-1",
      candidateId: "candidate-1",
      signalOccurrenceId: "signal-1",
      outcome: "open",
      netPnl: 0,
      ambiguityLabel: null,
    } as unknown as BacktestTrade],
  });
  assert.equal(result.reconciliation.dispositionReconciles, true);
  assert.equal(result.reconciliation.confirmedSignalCount, 1);
  assert.equal(result.reconciliation.dispositionCounts.candidate_entered_open, 1);
  assert.deepEqual(result.reconciliation.invariantViolations, []);
});

test("Phase 3 reports four independent edges, preserves confluence, and excludes invalid management", async () => {
  const baseDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: baseDataset, request, createdAt: "2026-08-30T12:00:00.000Z" });
  const partitions = buildPhase3PilotPartitions(baseDataset);
  const valid = candidate();
  const invalid = candidate({
    candidateId: "candidate-invalid",
    signalOccurrenceId: "signal-invalid",
    pOpenTimestamp: "2026-07-01T15:05:00.000Z",
    eOpenTimestamp: "2026-07-01T15:10:00.000Z",
    entryObservationTimestamp: "2026-07-01T15:15:00.000Z",
    patienceTimestamp: "2026-07-01T15:05:00.000Z",
    expectedEntryTimestamp: "2026-07-01T15:10:00.000Z",
    managementContext: {
      ...candidate().managementContext!,
      candidateId: "candidate-invalid",
      signalOccurrenceId: "signal-invalid",
       managementEvidenceStatus: "invalid",
       missingEvidenceReasons: ["INVALID_MANAGEMENT_GEOMETRY", "LONG_STOP_TARGET_ORDER"],
    },
  });
  const saved: Phase3Checkpoint[] = [];
  const result = await runPhase3EdgePilot(
    { manifest, request, partitions },
    {
      timeoutMs: 1_000,
      allowSyntheticFixtures: true,
      now: () => 1_000,
      runPartition: async ({ replayDataset }) => {
        assert.ok(replayDataset);
        return report(
          replayDataset,
          replayDataset.selectedDates?.[0] === dates[0] ? [valid, invalid] : [],
        );
      },
      saveCheckpoint: async (checkpoint) => { saved.push(checkpoint); },
    },
  );
  assert.deepEqual(result.edgeResults.map((item) => item.edge), [...PHASE3_EDGES]);
  const orb = result.edgeResults.find((item) => item.edge === "ORB_PULLBACK_CONTINUATION")!;
  assert.equal(orb.all.candidateCount, 2);
  assert.equal(orb.all.invalidContextCount, 1);
  assert.equal(orb.all.realized.tradeCount, 0);
  assert.equal(orb.candidates[0]?.candidate.supportingConfluences[0], "volume");
  assert.equal(result.edgeResults.find((item) => item.edge === "PATIENCE_CANDLE_CONTINUATION")?.all.candidateCount, 0);
  assert.equal(result.timing.newlyComputedPartitions, 30);
  assert.equal(saved.length, 31);
});

test("Phase 3 resumes from the manifest checkpoint without replaying completed partitions", async () => {
  const baseDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: baseDataset, request });
  const partitions = buildPhase3PilotPartitions(baseDataset);
  let calls = 0;
  let checkpoint: Phase3Checkpoint | null = null;
  const first = await runPhase3EdgePilot(
    { manifest, request, partitions },
    {
      timeoutMs: 1_000,
      allowSyntheticFixtures: true,
      runPartition: async ({ replayDataset }) => {
        calls += 1;
        assert.ok(replayDataset);
        return report(replayDataset);
      },
      saveCheckpoint: async (value) => { checkpoint = value; },
    },
  );
  assert.equal(first.completedPartitions, 30);
  assert.equal(calls, 30);
  const second = await runPhase3EdgePilot(
    { manifest, request, partitions },
    {
      timeoutMs: 1_000,
      allowSyntheticFixtures: true,
      loadCheckpoint: async () => checkpoint,
      runPartition: async () => {
        throw new Error("resumed pilot replayed a completed partition");
      },
    },
  );
  assert.equal(second.timing.resumedPartitions, 30);
  assert.equal(second.timing.newlyComputedPartitions, 0);
  assert.equal(activeShadowStrategySnapshot().strategyKey, "MES_SHADOW");
});

test("Phase 3 rejects an invalid exact 20/10 manifest and future-access reports", async () => {
  assert.throws(
    () => buildPhase3PilotManifest({
      dataset: dataset({
        inSampleDates: dates.slice(0, 19),
        outOfSampleDates: dates.slice(19),
      }),
      request,
    }),
    /exactly 20 in-sample and 10 out-of-sample/,
  );
  const baseDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: baseDataset, request });
  const partitions = buildPhase3PilotPartitions(baseDataset);
  await assert.rejects(
    runPhase3EdgePilot(
      { manifest, request, partitions },
      {
        timeoutMs: 1_000,
        allowSyntheticFixtures: true,
        runPartition: async ({ replayDataset }) => {
          assert.ok(replayDataset);
          return {
            ...report(replayDataset),
            replay: { ...report(replayDataset).replay, futureCandleAccess: true },
          } as unknown as BacktestReport;
        },
      },
    ),
    /REPLAY_CAUSALITY_GATE_FAILED/,
  );
});

test("Phase 3 refuses a late entry before persisting that partition", async () => {
  const baseDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: baseDataset, request });
  const lateCandidate = candidate({
    pOpenTimestamp: "2026-07-01T16:55:00.000Z",
    eOpenTimestamp: "2026-07-01T16:55:00.000Z",
    entryObservationTimestamp: "2026-07-01T17:00:00.000Z",
    expectedEntryTimestamp: "2026-07-01T16:55:00.000Z",
    patienceTimestamp: "2026-07-01T16:50:00.000Z",
  });
  let checkpoints = 0;
  await assert.rejects(
    runPhase3EdgePilot(
      { manifest, request, partitions: buildPhase3PilotPartitions(baseDataset) },
      {
        timeoutMs: 1_000,
        allowSyntheticFixtures: true,
        runPartition: async ({ replayDataset }) => {
          assert.ok(replayDataset);
          return report(replayDataset, [lateCandidate]);
        },
        saveCheckpoint: async () => { checkpoints += 1; },
      },
    ),
    /refuses late entry evidence/,
  );
  assert.equal(checkpoints, 0);
});

test("Phase 3 time buckets use E close rather than E open", async () => {
  const baseDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: baseDataset, request });
  const bucketBoundaryCandidate = candidate({
    pOpenTimestamp: "2026-07-01T15:50:00.000Z",
    eOpenTimestamp: "2026-07-01T15:55:00.000Z",
    entryObservationTimestamp: "2026-07-01T16:00:00.000Z",
    patienceTimestamp: "2026-07-01T15:50:00.000Z",
    expectedEntryTimestamp: "2026-07-01T15:55:00.000Z",
  });
  const result = await runPhase3EdgePilot(
    { manifest, request, partitions: buildPhase3PilotPartitions(baseDataset) },
    {
      timeoutMs: 1_000,
      allowSyntheticFixtures: true,
      runPartition: async ({ replayDataset }) => report(
        replayDataset!,
        replayDataset!.selectedDates?.[0] === dates[0] ? [bucketBoundaryCandidate] : [],
      ),
    },
  );
  assert.equal(result.overall.all.entryTimeBuckets["12:00-13:00"], 1);
  assert.equal(result.overall.all.entryTimeBuckets["11:00-12:00"], 0);
});

test("Phase 3 deduplicates a physical candidate and trade across partition reports", async () => {
  const baseDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: baseDataset, request });
  const physicalCandidate = candidate();
  const firstTrade = {
    id: "trade-1",
    candidateId: physicalCandidate.candidateId,
    signalOccurrenceId: physicalCandidate.signalOccurrenceId,
    outcome: "open",
  } as unknown as BacktestTrade;
  const saved: Phase3Checkpoint[] = [];
  const result = await runPhase3EdgePilot(
    { manifest, request, partitions: buildPhase3PilotPartitions(baseDataset) },
    {
      timeoutMs: 1_000,
      allowSyntheticFixtures: true,
      runPartition: async ({ replayDataset }) => {
        assert.ok(replayDataset);
        const duplicate = replayDataset.selectedDates?.[0] === dates[0]
          || replayDataset.selectedDates?.[0] === dates[1];
        return {
          ...report(replayDataset, duplicate ? [physicalCandidate] : []),
          trades: duplicate ? [firstTrade, firstTrade] : [],
        } as unknown as BacktestReport;
      },
      saveCheckpoint: async (checkpoint) => { saved.push(checkpoint); },
    },
  );
  assert.equal(result.diagnostics.candidateCount, 1);
  assert.equal(result.diagnostics.duplicateCandidateCount, 1);
  assert.equal(result.diagnostics.duplicateTradeCount, 1);
  assert.equal(result.overall.all.openCount, 1);
  assert.equal(saved.length, 31);
});

test("Phase 3 counts ambiguous exit evidence separately from unscored results", async () => {
  const baseDataset = dataset();
  const manifest = buildPhase3PilotManifest({ dataset: baseDataset, request });
  const ambiguousCandidate = candidate();
  const ambiguousTrade = {
    id: "ambiguous-trade",
    candidateId: ambiguousCandidate.candidateId,
    signalOccurrenceId: ambiguousCandidate.signalOccurrenceId,
    outcome: "stop",
    ambiguityLabel: "AMBIGUOUS_STOP_FIRST",
    audit: { ambiguityLabels: ["AMBIGUOUS_STOP_FIRST"] },
  } as unknown as BacktestTrade;
  const result = await runPhase3EdgePilot(
    { manifest, request, partitions: buildPhase3PilotPartitions(baseDataset) },
    {
      timeoutMs: 1_000,
      allowSyntheticFixtures: true,
      runPartition: async ({ replayDataset }) => {
        assert.ok(replayDataset);
        const firstDate = replayDataset.selectedDates?.[0] === dates[0];
        return {
          ...report(replayDataset, firstDate ? [ambiguousCandidate] : []),
          trades: firstDate ? [ambiguousTrade] : [],
        } as unknown as BacktestReport;
      },
    },
  );
  const orb = result.edgeResults.find((item) => item.edge === "ORB_PULLBACK_CONTINUATION")!;
  assert.equal(orb.all.ambiguousCount, 1);
  assert.equal(orb.all.unscoredCount, 0);
  assert.equal(orb.all.realized.tradeCount, 0);
});