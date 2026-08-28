import { useState, type FormEvent } from "react";
import { useGetBacktestAuditPage, useGetHistoricalData, useRunBacktest } from "@workspace/api-client-react";
import type { BacktestAuditRecord, BacktestMetricSet, BacktestReport, HistoricalImportSummary } from "@workspace/api-client-react";
import { BarChart3, Check, Database, FileCheck2, LockKeyhole, Play, ShieldCheck } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, Panel, PanelTitle, PageIntro, QueryError, ShadowBadge } from "@/components/levelstory-ui";

const symbols = ["MES", "ES", "MNQ", "NQ"];

function HistoricalImportResults({ data, isLoading, isError }: { data?: HistoricalImportSummary; isLoading: boolean; isError: boolean }) {
  if (isLoading) return <Panel><div className="p-6 text-center text-xs text-muted-foreground">Streaming the uploaded Databento CSV and validating each row…</div></Panel>;
  if (isError || !data) return <Panel><div className="p-6 text-xs text-destructive">The uploaded MESU6 CSV could not be imported. Check the server-side file path and try again.</div></Panel>;
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
  return <Panel accent data-testid="panel-historical-import-results">
    <PanelTitle eyebrow="File import / validation" title="Historical Databento Data — MESU6 — Shadow Mode" right={<FileCheck2 size={16} className="text-accent" />} />
    <div className="border-t border-border px-5 py-4 text-xs">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground"><span>File <strong className="text-foreground">{data.filename}</strong></span><span>Symbol <strong className="mono text-foreground">{data.detectedSymbol ?? "—"}</strong></span></div>
      <div className="mt-2 text-muted-foreground">UTC range <strong className="mono text-foreground">{data.earliestTimestamp ?? "—"} → {data.latestTimestamp ?? "—"}</strong></div>
    </div>
    <div className="grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-3">
      {stats.map(([label, value]) => <div key={label} className="px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
    </div>
     <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground">
       <p className="mb-2 text-foreground">Full-file coverage includes dates before MESU6 became active; it is not the selected backtest window.</p>
       <p>Expected closed = maintenance/daily close + weekend/holiday + early-close minutes. Unexpected missing = unexpected regular + unexpected overnight minutes. Inactive contract minutes are excluded from unexpected data loss when RTH coverage is below the configured threshold.</p>
      <div className="eyebrow mb-2">Aggregated bars</div>
      <div className="flex flex-wrap gap-x-5 gap-y-2"><span>1m <strong className="mono text-foreground">{data.aggregationCounts.oneMinute.toLocaleString()}</strong></span><span>5m <strong className="mono text-foreground">{data.aggregationCounts.fiveMinute.toLocaleString()}</strong></span><span>15m <strong className="mono text-foreground">{data.aggregationCounts.fifteenMinute.toLocaleString()}</strong></span><span>1h <strong className="mono text-foreground">{data.aggregationCounts.oneHour.toLocaleString()}</strong></span></div>
      <div className="mt-3">Available NY trading dates: <strong className="text-foreground">{data.availableTradingDates.length}</strong> ({data.availableTradingDates[0] ?? "—"} → {data.availableTradingDates.at(-1) ?? "—"})</div>
    </div>
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
  ];
  return <div className={`grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-4 sm:divide-y-0 ${accent ? "bg-accent/5" : ""}`}>
    {items.map(([label, value]) => <div key={label} className="px-4 py-4 sm:px-5">
      <div className="eyebrow text-muted-foreground">{label}</div>
      <div className={`mono mt-2 text-lg font-medium ${label === "Net P&L" || label === "Expectancy" ? (metrics.netPnl >= 0 ? "status-positive" : "status-negative") : ""}`}>{value}</div>
    </div>)}
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
       <div className="border-t border-border px-5 py-3 text-xs"><strong>{report.dataSource === "historical_databento" ? "Historical Databento Data — MESU6" : "Simulated demo data"} — {report.executionMode === "ohlcv_modeled" ? "Modeled OHLCV execution" : "Shadow Mode"}</strong><span className="ml-2 text-muted-foreground">{report.fillLabel}</span></div>
       <div className="grid gap-px border-t border-border bg-border sm:grid-cols-6">
        {[
          ["Dataset", `${report.dataset.startDate} → ${report.dataset.endDate}`],
           ["Requested range", `${report.dataset.requestedStartDate} → ${report.dataset.requestedEndDate}`],
           ["Selected dates", `${report.dataset.selectedDates.length} exact sessions`],
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
           <span>Selected <strong className="mono text-foreground">{report.dataset.selectedDates.join(", ") || "—"}</strong></span>
           <span>Excluded <strong className="mono text-foreground">{report.dataset.excludedDates.join(", ") || "none"}</strong></span>
         </div>
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
      <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Immediate-next-candle-only: <strong className="text-foreground">{report.executionPolicy.immediateNextCandleOnly ? "yes" : "no"}</strong> · Fee assumption: <strong className="mono text-foreground">${report.executionPolicy.commissionPerContract.toFixed(2)} / contract round trip</strong></div>
    </Panel>

     <div className="grid gap-5 lg:grid-cols-2">
     {fullCoverage && <Panel>
       <PanelTitle eyebrow="Data quality / full file" title="Uploaded-file coverage" right={<span className="mono text-[10px] text-muted-foreground">all dates</span>} />
       <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground">Includes dates before MESU6 became active. Sparse contract dates are classified using the inactivity threshold, not as generic vendor-data failures.</div>
       <div className="grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-3">
         {[
           ["Valid rows", fullCoverage.validRows.toLocaleString()],
           ["Available dates", String(fullCoverage.availableTradingDates.length)],
           ["Raw missing", `${fullCoverage.missingMinuteGaps.toLocaleString()} min`],
           ["Unexpected", `${fullCoverage.unexpectedMissingMinutes.toLocaleString()} min`],
           ["Expected closed", `${fullCoverage.expectedClosedMinutes.toLocaleString()} min`],
           ["Inactive", `${fullCoverage.inactiveContractMinutes.toLocaleString()} min`],
         ].map(([label, value]) => <div key={label} className="px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
       </div>
       <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Inactive threshold: <strong className="text-foreground">{fullCoverage.inactiveContractThresholdPercent}% of expected RTH minutes</strong>.</div>
     </Panel>}
     <Panel>
       <PanelTitle eyebrow="Data quality / selected backtest" title="Missing-minute accounting" right={<span className="mono text-[10px] text-muted-foreground">{report.gapReport.missingGapSegments.toLocaleString()} raw segments</span>} />
       <div className="grid grid-cols-2 divide-x divide-y border-t border-border sm:grid-cols-7">
        {[
          ["All missing", `${report.gapReport.missingMinuteGaps.toLocaleString()} min`],
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
           ["Coverage scope", report.gapReport.coverageScope === "selected_dates" ? "Selected dates" : "Full file"],
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
        <span>Entry triggers: <strong className="mono text-foreground">{report.metrics.entryTriggers}</strong></span>
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
       {report.trades.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[1120px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Date / period</th><th className="px-4 py-3">Setup</th><th className="px-4 py-3">Side</th><th className="px-4 py-3">Entry → exit</th><th className="px-4 py-3">Result</th><th className="px-4 py-3">Costs</th><th className="px-4 py-3">Mode / audit</th></tr></thead><tbody className="divide-y divide-border">{report.trades.map((trade) => <tr key={trade.id}><td className="px-4 py-3"><span className="block">{trade.tradingDate}</span><span className="text-[10px] text-muted-foreground">{trade.period === "out_of_sample" ? "HOLDOUT" : "IN-SAMPLE"}</span><span className="mono block text-[10px] text-muted-foreground">entry event {trade.entryTime} · exit event {trade.exitTime} UTC</span>{trade.audit && <span className="mono mt-1 block text-[10px] text-muted-foreground">patience {trade.audit.patienceCandleOpenTime ?? "—"} → {trade.audit.patienceCandleCloseTime ?? "—"} · trigger {trade.audit.triggerCandleOpenTime ?? "—"} → {trade.audit.triggerCandleCloseTime ?? "—"} · exit candle {trade.audit.exitCandleOpenTime ?? "—"} → {trade.audit.exitCandleCloseTime ?? "—"}</span>}</td><td className="max-w-[190px] px-4 py-3 text-[10px] text-muted-foreground">{trade.setupType}</td><td className="px-4 py-3 font-bold uppercase">{trade.direction}</td><td className="mono px-4 py-3">{trade.entryPrice.toFixed(2)} → {trade.exitPrice.toFixed(2)}<span className="block text-[10px] text-muted-foreground">trigger {trade.audit?.entryTriggerPrice?.toFixed(2) ?? "—"} · strategy {trade.audit?.strategyStopPrice?.toFixed(2) ?? "—"} · catastrophe {trade.audit?.catastropheStopPrice?.toFixed(2) ?? "—"} · target {trade.audit?.targetPrice?.toFixed(2) ?? "—"}</span>{trade.executionMode === "ohlcv_modeled" && <span className="block text-[10px] text-foreground">Fill observed within trigger candle: {trade.audit?.modeledFillObservationTime ?? "—"}</span>}</td><td className={`mono px-4 py-3 ${trade.netPnl >= 0 ? "status-positive" : "status-negative"}`}>{money(trade.netPnl)}<span className="ml-2 text-[10px] text-muted-foreground">{trade.outcome}</span></td><td className="mono px-4 py-3 text-muted-foreground">{money(trade.fees + trade.slippage)}</td><td className="px-4 py-3 text-[10px] text-muted-foreground">{trade.fillLabel ?? trade.source}{trade.audit?.stopLevel && <span className="ml-2">{trade.audit.stopLevel} stop</span>}{trade.audit?.runnerExited && <span className="ml-2">runner exit</span>}{trade.audit?.exitReason === "session_close" && <span className="ml-2">session close</span>}{trade.audit?.eventLabels.length ? <span className="ml-2">events: {trade.audit.eventLabels.join(", ")}</span> : null}{trade.ambiguityLabel && <span className="ml-2 text-destructive">{trade.ambiguityLabel}</span>}</td></tr>)}</tbody></table></div> : <div className="border-t border-border p-8 text-center text-sm text-muted-foreground">No simulated fills. Every setup remains a rejection until all existing rules and risk gates pass.</div>}
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
       <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Expected closed = maintenance/daily close + weekend/holiday + early close. Unexpected missing = unexpected regular + unexpected overnight. Inactive threshold: <strong className="text-foreground">{report.gapReport.inactiveContractThresholdPercent}% of expected RTH minutes</strong>.</div>
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
  const [source, setSource] = useState<"historical_databento" | "simulated">("historical_databento");
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
  const run = useRunBacktest();
  const historicalImport = useGetHistoricalData({ symbol: "MES" });

  const request = {
    symbol,
    source,
    startDate,
    endDate,
    inSampleDays: Number(inSampleDays),
    outOfSampleDays: Number(outOfSampleDays),
    seed: Number(seed),
    premarketAvailable: true,
    targetDollars: Number(targetDollars),
    slippageMode,
    executionMode,
    ohlcvEntryBufferTicks: Number(entryBufferTicks) as 3 | 4,
    ohlcvStopBufferTicks: Number(stopBufferTicks),
    ohlcvSlippageTicks: Number(ohlcvSlippageTicks),
    ...(commissionPerContract.trim() ? { ohlcvCommissionPerContract: Number(commissionPerContract) } : {}),
  } as const;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run.mutate({ data: request });
  };

  return <LevelStoryShell>
    <div className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
      <div className="mx-auto max-w-[1500px]">
        <PageIntro eyebrow="Research room / causal only" title="Replay the tape honestly." description="Run the existing futures rules through a sequential historical cursor. Tick data wins when available; one-minute fallback stays conservative. Nothing here can place an order." action={<ShadowBadge />} />
        {source === "historical_databento" && <div className="mb-5"><HistoricalImportResults data={historicalImport.data} isLoading={historicalImport.isLoading} isError={historicalImport.isError} /></div>}
        <Panel className="mb-5" accent>
          <PanelTitle eyebrow="Configure a deterministic run" title="Backtest controls" right={<span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><LockKeyhole size={12} /> Thresholds locked</span>} />
          <form onSubmit={submit} className="grid gap-4 border-t border-border p-5 sm:grid-cols-2 lg:grid-cols-4">
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Data source</span><select value={source} onChange={(event) => { const next = event.target.value as typeof source; setSource(next); setExecutionMode(next === "historical_databento" ? "ohlcv_modeled" : "quote_based_shadow"); if (next === "historical_databento") setSymbol("MES"); }} className="field w-full" data-testid="select-backtest-source"><option value="historical_databento">Historical Databento CSV</option><option value="simulated">Simulated demo</option></select></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Execution mode</span><select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as typeof executionMode)} className="field w-full" data-testid="select-backtest-execution-mode"><option value="ohlcv_modeled" disabled={source !== "historical_databento"}>Modeled OHLCV fill</option><option value="quote_based_shadow" disabled={source === "historical_databento"}>Quote-based Shadow fill</option></select></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Contract</span><select value={symbol} onChange={(event) => setSymbol(event.target.value)} className="field w-full" data-testid="select-backtest-symbol">{symbols.map((item) => <option key={item} disabled={source === "historical_databento" && item !== "MES"}>{item}</option>)}</select></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Start date</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="field mono w-full" data-testid="input-backtest-start-date" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">End date</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="field mono w-full" data-testid="input-backtest-end-date" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">In-sample days</span><input type="number" min="1" max="30" value={inSampleDays} onChange={(event) => setInSampleDays(event.target.value)} className="field mono w-full" data-testid="input-backtest-in-sample" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Holdout days</span><input type="number" min="1" max="10" value={outOfSampleDays} onChange={(event) => setOutOfSampleDays(event.target.value)} className="field mono w-full" data-testid="input-backtest-out-of-sample" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Seed</span><input type="number" min="1" max="100000" value={seed} onChange={(event) => setSeed(event.target.value)} className="field mono w-full" data-testid="input-backtest-seed" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Target</span><select value={targetDollars} onChange={(event) => setTargetDollars(event.target.value)} className="field w-full" data-testid="select-backtest-target"><option value="50">$50</option><option value="75">$75</option><option value="100">$100</option></select></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Slippage regime</span><select value={slippageMode} onChange={(event) => setSlippageMode(event.target.value as typeof slippageMode)} className="field w-full" data-testid="select-backtest-slippage"><option value="normal">Normal</option><option value="fast">Fast tape</option><option value="abnormal_spread">Abnormal spread</option></select></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">OHLCV entry buffer</span><select value={entryBufferTicks} onChange={(event) => setEntryBufferTicks(event.target.value)} className="field w-full" data-testid="select-ohlcv-entry-buffer"><option value="3">3 ticks</option><option value="4">4 ticks</option></select></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Patience stop buffer</span><input type="number" min="1" max="8" value={stopBufferTicks} onChange={(event) => setStopBufferTicks(event.target.value)} className="field mono w-full" data-testid="input-ohlcv-stop-buffer" /></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Modeled slippage</span><input type="number" min="0" max="8" value={ohlcvSlippageTicks} onChange={(event) => setOhlcvSlippageTicks(event.target.value)} className="field mono w-full" data-testid="input-ohlcv-slippage" /></label>
             <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Round-trip fee override</span><input type="number" min="0" step="0.01" placeholder="contract default" value={commissionPerContract} onChange={(event) => setCommissionPerContract(event.target.value)} className="field mono w-full" data-testid="input-ohlcv-fee" /></label>
            <div className="flex items-end"><button type="submit" disabled={run.isPending} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-sm bg-primary px-4 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50" data-testid="button-run-backtest"><Play size={14} className={run.isPending ? "animate-pulse" : ""} />{run.isPending ? "Replaying..." : "Run causal backtest"}</button></div>
          </form>
           <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">The final {outOfSampleDays || "—"} trading days are held out and never used for threshold selection. Historical runs use completed candles only, with an immediate-next-candle trigger and adverse-first OHLCV barriers. Contract economics remain month-specific.</div>
        </Panel>

        {run.isPending && <Panel><div className="p-8 text-center text-sm text-muted-foreground" data-testid="status-backtest-loading">Walking the replay cursor through completed observations…</div></Panel>}
        {run.isError && <Panel><QueryError onRetry={() => run.mutate({ data: request })} message="The causal backtest could not be completed." /></Panel>}
        {run.data && <ReportBody report={run.data} fullCoverage={historicalImport.data} />}
        {!run.isPending && !run.isError && !run.data && <Panel><div className="flex flex-col items-center gap-3 p-12 text-center"><ShieldCheck size={28} className="text-accent" /><h2 className="text-sm font-bold">Ready for a clean replay</h2><p className="max-w-md text-xs leading-5 text-muted-foreground">Choose the evaluation window, then run the locked strategy. Results will show why setups qualified, rejected, or became ambiguous.</p></div></Panel>}
        <LockedNote>Phase 9 is a research surface only. It has no broker connection, no position state, and no live or paper order path.</LockedNote>
      </div>
    </div>
  </LevelStoryShell>;
}