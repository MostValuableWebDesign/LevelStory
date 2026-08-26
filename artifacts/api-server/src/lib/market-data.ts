import {
  candleAlert,
  fullDecision,
  sessionLevels,
  strategyConfig,
  trendEvidence,
  analyzePullback,
  detectInitialBreakout,
  fibonacciAnalysis,
  phase4Volume,
  phase5PatienceAnalysis,
  phase6Analysis,
  type Phase6Analysis,
  type Phase6Decision,
  type SetupType,
  type ManualFibAnchors,
  type PatienceAnalysis,
  type PatienceEligibilityReason,
  type PatienceState,
  type Candle as StrategyCandle,
  type DecisionState,
  type Direction,
  type StrategyConfig,
  buildPhase7RiskPlan,
  type Phase7RiskConfig,
  type Phase7RiskPlan,
  buildPhase8EvaluationRecord,
  type Phase8Execution,
  type Phase8TimelineEvent,
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
  completedSimulatedHourlyCandles,
  generateSimulatedFuturesFeed,
  type SimulatedFuturesCandle,
} from "./futures/simulated-feed.js";
import { SHADOW_MODE_LABEL } from "./modules/shadow-execution.js";
import type { MajorLevel } from "./strategy/major-levels.js";

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
  breakout: {
    detected: boolean;
    direction: Direction | null;
    time: string | null;
    candleOpenTime: string | null;
    distanceOutside: number | null;
    breakoutVolume: number | null;
    baselineVolume: number | null;
    volumeRatio: number | null;
    volumeSupported: boolean;
    detail: string;
  };
  pullback: {
    status: "pending" | "observed" | "expired";
    events: Array<{ type: string; time: string; level: string; price: number; detail: string }>;
    evaluatedCandles: number;
    maxCandles: number;
    maxDurationMinutes: number;
    elapsedMinutes: number;
    proximityTolerance: number | null;
    atr14: number | null;
    qualifyingLevelCount: number;
    detail: string;
  };
  patience: {
    state: PatienceState;
    eligible: boolean;
    eligibilityReason: PatienceEligibilityReason | null;
    eligibilityTime: string | null;
    patienceCandle: PatienceCandleSummary | null;
    triggerCandle: PatienceCandleSummary | null;
    triggerPrice: number | null;
    stateTime: string | null;
    detail: string;
  };
  fibonacci: {
    direction: "bullish" | "bearish" | null;
    impulseLow: number | null;
    impulseHigh: number | null;
    breakoutTime: string | null;
    frozen: boolean;
    frozenAt: string | null;
    manualCorrection: boolean;
    levels: Array<{ name: string; label: string; ratio: number; price: number }>;
    retracementPercent: number | null;
    classification: "shallow" | "normal" | "deep" | "elevated failure risk" | "fully retraced" | "unavailable";
    detail: string;
  };
  volumeAnalysis: {
    baselineCandleCount: number;
    recentSixAverage: number | null;
    breakoutVolume: number | null;
    breakoutRatio: number | null;
    supportingBreakoutVolume: boolean;
    averageImpulseVolume: number | null;
    pullbackAverageVolume: number | null;
    opposingPullbackVolume: number | null;
    reversalWarning: string | null;
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
    emaSlopeWindow: number;
    vwapSessionDate: string;
  };
  majorLevels: MajorLevel[];
  trend: {
    direction: "bullish" | "bearish" | "neutral";
    score: number;
    evidence: string[];
    structure: string;
    candleCount: number;
    evidenceItems: Array<{
      key: "structure" | "vwap" | "ema" | "emaSlope";
      label: string;
      status: "positive" | "negative" | "neutral";
      detail: string;
    }>;
  };
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
    strategyStop: number | null;
    targetDollars: number;
    targetTicks: number;
    targetContracts: number;
    runnerContracts: number;
    stopTicks: number;
    riskPerContract: number;
    slippageMode: string;
    costBreakdown: {
      commission: number;
      exchange: number;
      regulatory: number;
      clearing: number;
      roundTripFees: number;
      entrySlippage: number;
      exitSlippage: number;
      totalSlippage: number;
    };
    projectedTargetPnl: {
      grossPnl: number;
      slippage: number;
      fees: number;
      netPnl: number;
    };
    runner: Phase7RiskPlan["runner"];
    locks: Record<string, boolean>;
  };
  levelStory: Array<{ time: string; level: string; interaction: string; detail: string; eventType: string; status: string }>;
  shadowExecution: Phase8Execution | null;
  reversal: { doji: boolean; equivalentCandles: boolean; warning: string | null };
  setupAnalysis: {
    decision: Phase6Decision;
    primarySetup: SetupType | null;
    explanation: string;
    evaluations: Array<{
      setupType: SetupType;
      direction: Direction | null;
      decision: Phase6Decision;
      mandatoryPassed: boolean;
      alertOnly: boolean;
      rules: Array<{ key: string; label: string; passed: boolean; mandatory: boolean; detail: string }>;
      reversalEvidence: {
        dojiAtMajorLevel: boolean;
        equivalentOpposingCandles: boolean;
        failedBreakout: boolean;
        strongOpposingVolume: boolean;
        deepFibonacciRetracement: boolean;
        majorLevelRejection: boolean;
        structureBreak: boolean;
        alert: boolean;
        detail: string;
      } | null;
      consolidation: {
        detected: boolean;
        candleCount: number;
        durationMinutes: number;
        insideOrNearCount: number;
        range: number | null;
        expansionRatio: number | null;
        startTime: string | null;
        endTime: string | null;
        detail: string;
      } | null;
      explanation: string;
    }>;
  };
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
type Phase7Input = {
  targetDollars?: number;
  slippageMode?: Phase7RiskConfig["slippageMode"];
  observedSpreadTicks?: number;
  liquidity?: number;
  dataAgeSeconds?: number;
  tradesToday?: number;
  duplicateEntry?: boolean;
  averagingDown?: boolean;
};

export type ReplaySnapshotOptions = {
  tradingDate?: string;
  cursor?: number;
  allCandles?: readonly SimulatedFuturesCandle[];
  historicalFeed?: readonly SimulatedFuturesCandle[];
  premarketAvailable?: boolean;
};

export function createMarketSnapshot(
  symbol: string,
  session: string,
  riskInput?: RiskInput,
  manualFibAnchors?: ManualFibAnchors,
  phase7Input?: Phase7Input,
  replayOptions?: ReplaySnapshotOptions,
): MarketSnapshot {
  const specification = getFuturesContractSpecification(symbol);
  const normalized = specification.rootSymbol;
  const config = strategyConfig();
  const calendar = sessionCalendarForContract(specification);
  const tradingDate = replayOptions?.tradingDate ?? CURRENT_TRADING_DATE;
  const premarketAvailable = replayOptions?.premarketAvailable !== false;
  const allCandles = replayOptions?.allCandles
    ? [...replayOptions.allCandles]
    : generateSimulatedFuturesFeed(specification, {
        calendar,
        days: config.simulationDays,
        seed: config.simulationSeed,
        includePremarket: premarketAvailable,
        startDate: tradingDate,
      });
  const historicalFeed = replayOptions?.historicalFeed
    ? [...replayOptions.historicalFeed]
    : generateSimulatedFuturesFeed(specification, {
        calendar,
        days: config.historicalLookbackTradingDays,
        seed: config.simulationSeed,
        includePremarket: false,
        startDate: tradingDate,
      });
  const currentCursor = replayOptions?.cursor ?? (session === "premarket"
    ? timestampForTradingDate(tradingDate, "09:20", calendar)
    : timestampForTradingDate(tradingDate, "13:00", calendar));
  const visible = completedSimulatedCandles(allCandles, currentCursor);
  const historicalHourly = completedSimulatedHourlyCandles(
    completedSimulatedCandles(historicalFeed, currentCursor),
    calendar,
  );
  const currentDay = visible.filter(c => tradingDateForTimestamp(c.openTime, calendar) === tradingDate);
  const premarket = currentDay.filter(c => classifyFuturesSession(c.openTime, calendar) === "premarket");
  const regular = currentDay.filter(c => classifyFuturesSession(c.openTime, calendar) === "regular");
  const levels = sessionLevels(
    visible,
    {
      premarket,
      regular,
       tradingDate,
       premarketAvailable,
      replayCursor: currentCursor,
      historicalHourly,
    },
    config,
    calendar,
    specification,
  );
  const breakout = detectInitialBreakout(regular, levels.ntz, config);
  const fibonacci = fibonacciAnalysis(regular, breakout, manualFibAnchors);
  const qualifyingLevels = [
    ...levels.levels,
    { name: "VWAP", price: levels.vwap, kind: "indicator" },
    { name: "EMA 200", price: levels.ema, kind: "indicator" },
    ...levels.majorLevels.map((level) => ({ name: level.name, price: level.price, kind: level.kind })),
    ...levels.majorLevels
      .filter((level) => level.confluence !== "normal")
      .map((level) => ({ name: `Confluence · ${level.name}`, price: level.price, kind: "confluence" })),
    ...fibonacci.levels.map((level) => ({ name: level.name, price: level.price, kind: "fibonacci" })),
  ];
  const pullback = analyzePullback(regular, breakout, qualifyingLevels, specification, config);
  const volumeAnalysis = phase4Volume(regular, breakout, config);
  const current = regular.at(-1) ?? premarket.at(-1) ?? visible.at(-1);
  const price = current?.close ?? 0;
  const previousClose = levels.previousDayClose ?? Number((price - specification.tickSize * 4).toFixed(2));
  const trend = trendEvidence(regular, levels, config);
  const direction: Direction = trend.direction === "bearish" ? "short" : "long";
  const patienceDirection = breakout.direction ?? direction;
  const patience = phase5PatienceAnalysis(regular, patienceDirection, pullback, levels.ntz, levels.ntzEvents);
  const plan = buildRiskPlan(price, direction, levels, riskInput, config, specification, {
    ...phase7Input,
    observedSpreadTicks: current ? Math.max(0, Math.round((current.ask - current.bid) / specification.tickSize)) : undefined,
    liquidity: current?.volume,
    dataAgeSeconds: 0,
  });
  const hardRiskLock = !!riskInput?.isLocked || (riskInput !== undefined && riskInput.dailyLossUsed >= riskInput.maxDailyLoss);
  const riskGateAllowed = plan.catastropheStop === null ? !hardRiskLock : plan.allowed;
  const reversalDirection: Direction = patienceDirection === "long" ? "short" : "long";
  const reversalPatience = phase5PatienceAnalysis(regular, reversalDirection, pullback, levels.ntz, levels.ntzEvents);
  const setupAnalysis = phase6Analysis({
    candles: regular,
    levels,
    breakout,
    pullback,
    fibonacci,
    volume: volumeAnalysis,
    patience,
    reversalPatience,
    trend,
    riskApproved: riskGateAllowed,
    config,
  });
  const evaluation = fullDecision(regular, levels, config, direction, riskGateAllowed);
  const selectedEvaluation = setupAnalysis.evaluations.find((item) => item.setupType === setupAnalysis.primarySetup)
    ?? setupAnalysis.evaluations[0];
  const phase8Record = buildPhase8EvaluationRecord({
    candles: regular,
    ntz: levels.ntz,
    ntzEvents: levels.ntzEvents,
    breakout,
    pullback,
    fibonacci,
    volume: volumeAnalysis,
    patience,
    evaluation: selectedEvaluation,
    riskPlan: plan,
    direction: selectedEvaluation.direction ?? direction,
    trend: trend.direction,
    specification,
    slippageMode: plan.slippageMode,
    now: currentCursor,
  });
  const story = phase8Record.timeline.map((item: Phase8TimelineEvent) => ({
    time: new Date(item.time).toISOString(),
    level: item.label,
    interaction: item.eventType,
    detail: item.detail,
    eventType: item.eventType,
    status: item.status,
  }));
  const alert = current ? candleAlert(current, direction, config) : { doji: false, reversal: false, detail: "" };
  const indicators = {
    rsi: finiteOrNull(levels.rsi),
    ema200: finiteOrNull(levels.ema),
    emaSlope: finiteOrNull(levels.emaSlope),
    vwap: finiteOrNull(levels.vwap),
    fib236: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.236")?.price),
    fib382: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.382")?.price),
    fib5: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.5")?.price),
    fib618: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.618")?.price),
    fib786: finiteOrNull(levels.fibonacci.find(l => l.name === "Fib 0.786")?.price),
    volumeRatio: finiteOrNull(levels.volumeRatio),
    emaSlopeWindow: config.emaSlopeWindow,
    vwapSessionDate: CURRENT_TRADING_DATE,
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
     breakout: {
       detected: breakout.detected,
       direction: breakout.direction,
       time: breakout.time === null ? null : new Date(breakout.time).toISOString(),
       candleOpenTime: breakout.candleOpenTime === null ? null : new Date(breakout.candleOpenTime).toISOString(),
       distanceOutside: breakout.distanceOutside,
       breakoutVolume: breakout.breakoutVolume,
       baselineVolume: breakout.baselineVolume,
       volumeRatio: breakout.volumeRatio,
       volumeSupported: breakout.volumeSupported,
       detail: breakout.detail,
     },
     pullback: {
       status: pullback.status,
       events: pullback.events.map((event) => ({ ...event, time: new Date(event.time).toISOString() })),
       evaluatedCandles: pullback.evaluatedCandles,
       maxCandles: pullback.maxCandles,
       maxDurationMinutes: pullback.maxDurationMinutes,
       elapsedMinutes: pullback.elapsedMinutes,
       proximityTolerance: pullback.proximityTolerance,
       atr14: pullback.atr14,
       qualifyingLevelCount: pullback.qualifyingLevelCount,
       detail: pullback.detail,
     },
      patience: toApiPatience(patience),
     fibonacci: {
       direction: fibonacci.direction,
       impulseLow: fibonacci.impulseLow,
       impulseHigh: fibonacci.impulseHigh,
       breakoutTime: fibonacci.breakoutTime === null ? null : new Date(fibonacci.breakoutTime).toISOString(),
       frozen: fibonacci.frozen,
       frozenAt: fibonacci.frozenAt === null ? null : new Date(fibonacci.frozenAt).toISOString(),
       manualCorrection: fibonacci.manualCorrection,
       levels: fibonacci.levels,
       retracementPercent: fibonacci.retracementPercent,
       classification: fibonacci.classification,
       detail: fibonacci.detail,
     },
     volumeAnalysis,
    indicators,
     majorLevels: levels.majorLevels,
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
      shadowExecution: phase8Record.execution,
    reversal: {
      doji: alert.doji,
      equivalentCandles: detectEquivalentCandles(regular, config),
       warning: volumeAnalysis.reversalWarning ?? (alert.reversal || evaluation.volume.adverseWarning ? (evaluation.volume.adverseWarning ? "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" : alert.detail) : null),
    },
      setupAnalysis: toApiSetupAnalysis(setupAnalysis),
    assumptions: [
      "Simulation uses America/New_York trading dates with UTC timestamps for deterministic replay.",
      "Premarket is available only when the simulated feed includes 04:00–09:29:59 ET candles.",
      "NTZ/ORB is the exact first three completed five-minute candles from 09:30 through 09:45 ET.",
      `Volume safety uses a ${config.volumeLookback}-candle average and ${config.adverseVolumeRatio.toFixed(2)}x adverse-volume ratio.`,
      `EMA uses ${config.emaPeriod} completed five-minute candles; slope compares ${config.emaSlopeWindow} completed candles.`,
      `VWAP resets at 09:30 ET for each regular session; major levels use ${config.historicalLookbackTradingDays} trading days of hourly reactions.`,
      `Trend classification requires ${config.trendCandleCount} completed 15-minute candles and remains descriptive only.`,
      `Phase 4 breakout support requires ${config.phase4BreakoutVolumeRatio.toFixed(2)}x the previous six completed five-minute candle volume average.`,
      `Phase 4 pullback proximity is the greater of ${config.phase4ProximityTicks} ticks and ${config.phase4ProximityAtrFactor.toFixed(2)} × ${config.phase4AtrPeriod}-period five-minute ATR, bounded to ${config.phase4PullbackMaxCandles} candles / ${config.phase4PullbackMaxMinutes} minutes.`,
      "Patience-candle states are descriptive shadow analysis only; a trigger never creates a live or paper order.",
      "Phase 6 setup decisions require every mandatory rule; scores and reversal alerts cannot qualify a setup.",
      "Doji uses a 10% body-to-range default; equivalent opposing candles use 15% body-size tolerance, 70% minimum body-to-range, and 15% trend-facing-wick limits.",
      `Extended NTZ consolidation requires 9–12 contiguous completed five-minute candles (45–60 minutes), primarily inside or near NTZ, with no more than ${config.phase6ConsolidationExpansionRatio.toFixed(2)}× range expansion.`,
       `Phase 7 uses tick-aligned catastrophe risk, ${plan.targetDollars.toFixed(2)} dollar target selection, whole-contract sizing, and a frozen 40% runner retracement.`,
       `Simulated costs: normal slippage is one adverse tick per fill; abnormal spread mode includes the observed spread. Fees include commission, exchange/regulatory, regulatory, and clearing components.`,
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
  phase7Input?: Phase7Input,
) {
  const risk = input ?? { accountSize: 25_000, riskPercent: 0.5, maxDailyLoss: 500, dailyLossUsed: 0, isLocked: false };
  const edge = direction === "long" ? levels.orb?.high : levels.orb?.low;
  const thesisStop = edge === undefined ? null : roundToTick(direction === "long" ? edge - config.stopBuffer : edge + config.stopBuffer, specification);
  if (thesisStop === null) {
    return buildPhase7RiskPlan(
      entry,
      direction,
      null,
      null,
      phase7Config(risk, config, specification, phase7Input),
      specification,
    );
  }
  const catastropheStop = roundToTick(direction === "long" ? thesisStop - 0.5 : thesisStop + 0.5, specification);
  return buildPhase7RiskPlan(
    entry,
    direction,
    thesisStop,
    catastropheStop,
    phase7Config(risk, config, specification, phase7Input),
    specification,
  );
}

function phase7Config(
  risk: RiskInput,
  config: StrategyConfig,
  specification: FuturesContractSpecification,
  phase7Input?: Phase7Input,
): Phase7RiskConfig {
  const latest = { observedSpreadTicks: 1, liquidity: specification.minimumLiquidity, dataAgeSeconds: 0 };
  return {
    riskDollars: risk.accountSize * risk.riskPercent / 100,
    dailyLossLimit: risk.maxDailyLoss,
    dailyLossUsed: risk.dailyLossUsed,
    tradesToday: phase7Input?.tradesToday ?? 0,
    maxTradesPerDay: config.maxRiskTrades,
    maxContracts: config.phase7MaxContracts,
    maxPositionValue: config.maxPositionValue,
    maximumSpreadTicks: specification.maximumSpreadTicks,
    minimumLiquidity: specification.minimumLiquidity,
    staleDataSeconds: config.phase7StaleDataSeconds,
    observedSpreadTicks: phase7Input?.observedSpreadTicks ?? latest.observedSpreadTicks,
    liquidity: phase7Input?.liquidity ?? latest.liquidity,
    dataAgeSeconds: phase7Input?.dataAgeSeconds ?? latest.dataAgeSeconds,
    emergencyKillSwitch: risk.isLocked,
    duplicateEntry: phase7Input?.duplicateEntry ?? false,
    averagingDown: phase7Input?.averagingDown ?? false,
    slippageMode: phase7Input?.slippageMode ?? "normal",
    normalSlippageTicks: config.phase7NormalSlippageTicks,
    fastSlippageTicks: config.phase7FastSlippageTicks,
    targetDollars: phase7Input?.targetDollars ?? config.phase7DefaultTargetDollars,
  };
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

function toApiSetupAnalysis(analysis: Phase6Analysis): MarketSnapshot["setupAnalysis"] {
  return {
    decision: analysis.decision,
    primarySetup: analysis.primarySetup,
    explanation: analysis.explanation,
    evaluations: analysis.evaluations.map((evaluation) => ({
      setupType: evaluation.setupType,
      direction: evaluation.direction,
      decision: evaluation.decision,
      mandatoryPassed: evaluation.mandatoryPassed,
      alertOnly: evaluation.alertOnly,
      rules: evaluation.rules,
      reversalEvidence: evaluation.reversalEvidence,
      consolidation: evaluation.consolidation
        ? {
            ...evaluation.consolidation,
            startTime: evaluation.consolidation.startTime === null ? null : new Date(evaluation.consolidation.startTime).toISOString(),
            endTime: evaluation.consolidation.endTime === null ? null : new Date(evaluation.consolidation.endTime).toISOString(),
          }
        : null,
      explanation: evaluation.explanation,
    })),
  };
}

type PatienceCandleSummary = {
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  isComplete: boolean;
};

function toApiPatience(analysis: PatienceAnalysis): MarketSnapshot["patience"] {
  return {
    state: analysis.state,
    eligible: analysis.eligible,
    eligibilityReason: analysis.eligibilityReason,
    eligibilityTime: analysis.eligibilityTime === null ? null : new Date(analysis.eligibilityTime).toISOString(),
    patienceCandle: toApiPatienceCandle(analysis.patienceCandle),
    triggerCandle: toApiPatienceCandle(analysis.triggerCandle),
    triggerPrice: analysis.triggerPrice,
    stateTime: analysis.stateTime === null ? null : new Date(analysis.stateTime).toISOString(),
    detail: analysis.detail,
  };
}

function toApiPatienceCandle(candle: PatienceAnalysis["patienceCandle"]): PatienceCandleSummary | null {
  if (!candle) return null;
  return {
    openTime: new Date(candle.openTime).toISOString(),
    closeTime: new Date(candle.closeTime).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    isComplete: candle.isComplete,
  };
}

function finiteOrNull(value: number | undefined) { return value !== undefined && Number.isFinite(value) ? Number(value.toFixed(2)) : null; }
function detectEquivalentCandles(candles: readonly StrategyCandle[], config: StrategyConfig) { const first = candles.at(-2), second = candles.at(-1); if (!first || !second) return false; const a = Math.abs(first.close - first.open), b = Math.abs(second.close - second.open); return a > 0 && Math.abs(a - b) / a <= config.equivalentBodyTolerance && (first.close >= first.open) !== (second.close >= second.open); }
function decisionExplanation(decision: DecisionState, rules: Array<{ label: string; passed: boolean; detail: string }>) { if (decision === "SETUP QUALIFIED") return "Every required market and risk rule passed on completed candles."; if (decision === "RISK LOCKOUT") return rules.find(rule => rule.label === "Risk controls passed")?.detail ?? "Risk controls blocked this setup."; const failed = rules.filter(rule => !rule.passed).map(rule => rule.label); return failed.length ? `${decision}: ${failed.join(", ")}.` : decision; }