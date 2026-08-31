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
  const candles = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-25",
    days: 3,
    seed,
    includePremarket: true,
    premarketAvailable: true,
  });
  const window = sessionWindow("2026-08-25", "regular", calendar)!;
  const regular = candles.filter((candle) => candle.openTime >= window.openTime && candle.openTime < window.closeTime);
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

test("deterministic bullish and bearish A+ fixtures qualify and target-exit through the endpoint pipeline", () => {
  for (const [seed, direction] of [[11, "long"], [12, "short"]] as const) {
    const snapshot = scenarioSnapshot(seed);
    assert.equal(snapshot.setupAnalysis.decision, "SETUP QUALIFIED", `seed ${seed}`);
    assert.equal(snapshot.setupAnalysis.primarySetup, "ORB_PULLBACK_CONTINUATION", `seed ${seed}`);
    assert.equal(snapshot.riskPlan.allowed, true, `seed ${seed}`);
    assert.equal(snapshot.riskPlan.direction, direction, `seed ${seed}`);
    assert.equal(snapshot.shadowExecution?.contracts, 2, `seed ${seed}`);

    const report = runCausalBacktest({
      symbol: "MES",
      endDate: "2026-08-25",
      inSampleDays: 5,
      outOfSampleDays: 2,
      seed,
      premarketAvailable: true,
      targetDollars: 75,
      slippageMode: "normal",
    });
    assert.equal(report.metrics.tradeCount, 1, `seed ${seed}`);
    assert.equal(report.trades[0]?.direction, direction, `seed ${seed}`);
    assert.equal(report.trades[0]?.outcome, "target", `seed ${seed}`);
  }
});

test("historical modeled replay audits every completed regular candle while preventing overlap", () => {
  const dates = listTradingDates("2026-08-27", 3, calendar);
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-27",
    days: 3,
    seed: 11,
    includePremarket: true,
    premarketAvailable: true,
  });
  const candles = source.map((candle) => ({
    ...candle,
    bid: candle.close,
    ask: candle.close,
    bidSize: 0,
    askSize: 0,
    contractSymbol: "MESU6",
  }));
  const report = runCausalBacktest({
    symbol: "MES",
    source: "historical_databento",
    startDate: dates[0],
    endDate: dates.at(-1)!,
    inSampleDays: 2,
    outOfSampleDays: 1,
    seed: 11,
    premarketAvailable: true,
    targetDollars: 75,
    slippageMode: "normal",
    executionMode: "ohlcv_modeled",
  }, undefined, {
    candles,
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    inSampleDates: dates.slice(0, 2),
    outOfSampleDates: dates.slice(2),
    selectedDates: dates,
    excludedDates: [],
    source: "historical_databento",
    quotesAvailable: false,
  });
  const regularCandleCount = candles.filter((candle) => {
    const date = tradingDateForTimestamp(candle.openTime, calendar);
    const window = sessionWindow(date, "regular", calendar);
    return dates.includes(date) && window !== null && candle.openTime >= window.openTime
      && candle.openTime < window.closeTime && candle.isComplete;
  }).length;
  const auditedCandleCount = new Set(report.audit.map((record) => record.evaluatedCandleOpenTime)).size;
  assert.equal(auditedCandleCount, regularCandleCount);
  assert.ok(report.trades.length > 0);
  assert.equal(report.symbol, "MESU6");
  assert.equal(report.trades[0]?.contractSymbol, "MESU6");
  assert.equal(report.trades[0]?.segmentation.contract, "MESU6");
  assert.equal(report.trades[0]?.executionMode, "ohlcv_modeled");
  const trade = report.trades[0]!;
  const patience = trade.patienceCandle!;
  const patienceLow = patience.low as number;
  const patienceHigh = patience.high as number;
  const expectedStop = trade.direction === "long"
    ? patienceLow - 8 * specification.tickSize
    : patienceHigh + 8 * specification.tickSize;
  assert.equal(trade.audit?.strategyStopPrice, expectedStop);
  assert.equal(trade.audit?.stopPrice, trade.audit?.strategyStopPrice);
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
  assert.equal(opposite.state, "OPPOSITE_SIDE_INVALIDATION");

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