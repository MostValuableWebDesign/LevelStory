import { createHash, randomUUID } from "node:crypto";
import {
  createMarketSnapshot,
  type MarketSnapshot,
} from "./market-data.js";
import {
  visibleReplayPrefix,
  type BacktestAuditRecord,
  type BacktestReport,
  type BacktestTrade,
  type CausalReplayDataset,
  type HistoricalOccurrence,
  type HistoricalTradeCandidate,
  buildQualificationFunnel,
  type QualificationFunnel,
  sourceFingerprint as datasetSourceFingerprint,
} from "./phase9.js";
import { buildHistoricalVisualValidationSetInWorker } from "./visual-validation-worker-client.js";
import { FIXED_FORMULA_VERSION, formulaConfigurationHash } from "./formula-hash.js";
import { APPLICATION_BUILD_ID } from "./build-metadata.js";
import type { SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { createVisualValidationFixtures } from "./visual-validation-fixtures.js";
import {
  classifyFuturesSession,
  sessionCalendarForContract,
  sessionWindow,
  tradingDateForTimestamp,
  wallClockMinutesForTimestamp,
} from "./futures/session-calendar.js";
import { causalEmaSeries } from "./strategy/indicators.js";
import { levelInteractionDistance, qualifyLevelInteraction } from "./strategy/phase4.js";
import { getFuturesContractSpecification } from "./futures/contracts.js";
import { strategyConfig } from "./strategy/config.js";
import { canonicalStrategyId, type StrategyId } from "./strategy/taxonomy.js";
import { activeShadowStrategySnapshot } from "./active-shadow-strategy.js";
import {
  DEFAULT_LEVEL_TOLERANCE_TICKS,
  LEVEL_TOLERANCE_TICKS,
  MES_TICK_SIZE,
  levelTolerancePoints,
} from "@workspace/api-spec/constants";

export const VISUAL_VALIDATION_CATEGORIES = [
  "qualified_trade",
  "rejected_setup",
  "bullish_patience_candle",
  "bearish_patience_candle",
  "weak_orb_probe",
  "strong_breakout",
  "pullback",
  "consolidation",
  "ambiguous_candle",
  "stop_exit",
  "target_exit",
  "runner_exit",
] as const;

export type VisualValidationCategory = typeof VISUAL_VALIDATION_CATEGORIES[number];
export type VisualValidationEntryWindow = "primary" | "outside_primary";
export type VisualValidationReviewStatus = "unreviewed" | "correct" | "incorrect" | "uncertain" | "rule_needs_clarification" | "missed_trade" | "false_positive_trade";
export type VisualValidationReviewMode = "trades_only" | "confirmed_signals" | "trades_and_diagnostics";
export type VisualValidationTeachingJudgment = "missed_trade" | "false_positive_trade";
export type VisualValidationTeachingConfidence = "low" | "medium" | "high";
export type VisualValidationTeachingSetup = StrategyId;

export type VisualValidationRequest = {
  symbol: string;
  endDate: string;
  inSampleDays: number;
  outOfSampleDays: number;
  seed?: number;
  premarketAvailable?: boolean;
  source?: "simulated" | "historical_databento";
  reviewMode?: VisualValidationReviewMode;
};

export type VisualValidationCandle = {
  openTime: string;
  closeTime: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  contractSymbol: string;
  isComplete: boolean;
};

export type VisualValidationAnnotation = {
  id: string;
  label: string;
  kind: "level" | "indicator" | "fibonacci" | "candle" | "price";
  price: number | null;
  rangeLow?: number | null;
  rangeHigh?: number | null;
  openTime: string | null;
  closeTime: string | null;
  available: boolean;
  color: "accent" | "positive" | "negative" | "muted" | "blue";
  detail: string;
  visibility: "machine" | "human_only";
};

export type VisualValidationIndicatorPoint = {
  openTime: string;
  closeTime: string;
  vwap: number | null;
  ema200: number | null;
  contractSymbol: string;
  sessionTemplate: string;
  noResetPolicy: "continuous_contract_local";
  warmupCount: number;
  initializationMethod: "sma_of_period_closes" | "unavailable";
  sourceStartTime: string | null;
  sourceEndTime: string | null;
  availability: "available" | "insufficient_warmup";
  visibility: "machine" | "human_only";
};

export type VisualValidationTradeEvent = {
  id: string;
  event: string;
  label: string;
  direction: "long" | "short" | null;
  openTime: string | null;
  closeTime: string | null;
  triggerPrice: number | null;
  modeledPrice: number | null;
  contracts: number;
  visibility: "machine" | "human_only";
  detail: string;
};

export type VisualValidationRelatedCandle = {
  role: "evaluation" | "patience" | "entry" | "fill" | "exit";
  openTime: string;
  closeTime: string;
  price: number | null;
  visibility: "machine" | "human_only";
};

export type VisualValidationCategoryAnchor = {
  category: VisualValidationCategory;
  auditId: string;
  tradeId: string | null;
  contractSymbol: string;
  openTime: string;
  closeTime: string;
  price: number | null;
  direction: "long" | "short" | null;
  label: string;
  detail: string;
  relatedCandles: VisualValidationRelatedCandle[];
  visibility: "machine" | "human_only";
  occurrenceId?: string;
};

export type VisualValidationCoverage = {
  session: "primary" | "full_regular";
  expectedCandleCount: number;
  observedCandleCount: number;
  complete: boolean;
  missingIntervals: string[];
};

export type VisualValidationSnapshot = {
  snapshotId: string;
  occurrenceId?: string;
  sourceFingerprint?: string;
  sampleIndex: number;
  category: VisualValidationCategory;
  categoryLabel: string;
  machineLabel: string;
  strategyKey: StrategyId;
  formulaHash: string;
  formulaVersion: string;
  symbol: string;
  contractSymbol: string;
  contractMonth: string;
  tradingDate: string;
  entryWindow: VisualValidationEntryWindow;
  selectionReason: string;
  period: "in_sample" | "out_of_sample";
  evaluationCursor: {
    openTime: string;
    closeTime: string;
    newYork: string;
    utc: string;
    visibleCandleCount: number;
    futureCandleAccess: false;
  };
  reviewCursor: {
    closeTime: string;
    newYork: string;
    utc: string;
  };
  machineCandles: VisualValidationCandle[];
  reviewCandles: VisualValidationCandle[];
  premarketCandles: VisualValidationCandle[];
  indicatorSeries: VisualValidationIndicatorPoint[];
  tradeEvents: VisualValidationTradeEvent[];
  coverage: VisualValidationCoverage[];
  outcomeContextEnd: string;
  futureCandleAccess: false;
  categoryAnchor: VisualValidationCategoryAnchor;
  annotations: VisualValidationAnnotation[];
  machineEvidence: {
    quotesAvailable: boolean;
    sourceSchema: "quote_bbo" | "historical_ohlcv";
    audit: BacktestAuditRecord;
    trade: BacktestTrade | null;
    market: {
      levels: MarketSnapshot["levels"];
      breakout: MarketSnapshot["breakout"];
      pullback: MarketSnapshot["pullback"];
      patience: MarketSnapshot["patience"];
      fibonacci: MarketSnapshot["fibonacci"];
      indicators: MarketSnapshot["indicators"];
      trend: MarketSnapshot["trend"];
      majorLevels: MarketSnapshot["majorLevels"];
    };
  };
  review: {
    status: VisualValidationReviewStatus;
    note: string | null;
    reviewedAt: string | null;
  };
};

export type VisualValidationCategoryCoverage = {
  category: VisualValidationCategory;
  label: string;
  count: number;
  available: boolean;
};

export type VisualValidationTradeCandidate = {
  candidateId: string;
  snapshotId: string;
  contractSymbol: string;
  tradingDate: string;
  entryCandleOpenTime: string;
  entryCandleCloseTime: string;
  direction: "long" | "short";
  entryTriggerPrice: number | null;
  primaryEdge: string;
  matchedEdges: string[];
  supportingConfluences: string[];
  setupGrade: "A" | "A+" | "A++";
  period: "in_sample" | "out_of_sample";
  outcome: BacktestTrade["outcome"] | "open";
  causalEvidence: Array<{ kind: "level" | "patience" | "entry"; timestamp: string; detail: string }>;
};

export type VisualValidationReviewPeriod = {
  startDate: string;
  endDate: string;
};

export type VisualValidationSet = {
  reviewSetId: string;
  createdAt: string;
  buildId: string;
  currentBuildId: string;
  stale: boolean;
  formulaHash: string;
  formulaVersion: string;
  sourceFingerprint: string;
  source: "simulated" | "historical_databento";
  symbol: string;
  request: VisualValidationRequest;
  reviewPeriod: VisualValidationReviewPeriod;
  snapshots: VisualValidationSnapshot[];
  tradeCandidates: VisualValidationTradeCandidate[];
  categoryCoverage: VisualValidationCategoryCoverage[];
  defaultSelectionReason: string;
  funnelDiagnostics?: Pick<QualificationFunnel, "sessionCount" | "candidateCount" | "occurrenceCount" | "stages" | "rejectionCounts"> & {
    window: {
      breakoutOccurrences: number;
      qualifyingPullbacks: number;
      patienceCandidates: number;
      expiredPatienceCandidates: number;
      confirmedPairs: number;
      riskApprovedEntries: number;
      primaryWindowOccurrences: number;
      outsidePrimaryWindowOccurrences: number;
    };
  };
};

function buildTradeCandidates(snapshots: VisualValidationSnapshot[]): VisualValidationTradeCandidate[] {
  const canonicalEdgeId = (edge: string): string => ({
    ORB_PULLBACK_CONTINUATION: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
    ORB_BREAK_PULLBACK_CONTINUATION: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
    CONSOLIDATION_BREAKOUT_CONTINUATION: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
  }[edge] ?? edge);
  const candidateById = new Map<string, VisualValidationTradeCandidate>();
  for (const snapshot of snapshots) {
    if (
      snapshot.category !== "qualified_trade"
      || !snapshot.categoryAnchor.direction
      || !snapshot.machineEvidence.trade?.candidateId
      || !snapshot.machineEvidence.trade.signalOccurrenceId
    ) continue;
    const trade = snapshot.machineEvidence.trade;
    const entryOpenTime = trade?.audit?.triggerCandleOpenTime ?? snapshot.categoryAnchor.openTime;
    const entryCloseTime = trade?.audit?.triggerCandleCloseTime ?? snapshot.categoryAnchor.closeTime;
    const candidateId = `${snapshot.contractSymbol}|${snapshot.tradingDate}|${entryOpenTime}|${snapshot.categoryAnchor.direction}`;
    const primaryEdge = canonicalEdgeId(trade?.primaryEdge ?? trade?.setupType ?? snapshot.strategyKey);
    const causalEvidence = snapshot.categoryAnchor.relatedCandles
      .filter((candle) => candle.role === "evaluation" || candle.role === "patience" || candle.role === "entry")
      .map((candle) => ({
        kind: candle.role === "evaluation" ? "level" as const : candle.role === "patience" ? "patience" as const : "entry" as const,
        timestamp: candle.closeTime,
        detail: `${candle.role} candle`,
      }));
    const existing = candidateById.get(candidateId);
    if (!existing) {
      candidateById.set(candidateId, {
        candidateId,
        snapshotId: snapshot.snapshotId,
        contractSymbol: snapshot.contractSymbol,
        tradingDate: snapshot.tradingDate,
        entryCandleOpenTime: entryOpenTime,
        entryCandleCloseTime: entryCloseTime,
        direction: snapshot.categoryAnchor.direction,
        entryTriggerPrice: trade?.audit?.entryTriggerPrice ?? snapshot.categoryAnchor.price,
        primaryEdge,
        matchedEdges: [...new Set((trade?.matchedEdges ?? [primaryEdge]).map(canonicalEdgeId))],
        supportingConfluences: [...new Set(trade?.supportingConfluences ?? [])],
        setupGrade: trade?.setupGrade ?? "A",
        period: snapshot.period,
        outcome: trade?.outcome ?? "open",
        causalEvidence,
      });
    } else {
      existing.matchedEdges = [...new Set([...existing.matchedEdges, ...(trade?.matchedEdges ?? [primaryEdge]).map(canonicalEdgeId)])];
      existing.supportingConfluences = [...new Set([...existing.supportingConfluences, ...(trade?.supportingConfluences ?? [])])];
      existing.causalEvidence = [...existing.causalEvidence, ...causalEvidence.filter((evidence) => !existing.causalEvidence.some((item) => item.timestamp === evidence.timestamp && item.kind === evidence.kind))];
    }
  }
  return [...candidateById.values()];
}

export const VISUAL_VALIDATION_TRADE_CATEGORIES: readonly VisualValidationCategory[] = [
  "qualified_trade",
  "bullish_patience_candle",
  "bearish_patience_candle",
  "strong_breakout",
  "pullback",
  "consolidation",
  "stop_exit",
  "target_exit",
  "runner_exit",
];

export function visualValidationReviewMode(request: Pick<VisualValidationRequest, "reviewMode">): VisualValidationReviewMode {
  return request.reviewMode ?? "trades_only";
}

function reviewPeriodForDataset(
  dataset: Pick<CausalReplayDataset, "inSampleDates" | "outOfSampleDates" | "requestedStartDate" | "requestedEndDate">,
  fallbackDate: string,
): VisualValidationReviewPeriod {
  const selectedDates = [...new Set([...dataset.inSampleDates, ...dataset.outOfSampleDates])].sort();
  return {
    startDate: selectedDates[0] ?? dataset.requestedStartDate ?? fallbackDate,
    endDate: selectedDates.at(-1) ?? dataset.requestedEndDate ?? fallbackDate,
  };
}

export type VisualValidationReview = {
  reviewId: string;
  reviewSetId: string;
  snapshotId: string;
  status: Exclude<VisualValidationReviewStatus, "unreviewed">;
  note: string | null;
  reviewedAt: string;
  teaching?: VisualValidationTeachingExample;
  supersedesReviewId: string | null;
  revision: number;
};

export type VisualValidationTeachingInput = {
  machineTradeId?: string;
  judgment: VisualValidationTeachingJudgment;
  direction: "long" | "short";
  levelCandleOpenTime?: string;
  levelCandleCloseTime?: string;
  entryCandleOpenTime: string;
  entryCandleCloseTime: string;
  patienceCandleOpenTime: string;
  patienceCandleCloseTime: string;
  entryBufferTicks: 8;
  levelToleranceTicks?: number;
  qualifyingLevelId?: string;
  qualifyingLevelRangeLow?: number | null;
  qualifyingLevelRangeHigh?: number | null;
  qualifyingLevels?: Array<{
    levelId: string;
    levelType: "dynamic_indicator" | "fixed_level" | "level_range";
    valueAtInteraction: number;
    sourceTimestamp: string;
    rangeLow: number | null;
    rangeHigh: number | null;
  }>;
  pullbackLevels: number[];
  setupType: VisualValidationTeachingSetup;
  confidence: VisualValidationTeachingConfidence;
  explanation: string;
};

export type VisualValidationTeachingValidation = {
  valid: boolean;
  messages: string[];
  checkedAt: string;
  levelInteractions: VisualValidationLevelInteraction[];
};

export type VisualValidationLevelInteraction = {
  levelId?: string;
  levelName: string;
  levelPrice: number;
  levelRangeLow?: number | null;
  levelRangeHigh?: number | null;
  candleOpenTime?: string;
  candleCloseTime?: string;
  candleHigh: number;
  candleLow: number;
  distanceTicks: number;
  distancePoints: number;
  allowedToleranceTicks: number;
  allowedTolerancePoints: number;
  machineVisible: boolean;
  passed: boolean;
  reason: string;
};

export type ResolvedQualifyingLevel = {
  levelId: string;
  levelType: "dynamic_indicator" | "fixed_level" | "level_range";
  label: string;
  valueAtInteraction: number;
  rangeLow: number | null;
  rangeHigh: number | null;
  sourceTimestamp: string;
  machineVisible: boolean;
  distancePoints: number;
  distanceTicks: number;
  toleranceTicks: number;
  qualifies: boolean;
  reason: string;
};

export type VisualValidationTeachingExample = VisualValidationTeachingInput & {
  teachingId: string;
  calculatedEntryPrice: number;
  validation: VisualValidationTeachingValidation;
  machineEvidenceSnapshot: {
    machineEvidence: VisualValidationSnapshot["machineEvidence"];
    machineCandles: VisualValidationSnapshot["machineCandles"];
    premarketCandles: VisualValidationSnapshot["premarketCandles"];
    evaluationCursor: VisualValidationSnapshot["evaluationCursor"];
    reviewCursor: VisualValidationSnapshot["reviewCursor"];
  };
  machineEvidenceHash: string;
  formulaHash: string;
  formulaVersion: string;
  sourceFingerprint: string;
  supersedesReviewId: string | null;
  createdAt: string;
};

export type VisualValidationProposedRuleAnalysis = {
  analysisId: string;
  reviewSetId: string;
  activeFormulaHash: string;
  activeFormulaVersion: string;
  status: "advisory";
  hypothesis: string;
  likelyCauses: string[];
  supportingExamples: Array<{ reviewId: string; status: string; snapshotId: string; explanation: string }>;
  conflictingExamples: Array<{ reviewId: string; status: string; snapshotId: string; explanation: string }>;
  insufficientEvidence: boolean;
  approvalRequired: true;
  generatedAt: string;
};

const TEACHING_TICK_SIZE = MES_TICK_SIZE;
export { DEFAULT_LEVEL_TOLERANCE_TICKS };

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function localMinute(value: string, timeZone = activeShadowStrategySnapshot().config.sessionTimeZone): number | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

function formatWindowMinute(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function tickAligned(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value / TEACHING_TICK_SIZE - Math.round(value / TEACHING_TICK_SIZE)) < 1e-8;
}

function normalizedLevelTolerance(input: VisualValidationTeachingInput, messages: string[]): number {
  const value = input.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS;
  if (!LEVEL_TOLERANCE_TICKS.includes(value as typeof LEVEL_TOLERANCE_TICKS[number])) {
    messages.push(`Level tolerance must be one of ${LEVEL_TOLERANCE_TICKS.join(", ")} MES ticks.`);
    return DEFAULT_LEVEL_TOLERANCE_TICKS;
  }
  return value;
}

function sameCandle(candidate: VisualValidationCandle | undefined, openTime: string, closeTime: string): boolean {
  return candidate?.openTime === openTime && candidate.closeTime === closeTime;
}

export function resolveQualifyingLevelAtCandle(
  snapshot: VisualValidationSnapshot,
  levelCandle: VisualValidationCandle,
  levelId: string,
  toleranceTicks: number = DEFAULT_LEVEL_TOLERANCE_TICKS,
): ResolvedQualifyingLevel {
  const annotation = snapshot.annotations.find((item) => item.id === levelId);
  const indicator = levelId === "vwap" || levelId === "ema-200"
    ? snapshot.indicatorSeries.find((point) => point.openTime === levelCandle.openTime && point.closeTime === levelCandle.closeTime)
    : undefined;
  const dynamic = levelId === "vwap" || levelId === "ema-200";
  const valueAtInteraction = dynamic
    ? levelId === "vwap" ? indicator?.vwap ?? Number.NaN : indicator?.ema200 ?? Number.NaN
    : annotation?.price ?? Number.NaN;
  const rangeLow = dynamic ? null : annotation?.rangeLow ?? null;
  const rangeHigh = dynamic ? null : annotation?.rangeHigh ?? null;
  const sourceTimestamp = indicator?.openTime ?? annotation?.openTime ?? levelCandle.openTime;
  const machineVisible = Boolean(annotation?.available && annotation.visibility === "machine")
    && (!dynamic || indicator?.visibility === "machine");
  const distancePoints = Number.isFinite(valueAtInteraction)
    ? levelInteractionDistance(valueAtInteraction, levelCandle.high, levelCandle.low, rangeLow, rangeHigh)
    : Number.POSITIVE_INFINITY;
  const tolerancePoints = levelTolerancePoints(toleranceTicks);
  const interaction = qualifyLevelInteraction(distancePoints, tolerancePoints, TEACHING_TICK_SIZE);
  const qualifies = machineVisible && interaction.qualifies;
  const reason = !annotation
    ? `Level ${levelId} is not present in the immutable snapshot.`
    : !machineVisible
      ? `${annotation.label} is not machine-visible at L.`
      : !Number.isFinite(valueAtInteraction)
        ? `${annotation.label} has no causal value at L.`
        : qualifies
          ? `${annotation.label} at ${valueAtInteraction.toFixed(3)} is within ${interaction.distanceTicks} ticks at L.`
          : `Patience candle remained ${interaction.distanceTicks} ticks from ${annotation.label}.`;
  return {
    levelId,
    levelType: dynamic ? "dynamic_indicator" : annotation?.kind === "level" && (rangeLow !== null || rangeHigh !== null) ? "level_range" : "fixed_level",
    label: annotation?.label ?? levelId,
    valueAtInteraction,
    rangeLow,
    rangeHigh,
    sourceTimestamp,
    machineVisible,
    distancePoints,
    distanceTicks: interaction.distanceTicks,
    toleranceTicks,
    qualifies,
    reason,
  };
}

export function validateVisualValidationTeaching(
  snapshot: VisualValidationSnapshot,
  input: VisualValidationTeachingInput,
): VisualValidationTeachingValidation & { calculatedEntryPrice: number } {
  const messages: string[] = [];
  const entryWindowConfig = activeShadowStrategySnapshot().config;
  const levelInteractions: VisualValidationLevelInteraction[] = [];
  const levelToleranceTicks = normalizedLevelTolerance(input, messages);
  const levelTolerancePointsValue = levelTolerancePoints(levelToleranceTicks);
  const evaluationClose = Date.parse(snapshot.evaluationCursor.closeTime);
  const entry = snapshot.reviewCandles.find((candle) => sameCandle(candle, input.entryCandleOpenTime, input.entryCandleCloseTime));
  const patience = snapshot.reviewCandles.find((candle) => sameCandle(candle, input.patienceCandleOpenTime, input.patienceCandleCloseTime));
  const levelOpenTime = input.levelCandleOpenTime ?? input.patienceCandleOpenTime;
  const levelCloseTime = input.levelCandleCloseTime ?? input.patienceCandleCloseTime;
  const levelCandle = snapshot.reviewCandles.find((candle) => sameCandle(candle, levelOpenTime, levelCloseTime));
  const entryIndex = snapshot.reviewCandles.findIndex((candle) => sameCandle(candle, input.entryCandleOpenTime, input.entryCandleCloseTime));
  const patienceIndex = snapshot.reviewCandles.findIndex((candle) => sameCandle(candle, input.patienceCandleOpenTime, input.patienceCandleCloseTime));
  const levelIndex = snapshot.reviewCandles.findIndex((candle) => sameCandle(candle, levelOpenTime, levelCloseTime));
  const previous = patienceIndex > 0 ? snapshot.reviewCandles[patienceIndex - 1] : undefined;
  const calculatedEntryPrice = patience
    ? input.direction === "long"
      ? Number((patience.high + input.entryBufferTicks * TEACHING_TICK_SIZE).toFixed(2))
      : Number((patience.low - input.entryBufferTicks * TEACHING_TICK_SIZE).toFixed(2))
    : Number.NaN;

  if (!entry || !patience || !levelCandle) messages.push("Choose exact L (level), P (patience), and immediate-next E (entry) candles from this snapshot.");
  if (input.levelCandleOpenTime !== undefined && input.levelCandleCloseTime === undefined) messages.push("The qualifying level candle must include both open and close timestamps.");
  if (input.levelCandleCloseTime !== undefined && input.levelCandleOpenTime === undefined) messages.push("The qualifying level candle must include both open and close timestamps.");
  if (levelCandle && !levelCandle.isComplete) messages.push("The qualifying level candle must be completed.");
  if (entry && !entry.isComplete) messages.push("The locked entry candle must be completed.");
  if (patience && !patience.isComplete) messages.push("The patience candle must be completed.");
  if (entry && patience && Date.parse(entry.openTime) !== Date.parse(patience.closeTime)) {
    messages.push("The entry candle must be the immediate-next candle after patience (E opens when P closes).");
  }
  if (entryIndex < 0 || patienceIndex < 0) messages.push("The selected candles must be exact observed candles, not a reconstructed or future slot.");
  if (levelIndex < 0) messages.push("The qualifying level candle must be an exact observed candle, not a reconstructed or future slot.");
  if (levelIndex > patienceIndex && patienceIndex >= 0) messages.push("The qualifying level candle L must occur at or before patience candle P.");
  if (levelIndex >= 0 && patienceIndex >= 0 && patienceIndex - levelIndex > 6) messages.push("L to P consolidation cannot exceed six completed five-minute candles (30 minutes).");
  if (levelCandle && patience && levelIndex >= 0 && patienceIndex >= 0 && levelIndex < patienceIndex) {
    const between = snapshot.reviewCandles.slice(levelIndex, patienceIndex + 1);
    if (between.some((candle) => !candle.isComplete)) messages.push("Every candle from L through P must be completed.");
    for (let index = 1; index < between.length; index += 1) {
      if (Date.parse(between[index]!.openTime) !== Date.parse(between[index - 1]!.closeTime)) {
        messages.push("L to P consolidation must use contiguous five-minute candles; a missing candle invalidates the sequence.");
        break;
      }
    }
    if (between.some((candle) => candle.contractSymbol !== snapshot.contractSymbol)) messages.push("Every L to P consolidation candle must belong to the snapshot's active MES contract.");
  }
  if (entry && (!Number.isFinite(evaluationClose) || Date.parse(entry.closeTime) > evaluationClose)) {
    messages.push("The entry candle is beyond the machine evaluation boundary and is not causally visible.");
  }
  if (patience && (!Number.isFinite(evaluationClose) || Date.parse(patience.closeTime) > evaluationClose)) {
    messages.push("The patience candle is beyond the machine evaluation boundary and uses future data.");
  }
  if (levelCandle && (!Number.isFinite(evaluationClose) || Date.parse(levelCandle.closeTime) > evaluationClose)) {
    messages.push("The qualifying level candle is beyond the machine evaluation boundary and uses future data.");
  }
  const entryMinute = entry ? localMinute(entry.openTime, entryWindowConfig.sessionTimeZone) : null;
  const entryCloseMinute = entry ? localMinute(entry.closeTime, entryWindowConfig.sessionTimeZone) : null;
  if (entryMinute === null || entryCloseMinute === null || entryMinute < entryWindowConfig.primaryEntryStartMinutes || entryCloseMinute > entryWindowConfig.primaryEntryEndMinutes) {
    messages.push(`The entry candle must be inside the ${formatWindowMinute(entryWindowConfig.primaryEntryStartMinutes)}–${formatWindowMinute(entryWindowConfig.primaryEntryEndMinutes)} ET primary entry window.`);
  }
  if (entry && entry.contractSymbol !== snapshot.contractSymbol) messages.push("The entry candle must belong to the snapshot's active MES contract.");
  if (patience && previous && input.direction === "long" && patience.high > previous.high) messages.push("Long patience must contain its high within the preceding completed candle.");
  if (patience && previous && input.direction === "short" && patience.low < previous.low) messages.push("Short patience must contain its low within the preceding completed candle.");
  if (!previous) messages.push("A preceding completed candle is required to validate patience containment.");
  const pullbackLevels = [...new Set(input.pullbackLevels.filter(Number.isFinite))];
  const structuredLevels = input.qualifyingLevels ?? [];
  if (!pullbackLevels.length && !structuredLevels.length) messages.push("Choose at least one qualifying pullback level.");
  const requestedLevelId = input.qualifyingLevelId;
  const selectedAnnotation = requestedLevelId
    ? snapshot.annotations.find((annotation) => annotation.id === requestedLevelId)
    : undefined;
  if (requestedLevelId && (!selectedAnnotation || !selectedAnnotation.available || selectedAnnotation.visibility !== "machine")) {
    messages.push("The selected qualifying level ID is not machine-visible at the causal evaluation time.");
  }
  const legacyAnnotations = pullbackLevels.flatMap((level) => snapshot.annotations
    .filter((item) => item.available && item.price !== null && item.kind !== "candle" && Math.abs(item.price - level) <= TEACHING_TICK_SIZE + 1e-8)
    .filter((item) => !requestedLevelId || item.id === requestedLevelId)
    .sort((first, second) => Math.abs(first.price! - level) - Math.abs(second.price! - level))
    .slice(0, 1)
    .map((annotation) => ({ annotation, level })));
  if (legacyAnnotations.length !== pullbackLevels.length && !structuredLevels.length) {
    messages.push("A selected qualifying level was not present in the machine-visible snapshot at the evaluation time.");
  }
  const levelSelections = structuredLevels.length
    ? structuredLevels.map((selection) => ({ selection, resolved: levelCandle ? resolveQualifyingLevelAtCandle(snapshot, levelCandle, selection.levelId, levelToleranceTicks) : null }))
    : legacyAnnotations.map(({ annotation, level }) => ({
        selection: null,
        resolved: levelCandle
          ? (() => {
              const resolved = resolveQualifyingLevelAtCandle(snapshot, levelCandle, annotation.id, levelToleranceTicks);
              if (annotation.id === "vwap" || annotation.id === "ema-200") return resolved;
              const interaction = qualifyLevelInteraction(
                levelInteractionDistance(level, levelCandle.high, levelCandle.low, annotation.rangeLow, annotation.rangeHigh),
                levelTolerancePointsValue,
                TEACHING_TICK_SIZE,
              );
              return {
                ...resolved,
                valueAtInteraction: level,
                ...interaction,
                qualifies: resolved.machineVisible && interaction.qualifies,
                rangeLow: annotation.rangeLow ?? null,
                rangeHigh: annotation.rangeHigh ?? null,
              };
            })()
          : null,
      }));
  const dynamicStructuredValues = structuredLevels
    .filter((selection) => selection.levelType === "dynamic_indicator")
    .map((selection) => levelCandle ? resolveQualifyingLevelAtCandle(snapshot, levelCandle, selection.levelId, levelToleranceTicks).valueAtInteraction : Number.NaN)
    .filter(Number.isFinite);
  const legacyLevelsForTickValidation = structuredLevels.length
    ? pullbackLevels.filter((level) => !dynamicStructuredValues.some((dynamicValue) => Math.abs(dynamicValue - level) <= 1e-9))
    : pullbackLevels;
  if (legacyLevelsForTickValidation.some((level) => !tickAligned(level))) messages.push("Every executable fixed qualifying pullback level must be aligned to the MES 0.25 tick.");
  for (const { selection, resolved } of levelSelections) {
    if (!resolved) continue;
    if (selection) {
      if (Math.abs(selection.valueAtInteraction - resolved.valueAtInteraction) > 1e-9) messages.push(`Submitted value for ${selection.levelId} disagrees with the immutable causal value at L.`);
      if ((selection.sourceTimestamp !== resolved.sourceTimestamp) || selection.rangeLow !== resolved.rangeLow || selection.rangeHigh !== resolved.rangeHigh) messages.push(`Submitted evidence for ${selection.levelId} disagrees with the immutable causal level range or timestamp.`);
      if (selection.levelType !== resolved.levelType) messages.push(`Submitted level type for ${selection.levelId} disagrees with the immutable annotation.`);
      if (resolved.levelType === "dynamic_indicator" && (selection.rangeLow !== null || selection.rangeHigh !== null)) messages.push(`Dynamic indicator ${selection.levelId} cannot submit a client-defined range.`);
    }
    const passed = resolved.qualifies;
    const levelName = resolved.label;
    levelInteractions.push({
      levelId: resolved.levelId,
      levelName,
      levelPrice: resolved.valueAtInteraction,
      levelRangeLow: resolved.rangeLow,
      levelRangeHigh: resolved.rangeHigh,
      candleOpenTime: levelCandle!.openTime,
      candleCloseTime: levelCandle!.closeTime,
      candleHigh: levelCandle!.high,
      candleLow: levelCandle!.low,
      distanceTicks: resolved.distanceTicks,
      distancePoints: Number(resolved.distancePoints.toFixed(2)),
      allowedToleranceTicks: levelToleranceTicks,
      allowedTolerancePoints: levelTolerancePointsValue,
      machineVisible: resolved.machineVisible,
      passed,
      reason: resolved.reason,
    });
    if (!passed || !resolved.machineVisible) messages.push(resolved.reason);
  }
  const indicatorAtLevel = levelCandle
    ? snapshot.indicatorSeries.find((point) => point.openTime === levelCandle.openTime && point.closeTime === levelCandle.closeTime)
    : undefined;
  const needsIndicatorEvidence = structuredLevels.some((selection) => selection.levelType === "dynamic_indicator")
    || input.qualifyingLevelId === "vwap" || input.qualifyingLevelId === "ema-200";
  if (needsIndicatorEvidence) {
    if (!indicatorAtLevel) messages.push("No causal VWAP/EMA 200 indicator point exists at the qualifying level candle.");
    else if (indicatorAtLevel.visibility !== "machine") messages.push("VWAP and EMA 200 at L are not causally machine-visible.");
  }
  if (entry && Number.isFinite(calculatedEntryPrice)) {
    const buffered = input.direction === "long" ? entry.high >= calculatedEntryPrice : entry.low <= calculatedEntryPrice;
    if (!buffered) messages.push(`The immediate-next candle did not reach the calculated ${input.entryBufferTicks}-tick MES entry buffer.`);
  }
  if (input.entryBufferTicks !== 8) messages.push("The entry buffer must be exactly eight MES ticks (2.00 index points).");
  if (!input.explanation.trim() || input.explanation.trim().length < 10) messages.push("Explain the teaching example in at least 10 characters.");

  return {
    valid: messages.length === 0,
    messages,
    calculatedEntryPrice,
    checkedAt: new Date().toISOString(),
    levelInteractions,
  };
}

export function createVisualValidationTeachingExample(
  snapshot: VisualValidationSnapshot,
  input: VisualValidationTeachingInput,
  supersedesReviewId: string | null,
): VisualValidationTeachingExample {
  const validation = validateVisualValidationTeaching(snapshot, input);
  const machineEvidenceSnapshot = structuredClone({
    machineEvidence: snapshot.machineEvidence,
    machineCandles: snapshot.machineCandles,
    premarketCandles: snapshot.premarketCandles,
    evaluationCursor: snapshot.evaluationCursor,
    reviewCursor: snapshot.reviewCursor,
  });
  return {
    ...input,
    levelCandleOpenTime: input.levelCandleOpenTime ?? input.patienceCandleOpenTime,
    levelCandleCloseTime: input.levelCandleCloseTime ?? input.patienceCandleCloseTime,
    levelToleranceTicks: input.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS,
    pullbackLevels: [...new Set(validation.levelInteractions
      .filter((interaction) => interaction.passed && interaction.levelId !== "vwap" && interaction.levelId !== "ema-200")
      .map((interaction) => interaction.levelPrice)
      .filter(tickAligned))].sort((a, b) => a - b),
    qualifyingLevels: validation.levelInteractions
      .filter((interaction) => interaction.passed)
      .map((interaction) => ({
        levelId: interaction.levelId ?? "",
        levelType: interaction.levelId === "vwap" || interaction.levelId === "ema-200" ? "dynamic_indicator" as const : interaction.levelRangeLow !== null || interaction.levelRangeHigh !== null ? "level_range" as const : "fixed_level" as const,
        valueAtInteraction: interaction.levelPrice,
        sourceTimestamp: interaction.candleOpenTime ?? input.levelCandleOpenTime ?? input.patienceCandleOpenTime,
        rangeLow: interaction.levelRangeLow ?? null,
        rangeHigh: interaction.levelRangeHigh ?? null,
      })),
    teachingId: randomUUID(),
    calculatedEntryPrice: validation.calculatedEntryPrice,
    validation: {
      valid: validation.valid,
      messages: validation.messages,
      checkedAt: validation.checkedAt,
      levelInteractions: validation.levelInteractions,
    },
    machineEvidenceSnapshot,
    machineEvidenceHash: hashJson(machineEvidenceSnapshot),
    formulaHash: snapshot.formulaHash,
    formulaVersion: snapshot.formulaVersion,
    sourceFingerprint: hashJson({
      symbol: snapshot.symbol,
      contractSymbol: snapshot.contractSymbol,
      tradingDate: snapshot.tradingDate,
      machineCandles: snapshot.machineCandles,
    }),
    supersedesReviewId,
    createdAt: new Date().toISOString(),
  };
}

export function buildProposedRuleAnalysis(
  reviewSetId: string,
  formulaHash: string,
  formulaVersion: string,
  reviews: readonly VisualValidationReview[],
  focusTeachingId?: string,
): VisualValidationProposedRuleAnalysis {
  const teachingReviews = reviews.filter((review) => review.teaching || review.status === "false_positive_trade");
  const focus = focusTeachingId ? teachingReviews.find((review) => review.teaching?.teachingId === focusTeachingId) : teachingReviews.at(-1);
  const focusTeaching = focus?.teaching;
  const likelyCauses = new Set<string>();
  for (const review of teachingReviews) {
    if (review.teaching && !review.teaching.validation.valid) likelyCauses.add("The proposed sequence does not satisfy the immediate-next or causal visibility boundary.");
    if (review.teaching?.entryBufferTicks !== 8) likelyCauses.add("Reviewers are testing a non-governed confirmation buffer against the active eight-tick formula.");
    if (review.status === "false_positive_trade") likelyCauses.add("A machine-qualified trade may be over-inclusive around level interaction or candle containment.");
  }
  if (!likelyCauses.size) likelyCauses.add("There are not yet enough structured teaching examples to isolate a rule difference.");
  const examples = teachingReviews.map((review) => ({
    reviewId: review.reviewId,
    status: review.status,
    snapshotId: review.snapshotId,
    explanation: review.teaching?.explanation ?? review.note ?? "No explanation supplied.",
  }));
  const supportingExamples = examples.filter((example) =>
    focusTeaching ? example.status === focus?.status && example.status !== "false_positive_trade" : example.status === "missed_trade",
  ).slice(0, 12);
  const conflictingExamples = examples.filter((example) => !supportingExamples.some((item) => item.reviewId === example.reviewId)).slice(0, 12);
  return {
    analysisId: randomUUID(),
    reviewSetId,
    activeFormulaHash: formulaHash,
    activeFormulaVersion: formulaVersion,
    status: "advisory",
    hypothesis: focusTeaching
      ? `${focusTeaching.judgment.replaceAll("_", " ")} examples suggest reviewing ${focusTeaching.direction} confirmation at ${focusTeaching.entryBufferTicks} ticks around ${focusTeaching.setupType}.`
      : "Review structured teaching examples before proposing a rule change.",
    likelyCauses: [...likelyCauses],
    supportingExamples,
    conflictingExamples,
    insufficientEvidence: teachingReviews.length < 2 || supportingExamples.length === 0,
    approvalRequired: true,
    generatedAt: new Date().toISOString(),
  };
}

export type VisualValidationDiscrepancyReport = {
  reviewSetId: string;
  generatedAt: string;
  formulaHash: string;
  totalSnapshots: number;
  reviewedSnapshots: number;
  reviews: Array<{
    snapshotId: string;
    category: VisualValidationCategory;
    categoryLabel: string;
    machineLabel: string;
    reviewerStatus: Exclude<VisualValidationReviewStatus, "unreviewed">;
    note: string | null;
    tradingDate: string;
    evaluationCursor: VisualValidationSnapshot["evaluationCursor"];
    machineEvidence: {
      decision: string;
      rejectionCategory: string;
      setupType: string;
      direction: string | null;
      eventLabels: string[];
      ambiguityLabels: string[];
    };
  }>;
  discrepancies: Array<{
    snapshotId: string;
    category: VisualValidationCategory;
    categoryLabel: string;
    machineLabel: string;
    reviewerStatus: Exclude<VisualValidationReviewStatus, "unreviewed">;
    note: string | null;
    tradingDate: string;
    evaluationCursor: VisualValidationSnapshot["evaluationCursor"];
    machineEvidence: {
      decision: string;
      rejectionCategory: string;
      setupType: string;
      direction: string | null;
      eventLabels: string[];
      ambiguityLabels: string[];
    };
  }>;
  reviewHistory: VisualValidationReview[];
};

const categoryLabels: Record<VisualValidationCategory, string> = {
  qualified_trade: "Qualified trades",
  rejected_setup: "Rejected setups",
  bullish_patience_candle: "Bullish patience candles",
  bearish_patience_candle: "Bearish patience candles",
  weak_orb_probe: "Weak ORB probes",
  strong_breakout: "Strong breakouts",
  pullback: "Pullbacks",
  consolidation: "Consolidation setups",
  ambiguous_candle: "Ambiguous candles",
  stop_exit: "Stops",
  target_exit: "Targets",
  runner_exit: "Runner exits",
};

const categoryOrder = new Map(VISUAL_VALIDATION_CATEGORIES.map((category, index) => [category, index]));

function formatTime(timestamp: number, timeZone: "America/New_York" | "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(timestamp));
}

function safeDate(timestamp: number | null): string | null {
  return timestamp === null || !Number.isFinite(timestamp) ? null : new Date(timestamp).toISOString();
}

function evidenceNumber(value: Record<string, number | boolean> | null, key: string): number | null {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function evidenceTime(value: Record<string, number | boolean> | null, key: string): number | null {
  const candidate = value?.[key];
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string") {
    const parsed = Date.parse(candidate);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toRawCandle(candle: SimulatedFuturesCandle): VisualValidationCandle {
  return {
    openTime: new Date(candle.openTime).toISOString(),
    closeTime: new Date(candle.closeTime).toISOString(),
    timestamp: new Date(candle.timestamp).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    bid: candle.bid,
    ask: candle.ask,
    bidSize: candle.bidSize,
    askSize: candle.askSize,
    contractSymbol: candle.contractSymbol,
    isComplete: candle.isComplete,
  };
}

export function matchingTrade(record: BacktestAuditRecord, trades: readonly BacktestTrade[]): BacktestTrade | null {
  const candidates = trades.filter((trade) =>
    trade.tradingDate === record.tradingDate
    && trade.contractSymbol === record.contractSymbol
    && canonicalStrategyId(trade.setupType) === canonicalStrategyId(record.setupType)
    && trade.direction === record.direction
     && trade.period === record.period
     && tradeEntryIsBeforePrimaryCutoff(trade),
  );
  const causalMatches = candidates.filter((trade) => {
    const tradeAudit = trade.audit;
    if (!tradeAudit) return false;
    const exactPairs: Array<[string | null, string | null]> = [
      [record.patienceCandleOpenTime, tradeAudit?.patienceCandleOpenTime ?? null],
      [record.patienceCandleCloseTime, tradeAudit?.patienceCandleCloseTime ?? null],
      [record.triggerCandleOpenTime, tradeAudit?.triggerCandleOpenTime ?? null],
      [record.triggerCandleCloseTime, tradeAudit.triggerCandleCloseTime ?? null],
      [record.modeledFillObservationTime, tradeAudit.modeledFillObservationTime ?? null],
      [record.exitCandleOpenTime, tradeAudit.exitCandleOpenTime ?? null],
      [record.exitCandleCloseTime, tradeAudit.exitCandleCloseTime ?? null],
    ];
    const causalPairs = exactPairs.slice(0, 4);
    const optionalPairs = exactPairs.slice(4);
    return causalPairs.every(([recordValue, tradeValue]) => recordValue === tradeValue)
      && optionalPairs.every(([recordValue, tradeValue]) =>
        recordValue === null || tradeValue === null || recordValue === tradeValue);
  });
  return causalMatches.length === 1 ? causalMatches[0]! : null;
}

function matchingTradeForOccurrence(
  occurrence: HistoricalOccurrence,
  record: BacktestAuditRecord,
  tradeCandidates: readonly HistoricalTradeCandidate[],
  trades: readonly BacktestTrade[],
): BacktestTrade | null {
  const candidate = tradeCandidates.find((item) => item.signalOccurrenceId === occurrence.occurrenceId);
  if (candidate) {
    const exact = trades.filter((trade) => isAuthoritativeCandidateTrade(occurrence, candidate, trade));
    return exact.length === 1 ? exact[0]! : null;
  }
  const entryOpen = occurrence.eOpenTimestamp ?? occurrence.entryTimestamp;
  if (!occurrence.patienceTimestamp || !entryOpen) return null;
  if (primaryEntryOpenIsLate(Date.parse(entryOpen))) return null;
  const candidates = trades.filter((trade) =>
    trade.tradingDate === occurrence.tradingDate
    && trade.contractSymbol === occurrence.contractSymbol
    && canonicalStrategyId(trade.setupType) === canonicalStrategyId(occurrence.strategyCandidate)
    && trade.direction === occurrence.direction
    && trade.period === record.period
    && trade.audit?.patienceCandleOpenTime === occurrence.patienceTimestamp
    && trade.audit?.triggerCandleOpenTime === entryOpen,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

function isAuthoritativeCandidateTrade(
  occurrence: HistoricalOccurrence,
  candidate: HistoricalTradeCandidate,
  trade: BacktestTrade,
): boolean {
  const valid = candidate.executionStatus === "MODELED_TRADE_CREATED"
    && candidate.entryReachedThreshold === true
    && candidate.direction === occurrence.direction
    && candidate.contractSymbol === occurrence.contractSymbol
    && candidate.tradingDate === occurrence.tradingDate
    && candidate.pOpenTimestamp === occurrence.pOpenTimestamp
    && candidate.eOpenTimestamp === occurrence.eOpenTimestamp
    && candidate.patienceTimestamp === occurrence.patienceTimestamp
    && candidate.expectedEntryTimestamp === occurrence.expectedEntryTimestamp
    && candidate.entryObservationTimestamp === occurrence.entryObservationTimestamp
    && trade.candidateId === candidate.candidateId
    && trade.signalOccurrenceId === occurrence.occurrenceId
    && trade.direction === candidate.direction
    && trade.contractSymbol === candidate.contractSymbol
    && trade.tradingDate === candidate.tradingDate
    && trade.entryPrice === candidate.confirmationPrice
    && trade.audit?.entryTriggerPrice === candidate.confirmationPrice
    && trade.audit?.modeledFillPrice === candidate.confirmationPrice
    && trade.audit?.triggerCandleOpenTime === candidate.eOpenTimestamp
    && trade.audit?.modeledFillObservationTime === candidate.entryObservationTimestamp
    && trade.entryTime === candidate.entryObservationTimestamp;
  return valid;
}

function primaryEntryOpenIsLate(timestamp: number): boolean {
  return Number.isFinite(timestamp)
    && wallClockMinutesForTimestamp(timestamp, "America/New_York") >= 13 * 60;
}

function tradeEntryIsBeforePrimaryCutoff(trade: BacktestTrade): boolean {
  const entryOpen = trade.audit?.triggerCandleOpenTime
    ? Date.parse(trade.audit.triggerCandleOpenTime)
    : Date.parse(trade.entryTime);
  return Number.isFinite(entryOpen) && !primaryEntryOpenIsLate(entryOpen);
}

function auditForOccurrence(
  occurrence: HistoricalOccurrence,
  audits: readonly BacktestAuditRecord[],
  trades: readonly BacktestTrade[],
): BacktestAuditRecord | undefined {
  const patienceTimestamp = occurrence.patienceTimestamp;
  const entryTimestamp = occurrence.entryTimestamp;
  if (patienceTimestamp && entryTimestamp) {
    const exact = audits
      .filter((audit) =>
        audit.tradingDate === occurrence.tradingDate
        && audit.contractSymbol === occurrence.contractSymbol
        && audit.patienceCandleOpenTime === patienceTimestamp
        && audit.triggerCandleOpenTime === entryTimestamp,
      )
      .sort((first, second) => Date.parse(first.evaluatedCandleOpenTime) - Date.parse(second.evaluatedCandleOpenTime));
    const tradeAudit = exact.find((audit) => matchingTrade(audit, trades) !== null);
    if (tradeAudit) return tradeAudit;
    if (exact[0]) return exact[0];
  }
  return audits.find((candidate) => candidate.id === occurrence.auditId);
}

type AnchorEvent = {
  role: VisualValidationRelatedCandle["role"];
  openTime: string | null;
  closeTime: string | null;
  price: number | null;
};

function rawCandleForCloseTime(
  candles: readonly SimulatedFuturesCandle[],
  value: string | null | undefined,
): SimulatedFuturesCandle | null {
  const target = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(target)) return null;
  return candles.find((candle) => candle.closeTime === target) ?? null;
}

function rawCandleForOpenTime(
  candles: readonly SimulatedFuturesCandle[],
  value: string | null | undefined,
): SimulatedFuturesCandle | null {
  const target = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(target)) return null;
  return candles.find((candle) => candle.openTime === target) ?? null;
}

function auditEvent(
  role: AnchorEvent["role"],
  openTime: string | null | undefined,
  closeTime: string | null | undefined,
  price: number | null,
): AnchorEvent {
  return { role, openTime: openTime ?? null, closeTime: closeTime ?? null, price };
}

function categoryAnchorEvent(
  category: VisualValidationCategory,
  audit: BacktestAuditRecord,
  trade: BacktestTrade | null,
  occurrence?: HistoricalOccurrence,
): AnchorEvent {
  if (occurrence) {
    if (category === "pullback" && occurrence.lTimestamp) {
      return auditEvent("evaluation", occurrence.lTimestamp, occurrence.lTimestamp, Object.values(occurrence.levelValues)[0] ?? null);
    }
    if ((category === "bullish_patience_candle" || category === "bearish_patience_candle") && occurrence.patienceTimestamp) {
      return auditEvent("patience", occurrence.patienceTimestamp, occurrence.patienceTimestamp, evidenceNumber(occurrence.patienceCandle, "close"));
    }
    if (category === "qualified_trade" && occurrence.entryTimestamp) {
      return auditEvent("entry", occurrence.entryTimestamp, occurrence.entryTimestamp, evidenceNumber(occurrence.entryCandle, "close"));
    }
  }
  const evaluationClose = new Date(Date.parse(audit.evaluatedCandleOpenTime) + 5 * 60_000).toISOString();
  const evaluation = auditEvent("evaluation", audit.evaluatedCandleOpenTime, evaluationClose, audit.entryTriggerPrice);
  const patience = auditEvent("patience", audit.patienceCandleOpenTime, audit.patienceCandleCloseTime, evidenceNumber(audit.patienceCandle, "close"));
  const entry = auditEvent("entry", audit.triggerCandleOpenTime, audit.triggerCandleCloseTime, evidenceNumber(audit.triggerCandle, "close") ?? audit.entryTriggerPrice);
  const fillTime = audit.modeledFillObservationTime ?? trade?.audit?.modeledFillObservationTime ?? null;
  const fill = auditEvent("fill", fillTime, fillTime, trade?.audit?.modeledFillPrice ?? trade?.entryPrice ?? null);
  const exitOpen = audit.exitCandleOpenTime ?? trade?.audit?.exitCandleOpenTime ?? null;
  const exitClose = audit.exitCandleCloseTime ?? trade?.audit?.exitCandleCloseTime ?? null;
  const exit = auditEvent("exit", exitOpen, exitClose, trade?.exitPrice ?? audit.targetPrice);
  if (category === "bullish_patience_candle" || category === "bearish_patience_candle") return patience;
  if (category === "strong_breakout" || category === "qualified_trade") return entry;
  if (category === "stop_exit" || category === "target_exit" || category === "runner_exit") return exit;
  return evaluation;
}

const anchorLabels: Record<VisualValidationCategory, string> = {
  qualified_trade: "Confirmed edge / trade found",
  rejected_setup: "Rejected setup found",
  bullish_patience_candle: "Bullish patience candle found",
  bearish_patience_candle: "Bearish patience candle found",
  weak_orb_probe: "Weak ORB probe found",
  strong_breakout: "Strong breakout found",
  pullback: "Pullback interaction found",
  consolidation: "Consolidation setup found",
  ambiguous_candle: "Ambiguous candle found",
  stop_exit: "Stop exit found",
  target_exit: "Target exit found",
  runner_exit: "Runner exit found",
};

function anchorDetail(category: VisualValidationCategory, audit: BacktestAuditRecord, occurrence?: HistoricalOccurrence): string {
  if (occurrence) return `${occurrence.reasonCode} (occurrence ${occurrence.occurrenceId}).`;
  if (category === "bullish_patience_candle" || category === "bearish_patience_candle") {
    return `${audit.direction === "long" ? "Bullish" : "Bearish"} patience candle from the immutable audit record.`;
  }
  if (category === "weak_orb_probe") return "ORB probe and wait state from the immutable audit record.";
  if (category === "strong_breakout") return "Confirmed breakout event from the immutable audit record.";
  if (category === "pullback") return "Mapped pullback interaction from the immutable audit record.";
  if (category === "consolidation") return "Completed consolidation state from the immutable audit record.";
  if (category === "ambiguous_candle") return audit.ambiguityLabels.join(", ") || "Ambiguity event from the immutable audit record.";
  if (category === "stop_exit" || category === "target_exit" || category === "runner_exit") {
    return `${category.replaceAll("_", " ")} outcome linked to the exact exit candle.`;
  }
  return audit.rejectionSummary ?? audit.decision;
}

function resolvedAnchorCandle(
  event: AnchorEvent,
  candles: readonly SimulatedFuturesCandle[],
): SimulatedFuturesCandle | null {
  return event.openTime
    ? rawCandleForOpenTime(candles, event.openTime)
    : rawCandleForCloseTime(candles, event.closeTime);
}

export function buildCategoryAnchor(
  category: VisualValidationCategory,
  audit: BacktestAuditRecord,
  trade: BacktestTrade | null,
  candles: readonly SimulatedFuturesCandle[],
  occurrence?: HistoricalOccurrence,
  causalCloseTime?: number,
  completeContractCandles?: readonly SimulatedFuturesCandle[],
): VisualValidationCategoryAnchor | null {
  const contractCandles = completeContractCandles
    ? [...completeContractCandles]
    : candles.filter((candle) => candle.contractSymbol === audit.contractSymbol && candle.isComplete);
  const anchorEvent = categoryAnchorEvent(category, audit, trade, occurrence);
  const anchorCandle = resolvedAnchorCandle(anchorEvent, contractCandles);
  if (!anchorCandle) return null;
  const relatedEvents = occurrence
    ? [
        auditEvent("evaluation", occurrence.lTimestamp, occurrence.lTimestamp, Object.values(occurrence.levelValues)[0] ?? null),
        auditEvent("patience", occurrence.patienceTimestamp, occurrence.patienceTimestamp, evidenceNumber(occurrence.patienceCandle, "close")),
        auditEvent("entry", occurrence.entryTimestamp, occurrence.entryTimestamp, evidenceNumber(occurrence.entryCandle, "close")),
      ]
    : [
        auditEvent("evaluation", audit.evaluatedCandleOpenTime, null, audit.entryTriggerPrice),
        auditEvent("patience", audit.patienceCandleOpenTime, audit.patienceCandleCloseTime, evidenceNumber(audit.patienceCandle, "close")),
        auditEvent("entry", audit.triggerCandleOpenTime, audit.triggerCandleCloseTime, evidenceNumber(audit.triggerCandle, "close") ?? audit.entryTriggerPrice),
        auditEvent("fill", audit.modeledFillObservationTime ?? trade?.audit?.modeledFillObservationTime, null, trade?.audit?.modeledFillPrice ?? trade?.entryPrice ?? null),
        auditEvent("exit", audit.exitCandleOpenTime ?? trade?.audit?.exitCandleOpenTime, audit.exitCandleCloseTime ?? trade?.audit?.exitCandleCloseTime, trade?.exitPrice ?? audit.targetPrice),
      ];
  const evaluationClose = causalCloseTime
    ?? Date.parse(audit.evaluatedCandleOpenTime) + 5 * 60_000;
  const relatedCandles = relatedEvents.flatMap((event) => {
    const candle = resolvedAnchorCandle(event, contractCandles);
    if (!candle) return [];
    if (occurrence && candle.closeTime > evaluationClose) return [];
    const openTime = new Date(candle.openTime).toISOString();
    const closeTime = new Date(candle.closeTime).toISOString();
    return [{
      role: event.role,
      openTime,
      closeTime,
      price: event.price ?? candle.close,
      visibility: candle.openTime <= evaluationClose ? "machine" as const : "human_only" as const,
    }];
  }).filter((event, index, values) => values.findIndex((candidate) => candidate.role === event.role) === index);
  return {
    category,
    auditId: audit.id,
    tradeId: trade?.id ?? null,
    contractSymbol: audit.contractSymbol,
    openTime: new Date(anchorCandle.openTime).toISOString(),
    closeTime: new Date(anchorCandle.closeTime).toISOString(),
    price: anchorEvent.price ?? anchorCandle.close,
    direction: audit.direction,
    label: anchorLabels[category],
    detail: anchorDetail(category, audit, occurrence),
    relatedCandles,
    visibility: anchorCandle.openTime <= evaluationClose ? "machine" : "human_only",
    ...(occurrence ? { occurrenceId: occurrence.occurrenceId } : {}),
  };
}

function isStrongBreakout(record: BacktestAuditRecord): boolean {
  return [
    "QUALIFIED_BREAKOUT",
    "WAITING_FOR_PULLBACK",
    "PULLBACK_IN_PROGRESS",
    "WAITING_FOR_PATIENCE_CANDLE",
    "PATIENCE_CANDLE_VALID",
    "TRIGGER_CANDLE_ACTIVE",
    "ENTRY_TRIGGERED",
  ].includes(record.orbState);
}

function hasConfirmedSignal(record: BacktestAuditRecord): boolean {
  return isStrongBreakout(record) || [
    "PATIENCE_CANDLE_VALID",
    "TRIGGER_CANDLE_ACTIVE",
    "ENTRY_BUFFER_REACHED",
    "ENTRY_TRIGGERED",
  ].includes(record.patienceState);
}

function occurrenceCandleOpenTime(candle: HistoricalOccurrence["patienceCandle"] | HistoricalOccurrence["entryCandle"]): number | null {
  const value = candle?.openTime;
  return typeof value === "number" ? value : null;
}

function hasConfirmedPatienceOccurrence(occurrence: HistoricalOccurrence): boolean {
  if (occurrence.kind !== "patience" || occurrence.status !== "SIGNAL_CONFIRMED") return false;
  const patienceTimestamp = Date.parse(occurrence.patienceTimestamp ?? "");
  const expectedEntryTimestamp = Date.parse(occurrence.expectedEntryTimestamp ?? "");
  const entryTimestamp = Date.parse(occurrence.entryTimestamp ?? "");
  const patienceOpenTime = occurrenceCandleOpenTime(occurrence.patienceCandle);
  const entryOpenTime = occurrenceCandleOpenTime(occurrence.entryCandle);
  return Number.isFinite(patienceTimestamp)
    && Number.isFinite(expectedEntryTimestamp)
    && Number.isFinite(entryTimestamp)
    && patienceOpenTime !== null
    && entryOpenTime !== null
    && entryTimestamp === expectedEntryTimestamp
    && patienceTimestamp === patienceOpenTime
    && entryTimestamp === entryOpenTime
    && entryTimestamp === patienceTimestamp + 5 * 60_000;
}

function hasConfirmedTradeOccurrence(occurrence: HistoricalOccurrence): boolean {
  return (occurrence.kind === "trade" || occurrence.kind === "patience")
    && (occurrence.status === "TRADE_TAKEN" || occurrence.status === "TRADE_OUTCOME" || occurrence.status === "SIGNAL_CONFIRMED")
    ;
}

function hasTrendAlignedPatience(record: BacktestAuditRecord): boolean {
  const trendAligned = record.direction === "long"
    ? /^bullish\s*:/i.test(record.trendEvidence)
    : record.direction === "short"
      ? /^bearish\s*:/i.test(record.trendEvidence)
      : false;
  return trendAligned
    && record.patienceCandle !== null
    && [
      "PATIENCE_CANDLE_VALID",
      "TRIGGER_CANDLE_ACTIVE",
      "BREAK_DETECTED_WAITING_FOR_BUFFER",
      "ENTRY_BUFFER_REACHED",
      "ENTRY_TRIGGERED",
      "PATIENCE_CANDLE_EXPIRED",
      "OPPOSITE_SIDE_INVALIDATION",
      "AMBIGUOUS_EVENT_ORDER",
    ].includes(record.patienceState);
}

function hasMappedPullbackEvidence(record: BacktestAuditRecord): boolean {
  const evidence = `${record.pullbackEvidence} ${record.criticalLevelEvidence} ${record.ruleEvidence.join(" ")}`;
  const mappedLevel = /\b(?:orb(?:\s+(?:high|low))?|vwap|(?:200\s*)?ema(?:\s*200)?|fib(?:onacci)?(?:\s+(?:0\.382|0\.5|0\.618|0\.786))?|(?:major|critical)\s+level|prior\s+(?:day|session)\s+(?:high|low)|previous\s+(?:day|session)\s+(?:high|low))\b/i.test(evidence);
  const interaction = /\b(?:touch(?:ed)?|proxim(?:ity|al)|retest(?:ed)?|hold|reclaim(?:ed)?|consolidat(?:e|ed|ion)|interact(?:ed|ion))\b/i.test(record.pullbackEvidence);
  return mappedLevel && interaction;
}

function hasCompletedConsolidation(record: BacktestAuditRecord): boolean {
  const evidence = `${record.pullbackEvidence} ${record.ruleEvidence.join(" ")}`;
  return /\bconsolidat(?:e|ed|ion)\b/i.test(evidence)
    && /(?:\b\d+\b|completed|detected|measured|stable|expansion|window)/i.test(evidence)
    && !/\b(?:pending|incomplete|waiting|not complete)\b/i.test(evidence);
}

export function categoriesFor(record: BacktestAuditRecord, trade: BacktestTrade | null): VisualValidationCategory[] {
  const categories: VisualValidationCategory[] = [];
  if (record.rejectionCategory === "QUALIFIED" && trade) categories.push("qualified_trade");
  if (record.rejectionReason !== null) categories.push("rejected_setup");
  if (hasTrendAlignedPatience(record) && record.direction === "long") categories.push("bullish_patience_candle");
  if (hasTrendAlignedPatience(record) && record.direction === "short") categories.push("bearish_patience_candle");
  if (record.orbState === "ORB_PROBE_WAIT" || record.orbState === "WEAK_BREAK_WAIT") categories.push("weak_orb_probe");
  if (isStrongBreakout(record)) categories.push("strong_breakout");
  if (hasMappedPullbackEvidence(record)) categories.push("pullback");
  if (hasCompletedConsolidation(record)) categories.push("consolidation");
  if (record.rejectionCategory === "AMBIGUITY" || record.ambiguityLabels.length > 0) categories.push("ambiguous_candle");
  if (trade?.outcome === "strategy stop" || trade?.outcome === "catastrophe stop") categories.push("stop_exit");
  if (trade?.outcome === "target" || trade?.audit?.targetHit) categories.push("target_exit");
  if (trade?.audit?.runnerExited) categories.push("runner_exit");
  return categories;
}

function annotation(
  id: string,
  label: string,
  kind: VisualValidationAnnotation["kind"],
  price: number | null,
  color: VisualValidationAnnotation["color"],
  detail: string,
  openTime: number | null = null,
  closeTime: number | null = null,
  visibility: VisualValidationAnnotation["visibility"] = "machine",
): VisualValidationAnnotation {
  return {
    id,
    label,
    kind,
    price,
    openTime: safeDate(openTime),
    closeTime: safeDate(closeTime),
    available: price !== null || openTime !== null,
    color,
    detail,
    visibility,
  };
}

function buildAnnotations(
  snapshot: MarketSnapshot,
  audit: BacktestAuditRecord,
  trade: BacktestTrade | null,
  indicatorSeries: VisualValidationIndicatorPoint[] = [],
  occurrence?: HistoricalOccurrence,
): VisualValidationAnnotation[] {
  const lines: VisualValidationAnnotation[] = [];
  const causalBoundary = occurrence
    ? Date.parse(occurrence.evaluationCursor)
    : Date.parse(audit.evaluatedCandleOpenTime) + 5 * 60_000;
  const eventVisibility = (openTime: number | null): VisualValidationAnnotation["visibility"] =>
    openTime === null || openTime <= causalBoundary ? "machine" : "human_only";
  const addLevel = (id: string, label: string, price: number | null, detail: string, color: VisualValidationAnnotation["color"] = "accent") => {
    lines.push(annotation(id, label, "level", price, color, detail));
  };
  const patienceOpenForIndicator = evidenceTime(audit.patienceCandle, "openTime");
  const patienceIndicator = patienceOpenForIndicator === null ? undefined : indicatorSeries.find((point) => Date.parse(point.openTime) === patienceOpenForIndicator);
  const addIndicator = (id: string, label: string, price: number | null, detail: string, color: VisualValidationAnnotation["color"]) => {
    lines.push(annotation(id, label, "indicator", price, color, detail));
  };
  addLevel("premarket-high", "Premarket high", snapshot.levels.premarketHigh, "Premarket high available at the evaluation cursor.");
  addLevel("premarket-low", "Premarket low", snapshot.levels.premarketLow, "Premarket low available at the evaluation cursor.");
  const sourceDetail = (name: string, fallback: string): string => {
    const source = snapshot.levels.references.find((level) => level.name === name);
    return source?.sourceTradingDate
      ? `${fallback} Frozen from completed regular session ${source.sourceTradingDate}${source.sourceContractSymbol ? ` (${source.sourceContractSymbol})` : ""}; available before the current session.`
      : fallback;
  };
  addLevel("previous-session-high", "Previous-day high", snapshot.levels.previousDayHigh, sourceDetail("Prior day high", "Previous completed regular-session high."), "positive");
  addLevel("previous-session-low", "Previous-day low", snapshot.levels.previousDayLow, sourceDetail("Prior day low", "Previous completed regular-session low."), "positive");
  addLevel("two-sessions-high", "Two-days-ago high", snapshot.levels.dayBeforeYesterdayHigh, sourceDetail("Two days ago high", "High from two completed regular sessions back."), "blue");
  addLevel("two-sessions-low", "Two-days-ago low", snapshot.levels.dayBeforeYesterdayLow, sourceDetail("Two days ago low", "Low from two completed regular sessions back."), "blue");
  addLevel("ntz-high", "NTZ high", snapshot.levels.ntzHigh, "No-trade zone upper boundary.");
  addLevel("ntz-low", "NTZ low", snapshot.levels.ntzLow, "No-trade zone lower boundary.");
  addIndicator("ema-200", "200 MA", patienceIndicator?.ema200 ?? snapshot.indicators.ema200, "Causal 200-period exponential moving average at the patience-candle timestamp.", "positive");
  addIndicator("vwap", "VWAP", patienceIndicator?.vwap ?? snapshot.indicators.vwap, "Causal regular-session volume-weighted average price at the patience-candle timestamp.", "negative");
  lines.push(annotation("orb-high", "ORB high", "price", snapshot.levels.openingRangeHigh, "accent", "Opening range upper boundary."));
  lines.push(annotation("orb-low", "ORB low", "price", snapshot.levels.openingRangeLow, "accent", "Opening range lower boundary."));
  for (const level of snapshot.levels.critical) {
    const normalizedName = level.name.toLowerCase().replace(/[-_]+/g, " ");
    if (/(?:prior|previous|two days? ago|day before yesterday)/.test(normalizedName)) continue;
    addLevel(`critical-${level.name}`, `Critical · ${level.name}`, level.price, level.kind, "muted");
  }
  for (const level of snapshot.majorLevels) {
    addLevel(`major-${level.name}`, level.name, level.price, `${level.kind} · ${level.confluence} confluence`, "muted");
    const major = lines.at(-1);
    if (major) {
      major.rangeLow = level.zoneLow ?? null;
      major.rangeHigh = level.zoneHigh ?? null;
    }
  }
  for (const level of snapshot.dynamiteLevels) {
    addLevel(
      level.id,
      `Dynamite · ${level.confluenceCount} confluences`,
      level.representative,
      `${level.lower.toFixed(2)}–${level.upper.toFixed(2)} · ${level.includedTypes.join(", ")} · observed ${new Date(level.observedAt).toISOString()}${level.pullbackInteracted ? " · pullback interacted" : ""}`,
      "blue",
    );
    const dynamite = lines.at(-1);
    if (dynamite) {
      dynamite.rangeLow = level.lower;
      dynamite.rangeHigh = level.upper;
    }
  }

  const patienceOpen = occurrence
    ? occurrence.patienceTimestamp ? Date.parse(occurrence.patienceTimestamp) : null
    : evidenceTime(audit.patienceCandle, "openTime");
  const patienceClose = occurrence
    ? occurrence.patienceCandle ? Number(occurrence.patienceCandle.closeTime) : null
    : evidenceTime(audit.patienceCandle, "closeTime");
  const entryOpen = occurrence
    ? occurrence.entryTimestamp ? Date.parse(occurrence.entryTimestamp) : null
    : evidenceTime(audit.triggerCandle, "openTime");
  const entryClose = occurrence
    ? occurrence.entryCandle ? Number(occurrence.entryCandle.closeTime) : null
    : evidenceTime(audit.triggerCandle, "closeTime");
  const patiencePrice = occurrence
    ? evidenceNumber(occurrence.patienceCandle, "close")
    : evidenceNumber(audit.patienceCandle, "close");
  const entryPrice = occurrence
    ? evidenceNumber(occurrence.entryCandle, "close")
    : evidenceNumber(audit.triggerCandle, "close");
  const patienceLabel = occurrence && occurrence.status !== "CONFIRMED"
    ? "Expired patience candidate"
    : "Patience candle";
  lines.push(annotation("patience-candle", patienceLabel, "candle", patiencePrice, occurrence && occurrence.status !== "CONFIRMED" ? "muted" : "positive", occurrence?.reasonCode ?? snapshot.patience.detail, patienceOpen, patienceClose));
  lines.push(annotation("entry-candle", "Entry candle (E)", "candle", entryPrice, "accent", occurrence?.entryTimestamp ? "The completed immediate-next candle after P reached the confirmation buffer." : occurrence?.nextObservedCandle ? "The immediate-next candle was observed but did not qualify as E; no later candle may replace it." : "No completed immediate-next E confirmation was recorded.", entryOpen, entryClose));
  const modeledFillTime = audit.modeledFillObservationTime ? Date.parse(audit.modeledFillObservationTime) : trade?.audit?.modeledFillObservationTime ? Date.parse(trade.audit.modeledFillObservationTime) : trade ? Date.parse(trade.entryTime) : null;
  lines.push(annotation("modeled-fill", "Modeled fill", "candle", trade?.audit?.modeledFillPrice ?? trade?.entryPrice ?? null, "positive", "The modeled execution observation, not a live order or broker fill.", modeledFillTime, modeledFillTime, eventVisibility(modeledFillTime)));
  const entryBuffer = snapshot.patience.entryBufferPrice ?? audit.entryTriggerPrice;
  addLevel("entry-buffer", "Entry buffer", entryBuffer, `${snapshot.patience.entryBufferTicks}-tick confirmation buffer.`, "accent");
  addLevel("strategy-stop", "Strategy stop", audit.strategyStopPrice ?? snapshot.patience.strategyStopPrice, "Formula-defined thesis stop.", "negative");
  const primaryLossExitLevel = trade?.audit?.primaryLossExitLevel ?? null;
  if (primaryLossExitLevel?.stopPrice !== null && primaryLossExitLevel?.stopPrice !== undefined) {
    addLevel(
      "primary-level-stop",
      `Primary level stop · ${primaryLossExitLevel.id}`,
      primaryLossExitLevel.stopPrice,
      `Buffered stop is 8 MES ticks beyond the adverse ${primaryLossExitLevel.id} boundary at ${primaryLossExitLevel.price.toFixed(2)}; this stop takes priority over the patience strategy stop.`,
      "negative",
    );
  }
  // Candidate-owned plans are authoritative. Audit target fields are legacy
  // evidence and may only be used for a non-candidate legacy visualization.
  const targetPlan = trade?.targetPlan ?? occurrence?.management?.targetPlan ?? (
    trade?.candidateId ? undefined : audit.targetPlan
  );
  if (targetPlan?.selectedTargetLevel) {
    const selected = targetPlan.selectedTargetLevel;
    addLevel(
      "selected-target-level",
      `Selected target level · ${selected.id}`,
      selected.price,
      `${selected.type} · ${targetPlan.direction === "long" ? "lower boundary first" : "upper boundary first"}.`,
      "blue",
    );
    const selectedAnnotation = lines.at(-1);
    if (selectedAnnotation) {
      selectedAnnotation.rangeLow = selected.rangeLow;
      selectedAnnotation.rangeHigh = selected.rangeHigh;
    }
    for (const skipped of targetPlan.skippedLevels) {
      addLevel(
        `skipped-target-${skipped.id}`,
        `Skipped: ${skipped.id}`,
        skipped.price,
        `Skipped: entry within ${targetPlan.bufferTicks} ticks.`,
        "muted",
      );
    }
  }
  const targetPrice = trade?.candidateId
    ? trade.targetPlan?.targetPrice ?? null
    : targetPlan?.targetPrice ?? null;
  addLevel(
    "target",
    targetPrice === null && targetPlan?.disposition === "NO_ELIGIBLE_KEY_LEVEL"
      ? "No eligible key-level target"
      : "Target",
    targetPrice,
    targetPlan?.selectedTargetLevel
      ? targetPlan.placementMode === "EXACT_LEVEL"
        ? `Exact ${targetPlan.selectedTargetLevel.id} level; all levels within ${targetPlan.bufferTicks} ticks of entry were excluded.`
        : `${targetPlan.bufferTicks} ticks before ${targetPlan.selectedTargetLevel.id}.`
      : "No eligible key-level target; candidate remains open and unscored.",
    "positive",
  );
  addLevel("runner-threshold", "Runner threshold", trade?.audit?.runnerReferencePrice ?? snapshot.riskPlan.runner.retracementThreshold ?? null, "Runner reference or retracement threshold.", "positive");
  const exitOpen = audit.exitCandleOpenTime ? Date.parse(audit.exitCandleOpenTime) : trade?.audit?.exitCandleOpenTime ? Date.parse(trade.audit.exitCandleOpenTime) : null;
  const exitClose = audit.exitCandleCloseTime ? Date.parse(audit.exitCandleCloseTime) : trade?.audit?.exitCandleCloseTime ? Date.parse(trade.audit.exitCandleCloseTime) : trade?.exitTime ? Date.parse(trade.exitTime) : null;
  const eventLabels = new Set([...(audit.eventLabels ?? []), ...(trade?.audit?.eventLabels ?? [])]);
  const stopHitTime = exitOpen ?? exitClose;
  const primaryLevelStopHit = trade?.audit?.stopLevel === "primary_level"
    || eventLabels.has("PRIMARY_LEVEL_EXIT_REACHED");
  if (primaryLevelStopHit) {
    lines.push(annotation(
      "primary-level-stop-hit",
      "Primary level stop hit",
      "candle",
      primaryLossExitLevel?.stopPrice ?? trade?.exitPrice ?? null,
      "negative",
      primaryLossExitLevel
        ? `The ${primaryLossExitLevel.id} primary loss reference was reached at the frozen buffered stop of ${primaryLossExitLevel.stopPrice.toFixed(2)}; the primary stop is the authoritative exit and the modeled fill is ${trade?.exitPrice?.toFixed(2) ?? "unavailable"}.`
        : "The primary-level stop was reached in the bounded execution outcome.",
      stopHitTime,
      exitClose,
      eventVisibility(stopHitTime),
    ));
  } else if (eventLabels.has("STRATEGY_STOP_REACHED") || trade?.outcome === "strategy stop") {
    lines.push(annotation("strategy-stop-hit", "Strategy stop hit", "candle", audit.strategyStopPrice ?? trade?.audit?.strategyStopPrice ?? null, "negative", "The strategy stop was reached in the bounded execution outcome.", stopHitTime, exitClose, eventVisibility(stopHitTime)));
  }
  if (targetPrice !== null
    && (eventLabels.has("TARGET_REACHED") || trade?.audit?.targetHit === true || trade?.outcome === "target")) {
    lines.push(annotation("target-hit", "Target hit", "candle", targetPrice, "positive", "The candidate-owned key-level target was reached.", exitOpen, exitClose, eventVisibility(exitOpen)));
  }
  if (eventLabels.has("RUNNER_ACTIVATED") || trade?.audit?.runnerActivated === true) {
    lines.push(annotation("runner-activation", "Runner activation", "candle", trade?.audit?.runnerReferencePrice ?? null, "positive", "The target leg completed and the runner became active.", exitOpen, exitClose, eventVisibility(exitOpen)));
  }
  if (eventLabels.has("RUNNER_EXITED") || trade?.audit?.runnerExited === true) {
    lines.push(annotation("runner-exit", "Runner exit", "candle", trade?.exitPrice ?? null, "accent", "The modeled runner exited; this outcome is human-only when it occurs after the causal cursor.", exitOpen, exitClose, eventVisibility(exitOpen)));
  }
  return lines;
}

function regularSessionCandlesForDate(
  candles: readonly SimulatedFuturesCandle[],
  tradingDate: string,
  contractSymbol: string,
  calendar: ReturnType<typeof sessionCalendarForContract>,
): SimulatedFuturesCandle[] {
  return candles
    .filter((candle) =>
      candle.contractSymbol === contractSymbol
      && tradingDateForTimestamp(candle.openTime, calendar) === tradingDate
      && classifyFuturesSession(candle.openTime, calendar) === "regular"
      && candle.isComplete,
    )
    .sort((first, second) => first.closeTime - second.closeTime);
}

type HistoricalVisualValidationIndex = {
  candlesByContract: Map<string, SimulatedFuturesCandle[]>;
  completeCandlesByContract: Map<string, SimulatedFuturesCandle[]>;
  regularCandlesByContractDate: Map<string, SimulatedFuturesCandle[]>;
  premarketCandlesByContractDate: Map<string, SimulatedFuturesCandle[]>;
  indicatorHistoryByContract: Map<string, SimulatedFuturesCandle[]>;
  emaSeriesByContract: Map<string, ReturnType<typeof causalEmaSeries>>;
  vwapTotalsByContractDate: Map<string, Map<number, { priceVolume: number; volume: number }>>;
  marketSnapshots: Map<string, MarketSnapshot>;
};

function visualValidationContractDateKey(contractSymbol: string, tradingDate: string): string {
  return `${contractSymbol}|${tradingDate}`;
}

function createHistoricalVisualValidationIndex(
  dataset: CausalReplayDataset,
  calendar: ReturnType<typeof sessionCalendarForContract>,
): HistoricalVisualValidationIndex {
  const index: HistoricalVisualValidationIndex = {
    candlesByContract: new Map(),
    completeCandlesByContract: new Map(),
    regularCandlesByContractDate: new Map(),
    premarketCandlesByContractDate: new Map(),
    indicatorHistoryByContract: new Map(),
    emaSeriesByContract: new Map(),
    vwapTotalsByContractDate: new Map(),
    marketSnapshots: new Map(),
  };
  for (const candle of dataset.candles) {
    const candles = index.candlesByContract.get(candle.contractSymbol) ?? [];
    candles.push(candle);
    index.candlesByContract.set(candle.contractSymbol, candles);
    if (!candle.isComplete) continue;
    const complete = index.completeCandlesByContract.get(candle.contractSymbol) ?? [];
    complete.push(candle);
    index.completeCandlesByContract.set(candle.contractSymbol, complete);
    const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
    const key = visualValidationContractDateKey(candle.contractSymbol, tradingDate);
    const session = classifyFuturesSession(candle.openTime, calendar);
    if (session === "regular") {
      const regular = index.regularCandlesByContractDate.get(key) ?? [];
      regular.push(candle);
      index.regularCandlesByContractDate.set(key, regular);
    } else if (session === "premarket") {
      const premarket = index.premarketCandlesByContractDate.get(key) ?? [];
      premarket.push(candle);
      index.premarketCandlesByContractDate.set(key, premarket);
    }
    if (session !== "closed") {
      const history = index.indicatorHistoryByContract.get(candle.contractSymbol) ?? [];
      history.push(candle);
      index.indicatorHistoryByContract.set(candle.contractSymbol, history);
    }
  }
  const sortCandles = (candles: SimulatedFuturesCandle[]): void => {
    candles.sort((first, second) => first.closeTime - second.closeTime);
  };
  for (const candles of index.candlesByContract.values()) sortCandles(candles);
  for (const candles of index.completeCandlesByContract.values()) sortCandles(candles);
  for (const candles of index.regularCandlesByContractDate.values()) sortCandles(candles);
  for (const candles of index.premarketCandlesByContractDate.values()) sortCandles(candles);
  for (const candles of index.indicatorHistoryByContract.values()) {
    sortCandles(candles);
    const emaSeries = causalEmaSeries(candles, strategyConfig().emaPeriod);
    index.emaSeriesByContract.set(candles[0]?.contractSymbol ?? "", emaSeries);
  }
  for (const [key, candles] of index.regularCandlesByContractDate) {
    let priceVolume = 0;
    let volume = 0;
    const totals = new Map<number, { priceVolume: number; volume: number }>();
    for (const candle of candles) {
      priceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
      volume += candle.volume;
      totals.set(candle.openTime, { priceVolume, volume });
    }
    index.vwapTotalsByContractDate.set(key, totals);
  }
  return index;
}

function buildIndicatorSeries(
  historicalCandles: readonly SimulatedFuturesCandle[],
  displayedCandles: readonly SimulatedFuturesCandle[],
  evaluationCloseTime: number,
  tradingDate: string,
  contractSymbol: string,
  calendar: ReturnType<typeof sessionCalendarForContract>,
  index?: HistoricalVisualValidationIndex,
): VisualValidationIndicatorPoint[] {
  const config = strategyConfig();
  const orderedHistory = index?.indicatorHistoryByContract.get(contractSymbol)
    ?? [...historicalCandles, ...displayedCandles]
      .filter((candle) =>
        candle.contractSymbol === contractSymbol
        && candle.isComplete
        && classifyFuturesSession(candle.openTime, calendar) !== "closed",
      )
      .sort((first, second) => first.closeTime - second.closeTime);
  const dedupedHistory = index ? orderedHistory : [...new Map(orderedHistory.map((candle) => [candle.openTime, candle])).values()];
  const emaSeries = index?.emaSeriesByContract.get(contractSymbol)
    ?? causalEmaSeries(dedupedHistory, config.emaPeriod);
  const emaByOpenTime = new Map(emaSeries.points.map((point) => [point.candle.openTime, point.value]));
  const sourceStartTime = emaSeries.sourceStartTime === null ? null : new Date(emaSeries.sourceStartTime).toISOString();
  const sourceEndTime = emaSeries.sourceEndTime === null ? null : new Date(emaSeries.sourceEndTime).toISOString();
  const sessionTotals = index?.vwapTotalsByContractDate.get(visualValidationContractDateKey(contractSymbol, tradingDate))
    ?? (() => {
      const sessionCandles = regularSessionCandlesForDate(historicalCandles, tradingDate, contractSymbol, calendar);
      const totals = new Map<number, { priceVolume: number; volume: number }>();
      let priceVolume = 0;
      let volume = 0;
      for (const candle of sessionCandles) {
        priceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
        volume += candle.volume;
        totals.set(candle.openTime, { priceVolume, volume });
      }
      return totals;
    })();
  return displayedCandles.map((candle) => {
    const totals = sessionTotals.get(candle.openTime);
    const visible = candle.closeTime <= evaluationCloseTime;
    return {
      openTime: new Date(candle.openTime).toISOString(),
      closeTime: new Date(candle.closeTime).toISOString(),
      vwap: totals && totals.volume > 0 ? totals.priceVolume / totals.volume : null,
      ema200: emaByOpenTime.get(candle.openTime) ?? null,
      contractSymbol,
      sessionTemplate: calendar.calendarVersion,
      noResetPolicy: "continuous_contract_local",
      warmupCount: emaSeries.warmupCount,
      initializationMethod: emaSeries.initialization === "sma" ? "sma_of_period_closes" : "unavailable",
      sourceStartTime,
      sourceEndTime,
      availability: emaSeries.initialized && emaByOpenTime.get(candle.openTime) !== null && emaByOpenTime.get(candle.openTime) !== undefined
        ? "available"
        : "insufficient_warmup",
      visibility: visible ? "machine" : "human_only",
    };
  });
}

function eventVisibility(openTime: number | null, evaluationCloseTime: number): VisualValidationTradeEvent["visibility"] {
  return openTime !== null && openTime <= evaluationCloseTime ? "machine" : "human_only";
}

function tradeEvent(
  id: string,
  event: string,
  label: string,
  direction: "long" | "short" | null,
  openTime: number | null,
  closeTime: number | null,
  triggerPrice: number | null,
  modeledPrice: number | null,
  contracts: number,
  detail: string,
  evaluationCloseTime: number,
): VisualValidationTradeEvent {
  return {
    id,
    event,
    label,
    direction,
    openTime: safeDate(openTime),
    closeTime: safeDate(closeTime),
    triggerPrice,
    modeledPrice,
    contracts,
    visibility: eventVisibility(openTime, evaluationCloseTime),
    detail,
  };
}

function buildTradeEvents(
  audit: BacktestAuditRecord,
  trade: BacktestTrade | null,
  evaluationCloseTime: number,
  occurrence?: HistoricalOccurrence,
): VisualValidationTradeEvent[] {
  if (!trade) return [];
  const tradeAudit = trade.audit;
  const patienceOpen = occurrence?.patienceTimestamp
    ? Date.parse(occurrence.patienceTimestamp)
    : evidenceTime(audit.patienceCandle, "openTime");
  const patienceClose = occurrence?.patienceCandle
    ? evidenceTime(occurrence.patienceCandle, "closeTime")
    : evidenceTime(audit.patienceCandle, "closeTime");
  const entryOpen = occurrence?.entryTimestamp
    ? Date.parse(occurrence.entryTimestamp)
    : evidenceTime(audit.triggerCandle, "openTime");
  const entryClose = occurrence?.entryCandle
    ? evidenceTime(occurrence.entryCandle, "closeTime")
    : evidenceTime(audit.triggerCandle, "closeTime");
  if (occurrence && (
    !["SIGNAL_CONFIRMED", "TRADE_TAKEN", "TRADE_OUTCOME"].includes(occurrence.status) && occurrence.kind !== "trade"
    || entryOpen === null
    || patienceClose === null
    || entryOpen !== patienceClose
  )) return [];
  const fillTime = tradeAudit?.modeledFillObservationTime
    ? Date.parse(tradeAudit.modeledFillObservationTime)
    : Date.parse(trade.entryTime);
  const exitOpen = tradeAudit?.exitCandleOpenTime ? Date.parse(tradeAudit.exitCandleOpenTime) : trade.exitTime ? Date.parse(trade.exitTime) : null;
  const exitClose = tradeAudit?.exitCandleCloseTime ? Date.parse(tradeAudit.exitCandleCloseTime) : trade.exitTime ? Date.parse(trade.exitTime) : null;
  const authoritativeFill = trade.candidateId
    && trade.signalOccurrenceId
    && (!occurrence || trade.signalOccurrenceId === occurrence.occurrenceId)
    && tradeAudit?.modeledFillPrice === trade.entryPrice
    && tradeAudit?.entryTriggerPrice === trade.entryPrice
    && tradeAudit?.triggerCandleOpenTime
    && tradeAudit?.modeledFillObservationTime;
  if (!authoritativeFill) return [];
  const events: VisualValidationTradeEvent[] = [
    tradeEvent("patience", "patience", "P", audit.direction, patienceOpen, patienceClose, null, occurrence ? evidenceNumber(occurrence.patienceCandle, "close") : evidenceNumber(audit.patienceCandle, "close"), trade.contracts, "Validated patience candle.", evaluationCloseTime),
    tradeEvent(
      "entry-fill",
      "entry_fill",
      `Entry + fill ${trade.entryPrice.toFixed(2)}`,
      trade.direction,
      entryOpen,
      entryClose ?? fillTime,
      tradeAudit.entryTriggerPrice,
      trade.entryPrice,
      trade.contracts,
      `Candidate ${trade.candidateId} filled once at the immediate E threshold; signal ${trade.signalOccurrenceId}, observed at E close in permanent Shadow Mode.`,
      evaluationCloseTime,
    ),
  ];
  if (trade.outcome === "strategy stop" || trade.outcome === "catastrophe stop") {
    const primaryLevelStopHit = trade.audit?.stopLevel === "primary_level"
      || trade.audit?.eventLabels?.includes("PRIMARY_LEVEL_EXIT_REACHED") === true;
    const primaryLossExitLevel = trade.audit?.primaryLossExitLevel ?? null;
    events.push(tradeEvent(
      primaryLevelStopHit ? "primary-level-stop" : "stop",
      "stop",
      primaryLevelStopHit ? "PRIMARY LEVEL STOP" : "STOP",
      trade.direction,
      exitOpen,
      exitClose,
      audit.entryTriggerPrice,
      primaryLevelStopHit ? primaryLossExitLevel?.stopPrice ?? trade.exitPrice : trade.exitPrice,
      trade.contracts,
      primaryLevelStopHit && primaryLossExitLevel
        ? `${trade.outcome} exit: ${primaryLossExitLevel.id} at ${primaryLossExitLevel.price.toFixed(2)} with an 8-MES-tick buffered stop at ${primaryLossExitLevel.stopPrice.toFixed(2)}. Actual fill: ${trade.exitPrice?.toFixed(2) ?? "unavailable"}.`
        : `${trade.outcome} exit.`,
      evaluationCloseTime,
    ));
  }
  if (trade.audit?.targetHit || trade.outcome === "target") {
    events.push(tradeEvent("target", "target", "TARGET", trade.direction, exitOpen, exitClose, audit.entryTriggerPrice, trade.audit?.targetPrice ?? audit.targetPrice, trade.contracts, "Modeled target exit.", evaluationCloseTime));
  }
  if (trade.audit?.runnerActivated) {
    events.push(tradeEvent("runner", "runner_activation", "RUNNER", trade.direction, exitOpen, exitClose, audit.entryTriggerPrice, trade.audit.runnerReferencePrice ?? null, trade.audit.remainingQuantity ?? 0, "Runner leg activated.", evaluationCloseTime));
  }
  if (trade.audit?.runnerExited) {
    events.push(tradeEvent("runner-exit", "runner_exit", "RUNNER EXIT", trade.direction, exitOpen, exitClose, audit.entryTriggerPrice, trade.exitPrice, trade.audit.remainingQuantity ?? 0, "Modeled runner exit.", evaluationCloseTime));
  }
  if (trade.ambiguityLabel || trade.audit?.ambiguityLabels?.length) {
    events.push(tradeEvent("ambiguity", "ambiguity", "AMBIGUITY", trade.direction, exitOpen, exitClose, audit.entryTriggerPrice, trade.exitPrice, trade.contracts, trade.ambiguityLabel ?? trade.audit?.ambiguityLabels.join(", ") ?? "Barrier order is unknown.", evaluationCloseTime));
  }
  return events.filter((event) => event.openTime !== null || event.closeTime !== null);
}

function formatMissingInterval(openTime: number, closeTime: number): string {
  const format = (value: number) => new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
  return `${format(openTime)}–${format(closeTime)} ET`;
}

function buildCoverage(
  regularCandles: readonly SimulatedFuturesCandle[],
  tradingDate: string,
  calendar: ReturnType<typeof sessionCalendarForContract>,
): VisualValidationCoverage[] {
  const window = sessionWindow(tradingDate, "regular", calendar);
  const config = activeShadowStrategySnapshot().config;
  if (!window) {
    return [
      { session: "primary", expectedCandleCount: 0, observedCandleCount: 0, complete: false, missingIntervals: ["Regular session window unavailable."] },
      { session: "full_regular", expectedCandleCount: 0, observedCandleCount: 0, complete: false, missingIntervals: ["Regular session window unavailable."] },
    ];
  }
  const observed = new Set(regularCandles.map((candle) => candle.openTime));
  const intervalMs = 5 * 60_000;
  const primaryEnd = Math.min(window.closeTime, window.openTime + (config.primaryEntryEndMinutes - config.primaryEntryStartMinutes) * 60_000);
  const build = (session: "primary" | "full_regular", endTime: number) => {
    const expected = Math.max(0, Math.floor((endTime - window.openTime) / intervalMs));
    const missing: string[] = [];
    for (let index = 0; index < expected; index += 1) {
      const openTime = window.openTime + index * 5 * 60_000;
      if (!observed.has(openTime)) missing.push(formatMissingInterval(openTime, openTime + 5 * 60_000));
    }
    return {
      session,
      expectedCandleCount: expected,
      observedCandleCount: regularCandles.filter((candle) => candle.openTime >= window.openTime && candle.openTime < endTime).length,
      complete: missing.length === 0,
      missingIntervals: missing,
    };
  };
  return [build("primary", primaryEnd), build("full_regular", window.closeTime)];
}

type ReviewCandidate = {
  audit: BacktestAuditRecord;
  trade: BacktestTrade | null;
  category: VisualValidationCategory;
  occurrence?: HistoricalOccurrence;
};

function candidateOccurrenceTimestamp(candidate: ReviewCandidate): number {
  const occurrence = candidate.occurrence;
  const value = candidate.category === "qualified_trade"
    ? occurrence?.entryTimestamp
    : candidate.category === "bullish_patience_candle" || candidate.category === "bearish_patience_candle"
      ? occurrence?.signalStatus === "SIGNAL_CONFIRMED"
        ? occurrence.entryTimestamp
        : occurrence?.patienceTimestamp
      : candidate.category === "pullback"
        ? occurrence?.lTimestamp
        : occurrence?.entryTimestamp ?? occurrence?.patienceTimestamp ?? occurrence?.lTimestamp;
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const tradeTime = candidate.trade?.audit?.modeledFillObservationTime
    ? Date.parse(candidate.trade.audit.modeledFillObservationTime)
    : Number.NaN;
  return Number.isFinite(tradeTime) ? tradeTime : Date.parse(candidate.audit.evaluatedCandleOpenTime);
}

function isPrimaryEntryTimestamp(timestamp: number): boolean {
  const config = activeShadowStrategySnapshot().config;
  if (!Number.isFinite(timestamp)) return false;
  const minutes = wallClockMinutesForTimestamp(timestamp, config.sessionTimeZone);
  return minutes >= config.primaryEntryStartMinutes && minutes < config.primaryEntryEndMinutes;
}

function candidateIsPrimary(candidate: ReviewCandidate): boolean {
  return isPrimaryEntryTimestamp(candidateOccurrenceTimestamp(candidate));
}

function candidateSelectionRank(candidate: ReviewCandidate): number {
  const primary = candidateIsPrimary(candidate);
  if (candidate.trade && primary) return 0;
  if (candidate.occurrence && (candidate.category === "bullish_patience_candle" || candidate.category === "bearish_patience_candle")
    && hasConfirmedPatienceOccurrence(candidate.occurrence) && primary) return 1;
  if (candidate.occurrence && candidate.category === "pullback" && primary) return 2;
  if (primary && (candidate.trade !== null || hasConfirmedSignal(candidate.audit))) return 3;
  if (primary) return 4;
  return 5;
}

function candidateSelectionReason(candidate: ReviewCandidate): string {
  const window = candidateIsPrimary(candidate) ? "inside the 9:30 a.m.–1:00 p.m. ET primary entry window" : "outside the primary entry window";
  const rank = candidateSelectionRank(candidate);
  const quality = rank === 0
    ? "confirmed modeled entry"
    : rank === 1
      ? "confirmed immediate P→E pair"
      : rank === 2
        ? "causal ORB pullback"
        : rank === 3
          ? "confirmed morning evidence"
          : rank === 4
            ? "morning diagnostic"
            : "afternoon diagnostic";
  return `${quality}; ${window}; earliest causal occurrence within its tier`;
}

function sortReviewCandidates(candidates: readonly ReviewCandidate[]): ReviewCandidate[] {
  return [...candidates].sort((first, second) =>
    candidateSelectionRank(first) - candidateSelectionRank(second)
    || candidateOccurrenceTimestamp(first) - candidateOccurrenceTimestamp(second)
    || first.audit.id.localeCompare(second.audit.id)
    || first.category.localeCompare(second.category),
  );
}

function buildMachineSnapshot(
  report: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode">,
  dataset: CausalReplayDataset,
  audit: BacktestAuditRecord,
  trade: BacktestTrade | null,
  sampleIndex: number,
  category: VisualValidationCategory,
  reviewCloseTime: number,
  premarketAvailable: boolean,
  occurrence?: HistoricalOccurrence,
  selectionReason = "causal occurrence retained",
  index?: HistoricalVisualValidationIndex,
): VisualValidationSnapshot {
  const calendar = sessionCalendarForContract(getFuturesContractSpecification(report.symbol));
  const auditEvaluationTime = Date.parse(audit.evaluatedCandleOpenTime);
  const occurrenceEvaluationCloseTime = occurrence ? Date.parse(occurrence.evaluationCursor) : Number.NaN;
  const occurrenceCursorIsForAuditDate = Number.isFinite(occurrenceEvaluationCloseTime)
    && tradingDateForTimestamp(occurrenceEvaluationCloseTime, calendar) === audit.tradingDate;
  const evaluationCloseTime = occurrenceCursorIsForAuditDate
    ? occurrenceEvaluationCloseTime
    : auditEvaluationTime + 5 * 60_000;
  const evaluationTime = occurrenceCursorIsForAuditDate
    ? evaluationCloseTime - 5 * 60_000
    : auditEvaluationTime;
  const exitTime = trade?.audit?.exitCandleCloseTime ? Date.parse(trade.audit.exitCandleCloseTime) : evaluationTime;
  const historicalCandles = index?.candlesByContract.get(audit.contractSymbol)
    ?? dataset.candles.filter((candle) => candle.contractSymbol === audit.contractSymbol);
  const evaluationCandles = index?.regularCandlesByContractDate.get(
    visualValidationContractDateKey(audit.contractSymbol, audit.tradingDate),
  ) ?? regularSessionCandlesForDate(historicalCandles, audit.tradingDate, audit.contractSymbol, calendar);
  const visibleEvaluation = visibleReplayPrefix(evaluationCandles, evaluationCloseTime);
  const regularWindow = sessionWindow(audit.tradingDate, "regular", calendar);
  const fullRegularEnd = regularWindow?.closeTime ?? reviewCloseTime;
  const reviewTime = Math.max(evaluationCloseTime, exitTime, reviewCloseTime, fullRegularEnd);
  const visibleReview = visibleReplayPrefix(evaluationCandles, reviewTime);
  const premarketSourceCandles = index?.premarketCandlesByContractDate.get(
    visualValidationContractDateKey(audit.contractSymbol, audit.tradingDate),
  ) ?? historicalCandles
    .filter((candle) =>
      tradingDateForTimestamp(candle.openTime, calendar) === audit.tradingDate
      && classifyFuturesSession(candle.openTime, calendar) === "premarket"
      && candle.isComplete,
    )
    .sort((first, second) => first.closeTime - second.closeTime);
  const visiblePremarket = premarketAvailable
    ? premarketSourceCandles.filter((candle) => candle.closeTime <= reviewTime)
    : [];
  const analysisCandles = [...visiblePremarket, ...visibleEvaluation];
  const snapshotCacheKey = `${report.symbol}|${audit.contractSymbol}|${audit.tradingDate}|${evaluationCloseTime}|${premarketAvailable}|${report.executionMode}`;
  let evaluationSnapshot = index?.marketSnapshots.get(snapshotCacheKey);
  if (!evaluationSnapshot) {
    evaluationSnapshot = createMarketSnapshot(
      report.symbol,
      "regular",
      undefined,
      undefined,
      { targetDollars: undefined, slippageMode: "normal" },
      {
        tradingDate: audit.tradingDate,
        cursor: evaluationCloseTime,
        allCandles: analysisCandles,
        // Keep the full contract-local history available to the causal replay
        // layer; sessionLevels and Phase 4 filter it at the evaluation cursor.
        historicalFeed: historicalCandles,
        allCandlesCompleted: true,
        premarketAvailable,
        executionMode: report.executionMode,
        validateDashboardInvariants: false,
        strategyConfigOverrides: activeShadowStrategySnapshot().config,
      },
    );
    index?.marketSnapshots.set(snapshotCacheKey, evaluationSnapshot);
  }
  const machineCandles = visibleEvaluation.map(toRawCandle);
  const reviewCandles = visibleReview.map(toRawCandle);
  const premarketCandles = visiblePremarket.map(toRawCandle);
  const categoryAnchor = buildCategoryAnchor(
    category,
    audit,
    trade,
    historicalCandles,
    occurrence,
    evaluationCloseTime,
    index?.completeCandlesByContract.get(audit.contractSymbol),
  );
  const indicatorSeries = buildIndicatorSeries(
    historicalCandles,
    visibleReview,
    evaluationCloseTime,
    audit.tradingDate,
    audit.contractSymbol,
    calendar,
    index,
  );
  if (!categoryAnchor) throw new Error(`Category anchor could not resolve to a raw ${audit.contractSymbol} candle.`);
  const hash = createHash("sha256")
    .update(JSON.stringify({
      sourceFingerprint: occurrence?.sourceFingerprint ?? null,
      formulaHash: report.formulaHash,
      contractSymbol: audit.contractSymbol,
      tradingDate: audit.tradingDate,
      strategy: canonicalStrategyId(audit.setupType) ?? audit.setupType,
      category,
      occurrenceKind: occurrence?.kind ?? null,
      lTimestamp: occurrence?.lTimestamp ?? null,
      patienceTimestamp: occurrence?.patienceTimestamp ?? null,
      entryTimestamp: occurrence?.entryTimestamp ?? null,
      lEventId: occurrence?.lEventId ?? null,
      evaluationCursor: occurrence?.evaluationCursor ?? null,
      auditId: audit.id,
      occurrenceId: occurrence?.occurrenceId ?? null,
    }))
    .digest("hex")
    .slice(0, 16);
  return {
    snapshotId: `visual-${hash}`,
    ...(occurrence ? { occurrenceId: occurrence.occurrenceId, sourceFingerprint: occurrence.sourceFingerprint } : {}),
    sampleIndex,
    category,
    categoryLabel: categoryLabels[category],
    machineLabel: audit.rejectionCategory === "QUALIFIED" ? `${canonicalStrategyId(audit.setupType) ?? audit.setupType} qualified` : audit.rejectionSummary ?? audit.decision,
    strategyKey: canonicalStrategyId(audit.setupType) ?? "ORB_PULLBACK_CONTINUATION",
    formulaHash: report.formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
    symbol: report.symbol,
    contractSymbol: audit.contractSymbol,
    contractMonth: audit.contractMonth,
    tradingDate: audit.tradingDate,
    entryWindow: isPrimaryEntryTimestamp(candidateOccurrenceTimestamp({
      audit,
      trade,
      category,
      occurrence,
    })) ? "primary" : "outside_primary",
    selectionReason,
    period: audit.period,
    evaluationCursor: {
      openTime: new Date(evaluationTime).toISOString(),
      closeTime: new Date(evaluationCloseTime).toISOString(),
      newYork: formatTime(evaluationTime, "America/New_York"),
      utc: formatTime(evaluationTime, "UTC"),
      visibleCandleCount: visibleEvaluation.length,
      futureCandleAccess: false,
    },
    reviewCursor: {
      closeTime: new Date(reviewTime).toISOString(),
      newYork: formatTime(reviewTime, "America/New_York"),
      utc: formatTime(reviewTime, "UTC"),
    },
    machineCandles,
    reviewCandles,
    premarketCandles,
    indicatorSeries,
    tradeEvents: buildTradeEvents(audit, trade, evaluationCloseTime, occurrence),
    coverage: buildCoverage(visibleReview, audit.tradingDate, calendar),
    outcomeContextEnd: new Date(reviewTime).toISOString(),
    futureCandleAccess: false,
    categoryAnchor,
    annotations: buildAnnotations(evaluationSnapshot, audit, trade, indicatorSeries, occurrence),
    machineEvidence: {
      quotesAvailable: report.executionMode === "quote_based_shadow",
      sourceSchema: report.executionMode === "quote_based_shadow" ? "quote_bbo" : "historical_ohlcv",
      audit,
      trade,
      market: {
        levels: evaluationSnapshot.levels,
        breakout: evaluationSnapshot.breakout,
        pullback: evaluationSnapshot.pullback,
        patience: evaluationSnapshot.patience,
        fibonacci: evaluationSnapshot.fibonacci,
        indicators: evaluationSnapshot.indicators,
        trend: evaluationSnapshot.trend,
        majorLevels: evaluationSnapshot.majorLevels,
      },
    },
    review: { status: "unreviewed", note: null, reviewedAt: null },
  };
}

export function buildVisualValidationSet(request: VisualValidationRequest): Omit<VisualValidationSet, "reviewSetId" | "createdAt"> {
  const formulaHash = formulaConfigurationHash({ symbol: request.symbol }, activeShadowStrategySnapshot().config);
  const fixtureReport: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode"> = {
    symbol: request.symbol,
    formulaHash,
    executionMode: "quote_based_shadow",
  };
  const fixtures = createVisualValidationFixtures(request);
  const sourceFingerprint = hashJson(fixtures.map((fixture) => datasetSourceFingerprint(fixture.dataset)).sort());
  const reviewPeriod = reviewPeriodForDataset(fixtures[0]?.dataset ?? {
    inSampleDates: [],
    outOfSampleDates: [],
  }, request.endDate);
  const orderedFixtures = [...fixtures].sort((first, second) => {
    const firstCandidate: ReviewCandidate = { audit: first.audit, trade: first.trade, category: first.category };
    const secondCandidate: ReviewCandidate = { audit: second.audit, trade: second.trade, category: second.category };
    return candidateSelectionRank(firstCandidate) - candidateSelectionRank(secondCandidate)
      || candidateOccurrenceTimestamp(firstCandidate) - candidateOccurrenceTimestamp(secondCandidate)
      || first.audit.id.localeCompare(second.audit.id);
  });
  const snapshots = orderedFixtures.map((fixture, index) => buildMachineSnapshot(
    fixtureReport,
    fixture.dataset,
    fixture.audit,
    fixture.trade,
    index + 1,
    fixture.category,
    fixture.reviewCloseTime,
    request.premarketAvailable !== false,
    undefined,
    candidateSelectionReason({ audit: fixture.audit, trade: fixture.trade, category: fixture.category }),
  ));
  return {
    buildId: APPLICATION_BUILD_ID,
    currentBuildId: APPLICATION_BUILD_ID,
    stale: false,
    formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
    sourceFingerprint,
    source: "simulated",
    symbol: request.symbol,
    request: { ...request, source: "simulated" },
    reviewPeriod,
    snapshots,
     tradeCandidates: buildTradeCandidates(snapshots),
    defaultSelectionReason: snapshots[0]?.selectionReason ?? "No retained occurrence is available.",
    categoryCoverage: VISUAL_VALIDATION_CATEGORIES.map((category) => ({
      category,
      label: categoryLabels[category],
      count: snapshots.filter((snapshot) => snapshot.category === category).length,
      available: snapshots.some((snapshot) => snapshot.category === category),
    })),
  };
}

export async function buildHistoricalVisualValidationSet(
  request: VisualValidationRequest,
): Promise<Omit<VisualValidationSet, "reviewSetId" | "createdAt">> {
  return buildHistoricalVisualValidationSetInWorker(request, 300_000);
}

export function buildHistoricalVisualValidationSetFromReport(
  request: VisualValidationRequest,
  dataset: CausalReplayDataset,
  report: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode" | "audit" | "trades">
    & Partial<Pick<BacktestReport, "dataset" | "contract" | "occurrences" | "tradeCandidates">>,
): Omit<VisualValidationSet, "reviewSetId" | "createdAt"> {
  const fixtureReport: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode"> = {
    symbol: request.symbol,
    formulaHash: formulaConfigurationHash({ symbol: request.symbol }, activeShadowStrategySnapshot().config),
    executionMode: "ohlcv_modeled",
  };
  const mode = visualValidationReviewMode(request);
  const visualIndex = createHistoricalVisualValidationIndex(
    dataset,
    sessionCalendarForContract(getFuturesContractSpecification(request.symbol)),
  );
  const ledgerCandidates: ReviewCandidate[] = report.occurrences?.flatMap((occurrence) => {
    const audit = auditForOccurrence(occurrence, report.audit, report.trades);
    if (!audit) return [];
    const category: VisualValidationCategory | null = occurrence.kind === "pullback"
      ? "pullback"
      : occurrence.kind === "patience"
        ? occurrence.direction === "long" ? "bullish_patience_candle" : occurrence.direction === "short" ? "bearish_patience_candle" : null
        : occurrence.kind === "risk"
          ? "rejected_setup"
          : "qualified_trade";
    if (!category) return [];
    const candidate = report.tradeCandidates?.find((item) => item.signalOccurrenceId === occurrence.occurrenceId);
    const authoritativeTrade = candidate
      ? matchingTradeForOccurrence(occurrence, audit, report.tradeCandidates ?? [], report.trades)
      : null;
    if (category === "qualified_trade" && (!candidate || !authoritativeTrade)) return [];
    const trade = category === "qualified_trade"
      ? authoritativeTrade
      : candidate
        ? authoritativeTrade
        : occurrence.canonicalTrade
          ? matchingTradeForOccurrence(occurrence, audit, [], report.trades) ?? matchingTrade(audit, report.trades)
          : null;
    const candidates: ReviewCandidate[] = [{ audit, trade, category, occurrence }];
    if (occurrence.kind === "patience" && occurrence.status === "SIGNAL_CONFIRMED") {
      if (candidate && authoritativeTrade) {
        candidates.push({ audit, trade: authoritativeTrade, category: "qualified_trade", occurrence });
      }
    }
    return candidates;
  }) ?? [];
  const uniqueLedgerCandidates = [...new Map(
    ledgerCandidates
      .filter((candidate): candidate is ReviewCandidate & { occurrence: HistoricalOccurrence } => Boolean(candidate.occurrence))
      .map((candidate) => [`${candidate.occurrence.occurrenceId}|${candidate.category}`, candidate]),
  ).values()];
  const ledgerCategoriesByAudit = new Set(
    uniqueLedgerCandidates.map((candidate) => `${candidate.audit.id}|${candidate.category}`),
  );
  const auditCandidates = report.audit.flatMap((audit) => {
    const trade = matchingTrade(audit, report.trades);
    return categoriesFor(audit, trade)
      .map((category) => ({ audit, trade, category, occurrence: undefined }))
      .filter((candidate) => candidate.category !== "qualified_trade")
      .filter((candidate) => !ledgerCategoriesByAudit.has(`${candidate.audit.id}|${candidate.category}`));
  });
  const candidates: ReviewCandidate[] = [
    ...uniqueLedgerCandidates,
    ...auditCandidates,
  ];
  const visibleCandidates = sortReviewCandidates(candidates)
      .filter((candidate) => mode === "trades_and_diagnostics"
        || (mode === "trades_only" && candidate.trade !== null)
        || (mode === "confirmed_signals"
          && candidate.occurrence !== undefined
          && hasConfirmedTradeOccurrence(candidate.occurrence)
          && (candidate.category !== "qualified_trade" || candidate.trade !== null)))
      .filter((candidate) => buildCategoryAnchor(
        candidate.category,
        candidate.audit,
        candidate.trade,
        dataset.candles,
        candidate.occurrence,
        undefined,
        visualIndex.completeCandlesByContract.get(candidate.audit.contractSymbol),
      ) !== null);
  const snapshots = visibleCandidates.map((candidate, candidateIndex) => {
    const reviewCloseTime = candidate.trade?.audit?.exitCandleCloseTime
      ? Date.parse(candidate.trade.audit.exitCandleCloseTime)
      : Date.parse(candidate.audit.evaluatedCandleOpenTime) + 5 * 60_000;
    return buildMachineSnapshot(
      fixtureReport,
      dataset,
      candidate.audit,
      candidate.trade,
      candidateIndex + 1,
      candidate.category,
      reviewCloseTime,
      request.premarketAvailable !== false,
      candidate.occurrence,
      candidateSelectionReason(candidate),
      visualIndex,
    );
  });
  const funnelDiagnostics = report.dataset && report.contract
    ? (() => {
        const funnel = buildQualificationFunnel([report as Pick<BacktestReport, "audit" | "trades" | "dataset" | "contract">]);
        const occurrences = report.occurrences ?? [];
        const primaryCount = occurrences.filter((occurrence) => isPrimaryEntryTimestamp(candidateOccurrenceTimestamp({
          audit: report.audit.find((item) => item.id === occurrence.auditId) ?? report.audit[0]!,
          trade: null,
          category: occurrence.kind === "pullback" ? "pullback" : occurrence.kind === "patience"
            ? occurrence.direction === "long" ? "bullish_patience_candle" : "bearish_patience_candle"
            : occurrence.kind === "trade" ? "qualified_trade" : "rejected_setup",
          occurrence,
        }))).length;
        return {
          sessionCount: funnel.sessionCount,
          candidateCount: funnel.candidateCount,
          occurrenceCount: funnel.occurrenceCount,
          stages: funnel.stages,
          rejectionCounts: funnel.rejectionCounts,
          window: {
            breakoutOccurrences: report.audit.filter((audit) => audit.breakoutEvidence.trim().length > 0).length,
            qualifyingPullbacks: occurrences.filter((occurrence) => occurrence.kind === "pullback").length,
            patienceCandidates: occurrences.filter((occurrence) => occurrence.kind === "patience").length,
            expiredPatienceCandidates: occurrences.filter((occurrence) => occurrence.kind === "patience" && !hasConfirmedPatienceOccurrence(occurrence)).length,
            confirmedPairs: occurrences.filter((occurrence) => occurrence.kind === "patience" && hasConfirmedPatienceOccurrence(occurrence)).length,
            riskApprovedEntries: occurrences.filter((occurrence) => occurrence.kind === "trade" && occurrence.canonicalTrade).length,
            primaryWindowOccurrences: primaryCount,
            outsidePrimaryWindowOccurrences: occurrences.length - primaryCount,
          },
        };
      })()
    : undefined;
  return {
    buildId: APPLICATION_BUILD_ID,
    currentBuildId: APPLICATION_BUILD_ID,
    stale: false,
    formulaHash: fixtureReport.formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
    sourceFingerprint: datasetSourceFingerprint(dataset),
    source: "historical_databento",
    symbol: request.symbol,
    request: { ...request, source: "historical_databento" },
    reviewPeriod: reviewPeriodForDataset(dataset, request.endDate),
    snapshots,
    tradeCandidates: buildTradeCandidates(snapshots),
    defaultSelectionReason: snapshots[0]?.selectionReason ?? "No retained occurrence is available.",
    categoryCoverage: VISUAL_VALIDATION_CATEGORIES.map((category) => ({
      category,
      label: categoryLabels[category],
      count: snapshots.filter((snapshot) => snapshot.category === category).length,
      available: snapshots.some((snapshot) => snapshot.category === category),
    })),
    ...(funnelDiagnostics ? { funnelDiagnostics } : {}),
  };
}

export { categoryLabels };