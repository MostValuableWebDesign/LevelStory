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
    confirmationBufferTicks: 4,
    grade: "A+",
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
      signalOccurrenceId: "signal-1",
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
    audit: [],
  } as unknown as BacktestReport;
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
    confirmationBufferTicks: 4,
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
  });
  assert.equal(result.reconciliation.confirmedSignalCount, 1);
  assert.equal(result.reconciliation.dispositionReconciles, true);
  assert.equal(Object.values(result.reconciliation.dispositionCounts).reduce((sum, count) => sum + count, 0), 1);
  assert.equal(result.reconciliation.timeBuckets["09:30-10:00"].confirmed, 0);
  assert.equal(result.reconciliation.signals[0]!.signalOccurrenceId, "signal-1");
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