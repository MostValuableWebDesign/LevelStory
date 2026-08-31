import test from "node:test";
import assert from "node:assert/strict";
import { detectLongTermZones, clearLongTermZoneCache } from "./long-term-zones.js";

const bar = (day: number, high: number, low: number) => {
  const openTime = Date.UTC(2026, 0, 1 + day, 14);
  return { openTime, closeTime: openTime + 3_600_000, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100, isComplete: true };
};

test("requires three dates and deduplicates adjacent pivot candles", () => {
  clearLongTermZoneCache();
  const bars = [
    bar(0, 100, 90), bar(1, 101, 91), bar(2, 110, 95), bar(3, 101, 91),
    bar(4, 100, 90), bar(8, 110, 95), bar(9, 101, 91), bar(10, 100, 90),
    bar(16, 110, 95), bar(17, 101, 91), bar(18, 100, 90),
  ];
  const zones = detectLongTermZones(bars, { lookback: "one-year", widthTicks: 12, tickSize: 0.25 });
  assert.ok(zones.some((zone) => zone.role === "resistance" && zone.touchCount >= 3));
});

test("never reads bars after the cursor and separates lookbacks", () => {
  const bars = [bar(0, 110, 90), bar(1, 100, 91), bar(2, 110, 90), bar(3, 100, 91), bar(4, 110, 90), bar(5, 100, 91)];
  const early = detectLongTermZones(bars, { lookback: "six-month", cursor: bars[3]!.closeTime, widthTicks: 12 });
  const late = detectLongTermZones(bars, { lookback: "one-year", cursor: bars[5]!.closeTime, widthTicks: 12 });
  assert.ok(early.every((zone) => zone.latestTimestamp <= bars[3]!.closeTime));
  assert.ok(Array.isArray(late));
});

test("cache identity includes the input series content", () => {
  clearLongTermZoneCache();
  const bars = [bar(0, 100, 90), bar(1, 101, 91), bar(2, 110, 95), bar(3, 101, 91), bar(4, 100, 90), bar(8, 110, 95), bar(9, 101, 91), bar(10, 100, 90), bar(16, 110, 95), bar(17, 101, 91), bar(18, 100, 90)];
  const shifted = bars.map((item) => ({ ...item, open: item.open + 100, high: item.high + 100, low: item.low + 100, close: item.close + 100 }));
  const first = detectLongTermZones(bars, { lookback: "one-year", seriesIdentity: "MES" });
  const second = detectLongTermZones(shifted, { lookback: "one-year", seriesIdentity: "MES" });
  assert.notEqual(first[0]?.midpoint, second[0]?.midpoint);
});