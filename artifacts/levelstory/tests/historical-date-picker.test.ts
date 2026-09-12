import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  historicalDateReason,
  latestEligibleDate,
  relativeEligibleDate,
  restoreLastEligibleDate,
} from "../src/lib/historical-date-picker.ts";

const eligibleDates = ["2026-10-08", "2026-10-09", "2026-10-13"];
const pickerSource = readFileSync(new URL("../src/components/historical-date-picker.tsx", import.meta.url), "utf8");

test("Saturday cannot be selected from authoritative eligible dates", () => {
  assert.equal(historicalDateReason("2026-10-10", eligibleDates, "2026-10-01", "2026-10-31"), "This date is not an eligible indexed trading date.");
});

test("holiday or other ineligible date cannot be selected", () => {
  assert.equal(historicalDateReason("2026-10-12", eligibleDates, "2026-10-01", "2026-10-31"), "This date is not an eligible indexed trading date.");
});

test("exact supplied disabled reason is returned", () => {
  const reasons = new Map([["2026-10-12", "Insufficient regular-session coverage."]]);
  assert.equal(historicalDateReason("2026-10-12", eligibleDates, "2026-10-01", "2026-10-31", reasons), "Insufficient regular-session coverage.");
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

test("navigation has no calendar-day fallback while metadata is unavailable", () => {
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
  assert.match(pickerSource, /aria-label="Previous eligible date"/);
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