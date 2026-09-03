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
  const first = await startVisualValidationGenerationJob(request);
  const duplicate = await startVisualValidationGenerationJob(request);
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

  const cached = await startVisualValidationGenerationJob(request);
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

test("fresh regeneration bypasses only the compatible derived result and preserves the old set", async () => {
  const freshRequest = { ...request, endDate: "2026-08-25", seed: 19 };
  const first = await startVisualValidationGenerationJob(freshRequest);
  const firstCompleted = await waitForCompletion(first.jobId);
  assert.equal(firstCompleted.current.status, "completed");
  assert.equal(firstCompleted.current.origin, "fresh");

  const cached = await startVisualValidationGenerationJob(freshRequest);
  assert.equal(cached.jobId, first.jobId);
  assert.equal(cached.origin, "cached");

  const freshPromise = startVisualValidationGenerationJob({ ...freshRequest, regenerateFresh: true });
  const duplicateFreshPromise = startVisualValidationGenerationJob({ ...freshRequest, regenerateFresh: true });
  const [fresh, duplicateFresh] = await Promise.all([freshPromise, duplicateFreshPromise]);
  assert.equal(fresh.jobId, duplicateFresh.jobId);
  assert.notEqual(fresh.jobId, first.jobId);
  const regenerated = await waitForCompletion(fresh.jobId);
  assert.equal(regenerated.current.status, "completed");
  assert.equal(regenerated.current.origin, "fresh");
  assert.notEqual(regenerated.current.reviewSetId, firstCompleted.current.reviewSetId);
  assert.ok(getVisualValidationSet(firstCompleted.current.reviewSetId!));
  assert.ok(getVisualValidationSet(regenerated.current.reviewSetId!));
});