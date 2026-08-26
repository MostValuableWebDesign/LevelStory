import {
  candleAlert,
  fullDecision,
  levelStory,
  positionSize,
  sessionLevels,
  strategyConfig,
  trendEvidence,
  type Candle as StrategyCandle,
  type DecisionState,
  type Direction,
  type StrategyConfig,
} from "./strategy/index.js";
import {
  getFuturesContractSpecification,
  roundToTick,
  type FuturesContractSpecification,
} from "./futures/contracts.js";
import {
  classifyFuturesSession,
  sessionCalendarForContract,
  timestampForTradingDate,
  tradingDateForTimestamp,
} from "./futures/session-calendar.js";
import {
  completedSimulatedCandles,
  generateSimulatedFuturesFeed,
  type SimulatedFuturesCandle,
} from "./futures/simulated-feed.js";
import { SHADOW_MODE_LABEL } from "./modules/shadow-execution.js";

export type MarketSnapshot = {
  mode: typeof SHADOW_MODE_LABEL;
  symbol: string;
  company: string;
  contract: FuturesContractSpecification;
  sessionCalendar: {
    timeZone: string;
    tradingDate: string;
    premarketAvailable: boolean;
    premarket: { timeZone: string; start: string; end: string };
    regular: { timeZone: string; start: string; end: string };
    holidays: string[];
    earlyCloses: Record<string, string>;
  };
  price: number;
  change: number;
  changePercent: number;
  marketStatus: "premarket" | "open" | "closed";
  session: string;
  updatedAt: string;
  replay: { cursor: string; visibleCandleCount: number; timeZone: string; barIntervalMinutes: 5 };
  candles: Array<{
    time: string;
    timestamp: string;
    openTime: string;
    closeTime: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isComplete: boolean;
    bid: number;
    ask: number;
    bidSize: number;
    askSize: number;
    contractSymbol: string;
  }>;
  levels: {
    premarketHigh: number | null;
    premarketLow: number | null;
    previousDayHigh: number | null;
    previousDayLow: number | null;
    previousDayClose: number | null;
    dayBeforeYesterdayHigh: number | null;
    dayBeforeYesterdayLow: number | null;
    openingRangeHigh: number | null;
    openingRangeLow: number | null;
    ntzHigh: number | null;
    ntzLow: number | null;
    ntzWidth: number | null;
    vwap: number | null;
    critical: Array<{ name: string; price: number; kind: string }>;
  };
  ntz: {
    status: "pending" | "inside" | "outside";
    phase: "pending" | "forming" | "completed";
    position: "unknown" | "inside" | "outside";
    complete: boolean;
    high: number | null;
    low: number | null;
    events: Array<{ type: string; time: string; detail: string }>;
  };
  indicators: {
    rsi: number | null;
    ema200: number | null;
    emaSlope: number | null;
    vwap: number | null;
    fib236: number | null;
    fib382: number | null;
    fib5: number | null;
    fib618: number | null;
    fib786: number | null;
    volumeRatio: number | null;
  };
  trend: { direction: "bullish" | "bearish" | "neutral"; score: number; evidence: string[]; structure: string };
  signals: Array<{
    key: "orb" | "pullback" | "patience" | "volume";
    label: string;
    status: "confirmed" | "watching" | "blocked";
    detail: string;
  }>;
  decision: {
    state: DecisionState;
    explanation: string;
    passedRules: Array<{ key: string; label: string; detail: string }>;
    failedRules: Array<{ key: string; label: string; detail: string }>;
  };
  riskPlan: {
    direction: Direction;
    entry: number | null;
    thesisStop: number | null;
    catastropheStop: number | null;
    target: number | null;
    contracts: number;
    dollarRisk: number;
    allowed: boolean;
    reasons: string[];
  };
  levelStory: Array<{ time: string; level: string; interaction: string; detail: string }>;
  reversal: { doji: boolean; equivalentCandles: boolean; warning: string | null };
  assumptions: string[];
};

const companies: Record<string, string> = {
  MES: "Micro E-mini S&P 500 Futures",
  ES: "E-mini S&P 500 Futures",
  MNQ: "Micro E-mini Nasdaq-100 Futures",
  NQ: "E-mini Nasdaq-100 Futures",
};

const CURRENT_TRADING_DATE = "2026-08-25";

type RiskInput = { accountSize: number; riskPercent: number; maxDailyLoss: number; dailyLossUsed: number; isLocked: boolean };

export function createMarketSnapshot(symbol: string, session: string, riskInput?: RiskInput): MarketSnapshot {
  const specification = getFuturesContractSpecification(symbol);
  const normalized = specification.rootSymbol;
  const config = strategyConfig();
  const calendar = sessionCalendarForContract(specification);
  const allCandles = generateSimulatedFuturesFeed(specification, {
    calendar,
    days: config.simulationDays,
    seed: config.simulationSeed,
    includePremarket: true,
    startDate: CURRENT_TRADING_DATE,
  });
  const currentCursor = session === "premarket"
    ? timestampForTradingDate(CURRENT_TRADING_DATE, "09:20", calendar)
    : timestampForTradingDate(CURRENT_TRADING_DATE, "13:00", calendar);
  const visible = completedSimulatedCandles(allCandles, currentCursor);
  const currentDay = visible.filter(c => tradingDateForTimestamp(c.openTime, calendar) === CURRENT_TRADING_DATE);
  const premarket = currentDay.filter(c => classifyFuturesSession(c.openTime, calendar) === "premarket");
  const regular = currentDay.filter(c => classifyFuturesSession(c.openTime, calendar) === "regular");
  const levels = sessionLevels(
    visible,
    { premarket, regular, tradingDate: CURRENT_TRADING_DATE, premarketAvailable: true, replayCursor: currentCursor },
    config,
    calendar,
  );
  const current = regular.at(-1) ?? premarket.at(-1) ?? visible.at(-1);
  const price = current?.close ?? 0;
  const previousClose = levels.previousDayClose ?? Number((price - specification.tickSize * 4).toFixed(2));
  const trend = trendEvidence(regular, levels);
  const direction: Direction = trend.direction === "bearish" ? "short" : "long";
  const plan = buildRiskPlan(price, direction, levels, riskInput, config, specification);
  const hardRiskLock = !!riskInput?.isLocked || (riskInput !== undefined && riskInput.dailyLossUsed >= riskInput.maxDailyLoss);
  const riskGateAllowed = plan.catastropheStop === null ? !hardRiskLock : plan.allowed;
  const evaluation = fullDecision(regular, levels, config, direction, riskGateAllowed);
  const story = regular.slice(-10).flatMap(c => levelStory(c, levels.levels, config.levelTolerance).interactions.map(item => ({
    time: new Date(c.closeTime).toISOString(),
    level: item.name,
    interaction: item.interaction,
    detail: `${item.interaction} at ${item.name} (${item.price.toFixed(2)})`,
  })));
  const alert = current ? candleAlert(current, direction, config) : { doji: false, reversal: false, detail: "" };
  const indicators = {
    rsi: finiteOrNull(levels.rsi),
    ema200: finiteOrNull(levels.ema),
    emaSlope: calculateEmaSlope(visible.map(c => c.close), config),
    vwap: finiteOrNull(levels.vwap),
    fib236: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.236")?.price),
    fib382: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.382")?.price),
    fib5: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.5")?.price),
    fib618: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.618")?.price),
    fib786: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.786")?.price),
    volumeRatio: finiteOrNull(levels.volumeRatio),
  };
  const currentLevels = Object.fromEntries(levels.levels.map(level => [level.name, level.price]));
  const ntzStatus = levels.ntzPhase !== "completed"
    ? "pending"
    : levels.ntzPosition === "inside" ? "inside" : "outside";
  const decision = evaluation.decision;
  const signals = evaluation.rules.filter(rule => ["orb", "pullback", "patience", "volume"].includes(rule.key)).map(rule => ({
    key: rule.key as "orb" | "pullback" | "patience" | "volume",
    label: rule.label,
    status: rule.passed ? "confirmed" as const : rule.key === "volume" && evaluation.volume.adverseWarning ? "blocked" as const : "watching" as const,
    detail: rule.detail,
  }));
  const priorLevels = levels.levels.filter(level => !["ORB high", "ORB low", "NTZ high", "NTZ low"].includes(level.name));
  const critical = [...priorLevels, ...levels.fibonacci.filter(level => ["Fib 0.382", "Fib 0.5", "Fib 0.618"].includes(level.name) && Number.isFinite(level.price))].filter(level => Number.isFinite(level.price)).map(level => ({ name: level.name, price: Number(level.price.toFixed(2)), kind: level.kind ?? "reference" }));
  return {
    mode: SHADOW_MODE_LABEL,
    symbol: normalized,
    company: companies[normalized] ?? `${normalized} Holdings`,
    contract: specification,
    sessionCalendar: {
      ...calendar,
      tradingDate: CURRENT_TRADING_DATE,
      premarketAvailable: true,
      holidays: [...calendar.holidays],
      earlyCloses: { ...calendar.earlyCloses },
    },
    price,
    change: Number((price - previousClose).toFixed(2)),
    changePercent: Number((((price - previousClose) / previousClose) * 100).toFixed(2)),
    marketStatus: session === "premarket" ? "premarket" : "open",
    session: session === "premarket" ? "Premarket" : "Regular session / replay",
    updatedAt: new Date(currentCursor).toISOString(),
     replay: { cursor: new Date(currentCursor).toISOString(), visibleCandleCount: visible.length, timeZone: "America/New_York", barIntervalMinutes: config.barIntervalMinutes },
    candles: visible.map(toApiCandle),
    levels: {
      premarketHigh: finiteOrNull(currentLevels["Premarket high"]),
      premarketLow: finiteOrNull(currentLevels["Premarket low"]),
      previousDayHigh: finiteOrNull(currentLevels["Prior day high"]),
      previousDayLow: finiteOrNull(currentLevels["Prior day low"]),
      previousDayClose: previousClose,
      dayBeforeYesterdayHigh: finiteOrNull(currentLevels["Two days ago high"]),
      dayBeforeYesterdayLow: finiteOrNull(currentLevels["Two days ago low"]),
      openingRangeHigh: finiteOrNull(levels.orb?.high),
      openingRangeLow: finiteOrNull(levels.orb?.low),
      ntzHigh: finiteOrNull(levels.ntz?.high),
      ntzLow: finiteOrNull(levels.ntz?.low),
      ntzWidth: levels.ntz ? Number((levels.ntz.high - levels.ntz.low).toFixed(2)) : null,
      vwap: indicators.vwap,
      critical,
    },
     ntz: {
       status: ntzStatus,
       phase: levels.ntzPhase,
       position: levels.ntzPosition,
       complete: levels.ntz?.complete === true,
       high: finiteOrNull(levels.ntz?.high),
       low: finiteOrNull(levels.ntz?.low),
       events: levels.ntzEvents.map((event) => ({
         type: event.type,
         time: new Date(event.time).toISOString(),
         detail: event.detail,
       })),
     },
    indicators,
    trend,
    signals,
    decision: {
      state: decision,
      explanation: decisionExplanation(decision, evaluation.rules),
      passedRules: evaluation.rules.filter(rule => rule.passed).map(({ key, label, detail }) => ({ key, label, detail })),
      failedRules: evaluation.rules.filter(rule => !rule.passed).map(({ key, label, detail }) => ({ key, label, detail })),
    },
    riskPlan: plan,
    levelStory: story,
    reversal: {
      doji: alert.doji,
      equivalentCandles: detectEquivalentCandles(regular, config),
      warning: alert.reversal || evaluation.volume.adverseWarning ? (evaluation.volume.adverseWarning ? "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" : alert.detail) : null,
    },
    assumptions: [
      "Simulation uses America/New_York trading dates with UTC timestamps for deterministic replay.",
      "Premarket is available only when the simulated feed includes 04:00–09:29:59 ET candles.",
      "NTZ/ORB is the exact first three completed five-minute candles from 09:30 through 09:45 ET.",
      `Volume safety uses a ${config.volumeLookback}-candle average and ${config.adverseVolumeRatio.toFixed(2)}x adverse-volume ratio.`,
      `Simulated costs: ${config.spread.toFixed(2)} points spread, ${config.slippage.toFixed(2)} points slippage, $${specification.commissionPerContract.toFixed(2)} commission and $${specification.exchangeAndRegulatoryFeesPerContract.toFixed(2)} exchange/regulatory fees per contract.`,
    ],
  };
}

function buildRiskPlan(
  entry: number,
  direction: Direction,
  levels: ReturnType<typeof sessionLevels>,
  input: RiskInput | undefined,
  config: StrategyConfig,
  specification: FuturesContractSpecification,
) {
  const risk = input ?? { accountSize: 25_000, riskPercent: 0.5, maxDailyLoss: 500, dailyLossUsed: 0, isLocked: false };
  const edge = direction === "long" ? levels.orb?.high : levels.orb?.low;
  const thesisStop = edge === undefined ? null : roundToTick(direction === "long" ? edge - config.stopBuffer : edge + config.stopBuffer, specification);
  const target = direction === "long" ? levels.levels.find(level => level.price > entry + 0.5)?.price : [...levels.levels].reverse().find(level => level.price < entry - 0.5)?.price;
  if (thesisStop === null) return { direction, entry: Number(entry.toFixed(2)), thesisStop, catastropheStop: null, target: target ?? null, contracts: 0, dollarRisk: 0, allowed: false, reasons: ["No completed opening range; catastrophe stop cannot be defined."] };
  const catastropheStop = roundToTick(direction === "long" ? thesisStop - 0.5 : thesisStop + 0.5, specification);
  const plan = positionSize(entry, catastropheStop, risk.accountSize, { dailyLoss: risk.dailyLossUsed, trades: 0, locked: risk.isLocked }, { ...config, riskPerTrade: risk.accountSize * risk.riskPercent / 100, dailyLossLimit: risk.maxDailyLoss }, specification);
  return { direction, entry: Number(entry.toFixed(2)), thesisStop: Number(thesisStop.toFixed(2)), catastropheStop: Number(catastropheStop.toFixed(2)), target: target ? Number(target.toFixed(2)) : null, contracts: plan.contracts, dollarRisk: Number(plan.risk.toFixed(2)), allowed: plan.allowed, reasons: plan.allowed ? ["Risk formula passed; no live order is created."] : [plan.reason] };
}

function toApiCandle(candle: SimulatedFuturesCandle) {
  return {
    time: new Date(candle.openTime).toISOString(),
    timestamp: new Date(candle.timestamp).toISOString(),
    openTime: new Date(candle.openTime).toISOString(),
    closeTime: new Date(candle.closeTime).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    isComplete: candle.isComplete,
    bid: candle.bid,
    ask: candle.ask,
    bidSize: candle.bidSize,
    askSize: candle.askSize,
    contractSymbol: candle.contractSymbol,
  };
}

function finiteOrNull(value: number | undefined) { return value !== undefined && Number.isFinite(value) ? Number(value.toFixed(2)) : null; }
function calculateEmaSlope(values: readonly number[], config: StrategyConfig) { const short = values.slice(-10); if (short.length < 2) return null; const emaValues = short.map((_, index) => { const all = values.slice(0, values.length - short.length + index + 1); return all.length ? all.reduce((sum, value) => sum + value, 0) / all.length : 0; }); return Number((emaValues.at(-1)! - emaValues[0]).toFixed(2)); }
function detectEquivalentCandles(candles: readonly StrategyCandle[], config: StrategyConfig) { const first = candles.at(-2), second = candles.at(-1); if (!first || !second) return false; const a = Math.abs(first.close - first.open), b = Math.abs(second.close - second.open); return a > 0 && Math.abs(a - b) / a <= config.equivalentBodyTolerance && (first.close >= first.open) !== (second.close >= second.open); }
function decisionExplanation(decision: DecisionState, rules: Array<{ label: string; passed: boolean; detail: string }>) { if (decision === "SETUP QUALIFIED") return "Every required market and risk rule passed on completed candles."; if (decision === "RISK LOCKOUT") return rules.find(rule => rule.label === "Risk controls passed")?.detail ?? "Risk controls blocked this setup."; const failed = rules.filter(rule => !rule.passed).map(rule => rule.label); return failed.length ? `${decision}: ${failed.join(", ")}.` : decision; }