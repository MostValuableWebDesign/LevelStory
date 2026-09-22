import test from "node:test";
import assert from "node:assert/strict";
import {
  detectExtendedNtzConsolidation,
  evaluateConsolidationEntryGuard,
  detectReversalEvidence,
  evaluateBonusReversal,
  evaluatePeakRetracementReversal,
  evaluateStrongBreakoutAfterConsolidation,
  evaluateExtendedNtzConsolidationBreakout,
  evaluateOrbBreakPullbackContinuation,
  evaluatePatienceCandleContinuation,
  evaluateEarlyOrbMomentumContinuation,
  hasEquivalentOpposingCandles,
  isDoji,
  phase6Analysis,
  validateCausalContinuationDirection,
  type Phase6Context,
} from "./phase6.js";
import { strategyConfig } from "./config.js";
import type { DynamiteLevel, MajorLevel } from "./major-levels.js";
import type { Candle } from "./types.js";
import type { OrbTrendAnalysis } from "./orb-trend.js";
import { canonicalStrategyId, STRATEGY_COMPONENT_TYPES, STRATEGY_IDS, STRATEGY_OUTCOME_TYPES, strategyIdsIncludingLegacy } from "./taxonomy.js";
import { patienceOccurrenceId, type PatienceOccurrence } from "./phase5.js";

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
  const resolvedDirection = direction ?? "long";
  const previousCandle = { openTime: 1, closeTime: 2, open: 10, high: 10.4, low: 9.6, close: 10.1, isComplete: true };
  const patienceCandle = { openTime: 2, closeTime: 3, open: 10, high: 10.2, low: 9.8, close: 10.15, isComplete: true };
  const triggerCandle = { openTime: 3, closeTime: 4, open: 10.15, high: 10.3, low: 10.1, close: 10.25, isComplete: true };
  const occurrence: PatienceOccurrence = {
    occurrenceId: "phase6-test-occurrence",
    direction: resolvedDirection,
    directionSource: "ORB_BREAKOUT",
    directionSourceTimestamp: 1,
    orbTrendEpochId: null,
    entryBufferTicks: 4,
    stopBufferTicks: 1,
    eligibilityReason: "pullback",
    eligibilityTime: 1,
    eligibilityEventId: null,
    expectedEntryCandleOpenTime: triggerCandle.openTime,
    previousCandle,
    patienceCandle,
    triggerCandle,
    outcomeStatus: "CONFIRMED",
    qualificationStatus: "SIGNAL_CONFIRMED",
    status: state,
    reasonCode: `Patience state ${state}.`,
    evaluationCursor: triggerCandle.closeTime,
    eligibilityArmId: "phase6-test-arm",
  };
  return {
    state,
    direction: resolvedDirection,
    directionSource: "ORB_BREAKOUT" as const,
    occurrenceId: occurrence.occurrenceId,
    occurrences: [occurrence],
    eligibilityArmId: occurrence.eligibilityArmId,
    eligibilityProvenance: { eventId: null, reason: "pullback" as const, time: 1, detail: "test" },
    eligible: true,
    eligibilityReason: "pullback" as const,
    eligibilityTime: 1,
    trend,
    previousCandle,
    patienceCandle,
    triggerCandle,
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
    tickSize: 0.25,
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

function causalOrbTrend(direction: "long" | "short", epochId = `${direction}-epoch`, effectiveFromTimestamp = 1): OrbTrendAnalysis {
  const confirmingCandle = {
    openTime: effectiveFromTimestamp - 300_000,
    closeTime: effectiveFromTimestamp,
    open: 10,
    high: direction === "long" ? 11 : 10,
    low: direction === "short" ? 9 : 10,
    close: direction === "long" ? 10.5 : 9.5,
    volume: 100,
  };
  const transition = {
    previousState: "NEUTRAL" as const,
    newState: direction === "long" ? "BULLISH_ORB_TREND" as const : "BEARISH_ORB_TREND" as const,
    direction,
    epochId,
    finalizedOrbHigh: 10,
    finalizedOrbLow: 9,
    confirmationBufferTicks: 1,
    confirmationBufferPoints: 0.25,
    confirmingCandle,
    boundaryCrossed: direction === "long" ? "ORB_HIGH" as const : "ORB_LOW" as const,
    effectiveFromTimestamp,
    expiredArmIds: [],
    expiredCandidateIds: [],
    expirationReason: null,
    activePositionBlocked: false,
    formulaVersion: "test",
    strategyVersion: "test",
  };
  return {
    state: transition.newState,
    direction,
    epochId,
    finalizedOrbHigh: 10,
    finalizedOrbLow: 9,
    finalizedAt: 0,
    confirmationBufferTicks: 1,
    confirmationBufferPoints: 0.25,
    transitions: [transition],
    trendDirectionAt: (openTime) => openTime >= effectiveFromTimestamp ? direction : null,
    trendStateAt: (openTime) => openTime >= effectiveFromTimestamp ? transition.newState : "NEUTRAL",
    epochIdAt: (openTime) => openTime >= effectiveFromTimestamp ? epochId : null,
  };
}

function orbTrendPatience(direction: "long" | "short", epochId: string) {
  const analysis = patience("ENTRY_TRIGGERED", direction === "long" ? "bullish" : "bearish", direction);
  const occurrence = analysis.occurrences![0];
  const occurrenceId = patienceOccurrenceId(
    direction,
    "ORB_TREND",
    1,
    epochId,
    occurrence.patienceCandle.openTime,
  );
  return {
    ...analysis,
    directionSource: "ORB_TREND" as const,
    occurrenceId,
    occurrences: [{
      ...occurrence,
      occurrenceId,
      direction,
      directionSource: "ORB_TREND" as const,
      directionSourceTimestamp: 1,
      orbTrendEpochId: epochId,
    }],
  };
}

test("canonical continuation validation accepts exact active ORB epochs for long and short", () => {
  for (const direction of ["long", "short"] as const) {
    const epochId = `${direction}-epoch`;
    const context = baseContext({
      breakout: { ...baseContext().breakout, direction },
      patience: orbTrendPatience(direction, epochId),
      orbTrend: causalOrbTrend(direction, epochId),
    });
    const result = validateCausalContinuationDirection(context, direction);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.direction, direction);
      assert.equal(result.source, "ORB_TREND");
      assert.equal(result.orbTrendEpochId, epochId);
      assert.equal(result.sourceTimestamp, 1);
      assert.equal(result.occurrenceId, context.patience.occurrenceId);
    }
  }
});

test("canonical continuation validation accepts exact valid breakout evidence for long and short", () => {
  for (const direction of ["long", "short"] as const) {
    const context = baseContext({
      breakout: {
        ...baseContext().breakout,
        direction,
        detected: true,
        failed: false,
        state: "WAITING_FOR_PULLBACK",
        time: 1,
      },
      patience: {
        ...patience("ENTRY_TRIGGERED", direction === "long" ? "bullish" : "bearish", direction),
        directionSource: "ORB_BREAKOUT",
      },
    });
    const result = validateCausalContinuationDirection(context, direction);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.source, "ORB_BREAKOUT");
      assert.equal(result.sourceTimestamp, 1);
      assert.equal(result.orbTrendEpochId, null);
    }
  }
});

test("canonical continuation validation fails closed for missing or mismatched occurrence identity", () => {
  const valid = baseContext();
  const missing = validateCausalContinuationDirection({
    ...valid,
    patience: { ...valid.patience, occurrenceId: null },
  }, "long");
  assert.equal(missing.valid, false);
  assert.equal(missing.reasonCode, "MISSING_PATIENCE_OCCURRENCE");

  const sourceMismatch = validateCausalContinuationDirection({
    ...valid,
    patience: {
      ...valid.patience,
      directionSource: "ORB_TREND",
    },
  }, "long");
  assert.equal(sourceMismatch.valid, false);
  assert.equal(sourceMismatch.reasonCode, "DIRECTION_SOURCE_MISMATCH");
});

test("canonical ORB trend validation fails closed for missing, wrong, future, or duplicated epochs", () => {
  const valid = baseContext({
    patience: orbTrendPatience("long", "long-epoch"),
    orbTrend: causalOrbTrend("long", "long-epoch"),
  });
  const cases: Array<{ label: string; context: Phase6Context; reasonCode: string }> = [
    { label: "missing", context: { ...valid, patience: { ...valid.patience, occurrences: [{ ...valid.patience.occurrences![0], orbTrendEpochId: null }] } }, reasonCode: "MISSING_ORB_TREND_EPOCH" },
    { label: "missing source timestamp", context: { ...valid, patience: { ...valid.patience, occurrences: [{ ...valid.patience.occurrences![0], directionSourceTimestamp: undefined as unknown as number }] } }, reasonCode: "DIRECTION_SOURCE_TIMESTAMP_MISMATCH" },
    { label: "non-finite source timestamp", context: { ...valid, patience: { ...valid.patience, occurrences: [{ ...valid.patience.occurrences![0], directionSourceTimestamp: Number.NaN }] } }, reasonCode: "DIRECTION_SOURCE_TIMESTAMP_MISMATCH" },
    { label: "wrong", context: { ...valid, patience: orbTrendPatience("long", "wrong-epoch") }, reasonCode: "ORB_TREND_EPOCH_MISMATCH" },
    { label: "future", context: { ...valid, orbTrend: causalOrbTrend("long", "long-epoch", 3) }, reasonCode: "ORB_TREND_NOT_EFFECTIVE_AT_P" },
    { label: "duplicate", context: { ...valid, orbTrend: { ...valid.orbTrend!, transitions: [...valid.orbTrend!.transitions, valid.orbTrend!.transitions[0]] } }, reasonCode: "ORB_TREND_EPOCH_MISMATCH" },
  ];
  for (const { label, context, reasonCode } of cases) {
    const result = validateCausalContinuationDirection(context, "long");
    assert.equal(result.valid, false, label);
    assert.equal(result.reasonCode, reasonCode, label);
  }
});

test("canonical breakout validation rejects failed, expired, weak, future, and mismatched breakouts", () => {
  const valid = baseContext();
  const cases: Array<{ label: string; context: Phase6Context; reasonCode: string }> = [
    { label: "failed", context: { ...valid, breakout: { ...valid.breakout, failed: true } }, reasonCode: "BREAKOUT_FAILED" },
    { label: "expired", context: { ...valid, breakout: { ...valid.breakout, state: "SETUP_EXPIRED" } }, reasonCode: "BREAKOUT_STATE_NOT_EXECUTABLE" },
    { label: "weak", context: { ...valid, breakout: { ...valid.breakout, state: "BREAKOUT_CANDIDATE" } }, reasonCode: "BREAKOUT_STATE_NOT_EXECUTABLE" },
    { label: "missing breakout timestamp", context: { ...valid, breakout: { ...valid.breakout, time: null } }, reasonCode: "BREAKOUT_TIME_INVALID" },
    { label: "non-finite breakout timestamp", context: { ...valid, breakout: { ...valid.breakout, time: Number.NaN } }, reasonCode: "BREAKOUT_TIME_INVALID" },
    { label: "missing occurrence timestamp", context: { ...valid, patience: { ...valid.patience, occurrences: [{ ...valid.patience.occurrences![0], directionSourceTimestamp: undefined as unknown as number }] } }, reasonCode: "DIRECTION_SOURCE_TIMESTAMP_MISMATCH" },
    { label: "non-finite occurrence timestamp", context: { ...valid, patience: { ...valid.patience, occurrences: [{ ...valid.patience.occurrences![0], directionSourceTimestamp: Number.NaN }] } }, reasonCode: "DIRECTION_SOURCE_TIMESTAMP_MISMATCH" },
    {
      label: "future",
      context: {
        ...valid,
        breakout: { ...valid.breakout, time: 3 },
        patience: { ...valid.patience, occurrences: [{ ...valid.patience.occurrences![0], directionSourceTimestamp: 3 }] },
      },
      reasonCode: "BREAKOUT_AFTER_P",
    },
    { label: "direction", context: { ...valid, breakout: { ...valid.breakout, direction: "short" } }, reasonCode: "BREAKOUT_DIRECTION_MISMATCH" },
  ];
  for (const { label, context, reasonCode } of cases) {
    const result = validateCausalContinuationDirection(context, "long");
    assert.equal(result.valid, false, label);
    assert.equal(result.reasonCode, reasonCode, label);
  }
});

test("an exact ORB trend ignores failed, expired, weak, future, and stale opposing breakouts", () => {
  const valid = baseContext({
    patience: orbTrendPatience("long", "long-epoch"),
    orbTrend: causalOrbTrend("long", "long-epoch"),
  });
  const cases = [
    { label: "failed", breakout: { ...valid.breakout, direction: "short" as const, failed: true } },
    { label: "expired", breakout: { ...valid.breakout, direction: "short" as const, state: "SETUP_EXPIRED" as const } },
    { label: "weak", breakout: { ...valid.breakout, direction: "short" as const, state: "BREAKOUT_CANDIDATE" as const } },
    { label: "future", breakout: { ...valid.breakout, direction: "short" as const, time: 4 } },
    { label: "stale", breakout: { ...valid.breakout, direction: "short" as const, time: 0 } },
  ];
  for (const { label, breakout } of cases) {
    const result = validateCausalContinuationDirection({ ...valid, breakout }, "long");
    assert.equal(result.valid, true, label);
  }
});

test("an executable opposing breakout after the active ORB epoch remains a conflict", () => {
  const valid = baseContext({
    patience: orbTrendPatience("long", "long-epoch"),
    orbTrend: causalOrbTrend("long", "long-epoch"),
    breakout: {
      ...baseContext().breakout,
      direction: "short",
      state: "WAITING_FOR_PULLBACK",
      failed: false,
      time: 2,
    },
  });
  const result = validateCausalContinuationDirection(valid, "long");
  assert.equal(result.valid, false);
  assert.equal(result.reasonCode, "CONFLICTING_CAUSAL_DIRECTION");
});

test("ORB continuation qualifies only when every mandatory rule passes", () => {
  const result = evaluateOrbBreakPullbackContinuation(baseContext());
  assert.equal(result.setupType, "ORB_PULLBACK_CONTINUATION");
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.mandatoryPassed, true);
  assert.ok(result.rules.filter((rule) => rule.mandatory).every((rule) => rule.passed));
});

test("peak reversal does not require a greater-than-50-percent retracement", () => {
  const result = evaluatePeakRetracementReversal(baseContext({
    fibonacci: {
      ...baseContext().fibonacci,
      direction: "bullish",
      retracementPercent: 25,
      classification: "shallow",
    },
    reversalPatience: {
      ...patience("ENTRY_TRIGGERED", "bearish", "short"),
      triggerCandle: { openTime: 3, closeTime: 4, open: 9.1, high: 9.2, low: 8.5, close: 8.6, isComplete: true },
    },
  }));
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.rules.some((rule) => rule.key === "peakRetracement"), false);
  assert.equal(result.rules.every((rule) => rule.passed), true);
});

test("peak retracement reversal must be counter-trend", () => {
  const result = evaluatePeakRetracementReversal(baseContext({
    fibonacci: {
      ...baseContext().fibonacci,
      direction: "bullish",
      retracementPercent: 25,
      classification: "shallow",
    },
    trend: {
      ...baseContext().trend,
      direction: "bearish",
      structure: "lower highs / lower lows",
    },
    reversalPatience: {
      ...patience("ENTRY_TRIGGERED", "bearish", "short"),
      triggerCandle: { openTime: 3, closeTime: 4, open: 9.1, high: 9.2, low: 8.5, close: 8.6, isComplete: true },
    },
  }));
  assert.equal(result.rules.find((rule) => rule.key === "counterTrendDirection")?.passed, false);
  assert.notEqual(result.decision, "SETUP QUALIFIED");
  assert.equal(result.mandatoryPassed, false);
});

test("peak retracement reversal rejects a directional label without full trend confirmation", () => {
  const result = evaluatePeakRetracementReversal(baseContext({
    trend: {
      ...baseContext().trend,
      direction: "bullish",
      score: 4,
      candleCount: 8,
    },
    reversalPatience: {
      ...patience("ENTRY_TRIGGERED", "bearish", "short"),
      triggerCandle: { openTime: 3, closeTime: 4, open: 9.1, high: 9.2, low: 8.5, close: 8.6, isComplete: true },
    },
  }));
  assert.equal(result.rules.find((rule) => rule.key === "counterTrendDirection")?.passed, false);
  assert.match(result.rules.find((rule) => rule.key === "counterTrendDirection")?.detail ?? "", /does not oppose/i);
});

test("peak retracement reversal accepts only a fully confirmed opposing trend", () => {
  const result = evaluatePeakRetracementReversal(baseContext({
    fibonacci: {
      ...baseContext().fibonacci,
      direction: "bearish",
    },
    trend: {
      ...baseContext().trend,
      direction: "bearish",
      structure: "lower highs / lower lows",
      score: -5,
      evidenceItems: [
        { key: "structure", status: "negative" },
        { key: "vwap", status: "negative" },
        { key: "ema", status: "negative" },
        { key: "emaSlope", status: "negative" },
      ],
    },
    reversalPatience: {
      ...patience("ENTRY_TRIGGERED", "bullish", "long"),
      triggerCandle: { openTime: 3, closeTime: 4, open: 9.1, high: 9.2, low: 8.5, close: 8.6, isComplete: true },
    },
  }));
  assert.equal(result.rules.find((rule) => rule.key === "counterTrendDirection")?.passed, true);
});

test("patience continuation cannot qualify from generic trend context without a causal source", () => {
  const result = evaluatePatienceCandleContinuation(baseContext({
    patience: {
      ...patience("ENTRY_TRIGGERED", "bullish", "long"),
      direction: "long",
      directionSource: null,
    },
  }));
  assert.equal(result.rules.find((rule) => rule.key === "causalDirection")?.passed, false);
  assert.notEqual(result.decision, "SETUP QUALIFIED");
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

test("early ORB momentum rejects an outside close that is not patience-shaped", () => {
  const result = evaluateEarlyOrbMomentumContinuation(baseContext({
    pullback: { ...baseContext().pullback, status: "pending", events: [] },
    trend: { direction: "neutral", structure: "neutral" },
    earlyOrbMomentum: {
      ...patience("ENTRY_TRIGGERED", "bullish", "long"),
      eligibilityReason: "early orb momentum",
      direction: "long",
      previousCandle: { ...patience().previousCandle, high: 10.1 },
    },
  }));
  const shapeRule = result.rules.find((rule) => rule.key === "patienceCandleOutsideOrb");
  assert.equal(shapeRule?.passed, false);
  assert.equal(result.mandatoryPassed, false);
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
    "ORB_PULLBACK_CONTINUATION", "ORB_BREAK_PULLBACK_CONTINUATION", "PATIENCE_CANDLE_CONTINUATION",
  ]);
  assert.equal(canonicalStrategyId("PATIENCE_CANDLE_CONTINUATION"), "ORB_PULLBACK_CONTINUATION");
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

test("consolidation breakout qualifies from direct breakout evidence without patience", () => {
  const breakoutOpenTime = 9 * 300_000;
  const candles = withCausalBaseline([
    ...Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)),
    candle(breakoutOpenTime, 9.96, 12.1, 9.94, 12.0, 300),
  ]);
  const noConsolidation = evaluateStrongBreakoutAfterConsolidation(baseContext());
  assert.notEqual(noConsolidation.decision, "SETUP QUALIFIED");

  const noPatience = evaluateStrongBreakoutAfterConsolidation(baseContext({
    candles,
    breakout: {
      ...baseContext().breakout,
      detected: true,
      candleOpenTime: breakoutOpenTime - 600_000,
      time: breakoutOpenTime - 300_000,
      closeLocationRatio: 0.95,
      bodyRatio: 0.95,
      volumeSupported: true,
    },
    pullback: { ...baseContext().pullback, events: [] },
    patience: patience("PATIENCE_CANDLE_EXPIRED"),
  }));
  assert.equal(noPatience.decision, "SETUP QUALIFIED");
  assert.equal(noPatience.rules.find((rule) => rule.key === "postBreakoutContext")?.passed, true);
});

test("authorized long consolidation entry uses the first eight-tick threshold crossing without a breakout close", () => {
  const breakoutOpenTime = 9 * 300_000;
  const result = evaluateStrongBreakoutAfterConsolidation(baseContext({
    candles: withCausalBaseline([
      ...Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)),
      candle(breakoutOpenTime, 9.96, 12.1, 9.94, 9.95, 300),
    ]),
    breakout: {
      ...baseContext().breakout,
      detected: true,
      direction: "long",
      candleOpenTime: breakoutOpenTime - 600_000,
      time: breakoutOpenTime - 300_000,
      continuationConfirmed: false,
      closeLocationRatio: 0.95,
      bodyRatio: 0.95,
      volumeSupported: true,
    },
    pullback: { ...baseContext().pullback, events: [] },
    patience: patience("PATIENCE_CANDLE_EXPIRED"),
  }));
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.rules.find((rule) => rule.key === "entryOutsideFinalizedNtz")?.passed, true);
  assert.match(result.rules.find((rule) => rule.key === "entryOutsideFinalizedNtz")?.detail ?? "", /close is not required/);
});

test("authorized short consolidation entry uses the first eight-tick threshold crossing without a breakout close", () => {
  const breakoutOpenTime = 9 * 300_000;
  const result = evaluateStrongBreakoutAfterConsolidation(baseContext({
    candles: withCausalBaseline([
      ...Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 10.05, 9.91, 9.96)),
      candle(breakoutOpenTime, 9.96, 10.05, 7.5, 9.95, 300),
    ]),
    breakout: {
      ...baseContext().breakout,
      detected: true,
      direction: "short",
      candleOpenTime: breakoutOpenTime - 600_000,
      time: breakoutOpenTime - 300_000,
      continuationConfirmed: false,
      closeLocationRatio: 0.1,
      bodyRatio: 0.95,
      volumeSupported: true,
    },
    pullback: { ...baseContext().pullback, events: [] },
    patience: patience("PATIENCE_CANDLE_EXPIRED", "bearish", "short"),
    trend: { ...baseContext().trend, direction: "bearish" },
  }));
  assert.equal(result.direction, "short");
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.rules.find((rule) => rule.key === "entryOutsideFinalizedNtz")?.passed, true);
});

test("strong consolidation breakout rejects missing, future, and conflicting causal trend evidence", () => {
  const breakoutOpenTime = 9 * 300_000;
  const candles = withCausalBaseline([
    ...Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)),
    candle(breakoutOpenTime, 9.96, 12.1, 9.94, 9.95, 300),
  ]);
  const withoutTrend = evaluateStrongBreakoutAfterConsolidation(baseContext({
    candles,
    breakout: {
      ...baseContext().breakout,
      detected: true,
      direction: "long",
      candleOpenTime: breakoutOpenTime,
      time: breakoutOpenTime + 300_000,
    },
    trend: { ...baseContext().trend, direction: "neutral", structure: "mixed structure" },
    pullback: { ...baseContext().pullback, events: [] },
    patience: patience("PATIENCE_CANDLE_EXPIRED"),
  }));
  assert.notEqual(withoutTrend.decision, "SETUP QUALIFIED");
  assert.equal(withoutTrend.rules.find((rule) => rule.key === "causalTrend")?.passed, false);

  const futureTrend = evaluateStrongBreakoutAfterConsolidation(baseContext({
    candles,
    breakout: {
      ...baseContext().breakout,
      detected: false,
      direction: "long",
      candleOpenTime: breakoutOpenTime,
      time: breakoutOpenTime + 300_000,
    },
    orbTrend: {
      state: "NEUTRAL",
      direction: null,
      epochId: null,
      finalizedOrbHigh: 10,
      finalizedOrbLow: 9,
      finalizedAt: 0,
      confirmationBufferTicks: 2,
      confirmationBufferPoints: 0.5,
      transitions: [],
      trendDirectionAt: (openTime) => openTime > breakoutOpenTime ? "long" : null,
      trendStateAt: () => "NEUTRAL",
      epochIdAt: () => null,
    },
    trend: baseContext().trend,
    pullback: { ...baseContext().pullback, events: [] },
    patience: patience("PATIENCE_CANDLE_EXPIRED"),
  }));
  assert.notEqual(futureTrend.decision, "SETUP QUALIFIED");

  const conflictingTrend = evaluateStrongBreakoutAfterConsolidation(baseContext({
    candles,
    breakout: {
      ...baseContext().breakout,
      detected: true,
      direction: "long",
      candleOpenTime: breakoutOpenTime,
      time: breakoutOpenTime - 300_000,
    },
    orbTrend: {
      state: "BEARISH_ORB_TREND",
      direction: "short",
      epochId: "bearish-epoch",
      finalizedOrbHigh: 10,
      finalizedOrbLow: 9,
      finalizedAt: 0,
      confirmationBufferTicks: 2,
      confirmationBufferPoints: 0.5,
      transitions: [{
        previousState: "NEUTRAL",
        newState: "BEARISH_ORB_TREND",
        direction: "short",
        epochId: "bearish-epoch",
        finalizedOrbHigh: 10,
        finalizedOrbLow: 9,
        confirmationBufferTicks: 2,
        confirmationBufferPoints: 0.5,
        confirmingCandle: { openTime: 0, closeTime: 1, open: 10, high: 10, low: 9, close: 9, volume: 1 },
        boundaryCrossed: "ORB_LOW",
        effectiveFromTimestamp: 1,
        expiredArmIds: [],
        expiredCandidateIds: [],
        expirationReason: null,
        activePositionBlocked: false,
        formulaVersion: "test",
        strategyVersion: "test",
      }],
      trendDirectionAt: () => "short",
      trendStateAt: () => "BEARISH_ORB_TREND",
      epochIdAt: () => "bearish-epoch",
    },
    pullback: { ...baseContext().pullback, events: [] },
    patience: patience("PATIENCE_CANDLE_EXPIRED"),
  }));
  assert.notEqual(conflictingTrend.decision, "SETUP QUALIFIED");
  assert.equal(conflictingTrend.rules.find((rule) => rule.key === "causalTrend")?.passed, false);
});

test("authorized consolidation crossing does not require post-crossing breakout quality gates", () => {
  const breakoutOpenTime = 9 * 300_000;
  const result = evaluateStrongBreakoutAfterConsolidation(baseContext({
    candles: withCausalBaseline([
      ...Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)),
      candle(breakoutOpenTime, 9.96, 12.1, 9.94, 9.95, 1),
    ]),
    breakout: {
      ...baseContext().breakout,
      detected: true,
      direction: "long",
      candleOpenTime: breakoutOpenTime - 600_000,
      time: breakoutOpenTime - 300_000,
      continuationConfirmed: false,
      closeLocationRatio: 0,
      bodyRatio: 0,
      volumeSupported: false,
    },
    pullback: { ...baseContext().pullback, events: [] },
    patience: patience("PATIENCE_CANDLE_EXPIRED"),
  }));
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.rules.find((rule) => rule.key === "breakoutBody")?.mandatory, false);
  assert.equal(result.rules.find((rule) => rule.key === "breakoutCloseLocation")?.mandatory, false);
  assert.equal(result.rules.find((rule) => rule.key === "breakoutVolume")?.mandatory, false);
});

test("consolidation breakout uses the active bearish ORB epoch and directional close location", () => {
  const breakoutOpenTime = 9 * 300_000;
  const context = baseContext({
    candles: withCausalBaseline([
      ...Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)),
      candle(breakoutOpenTime, 9.96, 10.05, 7.5, 7.7, 300),
    ]),
    breakout: {
      ...baseContext().breakout,
      detected: true,
      direction: "short",
      candleOpenTime: breakoutOpenTime - 600_000,
      time: breakoutOpenTime - 300_000,
      closeLocationRatio: 0.1,
      bodyRatio: 0.8,
      volumeSupported: true,
    },
    orbTrend: {
      state: "BEARISH_ORB_TREND",
      direction: "short",
      epochId: "bearish-epoch",
      finalizedOrbHigh: 10,
      finalizedOrbLow: 9,
      finalizedAt: 0,
      confirmationBufferTicks: 2,
      confirmationBufferPoints: 0.5,
      transitions: [{
        previousState: "NEUTRAL",
        newState: "BEARISH_ORB_TREND",
        direction: "short",
        epochId: "bearish-epoch",
        finalizedOrbHigh: 10,
        finalizedOrbLow: 9,
        confirmationBufferTicks: 2,
        confirmationBufferPoints: 0.5,
        confirmingCandle: { openTime: 0, closeTime: 1, open: 10, high: 10, low: 9, close: 9, volume: 1 },
        boundaryCrossed: "ORB_LOW",
        effectiveFromTimestamp: 1,
        expiredArmIds: [],
        expiredCandidateIds: [],
        expirationReason: null,
        activePositionBlocked: false,
        formulaVersion: "test",
        strategyVersion: "test",
      }],
      trendDirectionAt: () => "short",
      trendStateAt: () => "BEARISH_ORB_TREND",
      epochIdAt: () => "bearish-epoch",
    },
  });
  const result = evaluateStrongBreakoutAfterConsolidation(context);
  assert.equal(result.direction, "short");
  assert.equal(result.rules.find((rule) => rule.key === "strongBreakout")?.passed, true);
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
  const tooShort = withCausalBaseline(Array.from({ length: 3 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  const short = withCausalBaseline(Array.from({ length: 4 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  const long = withCausalBaseline(Array.from({ length: 13 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  assert.equal(detectExtendedNtzConsolidation(tooShort, ntz()).detected, false);
  assert.equal(detectExtendedNtzConsolidation(short, ntz()).detected, true);
  assert.equal(detectExtendedNtzConsolidation(short, ntz()).durationMinutes, 20);
  assert.equal(detectExtendedNtzConsolidation(long, ntz()).detected, true);
  assert.equal(detectExtendedNtzConsolidation(long, ntz()).durationMinutes, 65);
  assert.equal(detectExtendedNtzConsolidation(short.slice(0, 2), ntz()).detected, false);
});

test("consolidation requires four completed candles before the crossing candle", () => {
  const three = withCausalBaseline(Array.from({ length: 3 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  const breakout = candle(900_000, 9.96, 12.1, 9.94, 12, 300);
  assert.equal(
    detectExtendedNtzConsolidation([...three, breakout], ntz(), 1.25, breakout.closeTime).detected,
    false,
  );
  assert.equal(
    detectExtendedNtzConsolidation([...three, { ...breakout, isComplete: false }], ntz()).detected,
    false,
  );
  const nonconsecutive = withCausalBaseline([
    candle(0, 9.95, 9.99, 9.91, 9.96),
    candle(300_000, 9.95, 9.99, 9.91, 9.96),
    candle(900_000, 9.95, 9.99, 9.91, 9.96),
    candle(1_200_000, 9.95, 9.99, 9.91, 9.96),
  ]);
  assert.equal(detectExtendedNtzConsolidation(nonconsecutive, ntz()).detected, false);
  const unsupportedInterval = withCausalBaseline([
    candle(0, 9.95, 9.99, 9.91, 9.96),
    { ...candle(300_000, 9.95, 9.99, 9.91, 9.96), closeTime: 550_000 },
    candle(600_000, 9.95, 9.99, 9.91, 9.96),
    candle(900_000, 9.95, 9.99, 9.91, 9.96),
  ]);
  assert.equal(detectExtendedNtzConsolidation(unsupportedInterval, ntz()).detected, false);
});

test("adaptive consolidation rejects a range that is too wide for causal volatility", () => {
  const candles = withCausalBaseline(Array.from({ length: 4 }, (_, index) => candle(index * 300_000, 10, 11, 9, 10)));
  const result = detectExtendedNtzConsolidation(candles, ntz());
  assert.equal(result.detected, false);
  assert.ok((result.compressionRatio ?? 0) > config.phase6ConsolidationVolatilityMultiplier);
});

test("adaptive consolidation requires meaningful shared candle-range overlap", () => {
  const candles = withCausalBaseline([
    candle(0, 100, 101, 99, 100),
    candle(300_000, 100, 101.5, 99.5, 100.5),
    candle(600_000, 100, 102, 100, 101),
    candle(900_000, 100, 102.5, 100.5, 101.5),
  ]);
  const result = detectExtendedNtzConsolidation(candles, ntz());
  assert.equal(result.detected, false);
  assert.ok((result.overlapRatio ?? 0) < config.phase6ConsolidationMinOverlapRatio);
});

test("adaptive consolidation fails closed without enough preceding completed candles", () => {
  const result = detectExtendedNtzConsolidation(
    Array.from({ length: 4 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)),
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
  const consolidation = withCausalBaseline(Array.from({ length: 4 }, (_, index) => candle(index * 300_000, 9.5, 10.5, 9, 9.5)));
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
    candles: [...candles, candle(2_700_000, 9.96, 12.25, 9.95, 12.2)],
    pullback: { ...baseContext().pullback, events: [] },
     breakout: { ...baseContext().breakout, candleOpenTime: 2_700_000, time: 2_400_000 },
  }));
  assert.equal(result.rules.find((rule) => rule.key === "pullback")?.mandatory, undefined);
  assert.equal(result.rules.find((rule) => rule.key === "extendedConsolidation")?.passed, true);
});

test("extended consolidation qualifies with a breakout and NTZ-eligible patience window", () => {
  const candles = withCausalBaseline(Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96)));
  const result = evaluateExtendedNtzConsolidationBreakout(baseContext({
    candles: [...candles, candle(2_700_000, 9.96, 12.25, 9.95, 12.2)],
    patience: { ...patience(), eligibilityReason: "ntz consolidation" },
     breakout: { ...baseContext().breakout, candleOpenTime: 2_700_000, time: 2_400_000 },
  }));
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.mandatoryPassed, true);
});

test("consolidation breakout closes outside its frozen pre-breakout range", () => {
  const consolidationCandles = Array.from({ length: 9 }, (_, index) => candle(index * 300_000, 9.95, 9.99, 9.91, 9.96));
  const breakoutCandle = candle(2_700_000, 9.96, 12.25, 9.95, 12.2);
  const result = evaluateExtendedNtzConsolidationBreakout({
    ...baseContext({
      candles: [...consolidationCandles, breakoutCandle],
      breakout: { ...baseContext().breakout, candleOpenTime: breakoutCandle.openTime, time: breakoutCandle.openTime - 300_000 },
      patience: { ...patience(), eligibilityReason: "ntz consolidation" },
    }),
  });
  assert.equal(result.consolidation?.frozenHigh, 9.99);
  assert.equal(result.consolidation?.frozenLow, 9.91);
  assert.equal(result.rules.find((rule) => rule.key === "strongBreakout")?.passed, true);
});

test("Long effective threshold is max(P high + 4 ticks, zone high + 1 tick)", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
    candle(base + 900_000, 100, 100.5, 99.5, 100.1),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
   const p = candle(base + 1_200_000, 100, 100.25, 99.75, 100.1);
    const e = candle(base + 1_500_000, 100.1, 102.25, 100, 102.25);
  const result = evaluateConsolidationEntryGuard({
     candles: [...baselineCandles, ...zoneCandles, p, e, candle(base + 1_800_000, 102.25, 104, 102, 103)],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 4, entryBufferPrice: 101.25 },
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
    assert.equal(result.patienceConfirmationThreshold, 101.25);
   assert.equal(result.consolidationBoundaryThreshold, 100.75);
    assert.equal(result.effectiveEntryThreshold, 101.25);
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
    candle(base + 900_000, 100, 100.5, 99.5, 100.1),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
   const p = candle(base + 1_200_000, 100, 100.25, 99.75, 100.1);
   const e = candle(base + 1_500_000, 100.1, 102.25, 100, 100.25);
  const result = evaluateConsolidationEntryGuard({
     candles: [...baselineCandles, ...zoneCandles, p, e, candle(base + 1_800_000, 100.25, 106, 100, 105)],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 4, entryBufferPrice: 101.25 },
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
    candle(base + 900_000, 100, 100.5, 99.5, 100.1),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
   const breakout = candle(base + 1_200_000, 100, 102, 99.9, 101.75);
   const p = candle(base + 1_500_000, 101.5, 101.75, 100.75, 101.6);
   const e = candle(base + 1_800_000, 101.6, 103.75, 101.5, 103.75);
  const result = evaluateConsolidationEntryGuard({
     candles: [...baselineCandles, ...zoneCandles, breakout, p, e],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 4, entryBufferPrice: 101.25 },
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

test("Short effective threshold is min(P low − 4 ticks, zone low − 1 tick); wick overlapping the zone with fill and close outside is accepted", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
    candle(base + 900_000, 100, 100.5, 99.5, 100.1),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
   const p = candle(base + 1_200_000, 100, 100.25, 99.75, 99.9);
   const e = candle(base + 1_500_000, 100.1, 100, 97.75, 97.75);
  const result = evaluateConsolidationEntryGuard({
    candles: [...baselineCandles, ...zoneCandles, p, e],
    levels: { ntz: { high: 102, low: 101, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 4, entryBufferPrice: 98.75 },
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
   assert.equal(result.patienceConfirmationThreshold, 98.75);
  assert.equal(result.consolidationBoundaryThreshold, 99.25);
   assert.equal(result.effectiveEntryThreshold, 98.75);
  assert.equal(result.effectiveEntryThresholdReached, true);
  assert.equal(result.entryFillOutsideZone, true);
});

test("Close outside with threshold not reached is rejected", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const zoneCandles = [
    candle(base, 100, 100.5, 99.5, 100),
    candle(base + 300_000, 100, 100.5, 99.5, 100.1),
    candle(base + 600_000, 100.1, 100.5, 99.5, 100),
    candle(base + 900_000, 100, 100.5, 99.5, 100.1),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
   const p = candle(base + 1_200_000, 100, 100.25, 99.75, 100.1);
    const e = candle(base + 1_500_000, 100.1, 101, 100, 101);
  const result = evaluateConsolidationEntryGuard({
    candles: [...baselineCandles, ...zoneCandles, p, e],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 4, entryBufferPrice: 101.25 },
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
    candle(base + 900_000, 100, 100.5, 99.5, 100.1),
  ];
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
   const p = candle(base + 1_200_000, 100, 100.25, 99.75, 100.1);
   const e = candle(base + 1_500_000, 100.1, 102.25, 100, 102.25);
  const result = evaluateConsolidationEntryGuard({
     candles: [...baselineCandles, ...zoneCandles, p, e],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 4, entryBufferPrice: 101.25 },
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

test("ORB pullback applies the consolidation guard to its causal P to E window", () => {
  const base = Date.parse("2026-08-25T13:45:00.000Z");
  const baselineCandles = Array.from({ length: 12 }, (_, index) =>
    candle(base - (12 - index) * 300_000, 100, 100.5, 99.5, 100),
  );
   const consolidationSeed = candle(base, 100, 100.5, 99.9, 100.1);
   const consolidationCandles = [
     consolidationSeed,
     candle(base + 300_000, 100, 100.5, 99.9, 100.1),
     candle(base + 600_000, 100, 100.5, 99.9, 100.1),
     candle(base + 900_000, 100, 100.5, 99.9, 100.1),
   ];
   const p = candle(base + 1_200_000, 100, 100.5, 99.9, 100.1);
   const e = candle(base + 1_500_000, 100.1, 100.4, 99.9, 100.25);
  const result = evaluateConsolidationEntryGuard({
     candles: [...baselineCandles, ...consolidationCandles, p, e],
    levels: { ntz: { high: 99, low: 98, complete: true } },
    patience: { patienceCandle: p, triggerCandle: e, entryBufferTicks: 4, entryBufferPrice: 100.25 },
    direction: "long",
    strategyType: "ORB_PULLBACK_CONTINUATION",
    config,
    consolidationEvaluation: {
      setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
      decision: "SETUP FORMING",
    },
  });
  assert.ok(result);
  assert.equal(result.activeZone, true);
  assert.equal(result.executionEligible, false);
  assert.equal(result.entryClosedOutsideZone, false);
  assert.equal(result.rejectionReason, "CONSOLIDATION_ENTRY_THRESHOLD_NOT_REACHED");
  assert.equal(result.lifecycleState, "PATIENCE_EXPIRED_INSIDE_CONSOLIDATION");
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

test("equivalent reversal applies exact matching and every body rule to the same adjacent pair", () => {
  const first = candle(0, 9.75, 10, 9.75, 9.99);
  const matchingSecond = candle(300_000, 9.99, 10, 9.75, 9.76);
  const oneTickMismatch = candle(300_000, 9.99, 10.25, 9.75, 9.76);
  const invalidBodySecond = candle(300_000, 9.99, 10, 9.75, 9.96);
  assert.equal(detectReversalEvidence({
    ...baseContext(),
    candles: [first, matchingSecond],
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
    levels: { ...baseContext().levels, majorLevels: [major(10)] },
  }).reversalDirection, "short");
  assert.equal(detectReversalEvidence({
    ...baseContext(),
    candles: [first, oneTickMismatch],
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
    levels: { ...baseContext().levels, majorLevels: [major(10)] },
  }).reversalDirection, null);
  assert.equal(detectReversalEvidence({
    ...baseContext(),
    candles: [first, invalidBodySecond],
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
    levels: { ...baseContext().levels, majorLevels: [major(10)] },
  }).equivalentOpposingCandles, false);
});

test("an older equivalent pair cannot qualify a newer invalid pair", () => {
  const first = candle(0, 9.75, 10, 9.75, 9.99);
  const validSecond = candle(300_000, 9.99, 10, 9.75, 9.76);
  const newerInvalid = candle(600_000, 9.76, 10.25, 9.75, 10.1);
  const evidence = detectReversalEvidence({
    ...baseContext(),
    candles: [first, validSecond, newerInvalid],
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
    levels: { ...baseContext().levels, majorLevels: [major(10)] },
  });
  assert.equal(evidence.equivalentOpposingCandles, false);
  assert.equal(evidence.reversalDirection, null);
});

test("equivalent reversal supports both directions only from consecutive completed candles", () => {
  const bullishFirst = candle(0, 99.75, 100, 99.75, 99.99);
  const bullishSecond = candle(300_000, 99.99, 100, 99.75, 99.76);
  const bearishFirst = candle(0, 100.5, 100.75, 100, 100.05);
  const bearishSecond = candle(300_000, 100.05, 100.75, 100, 100.5);
  const base = baseContext();
  assert.equal(detectReversalEvidence({
    ...base,
    candles: [bullishFirst, bullishSecond],
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
    levels: { ...base.levels, majorLevels: [major(100)] },
  }).reversalDirection, "short");
  assert.equal(detectReversalEvidence({
    ...base,
    candles: [bearishFirst, bearishSecond],
    trend: { direction: "bearish", structure: "lower lows / lower highs" },
    levels: { ...base.levels, majorLevels: [major(100.75)] },
  }).reversalDirection, "long");
});

test("equivalent reversal ignores opposing-volume warnings", () => {
  const context = baseContext({
    candles: [
      candle(0, 9.8, 10.01, 9.79, 10),
      candle(300_000, 10, 10.01, 9.79, 9.81),
    ],
    levels: { ...baseContext().levels, ntzEvents: [{ type: "Failed breakout", time: 1, detail: "Failed." }] },
    fibonacci: { ...baseContext().fibonacci, classification: "deep" },
    volume: { ...baseContext().volume, reversalWarning: "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" },
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
     reversalPatience: patience("PATIENCE_CANDLE_VALID"),
  });
  const evidence = detectReversalEvidence(context);
  assert.equal(evidence.alert, true);
  assert.equal(evidence.dojiAtMajorLevel, false);
  assert.equal(evidence.equivalentOpposingCandles, true);
  assert.equal(evidence.failedBreakout, true);
  assert.equal(evidence.detail.includes("strong opposing volume"), false);
  assert.equal(evidence.deepFibonacciRetracement, true);
  const result = evaluateBonusReversal(context);
  assert.equal(result.alertOnly, false);
  assert.equal(result.decision, "SETUP QUALIFIED");
  assert.equal(result.rules.find((rule) => rule.key === "validPatienceCandle")?.passed, true);
});

test("equivalent reversal qualifies after context, patience, and risk approval", () => {
  const context = baseContext({
    candles: [
      candle(0, 9.8, 10.01, 9.79, 10),
      candle(300_000, 10, 10.01, 9.79, 9.81),
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
    ],
    levels: { ...baseContext().levels, ntzEvents: [{ type: "Failed breakout", time: 1, detail: "Failed." }] },
    fibonacci: { ...baseContext().fibonacci, classification: "deep" },
    volume: { ...baseContext().volume, reversalWarning: "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" },
    trend: { direction: "bullish", structure: "higher highs / higher lows" },
    reversalPatience: patience("ENTRY_TRIGGERED", "bullish", "long"),
  });
  const result = evaluateBonusReversal(context);
  assert.equal(result.direction, "short");
  assert.equal(result.rules.find((rule) => rule.key === "validPatienceCandle")?.passed, true);
  assert.equal(result.decision, "SETUP QUALIFIED");
});

test("equivalent reversal owns a shared qualified sequence before generic patience", () => {
  const context = baseContext({
    candles: [
      candle(0, 9.8, 10.01, 9.79, 10),
      candle(300_000, 10, 10.01, 9.79, 9.81),
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
  assert.equal(result.decision, "POSSIBLE REVERSAL");
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