/** Every default is deliberately explicit: these are strategy assumptions, not facts. */
import {
  DEFAULT_LEVEL_TOLERANCE_POINTS,
  LEVEL_TOLERANCE_TICKS,
  levelTolerancePoints,
} from "@workspace/api-spec/constants";
import type { ProfitTargetPlacement } from "./key-level-targets.js";

export type StrategyConfig = {
  defaultContractSymbol: string;
  simulationSeed: number;
  simulationDays: number;
  barIntervalMinutes: 5;
  sessionTimeZone: string;
  sessionStartMinutes: number;
  primaryEntryStartMinutes: number;
  primaryEntryEndMinutes: number;
  primaryEntryWindowVersion: string;
  premarketStartMinutes: number;
  orbMinutes: number;
  ntzMinutes: number;
  emaPeriod: number;
  emaSlopeWindow: number;
  rsiPeriod: number;
  volumeLookback: number;
  volumeExpansionRatio: number;
  adverseVolumeRatio: number;
  spread: number;
  slippage: number;
  feePerContract: number;
  profitBuffer: number;
  riskPerTrade: number;
  dailyLossLimit: number;
  maxPositionValue: number;
  maxRiskTrades: number;
  stopBuffer: number;
  runnerTriggerR: number;
  levelTolerance: number;
  patienceEntryBufferTicks: 8;
  patienceStopBufferTicks: number;
  dojiBodyRatio: number;
  equivalentBodyTolerance: number;
  trendCandleCount: number;
  trendEmaFlatThreshold: number;
  historicalLookbackTradingDays: number;
  majorLevelMinReactions: number;
  majorLevelProximityTicks: number;
  majorLevelProximityPercent: number;
  majorLevelProximityAtrFactor: number;
  majorLevelConfluenceToleranceTicks: number;
  dynamiteLevelToleranceTicks: number;
  majorLevelRecencyHalfLifeDays: number;
  phase4AtrPeriod: number;
  phase4PullbackMaxCandles: number;
  phase4PullbackMaxMinutes: number;
  phase4BreakoutVolumeRatio: number;
  phase4BreakoutMeaningfulDistanceTicks: number;
  phase4BreakoutMeaningfulDistanceAtrFactor: number;
  phase4BreakoutBodyRatio: number;
  phase4BreakoutCloseLocationRatio: number;
  phase4ContinuationMoveTicks: number;
  phase4ContinuationAtrFactor: number;
  phase4StrongVolumeRatio: number;
  phase4StrongBodyRatio: number;
  phase4StrongCloseLocationRatio: number;
  phase4AllowStrongSingleCandleException: boolean;
  phase4FailureReclaimRequired: boolean;
  phase4FailureOpposingVolumeRatio: number;
  phase6ConsolidationThresholdVersion: string;
  phase6ConsolidationExpansionRatio: number;
  phase6ConsolidationMinCandles: number;
  phase6ConsolidationMaxRangeTicks: number;
  phase6ConsolidationVolatilityLookback: number;
  phase6ConsolidationVolatilityMultiplier: number;
  phase6ConsolidationMinOverlapRatio: number;
  phase6ConsolidationMinRejectionCount: number;
  phase6ConsolidationMaxDirectionalSequence: number;
  phase7MaxContracts: number;
  phase7StaleDataSeconds: number;
  phase7NormalSlippageTicks: number;
  phase7FastSlippageTicks: number;
  phase7DefaultTargetDollars: number;
  profitTargetPlacement: ProfitTargetPlacement;
  phase7RunnerRetracementRatio: number;
};

export const CONSOLIDATION_THRESHOLD_VERSION = "phase6-consolidation-v2";

export type ConsolidationThresholds = {
  version: string;
  minCandles: number;
  maxRangeTicks: number;
  maxExpansionRatio: number;
  volatilityLookback: number;
  volatilityMultiplier: number;
  minOverlapRatio: number;
  minRejectionCount: number;
  maxDirectionalSequence: number;
};

export function consolidationThresholds(config: Pick<
  StrategyConfig,
  | "phase6ConsolidationThresholdVersion"
  | "phase6ConsolidationMinCandles"
  | "phase6ConsolidationMaxRangeTicks"
  | "phase6ConsolidationExpansionRatio"
  | "phase6ConsolidationVolatilityLookback"
  | "phase6ConsolidationVolatilityMultiplier"
  | "phase6ConsolidationMinOverlapRatio"
  | "phase6ConsolidationMinRejectionCount"
  | "phase6ConsolidationMaxDirectionalSequence"
>): ConsolidationThresholds {
  return {
    version: config.phase6ConsolidationThresholdVersion,
    minCandles: config.phase6ConsolidationMinCandles,
    maxRangeTicks: config.phase6ConsolidationMaxRangeTicks,
    maxExpansionRatio: config.phase6ConsolidationExpansionRatio,
    volatilityLookback: config.phase6ConsolidationVolatilityLookback,
    volatilityMultiplier: config.phase6ConsolidationVolatilityMultiplier,
    minOverlapRatio: config.phase6ConsolidationMinOverlapRatio,
    minRejectionCount: config.phase6ConsolidationMinRejectionCount,
    maxDirectionalSequence: config.phase6ConsolidationMaxDirectionalSequence,
  };
}

export const DEFAULT_STRATEGY_CONFIG: Readonly<StrategyConfig> = {
  defaultContractSymbol: "MES",
  simulationSeed: 17,
  simulationDays: 3,
  barIntervalMinutes: 5,
  sessionTimeZone: "America/New_York",
  sessionStartMinutes: 570, // assumption: 09:30 exchange-local minutes
  primaryEntryStartMinutes: 570, // assumption: 09:30 America/New_York
  primaryEntryEndMinutes: 780, // assumption: 13:00 America/New_York
  primaryEntryWindowVersion: "mes-primary-entry-window-v1",
  premarketStartMinutes: 240, // assumption: 04:00
  orbMinutes: 15, // assumption: exact 9:30–9:45 ET opening range
  ntzMinutes: 15, // assumption: exact first three completed 5m candles
  emaPeriod: 200,
  emaSlopeWindow: 5, // assumption: compare with the value five completed candles ago
  rsiPeriod: 14,
  volumeLookback: 20,
  volumeExpansionRatio: 1.5,
  adverseVolumeRatio: 1.5,
  spread: 0.02,
  slippage: 0.01,
  feePerContract: 0.62,
  profitBuffer: 0.02,
  riskPerTrade: 100,
  dailyLossLimit: 300,
  maxPositionValue: 100_000,
  maxRiskTrades: 1,
  stopBuffer: 0.03,
  runnerTriggerR: 1.5,
  levelTolerance: DEFAULT_LEVEL_TOLERANCE_POINTS,
  patienceEntryBufferTicks: 8,
  patienceStopBufferTicks: 8,
  dojiBodyRatio: 0.1,
  equivalentBodyTolerance: 0.2,
  trendCandleCount: 8, // assumption: eight completed 15m candles
  trendEmaFlatThreshold: 0.01,
  historicalLookbackTradingDays: 252, // assumption: approximately one trading year
  majorLevelMinReactions: 3,
  majorLevelProximityTicks: 2,
  majorLevelProximityPercent: 0.0015,
  majorLevelProximityAtrFactor: 0.25,
  majorLevelConfluenceToleranceTicks: 2,
  dynamiteLevelToleranceTicks: 8,
  majorLevelRecencyHalfLifeDays: 60,
  phase4AtrPeriod: 14,
  phase4PullbackMaxCandles: 6,
  phase4PullbackMaxMinutes: 30,
  phase4BreakoutVolumeRatio: 1.25,
  phase4BreakoutMeaningfulDistanceTicks: 2,
  phase4BreakoutMeaningfulDistanceAtrFactor: 0.1,
  phase4BreakoutBodyRatio: 0.6,
  phase4BreakoutCloseLocationRatio: 0.25,
  phase4ContinuationMoveTicks: 2,
  phase4ContinuationAtrFactor: 0.1,
  phase4StrongVolumeRatio: 1.5,
  phase4StrongBodyRatio: 0.7,
  phase4StrongCloseLocationRatio: 0.2,
  phase4AllowStrongSingleCandleException: true,
  phase4FailureReclaimRequired: true,
  phase4FailureOpposingVolumeRatio: 1.5,
  phase6ConsolidationThresholdVersion: CONSOLIDATION_THRESHOLD_VERSION,
  phase6ConsolidationExpansionRatio: 1.25,
  phase6ConsolidationMinCandles: 3,
  phase6ConsolidationMaxRangeTicks: 24, // diagnostic reference only; never an eligibility cap
  phase6ConsolidationVolatilityLookback: 12,
  phase6ConsolidationVolatilityMultiplier: 1.5,
  phase6ConsolidationMinOverlapRatio: 0.5,
  phase6ConsolidationMinRejectionCount: 2,
  phase6ConsolidationMaxDirectionalSequence: 2,
  phase7MaxContracts: 10,
  phase7StaleDataSeconds: 15,
  phase7NormalSlippageTicks: 1,
  phase7FastSlippageTicks: 2,
  phase7DefaultTargetDollars: 75,
  profitTargetPlacement: "EXACT_LEVEL",
  phase7RunnerRetracementRatio: 0.4,
};

export function strategyConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return validateStrategyConfig({ ...DEFAULT_STRATEGY_CONFIG, ...overrides });
}

export function validateStrategyConfig(config: StrategyConfig): StrategyConfig {
  if (!/^[A-Z]{1,5}$/.test(config.defaultContractSymbol)) {
    throw new Error("Invalid strategy configuration: defaultContractSymbol must be an uppercase futures root.");
  }
  if (!Number.isInteger(config.simulationSeed)) {
    throw new Error("Invalid strategy configuration: simulationSeed must be an integer.");
  }
  if (!Number.isInteger(config.simulationDays) || config.simulationDays < 1) {
    throw new Error("Invalid strategy configuration: simulationDays must be a positive integer.");
  }
  if (config.barIntervalMinutes !== 5) {
    throw new Error("Invalid strategy configuration: barIntervalMinutes must be 5 for the Phase 1 feed.");
  }
  if (!config.sessionTimeZone.trim()) {
    throw new Error("Invalid strategy configuration: sessionTimeZone is required.");
  }
  if (config.sessionTimeZone !== "America/New_York") {
    throw new Error("Invalid strategy configuration: sessionTimeZone must be America/New_York.");
  }
  if (!config.phase6ConsolidationThresholdVersion.trim()) {
    throw new Error("Invalid strategy configuration: phase6ConsolidationThresholdVersion is required.");
  }
  const positiveNumbers: Array<[string, number]> = [
    ["sessionStartMinutes", config.sessionStartMinutes],
    ["primaryEntryStartMinutes", config.primaryEntryStartMinutes],
    ["primaryEntryEndMinutes", config.primaryEntryEndMinutes],
    ["premarketStartMinutes", config.premarketStartMinutes],
    ["orbMinutes", config.orbMinutes],
    ["ntzMinutes", config.ntzMinutes],
    ["emaPeriod", config.emaPeriod],
    ["emaSlopeWindow", config.emaSlopeWindow],
    ["rsiPeriod", config.rsiPeriod],
    ["volumeLookback", config.volumeLookback],
    ["volumeExpansionRatio", config.volumeExpansionRatio],
    ["adverseVolumeRatio", config.adverseVolumeRatio],
    ["riskPerTrade", config.riskPerTrade],
    ["dailyLossLimit", config.dailyLossLimit],
    ["maxPositionValue", config.maxPositionValue],
    ["maxRiskTrades", config.maxRiskTrades],
    ["runnerTriggerR", config.runnerTriggerR],
    ["patienceStopBufferTicks", config.patienceStopBufferTicks],
    ["trendCandleCount", config.trendCandleCount],
    ["historicalLookbackTradingDays", config.historicalLookbackTradingDays],
    ["majorLevelMinReactions", config.majorLevelMinReactions],
    ["majorLevelProximityTicks", config.majorLevelProximityTicks],
    ["majorLevelConfluenceToleranceTicks", config.majorLevelConfluenceToleranceTicks],
    ["dynamiteLevelToleranceTicks", config.dynamiteLevelToleranceTicks],
    ["majorLevelRecencyHalfLifeDays", config.majorLevelRecencyHalfLifeDays],
    ["phase4AtrPeriod", config.phase4AtrPeriod],
    ["phase4PullbackMaxCandles", config.phase4PullbackMaxCandles],
    ["phase4PullbackMaxMinutes", config.phase4PullbackMaxMinutes],
    ["phase4BreakoutVolumeRatio", config.phase4BreakoutVolumeRatio],
    ["phase4BreakoutMeaningfulDistanceTicks", config.phase4BreakoutMeaningfulDistanceTicks],
    ["phase4BreakoutMeaningfulDistanceAtrFactor", config.phase4BreakoutMeaningfulDistanceAtrFactor],
    ["phase4BreakoutBodyRatio", config.phase4BreakoutBodyRatio],
    ["phase4BreakoutCloseLocationRatio", config.phase4BreakoutCloseLocationRatio],
    ["phase4ContinuationMoveTicks", config.phase4ContinuationMoveTicks],
    ["phase4ContinuationAtrFactor", config.phase4ContinuationAtrFactor],
    ["phase4StrongVolumeRatio", config.phase4StrongVolumeRatio],
    ["phase4StrongBodyRatio", config.phase4StrongBodyRatio],
    ["phase4StrongCloseLocationRatio", config.phase4StrongCloseLocationRatio],
    ["phase4FailureOpposingVolumeRatio", config.phase4FailureOpposingVolumeRatio],
    ["phase6ConsolidationExpansionRatio", config.phase6ConsolidationExpansionRatio],
    ["phase6ConsolidationMinCandles", config.phase6ConsolidationMinCandles],
    ["phase6ConsolidationMaxRangeTicks", config.phase6ConsolidationMaxRangeTicks],
    ["phase7MaxContracts", config.phase7MaxContracts],
    ["phase7StaleDataSeconds", config.phase7StaleDataSeconds],
    ["phase7NormalSlippageTicks", config.phase7NormalSlippageTicks],
    ["phase7FastSlippageTicks", config.phase7FastSlippageTicks],
    ["phase7DefaultTargetDollars", config.phase7DefaultTargetDollars],
  ];
  if (!Number.isInteger(config.primaryEntryStartMinutes)
    || !Number.isInteger(config.primaryEntryEndMinutes)
    || config.primaryEntryStartMinutes >= config.primaryEntryEndMinutes
    || config.primaryEntryStartMinutes < 0
    || config.primaryEntryEndMinutes > 24 * 60) {
    throw new Error("Invalid strategy configuration: primary entry window must be an increasing New York wall-clock minute range.");
  }
  if (!config.primaryEntryWindowVersion.trim()) {
    throw new Error("Invalid strategy configuration: primaryEntryWindowVersion is required.");
  }
  for (const [name, value] of positiveNumbers) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid strategy configuration: ${name} must be finite and positive.`);
    }
  }
  const nonNegativeNumbers: Array<[string, number]> = [
    ["spread", config.spread],
    ["slippage", config.slippage],
    ["feePerContract", config.feePerContract],
    ["profitBuffer", config.profitBuffer],
    ["stopBuffer", config.stopBuffer],
    ["levelTolerance", config.levelTolerance],
    ["dojiBodyRatio", config.dojiBodyRatio],
    ["equivalentBodyTolerance", config.equivalentBodyTolerance],
    ["trendEmaFlatThreshold", config.trendEmaFlatThreshold],
    ["majorLevelProximityPercent", config.majorLevelProximityPercent],
    ["majorLevelProximityAtrFactor", config.majorLevelProximityAtrFactor],
    ["phase7RunnerRetracementRatio", config.phase7RunnerRetracementRatio],
  ];
  for (const [name, value] of nonNegativeNumbers) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid strategy configuration: ${name} must be finite and non-negative.`);
    }
  }
  if (config.phase4BreakoutBodyRatio > 1 || config.phase4BreakoutCloseLocationRatio > 0.5
    || config.phase4StrongBodyRatio > 1 || config.phase4StrongCloseLocationRatio > 0.5) {
    throw new Error("Invalid strategy configuration: breakout body and close-location ratios are out of range.");
  }
  if (config.orbMinutes !== 15 || config.ntzMinutes !== 15) {
    throw new Error("Invalid strategy configuration: Phase 2 opening range and NTZ must be 15 minutes.");
  }
  if (config.phase7RunnerRetracementRatio !== 0.4) {
    throw new Error("Invalid strategy configuration: Phase 7 runner retracement must be 40%.");
  }
  if (config.patienceEntryBufferTicks !== 8) {
    throw new Error("Invalid strategy configuration: patienceEntryBufferTicks must be exactly eight MES ticks (2.00 index points).");
  }
  if (config.patienceStopBufferTicks !== 8) {
    throw new Error("Invalid strategy configuration: patienceStopBufferTicks must be exactly eight MES ticks.");
  }
  if (config.phase7DefaultTargetDollars < 50 || config.phase7DefaultTargetDollars > 100) {
    throw new Error("Invalid strategy configuration: Phase 7 target must be between $50 and $100.");
  }
  if (config.profitTargetPlacement !== "NEAR_SIDE_30_TICKS" && config.profitTargetPlacement !== "EXACT_LEVEL") {
    throw new Error("Invalid strategy configuration: profitTargetPlacement must be NEAR_SIDE_30_TICKS or EXACT_LEVEL.");
  }
  if (!Number.isInteger(config.phase4AtrPeriod) || !Number.isInteger(config.phase4PullbackMaxCandles)) {
    throw new Error("Invalid strategy configuration: Phase 4 ATR period and pullback candle limit must be integers.");
  }
  if (!Number.isInteger(config.phase6ConsolidationMinCandles) || config.phase6ConsolidationMinCandles < 3) {
    throw new Error("Invalid strategy configuration: phase6ConsolidationMinCandles must be an integer of at least three.");
  }
  if (!Number.isInteger(config.phase6ConsolidationMaxRangeTicks)) {
    throw new Error("Invalid strategy configuration: phase6ConsolidationMaxRangeTicks must be an integer.");
  }
  if (!Number.isInteger(config.phase6ConsolidationVolatilityLookback)
    || config.phase6ConsolidationVolatilityLookback < 3
    || !Number.isInteger(config.phase6ConsolidationMinRejectionCount)
    || config.phase6ConsolidationMinRejectionCount < 1
    || !Number.isInteger(config.phase6ConsolidationMaxDirectionalSequence)
    || config.phase6ConsolidationMaxDirectionalSequence < 1) {
    throw new Error("Invalid strategy configuration: adaptive consolidation lookback, rejection count, and directional sequence limits must be positive integers.");
  }
  if (config.phase6ConsolidationVolatilityMultiplier <= 0
    || config.phase6ConsolidationMinOverlapRatio <= 0
    || config.phase6ConsolidationMinOverlapRatio > 1) {
    throw new Error("Invalid strategy configuration: adaptive consolidation volatility multiplier must be positive and overlap ratio must be in (0, 1].");
  }
  const approvedTolerancePoints = LEVEL_TOLERANCE_TICKS.map(levelTolerancePoints);
  if (!approvedTolerancePoints.includes(config.levelTolerance)) {
    throw new Error(`Invalid strategy configuration: levelTolerance must be one of ${approvedTolerancePoints.join(", ")} MES points.`);
  }
  return { ...config };
}