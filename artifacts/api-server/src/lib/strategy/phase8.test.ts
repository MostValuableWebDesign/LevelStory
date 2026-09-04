import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import {
  buildPhase8Timeline,
  calculatePhase8Excursions,
  setupOutcome,
  simulatePhase8ShadowExecution,
  type ShadowQuote,
} from "./phase8.js";
import type { Phase7RiskPlan } from "./phase7.js";
import type { SetupEvaluation } from "./phase6.js";

const specification = getFuturesContractSpecification("MES");
const quote: ShadowQuote = { bid: 6799.75, ask: 6800.25 };

function riskPlan(overrides: Partial<Phase7RiskPlan> = {}): Phase7RiskPlan {
  return {
    direction: "long",
    entry: 6800,
    thesisStop: 6798,
    catastropheStop: 6797,
    strategyStop: 6798,
    target: 6805,
    targetDollars: 25,
    targetTicks: 20,
    targetContracts: 1,
    runnerContracts: 1,
    contracts: 2,
    stopTicks: 12,
    dollarRisk: 32,
    riskPerContract: 16,
    allowed: true,
    slippageMode: "normal",
    costBreakdown: { commission: 0, exchange: 0, regulatory: 0, clearing: 0, roundTripFees: 0, entrySlippage: 0, exitSlippage: 0, totalSlippage: 0 },
    projectedTargetPnl: { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 },
    runner: { active: false, referencePrice: null, impulse: null, mostFavorablePrice: null, adverseRetracement: 0, retracementThreshold: null, exit: false, exitReason: null },
    locks: {},
    reasons: [],
    ...overrides,
  };
}

test("Phase 8 uses ask plus slippage to enter long and bid minus slippage to exit", () => {
  const execution = simulatePhase8ShadowExecution({
    direction: "long",
    entryQuote: quote,
    exitQuote: { bid: 6805.25, ask: 6805.75 },
    entryReferencePrice: 6800,
    exitReferencePrice: 6805,
    currentPrice: 6805,
    contracts: 1,
    target: 6805,
    specification,
    normalSlippageTicks: 1,
  });
  assert.equal(execution.entryQuoteSide, "ask");
  assert.equal(execution.exitQuoteSide, "bid");
  assert.equal(execution.entryFillPrice, 6800.5);
  assert.equal(execution.exitFillPrice, 6805);
  assert.equal(execution.targetHit, true);
});

test("Phase 8 uses bid minus slippage to enter short and ask plus slippage to exit", () => {
  const execution = simulatePhase8ShadowExecution({
    direction: "short",
    entryQuote: quote,
    exitQuote: { bid: 6794.25, ask: 6794.75 },
    entryReferencePrice: 6800,
    exitReferencePrice: 6795,
    currentPrice: 6795,
    contracts: 1,
    target: 6795,
    specification,
    normalSlippageTicks: 1,
  });
  assert.equal(execution.entryQuoteSide, "bid");
  assert.equal(execution.exitQuoteSide, "ask");
  assert.equal(execution.entryFillPrice, 6799.5);
  assert.equal(execution.exitFillPrice, 6795);
  assert.equal(execution.targetHit, true);
});

test("Phase 8 keeps the target leg and exits a runner at the inclusive 40% retracement", () => {
  const execution = simulatePhase8ShadowExecution({
    direction: "long",
    entryQuote: quote,
    exitQuote: { bid: 6805.25, ask: 6805.75 },
    entryReferencePrice: 6800,
    currentPrice: 6802,
    high: 6805,
    low: 6799,
    contracts: 2,
    targetContracts: 1,
    runnerContracts: 1,
    target: 6805,
    runnerReferencePrice: 6800,
    runnerImpulse: 5,
    runnerMostFavorablePrice: 6805,
    specification,
  });
  assert.equal(execution.targetHit, true);
  assert.equal(execution.runnerActivated, true);
  assert.equal(execution.runnerExited, true);
  assert.equal(execution.exitReason, "runner");
  assert.deepEqual(execution.legs.map((leg) => leg.kind), ["target", "runner"]);
});

test("Phase 8 gives catastrophe stops precedence over strategy stops", () => {
  const execution = simulatePhase8ShadowExecution({
    direction: "long",
    entryQuote: quote,
    exitQuote: { bid: 6796.75, ask: 6797.25 },
    entryReferencePrice: 6800,
    currentPrice: 6797,
    high: 6800,
    low: 6796.75,
    contracts: 1,
    strategyStop: 6798,
    catastropheStop: 6797,
    specification,
  });
  assert.equal(execution.stop, "catastrophe");
  assert.equal(execution.exitReason, "catastrophe stop");
});

test("Phase 8 uses the exact primary level stop as the exit despite quote spread and slippage", () => {
  const execution = simulatePhase8ShadowExecution({
    direction: "short",
    entryQuote: quote,
    exitQuote: { bid: 6818, ask: 6818.5 },
    entryReferencePrice: 6800,
    exitReferencePrice: 6815.5,
    currentPrice: 6815.5,
    high: 6818.25,
    low: 6815,
    contracts: 1,
    strategyStop: 6815.5,
    primaryLevelStop: 6815.5,
    specification,
    slippageMode: "abnormal_spread",
  });
  assert.equal(execution.exitReferencePrice, 6815.5);
  assert.equal(execution.exitFillPrice, 6815.5);
  assert.equal(execution.legs[0]?.fillPrice, 6815.5);
  assert.equal(execution.exitSlippageTicks, 0);
  assert.equal(execution.legs[0]?.modeledSlippageTicks, 2);
});

test("Phase 8 maps setup states and computes excursions in dollars", () => {
  assert.equal(setupOutcome("SETUP QUALIFIED"), "qualified");
  assert.equal(setupOutcome("EXPIRED"), "expired");
  assert.equal(setupOutcome("AMBIGUOUS"), "ambiguous");
  assert.equal(setupOutcome("WAITING"), "rejected");
  const excursions = calculatePhase8Excursions("long", 6800, [{ high: 6804, low: 6798 }, { high: 6802, low: 6799 }], specification);
  assert.equal(excursions.maximumFavorableExcursion, 20);
  assert.equal(excursions.maximumAdverseExcursion, 10);
});

test("Phase 8 timeline is chronological and includes failed setup outcome", () => {
  const evaluation: SetupEvaluation = {
    setupType: "ORB_PULLBACK_CONTINUATION",
    direction: "long",
    decision: "AMBIGUOUS",
    mandatoryPassed: false,
    alertOnly: false,
    rules: [{ key: "trigger", label: "Immediate trigger", passed: false, mandatory: true, detail: "Ambiguous path." }],
    reversalEvidence: null,
    consolidation: null,
    explanation: "Setup is ambiguous.",
  };
  const timeline = buildPhase8Timeline({
    candles: [{ openTime: 1, closeTime: 2, open: 1, high: 2, low: 1, close: 1.5, volume: 10, isComplete: true, ...quote }],
    ntz: null,
    ntzEvents: [],
    breakout: { detected: false, direction: null, state: "INSIDE_ORB", time: null, candleOpenTime: null, candidateTime: null, candidateCandleOpenTime: null, distanceOutside: null, meaningfulDistance: null, breakoutVolume: null, baselineVolume: null, volumeRatio: null, volumeSupported: false, bodyRatio: null, closeLocationRatio: null, candleStructureSupported: false, continuationConfirmed: false, continuationCondition: null, failed: false, detail: "Waiting." },
    pullback: { status: "pending", events: [], evaluatedCandles: 0, maxCandles: 6, maxDurationMinutes: 30, elapsedMinutes: 0, proximityTolerance: null, atr14: null, qualifyingLevelCount: 0, detail: "Waiting." },
    fibonacci: { direction: null, impulseLow: null, impulseHigh: null, breakoutTime: null, frozen: false, frozenAt: null, manualCorrection: false, levels: [], retracementPercent: null, classification: "unavailable", detail: "Unavailable." },
    volume: { baselineCandleCount: 6, recentSixAverage: null, breakoutVolume: null, breakoutRatio: null, supportingBreakoutVolume: false, averageImpulseVolume: null, pullbackAverageVolume: null, pullbackToBreakoutRatio: null, pullbackToImpulseRatio: null, pullbackToRecentRatio: null, opposingPullbackVolume: null, reversalWarning: null },
    patience: { state: "AMBIGUOUS_EVENT_ORDER", eligible: false, eligibilityReason: null, eligibilityTime: null, trend: "neutral", previousCandle: null, patienceCandle: null, triggerCandle: null, entryBufferTicks: 8, entryBufferPrice: null, stopBufferTicks: 1, strategyStopPrice: null, triggerPrice: null, stateTime: null, detail: "Ambiguous." },
    evaluation,
    riskPlan: riskPlan({ allowed: false }),
    direction: "long",
    trend: "neutral",
    specification,
    now: 3,
  });
  assert.equal(timeline.at(-1)?.eventType, "Failed setup");
  assert.ok(timeline.every((item, index) => index === 0 || item.time >= timeline[index - 1].time));
});

test("Phase 8 simulates a qualified equivalent reversal only in shadow mode", () => {
  const timeline = buildPhase8Timeline({
    candles: [{ openTime: 1, closeTime: 2, open: 1, high: 2, low: 1, close: 1.5, volume: 10, isComplete: true, ...quote }],
    ntz: null,
    ntzEvents: [],
    breakout: { detected: true, direction: "long", state: "QUALIFIED_BREAKOUT", time: 1, candleOpenTime: 1, candidateTime: 1, candidateCandleOpenTime: 1, distanceOutside: 1, meaningfulDistance: 1, breakoutVolume: 10, baselineVolume: 5, volumeRatio: 2, volumeSupported: true, bodyRatio: 0.8, closeLocationRatio: 0.9, candleStructureSupported: true, continuationConfirmed: true, continuationCondition: "IMMEDIATE_DIRECTIONAL_EXTENSION", failed: false, detail: "Qualified." },
    pullback: { status: "observed", events: [], evaluatedCandles: 0, maxCandles: 6, maxDurationMinutes: 30, elapsedMinutes: 0, proximityTolerance: null, atr14: null, qualifyingLevelCount: 0, detail: "Observed." },
    fibonacci: { direction: "bullish", impulseLow: 1, impulseHigh: 2, breakoutTime: 1, frozen: true, frozenAt: 1, manualCorrection: false, levels: [{ name: "Fib 0.5", label: "50%", ratio: 0.5, price: 1.5 }], retracementPercent: 0, classification: "normal", detail: "Frozen." },
    volume: { baselineCandleCount: 6, recentSixAverage: 5, breakoutVolume: 10, breakoutRatio: 2, supportingBreakoutVolume: true, averageImpulseVolume: 10, pullbackAverageVolume: 5, pullbackToBreakoutRatio: 0.5, pullbackToImpulseRatio: 0.5, pullbackToRecentRatio: 1, opposingPullbackVolume: null, reversalWarning: null },
    patience: { state: "ENTRY_TRIGGERED", eligible: true, eligibilityReason: "pullback", eligibilityTime: 1, trend: "bullish", previousCandle: null, patienceCandle: { openTime: 1, closeTime: 2, open: 1, high: 2, low: 1, close: 1.5, isComplete: true }, triggerCandle: null, entryBufferTicks: 8, entryBufferPrice: 4, stopBufferTicks: 1, strategyStopPrice: 0.75, triggerPrice: 4, stateTime: 2, detail: "Triggered." },
    evaluation: { setupType: "EQUIVALENT_CANDLE_REVERSAL", direction: "long", decision: "SETUP QUALIFIED", mandatoryPassed: true, alertOnly: false, rules: [], reversalEvidence: { dojiAtMajorLevel: true, equivalentOpposingCandles: true, failedBreakout: false, deepFibonacciRetracement: false, majorLevelRejection: false, structureBreak: false, alert: true, detail: "Equivalent reversal context." }, consolidation: null, explanation: "Equivalent reversal context qualified." },
    riskPlan: riskPlan(),
    direction: "long",
    trend: "bullish",
    specification,
    now: 3,
  });
  assert.equal(timeline.some((item) => item.eventType === "Shadow entry"), true);
});