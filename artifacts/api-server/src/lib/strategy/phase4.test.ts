import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import { sessionCalendarForContract, timestampForTradingDate } from "../futures/session-calendar.js";
import { strategyConfig } from "./config.js";
import { analyzePullback, classifyRetracement, detectInitialBreakout, evaluateOrbBreakoutQuality, fibonacciAnalysis, phase4Volume } from "./phase4.js";
import { phase5PatienceAnalysis } from "./phase5.js";
import type { Candle } from "./types.js";

const specification = getFuturesContractSpecification("MES");
const calendar = sessionCalendarForContract(specification);
const config = strategyConfig();

function candle(index: number, open: number, high: number, low: number, close: number, volume: number, complete = true): Candle {
  const openTime = timestampForTradingDate("2026-08-25", "09:30", calendar) + index * 5 * 60_000;
  return { openTime, closeTime: openTime + 5 * 60_000, open, high, low, close, volume, isComplete: complete };
}

function candleCloseTime(index: number): number {
  return timestampForTradingDate("2026-08-25", "09:30", calendar) + (index + 1) * 5 * 60_000;
}

function candleOpenTime(index: number): number {
  return timestampForTradingDate("2026-08-25", "09:30", calendar) + index * 5 * 60_000;
}

function breakoutFixture(): Candle[] {
  return [
    candle(0, 99.5, 100, 99, 99.5, 100),
    candle(1, 99.5, 101, 99, 100, 100),
    candle(2, 100, 102, 99, 101, 100),
    candle(3, 101, 102.2, 100.5, 101.5, 100),
    candle(4, 101.5, 102.5, 100.8, 101.6, 100),
    candle(5, 101.6, 102.3, 100.9, 101.7, 100),
    candle(6, 101.5, 105, 101.5, 104.5, 130),
    candle(7, 104.5, 104.8, 101.4, 103.2, 80),
    candle(8, 102.1, 102.6, 101.8, 102.2, 70),
    candle(9, 102.2, 102.6, 101.9, 102.3, 70),
    candle(10, 102.3, 102.5, 101, 101.2, 140),
    candle(11, 101.2, 101.5, 100.8, 101, 90),
    candle(12, 101, 101.5, 100.5, 100.8, 90),
  ];
}

test("breakout requires a finalized NTZ and a completed close outside it", () => {
  const candles = breakoutFixture();
  const ntz = { high: 102, low: 99, complete: true, completedAt: candles[2].closeTime };
  const breakout = detectInitialBreakout(candles, ntz, config);
  assert.equal(breakout.detected, true);
  assert.equal(breakout.direction, "long");
  assert.equal(breakout.candleOpenTime, candles[6].openTime);
  assert.equal(breakout.state, "QUALIFIED_BREAKOUT");
  assert.equal(breakout.distanceOutside, 2.5);
  assert.equal(breakout.breakoutVolume, 130);
  assert.equal(breakout.volumeSupported, true);
  assert.equal(breakout.continuationCondition, "TWO_CONSECUTIVE_CLOSES_OUTSIDE_ORB");
  assert.equal(detectInitialBreakout(candles.slice(0, 3), { ...ntz, complete: false }, config).detected, false);
  assert.equal(detectInitialBreakout(candles.slice(0, 3), ntz, config).detected, false);
});

test("pullback uses max(two ticks, 0.10 ATR), stays bounded, and records interaction types", () => {
  const candles = breakoutFixture();
  const breakout = detectInitialBreakout(candles, { high: 102, low: 99, complete: true, completedAt: candles[2].closeTime }, config);
  const pullback = analyzePullback(candles, breakout, [
    { name: "ORB high", price: 102 },
    { name: "VWAP", price: 101.2 },
  ], specification, config);
  const eventTypes = new Set(pullback.events.map((event) => event.type));
  assert.equal(pullback.proximityTolerance, 0.5);
  for (const type of ["touch", "proximity", "break and reclaim", "hold", "consolidation", "break through"] as const) {
    assert.equal(eventTypes.has(type), true, `missing ${type}`);
  }
  assert.equal(pullback.evaluatedCandles, 6);
  assert.equal(pullback.status, "expired");
  assert.equal(pullback.maxDurationMinutes, 30);
});

test("Fibonacci anchors freeze at breakout, expose requested levels, allow manual correction, and classify depth independently", () => {
  const candles = breakoutFixture();
  const breakout = detectInitialBreakout(candles, { high: 102, low: 99, complete: true, completedAt: candles[2].closeTime }, config);
  const pullback = analyzePullback(candles, breakout, [{ name: "ORB high", price: 104 }], specification, config);
  const automatic = fibonacciAnalysis(candles, breakout, undefined, pullback);
  assert.equal(automatic.direction, "bullish");
  assert.equal(automatic.impulseLow, 101.5);
  assert.equal(automatic.impulseHigh, 105);
  assert.deepEqual(automatic.levels.map((level) => level.label), ["0%", "23.6%", "38.2%", "40.0%", "50.0%", "61.8%", "78.6%", "100%"]);
  const before = automatic.impulseHigh;
  const later = fibonacciAnalysis([...candles, candle(11, 101, 110, 95, 100, 100)], breakout, undefined, pullback);
  assert.equal(later.impulseHigh, before);
  const manual = fibonacciAnalysis(candles, breakout, { low: 100, high: 110 }, pullback);
  assert.equal(manual.manualCorrection, true);
  assert.equal(manual.impulseLow, 100);
  assert.equal(manual.impulseHigh, 110);
  for (const [depth, expected] of [[10, "shallow"], [40, "normal"], [55, "deep"], [75, "elevated failure risk"], [100, "fully retraced"]] as const) {
    assert.equal(classifyRetracement(depth), expected);
  }
});

test("Fibonacci remains unavailable until a pullback interacts with a qualifying key level", () => {
  const candles = breakoutFixture();
  const breakout = detectInitialBreakout(candles, { high: 102, low: 99, complete: true, completedAt: candles[2].closeTime }, config);
  const unavailable = fibonacciAnalysis(candles, breakout);
  assert.equal(unavailable.classification, "unavailable");
  assert.equal(unavailable.levels.length, 0);
  assert.match(unavailable.detail, /confirmed pullback/i);
});

test("volume keeps baseline, support, impulse, pullback, and opposing-volume warning separate", () => {
  const candles = breakoutFixture();
  const breakout = detectInitialBreakout(candles, { high: 102, low: 99, complete: true, completedAt: candles[2].closeTime }, config);
  const volume = phase4Volume(candles, breakout, config);
  assert.equal(volume.baselineCandleCount, 6);
  assert.equal(volume.recentSixAverage, 100);
  assert.equal(volume.breakoutRatio, 1.3);
  assert.equal(volume.supportingBreakoutVolume, true);
  assert.equal(volume.averageImpulseVolume, 100);
  assert.equal(volume.pullbackAverageVolume, 90);
  assert.equal(volume.opposingPullbackVolume, 140);
  assert.equal(volume.reversalWarning, "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL");
});

test("ORB probes and weak breaks never start downstream analysis", () => {
  const ntz = { high: 102, low: 99, complete: true, completedAt: candleCloseTime(2) };
  const probe = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candle(3, 101, 102.2, 100.5, 101.5, 100),
  ], ntz, config, specification);
  assert.equal(probe.state, "ORB_PROBE_WAIT");
  assert.equal(probe.detected, false);

  const weak = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candle(3, 102, 102.6, 101.8, 102.2, 100),
  ], ntz, config, specification);
  assert.equal(weak.state, "WEAK_BREAK_WAIT");
  assert.equal(weak.detected, false);
  assert.equal(analyzePullback([candle(0, 99, 100, 99, 99.5, 100)], weak, [], specification, config).evaluatedCandles, 0);
});

test("a weak probe can be followed by a later strong push in either direction", () => {
  const ntz = { high: 102, low: 99, complete: true, completedAt: candleCloseTime(2) };
  const bullish = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candle(3, 101, 102.2, 100.5, 101.5, 100),
    candle(4, 101.5, 105, 101.5, 104.5, 130),
    candle(5, 104.5, 105, 103.5, 104.7, 90),
  ], ntz, config, specification);
  assert.equal(bullish.detected, true);
  assert.equal(bullish.direction, "long");
  assert.equal(bullish.candidateCandleOpenTime, candleOpenTime(4));

  const bearish = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candle(3, 100, 100.4, 98.5, 98.8, 100),
    candle(4, 98.8, 100, 96, 96.2, 130),
    candle(5, 96.2, 97, 95.8, 95.8, 90),
  ], ntz, config, specification);
  assert.equal(bearish.detected, true);
  assert.equal(bearish.direction, "short");
  assert.equal(bearish.candidateCandleOpenTime, candleOpenTime(4));
});

test("the strong single-candle exception records its continuation condition", () => {
  const ntz = { high: 102, low: 99, complete: true, completedAt: candleCloseTime(2) };
  const breakout = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candle(3, 101, 105, 101, 104.6, 160),
  ], ntz, config, specification);
  assert.equal(breakout.detected, true);
  assert.equal(breakout.continuationConfirmed, true);
  assert.equal(breakout.continuationCondition, "STRONG_SINGLE_CANDLE_EXCEPTION");
});

test("qualified candidates require continuation and visibly fail when they reclaim the ORB", () => {
  const ntz = { high: 102, low: 99, complete: true, completedAt: candleCloseTime(2) };
  const waiting = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candle(3, 101, 105, 101, 104.5, 130),
  ], ntz, config, specification);
  assert.equal(waiting.state, "BREAKOUT_CANDIDATE");
  assert.equal(waiting.detected, false);

  const failed = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candle(3, 101, 105, 101, 104.5, 130),
    candle(4, 104.5, 104.8, 101, 101.8, 80),
  ], ntz, config, specification);
  assert.equal(failed.state, "BREAKOUT_FAILED");
  assert.equal(failed.failed, true);
  assert.equal(failed.continuationConfirmed, false);
});

test("ORB quality remains causal when a future continuation candle is incomplete", () => {
  const ntz = { high: 102, low: 99, complete: true, completedAt: candleCloseTime(2) };
  const candidate = candle(3, 101, 105, 101, 104.5, 130);
  const incompleteContinuation = candle(4, 104.5, 105, 103.5, 104.8, 90, false);
  const beforeClose = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candidate,
    incompleteContinuation,
  ], ntz, config, specification);
  assert.equal(beforeClose.state, "BREAKOUT_CANDIDATE");
  assert.equal(beforeClose.detected, false);

  const afterClose = evaluateOrbBreakoutQuality([
    ...breakoutFixture().slice(0, 3),
    candidate,
    { ...incompleteContinuation, isComplete: true },
  ], ntz, config, specification);
  assert.equal(afterClose.detected, true);
  assert.equal(afterClose.continuationCondition, "IMMEDIATE_DIRECTIONAL_EXTENSION");
});

test("Fibonacci anchors begin at the later strong push and pre-qualification patience is rejected", () => {
  const ntz = { high: 102, low: 99, complete: true, completedAt: candleCloseTime(2) };
  const candles = [
    ...breakoutFixture().slice(0, 3),
    candle(3, 101, 110, 100.5, 101.5, 100),
    candle(4, 101.5, 105, 101.5, 104.5, 130),
    candle(5, 104.5, 105, 103.5, 104.7, 90),
  ];
  const breakout = evaluateOrbBreakoutQuality(candles, ntz, config, specification);
  const pullback = analyzePullback(candles, breakout, [{ name: "ORB high", price: 105 }], specification, config);
  const fibonacci = fibonacciAnalysis(candles, breakout, undefined, pullback);
  assert.equal(breakout.detected, true);
  assert.equal(fibonacci.impulseHigh, 105);
  assert.ok((fibonacci.impulseHigh ?? 0) < 110);

  const patience = phase5PatienceAnalysis(candles, "long", {
    status: "observed",
    events: [{ type: "touch", time: candleCloseTime(3), level: "ORB high", price: 102, detail: "Pre-qualification interaction." }],
    evaluatedCandles: 1,
    maxCandles: 6,
    maxDurationMinutes: 30,
    elapsedMinutes: 5,
    proximityTolerance: 0.5,
    atr14: 1,
    qualifyingLevelCount: 1,
    detail: "Pre-qualification.",
  }, null, [], breakout.time);
  assert.equal(patience.patienceCandle, null);
  assert.equal(patience.state, "WAITING_FOR_LEVEL");
});