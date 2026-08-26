import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhase7RiskPlan,
  calculateShadowPnl,
  evaluateIntrabarStops,
  evaluateRunner,
  simulatePhase7Fill,
  targetPriceForDollars,
  targetTicksForDollars,
  validateProfitTargetDollars,
  type Phase7RiskConfig,
} from "./phase7.js";
import { getFuturesContractSpecification } from "../futures/contracts.js";

const specification = getFuturesContractSpecification("MES");

function config(overrides: Partial<Phase7RiskConfig> = {}): Phase7RiskConfig {
  return {
    riskDollars: 100,
    dailyLossLimit: 500,
    dailyLossUsed: 0,
    tradesToday: 0,
    maxTradesPerDay: 1,
    maxContracts: 10,
    maxPositionValue: 100_000,
    maximumSpreadTicks: specification.maximumSpreadTicks,
    minimumLiquidity: specification.minimumLiquidity,
    staleDataSeconds: 15,
    dataAgeSeconds: 0,
    observedSpreadTicks: 1,
    liquidity: specification.minimumLiquidity,
    emergencyKillSwitch: false,
    duplicateEntry: false,
    averagingDown: false,
    normalSlippageTicks: 1,
    fastSlippageTicks: 2,
    slippageMode: "normal",
    targetDollars: 75,
    ...overrides,
  };
}

test("Phase 7 target choices use ceiling ticks and preserve direction", () => {
  assert.equal(validateProfitTargetDollars(undefined), 75);
  assert.equal(targetTicksForDollars(50, specification), 40);
  assert.equal(targetTicksForDollars(62.51, specification), 51);
  assert.equal(targetPriceForDollars("long", 6800, 50, specification), 6810);
  assert.equal(targetPriceForDollars("short", 6800, 100, specification), 6780);
  for (const value of [49, 100.01]) assert.throws(() => validateProfitTargetDollars(value));
});

test("Phase 7 sizing includes both slippage legs and round-trip fees", () => {
  const plan = buildPhase7RiskPlan(6800, "long", 6799.75, 6799.5, config({ riskDollars: 10 }), specification);
  assert.equal(plan.stopTicks, 2);
  assert.equal(plan.costBreakdown.entrySlippage, 1.25);
  assert.equal(plan.costBreakdown.exitSlippage, 1.25);
  assert.equal(plan.costBreakdown.roundTripFees, 1.6);
  assert.equal(plan.costBreakdown.exchange, 0.24);
  assert.equal(plan.costBreakdown.regulatory, 0.12);
  assert.equal(plan.riskPerContract, 6.6);
  assert.equal(plan.contracts, 1);
  assert.equal(plan.dollarRisk, 6.6);
});

test("whole-contract floor rounding blocks when one contract cannot fit", () => {
  const plan = buildPhase7RiskPlan(6800, "long", 6799.75, 6799.5, config({ riskDollars: 6.59 }), specification);
  assert.equal(plan.contracts, 0);
  assert.equal(plan.allowed, false);
  assert.match(plan.reasons.join(" "), /zero contracts/i);
});

test("every Phase 7 safety lockout is explicit", () => {
  const cases: Array<[keyof ReturnType<typeof buildPhase7RiskPlan>["locks"], Partial<Phase7RiskConfig>]> = [
    ["tradeRisk", { riskDollars: 0 }],
    ["dailyLoss", { dailyLossUsed: 500 }],
    ["tradeCount", { tradesToday: 1 }],
    ["spread", { observedSpreadTicks: 3 }],
    ["liquidity", { liquidity: 1 }],
    ["staleData", { dataAgeSeconds: 16 }],
    ["duplicateEntry", { duplicateEntry: true }],
    ["averagingDown", { averagingDown: true }],
    ["emergencyKillSwitch", { emergencyKillSwitch: true }],
    ["contractCount", { maxContracts: 0 }],
  ];
  for (const [key, overrides] of cases) {
    const plan = buildPhase7RiskPlan(6800, "long", 6799.75, 6799.5, config(overrides), specification);
    assert.equal(plan.locks[key], true, key);
    assert.equal(plan.allowed, false, key);
    assert.ok(plan.reasons.length > 0, key);
  }
});

test("one contract is reserved for target and the rest are runners", () => {
  const plan = buildPhase7RiskPlan(6800, "long", 6799.5, 6799, config({ riskDollars: 1000, maxContracts: 3, maxPositionValue: 1_000_000 }), specification);
  assert.equal(plan.contracts, 3);
  assert.equal(plan.targetContracts, 1);
  assert.equal(plan.runnerContracts, 2);
  assert.equal(plan.target, 6815);
});

test("runner freezes its reference and exits at the inclusive 40% boundary", () => {
  const held = evaluateRunner("long", 100, 110, 106, true, 100, 10);
  assert.equal(held.referencePrice, 100);
  assert.equal(held.impulse, 10);
  assert.equal(held.retracementThreshold, 4);
  assert.equal(held.exit, true);
  const short = evaluateRunner("short", 100, 90, 94, true, 100, 10);
  assert.equal(short.exit, true);
  assert.equal(evaluateRunner("long", 100, 110, 107, false).referencePrice, null);
});

test("catastrophe stop always wins over strategy stop intrabar", () => {
  const long = evaluateIntrabarStops("long", { high: 6810, low: 6798 }, 6799.75, 6799.5);
  assert.equal(long.stop, "catastrophe");
  const short = evaluateIntrabarStops("short", { high: 6802, low: 6790 }, 6800.25, 6800.5);
  assert.equal(short.stop, "catastrophe");
  assert.equal(evaluateIntrabarStops("long", { high: 6802, low: 6799.75 }, 6799.75, 6799.5).stop, "strategy");
});

test("shadow fill honors intrabar stop precedence before target", () => {
  const fill = simulatePhase7Fill({
    direction: "long",
    entry: 6800,
    currentPrice: 6805,
    high: 6815,
    low: 6799,
    contracts: 1,
    strategyStop: 6799.75,
    catastropheStop: 6799.5,
    target: 6815,
    specification,
  });
  assert.equal(fill.stopped, "catastrophe");
  assert.equal(fill.exit, 6799.5);
});

test("shadow P&L reconciles gross, slippage, fees, and net", () => {
  const result = calculateShadowPnl("long", 6800, 6801, 1, specification);
  assert.equal(result.grossPnl, 5);
  assert.equal(result.slippage, 2.5);
  assert.equal(result.fees, 1.6);
  assert.equal(result.netPnl, 0.9);
});

test("fast and abnormal spread modes increase modeled adverse slippage", () => {
  const normal = calculateShadowPnl("long", 6800, 6801, 1, specification, "normal", 1);
  const fast = calculateShadowPnl("long", 6800, 6801, 1, specification, "fast", 1);
  const abnormal = calculateShadowPnl("long", 6800, 6801, 1, specification, "abnormal_spread", 2);
  assert.equal(normal.slippage, 2.5);
  assert.equal(fast.slippage, 5);
  assert.equal(abnormal.slippage, 7.5);
});