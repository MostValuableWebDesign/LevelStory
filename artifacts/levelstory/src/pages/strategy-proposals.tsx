import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, GitPullRequest, LoaderCircle, LockKeyhole, Plus, RotateCcw, Send, ShieldCheck, UserRound, XCircle } from "lucide-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { Panel, PanelTitle, PageIntro, ShadowBadge } from "@/components/levelstory-ui";

type TeachingExample = {
  id: string;
  judgment: string;
  reviewerId: string;
  revision: number;
  formulaVersion: string;
  formulaHash: string;
  causalValidation: { valid?: boolean; messages?: string[] };
  createdAt: string;
};
type Proposal = {
  id: string;
  title: string;
  hypothesis: string;
  rationale: string;
  status: string;
  createdBy: string;
  plainLanguageSummary?: string;
  currentRule?: string;
  proposedRule?: string;
  sourceFormulaVersion?: string;
  supportingExampleIds?: string[];
  conflictingExampleIds?: string[];
  sourceTeachingIds: string[];
  validationRunId: string | null;
  candidateVersionId: string | null;
  rejectionReason: string | null;
  clarificationRequest: string | null;
  createdAt: string;
  updatedAt: string;
};
type ValidationRun = { id: string; status: string; warnings: string[]; conflicts: string[]; regressions: string[]; beforeMetrics?: Record<string, unknown> | null; afterMetrics?: Record<string, unknown> | null; completedAt?: string | null };
type Detail = { proposal: Proposal; auditEvents: Array<{ id: string; actorId: string; action: string; fromStatus: string | null; toStatus: string | null; reason: string | null; createdAt: string }>; validationRuns: ValidationRun[]; strategyVersion: Record<string, unknown> | null };

const statusTone: Record<string, string> = {
  draft: "border-border bg-muted/40 text-muted-foreground",
  clarification_requested: "border-[hsl(var(--warning)/.35)] bg-[hsl(var(--warning)/.08)] text-[hsl(var(--warning))]",
  validation_pending: "border-accent/35 bg-accent/10 text-accent-foreground",
  validation_running: "border-accent/35 bg-accent/10 text-accent-foreground",
  validation_passed: "border-[hsl(var(--positive)/.35)] bg-[hsl(var(--positive)/.1)] text-[hsl(var(--positive))]",
  validation_failed: "border-destructive/35 bg-destructive/10 text-destructive",
  approved: "border-[hsl(var(--positive)/.35)] bg-[hsl(var(--positive)/.1)] text-[hsl(var(--positive))]",
  candidate: "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  active: "border-[hsl(var(--positive)/.45)] bg-[hsl(var(--positive)/.16)] text-[hsl(var(--positive))]",
  rejected: "border-destructive/35 bg-destructive/10 text-destructive",
  retired: "border-border bg-muted/40 text-muted-foreground",
  rolled_back: "border-destructive/35 bg-destructive/10 text-destructive",
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  return body as T;
}

export default function StrategyProposals() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [teachings, setTeachings] = useState<TeachingExample[]>([]);
  const [versions, setVersions] = useState<Record<string, unknown>[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [authUser, setAuthUser] = useState<{ id: string; email: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [auth, nextProposals, nextTeachings, nextVersions] = await Promise.all([
        api<{ user: { id: string; email: string | null } | null }>("/auth/user"),
        api<Proposal[]>("/strategy-proposals"),
        api<TeachingExample[]>("/teaching-examples"),
        api<Record<string, unknown>[]>("/strategy-versions"),
      ]);
      setAuthUser(auth.user);
      setProposals(nextProposals);
      setTeachings(nextTeachings);
      setVersions(nextVersions);
      const nextId = selectedId && nextProposals.some((item) => item.id === selectedId) ? selectedId : nextProposals[0]?.id ?? "";
      setSelectedId(nextId);
      if (nextId) setDetail(await api<Detail>(`/strategy-proposals/${nextId}`));
      else setDetail(null);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load strategy governance.");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { void load(); }, [load]);

  const selectProposal = async (id: string) => {
    setSelectedId(id);
    setMessage("");
    try { setDetail(await api<Detail>(`/strategy-proposals/${id}`)); } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load proposal."); }
  };
  const runAction = async (action: string, reason = "") => {
    if (!selectedId) return;
    setMessage("");
    try {
      const result = await api<Detail | Proposal | { proposal: Proposal; version: Record<string, unknown> }>(`/strategy-proposals/${selectedId}/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": `${selectedId}:${action}:${Date.now()}` },
        body: JSON.stringify(reason ? { reason } : {}),
      });
      if (action === "validate") setMessage("Validation queued. This page will refresh shortly.");
      else setMessage(`${action.replaceAll("_", " ")} completed.`);
      const nextProposal = "proposal" in result ? result.proposal : "status" in result ? result : null;
      if (nextProposal) setProposals((current) => current.map((item) => item.id === nextProposal.id ? nextProposal : item));
      setTimeout(() => void selectProposal(selectedId), action === "validate" ? 500 : 0);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The governance action could not be completed."); }
  };
  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const sourceTeachingIds = form.getAll("sourceTeachingIds").map(String);
    setCreating(true);
    try {
      const proposal = await api<Proposal>("/strategy-proposals", {
        method: "POST",
        headers: { "Idempotency-Key": `proposal:${crypto.randomUUID()}` },
        body: JSON.stringify({ title: String(form.get("title")), hypothesis: String(form.get("hypothesis")), rationale: String(form.get("rationale")), sourceTeachingIds, proposalPayload: { mode: "shadow_only", source: "human_teaching" } }),
      });
      setShowCreate(false);
      setMessage("Draft proposal created. Validation is still required.");
      await load();
      await selectProposal(proposal.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The proposal could not be created."); }
    finally { setCreating(false); }
  };

  const latestRun = detail?.validationRuns[0];
  const activeCount = versions.filter((item) => item.status === "active").length;
  if (message.includes("Authentication is required")) {
    return <LevelStoryShell><main className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-8 sm:px-7 lg:px-9"><div className="mx-auto max-w-[1180px]"><PageIntro eyebrow="Phase 13 / governed change" title="Strategy proposals require a login." description="Evidence remains readable only to authenticated reviewers, and approval or activation is separately authorized." action={<ShadowBadge />} /><Panel accent><div className="flex flex-col items-center gap-4 px-6 py-16 text-center"><LockKeyhole className="text-accent" size={28} /><p className="max-w-md text-sm text-muted-foreground">Sign in to review persistent teaching evidence and move advisory proposals through validation, approval, candidate publication, and Shadow Mode activation.</p><a className="rounded-md bg-primary px-4 py-2 text-xs font-bold text-primary-foreground" href={`/api/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>Log in</a></div></Panel></div></main></LevelStoryShell>;
  }

  return <LevelStoryShell>
    <main className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
      <div className="mx-auto max-w-[1480px]">
        <PageIntro eyebrow="Phase 13 / governed change" title="Strategy proposals." description="Human teaching can suggest a rule review. It cannot change the executable formula. Every proposal is validated, approved, published as a Shadow Mode candidate, and activated through separate audited actions." action={<ShadowBadge />} />
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <Metric label="Drafts & review" value={proposals.filter((item) => ["draft", "clarification_requested"].includes(item.status)).length} />
          <Metric label="Validation queue" value={proposals.filter((item) => ["validation_pending", "validation_running"].includes(item.status)).length} />
          <Metric label="Candidates" value={proposals.filter((item) => item.status === "candidate").length} />
          <Metric label="Active Shadow versions" value={activeCount} />
        </div>
        {message && <div className="mb-5 flex items-start gap-2 border border-accent/30 bg-accent/8 px-4 py-3 text-xs leading-5" role="status"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-accent" />{message}</div>}
        <div className="grid gap-5 xl:grid-cols-[minmax(300px,.58fr)_minmax(0,1.42fr)]">
          <Panel>
            <div className="flex items-center justify-between gap-3 px-5 py-4 sm:px-6"><PanelTitle eyebrow="Persistent queue" title="Proposals" right={<button type="button" onClick={() => setShowCreate(true)} disabled={!authUser || teachings.length === 0} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[10px] font-bold uppercase tracking-[.08em] text-primary-foreground disabled:opacity-45"><Plus size={13} />New</button>} /></div>
            {loading ? <div className="flex items-center gap-2 border-t border-border px-5 py-8 text-xs text-muted-foreground"><LoaderCircle size={14} className="animate-spin" />Loading governance records…</div> : proposals.length === 0 ? <div className="border-t border-border px-5 py-10 text-center text-xs leading-5 text-muted-foreground">{teachings.length ? "No proposals yet. Turn structured teaching into a draft for review." : "Persist a valid teaching example in Visual Review before creating a proposal."}</div> : <div className="divide-y divide-border border-t border-border">{proposals.map((item) => <button key={item.id} type="button" onClick={() => void selectProposal(item.id)} className={`w-full px-5 py-4 text-left transition hover:bg-muted/40 ${selectedId === item.id ? "bg-accent/10" : ""}`}><div className="flex items-start justify-between gap-3"><span className="min-w-0 text-xs font-bold leading-5">{item.title}</span><StatusPill status={item.status} /></div><span className="mono mt-2 block text-[9px] text-muted-foreground">{item.sourceTeachingIds.length} evidence source{item.sourceTeachingIds.length === 1 ? "" : "s"} · updated {new Date(item.updatedAt).toLocaleDateString()}</span></button>)}</div>}
          </Panel>
          <div className="space-y-5">
            {detail ? <ProposalDetail detail={detail} latestRun={latestRun} onAction={runAction} teachings={teachings} /> : <Panel accent><div className="flex min-h-[360px] flex-col items-center justify-center px-8 text-center"><GitPullRequest size={24} className="mb-4 text-accent" /><h2 className="display text-xl font-bold">No proposal selected.</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">Select a proposal or create one from a persisted teaching example.</p></div></Panel>}
          </div>
        </div>
      </div>
    </main>
    {showCreate && <CreateProposalModal teachings={teachings} pending={creating} onClose={() => setShowCreate(false)} onSubmit={create} />}
  </LevelStoryShell>;
}

function ProposalDetail({ detail, latestRun, onAction, teachings }: { detail: Detail; latestRun?: ValidationRun; onAction: (action: string, reason?: string) => void; teachings: TeachingExample[] }) {
  const { proposal } = detail;
  const sources = useMemo(() => teachings.filter((item) => proposal.sourceTeachingIds.includes(item.id)), [proposal.sourceTeachingIds, teachings]);
  const [reason, setReason] = useState("");
  const canValidate = ["draft", "validation_failed", "clarification_requested"].includes(proposal.status);
  const canApprove = proposal.status === "validation_passed";
  const canPublish = proposal.status === "approved";
  const canActivate = proposal.status === "candidate";
  const canRetire = ["candidate", "active"].includes(proposal.status);
  return <div className="space-y-5">
    <Panel>
      <div className="border-b border-border px-5 py-5 sm:px-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="eyebrow text-muted-foreground">Advisory proposal / {proposal.id.slice(0, 8)}</div><h2 className="display mt-1 text-2xl font-bold">{proposal.title}</h2></div><StatusPill status={proposal.status} /></div><p className="mt-4 max-w-3xl text-sm leading-6 text-muted-foreground">{proposal.hypothesis}</p></div>
      <div className="grid gap-4 border-b border-border px-5 py-5 sm:grid-cols-3 sm:px-6"><InfoCell label="Created by" value={proposal.createdBy} icon={<UserRound size={13} />} /><InfoCell label="Evidence sources" value={`${sources.length} immutable example${sources.length === 1 ? "" : "s"}`} icon={<ShieldCheck size={13} />} /><InfoCell label="Executable impact" value="None until separately activated" icon={<LockKeyhole size={13} />} /></div>
       <div className="space-y-5 px-5 py-5 sm:px-6"><div><div className="eyebrow text-muted-foreground">Plain-language proposal</div><p className="mt-2 whitespace-pre-wrap text-xs leading-5">{proposal.plainLanguageSummary || proposal.hypothesis}</p></div><div className="grid gap-4 md:grid-cols-2"><RuleCell label="Current rule" value={proposal.currentRule || "Current deterministic formula"} /><RuleCell label="Proposed rule" value={proposal.proposedRule || proposal.hypothesis} /></div><div className="grid gap-3 sm:grid-cols-3"><InfoCell label="Source formula" value={proposal.sourceFormulaVersion || "Recorded in evidence"} icon={<GitPullRequest size={13} />} /><InfoCell label="Supporting examples" value={String(proposal.supportingExampleIds?.length ?? sources.length)} icon={<CheckCircle2 size={13} />} /><InfoCell label="Conflicting examples" value={String(proposal.conflictingExampleIds?.length ?? 0)} icon={<AlertTriangle size={13} />} /></div><div><div className="eyebrow text-muted-foreground">Rationale</div><p className="mt-2 whitespace-pre-wrap text-xs leading-5">{proposal.rationale}</p></div>{proposal.clarificationRequest && <div className="border border-[hsl(var(--warning)/.35)] bg-[hsl(var(--warning)/.08)] px-3 py-3 text-xs leading-5"><strong>Clarification requested:</strong> {proposal.clarificationRequest}</div>}{proposal.rejectionReason && <div className="border border-destructive/30 bg-destructive/8 px-3 py-3 text-xs leading-5"><strong>Rejected:</strong> {proposal.rejectionReason}</div>}</div>
      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-4 sm:px-6">
        {canValidate && <ActionButton icon={<RotateCcw size={13} />} onClick={() => onAction("validate")}>Queue validation</ActionButton>}
        {canApprove && <ActionButton icon={<CheckCircle2 size={13} />} onClick={() => onAction("approve", reason || "Approved after required validation passed.")}>Approve</ActionButton>}
        {canPublish && <ActionButton icon={<Send size={13} />} onClick={() => onAction("publish")}>Publish candidate</ActionButton>}
        {canActivate && <ActionButton icon={<ShieldCheck size={13} />} onClick={() => onAction("activate")}>Activate Shadow Mode</ActionButton>}
        {canRetire && <ActionButton icon={<XCircle size={13} />} onClick={() => onAction("retire")}>Retire</ActionButton>}
        {["draft", "validation_failed", "validation_passed"].includes(proposal.status) && <ActionButton icon={<AlertTriangle size={13} />} onClick={() => onAction("clarification", reason || "Please clarify the proposed causal rule boundary.")}>Request clarification</ActionButton>}
        {["active", "candidate", "retired"].includes(proposal.status) && <ActionButton icon={<RotateCcw size={13} />} onClick={() => onAction("rollback", reason || "Rollback requested for Shadow Mode review.")}>Rollback</ActionButton>}
      </div>
      {(["validation_passed", "approved", "draft", "validation_failed"].includes(proposal.status)) && <div className="border-t border-border px-5 py-4 sm:px-6"><label className="eyebrow block text-muted-foreground">Decision note <span className="normal-case tracking-normal">(used for approval, clarification, or rollback)</span></label><textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={4000} className="field mt-2 resize-none" placeholder="Record the reason for the next governance action." /></div>}
    </Panel>
    <div className="grid gap-5 lg:grid-cols-2">
       <Panel><PanelTitle eyebrow="Validation / asynchronous" title="Evidence gate" right={latestRun ? <StatusPill status={latestRun.status} /> : <Clock3 size={15} className="text-muted-foreground" />} />{latestRun ? <div className="space-y-3 border-t border-border px-5 py-4 text-xs sm:px-6"><div className="flex items-center gap-2"><ValidationIcon status={latestRun.status} /><span>{latestRun.status === "queued" || latestRun.status === "running" ? "Validation is still running; approval remains blocked." : latestRun.status === "passed" ? "Required validation passed. An approver may now review this proposal." : "Validation failed. Resolve the evidence conflict before approval."}</span></div><div className="grid gap-2 sm:grid-cols-2"><MetricLine label="Warnings" value={latestRun.warnings.length} /><MetricLine label="Conflicts" value={latestRun.conflicts.length} /><MetricLine label="Regressions" value={latestRun.regressions.length} /><MetricLine label="Before sample" value={metricNumber(latestRun.beforeMetrics, "sampleCount")} /><MetricLine label="After sample" value={metricNumber(latestRun.afterMetrics, "sampleCount")} /><MetricLine label="Trades added" value={metricNumber(latestRun.afterMetrics, "tradesAdded")} /><MetricLine label="Trades removed" value={metricNumber(latestRun.afterMetrics, "tradesRemoved")} /><MetricLine label="Drawdown delta" value={metricNumber(latestRun.afterMetrics, "drawdownDelta")} /></div>{[...latestRun.conflicts, ...latestRun.regressions, ...latestRun.warnings].map((item) => <div key={item} className="border-l-2 border-accent/50 pl-3 text-muted-foreground">{item}</div>)}</div> : <div className="border-t border-border px-5 py-6 text-xs leading-5 text-muted-foreground sm:px-6">No validation run exists. Validation is required before approval and does not alter the active formula.</div>}</Panel>
      <Panel><PanelTitle eyebrow="Sources / immutable" title="Teaching evidence" right={<span className="mono text-[10px] text-muted-foreground">{sources.length}</span>} />{sources.length ? <div className="divide-y divide-border border-t border-border">{sources.map((source) => <div key={source.id} className="px-5 py-3 text-xs sm:px-6"><div className="flex items-center justify-between gap-3"><span className="font-bold">{source.judgment.replaceAll("_", " ")}</span><span className="mono text-[9px] text-muted-foreground">revision {source.revision}</span></div><div className="mono mt-1 text-[9px] text-muted-foreground">{source.formulaVersion} · {source.id.slice(0, 12)} · reviewer {source.reviewerId.slice(0, 10)}</div><div className={`mt-2 text-[10px] ${source.causalValidation.valid ? "text-[hsl(var(--positive))]" : "text-destructive"}`}>{source.causalValidation.valid ? "Causal validation passed" : source.causalValidation.messages?.join(" ") || "Causal validation failed"}</div></div>)}</div> : <div className="border-t border-border px-5 py-6 text-xs text-muted-foreground">Source examples are unavailable.</div>}</Panel>
    </div>
    <Panel><PanelTitle eyebrow="Audit / append-only" title="Decision history" right={<span className="mono text-[10px] text-muted-foreground">{detail.auditEvents.length} events</span>} />{detail.auditEvents.length ? <div className="divide-y divide-border border-t border-border">{detail.auditEvents.map((event) => <div key={event.id} className="flex items-start gap-3 px-5 py-3 text-xs sm:px-6"><div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /><div className="min-w-0"><div className="font-bold">{event.action.replaceAll("_", " ")} <span className="font-normal text-muted-foreground">{event.fromStatus ? `${event.fromStatus} → ` : ""}{event.toStatus ?? ""}</span></div><div className="mono mt-1 text-[9px] text-muted-foreground">{event.actorId} · {new Date(event.createdAt).toLocaleString()}</div>{event.reason && <div className="mt-1 text-muted-foreground">{event.reason}</div>}</div></div>)}</div> : <div className="border-t border-border px-5 py-6 text-xs text-muted-foreground">No audit events yet.</div>}</Panel>
  </div>;
}

function CreateProposalModal({ teachings, pending, onClose, onSubmit }: { teachings: TeachingExample[]; pending: boolean; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4"><div className="w-full max-w-2xl border border-border bg-card shadow-2xl"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><div className="eyebrow text-muted-foreground">New advisory proposal</div><h2 className="mt-1 text-base font-bold">Keep the hypothesis separate from execution.</h2></div><button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close proposal form">×</button></div><form onSubmit={onSubmit} className="space-y-4 px-5 py-5"><Field name="title" label="Proposal title" placeholder="e.g. Review 3-tick continuation confirmation" required /><Field name="hypothesis" label="Hypothesis" placeholder="What deterministic boundary should be investigated?" required /><label className="block"><span className="eyebrow block text-muted-foreground">Rationale</span><textarea name="rationale" required rows={4} className="field mt-1.5 resize-none" placeholder="Describe the causal evidence and why it deserves validation." /></label><label className="block"><span className="eyebrow block text-muted-foreground">Source teaching examples</span><select name="sourceTeachingIds" multiple required className="field mt-1.5 h-28">{teachings.map((teaching) => <option key={teaching.id} value={teaching.id}>{teaching.judgment.replaceAll("_", " ")} · revision {teaching.revision} · {teaching.id.slice(0, 10)}</option>)}</select><span className="mt-1 block text-[10px] text-muted-foreground">Hold Ctrl/Cmd to select independent examples.</span></label><div className="flex items-center justify-between gap-3 border-t border-border pt-4"><span className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground"><LockKeyhole size={13} className="mt-0.5 shrink-0" />Creating a draft never changes the active Shadow Mode formula.</span><div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-2 text-[10px] font-bold uppercase">Cancel</button><button type="submit" disabled={pending} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-[10px] font-bold uppercase text-primary-foreground disabled:opacity-50">{pending && <LoaderCircle size={13} className="animate-spin" />}Create draft</button></div></div></form></div></div>;
}

function Field({ name, label, placeholder, required }: { name: string; label: string; placeholder: string; required?: boolean }) { return <label className="block"><span className="eyebrow block text-muted-foreground">{label}</span><input name={name} required={required} className="field mt-1.5" placeholder={placeholder} /></label>; }
function Metric({ label, value }: { label: string; value: number }) { return <div className="border border-border bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">{label}</div><div className="display mt-1 text-2xl font-bold">{value}</div></div>; }
function MetricLine({ label, value }: { label: string; value: number | string }) { return <div className="flex items-center justify-between border-b border-border/70 pb-2"><span className="text-muted-foreground">{label}</span><strong className={value !== 0 && value !== "—" ? "text-accent-foreground" : "text-[hsl(var(--positive))]"}>{value}</strong></div>; }
function InfoCell({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) { return <div><div className="eyebrow flex items-center gap-1.5 text-muted-foreground">{icon}{label}</div><div className="mono mt-1 text-[10px]">{value}</div></div>; }
function RuleCell({ label, value }: { label: string; value: string }) { return <div className="border border-border bg-muted/20 px-3 py-3"><div className="eyebrow text-muted-foreground">{label}</div><p className="mt-2 text-xs leading-5">{value}</p></div>; }
function metricNumber(metrics: Record<string, unknown> | null | undefined, key: string): number | string { const value = metrics?.[key]; return typeof value === "number" ? value : "—"; }
function StatusPill({ status }: { status: string }) { return <span className={`whitespace-nowrap rounded-md border px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] ${statusTone[status] ?? statusTone.draft}`}>{status.replaceAll("_", " ")}</span>; }
function ValidationIcon({ status }: { status: string }) { return status === "passed" ? <CheckCircle2 size={15} className="text-[hsl(var(--positive))]" /> : status === "failed" ? <XCircle size={15} className="text-destructive" /> : <LoaderCircle size={15} className="animate-spin text-accent" />; }
function ActionButton({ children, onClick, icon }: { children: React.ReactNode; onClick: () => void; icon: React.ReactNode }) { return <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[.07em] transition hover:border-accent hover:bg-accent/8">{icon}{children}</button>; }