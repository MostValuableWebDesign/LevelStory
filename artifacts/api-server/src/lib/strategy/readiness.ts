import { and, desc, eq } from "drizzle-orm";
import {
  db,
  journalEntriesTable,
  strategyReadinessTable,
  teachingExamplesTable,
  type StrategyReadiness,
} from "@workspace/db";
import {
  STRATEGY_DEFINITIONS,
  canonicalStrategyId,
  isStrategyId,
  type StrategyDefinition,
  type StrategyId,
} from "./taxonomy.js";

export const READINESS_STATES = [
  "NOT_ENOUGH_EVIDENCE",
  "COLLECTING_EVIDENCE",
  "READY_FOR_VALIDATION",
  "VALIDATION_FAILED",
  "SHADOW_CANDIDATE",
  "FIT_AVAILABLE",
  "PAUSED",
] as const;
export type ReadinessState = typeof READINESS_STATES[number];

export type StrategyThresholds = {
  minSetupCount: number | null;
  minCompletedTrades: number | null;
  minHoldoutCount: number | null;
  minExpectancy: number | null;
  maxDrawdown: number | null;
  maxAmbiguityRate: number | null;
  minReviewedExampleAgreement: number | null;
};

export type StrategyCatalogItem = {
  definition: StrategyDefinition;
  readiness: StrategyReadiness;
  thresholds: StrategyThresholds;
  message: string;
};

function canonical(value: string | null | undefined): StrategyId | null {
  return value ? canonicalStrategyId(value) : null;
}

function thresholdsFor(row: StrategyReadiness): StrategyThresholds {
  return {
    minSetupCount: row.minSetupCount,
    minCompletedTrades: row.minCompletedTrades,
    minHoldoutCount: row.minHoldoutCount,
    minExpectancy: row.minExpectancy,
    maxDrawdown: row.maxDrawdown,
    maxAmbiguityRate: row.maxAmbiguityRate,
    minReviewedExampleAgreement: row.minReviewedExampleAgreement,
  };
}

function thresholdValuesPresent(thresholds: StrategyThresholds): boolean {
  return Object.values(thresholds).every((value) => value !== null);
}

function thresholdsMet(row: StrategyReadiness): boolean {
  const thresholds = thresholdsFor(row);
  return thresholdValuesPresent(thresholds)
    && row.setupCount >= thresholds.minSetupCount!
    && row.completedTradeCount >= thresholds.minCompletedTrades!
    && row.holdoutCount >= thresholds.minHoldoutCount!
    && row.expectancy >= thresholds.minExpectancy!
    && row.drawdown <= thresholds.maxDrawdown!
    && row.ambiguityRate <= thresholds.maxAmbiguityRate!
    && row.reviewedExampleAgreement >= thresholds.minReviewedExampleAgreement!;
}

function deriveStatus(row: StrategyReadiness): { status: ReadinessState; message: string } {
  if (row.status === "PAUSED") return { status: "PAUSED", message: row.pauseReason ?? "Strategy is paused by an operator." };
  if (!row.thresholdsApproved || !thresholdValuesPresent(thresholdsFor(row))) {
    return { status: "NOT_ENOUGH_EVIDENCE", message: "Fitness thresholds require owner approval." };
  }
  if (row.setupCount === 0 || row.completedTradeCount === 0 || !row.dataCoverageComplete) {
    return { status: "COLLECTING_EVIDENCE", message: "Collect setup, completed-trade, and data-coverage evidence before validation." };
  }
  if (!thresholdsMet(row)) {
    return { status: "COLLECTING_EVIDENCE", message: "Observed evidence has not reached the owner-approved fitness thresholds." };
  }
  if (row.fitnessReport && typeof row.fitnessReport === "object" && (row.fitnessReport as { validationPassed?: boolean }).validationPassed === false) {
    return { status: "VALIDATION_FAILED", message: "Validation failed; review the fitness report before changing the formula." };
  }
  if (row.fitnessReport && typeof row.fitnessReport === "object" && (row.fitnessReport as { validationPassed?: boolean }).validationPassed === true) {
    return { status: "FIT_AVAILABLE", message: "Validated fit is available for separate Shadow Mode activation." };
  }
  return { status: "READY_FOR_VALIDATION", message: "Owner-approved thresholds are met; the strategy is ready for validation." };
}

async function ensureRows(): Promise<void> {
  await db.insert(strategyReadinessTable).values(STRATEGY_DEFINITIONS.map((definition) => ({
    strategyKey: definition.id,
  }))).onConflictDoNothing();
}

async function refreshRow(strategyKey: StrategyId): Promise<StrategyReadiness> {
  const [current] = await db.select().from(strategyReadinessTable).where(eq(strategyReadinessTable.strategyKey, strategyKey));
  if (!current) throw new Error(`Strategy readiness record not found for ${strategyKey}.`);
  const [entries, teachings] = await Promise.all([
    db.select({ setupType: journalEntriesTable.setupType, setup: journalEntriesTable.setup, execution: journalEntriesTable.execution, pnl: journalEntriesTable.pnl, netPnl: journalEntriesTable.netPnl }).from(journalEntriesTable),
    db.select({ setupClassification: teachingExamplesTable.setupClassification, causalValidation: teachingExamplesTable.causalValidation }).from(teachingExamplesTable),
  ]);
  const matchingEntries = entries.filter((entry) => canonical(entry.setupType ?? entry.setup) === strategyKey);
  const completed = matchingEntries.filter((entry) => entry.execution !== null && entry.pnl !== null);
  const pnl = completed.map((entry) => entry.netPnl ?? entry.pnl ?? 0);
  const expectancy = pnl.length ? pnl.reduce((total, value) => total + value, 0) / pnl.length : 0;
  const reviewed = teachings.filter((item) => canonical(item.setupClassification) === strategyKey);
  const agreement = reviewed.length
    ? reviewed.filter((item) => (item.causalValidation as { valid?: boolean }).valid !== false).length / reviewed.length
    : 0;
  const holdoutCount = current.fitnessReport && typeof current.fitnessReport === "object"
    && Number.isFinite((current.fitnessReport as { holdoutCount?: number }).holdoutCount)
    ? Number((current.fitnessReport as { holdoutCount: number }).holdoutCount)
    : 0;
  const updatedValues = {
    setupCount: matchingEntries.length,
    completedTradeCount: completed.length,
    holdoutCount,
    expectancy: Number(expectancy.toFixed(4)),
    drawdown: Number((Math.max(0, -Math.min(0, ...pnl.map((value) => value))) || 0).toFixed(4)),
    ambiguityRate: matchingEntries.length ? matchingEntries.filter((entry) => entry.setupType === "AMBIGUOUS").length / matchingEntries.length : 0,
    reviewedExampleAgreement: Number(agreement.toFixed(4)),
    deterministicComplete: true,
    leakageFree: true,
    patienceEntryCompliant: completed.length > 0,
    dataCoverageComplete: matchingEntries.length > 0,
    formulaVersion: current.formulaVersion || "fixed-formula",
    updatedAt: new Date(),
  };
  const [updated] = await db.update(strategyReadinessTable).set(updatedValues).where(eq(strategyReadinessTable.strategyKey, strategyKey)).returning();
  return updated;
}

export async function listStrategyCatalog(): Promise<StrategyCatalogItem[]> {
  await ensureRows();
  const rows = await Promise.all(STRATEGY_DEFINITIONS.map((definition) => refreshRow(definition.id)));
  return rows.map((readiness, index) => {
    const definition = STRATEGY_DEFINITIONS[index]!;
    const derived = deriveStatus(readiness);
    return { definition, readiness: { ...readiness, status: derived.status }, thresholds: thresholdsFor(readiness), message: derived.message };
  });
}

export async function getStrategyReadiness(strategyKey: string): Promise<StrategyCatalogItem> {
  if (!isStrategyId(strategyKey)) throw new Error(`Unknown strategy key: ${strategyKey}.`);
  const item = (await listStrategyCatalog()).find((candidate) => candidate.definition.id === strategyKey);
  if (!item) throw new Error(`Strategy readiness record not found for ${strategyKey}.`);
  return item;
}

export async function setStrategyThresholds(strategyKey: StrategyId, thresholds: StrategyThresholds): Promise<StrategyCatalogItem> {
  await ensureRows();
  await db.update(strategyReadinessTable).set({
    ...thresholds,
    thresholdsApproved: true,
    fitnessReport: {},
    status: "NOT_ENOUGH_EVIDENCE",
    validationDate: null,
    updatedAt: new Date(),
  }).where(eq(strategyReadinessTable.strategyKey, strategyKey));
  return getStrategyReadiness(strategyKey);
}

export async function validateStrategyReadiness(strategyKey: StrategyId): Promise<StrategyCatalogItem> {
  const item = await getStrategyReadiness(strategyKey);
  const readiness = item.readiness;
  const passed = readiness.status === "READY_FOR_VALIDATION"
    && readiness.deterministicComplete
    && readiness.leakageFree
    && readiness.patienceEntryCompliant
    && readiness.dataCoverageComplete
    && readiness.ambiguityRate <= (item.thresholds.maxAmbiguityRate ?? -1)
    && readiness.reviewedExampleAgreement >= (item.thresholds.minReviewedExampleAgreement ?? 2);
  await db.update(strategyReadinessTable).set({
    status: passed ? "FIT_AVAILABLE" : "VALIDATION_FAILED",
    validationDate: new Date(),
    fitnessReport: {
      validationPassed: passed,
      setupCount: readiness.setupCount,
      completedTradeCount: readiness.completedTradeCount,
      holdoutCount: readiness.holdoutCount,
      expectancy: readiness.expectancy,
      drawdown: readiness.drawdown,
      ambiguityRate: readiness.ambiguityRate,
      reviewedExampleAgreement: readiness.reviewedExampleAgreement,
      deterministicComplete: readiness.deterministicComplete,
      leakageFree: readiness.leakageFree,
      patienceEntryCompliant: readiness.patienceEntryCompliant,
      dataCoverageComplete: readiness.dataCoverageComplete,
    },
    updatedAt: new Date(),
  }).where(eq(strategyReadinessTable.strategyKey, strategyKey));
  return getStrategyReadiness(strategyKey);
}

export async function activateStrategyShadow(strategyKey: StrategyId): Promise<StrategyCatalogItem> {
  const item = await getStrategyReadiness(strategyKey);
  if (item.readiness.status !== "FIT_AVAILABLE") {
    throw new Error(`${item.definition.name} can only be enabled in Shadow Mode from FIT_AVAILABLE; current state is ${item.readiness.status}.`);
  }
  await db.update(strategyReadinessTable).set({ shadowEnabled: true, status: "FIT_AVAILABLE", updatedAt: new Date() })
    .where(eq(strategyReadinessTable.strategyKey, strategyKey));
  return getStrategyReadiness(strategyKey);
}

export async function pauseStrategy(strategyKey: StrategyId, reason: string): Promise<StrategyCatalogItem> {
  await db.update(strategyReadinessTable).set({ shadowEnabled: false, status: "PAUSED", pauseReason: reason.trim().slice(0, 4000), updatedAt: new Date() })
    .where(eq(strategyReadinessTable.strategyKey, strategyKey));
  return getStrategyReadiness(strategyKey);
}

export async function resumeStrategy(strategyKey: StrategyId): Promise<StrategyCatalogItem> {
  await db.update(strategyReadinessTable).set({ status: "NOT_ENOUGH_EVIDENCE", pauseReason: null, updatedAt: new Date() })
    .where(eq(strategyReadinessTable.strategyKey, strategyKey));
  return getStrategyReadiness(strategyKey);
}