import { createHash } from "node:crypto";
import { DEFAULT_STRATEGY_CONFIG, strategyConfig, type StrategyConfig } from "./strategy/config.js";
import type { TeachingExample } from "@workspace/db";
import { createMarketSnapshot } from "./market-data.js";

export const PROPOSAL_VALIDATOR_VERSION = "candidate-validation-v3";

type RuleField = keyof StrategyConfig;
export type DeterministicRuleDiff = { field: RuleField; value: number | boolean };

const ALLOWED_FIELDS = new Set<RuleField>([
  "patienceEntryBufferTicks",
]);

export type ComparisonMetrics = {
  sampleCount: number;
  qualifiedTrades: number;
  completedTrades: number;
  tradesAdded: number;
  tradesRemoved: number;
  entryTimesChanged: number;
  directionChanges: number;
  rejectionReasonChanges: number;
  teachingCorrected: number;
  teachingRegressed: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  maximumDrawdown: number;
  averageTrade: number;
  stopOutcomes: number;
  targetOutcomes: number;
  runnerOutcomes: number;
  ambiguousSameCandleOutcomes: number;
  inSampleCount: number;
  holdoutCount: number;
  performanceMetricsAvailable: boolean;
};

export type ComparisonResult = {
  validatorVersion: string;
  beforeMetrics: ComparisonMetrics;
  afterMetrics: ComparisonMetrics;
  inSampleMetrics: { before: ComparisonMetrics; after: ComparisonMetrics };
  holdoutMetrics: { before: ComparisonMetrics; after: ComparisonMetrics };
  regressions: string[];
  conflicts: string[];
  warnings: string[];
  parentFormulaHash: string;
  candidateFormulaHash: string;
  holdoutCompleted: boolean;
  holdoutPassed: boolean;
  noFutureData: boolean;
  immediateNextEntryCompliant: boolean;
  entryBufferCompliant: boolean;
  datasetFingerprint: string;
  calendarFingerprint: string;
  performanceMetricsAvailable: boolean;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildCandidateConfiguration(diff: unknown, parentInput: Partial<StrategyConfig> = DEFAULT_STRATEGY_CONFIG): { parent: StrategyConfig; candidate: StrategyConfig; normalizedDiff: DeterministicRuleDiff[] } {
  const parent = strategyConfig(parentInput);
  const raw = Array.isArray(diff) ? diff : typeof diff === "object" && diff !== null && "field" in diff ? [diff] : [];
  if (!raw.length) throw new Error("A typed deterministicRuleDiff is required.");
  const normalizedDiff: DeterministicRuleDiff[] = raw.map((item) => {
    if (typeof item !== "object" || item === null || typeof (item as { field?: unknown }).field !== "string") {
      throw new Error("Each deterministic rule change must include a field and value.");
    }
    const field = (item as { field: string }).field as RuleField;
    const value = (item as { value?: unknown }).value;
    if (!ALLOWED_FIELDS.has(field) || (typeof value !== "number" && typeof value !== "boolean") || !Number.isFinite(value as number)) {
      throw new Error(`Unknown or invalid deterministic rule field: ${String(field)}.`);
    }
    return { field, value } as DeterministicRuleDiff;
  });
  const candidate = strategyConfig({ ...parent, ...Object.fromEntries(normalizedDiff.map(({ field, value }) => [field, value])) } as Partial<StrategyConfig>);
  return { parent, candidate, normalizedDiff };
}

type FormulaOutcome = { qualified: boolean; direction: string | null; entryTime: string | null; rejectionReason: string };

function executeFormula(config: StrategyConfig, teaching: TeachingExample): FormulaOutcome {
  const evidence = (teaching.evidenceSnapshot ?? {}) as { futureCandleAccess?: boolean; quotesAvailable?: boolean; sourceSchema?: string; evaluationCursor?: { closeTime?: string }; machineEvidenceSnapshot?: { machineEvidence?: { quotesAvailable?: boolean; sourceSchema?: string }; quotesAvailable?: boolean; sourceSchema?: string; machineCandles?: Array<Record<string, unknown>>; premarketCandles?: Array<Record<string, unknown>>; evaluationCursor?: { closeTime?: string } }; machineCandles?: Array<Record<string, unknown>>; premarketCandles?: Array<Record<string, unknown>> };
  const validTiming = Boolean(teaching.selectedCandleTimestamp && teaching.patienceCandleTimestamp);
  const rawCandles = [...(evidence.machineEvidenceSnapshot?.premarketCandles ?? evidence.premarketCandles ?? []), ...(evidence.machineEvidenceSnapshot?.machineCandles ?? evidence.machineCandles ?? [])];
  if (!rawCandles.length) throw new Error("Immutable candle evidence missing.");
  const quotesAvailable = evidence.machineEvidenceSnapshot?.machineEvidence?.quotesAvailable
    ?? evidence.machineEvidenceSnapshot?.quotesAvailable ?? evidence.quotesAvailable ?? false;
  const sourceSchema = evidence.machineEvidenceSnapshot?.machineEvidence?.sourceSchema
    ?? evidence.machineEvidenceSnapshot?.sourceSchema ?? evidence.sourceSchema ?? "historical_ohlcv";
  if (quotesAvailable && rawCandles.some((candle) => !["bid", "ask", "bidSize", "askSize", "contractSymbol"].every((key) => key in candle))) throw new Error("Immutable quote evidence missing.");
  const candles = rawCandles.map((candle) => ({
    timestamp: Date.parse(String(candle.timestamp ?? candle.openTime)),
    openTime: Date.parse(String(candle.openTime)), closeTime: Date.parse(String(candle.closeTime)),
    open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close),
    volume: Number(candle.volume ?? 0), bid: Number(candle.bid ?? Number.NaN), ask: Number(candle.ask ?? Number.NaN),
    bidSize: Number(candle.bidSize ?? Number.NaN), askSize: Number(candle.askSize ?? Number.NaN), contractSymbol: String(candle.contractSymbol ?? teaching.contract), isComplete: candle.isComplete !== false,
  })).filter((candle) => Number.isFinite(candle.openTime) && Number.isFinite(candle.closeTime) && Number.isFinite(candle.open));
  if (!candles.length || candles.some((candle) => candle.contractSymbol !== teaching.contract)) throw new Error(`Immutable ${sourceSchema} candle evidence is malformed or crosses contracts.`);
  const patienceTime = teaching.patienceCandleTimestamp ? Date.parse(teaching.patienceCandleTimestamp) : NaN;
  const entryTime = teaching.selectedCandleTimestamp ? Date.parse(teaching.selectedCandleTimestamp) : NaN;
  if (!Number.isFinite(patienceTime) || !Number.isFinite(entryTime) || entryTime - patienceTime !== 5 * 60 * 1000) {
    throw new Error("Immediate-next candle must be exactly five minutes after the patience candle.");
  }
  const snapshot = validTiming ? createMarketSnapshot("MES", "regular", undefined, undefined, undefined, {
    tradingDate: teaching.tradingDate,
    cursor: Date.parse(evidence.machineEvidenceSnapshot?.evaluationCursor?.closeTime ?? evidence.evaluationCursor?.closeTime ?? teaching.selectedCandleTimestamp),
    strategyConfigOverrides: config,
    ...(candles.length ? { allCandles: candles, historicalFeed: candles } : {}),
  }) : null;
  const qualified = validTiming && snapshot?.setupAnalysis.decision === "SETUP QUALIFIED"
    && snapshot.setupAnalysis.primarySetup !== null;
  return {
    qualified,
    direction: qualified ? teaching.direction : null,
    entryTime: qualified ? teaching.selectedCandleTimestamp : null,
    rejectionReason: qualified ? "" : !validTiming ? "IMMEDIATE_NEXT_CANDLE_REQUIRED" : snapshot?.setupAnalysis.decision ?? "FORMULA_REJECTED",
  };
}

function metrics(outcomes: FormulaOutcome[], teachings: TeachingExample[]): ComparisonMetrics {
  // Teaching outcomes are observations, not candidate executions. Until the
  // deterministic modeled-fill replay is available, expose decision-only
  // metrics rather than laundering the original outcome into the comparison.
  const pnl = teachings.map(() => 0);
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    sampleCount: teachings.length,
    qualifiedTrades: outcomes.filter((item) => item.qualified).length,
    completedTrades: 0,
    tradesAdded: 0, tradesRemoved: 0, entryTimesChanged: 0, directionChanges: 0, rejectionReasonChanges: 0,
    teachingCorrected: 0, teachingRegressed: 0,
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : 0,
    netPnl: Number(pnl.reduce((sum, value) => sum + value, 0).toFixed(4)),
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(4)) : grossProfit ? Number.POSITIVE_INFINITY : 0,
    maximumDrawdown: Number(maximumDrawdown.toFixed(4)),
    averageTrade: outcomes.length ? Number((pnl.reduce((sum, value) => sum + value, 0) / outcomes.length).toFixed(4)) : 0,
    stopOutcomes: 0, targetOutcomes: 0, runnerOutcomes: 0, ambiguousSameCandleOutcomes: 0,
    inSampleCount: teachings.filter((item) => ((item.evidenceSnapshot as { period?: string } | null)?.period ?? "in_sample") === "in_sample").length,
    holdoutCount: teachings.filter((item) => (item.evidenceSnapshot as { period?: string } | null)?.period === "holdout").length,
    performanceMetricsAvailable: false,
  };
}

export function compareCandidate(teachings: TeachingExample[], diff: unknown, parentInput: Partial<StrategyConfig> = DEFAULT_STRATEGY_CONFIG): ComparisonResult {
  const { parent, candidate, normalizedDiff } = buildCandidateConfiguration(diff, parentInput);
  const parentOutcomes = teachings.map((item) => executeFormula(parent, item));
  const candidateOutcomes = teachings.map((item) => executeFormula(candidate, item));
  const beforeMetrics = metrics(parentOutcomes, teachings);
  const afterMetrics = metrics(candidateOutcomes, teachings);
  const period = (item: TeachingExample) => {
    const value = item.dataPartition || (item.evidenceSnapshot as { period?: string } | null)?.period;
    return value === "holdout" || value === "out_of_sample" ? "holdout" : "in_sample";
  };
  const inSample = teachings.map((item, index) => ({ item, index })).filter(({ item }) => period(item) === "in_sample");
  const holdout = teachings.map((item, index) => ({ item, index })).filter(({ item }) => period(item) === "holdout");
  const regressions: string[] = [];
  const conflicts: string[] = [];
  teachings.forEach((teaching, index) => {
    const before = parentOutcomes[index]!;
    const after = candidateOutcomes[index]!;
    const expected = teaching.judgment === "missed_trade";
    if (expected && !after.qualified) regressions.push(`Teaching ${teaching.id} remains unqualified after candidate execution.`);
    if (!expected && after.qualified) conflicts.push(`Teaching ${teaching.id} is qualified despite a ${teaching.judgment} judgment.`);
    if (before.qualified !== after.qualified) {
      if (after.qualified) afterMetrics.tradesAdded += 1;
      else afterMetrics.tradesRemoved += 1;
    }
    if (before.entryTime !== after.entryTime) afterMetrics.entryTimesChanged += 1;
    if (before.direction !== after.direction) afterMetrics.directionChanges += 1;
    if (before.rejectionReason !== after.rejectionReason) afterMetrics.rejectionReasonChanges += 1;
    if (expected && after.qualified) afterMetrics.teachingCorrected += 1;
    if (!expected && after.qualified) afterMetrics.teachingRegressed += 1;
  });
  const noFutureData = teachings.every((item) => {
    const snapshot = item.evidenceSnapshot as { futureCandleAccess?: boolean; evaluationCursor?: { futureCandleAccess?: boolean }; machineEvidenceSnapshot?: { evaluationCursor?: { futureCandleAccess?: boolean } } } | null;
    return snapshot?.futureCandleAccess !== true
      && snapshot?.evaluationCursor?.futureCandleAccess !== true
      && snapshot?.machineEvidenceSnapshot?.evaluationCursor?.futureCandleAccess !== true;
  });
  const causalEvidenceValid = teachings.every((item) => (item.causalValidation as { valid?: boolean }).valid === true);
  const immediateNextEntryCompliant = teachings.every((item) => Boolean(item.selectedCandleTimestamp && item.patienceCandleTimestamp));
  const entryBufferCompliant = teachings.every((item) => item.entryBufferTicks === 3 || item.entryBufferTicks === 4);
  if (!causalEvidenceValid) conflicts.push("Causal validation did not pass for every selected teaching example.");
  if (!noFutureData) conflicts.push("Future candle access was detected in teaching evidence.");
  if (!immediateNextEntryCompliant) conflicts.push("Immediate-next patience-entry timing is incomplete.");
  if (!entryBufferCompliant) conflicts.push("Every entry buffer must be three or four ticks.");
  const datasetFingerprint = hash(teachings.map((item) => item.sourceFingerprint));
  const calendarFingerprint = hash(teachings.map((item) => item.calendarFingerprint));
  return {
    validatorVersion: PROPOSAL_VALIDATOR_VERSION,
    beforeMetrics, afterMetrics,
    inSampleMetrics: {
      before: metrics(inSample.map(({ index }) => parentOutcomes[index]!), inSample.map(({ item }) => item)),
      after: metrics(inSample.map(({ index }) => candidateOutcomes[index]!), inSample.map(({ item }) => item)),
    },
    holdoutMetrics: {
      before: metrics(holdout.map(({ index }) => parentOutcomes[index]!), holdout.map(({ item }) => item)),
      after: metrics(holdout.map(({ index }) => candidateOutcomes[index]!), holdout.map(({ item }) => item)),
    },
    regressions, conflicts,
    warnings: normalizedDiff.length > 1 ? ["Multiple typed rule changes increase attribution risk."] : [],
    parentFormulaHash: hash(parent), candidateFormulaHash: hash(candidate),
    holdoutCompleted: holdout.length > 0,
    holdoutPassed: holdout.length > 0 && holdout.every(({ index }) => {
      const outcome = candidateOutcomes[index]!;
      const judgment = teachings[index]!.judgment;
      return judgment === "missed_trade" ? outcome.qualified : !outcome.qualified;
    }),
    noFutureData, immediateNextEntryCompliant, entryBufferCompliant,
    performanceMetricsAvailable: false,
    datasetFingerprint, calendarFingerprint,
  };
}