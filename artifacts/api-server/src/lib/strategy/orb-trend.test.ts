import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import { sessionCalendarForContract, timestampForTradingDate } from "../futures/session-calendar.js";
import { strategyConfig } from "./config.js";
import { evaluateOrbTrend } from "./orb-trend.js";
import type { Candle } from "./types.js";

const specification = getFuturesContractSpecification("MES");
const calendar = sessionCalendarForContract(specification);
const config = strategyConfig();
const sessionStart = timestampForTradingDate("2026-08-25", "09:30", calendar);

function candle(index: number, close: number, high = close, low = close, open = close): Candle {
  const openTime = sessionStart + index * 5 * 60_000;
  return {
    openTime,
    closeTime: openTime + 5 * 60_000,
    open,
    high,
    low,
    close,
    volume: 100,
    isComplete: true,
  };
}

const ntz = {
  high: 100,
  low: 90,
  completedAt: candle(2, 95).closeTime,
  complete: true,
};

test("ORB trend establishes, reverses, and creates a unique epoch per direction", () => {
  const result = evaluateOrbTrend([
    candle(0, 95, 100, 90),
    candle(1, 95, 99, 91),
    candle(2, 95, 98, 92),
    candle(3, 101, 102, 94),
    candle(4, 98, 101, 95),
    candle(5, 89, 96, 88),
    candle(6, 92, 95, 90),
    candle(7, 101, 102, 94),
  ], ntz, config, { contractSymbol: "MES", tradingDate: "2026-08-25", tickSize: specification.tickSize });

  assert.deepEqual(result.transitions.map((transition) => transition.newState), [
    "BULLISH_ORB_TREND",
    "BEARISH_ORB_TREND",
    "BULLISH_ORB_TREND",
  ]);
  assert.equal(new Set(result.transitions.map((transition) => transition.epochId)).size, 3);
  assert.equal(result.state, "BEARISH_ORB_TREND");
  assert.equal(result.direction, "short");
});

test("wick-only breaks and inside closes preserve the active ORB trend", () => {
  const result = evaluateOrbTrend([
    candle(0, 95, 100, 90),
    candle(1, 95, 99, 91),
    candle(2, 95, 98, 92),
    candle(3, 101, 102, 94),
    candle(4, 98, 101, 95),
    candle(5, 90, 96, 88),
  ], ntz, config, { contractSymbol: "MES", tradingDate: "2026-08-25", tickSize: specification.tickSize });

  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0]?.newState, "BULLISH_ORB_TREND");
  assert.equal(result.trendDirectionAt(candle(4, 98).openTime), "long");
  assert.equal(result.trendDirectionAt(candle(5, 90).openTime), "long");
});

test("ORB reversal becomes effective on the candle after the confirming close", () => {
  const confirming = candle(3, 101, 102, 94);
  const following = candle(4, 89, 95, 88);
  const result = evaluateOrbTrend([
    candle(0, 95, 100, 90),
    candle(1, 95, 99, 91),
    candle(2, 95, 98, 92),
    confirming,
    following,
    candle(5, 95, 98, 91),
    candle(6, 89, 95, 88),
  ], ntz, config, { contractSymbol: "MES", tradingDate: "2026-08-25", tickSize: specification.tickSize });

  const transition = result.transitions[1];
  assert.ok(transition);
  assert.equal(result.trendDirectionAt(confirming.openTime), null);
  assert.equal(result.trendDirectionAt(following.openTime), "long");
  assert.equal(result.trendDirectionAt(candle(5, 95).openTime), "short");
  assert.equal(transition.confirmingCandle.closeTime, following.closeTime);
  assert.equal(transition.effectiveFromTimestamp, following.closeTime);
  assert.equal(transition.expirationReason, "ORB_TREND_REVERSED");
});

test("neutral bearish establishment and exact confirmation-buffer boundaries are causal", () => {
  const result = evaluateOrbTrend([
    candle(0, 95, 100, 90),
    candle(1, 95, 99, 91),
    candle(2, 95, 98, 92),
    candle(3, 89.5, 95, 88),
  ], ntz, config, { contractSymbol: "MES", tradingDate: "2026-08-25", tickSize: specification.tickSize });

  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0]?.previousState, "NEUTRAL");
  assert.equal(result.transitions[0]?.newState, "BEARISH_ORB_TREND");
  assert.equal(result.transitions[0]?.boundaryCrossed, "ORB_LOW");
  assert.equal(result.transitions[0]?.confirmationBufferPoints, 0.5);
});

test("ORB transition evidence reports active-position blocking without changing trend state", () => {
  const result = evaluateOrbTrend([
    candle(0, 95, 100, 90),
    candle(1, 95, 99, 91),
    candle(2, 95, 98, 92),
    candle(3, 101, 102, 94),
    candle(4, 89, 95, 88),
  ], ntz, config, {
    contractSymbol: "MES",
    tradingDate: "2026-08-25",
    tickSize: specification.tickSize,
    activePositionAt: () => true,
  });

  assert.equal(result.transitions.length, 2);
  assert.equal(result.transitions[1]?.activePositionBlocked, true);
  assert.equal(result.transitions[1]?.newState, "BEARISH_ORB_TREND");
  assert.deepEqual(result.transitions[1]?.expiredArmIds, []);
  assert.deepEqual(result.transitions[1]?.expiredCandidateIds, []);
});