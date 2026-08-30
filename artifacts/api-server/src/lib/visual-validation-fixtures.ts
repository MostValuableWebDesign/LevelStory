import {
  getFuturesContractSpecification,
  type FuturesContractSpecification,
} from "./futures/contracts.js";
import {
  listTradingDates,
  sessionCalendarForContract,
  sessionWindow,
  type FuturesSessionCalendar,
} from "./futures/session-calendar.js";
import type {
  BacktestAuditRecord,
  BacktestTrade,
  CausalReplayDataset,
  IntrabarBar,
} from "./phase9.js";
import type { VisualValidationCategory, VisualValidationRequest } from "./visual-validation.js";
import type { SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { consolidationThresholds, DEFAULT_STRATEGY_CONFIG } from "./strategy/config.js";

const INTERVAL = 5 * 60_000;
const CANDLE_COUNT = 78;
const EVALUATION_INDEX = 34;
const PATIENCE_INDEX = 29;
const TRIGGER_INDEX = 30;
const FILL_INDEX = 31;
const EXIT_INDEX = 37;

export type VisualValidationFixture = {
  category: VisualValidationCategory;
  dataset: CausalReplayDataset;
  audit: BacktestAuditRecord;
  trade: BacktestTrade | null;
  reviewCloseTime: number;
};

function tick(value: number, specification: FuturesContractSpecification): number {
  return Number((Math.round(value / specification.tickSize) * specification.tickSize).toFixed(2));
}

function categoryIndex(category: VisualValidationCategory): number {
  return [
    "qualified_trade",
    "rejected_setup",
    "bullish_patience_candle",
    "bearish_patience_candle",
    "weak_orb_probe",
    "strong_breakout",
    "pullback",
    "consolidation",
    "ambiguous_candle",
    "stop_exit",
    "target_exit",
    "runner_exit",
  ].indexOf(category);
}

function scenarioTarget(category: VisualValidationCategory, index: number, base: number): number {
  const earlyRange = [0, 0.25, -0.25, 0.5, 0.25, -0.25, 0.25][index] ?? 0;
  switch (category) {
    case "qualified_trade":
      if (index < 8) return base + earlyRange;
      if (index < 16) return base + 0.35 + (index - 8) * 0.28;
      if (index < 21) return base + 2.25 - (index - 16) * 0.22;
      return base + 1.4 + (index - 20) * 0.34;
    case "rejected_setup":
      if (index < 10) return base + earlyRange;
      if (index < 16) return base + 0.35 + (index - 10) * 0.12;
      return base + 1.05 - (index - 15) * 0.08;
    case "bullish_patience_candle":
    case "strong_breakout":
    case "target_exit":
    case "runner_exit":
      if (index < 8) return base + earlyRange;
      if (index < 17) return base + 0.3 + (index - 8) * 0.22;
      if (index < 22) return base + 2.15 - (index - 17) * 0.18;
      return base + 1.45 + (index - 21) * (category === "strong_breakout" ? 0.42 : 0.3);
    case "bearish_patience_candle":
    case "stop_exit":
      if (index < 8) return base - earlyRange;
      if (index < 17) return base - 0.3 - (index - 8) * 0.22;
      if (index < 22) return base - 2.15 + (index - 17) * 0.18;
      return base - 1.45 - (index - 21) * (category === "stop_exit" ? 0.34 : 0.3);
    case "weak_orb_probe":
      if (index < 10) return base + earlyRange;
      if (index === 10) return base + 0.85;
      if (index < 16) return base + 0.25 - (index - 10) * 0.1;
      return base + 0.05 + Math.sin(index * 0.9) * 0.18;
    case "pullback":
      if (index < 8) return base + earlyRange;
      if (index < 15) return base + 0.3 + (index - 8) * 0.3;
      if (index < 21) return base + 2.4 - (index - 15) * 0.32;
      return base + 0.9 + (index - 20) * 0.26;
    case "consolidation":
      if (index < 11) return base + earlyRange;
      if (index < 25) return base + 0.7 + [0.0, 0.2, -0.15, 0.1, -0.05][index % 5];
      return base + 0.7 + (index - 24) * 0.31;
    case "ambiguous_candle":
      if (index < 16) return base + 0.25 + (index % 4) * 0.18;
      return base + 0.9 + (index - 15) * 0.18;
  }
}

function buildCandles(
  category: VisualValidationCategory,
  specification: FuturesContractSpecification,
  calendar: FuturesSessionCalendar,
  tradingDate: string,
  seed: number,
  session: "regular" | "premarket" = "regular",
): SimulatedFuturesCandle[] {
  const window = sessionWindow(tradingDate, session, calendar);
  if (!window) throw new Error(`No ${session} session window for ${tradingDate}.`);
  const base = 6_800 + categoryIndex(category) * 3 + (Math.abs(Math.floor(seed)) % 4) * 0.25;
  const candles: SimulatedFuturesCandle[] = [];
  let previousClose = base;
  const candleCount = session === "premarket" ? 66 : CANDLE_COUNT;
  for (let index = 0; index < candleCount; index += 1) {
    const openTime = window.openTime + index * INTERVAL;
    const target = session === "premarket"
      ? base + Math.sin(index * 0.37 + categoryIndex(category)) * 0.65 + (index % 9) * 0.08
      : scenarioTarget(category, index, base);
    const open = tick(previousClose, specification);
    let close = tick(target + ((index + categoryIndex(category) + seed) % 3 - 1) * 0.25, specification);
    if (close === open) close = tick(close + (index % 2 === 0 ? 0.25 : -0.25), specification);
    const upperWick = [0.25, 0.5, 0.75, 0.25, 1][(index + categoryIndex(category)) % 5];
    const lowerWick = [0.5, 0.25, 0.75, 1, 0.25][(index + 2 * categoryIndex(category)) % 5];
    const high = tick(Math.max(open, close) + upperWick, specification);
    const low = tick(Math.min(open, close) - lowerWick, specification);
    const breakoutVolume = session === "regular" && ["strong_breakout", "qualified_trade", "target_exit", "runner_exit"].includes(category) && index >= 15 && index <= 19;
    const weakVolume = session === "regular" && category === "weak_orb_probe" && index >= 10 && index <= 13;
    const volume = Math.round(900 + index * 37 + ((index + categoryIndex(category) + seed) % 5) * 165 + (breakoutVolume ? 1_400 : 0) - (weakVolume ? 250 : 0));
    candles.push({
      timestamp: openTime,
      openTime,
      closeTime: openTime + INTERVAL,
      open,
      high,
      low,
      close,
      volume: Math.max(250, volume),
      bid: tick(close - specification.tickSize, specification),
      ask: close,
      bidSize: 10 + ((index + categoryIndex(category)) % 7) * 5,
      askSize: 15 + ((index + seed) % 7) * 5,
      contractSymbol: specification.fullContractSymbol,
      isComplete: true,
    });
    previousClose = close;
  }
  return candles;
}

function scenarioEvidence(category: VisualValidationCategory): {
  direction: "long" | "short";
  setupType: string;
  decision: string;
  rejectionReason: string | null;
  rejectionCategory: BacktestAuditRecord["rejectionCategory"];
  orbState: string;
  breakoutEvidence: string;
  volumeEvidence: string;
  pullbackEvidence: string;
  criticalLevelEvidence: string;
  trendEvidence: string;
  patienceState: string;
  ruleEvidence: string[];
} {
  const direction = category === "bearish_patience_candle" || category === "stop_exit" ? "short" : "long";
  const tradeLike = ["qualified_trade", "target_exit", "runner_exit", "stop_exit"].includes(category);
  const rejected = category === "rejected_setup" || category === "ambiguous_candle";
  return {
    direction,
    setupType: tradeLike || category === "pullback" || category === "consolidation"
      ? "ORB_BREAK_PULLBACK_CONTINUATION"
      : "ORB_BREAKOUT",
    decision: rejected ? "SETUP REJECTED" : "SETUP QUALIFIED",
    rejectionReason: rejected ? category === "ambiguous_candle" ? "AMBIGUOUS_STOP_FIRST" : "RULES_NOT_QUALIFIED:ORB_BREAKOUT" : null,
    rejectionCategory: category === "ambiguous_candle" ? "AMBIGUITY" : rejected ? "FAILURE" : "QUALIFIED",
    orbState: category === "weak_orb_probe" ? "ORB_PROBE_WAIT"
      : category === "pullback" ? "PULLBACK_IN_PROGRESS"
        : category === "consolidation" ? "WAITING_FOR_PULLBACK"
          : category === "rejected_setup" ? "WEAK_BREAK_WAIT"
            : "ENTRY_TRIGGERED",
    breakoutEvidence: category === "weak_orb_probe"
      ? "Weak ORB probe crossed ORB high by one tick and returned inside the range."
      : category === "strong_breakout" || tradeLike
        ? "Strong breakout closed beyond ORB with continuation."
        : "Opening range context is visible in the fixture.",
    volumeEvidence: category === "weak_orb_probe"
      ? "Volume stayed below the confirmation threshold; no convincing continuation."
      : category === "strong_breakout" || tradeLike
        ? "Breakout volume expanded above the preceding range."
        : "Volume varies across the fixture.",
    pullbackEvidence: category === "pullback"
      ? "Retraced to ORB high (pullback interaction) before continuation."
      : category === "consolidation"
        ? "14 completed candles consolidated inside a measured 0.75-point range near VWAP."
        : "No qualifying pullback interaction.",
    criticalLevelEvidence: category === "pullback" ? "ORB high 6802.50 is the recognized retracement level." : "No critical level evidence.",
    trendEvidence: direction === "long"
      ? "bullish: higher highs / higher lows on the completed 15-minute structure."
      : "bearish: lower highs / lower lows on the completed 15-minute structure.",
    patienceState: category === "bullish_patience_candle" || category === "bearish_patience_candle" || tradeLike
      ? "PATIENCE_CANDLE_VALID"
      : "WAITING_FOR_PULLBACK",
    ruleEvidence: [
      `PASS candle_structure: ${category} fixture has varied bodies and wicks.`,
      `PASS volume_condition: ${category === "weak_orb_probe" ? "no convincing confirmation" : "deterministic volume profile"}.`,
      ...(category === "pullback" ? ["PASS pullback_level: ORB high retest is explicit."] : []),
      ...(category === "consolidation" ? ["PASS consolidation_state: 14 completed candles in a measured range."] : []),
    ],
  };
}

function makeAudit(
  category: VisualValidationCategory,
  candles: readonly SimulatedFuturesCandle[],
  contract: FuturesContractSpecification,
  tradingDate: string,
  period: BacktestAuditRecord["period"],
): BacktestAuditRecord {
  const evidence = scenarioEvidence(category);
  const tradeLike = ["qualified_trade", "stop_exit", "target_exit", "runner_exit"].includes(category);
  const patience = candles[PATIENCE_INDEX]!;
  const trigger = candles[TRIGGER_INDEX]!;
  const fill = candles[FILL_INDEX]!;
  const exit = candles[EXIT_INDEX]!;
  const target = evidence.direction === "long" ? trigger.close + 4 : trigger.close - 4;
  const strategyStop = evidence.direction === "long" ? trigger.close - 2 : trigger.close + 2;
  const ambiguous = category === "ambiguous_candle";
  return {
    id: `visual-fixture-${category}-${tradingDate}-${candles[EVALUATION_INDEX]!.openTime}`,
    tradingDate,
    contractSymbol: contract.fullContractSymbol,
    contractMonth: contract.contractMonth,
    period,
    evaluatedCandleOpenTime: new Date(candles[EVALUATION_INDEX]!.openTime).toISOString(),
    setupType: evidence.setupType,
    direction: evidence.direction,
    decision: evidence.decision,
    alertOnly: false,
    rejectionReason: evidence.rejectionReason,
    rejectionCategory: evidence.rejectionCategory,
    rejectionSummary: evidence.rejectionReason ? evidence.rejectionReason : null,
    ruleEvidence: evidence.ruleEvidence,
    orbState: evidence.orbState,
    breakoutEvidence: evidence.breakoutEvidence,
    volumeEvidence: evidence.volumeEvidence,
    pullbackEvidence: evidence.pullbackEvidence,
    criticalLevelEvidence: evidence.criticalLevelEvidence,
    trendEvidence: evidence.trendEvidence,
    patienceState: evidence.patienceState,
    patienceCandle: {
      openTime: patience.openTime,
      closeTime: patience.closeTime,
      open: patience.open,
      high: patience.high,
      low: patience.low,
      close: patience.close,
      volume: patience.volume,
      isComplete: patience.isComplete,
    },
    triggerCandle: {
      openTime: trigger.openTime,
      closeTime: trigger.closeTime,
      open: trigger.open,
      high: trigger.high,
      low: trigger.low,
      close: trigger.close,
      volume: trigger.volume,
      isComplete: trigger.isComplete,
    },
    patienceCandleOpenTime: new Date(patience.openTime).toISOString(),
    patienceCandleCloseTime: new Date(patience.closeTime).toISOString(),
    triggerCandleOpenTime: new Date(trigger.openTime).toISOString(),
    triggerCandleCloseTime: new Date(trigger.closeTime).toISOString(),
    modeledFillObservationTime: tradeLike ? new Date(fill.closeTime).toISOString() : null,
    exitCandleOpenTime: tradeLike ? new Date(exit.openTime).toISOString() : null,
    exitCandleCloseTime: tradeLike ? new Date(exit.closeTime).toISOString() : null,
    entryTriggerPrice: trigger.close,
    strategyStopPrice: strategyStop,
    catastropheStopPrice: evidence.direction === "long" ? trigger.close - 3 : trigger.close + 3,
    targetPrice: target,
    eventLabels: ambiguous ? ["AMBIGUOUS_STOP_FIRST"] : [],
    ambiguityLabels: ambiguous ? ["AMBIGUOUS_STOP_FIRST"] : [],
    executionMode: "quote_based_shadow",
    fees: 0,
    slippage: 0,
    grossPnl: null,
    netPnl: null,
    exitReason: null,
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
  };
}

function makeTrade(
  category: VisualValidationCategory,
  audit: BacktestAuditRecord,
  candles: readonly SimulatedFuturesCandle[],
  contract: FuturesContractSpecification,
): BacktestTrade | null {
  if (!["qualified_trade", "stop_exit", "target_exit", "runner_exit"].includes(category)) return null;
  const entry = candles[FILL_INDEX]!;
  const exit = candles[EXIT_INDEX]!;
  const direction = audit.direction!;
  const entryPrice = entry.close;
  const exitPrice = category === "stop_exit"
    ? audit.strategyStopPrice!
    : category === "target_exit" || category === "runner_exit"
      ? audit.targetPrice!
      : exit.close;
  const outcome: BacktestTrade["outcome"] = category === "stop_exit" ? "strategy stop" : "target";
  const eventLabels = category === "stop_exit"
    ? ["STRATEGY_STOP_REACHED"]
    : category === "runner_exit"
      ? ["TARGET_REACHED", "RUNNER_ACTIVATED", "RUNNER_EXITED"]
      : ["TARGET_REACHED"];
  const tradeAudit: NonNullable<BacktestTrade["audit"]> = {
    entryTriggerPrice: audit.entryTriggerPrice,
    modeledFillPrice: entryPrice,
    stopPrice: audit.strategyStopPrice,
    targetPrice: audit.targetPrice,
    strategyStopPrice: audit.strategyStopPrice,
    catastropheStopPrice: audit.catastropheStopPrice,
    stopLevel: category === "stop_exit" ? "strategy" : null,
    patienceCandleOpenTime: audit.patienceCandleOpenTime,
    patienceCandleCloseTime: audit.patienceCandleCloseTime,
    triggerCandleOpenTime: audit.triggerCandleOpenTime,
    triggerCandleCloseTime: audit.triggerCandleCloseTime,
    modeledFillObservationTime: audit.modeledFillObservationTime,
    exitCandleOpenTime: audit.exitCandleOpenTime,
    exitCandleCloseTime: audit.exitCandleCloseTime,
    assumptions: ["Visual validation fixture uses deterministic, audit-linked modeled observations."],
    eventLabels,
    ambiguityLabels: [],
    targetHit: category !== "stop_exit",
    runnerActivated: category === "runner_exit",
    runnerExited: category === "runner_exit",
    runnerReferencePrice: category === "runner_exit" ? audit.targetPrice : null,
    runnerImpulse: category === "runner_exit" ? Math.abs(audit.targetPrice! - entryPrice) : null,
    runnerMostFavorablePrice: category === "runner_exit" ? audit.targetPrice : null,
    remainingQuantity: 0,
    exitReason: outcome,
    legs: [],
  };
  return {
    id: `visual-trade-${category}-${audit.tradingDate}`,
    tradingDate: audit.tradingDate,
    contractSymbol: contract.fullContractSymbol,
    contractMonth: contract.contractMonth,
    period: audit.period,
    setupType: audit.setupType,
    direction,
    entryTime: audit.modeledFillObservationTime!,
    exitTime: audit.exitCandleCloseTime!,
    entryPrice,
    exitPrice,
    contracts: 1,
    grossPnl: direction === "long" ? (exitPrice - entryPrice) * 5 : (entryPrice - exitPrice) * 5,
    fees: 0,
    slippage: 0,
    netPnl: direction === "long" ? (exitPrice - entryPrice) * 5 : (entryPrice - exitPrice) * 5,
    outcome,
    ambiguityLabel: null,
    source: "ohlc",
    segmentation: {
      contract: contract.fullContractSymbol,
      contractMonth: contract.contractMonth,
      setupType: audit.setupType,
      direction,
      timeOfDay: "open",
      trend: direction === "long" ? "bullish" : "bearish",
      fibonacciDepth: "none",
      volumeCondition: "supported",
      levelType: "ORB",
      confluence: "normal",
      patienceCharacteristic: audit.patienceState,
      orbState: audit.orbState as BacktestTrade["segmentation"]["orbState"],
      marketRegime: "trend",
    },
    executionMode: "quote_based_shadow",
    fillLabel: "Visual validation fixture fill",
    audit: tradeAudit,
  };
}

export function createVisualValidationFixtures(request: VisualValidationRequest): VisualValidationFixture[] {
  if (request.symbol !== "MES") throw new Error("Visual validation fixtures are MES-only.");
  const specification = getFuturesContractSpecification("MES");
  const calendar = sessionCalendarForContract(specification);
  const dates = listTradingDates(
    request.endDate,
    Math.max(request.inSampleDays + request.outOfSampleDays, 1),
    calendar,
  );
  const fixtureCategories: VisualValidationCategory[] = [
    "qualified_trade",
    "rejected_setup",
    "bullish_patience_candle",
    "bearish_patience_candle",
    "weak_orb_probe",
    "strong_breakout",
    "pullback",
    "consolidation",
    "ambiguous_candle",
    "stop_exit",
    "target_exit",
    "runner_exit",
  ];
  return fixtureCategories.map((category, index) => {
    const tradingDate = dates[index % dates.length]!;
    const period: BacktestAuditRecord["period"] = dates.slice(0, Math.max(1, request.inSampleDays)).includes(tradingDate)
      ? "in_sample"
      : "out_of_sample";
    const candles = buildCandles(category, specification, calendar, tradingDate, request.seed ?? 11);
    const premarket = request.premarketAvailable === false
      ? []
      : buildCandles(category, specification, calendar, tradingDate, request.seed ?? 11, "premarket");
    const warmupDates = listTradingDates(tradingDate, 3).slice(0, -1);
    const warmupCandles = warmupDates.flatMap((warmupDate) => [
      ...buildCandles("consolidation", specification, calendar, warmupDate, request.seed ?? 11, "premarket"),
      ...buildCandles("consolidation", specification, calendar, warmupDate, request.seed ?? 11),
    ]);
    const dataset: CausalReplayDataset = {
      candles: [...warmupCandles, ...premarket, ...candles],
      contractSymbol: specification.fullContractSymbol,
      contractMonth: specification.contractMonth,
      inSampleDates: dates.slice(0, Math.max(1, request.inSampleDays)),
      outOfSampleDates: dates.slice(-Math.max(1, request.outOfSampleDays)),
      requestedStartDate: dates[0],
      requestedEndDate: dates.at(-1),
      selectedDates: [tradingDate],
      source: "simulated",
      quotesAvailable: true,
    };
    const audit = makeAudit(category, candles, specification, tradingDate, period);
    const trade = makeTrade(category, audit, candles, specification);
    const oneMinute: IntrabarBar[] = category === "ambiguous_candle"
      ? [{
          openTime: candles[FILL_INDEX]!.openTime,
          closeTime: candles[FILL_INDEX]!.closeTime,
          open: candles[FILL_INDEX]!.open,
          high: Math.max(audit.targetPrice!, candles[FILL_INDEX]!.high),
          low: Math.min(audit.strategyStopPrice!, candles[FILL_INDEX]!.low),
          close: candles[FILL_INDEX]!.close,
          source: "one-minute",
          sequenceKnown: false,
        }]
      : [];
    if (oneMinute.length) dataset.oneMinute = oneMinute;
    return {
      category,
      dataset,
      audit,
      trade,
      reviewCloseTime: candles.at(-1)!.closeTime,
    };
  });
}