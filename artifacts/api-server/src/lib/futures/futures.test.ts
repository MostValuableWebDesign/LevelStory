import assert from "node:assert/strict";
import test from "node:test";
import {
  FUTURES_CONTRACT_SPECS,
  dollarsForTicks,
  generateSimulatedFuturesFeed,
  getFuturesContractSpecification,
  priceToTicks,
  roundToTick,
  ticksBetween,
  validateFuturesContractSpecification,
  wholeContractQuantity,
} from "./index.js";
import { sessionCalendarForContract } from "./session-calendar.js";
import { assertShadowMode, SHADOW_MODE_CAPABILITIES, SHADOW_MODE_LABEL } from "../modules/shadow-execution.js";
import { strategyConfig } from "../strategy/config.js";

test("futures catalog loads all configurable example contracts", () => {
  for (const symbol of ["MES", "ES", "MNQ", "NQ"]) {
    const specification = getFuturesContractSpecification(symbol);
    assert.equal(specification.rootSymbol, symbol);
    assert.equal(specification.configurable, true);
    assert.match(specification.verificationNote, /verify/i);
    assert.equal(specification.fullContractSymbol.startsWith(symbol), true);
    assert.equal(
      specification.dollarValuePerTick,
      specification.pointValue * specification.tickSize * specification.contractMultiplier,
    );
  }
  assert.equal(getFuturesContractSpecification("MESU26").rootSymbol, "MES");
});

test("invalid futures contract configuration is rejected", () => {
  const invalid = {
    ...FUTURES_CONTRACT_SPECS.MES,
    dollarValuePerTick: 99,
  };
  assert.throws(
    () => validateFuturesContractSpecification(invalid),
    /dollarValuePerTick must equal pointValue/,
  );
  assert.throws(
    () => getFuturesContractSpecification("AAPL"),
    /unsupported futures symbol/,
  );
});

test("futures tick calculations and whole-contract quantities use contract economics", () => {
  const mes = getFuturesContractSpecification("MES");
  assert.equal(priceToTicks(6_800.25, mes), 27_201);
  assert.equal(roundToTick(6_800.12, mes), 6_800);
  assert.equal(ticksBetween(6_800, 6_799.5, mes), 2);
  assert.equal(dollarsForTicks(2, 3, mes), 7.5);
  assert.equal(wholeContractQuantity(100, 6_800, 6_799.5, mes), 40);
  assert.equal(Number.isInteger(wholeContractQuantity(100, 6_800, 6_799.5, mes)), true);
});

test("central strategy configuration loads and rejects unsupported feed intervals", () => {
  const config = strategyConfig({ defaultContractSymbol: "MNQ", simulationSeed: 42 });
  assert.equal(config.defaultContractSymbol, "MNQ");
  assert.equal(config.barIntervalMinutes, 5);
  assert.throws(
    () => strategyConfig({ barIntervalMinutes: 1 } as unknown as Partial<typeof config>),
    /barIntervalMinutes must be 5/,
  );
});

test("simulated futures feed is deterministic, quote-aware, and chronologically ordered", () => {
  const specification = getFuturesContractSpecification("ES");
  const calendar = sessionCalendarForContract(specification);
  const options = {
    calendar,
    startDate: Date.UTC(2026, 7, 25),
    days: 1,
    seed: 7,
    includePremarket: true,
  };
  const first = generateSimulatedFuturesFeed(specification, options);
  const second = generateSimulatedFuturesFeed(specification, options);
  assert.deepEqual(first, second);
  assert.ok(first.length > 100);
  assert.ok(first.every((candle) => candle.contractSymbol === "ESU26"));
  assert.ok(first.every((candle) => candle.openTime < candle.closeTime));
  assert.ok(first.every((candle) => candle.bid < candle.ask));
  assert.ok(first.every((candle, index) => index === 0 || candle.timestamp > first[index - 1].timestamp));
});

test("Shadow Mode enforcement has no live or paper order capability", () => {
  assert.equal(SHADOW_MODE_LABEL, "SHADOW MODE — NO LIVE ORDERS");
  assert.deepEqual(assertShadowMode(), SHADOW_MODE_CAPABILITIES);
  assert.equal(SHADOW_MODE_CAPABILITIES.brokerAuthentication, false);
  assert.equal(SHADOW_MODE_CAPABILITIES.liveOrders, false);
  assert.equal(SHADOW_MODE_CAPABILITIES.paperBrokerOrders, false);
});