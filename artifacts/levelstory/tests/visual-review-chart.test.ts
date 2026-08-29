import assert from "node:assert/strict";
import test from "node:test";
import type { VisualValidationAnnotation, VisualValidationCandle } from "@workspace/api-client-react";
import {
  CANDLE_WINDOW_MAX,
  CANDLE_WINDOW_MIN,
  DOJI_BODY_HEIGHT,
  formatDataSource,
  getCandleDomain,
  getCandleGeometry,
  getEdgeIndicators,
  hasRepetitiveFixtureData,
  findCandleIndexAtTimestamp,
  invalidRawCandleIndices,
  priceToY,
  selectFocusedCandles,
  stackLabelPositions,
} from "../src/lib/visual-review-chart.ts";

const baseTime = Date.parse("2026-08-26T13:30:00.000Z");

function makeCandle(index: number, overrides: Partial<VisualValidationCandle> = {}): VisualValidationCandle {
  const openTime = new Date(baseTime + index * 5 * 60_000).toISOString();
  const closeTime = new Date(baseTime + (index + 1) * 5 * 60_000).toISOString();
  return {
    openTime,
    closeTime,
    timestamp: openTime,
    open: 100 + index * 0.1,
    high: 100.7 + index * 0.1,
    low: 99.7 + index * 0.1,
    close: 100.4 + index * 0.1,
    volume: 1000 + index,
    bid: 100.3 + index * 0.1,
    ask: 100.5 + index * 0.1,
    bidSize: 2,
    askSize: 3,
    contractSymbol: "MESU6",
    isComplete: true,
    ...overrides,
  };
}

function makeAnnotation(id: string, price: number | null, overrides: Partial<VisualValidationAnnotation> = {}): VisualValidationAnnotation {
  return {
    id,
    label: id,
    kind: "level",
    price,
    openTime: null,
    closeTime: null,
    available: price !== null,
    color: "accent",
    detail: id,
    visibility: "machine",
    ...overrides,
  };
}

test("candle domain uses candle extremes and padding, never distant annotation prices", () => {
  const candles = [makeCandle(0), makeCandle(1)];
  const domain = getCandleDomain(candles);
  assert.equal(domain.rawMin, 99.7);
  assert.equal(domain.rawMax, 100.8);
  assert.ok(domain.max < 110);
  assert.ok(domain.min > 90);
  assert.equal(domain.padding, (domain.rawMax - domain.rawMin) * 0.08);
});

test("out-of-range primary levels receive edge indicators with their actual prices", () => {
  const domain = getCandleDomain([makeCandle(0)]);
  const indicators = getEdgeIndicators([
    makeAnnotation("target", domain.max + 20),
    makeAnnotation("strategy-stop", domain.min - 20),
    makeAnnotation("vwap", (domain.min + domain.max) / 2),
  ], domain);
  assert.deepEqual(indicators.map(({ annotation, edge }) => [annotation.id, annotation.price, edge]), [
    ["target", domain.max + 20, "top"],
    ["strategy-stop", domain.min - 20, "bottom"],
  ]);
});

test("exact raw OHLC values map to full wick and body coordinates", () => {
  const candle = makeCandle(0, { open: 101, high: 104, low: 98, close: 102 });
  const domain = getCandleDomain([candle]);
  const geometry = getCandleGeometry(candle, 2, 20, domain);
  assert.equal(geometry.highY, priceToY(104, domain));
  assert.equal(geometry.lowY, priceToY(98, domain));
  assert.equal(geometry.openY, priceToY(101, domain));
  assert.equal(geometry.closeY, priceToY(102, domain));
  assert.equal(geometry.bodyTop, Math.min(geometry.openY, geometry.closeY));
  assert.equal(geometry.bodyHeight, Math.abs(geometry.closeY - geometry.openY));
});

test("doji bodies stay visible without changing OHLC coordinates", () => {
  const candle = makeCandle(0, { open: 101, high: 102, low: 100, close: 101 });
  const geometry = getCandleGeometry(candle, 0, 20, getCandleDomain([candle]));
  assert.equal(geometry.openY, geometry.closeY);
  assert.equal(geometry.bodyHeight, DOJI_BODY_HEIGHT);
});

test("dense level labels are stacked without overlap", () => {
  const positions = stackLabelPositions([
    { id: "a", y: 100 },
    { id: "b", y: 101 },
    { id: "c", y: 102 },
    { id: "d", y: 103 },
  ], 30, 100, 15);
  assert.equal(new Set(positions.map((position) => position.id)).size, 4);
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index].y - positions[index - 1].y >= 15);
  }
  assert.ok(positions.every((position) => position.y >= 30 && position.y <= 100));
});

test("focused window stays bounded and includes post-cursor candles only through review cursor", () => {
  const candles = Array.from({ length: 80 }, (_, index) => makeCandle(index));
  const evaluationClose = candles[50].closeTime;
  const reviewClose = candles[57].closeTime;
  const focused = selectFocusedCandles(candles, evaluationClose, reviewClose);
  assert.ok(focused.length >= CANDLE_WINDOW_MIN && focused.length <= CANDLE_WINDOW_MAX);
  assert.equal(focused.at(-1)?.closeTime, reviewClose);
  assert.ok(focused.some((candle) => !candle.machineVisible));
  assert.ok(focused.filter((candle) => candle.machineVisible).every((candle) => Date.parse(candle.closeTime) <= Date.parse(evaluationClose)));
  assert.ok(focused.every((candle) => Date.parse(candle.closeTime) <= Date.parse(reviewClose)));
});

test("event markers resolve only exact candle timestamps", () => {
  const candles = Array.from({ length: 4 }, (_, index) => makeCandle(index));
  assert.equal(findCandleIndexAtTimestamp(candles, candles[2].openTime), 2);
  assert.equal(findCandleIndexAtTimestamp(candles, candles[2].closeTime), 2);
  assert.equal(findCandleIndexAtTimestamp(candles, new Date(baseTime + 1).toISOString()), -1);
});

test("raw integrity and repetitive-fixture checks do not rewrite candles", () => {
  const repeated = Array.from({ length: 6 }, () => makeCandle(0));
  assert.equal(hasRepetitiveFixtureData(repeated), true);
  const invalid = makeCandle(0, { high: 99, low: 100 });
  assert.deepEqual(invalidRawCandleIndices([makeCandle(0), invalid]), [1]);
  assert.equal(invalid.open, 100);
  assert.equal(invalid.high, 99);
  assert.equal(invalid.low, 100);
});

test("source labels distinguish simulation from historical Databento data", () => {
  assert.equal(formatDataSource("simulated"), "Simulated fixture data");
  assert.equal(formatDataSource("historical_databento", "MESU6"), "Historical Databento data — MESU6");
  assert.equal(formatDataSource("historical_databento_multicontract", "MESU6"), "Historical Databento data — MESU6");
});