import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateJournalEntry, useDeleteJournalEntry, useListJournalEntries, getGetDashboardOverviewQueryKey, getListJournalEntriesQueryKey } from "@workspace/api-client-react";
import { BookOpen, Check, CircleAlert, ListFilter, Plus, Trash2 } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, Panel, PanelTitle, PageIntro, QueryError, QuerySkeleton, ShadowBadge } from "@/components/levelstory-ui";

const initialForm = { symbol: "AAPL", side: "long" as "long" | "short", setup: "", entryPrice: "", exitPrice: "", quantity: "1", pnl: "", notes: "", checklistPassed: false };

export default function Journal() {
  const queryClient = useQueryClient();
  const entries = useListJournalEntries({ limit: 50 });
  const create = useCreateJournalEntry();
  const remove = useDeleteJournalEntry();
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");
  const update = (key: keyof typeof initialForm, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    create.mutate({ data: { symbol: form.symbol.toUpperCase(), side: form.side, setup: form.setup, entryPrice: Number(form.entryPrice), exitPrice: form.exitPrice ? Number(form.exitPrice) : null, quantity: Number(form.quantity), pnl: form.pnl ? Number(form.pnl) : null, notes: form.notes, checklistPassed: form.checklistPassed } }, {
      onSuccess: () => { setForm(initialForm); setMessage("Shadow review recorded."); queryClient.invalidateQueries({ queryKey: getListJournalEntriesQueryKey({ limit: 50 }) }); queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() }); },
      onError: () => setMessage("We couldn't save that review. Check the values and try again."),
    });
  };
  const deleteEntry = (id: number) => {
    if (!window.confirm("Delete this shadow review? This cannot be undone.")) return;
    remove.mutate({ id }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListJournalEntriesQueryKey({ limit: 50 }) }); queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() }); }, onError: () => setMessage("We couldn't delete that review. Try again.") });
  };

  return <LevelStoryShell><div className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8"><div className="mx-auto max-w-[1500px]">
    <PageIntro eyebrow="Review room / no execution" title="Keep the receipts." description="Record what you saw, what you did, and whether the setup deserved your attention. Shadow trades are reviews only." action={<ShadowBadge />} />
    <div className="grid gap-5 xl:grid-cols-[minmax(330px,.72fr)_minmax(0,1.28fr)]">
      <Panel accent>
        <PanelTitle eyebrow="New entry" title="Record a shadow trade" right={<BookOpen size={17} className="text-muted-foreground" />} />
        <form onSubmit={submit} className="space-y-4 border-t border-border p-5 sm:p-6">
          <div className="grid grid-cols-2 gap-3"><Field label="Symbol"><input required maxLength={12} value={form.symbol} onChange={(e) => update("symbol", e.target.value)} className="field mono uppercase" data-testid="input-journal-symbol" /></Field><Field label="Side"><select value={form.side} onChange={(e) => update("side", e.target.value)} className="field" data-testid="select-journal-side"><option value="long">Long</option><option value="short">Short</option></select></Field></div>
          <Field label="Setup name"><input required maxLength={80} placeholder="Opening range reclaim" value={form.setup} onChange={(e) => update("setup", e.target.value)} className="field" data-testid="input-journal-setup" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Entry price"><input required type="number" min="0.01" step="0.01" placeholder="0.00" value={form.entryPrice} onChange={(e) => update("entryPrice", e.target.value)} className="field mono" data-testid="input-journal-entry-price" /></Field><Field label="Exit price"><input type="number" min="0.01" step="0.01" placeholder="Optional" value={form.exitPrice} onChange={(e) => update("exitPrice", e.target.value)} className="field mono" data-testid="input-journal-exit-price" /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label="Quantity"><input required type="number" min="1" step="1" value={form.quantity} onChange={(e) => update("quantity", e.target.value)} className="field mono" data-testid="input-journal-quantity" /></Field><Field label="Review P&amp;L"><input type="number" step="0.01" placeholder="Optional" value={form.pnl} onChange={(e) => update("pnl", e.target.value)} className="field mono" data-testid="input-journal-pnl" /></Field></div>
          <Field label="Notes"><textarea required maxLength={2000} rows={4} placeholder="What did price confirm? What did you ignore?" value={form.notes} onChange={(e) => update("notes", e.target.value)} className="field resize-none" data-testid="textarea-journal-notes" /></Field>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-muted/35 p-3"><input type="checkbox" checked={form.checklistPassed} onChange={(e) => update("checklistPassed", e.target.checked)} className="mt-0.5 accent-[hsl(var(--accent))]" data-testid="checkbox-journal-checklist" /><span><span className="block text-xs font-semibold">Checklist passed</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">I followed the plan before reviewing this trade.</span></span></label>
          {message && <div className={`flex items-center gap-2 rounded-md p-3 text-xs ${message.includes("couldn't") ? "bg-destructive/10 text-destructive" : "bg-[hsl(var(--positive)/.1)] text-[hsl(var(--positive))]"}`} role="status" data-testid="status-journal-message">{message.includes("couldn't") ? <CircleAlert size={14} /> : <Check size={14} />}{message}</div>}
          <button type="submit" disabled={create.isPending} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50" data-testid="button-save-journal"><Plus size={15} />{create.isPending ? "Recording review..." : "Record shadow review"}</button>
          <LockedNote>This is a journal action, not an order action. Nothing is sent to a broker.</LockedNote>
        </form>
      </Panel>
      <Panel>
        <PanelTitle eyebrow="Your record" title="Recent shadow reviews" right={<span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><ListFilter size={14} />{entries.data?.length ?? 0} entries</span>} />
        {entries.isLoading ? <QuerySkeleton rows={5} /> : entries.isError ? <QueryError onRetry={() => entries.refetch()} /> : entries.data?.length === 0 ? <EmptyJournal /> : <div className="divide-y divide-border border-t border-border">{entries.data?.map((entry) => <article key={entry.id} className="group px-5 py-5 sm:px-6" data-testid={`card-journal-entry-${entry.id}`}><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div className="flex items-start gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-xs font-bold">{entry.symbol.slice(0, 2)}</span><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-bold">{entry.symbol}</h3><span className="rounded-sm bg-secondary px-2 py-1 text-[10px] font-bold uppercase">{entry.side}</span>{entry.checklistPassed && <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[hsl(var(--positive))]"><Check size={12} />Plan held</span>}</div><p className="mt-1 text-xs text-muted-foreground">{entry.setup} <span className="mx-1 text-border">/</span> {new Date(entry.createdAt).toLocaleDateString()}</p></div></div><div className="flex items-center gap-4 sm:text-right"><div><div className={`mono text-sm font-medium ${entry.pnl == null ? "text-muted-foreground" : entry.pnl >= 0 ? "status-positive" : "status-negative"}`}>{entry.pnl == null ? "—" : `${entry.pnl >= 0 ? "+" : ""}$${entry.pnl.toFixed(2)}`}</div><div className="text-[10px] text-muted-foreground">{entry.quantity} shares</div></div><button type="button" onClick={() => deleteEntry(entry.id)} disabled={remove.isPending} className="rounded-md p-2 text-muted-foreground opacity-100 transition hover:bg-destructive/10 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100" aria-label={`Delete ${entry.symbol} journal entry`} data-testid={`button-delete-journal-${entry.id}`}><Trash2 size={15} /></button></div></div><p className="mt-4 max-w-3xl text-xs leading-5 text-muted-foreground">{entry.notes}</p></article>)}</div>}
      </Panel>
    </div>
  </div></div></LevelStoryShell>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="eyebrow mb-1.5 block text-muted-foreground">{label}</span>{children}</label>; }
function EmptyJournal() { return <div className="flex min-h-[420px] flex-col items-center justify-center px-8 text-center" data-testid="empty-journal"><div className="mb-5 flex h-14 w-14 items-center justify-center rounded-md bg-accent/20 text-foreground"><BookOpen size={24} /></div><h3 className="display text-xl font-bold">A blank page is useful.</h3><p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">Your first shadow review will give tomorrow's discipline something real to learn from.</p></div>; }