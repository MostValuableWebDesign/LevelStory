import assert from "node:assert/strict";
import test from "node:test";
import { buildReplayDataset, resolveIntrabarOutcome, runCausalBacktest } from "./phase9.js";
import { createMarketSnapshot } from "./market-data.js";
import { generateSimulatedFuturesFeed, type SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { getFuturesContractSpecification } from "./futures/contracts.js";
import { listTradingDates, sessionCalendarForContract, sessionWindow, tradingDateForTimestamp } from "./futures/session-calendar.js";
import { strategyConfig } from "./strategy/config.js";
import { evaluateOrbBreakoutQuality } from "./strategy/phase4.js";
import { patienceCandleEngine } from "./strategy/phase5.js";
import { buildPhase7RiskPlan, type Phase7RiskConfig } from "./strategy/phase7.js";
import { simulatePhase8ShadowExecution } from "./strategy/phase8.js";

const specification = getFuturesContractSpecification("MES");
const calendar = sessionCalendarForContract(specification);
const FIVE_MINUTES = 5 * 60_000;

function scenarioSnapshot(seed: number) {
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-25",
    days: 3,
    seed,
    includePremarket: true,
    premarketAvailable: true,
  });
  const window = sessionWindow("2026-08-25", "regular", calendar)!;
  const regular = source.filter((candle) => candle.openTime >= window.openTime && candle.openTime < window.closeTime);
  const candles = source.map((candle) => {
    if (candle.openTime !== regular[36]?.openTime) return candle;
    return seed === 11
      ? { ...candle, high: candle.high + 0.75, close: candle.high + 0.75 }
      : { ...candle, low: candle.low - 0.75, close: candle.low - 0.75 };
  });
  return createMarketSnapshot(
    "MES",
    "regular",
    undefined,
    undefined,
    { targetDollars: 75, slippageMode: "normal" },
    {
      tradingDate: "2026-08-25",
      cursor: regular[36].closeTime,
      allCandles: candles,
      historicalFeed: candles,
      premarketAvailable: true,
    },
  );
}

function scenarioDataset(seed: number, startDate: string, days: number) {
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate,
    days,
    seed,
    includePremarket: true,
    premarketAvailable: true,
  });
  const dates = [...new Set(source.map((item) => tradingDateForTimestamp(item.openTime, calendar)))];
  const dataset = {
    candles: source,
    contractSymbol: specification.fullContractSymbol,
    contractMonth: specification.contractMonth,
    inSampleDates: dates.slice(0, Math.max(1, dates.length - 1)),
    outOfSampleDates: dates.slice(-1),
  };
  const regularByDate = new Map<string, typeof dataset.candles>();
  for (const item of dataset.candles) {
    const date = tradingDateForTimestamp(item.openTime, calendar);
    const window = sessionWindow(date, "regular", calendar);
    if (window !== null && item.openTime >= window.openTime && item.openTime < window.closeTime) {
      const rows = regularByDate.get(date) ?? [];
      rows.push(item);
      regularByDate.set(date, rows);
    }
  }
  const triggers = new Set(Array.from(regularByDate.values()).map((regular) => regular[36]?.openTime).filter((time): time is number => time !== undefined));
  if (triggers.size === 0) throw new Error("Scenario fixture did not contain its immediate E candle.");
  const candles = dataset.candles.map((item) => !triggers.has(item.openTime)
    ? item
    : seed === 11
      ? { ...item, high: item.high + 0.75, close: item.high + 0.75 }
      : { ...item, low: item.low - 0.75, close: item.low - 0.75 });
  return { ...dataset, candles };
}

type DirectFixtureKind = "consolidation" | "reversal";

function directProductionFixture(kind: DirectFixtureKind, direction: "long" | "short") {
  const tradingDate = "2026-08-25";
  const seed = direction === "long" ? 11 : 12;
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: tradingDate,
    days: kind === "reversal" ? 6 : 1,
    seed,
    includePremarket: true,
    premarketAvailable: true,
  });
  const regularWindow = sessionWindow(tradingDate, "regular", calendar)!;
  const regular = source.filter((item) =>
    tradingDateForTimestamp(item.openTime, calendar) === tradingDate
    && item.openTime >= regularWindow.openTime
    && item.openTime < regularWindow.closeTime,
  );
  const signalIndex = kind === "reversal" ? 37 : 40;
  const base = regular[25]!.close;
  const orbHigh = Math.max(...regular.slice(0, 3).map((item) => item.high));
  const orbLow = Math.min(...regular.slice(0, 3).map((item) => item.low));
  const candles = source.map((item) => {
    const index = regular.findIndex((candidate) => candidate.openTime === item.openTime);
    if (kind === "consolidation" && index === 3) {
      return direction === "long"
        ? {
          ...item,
          open: orbHigh + 0.25,
          high: orbHigh + 1,
          low: orbHigh + 0.25,
          close: orbHigh + 0.75,
          volume: 2_000,
        }
        : {
          ...item,
          open: orbLow - 0.25,
          high: orbLow - 0.25,
          low: orbLow - 1,
          close: orbLow - 0.75,
          volume: 2_000,
        };
    }
    if (kind === "consolidation" && index >= 25 && index < signalIndex) {
      return {
        ...item,
        open: base,
        high: base + 0.75,
        low: base - 0.75,
        close: base + (index % 2 ? 0.25 : -0.25),
        volume: 1_000,
        bid: base,
        ask: base + specification.tickSize,
      };
    }
    if (kind === "consolidation" && index === signalIndex) {
      return direction === "long"
        ? {
          ...item,
          open: base + 0.25,
          high: base + 2.75,
          low: base + 0.25,
          close: base + 0.5,
          volume: 2_000,
          bid: base,
          ask: base + specification.tickSize,
        }
        : {
          ...item,
          open: base - 0.25,
          high: base - 0.25,
          low: base - 2.75,
          close: base - 0.5,
          volume: 2_000,
          bid: base - specification.tickSize,
          ask: base,
        };
    }
    if (kind === "reversal" && index >= 0 && index < signalIndex) {
      const trendBase = direction === "short"
        ? 6770 + index * 0.5
        : 6830 - index * 0.5;
      return direction === "short"
        ? {
          ...item,
          open: trendBase,
          high: trendBase + 0.5,
          low: trendBase - 0.1,
          close: trendBase + 0.5,
          volume: 1_000,
        }
        : {
          ...item,
          open: trendBase,
          high: trendBase + 0.1,
          low: trendBase - 0.5,
          close: trendBase - 0.5,
          volume: 1_000,
        };
    }
    if (kind === "reversal" && index === signalIndex) {
      return direction === "short"
        ? { ...item, open: 6_807.5, high: 6_808.5, low: 6_807.5, close: 6_808.5, volume: 1_000 }
        : { ...item, open: 6_808.25, high: 6_808.5, low: 6_807.25, close: 6_807.25, volume: 1_000 };
    }
    if (kind === "reversal" && index === signalIndex + 1) {
      return direction === "short"
        ? { ...item, open: 6_808.5, high: 6_808.5, low: 6_807.5, close: 6_807.5, volume: 1_000 }
        : { ...item, open: 6_807.25, high: 6_808.25, low: 6_807.25, close: 6_808.25, volume: 1_000 };
    }
    if (kind === "reversal" && index === signalIndex + 2) {
      return direction === "short"
        ? { ...item, open: 6_807.5, high: 6_808, low: 6_805.5, close: 6_805.5, volume: 2_000 }
        : { ...item, open: 6_808.25, high: 6_810.25, low: 6_808, close: 6_810.25, volume: 2_000 };
    }
    return item;
  });
  const signalCandle = regular[signalIndex]!;
  const entryCandle = kind === "reversal" ? regular[signalIndex + 2]! : signalCandle;
  const entryThreshold = kind === "consolidation"
    ? direction === "long" ? base + 2.75 : base - 2.75
    : direction === "short" ? 6_805.5 : 6_810.25;
  const ticks = [{
    timestamp: entryCandle.openTime + 60_000,
    price: entryThreshold,
    source: "tick" as const,
  }, {
    timestamp: entryCandle.openTime + 120_000,
    price: direction === "long" ? entryThreshold + 0.25 : entryThreshold - 0.25,
    source: "tick" as const,
  }];
  const dates = [...new Set(source.map((item) => tradingDateForTimestamp(item.openTime, calendar)))];
  const enabledStrategies = {
    ORB_PULLBACK_CONTINUATION: false,
    EARLY_ORB_MOMENTUM_CONTINUATION: false,
    CONSOLIDATION_BREAKOUT_CONTINUATION: kind === "consolidation",
    EQUIVALENT_CANDLE_REVERSAL: kind === "reversal",
    PATIENCE_CANDLE_CONTINUATION: false,
    PEAK_RETRACEMENT_REVERSAL: false,
  };
  return {
    request: {
      symbol: "MES",
      startDate: tradingDate,
      endDate: tradingDate,
      inSampleDays: Math.max(1, dates.length - 1),
      outOfSampleDays: dates.length > 1 ? 1 : 0,
      executionMode: "ohlcv_modeled" as const,
      premarketAvailable: true,
      visualReviewEnabledStrategies: enabledStrategies,
      ...(kind === "reversal"
        ? { strategyConfigOverride: strategyConfig({ trendCandleCount: 3, emaPeriod: 5, emaSlopeWindow: 5 }) }
        : {}),
    },
    dataset: {
      source: "historical_databento" as const,
      contractSymbol: specification.fullContractSymbol,
      contractMonth: specification.contractMonth,
      candles,
      ticks,
      orderedIntrabarEvidence: {
        source: "tick" as const,
        contractSymbol: specification.fullContractSymbol,
        ordering: "timestamp_ascending" as const,
        equalTimestampSemantics: "conservative" as const,
        coverageStart: entryCandle.openTime,
        coverageEnd: entryCandle.closeTime,
      },
      orderedIntrabarEvidenceComplete: true,
      inSampleDates: dates.slice(0, -1),
      outOfSampleDates: dates.slice(-1),
      selectedDates: [tradingDate],
    },
  };
}

function candle(index: number, open: number, high: number, low: number, close: number, volume = 100, isComplete = true): SimulatedFuturesCandle {
  const openTime = index * FIVE_MINUTES;
  return {
    timestamp: openTime,
    openTime,
    closeTime: openTime + FIVE_MINUTES,
    open,
    high,
    low,
    close,
    volume,
    bid: close - specification.tickSize,
    ask: close,
    bidSize: 10,
    askSize: 10,
    contractSymbol: specification.fullContractSymbol,
    isComplete,
  };
}

function riskConfig(overrides: Partial<Phase7RiskConfig> = {}): Phase7RiskConfig {
  return {
    riskDollars: 100,
    dailyLossLimit: 500,
    dailyLossUsed: 0,
    tradesToday: 0,
    maxTradesPerDay: 1,
    maxContracts: 10,
    maxPositionValue: 100_000,
    maximumSpreadTicks: specification.maximumSpreadTicks,
    minimumLiquidity: specification.minimumLiquidity,
    staleDataSeconds: 15,
    dataAgeSeconds: 0,
    observedSpreadTicks: 1,
    liquidity: specification.minimumLiquidity,
    emergencyKillSwitch: false,
    duplicateEntry: false,
    averagingDown: false,
    normalSlippageTicks: 1,
    fastSlippageTicks: 2,
    slippageMode: "normal",
    targetDollars: 75,
    ...overrides,
  };
}

test("deterministic bullish and bearish A+ fixtures qualify with the governed entry and stop buffers", () => {
  for (const [seed, direction] of [[11, "long"], [12, "short"]] as const) {
    const snapshot = scenarioSnapshot(seed);
    assert.equal(snapshot.setupAnalysis.decision, "SETUP QUALIFIED", `seed ${seed}`);
    assert.equal(snapshot.setupAnalysis.primarySetup, "ORB_PULLBACK_CONTINUATION", `seed ${seed}`);
    assert.equal(snapshot.riskPlan.allowed, true, `seed ${seed}`);
    assert.equal(snapshot.riskPlan.direction, direction, `seed ${seed}`);
    assert.equal(snapshot.shadowExecution?.contracts, 1, `seed ${seed}`);

    assert.equal(snapshot.patience.entryBufferTicks, 4, `seed ${seed}`);
    assert.equal(snapshot.patience.stopBufferTicks, 8, `seed ${seed}`);
    const patienceCandle = snapshot.patience.patienceCandle;
    assert.ok(patienceCandle, `seed ${seed} must expose P`);
    assert.equal(snapshot.patience.strategyStopPrice,
      direction === "long"
        ? patienceCandle.low - 8 * specification.tickSize
        : patienceCandle.high + 8 * specification.tickSize,
      `seed ${seed}`);
  }
});

test("raw direct-strategy fixtures reach audit, occurrence, candidate, execution, and account arbitration", () => {
  for (const kind of ["consolidation", "reversal"] as const) {
    for (const direction of ["long", "short"] as const) {
      const fixture = directProductionFixture(kind, direction);
      const report = runCausalBacktest(fixture.request, undefined, fixture.dataset);
      const setupType = kind === "consolidation"
        ? "CONSOLIDATION_BREAKOUT_CONTINUATION"
        : "EQUIVALENT_CANDLE_REVERSAL";
      const qualifiedAudit = report.audit.find((record) =>
        record.setupType === setupType
        && record.direction === direction
        && record.decision === "SETUP QUALIFIED");
      assert.ok(qualifiedAudit, `${kind} ${direction} must qualify from a raw snapshot`);
      const occurrence = report.occurrences.find((item) =>
        item.strategyCandidate === setupType
        && item.direction === direction
        && item.status === "SIGNAL_CONFIRMED");
      assert.ok(occurrence, `${kind} ${direction} must create a confirmed causal occurrence`);
      const candidate = report.tradeCandidates.find((item) =>
        item.signalOccurrenceId === occurrence?.occurrenceId
        && item.primaryEdge === setupType);
      assert.ok(candidate, `${kind} ${direction} must project a candidate`);
      assert.equal(candidate?.executionStatus, "MODELED_TRADE_CREATED");
      assert.equal(candidate?.accountEntryStatus, "ENTERED");
      assert.ok(
        report.candidateExecutionEvidence?.some((trade) =>
          trade.candidateId === candidate?.candidateId
          && trade.signalOccurrenceId === occurrence?.occurrenceId
          && trade.primaryEdge === setupType),
        `${kind} ${direction} must emit candidate-owned execution evidence`,
      );
      assert.ok(
        report.trades.some((trade) =>
          trade.candidateId === candidate?.candidateId
          && trade.signalOccurrenceId === occurrence?.occurrenceId
          && trade.primaryEdge === setupType
          && trade.direction === direction),
        `${kind} ${direction} must produce an authoritative trade`,
      );
      assert.ok(occurrence?.directSignalOpenTimestamp,
        `${kind} ${direction} must retain the direct signal candle identity`);
      if (kind === "reversal") {
        assert.equal(occurrence?.directSignalOpenTimestamp,
          qualifiedAudit?.evaluatedCandleOpenTime,
          `${kind} ${direction} must retain the direct signal candle identity`);
        assert.equal(occurrence?.eOpenTimestamp,
          new Date(Date.parse(qualifiedAudit?.evaluatedCandleOpenTime ?? "") + FIVE_MINUTES).toISOString(),
          `${kind} ${direction} must use the immediate next candle`);
      } else {
        assert.equal(occurrence?.eOpenTimestamp,
          occurrence?.directSignalOpenTimestamp,
          `${kind} ${direction} must enter on the completed breakout candle`);
        assert.equal(occurrence?.directCrossingCandleOpenTimestamp,
          occurrence?.directSignalOpenTimestamp,
          `${kind} ${direction} must preserve the physical crossing candle`);
        assert.ok(occurrence?.directConsolidationStartTimestamp);
        assert.ok(occurrence?.directConsolidationEndTimestamp);
        assert.ok(occurrence?.directConsolidationCrossingIdentity);
        assert.equal(candidate?.causalIdentity.directConsolidationCrossingIdentity,
          occurrence?.directConsolidationCrossingIdentity);
      }
      assert.equal(candidate?.confirmationBufferTicks, 8);
      assert.equal(candidate?.entryReachedThreshold, true);
      assert.ok(candidate?.strategyStopPrice !== null && Number.isFinite(candidate?.strategyStopPrice));
      assert.ok(candidate?.targetDisposition);
      if (kind === "consolidation") {
        const causalTrendSource = qualifiedAudit?.causalTrendSource;
        assert.equal(qualifiedAudit?.causalTrendDirection, direction);
        assert.ok(causalTrendSource === "ORB_TREND" || causalTrendSource === "BREAKOUT_DIRECTION");
        assert.ok(qualifiedAudit?.causalTrendTimestamp);
        assert.equal(occurrence?.causalTrendDirection, direction);
        assert.equal(occurrence?.causalTrendSource, causalTrendSource);
        assert.equal(occurrence?.causalTrendTimestamp, qualifiedAudit?.causalTrendTimestamp);
        assert.equal(candidate?.causalTrendDirection, direction);
        assert.equal(candidate?.causalTrendSource, causalTrendSource);
        assert.equal(candidate?.causalTrendTimestamp, occurrence?.causalTrendTimestamp);
        assert.equal(candidate?.causalIdentity.causalTrendDirection, direction);
        assert.equal(candidate?.causalIdentity.causalTrendSource, causalTrendSource);
        assert.equal(candidate?.causalIdentity.causalTrendTimestamp, occurrence?.causalTrendTimestamp);
        assert.equal(candidate?.managementContext?.causalTrendTimestamp, occurrence?.causalTrendTimestamp);
        const execution = report.candidateExecutionEvidence?.find((trade) => trade.candidateId === candidate?.candidateId);
        assert.equal(execution?.causalIdentity?.causalTrendTimestamp, occurrence?.causalTrendTimestamp);
      }
    }
  }
});

test("a reversal expires the real prior-epoch arm and pending candidate at the confirming boundary", () => {
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-25",
    days: 1,
    seed: 11,
    includePremarket: true,
    premarketAvailable: true,
  });
  const window = sessionWindow("2026-08-25", "regular", calendar)!;
  const regular = source.filter((candle) =>
    candle.openTime >= window.openTime && candle.openTime < window.closeTime);
  const beforeReversal = createMarketSnapshot(
    "MES",
    "regular",
    undefined,
    undefined,
    { targetDollars: 75, slippageMode: "normal" },
    {
      tradingDate: "2026-08-25",
      cursor: regular[35].closeTime,
      allCandles: source,
      historicalFeed: source,
      premarketAvailable: true,
    },
  );
  const priorArmId = beforeReversal.pullback.armId;
  const pendingCandidateId = beforeReversal.patience.occurrences?.find(
    (occurrence) => occurrence.outcomeStatus === "CANDIDATE",
  )?.occurrenceId;
  assert.equal(beforeReversal.pullback.armState, "PATIENCE_ARMED");
  assert.ok(priorArmId);
  assert.ok(pendingCandidateId);

  const reversalCandles = source.map((candle) =>
    candle.openTime !== regular[36].openTime
      ? candle
      : { ...candle, open: 6798, high: 6798.5, low: 6797.5, close: 6798 });
  const afterReversal = createMarketSnapshot(
    "MES",
    "regular",
    undefined,
    undefined,
    { targetDollars: 75, slippageMode: "normal" },
    {
      tradingDate: "2026-08-25",
      cursor: regular[36].closeTime,
      allCandles: reversalCandles,
      historicalFeed: reversalCandles,
      premarketAvailable: true,
    },
  );
  const reversal = afterReversal.orbTrend.transitions.at(-1);
  assert.equal(reversal?.direction, "short");
  assert.equal(reversal?.expirationReason, "ORB_TREND_REVERSED");
  assert.equal(reversal?.expiredArmIds.includes(priorArmId!), true);
  assert.equal(reversal?.expiredCandidateIds.includes(pendingCandidateId!), true);
  const matchingOccurrences = afterReversal.patience.occurrences?.filter(
    (occurrence) => occurrence.occurrenceId === pendingCandidateId,
  ) ?? [];
  assert.equal(matchingOccurrences.length, 1);
  assert.notEqual(matchingOccurrences[0]?.outcomeStatus, "CONFIRMED");
});

test("an ORB reversal candle that reaches the prior threshold at open confirms the prior-epoch occurrence", () => {
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-25",
    days: 1,
    seed: 11,
    includePremarket: true,
    premarketAvailable: true,
  });
  const window = sessionWindow("2026-08-25", "regular", calendar)!;
  const regular = source.filter((candle) =>
    candle.openTime >= window.openTime && candle.openTime < window.closeTime);
  const beforeReversal = createMarketSnapshot(
    "MES",
    "regular",
    undefined,
    undefined,
    { targetDollars: 75, slippageMode: "normal" },
    {
      tradingDate: "2026-08-25",
      cursor: regular[35].closeTime,
      allCandles: source,
      historicalFeed: source,
      premarketAvailable: true,
    },
  );
  const priorCandidate = beforeReversal.patience.occurrences?.find(
    (occurrence) => occurrence.outcomeStatus === "CANDIDATE",
  );
  assert.ok(priorCandidate?.confirmationThreshold);
  assert.ok(beforeReversal.orbTrend.finalizedOrbLow !== null);
  const reversalBoundary = beforeReversal.orbTrend.finalizedOrbLow!
    - beforeReversal.orbTrend.confirmationBufferPoints
    - specification.tickSize;
  const threshold = priorCandidate!.confirmationThreshold!;
  const reversalCandles = source.map((candle) =>
    candle.openTime !== regular[36].openTime
      ? candle
      : {
        ...candle,
        open: threshold,
        high: threshold + specification.tickSize,
        low: reversalBoundary - specification.tickSize,
        close: reversalBoundary - specification.tickSize,
        bid: reversalBoundary - 2 * specification.tickSize,
        ask: reversalBoundary - specification.tickSize,
      });
  const afterReversal = createMarketSnapshot(
    "MES",
    "regular",
    undefined,
    undefined,
    { targetDollars: 75, slippageMode: "normal" },
    {
      tradingDate: "2026-08-25",
      cursor: regular[36].closeTime,
      allCandles: reversalCandles,
      historicalFeed: reversalCandles,
      premarketAvailable: true,
    },
  );
  const matchingOccurrences = afterReversal.patience.occurrences?.filter(
    (occurrence) => occurrence.occurrenceId === priorCandidate!.occurrenceId,
  ) ?? [];
  const reversal = afterReversal.orbTrend.transitions.at(-1);
  assert.equal(matchingOccurrences.length, 1);
  assert.equal(matchingOccurrences[0]?.outcomeStatus, "CONFIRMED");
  assert.equal(matchingOccurrences[0]?.qualificationStatus, "SIGNAL_CONFIRMED");
  assert.equal(afterReversal.patience.state, "ENTRY_TRIGGERED");
  assert.equal(reversal?.expiredCandidateIds.includes(priorCandidate!.occurrenceId), false);
  assert.equal(
    matchingOccurrences.some((occurrence) => occurrence.outcomeStatus === "CONFIRMED"
      && reversal?.expiredCandidateIds.includes(occurrence.occurrenceId)),
    false,
  );
});

test("an ORB reversal candle that reaches the prior threshold only intrabar is retained as ambiguous", () => {
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-25",
    days: 1,
    seed: 11,
    includePremarket: true,
    premarketAvailable: true,
  });
  const window = sessionWindow("2026-08-25", "regular", calendar)!;
  const regular = source.filter((candle) =>
    candle.openTime >= window.openTime && candle.openTime < window.closeTime);
  const beforeReversal = createMarketSnapshot(
    "MES",
    "regular",
    undefined,
    undefined,
    { targetDollars: 75, slippageMode: "normal" },
    {
      tradingDate: "2026-08-25",
      cursor: regular[35].closeTime,
      allCandles: source,
      historicalFeed: source,
      premarketAvailable: true,
    },
  );
  const priorCandidate = beforeReversal.patience.occurrences?.find(
    (occurrence) => occurrence.outcomeStatus === "CANDIDATE",
  );
  assert.ok(priorCandidate?.confirmationThreshold);
  assert.ok(beforeReversal.orbTrend.finalizedOrbLow !== null);
  const reversalBoundary = beforeReversal.orbTrend.finalizedOrbLow!
    - beforeReversal.orbTrend.confirmationBufferPoints
    - specification.tickSize;
  const threshold = priorCandidate!.confirmationThreshold!;
  const reversalCandles = source.map((candle) =>
    candle.openTime !== regular[36].openTime
      ? candle
      : {
        ...candle,
        open: threshold - specification.tickSize,
        high: threshold + specification.tickSize,
        low: reversalBoundary - specification.tickSize,
        close: reversalBoundary - specification.tickSize,
        bid: reversalBoundary - 2 * specification.tickSize,
        ask: reversalBoundary - specification.tickSize,
      });
  const afterReversal = createMarketSnapshot(
    "MES",
    "regular",
    undefined,
    undefined,
    { targetDollars: 75, slippageMode: "normal" },
    {
      tradingDate: "2026-08-25",
      cursor: regular[36].closeTime,
      allCandles: reversalCandles,
      historicalFeed: reversalCandles,
      premarketAvailable: true,
    },
  );
  const matchingOccurrences = afterReversal.patience.occurrences?.filter(
    (occurrence) => occurrence.occurrenceId === priorCandidate!.occurrenceId,
  ) ?? [];
  assert.equal(matchingOccurrences.length, 1);
  assert.equal(matchingOccurrences[0]?.status, "AMBIGUOUS_EVENT_ORDER");
  assert.equal(matchingOccurrences[0]?.outcomeStatus, "INVALIDATED");
  assert.equal(matchingOccurrences[0]?.qualificationStatus, "STRUCTURALLY_INVALIDATED");
  assert.equal(afterReversal.patience.state, "AMBIGUOUS_EVENT_ORDER");
  assert.equal(matchingOccurrences.some((occurrence) => occurrence.outcomeStatus === "CONFIRMED"), false);
});

test("deterministic modeled lifecycles start management after E and use the buffered P extreme", () => {
  const longStop = 6972.75;
  const longRevisit = simulatePhase8ShadowExecution({
    direction: "long",
    entryQuote: { bid: 6977.75, ask: 6978.25 },
    exitQuote: { bid: 6975.5, ask: 6975.75 },
    entryReferencePrice: 6978,
    currentPrice: 6975.75,
    low: 6975.75,
    strategyStop: longStop,
    catastropheStop: 6972.5,
    target: 7000,
    contracts: 1,
    specification,
  });
  assert.notEqual(longRevisit.exitReason, "strategy stop");
  const longExit = simulatePhase8ShadowExecution({
    direction: "long",
    entryQuote: { bid: 6977.75, ask: 6978.25 },
    exitQuote: { bid: 6973.5, ask: 6973.75 },
    entryReferencePrice: 6978,
    currentPrice: longStop,
    low: longStop,
    strategyStop: longStop,
    catastropheStop: 6972.5,
    target: 7000,
    contracts: 1,
    specification,
  });
  assert.equal(longExit.exitReason, "strategy stop");
  assert.equal(longExit.stop, "strategy");
  assert.equal(longExit.exitFillPrice, 6973.25);

  const shortStop = 6983.25;
  const shortRevisit = simulatePhase8ShadowExecution({
    direction: "short",
    entryQuote: { bid: 6978.25, ask: 6978.75 },
    exitQuote: { bid: 6982.25, ask: 6982.75 },
    entryReferencePrice: 6978.5,
    currentPrice: 6979.5,
    high: 6980.25,
    strategyStop: shortStop,
    catastropheStop: 6983.5,
    target: 6950,
    contracts: 1,
    specification,
  });
  assert.notEqual(shortRevisit.exitReason, "strategy stop");
  const shortExit = simulatePhase8ShadowExecution({
    direction: "short",
    entryQuote: { bid: 6978.25, ask: 6978.75 },
    exitQuote: { bid: 6982.25, ask: 6982.75 },
    entryReferencePrice: 6978.5,
    currentPrice: shortStop,
    high: shortStop,
    strategyStop: shortStop,
    catastropheStop: 6983.5,
    target: 6950,
    contracts: 1,
    specification,
  });
  assert.equal(shortExit.exitReason, "strategy stop");
  assert.equal(shortExit.stop, "strategy");
});

test("public decision surfaces project the same phased Phase 4–8 evaluation", () => {
  const snapshot = scenarioSnapshot(11);
  const selected = snapshot.setupAnalysis.evaluations.find((evaluation) =>
    evaluation.setupType === snapshot.setupAnalysis.primarySetup,
  )!;
  const signal = (key: "orb" | "pullback" | "patience" | "volume") =>
    snapshot.signals.find((item) => item.key === key)!;

  assert.equal(selected.decision, "SETUP QUALIFIED");
  assert.equal(snapshot.setupAnalysis.decision, selected.decision);
  assert.equal(snapshot.decision.state, selected.decision);
  assert.deepEqual(
    snapshot.decision.passedRules.map((rule) => rule.key),
    selected.rules.filter((rule) => rule.passed).map((rule) => rule.key),
  );
  assert.deepEqual(
    snapshot.decision.failedRules.map((rule) => rule.key),
    selected.rules.filter((rule) => !rule.passed).map((rule) => rule.key),
  );
  assert.equal(signal("orb").status, "confirmed");
  assert.equal(signal("orb").detail, snapshot.breakout.detail);
  assert.equal(signal("pullback").status, "confirmed");
  assert.equal(signal("pullback").detail, snapshot.pullback.detail);
  assert.equal(signal("patience").status, "confirmed");
  assert.equal(signal("patience").detail, snapshot.patience.detail);
  assert.equal(signal("volume").status, "confirmed");
  assert.equal(snapshot.riskPlan.direction, selected.direction);
  assert.equal(snapshot.riskPlan.allowed, true);
  assert.equal(snapshot.shadowExecution?.entryQuoteSide, snapshot.riskPlan.direction === "long" ? "ask" : "bid");
  assert.equal(snapshot.shadowExecution?.contracts, snapshot.riskPlan.contracts);
});

test("causal fixture matrix preserves weak-probe rejection, patience rejects, ambiguous OHLC, risk rejection, target, and runner exits", () => {
  const ntz = { high: 102, low: 99, complete: true, completedAt: candle(2, 100, 102, 99, 101).closeTime };
  const weakProbe = evaluateOrbBreakoutQuality([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101.5, 99.5, 100.5),
    candle(2, 100.5, 102, 99, 101),
    candle(3, 101, 102.2, 100.5, 101.5),
  ], ntz, strategyConfig(), specification);
  assert.equal(weakProbe.detected, false);
  assert.equal(weakProbe.state, "ORB_PROBE_WAIT");

  const eligibility = [{ time: FIVE_MINUTES, reason: "pullback" as const, detail: "Retest reached a qualifying level." }];
  const patienceBase = [candle(0, 10, 12, 8, 10.5), candle(1, 10.5, 11, 7, 10.8)];
  const expired = patienceCandleEngine([
    ...patienceBase,
    candle(2, 10.8, 11.2, 10.1, 10.4),
    candle(4, 10.4, 12.2, 10.1, 12.1),
  ], "long", { eligibilityEvents: eligibility, tickSize: 0.25 });
  assert.equal(expired.state, "PATIENCE_CANDLE_EXPIRED");

  const opposite = patienceCandleEngine([
    ...patienceBase,
    candle(2, 8.8, 10.5, 6.5, 8, 100, false),
  ], "long", { eligibilityEvents: eligibility, tickSize: 0.25 });
  assert.equal(opposite.state, "TRIGGER_CANDLE_ACTIVE");

  const ambiguous = resolveIntrabarOutcome({
    direction: "long",
    target: 104,
    stop: 96,
    candle: candle(1, 100, 105, 95, 101),
    oneMinute: [{
      openTime: FIVE_MINUTES,
      closeTime: FIVE_MINUTES + 60_000,
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

  const denied = buildPhase7RiskPlan(6800, "long", 6799.75, 6799.5, riskConfig({ riskDollars: 5.34 }), specification);
  assert.equal(denied.allowed, false);
  assert.equal(denied.contracts, 0);

  const target = simulatePhase8ShadowExecution({
    direction: "long",
    entryQuote: { bid: 6799.75, ask: 6800.25 },
    exitQuote: { bid: 6815.25, ask: 6815.75 },
    entryReferencePrice: 6800,
    currentPrice: 6815,
    contracts: 1,
    target: 6815,
    specification,
  });
  assert.equal(target.exitReason, "target");
  assert.equal(target.entryFillPrice, 6800.5);
  assert.equal(target.exitFillPrice, 6815);
  assert.deepEqual(target.accounting, { grossPnl: 72.5, slippage: 2.5, fees: 1.6, netPnl: 70.9 });

  const strategyStop = simulatePhase8ShadowExecution({
    direction: "long",
    entryQuote: { bid: 6799.75, ask: 6800.25 },
    exitQuote: { bid: 6797.75, ask: 6798.25 },
    entryReferencePrice: 6800,
    exitReferencePrice: 6798,
    currentPrice: 6798,
    high: 6800,
    low: 6798,
    contracts: 1,
    strategyStop: 6798,
    catastropheStop: 6797.5,
    specification,
  });
  assert.equal(strategyStop.stop, "strategy");
  assert.equal(strategyStop.exitReason, "strategy stop");
  assert.equal(strategyStop.entryFillPrice, 6800.5);
  assert.equal(strategyStop.exitFillPrice, 6797.5);
  assert.deepEqual(strategyStop.accounting, { grossPnl: -15, slippage: 12.5, fees: 1.6, netPnl: -16.6 });
  assert.equal(strategyStop.legs.length, 1);

  const runner = simulatePhase8ShadowExecution({
    direction: "long",
    entryQuote: { bid: 6799.75, ask: 6800.25 },
    exitQuote: { bid: 6815.25, ask: 6815.75 },
    entryReferencePrice: 6800,
    currentPrice: 6809,
    high: 6815,
    low: 6799,
    contracts: 2,
    targetContracts: 1,
    runnerContracts: 1,
    target: 6815,
    runnerReferencePrice: 6800,
    runnerImpulse: 15,
    runnerMostFavorablePrice: 6815,
    specification,
  });
  assert.equal(runner.exitReason, "runner");
  assert.equal(runner.runnerExited, true);
  assert.deepEqual(runner.legs.map((leg) => ({
    kind: leg.kind,
    contracts: leg.contracts,
    grossPnl: leg.grossPnl,
    slippage: leg.slippage,
    fees: leg.fees,
    netPnl: leg.netPnl,
  })), [
    { kind: "target", contracts: 1, grossPnl: 72.5, slippage: 2.5, fees: 1.6, netPnl: 70.9 },
    { kind: "runner", contracts: 1, grossPnl: 72.5, slippage: 2.5, fees: 1.6, netPnl: 70.9 },
  ]);
  assert.deepEqual(runner.accounting, { grossPnl: 145, slippage: 5, fees: 3.2, netPnl: 141.8 });
});