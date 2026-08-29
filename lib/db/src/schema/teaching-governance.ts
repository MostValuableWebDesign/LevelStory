import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const teachingExamplesTable = pgTable("levelstory_teaching_examples", {
  id: text("id").primaryKey(),
  reviewSetId: text("review_set_id").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  reviewId: text("review_id"),
  reviewerId: text("reviewer_id").notNull(),
  status: text("status").notNull().default("submitted"),
  judgment: text("judgment").notNull(),
  symbol: text("symbol").notNull(),
  contract: text("contract").notNull(),
  tradingDate: text("trading_date").notNull(),
  dataPartition: text("data_partition").notNull().default("in_sample"),
  selectedCandleTimestamp: text("selected_candle_timestamp").notNull(),
  patienceCandleTimestamp: text("patience_candle_timestamp"),
  direction: text("direction"),
  entryBufferTicks: integer("entry_buffer_ticks"),
  calculatedEntryPrice: text("calculated_entry_price"),
  setupClassification: text("setup_classification").notNull(),
  qualifyingLevelType: text("qualifying_level_type"),
  qualifyingPullbackLevels: jsonb("qualifying_pullback_levels").notNull().default([]),
  confidence: text("confidence").notNull(),
  reviewerExplanation: text("reviewer_explanation").notNull(),
  machineDecision: text("machine_decision").notNull(),
  machineRejectionReasons: jsonb("machine_rejection_reasons").notNull().default([]),
  calendarVersion: text("calendar_version").notNull(),
  evidenceSnapshot: jsonb("evidence_snapshot").notNull(),
  causalValidation: jsonb("causal_validation").notNull(),
  formulaVersion: text("formula_version").notNull(),
  formulaHash: text("formula_hash").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(),
  calendarFingerprint: text("calendar_fingerprint").notNull(),
  supersedesTeachingId: text("supersedes_teaching_id"),
  revision: integer("revision").notNull().default(1),
  idempotencyKey: text("idempotency_key").notNull(),
  outcomeSnapshot: jsonb("outcome_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  reviewerIdempotencyUnique: unique("levelstory_teaching_reviewer_idempotency_unique").on(table.reviewerId, table.idempotencyKey),
  snapshotRevisionIndex: index("levelstory_teaching_snapshot_revision_idx").on(table.reviewSetId, table.snapshotId, table.revision),
}));

export const advisoryRuleProposalsTable = pgTable("levelstory_advisory_rule_proposals", {
  id: text("id").primaryKey(),
  strategyKey: text("strategy_key"),
  title: text("title").notNull(),
  hypothesis: text("hypothesis").notNull(),
  rationale: text("rationale").notNull(),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by").notNull(),
  proposalType: text("proposal_type").notNull().default("formula_rule_change"),
  plainLanguageSummary: text("plain_language_summary").notNull().default(""),
  currentRule: text("current_rule").notNull().default(""),
  proposedRule: text("proposed_rule").notNull().default(""),
  deterministicRuleDiff: jsonb("deterministic_rule_diff").notNull().default({}),
  affectedRuleIds: text("affected_rule_ids").array().notNull().default([]),
  expectedBehaviorChange: text("expected_behavior_change").notNull().default(""),
  risks: jsonb("risks").notNull().default([]),
  sourceTeachingIds: text("source_teaching_ids").array().notNull(),
  supportingExampleIds: text("supporting_example_ids").array().notNull().default([]),
  conflictingExampleIds: text("conflicting_example_ids").array().notNull().default([]),
  sourceFormulaVersion: text("source_formula_version").notNull().default(""),
  candidateFormulaVersion: text("candidate_formula_version"),
  proposalPayload: jsonb("proposal_payload").notNull(),
  validationRunId: text("validation_run_id"),
  candidateVersionId: text("candidate_version_id"),
  rejectionReason: text("rejection_reason"),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  clarificationRequest: text("clarification_request"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  idempotencyKey: text("idempotency_key").notNull(),
}, (table) => ({
  creatorIdempotencyUnique: unique("levelstory_proposal_creator_idempotency_unique").on(table.createdBy, table.idempotencyKey),
  statusIndex: index("levelstory_proposal_status_idx").on(table.status),
}));

export const ruleProposalAuditEventsTable = pgTable("levelstory_rule_proposal_audit_events", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  reason: text("reason"),
  idempotencyKey: text("idempotency_key"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  proposalCreatedIndex: index("levelstory_proposal_audit_proposal_created_idx").on(table.proposalId, table.createdAt),
  idempotentActionUnique: unique("levelstory_proposal_audit_idempotent_action_unique").on(table.proposalId, table.actorId, table.action, table.idempotencyKey),
}));

export const strategyVersionsTable = pgTable("levelstory_strategy_versions", {
  id: text("id").primaryKey(),
  strategyKey: text("strategy_key").notNull().default("MES_SHADOW"),
  versionNumber: integer("version_number").notNull(),
  status: text("status").notNull().default("candidate"),
  proposalId: text("proposal_id"),
  parentVersionId: text("parent_version_id"),
  formulaVersion: text("formula_version").notNull(),
  formulaHash: text("formula_hash").notNull(),
  configSnapshot: jsonb("config_snapshot").notNull(),
  ruleDiff: jsonb("rule_diff").notNull().default({}),
  evidenceIds: text("evidence_ids").array().notNull().default([]),
  validationRunId: text("validation_run_id"),
  publishedBy: text("published_by").notNull(),
  createdBy: text("created_by").notNull(),
  activatedBy: text("activated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (table) => ({
  strategyVersionUnique: unique("levelstory_strategy_key_version_unique").on(table.strategyKey, table.versionNumber),
  strategyStatusIndex: index("levelstory_strategy_status_idx").on(table.strategyKey, table.status),
}));

export const proposalValidationRunsTable = pgTable("levelstory_proposal_validation_runs", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  status: text("status").notNull().default("queued"),
  beforeMetrics: jsonb("before_metrics"),
  afterMetrics: jsonb("after_metrics"),
  regressions: jsonb("regressions").notNull().default([]),
  conflicts: jsonb("conflicts").notNull().default([]),
  warnings: jsonb("warnings").notNull().default([]),
  formulaFingerprint: text("formula_fingerprint").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(),
  errorMessage: text("error_message"),
  progressStage: text("progress_stage").notNull().default("queued"),
  progressPercent: integer("progress_percent").notNull().default(0),
  attempt: integer("attempt").notNull().default(0),
  workerId: text("worker_id"),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  parentFormulaHash: text("parent_formula_hash"),
  candidateFormulaHash: text("candidate_formula_hash"),
  validationConfigFingerprint: text("validation_config_fingerprint"),
  holdoutCompleted: integer("holdout_completed").notNull().default(0),
  evidenceIds: jsonb("evidence_ids").notNull().default([]),
  requestedBy: text("requested_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => ({
  proposalFingerprintUnique: unique("levelstory_validation_proposal_fingerprint_unique").on(table.proposalId, table.requestFingerprint),
  validationStatusIndex: index("levelstory_validation_status_idx").on(table.status),
}));

export const insertTeachingExampleSchema = createInsertSchema(teachingExamplesTable).omit({ createdAt: true });
export const insertAdvisoryRuleProposalSchema = createInsertSchema(advisoryRuleProposalsTable).omit({ createdAt: true, updatedAt: true });
export const insertRuleProposalAuditEventSchema = createInsertSchema(ruleProposalAuditEventsTable).omit({ createdAt: true });
export const insertStrategyVersionSchema = createInsertSchema(strategyVersionsTable).omit({ createdAt: true });
export const insertProposalValidationRunSchema = createInsertSchema(proposalValidationRunsTable).omit({ createdAt: true });

export type TeachingExample = typeof teachingExamplesTable.$inferSelect;
export type AdvisoryRuleProposal = typeof advisoryRuleProposalsTable.$inferSelect;
export type RuleProposalAuditEvent = typeof ruleProposalAuditEventsTable.$inferSelect;
export type StrategyVersion = typeof strategyVersionsTable.$inferSelect;
export type ProposalValidationRun = typeof proposalValidationRunsTable.$inferSelect;
export type InsertTeachingExample = z.infer<typeof insertTeachingExampleSchema>;