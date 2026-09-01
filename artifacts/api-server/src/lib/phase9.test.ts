import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCausalVisibility,
  calculateBacktestMetrics,
  createCausalReplay,
  buildReplayIndexes,
  historicalReplayDiagnostics,
  resolveEntryAndInvalidation,
  resolveIntrabarOutcome,
  buildHistoricalOccurrenceLedger,
  projectHistoricalTradeCandidates,
  reduceHistoricalPullbackLifecycles,
  type IntrabarBar,
  type BacktestTrade,
  type BacktestAuditRecord,
  type CausalReplayDataset,
  type HistoricalOccurrence,
} from "./phase9.js";
import type { SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { DEFAULT_FUTURES_SESSION_CALENDAR, newYorkTimeToUtc } from "./futures/session-calendar.js";
import { consolidationThresholds, DEFAULT_STRATEGY_CONFIG } from "./strategy/config.js";
import { getFuturesContractSpecification } from "./futures/contracts.js";
import { RunBacktestBody } from "@workspace/api-zod";
import { reducePullbackArmLifecycles } from "./strategy/phase4.js";

function candle(index: number, overrides: Partial<SimulatedFuturesCandle> = {}): SimulatedFuturesCandle {
  const openTime = index * 300_000;
  return {
    timestamp: openTime,
    openTime,
    closeTime: openTime + 300_000,
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 1_000,
    bid: 101.75,
    ask: 102,
    bidSize: 10,
    askSize: 10,
    contractSymbol: "MESU26",
    isComplete: true,
    ...overrides,
  };
}

function trade(netPnl: number, overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    id: `trade-${netPnl}`,
    tradingDate: "2026-08-25",
    contractSymbol: "MESU26",
    contractMonth: "2026-09",
    period: "in_sample",
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long",
    entryTime: new Date(0).toISOString(),
    exitTime: new Date(1).toISOString(),
    entryPrice: 100,
    exitPrice: 100,
    contracts: 1,
    grossPnl: netPnl,
    fees: 0,
    slippage: 0,
    netPnl,
    outcome: netPnl > 0 ? "target" : "strategy stop",
    ambiguityLabel: null,
    source: "tick",
    segmentation: {
      contract: "MESU26",
      contractMonth: "2026-09",
      setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
      direction: "long",
      timeOfDay: "open",
      trend: "bullish",
      fibonacciDepth: "normal",
      volumeCondition: "supported",
      levelType: "ORB",
      confluence: "normal",
      patienceCharacteristic: "ENTRY_TRIGGERED",
      orbState: "ENTRY_TRIGGERED",
      marketRegime: "trend",
    },
    ...overrides,
  };
}

test("API contracts accept only the governed eight-tick entry buffer", () => {
  const defaults = RunBacktestBody.safeParse({});
  assert.equal(defaults.success, true);
  if (defaults.success) assert.equal(defaults.data.ohlcvEntryBufferTicks, 8);
  assert.equal(RunBacktestBody.safeParse({ ohlcvEntryBufferTicks: 8 }).success, true);
  assert.equal(RunBacktestBody.safeParse({ ohlcvEntryBufferTicks: 7 }).success, false);
});

function replayCandle(openTime: number, contractSymbol: string, base: number): SimulatedFuturesCandle {
  return {
    timestamp: openTime,
    openTime,
    closeTime: openTime + 5 * 60_000,
    open: base,
    high: base + 5,
    low: base - 5,
    close: base + 1,
    volume: 1_000,
    bid: base,
    ask: base + 0.25,
    bidSize: 10,
    askSize: 10,
    contractSymbol,
    isComplete: true,
  };
}

function constituentMinutes(start: number, base: number): IntrabarBar[] {
  return Array.from({ length: 5 }, (_, index) => ({
    openTime: start + index * 60_000,
    closeTime: start + (index + 1) * 60_000,
    open: base,
    high: base + 1,
    low: base - 1,
    close: base + 0.25,
    source: "one-minute" as const,
    sequenceKnown: false,
  }));
}

function confirmedCandidateOccurrence(input: {
  pOpen: string;
  eOpen: string;
  eClose: string;
  direction?: "long" | "short";
  entryHigh?: number;
  entryLow?: number;
  patienceLow?: number;
  patienceHigh?: number;
  levelValues?: Record<string, number>;
  management?: Record<string, unknown>;
  eligibilityArmId?: string;
  eligibilityArmState?: "active" | "consumed" | "invalidated" | "superseded";
}): any {
  const direction = input.direction ?? "long";
  return {
    occurrenceId: `confirmed-${input.eOpen}-${direction}`,
    auditId: "confirmed-audit",
    kind: "patience",
    strategyCandidate: "ORB_PULLBACK_CONTINUATION",
    secondaryStrategyMatches: [],
    tradingDate: input.pOpen.slice(0, 10),
    contractSymbol: "MESU26",
    contractMonth: "U26",
    direction,
    lTimestamp: input.pOpen,
    lEventId: "confirmed-l",
    lInteractionType: "touch",
    lCandle: null,
    previousComparisonTimestamp: input.pOpen,
    patienceTimestamp: input.pOpen,
    patienceCandle: {
      openTime: Date.parse(input.pOpen),
      closeTime: Date.parse(input.eOpen),
      open: 100,
      high: input.patienceHigh ?? 101,
      low: input.patienceLow ?? 99,
      close: 100.5,
      volume: 1_000,
      isComplete: true,
    },
    candidateShapeResult: true,
    expectedEntryTimestamp: input.eOpen,
    confirmationThreshold: direction === "long" ? 101.25 : 98.75,
    confirmationExcursion: 0.25,
    entryTimestamp: input.eOpen,
    entryCandle: {
      openTime: Date.parse(input.eOpen),
      closeTime: Date.parse(input.eClose),
      open: 100,
      high: input.entryHigh ?? (direction === "long" ? 102 : 101),
      low: input.entryLow ?? (direction === "short" ? 98 : 99),
      close: 100.5,
      volume: 1_000,
      isComplete: true,
    },
    levelIdentifiers: ["ORB"],
    levelValues: input.levelValues ?? { ORB: 100 },
    levelDistancesTicks: {},
    levelTolerancePoints: {},
    levelToleranceTicks: {},
    levelInteractionTypes: { ORB: ["touch"] },
    pOpenTimestamp: input.pOpen,
    eOpenTimestamp: input.eOpen,
    entryObservationTimestamp: input.eClose,
    confirmationBufferTicks: 1,
    nextObservedCandle: null,
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
    status: "SIGNAL_CONFIRMED",
    signalStatus: "SIGNAL_CONFIRMED",
    reasonCode: "Immediate E confirmed.",
    evaluationCursor: input.eClose,
    formulaVersion: "phase9-fixed-formula-v2",
    formulaHash: "f".repeat(64),
    sourceFingerprint: "a".repeat(64),
    canonicalTrade: false,
    canonicalOccurrence: true,
    primaryEdge: "ORB_PULLBACK_CONTINUATION",
    matchedEdges: ["ORB_PULLBACK_CONTINUATION"],
    supportingConfluences: [],
    setupGrade: "A",
    ...(input.management ? { management: input.management } : {}),
    ...(input.eligibilityArmId ? { eligibilityArmId: input.eligibilityArmId } : {}),
    ...(input.eligibilityArmState ? { eligibilityArmState: input.eligibilityArmState } : {}),
  };
}

function candidateProjectionDataset(
  occurrence: any,
  postEntryOverrides: Partial<SimulatedFuturesCandle> = {},
): CausalReplayDataset {
  const entry = occurrence.entryCandle;
  return {
    source: "historical_databento_multicontract",
    contractSymbol: occurrence.contractSymbol,
    candles: [
      {
        ...candle(Date.parse(occurrence.pOpenTimestamp) / 300_000, {
          openTime: Date.parse(occurrence.pOpenTimestamp),
          closeTime: Date.parse(occurrence.eOpenTimestamp),
          contractSymbol: occurrence.contractSymbol,
        }),
      },
      {
        ...candle(Date.parse(occurrence.eOpenTimestamp) / 300_000, {
          ...entry,
          timestamp: entry.openTime,
          contractSymbol: occurrence.contractSymbol,
        }),
      },
      candle(Date.parse(occurrence.entryObservationTimestamp) / 300_000, {
        openTime: Date.parse(occurrence.entryObservationTimestamp),
        closeTime: Date.parse(occurrence.entryObservationTimestamp) + 300_000,
        contractSymbol: occurrence.contractSymbol,
        ...postEntryOverrides,
      }),
    ],
    inSampleDates: [occurrence.tradingDate],
    outOfSampleDates: [],
    contractMonth: "U26",
  } as CausalReplayDataset;
}

function lifecycleForArm(
  armId: string,
  terminalState: "STRUCTURALLY_INVALIDATED" | "SUPERSEDED_BY_NEW_BREAKOUT" | "OPPOSITE_BREAKOUT_INVALIDATED" | "DATA_GAP_INVALIDATED" | "ENTRY_CUTOFF_EXPIRED" | "SESSION_BOUNDARY_EXPIRED" | "CONTRACT_BOUNDARY_EXPIRED" | "CONSUMED",
  consumingOccurrence?: any,
): ReturnType<typeof reducePullbackArmLifecycles> {
  const consumingSignalIdentity = consumingOccurrence?.direction
    && consumingOccurrence.pOpenTimestamp
    && consumingOccurrence.eOpenTimestamp
    ? {
      sourceFingerprint: consumingOccurrence.sourceFingerprint,
      formulaHash: consumingOccurrence.formulaHash,
      contractSymbol: consumingOccurrence.contractSymbol,
      tradingDate: consumingOccurrence.tradingDate,
      direction: consumingOccurrence.direction,
      pOpenTimestamp: consumingOccurrence.pOpenTimestamp,
      eOpenTimestamp: consumingOccurrence.eOpenTimestamp,
    }
    : undefined;
  return reducePullbackArmLifecycles([{
    armId,
    transitions: [
      { from: null, to: "ARMED_AFTER_BREAKOUT", time: 0, reason: "breakout" },
      { from: "ARMED_AFTER_BREAKOUT", to: "PULLBACK_OBSERVED", time: 1, reason: "pullback" },
      { from: "PULLBACK_OBSERVED", to: "LEVEL_INTERACTION_FOUND", time: 2, reason: "level" },
      { from: "LEVEL_INTERACTION_FOUND", to: "PATIENCE_ARMED", time: 3, reason: "patience" },
      {
        from: "PATIENCE_ARMED",
        to: terminalState,
        time: 4,
        reason: terminalState,
        ...(consumingSignalIdentity ? {
          consumingSignalIdentity,
          consumingSignalOccurrenceId: consumingOccurrence.occurrenceId,
        } : {}),
      },
    ],
    source: "test-lifecycle",
  }]);
}

test("causal replay only exposes the visible prefix and cannot leak a future candle", () => {
  const replay = createCausalReplay({ candles: [candle(0), candle(1), candle(2)] }, candle(1).closeTime);
  assert.deepEqual(replay.candles.map((item) => item.openTime), [0, 300_000]);
  assert.equal(replay.visibleCandleCount, 2);
  assert.doesNotThrow(() => assertCausalVisibility(replay.candles, candle(1).closeTime));
  assert.throws(() => assertCausalVisibility([...replay.candles, candle(2)], candle(1).closeTime), /future candle/);
});

test("mutating a future source candle cannot change an earlier replay prefix", () => {
  const source = [candle(0), candle(1), candle(2)];
  const before = createCausalReplay({ candles: source }, candle(1).closeTime);
  source[2].close = 9_999;
  const after = createCausalReplay({ candles: source }, candle(1).closeTime);
  assert.deepEqual(after.candles, before.candles);
});

test("tick data takes precedence over one-minute fallback", () => {
  const next = candle(1);
  const bars: IntrabarBar[] = [{
    openTime: next.openTime,
    closeTime: next.closeTime,
    open: 100,
    high: 110,
    low: 99,
    close: 109,
    source: "one-minute",
    sequenceKnown: false,
  }];
  const result = resolveIntrabarOutcome({
    direction: "long",
    target: 108,
    stop: 98,
    candle: next,
    ticks: [{ timestamp: next.openTime + 1, price: 101, source: "tick" }, { timestamp: next.openTime + 2, price: 108, source: "tick" }],
    oneMinute: bars,
  });
  assert.equal(result.source, "tick");
  assert.equal(result.status, "target");
});

test("multi-contract indexing preserves every constituent minute inside its five-minute candle", () => {
  const firstOpen = newYorkTimeToUtc("2026-06-10", "09:30");
  const secondOpen = newYorkTimeToUtc("2026-06-11", "09:30");
  const first = replayCandle(firstOpen, "MESM6", 100);
  const second = replayCandle(secondOpen, "MESU6", 200);
  const indexes = buildReplayIndexes(
    [first, second],
    [],
    [...constituentMinutes(firstOpen, 100), ...constituentMinutes(secondOpen, 200)],
    DEFAULT_FUTURES_SESSION_CALENDAR,
  );

  const firstBars = indexes.oneMinuteByContractCandle.get(`MESM6:${firstOpen}`);
  const secondBars = indexes.oneMinuteByContractCandle.get(`MESU6:${secondOpen}`);
  const legacyExactOpenMatches = constituentMinutes(firstOpen, 100)
    .filter((bar) => bar.openTime === firstOpen);
  assert.equal(legacyExactOpenMatches.length, 1);
  assert.equal(firstBars?.length, 5);
  assert.equal(secondBars?.length, 5);
  assert.deepEqual(firstBars?.map((bar) => bar.openTime), constituentMinutes(firstOpen, 100).map((bar) => bar.openTime));
  assert.deepEqual(secondBars?.map((bar) => bar.openTime), constituentMinutes(secondOpen, 200).map((bar) => bar.openTime));
});

test("minutes two through five can resolve target, stop, and chronological collision outcomes", () => {
  const openTime = newYorkTimeToUtc("2026-06-10", "09:30");
  const fiveMinute = replayCandle(openTime, "MESM6", 100);
  const bars = constituentMinutes(openTime, 100);
  bars[3] = { ...bars[3], high: 110 };
  bars[4] = { ...bars[4], low: 90 };
  const indexes = buildReplayIndexes([fiveMinute, { ...fiveMinute, openTime: openTime + 300_000, closeTime: openTime + 600_000 }], [], bars, DEFAULT_FUTURES_SESSION_CALENDAR);
  const indexedBars = indexes.oneMinuteByContractCandle.get(`MESM6:${openTime}`) ?? [];

  const target = resolveIntrabarOutcome({
    direction: "long",
    target: 109,
    stop: 94,
    candle: fiveMinute,
    oneMinute: indexedBars,
  });
  assert.equal(target.status, "target");
  assert.equal(target.timestamp, openTime + 4 * 60_000);

  const stop = resolveIntrabarOutcome({
    direction: "long",
    target: 111,
    stop: 91,
    candle: fiveMinute,
    oneMinute: indexedBars,
  });
  assert.equal(stop.status, "stop");
  assert.equal(stop.timestamp, openTime + 5 * 60_000);

  const collisionBars = indexedBars.map((bar, index) => index === 1 ? { ...bar, high: 109, low: 91 } : bar);
  const collision = resolveIntrabarOutcome({
    direction: "long",
    target: 109,
    stop: 91,
    candle: fiveMinute,
    oneMinute: collisionBars,
  });
  assert.equal(collision.status, "ambiguous");
  assert.equal(collision.ambiguityLabel, "AMBIGUOUS_STOP_FIRST");
});

test("one-minute fallback resolves a target and labels same-minute collisions stop-first", () => {
  const next = candle(1);
  const target = resolveIntrabarOutcome({
    direction: "long",
    target: 104,
    stop: 94,
    candle: next,
    oneMinute: [{
      openTime: next.openTime,
      closeTime: next.openTime + 60_000,
      open: 100,
      high: 103,
      low: 99,
      close: 102,
      source: "one-minute",
      sequenceKnown: false,
    }, {
      openTime: next.openTime + 60_000,
      closeTime: next.openTime + 120_000,
      open: 102,
      high: 104,
      low: 101,
      close: 104,
      source: "one-minute",
      sequenceKnown: false,
    }],
  });
  assert.equal(target.status, "target");
  assert.equal(target.source, "one-minute");

  const ambiguous = resolveIntrabarOutcome({
    direction: "long",
    target: 104,
    stop: 96,
    candle: next,
    oneMinute: [{
      openTime: next.openTime,
      closeTime: next.openTime + 60_000,
      open: 100,
      high: 105,
      low: 95,
      close: 101,
      source: "one-minute",
      sequenceKnown: false,
    }],
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.ambiguityLabel, "AMBIGUOUS_STOP_FIRST");
});

test("a stop-only OHLC candle is an execution event, not an ambiguity", () => {
  const result = resolveIntrabarOutcome({
    direction: "long",
    target: 110,
    stop: 96,
    candle: candle(1),
  });
  assert.equal(result.status, "stop");
  assert.equal(result.ambiguityLabel, null);
});

test("entry and invalidation in an unresolved candle reject the setup", () => {
  const result = resolveEntryAndInvalidation({
    direction: "long",
    candle: { open: 100, high: 105, low: 95, close: 101 },
    entry: 102,
    invalidation: 96,
    sequenceKnown: false,
  });
  assert.deepEqual(result, {
    status: "ambiguous",
    price: null,
    label: "AMBIGUOUS_ENTRY_INVALIDATION",
    detail: "Entry and invalidation occurred in the same unresolved candle; the setup was rejected instead of inventing an order.",
  });
});

test("backtest metrics include costs and equity drawdown", () => {
  const metrics = calculateBacktestMetrics([
    trade(100, { grossPnl: 120, fees: 10, slippage: 10 }),
    trade(-60, { grossPnl: -40, fees: 10, slippage: 10 }),
    trade(40, { grossPnl: 60, fees: 10, slippage: 10 }),
  ], 4);
  assert.equal(metrics.tradeCount, 3);
  assert.equal(metrics.winRate, 66.7);
  assert.equal(metrics.grossPnl, 140);
  assert.equal(metrics.fees, 30);
  assert.equal(metrics.slippage, 30);
  assert.equal(metrics.netPnl, 80);
  assert.equal(metrics.maximumDrawdown, 60);
  assert.equal(metrics.rejectedSetupCount, 4);
});

test("ambiguity metrics separate rejected entries from ambiguous exits", () => {
  const ambiguous = trade(40, {
    audit: {
      ambiguityLabels: ["AMBIGUOUS_RUNNER_SEQUENCE"],
      patienceCandleOpenTime: null,
    } as NonNullable<BacktestTrade["audit"]>,
  });
  const metrics = calculateBacktestMetrics(
    [ambiguous],
    1,
    [{
      rejectionReason: "AMBIGUOUS_ENTRY_INVALIDATION",
    } as BacktestAuditRecord],
  );
  assert.equal(metrics.ambiguousEntryCount, 1);
  assert.equal(metrics.ambiguousExitCount, 1);
  assert.equal(metrics.ambiguousTradeCount, 1);
  assert.equal(metrics.ambiguityCount, 2);
});

function occurrenceAudit(
  setupType: string,
  overrides: Partial<BacktestAuditRecord> = {},
): BacktestAuditRecord {
  const lOpen = 300_000;
  const pOpen = 600_000;
  const eOpen = 900_000;
  const lCandle = { openTime: lOpen, closeTime: lOpen + 300_000, open: 100, high: 103, low: 99, close: 101, volume: 10, isComplete: true };
  const pCandle = { openTime: pOpen, closeTime: pOpen + 300_000, open: 101, high: 102, low: 98, close: 100, volume: 11, isComplete: true };
  const eCandle = { openTime: eOpen, closeTime: eOpen + 300_000, open: 100, high: 105, low: 100, close: 104, volume: 12, isComplete: true };
  return {
    id: `${setupType}-audit`,
    tradingDate: "2026-08-25",
    contractSymbol: "MESU26",
    contractMonth: "2026-09",
    period: "in_sample",
    evaluatedCandleOpenTime: new Date(eOpen).toISOString(),
    setupType,
    direction: "long",
    decision: "SETUP QUALIFIED",
    alertOnly: true,
    rejectionReason: null,
    rejectionCategory: "QUALIFIED",
    rejectionSummary: null,
    ruleEvidence: [],
    orbState: "ENTRY_TRIGGERED",
    breakoutEvidence: "",
    volumeEvidence: "",
    pullbackEvidence: "",
    criticalLevelEvidence: "",
    trendEvidence: "",
    patienceState: "ENTRY_TRIGGERED",
    patienceCandle: pCandle,
    triggerCandle: eCandle,
    patienceCandleOpenTime: new Date(pOpen).toISOString(),
    patienceCandleCloseTime: new Date(pOpen + 300_000).toISOString(),
    triggerCandleOpenTime: new Date(eOpen).toISOString(),
    triggerCandleCloseTime: new Date(eOpen + 300_000).toISOString(),
    modeledFillObservationTime: null,
    exitCandleOpenTime: null,
    exitCandleCloseTime: null,
    entryTriggerPrice: 104,
    strategyStopPrice: 97.75,
    catastropheStopPrice: 95,
    targetPrice: 110,
    eventLabels: [],
    ambiguityLabels: [],
    executionMode: "ohlcv_modeled",
    fees: 0,
    slippage: 0,
    grossPnl: null,
    netPnl: null,
    exitReason: null,
    confirmationBufferTicks: 8,
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
    pullbackOccurrences: [{
      type: "touch",
      time: new Date(lOpen).toISOString(),
      level: "ORB",
      price: 101,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      candle: lCandle,
      detail: "ORB retest touched the causal level.",
    }],
    patienceOccurrences: [{
      occurrenceId: "p1",
      direction: "long",
      entryBufferTicks: 8,
      stopBufferTicks: 1,
      eligibilityReason: "pullback",
      eligibilityTime: lOpen,
      previousComparisonTimestamp: lCandle.openTime,
      candidateShapeResult: true,
      expectedEntryCandleOpenTime: eCandle.openTime,
      confirmationThreshold: 104,
      actualConfirmationExcursion: 3,
      previousCandle: lCandle,
      patienceCandle: pCandle,
      triggerCandle: eCandle,
      nextObservedCandle: null,
      outcomeStatus: "CONFIRMED",
      status: "ENTRY_TRIGGERED",
      reasonCode: "immediate E reached the confirmation buffer",
      evaluationCursor: eCandle.closeTime,
    }],
    ...overrides,
  };
}

function occurrenceDataset(): CausalReplayDataset {
  return {
    source: "historical_databento",
    contractSymbol: "MESU26",
    contractMonth: "2026-09",
    selectedDates: ["2026-08-25"],
    inSampleDates: ["2026-08-25"],
    outOfSampleDates: [],
    candles: [],
  } as unknown as CausalReplayDataset;
}

test("historical occurrence ledger is repeatable and retains causal L/P/E evidence", () => {
  const report = buildHistoricalOccurrenceLedger(occurrenceDataset(), [occurrenceAudit("ORB_PULLBACK_CONTINUATION")], []);
  const repeat = buildHistoricalOccurrenceLedger(occurrenceDataset(), [occurrenceAudit("ORB_PULLBACK_CONTINUATION")], []);
  assert.deepEqual(report, repeat);
  const patience = report.find((occurrence) => occurrence.kind === "patience");
  assert.ok(patience);
   assert.equal(patience.confirmationBufferTicks, 8);
  assert.equal(patience.lCandle?.openTime, 300_000);
  assert.equal(patience.patienceCandle?.openTime, 600_000);
  assert.equal(patience.entryCandle?.openTime, 900_000);
  assert.equal(patience.evaluationCursor, new Date(1_200_000).toISOString());
});

test("historical occurrences preserve exact L identity, all same-candle levels, and content fingerprints", () => {
  const previousCandle = { openTime: 0, closeTime: 300_000, open: 99, high: 101, low: 98, close: 100, volume: 9, isComplete: true };
  const patienceCandle = { openTime: 600_000, closeTime: 900_000, open: 101, high: 102, low: 98, close: 100, volume: 11, isComplete: true };
  const triggerCandle = { openTime: 900_000, closeTime: 1_200_000, open: 100, high: 105, low: 100, close: 104, volume: 12, isComplete: true };
  const audit = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    pullbackOccurrences: [
      {
        eventId: "l-orb",
        type: "touch",
        time: new Date(300_000).toISOString(),
        level: "ORB",
        price: 101,
        distancePoints: 0,
        distanceTicks: 0,
        tolerancePoints: 3,
        toleranceTicks: 12,
        qualifies: true,
        candle: {
          openTime: 300_000, closeTime: 600_000, open: 100, high: 103, low: 99, close: 101, volume: 10,
        },
        detail: "ORB retest.",
      },
      {
        eventId: "l-vwap",
        type: "proximity",
        time: new Date(300_000).toISOString(),
        level: "VWAP",
        price: 100.75,
        distancePoints: 1,
        distanceTicks: 4,
        tolerancePoints: 3,
        toleranceTicks: 12,
        qualifies: true,
        candle: {
          openTime: 300_000, closeTime: 600_000, open: 100, high: 103, low: 99, close: 101, volume: 10,
        },
        detail: "VWAP proximity.",
      },
    ],
    patienceOccurrences: [{
      occurrenceId: "p1",
      direction: "long",
      entryBufferTicks: 8,
      stopBufferTicks: 1,
      eligibilityReason: "pullback",
      eligibilityTime: 300_000,
      eligibilityEventId: "l-orb",
      previousCandle,
      patienceCandle,
      triggerCandle,
      status: "ENTRY_TRIGGERED",
      reasonCode: "entry confirmed",
      evaluationCursor: 1_200_000,
    }],
  });
  const dataset = { ...occurrenceDataset(), candles: [candle(1)] };
  const occurrence = buildHistoricalOccurrenceLedger(dataset, [audit], []).find((item) => item.kind === "patience");
  assert.ok(occurrence);
  assert.equal(occurrence.lEventId, "l-orb");
  assert.equal(occurrence.pOpenTimestamp, new Date(patienceCandle.openTime).toISOString());
  assert.equal(occurrence.eOpenTimestamp, new Date(triggerCandle.openTime).toISOString());
  assert.equal(occurrence.entryObservationTimestamp, new Date(triggerCandle.closeTime).toISOString());
  assert.deepEqual(occurrence.identityInvariantViolations, ["P_E_TRADING_DATE_MISMATCH"]);
  assert.notEqual(occurrence.pOpenTimestamp, occurrence.lTimestamp);
  assert.deepEqual(occurrence.levelIdentifiers, ["ORB", "VWAP"]);
  assert.deepEqual(occurrence.levelInteractionTypes, { ORB: ["touch"], VWAP: ["proximity"] });
  assert.equal(occurrence.formulaHash.length, 64);
  const changed = buildHistoricalOccurrenceLedger(
    { ...dataset, candles: [candle(1, { high: 106 })] },
    [audit],
    [],
  ).find((item) => item.kind === "patience");
  assert.ok(changed);
  assert.notEqual(changed.sourceFingerprint, occurrence.sourceFingerprint);
});

test("ledger merges the same causal occurrence and preserves canonical plus secondary strategies", () => {
  const primary = occurrenceAudit("ORB_PULLBACK_CONTINUATION");
  const secondary = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION", { id: "patience-audit" });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [secondary, primary], []);
  const patience = occurrences.find((occurrence) => occurrence.kind === "patience");
  assert.ok(patience);
  assert.equal(patience.strategyCandidate, "ORB_PULLBACK_CONTINUATION");
  assert.deepEqual(patience.secondaryStrategyMatches, ["PATIENCE_CANDLE_CONTINUATION"]);
  assert.equal(new Set(occurrences.map((occurrence) => occurrence.occurrenceId)).size, occurrences.length);
});

test("ledger promotes the complete immediate-E snapshot over an earlier partial replay cursor", () => {
  const source = occurrenceAudit("ORB_PULLBACK_CONTINUATION");
  const base = source.patienceOccurrences![0]!;
  const partial = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "partial-e-audit",
    patienceOccurrences: [{
      ...base,
      triggerCandle: null,
      nextObservedCandle: null,
      outcomeStatus: "CANDIDATE",
      qualificationStatus: "IMMEDIATE_CONFIRMATION_FAILED",
      status: "PATIENCE_CANDLE_EXPIRED",
      evaluationCursor: base.patienceCandle.closeTime,
    }],
  });
  const complete = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "complete-e-audit",
    patienceOccurrences: [{
      ...base,
      outcomeStatus: "CONFIRMED",
      qualificationStatus: "SIGNAL_CONFIRMED",
      status: "ENTRY_TRIGGERED",
      evaluationCursor: base.triggerCandle!.closeTime,
    }],
  });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [partial, complete], []);
  const patience = occurrences.find((occurrence) => occurrence.kind === "patience");
  assert.ok(patience);
  assert.equal(patience.status, "SIGNAL_CONFIRMED");
  assert.equal(patience.entryObservationTimestamp, new Date(base.triggerCandle!.closeTime).toISOString());
  assert.equal(patience.entryCandle?.openTime, base.triggerCandle!.openTime);
  assert.deepEqual(
    buildHistoricalOccurrenceLedger(occurrenceDataset(), [complete, partial], []).find((occurrence) => occurrence.kind === "patience"),
    patience,
  );
});

test("ledger merges multiple qualifying levels into one physical P to E signal", () => {
  const first = occurrenceAudit("ORB_PULLBACK_CONTINUATION");
  const second = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION", {
    id: "second-level-audit",
    pullbackOccurrences: [
      {
        ...first.pullbackOccurrences![0]!,
        eventId: "vwap-interaction",
        level: "VWAP",
        type: "proximity",
        price: 100.75,
      },
    ],
  });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [first, second], []);
  const patience = occurrences.filter((occurrence) => occurrence.kind === "patience");
  assert.equal(patience.length, 1);
  assert.deepEqual(patience[0]?.levelIdentifiers, ["ORB", "VWAP"]);
  assert.deepEqual(patience[0]?.auditIds, ["ORB_PULLBACK_CONTINUATION-audit", "second-level-audit"]);
  assert.deepEqual(patience[0]?.matchedEdges, ["ORB_PULLBACK_CONTINUATION", "PATIENCE_CANDLE_CONTINUATION"]);
});

test("ledger keeps two P candles linked to the same L as separate physical occurrences", () => {
  const first = occurrenceAudit("ORB_PULLBACK_CONTINUATION");
  const basePatience = first.patienceOccurrences![0]!;
  const second = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "second-p-candle-audit",
    evaluatedCandleOpenTime: new Date(1_500_000).toISOString(),
    patienceCandle: { ...first.patienceCandle!, openTime: 1_200_000, closeTime: 1_500_000 },
    triggerCandle: { ...first.triggerCandle!, openTime: 1_500_000, closeTime: 1_800_000 },
    patienceCandleOpenTime: new Date(1_200_000).toISOString(),
    patienceCandleCloseTime: new Date(1_500_000).toISOString(),
    triggerCandleOpenTime: new Date(1_500_000).toISOString(),
    triggerCandleCloseTime: new Date(1_800_000).toISOString(),
    patienceOccurrences: [{
      ...basePatience,
      occurrenceId: "p2",
      previousCandle: { ...basePatience.previousCandle },
      patienceCandle: { ...basePatience.patienceCandle, openTime: 1_200_000, closeTime: 1_500_000 },
      triggerCandle: { ...basePatience.triggerCandle!, openTime: 1_500_000, closeTime: 1_800_000 },
      expectedEntryCandleOpenTime: 1_500_000,
      evaluationCursor: 1_800_000,
    }],
  });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [first, second], []);
  const patience = occurrences.filter((occurrence) => occurrence.kind === "patience");
  assert.equal(patience.length, 2);
  assert.deepEqual(patience.map((occurrence) => occurrence.pOpenTimestamp).sort(), [
    new Date(600_000).toISOString(),
    new Date(1_200_000).toISOString(),
  ]);
  assert.ok(patience.every((occurrence) => occurrence.lTimestamp === new Date(300_000).toISOString()));
});

test("ledger diagnoses a confirmed sequence whose trigger is not the immediate E candle", () => {
  const source = occurrenceAudit("ORB_PULLBACK_CONTINUATION");
  const basePatience = source.patienceOccurrences![0]!;
  const audit = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    patienceOccurrences: [{
      ...basePatience,
      triggerCandle: { ...basePatience.triggerCandle!, openTime: 1_200_000, closeTime: 1_500_000 },
      expectedEntryCandleOpenTime: 900_000,
    }],
  });
  const occurrence = buildHistoricalOccurrenceLedger(occurrenceDataset(), [audit], [])
    .find((item) => item.kind === "patience");
  assert.ok(occurrence);
  assert.equal(occurrence.status, "SIGNAL_CONFIRMED");
  assert.ok(occurrence.identityInvariantViolations.includes("CONFIRMATION_NOT_ON_IMMEDIATE_E"));
  assert.ok(occurrence.identityInvariantViolations.includes("E_CLOSE_OBSERVATION_MISMATCH"));
});

test("authoritative candidate identity preserves one candidate across merged signal provenance", () => {
  const first = occurrenceAudit("ORB_PULLBACK_CONTINUATION");
  const second = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION", {
    id: "candidate-secondary-audit",
    pullbackOccurrences: [{
      ...first.pullbackOccurrences![0]!,
      eventId: "candidate-vwap",
      level: "VWAP",
      type: "proximity",
    }],
  });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [first, second], []);
  const patience = occurrences.find((occurrence) => occurrence.kind === "patience")!;
  assert.equal(patience.occurrenceId, buildHistoricalOccurrenceLedger(occurrenceDataset(), [second, first], [])
    .find((occurrence) => occurrence.kind === "patience")?.occurrenceId);
  assert.deepEqual(patience.levelIdentifiers, ["ORB", "VWAP"]);
  assert.deepEqual(patience.matchedEdges, ["ORB_PULLBACK_CONTINUATION", "PATIENCE_CANDLE_CONTINUATION"]);
});

test("changing only the qualifying L leaves the physical P to E identity unchanged", () => {
  const original = occurrenceAudit("ORB_PULLBACK_CONTINUATION");
  const changedL = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    pullbackOccurrences: [{
      ...original.pullbackOccurrences![0]!,
      eventId: "different-l",
      time: new Date(0).toISOString(),
      candle: { ...original.pullbackOccurrences![0]!.candle!, openTime: 0, closeTime: 300_000 },
    }],
    patienceOccurrences: [{
      ...original.patienceOccurrences![0]!,
      eligibilityTime: 0,
      eligibilityEventId: "different-l",
    }],
  });
  const originalPatience = buildHistoricalOccurrenceLedger(occurrenceDataset(), [original], [])
    .find((occurrence) => occurrence.kind === "patience")!;
  const changedPatience = buildHistoricalOccurrenceLedger(occurrenceDataset(), [changedL], [])
    .find((occurrence) => occurrence.kind === "patience")!;
  assert.equal(changedPatience.occurrenceId, originalPatience.occurrenceId);
  assert.notEqual(changedPatience.lTimestamp, originalPatience.lTimestamp);
  assert.equal(changedPatience.pOpenTimestamp, originalPatience.pOpenTimestamp);
  assert.equal(changedPatience.eOpenTimestamp, originalPatience.eOpenTimestamp);
});

test("a terminal non-consumed arm cannot create a candidate or affect metrics", () => {
  const terminalStates = [
    "STRUCTURALLY_INVALIDATED",
    "SUPERSEDED_BY_NEW_BREAKOUT",
    "OPPOSITE_BREAKOUT_INVALIDATED",
    "DATA_GAP_INVALIDATED",
    "ENTRY_CUTOFF_EXPIRED",
    "SESSION_BOUNDARY_EXPIRED",
    "CONTRACT_BOUNDARY_EXPIRED",
  ] as const;
  for (const state of terminalStates) {
    const occurrence = confirmedCandidateOccurrence({
      pOpen: "2026-08-25T14:00:00.000Z",
      eOpen: "2026-08-25T14:05:00.000Z",
      eClose: "2026-08-25T14:10:00.000Z",
      eligibilityArmId: `terminal-${state}`,
      eligibilityArmState: "active",
    });
    const result = projectHistoricalTradeCandidates([occurrence], [], {
      dataset: candidateProjectionDataset(occurrence),
      specification: getFuturesContractSpecification("MES"),
      executionMode: "ohlcv_modeled",
      lifecycle: lifecycleForArm(`terminal-${state}`, state),
    });
    assert.equal(result.candidates.length, 0, state);
    assert.equal(result.authoritativeTrades.length, 0, state);
    assert.equal(result.rejected[0]?.reasonCodes[0], `REJECTED_PULLBACK_ARM_${state}`, state);
    const metrics = calculateBacktestMetrics(result.authoritativeTrades);
    assert.equal(metrics.tradeCount, 0, state);
    assert.equal(metrics.netPnl, 0, state);
  }
});

test("a confirmed candidate remains eligible when its arm terminates after confirmation", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T14:00:00.000Z",
    eOpen: "2026-08-25T14:05:00.000Z",
    eClose: "2026-08-25T14:10:00.000Z",
    eligibilityArmId: "confirmed-before-cutoff",
    eligibilityArmState: "active",
  });
  const terminalTime = Date.parse("2026-08-25T14:15:00.000Z");
  const lifecycle = reducePullbackArmLifecycles([{
    armId: "confirmed-before-cutoff",
    transitions: [
      { from: null, to: "ARMED_AFTER_BREAKOUT", time: Date.parse("2026-08-25T13:55:00.000Z"), reason: "breakout" },
      { from: "ARMED_AFTER_BREAKOUT", to: "LEVEL_INTERACTION_FOUND", time: Date.parse("2026-08-25T14:00:00.000Z"), reason: "pullback" },
      { from: "LEVEL_INTERACTION_FOUND", to: "ENTRY_CUTOFF_EXPIRED", time: terminalTime, reason: "entry cutoff" },
    ],
    source: "test-lifecycle",
  }]);
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
    lifecycle,
  });
  assert.equal(result.rejected.length, 0);
  assert.equal(result.candidates.length, 1);
});

test("one pullback arm authorizes later confirmed signals after a legacy CONSUMED marker", () => {
  const first = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T14:00:00.000Z",
    eOpen: "2026-08-25T14:05:00.000Z",
    eClose: "2026-08-25T14:10:00.000Z",
    eligibilityArmId: "consumed-arm",
    eligibilityArmState: "consumed",
  });
  const later = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T14:15:00.000Z",
    eOpen: "2026-08-25T14:20:00.000Z",
    eClose: "2026-08-25T14:25:00.000Z",
    eligibilityArmId: "consumed-arm",
    eligibilityArmState: "active",
  });
  const result = projectHistoricalTradeCandidates([first, later], [], {
    dataset: candidateProjectionDataset(first),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
    lifecycle: lifecycleForArm("consumed-arm", "CONSUMED", first),
  });
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.signalOccurrenceId),
    [first.occurrenceId, later.occurrenceId],
  );
  assert.equal(result.rejected.length, 0);
});

test("duplicate observations of the same consuming signal merge without conflicts", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T14:00:00.000Z",
    eOpen: "2026-08-25T14:05:00.000Z",
    eClose: "2026-08-25T14:10:00.000Z",
    eligibilityArmId: "duplicate-consumer-arm",
    eligibilityArmState: "consumed",
  });
  const identity = {
    sourceFingerprint: occurrence.sourceFingerprint,
    formulaHash: occurrence.formulaHash,
    contractSymbol: occurrence.contractSymbol,
    tradingDate: occurrence.tradingDate,
    direction: occurrence.direction,
    pOpenTimestamp: occurrence.pOpenTimestamp,
    eOpenTimestamp: occurrence.eOpenTimestamp,
  };
  const transitions = [
    { from: null, to: "ARMED_AFTER_BREAKOUT" as const, time: 0, reason: "breakout" },
    { from: "ARMED_AFTER_BREAKOUT" as const, to: "PULLBACK_OBSERVED" as const, time: 1, reason: "pullback" },
    { from: "PULLBACK_OBSERVED" as const, to: "LEVEL_INTERACTION_FOUND" as const, time: 2, reason: "level" },
    { from: "LEVEL_INTERACTION_FOUND" as const, to: "PATIENCE_ARMED" as const, time: 3, reason: "patience" },
    { from: "PATIENCE_ARMED" as const, to: "SIGNAL_CONFIRMED" as const, time: 4, reason: "confirmed" },
    {
      from: "SIGNAL_CONFIRMED" as const,
      to: "CONSUMED" as const,
      time: 4,
      reason: "consumed",
      consumingSignalIdentity: identity,
      consumingSignalOccurrenceId: occurrence.occurrenceId,
    },
  ];
  const reduced = reducePullbackArmLifecycles([
    { armId: "duplicate-consumer-arm", transitions, source: "cursor-1" },
    { armId: "duplicate-consumer-arm", transitions, source: "cursor-2" },
  ]);
  assert.equal(reduced.duplicateTransitions, transitions.length);
  assert.equal(reduced.conflicts.length, 0);
  assert.deepEqual(reduced.records[0]?.consumingSignalIdentity, identity);
  assert.equal(reduced.records[0]?.consumingSignalOccurrenceId, occurrence.occurrenceId);

  const conflictingIdentity = { ...identity, pOpenTimestamp: "2026-08-25T14:15:00.000Z" };
  const conflicting = reducePullbackArmLifecycles([{
    armId: "duplicate-consumer-arm",
    transitions,
    source: "canonical-cursor",
  }, {
    armId: "duplicate-consumer-arm",
    transitions: [{
      from: "SIGNAL_CONFIRMED" as const,
      to: "CONSUMED" as const,
      time: 4,
      reason: "consumed",
      consumingSignalIdentity: conflictingIdentity,
      consumingSignalOccurrenceId: "different-consumer",
    }],
    source: "conflicting-cursor",
  }]);
  assert.equal(conflicting.records[0]?.consumingSignalIdentity?.pOpenTimestamp, identity.pOpenTimestamp);
  assert.equal(conflicting.conflicts.length, 0);
});

test("historical lifecycle reduction records the canonical consumer identity", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T14:00:00.000Z",
    eOpen: "2026-08-25T14:05:00.000Z",
    eClose: "2026-08-25T14:10:00.000Z",
    eligibilityArmId: "historical-consumer-arm",
    eligibilityArmState: "consumed",
  });
  const reduced = reduceHistoricalPullbackLifecycles([], [{
    occurrenceId: "raw-consuming-observation",
    direction: occurrence.direction,
    patienceCandle: {
      openTime: Date.parse(occurrence.pOpenTimestamp),
      closeTime: Date.parse(occurrence.eOpenTimestamp),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      isComplete: true,
    },
    eligibilityArmId: "historical-consumer-arm",
    eligibilityArmState: "consumed",
    expectedEntryCandleOpenTime: Date.parse(occurrence.eOpenTimestamp),
    qualificationStatus: "SIGNAL_CONFIRMED",
    outcomeStatus: "CONFIRMED",
    status: "ENTRY_TRIGGERED",
    evaluationCursor: Date.parse(occurrence.eClose),
    eligibilityArmTransitionTime: Date.parse(occurrence.eClose),
  } as any], [occurrence]);
  assert.deepEqual(reduced.records[0]?.consumingSignalIdentity, {
    sourceFingerprint: occurrence.sourceFingerprint,
    formulaHash: occurrence.formulaHash,
    contractSymbol: occurrence.contractSymbol,
    tradingDate: occurrence.tradingDate,
    direction: occurrence.direction,
    pOpenTimestamp: occurrence.pOpenTimestamp,
    eOpenTimestamp: occurrence.eOpenTimestamp,
  });
  assert.equal(reduced.records[0]?.consumingSignalOccurrenceId, occurrence.occurrenceId);
});

test("arm-backed confirmed signals fail closed when lifecycle data is missing", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T14:00:00.000Z",
    eOpen: "2026-08-25T14:05:00.000Z",
    eClose: "2026-08-25T14:10:00.000Z",
    eligibilityArmId: "missing-lifecycle-arm",
    eligibilityArmState: "active",
  });
  const context = {
    dataset: candidateProjectionDataset(occurrence),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled" as const,
  };
  const missingArgument = projectHistoricalTradeCandidates([occurrence], [], context);
  assert.equal(missingArgument.candidates.length, 0);
  assert.equal(missingArgument.authoritativeTrades.length, 0);
  assert.equal(missingArgument.rejected[0]?.reasonCodes[0], "REJECTED_PULLBACK_ARM_LIFECYCLE_MISSING");

  const missingRecord = projectHistoricalTradeCandidates([occurrence], [], {
    ...context,
    lifecycle: reducePullbackArmLifecycles([]),
  });
  assert.equal(missingRecord.candidates.length, 0);
  assert.equal(missingRecord.authoritativeTrades.length, 0);
  assert.equal(missingRecord.rejected[0]?.reasonCodes[0], "REJECTED_PULLBACK_ARM_LIFECYCLE_MISSING");
});

test("eligible confirmed candidate creates one threshold trade without a legacy raw trade", () => {
  const patienceTimestamp = "2026-08-25T13:55:00.000Z";
  const entryTimestamp = "2026-08-25T14:00:00.000Z";
  const occurrence = {
    occurrenceId: "signal-candidate-driven",
    auditId: "audit-candidate-driven",
    kind: "patience",
    strategyCandidate: "ORB_PULLBACK_CONTINUATION",
    secondaryStrategyMatches: [],
    tradingDate: "2026-08-25",
    contractSymbol: "MESU26",
    contractMonth: "U26",
    direction: "long",
    lTimestamp: "2026-08-25T13:50:00.000Z",
    lEventId: "l-candidate-driven",
    lInteractionType: "proximity",
    lCandle: null,
    previousComparisonTimestamp: "2026-08-25T13:45:00.000Z",
    patienceTimestamp,
    patienceCandle: { openTime: Date.parse(patienceTimestamp), closeTime: Date.parse(entryTimestamp), open: 100, high: 101, low: 99, close: 100.5, volume: 1000, isComplete: true },
    candidateShapeResult: true,
    expectedEntryTimestamp: entryTimestamp,
    confirmationThreshold: 101.25,
    confirmationExcursion: 0.25,
    entryTimestamp: null,
    entryCandle: null,
    levelIdentifiers: ["Prior day high"],
    levelValues: { "Prior day high": 100.5 },
    levelDistancesTicks: {},
    levelTolerancePoints: {},
    levelToleranceTicks: {},
     levelInteractionTypes: { "Prior day high": ["touch"] },
    pOpenTimestamp: patienceTimestamp,
    eOpenTimestamp: entryTimestamp,
    entryObservationTimestamp: new Date(Date.parse(entryTimestamp) + 300_000).toISOString(),
    confirmationBufferTicks: 1,
    nextObservedCandle: null,
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
    status: "SIGNAL_CONFIRMED",
    reasonCode: "Immediate next candle reached the confirmation buffer.",
    evaluationCursor: entryTimestamp,
    formulaVersion: "phase9-fixed-formula-v2",
    formulaHash: "d".repeat(64),
    sourceFingerprint: "e".repeat(64),
    canonicalTrade: false,
    canonicalOccurrence: true,
    primaryEdge: "ORB_PULLBACK_CONTINUATION",
    matchedEdges: ["ORB_PULLBACK_CONTINUATION"],
    supportingConfluences: ["Immediate confirmation"],
    setupGrade: "A",
    signalStatus: "SIGNAL_CONFIRMED",
  } as any;
  const dataset = {
    candles: [
      candle(Date.parse(patienceTimestamp) / 300_000, { openTime: Date.parse(patienceTimestamp), closeTime: Date.parse(entryTimestamp), contractSymbol: "MESU26", high: 101, low: 99 }),
      candle(Date.parse(entryTimestamp) / 300_000, { openTime: Date.parse(entryTimestamp), closeTime: Date.parse(entryTimestamp) + 300_000, contractSymbol: "MESU26", high: 101.25, low: 100 }),
    ],
    inSampleDates: ["2026-08-25"],
    outOfSampleDates: [],
    contractMonth: "U26",
  } as any;
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset,
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.executionStatus, "MODELED_TRADE_CREATED");
  assert.equal(result.authoritativeTrades.length, 1);
  assert.equal(result.authoritativeTrades[0]?.candidateId, result.candidates[0]?.candidateId);
  assert.equal(result.authoritativeTrades[0]?.signalOccurrenceId, occurrence.occurrenceId);
  assert.equal(result.authoritativeTrades[0]?.fillLabel, "OHLCV_CONFIRMATION_THRESHOLD");
  assert.equal(result.authoritativeTrades[0]?.entryPrice, 101.25);
  assert.equal(result.authoritativeTrades[0]?.entryTime, new Date(Date.parse(entryTimestamp) + 300_000).toISOString());
  assert.equal(result.authoritativeTrades[0]?.audit?.triggerCandleOpenTime, entryTimestamp);
  assert.equal(result.authoritativeTrades[0]?.audit?.triggerCandleCloseTime, new Date(Date.parse(entryTimestamp) + 300_000).toISOString());
  assert.equal(result.authoritativeTrades[0]?.audit?.modeledFillObservationTime, new Date(Date.parse(entryTimestamp) + 300_000).toISOString());
  assert.equal(result.candidates[0]?.managementContext?.managementEvidenceStatus, "missing");

  const legacyTrade = { ...result.authoritativeTrades[0]!, id: "legacy-conflicts-with-entry" };
  const reconciledResult = projectHistoricalTradeCandidates([occurrence], [legacyTrade], {
    dataset,
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(reconciledResult.authoritativeTrades.length, 1);
  assert.equal(reconciledResult.authoritativeTrades[0]?.entryTime, new Date(Date.parse(entryTimestamp) + 300_000).toISOString());
  assert.equal(reconciledResult.authoritativeTrades[0]?.audit?.triggerCandleCloseTime, new Date(Date.parse(entryTimestamp) + 300_000).toISOString());

  const failedOccurrence = {
    ...occurrence,
    confirmationThreshold: 101.5,
  };
  const failedResult = projectHistoricalTradeCandidates([failedOccurrence], [legacyTrade], {
    dataset,
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(failedResult.candidates[0]?.executionStatus, "ENTRY_NOT_REACHED");
  assert.equal(failedResult.authoritativeTrades.length, 0);
  assert.deepEqual(failedResult.orphans, [{
    tradeId: "legacy-conflicts-with-entry",
    matchingSignalOccurrenceId: occurrence.occurrenceId,
    reason: "LEGACY_TRADE_CONFLICTS_WITH_CANDIDATE_ENTRY_DISPOSITION",
  }]);
});

test("6725.75 short E crossing creates exactly one candidate-owned threshold fill", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    direction: "short",
    entryHigh: 6728,
    entryLow: 6713.25,
  });
  occurrence.patienceCandle = {
    ...occurrence.patienceCandle,
    open: 6729,
    high: 6730,
    low: 6727.75,
    close: 6728.25,
  };
  occurrence.entryCandle = {
    ...occurrence.entryCandle,
    open: 6728.25,
    high: 6728.5,
    low: 6713.25,
    close: 6715,
  };
  occurrence.confirmationThreshold = 6725.75;
  occurrence.confirmationBufferTicks = 8;
  const duplicateReference = {
    ...occurrence,
    auditId: "duplicate-audit-reference",
    auditIds: ["duplicate-audit-reference"],
  };
  const result = projectHistoricalTradeCandidates(
    [duplicateReference, occurrence],
    [],
    {
      dataset: candidateProjectionDataset(occurrence),
      specification: getFuturesContractSpecification("MES"),
      executionMode: "ohlcv_modeled",
    },
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.entryReachedThreshold, true);
  assert.equal(result.candidates[0]?.executionStatus, "MODELED_TRADE_CREATED");
  assert.equal(result.authoritativeTrades.length, 1);
  const candidate = result.candidates[0]!;
  const trade = result.authoritativeTrades[0]!;
  assert.equal(trade.entryPrice, 6725.75);
  assert.equal(trade.audit?.modeledFillPrice, 6725.75);
  assert.equal(trade.audit?.triggerCandleOpenTime, occurrence.eOpenTimestamp);
  assert.equal(trade.entryTime, occurrence.entryObservationTimestamp);
  assert.equal(trade.audit?.modeledFillObservationTime, occurrence.entryObservationTimestamp);
  assert.equal(trade.candidateId, candidate.candidateId);
  assert.equal(trade.signalOccurrenceId, candidate.signalOccurrenceId);

  const reconciliationRow = {
    signalOccurrenceId: candidate.signalOccurrenceId,
    candidateId: candidate.candidateId,
    pOpen: candidate.pOpenTimestamp,
    eOpen: candidate.eOpenTimestamp,
    eClose: candidate.entryObservationTimestamp,
    threshold: candidate.confirmationPrice,
    eRange: [candidate.entryLow, candidate.entryHigh],
    disposition: candidate.executionStatus,
    fill: trade.audit?.modeledFillPrice,
    tradeId: trade.id,
    exitStatus: trade.outcome,
  };
  assert.deepEqual(reconciliationRow, {
    signalOccurrenceId: occurrence.occurrenceId,
    candidateId: candidate.candidateId,
    pOpen: occurrence.pOpenTimestamp,
    eOpen: occurrence.eOpenTimestamp,
    eClose: occurrence.entryObservationTimestamp,
    threshold: 6725.75,
    eRange: [6713.25, 6728.5],
    disposition: "MODELED_TRADE_CREATED",
    fill: 6725.75,
    tradeId: `${candidate.candidateId}-ohlcv-confirmation`,
    exitStatus: "open",
  });
});

test("candidate projection rejects finalized NTZ entries and does not emit a fill", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
  });
  occurrence.finalizedNtzComplete = true;
  occurrence.finalizedNtzLow = 101;
  occurrence.finalizedNtzHigh = 101.5;
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.authoritativeTrades.length, 0);
  assert.deepEqual(result.rejected[0]?.reasonCodes, ["REJECTED_INSIDE_NTZ"]);
});

test("candidate diagnostics report missing, duplicate, and identity-mismatched fills", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
  }) as HistoricalOccurrence;
  const projected = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  assert.deepEqual(
    historicalReplayDiagnostics([], [occurrence], projected.candidates, projected.authoritativeTrades)
      .candidateInvariantViolations,
    [],
  );
  const missing = historicalReplayDiagnostics([], [occurrence], projected.candidates, []);
  assert.match(missing.candidateInvariantViolations.join(" "), /expected exactly one/);

  const trade = projected.authoritativeTrades[0]!;
  const duplicate = historicalReplayDiagnostics(
    [],
    [occurrence],
    projected.candidates,
    [trade, { ...trade, id: `${trade.id}-duplicate` }],
  );
  assert.match(duplicate.candidateInvariantViolations.join(" "), /has 2 authoritative trades/);

  const mismatched = historicalReplayDiagnostics(
    [],
    [occurrence],
    projected.candidates,
    [{ ...trade, signalOccurrenceId: "wrong-signal" }],
  );
  assert.match(mismatched.candidateInvariantViolations.join(" "), /mismatched signalOccurrenceId/);

  const contradictoryCandidate = {
    ...projected.candidates[0]!,
    executionStatus: "ENTRY_NOT_REACHED" as const,
  };
  const contradictory = historicalReplayDiagnostics([], [occurrence], [contradictoryCandidate], []);
  assert.match(contradictory.candidateInvariantViolations.join(" "), /does not match executionStatus/);
});

test("historical diagnostics reduce repeated arm cursors and preserve terminal boundary conflicts", () => {
  const armId = "orb-arm|full-identity";
  const path = [
    { from: null, to: "ARMED_AFTER_BREAKOUT" as const, time: 1, reason: "breakout" },
    { from: "ARMED_AFTER_BREAKOUT" as const, to: "PULLBACK_OBSERVED" as const, time: 2, reason: "pullback" },
    { from: "PULLBACK_OBSERVED" as const, to: "LEVEL_INTERACTION_FOUND" as const, time: 3, reason: "level" },
  ];
  const first = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "arm-cursor-1",
    patienceOccurrences: [],
    pullbackArmId: armId,
    pullbackArmState: "LEVEL_INTERACTION_FOUND",
    pullbackArmTransitions: path.map((transition) => ({
      ...transition,
      time: new Date(transition.time).toISOString(),
    })),
  });
  const terminal = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "arm-cursor-2",
    patienceOccurrences: [],
    pullbackArmId: armId,
    pullbackArmState: "SESSION_BOUNDARY_EXPIRED",
    pullbackArmTransitions: [
      ...path,
      {
        from: "LEVEL_INTERACTION_FOUND" as const,
        to: "SESSION_BOUNDARY_EXPIRED" as const,
        time: 4,
        reason: "boundary",
      },
    ].map((transition) => ({ ...transition, time: new Date(transition.time).toISOString() })),
  });
  const stale = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "arm-cursor-3",
    patienceOccurrences: [],
    pullbackArmId: armId,
    pullbackArmState: "PULLBACK_OBSERVED",
    pullbackArmTransitions: [{
      from: "SESSION_BOUNDARY_EXPIRED",
      to: "PULLBACK_OBSERVED",
      time: new Date(5).toISOString(),
      reason: "stale later cursor",
    }],
  });
  const diagnostics = historicalReplayDiagnostics([first, terminal, stale], [], [], [], [], []);
  assert.equal(diagnostics.pullbackArmsCreated, 1);
  assert.equal(diagnostics.pullbackSessionExpirations, 1);
  assert.equal(diagnostics.pullbackActiveArms, 0);
  assert.equal(diagnostics.pullbackLifecycleStateCounts.SESSION_BOUNDARY_EXPIRED, 1);
  assert.ok(diagnostics.pullbackLifecycleDuplicateTransitions > 0);
  assert.equal(diagnostics.pullbackLifecycleConflicts, 1);
  assert.equal(diagnostics.armTerminalConflicts, 1);
  assert.equal(diagnostics.pullbackInvariantViolations.length, 1);
});

test("invalid confirmed P to E identity is rejected diagnostically without a candidate or trade", () => {
  const occurrence = {
    ...confirmedCandidateOccurrence({
      pOpen: "2026-08-25T15:00:00.000Z",
      eOpen: "2026-08-25T15:05:00.000Z",
      eClose: "2026-08-25T15:10:00.000Z",
    }),
    identityInvariantViolations: ["P_E_DURATION_MISMATCH", "CONFIRMATION_NOT_ON_IMMEDIATE_E"],
  } as HistoricalOccurrence;
  const result = projectHistoricalTradeCandidates(
    [occurrence],
    [],
    {
      dataset: candidateProjectionDataset(occurrence),
      specification: {} as any,
      executionMode: "ohlcv_modeled",
    },
  );
  assert.equal(result.candidates.length, 0);
  assert.equal(result.authoritativeTrades.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.rejected[0]?.reasonCodes, ["INVALID_CAUSAL_IDENTITY"]);
  assert.deepEqual(result.rejected[0]?.details, occurrence.identityInvariantViolations);

  const diagnostics = historicalReplayDiagnostics([], [occurrence], [], [], result.rejected);
  assert.equal(diagnostics.invalidCausalIdentityCount, 1);
  assert.equal(diagnostics.confirmedSignalsWithoutCandidates, 1);
  assert.equal(
    diagnostics.candidateRejectionReasons[occurrence.occurrenceId],
    occurrence.identityInvariantViolations.join(" "),
  );
});

test("confirmed signals do not require key-level interaction evidence for candidate projection", () => {
  const base = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
  });
  const dataset = candidateProjectionDataset(base);
  const noInteraction = projectHistoricalTradeCandidates([{ ...base, levelInteractionTypes: {} }], [], {
    dataset,
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(noInteraction.candidates.length, 1);

  const fibonacciOnly = projectHistoricalTradeCandidates([{
    ...base,
    levelIdentifiers: ["Fibonacci 61.8"],
    levelValues: { "Fibonacci 61.8": 100 },
    levelInteractionTypes: { "Fibonacci 61.8": ["touch"] },
  }], [], {
    dataset,
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(fibonacciOnly.candidates.length, 1);

  const causalLevel = projectHistoricalTradeCandidates([{
    ...base,
    levelIdentifiers: ["VWAP"],
    levelValues: { VWAP: 100 },
    levelInteractionTypes: { VWAP: ["proximity"] },
  }], [], {
    dataset,
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(causalLevel.candidates.length, 1);
});

test("confirmed signal missing P open is rejected with field-level causal identity evidence", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
  });
  occurrence.pOpenTimestamp = null;
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence),
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.authoritativeTrades.length, 0);
  assert.deepEqual(result.rejected, [{
    signalOccurrenceId: occurrence.occurrenceId,
    reasonCodes: ["INVALID_CAUSAL_IDENTITY"],
    details: ["MISSING_OR_INVALID_pOpenTimestamp"],
  }]);
});

test("confirmed signal missing immediate E open is rejected with field-level causal identity evidence", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
  });
  occurrence.eOpenTimestamp = null;
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence),
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.rejected[0]?.reasonCodes, ["INVALID_CAUSAL_IDENTITY"]);
  assert.ok(result.rejected[0]?.details.includes("MISSING_OR_INVALID_eOpenTimestamp"));
});

test("confirmed signal missing E-close observation is rejected with field-level causal identity evidence", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
  });
  occurrence.entryObservationTimestamp = null;
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence),
    specification: {} as any,
    executionMode: "ohlcv_modeled",
  });
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.rejected[0]?.reasonCodes, ["INVALID_CAUSAL_IDENTITY"]);
  assert.ok(result.rejected[0]?.details.includes("MISSING_OR_INVALID_entryObservationTimestamp"));
});

test("candidate window uses E open time across EST and EDT cutoffs", () => {
  const cases = [
    {
      label: "EDT before cutoff",
      pOpen: "2026-08-25T16:45:00.000Z",
      eOpen: "2026-08-25T16:50:00.000Z",
      eClose: "2026-08-25T16:55:00.000Z",
      expectedCandidates: 1,
    },
    {
       label: "EDT 12:55 E open with 1:00 close",
      pOpen: "2026-08-25T16:50:00.000Z",
      eOpen: "2026-08-25T16:55:00.000Z",
      eClose: "2026-08-25T17:00:00.000Z",
       expectedCandidates: 1,
    },
    {
      label: "EDT one o'clock open",
      pOpen: "2026-08-25T16:55:00.000Z",
      eOpen: "2026-08-25T17:00:00.000Z",
      eClose: "2026-08-25T17:05:00.000Z",
      expectedCandidates: 0,
    },
    {
      label: "EST before cutoff",
      pOpen: "2026-01-15T17:45:00.000Z",
      eOpen: "2026-01-15T17:50:00.000Z",
      eClose: "2026-01-15T17:55:00.000Z",
      expectedCandidates: 1,
    },
    {
       label: "EST 12:55 E open with 1:00 close",
      pOpen: "2026-01-15T17:50:00.000Z",
      eOpen: "2026-01-15T17:55:00.000Z",
      eClose: "2026-01-15T18:00:00.000Z",
       expectedCandidates: 1,
    },
  ];
  for (const item of cases) {
    const occurrence = confirmedCandidateOccurrence(item);
    const result = projectHistoricalTradeCandidates(
      [occurrence],
      [],
      {
        dataset: candidateProjectionDataset(occurrence),
        specification: {} as any,
        executionMode: "ohlcv_modeled",
      },
    );
    assert.equal(result.candidates.length, item.expectedCandidates, item.label);
    if (item.expectedCandidates === 0) {
      assert.deepEqual(result.rejected[0]?.reasonCodes, ["REJECTED_OUTSIDE_ENTRY_WINDOW"], item.label);
    }
  }
});

test("physical candidate identity keeps opposite directions separate", () => {
  const long = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    direction: "long",
  });
  const short = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    direction: "short",
  });
  const dataset = candidateProjectionDataset(long);
  const result = projectHistoricalTradeCandidates(
    [long, short],
    [],
    {
      dataset,
      specification: {} as any,
      executionMode: "ohlcv_modeled",
    },
  );
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.direction).sort(), ["long", "short"]);
});

test("invalid frozen strategy-stop geometry stays open and unscored without P&L", () => {
  for (const direction of ["long", "short"] as const) {
    const occurrence = confirmedCandidateOccurrence({
      pOpen: "2026-08-25T15:00:00.000Z",
      eOpen: "2026-08-25T15:05:00.000Z",
      eClose: "2026-08-25T15:10:00.000Z",
      direction,
      patienceLow: direction === "long" ? 104 : undefined,
      patienceHigh: direction === "short" ? 96 : undefined,
      management: {
        strategyStopPrice: direction === "long" ? 99 : 101,
        catastropheStopPrice: direction === "long" ? 100 : 100,
        targetPrice: direction === "long" ? 105 : 95,
        contracts: 1,
        runnerActivationPrice: direction === "long" ? 101.25 : 98.75,
        runnerExitRule: "40% retracement",
        sessionCloseTime: "2026-08-25T20:00:00.000Z",
        sourceAuditId: "invalid-geometry-audit",
        missingEvidenceReasons: [],
      },
    });
    occurrence.targetLevelInputs = [{
      id: direction === "long" ? "invalid-geometry-target-long" : "invalid-geometry-target-short",
      type: "major resistance",
      price: direction === "long" ? 105 : 95,
    }];
    const result = projectHistoricalTradeCandidates(
      [occurrence],
      [],
      {
        dataset: candidateProjectionDataset(occurrence, { high: 106, low: 94 }),
        specification: getFuturesContractSpecification("MES"),
        executionMode: "ohlcv_modeled",
      },
    );
    assert.equal(result.candidates[0]?.executionStatus, "MODELED_TRADE_CREATED", direction);
    assert.equal(result.candidates[0]?.managementContext?.managementEvidenceStatus, "invalid", direction);
    assert.match(result.candidates[0]?.managementContext?.missingEvidenceReasons.join(", ") ?? "", /INVALID_MANAGEMENT_GEOMETRY/);
    assert.match(result.candidates[0]?.managementContext?.missingEvidenceReasons.join(", ") ?? "", /STOP_TARGET_ORDER/);
    assert.equal(result.authoritativeTrades[0]?.outcome, "open", direction);
    assert.equal(result.authoritativeTrades[0]?.exitPrice, null, direction);
    assert.equal(result.authoritativeTrades[0]?.netPnl, 0, direction);
    assert.equal(result.authoritativeTrades[0]?.audit?.legs.length, 0, direction);
  }
});

test("valid frozen geometry preserves deterministic target replay and starts after E", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    management: {
      strategyStopPrice: 97,
      catastropheStopPrice: 96,
      targetPrice: 105,
      contracts: 1,
      runnerActivationPrice: null,
      runnerExitRule: null,
      sessionCloseTime: "2026-08-25T20:00:00.000Z",
      sourceAuditId: "valid-geometry-audit",
      missingEvidenceReasons: [],
    },
  });
  occurrence.targetLevelInputs = [{
    id: "major-resistance",
    type: "major resistance",
    price: 105,
  }];
  const result = projectHistoricalTradeCandidates(
    [occurrence],
    [],
    {
      dataset: candidateProjectionDataset(occurrence, { high: 106, low: 101 }),
      specification: getFuturesContractSpecification("MES"),
      executionMode: "ohlcv_modeled",
    },
  );
  assert.equal(result.candidates[0]?.managementContext?.managementEvidenceStatus, "complete");
  assert.equal(result.authoritativeTrades[0]?.outcome, "target");
  assert.equal(result.authoritativeTrades[0]?.audit?.modeledFillObservationTime, occurrence.entryObservationTimestamp);
  assert.equal(result.authoritativeTrades[0]?.audit?.exitCandleOpenTime, occurrence.entryObservationTimestamp);
});

test("candidate target snapshot rejects legacy target fallback and stays open", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    entryHigh: 102,
    management: {
      strategyStopPrice: 97,
      catastropheStopPrice: 96,
      targetPrice: 125,
      contracts: 1,
      runnerActivationPrice: null,
      runnerExitRule: null,
      sessionCloseTime: "2026-08-25T20:00:00.000Z",
      sourceAuditId: "legacy-target-audit",
      missingEvidenceReasons: [],
    },
  });
  occurrence.targetLevelInputs = [
    { id: "fibonacci-618", type: "Fibonacci", price: 110 },
    { id: "previous-day-close", type: "PREVIOUS_DAY", price: 115 },
  ];
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence, { high: 130, low: 101 }),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  const candidate = result.candidates[0]!;
  const trade = result.authoritativeTrades[0]!;
  assert.equal(candidate.targetDisposition, "NO_ELIGIBLE_KEY_LEVEL");
  assert.equal(candidate.targetPlan?.targetPrice, null);
  assert.equal(candidate.managementContext?.managementEvidenceStatus, "complete");
  assert.equal(candidate.managementContext?.missingEvidenceReasons.includes("NO_ELIGIBLE_KEY_LEVEL"), false);
  assert.equal(trade.outcome, "session close");
  assert.notEqual(trade.exitPrice, null);
  assert.notEqual(trade.netPnl, 0);
  assert.equal(trade.audit?.targetPrice, null);
  assert.equal(trade.audit?.targetHit, false);
});

test("candidate target planning never reuses L-time qualifying values as E-time targets", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    entryHigh: 102,
    management: {
      strategyStopPrice: 97,
      catastropheStopPrice: null,
      targetPrice: 110,
      contracts: 1,
      runnerActivationPrice: null,
      runnerExitRule: null,
      sessionCloseTime: "2026-08-25T20:00:00.000Z",
      sourceAuditId: "l-value-is-not-e-target",
      missingEvidenceReasons: [],
    },
  });
  occurrence.levelIdentifiers = ["VWAP"];
  occurrence.levelValues = { VWAP: 110 };
  occurrence.levelInteractionTypes = { VWAP: ["touch"] };
  occurrence.targetLevelInputs = [];
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence, { high: 120, low: 101 }),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  assert.equal(result.candidates[0]?.targetDisposition, "NO_ELIGIBLE_KEY_LEVEL");
  assert.equal(result.candidates[0]?.targetPlan?.targetPrice, null);
  assert.notEqual(result.authoritativeTrades[0]?.outcome, "target");
  assert.equal(result.authoritativeTrades[0]?.audit?.targetPrice, null);
});

test("a valid strategy stop is sufficient without catastrophe-stop evidence", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    management: {
      strategyStopPrice: 97,
      targetPrice: 125,
      contracts: 1,
      runnerActivationPrice: null,
      runnerExitRule: null,
      sessionCloseTime: "2026-08-25T20:00:00.000Z",
      sourceAuditId: "strategy-only-audit",
      missingEvidenceReasons: [],
    },
  });
  occurrence.targetLevelInputs = [{ id: "fibonacci-618", type: "Fibonacci", price: 110 }];
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence, { high: 103, low: 96.5 }),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  const candidate = result.candidates[0]!;
  const trade = result.authoritativeTrades[0]!;
  assert.equal(candidate.managementContext?.managementEvidenceStatus, "complete");
  assert.equal(candidate.managementContext?.catastropheStopPrice, null);
  assert.equal(trade.outcome, "strategy stop");
  assert.equal(trade.audit?.strategyStopPrice, 97);
  assert.equal(trade.audit?.catastropheStopPrice, null);
  assert.equal(trade.audit?.stopLevel, "strategy");
});

test("no target does not disable the candidate-owned strategy stop", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    management: {
      strategyStopPrice: 97,
      catastropheStopPrice: 100,
      targetPrice: 125,
      contracts: 1,
      runnerActivationPrice: null,
      runnerExitRule: null,
      sessionCloseTime: "2026-08-25T20:00:00.000Z",
      sourceAuditId: "legacy-target-audit",
      missingEvidenceReasons: [],
    },
  });
  occurrence.targetLevelInputs = [{ id: "fibonacci-618", type: "Fibonacci", price: 110 }];
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: candidateProjectionDataset(occurrence, { high: 103, low: 96.5 }),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  const candidate = result.candidates[0]!;
  const trade = result.authoritativeTrades[0]!;
  assert.equal(candidate.targetDisposition, "NO_ELIGIBLE_KEY_LEVEL");
  assert.equal(trade.outcome, "strategy stop");
  assert.equal(trade.audit?.targetPrice, null);
  assert.equal(trade.audit?.targetHit, false);
  assert.equal(trade.audit?.eventLabels.includes("STRATEGY_STOP_REACHED"), true);
  assert.equal(trade.audit?.eventLabels.includes("CATASTROPHE_STOP_REACHED"), false);
  assert.equal(trade.audit?.stopPrice, 97);
  assert.equal(trade.audit?.stopLevel, "strategy");
  assert.equal(trade.audit?.catastropheStopPrice, 100);
  assert.equal(calculateBacktestMetrics([trade]).tradeCount, 1);
});

test("no target and no independent exit leaves the candidate open and unscored", () => {
  const occurrence = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
    management: {
      strategyStopPrice: 97,
      targetPrice: 125,
      contracts: 1,
      runnerActivationPrice: null,
      runnerExitRule: null,
      sessionCloseTime: "2026-08-25T20:00:00.000Z",
      sourceAuditId: "legacy-target-audit",
      missingEvidenceReasons: [],
    },
  });
  occurrence.targetLevelInputs = [{ id: "previous-day-close", type: "PREVIOUS_DAY", price: 125 }];
  const dataset = candidateProjectionDataset(occurrence);
  const result = projectHistoricalTradeCandidates([occurrence], [], {
    dataset: { ...dataset, candles: dataset.candles.slice(0, 2) },
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  const trade = result.authoritativeTrades[0]!;
  assert.equal(trade.outcome, "open");
  assert.equal(trade.exitPrice, null);
  assert.equal(trade.audit?.targetPrice, null);
  assert.equal(calculateBacktestMetrics([trade]).tradeCount, 0);
});

test("completed-E target snapshots do not inherit later audit cursor levels", () => {
  const first = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    targetLevelInputs: [{ id: "first-resistance", type: "major resistance", price: 110 }],
  });
  const later = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "later-cursor-audit",
    evaluatedCandleOpenTime: new Date(1_200_000).toISOString(),
    targetLevelInputs: [{ id: "later-closer-resistance", type: "major resistance", price: 104.5 }],
  });
  const tooLate = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "too-late-cursor-audit",
    evaluatedCandleOpenTime: new Date(1_500_000).toISOString(),
    targetLevelInputs: [{ id: "too-late-resistance", type: "major resistance", price: 103 }],
  });
  const occurrence = buildHistoricalOccurrenceLedger(occurrenceDataset(), [tooLate, later, first], [])
    .find((item) => item.kind === "patience")!;
  assert.equal(occurrence.targetLevelSnapshot?.sourceAuditId, later.id);
  assert.equal(occurrence.targetLevelSnapshot?.frozenAt, new Date(1_200_000).toISOString());
  assert.equal(occurrence.targetLevelSnapshot?.sourceAuditCursor, new Date(1_200_000).toISOString());
  assert.deepEqual(
    occurrence.targetLevelSnapshot?.frozenLevelInputs.map((level) => level.id),
    ["later-closer-resistance"],
  );
});

test("an incomplete E snapshot cannot win over the completed confirmed E snapshot", () => {
  const incomplete = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "incomplete-e-audit",
    evaluatedCandleOpenTime: new Date(900_000).toISOString(),
    targetLevelInputs: [{ id: "incomplete-resistance", type: "major resistance", price: 104.5 }],
  });
  const incompletePatience = incomplete.patienceOccurrences![0]!;
  incomplete.patienceOccurrences = [{
    ...incompletePatience,
    status: "PATIENCE_CANDLE_FORMING",
    outcomeStatus: undefined,
    triggerCandle: { ...incompletePatience.triggerCandle!, isComplete: false },
    nextObservedCandle: { ...incompletePatience.triggerCandle!, isComplete: false },
    evaluationCursor: 900_000,
  }];
  const completed = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "completed-e-audit",
    evaluatedCandleOpenTime: new Date(1_200_000).toISOString(),
    targetLevelInputs: [{ id: "completed-resistance", type: "major resistance", price: 110 }],
  });
  const occurrence = buildHistoricalOccurrenceLedger(
    occurrenceDataset(),
    [incomplete, completed],
    [],
  ).find((item) => item.kind === "patience")!;
  assert.equal(occurrence.status, "SIGNAL_CONFIRMED");
  assert.equal(occurrence.targetLevelSnapshot?.sourceAuditId, completed.id);
  assert.equal(occurrence.targetLevelSnapshot?.frozenAt, new Date(1_200_000).toISOString());
  assert.deepEqual(
    occurrence.targetLevelSnapshot?.frozenLevelInputs.map((level) => level.id),
    ["completed-resistance"],
  );
});

test("merged strategy audits preserve one immutable completed-E target plan", () => {
  const first = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    id: "earliest-completed-e",
    evaluatedCandleOpenTime: new Date(900_000).toISOString(),
    targetLevelInputs: [{ id: "earliest-resistance", type: "major resistance", price: 110 }],
  });
  const secondary = occurrenceAudit("CONSOLIDATION_BREAKOUT_CONTINUATION", {
    id: "secondary-completed-e",
    evaluatedCandleOpenTime: new Date(1_200_000).toISOString(),
    targetLevelInputs: [{ id: "new-closer-resistance", type: "major resistance", price: 104.5 }],
  });
  const occurrences = buildHistoricalOccurrenceLedger(
    occurrenceDataset(),
    [secondary, first],
    [],
  ).filter((item) => item.kind === "patience");
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]?.targetLevelSnapshot?.sourceAuditId, secondary.id);
  assert.deepEqual(
    occurrences[0]?.targetLevelSnapshot?.frozenLevelInputs.map((level) => level.id),
    ["new-closer-resistance"],
  );
  const firstProjection = projectHistoricalTradeCandidates(occurrences, [], {
    dataset: candidateProjectionDataset(occurrences[0]!),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  const secondProjection = projectHistoricalTradeCandidates(occurrences, [], {
    dataset: candidateProjectionDataset(occurrences[0]!),
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  assert.deepEqual(
    firstProjection.candidates[0]?.targetPlan?.targetLevelSnapshot,
    secondProjection.candidates[0]?.targetPlan?.targetLevelSnapshot,
  );
  assert.equal(
    firstProjection.candidates[0]?.targetPlan?.targetPrice,
    secondProjection.candidates[0]?.targetPlan?.targetPrice,
  );
});

test("same-session confirmed occurrences freeze independent target plans", () => {
  const first = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:00:00.000Z",
    eOpen: "2026-08-25T15:05:00.000Z",
    eClose: "2026-08-25T15:10:00.000Z",
  });
  const second = confirmedCandidateOccurrence({
    pOpen: "2026-08-25T15:10:00.000Z",
    eOpen: "2026-08-25T15:15:00.000Z",
    eClose: "2026-08-25T15:20:00.000Z",
  });
  first.auditId = "first-audit";
  second.auditId = "second-audit";
  first.targetLevelInputs = [{ id: "first-resistance", type: "major resistance", price: 110 }];
  second.targetLevelInputs = [{ id: "second-resistance", type: "major resistance", price: 120 }];
  const firstDataset = candidateProjectionDataset(first);
  const secondDataset = candidateProjectionDataset(second);
  const result = projectHistoricalTradeCandidates([first, second], [], {
    dataset: {
      ...firstDataset,
      candles: [...firstDataset.candles, ...secondDataset.candles],
    },
    specification: getFuturesContractSpecification("MES"),
    executionMode: "ohlcv_modeled",
  });
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.targetPlan?.selectedTargetLevel?.id).sort(),
    ["first-resistance", "second-resistance"],
  );
  assert.notEqual(result.candidates[0]?.targetPlan?.targetLevelSnapshot?.sourceAuditId,
    result.candidates[1]?.targetPlan?.targetLevelSnapshot?.sourceAuditId);
});

test("ledger stores one pullback for repeated strategy references to the same level interaction", () => {
  const first = occurrenceAudit("ORB_PULLBACK_CONTINUATION", {
    pullbackOccurrences: [{
      eventId: "touch-reference",
      type: "touch",
      time: new Date(300_000).toISOString(),
      level: "ORB",
      price: 101,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      candle: { openTime: 300_000, closeTime: 600_000, open: 100, high: 103, low: 99, close: 101, volume: 10 },
      detail: "Touch reference.",
    }],
  });
  const repeated = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION", {
    id: "repeated-reference",
    breakoutEvidence: `${first.breakoutEvidence} (later audit cursor)`,
    pullbackOccurrences: [{
      eventId: "proximity-reference",
      type: "proximity",
      time: new Date(300_000).toISOString(),
      level: "ORB",
      price: 101,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      candle: { openTime: 300_000, closeTime: 600_000, open: 100, high: 103, low: 99, close: 101, volume: 10 },
      detail: "Proximity reference.",
    }],
  });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [first, repeated], []);
  const pullbacks = occurrences.filter((occurrence) => occurrence.kind === "pullback");
  assert.equal(pullbacks.length, 1);
  assert.deepEqual(pullbacks[0]?.secondaryStrategyMatches, ["PATIENCE_CANDLE_CONTINUATION"]);
});

test("ledger does not turn a removed risk gate into a separate trade outcome", () => {
  const risk = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION", {
    id: "risk-audit",
    decision: "SETUP REJECTED — RISK",
    rejectionCategory: "RISK_REJECTION",
    rejectionReason: "risk budget",
    patienceState: "ENTRY_TRIGGERED",
  });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [risk], []);
  const riskOccurrence = occurrences.find((occurrence) => occurrence.kind === "risk");
  assert.equal(riskOccurrence, undefined);
  assert.equal(occurrences.some((occurrence) => occurrence.kind === "trade"), false);
});

test("ledger retains an expired patience attempt without inventing an E candle", () => {
  const expired = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION", {
    id: "expired-audit",
    patienceState: "PATIENCE_CANDLE_EXPIRED",
    patienceOccurrences: [{
      occurrenceId: "expired-p1",
      direction: "long",
      entryBufferTicks: 8,
      stopBufferTicks: 1,
      eligibilityReason: "pullback",
      eligibilityTime: 300_000,
      previousCandle: {
        openTime: 300_000,
        closeTime: 600_000,
        open: 100,
        high: 103,
        low: 99,
        close: 101,
        volume: 10,
        isComplete: true,
      },
      patienceCandle: {
        openTime: 600_000,
        closeTime: 900_000,
        open: 101,
        high: 102,
        low: 98,
        close: 100,
        volume: 11,
        isComplete: true,
      },
      triggerCandle: null,
      status: "PATIENCE_CANDLE_EXPIRED",
      reasonCode: "immediate E missing",
      evaluationCursor: 900_000,
    }],
  });
  const occurrence = buildHistoricalOccurrenceLedger(occurrenceDataset(), [expired], []).find((item) => item.kind === "patience");
  assert.ok(occurrence);
  assert.equal(occurrence.status, "IMMEDIATE_CONFIRMATION_FAILED");
  assert.equal(occurrence.entryCandle, null);
});

test("an empty causal evaluation produces no patience or trade ledger rows", () => {
  const audit = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION", {
    id: "no-patience-audit",
    patienceState: "WAITING_FOR_VALID_CONTEXT",
    patienceCandle: null,
    triggerCandle: null,
    pullbackOccurrences: [],
    patienceOccurrences: [],
  });
  assert.deepEqual(buildHistoricalOccurrenceLedger(occurrenceDataset(), [audit], []), []);
});

test("failed immediate confirmation remains a no-trade patience occurrence", () => {
  const failed = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION", {
    id: "failed-confirmation-audit",
    decision: "SETUP EXPIRED",
    rejectionCategory: "EXPIRED",
    patienceState: "PATIENCE_CANDLE_EXPIRED",
    patienceOccurrences: [{
      occurrenceId: "failed-p1",
      direction: "long",
      entryBufferTicks: 8,
      stopBufferTicks: 1,
      eligibilityReason: "pullback",
      eligibilityTime: 300_000,
      previousCandle: {
        openTime: 300_000,
        closeTime: 600_000,
        open: 100,
        high: 103,
        low: 99,
        close: 101,
        volume: 10,
        isComplete: true,
      },
      patienceCandle: {
        openTime: 600_000,
        closeTime: 900_000,
        open: 101,
        high: 102,
        low: 98,
        close: 100,
        volume: 11,
        isComplete: true,
      },
      triggerCandle: {
        openTime: 900_000,
        closeTime: 1_200_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 12,
        isComplete: true,
      },
      status: "PATIENCE_CANDLE_EXPIRED",
      reasonCode: "confirmation buffer not reached",
      evaluationCursor: 1_200_000,
    }],
  });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [failed], []);
  assert.ok(occurrences.some((occurrence) => occurrence.kind === "patience" && occurrence.status === "IMMEDIATE_CONFIRMATION_FAILED"));
  assert.equal(occurrences.some((occurrence) => occurrence.kind === "trade" || occurrence.kind === "risk"), false);
});

test("only the exact confirmed P2 to E2 occurrence inherits a qualified trade", () => {
  const base = occurrenceAudit("PATIENCE_CANDLE_CONTINUATION");
  const confirmed = base.patienceOccurrences![0]!;
  const previous = { openTime: 0, closeTime: 300_000, open: 99, high: 103, low: 98, close: 101, volume: 8, isComplete: true };
  const expiredPatience = { openTime: 300_000, closeTime: 600_000, open: 101, high: 102, low: 99, close: 101, volume: 9, isComplete: true };
  const failedImmediate = { openTime: 600_000, closeTime: 900_000, open: 101, high: 102.5, low: 100, close: 102, volume: 10, isComplete: true };
  const expired: NonNullable<BacktestAuditRecord["patienceOccurrences"]>[number] = {
    occurrenceId: "expired-p1",
    direction: "long",
    entryBufferTicks: 8,
    stopBufferTicks: 1,
    eligibilityReason: "pullback",
    eligibilityTime: 300_000,
    previousComparisonTimestamp: previous.openTime,
    candidateShapeResult: true,
    expectedEntryCandleOpenTime: failedImmediate.openTime,
    confirmationThreshold: 102.75,
    actualConfirmationExcursion: 0.5,
    previousCandle: previous,
    patienceCandle: expiredPatience,
    triggerCandle: failedImmediate,
    nextObservedCandle: failedImmediate,
    outcomeStatus: "EXPIRED_NO_IMMEDIATE_CONFIRMATION",
    status: "PATIENCE_CANDLE_EXPIRED",
    reasonCode: "10:10 failed to reach the eight-tick confirmation buffer.",
    evaluationCursor: failedImmediate.closeTime,
  };
  const audit = { ...base, patienceOccurrences: [expired, confirmed] };
  const linkedTrade = trade(25, {
    setupType: "PATIENCE_CANDLE_CONTINUATION",
    entryTime: base.triggerCandleCloseTime!,
    audit: {
      patienceCandleOpenTime: base.patienceCandleOpenTime,
      patienceCandleCloseTime: base.patienceCandleCloseTime,
      triggerCandleOpenTime: base.triggerCandleOpenTime,
      triggerCandleCloseTime: base.triggerCandleCloseTime,
    } as NonNullable<BacktestTrade["audit"]>,
  });
  const occurrences = buildHistoricalOccurrenceLedger(occurrenceDataset(), [audit], [linkedTrade]);
  const patience = occurrences.filter((occurrence) => occurrence.kind === "patience");
  assert.equal(patience.length, 2);
  assert.equal(patience[0]?.status, "IMMEDIATE_CONFIRMATION_FAILED");
  assert.equal(patience[0]?.entryTimestamp, null);
  assert.equal(patience[0]?.entryCandle, null);
  assert.equal(patience[0]?.nextObservedCandle?.openTime, failedImmediate.openTime);
  assert.equal(patience[0]?.canonicalTrade, false);
  assert.equal(patience[1]?.status, "SIGNAL_CONFIRMED");
  assert.equal(patience[1]?.entryTimestamp, base.triggerCandleOpenTime);
  assert.equal(patience[1]?.canonicalTrade, true);
});