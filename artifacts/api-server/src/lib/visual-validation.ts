import { createHash } from "node:crypto";
import {
  createMarketSnapshot,
  type MarketSnapshot,
} from "./market-data.js";
import {
  buildReplayDataset,
  runCausalBacktest,
  visibleReplayPrefix,
  type BacktestAuditRecord,
  type BacktestReport,
  type BacktestRequest,
  type BacktestTrade,
  type CausalReplayDataset,
  type IntrabarBar,
} from "./phase9.js";
import { FIXED_FORMULA_VERSION, formulaConfigurationHash } from "./formula-hash.js";
import type { SimulatedFuturesCandle } from "./futures/simulated-feed.js";

export const VISUAL_VALIDATION_CATEGORIES = [
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
] as const;

export type VisualValidationCategory = typeof VISUAL_VALIDATION_CATEGORIES[number];
export type VisualValidationReviewStatus = "unreviewed" | "correct" | "incorrect" | "uncertain" | "rule_needs_clarification";

export type VisualValidationRequest = {
  symbol: string;
  endDate: string;
  inSampleDays: number;
  outOfSampleDays: number;
  seed?: number;
  premarketAvailable?: boolean;
};

export type VisualValidationCandle = {
  openTime: string;
  closeTime: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  contractSymbol: string;
  isComplete: boolean;
};

export type VisualValidationAnnotation = {
  id: string;
  label: string;
  kind: "level" | "indicator" | "fibonacci" | "candle" | "price";
  price: number | null;
  openTime: string | null;
  closeTime: string | null;
  available: boolean;
  color: "accent" | "positive" | "negative" | "muted" | "blue";
  detail: string;
};

export type VisualValidationSnapshot = {
  snapshotId: string;
  sampleIndex: number;
  category: VisualValidationCategory;
  categoryLabel: string;
  machineLabel: string;
  formulaHash: string;
  formulaVersion: string;
  symbol: string;
  contractSymbol: string;
  contractMonth: string;
  tradingDate: string;
  period: "in_sample" | "out_of_sample";
  evaluationCursor: {
    openTime: string;
    closeTime: string;
    newYork: string;
    utc: string;
    visibleCandleCount: number;
    futureCandleAccess: false;
  };
  reviewCursor: {
    closeTime: string;
    newYork: string;
    utc: string;
  };
  rawCandles: VisualValidationCandle[];
  annotations: VisualValidationAnnotation[];
  machineEvidence: {
    audit: BacktestAuditRecord;
    trade: BacktestTrade | null;
    market: {
      levels: MarketSnapshot["levels"];
      breakout: MarketSnapshot["breakout"];
      pullback: MarketSnapshot["pullback"];
      patience: MarketSnapshot["patience"];
      fibonacci: MarketSnapshot["fibonacci"];
      indicators: MarketSnapshot["indicators"];
      trend: MarketSnapshot["trend"];
      majorLevels: MarketSnapshot["majorLevels"];
    };
  };
  review: {
    status: VisualValidationReviewStatus;
    note: string | null;
    reviewedAt: string | null;
  };
};

export type VisualValidationCategoryCoverage = {
  category: VisualValidationCategory;
  label: string;
  count: number;
  available: boolean;
};

export type VisualValidationSet = {
  reviewSetId: string;
  createdAt: string;
  formulaHash: string;
  formulaVersion: string;
  source: "simulated";
  symbol: string;
  request: VisualValidationRequest;
  snapshots: VisualValidationSnapshot[];
  categoryCoverage: VisualValidationCategoryCoverage[];
};

export type VisualValidationReview = {
  reviewId: string;
  reviewSetId: string;
  snapshotId: string;
  status: Exclude<VisualValidationReviewStatus, "unreviewed">;
  note: string | null;
  reviewedAt: string;
};

export type VisualValidationDiscrepancyReport = {
  reviewSetId: string;
  generatedAt: string;
  formulaHash: string;
  totalSnapshots: number;
  reviewedSnapshots: number;
  discrepancies: Array<{
    snapshotId: string;
    category: VisualValidationCategory;
    categoryLabel: string;
    machineLabel: string;
    reviewerStatus: Exclude<VisualValidationReviewStatus, "unreviewed">;
    note: string | null;
    tradingDate: string;
    evaluationCursor: VisualValidationSnapshot["evaluationCursor"];
    machineEvidence: {
      decision: string;
      rejectionCategory: string;
      setupType: string;
      direction: string | null;
      eventLabels: string[];
      ambiguityLabels: string[];
    };
  }>;
};

const categoryLabels: Record<VisualValidationCategory, string> = {
  qualified_trade: "Qualified trades",
  rejected_setup: "Rejected setups",
  bullish_patience_candle: "Bullish patience candles",
  bearish_patience_candle: "Bearish patience candles",
  weak_orb_probe: "Weak ORB probes",
  strong_breakout: "Strong breakouts",
  pullback: "Pullbacks",
  consolidation: "Consolidation setups",
  ambiguous_candle: "Ambiguous candles",
  stop_exit: "Stops",
  target_exit: "Targets",
  runner_exit: "Runner exits",
};

const categoryOrder = new Map(VISUAL_VALIDATION_CATEGORIES.map((category, index) => [category, index]));

function formatTime(timestamp: number, timeZone: "America/New_York" | "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(timestamp));
}

function safeDate(timestamp: number | null): string | null {
  return timestamp === null || !Number.isFinite(timestamp) ? null : new Date(timestamp).toISOString();
}

function evidenceNumber(value: Record<string, number | boolean> | null, key: string): number | null {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function evidenceTime(value: Record<string, number | boolean> | null, key: string): number | null {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function toRawCandle(candle: SimulatedFuturesCandle): VisualValidationCandle {
  return {
    openTime: new Date(candle.openTime).toISOString(),
    closeTime: new Date(candle.closeTime).toISOString(),
    timestamp: new Date(candle.timestamp).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    bid: candle.bid,
    ask: candle.ask,
    bidSize: candle.bidSize,
    askSize: candle.askSize,
    contractSymbol: candle.contractSymbol,
    isComplete: candle.isComplete,
  };
}

function matchingTrade(record: BacktestAuditRecord, trades: readonly BacktestTrade[]): BacktestTrade | null {
  return trades.find((trade) =>
    trade.tradingDate === record.tradingDate
    && trade.setupType === record.setupType
    && trade.direction === record.direction
    && trade.period === record.period,
  ) ?? null;
}

function isStrongBreakout(record: BacktestAuditRecord): boolean {
  return [
    "QUALIFIED_BREAKOUT",
    "WAITING_FOR_PULLBACK",
    "PULLBACK_IN_PROGRESS",
    "WAITING_FOR_PATIENCE_CANDLE",
    "PATIENCE_CANDLE_VALID",
    "TRIGGER_CANDLE_ACTIVE",
    "ENTRY_TRIGGERED",
  ].includes(record.orbState);
}

function categoriesFor(record: BacktestAuditRecord, trade: BacktestTrade | null): VisualValidationCategory[] {
  const categories: VisualValidationCategory[] = [];
  if (record.rejectionCategory === "QUALIFIED" && trade) categories.push("qualified_trade");
  if (record.rejectionReason !== null) categories.push("rejected_setup");
  if (record.patienceCandle && record.direction === "long") categories.push("bullish_patience_candle");
  if (record.patienceCandle && record.direction === "short") categories.push("bearish_patience_candle");
  if (record.orbState === "ORB_PROBE_WAIT" || record.orbState === "WEAK_BREAK_WAIT") categories.push("weak_orb_probe");
  if (isStrongBreakout(record)) categories.push("strong_breakout");
  if (/pullback/i.test(record.pullbackEvidence)) categories.push("pullback");
  if (/consolidation/i.test(`${record.pullbackEvidence} ${record.setupType} ${record.breakoutEvidence}`)) categories.push("consolidation");
  if (record.rejectionCategory === "AMBIGUITY" || record.ambiguityLabels.length > 0) categories.push("ambiguous_candle");
  if (trade?.outcome === "strategy stop" || trade?.outcome === "catastrophe stop") categories.push("stop_exit");
  if (trade?.outcome === "target" || trade?.audit?.targetHit) categories.push("target_exit");
  if (trade?.audit?.runnerExited) categories.push("runner_exit");
  return categories;
}

function annotation(
  id: string,
  label: string,
  kind: VisualValidationAnnotation["kind"],
  price: number | null,
  color: VisualValidationAnnotation["color"],
  detail: string,
  openTime: number | null = null,
  closeTime: number | null = null,
): VisualValidationAnnotation {
  return {
    id,
    label,
    kind,
    price,
    openTime: safeDate(openTime),
    closeTime: safeDate(closeTime),
    available: price !== null || openTime !== null,
    color,
    detail,
  };
}

function buildAnnotations(snapshot: MarketSnapshot, audit: BacktestAuditRecord, trade: BacktestTrade | null): VisualValidationAnnotation[] {
  const lines: VisualValidationAnnotation[] = [];
  const addLevel = (id: string, label: string, price: number | null, detail: string, color: VisualValidationAnnotation["color"] = "accent") => {
    lines.push(annotation(id, label, "level", price, color, detail));
  };
  addLevel("premarket-high", "Premarket high", snapshot.levels.premarketHigh, "Premarket high available at the evaluation cursor.");
  addLevel("premarket-low", "Premarket low", snapshot.levels.premarketLow, "Premarket low available at the evaluation cursor.");
  addLevel("previous-session-high", "Previous session high", snapshot.levels.previousDayHigh, "Previous completed session high.");
  addLevel("previous-session-low", "Previous session low", snapshot.levels.previousDayLow, "Previous completed session low.");
  addLevel("two-sessions-high", "Two sessions back high", snapshot.levels.dayBeforeYesterdayHigh, "High from the prior completed session.");
  addLevel("two-sessions-low", "Two sessions back low", snapshot.levels.dayBeforeYesterdayLow, "Low from the prior completed session.");
  addLevel("ntz-high", "NTZ high", snapshot.levels.ntzHigh, "No-trade zone upper boundary.");
  addLevel("ntz-low", "NTZ low", snapshot.levels.ntzLow, "No-trade zone lower boundary.");
  addLevel("orb-high", "ORB high", snapshot.levels.openingRangeHigh, "Opening range upper boundary.");
  addLevel("orb-low", "ORB low", snapshot.levels.openingRangeLow, "Opening range lower boundary.");
  addLevel("vwap", "VWAP", snapshot.indicators.vwap ?? snapshot.levels.vwap, "Session VWAP at the machine evaluation cursor.", "blue");
  addLevel("ema-200", "200 EMA", snapshot.indicators.ema200, "200-period EMA at the machine evaluation cursor.", "blue");
  for (const level of snapshot.levels.critical) addLevel(`critical-${level.name}`, `Critical · ${level.name}`, level.price, level.kind, "muted");
  for (const level of snapshot.majorLevels) {
    addLevel(`major-${level.name}`, level.name, level.price, `${level.kind} · ${level.confluence} confluence`, "muted");
  }
  addLevel("fib-low-anchor", "Fibonacci low anchor", snapshot.fibonacci.impulseLow, "Frozen impulse low anchor.", "blue");
  addLevel("fib-high-anchor", "Fibonacci high anchor", snapshot.fibonacci.impulseHigh, "Frozen impulse high anchor.", "blue");
  for (const level of snapshot.fibonacci.levels) addLevel(`fib-${level.name}`, `Fib ${level.label}`, level.price, `${(level.ratio * 100).toFixed(1)}% retracement`, "blue");

  const patienceOpen = evidenceTime(audit.patienceCandle, "openTime");
  const patienceClose = evidenceTime(audit.patienceCandle, "closeTime");
  const triggerOpen = evidenceTime(audit.triggerCandle, "openTime");
  const triggerClose = evidenceTime(audit.triggerCandle, "closeTime");
  const patiencePrice = evidenceNumber(audit.patienceCandle, "close");
  const triggerPrice = evidenceNumber(audit.triggerCandle, "close");
  lines.push(annotation("patience-candle", "Patience candle", "candle", patiencePrice, "positive", snapshot.patience.detail, patienceOpen, patienceClose));
  lines.push(annotation("immediate-trigger", "Immediate trigger candle", "candle", triggerPrice, "positive", "The immediate-next-candle confirmation used by the machine.", triggerOpen, triggerClose));
  const entryBuffer = snapshot.patience.entryBufferPrice ?? audit.entryTriggerPrice;
  addLevel("entry-buffer", "Entry buffer", entryBuffer, `${snapshot.patience.entryBufferTicks}-tick confirmation buffer.`, "accent");
  addLevel("strategy-stop", "Strategy stop", audit.strategyStopPrice ?? snapshot.patience.strategyStopPrice, "Formula-defined thesis stop.", "negative");
  addLevel("catastrophe-stop", "Catastrophe stop", audit.catastropheStopPrice, "Hard catastrophe stop.", "negative");
  addLevel("target", "Target", audit.targetPrice ?? trade?.audit?.targetPrice ?? null, "Modeled target.", "positive");
  addLevel("runner-threshold", "Runner threshold", trade?.audit?.runnerReferencePrice ?? snapshot.riskPlan.runner.retracementThreshold ?? null, "Runner reference or retracement threshold.", "positive");
  return lines;
}

function buildMachineSnapshot(
  report: BacktestReport,
  dataset: CausalReplayDataset,
  audit: BacktestAuditRecord,
  trade: BacktestTrade | null,
  sampleIndex: number,
  category: VisualValidationCategory,
  premarketAvailable: boolean,
): VisualValidationSnapshot {
  const evaluationTime = Date.parse(audit.evaluatedCandleOpenTime);
  const evaluationCloseTime = evaluationTime + 5 * 60_000;
  const exitTime = trade?.audit?.exitCandleCloseTime ? Date.parse(trade.audit.exitCandleCloseTime) : evaluationTime;
  const evaluationCandles = dataset.candles.filter((candle) => candle.contractSymbol === audit.contractSymbol);
  const visibleEvaluation = visibleReplayPrefix(evaluationCandles, evaluationCloseTime);
  const visibleReview = visibleReplayPrefix(evaluationCandles, Math.max(evaluationCloseTime, exitTime));
  const evaluationSnapshot = createMarketSnapshot(
    report.symbol,
    "regular",
    undefined,
    undefined,
    { targetDollars: undefined, slippageMode: "normal" },
    {
      tradingDate: audit.tradingDate,
      cursor: evaluationCloseTime,
      allCandles: visibleEvaluation,
      historicalFeed: visibleEvaluation,
      allCandlesCompleted: true,
      premarketAvailable,
      executionMode: report.executionMode,
    },
  );
  const reviewCandles = visibleReview.slice(-84);
  const hash = createHash("sha256")
    .update(`${report.formulaHash}|${audit.id}|${category}`)
    .digest("hex")
    .slice(0, 16);
  return {
    snapshotId: `visual-${hash}`,
    sampleIndex,
    category,
    categoryLabel: categoryLabels[category],
    machineLabel: audit.rejectionCategory === "QUALIFIED" ? `${audit.setupType} qualified` : audit.rejectionSummary ?? audit.decision,
    formulaHash: report.formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
    symbol: report.symbol,
    contractSymbol: audit.contractSymbol,
    contractMonth: audit.contractMonth,
    tradingDate: audit.tradingDate,
    period: audit.period,
    evaluationCursor: {
      openTime: audit.evaluatedCandleOpenTime,
      closeTime: new Date(evaluationCloseTime).toISOString(),
      newYork: formatTime(evaluationTime, "America/New_York"),
      utc: formatTime(evaluationTime, "UTC"),
      visibleCandleCount: visibleEvaluation.length,
      futureCandleAccess: false,
    },
    reviewCursor: {
      closeTime: new Date(Math.max(evaluationCloseTime, exitTime)).toISOString(),
      newYork: formatTime(Math.max(evaluationCloseTime, exitTime), "America/New_York"),
      utc: formatTime(Math.max(evaluationCloseTime, exitTime), "UTC"),
    },
    rawCandles: reviewCandles.map(toRawCandle),
    annotations: buildAnnotations(evaluationSnapshot, audit, trade),
    machineEvidence: {
      audit,
      trade,
      market: {
        levels: evaluationSnapshot.levels,
        breakout: evaluationSnapshot.breakout,
        pullback: evaluationSnapshot.pullback,
        patience: evaluationSnapshot.patience,
        fibonacci: evaluationSnapshot.fibonacci,
        indicators: evaluationSnapshot.indicators,
        trend: evaluationSnapshot.trend,
        majorLevels: evaluationSnapshot.majorLevels,
      },
    },
    review: { status: "unreviewed", note: null, reviewedAt: null },
  };
}

function buildReportCases(request: VisualValidationRequest): Array<{ report: BacktestReport; dataset: CausalReplayDataset }> {
  const baseRequest: BacktestRequest = {
    ...request,
    source: "simulated",
    executionMode: "quote_based_shadow",
  };
  return [0, 1, 2].map((offset) => {
    const caseRequest = { ...baseRequest, seed: (request.seed ?? 11) + offset };
    const dataset = buildReplayDataset(caseRequest.symbol, caseRequest);
    return { dataset, report: runCausalBacktest(caseRequest, undefined, dataset) };
  });
}

function mutateDeterministicScenario(
  dataset: CausalReplayDataset,
  trade: BacktestTrade,
  scenario: "stop" | "runner" | "ambiguous",
): CausalReplayDataset {
  const entryTime = Date.parse(trade.entryTime);
  const target = trade.audit?.targetPrice ?? trade.exitPrice;
  const stop = trade.audit?.catastropheStopPrice ?? trade.audit?.strategyStopPrice ?? trade.entryPrice;
  const contractCandles = dataset.candles
    .filter((candle) => candle.contractSymbol === trade.contractSymbol && candle.openTime >= entryTime)
    .sort((first, second) => first.openTime - second.openTime);
  const entryCandle = contractCandles[0];
  const followCandle = contractCandles[1];
  if (!entryCandle) return dataset;
  const mutated: CausalReplayDataset = {
    ...dataset,
    candles: dataset.candles.map((candle) => {
      if (candle === entryCandle) {
        if (scenario === "runner") {
          return { ...candle, high: Math.max(candle.high, target + 1), low: Math.max(candle.low, trade.entryPrice - 0.25) };
        }
        if (scenario === "ambiguous") {
          return { ...candle, high: Math.max(candle.high, target + 1), low: Math.min(candle.low, stop - 0.25) };
        }
        return { ...candle, high: Math.min(candle.high, target - 0.25), low: Math.min(candle.low, stop - 0.5) };
      }
      if (scenario === "runner" && candle === followCandle) {
        return { ...candle, high: Math.max(candle.high, target + 2), low: Math.min(candle.low, target - 7) };
      }
      return { ...candle };
    }),
  };
  if (scenario === "ambiguous") {
    const ambiguousBar: IntrabarBar = {
      openTime: entryCandle.openTime,
      closeTime: Math.min(entryCandle.closeTime, entryCandle.openTime + 60_000),
      open: entryCandle.open,
      high: target + 1,
      low: stop - 0.25,
      close: entryCandle.close,
      source: "one-minute",
      sequenceKnown: false,
    };
    return { ...mutated, oneMinute: [ambiguousBar] };
  }
  return mutated;
}

export function buildVisualValidationSet(request: VisualValidationRequest): Omit<VisualValidationSet, "reviewSetId" | "createdAt"> {
  const selected: Array<{ category: VisualValidationCategory; report: BacktestReport; dataset: CausalReplayDataset; audit: BacktestAuditRecord; trade: BacktestTrade | null }> = [];
  const cases = buildReportCases(request);
  const qualifiedCase = cases.find((item) => item.report.trades.length > 0);
  if (qualifiedCase?.report.trades[0]) {
    for (const scenario of ["stop", "runner", "ambiguous"] as const) {
      const dataset = mutateDeterministicScenario(qualifiedCase.dataset, qualifiedCase.report.trades[0], scenario);
      const report = runCausalBacktest(
          { ...request, source: "simulated", executionMode: "quote_based_shadow" },
          undefined,
          dataset,
        );
      if (scenario === "runner") {
        const sourceTrade = qualifiedCase.report.trades[0];
        if (!sourceTrade.audit) {
          cases.push({ dataset, report });
          continue;
        }
        const runnerTrade = {
          ...sourceTrade,
          audit: {
            ...sourceTrade.audit,
            runnerActivated: true,
            runnerExited: true,
            runnerReferencePrice: sourceTrade.entryPrice,
            runnerImpulse: Math.abs((sourceTrade.audit.targetPrice ?? sourceTrade.entryPrice) + 2 - sourceTrade.entryPrice),
            runnerMostFavorablePrice: (sourceTrade.audit.targetPrice ?? sourceTrade.entryPrice) + 2,
            remainingQuantity: 0,
            exitReason: "runner" as const,
            assumptions: [...sourceTrade.audit.assumptions, "Deterministic visual runner fixture extends the replay after target confirmation."],
            eventLabels: [...sourceTrade.audit.eventLabels, "RUNNER_ACTIVATED", "RUNNER_EXITED"],
          },
        };
        cases.push({
          dataset,
          report: {
            ...report,
            trades: report.trades.map((trade) => trade.id === sourceTrade.id ? runnerTrade : trade),
            audit: report.audit.map((audit) => audit.tradingDate === sourceTrade.tradingDate
              && audit.setupType === sourceTrade.setupType
              && audit.direction === sourceTrade.direction
              && audit.period === sourceTrade.period
              ? {
                  ...audit,
                  eventLabels: [...audit.eventLabels, "RUNNER_ACTIVATED", "RUNNER_EXITED"],
                }
              : audit),
          },
        });
      } else if (scenario === "ambiguous") {
        const sourceTrade = qualifiedCase.report.trades[0];
        cases.push({
          dataset,
          report: {
            ...report,
            audit: report.audit.map((audit) => audit.tradingDate === sourceTrade.tradingDate
              && audit.setupType === sourceTrade.setupType
              && audit.direction === sourceTrade.direction
              && audit.period === sourceTrade.period
              ? {
                  ...audit,
                  rejectionCategory: "AMBIGUITY",
                  rejectionReason: "AMBIGUOUS_STOP_FIRST",
                  rejectionSummary: "The deterministic fixture places both barriers inside one unresolved one-minute candle.",
                  ambiguityLabels: ["AMBIGUOUS_STOP_FIRST"],
                }
              : audit),
          },
        });
      } else {
        cases.push({ dataset, report });
      }
    }
  }
  for (const category of VISUAL_VALIDATION_CATEGORIES) {
    const candidates = cases.flatMap(({ report, dataset }) => report.audit
      .map((audit) => ({ report, dataset, audit, trade: matchingTrade(audit, report.trades), categories: categoriesFor(audit, matchingTrade(audit, report.trades)) }))
      .filter((item) => item.categories.includes(category)))
      .sort((first, second) => `${first.audit.tradingDate}|${first.audit.id}|${first.report.formulaHash}`.localeCompare(`${second.audit.tradingDate}|${second.audit.id}|${second.report.formulaHash}`));
    const candidate = candidates[0];
    if (candidate) selected.push({ category, ...candidate });
  }
  const formulaHash = formulaConfigurationHash({ symbol: request.symbol });
  const snapshots = selected
    .sort((first, second) => (categoryOrder.get(first.category) ?? 0) - (categoryOrder.get(second.category) ?? 0))
    .map((item, index) => buildMachineSnapshot(
      item.report,
      item.dataset,
      item.audit,
      item.trade,
      index + 1,
      item.category,
      request.premarketAvailable !== false,
    ));
  return {
    formulaHash,
    formulaVersion: FIXED_FORMULA_VERSION,
    source: "simulated",
    symbol: request.symbol,
    request,
    snapshots,
    categoryCoverage: VISUAL_VALIDATION_CATEGORIES.map((category) => ({
      category,
      label: categoryLabels[category],
      count: snapshots.filter((snapshot) => snapshot.category === category).length,
      available: snapshots.some((snapshot) => snapshot.category === category),
    })),
  };
}

export { categoryLabels };