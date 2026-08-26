import test from "node:test";
import assert from "node:assert/strict";
import {
  detectExtendedNtzConsolidation,
  detectReversalEvidence,
  evaluateBonusReversal,
  evaluateExtendedNtzConsolidationBreakout,
  evaluateOrbBreakPullbackContinuation,
  hasEquivalentOpposingCandles,
  isDoji,
  phase6Analysis,
  type Phase6Context,
} from "./phase6.js";
import { strategyConfig } from "./config.js";
import type { MajorLevel } from "./major-levels.js";
import type { Candle } from "./types.js";

const config = strategyConfig();

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 100, isComplete = true): Candle {
  return { openTime, closeTime: openTime + 300_000, open, high, low, close, volume, isComplete };
}

function ntz() {
  return { high: 10, low: 9, complete: true, completedAt: 0 };
}

function major(price = 10): MajorLevel {
  return {
    name: "Major resistance 10.00",
    kind: "resistance",
    price,
    zoneLow: price - 0.25,
    zoneHigh: price + 0.25,
    reactionCount: 4,
    strength: 80,
    recencyScore: 1,
    reactionMagnitude: 1,
    volumeScore: 1,
    components: ["Hourly resistance"],
    componentCount: 1,
    confluence: "normal",
  };
}

function patience(state: "ENTRY_TRIGGERED" | "PATIENCE_CANDLE_VALID" | "PATIENCE_CANDLE_EXPIRED" | "AMBIGUOUS_EVENT_ORDER" = "ENTRY_TRIGGERED") {
  return {
    state,
    eligible: true,
    eligibilityReason: "pullback" as const,
    eligibilityTime: 1,
    trend: "bullish" as const,
    previousCandle: { openTime: 1, closeTime: 2, open: 10, high: 10.4, low: 9.6, close: 10.1, isComplete: true },
    patienceCandle: { openTime: 2, closeTime: 3, open: 10, high: 10.2, low: 9.8, close: 10.15, isComplete: true },
    triggerCandle: { openTime: 3, closeTime: 4, open: 10.15, high: 10.3, low: 10.1, close: 10.25, isComplete: true },
    entryBufferTicks: 4,
    entryBufferPrice: 11.2,
    stopBufferTicks: 1,
    strategyStopPrice: 9.55,
    triggerPrice: 10.2,
    stateTime: 3,
    detail: `Patience state ${state}.`,
  };
}

function baseContext(overrides: Partial<Phase6Context> = {}): Phase6Context {
  return {
    candles: [candle(0, 9.8, 10, 9.7, 9.9), candle(300_000, 9.9, 10.1, 9.8, 10.05)],
    levels: {
      levels: [{ name: "Prior day high", price: 10.5 }],
      orb: { high: 10, low: 9 },
      orbComplete: true,
      ntz: ntz(),
      ntzPhase: "completed",
      ntzPosition: "outside",
      ntzEvents: [],
      vwap: 10,
      ema: 9.8,
      rsi: 55,
      volumeRatio: 1.4,
      fibonacci: [{ name: "Fib 0.5", price: 10.1 }],
      emaSlope: 0.1,
      majorLevels: [major()],
      previousDayClose: 9.8,
    },
    breakout: {
      detected: true,
      direction: "long",
      state: "WAITING_FOR_PULLBACK",
      time: 1,
      candleOpenTime: 0,
      candidateTime: 1,
      candidateCandleOpenTime: 0,
      distanceOutside: 0.2,
      meaningfulDistance: 0.2,
      breakoutVolume: 200,
      baselineVolume: 100,
      volumeRatio: 2,
      volumeSupported: true,
      bodyRatio: 0.8,
      closeLocationRatio: 0.9,
      candleStructureSupported: true,
      continuationConfirmed: true,
      continuationCondition: "IMMEDIATE_DIRECTIONAL_EXTENSION",
      failed: false,
      detail: "Bullish breakout closed outside NTZ.",
    },
    pullback: {
      status: "observed",
      events: [{ type: "touch", time: 2, level: "Prior day high", price: 10.5, detail: "Touched level." }],
      evaluatedCandles: 1,
      maxCandles: 6,
      maxDurationMinutes: 30,
      elapsedMinutes: 5,
      proximityTolerance: 0.1,
      atr14: 0.1,
      qualifyingLevelCount: 1,
      detail: "Pullback observed.",
    },
    fibonacci: {
      direction: "bullish",
      impulseLow: 9,
      impulseHigh: 10.3,
      breakoutTime: 1,
      frozen: true,
      frozenAt: 2,
      manualCorrection: false,
      levels: [{ name: "Fib 0.5", label: "50%", ratio: 0.5, price: 9.65 }],
      retracementPercent: 25,
      classification: "shallow",
      detail: "Frozen.",
    },
    volume: {
      baselineCandleCount: 6,
      recentSixAverage: 100,
      breakoutVolume: 200,
      breakoutRatio: 2,
      supportingBreakoutVolume: true,
      averageImpulseVolume: 100,
      pullbackAverageVolume: 100,
      pullbackToBreakoutRatio: 0.5,
      pullbackToImpulseRatio: 1,
      pullbackToRecentRatio: 1,
      opposingPullbackVolume: 50,
      reversalWarning: null,
    },
     patience: patience(),
     reversalPatience: patience("PATIENCE_CANDLE_VALID"),
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
    riskApproved: true,
    config,
    ...overrides,
  };
}

test("ORB continuation qualifies only when every mandatory rule passes", () => {
  const result = evaluateOrbBreakPullbackContinuation(baseContext());
  assert.equal(result.setupType, "ORB_BREAK_PULLBACK_CONTINUATION");
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.mandatoryPassed, true);
  assert.ok(result.rules.filter((rule) => rule.mandatory).every((rule) => rule.passed));
});

test("ORB continuation never qualifies when any mandatory gate fails", () => {
  const gates: Array<[string, Partial<Phase6Context>]> = [
    ["NTZ", { levels: { ...baseContext().levels, ntz: { ...ntz(), complete: false } } }],
    ["completed breakout", { breakout: { ...baseContext().breakout, detected: false, direction: null } }],
    ["trend", { trend: { direction: "neutral", structure: "mixed structure" } }],
    ["pullback", { pullback: { ...baseContext().pullback, events: [] } }],
    ["volume", { volume: { ...baseContext().volume, reversalWarning: "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" } }],
    ["context", { fibonacci: { ...baseContext().fibonacci, frozen: false, levels: [] } }],
     ["patience", { patience: patience("PATIENCE_CANDLE_VALID") }],
     ["immediate trigger", { patience: patience("PATIENCE_CANDLE_EXPIRED") }],
    ["risk", { riskApproved: false }],
  ];
  for (const [name, overrides] of gates) {
    const result = evaluateOrbBreakPullbackContinuation(baseContext(overrides));
    assert.notEqual(result.decision, "SETUP QUALIFIED", `${name} gate must block qualification`);
    assert.equal(result.rules.filter((rule) => rule.mandatory).every((rule) => rule.passed), false, `${name} gate should fail`);
  }
});

test("extended NTZ consolidation requires 9 to 12 contiguous five-minute candles", () => {
  const candles = Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96));
  const result = detectExtendedNtzConsolidation(candles, ntz());
  assert.equal(result.detected, true);
  assert.equal(result.candleCount, 9);
  assert.equal(result.durationMinutes, 45);
  assert.equal(result.insideOrNearCount, 9);
  assert.equal(result.expansionRatio, 1);
});

test("extended consolidation rejects a materially expanding range", () => {
  const candles = Array.from({ length: 9 }, (_, index) => index < 4
    ? candle(index * 300_000, 9.95, 9.96, 9.94, 9.95)
    : candle(index * 300_000, 9.95, 10.1, 9.9, 9.96));
  const result = detectExtendedNtzConsolidation(candles, ntz());
  assert.equal(result.detected, true);
  assert.ok((result.expansionRatio ?? 0) > 1.25);
  const evaluated = evaluateExtendedNtzConsolidationBreakout(baseContext({ candles }));
  assert.equal(evaluated.rules.find((rule) => rule.key === "rangeStable")?.passed, false);
  assert.notEqual(evaluated.decision, "SETUP QUALIFIED");
});

test("extended consolidation does not require a pullback", () => {
  const candles = Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96));
  const result = evaluateExtendedNtzConsolidationBreakout(baseContext({
    candles,
    pullback: { ...baseContext().pullback, events: [] },
  }));
  assert.equal(result.rules.find((rule) => rule.key === "pullback")?.mandatory, undefined);
  assert.equal(result.rules.find((rule) => rule.key === "extendedConsolidation")?.passed, true);
});

test("extended consolidation qualifies with a breakout and NTZ-eligible patience window", () => {
  const candles = Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96));
  const result = evaluateExtendedNtzConsolidationBreakout(baseContext({
    candles,
     patience: { ...patience(), eligibilityReason: "ntz consolidation" },
  }));
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.mandatoryPassed, true);
});

test("Phase 6 uses the exact doji and equivalent-candle defaults", () => {
  assert.equal(isDoji(candle(0, 10, 10.1, 9.9, 10.02), 0.1), true);
  assert.equal(isDoji(candle(0, 10, 10.1, 9.9, 10.03), 0.1), false);
  const first = candle(0, 9.8, 10.01, 9.79, 10);
  const second = candle(300_000, 10, 10.01, 9.79, 9.81);
  assert.equal(hasEquivalentOpposingCandles([first, second], [major(10)], config), true);
  const tooDifferent = candle(300_000, 10, 10.01, 9.79, 9.84);
  assert.equal(hasEquivalentOpposingCandles([first, tooDifferent], [major(10)], config), false);
});

test("bonus reversal exposes independent evidence and remains alert-only", () => {
  const context = baseContext({
    candles: [
      candle(0, 9.8, 10.01, 9.79, 10),
      candle(300_000, 10, 10.01, 9.79, 9.81),
      candle(600_000, 10, 10.04, 9.96, 10.005),
      candle(900_000, 10.005, 10.01, 9.8, 9.85),
      candle(1_200_000, 9.85, 10.04, 9.8, 9.855),
    ],
    levels: { ...baseContext().levels, ntzEvents: [{ type: "Failed breakout", time: 1, detail: "Failed." }] },
    fibonacci: { ...baseContext().fibonacci, classification: "deep" },
    volume: { ...baseContext().volume, reversalWarning: "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" },
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
     reversalPatience: patience("PATIENCE_CANDLE_VALID"),
  });
  const evidence = detectReversalEvidence(context);
  assert.equal(evidence.alert, true);
  assert.equal(evidence.dojiAtMajorLevel, true);
  assert.equal(evidence.equivalentOpposingCandles, true);
  assert.equal(evidence.failedBreakout, true);
  assert.equal(evidence.strongOpposingVolume, true);
  assert.equal(evidence.deepFibonacciRetracement, true);
  const result = evaluateBonusReversal(context);
  assert.equal(result.alertOnly, true);
  assert.equal(result.decision, "POSSIBLE REVERSAL");
  assert.equal(result.rules.find((rule) => rule.key === "immediateTrigger")?.passed, false);
});

test("bonus reversal can qualify only as an alert-only descriptive setup", () => {
  const context = baseContext({
    candles: [
      candle(0, 9.8, 10.01, 9.79, 10),
      candle(300_000, 10, 10.01, 9.79, 9.81),
      candle(600_000, 10, 10.04, 9.96, 10.005),
      candle(900_000, 10.005, 10.01, 9.8, 9.85),
      candle(1_200_000, 9.85, 10.04, 9.8, 9.855),
    ],
    levels: { ...baseContext().levels, ntzEvents: [{ type: "Failed breakout", time: 1, detail: "Failed." }] },
    fibonacci: { ...baseContext().fibonacci, classification: "deep" },
    volume: { ...baseContext().volume, reversalWarning: "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" },
    trend: { direction: "bearish", structure: "lower highs / lower lows" },
    breakout: { ...baseContext().breakout, direction: "long" },
     reversalPatience: patience("ENTRY_TRIGGERED"),
  });
  const result = evaluateBonusReversal(context);
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.alertOnly, true);
  assert.equal(result.mandatoryPassed, true);
});

test("reversal requires directional confirmation, patience, immediate trigger, and risk", () => {
  const result = evaluateBonusReversal(baseContext({
    candles: [candle(0, 10, 10.04, 9.96, 10.005)],
     reversalPatience: patience("PATIENCE_CANDLE_EXPIRED"),
    riskApproved: false,
    trend: { direction: "neutral", structure: "mixed structure" },
  }));
  assert.equal(result.decision, "EXPIRED");
  assert.equal(result.mandatoryPassed, false);
  assert.equal(result.rules.filter((rule) => rule.mandatory).every((rule) => rule.passed), false);
});

test("Phase 5 expiration and ambiguity propagate to setup decisions", () => {
  const expired = phase6Analysis(baseContext({ patience: patience("PATIENCE_CANDLE_EXPIRED") }));
  assert.equal(expired.evaluations[0].decision, "EXPIRED");
  const ambiguous = phase6Analysis(baseContext({ patience: patience("AMBIGUOUS_EVENT_ORDER") }));
  assert.equal(ambiguous.evaluations[0].decision, "AMBIGUOUS");
  assert.ok(["NO TRADE", "WAITING", "SETUP FORMING", "SETUP QUALIFIED", "POSSIBLE REVERSAL", "EXPIRED", "AMBIGUOUS"].includes(ambiguous.decision));
});