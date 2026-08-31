import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  useCancelBatchBacktest,
  useGetBacktestAuditPage,
  useGetBatchBacktestStatus,
  useGetBatchFunnel,
  useGetHistoricalData,
  useGetHistoricalEmaComparison,
  useGetHistoricalDataIndexStatus,
  useRunBacktest,
  useStartBatchBacktest,
} from "@workspace/api-client-react";
import type {
  BacktestAuditRecord,
  BacktestMetricSet,
  BacktestReport,
  BatchBacktestReport,
  HistoricalImportSummary,
  HistoricalEmaComparisonReport,
  QualificationFunnelStage,
  WalkForwardEdgeStatus,
  WalkForwardReport,
} from "@workspace/api-client-react";
import { BarChart3, Check, CheckCircle2, CircleX, Database, FileCheck2, LockKeyhole, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, Panel, PanelTitle, PageIntro, QueryError, ShadowBadge } from "@/components/levelstory-ui";
import {
  acceptedOutrightFilesLabel,
  coverageEligibilityLabel,
  getHistoricalBacktestReadiness,
  getMultiContractCoverageTotals,
  getBacktestSessionLimits,
  MAX_BACKTEST_SESSIONS,
} from "@/lib/backtest-state";

const symbols = ["MES", "ES", "MNQ", "NQ"];

const MULTI_CONTRACT_SOURCE = "historical_databento_multicontract" as const;

const coverageStatusLabels: Record<string, string> = {
  eligible: "Sufficient scheduled coverage",
  missing_scheduled_file: "Scheduled contract file missing",
  no_scheduled_contract_candles: "No scheduled-contract candles",
  insufficient_rth_coverage: "Insufficient regular-session coverage",
  invalid_or_rejected_source_data: "Invalid or rejected source data",
  duplicate_or_overlapping_active_contract_data: "Duplicate or overlapping active-contract data",
  no_scheduled_contract: "No scheduled contract",
  outside_configured_rollover_schedule: "Outside configured rollover schedule",
};

function CoverageYesNo({ value, label }: { value: boolean; label: string }) {
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold" aria-label={`${label}: ${value ? "yes" : "no"}`}>
    {value ? <CheckCircle2 size={13} aria-hidden="true" /> : <CircleX size={13} aria-hidden="true" />}
    {value ? "Yes" : "No"}
  </span>;
}

function HistoricalImportResults({ data, isLoading, isError }: { data?: HistoricalImportSummary; isLoading: boolean; isError: boolean }) {
  if (isLoading) return <Panel><div className="p-6 text-center text-xs text-muted-foreground">Streaming the uploaded Databento CSV and validating each row…</div></Panel>;
  if (isError || !data) return <Panel><div className="p-6 text-xs text-destructive">The server-side Databento source could not be imported. Check the configured historical inputs and try again.</div></Panel>;
  const stats = [
    ["Valid rows", data.validRows.toLocaleString()],
    ["Rejected rows", data.rejectedRows.toLocaleString()],
    ["Duplicates removed", data.duplicateRowsRemoved.toLocaleString()],
     ["Missing minutes", `${data.missingMinuteGaps.toLocaleString()} across ${data.missingGapSegments} raw gaps`],
     ["Unexpected missing", `${data.unexpectedMissingMinutes.toLocaleString()} min`],
    ["Open-session gaps", `${data.unexpectedOpenSessionMissingMinutes.toLocaleString()} min`],
    ["Overnight gaps", `${data.unexpectedOvernightMissingMinutes.toLocaleString()} min`],
    ["RTH gap segments", String(data.regularSessionGapSegments)],
    ["Regular-session gaps", `${data.regularSessionMissingMinutes.toLocaleString()} min`],
     ["Expected closed time", `${data.expectedClosedMinutes.toLocaleString()} min`],
     ["Maintenance / daily close", `${data.maintenanceGapMinutes.toLocaleString()} min`],
     ["Weekend / holiday", `${data.weekendHolidayClosedMinutes.toLocaleString()} min`],
     ["Early close", `${data.earlyCloseMinutes.toLocaleString()} min`],
     ["Inactive contract", `${data.inactiveContractMinutes.toLocaleString()} min`],
    ["Inactive contract days", `${data.inactiveContractDays} at <${data.inactiveContractThresholdPercent}% RTH coverage`],
    ["Missing RTH dates", String(data.missingRegularSessionDates.length)],
    ["Missing overnight dates", data.overnightCoverageObserved ? String(data.missingOvernightSessionDates.length) : "not observed"],
    ["Regular session", data.regularSessionCandleCount.toLocaleString()],
    ["Overnight", data.overnightCandleCount.toLocaleString()],
  ];
  const multiContract = data.source === MULTI_CONTRACT_SOURCE;
  const coverageTotals = getMultiContractCoverageTotals(data);
  const acceptedOutrightFileCount = data.acceptedOutrightFileCount ?? data.files?.length ?? data.acceptedContracts?.length ?? 0;
  const scheduledActiveContractCount = data.scheduledActiveContractCount ?? new Set(data.activeContractByDate?.map((item) => item.contractSymbol)).size;
  const inactiveFutureContractCount = data.inactiveFutureContractCount ?? data.inactiveContracts?.length ?? 0;
  const rejectedSpreadOrDuplicateFileCount = data.rejectedSpreadOrDuplicateFileCount
    ?? data.rejectedFiles?.filter((file) => file.reason === "CALENDAR_SPREAD_REJECTED" || file.reason === "DUPLICATE_CONTRACT_FILE").length
    ?? 0;
  const missingScheduledContractFileCount = data.missingScheduledContractFileCount
    ?? new Set((data.ineligibleDates ?? [])
      .filter((item) => item.status === "missing_scheduled_file")
      .map((item) => item.scheduledContractSymbol)
      .filter((symbol): symbol is string => Boolean(symbol))).size;
  const dateRows = [...(data.dateEligibility ?? [])].sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
  return <Panel accent data-testid="panel-historical-import-results">
     <PanelTitle eyebrow="File import / validation" title={multiContract ? "Historical Databento Data — MES quarterly contracts — Shadow Mode" : "Historical Databento Data — MESU6 — Shadow Mode"} right={<FileCheck2 size={16} className="text-accent" />} />
    <div className="border-t border-border px-5 py-4 text-xs">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground"><span>File <strong className="text-foreground">{data.filename}</strong></span><span>Symbol <strong className="mono text-foreground">{data.detectedSymbol ?? "—"}</strong></span></div>
      <div className="mt-2 text-muted-foreground">UTC range <strong className="mono text-foreground">{data.earliestTimestamp ?? "—"} → {data.latestTimestamp ?? "—"}</strong></div>
    </div>
    <div className="grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-3">
      {stats.map(([label, value]) => <div key={label} className="px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
    </div>
       <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground">
         <p className="mb-2 text-foreground">{multiContract ? `Coverage is reported independently for each discovered outright file. The active contract is chosen by the explicit ${data.scheduleVersion ?? "versioned"} schedule; no price blending or back-adjustment is applied.` : "Full-file coverage includes dates before MESU6 became active; it is not the selected backtest window."}</p>
       <p>Expected closed = maintenance/daily close + weekend/holiday + early-close minutes. Unexpected missing = unexpected regular + unexpected overnight minutes. Inactive contract minutes are excluded from unexpected data loss when RTH coverage is below the configured threshold.</p>
      <div className="eyebrow mb-2">Aggregated bars</div>
      <div className="flex flex-wrap gap-x-5 gap-y-2"><span>1m <strong className="mono text-foreground">{data.aggregationCounts.oneMinute.toLocaleString()}</strong></span><span>5m <strong className="mono text-foreground">{data.aggregationCounts.fiveMinute.toLocaleString()}</strong></span><span>15m <strong className="mono text-foreground">{data.aggregationCounts.fifteenMinute.toLocaleString()}</strong></span><span>1h <strong className="mono text-foreground">{data.aggregationCounts.oneHour.toLocaleString()}</strong></span></div>
       {!multiContract && <div className="mt-3">All observed dates: <strong className="text-foreground">{data.availableTradingDates.length}</strong> ({data.availableTradingDates[0] ?? "—"} → {data.availableTradingDates.at(-1) ?? "—"})</div>}
        {multiContract && <div className="mt-5 space-y-5">
          {!coverageTotals.reconciles ? <div className="border border-destructive/40 bg-destructive/5 p-4 text-destructive" role="alert">Coverage totals failed reconciliation. Backtest eligibility is unavailable until the server returns a consistent summary.</div> : <>
            <section aria-labelledby="coverage-totals-heading">
              <div id="coverage-totals-heading" className="eyebrow mb-2 text-foreground">Replay eligibility totals</div>
              <div className="grid gap-px border border-border bg-border sm:grid-cols-3">
                <div className="bg-card px-4 py-4"><div className="eyebrow">All observed dates</div><div className="mono mt-2 text-lg text-foreground">{coverageTotals.allObservedDateCount.toLocaleString()}</div><div className="mt-1 text-[10px]">Informational only</div></div>
                <div className="bg-card px-4 py-4"><div className="eyebrow">Eligible scheduled replay dates</div><div className="mono mt-2 text-lg text-foreground">{coverageTotals.eligibleScheduledReplayDateCount.toLocaleString()}</div><div className="mt-1 text-[10px]">May enter a backtest or batch</div></div>
                <div className="bg-card px-4 py-4"><div className="eyebrow">Ineligible observed dates</div><div className="mono mt-2 text-lg text-foreground">{coverageTotals.ineligibleObservedDateCount.toLocaleString()}</div><div className="mt-1 text-[10px]">Observed, but blocked</div></div>
              </div>
              <p className="mt-3 max-w-4xl text-foreground">All observed dates come from every accepted contract file. Eligible scheduled replay dates contain sufficient data for the contract selected by the deterministic rollover schedule. Backtests use eligible dates only.</p>
              <p className="mt-2 font-semibold text-foreground">Reconciliation: {coverageTotals.allObservedDateCount.toLocaleString()} all observed = {coverageTotals.eligibleScheduledReplayDateCount.toLocaleString()} eligible + {coverageTotals.ineligibleObservedDateCount.toLocaleString()} ineligible observed.</p>
            </section>
            <section aria-labelledby="coverage-inventory-heading">
              <div id="coverage-inventory-heading" className="eyebrow mb-2 text-foreground">Coverage inventory</div>
              <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
                {[
                  [acceptedOutrightFilesLabel(acceptedOutrightFileCount), "Accepted outright files"],
                  [String(scheduledActiveContractCount), "Scheduled active contracts"],
                  [String(inactiveFutureContractCount), "Inactive / future contracts"],
                  [String(rejectedSpreadOrDuplicateFileCount), "Rejected spreads or duplicate files"],
                  [String(missingScheduledContractFileCount), "Missing scheduled contract files"],
                  [String(data.ineligibleScheduledDateCount ?? data.ineligibleDates?.length ?? 0), "Ineligible scheduled dates"],
                ].map(([value, label]) => <div key={label} className="bg-card px-4 py-4"><div className="eyebrow">{label}</div><div className="mono mt-2 text-sm text-foreground">{value}</div></div>)}
              </div>
            </section>
            <section aria-labelledby="uploaded-coverage-heading">
              <div id="uploaded-coverage-heading" className="eyebrow mb-2 text-foreground">Uploaded contract coverage</div>
              <div className="grid gap-2 text-foreground sm:grid-cols-2">{(data.files ?? []).map((file) => <div key={file.contractSymbol} className="border border-border px-3 py-2"><div className="mono">{file.contractSymbol} <span className="text-muted-foreground">· {file.status}</span></div><div className="mt-1 text-[10px] text-muted-foreground">{file.coverageStatus ?? "not_calculated"} · {file.activeSelectedDates.length} eligible dates · {file.regularSessionCandleCount?.toLocaleString() ?? "—"} RTH candles</div>{file.activePeriod?.reason && <div className="mt-1 text-[10px] text-muted-foreground">{file.activePeriod.reason}</div>}</div>)}</div>
            </section>
            <section aria-labelledby="date-eligibility-heading">
              <details className="border border-border" open={dateRows.length <= 20}>
                <summary id="date-eligibility-heading" className="cursor-pointer list-none px-4 py-3 font-semibold text-foreground">Date-level eligibility <span className="ml-2 font-normal text-muted-foreground">({dateRows.length} scheduled dates; expand to review)</span></summary>
                <div className="border-t border-border px-4 py-3 text-[10px] text-muted-foreground">Eligibility is shown with words and symbols, not color alone. The schedule version and rollover context are included for every date.</div>
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full min-w-[1280px] text-left text-[10px]" aria-label="Date-level scheduled replay eligibility">
                    <thead className="bg-muted/40 uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-3 py-3">Trading date</th><th className="px-3 py-3">Scheduled contract</th><th className="px-3 py-3">Rollover / schedule</th><th className="px-3 py-3">Observed in any file</th><th className="px-3 py-3">Scheduled-contract data</th><th className="px-3 py-3">Coverage status</th><th className="px-3 py-3">Backtest eligible</th><th className="px-3 py-3">Ineligibility reason</th></tr></thead>
                    <tbody className="divide-y divide-border">{dateRows.map((row) => <tr key={row.tradingDate} className={row.backtestEligible ? "" : "bg-muted/20"}>
                      <td className="mono whitespace-nowrap px-3 py-3">{row.tradingDate}</td>
                      <td className="mono whitespace-nowrap px-3 py-3">{row.scheduledContractSymbol ?? "None scheduled"}</td>
                      <td className="max-w-[240px] px-3 py-3 text-muted-foreground"><span className="block">{row.rolloverReason}</span><span className="mono mt-1 block">{row.scheduleVersion}</span></td>
                      <td className="px-3 py-3"><CoverageYesNo value={row.observedInAnyFile} label="Observed in any file" /></td>
                      <td className="px-3 py-3"><CoverageYesNo value={row.scheduledContractDataAvailable} label="Scheduled-contract data available" /></td>
                      <td className="px-3 py-3">{coverageStatusLabels[row.coverageStatus] ?? row.coverageStatus}</td>
                      <td className="px-3 py-3"><span className="font-semibold" aria-label={coverageEligibilityLabel(row.backtestEligible)}>{row.backtestEligible ? "✓ Yes" : "— No"} <span className="sr-only">{coverageEligibilityLabel(row.backtestEligible)}</span></span></td>
                      <td className="max-w-[280px] px-3 py-3 text-muted-foreground">{row.backtestEligible ? "—" : row.reason ?? coverageStatusLabels[row.coverageStatus] ?? "Not eligible"}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </details>
            </section>
          </>}
        </div>}
    </div>
  </Panel>;
}

function HistoricalEmaComparisonPanel({ report, isLoading, isError, selectedTimestamps, onToggle }: {
  report?: HistoricalEmaComparisonReport;
  isLoading: boolean;
  isError: boolean;
  selectedTimestamps: string[];
  onToggle: (timestamp: string) => void;
}) {
  if (isLoading) return <Panel><div className="p-6 text-center text-xs text-muted-foreground">Calculating an independent EMA from the uploaded 5-minute closes…</div></Panel>;
  if (isError || !report) return <Panel><div className="p-6 text-xs text-destructive">The independent EMA comparison could not be loaded.</div></Panel>;
  const formatTimestamp = (value: string) => new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  return <Panel accent data-testid="panel-ema-comparison">
    <PanelTitle eyebrow="Independent audit / uploaded history" title="EMA comparison report" right={<span className="mono text-[10px] text-muted-foreground">EMA {report.rows[0]?.period ?? 200} · MES</span>} />
    <div className="border-t border-border bg-accent/5 px-5 py-4 text-xs leading-5">
      <p className="font-semibold">Not a NinjaTrader equivalence test.</p>
      <p className="mt-1 text-muted-foreground">{report.inputMatchNote}</p>
    </div>
    <div className="border-t border-border px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><div className="eyebrow text-muted-foreground">Choose three timestamps</div><div className="mt-1 text-[11px] text-muted-foreground">Selections are limited to timestamps with an independently warmed-up EMA.</div></div>
        <span className={`mono text-[10px] font-bold ${selectedTimestamps.length === 3 ? "text-[hsl(var(--positive))]" : "text-accent"}`}>{selectedTimestamps.length}/3 selected</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {report.candidates.map((candidate) => <label key={`${candidate.contract}-${candidate.timestamp}`} className={`inline-flex cursor-pointer items-center gap-2 border px-2.5 py-2 text-[10px] transition-colors ${selectedTimestamps.includes(candidate.timestamp) ? "border-accent bg-accent/10" : "border-border hover:bg-muted/50"}`}>
          <input type="checkbox" checked={selectedTimestamps.includes(candidate.timestamp)} onChange={() => onToggle(candidate.timestamp)} disabled={!selectedTimestamps.includes(candidate.timestamp) && selectedTimestamps.length >= 3} className="accent-[hsl(var(--accent))]" />
          <span className="mono">{formatTimestamp(candidate.timestamp)}</span><span className="text-muted-foreground">{candidate.contract}</span>
        </label>)}
      </div>
    </div>
    <div className="overflow-x-auto border-t border-border">
      <table className="w-full min-w-[1050px] text-left text-xs">
        <thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Timestamp</th><th className="px-4 py-3">Contract / session template</th><th className="px-4 py-3">Warm-up / source range</th><th className="px-4 py-3">Uploaded close</th><th className="px-4 py-3">Independent EMA</th><th className="px-4 py-3">Difference</th><th className="px-4 py-3">Availability</th></tr></thead>
        <tbody className="divide-y divide-border">{report.rows.map((row) => <tr key={row.timestamp} data-testid={`ema-comparison-row-${row.timestamp}`}>
          <td className="mono px-4 py-3">{formatTimestamp(row.timestamp)}<span className="mt-1 block text-[10px] text-muted-foreground">{row.timestamp}</span></td>
          <td className="px-4 py-3"><strong>{row.contract}</strong><span className="mt-1 block max-w-[250px] text-[10px] leading-4 text-muted-foreground">{row.cmeSessionTemplate}</span></td>
          <td className="mono px-4 py-3 text-[10px]">{row.warmupCount} candles<span className="mt-1 block text-muted-foreground">{row.sourceRange.earliest ?? "—"} → {row.sourceRange.latest ?? "—"}</span></td>
          <td className="mono px-4 py-3">{row.sourceClose?.toFixed(2) ?? "—"}</td>
          <td className="mono px-4 py-3">{row.independentEma?.toFixed(4) ?? "—"}</td>
          <td className="mono px-4 py-3">{row.differencePoints == null ? "—" : `${row.differencePoints >= 0 ? "+" : ""}${row.differencePoints.toFixed(4)} pts`}<span className="mt-1 block text-[10px] text-muted-foreground">{row.differenceTicks == null ? "—" : `${row.differenceTicks >= 0 ? "+" : ""}${row.differenceTicks.toFixed(2)} MES ticks`}</span></td>
          <td className={`px-4 py-3 font-semibold ${row.available ? "text-[hsl(var(--positive))]" : "text-destructive"}`}>{row.available ? "Available" : "Unavailable"}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="border-t border-border px-5 py-3 text-[10px] leading-4 text-muted-foreground">Method: 200-period EMA seeded with the first 200 complete uploaded 5-minute closes. Differences are close minus independent EMA; one MES tick = 0.25 points. This report validates source assumptions only and makes no broker/platform equivalence claim.</div>
  </Panel>;
}

function money(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}$${value.toFixed(2)}`;
}

function MetricGrid({ metrics, accent = false }: { metrics: BacktestMetricSet; accent?: boolean }) {
  const items = [
    ["Trades", String(metrics.tradeCount)],
    ["Win rate", `${metrics.winRate.toFixed(1)}%`],
    ["Expectancy", money(metrics.expectancy)],
    ["Profit factor", metrics.profitFactor === null ? "—" : metrics.profitFactor.toFixed(2)],
    ["Max drawdown", money(-metrics.maximumDrawdown)],
    ["Net P&L", money(metrics.netPnl)],
    ["Fees", money(-metrics.fees)],
    ["Slippage", money(-metrics.slippage)],
    ["Consecutive losses", String(metrics.consecutiveLosses)],
    ["Ambiguous trades", String(metrics.ambiguousTradeCount)],
  ];
  return <div className={`grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-4 sm:divide-y-0 ${accent ? "bg-accent/5" : ""}`}>
    {items.map(([label, value]) => <div key={label} className="px-4 py-4 sm:px-5">
      <div className="eyebrow text-muted-foreground">{label}</div>
      <div className={`mono mt-2 text-lg font-medium ${label === "Net P&L" || label === "Expectancy" ? (metrics.netPnl >= 0 ? "status-positive" : "status-negative") : ""}`}>{value}</div>
    </div>)}
  </div>;
}

const edgeStatusLabels: Record<WalkForwardEdgeStatus, string> = {
  insufficient_evidence: "Insufficient evidence",
  negative_observed_expectancy: "Negative observed expectancy",
  mixed_inconclusive: "Mixed / inconclusive",
  positive_observed_expectancy_requires_further_validation: "Positive observed expectancy — further validation required",
};

function edgeStatusClass(status: WalkForwardEdgeStatus): string {
  if (status === "negative_observed_expectancy") return "status-negative";
  if (status === "positive_observed_expectancy_requires_further_validation") return "status-positive";
  return "text-foreground";
}

function WalkForwardMetrics({ metrics }: { metrics: BacktestMetricSet }) {
  return <div className="grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-4">
    {[
      ["Trades", String(metrics.tradeCount)],
      ["Expectancy", money(metrics.expectancy)],
      ["Net P&L", money(metrics.netPnl)],
      ["Max drawdown", money(-metrics.maximumDrawdown)],
      ["Fees", money(-metrics.fees)],
      ["Slippage", money(-metrics.slippage)],
      ["Stops / targets / runners", `${metrics.stopExits} / ${metrics.targetExits} / ${metrics.runnerExits}`],
      ["Consecutive losses", String(metrics.consecutiveLosses)],
      ["Ambiguous trades", String(metrics.ambiguousTradeCount)],
    ].map(([label, value]) => <div key={label} className="px-4 py-3"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
  </div>;
}

function WalkForwardPanel({ report }: { report: BatchBacktestReport }) {
  const validation: WalkForwardReport = report.walkForward;
  const segmentRows = validation.segments.slice(0, 40);
  return <div className="space-y-5">
    <Panel accent>
      <PanelTitle eyebrow="Phase 11C / fixed chronological folds" title="Walk-forward validation" right={<span className={`text-[10px] font-bold uppercase ${edgeStatusClass(validation.edgeStatus)}`}>{edgeStatusLabels[validation.edgeStatus]}</span>} />
      <div className="border-t border-border bg-accent/5 px-5 py-4 text-xs leading-5">
        <p className="font-semibold">Descriptive validation only — no tuning, optimization, live trading, or proven-edge claim.</p>
        <p className="mt-1 text-muted-foreground">Each fold keeps its out-of-sample dates untouched. The fixed formula identity is carried through the report and cache.</p>
      </div>
      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-4">
        {[
          ["Formula hash", `${validation.formulaHash.slice(0, 16)}…`],
          ["Formula version", validation.formulaVersion],
          ["Folds", String(validation.foldCount)],
          ["Evidence", `${validation.minimumEvidence.totalTrades} / ${validation.minimumEvidence.requiredTotalTrades} trades · ${validation.minimumEvidence.holdoutTrades} / ${validation.minimumEvidence.requiredHoldoutTrades} holdout`],
        ].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 break-all text-xs">{value}</div></div>)}
      </div>
      <WalkForwardMetrics metrics={validation.metrics} />
    </Panel>

    <div className="grid gap-5 lg:grid-cols-2">
      <Panel>
        <PanelTitle eyebrow="Chronological training view" title="In-sample evidence" />
        <WalkForwardMetrics metrics={validation.inSample} />
      </Panel>
      <Panel accent>
        <PanelTitle eyebrow="Untouched evaluation view" title="Out-of-sample evidence" right={<span className="border border-accent/40 bg-accent/10 px-2 py-1 text-[9px] font-bold uppercase">Holdout</span>} />
        <WalkForwardMetrics metrics={validation.outOfSample} />
      </Panel>
    </div>

    <Panel>
      <PanelTitle eyebrow="No random splits / exact dates" title="Fold ledger" right={<span className="mono text-[10px] text-muted-foreground">{validation.foldCount} folds</span>} />
      {validation.folds.length ? <div className="divide-y divide-border border-t border-border">{validation.folds.map((fold) => <div key={fold.foldId} className="grid gap-4 px-5 py-4 lg:grid-cols-[120px_1fr_1fr_220px]">
        <div><div className="eyebrow text-muted-foreground">{fold.foldId}</div><div className="mono mt-2 text-xs">{fold.startDate} → {fold.endDate}</div></div>
        <div className="text-xs"><div className="eyebrow text-muted-foreground">In-sample dates</div><div className="mono mt-2 leading-5">{fold.inSampleDates.join(", ") || "—"}</div></div>
        <div className="text-xs"><div className="eyebrow text-muted-foreground">Untouched holdout dates</div><div className="mono mt-2 leading-5">{fold.outOfSampleDates.join(", ") || "—"}</div><div className="mt-2 text-[10px] text-muted-foreground">{fold.contractPartitions.map((partition) => `${partition.tradingDate} · ${partition.contractSymbol}`).join(" / ")}</div></div>
        <div><div className="eyebrow text-muted-foreground">Observed status</div><div className={`mt-2 text-xs font-semibold ${edgeStatusClass(fold.edgeStatus)}`}>{edgeStatusLabels[fold.edgeStatus]}</div><div className="mono mt-2 text-[10px] text-muted-foreground">{fold.metrics.tradeCount} trades · {money(fold.metrics.netPnl)}</div></div>
      </div>)}</div> : <div className="border-t border-border p-6 text-sm text-muted-foreground">No complete fixed fold fits the selected dates. The report does not invent a partial fold.</div>}
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Independent cost cases" title="Sensitivity — never selected" right={<span className="text-[10px] text-muted-foreground">same formula / dates / contracts</span>} />
      <div className="grid gap-4 border-t border-border p-5 md:grid-cols-3">{validation.sensitivity.map((scenario) => <div key={scenario.scenario} className="border border-border p-4">
        <div className="flex items-start justify-between gap-2"><div className="text-xs font-semibold">{scenario.label}</div><span className={`text-[9px] font-bold uppercase ${edgeStatusClass(scenario.edgeStatus)}`}>{edgeStatusLabels[scenario.edgeStatus]}</span></div>
        <div className="mt-4"><WalkForwardMetrics metrics={scenario.outOfSample} /></div>
        <ul className="mt-3 space-y-1 text-[10px] leading-4 text-muted-foreground">{scenario.assumptions.map((assumption) => <li key={assumption}>• {assumption}</li>)}</ul>
      </div>)}</div>
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Required segmentation" title="Where observed results cluster" right={<span className="mono text-[10px] text-muted-foreground">{validation.segments.length} groups</span>} />
      {segmentRows.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[980px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Dimension</th><th className="px-4 py-3">Value</th><th className="px-4 py-3">Sample</th><th className="px-4 py-3">Trades</th><th className="px-4 py-3">Expectancy</th><th className="px-4 py-3">Net</th><th className="px-4 py-3">Costs</th><th className="px-4 py-3">Ambiguous</th><th className="px-4 py-3">Status</th></tr></thead><tbody className="divide-y divide-border">{segmentRows.map((segment) => <tr key={`${segment.dimension}-${segment.value}`}><td className="px-4 py-3 font-semibold">{segment.dimension}</td><td className="px-4 py-3 text-muted-foreground">{segment.value}</td><td className="px-4 py-3 text-[10px]">{segment.sampleStatus === "insufficient_sample" ? "Insufficient sample" : "Sufficient"}</td><td className="mono px-4 py-3">{segment.tradeCount}</td><td className="mono px-4 py-3">{money(segment.expectancy)}</td><td className={`mono px-4 py-3 ${segment.netPnl >= 0 ? "status-positive" : "status-negative"}`}>{money(segment.netPnl)}</td><td className="mono px-4 py-3 text-muted-foreground">{money(segment.fees + segment.slippage)}</td><td className="mono px-4 py-3">{segment.ambiguousTradeCount}</td><td className={`px-4 py-3 text-[10px] font-semibold ${edgeStatusClass(segment.edgeStatus)}`}>{edgeStatusLabels[segment.edgeStatus]}</td></tr>)}</tbody></table></div> : <div className="border-t border-border p-8 text-center text-sm text-muted-foreground">No qualified trade groups were produced; this is reported as insufficient evidence rather than an edge.</div>}
    </Panel>
  </div>;
}

const funnelStageLabels: Record<QualificationFunnelStage, string> = {
  session_loaded: "Trading session loaded",
  ntz_orb_completed: "NTZ / ORB completed",
  strong_breakout_candidate: "Strong breakout candidate",
  strong_continuation_confirmed: "Strong continuation confirmed",
  pullback_or_consolidation: "Pullback / consolidation",
  critical_level_interaction: "Critical-level interaction",
  fibonacci_context_available: "Fibonacci context available",
  volume_condition_passed: "Volume condition passed",
  valid_trend_aligned_patience_candle: "Valid trend-aligned patience candle",
  immediate_next_candle_confirmation: "Immediate-next-candle confirmation",
  risk_approved: "Risk approved",
  modeled_entry: "Modeled entry",
  final_exit: "Target / stop / runner / session-close exit",
};

function candidateEvidenceValue(evidence: Record<string, unknown>, key: string): string {
  const value = evidence[key];
  return value === null || value === undefined ? "—" : typeof value === "string" ? value : String(value);
}

function candidateEvidenceNumber(evidence: Record<string, unknown>, key: string): number | null {
  const value = evidence[key];
  return typeof value === "number" ? value : null;
}

function candidateEvidenceList(evidence: Record<string, unknown>, key: string): string[] {
  const value = evidence[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function BatchFunnelPanel({ report, batchId }: { report: BatchBacktestReport; batchId: string }) {
  const [selectedStage, setSelectedStage] = useState<QualificationFunnelStage | "all">("all");
  const [comparisonDimension, setComparisonDimension] = useState("contract");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const funnelQuery = useGetBatchFunnel({
    batchId,
    page: 1,
    pageSize: 50,
    ...(selectedStage === "all" ? {} : { stage: selectedStage }),
  }, {
    query: {
      enabled: Boolean(batchId),
      staleTime: 60_000,
      queryKey: ["batch-funnel", batchId, selectedStage],
    },
  });
  const comparisons = report.funnel.comparisons.filter((comparison) => comparison.dimension === comparisonDimension);
  const selectedCandidate = funnelQuery.data?.candidates.find((candidate) => candidate.candidateId === selectedCandidateId)
    ?? funnelQuery.data?.candidates[0];
  const firstCount = report.funnel.stages[0]?.count ?? 0;
  return <div className="space-y-5">
    <Panel accent>
      <PanelTitle eyebrow="Phase 11B / unique candidates" title="Qualification funnel" right={<span className="mono text-[10px] text-muted-foreground">{report.funnel.candidateCount} candidates · {report.funnel.sessionCount} sessions</span>} />
      <div className="border-t border-border bg-accent/5 px-5 py-3 text-xs leading-5 text-muted-foreground">Each candidate is counted once per trading date, active contract, setup, and direction. The funnel describes observed rule progression only; it does not optimize parameters or claim an edge.</div>
      <div className="divide-y divide-border border-t border-border">
        {report.funnel.stages.map((stage) => {
          const width = firstCount === 0 ? 0 : Math.max(2, (stage.count / firstCount) * 100);
          return <button key={stage.stage} type="button" onClick={() => setSelectedStage(stage.stage)} className={`grid w-full grid-cols-[minmax(180px,1fr)_70px_90px_90px] items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/40 ${selectedStage === stage.stage ? "bg-accent/10" : ""}`} data-testid={`funnel-stage-${stage.stage}`}>
            <span className="min-w-0"><span className="block truncate text-xs font-semibold">{funnelStageLabels[stage.stage]}</span><span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-accent" style={{ width: `${width}%` }} /></span></span>
            <span className="mono text-right text-sm">{stage.count}</span>
            <span className="mono text-right text-[10px] text-muted-foreground">{stage.percentOfPreceding.toFixed(1)}% prev.</span>
            <span className="mono text-right text-[10px] text-muted-foreground">{stage.percentOfSessions.toFixed(1)}% sessions</span>
          </button>;
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
        <span>Primary rejection details:</span>
        {report.funnel.rejectionCounts.map((item) => <span key={item.stage} className="border border-border px-2 py-1"><strong className="text-foreground">{item.count}</strong> · {funnelStageLabels[item.stage]}</span>)}
        {!report.funnel.rejectionCounts.length && <span>none recorded</span>}
      </div>
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Comparative cuts" title="Where candidates cluster" right={<BarChart3 size={16} className="text-muted-foreground" />} />
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
        <label className="text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">Compare by
          <select value={comparisonDimension} onChange={(event) => setComparisonDimension(event.target.value)} className="field ml-2 py-1 text-xs">
            <option value="contract">Contract</option><option value="month">Calendar month</option><option value="direction">Direction</option><option value="period">Sample partition</option><option value="market_regime">Market regime</option><option value="volume_regime">Volume regime</option>
          </select>
        </label>
        <span className="text-[10px] text-muted-foreground">Counts remain unique within each comparison.</span>
      </div>
      {comparisons.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[920px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Value</th><th className="px-4 py-3">Candidates</th>{report.funnel.stages.slice(0, 6).map((stage) => <th key={stage.stage} className="px-4 py-3">{funnelStageLabels[stage.stage]}</th>)}</tr></thead><tbody className="divide-y divide-border">{comparisons.map((comparison) => <tr key={`${comparison.dimension}-${comparison.value}`}><td className="px-4 py-3 font-semibold">{comparison.value}</td><td className="mono px-4 py-3">{comparison.candidateCount}</td>{comparison.stageCounts.slice(0, 6).map((stage) => <td key={stage.stage} className="mono px-4 py-3 text-muted-foreground">{stage.count}</td>)}</tr>)}</tbody></table></div> : <div className="border-t border-border p-6 text-sm text-muted-foreground">No comparison candidates were recorded.</div>}
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Causal drill-down" title={selectedStage === "all" ? "All unique candidates" : funnelStageLabels[selectedStage]} right={<span className="mono text-[10px] text-muted-foreground">{funnelQuery.data?.total ?? 0} rows</span>} />
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
        <label className="text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">Stage
          <select value={selectedStage} onChange={(event) => { setSelectedStage(event.target.value as QualificationFunnelStage | "all"); setSelectedCandidateId(null); }} className="field ml-2 py-1 text-xs" data-testid="select-funnel-stage">
            <option value="all">All candidates</option>
            {report.funnel.stages.map((stage) => <option key={stage.stage} value={stage.stage}>{funnelStageLabels[stage.stage]}</option>)}
          </select>
        </label>
        <span className="text-[10px] text-muted-foreground">Select a row to inspect the supporting evidence.</span>
      </div>
      {funnelQuery.isError ? <div className="border-t border-border p-6 text-sm text-destructive">The candidate drill-down could not be loaded.</div> : funnelQuery.data?.candidates.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[980px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Date / contract</th><th className="px-4 py-3">Setup / side</th><th className="px-4 py-3">Reached</th><th className="px-4 py-3">Primary rejection</th><th className="px-4 py-3">Regime / volume</th><th className="px-4 py-3">Outcome</th></tr></thead><tbody className="divide-y divide-border">{funnelQuery.data.candidates.map((candidate) => <tr key={candidate.candidateId} onClick={() => setSelectedCandidateId(candidate.candidateId)} className={`cursor-pointer hover:bg-muted/40 ${selectedCandidate?.candidateId === candidate.candidateId ? "bg-accent/10" : ""}`}><td className="mono px-4 py-3">{candidate.tradingDate}<span className="block text-[10px] text-muted-foreground">{candidate.contractSymbol} · {candidate.contractMonth}</span><span className="block text-[10px] text-muted-foreground">{candidate.timeOfDay}</span></td><td className="px-4 py-3">{candidate.setupType}<span className="block text-[10px] font-bold uppercase">{candidate.direction ?? "unknown"}</span></td><td className="px-4 py-3 text-[10px]">{funnelStageLabels[candidate.reachedStage]}</td><td className="px-4 py-3 text-[10px] text-muted-foreground">{candidate.primaryRejectionStage ? funnelStageLabels[candidate.primaryRejectionStage] : "—"}<span className="block max-w-[260px]">{candidate.rejectionDetail ?? ""}</span></td><td className="px-4 py-3 text-[10px] text-muted-foreground">{candidate.marketRegime} · {candidate.volumeRegime}</td><td className="mono px-4 py-3">{candidateEvidenceValue(candidate.evidence, "finalOutcome")}{candidateEvidenceNumber(candidate.evidence, "netPnl") !== null && <span className="ml-2">{money(candidateEvidenceNumber(candidate.evidence, "netPnl") ?? 0)}</span>}</td></tr>)}</tbody></table></div> : <div className="border-t border-border p-6 text-sm text-muted-foreground">No candidates match this funnel stage.</div>}
      {selectedCandidate && <div className="grid gap-4 border-t border-border bg-muted/20 p-5 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div><div className="eyebrow text-muted-foreground">Relevant candle times</div><div className="mono mt-2 leading-5">{candidateEvidenceValue(selectedCandidate.evidence, "evaluatedCandleOpenTime")}<br />patience {candidateEvidenceValue(selectedCandidate.evidence, "patienceCandleOpenTime")} → {candidateEvidenceValue(selectedCandidate.evidence, "patienceCandleCloseTime")}<br />trigger {candidateEvidenceValue(selectedCandidate.evidence, "triggerCandleOpenTime")} → {candidateEvidenceValue(selectedCandidate.evidence, "triggerCandleCloseTime")}</div></div>
        <div><div className="eyebrow text-muted-foreground">ORB / breakout</div><div className="mt-2 leading-5">{candidateEvidenceValue(selectedCandidate.evidence, "orbLevels")}<br />{candidateEvidenceValue(selectedCandidate.evidence, "breakout")}</div></div>
        <div><div className="eyebrow text-muted-foreground">Volume / pullback</div><div className="mt-2 leading-5">{candidateEvidenceValue(selectedCandidate.evidence, "volume")}<br />{candidateEvidenceValue(selectedCandidate.evidence, "pullback")}<br />{candidateEvidenceValue(selectedCandidate.evidence, "criticalLevel")}</div></div>
        <div><div className="eyebrow text-muted-foreground">Risk / outcome</div><div className="mono mt-2 leading-5">entry {candidateEvidenceValue(selectedCandidate.evidence, "entryTriggerPrice")}<br />stop {candidateEvidenceValue(selectedCandidate.evidence, "strategyStopPrice")} / {candidateEvidenceValue(selectedCandidate.evidence, "catastropheStopPrice")}<br />target {candidateEvidenceValue(selectedCandidate.evidence, "targetPrice")}<br />{candidateEvidenceValue(selectedCandidate.evidence, "finalOutcome")}</div></div>
        <div className="sm:col-span-2 lg:col-span-4"><div className="eyebrow text-muted-foreground">Rule evidence</div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">{candidateEvidenceList(selectedCandidate.evidence, "ruleEvidence").map((evidence) => <span key={evidence}>{evidence}</span>)}</div></div>
      </div>}
    </Panel>
  </div>;
}

function ReportBody({ report, fullCoverage }: { report: BacktestReport; fullCoverage?: HistoricalImportSummary }) {
  const [auditPage, setAuditPage] = useState(1);
  const [auditFilter, setAuditFilter] = useState<"all" | "AMBIGUITY" | "FAILURE" | "WAITING" | "EXPIRED" | "RISK_REJECTION" | "POSITION_ACTIVE">("all");
  const [auditDate, setAuditDate] = useState("");
  const runId = report.auditPage?.runId ?? "";
  const auditQuery = useGetBacktestAuditPage({
    runId,
    page: auditPage,
    pageSize: 50,
    ...(auditFilter === "all" ? {} : { category: auditFilter }),
    ...(auditDate ? { date: auditDate } : {}),
  });
  const segmentRows = report.segments.filter((segment) => segment.tradeCount > 0 || segment.rejectedSetupCount > 0).slice(0, 24);
  const auditRows: BacktestAuditRecord[] = auditQuery.data?.audit ?? report.audit;
  const auditTotal = auditQuery.data?.total ?? report.auditPage?.total ?? auditRows.length;
  const rejectedAuditRows = auditRows.filter((item) => item.rejectionReason !== null);
  const ambiguousAuditRows = auditRows.filter((item) => item.rejectionCategory === "AMBIGUITY");
  return <div className="space-y-5">
    <Panel accent>
      <PanelTitle eyebrow="Run integrity / causal replay" title={`${report.symbol} · ${report.contract.fullContractSymbol}`} right={<span className="mono text-[10px] text-muted-foreground">{report.dataResolution}</span>} />
       <div className="border-t border-border px-5 py-3 text-xs"><strong>{report.dataSource === MULTI_CONTRACT_SOURCE ? "Historical Databento Data — MES quarterly contracts" : report.dataSource === "historical_databento" ? "Historical Databento Data — MESU6" : "Simulated demo data"} — {report.executionMode === "ohlcv_modeled" ? "Modeled OHLCV execution" : "Shadow Mode"}</strong><span className="ml-2 text-muted-foreground">{report.fillLabel}</span></div>
       <div className="grid gap-px border-t border-border bg-border sm:grid-cols-6">
        {[
          ["Dataset", `${report.dataset.startDate} → ${report.dataset.endDate}`],
           ["Requested range", `${report.dataset.requestedStartDate} → ${report.dataset.requestedEndDate}`],
            ["Dates selected for this run", `${report.dataset.selectedDates.length} exact sessions`],
          ["Visible candles", `${report.replay.visibleCandleCount} / ${report.replay.totalCandleCount}`],
          ["Holdout", `${report.dataset.outOfSampleDates.length} trading days`],
          ["Ambiguous trades", String(report.metrics.ambiguousTradeCount)],
         ["Modeled fills", String(report.metrics.modeledFills)],
        ].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
      </div>
       <div className="border-t border-border bg-accent/5 px-5 py-4 text-xs leading-5 text-foreground">
         Historical results use conservative OHLCV-based modeled fills. They do not represent actual bid/ask quotes, queue position, or guaranteed executions.
       </div>
       <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground">
         <div className="eyebrow mb-2">Exact replay partition</div>
         <div className="flex flex-wrap gap-x-5 gap-y-2">
            <span>Dates selected for this run <strong className="mono text-foreground">{report.dataset.selectedDates.join(", ") || "—"}</strong></span>
           <span>Excluded <strong className="mono text-foreground">{report.dataset.excludedDates.join(", ") || "none"}</strong></span>
         </div>
          {report.dataset.scheduleVersion && <div className="mt-3 space-y-1">
            <div>Rollover schedule <strong className="mono text-foreground">{report.dataset.scheduleVersion}</strong></div>
            <div>Active contract sequence <strong className="mono text-foreground">{[...new Set((report.dataset.activeContractByDate ?? []).map((item) => item.contractSymbol))].join(" → ") || "—"}</strong></div>
          </div>}
       </div>
      <div className="grid gap-3 border-t border-border p-5 text-xs sm:grid-cols-3">
        <div className="flex items-center gap-2 text-[hsl(var(--positive))]"><Check size={14} /> Causal cursor enforced</div>
        <div className="flex items-center gap-2 text-[hsl(var(--positive))]"><Check size={14} /> Future access blocked</div>
        <div className="flex items-center gap-2 text-[hsl(var(--positive))]"><Check size={14} /> Holdout untouched</div>
      </div>
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Execution policy / explicit assumptions" title={report.executionMode === "ohlcv_modeled" ? "Conservative OHLCV modeled fills" : "Observed quote Shadow fills"} right={<span className="mono text-[10px] text-muted-foreground">{report.executionPolicy.entryBufferTicks} tick buffer</span>} />
      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-4">
        {[
          ["Fill label", report.fillLabel],
          ["Entry / exit slippage", `${report.executionPolicy.entrySlippageTicks} / ${report.executionPolicy.exitSlippageTicks} ticks`],
          ["Stop rule", report.executionPolicy.stopRule],
          ["Ambiguity", report.executionPolicy.ambiguityRule],
        ].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mt-2 text-xs leading-5">{value}</div></div>)}
      </div>
         <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Formula hash: <strong className="mono text-foreground">{report.formulaHash.slice(0, 16)}…</strong> · Immediate-next-candle-only: <strong className="text-foreground">{report.executionPolicy.immediateNextCandleOnly ? "yes" : "no"}</strong> · Fee assumption: <strong className="mono text-foreground">${report.executionPolicy.commissionPerContract.toFixed(2)} / contract round trip</strong></div>
    </Panel>

     <div className="grid gap-5 lg:grid-cols-2">
     {fullCoverage && <Panel>
       <PanelTitle eyebrow="Data quality / full file" title="Uploaded-file coverage" right={<span className="mono text-[10px] text-muted-foreground">all dates</span>} />
       <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground">Includes dates before MESU6 became active. Sparse contract dates are classified using the inactivity threshold, not as generic vendor-data failures.</div>
       <div className="grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-3">
         {[
           ["Valid rows", fullCoverage.validRows.toLocaleString()],
            ["All observed dates", String(fullCoverage.allObservedDateCount ?? fullCoverage.availableTradingDates.length)],
           ["Classified missing total", `${fullCoverage.missingMinuteGaps.toLocaleString()} min`],
           ["Raw adjacent gap segments", `${fullCoverage.missingGapSegments.toLocaleString()}`],
           ["Unexpected", `${fullCoverage.unexpectedMissingMinutes.toLocaleString()} min`],
           ["Expected closed", `${fullCoverage.expectedClosedMinutes.toLocaleString()} min`],
           ["Inactive", `${fullCoverage.inactiveContractMinutes.toLocaleString()} min`],
         ].map(([label, value]) => <div key={label} className="px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
       </div>
       <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Inactive threshold: <strong className="text-foreground">{fullCoverage.inactiveContractThresholdPercent}% of expected RTH minutes</strong>.</div>
     </Panel>}
     <Panel>
       <PanelTitle eyebrow="Data quality / selected backtest" title="Missing-minute accounting" right={<span className="mono text-[10px] text-muted-foreground">{report.gapReport.missingGapSegments.toLocaleString()} raw adjacent segments</span>} />
       <div className="grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-7">
        {[
          ["Classified missing total", `${report.gapReport.missingMinuteGaps.toLocaleString()} min`],
          ["Raw adjacent gap segments", `${report.gapReport.missingGapSegments.toLocaleString()}`],
          ["Unexpected open", `${report.gapReport.unexpectedOpenSessionMissingMinutes.toLocaleString()} min`],
           ["Unexpected overnight", `${report.gapReport.unexpectedOvernightMissingMinutes.toLocaleString()} min / ${report.gapReport.overnightGapSegments} segments`],
           ["Unexpected regular", `${report.gapReport.unexpectedRegularSessionMissingMinutes.toLocaleString()} min / ${report.gapReport.regularSessionGapSegments} segments`],
          ["Regular session", `${report.gapReport.regularSessionMissingMinutes.toLocaleString()} min`],
           ["Unexpected missing", `${report.gapReport.unexpectedMissingMinutes.toLocaleString()} min`],
           ["Expected closed", `${report.gapReport.expectedClosedMinutes.toLocaleString()} min`],
           ["Maintenance / daily close", `${report.gapReport.maintenanceGapMinutes.toLocaleString()} min`],
           ["Weekend / holiday", `${report.gapReport.weekendHolidayClosedMinutes.toLocaleString()} min`],
           ["Early close", `${report.gapReport.earlyCloseMinutes.toLocaleString()} min`],
           ["Inactive contract", `${report.gapReport.inactiveContractMinutes.toLocaleString()} min`],
            ["Coverage scope", report.gapReport.coverageScope === "selected_dates" ? "Dates selected for this run" : "Full file"],
           ["Maintenance", `${report.gapReport.maintenanceGapMinutes.toLocaleString()} min`],
           ["Missing RTH dates", String(report.gapReport.missingRegularSessionDates.length)],
           ["Complete RTH dates", String(report.gapReport.completeRegularSessionDates.length)],
        ].map(([label, value]) => <div key={label} className="px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
      </div>
    </Panel>

    <div className="grid gap-5 lg:grid-cols-2">
      <Panel>
        <PanelTitle eyebrow="Training partition" title="In-sample" right={<span className="mono text-[10px] text-muted-foreground">{report.dataset.inSampleDates.length} days</span>} />
        <MetricGrid metrics={report.inSample} />
        <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Used for observation only. No thresholds are optimized by this run.</div>
      </Panel>
      <Panel accent>
        <PanelTitle eyebrow="Evaluation partition" title="Out-of-sample holdout" right={<span className="border border-accent/40 bg-accent/10 px-2 py-1 text-[9px] font-bold uppercase text-foreground">Untouched</span>} />
        <MetricGrid metrics={report.outOfSample} accent />
        <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Never used to choose thresholds or tune the strategy.</div>
      </Panel>
    </div>

    <Panel>
      <PanelTitle eyebrow="All partitions / never blended" title="Backtest economics" right={<span className="mono text-[10px] text-muted-foreground">{report.metrics.rejectedSetupCount} rejected setups</span>} />
      <MetricGrid metrics={report.metrics} />
      <div className="grid gap-3 border-t border-border px-5 py-4 text-xs text-muted-foreground sm:grid-cols-3">
        <span>Average win: <strong className="mono text-foreground">{money(report.metrics.averageWin)}</strong></span>
        <span>Average loss: <strong className="mono text-foreground">{money(report.metrics.averageLoss)}</strong></span>
        <span>Gross P&L: <strong className="mono text-foreground">{money(report.metrics.grossPnl)}</strong></span>
      </div>
      <div className="grid gap-3 border-t border-border px-5 py-4 text-xs text-muted-foreground sm:grid-cols-4">
        <span>Setups detected: <strong className="mono text-foreground">{report.metrics.setupsDetected}</strong></span>
        <span>Patience candles: <strong className="mono text-foreground">{report.metrics.patienceCandles}</strong></span>
        <span>Entry candles: <strong className="mono text-foreground">{report.metrics.entryTriggers}</strong></span>
        <span>Stops / targets / runners: <strong className="mono text-foreground">{report.metrics.stopExits} / {report.metrics.targetExits} / {report.metrics.runnerExits}</strong></span>
      </div>
       <div className="grid gap-3 border-t border-border px-5 py-4 text-xs text-muted-foreground sm:grid-cols-3">
         <span>Expired patience: <strong className="mono text-foreground">{report.metrics.expiredPatienceSetups}</strong></span>
         <span>Ambiguous entry / exit: <strong className="mono text-foreground">{report.metrics.ambiguousEntryCount} / {report.metrics.ambiguityCount}</strong></span>
         <span>Strategy / catastrophe stops: <strong className="mono text-foreground">{report.metrics.strategyStopExits} / {report.metrics.catastropheStopExits}</strong></span>
         <span>Partial target + runner: <strong className="mono text-foreground">{report.metrics.partialTargetExits}</strong></span>
         <span>Session-close exits: <strong className="mono text-foreground">{report.metrics.sessionCloseExits}</strong></span>
       </div>
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Requested breakdowns" title="Where the evidence clusters" right={<BarChart3 size={16} className="text-muted-foreground" />} />
      {segmentRows.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Dimension</th><th className="px-4 py-3">Value</th><th className="px-4 py-3">Trades</th><th className="px-4 py-3">Win</th><th className="px-4 py-3">Expectancy</th><th className="px-4 py-3">Net</th><th className="px-4 py-3">Rejected</th></tr></thead><tbody className="divide-y divide-border">{segmentRows.map((segment) => <tr key={`${segment.dimension}-${segment.value}`}><td className="px-4 py-3 font-semibold">{segment.dimension}</td><td className="px-4 py-3 text-muted-foreground">{segment.value}</td><td className="mono px-4 py-3">{segment.tradeCount}</td><td className="mono px-4 py-3">{segment.winRate.toFixed(1)}%</td><td className="mono px-4 py-3">{money(segment.expectancy)}</td><td className={`mono px-4 py-3 ${segment.netPnl >= 0 ? "status-positive" : "status-negative"}`}>{money(segment.netPnl)}</td><td className="mono px-4 py-3 text-muted-foreground">{segment.rejectedSetupCount}</td></tr>)}</tbody></table></div> : <div className="border-t border-border p-8 text-center text-sm text-muted-foreground">No qualified trades were produced in this deterministic sample. Rejected setup counts remain visible above.</div>}
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Execution evidence" title="Trade ledger" right={<span className="mono text-[10px] text-muted-foreground">{report.trades.length} simulated fills</span>} />
       {report.trades.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[1120px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Date / period</th><th className="px-4 py-3">Setup</th><th className="px-4 py-3">Side</th><th className="px-4 py-3">Entry → exit</th><th className="px-4 py-3">Result</th><th className="px-4 py-3">Costs</th><th className="px-4 py-3">Mode / audit</th></tr></thead><tbody className="divide-y divide-border">{report.trades.map((trade) => <tr key={trade.id}><td className="px-4 py-3"><span className="block">{trade.tradingDate}</span><span className="text-[10px] text-muted-foreground">{trade.period === "out_of_sample" ? "HOLDOUT" : "IN-SAMPLE"}</span><span className="mono block text-[10px] text-muted-foreground">entry event {trade.entryTime} · exit event {trade.exitTime} UTC</span>{trade.audit && <span className="mono mt-1 block text-[10px] text-muted-foreground">patience {trade.audit.patienceCandleOpenTime ?? "—"} → {trade.audit.patienceCandleCloseTime ?? "—"} · entry candle {trade.audit.triggerCandleOpenTime ?? "—"} → {trade.audit.triggerCandleCloseTime ?? "—"} · exit candle {trade.audit.exitCandleOpenTime ?? "—"} → {trade.audit.exitCandleCloseTime ?? "—"}</span>}</td><td className="max-w-[190px] px-4 py-3 text-[10px] text-muted-foreground">{trade.setupType}</td><td className="px-4 py-3 font-bold uppercase">{trade.direction}</td><td className="mono px-4 py-3">{trade.entryPrice.toFixed(2)} → {trade.exitPrice?.toFixed(2) ?? "OPEN"}<span className="block text-[10px] text-muted-foreground">entry buffer {trade.audit?.entryTriggerPrice?.toFixed(2) ?? "—"} · strategy {trade.audit?.strategyStopPrice?.toFixed(2) ?? "—"} · catastrophe {trade.audit?.catastropheStopPrice?.toFixed(2) ?? "—"} · target {trade.audit?.targetPrice?.toFixed(2) ?? "—"}</span>{trade.executionMode === "ohlcv_modeled" && <span className="block text-[10px] text-foreground">Fill observed within entry candle: {trade.audit?.modeledFillObservationTime ?? "—"}</span>}</td><td className={`mono px-4 py-3 ${trade.netPnl >= 0 ? "status-positive" : "status-negative"}`}>{money(trade.netPnl)}<span className="ml-2 text-[10px] text-muted-foreground">{trade.outcome}</span></td><td className="mono px-4 py-3 text-muted-foreground">{money(trade.fees + trade.slippage)}</td><td className="px-4 py-3 text-[10px] text-muted-foreground">{trade.fillLabel ?? trade.source}{trade.audit?.stopLevel && <span className="ml-2">{trade.audit.stopLevel} stop</span>}{trade.audit?.runnerExited && <span className="ml-2">runner exit</span>}{trade.audit?.exitReason === "session_close" && <span className="ml-2">session close</span>}{trade.audit?.eventLabels.length ? <span className="ml-2">events: {trade.audit.eventLabels.join(", ")}</span> : null}{trade.ambiguityLabel && <span className="ml-2 text-destructive">{trade.ambiguityLabel}</span>}</td></tr>)}</tbody></table></div> : <div className="border-t border-border p-8 text-center text-sm text-muted-foreground">No simulated fills. Confirmed signals create trades even when exits remain open.</div>}
    </Panel>

     <Panel>
        <PanelTitle eyebrow="Causal setup audit" title="Detected, rejected, and ambiguous evaluations" right={<span className="mono text-[10px] text-muted-foreground">{auditTotal.toLocaleString()} records</span>} />
       <div className="grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-4">
         {[
            ["Audited evaluations", auditTotal],
           ["Rejected evaluations", rejectedAuditRows.length],
            ["Ambiguous entries", ambiguousAuditRows.filter((item) => item.rejectionReason === "AMBIGUOUS_ENTRY_INVALIDATION").length],
           ["Ambiguous exits", ambiguousAuditRows.length],
         ].map(([label, value]) => <div key={label} className="px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
       </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <label className="text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">Audit filter
            <select value={auditFilter} onChange={(event) => { setAuditFilter(event.target.value as typeof auditFilter); setAuditPage(1); }} className="field ml-2 py-1 text-xs" data-testid="select-audit-filter">
              <option value="all">All evaluations</option><option value="AMBIGUITY">Ambiguous</option><option value="FAILURE">Failures</option><option value="WAITING">Waiting</option><option value="EXPIRED">Expired</option><option value="RISK_REJECTION">Risk rejected</option><option value="POSITION_ACTIVE">Position active</option>
            </select>
          </label>
          <label className="text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">Trading date
            <input type="date" value={auditDate} onChange={(event) => { setAuditDate(event.target.value); setAuditPage(1); }} className="field ml-2 py-1 text-xs" data-testid="input-audit-date" />
          </label>
          <span className="text-[10px] text-muted-foreground">Page {auditPage} · 50 rows max · server-filtered</span>
          <div className="ml-auto flex gap-2">
            <button type="button" disabled={auditPage <= 1 || auditQuery.isFetching} onClick={() => setAuditPage((page) => Math.max(1, page - 1))} className="rounded-sm border border-border px-2 py-1 text-[10px] disabled:opacity-40">Previous</button>
            <button type="button" disabled={!auditQuery.data?.hasMore || auditQuery.isFetching} onClick={() => setAuditPage((page) => page + 1)} className="rounded-sm border border-border px-2 py-1 text-[10px] disabled:opacity-40">Next</button>
          </div>
        </div>
        {auditQuery.isError ? <div className="border-t border-border p-6 text-sm text-destructive">This audit page could not be loaded. The run may have expired.</div> : rejectedAuditRows.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Trading date / observation (UTC)</th><th className="px-4 py-3">Setup / decision</th><th className="px-4 py-3">Patience</th><th className="px-4 py-3">Stops / target</th><th className="px-4 py-3">Reason</th></tr></thead><tbody className="divide-y divide-border">{rejectedAuditRows.map((item) => <tr key={item.id}><td className="mono px-4 py-3">{item.tradingDate}<span className="block text-[10px] text-muted-foreground">candle {item.evaluatedCandleOpenTime}</span>{item.modeledFillObservationTime && <span className="block text-[10px] text-muted-foreground">modeled fill {item.modeledFillObservationTime}</span>}</td><td className="px-4 py-3">{item.setupType}<span className="block text-[10px] text-muted-foreground">{item.decision}</span></td><td className="px-4 py-3 text-[10px] text-muted-foreground">{item.patienceState}</td><td className="mono px-4 py-3 text-[10px] text-muted-foreground">{item.strategyStopPrice ?? "—"} / {item.catastropheStopPrice ?? "—"} / {item.targetPrice ?? "—"}</td><td className="max-w-[360px] px-4 py-3 text-[10px] text-muted-foreground"><strong className="text-foreground">{item.rejectionCategory}</strong> · {item.rejectionSummary ?? item.rejectionReason}</td></tr>)}</tbody></table></div> : <div className="border-t border-border p-6 text-sm text-muted-foreground">No rejected evaluations were recorded on this page.</div>}
       <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Classified missing total = unexpected missing + expected closed + inactive contract. Expected closed = maintenance/daily close + weekend/holiday + early close. Unexpected missing = unexpected regular + unexpected overnight. Inactive threshold: <strong className="text-foreground">{report.gapReport.inactiveContractThresholdPercent}% of expected RTH minutes</strong>.</div>
     </Panel>
     </div>

    <Panel>
      <PanelTitle eyebrow="Method / audit trail" title="Replay assumptions" right={<Database size={16} className="text-muted-foreground" />} />
      <div className="grid gap-3 border-t border-border p-5 sm:grid-cols-2">{report.assumptions.map((assumption) => <div key={assumption} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" />{assumption}</div>)}</div>
    </Panel>
  </div>;
}

export default function Backtest() {
  const [symbol, setSymbol] = useState("MES");
  const [source, setSource] = useState<"historical_databento" | typeof MULTI_CONTRACT_SOURCE | "simulated">(MULTI_CONTRACT_SOURCE);
  const [startDate, setStartDate] = useState("2026-07-27");
  const [endDate, setEndDate] = useState("2026-08-26");
  const [inSampleDays, setInSampleDays] = useState("5");
  const [outOfSampleDays, setOutOfSampleDays] = useState("2");
  const [seed, setSeed] = useState("11");
  const [targetDollars, setTargetDollars] = useState("75");
  const [slippageMode, setSlippageMode] = useState<"normal" | "fast" | "abnormal_spread">("normal");
  const [executionMode, setExecutionMode] = useState<"quote_based_shadow" | "ohlcv_modeled">("ohlcv_modeled");
  const [entryBufferTicks, setEntryBufferTicks] = useState("4");
  const [stopBufferTicks, setStopBufferTicks] = useState("1");
  const [ohlcvSlippageTicks, setOhlcvSlippageTicks] = useState("1");
  const [commissionPerContract, setCommissionPerContract] = useState("");
  const [selectedEmaTimestamps, setSelectedEmaTimestamps] = useState<string[]>([]);
  const run = useRunBacktest();
  const startBatch = useStartBatchBacktest();
  const cancelBatch = useCancelBatchBacktest();
  const [batchId, setBatchId] = useState<string | null>(null);
  const historicalImport = useGetHistoricalData({
    symbol: "MES",
    source: source === "simulated" ? "historical_databento" : source,
  });
  const emaComparison = useGetHistoricalEmaComparison({
    source: source === "historical_databento" ? "historical_databento" : MULTI_CONTRACT_SOURCE,
    ...(selectedEmaTimestamps.length ? { timestamps: selectedEmaTimestamps.join(",") } : {}),
  }, {
    query: {
      enabled: source !== "simulated",
      queryKey: ["historical-ema-comparison", source, selectedEmaTimestamps.join(",")],
    },
  });
  useEffect(() => {
    const defaults = emaComparison.data?.candidates.slice(-3).map((candidate) => candidate.timestamp) ?? [];
    if (!selectedEmaTimestamps.length && defaults.length === 3) setSelectedEmaTimestamps(defaults);
  }, [emaComparison.data?.candidates, selectedEmaTimestamps.length]);
  const multiContractIndex = useGetHistoricalDataIndexStatus({
    query: {
      enabled: source === MULTI_CONTRACT_SOURCE,
      queryKey: ["historical-data-index-status"],
      refetchInterval: (query) => {
        const state = query.state.data?.state;
        return state === "indexing" || state === "not_started" ? 1200 : false;
      },
    },
  });
  const batchStatus = useGetBatchBacktestStatus(
    { batchId: batchId ?? "00000000-0000-0000-0000-000000000000" },
    {
      query: {
        enabled: Boolean(batchId),
        queryKey: ["batch-status", batchId],
        refetchInterval: (query) => {
          const status = query.state.data?.status;
          return status === "queued" || status === "running" ? 1200 : false;
        },
      },
    },
  );

  const parsedInSampleDays = Number(inSampleDays);
  const parsedOutOfSampleDays = Number(outOfSampleDays);
  const sessionLimits = getBacktestSessionLimits(parsedInSampleDays, parsedOutOfSampleDays);

  const request = {
    symbol,
    source,
    startDate,
    endDate,
    inSampleDays: parsedInSampleDays,
    outOfSampleDays: parsedOutOfSampleDays,
    seed: Number(seed),
    premarketAvailable: true,
    targetDollars: Number(targetDollars),
    slippageMode,
    executionMode,
    ohlcvEntryBufferTicks: 8,
    ohlcvStopBufferTicks: Number(stopBufferTicks),
    ohlcvSlippageTicks: Number(ohlcvSlippageTicks),
    ...(commissionPerContract.trim() ? { ohlcvCommissionPerContract: Number(commissionPerContract) } : {}),
  } as const;

  const availableBatchDates = useMemo(() => {
    const dates = historicalImport.data?.eligibleTradingDates ?? historicalImport.data?.availableTradingDates ?? [];
    return dates.filter((date) => date >= startDate && date <= endDate).sort();
  }, [endDate, historicalImport.data?.availableTradingDates, historicalImport.data?.eligibleTradingDates, startDate]);
  const batchRequest = {
    ...request,
    ...(availableBatchDates.length >= 2 ? { selectedDates: availableBatchDates } : {}),
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run.mutate({ data: request });
  };
  const submitBatch = () => {
    setBatchId(null);
    startBatch.mutate({ data: batchRequest }, {
      onSuccess: (response) => setBatchId(response.batchId),
    });
  };
  const batchReport = batchStatus.data?.report ?? null;
  const batchActive = batchStatus.data?.status === "queued" || batchStatus.data?.status === "running";
  const historicalReadiness = getHistoricalBacktestReadiness(source, {
    indexState: multiContractIndex.data?.state,
    importLoading: historicalImport.isLoading,
    hasImport: Boolean(historicalImport.data),
  });
  const historicalReady = historicalReadiness.ready;
  const canSubmitSingleRun = historicalReady && !sessionLimits.error && !run.isPending && !startBatch.isPending && !batchActive;
  const historicalIndexMessage = multiContractIndex.data?.message
    ?? (multiContractIndex.isLoading ? "Checking historical MES index…" : null);

  return <LevelStoryShell>
    <div className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
      <div className="mx-auto max-w-[1500px]">
        <PageIntro eyebrow="Research room / causal only" title="Replay the tape honestly." description="Run the existing futures rules through a sequential historical cursor. Tick data wins when available; one-minute fallback stays conservative. Nothing here can place an order." action={<ShadowBadge />} />
         {source !== "simulated" && <div className="mb-5 space-y-5"><HistoricalImportResults data={historicalImport.data} isLoading={historicalImport.isLoading || (source === MULTI_CONTRACT_SOURCE && multiContractIndex.data?.state === "indexing")} isError={historicalImport.isError || multiContractIndex.data?.state === "failed"} /><HistoricalEmaComparisonPanel report={emaComparison.data} isLoading={emaComparison.isLoading || emaComparison.isFetching} isError={emaComparison.isError} selectedTimestamps={selectedEmaTimestamps} onToggle={(timestamp) => setSelectedEmaTimestamps((current) => current.includes(timestamp) ? current.filter((item) => item !== timestamp) : current.length < 3 ? [...current, timestamp] : current)} /></div>}
         {source === MULTI_CONTRACT_SOURCE && <Panel className="mb-5" data-testid="panel-historical-index-status"><div className="flex flex-wrap items-center justify-between gap-3 p-4 text-xs"><div><div className="eyebrow text-muted-foreground">Historical index lifecycle</div><div className="mt-1 font-semibold">{historicalIndexMessage ?? "Index ready"}</div>{multiContractIndex.data?.error && <div className="mt-1 text-destructive">{multiContractIndex.data.error}</div>}</div><div className="mono text-muted-foreground">{multiContractIndex.data?.state ?? "not_started"} · {multiContractIndex.data?.indexedFileCount ?? 0}/{multiContractIndex.data?.discoveredFileCount ?? 0} files · {multiContractIndex.data?.progress ?? 0}%</div><button type="button" onClick={() => { void multiContractIndex.refetch(); void historicalImport.refetch(); }} className="inline-flex items-center gap-2 border border-border px-3 py-2 text-[10px] font-bold uppercase" data-testid="button-refresh-historical-index"><RefreshCw size={12} />Refresh</button></div></Panel>}
        <Panel className="mb-5" accent>
          <PanelTitle eyebrow="Configure a deterministic run" title="Backtest controls" right={<span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><LockKeyhole size={12} /> Thresholds locked</span>} />
          <form onSubmit={submit} className="grid gap-4 border-t border-border p-5 sm:grid-cols-2 lg:grid-cols-4">
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Data source</span><select value={source} onChange={(event) => { const next = event.target.value as typeof source; setSource(next); setExecutionMode(next === "simulated" ? "quote_based_shadow" : "ohlcv_modeled"); if (next !== "simulated") setSymbol("MES"); }} className="field w-full" data-testid="select-backtest-source"><option value={MULTI_CONTRACT_SOURCE}>Historical Databento — MES quarterly contracts</option><option value="historical_databento">Historical Databento CSV — MESU6</option><option value="simulated">Simulated demo</option></select></label>
              <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Execution mode</span><select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as typeof executionMode)} className="field w-full" data-testid="select-backtest-execution-mode"><option value="ohlcv_modeled" disabled={source === "simulated"}>Modeled OHLCV fill</option><option value="quote_based_shadow" disabled={source !== "simulated"}>Quote-based Shadow fill</option></select></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Contract</span><select value={symbol} onChange={(event) => setSymbol(event.target.value)} className="field w-full" data-testid="select-backtest-symbol">{symbols.map((item) => <option key={item} value={item} disabled={source !== "simulated" && item !== "MES"}>{item}</option>)}</select></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Start date</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="field mono w-full" data-testid="input-backtest-start-date" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">End date</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="field mono w-full" data-testid="input-backtest-end-date" /></label>
           <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">In-sample days</span><input type="number" min="1" max={sessionLimits.maxInSampleDays} value={inSampleDays} onChange={(event) => setInSampleDays(event.target.value)} aria-invalid={Boolean(sessionLimits.error && (!Number.isInteger(parsedInSampleDays) || parsedInSampleDays > sessionLimits.maxInSampleDays))} className="field mono w-full" data-testid="input-backtest-in-sample" /></label>
           <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Holdout days</span><input type="number" min="1" max={sessionLimits.maxOutOfSampleDays} value={outOfSampleDays} onChange={(event) => setOutOfSampleDays(event.target.value)} aria-invalid={Boolean(sessionLimits.error && (!Number.isInteger(parsedOutOfSampleDays) || parsedOutOfSampleDays > sessionLimits.maxOutOfSampleDays))} className="field mono w-full" data-testid="input-backtest-out-of-sample" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Seed</span><input type="number" min="1" max="100000" value={seed} onChange={(event) => setSeed(event.target.value)} className="field mono w-full" data-testid="input-backtest-seed" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Target</span><select value={targetDollars} onChange={(event) => setTargetDollars(event.target.value)} className="field w-full" data-testid="select-backtest-target"><option value="50">$50</option><option value="75">$75</option><option value="100">$100</option></select></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Slippage regime</span><select value={slippageMode} onChange={(event) => setSlippageMode(event.target.value as typeof slippageMode)} className="field w-full" data-testid="select-backtest-slippage"><option value="normal">Normal</option><option value="fast">Fast tape</option><option value="abnormal_spread">Abnormal spread</option></select></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">OHLCV entry buffer</span><select value="8" onChange={() => setEntryBufferTicks("8")} className="field w-full" data-testid="select-ohlcv-entry-buffer"><option value="8">8 MES ticks · 2.00 points</option></select></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Patience stop buffer</span><input type="number" min="1" max="8" value={stopBufferTicks} onChange={(event) => setStopBufferTicks(event.target.value)} className="field mono w-full" data-testid="input-ohlcv-stop-buffer" /></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Modeled slippage</span><input type="number" min="0" max="8" value={ohlcvSlippageTicks} onChange={(event) => setOhlcvSlippageTicks(event.target.value)} className="field mono w-full" data-testid="input-ohlcv-slippage" /></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Round-trip fee override</span><input type="number" min="0" step="0.01" placeholder="contract default" value={commissionPerContract} onChange={(event) => setCommissionPerContract(event.target.value)} className="field mono w-full" data-testid="input-ohlcv-fee" /></label>
             <div className="flex flex-col items-end gap-2 sm:col-span-2 lg:col-span-2 lg:flex-row">
                <button type="submit" disabled={!canSubmitSingleRun} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-sm bg-primary px-4 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50" data-testid="button-run-backtest"><Play size={14} className={run.isPending ? "animate-pulse" : ""} />{run.isPending ? "Replaying..." : !historicalReady ? "Waiting for history…" : "Run causal backtest"}</button>
                <button type="button" onClick={submitBatch} disabled={!historicalReady || sessionLimits.error !== null || startBatch.isPending || batchActive || availableBatchDates.length < 2} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-sm border border-accent bg-accent/10 px-4 text-xs font-bold text-foreground transition-colors hover:bg-accent/20 disabled:opacity-50" data-testid="button-run-batch"><BarChart3 size={14} className={startBatch.isPending ? "animate-pulse" : ""} />{startBatch.isPending ? "Queueing batch…" : availableBatchDates.length < 2 ? "Need 2 eligible sessions" : `Run ${availableBatchDates.length}-session funnel`}</button>
             </div>
             <div className="sm:col-span-2 lg:col-span-4" aria-live="polite">
               <div className={`text-[11px] ${sessionLimits.error ? "text-destructive" : "text-muted-foreground"}`} data-testid="backtest-session-limit">
                 {sessionLimits.error ?? `Single-run sessions requested: ${Number.isFinite(sessionLimits.requested) ? sessionLimits.requested : "—"} / ${MAX_BACKTEST_SESSIONS}. Remaining capacity: ${Number.isFinite(sessionLimits.requested) ? sessionLimits.remaining : "—"}.`}
               </div>
               <div className="mt-1 text-[11px] text-muted-foreground">The qualification batch is separate and may include up to {availableBatchDates.length ? Math.min(availableBatchDates.length, 60) : 60} selected eligible dates (batch ceiling: 60); it does not use the single-run {MAX_BACKTEST_SESSIONS}-session validation ceiling.</div>
             </div>
          </form>
             <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">The final {outOfSampleDays || "—"} trading days are held out and never used for threshold selection. Historical runs use completed candles only, with an immediate-next-candle trigger and adverse-first OHLCV barriers. Contract economics remain month-specific. Eligible scheduled dates in this window: <strong className="text-foreground">{availableBatchDates.length}</strong>.</div>
        </Panel>

        {run.isPending && <Panel><div className="p-8 text-center text-sm text-muted-foreground" data-testid="status-backtest-loading">Backtest running. Historical runs may take approximately one minute on the current compute plan. Repeated identical runs use the cached result.</div></Panel>}
        {run.isError && <Panel><QueryError onRetry={() => run.mutate({ data: request })} message="The causal backtest could not be completed." /></Panel>}
         {startBatch.isError && <Panel><QueryError onRetry={submitBatch} message="The qualification batch could not be started." /></Panel>}
         {batchStatus.isError && <Panel><QueryError onRetry={() => batchStatus.refetch()} message="The batch status could not be loaded." /></Panel>}
         {batchStatus.data && <Panel accent>
           <PanelTitle eyebrow="Phase 11B / batch status" title={batchActive ? "Qualification funnel in progress" : batchStatus.data.status === "completed" ? "Qualification funnel complete" : "Qualification funnel stopped"} right={<span className="mono text-[10px] text-muted-foreground">{batchStatus.data.completedPartitions}/{batchStatus.data.totalPartitions} partitions</span>} />
           <div className="border-t border-border p-5">
             <div className="flex flex-wrap items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">{batchStatus.data.message}</span><span className="mono text-[10px] text-muted-foreground">{batchStatus.data.currentTradingDate ? `${batchStatus.data.currentTradingDate} · ${batchStatus.data.currentContractSymbol ?? "contract pending"}` : "no active partition"}</span></div>
             <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${batchStatus.data.totalPartitions ? (batchStatus.data.completedPartitions / batchStatus.data.totalPartitions) * 100 : 0}%` }} /></div>
             {batchActive && <button type="button" onClick={() => cancelBatch.mutate({ params: { batchId: batchId! } })} disabled={cancelBatch.isPending} className="mt-4 inline-flex items-center gap-2 border border-destructive/40 px-3 py-2 text-xs font-bold text-destructive disabled:opacity-50" data-testid="button-cancel-batch"><Square size={12} />{cancelBatch.isPending ? "Cancelling…" : "Cancel batch"}</button>}
             {(batchStatus.data.status === "cancelled" || batchStatus.data.status === "failed" || batchStatus.data.status === "timed_out") && <div className="mt-4 flex items-center gap-2 text-xs text-destructive"><RefreshCw size={13} />No partial result was persisted. Start a new batch after adjusting the window or source.</div>}
           </div>
         </Panel>}
         {batchReport && batchId && <><WalkForwardPanel report={batchReport} /><BatchFunnelPanel report={batchReport} batchId={batchId} /></>}
         {run.data && <ReportBody report={run.data} fullCoverage={source === "simulated" ? undefined : historicalImport.data} />}
         {!run.isPending && !run.isError && !run.data && !batchReport && !batchActive && <Panel><div className="flex flex-col items-center gap-3 p-12 text-center"><ShieldCheck size={28} className="text-accent" /><h2 className="text-sm font-bold">Ready for a clean replay</h2><p className="max-w-md text-xs leading-5 text-muted-foreground">Choose the evaluation window, then run the locked strategy. Results will show why setups qualified, rejected, or became ambiguous.</p></div></Panel>}
        <LockedNote>Phase 9 is a research surface only. It has no broker connection, no position state, and no live or paper order path.</LockedNote>
      </div>
    </div>
  </LevelStoryShell>;
}