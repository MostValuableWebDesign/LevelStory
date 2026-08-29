import { boolean, integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const strategyReadinessTable = pgTable("levelstory_strategy_readiness", {
  strategyKey: text("strategy_key").primaryKey(),
  status: text("status").notNull().default("NOT_ENOUGH_EVIDENCE"),
  minSetupCount: integer("min_setup_count"),
  minCompletedTrades: integer("min_completed_trades"),
  minHoldoutCount: integer("min_holdout_count"),
  minExpectancy: numeric("min_expectancy", { precision: 12, scale: 4, mode: "number" }),
  maxDrawdown: numeric("max_drawdown", { precision: 12, scale: 4, mode: "number" }),
  maxAmbiguityRate: numeric("max_ambiguity_rate", { precision: 8, scale: 4, mode: "number" }),
  minReviewedExampleAgreement: numeric("min_reviewed_example_agreement", { precision: 8, scale: 4, mode: "number" }),
  thresholdsApproved: boolean("thresholds_approved").notNull().default(false),
  setupCount: integer("setup_count").notNull().default(0),
  completedTradeCount: integer("completed_trade_count").notNull().default(0),
  holdoutCount: integer("holdout_count").notNull().default(0),
  expectancy: numeric("expectancy", { precision: 12, scale: 4, mode: "number" }).notNull().default(0),
  drawdown: numeric("drawdown", { precision: 12, scale: 4, mode: "number" }).notNull().default(0),
  ambiguityRate: numeric("ambiguity_rate", { precision: 8, scale: 4, mode: "number" }).notNull().default(0),
  reviewedExampleAgreement: numeric("reviewed_example_agreement", { precision: 8, scale: 4, mode: "number" }).notNull().default(0),
  deterministicComplete: boolean("deterministic_complete").notNull().default(false),
  leakageFree: boolean("leakage_free").notNull().default(true),
  patienceEntryCompliant: boolean("patience_entry_compliant").notNull().default(false),
  dataCoverageComplete: boolean("data_coverage_complete").notNull().default(false),
  formulaVersion: text("formula_version").notNull().default(""),
  validationDate: timestamp("validation_date", { withTimezone: true }),
  pauseReason: text("pause_reason"),
  shadowEnabled: boolean("shadow_enabled").notNull().default(false),
  fitnessReport: jsonb("fitness_report").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStrategyReadinessSchema = createInsertSchema(strategyReadinessTable).omit({ updatedAt: true });
export type InsertStrategyReadiness = z.infer<typeof insertStrategyReadinessSchema>;
export type StrategyReadiness = typeof strategyReadinessTable.$inferSelect;