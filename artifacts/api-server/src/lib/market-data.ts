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
  patienceArmLifecycleTransitions,
  phase6Analysis,
  reducePullbackArmLifecycles,
  type Phase6Analysis,
  type Phase6Decision,
  type SetupType,
  type ManualFibAnchors,
  type PatienceAnalysis,
  type PatienceOccurrence,
  type PatienceEligibilityReason,
  type PatienceState,
  type DecisionState,
  type Direction,
  type StrategyConfig,
  detectReversalEvidence,
  consolidationThresholds,
  type OrbBreakoutState,
  type PullbackArmState,
  type BreakoutContinuationCondition,
  buildPhase7RiskPlan,
  type Phase7RiskConfig,
  type Phase7RiskPlan,
  buildPhase8EvaluationRecord,
  type Phase8Execution,
  type Phase8TimelineEvent,
  assertDashboardInvariants,
} from "./strategy/index.js";
import { canonicalStrategyId } from "./strategy/taxonomy.js";
import {
  getFuturesContractSpecification,
  roundToTick,
  type FuturesContractSpecification,
} from "./futures/contracts.js";
import {
  classifyFuturesSession,
  isTradingDate,
  previousTradingDate,
  sessionCalendarForContract,
  timestampForTradingDate,
  tradingDateForTimestamp,
} from "./futures/session-calendar.js";
import {
  completedSimulatedCandles,
  completedSimulatedHourlyCandles,
  generateSimulatedFuturesFeed,
  type SimulatedHourlyCandle,
  type SimulatedFuturesCandle,
} from "./futures/simulated-feed.js";
import { SHADOW_MODE_LABEL } from "./modules/shadow-execution.js";
import { dynamiteLevels, type MajorLevel, type DynamiteLevel } from "./strategy/major-levels.js";
import { activeShadowStrategySnapshot } from "./active-shadow-strategy.js";
import { detectLongTermZones, type LongTermZone } from "./strategy/long-term-zones.js";
import { formulaConfigurationHash } from "./formula-hash.js";
import { createHash } from "node:crypto";

const CONFIRMED_ORB_STATES = new Set<OrbBreakoutState>([
  "QUALIFIED_BREAKOUT",
  "WAITING_FOR_PULLBACK",
  "PULLBACK_IN_PROGRESS",
  "WAITING_FOR_PATIENCE_CANDLE",
  "PATIENCE_CANDLE_VALID",
  "TRIGGER_CANDLE_ACTIVE",
  "ENTRY_TRIGGERED",
]);

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
  replay: { tradingDate: string; cursor: string; visibleCandleCount: number; timeZone: string; barIntervalMinutes: 5 };
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
     references: Array<{
       id: "previous-session-high" | "previous-session-low" | "two-sessions-high" | "two-sessions-low";
       name: string;
       price: number;
       sourceTradingDate: string;
       sourceContractSymbol: string | null;
       toleranceTicks: 12;
     }>;
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
    armId?: string | null;
    armState?: PullbackArmState;
    armTransitions?: Array<{ from: PullbackArmState | null; to: PullbackArmState; time: string; reason: string }>;
    terminalReason?: string | null;
    lateInteractionCount?: number;
    events: Array<{
      type: string;
      time: string;
      level: string;
      price: number;
      distancePoints?: number;
      distanceTicks?: number;
      tolerancePoints?: number;
      toleranceTicks?: number;
      qualifies?: boolean;
      candle?: { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number };
      detail: string;
    }>;
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
    occurrences?: PatienceOccurrence[];
    eligibilityArmId?: string | null;
    eligibilityArmState?: "active" | "consumed" | "invalidated" | "superseded" | null;
    eligibilityArmStateReason?: string | null;
    eligibilityProvenance?: PatienceOccurrence["eligibilityProvenance"] | null;
  };
  reversalPatience?: MarketSnapshot["patience"];
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
  longTermZones: LongTermZone[];
  dynamiteLevels: DynamiteLevel[];
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
      grade?: number;
      dynamiteConfluenceCount?: number;
      supportingConfluences?: string[];
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

type RiskInput = { accountSize: number; riskPercent: number; maxDailyLoss: number; dailyLossUsed: number; isLocked: boolean };
type Phase7Input = {
  targetDollars?: number;
  slippageMode?: Phase7RiskConfig["slippageMode"];
  normalSlippageTicks?: number;
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
  strategyConfigOverrides?: Partial<StrategyConfig>;
  tradingDate?: string;
  cursor?: number;
  allCandles?: readonly SimulatedFuturesCandle[];
  historicalFeed?: readonly SimulatedFuturesCandle[];
  historicalHourly?: readonly SimulatedHourlyCandle[];
  premarketAvailable?: boolean;
  executionMode?: "quote_based_shadow" | "ohlcv_modeled";
  ohlcvEntryBufferTicks?: 8;
  ohlcvStopBufferTicks?: number;
  allCandlesCompleted?: boolean;
  validateDashboardInvariants?: boolean;
  sourceFingerprint?: string;
};

function feedSourceFingerprint(feed: readonly SimulatedFuturesCandle[]): string {
  const first = feed[0];
  const last = feed.at(-1);
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    count: feed.length,
    first: first ? [first.contractSymbol, first.openTime, first.closeTime, first.open, first.high, first.low, first.close] : null,
    last: last ? [last.contractSymbol, last.openTime, last.closeTime, last.open, last.high, last.low, last.close] : null,
  }));
  return hash.digest("hex");
}

function latestTradingDate(calendar: ReturnType<typeof sessionCalendarForContract>): string {
  let date = tradingDateForTimestamp(Date.now(), calendar);
  while (!isTradingDate(date, calendar)) date = previousTradingDate(date, calendar);
  return date;
}

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
  const config = strategyConfig({
    ...activeShadowStrategySnapshot().config,
    ...(replayOptions?.strategyConfigOverrides ?? {}),
    ...(replayOptions?.ohlcvEntryBufferTicks === undefined ? {} : { patienceEntryBufferTicks: replayOptions.ohlcvEntryBufferTicks }),
    ...(replayOptions?.ohlcvStopBufferTicks === undefined ? {} : { patienceStopBufferTicks: replayOptions.ohlcvStopBufferTicks }),
  });
  const calendar = sessionCalendarForContract(specification);
  const requestedCursor = replayOptions?.cursor;
  const tradingDate = replayOptions?.tradingDate
    ?? (requestedCursor === undefined ? latestTradingDate(calendar) : tradingDateForTimestamp(requestedCursor, calendar));
  if (requestedCursor !== undefined && tradingDateForTimestamp(requestedCursor, calendar) !== tradingDate) {
    throw new Error(`Replay cursor ${new Date(requestedCursor).toISOString()} is outside trading date ${tradingDate}.`);
  }
  const premarketAvailable = replayOptions?.premarketAvailable !== false;
  const allCandles = replayOptions?.allCandles
    ? replayOptions.allCandles
    : generateSimulatedFuturesFeed(specification, {
        calendar,
        days: config.simulationDays,
        seed: config.simulationSeed,
        includePremarket: premarketAvailable,
        startDate: tradingDate,
      });
  const historicalFeed = replayOptions?.historicalFeed
    ? replayOptions.historicalFeed
    : generateSimulatedFuturesFeed(specification, {
        calendar,
        days: config.historicalLookbackTradingDays,
        seed: config.simulationSeed,
        includePremarket: true,
        startDate: tradingDate,
      });
  const currentCursor = replayOptions?.cursor ?? (session === "premarket"
    ? timestampForTradingDate(tradingDate, "09:20", calendar)
    : timestampForTradingDate(tradingDate, "13:00", calendar));
  const sourceFingerprint = replayOptions?.sourceFingerprint ?? feedSourceFingerprint(historicalFeed);
  const formulaHash = formulaConfigurationHash({ symbol: normalized }, config);
  const currentSession = classifyFuturesSession(currentCursor, calendar);
  const marketStatus = currentSession === "premarket"
    ? "premarket"
    : currentSession === "regular"
      ? "open"
      : "closed";
  const visible = completedSimulatedCandles(allCandles, currentCursor, {
    clone: false,
    assumeSorted: replayOptions?.allCandlesCompleted === true,
    assumeAllCompleted: replayOptions?.allCandlesCompleted === true,
  });
  const historicalHourly = replayOptions?.historicalHourly
    ? replayOptions.historicalHourly.filter((candle) => candle.closeTime <= currentCursor)
    : completedSimulatedHourlyCandles(
        completedSimulatedCandles(historicalFeed, currentCursor, {
          assumeSorted: replayOptions?.allCandlesCompleted === true,
          assumeAllCompleted: replayOptions?.allCandlesCompleted === true,
        }),
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
       historicalFeed,
    },
    config,
    calendar,
    specification,
  );
  const longTermZones = [
    ...detectLongTermZones(historicalHourly, { cursor: currentCursor, lookback: "six-month", tickSize: specification.tickSize, widthTicks: 12, seriesIdentity: `${symbol}|${historicalHourly.length}` }),
    ...detectLongTermZones(historicalHourly, { cursor: currentCursor, lookback: "one-year", tickSize: specification.tickSize, widthTicks: 12, seriesIdentity: `${symbol}|${historicalHourly.length}` }),
  ];
  const breakout = detectInitialBreakout(regular, levels.ntz, config, specification);
  const qualifyingLevels = [
    ...levels.levels,
    { name: "VWAP", price: levels.vwap, kind: "indicator" },
    { name: "EMA 200", price: levels.ema, kind: "indicator" },
    ...levels.majorLevels.map((level) => ({ name: level.name, price: level.price, kind: level.kind })),
    ...levels.majorLevels
      .filter((level) => level.confluence !== "normal")
      .map((level) => ({ name: `Confluence · ${level.name}`, price: level.price, kind: "confluence" })),
  ];
  let pullback = analyzePullback(regular, breakout, qualifyingLevels, specification, config, {
    causalCandles: historicalFeed,
    calendar,
    finalizedNtz: levels.ntz,
    armIdentity: {
      sourceFingerprint,
      formulaHash,
      contractSymbol: specification.fullContractSymbol,
      tradingDate,
      finalizedNtzIdentity: levels.ntz
        ? `${levels.ntz.high}|${levels.ntz.low}|${levels.ntz.completedAt ?? "unknown"}`
        : "ntz-incomplete",
      configurationHash: activeShadowStrategySnapshot().formulaHash,
    },
  });
  let fibonacci = fibonacciAnalysis(regular, breakout, manualFibAnchors, pullback);
  if (fibonacci.levels.length) {
    const fibonacciLevels = fibonacci.levels.map((level) => ({
      name: level.name,
      price: level.price,
      kind: "reference" as const,
    }));
    pullback = analyzePullback(regular, breakout, [...qualifyingLevels, ...fibonacciLevels], specification, config, {
      causalCandles: historicalFeed,
      calendar,
      finalizedNtz: levels.ntz,
      armIdentity: {
        sourceFingerprint,
        formulaHash,
        contractSymbol: specification.fullContractSymbol,
        tradingDate,
        finalizedNtzIdentity: levels.ntz
          ? `${levels.ntz.high}|${levels.ntz.low}|${levels.ntz.completedAt ?? "unknown"}`
          : "ntz-incomplete",
        configurationHash: activeShadowStrategySnapshot().formulaHash,
      },
    });
    fibonacci = fibonacciAnalysis(regular, breakout, manualFibAnchors, pullback);
  }
  const dynamiteInteractions = pullback.events
    .filter((event) =>
      event.qualifies
      && ["touch", "proximity", "consolidation", "break and reclaim", "hold"].includes(event.type),
    )
    .map((event) => ({
      eventId: event.eventId ?? null,
      eventTime: event.time,
      candleOpenTime: event.candle?.openTime ?? event.time,
      price: event.price,
      level: event.level,
      direction: null,
      lCandleOpenTime: event.candle?.openTime ?? null,
      sourceFingerprint,
      formulaHash,
      contractSymbol: specification.fullContractSymbol,
      tradingDate,
    }));
  const dynamite = dynamiteLevels([
    { name: "ORB high", price: levels.orb?.high ?? NaN, family: "orb-ntz-high", id: "orb-high" },
    { name: "NTZ high", price: levels.ntz?.high ?? NaN, family: "orb-ntz-high", id: "ntz-high" },
    { name: "ORB low", price: levels.orb?.low ?? NaN, family: "orb-ntz-low", id: "orb-low" },
    { name: "NTZ low", price: levels.ntz?.low ?? NaN, family: "orb-ntz-low", id: "ntz-low" },
    ...levels.levels.map((level) => ({ name: level.name, price: level.price, id: level.name })),
    { name: "VWAP", price: levels.vwap, family: "vwap", id: "vwap" },
    { name: "EMA 200", price: levels.ema, family: "ema-200", id: "ema-200" },
    ...levels.majorLevels.map((level) => ({
      name: level.name,
      price: level.price,
      family: level.kind === "resistance" ? "resistance-zone" : "support-zone",
      id: level.name,
    })),
    ...fibonacci.levels.map((level) => ({ name: level.name, price: level.price, family: "fibonacci", id: level.name })),
  ], config.dynamiteLevelToleranceTicks, specification.tickSize, currentCursor, dynamiteInteractions, {
    sourceFingerprint,
    formulaHash,
    contractSymbol: specification.fullContractSymbol,
    tradingDate,
  });
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
    false,
    breakout.direction ? "ORB_BREAKOUT" : "CONFIRMED_15M_TREND",
  );
  const evaluatedBreakout = advanceOrbBreakoutState(breakout, pullback, patience.state);
  const baseSetupContext = {
    candles: regular,
    levels,
    breakout: evaluatedBreakout,
    pullback,
    fibonacci,
    volume: volumeAnalysis,
    patience,
    trend,
    riskApproved: true,
    config,
  };
  const preliminaryReversalEvidence = detectReversalEvidence(baseSetupContext);
  const reversalDirection: Direction | null = preliminaryReversalEvidence.directionalConfirmation
    ? preliminaryReversalEvidence.reversalDirection ?? null
    : null;
  const reversalPatience = phase5PatienceAnalysis(
    regular,
    reversalDirection,
    pullback,
    levels.ntz,
    levels.ntzEvents,
    undefined,
    trend.direction,
    specification.tickSize,
    config.patienceEntryBufferTicks,
    config.patienceStopBufferTicks,
    true,
    "EQUIVALENT_REVERSAL",
  );
  const preliminarySetupAnalysis = phase6Analysis({
    ...baseSetupContext,
    reversalPatience,
  });
  const direction = selectExecutableDirection(preliminarySetupAnalysis, evaluatedBreakout, patienceDirection);
  const executablePatience = preliminarySetupAnalysis.primarySetup === "EQUIVALENT_CANDLE_REVERSAL"
    || preliminarySetupAnalysis.primarySetup === "PEAK_RETRACEMENT_REVERSAL"
    ? reversalPatience
    : patience;
  const plan = buildRiskPlan(direction, levels, executablePatience, riskInput, config, specification, {
    ...phase7Input,
    observedSpreadTicks: current ? Math.max(0, Math.round((current.ask - current.bid) / specification.tickSize)) : undefined,
    liquidity: current?.volume,
    dataAgeSeconds: 0,
  });
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
    dynamiteLevels: dynamite,
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
    patience: executablePatience,
    evaluation: selectedEvaluation,
    riskPlan: plan,
    direction: plan.direction,
    trend: trend.direction,
    specification,
    slippageMode: plan.slippageMode,
    now: currentCursor,
  });
  pullback = projectCanonicalPullbackLifecycle(pullback, [patience, reversalPatience]);
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
     vwapSessionDate: tradingDate,
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
  const reversalEvaluation = setupAnalysis.evaluations.find((item) => item.setupType === "EQUIVALENT_CANDLE_REVERSAL");
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
      tradingDate,
      premarketAvailable,
      holidays: [...calendar.holidays],
      earlyCloses: { ...calendar.earlyCloses },
    },
    price,
    change: Number((price - previousClose).toFixed(2)),
    changePercent: Number((((price - previousClose) / previousClose) * 100).toFixed(2)),
     marketStatus,
     session: currentSession === "premarket" ? "Premarket" : currentSession === "regular" ? "Regular session / replay" : "Market closed",
    updatedAt: new Date(currentCursor).toISOString(),
     replay: { tradingDate, cursor: new Date(currentCursor).toISOString(), visibleCandleCount: visible.length, timeZone: "America/New_York", barIntervalMinutes: config.barIntervalMinutes },
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
       references: levels.levels
         .filter((level) => level.kind === "intraday_reference" && level.sourceTradingDate)
         .map((level) => ({
           id: level.name === "Prior day high" ? "previous-session-high"
             : level.name === "Prior day low" ? "previous-session-low"
               : level.name === "Two days ago high" ? "two-sessions-high" : "two-sessions-low",
           name: level.name,
           price: level.price,
           sourceTradingDate: level.sourceTradingDate!,
           sourceContractSymbol: level.sourceContractSymbol ?? null,
           toleranceTicks: 12 as const,
         })),
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
        armId: pullback.armId,
        armState: pullback.armState,
        armTransitions: (pullback.armTransitions ?? []).map((transition) => ({
          ...transition,
          time: new Date(transition.time).toISOString(),
        })),
        terminalReason: pullback.terminalReason,
        lateInteractionCount: pullback.lateInteractionCount,
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
      patience: toApiPatience(executablePatience),
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
     longTermZones,
      dynamiteLevels: dynamite,
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
      `Phase 4 qualifying-level proximity uses the shared ${Math.round(config.levelTolerance / specification.tickSize)}-tick MES tolerance (${config.levelTolerance.toFixed(2)} points) against the complete L-candle range; ${config.phase4AtrPeriod}-period ATR is diagnostic only. The window is bounded to ${config.phase4PullbackMaxCandles} candles / ${config.phase4PullbackMaxMinutes} minutes.`,
      "Patience-candle states are descriptive shadow analysis only; a trigger never creates a live or paper order.",
      "Phase 6 setup decisions require every mandatory rule; scores and reversal alerts cannot qualify a setup.",
      "Doji uses a 10% body-to-range default; equivalent opposing candles use 15% body-size tolerance, 70% minimum body-to-range, and 15% trend-facing-wick limits.",
      (() => {
        const thresholds = consolidationThresholds(config);
        return `Phase 6 consolidation thresholds ${thresholds.version}: minimum ${thresholds.minCandles} completed five-minute candles, maximum ${thresholds.maxRangeTicks} MES ticks, and no more than ${thresholds.maxExpansionRatio.toFixed(2)}× range expansion. NTZ proximity is diagnostic confluence, not a duration substitute.`;
      })(),
       `Phase 7 uses tick-aligned catastrophe risk, ${plan.targetDollars.toFixed(2)} dollar target selection, whole-contract sizing, and a frozen 40% runner retracement.`,
       `Simulated costs: normal slippage is one adverse tick per fill; abnormal spread mode includes the observed spread. Fees include commission, exchange/regulatory, regulatory, and clearing components.`,
    ],
  };
  if (replayOptions?.validateDashboardInvariants !== false) {
    assertDashboardInvariants({
      ntz: snapshot.ntz,
      breakout: snapshot.breakout,
      signals: snapshot.signals,
      riskPlan: snapshot.riskPlan,
      patience: executablePatience,
      setupAnalysis,
      shadowExecution: snapshot.shadowExecution,
    });
  }
  return snapshot;
}

type BreakoutForProjection = ReturnType<typeof advanceOrbBreakoutState>;

function projectCanonicalPullbackLifecycle(
  pullback: ReturnType<typeof analyzePullback>,
  analyses: readonly PatienceAnalysis[],
): ReturnType<typeof analyzePullback> {
  if (!pullback.armId) return pullback;
  const observations = [
    {
      armId: pullback.armId,
      transitions: pullback.armTransitions ?? [],
      source: "phase4",
    },
    ...analyses.flatMap((analysis) =>
      (analysis.occurrences ?? [])
        .filter((occurrence) => occurrence.eligibilityArmId === pullback.armId)
        .map((occurrence) => ({
          armId: pullback.armId!,
          transitions: patienceArmLifecycleTransitions(occurrence),
          source: `phase5:${occurrence.occurrenceId}`,
        })),
    ),
  ];
  const record = reducePullbackArmLifecycles(observations).records.find((item) => item.armId === pullback.armId);
  if (!record) return pullback;
  return {
    ...pullback,
    status: record.terminal ? "expired" : pullback.status,
    armState: record.state,
    armTransitions: record.transitions,
    terminalReason: record.terminalReason ?? pullback.terminalReason,
  };
}

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
    && breakout.continuationConfirmed
    && CONFIRMED_ORB_STATES.has(breakout.state);
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
    normalSlippageTicks: phase7Input?.normalSlippageTicks ?? config.phase7NormalSlippageTicks,
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
      setupType: canonicalStrategyId(evaluation.setupType) ?? "ORB_PULLBACK_CONTINUATION",
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
      grade: evaluation.grade ?? 0,
      dynamiteConfluenceCount: evaluation.dynamiteConfluenceCount ?? 0,
      supportingConfluences: evaluation.supportingConfluences ?? [],
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
    occurrences: analysis.occurrences,
    eligibilityArmId: analysis.eligibilityArmId ?? null,
    eligibilityArmState: analysis.eligibilityArmState ?? null,
    eligibilityArmStateReason: analysis.eligibilityArmStateReason ?? null,
    eligibilityProvenance: analysis.eligibilityProvenance ?? null,
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