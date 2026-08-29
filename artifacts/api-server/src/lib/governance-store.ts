import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  advisoryRuleProposalsTable,
  db,
  proposalValidationRunsTable,
  ruleProposalAuditEventsTable,
  strategyVersionsTable,
  teachingExamplesTable,
  type AdvisoryRuleProposal,
  type ProposalValidationRun,
  type RuleProposalAuditEvent,
  type StrategyVersion,
  type TeachingExample,
} from "@workspace/db";
import type {
  VisualValidationReview,
  VisualValidationSnapshot,
  VisualValidationTeachingExample,
} from "./visual-validation.js";
import { canonicalStrategyId, isStrategyId } from "./strategy/taxonomy.js";

export const PROPOSAL_STATUSES = [
  "draft",
  "clarification_requested",
  "validation_pending",
  "validation_running",
  "validation_passed",
  "validation_failed",
  "approved",
  "rejected",
  "candidate",
  "active",
  "retired",
  "rolled_back",
] as const;
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];
export type GovernanceActor = { id: string; role?: "reviewer" | "approver" | "activator" | "admin" };

export class GovernanceError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceFingerprint(snapshot: VisualValidationSnapshot): string {
  return hashJson({
    symbol: snapshot.symbol,
    contractSymbol: snapshot.contractSymbol,
    tradingDate: snapshot.tradingDate,
    machineCandles: snapshot.machineCandles,
  });
}

function calendarFingerprint(snapshot: VisualValidationSnapshot): string {
  return hashJson({
    contractSymbol: snapshot.contractSymbol,
    tradingDate: snapshot.tradingDate,
    evaluationCursor: snapshot.evaluationCursor,
    reviewCursor: snapshot.reviewCursor,
  });
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim().slice(0, 4000) : fallback;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 100)
    : [];
}

export async function persistTeachingEvidence(args: {
  actor: GovernanceActor;
  reviewSetId: string;
  snapshot: VisualValidationSnapshot;
  review: VisualValidationReview;
  idempotencyKey: string;
}): Promise<TeachingExample | null> {
  const teaching = args.review.teaching;
  if (!teaching) return null;
  const [existing] = await db.select().from(teachingExamplesTable).where(and(
    eq(teachingExamplesTable.reviewerId, args.actor.id),
    eq(teachingExamplesTable.idempotencyKey, args.idempotencyKey),
  ));
  if (existing) return existing;
  const [previous] = await db.select({ id: teachingExamplesTable.id, revision: teachingExamplesTable.revision })
    .from(teachingExamplesTable)
    .where(and(
      eq(teachingExamplesTable.reviewerId, args.actor.id),
      eq(teachingExamplesTable.reviewSetId, args.reviewSetId),
      eq(teachingExamplesTable.snapshotId, args.snapshot.snapshotId),
    ))
    .orderBy(desc(teachingExamplesTable.revision))
    .limit(1);
  const [created] = await db.insert(teachingExamplesTable).values({
    id: teaching.teachingId,
    reviewSetId: args.reviewSetId,
    snapshotId: args.snapshot.snapshotId,
    reviewId: args.review.reviewId,
    reviewerId: args.actor.id,
    status: "submitted",
    judgment: teaching.judgment,
    symbol: args.snapshot.symbol,
    contract: args.snapshot.contractSymbol,
    tradingDate: args.snapshot.tradingDate,
    selectedCandleTimestamp: teaching.entryCandleOpenTime,
    patienceCandleTimestamp: teaching.patienceCandleOpenTime || null,
    direction: teaching.direction,
    entryBufferTicks: teaching.entryBufferTicks,
    calculatedEntryPrice: Number.isFinite(teaching.calculatedEntryPrice) ? String(teaching.calculatedEntryPrice) : null,
    setupClassification: teaching.setupType,
    qualifyingPullbackLevels: teaching.pullbackLevels,
    qualifyingLevelType: teaching.pullbackLevels.map((level) => args.snapshot.annotations.find((annotation) =>
      annotation.available && annotation.price !== null && Math.abs(annotation.price - level) < 0.26
    )?.label).filter((label): label is string => Boolean(label)).join(", ") || null,
    confidence: teaching.confidence,
    reviewerExplanation: teaching.explanation,
    machineDecision: args.snapshot.machineEvidence.audit.decision,
    machineRejectionReasons: args.snapshot.machineEvidence.audit.rejectionCategory
      ? [args.snapshot.machineEvidence.audit.rejectionCategory]
      : [],
    calendarVersion: "America/New_York:contract-local",
    evidenceSnapshot: teaching.machineEvidenceSnapshot,
    causalValidation: teaching.validation,
    formulaVersion: teaching.formulaVersion,
    formulaHash: teaching.formulaHash,
    sourceFingerprint: teaching.sourceFingerprint,
    calendarFingerprint: calendarFingerprint(args.snapshot),
    supersedesTeachingId: previous?.id ?? null,
    revision: (previous?.revision ?? 0) + 1,
    idempotencyKey: args.idempotencyKey,
    outcomeSnapshot: args.snapshot.machineEvidence.trade,
  }).returning();
  return created;
}

export async function listTeachingExamples(): Promise<TeachingExample[]> {
  return db.select().from(teachingExamplesTable).orderBy(desc(teachingExamplesTable.createdAt));
}

export async function supersedeTeachingEvidence(args: {
  id: string;
  actor: GovernanceActor;
  judgment: string;
  explanation: string;
  idempotencyKey: string;
}): Promise<TeachingExample> {
  const [existing] = await db.select().from(teachingExamplesTable).where(and(
    eq(teachingExamplesTable.id, args.id),
    eq(teachingExamplesTable.reviewerId, args.actor.id),
  ));
  if (!existing) throw new GovernanceError(404, "Teaching example not found for this reviewer.");
  const [retry] = await db.select().from(teachingExamplesTable).where(and(
    eq(teachingExamplesTable.reviewerId, args.actor.id),
    eq(teachingExamplesTable.idempotencyKey, args.idempotencyKey),
  ));
  if (retry) return retry;
  if (existing.status !== "submitted") throw new GovernanceError(409, "Only the current submitted teaching example can be superseded.");
  if (!args.explanation.trim()) throw new GovernanceError(400, "A replacement teaching explanation is required.");
  const [created] = await db.insert(teachingExamplesTable).values({
    id: randomUUID(),
    reviewSetId: existing.reviewSetId,
    snapshotId: existing.snapshotId,
    reviewId: existing.reviewId,
    reviewerId: existing.reviewerId,
    status: "submitted",
    judgment: args.judgment,
    symbol: existing.symbol,
    contract: existing.contract,
    tradingDate: existing.tradingDate,
    selectedCandleTimestamp: existing.selectedCandleTimestamp,
    patienceCandleTimestamp: existing.patienceCandleTimestamp,
    direction: existing.direction,
    entryBufferTicks: existing.entryBufferTicks,
    calculatedEntryPrice: existing.calculatedEntryPrice,
    setupClassification: existing.setupClassification,
    qualifyingLevelType: existing.qualifyingLevelType,
    qualifyingPullbackLevels: existing.qualifyingPullbackLevels,
    confidence: existing.confidence,
    reviewerExplanation: args.explanation.trim().slice(0, 4000),
    machineDecision: existing.machineDecision,
    machineRejectionReasons: existing.machineRejectionReasons,
    calendarVersion: existing.calendarVersion,
    evidenceSnapshot: existing.evidenceSnapshot,
    causalValidation: existing.causalValidation,
    formulaVersion: existing.formulaVersion,
    formulaHash: existing.formulaHash,
    sourceFingerprint: existing.sourceFingerprint,
    calendarFingerprint: existing.calendarFingerprint,
    supersedesTeachingId: existing.id,
    revision: existing.revision + 1,
    idempotencyKey: args.idempotencyKey,
    outcomeSnapshot: existing.outcomeSnapshot,
  }).returning();
  await db.update(teachingExamplesTable).set({ status: "superseded" }).where(eq(teachingExamplesTable.id, existing.id));
  return created;
}

export async function getTeachingHistory(reviewSetId: string, snapshotId: string): Promise<TeachingExample[]> {
  return db.select().from(teachingExamplesTable).where(and(
    eq(teachingExamplesTable.reviewSetId, reviewSetId),
    eq(teachingExamplesTable.snapshotId, snapshotId),
  )).orderBy(desc(teachingExamplesTable.revision));
}

async function getProposal(id: string): Promise<AdvisoryRuleProposal> {
  const [proposal] = await db.select().from(advisoryRuleProposalsTable).where(eq(advisoryRuleProposalsTable.id, id));
  if (!proposal) throw new GovernanceError(404, "Strategy proposal not found.");
  return proposal;
}

async function audit(
  proposalId: string,
  actorId: string,
  action: string,
  fromStatus: string | null,
  toStatus: string | null,
  reason: string | null,
  idempotencyKey: string | null,
  metadata: unknown = null,
): Promise<RuleProposalAuditEvent> {
  const [event] = await db.insert(ruleProposalAuditEventsTable).values({
    id: randomUUID(),
    proposalId,
    actorId,
    action,
    fromStatus,
    toStatus,
    reason,
    idempotencyKey,
    metadata: metadata as Record<string, unknown> | null,
  }).returning();
  return event;
}

export async function listProposals(): Promise<AdvisoryRuleProposal[]> {
  return db.select().from(advisoryRuleProposalsTable).orderBy(desc(advisoryRuleProposalsTable.updatedAt));
}

export async function getProposalDetail(id: string): Promise<{
  proposal: AdvisoryRuleProposal;
  auditEvents: RuleProposalAuditEvent[];
  validationRuns: ProposalValidationRun[];
  strategyVersion: StrategyVersion | null;
}> {
  const proposal = await getProposal(id);
  const auditEvents = await db.select().from(ruleProposalAuditEventsTable)
    .where(eq(ruleProposalAuditEventsTable.proposalId, id)).orderBy(desc(ruleProposalAuditEventsTable.createdAt));
  const validationRuns = await db.select().from(proposalValidationRunsTable)
    .where(eq(proposalValidationRunsTable.proposalId, id)).orderBy(desc(proposalValidationRunsTable.createdAt));
  const [strategyVersion] = proposal.candidateVersionId
    ? await db.select().from(strategyVersionsTable).where(eq(strategyVersionsTable.id, proposal.candidateVersionId))
    : [];
  return { proposal, auditEvents, validationRuns, strategyVersion: strategyVersion ?? null };
}

export async function createProposal(args: {
  actor: GovernanceActor;
  title: string;
  hypothesis: string;
  rationale: string;
  sourceTeachingIds: string[];
  proposalPayload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<AdvisoryRuleProposal> {
  const [existing] = await db.select().from(advisoryRuleProposalsTable).where(and(
    eq(advisoryRuleProposalsTable.createdBy, args.actor.id),
    eq(advisoryRuleProposalsTable.idempotencyKey, args.idempotencyKey),
  ));
  if (existing) return existing;
  const teachings = await db.select().from(teachingExamplesTable).where(inArray(teachingExamplesTable.id, args.sourceTeachingIds));
  if (teachings.length !== args.sourceTeachingIds.length) {
    throw new GovernanceError(400, "Every source teaching example must be persisted before creating a proposal.");
  }
  const requestedStrategy = typeof args.proposalPayload.strategyKey === "string"
    ? canonicalStrategyId(args.proposalPayload.strategyKey)
    : null;
  const sourceStrategies = [...new Set(teachings.map((item) => canonicalStrategyId(item.setupClassification)).filter((item): item is NonNullable<typeof item> => item !== null))];
  const strategyKey = requestedStrategy ?? (sourceStrategies.length === 1 ? sourceStrategies[0] : null);
  if (!strategyKey || !isStrategyId(strategyKey)) {
    throw new GovernanceError(400, "A proposal must link to exactly one canonical strategy.");
  }
  const [created] = await db.insert(advisoryRuleProposalsTable).values({
    id: randomUUID(),
    strategyKey,
    title: args.title.trim().slice(0, 200),
    hypothesis: args.hypothesis.trim().slice(0, 2000),
    rationale: args.rationale.trim().slice(0, 4000),
    status: "draft",
    createdBy: args.actor.id,
    proposalType: "formula_rule_change",
    plainLanguageSummary: args.hypothesis.trim().slice(0, 2000),
    currentRule: textValue(args.proposalPayload.currentRule, "Current deterministic formula"),
    proposedRule: textValue(args.proposalPayload.proposedRule, args.hypothesis),
    deterministicRuleDiff: args.proposalPayload.ruleDiff ?? args.proposalPayload,
    affectedRuleIds: textArray(args.proposalPayload.affectedRuleIds),
    expectedBehaviorChange: textValue(args.proposalPayload.expectedBehaviorChange, args.hypothesis),
    risks: args.proposalPayload.risks ?? ["Overfitting risk must be evaluated on holdout data."],
    sourceTeachingIds: args.sourceTeachingIds,
    supportingExampleIds: teachings
      .filter((item) => (item.causalValidation as { valid?: boolean }).valid !== false)
      .map((item) => item.id),
    conflictingExampleIds: teachings
      .filter((item) => (item.causalValidation as { valid?: boolean }).valid === false)
      .map((item) => item.id),
    sourceFormulaVersion: teachings[0]?.formulaVersion ?? "unknown",
    candidateFormulaVersion: null,
    proposalPayload: args.proposalPayload,
    idempotencyKey: args.idempotencyKey,
  }).returning();
  await audit(created.id, args.actor.id, "created", null, "draft", null, args.idempotencyKey);
  return created;
}

async function transition(args: {
  id: string;
  actor: GovernanceActor;
  action: string;
  toStatus: ProposalStatus;
  fromStatuses: ProposalStatus[];
  reason?: string | null;
  idempotencyKey: string;
  patch?: Partial<typeof advisoryRuleProposalsTable.$inferInsert>;
}): Promise<AdvisoryRuleProposal> {
  const existingEvent = await db.select().from(ruleProposalAuditEventsTable).where(and(
    eq(ruleProposalAuditEventsTable.proposalId, args.id),
    eq(ruleProposalAuditEventsTable.actorId, args.actor.id),
    eq(ruleProposalAuditEventsTable.action, args.action),
    eq(ruleProposalAuditEventsTable.idempotencyKey, args.idempotencyKey),
  ));
  if (existingEvent.length) return getProposal(args.id);
  const proposal = await getProposal(args.id);
  if (!args.fromStatuses.includes(proposal.status as ProposalStatus)) {
    throw new GovernanceError(409, `Cannot ${args.action} a proposal in ${proposal.status} state.`);
  }
  const [updated] = await db.update(advisoryRuleProposalsTable).set({
    ...(args.patch ?? {}),
    status: args.toStatus,
    updatedAt: new Date(),
  }).where(and(
    eq(advisoryRuleProposalsTable.id, args.id),
    eq(advisoryRuleProposalsTable.status, proposal.status),
  )).returning();
  if (!updated) throw new GovernanceError(409, "Proposal changed before this transition completed.");
  await audit(args.id, args.actor.id, args.action, proposal.status, args.toStatus, args.reason ?? null, args.idempotencyKey);
  return updated;
}

export async function requestClarification(id: string, actor: GovernanceActor, clarificationRequest: string, idempotencyKey: string) {
  return transition({
    id, actor, action: "requested_clarification", toStatus: "clarification_requested",
    fromStatuses: ["draft", "validation_failed"], reason: clarificationRequest, idempotencyKey,
    patch: { clarificationRequest: clarificationRequest.trim().slice(0, 4000) },
  });
}

async function runValidation(runId: string, proposalId: string): Promise<void> {
  const [run] = await db.select().from(proposalValidationRunsTable).where(eq(proposalValidationRunsTable.id, runId));
  if (!run) return;
  await db.update(proposalValidationRunsTable).set({ status: "running", startedAt: new Date() }).where(eq(proposalValidationRunsTable.id, runId));
  const proposal = await getProposal(proposalId);
  const teachingExamples = await db.select().from(teachingExamplesTable).where(inArray(teachingExamplesTable.id, proposal.sourceTeachingIds));
  const formulaFingerprint = hashJson(teachingExamples.map((item) => [item.formulaVersion, item.formulaHash]));
  const sourceFingerprint = hashJson(teachingExamples.map((item) => item.sourceFingerprint));
  const conflicts = teachingExamples.filter((item) => item.judgment === "missed_trade" && (item.causalValidation as { valid?: boolean }).valid === false)
    .map((item) => `Teaching ${item.id} has invalid causal evidence.`);
  const warnings = teachingExamples.length < 2 ? ["Validation is based on a single teaching example; collect independent evidence."] : [];
  const regressions: string[] = [];
  const beforeMetrics = { sampleCount: teachingExamples.length, qualifiedTrades: 0, expectancy: 0 };
  const afterMetrics = { sampleCount: teachingExamples.length, qualifiedTrades: 0, expectancy: 0 };
  const passed = conflicts.length === 0 && regressions.length === 0;
  await db.update(proposalValidationRunsTable).set({
    status: passed ? "passed" : "failed",
    beforeMetrics,
    afterMetrics,
    regressions,
    conflicts,
    warnings,
    formulaFingerprint,
    sourceFingerprint,
    completedAt: new Date(),
    errorMessage: passed ? null : "Validation found conflicting or invalid evidence.",
  }).where(eq(proposalValidationRunsTable.id, runId));
  await db.update(advisoryRuleProposalsTable).set({
    status: passed ? "validation_passed" : "validation_failed",
    updatedAt: new Date(),
  }).where(eq(advisoryRuleProposalsTable.id, proposalId));
  await audit(proposalId, run.requestedBy, passed ? "validation_passed" : "validation_failed", "validation_running", passed ? "validation_passed" : "validation_failed", null, `validation:${runId}`, { runId });
}

export async function requestValidation(args: {
  id: string;
  actor: GovernanceActor;
  idempotencyKey: string;
  requestFingerprint?: string;
}): Promise<ProposalValidationRun> {
  const proposal = await getProposal(args.id);
  const fingerprint = args.requestFingerprint ?? hashJson({ proposalId: args.id, payload: proposal.proposalPayload, sourceTeachingIds: proposal.sourceTeachingIds });
  const [cached] = await db.select().from(proposalValidationRunsTable).where(and(
    eq(proposalValidationRunsTable.proposalId, args.id),
    eq(proposalValidationRunsTable.requestFingerprint, fingerprint),
  ));
  if (cached) return cached;
  if (!["draft", "validation_failed", "clarification_requested"].includes(proposal.status)) {
    throw new GovernanceError(409, `Cannot validate a proposal in ${proposal.status} state.`);
  }
  const [run] = await db.insert(proposalValidationRunsTable).values({
    id: randomUUID(),
    proposalId: args.id,
    requestFingerprint: fingerprint,
    status: "queued",
    formulaFingerprint: "pending",
    sourceFingerprint: "pending",
    requestedBy: args.actor.id,
  }).returning();
  await db.update(advisoryRuleProposalsTable).set({ status: "validation_pending", validationRunId: run.id, updatedAt: new Date() })
    .where(and(eq(advisoryRuleProposalsTable.id, args.id), eq(advisoryRuleProposalsTable.status, proposal.status)));
  await audit(args.id, args.actor.id, "validation_requested", proposal.status, "validation_pending", null, args.idempotencyKey, { runId: run.id });
  setTimeout(() => void runValidation(run.id, args.id), 0);
  return run;
}

export async function approveProposal(id: string, actor: GovernanceActor, reason: string, idempotencyKey: string) {
  return transition({
    id,
    actor,
    action: "approved",
    toStatus: "approved",
    fromStatuses: ["validation_passed"],
    reason,
    idempotencyKey,
    patch: { approvedBy: actor.id, approvedAt: new Date() },
  });
}

export async function rejectProposal(id: string, actor: GovernanceActor, reason: string, idempotencyKey: string) {
  return transition({ id, actor, action: "rejected", toStatus: "rejected", fromStatuses: ["draft", "clarification_requested", "validation_failed", "validation_passed"], reason, idempotencyKey, patch: { rejectionReason: reason.trim().slice(0, 4000) } });
}

export async function publishCandidate(id: string, actor: GovernanceActor, idempotencyKey: string): Promise<{ proposal: AdvisoryRuleProposal; version: StrategyVersion }> {
  const proposal = await transition({ id, actor, action: "published_candidate", toStatus: "candidate", fromStatuses: ["approved"], idempotencyKey });
  if (!proposal.strategyKey || !isStrategyId(proposal.strategyKey)) {
    throw new GovernanceError(409, "Only proposals linked to one canonical strategy can publish a candidate.");
  }
  const [existingVersion] = await db.select().from(strategyVersionsTable).where(eq(strategyVersionsTable.proposalId, id));
  if (existingVersion) return { proposal, version: existingVersion };
  const [current] = await db.select({ id: strategyVersionsTable.id, versionNumber: strategyVersionsTable.versionNumber }).from(strategyVersionsTable)
    .where(eq(strategyVersionsTable.strategyKey, proposal.strategyKey)).orderBy(desc(strategyVersionsTable.versionNumber)).limit(1);
  const [version] = await db.insert(strategyVersionsTable).values({
    id: randomUUID(),
    strategyKey: proposal.strategyKey,
    versionNumber: (current?.versionNumber ?? 0) + 1,
    status: "candidate",
    proposalId: id,
    parentVersionId: current?.id ?? null,
    formulaVersion: "advisory-candidate",
    formulaHash: hashJson(proposal.proposalPayload),
    configSnapshot: proposal.proposalPayload,
    ruleDiff: proposal.deterministicRuleDiff,
    evidenceIds: proposal.sourceTeachingIds,
    validationRunId: proposal.validationRunId,
    publishedBy: actor.id,
    createdBy: actor.id,
  }).returning();
  await db.update(advisoryRuleProposalsTable).set({ candidateVersionId: version.id, updatedAt: new Date() }).where(eq(advisoryRuleProposalsTable.id, id));
  return { proposal: await getProposal(id), version };
}

export async function activateCandidate(id: string, actor: GovernanceActor, idempotencyKey: string) {
  const proposal = await getProposal(id);
  if (proposal.status !== "candidate") throw new GovernanceError(409, `Cannot activate a proposal in ${proposal.status} state.`);
  const [version] = await db.select().from(strategyVersionsTable).where(eq(strategyVersionsTable.id, proposal.candidateVersionId ?? ""));
  if (!version) throw new GovernanceError(409, "Publish a candidate strategy version before activation.");
  await db.update(strategyVersionsTable).set({ status: "retired", retiredAt: new Date() }).where(and(eq(strategyVersionsTable.strategyKey, version.strategyKey), eq(strategyVersionsTable.status, "active")));
  await db.update(strategyVersionsTable).set({ status: "active", activatedBy: actor.id, activatedAt: new Date() }).where(eq(strategyVersionsTable.id, version.id));
  const updated = await transition({ id, actor, action: "activated_shadow_version", toStatus: "active", fromStatuses: ["candidate"], idempotencyKey });
  return { proposal: updated, version: (await db.select().from(strategyVersionsTable).where(eq(strategyVersionsTable.id, version.id)))[0] };
}

export async function retireProposal(id: string, actor: GovernanceActor, idempotencyKey: string) {
  const proposal = await transition({ id, actor, action: "retired_shadow_version", toStatus: "retired", fromStatuses: ["active", "candidate"], idempotencyKey });
  if (proposal.candidateVersionId) await db.update(strategyVersionsTable).set({ status: "retired", retiredAt: new Date() }).where(eq(strategyVersionsTable.id, proposal.candidateVersionId));
  return proposal;
}

export async function rollbackProposal(id: string, actor: GovernanceActor, reason: string, idempotencyKey: string) {
  const proposal = await transition({ id, actor, action: "rolled_back_shadow_version", toStatus: "rolled_back", fromStatuses: ["active", "candidate", "retired"], reason, idempotencyKey });
  if (proposal.candidateVersionId) await db.update(strategyVersionsTable).set({ status: "rolled_back", retiredAt: new Date() }).where(eq(strategyVersionsTable.id, proposal.candidateVersionId));
  return proposal;
}

export async function listStrategyVersions(): Promise<StrategyVersion[]> {
  return db.select().from(strategyVersionsTable).orderBy(desc(strategyVersionsTable.versionNumber));
}