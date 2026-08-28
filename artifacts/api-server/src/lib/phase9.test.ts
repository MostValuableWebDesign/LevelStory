import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCausalVisibility,
  calculateBacktestMetrics,
  createCausalReplay,
  buildReplayIndexes,
  resolveEntryAndInvalidation,
  resolveIntrabarOutcome,
  type IntrabarBar,
  type BacktestTrade,
  type BacktestAuditRecord,
} from "./phase9.js";
import type { SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { DEFAULT_FUTURES_SESSION_CALENDAR, newYorkTimeToUtc } from "./futures/session-calendar.js";

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