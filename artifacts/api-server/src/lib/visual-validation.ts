import { createHash } from "node:crypto";
import {
  createMarketSnapshot,
  type MarketSnapshot,
} from "./market-data.js";
import {
  visibleReplayPrefix,
  type BacktestAuditRecord,
  type BacktestReport,
  type BacktestTrade,
  type CausalReplayDataset,
} from "./phase9.js";
import { FIXED_FORMULA_VERSION, formulaConfigurationHash } from "./formula-hash.js";
import type { SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { createVisualValidationFixtures } from "./visual-validation-fixtures.js";

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
  visibility: "machine" | "human_only";
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
  reviews: Array<{
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

export function matchingTrade(record: BacktestAuditRecord, trades: readonly BacktestTrade[]): BacktestTrade | null {
  const candidates = trades.filter((trade) =>
    trade.tradingDate === record.tradingDate
    && trade.contractSymbol === record.contractSymbol
    && trade.setupType === record.setupType
    && trade.direction === record.direction
    && trade.period === record.period,
  );
  const causalMatches = candidates.filter((trade) => {
    const tradeAudit = trade.audit;
    if (!tradeAudit) return false;
    const exactPairs: Array<[string | null, string | null]> = [
      [record.patienceCandleOpenTime, tradeAudit?.patienceCandleOpenTime ?? null],
      [record.patienceCandleCloseTime, tradeAudit?.patienceCandleCloseTime ?? null],
      [record.triggerCandleOpenTime, tradeAudit?.triggerCandleOpenTime ?? null],
      [record.triggerCandleCloseTime, tradeAudit.triggerCandleCloseTime ?? null],
      [record.modeledFillObservationTime, tradeAudit.modeledFillObservationTime ?? null],
      [record.exitCandleOpenTime, tradeAudit.exitCandleOpenTime ?? null],
      [record.exitCandleCloseTime, tradeAudit.exitCandleCloseTime ?? null],
    ];
    return exactPairs.some(([recordValue, tradeValue]) => recordValue !== null || tradeValue !== null)
      && exactPairs.every(([recordValue, tradeValue]) => recordValue === tradeValue);
  });
  return causalMatches.length === 1 ? causalMatches[0]! : null;
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

function hasTrendAlignedPatience(record: BacktestAuditRecord): boolean {
  const trendAligned = record.direction === "long"
    ? /^bullish\s*:/i.test(record.trendEvidence)
    : record.direction === "short"
      ? /^bearish\s*:/i.test(record.trendEvidence)
      : false;
  return trendAligned
    && record.patienceCandle !== null
    && [
      "PATIENCE_CANDLE_VALID",
      "TRIGGER_CANDLE_ACTIVE",
      "BREAK_DETECTED_WAITING_FOR_BUFFER",
      "ENTRY_BUFFER_REACHED",
      "ENTRY_TRIGGERED",
    ].includes(record.patienceState);
}

function hasMappedPullbackEvidence(record: BacktestAuditRecord): boolean {
  const evidence = `${record.pullbackEvidence} ${record.criticalLevelEvidence} ${record.ruleEvidence.join(" ")}`;
  const mappedLevel = /\b(?:orb(?:\s+(?:high|low))?|vwap|(?:200\s*)?ema(?:\s*200)?|fib(?:onacci)?(?:\s+(?:0\.382|0\.5|0\.618|0\.786))?|(?:major|critical)\s+level|prior\s+(?:day|session)\s+(?:high|low)|previous\s+(?:day|session)\s+(?:high|low))\b/i.test(evidence);
  const interaction = /\b(?:touch(?:ed)?|proxim(?:ity|al)|retest(?:ed)?|hold|reclaim(?:ed)?|consolidat(?:e|ed|ion)|interact(?:ed|ion))\b/i.test(record.pullbackEvidence);
  return mappedLevel && interaction;
}

function hasCompletedConsolidation(record: BacktestAuditRecord): boolean {
  const evidence = `${record.pullbackEvidence} ${record.ruleEvidence.join(" ")}`;
  return /\bconsolidat(?:e|ed|ion)\b/i.test(evidence)
    && /(?:\b\d+\b|completed|detected|measured|stable|expansion|window)/i.test(evidence)
    && !/\b(?:pending|incomplete|waiting|not complete)\b/i.test(evidence);
}

export function categoriesFor(record: BacktestAuditRecord, trade: BacktestTrade | null): VisualValidationCategory[] {
  const categories: VisualValidationCategory[] = [];
  if (record.rejectionCategory === "QUALIFIED" && trade) categories.push("qualified_trade");
  if (record.rejectionReason !== null) categories.push("rejected_setup");
  if (hasTrendAlignedPatience(record) && record.direction === "long") categories.push("bullish_patience_candle");
  if (hasTrendAlignedPatience(record) && record.direction === "short") categories.push("bearish_patience_candle");
  if (record.orbState === "ORB_PROBE_WAIT" || record.orbState === "WEAK_BREAK_WAIT") categories.push("weak_orb_probe");
  if (isStrongBreakout(record)) categories.push("strong_breakout");
  if (hasMappedPullbackEvidence(record)) categories.push("pullback");
  if (hasCompletedConsolidation(record)) categories.push("consolidation");
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
  visibility: VisualValidationAnnotation["visibility"] = "machine",
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
    visibility,
  };
}

function buildAnnotations(snapshot: MarketSnapshot, audit: BacktestAuditRecord, trade: BacktestTrade | null): VisualValidationAnnotation[] {
  const lines: VisualValidationAnnotation[] = [];
  const causalBoundary = Date.parse(audit.evaluatedCandleOpenTime) + 5 * 60_000;
  const eventVisibility = (openTime: number | null): VisualValidationAnnotation["visibility"] =>
    openTime === null || openTime <= causalBoundary ? "machine" : "human_only";
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
  lines.push(annotation("orb-high", "ORB high", "price", snapshot.levels.openingRangeHigh, "accent", "Opening range upper boundary."));
  lines.push(annotation("orb-low", "ORB low", "price", snapshot.levels.openingRangeLow, "accent", "Opening range lower boundary."));
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
  lines.push(annotation("entry-trigger", "Entry trigger", "candle", audit.entryTriggerPrice, "accent", "The buffered price trigger that authorizes the modeled entry.", triggerOpen, triggerClose));
  const modeledFillTime = audit.modeledFillObservationTime ? Date.parse(audit.modeledFillObservationTime) : trade?.audit?.modeledFillObservationTime ? Date.parse(trade.audit.modeledFillObservationTime) : trade ? Date.parse(trade.entryTime) : null;
  lines.push(annotation("modeled-fill", "Modeled fill", "candle", trade?.audit?.modeledFillPrice ?? trade?.entryPrice ?? null, "positive", "The modeled execution observation, not a live order or broker fill.", modeledFillTime, modeledFillTime, eventVisibility(modeledFillTime)));
  const entryBuffer = snapshot.patience.entryBufferPrice ?? audit.entryTriggerPrice;
  addLevel("entry-buffer", "Entry buffer", entryBuffer, `${snapshot.patience.entryBufferTicks}-tick confirmation buffer.`, "accent");
  addLevel("strategy-stop", "Strategy stop", audit.strategyStopPrice ?? snapshot.patience.strategyStopPrice, "Formula-defined thesis stop.", "negative");
  addLevel("catastrophe-stop", "Catastrophe stop", audit.catastropheStopPrice, "Hard catastrophe stop.", "negative");
  addLevel("target", "Target", audit.targetPrice ?? trade?.audit?.targetPrice ?? null, "Modeled target.", "positive");
  addLevel("runner-threshold", "Runner threshold", trade?.audit?.runnerReferencePrice ?? snapshot.riskPlan.runner.retracementThreshold ?? null, "Runner reference or retracement threshold.", "positive");
  const exitOpen = audit.exitCandleOpenTime ? Date.parse(audit.exitCandleOpenTime) : trade?.audit?.exitCandleOpenTime ? Date.parse(trade.audit.exitCandleOpenTime) : null;
  const exitClose = audit.exitCandleCloseTime ? Date.parse(audit.exitCandleCloseTime) : trade?.audit?.exitCandleCloseTime ? Date.parse(trade.audit.exitCandleCloseTime) : trade ? Date.parse(trade.exitTime) : null;
  const eventLabels = new Set([...(audit.eventLabels ?? []), ...(trade?.audit?.eventLabels ?? [])]);
  const stopHitTime = exitOpen ?? exitClose;
  if (eventLabels.has("STRATEGY_STOP_REACHED") || trade?.outcome === "strategy stop") {
    lines.push(annotation("strategy-stop-hit", "Strategy stop hit", "candle", audit.strategyStopPrice ?? trade?.audit?.strategyStopPrice ?? null, "negative", "The strategy stop was reached in the bounded execution outcome.", stopHitTime, exitClose, eventVisibility(stopHitTime)));
  }
  if (eventLabels.has("CATASTROPHE_STOP_REACHED") || trade?.outcome === "catastrophe stop") {
    lines.push(annotation("catastrophe-stop-hit", "Catastrophe stop hit", "candle", audit.catastropheStopPrice ?? trade?.audit?.catastropheStopPrice ?? null, "negative", "The catastrophe stop was reached in the bounded execution outcome.", stopHitTime, exitClose, eventVisibility(stopHitTime)));
  }
  if (eventLabels.has("TARGET_REACHED") || trade?.audit?.targetHit === true || trade?.outcome === "target") {
    lines.push(annotation("target-hit", "Target hit", "candle", audit.targetPrice ?? trade?.audit?.targetPrice ?? null, "positive", "The modeled target was reached.", exitOpen, exitClose, eventVisibility(exitOpen)));
  }
  if (eventLabels.has("RUNNER_ACTIVATED") || trade?.audit?.runnerActivated === true) {
    lines.push(annotation("runner-activation", "Runner activation", "candle", trade?.audit?.runnerReferencePrice ?? null, "positive", "The target leg completed and the runner became active.", exitOpen, exitClose, eventVisibility(exitOpen)));
  }
  if (eventLabels.has("RUNNER_EXITED") || trade?.audit?.runnerExited === true) {
    lines.push(annotation("runner-exit", "Runner exit", "candle", trade?.exitPrice ?? null, "accent", "The modeled runner exited; this outcome is human-only when it occurs after the causal cursor.", exitOpen, exitClose, eventVisibility(exitOpen)));
  }
  return lines;
}

function buildMachineSnapshot(
  report: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode">,
  dataset: CausalReplayDataset,
  audit: BacktestAuditRecord,
  trade: BacktestTrade | null,
  sampleIndex: number,
  category: VisualValidationCategory,
  reviewCloseTime: number,
  premarketAvailable: boolean,
): VisualValidationSnapshot {
  const evaluationTime = Date.parse(audit.evaluatedCandleOpenTime);
  const evaluationCloseTime = evaluationTime + 5 * 60_000;
  const exitTime = trade?.audit?.exitCandleCloseTime ? Date.parse(trade.audit.exitCandleCloseTime) : evaluationTime;
  const evaluationCandles = dataset.candles.filter((candle) => candle.contractSymbol === audit.contractSymbol);
  const visibleEvaluation = visibleReplayPrefix(evaluationCandles, evaluationCloseTime);
  const reviewTime = Math.max(evaluationCloseTime, exitTime, reviewCloseTime);
  const visibleReview = visibleReplayPrefix(evaluationCandles, reviewTime);
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
      closeTime: new Date(reviewTime).toISOString(),
      newYork: formatTime(reviewTime, "America/New_York"),
      utc: formatTime(reviewTime, "UTC"),
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

export function buildVisualValidationSet(request: VisualValidationRequest): Omit<VisualValidationSet, "reviewSetId" | "createdAt"> {
  const formulaHash = formulaConfigurationHash({ symbol: request.symbol });
  const fixtureReport: Pick<BacktestReport, "symbol" | "formulaHash" | "executionMode"> = {
    symbol: request.symbol,
    formulaHash,
    executionMode: "quote_based_shadow",
  };
  const fixtures = createVisualValidationFixtures(request);
  const snapshots = fixtures.map((fixture, index) => buildMachineSnapshot(
      fixtureReport,
      fixture.dataset,
      fixture.audit,
      fixture.trade,
      index + 1,
      fixture.category,
      fixture.reviewCloseTime,
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