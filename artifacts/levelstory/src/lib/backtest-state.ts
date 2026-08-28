export type HistoricalIndexState = "not_started" | "indexing" | "ready" | "failed";

export type HistoricalReadiness = {
  ready: boolean;
  label: string;
};

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