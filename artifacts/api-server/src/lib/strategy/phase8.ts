import type { FuturesContractSpecification } from "../futures/contracts.js";
import type { BreakoutEvent, FibonacciAnalysis, Phase4VolumeAnalysis, PullbackAnalysis } from "./phase4.js";
import type { Phase6Decision, SetupEvaluation } from "./phase6.js";
import type { NtzEvent, NtzRange, SessionLevels } from "./levels.js";
import type { PatienceAnalysis } from "./phase5.js";
import type { Phase7Accounting, Phase7RiskPlan, SlippageMode } from "./phase7.js";
import type { Candle, Direction, TrendDirection } from "./types.js";

export type Phase8EventType =
  | "NTZ completion"
  | "ORB quality"
  | "Breakout"
  | "Pullback"
  | "Level touch or proximity"
  | "Consolidation"
  | "Fibonacci depth"
  | "Volume warning"
  | "Patience candle"
  | "Immediate trigger"
  | "Shadow entry"
  | "Partial profit"
  | "Runner activation"
  | "Runner exit"
  | "Stop"
  | "Failed setup";

export type Phase8EventStatus = "observed" | "passed" | "warning" | "blocked" | "simulated";

export type Phase8TimelineEvent = {
  time: number;
  eventType: Phase8EventType;
  label: string;
  detail: string;
  status: Phase8EventStatus;
};

export type ShadowQuote = {
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  time?: number;
};

export type ShadowFillLeg = {
  kind: "target" | "runner" | "full";
  contracts: number;
  quoteSide: "bid" | "ask";
  referencePrice: number;
  fillPrice: number;
  modeledSlippageTicks: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
};

export type Phase8Execution = {
  mode: "shadow";
  entryQuoteSide: "ask" | "bid";
  exitQuoteSide: "bid" | "ask" | null;
  entryReferencePrice: number;
  entryFillPrice: number;
  exitReferencePrice: number | null;
  exitFillPrice: number | null;
  entrySlippageTicks: number;
  exitSlippageTicks: number | null;
  contracts: number;
  targetContracts: number;
  runnerContracts: number;
  targetHit: boolean;
  runnerActivated: boolean;
  runnerExited: boolean;
  stop: "strategy" | "catastrophe" | null;
  exitReason: "target" | "runner" | "strategy stop" | "catastrophe stop" | "manual" | "not filled";
  legs: ShadowFillLeg[];
  accounting: Phase7Accounting;
};

export type Phase8Excursions = {
  maximumFavorableExcursion: number;
  maximumAdverseExcursion: number;
  favorablePrice: number | null;
  adversePrice: number | null;
};

export type Phase8SetupOutcome = "qualified" | "rejected" | "expired" | "ambiguous";

export type Phase8EvaluationRecord = {
  setupType: SetupEvaluation["setupType"];
  direction: Direction | null;
  decision: Phase6Decision;
  outcome: Phase8SetupOutcome;
  timeline: Phase8TimelineEvent[];
  execution: Phase8Execution | null;
  excursions: Phase8Excursions;
  passedRules: SetupEvaluation["rules"];
  failedRules: SetupEvaluation["rules"];
};

type CandleWithQuote = Candle & ShadowQuote;

type TimelineContext = {
  candles: readonly CandleWithQuote[];
  ntz: NtzRange | null;
  ntzEvents: readonly NtzEvent[];
  breakout: BreakoutEvent;
  pullback: PullbackAnalysis;
  fibonacci: FibonacciAnalysis;
  volume: Phase4VolumeAnalysis;
  patience: PatienceAnalysis;
  evaluation: SetupEvaluation;
  riskPlan: Phase7RiskPlan;
  direction: Direction | null;
  trend: TrendDirection;
  specification: FuturesContractSpecification;
  slippageMode?: SlippageMode;
  now: number;
};

function money(value: number): number {
  return Number(value.toFixed(2));
}

function positive(value: number): number {
  return Math.max(0, value);
}

function slippageTicks(mode: SlippageMode, observedSpreadTicks: number, normalTicks = 1, fastTicks = 2): number {
  if (mode === "fast") return fastTicks;
  if (mode === "abnormal_spread") return Math.max(1, Math.ceil(observedSpreadTicks)) + 1;
  return normalTicks;
}

function feesForContracts(contracts: number, specification: FuturesContractSpecification): number {
  const perSide = specification.commissionPerContract
    + (specification.exchangeFeePerContract ?? specification.exchangeAndRegulatoryFeesPerContract)
    + (specification.regulatoryFeePerContract ?? 0)
    + (specification.clearingFeePerContract ?? 0);
  return money(contracts * perSide * 2);
}

function fillPrice(direction: Direction, quote: ShadowQuote, side: "entry" | "exit", slippage: number, tickSize: number): { price: number; quoteSide: "ask" | "bid" } {
  if (side === "entry") {
    return direction === "long"
      ? { price: quote.ask + slippage * tickSize, quoteSide: "ask" }
      : { price: quote.bid - slippage * tickSize, quoteSide: "bid" };
  }
  return direction === "long"
    ? { price: quote.bid - slippage * tickSize, quoteSide: "bid" }
    : { price: quote.ask + slippage * tickSize, quoteSide: "ask" };
}

function legAccounting(
  direction: Direction,
  entryFill: number,
  referencePrice: number,
  exitFill: number,
  entrySlippageTicks: number,
  exitSlippageTicks: number,
  contracts: number,
  specification: FuturesContractSpecification,
  kind: ShadowFillLeg["kind"],
  quoteSide: "bid" | "ask",
): ShadowFillLeg {
  const multiplier = specification.pointValue * specification.contractMultiplier;
  const sign = direction === "long" ? 1 : -1;
  const gross = (exitFill - entryFill) * contracts * multiplier * sign;
  const theoretical = (referencePrice - entryFill) * contracts * multiplier * sign;
  const slippage = (entrySlippageTicks + exitSlippageTicks) * contracts * specification.dollarValuePerTick;
  const fees = feesForContracts(contracts, specification);
  return {
    kind,
    contracts,
    quoteSide,
    referencePrice,
    fillPrice: money(exitFill),
    modeledSlippageTicks: entrySlippageTicks + exitSlippageTicks,
    grossPnl: money(gross),
    fees,
    slippage: money(positive(theoretical - gross) || slippage),
    netPnl: money(gross - fees),
  };
}

export function simulatePhase8ShadowExecution(input: {
  direction: Direction;
  entryQuote: ShadowQuote;
  exitQuote?: ShadowQuote | null;
  entryReferencePrice: number;
  exitReferencePrice?: number | null;
  currentPrice?: number;
  high?: number;
  low?: number;
  contracts: number;
  targetContracts?: number;
  runnerContracts?: number;
  target?: number | null;
  strategyStop?: number | null;
  catastropheStop?: number | null;
  runnerReferencePrice?: number | null;
  runnerImpulse?: number | null;
  runnerMostFavorablePrice?: number | null;
  specification: FuturesContractSpecification;
  slippageMode?: SlippageMode;
  observedSpreadTicks?: number;
  normalSlippageTicks?: number;
  fastSlippageTicks?: number;
}): Phase8Execution {
  if (!Number.isInteger(input.contracts) || input.contracts < 0) throw new Error("Shadow execution contracts must be a whole, non-negative number.");
  const mode = input.slippageMode ?? "normal";
  const entrySlip = slippageTicks(mode, input.observedSpreadTicks ?? 1, input.normalSlippageTicks, input.fastSlippageTicks);
  const entry = fillPrice(input.direction, input.entryQuote, "entry", entrySlip, input.specification.tickSize);
  if (input.contracts === 0 || !input.exitQuote) {
    return {
      mode: "shadow",
      entryQuoteSide: entry.quoteSide,
      exitQuoteSide: null,
      entryReferencePrice: input.entryReferencePrice,
      entryFillPrice: money(entry.price),
      exitReferencePrice: null,
      exitFillPrice: null,
      entrySlippageTicks: entrySlip,
      exitSlippageTicks: null,
      contracts: input.contracts,
      targetContracts: 0,
      runnerContracts: 0,
      targetHit: false,
      runnerActivated: false,
      runnerExited: false,
      stop: null,
      exitReason: "not filled",
      legs: [],
      accounting: { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 },
    };
  }

  const targetContracts = Math.min(input.contracts, Math.max(0, input.targetContracts ?? input.contracts));
  const runnerContracts = Math.min(input.contracts - targetContracts, Math.max(0, input.runnerContracts ?? 0));
  const high = input.high ?? input.currentPrice ?? input.entryReferencePrice;
  const low = input.low ?? input.currentPrice ?? input.entryReferencePrice;
  const targetHit = input.target !== null && input.target !== undefined
    && (input.direction === "long" ? high >= input.target : low <= input.target);
  const stopHit = input.catastropheStop !== null && input.catastropheStop !== undefined
    && (input.direction === "long" ? low <= input.catastropheStop : high >= input.catastropheStop);
  const strategyHit = input.strategyStop !== null && input.strategyStop !== undefined
    && (input.direction === "long" ? low <= input.strategyStop : high >= input.strategyStop);
  const stop = stopHit ? "catastrophe" : strategyHit ? "strategy" : null;
  const stopReference = stop === "catastrophe" ? input.catastropheStop! : input.strategyStop;
  const targetReference = targetHit ? input.target! : null;
  const fullExitReference = stopReference ?? targetReference ?? input.exitReferencePrice ?? input.currentPrice ?? input.entryReferencePrice;
  const exitSlip = slippageTicks(mode, input.observedSpreadTicks ?? 1, input.normalSlippageTicks, input.fastSlippageTicks);
  const exit = fillPrice(input.direction, input.exitQuote, "exit", exitSlip, input.specification.tickSize);
  const referenceForExit = stopReference ?? targetReference ?? fullExitReference;
  const legs: ShadowFillLeg[] = [];

  if (stop || !targetHit) {
    legs.push(legAccounting(input.direction, entry.price, input.entryReferencePrice, exit.price, entrySlip, exitSlip, input.contracts, input.specification, "full", exit.quoteSide));
  } else {
    if (targetContracts > 0) {
      const targetExit = fillPrice(input.direction, input.exitQuote, "exit", exitSlip, input.specification.tickSize);
      legs.push(legAccounting(input.direction, entry.price, input.target!, targetExit.price, entrySlip, exitSlip, targetContracts, input.specification, "target", targetExit.quoteSide));
    }
    const runnerActivated = runnerContracts > 0;
    const runnerReference = input.runnerReferencePrice ?? input.entryReferencePrice;
    const runnerMostFavorable = input.runnerMostFavorablePrice
      ?? (input.direction === "long" ? high : low);
    const runnerImpulse = input.runnerImpulse ?? Math.abs(runnerMostFavorable - runnerReference);
    const adverseRetracement = input.direction === "long"
      ? Math.max(0, runnerMostFavorable - (input.currentPrice ?? input.target!))
      : Math.max(0, (input.currentPrice ?? input.target!) - runnerMostFavorable);
    const runnerExited = runnerActivated && runnerImpulse > 0 && adverseRetracement >= runnerImpulse * 0.4;
    if (runnerActivated && runnerExited) {
      const runnerExit = fillPrice(input.direction, input.exitQuote, "exit", exitSlip, input.specification.tickSize);
      legs.push(legAccounting(input.direction, entry.price, input.currentPrice ?? input.target!, runnerExit.price, entrySlip, exitSlip, runnerContracts, input.specification, "runner", runnerExit.quoteSide));
    }
  }

  const accounting = legs.reduce<Phase7Accounting>((total, leg) => ({
    grossPnl: money(total.grossPnl + leg.grossPnl),
    slippage: money(total.slippage + leg.slippage),
    fees: money(total.fees + leg.fees),
    netPnl: money(total.netPnl + leg.netPnl),
  }), { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 });
  const runnerActivated = !stop && targetHit && runnerContracts > 0;
  const runnerMostFavorable = input.runnerMostFavorablePrice
    ?? (input.direction === "long" ? high : low);
  const runnerReference = input.runnerReferencePrice ?? input.entryReferencePrice;
  const runnerImpulse = input.runnerImpulse ?? Math.abs(runnerMostFavorable - runnerReference);
  const adverseRetracement = input.direction === "long"
    ? Math.max(0, runnerMostFavorable - (input.currentPrice ?? input.target ?? input.entryReferencePrice))
    : Math.max(0, (input.currentPrice ?? input.target ?? input.entryReferencePrice) - runnerMostFavorable);
  const runnerExited = runnerActivated && runnerImpulse > 0 && adverseRetracement >= runnerImpulse * 0.4;
  return {
    mode: "shadow",
    entryQuoteSide: entry.quoteSide,
    exitQuoteSide: exit.quoteSide,
    entryReferencePrice: input.entryReferencePrice,
    entryFillPrice: money(entry.price),
    exitReferencePrice: money(referenceForExit),
    exitFillPrice: money(exit.price),
    entrySlippageTicks: entrySlip,
    exitSlippageTicks: exitSlip,
    contracts: input.contracts,
    targetContracts: targetHit ? targetContracts : 0,
    runnerContracts: targetHit ? runnerContracts : 0,
    targetHit,
    runnerActivated,
    runnerExited,
    stop,
    exitReason: stop === "catastrophe" ? "catastrophe stop" : stop === "strategy" ? "strategy stop" : runnerExited ? "runner" : targetHit ? "target" : "manual",
    legs,
    accounting,
  };
}

export function calculatePhase8Excursions(
  direction: Direction,
  entry: number,
  candles: readonly Pick<Candle, "high" | "low">[],
  specification: FuturesContractSpecification,
): Phase8Excursions {
  if (!candles.length) return { maximumFavorableExcursion: 0, maximumAdverseExcursion: 0, favorablePrice: null, adversePrice: null };
  const favorablePrice = direction === "long" ? Math.max(...candles.map((candle) => candle.high)) : Math.min(...candles.map((candle) => candle.low));
  const adversePrice = direction === "long" ? Math.min(...candles.map((candle) => candle.low)) : Math.max(...candles.map((candle) => candle.high));
  const multiplier = specification.pointValue * specification.contractMultiplier;
  return {
    maximumFavorableExcursion: money(positive((favorablePrice - entry) * multiplier * (direction === "long" ? 1 : -1))),
    maximumAdverseExcursion: money(positive((entry - adversePrice) * multiplier * (direction === "long" ? 1 : -1))),
    favorablePrice: money(favorablePrice),
    adversePrice: money(adversePrice),
  };
}

export function setupOutcome(decision: Phase6Decision): Phase8SetupOutcome {
  if (decision === "SETUP QUALIFIED") return "qualified";
  if (decision === "EXPIRED") return "expired";
  if (decision === "AMBIGUOUS") return "ambiguous";
  return "rejected";
}

function event(
  events: Phase8TimelineEvent[],
  time: number,
  eventType: Phase8EventType,
  detail: string,
  status: Phase8EventStatus,
  label: string = eventType,
): void {
  events.push({ time, eventType, label, detail, status });
}

export function buildPhase8Timeline(context: TimelineContext): Phase8TimelineEvent[] {
  const events: Phase8TimelineEvent[] = [];
  const lastCandle = context.candles.at(-1);
  const fallbackTime = lastCandle?.closeTime ?? context.now;
  const ntzCompleted = context.ntzEvents.find((item) => item.type === "NTZ completed");
  if (ntzCompleted) event(events, ntzCompleted.time, "NTZ completion", ntzCompleted.detail, "passed");
  else if (context.ntz?.complete) event(events, context.now, "NTZ completion", "NTZ is complete in the current replay.", "passed");
  if (context.breakout.detected && context.breakout.time !== null) {
    event(events, context.breakout.time, "Breakout", context.breakout.detail, "observed");
  }
  if (context.breakout.candidateTime !== null) {
    event(
      events,
      context.breakout.candidateTime,
      "ORB quality",
      context.breakout.detail,
      context.breakout.failed ? "warning" : context.breakout.detected ? "passed" : "observed",
      `ORB · ${context.breakout.state}`,
    );
  }
  for (const item of context.pullback.events) {
    const type = item.type === "consolidation" ? "Consolidation" : ["touch", "proximity"].includes(item.type) ? "Level touch or proximity" : "Pullback";
    event(events, item.time, type, item.detail, item.type === "break through" ? "warning" : "observed", `${item.type} · ${item.level}`);
  }
  for (const item of context.ntzEvents.filter((item) => item.type === "Consolidation inside NTZ")) {
    event(events, item.time, "Consolidation", item.detail, "observed");
  }
  const fibTime = context.fibonacci.frozenAt ?? context.fibonacci.breakoutTime ?? fallbackTime;
  event(events, fibTime, "Fibonacci depth", context.fibonacci.detail, context.fibonacci.classification === "deep" || context.fibonacci.classification === "elevated failure risk" ? "warning" : "observed");
  const volumeTime = context.breakout.time ?? fallbackTime;
  if (context.volume.reversalWarning) event(events, volumeTime, "Volume warning", context.volume.reversalWarning, "warning");
  else event(events, volumeTime, "Volume warning", context.breakout.volumeSupported ? "Breakout volume supports the move; pullback volume passed." : "Volume support is not confirmed.", context.breakout.volumeSupported ? "passed" : "warning");
  if (context.patience.patienceCandle) {
    event(events, context.patience.patienceCandle.closeTime, "Patience candle", context.patience.detail, context.patience.state === "PATIENCE_CANDLE_VALID" || context.patience.state === "ENTRY_TRIGGERED" ? "passed" : "observed");
  }
  if (context.patience.triggerCandle) {
    event(events, context.patience.triggerCandle.closeTime, "Immediate trigger", context.patience.detail, context.patience.state === "ENTRY_TRIGGERED" ? "passed" : "warning");
  }

  const execution = context.evaluation.decision === "SETUP QUALIFIED" && !context.evaluation.alertOnly && context.riskPlan.allowed && context.direction !== null
    ? simulatePhase8ShadowExecution({
        direction: context.direction,
        entryQuote: lastCandle ?? { bid: context.riskPlan.entry ?? 0, ask: context.riskPlan.entry ?? 0 },
        exitQuote: lastCandle,
        entryReferencePrice: context.riskPlan.entry ?? lastCandle?.close ?? 0,
        exitReferencePrice: context.riskPlan.target,
        currentPrice: lastCandle?.close,
        high: lastCandle?.high,
        low: lastCandle?.low,
        contracts: context.riskPlan.contracts,
        targetContracts: context.riskPlan.targetContracts,
        runnerContracts: context.riskPlan.runnerContracts,
        target: context.riskPlan.target,
        strategyStop: context.riskPlan.strategyStop,
        catastropheStop: context.riskPlan.catastropheStop,
        runnerReferencePrice: context.riskPlan.runner.referencePrice,
        runnerImpulse: context.riskPlan.runner.impulse,
        runnerMostFavorablePrice: context.riskPlan.runner.mostFavorablePrice,
        specification: context.specification,
        slippageMode: context.slippageMode ?? context.riskPlan.slippageMode,
        observedSpreadTicks: lastCandle ? (lastCandle.ask - lastCandle.bid) / context.specification.tickSize : 1,
      })
    : null;

  if (execution?.contracts && execution.entryFillPrice) {
    const entryTime = lastCandle?.closeTime ?? context.now;
    event(events, entryTime, "Shadow entry", `Simulated ${context.direction} entry at ${execution.entryFillPrice.toFixed(2)} from the ${execution.entryQuoteSide}; no order was created.`, "simulated");
    if (execution.targetHit) {
      event(events, entryTime, "Partial profit", `Target leg exited ${execution.targetContracts} contract${execution.targetContracts === 1 ? "" : "s"} at the modeled ${execution.exitQuoteSide}.`, "simulated");
      if (execution.runnerActivated) event(events, entryTime, "Runner activation", `${execution.runnerContracts} runner contract${execution.runnerContracts === 1 ? "" : "s"} activated after the target leg.`, "simulated");
      if (execution.runnerExited) event(events, entryTime, "Runner exit", "Runner exited through the frozen adverse-retracement rule in shadow simulation.", "simulated");
    }
    if (execution.stop) event(events, entryTime, "Stop", `Simulated ${execution.exitReason}; catastrophe protection takes precedence over the strategy stop.`, "simulated");
  } else if (context.evaluation.decision !== "SETUP QUALIFIED") {
    const failed = context.evaluation.rules.filter((rule) => !rule.passed).map((rule) => rule.label);
    event(events, fallbackTime, "Failed setup", `${context.evaluation.decision}: ${failed.length ? failed.join(", ") : context.evaluation.explanation}. No shadow fill was created.`, context.evaluation.decision === "AMBIGUOUS" ? "warning" : "blocked");
  } else {
    event(events, fallbackTime, "Failed setup", "Setup qualified descriptively, but Phase 7 risk sizing or a safety gate prevented a simulated fill.", "blocked");
  }
  const terminalOrder = new Set<Phase8EventType>(["Shadow entry", "Partial profit", "Runner activation", "Runner exit", "Stop", "Failed setup"]);
  return events.sort((first, second) => first.time - second.time
    || Number(terminalOrder.has(first.eventType)) - Number(terminalOrder.has(second.eventType))
    || first.eventType.localeCompare(second.eventType));
}

export function buildPhase8EvaluationRecord(context: TimelineContext): Phase8EvaluationRecord {
  const timeline = buildPhase8Timeline(context);
  const execution = context.evaluation.decision === "SETUP QUALIFIED" && !context.evaluation.alertOnly && context.riskPlan.allowed && context.direction !== null
    ? simulatePhase8ShadowExecution({
        direction: context.direction,
        entryQuote: context.candles.at(-1) ?? { bid: context.riskPlan.entry ?? 0, ask: context.riskPlan.entry ?? 0 },
        exitQuote: context.candles.at(-1),
        entryReferencePrice: context.riskPlan.entry ?? context.candles.at(-1)?.close ?? 0,
        exitReferencePrice: context.riskPlan.target,
        currentPrice: context.candles.at(-1)?.close,
        high: context.candles.at(-1)?.high,
        low: context.candles.at(-1)?.low,
        contracts: context.riskPlan.contracts,
        targetContracts: context.riskPlan.targetContracts,
        runnerContracts: context.riskPlan.runnerContracts,
        target: context.riskPlan.target,
        strategyStop: context.riskPlan.strategyStop,
        catastropheStop: context.riskPlan.catastropheStop,
        runnerReferencePrice: context.riskPlan.runner.referencePrice,
        runnerImpulse: context.riskPlan.runner.impulse,
        runnerMostFavorablePrice: context.riskPlan.runner.mostFavorablePrice,
        specification: context.specification,
        slippageMode: context.slippageMode ?? context.riskPlan.slippageMode,
        observedSpreadTicks: context.candles.at(-1) ? (context.candles.at(-1)!.ask - context.candles.at(-1)!.bid) / context.specification.tickSize : 1,
      })
    : null;
  const entry = context.riskPlan.entry ?? context.candles.at(-1)?.close ?? 0;
  return {
    setupType: context.evaluation.setupType,
    direction: context.direction,
    decision: context.evaluation.decision,
    outcome: setupOutcome(context.evaluation.decision),
    timeline,
    execution,
    excursions: context.direction === null
      ? { maximumFavorableExcursion: 0, maximumAdverseExcursion: 0, favorablePrice: null, adversePrice: null }
      : calculatePhase8Excursions(context.direction, entry, context.candles, context.specification),
    passedRules: context.evaluation.rules.filter((rule) => rule.passed),
    failedRules: context.evaluation.rules.filter((rule) => !rule.passed),
  };
}