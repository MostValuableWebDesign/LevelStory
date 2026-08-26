import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getGetMarketSnapshotQueryKey, useGetDashboardOverview, useGetMarketSnapshot, useGetRiskSettings } from "@workspace/api-client-react";
import type { MarketSnapshot, Signal } from "@workspace/api-client-react";
import { ArrowUpRight, Check, Clock3, Crosshair, RefreshCw, ShieldAlert, Target } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, MiniCandleChart, Panel, PanelTitle, PageIntro, PriceChange, QueryError, QuerySkeleton, ShadowBadge, SignalSummary, StatusBadge } from "@/components/levelstory-ui";

const symbols = ["MES", "ES", "MNQ", "NQ"];
export default function Dashboard() {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState("MES");
  const [session, setSession] = useState<"premarket" | "regular">("premarket");
  const [fibHigh, setFibHigh] = useState("");
  const [fibLow, setFibLow] = useState("");
  const [appliedFib, setAppliedFib] = useState<{ fibHigh: number; fibLow: number } | undefined>();
  const marketParams = { symbol, session, ...appliedFib };
  const market = useGetMarketSnapshot(marketParams);
  const overview = useGetDashboardOverview();
  const risk = useGetRiskSettings();
  const snapshot = market.data;
  const overviewData = overview.data;
  const activeSignals = snapshot?.signals ?? [];
  const confirmedCount = activeSignals.filter((signal) => signal.status === "confirmed").length;
  const blockedCount = activeSignals.filter((signal) => signal.status === "blocked").length;
  const qualified = snapshot?.decision.state === "SETUP QUALIFIED";

  return <LevelStoryShell>
    <div className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
      <div className="mx-auto max-w-[1500px]">
         <PageIntro eyebrow={`Daily cockpit / ${session === "premarket" ? "premarket context" : "regular-session replay"}`} title="Make the plan. Then wait." description="Read the simulated tape, mark the conditions, and decide whether attention is earned today." action={<ShadowBadge />} />

        <div className="mb-5 flex flex-col gap-3 border border-border bg-card/85 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
           <div className="flex flex-col gap-3 sm:flex-row sm:items-center"><div className="flex items-center gap-3"><span className="eyebrow px-1 text-muted-foreground">Watchlist</span><div className="flex flex-wrap gap-1">{symbols.map((item) => <button type="button" key={item} onClick={() => setSymbol(item)} className={`rounded-sm px-3 py-2 text-xs font-bold transition-colors ${symbol === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`} aria-pressed={symbol === item} data-testid={`button-symbol-${item.toLowerCase()}`}>{item}</button>)}</div></div><div className="flex rounded-sm border border-border p-0.5"><button type="button" onClick={() => setSession("premarket")} className={`px-2.5 py-1.5 text-[10px] font-bold uppercase ${session === "premarket" ? "bg-secondary text-foreground" : "text-muted-foreground"}`} aria-pressed={session === "premarket"} data-testid="button-session-premarket">Premarket</button><button type="button" onClick={() => setSession("regular")} className={`px-2.5 py-1.5 text-[10px] font-bold uppercase ${session === "regular" ? "bg-secondary text-foreground" : "text-muted-foreground"}`} aria-pressed={session === "regular"} data-testid="button-session-regular">Replay</button></div></div>
            <button type="button" onClick={() => queryClient.invalidateQueries({ queryKey: getGetMarketSnapshotQueryKey(marketParams) })} disabled={market.isFetching} className="inline-flex items-center justify-center gap-2 self-start rounded-sm border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 sm:self-auto" data-testid="button-refresh-market"><RefreshCw size={13} className={market.isFetching ? "animate-spin" : ""} />Refresh simulation</button>
        </div>

        <Panel className="mb-5">
          {overview.isLoading ? <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton m-5 h-12 rounded" />)}</div> : overview.isError ? <div className="flex items-center justify-between px-5 py-4 text-xs text-muted-foreground"><span>Session summary could not be loaded.</span><button type="button" onClick={() => overview.refetch()} className="font-bold text-foreground underline decoration-accent decoration-2 underline-offset-4" data-testid="button-retry-overview">Retry</button></div> : overviewData ? <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">{[["Session P&L", `${overviewData.sessionPnl >= 0 ? "+" : ""}$${overviewData.sessionPnl.toFixed(2)}`, overviewData.sessionPnl >= 0 ? "status-positive" : "status-negative"], ["Reviews logged", String(overviewData.tradeCount), ""], ["Win rate", `${overviewData.winRate.toFixed(1)}%`, ""], ["Plan completion", `${overviewData.checklistCompleted}/${overviewData.checklistTotal}`, ""]].map(([label, value, tone]) => <div key={label} className="px-5 py-4 sm:px-6"><div className="eyebrow text-muted-foreground">{label}</div><div className={`mono mt-2 text-xl font-medium ${tone}`} data-testid={`text-overview-${label.toLowerCase().replaceAll(" ", "-")}`}>{value}</div></div>)}</div> : <div className="px-5 py-4 text-xs text-muted-foreground">Session summary is waiting for the review feed.</div>}
        </Panel>

        {market.isLoading ? <Panel><QuerySkeleton rows={5} /></Panel> : market.isError || !snapshot ? <Panel><QueryError onRetry={() => market.refetch()} message="Simulated market feed unavailable." /></Panel> : <div className="space-y-5 appear">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,.7fr)]">
            <Panel accent>
              <div className="flex flex-col justify-between gap-5 px-5 pb-4 pt-6 sm:flex-row sm:items-start sm:px-7">
                 <div><div className="mb-3 flex items-center gap-2"><span className="eyebrow text-muted-foreground">Selected futures contract</span><span className="border border-border bg-secondary px-2 py-1 text-[10px] font-bold uppercase text-muted-foreground" data-testid="status-market-session">{snapshot.marketStatus}</span></div><div className="flex flex-wrap items-end gap-x-4 gap-y-1"><span className="display text-5xl font-bold tracking-[-.08em]" data-testid="text-market-symbol">{snapshot.contract.fullContractSymbol}</span><span className="pb-1 text-sm text-muted-foreground" data-testid="text-market-company">{snapshot.company}</span></div><div className="mt-3 text-[10px] text-muted-foreground" data-testid="text-contract-metadata">{snapshot.contract.exchange} · {snapshot.contract.contractMonth} · {snapshot.contract.tickSize.toFixed(2)} tick · {snapshot.contract.verificationNote}</div></div>
                <div className="sm:text-right"><div className="mono text-3xl font-medium tracking-[-.05em]" data-testid="text-market-price">${snapshot.price.toFixed(2)}</div><PriceChange value={snapshot.change} percent={snapshot.changePercent} /><div className="mt-2 text-[10px] text-muted-foreground">Updated {new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div></div>
              </div>
               <div className="terminal-rule px-1 pt-2"><MiniCandleChart candles={snapshot.candles} ntz={snapshot.ntz} levels={snapshot.levels.critical} /></div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/70 px-5 py-3 text-[10px] text-muted-foreground sm:px-7"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-[hsl(var(--positive))]" />Up candle</span><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-[hsl(var(--negative))]" />Down candle</span><span className="ml-auto inline-flex items-center gap-1.5"><Clock3 size={12} />{snapshot.replay.barIntervalMinutes} min · {snapshot.replay.timeZone} · {snapshot.sessionCalendar.tradingDate}</span></div>
            </Panel>

             <DecisionPanel snapshot={snapshot} confirmedCount={confirmedCount} signalCount={activeSignals.length} />
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
            <Panel>
              <PanelTitle eyebrow="Context / mapped before momentum" title="Key levels" right={<Crosshair size={16} className="text-muted-foreground" />} />
               <div className="grid grid-cols-2 gap-px overflow-hidden border-t border-border bg-border sm:grid-cols-4">{[["Premarket high", snapshot.levels.premarketHigh], ["Premarket low", snapshot.levels.premarketLow], ["Opening range high", snapshot.levels.openingRangeHigh], ["Opening range low", snapshot.levels.openingRangeLow], ["Previous day high", snapshot.levels.previousDayHigh], ["Previous day low", snapshot.levels.previousDayLow], ["Two days ago high", snapshot.levels.dayBeforeYesterdayHigh], ["Two days ago low", snapshot.levels.dayBeforeYesterdayLow], ["NTZ high", snapshot.levels.ntzHigh], ["NTZ low", snapshot.levels.ntzLow], ["NTZ width", snapshot.levels.ntzWidth], ["VWAP", snapshot.levels.vwap]].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="text-[10px] leading-4 text-muted-foreground">{label}</div><div className="mono mt-1 text-sm font-medium">{formatPrice(value)}</div></div>)}</div>
            </Panel>
            <Panel>
              <PanelTitle eyebrow="Read, don't predict" title="Indicators" right={<Target size={16} className="text-muted-foreground" />} />
               <div className="divide-y divide-border border-t border-border">{[["RSI", snapshot.indicators.rsi == null ? "—" : snapshot.indicators.rsi.toFixed(1), snapshot.indicators.rsi == null ? "Pending" : snapshot.indicators.rsi > 70 ? "Extended" : snapshot.indicators.rsi < 30 ? "Oversold" : "Balanced"], ["EMA 200", formatPrice(snapshot.indicators.ema200), "Completed 5m"], [`EMA slope (${snapshot.indicators.emaSlopeWindow}c)`, formatSigned(snapshot.indicators.emaSlope), "Completed EMA"], ["VWAP", formatPrice(snapshot.indicators.vwap), `Reset ${snapshot.indicators.vwapSessionDate} 09:30 ET`], ["Fib 23.6", formatPrice(snapshot.indicators.fib236), "Confluence"], ["Fib 38.2", formatPrice(snapshot.indicators.fib382), "Confluence"], ["Fib 50", formatPrice(snapshot.indicators.fib5), "Confluence"], ["Fib 61.8", formatPrice(snapshot.indicators.fib618), "Confluence"], ["Fib 78.6", formatPrice(snapshot.indicators.fib786), "Confluence"], ["Volume ratio", snapshot.indicators.volumeRatio == null ? "—" : `${snapshot.indicators.volumeRatio.toFixed(2)}×`, snapshot.indicators.volumeRatio == null ? "Pending" : snapshot.indicators.volumeRatio > 1 ? "Elevated" : "Quiet"]].map(([label, value, detail]) => <div key={label} className="flex items-center justify-between px-5 py-3 text-xs"><span className="text-muted-foreground">{label}</span><span className="mono font-medium">{value}</span><span className="hidden w-32 text-right text-[10px] text-muted-foreground sm:block">{detail}</span></div>)}</div>
            </Panel>
          </div>

           <NtzPanel snapshot={snapshot} />
           <MajorLevelsPanel snapshot={snapshot} />
           <Phase4Panel snapshot={snapshot} fibHigh={fibHigh} fibLow={fibLow} onFibHighChange={setFibHigh} onFibLowChange={setFibLow} onApplyFib={() => {
             const high = Number(fibHigh);
             const low = Number(fibLow);
             setAppliedFib(Number.isFinite(high) && Number.isFinite(low) ? { fibHigh: high, fibLow: low } : undefined);
           }} />
           <PatiencePanel snapshot={snapshot} />

          <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
            <Panel>
              <PanelTitle eyebrow="Confirmation layer" title="Signals worth respecting" right={<SignalSummary signals={activeSignals} />} />
              <div className="divide-y divide-border border-t border-border">{activeSignals.length ? activeSignals.map((signal) => <SignalRow key={signal.key} signal={signal} />) : <div className="p-8 text-center text-sm text-muted-foreground" data-testid="empty-signals">No signals are available for this simulation.</div>}</div>
            </Panel>
             <Panel accent>
               <PanelTitle eyebrow="Calculated gate" title="Required-rule checklist" right={<span className="mono text-xs">{snapshot.decision.passedRules.length}/{snapshot.decision.passedRules.length + snapshot.decision.failedRules.length}</span>} />
               <div className="space-y-2 border-t border-border p-5 sm:p-6">{[...snapshot.decision.passedRules.map(rule => ({ ...rule, passed: true })), ...snapshot.decision.failedRules.map(rule => ({ ...rule, passed: false }))].map((rule) => <div key={rule.key} className="flex items-start gap-3 rounded-sm px-2 py-2" data-testid={`rule-${rule.key}`}><span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border ${rule.passed ? "border-[hsl(var(--positive))] bg-[hsl(var(--positive))] text-white" : "border-destructive/40 text-destructive"}`}>{rule.passed ? <Check size={13} strokeWidth={3} /> : <span className="text-xs">—</span>}</span><span><span className={`block text-xs font-semibold ${rule.passed ? "text-foreground" : "text-muted-foreground"}`}>{rule.label}</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{rule.detail}</span></span></div>)}</div>
             </Panel>
          </div>

          <Panel>
            <PanelTitle eyebrow="Session ledger" title="Recent shadow reviews" right={<Link href="/journal" className="text-xs font-bold underline decoration-accent decoration-2 underline-offset-4" data-testid="link-view-journal">Open journal</Link>} />
            {overview.isLoading ? <QuerySkeleton rows={2} /> : overview.isError || !overviewData ? <QueryError onRetry={() => overview.refetch()} /> : <div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[680px] text-left text-xs"><thead className="bg-muted/55 text-[10px] uppercase tracking-[.1em] text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Symbol</th><th className="px-5 py-3 font-medium">Setup</th><th className="px-5 py-3 font-medium">Side</th><th className="px-5 py-3 font-medium">P&amp;L</th><th className="px-5 py-3 font-medium">Review</th></tr></thead><tbody className="divide-y divide-border">{overviewData.recentEntries.slice(0, 4).map((entry) => <tr key={entry.id} className="transition hover:bg-muted/35" data-testid={`row-recent-entry-${entry.id}`}><td className="px-5 py-4 font-bold">{entry.symbol}</td><td className="px-5 py-4 text-muted-foreground">{entry.setup}</td><td className="px-5 py-4"><span className="rounded-sm bg-secondary px-2 py-1 text-[10px] font-bold uppercase">{entry.side}</span></td><td className={`mono px-5 py-4 font-medium ${entry.pnl == null ? "text-muted-foreground" : entry.pnl >= 0 ? "status-positive" : "status-negative"}`}>{entry.pnl == null ? "Open review" : `${entry.pnl >= 0 ? "+" : ""}$${entry.pnl.toFixed(2)}`}</td><td className="px-5 py-4 text-muted-foreground">{entry.checklistPassed ? "Checklist passed" : "Needs reflection"}</td></tr>)}</tbody></table>{overviewData.recentEntries.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground" data-testid="empty-recent-reviews">No shadow reviews yet. The first honest note is a good start.</div>}</div>}
          </Panel>
           <div className="grid gap-5 lg:grid-cols-[.95fr_1.05fr]">
             <Panel>
               <PanelTitle eyebrow="Risk / no execution" title="Position plan" right={<span className={`text-[10px] font-bold uppercase ${snapshot.riskPlan.allowed ? "status-positive" : "status-negative"}`}>{snapshot.riskPlan.allowed ? "Allowed" : "Blocked"}</span>} />
               <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3">{[["Direction", snapshot.riskPlan.direction], ["Entry", formatPrice(snapshot.riskPlan.entry)], ["Thesis stop", formatPrice(snapshot.riskPlan.thesisStop)], ["Catastrophe stop", formatPrice(snapshot.riskPlan.catastropheStop)], ["Target", formatPrice(snapshot.riskPlan.target)], ["Contracts", String(snapshot.riskPlan.contracts)], ["Dollar risk", `$${snapshot.riskPlan.dollarRisk.toFixed(2)}`]].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mono mt-1 text-sm font-medium">{value}</div></div>)}</div>
               <div className="space-y-2 border-t border-border p-5">{snapshot.riskPlan.reasons.map(reason => <p key={reason} className="text-xs leading-5 text-muted-foreground">{reason}</p>)}</div>
             </Panel>
             <Panel>
               <PanelTitle eyebrow="Chronological evidence" title="Level Story" right={<span className="text-[10px] uppercase text-muted-foreground">{snapshot.levelStory.length} interactions</span>} />
               <div className="max-h-[260px] overflow-y-auto border-t border-border">{snapshot.levelStory.length ? snapshot.levelStory.map((event, index) => <div key={`${event.time}-${event.level}-${index}`} className="border-b border-border px-5 py-3 last:border-0"><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold">{event.level}</span><span className="mono text-[10px] text-muted-foreground">{new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{event.detail}</p></div>) : <div className="p-6 text-sm text-muted-foreground">No mapped level interactions yet.</div>}</div>
             </Panel>
           </div>
           <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
             <Panel>
               <PanelTitle eyebrow="Trend evidence" title={`${snapshot.trend.direction} 15-minute trend`} right={<span className="mono text-xs">{snapshot.trend.candleCount}/8 candles · score {snapshot.trend.score}</span>} />
                <div className="border-t border-border p-5"><p className="text-sm font-semibold">{snapshot.trend.structure}</p><div className="mt-3 grid gap-2">{snapshot.trend.evidenceItems.map(item => <div key={item.key} className="rounded-sm border border-border/80 px-3 py-2" data-testid={`trend-evidence-${item.key}`}><div className="flex items-center justify-between gap-3"><span className="text-[10px] font-bold uppercase tracking-[.08em]">{item.label}</span><span className={`text-[10px] font-bold uppercase ${item.status === "positive" ? "status-positive" : item.status === "negative" ? "status-negative" : "text-muted-foreground"}`}>{item.status}</span></div><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{item.detail}</p></div>)}</div><div className="mt-5 grid gap-2">{snapshot.assumptions.map(item => <p key={item} className="text-[11px] leading-4 text-muted-foreground">{item}</p>)}</div></div>
             </Panel>
             <Panel className={snapshot.reversal.warning ? "border-destructive/30" : ""}>
               <PanelTitle eyebrow="Bonus reversal / alert only" title="Reversal watch" right={<span className="text-[10px] uppercase text-muted-foreground">{snapshot.reversal.warning ? "Attention" : "Quiet"}</span>} />
               <div className="space-y-3 border-t border-border p-5"><div className="flex justify-between text-xs"><span className="text-muted-foreground">Doji at context</span><span className="mono">{snapshot.reversal.doji ? "Detected" : "None"}</span></div><div className="flex justify-between text-xs"><span className="text-muted-foreground">Equivalent opposing candles</span><span className="mono">{snapshot.reversal.equivalentCandles ? "Detected" : "None"}</span></div>{snapshot.reversal.warning && <p className="border border-destructive/25 bg-destructive/10 p-3 text-xs font-semibold text-destructive">{snapshot.reversal.warning}</p>}<p className="text-[11px] leading-4 text-muted-foreground">Reversal patterns never qualify an entry by themselves.</p></div>
             </Panel>
           </div>
        </div>}
      </div>
    </div>
  </LevelStoryShell>;
}

function DecisionPanel({ snapshot, confirmedCount, signalCount }: { snapshot: MarketSnapshot; confirmedCount: number; signalCount: number }) {
  const qualified = snapshot.decision.state === "SETUP QUALIFIED";
  const waiting = snapshot.decision.state === "WAITING" || snapshot.decision.state === "SETUP FORMING";
  return <Panel className={qualified ? "border-[hsl(var(--positive)/.3)]" : waiting ? "border-accent/50" : "border-destructive/25"}>
    <div className={`h-1 w-full ${qualified ? "bg-[hsl(var(--positive))]" : waiting ? "bg-accent" : "bg-destructive/70"}`} />
    <div className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4"><div><div className="eyebrow text-muted-foreground">Current decision</div><div className={`display mt-3 text-3xl font-bold tracking-[-.06em] ${qualified ? "status-positive" : waiting ? "text-accent-foreground" : "status-negative"}`} data-testid="status-current-decision">{snapshot.decision.state}</div></div><ShieldAlert size={19} className={qualified ? "status-positive" : waiting ? "text-accent-foreground" : "status-negative"} /></div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">{snapshot.decision.explanation}</p>
       {snapshot.ntz.complete && snapshot.ntz.position === "inside" && <div className="mt-4 border border-accent/45 bg-accent/10 px-3 py-3 text-center text-[11px] font-bold uppercase tracking-[.12em] text-accent-foreground" data-testid="status-inside-ntz">INSIDE NTZ — NO TRADE</div>}
      <div className="mt-6 space-y-3 border-t border-border pt-4"><div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">Rules passed</span><span className="mono">{snapshot.decision.passedRules.length}/{snapshot.decision.passedRules.length + snapshot.decision.failedRules.length}</span></div><div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">Confirmed signals</span><span className="mono">{confirmedCount}/{signalCount || 0}</span></div></div>
      <div className="mt-5"><LockedNote>No live orders. This is a decision rehearsal, not an execution terminal.</LockedNote></div>
    </div>
  </Panel>;
}

function NtzPanel({ snapshot }: { snapshot: MarketSnapshot }) {
  const phaseLabel = snapshot.ntz.phase === "pending" ? "Awaiting 09:30 ET" : snapshot.ntz.phase === "forming" ? "Forming · not final" : snapshot.ntz.position === "inside" ? "Completed · price inside" : "Completed · price outside";
  return <Panel className={snapshot.ntz.position === "inside" && snapshot.ntz.complete ? "border-accent/50" : ""}>
    <PanelTitle eyebrow="Opening range lifecycle" title="NTZ / ORB state" right={<span className="mono text-[10px] uppercase text-muted-foreground">{phaseLabel}</span>} />
    <div className="grid gap-4 border-t border-border p-5 sm:grid-cols-[.8fr_1.2fr] sm:p-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-sm bg-secondary/70 p-3"><div className="text-[10px] text-muted-foreground">NTZ high</div><div className="mono mt-1 text-sm">{formatPrice(snapshot.ntz.high)}</div></div>
        <div className="rounded-sm bg-secondary/70 p-3"><div className="text-[10px] text-muted-foreground">NTZ low</div><div className="mono mt-1 text-sm">{formatPrice(snapshot.ntz.low)}</div></div>
        <div className="col-span-2 text-[11px] leading-5 text-muted-foreground">Exactly three completed 5-minute candles: 09:30–09:35, 09:35–09:40, and 09:40–09:45 ET. The range is not final before 09:45 ET.</div>
      </div>
      <div className="max-h-[170px] overflow-y-auto rounded-sm border border-border" data-testid="ntz-event-ledger">
        {snapshot.ntz.events.length ? snapshot.ntz.events.map((event, index) => <div key={`${event.time}-${event.type}-${index}`} className="flex gap-3 border-b border-border px-3 py-2.5 last:border-0"><span className="mono mt-0.5 shrink-0 text-[10px] text-muted-foreground">{new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span><span className="block text-[11px] font-semibold">{event.type}</span><span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{event.detail}</span></span></div>) : <div className="p-4 text-xs text-muted-foreground">No NTZ lifecycle events yet.</div>}
      </div>
    </div>
  </Panel>;
}

function MajorLevelsPanel({ snapshot }: { snapshot: MarketSnapshot }) {
  return <Panel>
    <PanelTitle eyebrow="Historical reaction map" title="Major levels" right={<span className="mono text-[10px] uppercase text-muted-foreground">{snapshot.majorLevels.length} zones · 252 sessions</span>} />
    <div className="border-t border-border">
      {snapshot.majorLevels.length ? snapshot.majorLevels.slice(0, 8).map((level) => <div key={level.name} className="flex flex-col gap-3 border-b border-border px-5 py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between" data-testid={`major-level-${level.kind}`}>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{level.kind === "support" ? "Support" : "Resistance"}</span><span className={`rounded-sm px-2 py-1 text-[10px] font-bold uppercase ${level.confluence === "dynamite" ? "bg-accent text-accent-foreground" : level.confluence === "strong" ? "bg-secondary text-foreground" : "bg-muted text-muted-foreground"}`}>{level.confluence}</span></div><p className="mt-1 truncate text-[11px] text-muted-foreground">{level.components.join(" · ")}</p></div>
        <div className="flex shrink-0 items-center gap-5"><div><div className="mono text-sm font-medium">{level.price.toFixed(2)}</div><div className="text-[10px] text-muted-foreground">zone {level.zoneLow.toFixed(2)}–{level.zoneHigh.toFixed(2)}</div></div><div className="text-right"><div className="mono text-sm font-medium">{level.strength}</div><div className="text-[10px] text-muted-foreground">{level.reactionCount} reactions</div></div></div>
      </div>) : <div className="p-6 text-sm text-muted-foreground">No three-reaction hourly zones are available yet.</div>}
    </div>
  </Panel>;
}

function PatiencePanel({ snapshot }: { snapshot: MarketSnapshot }) {
  const patience = snapshot.patience;
  const candle = patience.patienceCandle;
  const trigger = patience.triggerCandle;
  const active = patience.state === "ENTRY TRIGGERED" || patience.state === "TRIGGER CANDLE ACTIVE";
  const warning = patience.state === "INVALIDATED" || patience.state === "EXPIRED" || patience.state === "AMBIGUOUS";
  return <Panel className={active ? "border-[hsl(var(--positive)/.3)]" : warning ? "border-destructive/30" : ""}>
    <PanelTitle eyebrow="Phase 5 / exact timing" title="Patience-candle engine" right={<span className={`text-[10px] font-bold uppercase ${active ? "status-positive" : warning ? "status-negative" : "text-muted-foreground"}`} data-testid="patience-state">{patience.state}</span>} />
    <div className="border-t border-border p-5 sm:p-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-sm bg-secondary/70 p-3"><div className="text-[10px] text-muted-foreground">Eligibility</div><div className="mt-1 text-xs font-semibold uppercase">{patience.eligibilityReason ?? "Not opened"}</div><div className="mt-1 text-[10px] text-muted-foreground">{patience.eligibilityTime ? new Date(patience.eligibilityTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</div></div>
        <div className="rounded-sm bg-secondary/70 p-3"><div className="text-[10px] text-muted-foreground">Patience range</div><div className="mono mt-1 text-sm">{candle ? `${candle.low.toFixed(2)} – ${candle.high.toFixed(2)}` : "—"}</div><div className="mt-1 text-[10px] text-muted-foreground">{candle?.isComplete ? "Closed and contained" : "Still forming"}</div></div>
        <div className="rounded-sm bg-secondary/70 p-3"><div className="text-[10px] text-muted-foreground">Trigger price</div><div className="mono mt-1 text-sm">{formatPrice(patience.triggerPrice)}</div><div className="mt-1 text-[10px] text-muted-foreground">{trigger ? "Immediate next candle" : "No trigger candle"}</div></div>
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">{patience.detail}</p>
      <LockedNote>Timing state is descriptive shadow analysis only. `ENTRY TRIGGERED` never creates a live or paper order.</LockedNote>
    </div>
  </Panel>;
}

function Phase4Panel({ snapshot, fibHigh, fibLow, onFibHighChange, onFibLowChange, onApplyFib }: {
  snapshot: MarketSnapshot;
  fibHigh: string;
  fibLow: string;
  onFibHighChange: (value: string) => void;
  onFibLowChange: (value: string) => void;
  onApplyFib: () => void;
}) {
  const breakout = snapshot.breakout;
  const volume = snapshot.volumeAnalysis;
  const fib = snapshot.fibonacci;
  return <div className="space-y-5">
    <div className="grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
      <Panel accent={breakout.detected}>
        <PanelTitle eyebrow="Phase 4 / initial event" title="ORB breakout" right={<span className={`text-[10px] font-bold uppercase ${breakout.detected ? "status-positive" : "text-muted-foreground"}`}>{breakout.detected ? `${breakout.direction} detected` : "Waiting"}</span>} />
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
          {[["Close", breakout.time ? new Date(breakout.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"], ["Distance", breakout.distanceOutside == null ? "—" : `${breakout.distanceOutside.toFixed(2)} pts`], ["Volume", breakout.breakoutVolume == null ? "—" : breakout.breakoutVolume.toFixed(0)], ["Support", breakout.volumeSupported ? "≥ 1.25× baseline" : "Not confirmed"]].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mono mt-1 text-sm font-medium">{value}</div></div>)}
        </div>
        <p className="border-t border-border px-5 py-4 text-[11px] leading-5 text-muted-foreground">{breakout.detail} A breakout is recorded evidence only; it never creates an entry.</p>
      </Panel>
      <Panel className={volume.reversalWarning ? "border-destructive/30" : ""}>
        <PanelTitle eyebrow="Phase 4 / separate variables" title="Volume evidence" right={<span className={`text-[10px] font-bold uppercase ${volume.reversalWarning ? "status-negative" : "text-muted-foreground"}`}>{volume.reversalWarning ? "Warning" : "No warning"}</span>} />
        <div className="divide-y divide-border border-t border-border">
          {[["Previous six average", volume.recentSixAverage == null ? "—" : volume.recentSixAverage.toFixed(0)], ["Breakout ratio", volume.breakoutRatio == null ? "—" : `${volume.breakoutRatio.toFixed(2)}×`], ["Impulse average", volume.averageImpulseVolume == null ? "—" : volume.averageImpulseVolume.toFixed(0)], ["Pullback average", volume.pullbackAverageVolume == null ? "—" : volume.pullbackAverageVolume.toFixed(0)], ["Pullback / breakout", volume.pullbackToBreakoutRatio == null ? "—" : `${volume.pullbackToBreakoutRatio.toFixed(2)}×`], ["Pullback / impulse", volume.pullbackToImpulseRatio == null ? "—" : `${volume.pullbackToImpulseRatio.toFixed(2)}×`], ["Pullback / recent", volume.pullbackToRecentRatio == null ? "—" : `${volume.pullbackToRecentRatio.toFixed(2)}×`], ["Opposing pullback", volume.opposingPullbackVolume == null ? "—" : volume.opposingPullbackVolume.toFixed(0)]].map(([label, value]) => <div key={label} className="flex items-center justify-between px-5 py-3 text-xs"><span className="text-muted-foreground">{label}</span><span className="mono font-medium">{value}</span></div>)}
        </div>
        {volume.reversalWarning && <p className="m-4 border border-destructive/25 bg-destructive/10 p-3 text-xs font-semibold text-destructive">{volume.reversalWarning}</p>}
        <p className="px-5 pb-4 text-[11px] leading-5 text-muted-foreground">Breakout strength and pullback pressure remain separate. Volume is descriptive evidence, not proof of reversal.</p>
      </Panel>
    </div>
    <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
      <Panel>
        <PanelTitle eyebrow="Phase 4 / bounded window" title="Pullback ledger" right={<span className="mono text-[10px] uppercase text-muted-foreground">{snapshot.pullback.evaluatedCandles}/{snapshot.pullback.maxCandles} candles</span>} />
        <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3 text-[10px] text-muted-foreground"><span>{snapshot.pullback.status}</span><span>·</span><span>{snapshot.pullback.elapsedMinutes}/{snapshot.pullback.maxDurationMinutes} min</span><span>·</span><span>±{snapshot.pullback.proximityTolerance == null ? "—" : snapshot.pullback.proximityTolerance.toFixed(2)} proximity</span><span>·</span><span>{snapshot.pullback.qualifyingLevelCount} levels</span></div>
        <div className="max-h-[280px] overflow-y-auto border-t border-border">{snapshot.pullback.events.length ? snapshot.pullback.events.map((event, index) => <div key={`${event.time}-${event.level}-${event.type}-${index}`} className="flex gap-3 border-b border-border px-5 py-3 last:border-0"><span className="mono mt-0.5 shrink-0 text-[10px] text-muted-foreground">{new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span><span className="block text-[11px] font-semibold">{event.type} · {event.level}</span><span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{event.detail}</span></span></div>) : <div className="p-6 text-sm text-muted-foreground">{snapshot.pullback.detail}</div>}</div>
      </Panel>
      <Panel accent={fib.frozen}>
        <PanelTitle eyebrow="Phase 4 / frozen anchors" title="Fibonacci retracement" right={<span className="text-[10px] font-bold uppercase text-muted-foreground">{fib.classification}</span>} />
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border">
          {[["Impulse low", formatPrice(fib.impulseLow)], ["Impulse high", formatPrice(fib.impulseHigh)], ["Depth", fib.retracementPercent == null ? "—" : `${fib.retracementPercent.toFixed(1)}%`], ["State", fib.frozen ? "Frozen" : "Unavailable"]].map(([label, value]) => <div key={label} className="bg-card px-4 py-3"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mono mt-1 text-sm font-medium">{value}</div></div>)}
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-border p-4 sm:grid-cols-4">{fib.levels.map((level) => <div key={level.name} className="rounded-sm bg-secondary/70 px-3 py-2"><div className="text-[10px] text-muted-foreground">{level.label}</div><div className="mono mt-1 text-xs">{level.price.toFixed(2)}</div></div>)}</div>
        <div className="border-t border-border p-4"><div className="mb-2 text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">Manual anchor correction</div><div className="grid grid-cols-2 gap-2"><label className="text-[10px] text-muted-foreground">High<input value={fibHigh} onChange={(event) => onFibHighChange(event.target.value)} type="number" step="0.01" className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2 text-xs text-foreground" aria-label="Manual Fibonacci high" /></label><label className="text-[10px] text-muted-foreground">Low<input value={fibLow} onChange={(event) => onFibLowChange(event.target.value)} type="number" step="0.01" className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2 text-xs text-foreground" aria-label="Manual Fibonacci low" /></label></div><button type="button" onClick={onApplyFib} className="mt-3 rounded-sm bg-primary px-3 py-2 text-[10px] font-bold uppercase text-primary-foreground hover:opacity-90" data-testid="button-apply-fibonacci">Apply anchors</button></div>
        <p className="border-t border-border px-5 py-4 text-[11px] leading-5 text-muted-foreground">{fib.detail}</p>
      </Panel>
    </div>
  </div>;
}

function formatPrice(value: number | string | null) { return value == null ? "—" : typeof value === "number" ? value.toFixed(2) : value; }
function formatSigned(value: number | null) { return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`; }

function SignalRow({ signal }: { signal: Signal }) {
  return <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6" data-testid={`row-signal-${signal.label.toLowerCase().replaceAll(" ", "-")}`}><div><div className="text-sm font-semibold">{signal.label}</div><div className="mt-1 text-xs leading-5 text-muted-foreground">{signal.detail}</div></div><StatusBadge status={signal.status} /></div>;
}