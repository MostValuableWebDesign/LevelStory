import assert from "node:assert/strict";
import test from "node:test";
import type { VisualValidationAnnotation, VisualValidationCandle, VisualValidationSnapshot } from "@workspace/api-client-react";
import {
  CANDLE_WINDOW_MAX,
  CANDLE_WINDOW_MIN,
  DOJI_BODY_HEIGHT,
  layoutEventRail,
  getCandleSlotIndex,
  formatAxisDate,
  formatInterval,
  formatDataSource,
  getCandleInspection,
  getFixedTimeAxisTicks,
  getPriceAxis,
  getTimeAxisTicks,
  getVolumeAxisTicks,
  getCandleDomain,
  getCandleGeometry,
  getEdgeIndicators,
  getSessionDomainSlotCount,
  hasExactCandleAnchor,
  hasRepetitiveFixtureData,
  findCandleIndexAtTimestamp,
  invalidRawCandleIndices,
  isOpeningRangeCompleteAtEvaluation,
  isDisplacedLabel,
  isExactFiveMinuteCandle,
  isPrimaryLevel,
  mergeOrbNtzAnnotations,
  priceToY,
  resolveFixedSlotFromClientPoint,
  selectSessionCandles,
  selectChartEvents,
  selectFocusedCandles,
  snapPrice,
  stackLabelPositions,
  summarizeCategoryCoverage,
  type EventRailEvent,
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

function makeRailEvent(id: string, index: number, overrides: Partial<EventRailEvent> = {}): EventRailEvent {
  const candle = makeCandle(index);
  return {
    id,
    kind: "supporting",
    label: `Event ${id}`,
    shortLabel: "·",
    detail: `detail for ${id}`,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    price: candle.close,
    visibility: "machine",
    priority: 6,
    markerSlot: index,
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

test("event rail sorting is deterministic by timestamp, priority, then stable ID", () => {
  const events = [
    makeRailEvent("zeta", 2, { priority: 4 }),
    makeRailEvent("alpha", 1, { priority: 8 }),
    makeRailEvent("beta", 1, { priority: 2 }),
    makeRailEvent("aardvark", 1, { priority: 2 }),
  ];
  const layout = layoutEventRail(events, { left: 0, right: 300, slotCount: 10 });
  assert.deepEqual(layout.events.map((event) => event.id), ["aardvark", "beta", "alpha", "zeta"]);
  assert.deepEqual(layout.events.map((event) => event.order), [0, 1, 2, 3]);
});

test("event rail uses four collision-aware lanes and preserves dense events as numbered overflow", () => {
  const events = Array.from({ length: 6 }, (_, index) => makeRailEvent(`same-${index}`, 4, {
    label: `Same candle event ${index} with a descriptive label`,
  }));
  const layout = layoutEventRail(events, { left: 0, right: 220, slotCount: 10, laneCount: 4, labelGap: 4 });
  assert.equal(layout.laneCount, 4);
  assert.equal(layout.events.filter((event) => !event.overflow).length, 4);
  assert.equal(layout.events.filter((event) => event.overflow).length, 2);
  assert.equal(layout.hasOverflow, true);
  const visible = layout.events.filter((event) => !event.overflow);
  for (const first of visible) {
    for (const second of visible) {
      if (first.id >= second.id || first.lane !== second.lane) continue;
      assert.ok(first.labelX + first.labelWidth + 4 <= second.labelX || second.labelX + second.labelWidth + 4 <= first.labelX);
    }
  }
});

test("human-only rail labels are dashed and routed to the cursor's outcome side", () => {
  const layout = layoutEventRail([
    makeRailEvent("human", 8, { visibility: "human_only", label: "Later observed outcome" }),
    makeRailEvent("machine", 2, { visibility: "machine" }),
  ], { left: 0, right: 300, slotCount: 10, cursorX: 150 });
  const human = layout.events.find((event) => event.id === "human");
  const machine = layout.events.find((event) => event.id === "machine");
  assert.ok(human && machine);
  assert.ok(human.labelX >= 158);
  assert.notEqual(human.lane, undefined);
  assert.equal(machine?.overflow, false);
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

test("stacked labels expose displacement for connector rendering", () => {
  assert.equal(isDisplacedLabel(100, 100), false);
  assert.equal(isDisplacedLabel(118, 100), true);
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
  assert.equal(findCandleIndexAtTimestamp(candles, candles[2].closeTime), 3);
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

test("only completed exact five-minute candles enter the execution chart", () => {
  const exact = makeCandle(0);
  const tenMinute = makeCandle(1, {
    closeTime: new Date(baseTime + 15 * 60_000).toISOString(),
  });
  const incomplete = makeCandle(2, { isComplete: false as true });
  assert.equal(isExactFiveMinuteCandle(exact), true);
  assert.equal(isExactFiveMinuteCandle(tenMinute), false);
  assert.equal(isExactFiveMinuteCandle(incomplete), false);
  const focused = selectFocusedCandles([exact, tenMinute, incomplete], exact.closeTime, incomplete.closeTime, 42);
  assert.deepEqual(focused.map((candle) => candle.openTime), [exact.openTime]);
});

test("primary session view contains the exact 42 regular-session intervals", () => {
  const regularCandles = Array.from({ length: 42 }, (_, index) => makeCandle(index));
  const selection = selectSessionCandles(
    regularCandles,
    regularCandles[2].closeTime,
    regularCandles.at(-1)!.closeTime,
  );
  assert.equal(selection.regularCandles.length, 42);
  assert.equal(selection.candles.length, 42);
  assert.equal(formatInterval(selection.regularCandles[0].openTime, selection.regularCandles[0].closeTime), "9:30 AM–9:35 AM ET");
  assert.equal(formatInterval(selection.regularCandles.at(-1)!.openTime, selection.regularCandles.at(-1)!.closeTime), "12:55 PM–1:00 PM ET");
  assert.equal(selection.regularCandles.slice(0, 3).every((candle) => candle.machineVisible), true);
  assert.equal(selection.regularCandles.slice(3).every((candle) => !candle.machineVisible), true);
  assert.deepEqual(getTimeAxisTicks(selection.regularCandles, "America/New_York", true).at(-1), {
    index: 42,
    position: 42,
    label: "1:00 PM",
  });
});

test("fixed session domains preserve 42 and 78 timestamp slots", () => {
  assert.equal(getSessionDomainSlotCount("primary"), 42);
  assert.equal(getSessionDomainSlotCount("full_regular"), 78);
  assert.equal(getSessionDomainSlotCount("primary", true), 108);
  assert.equal(getSessionDomainSlotCount("full_regular", true), 144);
  const first = makeCandle(0);
  assert.equal(getCandleSlotIndex(first, "primary"), 0);
  assert.equal(getCandleSlotIndex(first, "full_regular"), 0);
  assert.equal(getFixedTimeAxisTicks("primary").at(-1)?.label, "1:00 PM");
  assert.equal(getFixedTimeAxisTicks("full_regular").at(-1)?.label, "4:00 PM");
  assert.equal(getFixedTimeAxisTicks("primary", true).at(-1)?.index, 108);
});

test("fixed slot geometry leaves gaps empty instead of compressing observed candles", () => {
  const first = makeCandle(0);
  const third = makeCandle(2);
  const domain = getCandleDomain([first, third]);
  const step = (1040 - 58 - 150) / 42;
  const firstGeometry = getCandleGeometry(first, getCandleSlotIndex(first, "primary"), step, domain);
  const thirdGeometry = getCandleGeometry(third, getCandleSlotIndex(third, "primary"), step, domain);
  assert.equal(thirdGeometry.x - firstGeometry.x, step * 2);
});

test("fixed slot pointer resolver inverts SVG scaling and keeps empty slots addressable", () => {
  const rect = { left: 20, top: 10, width: 1600, height: 900 };
  const options = {
    viewBoxX: 0,
    viewBoxWidth: 1600,
    viewBoxHeight: 900,
    plotLeft: 140,
    plotRight: 1510,
    plotTop: 70,
    plotBottom: 700,
    slotCount: 78,
  };
  const step = (options.plotRight - options.plotLeft) / options.slotCount;
  const slotCenter = options.plotLeft + step * 20.5;
  assert.equal(resolveFixedSlotFromClientPoint(rect.left + slotCenter, rect.top + 200, rect, options), 20);
  assert.equal(resolveFixedSlotFromClientPoint(rect.left + slotCenter / 2, rect.top + 100, { ...rect, width: 800, height: 450 }, options), 20);
  assert.equal(resolveFixedSlotFromClientPoint(rect.left + options.plotRight + 1, rect.top + 200, rect, options), null);
  assert.equal(resolveFixedSlotFromClientPoint(rect.left + slotCenter, rect.top + options.plotBottom, rect, options), null);
});

test("fixed slot pointer resolver accounts for zoom and pan without snapping to observed candles", () => {
  const rect = { left: 0, top: 0, width: 800, height: 900 };
  const options = {
    viewBoxX: 300,
    viewBoxWidth: 800,
    viewBoxHeight: 900,
    plotLeft: 140,
    plotRight: 1510,
    plotTop: 70,
    plotBottom: 700,
    slotCount: 42,
  };
  const step = (options.plotRight - options.plotLeft) / options.slotCount;
  const selectedSvgX = options.plotLeft + step * 31.5;
  assert.equal(resolveFixedSlotFromClientPoint(selectedSvgX - options.viewBoxX, 200, rect, options), 31);
  assert.equal(resolveFixedSlotFromClientPoint(1500, 200, rect, options), null);
});

test("premarket remains separate and hidden by default while its levels stay primary references", () => {
  const premarket = Array.from({ length: 66 }, (_, index) => makeCandle(index, {
    openTime: new Date(baseTime - (66 - index) * 5 * 60_000).toISOString(),
    closeTime: new Date(baseTime - (65 - index) * 5 * 60_000).toISOString(),
  }));
  const regular = Array.from({ length: 42 }, (_, index) => makeCandle(index));
  const raw = [...premarket, ...regular];
  const hidden = selectSessionCandles(raw, regular[2].closeTime, regular.at(-1)!.closeTime);
  assert.equal(hidden.premarketCandles.length, 0);
  assert.equal(hidden.regularCandles.length, 42);
  const shown = selectSessionCandles(raw, regular[2].closeTime, regular.at(-1)!.closeTime, "primary", true);
  assert.equal(shown.premarketCandles.length, 66);
  assert.equal(shown.regularCandles.length, 42);
  assert.equal(shown.candles.length, 108);
  assert.equal(isPrimaryLevel({ ...makeAnnotation("premarket-high", 101), label: "Premarket high" }), true);
  assert.equal(isPrimaryLevel({ ...makeAnnotation("premarket-low", 99), label: "Premarket low" }), true);
});

test("ORB availability begins only after the 9:40–9:45 candle closes", () => {
  const regularCandles = Array.from({ length: 42 }, (_, index) => makeCandle(index));
  assert.equal(isOpeningRangeCompleteAtEvaluation(regularCandles, regularCandles[1].closeTime), false);
  assert.equal(isOpeningRangeCompleteAtEvaluation(regularCandles, regularCandles[2].openTime), false);
  assert.equal(isOpeningRangeCompleteAtEvaluation(regularCandles, regularCandles[2].closeTime), true);
});

test("full regular view expands only to the existing 4:00 PM boundary", () => {
  const regularCandles = Array.from({ length: 78 }, (_, index) => makeCandle(index));
  const primary = selectSessionCandles(regularCandles, regularCandles[2].closeTime, regularCandles.at(-1)!.closeTime);
  const full = selectSessionCandles(regularCandles, regularCandles[2].closeTime, regularCandles.at(-1)!.closeTime, "full_regular");
  assert.equal(primary.regularCandles.length, 42);
  assert.equal(full.regularCandles.length, 78);
  assert.equal(formatInterval(full.regularCandles.at(-1)!.openTime, full.regularCandles.at(-1)!.closeTime), "3:55 PM–4:00 PM ET");
  assert.equal(getTimeAxisTicks(full.regularCandles, "America/New_York", true).at(-1)?.label, "4:00 PM");
});

test("session filtering remains DST-safe in New York", () => {
  const dstOpen = "2026-03-09T13:30:00.000Z";
  const dstClose = "2026-03-09T13:35:00.000Z";
  const candle = makeCandle(0, { openTime: dstOpen, closeTime: dstClose, timestamp: dstOpen });
  const selection = selectSessionCandles([candle], dstClose, dstClose);
  assert.equal(selection.regularCandles.length, 1);
  assert.equal(formatInterval(dstOpen, dstClose), "9:30 AM–9:35 AM ET");
});

test("time axis uses New York 15-minute labels and keeps the date separate", () => {
  const candles = Array.from({ length: 9 }, (_, index) => makeCandle(index));
  const ticks = getTimeAxisTicks(candles);
  assert.deepEqual(ticks.map((tick) => tick.index), [0, 3, 6]);
  assert.deepEqual(ticks.map((tick) => tick.label), ["9:30 AM", "9:45 AM", "10:00 AM"]);
  assert.equal(formatAxisDate(candles[0].openTime), "Aug 26, 2026");
  assert.equal(formatInterval(candles[0].openTime, candles[0].closeTime), "9:30 AM–9:35 AM ET");
  assert.equal(formatInterval(candles[0].openTime, candles[0].closeTime).match(/\d{4}-\d{2}-\d{2}T/) == null, true);
});

test("price axis is adaptive, readable, and aligned to MES ticks", () => {
  const domain = getCandleDomain([makeCandle(0, { low: 6799.63, high: 6803.12 })]);
  const axis = getPriceAxis(domain);
  assert.ok(axis.ticks.length >= 6 && axis.ticks.length <= 10);
  assert.ok(axis.ticks.every((tick) => Math.abs(tick / 0.25 - Math.round(tick / 0.25)) < 1e-9));
  assert.ok(axis.ticks.every((tick, index) => index === 0 || tick > axis.ticks[index - 1]));
  assert.equal(snapPrice(6800.11), 6800);
  assert.equal(snapPrice(6800.14), 6800.25);
  assert.ok(axis.ticks.every((tick) => !Number.isNaN(Number(tick.toFixed(2)))));
});

test("volume axis uses readable secondary units", () => {
  const ticks = getVolumeAxisTicks(2600);
  assert.deepEqual(ticks.map((tick) => tick.label), ["0", "1K", "2K", "3K"]);
});

test("crosshair inspection preserves exact raw OHLCV and visibility", () => {
  const candle = makeCandle(0, {
    open: 6800.25,
    high: 6801.5,
    low: 6799.75,
    close: 6801,
    volume: 1234,
  });
  const inspection = getCandleInspection({ ...candle, machineVisible: false });
  assert.equal(inspection.interval, "9:30 AM–9:35 AM ET");
  assert.equal(inspection.newYork.includes("Aug 26, 2026"), true);
  assert.equal(inspection.utc.includes("Aug 26, 2026"), true);
  assert.deepEqual(
    [inspection.open, inspection.high, inspection.low, inspection.close, inspection.volume],
    [candle.open, candle.high, candle.low, candle.close, candle.volume],
  );
  assert.equal(inspection.contractSymbol, "MESU6");
  assert.equal(inspection.machineVisible, false);
});

test("category coverage reports available and missing historical categories without fabrication", () => {
  const summary = summarizeCategoryCoverage([
    { category: "strong_breakout", label: "Strong breakout", count: 1, available: true },
    { category: "qualified_trade", label: "Qualified trade", count: 0, available: false },
    { category: "pullback", label: "Pullback", count: 0, available: true },
  ]);
  assert.deepEqual(summary.available.map((item) => item.category), ["strong_breakout"]);
  assert.deepEqual(summary.unavailable.map((item) => item.category), ["qualified_trade", "pullback"]);
});

test("default chart events are category-relevant and numbered in stable order", () => {
  const candles = [makeCandle(0), makeCandle(1)];
  const snapshot = {
    category: "bullish_patience_candle",
    categoryAnchor: {
      category: "bullish_patience_candle",
      auditId: "audit-1",
      tradeId: null,
      contractSymbol: "MESU6",
      openTime: candles[0].openTime,
      closeTime: candles[0].closeTime,
      price: candles[0].close,
      direction: "long",
      label: "Bullish patience candle",
      detail: "The patience candle held above the entry buffer.",
      relatedCandles: [{ role: "patience", openTime: candles[0].openTime, closeTime: candles[0].closeTime, price: candles[0].close, visibility: "machine" }],
      visibility: "machine",
    },
    tradeEvents: [{
      id: "stop-1",
      event: "stop",
      label: "Strategy stop",
      direction: "long",
      openTime: candles[1].openTime,
      closeTime: candles[1].closeTime,
      triggerPrice: candles[1].close,
      modeledPrice: candles[1].close,
      contracts: 1,
      visibility: "human_only",
      detail: "Observed after the evaluation cursor.",
    }],
    annotations: [],
  } as unknown as VisualValidationSnapshot;
  const relevant = selectChartEvents(snapshot, candles, "primary");
  assert.ok(relevant.length > 0);
  assert.ok(relevant.every((event, index) => event.number === index + 1));
  assert.equal(relevant.some((event) => event.kind === "stop"), false);
  const all = selectChartEvents(snapshot, candles, "primary", true);
  assert.equal(all.some((event) => event.kind === "stop"), true);
  assert.deepEqual(all.map((event) => event.number), all.map((_, index) => index + 1));
});

test("ORB and NTZ aliases collapse to one labeled upper and lower boundary", () => {
  const annotations = [
    makeAnnotation("orb-high", 101, { label: "Opening range high" }),
    makeAnnotation("ntz-high", 101, { label: "No-trade zone high" }),
    makeAnnotation("orb-low", 99, { label: "Opening range low" }),
    makeAnnotation("ntz-low", 99, { label: "No-trade zone low" }),
    makeAnnotation("vwap", 100),
  ];
  const merged = mergeOrbNtzAnnotations(annotations);
  assert.deepEqual(merged.filter((annotation) => annotation.id.startsWith("orb-")).map((annotation) => [annotation.id, annotation.label, annotation.price]), [
    ["orb-high", "ORB / NTZ High", 101],
    ["orb-low", "ORB / NTZ Low", 99],
  ]);
  assert.equal(merged.some((annotation) => annotation.id === "ntz-high" || annotation.id === "ntz-low"), false);
  assert.equal(merged.find((annotation) => annotation.id === "vwap")?.price, 100);
});

test("planned levels without an exact candle anchor cannot become occurrence markers", () => {
  assert.equal(hasExactCandleAnchor({ openTime: null, closeTime: null }), false);
  assert.equal(hasExactCandleAnchor({ openTime: null, closeTime: makeCandle(1).closeTime }), true);
  assert.equal(hasExactCandleAnchor({ openTime: makeCandle(1).openTime, closeTime: null }), true);
});