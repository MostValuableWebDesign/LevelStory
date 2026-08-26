import assert from "node:assert/strict";
import test from "node:test";
import { GetMarketSnapshotResponse } from "@workspace/api-zod";
import { completedCandles } from "./types.js";
import { strategyConfig } from "./config.js";
import { ema, fibonacci, rsi } from "./indicators.js";
import { positionSize } from "./risk.js";
import { patience, volumeCheck } from "./rules.js";
import { createMarketSnapshot } from "../market-data.js";
import { getFuturesContractSpecification } from "../futures/contracts.js";

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
  assert.equal(locked.decision.state, "RISK LOCKOUT");
  assert.match(locked.decision.explanation, /Risk controls|lockout|blocked/i);
});

test("snapshot conforms to the generated API contract", () => {
  const snapshot = createMarketSnapshot("MNQ", "regular");
  assert.doesNotThrow(() => GetMarketSnapshotResponse.parse(snapshot));
});