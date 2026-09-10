import {
  DEFAULT_FUTURES_SESSION_CALENDAR,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "../futures/session-calendar.js";
import type { StrategyConfig } from "./config.js";
import type { Candle, Direction } from "./types.js";

export type OrbTrendState =
  | "NEUTRAL"
  | "BULLISH_ORB_TREND"
  | "BEARISH_ORB_TREND";

export type OrbTrendBoundary = "ORB_HIGH" | "ORB_LOW";

export type OrbTrendTransition = {
  previousState: OrbTrendState;
  newState: Exclude<OrbTrendState, "NEUTRAL">;
  direction: Direction;
  epochId: string;
  finalizedOrbHigh: number;
  finalizedOrbLow: number;
  confirmationBufferTicks: number;
  confirmationBufferPoints: number;
  confirmingCandle: {
    openTime: number;
    closeTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  boundaryCrossed: OrbTrendBoundary;
  effectiveFromTimestamp: number;
  expiredArmIds: string[];
  expiredCandidateIds: string[];
  expirationReason: "ORB_TREND_REVERSED" | null;
  activePositionBlocked: boolean;
  formulaVersion: string;
  strategyVersion: string;
};

export type OrbTrendAnalysis = {
  state: OrbTrendState;
  direction: Direction | null;
  epochId: string | null;
  finalizedOrbHigh: number | null;
  finalizedOrbLow: number | null;
  finalizedAt: number | null;
  confirmationBufferTicks: number;
  confirmationBufferPoints: number;
  transitions: OrbTrendTransition[];
  trendDirectionAt: (candleOpenTime: number) => Direction | null;
  trendStateAt: (candleOpenTime: number) => OrbTrendState;
  epochIdAt: (candleOpenTime: number) => string | null;
};

type FinalizedOrb = {
  high: number;
  low: number;
  completedAt: number;
};

type OrbTrendOptions = {
  contractSymbol?: string | null;
  tradingDate?: string;
  calendar?: FuturesSessionCalendar;
  tickSize?: number;
  formulaVersion?: string;
  strategyVersion?: string;
  activePositionAt?: (timestamp: number) => boolean;
};

const EMPTY_ORB_TREND: OrbTrendAnalysis = {
  state: "NEUTRAL",
  direction: null,
  epochId: null,
  finalizedOrbHigh: null,
  finalizedOrbLow: null,
  finalizedAt: null,
  confirmationBufferTicks: 0,
  confirmationBufferPoints: 0,
  transitions: [],
  trendDirectionAt: () => null,
  trendStateAt: () => "NEUTRAL",
  epochIdAt: () => null,
};

export function evaluateOrbTrend(
  candles: readonly Candle[],
  ntz: { high: number; low: number; completedAt?: number | null; complete?: boolean } | null | undefined,
  config: StrategyConfig,
  options: OrbTrendOptions = {},
): OrbTrendAnalysis {
  if (
    !ntz
    || ntz.complete === false
    || !Number.isFinite(ntz.high)
    || !Number.isFinite(ntz.low)
  ) {
    return EMPTY_ORB_TREND;
  }

  const completed = candles
    .filter((candle) => candle.isComplete)
    .sort((left, right) => left.openTime - right.openTime);
  const finalizedAt = ntz.completedAt ?? completed[2]?.closeTime;
  if (!Number.isFinite(finalizedAt)) return EMPTY_ORB_TREND;

  const bufferTicks = config.orbTrendConfirmationBufferTicks;
  const tickSize = options.tickSize ?? 0.25;
  const bufferPoints = bufferTicks * tickSize;
  const finalized: FinalizedOrb = {
    high: ntz.high,
    low: ntz.low,
    completedAt: finalizedAt!,
  };
  const afterOrb = completed.filter((candle) => candle.openTime >= finalized.completedAt);
  let state: OrbTrendState = "NEUTRAL";
  let epochOrdinal = 0;
  const transitions: OrbTrendTransition[] = [];
  for (const candle of afterOrb) {
    const closesAbove = candle.close >= finalized.high + bufferPoints;
    const closesBelow = candle.close <= finalized.low - bufferPoints;
    const nextDirection: Direction | null = closesAbove === closesBelow
      ? null
      : closesAbove ? "long" : "short";

    const shouldTransition = nextDirection !== null
      && (state === "NEUTRAL"
        || (state === "BULLISH_ORB_TREND" && nextDirection === "short")
        || (state === "BEARISH_ORB_TREND" && nextDirection === "long"));
    if (!shouldTransition) continue;
    if (state !== "NEUTRAL" && !config.orbTrendReversalEnabled) continue;

    const nextState: Exclude<OrbTrendState, "NEUTRAL"> = nextDirection === "long"
      ? "BULLISH_ORB_TREND"
      : "BEARISH_ORB_TREND";
    const epochId = [
      "orb-trend",
      options.contractSymbol ?? "contract-unknown",
      options.tradingDate ?? tradingDateForTimestamp(candle.openTime, options.calendar ?? DEFAULT_FUTURES_SESSION_CALENDAR),
      String(epochOrdinal + 1),
      nextState,
      candle.openTime,
    ].join("|");
    epochOrdinal += 1;
    const transition: OrbTrendTransition = {
      previousState: state,
      newState: nextState,
      direction: nextDirection,
      epochId,
      finalizedOrbHigh: finalized.high,
      finalizedOrbLow: finalized.low,
      confirmationBufferTicks: bufferTicks,
      confirmationBufferPoints: bufferPoints,
      confirmingCandle: {
        openTime: candle.openTime,
        closeTime: candle.closeTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      },
      boundaryCrossed: nextDirection === "long" ? "ORB_HIGH" : "ORB_LOW",
      effectiveFromTimestamp: candle.closeTime,
      expiredArmIds: [],
      expiredCandidateIds: [],
      expirationReason: state === "NEUTRAL" ? null : "ORB_TREND_REVERSED",
      activePositionBlocked: options.activePositionAt?.(candle.closeTime) ?? false,
      formulaVersion: options.formulaVersion ?? "orb-trend-state-machine-v1",
      strategyVersion: options.strategyVersion ?? "orb-trend-state-machine-v1",
    };
    transitions.push(transition);
    state = nextState;
  }

  const stateAt = (candleOpenTime: number) => {
    let selected: {
      state: OrbTrendState;
      direction: Direction | null;
      epochId: string | null;
    } = { state: "NEUTRAL", direction: null, epochId: null };
    for (const transition of transitions) {
      if (transition.effectiveFromTimestamp > candleOpenTime) break;
      selected = {
        state: transition.newState,
        direction: transition.direction,
        epochId: transition.epochId,
      };
    }
    return selected;
  };
  const latest = completed.at(-1);
  const current = latest ? stateAt(latest.openTime) : { state: "NEUTRAL" as const, direction: null, epochId: null };
  return {
    state: current.state,
    direction: current.direction,
    epochId: current.epochId,
    finalizedOrbHigh: finalized.high,
    finalizedOrbLow: finalized.low,
    finalizedAt: finalized.completedAt,
    confirmationBufferTicks: bufferTicks,
    confirmationBufferPoints: bufferPoints,
    transitions,
    trendDirectionAt: (candleOpenTime) => stateAt(candleOpenTime).direction,
    trendStateAt: (candleOpenTime) => stateAt(candleOpenTime).state,
    epochIdAt: (candleOpenTime) => stateAt(candleOpenTime).epochId,
  };
}

function directionForState(state: OrbTrendState): Direction | null {
  return state === "BULLISH_ORB_TREND" ? "long" : state === "BEARISH_ORB_TREND" ? "short" : null;
}