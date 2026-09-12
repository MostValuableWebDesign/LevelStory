import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalToDate,
  dateToCanonical,
  formatDateForDisplay,
  parseDateText,
} from "../src/lib/historical-date.ts";

test("parses supported date entry formats without timezone shifts", () => {
  assert.equal(parseDateText("08/26/2026"), "2026-08-26");
  assert.equal(parseDateText("8/6/2021"), "2021-08-06");
  assert.equal(parseDateText("2021-09-12"), "2021-09-12");
  assert.equal(parseDateText("2021-02-29"), null);
  assert.equal(parseDateText("08/26"), null);
  assert.equal(formatDateForDisplay("2026-08-26"), "08/26/2026");
});

test("round-trips calendar dates using local date components", () => {
  const date = canonicalToDate("2021-09-12");
  assert.ok(date);
  assert.equal(dateToCanonical(date), "2021-09-12");
});