import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import { sessionCalendarForContract, timestampForTradingDate } from "../futures/session-calendar.js";
import { strategyConfig } from "./config.js";
import { analyzePullback, classifyRetracement, detectInitialBreakout, fibonacciAnalysis, phase4Volume } from "./phase4.js";
import type { Candle } from "./types.js";

const specification = getFuturesContractSpecification("MES");
const calendar = sessionCalendarForContract(specification);
const config = strategyConfig();

function candle(index: number, open: number, high: number, low: number, close: number, volume: number, complete = true): Candle {
  const openTime = timestampForTradingDate("2026-08-25", "09:30", calendar) + index * 5 * 60_000;
  return { openTime, closeTime: openTime + 5 * 60_000, open, high, low, close, volume, isComplete: complete };
}

function breakoutFixture(): Candle[] {
  return [
    candle(0, 99.5, 100, 99, 99.5, 100),
    candle(1, 99.5, 101, 99, 100, 100),
    candle(2, 100, 102, 99, 101, 100),
    candle(3, 101, 102.2, 100.5, 101.5, 100),
    candle(4, 101.5, 102.5, 100.8, 101.6, 100),
    candle(5, 101.6, 102.3, 100.9, 101.7, 100),
    candle(6, 101.5, 105, 101.5, 104, 130),
    candle(7, 104, 104.5, 101.4, 102.1, 80),
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
  assert.equal(breakout.distanceOutside, 2);
  assert.equal(breakout.breakoutVolume, 130);
  assert.equal(breakout.volumeSupported, true);
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
  const automatic = fibonacciAnalysis(candles, breakout);
  assert.equal(automatic.direction, "bullish");
  assert.equal(automatic.impulseLow, 99);
  assert.equal(automatic.impulseHigh, 105);
  assert.deepEqual(automatic.levels.map((level) => level.label), ["0%", "23.6%", "38.2%", "40.0%", "50.0%", "61.8%", "78.6%", "100%"]);
  const before = automatic.impulseHigh;
  const later = fibonacciAnalysis([...candles, candle(11, 101, 110, 95, 100, 100)], breakout);
  assert.equal(later.impulseHigh, before);
  const manual = fibonacciAnalysis(candles, breakout, { low: 100, high: 110 });
  assert.equal(manual.manualCorrection, true);
  assert.equal(manual.impulseLow, 100);
  assert.equal(manual.impulseHigh, 110);
  for (const [depth, expected] of [[10, "shallow"], [40, "normal"], [55, "deep"], [75, "elevated failure risk"], [100, "fully retraced"]] as const) {
    assert.equal(classifyRetracement(depth), expected);
  }
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