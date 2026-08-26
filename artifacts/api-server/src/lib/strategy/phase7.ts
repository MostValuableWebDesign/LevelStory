import {
  dollarsForTicks,
  notionalValue,
  roundToTick,
  ticksBetween,
  type FuturesContractSpecification,
} from "../futures/contracts.js";
import type { Direction } from "./types.js";

export type SlippageMode = "normal" | "fast" | "abnormal_spread";
export type ProfitTargetPreset = 50 | 75 | 100;

export type Phase7RiskConfig = {
  riskDollars: number;
  dailyLossLimit: number;
  dailyLossUsed: number;
  tradesToday: number;
  maxTradesPerDay: number;
  maxContracts: number;
  maxPositionValue: number;
  maximumSpreadTicks: number;
  minimumLiquidity: number;
  staleDataSeconds: number;
  dataAgeSeconds: number;
  observedSpreadTicks: number;
  liquidity: number;
  emergencyKillSwitch: boolean;
  duplicateEntry: boolean;
  averagingDown: boolean;
  slippageMode?: SlippageMode;
  normalSlippageTicks?: number;
  fastSlippageTicks?: number;
  targetDollars?: number;
};

export type Phase7CostBreakdown = {
  commission: number;
  exchange: number;
  regulatory: number;
  clearing: number;
  roundTripFees: number;
  entrySlippage: number;
  exitSlippage: number;
  totalSlippage: number;
};

export type Phase7Accounting = {
  grossPnl: number;
  slippage: number;
  fees: number;
  netPnl: number;
};

export type RunnerState = {
  active: boolean;
  referencePrice: number | null;
  impulse: number | null;
  mostFavorablePrice: number | null;
  adverseRetracement: number;
  retracementThreshold: number | null;
  exit: boolean;
  exitReason: string | null;
};

export type Phase7ShadowFill = {
  entry: number;
  exit: number;
  contracts: number;
  stopped: "strategy" | "catastrophe" | "target" | "runner" | "manual";
  accounting: Phase7Accounting;
};

export type Phase7RiskPlan = {
  direction: Direction;
  entry: number | null;
  thesisStop: number | null;
  catastropheStop: number | null;
  strategyStop: number | null;
  target: number | null;
  targetDollars: number;
  targetTicks: number;
  targetContracts: number;
  runnerContracts: number;
  contracts: number;
  stopTicks: number;
  dollarRisk: number;
  riskPerContract: number;
  allowed: boolean;
  slippageMode: SlippageMode;
  costBreakdown: Phase7CostBreakdown;
  projectedTargetPnl: Phase7Accounting;
  runner: RunnerState;
  locks: Record<string, boolean>;
  reasons: string[];
};

const TARGET_MIN = 50;
const TARGET_MAX = 100;
const RUNNER_RETRACEMENT = 0.4;

function money(value: number): number {
  return Number(value.toFixed(2));
}

export function validateProfitTargetDollars(value: number | undefined): number {
  const target = value ?? 75;
  if (!Number.isFinite(target) || target < TARGET_MIN || target > TARGET_MAX) {
    throw new Error("Profit target must be $50, $75, $100, or a custom value from $50 to $100.");
  }
  return money(target);
}

export function targetTicksForDollars(targetDollars: number, specification: FuturesContractSpecification): number {
  const target = validateProfitTargetDollars(targetDollars);
  return Math.max(1, Math.ceil(target / specification.dollarValuePerTick));
}

export function targetPriceForDollars(
  direction: Direction,
  entry: number,
  targetDollars: number,
  specification: FuturesContractSpecification,
): number {
  const ticks = targetTicksForDollars(targetDollars, specification);
  const price = direction === "long"
    ? entry + ticks * specification.tickSize
    : entry - ticks * specification.tickSize;
  return roundToTick(price, specification);
}

function slippageTicks(
  mode: SlippageMode,
  observedSpreadTicks: number,
  normalTicks = 1,
  fastTicks = 2,
): { entry: number; exit: number } {
  if (mode === "fast") return { entry: fastTicks, exit: fastTicks };
  if (mode === "abnormal_spread") {
    const spread = Math.max(1, Math.ceil(observedSpreadTicks));
    return { entry: spread + 1, exit: spread + 1 };
  }
  return { entry: normalTicks, exit: normalTicks };
}

function feeBreakdown(
  contracts: number,
  specification: FuturesContractSpecification,
): Phase7CostBreakdown {
  const commission = contracts * specification.commissionPerContract * 2;
  const exchange = contracts * (specification.exchangeFeePerContract ?? specification.exchangeAndRegulatoryFeesPerContract) * 2;
  const regulatory = contracts * (specification.regulatoryFeePerContract ?? 0) * 2;
  const clearing = contracts * (specification.clearingFeePerContract ?? 0) * 2;
  return {
    commission: money(commission),
    exchange: money(exchange),
    regulatory: money(regulatory),
    clearing: money(clearing),
    roundTripFees: money(commission + exchange + regulatory + clearing),
    entrySlippage: 0,
    exitSlippage: 0,
    totalSlippage: 0,
  };
}

function lockReasons(config: Phase7RiskConfig): { locks: Record<string, boolean>; reasons: string[] } {
  const locks = {
    tradeRisk: config.riskDollars <= 0,
    dailyLoss: config.dailyLossUsed >= config.dailyLossLimit,
    tradeCount: config.tradesToday >= config.maxTradesPerDay,
    spread: config.observedSpreadTicks > config.maximumSpreadTicks,
    liquidity: config.liquidity < config.minimumLiquidity,
    staleData: config.dataAgeSeconds > config.staleDataSeconds,
    duplicateEntry: config.duplicateEntry,
    averagingDown: config.averagingDown,
    emergencyKillSwitch: config.emergencyKillSwitch,
    contractCount: config.maxContracts <= 0,
  };
  const reasons: string[] = [];
  if (locks.tradeRisk) reasons.push("Trade risk is zero; plan blocked.");
  if (locks.dailyLoss) reasons.push("Daily loss lockout is active.");
  if (locks.tradeCount) reasons.push("Maximum daily trade count reached.");
  if (locks.spread) reasons.push(`Spread is ${config.observedSpreadTicks} ticks; maximum is ${config.maximumSpreadTicks}.`);
  if (locks.liquidity) reasons.push(`Liquidity is ${config.liquidity}; minimum is ${config.minimumLiquidity}.`);
  if (locks.staleData) reasons.push(`Market data is ${config.dataAgeSeconds}s old; maximum is ${config.staleDataSeconds}s.`);
  if (locks.duplicateEntry) reasons.push("Duplicate entry lockout is active.");
  if (locks.averagingDown) reasons.push("Averaging-down lockout is active.");
  if (locks.emergencyKillSwitch) reasons.push("Emergency kill switch is active.");
  if (locks.contractCount) reasons.push("Maximum contract count is zero; plan blocked.");
  return { locks, reasons };
}

export function calculateShadowPnl(
  direction: Direction,
  entry: number,
  exit: number,
  contracts: number,
  specification: FuturesContractSpecification,
  mode: SlippageMode = "normal",
  observedSpreadTicks = 1,
  normalSlippageTicks = 1,
  fastSlippageTicks = 2,
): Phase7Accounting {
  if (!Number.isInteger(contracts) || contracts < 0) throw new Error("P&L contracts must be a whole, non-negative number.");
  const slips = slippageTicks(mode, observedSpreadTicks, normalSlippageTicks, fastSlippageTicks);
  const entryFill = direction === "long"
    ? entry + slips.entry * specification.tickSize
    : entry - slips.entry * specification.tickSize;
  const exitFill = direction === "long"
    ? exit - slips.exit * specification.tickSize
    : exit + slips.exit * specification.tickSize;
  const gross = (exitFill - entryFill) * contracts * specification.pointValue * specification.contractMultiplier * (direction === "long" ? 1 : -1);
  const costs = feeBreakdown(contracts, specification);
  const slippage = (slips.entry + slips.exit) * contracts * specification.dollarValuePerTick;
  const theoreticalGross = (exit - entry) * contracts * specification.pointValue * specification.contractMultiplier * (direction === "long" ? 1 : -1);
  return {
    grossPnl: money(theoreticalGross),
    slippage: money(slippage),
    fees: costs.roundTripFees,
    netPnl: money(gross - costs.roundTripFees),
  };
}

export function evaluateRunner(
  direction: Direction,
  entry: number,
  mostFavorablePrice: number,
  currentPrice: number,
  runnerStarted: boolean,
  referencePrice: number | null = null,
  impulse: number | null = null,
): RunnerState {
  if (!runnerStarted) {
    return {
      active: false,
      referencePrice: null,
      impulse: null,
      mostFavorablePrice: null,
      adverseRetracement: 0,
      retracementThreshold: null,
      exit: false,
      exitReason: null,
    };
  }
  const frozenReference = referencePrice ?? entry;
  const measuredImpulse = impulse ?? Math.abs(mostFavorablePrice - frozenReference);
  const adverseRetracement = direction === "long"
    ? Math.max(0, mostFavorablePrice - currentPrice)
    : Math.max(0, currentPrice - mostFavorablePrice);
  const threshold = measuredImpulse * RUNNER_RETRACEMENT;
  const exit = measuredImpulse > 0 && adverseRetracement >= threshold;
  return {
    active: true,
    referencePrice: frozenReference,
    impulse: money(measuredImpulse),
    mostFavorablePrice,
    adverseRetracement: money(adverseRetracement),
    retracementThreshold: money(threshold),
    exit,
    exitReason: exit ? "Runner exited intrabar at 40% adverse retracement." : null,
  };
}

export type IntrabarStopOutcome = {
  hit: boolean;
  stop: "catastrophe" | "strategy" | null;
  price: number | null;
  detail: string;
};

/**
 * Catastrophe protection is always evaluated before the strategy stop. This
 * is deliberately candle/intrabar based: a close is not required to honor a
 * hard safety boundary.
 */
export function evaluateIntrabarStops(
  direction: Direction,
  candle: { high: number; low: number },
  strategyStop: number | null,
  catastropheStop: number | null,
): IntrabarStopOutcome {
  const catastropheHit = catastropheStop !== null && (
    direction === "long" ? candle.low <= catastropheStop : candle.high >= catastropheStop
  );
  if (catastropheHit) {
    return {
      hit: true,
      stop: "catastrophe",
      price: catastropheStop,
      detail: "Always-active catastrophe stop takes precedence intrabar.",
    };
  }
  const strategyHit = strategyStop !== null && (
    direction === "long" ? candle.low <= strategyStop : candle.high >= strategyStop
  );
  if (strategyHit) {
    return {
      hit: true,
      stop: "strategy",
      price: strategyStop,
      detail: "Intrabar strategy stop was reached after catastrophe protection remained clear.",
    };
  }
  return { hit: false, stop: null, price: null, detail: "Neither stop was reached intrabar." };
}

export function simulatePhase7Fill(input: {
  direction: Direction;
  entry: number;
  currentPrice: number;
  high: number;
  low: number;
  contracts: number;
  strategyStop: number | null;
  catastropheStop: number | null;
  target: number | null;
  specification: FuturesContractSpecification;
  slippageMode?: SlippageMode;
  observedSpreadTicks?: number;
  normalSlippageTicks?: number;
  fastSlippageTicks?: number;
}): Phase7ShadowFill {
  const stop = evaluateIntrabarStops(
    input.direction,
    { high: input.high, low: input.low },
    input.strategyStop,
    input.catastropheStop,
  );
  const targetHit = input.target !== null && (
    input.direction === "long" ? input.high >= input.target : input.low <= input.target
  );
  const stopped: Phase7ShadowFill["stopped"] = stop.stop === "catastrophe"
    ? "catastrophe"
    : stop.stop === "strategy"
      ? "strategy"
      : targetHit
        ? "target"
        : "manual";
  const exit = stop.price ?? (targetHit ? input.target! : input.currentPrice);
  return {
    entry: input.entry,
    exit,
    contracts: input.contracts,
    stopped,
    accounting: calculateShadowPnl(
      input.direction,
      input.entry,
      exit,
      input.contracts,
      input.specification,
      input.slippageMode,
      input.observedSpreadTicks,
      input.normalSlippageTicks,
      input.fastSlippageTicks,
    ),
  };
}

export function buildPhase7RiskPlan(
  entry: number,
  direction: Direction,
  thesisStop: number | null,
  catastropheStop: number | null,
  config: Phase7RiskConfig,
  specification: FuturesContractSpecification,
  runner: RunnerState = evaluateRunner(direction, entry, entry, entry, false),
): Phase7RiskPlan {
  const targetDollars = validateProfitTargetDollars(config.targetDollars);
  const emptyCosts = feeBreakdown(0, specification);
  const base = {
    direction,
    entry: Number(entry.toFixed(2)),
    thesisStop: thesisStop === null ? null : Number(thesisStop.toFixed(2)),
    catastropheStop: catastropheStop === null ? null : Number(catastropheStop.toFixed(2)),
    strategyStop: thesisStop === null ? null : Number(thesisStop.toFixed(2)),
    target: null as number | null,
    targetDollars,
    targetTicks: 0,
    targetContracts: 0,
    runnerContracts: 0,
    contracts: 0,
    stopTicks: 0,
    dollarRisk: 0,
    riskPerContract: 0,
    allowed: false,
    slippageMode: config.slippageMode ?? "normal",
    costBreakdown: emptyCosts,
    projectedTargetPnl: { grossPnl: 0, slippage: 0, fees: 0, netPnl: 0 },
    runner,
    locks: {},
    reasons: [] as string[],
  };
  const gates = lockReasons(config);
  base.locks = gates.locks;
  base.reasons.push(...gates.reasons);
  if (catastropheStop === null) {
    base.reasons.push("No catastrophe stop is defined; plan blocked.");
    return base;
  }
  let stopTicks: number;
  try {
    stopTicks = ticksBetween(entry, catastropheStop, specification);
  } catch {
    base.reasons.push("Catastrophe stop is not aligned to contract ticks.");
    return base;
  }
  if (stopTicks <= 0) {
    base.reasons.push("Catastrophe stop must be beyond entry.");
    return base;
  }
  const slips = slippageTicks(
    base.slippageMode,
    config.observedSpreadTicks,
    config.normalSlippageTicks,
    config.fastSlippageTicks,
  );
  const costs = feeBreakdown(1, specification);
  costs.entrySlippage = money(slips.entry * specification.dollarValuePerTick);
  costs.exitSlippage = money(slips.exit * specification.dollarValuePerTick);
  costs.totalSlippage = money(costs.entrySlippage + costs.exitSlippage);
  const stopLoss = dollarsForTicks(stopTicks, 1, specification);
  const riskPerContract = stopLoss + costs.totalSlippage + costs.roundTripFees;
  const valuePerContract = notionalValue(entry, 1, specification);
  const contracts = Math.max(0, Math.floor(Math.min(
    config.riskDollars / riskPerContract,
    config.maxPositionValue / valuePerContract,
    config.maxContracts,
  )));
  const targetTicks = targetTicksForDollars(targetDollars, specification);
  const target = targetPriceForDollars(direction, entry, targetDollars, specification);
  const targetContracts = contracts > 0 ? 1 : 0;
  const runnerContracts = Math.max(0, contracts - targetContracts);
  base.target = Number(target.toFixed(2));
  base.targetTicks = targetTicks;
  base.targetContracts = targetContracts;
  base.runnerContracts = runnerContracts;
  base.contracts = contracts;
  base.stopTicks = stopTicks;
  base.riskPerContract = money(riskPerContract);
  base.dollarRisk = money(contracts * riskPerContract);
  base.costBreakdown = {
    ...costs,
    commission: money(costs.commission * contracts),
    exchange: money(costs.exchange * contracts),
    regulatory: money(costs.regulatory * contracts),
    clearing: money(costs.clearing * contracts),
    roundTripFees: money(costs.roundTripFees * contracts),
    entrySlippage: money(costs.entrySlippage * contracts),
    exitSlippage: money(costs.exitSlippage * contracts),
    totalSlippage: money(costs.totalSlippage * contracts),
  };
  base.projectedTargetPnl = calculateShadowPnl(
    direction,
    entry,
    target,
    targetContracts,
    specification,
    base.slippageMode,
    config.observedSpreadTicks,
    config.normalSlippageTicks,
    config.fastSlippageTicks,
  );
  if (contracts <= 0) base.reasons.push("Whole-contract sizing returned zero contracts; plan blocked.");
  if (!base.reasons.length) base.reasons.push("All risk, market-quality, and safety gates passed; no order is created.");
  base.allowed = contracts > 0 && Object.values(gates.locks).every((locked) => !locked);
  return base;
}