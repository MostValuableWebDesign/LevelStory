import {
  candleAlert,
  completedCandles,
  fullDecision,
  levelStory,
  positionSize,
  sessionLevels,
  simulateFill,
  strategyConfig,
  trendEvidence,
  type Candle as StrategyCandle,
  type DecisionState,
  type Direction,
  type RiskState,
  type StrategyConfig,
} from "./strategy/index.js";

export type MarketSnapshot = {
  symbol: string;
  company: string;
  price: number;
  change: number;
  changePercent: number;
  marketStatus: "premarket" | "open" | "closed";
  session: string;
  updatedAt: string;
  replay: { cursor: string; visibleCandleCount: number; timeZone: string };
  candles: Array<{
    time: string;
    openTime: string;
    closeTime: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isComplete: boolean;
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
  ntz: { status: "pending" | "inside" | "outside"; complete: boolean };
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
    shares: number;
    dollarRisk: number;
    allowed: boolean;
    reasons: string[];
  };
  levelStory: Array<{ time: string; level: string; interaction: string; detail: string }>;
  reversal: { doji: boolean; equivalentCandles: boolean; warning: string | null };
  assumptions: string[];
};

const companies: Record<string, string> = {
  AAPL: "Apple Inc.",
  NVDA: "NVIDIA Corporation",
  TSLA: "Tesla, Inc.",
  AMD: "Advanced Micro Devices",
  SPY: "SPDR S&P 500 ETF Trust",
};

const CURRENT_DAY = Date.UTC(2026, 7, 25);
const MINUTE = 60_000;
const DAY = 86_400_000;
const SESSION_START = 9 * 60 + 30;
const PREMARKET_START = 4 * 60;
const SESSION_END = 16 * 60;

type RiskInput = { accountSize: number; riskPercent: number; maxDailyLoss: number; dailyLossUsed: number; isLocked: boolean };

export function createMarketSnapshot(symbol: string, session: string, riskInput?: RiskInput): MarketSnapshot {
  const normalized = symbol.trim().toUpperCase();
  const base = normalized === "NVDA" ? 183.42 : normalized === "TSLA" ? 344.18 : normalized === "AMD" ? 174.26 : normalized === "SPY" ? 646.32 : 126.84;
  const config = strategyConfig();
  const allCandles = generateSimulation(base);
  const currentCursor = session === "premarket"
    ? timestamp(CURRENT_DAY, 9 * 60 + 20)
    : timestamp(CURRENT_DAY, 13 * 60);
  const visible = completedCandles({ candles: allCandles, cursor: currentCursor });
  const currentDay = visible.filter(c => sameDay(c.openTime, CURRENT_DAY));
  const premarket = currentDay.filter(c => minuteOfDay(c.openTime) >= PREMARKET_START && minuteOfDay(c.openTime) < SESSION_START);
  const regular = currentDay.filter(c => minuteOfDay(c.openTime) >= SESSION_START && minuteOfDay(c.openTime) < SESSION_END);
  const levels = sessionLevels(visible, { premarket, regular }, config);
  const current = regular.at(-1) ?? premarket.at(-1) ?? visible.at(-1);
  const price = current?.close ?? base;
  const previousClose = findPreviousClose(visible, CURRENT_DAY) ?? Number((base - 1.84).toFixed(2));
  const trend = trendEvidence(regular, levels);
  const direction: Direction = trend.direction === "bearish" ? "short" : "long";
  const plan = buildRiskPlan(price, direction, levels, riskInput, config);
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
  const ntzStatus = !levels.ntz ? "pending" : !current ? "pending" : current.close > levels.ntz.high || current.close < levels.ntz.low ? "outside" : "inside";
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
    symbol: normalized,
    company: companies[normalized] ?? `${normalized} Holdings`,
    price,
    change: Number((price - previousClose).toFixed(2)),
    changePercent: Number((((price - previousClose) / previousClose) * 100).toFixed(2)),
    marketStatus: session === "premarket" ? "premarket" : "open",
    session: session === "premarket" ? "Premarket" : "Regular session / replay",
    updatedAt: new Date(currentCursor).toISOString(),
    replay: { cursor: new Date(currentCursor).toISOString(), visibleCandleCount: visible.length, timeZone: "UTC exchange-local simulation" },
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
    ntz: { status: ntzStatus, complete: !!levels.ntz },
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
      "Simulation uses UTC as exchange-local time for deterministic replay.",
      `NTZ is the first completed ${config.ntzMinutes}-minute regular-session candle.`,
      `Volume safety uses a ${config.volumeLookback}-candle average and ${config.adverseVolumeRatio.toFixed(2)}x adverse-volume ratio.`,
      `Simulated costs: $${config.spread.toFixed(2)} spread, $${config.slippage.toFixed(2)} slippage, $${config.feePerShare.toFixed(3)} per share.`,
    ],
  };
}

function generateSimulation(base: number): StrategyCandle[] {
  const candles: StrategyCandle[] = [];
  for (let dayOffset = -3; dayOffset <= 0; dayOffset++) {
    const day = CURRENT_DAY + dayOffset * DAY;
    if (dayOffset === 0) {
      for (let minute = PREMARKET_START; minute < SESSION_START; minute += 5) candles.push(makeCandle(day, minute, base, dayOffset, true));
    }
    for (let minute = SESSION_START; minute < SESSION_END; minute += 5) candles.push(makeCandle(day, minute, base, dayOffset, true));
  }
  return candles;
}

function makeCandle(day: number, minute: number, base: number, dayOffset: number, complete: boolean): StrategyCandle {
  const index = Math.max(0, Math.round((minute - SESSION_START) / 5));
  const premarket = minute < SESSION_START;
  const dayBias = dayOffset * -0.42;
  let close = base + dayBias;
  if (premarket) close += 0.12 + Math.sin(index / 3) * 0.34;
  else if (dayOffset === 0 && index < 3) close += Math.sin(index) * 0.08;
  else if (dayOffset === 0 && index < 9) close += 0.35 + (index - 2) * 0.16;
  else if (dayOffset === 0 && index < 14) close += 1.32 - (index - 9) * 0.12;
  else close += 1.0 + index * 0.035 + Math.sin(index / 2.8) * 0.22;
  close = Number(close.toFixed(2));
  const open = Number((close - (Math.sin(index * 1.7 + dayOffset) * 0.22)).toFixed(2));
  const high = Number((Math.max(open, close) + 0.18 + (index % 3) * 0.03).toFixed(2));
  const low = Number((Math.min(open, close) - 0.16 - (index % 2) * 0.03).toFixed(2));
  const openTime = timestamp(day, minute);
  return { openTime, closeTime: openTime + 5 * MINUTE, open, high, low, close, volume: 120_000 + Math.max(index, 0) * 4_200 + (index % 5) * 13_000 + (dayOffset === 0 && index >= 3 && index < 9 ? 90_000 : 0), isComplete: complete };
}

function buildRiskPlan(entry: number, direction: Direction, levels: ReturnType<typeof sessionLevels>, input: RiskInput | undefined, config: StrategyConfig) {
  const risk = input ?? { accountSize: 25_000, riskPercent: 0.5, maxDailyLoss: 500, dailyLossUsed: 0, isLocked: false };
  const edge = direction === "long" ? levels.orb?.high : levels.orb?.low;
  const thesisStop = edge === undefined ? null : direction === "long" ? edge - config.stopBuffer : edge + config.stopBuffer;
  const target = direction === "long" ? levels.levels.find(level => level.price > entry + 0.5)?.price : [...levels.levels].reverse().find(level => level.price < entry - 0.5)?.price;
  if (thesisStop === null) return { direction, entry: Number(entry.toFixed(2)), thesisStop, catastropheStop: null, target: target ?? null, shares: 0, dollarRisk: 0, allowed: false, reasons: ["No completed opening range; catastrophe stop cannot be defined."] };
  const catastropheStop = direction === "long" ? thesisStop - 0.5 : thesisStop + 0.5;
  const plan = positionSize(entry, catastropheStop, risk.accountSize, { dailyLoss: risk.dailyLossUsed, trades: 0, locked: risk.isLocked }, { ...config, riskPerTrade: risk.accountSize * risk.riskPercent / 100, dailyLossLimit: risk.maxDailyLoss });
  return { direction, entry: Number(entry.toFixed(2)), thesisStop: Number(thesisStop.toFixed(2)), catastropheStop: Number(catastropheStop.toFixed(2)), target: target ? Number(target.toFixed(2)) : null, shares: plan.shares, dollarRisk: Number(plan.risk.toFixed(2)), allowed: plan.allowed, reasons: plan.allowed ? ["Risk formula passed; no live order is created."] : [plan.reason] };
}

function toApiCandle(candle: StrategyCandle) {
  return { time: new Date(candle.openTime).toISOString(), openTime: new Date(candle.openTime).toISOString(), closeTime: new Date(candle.closeTime).toISOString(), open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, isComplete: candle.isComplete };
}

function timestamp(day: number, minute: number) { return day + minute * MINUTE; }
function sameDay(value: number, day: number) { return Math.floor(value / DAY) === Math.floor(day / DAY); }
function minuteOfDay(value: number) { const date = new Date(value); return date.getUTCHours() * 60 + date.getUTCMinutes(); }
function finiteOrNull(value: number | undefined) { return value !== undefined && Number.isFinite(value) ? Number(value.toFixed(2)) : null; }
function findPreviousClose(candles: readonly StrategyCandle[], currentDay: number) { return candles.filter(c => c.openTime < currentDay).at(-1)?.close; }
function calculateEmaSlope(values: readonly number[], config: StrategyConfig) { const short = values.slice(-10); if (short.length < 2) return null; const emaValues = short.map((_, index) => { const all = values.slice(0, values.length - short.length + index + 1); return all.length ? all.reduce((sum, value) => sum + value, 0) / all.length : 0; }); return Number((emaValues.at(-1)! - emaValues[0]).toFixed(2)); }
function detectEquivalentCandles(candles: readonly StrategyCandle[], config: StrategyConfig) { const first = candles.at(-2), second = candles.at(-1); if (!first || !second) return false; const a = Math.abs(first.close - first.open), b = Math.abs(second.close - second.open); return a > 0 && Math.abs(a - b) / a <= config.equivalentBodyTolerance && (first.close >= first.open) !== (second.close >= second.open); }
function decisionExplanation(decision: DecisionState, rules: Array<{ label: string; passed: boolean; detail: string }>) { if (decision === "SETUP QUALIFIED") return "Every required market and risk rule passed on completed candles."; if (decision === "RISK LOCKOUT") return rules.find(rule => rule.label === "Risk controls passed")?.detail ?? "Risk controls blocked this setup."; const failed = rules.filter(rule => !rule.passed).map(rule => rule.label); return failed.length ? `${decision}: ${failed.join(", ")}.` : decision; }