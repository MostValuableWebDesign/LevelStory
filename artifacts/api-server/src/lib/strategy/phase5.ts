import type { PullbackAnalysis } from "./phase4.js";
import type { NtzEvent, NtzRange } from "./levels.js";
import type { Candle, Direction, TrendDirection } from "./types.js";
import { wallClockMinutesForTimestamp } from "../futures/session-calendar.js";

export type PatienceState =
  | "WAITING_FOR_VALID_CONTEXT"
  | "WAITING_FOR_LEVEL"
  | "WAITING_FOR_PATIENCE_CANDLE"
  | "PATIENCE_CANDLE_FORMING"
  | "PATIENCE_CANDLE_VALID"
  | "PATIENCE_TREND_MISMATCH"
  | "TRIGGER_CANDLE_ACTIVE" // Compatibility state name: the immediate-next entry candle is active.
  | "BREAK_DETECTED_WAITING_FOR_BUFFER"
  | "ENTRY_BUFFER_REACHED"
  | "ENTRY_TRIGGERED"
  | "OPPOSITE_SIDE_INVALIDATION"
  | "PATIENCE_CANDLE_EXPIRED"
  | "AMBIGUOUS_EVENT_ORDER"
  | "RISK_REJECTED";

export type PatienceEligibilityReason = "pullback" | "consolidation" | "ntz consolidation";
export type PatienceEligibilityArmState = "active" | "consumed" | "invalidated" | "superseded";
export type PatienceEligibilityEvent = {
  time: number;
  reason: PatienceEligibilityReason;
  detail?: string;
  eventId?: string;
  levelValue?: number | null;
  toleranceTicks?: number | null;
};
export type IntrabarFirstBreak = "intended-first" | "opposite-first" | "ambiguous";
export type IntrabarEvidence = { candleOpenTime: number; firstBreak: IntrabarFirstBreak };

export type PatienceCandleSnapshot = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  isComplete: boolean;
};

export type PatienceOccurrenceStatus =
  | "CANDIDATE"
  | "CONFIRMED"
  | "EXPIRED_NO_IMMEDIATE_CONFIRMATION"
  | "EXPIRED_WRONG_DIRECTION"
  | "EXPIRED_MISSING_E"
  | "EXPIRED_INCOMPLETE_E"
  | "INVALIDATED";

export type PatienceDirectionSource =
  | "ORB_BREAKOUT"
  | "CONSOLIDATION_BREAKOUT"
  | "EQUIVALENT_REVERSAL"
  | "CONFIRMED_15M_TREND";

export type PatienceOccurrenceQualification =
  | "PATIENCE_SHAPE_FOUND"
  | "IMMEDIATE_CONFIRMATION_FAILED"
  | "SIGNAL_CONFIRMED"
  | "STRUCTURALLY_INVALIDATED";

export type PatienceOccurrence = {
  occurrenceId: string;
  direction: Direction;
  directionSource?: PatienceDirectionSource;
  entryBufferTicks: number;
  stopBufferTicks: number;
  patienceCandleExtreme?: number;
  stopBufferPoints?: number;
  finalStopBoundary?: number;
  eligibilityReason: PatienceEligibilityReason;
  eligibilityTime: number;
  eligibilityEventId?: string | null;
  previousComparisonTimestamp?: number;
  candidateShapeResult?: boolean;
  expectedEntryCandleOpenTime?: number;
  confirmationThreshold?: number;
  actualConfirmationExcursion?: number | null;
  previousCandle: PatienceCandleSnapshot;
  patienceCandle: PatienceCandleSnapshot;
  triggerCandle: PatienceCandleSnapshot | null;
  nextObservedCandle?: PatienceCandleSnapshot | null;
  outcomeStatus?: PatienceOccurrenceStatus;
  qualificationStatus?: PatienceOccurrenceQualification;
  status: PatienceState;
  reasonCode: string;
  evaluationCursor: number;
  eligibilityArmId?: string;
  eligibilityArmState?: PatienceEligibilityArmState;
  eligibilityArmStateReason?: string;
  eligibilityArmTransitionTime?: number;
  eligibilityProvenance?: {
    eventId: string | null;
    reason: PatienceEligibilityReason;
    time: number;
    detail: string | null;
  };
};

export type PatienceAnalysis = {
  state: PatienceState;
  /** The direction this patience engine evaluated, independent of the established continuation trend. */
  direction?: Direction;
  directionSource?: PatienceDirectionSource;
  eligible: boolean;
  eligibilityReason: PatienceEligibilityReason | null;
  eligibilityTime: number | null;
  trend: TrendDirection;
  previousCandle: PatienceCandleSnapshot | null;
  patienceCandle: PatienceCandleSnapshot | null;
  triggerCandle: PatienceCandleSnapshot | null;
  entryBufferTicks: number;
  entryBufferPrice: number | null;
  stopBufferTicks: number;
  strategyStopPrice: number | null;
  triggerPrice: number | null;
  stateTime: number | null;
  detail: string;
  occurrences?: PatienceOccurrence[];
  eligibilityArmId?: string | null;
  eligibilityArmState?: PatienceEligibilityArmState | null;
  eligibilityArmStateReason?: string | null;
  eligibilityProvenance?: PatienceOccurrence["eligibilityProvenance"] | null;
};

export type PatienceEngineOptions = {
  eligibilityEvents?: readonly PatienceEligibilityEvent[];
  intrabarEvidence?: readonly IntrabarEvidence[];
  trend?: TrendDirection;
  tickSize?: number;
  entryBufferTicks?: number;
  stopBufferTicks?: number;
  validContext?: boolean;
  allowOpposingTrend?: boolean;
  directionSource?: PatienceDirectionSource;
  finalizedNtz?: NtzRange | null;
  requireFinalizedNtz?: boolean;
  entryCutoffMinutes?: number;
};

const PATIENCE_STATES: readonly PatienceState[] = [
  "WAITING_FOR_VALID_CONTEXT",
  "WAITING_FOR_LEVEL",
  "WAITING_FOR_PATIENCE_CANDLE",
  "PATIENCE_CANDLE_FORMING",
  "PATIENCE_CANDLE_VALID",
  "PATIENCE_TREND_MISMATCH",
  "TRIGGER_CANDLE_ACTIVE",
  "BREAK_DETECTED_WAITING_FOR_BUFFER",
  "ENTRY_BUFFER_REACHED",
  "ENTRY_TRIGGERED",
  "OPPOSITE_SIDE_INVALIDATION",
  "PATIENCE_CANDLE_EXPIRED",
  "AMBIGUOUS_EVENT_ORDER",
  "RISK_REJECTED",
];
export function patienceCandleEngine(
  candles: readonly Candle[],
  direction: Direction,
  options: PatienceEngineOptions = {},
): PatienceAnalysis {
  const sorted = [...candles].sort((first, second) => first.openTime - second.openTime);
  const completed = sorted.filter((candle) => candle.isComplete);
  const eligibility = [...(options.eligibilityEvents ?? [])].sort((first, second) => first.time - second.time);
  const trend = options.trend ?? (direction === "long" ? "bullish" : "bearish");
  const tickSize = options.tickSize ?? 0.25;
  const entryBufferTicks = options.entryBufferTicks ?? 4;
  const stopBufferTicks = options.stopBufferTicks ?? 12;
  const allowOpposingTrend = options.allowOpposingTrend ?? false;
  const directionSource = options.directionSource ?? "CONFIRMED_15M_TREND";
  const trendRequired = directionSource === "CONFIRMED_15M_TREND";
  const withDirection = (analysis: PatienceAnalysis): PatienceAnalysis => ({ ...analysis, direction, directionSource });
  validateBuffers(tickSize, entryBufferTicks, stopBufferTicks);
  const validContext = options.validContext ?? eligibility.length > 0;
  if (!validContext) return withDirection(waiting("WAITING_FOR_VALID_CONTEXT", "No valid pullback or consolidation context has been recorded.", trend, entryBufferTicks, stopBufferTicks));
  if (!eligibility.length) return withDirection(waiting("WAITING_FOR_LEVEL", "Valid pullback/consolidation context exists; waiting for a qualifying level interaction.", trend, entryBufferTicks, stopBufferTicks));
  if (trend === "neutral" && trendRequired) return withDirection(waiting("PATIENCE_TREND_MISMATCH", "WAITING — TREND UNCLEAR. A bullish or bearish 15-minute trend is required.", trend, entryBufferTicks, stopBufferTicks, eligibility.at(-1)));
  const latestEligibility = eligibility.at(-1)!;
  const candidateIndexes = completed
    .map((candle, index) => {
      const event = latestEligibilityBefore(eligibility, candle.openTime);
      return { candle, index, event, armId: event ? eligibilityArmId(event) : null };
    })
    .filter(({ event, candle, index }) =>
      event !== undefined
      && index > 0
      && patienceShape(candle, completed[index - 1], direction));
  const occurrences = buildPatienceOccurrences(candidateIndexes, completed, sorted, direction, directionSource, trend, tickSize, entryBufferTicks, stopBufferTicks, options.intrabarEvidence ?? [], allowOpposingTrend, trendRequired, options.finalizedNtz);
  const finalize = (analysis: PatienceAnalysis): PatienceAnalysis => {
    const latestOccurrence = occurrences.at(-1);
    return {
      ...withDirection(analysis),
      occurrences,
      eligibilityArmId: latestOccurrence?.eligibilityArmId ?? null,
      eligibilityArmState: latestOccurrence?.eligibilityArmState ?? null,
      eligibilityArmStateReason: latestOccurrence?.eligibilityArmStateReason ?? null,
      eligibilityProvenance: latestOccurrence?.eligibilityProvenance ?? null,
    };
  };
  // If an earlier P/E candidate is invalidated or ambiguous, continue to the
  // earliest later confirmed occurrence. Do not let a stale earlier candidate
  // hide a valid immediate P→E sequence at the same replay cursor.
  const confirmedOccurrence = occurrences.find((occurrence) =>
    occurrence.outcomeStatus === "CONFIRMED"
    && occurrence.triggerCandle?.openTime !== undefined
    && occurrence.patienceCandle.openTime !== undefined,
  );
  const candidate = (confirmedOccurrence
    ? candidateIndexes.find(({ candle }) => candle.openTime === confirmedOccurrence.patienceCandle.openTime)
    : undefined) ?? candidateIndexes.find(({ candle }) => {
    const next = sorted.find((item) => item.openTime > candle.openTime);
    if (!next || !next.isComplete || next.openTime !== candle.closeTime) return false;
    const confirmationPrice = direction === "long"
      ? roundPrice(candle.high + entryBufferTicks * tickSize, tickSize)
      : roundPrice(candle.low - entryBufferTicks * tickSize, tickSize);
    return (direction === "long" ? next.high >= confirmationPrice : next.low <= confirmationPrice)
      && isStrictlyOutsideNtz(next, direction, options.finalizedNtz);
  }) ?? candidateIndexes.at(-1);
  if (candidate) {
    const previous = completed[candidate.index - 1];
    if (!previous) return finalize(waiting("WAITING_FOR_PATIENCE_CANDLE", "Waiting for a preceding completed candle.", trend, entryBufferTicks, stopBufferTicks, candidate.event));
    const event = candidate.event!;
    const shapeValid = patienceShape(candidate.candle, previous, direction);
    const trendValid = !trendRequired || allowOpposingTrend || directionTrendMatches(direction, trend);
    if (!trendValid || !shapeValid) {
      return finalize({
        ...baseAnalysis("PATIENCE_TREND_MISMATCH", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: snapshot(candidate.candle),
        stateTime: candidate.candle.closeTime,
        detail: !trendValid
          ? `${direction === "long" ? "Bullish" : "Bearish"} patience requires the established ${direction === "long" ? "bullish" : "bearish"} 15-minute trend; current trend is ${trend}.`
          : `Opposing patience shape rejected: ${direction === "long" ? "candidate high must be less than or equal to the preceding high" : "candidate low must be greater than or equal to the preceding low"}. It may feed reversal analysis, not continuation patience.`,
      });
    }
    const next = sorted.find((candle) => candle.openTime > candidate.candle.openTime);
    const patience = snapshot(candidate.candle);
    const entryBufferPrice = direction === "long"
      ? roundPrice(candidate.candle.high + entryBufferTicks * tickSize, tickSize)
      : roundPrice(candidate.candle.low - entryBufferTicks * tickSize, tickSize);
    const strategyStopPrice = direction === "long"
      ? roundPrice(candidate.candle.low - stopBufferTicks * tickSize, tickSize)
      : roundPrice(candidate.candle.high + stopBufferTicks * tickSize, tickSize);
    if (!next) {
      return finalize({
        ...baseAnalysis("PATIENCE_CANDLE_VALID", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: patience,
        entryBufferPrice,
        strategyStopPrice,
        stateTime: candidate.candle.closeTime,
        detail: `Completed ${direction === "long" ? "bullish" : "bearish"} patience candle accepted from exact wick highs/lows; entry waits for a ${entryBufferTicks}-tick confirmation buffer on the immediate next candle.`,
      });
    }
    if (next.openTime !== candidate.candle.closeTime) {
      return finalize({
        ...baseAnalysis("PATIENCE_CANDLE_EXPIRED", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: patience,
        triggerCandle: null,
        entryBufferPrice,
        strategyStopPrice,
        stateTime: next.openTime,
        detail: `The immediate-next entry candle is missing for ${formatFiveMinuteWindow(candidate.candle.closeTime)}; later candles cannot reuse this patience pattern.`,
      });
    }
    return finalize(evaluateTrigger(candidate.candle, previous, next, direction, event, trend, directionSource, tickSize, entryBufferTicks, stopBufferTicks, options.intrabarEvidence ?? [], options.finalizedNtz, options.requireFinalizedNtz, options.entryCutoffMinutes));
  }

  const forming = sorted.at(-1);
  const event = forming ? latestEligibilityBefore(eligibility, forming.openTime) : latestEligibility;
  const eventIsWithinArm = true;
  const latestCompleted = completed.at(-1);
  const latestPrevious = completed.at(-2);
  if (latestCompleted && latestPrevious && event && eventIsWithinArm && !patienceShape(latestCompleted, latestPrevious, direction)) {
    return finalize({
      ...baseAnalysis("PATIENCE_TREND_MISMATCH", true, event, trend, entryBufferTicks, stopBufferTicks),
      previousCandle: snapshot(latestPrevious),
      patienceCandle: snapshot(latestCompleted),
      stateTime: latestCompleted.closeTime,
      detail: `Opposing patience shape rejected: ${direction === "long" ? "candidate high must be less than or equal to the preceding high" : "candidate low must be greater than or equal to the preceding low"}. It may feed reversal analysis, not continuation patience.`,
    });
  }
  if (forming && !forming.isComplete && completed.length && event && eventIsWithinArm) {
    return finalize({
      ...baseAnalysis("PATIENCE_CANDLE_FORMING", true, event, trend, entryBufferTicks, stopBufferTicks),
      patienceCandle: snapshot(forming),
      stateTime: forming.openTime,
      detail: "A patience candle is forming; wait for its completed close before checking exact wick highs/lows and trend alignment.",
    });
  }
  return finalize(waiting("WAITING_FOR_PATIENCE_CANDLE", "A qualifying level is recorded; waiting for a completed trend-aligned patience candle.", trend, entryBufferTicks, stopBufferTicks, event && eventIsWithinArm ? event : undefined));
}

export function phase5PatienceAnalysis(
  candles: readonly Candle[],
  direction: Direction | null,
  pullback: PullbackAnalysis,
  ntz: NtzRange | null,
  ntzEvents: readonly NtzEvent[] = [],
  minimumEligibilityTime?: number | null,
  trend: TrendDirection = "neutral",
  tickSize = 0.25,
  entryBufferTicks = 4,
  stopBufferTicks = 1,
  allowOpposingTrend = false,
  directionSource: PatienceDirectionSource = "CONFIRMED_15M_TREND",
): PatienceAnalysis {
  const eligibleAfter = minimumEligibilityTime === undefined ? null : minimumEligibilityTime;
  const eligibilityEvents: PatienceEligibilityEvent[] = [
    ...pullback.events
      .filter((event) => eligibleAfter === null || event.time >= eligibleAfter)
      .filter((event) => ["touch", "proximity", "consolidation", "break and reclaim", "hold"].includes(event.type))
      .map((event) => ({
        time: event.time,
        reason: event.type === "consolidation" ? "consolidation" as const : "pullback" as const,
        detail: `${event.type} at ${event.level}`,
        eventId: event.eventId ?? `pullback|${event.type}|${event.time}|${event.level}|${event.price}`,
        levelValue: event.price,
        toleranceTicks: event.toleranceTicks ?? null,
      })),
    ...ntzEvents
      .filter((event) => eligibleAfter === null || event.time >= eligibleAfter)
      .filter((event) => event.type === "Consolidation inside NTZ")
      .map((event) => ({ time: event.time, reason: "ntz consolidation" as const, detail: event.detail, eventId: `ntz|${event.type}|${event.time}`, levelValue: null, toleranceTicks: null })),
  ];
  if (ntz && ntz.complete && candles.length >= 2) {
    const completed = candles.filter((candle) => candle.isComplete).sort((first, second) => first.openTime - second.openTime);
    const proximity = Math.max((ntz.high - ntz.low) * 0.1, 0.01);
    let insideStreak = 0;
    for (const candle of completed) {
      const near = candle.close >= ntz.low - proximity && candle.close <= ntz.high + proximity;
      insideStreak = near ? insideStreak + 1 : 0;
       if (insideStreak >= 2 && (eligibleAfter === null || candle.closeTime >= eligibleAfter)) {
        eligibilityEvents.push({ time: candle.closeTime, reason: "ntz consolidation", detail: "Extended completed-candle consolidation inside or near NTZ.", eventId: `ntz|extended-consolidation|${candle.closeTime}`, levelValue: null, toleranceTicks: null });
      }
    }
  }
  if (direction === null) {
    return waiting("PATIENCE_TREND_MISMATCH", "No executable direction is available for continuation patience.", trend, entryBufferTicks, stopBufferTicks, eligibilityEvents.at(-1));
  }
  return patienceCandleEngine(candles, direction, {
    eligibilityEvents,
    trend,
    tickSize,
    entryBufferTicks,
    stopBufferTicks,
    validContext: pullback.status === "observed" || (ntz?.complete === true),
    allowOpposingTrend,
    directionSource,
    finalizedNtz: ntz,
    requireFinalizedNtz: true,
    entryCutoffMinutes: 780,
  });
}

export function patienceStateLabels(): readonly PatienceState[] {
  return PATIENCE_STATES;
}

function evaluateTrigger(
  patience: Candle,
  previous: Candle,
  trigger: Candle,
  direction: Direction,
  eligibility: PatienceEligibilityEvent,
  trend: TrendDirection,
  directionSource: PatienceDirectionSource,
  tickSize: number,
  entryBufferTicks: number,
  stopBufferTicks: number,
  evidence: readonly IntrabarEvidence[],
  finalizedNtz?: NtzRange | null,
  requireFinalizedNtz = false,
  entryCutoffMinutes?: number,
): PatienceAnalysis {
  const intendedPrice = direction === "long" ? patience.high : patience.low;
  const oppositePrice = direction === "long" ? patience.low : patience.high;
  const entryBufferPrice = direction === "long"
    ? roundPrice(intendedPrice + entryBufferTicks * tickSize, tickSize)
    : roundPrice(intendedPrice - entryBufferTicks * tickSize, tickSize);
  const strictNtzPrice = finalizedNtz?.complete
    ? direction === "long"
      ? roundPrice(finalizedNtz.high + tickSize, tickSize)
      : roundPrice(finalizedNtz.low - tickSize, tickSize)
    : null;
  const modeledEntryPrice = strictNtzPrice === null
    ? entryBufferPrice
    : direction === "long"
      ? Math.max(entryBufferPrice, strictNtzPrice)
      : Math.min(entryBufferPrice, strictNtzPrice);
  const strategyStopPrice = direction === "long"
    ? roundPrice(oppositePrice - stopBufferTicks * tickSize, tickSize)
    : roundPrice(oppositePrice + stopBufferTicks * tickSize, tickSize);
  const intendedTouched = direction === "long" ? trigger.high >= intendedPrice : trigger.low <= intendedPrice;
  const bufferReached = direction === "long" ? trigger.high >= modeledEntryPrice : trigger.low <= modeledEntryPrice;
  // Touching the opposite wick is not a breach. Invalidation requires the
  // immediate E candle to print beyond the patience extreme.
  const oppositeTouched = direction === "long" ? trigger.low < oppositePrice : trigger.high > oppositePrice;
  const gapBuffer = direction === "long" ? trigger.open >= modeledEntryPrice : trigger.open <= modeledEntryPrice;
  const gapOpposite = direction === "long" ? trigger.open < oppositePrice : trigger.open > oppositePrice;
  const sequence = evidence.find((item) => item.candleOpenTime === trigger.openTime)?.firstBreak;
  const base = {
    direction,
    directionSource,
    eligible: true,
    eligibilityReason: eligibility.reason,
    eligibilityTime: eligibility.time,
    trend,
    previousCandle: snapshot(previous),
    patienceCandle: snapshot(patience),
    triggerCandle: snapshot(trigger),
    entryBufferTicks,
    entryBufferPrice,
    stopBufferTicks,
    strategyStopPrice,
    stateTime: trigger.openTime,
  };
  if (entryCutoffMinutes !== undefined && wallClockMinutesForTimestamp(trigger.closeTime) >= entryCutoffMinutes) {
    return { ...base, state: "PATIENCE_CANDLE_EXPIRED", triggerPrice: null, detail: "ENTRY_AFTER_PRIMARY_CUTOFF: completed E is at or after 1:00 p.m. ET." };
  }
  if ((bufferReached && oppositeTouched) || (gapBuffer && gapOpposite) || (intendedTouched && oppositeTouched)) {
    if (sequence === "opposite-first") {
      return { ...base, state: "OPPOSITE_SIDE_INVALIDATION", triggerPrice: oppositePrice, detail: "The immediate-next entry candle (E) broke the opposite patience extreme first; the confirmation buffer cannot restore this setup." };
    }
    if (!(sequence === "intended-first" && bufferReached)) {
      return { ...base, state: "AMBIGUOUS_EVENT_ORDER", triggerPrice: null, detail: "The immediate-next entry candle (E) reached both the confirmation buffer and the opposite patience extreme, but available candle data cannot prove which occurred first; the setup is rejected." };
    }
  }
  if (gapOpposite || (oppositeTouched && !bufferReached) || sequence === "opposite-first") {
    return { ...base, state: "OPPOSITE_SIDE_INVALIDATION", triggerPrice: oppositePrice, detail: "The immediate-next entry candle (E) crossed the opposite patience extreme; a later intended-side move cannot restore this setup." };
  }
  if (bufferReached || gapBuffer) {
    if (!isStrictlyOutsideNtz(trigger, direction, finalizedNtz, requireFinalizedNtz)) {
      return {
        ...base,
        state: "PATIENCE_CANDLE_EXPIRED",
        triggerPrice: null,
        detail: "ENTRY_NOT_OUTSIDE_FINALIZED_NTZ: immediate E reached the patience threshold but did not confirm strictly outside the finalized NTZ/ORB.",
      };
    }
    return {
      ...base,
      state: trigger.isComplete ? "ENTRY_TRIGGERED" : "ENTRY_BUFFER_REACHED",
      triggerPrice: modeledEntryPrice,
      detail: trigger.isComplete
        ? `The immediate-next entry candle (E) reached the full ${entryBufferTicks}-tick confirmation buffer; shadow entry is triggered at ${entryBufferPrice}.`
        : `The immediate-next entry candle (E) reached the full ${entryBufferTicks}-tick confirmation buffer; shadow entry is pending the completed-candle record.`,
    };
  }
  if (intendedTouched) {
    return {
      ...base,
      state: trigger.isComplete ? "PATIENCE_CANDLE_EXPIRED" : "BREAK_DETECTED_WAITING_FOR_BUFFER",
      triggerPrice: null,
      detail: trigger.isComplete
        ? `The immediate-next entry candle (E) crossed the patience extreme but closed before reaching the full ${entryBufferTicks}-tick confirmation buffer; the setup expired.`
        : `BREAK DETECTED — WAITING FOR CONFIRMATION BUFFER. The raw patience extreme was crossed, but the full ${entryBufferTicks}-tick buffer is not reached.`,
    };
  }
  if (!trigger.isComplete) {
    return { ...base, state: "TRIGGER_CANDLE_ACTIVE", triggerPrice: null, detail: "The immediate-next entry candle (E) is active and has not crossed the patience extreme or opposite invalidation." };
  }
  return { ...base, state: "PATIENCE_CANDLE_EXPIRED", triggerPrice: null, detail: "The immediate-next entry candle (E) closed without reaching the patience confirmation buffer; later candles cannot reuse this pattern." };
}

function patienceShape(candle: Candle, previous: Candle, direction: Direction): boolean {
  return direction === "long" ? candle.high <= previous.high : candle.low >= previous.low;
}

function isStrictlyOutsideNtz(candle: Pick<Candle, "high" | "low" | "close">, direction: Direction, ntz?: NtzRange | null, required = false): boolean {
  if (!ntz?.complete) return !required;
  return direction === "long"
    ? candle.high > ntz.high && candle.close > ntz.high
    : candle.low < ntz.low && candle.close < ntz.low;
}

function directionTrendMatches(direction: Direction, trend: TrendDirection): boolean {
  return direction === "long" ? trend === "bullish" : trend === "bearish";
}

function validateBuffers(tickSize: number, entryBufferTicks: number, stopBufferTicks: number): void {
  if (!Number.isFinite(tickSize) || tickSize <= 0) throw new Error("Patience tick size must be finite and positive.");
  if (!Number.isInteger(entryBufferTicks) || ![3, 4].includes(entryBufferTicks)) throw new Error("Patience entry confirmation buffer must be three or four ticks.");
  if (!Number.isInteger(stopBufferTicks) || stopBufferTicks < 1) throw new Error("Patience stop buffer must be at least one tick.");
}

function roundPrice(price: number, tickSize: number): number {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(10));
}

function formatFiveMinuteWindow(openTime: number): string {
  return `${new Date(openTime).toISOString()}–${new Date(openTime + 5 * 60_000).toISOString()}`;
}

function latestEligibilityBefore(events: readonly PatienceEligibilityEvent[], time: number): PatienceEligibilityEvent | undefined {
  return events.filter((event) => event.time <= time).at(-1);
}

function eligibilityArmId(event: PatienceEligibilityEvent): string {
  return event.eventId
    ?? `eligibility|${event.reason}|${event.time}|${event.levelValue ?? "none"}|${event.detail ?? ""}`;
}

function snapshot(candle: Candle): PatienceCandleSnapshot {
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

function buildPatienceOccurrences(
  candidates: readonly { candle: Candle; index: number; event?: PatienceEligibilityEvent; armId: string | null }[],
  completed: readonly Candle[],
  sorted: readonly Candle[],
  direction: Direction,
  directionSource: PatienceDirectionSource,
  trend: TrendDirection,
  tickSize: number,
  entryBufferTicks: number,
  stopBufferTicks: number,
  intrabarEvidence: readonly IntrabarEvidence[],
  allowOpposingTrend: boolean,
  trendRequired: boolean,
  finalizedNtz: NtzRange | null | undefined,
): PatienceOccurrence[] {
  const armStates = new Map<string, { state: PatienceEligibilityArmState; reason: string }>();
  const occurrences: PatienceOccurrence[] = candidates.map((candidate): PatienceOccurrence => {
    const previous = completed[candidate.index - 1];
    const nextObserved = sorted.find((item) => item.openTime > candidate.candle.openTime);
    const trigger = nextObserved
      && nextObserved.openTime === candidate.candle.closeTime
      && nextObserved.isComplete
      ? nextObserved
      : undefined;
    const laterIntervalObserved = nextObserved
      ? sorted.some((item) => item.openTime > nextObserved.openTime)
      : false;
    const evaluationCursor = trigger?.closeTime
      ?? (!nextObserved
        ? candidate.candle.closeTime
        : nextObserved.openTime !== candidate.candle.closeTime
          ? candidate.candle.closeTime
          : nextObserved.isComplete
            ? nextObserved.closeTime
            : laterIntervalObserved
              ? candidate.candle.closeTime
              : candidate.candle.closeTime);
    const event = candidate.event!;
    const patienceCandleExtreme = direction === "long" ? candidate.candle.low : candidate.candle.high;
    const stopBufferPoints = stopBufferTicks * tickSize;
    const finalStopBoundary = roundPrice(
      direction === "long" ? patienceCandleExtreme - stopBufferPoints : patienceCandleExtreme + stopBufferPoints,
      tickSize,
    );
    const armId = candidate.armId ?? eligibilityArmId(event);
    const arm = armStates.get(armId) ?? { state: "active" as const, reason: "Eligibility context opened by the causal level interaction." };
    const provenance = {
      eventId: event.eventId ?? null,
      reason: event.reason,
      time: event.time,
      detail: event.detail ?? null,
    };
    if (arm.state !== "active") {
      const previous = completed[candidate.index - 1];
      const inactiveDetail = `Eligibility arm ${arm.state}: ${arm.reason}`;
      return {
        occurrenceId: `patience|${direction}|${candidate.candle.openTime}|${trigger?.openTime ?? "none"}`,
        direction,
        directionSource,
        entryBufferTicks,
        stopBufferTicks,
        patienceCandleExtreme,
        stopBufferPoints,
        finalStopBoundary,
        eligibilityReason: event.reason,
        eligibilityTime: event.time,
        eligibilityEventId: event.eventId ?? null,
        previousComparisonTimestamp: previous?.openTime,
        candidateShapeResult: true,
        expectedEntryCandleOpenTime: candidate.candle.closeTime,
        confirmationThreshold: undefined,
        actualConfirmationExcursion: null,
        previousCandle: previous ? snapshot(previous) : snapshot(candidate.candle),
        patienceCandle: snapshot(candidate.candle),
        triggerCandle: null,
        nextObservedCandle: nextObserved ? snapshot(nextObserved) : null,
        outcomeStatus: "INVALIDATED",
        status: "PATIENCE_CANDLE_EXPIRED",
        reasonCode: inactiveDetail,
        evaluationCursor: candidate.candle.closeTime,
        eligibilityArmId: armId,
        eligibilityArmState: arm.state,
        eligibilityArmStateReason: arm.reason,
        eligibilityProvenance: provenance,
      };
    }
    const confirmationThreshold = direction === "long"
      ? roundPrice(candidate.candle.high + entryBufferTicks * tickSize, tickSize)
      : roundPrice(candidate.candle.low - entryBufferTicks * tickSize, tickSize);
    const actualConfirmationExcursion = nextObserved
      ? direction === "long"
        ? Math.max(0, nextObserved.high - candidate.candle.high)
        : Math.max(0, candidate.candle.low - nextObserved.low)
      : null;
    let analysis: PatienceAnalysis;
    if (!previous) {
      analysis = waiting("WAITING_FOR_PATIENCE_CANDLE", "Waiting for a preceding completed candle.", trend, entryBufferTicks, stopBufferTicks, event);
      } else if (trendRequired && !allowOpposingTrend && !directionTrendMatches(direction, trend)) {
      analysis = {
        ...baseAnalysis("PATIENCE_TREND_MISMATCH", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: snapshot(candidate.candle),
        stateTime: candidate.candle.closeTime,
        detail: "The detected patience candle is not aligned with the continuation trend.",
      };
    } else if (!nextObserved) {
      analysis = {
        ...baseAnalysis("PATIENCE_CANDLE_VALID", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: snapshot(candidate.candle),
        triggerCandle: null,
        stateTime: candidate.candle.closeTime,
        detail: "Detected patience candle has no immediately following candle in the visible replay prefix.",
      };
    } else if (!nextObserved.isComplete) {
      analysis = {
        ...baseAnalysis("TRIGGER_CANDLE_ACTIVE", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: snapshot(candidate.candle),
        triggerCandle: null,
        stateTime: nextObserved.openTime,
        detail: "The immediate-next candle (E) is incomplete; it cannot be recorded as a confirmation until its interval is complete.",
      };
    } else if (nextObserved.openTime !== candidate.candle.closeTime) {
      analysis = {
        ...baseAnalysis("PATIENCE_CANDLE_EXPIRED", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: snapshot(candidate.candle),
        triggerCandle: null,
        stateTime: nextObserved.openTime,
        detail: "The immediately following candle is missing; this P→E attempt expired.",
      };
    } else {
      analysis = evaluateTrigger(candidate.candle, previous, nextObserved, direction, event, trend, directionSource, tickSize, entryBufferTicks, stopBufferTicks, intrabarEvidence, finalizedNtz);
    }
    const outcomeStatus: PatienceOccurrenceStatus = !nextObserved
      ? "CANDIDATE"
      : nextObserved.openTime !== candidate.candle.closeTime
        ? "EXPIRED_MISSING_E"
        : !nextObserved.isComplete
          ? laterIntervalObserved ? "EXPIRED_INCOMPLETE_E" : "CANDIDATE"
          : analysis.state === "ENTRY_TRIGGERED"
            ? "CONFIRMED"
            : analysis.state === "OPPOSITE_SIDE_INVALIDATION"
              ? "EXPIRED_WRONG_DIRECTION"
              : analysis.state === "PATIENCE_CANDLE_EXPIRED"
                ? "EXPIRED_NO_IMMEDIATE_CONFIRMATION"
                : analysis.state === "AMBIGUOUS_EVENT_ORDER"
                  ? "INVALIDATED"
                  : "CANDIDATE";
    const qualificationStatus: PatienceOccurrenceQualification = outcomeStatus === "CONFIRMED"
      ? "SIGNAL_CONFIRMED"
      : analysis.state === "OPPOSITE_SIDE_INVALIDATION" || analysis.state === "AMBIGUOUS_EVENT_ORDER"
        ? "STRUCTURALLY_INVALIDATED"
        : "IMMEDIATE_CONFIRMATION_FAILED";
    const stateAfterCandidate: PatienceEligibilityArmState = outcomeStatus === "CONFIRMED"
      ? "consumed"
      : analysis.state === "OPPOSITE_SIDE_INVALIDATION"
        ? "invalidated"
        : "active";
    const stateReason = outcomeStatus === "CONFIRMED"
      ? "Immediate-next E reached the full confirmation buffer; the arm was consumed by signal confirmation."
      : stateAfterCandidate === "invalidated"
        ? analysis.detail
        : "Arm remains active for a later patience candidate until session or structural invalidation.";
    const armTransitionTime = stateAfterCandidate === "consumed"
      ? trigger?.closeTime ?? candidate.candle.closeTime
      : stateAfterCandidate === "invalidated"
        ? analysis.stateTime ?? candidate.candle.closeTime
        : undefined;
    armStates.set(armId, { state: stateAfterCandidate, reason: stateReason });
    return {
      occurrenceId: `patience|${direction}|${candidate.candle.openTime}|${trigger?.openTime ?? "none"}`,
      direction,
      directionSource,
      entryBufferTicks,
      stopBufferTicks,
      patienceCandleExtreme,
      stopBufferPoints,
      finalStopBoundary,
      eligibilityReason: event.reason,
      eligibilityTime: event.time,
      eligibilityEventId: event.eventId ?? null,
      previousComparisonTimestamp: previous.openTime,
      candidateShapeResult: true,
      expectedEntryCandleOpenTime: candidate.candle.closeTime,
      confirmationThreshold,
      actualConfirmationExcursion,
      previousCandle: snapshot(previous),
      patienceCandle: snapshot(candidate.candle),
      triggerCandle: trigger ? snapshot(trigger) : null,
      nextObservedCandle: nextObserved && (nextObserved !== trigger || outcomeStatus !== "CONFIRMED") ? snapshot(nextObserved) : null,
      outcomeStatus,
      qualificationStatus,
      status: analysis.state,
      reasonCode: analysis.detail,
      evaluationCursor,
      eligibilityArmId: armId,
      eligibilityArmState: stateAfterCandidate,
      eligibilityArmStateReason: stateReason,
      eligibilityArmTransitionTime: armTransitionTime,
      eligibilityProvenance: provenance,
    };
  });
  return occurrences.map((occurrence): PatienceOccurrence => {
    if (occurrence.eligibilityArmState !== "active") return occurrence;
    const currentArm = occurrence.eligibilityArmId ? armStates.get(occurrence.eligibilityArmId) : undefined;
    if (currentArm && currentArm.state !== "active") return occurrence;
    const supersedingCandidate = candidates.find((candidate) =>
      candidate.armId !== occurrence.eligibilityArmId
      && candidate.event !== undefined
      && candidate.event.time > occurrence.eligibilityTime,
    );
    if (!supersedingCandidate) return occurrence;
    return {
      ...occurrence,
      eligibilityArmState: "superseded" as const,
      eligibilityArmStateReason: `A newer causal eligibility event superseded arm ${occurrence.eligibilityArmId}.`,
      eligibilityArmTransitionTime: supersedingCandidate.event?.time,
      reasonCode: `Eligibility arm superseded by ${supersedingCandidate.armId ?? "a newer causal event"}.`,
    };
  });
}

function baseAnalysis(
  state: PatienceState,
  eligible: boolean,
  event: PatienceEligibilityEvent,
  trend: TrendDirection,
  entryBufferTicks: number,
  stopBufferTicks: number,
): PatienceAnalysis {
  return {
    state,
    eligible,
    eligibilityReason: event.reason,
    eligibilityTime: event.time,
    trend,
    previousCandle: null,
    patienceCandle: null,
    triggerCandle: null,
    entryBufferTicks,
    entryBufferPrice: null,
    stopBufferTicks,
    strategyStopPrice: null,
    triggerPrice: null,
    stateTime: null,
    detail: "",
  };
}

function waiting(
  state: PatienceState,
  detail: string,
  trend: TrendDirection,
  entryBufferTicks: number,
  stopBufferTicks: number,
  event?: PatienceEligibilityEvent,
): PatienceAnalysis {
  return {
    ...baseAnalysis(state, event !== undefined, event ?? { time: 0, reason: "pullback" }, trend, entryBufferTicks, stopBufferTicks),
    eligibilityReason: event?.reason ?? null,
    eligibilityTime: event?.time ?? null,
    stateTime: event?.time ?? null,
    detail,
  };
}