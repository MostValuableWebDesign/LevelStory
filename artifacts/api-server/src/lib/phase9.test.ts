import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCausalVisibility,
  calculateBacktestMetrics,
  createCausalReplay,
  buildReplayIndexes,
  resolveEntryAndInvalidation,
  resolveIntrabarOutcome,
  buildHistoricalOccurrenceLedger,
  projectHistoricalTradeCandidates,
  type IntrabarBar,
  type BacktestTrade,
  type BacktestAuditRecord,
  type CausalReplayDataset,
} from "./phase9.js";
import type { SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { DEFAULT_FUTURES_SESSION_CALENDAR, newYorkTimeToUtc } from "./futures/session-calendar.js";
import { consolidationThresholds, DEFAULT_STRATEGY_CONFIG } from "./strategy/config.js";

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
    confirmationBufferTicks: 3,
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
      entryBufferTicks: 3,
      stopBufferTicks: 1,
      eligibilityReason: "pullback",
      eligibilityTime: lOpen,
      previousComparisonTimestamp: lCandle.openTime,
      candidateShapeResult: true,
      expectedEntryCandleOpenTime: eCandle.openTime,
      confirmationThreshold: 102.75,
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
  assert.equal(patience.confirmationBufferTicks, 3);
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
      entryBufferTicks: 3,
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
    levelInteractionTypes: {},
    confirmationBufferTicks: 1,
    nextObservedCandle: null,
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
    status: "SIGNAL_CONFIRMED",
    reasonCode: "Immediate next candle reached the confirmation buffer.",
    evaluationCursor: entryTimestamp,
    formulaVersion: "phase9-fixed-formula-v2",
    formulaHash: "formula-candidate-driven",
    sourceFingerprint: "source-candidate-driven",
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
  assert.equal(result.candidates[0]?.executionStatus, "MODELED_TRADE_CREATED");
  assert.equal(result.authoritativeTrades.length, 1);
  assert.equal(result.authoritativeTrades[0]?.candidateId, result.candidates[0]?.candidateId);
  assert.equal(result.authoritativeTrades[0]?.signalOccurrenceId, occurrence.occurrenceId);
  assert.equal(result.authoritativeTrades[0]?.fillLabel, "OHLCV_CONFIRMATION_THRESHOLD");
  assert.equal(result.authoritativeTrades[0]?.entryPrice, 101.25);
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
      entryBufferTicks: 3,
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
      entryBufferTicks: 4,
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
    entryBufferTicks: 3,
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
    reasonCode: "10:10 failed to reach the three-tick confirmation buffer.",
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