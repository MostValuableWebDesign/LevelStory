import assert from "node:assert/strict";
import test from "node:test";
import { getFuturesContractSpecification } from "./contracts.js";
import {
  classifyFuturesSession,
  isTradingDate,
  listTradingDates,
  newYorkTimeToUtc,
  sessionCalendarForContract,
  sessionWindow,
  timestampForTradingDate,
} from "./session-calendar.js";
import { generateSimulatedFuturesFeed } from "./simulated-feed.js";

const calendar = sessionCalendarForContract(getFuturesContractSpecification("MES"));

test("normal ET session converts to the correct summer UTC boundaries", () => {
  const regular = sessionWindow("2026-08-25", "regular", calendar);
  const premarket = sessionWindow("2026-08-25", "premarket", calendar);
  assert.equal(regular?.openTime, Date.parse("2026-08-25T13:30:00.000Z"));
  assert.equal(regular?.closeTime, Date.parse("2026-08-25T20:00:00.000Z"));
  assert.equal(premarket?.openTime, Date.parse("2026-08-25T08:00:00.000Z"));
  assert.equal(premarket?.closeTime, Date.parse("2026-08-25T13:30:00.000Z"));
  assert.equal(classifyFuturesSession(regular!.openTime - 1, calendar), "premarket");
  assert.equal(classifyFuturesSession(regular!.openTime, calendar), "regular");
  assert.equal(classifyFuturesSession(regular!.closeTime, calendar), "closed");
});

test("weekends and configured holidays have no session windows", () => {
  assert.equal(isTradingDate("2026-08-22", calendar), false);
  assert.equal(isTradingDate("2026-09-07", calendar), false);
  assert.equal(sessionWindow("2026-08-22", "regular", calendar), null);
  assert.equal(sessionWindow("2026-09-07", "regular", calendar), null);
  assert.deepEqual(listTradingDates("2026-09-08", 2, calendar), ["2026-09-04", "2026-09-08"]);
});

test("early close ends regular session at 1:00 p.m. ET", () => {
  const regular = sessionWindow("2026-07-03", "regular", calendar);
  assert.equal(regular?.earlyClose, true);
  assert.equal(regular?.closeTime, Date.parse("2026-07-03T17:00:00.000Z"));
  assert.equal(classifyFuturesSession(timestampForTradingDate("2026-07-03", "13:00", calendar), calendar), "closed");
  const feed = generateSimulatedFuturesFeed(getFuturesContractSpecification("MES"), {
    calendar,
    startDate: "2026-07-03",
    days: 1,
    seed: 3,
    includePremarket: true,
  });
  assert.equal(feed.length, 108);
  assert.equal(feed.at(-1)?.closeTime, Date.parse("2026-07-03T17:00:00.000Z"));
});

test("daylight-saving transitions preserve 9:30 a.m. ET", () => {
  assert.equal(newYorkTimeToUtc("2026-03-09", "09:30"), Date.parse("2026-03-09T13:30:00.000Z"));
  assert.equal(newYorkTimeToUtc("2026-01-05", "09:30"), Date.parse("2026-01-05T14:30:00.000Z"));
});

test("feed skips non-trading dates and can omit unavailable premarket data", () => {
  const specification = getFuturesContractSpecification("MES");
  const feed = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-22",
    days: 1,
    seed: 11,
    includePremarket: true,
  });
  assert.equal(feed.length, 144);
  assert.equal(new Date(feed[0].openTime).toISOString(), "2026-08-21T08:00:00.000Z");
  assert.equal(feed.every((candle) => new Date(candle.openTime).getUTCDay() !== 0 && new Date(candle.openTime).getUTCDay() !== 6), true);

  const noPremarket = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: "2026-08-25",
    days: 1,
    seed: 11,
    includePremarket: true,
    premarketAvailable: false,
  });
  assert.equal(noPremarket.length, 78);
  assert.equal(noPremarket[0].openTime, Date.parse("2026-08-25T13:30:00.000Z"));
});