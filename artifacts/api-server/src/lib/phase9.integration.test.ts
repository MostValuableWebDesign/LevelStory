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
import { buildHistoricalVisualValidationSetFromReport } from "./visual-validation.js";

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
  const signalIndex = kind === "reversal" ? 37 : 29;
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
        coverageStart: 0,
        coverageEnd: Number.MAX_SAFE_INTEGER,
      },
      orderedIntrabarEvidenceComplete: true,
      inSampleDates: dates.slice(0, -1),
      outOfSampleDates: dates.slice(-1),
      selectedDates: [tradingDate],
    },
  };
}

function orbContinuationProductionFixture(direction: "long" | "short") {
  const tradingDate = "2026-08-25";
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: tradingDate,
    days: 1,
    seed: direction === "long" ? 11 : 12,
    includePremarket: true,
    premarketAvailable: true,
  });
  const regularWindow = sessionWindow(tradingDate, "regular", calendar)!;
  const regular = source.filter((item) =>
    tradingDateForTimestamp(item.openTime, calendar) === tradingDate
    && item.openTime >= regularWindow.openTime
    && item.openTime < regularWindow.closeTime,
  );
  const candles = source.map((item) => {
    const index = regular.findIndex((candidate) => candidate.openTime === item.openTime);
    if (index < 3 || index > 9) return item;
    const template = regular[index + 27];
    if (!template) return item;
    const moved = {
      ...item,
      open: template.open,
      high: template.high,
      low: template.low,
      close: template.close,
      volume: template.volume,
      bid: template.bid,
      ask: template.ask,
    };
    if (index !== 9) return moved;
    return direction === "long"
      ? { ...moved, high: template.high + 0.75, close: template.high + 0.75, volume: 2_000 }
      : { ...moved, low: template.low - 0.75, close: template.low - 0.75, volume: 2_000 };
  });
  return {
    request: {
      symbol: "MES",
      startDate: tradingDate,
      endDate: tradingDate,
      inSampleDays: 1,
      outOfSampleDays: 0,
      executionMode: "ohlcv_modeled" as const,
      premarketAvailable: true,
      visualReviewEnabledStrategies: {
        ORB_PULLBACK_CONTINUATION: true,
        EARLY_ORB_MOMENTUM_CONTINUATION: false,
        CONSOLIDATION_BREAKOUT_CONTINUATION: false,
        EQUIVALENT_CANDLE_REVERSAL: false,
        PATIENCE_CANDLE_CONTINUATION: true,
        PEAK_RETRACEMENT_REVERSAL: false,
      },
    },
    dataset: {
      source: "historical_databento" as const,
      contractSymbol: specification.fullContractSymbol,
      contractMonth: specification.contractMonth,
      candles,
      quotesAvailable: false,
      inSampleDates: [tradingDate],
      outOfSampleDates: [],
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
       const authoritativeTrade = report.trades.find((trade) =>
          trade.candidateId === candidate?.candidateId
          && trade.signalOccurrenceId === occurrence?.occurrenceId
          && trade.primaryEdge === setupType
           && trade.direction === direction);
       assert.ok(authoritativeTrade, `${kind} ${direction} must produce an authoritative trade`);
       assert.ok(
         authoritativeTrade?.audit?.executionChronologyMode,
         `${kind} ${direction} must persist its production execution chronology mode`,
       );
       assert.equal(
         authoritativeTrade?.audit?.executionChronology?.candidateId,
         authoritativeTrade?.candidateId,
         `${kind} ${direction} chronology must retain candidate ownership`,
       );
       assert.equal(
         authoritativeTrade?.audit?.causalIdentity?.canonicalFrozenZoneIdentity,
         candidate?.causalIdentity.canonicalFrozenZoneIdentity,
         `${kind} ${direction} must carry one frozen-zone identity into execution`,
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
          const frozenHigh = qualifiedAudit?.directConsolidationZoneHigh;
          const frozenLow = qualifiedAudit?.directConsolidationZoneLow;
          assert.equal(typeof frozenHigh, "number");
          assert.equal(typeof frozenLow, "number");
          const expectedEntry = direction === "long"
            ? frozenHigh! + 8 * specification.tickSize
            : frozenLow! - 8 * specification.tickSize;
          const rawMidpoint = frozenLow! + (frozenHigh! - frozenLow!) / 2;
          const expectedStop = direction === "long"
            ? (Math.ceil(rawMidpoint / specification.tickSize) - 1) * specification.tickSize
            : (Math.floor(rawMidpoint / specification.tickSize) + 1) * specification.tickSize;
          assert.equal(candidate?.confirmationPrice, expectedEntry);
          assert.equal(candidate?.strategyStopPrice, expectedStop);
          assert.equal(
            direction === "long"
              ? (candidate?.entryHigh ?? Number.NEGATIVE_INFINITY) > frozenHigh!
              : (candidate?.entryLow ?? Number.POSITIVE_INFINITY) < frozenLow!,
            true,
          );
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
        assert.equal(qualifiedAudit?.directConsolidationSourceCandleTimestamps?.length, 4);
        assert.equal(occurrence?.directConsolidationSourceCandleTimestamps?.length, 4);
        const execution = report.candidateExecutionEvidence?.find((trade) => trade.candidateId === candidate?.candidateId);
        assert.equal(execution?.causalIdentity?.causalTrendTimestamp, occurrence?.causalTrendTimestamp);
         const authoritativeTrade = report.trades.find((trade) =>
           trade.candidateId === candidate?.candidateId
           && trade.signalOccurrenceId === occurrence?.occurrenceId
           && trade.primaryEdge === setupType,
         );
         assert.ok(authoritativeTrade);
         assert.ok((authoritativeTrade.audit?.legs.length ?? 0) > 0);
         assert.ok(
           authoritativeTrade.audit?.exitReason === "target"
           || authoritativeTrade.audit?.exitReason === "CONSOLIDATION_MIDPOINT_REENTRY_STOP",
         );
         assert.equal(authoritativeTrade.audit?.consolidationMidpointStop?.tickAlignedStop, expectedStop);
         const visualSet = buildHistoricalVisualValidationSetFromReport(
           {
             ...fixture.request,
             source: "historical_databento",
             reviewMode: "trades_and_diagnostics",
           },
           fixture.dataset,
           {
             symbol: report.symbol,
             formulaHash: report.formulaHash,
             executionMode: report.executionMode,
             audit: report.audit,
             trades: report.trades,
             occurrences: report.occurrences,
             tradeCandidates: report.tradeCandidates,
           },
         );
         const visualSnapshot = visualSet.snapshots.find((snapshot) =>
           snapshot.machineEvidence.trade?.candidateId === candidate?.candidateId
           && snapshot.category === "qualified_trade",
         );
         assert.ok(visualSnapshot);
         assert.equal(visualSnapshot.machineEvidence.trade?.audit?.consolidationMidpointStop?.tickAlignedStop, expectedStop);
         assert.equal(
           visualSnapshot.annotations.find((annotation) => annotation.id === "strategy-stop")?.price,
           expectedStop,
         );
      }
    }
  }
});

test("pre-11:30 ORB continuation fixtures preserve exact long and short identity through Visual Review", () => {
  for (const direction of ["long", "short"] as const) {
    const fixture = orbContinuationProductionFixture(direction);
    const report = runCausalBacktest(fixture.request, undefined, fixture.dataset);
    const confirmedOccurrences = [...new Map(report.occurrences
      .filter((item) =>
        item.strategyCandidate === "ORB_PULLBACK_CONTINUATION"
        && item.direction === direction
        && item.status === "SIGNAL_CONFIRMED"
        && item.matchedEdges?.includes("PATIENCE_CANDLE_CONTINUATION")
        && item.primaryEdge === "ORB_PULLBACK_CONTINUATION"
        && item.directionSource === "ORB_TREND"
        && Number.isFinite(Date.parse(item.directionSourceTimestamp ?? "")),
      )
      .map((item) => [item.occurrenceId, item])).values()];
    const expectedOccurrenceCount = direction === "long" ? 1 : 2;
    assert.equal(confirmedOccurrences.length, expectedOccurrenceCount, `${direction} must produce the complete confirmed occurrence set`);
    assert.equal(new Set(confirmedOccurrences.map((item) => item.occurrenceId)).size, expectedOccurrenceCount);
    assert.ok(confirmedOccurrences.every((item) => item.matchedEdges?.includes("ORB_PULLBACK_CONTINUATION")));
    assert.ok(confirmedOccurrences.every((item) => item.matchedEdges?.includes("PATIENCE_CANDLE_CONTINUATION")));
    assert.ok(confirmedOccurrences.every((item) => item.secondaryStrategyMatches?.includes("PATIENCE_CANDLE_CONTINUATION")));
    assert.ok(confirmedOccurrences.every((item) => item.primaryEdge === "ORB_PULLBACK_CONTINUATION"));
    assert.ok(confirmedOccurrences.every((item) =>
      Date.parse(item.pOpenTimestamp ?? item.patienceTimestamp ?? "") < Date.parse(`${fixture.request.startDate}T15:30:00.000Z`),
    ), `${direction} patience candle must open before 11:30 a.m. ET`);

    const candidates = report.tradeCandidates.filter((item) =>
      confirmedOccurrences.some((occurrence) => occurrence.occurrenceId === item.signalOccurrenceId)
      && item.primaryEdge === "ORB_PULLBACK_CONTINUATION",
    );
    assert.equal(candidates.length, expectedOccurrenceCount, `${direction} must produce one canonical candidate per confirmed occurrence`);
    assert.equal(new Set(candidates.map((item) => item.candidateId)).size, expectedOccurrenceCount);
    assert.deepEqual(
      candidates.map((item) => item.accountEntryStatus),
      direction === "long" ? ["ENTERED"] : ["ENTERED", "BLOCKED_ACTIVE_POSITION"],
    );
    assert.equal(candidates.filter((item) => item.accountEntryStatus === "ENTERED").length, 1);
    assert.equal(candidates.filter((item) => item.accountEntryStatus === "BLOCKED_ACTIVE_POSITION").length, direction === "long" ? 0 : 1);
    assert.equal(report.trades.length, 1, `${direction} must produce exactly one account-authorized modeled trade`);

    for (const occurrence of confirmedOccurrences) {
      const patienceAudits = report.audit.filter((item) =>
        item.setupType === "PATIENCE_CANDLE_CONTINUATION"
        && item.decision === "SETUP QUALIFIED"
        && item.direction === direction
        && occurrence.auditIds?.includes(item.id),
      );
      assert.ok(patienceAudits.length > 0, `${direction} authoritative audit must preserve the qualified Patience evaluation`);
      assert.ok(patienceAudits.every((item) =>
        ["causalDirection", "continuationContext", "patienceEligible", "immediateTrigger", "entryOutsideFinalizedNtz"]
          .every((key) => item.ruleEvidence.some((evidence) => evidence.startsWith(`PASS ${key}:`))),
      ), `${direction} qualified Patience audit must preserve every mandatory pass`);
      const phase6Snapshot = createMarketSnapshot(
        "MES",
        "regular",
        undefined,
        undefined,
        { targetDollars: 75, slippageMode: "normal" },
        {
          tradingDate: fixture.request.startDate,
          cursor: Date.parse(patienceAudits[0]!.evaluatedCandleOpenTime) + FIVE_MINUTES,
          allCandles: fixture.dataset.candles,
          historicalFeed: fixture.dataset.candles,
          premarketAvailable: true,
          executionMode: "ohlcv_modeled",
        },
      );
      const patienceEvaluation = phase6Snapshot.setupAnalysis.evaluations.find((item) =>
        item.setupType === "PATIENCE_CANDLE_CONTINUATION"
        && item.decision === "SETUP QUALIFIED",
      );
      assert.ok(patienceEvaluation, `${direction} Phase 6 must retain the qualified Patience evaluator identity`);
      assert.equal(patienceEvaluation?.mandatoryPassed, true);
      assert.equal(patienceEvaluation?.rules.find((rule) => rule.key === "causalDirection")?.passed, true);

      const candidateMatches = candidates.filter((item) => item.signalOccurrenceId === occurrence.occurrenceId);
      assert.equal(candidateMatches.length, 1);
      const candidate = candidateMatches[0]!;
      assert.deepEqual(candidate.matchedEdges, ["ORB_PULLBACK_CONTINUATION", "PATIENCE_CANDLE_CONTINUATION"]);
      assert.deepEqual(candidate.causalIdentity.signalOccurrenceId, occurrence.occurrenceId);
      assert.deepEqual(
        {
          direction: candidate.direction,
          source: candidate.directionSource,
          sourceTimestamp: candidate.directionSourceTimestamp,
          epoch: candidate.orbTrendEpochId,
          signalOccurrenceId: candidate.signalOccurrenceId,
        },
        {
          direction,
          source: occurrence.directionSource,
          sourceTimestamp: occurrence.directionSourceTimestamp,
          epoch: occurrence.orbTrendEpochId,
          signalOccurrenceId: occurrence.occurrenceId,
        },
      );
      const linkedTrades = report.trades.filter((item) =>
        item.candidateId === candidate.candidateId && item.signalOccurrenceId === occurrence.occurrenceId,
      );
      assert.equal(linkedTrades.length, candidate.accountEntryStatus === "ENTERED" ? 1 : 0);
      const trade = linkedTrades[0];
      if (trade) {
        assert.equal(trade.primaryEdge, "ORB_PULLBACK_CONTINUATION");
        assert.deepEqual(
          {
            candidateId: trade.candidateId,
            signalOccurrenceId: trade.signalOccurrenceId,
            direction: trade.direction,
            source: trade.directionSource,
            sourceTimestamp: trade.directionSourceTimestamp,
            epoch: trade.orbTrendEpochId,
          },
          {
            candidateId: candidate.candidateId,
            signalOccurrenceId: occurrence.occurrenceId,
            direction,
            source: occurrence.directionSource,
            sourceTimestamp: occurrence.directionSourceTimestamp,
            epoch: occurrence.orbTrendEpochId,
          },
        );
      }
    }

    const occurrence = confirmedOccurrences.find((item) =>
      candidates.some((candidate) => candidate.signalOccurrenceId === item.occurrenceId && candidate.accountEntryStatus === "ENTERED"),
    );
    assert.ok(occurrence, `${direction} must have an account-authorized occurrence`);
    const candidate = candidates.find((item) =>
      item.signalOccurrenceId === occurrence?.occurrenceId && item.accountEntryStatus === "ENTERED",
    );
    assert.ok(candidate, `${direction} must produce an entered candidate`);
    const trade = report.trades.find((item) =>
      item.candidateId === candidate?.candidateId
      && item.signalOccurrenceId === occurrence?.occurrenceId
      && item.direction === direction
      && item.primaryEdge === "ORB_PULLBACK_CONTINUATION",
    );
    assert.ok(trade, `${direction} must produce an authoritative trade`);
    assert.ok(report.candidateExecutionEvidence?.some((item) =>
      item.candidateId === candidate?.candidateId
      && item.signalOccurrenceId === occurrence?.occurrenceId,
    ), `${direction} must produce candidate-owned execution evidence`);
    assert.ok(
      Date.parse(trade?.entryTime ?? "") < Date.parse(`${fixture.request.startDate}T15:30:00.000Z`),
      `${direction} trade must enter before 11:30 a.m. ET`,
    );

    const expectedIdentity = {
      direction,
      source: occurrence?.directionSource,
      sourceTimestamp: occurrence?.directionSourceTimestamp,
      epoch: occurrence?.orbTrendEpochId,
    };
    assert.deepEqual(
      {
        direction: candidate?.direction,
        source: candidate?.directionSource,
        sourceTimestamp: candidate?.directionSourceTimestamp,
        epoch: candidate?.orbTrendEpochId,
      },
      expectedIdentity,
      `${direction} candidate must preserve causal direction identity`,
    );
    assert.deepEqual(
      {
        direction: candidate?.causalIdentity.direction,
        source: candidate?.causalIdentity.directionSource,
        sourceTimestamp: candidate?.causalIdentity.directionSourceTimestamp,
        epoch: candidate?.causalIdentity.orbTrendEpochId,
      },
      expectedIdentity,
      `${direction} candidate identity must preserve causal direction identity`,
    );
    assert.deepEqual(
      {
        direction: trade?.direction,
        source: trade?.directionSource,
        sourceTimestamp: trade?.directionSourceTimestamp,
        epoch: trade?.orbTrendEpochId,
        identity: {
          direction: trade?.causalIdentity?.direction,
          source: trade?.causalIdentity?.directionSource,
          sourceTimestamp: trade?.causalIdentity?.directionSourceTimestamp,
          epoch: trade?.causalIdentity?.orbTrendEpochId,
        },
      },
      {
        ...expectedIdentity,
        identity: expectedIdentity,
      },
      `${direction} trade must preserve causal direction identity`,
    );

    const visualSet = buildHistoricalVisualValidationSetFromReport(
      {
        ...fixture.request,
        source: "historical_databento",
        reviewMode: "trades_and_diagnostics",
      },
      fixture.dataset,
      {
        symbol: report.symbol,
        formulaHash: report.formulaHash,
        executionMode: report.executionMode,
        audit: report.audit,
        trades: report.trades,
        occurrences: report.occurrences,
        tradeCandidates: report.tradeCandidates,
      },
    );
    const visualSnapshot = visualSet.snapshots.find((snapshot) =>
      snapshot.category === "qualified_trade"
      && snapshot.occurrenceId === occurrence?.occurrenceId
      && snapshot.machineEvidence.trade?.candidateId === candidate?.candidateId
      && snapshot.machineEvidence.trade?.signalOccurrenceId === occurrence?.occurrenceId,
    );
    assert.ok(visualSnapshot, `${direction} must reach Visual Review with exact occurrence/candidate linkage`);
    assert.deepEqual(
      {
        direction: visualSnapshot?.machineEvidence.trade?.direction,
        source: visualSnapshot?.machineEvidence.trade?.directionSource,
        sourceTimestamp: visualSnapshot?.machineEvidence.trade?.directionSourceTimestamp,
        epoch: visualSnapshot?.machineEvidence.trade?.orbTrendEpochId,
      },
      expectedIdentity,
      `${direction} Visual Review must preserve causal direction identity`,
    );
    assert.equal(visualSnapshot?.machineEvidence.trade?.causalIdentity?.signalOccurrenceId, occurrence?.occurrenceId);
    assert.equal(visualSnapshot?.machineEvidence.trade?.candidateId, candidate?.candidateId);
  }
});

test("pre-11:30 fixtures apply independent ORB and Patience switches before canonical projection", () => {
  const toggleCases = [
    { label: "both enabled", orb: true, patience: true },
    { label: "ORB enabled, Patience disabled", orb: true, patience: false },
    { label: "ORB disabled, Patience enabled", orb: false, patience: true },
    { label: "both disabled", orb: false, patience: false },
  ] as const;

  for (const direction of ["long", "short"] as const) {
    for (const toggleCase of toggleCases) {
      const fixture = orbContinuationProductionFixture(direction);
      const request = {
        ...fixture.request,
        visualReviewEnabledStrategies: {
          ...fixture.request.visualReviewEnabledStrategies,
          ORB_PULLBACK_CONTINUATION: toggleCase.orb,
          PATIENCE_CANDLE_CONTINUATION: toggleCase.patience,
        },
      };
      const report = runCausalBacktest(request, undefined, fixture.dataset);
      const expectedOccurrenceCount = direction === "long" ? 1 : 2;
      const expectedQualifiedAuditCount = direction === "long" ? 69 : 33;
      const expectedGrades = direction === "long" ? ["A+"] : ["A+", "A"];
      const expectedQualifiedCount = toggleCase.orb || toggleCase.patience ? expectedOccurrenceCount : 0;
      const expectedEnteredCount = expectedQualifiedCount > 0 ? 1 : 0;
      const expectedBlockedCount = direction === "short" && expectedQualifiedCount > 0 ? 1 : 0;
      const expectedEdges = toggleCase.orb && toggleCase.patience
        ? ["ORB_PULLBACK_CONTINUATION", "PATIENCE_CANDLE_CONTINUATION"]
        : toggleCase.orb
          ? ["ORB_PULLBACK_CONTINUATION"]
          : toggleCase.patience
            ? ["PATIENCE_CANDLE_CONTINUATION"]
            : [];
      const expectedSecondary = toggleCase.orb && toggleCase.patience
        ? ["PATIENCE_CANDLE_CONTINUATION"]
        : [];

      const qualifiedOrbAudits = report.audit.filter((item) =>
        item.setupType === "ORB_PULLBACK_CONTINUATION"
        && item.direction === direction
        && item.decision === "SETUP QUALIFIED",
      );
      const qualifiedPatienceAudits = report.audit.filter((item) =>
        item.setupType === "PATIENCE_CANDLE_CONTINUATION"
        && item.direction === direction
        && item.decision === "SETUP QUALIFIED",
      );
      assert.equal(qualifiedOrbAudits.length, toggleCase.orb ? expectedQualifiedAuditCount : 0, `${direction} ${toggleCase.label} ORB audit count`);
      assert.equal(qualifiedPatienceAudits.length, toggleCase.patience ? expectedQualifiedAuditCount : 0, `${direction} ${toggleCase.label} Patience audit count`);

      const occurrences = report.occurrences.filter((item) =>
        item.direction === direction
        && item.status === "SIGNAL_CONFIRMED"
        && item.strategyCandidate === "ORB_PULLBACK_CONTINUATION"
        && (item.matchedEdges ?? []).some((edge) =>
          edge === "ORB_PULLBACK_CONTINUATION" || edge === "PATIENCE_CANDLE_CONTINUATION"),
      );
      assert.equal(occurrences.length, expectedQualifiedCount, `${direction} ${toggleCase.label} occurrence count`);
      assert.equal(new Set(occurrences.map((item) => item.occurrenceId)).size, occurrences.length);
      assert.ok(occurrences.every((item) => item.primaryEdge === "ORB_PULLBACK_CONTINUATION"));
      assert.ok(occurrences.every((item) => item.matchedEdges?.slice().sort().join("|") === expectedEdges.slice().sort().join("|")));
      assert.ok(occurrences.every((item) => (item.secondaryStrategyMatches ?? []).slice().sort().join("|") === expectedSecondary.slice().sort().join("|")));

      const candidates = report.tradeCandidates.filter((item) =>
        occurrences.some((occurrence) => occurrence.occurrenceId === item.signalOccurrenceId),
      );
      assert.equal(candidates.length, expectedQualifiedCount, `${direction} ${toggleCase.label} candidate count`);
      assert.equal(new Set(candidates.map((item) => item.candidateId)).size, candidates.length);
      assert.deepEqual(
        candidates.map((item) => item.accountEntryStatus),
        direction === "long"
          ? expectedQualifiedCount > 0 ? ["ENTERED"] : []
          : expectedQualifiedCount > 0 ? ["ENTERED", "BLOCKED_ACTIVE_POSITION"] : [],
      );
      assert.equal(candidates.filter((item) => item.accountEntryStatus === "ENTERED").length, expectedEnteredCount);
      assert.equal(candidates.filter((item) => item.accountEntryStatus === "BLOCKED_ACTIVE_POSITION").length, expectedBlockedCount);
      assert.equal(report.trades.length, expectedEnteredCount, `${direction} ${toggleCase.label} modeled trade count`);
      assert.ok(candidates.every((item) => item.primaryEdge === "ORB_PULLBACK_CONTINUATION"));
      assert.ok(candidates.every((item) => item.matchedEdges.slice().sort().join("|") === expectedEdges.slice().sort().join("|")));
      assert.deepEqual(candidates.map((item) => item.grade), expectedQualifiedCount > 0 ? expectedGrades : [], `${direction} ${toggleCase.label} setup grade`);

      if (expectedEnteredCount === 0) {
        const visualSet = buildHistoricalVisualValidationSetFromReport(
          {
            ...request,
            source: "historical_databento",
            reviewMode: "trades_and_diagnostics",
          },
          fixture.dataset,
          {
            symbol: report.symbol,
            formulaHash: report.formulaHash,
            executionMode: report.executionMode,
            audit: report.audit,
            trades: report.trades,
            occurrences: report.occurrences,
            tradeCandidates: report.tradeCandidates,
          },
        );
        assert.equal(
          visualSet.snapshots.filter((snapshot) =>
            snapshot.category === "qualified_trade"
            && (snapshot.machineEvidence.audit.setupType === "ORB_PULLBACK_CONTINUATION"
              || snapshot.machineEvidence.audit.setupType === "PATIENCE_CANDLE_CONTINUATION"),
          ).length,
          0,
          `${direction} ${toggleCase.label} must not create a qualified continuation Visual Review snapshot`,
        );
      }

      for (const occurrence of occurrences) {
        const matchingCandidates = candidates.filter((item) => item.signalOccurrenceId === occurrence.occurrenceId);
        assert.equal(matchingCandidates.length, 1, `${direction} ${toggleCase.label} occurrence must map to one candidate`);
        const candidate = matchingCandidates[0]!;
        const matchingTrades = report.trades.filter((item) =>
          item.candidateId === candidate.candidateId
          && item.signalOccurrenceId === occurrence.occurrenceId,
        );
        assert.equal(matchingTrades.length, candidate.accountEntryStatus === "ENTERED" ? 1 : 0);
        if (candidate.accountEntryStatus === "ENTERED") {
          const visualSet = buildHistoricalVisualValidationSetFromReport(
            {
              ...request,
              source: "historical_databento",
              reviewMode: "trades_and_diagnostics",
            },
            fixture.dataset,
            {
              symbol: report.symbol,
              formulaHash: report.formulaHash,
              executionMode: report.executionMode,
              audit: report.audit,
              trades: report.trades,
              occurrences: report.occurrences,
              tradeCandidates: report.tradeCandidates,
            },
          );
          const visualSnapshots = visualSet.snapshots.filter((snapshot) =>
            snapshot.category === "qualified_trade"
            && snapshot.machineEvidence.trade?.candidateId === candidate.candidateId
            && snapshot.machineEvidence.trade?.signalOccurrenceId === occurrence.occurrenceId,
          );
          assert.equal(visualSnapshots.length, 1, `${direction} ${toggleCase.label} candidate must have one Visual Review snapshot`);
          assert.equal(visualSnapshots[0]?.machineEvidence.trade?.candidateId, candidate.candidateId);
          assert.deepEqual(visualSnapshots[0]?.machineEvidence.trade?.matchedEdges?.slice().sort(), expectedEdges.slice().sort());
          if (!toggleCase.patience) {
            assert.notEqual(visualSnapshots[0]?.machineEvidence.audit.setupType, "PATIENCE_CANDLE_CONTINUATION");
          }
          if (!toggleCase.orb) {
            assert.equal(visualSnapshots[0]?.machineEvidence.audit.setupType, "PATIENCE_CANDLE_CONTINUATION");
          }
        }
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
  ], "long", { eligibilityEvents: eligibility, tickSize: 0.25, directionSource: "ORB_BREAKOUT" });
  assert.equal(expired.state, "PATIENCE_CANDLE_EXPIRED");

  const opposite = patienceCandleEngine([
    ...patienceBase,
    candle(2, 8.8, 10.5, 6.5, 8, 100, false),
  ], "long", { eligibilityEvents: eligibility, tickSize: 0.25, directionSource: "ORB_BREAKOUT" });
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