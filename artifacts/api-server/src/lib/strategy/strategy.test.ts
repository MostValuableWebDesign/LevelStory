import assert from "node:assert/strict";
import test from "node:test";
import { GetMarketSnapshotResponse } from "@workspace/api-zod";
import { completedCandles } from "./types.js";
import { strategyConfig } from "./config.js";
import { ema, fibonacci, rsi } from "./indicators.js";
import { positionSize } from "./risk.js";
import { buildPhase7RiskPlan } from "./phase7.js";
import { assertDashboardInvariants, validateDashboardInvariants } from "./invariants.js";
import { createMarketSnapshot, selectExecutableDirection } from "../market-data.js";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import { timestampForTradingDate } from "../futures/session-calendar.js";
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
  const currentRegularOpen = timestampForTradingDate(premarket.replay.tradingDate, "09:30");
  assert.equal(premarket.candles.some(candle => Date.parse(candle.openTime) >= currentRegularOpen), false);
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

test("snapshot metadata follows each effective replay trading date", () => {
  const summer = createMarketSnapshot("MES", "regular", undefined, undefined, undefined, {
    tradingDate: "2026-08-25",
    cursor: timestampForTradingDate("2026-08-25", "10:00"),
  });
  const winter = createMarketSnapshot("MES", "regular", undefined, undefined, undefined, {
    tradingDate: "2026-01-05",
    cursor: timestampForTradingDate("2026-01-05", "10:00"),
  });
  assert.equal(summer.sessionCalendar.tradingDate, "2026-08-25");
  assert.equal(summer.replay.tradingDate, "2026-08-25");
  assert.equal(summer.indicators.vwapSessionDate, "2026-08-25");
  assert.equal(winter.sessionCalendar.tradingDate, "2026-01-05");
  assert.equal(winter.replay.tradingDate, "2026-01-05");
  assert.equal(winter.indicators.vwapSessionDate, "2026-01-05");
  assert.notEqual(summer.replay.cursor, winter.replay.cursor);
});

test("snapshot honors unavailable premarket data and cursor-derived market status", () => {
  const noPremarket = createMarketSnapshot("MES", "premarket", undefined, undefined, undefined, {
    tradingDate: "2026-03-09",
    cursor: timestampForTradingDate("2026-03-09", "09:50"),
    premarketAvailable: false,
  });
  assert.equal(noPremarket.sessionCalendar.premarketAvailable, false);
  assert.equal(noPremarket.levels.premarketHigh, null);
  assert.equal(noPremarket.levels.premarketLow, null);
  assert.equal(noPremarket.marketStatus, "open");

  const beforeOpen = createMarketSnapshot("MES", "regular", undefined, undefined, undefined, {
    tradingDate: "2026-03-09",
    cursor: timestampForTradingDate("2026-03-09", "09:20"),
  });
  const afterClose = createMarketSnapshot("MES", "regular", undefined, undefined, undefined, {
    tradingDate: "2026-03-09",
    cursor: timestampForTradingDate("2026-03-09", "16:00"),
  });
  assert.equal(beforeOpen.marketStatus, "premarket");
  assert.equal(afterClose.marketStatus, "closed");
  assert.equal(new Date(beforeOpen.replay.cursor).toISOString(), "2026-03-09T13:20:00.000Z");
  assert.equal(new Date(afterClose.replay.cursor).toISOString(), "2026-03-09T20:00:00.000Z");
});

test("a replay cursor cannot silently cross its selected trading date", () => {
  assert.throws(
    () => createMarketSnapshot("MES", "regular", undefined, undefined, undefined, {
      tradingDate: "2026-08-25",
      cursor: timestampForTradingDate("2026-08-26", "10:00"),
    }),
    /outside trading date/,
  );
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

test("public strategy barrels do not expose the retired monolithic decision helper", async () => {
  const strategyExports = await import("./index.js");
  const compatibilityExports = await import("../modules/strategy-evaluation.js");
  const retiredHelper = ["full", "Decision"].join("");
  assert.equal(retiredHelper in strategyExports, false);
  assert.equal(retiredHelper in compatibilityExports, false);
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
  const orbSignal = snapshot.signals.find((signal) => signal.key === "orb");
  assert.equal(
    orbSignal?.status === "confirmed",
    snapshot.breakout.detected
      && snapshot.breakout.state !== "SETUP_EXPIRED"
      && snapshot.breakout.volumeSupported
      && snapshot.breakout.continuationConfirmed,
  );
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
  assert.doesNotThrow(() => assertDashboardInvariants(invariantFixture({
    breakout: {
      detected: false,
      failed: false,
      state: "WEAK_BREAK_WAIT",
      volumeSupported: false,
      continuationConfirmed: false,
      direction: "long",
    },
  })));

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