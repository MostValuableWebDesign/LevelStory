import test from "node:test";
import assert from "node:assert/strict";
import {
  detectExtendedNtzConsolidation,
  evaluateConsolidationEntryGuard,
  detectReversalEvidence,
  evaluateBonusReversal,
  evaluateStrongBreakoutAfterConsolidation,
  evaluateExtendedNtzConsolidationBreakout,
  evaluateOrbBreakPullbackContinuation,
  evaluateEarlyOrbMomentumContinuation,
  hasEquivalentOpposingCandles,
  isDoji,
  phase6Analysis,
  type Phase6Context,
} from "./phase6.js";
import { strategyConfig } from "./config.js";
import type { DynamiteLevel, MajorLevel } from "./major-levels.js";
import type { Candle } from "./types.js";
import { STRATEGY_COMPONENT_TYPES, STRATEGY_IDS, STRATEGY_OUTCOME_TYPES, strategyIdsIncludingLegacy } from "./taxonomy.js";

const config = strategyConfig();

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 100, isComplete = true): Candle {
  return { openTime, closeTime: openTime + 300_000, open, high, low, close, volume, isComplete };
}

function withCausalBaseline(candles: Candle[]): Candle[] {
  const firstOpenTime = candles[0]?.openTime ?? 0;
  const baseline = Array.from({ length: 12 }, (_, index) =>
    candle(firstOpenTime - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
  return [...baseline, ...candles];
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

function patience(state: "ENTRY_TRIGGERED" | "PATIENCE_CANDLE_VALID" | "PATIENCE_CANDLE_EXPIRED" | "AMBIGUOUS_EVENT_ORDER" = "ENTRY_TRIGGERED", trend: "bullish" | "bearish" = "bullish", direction?: "long" | "short") {
  return {
    state,
    direction,
    eligible: true,
    eligibilityReason: "pullback" as const,
    eligibilityTime: 1,
    trend,
    previousCandle: { openTime: 1, closeTime: 2, open: 10, high: 10.4, low: 9.6, close: 10.1, isComplete: true },
    patienceCandle: { openTime: 2, closeTime: 3, open: 10, high: 10.2, low: 9.8, close: 10.15, isComplete: true },
    triggerCandle: { openTime: 3, closeTime: 4, open: 10.15, high: 10.3, low: 10.1, close: 10.25, isComplete: true },
    entryBufferTicks: 8,
    entryBufferPrice: 12.2,
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
      events: [{
        type: "touch",
        time: 2,
        level: "Prior day high",
        price: 10.5,
        distancePoints: 0,
        distanceTicks: 0,
        tolerancePoints: 3,
        toleranceTicks: 12,
        qualifies: true,
        detail: "Touched level.",
      }],
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
    trend: { direction: "bullish", structure: "higher highs / higher lows", score: 6, candleCount: 8, evidenceItems: [{ key: "structure", status: "positive" }, { key: "vwap", status: "positive" }, { key: "ema", status: "positive" }, { key: "emaSlope", status: "positive" }] },
    riskApproved: true,
    config,
    ...overrides,
  };
}

test("ORB continuation qualifies only when every mandatory rule passes", () => {
  const result = evaluateOrbBreakPullbackContinuation(baseContext());
  assert.equal(result.setupType, "ORB_PULLBACK_CONTINUATION");
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.mandatoryPassed, true);
  assert.ok(result.rules.filter((rule) => rule.mandatory).every((rule) => rule.passed));
});

test("early ORB momentum qualifies without pullback or trend evidence", () => {
  const result = evaluateEarlyOrbMomentumContinuation(baseContext({
    pullback: { ...baseContext().pullback, status: "pending", events: [] },
    trend: { direction: "neutral", structure: "neutral" },
    earlyOrbMomentum: {
      ...patience("ENTRY_TRIGGERED", "bullish", "long"),
      eligibilityReason: "early orb momentum",
      direction: "long",
    },
  }));
  assert.equal(result.setupType, "EARLY_ORB_MOMENTUM_CONTINUATION");
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.mandatoryPassed, true);
});

test("Dynamite boosts only a matching qualified signal and preserves its confluence evidence", () => {
  const result = phase6Analysis(baseContext({
    patience: { ...patience(), direction: "long" },
    dynamiteLevels: [{
      id: "dynamite|10.00|10.25",
      lower: 10,
      upper: 10.25,
      representative: 10.125,
      includedLevelIds: ["vwap", "ema-200"],
      includedTypes: ["VWAP", "EMA 200"],
      includedLevelValues: [10, 10.25],
      sourceFamilies: ["vwap", "ema-200"],
      confluenceCount: 2,
      observedAt: 3,
      pullbackInteracted: true,
      pullbackInteractions: [{
        eventId: "pullback-1",
        eventTime: 2,
        candleOpenTime: 2,
        price: 10,
        level: "VWAP",
      }],
    } satisfies DynamiteLevel],
  }));
  const orb = result.evaluations.find((evaluation) => evaluation.setupType === "ORB_PULLBACK_CONTINUATION");
  assert.equal(orb?.decision, "SETUP QUALIFIED");
  assert.equal(orb?.dynamiteConfluenceCount, 2);
  assert.equal(orb?.grade, 1);
  assert.ok(orb?.supportingConfluences?.some((item) => item.includes("Dynamite dynamite|10.00|10.25")));
});

test("a rejected pullback event cannot satisfy a Phase 6 pullback rule", () => {
  const context = baseContext({
    pullback: {
      ...baseContext().pullback,
      events: [{ ...baseContext().pullback.events[0]!, qualifies: false }],
    },
  });
  const result = phase6Analysis(context);
  assert.notEqual(result.evaluations.find((evaluation) => evaluation.setupType === "ORB_PULLBACK_CONTINUATION")?.decision, "SETUP QUALIFIED");
});

test("Dynamite ignores an earlier unrelated interaction instead of using broad time matching", () => {
  const result = phase6Analysis(baseContext({
    patience: {
      ...patience(),
      direction: "long",
      eligibilityProvenance: { eventId: "pullback-current", reason: "pullback", time: 2, detail: "current" },
    },
    dynamiteLevels: [{
      id: "dynamite|10.00|10.25",
      lower: 10,
      upper: 10.25,
      representative: 10.125,
      includedLevelIds: ["vwap", "ema-200"],
      includedTypes: ["VWAP", "EMA 200"],
      includedLevelValues: [10, 10.25],
      sourceFamilies: ["vwap", "ema-200"],
      confluenceCount: 2,
      observedAt: 3,
      pullbackInteracted: true,
      pullbackInteractions: [{
        eventId: "pullback-earlier",
        eventTime: 1,
        candleOpenTime: 1,
        price: 10,
        level: "VWAP",
      }],
    } satisfies DynamiteLevel],
  }));
  const orb = result.evaluations.find((evaluation) => evaluation.setupType === "ORB_PULLBACK_CONTINUATION");
  assert.equal(orb?.dynamiteConfluenceCount, 0);
  assert.equal(orb?.grade, 0);
});

test("ORB qualification does not require strong-breakout volume or body classification", () => {
  const context = baseContext({
    breakout: {
      ...baseContext().breakout,
      volumeSupported: false,
      bodyRatio: 0,
      closeLocationRatio: 0,
      candleStructureSupported: false,
    },
    volume: { ...baseContext().volume, supportingBreakoutVolume: false },
  });
  const result = evaluateOrbBreakPullbackContinuation(context);
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.rules.some((rule) => rule.key === "strongBreakout" || rule.key === "breakoutVolume"), false);
});

test("ORB continuation does not qualify a boundary probe without a completed ORB close", () => {
  const result = evaluateOrbBreakPullbackContinuation(baseContext({
    breakout: {
      ...baseContext().breakout,
      detected: false,
      continuationConfirmed: false,
      state: "ORB_PROBE_WAIT",
    },
  }));
  assert.notEqual(result.decision, "SETUP QUALIFIED");
  assert.equal(result.rules.find((rule) => rule.key === "closeOutsideNtz")?.passed, false);
});

test("taxonomy exposes six strategies and separates components from outcomes", () => {
  assert.deepEqual(STRATEGY_IDS, [
    "ORB_PULLBACK_CONTINUATION",
    "EARLY_ORB_MOMENTUM_CONTINUATION",
    "CONSOLIDATION_BREAKOUT_CONTINUATION",
    "PATIENCE_CANDLE_CONTINUATION",
    "EQUIVALENT_CANDLE_REVERSAL",
    "PEAK_RETRACEMENT_REVERSAL",
  ]);
  assert.ok(STRATEGY_COMPONENT_TYPES.includes("BULLISH_PATIENCE"));
  assert.ok(STRATEGY_COMPONENT_TYPES.includes("ENTRY_CONFIRMATION_FAILED"));
  assert.deepEqual(STRATEGY_OUTCOME_TYPES, [
    "QUALIFIED_TRADE",
    "ENTRY_CONFIRMATION_FAILED",
    "ENTRY_CONFIRMED",
    "RISK_REJECTED",
    "RISK_APPROVED_EXECUTION_UNAVAILABLE",
    "MODELED_TRADE",
    "STOP_EXIT",
    "TARGET_EXIT",
    "RUNNER_EXIT",
  ]);
  assert.deepEqual(strategyIdsIncludingLegacy("ORB_PULLBACK_CONTINUATION"), [
    "ORB_PULLBACK_CONTINUATION", "ORB_BREAK_PULLBACK_CONTINUATION",
  ]);
  assert.deepEqual(strategyIdsIncludingLegacy("CONSOLIDATION_BREAKOUT_CONTINUATION"), [
    "CONSOLIDATION_BREAKOUT_CONTINUATION", "STRONG_BREAKOUT_AFTER_CONSOLIDATION", "EXTENDED_NTZ_CONSOLIDATION_BREAKOUT",
  ]);
});

test("a pullback or patience candle without its strategy context cannot qualify", () => {
  const noPatience = evaluateOrbBreakPullbackContinuation(baseContext({
    patience: patience("PATIENCE_CANDLE_EXPIRED"),
  }));
  assert.notEqual(noPatience.decision, "SETUP QUALIFIED");

  const noContext = evaluateOrbBreakPullbackContinuation(baseContext({
    breakout: { ...baseContext().breakout, detected: false, direction: null },
    pullback: { ...baseContext().pullback, events: [] },
  }));
  assert.notEqual(noContext.decision, "SETUP QUALIFIED");
});

test("consolidation breakout requires a strong breakout and shared patience sequence", () => {
  const candles = Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96));
  const noConsolidation = evaluateStrongBreakoutAfterConsolidation(baseContext());
  assert.notEqual(noConsolidation.decision, "SETUP QUALIFIED");

  const noPatience = evaluateStrongBreakoutAfterConsolidation(baseContext({
    candles,
    patience: patience("PATIENCE_CANDLE_VALID"),
  }));
  assert.notEqual(noPatience.decision, "SETUP QUALIFIED");
});

test("ORB continuation never qualifies when an actual mandatory gate fails", () => {
  const gates: Array<[string, Partial<Phase6Context>]> = [
    ["NTZ", { levels: { ...baseContext().levels, ntz: { ...ntz(), complete: false } } }],
    ["completed breakout", { breakout: { ...baseContext().breakout, detected: false, direction: null } }],
    ["context", { pullback: { ...baseContext().pullback, events: [] }, fibonacci: { ...baseContext().fibonacci, frozen: false, levels: [] } }],
     ["patience", { patience: patience("PATIENCE_CANDLE_VALID") }],
     ["immediate trigger", { patience: patience("PATIENCE_CANDLE_EXPIRED") }],
  ];
  for (const [name, overrides] of gates) {
    const result = evaluateOrbBreakPullbackContinuation(baseContext(overrides));
    assert.notEqual(result.decision, "SETUP QUALIFIED", `${name} gate must block qualification`);
    assert.equal(result.rules.filter((rule) => rule.mandatory).every((rule) => rule.passed), false, `${name} gate should fail`);
  }
});

test("tight consolidation can qualify outside the old 45–60 minute window", () => {
  const candles = withCausalBaseline(Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  const result = detectExtendedNtzConsolidation(candles, ntz());
  assert.equal(result.detected, true);
  assert.equal(result.candleCount, 9);
  assert.equal(result.durationMinutes, 45);
  assert.equal(result.insideOrNearCount, 9);
  assert.equal(result.expansionRatio, 1);
});

test("bounded consolidation qualifies both below 45 and above 60 minutes without NTZ duration substitution", () => {
  const short = withCausalBaseline(Array.from({ length: 3 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  const long = withCausalBaseline(Array.from({ length: 13 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  assert.equal(detectExtendedNtzConsolidation(short, ntz()).detected, true);
  assert.equal(detectExtendedNtzConsolidation(short, ntz()).durationMinutes, 15);
  assert.equal(detectExtendedNtzConsolidation(long, ntz()).detected, true);
  assert.equal(detectExtendedNtzConsolidation(long, ntz()).durationMinutes, 65);
  assert.equal(detectExtendedNtzConsolidation(short.slice(0, 2), ntz()).detected, false);
});

test("adaptive consolidation rejects a range that is too wide for causal volatility", () => {
  const candles = withCausalBaseline(Array.from({ length: 3 }, (_, index) => candle(index * 300_000, 10, 11, 9, 10)));
  const result = detectExtendedNtzConsolidation(candles, ntz());
  assert.equal(result.detected, false);
  assert.ok((result.compressionRatio ?? 0) > config.phase6ConsolidationVolatilityMultiplier);
});

test("adaptive consolidation requires meaningful shared candle-range overlap", () => {
  const candles = withCausalBaseline([
    candle(0, 100, 101, 99, 100),
    candle(300_000, 100, 101.5, 99.5, 100.5),
    candle(600_000, 100, 102, 100, 101),
  ]);
  const result = detectExtendedNtzConsolidation(candles, ntz());
  assert.equal(result.detected, false);
  assert.ok((result.overlapRatio ?? 0) < config.phase6ConsolidationMinOverlapRatio);
});

test("adaptive consolidation fails closed without enough preceding completed candles", () => {
  const result = detectExtendedNtzConsolidation(
    Array.from({ length: 3 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)),
    ntz(),
  );
  assert.equal(result.detected, false);
  assert.equal(result.causalVolatilityBaseline, null);
});

test("adaptive consolidation rejects excessive directional progression", () => {
  const candles = withCausalBaseline(Array.from({ length: 5 }, (_, index) =>
    candle(index * 300_000, 100, 101 + index * 0.1, 99, 100.4),
  ));
  const result = detectExtendedNtzConsolidation(candles, ntz());
  assert.equal(result.detected, false);
  assert.ok(result.maxDirectionalSequence > config.phase6ConsolidationMaxDirectionalSequence);
});

test("legacy consolidation range cap is diagnostic while volatility compression governs qualification", () => {
  const consolidation = withCausalBaseline(Array.from({ length: 3 }, (_, index) => candle(index * 300_000, 9.5, 10.5, 9, 9.5)));
  const breakout = candle(3_600_000, 10, 10.8, 9.9, 10.7, 250);
  const evaluate = (volatilityMultiplier: number, maxRangeTicks: number) => evaluateExtendedNtzConsolidationBreakout(baseContext({
     candles: [...consolidation, breakout],
    breakout: { ...baseContext().breakout, candleOpenTime: breakout.openTime, time: breakout.closeTime },
    patience: { ...patience(), eligibilityReason: "ntz consolidation" },
     config: strategyConfig({ phase6ConsolidationMaxRangeTicks: maxRangeTicks, phase6ConsolidationVolatilityMultiplier: volatilityMultiplier }),
  }));
   const governed = evaluate(config.phase6ConsolidationVolatilityMultiplier, 5);
   const stricter = evaluate(1, 5);
  assert.equal(governed.rules.find((rule) => rule.key === "extendedConsolidation")?.passed, true);
  assert.equal(stricter.rules.find((rule) => rule.key === "extendedConsolidation")?.passed, false);
   assert.equal(governed.consolidation?.diagnosticRangeCapExceeded, true);
   assert.deepEqual(stricter, evaluate(1, 5));
});

test("extended consolidation rejects a materially expanding range", () => {
  const candles = withCausalBaseline(Array.from({ length: 9 }, (_, index) => index < 4
    ? candle(index * 300_000, 9.95, 9.96, 9.94, 9.95)
    : candle(index * 300_000, 9.95, 9.96 + (index - 3) * 0.2, 9.94 - (index - 3) * 0.2, 9.96)));
  const result = detectExtendedNtzConsolidation(candles, ntz(), 1.25, null, 24, 9);
  assert.equal(result.detected, false);
  assert.ok((result.expansionRatio ?? 0) > 1.25);
  const evaluated = evaluateExtendedNtzConsolidationBreakout(baseContext({ candles }));
  assert.equal(evaluated.rules.find((rule) => rule.key === "rangeStable")?.passed, false);
  assert.notEqual(evaluated.decision, "SETUP QUALIFIED");
});

test("extended consolidation does not require a pullback", () => {
  const candles = withCausalBaseline(Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  const result = evaluateExtendedNtzConsolidationBreakout(baseContext({
    candles: [...candles, candle(2_700_000, 9.96, 10.25, 9.95, 10.2)],
    pullback: { ...baseContext().pullback, events: [] },
     breakout: { ...baseContext().breakout, candleOpenTime: 2_700_000, time: 3_000_000 },
  }));
  assert.equal(result.rules.find((rule) => rule.key === "pullback")?.mandatory, undefined);
  assert.equal(result.rules.find((rule) => rule.key === "extendedConsolidation")?.passed, true);
});

test("extended consolidation qualifies with a breakout and NTZ-eligible patience window", () => {
  const candles = withCausalBaseline(Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  const result = evaluateExtendedNtzConsolidationBreakout(baseContext({
    candles: [...candles, candle(2_700_000, 9.96, 10.25, 9.95, 10.2)],
    patience: { ...patience(), eligibilityReason: "ntz consolidation" },
    breakout: { ...baseContext().breakout, candleOpenTime: 2_700_000, time: 3_000_000 },
  }));
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.mandatoryPassed, true);
});

test("consolidation breakout closes outside its frozen pre-breakout range", () => {
  const consolidationCandles = Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96));
  const breakoutCandle = candle(2_700_000, 9.96, 10.25, 9.95, 10.2);
  const result = evaluateExtendedNtzConsolidationBreakout({
    ...baseContext({
      candles: [...consolidationCandles, breakoutCandle],
      breakout: { ...baseContext().breakout, candleOpenTime: breakoutCandle.openTime, time: breakoutCandle.closeTime },
      patience: { ...patience(), eligibilityReason: "ntz consolidation" },
    }),
  });
  assert.equal(result.consolidation?.frozenHigh, 9.99);
  assert.equal(result.consolidation?.frozenLow, 9.91);
  assert.equal(result.rules.find((rule) => rule.key === "strongBreakout")?.passed, true);
});

test("Long effective threshold is max(P high + 8 ticks, zone high + 1 tick)", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
  const p = candle(base + 900_000, 100, 100.25, 99.75, 100.1);
   const e = candle(base + 1_200_000, 100.1, 102.25, 100, 102.25);
  const result = evaluateConsolidationEntryGuard({
     candles: [...baselineCandles, ...zoneCandles, p, e, candle(base + 1_500_000, 102.25, 104, 102, 103)],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 8, entryBufferPrice: 102.25 },
    direction: "long",
    config,
    consolidationEvaluation: {
      setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
      decision: "SETUP QUALIFIED",
    },
  });
  assert.ok(result);
  assert.equal(result.lifecycleState, "CONSOLIDATION_BREAKOUT_CONFIRMED");
  assert.equal(result.executionEligible, true);
  assert.equal(result.consolidationZoneHigh, 100.5);
  assert.equal(result.consolidationZoneLow, 99.5);
   assert.equal(result.entryOpenedOutsideZone, false);
   assert.equal(result.entryClosedOutsideZone, true);
   assert.equal(result.entryRangeOutsideZone, false);
   assert.equal(result.entryRangeOverlappedZone, true);
   assert.equal(result.patienceConfirmationThreshold, 102.25);
   assert.equal(result.consolidationBoundaryThreshold, 100.75);
   assert.equal(result.effectiveEntryThreshold, 102.25);
   assert.equal(result.effectiveEntryThresholdReached, true);
   assert.equal(result.entryOutsideFinalizedNtz, true);
   assert.equal(result.entryBeforeCutoff, true);
   assert.equal(result.entryFillOutsideZone, true);
  assert.deepEqual(result.sourceCandleOpenTimes, zoneCandles.map((item) => item.openTime));
});

test("Wick outside with close inside is rejected", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
  const p = candle(base + 900_000, 100, 100.25, 99.75, 100.1);
  const e = candle(base + 1_200_000, 100.1, 102.25, 100, 100.25);
  const result = evaluateConsolidationEntryGuard({
     candles: [...baselineCandles, ...zoneCandles, p, e, candle(base + 1_500_000, 100.25, 106, 100, 105)],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 8, entryBufferPrice: 102.25 },
    direction: "long",
    config,
    consolidationEvaluation: {
      setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
      decision: "SETUP QUALIFIED",
    },
  });
  assert.ok(result);
  assert.equal(result.lifecycleState, "PATIENCE_EXPIRED_INSIDE_CONSOLIDATION");
  assert.equal(result.executionEligible, false);
  assert.equal(result.consolidationZoneHigh, 100.5);
  assert.equal(result.consolidationZoneLow, 99.5);
  assert.equal(result.entryRangeOutsideZone, false);
   assert.equal(result.entryRangeOverlappedZone, true);
   assert.equal(result.rejectionReason, "CONSOLIDATION_ENTRY_WICK_ONLY_BREAKOUT");
});

test("consolidation guard preserves the frozen boundary for breakout-pullback P to E", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
  const breakout = candle(base + 900_000, 100, 102, 99.9, 101.75);
  const p = candle(base + 1_200_000, 101.5, 101.75, 100.75, 101.6);
  const e = candle(base + 1_500_000, 101.6, 103.75, 101.5, 103.75);
  const result = evaluateConsolidationEntryGuard({
     candles: [...baselineCandles, ...zoneCandles, breakout, p, e],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 8, entryBufferPrice: 103.75 },
    direction: "long",
    breakout: {
      detected: true,
      direction: "long",
      candleOpenTime: breakout.openTime,
      continuationConfirmed: true,
      failed: false,
    },
    qualifyingPullback: true,
    config,
    consolidationEvaluation: {
      setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
      decision: "SETUP QUALIFIED",
    },
  });
  assert.ok(result);
  assert.equal(result.lifecycleState, "BREAKOUT_PULLBACK_PATIENCE_CONFIRMED");
  assert.equal(result.executionEligible, true);
  assert.equal(result.consolidationZoneHigh, 100.5);
});

test("Short effective threshold is min(P low − 8 ticks, zone low − 1 tick); wick overlapping the zone with fill and close outside is accepted", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
  const p = candle(base + 900_000, 100, 100.25, 99.75, 99.9);
  const e = candle(base + 1_200_000, 100.1, 100, 97.75, 97.75);
  const result = evaluateConsolidationEntryGuard({
    candles: [...baselineCandles, ...zoneCandles, p, e],
    levels: { ntz: { high: 102, low: 101, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 8, entryBufferPrice: 97.75 },
    direction: "short",
    config,
    consolidationEvaluation: {
      setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
      decision: "SETUP QUALIFIED",
    },
  });
  assert.ok(result);
  assert.equal(result.executionEligible, true);
  assert.equal(result.entryOpenedOutsideZone, false);
  assert.equal(result.entryClosedOutsideZone, true);
  assert.equal(result.entryRangeOverlappedZone, true);
  assert.equal(result.patienceConfirmationThreshold, 97.75);
  assert.equal(result.consolidationBoundaryThreshold, 99.25);
  assert.equal(result.effectiveEntryThreshold, 97.75);
  assert.equal(result.effectiveEntryThresholdReached, true);
  assert.equal(result.entryFillOutsideZone, true);
});

test("Close outside with threshold not reached is rejected", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
  const p = candle(base + 900_000, 100, 100.25, 99.75, 100.1);
  const e = candle(base + 1_200_000, 100.1, 101.5, 100, 101);
  const result = evaluateConsolidationEntryGuard({
    candles: [...baselineCandles, ...zoneCandles, p, e],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 12, entryBufferPrice: 103 },
    direction: "long",
    config,
    consolidationEvaluation: {
      setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
      decision: "SETUP QUALIFIED",
    },
  });
  assert.ok(result);
  assert.equal(result.entryClosedOutsideZone, true);
  assert.equal(result.effectiveEntryThresholdReached, false);
  assert.equal(result.executionEligible, false);
  assert.equal(result.rejectionReason, "CONSOLIDATION_ENTRY_THRESHOLD_NOT_REACHED");
});

test("Fill exactly on the boundary is rejected", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
  const p = candle(base + 900_000, 100, 100.25, 99.75, 100.1);
  const e = candle(base + 1_200_000, 100.1, 102.25, 100, 102.25);
  const result = evaluateConsolidationEntryGuard({
    candles: [...baselineCandles, ...zoneCandles, p, e],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 8, entryBufferPrice: 102.25 },
    entryFillPrice: 100.5,
    direction: "long",
    config,
    consolidationEvaluation: {
      setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
      decision: "SETUP QUALIFIED",
    },
  });
  assert.ok(result);
  assert.equal(result.entryClosedOutsideZone, true);
  assert.equal(result.entryFillOutsideZone, false);
  assert.equal(result.executionEligible, false);
  assert.equal(result.rejectionReason, "CONSOLIDATION_ENTRY_FILL_NOT_OUTSIDE_ZONE");
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

test("equivalent reversal ignores opposing-volume warnings", () => {
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
  assert.equal(evidence.detail.includes("strong opposing volume"), false);
  assert.equal(evidence.deepFibonacciRetracement, true);
  const result = evaluateBonusReversal(context);
  assert.equal(result.alertOnly, false);
  assert.equal(result.decision, "POSSIBLE REVERSAL");
  assert.equal(result.rules.find((rule) => rule.key === "immediateTrigger")?.passed, false);
});

test("equivalent reversal qualifies after context, patience, and risk approval", () => {
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
    breakout: { ...baseContext().breakout, direction: "long" },
     reversalPatience: { ...patience("ENTRY_TRIGGERED", "bearish", "short"), triggerCandle: candle(3, 9.9, 10, 8.8, 8.9) },
  });
  const result = evaluateBonusReversal(context);
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.alertOnly, false);
  assert.equal(result.mandatoryPassed, true);
});

test("reversal patience must carry the independently confirmed reversal direction", () => {
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
    reversalPatience: patience("ENTRY_TRIGGERED", "bullish", "long"),
  });
  const result = evaluateBonusReversal(context);
  assert.equal(result.direction, "short");
  assert.equal(result.rules.find((rule) => rule.key === "validPatienceCandle")?.passed, false);
  assert.notEqual(result.decision, "SETUP QUALIFIED");
});

test("equivalent reversal owns a shared qualified sequence before generic patience", () => {
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
    breakout: { ...baseContext().breakout, detected: false, failed: true },
    reversalPatience: { ...patience("ENTRY_TRIGGERED", "bearish"), triggerCandle: candle(3, 9.9, 10, 8.8, 8.9) },
  });
  const result = phase6Analysis(context);
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.primarySetup, "EQUIVALENT_CANDLE_REVERSAL");
});

test("ORB Fibonacci interaction is diagnostic-only and cannot satisfy level context", () => {
  const withoutInteraction = evaluateOrbBreakPullbackContinuation(baseContext({
    pullback: { ...baseContext().pullback, events: [] },
    fibonacci: { ...baseContext().fibonacci, frozen: true, levels: [{ name: "Fib 0.5", label: "50%", ratio: 0.5, price: 100 }] },
  }));
  assert.equal(withoutInteraction.rules.find((rule) => rule.key === "levelContext")?.passed, false);

  const withInteraction = evaluateOrbBreakPullbackContinuation(baseContext({
    pullback: {
      ...baseContext().pullback,
      events: [{ ...baseContext().pullback.events[0]!, level: "Fib 0.5", price: 10.1 }],
    },
    fibonacci: { ...baseContext().fibonacci, frozen: true, levels: [{ name: "Fib 0.5", label: "50%", ratio: 0.5, price: 10.1 }] },
  }));
  assert.equal(withInteraction.rules.find((rule) => rule.key === "levelContext")?.passed, false);
});

test("ORB rejects a genuine pullback whose only qualifying level is Fibonacci", () => {
  const context = baseContext({
    pullback: {
      ...baseContext().pullback,
      events: [{ ...baseContext().pullback.events[0]!, level: "Fib 0.5", price: 10.1 }],
      structure: {
        detected: true,
        direction: "long",
        impulseExtreme: 10.4,
        impulseExtremeTime: 1,
        pullbackStart: 2,
        pullbackEnd: 3,
        depthPoints: 0.3,
        retracementPercent: 30,
        greaterThan50PercentWarning: false,
      },
    },
    fibonacci: { ...baseContext().fibonacci, frozen: true, levels: [{ name: "Fib 0.5", label: "50%", ratio: 0.5, price: 10.1 }] },
  });
  const result = evaluateOrbBreakPullbackContinuation(context);
  assert.equal(result.rules.find((rule) => rule.key === "levelContext")?.passed, false);
});

test("Fibonacci proximity without causal pullback structure does not qualify ORB continuation", () => {
  const result = evaluateOrbBreakPullbackContinuation(baseContext({
    pullback: {
      ...baseContext().pullback,
      events: [{ ...baseContext().pullback.events[0]!, level: "Fib 0.5", price: 10.1 }],
      structure: {
        detected: false,
        direction: "long",
        impulseExtreme: 10.4,
        impulseExtremeTime: 1,
        pullbackStart: null,
        pullbackEnd: null,
        depthPoints: null,
        retracementPercent: null,
        greaterThan50PercentWarning: false,
      },
    },
    fibonacci: { ...baseContext().fibonacci, frozen: true, levels: [{ name: "Fib 0.5", label: "50%", ratio: 0.5, price: 10.1 }] },
  }));
  assert.equal(result.rules.find((rule) => rule.key === "levelContext")?.passed, false);
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