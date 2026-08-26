import { useState, type FormEvent } from "react";
import { useRunBacktest } from "@workspace/api-client-react";
import type { BacktestMetricSet, BacktestReport } from "@workspace/api-client-react";
import { BarChart3, Check, Database, LockKeyhole, Play, ShieldCheck } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, Panel, PanelTitle, PageIntro, QueryError, ShadowBadge } from "@/components/levelstory-ui";

const symbols = ["MES", "ES", "MNQ", "NQ"];

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

function ReportBody({ report }: { report: BacktestReport }) {
  const segmentRows = report.segments.filter((segment) => segment.tradeCount > 0 || segment.rejectedSetupCount > 0).slice(0, 24);
  return <div className="space-y-5">
    <Panel accent>
      <PanelTitle eyebrow="Run integrity / causal replay" title={`${report.symbol} · ${report.contract.fullContractSymbol}`} right={<span className="mono text-[10px] text-muted-foreground">{report.dataResolution}</span>} />
      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-4">
        {[
          ["Dataset", `${report.dataset.startDate} → ${report.dataset.endDate}`],
          ["Visible candles", `${report.replay.visibleCandleCount} / ${report.replay.totalCandleCount}`],
          ["Holdout", `${report.dataset.outOfSampleDates.length} trading days`],
          ["Ambiguous trades", String(report.metrics.ambiguousTradeCount)],
        ].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-sm">{value}</div></div>)}
      </div>
      <div className="grid gap-3 border-t border-border p-5 text-xs sm:grid-cols-3">
        <div className="flex items-center gap-2 text-[hsl(var(--positive))]"><Check size={14} /> Causal cursor enforced</div>
        <div className="flex items-center gap-2 text-[hsl(var(--positive))]"><Check size={14} /> Future access blocked</div>
        <div className="flex items-center gap-2 text-[hsl(var(--positive))]"><Check size={14} /> Holdout untouched</div>
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
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Requested breakdowns" title="Where the evidence clusters" right={<BarChart3 size={16} className="text-muted-foreground" />} />
      {segmentRows.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Dimension</th><th className="px-4 py-3">Value</th><th className="px-4 py-3">Trades</th><th className="px-4 py-3">Win</th><th className="px-4 py-3">Expectancy</th><th className="px-4 py-3">Net</th><th className="px-4 py-3">Rejected</th></tr></thead><tbody className="divide-y divide-border">{segmentRows.map((segment) => <tr key={`${segment.dimension}-${segment.value}`}><td className="px-4 py-3 font-semibold">{segment.dimension}</td><td className="px-4 py-3 text-muted-foreground">{segment.value}</td><td className="mono px-4 py-3">{segment.tradeCount}</td><td className="mono px-4 py-3">{segment.winRate.toFixed(1)}%</td><td className="mono px-4 py-3">{money(segment.expectancy)}</td><td className={`mono px-4 py-3 ${segment.netPnl >= 0 ? "status-positive" : "status-negative"}`}>{money(segment.netPnl)}</td><td className="mono px-4 py-3 text-muted-foreground">{segment.rejectedSetupCount}</td></tr>)}</tbody></table></div> : <div className="border-t border-border p-8 text-center text-sm text-muted-foreground">No qualified trades were produced in this deterministic sample. Rejected setup counts remain visible above.</div>}
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Execution evidence" title="Trade ledger" right={<span className="mono text-[10px] text-muted-foreground">{report.trades.length} simulated fills</span>} />
      {report.trades.length ? <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[920px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Date / period</th><th className="px-4 py-3">Setup</th><th className="px-4 py-3">Side</th><th className="px-4 py-3">Entry → exit</th><th className="px-4 py-3">Result</th><th className="px-4 py-3">Costs</th><th className="px-4 py-3">Resolution</th></tr></thead><tbody className="divide-y divide-border">{report.trades.map((trade) => <tr key={trade.id}><td className="px-4 py-3"><span className="block">{trade.tradingDate}</span><span className="text-[10px] text-muted-foreground">{trade.period === "out_of_sample" ? "HOLDOUT" : "IN-SAMPLE"}</span></td><td className="max-w-[190px] px-4 py-3 text-[10px] text-muted-foreground">{trade.setupType}</td><td className="px-4 py-3 font-bold uppercase">{trade.direction}</td><td className="mono px-4 py-3">{trade.entryPrice.toFixed(2)} → {trade.exitPrice.toFixed(2)}</td><td className={`mono px-4 py-3 ${trade.netPnl >= 0 ? "status-positive" : "status-negative"}`}>{money(trade.netPnl)}<span className="ml-2 text-[10px] text-muted-foreground">{trade.outcome}</span></td><td className="mono px-4 py-3 text-muted-foreground">{money(trade.fees + trade.slippage)}</td><td className="px-4 py-3 text-[10px] text-muted-foreground">{trade.source}{trade.ambiguityLabel && <span className="ml-2 text-destructive">{trade.ambiguityLabel}</span>}</td></tr>)}</tbody></table></div> : <div className="border-t border-border p-8 text-center text-sm text-muted-foreground">No simulated fills. Every setup remains a rejection until all existing rules and risk gates pass.</div>}
    </Panel>

    <Panel>
      <PanelTitle eyebrow="Method / audit trail" title="Replay assumptions" right={<Database size={16} className="text-muted-foreground" />} />
      <div className="grid gap-3 border-t border-border p-5 sm:grid-cols-2">{report.assumptions.map((assumption) => <div key={assumption} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" />{assumption}</div>)}</div>
    </Panel>
  </div>;
}

export default function Backtest() {
  const [symbol, setSymbol] = useState("MES");
  const [endDate, setEndDate] = useState("2026-08-25");
  const [inSampleDays, setInSampleDays] = useState("5");
  const [outOfSampleDays, setOutOfSampleDays] = useState("2");
  const [seed, setSeed] = useState("11");
  const [targetDollars, setTargetDollars] = useState("75");
  const [slippageMode, setSlippageMode] = useState<"normal" | "fast" | "abnormal_spread">("normal");
  const run = useRunBacktest();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run.mutate({
      data: {
        symbol,
        endDate,
        inSampleDays: Number(inSampleDays),
        outOfSampleDays: Number(outOfSampleDays),
        seed: Number(seed),
        premarketAvailable: true,
        targetDollars: Number(targetDollars),
        slippageMode,
      },
    });
  };

  return <LevelStoryShell>
    <div className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
      <div className="mx-auto max-w-[1500px]">
        <PageIntro eyebrow="Research room / causal only" title="Replay the tape honestly." description="Run the existing futures rules through a sequential historical cursor. Tick data wins when available; one-minute fallback stays conservative. Nothing here can place an order." action={<ShadowBadge />} />
        <Panel className="mb-5" accent>
          <PanelTitle eyebrow="Configure a deterministic run" title="Backtest controls" right={<span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><LockKeyhole size={12} /> Thresholds locked</span>} />
          <form onSubmit={submit} className="grid gap-4 border-t border-border p-5 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Contract</span><select value={symbol} onChange={(event) => setSymbol(event.target.value)} className="field w-full" data-testid="select-backtest-symbol">{symbols.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">End date</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="field mono w-full" data-testid="input-backtest-end-date" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">In-sample days</span><input type="number" min="1" max="30" value={inSampleDays} onChange={(event) => setInSampleDays(event.target.value)} className="field mono w-full" data-testid="input-backtest-in-sample" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Holdout days</span><input type="number" min="1" max="10" value={outOfSampleDays} onChange={(event) => setOutOfSampleDays(event.target.value)} className="field mono w-full" data-testid="input-backtest-out-of-sample" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Seed</span><input type="number" min="1" max="100000" value={seed} onChange={(event) => setSeed(event.target.value)} className="field mono w-full" data-testid="input-backtest-seed" /></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Target</span><select value={targetDollars} onChange={(event) => setTargetDollars(event.target.value)} className="field w-full" data-testid="select-backtest-target"><option value="50">$50</option><option value="75">$75</option><option value="100">$100</option></select></label>
            <label className="space-y-1.5 text-xs"><span className="eyebrow text-muted-foreground">Slippage regime</span><select value={slippageMode} onChange={(event) => setSlippageMode(event.target.value as typeof slippageMode)} className="field w-full" data-testid="select-backtest-slippage"><option value="normal">Normal</option><option value="fast">Fast tape</option><option value="abnormal_spread">Abnormal spread</option></select></label>
            <div className="flex items-end"><button type="submit" disabled={run.isPending} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-sm bg-primary px-4 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50" data-testid="button-run-backtest"><Play size={14} className={run.isPending ? "animate-pulse" : ""} />{run.isPending ? "Replaying..." : "Run causal backtest"}</button></div>
          </form>
          <div className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">The final {outOfSampleDays || "—"} trading days are held out and never used for threshold selection. Contract economics remain month-specific.</div>
        </Panel>

        {run.isPending && <Panel><div className="p-8 text-center text-sm text-muted-foreground" data-testid="status-backtest-loading">Walking the replay cursor through completed observations…</div></Panel>}
        {run.isError && <Panel><QueryError onRetry={() => run.mutate({ data: { symbol, endDate, inSampleDays: Number(inSampleDays), outOfSampleDays: Number(outOfSampleDays), seed: Number(seed), premarketAvailable: true, targetDollars: Number(targetDollars), slippageMode } })} message="The causal backtest could not be completed." /></Panel>}
        {run.data && <ReportBody report={run.data} />}
        {!run.isPending && !run.isError && !run.data && <Panel><div className="flex flex-col items-center gap-3 p-12 text-center"><ShieldCheck size={28} className="text-accent" /><h2 className="text-sm font-bold">Ready for a clean replay</h2><p className="max-w-md text-xs leading-5 text-muted-foreground">Choose the evaluation window, then run the locked strategy. Results will show why setups qualified, rejected, or became ambiguous.</p></div></Panel>}
        <LockedNote>Phase 9 is a research surface only. It has no broker connection, no position state, and no live or paper order path.</LockedNote>
      </div>
    </div>
  </LevelStoryShell>;
}