import assert from "node:assert/strict";
import test from "node:test";
import {
  getVisualValidationGenerationJob,
  monotonicRemainingEstimate,
  startVisualValidationGenerationJob,
} from "./visual-validation-generation-jobs.js";
import { getVisualValidationSet } from "./visual-validation-store.js";

const request = {
  symbol: "MES" as const,
  endDate: "2026-08-26",
  inSampleDays: 2,
  outOfSampleDays: 1,
  seed: 11,
  premarketAvailable: true,
  source: "simulated" as const,
  reviewMode: "trades_only" as const,
};

async function waitForCompletion(jobId: string) {
  const updates = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = getVisualValidationGenerationJob(jobId);
    assert.ok(current);
    updates.push(current);
    if (current.status === "completed" || current.status === "failed") return { current, updates };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Generation job did not finish within the test timeout.");
}

test("visual-validation generation jobs reuse active work and publish completion after storage", async () => {
  const first = startVisualValidationGenerationJob(request);
  const duplicate = startVisualValidationGenerationJob(request);
  assert.equal(duplicate.jobId, first.jobId);

  const { current, updates } = await waitForCompletion(first.jobId);
  assert.equal(current.status, "completed");
  assert.equal(current.phase, "completed");
  assert.equal(current.percent, 100);
  assert.equal(current.completedUnits, current.totalUnits);
  assert.ok(current.reviewSetId);
  assert.ok(current.result);
  assert.equal(current.result?.reviewSetId, current.reviewSetId);
  assert.deepEqual(getVisualValidationSet(current.reviewSetId!), current.result);

  for (let index = 1; index < updates.length; index += 1) {
    assert.ok(updates[index]!.completedUnits >= updates[index - 1]!.completedUnits);
    assert.ok(updates[index]!.percent >= updates[index - 1]!.percent);
    assert.ok(updates[index]!.completedSessions >= updates[index - 1]!.completedSessions);
  }

  const cached = startVisualValidationGenerationJob(request);
  assert.equal(cached.jobId, first.jobId);
  assert.equal(cached.status, "completed");
  assert.equal(cached.percent, 100);
});

test("remaining-time estimates never increase while progress is unchanged", () => {
  const first = monotonicRemainingEstimate(10_000, 20, 100, null);
  assert.ok(first);
  const later = monotonicRemainingEstimate(30_000, 20, 100, first);
  assert.equal(later, first);
  const progressed = monotonicRemainingEstimate(30_000, 60, 100, later);
  assert.ok(progressed !== null && progressed <= first);
});