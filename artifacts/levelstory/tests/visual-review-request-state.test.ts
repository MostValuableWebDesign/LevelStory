import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptsGenerationJobResult,
  acceptsGenerationResponse,
  preserveReviewEndDate,
} from "../src/pages/visual-review-request-state.ts";

test("Visual Review ignores a late generation start response", () => {
  assert.equal(acceptsGenerationResponse({
    requestToken: 1,
    activeRequestToken: 2,
    jobId: "older-job",
    acceptedJobId: "",
  }), false);
  assert.equal(acceptsGenerationResponse({
    requestToken: 2,
    activeRequestToken: 2,
    jobId: "new-job",
    acceptedJobId: "",
  }), true);
});

test("Visual Review ignores polling from a superseded generation job", () => {
  assert.equal(acceptsGenerationJobResult("older-job", "new-job"), false);
  assert.equal(acceptsGenerationJobResult("new-job", "new-job"), true);
  assert.equal(acceptsGenerationJobResult("", "new-job"), true);
});

test("Visual Review keeps the selected date while a loaded set supplies other request settings", () => {
  const current = {
    symbol: "MES",
    endDate: "2026-08-26",
    inSampleDays: 2,
    outOfSampleDays: 1,
  };
  const incoming = {
    ...current,
    endDate: "2026-08-20",
    inSampleDays: 5,
  };
  assert.deepEqual(
    preserveReviewEndDate(current, incoming, true, "2026-08-25"),
    { ...incoming, endDate: "2026-08-26" },
  );
  assert.deepEqual(preserveReviewEndDate({ ...current, endDate: "2026-08-25" }, incoming, true, "2026-08-25"), incoming);
  assert.deepEqual(preserveReviewEndDate(current, incoming, false, "2026-08-25"), incoming);
});