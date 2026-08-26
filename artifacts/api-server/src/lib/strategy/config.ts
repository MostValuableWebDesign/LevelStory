/** Every default is deliberately explicit: these are strategy assumptions, not facts. */
export type StrategyConfig = {
  defaultContractSymbol: string;
  simulationSeed: number;
  simulationDays: number;
  barIntervalMinutes: 5;
  sessionTimeZone: string;
  sessionStartMinutes: number;
  premarketStartMinutes: number;
  orbMinutes: number;
  ntzMinutes: number;
  emaPeriod: number;
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
  patienceContainmentTolerance: number;
  dojiBodyRatio: number;
  equivalentBodyTolerance: number;
};

export const DEFAULT_STRATEGY_CONFIG: Readonly<StrategyConfig> = {
  defaultContractSymbol: "MES",
  simulationSeed: 17,
  simulationDays: 3,
  barIntervalMinutes: 5,
  sessionTimeZone: "UTC",
  sessionStartMinutes: 570, // assumption: 09:30 exchange-local minutes
  premarketStartMinutes: 240, // assumption: 04:00
  orbMinutes: 15, // assumption: first completed 15m candle
  ntzMinutes: 15, // assumption: NTZ is the first completed 15m regular-session candle
  emaPeriod: 200,
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
  maxPositionValue: 25_000,
  maxRiskTrades: 1,
  stopBuffer: 0.03,
  runnerTriggerR: 1.5,
  levelTolerance: 0.05,
  patienceContainmentTolerance: 0,
  dojiBodyRatio: 0.1,
  equivalentBodyTolerance: 0.2,
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
  const positiveNumbers: Array<[string, number]> = [
    ["sessionStartMinutes", config.sessionStartMinutes],
    ["premarketStartMinutes", config.premarketStartMinutes],
    ["orbMinutes", config.orbMinutes],
    ["ntzMinutes", config.ntzMinutes],
    ["emaPeriod", config.emaPeriod],
    ["rsiPeriod", config.rsiPeriod],
    ["volumeLookback", config.volumeLookback],
    ["volumeExpansionRatio", config.volumeExpansionRatio],
    ["adverseVolumeRatio", config.adverseVolumeRatio],
    ["riskPerTrade", config.riskPerTrade],
    ["dailyLossLimit", config.dailyLossLimit],
    ["maxPositionValue", config.maxPositionValue],
    ["maxRiskTrades", config.maxRiskTrades],
    ["runnerTriggerR", config.runnerTriggerR],
  ];
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
    ["patienceContainmentTolerance", config.patienceContainmentTolerance],
    ["dojiBodyRatio", config.dojiBodyRatio],
    ["equivalentBodyTolerance", config.equivalentBodyTolerance],
  ];
  for (const [name, value] of nonNegativeNumbers) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid strategy configuration: ${name} must be finite and non-negative.`);
    }
  }
  return { ...config };
}