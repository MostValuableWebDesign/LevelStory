import type { PullbackAnalysis } from "./phase4.js";
import type { NtzEvent, NtzRange } from "./levels.js";
import type { Candle, Direction } from "./types.js";

export type PatienceState =
  | "WAITING FOR PATIENCE CANDLE"
  | "PATIENCE CANDLE FORMING"
  | "VALID PATIENCE CANDLE"
  | "TRIGGER CANDLE ACTIVE"
  | "ENTRY TRIGGERED"
  | "INVALIDATED"
  | "EXPIRED"
  | "AMBIGUOUS";

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
  patienceCandle: PatienceCandleSnapshot | null;
  triggerCandle: PatienceCandleSnapshot | null;
  triggerPrice: number | null;
  stateTime: number | null;
  detail: string;
};

export type PatienceEngineOptions = {
  eligibilityEvents?: readonly PatienceEligibilityEvent[];
  intrabarEvidence?: readonly IntrabarEvidence[];
};

const PATIENCE_STATES: readonly PatienceState[] = [
  "WAITING FOR PATIENCE CANDLE",
  "PATIENCE CANDLE FORMING",
  "VALID PATIENCE CANDLE",
  "TRIGGER CANDLE ACTIVE",
  "ENTRY TRIGGERED",
  "INVALIDATED",
  "EXPIRED",
  "AMBIGUOUS",
];

export function patienceCandleEngine(
  candles: readonly Candle[],
  direction: Direction,
  options: PatienceEngineOptions = {},
): PatienceAnalysis {
  const sorted = [...candles].sort((first, second) => first.openTime - second.openTime);
  const completed = sorted.filter((candle) => candle.isComplete);
  const eligibility = [...(options.eligibilityEvents ?? [])].sort((first, second) => first.time - second.time);
  if (!eligibility.length) return waiting("No qualifying pullback or consolidation has opened a patience-candle window.");

  const candidates = completed
    .map((candle, index) => ({ candle, index }))
    .filter(({ candle, index }) => {
      const previous = completed[index - 1];
      return previous !== undefined
        && eligibility.some((event) => event.time <= candle.openTime)
        && contained(candle, previous);
    });
  const candidate = candidates.at(-1);
  if (candidate) {
    const event = latestEligibilityBefore(eligibility, candidate.candle.openTime)!;
    const patience = snapshot(candidate.candle);
    const next = sorted.find((candle) => candle.openTime > candidate.candle.openTime);
    if (!next) {
      return {
        state: "VALID PATIENCE CANDLE",
        eligible: true,
        eligibilityReason: event.reason,
        eligibilityTime: event.time,
        patienceCandle: patience,
        triggerCandle: null,
        triggerPrice: null,
        stateTime: candidate.candle.closeTime,
        detail: "Patience candle closed inside the previous completed candle range; only the immediate next candle may trigger.",
      };
    }

    const immediate = next.openTime === candidate.candle.closeTime;
    if (!immediate) {
      return {
        state: "EXPIRED",
        eligible: true,
        eligibilityReason: event.reason,
        eligibilityTime: event.time,
        patienceCandle: patience,
        triggerCandle: snapshot(next),
        triggerPrice: null,
        stateTime: next.openTime,
        detail: "The immediate next five-minute candle was not available; this setup is expired and requires a new patience pattern.",
      };
    }
    return evaluateTrigger(candidate.candle, next, direction, event, options.intrabarEvidence ?? []);
  }

  const forming = sorted.at(-1);
  if (forming && !forming.isComplete && completed.length) {
    const event = latestEligibilityBefore(eligibility, forming.openTime);
    if (event) {
      return {
        state: "PATIENCE CANDLE FORMING",
        eligible: true,
        eligibilityReason: event.reason,
        eligibilityTime: event.time,
        patienceCandle: snapshot(forming),
        triggerCandle: null,
        triggerPrice: null,
        stateTime: forming.openTime,
        detail: "A patience candle is forming; wait for its complete close before validating containment.",
      };
    }
  }

  const event = eligibility.at(-1);
  return event
    ? waiting("A qualifying location was observed; waiting for a completely closed contained candle.", event)
    : waiting("No qualifying pullback or consolidation has opened a patience-candle window.");
}

export function phase5PatienceAnalysis(
  candles: readonly Candle[],
  direction: Direction,
  pullback: PullbackAnalysis,
  ntz: NtzRange | null,
  ntzEvents: readonly NtzEvent[] = [],
): PatienceAnalysis {
  const eligibilityEvents: PatienceEligibilityEvent[] = [
    ...pullback.events
      .filter((event) => ["touch", "proximity", "consolidation", "break and reclaim", "hold"].includes(event.type))
      .map((event) => ({
        time: event.time,
        reason: event.type === "consolidation" ? "consolidation" as const : "pullback" as const,
        detail: `${event.type} at ${event.level}`,
      })),
    ...ntzEvents
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
      if (insideStreak >= 2) {
        eligibilityEvents.push({ time: candle.closeTime, reason: "ntz consolidation", detail: "Extended completed-candle consolidation inside or near NTZ." });
      }
    }
  }
  return patienceCandleEngine(candles, direction, { eligibilityEvents });
}

export function patienceStateLabels(): readonly PatienceState[] {
  return PATIENCE_STATES;
}

function evaluateTrigger(
  patience: Candle,
  trigger: Candle,
  direction: Direction,
  eligibility: PatienceEligibilityEvent,
  evidence: readonly IntrabarEvidence[],
): PatienceAnalysis {
  const intendedPrice = direction === "long" ? patience.high : patience.low;
  const oppositePrice = direction === "long" ? patience.low : patience.high;
  const intendedTouched = direction === "long" ? trigger.high > intendedPrice : trigger.low < intendedPrice;
  const oppositeTouched = direction === "long" ? trigger.low < oppositePrice : trigger.high > oppositePrice;
  const gapIntended = direction === "long" ? trigger.open > intendedPrice : trigger.open < intendedPrice;
  const gapOpposite = direction === "long" ? trigger.open < oppositePrice : trigger.open > oppositePrice;
  const sequence = evidence.find((item) => item.candleOpenTime === trigger.openTime)?.firstBreak;
  const base = {
    eligible: true,
    eligibilityReason: eligibility.reason,
    eligibilityTime: eligibility.time,
    patienceCandle: snapshot(patience),
    triggerCandle: snapshot(trigger),
    stateTime: trigger.openTime,
  };
  if (gapOpposite || sequence === "opposite-first") {
    return { ...base, state: "INVALIDATED", triggerPrice: oppositePrice, detail: "The immediate trigger candle broke the opposite side first; the patience setup cannot recover." };
  }
  if (gapIntended || sequence === "intended-first") {
    return { ...base, state: "ENTRY TRIGGERED", triggerPrice: intendedPrice, detail: "The immediate next candle triggered intrabar in the intended direction; no candle close was required and no order was created." };
  }
  if (intendedTouched && oppositeTouched) {
    return { ...base, state: "AMBIGUOUS", triggerPrice: null, detail: "Both patience-candle boundaries were touched, but available five-minute data cannot prove which occurred first; the setup is rejected." };
  }
  if (oppositeTouched) {
    return { ...base, state: "INVALIDATED", triggerPrice: oppositePrice, detail: "The immediate trigger candle broke the opposite side; a later intended-side cross cannot restore this setup." };
  }
  if (intendedTouched) {
    return { ...base, state: "ENTRY TRIGGERED", triggerPrice: intendedPrice, detail: "The immediate next candle crossed the intended patience-candle boundary intrabar; no order was created." };
  }
  if (!trigger.isComplete) {
    return { ...base, state: "TRIGGER CANDLE ACTIVE", triggerPrice: null, detail: "The immediate five-minute trigger candle is still active and has not crossed either boundary." };
  }
  return { ...base, state: "EXPIRED", triggerPrice: null, detail: "The immediate next candle closed without breaking the intended patience-candle boundary; a new patience pattern is required." };
}

function contained(candle: Candle, previous: Candle): boolean {
  return candle.high <= previous.high && candle.low >= previous.low;
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

function waiting(detail: string, event?: PatienceEligibilityEvent): PatienceAnalysis {
  return {
    state: "WAITING FOR PATIENCE CANDLE",
    eligible: event !== undefined,
    eligibilityReason: event?.reason ?? null,
    eligibilityTime: event?.time ?? null,
    patienceCandle: null,
    triggerCandle: null,
    triggerPrice: null,
    stateTime: event?.time ?? null,
    detail,
  };
}