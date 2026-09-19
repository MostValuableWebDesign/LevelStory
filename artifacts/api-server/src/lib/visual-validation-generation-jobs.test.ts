import assert from "node:assert/strict";
import test from "node:test";
import {
  generationElapsedMs,
  getVisualValidationGenerationJob,
  startVisualValidationGenerationJob,
  VisualValidationGenerationBusyError,
} from "./visual-validation-generation-jobs.js";
import { getVisualValidationSet } from "./visual-validation-store.js";
import { DEFAULT_FUTURES_SESSION_CALENDAR } from "./futures/session-calendar.js";

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

async function waitForHistoricalCompletion(jobId: string) {
  const updates = [];
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const current = getVisualValidationGenerationJob(jobId);
    assert.ok(current);
    updates.push(current);
    if (current.status === "completed" || current.status === "failed") return { current, updates };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Historical generation job did not finish within the test timeout.");
}

test("visual-validation generation jobs reuse active work and publish completion after storage", async () => {
  const first = await startVisualValidationGenerationJob(request);
  const duplicate = await startVisualValidationGenerationJob(request);
  assert.equal(duplicate.jobId, first.jobId);

  const { current, updates } = await waitForCompletion(first.jobId);
  assert.equal(current.status, "completed");
  assert.equal(current.phase, "completed");
  assert.equal(current.percent, 100);
  assert.equal(current.estimatedRemainingMs, 0);
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

test("historical default review generation stays current and retains end-date charts", async () => {
  const request = {
    symbol: "MES" as const,
    endDate: "2026-05-04",
    inSampleDays: 5,
    outOfSampleDays: 2,
    premarketAvailable: true,
    source: "historical_databento" as const,
    reviewMode: "confirmed_signals" as const,
    earlyOrbMomentum: {
      enabled: true,
      eligibilityCutoffMinutes: 630,
      minimumCloseDistanceTicks: 1,
    },
    enabledStrategies: {
      ORB_PULLBACK_CONTINUATION: true,
      EARLY_ORB_MOMENTUM_CONTINUATION: true,
      CONSOLIDATION_BREAKOUT_CONTINUATION: true,
      PATIENCE_CANDLE_CONTINUATION: true,
      EQUIVALENT_CANDLE_REVERSAL: true,
      PEAK_RETRACEMENT_REVERSAL: true,
    },
  };
  const started = await startVisualValidationGenerationJob(request);
  const { current } = await waitForHistoricalCompletion(started.jobId);

  assert.equal(current.status, "completed", current.error ?? undefined);
  assert.equal(current.error, null);
  assert.ok(current.result);
  assert.equal(current.result?.stale, false);
  assert.equal(current.result?.freshness?.status, "current");
  assert.equal(current.result?.sessionCalendarVersion, DEFAULT_FUTURES_SESSION_CALENDAR.calendarVersion);
  assert.equal(current.result?.request.endDate, request.endDate);
  assert.equal(
    current.result?.snapshots.some((snapshot) => snapshot.tradingDate === request.endDate),
    true,
  );
});

test("elapsed time is zero before start and freezes at completion", () => {
  assert.equal(generationElapsedMs(null, null, 50_000), 0);
  assert.equal(generationElapsedMs(10_000, null, 13_250), 3_250);
  assert.equal(generationElapsedMs(10_000, 12_000, 50_000), 2_000);
  assert.equal(generationElapsedMs(12_000, 10_000, 50_000), 0);
});

test("different historical replay requests are rejected instead of queued behind active work", async () => {
  const firstPromise = startVisualValidationGenerationJob({ ...request, endDate: "2026-08-27" });
  await assert.rejects(
    () => startVisualValidationGenerationJob({ ...request, endDate: "2026-08-28" }),
    (error: unknown) => error instanceof VisualValidationGenerationBusyError
      && error.activeJobId === "starting",
  );
  const first = await firstPromise;
  await waitForCompletion(first.jobId);
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