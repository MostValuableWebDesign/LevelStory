import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import { completedSimulatedHourlyCandles, generateSimulatedFuturesFeed, type SimulatedHourlyCandle } from "../futures/simulated-feed.js";
import { sessionCalendarForContract, timestampForTradingDate } from "../futures/session-calendar.js";
import { strategyConfig } from "./config.js";
import { completedEma, emaSlope, regularSessionVwap } from "./indicators.js";
import { majorLevels } from "./major-levels.js";
import { trendEvidence } from "./rules.js";
import type { Candle } from "./types.js";
import type { SessionLevels } from "./levels.js";

const specification = getFuturesContractSpecification("MES");
const calendar = sessionCalendarForContract(specification);
const config = strategyConfig();

function fiveMinuteCandle(index: number, close: number, open = close, complete = true): Candle {
  const openTime = timestampForTradingDate("2026-08-25", "09:30", calendar) + index * 5 * 60_000;
  return { openTime, closeTime: openTime + 5 * 60_000, open, high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, close, volume: 100 + index, isComplete: complete };
}

function hourlyReaction(index: number, kind: "support" | "resistance", price: number): SimulatedHourlyCandle {
  const openTime = Date.parse("2026-01-05T14:30:00.000Z") + index * 60 * 60_000;
  const open = kind === "support" ? price + 0.75 : price - 0.75;
  const close = kind === "support" ? price + 1.25 : price - 1.25;
  return {
    openTime,
    closeTime: openTime + 60 * 60_000,
    open,
    high: kind === "support" ? price + 1.75 : price - 0.25,
    low: kind === "support" ? price - 0.25 : price - 1.75,
    close,
    volume: 1_000 + index * 50,
    isComplete: true,
  };
}

function levelsFor(vwap: number, ema: number, slope: number): SessionLevels {
  return { vwap, ema, emaSlope: slope } as SessionLevels;
}

function fifteenMinuteCandles(
  direction: "bullish" | "bearish" | "mixed",
  count = 8,
): Candle[] {
  const candles: Candle[] = [];
  const start = timestampForTradingDate("2026-08-25", "09:30", calendar);
  for (let group = 0; group < count; group += 1) {
    const base = direction === "bullish" ? 100 + group : direction === "bearish" ? 120 - group : 110 + (group % 2 ? -2 : 0);
    for (let part = 0; part < 3; part += 1) {
      const openTime = start + (group * 3 + part) * 5 * 60_000;
      const close = direction === "bullish" ? base + 1 : direction === "bearish" ? base - 1 : base;
      candles.push({
        openTime,
        closeTime: openTime + 5 * 60_000,
        open: base,
        high: base + (direction === "bullish" ? 2 : direction === "bearish" ? 1 : 1),
        low: base - (direction === "bullish" ? 1 : direction === "bearish" ? 2 : 1),
        close,
        volume: 100,
        isComplete: true,
      });
    }
  }
  return candles;
}

test("completed EMA and slope ignore an incomplete five-minute candle", () => {
  const candles = [10, 11, 12, 13, 100].map((close, index) => fiveMinuteCandle(index, close, close, index < 4));
  const values = completedEma(candles, 3);
  assert.deepEqual(values.map((value) => Number(value.toFixed(3))), [10, 10.5, 11.25, 12.125]);
  assert.equal(Number(emaSlope(candles, 3, 2).toFixed(3)), 1.625);
});

test("regular-session VWAP resets at 09:30 ET and excludes other sessions", () => {
  const dayOneOpen = timestampForTradingDate("2026-08-24", "09:30", calendar);
  const dayTwoOpen = timestampForTradingDate("2026-08-25", "09:30", calendar);
  const candle = (openTime: number, price: number, volume: number): Candle => ({
    openTime,
    closeTime: openTime + 5 * 60_000,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume,
    isComplete: true,
  });
  const candles = [
    candle(timestampForTradingDate("2026-08-25", "04:00", calendar), 50, 10),
    candle(dayOneOpen, 100, 1),
    candle(dayOneOpen + 5 * 60_000, 102, 3),
    candle(dayTwoOpen, 200, 2),
    candle(dayTwoOpen + 5 * 60_000, 204, 2),
  ];
  assert.equal(regularSessionVwap(candles, calendar, "2026-08-24"), 101.5);
  assert.equal(regularSessionVwap(candles, calendar, "2026-08-25"), 202);
});

test("deterministic feed provides completed hourly history across a trading year", () => {
  const feed = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-25",
    days: 252,
    seed: 17,
    includePremarket: false,
  });
  const hourly = completedSimulatedHourlyCandles(feed, calendar);
  assert.equal(hourly.length > 1_400, true);
  assert.equal(hourly.every((candle) => candle.isComplete && candle.closeTime - candle.openTime === 60 * 60_000), true);
});

test("major levels require three reactions, merge nearby prices, and score confluence", () => {
  const hourly = [
    hourlyReaction(0, "support", 100),
    hourlyReaction(1, "support", 100.25),
    hourlyReaction(2, "support", 100.1),
    hourlyReaction(3, "resistance", 110),
    hourlyReaction(4, "resistance", 110.25),
    hourlyReaction(5, "resistance", 110.1),
    hourlyReaction(6, "support", 130),
  ];
  const levels = majorLevels(hourly, specification, strategyConfig({ majorLevelMinReactions: 3 }), [
    { name: "Prior day high", price: 100.2 },
    { name: "VWAP", price: 100.1 },
  ]);
  const support = levels.find((level) => level.kind === "support");
  const resistance = levels.find((level) => level.kind === "resistance");
  assert.equal(levels.length, 2);
  assert.equal(support?.reactionCount, 3);
  assert.equal(support?.confluence, "dynamite");
  assert.equal(support?.components.includes("Prior day high"), true);
  assert.equal(support?.components.includes("VWAP"), true);
  assert.equal((support?.strength ?? 0) > 0, true);
  assert.equal(resistance?.reactionCount, 3);
});

test("trend evidence requires eight completed 15-minute candles and reports all directions", () => {
  const bullish = trendEvidence(fifteenMinuteCandles("bullish"), levelsFor(100, 100, 1), config);
  const bearish = trendEvidence(fifteenMinuteCandles("bearish"), levelsFor(120, 120, -1), config);
  const neutral = trendEvidence(fifteenMinuteCandles("mixed"), levelsFor(110, 110, 0), config);
  const incomplete = trendEvidence(fifteenMinuteCandles("bullish", 7), levelsFor(100, 100, 1), config);

  assert.equal(bullish.direction, "bullish");
  assert.equal(bullish.structure, "higher highs / higher lows");
  assert.equal(bullish.candleCount, 8);
  assert.equal(bullish.evidenceItems.length, 4);
  assert.equal(bearish.direction, "bearish");
  assert.equal(bearish.structure, "lower highs / lower lows");
  assert.equal(neutral.direction, "neutral");
  assert.equal(incomplete.direction, "neutral");
  assert.equal(incomplete.candleCount, 7);
});