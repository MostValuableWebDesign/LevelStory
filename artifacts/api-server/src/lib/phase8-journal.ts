import { desc } from "drizzle-orm";
import { db, journalEntriesTable } from "@workspace/db";
import type { JournalEntryInput, Phase8TimelineEvent } from "@workspace/api-zod";
import type { MarketSnapshot } from "./market-data.js";
import { setupOutcome } from "./strategy/phase8.js";

function round(value: number): number {
  return Number(value.toFixed(2));
}

export function toApiJournalEntry(entry: typeof journalEntriesTable.$inferSelect) {
  return {
    ...entry,
    createdAt: entry.createdAt.toISOString(),
    evaluationKey: entry.evaluationKey ?? null,
    contractMonth: entry.contractMonth ?? null,
    setupType: entry.setupType ?? null,
    outcome: entry.outcome ?? null,
    tradingDate: entry.tradingDate ?? null,
    trend: entry.trend ?? null,
    contracts: entry.contracts ?? null,
    grossPnl: entry.grossPnl ?? null,
    netPnl: entry.netPnl ?? null,
    fees: entry.fees ?? null,
    slippage: entry.slippage ?? null,
    profitTarget: entry.profitTarget ?? null,
    maximumFavorableExcursion: entry.maximumFavorableExcursion ?? null,
    maximumAdverseExcursion: entry.maximumAdverseExcursion ?? null,
    exitReason: entry.exitReason ?? null,
    levels: entry.levels ?? null,
    confluences: entry.confluences ?? null,
    ntz: entry.ntz ?? null,
    breakout: entry.breakout ?? null,
    pullback: entry.pullback ?? null,
    fibonacci: entry.fibonacci ?? null,
    volume: entry.volume ?? null,
    patience: entry.patience ?? null,
    stops: entry.stops ?? null,
    runner: entry.runner ?? null,
    passedRules: entry.passedRules ?? null,
    failedRules: entry.failedRules ?? null,
    timeline: entry.timeline ?? null,
    execution: entry.execution ?? null,
  };
}

function recordForEvaluation(snapshot: MarketSnapshot, evaluation: MarketSnapshot["setupAnalysis"]["evaluations"][number]): JournalEntryInput {
  const direction = evaluation.direction ?? snapshot.riskPlan.direction;
  const entryPrice = snapshot.riskPlan.entry ?? snapshot.price;
  const isPrimary = evaluation.setupType === snapshot.setupAnalysis.primarySetup;
  const execution = isPrimary ? snapshot.shadowExecution : null;
  const outcome = setupOutcome(evaluation.decision);
  const failedRules = evaluation.rules.filter((rule) => !rule.passed);
  const passedRules = evaluation.rules.filter((rule) => rule.passed);
  const evaluationKey = `${snapshot.contract.fullContractSymbol}|${snapshot.replay.cursor}|${evaluation.setupType}|${evaluation.decision}`;
  const replayTime = new Date(snapshot.updatedAt).getTime();
  const excursionCandles = snapshot.candles.filter((candle) => new Date(candle.closeTime).getTime() >= replayTime);
  const favorablePrice = excursionCandles.length
    ? direction === "long" ? Math.max(...excursionCandles.map((candle) => candle.high)) : Math.min(...excursionCandles.map((candle) => candle.low))
    : entryPrice;
  const adversePrice = excursionCandles.length
    ? direction === "long" ? Math.min(...excursionCandles.map((candle) => candle.low)) : Math.max(...excursionCandles.map((candle) => candle.high))
    : entryPrice;
  const multiplier = snapshot.contract.pointValue * snapshot.contract.contractMultiplier;
  const mfe = round(Math.max(0, (favorablePrice - entryPrice) * multiplier * (direction === "long" ? 1 : -1)));
  const mae = round(Math.max(0, (entryPrice - adversePrice) * multiplier * (direction === "long" ? 1 : -1)));
  return {
    symbol: snapshot.contract.fullContractSymbol,
    side: direction,
    setup: evaluation.setupType,
    entryPrice,
    exitPrice: execution?.exitFillPrice ?? null,
    quantity: Math.max(1, snapshot.riskPlan.contracts),
    pnl: execution?.accounting.netPnl ?? null,
    notes: `${evaluation.explanation} ${failedRules.length ? `Failed rules: ${failedRules.map((rule) => rule.label).join(", ")}.` : ""} Shadow analysis only; no order was created.`,
    checklistPassed: outcome === "qualified" && failedRules.length === 0,
    evaluationKey,
    contractMonth: snapshot.contract.contractMonth,
    setupType: evaluation.setupType,
    outcome,
    tradingDate: snapshot.sessionCalendar.tradingDate,
    trend: snapshot.trend.direction,
    contracts: snapshot.riskPlan.contracts,
    grossPnl: execution?.accounting.grossPnl ?? null,
    netPnl: execution?.accounting.netPnl ?? null,
    fees: execution?.accounting.fees ?? null,
    slippage: execution?.accounting.slippage ?? null,
    profitTarget: snapshot.riskPlan.target,
    maximumFavorableExcursion: mfe,
    maximumAdverseExcursion: mae,
    exitReason: execution?.exitReason ?? "not filled",
    levels: snapshot.levels,
    confluences: { levels: snapshot.majorLevels },
    ntz: snapshot.ntz,
    breakout: snapshot.breakout,
    pullback: snapshot.pullback,
    fibonacci: snapshot.fibonacci,
    volume: snapshot.volumeAnalysis,
    patience: snapshot.patience,
    stops: {
      thesisStop: snapshot.riskPlan.thesisStop,
      strategyStop: snapshot.riskPlan.strategyStop,
      catastropheStop: snapshot.riskPlan.catastropheStop,
    },
    runner: snapshot.riskPlan.runner,
    passedRules,
    failedRules,
    timeline: snapshot.levelStory.map((item) => ({
      time: item.time,
      eventType: item.eventType as Phase8TimelineEvent["eventType"],
      label: item.level,
      detail: item.detail,
      status: item.status as Phase8TimelineEvent["status"],
    })),
    ...(execution ? { execution } : {}),
  };
}

export async function recordSnapshotEvaluations(snapshot: MarketSnapshot): Promise<void> {
  const records = snapshot.setupAnalysis.evaluations.map((evaluation) => recordForEvaluation(snapshot, evaluation));
  if (!records.length) return;
  await db.insert(journalEntriesTable).values(records).onConflictDoNothing({
    target: journalEntriesTable.evaluationKey,
  });
}

export async function recentJournalEntries(limit = 5) {
  return db.select().from(journalEntriesTable).orderBy(desc(journalEntriesTable.createdAt)).limit(limit);
}