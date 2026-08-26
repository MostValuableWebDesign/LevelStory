import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardOverviewQueryKey,
  getListJournalEntriesQueryKey,
  useCreateJournalEntry,
  useDeleteJournalEntry,
  useGetJournalEntry,
  useListJournalEntries,
} from "@workspace/api-client-react";
import type { ListJournalEntriesParams, JournalEntry } from "@workspace/api-client-react";
import { BookOpen, Check, CircleAlert, Eye, Filter, Plus, Trash2 } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, Panel, PanelTitle, PageIntro, QueryError, QuerySkeleton, ShadowBadge } from "@/components/levelstory-ui";

const initialForm = {
  symbol: "MESU26",
  side: "long" as "long" | "short",
  setup: "",
  entryPrice: "",
  exitPrice: "",
  quantity: "1",
  pnl: "",
  notes: "",
  checklistPassed: false,
};

const initialFilters: ListJournalEntriesParams = { limit: 50 };

export default function Journal() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<ListJournalEntriesParams>(initialFilters);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");
  const entries = useListJournalEntries(filters);
  const detail = useGetJournalEntry(selectedId ?? 0, { query: { queryKey: ["journal-detail", selectedId], enabled: selectedId !== null } });
  const create = useCreateJournalEntry();
  const remove = useDeleteJournalEntry();
  const update = (key: keyof typeof initialForm, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const updateFilter = (key: keyof ListJournalEntriesParams, value: string) => {
    setSelectedId(null);
    setFilters((current) => ({ ...current, [key]: value || undefined, limit: 50 }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    create.mutate({
      data: {
        symbol: form.symbol.toUpperCase(),
        side: form.side,
        setup: form.setup,
        entryPrice: Number(form.entryPrice),
        exitPrice: form.exitPrice ? Number(form.exitPrice) : null,
        quantity: Number(form.quantity),
        pnl: form.pnl ? Number(form.pnl) : null,
        notes: form.notes,
        checklistPassed: form.checklistPassed,
      },
    }, {
      onSuccess: () => {
        setForm(initialForm);
        setMessage("Shadow review recorded.");
        queryClient.invalidateQueries({ queryKey: getListJournalEntriesQueryKey(filters) });
        queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() });
      },
      onError: () => setMessage("We couldn't save that review. Check the values and try again."),
    });
  };

  const deleteEntry = (id: number) => {
    if (!window.confirm("Delete this shadow review? This cannot be undone.")) return;
    remove.mutate({ id }, {
      onSuccess: () => {
        if (selectedId === id) setSelectedId(null);
        queryClient.invalidateQueries({ queryKey: getListJournalEntriesQueryKey(filters) });
        queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() });
      },
      onError: () => setMessage("We couldn't delete that review. Try again."),
    });
  };

  return (
    <LevelStoryShell>
      <div className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
        <div className="mx-auto max-w-[1500px]">
          <PageIntro
            eyebrow="Review room / no execution"
            title="Keep the receipts."
            description="Every setup evaluation becomes a chronological shadow record. Inspect the evidence, modeled fills, and outcome without sending an order anywhere."
            action={<ShadowBadge />}
          />

          <Panel className="mb-5">
            <PanelTitle eyebrow="Find a setup" title="Journal filters" right={<Filter size={17} className="text-muted-foreground" />} />
            <div className="grid gap-3 border-t border-border p-5 sm:grid-cols-2 lg:grid-cols-5">
              <FilterField label="Symbol">
                <input value={filters.symbol ?? ""} onChange={(event) => updateFilter("symbol", event.target.value.toUpperCase())} placeholder="MESU26" className="field mono" data-testid="input-filter-symbol" />
              </FilterField>
              <FilterField label="Setup type">
                <select value={filters.setupType ?? ""} onChange={(event) => updateFilter("setupType", event.target.value)} className="field" data-testid="select-filter-setup">
                  <option value="">All setup engines</option>
                  <option value="ORB_BREAK_PULLBACK_CONTINUATION">ORB break / pullback</option>
                  <option value="EXTENDED_NTZ_CONSOLIDATION_BREAKOUT">Extended NTZ consolidation</option>
                  <option value="BONUS_REVERSAL">Bonus reversal</option>
                </select>
              </FilterField>
              <FilterField label="Direction">
                <select value={filters.direction ?? ""} onChange={(event) => updateFilter("direction", event.target.value)} className="field" data-testid="select-filter-direction">
                  <option value="">Both directions</option>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </FilterField>
              <FilterField label="Outcome">
                <select value={filters.outcome ?? ""} onChange={(event) => updateFilter("outcome", event.target.value)} className="field" data-testid="select-filter-outcome">
                  <option value="">All outcomes</option>
                  <option value="qualified">Qualified</option>
                  <option value="rejected">Rejected</option>
                  <option value="expired">Expired</option>
                  <option value="ambiguous">Ambiguous</option>
                </select>
              </FilterField>
              <FilterField label="Trading date">
                <input type="date" value={filters.tradingDate ?? ""} onChange={(event) => updateFilter("tradingDate", event.target.value)} className="field mono" data-testid="input-filter-date" />
              </FilterField>
            </div>
          </Panel>

          <div className="grid gap-5 xl:grid-cols-[minmax(330px,.72fr)_minmax(0,1.28fr)]">
            <Panel accent>
              <PanelTitle eyebrow="Manual note" title="Record a shadow review" right={<BookOpen size={17} className="text-muted-foreground" />} />
              <form onSubmit={submit} className="space-y-4 border-t border-border p-5 sm:p-6">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Contract symbol"><input required maxLength={12} value={form.symbol} onChange={(event) => update("symbol", event.target.value)} className="field mono uppercase" data-testid="input-journal-symbol" /></Field>
                  <Field label="Side"><select value={form.side} onChange={(event) => update("side", event.target.value)} className="field" data-testid="select-journal-side"><option value="long">Long</option><option value="short">Short</option></select></Field>
                </div>
                <Field label="Setup name"><input required maxLength={80} placeholder="Opening range reclaim" value={form.setup} onChange={(event) => update("setup", event.target.value)} className="field" data-testid="input-journal-setup" /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Entry price"><input required type="number" min="0.01" step="0.01" placeholder="0.00" value={form.entryPrice} onChange={(event) => update("entryPrice", event.target.value)} className="field mono" data-testid="input-journal-entry-price" /></Field>
                  <Field label="Exit price"><input type="number" min="0.01" step="0.01" placeholder="Optional" value={form.exitPrice} onChange={(event) => update("exitPrice", event.target.value)} className="field mono" data-testid="input-journal-exit-price" /></Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Contracts"><input required type="number" min="1" step="1" value={form.quantity} onChange={(event) => update("quantity", event.target.value)} className="field mono" data-testid="input-journal-quantity" /></Field>
                  <Field label="Review P&amp;L"><input type="number" step="0.01" placeholder="Optional" value={form.pnl} onChange={(event) => update("pnl", event.target.value)} className="field mono" data-testid="input-journal-pnl" /></Field>
                </div>
                <Field label="Notes"><textarea required maxLength={2000} rows={4} placeholder="What did price confirm? What did you ignore?" value={form.notes} onChange={(event) => update("notes", event.target.value)} className="field resize-none" data-testid="textarea-journal-notes" /></Field>
                <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-muted/35 p-3">
                  <input type="checkbox" checked={form.checklistPassed} onChange={(event) => update("checklistPassed", event.target.checked)} className="mt-0.5 accent-[hsl(var(--accent))]" data-testid="checkbox-journal-checklist" />
                  <span><span className="block text-xs font-semibold">Checklist passed</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">I followed the plan before reviewing this trade.</span></span>
                </label>
                {message && <div className={`flex items-center gap-2 rounded-md p-3 text-xs ${message.includes("couldn't") ? "bg-destructive/10 text-destructive" : "bg-[hsl(var(--positive)/.1)] text-[hsl(var(--positive))]"}`} role="status" data-testid="status-journal-message">{message.includes("couldn't") ? <CircleAlert size={14} /> : <Check size={14} />}{message}</div>}
                <button type="submit" disabled={create.isPending} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50" data-testid="button-save-journal"><Plus size={15} />{create.isPending ? "Recording review..." : "Record shadow review"}</button>
                <LockedNote>This is a journal action, not an order action. Nothing is sent to a broker.</LockedNote>
              </form>
            </Panel>

            <Panel>
              <PanelTitle eyebrow="Automatic + manual record" title="Setup evaluations" right={<span className="text-xs text-muted-foreground">{entries.data?.length ?? 0} records</span>} />
              {entries.isLoading ? <QuerySkeleton rows={5} /> : entries.isError ? <QueryError onRetry={() => entries.refetch()} /> : entries.data?.length === 0 ? <EmptyJournal /> : (
                <div className="divide-y divide-border border-t border-border">
                  {entries.data?.map((entry) => <JournalCard key={entry.id} entry={entry} selected={selectedId === entry.id} onSelect={() => setSelectedId(entry.id)} onDelete={() => deleteEntry(entry.id)} />)}
                </div>
              )}
            </Panel>
          </div>

          {selectedId !== null && (
            <Panel className="mt-5" accent>
              {detail.isLoading ? <QuerySkeleton rows={6} /> : detail.isError || !detail.data ? <QueryError onRetry={() => detail.refetch()} message="This journal detail could not be loaded." /> : <JournalDetail entry={detail.data} />}
            </Panel>
          )}
        </div>
      </div>
    </LevelStoryShell>
  );
}

function JournalCard({ entry, selected, onSelect, onDelete }: { entry: JournalEntry; selected: boolean; onSelect: () => void; onDelete: () => void }) {
  const tone = entry.outcome === "qualified" ? "status-positive" : entry.outcome === "ambiguous" ? "text-accent-foreground" : entry.outcome === "expired" ? "text-muted-foreground" : "status-negative";
  return <article className={`group px-5 py-5 transition sm:px-6 ${selected ? "bg-muted/45" : "hover:bg-muted/25"}`} data-testid={`card-journal-entry-${entry.id}`}>
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <button type="button" onClick={onSelect} className="flex min-w-0 items-start gap-3 text-left" data-testid={`button-view-journal-${entry.id}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-bold">{entry.symbol.slice(0, 2)}</span>
        <span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold">{entry.symbol}</span><span className="rounded-sm bg-secondary px-2 py-1 text-[10px] font-bold uppercase">{entry.side}</span>{entry.outcome && <span className={`rounded-sm px-2 py-1 text-[10px] font-bold uppercase ${tone}`}>{entry.outcome}</span>}{entry.checklistPassed && <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[hsl(var(--positive))]"><Check size={12} />Plan held</span>}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{entry.setup} <span className="mx-1 text-border">/</span> {entry.tradingDate ?? new Date(entry.createdAt).toLocaleDateString()}</span></span>
      </button>
      <div className="flex items-center gap-4 sm:text-right"><div><div className={`mono text-sm font-medium ${entry.netPnl == null && entry.pnl == null ? "text-muted-foreground" : (entry.netPnl ?? entry.pnl ?? 0) >= 0 ? "status-positive" : "status-negative"}`}>{entry.netPnl == null && entry.pnl == null ? "No fill" : `${(entry.netPnl ?? entry.pnl ?? 0) >= 0 ? "+" : ""}$${(entry.netPnl ?? entry.pnl ?? 0).toFixed(2)}`}</div><div className="text-[10px] text-muted-foreground">{entry.contracts ?? entry.quantity} contracts</div></div><button type="button" onClick={onDelete} className="rounded-md p-2 text-muted-foreground opacity-100 transition hover:bg-destructive/10 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100" aria-label={`Delete ${entry.symbol} journal entry`} data-testid={`button-delete-journal-${entry.id}`}><Trash2 size={15} /></button></div>
    </div>
    <button type="button" onClick={onSelect} className="mt-4 flex w-full items-center gap-2 text-left text-xs leading-5 text-muted-foreground"><Eye size={13} />Open full evidence, timeline, and fill detail</button>
  </article>;
}

function JournalDetail({ entry }: { entry: JournalEntry }) {
  const rules = [...(entry.passedRules ?? []), ...(entry.failedRules ?? [])];
  return <div data-testid="journal-detail">
    <PanelTitle eyebrow="Selected record / shadow only" title={`${entry.symbol} · ${entry.setup}`} right={<span className="rounded-sm bg-secondary px-2 py-1 text-[10px] font-bold uppercase">{entry.outcome ?? "manual review"}</span>} />
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-6">
      <Metric label="Contract month" value={entry.contractMonth ?? "—"} />
      <Metric label="Trend" value={entry.trend ?? "—"} />
      <Metric label="Entry" value={entry.entryPrice.toFixed(2)} />
      <Metric label="Target" value={entry.profitTarget?.toFixed(2) ?? "—"} />
      <Metric label="MFE / MAE" value={`${entry.maximumFavorableExcursion?.toFixed(2) ?? "—"} / ${entry.maximumAdverseExcursion?.toFixed(2) ?? "—"}`} />
      <Metric label="Net result" value={entry.netPnl == null ? "No fill" : `$${entry.netPnl.toFixed(2)}`} />
    </div>
    <div className="grid gap-5 border-t border-border p-5 lg:grid-cols-[1.2fr_.8fr] sm:p-6">
      <div>
        <div className="eyebrow text-muted-foreground">Chronological Level Story</div>
        <div className="mt-3 divide-y divide-border rounded-sm border border-border" data-testid="journal-detail-timeline">
          {entry.timeline?.length ? entry.timeline.map((item, index) => <div key={`${item.time}-${index}`} className="flex gap-3 px-3 py-3"><span className="mono shrink-0 text-[10px] text-muted-foreground">{new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span><span className="block text-xs font-semibold">{item.label}</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{item.detail}</span></span></div>) : <div className="p-4 text-xs text-muted-foreground">No timeline events were recorded for this manual entry.</div>}
        </div>
      </div>
      <div className="space-y-4">
        <div><div className="eyebrow text-muted-foreground">Accounting</div><div className="mt-3 grid grid-cols-2 gap-2"><Metric label="Gross" value={money(entry.grossPnl)} /><Metric label="Fees" value={money(entry.fees)} /><Metric label="Slippage" value={money(entry.slippage)} /><Metric label="Exit" value={entry.exitReason ?? "—"} /></div></div>
        <div><div className="eyebrow text-muted-foreground">Execution</div><pre className="mt-3 max-h-48 overflow-auto rounded-sm bg-secondary/60 p-3 text-[10px] leading-4 text-muted-foreground">{entry.execution ? JSON.stringify(entry.execution, null, 2) : "No simulated fill was created."}</pre></div>
      </div>
    </div>
    <div className="grid gap-5 border-t border-border p-5 lg:grid-cols-3 sm:p-6">
      <Evidence title="Stops + runner" value={{ stops: entry.stops, runner: entry.runner }} />
      <Evidence title="Market evidence" value={{ levels: entry.levels, confluences: entry.confluences, ntz: entry.ntz, breakout: entry.breakout, pullback: entry.pullback }} />
      <Evidence title="Fib + volume + patience" value={{ fibonacci: entry.fibonacci, volume: entry.volume, patience: entry.patience }} />
    </div>
    <div className="border-t border-border p-5 sm:p-6"><div className="eyebrow text-muted-foreground">Rules and notes</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{rules.length ? rules.map((rule) => <div key={rule.key} className={`rounded-sm border p-3 ${rule.passed ? "border-[hsl(var(--positive)/.25)]" : "border-destructive/25"}`}><div className="flex items-center gap-2 text-xs font-semibold">{rule.passed ? <Check size={13} className="status-positive" /> : <CircleAlert size={13} className="status-negative" />}{rule.label}</div><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{rule.detail}</p></div>) : <p className="text-xs text-muted-foreground">No rule evidence was attached to this manual review.</p>}</div><p className="mt-5 max-w-4xl text-xs leading-5 text-muted-foreground">{entry.notes}</p><LockedNote>No live orders. This record describes a deterministic review and simulated fill only.</LockedNote></div>
  </div>;
}

function Evidence({ title, value }: { title: string; value: unknown }) {
  return <details className="rounded-sm border border-border p-3"><summary className="cursor-pointer text-xs font-semibold">{title}</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-[10px] leading-4 text-muted-foreground">{JSON.stringify(value, null, 2)}</pre></details>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="bg-card px-4 py-3"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mono mt-1 break-words text-xs font-medium">{value}</div></div>; }
function FilterField({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="eyebrow mb-1.5 block text-muted-foreground">{label}</span>{children}</label>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="eyebrow mb-1.5 block text-muted-foreground">{label}</span>{children}</label>; }
function money(value: number | null) { return value == null ? "—" : `$${value.toFixed(2)}`; }
function EmptyJournal() { return <div className="flex min-h-[420px] flex-col items-center justify-center px-8 text-center" data-testid="empty-journal"><div className="mb-5 flex h-14 w-14 items-center justify-center rounded-md bg-accent/20 text-foreground"><BookOpen size={24} /></div><h3 className="display text-xl font-bold">No setup records match.</h3><p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">Adjust the filters or create a manual shadow review to give the record room something real to learn from.</p></div>; }