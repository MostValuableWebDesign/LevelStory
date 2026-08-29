import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Download,
  FileSearch,
  Fingerprint,
  Info,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  Minimize2,
  MoveLeft,
  MoveRight,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCreateVisualValidationSet,
  useExportVisualValidationDiscrepancies,
  useGetVisualValidationSet,
  useRecordVisualValidationReview,
} from "@workspace/api-client-react";
import type {
  VisualValidationAnnotation,
  VisualValidationCategory,
  VisualValidationDiscrepancyReport,
  VisualValidationRequest,
  VisualValidationReviewStatus,
  VisualValidationSet,
  VisualValidationSnapshot,
} from "@workspace/api-client-react";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, Panel, PanelTitle, PageIntro, QueryError, QuerySkeleton, ShadowBadge } from "@/components/levelstory-ui";
import {
  CHART_HEIGHT,
  CHART_LEFT,
  CHART_PLOT_BOTTOM,
  CHART_RIGHT,
  CHART_TOP,
  CHART_DATE_LABEL_Y,
  CHART_FOOTER_LABEL_Y,
  CHART_TIME_TICK_Y,
  CHART_VOLUME_HEIGHT,
  CHART_VOLUME_TOP,
  CHART_WIDTH,
  PREMARKET_SLOT_COUNT,
  findCandleIndexAtTimestamp,
  formatCandleTime,
  formatInterval,
  formatPriceAxisValue,
  formatDataSource,
  getCandleInspection,
  getDateLabel,
  getCandleDomain,
  getCandleSlotIndex,
  getCandleGeometry,
  getEdgeIndicators,
  getFixedTimeAxisTicks,
  getPriceAxis,
  getSessionDomainSlotCount,
  getVolumeAxisTicks,
  hasRepetitiveFixtureData,
  invalidRawCandleIndices,
  isOpeningRangeCompleteAtEvaluation,
  isDisplacedLabel,
  isPrimaryLevel,
  priceToY,
  selectSessionCandles,
  type SessionCandle,
  type SessionView,
  stackLabelPositions,
  summarizeCategoryCoverage,
} from "@/lib/visual-review-chart";

const CATEGORIES: Array<{ value: VisualValidationCategory; label: string; short: string }> = [
  { value: "qualified_trade", label: "Qualified trade", short: "Qualified" },
  { value: "rejected_setup", label: "Rejected setup", short: "Rejected" },
  { value: "bullish_patience_candle", label: "Bullish patience candle", short: "Bullish patience" },
  { value: "bearish_patience_candle", label: "Bearish patience candle", short: "Bearish patience" },
  { value: "weak_orb_probe", label: "Weak ORB probe", short: "Weak ORB" },
  { value: "strong_breakout", label: "Strong breakout", short: "Breakout" },
  { value: "pullback", label: "Pullback", short: "Pullback" },
  { value: "consolidation", label: "Consolidation", short: "Consolidation" },
  { value: "ambiguous_candle", label: "Ambiguous candle", short: "Ambiguous" },
  { value: "stop_exit", label: "Stop exit", short: "Stop exit" },
  { value: "target_exit", label: "Target exit", short: "Target exit" },
  { value: "runner_exit", label: "Runner exit", short: "Runner exit" },
];

const REVIEW_OPTIONS: Array<{ value: Exclude<VisualValidationReviewStatus, "unreviewed">; label: string; detail: string }> = [
  { value: "correct", label: "Correct", detail: "Machine story matches the candles." },
  { value: "incorrect", label: "Incorrect", detail: "The machine label does not hold up." },
  { value: "uncertain", label: "Uncertain", detail: "Evidence is not decisive." },
  { value: "rule_needs_clarification", label: "Rule needs clarification", detail: "The rule or annotation needs a sharper definition." },
];

const INITIAL_REQUEST: VisualValidationRequest = {
  symbol: "MES",
  endDate: "2026-08-26",
  inSampleDays: 5,
  outOfSampleDays: 2,
  seed: 11,
  premarketAvailable: true,
  source: "simulated",
};

function storedReviewSetId(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem("levelstory.visualReviewSetId") ?? "";
}

function requestedReviewCategory(): VisualValidationCategory | null {
  if (typeof window === "undefined") return null;
  const candidate = new URLSearchParams(window.location.search).get("category");
  return CATEGORIES.some((category) => category.value === candidate) ? candidate as VisualValidationCategory : null;
}

function requestedSessionView(): SessionView {
  if (typeof window === "undefined") return "primary";
  return new URLSearchParams(window.location.search).get("view") === "full_regular" ? "full_regular" : "primary";
}

function prettyCategory(category: string): string {
  return category.replaceAll("_", " ");
}

function formatReviewTime(value: string): string {
  if (!value) return "—";
  return value.replace("T", " ").replace("Z", " UTC");
}

function safeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(3) : "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return JSON.stringify(value);
}

function apiErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = error.data;
  if (!data || typeof data !== "object" || !("error" in data) || typeof data.error !== "string") return null;
  return data.error;
}

function annotationTone(color: VisualValidationAnnotation["color"]): string {
  const tones: Record<VisualValidationAnnotation["color"], string> = {
    accent: "hsl(var(--accent))",
    positive: "hsl(var(--positive))",
    negative: "hsl(var(--negative))",
    muted: "hsl(var(--muted-foreground))",
    blue: "hsl(204 54% 43%)",
  };
  return tones[color];
}

function levelStroke(annotation: VisualValidationAnnotation): string {
  if (annotation.id === "orb-high" || annotation.id === "orb-low") return "hsl(33 93% 52%)";
  if (annotation.id === "vwap") return "hsl(204 72% 48%)";
  if (annotation.id === "ema-200") return "hsl(273 63% 58%)";
  if (annotation.id.startsWith("critical-")) return "hsl(var(--muted-foreground))";
  if (annotation.id === "entry-buffer") return "hsl(var(--positive))";
  if (annotation.id === "strategy-stop" || annotation.id === "catastrophe-stop") return "hsl(var(--negative))";
  if (annotation.id === "target" || annotation.id === "runner-threshold") return "hsl(var(--positive))";
  if (annotation.id.startsWith("fib-")) return "hsl(var(--muted-foreground))";
  return annotationTone(annotation.color);
}

export default function VisualReview() {
  const [request, setRequest] = useState<VisualValidationRequest>(INITIAL_REQUEST);
  const [reviewSetId, setReviewSetId] = useState(storedReviewSetId);
  const [localSet, setLocalSet] = useState<VisualValidationSet | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<VisualValidationCategory | null>(requestedReviewCategory);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<VisualValidationDiscrepancyReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [reviewDrawerOpen, setReviewDrawerOpen] = useState(true);

  const setQuery = useGetVisualValidationSet(
    reviewSetId ? { reviewSetId } : undefined,
    { query: { enabled: true, staleTime: 30_000, queryKey: ["visual-validation-set", reviewSetId || "latest"] } },
  );
  const createSet = useCreateVisualValidationSet();
  const recordReview = useRecordVisualValidationReview();
  const exportId = localSet?.reviewSetId ?? setQuery.data?.reviewSetId ?? reviewSetId;
  const exportQuery = useExportVisualValidationDiscrepancies(
    { reviewSetId: exportId || "00000000-0000-0000-0000-000000000000" },
    { query: { enabled: false, queryKey: ["visual-validation-discrepancies", exportId || "none"] } },
  );

  const data = localSet ?? setQuery.data;
  const coverage = data?.categoryCoverage ?? [];
  const snapshots = data?.snapshots ?? [];
  const availableCategories = useMemo(() => coverage.filter((item) => item.available && item.count > 0).map((item) => item.category), [coverage]);
  const categorySnapshots = useMemo(
    () => snapshots.filter((snapshot) => snapshot.category === selectedCategory),
    [selectedCategory, snapshots],
  );
  const activeSnapshot = categorySnapshots.find((snapshot) => snapshot.snapshotId === selectedSnapshotId) ?? categorySnapshots[0];

  useEffect(() => {
    if (data && !reviewSetId && typeof window !== "undefined") {
      window.localStorage.setItem("levelstory.visualReviewSetId", data.reviewSetId);
    }
  }, [data, reviewSetId]);

  useEffect(() => {
    if (!data) return;
    if (!availableCategories.length) {
      setSelectedCategory(null);
      return;
    }
    if (!selectedCategory || !availableCategories.includes(selectedCategory)) {
      setSelectedCategory(availableCategories[0]);
    }
  }, [availableCategories, data, selectedCategory]);

  useEffect(() => {
    if (!activeSnapshot) {
      setSelectedSnapshotId("");
      setReviewNote("");
      return;
    }
    setSelectedSnapshotId(activeSnapshot.snapshotId);
    setReviewNote(activeSnapshot.review.note ?? "");
  }, [activeSnapshot]);

  const selectCategory = (category: VisualValidationCategory) => {
    const item = coverage.find((entry) => entry.category === category);
    if (!item?.available || item.count === 0) return;
    setSelectedCategory(category);
    setSelectedSnapshotId("");
    setReport(null);
  };

  const submitGeneration = (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    setReport(null);
    createSet.mutate({ data: request }, {
      onSuccess: (nextSet) => {
        setLocalSet(nextSet);
        setReviewSetId(nextSet.reviewSetId);
        if (typeof window !== "undefined") window.localStorage.setItem("levelstory.visualReviewSetId", nextSet.reviewSetId);
        setMessage(`Generated ${nextSet.snapshots.length} causal snapshots.`);
      },
       onError: (error) => setMessage(apiErrorMessage(error) ?? "The deterministic set could not be generated. Check the date window and try again."),
    });
  };

  const saveReview = (status: Exclude<VisualValidationReviewStatus, "unreviewed">) => {
    if (!data || !activeSnapshot) return;
    setMessage("");
    recordReview.mutate({
      data: {
        reviewSetId: data.reviewSetId,
        snapshotId: activeSnapshot.snapshotId,
        status,
        note: reviewNote.trim() || null,
      },
    }, {
      onSuccess: (saved) => {
        setLocalSet((current) => {
          const base = current ?? data;
          return {
            ...base,
            snapshots: base.snapshots.map((snapshot) => snapshot.snapshotId === saved.snapshotId
              ? { ...snapshot, review: { status: saved.status, note: saved.note, reviewedAt: saved.reviewedAt } }
              : snapshot),
          };
        });
        setMessage(`Saved ${status.replaceAll("_", " ")} judgment.`);
      },
      onError: () => setMessage("The human judgment was not saved. Try again."),
    });
  };

  const exportReport = () => {
    if (!exportId) return;
    setReportOpen(true);
    exportQuery.refetch().then((result) => {
      if (!result.data) return;
      setReport(result.data);
      const file = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `levelstory-reviews-${result.data.reviewSetId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  };

  return (
    <LevelStoryShell>
      <div className="cockpit-grid min-h-[calc(100dvh-62px)] px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
        <div className="mx-auto max-w-[1560px]">
          <PageIntro
            eyebrow="Phase 12 / human-machine alignment"
            title="Look before you trust."
             description="A causal visual review room for checking whether deterministic setup rules tell the same story as the candles. Compare simulated fixtures or actual historical MES candles, inspect one decision at a time, then leave a human judgment."
            action={<ShadowBadge />}
          />

          <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(280px,.7fr)_minmax(0,1.3fr)]">
            <GenerationPanel request={request} setRequest={setRequest} onSubmit={submitGeneration} pending={createSet.isPending} message={message} />
            <SetManifest data={data} loading={setQuery.isLoading} />
          </div>

          {setQuery.isLoading && !data ? <Panel><QuerySkeleton rows={6} /></Panel> : setQuery.isError && !data ? (
            <Panel accent><QueryError onRetry={() => setQuery.refetch()} message="The visual-validation set could not be loaded." /></Panel>
          ) : !data ? (
            <Panel><EmptyReview /></Panel>
          ) : (
            <>
              <CoverageRail data={data} selectedCategory={selectedCategory} onSelect={selectCategory} />
              {activeSnapshot ? (
                <div className={`visual-review-workspace mt-5 grid gap-5 ${workspaceExpanded ? "is-expanded" : ""}`} data-testid="visual-review-workspace">
                  <div className="visual-review-chart-column min-w-0 space-y-5">
                    <SnapshotHeader snapshot={activeSnapshot} index={categorySnapshots.findIndex((item) => item.snapshotId === activeSnapshot.snapshotId)} total={categorySnapshots.length} onPrevious={() => moveSnapshot(categorySnapshots, activeSnapshot, -1, setSelectedSnapshotId)} onNext={() => moveSnapshot(categorySnapshots, activeSnapshot, 1, setSelectedSnapshotId)} />
                    <Panel accent>
                      <PanelTitle eyebrow="Raw market evidence / causal only" title="Annotated candle story" right={<CausalTag />} />
                      <CausalChart snapshot={activeSnapshot} source={data.source} expanded={workspaceExpanded} onToggleExpanded={() => setWorkspaceExpanded((current) => !current)} />
                    </Panel>
                    {workspaceExpanded ? (
                      <details className="machine-evidence-disclosure" open data-testid="machine-evidence-disclosure">
                        <summary className="cursor-pointer border border-border bg-card px-5 py-4 text-xs font-bold">Machine evidence · read-only</summary>
                        <div className="mt-3"><MachineEvidence snapshot={activeSnapshot} /></div>
                      </details>
                    ) : <MachineEvidence snapshot={activeSnapshot} />}
                  </div>
                  <aside className={`visual-review-sidebar min-w-0 space-y-5 ${workspaceExpanded && !reviewDrawerOpen ? "review-drawer-collapsed" : ""}`} data-testid="visual-review-sidebar">
                    {workspaceExpanded && <button type="button" onClick={() => setReviewDrawerOpen((current) => !current)} className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[10px] font-bold uppercase tracking-[.08em] hover:bg-muted" aria-expanded={reviewDrawerOpen} aria-controls="visual-review-drawer" data-testid="button-toggle-review-drawer">
                      {reviewDrawerOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}{reviewDrawerOpen ? "Collapse review drawer" : "Open review drawer"}
                    </button>}
                    <div id="visual-review-drawer" className={workspaceExpanded && !reviewDrawerOpen ? "hidden" : "space-y-5"}>
                      <ReviewPanel snapshot={activeSnapshot} note={reviewNote} setNote={setReviewNote} pending={recordReview.isPending} onSave={saveReview} message={message} />
                      <SnapshotNavigator snapshots={categorySnapshots} active={activeSnapshot} onSelect={setSelectedSnapshotId} />
                      <DiscrepancyPanel report={report} open={reportOpen} setOpen={setReportOpen} pending={exportQuery.isFetching} onExport={exportReport} />
                    </div>
                  </aside>
                </div>
              ) : <UnavailableWorkspace coverage={coverage} source={data.source} />}
            </>
          )}
        </div>
      </div>
    </LevelStoryShell>
  );
}

function GenerationPanel({ request, setRequest, onSubmit, pending, message }: { request: VisualValidationRequest; setRequest: (next: VisualValidationRequest) => void; onSubmit: (event: FormEvent) => void; pending: boolean; message: string }) {
  const update = (key: keyof VisualValidationRequest, value: string | number | boolean) => setRequest({ ...request, [key]: value });
  const hasError = ["could not", "not saved", "unavailable", "not found"].some((term) => message.toLowerCase().includes(term));
  return <Panel accent>
    <PanelTitle eyebrow="Generate / deterministic replay" title="Build a review set" right={<SlidersHorizontal size={16} className="text-muted-foreground" />} />
    <form onSubmit={onSubmit} className="space-y-4 border-t border-border p-5 sm:p-6">
      <Field label="Data source">
        <select
          className="field"
          value={request.source ?? "simulated"}
          onChange={(event) => update("source", event.target.value as "simulated" | "historical_databento")}
          data-testid="select-visual-review-source"
        >
          <option value="simulated">Simulated fixture data</option>
          <option value="historical_databento">Historical Databento data</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Symbol"><select className="field mono" value={request.symbol} onChange={(event) => update("symbol", event.target.value as "MES")}><option value="MES">MES</option></select></Field>
        <Field label="Seed"><input className="field mono" type="number" min="0" max="1000000" value={request.seed ?? ""} onChange={(event) => update("seed", Number(event.target.value))} /></Field>
      </div>
      <Field label="End date · New York trading date"><input required className="field mono" type="date" value={request.endDate} onChange={(event) => update("endDate", event.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="In-sample days"><select className="field mono" value={request.inSampleDays} onChange={(event) => update("inSampleDays", Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => <option key={value} value={value}>{value} sessions</option>)}</select></Field>
        <Field label="Out-of-sample days"><select className="field mono" value={request.outOfSampleDays} onChange={(event) => update("outOfSampleDays", Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => <option key={value} value={value}>{value} sessions</option>)}</select></Field>
      </div>
      <label className="flex cursor-pointer items-start gap-3 border border-border bg-muted/35 p-3">
        <input type="checkbox" className="mt-0.5 accent-[hsl(var(--accent))]" checked={request.premarketAvailable ?? true} onChange={(event) => update("premarketAvailable", event.target.checked)} />
        <span><span className="block text-xs font-semibold">Include premarket context</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">Keep this explicit; unavailable context must remain unavailable in the set.</span></span>
      </label>
      {message && <div className={`flex items-start gap-2 border p-3 text-xs ${hasError ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-[hsl(var(--positive)/.25)] bg-[hsl(var(--positive)/.08)] text-[hsl(var(--positive))]"}`} role="status"><Info size={14} className="mt-0.5 shrink-0" />{message}</div>}
       <button type="submit" disabled={pending} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:cursor-wait disabled:opacity-55" data-testid="button-generate-visual-set">
         {pending ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}{pending ? "Generating causal set..." : request.source === "historical_databento" ? "Generate historical set" : "Generate simulated set"}
      </button>
       <LockedNote>{request.source === "historical_databento" ? "Historical mode reads the existing indexed MES contract candles only. It never rebuilds the index, connects to a broker, creates orders, or produces live execution." : "Generation replays deterministic data only. No broker connection, order creation, or live execution path exists here."}</LockedNote>
    </form>
  </Panel>;
}

function SetManifest({ data, loading }: { data?: VisualValidationSet; loading: boolean }) {
  if (loading && !data) return <Panel><QuerySkeleton rows={3} /></Panel>;
  if (!data) return <Panel><div className="flex min-h-[300px] items-center justify-center p-6 text-sm text-muted-foreground">Generate a set to open the review room.</div></Panel>;
  return <Panel>
    <PanelTitle eyebrow="Set manifest / immutable inputs" title="What this room is looking at" right={<span className="mono text-[10px] text-muted-foreground">{data.snapshots.length} samples</span>} />
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2">
       <ManifestItem label="Source" value={formatDataSource(data.source, data.symbol)} icon={<ShieldCheck size={14} />} />
      <ManifestItem label="Symbol" value={data.symbol} icon={<Layers3 size={14} />} />
      <ManifestItem label="Formula version" value={data.formulaVersion} icon={<Fingerprint size={14} />} />
      <ManifestItem label="Formula hash" value={`${data.formulaHash.slice(0, 18)}…`} icon={<ScanLine size={14} />} />
      <ManifestItem label="Request window" value={`${data.request.inSampleDays} IS / ${data.request.outOfSampleDays} OOS`} />
      <ManifestItem label="Created" value={formatReviewTime(data.createdAt)} />
    </div>
    <div className="border-t border-border bg-accent/8 px-5 py-4 text-xs leading-5">
      <div className="flex items-center gap-2 font-semibold"><FileSearch size={14} className="text-accent" />Read the cursor, not the future.</div>
       <p className="mt-1 text-muted-foreground">The evaluation cursor marks the last candle visible to the machine. Shaded candles to its right are human-only outcome context and were never available to the strategy.</p>
    </div>
  </Panel>;
}

function CoverageRail({ data, selectedCategory, onSelect }: { data: VisualValidationSet; selectedCategory: VisualValidationCategory | null; onSelect: (category: VisualValidationCategory) => void }) {
  const summary = summarizeCategoryCoverage(data.categoryCoverage);
  const historical = data.source === "historical_databento";
  return <Panel>
    <PanelTitle eyebrow="Coverage / category samples" title="Choose the story to inspect" right={<span className="mono text-[10px] text-muted-foreground">{summary.available.length} of 12 {historical ? "historical categories found" : "categories available"}</span>} />
    <div className="grid gap-3 border-t border-border bg-accent/8 px-5 py-4 text-xs leading-5 sm:grid-cols-2 sm:px-6" data-testid="category-coverage-summary">
      <div><span className="font-semibold text-foreground">{summary.available.length} of 12 {historical ? "historical categories found" : "categories available"}</span><div className="mt-1 text-[11px] text-muted-foreground">{summary.available.length ? `Available: ${summary.available.map((item) => item.label).join(", ")}` : "No qualifying categories found in this range."}</div></div>
      <div><span className="font-semibold text-foreground">{summary.unavailable.length} not found</span><div className="mt-1 text-[11px] text-muted-foreground">{summary.unavailable.length ? `Not found: ${summary.unavailable.map((item) => item.label).join(", ")}` : "All categories are represented."}</div></div>
    </div>
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
      {CATEGORIES.map((category) => {
        const item = data.categoryCoverage.find((entry) => entry.category === category.value);
        const available = Boolean(item?.available && item.count > 0);
        const selected = selectedCategory === category.value;
        return <button type="button" key={category.value} disabled={!available} onClick={() => onSelect(category.value)} className={`group min-h-[82px] bg-card px-4 py-3 text-left transition ${selected ? "bg-accent/12 ring-1 ring-inset ring-accent" : available ? "hover:bg-muted/55" : "cursor-not-allowed opacity-55"}`} aria-pressed={selected} data-testid={`button-category-${category.value}`}>
          <span className="flex items-start justify-between gap-2"><span className="text-xs font-semibold leading-4">{category.label}</span>{available ? <span className={`mono text-[11px] ${selected ? "text-accent-foreground" : "text-muted-foreground"}`}>{item?.count}</span> : <X size={13} className="text-muted-foreground" aria-label="Unavailable" />}</span>
           <span className={`mt-3 block text-[9px] font-bold uppercase tracking-[.1em] ${available ? selected ? "text-accent-foreground" : "text-muted-foreground" : "text-muted-foreground"}`}>{available ? selected ? "Inspecting" : "Available" : data.source === "historical_databento" ? "No qualifying historical example found." : "Unavailable"}</span>
        </button>;
      })}
    </div>
  </Panel>;
}

function SnapshotHeader({ snapshot, index, total, onPrevious, onNext }: { snapshot: VisualValidationSnapshot; index: number; total: number; onPrevious: () => void; onNext: () => void }) {
  return <Panel>
    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="min-w-0">
        <div className="eyebrow mb-2 text-muted-foreground">Sample {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")} · {snapshot.period.replaceAll("_", "-")}</div>
        <div className="flex flex-wrap items-center gap-2"><h2 className="display text-2xl font-bold tracking-[-.045em]">{snapshot.categoryLabel}</h2><span className="border border-accent/45 bg-accent/10 px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em]">{snapshot.machineLabel}</span></div>
        <p className="mt-2 text-xs text-muted-foreground"><span className="mono">{snapshot.contractSymbol}</span> · {snapshot.tradingDate} · Formula evidence is machine-owned</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={onPrevious} disabled={index <= 0} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-muted disabled:opacity-35" aria-label="Previous sample"><ChevronLeft size={17} /></button>
        <button type="button" onClick={onNext} disabled={index < 0 || index >= total - 1} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-muted disabled:opacity-35" aria-label="Next sample"><ChevronRight size={17} /></button>
      </div>
    </div>
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Evaluation cursor" value={snapshot.evaluationCursor.newYork} sub={snapshot.evaluationCursor.utc} />
      <Metric label="Review cursor" value={snapshot.reviewCursor.newYork} sub={snapshot.reviewCursor.utc} />
      <Metric label="Machine candles" value={`${snapshot.machineCandles.length} candles`} sub={snapshot.futureCandleAccess ? "Future access detected" : "Future access: false"} />
      <Metric label="Review candles" value={`${snapshot.reviewCandles.length} candles`} sub={`Context ends ${formatReviewTime(snapshot.outcomeContextEnd)}`} />
    </div>
  </Panel>;
}

function CausalTag() {
  return <span className="inline-flex items-center gap-1.5 border border-[hsl(var(--positive)/.3)] bg-[hsl(var(--positive)/.08)] px-2 py-1 text-[9px] font-bold uppercase tracking-[.1em] text-[hsl(var(--positive))]"><LockKeyhole size={11} />Causal boundary enforced</span>;
}

function CausalChart({ snapshot, source, expanded, onToggleExpanded }: { snapshot: VisualValidationSnapshot; source: string; expanded: boolean; onToggleExpanded: () => void }) {
  const [sessionView, setSessionView] = useState<SessionView>(requestedSessionView);
  const [showPremarket, setShowPremarket] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    const exitOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && document.fullscreenElement === frameRef.current) void document.exitFullscreen();
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("keydown", exitOnEscape);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("keydown", exitOnEscape);
    };
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement === frameRef.current) {
      void document.exitFullscreen();
    } else {
      void frameRef.current?.requestFullscreen();
    }
  };
  const selection = selectSessionCandles(
    snapshot.reviewCandles,
    snapshot.evaluationCursor.closeTime,
    snapshot.reviewCursor.closeTime,
    sessionView,
    showPremarket,
  );
  const chartCandles = selection.candles;
  const repetitive = hasRepetitiveFixtureData(chartCandles);
  const invalidIndices = invalidRawCandleIndices(chartCandles);
  const historical = source === "historical_databento" || source === "historical_databento_multicontract";
  const windowLabel = sessionView === "primary"
    ? "Primary trade window · 9:30 AM–1:00 PM ET"
    : "Full regular session · 9:30 AM–4:00 PM ET";
  const sourceLabel = `${windowLabel} · ${historical ? "Historical Databento" : "Simulated fixture data"}`;
  return <div ref={frameRef} className={`chart-frame border-t border-border p-3 sm:p-5 ${isFullscreen ? "visual-review-chart-fullscreen" : ""}`} data-testid="visual-review-chart">
    <div className="mb-4 flex flex-col gap-2 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="eyebrow text-muted-foreground">Source / immutable candle bytes</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 border border-accent/45 bg-accent/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.1em]" data-testid="chart-data-source"><span className="h-1.5 w-1.5 rounded-full bg-accent" />{formatDataSource(source, snapshot.contractSymbol)}</span>
          <span className="mono text-[10px] text-muted-foreground" data-testid="chart-window-count">{selection.regularCandles.length} regular candles shown{showPremarket ? ` · ${selection.premarketCandles.length} premarket` : ""} · raw OHLCV</span>
        </div>
        <div className="mt-2 text-xs font-semibold tracking-[-.01em]" data-testid="primary-trade-window-label">{sourceLabel}</div>
      </div>
       <div className="flex flex-col items-start gap-2 sm:items-end">
        <span className="mono text-[10px] text-muted-foreground">MES · {snapshot.contractSymbol}</span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="eyebrow">Chart window</span>
            <select className="field h-8 min-w-[190px] py-1 text-[10px]" value={sessionView} onChange={(event) => setSessionView(event.target.value as SessionView)} data-testid="select-session-view">
              <option value="primary">Primary window: 9:30 AM–1:00 PM</option>
              <option value="full_regular">Full regular session: 9:30 AM–4:00 PM</option>
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
            <input type="checkbox" className="accent-[hsl(var(--accent))]" checked={showPremarket} onChange={(event) => setShowPremarket(event.target.checked)} data-testid="toggle-show-premarket" />
            <span>Show premarket candles</span>
          </label>
           <div className="flex flex-wrap items-center gap-1 border-l border-border pl-2" role="group" aria-label="Chart view controls">
             <button type="button" onClick={onToggleExpanded} className="chart-control" aria-label={expanded ? "Exit expanded chart" : "Expand chart"} data-testid="button-expand-chart">{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}{expanded ? "Exit" : "Expand"}</button>
             <button type="button" onClick={toggleFullscreen} className="chart-control" aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} data-testid="button-fullscreen-chart">{isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
           </div>
        </div>
      </div>
    </div>
     {repetitive && source === "simulated" && <div className="mb-4 flex items-start gap-2 border border-accent/35 bg-accent/8 p-3 text-[11px] leading-4 text-muted-foreground" role="status" data-testid="repetitive-fixture-warning"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-accent" /><span><strong className="text-foreground">Repetitive simulated fixture data.</strong> The raw candles contain repeated or unusually narrow-body shapes; values are rendered unchanged.</span></div>}
    {invalidIndices.length > 0 && <div className="mb-4 flex items-start gap-2 border border-destructive/35 bg-destructive/8 p-3 text-[11px] leading-4 text-destructive" role="alert" data-testid="invalid-candle-warning"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>Raw OHLC integrity issue in {invalidIndices.length} candle{invalidIndices.length === 1 ? "" : "s"}; values are shown without correction.</span></div>}
      <CausalSvg snapshot={snapshot} candles={chartCandles} regularCandles={selection.regularCandles} premarketCandles={selection.premarketCandles} sessionView={sessionView} onReturnPrimary={() => setSessionView("primary")} />
     <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-[10px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[hsl(var(--positive))]" />up candle</span>
      <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[hsl(var(--negative))]" />down candle</span>
      <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full border border-accent bg-accent/20" />primary level</span>
      <span className="inline-flex items-center gap-1.5"><i className="h-3 w-px border-l border-dashed border-foreground" />evaluation cursor</span>
      <span className="inline-flex items-center gap-1.5"><i className="h-3 w-3 border border-foreground/20 bg-foreground/5" />Human-only outcome context</span>
       <span className="mono ml-auto">5m · NY / UTC · review-bounded</span>
    </div>
  </div>;
}

function formatExactVolume(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

function CausalSvg({
  snapshot,
  candles,
  regularCandles,
  premarketCandles,
  sessionView,
  onReturnPrimary,
}: {
  snapshot: VisualValidationSnapshot;
  candles: SessionCandle[];
  regularCandles: SessionCandle[];
  premarketCandles: SessionCandle[];
  sessionView: SessionView;
  onReturnPrimary: () => void;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  useEffect(() => {
    setHoveredIndex(null);
    setZoom(1);
    setPan(0);
  }, [sessionView, premarketCandles.length]);
  if (!candles.length) return <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">No causal candles were returned for this snapshot.</div>;
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const left = CHART_LEFT;
  const right = CHART_RIGHT;
  const top = CHART_TOP;
  const plotBottom = CHART_PLOT_BOTTOM;
  const volumeTop = CHART_VOLUME_TOP;
  const plotWidth = width - left - right;
  const slotCount = getSessionDomainSlotCount(sessionView, premarketCandles.length > 0);
  const step = plotWidth / Math.max(slotCount, 1);
  const orbCandles = regularCandles.slice(0, 3);
  const orbCompleteAtEvaluation = isOpeningRangeCompleteAtEvaluation(regularCandles, snapshot.evaluationCursor.closeTime);
  const annotations = snapshot.annotations.filter((annotation) => annotation.available
    && (!["orb-high", "orb-low"].includes(annotation.id) || orbCompleteAtEvaluation));
  const domain = getCandleDomain(candles);
  const priceAxis = getPriceAxis(domain);
  const y = (price: number) => priceToY(price, domain, top, plotBottom);
  const x = (index: number) => left + index * step + step / 2;
  const plotRight = width - right;
  const visibleAtEvaluation = candles.filter((candle) => candle.machineVisible).length;
  const machineSlots = candles.filter((candle) => candle.machineVisible).map((candle) => getCandleSlotIndex(candle, sessionView, premarketCandles.length > 0));
  const boundarySlot = machineSlots.length ? Math.max(...machineSlots) + 1 : (premarketCandles.length > 0 ? PREMARKET_SLOT_COUNT : 0);
  const boundaryX = left + Math.min(boundarySlot, slotCount) * step;
  const volumeMax = Math.max(...candles.map((candle) => candle.volume), 1);
  const volumeAxis = getVolumeAxisTicks(volumeMax);
  const timeAxis = getFixedTimeAxisTicks(sessionView, premarketCandles.length > 0);
  const regularStartIndex = regularCandles.length ? getCandleSlotIndex(regularCandles[0], sessionView, premarketCandles.length > 0) : -1;
  const premarketEndX = premarketCandles.length ? left + PREMARKET_SLOT_COUNT * step : null;
  const openingRangeX = regularStartIndex >= 0 ? left + regularStartIndex * step : null;
  const openingRangeWidth = orbCandles.length === 3 ? 3 * step : 0;
  const allLevels = annotations.filter((annotation) => annotation.kind !== "candle" && annotation.price !== null);
  const criticalLevels = allLevels.filter((annotation) => annotation.id.startsWith("critical-"));
  const entryReference = allLevels.find((annotation) => annotation.id === "entry-buffer")?.price ?? null;
  const relevantCritical = [...criticalLevels]
    .sort((first, second) => entryReference == null
      ? 0
      : Math.abs((first.price ?? entryReference) - entryReference) - Math.abs((second.price ?? entryReference) - entryReference))
    .slice(0, 1);
  const primaryLevels = allLevels.filter((annotation) => isPrimaryLevel(annotation) && !annotation.id.startsWith("critical-")).concat(relevantCritical);
  const additionalLevels = allLevels.filter((annotation) => !primaryLevels.some((primary) => primary.id === annotation.id));
  const inRangeLevels = primaryLevels.filter((annotation) => annotation.price != null && annotation.price >= domain.min && annotation.price <= domain.max);
  const labelPositions = stackLabelPositions(inRangeLevels.map((annotation) => ({ id: annotation.id, y: y(annotation.price as number) })), top + 9, plotBottom - 5, 16);
  const labelYById = new Map(labelPositions.map((position) => [position.id, position.y]));
  const edgeIndicators = getEdgeIndicators(primaryLevels, domain);
  const edgeCounts: Record<"top" | "bottom", number> = { top: 0, bottom: 0 };
  const eventMarkers = annotations.flatMap((annotation) => {
    if (annotation.kind !== "candle") return [];
    const markerIndex = findCandleIndexAtTimestamp(candles, annotation.openTime ?? annotation.closeTime);
    if (markerIndex < 0) return [];
    const machineVisible = candles[markerIndex].machineVisible;
    if (annotation.visibility === "machine" && !machineVisible) return [];
    if (annotation.visibility === "human_only" && machineVisible) return [];
    return [{ annotation, markerIndex, markerSlot: getCandleSlotIndex(candles[markerIndex], sessionView, premarketCandles.length > 0) }];
  });
  const hoveredCandle = hoveredIndex == null ? null : candles[hoveredIndex];
  const hoveredDetails = hoveredCandle ? getCandleInspection(hoveredCandle) : null;
  const hoveredSlot = hoveredCandle ? getCandleSlotIndex(hoveredCandle, sessionView, premarketCandles.length > 0) : 0;
  const setIndexFromClientX = (clientX: number, rect: DOMRect) => {
    const svgX = (clientX - rect.left) * (width / rect.width);
    const slot = Math.floor((svgX - left) / step);
    const nextIndex = candles.reduce((best, candle, index) => {
      const distance = Math.abs(getCandleSlotIndex(candle, sessionView, premarketCandles.length > 0) - slot);
      const bestDistance = best < 0 ? Number.POSITIVE_INFINITY : Math.abs(getCandleSlotIndex(candles[best], sessionView, premarketCandles.length > 0) - slot);
      return distance < bestDistance ? index : best;
    }, -1);
    if (nextIndex < 0) return;
    setHoveredIndex(nextIndex);
  };
  const setIndexFromKeyboard = (event: KeyboardEvent<SVGRectElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const current = hoveredIndex ?? Math.max(0, visibleAtEvaluation - 1);
    const nextIndex = event.key === "ArrowLeft"
      ? Math.max(0, current - 1)
      : event.key === "ArrowRight"
        ? Math.min(candles.length - 1, current + 1)
        : event.key === "Home"
          ? 0
          : candles.length - 1;
    setHoveredIndex(nextIndex);
  };
  return <div className="relative w-full overflow-x-auto">
    {hoveredCandle && hoveredDetails && <div className="pointer-events-none absolute right-4 top-4 z-10 min-w-[238px] border border-foreground/20 bg-card/95 p-3 shadow-sm" role="status" aria-live="polite" data-testid="chart-crosshair-tooltip">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow text-muted-foreground">Selected 5-minute candle</div>
          <div className="mono mt-1 text-[11px] font-bold">{hoveredDetails.interval}</div>
        </div>
        <span className={`shrink-0 text-[9px] font-bold uppercase ${hoveredDetails.machineVisible ? "text-[hsl(var(--positive))]" : "text-muted-foreground"}`}>{hoveredDetails.machineVisible ? "Machine visible" : "Human-only"}</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 border-t border-border pt-2 text-[10px]">
        <span>O <strong className="mono">{hoveredDetails.open.toFixed(2)}</strong></span>
        <span>H <strong className="mono">{hoveredDetails.high.toFixed(2)}</strong></span>
        <span>L <strong className="mono">{hoveredDetails.low.toFixed(2)}</strong></span>
        <span>C <strong className="mono">{hoveredDetails.close.toFixed(2)}</strong></span>
        <span className="col-span-2">V <strong className="mono">{formatExactVolume(hoveredDetails.volume)}</strong></span>
      </div>
      <div className="mt-2 border-t border-border pt-2 text-[9px] text-muted-foreground">
        <div><span className="font-semibold text-foreground">{hoveredDetails.contractSymbol}</span> · {hoveredDetails.utc} UTC</div>
        <div>Crosshair snaps to the exact raw OHLCV interval.</div>
      </div>
    </div>}
     <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-y border-border py-2" data-testid="chart-navigation-controls">
       <span className="eyebrow text-muted-foreground">Inspect / fixed timestamp slots</span>
       <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Chart navigation controls">
         <button type="button" onClick={() => setZoom((current) => Math.max(1, Number((current - .25).toFixed(2))))} disabled={zoom <= 1} className="chart-control" aria-label="Zoom out" data-testid="button-zoom-out"><ZoomOut size={13} />Zoom out</button>
         <span className="mono min-w-[42px] text-center text-[10px] text-muted-foreground" aria-live="polite">{Math.round(zoom * 100)}%</span>
         <button type="button" onClick={() => setZoom((current) => Math.min(3, Number((current + .25).toFixed(2))))} disabled={zoom >= 3} className="chart-control" aria-label="Zoom in" data-testid="button-zoom-in"><ZoomIn size={13} />Zoom in</button>
         <button type="button" onClick={() => setPan((current) => Math.max(0, current - 80 / zoom))} disabled={pan <= 0} className="chart-control" aria-label="Pan chart left" data-testid="button-pan-left"><MoveLeft size={13} />Pan left</button>
         <button type="button" onClick={() => setPan((current) => Math.min(width - width / zoom, current + 80 / zoom))} disabled={pan >= width - width / zoom} className="chart-control" aria-label="Pan chart right" data-testid="button-pan-right"><MoveRight size={13} />Pan right</button>
         <button type="button" onClick={() => { setZoom(1); setPan(0); }} className="chart-control" aria-label="Reset chart view" data-testid="button-reset-chart"><RotateCcw size={13} />Reset</button>
         {sessionView !== "primary" && <button type="button" onClick={onReturnPrimary} className="chart-control" aria-label="Return to primary trade window" data-testid="button-return-primary"><RotateCcw size={13} />Primary window</button>}
       </div>
     </div>
     <svg viewBox={`${pan} 0 ${width / zoom} ${height}`} className="visual-review-svg h-[600px] min-w-[900px] w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Causal annotated five-minute OHLCV chart for ${snapshot.categoryLabel}. ${sessionView === "primary" ? "Primary trade window from 9:30 AM to 1:00 PM ET." : "Full regular session from 9:30 AM to 4:00 PM ET."} Hover or use the arrow keys to inspect an exact five-minute candle. The evaluation cursor marks the last candle visible to the machine. Shaded candles to its right are human-only outcome context.`}>
      <title>Causal annotated chart. The evaluation cursor marks the last machine-visible candle; shaded candles to its right are human-only outcome context.</title>
      {priceAxis.ticks.map((price) => <g key={`price-axis-${price}`} data-testid="price-axis-tick"><line x1={left} x2={plotRight} y1={y(price)} y2={y(price)} stroke="hsl(var(--border))" strokeDasharray="2 6" opacity=".8" /><text x={width - 5} y={y(price) + 4} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="DM Mono">{formatPriceAxisValue(price)}</text></g>)}
      {volumeAxis.map((tick) => {
        const tickY = volumeTop + CHART_VOLUME_HEIGHT - (tick.value / Math.max(volumeAxis.at(-1)?.value ?? volumeMax, 1)) * CHART_VOLUME_HEIGHT;
        return <g key={`volume-axis-${tick.value}`} data-testid="volume-axis-tick"><line x1={left} x2={plotRight} y1={tickY} y2={tickY} stroke="hsl(var(--border))" strokeDasharray="2 6" opacity=".42" /><text x={width - 5} y={tickY + 3} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">{tick.label}</text></g>;
      })}
      {timeAxis.map((tick) => {
        const tickX = left + (tick.position ?? tick.index + 0.5) * step;
        const emphasized = ["9:30 AM", "9:45 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:00 PM"].includes(tick.label);
        return <g key={`time-axis-${tick.index}-${tick.position ?? "open"}`} data-testid="time-axis-tick"><line x1={tickX} x2={tickX} y1={plotBottom + 4} y2={volumeTop + CHART_VOLUME_HEIGHT + 2} stroke="hsl(var(--border))" strokeDasharray="2 5" opacity={emphasized ? ".75" : ".45"} /><text x={tickX} y={CHART_TIME_TICK_Y} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize={emphasized ? "10.5" : "10"} fontWeight={emphasized ? "700" : "400"} fontFamily="DM Mono">{tick.label}</text></g>;
      })}
      {premarketEndX !== null && <g data-testid="premarket-region">
        <rect x={left} y={top} width={premarketEndX - left} height={volumeTop + CHART_VOLUME_HEIGHT - top} fill="hsl(var(--muted) / .18)" />
        <line x1={premarketEndX} x2={premarketEndX} y1={top} y2={volumeTop + CHART_VOLUME_HEIGHT + 2} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" opacity=".65" />
        <text x={left + 8} y={top + 17} fill="hsl(var(--muted-foreground))" fontSize="8.5" fontWeight="700" fontFamily="DM Mono">PREMARKET</text>
      </g>}
      {openingRangeX !== null && openingRangeWidth > 0 && <g data-testid="opening-range-region">
        <rect x={openingRangeX} y={top} width={openingRangeWidth} height={volumeTop + CHART_VOLUME_HEIGHT - top} fill="hsl(var(--accent) / .08)" stroke="hsl(var(--accent) / .55)" strokeDasharray="4 3" />
        <path d={`M ${openingRangeX} ${top + 25} v -8 h ${openingRangeWidth} v 8`} fill="none" stroke="hsl(var(--accent))" strokeWidth="1.2" />
        <text x={openingRangeX + openingRangeWidth / 2} y={top + 15} textAnchor="middle" fill="hsl(var(--accent))" fontSize="8.5" fontWeight="700" fontFamily="DM Mono">OPENING RANGE</text>
      </g>}
       <rect x={Math.max(boundaryX, left)} y={top} width={Math.max(width - right - boundaryX, 0)} height={volumeTop + CHART_VOLUME_HEIGHT - top} fill="hsl(var(--foreground) / .055)" data-testid="human-only-region" />
       {width - right - Math.max(boundaryX, left) >= 150
         ? <text x={Math.max(boundaryX, left) + 10} y={top + 20} fill="hsl(var(--muted-foreground))" fontSize="9" fontWeight="700" fontFamily="DM Mono" data-testid="human-only-label">HUMAN-ONLY OUTCOME CONTEXT</text>
         : <text x={Math.min(Math.max(boundaryX + 11, left + 11), width - right - 8)} y={(top + volumeTop) / 2} transform={`rotate(90 ${Math.min(Math.max(boundaryX + 11, left + 11), width - right - 8)} ${(top + volumeTop) / 2})`} fill="hsl(var(--muted-foreground))" fontSize="8" fontWeight="700" fontFamily="DM Mono" data-testid="human-only-label">HUMAN-ONLY</text>}
      {primaryLevels.map((annotation) => {
        if (annotation.price == null || annotation.price < domain.min || annotation.price > domain.max) return null;
        const orb = annotation.id === "orb-high" || annotation.id === "orb-low";
        const fib = annotation.id.startsWith("fib-");
        const critical = annotation.id.startsWith("critical-");
        const stop = annotation.id === "strategy-stop" || annotation.id === "catastrophe-stop";
        const target = annotation.id === "target";
         const stroke = levelStroke(annotation);
          const labelY = labelYById.get(annotation.id) ?? y(annotation.price);
          const axisLabelX = plotRight + 7;
          const labelWidth = width - axisLabelX - 7;
          const displaced = isDisplacedLabel(labelY, y(annotation.price));
          return <g key={annotation.id} data-testid={`chart-level-${annotation.id}`}>
            <line x1={left} x2={plotRight} y1={y(annotation.price)} y2={y(annotation.price)} stroke={stroke} strokeWidth={orb ? 2.8 : critical ? 2 : stop ? 1.8 : 1.4} strokeDasharray={target ? "7 5" : orb ? "10 4" : fib ? "3 6" : annotation.kind === "indicator" ? "2 5" : "none"} opacity={fib ? ".42" : orb ? ".98" : ".8"} />
            {displaced && <line x1={plotRight} x2={axisLabelX} y1={y(annotation.price)} y2={labelY} stroke={stroke} strokeWidth="1" opacity=".75" data-testid={`chart-level-connector-${annotation.id}`} />}
            <rect x={axisLabelX} y={labelY - 10} width={labelWidth} height="18" rx="2" fill="hsl(var(--card) / .94)" stroke={stroke} strokeOpacity=".32" />
            <text x={axisLabelX + 4} y={labelY + 3} fill={stroke} fontSize="8.5" fontWeight={orb || critical ? "700" : "500"} fontFamily="DM Mono">{annotation.label}</text>
            <text x={width - 11} y={labelY + 3} textAnchor="end" fill={stroke} fontSize="8.5" fontWeight="700" fontFamily="DM Mono">{formatPriceAxisValue(annotation.price)}</text>
          </g>;
      })}
      {edgeIndicators.map(({ annotation, edge }) => {
         const edgeIndex = edgeCounts[edge]++;
         const edgeY = edge === "top" ? top + 8 + edgeIndex * 15 : plotBottom - 8 - edgeIndex * 15;
         const stroke = levelStroke(annotation);
        const label = `${annotation.label} · ${annotation.price?.toFixed(2)}`;
         return <g key={`edge-${annotation.id}`} data-testid={`edge-indicator-${annotation.id}`}><path d={edge === "top" ? `M ${left} ${edgeY - 7} l 7 7 l -14 0 z` : `M ${left} ${edgeY + 7} l 7 -7 l -14 0 z`} fill={stroke} /><text x={left + 12} y={edgeY + 4} fill={stroke} fontSize="9" fontWeight="700" fontFamily="DM Mono">{edge === "top" ? "↑" : "↓"} {label}</text></g>;
      })}
      {candles.map((candle, index) => {
        const up = candle.close >= candle.open;
         const color = up ? "hsl(var(--positive))" : "hsl(var(--negative))";
         const slotIndex = getCandleSlotIndex(candle, sessionView, premarketCandles.length > 0);
         const geometry = getCandleGeometry(candle, slotIndex, step, domain, left);
         const volumeHeight = Math.max((candle.volume / volumeMax) * CHART_VOLUME_HEIGHT, 2);
         return <g key={`${candle.openTime}-${index}`} data-testid={`chart-candle-${index}`} opacity={candle.machineVisible ? 1 : ".72"}><title>{`${formatCandleTime(candle.openTime, "America/New_York")} NY · ${formatCandleTime(candle.openTime, "UTC")} UTC · O ${candle.open.toFixed(2)} H ${candle.high.toFixed(2)} L ${candle.low.toFixed(2)} C ${candle.close.toFixed(2)} · volume ${candle.volume}`}</title><line x1={geometry.x} x2={geometry.x} y1={geometry.highY} y2={geometry.lowY} stroke={color} strokeWidth="1.6" /><rect x={geometry.x - Math.max(step * .3, 2)} y={geometry.bodyTop} width={Math.max(step * .6, 4)} height={geometry.bodyHeight} fill={color} rx="1" /><rect x={geometry.x - Math.max(step * .25, 2)} y={volumeTop + CHART_VOLUME_HEIGHT - volumeHeight} width={Math.max(step * .5, 3)} height={volumeHeight} fill={color} opacity=".43" /></g>;
      })}
          {eventMarkers.map(({ annotation, markerSlot }, markerOrder) => {
           const markerX = x(markerSlot);
          const humanOnly = annotation.visibility === "human_only";
           const markerY = top + 15 + Math.min(markerOrder, 5) * 12;
          const markerPriceY = annotation.price == null ? markerY : y(annotation.price);
          const label = humanOnly ? `Human-only · ${annotation.label}` : annotation.label;
          const markerTime = annotation.openTime ?? annotation.closeTime;
          return <g key={`marker-${annotation.id}`} data-testid={`event-marker-${annotation.id}`}><title>{`${label} · ${markerTime ? `${formatCandleTime(markerTime, "America/New_York")} NY · ${formatCandleTime(markerTime, "UTC")} UTC` : "timestamp unavailable"}`}</title><line x1={markerX} x2={markerX} y1={top} y2={plotBottom} stroke={annotationTone(annotation.color)} strokeDasharray={humanOnly ? "7 4" : "2 4"} opacity={humanOnly ? ".62" : ".88"} /><circle cx={markerX} cy={markerPriceY} r={humanOnly ? "4" : "3.5"} fill={annotationTone(annotation.color)} /><text x={markerX + 5} y={markerY} fill={annotationTone(annotation.color)} fontSize="9" fontWeight="700" fontFamily="DM Mono">{label}</text></g>;
      })}
       <line x1={boundaryX} x2={boundaryX} y1={12} y2={plotBottom + 12} stroke="hsl(var(--foreground))" strokeWidth="1.5" strokeDasharray="5 4" data-testid="evaluation-cursor" />
       <rect x={Math.min(Math.max(boundaryX - 62, left), width - 130)} y="1" width="124" height="18" rx="2" fill="hsl(var(--foreground))" /><text x={Math.min(Math.max(boundaryX, left + 62), width - 68)} y="13" textAnchor="middle" fill="hsl(var(--background))" fontSize="9" fontWeight="700" fontFamily="DM Mono">CAUSAL CURSOR</text>
       <line x1={left} x2={width - right} y1={volumeTop + CHART_VOLUME_HEIGHT + 2} y2={volumeTop + CHART_VOLUME_HEIGHT + 2} stroke="hsl(var(--border))" />
        {hoveredCandle && <g pointerEvents="none" data-testid="chart-crosshair">
           <line x1={x(hoveredSlot)} x2={x(hoveredSlot)} y1={top} y2={volumeTop + CHART_VOLUME_HEIGHT} stroke="hsl(var(--foreground))" strokeDasharray="4 3" strokeWidth="1.2" />
          <line x1={left} x2={plotRight} y1={y(hoveredCandle.close)} y2={y(hoveredCandle.close)} stroke="hsl(var(--foreground))" strokeDasharray="4 3" strokeWidth="1" opacity=".65" />
           <circle cx={x(hoveredSlot)} cy={y(hoveredCandle.close)} r="3.5" fill="hsl(var(--foreground))" />
        </g>}
        <line x1={left} x2={plotRight} y1={volumeTop + CHART_VOLUME_HEIGHT + 2} y2={volumeTop + CHART_VOLUME_HEIGHT + 2} stroke="hsl(var(--border))" />
         <text x={left} y={CHART_DATE_LABEL_Y} fill="hsl(var(--muted-foreground))" fontSize="10" fontWeight="700" fontFamily="DM Mono">{getDateLabel(candles)}</text>
        <text x={left} y={CHART_FOOTER_LABEL_Y} fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">PRICE · MES 0.25 TICK</text>
        <text x={plotRight} y={CHART_FOOTER_LABEL_Y} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">VOLUME · COMPLETED 5M</text>
        <rect x={left} y={top} width={plotWidth} height={volumeTop + CHART_VOLUME_HEIGHT - top} fill="transparent" tabIndex={0} role="application" aria-label="Interactive five-minute candle crosshair. Use left and right arrow keys to select a candle." data-testid="chart-interaction-layer"
          onMouseMove={(event) => setIndexFromClientX(event.clientX, event.currentTarget.ownerSVGElement?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => setHoveredIndex(null)}
          onKeyDown={setIndexFromKeyboard}
        />
    </svg>
     <div className="sr-only" aria-live="polite" data-testid="selected-candle-announcement">
       {hoveredDetails ? `Selected ${hoveredDetails.interval}. Open ${hoveredDetails.open.toFixed(2)}, high ${hoveredDetails.high.toFixed(2)}, low ${hoveredDetails.low.toFixed(2)}, close ${hoveredDetails.close.toFixed(2)}, volume ${formatExactVolume(hoveredDetails.volume)}. ${hoveredDetails.machineVisible ? "Machine visible." : "Human-only context."}` : "No candle selected."}
     </div>
     {hoveredCandle == null && <div className="mt-2 text-right text-[10px] text-muted-foreground">Hover a candle or focus the chart and use ← / → to inspect the exact 5-minute interval.</div>}
    {additionalLevels.length > 0 && <details className="mt-3 border-t border-border pt-3" data-testid="additional-levels">
      <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">Additional levels ({additionalLevels.length})</summary>
       <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{additionalLevels.map((annotation) => <div key={annotation.id} className="flex items-center justify-between gap-3 border border-border bg-muted/25 px-3 py-2 text-[10px]"><span className="truncate text-muted-foreground">{annotation.label}</span><span className="mono shrink-0">{annotation.price == null ? "—" : formatPriceAxisValue(annotation.price)}</span></div>)}</div>
    </details>}
   </div>;
}

function MachineEvidence({ snapshot }: { snapshot: VisualValidationSnapshot }) {
  const evidence = snapshot.machineEvidence;
  const market = typeof evidence.market === "object" && evidence.market !== null ? evidence.market as Record<string, unknown> : {};
  const audit = typeof evidence.audit === "object" && evidence.audit !== null ? evidence.audit as Record<string, unknown> : {};
  const fields: Array<[string, unknown]> = [
    ["Decision", audit.decision ?? snapshot.machineLabel],
    ["Setup", audit.setupType],
    ["Direction", audit.direction],
    ["Evaluation", audit.evaluatedCandleOpenTime],
    ["Breakout", typeof market.breakout === "object" && market.breakout ? (market.breakout as Record<string, unknown>).detail : null],
    ["Patience", typeof market.patience === "object" && market.patience ? (market.patience as Record<string, unknown>).detail : null],
    ["Formula", `${snapshot.formulaVersion} · ${snapshot.formulaHash.slice(0, 16)}…`],
    ["Future access", snapshot.evaluationCursor.futureCandleAccess],
  ];
  return <Panel>
    <PanelTitle eyebrow="Machine evidence / read-only" title="What the deterministic engine said" right={<span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase text-muted-foreground"><Fingerprint size={13} />Immutable formula trace</span>} />
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
      {fields.map(([label, value]) => <div key={label} className="min-h-[74px] bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 break-words text-[11px]">{safeValue(value)}</div></div>)}
    </div>
    <details className="border-t border-border px-5 py-4 sm:px-6">
      <summary className="cursor-pointer text-xs font-semibold">Open complete machine payload</summary>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-sm bg-secondary/60 p-3 text-[10px] leading-4 text-muted-foreground">{JSON.stringify(evidence, null, 2)}</pre>
    </details>
    <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground sm:px-6">Machine evidence is not a human judgment. Do not use this panel to silently correct a rule; leave a labeled review below.</div>
  </Panel>;
}

function ReviewPanel({ snapshot, note, setNote, pending, onSave, message }: { snapshot: VisualValidationSnapshot; note: string; setNote: (note: string) => void; pending: boolean; onSave: (status: Exclude<VisualValidationReviewStatus, "unreviewed">) => void; message: string }) {
  const savedStatus = snapshot.review.status === "unreviewed" ? null : snapshot.review.status;
  return <Panel accent>
    <PanelTitle eyebrow="Human judgment / persisted review" title="Does the story hold?" right={<ClipboardCheck size={17} className="text-accent" />} />
    <div className="border-t border-border bg-accent/8 px-5 py-4 text-xs leading-5 sm:px-6"><strong>Separate the two voices.</strong><span className="ml-1 text-muted-foreground">The machine has labeled this sample. Your task is to judge the raw causal candle story.</span></div>
    <div className="space-y-4 border-t border-border p-5 sm:p-6">
      <div className="grid gap-2">
        {REVIEW_OPTIONS.map((option) => <button type="button" key={option.value} onClick={() => onSave(option.value)} disabled={pending} className={`flex items-start gap-3 border p-3 text-left transition hover:bg-muted/50 disabled:opacity-55 ${savedStatus === option.value ? "border-accent bg-accent/10" : "border-border"}`} aria-pressed={savedStatus === option.value} data-testid={`button-review-${option.value}`}>
          <span className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border ${savedStatus === option.value ? "border-accent bg-accent text-accent-foreground" : "border-muted-foreground/50"}`}>{savedStatus === option.value && <Check size={11} />}</span><span><span className="block text-xs font-bold">{option.label}</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{option.detail}</span></span>
        </button>)}
      </div>
      <label className="block"><span className="eyebrow mb-1.5 block text-muted-foreground">Reviewer note · optional</span><textarea maxLength={2000} rows={5} value={note} onChange={(event) => setNote(event.target.value)} className="field resize-none" placeholder="Name the exact candle, level, or rule ambiguity you observed." /><span className="mt-1 block text-right text-[10px] text-muted-foreground">{note.length} / 2000</span></label>
      {message && <div className="border border-[hsl(var(--positive)/.25)] bg-[hsl(var(--positive)/.08)] p-3 text-xs text-[hsl(var(--positive))]" role="status">{message}</div>}
      <div className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground"><LockKeyhole size={13} className="mt-0.5 shrink-0" />Selecting a judgment persists the current note with this snapshot. It does not modify the strategy.</div>
    </div>
  </Panel>;
}

function SnapshotNavigator({ snapshots, active, onSelect }: { snapshots: VisualValidationSnapshot[]; active: VisualValidationSnapshot; onSelect: (id: string) => void }) {
  return <Panel>
    <PanelTitle eyebrow="Same category / sample index" title="Other samples" right={<span className="mono text-[10px] text-muted-foreground">{snapshots.length}</span>} />
    {snapshots.length > 1 ? <div className="divide-y divide-border border-t border-border">{snapshots.map((snapshot) => <button type="button" key={snapshot.snapshotId} onClick={() => onSelect(snapshot.snapshotId)} className={`flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition hover:bg-muted/40 ${active.snapshotId === snapshot.snapshotId ? "bg-accent/10" : ""}`}><span className="min-w-0"><span className="mono block text-[10px] text-muted-foreground">sample {String(snapshot.sampleIndex).padStart(2, "0")} · {snapshot.tradingDate}</span><span className="mt-1 block truncate text-xs font-semibold">{snapshot.machineLabel}</span></span><ReviewDot status={snapshot.review.status} /></button>)}</div> : <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground">Only one generated sample is available for this category.</div>}
  </Panel>;
}

function DiscrepancyPanel({ report, open, setOpen, pending, onExport }: { report: VisualValidationDiscrepancyReport | null; open: boolean; setOpen: (open: boolean) => void; pending: boolean; onExport: () => void }) {
  return <Panel>
    <div className="flex items-center justify-between gap-3 px-5 py-4 sm:px-6"><div><div className="eyebrow text-muted-foreground">Output / review ledger</div><h2 className="mt-1 text-[14px] font-bold">Review export</h2></div><button type="button" onClick={onExport} disabled={pending} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[.08em] hover:bg-muted disabled:opacity-55" data-testid="button-export-reviews">{pending ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}Export JSON</button></div>
    <div className="border-t border-border px-5 py-3 text-[11px] leading-5 text-muted-foreground sm:px-6">Export the current set as machine-readable evidence for rule review. The report contains only persisted human judgments and their causal cursors.</div>
    {report && <div className="border-t border-border bg-accent/8 px-5 py-3 text-xs sm:px-6"><div className="flex items-center justify-between gap-3"><span><strong>{report.reviewedSnapshots}</strong> of {report.totalSnapshots} snapshots reviewed</span><button type="button" onClick={() => setOpen(!open)} className="font-bold text-accent-foreground underline">{open ? "Hide detail" : "Show detail"}</button></div>{open && <div className="mt-3 space-y-2">{report.reviews.length ? report.reviews.slice(0, 8).map((item, index) => <pre key={index} className="overflow-auto border border-border bg-card p-2 text-[9px] leading-4">{JSON.stringify(item, null, 2)}</pre>) : <p className="text-muted-foreground">No human reviews have been labeled yet.</p>}{report.discrepancies.length > 0 && <p className="text-muted-foreground">{report.discrepancies.length} incorrect or uncertain review{report.discrepancies.length === 1 ? "" : "s"} require attention.</p>}</div>}</div>}
  </Panel>;
}

function UnavailableWorkspace({ coverage, source }: { coverage: VisualValidationSet["categoryCoverage"]; source: VisualValidationSet["source"] }) {
  const historical = source === "historical_databento";
  return <Panel accent><div className="flex min-h-[280px] flex-col items-center justify-center px-8 py-12 text-center"><div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-muted text-muted-foreground"><AlertTriangle size={22} /></div><h2 className="display text-xl font-bold">No category sample is available.</h2><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{historical ? "No qualifying historical example found. The room will not fabricate a chart." : "This set did not produce an available category. The room will not fabricate a chart."} Generate another set or select an available category above.</p><div className="mt-5 flex flex-wrap justify-center gap-2">{coverage.filter((item) => item.count > 0).map((item) => <span key={item.category} className="border border-border bg-muted/35 px-2.5 py-1.5 text-[10px] font-bold uppercase">{prettyCategory(item.category)}</span>)}</div></div></Panel>;
}

function EmptyReview() {
  return <div className="flex min-h-[360px] flex-col items-center justify-center px-8 text-center"><div className="mb-5 flex h-14 w-14 items-center justify-center rounded-md bg-accent/20"><FileSearch size={24} /></div><h2 className="display text-2xl font-bold">The review room is empty.</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">Choose a simulated fixture or Historical Databento source to begin inspecting machine evidence against raw candles.</p></div>;
}

function moveSnapshot(snapshots: VisualValidationSnapshot[], active: VisualValidationSnapshot, direction: -1 | 1, setSelected: (id: string) => void) {
  const index = snapshots.findIndex((snapshot) => snapshot.snapshotId === active.snapshotId);
  const next = snapshots[index + direction];
  if (next) setSelected(next.snapshotId);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="eyebrow mb-1.5 block text-muted-foreground">{label}</span>{children}</label>;
}

function ManifestItem({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="bg-card px-4 py-4"><div className="flex items-center gap-2 text-[10px] text-muted-foreground">{icon}{label}</div><div className="mono mt-2 break-words text-[11px]">{value}</div></div>;
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-xs font-medium">{value}</div>{sub && <div className="mono mt-1 text-[9px] text-muted-foreground">{sub}</div>}</div>;
}

function ReviewDot({ status }: { status: VisualValidationReviewStatus }) {
  if (status === "unreviewed") return <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/50" aria-label="Unreviewed" />;
  const tone = status === "correct" ? "bg-[hsl(var(--positive))]" : status === "incorrect" ? "bg-[hsl(var(--negative))]" : "bg-accent";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} aria-label={status.replaceAll("_", " ")} />;
}