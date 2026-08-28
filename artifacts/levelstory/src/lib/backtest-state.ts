export type HistoricalIndexState = "not_started" | "indexing" | "ready" | "failed";

export type HistoricalReadiness = {
  ready: boolean;
  label: string;
};

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