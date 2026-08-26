import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetRiskSettingsQueryKey, useGetRiskSettings, useUpdateRiskSettings } from "@workspace/api-client-react";
import { Check, Info, LockKeyhole, Save, ShieldCheck } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, Panel, PanelTitle, PageIntro, QueryError, QuerySkeleton, ShadowBadge } from "@/components/levelstory-ui";

export default function Settings() {
  const queryClient = useQueryClient();
  const settings = useGetRiskSettings();
  const update = useUpdateRiskSettings();
  const [form, setForm] = useState({ accountSize: "", riskPercent: "", maxDailyLoss: "" });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (settings.data) setForm({ accountSize: String(settings.data.accountSize), riskPercent: String(settings.data.riskPercent), maxDailyLoss: String(settings.data.maxDailyLoss) }); }, [settings.data]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    setError("");
    update.mutate({ data: { accountSize: Number(form.accountSize), riskPercent: Number(form.riskPercent), maxDailyLoss: Number(form.maxDailyLoss) } }, { onSuccess: (data) => { queryClient.setQueryData(getGetRiskSettingsQueryKey(), data); setSaved(true); }, onError: () => setError("Guardrails could not be saved. Check the values and try again.") });
  };
  return <LevelStoryShell><div className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8"><div className="mx-auto max-w-[1180px]">
    <PageIntro eyebrow="Rules of engagement / always yours" title="Protect the decision-maker." description="Set the limits that keep a simulated session useful. These guardrails make restraint visible; they never optimize or place an order." action={<ShadowBadge />} />
    {settings.isLoading ? <Panel><QuerySkeleton rows={4} /></Panel> : settings.isError || !settings.data ? <Panel><QueryError onRetry={() => settings.refetch()} /></Panel> : <div className="grid gap-5 lg:grid-cols-[1.08fr_.92fr]">
      <Panel accent><PanelTitle eyebrow="Account boundaries" title="Risk guardrails" right={settings.data.isLocked ? <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground"><LockKeyhole size={13} />Locked</span> : <ShieldCheck size={17} className="text-muted-foreground" />} />
        <form onSubmit={submit} className="space-y-6 border-t border-border p-5 sm:p-7">
          <Field label="Practice account size" hint="The notional account used for simulation."><div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span><input required type="number" min="0.01" step="0.01" value={form.accountSize} disabled={settings.data.isLocked} onChange={(e) => setForm({ ...form, accountSize: e.target.value })} className="field mono pl-7" data-testid="input-account-size" /></div></Field>
          <Field label="Risk per idea" hint="A percentage of account size. Smaller keeps reps repeatable."><div className="relative"><input required type="number" min="0.01" max="100" step="0.01" value={form.riskPercent} disabled={settings.data.isLocked} onChange={(e) => setForm({ ...form, riskPercent: e.target.value })} className="field mono pr-8" data-testid="input-risk-percent" /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span></div></Field>
          <Field label="Maximum daily loss" hint="Once reached, the session is over. The best next move is a reset."><div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span><input required type="number" min="0.01" step="0.01" value={form.maxDailyLoss} disabled={settings.data.isLocked} onChange={(e) => setForm({ ...form, maxDailyLoss: e.target.value })} className="field mono pl-7" data-testid="input-max-daily-loss" /></div></Field>
          {settings.data.isLocked ? <LockedNote>Your guardrails are currently locked for this session. LevelStory will always keep Shadow Mode explicit.</LockedNote> : <button type="submit" disabled={update.isPending} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50" data-testid="button-save-settings"><Save size={15} />{update.isPending ? "Saving guardrails..." : "Save guardrails"}</button>}
          {saved && <div className="flex items-center gap-2 text-xs font-semibold text-[hsl(var(--positive))]" role="status" data-testid="status-settings-saved"><Check size={15} />Guardrails saved for Shadow Mode.</div>}
          {error && <div className="flex items-center gap-2 text-xs font-semibold text-destructive" role="alert" data-testid="status-settings-error"><Info size={15} />{error}</div>}
        </form>
      </Panel>
      <div className="space-y-5">
        <Panel><PanelTitle eyebrow="Current session" title="Usage so far" right={<Info size={16} className="text-muted-foreground" />} /><div className="space-y-5 border-t border-border p-5 sm:p-6"><div className="grid grid-cols-2 gap-3"><Metric label="Daily loss used" value={`$${settings.data.dailyLossUsed.toFixed(2)}`} /><Metric label="Loss ceiling" value={`$${settings.data.maxDailyLoss.toFixed(2)}`} /></div><div><div className="mb-2 flex justify-between text-xs"><span className="text-muted-foreground">Guardrail usage</span><span className="mono">{Math.round((settings.data.dailyLossUsed / settings.data.maxDailyLoss) * 100)}%</span></div><div className="h-2 rounded-full bg-muted"><div className="h-full rounded-full bg-[hsl(var(--positive))] transition-all" style={{ width: `${Math.min(settings.data.dailyLossUsed / settings.data.maxDailyLoss * 100, 100)}%` }} /></div></div><p className="text-xs leading-5 text-muted-foreground">Usage reflects reviewed shadow trades, never broker activity.</p></div></Panel>
        <Panel className="bg-primary text-primary-foreground"><div className="p-5 sm:p-6"><div className="eyebrow text-primary-foreground/50">Provider readiness</div><h2 className="display mt-2 text-xl font-bold">Ready for context, not connection.</h2><p className="mt-3 text-xs leading-5 text-primary-foreground/70">LevelStory can eventually read provider data for richer simulation context. It will not become an execution terminal. Your practice stays safely one step removed.</p><div className="mt-5 flex items-center gap-2 text-xs font-semibold text-accent"><span className="h-1.5 w-1.5 rounded-full bg-accent" />No provider connected</div></div></Panel>
      </div>
    </div>}
  </div></div></LevelStoryShell>;
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) { return <label className="block"><span className="block text-sm font-bold">{label}</span><span className="mt-1 mb-2 block text-xs leading-5 text-muted-foreground">{hint}</span>{children}</label>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-md bg-muted/60 p-3"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-lg font-medium">{value}</div></div>; }