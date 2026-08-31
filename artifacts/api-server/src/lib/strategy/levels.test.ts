import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "../futures/contracts.js";
import { sessionCalendarForContract, sessionWindow, timestampForTradingDate } from "../futures/session-calendar.js";
import { strategyConfig } from "./config.js";
import { sessionLevels, type SessionWindows } from "./levels.js";
import type { Candle } from "./types.js";

const calendar = sessionCalendarForContract(getFuturesContractSpecification("MES"));
const config = strategyConfig();

function candle(
  date: string,
  time: string,
  high: number,
  low: number,
  close: number,
  complete = true,
): Candle {
  const openTime = timestampForTradingDate(date, time, calendar);
  return {
    openTime,
    closeTime: openTime + 5 * 60_000,
    open: close,
    high,
    low,
    close,
    volume: 100,
    isComplete: complete,
  };
}

function regularSession(date: string, high: number, low: number, lastClose: number): Candle[] {
  const start = timestampForTradingDate(date, "09:30", calendar);
  return Array.from({ length: 78 }, (_, index) => {
    const openTime = start + index * 5 * 60_000;
    return {
      openTime,
      closeTime: openTime + 5 * 60_000,
      open: index === 77 ? lastClose : 104,
      high: index === 0 ? high : 105,
      low: index === 0 ? low : 103,
      close: index === 77 ? lastClose : 104,
      volume: 100,
      isComplete: true,
    };
  });
}

function regularSessionFor(
  date: string,
  high: number,
  low: number,
  lastClose: number,
  sessionCalendar = calendar,
  contractSymbol?: string,
): Candle[] {
  const window = sessionWindow(date, "regular", sessionCalendar);
  assert.ok(window);
  const count = Math.round((window.closeTime - window.openTime) / (5 * 60_000));
  return Array.from({ length: count }, (_, index) => ({
    openTime: window.openTime + index * 5 * 60_000,
    closeTime: window.openTime + (index + 1) * 5 * 60_000,
    open: index === count - 1 ? lastClose : 104,
    high: index === 0 ? high : 105,
    low: index === 0 ? low : 103,
    close: index === count - 1 ? lastClose : 104,
    volume: 100,
    isComplete: true,
    ...(contractSymbol ? { contractSymbol } : {}),
  })) as Array<Candle & { contractSymbol?: string }>;
}

function fixture(options: { includeThird?: boolean; includePremarket?: boolean; outsideLast?: boolean } = {}) {
  const previous = regularSession("2026-08-24", 110, 100, 104);
  const dayBefore = regularSession("2026-08-21", 120, 90, 96);
  const premarket = options.includePremarket === false
    ? []
    : [candle("2026-08-25", "04:00", 101, 99, 100)];
  const opening = [
    candle("2026-08-25", "09:30", 105, 100, 102),
    candle("2026-08-25", "09:35", 107, 101, 104),
    ...(options.includeThird === false ? [] : [candle("2026-08-25", "09:40", 106, 99.5, 103)]),
  ];
  const after = options.includeThird === false ? [] : [
    candle("2026-08-25", "09:45", 104, 100, options.outsideLast ? 102 : 102),
    candle("2026-08-25", "09:50", 109, 106, options.outsideLast ? 108 : 108),
    candle("2026-08-25", "09:55", 109, 106.5, options.outsideLast ? 108 : 108),
    ...(!options.outsideLast ? [
      candle("2026-08-25", "10:00", 104, 100, 101),
      candle("2026-08-25", "10:05", 104, 100, 102),
    ] : []),
  ];
  const regular = [...opening, ...after];
  const all = [...dayBefore, ...previous, ...premarket, ...regular];
  const windows: SessionWindows = {
    premarket,
    regular,
    tradingDate: "2026-08-25",
    premarketAvailable: options.includePremarket !== false,
  };
  return sessionLevels(all, windows, config, calendar);
}

test("premarket and previous regular-session levels use the correct trading days", () => {
  const levels = fixture();
  assert.equal(levels.levels.find((level) => level.name === "Premarket high")?.price, 101);
  assert.equal(levels.levels.find((level) => level.name === "Premarket low")?.price, 99);
  assert.equal(levels.levels.find((level) => level.name === "Prior day high")?.price, 110);
  assert.equal(levels.levels.find((level) => level.name === "Prior day low")?.price, 100);
  assert.equal(levels.levels.find((level) => level.name === "Two days ago high")?.price, 120);
  assert.equal(levels.levels.find((level) => level.name === "Two days ago low")?.price, 90);
  assert.equal(levels.previousDayClose, 104);
});

test("reference levels use trading sessions across a weekend", () => {
  const levels = fixture();
  assert.equal(levels.levels.find((level) => level.name === "Prior day high")?.sourceTradingDate, "2026-08-24");
  assert.equal(levels.levels.find((level) => level.name === "Two days ago low")?.sourceTradingDate, "2026-08-21");
});

test("reference levels skip a full holiday", () => {
  const holidayCalendar = {
    ...calendar,
    holidays: [...calendar.holidays, "2026-08-25"],
    earlyCloses: { ...calendar.earlyCloses },
  };
  const prior = regularSessionFor("2026-08-24", 111, 99, 104, holidayCalendar);
  const twoBack = regularSessionFor("2026-08-21", 121, 89, 96, holidayCalendar);
  const levels = sessionLevels([...twoBack, ...prior], {
    premarket: [],
    regular: [],
    tradingDate: "2026-08-26",
  }, config, holidayCalendar);
  assert.equal(levels.levels.find((level) => level.name === "Prior day high")?.price, 111);
  assert.equal(levels.levels.find((level) => level.name === "Prior day high")?.sourceTradingDate, "2026-08-24");
});

test("reference levels accept verified early-close sessions", () => {
  const earlyCloseCalendar = {
    ...calendar,
    holidays: [...calendar.holidays],
    earlyCloses: { ...calendar.earlyCloses, "2026-08-28": "13:00" },
  };
  const early = regularSessionFor("2026-08-28", 113.12, 97.88, 105, earlyCloseCalendar);
  const prior = regularSessionFor("2026-08-27", 123, 87, 100, earlyCloseCalendar);
  const levels = sessionLevels([...prior, ...early], {
    premarket: [],
    regular: [],
    tradingDate: "2026-08-31",
  }, config, earlyCloseCalendar);
  assert.equal(early.length, 42);
  assert.equal(levels.levels.find((level) => level.name === "Prior day high")?.price, 113);
  assert.equal(levels.levels.find((level) => level.name === "Prior day low")?.price, 98);
});

test("reference levels preserve contract identity at rollover", () => {
  const oldContract = regularSessionFor("2026-09-09", 5100, 4900, 5000, calendar, "MESU6");
  const newContract = regularSessionFor("2026-09-10", 6100, 5900, 6000, calendar, "MESZ6");
  const levels = sessionLevels([...oldContract, ...newContract], {
    premarket: [],
    regular: [],
    tradingDate: "2026-09-11",
  }, config, calendar);
  const previous = levels.levels.find((level) => level.name === "Prior day high");
  const twoBack = levels.levels.find((level) => level.name === "Two days ago high");
  assert.equal(previous?.price, 6100);
  assert.equal(previous?.sourceContractSymbol, "MESZ6");
  assert.equal(twoBack?.price, 5100);
  assert.equal(twoBack?.sourceContractSymbol, "MESU6");
});

test("reference levels never read future current-session candles", () => {
  const prior = regularSessionFor("2026-08-24", 111, 99, 104);
  const current = regularSessionFor("2026-08-25", 9999, 1, 104);
  const cursor = timestampForTradingDate("2026-08-25", "09:35", calendar);
  const levels = sessionLevels([...prior, ...current], {
    premarket: [],
    regular: current.slice(0, 1),
    tradingDate: "2026-08-25",
    replayCursor: cursor,
    historicalFeed: [...prior, ...current],
  }, config, calendar);
  assert.equal(levels.levels.find((level) => level.name === "Prior day high")?.price, 111);
  assert.equal(levels.levels.find((level) => level.name === "Prior day high")?.sourceTradingDate, "2026-08-24");
});

test("missing premarket data does not infer or backfill premarket levels", () => {
  const levels = fixture({ includePremarket: false });
  assert.equal(levels.levels.some((level) => level.name.startsWith("Premarket")), false);
});

test("EMA and slope remain causal when future feed candles change after the replay cursor", () => {
  const prior = [...regularSession("2026-08-21", 110, 90, 100), ...regularSession("2026-08-24", 110, 90, 100)];
  const currentFull = regularSession("2026-08-25", 110, 90, 100);
  const visible = currentFull.slice(0, 8);
  const cursor = visible.at(-1)!.closeTime;
  const windows: SessionWindows = {
    premarket: [],
    regular: visible,
    tradingDate: "2026-08-25",
    replayCursor: cursor,
    historicalFeed: [...prior, ...currentFull],
  };
  const baseline = sessionLevels([...prior, ...visible], windows, config, calendar);
  const changedFuture = currentFull.map((item, index) => index >= visible.length ? { ...item, close: item.close + 10_000, open: item.open + 10_000 } : item);
  const changed = sessionLevels([...prior, ...visible], { ...windows, historicalFeed: [...prior, ...changedFuture] }, config, calendar);
  assert.equal(changed.ema, baseline.ema);
  assert.equal(changed.emaSlope, baseline.emaSlope);
});

test("NTZ remains forming before the third candle and completes exactly at 9:45 ET", () => {
  const forming = fixture({ includeThird: false });
  assert.equal(forming.ntzPhase, "forming");
  assert.equal(forming.orbComplete, false);
  assert.equal(forming.orb, null);
  assert.equal(forming.ntz?.high, 107);
  assert.equal(forming.ntzEvents[0].type, "NTZ forming");

  const complete = fixture();
  assert.equal(complete.ntzPhase, "completed");
  assert.equal(complete.orbComplete, true);
  assert.deepEqual(complete.orb, { high: 107, low: 99.5 });
  assert.equal(complete.ntzEvents[0].type, "NTZ completed");
  assert.equal(complete.ntzEvents[0].time, timestampForTradingDate("2026-08-25", "09:45", calendar));
});

test("NTZ classification and lifecycle events remain descriptive", () => {
  const levels = fixture();
  assert.equal(levels.ntzPosition, "inside");
  const eventTypes = new Set(levels.ntzEvents.map((event) => event.type));
  for (const event of [
    "NTZ completed",
    "Price inside",
    "Close outside",
    "Break and retest",
    "Break and reentry",
    "Failed breakout",
    "Consolidation inside NTZ",
  ] as const) {
    assert.equal(eventTypes.has(event), true, `missing ${event}`);
  }
  assert.equal(fixture({ outsideLast: true }).ntzPosition, "outside");
});