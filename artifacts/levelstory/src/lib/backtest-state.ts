export type HistoricalIndexState = "not_started" | "indexing" | "ready" | "failed";

import { MAX_BACKTEST_SESSIONS } from "@workspace/api-spec/constants";
export { MAX_BACKTEST_SESSIONS };

export type HistoricalReadiness = {
  ready: boolean;
  label: string;
};

export type BacktestSessionLimits = {
  requested: number;
  remaining: number;
  maxInSampleDays: number;
  maxOutOfSampleDays: number;
  error: string | null;
};

export function getBacktestSessionLimits(
  inSampleDays: number,
  outOfSampleDays: number,
): BacktestSessionLimits {
  const requested = inSampleDays + outOfSampleDays;
  const error = !Number.isInteger(inSampleDays) || inSampleDays < 1
    ? "In-sample days must be at least 1."
    : !Number.isInteger(outOfSampleDays) || outOfSampleDays < 1
    ? "Holdout days must be at least 1."
    : requested > MAX_BACKTEST_SESSIONS
    ? `This single run requests ${requested} sessions; the maximum is ${MAX_BACKTEST_SESSIONS}.`
    : null;
  return {
    requested,
    remaining: Number.isFinite(requested) ? Math.max(0, MAX_BACKTEST_SESSIONS - requested) : 0,
    maxInSampleDays: Math.max(1, MAX_BACKTEST_SESSIONS - Math.max(1, outOfSampleDays || 1)),
    maxOutOfSampleDays: Math.max(1, MAX_BACKTEST_SESSIONS - Math.max(1, inSampleDays || 1)),
    error,
  };
}

export type MultiContractCoverageInput = {
  allObservedTradingDates?: string[];
  eligibleTradingDates?: string[];
  ineligibleObservedDates?: Array<{ tradingDate: string; observedInAnyFile?: boolean; backtestEligible?: boolean }>;
  allObservedDateCount?: number;
  eligibleScheduledReplayDateCount?: number;
  ineligibleObservedDateCount?: number;
  coverageReconciles?: boolean;
};

export type MultiContractCoverageTotals = {
  allObservedDateCount: number;
  eligibleScheduledReplayDateCount: number;
  ineligibleObservedDateCount: number;
  reconciles: boolean;
};

export function getMultiContractCoverageTotals(
  summary: MultiContractCoverageInput,
): MultiContractCoverageTotals {
  const allObservedDateCount = summary.allObservedDateCount ?? -1;
  const eligibleScheduledReplayDateCount = summary.eligibleScheduledReplayDateCount ?? -1;
  const ineligibleObservedDateCount = summary.ineligibleObservedDateCount ?? -1;
  const computedObservedDateCount = new Set(summary.allObservedTradingDates ?? []).size;
  const computedEligibleDateCount = new Set(summary.eligibleTradingDates ?? []).size;
  const computedIneligibleObservedDateCount = new Set(
    (summary.ineligibleObservedDates ?? [])
      .filter((item) => item.observedInAnyFile !== false && item.backtestEligible !== true)
      .map((item) => item.tradingDate),
  ).size;
  const reconciles = summary.coverageReconciles === true
    && allObservedDateCount >= 0
    && eligibleScheduledReplayDateCount >= 0
    && ineligibleObservedDateCount >= 0
    && allObservedDateCount === eligibleScheduledReplayDateCount + ineligibleObservedDateCount
    && allObservedDateCount === computedObservedDateCount
    && eligibleScheduledReplayDateCount === computedEligibleDateCount
    && ineligibleObservedDateCount === computedIneligibleObservedDateCount;
  return {
    allObservedDateCount,
    eligibleScheduledReplayDateCount,
    ineligibleObservedDateCount,
    reconciles,
  };
}

export function acceptedOutrightFilesLabel(count: number): string {
  return `${count.toLocaleString()} accepted outright MES file${count === 1 ? "" : "s"}`;
}

export function coverageEligibilityLabel(eligible: boolean): string {
  return eligible ? "Eligible for backtest" : "Not eligible for backtest";
}

export function getHistoricalBacktestReadiness(
  source: "simulated" | "historical_databento" | "historical_databento_multicontract",
  options: {
    indexState?: HistoricalIndexState;
    importLoading: boolean;
    hasImport: boolean;
  },
): HistoricalReadiness {
  if (source === "simulated") return { ready: true, label: "Ready" };
  if (options.indexState === "failed") return { ready: false, label: "Historical index failed" };
  if (options.importLoading || (source === "historical_databento_multicontract" && options.indexState !== "ready")) {
    return { ready: false, label: "Waiting for history…" };
  }
  return options.hasImport
    ? { ready: true, label: "Ready" }
    : { ready: false, label: "Historical data unavailable" };
}