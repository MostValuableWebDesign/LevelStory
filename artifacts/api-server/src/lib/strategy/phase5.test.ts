import assert from "node:assert/strict";
import test from "node:test";
import { patienceCandleEngine, phase5PatienceAnalysis, type PatienceEligibilityEvent } from "./phase5.js";
import type { PullbackAnalysis } from "./phase4.js";
import type { Candle } from "./types.js";

const FIVE_MINUTES = 5 * 60_000;

function candle(index: number, open: number, high: number, low: number, close: number, isComplete = true): Candle {
  const openTime = index * FIVE_MINUTES;
  return { openTime, closeTime: openTime + FIVE_MINUTES, open, high, low, close, volume: 100, isComplete };
}

function eligibility(time = FIVE_MINUTES): PatienceEligibilityEvent[] {
  return [{ time, reason: "pullback", detail: "Retest reached a qualifying level." }];
}

function setup(direction: "long" | "short", trigger: Candle): Candle[] {
  const previous = direction === "long" ? candle(0, 10, 12, 8, 10.5) : candle(0, 10, 12, 8, 9.5);
  const patience = direction === "long" ? candle(1, 10.5, 11, 7, 10.8) : candle(1, 9.5, 13, 9, 9.2);
  return [previous, patience, trigger];
}

test("valid bullish patience candle triggers only on the immediate next candle", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 12.1, 10.2, 12)), "long", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.triggerPrice, 12);
  assert.equal(result.patienceCandle?.isComplete, true);
});

test("valid bearish patience candle triggers below the patience low", () => {
  const result = patienceCandleEngine(setup("short", candle(2, 9.2, 9.8, 7.8, 8)), "short", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.triggerPrice, 8);
});

test("an incomplete patience candle cannot be validated", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 9, 10.8, false),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE_CANDLE_FORMING");
  assert.equal(result.patienceCandle?.isComplete, false);
});

test("a closed patience candle with no next candle waits for the trigger window", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 11, 9.2, 10.6)).slice(0, 2), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE_CANDLE_VALID");
  assert.equal(result.triggerCandle, null);
});

test("a later candle cannot be stored as the immediate-next entry candle", () => {
  const candles = setup("long", candle(2, 10.8, 11, 9.2, 10.6)).slice(0, 2);
  candles.push(candle(4, 10.8, 12.1, 10.2, 12));
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE_CANDLE_EXPIRED");
  assert.equal(result.triggerCandle, null);
  assert.match(result.detail, /immediate-next entry candle is missing/i);
  assert.match(result.detail, /00:10:00\.000Z.*00:15:00\.000Z/);
});

test("a failed immediate trigger expires and a later candle cannot trigger it", () => {
  const candles = setup("long", candle(2, 10.8, 11.2, 10.1, 10.4));
  candles.push(candle(4, 10.4, 12.2, 10.1, 12.1));
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE_CANDLE_EXPIRED");
  assert.match(result.detail, /confirmation buffer|new patience pattern/i);
});

test("an earlier ORB pullback patience sequence is not overwritten by a later candidate", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 7, 10.8),
    candle(2, 10.8, 11.2, 10.1, 10.4),
    candle(3, 10.4, 11.1, 9.2, 10.8),
    candle(4, 10.8, 12.1, 10.2, 12),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.patienceCandle?.openTime, candles[3].openTime);
  assert.equal(result.triggerCandle?.openTime, candles[4].openTime);
});

test("an active trigger candle does not need to close", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 10.95, 9.2, 10.9, false)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "TRIGGER_CANDLE_ACTIVE");
});

test("bullish opposite-side-first gap invalidates the setup", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 8.8, 10.5, 6.5, 8, false)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "OPPOSITE_SIDE_INVALIDATION");
  assert.equal(result.triggerPrice, 7);
});

test("bearish opposite-side-first gap invalidates the setup", () => {
  const result = patienceCandleEngine(setup("short", candle(2, 11.2, 13.5, 9.2, 10, false)), "short", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "OPPOSITE_SIDE_INVALIDATION");
  assert.equal(result.triggerPrice, 13);
});

test("both sides touched without sequence proof are ambiguous", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10, 12.2, 6.8, 10.5)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "AMBIGUOUS_EVENT_ORDER");
  assert.equal(result.triggerPrice, null);
});

test("a proven first-touch sequence resolves a two-sided trigger conservatively", () => {
  const candles = setup("long", candle(2, 10, 12.2, 6.8, 10.5));
  const intended = patienceCandleEngine(candles, "long", {
    eligibilityEvents: eligibility(),
    intrabarEvidence: [{ candleOpenTime: candles[2].openTime, firstBreak: "intended-first" }],
  });
  const opposite = patienceCandleEngine(candles, "long", {
    eligibilityEvents: eligibility(),
    intrabarEvidence: [{ candleOpenTime: candles[2].openTime, firstBreak: "opposite-first" }],
  });
  assert.equal(intended.state, "ENTRY_TRIGGERED");
  assert.equal(opposite.state, "OPPOSITE_SIDE_INVALIDATION");
});

test("gaps through the intended side trigger at the opening print", () => {
  const bullish = patienceCandleEngine(setup("long", candle(2, 12.2, 12.5, 11.8, 12.3, false)), "long", { eligibilityEvents: eligibility() });
  const bearish = patienceCandleEngine(setup("short", candle(2, 7.8, 8.2, 7.5, 7.7, false)), "short", { eligibilityEvents: eligibility() });
  assert.equal(bullish.state, "ENTRY_BUFFER_REACHED");
  assert.equal(bearish.state, "ENTRY_BUFFER_REACHED");
});

test("raw patience breaks wait for the full confirmation buffer", () => {
  const bullish = patienceCandleEngine(setup("long", candle(2, 10.8, 11.1, 10.1, 10.9, false)), "long", { eligibilityEvents: eligibility() });
  const bearish = patienceCandleEngine(setup("short", candle(2, 9.2, 12, 8.9, 9, false)), "short", { eligibilityEvents: eligibility() });
  assert.equal(bullish.state, "BREAK_DETECTED_WAITING_FOR_BUFFER");
  assert.equal(bullish.entryBufferPrice, 12);
  assert.equal(bearish.state, "BREAK_DETECTED_WAITING_FOR_BUFFER");
  assert.equal(bearish.entryBufferPrice, 8);
});

test("three-tick confirmation is configurable and the thesis stop sits one tick beyond the opposite wick", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 11.75, 10.1, 11.7)), "long", {
    eligibilityEvents: eligibility(),
    entryBufferTicks: 3,
    stopBufferTicks: 1,
  });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.entryBufferTicks, 3);
  assert.equal(result.entryBufferPrice, 11.75);
  assert.equal(result.strategyStopPrice, 6.75);
});

test("neutral and opposing patience trends cannot qualify continuation patience", () => {
  const neutral = patienceCandleEngine(setup("long", candle(2, 10.8, 10.9, 10.1, 10.7)), "long", {
    eligibilityEvents: eligibility(),
    trend: "neutral",
  });
  const opposingShape = patienceCandleEngine([
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 13, 9, 12),
  ], "long", { eligibilityEvents: eligibility() });
  assert.equal(neutral.state, "PATIENCE_TREND_MISMATCH");
  assert.match(neutral.detail, /WAITING — TREND UNCLEAR/);
  assert.equal(opposingShape.state, "PATIENCE_TREND_MISMATCH");
});

test("buffer configuration rejects unsupported confirmation widths", () => {
  assert.throws(() => patienceCandleEngine([], "long", { entryBufferTicks: 2 }), /three or four ticks/i);
  assert.throws(() => patienceCandleEngine([], "long", { stopBufferTicks: 0 }), /at least one tick/i);
});

test("pullback and consolidation locations can open patience eligibility", () => {
  const pullback: PullbackAnalysis = {
    status: "observed",
    events: [{
      type: "touch",
      time: FIVE_MINUTES,
      level: "VWAP",
      price: 10,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      detail: "touch",
    }],
    evaluatedCandles: 1,
    maxCandles: 6,
    maxDurationMinutes: 30,
    elapsedMinutes: 5,
    proximityTolerance: 0.5,
    atr14: 1,
    qualifyingLevelCount: 1,
    detail: "observed",
  };
  const consolidation = { ...pullback, events: [{ ...pullback.events[0], type: "consolidation" as const }] };
  const candles = setup("long", candle(2, 10.8, 10.95, 9.2, 10.9));
  assert.equal(phase5PatienceAnalysis(candles, "long", pullback, null).eligibilityReason, "pullback");
  assert.equal(phase5PatienceAnalysis(candles, "long", consolidation, null).eligibilityReason, "consolidation");
});

test("extended consolidation inside NTZ can open patience eligibility", () => {
  const candles = [
    candle(0, 10, 11, 9, 10),
    candle(1, 10, 10.8, 9.2, 10.2),
    candle(2, 10.2, 10.7, 9.3, 10.3),
  ];
  const result = phase5PatienceAnalysis(candles, "long", {
    status: "pending",
    events: [],
    evaluatedCandles: 0,
    maxCandles: 6,
    maxDurationMinutes: 30,
    elapsedMinutes: 0,
    proximityTolerance: null,
    atr14: null,
    qualifyingLevelCount: 0,
    detail: "none",
  }, { high: 11, low: 9, complete: true });
  assert.equal(result.eligibilityReason, "ntz consolidation");
});

test("no qualifying location remains waiting", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 11.1, 10.2, 11)), "long");
  assert.equal(result.state, "WAITING_FOR_VALID_CONTEXT");
  assert.equal(result.eligible, false);
});