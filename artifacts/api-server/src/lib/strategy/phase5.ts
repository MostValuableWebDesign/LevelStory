import type { PullbackAnalysis } from "./phase4.js";
import type { NtzEvent, NtzRange } from "./levels.js";
import type { Candle, Direction, TrendDirection } from "./types.js";

export type PatienceState =
  | "WAITING_FOR_VALID_CONTEXT"
  | "WAITING_FOR_LEVEL"
  | "WAITING_FOR_PATIENCE_CANDLE"
  | "PATIENCE_CANDLE_FORMING"
  | "PATIENCE_CANDLE_VALID"
  | "PATIENCE_TREND_MISMATCH"
  | "TRIGGER_CANDLE_ACTIVE"
  | "BREAK_DETECTED_WAITING_FOR_BUFFER"
  | "ENTRY_BUFFER_REACHED"
  | "ENTRY_TRIGGERED"
  | "OPPOSITE_SIDE_INVALIDATION"
  | "PATIENCE_CANDLE_EXPIRED"
  | "AMBIGUOUS_EVENT_ORDER"
  | "RISK_REJECTED";

export type PatienceEligibilityReason = "pullback" | "consolidation" | "ntz consolidation";
export type PatienceEligibilityEvent = { time: number; reason: PatienceEligibilityReason; detail?: string };
export type IntrabarFirstBreak = "intended-first" | "opposite-first" | "ambiguous";
export type IntrabarEvidence = { candleOpenTime: number; firstBreak: IntrabarFirstBreak };

export type PatienceCandleSnapshot = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isComplete: boolean;
};

export type PatienceAnalysis = {
  state: PatienceState;
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
};

export type PatienceEngineOptions = {
  eligibilityEvents?: readonly PatienceEligibilityEvent[];
  intrabarEvidence?: readonly IntrabarEvidence[];
  trend?: TrendDirection;
  tickSize?: number;
  entryBufferTicks?: number;
  stopBufferTicks?: number;
  validContext?: boolean;
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
  const stopBufferTicks = options.stopBufferTicks ?? 1;
  validateBuffers(tickSize, entryBufferTicks, stopBufferTicks);
  const validContext = options.validContext ?? eligibility.length > 0;
  if (!validContext) return waiting("WAITING_FOR_VALID_CONTEXT", "No valid pullback or consolidation context has been recorded.", trend, entryBufferTicks, stopBufferTicks);
  if (!eligibility.length) return waiting("WAITING_FOR_LEVEL", "Valid pullback/consolidation context exists; waiting for a qualifying level interaction.", trend, entryBufferTicks, stopBufferTicks);
  if (trend === "neutral") return waiting("PATIENCE_TREND_MISMATCH", "WAITING — TREND UNCLEAR. A bullish or bearish 15-minute trend is required.", trend, entryBufferTicks, stopBufferTicks, eligibility.at(-1));
  const latestEligibility = eligibility.at(-1)!;
  const candidateIndexes = completed
    .map((candle, index) => ({ candle, index, event: latestEligibilityBefore(eligibility, candle.openTime) }))
    .filter(({ event, candle, index }) => event !== undefined && index > 0 && patienceShape(candle, completed[index - 1], direction));
  const candidate = candidateIndexes.at(-1);
  if (candidate) {
    const previous = completed[candidate.index - 1];
    if (!previous) return waiting("WAITING_FOR_PATIENCE_CANDLE", "Waiting for a preceding completed candle.", trend, entryBufferTicks, stopBufferTicks, candidate.event);
    const event = candidate.event!;
    const shapeValid = patienceShape(candidate.candle, previous, direction);
    const trendValid = directionTrendMatches(direction, trend);
    if (!trendValid || !shapeValid) {
      return {
        ...baseAnalysis("PATIENCE_TREND_MISMATCH", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: snapshot(candidate.candle),
        stateTime: candidate.candle.closeTime,
        detail: !trendValid
          ? `${direction === "long" ? "Bullish" : "Bearish"} patience requires the established ${direction === "long" ? "bullish" : "bearish"} 15-minute trend; current trend is ${trend}.`
          : `Opposing patience shape rejected: ${direction === "long" ? "candidate high must be less than or equal to the preceding high" : "candidate low must be greater than or equal to the preceding low"}. It may feed reversal analysis, not continuation patience.`,
      };
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
      return {
        ...baseAnalysis("PATIENCE_CANDLE_VALID", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: patience,
        entryBufferPrice,
        strategyStopPrice,
        stateTime: candidate.candle.closeTime,
        detail: `Completed ${direction === "long" ? "bullish" : "bearish"} patience candle accepted from exact wick highs/lows; entry waits for a ${entryBufferTicks}-tick confirmation buffer on the immediate next candle.`,
      };
    }
    if (next.openTime !== candidate.candle.closeTime) {
      return {
        ...baseAnalysis("PATIENCE_CANDLE_EXPIRED", true, event, trend, entryBufferTicks, stopBufferTicks),
        previousCandle: snapshot(previous),
        patienceCandle: patience,
        triggerCandle: snapshot(next),
        entryBufferPrice,
        strategyStopPrice,
        stateTime: next.openTime,
        detail: "The immediate next five-minute candle is missing; later candles cannot reuse this patience pattern.",
      };
    }
    return evaluateTrigger(candidate.candle, previous, next, direction, event, trend, tickSize, entryBufferTicks, stopBufferTicks, options.intrabarEvidence ?? []);
  }

  const forming = sorted.at(-1);
  const event = forming ? latestEligibilityBefore(eligibility, forming.openTime) : latestEligibility;
  const latestCompleted = completed.at(-1);
  const latestPrevious = completed.at(-2);
  if (latestCompleted && latestPrevious && event && !patienceShape(latestCompleted, latestPrevious, direction)) {
    return {
      ...baseAnalysis("PATIENCE_TREND_MISMATCH", true, event, trend, entryBufferTicks, stopBufferTicks),
      previousCandle: snapshot(latestPrevious),
      patienceCandle: snapshot(latestCompleted),
      stateTime: latestCompleted.closeTime,
      detail: `Opposing patience shape rejected: ${direction === "long" ? "candidate high must be less than or equal to the preceding high" : "candidate low must be greater than or equal to the preceding low"}. It may feed reversal analysis, not continuation patience.`,
    };
  }
  if (forming && !forming.isComplete && completed.length && event) {
    return {
      ...baseAnalysis("PATIENCE_CANDLE_FORMING", true, event, trend, entryBufferTicks, stopBufferTicks),
      patienceCandle: snapshot(forming),
      stateTime: forming.openTime,
      detail: "A patience candle is forming; wait for its completed close before checking exact wick highs/lows and trend alignment.",
    };
  }
  return waiting("WAITING_FOR_PATIENCE_CANDLE", "A qualifying level is recorded; waiting for a completed trend-aligned patience candle.", trend, entryBufferTicks, stopBufferTicks, latestEligibility);
}

export function phase5PatienceAnalysis(
  candles: readonly Candle[],
  direction: Direction,
  pullback: PullbackAnalysis,
  ntz: NtzRange | null,
  ntzEvents: readonly NtzEvent[] = [],
  minimumEligibilityTime?: number | null,
  trend: TrendDirection = "neutral",
  tickSize = 0.25,
  entryBufferTicks = 4,
  stopBufferTicks = 1,
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
      })),
    ...ntzEvents
      .filter((event) => eligibleAfter === null || event.time >= eligibleAfter)
      .filter((event) => event.type === "Consolidation inside NTZ")
      .map((event) => ({ time: event.time, reason: "ntz consolidation" as const, detail: event.detail })),
  ];
  if (ntz && ntz.complete && candles.length >= 2) {
    const completed = candles.filter((candle) => candle.isComplete).sort((first, second) => first.openTime - second.openTime);
    const proximity = Math.max((ntz.high - ntz.low) * 0.1, 0.01);
    let insideStreak = 0;
    for (const candle of completed) {
      const near = candle.close >= ntz.low - proximity && candle.close <= ntz.high + proximity;
      insideStreak = near ? insideStreak + 1 : 0;
       if (insideStreak >= 2 && (eligibleAfter === null || candle.closeTime >= eligibleAfter)) {
        eligibilityEvents.push({ time: candle.closeTime, reason: "ntz consolidation", detail: "Extended completed-candle consolidation inside or near NTZ." });
      }
    }
  }
  return patienceCandleEngine(candles, direction, {
    eligibilityEvents,
    trend,
    tickSize,
    entryBufferTicks,
    stopBufferTicks,
    validContext: pullback.status === "observed" || (ntz?.complete === true),
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
  tickSize: number,
  entryBufferTicks: number,
  stopBufferTicks: number,
  evidence: readonly IntrabarEvidence[],
): PatienceAnalysis {
  const intendedPrice = direction === "long" ? patience.high : patience.low;
  const oppositePrice = direction === "long" ? patience.low : patience.high;
  const entryBufferPrice = direction === "long"
    ? roundPrice(intendedPrice + entryBufferTicks * tickSize, tickSize)
    : roundPrice(intendedPrice - entryBufferTicks * tickSize, tickSize);
  const strategyStopPrice = direction === "long"
    ? roundPrice(oppositePrice - stopBufferTicks * tickSize, tickSize)
    : roundPrice(oppositePrice + stopBufferTicks * tickSize, tickSize);
  const intendedTouched = direction === "long" ? trigger.high >= intendedPrice : trigger.low <= intendedPrice;
  const bufferReached = direction === "long" ? trigger.high >= entryBufferPrice : trigger.low <= entryBufferPrice;
  const oppositeTouched = direction === "long" ? trigger.low <= oppositePrice : trigger.high >= oppositePrice;
  const gapBuffer = direction === "long" ? trigger.open >= entryBufferPrice : trigger.open <= entryBufferPrice;
  const gapOpposite = direction === "long" ? trigger.open <= oppositePrice : trigger.open >= oppositePrice;
  const sequence = evidence.find((item) => item.candleOpenTime === trigger.openTime)?.firstBreak;
  const base = {
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
  if ((bufferReached && oppositeTouched) || (gapBuffer && gapOpposite) || (intendedTouched && oppositeTouched)) {
    if (sequence === "opposite-first") {
      return { ...base, state: "OPPOSITE_SIDE_INVALIDATION", triggerPrice: oppositePrice, detail: "The immediate trigger candle broke the opposite patience extreme first; the confirmation buffer cannot restore this setup." };
    }
    if (!(sequence === "intended-first" && bufferReached)) {
      return { ...base, state: "AMBIGUOUS_EVENT_ORDER", triggerPrice: null, detail: "The immediate trigger candle reached both the confirmation buffer and the opposite patience extreme, but available candle data cannot prove which occurred first; the setup is rejected." };
    }
  }
  if (gapOpposite || (oppositeTouched && !bufferReached) || sequence === "opposite-first") {
    return { ...base, state: "OPPOSITE_SIDE_INVALIDATION", triggerPrice: oppositePrice, detail: "The immediate trigger candle crossed the opposite patience extreme; a later intended-side move cannot restore this setup." };
  }
  if (bufferReached || gapBuffer) {
    return {
      ...base,
      state: trigger.isComplete ? "ENTRY_TRIGGERED" : "ENTRY_BUFFER_REACHED",
      triggerPrice: entryBufferPrice,
      detail: trigger.isComplete
        ? `The immediate next candle reached the full ${entryBufferTicks}-tick confirmation buffer; shadow entry is triggered at ${entryBufferPrice}.`
        : `The immediate next candle reached the full ${entryBufferTicks}-tick confirmation buffer; shadow entry is pending the completed-candle record.`,
    };
  }
  if (intendedTouched) {
    return {
      ...base,
      state: trigger.isComplete ? "PATIENCE_CANDLE_EXPIRED" : "BREAK_DETECTED_WAITING_FOR_BUFFER",
      triggerPrice: null,
      detail: trigger.isComplete
        ? `The immediate next candle crossed the patience extreme but closed before reaching the full ${entryBufferTicks}-tick confirmation buffer; the setup expired.`
        : `BREAK DETECTED — WAITING FOR CONFIRMATION BUFFER. The raw patience extreme was crossed, but the full ${entryBufferTicks}-tick buffer is not reached.`,
    };
  }
  if (!trigger.isComplete) {
    return { ...base, state: "TRIGGER_CANDLE_ACTIVE", triggerPrice: null, detail: "The immediate five-minute trigger candle is active and has not crossed the patience extreme or opposite invalidation." };
  }
  return { ...base, state: "PATIENCE_CANDLE_EXPIRED", triggerPrice: null, detail: "The immediate next candle closed without reaching the patience confirmation buffer; later candles cannot reuse this pattern." };
}

function patienceShape(candle: Candle, previous: Candle, direction: Direction): boolean {
  return direction === "long" ? candle.high <= previous.high : candle.low >= previous.low;
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

function latestEligibilityBefore(events: readonly PatienceEligibilityEvent[], time: number): PatienceEligibilityEvent | undefined {
  return events.filter((event) => event.time <= time).at(-1);
}

function snapshot(candle: Candle): PatienceCandleSnapshot {
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    isComplete: candle.isComplete,
  };
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