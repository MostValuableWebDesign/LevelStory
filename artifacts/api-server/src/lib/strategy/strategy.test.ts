import assert from "node:assert/strict";
import test from "node:test";
import { GetMarketSnapshotResponse } from "@workspace/api-zod";
import { completedCandles } from "./types.js";
import { strategyConfig } from "./config.js";
import { ema, fibonacci, rsi } from "./indicators.js";
import { positionSize } from "./risk.js";
import { patience, volumeCheck } from "./rules.js";
import { buildPhase7RiskPlan } from "./phase7.js";
import { assertDashboardInvariants, validateDashboardInvariants } from "./invariants.js";
import { createMarketSnapshot, selectExecutableDirection } from "../market-data.js";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import type { Phase6Analysis } from "./phase6.js";

const candle = (n: number, close = 10, complete = true) => ({
  openTime: n * 60_000, closeTime: (n + 1) * 60_000, open: close - .1, high: close + .2, low: close - .2, close, volume: 100, isComplete: complete,
});

test("replay only exposes completed candles at or before cursor", () => {
  const replay = { candles: [candle(0), candle(1, 11, false), candle(2)], cursor: 180_000 };
  assert.deepEqual(completedCandles(replay).map(c => c.openTime), [0, 120_000]);
});

test("completed candle snapshots do not mutate with source data", () => {
  const source = candle(0);
  const result = completedCandles({ candles: [source], cursor: 60_000 });
  source.close = 99;
  assert.equal(result[0].close, 10);
});

test("indicators and automatic fibonacci are deterministic", () => {
  assert.equal(ema([1, 2, 3], 2).length, 3);
  assert.equal(rsi([1, 2, 3], 2)[2], 100);
  const levels = fibonacci([candle(0, 10), { ...candle(1, 12), high: 13 }]);
  assert.equal(levels.find(level => level.name === "Fib 0.5")?.price, 11.4);
});

test("volume and patience are table-driven", () => {
  const config = strategyConfig({ volumeExpansionRatio: 1.4 });
  for (const [vol, confirmed] of [[80, true], [200, false]] as const) {
    const candles = [candle(0), { ...candle(1), volume: vol }];
    assert.equal(volumeCheck(candles, config, "long").confirmed, confirmed);
  }
  assert.equal(patience({ ...candle(0), open: 9, close: 10, high: 10.1, low: 8.9 }, "long").status, "ready");
});

test("sizing enforces daily lockout and risk cap", () => {
  const config = strategyConfig({ riskPerTrade: 100, maxPositionValue: 100_000 });
  const contract = getFuturesContractSpecification("MES");
  assert.equal(positionSize(6_800, 6_799.5, 100_000, { dailyLoss: 300, trades: 0, locked: false }, config, contract).allowed, false);
  assert.equal(positionSize(6_800, 6_799.5, 100_000, { dailyLoss: 0, trades: 0, locked: false }, config, contract).contracts, 2);
});

test("snapshot replay is causal and session bounded", () => {
  const premarket = createMarketSnapshot("MES", "premarket");
  assert.equal(premarket.ntz.complete, false);
  assert.equal(premarket.candles.every(candle => candle.closeTime <= premarket.replay.cursor), true);
  assert.equal(premarket.candles.some(candle => candle.openTime.startsWith("2026-08-25T13:30:")), false);
  assert.equal(premarket.candles.every(candle => candle.contractSymbol === "MESU26"), true);
  assert.equal(premarket.breakout.detected, false);
  assert.equal(premarket.riskPlan.direction, null);
  assert.equal(premarket.riskPlan.contracts, 0);
  assert.equal(premarket.shadowExecution, null);

  const regular = createMarketSnapshot("MES", "regular");
  assert.equal(regular.ntz.complete, true);
  assert.equal(regular.levels.openingRangeHigh !== null, true);
  assert.equal(regular.candles.every(candle => candle.closeTime <= regular.replay.cursor), true);
});

test("snapshot decision honors server-side emergency lockout", () => {
  const locked = createMarketSnapshot("MES", "regular", {
    accountSize: 25_000,
    riskPercent: 0.5,
    maxDailyLoss: 500,
    dailyLossUsed: 500,
    isLocked: true,
  });
  assert.equal(locked.riskPlan.allowed, false);
  assert.equal(locked.riskPlan.contracts, 0);
  assert.equal(locked.decision.state, "RISK LOCKOUT");
  assert.match(locked.decision.explanation, /Risk controls|lockout|blocked/i);
  assert.ok(locked.riskPlan.reasons.every((reason) => locked.decision.explanation.includes(reason)));
  assert.ok(locked.setupAnalysis.evaluations.every((evaluation) =>
    evaluation.rules.find((rule) => rule.key === "riskApproval")?.passed === false));
  assert.equal(locked.shadowExecution, null);
});

test("denied risk approval cannot qualify a setup or create a shadow entry", () => {
  const denied = createMarketSnapshot("MES", "regular", {
    accountSize: 25_000,
    riskPercent: 0,
    maxDailyLoss: 500,
    dailyLossUsed: 0,
    isLocked: false,
  });
  assert.equal(denied.riskPlan.allowed, false);
  assert.equal(denied.riskPlan.contracts, 0);
  assert.notEqual(denied.setupAnalysis.decision, "SETUP QUALIFIED");
  assert.ok(denied.setupAnalysis.evaluations.every((evaluation) => evaluation.decision !== "SETUP QUALIFIED"));
  assert.equal(denied.shadowExecution, null);
  assert.ok(denied.riskPlan.reasons.some((reason) => /zero contracts|trade risk/i.test(reason)));
});

function setupAnalysis(direction: "long" | "short" | null, decision: "SETUP QUALIFIED" | "WAITING" = "SETUP QUALIFIED", alertOnly = false): Pick<Phase6Analysis, "evaluations"> {
  return { evaluations: [{ setupType: "ORB_BREAK_PULLBACK_CONTINUATION", direction, decision, mandatoryPassed: decision === "SETUP QUALIFIED", alertOnly, rules: [], reversalEvidence: null, consolidation: null, explanation: "" }] };
}

test("direction precedence feeds consistent bearish and bullish Phase 7 plans", () => {
  const bearish = selectExecutableDirection(setupAnalysis(null), { detected: true, failed: false, direction: "short" }, null);
  const bullish = selectExecutableDirection(setupAnalysis(null), { detected: true, failed: false, direction: "long" }, null);
  assert.equal(bearish, "short");
  assert.equal(bullish, "long");

  const contract = getFuturesContractSpecification("MES");
  const basePlanConfig = {
    riskDollars: 100,
    dailyLossLimit: 500,
    dailyLossUsed: 0,
    tradesToday: 0,
    maxTradesPerDay: 1,
    maxContracts: 10,
    maxPositionValue: 100_000,
    maximumSpreadTicks: contract.maximumSpreadTicks,
    minimumLiquidity: contract.minimumLiquidity,
    staleDataSeconds: 15,
    dataAgeSeconds: 0,
    observedSpreadTicks: 1,
    liquidity: contract.minimumLiquidity,
    emergencyKillSwitch: false,
    duplicateEntry: false,
    averagingDown: false,
  };
  const shortPlan = buildPhase7RiskPlan(6800, bearish, 6800.25, 6800.5, basePlanConfig, contract);
  const longPlan = buildPhase7RiskPlan(6800, bullish, 6799.75, 6799.5, basePlanConfig, contract);
  assert.equal(shortPlan.direction, "short");
  assert.ok(shortPlan.target! < shortPlan.entry!);
  assert.ok(shortPlan.strategyStop! > shortPlan.entry!);
  assert.equal(longPlan.direction, "long");
  assert.ok(longPlan.target! > longPlan.entry!);
  assert.ok(longPlan.strategyStop! < longPlan.entry!);
});

test("neutral and non-breakout evidence produce no executable direction", () => {
  assert.equal(selectExecutableDirection(setupAnalysis(null), { detected: false, failed: false, direction: null }, null), null);
  assert.equal(selectExecutableDirection(setupAnalysis(null, "WAITING"), { detected: false, failed: false, direction: null }, null), null);
  assert.equal(selectExecutableDirection(setupAnalysis(null), { detected: true, failed: true, direction: "long" }, null), null);
});

test("setup, breakout, patience, risk direction, stops, and targets cannot contradict", () => {
  const selected = selectExecutableDirection(setupAnalysis("short"), { detected: true, failed: false, direction: "long" }, "long");
  assert.equal(selected, "short");
  const contract = getFuturesContractSpecification("MES");
  const plan = buildPhase7RiskPlan(6800, selected, 6800.25, 6800.5, {
    riskDollars: 100,
    dailyLossLimit: 500,
    dailyLossUsed: 0,
    tradesToday: 0,
    maxTradesPerDay: 1,
    maxContracts: 1,
    maxPositionValue: 100_000,
    maximumSpreadTicks: contract.maximumSpreadTicks,
    minimumLiquidity: contract.minimumLiquidity,
    staleDataSeconds: 15,
    dataAgeSeconds: 0,
    observedSpreadTicks: 1,
    liquidity: contract.minimumLiquidity,
    emergencyKillSwitch: false,
    duplicateEntry: false,
    averagingDown: false,
  }, contract);
  assert.equal(plan.direction, "short");
  assert.ok(plan.strategyStop! > plan.entry!);
  assert.ok(plan.catastropheStop! > plan.strategyStop!);
  assert.ok(plan.target! < plan.entry!);
});

test("snapshot conforms to the generated API contract", () => {
  const snapshot = createMarketSnapshot("MNQ", "regular");
  assert.doesNotThrow(() => GetMarketSnapshotResponse.parse(snapshot));
});

test("public dashboard decision and rule lists project the selected phased evaluation", () => {
  const snapshot = createMarketSnapshot("MES", "regular");
  const selected = snapshot.setupAnalysis.primarySetup === null
    ? snapshot.setupAnalysis.evaluations[0]
    : snapshot.setupAnalysis.evaluations.find((evaluation) => evaluation.setupType === snapshot.setupAnalysis.primarySetup)!;
  assert.deepEqual(
    snapshot.decision.passedRules.map((rule) => rule.key),
    selected.rules.filter((rule) => rule.passed).map((rule) => rule.key),
  );
  assert.deepEqual(
    snapshot.decision.failedRules.map((rule) => rule.key),
    selected.rules.filter((rule) => !rule.passed).map((rule) => rule.key),
  );
  assert.equal(snapshot.signals.length, 4);
  assert.ok(snapshot.decision.explanation.includes(`ORB state: ${snapshot.breakout.state}.`));
  assert.equal(snapshot.breakout.detected, snapshot.signals.find((signal) => signal.key === "orb")?.status === "confirmed");
});

function invariantFixture(overrides: Record<string, unknown> = {}) {
  const evaluation = {
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION" as const,
    direction: "long" as const,
    decision: "SETUP QUALIFIED" as const,
    mandatoryPassed: true,
    alertOnly: false,
    rules: [{
      key: "riskApproval",
      label: "Risk approval",
      passed: true,
      mandatory: true,
      detail: "approved",
    }],
    reversalEvidence: null,
    consolidation: null,
    explanation: "qualified",
  };
  return {
    ntz: { complete: true },
    breakout: {
      detected: true,
      failed: false,
      state: "QUALIFIED_BREAKOUT" as const,
      volumeSupported: true,
      continuationConfirmed: true,
      direction: "long" as const,
    },
    signals: [
      { key: "orb" as const, status: "confirmed" as const },
      { key: "pullback" as const, status: "confirmed" as const },
      { key: "patience" as const, status: "confirmed" as const },
      { key: "volume" as const, status: "confirmed" as const },
    ],
    riskPlan: { allowed: true, contracts: 1, direction: "long" as const },
    patience: { entryBufferPrice: 100, strategyStopPrice: 99 },
    setupAnalysis: {
      decision: "SETUP QUALIFIED" as const,
      primarySetup: "ORB_BREAK_PULLBACK_CONTINUATION" as const,
      evaluations: [evaluation],
    },
    shadowExecution: { contracts: 1 },
    ...overrides,
  };
}

test("dashboard invariant validator flags every blocked or contradictory state", () => {
  const orbContradiction = validateDashboardInvariants(invariantFixture({
    breakout: {
      detected: false,
      failed: false,
      state: "WEAK_BREAK_WAIT",
      volumeSupported: false,
      continuationConfirmed: false,
      direction: "long",
    },
  }));
  assert.ok(orbContradiction.some((violation) => violation.code === "ORB_SIGNAL_WITHOUT_QUALIFIED_BREAKOUT"));

  const blockedRisk = validateDashboardInvariants(invariantFixture({
    riskPlan: { allowed: false, contracts: 0, direction: "short" },
  }));
  assert.ok(blockedRisk.some((violation) => violation.code === "RISK_APPROVAL_CONTRADICTION"));
  assert.ok(blockedRisk.some((violation) => violation.code === "SETUP_DIRECTION_CONTRADICTION"));
  assert.ok(blockedRisk.some((violation) => violation.code === "SHADOW_EXECUTION_WHILE_BLOCKED"));

  const missingEntry = invariantFixture({
    patience: { entryBufferPrice: null, strategyStopPrice: null },
    shadowExecution: null,
  });
  assert.ok(validateDashboardInvariants(missingEntry).some((violation) => violation.code === "QUALIFIED_SETUP_WITHOUT_PATIENCE_ENTRY"));
  assert.throws(() => assertDashboardInvariants(missingEntry), /QUALIFIED_SETUP_WITHOUT_PATIENCE_ENTRY/);
});