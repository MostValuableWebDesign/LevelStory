import {
  sessionLevels,
  strategyConfig,
  trendEvidence,
  analyzePullback,
  advanceOrbBreakoutState,
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
  type DecisionState,
  type Direction,
  type StrategyConfig,
  type OrbBreakoutState,
  type BreakoutContinuationCondition,
  buildPhase7RiskPlan,
  type Phase7RiskConfig,
  type Phase7RiskPlan,
  buildPhase8EvaluationRecord,
  type Phase8Execution,
  type Phase8TimelineEvent,
  assertDashboardInvariants,
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
    state: OrbBreakoutState;
    time: string | null;
    candleOpenTime: string | null;
    candidateTime: string | null;
    candidateCandleOpenTime: string | null;
    distanceOutside: number | null;
    meaningfulDistance: number | null;
    breakoutVolume: number | null;
    baselineVolume: number | null;
    volumeRatio: number | null;
    volumeSupported: boolean;
    bodyRatio: number | null;
    closeLocationRatio: number | null;
    candleStructureSupported: boolean;
    continuationConfirmed: boolean;
    continuationCondition: BreakoutContinuationCondition | null;
    failed: boolean;
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
    trend: "bullish" | "bearish" | "neutral";
    previousCandle: PatienceCandleSummary | null;
    patienceCandle: PatienceCandleSummary | null;
    triggerCandle: PatienceCandleSummary | null;
    entryBufferTicks: number;
    entryBufferPrice: number | null;
    stopBufferTicks: number;
    strategyStopPrice: number | null;
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
    direction: Direction | null;
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

export function selectExecutableDirection(
  setupAnalysis: Pick<Phase6Analysis, "evaluations">,
  breakout: { detected: boolean; failed: boolean; direction: Direction | null },
  patienceDirection: Direction | null,
): Direction | null {
  const qualifiedSetupDirection = setupAnalysis.evaluations.find((item) =>
    item.decision === "SETUP QUALIFIED" && !item.alertOnly && item.direction !== null)?.direction ?? null;
  const qualifiedBreakoutDirection = breakout.detected && !breakout.failed ? breakout.direction : null;
  return qualifiedSetupDirection ?? qualifiedBreakoutDirection ?? patienceDirection;
}

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
  const breakout = detectInitialBreakout(regular, levels.ntz, config, specification);
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
  const trendDirection: Direction | null = trend.direction === "bullish"
    ? "long"
    : trend.direction === "bearish"
      ? "short"
      : null;
  const patienceDirection = breakout.direction ?? trendDirection;
  const patience = phase5PatienceAnalysis(
    regular,
    patienceDirection,
    pullback,
    levels.ntz,
    levels.ntzEvents,
    breakout.detected ? breakout.time : Number.POSITIVE_INFINITY,
    trend.direction,
    specification.tickSize,
    config.patienceEntryBufferTicks,
    config.patienceStopBufferTicks,
  );
  const evaluatedBreakout = advanceOrbBreakoutState(breakout, pullback, patience.state);
  const preliminarySetupAnalysis = phase6Analysis({
    candles: regular,
    levels,
    breakout: evaluatedBreakout,
    pullback,
    fibonacci,
    volume: volumeAnalysis,
    patience,
    reversalPatience: patience,
    trend,
    riskApproved: true,
    config,
  });
  const direction = selectExecutableDirection(preliminarySetupAnalysis, evaluatedBreakout, patienceDirection);
  const plan = buildRiskPlan(direction, levels, patience, riskInput, config, specification, {
    ...phase7Input,
    observedSpreadTicks: current ? Math.max(0, Math.round((current.ask - current.bid) / specification.tickSize)) : undefined,
    liquidity: current?.volume,
    dataAgeSeconds: 0,
  });
  const reversalDirection: Direction | null = patienceDirection === null
    ? null
    : patienceDirection === "long" ? "short" : "long";
  const reversalPatience = phase5PatienceAnalysis(regular, reversalDirection, pullback, levels.ntz, levels.ntzEvents, undefined, trend.direction, specification.tickSize, config.patienceEntryBufferTicks, config.patienceStopBufferTicks);
  const setupAnalysis = phase6Analysis({
    candles: regular,
    levels,
    breakout: evaluatedBreakout,
    pullback,
    fibonacci,
    volume: volumeAnalysis,
    patience,
    reversalPatience,
    trend,
    riskApproved: plan.allowed,
    config,
  });
  const selectedEvaluation = setupAnalysis.evaluations.find((item) => item.setupType === setupAnalysis.primarySetup)
    ?? setupAnalysis.evaluations[0];
  const phase8Record = buildPhase8EvaluationRecord({
    candles: regular,
    ntz: levels.ntz,
    ntzEvents: levels.ntzEvents,
    breakout: evaluatedBreakout,
    pullback,
    fibonacci,
    volume: volumeAnalysis,
    patience,
    evaluation: selectedEvaluation,
    riskPlan: plan,
    direction: plan.direction,
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
  const signals = phasedSignals(evaluatedBreakout, levels.ntz?.complete === true, pullback, patience, volumeAnalysis);
  const decisionProjection = phasedDecision(setupAnalysis, selectedEvaluation, plan, evaluatedBreakout, phase8Record.execution);
  const riskExplanation = plan.allowed ? "" : ` Risk plan blocked: ${plan.reasons.join(" ")}`;
  const publicSetupAnalysis = { ...setupAnalysis, explanation: `${setupAnalysis.explanation}${riskExplanation}` };
  const passedRules = phase8Record.passedRules.map(({ key, label, detail }) => ({ key, label, detail }));
  const failedRules = phase8Record.failedRules.map(({ key, label, detail }) => ({ key, label, detail }));
  const reversalEvaluation = setupAnalysis.evaluations.find((item) => item.setupType === "BONUS_REVERSAL");
  const reversalEvidence = reversalEvaluation?.reversalEvidence;
  const reversal = {
    doji: reversalEvidence?.dojiAtMajorLevel ?? false,
    equivalentCandles: reversalEvidence?.equivalentOpposingCandles ?? false,
    warning: volumeAnalysis.reversalWarning ?? (reversalEvidence?.alert ? reversalEvidence.detail : null),
  };
  const priorLevels = levels.levels.filter(level => !["ORB high", "ORB low", "NTZ high", "NTZ low"].includes(level.name));
  const critical = [...priorLevels, ...levels.fibonacci.filter(level => ["Fib 0.382", "Fib 0.5", "Fib 0.618"].includes(level.name) && Number.isFinite(level.price))].filter(level => Number.isFinite(level.price)).map(level => ({ name: level.name, price: Number(level.price.toFixed(2)), kind: level.kind ?? "reference" }));
  const snapshot: MarketSnapshot = {
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
         detected: evaluatedBreakout.detected,
        direction: evaluatedBreakout.direction,
        state: evaluatedBreakout.state,
        time: evaluatedBreakout.time === null ? null : new Date(evaluatedBreakout.time).toISOString(),
        candleOpenTime: evaluatedBreakout.candleOpenTime === null ? null : new Date(evaluatedBreakout.candleOpenTime).toISOString(),
        candidateTime: evaluatedBreakout.candidateTime === null ? null : new Date(evaluatedBreakout.candidateTime).toISOString(),
        candidateCandleOpenTime: evaluatedBreakout.candidateCandleOpenTime === null ? null : new Date(evaluatedBreakout.candidateCandleOpenTime).toISOString(),
        distanceOutside: evaluatedBreakout.distanceOutside,
        meaningfulDistance: evaluatedBreakout.meaningfulDistance,
        breakoutVolume: evaluatedBreakout.breakoutVolume,
        baselineVolume: evaluatedBreakout.baselineVolume,
        volumeRatio: evaluatedBreakout.volumeRatio,
        volumeSupported: evaluatedBreakout.volumeSupported,
        bodyRatio: evaluatedBreakout.bodyRatio,
        closeLocationRatio: evaluatedBreakout.closeLocationRatio,
        candleStructureSupported: evaluatedBreakout.candleStructureSupported,
        continuationConfirmed: evaluatedBreakout.continuationConfirmed,
        continuationCondition: evaluatedBreakout.continuationCondition,
        failed: evaluatedBreakout.failed,
        detail: evaluatedBreakout.detail,
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
       state: decisionProjection.state,
       explanation: decisionProjection.explanation,
       passedRules,
       failedRules,
    },
     riskPlan: plan,
    levelStory: story,
      shadowExecution: phase8Record.execution,
      reversal,
       setupAnalysis: toApiSetupAnalysis(publicSetupAnalysis),
    assumptions: [
      "Simulation uses America/New_York trading dates with UTC timestamps for deterministic replay.",
      "Premarket is available only when the simulated feed includes 04:00–09:29:59 ET candles.",
      "NTZ/ORB is the exact first three completed five-minute candles from 09:30 through 09:45 ET.",
      `Volume safety uses a ${config.volumeLookback}-candle average and ${config.adverseVolumeRatio.toFixed(2)}x adverse-volume ratio.`,
      `EMA uses ${config.emaPeriod} completed five-minute candles; slope compares ${config.emaSlopeWindow} completed candles.`,
      `VWAP resets at 09:30 ET for each regular session; major levels use ${config.historicalLookbackTradingDays} trading days of hourly reactions.`,
      `Trend classification requires ${config.trendCandleCount} completed 15-minute candles and remains descriptive only.`,
      `Phase 4 breakout support requires ${config.phase4BreakoutVolumeRatio.toFixed(2)}x the previous six completed five-minute candle volume average.`,
      `ORB quality uses ${config.phase4BreakoutMeaningfulDistanceTicks} ticks or ${config.phase4BreakoutMeaningfulDistanceAtrFactor.toFixed(2)} × ${config.phase4AtrPeriod}-period ATR for meaningful distance, ${config.phase4BreakoutBodyRatio.toFixed(0)}% body, and the outer ${(1 - config.phase4BreakoutCloseLocationRatio) * 100}% close location.`,
      `ORB continuation requires immediate extension or a second close outside the ORB; the strong single-candle exception is ${config.phase4AllowStrongSingleCandleException ? "enabled" : "disabled"} and uses ${config.phase4StrongVolumeRatio.toFixed(2)}x volume, ${(config.phase4StrongBodyRatio * 100).toFixed(0)}% body, and the outer ${(1 - config.phase4StrongCloseLocationRatio) * 100}% close location.`,
      `Phase 4 pullback proximity is the greater of ${config.phase4ProximityTicks} ticks and ${config.phase4ProximityAtrFactor.toFixed(2)} × ${config.phase4AtrPeriod}-period five-minute ATR, bounded to ${config.phase4PullbackMaxCandles} candles / ${config.phase4PullbackMaxMinutes} minutes.`,
      "Patience-candle states are descriptive shadow analysis only; a trigger never creates a live or paper order.",
      "Phase 6 setup decisions require every mandatory rule; scores and reversal alerts cannot qualify a setup.",
      "Doji uses a 10% body-to-range default; equivalent opposing candles use 15% body-size tolerance, 70% minimum body-to-range, and 15% trend-facing-wick limits.",
      `Extended NTZ consolidation requires 9–12 contiguous completed five-minute candles (45–60 minutes), primarily inside or near NTZ, with no more than ${config.phase6ConsolidationExpansionRatio.toFixed(2)}× range expansion.`,
       `Phase 7 uses tick-aligned catastrophe risk, ${plan.targetDollars.toFixed(2)} dollar target selection, whole-contract sizing, and a frozen 40% runner retracement.`,
       `Simulated costs: normal slippage is one adverse tick per fill; abnormal spread mode includes the observed spread. Fees include commission, exchange/regulatory, regulatory, and clearing components.`,
    ],
  };
  assertDashboardInvariants({
    ntz: snapshot.ntz,
    breakout: snapshot.breakout,
    signals: snapshot.signals,
    riskPlan: snapshot.riskPlan,
    patience,
    setupAnalysis,
    shadowExecution: snapshot.shadowExecution,
  });
  return snapshot;
}

type BreakoutForProjection = ReturnType<typeof advanceOrbBreakoutState>;

function phasedSignals(
  breakout: BreakoutForProjection,
  ntzComplete: boolean,
  pullback: ReturnType<typeof analyzePullback>,
  patience: PatienceAnalysis,
  volume: ReturnType<typeof phase4Volume>,
): MarketSnapshot["signals"] {
  const orbConfirmed = ntzComplete
    && breakout.detected
    && !breakout.failed
    && breakout.volumeSupported
    && volume.supportingBreakoutVolume
    && breakout.continuationConfirmed;
  const pullbackConfirmed = breakout.detected
    && !breakout.failed
    && pullback.events.some((event) => ["touch", "proximity", "consolidation", "break and reclaim", "hold"].includes(event.type));
  const patienceConfirmed = patience.state === "ENTRY_TRIGGERED";
  const patienceBlocked = ["PATIENCE_CANDLE_EXPIRED", "OPPOSITE_SIDE_INVALIDATION", "AMBIGUOUS_EVENT_ORDER"].includes(patience.state);
  const volumeConfirmed = breakout.detected
    && breakout.volumeSupported
    && volume.supportingBreakoutVolume
    && volume.reversalWarning === null;
  return [
    {
      key: "orb",
      label: "ORB breakout",
      status: orbConfirmed ? "confirmed" : breakout.failed ? "blocked" : "watching",
      detail: breakout.detail,
    },
    {
      key: "pullback",
      label: "Pullback",
      status: pullbackConfirmed ? "confirmed" : breakout.failed ? "blocked" : "watching",
      detail: pullback.detail,
    },
    {
      key: "patience",
      label: "Patience candle",
      status: patienceConfirmed ? "confirmed" : patienceBlocked ? "blocked" : "watching",
      detail: patience.detail,
    },
    {
      key: "volume",
      label: "Volume support",
      status: volume.reversalWarning !== null ? "blocked" : volumeConfirmed ? "confirmed" : "watching",
      detail: volume.reversalWarning ?? (volumeConfirmed ? "Breakout and pullback volume support the setup." : "Volume support is not confirmed for the current phased state."),
    },
  ];
}

function phasedDecision(
  setupAnalysis: Phase6Analysis,
  selectedEvaluation: Phase6Analysis["evaluations"][number],
  plan: Phase7RiskPlan,
  breakout: BreakoutForProjection,
  execution: Phase8Execution | null,
): { state: DecisionState; explanation: string } {
  const riskLockout = !plan.allowed && Object.values(plan.locks).some(Boolean);
  const state: DecisionState = riskLockout
    ? "RISK LOCKOUT"
    : setupAnalysis.decision === "SETUP QUALIFIED" && selectedEvaluation.alertOnly
      ? "POSSIBLE REVERSAL"
      : setupAnalysis.decision === "EXPIRED"
        ? "NO TRADE"
        : setupAnalysis.decision === "AMBIGUOUS"
          ? "WAITING"
          : setupAnalysis.decision;
  const parts = [
    selectedEvaluation.explanation,
    `ORB state: ${breakout.state}.`,
    riskLockout ? `Risk controls blocked the plan: ${plan.reasons.join(" ")}` : !plan.allowed ? `Plan blocked: ${plan.reasons.join(" ")}` : "",
    execution ? `Shadow execution is simulated only (${execution.contracts} contract${execution.contracts === 1 ? "" : "s"}).` : "",
  ].filter(Boolean);
  return { state, explanation: parts.join(" ") };
}

function buildRiskPlan(
  direction: Direction | null,
  levels: ReturnType<typeof sessionLevels>,
  patience: PatienceAnalysis,
  input: RiskInput | undefined,
  config: StrategyConfig,
  specification: FuturesContractSpecification,
  phase7Input?: Phase7Input,
) {
  const risk = input ?? { accountSize: 25_000, riskPercent: 0.5, maxDailyLoss: 500, dailyLossUsed: 0, isLocked: false };
  const entry = patience.entryBufferPrice;
  const thesisStop = patience.strategyStopPrice;
  if (direction === null || entry === null || thesisStop === null) {
    return buildPhase7RiskPlan(
      entry,
      direction,
      thesisStop,
      null,
      phase7Config(risk, config, specification, phase7Input),
      specification,
    );
  }
  const catastropheOffset = Math.max(config.stopBuffer, specification.tickSize);
  const catastropheStop = roundToTick(direction === "long" ? thesisStop - catastropheOffset : thesisStop + catastropheOffset, specification);
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
    trend: analysis.trend,
    previousCandle: toApiPatienceCandle(analysis.previousCandle),
    patienceCandle: toApiPatienceCandle(analysis.patienceCandle),
    triggerCandle: toApiPatienceCandle(analysis.triggerCandle),
    entryBufferTicks: analysis.entryBufferTicks,
    entryBufferPrice: analysis.entryBufferPrice,
    stopBufferTicks: analysis.stopBufferTicks,
    strategyStopPrice: analysis.strategyStopPrice,
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