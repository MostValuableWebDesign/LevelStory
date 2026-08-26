import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getGetMarketSnapshotQueryKey, useGetDashboardOverview, useGetMarketSnapshot, useGetRiskSettings } from "@workspace/api-client-react";
import { ArrowUpRight, Check, Clock3, Crosshair, RefreshCw, ShieldAlert, Target } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, MiniCandleChart, Panel, PanelTitle, PageIntro, PriceChange, QueryError, QuerySkeleton, ShadowBadge, StatusBadge } from "@/components/levelstory-ui";

const symbols = ["AAPL", "NVDA", "TSLA", "AMD"];
const checklist = ["Premarket levels marked", "Max loss acknowledged", "Primary setup named", "Wait condition written"];

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState("AAPL");
  const [checked, setChecked] = useState<boolean[]>([true, true, false, false]);
  const market = useGetMarketSnapshot({ symbol, session: "premarket" });
  const overview = useGetDashboardOverview();
  const risk = useGetRiskSettings();
  const snapshot = market.data;
  const overviewData = overview.data;
  const activeSignals = useMemo(() => snapshot?.signals ?? [], [snapshot?.signals]);
  const toggledCount = checked.filter(Boolean).length;

  return <LevelStoryShell>
    <div className="cockpit-grid min-h-[calc(100dvh-68px)] px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
      <div className="mx-auto max-w-[1480px]">
        <PageIntro eyebrow="Daily cockpit / 06:42 PT" title="Make the plan. Then wait." description="A deliberate view of simulated price action, levels, and the conditions worth respecting today." action={<ShadowBadge />} />
        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-card/80 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3"><span className="eyebrow px-2 text-muted-foreground">Watchlist</span><div className="flex flex-wrap gap-1.5">{symbols.map((item) => <button type="button" key={item} onClick={() => setSymbol(item)} className={`rounded-md px-3 py-2 text-xs font-bold transition-colors ${symbol === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`} data-testid={`button-symbol-${item.toLowerCase()}`}>{item}</button>)}</div></div>
          <button type="button" onClick={() => { queryClient.invalidateQueries({ queryKey: getGetMarketSnapshotQueryKey({ symbol, session: "premarket" }) }); }} disabled={market.isFetching} className="inline-flex items-center justify-center gap-2 self-start rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 sm:self-auto" data-testid="button-refresh-market"><RefreshCw size={13} className={market.isFetching ? "animate-spin" : ""} />Refresh simulation</button>
        </div>
        <Panel className="mb-6 overflow-visible">
          {overview.isLoading ? <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0"><div className="skeleton m-5 h-12 rounded" /><div className="skeleton m-5 h-12 rounded" /><div className="skeleton m-5 h-12 rounded" /><div className="skeleton m-5 h-12 rounded" /></div> : overview.isError ? <div className="flex items-center justify-between px-5 py-4 text-xs text-muted-foreground"><span>Session summary could not be loaded.</span><button type="button" onClick={() => overview.refetch()} className="font-bold text-foreground underline decoration-accent decoration-2 underline-offset-4" data-testid="button-retry-overview">Retry</button></div> : overviewData ? <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">{[["Session P&L", `${overviewData.sessionPnl >= 0 ? "+" : ""}$${overviewData.sessionPnl.toFixed(2)}`, overviewData.sessionPnlPercent >= 0 ? "positive" : "negative"], ["Reviews logged", String(overviewData.tradeCount), "neutral"], ["Win rate", `${overviewData.winRate.toFixed(1)}%`, "neutral"], ["Plan completion", `${overviewData.checklistCompleted}/${overviewData.checklistTotal}`, "neutral"]].map(([label, value, tone]) => <div key={label} className="px-5 py-4 sm:px-6"><div className="eyebrow text-muted-foreground">{label}</div><div className={`mono mt-2 text-xl font-medium ${tone === "negative" ? "text-destructive" : ""}`} data-testid={`text-overview-${label.toLowerCase().replaceAll(" ", "-")}`}>{value}</div></div>)}</div> : <div className="px-5 py-4 text-xs text-muted-foreground">Session summary is waiting for the review feed.</div>}
        </Panel>

        {market.isLoading ? <Panel><QuerySkeleton rows={4} /></Panel> : market.isError || !snapshot ? <Panel><QueryError onRetry={() => market.refetch()} message="Simulated market feed unavailable." /></Panel> : <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[1.6fr_.8fr]">
            <Panel accent>
              <div className="flex flex-col justify-between gap-5 px-5 pb-5 pt-6 sm:flex-row sm:items-start sm:px-7">
                <div><div className="mb-3 flex items-center gap-2"><span className="eyebrow text-muted-foreground">Selected symbol</span><span className="rounded bg-secondary px-2 py-1 text-[10px] font-bold uppercase text-muted-foreground" data-testid="status-market-session">{snapshot.marketStatus}</span></div><div className="flex items-end gap-4"><span className="display text-5xl font-bold tracking-[-.07em]" data-testid="text-market-symbol">{snapshot.symbol}</span><span className="pb-1 text-sm text-muted-foreground" data-testid="text-market-company">{snapshot.company}</span></div></div>
                <div className="sm:text-right"><div className="mono text-3xl font-medium tracking-[-.04em]" data-testid="text-market-price">${snapshot.price.toFixed(2)}</div><PriceChange value={snapshot.change} percent={snapshot.changePercent} /><div className="mt-2 text-[10px] text-muted-foreground">Updated {new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div></div>
              </div>
              <div className="border-t border-border/70 px-1 pt-2"><MiniCandleChart candles={snapshot.candles} /></div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/70 px-5 py-3 text-[10px] text-muted-foreground sm:px-7"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-accent" />Up candle</span><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-destructive" />Down candle</span><span className="ml-auto inline-flex items-center gap-1.5"><Clock3 size={12} />5 min / simulated</span></div>
            </Panel>
            <Panel>
              <PanelTitle eyebrow="Session pulse" title="Your guardrails" right={<ShieldAlert size={16} className="text-muted-foreground" />} />
              {risk.isLoading ? <QuerySkeleton rows={2} /> : risk.isError || !risk.data ? <QueryError onRetry={() => risk.refetch()} /> : <div className="space-y-5 px-5 pb-6 sm:px-6">
                <div><div className="mb-2 flex items-baseline justify-between"><span className="text-xs text-muted-foreground">Daily loss used</span><span className="mono text-sm font-medium">${risk.data.dailyLossUsed.toFixed(2)} / ${risk.data.maxDailyLoss.toFixed(2)}</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min((risk.data.dailyLossUsed / risk.data.maxDailyLoss) * 100, 100)}%` }} /></div></div>
                <div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-muted/60 p-3"><div className="eyebrow text-muted-foreground">Per trade</div><div className="mono mt-2 text-lg font-medium">${((risk.data.accountSize * risk.data.riskPercent) / 100).toFixed(0)}</div></div><div className="rounded-lg bg-muted/60 p-3"><div className="eyebrow text-muted-foreground">Account</div><div className="mono mt-2 text-lg font-medium">${risk.data.accountSize.toLocaleString()}</div></div></div>
                <LockedNote>Guardrails are a stop sign, not a suggestion. LevelStory will never turn this into a live order.</LockedNote>
                <Link href="/settings" className="inline-flex items-center gap-1 text-xs font-bold text-foreground underline decoration-accent decoration-2 underline-offset-4" data-testid="link-edit-guardrails">Review risk settings <ArrowUpRight size={13} /></Link>
              </div>}
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
            <Panel>
              <PanelTitle eyebrow="Context / mapped before momentum" title="Key levels" right={<Crosshair size={16} className="text-muted-foreground" />} />
              <div className="grid grid-cols-2 gap-px overflow-hidden border-t border-border bg-border sm:grid-cols-4">
                {[["Premarket high", snapshot.levels.premarketHigh], ["Premarket low", snapshot.levels.premarketLow], ["Opening range high", snapshot.levels.openingRangeHigh], ["Opening range low", snapshot.levels.openingRangeLow], ["Previous day high", snapshot.levels.previousDayHigh], ["Previous day low", snapshot.levels.previousDayLow], ["Previous close", snapshot.levels.previousDayClose]].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="text-[10px] leading-4 text-muted-foreground">{label}</div><div className="mono mt-1 text-sm font-medium">${Number(value).toFixed(2)}</div></div>)}
              </div>
            </Panel>
            <Panel>
              <PanelTitle eyebrow="Read, don't predict" title="Indicators" right={<Target size={16} className="text-muted-foreground" />} />
              <div className="divide-y divide-border border-t border-border">{[["RSI", `${snapshot.indicators.rsi.toFixed(1)}`, snapshot.indicators.rsi > 70 ? "Extended" : snapshot.indicators.rsi < 30 ? "Oversold" : "Balanced"], ["EMA 200", `$${snapshot.indicators.ema200.toFixed(2)}`, "Reference"], ["Fib 38.2", `$${snapshot.indicators.fib382.toFixed(2)}`, "Retracement"], ["Fib 50", `$${snapshot.indicators.fib5.toFixed(2)}`, "Retracement"], ["Volume ratio", `${snapshot.indicators.volumeRatio.toFixed(2)}×`, snapshot.indicators.volumeRatio > 1 ? "Elevated" : "Quiet"]].map(([label, value, detail]) => <div key={label} className="flex items-center justify-between px-5 py-3 text-xs"><span className="text-muted-foreground">{label}</span><span className="mono font-medium">{value}</span><span className="hidden w-20 text-right text-[10px] text-muted-foreground sm:block">{detail}</span></div>)}</div>
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
            <Panel>
              <PanelTitle eyebrow="Confirmation layer" title="Signals worth respecting" right={<span className="mono text-xs text-muted-foreground">{activeSignals.filter((s) => s.status === "confirmed").length}/{activeSignals.length} clear</span>} />
              <div className="divide-y divide-border border-t border-border">{activeSignals.map((signal) => <SignalRow key={signal.key} signal={signal} />)}</div>
            </Panel>
            <Panel accent>
              <PanelTitle eyebrow="Before the bell" title="Discipline checklist" right={<span className="mono text-xs">{toggledCount}/{checklist.length}</span>} />
              <div className="space-y-2 border-t border-border p-5 sm:p-6">{checklist.map((item, index) => <button type="button" key={item} onClick={() => setChecked((current) => current.map((value, i) => i === index ? !value : value))} className="flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left transition hover:border-border hover:bg-muted/50" data-testid={`button-checklist-${index}`}><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${checked[index] ? "border-accent bg-accent text-accent-foreground" : "border-border"}`}>{checked[index] && <Check size={13} strokeWidth={3} />}</span><span className={`text-xs ${checked[index] ? "text-foreground" : "text-muted-foreground"}`}>{item}</span></button>)}</div>
              {toggledCount === checklist.length && <div className="mx-5 mb-5 rounded-lg bg-accent/15 p-3 text-xs font-semibold text-foreground sm:mx-6">You have earned the right to wait.</div>}
            </Panel>
          </div>

          <Panel>
            <PanelTitle eyebrow="Session ledger" title="Recent shadow reviews" right={<Link href="/journal" className="text-xs font-bold underline decoration-accent decoration-2 underline-offset-4" data-testid="link-view-journal">Open journal</Link>} />
            {overview.isLoading ? <QuerySkeleton rows={2} /> : overview.isError || !overviewData ? <QueryError onRetry={() => overview.refetch()} /> : <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[680px] text-left text-xs"><thead className="bg-muted/55 text-[10px] uppercase tracking-[.1em] text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Symbol</th><th className="px-5 py-3 font-medium">Setup</th><th className="px-5 py-3 font-medium">Side</th><th className="px-5 py-3 font-medium">P&amp;L</th><th className="px-5 py-3 font-medium">Review</th></tr></thead><tbody className="divide-y divide-border">{overviewData.recentEntries.slice(0, 4).map((entry) => <tr key={entry.id} className="transition hover:bg-muted/35" data-testid={`row-recent-entry-${entry.id}`}><td className="px-5 py-4 font-bold">{entry.symbol}</td><td className="px-5 py-4 text-muted-foreground">{entry.setup}</td><td className="px-5 py-4"><span className="rounded bg-secondary px-2 py-1 text-[10px] font-bold uppercase">{entry.side}</span></td><td className={`mono px-5 py-4 font-medium ${(entry.pnl ?? 0) >= 0 ? "text-foreground" : "text-destructive"}`}>{entry.pnl == null ? "Open review" : `${entry.pnl >= 0 ? "+" : ""}$${entry.pnl.toFixed(2)}`}</td><td className="px-5 py-4 text-muted-foreground">{entry.checklistPassed ? "Checklist passed" : "Needs reflection"}</td></tr>)}</tbody></table>{overviewData.recentEntries.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No shadow reviews yet. The first honest note is a good start.</div>}</div>}
          </Panel>
        </div>}
      </div>
    </div>
  </LevelStoryShell>;
}

function SignalRow({ signal }: { signal: { label: string; status: "confirmed" | "watching" | "blocked"; detail: string } }) {
  return <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6" data-testid={`row-signal-${signal.label.toLowerCase().replaceAll(" ", "-")}`}><div><div className="text-sm font-semibold">{signal.label}</div><div className="mt-1 text-xs leading-5 text-muted-foreground">{signal.detail}</div></div><StatusBadge status={signal.status} /></div>;
}