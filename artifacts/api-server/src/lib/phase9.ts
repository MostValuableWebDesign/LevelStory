import {
  createMarketSnapshot,
  type MarketSnapshot,
} from "./market-data";
import {
  getFuturesContractSpecification,
  type FuturesContractSpecification,
} from "./futures/contracts.js";
import {
  sessionCalendarForContract,
  sessionWindow,
  tradingDateForTimestamp,
  type FuturesSessionCalendar,
} from "./futures/session-calendar.js";
import {
  generateSimulatedFuturesFeed,
  type SimulatedFuturesCandle,
} from "./futures/simulated-feed.js";
import { simulatePhase8ShadowExecution } from "./strategy/phase8.js";
import type { OrbBreakoutState } from "./strategy/phase4.js";
import type { Direction } from "./strategy/types.js";

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
  source?: "simulated" | "historical_databento";
  quotesAvailable?: boolean;
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
  source?: "simulated" | "historical_databento";
  targetDollars?: number;
  slippageMode?: "normal" | "fast" | "abnormal_spread";
};

export type BacktestTrade = {
  id: string;
  tradingDate: string;
  contractSymbol: string;
  contractMonth: string;
  period: "in_sample" | "out_of_sample";
  setupType: string;
  direction: Direction;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  contracts: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  outcome: "target" | "strategy stop" | "catastrophe stop" | "manual";
  ambiguityLabel: "AMBIGUOUS_STOP_FIRST" | "AMBIGUOUS_ENTRY_INVALIDATION" | null;
  source: "tick" | "one-minute" | "ohlc";
  segmentation: BacktestSegmentation;
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
};

export type BacktestSegment = BacktestMetrics & {
  dimension: string;
  value: string;
};

export type BacktestReport = {
  mode: "SHADOW MODE — NO LIVE ORDERS";
  dataSource: "simulated" | "historical_databento";
  symbol: string;
  contract: FuturesContractSpecification;
  dataResolution: "tick" | "one-minute-fallback";
  dataset: {
    startDate: string;
    endDate: string;
    inSampleDates: string[];
    outOfSampleDates: string[];
    untouchedOutOfSample: true;
    optimizationApplied: false;
  };
  replay: ReplayCursor & {
    totalCandleCount: number;
    causal: true;
    futureCandleAccess: false;
  };
  metrics: BacktestMetrics;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  segments: BacktestSegment[];
  trades: BacktestTrade[];
  assumptions: string[];
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
  candle: SimulatedFuturesCandle;
  ticks?: readonly IntrabarPoint[];
  oneMinute?: readonly IntrabarBar[];
}): IntrabarResolution {
  const ticks = [...(input.ticks ?? [])].filter((tick) =>
    tick.timestamp >= input.candle.openTime && tick.timestamp <= input.candle.closeTime,
  ).sort((first, second) => first.timestamp - second.timestamp);
  if (ticks.length) {
    for (const tick of ticks) {
      const hit = touches(input.direction, tick.price, input.target, input.stop);
      if (hit.stop && hit.target) {
        return {
          status: "ambiguous",
          source: "tick",
          timestamp: tick.timestamp,
          price: tick.price,
          ambiguityLabel: "AMBIGUOUS_STOP_FIRST",
          detail: "Tick data touched the stop and target at the same observation; the conservative stop-first policy was applied.",
        };
      }
      if (hit.stop) return { status: "stop", source: "tick", timestamp: tick.timestamp, price: tick.price, ambiguityLabel: null, detail: "Tick data resolved the stop before any target." };
      if (hit.target) return { status: "target", source: "tick", timestamp: tick.timestamp, price: tick.price, ambiguityLabel: null, detail: "Tick data resolved the target." };
    }
    return { status: "open", source: "tick", timestamp: null, price: null, ambiguityLabel: null, detail: "Tick data did not reach a target or stop." };
  }

  const bars = [...(input.oneMinute ?? [])]
    .filter((bar) => bar.openTime >= input.candle.openTime && bar.closeTime <= input.candle.closeTime)
    .sort((first, second) => first.closeTime - second.closeTime);
  if (bars.length) {
    for (const bar of bars) {
      const hit = barTouches(input.direction, bar, input.target, input.stop);
      if (hit.stop && hit.target) {
        return {
          status: "ambiguous",
          source: "one-minute",
          timestamp: bar.closeTime,
          price: input.stop,
          ambiguityLabel: "AMBIGUOUS_STOP_FIRST",
          detail: "One-minute OHLC touched both barriers inside the same minute; the conservative stop-first policy was applied.",
        };
      }
      if (hit.stop) return { status: "stop", source: "one-minute", timestamp: bar.closeTime, price: input.stop, ambiguityLabel: null, detail: "One-minute data resolved the stop." };
      if (hit.target) return { status: "target", source: "one-minute", timestamp: bar.closeTime, price: input.target, ambiguityLabel: null, detail: "One-minute data resolved the target." };
    }
    return { status: "open", source: "one-minute", timestamp: null, price: null, ambiguityLabel: null, detail: "One-minute data did not reach a target or stop." };
  }

  const hit = barTouches(input.direction, input.candle, input.target, input.stop);
  if (hit.stop || hit.target) {
    return {
      status: hit.stop ? "ambiguous" : "target",
      source: "ohlc",
      timestamp: input.candle.closeTime,
      price: hit.stop ? input.stop : input.target,
      ambiguityLabel: hit.stop ? "AMBIGUOUS_STOP_FIRST" : null,
      detail: hit.stop
        ? "Only five-minute OHLC is available and the barrier sequence is unknown; stop-first was applied."
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

function segmentation(snapshot: MarketSnapshot, setupType: string, direction: Direction, candle: SimulatedFuturesCandle): BacktestSegmentation {
  const confluence = snapshot.majorLevels.reduce<BacktestSegmentation["confluence"]>((strongest, level) => {
    const rank = { normal: 0, strong: 1, dynamite: 2 };
    return rank[level.confluence] > rank[strongest] ? level.confluence : strongest;
  }, "normal");
  return {
    contract: snapshot.contract.fullContractSymbol,
    contractMonth: snapshot.contract.contractMonth,
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
  };
}

export function calculateBacktestMetrics(trades: readonly BacktestTrade[], rejectedSetupCount = 0): BacktestMetrics {
  if (!trades.length) return emptyMetrics(rejectedSetupCount);
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }
  const grossWins = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  return {
    tradeCount: trades.length,
    winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
    averageWin: wins.length ? money(grossWins / wins.length) : null,
    averageLoss: losses.length ? money(losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length) : null,
    expectancy: money(trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length),
    profitFactor: grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? null : 0,
    maximumDrawdown: money(maximumDrawdown),
    grossPnl: money(trades.reduce((sum, trade) => sum + trade.grossPnl, 0)),
    fees: money(trades.reduce((sum, trade) => sum + trade.fees, 0)),
    slippage: money(trades.reduce((sum, trade) => sum + trade.slippage, 0)),
    netPnl: money(trades.reduce((sum, trade) => sum + trade.netPnl, 0)),
    ambiguousTradeCount: trades.filter((trade) => trade.ambiguityLabel !== null).length,
    rejectedSetupCount,
  };
}

function buildSegments(trades: readonly BacktestTrade[], rejectedSetupCount: number): BacktestSegment[] {
  const dimensions: Array<keyof BacktestSegmentation> = [
    "contract", "contractMonth", "setupType", "direction", "timeOfDay", "trend",
    "fibonacciDepth", "volumeCondition", "levelType", "confluence", "patienceCharacteristic", "orbState", "marketRegime",
  ];
  return dimensions.flatMap((dimension) => {
    const values = [...new Set(trades.map((trade) => String(trade.segmentation[dimension])))];
    return values.map((value) => {
      const matching = trades.filter((trade) => String(trade.segmentation[dimension]) === value);
      return { dimension, value, ...calculateBacktestMetrics(matching, matching.length ? 0 : rejectedSetupCount) };
    });
  });
}

export function runCausalBacktest(
  request: BacktestRequest,
  riskInput?: { accountSize: number; riskPercent: number; maxDailyLoss: number; dailyLossUsed: number; isLocked: boolean },
  providedDataset?: CausalReplayDataset,
): BacktestReport {
  const specification = getFuturesContractSpecification(request.symbol);
  const calendar = sessionCalendarForContract(specification);
  const dataset = providedDataset ?? buildReplayDataset(request.symbol, request);
  const candles = sortedCandles(dataset.candles);
  const ticks = dataset.ticks ?? [];
  const oneMinute = dataset.oneMinute ?? candles.flatMap(buildSyntheticOneMinuteBars);
  const rejectedByPeriod = { in_sample: 0, out_of_sample: 0 };
  const trades: BacktestTrade[] = [];
  let lastExitIndex = -1;
  let finalReplay: ReplayCursor = { cursor: 0, visibleCandleCount: 0, visibleCandleCloseTime: null, mode: "replay" };

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const tradingDate = tradingDateForTimestamp(candle.openTime, calendar);
    const period = periodForDate(tradingDate, dataset);
    const regularWindow = sessionWindow(tradingDate, "regular", calendar);
    if (!regularWindow || candle.openTime < regularWindow.openTime || candle.openTime >= regularWindow.closeTime) continue;
    const regularOrdinal = Math.round((candle.openTime - regularWindow.openTime) / (5 * MINUTE));
    const isLastRegularCandle = candle.closeTime >= regularWindow.closeTime;
    // A report checkpoint is every 60 minutes. The cursor still exposes only
    // the complete prefix, while this bounded sampling keeps a multi-day
    // report responsive enough for an interactive research surface.
    if (regularOrdinal % 12 !== 0 && !isLastRegularCandle) continue;
    if (!candle.isComplete || !candle.closeTime || lastExitIndex >= index) continue;
    const cursor = createCausalReplay(dataset, candle.closeTime);
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
        allCandles: dataset.candles,
        historicalFeed: dataset.candles,
        premarketAvailable: request.premarketAvailable !== false,
      },
    );
    const evaluations = snapshot.setupAnalysis.evaluations;
    for (const evaluation of evaluations) {
      if (evaluation.decision !== "SETUP QUALIFIED") {
        rejectedByPeriod[period] += 1;
      }
    }
    const selected = evaluations.find((evaluation) => evaluation.decision === "SETUP QUALIFIED" && !evaluation.alertOnly);
    if (!selected?.direction || snapshot.riskPlan.contracts <= 0 || !snapshot.riskPlan.allowed) continue;
    if (dataset.quotesAvailable === false) {
      rejectedByPeriod[period] += 1;
      continue;
    }
    const entryReference = snapshot.riskPlan.entry ?? candle.close;
    const entryResolution = resolveEntryAndInvalidation({
      direction: selected.direction,
      candle,
      entry: entryReference,
      invalidation: snapshot.riskPlan.strategyStop,
      sequenceKnown: true,
    });
    if (entryResolution.status === "ambiguous") {
      rejectedByPeriod[period] += 1;
      continue;
    }
    let exitIndex = index + 1;
    let resolution: IntrabarResolution = { status: "open", source: "ohlc", timestamp: null, price: null, ambiguityLabel: null, detail: "Trade remains open." };
    for (; exitIndex < candles.length; exitIndex += 1) {
      const next = candles[exitIndex];
      if (tradingDateForTimestamp(next.openTime, calendar) !== tradingDate) break;
      resolution = resolveIntrabarOutcome({
        direction: selected.direction,
        target: snapshot.riskPlan.target,
        stop: snapshot.riskPlan.catastropheStop ?? snapshot.riskPlan.strategyStop,
        candle: next,
        ticks,
        oneMinute,
      });
      if (resolution.status !== "open") break;
    }
    const exitCandle = candles[Math.min(exitIndex, candles.length - 1)];
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
      strategyStop: resolution.status === "stop" ? snapshot.riskPlan.strategyStop : null,
      catastropheStop: resolution.status === "stop" ? snapshot.riskPlan.catastropheStop : null,
      specification,
      slippageMode: request.slippageMode,
      observedSpreadTicks: (candle.ask - candle.bid) / specification.tickSize,
    });
    const outcome = resolution.status === "target"
      ? "target"
      : resolution.status === "stop"
        ? snapshot.riskPlan.catastropheStop !== null ? "catastrophe stop" : "strategy stop"
        : "manual";
    const segment = segmentation(snapshot, selected.setupType, selected.direction, candle);
    trades.push({
      id: `${tradingDate}-${index}-${selected.setupType}`,
      tradingDate,
      contractSymbol: specification.fullContractSymbol,
      contractMonth: specification.contractMonth,
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
    });
    lastExitIndex = Math.min(exitIndex, candles.length - 1);
  }

  if (candles.length) {
    finalReplay = createCausalReplay(dataset, candles.at(-1)!.closeTime);
  }
  const inSampleTrades = trades.filter((trade) => trade.period === "in_sample");
  const outOfSampleTrades = trades.filter((trade) => trade.period === "out_of_sample");
  const allMetrics = calculateBacktestMetrics(trades, rejectedByPeriod.in_sample + rejectedByPeriod.out_of_sample);
  return {
    mode: "SHADOW MODE — NO LIVE ORDERS",
    dataSource: dataset.source ?? "simulated",
    symbol: specification.rootSymbol,
    contract: specification,
    dataResolution: dataset.ticks?.length ? "tick" : "one-minute-fallback",
    dataset: {
      startDate: dataset.inSampleDates[0],
      endDate: dataset.outOfSampleDates.at(-1) ?? dataset.inSampleDates.at(-1)!,
      inSampleDates: [...dataset.inSampleDates],
      outOfSampleDates: [...dataset.outOfSampleDates],
      untouchedOutOfSample: true,
      optimizationApplied: false,
    },
    replay: {
      ...finalReplay,
      totalCandleCount: candles.length,
      causal: true,
      futureCandleAccess: false,
    },
    metrics: allMetrics,
    inSample: calculateBacktestMetrics(inSampleTrades, rejectedByPeriod.in_sample),
    outOfSample: calculateBacktestMetrics(outOfSampleTrades, rejectedByPeriod.out_of_sample),
    segments: buildSegments(trades, allMetrics.rejectedSetupCount),
    trades,
    assumptions: [
      "Every strategy decision is recomputed from the visible candle prefix at that historical cursor.",
      "No current or future candle, indicator, volume value, level reaction, or setup state is available before its close time.",
      "Tick observations take precedence over one-minute bars; one-minute bars are the deterministic intrabar fallback.",
      "Unknown entry/invalidation order rejects the setup; unknown stop/target order applies stop first and is labeled AMBIGUOUS_STOP_FIRST.",
      "Each contract month keeps its own tick economics and fees; contract rollover boundaries are never blended.",
      "The out-of-sample dates are immutable holdout data and are not used for optimization.",
      ...(dataset.quotesAvailable === false
        ? ["The selected historical OHLCV file has no bid/ask quotes; descriptive setups ran, but Shadow fills were blocked."]
        : []),
      "This report is simulated futures analysis only. No live or paper order was created.",
    ],
  };
}