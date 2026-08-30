import { createHash, randomUUID } from "node:crypto";
import {
  createMarketSnapshot,
  type MarketSnapshot,
} from "./market-data.js";
import {
  visibleReplayPrefix,
  runCausalBacktest,
  type BacktestAuditRecord,
  type BacktestReport,
  type BacktestTrade,
  type CausalReplayDataset,
  buildQualificationFunnel,
  type QualificationFunnel,
} from "./phase9.js";
import { FIXED_FORMULA_VERSION, formulaConfigurationHash } from "./formula-hash.js";
import type { SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { createVisualValidationFixtures } from "./visual-validation-fixtures.js";
import {
  getReadyHistoricalMultiContractIndex,
  multiContractImportToReplayDataset,
  MULTI_CONTRACT_SOURCE,
} from "./futures/multi-contract-replay.js";
import {
  classifyFuturesSession,
  sessionCalendarForContract,
  sessionWindow,
  tradingDateForTimestamp,
} from "./futures/session-calendar.js";
import { causalEmaSeries } from "./strategy/indicators.js";
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

export type VisualValidationReviewPeriod = {
  startDate: string;
  endDate: string;
};

export type VisualValidationSet = {
  reviewSetId: string;
  createdAt: string;
  formulaHash: string;
  formulaVersion: string;
  source: "simulated" | "historical_databento";
  symbol: string;
  request: VisualValidationRequest;
  reviewPeriod: VisualValidationReviewPeriod;
  snapshots: VisualValidationSnapshot[];
  categoryCoverage: VisualValidationCategoryCoverage[];
  funnelDiagnostics?: Pick<QualificationFunnel, "sessionCount" | "candidateCount" | "stages" | "rejectionCounts">;
};

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
  entryBufferTicks: 3 | 4;
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
const TEACHING_ENTRY_WINDOW_START = 9 * 60 + 30;
const TEACHING_ENTRY_WINDOW_END = 14 * 60;

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function localMinute(value: string): number | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

function tickAligned(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value / TEACHING_TICK_SIZE - Math.round(value / TEACHING_TICK_SIZE)) < 1e-8;
}

function distanceToLevel(level: number, candleHigh: number, candleLow: number, rangeLow?: number | null, rangeHigh?: number | null): number {
  const low = rangeLow ?? level;
  const high = rangeHigh ?? level;
  if (candleHigh >= low && candleLow <= high) return 0;
  if (candleHigh < low) return low - candleHigh;
  return candleLow - high;
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
    ? distanceToLevel(valueAtInteraction, levelCandle.high, levelCandle.low, rangeLow, rangeHigh)
    : Number.POSITIVE_INFINITY;
  const distanceTicks = Number.isFinite(distancePoints)
    ? Math.ceil(Math.max(0, distancePoints) / TEACHING_TICK_SIZE - 1e-10)
    : Number.POSITIVE_INFINITY;
  const tolerancePoints = levelTolerancePoints(toleranceTicks);
  const qualifies = machineVisible && distancePoints <= tolerancePoints + 1e-10;
  const reason = !annotation
    ? `Level ${levelId} is not present in the immutable snapshot.`
    : !machineVisible
      ? `${annotation.label} is not machine-visible at L.`
      : !Number.isFinite(valueAtInteraction)
        ? `${annotation.label} has no causal value at L.`
        : qualifies
          ? `${annotation.label} at ${valueAtInteraction.toFixed(3)} is within ${distanceTicks} ticks at L.`
          : `Patience candle remained ${distanceTicks} ticks from ${annotation.label}.`;
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
    distanceTicks,
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
  const entryMinute = entry ? localMinute(entry.openTime) : null;
  const entryCloseMinute = entry ? localMinute(entry.closeTime) : null;
  if (entryMinute === null || entryCloseMinute === null || entryMinute < TEACHING_ENTRY_WINDOW_START || entryCloseMinute > TEACHING_ENTRY_WINDOW_END) {
    messages.push("The entry candle must be inside the 9:30 AM–2:00 PM ET primary entry window.");
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
        resolved: levelCandle && (annotation.id === "vwap" || annotation.id === "ema-200")
          ? resolveQualifyingLevelAtCandle(snapshot, levelCandle, annotation.id, levelToleranceTicks)
          : levelCandle
            ? {
                ...resolveQualifyingLevelAtCandle(snapshot, levelCandle, annotation.id, levelToleranceTicks),
                valueAtInteraction: level,
                distancePoints: distanceToLevel(level, levelCandle.high, levelCandle.low, annotation.rangeLow, annotation.rangeHigh),
                distanceTicks: Math.ceil(Math.max(0, distanceToLevel(level, levelCandle.high, levelCandle.low, annotation.rangeLow, annotation.rangeHigh)) / TEACHING_TICK_SIZE - 1e-10),
                rangeLow: annotation.rangeLow ?? null,
                rangeHigh: annotation.rangeHigh ?? null,
              }
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
  if (!Number.isInteger(input.entryBufferTicks) || ![3, 4].includes(input.entryBufferTicks)) messages.push("The entry buffer must be three or four ticks.");
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
    if (review.teaching?.entryBufferTicks === 3) likelyCauses.add("Reviewers are testing a three-tick confirmation buffer against the active four-tick formula.");
    if (review.teaching?.entryBufferTicks === 4) likelyCauses.add("Reviewers are testing the active four-tick confirmation buffer at a different qualifying level.");
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
    && trade.setupType === record.setupType
    && trade.direction === record.direction
    && trade.period === record.period,
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
    return exactPairs.some(([recordValue, tradeValue]) => recordValue !== null || tradeValue !== null)
      && exactPairs.every(([recordValue, tradeValue]) => recordValue === tradeValue);
  });
  return causalMatches.length === 1 ? causalMatches[0]! : null;
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
): AnchorEvent {
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
  qualified_trade: "Qualified trade found",
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

function anchorDetail(category: VisualValidationCategory, audit: BacktestAuditRecord): string {
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
): VisualValidationCategoryAnchor | null {
  const contractCandles = candles.filter((candle) => candle.contractSymbol === audit.contractSymbol && candle.isComplete);
  const anchorEvent = categoryAnchorEvent(category, audit, trade);
  const anchorCandle = resolvedAnchorCandle(anchorEvent, contractCandles);
  if (!anchorCandle) return null;
  const relatedEvents = [
    auditEvent("evaluation", audit.evaluatedCandleOpenTime, null, audit.entryTriggerPrice),
    auditEvent("patience", audit.patienceCandleOpenTime, audit.patienceCandleCloseTime, evidenceNumber(audit.patienceCandle, "close")),
    auditEvent("entry", audit.triggerCandleOpenTime, audit.triggerCandleCloseTime, evidenceNumber(audit.triggerCandle, "close") ?? audit.entryTriggerPrice),
    auditEvent("fill", audit.modeledFillObservationTime ?? trade?.audit?.modeledFillObservationTime, null, trade?.audit?.modeledFillPrice ?? trade?.entryPrice ?? null),
    auditEvent("exit", audit.exitCandleOpenTime ?? trade?.audit?.exitCandleOpenTime, audit.exitCandleCloseTime ?? trade?.audit?.exitCandleCloseTime, trade?.exitPrice ?? audit.targetPrice),
  ];
  const evaluationClose = Date.parse(audit.evaluatedCandleOpenTime) + 5 * 60_000;
  const relatedCandles = relatedEvents.flatMap((event) => {
    const candle = resolvedAnchorCandle(event, contractCandles);
    if (!candle) return [];
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
    detail: anchorDetail(category, audit),
    relatedCandles,
    visibility: anchorCandle.openTime <= evaluationClose ? "machine" : "human_only",
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

function buildAnnotations(snapshot: MarketSnapshot, audit: BacktestAuditRecord, trade: BacktestTrade | null, indicatorSeries: VisualValidationIndicatorPoint[] = []): VisualValidationAnnotation[] {
  const lines: VisualValidationAnnotation[] = [];
  const causalBoundary = Date.parse(audit.evaluatedCandleOpenTime) + 5 * 60_000;
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
  addLevel("previous-session-high", "PDH", snapshot.levels.previousDayHigh, "Previous completed regular-session high.");
  addLevel("previous-session-low", "PDL", snapshot.levels.previousDayLow, "Previous completed regular-session low.");
  addLevel("two-sessions-high", "2DH", snapshot.levels.dayBeforeYesterdayHigh, "High from two completed regular sessions back.");
  addLevel("two-sessions-low", "2DL", snapshot.levels.dayBeforeYesterdayLow, "Low from two completed regular sessions back.");
  addLevel("ntz-high", "NTZ high", snapshot.levels.ntzHigh, "No-trade zone upper boundary.");
  addLevel("ntz-low", "NTZ low", snapshot.levels.ntzLow, "No-trade zone lower boundary.");
  addIndicator("ema-200", "200 MA", patienceIndicator?.ema200 ?? snapshot.indicators.ema200, "Causal 200-period exponential moving average at the patience-candle timestamp.", "positive");
  addIndicator("vwap", "VWAP", patienceIndicator?.vwap ?? snapshot.indicators.vwap, "Causal regular-session volume-weighted average price at the patience-candle timestamp.", "negative");
  lines.push(annotation("orb-high", "ORB high", "price", snapshot.levels.openingRangeHigh, "accent", "Opening range upper boundary."));
  lines.push(annotation("orb-low", "ORB low", "price", snapshot.levels.openingRangeLow, "accent", "Opening range lower boundary."));
  for (const level of snapshot.levels.critical) addLevel(`critical-${level.name}`, `Critical · ${level.name}`, level.price, level.kind, "muted");
  for (const level of snapshot.majorLevels) {
    addLevel(`major-${level.name}`, level.name, level.price, `${level.kind} · ${level.confluence} confluence`, "muted");
  }
  const fibonacciAvailable = snapshot.pullback.events.length > 0
    && snapshot.fibonacci.classification !== "unavailable"
    && snapshot.fibonacci.levels.length > 0;
  if (fibonacciAvailable) {
    addLevel("fib-low-anchor", "Fibonacci low anchor", snapshot.fibonacci.impulseLow, "Frozen impulse low anchor after confirmed pullback interaction.", "blue");
    addLevel("fib-high-anchor", "Fibonacci high anchor", snapshot.fibonacci.impulseHigh, "Frozen impulse high anchor after confirmed pullback interaction.", "blue");
    for (const level of snapshot.fibonacci.levels) addLevel(`fib-${level.name}`, `Fib ${level.label}`, level.price, `${(level.ratio * 100).toFixed(1)}% retracement`, "blue");
  }

  const patienceOpen = evidenceTime(audit.patienceCandle, "openTime");
  const patienceClose = evidenceTime(audit.patienceCandle, "closeTime");
  const entryOpen = evidenceTime(audit.triggerCandle, "openTime");
  const entryClose = evidenceTime(audit.triggerCandle, "closeTime");
  const patiencePrice = evidenceNumber(audit.patienceCandle, "close");
  const entryPrice = evidenceNumber(audit.triggerCandle, "close");
  lines.push(annotation("patience-candle", "Patience candle", "candle", patiencePrice, "positive", snapshot.patience.detail, patienceOpen, patienceClose));
  lines.push(annotation("entry-candle", "Entry candle (E)", "candle", entryPrice, "accent", "The immediate-next candle after P; its buffered move authorizes the modeled entry.", entryOpen, entryClose));
  const modeledFillTime = audit.modeledFillObservationTime ? Date.parse(audit.modeledFillObservationTime) : trade?.audit?.modeledFillObservationTime ? Date.parse(trade.audit.modeledFillObservationTime) : trade ? Date.parse(trade.entryTime) : null;
  lines.push(annotation("modeled-fill", "Modeled fill", "candle", trade?.audit?.modeledFillPrice ?? trade?.entryPrice ?? null, "positive", "The modeled execution observation, not a live order or broker fill.", modeledFillTime, modeledFillTime, eventVisibility(modeledFillTime)));
  const entryBuffer = snapshot.patience.entryBufferPrice ?? audit.entryTriggerPrice;
  addLevel("entry-buffer", "Entry buffer", entryBuffer, `${snapshot.patience.entryBufferTicks}-tick confirmation buffer.`, "accent");
  addLevel("strategy-stop", "Strategy stop", audit.strategyStopPrice ?? snapshot.patience.strategyStopPrice, "Formula-defined thesis stop.", "negative");
  addLevel("catastrophe-stop", "Catastrophe stop", audit.catastropheStopPrice, "Hard catastrophe stop.", "negative");
  addLevel("target", "Target", audit.targetPrice ?? trade?.audit?.targetPrice ?? null, "Modeled target.", "positive");
  addLevel("runner-threshold", "Runner threshold", trade?.audit?.runnerReferencePrice ?? snapshot.riskPlan.runner.retracementThreshold ?? null, "Runner reference or retracement threshold.", "positive");
  const exitOpen = audit.exitCandleOpenTime ? Date.parse(audit.exitCandleOpenTime) : trade?.audit?.exitCandleOpenTime ? Date.parse(trade.audit.exitCandleOpenTime) : null;
  const exitClose = audit.exitCandleCloseTime ? Date.parse(audit.exitCandleCloseTime) : trade?.audit?.exitCandleCloseTime ? Date.parse(trade.audit.exitCandleCloseTime) : trade ? Date.parse(trade.exitTime) : null;
  const eventLabels = new Set([...(audit.eventLabels ?? []), ...(trade?.audit?.eventLabels ?? [])]);
  const stopHitTime = exitOpen ?? exitClose;
  if (eventLabels.has("STRATEGY_STOP_REACHED") || trade?.outcome === "strategy stop") {
    lines.push(annotation("strategy-stop-hit", "Strategy stop hit", "candle", audit.strategyStopPrice ?? trade?.audit?.strategyStopPrice ?? null, "negative", "The strategy stop was reached in the bounded execution outcome.", stopHitTime, exitClose, eventVisibility(stopHitTime)));
  }
  if (eventLabels.has("CATASTROPHE_STOP_REACHED") || trade?.outcome === "catastrophe stop") {
    lines.push(annotation("catastrophe-stop-hit", "Catastrophe stop hit", "candle", audit.catastropheStopPrice ?? trade?.audit?.catastropheStopPrice ?? null, "negative", "The catastrophe stop was reached in the bounded execution outcome.", stopHitTime, exitClose, eventVisibility(stopHitTime)));
  }
  if (eventLabels.has("TARGET_REACHED") || trade?.audit?.targetHit === true || trade?.outcome === "target") {
    lines.push(annotation("target-hit", "Target hit", "candle", audit.targetPrice ?? trade?.audit?.targetPrice ?? null, "positive", "The modeled target was reached.", exitOpen, exitClose, eventVisibility(exitOpen)));
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

function buildIndicatorSeries(
  historicalCandles: readonly SimulatedFuturesCandle[],
  displayedCandles: readonly SimulatedFuturesCandle[],
  evaluationCloseTime: number,
  tradingDate: string,
  contractSymbol: string,
  calendar: ReturnType<typeof sessionCalendarForContract>,
): VisualValidationIndicatorPoint[] {
  const config = strategyConfig();
  const orderedHistory = [...historicalCandles, ...displayedCandles]
    .filter((candle) =>
      candle.contractSymbol === contractSymbol
      && candle.isComplete
      && classifyFuturesSession(candle.openTime, calendar) !== "closed",
    )
    .sort((first, second) => first.closeTime - second.closeTime);
  const dedupedHistory = [...new Map(orderedHistory.map((candle) => [candle.openTime, candle])).values()];
  const emaSeries = causalEmaSeries(dedupedHistory, config.emaPeriod);
  const emaByOpenTime = new Map(emaSeries.points.map((point) => [point.candle.openTime, point.value]));
  const sourceStartTime = emaSeries.sourceStartTime === null ? null : new Date(emaSeries.sourceStartTime).toISOString();
  const sourceEndTime = emaSeries.sourceEndTime === null ? null : new Date(emaSeries.sourceEndTime).toISOString();
  const sessionCandles = regularSessionCandlesForDate(historicalCandles, tradingDate, contractSymbol, calendar);
  const sessionTotals = new Map<number, { priceVolume: number; volume: number }>();
  let priceVolume = 0;
  let volume = 0;
  for (const candle of sessionCandles) {
    priceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    volume += candle.volume;
    sessionTotals.set(candle.openTime, { priceVolume, volume });
  }
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
): VisualValidationTradeEvent[] {
  if (!trade) return [];
  const tradeAudit = trade.audit;
  const patienceOpen = evidenceTime(audit.patienceCandle, "openTime");
  const patienceClose = evidenceTime(audit.patienceCandle, "closeTime");
  const entryOpen = evidenceTime(audit.triggerCandle, "openTime");
  const entryClose = evidenceTime(audit.triggerCandle, "closeTime");
  const fillTime = tradeAudit?.modeledFillObservationTime
    ? Date.parse(tradeAudit.modeledFillObservationTime)
    : Date.parse(trade.entryTime);
  const exitOpen = tradeAudit?.exitCandleOpenTime ? Date.parse(tradeAudit.exitCandleOpenTime) : Date.parse(trade.exitTime);
  const exitClose = tradeAudit?.exitCandleCloseTime ? Date.parse(tradeAudit.exitCandleCloseTime) : Date.parse(trade.exitTime);
  const events: VisualValidationTradeEvent[] = [
    tradeEvent("patience", "patience", "P", audit.direction, patienceOpen, patienceClose, null, evidenceNumber(audit.patienceCandle, "close"), trade.contracts, "Validated patience candle.", evaluationCloseTime),
    tradeEvent("entry", "entry", "E", audit.direction, entryOpen, entryClose, audit.entryTriggerPrice, evidenceNumber(audit.triggerCandle, "close"), trade.contracts, "Immediate-next entry candle after P; no later candle can authorize entry.", evaluationCloseTime),
    tradeEvent("fill", "fill", `FILL ${trade.entryPrice.toFixed(2)}`, trade.direction, fillTime, fillTime, audit.entryTriggerPrice, trade.entryPrice, trade.contracts, "Modeled shadow entry observation; no live order was created.", evaluationCloseTime),
  ];
  if (trade.outcome === "strategy stop" || trade.outcome === "catastrophe stop") {
    events.push(tradeEvent("stop", "stop", "STOP", trade.direction, exitOpen, exitClose, audit.entryTriggerPrice, trade.exitPrice, trade.contracts, `${trade.outcome} exit.`, evaluationCloseTime));
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
  if (!window) {
    return [
      { session: "primary", expectedCandleCount: 42, observedCandleCount: 0, complete: false, missingIntervals: ["Regular session window unavailable."] },
      { session: "full_regular", expectedCandleCount: 78, observedCandleCount: 0, complete: false, missingIntervals: ["Regular session window unavailable."] },
    ];
  }
  const observed = new Set(regularCandles.map((candle) => candle.openTime));
  const build = (session: "primary" | "full_regular", expected: number) => {
    const missing: string[] = [];
    for (let index = 0; index < expected; index += 1) {
      const openTime = window.openTime + index * 5 * 60_000;
      if (!observed.has(openTime)) missing.push(formatMissingInterval(openTime, openTime + 5 * 60_000));
    }
    return {
      session,
      expectedCandleCount: expected,
      observedCandleCount: Math.min(regularCandles.length, expected),
      complete: missing.length === 0,
      missingIntervals: missing,
    };
  };
  return [build("primary", 42), build("full_regular", 78)];
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
): VisualValidationSnapshot {
  const evaluationTime = Date.parse(audit.evaluatedCandleOpenTime);
  const evaluationCloseTime = evaluationTime + 5 * 60_000;
  const exitTime = trade?.audit?.exitCandleCloseTime ? Date.parse(trade.audit.exitCandleCloseTime) : evaluationTime;
  const calendar = sessionCalendarForContract(getFuturesContractSpecification(report.symbol));
  const historicalCandles = dataset.candles.filter((candle) => candle.contractSymbol === audit.contractSymbol);
  const evaluationCandles = regularSessionCandlesForDate(historicalCandles, audit.tradingDate, audit.contractSymbol, calendar);
  const visibleEvaluation = visibleReplayPrefix(evaluationCandles, evaluationCloseTime);
  const regularWindow = sessionWindow(audit.tradingDate, "regular", calendar);
  const fullRegularEnd = regularWindow?.closeTime ?? reviewCloseTime;
  const reviewTime = Math.max(evaluationCloseTime, exitTime, reviewCloseTime, fullRegularEnd);
  const visibleReview = visibleReplayPrefix(evaluationCandles, reviewTime);
  const visiblePremarket = premarketAvailable
    ? historicalCandles
      .filter((candle) =>
        tradingDateForTimestamp(candle.openTime, calendar) === audit.tradingDate
        && classifyFuturesSession(candle.openTime, calendar) === "premarket"
        && candle.isComplete
        && candle.closeTime <= reviewTime,
      )
      .sort((first, second) => first.closeTime - second.closeTime)
    : [];
  const analysisCandles = [...visiblePremarket, ...visibleEvaluation];
  const evaluationSnapshot = createMarketSnapshot(
    report.symbol,
    "regular",
    undefined,
    undefined,
    { targetDollars: undefined, slippageMode: "normal" },
    {
      tradingDate: audit.tradingDate,
      cursor: evaluationCloseTime,
      allCandles: analysisCandles,
      historicalFeed: analysisCandles,
      allCandlesCompleted: true,
      premarketAvailable,
      executionMode: report.executionMode,
      validateDashboardInvariants: false,
      strategyConfigOverrides: activeShadowStrategySnapshot().config,
    },
  );
  const machineCandles = visibleEvaluation.map(toRawCandle);
  const reviewCandles = visibleReview.map(toRawCandle);
  const premarketCandles = visiblePremarket.map(toRawCandle);
  const categoryAnchor = buildCategoryAnchor(category, audit, trade, historicalCandles);
  const indicatorSeries = buildIndicatorSeries(
    historicalCandles,
    visibleReview,
    evaluationCloseTime,
    audit.tradingDate,
    audit.contractSymbol,
    calendar,
  );
  if (!categoryAnchor) throw new Error(`Category anchor could not resolve to a raw ${audit.contractSymbol} candle.`);
  const hash = createHash("sha256")
    .update(`${report.formulaHash}|${audit.id}|${category}`)
    .digest("hex")
    .slice(0, 16);
  return {
    snapshotId: `visual-${hash}`,
    sampleIndex,
    category,
    categoryLabel: categoryLabels[category],
    machineLabel: audit.rejectionCategory === "QUALIFIED" ? `${canonicalStrategyId(audit.setupType) ?? audit.setupType} qualified` : audit.rejectionSummary ?? audit.decision,
    strategyKey: canonicalStrategyId(audit.setupType) ?? "PATIENCE_CANDLE_CONTINUATION",
    formulaHash: report.formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
    symbol: report.symbol,
    contractSymbol: audit.contractSymbol,
    contractMonth: audit.contractMonth,
    tradingDate: audit.tradingDate,
    period: audit.period,
    evaluationCursor: {
      openTime: audit.evaluatedCandleOpenTime,
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
    tradeEvents: buildTradeEvents(audit, trade, evaluationCloseTime),
    coverage: buildCoverage(visibleReview, audit.tradingDate, calendar),
    outcomeContextEnd: new Date(reviewTime).toISOString(),
    futureCandleAccess: false,
    categoryAnchor,
    annotations: buildAnnotations(evaluationSnapshot, audit, trade, indicatorSeries),
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
  const formulaHash = formulaConfigurationHash({ symbol: request.symbol });
  const fixtureReport: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode"> = {
    symbol: request.symbol,
    formulaHash,
    executionMode: "quote_based_shadow",
  };
  const fixtures = createVisualValidationFixtures(request);
  const reviewPeriod = reviewPeriodForDataset(fixtures[0]?.dataset ?? {
    inSampleDates: [],
    outOfSampleDates: [],
  }, request.endDate);
  const snapshots = fixtures.map((fixture, index) => buildMachineSnapshot(
      fixtureReport,
      fixture.dataset,
      fixture.audit,
      fixture.trade,
      index + 1,
      fixture.category,
      fixture.reviewCloseTime,
      request.premarketAvailable !== false,
    ));
  return {
    formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
    source: "simulated",
    symbol: request.symbol,
    request: { ...request, source: "simulated" },
    reviewPeriod,
    snapshots,
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
  if (request.symbol !== "MES") {
    throw new Error("Historical Databento visual review supports MES only.");
  }
  const imported = await getReadyHistoricalMultiContractIndex();
  if (!imported) {
    throw new Error("Historical Databento visual review is unavailable because the ready multi-contract index was not found. Load the existing historical index before generating a review set.");
  }
  const firstEligibleDate = imported.summary.eligibleTradingDates[0];
  if (!firstEligibleDate) {
    throw new Error("Historical Databento visual review is unavailable because the ready index contains no eligible MES trading dates.");
  }
  const dataset = multiContractImportToReplayDataset(
    imported,
    firstEligibleDate,
    request.endDate,
    request.inSampleDays,
    request.outOfSampleDays,
  );
  const report = runCausalBacktest({
    symbol: request.symbol,
    endDate: request.endDate,
    inSampleDays: request.inSampleDays,
    outOfSampleDays: request.outOfSampleDays,
    premarketAvailable: request.premarketAvailable,
    source: MULTI_CONTRACT_SOURCE,
    executionMode: "ohlcv_modeled",
  }, undefined, dataset);
  return buildHistoricalVisualValidationSetFromReport(request, dataset, report);
}

export function buildHistoricalVisualValidationSetFromReport(
  request: VisualValidationRequest,
  dataset: CausalReplayDataset,
  report: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode" | "audit" | "trades">
    & Partial<Pick<BacktestReport, "dataset" | "contract">>,
): Omit<VisualValidationSet, "reviewSetId" | "createdAt"> {
  const fixtureReport: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode"> = {
    symbol: request.symbol,
    formulaHash: formulaConfigurationHash({ symbol: request.symbol }),
    executionMode: "ohlcv_modeled",
  };
  const mode = visualValidationReviewMode(request);
  const candidates = report.audit.flatMap((audit) => {
    const trade = matchingTrade(audit, report.trades);
    return categoriesFor(audit, trade)
      .map((category) => ({ audit, trade, category }))
      .filter((candidate) => mode === "trades_and_diagnostics"
        || candidate.trade !== null
        || (mode === "confirmed_signals" && hasConfirmedSignal(candidate.audit)))
      .filter((candidate) => buildCategoryAnchor(candidate.category, candidate.audit, candidate.trade, dataset.candles) !== null);
  });
  const snapshots = candidates.map((candidate, candidateIndex) => {
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
    );
  });
  const funnelDiagnostics = report.dataset && report.contract
    ? (() => {
        const funnel = buildQualificationFunnel([report as Pick<BacktestReport, "audit" | "trades" | "dataset" | "contract">]);
        return {
          sessionCount: funnel.sessionCount,
          candidateCount: funnel.candidateCount,
          stages: funnel.stages,
          rejectionCounts: funnel.rejectionCounts,
        };
      })()
    : undefined;
  return {
    formulaHash: fixtureReport.formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
    source: "historical_databento",
    symbol: request.symbol,
    request: { ...request, source: "historical_databento" },
    reviewPeriod: reviewPeriodForDataset(dataset, request.endDate),
    snapshots,
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