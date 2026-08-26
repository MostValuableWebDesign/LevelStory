/** Every default is deliberately explicit: these are strategy assumptions, not facts. */
export type StrategyConfig = {
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
  feePerShare: number;
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
  feePerShare: 0.005,
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
  return { ...DEFAULT_STRATEGY_CONFIG, ...overrides };
}