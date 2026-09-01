import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import { sessionCalendarForContract, timestampForTradingDate } from "../futures/session-calendar.js";
import { strategyConfig } from "./config.js";
import { analyzePullback, classifyRetracement, detectInitialBreakout, detectPullbackStructure, evaluateOrbBreakoutQuality, fibonacciAnalysis, levelInteractionDistance, phase4Volume, qualifyLevelInteraction, type BreakoutEvent } from "./phase4.js";
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

function breakoutAt(candle: Candle): BreakoutEvent {
  return {
    detected: true,
    direction: "long",
    time: candle.closeTime,
    candleOpenTime: candle.openTime,
    state: "QUALIFIED_BREAKOUT",
    candidateTime: candle.closeTime,
    candidateCandleOpenTime: candle.openTime,
    distanceOutside: 1,
    meaningfulDistance: 1,
    breakoutVolume: candle.volume,
    baselineVolume: candle.volume,
    volumeRatio: 1,
    volumeSupported: true,
    bodyRatio: 1,
    closeLocationRatio: 1,
    candleStructureSupported: true,
    continuationConfirmed: true,
    continuationCondition: "IMMEDIATE_DIRECTIONAL_EXTENSION",
    failed: false,
    detail: "focused fixture",
  };
}

function analyzeSinglePullback(
  high: number,
  low: number,
  close: number,
  level = 100,
  configOverrides: Parameters<typeof strategyConfig>[0] = {},
) {
  const breakoutCandle = candle(0, 100, 101, 99, 101, 100);
  const levelCandle = candle(1, close, high, low, close, 100);
  return analyzePullback(
    [breakoutCandle, levelCandle],
    breakoutAt(breakoutCandle),
    [{ name: "Focused level", price: level }],
    specification,
    strategyConfig(configOverrides),
  );
}

test("pullback structure is causal and independent of qualifying levels", () => {
  const breakoutCandle = candle(0, 100, 101, 99, 101, 100);
  const impulse = candle(1, 101, 103, 100.5, 102.8, 120);
  const retracement = candle(2, 102.8, 103, 101.5, 102, 90);
  const structure = detectPullbackStructure([impulse, retracement], breakoutCandle, "long");
  assert.equal(structure.detected, true);
  assert.equal(structure.impulseExtreme, impulse.high);
  assert.equal(structure.pullbackStart, retracement.openTime);
  assert.equal(structure.pullbackEnd, retracement.closeTime);
  assert.ok((structure.depthPoints ?? 0) > 0);

  const continuationOnly = detectPullbackStructure([impulse, candle(2, 102.8, 103.5, 102.5, 103.4, 90)], breakoutCandle, "long");
  assert.equal(continuationOnly.detected, false);
});

test("pullback structure requires direction-aware countertrend evidence after the impulse extreme", () => {
  const bullishBreakout = candle(0, 100, 105, 99, 104.5, 120);
  const bullishImpulse = candle(1, 104.5, 106, 104, 105.5, 100);
  const bullishContinuation = candle(2, 105.5, 105.8, 104.2, 105.6, 100);
  const bullishPullback = candle(2, 105.5, 105.8, 103.5, 104.2, 90);
  assert.equal(detectPullbackStructure([bullishImpulse, bullishContinuation], bullishBreakout, "long").detected, false);
  assert.equal(detectPullbackStructure([bullishImpulse, bullishPullback], bullishBreakout, "long").detected, true);

  const bearishBreakout = candle(0, 100, 101, 95, 96, 120);
  const bearishImpulse = candle(1, 96, 97, 94, 95, 100);
  const bearishContinuation = candle(2, 95, 95.8, 94.2, 94.8, 100);
  const bearishPullback = candle(2, 95, 98, 94.2, 97.5, 90);
  assert.equal(detectPullbackStructure([bearishImpulse, bearishContinuation], bearishBreakout, "short").detected, false);
  assert.equal(detectPullbackStructure([bearishImpulse, bearishPullback], bearishBreakout, "short").detected, true);
});

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

test("pullback uses the shared 12-tick full-range tolerance and records interaction types", () => {
  const candles = breakoutFixture();
  const breakout = detectInitialBreakout(candles, { high: 102, low: 99, complete: true, completedAt: candles[2].closeTime }, config);
  const pullback = analyzePullback(candles, breakout, [
    { name: "ORB high", price: 102 },
    { name: "VWAP", price: 101.2 },
    { name: "Far level", price: 104 },
  ], specification, config);
  const eventTypes = new Set(pullback.events.map((event) => event.type));
  assert.equal(pullback.proximityTolerance, 3);
  for (const type of ["touch", "proximity", "hold", "consolidation", "break through"] as const) {
    assert.equal(eventTypes.has(type), true, `missing ${type}`);
  }
  assert.equal(pullback.evaluatedCandles, 6);
  assert.equal(pullback.status, "observed");
  assert.equal(pullback.maxDurationMinutes, 30);
});

test("pullback remains causally active beyond the diagnostic six-candle and thirty-minute values", () => {
  const breakoutCandle = candle(0, 100, 101, 99, 101, 100);
  const laterCandles = Array.from({ length: 9 }, (_, offset) => {
    const index = offset + 1;
    const close = index === 8 ? 100 : 101 - index * 0.05;
    return candle(index, close, close + 0.1, 99.9, close, 100);
  });
  const pullback = analyzePullback(
    [breakoutCandle, ...laterCandles],
    breakoutAt(breakoutCandle),
    [{ name: "Late support", price: 100 }],
    specification,
    strategyConfig({ phase4PullbackMaxCandles: 6, phase4PullbackMaxMinutes: 30 }),
  );
  assert.equal(pullback.evaluatedCandles, 9);
  assert.equal(pullback.status, "observed");
  assert.ok(pullback.events.some((event) => event.candle?.openTime === laterCandles[7]?.openTime));
  assert.equal(pullback.maxCandles, 6);
  assert.equal(pullback.maxDurationMinutes, 30);
  assert.ok(pullback.elapsedMinutes > 30);
});

test("complete pullback detector qualifies full-range distances at 0/4/8/12 ticks and rejects beyond twelve", () => {
  const cases = [
    { label: "zero ticks", high: 100.25, low: 99.75, close: 100, distance: 0, ticks: 0, qualifies: true },
    { label: "four ticks", high: 99, low: 98.5, close: 98.75, distance: 1, ticks: 4, qualifies: true },
    { label: "eight ticks", high: 98, low: 97.5, close: 97.75, distance: 2, ticks: 8, qualifies: true },
    { label: "exactly twelve ticks", high: 97, low: 96.5, close: 96.75, distance: 3, ticks: 12, qualifies: true },
    { label: "just over twelve ticks", high: 96.99, low: 96.5, close: 96.75, distance: 3.01, ticks: 13, qualifies: false },
  ];
  for (const item of cases) {
    const result = analyzeSinglePullback(item.high, item.low, item.close);
    const event = result.events.find((candidate) => candidate.level === "Focused level");
    assert.ok(event, `${item.label} produces detector evidence`);
    assert.ok(Math.abs(event.distancePoints - item.distance) < 1e-9, `${item.label} distance`);
    assert.equal(event.distanceTicks, item.ticks, `${item.label} tick count`);
    assert.equal(event.tolerancePoints, 3);
    assert.equal(event.toleranceTicks, 12);
    assert.equal(event.qualifies, item.qualifies, `${item.label} qualification`);
    assert.equal(result.events.some((candidate) => ["touch", "proximity"].includes(candidate.type)), item.qualifies, `${item.label} qualifying event`);
  }
});

test("complete pullback detector handles above-level, below-level, and wick-crossing candles", () => {
  const above = analyzeSinglePullback(101.5, 101.25, 101.4).events.find((event) => event.level === "Focused level");
  const below = analyzeSinglePullback(99, 98.5, 98.75).events.find((event) => event.level === "Focused level");
  const crossing = analyzeSinglePullback(100.25, 99.75, 100).events.find((event) => event.level === "Focused level");
  assert.ok(above);
  assert.equal(above.distanceTicks, 5);
  assert.equal(above.qualifies, true);
  assert.ok(below);
  assert.equal(below.distanceTicks, 4);
  assert.equal(below.qualifies, true);
  assert.ok(crossing);
  assert.equal(crossing.distancePoints, 0);
  assert.equal(crossing.distanceTicks, 0);
  assert.equal(crossing.qualifies, true);
});

test("shared qualification helper accepts the exact floating-point tolerance boundary", () => {
  const result = qualifyLevelInteraction(3.00000000005, 3, 0.25);
  assert.equal(result.distanceTicks, 12);
  assert.equal(result.qualifies, true);
  const outsideEpsilon = qualifyLevelInteraction(3.00000000011, 3, 0.25);
  assert.equal(outsideEpsilon.distanceTicks, 13);
  assert.equal(outsideEpsilon.qualifies, false);
  const beyondTolerance = qualifyLevelInteraction(3.01, 3, 0.25);
  assert.equal(beyondTolerance.distanceTicks, 13);
  assert.equal(beyondTolerance.qualifies, false);
  assert.equal(levelInteractionDistance(100, 103, 99, 99.5, 100.5), 0, "ranged levels use their complete zone");
});

test("pullback qualification accepts a candle below a level through the configured twelve-tick zone", () => {
  const breakout = detectInitialBreakout(
    breakoutFixture(),
    { high: 102, low: 99, complete: true, completedAt: candle(2, 100, 102, 99, 101, 100).closeTime },
    config,
  );
  const level = { name: "Below-level test", price: 104.8 };
  const pullback = analyzePullback(breakoutFixture(), breakout, [level], specification, config);
  assert.equal(pullback.proximityTolerance, 3);
  assert.equal(pullback.events.some((event) => event.level === level.name && event.type === "proximity"), true);
  assert.equal(pullback.events.some((event) => event.level === level.name && event.type === "touch"), true);
  assert.equal(pullback.events.every((event) => event.detail.includes("tolerance is 3.00 points")), true);
});

test("dynamic pullback levels resolve from the causal L candle, not the latest candle", () => {
  const first = candle(0, 100, 100.2, 99.8, 100, 100);
  const levelCandle = candle(1, 101, 101.2, 100.8, 101, 100);
  const breakout: BreakoutEvent = {
    detected: true,
    direction: "long",
    time: first.closeTime,
    candleOpenTime: first.openTime,
    state: "QUALIFIED_BREAKOUT",
    candidateTime: first.closeTime,
    candidateCandleOpenTime: first.openTime,
    distanceOutside: 1,
    meaningfulDistance: 1,
    breakoutVolume: 100,
    baselineVolume: 100,
    volumeRatio: 1,
    volumeSupported: true,
    bodyRatio: 1,
    closeLocationRatio: 1,
    candleStructureSupported: true,
    continuationConfirmed: true,
    continuationCondition: "IMMEDIATE_DIRECTIONAL_EXTENSION",
    failed: false,
    detail: "fixture",
  };
  const shortEmaConfig = strategyConfig({ emaPeriod: 2 });
  const result = analyzePullback(
    [first, levelCandle],
    breakout,
    [{ name: "EMA 200", price: 999 }, { name: "VWAP", price: 999 }],
    specification,
    shortEmaConfig,
    { causalCandles: [first, levelCandle], calendar },
  );
  const event = result.events.find((item) => item.level === "EMA 200" && item.type === "proximity");
  assert.ok(event);
  assert.equal(event.price, 100.5);
  assert.notEqual(event.price, 101);
  const vwapEvent = result.events.find((item) => item.level === "VWAP" && item.type === "proximity");
  assert.ok(vwapEvent);
  assert.equal(vwapEvent.price, 100.5);
});

test("final-session dynamic values cannot qualify an earlier L candle", () => {
  const first = candle(0, 100, 100.2, 99.8, 100, 100);
  const levelCandle = candle(1, 101, 101.2, 100.8, 101, 100);
  const finalSessionCandle = candle(2, 150, 151, 149, 150, 100);
  const result = analyzePullback(
    [first, levelCandle, finalSessionCandle],
    breakoutAt(first),
    [{ name: "EMA 200", price: 999 }, { name: "VWAP", price: 999 }],
    specification,
    strategyConfig({ emaPeriod: 2 }),
    { causalCandles: [first, levelCandle], calendar },
  );
  const vwapEvent = result.events.find((item) => item.level === "VWAP" && item.candle?.openTime === levelCandle.openTime);
  const emaEvent = result.events.find((item) => item.level === "EMA 200" && item.candle?.openTime === levelCandle.openTime);
  assert.ok(vwapEvent);
  assert.ok(emaEvent);
  assert.equal(vwapEvent.price, 100.5);
  assert.equal(emaEvent.price, 100.5);
  assert.notEqual(vwapEvent.price, 150);
  assert.notEqual(emaEvent.price, 150);
});

test("complete detector qualifies fractional VWAP at exactly the twelve-tick boundary", () => {
  const first = candle(0, 105.1, 105.1, 105.1, 105.1, 100);
  const high = 98.7583333333333;
  const levelCandle = candle(1, high - 0.325, high, high - 0.7, high - 0.325, 100);
  const result = analyzePullback(
    [first, levelCandle],
    breakoutAt(first),
    [{ name: "VWAP", price: Number.NaN }],
    specification,
    strategyConfig(),
    { causalCandles: [first, levelCandle], calendar },
  );
  const event = result.events.find((item) => item.level === "VWAP" && item.type === "proximity");
  assert.ok(event);
  assert.ok(Math.abs(event.distancePoints - 3) < 1e-9);
  assert.equal(event.distanceTicks, 12);
  assert.equal(event.qualifies, true);
});

test("complete detector resolves EMA 200 at the causal L candle", () => {
  const first = candle(0, 100, 100.2, 99.8, 100, 100);
  const levelCandle = candle(1, 103.25, 103.5, 103, 103.25, 100);
  const result = analyzePullback(
    [first, levelCandle],
    breakoutAt(first),
    [{ name: "EMA 200", price: Number.NaN }],
    specification,
    strategyConfig({ emaPeriod: 2 }),
    { causalCandles: [first, levelCandle], calendar },
  );
  const event = result.events.find((item) => item.level === "EMA 200" && item.type === "proximity");
  assert.ok(event);
  assert.equal(event.price, 101.625);
  assert.equal(event.distancePoints, 1.375);
  assert.equal(event.distanceTicks, 6);
  assert.equal(event.qualifies, true);
});

test("changing ATR cannot widen, narrow, or replace the configured three-point qualifying area", () => {
  const prefix = [
    candle(0, 100, 100.5, 99.5, 100, 100),
    candle(1, 100, 100.5, 99.5, 100, 100),
    candle(2, 100, 102, 99, 101, 100),
  ];
  const levelCandle = candle(3, 96.75, 97, 96.5, 96.75, 100);
  const makeResult = (phase4AtrPeriod: number, high: number, low: number, close: number) => analyzePullback(
    [...prefix, candle(3, close, high, low, close, 100)],
    breakoutAt(prefix[2]!),
    [{ name: "ATR-invariant level", price: 100 }],
    specification,
    strategyConfig({ phase4AtrPeriod }),
  );
  const onePeriod = makeResult(1, levelCandle.high, levelCandle.low, levelCandle.close);
  const fourteenPeriod = makeResult(14, levelCandle.high, levelCandle.low, levelCandle.close);
  assert.notEqual(onePeriod.atr14, fourteenPeriod.atr14);
  for (const result of [onePeriod, fourteenPeriod]) {
    assert.equal(result.proximityTolerance, 3);
    const event = result.events.find((item) => item.level === "ATR-invariant level" && item.type === "proximity");
    assert.ok(event);
    assert.equal(event.distancePoints, 3);
    assert.equal(event.qualifies, true);
  }
  for (const result of [
    makeResult(1, 96.99, 96.5, 96.75),
    makeResult(14, 96.99, 96.5, 96.75),
  ]) {
    const event = result.events.find((item) => item.level === "ATR-invariant level");
    assert.ok(event);
    assert.equal(event.distanceTicks, 13);
    assert.equal(event.qualifies, false);
    assert.equal(result.events.some((item) => ["touch", "proximity"].includes(item.type)), false);
  }
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

test("Fibonacci levels freeze causally from a completed breakout", () => {
  const candles = breakoutFixture();
  const breakout = detectInitialBreakout(candles, { high: 102, low: 99, complete: true, completedAt: candles[2].closeTime }, config);
  const unavailable = fibonacciAnalysis(candles, breakout);
  assert.equal(unavailable.frozen, true);
  assert.ok(unavailable.levels.length > 0);
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
    events: [{
      type: "touch",
      time: candleCloseTime(3),
      level: "ORB high",
      price: 102,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      detail: "Pre-qualification interaction.",
    }],
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