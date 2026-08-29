import type {
  BreakoutEvent,
  FibonacciAnalysis,
  Phase4VolumeAnalysis,
  PullbackAnalysis,
} from "./phase4.js";
import type { PatienceAnalysis } from "./phase5.js";
import type { MajorLevel } from "./major-levels.js";
import type { SessionLevels } from "./levels.js";
import type { StrategyConfig } from "./config.js";
import type { Candle, Direction, Level, TrendDirection } from "./types.js";
import { canonicalStrategyId } from "./taxonomy.js";

export type SetupType =
  | "PATIENCE_CANDLE_CONTINUATION"
  | "STRONG_BREAKOUT_AFTER_CONSOLIDATION"
  | "ORB_BREAK_PULLBACK_CONTINUATION"
  | "EQUIVALENT_CANDLE_REVERSAL";

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
  dojiAtMajorLevel: boolean;
  equivalentOpposingCandles: boolean;
  failedBreakout: boolean;
  strongOpposingVolume: boolean;
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
  startTime: number | null;
  endTime: number | null;
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
};

export type Phase6Analysis = {
  decision: Phase6Decision;
  primarySetup: SetupType | null;
  evaluations: SetupEvaluation[];
  explanation: string;
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
  trend: { direction: TrendDirection; structure: string };
  riskApproved: boolean;
  config: StrategyConfig;
};

export function phase6Analysis(context: Phase6Context): Phase6Analysis {
  const evaluations = [
    evaluateOrbBreakPullbackContinuation(context),
    evaluateStrongBreakoutAfterConsolidation(context),
    evaluatePatienceCandleContinuation(context),
    evaluateEquivalentCandleReversal(context),
  ];
  const qualified = evaluations.find((evaluation) => evaluation.decision === "SETUP QUALIFIED" && !evaluation.alertOnly);
  const reversalQualified = evaluations.find((evaluation) => evaluation.setupType === "EQUIVALENT_CANDLE_REVERSAL" && evaluation.decision === "SETUP QUALIFIED");
  const possibleReversal = evaluations.find((evaluation) => evaluation.decision === "POSSIBLE REVERSAL");
  const ambiguous = evaluations.find((evaluation) => evaluation.decision === "AMBIGUOUS");
  const expired = evaluations.find((evaluation) => evaluation.decision === "EXPIRED");
  const forming = evaluations.find((evaluation) => evaluation.decision === "SETUP FORMING");
  if (qualified || reversalQualified) {
    const selected = qualified ?? reversalQualified!;
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
  const rules: SetupRuleEvidence[] = [
    rule("ntzComplete", "NTZ complete", context.levels.ntz?.complete === true, "A finalized NTZ/ORB range is required."),
    rule("closeOutsideNtz", "Completed candle closed outside NTZ", context.breakout.detected, context.breakout.detected ? context.breakout.detail : "Waiting for a completed close outside the finalized NTZ."),
    rule("breakoutAgreesWithTrend", "Breakout agrees with 15-minute trend", direction !== null && trendAgrees(direction, context.trend.direction), direction && context.trend.direction !== "neutral" ? `${direction} breakout vs ${context.trend.direction} 15-minute trend.` : "Breakout direction and a directional 15-minute trend are both required."),
    rule("pullbackReachedLevel", "Pullback reached or came near a qualifying level", hasQualifyingPullback(context.pullback), hasQualifyingPullback(context.pullback) ? "Pullback interaction reached a mapped level." : "No qualifying pullback interaction has been recorded."),
    rule("pullbackVolumePassed", "Pullback volume passed", pullbackVolumePassed(context.volume), pullbackVolumePassed(context.volume) ? "Pullback volume remained below the breakout safety reference without a reversal warning." : "Pullback volume is missing, expanded, or carries an opposing-volume warning."),
    rule("contextRecorded", "Fibonacci and level context recorded", context.fibonacci.frozen && context.fibonacci.levels.length > 0 && context.levels.levels.some((level) => Number.isFinite(level.price)), context.fibonacci.frozen ? "Frozen Fibonacci levels and mapped level context are recorded." : "Frozen Fibonacci and mapped level context are incomplete."),
    rule("validPatienceCandle", "Valid patience candle formed", context.patience.patienceCandle !== null && ["PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED", "ENTRY_TRIGGERED"].includes(context.patience.state), context.patience.detail),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", context.patience.state === "ENTRY_TRIGGERED", context.patience.state === "ENTRY_TRIGGERED" ? context.patience.detail : `Patience state is ${context.patience.state}; only ENTRY_TRIGGERED qualifies.`),
    rule("riskApproval", "Risk approval", context.riskApproved, context.riskApproved ? "Risk controls approved the descriptive plan." : "Risk controls blocked the setup."),
  ];
  return buildEvaluation("ORB_BREAK_PULLBACK_CONTINUATION", direction, rules, false, context.patience.state);
}

export function evaluatePatienceCandleContinuation(context: Phase6Context): SetupEvaluation {
  const direction = directionFromTrend(context.trend.direction);
  const eligible = context.patience.eligible && context.patience.patienceCandle !== null;
  const validState = ["PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED", "ENTRY_TRIGGERED"].includes(context.patience.state);
  const rules: SetupRuleEvidence[] = [
    rule("directionalTrend", "Directional 15-minute trend", direction !== null, direction ? `${direction} continuation follows the ${context.trend.direction} trend.` : "A bullish or bearish 15-minute trend is required."),
    rule("eligiblePatience", "Patience candle is eligible", eligible, eligible ? `Patience eligibility recorded from ${context.patience.eligibilityReason}.` : "No causal patience-candle eligibility is recorded."),
    rule("validPatienceCandle", "Valid patience candle formed", validState, context.patience.detail),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", context.patience.state === "ENTRY_TRIGGERED", context.patience.state === "ENTRY_TRIGGERED" ? context.patience.detail : `Patience state is ${context.patience.state}; only ENTRY_TRIGGERED qualifies.`),
    rule("riskApproval", "Risk approval", context.riskApproved, context.riskApproved ? "Risk controls approved the descriptive plan." : "Risk controls blocked the setup."),
  ];
  return buildEvaluation("PATIENCE_CANDLE_CONTINUATION", direction, rules, false, context.patience.state);
}

export function evaluateStrongBreakoutAfterConsolidation(context: Phase6Context): SetupEvaluation {
  const consolidation = detectExtendedNtzConsolidation(context.candles, context.levels.ntz, context.config.phase6ConsolidationExpansionRatio);
  const direction = context.breakout.direction ?? directionFromTrend(context.trend.direction);
  const patienceNearLevel = context.patience.patienceCandle !== null
    && context.patience.eligible
    && (hasQualifyingPullback(context.pullback) || context.patience.eligibilityReason === "ntz consolidation");
  const rules: SetupRuleEvidence[] = [
    rule("ntzComplete", "NTZ complete", context.levels.ntz?.complete === true, "A finalized NTZ/ORB range is required."),
    rule("extendedConsolidation", "45–60 minutes / 9–12 completed candles inside or near NTZ", consolidation.detected, consolidation.detail),
    rule("rangeStable", "Consolidation range did not materially expand", consolidation.detected && consolidation.expansionRatio !== null && consolidation.expansionRatio <= context.config.phase6ConsolidationExpansionRatio, consolidation.detected ? `Consolidation expansion ratio ${formatRatio(consolidation.expansionRatio)}; maximum allowed is ${context.config.phase6ConsolidationExpansionRatio.toFixed(2)}×.` : "The required extended consolidation window is not complete."),
    rule("validPatienceNearLevel", "Valid patience candle formed near a qualifying level", patienceNearLevel && ["PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED", "ENTRY_TRIGGERED"].includes(context.patience.state), patienceNearLevel ? context.patience.detail : "Patience must be eligible from the NTZ or a mapped qualifying-level interaction."),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", context.patience.state === "ENTRY_TRIGGERED", context.patience.state === "ENTRY_TRIGGERED" ? context.patience.detail : `Patience state is ${context.patience.state}; only ENTRY_TRIGGERED qualifies.`),
    rule("breakoutVolume", "Breakout volume supports the move", context.breakout.volumeSupported || context.volume.supportingBreakoutVolume, context.breakout.volumeSupported || context.volume.supportingBreakoutVolume ? "Breakout volume meets the configured support threshold." : "Breakout volume support is not confirmed."),
    rule("riskApproval", "Risk approval", context.riskApproved, context.riskApproved ? "Risk controls approved the descriptive plan." : "Risk controls blocked the setup."),
  ];
  return buildEvaluation("STRONG_BREAKOUT_AFTER_CONSOLIDATION", direction, rules, false, context.patience.state, consolidation);
}

export const evaluateExtendedNtzConsolidationBreakout = evaluateStrongBreakoutAfterConsolidation;

export function evaluateEquivalentCandleReversal(context: Phase6Context): SetupEvaluation {
  const completed = completedCandles(context.candles);
  const latest = completed.at(-1);
  const reversalDirection = reverseDirection(context.breakout.direction ?? directionFromTrend(context.trend.direction));
  const evidence = detectReversalEvidence(context, completed, latest);
  const patience = context.reversalPatience ?? context.patience;
  const rules: SetupRuleEvidence[] = [
    rule("directionalConfirmation", "Directional confirmation", reversalDirection !== null && trendAgrees(reversalDirection, context.trend.direction), reversalDirection && context.trend.direction !== "neutral" ? `${reversalDirection} reversal direction vs ${context.trend.direction} 15-minute trend.` : "A directional trend confirmation is required."),
    rule("validPatienceCandle", "Valid patience candle formed", patience.patienceCandle !== null && ["PATIENCE_CANDLE_VALID", "TRIGGER_CANDLE_ACTIVE", "BREAK_DETECTED_WAITING_FOR_BUFFER", "ENTRY_BUFFER_REACHED", "ENTRY_TRIGGERED"].includes(patience.state), patience.detail),
    rule("immediateTrigger", "Immediate next candle reached the confirmation buffer", patience.state === "ENTRY_TRIGGERED", patience.state === "ENTRY_TRIGGERED" ? patience.detail : `Patience state is ${patience.state}; only ENTRY_TRIGGERED qualifies.`),
    rule("riskApproval", "Risk approval", context.riskApproved, context.riskApproved ? "Risk controls approved the descriptive plan." : "Risk controls blocked the setup."),
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
    alertOnly: true,
    rules: [...evidenceRules(evidence), ...rules],
    reversalEvidence: evidence,
    consolidation: null,
    explanation: decision === "SETUP QUALIFIED"
      ? "Bonus reversal evidence and every mandatory confirmation passed. Alert only; no order was created."
      : evidence.alert
        ? `Possible reversal: ${evidence.detail} Mandatory confirmation remains incomplete.`
        : "No reversal evidence currently meets the configured detection defaults.",
  };
}

export const evaluateBonusReversal = evaluateEquivalentCandleReversal;

export function detectReversalEvidence(
  context: Phase6Context,
  completed: readonly Candle[] = completedCandles(context.candles),
  latest = completed.at(-1),
): ReversalEvidence {
  const dojiAtMajorLevel = latest !== undefined && isDoji(latest, context.config.dojiBodyRatio) && nearMajorLevel(latest, context.levels.majorLevels, context.config);
  const equivalentOpposingCandles = hasEquivalentOpposingCandles(completed, context.levels.majorLevels, context.config);
  const failedBreakout = context.levels.ntzEvents.some((event) => event.type === "Failed breakout");
  const strongOpposingVolume = context.volume.reversalWarning !== null
    || (context.volume.breakoutVolume !== null && context.volume.opposingPullbackVolume !== null && context.volume.opposingPullbackVolume >= context.volume.breakoutVolume);
  const deepFibonacciRetracement = ["deep", "elevated failure risk", "fully retraced"].includes(context.fibonacci.classification);
  const majorLevelRejection = latest !== undefined && hasMajorLevelRejection(latest, context.levels.majorLevels, context.config);
  const structureBreak = hasStructureBreak(completed, context.trend.direction);
  const signals = [
    dojiAtMajorLevel,
    equivalentOpposingCandles,
    failedBreakout,
    strongOpposingVolume,
    deepFibonacciRetracement,
    majorLevelRejection,
    structureBreak,
  ];
  const names = [
    ["doji at major level", dojiAtMajorLevel],
    ["equivalent opposing candles", equivalentOpposingCandles],
    ["failed breakout", failedBreakout],
    ["strong opposing volume", strongOpposingVolume],
    ["deep Fibonacci retracement", deepFibonacciRetracement],
    ["major-level rejection", majorLevelRejection],
    ["structure break", structureBreak],
  ].filter(([, passed]) => passed).map(([name]) => name);
  return {
    dojiAtMajorLevel,
    equivalentOpposingCandles,
    failedBreakout,
    strongOpposingVolume,
    deepFibonacciRetracement,
    majorLevelRejection,
    structureBreak,
    alert: signals.some(Boolean),
    detail: names.length ? `Detected: ${names.join(", ")}.` : "No bonus reversal evidence detected.",
  };
}

export function detectExtendedNtzConsolidation(candles: readonly Candle[], ntz: SessionLevels["ntz"], expansionLimit = 1.25): ExtendedConsolidation {
  if (!ntz?.complete) return emptyConsolidation("Waiting for a finalized NTZ.");
  const afterNtz = completedCandles(candles).filter((candle) => ntz.completedAt === undefined || candle.openTime >= ntz.completedAt);
  const candidates: ExtendedConsolidation[] = [];
  const proximity = Math.max((ntz.high - ntz.low) * 0.1, 0.01);
  for (let count = 9; count <= Math.min(12, afterNtz.length); count += 1) {
    for (let start = 0; start + count <= afterNtz.length; start += 1) {
      const window = afterNtz.slice(start, start + count);
      if (!isContiguous(window)) continue;
      const insideOrNear = window.filter((candle) => candle.close >= ntz.low - proximity && candle.close <= ntz.high + proximity).length;
      if (insideOrNear / count < 0.75) continue;
      const midpoint = Math.floor(count / 2);
      const firstRange = candleRange(window.slice(0, midpoint));
      const secondRange = candleRange(window.slice(midpoint));
      const expansionRatio = firstRange > 0 ? secondRange / firstRange : secondRange === 0 ? 1 : Infinity;
      candidates.push({
        detected: true,
        candleCount: count,
        durationMinutes: Math.round((window.at(-1)!.closeTime - window[0].openTime) / 60_000),
        insideOrNearCount: insideOrNear,
        range: Number((Math.max(...window.map((candle) => candle.high)) - Math.min(...window.map((candle) => candle.low))).toFixed(2)),
        expansionRatio: Number.isFinite(expansionRatio) ? Number(expansionRatio.toFixed(2)) : null,
        startTime: window[0].openTime,
        endTime: window.at(-1)!.closeTime,
        detail: `${count} contiguous completed candles (${Math.round((window.at(-1)!.closeTime - window[0].openTime) / 60_000)} minutes); ${insideOrNear}/${count} closes inside or near NTZ.`,
      });
    }
  }
  const best = candidates
    .sort((first, second) => (second.endTime ?? 0) - (first.endTime ?? 0) || second.candleCount - first.candleCount)
    .at(0);
  return best ?? emptyConsolidation("No contiguous 45–60 minute window remains primarily inside or near NTZ.");
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
  };
}

function evidenceRules(evidence: ReversalEvidence): SetupRuleEvidence[] {
  return [
    { key: "dojiAtMajorLevel", label: "Doji at major level", passed: evidence.dojiAtMajorLevel },
    { key: "equivalentOpposingCandles", label: "Equivalent opposing candles", passed: evidence.equivalentOpposingCandles },
    { key: "failedBreakout", label: "Failed breakout", passed: evidence.failedBreakout },
    { key: "strongOpposingVolume", label: "Strong opposing volume", passed: evidence.strongOpposingVolume },
    { key: "deepFibonacciRetracement", label: "Deep Fibonacci retracement", passed: evidence.deepFibonacciRetracement },
    { key: "majorLevelRejection", label: "Major-level rejection", passed: evidence.majorLevelRejection },
    { key: "structureBreak", label: "Structure break", passed: evidence.structureBreak },
  ].map((item) => ({ ...item, mandatory: false, detail: item.passed ? "Detected as reversal alert evidence." : "Not detected in the current completed-candle context." }));
}

function rule(key: string, label: string, passed: boolean, detail: string): SetupRuleEvidence {
  return { key, label, passed, mandatory: true, detail };
}

function hasQualifyingPullback(pullback: PullbackAnalysis): boolean {
  return pullback.events.some((event) => ["touch", "proximity", "consolidation", "break and reclaim", "hold"].includes(event.type));
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

function directionFromTrend(trend: TrendDirection): Direction | null {
  return trend === "bullish" ? "long" : trend === "bearish" ? "short" : null;
}

function reverseDirection(direction: Direction | null): Direction | null {
  return direction === "long" ? "short" : direction === "short" ? "long" : null;
}

function completedCandles(candles: readonly Candle[]): Candle[] {
  return candles.filter((candle) => candle.isComplete).sort((first, second) => first.closeTime - second.closeTime);
}

function isContiguous(candles: readonly Candle[]): boolean {
  return candles.every((candle, index) => index === 0 || candle.openTime === candles[index - 1].closeTime);
}

function candleRange(candles: readonly Candle[]): number {
  return candles.length ? Math.max(...candles.map((candle) => candle.high)) - Math.min(...candles.map((candle) => candle.low)) : 0;
}

function emptyConsolidation(detail: string): ExtendedConsolidation {
  return { detected: false, candleCount: 0, durationMinutes: 0, insideOrNearCount: 0, range: null, expansionRatio: null, startTime: null, endTime: null, detail };
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

function sameDirection(first: Candle, second: Candle): boolean {
  return (first.close >= first.open) === (second.close >= second.open);
}

function trendFacingWick(candle: Candle): number {
  return candle.close >= candle.open
    ? candle.high - Math.max(candle.open, candle.close)
    : Math.min(candle.open, candle.close) - candle.low;
}