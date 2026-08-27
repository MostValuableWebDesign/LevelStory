import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "./contracts.js";
import {
  aggregateFiveMinuteCandles,
  createMarketDataProvider,
  normalizeProviderCandle,
  normalizedToSimulatedCandle,
  parseCsvCandles,
  selectFrontMonthContract,
  validateCandleSeries,
} from "./market-data-provider.js";

const specification = getFuturesContractSpecification("MES");

function candle(openTime: number, overrides: Record<string, unknown> = {}) {
  return normalizeProviderCandle({
    ts_event: openTime * 1_000_000,
    open: 6800,
    high: 6801,
    low: 6799,
    close: 6800.5,
    volume: 100,
    bid: 6800.25,
    ask: 6800.75,
    bidSize: 10,
    askSize: 12,
    symbol: specification.fullContractSymbol,
    ...overrides,
  }, specification, 1)!;
}

test("normalizes nanosecond timestamps and preserves nullable market fields", () => {
  const normalized = normalizeProviderCandle({
    ts_event: 1_756_209_600_000_000_000,
    open: "6800",
    high: "6801",
    low: "6799",
    close: "6800.5",
    volume: null,
    symbol: specification.fullContractSymbol,
  }, specification);
  assert.equal(normalized?.open, 6800);
  assert.equal(normalized?.volume, null);
  assert.equal(normalized?.bid, null);
  assert.equal(normalized?.ask, null);
  assert.ok(normalized?.quality.codes.includes("MISSING_BID_ASK"));
});

test("aggregates exactly aligned five-minute buckets without manufacturing quotes", () => {
  const start = Date.parse("2026-08-26T13:30:00.000Z");
  const oneMinute = Array.from({ length: 5 }, (_, index) => candle(start + index * 60_000, {
    open: 6800 + index,
    high: 6801 + index,
    low: 6799 + index,
    close: 6800.5 + index,
    bid: index === 4 ? null : 6800.25 + index,
    ask: index === 4 ? null : 6800.75 + index,
  }));
  const aggregated = aggregateFiveMinuteCandles(oneMinute, specification);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].open, 6800);
  assert.equal(aggregated[0].close, 6804.5);
  assert.equal(aggregated[0].volume, 500);
  assert.equal(aggregated[0].bid, 6803.25);
  assert.equal(aggregated[0].ask, 6803.75);
  assert.equal(aggregated[0].isComplete, true);
});

test("quality gates identify duplicates, gaps, stale data, and missing liquidity fields", () => {
  const start = Date.parse("2026-08-26T13:30:00.000Z");
  const candles = [
    candle(start, { bid: null, ask: null, volume: null }),
    candle(start, { close: 6801 }),
    candle(start + 10 * 60_000),
  ];
  const quality = validateCandleSeries(candles, specification, start + 30 * 60_000);
  assert.equal(quality.duplicateCount, 1);
  assert.equal(quality.gapCount, 1);
  assert.equal(quality.stale, true);
  assert.equal(quality.missingBidAskCount, 1);
  assert.equal(quality.missingVolumeCount, 1);
  assert.equal(quality.valid, false);
});

test("CSV replay maps rows into the same normalized candle contract", () => {
  const csv = [
    "timestamp,open,high,low,close,volume,bid,ask,bidSize,askSize,symbol",
    "2026-08-26T13:30:00Z,6800,6801,6799,6800.5,100,6800.25,6800.75,10,12,MESU26",
  ].join("\n");
  const [parsed] = parseCsvCandles(csv, specification);
  assert.equal(parsed.contractSymbol, "MESU26");
  assert.equal(parsed.volume, 100);
  assert.ok(normalizedToSimulatedCandle(parsed));
});

test("front-month selection advances on the configured rollover date", () => {
  const before = selectFrontMonthContract(specification, "2026-09-09");
  const after = selectFrontMonthContract(specification, "2026-09-10");
  assert.equal(before.fullContractSymbol, "MESU26");
  assert.equal(after.fullContractSymbol, "MESZ26");
  assert.equal(after.contractMonth, "2026-12");
});

test("all providers advertise a data-only, no-execution boundary", async () => {
  for (const kind of ["simulated", "csv", "databento"] as const) {
    const provider = createMarketDataProvider(kind, specification);
    assert.equal(provider.metadata.dataOnly, true);
    assert.equal(provider.metadata.executionEnabled, false);
    await provider.disconnect();
  }
});