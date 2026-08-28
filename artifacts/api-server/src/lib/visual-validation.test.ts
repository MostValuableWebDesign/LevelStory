import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVisualValidationSet,
  type VisualValidationRequest,
} from "./visual-validation.js";
import {
  buildVisualValidationDiscrepancyReport,
  getVisualValidationSet,
  recordVisualValidationReview,
  storeVisualValidationSet,
} from "./visual-validation-store.js";

const request: VisualValidationRequest = {
  symbol: "MES",
  endDate: "2026-08-26",
  inSampleDays: 2,
  outOfSampleDays: 1,
  seed: 11,
  premarketAvailable: true,
};

test("visual-validation sample selection is deterministic", () => {
  const first = buildVisualValidationSet(request);
  const second = buildVisualValidationSet(request);
  assert.deepEqual(first, second);
  assert.ok(first.snapshots.length > 0);
  assert.equal(first.formulaHash, second.formulaHash);
});

test("visual-validation snapshots never expose candles beyond their review cursor", () => {
  const set = buildVisualValidationSet(request);
  for (const snapshot of set.snapshots) {
    const reviewCursor = Date.parse(snapshot.reviewCursor.closeTime);
    for (const candle of snapshot.rawCandles) {
      assert.ok(Date.parse(candle.closeTime) <= reviewCursor, `${candle.closeTime} is after ${snapshot.reviewCursor.closeTime}`);
    }
    for (const item of snapshot.annotations) {
      if (item.openTime) assert.ok(Date.parse(item.openTime) <= reviewCursor);
      if (item.closeTime) assert.ok(Date.parse(item.closeTime) <= reviewCursor);
    }
    assert.equal(snapshot.evaluationCursor.futureCandleAccess, false);
  }
});

test("visual-validation cursors carry distinct New York and UTC timestamps", () => {
  const set = buildVisualValidationSet(request);
  const cursor = set.snapshots[0]?.evaluationCursor;
  assert.ok(cursor);
  assert.notEqual(cursor.newYork, cursor.utc);
  assert.match(cursor.newYork, /2026/);
  assert.match(cursor.utc, /2026/);
});

test("human reviews remain separate from immutable machine evidence", () => {
  const stored = storeVisualValidationSet(buildVisualValidationSet(request));
  const snapshot = stored.snapshots[0];
  assert.ok(snapshot);
  const before = getVisualValidationSet(stored.reviewSetId);
  assert.ok(before);
  const review = recordVisualValidationReview(stored.reviewSetId, snapshot.snapshotId, "incorrect", "The level is not respected.");
  assert.ok(review);
  const after = getVisualValidationSet(stored.reviewSetId);
  assert.ok(after);
  const beforeSnapshot = before.snapshots.find((item) => item.snapshotId === snapshot.snapshotId);
  const afterSnapshot = after.snapshots.find((item) => item.snapshotId === snapshot.snapshotId);
  assert.ok(beforeSnapshot);
  assert.ok(afterSnapshot);
  assert.deepEqual(afterSnapshot.machineEvidence, beforeSnapshot.machineEvidence);
  assert.deepEqual(afterSnapshot.rawCandles, beforeSnapshot.rawCandles);
  assert.equal(afterSnapshot.review.status, "incorrect");
  assert.equal(beforeSnapshot.review.status, "unreviewed");
});

test("discrepancy export contains only labeled reviews", () => {
  const stored = storeVisualValidationSet(buildVisualValidationSet(request));
  const [first, second] = stored.snapshots;
  assert.ok(first);
  assert.ok(second);
  recordVisualValidationReview(stored.reviewSetId, first.snapshotId, "rule_needs_clarification", "Clarify the pullback tolerance.");
  const report = buildVisualValidationDiscrepancyReport(stored.reviewSetId);
  assert.ok(report);
  assert.equal(report.reviewedSnapshots, 1);
  assert.equal(report.discrepancies.length, 1);
  assert.equal(report.discrepancies[0]?.snapshotId, first.snapshotId);
  assert.equal(report.discrepancies[0]?.reviewerStatus, "rule_needs_clarification");
  assert.equal(report.discrepancies[0]?.note, "Clarify the pullback tolerance.");
});
