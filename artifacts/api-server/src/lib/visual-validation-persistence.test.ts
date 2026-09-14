import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  visualValidationReviewsTable,
} from "@workspace/db";
import type { VisualValidationReview, VisualValidationSet, VisualValidationSnapshot } from "./visual-validation.js";
import {
  GovernanceError,
  persistVisualValidationReview,
} from "./governance-store.js";

function snapshot(reviewSetId: string, snapshotId: string): VisualValidationSnapshot {
  return {
    snapshotId,
    sampleIndex: 0,
    category: "qualified_trade",
    categoryLabel: "Qualified trade",
    machineLabel: "qualified",
    strategyKey: "ORB_PULLBACK_CONTINUATION",
    formulaHash: "a".repeat(64),
    formulaVersion: "test-formula",
    symbol: "MES",
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    tradingDate: "2026-08-26",
    entryWindow: "primary",
    selectionReason: "test",
    period: "in_sample",
    evaluationCursor: {
      openTime: "2026-08-26T13:30:00.000Z",
      closeTime: "2026-08-26T13:35:00.000Z",
      newYork: "09:30",
      utc: "13:30",
      visibleCandleCount: 1,
      futureCandleAccess: false,
    },
    reviewCursor: {
      closeTime: "2026-08-26T14:00:00.000Z",
      newYork: "10:00",
      utc: "14:00",
    },
    machineCandles: [],
    reviewCandles: [],
    premarketCandles: [],
    indicatorSeries: [],
    tradeEvents: [],
    coverage: [],
    outcomeContextEnd: "2026-08-26T14:00:00.000Z",
    futureCandleAccess: false,
    categoryAnchor: null,
    annotations: [],
    machineEvidence: {
      quotesAvailable: false,
      sourceSchema: "historical_ohlcv",
      audit: { decision: "NO_TRADE", rejectionCategory: "test" },
      trade: null,
      market: {},
    },
    review: { status: "unreviewed", note: null, reviewedAt: null, revision: 0 },
  } as unknown as VisualValidationSnapshot;
}

function review(reviewSetId: string, snapshotId: string, reviewId: string, revision: number, status: "correct" | "incorrect"): VisualValidationReview {
  return {
    reviewId,
    reviewSetId,
    snapshotId,
    status,
    note: status === "correct" ? "The causal story holds." : "The level interaction is not supported.",
    reviewedAt: new Date().toISOString(),
    supersedesReviewId: revision > 1 ? "previous-review" : null,
    revision,
  };
}

test("durable visual reviews are idempotent and reject stale concurrent edits", async () => {
  const actor = { id: `visual-review-test-${randomUUID()}` };
  const reviewSetId = randomUUID();
  const snapshotId = `snapshot-${randomUUID()}`;
  const evidence = snapshot(reviewSetId, snapshotId);
  const persistedSet = {
    reviewSetId,
    buildId: "test-build",
    snapshots: [evidence],
  } as unknown as VisualValidationSet;
  const first = review(reviewSetId, snapshotId, randomUUID(), 1, "correct");
  const base = {
    actor,
    reviewSetId,
    snapshot: evidence,
    set: persistedSet,
    buildId: "test-build",
    requestFingerprint: "request-one",
    expectedRevision: 0,
  };

  try {
    const saved = await persistVisualValidationReview({
      ...base,
      review: first,
      idempotencyKey: "review-retry-one",
    });
    const replay = await persistVisualValidationReview({
      ...base,
      review: { ...first, reviewedAt: new Date(Date.now() + 1000).toISOString() },
      idempotencyKey: "review-retry-one",
    });
    assert.equal(replay.reviewId, saved.reviewId);
    assert.equal(replay.revision, 1);

    const second = review(reviewSetId, snapshotId, randomUUID(), 2, "incorrect");
    const third = review(reviewSetId, snapshotId, randomUUID(), 2, "correct");
    const results = await Promise.allSettled([
      persistVisualValidationReview({
        ...base,
        review: second,
        idempotencyKey: "review-concurrent-two",
        requestFingerprint: "request-two",
        expectedRevision: 1,
      }),
      persistVisualValidationReview({
        ...base,
        review: third,
        idempotencyKey: "review-concurrent-three",
        requestFingerprint: "request-three",
        expectedRevision: 1,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof GovernanceError);
    assert.equal(rejected.reason.status, 409);

    const rows = await db.select().from(visualValidationReviewsTable).where(and(
      eq(visualValidationReviewsTable.reviewerId, actor.id),
      eq(visualValidationReviewsTable.reviewSetId, reviewSetId),
      eq(visualValidationReviewsTable.snapshotId, snapshotId),
    ));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.revision).sort(), [1, 2]);
  } finally {
    await db.delete(visualValidationReviewsTable).where(eq(visualValidationReviewsTable.reviewerId, actor.id));
  }
});