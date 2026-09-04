import type { BreakoutEvent, FibonacciAnalysis, Phase4VolumeAnalysis, PullbackAnalysis } from "./phase4.js";
import type { MajorLevel } from "./major-levels.js";
import type { DynamiteLevel } from "./major-levels.js";
import type { SessionLevels } from "./levels.js";
import type { StrategyConfig } from "./config.js";
import { DEFAULT_STRATEGY_CONFIG } from "./config.js";
import type { Candle, Direction, Level, TrendDirection } from "./types.js";
import { canonicalStrategyId } from "./taxonomy.js";
import { hasConfirmedDirectionalTrend } from "./rules.js";
import {
  effectiveConfirmationThreshold,
  isStrictlyOutsideNtz,
  reachesEffectiveConfirmation,
  type PatienceAnalysis,
} from "./phase5.js";
import { wallClockMinutesForTimestamp } from "../futures/session-calendar.js";

export type SetupType =
  | "ORB_PULLBACK_CONTINUATION"
  | "CONSOLIDATION_BREAKOUT_CONTINUATION"
  | "PATIENCE_CANDLE_CONTINUATION"
  | "EQUIVALENT_CANDLE_REVERSAL"
  | "PEAK_RETRACEMENT_REVERSAL";

/** Accepted only at legacy input boundaries; new machine output never emits these IDs. */
export type LegacySetupType = "EXTENDED_NTZ_CONSOLIDATION_BREAKOUT" | "BONUS_REVERSAL";

export type Phase6Decision =
  | "NO TRADE"
  | "WAITING"
  | "SETUP FORMING"
  | "SETUP QUALIFIED"
  | "POSSIBLE REVERSAL"
  | "EXPIRED"
  | "AMBIGUOUS";

export type SetupRuleEvidence = {
  key: string;
  label: string;
  passed: boolean;
  mandatory: boolean;
  detail: string;
};

export type ReversalEvidence = {
  reversalDirection?: Direction | null;
  directionalConfirmation?: boolean;
  dojiAtMajorLevel: boolean;
  equivalentOpposingCandles: boolean;
  failedBreakout: boolean;
  deepFibonacciRetracement: boolean;
  majorLevelRejection: boolean;
  structureBreak: boolean;
  alert: boolean;
  detail: string;
};

export type ExtendedConsolidation = {
  detected: boolean;
  candleCount: number;
  durationMinutes: number;
  insideOrNearCount: number;
  range: number | null;
  expansionRatio: number | null;
  causalVolatilityBaseline: number | null;
  compressionRatio: number | null;
  overlapRatio: number | null;
  highRejectionCount: number;
  lowRejectionCount: number;
  maxDirectionalSequence: number;
  diagnosticRangeCapExceeded: boolean;
  startTime: number | null;
  endTime: number | null;
  frozenHigh?: number | null;
  frozenLow?: number | null;
  qualificationReason: string | null;
  detail: string;
};

export const CONSOLIDATION_ENTRY_GUARD_VERSION = "phase6-consolidation-entry-guard-v4";

export type ConsolidationLifecycleState =
  | "CONSOLIDATION_ZONE_FROZEN"
  | "PATIENCE_INSIDE_CONSOLIDATION"
  | "CONSOLIDATION_BREAKOUT_CONFIRMED"
  | "CONSOLIDATION_BREAKOUT_CLOSE_NOT_CONFIRMED"
  | "PATIENCE_EXPIRED_INSIDE_CONSOLIDATION"
  | "BREAKOUT_PULLBACK_PATIENCE_CONFIRMED";

/**
 * Causal evidence for the consolidation entry guard. Timestamps are epoch
 * milliseconds here and are converted to API timestamps at the replay edge.
 */
export type ConsolidationEntryEvidence = {
  detectorVersion: string;
  lifecycleState: ConsolidationLifecycleState | null;
  lifecycleStates: ConsolidationLifecycleState[];
  zoneDetected: boolean;
  activeZone: boolean;
  executionEligible: boolean;
  consolidationZoneHigh: number | null;
  consolidationZoneLow: number | null;
  activeConsolidationZoneId: string | null;
  consolidationStartTime: number | null;
  consolidationDetectionTime: number | null;
  sourceCandleOpenTimes: number[];
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
  patienceOpenTime: number | null;
  patienceCloseTime: number | null;
  entryOpenTime: number | null;
  entryCloseTime: number | null;
  confirmationThreshold: number | null;
  patienceConfirmationThreshold: number | null;
  consolidationBoundaryThreshold: number | null;
  effectiveEntryThreshold: number | null;
  entryClose: number | null;
  entryCompleted: boolean;
  entryReachedConfirmation: boolean | null;
  effectiveEntryThresholdReached: boolean | null;
  entryOpenedOutsideZone: boolean | null;
  entryClosedOutsideZone: boolean | null;
  entryCloseOutsideZone: boolean | null;
  entryRangeOutsideZone: boolean | null;
  entryRangeOverlappedZone: boolean | null;
  entryFillOutsideZone: boolean | null;
  entryOutsideFinalizedNtz: boolean | null;
  entryBeforeCutoff: boolean | null;
  consolidationEdgeQualified: boolean;
  breakoutPullback: boolean;
  consolidationEntryDisposition: string;
  rejectionReason: string | null;
  detail: string;
};

export type SetupEvaluation = {
  setupType: SetupType | LegacySetupType;
  direction: Direction | null;
  decision: Phase6Decision;
  mandatoryPassed: boolean;
  alertOnly: boolean;
  rules: SetupRuleEvidence[];
  reversalEvidence: ReversalEvidence | null;
  consolidation: ExtendedConsolidation | null;
  explanation: string;
  grade?: number;
  dynamiteConfluenceCount?: number;
  supportingConfluences?: string[];
};

export type Phase6Analysis = {
  decision: Phase6Decision;
  primarySetup: SetupType | null;
  evaluations: SetupEvaluation[];
  explanation: string;
};

type ConsolidationMetrics = {
  high: number;
  low: number;
  range: number;
  rangeTicks: number;
  causalVolatilityBaseline: number | null;
  compressionRatio: number | null;
  overlapRatio: number;
  highRejectionCount: number;
  lowRejectionCount: number;
  maxDirectionalSequence: number;
  expansionRatio: number | null;
};

export type Phase6Context = {
  candles: readonly Candle[];
  levels: SessionLevels;
  breakout: BreakoutEvent;
  pullback: PullbackAnalysis;
  fibonacci: FibonacciAnalysis;
  volume: Phase4VolumeAnalysis;
  patience: PatienceAnalysis;
  reversalPatience?: PatienceAnalysis;
  trend: {
    direction: TrendDirection;
    structure: string;
    score?: number;
    candleCount?: number;
    evidenceItems?: Array<{ key: "structure" | "vwap" | "ema" | "emaSlope"; status: "positive" | "negative" | "neutral" }>;
  };
  riskApproved: boolean;
  config: StrategyConfig;
  dynamiteLevels?: readonly DynamiteLevel[];
};

function dynamiteInteractionMatchesSignal(
  interaction: DynamiteLevel["pullbackInteractions"][number],
  level: DynamiteLevel,
  patience: PatienceAnalysis,
  pullback: PullbackAnalysis,
  direction: Direction | null,
): boolean {
  const patienceCandle = patience.patienceCandle;
  if (!patienceCandle || !patience.eligible || !level.pullbackInteracted) return false;
  if (direction && interaction.direction && interaction.direction !== direction) return false;
  if (interaction.pCandleOpenTime != null && interaction.pCandleOpenTime !== patienceCandle.openTime) return false;
  if (interaction.eCandleOpenTime != null) {
    if (!patience.triggerCandle || interaction.eCandleOpenTime !== patience.triggerCandle.openTime) return false;
  }
  if (interaction.eligibilityArmId
    && patience.eligibilityArmId
    && interaction.eligibilityArmId !== patience.eligibilityArmId) return false;

  const provenanceEventId = patience.eligibilityProvenance?.eventId;
  if (provenanceEventId && interaction.eventId) {
    return interaction.eventId === provenanceEventId;
  }

  const levelEvent = pullback.events.find((event) =>
    (interaction.eventId && event.eventId === interaction.eventId)
    || (event.candle?.openTime ?? event.time) === interaction.lCandleOpenTime
    || (event.candle?.openTime ?? event.time) === interaction.candleOpenTime,
  );
  const lCandleOpenTime = patience.eligibilityProvenance?.lCandleOpenTime
    ?? (levelEvent ? levelEvent.candle?.openTime ?? levelEvent.time : null);
  if (lCandleOpenTime == null) return false;
  if (interaction.lCandleOpenTime != null && interaction.lCandleOpenTime !== lCandleOpenTime) return false;
  return interaction.candleOpenTime === lCandleOpenTime;
}

export function phase6Analysis(context: Phase6Context): Phase6Analysis {
  const evaluations = [
    evaluateOrbBreakPullbackContinuation(context),
    evaluateStrongBreakoutAfterConsolidation(context),
    evaluatePatienceCandleContinuation(context),
    evaluateEquivalentCandleReversal(context),
    evaluatePeakRetracementReversal(context),
  ].map((evaluation) => {
    const signalPatience = ["EQUIVALENT_CANDLE_REVERSAL", "PEAK_RETRACEMENT_REVERSAL"].includes(evaluation.setupType)
      ? context.reversalPatience
      : context.patience;
    const signalDynamite = evaluation.decision === "SETUP QUALIFIED"
      ? context.dynamiteLevels?.filter((level) =>
        level.pullbackInteracted
        && signalPatience?.patienceCandle
        && (evaluation.direction === signalPatience.direction || !evaluation.direction)
        && level.pullbackInteractions.some((interaction) =>
          dynamiteInteractionMatchesSignal(interaction, level, signalPatience, context.pullback, evaluation.direction),
        ),
      ) ?? []
      : [];
    const dynamiteConfluenceCount = signalDynamite.reduce((max, level) => Math.max(max, level.confluenceCount), 0);
    const supportingConfluences = [
      ...(evaluation.supportingConfluences ?? []),
      ...signalDynamite.map((level) => `Dynamite ${level.id}: ${level.sourceFamilies.join(", ")}`),
    ];
    return {
      ...evaluation,
      dynamiteConfluenceCount,
      grade: (evaluation.grade ?? 0) + (dynamiteConfluenceCount > 0 ? 1 : 0),
      supportingConfluences: [...new Set(supportingConfluences)],
    };
  });
  const attributionOrder: SetupType[] = [
    "ORB_PULLBACK_CONTINUATION",
    "CONSOLIDATION_BREAKOUT_CONTINUATION",
    "EQUIVALENT_CANDLE_REVERSAL",
    "PEAK_RETRACEMENT_REVERSAL",
    "PATIENCE_CANDLE_CONTINUATION",
  ];
  const qualified = attributionOrder
    .map((setupType) => evaluations.find((evaluation) => evaluation.setupType === setupType && evaluation.decision === "SETUP QUALIFIED" && !evaluation.alertOnly))
    .find((evaluation) => evaluation !== undefined);
  const possibleReversal = evaluations.find((evaluation) => evaluation.decision === "POSSIBLE REVERSAL");
  const ambiguous = evaluations.find((evaluation) => evaluation.decision === "AMBIGUOUS");
  const expired = evaluations.find((evaluation) => evaluation.decision === "EXPIRED");
  const forming = evaluations.find((evaluation) => evaluation.decision === "SETUP FORMING");
  if (qualified) {
    const selected = qualified;
    return { decision: "SETUP QUALIFIED", primarySetup: canonicalStrategyId(selected.setupType), evaluations, explanation: `${selected.setupType} passed every mandatory rule. This is shadow analysis only.` };
  }
  if (possibleReversal) return { decision: "POSSIBLE REVERSAL", primarySetup: "EQUIVALENT_CANDLE_REVERSAL", evaluations, explanation: possibleReversal.explanation };
  if (ambiguous) return { decision: "AMBIGUOUS", primarySetup: canonicalStrategyId(ambiguous.setupType), evaluations, explanation: ambiguous.explanation };
  if (expired) return { decision: "EXPIRED", primarySetup: canonicalStrategyId(expired.setupType), evaluations, explanation: expired.explanation };
  if (forming) return { decision: "SETUP FORMING", primarySetup: canonicalStrategyId(forming.setupType), evaluations, explanation: forming.explanation };
  const hasContext = evaluations.some((evaluation) => evaluation.rules.some((rule) => rule.passed));
  return {
    decision: hasContext ? "WAITING" : "NO TRADE",
    primarySetup: null,
    evaluations,
    explanation: hasContext ? "Setup conditions are incomplete; wait for every mandatory rule." : "No complete setup context is available.",
  };
}

export function evaluateOrbBreakPullbackContinuation(context: Phase6Context): SetupEvaluation {
  const direction = context.breakout.direction;
  const levelInteraction = hasQualifyingPullback(context.pullback);
  const rules: SetupRuleEvidence[] = [
    rule("ntzComplete", "NTZ complete", context.levels.ntz?.complete === true, "A finalized NTZ/ORB range is required."),
    rule("closeOutsideNtz", "Completed candle closed outside NTZ", context.breakout.detected, context.breakout.detected ? context.breakout.detail : "Waiting for a completed close outside the finalized NTZ."),
    rule("levelContext", "Pullback candle reached a governed level or indicator zone", levelInteraction, levelInteraction ? "A completed pullback candle interacted with a governed level or indicator within the configured tolerance." : "A completed pullback candle must reach a governed level or indicator zone within the configured tolerance."),
    rule("validPatienceCandle", "Valid trend-aligned patience candle formed", context.patience.patienceCandle !== null && patienceDirectionMatches(context.patience, direction) && ["PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED", "ENTRY_TRIGGERED"].includes(context.patience.state), context.patience.detail),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", context.patience.state === "ENTRY_TRIGGERED", context.patience.state === "ENTRY_TRIGGERED" ? context.patience.detail : `Patience state is ${context.patience.state}; only ENTRY_TRIGGERED qualifies.`),
    rule("entryOutsideFinalizedNtz", "Entry candle confirmed strictly outside finalized NTZ", strictNtzEntry(context, context.patience, direction), strictNtzEntry(context, context.patience, direction) ? "Completed E is strictly outside the finalized NTZ/ORB." : "ENTRY_NOT_OUTSIDE_FINALIZED_NTZ."),
  ];
  return buildEvaluation("ORB_PULLBACK_CONTINUATION", direction, rules, false, context.patience.state);
}

export function evaluatePatienceCandleContinuation(context: Phase6Context): SetupEvaluation {
  const direction = directionFromTrend(context.trend.direction);
  const valid = context.patience.eligible && context.patience.patienceCandle !== null;
  const confirmedTrend = hasConfirmedTrend(context, direction);
  const rules = [
    rule("confirmedTrend", "Confirmed causal 15-minute directional trend", confirmedTrend, confirmedTrend ? "Confirmed causal trend evidence is available." : "TREND_DIRECTION_PRESENT_BUT_UNCONFIRMED."),
    rule("continuationContext", "Qualifying continuation context", hasQualifyingPullback(context.pullback), "A qualifying pullback to a machine-visible level is required."),
    rule("patienceEligible", "Patience candle is eligible", valid, context.patience.detail),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", context.patience.state === "ENTRY_TRIGGERED", context.patience.detail),
    rule("entryOutsideFinalizedNtz", "Entry candle confirmed strictly outside finalized NTZ", strictNtzEntry(context, context.patience, direction), strictNtzEntry(context, context.patience, direction) ? "Completed E is strictly outside the finalized NTZ/ORB." : "ENTRY_NOT_OUTSIDE_FINALIZED_NTZ."),
  ];
  return buildEvaluation("PATIENCE_CANDLE_CONTINUATION", direction, rules, false, context.patience.state);
}

export function evaluateStrongBreakoutAfterConsolidation(context: Phase6Context): SetupEvaluation {
  const consolidation = detectExtendedNtzConsolidation(
    context.candles,
    context.levels.ntz,
    context.config.phase6ConsolidationExpansionRatio,
    context.breakout.candleOpenTime ?? context.breakout.time,
    context.config.phase6ConsolidationMaxRangeTicks,
    context.config.phase6ConsolidationMinCandles,
    context.config.phase6ConsolidationVolatilityLookback,
    context.config.phase6ConsolidationVolatilityMultiplier,
    context.config.phase6ConsolidationMinOverlapRatio,
    context.config.phase6ConsolidationMinRejectionCount,
    context.config.phase6ConsolidationMaxDirectionalSequence,
  );
  const direction = context.breakout.direction ?? directionFromTrend(context.trend.direction);
  const breakoutCandle = completedCandles(context.candles).find((candle) => candle.openTime === context.breakout.candleOpenTime);
  const breakoutOutsideFrozenRange = breakoutCandle !== undefined && consolidation.frozenHigh !== null && consolidation.frozenLow !== null
    && (direction === "long" ? breakoutCandle.close > consolidation.frozenHigh! : breakoutCandle.close < consolidation.frozenLow!);
  const breakoutConfirmed = context.breakout.detected && !context.breakout.failed && context.breakout.continuationConfirmed && breakoutOutsideFrozenRange;
  const postBreakoutContext = hasQualifyingPullback(context.pullback)
    || (consolidation.detected && context.patience.eligibilityReason === "ntz consolidation");
  const patienceNearLevel = context.patience.patienceCandle !== null
    && context.patience.eligible
    && postBreakoutContext;
  const rules: SetupRuleEvidence[] = [
    rule("extendedConsolidation", "Tight/stable price consolidation", consolidation.detected, consolidation.detail),
    rule("rangeStable", "Consolidation range did not materially expand", consolidation.detected && consolidation.expansionRatio !== null && consolidation.expansionRatio <= context.config.phase6ConsolidationExpansionRatio, consolidation.detected ? `Consolidation expansion ratio ${formatRatio(consolidation.expansionRatio)}; maximum allowed is ${context.config.phase6ConsolidationExpansionRatio.toFixed(2)}×.` : "The required extended consolidation window is not complete."),
    rule("strongBreakout", "Strong directional breakout outside frozen consolidation", breakoutConfirmed && direction !== null && context.breakout.volumeSupported && (context.breakout.bodyRatio ?? 0) >= context.config.phase4StrongBodyRatio && (context.breakout.closeLocationRatio ?? 0) >= context.config.phase4StrongCloseLocationRatio, "Strong breakout evidence must close outside the frozen consolidation range."),
    rule("postBreakoutContext", "Post-breakout pullback or consolidation context", postBreakoutContext, postBreakoutContext ? "A qualifying pullback or post-breakout consolidation context is recorded." : "The strong breakout must be followed by a qualifying pullback or valid post-breakout consolidation."),
    rule("validPatienceNearLevel", "Valid trend-aligned patience candle formed", patienceNearLevel && patienceDirectionMatches(context.patience, direction) && ["PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED", "ENTRY_TRIGGERED"].includes(context.patience.state), patienceNearLevel ? context.patience.detail : "Patience must be eligible from the post-breakout context."),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", context.patience.state === "ENTRY_TRIGGERED", context.patience.state === "ENTRY_TRIGGERED" ? context.patience.detail : `Patience state is ${context.patience.state}; only ENTRY_TRIGGERED qualifies.`),
    rule("entryOutsideFinalizedNtz", "Entry candle confirmed strictly outside finalized NTZ", strictNtzEntry(context, context.patience, direction), strictNtzEntry(context, context.patience, direction) ? "Completed E is strictly outside the finalized NTZ/ORB." : "ENTRY_NOT_OUTSIDE_FINALIZED_NTZ."),
    rule("breakoutVolume", "Breakout volume supports the move", context.breakout.volumeSupported || context.volume.supportingBreakoutVolume, context.breakout.volumeSupported || context.volume.supportingBreakoutVolume ? "Breakout volume meets the configured support threshold." : "Breakout volume support is not confirmed."),
  ];
  return buildEvaluation("CONSOLIDATION_BREAKOUT_CONTINUATION", direction, rules, false, context.patience.state, consolidation);
}

export const evaluateExtendedNtzConsolidationBreakout = evaluateStrongBreakoutAfterConsolidation;

export function evaluateEquivalentCandleReversal(context: Phase6Context): SetupEvaluation {
  const completed = completedCandles(context.candles);
  const latest = completed.at(-1);
  const evidence = detectReversalEvidence(context, completed, latest);
  const reversalDirection = evidence.reversalDirection ?? null;
  const patience = context.reversalPatience ?? context.patience;
  const rules: SetupRuleEvidence[] = [
    rule("equivalentContext", "Equivalent opposing candles at a qualifying level", evidence.equivalentOpposingCandles, evidence.equivalentOpposingCandles ? "Equivalent opposing full-body candles meet the configured level and wick tolerances." : "Equivalent opposing candles at a qualifying level are required."),
    rule("directionalConfirmation", "Directional reversal confirmation", evidence.directionalConfirmation === true, evidence.directionalConfirmation ? "A completed opposing candle structure confirms the reversal direction." : "A reversed direction label is not sufficient; completed opposing-candle evidence must confirm it."),
    rule("validPatienceCandle", "Valid trend-aligned patience candle formed", patience.patienceCandle !== null && patienceDirectionMatches(patience, reversalDirection) && ["PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED", "ENTRY_TRIGGERED"].includes(patience.state), patience.detail),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", patience.state === "ENTRY_TRIGGERED", patience.state === "ENTRY_TRIGGERED" ? patience.detail : `Patience state is ${patience.state}; only ENTRY_TRIGGERED qualifies.`),
    rule("entryOutsideFinalizedNtz", "Entry candle confirmed strictly outside finalized NTZ", strictNtzEntry(context, patience, reversalDirection), strictNtzEntry(context, patience, reversalDirection) ? "Completed E is strictly outside the finalized NTZ/ORB." : "ENTRY_NOT_OUTSIDE_FINALIZED_NTZ."),
  ];
  const mandatoryPassed = rules.every((item) => item.passed);
  const decision = !evidence.alert
    ? "NO TRADE"
    : patience.state === "AMBIGUOUS_EVENT_ORDER"
      ? "AMBIGUOUS"
      : patience.state === "PATIENCE_CANDLE_EXPIRED"
        ? "EXPIRED"
        : mandatoryPassed ? "SETUP QUALIFIED" : "POSSIBLE REVERSAL";
  return {
    setupType: "EQUIVALENT_CANDLE_REVERSAL",
    direction: reversalDirection,
    decision,
    mandatoryPassed,
    alertOnly: false,
    rules: [...evidenceRules(evidence), ...rules],
    reversalEvidence: evidence,
    consolidation: null,
    explanation: decision === "SETUP QUALIFIED"
      ? "Bonus reversal evidence and every mandatory confirmation passed. Alert only; no order was created."
      : evidence.alert
        ? `Possible reversal: ${evidence.detail} Mandatory confirmation remains incomplete.`
        : "No reversal evidence currently meets the configured detection defaults.",
    grade: 0,
    dynamiteConfluenceCount: 0,
  };
}

export const evaluateBonusReversal = evaluateEquivalentCandleReversal;

export function evaluatePeakRetracementReversal(context: Phase6Context): SetupEvaluation {
  const patience = context.reversalPatience ?? context.patience;
  const direction: Direction | null = context.fibonacci.direction === "bullish"
    ? "short"
    : context.fibonacci.direction === "bearish"
      ? "long"
      : null;
  const retracement = context.fibonacci.retracementPercent;
  const deepRetracement = retracement !== null && retracement > 50;
  const rules: SetupRuleEvidence[] = [
    rule("peakRetracement", "Deep retracement reversal evidence", deepRetracement, deepRetracement
      ? `Causal retracement is ${retracement}%.`
      : "A causal intraday impulse retracement greater than 50% is required."),
    rule("reversalDirection", "Reversal direction established", direction !== null, direction ? `Reversal direction is ${direction}.` : "A reversal direction is not established."),
    rule("validPatienceCandle", "Valid reversal patience candle formed", patience.patienceCandle !== null && patience.direction === direction && ["PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED", "ENTRY_TRIGGERED"].includes(patience.state), patience.detail),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", patience.state === "ENTRY_TRIGGERED", patience.detail),
    rule("entryOutsideFinalizedNtz", "Entry candle confirmed strictly outside finalized NTZ", strictNtzEntry(context, patience, direction), strictNtzEntry(context, patience, direction) ? "Completed E is strictly outside the finalized NTZ/ORB." : "ENTRY_NOT_OUTSIDE_FINALIZED_NTZ."),
  ];
  return buildEvaluation("PEAK_RETRACEMENT_REVERSAL", direction, rules, false, patience.state);
}

export function detectReversalEvidence(
  context: Phase6Context,
  completed: readonly Candle[] = completedCandles(context.candles),
  latest = completed.at(-1),
): ReversalEvidence {
  const dojiAtMajorLevel = latest !== undefined && isDoji(latest, context.config.dojiBodyRatio) && nearMajorLevel(latest, context.levels.majorLevels, context.config);
  const equivalentOpposingCandles = hasEquivalentOpposingCandles(completed, context.levels.majorLevels, context.config);
  const failedBreakout = context.levels.ntzEvents.some((event) => event.type === "Failed breakout");
  const deepFibonacciRetracement = ["deep", "elevated failure risk", "fully retraced"].includes(context.fibonacci.classification);
  const majorLevelRejection = latest !== undefined && hasMajorLevelRejection(latest, context.levels.majorLevels, context.config);
  const structureBreak = hasStructureBreak(completed, context.trend.direction);
  const reversalDirection = confirmedReversalDirection(context, completed, equivalentOpposingCandles, failedBreakout, structureBreak, majorLevelRejection);
  const directionalConfirmation = reversalDirection !== null && (
    equivalentOpposingCandles
    || failedBreakout
    || majorLevelRejection
    || structureBreak
  );
  const signals = [
    dojiAtMajorLevel,
    equivalentOpposingCandles,
    failedBreakout,
    deepFibonacciRetracement,
    majorLevelRejection,
    structureBreak,
  ];
  const names = [
    ["doji at major level", dojiAtMajorLevel],
    ["equivalent opposing candles", equivalentOpposingCandles],
    ["failed breakout", failedBreakout],
    ["deep Fibonacci retracement", deepFibonacciRetracement],
    ["major-level rejection", majorLevelRejection],
    ["structure break", structureBreak],
  ].filter(([, passed]) => passed).map(([name]) => name);
  return {
    reversalDirection,
    directionalConfirmation,
    dojiAtMajorLevel,
    equivalentOpposingCandles,
    failedBreakout,
    deepFibonacciRetracement,
    majorLevelRejection,
    structureBreak,
    alert: signals.some(Boolean),
    detail: names.length ? `Detected: ${names.join(", ")}.` : "No bonus reversal evidence detected.",
  };
}

export function detectExtendedNtzConsolidation(
  candles: readonly Candle[],
  ntz: SessionLevels["ntz"],
  expansionLimit = DEFAULT_STRATEGY_CONFIG.phase6ConsolidationExpansionRatio,
  breakoutTime: number | null = null,
  maxRangeTicks = DEFAULT_STRATEGY_CONFIG.phase6ConsolidationMaxRangeTicks,
  minimumCandles = DEFAULT_STRATEGY_CONFIG.phase6ConsolidationMinCandles,
  volatilityLookback = DEFAULT_STRATEGY_CONFIG.phase6ConsolidationVolatilityLookback,
  volatilityMultiplier = DEFAULT_STRATEGY_CONFIG.phase6ConsolidationVolatilityMultiplier,
  minOverlapRatio = DEFAULT_STRATEGY_CONFIG.phase6ConsolidationMinOverlapRatio,
  minRejectionCount = DEFAULT_STRATEGY_CONFIG.phase6ConsolidationMinRejectionCount,
  maxDirectionalSequence = DEFAULT_STRATEGY_CONFIG.phase6ConsolidationMaxDirectionalSequence,
): ExtendedConsolidation {
  const completed = completedCandles(candles)
    .filter(isCompletedFiveMinuteCandle)
    .filter((candle) => breakoutTime === null || candle.closeTime <= breakoutTime);
  const minimumCount = Math.max(DEFAULT_STRATEGY_CONFIG.phase6ConsolidationMinCandles, Math.floor(minimumCandles));
  if (completed.length < minimumCount) return emptyConsolidation(`At least ${minimumCount} contiguous completed candles are required.`);
  const candidates: ExtendedConsolidation[] = [];
  for (let count = minimumCount; count <= completed.length; count += 1) {
    const window = completed.slice(-count);
    if (!isContiguous(window)) break;
    const preceding = completed.slice(0, completed.length - count).slice(-Math.max(1, Math.floor(volatilityLookback)));
    const metrics = consolidationMetrics(window, preceding);
    if (
      preceding.length < Math.max(1, Math.floor(volatilityLookback))
      || metrics.causalVolatilityBaseline === null
      || metrics.compressionRatio === null
      || metrics.compressionRatio > volatilityMultiplier
      || metrics.overlapRatio < minOverlapRatio
      || metrics.highRejectionCount + metrics.lowRejectionCount < minRejectionCount
      || metrics.maxDirectionalSequence > maxDirectionalSequence
      || metrics.expansionRatio === null
      || metrics.expansionRatio > expansionLimit
    ) continue;
    const insideOrNear = ntz?.complete ? window.filter((candle) => candle.close >= ntz.low && candle.close <= ntz.high).length : 0;
    candidates.push({
      detected: true, candleCount: count,
      durationMinutes: Math.round((window.at(-1)!.closeTime - window[0]!.openTime) / 60_000),
      insideOrNearCount: insideOrNear,
      range: metrics.range,
      expansionRatio: metrics.expansionRatio,
      causalVolatilityBaseline: metrics.causalVolatilityBaseline,
      compressionRatio: metrics.compressionRatio,
      overlapRatio: metrics.overlapRatio,
      highRejectionCount: metrics.highRejectionCount,
      lowRejectionCount: metrics.lowRejectionCount,
      maxDirectionalSequence: metrics.maxDirectionalSequence,
      diagnosticRangeCapExceeded: metrics.rangeTicks > maxRangeTicks,
      startTime: window[0]!.openTime, endTime: window.at(-1)!.closeTime,
      frozenHigh: metrics.high,
      frozenLow: metrics.low,
      qualificationReason: `Qualified: ${count} completed contiguous five-minute candles; width ${metrics.range!.toFixed(2)} points (${metrics.rangeTicks.toFixed(2)} ticks) is ${metrics.compressionRatio!.toFixed(2)}× the causal median true-range baseline of ${metrics.causalVolatilityBaseline!.toFixed(2)} points (limit ${volatilityMultiplier.toFixed(2)}×); shared candle-range overlap is ${(metrics.overlapRatio * 100).toFixed(0)}%; repeated rejection counts are high ${metrics.highRejectionCount} / low ${metrics.lowRejectionCount}; maximum directional new-high/new-low sequence is ${metrics.maxDirectionalSequence}; range expansion is ${formatRatio(metrics.expansionRatio)} (limit ${expansionLimit.toFixed(2)}×).`,
      detail: `Consolidation qualified. ${count} contiguous completed five-minute candles (${Math.round((window.at(-1)!.closeTime - window[0]!.openTime) / 60_000)} minutes); ${metrics.range!.toFixed(2)} points (${metrics.rangeTicks.toFixed(2)} ticks) versus ${metrics.causalVolatilityBaseline!.toFixed(2)} point causal volatility baseline, ${metrics.overlapRatio.toFixed(2)} overlap ratio, ${metrics.highRejectionCount + metrics.lowRejectionCount} repeated edge rejections, and ${metrics.maxDirectionalSequence}-candle maximum directional sequence. The legacy ${maxRangeTicks}-tick value is diagnostic only${metrics.rangeTicks > maxRangeTicks ? " and was exceeded" : ""}; NTZ proximity is diagnostic confluence only (${insideOrNear}/${count} closes).`,
    });
  }
  const best = candidates.at(-1);
  if (best) return best;
  const window = completed.slice(-Math.min(minimumCount, completed.length));
  const preceding = completed.slice(0, completed.length - window.length).slice(-Math.max(1, Math.floor(volatilityLookback)));
  const metrics = consolidationMetrics(window, preceding);
  const failureReasons = [
    preceding.length < Math.max(1, Math.floor(volatilityLookback))
      || metrics.causalVolatilityBaseline === null
      ? `fewer than ${Math.max(1, Math.floor(volatilityLookback))} preceding completed candles for a causal baseline`
      : null,
    metrics.compressionRatio !== null && metrics.compressionRatio > volatilityMultiplier ? `compression ratio ${formatRatio(metrics.compressionRatio)} exceeds ${volatilityMultiplier.toFixed(2)}×` : null,
    metrics.overlapRatio < minOverlapRatio ? `overlap ratio ${metrics.overlapRatio.toFixed(2)} is below ${minOverlapRatio.toFixed(2)}` : null,
    metrics.highRejectionCount + metrics.lowRejectionCount < minRejectionCount ? `only ${metrics.highRejectionCount + metrics.lowRejectionCount} repeated edge rejections are present` : null,
    metrics.maxDirectionalSequence > maxDirectionalSequence ? `directional sequence reaches ${metrics.maxDirectionalSequence} candles` : null,
    metrics.expansionRatio !== null && metrics.expansionRatio > expansionLimit ? `expansion ratio ${formatRatio(metrics.expansionRatio)} exceeds ${expansionLimit.toFixed(2)}×` : null,
  ].filter((reason): reason is string => reason !== null);
  return {
    detected: false, candleCount: window.length,
    durationMinutes: Math.round((window.at(-1)!.closeTime - window[0]!.openTime) / 60_000),
    insideOrNearCount: ntz?.complete ? window.filter((candle) => candle.close >= ntz.low && candle.close <= ntz.high).length : 0,
    range: metrics.range,
    expansionRatio: metrics.expansionRatio,
    causalVolatilityBaseline: metrics.causalVolatilityBaseline,
    compressionRatio: metrics.compressionRatio,
    overlapRatio: metrics.overlapRatio,
    highRejectionCount: metrics.highRejectionCount,
    lowRejectionCount: metrics.lowRejectionCount,
    maxDirectionalSequence: metrics.maxDirectionalSequence,
    diagnosticRangeCapExceeded: metrics.rangeTicks > maxRangeTicks,
    startTime: window[0]!.openTime,
    endTime: window.at(-1)!.closeTime,
    frozenHigh: metrics.high,
    frozenLow: metrics.low,
    qualificationReason: null,
    detail: `No causal volatility-adjusted consolidation: ${failureReasons.join("; ") || "the completed window did not satisfy all governed structural criteria"}. Observed ${window.length} candles span ${metrics.range.toFixed(2)} points with expansion ratio ${formatRatio(metrics.expansionRatio)}; the legacy ${maxRangeTicks}-tick value is diagnostic only.`,
  };
}

export function evaluateConsolidationEntryGuard(input: {
  candles: readonly Candle[];
  levels: Pick<Phase6Context["levels"], "ntz">;
  patience: Pick<PatienceAnalysis, "patienceCandle" | "triggerCandle" | "entryBufferTicks" | "entryBufferPrice"> | null;
  direction: Direction | null;
  breakout?: Pick<BreakoutEvent, "detected" | "direction" | "candleOpenTime" | "continuationConfirmed" | "failed"> | null;
  config: StrategyConfig;
  consolidationEvaluation?: Pick<SetupEvaluation, "setupType" | "decision"> | null;
  qualifyingPullback?: boolean;
  entryFillPrice?: number | null;
}): ConsolidationEntryEvidence | null {
  const completed = completedCandles(input.candles);
  const patienceCandle = input.patience?.patienceCandle;
  const breakoutCandle = input.breakout?.candleOpenTime === null || input.breakout?.candleOpenTime === undefined
    ? undefined
    : completed.find((candle) => candle.openTime === input.breakout!.candleOpenTime);
  const breakoutIsBeforePatience = breakoutCandle !== undefined
    && patienceCandle !== null
    && patienceCandle !== undefined
    && breakoutCandle.closeTime <= patienceCandle.openTime;
  const detectionCandles = breakoutIsBeforePatience
    ? completed.filter((candle) => candle.closeTime <= breakoutCandle!.openTime)
    : completed.filter((candle) => patienceCandle
      ? candle.closeTime <= patienceCandle.openTime
      : candle.closeTime <= (completed.at(-1)?.closeTime ?? Number.NEGATIVE_INFINITY));
  const frozen = detectExtendedNtzConsolidation(
    detectionCandles,
    input.levels.ntz,
    input.config.phase6ConsolidationExpansionRatio,
    null,
    input.config.phase6ConsolidationMaxRangeTicks,
    input.config.phase6ConsolidationMinCandles,
    input.config.phase6ConsolidationVolatilityLookback,
    input.config.phase6ConsolidationVolatilityMultiplier,
    input.config.phase6ConsolidationMinOverlapRatio,
    input.config.phase6ConsolidationMinRejectionCount,
    input.config.phase6ConsolidationMaxDirectionalSequence,
  );
  if (
    !frozen.detected
    || typeof frozen.frozenHigh !== "number"
    || typeof frozen.frozenLow !== "number"
  ) return null;

  const sourceCandleOpenTimes = completed
    .filter((candle) =>
      frozen.startTime !== null
      && frozen.endTime !== null
      && candle.openTime >= frozen.startTime
      && candle.closeTime <= frozen.endTime
      && candle.closeTime <= (frozen.endTime ?? Number.POSITIVE_INFINITY),
    )
    .map((candle) => candle.openTime);
  const zoneHigh = frozen.frozenHigh;
  const zoneLow = frozen.frozenLow;
  const direction = input.direction;
  const activeConsolidationZoneId = [
    CONSOLIDATION_ENTRY_GUARD_VERSION,
    frozen.startTime ?? "unknown",
    frozen.endTime ?? "unknown",
    zoneLow,
    zoneHigh,
  ].join("|");
  const pInside = patienceCandle !== null
    && patienceCandle !== undefined
    && patienceCandle.high <= zoneHigh
    && patienceCandle.low >= zoneLow;
  const consolidationEdgeQualified = input.consolidationEvaluation?.setupType === "CONSOLIDATION_BREAKOUT_CONTINUATION"
    && input.consolidationEvaluation.decision === "SETUP QUALIFIED";
  const entry = input.patience?.triggerCandle;
  const entryIsImmediate = Boolean(
    patienceCandle
    && entry
    && entry.openTime === patienceCandle.closeTime,
  );
  const confirmationThreshold = direction && patienceCandle
    ? input.patience?.entryBufferPrice
      ?? effectiveConfirmationThreshold(
        patienceCandle,
        direction,
        input.patience?.entryBufferTicks ?? 8,
        0.25,
        input.levels.ntz,
      )
    : null;
  const patienceConfirmationThreshold = confirmationThreshold;
  const consolidationBoundaryThreshold = direction === "long"
    ? zoneHigh + 0.25
    : direction === "short"
      ? zoneLow - 0.25
      : null;
  const effectiveEntryThreshold = direction && patienceConfirmationThreshold !== null && consolidationBoundaryThreshold !== null
    ? Number((
      direction === "long"
        ? Math.max(patienceConfirmationThreshold, consolidationBoundaryThreshold)
        : Math.min(patienceConfirmationThreshold, consolidationBoundaryThreshold)
    ).toFixed(10))
    : null;
  const effectiveEntryThresholdReached = direction && entry && effectiveEntryThreshold !== null
    ? reachesEffectiveConfirmation(entry, direction, effectiveEntryThreshold)
      || (direction === "long" ? entry.open >= effectiveEntryThreshold : entry.open <= effectiveEntryThreshold)
    : null;
  const entryOpenedOutsideZone = direction && entry
    ? direction === "long" ? entry.open > zoneHigh : entry.open < zoneLow
    : null;
  const entryClosedOutsideZone = direction && entry
    ? entry.isComplete
      ? direction === "long" ? entry.close > zoneHigh : entry.close < zoneLow
      : null
    : null;
  const entryCloseOutsideZone = entryClosedOutsideZone;
  const entryRangeOutsideZone = direction && entry
    ? direction === "long" ? entry.low > zoneHigh : entry.high < zoneLow
    : null;
  const entryRangeOverlappedZone = entry
    ? entry.low <= zoneHigh && entry.high >= zoneLow
    : null;
  const entryOutsideFinalizedNtz = direction && entry && entry.isComplete && effectiveEntryThreshold !== null
    ? isStrictlyOutsideNtz(entry, direction, input.levels.ntz, true, effectiveEntryThreshold)
    : entry ? false : null;
  const entryFillPrice = input.entryFillPrice ?? effectiveEntryThreshold;
  const entryFillOutsideZone = direction && entryFillPrice !== null
    ? direction === "long" ? entryFillPrice > zoneHigh : entryFillPrice < zoneLow
    : null;
  const entryReachedConfirmation = effectiveEntryThresholdReached;
  const entryBeforeCutoff = entry
    ? wallClockMinutesForTimestamp(entry.openTime, input.config.sessionTimeZone) < input.config.primaryEntryEndMinutes
    : null;
  const breakoutPullback = Boolean(
    breakoutIsBeforePatience
    && input.breakout?.detected
    && !input.breakout.failed
    && input.breakout.continuationConfirmed
    && input.qualifyingPullback
    && !pInside,
  );
  const directBreakoutConfirmed = Boolean(
    pInside
    && entryIsImmediate
    && entry?.isComplete
    && entryReachedConfirmation
    && entryCloseOutsideZone
    && entryOutsideFinalizedNtz
    && entryFillOutsideZone
    && entryBeforeCutoff
    && consolidationEdgeQualified,
  );
  const breakoutPullbackConfirmed = Boolean(
    breakoutPullback
    && entryIsImmediate
    && entry?.isComplete
    && entryReachedConfirmation
    && entryCloseOutsideZone
    && entryOutsideFinalizedNtz
    && entryFillOutsideZone
    && entryBeforeCutoff
    && consolidationEdgeQualified,
  );
  const lifecycleStates: ConsolidationLifecycleState[] = ["CONSOLIDATION_ZONE_FROZEN"];
  if (pInside) lifecycleStates.push("PATIENCE_INSIDE_CONSOLIDATION");
  if (directBreakoutConfirmed) {
    lifecycleStates.push("CONSOLIDATION_BREAKOUT_CONFIRMED");
  } else if (breakoutPullbackConfirmed) {
    lifecycleStates.push("BREAKOUT_PULLBACK_PATIENCE_CONFIRMED");
  } else if (pInside && entryIsImmediate && entry?.isComplete) {
    lifecycleStates.push(
      "CONSOLIDATION_BREAKOUT_CLOSE_NOT_CONFIRMED",
      "PATIENCE_EXPIRED_INSIDE_CONSOLIDATION",
    );
  }
  const executionEligible = !pInside
    ? (!breakoutPullback || breakoutPullbackConfirmed)
    : directBreakoutConfirmed;
  const entryWickedOutsideButClosedInside = direction && entry
    ? direction === "long"
      ? entry.high > zoneHigh && entry.close <= zoneHigh
      : entry.low < zoneLow && entry.close >= zoneLow
    : false;
  const consolidationEntryDisposition = !pInside && !breakoutPullback
    ? "CONSOLIDATION_ZONE_NOT_CAUSALLY_APPLICABLE"
    : !entryIsImmediate || !entry?.isComplete
      ? "CONSOLIDATION_ENTRY_THRESHOLD_NOT_REACHED"
      : !effectiveEntryThresholdReached
        ? "CONSOLIDATION_ENTRY_THRESHOLD_NOT_REACHED"
        : !entryClosedOutsideZone
          ? entryWickedOutsideButClosedInside
            ? "CONSOLIDATION_ENTRY_WICK_ONLY_BREAKOUT"
            : "CONSOLIDATION_ENTRY_CLOSE_REMAINED_INSIDE_ZONE"
          : !entryFillOutsideZone
            ? "CONSOLIDATION_ENTRY_FILL_NOT_OUTSIDE_ZONE"
            : executionEligible
              ? "CONSOLIDATION_ENTRY_CONFIRMED_OUTSIDE_ZONE"
              : "CONSOLIDATION_ENTRY_THRESHOLD_NOT_REACHED";
  const rejectionReason = executionEligible
    ? null
    : breakoutPullback
      ? consolidationEntryDisposition
      : pInside
        ? entryIsImmediate && entry?.isComplete
          ? consolidationEntryDisposition
          : "PATIENCE_INSIDE_CONSOLIDATION"
        : null;
  return {
    detectorVersion: CONSOLIDATION_ENTRY_GUARD_VERSION,
    lifecycleState: lifecycleStates.at(-1) ?? null,
    lifecycleStates,
    zoneDetected: true,
    activeZone: pInside,
    executionEligible,
    consolidationZoneHigh: zoneHigh,
    consolidationZoneLow: zoneLow,
    activeConsolidationZoneId,
    consolidationStartTime: frozen.startTime,
    consolidationDetectionTime: frozen.endTime,
    sourceCandleOpenTimes,
    rangeWidth: frozen.range,
    rangeWidthTicks: frozen.range === null ? null : Number((frozen.range / 0.25).toFixed(2)),
    causalVolatilityBaseline: frozen.causalVolatilityBaseline,
    compressionRatio: frozen.compressionRatio,
    overlapRatio: frozen.overlapRatio,
    completedCandleCount: frozen.candleCount,
    highRejectionCount: frozen.highRejectionCount,
    lowRejectionCount: frozen.lowRejectionCount,
    maxDirectionalSequence: frozen.maxDirectionalSequence,
    diagnosticRangeCapExceeded: frozen.diagnosticRangeCapExceeded,
    qualificationReason: frozen.qualificationReason,
    direction,
    patienceOpenTime: patienceCandle?.openTime ?? null,
    patienceCloseTime: patienceCandle?.closeTime ?? null,
    entryOpenTime: entry?.openTime ?? null,
    entryCloseTime: entry?.closeTime ?? null,
    confirmationThreshold,
    entryClose: entry?.isComplete ? entry.close : null,
    entryCompleted: entry?.isComplete === true,
    entryReachedConfirmation,
    patienceConfirmationThreshold,
    consolidationBoundaryThreshold,
    effectiveEntryThreshold,
    effectiveEntryThresholdReached,
    entryOpenedOutsideZone,
    entryClosedOutsideZone,
    entryCloseOutsideZone,
    entryRangeOutsideZone,
    entryRangeOverlappedZone,
    entryFillOutsideZone,
    entryOutsideFinalizedNtz,
    entryBeforeCutoff,
    consolidationEdgeQualified,
    breakoutPullback,
    consolidationEntryDisposition,
    rejectionReason,
    detail: directBreakoutConfirmed
      ? "Immediate E reached the configured confirmation buffer, closed strictly outside the frozen consolidation zone and finalized NTZ, and satisfied the consolidation breakout edge."
      : breakoutPullbackConfirmed
        ? "Completed breakout-pullback patience sequence confirmed from the frozen consolidation boundary and a new immediate P→E."
        : rejectionReason === "CONSOLIDATION_ENTRY_WICK_ONLY_BREAKOUT"
          ? "The entry candle wicked outside the frozen consolidation zone but closed back inside; a directional close is required."
          : rejectionReason === "CONSOLIDATION_ENTRY_CLOSE_REMAINED_INSIDE_ZONE"
            ? "The completed entry candle closed inside the frozen consolidation zone; a strict directional close is required."
            : rejectionReason === "CONSOLIDATION_ENTRY_THRESHOLD_NOT_REACHED"
              ? "The completed entry candle did not reach the effective patience-plus-consolidation entry threshold."
              : rejectionReason === "CONSOLIDATION_ENTRY_FILL_NOT_OUTSIDE_ZONE"
                ? "The modeled entry fill was inside or exactly on the frozen consolidation boundary."
                : rejectionReason === "PATIENCE_INSIDE_CONSOLIDATION"
                  ? "The patience candle remains inside the frozen consolidation zone and is evidence only until its immediate E confirms a breakout close."
                  : frozen.detail,
  };
}

export function isDoji(candle: Candle, bodyRatio = 0.1): boolean {
  const range = candle.high - candle.low;
  return range > 0 && Math.abs(candle.close - candle.open) / range <= bodyRatio;
}

export function hasEquivalentOpposingCandles(candles: readonly Candle[], majorLevels: readonly MajorLevel[], config: StrategyConfig): boolean {
  const recent = candles.slice(-6);
  return recent.slice(1).some((second, index) => {
    const first = recent[index];
    if (sameDirection(first, second)) return false;
    if (!nearMajorLevel(first, majorLevels, config) && !nearMajorLevel(second, majorLevels, config)) return false;
    const firstRange = first.high - first.low;
    const secondRange = second.high - second.low;
    const firstBody = Math.abs(first.close - first.open);
    const secondBody = Math.abs(second.close - second.open);
    if (!firstRange || !secondRange || firstBody / firstRange < 0.7 || secondBody / secondRange < 0.7) return false;
    if (Math.abs(firstBody - secondBody) / Math.max(firstBody, secondBody) > 0.15) return false;
    return trendFacingWick(first) / firstRange <= 0.15 && trendFacingWick(second) / secondRange <= 0.15;
  });
}

function buildEvaluation(
  setupType: SetupType,
  direction: Direction | null,
  rules: SetupRuleEvidence[],
  alertOnly: boolean,
  patienceState: PatienceAnalysis["state"],
  consolidation: ExtendedConsolidation | null = null,
): SetupEvaluation {
  const mandatory = rules.filter((item) => item.mandatory);
  const mandatoryPassed = mandatory.every((item) => item.passed);
  const decision = mandatoryPassed
    ? "SETUP QUALIFIED"
      : patienceState === "AMBIGUOUS_EVENT_ORDER"
      ? "AMBIGUOUS"
      : patienceState === "PATIENCE_CANDLE_EXPIRED"
        ? "EXPIRED"
        : mandatory.some((item) => item.passed) || ["PATIENCE_CANDLE_FORMING", "PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED"].includes(patienceState)
          ? "SETUP FORMING"
          : "WAITING";
  return {
    setupType,
    direction,
    decision,
    mandatoryPassed,
    alertOnly,
    rules,
    reversalEvidence: null,
    consolidation,
    explanation: mandatoryPassed
      ? `${setupType} passed every mandatory rule.`
      : `${setupType} is ${decision}; ${mandatory.filter((item) => !item.passed).map((item) => item.label).join(", ")}.`,
    grade: 0,
    supportingConfluences: rules.filter((item) => item.passed).map((item) => item.label),
    dynamiteConfluenceCount: 0,
  };
}

function evidenceRules(evidence: ReversalEvidence): SetupRuleEvidence[] {
  return [
    { key: "directionalConfirmationEvidence", label: "Directional reversal evidence", passed: evidence.directionalConfirmation === true },
    { key: "dojiAtMajorLevel", label: "Doji at major level", passed: evidence.dojiAtMajorLevel },
    { key: "equivalentOpposingCandles", label: "Equivalent opposing candles", passed: evidence.equivalentOpposingCandles },
    { key: "failedBreakout", label: "Failed breakout", passed: evidence.failedBreakout },
    { key: "deepFibonacciRetracement", label: "Deep retracement reversal evidence", passed: evidence.deepFibonacciRetracement },
    { key: "majorLevelRejection", label: "Major-level rejection", passed: evidence.majorLevelRejection },
    { key: "structureBreak", label: "Structure break", passed: evidence.structureBreak },
  ].map((item) => ({ ...item, mandatory: false, detail: item.passed ? "Detected as reversal alert evidence." : "Not detected in the current completed-candle context." }));
}

function rule(key: string, label: string, passed: boolean, detail: string): SetupRuleEvidence {
  return { key, label, passed, mandatory: true, detail };
}

function hasQualifyingPullback(pullback: PullbackAnalysis): boolean {
  return pullback.events.some((event) =>
    event.qualifies === true
    && ["touch", "proximity", "consolidation", "break and reclaim", "hold"].includes(event.type)
    && !event.level.trim().toLowerCase().startsWith("fib"),
  );
}

function patienceDirectionMatches(patience: PatienceAnalysis, direction: Direction | null): boolean {
  if (!direction) return false;
  if (patience.direction) return patience.direction === direction;
  return direction === "long" ? patience.trend === "bullish" : patience.trend === "bearish";
}

function strictNtzEntry(context: Phase6Context, patience: PatienceAnalysis, direction: Direction | null): boolean {
  if (!direction || context.levels.ntz?.complete !== true) return false;
  const trigger = patience.triggerCandle;
  // Legacy evaluation callers may provide only the ENTRY_TRIGGERED state.
  // Phase 5 is authoritative when a trigger candle is available; do not
  // invent a contradictory rejection from an incomplete synthetic context.
  if (!trigger) return false;
  // Phase 5 owns the effective P-buffer threshold. This Phase 6 gate only
  // verifies strict geometric NTZ separation on the already-confirmed E.
  const ntzBoundary = direction === "long" ? context.levels.ntz.high : context.levels.ntz.low;
  return isStrictlyOutsideNtz(trigger, direction, context.levels.ntz, true, ntzBoundary);
}

function pullbackVolumePassed(volume: Phase4VolumeAnalysis): boolean {
  return volume.reversalWarning === null
    && volume.pullbackAverageVolume !== null
    && volume.breakoutVolume !== null
    && volume.pullbackAverageVolume <= volume.breakoutVolume
    && (volume.pullbackToRecentRatio === null || volume.pullbackToRecentRatio < 1.5);
}

function trendAgrees(direction: Direction, trend: TrendDirection): boolean {
  return direction === "long" ? trend === "bullish" : trend === "bearish";
}

function hasConfirmedTrend(context: Phase6Context, direction: Direction | null): boolean {
  if (!direction || context.trend.score === undefined || context.trend.candleCount === undefined || !context.trend.evidenceItems) return false;
  return hasConfirmedDirectionalTrend({
    direction: context.trend.direction,
    structure: context.trend.structure,
    score: context.trend.score,
    candleCount: context.trend.candleCount,
    evidenceItems: context.trend.evidenceItems.map((item) => ({
      key: item.key,
      label: "",
      status: item.status,
      detail: "",
    })),
  }, direction);
}

function directionFromTrend(trend: TrendDirection): Direction | null {
  return trend === "bullish" ? "long" : trend === "bearish" ? "short" : null;
}

function reverseDirection(direction: Direction | null): Direction | null {
  return direction === "long" ? "short" : direction === "short" ? "long" : null;
}

function completedCandles(candles: readonly Candle[]): Candle[] {
  return candles.filter((candle) => candle.isComplete).sort((first, second) => first.closeTime - second.closeTime);
}

function isCompletedFiveMinuteCandle(candle: Candle): boolean {
  return candle.isComplete
    && candle.openTime % (5 * 60_000) === 0
    && candle.closeTime - candle.openTime === 5 * 60_000;
}

function isContiguous(candles: readonly Candle[]): boolean {
  return candles.every((candle, index) => index === 0 || candle.openTime === candles[index - 1].closeTime);
}

function candleRange(candles: readonly Candle[]): number {
  return candles.length ? Math.max(...candles.map((candle) => candle.high)) - Math.min(...candles.map((candle) => candle.low)) : 0;
}

function consolidationMetrics(window: readonly Candle[], preceding: readonly Candle[]): ConsolidationMetrics {
  const high = Math.max(...window.map((candle) => candle.high));
  const low = Math.min(...window.map((candle) => candle.low));
  const range = high - low;
  const midpoint = Math.max(1, Math.floor(window.length / 2));
  const firstRange = candleRange(window.slice(0, midpoint));
  const secondRange = candleRange(window.slice(midpoint));
  const expansionRatio = firstRange > 0 ? secondRange / firstRange : secondRange === 0 ? 1 : Infinity;
  const sharedHigh = Math.min(...window.map((candle) => candle.high));
  const sharedLow = Math.max(...window.map((candle) => candle.low));
  const overlapRatio = range > 0 ? Math.max(0, sharedHigh - sharedLow) / range : 1;
  const edgeDistance = Math.max(0.01, range * 0.2);
  const rejectionDistance = Math.max(0.01, edgeDistance * 0.5);
  const highRejectionCount = window.filter((candle) =>
    candle.high >= high - edgeDistance && candle.close <= high - rejectionDistance,
  ).length;
  const lowRejectionCount = window.filter((candle) =>
    candle.low <= low + edgeDistance && candle.close >= low + rejectionDistance,
  ).length;
  const maxDirectionalSequence = maxDirectionalProgression(window);
  const baselineRanges = preceding.map((candle, index) => {
    const previous = preceding[index - 1];
    return previous
      ? Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close))
      : candle.high - candle.low;
  }).filter((value) => Number.isFinite(value) && value >= 0);
  const sortedBaseline = [...baselineRanges].sort((first, second) => first - second);
  const middle = Math.floor(sortedBaseline.length / 2);
  const causalVolatilityBaseline = sortedBaseline.length === 0
    ? null
    : sortedBaseline.length % 2 === 0
      ? (sortedBaseline[middle - 1]! + sortedBaseline[middle]!) / 2
      : sortedBaseline[middle]!;
  return {
    high,
    low,
    range: Number(range.toFixed(2)),
    rangeTicks: Number((range / 0.25).toFixed(2)),
    causalVolatilityBaseline: causalVolatilityBaseline === null ? null : Number(causalVolatilityBaseline.toFixed(4)),
    compressionRatio: causalVolatilityBaseline !== null && causalVolatilityBaseline > 0
      ? Number((range / causalVolatilityBaseline).toFixed(4))
      : null,
    overlapRatio: Number(overlapRatio.toFixed(4)),
    highRejectionCount,
    lowRejectionCount,
    maxDirectionalSequence,
    expansionRatio: Number.isFinite(expansionRatio) ? Number(expansionRatio.toFixed(4)) : null,
  };
}

function maxDirectionalProgression(candles: readonly Candle[]): number {
  let higherHighSequence = candles.length ? 1 : 0;
  let lowerLowSequence = candles.length ? 1 : 0;
  let maximum = candles.length ? 1 : 0;
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    higherHighSequence = current.high > previous.high ? higherHighSequence + 1 : 1;
    lowerLowSequence = current.low < previous.low ? lowerLowSequence + 1 : 1;
    maximum = Math.max(maximum, higherHighSequence, lowerLowSequence);
  }
  return maximum;
}

function emptyConsolidation(detail: string): ExtendedConsolidation {
  return {
    detected: false,
    candleCount: 0,
    durationMinutes: 0,
    insideOrNearCount: 0,
    range: null,
    expansionRatio: null,
    causalVolatilityBaseline: null,
    compressionRatio: null,
    overlapRatio: 0,
    highRejectionCount: 0,
    lowRejectionCount: 0,
    maxDirectionalSequence: 0,
    diagnosticRangeCapExceeded: false,
    startTime: null,
    endTime: null,
    qualificationReason: null,
    detail,
  };
}

function formatRatio(value: number | null): string {
  return value === null ? "unavailable" : `${value.toFixed(2)}×`;
}

function nearMajorLevel(candle: Candle, levels: readonly MajorLevel[], config: StrategyConfig): boolean {
  return levels.some((level) => {
    const tolerance = Math.max(config.majorLevelProximityTicks * 0.25, Math.abs(level.price) * config.majorLevelProximityPercent);
    return candle.low <= level.price + tolerance && candle.high >= level.price - tolerance;
  });
}

function hasMajorLevelRejection(candle: Candle, levels: readonly MajorLevel[], config: StrategyConfig): boolean {
  return levels.some((level) => {
    const tolerance = Math.max(config.majorLevelProximityTicks * 0.25, Math.abs(level.price) * config.majorLevelProximityPercent);
    const touched = candle.low <= level.price + tolerance && candle.high >= level.price - tolerance;
    const rejectedAbove = candle.high > level.price + tolerance && candle.close < level.price - tolerance;
    const rejectedBelow = candle.low < level.price - tolerance && candle.close > level.price + tolerance;
    return touched && (rejectedAbove || rejectedBelow);
  });
}

function hasStructureBreak(candles: readonly Candle[], trend: TrendDirection): boolean {
  if (candles.length < 4 || trend === "neutral") return false;
  const latest = candles.at(-1)!;
  const previous = candles.slice(-4, -1);
  return trend === "bullish"
    ? latest.close < Math.min(...previous.map((candle) => candle.low))
    : latest.close > Math.max(...previous.map((candle) => candle.high));
}

function confirmedReversalDirection(
  context: Phase6Context,
  candles: readonly Candle[],
  equivalentOpposingCandles: boolean,
  failedBreakout: boolean,
  structureBreak: boolean,
  majorLevelRejection: boolean,
): Direction | null {
  const continuationDirection = context.breakout.direction ?? directionFromTrend(context.trend.direction);
  const oppositeDirection = reverseDirection(continuationDirection);
  if (!oppositeDirection) return null;
  const hasIndependentConfirmation = equivalentOpposingCandles
    || failedBreakout
    || structureBreak
    || majorLevelRejection;
  if (!hasIndependentConfirmation) return null;
  const reversalCandle = [...candles].reverse().find((candle) => candleDirection(candle) === oppositeDirection);
  return reversalCandle ? oppositeDirection : null;
}

function candleDirection(candle: Candle): Direction | null {
  if (candle.close > candle.open) return "long";
  if (candle.close < candle.open) return "short";
  return null;
}

function sameDirection(first: Candle, second: Candle): boolean {
  return (first.close >= first.open) === (second.close >= second.open);
}

function trendFacingWick(candle: Candle): number {
  return candle.close >= candle.open
    ? candle.high - Math.max(candle.open, candle.close)
    : Math.min(candle.open, candle.close) - candle.low;
}