import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CALENDAR_MONTHS,
  clampDisplayMonth,
  historicalDateReason,
  latestEligibleDate,
  monthSelection,
  relativeEligibleDate,
  resolveOpeningMonth,
  restoreLastEligibleDate,
  yearSelection,
} from "../src/lib/historical-date-picker.ts";

const eligibleDates = ["2026-10-08", "2026-10-09", "2026-10-13"];
const pickerSource = readFileSync(new URL("../src/components/historical-date-picker.tsx", import.meta.url), "utf8");

test("Saturday remains selectable inside indexed coverage", () => {
  assert.equal(historicalDateReason("2026-10-10", eligibleDates, "2026-10-01", "2026-10-31"), null);
});

test("holiday or other unavailable date remains selectable", () => {
  assert.equal(historicalDateReason("2026-10-12", eligibleDates, "2026-10-01", "2026-10-31"), null);
});

test("availability reasons are resolved after selection", () => {
  const reasons = new Map([["2026-10-12", "Insufficient regular-session coverage."]]);
  assert.equal(historicalDateReason("2026-10-12", eligibleDates, "2026-10-01", "2026-10-31", reasons), null);
});

test("previous returns the nearest earlier eligible date", () => {
  assert.equal(relativeEligibleDate("2026-10-13", -1, eligibleDates), "2026-10-09");
});

test("next returns the nearest later eligible date", () => {
  assert.equal(relativeEligibleDate("2026-10-09", 1, eligibleDates), "2026-10-13");
});

test("previous and next return null at their boundaries", () => {
  assert.equal(relativeEligibleDate("2026-10-08", -1, eligibleDates), null);
  assert.equal(relativeEligibleDate("2026-10-13", 1, eligibleDates), null);
});

test("eligible metadata is optional for calendar selection", () => {
  assert.equal(latestEligibleDate(undefined), null);
});

test("invalid manual input restores the last valid value only when still eligible", () => {
  assert.equal(restoreLastEligibleDate("2026-10-09", eligibleDates), "2026-10-09");
  assert.equal(restoreLastEligibleDate("2026-10-12", eligibleDates), "");
});

test("after-coverage input is rejected", () => {
  assert.equal(historicalDateReason("2026-11-01", eligibleDates, "2026-10-01", "2026-10-31"), "After the indexed historical coverage.");
});

test("Latest uses the latest eligible date, not indexed end date", () => {
  assert.equal(latestEligibleDate(["2026-10-08", "2026-10-13"]), "2026-10-13");
});

test("month and year can be selected directly", () => {
  assert.match(pickerSource, /aria-label="Select month"/);
  assert.match(pickerSource, /aria-label="Select year"/);
});

test("month and year controls use a separate calendar caption", () => {
  assert.match(pickerSource, /captionLayout="label"/);
  assert.match(pickerSource, /className="mx-auto"/);
});

test("popover has a responsive maximum width around 400px", () => {
  assert.match(pickerSource, /w-\[min\(400px,calc\(100vw-1\.5rem\)\)\]/);
  assert.match(pickerSource, /max-w-\[calc\(100vw-1\.5rem\)\]/);
});

test("footer controls use a compact grid", () => {
  assert.match(pickerSource, /grid grid-cols-2 gap-1 border-t/);
  assert.match(pickerSource, /aria-label="Previous calendar date"/);
  assert.match(pickerSource, /aria-label="Latest indexed date"/);
});

test("mobile viewport containment is explicit", () => {
  assert.match(pickerSource, /calc\(100vw-1\.5rem\)/);
});

test("canonical date comparisons do not use UTC conversion", () => {
  assert.doesNotMatch(pickerSource, /toISOString|Date\.parse/);
});

test("Escape and focus restoration are implemented", () => {
  assert.match(pickerSource, /event\.key === "Escape"/);
  assert.match(pickerSource, /requestAnimationFrame\(\(\) => inputRef\.current\?\.focus\(\)\)/);
});

test("opening the picker prioritizes the valid controlled date", () => {
  const month = resolveOpeningMonth({
    value: "2026-08-26",
    lastValidValue: "2026-08-25",
    eligibleDates: ["2026-08-25", "2026-08-26"],
    minDate: "2021-09-12",
    maxDate: "2026-08-26",
    today: "2026-09-12",
  });
  assert.equal(month.getFullYear(), 2026);
  assert.equal(month.getMonth(), 7);
});

test("opening falls back to the last valid, latest eligible, then coverage end date", () => {
  const lastValid = resolveOpeningMonth({
    value: "2026-08-27",
    lastValidValue: "2026-08-25",
    eligibleDates: ["2026-08-25", "2026-08-26"],
    minDate: "2021-09-12",
    maxDate: "2026-08-26",
    today: "2026-09-12",
  });
  const latest = resolveOpeningMonth({
    value: "2026-08-27",
    eligibleDates: ["2026-08-25", "2026-08-26"],
    minDate: "2021-09-12",
    maxDate: "2026-08-26",
    today: "2026-09-12",
  });
  assert.equal(lastValid.getMonth(), 7);
  assert.equal(latest.getMonth(), 7);
});

test("opening month is clamped to indexed coverage", () => {
  assert.equal(clampDisplayMonth(new Date(2020, 0, 1), "2021-09-12", "2026-08-26").getTime(), new Date(2021, 8, 1).getTime());
  assert.equal(clampDisplayMonth(new Date(2027, 0, 1), "2021-09-12", "2026-08-26").getTime(), new Date(2026, 7, 1).getTime());
});

test("month selector has exactly one option for each calendar month", () => {
  assert.equal(CALENDAR_MONTHS.length, 12);
  assert.equal(new Set(CALENDAR_MONTHS).size, 12);
  assert.equal(CALENDAR_MONTHS[0], "January");
  assert.equal(CALENDAR_MONTHS[11], "December");
});

test("changing month preserves year when covered", () => {
  const selected = monthSelection(2025, 2, "2021-09-12", "2026-08-26");
  assert.equal(selected.getFullYear(), 2025);
  assert.equal(selected.getMonth(), 2);
});

test("changing year preserves month when covered", () => {
  const selected = yearSelection(2024, 7, "2021-09-12", "2026-08-26");
  assert.equal(selected.getFullYear(), 2024);
  assert.equal(selected.getMonth(), 7);
});

test("out-of-coverage month and year combinations clamp to the nearest covered month", () => {
  const before = monthSelection(2021, 0, "2021-09-12", "2026-08-26");
  const after = yearSelection(2026, 11, "2021-09-12", "2026-08-26");
  assert.equal(before.getTime(), new Date(2021, 8, 1).getTime());
  assert.equal(after.getTime(), new Date(2026, 7, 1).getTime());
});