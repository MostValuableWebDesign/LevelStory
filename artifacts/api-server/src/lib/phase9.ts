import {
  createMarketSnapshot,
  type MarketSnapshot,
} from "./market-data";
import {
  getFuturesContractSpecification,
  type FuturesContractSpecification,
} from "./futures/contracts.js";
import {
  classifyFuturesSession,
  sessionCalendarForContract,
  sessionWindow,
  tradingDateForTimestamp,
  wallClockMinutesForTimestamp,
  type FuturesSessionCalendar,
} from "./futures/session-calendar.js";
import {
  completedSimulatedHourlyCandles,
  generateSimulatedFuturesFeed,
  type SimulatedHourlyCandle,
  type SimulatedFuturesCandle,
} from "./futures/simulated-feed.js";
import { simulatePhase8ShadowExecution } from "./strategy/phase8.js";
import {
  isExecutionAmbiguityLabel,
  MODELED_OHLCV_FILL_LABEL,
  PRIMARY_LEVEL_EXIT_ARMED_LABEL,
  PRIMARY_LEVEL_EXIT_REACHED_LABEL,
  simulateOhlcvExecution,
} from "./strategy/ohlcv-execution.js";
import type { ModeledExecutionLeg } from "./strategy/ohlcv-execution.js";
import { causalEmaSeries, regularSessionVwap } from "./strategy/indicators.js";
import {
  isTerminalPullbackArmState,
  reducePullbackArmLifecycles,
  samePullbackArmSignalIdentity,
  type PullbackArmSignalIdentity,
  type OrbBreakoutState,
  type PullbackArmLifecycleObservation,
  type PullbackArmState,
} from "./strategy/phase4.js";
import {
  isPatienceCandleOutsideNtz,
  patienceArmLifecycleTransitions,
  type PatienceOccurrence,
} from "./strategy/phase5.js";
import { authoritativePatienceStopPrice, effectiveConfirmationThreshold } from "./strategy/phase5.js";
import {
  evaluateConsolidationEntryGuard,
  type ConsolidationEntryEvidence,
} from "./strategy/phase6.js";
import type { Direction } from "./strategy/types.js";
import { canonicalStrategyId } from "./strategy/taxonomy.js";
import { parseMesContractSymbol } from "./futures/multi-contract-replay.js";
import { FIXED_FORMULA_VERSION, formulaConfigurationHash } from "./formula-hash.js";
import { createHash } from "node:crypto";
import { activeShadowStrategySnapshot } from "./active-shadow-strategy.js";
import { SHADOW_CONTRACTS_PER_TRADE, consolidationThresholds, type ConsolidationThresholds } from "./strategy/config.js";
import {
  buildKeyLevelTargetPlan,
  filterEligibleKeyLevelInputs,
  PROFIT_TARGET_BUFFER_TICKS,
  PROFIT_TARGET_PLACEMENT_TICKS,
  type KeyLevelTargetInput,
  type KeyLevelTargetPlan,
  type PrimaryLossExitReference,
  type TargetLevelSnapshot,
  primaryLossExitReferenceForPatience,
} from "./strategy/key-level-targets.js";

export type ReplayCursor = {
  cursor: number;
  visibleCandleCount: number;
  visibleCandleCloseTime: number | null;
  mode: "replay";
};

export type IntrabarBar = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  source: "tick" | "one-minute";
  /**
   * A one-minute OHLC bar can still contain an unknowable order between its
   * high and low. Tick points are ordered observations; bars are not.
   */
  sequenceKnown?: boolean;
};

export type IntrabarPoint = {
  timestamp: number;
  price: number;
  source: "tick";
};

export type IntrabarResolution = {
  status: "open" | "target" | "stop" | "ambiguous";
  source: "tick" | "one-minute" | "ohlc";
  timestamp: number | null;
  price: number | null;
  ambiguityLabel: "AMBIGUOUS_STOP_FIRST" | null;
      stopLevel?: "primary_level" | "strategy" | "catastrophe" | "structure_trailing" | "breakeven" | null;
  detail: string;
};

export type EntryResolution = {
  status: "accepted" | "ambiguous";
  price: number | null;
  label: "AMBIGUOUS_ENTRY_INVALIDATION" | null;
  detail: string;
};

export type CausalReplayDataset = {
  candles: readonly SimulatedFuturesCandle[];
  ticks?: readonly IntrabarPoint[];
  oneMinute?: readonly IntrabarBar[];
  contractSymbol: string;
  contractMonth: string;
  inSampleDates: readonly string[];
  outOfSampleDates: readonly string[];
  requestedStartDate?: string;
  requestedEndDate?: string;
  selectedDates?: readonly string[];
  excludedDates?: readonly string[];
  source?: "simulated" | "historical_databento" | "historical_databento_multicontract";
  contentFingerprint?: string;
  quotesAvailable?: boolean;
  gapReport?: BacktestGapReport;
  contractSchedule?: {
    version: string;
    activeContractByDate: readonly { tradingDate: string; contractSymbol: string }[];
    boundaries: readonly {
      effectiveDate: string;
      fromContractSymbol: string | null;
      toContractSymbol: string;
      scheduleVersion: string;
    }[];
  };
};

export type CausalReplayProgress = {
  completedSessions: number;
  totalSessions: number;
};

export type BacktestGapReport = {
  missingMinuteGaps: number;
  missingGapSegments: number;
  unexpectedMissingMinutes: number;
  unexpectedOpenSessionMissingMinutes: number;
  unexpectedOvernightMissingMinutes: number;
  unexpectedRegularSessionMissingMinutes: number;
  regularSessionGapSegments: number;
  overnightGapSegments: number;
  regularSessionMissingMinutes: number;
  expectedClosedMarketMinutes: number;
  expectedClosedMinutes: number;
  weekendHolidayClosedMinutes: number;
  earlyCloseMinutes: number;
  inactiveContractMinutes: number;
  lowLiquidityInactiveMinutes: number;
  coverageScope: "full_file" | "selected_dates" | "multi_contract";
  inactiveContractThresholdPercent: number;
  inactiveContractDays: number;
  missingRegularSessionDates: string[];
  missingOvernightSessionDates: string[];
  completeRegularSessionDates: string[];
  maintenanceGapMinutes: number;
  weekendHolidayGapMinutes: number;
  earlyCloseDates: string[];
  overnightCoverageObserved: boolean;
};

export type ReplayDatasetOptions = {
  endDate: string;
  inSampleDays: number;
  outOfSampleDays: number;
  seed?: number;
  premarketAvailable?: boolean;
};

export type BacktestRequest = ReplayDatasetOptions & {
  symbol: string;
  startDate?: string;
  source?: "simulated" | "historical_databento" | "historical_databento_multicontract";
  targetDollars?: number;
  slippageMode?: "normal" | "fast" | "abnormal_spread";
  executionMode?: "quote_based_shadow" | "ohlcv_modeled";
  ohlcvEntryBufferTicks?: 8;
  ohlcvStopBufferTicks?: number;
  ohlcvSlippageTicks?: number;
  ohlcvCommissionPerContract?: number;
};

export type CandidateCausalIdentity = {
  signalOccurrenceId: string;
  eligibilityArmId: string | null;
  activeConsolidationZoneId: string | null;
  /** Stable identity for this independent entry attempt within the shared arm. */
  armAttemptId?: string;
  /** One-based attempt number for authoritative entries on the shared arm. */
  attemptOrdinal?: number;
};

export type CandidateAttemptState =
  | "FIRST_ENTRY_CONFIRMED"
  | "FIRST_TRADE_ACTIVE"
  | "FIRST_TRADE_STOPPED"
  | "REENTRY_ELIGIBLE"
  | "SECOND_ENTRY_CONFIRMED"
  | "SECOND_TRADE_ACTIVE"
  | "ARM_RETIRED_AFTER_TWO_LOSSES"
  | "ARM_RETIRED_AFTER_ATTEMPT_LIMIT"
  | "ARM_STRUCTURALLY_INVALIDATED";

export type CandidateAttemptGrade = "B" | "A" | "A+" | "A++";

export type BacktestTrade = {
  id: string;
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  period: "in_sample" | "out_of_sample";
  setupType: string;
  direction: Direction;
  entryTime: string;
  exitTime: string | null;
  entryPrice: number;
  exitPrice: number | null;
  contracts: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
   outcome: "target" | "strategy stop" | "catastrophe stop" | "session close" | "breakeven" | "breakeven recovery" | "manual" | "open";
  ambiguityLabel: string | null;
  source: "tick" | "one-minute" | "ohlc";
  segmentation: BacktestSegmentation;
  executionMode?: "quote_based_shadow" | "ohlcv_modeled";
  fillLabel?: string | null;
  primaryEdge?: string;
  matchedEdges?: string[];
  supportingConfluences?: string[];
  setupGrade?: "A" | "A+" | "A++";
  causalIdentity?: CandidateCausalIdentity;
  signalOccurrenceId?: string;
  candidateId?: string;
  armAttemptId?: string;
  attemptOrdinal?: number;
  attemptGrade?: CandidateAttemptGrade;
  targetPlan?: KeyLevelTargetPlan;
  patienceCandle?: Record<string, number | boolean> | null;
  entryCandle?: Record<string, number | boolean> | null;
  audit?: {
    entryTriggerPrice: number | null;
    modeledFillPrice: number | null;
    stopPrice: number | null;
    targetPrice: number | null;
     targetPlan?: KeyLevelTargetPlan;
    strategyStopPrice?: number | null;
    catastropheStopPrice?: number | null;
     stopLevel?: "primary_level" | "strategy" | "catastrophe" | "structure_trailing" | "breakeven" | null;
     causalIdentity?: CandidateCausalIdentity;
      armAttemptId?: string;
      attemptOrdinal?: number;
      attemptGrade?: CandidateAttemptGrade;
    primaryLossExitLevel?: PrimaryLossExitReference | null;
    patienceCandleOpenTime: string | null;
    patienceCandleCloseTime: string | null;
    triggerCandleOpenTime: string | null;
    triggerCandleCloseTime: string | null;
    modeledFillObservationTime: string | null;
    exitCandleOpenTime: string | null;
    exitCandleCloseTime: string | null;
    assumptions: string[];
    eventLabels: string[];
    ambiguityLabels: string[];
    targetHit: boolean;
    runnerActivated: boolean;
    runnerExited: boolean;
    runnerReferencePrice?: number | null;
    runnerImpulse?: number | null;
    runnerMostFavorablePrice?: number | null;
     initialRiskPoints?: number | null;
     oneRPrice?: number | null;
     oneRReached?: boolean;
     profitCheckpointPrice?: number | null;
     trailingStopPrice?: number | null;
     trailingStopActive?: boolean;
     trailingStopSource?: string | null;
    remainingQuantity?: number;
     noForwardLevelAtEntry?: boolean;
     postEntryCompletedBars?: number;
     breakevenActivationBars?: number | null;
     breakevenActivated?: boolean;
      breakevenActivationTimestamp?: string | null;
      breakevenEffectiveFromTimestamp?: string | null;
     breakevenPrice?: number | null;
     breakevenDisposition?: string;
     originalStopStillActive?: boolean;
    exitReason: string;
    legs: ModeledExecutionLeg[];
  };
};

export type BacktestConsolidationGuardEvidence = {
  detectorVersion: string;
  lifecycleState: ConsolidationEntryEvidence["lifecycleState"];
  lifecycleStates: ConsolidationEntryEvidence["lifecycleStates"];
  zoneDetected: boolean;
  activeZone: boolean;
  executionEligible: boolean;
  consolidationZoneHigh: number | null;
  consolidationZoneLow: number | null;
  activeConsolidationZoneId?: string | null;
  consolidationStartTime: string | null;
  consolidationDetectionTime: string | null;
  sourceCandleTimestamps: string[];
  rangeWidth: number | null;
  rangeWidthTicks: number | null;
  causalVolatilityBaseline: number | null;
  compressionRatio: number | null;
  overlapRatio: number | null;
  completedCandleCount: number;
  highRejectionCount: number;
  lowRejectionCount: number;
  maxDirectionalSequence: number;
  diagnosticRangeCapExceeded: boolean;
  qualificationReason: string | null;
  direction: Direction | null;
  patienceOpenTime: string | null;
  patienceCloseTime: string | null;
  entryOpenTime: string | null;
  entryCloseTime: string | null;
  confirmationThreshold: number | null;
  patienceConfirmationThreshold?: number | null;
  consolidationBoundaryThreshold?: number | null;
  effectiveEntryThreshold?: number | null;
  entryClose: number | null;
  entryCompleted: boolean;
  entryReachedConfirmation: boolean | null;
  effectiveEntryThresholdReached?: boolean | null;
  entryOpenedOutsideZone?: boolean | null;
  entryClosedOutsideZone?: boolean | null;
  entryCloseOutsideZone: boolean | null;
  entryRangeOutsideZone: boolean | null;
  entryRangeOverlappedZone?: boolean | null;
  entryFillOutsideZone?: boolean | null;
  entryOutsideFinalizedNtz: boolean | null;
  entryBeforeCutoff: boolean | null;
  consolidationEdgeQualified: boolean;
  breakoutPullback: boolean;
  consolidationEntryDisposition?: string;
  rejectionReason: string | null;
  detail: string;
};

function serializeConsolidationGuard(
  evidence: ConsolidationEntryEvidence | null,
): BacktestConsolidationGuardEvidence | null {
  if (!evidence) return null;
  const iso = (timestamp: number | null): string | null =>
    timestamp !== null && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  return {
    detectorVersion: evidence.detectorVersion,
    lifecycleState: evidence.lifecycleState,
    lifecycleStates: evidence.lifecycleStates,
    zoneDetected: evidence.zoneDetected,
    activeZone: evidence.activeZone,
    executionEligible: evidence.executionEligible,
    consolidationZoneHigh: evidence.consolidationZoneHigh,
    consolidationZoneLow: evidence.consolidationZoneLow,
    activeConsolidationZoneId: evidence.activeConsolidationZoneId,
    consolidationStartTime: iso(evidence.consolidationStartTime),
    consolidationDetectionTime: iso(evidence.consolidationDetectionTime),
    sourceCandleTimestamps: evidence.sourceCandleOpenTimes
      .filter((timestamp) => Number.isFinite(timestamp))
      .map((timestamp) => new Date(timestamp).toISOString()),
    rangeWidth: evidence.rangeWidth,
    rangeWidthTicks: evidence.rangeWidthTicks,
    causalVolatilityBaseline: evidence.causalVolatilityBaseline,
    compressionRatio: evidence.compressionRatio,
    overlapRatio: evidence.overlapRatio,
    completedCandleCount: evidence.completedCandleCount,
    highRejectionCount: evidence.highRejectionCount,
    lowRejectionCount: evidence.lowRejectionCount,
    maxDirectionalSequence: evidence.maxDirectionalSequence,
    diagnosticRangeCapExceeded: evidence.diagnosticRangeCapExceeded,
    qualificationReason: evidence.qualificationReason,
    direction: evidence.direction,
    patienceOpenTime: iso(evidence.patienceOpenTime),
    patienceCloseTime: iso(evidence.patienceCloseTime),
    entryOpenTime: iso(evidence.entryOpenTime),
    entryCloseTime: iso(evidence.entryCloseTime),
    confirmationThreshold: evidence.confirmationThreshold,
    patienceConfirmationThreshold: evidence.patienceConfirmationThreshold,
    consolidationBoundaryThreshold: evidence.consolidationBoundaryThreshold,
    effectiveEntryThreshold: evidence.effectiveEntryThreshold,
    entryClose: evidence.entryClose,
    entryCompleted: evidence.entryCompleted,
    entryReachedConfirmation: evidence.entryReachedConfirmation,
    effectiveEntryThresholdReached: evidence.effectiveEntryThresholdReached,
    entryOpenedOutsideZone: evidence.entryOpenedOutsideZone,
    entryClosedOutsideZone: evidence.entryClosedOutsideZone,
    entryCloseOutsideZone: evidence.entryCloseOutsideZone,
    entryRangeOutsideZone: evidence.entryRangeOutsideZone,
    entryRangeOverlappedZone: evidence.entryRangeOverlappedZone,
    entryFillOutsideZone: evidence.entryFillOutsideZone,
    entryOutsideFinalizedNtz: evidence.entryOutsideFinalizedNtz,
    entryBeforeCutoff: evidence.entryBeforeCutoff,
    consolidationEdgeQualified: evidence.consolidationEdgeQualified,
    breakoutPullback: evidence.breakoutPullback,
    consolidationEntryDisposition: evidence.consolidationEntryDisposition,
    rejectionReason: evidence.rejectionReason,
    detail: evidence.detail,
  };
}

export type BacktestAuditRecord = {
  id: string;
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  period: "in_sample" | "out_of_sample";
  evaluatedCandleOpenTime: string;
  setupType: string;
  direction: Direction | null;
  decision: string;
  alertOnly: boolean;
  rejectionReason: string | null;
  rejectionCategory: "WAITING" | "FAILURE" | "EXPIRED" | "AMBIGUITY" | "RISK_REJECTION" | "POSITION_ACTIVE" | "QUALIFIED";
  rejectionSummary: string | null;
  ruleEvidence: string[];
  orbState: string;
  breakoutEvidence: string;
  volumeEvidence: string;
  pullbackEvidence: string;
  criticalLevelEvidence: string;
  trendEvidence: string;
  patienceState: string;
  patienceCandle: Record<string, number | boolean> | null;
  triggerCandle: Record<string, number | boolean> | null;
  patienceCandleOpenTime: string | null;
  patienceCandleCloseTime: string | null;
  patienceCandleExtreme?: number | null;
  stopBufferTicks?: number | null;
  stopBufferPoints?: number | null;
  finalStrategyStopBoundary?: number | null;
  stopDirection?: Direction | null;
  stopSourceAuditId?: string | null;
  triggerCandleOpenTime: string | null;
  triggerCandleCloseTime: string | null;
  modeledFillObservationTime: string | null;
  exitCandleOpenTime: string | null;
  exitCandleCloseTime: string | null;
  entryTriggerPrice: number | null;
  patienceConfirmationThreshold?: number | null;
  consolidationBoundaryThreshold?: number | null;
  effectiveEntryThreshold?: number | null;
  effectiveEntryThresholdReached?: boolean | null;
  entryOpenedOutsideZone?: boolean | null;
  entryClosedOutsideZone?: boolean | null;
  entryRangeOverlappedZone?: boolean | null;
  entryFillOutsideZone?: boolean | null;
  consolidationEntryDisposition?: string;
  strategyStopPrice: number | null;
  catastropheStopPrice: number | null;
  targetPrice: number | null;
  targetPlan?: KeyLevelTargetPlan;
  targetLevelInputs?: KeyLevelTargetInput[];
  contracts?: number | null;
  eventLabels: string[];
  ambiguityLabels: string[];
  executionMode: "quote_based_shadow" | "ohlcv_modeled";
  fees: number;
  slippage: number;
  grossPnl: number | null;
  netPnl: number | null;
  exitReason: string | null;
  confirmationBufferTicks?: number;
  pullbackArmId?: string | null;
  pullbackArmState?: PullbackArmState;
  pullbackArmTransitions?: Array<{ from: PullbackArmState | null; to: PullbackArmState; time: string; reason: string }>;
  latePullbackInteractions?: number;
  finalizedNtzHigh?: number | null;
  finalizedNtzLow?: number | null;
  finalizedNtzComplete?: boolean;
  supportingConfluences?: string[];
  setupGrade?: "A" | "A+" | "A++";
  noForwardLevelAtEntry?: boolean;
  postEntryCompletedBars?: number;
  breakevenActivationBars?: number | null;
  breakevenActivated?: boolean;
  breakevenActivationTimestamp?: string | null;
  breakevenEffectiveFromTimestamp?: string | null;
  breakevenPrice?: number | null;
  breakevenDisposition?: string;
  originalStopStillActive?: boolean;
  consolidationThresholds: ConsolidationThresholds;
  consolidationGuard?: BacktestConsolidationGuardEvidence | null;
  pullbackOccurrences?: Array<{
    eventId?: string;
    armId?: string;
    type: string;
    time: string;
    level: string;
    price: number;
    distancePoints?: number;
    distanceTicks?: number;
    tolerancePoints?: number;
    toleranceTicks?: number;
    qualifies?: boolean;
    candle?: { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number };
    detail: string;
  }>;
  patienceOccurrences?: PatienceOccurrence[];
};

export type BacktestSegmentation = {
  contract: string;
  contractMonth: string;
  setupType: string;
  direction: Direction;
  timeOfDay: "open" | "midday" | "close";
  trend: "bullish" | "bearish" | "neutral";
  fibonacciDepth: string;
  volumeCondition: "supported" | "warning" | "neutral";
  levelType: "NTZ" | "ORB" | "major level" | "Fibonacci" | "mixed" | "unmapped";
  confluence: "normal" | "strong" | "dynamite";
  patienceCharacteristic: string;
  orbState: OrbBreakoutState;
  marketRegime: "trend" | "range" | "transition";
};

export type BacktestMetrics = {
  tradeCount: number;
  winRate: number;
  averageWin: number | null;
  averageLoss: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  maximumDrawdown: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  ambiguousTradeCount: number;
  rejectedSetupCount: number;
  setupsDetected: number;
  setupsRejected: number;
  patienceCandles: number;
  entryTriggers: number;
  modeledFills: number;
  stopExits: number;
  targetExits: number;
  runnerExits: number;
  ambiguityCount: number;
  ambiguousExitCount: number;
  expiredPatienceSetups: number;
  ambiguousEntryCount: number;
  strategyStopExits: number;
  catastropheStopExits: number;
  sessionCloseExits: number;
  partialTargetExits: number;
  consecutiveLosses: number;
};

export type BacktestExecutionSummary = {
  eligibleCandidateCount: number;
  enteredTradeCount: number;
  finalizedTradeCount: number;
  openTradeCount: number;
  ambiguousEntryCount: number;
  unresolvedAmbiguousTradeCount: number;
  conservativelyResolvedTradeCount: number;
  unscoredTradeCount: number;
};

export type BacktestSegment = BacktestMetrics & {
  dimension: string;
  value: string;
};

export type BacktestRuntimeTiming = {
  preparationMs: number;
  cacheLookupMs: number;
  cacheStoreMs: number;
  workerStartupMs: number;
  workerMs: number;
  responseValidationMs: number;
  totalMs: number;
};

export type BacktestReport = {
  mode: "SHADOW MODE — NO LIVE ORDERS";
  dataSource: "simulated" | "historical_databento" | "historical_databento_multicontract";
  symbol: string;
  formulaHash: string;
  contract: FuturesContractSpecification;
  dataResolution: "tick" | "one-minute-fallback";
  dataset: {
    startDate: string;
    endDate: string;
    requestedStartDate: string;
    requestedEndDate: string;
    selectedDates: string[];
    inSampleDates: string[];
    outOfSampleDates: string[];
    excludedDates: string[];
    untouchedOutOfSample: true;
    optimizationApplied: false;
    scheduleVersion?: string | null;
    rolloverBoundaries?: readonly {
      effectiveDate: string;
      fromContractSymbol: string | null;
      toContractSymbol: string;
      scheduleVersion: string;
    }[];
    activeContractByDate?: readonly { tradingDate: string; contractSymbol: string }[];
  };
  replay: ReplayCursor & {
    totalCandleCount: number;
    causal: true;
    futureCandleAccess: false;
  };
  metrics: BacktestMetrics;
  executionSummary: BacktestExecutionSummary;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  segments: BacktestSegment[];
  trades: BacktestTrade[];
  tradeCandidates: HistoricalTradeCandidate[];
  rejectedCandidateSignals: RejectedCandidateSignal[];
  orphanModeledTrades: OrphanModeledTrade[];
  audit: BacktestAuditRecord[];
  occurrences: HistoricalOccurrence[];
  diagnostics?: HistoricalReplayDiagnostics;
  auditPage?: {
    runId: string;
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
  timing?: BacktestRuntimeTiming;
  assumptions: string[];
  executionMode: "quote_based_shadow" | "ohlcv_modeled";
  fillLabel: string;
  executionPolicy: {
    entryBufferTicks: number;
    immediateNextCandleOnly: true;
    entrySlippageTicks: number;
    exitSlippageTicks: number;
    stopRule: string;
    ambiguityRule: string;
    commissionPerContract: number;
  };
  gapReport: BacktestGapReport;
};

export type HistoricalTradeCandidate = {
  candidateId: string;
  signalOccurrenceId: string;
  sourceFingerprint: string;
  formulaHash: string;
  formulaVersion: string;
  contractSymbol: string;
  tradingDate: string;
  direction: "long" | "short";
  primaryEdge: string;
  matchedEdges: string[];
  supportingConfluences: string[];
  qualifyingLevelIdentifiers: string[];
  qualifyingLevelValues: Record<string, number>;
  /** The P candle open; retained as physical identity evidence. */
  pOpenTimestamp: string;
  /** The immediate E candle open; retained as physical identity evidence. */
  eOpenTimestamp: string;
  /** The completed E candle close where threshold confirmation is observed. */
  entryObservationTimestamp: string;
  patienceTimestamp: string;
  expectedEntryTimestamp: string;
  confirmationPrice: number | null;
  confirmationBufferTicks: number;
  grade: "A" | "A+" | "A++";
  causalIdentity: CandidateCausalIdentity;
  armAttemptId?: string;
  attemptOrdinal?: number;
  entryAttemptCount?: number;
  attemptGrade?: CandidateAttemptGrade;
  attemptState?: CandidateAttemptState;
  firstCandidateId?: string;
  firstTradeId?: string;
  secondCandidateId?: string;
  secondTradeId?: string;
  firstExitTimestamp?: string | null;
  firstExitReason?: string | null;
  reentryEligible?: boolean;
  reentryEligibilityReason?: string;
  armRetirementReason?: string | null;
  eligible: true;
  executionStatus: "MODELED_TRADE_CREATED" | "ENTRY_NOT_REACHED" | "ENTRY_AMBIGUOUS" | "INSUFFICIENT_CANDLE_DATA";
  fillModelType: "OHLCV_CONFIRMATION_THRESHOLD";
  patienceHigh: number | null;
  patienceLow: number | null;
  entryHigh: number | null;
  entryLow: number | null;
  entryReachedThreshold: boolean | null;
  strategyStopPrice?: number | null;
  targetPlan?: KeyLevelTargetPlan;
  targetDisposition?: "KEY_LEVEL_SELECTED" | "NO_ELIGIBLE_KEY_LEVEL";
  managementContext?: CandidateManagementContext;
};

export type CandidateManagementContext = {
  candidateId: string;
  causalIdentity: CandidateCausalIdentity;
  signalOccurrenceId: string;
  armAttemptId?: string;
  attemptOrdinal?: number;
  patienceCandleOpenTime: string | null;
  patienceCandleHigh: number | null;
  patienceCandleLow: number | null;
  stopBufferTicks: 12;
  tickSize: 0.25;
  derivedStrategyStop: number | null;
  targetPlan?: KeyLevelTargetPlan;
  frozenAt: string;
  direction: Direction;
  contracts: number;
  entryPrice: number;
  strategyStopPrice: number | null;
  primaryLossExitLevel?: PrimaryLossExitReference | null;
  catastropheStopPrice: number | null;
  targetPrice: number | null;
  runnerActivationPrice: number | null;
  runnerExitRule: string | null;
  sessionCloseTime: string | null;
  sourceAuditId: string;
  managementEvidenceStatus: "complete" | "missing" | "invalid";
  missingEvidenceReasons: string[];
};

function candidateManagementValidationReasons(
  context: CandidateManagementContext,
  entryObservationTimestamp: string | null,
): string[] {
  const reasons: string[] = [];
  if (context.managementEvidenceStatus !== "complete") reasons.push("managementEvidenceStatus");
  if (context.missingEvidenceReasons.length > 0) reasons.push("missingEvidenceReasons");
  const finitePrices = [
    ["entryPrice", context.entryPrice],
    ["strategyStopPrice", context.strategyStopPrice],
  ] as const;
  for (const [name, value] of finitePrices) {
    if (value === null) reasons.push(name);
    else if (!Number.isFinite(value)) reasons.push(`${name}_NOT_FINITE`);
  }
  if (context.targetPlan?.disposition === "KEY_LEVEL_SELECTED") {
    if (context.targetPrice === null) reasons.push("targetPrice");
    else if (!Number.isFinite(context.targetPrice)) reasons.push("targetPrice_NOT_FINITE");
  }
  if (!Number.isInteger(context.contracts) || context.contracts <= 0) reasons.push("contracts");
  if (context.sessionCloseTime === null || !Number.isFinite(Date.parse(context.sessionCloseTime))) {
    reasons.push("sessionCloseTime");
  }
  const frozenAt = Date.parse(context.frozenAt);
  const observedAt = entryObservationTimestamp === null ? Number.NaN : Date.parse(entryObservationTimestamp);
  if (!Number.isFinite(frozenAt)) reasons.push("frozenAt");
  if (!Number.isFinite(observedAt)) reasons.push("entryObservationTimestamp");
  else if (Number.isFinite(frozenAt) && frozenAt > observedAt) reasons.push("frozenAt_after_entry_observation");
  if (context.strategyStopPrice !== null) {
    if (context.direction === "long") {
      if (!(context.strategyStopPrice < context.entryPrice)) {
        reasons.push("LONG_STOP_TARGET_ORDER");
      }
    } else if (!(context.entryPrice < context.strategyStopPrice)) {
      reasons.push("SHORT_STOP_TARGET_ORDER");
    }
  }
  if (context.targetPlan?.disposition === "KEY_LEVEL_SELECTED" && context.targetPrice !== null) {
    if (context.direction === "long" && !(context.entryPrice < context.targetPrice)) {
      reasons.push("LONG_STOP_TARGET_ORDER");
    }
    if (context.direction === "short" && !(context.targetPrice < context.entryPrice)) {
      reasons.push("SHORT_STOP_TARGET_ORDER");
    }
  }
  const hasRunnerActivation = context.runnerActivationPrice !== null;
  const hasRunnerRule = context.runnerExitRule !== null;
  if (hasRunnerActivation !== hasRunnerRule) {
    reasons.push("runnerSettings_incomplete");
  } else if (hasRunnerActivation && context.runnerExitRule!.trim().length === 0) {
    reasons.push("runnerExitRule");
  } else if (hasRunnerActivation) {
    if (!Number.isFinite(context.runnerActivationPrice)) {
      reasons.push("runnerActivationPrice_NOT_FINITE");
    } else if (
      (context.direction === "long" && context.runnerActivationPrice! <= context.entryPrice)
      || (context.direction === "short" && context.runnerActivationPrice! >= context.entryPrice)
    ) {
      reasons.push("runnerActivationPrice_order");
    }
  }
  if (Number.isFinite(Date.parse(context.sessionCloseTime ?? ""))
    && Number.isFinite(observedAt)
    && Date.parse(context.sessionCloseTime!) <= observedAt) {
    reasons.push("sessionCloseTime_before_entry_observation");
  }
  return [...new Set(reasons)];
}

export function isValidCandidateManagementContext(candidate: HistoricalTradeCandidate): boolean {
  const context = candidate.managementContext;
  return context !== undefined
    && context.managementEvidenceStatus === "complete"
    && candidateManagementValidationReasons(context, candidate.entryObservationTimestamp).length === 0;
}

function candidateIdentityViolations(occurrence: HistoricalOccurrence): string[] {
  const violations = [...(occurrence.identityInvariantViolations ?? [])];
  const requiredText = [
    ["sourceFingerprint", occurrence.sourceFingerprint],
    ["formulaHash", occurrence.formulaHash],
    ["contractSymbol", occurrence.contractSymbol],
    ["tradingDate", occurrence.tradingDate],
    ["pOpenTimestamp", occurrence.pOpenTimestamp],
    ["eOpenTimestamp", occurrence.eOpenTimestamp],
    ["entryObservationTimestamp", occurrence.entryObservationTimestamp],
  ] as const;
  for (const [field, value] of requiredText) {
    if (typeof value !== "string" || value.trim().length === 0) {
      violations.push(`MISSING_OR_INVALID_${field}`);
    }
  }
  if (typeof occurrence.sourceFingerprint === "string"
    && !/^[0-9a-f]{64}$/i.test(occurrence.sourceFingerprint)) {
    violations.push("INVALID_sourceFingerprint");
  }
  if (typeof occurrence.formulaHash === "string"
    && !/^[0-9a-f]{64}$/i.test(occurrence.formulaHash)) {
    violations.push("INVALID_formulaHash");
  }
  if (typeof occurrence.contractSymbol === "string"
    && occurrence.contractSymbol.trim().length > 0
    && !parseMesContractSymbol(occurrence.contractSymbol)) {
    violations.push("INVALID_contractSymbol");
  }
  if (typeof occurrence.tradingDate === "string"
    && !/^\d{4}-\d{2}-\d{2}$/.test(occurrence.tradingDate)) {
    violations.push("INVALID_tradingDate");
  } else if (typeof occurrence.tradingDate === "string"
    && (
      !Number.isFinite(Date.parse(`${occurrence.tradingDate}T00:00:00.000Z`))
      || new Date(`${occurrence.tradingDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== occurrence.tradingDate
    )) {
    violations.push("INVALID_tradingDate");
  }
  if (occurrence.direction !== "long" && occurrence.direction !== "short") {
    violations.push("MISSING_OR_INVALID_direction");
  }
  for (const [field, value] of [
    ["pOpenTimestamp", occurrence.pOpenTimestamp],
    ["eOpenTimestamp", occurrence.eOpenTimestamp],
    ["entryObservationTimestamp", occurrence.entryObservationTimestamp],
  ] as const) {
    if (typeof value === "string" && value.trim().length > 0 && !Number.isFinite(Date.parse(value))) {
      violations.push(`INVALID_${field}`);
    }
  }
  return [...new Set(violations)];
}
type CandidateEntryDisposition = {
  status: HistoricalTradeCandidate["executionStatus"];
  reached: boolean | null;
};

export type RejectedCandidateSignal = {
  signalOccurrenceId: string;
  reasonCodes: string[];
  details: string[];
  armAttemptId?: string;
  attemptOrdinal?: number;
  eligibilityArmId?: string | null;
};

export type OrphanModeledTrade = {
  tradeId: string;
  reason: string;
  matchingSignalOccurrenceId?: string;
};

export type HistoricalReplayDiagnostics = {
  rawAuditPatienceReferences: number;
  uniquePhysicalPatienceCandles: number;
  canonicalPatienceOccurrences: number;
  patienceShapesFound: number;
  immediateConfirmationFailures: number;
  canonicalSignalsConfirmed: number;
  canonicalStructuralInvalidations: number;
  duplicatePatienceReferencesRemoved: number;
  uniqueArms: number;
  duplicateArmTransitionReferencesRemoved: number;
  confirmedOccurrencesByEdge: Record<string, number>;
  confirmedOccurrencesBySession: Record<string, number>;
  confirmedOccurrencesByDirectionSource: Record<string, number>;
  eligibleLevelInteractions: number;
  bullishPatienceShapesBeforeQualification: number;
  bearishPatienceShapesBeforeQualification: number;
  orbDirectionShapes: number;
  trendDirectionShapes: number;
  shapesWithoutStrategyDirection: number;
  signalConfirmed: number;
  structuralInvalidations: number;
  armExpirations: number;
  armInvalidations: number;
  armSupersessions: number;
  armConsumptions: number;
  armTerminalConflicts: number;
  pullbackLifecycleStateCounts: Record<string, number>;
  pullbackLifecycleDuplicateTransitions: number;
  pullbackLifecycleConflicts: number;
  pullbackDataGapInvalidations: number;
  pullbackArmsCreated: number;
  pullbackActiveArms: number;
  pullbackSupersededArms: number;
  pullbackOppositeBreakoutInvalidations: number;
  pullbackOrbReentryInvalidations: number;
  pullbackStructuralInvalidations: number;
  pullbackConsumedArms: number;
  pullbackCutoffExpirations: number;
  pullbackSessionExpirations: number;
  pullbackContractExpirations: number;
  latePullbackInteractions: number;
  pullbackInvariantViolations: string[];
  rawPullbackEvents: number;
  canonicalPullbackOccurrences: number;
  duplicatePullbackReferencesRemoved: number;
  sessionsWithMultipleGenuinePullbacks: number;
  tradeCandidates: number;
  modeledTrades: number;
  confirmedSignalsWithoutCandidates: number;
  candidatesWithoutModeledTrades: number;
  candidatesWithoutConfirmedSignals: number;
  modeledTradesWithoutCandidates: number;
  duplicateCandidatesPerSignal: number;
  duplicateModeledTradesPerCandidate: number;
  candidateRejectionReasons: Record<string, string>;
  invalidCausalIdentityCount: number;
  orphanModeledTradesExcluded: number;
  candidateInvariantViolations: string[];
};

export type HistoricalOccurrence = {
  occurrenceId: string;
  auditId: string;
  kind: "pullback" | "patience" | "risk" | "trade";
  strategyCandidate: string;
  secondaryStrategyMatches: string[];
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  direction: Direction | null;
  lTimestamp: string | null;
  lEventId: string | null;
  lInteractionType: string | null;
  lCandle: Record<string, number | boolean> | null;
  previousComparisonTimestamp: string | null;
  patienceTimestamp: string | null;
  patienceCandle: Record<string, number | boolean> | null;
  candidateShapeResult: boolean | null;
  expectedEntryTimestamp: string | null;
  confirmationThreshold: number | null;
  confirmationExcursion: number | null;
  entryTimestamp: string | null;
  entryCandle: Record<string, number | boolean> | null;
  levelIdentifiers: string[];
  levelValues: Record<string, number>;
  targetLevelInputs?: KeyLevelTargetInput[];
  levelDistancesTicks: Record<string, number>;
  levelTolerancePoints: Record<string, number>;
  levelToleranceTicks: Record<string, number>;
  levelInteractionTypes: Record<string, string[]>;
  /** The P candle open; retained as physical identity evidence. */
  pOpenTimestamp: string | null;
  /** The immediate E candle open; retained as physical identity evidence. */
  eOpenTimestamp: string | null;
  /** The completed E candle close where threshold confirmation is observed. */
  entryObservationTimestamp: string | null;
  finalizedNtzHigh?: number | null;
  finalizedNtzLow?: number | null;
  finalizedNtzComplete?: boolean;
  /** Non-empty only when a confirmed P→E sequence violates causal identity invariants. */
  identityInvariantViolations: string[];
  confirmationBufferTicks: number | null;
  nextObservedCandle: Record<string, number | boolean> | null;
  consolidationThresholds: ConsolidationThresholds;
  consolidationGuard?: BacktestConsolidationGuardEvidence | null;
  status: string;
  reasonCode: string;
  evaluationCursor: string;
  formulaVersion: string;
  formulaHash: string;
  sourceFingerprint: string;
  canonicalTrade: boolean;
  canonicalOccurrence?: boolean;
  directionSource?: string;
  directionSources?: string[];
  primaryEdge?: string;
  matchedEdges?: string[];
  supportingConfluences?: string[];
  setupGrade?: "A" | "A+" | "A++";
  entryPrice?: number | null;
  patienceEntryPrice?: number | null;
  confirmationEntryPrice?: number | null;
  signalStatus?: "SIGNAL_CONFIRMED" | "ENTRY_CONFIRMATION_FAILED" | "ENTRY_CONFIRMED";
  eligibilityArmId?: string;
  eligibilityArmState?: "active" | "consumed" | "invalidated" | "superseded";
  eligibilityArmStateReason?: string;
  eligibilityArmTransitionTime?: string;
  eligibilityArmIds?: string[];
  auditIds?: string[];
  eligibilityProvenance?: {
    eventId: string | null;
    reason: "pullback" | "consolidation" | "ntz consolidation";
    time: string;
    detail: string | null;
  };
  management?: {
    strategyStopPrice: number | null;
    catastropheStopPrice: number | null;
    targetPrice: number | null;
    targetPlan?: KeyLevelTargetPlan;
    contracts: number | null;
    runnerActivationPrice: number | null;
    runnerExitRule: string | null;
    sessionCloseTime: string | null;
    sourceAuditId: string;
    missingEvidenceReasons: string[];
  };
  targetLevelSnapshot?: TargetLevelSnapshot;
  /** Causal evidence copied from the source audit; labels are intentionally excluded. */
  causalEvidence?: {
    sourceAuditId: string;
    sourceEdge: string;
    evidenceTimestamp: string | null;
    ruleEvidence: string[];
    orbState: string | null;
    breakoutEvidence: string | null;
    pullbackEvidence: string | null;
    criticalLevelEvidence: string | null;
    trendEvidence: string | null;
    patienceState: string | null;
    patienceCandleOpenTime: string | null;
    patienceCandleCloseTime: string | null;
    triggerCandleOpenTime: string | null;
    triggerCandleCloseTime: string | null;
  };
  causalEvidenceByAudit?: NonNullable<HistoricalOccurrence["causalEvidence"]>[];
};

function candidateCausalIdentityForOccurrence(
  occurrence: HistoricalOccurrence,
): CandidateCausalIdentity {
  return {
    signalOccurrenceId: occurrence.occurrenceId,
    eligibilityArmId: occurrence.eligibilityArmId ?? null,
    activeConsolidationZoneId: occurrence.consolidationGuard?.activeConsolidationZoneId ?? null,
  };
}

function historicalArmAttemptId(occurrence: HistoricalOccurrence): string {
  return occurrenceId([
    "historical-arm-attempt-v1",
    occurrence.sourceFingerprint,
    occurrence.formulaHash,
    occurrence.eligibilityArmId ?? "no-arm",
    occurrence.occurrenceId,
  ].join("|"));
}

function qualifyingLevelRelationshipFingerprint(occurrence: HistoricalOccurrence): string {
  return [...occurrence.levelIdentifiers]
    .sort()
    .map((level) => `${level}:${occurrence.levelValues[level] ?? "null"}`)
    .join("|");
}

function confluenceScoreForCandidate(candidate: HistoricalTradeCandidate): number {
  return candidate.matchedEdges.length
    + candidate.supportingConfluences.length
    + candidate.qualifyingLevelIdentifiers.length;
}

function attemptGradeForCandidate(
  candidate: HistoricalTradeCandidate,
  attemptOrdinal: number,
  runtime: ArmAttemptRuntime,
): CandidateAttemptGrade {
  if (attemptOrdinal === 1 || confluenceScoreForCandidate(candidate) > runtime.firstConfluenceScore) {
    return candidate.grade;
  }
  if (candidate.grade === "A++") return "A+";
  if (candidate.grade === "A+") return "A";
  return "B";
}

export const QUALIFICATION_FUNNEL_STAGES = [
  "session_loaded",
  "ntz_orb_completed",
  "strong_breakout_candidate",
  "strong_continuation_confirmed",
  "pullback_or_consolidation",
  "critical_level_interaction",
  "fibonacci_context_available",
  "volume_condition_passed",
  "valid_trend_aligned_patience_candle",
  "immediate_next_candle_confirmation",
  "risk_approved",
  "modeled_entry",
  "final_exit",
] as const;

export type QualificationFunnelStage = typeof QUALIFICATION_FUNNEL_STAGES[number];

export type QualificationFunnelStageCount = {
  stage: QualificationFunnelStage;
  count: number;
  percentOfPreceding: number;
  percentOfSessions: number;
};

export type QualificationCandidate = {
  candidateId: string;
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  period: "in_sample" | "out_of_sample";
  direction: Direction | null;
  setupType: string;
  timeOfDay: BacktestSegmentation["timeOfDay"];
  marketRegime: BacktestSegmentation["marketRegime"];
  volumeRegime: "normal" | "high";
  reachedStage: QualificationFunnelStage;
  primaryRejectionStage: QualificationFunnelStage | null;
  rejectionDetail: string | null;
  evidence: {
    evaluatedCandleOpenTime: string;
    orbLevels: string;
    breakout: string;
    volume: string;
    pullback: string;
    criticalLevel: string;
    trend: string;
    patience: string;
    trigger: string;
    patienceCandle: Record<string, number | boolean> | null;
    triggerCandle: Record<string, number | boolean> | null;
    patienceCandleOpenTime: string | null;
    patienceCandleCloseTime: string | null;
    triggerCandleOpenTime: string | null;
    triggerCandleCloseTime: string | null;
    entryTriggerPrice: number | null;
    strategyStopPrice: number | null;
    catastropheStopPrice: number | null;
    targetPrice: number | null;
    decision: string;
    rejectionCategory: BacktestAuditRecord["rejectionCategory"];
    ruleEvidence: string[];
    finalOutcome: BacktestTrade["outcome"] | null;
    exitCandleOpenTime: string | null;
    exitCandleCloseTime: string | null;
    netPnl: number | null;
  };
};

export type QualificationFunnelComparison = {
  dimension: "contract" | "month" | "direction" | "period" | "market_regime" | "volume_regime";
  value: string;
  candidateCount: number;
  stageCounts: QualificationFunnelStageCount[];
};

export type QualificationFunnel = {
  sessionCount: number;
  candidateCount: number;
  occurrenceCount: number;
  stages: QualificationFunnelStageCount[];
  rejectionCounts: Array<{ stage: QualificationFunnelStage; count: number }>;
  comparisons: QualificationFunnelComparison[];
  candidates: QualificationCandidate[];
};

const MINUTE = 60_000;

function money(value: number): number {
  return Number(value.toFixed(2));
}

function sortedCandles(candles: readonly SimulatedFuturesCandle[]): SimulatedFuturesCandle[] {
  return [...candles].sort((first, second) => first.closeTime - second.closeTime);
}

export function visibleReplayPrefix(
  candles: readonly SimulatedFuturesCandle[],
  cursor: number,
): SimulatedFuturesCandle[] {
  return sortedCandles(candles)
    .filter((candle) => candle.isComplete && candle.closeTime <= cursor)
    .map((candle) => ({ ...candle }));
}

export function createCausalReplay(
  dataset: Pick<CausalReplayDataset, "candles">,
  cursor: number,
): ReplayCursor & { candles: SimulatedFuturesCandle[] } {
  const candles = visibleReplayPrefix(dataset.candles, cursor);
  return {
    cursor,
    visibleCandleCount: candles.length,
    visibleCandleCloseTime: candles.at(-1)?.closeTime ?? null,
    mode: "replay",
    candles,
  };
}

export function assertCausalVisibility(
  visible: readonly { closeTime: number }[],
  cursor: number,
): void {
  if (visible.some((candle) => candle.closeTime > cursor)) {
    throw new Error("Causal replay attempted to expose a future candle.");
  }
}

/**
 * This is intentionally a conservative fallback for the deterministic feed:
 * the generated five-minute candle has a synthetic one-minute path, but any
 * high/low collision inside one minute remains unresolved and is stop-first.
 */
export function buildSyntheticOneMinuteBars(candle: SimulatedFuturesCandle): IntrabarBar[] {
  const bullish = candle.close >= candle.open;
  const points = bullish
    ? [candle.open, candle.low, candle.high, candle.high, candle.close]
    : [candle.open, candle.high, candle.low, candle.low, candle.close];
  return points.map((open, index) => {
    const close = points[index + 1] ?? candle.close;
    const high = Math.max(open, close, index === (bullish ? 2 : 1) ? candle.high : -Infinity);
    const low = Math.min(open, close, index === (bullish ? 1 : 2) ? candle.low : Infinity);
    return {
      openTime: candle.openTime + index * MINUTE,
      closeTime: candle.openTime + (index + 1) * MINUTE,
      open,
      high,
      low,
      close,
      source: "one-minute",
      sequenceKnown: false,
    };
  });
}

function touches(direction: Direction, price: number, target: number | null, stop: number | null): { target: boolean; stop: boolean } {
  return {
    target: target !== null && (direction === "long" ? price >= target : price <= target),
    stop: stop !== null && (direction === "long" ? price <= stop : price >= stop),
  };
}

function barTouches(
  direction: Direction,
  bar: Pick<IntrabarBar, "high" | "low">,
  target: number | null,
  stop: number | null,
): { target: boolean; stop: boolean } {
  return {
    target: target !== null && (direction === "long" ? bar.high >= target : bar.low <= target),
    stop: stop !== null && (direction === "long" ? bar.low <= stop : bar.high >= stop),
  };
}

export function resolveIntrabarOutcome(input: {
  direction: Direction;
  target: number | null;
  stop: number | null;
  primaryLossExitLevel?: PrimaryLossExitReference | null;
  candle: SimulatedFuturesCandle;
  ticks?: readonly IntrabarPoint[];
  oneMinute?: readonly IntrabarBar[];
}): IntrabarResolution {
  // A patience candidate's protective stop is always the frozen P-wick
  // strategy stop. Nearby key levels remain diagnostic evidence and must not
  // replace that governed stop.
  const effectiveStop = input.stop;
  const stopResult = (
    source: IntrabarResolution["source"],
    timestamp: number,
    price: number,
    detail: string,
  ): IntrabarResolution => ({
    status: "stop",
    source,
    timestamp,
    price,
    ambiguityLabel: null,
    stopLevel: "strategy",
    detail,
  });
  const ticks = [...(input.ticks ?? [])].filter((tick) =>
    tick.timestamp >= input.candle.openTime && tick.timestamp <= input.candle.closeTime,
  ).sort((first, second) => first.timestamp - second.timestamp);
  if (ticks.length) {
    for (const tick of ticks) {
      const hit = touches(input.direction, tick.price, input.target, effectiveStop);
      if (hit.stop && hit.target) {
        return {
          status: "ambiguous",
          source: "tick",
          timestamp: tick.timestamp,
          price: tick.price,
          ambiguityLabel: "AMBIGUOUS_STOP_FIRST",
          stopLevel: "strategy",
          detail: "Tick data touched the stop and target at the same observation; the conservative stop-first policy was applied.",
        };
      }
      if (hit.stop) return stopResult("tick", tick.timestamp, effectiveStop!, "Tick data resolved the patience opposite-wick stop.");
      if (hit.target) return { status: "target", source: "tick", timestamp: tick.timestamp, price: tick.price, ambiguityLabel: null, detail: "Tick data resolved the target." };
    }
    return { status: "open", source: "tick", timestamp: null, price: null, ambiguityLabel: null, detail: "Tick data did not reach a target or stop." };
  }

  const bars = [...(input.oneMinute ?? [])]
    .filter((bar) => bar.openTime >= input.candle.openTime && bar.closeTime <= input.candle.closeTime)
    .sort((first, second) => first.closeTime - second.closeTime);
  if (bars.length) {
    for (const bar of bars) {
      const hit = barTouches(input.direction, bar, input.target, effectiveStop);
      if (hit.stop && hit.target) {
        return {
          status: "ambiguous",
          source: "one-minute",
          timestamp: bar.closeTime,
          price: input.stop,
          ambiguityLabel: "AMBIGUOUS_STOP_FIRST",
          stopLevel: "strategy",
          detail: "One-minute OHLC touched both barriers inside the same minute; the conservative stop-first policy was applied.",
        };
      }
      if (hit.stop) return stopResult("one-minute", bar.closeTime, effectiveStop!, "One-minute data resolved the patience opposite-wick stop.");
      if (hit.target) return { status: "target", source: "one-minute", timestamp: bar.closeTime, price: input.target, ambiguityLabel: null, detail: "One-minute data resolved the target." };
    }
    return { status: "open", source: "one-minute", timestamp: null, price: null, ambiguityLabel: null, detail: "One-minute data did not reach a target or stop." };
  }

  const hit = barTouches(input.direction, input.candle, input.target, effectiveStop);
  if (hit.stop || hit.target) {
    const ambiguous = hit.stop && hit.target;
    return {
      status: ambiguous ? "ambiguous" : hit.stop ? "stop" : "target",
      source: "ohlc",
      timestamp: input.candle.closeTime,
      price: hit.stop ? effectiveStop : input.target,
      ambiguityLabel: ambiguous ? "AMBIGUOUS_STOP_FIRST" : null,
      stopLevel: hit.stop ? "strategy" : null,
      detail: hit.stop
        ? ambiguous
          ? "Only five-minute OHLC is available and both barriers were touched; stop-first was applied."
          : "Five-minute OHLC reached the stop without also reaching the target."
        : "Five-minute OHLC reached the target without also reaching the stop.",
    };
  }
  return { status: "open", source: "ohlc", timestamp: null, price: null, ambiguityLabel: null, detail: "Five-minute OHLC did not reach a target or stop." };
}

export function resolveEntryAndInvalidation(input: {
  direction: Direction;
  candle: Pick<SimulatedFuturesCandle, "open" | "high" | "low" | "close">;
  entry: number;
  invalidation: number | null;
  sequenceKnown: boolean;
}): EntryResolution {
  const entryTouched = input.direction === "long" ? input.candle.high >= input.entry : input.candle.low <= input.entry;
  const invalidationTouched = input.invalidation !== null
    && (input.direction === "long" ? input.candle.low <= input.invalidation : input.candle.high >= input.invalidation);
  if (entryTouched && invalidationTouched && !input.sequenceKnown) {
    return {
      status: "ambiguous",
      price: null,
      label: "AMBIGUOUS_ENTRY_INVALIDATION",
      detail: "Entry and invalidation occurred in the same unresolved candle; the setup was rejected instead of inventing an order.",
    };
  }
  return {
    status: "accepted",
    price: entryTouched ? input.entry : null,
    label: null,
    detail: entryTouched ? "Entry sequence was resolved without look-ahead." : "The entry was not touched.",
  };
}

function datesForDataset(
  candles: readonly SimulatedFuturesCandle[],
  calendar: FuturesSessionCalendar,
): string[] {
  return [...new Set(candles.map((candle) => tradingDateForTimestamp(candle.openTime, calendar)))].sort();
}

type ReplayIndexes = {
  candlesByContract: Map<string, SimulatedFuturesCandle[]>;
  candleIndexByContractOpenTime: Map<string, Map<number, number>>;
  hourlyByContract: Map<string, SimulatedHourlyCandle[]>;
  regularCandlesByContractDate: Map<string, SimulatedFuturesCandle[]>;
  regularIndexByContractOpenTime: Map<string, Map<number, number>>;
  ticksByCandleOpenTime: Map<number, IntrabarPoint[]>;
  oneMinuteByContractCandle: Map<string, IntrabarBar[]>;
};

function lowerBound<T>(values: readonly T[], target: number, value: (item: T) => number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (value(values[middle]) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function buildReplayIndexes(
  candles: readonly SimulatedFuturesCandle[],
  ticks: readonly IntrabarPoint[],
  oneMinute: readonly IntrabarBar[],
  calendar: FuturesSessionCalendar,
): ReplayIndexes {
  const candlesByContract = new Map<string, SimulatedFuturesCandle[]>();
  const candleIndexByContractOpenTime = new Map<string, Map<number, number>>();
  const regularCandlesByContractDate = new Map<string, SimulatedFuturesCandle[]>();
  const regularIndexByContractOpenTime = new Map<string, Map<number, number>>();

  for (const candle of candles) {
    const contractCandles = candlesByContract.get(candle.contractSymbol) ?? [];
    contractCandles.push(candle);
    candlesByContract.set(candle.contractSymbol, contractCandles);

    const contractIndex = candleIndexByContractOpenTime.get(candle.contractSymbol) ?? new Map<number, number>();
    contractIndex.set(candle.openTime, contractCandles.length - 1);
    candleIndexByContractOpenTime.set(candle.contractSymbol, contractIndex);

    const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
    const window = sessionWindow(tradingDate, "regular", calendar);
    if (candle.isComplete && window && candle.openTime >= window.openTime && candle.closeTime <= window.closeTime) {
      const dateKey = `${candle.contractSymbol}:${tradingDate}`;
      const regular = regularCandlesByContractDate.get(dateKey) ?? [];
      regular.push(candle);
      regularCandlesByContractDate.set(dateKey, regular);
      const regularIndex = regularIndexByContractOpenTime.get(dateKey) ?? new Map<number, number>();
      regularIndex.set(candle.openTime, regular.length - 1);
      regularIndexByContractOpenTime.set(dateKey, regularIndex);
    }
  }

  const hourlyByContract = new Map<string, SimulatedHourlyCandle[]>();
  for (const [contractSymbol, contractCandles] of candlesByContract) {
    hourlyByContract.set(contractSymbol, completedSimulatedHourlyCandles(contractCandles, calendar));
  }

  const sortedTicks = [...ticks].sort((first, second) => first.timestamp - second.timestamp);
  const ticksByCandleOpenTime = new Map<number, IntrabarPoint[]>();
  for (const candle of candles) {
    const start = lowerBound(sortedTicks, candle.openTime, (item) => item.timestamp);
    const end = lowerBound(sortedTicks, candle.closeTime + 1, (item) => item.timestamp);
    if (end > start) ticksByCandleOpenTime.set(candle.openTime, sortedTicks.slice(start, end));
  }

  const oneMinuteByContract = new Map<string, IntrabarBar[]>();
  const sortedOneMinute = [...oneMinute].sort((first, second) => first.closeTime - second.closeTime);
  if (candlesByContract.size > 1) {
    const assignedBars = new Set<string>();
    for (const [contractSymbol, contractCandles] of candlesByContract) {
      for (const item of sortedOneMinute) {
        const candleIndex = lowerBound(contractCandles, item.openTime + 1, (value) => value.openTime) - 1;
        const enclosing = contractCandles[candleIndex];
        if (!enclosing) continue;
        const sameTradingDate = tradingDateForTimestamp(item.openTime, calendar)
          === tradingDateForTimestamp(enclosing.openTime, calendar);
        const enclosedByFiveMinute = item.openTime >= enclosing.openTime
          && item.closeTime <= enclosing.closeTime;
        if (!sameTradingDate || !enclosedByFiveMinute) continue;
        const barIdentity = `${item.openTime}:${item.closeTime}`;
        if (assignedBars.has(barIdentity)) continue;
        const partition = oneMinuteByContract.get(contractSymbol) ?? [];
        partition.push(item);
        oneMinuteByContract.set(contractSymbol, partition);
        assignedBars.add(barIdentity);
      }
    }
  }

  const oneMinuteByContractCandle = new Map<string, IntrabarBar[]>();
  for (const [contractSymbol, contractCandles] of candlesByContract) {
    const contractBars = candlesByContract.size === 1
      ? sortedOneMinute
      : oneMinuteByContract.get(contractSymbol) ?? [];
    let cursor = 0;
    for (const candle of contractCandles) {
      while (cursor < contractBars.length && contractBars[cursor].closeTime <= candle.openTime) cursor += 1;
      const bars: IntrabarBar[] = [];
      for (let index = cursor; index < contractBars.length; index += 1) {
        const bar = contractBars[index];
        if (bar.openTime >= candle.openTime && bar.closeTime <= candle.closeTime) bars.push(bar);
        if (bar.openTime > candle.closeTime) break;
      }
      if (bars.length) oneMinuteByContractCandle.set(`${contractSymbol}:${candle.openTime}`, bars);
    }
  }

  return {
    candlesByContract,
    candleIndexByContractOpenTime,
    hourlyByContract,
    regularCandlesByContractDate,
    regularIndexByContractOpenTime,
    ticksByCandleOpenTime,
    oneMinuteByContractCandle,
  };
}

export function buildReplayDataset(
  symbol: string,
  options: ReplayDatasetOptions,
): CausalReplayDataset {
  if (options.inSampleDays < 1 || options.outOfSampleDays < 1) {
    throw new Error("Replay requires at least one in-sample day and one out-of-sample day.");
  }
  const specification = getFuturesContractSpecification(symbol);
  const calendar = sessionCalendarForContract(specification);
  const candles = generateSimulatedFuturesFeed(specification, {
    calendar,
    days: options.inSampleDays + options.outOfSampleDays,
    seed: options.seed ?? 11,
    includePremarket: options.premarketAvailable !== false,
    startDate: options.endDate,
  });
  const dates = datesForDataset(candles, calendar);
  const inSampleDates = dates.slice(0, options.inSampleDays);
  const outOfSampleDates = dates.slice(-options.outOfSampleDays);
  return {
    candles,
    contractSymbol: specification.fullContractSymbol,
    contractMonth: specification.contractMonth,
    inSampleDates,
    outOfSampleDates,
  };
}

function periodForDate(date: string, dataset: CausalReplayDataset): "in_sample" | "out_of_sample" {
  return dataset.outOfSampleDates.includes(date) ? "out_of_sample" : "in_sample";
}

function timeOfDay(timestamp: number): BacktestSegmentation["timeOfDay"] {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp)));
  return hour < 11 ? "open" : hour < 14 ? "midday" : "close";
}

function levelType(snapshot: MarketSnapshot): BacktestSegmentation["levelType"] {
  const levelNames = snapshot.setupAnalysis.evaluations
    .flatMap((evaluation) => evaluation.rules.filter((rule) => rule.passed).map((rule) => rule.key));
  const types = [
    levelNames.some((name) => name.includes("ntz")) ? "NTZ" : null,
    levelNames.some((name) => name.includes("pullback") || name.includes("level")) ? "major level" : null,
    snapshot.fibonacci.frozen ? "Fibonacci" : null,
  ].filter((value): value is string => value !== null);
  return types.length > 1 ? "mixed" : (types[0] as BacktestSegmentation["levelType"] | undefined) ?? "unmapped";
}

function segmentation(
  snapshot: MarketSnapshot,
  setupType: string,
  direction: Direction,
  candle: SimulatedFuturesCandle,
  contractSymbol = snapshot.contract.fullContractSymbol,
  contractMonth = snapshot.contract.contractMonth,
): BacktestSegmentation {
  const confluence = snapshot.majorLevels.reduce<BacktestSegmentation["confluence"]>((strongest, level) => {
    const rank = { normal: 0, strong: 1, dynamite: 2 };
    return rank[level.confluence] > rank[strongest] ? level.confluence : strongest;
  }, "normal");
  return {
    contract: contractSymbol,
    contractMonth,
    setupType,
    direction,
    timeOfDay: timeOfDay(candle.openTime),
    trend: snapshot.trend.direction,
    fibonacciDepth: snapshot.fibonacci.classification,
    volumeCondition: snapshot.volumeAnalysis.reversalWarning ? "warning" : snapshot.volumeAnalysis.supportingBreakoutVolume ? "supported" : "neutral",
    levelType: levelType(snapshot),
    confluence,
    patienceCharacteristic: snapshot.patience.state,
    orbState: snapshot.breakout.state,
    marketRegime: snapshot.trend.direction === "neutral" ? "range" : snapshot.volumeAnalysis.reversalWarning ? "transition" : "trend",
  };
}

function emptyMetrics(rejectedSetupCount = 0): BacktestMetrics {
  return {
    tradeCount: 0,
    winRate: 0,
    averageWin: null,
    averageLoss: null,
    expectancy: null,
    profitFactor: null,
    maximumDrawdown: 0,
    grossPnl: 0,
    fees: 0,
    slippage: 0,
    netPnl: 0,
    ambiguousTradeCount: 0,
    rejectedSetupCount,
    setupsDetected: 0,
    setupsRejected: rejectedSetupCount,
    patienceCandles: 0,
    entryTriggers: 0,
    modeledFills: 0,
    stopExits: 0,
    targetExits: 0,
    runnerExits: 0,
    ambiguityCount: 0,
    ambiguousExitCount: 0,
    expiredPatienceSetups: 0,
    ambiguousEntryCount: 0,
    strategyStopExits: 0,
    catastropheStopExits: 0,
    sessionCloseExits: 0,
    partialTargetExits: 0,
    consecutiveLosses: 0,
  };
}

export function calculateBacktestMetrics(
  trades: readonly BacktestTrade[],
  rejectedSetupCount = 0,
  audits: readonly BacktestAuditRecord[] = [],
): BacktestMetrics {
  const realizedTrades = trades.filter((trade) => trade.outcome !== "open");
  if (!realizedTrades.length) {
    const empty = emptyMetrics(rejectedSetupCount);
    empty.expiredPatienceSetups = audits.filter((record) => record.patienceState === "PATIENCE_CANDLE_EXPIRED").length;
    empty.ambiguousEntryCount = audits.filter((record) => record.rejectionReason === "AMBIGUOUS_ENTRY_INVALIDATION").length;
    empty.ambiguityCount = empty.ambiguousEntryCount;
    return empty;
  }
  const wins = realizedTrades.filter((trade) => trade.netPnl > 0);
  const losses = realizedTrades.filter((trade) => trade.netPnl < 0);
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  let consecutiveLosses = 0;
  let currentLosses = 0;
  for (const trade of realizedTrades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
    currentLosses = trade.netPnl < 0 ? currentLosses + 1 : 0;
    consecutiveLosses = Math.max(consecutiveLosses, currentLosses);
  }
  const grossWins = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  return {
    tradeCount: realizedTrades.length,
    winRate: Number(((wins.length / realizedTrades.length) * 100).toFixed(1)),
    averageWin: wins.length ? money(grossWins / wins.length) : null,
    averageLoss: losses.length ? money(losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length) : null,
    expectancy: money(realizedTrades.reduce((sum, trade) => sum + trade.netPnl, 0) / realizedTrades.length),
    profitFactor: grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? null : 0,
    maximumDrawdown: money(maximumDrawdown),
    grossPnl: money(realizedTrades.reduce((sum, trade) => sum + trade.grossPnl, 0)),
    fees: money(realizedTrades.reduce((sum, trade) => sum + trade.fees, 0)),
    slippage: money(realizedTrades.reduce((sum, trade) => sum + trade.slippage, 0)),
    netPnl: money(realizedTrades.reduce((sum, trade) => sum + trade.netPnl, 0)),
     ambiguousTradeCount: realizedTrades.filter((trade) => (trade.audit?.ambiguityLabels.length ?? 0) > 0).length,
    rejectedSetupCount,
    setupsDetected: trades.length,
    setupsRejected: rejectedSetupCount,
     patienceCandles: realizedTrades.filter((trade) => trade.audit?.patienceCandleOpenTime !== null).length,
    entryTriggers: realizedTrades.filter((trade) => trade.audit?.entryTriggerPrice !== null).length,
    modeledFills: realizedTrades.filter((trade) => trade.executionMode === "ohlcv_modeled").length,
    stopExits: realizedTrades.filter((trade) => trade.outcome === "strategy stop" || trade.outcome === "catastrophe stop").length,
    targetExits: realizedTrades.filter((trade) => trade.audit?.targetHit === true).length,
      runnerExits: realizedTrades.filter((trade) => trade.audit?.runnerExited === true || trade.audit?.legs?.some((leg) => leg.kind === "runner") === true).length,
     ambiguityCount: audits.filter((record) => record.rejectionReason === "AMBIGUOUS_ENTRY_INVALIDATION").length
        + realizedTrades.filter((trade) => (trade.audit?.ambiguityLabels.length ?? 0) > 0).length,
      ambiguousExitCount: realizedTrades.filter((trade) => (trade.audit?.ambiguityLabels.length ?? 0) > 0).length,
    expiredPatienceSetups: audits.filter((record) => record.patienceState === "PATIENCE_CANDLE_EXPIRED").length,
    ambiguousEntryCount: audits.filter((record) => record.rejectionReason === "AMBIGUOUS_ENTRY_INVALIDATION").length,
     strategyStopExits: realizedTrades.filter((trade) => trade.outcome === "strategy stop").length,
     catastropheStopExits: realizedTrades.filter((trade) => trade.outcome === "catastrophe stop").length,
     sessionCloseExits: realizedTrades.filter((trade) => trade.outcome === "session close").length,
      partialTargetExits: realizedTrades.filter((trade) => trade.audit?.legs?.some((leg) => leg.kind === "target") && trade.audit?.legs?.some((leg) => leg.kind === "runner")).length,
     consecutiveLosses,
  };
}

export function buildSegments(trades: readonly BacktestTrade[], rejectedSetupCount: number): BacktestSegment[] {
  const dimensions: Array<keyof BacktestSegmentation> = [
    "contract", "contractMonth", "setupType", "direction", "timeOfDay", "trend",
    "fibonacciDepth", "volumeCondition", "levelType", "confluence", "patienceCharacteristic", "orbState", "marketRegime",
  ];
  const dimensionalSegments = dimensions.flatMap((dimension) => {
    const values = [...new Set(trades.map((trade) => String(trade.segmentation[dimension])))];
    return values.map((value) => {
      const matching = trades.filter((trade) => String(trade.segmentation[dimension]) === value);
      return { dimension, value, ...calculateBacktestMetrics(matching, matching.length ? 0 : rejectedSetupCount) };
    });
  });
  const periodSegments = (["in_sample", "out_of_sample"] as const)
    .map((value) => {
      const matching = trades.filter((trade) => trade.period === value);
      return { dimension: "period", value, ...calculateBacktestMetrics(matching) };
    })
    .filter((segment) => segment.tradeCount > 0);
  return [...dimensionalSegments, ...periodSegments];
}

export function historicalReplayDiagnostics(
  audits: readonly BacktestAuditRecord[],
  occurrences: readonly HistoricalOccurrence[],
  tradeCandidates: readonly HistoricalTradeCandidate[] = [],
  authoritativeModeledTrades: readonly BacktestTrade[] = [],
  rejectedCandidateSignals: readonly RejectedCandidateSignal[] = [],
  orphanModeledTrades: readonly OrphanModeledTrade[] = [],
): HistoricalReplayDiagnostics {
  const patience = audits.flatMap((record) => record.patienceOccurrences ?? []);
  const canonicalPatience = occurrences.filter((occurrence) => occurrence.kind === "patience" && occurrence.canonicalOccurrence === true);
  const confirmedPatience = canonicalPatience.filter((occurrence) => occurrence.status === "SIGNAL_CONFIRMED");
  const countBy = (values: readonly string[]): Record<string, number> =>
    values.reduce<Record<string, number>>((counts, value) => {
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    }, {});
  const confirmedByEdge = countBy(confirmedPatience.map((occurrence) => occurrence.primaryEdge ?? occurrence.strategyCandidate));
  const confirmedBySession = countBy(confirmedPatience.map((occurrence) => `${occurrence.contractSymbol}|${occurrence.tradingDate}`));
  const confirmedBySource = countBy(confirmedPatience.flatMap((occurrence) => occurrence.directionSources ?? (occurrence.directionSource ? [occurrence.directionSource] : [])));
  const candidateSignalIds = tradeCandidates.map((candidate) => candidate.signalOccurrenceId);
  const candidateCountBySignal = countBy(candidateSignalIds);
  const duplicateCandidatesPerSignal = Object.values(candidateCountBySignal)
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const modeledTradeCandidateIds = authoritativeModeledTrades.map((trade) => trade.candidateId).filter((id): id is string => Boolean(id));
  const duplicateModeledTradesPerCandidate = Object.values(countBy(modeledTradeCandidateIds))
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const candidateInvariantViolations = tradeCandidates.flatMap((candidate) => {
    const violations: string[] = [];
    const triggered = candidate.entryReachedThreshold === true;
    const modeled = candidate.executionStatus === "MODELED_TRADE_CREATED";
    const candidateTrades = authoritativeModeledTrades.filter((trade) => trade.candidateId === candidate.candidateId);
    const exactLinkedTrades = candidateTrades.filter((trade) =>
      trade.signalOccurrenceId === candidate.signalOccurrenceId);
    if (triggered !== modeled) {
      violations.push(
        `${candidate.signalOccurrenceId}: entryReachedThreshold=${String(candidate.entryReachedThreshold)} does not match executionStatus=${candidate.executionStatus}.`,
      );
    }
    if (triggered && exactLinkedTrades.length !== 1) {
      violations.push(
        `${candidate.signalOccurrenceId}: triggered candidate ${candidate.candidateId} has ${exactLinkedTrades.length} authoritative trades linked by candidateId and signalOccurrenceId; expected exactly one.`,
      );
    }
    if (!triggered && candidateTrades.length > 0) {
      violations.push(
        `${candidate.signalOccurrenceId}: non-triggered candidate ${candidate.candidateId} has ${candidateTrades.length} authoritative modeled trades; expected none.`,
      );
    }
    for (const trade of candidateTrades) {
      if (trade.signalOccurrenceId !== candidate.signalOccurrenceId) {
        violations.push(
          `${candidate.signalOccurrenceId}: trade ${trade.id} has mismatched signalOccurrenceId ${trade.signalOccurrenceId ?? "missing"}.`,
        );
      }
      if (trade.entryPrice !== candidate.confirmationPrice
        || trade.audit?.modeledFillPrice !== candidate.confirmationPrice
        || trade.audit?.entryTriggerPrice !== candidate.confirmationPrice) {
        violations.push(
          `${candidate.signalOccurrenceId}: trade ${trade.id} is not filled at candidate threshold ${candidate.confirmationPrice}.`,
        );
      }
      if (trade.audit?.triggerCandleOpenTime !== candidate.eOpenTimestamp
        || trade.audit?.modeledFillObservationTime !== candidate.entryObservationTimestamp
        || trade.entryTime !== candidate.entryObservationTimestamp) {
        violations.push(
          `${candidate.signalOccurrenceId}: trade ${trade.id} does not preserve E-open identity and E-close fill observation.`,
        );
      }
    }
    return violations;
  });
  const lifecycle = reduceHistoricalPullbackLifecycles(audits, patience, occurrences);
  const lifecycleByArm = new Map(lifecycle.records.map((record) => [record.armId, record]));
  const terminalByArm = new Map(
    lifecycle.records
      .filter((record) => record.terminal)
      .map((record) => [record.armId, {
        state: record.state,
        time: record.transitions.at(-1)?.time ?? 0,
        reason: record.terminalReason ?? "",
      }]),
  );
  const pullbackArmStateById = new Map(lifecycle.records.map((record) => [record.armId, record.state]));
  const uniqueArms = lifecycle.records.length;
  const modeledTrades = authoritativeModeledTrades.length;
  const rawPullbackEvents = audits.reduce(
    (count, record) => count + (record.pullbackOccurrences?.filter((event) => event.qualifies !== false && QUALIFYING_PULLBACK_EVENT_TYPES.has(event.type)).length ?? 0),
    0,
  );
  const canonicalPullbackOccurrences = occurrences.filter((occurrence) => occurrence.kind === "pullback");
  const interactionSessions = new Map<string, Set<string>>();
  for (const occurrence of canonicalPullbackOccurrences) {
    const session = `${occurrence.contractSymbol}|${occurrence.tradingDate}`;
    const identity = `${occurrence.direction ?? "unknown"}|${occurrence.lTimestamp}|${occurrence.levelIdentifiers.join("|")}`;
    const interactions = interactionSessions.get(session) ?? new Set<string>();
    interactions.add(identity);
    interactionSessions.set(session, interactions);
  }
  const lateInteractionsByArm = new Map<string, number>();
  const pullbackInvariantViolations: string[] = lifecycle.conflicts.map((conflict) =>
    `${conflict.armId}: ${conflict.reason} observed ${conflict.observedState} after ${conflict.canonicalState}.`,
  );
  for (const record of audits) {
    const armId = record.pullbackArmId;
    if (!armId) continue;
    lateInteractionsByArm.set(
      armId,
      Math.max(lateInteractionsByArm.get(armId) ?? 0, record.latePullbackInteractions ?? 0),
    );
  }
  const terminalPullbackStates = new Set<PullbackArmState>([
    "STRUCTURALLY_INVALIDATED",
    "ORB_REENTRY_INVALIDATED",
    "SUPERSEDED_BY_NEW_BREAKOUT",
    "OPPOSITE_BREAKOUT_INVALIDATED",
    "ENTRY_CUTOFF_EXPIRED",
    "SESSION_BOUNDARY_EXPIRED",
    "CONTRACT_BOUNDARY_EXPIRED",
    "DATA_GAP_INVALIDATED",
  ]);
  const confirmedArmIds = new Set(
    confirmedPatience
      .filter((occurrence) => occurrence.eligibilityArmId)
      .map((occurrence) => occurrence.eligibilityArmId!),
  );
  for (const [armId, state] of pullbackArmStateById) {
    if (terminalPullbackStates.has(state) && state !== "CONSUMED" && confirmedArmIds.has(armId)) {
      pullbackInvariantViolations.push(`${armId}: a confirmed candidate is linked to a non-consumed terminal pullback arm.`);
    }
  }
  for (const candidate of tradeCandidates) {
    const occurrence = canonicalPatience.find((item) => item.occurrenceId === candidate.signalOccurrenceId);
    const state = occurrence?.eligibilityArmId
      ? lifecycleByArm.get(occurrence.eligibilityArmId)?.state
      : undefined;
    if (state && isTerminalPullbackArmState(state) && state !== "CONSUMED") {
      pullbackInvariantViolations.push(
        `${candidate.signalOccurrenceId}: candidate ${candidate.candidateId} is linked to terminal arm state ${state}.`,
      );
    }
  }
  const lifecycleStateCounts = countBy(lifecycle.records.map((record) => record.state));
  const armTerminalConflicts = lifecycle.conflicts.filter((conflict) =>
    isTerminalPullbackArmState(conflict.canonicalState),
  ).length;
  return {
    rawAuditPatienceReferences: patience.length,
    uniquePhysicalPatienceCandles: new Set(canonicalPatience.map((item) => `${item.sourceFingerprint}|${item.contractSymbol}|${item.tradingDate}|${item.direction}|${item.patienceTimestamp}`)).size,
    canonicalPatienceOccurrences: canonicalPatience.length,
    patienceShapesFound: canonicalPatience.filter((item) => item.status === "PATIENCE_SHAPE_FOUND").length,
    canonicalSignalsConfirmed: confirmedPatience.length,
    canonicalStructuralInvalidations: canonicalPatience.filter((item) => item.status === "STRUCTURALLY_INVALIDATED").length,
    duplicatePatienceReferencesRemoved: Math.max(0, patience.length - canonicalPatience.length),
    uniqueArms,
    duplicateArmTransitionReferencesRemoved: lifecycle.duplicateTransitions,
    confirmedOccurrencesByEdge: confirmedByEdge,
    confirmedOccurrencesBySession: confirmedBySession,
    confirmedOccurrencesByDirectionSource: confirmedBySource,
    eligibleLevelInteractions: rawPullbackEvents,
    bullishPatienceShapesBeforeQualification: patience.filter((item) => item.candidateShapeResult === true && item.direction === "long").length,
    bearishPatienceShapesBeforeQualification: patience.filter((item) => item.candidateShapeResult === true && item.direction === "short").length,
    orbDirectionShapes: patience.filter((item) => item.directionSource === "ORB_BREAKOUT" || item.directionSource === "CONSOLIDATION_BREAKOUT").length,
    trendDirectionShapes: patience.filter((item) => item.directionSource === "CONFIRMED_15M_TREND").length,
    shapesWithoutStrategyDirection: audits.filter((record) => record.patienceCandle !== null && record.direction === null).length,
    immediateConfirmationFailures: canonicalPatience.filter((item) => item.status === "IMMEDIATE_CONFIRMATION_FAILED").length,
    signalConfirmed: confirmedPatience.length,
    structuralInvalidations: canonicalPatience.filter((item) => item.status === "STRUCTURALLY_INVALIDATED").length,
    armExpirations: [...terminalByArm.values()].filter((item) =>
      item.state === "ENTRY_CUTOFF_EXPIRED"
      || item.state === "SESSION_BOUNDARY_EXPIRED"
      || item.state === "CONTRACT_BOUNDARY_EXPIRED"
      || item.state === "DATA_GAP_INVALIDATED",
    ).length,
    armInvalidations: [...terminalByArm.values()].filter((item) =>
      item.state === "STRUCTURALLY_INVALIDATED"
      || item.state === "ORB_REENTRY_INVALIDATED"
      || item.state === "OPPOSITE_BREAKOUT_INVALIDATED"
      || item.state === "DATA_GAP_INVALIDATED",
    ).length,
    armSupersessions: [...terminalByArm.values()].filter((item) => item.state === "SUPERSEDED_BY_NEW_BREAKOUT").length,
    armConsumptions: [...terminalByArm.values()].filter((item) => item.state === "CONSUMED").length,
    armTerminalConflicts,
    pullbackLifecycleStateCounts: lifecycleStateCounts,
    pullbackLifecycleDuplicateTransitions: lifecycle.duplicateTransitions,
    pullbackLifecycleConflicts: lifecycle.conflicts.length,
    pullbackDataGapInvalidations: [...terminalByArm.values()].filter((item) => item.state === "DATA_GAP_INVALIDATED").length,
    pullbackArmsCreated: pullbackArmStateById.size,
    pullbackActiveArms: [...pullbackArmStateById.values()].filter((state) => !terminalPullbackStates.has(state)).length,
    pullbackSupersededArms: [...pullbackArmStateById.values()].filter((state) => state === "SUPERSEDED_BY_NEW_BREAKOUT").length,
    pullbackOppositeBreakoutInvalidations: [...pullbackArmStateById.values()].filter((state) => state === "OPPOSITE_BREAKOUT_INVALIDATED").length,
    pullbackOrbReentryInvalidations: [...pullbackArmStateById.values()].filter((state) => state === "ORB_REENTRY_INVALIDATED").length,
    pullbackStructuralInvalidations: [...pullbackArmStateById.values()].filter((state) => state === "STRUCTURALLY_INVALIDATED").length,
    pullbackConsumedArms: [...pullbackArmStateById.values()].filter((state) => state === "CONSUMED").length,
    pullbackCutoffExpirations: [...pullbackArmStateById.values()].filter((state) => state === "ENTRY_CUTOFF_EXPIRED").length,
    pullbackSessionExpirations: [...pullbackArmStateById.values()].filter((state) => state === "SESSION_BOUNDARY_EXPIRED").length,
    pullbackContractExpirations: [...pullbackArmStateById.values()].filter((state) => state === "CONTRACT_BOUNDARY_EXPIRED").length,
    latePullbackInteractions: [...lateInteractionsByArm.values()].reduce((total, count) => total + count, 0),
    pullbackInvariantViolations: [...new Set(pullbackInvariantViolations)],
    rawPullbackEvents,
    canonicalPullbackOccurrences: canonicalPullbackOccurrences.length,
    duplicatePullbackReferencesRemoved: Math.max(0, rawPullbackEvents - canonicalPullbackOccurrences.length),
    sessionsWithMultipleGenuinePullbacks: [...interactionSessions.values()].filter((items) => items.size > 1).length,
    tradeCandidates: tradeCandidates.length,
    modeledTrades,
    confirmedSignalsWithoutCandidates: confirmedPatience.filter((occurrence) => !candidateSignalIds.includes(occurrence.occurrenceId)).length,
    candidatesWithoutModeledTrades: tradeCandidates.filter((candidate) => !authoritativeModeledTrades.some((trade) => trade.candidateId === candidate.candidateId)).length,
    candidatesWithoutConfirmedSignals: tradeCandidates.filter((candidate) => !confirmedPatience.some((occurrence) => occurrence.occurrenceId === candidate.signalOccurrenceId)).length,
    modeledTradesWithoutCandidates: authoritativeModeledTrades.filter((trade) => !tradeCandidates.some((candidate) => candidate.candidateId === trade.candidateId)).length,
    duplicateCandidatesPerSignal,
    duplicateModeledTradesPerCandidate,
    candidateRejectionReasons: Object.fromEntries(rejectedCandidateSignals.flatMap((rejection) =>
      rejection.details.length
        ? [[rejection.signalOccurrenceId, rejection.details.join(" ")]]
        : [])),
    invalidCausalIdentityCount: confirmedPatience.filter((occurrence) =>
      (occurrence.identityInvariantViolations?.length ?? 0) > 0,
    ).length,
    orphanModeledTradesExcluded: orphanModeledTrades.length,
    candidateInvariantViolations,
  };
}

export type HistoricalPullbackLifecycle = ReturnType<typeof reducePullbackArmLifecycles>;

export function reduceHistoricalPullbackLifecycles(
  audits: readonly BacktestAuditRecord[],
  patience: readonly PatienceOccurrence[] = audits.flatMap((record) => record.patienceOccurrences ?? []),
  historicalOccurrences: readonly HistoricalOccurrence[] = [],
): HistoricalPullbackLifecycle {
  const observations: PullbackArmLifecycleObservation[] = [];
  const historicalByArmAndPhysicalIdentity = new Map<string, HistoricalOccurrence>();
  for (const occurrence of historicalOccurrences) {
    if (occurrence.kind !== "patience" || !occurrence.eligibilityArmId) continue;
    const key = [
      occurrence.eligibilityArmId,
      occurrence.pOpenTimestamp ?? "missing-p",
      occurrence.eOpenTimestamp ?? "missing-e",
    ].join("|");
    historicalByArmAndPhysicalIdentity.set(key, occurrence);
  }
  for (const record of audits) {
    if (!record.pullbackArmId) continue;
    const transitions = (record.pullbackArmTransitions ?? [])
      .map((transition) => ({
        ...transition,
        time: Date.parse(transition.time),
      }))
      .filter((transition) => Number.isFinite(transition.time));
    observations.push({
      armId: record.pullbackArmId,
      state: record.pullbackArmState,
      transitions,
      observedAt: Date.parse(record.evaluatedCandleOpenTime),
      source: `audit:${record.id}`,
    });
  }
  for (const occurrence of patience) {
    const armId = occurrence.eligibilityArmId;
    if (!armId) continue;
    const historicalOccurrence = historicalByArmAndPhysicalIdentity.get([
      armId,
      Number.isFinite(occurrence.patienceCandle.openTime)
        ? new Date(occurrence.patienceCandle.openTime).toISOString()
        : "missing-p",
      Number.isFinite(occurrence.expectedEntryCandleOpenTime ?? Number.NaN)
        ? new Date(occurrence.expectedEntryCandleOpenTime!).toISOString()
        : "missing-e",
    ].join("|"));
    const consumingSignalIdentity = historicalOccurrence
      && historicalOccurrence.status === "SIGNAL_CONFIRMED"
      ? pullbackSignalIdentityForOccurrence(historicalOccurrence)
      : undefined;
    observations.push({
      armId,
      transitions: patienceArmLifecycleTransitions(occurrence).map((transition) =>
        transition.to === "CONSUMED" && consumingSignalIdentity
          ? {
            ...transition,
            consumingSignalIdentity,
            consumingSignalOccurrenceId: historicalOccurrence!.occurrenceId,
          }
          : transition,
      ),
      source: `patience:${occurrence.occurrenceId}`,
    });
  }
  return reducePullbackArmLifecycles(observations);
}

function pullbackSignalIdentityForOccurrence(
  occurrence: Pick<
    HistoricalOccurrence,
    | "sourceFingerprint"
    | "formulaHash"
    | "contractSymbol"
    | "tradingDate"
    | "direction"
    | "pOpenTimestamp"
    | "eOpenTimestamp"
  >,
): PullbackArmSignalIdentity | undefined {
  if (
    typeof occurrence.sourceFingerprint !== "string"
    || occurrence.sourceFingerprint.trim().length === 0
    || typeof occurrence.formulaHash !== "string"
    || occurrence.formulaHash.trim().length === 0
    || typeof occurrence.contractSymbol !== "string"
    || occurrence.contractSymbol.trim().length === 0
    || typeof occurrence.tradingDate !== "string"
    || occurrence.tradingDate.trim().length === 0
    || (occurrence.direction !== "long" && occurrence.direction !== "short")
    || typeof occurrence.pOpenTimestamp !== "string"
    || occurrence.pOpenTimestamp.trim().length === 0
    || typeof occurrence.eOpenTimestamp !== "string"
    || occurrence.eOpenTimestamp.trim().length === 0
  ) return undefined;
  return {
    sourceFingerprint: occurrence.sourceFingerprint,
    formulaHash: occurrence.formulaHash,
    contractSymbol: occurrence.contractSymbol,
    tradingDate: occurrence.tradingDate,
    direction: occurrence.direction,
    pOpenTimestamp: occurrence.pOpenTimestamp,
    eOpenTimestamp: occurrence.eOpenTimestamp,
  };
}

function describePullbackSignalIdentity(identity: PullbackArmSignalIdentity | null | undefined): string {
  if (!identity) return "<missing>";
  return JSON.stringify(identity);
}

function evidenceCandle(candle: SimulatedFuturesCandle | null | undefined): Record<string, number | boolean> | null {
  if (!candle) return null;
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    isComplete: candle.isComplete,
  };
}

function managementFromAudit(
  record: BacktestAuditRecord,
  trade: BacktestTrade | undefined,
): HistoricalOccurrence["management"] {
  const specification = getFuturesContractSpecification(
    parseMesContractSymbol(record.contractSymbol)?.rootSymbol ?? record.contractSymbol,
  );
  const calendar = sessionCalendarForContract(specification);
  const close = sessionWindow(record.tradingDate, "regular", calendar)?.closeTime ?? null;
  const strategyStopPrice = trade?.audit?.strategyStopPrice ?? record.strategyStopPrice;
  const catastropheStopPrice = trade?.audit?.catastropheStopPrice ?? record.catastropheStopPrice;
  const candidateTargetPlan = trade?.candidateId ? trade.targetPlan : undefined;
  const targetPlan = candidateTargetPlan ?? record.targetPlan;
  const targetPrice = candidateTargetPlan
    ? candidateTargetPlan.targetPrice
    : trade?.audit?.targetPrice ?? record.targetPrice;
  const contracts = trade?.contracts ?? record.contracts ?? null;
  const missingEvidenceReasons = [
    ...(strategyStopPrice === null ? ["strategyStopPrice"] : []),
    ...(targetPrice === null && targetPlan?.disposition !== "NO_ELIGIBLE_KEY_LEVEL" ? ["targetPrice"] : []),
    ...(contracts === null ? ["contracts"] : []),
    ...(close === null ? ["sessionCloseTime"] : []),
  ];
  return {
    strategyStopPrice,
    catastropheStopPrice,
    targetPrice,
    ...(targetPlan ? { targetPlan } : {}),
    contracts,
    runnerActivationPrice: targetPrice,
    runnerExitRule: targetPrice === null
      ? null
      : "Existing governed runner exits at the 40% adverse retracement after target activation.",
    sessionCloseTime: close === null ? null : new Date(close).toISOString(),
    sourceAuditId: record.id,
    missingEvidenceReasons,
  };
}

function classifyRejection(reason: string | null, decision: string): BacktestAuditRecord["rejectionCategory"] {
  if (decision === "SETUP QUALIFIED" && reason === null) return "QUALIFIED";
  if (!reason) return "FAILURE";
  if (reason === "POSITION_ACTIVE") return "POSITION_ACTIVE";
  if (reason.startsWith("AMBIGUOUS")) return "AMBIGUITY";
  if (reason.includes("EXPIRED")) return "EXPIRED";
  if (reason.includes("WAIT") || reason.includes("NOT_COMPLETED") || reason.includes("NOT_AT_CURSOR")) return "WAITING";
  if (reason.includes("RISK") || reason.includes("CONTRACT") || reason.includes("DAILY")) return "RISK_REJECTION";
  return "FAILURE";
}

function setAuditRejection(record: BacktestAuditRecord, reason: string | null, summary = reason): void {
  record.rejectionReason = reason;
  record.rejectionCategory = classifyRejection(reason, record.decision);
  record.rejectionSummary = summary;
}

function targetLevelsForSnapshot(
  snapshot: MarketSnapshot,
  causalEntryOpenTime?: number,
  causalSourceCandles?: readonly SimulatedFuturesCandle[],
  causalContractSymbol?: string,
): KeyLevelTargetInput[] {
  const levels: KeyLevelTargetInput[] = [];
  let vwap = snapshot.indicators.vwap;
  let ema200 = snapshot.indicators.ema200;
  if (causalEntryOpenTime !== undefined) {
    const sourceCandles = causalSourceCandles
      ? (() => {
        const sourceContractSymbol = causalContractSymbol
          ?? causalSourceCandles.find((candle) => candle.openTime === causalEntryOpenTime)?.contractSymbol
          ?? causalSourceCandles
            .filter((candle) => candle.isComplete && candle.openTime <= causalEntryOpenTime)
            .sort((first, second) => first.openTime - second.openTime)
            .at(-1)
            ?.contractSymbol
          ?? causalContractSymbol
          ?? snapshot.contract.fullContractSymbol;
        const matching = causalSourceCandles.filter((candle) => candle.contractSymbol === sourceContractSymbol);
        return matching.length ? [...matching] : [...causalSourceCandles];
      })()
      : snapshot.candles.map((candle) => ({
        ...candle,
        timestamp: Date.parse(candle.timestamp),
        openTime: Date.parse(candle.openTime),
        closeTime: Date.parse(candle.closeTime),
      }));
    const entryCandle = sourceCandles.find((candle) => candle.openTime === causalEntryOpenTime)
      ?? sourceCandles
        .filter((candle) => candle.isComplete && candle.openTime <= causalEntryOpenTime)
        .sort((first, second) => first.openTime - second.openTime)
        .at(-1);
    if (entryCandle) {
      const causalCandles = sourceCandles.filter((candle) => candle.isComplete && candle.closeTime <= entryCandle.closeTime);
      const calendar = sessionCalendarForContract(snapshot.contract);
      const causalVwap = regularSessionVwap(causalCandles, calendar, snapshot.replay.tradingDate);
      const causalEma = causalEmaSeries(
        causalCandles.filter((candle) => classifyFuturesSession(candle.openTime, calendar) !== "closed"),
        200,
      ).points.at(-1)?.value ?? null;
      vwap = Number.isFinite(causalVwap) ? causalVwap : null;
      ema200 = causalEma === null ? null : causalEma;
    }
  }
  const add = (id: string, type: string, price: number | null | undefined) => {
    if (typeof price === "number" && Number.isFinite(price)) levels.push({ id, type, price });
  };
  add("premarket-high", "PREMARKET", snapshot.levels.premarketHigh);
  add("premarket-low", "PREMARKET", snapshot.levels.premarketLow);
  add("previous-day-high", "PREVIOUS_DAY", snapshot.levels.previousDayHigh);
  add("previous-day-low", "PREVIOUS_DAY", snapshot.levels.previousDayLow);
  add("two-days-ago-high", "TWO_DAYS_AGO", snapshot.levels.dayBeforeYesterdayHigh);
  add("two-days-ago-low", "TWO_DAYS_AGO", snapshot.levels.dayBeforeYesterdayLow);
  add("orb-high", "ORB", snapshot.levels.openingRangeHigh);
  add("orb-low", "ORB", snapshot.levels.openingRangeLow);
  add("ntz-high", "NTZ", snapshot.levels.ntzHigh);
  add("ntz-low", "NTZ", snapshot.levels.ntzLow);
  add("vwap", "VWAP", vwap);
  add("ema-200", "EMA200", ema200);
  for (const level of snapshot.majorLevels) {
    levels.push({
      id: `major-${level.name}`,
      type: level.kind,
      price: level.price,
      rangeLow: level.zoneLow,
      rangeHigh: level.zoneHigh,
    });
  }
  for (const level of snapshot.dynamiteLevels) {
    levels.push({
      id: level.id,
      type: "DYNAMITE",
      price: level.representative,
      rangeLow: level.lower,
      rangeHigh: level.upper,
    });
  }
  return filterEligibleKeyLevelInputs(levels);
}

function targetPlanForSnapshot(
  snapshot: MarketSnapshot,
  direction: Direction,
  entryPrice: number,
  causalSourceCandles?: readonly SimulatedFuturesCandle[],
  causalContractSymbol?: string,
  causalEntryOpenTime?: number,
): KeyLevelTargetPlan {
  const patienceCandle = snapshot.reversalPatience?.patienceCandle
    ?? snapshot.patience.patienceCandle;
  const entryCandle = snapshot.reversalPatience?.triggerCandle
    ?? snapshot.patience.triggerCandle;
  return buildKeyLevelTargetPlan({
    direction,
    entryPrice,
    levels: targetLevelsForSnapshot(
      snapshot,
      causalEntryOpenTime
        ?? (entryCandle ? Date.parse(entryCandle.openTime) : patienceCandle ? Date.parse(patienceCandle.openTime) : undefined),
      causalSourceCandles,
      causalContractSymbol,
    ),
    // The first level beyond the entry buffer is the take-profit price.
    // Do not let an older persisted strategy snapshot re-enable the
    // deprecated near-side placement behavior.
    placementMode: "EXACT_LEVEL",
  });
}

function targetLevelSnapshotForOccurrence(
  occurrence: Pick<
    HistoricalOccurrence,
    | "auditId"
    | "eOpenTimestamp"
    | "entryObservationTimestamp"
    | "sourceFingerprint"
    | "formulaHash"
    | "evaluationCursor"
  >,
  levels: readonly KeyLevelTargetInput[],
): TargetLevelSnapshot {
  const frozenLevelInputs = filterEligibleKeyLevelInputs(levels).map((level) => ({ ...level }));
  return Object.freeze({
    frozenAt: occurrence.entryObservationTimestamp ?? occurrence.evaluationCursor,
    sourceAuditCursor: occurrence.evaluationCursor,
    sourceAuditId: occurrence.auditId,
    eOpenTimestamp: occurrence.eOpenTimestamp,
    eCloseTimestamp: occurrence.entryObservationTimestamp,
    sourceFingerprint: occurrence.sourceFingerprint,
    formulaHash: occurrence.formulaHash,
    configurationHash: activeShadowStrategySnapshot().formulaHash,
    frozenLevelInputs: Object.freeze(frozenLevelInputs),
  });
}

function targetLevelSnapshotForAudit(
  record: BacktestAuditRecord,
  sourceFingerprint: string,
  formulaHash: string,
  eOpenTimestamp: string | null,
  eCloseTimestamp: string | null,
): TargetLevelSnapshot | undefined {
  if (
    eOpenTimestamp === null
    || eCloseTimestamp === null
    || !Number.isFinite(Date.parse(eOpenTimestamp))
    || !Number.isFinite(Date.parse(eCloseTimestamp))
  ) return undefined;
  return Object.freeze({
    // A target becomes causal only when the canonical immediate E candle has
    // completed. Preserve the audit's actual observation cursor rather than
    // retimestamping an audit as if it were observed at E close.
    frozenAt: record.evaluatedCandleOpenTime,
    sourceAuditCursor: record.evaluatedCandleOpenTime,
    sourceAuditId: record.id,
    eOpenTimestamp,
    eCloseTimestamp,
    sourceFingerprint,
    formulaHash,
    configurationHash: activeShadowStrategySnapshot().formulaHash,
    frozenLevelInputs: Object.freeze(filterEligibleKeyLevelInputs(record.targetLevelInputs ?? []).map((level) => ({ ...level }))),
  });
}

function preferredTargetLevelSnapshot(
  snapshots: readonly (TargetLevelSnapshot | undefined)[],
  occurrence: Pick<
    HistoricalOccurrence,
    | "status"
    | "signalStatus"
    | "sourceFingerprint"
    | "formulaHash"
    | "eOpenTimestamp"
    | "entryObservationTimestamp"
    | "entryCandle"
  >,
): TargetLevelSnapshot | undefined {
  if (
    occurrence.status !== "SIGNAL_CONFIRMED"
    && occurrence.signalStatus !== "SIGNAL_CONFIRMED"
  ) return undefined;
  const eOpenTimestamp = occurrence.eOpenTimestamp;
  const eCloseTimestamp = occurrence.entryObservationTimestamp;
  const eOpen = eOpenTimestamp === null ? Number.NaN : Date.parse(eOpenTimestamp);
  const eClose = eCloseTimestamp === null ? Number.NaN : Date.parse(eCloseTimestamp);
  const canonicalEntryOpen = typeof occurrence.entryCandle?.openTime === "number"
    ? occurrence.entryCandle.openTime
    : Number.NaN;
  const canonicalEntryClose = typeof occurrence.entryCandle?.closeTime === "number"
    ? occurrence.entryCandle.closeTime
    : Number.NaN;
  if (
    eOpenTimestamp === null
    || eCloseTimestamp === null
    || !Number.isFinite(eOpen)
    || !Number.isFinite(eClose)
    || !occurrence.entryCandle
    || occurrence.entryCandle.isComplete !== true
    || canonicalEntryOpen !== eOpen
    || canonicalEntryClose !== eClose
  ) return undefined;
  return snapshots
    .filter((snapshot): snapshot is TargetLevelSnapshot => snapshot !== undefined)
    .filter((snapshot) =>
      snapshot.eOpenTimestamp === eOpenTimestamp
      && snapshot.eCloseTimestamp === eCloseTimestamp
       && Number.isFinite(Date.parse(snapshot.sourceAuditCursor ?? snapshot.frozenAt))
       && Date.parse(snapshot.sourceAuditCursor ?? snapshot.frozenAt) >= eClose
      && snapshot.sourceFingerprint === occurrence.sourceFingerprint
      && snapshot.formulaHash === occurrence.formulaHash
    )
    .sort((left, right) =>
      (Date.parse(left.sourceAuditCursor ?? left.frozenAt) || Number.POSITIVE_INFINITY)
      - (Date.parse(right.sourceAuditCursor ?? right.frozenAt) || Number.POSITIVE_INFINITY)
      || left.sourceAuditId.localeCompare(right.sourceAuditId)
    )[0];
}

function auditForEvaluation(
  evaluation: MarketSnapshot["setupAnalysis"]["evaluations"][number],
  snapshot: MarketSnapshot,
  candle: SimulatedFuturesCandle,
  tradingDate: string,
  period: "in_sample" | "out_of_sample",
  executionMode: "quote_based_shadow" | "ohlcv_modeled",
  contractSymbol: string,
  contractMonth: string,
  governedConsolidation: ConsolidationThresholds,
  causalSourceCandles?: readonly SimulatedFuturesCandle[],
  causalContractSymbol?: string,
  visibleCausalCandles?: readonly SimulatedFuturesCandle[],
): BacktestAuditRecord {
  const rejectionReason = evaluation.decision === "SETUP QUALIFIED" ? null : `RULES_NOT_QUALIFIED:${evaluation.setupType}`;
  const signalPatience = ["EQUIVALENT_CANDLE_REVERSAL", "PEAK_RETRACEMENT_REVERSAL"].includes(evaluation.setupType)
    ? snapshot.reversalPatience ?? snapshot.patience
    : snapshot.patience;
  const consolidationEdgeEvaluation = snapshot.setupAnalysis.evaluations
    .find((candidate) => candidate.setupType === "CONSOLIDATION_BREAKOUT_CONTINUATION");
  const toGuardCandle = (candle: typeof signalPatience.patienceCandle | typeof signalPatience.triggerCandle) =>
    candle && Number.isFinite(Date.parse(candle.openTime)) && Number.isFinite(Date.parse(candle.closeTime))
      ? {
        openTime: Date.parse(candle.openTime),
        closeTime: Date.parse(candle.closeTime),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: 0,
        isComplete: candle.isComplete,
      }
      : null;
  const guardPatience = {
    patienceCandle: toGuardCandle(signalPatience.patienceCandle),
    triggerCandle: toGuardCandle(signalPatience.triggerCandle),
    entryBufferTicks: signalPatience.entryBufferTicks,
    entryBufferPrice: signalPatience.entryBufferPrice,
  };
  const guardDirection = evaluation.direction ?? snapshot.breakout.direction ?? null;
  const finalizedNtz = snapshot.ntz.complete
    && typeof snapshot.ntz.high === "number"
    && typeof snapshot.ntz.low === "number"
    ? { high: snapshot.ntz.high, low: snapshot.ntz.low, complete: true }
    : null;
  const consolidationGuard = evaluation.setupType === "CONSOLIDATION_BREAKOUT_CONTINUATION"
    ? serializeConsolidationGuard(evaluateConsolidationEntryGuard({
      candles: visibleCausalCandles ?? [],
      levels: { ntz: finalizedNtz },
      patience: guardPatience,
      direction: guardDirection,
      breakout: {
        detected: snapshot.breakout.detected,
        direction: snapshot.breakout.direction,
        candleOpenTime: snapshot.breakout.candleOpenTime ? Date.parse(snapshot.breakout.candleOpenTime) : null,
        continuationConfirmed: snapshot.breakout.continuationConfirmed,
        failed: snapshot.breakout.failed,
      },
      config: activeShadowStrategySnapshot().config,
      consolidationEvaluation: consolidationEdgeEvaluation,
      qualifyingPullback: snapshot.pullback.events.some((event) =>
        event.qualifies === true
        && ["touch", "proximity", "consolidation", "break and reclaim", "hold"].includes(event.type)
        && !event.level.trim().toLowerCase().startsWith("fib"),
      ),
    }))
    : null;
  return {
    id: `${tradingDate}-${candle.openTime}-${evaluation.setupType}`,
    tradingDate,
    contractSymbol,
    contractMonth,
    period,
    evaluatedCandleOpenTime: new Date(candle.openTime).toISOString(),
    setupType: evaluation.setupType,
    direction: evaluation.direction,
    decision: evaluation.decision,
    alertOnly: evaluation.alertOnly,
    rejectionReason,
    rejectionCategory: classifyRejection(rejectionReason, evaluation.decision),
    rejectionSummary: evaluation.decision === "SETUP QUALIFIED"
      ? null
      : evaluation.rules.filter((rule) => !rule.passed).map((rule) => `${rule.key}: ${rule.detail}`).join("; ") || evaluation.explanation,
    ruleEvidence: evaluation.rules.map((rule) => `${rule.passed ? "PASS" : "FAIL"} ${rule.key}: ${rule.detail}`),
    orbState: snapshot.breakout.state,
    breakoutEvidence: snapshot.breakout.detail,
    volumeEvidence: snapshot.volumeAnalysis.reversalWarning
      ?? (snapshot.volumeAnalysis.supportingBreakoutVolume ? "Breakout volume supported." : "Breakout volume neutral or unavailable."),
    pullbackEvidence: snapshot.pullback.events.length
      ? snapshot.pullback.events.map((event) => `${event.type} at ${event.level} (${event.price}): ${event.detail}`).join("; ")
      : snapshot.pullback.detail,
    criticalLevelEvidence: snapshot.levels.critical.map((level) => `${level.name} ${level.price}`).join("; ") || "No critical level evidence.",
    trendEvidence: `${snapshot.trend.direction}: ${snapshot.trend.evidence.join("; ")}`,
    patienceState: snapshot.patience.state,
    patienceCandle: evidenceCandle(snapshot.patience.patienceCandle as SimulatedFuturesCandle | null),
    triggerCandle: evidenceCandle(snapshot.patience.triggerCandle as SimulatedFuturesCandle | null),
    patienceCandleOpenTime: snapshot.patience.patienceCandle?.openTime ?? null,
    patienceCandleCloseTime: snapshot.patience.patienceCandle?.closeTime ?? null,
    patienceCandleExtreme: snapshot.patience.patienceCandle
      ? evaluation.direction === "long"
        ? snapshot.patience.patienceCandle.low
        : snapshot.patience.patienceCandle.high
      : null,
    stopBufferTicks: snapshot.patience.stopBufferTicks,
    stopBufferPoints: snapshot.patience.stopBufferTicks * getFuturesContractSpecification(
      parseMesContractSymbol(contractSymbol)?.rootSymbol ?? contractSymbol,
    ).tickSize,
    finalStrategyStopBoundary: snapshot.patience.strategyStopPrice,
    stopDirection: evaluation.direction ?? null,
    stopSourceAuditId: `${tradingDate}-${candle.openTime}-${evaluation.setupType}`,
    triggerCandleOpenTime: snapshot.patience.triggerCandle?.openTime ?? null,
    triggerCandleCloseTime: snapshot.patience.triggerCandle?.closeTime ?? null,
    modeledFillObservationTime: null,
    exitCandleOpenTime: null,
    exitCandleCloseTime: null,
     entryTriggerPrice: consolidationGuard?.effectiveEntryThreshold ?? snapshot.patience.entryBufferPrice,
     patienceConfirmationThreshold: consolidationGuard?.patienceConfirmationThreshold ?? snapshot.patience.entryBufferPrice,
     consolidationBoundaryThreshold: consolidationGuard?.consolidationBoundaryThreshold ?? null,
     effectiveEntryThreshold: consolidationGuard?.effectiveEntryThreshold ?? snapshot.patience.entryBufferPrice,
     effectiveEntryThresholdReached: consolidationGuard?.effectiveEntryThresholdReached ?? null,
     entryOpenedOutsideZone: consolidationGuard?.entryOpenedOutsideZone ?? null,
     entryClosedOutsideZone: consolidationGuard?.entryClosedOutsideZone ?? null,
     entryRangeOverlappedZone: consolidationGuard?.entryRangeOverlappedZone ?? null,
     entryFillOutsideZone: consolidationGuard?.entryFillOutsideZone ?? null,
     consolidationEntryDisposition: consolidationGuard?.consolidationEntryDisposition,
    strategyStopPrice: snapshot.riskPlan.strategyStop,
    catastropheStopPrice: snapshot.riskPlan.catastropheStop,
    targetPrice: snapshot.riskPlan.target,
    targetLevelInputs: targetLevelsForSnapshot(
      snapshot,
      candle.openTime,
      causalSourceCandles,
      causalContractSymbol ?? contractSymbol,
    ),
    contracts: snapshot.riskPlan.contracts,
    eventLabels: [],
    ambiguityLabels: [],
    executionMode,
    fees: 0,
    slippage: 0,
    grossPnl: null,
    netPnl: null,
    exitReason: null,
    confirmationBufferTicks: snapshot.patience.entryBufferTicks,
    pullbackArmId: snapshot.pullback.armId ?? null,
    pullbackArmState: snapshot.pullback.armState,
    pullbackArmTransitions: (snapshot.pullback.armTransitions ?? []).map((transition) => ({
      ...transition,
      time: new Date(transition.time).toISOString(),
    })),
    latePullbackInteractions: snapshot.pullback.lateInteractionCount ?? 0,
    finalizedNtzHigh: snapshot.ntz.high ?? null,
    finalizedNtzLow: snapshot.ntz.low ?? null,
    finalizedNtzComplete: snapshot.ntz.complete,
    supportingConfluences: evaluation.supportingConfluences ?? [],
    setupGrade: evaluation.grade && evaluation.grade >= 2 ? "A++" : evaluation.grade && evaluation.grade >= 1 ? "A+" : "A",
    consolidationThresholds: governedConsolidation,
    consolidationGuard,
    pullbackOccurrences: snapshot.pullback.events.map((event) => ({ ...event })),
    patienceOccurrences: [...(snapshot.patience.occurrences ?? [])],
  };
}

function stageRank(stage: QualificationFunnelStage): number {
  return QUALIFICATION_FUNNEL_STAGES.indexOf(stage);
}

function passedRule(record: BacktestAuditRecord, pattern: RegExp): boolean {
  return record.ruleEvidence.some((evidence) => evidence.startsWith("PASS ") && pattern.test(evidence));
}

function stageEvidence(
  record: BacktestAuditRecord,
  trade: BacktestTrade | undefined,
): boolean[] {
  const ruleText = record.ruleEvidence.join(" ");
  const marketText = `${record.breakoutEvidence} ${record.trendEvidence} ${record.pullbackEvidence}`;
  const orbCompleted = passedRule(record, /(?:ntz|orb)/i)
    || !/(?:NOT_COMPLETED|INCOMPLETE|WAITING)/i.test(record.orbState);
  const strongBreakout = record.setupType === "ORB_PULLBACK_CONTINUATION"
    ? passedRule(record, /closeOutsideNtz/)
    : passedRule(record, /(?:breakout|orb|impulse|strong)/i)
      || /(?:strong|confirmed|breakout|impulse)/i.test(record.breakoutEvidence);
  const continuation = record.setupType === "ORB_PULLBACK_CONTINUATION"
    ? orbCompleted && record.orbState !== "SETUP_EXPIRED" && !/BREAKOUT_FAILED|ORB_REENTRY_INVALIDATED/i.test(record.breakoutEvidence)
    : passedRule(record, /(?:continuation|trend|alignment|follow)/i)
      || /(?:continuation|aligned|follow-through|follow through)/i.test(marketText);
  const pullback = passedRule(record, /(?:pullback|consolidation|retest)/i)
    || /(?:pullback|consolidation|retest)/i.test(record.pullbackEvidence);
  const criticalLevel = record.setupType === "ORB_PULLBACK_CONTINUATION"
    ? passedRule(record, /levelContext/)
    : passedRule(record, /(?:critical|level|ntz|orb)/i)
    || (record.criticalLevelEvidence !== "No critical level evidence." && record.criticalLevelEvidence.length > 0);
  const fibonacci = record.setupType === "ORB_PULLBACK_CONTINUATION"
    ? true
    : passedRule(record, /fibonacci|fib/i)
      || /fibonacci|fib/i.test(ruleText);
  const volume = record.setupType === "ORB_PULLBACK_CONTINUATION"
    ? true
    : passedRule(record, /volume/i)
      || /supported|confirmed/i.test(record.volumeEvidence);
  const patience = record.patienceCandle !== null
    || /valid|confirmed|ready|aligned/i.test(record.patienceState);
  const trigger = record.triggerCandle !== null
    || record.modeledFillObservationTime !== null
    || /trigger|confirmed/i.test(record.patienceState);
  const risk = trade !== undefined
    || (record.rejectionReason !== "RISK_REJECTED"
      && (record.decision === "SETUP QUALIFIED" || passedRule(record, /risk|stop|target|contract|daily/i)));
  const entry = trade !== undefined;
  const exit = trade !== undefined && trade.exitTime !== null;
  return [
    true,
    orbCompleted,
    strongBreakout,
    continuation,
    pullback,
    criticalLevel,
    fibonacci,
    volume,
    patience,
    trigger,
    risk,
    entry,
    exit,
  ];
}

function contiguousStage(stageFlags: readonly boolean[]): QualificationFunnelStage {
  let rank = 0;
  for (let index = 1; index < stageFlags.length; index += 1) {
    if (!stageFlags[index]) break;
    rank = index;
  }
  return QUALIFICATION_FUNNEL_STAGES[rank];
}

function candidateKey(record: Pick<BacktestAuditRecord, "tradingDate" | "contractSymbol" | "setupType" | "direction" | "evaluatedCandleOpenTime">): string {
  return [
    record.tradingDate,
    record.contractSymbol,
    record.setupType,
    record.direction ?? "unknown",
    record.evaluatedCandleOpenTime,
  ].join("|");
}

function tradeForRecord(record: BacktestAuditRecord, trades: readonly BacktestTrade[]): BacktestTrade | undefined {
  return trades.find((trade) => (
    trade.tradingDate === record.tradingDate
    && trade.contractSymbol === record.contractSymbol
    && trade.setupType === record.setupType
    && trade.direction === record.direction
    && (
      trade.audit?.triggerCandleOpenTime === record.triggerCandleOpenTime
      || trade.entryTime === record.triggerCandleCloseTime
      || trade.entryTime === record.evaluatedCandleOpenTime
    )
  ));
}

function occurrenceCandle(candle: { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume?: number; isComplete?: boolean } | null | undefined): Record<string, number | boolean> | null {
  if (!candle) return null;
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    ...(candle.volume === undefined ? {} : { volume: candle.volume }),
    isComplete: candle.isComplete ?? true,
  };
}

function numericCandleValue(
  candle: Record<string, number | boolean> | null | undefined,
  key: string,
): number | null {
  const value = candle?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function occurrenceId(seed: string): string {
  return `occ-${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

function governedOccurrenceId(value: HistoricalOccurrence): string {
  if (value.kind === "patience") {
    return occurrenceId([
      "historical-patience-occurrence-v3",
      value.sourceFingerprint,
      value.formulaHash,
      value.formulaVersion,
      value.contractSymbol,
      value.tradingDate,
      value.direction,
      value.patienceTimestamp,
      value.eOpenTimestamp,
    ].map((part) => part ?? "absent").join("|"));
  }
  const actualObservedE = value.nextObservedCandle && typeof value.nextObservedCandle.openTime === "number"
    ? value.nextObservedCandle.openTime
    : null;
  return occurrenceId([
    "historical-occurrence-v2",
    value.sourceFingerprint,
    value.formulaHash,
    value.formulaVersion,
    value.contractSymbol,
    value.tradingDate,
    value.kind,
    value.strategyCandidate,
    value.direction,
    value.lEventId,
    value.lTimestamp,
    value.patienceTimestamp,
    value.expectedEntryTimestamp,
    actualObservedE,
    value.entryTimestamp,
    value.status,
    value.signalStatus,
    value.eligibilityArmId,
  ].map((part) => part ?? "absent").join("|"));
}

export function sourceFingerprint(dataset: CausalReplayDataset): string {
  const digest = createHash("sha256");
  digest.update("levelstory-causal-source-v2|");
  if (dataset.contentFingerprint) digest.update(`importer:${dataset.contentFingerprint}|`);
  const candles = [...dataset.candles].sort((first, second) =>
    first.contractSymbol.localeCompare(second.contractSymbol)
    || first.openTime - second.openTime
    || first.closeTime - second.closeTime,
  );
  for (const candle of candles) {
    digest.update(JSON.stringify({
      contract: candle.contractSymbol,
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      isComplete: candle.isComplete,
    }));
    digest.update("\n");
  }
  digest.update(JSON.stringify({
    source: dataset.source ?? "simulated",
    contractSymbol: dataset.contractSymbol,
    contractMonth: dataset.contractMonth,
    selectedDates: dataset.selectedDates ?? [...dataset.inSampleDates, ...dataset.outOfSampleDates],
    schedule: dataset.contractSchedule?.version ?? null,
  }));
  return digest.digest("hex");
}

type HistoricalPullbackEvent = NonNullable<BacktestAuditRecord["pullbackOccurrences"]>[number];

function causalEvidenceForAudit(record: BacktestAuditRecord): HistoricalOccurrence["causalEvidence"] {
  return {
    sourceAuditId: record.id,
    sourceEdge: canonicalStrategyId(record.setupType) ?? record.setupType,
    evidenceTimestamp: record.evaluatedCandleOpenTime,
    ruleEvidence: [...record.ruleEvidence],
    orbState: record.orbState,
    breakoutEvidence: record.breakoutEvidence,
    pullbackEvidence: record.pullbackEvidence,
    criticalLevelEvidence: record.criticalLevelEvidence,
    trendEvidence: record.trendEvidence,
    patienceState: record.patienceState,
    patienceCandleOpenTime: record.patienceCandleOpenTime,
    patienceCandleCloseTime: record.patienceCandleCloseTime,
    triggerCandleOpenTime: record.triggerCandleOpenTime,
    triggerCandleCloseTime: record.triggerCandleCloseTime,
  };
}

const QUALIFYING_PULLBACK_EVENT_TYPES = new Set([
  "touch",
  "proximity",
  "consolidation",
  "break and reclaim",
  "hold",
]);

function isDiagnosticOnlyPullbackLevel(level: string): boolean {
  return /^(?:fib|fibonacci)\b/i.test(level.trim());
}

function pullbackEventId(event: HistoricalPullbackEvent): string {
  return event.eventId ?? `pullback|${event.type}|${event.time}|${event.level}|${event.price}`;
}

function pullbackEventOpenTime(event: HistoricalPullbackEvent): number {
  return event.candle?.openTime ?? Date.parse(event.time);
}

function linkedPullbackEvents(
  record: BacktestAuditRecord,
  patience: PatienceOccurrence,
): HistoricalPullbackEvent[] {
  const events = (record.pullbackOccurrences ?? []).filter((event) =>
    event.qualifies !== false
      && QUALIFYING_PULLBACK_EVENT_TYPES.has(event.type)
      && !isDiagnosticOnlyPullbackLevel(event.level),
  );
  const exact = patience.eligibilityEventId
    ? events.find((event) => pullbackEventId(event) === patience.eligibilityEventId)
    : undefined;
  const anchor = exact ?? events.find((event) => Date.parse(event.time) === patience.eligibilityTime);
  if (!anchor) return [];
  const anchorOpenTime = pullbackEventOpenTime(anchor);
  return events.filter((event) => pullbackEventOpenTime(event) === anchorOpenTime);
}

type CanonicalPatienceStatus =
  | "PATIENCE_SHAPE_FOUND"
  | "IMMEDIATE_CONFIRMATION_FAILED"
  | "SIGNAL_CONFIRMED"
  | "STRUCTURALLY_INVALIDATED";

function canonicalPatienceStatus(patience: PatienceOccurrence): CanonicalPatienceStatus {
  if (patience.qualificationStatus) return patience.qualificationStatus;
  if (patience.outcomeStatus === "CONFIRMED" || patience.status === "ENTRY_TRIGGERED") return "SIGNAL_CONFIRMED";
  if (patience.status === "OPPOSITE_SIDE_INVALIDATION" || patience.status === "AMBIGUOUS_EVENT_ORDER") return "STRUCTURALLY_INVALIDATED";
  if (patience.status === "PATIENCE_CANDLE_EXPIRED") return "IMMEDIATE_CONFIRMATION_FAILED";
  return "PATIENCE_SHAPE_FOUND";
}

function canonicalPatienceIdentityViolations(input: {
  tradingDate: string;
  contractSymbol: string;
  patienceCandle: { openTime: number; closeTime: number };
  pOpenTimestamp: string | null;
  eOpenTimestamp: string | null;
  entryObservationTimestamp: string | null;
  confirmedEntry: { openTime: number; closeTime: number } | null;
  expectedEntryCandleOpenTime: number;
}): string[] {
  const violations: string[] = [];
  const pOpen = input.patienceCandle.openTime;
  const pClose = input.patienceCandle.closeTime;
  const eOpen = input.confirmedEntry?.openTime ?? input.expectedEntryCandleOpenTime;
  const eClose = input.confirmedEntry?.closeTime ?? Number.NaN;
  const pTimestamp = input.pOpenTimestamp ? Date.parse(input.pOpenTimestamp) : Number.NaN;
  const eTimestamp = input.eOpenTimestamp ? Date.parse(input.eOpenTimestamp) : Number.NaN;
  const observationTimestamp = input.entryObservationTimestamp
    ? Date.parse(input.entryObservationTimestamp)
    : Number.NaN;
  if (!Number.isFinite(pOpen) || !Number.isFinite(pTimestamp) || pTimestamp !== pOpen) {
    violations.push("P_OPEN_MISMATCH");
  }
  if (!Number.isFinite(pClose) || pClose - pOpen !== 5 * 60_000) {
    violations.push("P_NOT_FIVE_MINUTES");
  }
  if (!Number.isFinite(eOpen) || !Number.isFinite(eTimestamp) || eTimestamp !== eOpen) {
    violations.push("E_OPEN_MISMATCH");
  }
  if (!Number.isFinite(eClose) || eClose - eOpen !== 5 * 60_000) {
    violations.push("E_NOT_FIVE_MINUTES");
  }
  if (!Number.isFinite(pClose) || pClose !== eOpen) {
    violations.push("E_NOT_IMMEDIATE_NEXT_CANDLE");
  }
  if (!input.confirmedEntry || input.confirmedEntry.openTime !== input.expectedEntryCandleOpenTime) {
    violations.push("CONFIRMATION_NOT_ON_IMMEDIATE_E");
  }
  if (!Number.isFinite(observationTimestamp) || observationTimestamp !== eClose) {
    violations.push("E_CLOSE_OBSERVATION_MISMATCH");
  }
  if (Number.isFinite(pOpen) && Number.isFinite(eOpen)) {
    const root = input.contractSymbol.replace(/[FGHJKMNQUVXZ]\d$/, "");
    const calendar = sessionCalendarForContract(getFuturesContractSpecification(root || input.contractSymbol));
    if (tradingDateForTimestamp(pOpen, calendar) !== input.tradingDate
      || tradingDateForTimestamp(eOpen, calendar) !== input.tradingDate) {
      violations.push("P_E_TRADING_DATE_MISMATCH");
    }
  } else {
    violations.push("P_E_TIMESTAMP_INVALID");
  }
  return [...new Set(violations)];
}

function patienceStatusRank(status: string): number {
  return status === "SIGNAL_CONFIRMED"
    ? 4
    : status === "STRUCTURALLY_INVALIDATED"
      ? 3
      : status === "IMMEDIATE_CONFIRMATION_FAILED"
        ? 2
        : status === "PATIENCE_SHAPE_FOUND"
          ? 1
          : 0;
}

function patienceSequenceIdentity(
  patience: PatienceOccurrence,
  linkedPullback: HistoricalPullbackEvent | undefined,
): string {
  return patience.eligibilityArmId
    ?? patience.eligibilityEventId
    ?? (linkedPullback ? pullbackEventId(linkedPullback) : "unarmed");
}

function levelEvidence(events: readonly HistoricalPullbackEvent[]): {
  identifiers: string[];
  values: Record<string, number>;
  distancesTicks: Record<string, number>;
  tolerancePoints: Record<string, number>;
  toleranceTicks: Record<string, number>;
  interactionTypes: Record<string, string[]>;
} {
  const identifiers: string[] = [];
  const values: Record<string, number> = {};
  const distancesTicks: Record<string, number> = {};
  const tolerancePoints: Record<string, number> = {};
  const toleranceTicks: Record<string, number> = {};
  const interactionTypes: Record<string, string[]> = {};
  for (const event of events) {
    if (!identifiers.includes(event.level)) identifiers.push(event.level);
    values[event.level] ??= event.price;
    distancesTicks[event.level] = Math.min(distancesTicks[event.level] ?? Number.POSITIVE_INFINITY, event.distanceTicks ?? 0);
    if (event.tolerancePoints !== undefined) tolerancePoints[event.level] = event.tolerancePoints;
    if (event.toleranceTicks !== undefined) toleranceTicks[event.level] = event.toleranceTicks;
    interactionTypes[event.level] = [...new Set([...(interactionTypes[event.level] ?? []), event.type])];
  }
  return { identifiers, values, distancesTicks, tolerancePoints, toleranceTicks, interactionTypes };
}

export function buildHistoricalOccurrenceLedger(
  dataset: CausalReplayDataset,
  audits: readonly BacktestAuditRecord[],
  trades: readonly BacktestTrade[],
  reportFormulaHash?: string,
  sourceFingerprintOverride?: string,
): HistoricalOccurrence[] {
  const fingerprint = sourceFingerprintOverride ?? sourceFingerprint(dataset);
  const formulaHash = reportFormulaHash ?? createHash("sha256").update(FIXED_FORMULA_VERSION).digest("hex");
  const byIdentity = new Map<string, HistoricalOccurrence>();
  const auditsAtCursor = new Map<string, BacktestAuditRecord[]>();
  for (const record of audits) {
    const key = `${record.tradingDate}|${record.contractSymbol}|${record.evaluatedCandleOpenTime}|${record.direction ?? "unknown"}`;
    auditsAtCursor.set(key, [...(auditsAtCursor.get(key) ?? []), record]);
  }
  const upsert = (identity: string, value: HistoricalOccurrence) => {
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, { ...value, occurrenceId: governedOccurrenceId(value) });
      return;
    }
    const edgePrecedence = (setupType: string): number => [
      "ORB_PULLBACK_CONTINUATION",
      "CONSOLIDATION_BREAKOUT_CONTINUATION",
      "EQUIVALENT_CANDLE_REVERSAL",
      "PATIENCE_CANDLE_CONTINUATION",
      "PEAK_RETRACEMENT_REVERSAL",
    ].indexOf(canonicalStrategyId(setupType) ?? setupType);
    const primaryByEdge = edgePrecedence(value.strategyCandidate) < edgePrecedence(existing.strategyCandidate)
      ? value
      : existing;
    const evidenceRank = (occurrence: HistoricalOccurrence): number[] => [
      occurrence.kind === "patience" ? patienceStatusRank(occurrence.status) : 0,
      occurrence.entryObservationTimestamp ? 1 : 0,
      occurrence.entryCandle ? 1 : 0,
      occurrence.nextObservedCandle ? 1 : 0,
      occurrence.confirmationExcursion !== null ? 1 : 0,
      occurrence.canonicalTrade ? 1 : 0,
      Date.parse(occurrence.evaluationCursor),
    ];
    const compareEvidence = (left: HistoricalOccurrence, right: HistoricalOccurrence): HistoricalOccurrence => {
      const leftRank = evidenceRank(left);
      const rightRank = evidenceRank(right);
      for (let index = 0; index < leftRank.length; index += 1) {
        if (leftRank[index] !== rightRank[index]) return leftRank[index]! > rightRank[index]! ? left : right;
      }
      return left.auditId.localeCompare(right.auditId) <= 0 ? left : right;
    };
    // The earliest replay cursor can contain only an unclosed E candle. Do not
    // let that partial snapshot win over a later, complete confirmation merely
    // because its strategy label has the same edge precedence.
    const primaryByEvidence = existing.kind === "patience" && value.kind === "patience"
      ? compareEvidence(existing, value)
      : primaryByEdge;
    const selectedTargetSnapshot = preferredTargetLevelSnapshot(
      [existing.targetLevelSnapshot, value.targetLevelSnapshot],
      primaryByEvidence,
    );
    const matches = [...new Set([
      existing.strategyCandidate,
      value.strategyCandidate,
      ...existing.secondaryStrategyMatches,
      ...value.secondaryStrategyMatches,
    ])];
    const merged = {
      ...primaryByEvidence,
      // Edge attribution is independent from confirmation-evidence selection.
      // A secondary audit may provide the better complete snapshot, but it
      // must not become the canonical edge solely because it was observed later.
      strategyCandidate: primaryByEdge.strategyCandidate,
      primaryEdge: primaryByEdge.primaryEdge ?? primaryByEdge.strategyCandidate,
      secondaryStrategyMatches: matches.filter((match) => match !== primaryByEdge.strategyCandidate),
      canonicalTrade: existing.canonicalTrade || value.canonicalTrade,
      identityInvariantViolations: [...new Set([
        ...existing.identityInvariantViolations,
        ...value.identityInvariantViolations,
      ])].sort(),
      levelIdentifiers: [...new Set([...existing.levelIdentifiers, ...value.levelIdentifiers])].sort(),
      levelValues: { ...value.levelValues, ...existing.levelValues },
      // Target inputs belong to the completed-E snapshot, not to the union of
      // every diagnostic cursor that happens to share the physical P→E key.
      targetLevelInputs: selectedTargetSnapshot
        ? [...selectedTargetSnapshot.frozenLevelInputs]
        : primaryByEvidence.targetLevelInputs
          ? filterEligibleKeyLevelInputs(primaryByEvidence.targetLevelInputs)
        : undefined,
      targetLevelSnapshot: selectedTargetSnapshot,
      levelDistancesTicks: { ...value.levelDistancesTicks, ...existing.levelDistancesTicks },
      levelTolerancePoints: { ...value.levelTolerancePoints, ...existing.levelTolerancePoints },
      levelToleranceTicks: { ...value.levelToleranceTicks, ...existing.levelToleranceTicks },
      levelInteractionTypes: Object.fromEntries([...new Set([
        ...Object.keys(existing.levelInteractionTypes),
        ...Object.keys(value.levelInteractionTypes),
      ])].sort().map((level) => [
        level,
        [...new Set([
          ...(existing.levelInteractionTypes[level] ?? []),
          ...(value.levelInteractionTypes[level] ?? []),
        ])].sort(),
      ])),
      eligibilityArmIds: [...new Set([
        ...(existing.eligibilityArmIds ?? (existing.eligibilityArmId ? [existing.eligibilityArmId] : [])),
        ...(value.eligibilityArmIds ?? (value.eligibilityArmId ? [value.eligibilityArmId] : [])),
      ])].sort(),
      auditIds: [...new Set([
        ...(existing.auditIds ?? [existing.auditId]),
        ...(value.auditIds ?? [value.auditId]),
      ])].sort(),
      supportingConfluences: [...new Set([
        ...(existing.supportingConfluences ?? []),
        ...(value.supportingConfluences ?? []),
      ])].sort(),
      ...(
        existing.causalEvidenceByAudit
        || canonicalStrategyId(existing.strategyCandidate) !== canonicalStrategyId(value.strategyCandidate)
        ? {
          causalEvidenceByAudit: [...new Map([
            ...(existing.causalEvidenceByAudit ?? (existing.causalEvidence ? [existing.causalEvidence] : [])),
            ...(value.causalEvidenceByAudit ?? (value.causalEvidence ? [value.causalEvidence] : [])),
          ].map((evidence) => [evidence.sourceAuditId, evidence])).values()],
        }
        : {}
      ),
      matchedEdges: [...new Set([
        ...(existing.matchedEdges ?? [existing.primaryEdge ?? existing.strategyCandidate]),
        ...(value.matchedEdges ?? [value.primaryEdge ?? value.strategyCandidate]),
      ])].sort(),
      ...(existing.kind === "patience" && value.kind === "patience" ? {
         status: patienceStatusRank(value.status) > patienceStatusRank(existing.status) ? value.status : existing.status,
        canonicalOccurrence: true,
        directionSources: [...new Set([
          ...(existing.directionSources ?? (existing.directionSource ? [existing.directionSource] : [])),
          ...(value.directionSources ?? (value.directionSource ? [value.directionSource] : [])),
        ])],
        eligibilityArmTransitionTime: [existing, value]
          .map((item) => item.eligibilityArmTransitionTime)
          .filter((item): item is string => Boolean(item))
          .sort()[0],
      } : {}),
    };
    byIdentity.set(identity, { ...merged, occurrenceId: governedOccurrenceId(merged) });
  };
  for (const record of audits) {
    const trade = tradeForRecord(record, trades);
    const cursor = record.evaluatedCandleOpenTime;
    const auditKey = `${record.tradingDate}|${record.contractSymbol}|${cursor}|${record.direction ?? "unknown"}`;
    const secondary = (auditsAtCursor.get(auditKey) ?? [])
      .filter((candidate) => candidate.id !== record.id && candidate.decision === "SETUP QUALIFIED")
      .map((candidate) => canonicalStrategyId(candidate.setupType) ?? candidate.setupType);
    for (const event of record.pullbackOccurrences ?? []) {
      const identity = [
        "pullback",
        fingerprint,
        formulaHash,
        FIXED_FORMULA_VERSION,
        record.tradingDate,
        record.contractSymbol,
        record.direction ?? "absent",
        event.candle ? new Date(event.candle.openTime).toISOString() : event.time,
        event.level,
      ].join("|");
      const id = occurrenceId(identity);
      const evidence = levelEvidence([event]);
      upsert(identity, {
        occurrenceId: id,
        auditId: record.id,
        kind: "pullback",
        strategyCandidate: canonicalStrategyId(record.setupType) ?? record.setupType,
        secondaryStrategyMatches: secondary,
        tradingDate: record.tradingDate,
        contractSymbol: record.contractSymbol,
        contractMonth: record.contractMonth,
        direction: record.direction,
        lTimestamp: event.candle ? new Date(event.candle.openTime).toISOString() : event.time,
        lEventId: pullbackEventId(event),
        lInteractionType: event.type,
        lCandle: occurrenceCandle(event.candle),
        previousComparisonTimestamp: null,
        patienceTimestamp: null,
        patienceCandle: null,
        candidateShapeResult: null,
        expectedEntryTimestamp: null,
        confirmationThreshold: null,
        confirmationExcursion: null,
        entryTimestamp: null,
        entryCandle: null,
        levelIdentifiers: evidence.identifiers,
        levelValues: evidence.values,
        targetLevelInputs: record.targetLevelInputs,
        levelDistancesTicks: evidence.distancesTicks,
        levelTolerancePoints: evidence.tolerancePoints,
        levelToleranceTicks: evidence.toleranceTicks,
        levelInteractionTypes: evidence.interactionTypes,
        pOpenTimestamp: event.candle ? new Date(event.candle.openTime).toISOString() : event.time,
        eOpenTimestamp: null,
        entryObservationTimestamp: null,
         consolidationGuard: record.consolidationGuard,
         identityInvariantViolations: [],
        confirmationBufferTicks: null,
        nextObservedCandle: null,
        consolidationThresholds: record.consolidationThresholds,
         causalEvidence: causalEvidenceForAudit(record),
         status: "EDGE_FOUND",
        reasonCode: event.detail,
        evaluationCursor: cursor,
        formulaVersion: FIXED_FORMULA_VERSION,
        formulaHash,
        sourceFingerprint: fingerprint,
        canonicalTrade: false,
      });
    }
    for (const patience of record.patienceOccurrences ?? []) {
      const linkedEvents = linkedPullbackEvents(record, patience);
      const linkedPullback = linkedEvents[0];
      const linkedEvidence = levelEvidence(linkedEvents);
      const expectedEntryCandleOpenTime = patience.expectedEntryCandleOpenTime ?? patience.patienceCandle.closeTime;
      const outcomeStatus = (patience.outcomeStatus === "CONFIRMED" ? "SIGNAL_CONFIRMED" : patience.outcomeStatus) ?? (
        patience.status === "ENTRY_TRIGGERED"
           ? "SIGNAL_CONFIRMED"
          : patience.status === "OPPOSITE_SIDE_INVALIDATION"
            ? "EXPIRED_WRONG_DIRECTION"
            : patience.status === "PATIENCE_CANDLE_EXPIRED"
              ? "EXPIRED_NO_IMMEDIATE_CONFIRMATION"
              : patience.status === "AMBIGUOUS_EVENT_ORDER"
                ? "INVALIDATED"
                : "CANDIDATE"
      );
      const observedImmediate = patience.triggerCandle?.isComplete
        ? patience.triggerCandle
        : patience.nextObservedCandle ?? null;
       const confirmedEntry = outcomeStatus === "SIGNAL_CONFIRMED"
        && patience.triggerCandle?.isComplete
        && patience.triggerCandle.openTime === expectedEntryCandleOpenTime
        ? patience.triggerCandle
        : null;
      const confirmationThreshold = patience.confirmationThreshold ?? effectiveConfirmationThreshold(
        patience.patienceCandle,
        patience.direction,
        patience.entryBufferTicks,
        0.25,
        record.finalizedNtzComplete
          && typeof record.finalizedNtzHigh === "number"
          && typeof record.finalizedNtzLow === "number"
          ? {
            high: record.finalizedNtzHigh,
            low: record.finalizedNtzLow,
            complete: true,
          }
          : null,
      );
      const effectiveEntryThreshold = record.consolidationGuard?.effectiveEntryThreshold
        ?? confirmationThreshold;
      const confirmationExcursion = patience.actualConfirmationExcursion ?? (
        observedImmediate
          ? patience.direction === "long"
            ? Math.max(0, observedImmediate.high - patience.patienceCandle.high)
            : Math.max(0, patience.patienceCandle.low - observedImmediate.low)
          : null
      );
      const pOpenTimestamp = Number.isFinite(patience.patienceCandle.openTime)
        ? new Date(patience.patienceCandle.openTime).toISOString()
        : null;
      const eOpenTimestamp = Number.isFinite(expectedEntryCandleOpenTime)
        ? new Date(expectedEntryCandleOpenTime).toISOString()
        : null;
      const entryObservationTimestamp = confirmedEntry && Number.isFinite(confirmedEntry.closeTime)
        ? new Date(confirmedEntry.closeTime).toISOString()
        : null;
      const identityInvariantViolations = outcomeStatus === "SIGNAL_CONFIRMED"
        ? canonicalPatienceIdentityViolations({
          tradingDate: record.tradingDate,
          contractSymbol: record.contractSymbol,
          patienceCandle: patience.patienceCandle,
          pOpenTimestamp,
          eOpenTimestamp,
          entryObservationTimestamp,
          confirmedEntry,
          expectedEntryCandleOpenTime,
        })
        : [];
      const linkedTrade = trade
        && confirmedEntry
        && trade.audit?.patienceCandleOpenTime === new Date(patience.patienceCandle.openTime).toISOString()
        && trade.audit?.triggerCandleOpenTime === new Date(confirmedEntry.openTime).toISOString()
        ? trade
        : undefined;
      const identity = [
        "patience",
        fingerprint,
        formulaHash,
        FIXED_FORMULA_VERSION,
        record.tradingDate,
        record.contractSymbol,
        patience.direction,
         pOpenTimestamp ?? "invalid",
         eOpenTimestamp ?? "invalid",
      ].join("|");
      const id = occurrenceId(identity);
      upsert(identity, {
        occurrenceId: id,
        auditId: record.id,
        kind: "patience",
         canonicalOccurrence: true,
        strategyCandidate: canonicalStrategyId(record.setupType) ?? record.setupType,
         primaryEdge: canonicalStrategyId(record.setupType) ?? record.setupType,
         matchedEdges: [canonicalStrategyId(record.setupType) ?? record.setupType, ...secondary],
        secondaryStrategyMatches: secondary,
        tradingDate: record.tradingDate,
        contractSymbol: record.contractSymbol,
        contractMonth: record.contractMonth,
        direction: patience.direction,
         directionSource: patience.directionSource,
         directionSources: patience.directionSource ? [patience.directionSource] : [],
        lTimestamp: linkedPullback?.candle ? new Date(linkedPullback.candle.openTime).toISOString() : linkedPullback ? new Date(linkedPullback.time).toISOString() : null,
        lEventId: linkedPullback ? pullbackEventId(linkedPullback) : patience.eligibilityEventId ?? null,
        lInteractionType: linkedPullback?.type ?? null,
        lCandle: occurrenceCandle(linkedPullback?.candle),
        previousComparisonTimestamp: new Date(patience.previousComparisonTimestamp ?? patience.previousCandle.openTime).toISOString(),
        patienceTimestamp: new Date(patience.patienceCandle.openTime).toISOString(),
        patienceCandle: occurrenceCandle(patience.patienceCandle),
        candidateShapeResult: patience.candidateShapeResult ?? true,
         expectedEntryTimestamp: eOpenTimestamp,
         confirmationThreshold: effectiveEntryThreshold,
        confirmationExcursion,
         entryTimestamp: confirmedEntry && Number.isFinite(confirmedEntry.openTime)
           ? new Date(confirmedEntry.openTime).toISOString()
           : null,
        entryCandle: occurrenceCandle(confirmedEntry ?? (outcomeStatus === "SIGNAL_CONFIRMED" ? observedImmediate : null)),
        levelIdentifiers: linkedEvidence.identifiers,
        levelValues: linkedEvidence.values,
        targetLevelInputs: record.targetLevelInputs,
         targetLevelSnapshot: targetLevelSnapshotForAudit(
           record,
           fingerprint,
           formulaHash,
           eOpenTimestamp,
           entryObservationTimestamp,
         ),
        levelDistancesTicks: linkedEvidence.distancesTicks,
        levelTolerancePoints: linkedEvidence.tolerancePoints,
        levelToleranceTicks: linkedEvidence.toleranceTicks,
        levelInteractionTypes: linkedEvidence.interactionTypes,
         pOpenTimestamp,
         eOpenTimestamp,
         entryObservationTimestamp,
         finalizedNtzHigh: record.finalizedNtzHigh ?? null,
         finalizedNtzLow: record.finalizedNtzLow ?? null,
         finalizedNtzComplete: record.finalizedNtzComplete ?? false,
          consolidationGuard: record.consolidationGuard,
         identityInvariantViolations,
        confirmationBufferTicks: record.confirmationBufferTicks ?? 8,
        nextObservedCandle: occurrenceCandle(confirmedEntry ? null : observedImmediate),
        consolidationThresholds: record.consolidationThresholds,
         causalEvidence: causalEvidenceForAudit(record),
         status: canonicalPatienceStatus(patience),
        reasonCode: patience.reasonCode,
        evaluationCursor: new Date(patience.evaluationCursor).toISOString(),
        formulaVersion: FIXED_FORMULA_VERSION,
        formulaHash,
        sourceFingerprint: fingerprint,
        canonicalTrade: linkedTrade !== undefined,
         eligibilityArmIds: patience.eligibilityArmId ? [patience.eligibilityArmId] : [],
         auditIds: [record.id],
         ...(patience.eligibilityArmTransitionTime !== undefined
           ? { eligibilityArmTransitionTime: new Date(patience.eligibilityArmTransitionTime).toISOString() }
           : {}),
         ...(linkedTrade ? {
           primaryEdge: linkedTrade.primaryEdge ?? linkedTrade.setupType,
           matchedEdges: linkedTrade.matchedEdges ?? [linkedTrade.setupType],
      supportingConfluences: [...new Set([
        ...(record.supportingConfluences ?? []),
        ...(linkedTrade?.supportingConfluences ?? []),
      ])],
      setupGrade: record.setupGrade ?? linkedTrade?.setupGrade ?? "A",
           entryPrice: linkedTrade.entryPrice,
           patienceEntryPrice: linkedTrade.audit?.entryTriggerPrice ?? null,
           confirmationEntryPrice: linkedTrade.entryPrice,
         } : {}),
          management: managementFromAudit(record, linkedTrade),
         ...(outcomeStatus !== "CANDIDATE"
            ? { signalStatus: outcomeStatus === "SIGNAL_CONFIRMED" ? "SIGNAL_CONFIRMED" as const : "ENTRY_CONFIRMATION_FAILED" as const }
           : {}),
         ...(patience.eligibilityArmId ? { eligibilityArmId: patience.eligibilityArmId } : {}),
         ...(patience.eligibilityArmState ? { eligibilityArmState: patience.eligibilityArmState } : {}),
         ...(patience.eligibilityArmStateReason ? { eligibilityArmStateReason: patience.eligibilityArmStateReason } : {}),
         ...(patience.eligibilityProvenance ? {
           eligibilityProvenance: {
             ...patience.eligibilityProvenance,
             time: new Date(patience.eligibilityProvenance.time).toISOString(),
           },
         } : {}),
      });
    }
    if ((record.patienceState === "ENTRY_TRIGGERED" || record.rejectionCategory === "RISK_REJECTION" || trade)
      && (trade !== undefined || (record.patienceOccurrences?.length ?? 0) === 0)) {
      const identity = [
        "decision",
        fingerprint,
        formulaHash,
        FIXED_FORMULA_VERSION,
        record.tradingDate,
        record.contractSymbol,
        record.direction ?? "absent",
        record.id,
        record.patienceCandleOpenTime ?? "absent",
        record.patienceCandleCloseTime ?? "absent",
        record.triggerCandleOpenTime ?? "absent",
        record.patienceState ?? "absent",
        record.rejectionCategory ?? "absent",
        trade?.id ?? "none",
      ].join("|");
       const decisionStatus: HistoricalOccurrence["status"] = trade
         ? (trade.outcome === "open" ? "TRADE_TAKEN" : "TRADE_OUTCOME")
         : record.patienceState === "ENTRY_TRIGGERED"
           ? "SIGNAL_CONFIRMED"
           : "PATIENCE_FOUND";
      upsert(identity, {
        occurrenceId: occurrenceId(identity),
        auditId: record.id,
         kind: trade ? "trade" : "patience",
        strategyCandidate: canonicalStrategyId(record.setupType) ?? record.setupType,
        secondaryStrategyMatches: secondary,
        tradingDate: record.tradingDate,
        contractSymbol: record.contractSymbol,
        contractMonth: record.contractMonth,
        direction: record.direction,
        lTimestamp: null,
        lEventId: null,
        lInteractionType: null,
        lCandle: null,
        previousComparisonTimestamp: null,
        patienceTimestamp: record.patienceCandleOpenTime,
        patienceCandle: record.patienceCandle,
        candidateShapeResult: record.patienceCandle !== null,
        expectedEntryTimestamp: record.patienceCandleCloseTime,
        confirmationThreshold: record.entryTriggerPrice,
        confirmationExcursion: null,
        entryTimestamp: record.triggerCandleOpenTime,
        entryCandle: record.triggerCandle,
        levelIdentifiers: [],
        levelValues: {},
        targetLevelInputs: record.targetLevelInputs,
        levelDistancesTicks: {},
        levelTolerancePoints: {},
        levelToleranceTicks: {},
        levelInteractionTypes: {},
         pOpenTimestamp: record.patienceCandleOpenTime,
         eOpenTimestamp: record.triggerCandleOpenTime ?? record.patienceCandleCloseTime,
         entryObservationTimestamp: record.triggerCandleCloseTime,
         consolidationGuard: record.consolidationGuard,
         identityInvariantViolations: [],
        confirmationBufferTicks: record.confirmationBufferTicks ?? 8,
        nextObservedCandle: null,
        consolidationThresholds: record.consolidationThresholds,
         causalEvidence: causalEvidenceForAudit(record),
        status: decisionStatus,
        reasonCode: record.rejectionSummary ?? record.decision,
        evaluationCursor: cursor,
        formulaVersion: FIXED_FORMULA_VERSION,
        formulaHash,
        sourceFingerprint: fingerprint,
        canonicalTrade: trade !== undefined,
         ...(trade ? {
           primaryEdge: trade.primaryEdge ?? trade.setupType,
           matchedEdges: trade.matchedEdges ?? [trade.setupType],
           supportingConfluences: trade.supportingConfluences ?? [],
           setupGrade: trade.setupGrade ?? "A",
           entryPrice: trade.entryPrice,
           patienceEntryPrice: trade.audit?.entryTriggerPrice ?? null,
           confirmationEntryPrice: trade.entryPrice,
         } : {}),
      });
    }
  }
  const stageRank: Record<HistoricalOccurrence["kind"], number> = { pullback: 0, patience: 1, risk: 2, trade: 3 };
  return [...byIdentity.values()].sort((first, second) => {
    const firstTime = first.lTimestamp ?? first.patienceTimestamp ?? first.entryTimestamp ?? first.evaluationCursor;
    const secondTime = second.lTimestamp ?? second.patienceTimestamp ?? second.entryTimestamp ?? second.evaluationCursor;
    return `${first.tradingDate}|${firstTime}|${first.patienceTimestamp ?? "absent"}|${stageRank[first.kind]}|${first.occurrenceId}`
      .localeCompare(`${second.tradingDate}|${secondTime}|${second.patienceTimestamp ?? "absent"}|${stageRank[second.kind]}|${second.occurrenceId}`);
  });
}

function candidateWindowEligible(occurrence: HistoricalOccurrence): boolean {
  if (!occurrence.eOpenTimestamp || !occurrence.direction) return false;
  const entryOpenTimestamp = Date.parse(occurrence.eOpenTimestamp);
  if (!Number.isFinite(entryOpenTimestamp)) return false;
  const config = activeShadowStrategySnapshot().config;
  const root = occurrence.contractSymbol.replace(/[FGHJKMNQUVXZ]\d$/, "");
  const calendar = sessionCalendarForContract(getFuturesContractSpecification(root || occurrence.contractSymbol));
  return tradingDateForTimestamp(entryOpenTimestamp, calendar) === occurrence.tradingDate
    && wallClockMinutesForTimestamp(entryOpenTimestamp, config.sessionTimeZone) >= config.primaryEntryStartMinutes
    && wallClockMinutesForTimestamp(entryOpenTimestamp, config.sessionTimeZone) < config.primaryEntryEndMinutes;
}

function causalOrbNtzRange(occurrence: HistoricalOccurrence): { high: number; low: number; complete: true } | null {
  if (
    occurrence.finalizedNtzComplete === true
    && typeof occurrence.finalizedNtzHigh === "number"
    && typeof occurrence.finalizedNtzLow === "number"
  ) {
    return {
      high: Math.max(occurrence.finalizedNtzHigh, occurrence.finalizedNtzLow),
      low: Math.min(occurrence.finalizedNtzHigh, occurrence.finalizedNtzLow),
      complete: true,
    };
  }
  const levels = occurrence.targetLevelSnapshot?.frozenLevelInputs ?? occurrence.targetLevelInputs ?? [];
  const orbNtzLevels = levels.filter((level) => {
    const label = `${level.id} ${level.type}`.trim().toLowerCase();
    return /\b(?:orb|ntz)\b/.test(label);
  });
  const highs = orbNtzLevels
    .filter((level) => /\bhigh\b/.test(`${level.id} ${level.type}`.toLowerCase()))
    .map((level) => level.price)
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price));
  const lows = orbNtzLevels
    .filter((level) => /\blow\b/.test(`${level.id} ${level.type}`.toLowerCase()))
    .map((level) => level.price)
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price));
  if (!highs.length || !lows.length) return null;
  return { high: Math.max(...highs), low: Math.min(...lows), complete: true };
}

function candidateNtzEligibility(occurrence: HistoricalOccurrence): { eligible: boolean; reason?: string } {
  const threshold = occurrence.confirmationThreshold;
  const zone = causalOrbNtzRange(occurrence);
  if (!zone) return { eligible: true };
  const patienceCandle = occurrence.patienceCandle
    ? {
      high: Number(occurrence.patienceCandle.high),
      low: Number(occurrence.patienceCandle.low),
    }
    : null;
  if (
    occurrence.direction
    && patienceCandle
    && Number.isFinite(patienceCandle.high)
    && Number.isFinite(patienceCandle.low)
    && !isPatienceCandleOutsideNtz(patienceCandle, occurrence.direction, zone, true)
  ) {
    return {
      eligible: false,
      reason: `REJECTED_PATIENCE_INSIDE_NTZ_ORB: patience candle ${patienceCandle.low}-${patienceCandle.high} overlaps causal ORB/NTZ ${zone.low}-${zone.high}.`,
    };
  }
  if (threshold !== null && threshold >= zone.low && threshold <= zone.high) {
    return {
      eligible: false,
      reason: `REJECTED_INSIDE_NTZ: confirmation threshold ${threshold} is inside finalized NTZ ${zone.low}-${zone.high}.`,
    };
  }
  return { eligible: true };
}

function candidatePrimaryLevelRejection(occurrence: HistoricalOccurrence): { reasonCodes: string[]; details: string[] } | null {
  if (canonicalStrategyId(occurrence.strategyCandidate) !== "ORB_PULLBACK_CONTINUATION") return null;
  const hasExecutablePrimaryLevel = occurrence.levelIdentifiers.some((level) =>
    !level.trim().toLowerCase().startsWith("fib")
    && (occurrence.levelInteractionTypes[level]?.length ?? 0) > 0,
  );
  if (hasExecutablePrimaryLevel) return null;
  return {
    reasonCodes: ["REJECTED_MISSING_PRIMARY_LEVEL_INTERACTION"],
    details: [
      `Confirmed ORB signal ${occurrence.occurrenceId} has no causal interaction with an executable primary level.`,
      "Fibonacci references are diagnostic-only and cannot authorize an ORB pullback continuation.",
    ],
  };
}

function candidateConsolidationRejection(
  occurrence: HistoricalOccurrence,
): { reasonCodes: string[]; details: string[] } | null {
  const primaryEdge = canonicalStrategyId(occurrence.primaryEdge ?? occurrence.strategyCandidate);
  if (primaryEdge !== "CONSOLIDATION_BREAKOUT_CONTINUATION") return null;
  const guard = occurrence.consolidationGuard;
  if (!guard || (!guard.activeZone && !guard.breakoutPullback)) return null;
  const thresholdReached = guard.effectiveEntryThresholdReached ?? guard.entryReachedConfirmation;
  const closedOutside = guard.entryClosedOutsideZone ?? guard.entryCloseOutsideZone;
  const fillOutside = guard.entryFillOutsideZone;
  const contradictoryEvidence = thresholdReached === false
    || closedOutside === false
    || fillOutside === false
    || guard.entryOutsideFinalizedNtz === false
    || guard.entryBeforeCutoff === false;
  if (consolidationGuardIsExecutionEligible(guard) && !contradictoryEvidence) return null;
  const lifecycleCodes = guard.lifecycleStates.filter((state) =>
    state !== "CONSOLIDATION_ZONE_FROZEN" && state !== "PATIENCE_INSIDE_CONSOLIDATION",
  );
  return {
    reasonCodes: [
      "REJECTED_CONSOLIDATION_ENTRY_GUARD",
      ...(guard.rejectionReason ? [guard.rejectionReason] : []),
      ...lifecycleCodes,
    ].filter((reason, index, all) => all.indexOf(reason) === index),
    details: [
      `Confirmed signal ${occurrence.occurrenceId} was rejected by the deterministic consolidation-entry guard.`,
      guard.detail,
      ...(guard.rejectionReason ? [`Consolidation guard reason: ${guard.rejectionReason}.`] : []),
      ...(guard.activeConsolidationZoneId
        ? [`Active frozen consolidation zone: ${guard.activeConsolidationZoneId}.`]
        : []),
      ...(guard.consolidationZoneLow !== null && guard.consolidationZoneHigh !== null
        ? [`Frozen consolidation zone: ${guard.consolidationZoneLow}-${guard.consolidationZoneHigh}.`] : []),
      ...(guard.effectiveEntryThreshold !== undefined
        ? [`Effective entry threshold: ${guard.effectiveEntryThreshold ?? "unavailable"}.`]
        : []),
    ],
  };
}

function historicalCandidateId(occurrence: HistoricalOccurrence): string {
  return occurrenceId([
    "historical-trade-candidate-v2",
    occurrence.sourceFingerprint,
    occurrence.formulaHash,
    historicalArmAttemptId(occurrence),
    occurrence.occurrenceId,
  ].join("|"));
}

function effectiveEntryThresholdForOccurrence(occurrence: HistoricalOccurrence): number | null {
  const guardedThreshold = occurrence.consolidationGuard?.effectiveEntryThreshold;
  return typeof guardedThreshold === "number" && Number.isFinite(guardedThreshold)
    ? guardedThreshold
    : occurrence.confirmationThreshold ?? occurrence.confirmationEntryPrice ?? null;
}

function consolidationGuardIsExecutionEligible(
  guard: BacktestConsolidationGuardEvidence,
): boolean {
  const thresholdReached = guard.effectiveEntryThresholdReached ?? guard.entryReachedConfirmation;
  const closedOutside = guard.entryClosedOutsideZone ?? guard.entryCloseOutsideZone;
  return guard.executionEligible
    && thresholdReached !== false
    && closedOutside !== false
    && guard.entryFillOutsideZone !== false
    && guard.entryOutsideFinalizedNtz !== false
    && guard.entryBeforeCutoff !== false;
}

function fillIsStrictlyOutsideConsolidation(
  guard: BacktestConsolidationGuardEvidence | null | undefined,
  direction: Direction,
  fillPrice: number | null,
): boolean {
  if (!guard || guard.consolidationZoneHigh === null || guard.consolidationZoneLow === null) return true;
  if (fillPrice === null || !Number.isFinite(fillPrice)) return false;
  return direction === "long"
    ? fillPrice > guard.consolidationZoneHigh
    : fillPrice < guard.consolidationZoneLow;
}

function candidateEntryDisposition(occurrence: HistoricalOccurrence): CandidateEntryDisposition {
  const patienceHigh = numericCandleValue(occurrence.patienceCandle, "high");
  const patienceLow = numericCandleValue(occurrence.patienceCandle, "low");
  const entryHigh = numericCandleValue(occurrence.entryCandle, "high");
  const entryLow = numericCandleValue(occurrence.entryCandle, "low");
  const threshold = effectiveEntryThresholdForOccurrence(occurrence);
  if (
    patienceHigh === null
    || patienceLow === null
    || entryHigh === null
    || entryLow === null
    || threshold === null
  ) {
    return { status: "INSUFFICIENT_CANDLE_DATA", reached: null };
  }
  const reached = occurrence.direction === "long"
    ? entryHigh >= threshold
    : occurrence.direction === "short"
      ? entryLow <= threshold
      : false;
  return {
    status: reached ? "MODELED_TRADE_CREATED" : "ENTRY_NOT_REACHED",
    reached,
  };
}

function strategyStopPriceForOccurrence(occurrence: HistoricalOccurrence): number | null {
  const patienceLow = numericCandleValue(occurrence.patienceCandle, "low");
  const patienceHigh = numericCandleValue(occurrence.patienceCandle, "high");
  if (occurrence.direction === "long" && patienceLow !== null) {
    return authoritativePatienceStopPrice("long", patienceLow, 12, 0.25);
  }
  if (occurrence.direction === "short" && patienceHigh !== null) {
    return authoritativePatienceStopPrice("short", patienceHigh, 12, 0.25);
  }
  return null;
}

function targetPlanForOccurrence(
  occurrence: HistoricalOccurrence,
  entryPrice: number | null,
): KeyLevelTargetPlan | null {
  if (entryPrice === null || !occurrence.direction) return null;
  const snapshot = occurrence.targetLevelSnapshot ?? targetLevelSnapshotForOccurrence(occurrence, [
    ...(occurrence.targetLevelInputs ?? []),
    ...(typeof occurrence.finalizedNtzHigh === "number"
      ? [{
        id: "ntz",
        type: "NTZ",
        rangeLow: occurrence.finalizedNtzLow ?? occurrence.finalizedNtzHigh,
        rangeHigh: occurrence.finalizedNtzHigh,
      }]
      : []),
  ]);
  const plan = buildKeyLevelTargetPlan({
    direction: occurrence.direction,
    entryPrice,
    levels: snapshot.frozenLevelInputs,
    placementMode: "NEAR_SIDE_8_TICKS",
  });
  return {
    ...plan,
    targetLevelSnapshot: snapshot,
  };
}

function primaryLossExitReferenceForOccurrence(
  occurrence: HistoricalOccurrence,
  entryPrice: number | null,
): PrimaryLossExitReference | null {
  const patienceLow = numericCandleValue(occurrence.patienceCandle, "low");
  const patienceHigh = numericCandleValue(occurrence.patienceCandle, "high");
  const levels = occurrence.targetLevelSnapshot?.frozenLevelInputs
    ?? occurrence.targetLevelInputs
    ?? [];
  if (
    entryPrice === null
    || occurrence.direction === null
    || patienceLow === null
    || patienceHigh === null
  ) return null;
  return primaryLossExitReferenceForPatience({
    direction: occurrence.direction,
    entryPrice,
    patienceLow,
    patienceHigh,
    levels,
  });
}

function freezeCandidateManagementContext(
  occurrence: HistoricalOccurrence,
  candidateId: string,
  linkedTrade: BacktestTrade | undefined,
): CandidateManagementContext {
  const management = occurrence.management;
  const entryPrice = effectiveEntryThresholdForOccurrence(occurrence);
  const targetPlan = targetPlanForOccurrence(occurrence, entryPrice);
  const contracts = management?.contracts ?? linkedTrade?.contracts ?? null;
  const patienceLow = numericCandleValue(occurrence.patienceCandle, "low");
  const patienceHigh = numericCandleValue(occurrence.patienceCandle, "high");
  const strategyStopPrice = strategyStopPriceForOccurrence(occurrence);
  const primaryLossExitLevel = primaryLossExitReferenceForOccurrence(occurrence, entryPrice);
  const catastropheStopPrice = management?.catastropheStopPrice ?? linkedTrade?.audit?.catastropheStopPrice ?? null;
  const targetPrice = targetPlan?.targetPrice ?? null;
  const hasTarget = targetPlan?.disposition === "KEY_LEVEL_SELECTED" && targetPrice !== null;
  const missingEvidenceReasons = [
    ...(entryPrice === null ? ["entryPrice"] : []),
    ...(contracts === null ? ["contracts"] : []),
    ...(strategyStopPrice === null ? ["strategyStopPrice"] : []),
    ...(management?.sessionCloseTime == null ? ["sessionCloseTime"] : []),
  ];
  const context: CandidateManagementContext = {
    candidateId,
    causalIdentity: candidateCausalIdentityForOccurrence(occurrence),
    signalOccurrenceId: occurrence.occurrenceId,
    patienceCandleOpenTime: occurrence.patienceTimestamp ?? null,
    patienceCandleHigh: patienceHigh,
    patienceCandleLow: patienceLow,
    stopBufferTicks: 12,
    tickSize: 0.25,
    derivedStrategyStop: strategyStopPrice,
    targetPlan: targetPlan ?? undefined,
    frozenAt: occurrence.evaluationCursor,
    direction: occurrence.direction!,
    contracts: contracts ?? 0,
    entryPrice: entryPrice ?? 0,
    strategyStopPrice,
    primaryLossExitLevel,
    catastropheStopPrice,
    targetPrice,
    runnerActivationPrice: hasTarget && management?.runnerExitRule ? targetPrice : null,
    runnerExitRule: hasTarget ? management?.runnerExitRule ?? null : null,
    sessionCloseTime: management?.sessionCloseTime ?? null,
    sourceAuditId: management?.sourceAuditId ?? occurrence.auditId,
    managementEvidenceStatus: "complete",
    missingEvidenceReasons: [],
  };
  const validationReasons = candidateManagementValidationReasons(context, occurrence.entryObservationTimestamp);
  const allReasons = [...new Set([...missingEvidenceReasons, ...validationReasons])];
  const invalidReasons = validationReasons.filter((reason) => !missingEvidenceReasons.includes(reason));
  const managementEvidenceStatus = invalidReasons.length > 0
    ? "invalid"
    : allReasons.length > 0
      ? "missing"
      : "complete";
  return {
    ...context,
    managementEvidenceStatus,
    missingEvidenceReasons: managementEvidenceStatus === "invalid"
      ? ["INVALID_MANAGEMENT_GEOMETRY", ...allReasons]
      : allReasons,
  };
}

type CandidateProjectionRecord = {
  occurrence: HistoricalOccurrence;
  occurrenceForExecution: HistoricalOccurrence;
  candidate: HistoricalTradeCandidate;
};

type ArmAttemptRuntime = {
  attemptCount: number;
  firstCandidateId: string;
  firstTradeId: string | null;
  firstExitTimestamp: string | null;
  firstExitReason: string | null;
  contractSymbol: string;
  tradingDate: string;
  direction: "long" | "short" | null;
  primaryEdge: string;
  qualifyingLevelRelationship: string;
  firstConfluenceScore: number;
  reentryEligible: boolean;
  reentryEligibilityReason: string;
};

function isLossStopOutcome(outcome: BacktestTrade["outcome"] | undefined): boolean {
  return outcome === "strategy stop" || outcome === "catastrophe stop";
}

function annotateCandidateAttempt(
  candidate: HistoricalTradeCandidate,
  attemptId: string,
  attemptOrdinal: number,
  attemptState: CandidateAttemptState,
  runtime: ArmAttemptRuntime,
  armRetirementReason: string | null = null,
  secondCandidateId?: string,
  secondTradeId?: string,
): HistoricalTradeCandidate {
  const causalIdentity = candidate.causalIdentity;
  return {
    ...candidate,
    causalIdentity,
    armAttemptId: attemptId,
    attemptOrdinal,
    entryAttemptCount: runtime.attemptCount,
    attemptGrade: attemptGradeForCandidate(candidate, attemptOrdinal, runtime),
    attemptState,
    firstCandidateId: runtime.firstCandidateId,
    firstTradeId: runtime.firstTradeId ?? undefined,
    secondCandidateId,
    secondTradeId,
    firstExitTimestamp: runtime.firstExitTimestamp,
    firstExitReason: runtime.firstExitReason,
    reentryEligible: runtime.reentryEligible,
    reentryEligibilityReason: runtime.reentryEligibilityReason,
    armRetirementReason,
    managementContext: candidate.managementContext
      ? {
        ...candidate.managementContext,
        causalIdentity,
        armAttemptId: attemptId,
        attemptOrdinal,
      }
      : candidate.managementContext,
  };
}

export function projectHistoricalTradeCandidates(
  occurrences: readonly HistoricalOccurrence[],
  rawTrades: readonly BacktestTrade[],
  executionContext?: {
    dataset: CausalReplayDataset;
    specification: ReturnType<typeof getFuturesContractSpecification>;
    executionMode: BacktestRequest["executionMode"];
    lifecycle?: HistoricalPullbackLifecycle;
  },
): {
  candidates: HistoricalTradeCandidate[];
  rejected: RejectedCandidateSignal[];
  authoritativeTrades: BacktestTrade[];
  orphans: OrphanModeledTrade[];
} {
  const confirmed = occurrences.filter((occurrence) =>
    occurrence.kind === "patience"
    && occurrence.canonicalOccurrence === true
    && occurrence.status === "SIGNAL_CONFIRMED",
  );
  const candidates: HistoricalTradeCandidate[] = [];
  const rejected: RejectedCandidateSignal[] = [];
  const signalByPhysicalIdentity = new Map<string, HistoricalOccurrence>();
  for (const occurrence of confirmed) {
    const lifecycleRejection = candidateLifecycleRejection(occurrence, executionContext?.lifecycle);
    if (lifecycleRejection) {
      rejected.push({
        signalOccurrenceId: occurrence.occurrenceId,
        reasonCodes: lifecycleRejection.reasonCodes,
        details: lifecycleRejection.details,
      });
      continue;
    }
    const consolidationRejection = candidateConsolidationRejection(occurrence);
    if (consolidationRejection) {
      rejected.push({
        signalOccurrenceId: occurrence.occurrenceId,
        reasonCodes: consolidationRejection.reasonCodes,
        details: consolidationRejection.details,
      });
      continue;
    }
    const primaryLevelRejection = candidatePrimaryLevelRejection(occurrence);
    if (primaryLevelRejection) {
      rejected.push({
        signalOccurrenceId: occurrence.occurrenceId,
        reasonCodes: primaryLevelRejection.reasonCodes,
        details: primaryLevelRejection.details,
      });
      continue;
    }
    const identityViolations = candidateIdentityViolations(occurrence);
    if (identityViolations.length > 0) {
      rejected.push({
        signalOccurrenceId: occurrence.occurrenceId,
        reasonCodes: ["INVALID_CAUSAL_IDENTITY"],
        details: identityViolations,
      });
      continue;
    }
    const ntz = candidateNtzEligibility(occurrence);
    const inWindow = candidateWindowEligible(occurrence);
    const identityValid = !(occurrence.identityInvariantViolations?.length);
    if (!ntz.eligible || !inWindow || !identityValid) {
      const patienceInsideZone = ntz.reason?.startsWith("REJECTED_PATIENCE_INSIDE_NTZ_ORB") === true;
      rejected.push({
        signalOccurrenceId: occurrence.occurrenceId,
        reasonCodes: [
          ...(patienceInsideZone
            ? ["REJECTED_PATIENCE_INSIDE_NTZ_ORB"]
            : !ntz.eligible
              ? ["REJECTED_INSIDE_NTZ"]
              : []),
          ...(!inWindow ? ["REJECTED_OUTSIDE_ENTRY_WINDOW"] : []),
          ...(!identityValid ? ["INVALID_CAUSAL_IDENTITY"] : []),
        ],
        details: [
          ...(ntz.reason ? [ntz.reason] : []),
          ...(!inWindow ? ["Entry confirmation is observed outside the exclusive 9:30 a.m.–1:00 p.m. America/New_York entry window."] : []),
          ...(!identityValid ? occurrence.identityInvariantViolations : []),
        ],
      });
      continue;
    }
    const physicalIdentity = [
      occurrence.sourceFingerprint,
      occurrence.formulaHash,
      occurrence.contractSymbol,
      occurrence.tradingDate,
      occurrence.direction,
      occurrence.pOpenTimestamp,
      occurrence.eOpenTimestamp,
    ].join("|");
    const existing = signalByPhysicalIdentity.get(physicalIdentity);
    if (!existing) {
      signalByPhysicalIdentity.set(physicalIdentity, occurrence);
      continue;
    }
    const selectedTargetSnapshot = preferredTargetLevelSnapshot(
      [existing.targetLevelSnapshot, occurrence.targetLevelSnapshot],
      existing,
    );
    signalByPhysicalIdentity.set(physicalIdentity, {
      ...existing,
      ...(selectedTargetSnapshot ? {
        targetLevelSnapshot: selectedTargetSnapshot,
        targetLevelInputs: [...selectedTargetSnapshot.frozenLevelInputs],
      } : {}),
      levelIdentifiers: [...new Set([...existing.levelIdentifiers, ...occurrence.levelIdentifiers])],
      levelValues: { ...occurrence.levelValues, ...existing.levelValues },
      levelDistancesTicks: { ...occurrence.levelDistancesTicks, ...existing.levelDistancesTicks },
      levelTolerancePoints: { ...occurrence.levelTolerancePoints, ...existing.levelTolerancePoints },
      levelToleranceTicks: { ...occurrence.levelToleranceTicks, ...existing.levelToleranceTicks },
      levelInteractionTypes: Object.fromEntries(
        [...new Set([...Object.keys(existing.levelInteractionTypes), ...Object.keys(occurrence.levelInteractionTypes)])]
          .map((level) => [
            level,
            [...new Set([
              ...(existing.levelInteractionTypes[level] ?? []),
              ...(occurrence.levelInteractionTypes[level] ?? []),
            ])],
          ]),
      ),
      matchedEdges: [...new Set([...(existing.matchedEdges ?? []), ...(occurrence.matchedEdges ?? [])])],
      supportingConfluences: [...new Set([
        ...(existing.supportingConfluences ?? []),
        ...(occurrence.supportingConfluences ?? []),
      ])],
      directionSources: [...new Set([...(existing.directionSources ?? []), ...(occurrence.directionSources ?? [])])],
      auditIds: [...new Set([...(existing.auditIds ?? []), ...(occurrence.auditIds ?? []), existing.auditId, occurrence.auditId])],
    });
  }
  const candidateRecords: CandidateProjectionRecord[] = [];
  for (const occurrence of signalByPhysicalIdentity.values()) {
    const candidateId = historicalCandidateId(occurrence);
    const datasetEntryCandle = executionContext?.dataset.candles.find((candle) =>
      candle.contractSymbol === occurrence.contractSymbol
      && candle.openTime === Date.parse(occurrence.eOpenTimestamp!));
    const occurrenceForExecution = occurrence.entryCandle || !datasetEntryCandle
      ? occurrence
      : { ...occurrence, entryCandle: occurrenceCandle(datasetEntryCandle) };
    const linked = rawTrades.filter((trade) =>
      trade.contractSymbol === occurrence.contractSymbol
      && trade.tradingDate === occurrence.tradingDate
      && trade.direction === occurrence.direction
      && trade.audit?.patienceCandleOpenTime === occurrence.patienceTimestamp
      && trade.audit?.triggerCandleOpenTime === occurrence.eOpenTimestamp,
    );
    const firstTrade = linked[0];
    const entryDisposition = candidateEntryDisposition(occurrenceForExecution);
    const managementContext = freezeCandidateManagementContext(occurrenceForExecution, candidateId, firstTrade);
    candidateRecords.push({
      occurrence,
      occurrenceForExecution,
      candidate: {
      candidateId,
      causalIdentity: candidateCausalIdentityForOccurrence(occurrence),
      signalOccurrenceId: occurrence.occurrenceId,
      sourceFingerprint: occurrence.sourceFingerprint,
      formulaHash: occurrence.formulaHash,
      formulaVersion: occurrence.formulaVersion,
      contractSymbol: occurrence.contractSymbol,
      tradingDate: occurrence.tradingDate,
      direction: occurrence.direction!,
      primaryEdge: occurrence.primaryEdge ?? occurrence.strategyCandidate,
      matchedEdges: [...new Set(occurrence.matchedEdges ?? [occurrence.strategyCandidate])].sort(),
      supportingConfluences: [...new Set(occurrence.supportingConfluences ?? [])].sort(),
      qualifyingLevelIdentifiers: [...occurrence.levelIdentifiers].sort(),
      qualifyingLevelValues: { ...occurrence.levelValues },
      pOpenTimestamp: occurrence.pOpenTimestamp!,
      eOpenTimestamp: occurrence.eOpenTimestamp!,
      entryObservationTimestamp: occurrence.entryObservationTimestamp!,
      patienceTimestamp: occurrence.patienceTimestamp!,
      expectedEntryTimestamp: occurrence.expectedEntryTimestamp!,
      confirmationPrice: effectiveEntryThresholdForOccurrence(occurrence),
      confirmationBufferTicks: occurrence.confirmationBufferTicks ?? 0,
      grade: occurrence.setupGrade ?? "A",
      eligible: true,
      fillModelType: "OHLCV_CONFIRMATION_THRESHOLD",
      patienceHigh: numericCandleValue(occurrence.patienceCandle, "high"),
      patienceLow: numericCandleValue(occurrence.patienceCandle, "low"),
      entryHigh: numericCandleValue(occurrenceForExecution.entryCandle, "high"),
      entryLow: numericCandleValue(occurrenceForExecution.entryCandle, "low"),
      entryReachedThreshold: entryDisposition.reached,
      executionStatus: entryDisposition.status,
      strategyStopPrice: strategyStopPriceForOccurrence(occurrenceForExecution),
      targetPlan: managementContext.targetPlan,
      targetDisposition: managementContext.targetPlan?.disposition ?? "NO_ELIGIBLE_KEY_LEVEL",
      managementContext,
      },
    });
  }
  const orderedCandidateRecords = [...candidateRecords].sort((left, right) =>
    Date.parse(left.occurrence.entryObservationTimestamp ?? left.occurrence.eOpenTimestamp ?? "")
    - Date.parse(right.occurrence.entryObservationTimestamp ?? right.occurrence.eOpenTimestamp ?? "")
    || left.occurrence.occurrenceId.localeCompare(right.occurrence.occurrenceId),
  );
  const attemptByArm = new Map<string, ArmAttemptRuntime>();
  const authoritativeTrades: BacktestTrade[] = [];
  const orphans: OrphanModeledTrade[] = [];
  for (const record of orderedCandidateRecords) {
    const { occurrence, occurrenceForExecution, candidate } = record;
    const armId = occurrence.eligibilityArmId;
    const attemptId = historicalArmAttemptId(occurrence);
    const canSimulate = Boolean(
      executionContext
      && candidate.executionStatus === "MODELED_TRADE_CREATED",
    );
    const runtime = armId ? attemptByArm.get(armId) : undefined;
    if (!canSimulate || !executionContext || !armId || !isValidCandidateManagementContext(candidate)) {
      candidates.push(candidate);
      if (canSimulate && executionContext) {
        const candidateTrade = candidateDrivenEntryTrade(
          occurrenceForExecution,
          candidate.candidateId,
          candidate,
          executionContext,
        );
        if (candidateTrade) authoritativeTrades.push(candidateTrade);
      }
      continue;
    }

    if (runtime && !runtime.reentryEligible) {
      rejected.push({
        signalOccurrenceId: occurrence.occurrenceId,
        armAttemptId: attemptId,
        attemptOrdinal: runtime.attemptCount + 1,
        eligibilityArmId: armId,
        reasonCodes: [
          runtime.attemptCount >= 2
            ? "REJECTED_PULLBACK_ARM_ATTEMPT_LIMIT"
            : "REJECTED_PULLBACK_ARM_REENTRY_INELIGIBLE",
        ],
        details: [
          runtime.attemptCount >= 2
            ? `Causal arm ${armId} already used its maximum of two authoritative entries.`
            : runtime.reentryEligibilityReason,
        ],
      });
      continue;
    }

    const attemptOrdinal = runtime ? 2 : 1;
    if (runtime) {
      const contextChanged = occurrence.contractSymbol !== runtime.contractSymbol
        || occurrence.tradingDate !== runtime.tradingDate
        || occurrence.direction !== runtime.direction
        || (occurrence.primaryEdge ?? occurrence.strategyCandidate) !== runtime.primaryEdge
        || qualifyingLevelRelationshipFingerprint(occurrence) !== runtime.qualifyingLevelRelationship;
      if (contextChanged) {
        rejected.push({
          signalOccurrenceId: occurrence.occurrenceId,
          armAttemptId: attemptId,
          attemptOrdinal,
          eligibilityArmId: armId,
          reasonCodes: ["REJECTED_PULLBACK_ARM_CONTEXT_CHANGED"],
          details: [
            `Causal arm ${armId} cannot re-enter after its contract, date, direction, breakout structure, or qualifying level relationship changed.`,
          ],
        });
        continue;
      }
      const currentObservation = Date.parse(
        occurrence.entryObservationTimestamp ?? occurrence.eOpenTimestamp ?? "",
      );
      const firstExit = runtime.firstExitTimestamp ? Date.parse(runtime.firstExitTimestamp) : Number.NaN;
      if (!Number.isFinite(firstExit) || !Number.isFinite(currentObservation) || currentObservation <= firstExit) {
        rejected.push({
          signalOccurrenceId: occurrence.occurrenceId,
          armAttemptId: attemptId,
          attemptOrdinal,
          eligibilityArmId: armId,
          reasonCodes: ["REJECTED_PULLBACK_ARM_FIRST_TRADE_ACTIVE"],
          details: [
            `Causal arm ${armId} cannot re-enter before the first stop has completed; first exit is ${runtime.firstExitTimestamp ?? "unavailable"}.`,
          ],
        });
        continue;
      }
    }

    const tentative = annotateCandidateAttempt(
      candidate,
      attemptId,
      attemptOrdinal,
      attemptOrdinal === 1 ? "FIRST_ENTRY_CONFIRMED" : "SECOND_ENTRY_CONFIRMED",
      runtime ?? {
        attemptCount: 0,
        firstCandidateId: candidate.candidateId,
        firstTradeId: null,
        firstExitTimestamp: null,
        firstExitReason: null,
        contractSymbol: occurrence.contractSymbol,
        tradingDate: occurrence.tradingDate,
        direction: occurrence.direction,
        primaryEdge: occurrence.primaryEdge ?? occurrence.strategyCandidate,
        qualifyingLevelRelationship: qualifyingLevelRelationshipFingerprint(occurrence),
        firstConfluenceScore: confluenceScoreForCandidate(candidate),
        reentryEligible: false,
        reentryEligibilityReason: "The first managed attempt has not yet been evaluated.",
      },
    );
    const candidateTrade = candidateDrivenEntryTrade(
      occurrenceForExecution,
      candidate.candidateId,
      tentative,
      executionContext,
    );
    if (!candidateTrade) {
      candidates.push(candidate);
      continue;
    }

    if (!runtime) {
      const stopped = isLossStopOutcome(candidateTrade.outcome);
      const nextRuntime: ArmAttemptRuntime = {
        attemptCount: 1,
        firstCandidateId: candidate.candidateId,
        firstTradeId: candidateTrade.id,
        firstExitTimestamp: candidateTrade.exitTime,
        firstExitReason: candidateTrade.outcome,
        contractSymbol: occurrence.contractSymbol,
        tradingDate: occurrence.tradingDate,
        direction: occurrence.direction,
        primaryEdge: occurrence.primaryEdge ?? occurrence.strategyCandidate,
        qualifyingLevelRelationship: qualifyingLevelRelationshipFingerprint(occurrence),
        firstConfluenceScore: confluenceScoreForCandidate(candidate),
        reentryEligible: stopped,
        reentryEligibilityReason: stopped
          ? "The first authoritative attempt stopped while the breakout/pullback arm remains structurally valid; a new P→E may authorize one re-entry."
          : `The first authoritative attempt ended as ${candidateTrade.outcome}; a second entry requires a new stop-out.`,
      };
      const finalCandidate = annotateCandidateAttempt(
        candidate,
        attemptId,
        1,
        stopped ? "REENTRY_ELIGIBLE" : candidateTrade.outcome === "open" ? "FIRST_TRADE_ACTIVE" : "ARM_RETIRED_AFTER_ATTEMPT_LIMIT",
        nextRuntime,
        stopped ? null : `The arm is not re-entry eligible after the first ${candidateTrade.outcome} attempt.`,
      );
      candidates.push(finalCandidate);
      authoritativeTrades.push({
        ...candidateTrade,
        armAttemptId: attemptId,
        attemptOrdinal: 1,
        attemptGrade: finalCandidate.attemptGrade,
        causalIdentity: finalCandidate.causalIdentity,
        audit: candidateTrade.audit
          ? {
            ...candidateTrade.audit,
            armAttemptId: attemptId,
            attemptOrdinal: 1,
            attemptGrade: finalCandidate.attemptGrade,
            causalIdentity: finalCandidate.causalIdentity,
          }
          : candidateTrade.audit,
      });
      attemptByArm.set(armId, nextRuntime);
      continue;
    }

    const secondStopped = isLossStopOutcome(candidateTrade.outcome);
    const secondRuntime: ArmAttemptRuntime = {
      ...runtime,
      attemptCount: 2,
      reentryEligible: false,
      reentryEligibilityReason: secondStopped
        ? "Two authoritative attempts from this arm have stopped; the arm is retired."
        : `The second authoritative attempt ended as ${candidateTrade.outcome}; the two-entry arm limit is reached.`,
    };
    const finalCandidate = annotateCandidateAttempt(
      candidate,
      attemptId,
      2,
      secondStopped
        ? "ARM_RETIRED_AFTER_TWO_LOSSES"
        : candidateTrade.outcome === "open" ? "SECOND_TRADE_ACTIVE" : "ARM_RETIRED_AFTER_ATTEMPT_LIMIT",
      secondRuntime,
      secondStopped
        ? "The arm was retired after two stopped authoritative attempts."
        : "The arm reached the maximum of two authoritative entries.",
      candidate.candidateId,
      candidateTrade.id,
    );
    const firstCandidateIndex = candidates.findIndex((item) => item.candidateId === runtime.firstCandidateId);
    if (firstCandidateIndex >= 0) {
      const firstCandidate = candidates[firstCandidateIndex]!;
      candidates[firstCandidateIndex] = {
        ...firstCandidate,
        entryAttemptCount: 2,
        secondCandidateId: candidate.candidateId,
        secondTradeId: candidateTrade.id,
        armRetirementReason: finalCandidate.armRetirementReason,
      };
    }
    candidates.push(finalCandidate);
    authoritativeTrades.push({
      ...candidateTrade,
      armAttemptId: attemptId,
      attemptOrdinal: 2,
      attemptGrade: finalCandidate.attemptGrade,
      causalIdentity: finalCandidate.causalIdentity,
      audit: candidateTrade.audit
        ? {
          ...candidateTrade.audit,
          armAttemptId: attemptId,
          attemptOrdinal: 2,
          attemptGrade: finalCandidate.attemptGrade,
          causalIdentity: finalCandidate.causalIdentity,
        }
        : candidateTrade.audit,
    });
    attemptByArm.set(armId, secondRuntime);
  }
  const rejectionBySignalId = new Map(rejected.map((rejection) => [rejection.signalOccurrenceId, rejection]));
  for (const trade of rawTrades) {
    const matchingCandidate = candidates.find((candidate) =>
      candidate.contractSymbol === trade.contractSymbol
      && candidate.tradingDate === trade.tradingDate
      && candidate.direction === trade.direction
      && trade.audit?.patienceCandleOpenTime === candidate.patienceTimestamp
      && trade.audit?.triggerCandleOpenTime === candidate.eOpenTimestamp,
    );
    if (!matchingCandidate) {
      const matchingSignal = confirmed.find((occurrence) =>
        occurrence.contractSymbol === trade.contractSymbol
        && occurrence.tradingDate === trade.tradingDate
        && occurrence.direction === trade.direction
        && trade.audit?.patienceCandleOpenTime === occurrence.patienceTimestamp
        && trade.audit?.triggerCandleOpenTime === occurrence.eOpenTimestamp,
      );
      orphans.push({
        tradeId: trade.id,
        matchingSignalOccurrenceId: matchingSignal?.occurrenceId,
        reason: matchingSignal && rejectionBySignalId.get(matchingSignal.occurrenceId)
          ? rejectionBySignalId.get(matchingSignal.occurrenceId)!.details.join(" ")
          : matchingSignal
            ? "The modeled trade matched a confirmed signal, but that signal failed lifecycle, edge, identity, or primary-window eligibility."
          : "No canonical confirmed signal matched the trade's exact contract/date/direction/P/E identity.",
      });
      continue;
    }
    if (matchingCandidate.executionStatus !== "MODELED_TRADE_CREATED"
      || matchingCandidate.entryReachedThreshold !== true) {
      orphans.push({
        tradeId: trade.id,
        matchingSignalOccurrenceId: matchingCandidate.signalOccurrenceId,
        reason: "LEGACY_TRADE_CONFLICTS_WITH_CANDIDATE_ENTRY_DISPOSITION",
      });
      continue;
    }
    if (!authoritativeTrades.some((existing) => existing.candidateId === matchingCandidate.candidateId)) {
      // A legacy modeled trade is evidence for reconciliation only. It must
      // never become authoritative when the candidate-owned execution was not
      // produced, because its target and P/L may come from the old model.
      orphans.push({
        tradeId: trade.id,
        matchingSignalOccurrenceId: matchingCandidate.signalOccurrenceId,
        reason: matchingCandidate.targetDisposition === "NO_ELIGIBLE_KEY_LEVEL"
          ? "NO_ELIGIBLE_KEY_LEVEL: legacy modeled trade cannot supply a target or outcome."
          : "CANDIDATE_OWNED_EXECUTION_MISSING: legacy modeled trade cannot become authoritative.",
      });
    } else if (authoritativeTrades.some((existing) =>
      existing.candidateId === matchingCandidate.candidateId
      && existing.signalOccurrenceId !== matchingCandidate.signalOccurrenceId)) {
    }
  }
  return { candidates, rejected, authoritativeTrades, orphans };
}

function candidateLifecycleRejection(
  occurrence: HistoricalOccurrence,
  lifecycle: HistoricalPullbackLifecycle | undefined,
): { reasonCodes: string[]; details: string[] } | null {
  const armId = occurrence.eligibilityArmId;
  if (!armId) return null;
  if (occurrence.eligibilityArmState === "invalidated" || occurrence.eligibilityArmState === "superseded") {
    return {
      reasonCodes: [`REJECTED_PULLBACK_ARM_${occurrence.eligibilityArmState.toUpperCase()}`],
      details: [
        `Confirmed signal ${occurrence.occurrenceId} was excluded because causal arm ${armId} reported ${occurrence.eligibilityArmState} before this attempt.`,
        ...(occurrence.eligibilityArmStateReason ? [occurrence.eligibilityArmStateReason] : []),
      ],
    };
  }
  if (!lifecycle) {
    return {
      reasonCodes: ["REJECTED_PULLBACK_ARM_LIFECYCLE_MISSING"],
      details: [`Confirmed signal ${occurrence.occurrenceId} references causal arm ${armId}, but canonical lifecycle data was not supplied.`],
    };
  }
  const record = lifecycle.records.find((item) => item.armId === armId);
  if (!record) {
    return {
      reasonCodes: ["REJECTED_PULLBACK_ARM_LIFECYCLE_MISSING"],
      details: [`Confirmed signal ${occurrence.occurrenceId} references causal arm ${armId}, but no canonical lifecycle record exists for that exact arm.`],
    };
  }
  const conflicts = lifecycle.conflicts.filter((conflict) => conflict.armId === armId);
  if (conflicts.length > 0) {
    return {
      reasonCodes: ["REJECTED_CONFLICTING_PULLBACK_ARM"],
      details: [
        `Confirmed signal ${occurrence.occurrenceId} references causal arm ${armId}, which has ${conflicts.length} lifecycle conflict(s).`,
        ...conflicts.map((conflict) => `${conflict.reason} Observed ${conflict.observedState} after canonical ${conflict.canonicalState}.`),
      ],
    };
  }
  if (!isTerminalPullbackArmState(record.state)) return null;
  const terminalTransition = record.transitions
    .find((transition) => isTerminalPullbackArmState(transition.to));
  const terminalTime = terminalTransition?.time ?? Number.NaN;
  const occurrenceConfirmationTime = Date.parse(
    occurrence.entryObservationTimestamp
      ?? occurrence.entryTimestamp
      ?? occurrence.eOpenTimestamp
      ?? "",
  );
  if (
    Number.isFinite(terminalTime)
    && Number.isFinite(occurrenceConfirmationTime)
    && terminalTime > occurrenceConfirmationTime
  ) {
    return null;
  }
  return {
    reasonCodes: [`REJECTED_PULLBACK_ARM_${record.state}`],
    details: [
      `Confirmed signal ${occurrence.occurrenceId} was excluded because causal arm ${armId} was terminal at ${record.state} before or at confirmation.`,
      ...(record.terminalReason ? [record.terminalReason] : []),
    ],
  };
}

function candidateDrivenEntryTrade(
  occurrence: HistoricalOccurrence,
  candidateId: string,
  candidate: HistoricalTradeCandidate,
  context: { dataset: CausalReplayDataset; specification: ReturnType<typeof getFuturesContractSpecification>; executionMode: BacktestRequest["executionMode"] },
): BacktestTrade | undefined {
  const entryOpenTimestamp = occurrence.eOpenTimestamp ? Date.parse(occurrence.eOpenTimestamp) : Number.NaN;
  const config = activeShadowStrategySnapshot().config;
  if (
    !Number.isFinite(entryOpenTimestamp)
    || wallClockMinutesForTimestamp(entryOpenTimestamp, config.sessionTimeZone) < config.primaryEntryStartMinutes
    || wallClockMinutesForTimestamp(entryOpenTimestamp, config.sessionTimeZone) >= config.primaryEntryEndMinutes
  ) return undefined;
  const patience = occurrence.patienceCandle;
  const entryCandle = occurrence.entryCandle;
  const entryPrice = effectiveEntryThresholdForOccurrence(occurrence);
  const disposition = candidateEntryDisposition(occurrence);
  if (disposition.status !== "MODELED_TRADE_CREATED" || !patience || !entryCandle || entryPrice === null || occurrence.direction === null) return undefined;
  const tradingDate = occurrence.tradingDate;
  const contractMonth = parseMesContractSymbol(occurrence.contractSymbol)?.contractMonth ?? context.dataset.contractMonth;
  const period = periodForDate(tradingDate, context.dataset);
  const entryCloseTimestamp = numericCandleValue(entryCandle, "closeTime");
  const entryObservationTimestamp = entryCloseTimestamp !== null
    ? new Date(entryCloseTimestamp).toISOString()
    : occurrence.entryObservationTimestamp;
  if (!entryObservationTimestamp) return undefined;
  const entryTime = entryObservationTimestamp;
  const management = candidate.managementContext ?? freezeCandidateManagementContext(occurrence, candidateId, undefined);
  const contracts = SHADOW_CONTRACTS_PER_TRADE;
  const targetPlan = management.targetPlan;
  const primaryLossExitLevel = management.primaryLossExitLevel
    ?? primaryLossExitReferenceForOccurrence(occurrence, entryPrice);
  const targetPrice = targetPlan?.targetPrice ?? null;
  const contractCandles = context.dataset.candles
    .filter((item) => item.contractSymbol === occurrence.contractSymbol)
    .sort((first, second) => first.openTime - second.openTime);
  const entryOpenTime = numericCandleValue(entryCandle, "openTime") ?? Date.parse(occurrence.eOpenTimestamp!);
  const entryCloseTime = numericCandleValue(entryCandle, "closeTime") ?? Date.parse(entryObservationTimestamp);
  const managementValidationReasons = candidateManagementValidationReasons(
    management,
    entryObservationTimestamp,
  );
  const missingContext = managementValidationReasons.length > 0;
  const regular = !missingContext
    ? sessionWindow(tradingDate, "regular", sessionCalendarForContract(context.specification))
    : null;
  const postEntry = contractCandles.filter((item) =>
    item.isComplete
    && item.openTime > entryOpenTime
    && item.closeTime > entryCloseTime
    && regular !== null
    && item.openTime >= regular.openTime
    && item.closeTime <= regular.closeTime,
  );
  const sessionCloseCandle = !missingContext
    ? regular
      ? contractCandles.filter((item) =>
        item.isComplete
        && item.openTime > entryOpenTime
        && item.closeTime > entryCloseTime
        && item.openTime >= regular.openTime
        && item.closeTime <= regular.closeTime,
      ).at(-1) ?? null
      : null
    : null;
  let modeled: ReturnType<typeof simulateOhlcvExecution> | null = null;
  if (!missingContext) {
    modeled = simulateOhlcvExecution({
      direction: occurrence.direction,
      entry: entryPrice,
      patienceCandle: patience as any,
      immediateTriggerCandle: entryCandle as any,
      evaluateEntryCandleForExit: false,
      subsequentCompletedCandles: postEntry,
      contracts,
      targetQuantity: targetPrice === null ? 0 : Math.min(1, management.contracts),
      target: targetPrice,
      oneRProfitRule: targetPrice === null,
      structureTrailing: true,
      trailingBufferTicks: 8,
      noLevelBreakevenActivationBars: config.noLevelBreakevenActivationBars,
      strategyStop: management.strategyStopPrice,
      // Candidate-driven management deliberately ignores the legacy
      // catastrophe barrier. Preserve that value in provenance below, but do
      // not let it create a competing operative loss exit.
      catastropheStop: null,
      primaryLossExitLevel,
      sessionCloseCandle: sessionCloseCandle as any,
      tickSize: context.specification.tickSize,
      tickValue: context.specification.dollarValuePerTick,
      pointMultiplier: context.specification.pointValue * context.specification.contractMultiplier,
      entrySlippageTicks: 0,
      exitSlippageTicks: 0,
      fees: {
        commission: context.specification.commissionPerContract,
        exchange: context.specification.exchangeFeePerContract ?? context.specification.exchangeAndRegulatoryFeesPerContract,
        regulatory: context.specification.regulatoryFeePerContract,
        clearing: context.specification.clearingFeePerContract,
      },
    });
  }
  const isOpen = missingContext || modeled?.exitPrice === null || !modeled?.legs.length;
  const outcome: BacktestTrade["outcome"] = missingContext
    ? "open"
    : modeled?.exitReason === "target"
      ? "target"
      : modeled?.exitReason === "stop"
        ? modeled.audit.stopLevel === "catastrophe" ? "catastrophe stop" : "strategy stop"
        : modeled?.exitReason === "breakeven"
          ? "breakeven"
          : modeled?.exitReason === "breakeven_recovery"
            ? "breakeven recovery"
            : modeled?.exitReason === "runner"
              ? "manual"
              : modeled?.exitReason === "session_close"
                ? "session close"
                : "open";
  const exitCandle = modeled?.audit.exitCandle ?? null;
  const ambiguityLabel = modeled?.ambiguityLabels.find(isExecutionAmbiguityLabel) ?? null;
  const accounting = modeled?.accounting ?? { grossPnl: 0, fees: 0, slippage: 0, netPnl: 0 };
  return {
    id: `${candidateId}-ohlcv-confirmation`,
    causalIdentity: candidateCausalIdentityForOccurrence(occurrence),
    signalOccurrenceId: occurrence.occurrenceId,
    candidateId,
    targetPlan,
    tradingDate,
    contractSymbol: occurrence.contractSymbol,
    contractMonth,
    period,
    setupType: occurrence.primaryEdge ?? occurrence.strategyCandidate,
    direction: occurrence.direction,
    entryTime,
    exitTime: isOpen ? null : exitCandle?.closeTime ? new Date(exitCandle.closeTime).toISOString() : null,
    entryPrice,
    exitPrice: isOpen ? null : modeled?.exitPrice ?? null,
     contracts,
    grossPnl: accounting.grossPnl,
    fees: accounting.fees,
    slippage: accounting.slippage,
    netPnl: accounting.netPnl,
    outcome,
    ambiguityLabel,
    source: modeled?.audit.exitCandle ? "ohlc" : "ohlc",
    executionMode: context.executionMode,
    fillLabel: "OHLCV_CONFIRMATION_THRESHOLD",
    primaryEdge: occurrence.primaryEdge ?? occurrence.strategyCandidate,
    matchedEdges: [...new Set(occurrence.matchedEdges ?? [occurrence.strategyCandidate])].sort(),
    supportingConfluences: [...new Set(occurrence.supportingConfluences ?? [])].sort(),
    setupGrade: occurrence.setupGrade ?? "A",
    patienceCandle: patience,
    entryCandle,
    segmentation: {
      contract: occurrence.contractSymbol,
      contractMonth,
      setupType: occurrence.primaryEdge ?? occurrence.strategyCandidate,
      direction: occurrence.direction,
      timeOfDay: "midday",
      trend: "neutral",
      fibonacciDepth: "unknown",
      volumeCondition: "neutral",
      levelType: occurrence.levelIdentifiers.some((level) => /^fib/i.test(level)) ? "Fibonacci" : "mixed",
      confluence: occurrence.levelIdentifiers.length > 1 ? "strong" : "normal",
      patienceCharacteristic: "Buffered immediate confirmation",
      orbState: "ENTRY_TRIGGERED",
      marketRegime: "trend",
    },
    audit: {
      causalIdentity: candidateCausalIdentityForOccurrence(occurrence),
      entryTriggerPrice: entryPrice,
      modeledFillPrice: entryPrice,
       stopPrice: modeled?.stopPrice ?? management.strategyStopPrice,
      targetPrice,
      targetPlan,
      primaryLossExitLevel,
      strategyStopPrice: management.strategyStopPrice,
      catastropheStopPrice: management.catastropheStopPrice,
      stopLevel: modeled?.audit.stopLevel ?? null,
      patienceCandleOpenTime: occurrence.patienceTimestamp,
      patienceCandleCloseTime: typeof patience.closeTime === "number" ? new Date(patience.closeTime).toISOString() : null,
      triggerCandleOpenTime: occurrence.eOpenTimestamp,
       triggerCandleCloseTime: typeof entryCandle.closeTime === "number"
         ? new Date(entryCandle.closeTime).toISOString()
         : null,
      modeledFillObservationTime: entryTime,
      exitCandleOpenTime: exitCandle?.openTime ? new Date(exitCandle.openTime).toISOString() : null,
      exitCandleCloseTime: exitCandle?.closeTime ? new Date(exitCandle.closeTime).toISOString() : null,
      assumptions: [
        "Candidate-driven Shadow Mode entry uses the OHLCV confirmation threshold; no bid/ask quote is fabricated.",
        targetPlan
          ? `Target plan selects ${targetPlan.selectedTargetLevel?.id ?? "no eligible key level"} only when it is within ${targetPlan.bufferTicks ?? PROFIT_TARGET_BUFFER_TICKS} MES ticks of entry; the target is placed ${targetPlan.placementTicks ?? PROFIT_TARGET_PLACEMENT_TICKS} MES ticks before the level.`
           : "No eligible key-level target plan was available; one contract exits fully at its actual initial-stop 1R distance, while multi-contract positions take one contract at 1R before structure trailing.",
       ...(primaryLossExitLevel
           ? [`Nearby ${primaryLossExitLevel.id} level retained as diagnostic evidence only; the frozen patience opposite-wick strategy stop remains authoritative.`]
           : []),
        ...(missingContext
          ? [`Management context unavailable or invalid: ${[...new Set([
            ...management.missingEvidenceReasons,
            ...managementValidationReasons,
          ])].join(", ")}.`]
          : []),
        ...(modeled?.assumptions ?? []),
      ],
      eventLabels: ["CANDIDATE_DRIVEN_ENTRY", "OHLCV_CONFIRMATION_THRESHOLD", ...(modeled?.eventLabels ?? [])],
      ambiguityLabels: modeled?.ambiguityLabels ?? [],
      targetHit: modeled?.audit.targetHit ?? false,
      runnerActivated: modeled?.audit.runnerActivated ?? false,
      runnerExited: modeled?.audit.runnerExited ?? false,
      runnerReferencePrice: modeled?.audit.runnerReferencePrice ?? null,
      runnerImpulse: modeled?.audit.runnerImpulse ?? null,
      runnerMostFavorablePrice: modeled?.audit.runnerMostFavorablePrice ?? null,
       initialRiskPoints: modeled?.audit.initialRiskPoints ?? null,
       oneRPrice: modeled?.audit.oneRPrice ?? null,
       oneRReached: modeled?.audit.oneRReached ?? false,
       profitCheckpointPrice: modeled?.audit.profitCheckpointPrice ?? null,
       trailingStopPrice: modeled?.audit.trailingStopPrice ?? null,
       trailingStopActive: modeled?.audit.trailingStopActive ?? false,
       trailingStopSource: modeled?.audit.trailingStopSource ?? null,
       noForwardLevelAtEntry: modeled?.audit.noForwardLevelAtEntry ?? false,
       postEntryCompletedBars: modeled?.audit.postEntryCompletedBars ?? 0,
       breakevenActivationBars: modeled?.audit.breakevenActivationBars ?? null,
       breakevenActivated: modeled?.audit.breakevenActivated ?? false,
       breakevenActivationTimestamp: modeled?.audit.breakevenActivationTimestamp === null || modeled?.audit.breakevenActivationTimestamp === undefined
         ? null
         : new Date(modeled.audit.breakevenActivationTimestamp).toISOString(),
       breakevenEffectiveFromTimestamp: modeled?.audit.breakevenEffectiveFromTimestamp === null || modeled?.audit.breakevenEffectiveFromTimestamp === undefined
         ? null
         : new Date(modeled.audit.breakevenEffectiveFromTimestamp).toISOString(),
       breakevenPrice: modeled?.audit.breakevenPrice ?? null,
       breakevenDisposition: modeled?.audit.breakevenDisposition ?? "NOT_APPLICABLE",
       originalStopStillActive: modeled?.audit.originalStopStillActive ?? false,
      remainingQuantity: modeled?.audit.remainingQuantity ?? management.contracts,
      exitReason: modeled?.exitReason ?? "not filled",
      legs: modeled?.legs ?? [],
    },
  };
}

function candidateDimensionValue(
  candidate: QualificationCandidate,
  dimension: QualificationFunnelComparison["dimension"],
): string {
  switch (dimension) {
    case "contract": return candidate.contractSymbol;
    case "month": return candidate.contractMonth;
    case "direction": return candidate.direction ?? "unknown";
    case "period": return candidate.period;
    case "market_regime": return candidate.marketRegime;
    case "volume_regime": return candidate.volumeRegime;
  }
}

function funnelStageCounts(
  candidates: readonly QualificationCandidate[],
  sessionCount: number,
  useCandidateSessionDenominator = false,
): QualificationFunnelStageCount[] {
  const candidateSessionCount = new Set(candidates.map((candidate) => `${candidate.tradingDate}|${candidate.contractSymbol}`)).size;
  const sessionDenominator = useCandidateSessionDenominator ? candidateSessionCount : sessionCount;
  return QUALIFICATION_FUNNEL_STAGES.map((stage, index) => {
    const count = candidates.filter((candidate) => stageRank(candidate.reachedStage) >= index).length;
    const preceding = index === 0
      ? candidates.length
      : candidates.filter((candidate) => stageRank(candidate.reachedStage) >= index - 1).length;
    const reachedSessions = new Set(
      candidates
        .filter((candidate) => stageRank(candidate.reachedStage) >= index)
        .map((candidate) => `${candidate.tradingDate}|${candidate.contractSymbol}`),
    ).size;
    return {
      stage,
      count,
      percentOfPreceding: preceding === 0 ? 0 : Number(((count / preceding) * 100).toFixed(1)),
      percentOfSessions: sessionDenominator === 0 ? 0 : Number(((reachedSessions / sessionDenominator) * 100).toFixed(1)),
    };
  });
}

export function buildQualificationFunnel(
  reports: readonly (Pick<BacktestReport, "audit" | "trades" | "dataset" | "contract"> & Partial<Pick<BacktestReport, "occurrences">>)[],
): QualificationFunnel {
  const allAudits = reports.flatMap((report) => report.audit);
  const allTrades = reports.flatMap((report) => report.trades);
  // Every completed causal evaluation is an independent funnel occurrence.
  // Do not select the strongest/latest record: later qualification failure
  // must not erase an earlier pullback or patience observation.
  const occurrenceRecords = [...new Map(
    allAudits.map((record) => [candidateKey(record), record]),
  ).values()];

  const sessionKeys = new Set<string>();
  for (const report of reports) {
    for (const date of report.dataset.selectedDates) {
      const activeContract = report.dataset.activeContractByDate?.find((item) => item.tradingDate === date)?.contractSymbol
        ?? report.trades.find((trade) => trade.tradingDate === date)?.contractSymbol
        ?? report.audit.find((record) => record.tradingDate === date)?.contractSymbol
        ?? report.contract.fullContractSymbol;
      sessionKeys.add(`${date}|${activeContract}`);
    }
  }

  const candidates = occurrenceRecords
    .sort((first, second) => candidateKey(first).localeCompare(candidateKey(second)))
    .map((record): QualificationCandidate => {
      const trade = tradeForRecord(record, allTrades);
      const flags = stageEvidence(record, trade);
      const reachedStage = contiguousStage(flags);
      const firstRejectedIndex = flags.findIndex((passed, index) => index > 0 && !passed);
      const primaryRejectionStage = firstRejectedIndex < 0 || trade
        ? null
        : QUALIFICATION_FUNNEL_STAGES[firstRejectedIndex];
      const evaluatedTime = Date.parse(record.evaluatedCandleOpenTime);
      const hourTime = Number.isFinite(evaluatedTime) ? timeOfDay(evaluatedTime) : "close";
      const marketRegime: BacktestSegmentation["marketRegime"] = /^neutral:/i.test(record.trendEvidence)
        ? "range"
        : /reversal|warning|transition/i.test(`${record.trendEvidence} ${record.volumeEvidence}`)
          ? "transition"
          : "trend";
      const volumeRegime: "normal" | "high" = /supported|high volume|confirmed/i.test(record.volumeEvidence)
        ? "high"
        : "normal";
      return {
        candidateId: candidateKey(record),
        tradingDate: record.tradingDate,
        contractSymbol: record.contractSymbol,
        contractMonth: record.contractMonth,
        period: record.period,
        direction: record.direction,
        setupType: record.setupType,
        timeOfDay: hourTime,
        marketRegime,
        volumeRegime,
        reachedStage,
        primaryRejectionStage,
        rejectionDetail: primaryRejectionStage ? record.rejectionSummary ?? record.rejectionReason : null,
        evidence: {
          evaluatedCandleOpenTime: record.evaluatedCandleOpenTime,
          orbLevels: record.orbState,
          breakout: record.breakoutEvidence,
          volume: record.volumeEvidence,
          pullback: record.pullbackEvidence,
          criticalLevel: record.criticalLevelEvidence,
          trend: record.trendEvidence,
          patience: record.patienceState,
          trigger: record.triggerCandle ? "Entry candle (E) completed." : "No completed immediate-next entry candle.",
          patienceCandle: record.patienceCandle,
          triggerCandle: record.triggerCandle,
          patienceCandleOpenTime: record.patienceCandleOpenTime,
          patienceCandleCloseTime: record.patienceCandleCloseTime,
          triggerCandleOpenTime: record.triggerCandleOpenTime,
          triggerCandleCloseTime: record.triggerCandleCloseTime,
          entryTriggerPrice: record.entryTriggerPrice,
          strategyStopPrice: record.strategyStopPrice,
          catastropheStopPrice: record.catastropheStopPrice,
          targetPrice: record.targetPrice,
          decision: record.decision,
          rejectionCategory: record.rejectionCategory,
          ruleEvidence: [...record.ruleEvidence],
          finalOutcome: trade?.outcome ?? null,
          exitCandleOpenTime: trade?.audit?.exitCandleOpenTime ?? record.exitCandleOpenTime,
          exitCandleCloseTime: trade?.audit?.exitCandleCloseTime ?? record.exitCandleCloseTime,
          netPnl: trade?.netPnl ?? record.netPnl,
        },
      };
    });
  const stages = funnelStageCounts(candidates, sessionKeys.size);
  const dimensions: QualificationFunnelComparison["dimension"][] = [
    "contract", "month", "direction", "period", "market_regime", "volume_regime",
  ];
  const comparisons = dimensions.flatMap((dimension) => {
    const values = [...new Set(candidates.map((candidate) => candidateDimensionValue(candidate, dimension)))].sort();
    return values.map((value) => {
      const matching = candidates.filter((candidate) => candidateDimensionValue(candidate, dimension) === value);
      return {
        dimension,
        value,
        candidateCount: matching.length,
        stageCounts: funnelStageCounts(matching, sessionKeys.size, true),
      };
    });
  });
  const rejectionCounts = QUALIFICATION_FUNNEL_STAGES
    .map((stage) => ({ stage, count: candidates.filter((candidate) => candidate.primaryRejectionStage === stage).length }))
    .filter((item) => item.count > 0);
  return {
    sessionCount: sessionKeys.size,
    candidateCount: candidates.length,
    occurrenceCount: reports.reduce((total, report) => total + (report.occurrences?.length ?? 0), 0),
    stages,
    rejectionCounts,
    comparisons,
    candidates,
  };
}

export function runCausalBacktest(
  request: BacktestRequest,
  riskInput?: { accountSize: number; riskPercent: number; maxDailyLoss: number; dailyLossUsed: number; isLocked: boolean },
  providedDataset?: CausalReplayDataset,
  onProgress?: (progress: CausalReplayProgress) => void,
): BacktestReport {
  const specification = getFuturesContractSpecification(request.symbol);
  const activeStrategy = activeShadowStrategySnapshot();
  const governedConsolidation = consolidationThresholds(activeStrategy.config);
  const calendar = sessionCalendarForContract(specification);
  const dataset = providedDataset ?? buildReplayDataset(request.symbol, request);
  const executionMode = request.executionMode
    ?? (dataset.quotesAvailable === false ? "ohlcv_modeled" : "quote_based_shadow");
  // Arm identity must remain stable as the replay cursor advances. The market
  // snapshot receives only the visible candle prefix, so its default feed
  // fingerprint would otherwise change at every cursor and split one causal
  // pullback arm into multiple independent arms.
  const replaySourceFingerprint = sourceFingerprint(dataset);
  if (executionMode === "quote_based_shadow" && dataset.quotesAvailable === false) {
    throw new Error("Quote-based Shadow execution requires genuine bid/ask data; this dataset is OHLCV-only.");
  }
  if (executionMode === "ohlcv_modeled"
    && !["historical_databento", "historical_databento_multicontract"].includes(dataset.source ?? "")
    && dataset.quotesAvailable !== false) {
    throw new Error("Modeled OHLCV execution is reserved for explicitly historical OHLCV datasets.");
  }
  const entryBufferTicks = request.ohlcvEntryBufferTicks ?? 8;
  const stopBufferTicks: number = Number(request.ohlcvStopBufferTicks ?? activeStrategy.config.patienceStopBufferTicks);
  if (stopBufferTicks !== 12) throw new Error("OHLCV patience stop buffer must be exactly twelve MES ticks.");
  const modeledSlippageTicks = request.ohlcvSlippageTicks ?? 1;
  const commissionPerContract = request.ohlcvCommissionPerContract
    ?? 2 * (specification.commissionPerContract + specification.exchangeAndRegulatoryFeesPerContract);
  const candles = sortedCandles(dataset.candles);
  const ticks = dataset.ticks ?? [];
  const oneMinute = dataset.oneMinute ?? candles.flatMap(buildSyntheticOneMinuteBars);
  const candleIndexByOpenTime = new Map(candles.map((item, index) => [item.openTime, index]));
  const replayIndexes = buildReplayIndexes(candles, ticks, oneMinute, calendar);
  const finalRegularIndexByContractDate = new Map<string, number>();
  for (const [index, item] of candles.entries()) {
    const date = tradingDateForTimestamp(item.openTime, calendar);
    const window = sessionWindow(date, "regular", calendar);
    if (item.isComplete && window && item.openTime >= window.openTime && item.closeTime <= window.closeTime) {
      finalRegularIndexByContractDate.set(`${item.contractSymbol}:${date}`, index);
    }
  }
  const totalReplaySessions = dataset.selectedDates?.length
    ?? new Set(candles
      .filter((item) => item.isComplete)
      .map((item) => `${item.contractSymbol}:${tradingDateForTimestamp(item.openTime, calendar)}`))
      .size;
  const completedReplaySessions = new Set<string>();
  const markCompletedSessionBeforeIndex = (index: number): void => {
    if (!onProgress || index <= 0) return;
    const previous = candles[index - 1];
    if (!previous?.isComplete) return;
    const previousDate = tradingDateForTimestamp(previous.openTime, calendar);
    const previousKey = `${previous.contractSymbol}:${previousDate}`;
    if (finalRegularIndexByContractDate.get(previousKey) !== index - 1 || completedReplaySessions.has(previousKey)) return;
    completedReplaySessions.add(previousKey);
    onProgress({
      completedSessions: completedReplaySessions.size,
      totalSessions: totalReplaySessions,
    });
  };
  const rejectedByPeriod = { in_sample: 0, out_of_sample: 0 };
  const trades: BacktestTrade[] = [];
  const audit: BacktestAuditRecord[] = [];
  const historicalContractSymbol = dataset.source === "historical_databento" || dataset.source === "historical_databento_multicontract"
    ? dataset.contractSymbol
    : specification.fullContractSymbol;
  const reportContract = dataset.source === "historical_databento" || dataset.source === "historical_databento_multicontract"
    ? { ...specification, fullContractSymbol: dataset.contractSymbol }
    : specification;
  let lastExitIndex = -1;
  const executedEntryKeys = new Set<string>();
  let finalReplay: ReplayCursor = { cursor: 0, visibleCandleCount: 0, visibleCandleCloseTime: null, mode: "replay" };
  let previousContractSymbol: string | null = null;

  for (let index = 0; index < candles.length; index += 1) {
    markCompletedSessionBeforeIndex(index);
    const candle = candles[index];
    const currentContractSymbol = dataset.contractSchedule
      ? candle.contractSymbol
      : historicalContractSymbol;
    const currentContractMonth = dataset.contractSchedule
      ? parseMesContractSymbol(currentContractSymbol)?.contractMonth ?? dataset.contractMonth
      : dataset.contractMonth;
    if (dataset.contractSchedule && previousContractSymbol !== null && previousContractSymbol !== currentContractSymbol) {
      // Never carry a position, indicators, or execution state through a
      // scheduled contract boundary.
      lastExitIndex = index - 1;
    }
    previousContractSymbol = currentContractSymbol;
    const contractCandles = dataset.contractSchedule
      ? replayIndexes.candlesByContract.get(currentContractSymbol) ?? []
      : candles;
    const contractCandleIndex = dataset.contractSchedule
      ? replayIndexes.candleIndexByContractOpenTime.get(currentContractSymbol)?.get(candle.openTime) ?? -1
      : candleIndexByOpenTime.get(candle.openTime) ?? -1;
    const visibleContractCandles = contractCandles.slice(0, Math.max(0, contractCandleIndex) + 1);
    const historicalHourly = replayIndexes.hourlyByContract.get(currentContractSymbol)
      ?? replayIndexes.hourlyByContract.get(dataset.contractSchedule ? currentContractSymbol : candle.contractSymbol)
      ?? completedSimulatedHourlyCandles(contractCandles, calendar);
    const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
    const period = periodForDate(tradingDate, dataset);
    const regularWindow = sessionWindow(tradingDate, "regular", calendar);
    if (!regularWindow || candle.openTime < regularWindow.openTime || candle.openTime >= regularWindow.closeTime) continue;
     if (!candle.isComplete || !candle.closeTime) continue;
     const positionActive = lastExitIndex >= index;
    const cursor = {
      cursor: candle.closeTime,
      visibleCandleCount: visibleContractCandles.length,
      visibleCandleCloseTime: visibleContractCandles.at(-1)?.closeTime ?? null,
      mode: "replay" as const,
      candles: visibleContractCandles,
    };
    assertCausalVisibility(cursor.candles, candle.closeTime);
    finalReplay = cursor;
    const snapshot = createMarketSnapshot(
      request.symbol,
      "regular",
      riskInput,
      undefined,
      { targetDollars: request.targetDollars, slippageMode: request.slippageMode },
      {
        tradingDate,
        cursor: candle.closeTime,
        allCandles: visibleContractCandles,
        historicalFeed: visibleContractCandles,
        historicalHourly,
        allCandlesCompleted: true,
        strategyConfigOverrides: activeStrategy.config,
        premarketAvailable: request.premarketAvailable !== false,
        executionMode,
        sourceFingerprint: replaySourceFingerprint,
        // The active Shadow configuration is authoritative for ordinary backtests.
        ohlcvStopBufferTicks: executionMode === "ohlcv_modeled" ? stopBufferTicks : undefined,
      },
    );
    const evaluations = snapshot.setupAnalysis.evaluations;
    const evaluationAudits = evaluations.map((evaluation) => {
      const record = auditForEvaluation(
        evaluation,
        snapshot,
        candle,
        tradingDate,
        period,
        executionMode,
        currentContractSymbol,
        currentContractMonth,
        governedConsolidation,
        contractCandles,
        candle.contractSymbol,
        visibleContractCandles,
      );
      audit.push(record);
      return record;
    });
    for (const evaluation of evaluations) {
      if (evaluation.decision !== "SETUP QUALIFIED") {
        rejectedByPeriod[period] += 1;
      }
    }
    const selected = ([
      "ORB_PULLBACK_CONTINUATION",
      "CONSOLIDATION_BREAKOUT_CONTINUATION",
      "EQUIVALENT_CANDLE_REVERSAL",
      "PATIENCE_CANDLE_CONTINUATION",
      "PEAK_RETRACEMENT_REVERSAL",
    ] as const)
      .map((setupType) => evaluations.find((evaluation) => evaluation.setupType === setupType && evaluation.decision === "SETUP QUALIFIED" && !evaluation.alertOnly))
      .find((evaluation) => evaluation !== undefined);
    const matchedEdges = evaluations
      .filter((evaluation) => evaluation.decision === "SETUP QUALIFIED" && !evaluation.alertOnly)
      .map((evaluation) => evaluation.setupType);
    const supportingConfluences = selected
      ? [...new Set([
        ...(selected.supportingConfluences ?? []),
        ...selected.rules.filter((item) => item.passed).map((item) => item.label),
      ])]
      : [];
    const gradeScore = matchedEdges.length + (selected?.grade ?? 0);
    const setupGrade: BacktestTrade["setupGrade"] = gradeScore >= 3
      ? "A++"
      : gradeScore >= 2 ? "A+" : "A";
    const selectedPatience = selected && ["EQUIVALENT_CANDLE_REVERSAL", "PEAK_RETRACEMENT_REVERSAL"].includes(selected.setupType)
      ? snapshot.reversalPatience ?? snapshot.patience
      : snapshot.patience;
    const selectedAudit = selected
      ? evaluationAudits.find((record) => record.setupType === selected.setupType)
      : undefined;
    if (!selected?.direction) {
      if (selectedAudit) setAuditRejection(
        selectedAudit,
        "NO_QUALIFIED_SETUP",
        "No non-alert qualified setup was available.",
      );
      continue;
    }
    const selectedConsolidationGuard = selectedAudit?.consolidationGuard;
    if (selectedConsolidationGuard && !consolidationGuardIsExecutionEligible(selectedConsolidationGuard)) {
      setAuditRejection(
        selectedAudit!,
        "REJECTED_CONSOLIDATION_ENTRY_GUARD",
        [
          selectedConsolidationGuard.detail,
          selectedConsolidationGuard.rejectionReason
            ? `Reason: ${selectedConsolidationGuard.rejectionReason}.`
            : null,
        ].filter((detail): detail is string => detail !== null).join(" "),
      );
      rejectedByPeriod[period] += 1;
      continue;
    }
     // Historical candidates are independent Shadow Mode dispositions. The
     // legacy position-active gate must not prevent a confirmed candidate
     // from receiving its deterministic simulation; overlap remains visible
     // in the report rather than changing signal eligibility.
    if (executionMode === "ohlcv_modeled") {
       const patienceSummary = selectedPatience?.patienceCandle;
       const triggerSummary = selectedPatience?.triggerCandle;
       const contractCandleIndexByOpenTime = dataset.contractSchedule
         ? replayIndexes.candleIndexByContractOpenTime.get(currentContractSymbol)
         : candleIndexByOpenTime;
       const trigger = triggerSummary
          ? contractCandles[contractCandleIndexByOpenTime?.get(Date.parse(triggerSummary.openTime)) ?? -1]
         : undefined;
       const patienceCandle = patienceSummary
          ? contractCandles[contractCandleIndexByOpenTime?.get(Date.parse(patienceSummary.openTime)) ?? -1]
         : undefined;
      if (!trigger || !patienceCandle || trigger.closeTime > candle.closeTime) {
        if (selectedAudit) setAuditRejection(selectedAudit, "PATIENCE_TRIGGER_NOT_COMPLETED", "The required patience trigger was not complete at this candle.");
        rejectedByPeriod[period] += 1;
        continue;
      }
        const entry = selectedConsolidationGuard?.effectiveEntryThreshold
          ?? selectedPatience?.entryBufferPrice
         ?? snapshot.riskPlan.entry
         ?? effectiveConfirmationThreshold(
           patienceCandle,
           selected.direction,
           entryBufferTicks,
           specification.tickSize,
           snapshot.ntz.complete
             && typeof snapshot.ntz.high === "number"
             && typeof snapshot.ntz.low === "number"
             ? {
               high: snapshot.ntz.high,
               low: snapshot.ntz.low,
               complete: true,
             }
             : null,
         );
        const patienceExtreme = selected.direction === "long" ? patienceCandle.low : patienceCandle.high;
        const authoritativeStop = authoritativePatienceStopPrice(
          selected.direction,
          patienceExtreme,
          stopBufferTicks,
          specification.tickSize,
        );
        // Recalculate from the frozen P extreme rather than trusting a stale
        // legacy/risk-plan stop. A raw P extreme is never a valid strategy stop.
        const strategyStop = authoritativeStop;
        const targetPlan = targetPlanForSnapshot(
          snapshot,
          selected.direction,
          entry,
          contractCandles,
          candle.contractSymbol,
          trigger.openTime,
        );
        const primaryLossExitLevel = primaryLossExitReferenceForPatience({
          direction: selected.direction,
          entryPrice: entry,
          patienceLow: patienceCandle.low,
          patienceHigh: patienceCandle.high,
          levels: targetLevelsForSnapshot(
            snapshot,
            trigger.openTime,
            contractCandles,
            candle.contractSymbol,
          ),
        });
        const target = targetPlan.targetPrice;
       const contracts = SHADOW_CONTRACTS_PER_TRADE;
       const entryKey = `${currentContractSymbol}|${tradingDate}|${selected.direction}|${trigger.openTime}|${Math.round(entry / specification.tickSize)}`;
       if (executedEntryKeys.has(entryKey)) continue;
       const entryResolution = resolveEntryAndInvalidation({
        direction: selected.direction,
        candle: trigger,
         entry,
         invalidation: strategyStop,
        sequenceKnown: false,
      });
      if (entryResolution.status === "ambiguous") {
        if (selectedAudit) {
          setAuditRejection(selectedAudit, entryResolution.label, entryResolution.detail);
          selectedAudit.ambiguityLabels = [entryResolution.label ?? "AMBIGUOUS_ENTRY_INVALIDATION"];
        }
        rejectedByPeriod[period] += 1;
        continue;
      }
        const triggerIndex = contractCandleIndexByOpenTime?.get(trigger.openTime) ?? -1;
        const regularKey = `${currentContractSymbol}:${tradingDate}`;
        const regularCandles = replayIndexes.regularCandlesByContractDate.get(regularKey) ?? [];
        const regularIndex = replayIndexes.regularIndexByContractOpenTime.get(regularKey)?.get(trigger.openTime) ?? -1;
        const postTrigger = regularIndex >= 0
          ? regularCandles.slice(regularIndex + 1)
          : contractCandles
            .slice(triggerIndex + 1)
            .filter((item) => tradingDateForTimestamp(item.openTime, calendar) === tradingDate
              && item.isComplete
              && item.closeTime <= regularWindow.closeTime);
        const sessionCloseCandle = regularCandles.at(-1)
          ?? contractCandles
            .filter((item) => item.isComplete
              && tradingDateForTimestamp(item.openTime, calendar) === tradingDate
              && item.openTime >= regularWindow.openTime
              && item.closeTime <= regularWindow.closeTime)
            .at(-1);
      const modeled = simulateOhlcvExecution({
        direction: selected.direction,
         entry,
        patienceCandle,
        immediateTriggerCandle: trigger,
        subsequentCompletedCandles: postTrigger,
         contracts,
         targetQuantity: 1,
         target,
         strategyStop,
          primaryLossExitLevel,
         catastropheStop: snapshot.riskPlan.catastropheStop,
         noLevelBreakevenActivationBars: activeStrategy.config.noLevelBreakevenActivationBars,
        sessionCloseCandle,
        tickSize: specification.tickSize,
        tickValue: specification.dollarValuePerTick,
        pointMultiplier: specification.pointValue * specification.contractMultiplier,
        entrySlippageTicks: modeledSlippageTicks,
        exitSlippageTicks: modeledSlippageTicks,
        fees: request.ohlcvCommissionPerContract === undefined
          ? {
              commission: specification.commissionPerContract,
              exchange: specification.exchangeFeePerContract ?? specification.exchangeAndRegulatoryFeesPerContract,
              regulatory: specification.regulatoryFeePerContract,
              clearing: specification.clearingFeePerContract,
            }
          : { commission: request.ohlcvCommissionPerContract / 2 },
      });
       if (modeled.modeledFill === null) {
         if (selectedAudit) setAuditRejection(selectedAudit, "NO_MODELED_FILL", "The confirmed entry did not produce a finite OHLCV trigger fill.");
        continue;
      }
       if (selectedConsolidationGuard
         && !fillIsStrictlyOutsideConsolidation(selectedConsolidationGuard, selected.direction, modeled.modeledFill)) {
         if (selectedAudit) {
           selectedAudit.entryFillOutsideZone = false;
           setAuditRejection(
             selectedAudit,
             "CONSOLIDATION_ENTRY_FILL_NOT_OUTSIDE_ZONE",
             "The modeled fill was inside or exactly on the frozen consolidation boundary.",
           );
         }
         rejectedByPeriod[period] += 1;
         continue;
       }
       const isOpen = modeled.exitPrice === null || !modeled.legs.length;
       const exitCandle = modeled.audit.exitCandle ?? trigger;
      const outcome = modeled.exitReason === "target"
        ? "target"
        : modeled.exitReason === "stop"
          ? modeled.audit.stopLevel === "catastrophe" ? "catastrophe stop" : "strategy stop"
           : modeled.exitReason === "breakeven"
             ? "breakeven"
             : modeled.exitReason === "breakeven_recovery"
               ? "breakeven recovery"
               : modeled.exitReason === "session_close" ? "session close" : isOpen ? "open" : "manual";
       const ambiguityLabel = modeled.ambiguityLabels.find(isExecutionAmbiguityLabel) ?? null;
      const segment = segmentation(snapshot, selected.setupType, selected.direction, trigger, currentContractSymbol, currentContractMonth);
      trades.push({
        id: `${tradingDate}-${triggerIndex}-${selected.setupType}-ohlcv`,
        tradingDate,
        contractSymbol: currentContractSymbol,
        contractMonth: currentContractMonth,
        period,
        setupType: selected.setupType,
        direction: selected.direction,
         entryTime: new Date(trigger.closeTime).toISOString(),
          exitTime: isOpen ? null : new Date(exitCandle.closeTime ?? trigger.closeTime).toISOString(),
        entryPrice: modeled.modeledFill,
          exitPrice: modeled.exitPrice,
         contracts,
        grossPnl: modeled.accounting.grossPnl,
        fees: modeled.accounting.fees,
        slippage: modeled.accounting.slippage,
        netPnl: modeled.accounting.netPnl,
        outcome,
        ambiguityLabel,
        source: "ohlc",
        segmentation: segment,
        executionMode,
        fillLabel: MODELED_OHLCV_FILL_LABEL,
         primaryEdge: selected.setupType,
         matchedEdges,
         supportingConfluences,
         setupGrade,
         patienceCandle: occurrenceCandle(patienceCandle),
         entryCandle: occurrenceCandle(trigger),
        audit: {
          entryTriggerPrice: modeled.entryTrigger,
          modeledFillPrice: modeled.modeledFill,
          stopPrice: modeled.stopPrice,
          strategyStopPrice: modeled.audit.strategyStopPrice,
          catastropheStopPrice: modeled.audit.catastropheStopPrice,
          stopLevel: modeled.audit.stopLevel,
           primaryLossExitLevel: modeled.audit.primaryLossExitLevel,
          targetPrice: modeled.targetPrice,
           patienceCandleOpenTime: patienceCandle.openTime === undefined ? null : new Date(patienceCandle.openTime).toISOString(),
           patienceCandleCloseTime: patienceCandle.closeTime === undefined ? null : new Date(patienceCandle.closeTime).toISOString(),
           triggerCandleOpenTime: trigger.openTime === undefined ? null : new Date(trigger.openTime).toISOString(),
           triggerCandleCloseTime: trigger.closeTime === undefined ? null : new Date(trigger.closeTime).toISOString(),
           modeledFillObservationTime: trigger.closeTime === undefined ? null : new Date(trigger.closeTime).toISOString(),
          exitCandleOpenTime: exitCandle.openTime === undefined ? null : new Date(exitCandle.openTime).toISOString(),
           exitCandleCloseTime: exitCandle.closeTime === undefined ? null : new Date(exitCandle.closeTime).toISOString(),
          assumptions: modeled.assumptions,
           eventLabels: modeled.eventLabels,
          ambiguityLabels: modeled.ambiguityLabels,
          targetHit: modeled.audit.targetHit,
          runnerActivated: modeled.audit.runnerActivated,
          runnerExited: modeled.audit.runnerExited,
          runnerReferencePrice: modeled.audit.runnerReferencePrice ?? null,
          runnerImpulse: modeled.audit.runnerImpulse ?? null,
          runnerMostFavorablePrice: modeled.audit.runnerMostFavorablePrice ?? null,
           noForwardLevelAtEntry: modeled.audit.noForwardLevelAtEntry,
           postEntryCompletedBars: modeled.audit.postEntryCompletedBars,
           breakevenActivationBars: modeled.audit.breakevenActivationBars,
           breakevenActivated: modeled.audit.breakevenActivated,
           breakevenActivationTimestamp: modeled.audit.breakevenActivationTimestamp === null
             ? null
             : new Date(modeled.audit.breakevenActivationTimestamp).toISOString(),
           breakevenEffectiveFromTimestamp: modeled.audit.breakevenEffectiveFromTimestamp === null
             ? null
             : new Date(modeled.audit.breakevenEffectiveFromTimestamp).toISOString(),
           breakevenPrice: modeled.audit.breakevenPrice,
           breakevenDisposition: modeled.audit.breakevenDisposition,
           originalStopStillActive: modeled.audit.originalStopStillActive,
          remainingQuantity: modeled.audit.remainingQuantity,
          exitReason: modeled.exitReason,
          legs: modeled.legs,
        },
      });
      executedEntryKeys.add(entryKey);
      if (selectedAudit) {
        setAuditRejection(selectedAudit, null);
           selectedAudit.targetPrice = target;
           selectedAudit.targetPlan = targetPlan;
         selectedAudit.eventLabels = modeled.eventLabels;
         selectedAudit.ambiguityLabels = modeled.ambiguityLabels;
        selectedAudit.modeledFillObservationTime = new Date(trigger.closeTime).toISOString();
        selectedAudit.exitCandleOpenTime = exitCandle.openTime === undefined ? null : new Date(exitCandle.openTime).toISOString();
         selectedAudit.exitCandleCloseTime = exitCandle.closeTime === undefined ? null : new Date(exitCandle.closeTime).toISOString();
        selectedAudit.fees = modeled.accounting.fees;
        selectedAudit.slippage = modeled.accounting.slippage;
        selectedAudit.grossPnl = modeled.accounting.grossPnl;
        selectedAudit.netPnl = modeled.accounting.netPnl;
        selectedAudit.exitReason = modeled.exitReason;
         selectedAudit.noForwardLevelAtEntry = modeled.audit.noForwardLevelAtEntry;
         selectedAudit.postEntryCompletedBars = modeled.audit.postEntryCompletedBars;
         selectedAudit.breakevenActivationBars = modeled.audit.breakevenActivationBars;
         selectedAudit.breakevenActivated = modeled.audit.breakevenActivated;
         selectedAudit.breakevenActivationTimestamp = modeled.audit.breakevenActivationTimestamp === null
           ? null
           : new Date(modeled.audit.breakevenActivationTimestamp).toISOString();
         selectedAudit.breakevenEffectiveFromTimestamp = modeled.audit.breakevenEffectiveFromTimestamp === null
           ? null
           : new Date(modeled.audit.breakevenEffectiveFromTimestamp).toISOString();
         selectedAudit.breakevenPrice = modeled.audit.breakevenPrice;
         selectedAudit.breakevenDisposition = modeled.audit.breakevenDisposition;
         selectedAudit.originalStopStillActive = modeled.audit.originalStopStillActive;
      }
       lastExitIndex = Math.max(lastExitIndex, candleIndexByOpenTime.get(exitCandle.openTime ?? candle.openTime) ?? index);
      continue;
    }
    const entryReference = snapshot.riskPlan.entry ?? candle.close;
    const primaryLossExitLevel = selectedPatience?.patienceCandle
      ? primaryLossExitReferenceForPatience({
        direction: selected.direction,
        entryPrice: entryReference,
        patienceLow: selectedPatience.patienceCandle.low,
        patienceHigh: selectedPatience.patienceCandle.high,
        levels: targetLevelsForSnapshot(
          snapshot,
          candle.openTime,
          visibleContractCandles,
          candle.contractSymbol,
        ),
      })
      : null;
    const entryResolution = resolveEntryAndInvalidation({
      direction: selected.direction,
      candle,
      entry: entryReference,
      invalidation: snapshot.riskPlan.strategyStop,
      sequenceKnown: true,
    });
    if (entryResolution.status === "ambiguous") {
      if (selectedAudit) {
        selectedAudit.rejectionReason = entryResolution.label;
        selectedAudit.rejectionCategory = "AMBIGUITY";
        selectedAudit.rejectionSummary = entryResolution.detail;
        selectedAudit.ambiguityLabels = [entryResolution.label ?? "AMBIGUOUS_ENTRY_INVALIDATION"];
      }
      rejectedByPeriod[period] += 1;
      continue;
    }
    let exitIndex = index + 1;
    let resolution: IntrabarResolution = { status: "open", source: "ohlc", timestamp: null, price: null, ambiguityLabel: null, detail: "Trade remains open." };
    const finalRegularIndex = finalRegularIndexByContractDate.get(`${currentContractSymbol}:${tradingDate}`) ?? index;
    for (; exitIndex <= finalRegularIndex; exitIndex += 1) {
      const next = candles[exitIndex];
      resolution = resolveIntrabarOutcome({
        direction: selected.direction,
        target: snapshot.riskPlan.target,
        stop: snapshot.riskPlan.catastropheStop ?? snapshot.riskPlan.strategyStop,
         primaryLossExitLevel,
        candle: next,
        ticks: replayIndexes.ticksByCandleOpenTime.get(next.openTime),
        oneMinute: replayIndexes.oneMinuteByContractCandle.get(`${currentContractSymbol}:${next.openTime}`),
      });
      if (resolution.status !== "open") break;
    }
    if (resolution.status === "open") exitIndex = finalRegularIndex;
    const exitCandle = candles[Math.min(exitIndex, candles.length - 1)] ?? candle;
    const exitReference = resolution.price ?? exitCandle.close;
    const simulated = simulatePhase8ShadowExecution({
      direction: selected.direction,
      entryQuote: candle,
      exitQuote: { ...exitCandle, bid: exitCandle.bid, ask: exitCandle.ask },
      entryReferencePrice: entryReference,
      exitReferencePrice: exitReference,
      currentPrice: exitReference,
      high: exitReference,
      low: exitReference,
      contracts: snapshot.riskPlan.contracts,
      targetContracts: snapshot.riskPlan.targetContracts,
      runnerContracts: snapshot.riskPlan.runnerContracts,
      target: resolution.status === "target" ? snapshot.riskPlan.target : null,
      strategyStop: resolution.status === "stop"
        ? resolution.stopLevel === "primary_level" ? resolution.price : snapshot.riskPlan.strategyStop
        : null,
       primaryLevelStop: resolution.status === "stop" && resolution.stopLevel === "primary_level"
         ? resolution.price
         : null,
      catastropheStop: resolution.status === "stop" && resolution.stopLevel !== "primary_level"
        ? snapshot.riskPlan.catastropheStop
        : null,
      specification,
      slippageMode: request.slippageMode,
      observedSpreadTicks: (candle.ask - candle.bid) / specification.tickSize,
    });
     const resolvedStop = resolution.status === "stop" || resolution.status === "ambiguous";
     const outcome = resolution.status === "target"
      ? "target"
       : resolvedStop
        ? snapshot.riskPlan.catastropheStop !== null ? "catastrophe stop" : "strategy stop"
        : "session close";
     const eventLabels = resolution.status === "target"
       ? ["TARGET_REACHED"]
       : resolvedStop
          ? [
            ...(resolution.stopLevel === "primary_level" ? [PRIMARY_LEVEL_EXIT_REACHED_LABEL] : ["STRATEGY_STOP_REACHED"]),
            ...(resolution.stopLevel !== "primary_level" && snapshot.riskPlan.catastropheStop !== null ? ["CATASTROPHE_STOP_REACHED"] : []),
            ...(resolution.status === "ambiguous" ? ["AMBIGUOUS_STOP_FIRST"] : []),
          ]
         : ["SESSION_CLOSE"];
     const ambiguityLabels = resolution.ambiguityLabel ? [resolution.ambiguityLabel] : [];
    const segment = segmentation(snapshot, selected.setupType, selected.direction, candle, currentContractSymbol, currentContractMonth);
    trades.push({
      id: `${tradingDate}-${index}-${selected.setupType}`,
      tradingDate,
      contractSymbol: currentContractSymbol,
      contractMonth: currentContractMonth,
      period,
      setupType: selected.setupType,
      direction: selected.direction,
      entryTime: new Date(candle.closeTime).toISOString(),
      exitTime: new Date(resolution.timestamp ?? exitCandle.closeTime).toISOString(),
      entryPrice: simulated.entryFillPrice,
      exitPrice: simulated.exitFillPrice ?? exitReference,
      contracts: simulated.contracts,
      grossPnl: simulated.accounting.grossPnl,
      fees: simulated.accounting.fees,
      slippage: simulated.accounting.slippage,
      netPnl: simulated.accounting.netPnl,
      outcome,
       ambiguityLabel: resolution.ambiguityLabel,
      source: resolution.source,
      segmentation: segment,
      executionMode,
      fillLabel: "Quote-based Shadow fill",
       audit: {
         entryTriggerPrice: entryReference,
         modeledFillPrice: simulated.entryFillPrice,
          stopPrice: resolution.price ?? snapshot.riskPlan.catastropheStop ?? snapshot.riskPlan.strategyStop,
         targetPrice: snapshot.riskPlan.target,
         strategyStopPrice: snapshot.riskPlan.strategyStop,
         catastropheStopPrice: snapshot.riskPlan.catastropheStop,
          stopLevel: resolvedStop
            ? resolution.stopLevel ?? (snapshot.riskPlan.catastropheStop !== null ? "catastrophe" : "strategy")
            : null,
          primaryLossExitLevel,
         patienceCandleOpenTime: null,
         patienceCandleCloseTime: null,
         triggerCandleOpenTime: new Date(candle.openTime).toISOString(),
         triggerCandleCloseTime: new Date(candle.closeTime).toISOString(),
         modeledFillObservationTime: null,
         exitCandleOpenTime: new Date(exitCandle.openTime).toISOString(),
         exitCandleCloseTime: new Date(exitCandle.closeTime).toISOString(),
          assumptions: [
            "Quote-based Shadow fill uses genuine bid/ask observations.",
            ...(primaryLossExitLevel
              ? [`Nearby ${primaryLossExitLevel.id} level retained as diagnostic evidence only; the frozen patience opposite-wick strategy stop remains authoritative.`]
              : []),
          ],
         eventLabels,
         ambiguityLabels,
         targetHit: resolution.status === "target",
         runnerActivated: false,
         runnerExited: false,
         runnerReferencePrice: null,
         runnerImpulse: null,
         runnerMostFavorablePrice: null,
         remainingQuantity: 0,
         exitReason: resolution.status === "ambiguous" ? "stop" : resolution.status,
         legs: [],
       },
    });
    lastExitIndex = Math.min(exitIndex, candles.length - 1);
  }
  markCompletedSessionBeforeIndex(candles.length);

  if (candles.length) {
    finalReplay = createCausalReplay(dataset, candles.at(-1)!.closeTime);
  }
  const reportFormulaHash = formulaConfigurationHash(request, activeStrategy.config);
  const signalOccurrences = buildHistoricalOccurrenceLedger(dataset, audit, trades, reportFormulaHash);
  const lifecycle = reduceHistoricalPullbackLifecycles(audit, undefined, signalOccurrences);
  const reconciliation = projectHistoricalTradeCandidates(signalOccurrences, trades, {
    dataset,
    specification,
    executionMode,
    lifecycle,
  });
  const authoritativeTrades = reconciliation.authoritativeTrades;
  const inSampleTrades = authoritativeTrades.filter((trade) => trade.period === "in_sample");
  const outOfSampleTrades = authoritativeTrades.filter((trade) => trade.period === "out_of_sample");
  const allMetrics = calculateBacktestMetrics(authoritativeTrades, rejectedByPeriod.in_sample + rejectedByPeriod.out_of_sample, audit);
  const occurrences = buildHistoricalOccurrenceLedger(dataset, audit, authoritativeTrades, reportFormulaHash);
  const diagnostics = historicalReplayDiagnostics(
    audit,
    occurrences,
    reconciliation.candidates,
    authoritativeTrades,
    reconciliation.rejected,
    reconciliation.orphans,
  );
  const executionSummary: BacktestExecutionSummary = {
    eligibleCandidateCount: reconciliation.candidates.length,
    enteredTradeCount: authoritativeTrades.length,
    finalizedTradeCount: authoritativeTrades.filter((trade) => trade.outcome !== "open").length,
    openTradeCount: authoritativeTrades.filter((trade) => trade.outcome === "open").length,
    ambiguousEntryCount: reconciliation.candidates.filter((candidate) => candidate.executionStatus === "ENTRY_AMBIGUOUS").length,
    unresolvedAmbiguousTradeCount: authoritativeTrades.filter((trade) => trade.ambiguityLabel !== null).length,
    conservativelyResolvedTradeCount: authoritativeTrades.filter((trade) => trade.ambiguityLabel !== null && trade.outcome !== "open").length,
    unscoredTradeCount: authoritativeTrades.filter((trade) => trade.outcome === "open" || trade.ambiguityLabel !== null).length,
  };
  return {
    mode: "SHADOW MODE — NO LIVE ORDERS",
    dataSource: dataset.source ?? "simulated",
    symbol: dataset.source === "historical_databento" || dataset.source === "historical_databento_multicontract"
      ? historicalContractSymbol
      : specification.rootSymbol,
    formulaHash: reportFormulaHash,
    contract: reportContract,
    dataResolution: dataset.ticks?.length ? "tick" : "one-minute-fallback",
    dataset: {
      startDate: dataset.inSampleDates[0],
      endDate: dataset.outOfSampleDates.at(-1) ?? dataset.inSampleDates.at(-1)!,
      requestedStartDate: dataset.requestedStartDate ?? request.startDate ?? dataset.inSampleDates[0],
      requestedEndDate: dataset.requestedEndDate ?? request.endDate,
      selectedDates: [...(dataset.selectedDates ?? [...dataset.inSampleDates, ...dataset.outOfSampleDates])],
      inSampleDates: [...dataset.inSampleDates],
      outOfSampleDates: [...dataset.outOfSampleDates],
      excludedDates: [...(dataset.excludedDates ?? [])],
      untouchedOutOfSample: true,
      optimizationApplied: false,
      scheduleVersion: dataset.contractSchedule?.version ?? null,
      rolloverBoundaries: dataset.contractSchedule?.boundaries
        ? [...dataset.contractSchedule.boundaries]
        : [],
      activeContractByDate: dataset.contractSchedule?.activeContractByDate
        ? [...dataset.contractSchedule.activeContractByDate]
        : [],
    },
    replay: {
      ...finalReplay,
      totalCandleCount: candles.length,
      causal: true,
      futureCandleAccess: false,
    },
    metrics: allMetrics,
    executionSummary,
    inSample: calculateBacktestMetrics(inSampleTrades, rejectedByPeriod.in_sample, audit.filter((record) => record.period === "in_sample")),
    outOfSample: calculateBacktestMetrics(outOfSampleTrades, rejectedByPeriod.out_of_sample, audit.filter((record) => record.period === "out_of_sample")),
    segments: buildSegments(authoritativeTrades, allMetrics.rejectedSetupCount),
    trades: authoritativeTrades,
    tradeCandidates: reconciliation.candidates,
    rejectedCandidateSignals: reconciliation.rejected,
    orphanModeledTrades: reconciliation.orphans,
    audit,
    occurrences,
    diagnostics,
    assumptions: [
      "Every strategy decision is recomputed from the visible candle prefix at that historical cursor.",
      "No current or future candle, indicator, volume value, level reaction, or setup state is available before its close time.",
      "Tick observations take precedence over one-minute bars; one-minute bars are the deterministic intrabar fallback.",
      "Unknown entry/invalidation order rejects the setup; unknown stop/target order applies stop first and is labeled AMBIGUOUS_STOP_FIRST.",
      "Each contract month keeps its own tick economics and fees; contract rollover boundaries are never blended.",
      "The out-of-sample dates are immutable holdout data and are not used for optimization.",
      `Historical replay uses exactly ${dataset.inSampleDates.length + dataset.outOfSampleDates.length} selected available trading dates; excluded dates are reported separately.`,
      ...(executionMode === "ohlcv_modeled"
        ? [
          MODELED_OHLCV_FILL_LABEL,
          "Only completed candles are visible. The entry uses the immediate next candle after the patience candle; later candles cannot trigger entry.",
          `Entry and exit slippage are ${modeledSlippageTicks} adverse tick${modeledSlippageTicks === 1 ? "" : "s"} per side.`,
          `The patience stop buffer is ${stopBufferTicks} ticks and the confirmation buffer is ${entryBufferTicks} ticks.`,
          "OHLCV barriers that share one candle are resolved adverse-first and labeled.",
          `Fees use the configurable ${commissionPerContract.toFixed(2)} per-contract round-trip assumption.`,
        ]
        : []),
      "This report is simulated futures analysis only. No live or paper order was created.",
    ],
    executionMode,
    fillLabel: executionMode === "ohlcv_modeled" ? MODELED_OHLCV_FILL_LABEL : "Quote-based Shadow fill",
    executionPolicy: {
      entryBufferTicks,
      immediateNextCandleOnly: true,
      entrySlippageTicks: executionMode === "ohlcv_modeled" ? modeledSlippageTicks : 1,
      exitSlippageTicks: executionMode === "ohlcv_modeled" ? modeledSlippageTicks : 1,
      stopRule: executionMode === "ohlcv_modeled"
        ? `${stopBufferTicks} ticks beyond the patience candle`
        : "Quote-based strategy and catastrophe stops",
      ambiguityRule: executionMode === "ohlcv_modeled"
        ? "Adverse-first when stop and target are both touched inside one OHLCV candle"
        : "Quote/tick order first; unresolved bars use stop-first",
      commissionPerContract,
    },
    gapReport: dataset.gapReport ?? {
      missingMinuteGaps: 0,
      missingGapSegments: 0,
      unexpectedMissingMinutes: 0,
      unexpectedOpenSessionMissingMinutes: 0,
      unexpectedOvernightMissingMinutes: 0,
      unexpectedRegularSessionMissingMinutes: 0,
      regularSessionGapSegments: 0,
      overnightGapSegments: 0,
      regularSessionMissingMinutes: 0,
      expectedClosedMarketMinutes: 0,
      expectedClosedMinutes: 0,
      weekendHolidayClosedMinutes: 0,
      earlyCloseMinutes: 0,
      inactiveContractMinutes: 0,
      lowLiquidityInactiveMinutes: 0,
      coverageScope: "selected_dates",
      inactiveContractThresholdPercent: 50,
      inactiveContractDays: 0,
      missingRegularSessionDates: [],
      missingOvernightSessionDates: [],
      completeRegularSessionDates: [],
      maintenanceGapMinutes: 0,
      weekendHolidayGapMinutes: 0,
      earlyCloseDates: [],
      overnightCoverageObserved: false,
    },
  };
}