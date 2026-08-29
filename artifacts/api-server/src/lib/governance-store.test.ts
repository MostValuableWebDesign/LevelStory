import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  advisoryRuleProposalsTable,
  db,
  proposalValidationRunsTable,
  ruleProposalAuditEventsTable,
  strategyVersionsTable,
  teachingExamplesTable,
} from "@workspace/db";
import {
  approveProposal,
  activateCandidate,
  createProposal,
  getProposalDetail,
  GovernanceError,
  publishCandidate,
  requestValidation,
  rollbackProposal,
  supersedeTeachingEvidence,
} from "./governance-store.js";

test("governance proposals are idempotent, validation-gated, audited, and Shadow-only", async () => {
  const actor = { id: `test-reviewer-${randomUUID()}` };
  const teachingId = randomUUID();
  const proposalKey = `proposal-${randomUUID()}`;
  const teaching = await db.insert(teachingExamplesTable).values({
    id: teachingId,
    reviewSetId: randomUUID(),
    snapshotId: randomUUID(),
    reviewerId: actor.id,
    status: "submitted",
    judgment: "missed_trade",
    symbol: "MES",
    contract: "MESU6",
    tradingDate: "2026-08-26",
    selectedCandleTimestamp: "2026-08-26T14:00:00.000Z",
    patienceCandleTimestamp: "2026-08-26T13:55:00.000Z",
    direction: "long",
    entryBufferTicks: 2,
    calculatedEntryPrice: "6500.5",
    setupClassification: "trend_pullback",
    qualifyingLevelType: "VWAP",
    confidence: "high",
    reviewerExplanation: "The immediate next candle should qualify.",
    machineDecision: "no_trade",
    machineRejectionReasons: [],
    calendarVersion: "America/New_York:contract-local",
    evidenceSnapshot: { futureCandleAccess: false },
    causalValidation: { valid: true, messages: [] },
    formulaVersion: "test-formula",
    formulaHash: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    calendarFingerprint: "c".repeat(64),
    revision: 1,
    idempotencyKey: `teaching-${randomUUID()}`,
    outcomeSnapshot: null,
  }).returning();
  const superseded = await supersedeTeachingEvidence({
    id: teachingId,
    actor,
    judgment: "false_positive_trade",
    explanation: "The original judgment was revised after a second causal review.",
    idempotencyKey: `supersede-${randomUUID()}`,
  });
  const teachingHistory = await db.select().from(teachingExamplesTable).where(eq(teachingExamplesTable.snapshotId, teaching[0]!.snapshotId));
  assert.equal(teachingHistory.length, 2);
  assert.equal(teachingHistory.find((item) => item.id === teachingId)?.status, "superseded");
  assert.equal(superseded.supersedesTeachingId, teachingId);
  const created = await createProposal({
    actor,
    title: "Test governed proposal",
    hypothesis: "A bounded confirmation rule deserves an advisory review.",
    rationale: "This test verifies that evidence remains separate from executable behavior.",
    sourceTeachingIds: [superseded.id],
    proposalPayload: { mode: "shadow_only", execution: "none" },
    idempotencyKey: proposalKey,
  });
  const duplicate = await createProposal({
    actor,
    title: "Different replay of same request",
    hypothesis: "The original idempotency key must win.",
    rationale: "The persisted draft is the canonical result.",
    sourceTeachingIds: [teachingId],
    proposalPayload: { mode: "shadow_only" },
    idempotencyKey: proposalKey,
  });
  assert.equal(duplicate.id, created.id);
  await assert.rejects(
    () => approveProposal(created.id, { id: "approver-before-validation" }, "Too early", `approve-${randomUUID()}`),
    (error: unknown) => error instanceof GovernanceError && error.status === 409,
  );

  const queued = await requestValidation({ id: created.id, actor, idempotencyKey: `validate-${randomUUID()}` });
  const cached = await requestValidation({ id: created.id, actor, idempotencyKey: `validate-retry-${randomUUID()}` });
  assert.equal(cached.id, queued.id);
  let detail = await getProposalDetail(created.id);
  for (let attempt = 0; attempt < 40 && detail.proposal.status !== "validation_passed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    detail = await getProposalDetail(created.id);
  }
  assert.equal(detail.proposal.status, "validation_passed");
  assert.equal(detail.validationRuns[0]?.status, "passed");
  assert.deepEqual(detail.validationRuns[0]?.regressions, []);
  const approved = await approveProposal(created.id, { id: "approver-after-validation" }, "Required validation passed.", `approve-${randomUUID()}`);
  assert.equal(approved.status, "approved");
  const publication = await publishCandidate(created.id, { id: "approver-after-validation" }, `publish-${randomUUID()}`);
  assert.equal(publication.proposal.status, "candidate");
  assert.equal(publication.version.status, "candidate");
  assert.equal((publication.version.configSnapshot as { mode: string }).mode, "shadow_only");
  const active = await activateCandidate(created.id, { id: "activator" }, `activate-${randomUUID()}`);
  assert.equal(active.proposal.status, "active");
  assert.equal(active.version.status, "active");
  const rolledBack = await rollbackProposal(created.id, { id: "activator" }, "Keep the candidate out of executable paths.", `rollback-${randomUUID()}`);
  assert.equal(rolledBack.status, "rolled_back");
  const history = await getProposalDetail(created.id);
  assert.ok(history.auditEvents.length >= 6);
  assert.ok(history.auditEvents.some((event) => event.action === "validation_passed"));

  await db.delete(ruleProposalAuditEventsTable).where(eq(ruleProposalAuditEventsTable.proposalId, created.id));
  await db.delete(proposalValidationRunsTable).where(eq(proposalValidationRunsTable.proposalId, created.id));
  await db.delete(strategyVersionsTable).where(eq(strategyVersionsTable.proposalId, created.id));
  await db.delete(advisoryRuleProposalsTable).where(eq(advisoryRuleProposalsTable.id, created.id));
  await db.delete(teachingExamplesTable).where(and(eq(teachingExamplesTable.snapshotId, teaching[0]!.snapshotId), eq(teachingExamplesTable.reviewerId, actor.id)));
});