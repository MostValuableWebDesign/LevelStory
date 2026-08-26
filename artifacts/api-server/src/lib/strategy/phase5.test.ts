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
  const patience = direction === "long" ? candle(1, 10.5, 11, 9, 10.8) : candle(1, 9.5, 11, 9, 9.2);
  return [previous, patience, trigger];
}

test("valid bullish patience candle triggers only on the immediate next candle", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 11.1, 10.2, 11)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "ENTRY TRIGGERED");
  assert.equal(result.triggerPrice, 11);
  assert.equal(result.patienceCandle?.isComplete, true);
});

test("valid bearish patience candle triggers below the patience low", () => {
  const result = patienceCandleEngine(setup("short", candle(2, 9.2, 9.8, 8.8, 8.9)), "short", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "ENTRY TRIGGERED");
  assert.equal(result.triggerPrice, 9);
});

test("an incomplete patience candle cannot be validated", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 9, 10.8, false),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE CANDLE FORMING");
  assert.equal(result.patienceCandle?.isComplete, false);
});

test("a closed patience candle with no next candle waits for the trigger window", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 11, 9.2, 10.6)).slice(0, 2), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "VALID PATIENCE CANDLE");
  assert.equal(result.triggerCandle, null);
});

test("a failed immediate trigger expires and a later candle cannot trigger it", () => {
  const candles = setup("long", candle(2, 10.8, 10.95, 9.1, 10.4));
  candles.push(candle(4, 10.4, 11.2, 10.1, 11.1));
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "EXPIRED");
  assert.match(result.detail, /new patience pattern/i);
});

test("an active trigger candle does not need to close", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 10.95, 9.2, 10.9, false)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "TRIGGER CANDLE ACTIVE");
});

test("bullish opposite-side-first gap invalidates the setup", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 8.8, 11.2, 8.5, 11, false)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "INVALIDATED");
  assert.equal(result.triggerPrice, 9);
});

test("bearish opposite-side-first gap invalidates the setup", () => {
  const result = patienceCandleEngine(setup("short", candle(2, 11.2, 11.5, 8.8, 8.9, false)), "short", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "INVALIDATED");
  assert.equal(result.triggerPrice, 11);
});

test("both sides touched without sequence proof are ambiguous", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10, 11.2, 8.8, 10.5)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "AMBIGUOUS");
  assert.equal(result.triggerPrice, null);
});

test("a proven first-touch sequence resolves a two-sided trigger conservatively", () => {
  const candles = setup("long", candle(2, 10, 11.2, 8.8, 10.5));
  const intended = patienceCandleEngine(candles, "long", {
    eligibilityEvents: eligibility(),
    intrabarEvidence: [{ candleOpenTime: candles[2].openTime, firstBreak: "intended-first" }],
  });
  const opposite = patienceCandleEngine(candles, "long", {
    eligibilityEvents: eligibility(),
    intrabarEvidence: [{ candleOpenTime: candles[2].openTime, firstBreak: "opposite-first" }],
  });
  assert.equal(intended.state, "ENTRY TRIGGERED");
  assert.equal(opposite.state, "INVALIDATED");
});

test("gaps through the intended side trigger at the opening print", () => {
  const bullish = patienceCandleEngine(setup("long", candle(2, 11.2, 11.5, 10.8, 11.3, false)), "long", { eligibilityEvents: eligibility() });
  const bearish = patienceCandleEngine(setup("short", candle(2, 8.8, 9.2, 8.5, 8.7, false)), "short", { eligibilityEvents: eligibility() });
  assert.equal(bullish.state, "ENTRY TRIGGERED");
  assert.equal(bearish.state, "ENTRY TRIGGERED");
});

test("pullback and consolidation locations can open patience eligibility", () => {
  const pullback: PullbackAnalysis = {
    status: "observed",
    events: [{ type: "touch", time: FIVE_MINUTES, level: "VWAP", price: 10, detail: "touch" }],
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
  assert.equal(result.state, "WAITING FOR PATIENCE CANDLE");
  assert.equal(result.eligible, false);
});