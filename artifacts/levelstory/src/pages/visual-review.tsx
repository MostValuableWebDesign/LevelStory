import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  Minimize2,
  MoveLeft,
  MoveRight,
  RotateCcw,
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
  useAnalyzeVisualValidationTeaching,
} from "@workspace/api-client-react";
import type {
  VisualValidationAnnotation,
  VisualValidationCategoryAnchor,
  VisualValidationCategory,
  VisualValidationDiscrepancyReport,
  VisualValidationRequest,
  VisualValidationReviewStatus,
  VisualValidationReviewRequest,
  VisualValidationProposedRuleAnalysis,
  VisualValidationSet,
  VisualValidationSnapshot,
  StrategyId,
} from "@workspace/api-client-react";
import {
  DEFAULT_LEVEL_TOLERANCE_TICKS,
  LEVEL_TOLERANCE_TICKS,
  MES_TICK_SIZE,
  levelTolerancePoints,
} from "@workspace/api-spec/constants";
import { LevelStoryShell } from "@/components/levelstory-shell";
import { LockedNote, Panel, PanelTitle, PageIntro, QueryError, QuerySkeleton, ShadowBadge } from "@/components/levelstory-ui";
import { deriveTeachingCompatibilityFields, evaluateDynamicLevelInteraction, normalizeTeachingQualifyingLevels } from "@/lib/visual-review-teaching";
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
  selectChartEvents,
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
  mergeOrbNtzAnnotations,
  priceToY,
  resolveFixedSlotFromClientPoint,
  selectSessionCandles,
  type SessionCandle,
  type SessionView,
  stackLabelPositions,
  type CandleInspection,
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
const TRADE_CATEGORY_VALUES = new Set<VisualValidationCategory>([
  "qualified_trade",
  "bullish_patience_candle",
  "bearish_patience_candle",
  "strong_breakout",
  "pullback",
  "consolidation",
  "stop_exit",
  "target_exit",
  "runner_exit",
]);
const STRATEGY_TABS: Array<{ id: StrategyId; label: string }> = [
  { id: "ORB_PULLBACK_CONTINUATION", label: "ORB pullback continuation" },
  { id: "CONSOLIDATION_BREAKOUT_CONTINUATION", label: "Consolidation breakout continuation" },
  { id: "PATIENCE_CANDLE_CONTINUATION", label: "Patience continuation" },
  { id: "EQUIVALENT_CANDLE_REVERSAL", label: "Equivalent-candle reversal" },
];

const REVIEW_OPTIONS: Array<{ value: Exclude<VisualValidationReviewStatus, "unreviewed">; label: string; detail: string }> = [
  { value: "correct", label: "Correct", detail: "Machine story matches the candles." },
  { value: "incorrect", label: "Incorrect", detail: "The machine label does not hold up." },
  { value: "uncertain", label: "Uncertain", detail: "Evidence is not decisive." },
  { value: "rule_needs_clarification", label: "Rule needs clarification", detail: "The rule or annotation needs a sharper definition." },
  { value: "missed_trade", label: "Missed trade", detail: "The candles contain a valid, causal trade the machine did not capture." },
  { value: "false_positive_trade", label: "False-positive trade", detail: "The machine trade is not supported by the raw causal candle story." },
];

const INITIAL_REQUEST: VisualValidationRequest = {
  symbol: "MES",
  endDate: "2026-08-26",
  inSampleDays: 5,
  outOfSampleDays: 2,
  seed: undefined,
  premarketAvailable: true,
  source: "historical_databento",
  reviewMode: "trades_only",
};

function storedReviewSource(): VisualValidationRequest["source"] {
  if (typeof window === "undefined") return "historical_databento";
  const source = window.localStorage.getItem("levelstory.visualReviewSource");
  return source === "simulated" || source === "historical_databento" ? source : "historical_databento";
}

function storedReviewSetId(): string {
  if (typeof window === "undefined") return "";
  const requested = new URLSearchParams(window.location.search).get("reviewSetId");
  if (requested) return requested;
  return window.localStorage.getItem("levelstory.visualReviewSetId") ?? "";
}

function requestedReviewCategory(): VisualValidationCategory | null {
  if (typeof window === "undefined") return null;
  const candidate = new URLSearchParams(window.location.search).get("category");
  return CATEGORIES.some((category) => category.value === candidate) ? candidate as VisualValidationCategory : null;
}

function requestedSessionView(): SessionView {
  if (typeof window === "undefined") return "full_regular";
  const queryView = new URLSearchParams(window.location.search).get("view");
  if (queryView === "primary" || queryView === "full_regular") return queryView;
  return window.localStorage.getItem("levelstory.visualReviewWindow") === "primary" ? "primary" : "full_regular";
}

function requestedPremarket(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("premarket") === "1";
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

function anchorTone(role: VisualValidationCategoryAnchor["relatedCandles"][number]["role"]): string {
  if (role === "patience") return "hsl(var(--positive))";
  if (role === "entry") return "hsl(var(--accent))";
  if (role === "fill") return "hsl(204 72% 48%)";
  if (role === "exit") return "hsl(var(--negative))";
  return "hsl(var(--muted-foreground))";
}

function levelStroke(annotation: VisualValidationAnnotation): string {
  if (annotation.id === "orb-high" || annotation.id === "orb-low") return "hsl(33 93% 52%)";
  if (annotation.id === "premarket-high" || annotation.id === "premarket-low") return "hsl(var(--positive))";
  if (annotation.id === "previous-session-high" || annotation.id === "previous-session-low") return "hsl(259 55% 48%)";
  if (annotation.id === "two-sessions-high" || annotation.id === "two-sessions-low") return "hsl(190 58% 38%)";
  if (annotation.id === "vwap") return "hsl(5 58% 46%)";
  if (annotation.id === "ema-200") return "hsl(145 45% 42%)";
  if (annotation.id.startsWith("critical-") || annotation.id.includes("support") || annotation.id.includes("resistance")) return "hsl(214 37% 15%)";
  if (annotation.id === "entry-buffer") return "hsl(var(--positive))";
  if (annotation.id === "strategy-stop" || annotation.id === "catastrophe-stop") return "hsl(var(--negative))";
  if (annotation.id === "target" || annotation.id === "runner-threshold") return "hsl(var(--positive))";
  if (annotation.id.startsWith("fib-")) return "hsl(var(--muted-foreground))";
  return annotationTone(annotation.color);
}

export default function VisualReview() {
  const [request, setRequest] = useState<VisualValidationRequest>(() => ({
    ...INITIAL_REQUEST,
    source: storedReviewSource(),
    seed: storedReviewSource() === "simulated" ? 11 : undefined,
  }));
  const [reviewSetId, setReviewSetId] = useState(storedReviewSetId);
  const [localSet, setLocalSet] = useState<VisualValidationSet | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<VisualValidationCategory | null>(requestedReviewCategory);
  const [selectedStrategyKey, setSelectedStrategyKey] = useState<StrategyId | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewStatus, setReviewStatus] = useState<Exclude<VisualValidationReviewStatus, "unreviewed"> | null>(null);
  const [lockedEntryCandle, setLockedEntryCandle] = useState<SessionCandle | null>(null);
  const [teachingDraft, setTeachingDraft] = useState<NonNullable<VisualValidationReviewRequest["teaching"]> | null>(null);
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<VisualValidationDiscrepancyReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [analysis, setAnalysis] = useState<VisualValidationProposedRuleAnalysis | null>(null);
  const [authenticated, setAuthenticated] = useState(false);

  const setQuery = useGetVisualValidationSet(
    reviewSetId ? { reviewSetId } : undefined,
    { query: { enabled: true, staleTime: 30_000, queryKey: ["visual-validation-set", reviewSetId || "latest"] } },
  );
  const createSet = useCreateVisualValidationSet();
  const recordReview = useRecordVisualValidationReview();
  const analyzeRule = useAnalyzeVisualValidationTeaching();
  const exportId = localSet?.reviewSetId ?? setQuery.data?.reviewSetId ?? reviewSetId;
  const exportQuery = useExportVisualValidationDiscrepancies(
    { reviewSetId: exportId || "00000000-0000-0000-0000-000000000000" },
    { query: { enabled: false, queryKey: ["visual-validation-discrepancies", exportId || "none"] } },
  );

  useEffect(() => {
    let active = true;
    const authError = new URLSearchParams(window.location.search).get("authError");
    if (authError) setMessage("Login could not be completed. Please try Log in again.");
    fetch("/api/auth/user", { credentials: "include" })
      .then((response) => response.ok ? response.json() as Promise<{ user?: unknown }> : { user: null })
      .then((result) => { if (active) setAuthenticated(Boolean(result.user)); })
      .catch(() => { if (active) setAuthenticated(false); });
    return () => { active = false; };
  }, []);

  const data = localSet ?? setQuery.data;
  const coverage = data?.categoryCoverage ?? [];
  const snapshots = data?.snapshots ?? [];
  const strategySnapshots = useMemo(
    () => selectedStrategyKey ? snapshots.filter((snapshot) => snapshot.strategyKey === selectedStrategyKey) : snapshots,
    [selectedStrategyKey, snapshots],
  );
  const availableCategories = useMemo(() => coverage
    .filter((item) => item.available && strategySnapshots.some((snapshot) => snapshot.category === item.category) && TRADE_CATEGORY_VALUES.has(item.category))
    .map((item) => item.category), [coverage, strategySnapshots]);
  const categorySnapshots = useMemo(
    () => strategySnapshots.filter((snapshot) => snapshot.category === selectedCategory),
    [selectedCategory, strategySnapshots],
  );
  const activeSnapshot = categorySnapshots.find((snapshot) => snapshot.snapshotId === selectedSnapshotId) ?? categorySnapshots[0];

  useEffect(() => {
    if (data && !reviewSetId && typeof window !== "undefined") {
      window.localStorage.setItem("levelstory.visualReviewSetId", data.reviewSetId);
    }
  }, [data, reviewSetId]);

  useEffect(() => {
    if (!data) return;
    setRequest(data.request);
    if (!availableCategories.length) {
      setSelectedCategory(null);
      return;
    }
    const selectedIsExplicitDiagnostic = selectedCategory !== null
      && !TRADE_CATEGORY_VALUES.has(selectedCategory)
      && (data.source === "simulated" || data.request.reviewMode === "trades_and_diagnostics")
      && snapshots.some((snapshot) => snapshot.category === selectedCategory);
    if (!selectedCategory || (!availableCategories.includes(selectedCategory) && !selectedIsExplicitDiagnostic)) {
      setSelectedCategory(availableCategories[0]);
    }
  }, [availableCategories, data, selectedCategory, selectedStrategyKey]);

  useEffect(() => {
    if (!activeSnapshot) {
      setSelectedSnapshotId("");
      setReviewNote("");
      setReviewStatus(null);
      setLockedEntryCandle(null);
      setTeachingDraft(null);
      return;
    }
    setSelectedSnapshotId(activeSnapshot.snapshotId);
    setReviewNote(activeSnapshot.review.note ?? "");
    setReviewStatus(activeSnapshot.review.status === "unreviewed" ? null : activeSnapshot.review.status);
    const savedTeaching = activeSnapshot.review.teaching;
    const savedEntry = savedTeaching ? activeSnapshot.reviewCandles.find((candle) => candle.openTime === savedTeaching.entryCandleOpenTime && candle.closeTime === savedTeaching.entryCandleCloseTime) : undefined;
    setLockedEntryCandle(savedEntry ? {
      ...savedEntry,
      session: "regular",
      machineVisible: Date.parse(savedEntry.closeTime) <= Date.parse(activeSnapshot.evaluationCursor.closeTime),
    } : null);
    setTeachingDraft(savedTeaching ? {
      judgment: savedTeaching.judgment,
      direction: savedTeaching.direction,
      levelCandleOpenTime: savedTeaching.levelCandleOpenTime ?? savedTeaching.patienceCandleOpenTime,
      levelCandleCloseTime: savedTeaching.levelCandleCloseTime ?? savedTeaching.patienceCandleCloseTime,
      entryCandleOpenTime: savedTeaching.entryCandleOpenTime,
      entryCandleCloseTime: savedTeaching.entryCandleCloseTime,
      patienceCandleOpenTime: savedTeaching.patienceCandleOpenTime,
      patienceCandleCloseTime: savedTeaching.patienceCandleCloseTime,
      entryBufferTicks: savedTeaching.entryBufferTicks,
      levelToleranceTicks: savedTeaching.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS,
      qualifyingLevelId: savedTeaching.qualifyingLevelId,
      qualifyingLevelRangeLow: savedTeaching.qualifyingLevelRangeLow,
      qualifyingLevelRangeHigh: savedTeaching.qualifyingLevelRangeHigh,
      qualifyingLevels: savedTeaching.qualifyingLevels,
      pullbackLevels: savedTeaching.pullbackLevels?.length ? savedTeaching.pullbackLevels : savedTeaching.pullbackLevel !== undefined ? [savedTeaching.pullbackLevel] : [],
      setupType: savedTeaching.setupType,
      confidence: savedTeaching.confidence,
      explanation: savedTeaching.explanation,
    } : null);
  }, [activeSnapshot]);

  const savedStatus = activeSnapshot?.review.status === "unreviewed" ? null : activeSnapshot?.review.status ?? null;
  const savedNote = activeSnapshot?.review.note ?? "";
  const savedCompatibility = activeSnapshot?.review.teaching
    ? deriveTeachingCompatibilityFields(activeSnapshot.review.teaching.qualifyingLevels)
    : null;
  const savedTeachingKey = activeSnapshot?.review.teaching ? JSON.stringify({
    judgment: activeSnapshot.review.teaching.judgment,
    direction: activeSnapshot.review.teaching.direction,
    levelCandleOpenTime: activeSnapshot.review.teaching.levelCandleOpenTime ?? activeSnapshot.review.teaching.patienceCandleOpenTime,
    levelCandleCloseTime: activeSnapshot.review.teaching.levelCandleCloseTime ?? activeSnapshot.review.teaching.patienceCandleCloseTime,
    entryCandleOpenTime: activeSnapshot.review.teaching.entryCandleOpenTime,
    entryCandleCloseTime: activeSnapshot.review.teaching.entryCandleCloseTime,
    patienceCandleOpenTime: activeSnapshot.review.teaching.patienceCandleOpenTime,
    patienceCandleCloseTime: activeSnapshot.review.teaching.patienceCandleCloseTime,
    entryBufferTicks: activeSnapshot.review.teaching.entryBufferTicks,
    levelToleranceTicks: activeSnapshot.review.teaching.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS,
    qualifyingLevelId: activeSnapshot.review.teaching.qualifyingLevelId,
    qualifyingLevelRangeLow: activeSnapshot.review.teaching.qualifyingLevelRangeLow,
    qualifyingLevelRangeHigh: activeSnapshot.review.teaching.qualifyingLevelRangeHigh,
    qualifyingLevels: normalizeTeachingQualifyingLevels(activeSnapshot.review.teaching.qualifyingLevels),
    pullbackLevels: savedCompatibility?.pullbackLevels.length
      ? savedCompatibility.pullbackLevels
      : activeSnapshot.review.teaching.pullbackLevels?.length ? activeSnapshot.review.teaching.pullbackLevels : activeSnapshot.review.teaching.pullbackLevel !== undefined ? [activeSnapshot.review.teaching.pullbackLevel] : [],
    setupType: activeSnapshot.review.teaching.setupType,
    confidence: activeSnapshot.review.teaching.confidence,
    explanation: activeSnapshot.review.teaching.explanation,
  }) : "";
  const draftCompatibility = teachingDraft ? deriveTeachingCompatibilityFields(teachingDraft.qualifyingLevels) : null;
  const draftTeachingKey = teachingDraft ? JSON.stringify({
    ...teachingDraft,
    qualifyingLevels: normalizeTeachingQualifyingLevels(teachingDraft.qualifyingLevels),
    ...(draftCompatibility?.pullbackLevels.length
      ? draftCompatibility
      : { pullbackLevels: teachingDraft.pullbackLevels }),
  }) : "";
  const reviewDirty = Boolean(activeSnapshot && (reviewStatus !== savedStatus || reviewNote.trim() !== savedNote.trim() || draftTeachingKey !== savedTeachingKey));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!reviewDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [reviewDirty]);

  const confirmDiscardReview = () => !reviewDirty || typeof window === "undefined" || window.confirm("You have an unsaved review. Leave it without submitting?");

  const selectCategory = (category: VisualValidationCategory) => {
    const item = coverage.find((entry) => entry.category === category);
    if (!item?.available || item.count === 0) return;
    if (!confirmDiscardReview()) return;
    setSelectedCategory(category);
    setSelectedSnapshotId("");
    setReport(null);
  };

  const selectSnapshot = (snapshotId: string) => {
    if (snapshotId === activeSnapshot?.snapshotId || !confirmDiscardReview()) return;
    setSelectedSnapshotId(snapshotId);
  };

  const submitGeneration = (event: FormEvent) => {
    event.preventDefault();
    if (!confirmDiscardReview()) return;
    setMessage("");
    setReport(null);
    createSet.mutate({ data: request }, {
      onSuccess: (nextSet) => {
        setLocalSet(nextSet);
        setReviewSetId(nextSet.reviewSetId);
         setReviewStatus(null);
         setReviewNote("");
         setAnalysis(null);
        if (typeof window !== "undefined") window.localStorage.setItem("levelstory.visualReviewSetId", nextSet.reviewSetId);
        setMessage(`Generated ${nextSet.snapshots.length} causal snapshots.`);
      },
       onError: (error) => setMessage(apiErrorMessage(error) ?? "The deterministic set could not be generated. Check the date window and try again."),
    });
  };

  const saveReview = (status: Exclude<VisualValidationReviewStatus, "unreviewed">, moveNext = false) => {
    if (!data || !activeSnapshot) return;
    setMessage("");
    recordReview.mutate({
      data: {
        reviewSetId: data.reviewSetId,
        snapshotId: activeSnapshot.snapshotId,
        status,
        note: reviewNote.trim() || null,
        ...((status === "missed_trade" || status === "false_positive_trade" || status === "rule_needs_clarification") && teachingDraft
          ? { teaching: status === "false_positive_trade" ? { ...teachingDraft, judgment: "false_positive_trade" as const } : teachingDraft }
          : {}),
      },
    }, {
      onSuccess: (saved) => {
        setLocalSet((current) => {
          const base = current ?? data;
          return {
            ...base,
            snapshots: base.snapshots.map((snapshot) => snapshot.snapshotId === saved.snapshotId
              ? { ...snapshot, review: { status: saved.status, note: saved.note, reviewedAt: saved.reviewedAt, ...(saved.teaching ? { teaching: saved.teaching } : {}) } }
              : snapshot),
          };
        });
        if (saved.status !== "unreviewed") setReviewStatus(saved.status);
        setReviewNote(saved.note ?? "");
        setTeachingDraft(saved.teaching ? {
          judgment: saved.teaching.judgment,
          direction: saved.teaching.direction,
          levelCandleOpenTime: saved.teaching.levelCandleOpenTime ?? saved.teaching.patienceCandleOpenTime,
          levelCandleCloseTime: saved.teaching.levelCandleCloseTime ?? saved.teaching.patienceCandleCloseTime,
          entryCandleOpenTime: saved.teaching.entryCandleOpenTime,
          entryCandleCloseTime: saved.teaching.entryCandleCloseTime,
          patienceCandleOpenTime: saved.teaching.patienceCandleOpenTime,
          patienceCandleCloseTime: saved.teaching.patienceCandleCloseTime,
          entryBufferTicks: saved.teaching.entryBufferTicks,
          levelToleranceTicks: saved.teaching.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS,
          qualifyingLevelId: saved.teaching.qualifyingLevelId,
          qualifyingLevelRangeLow: saved.teaching.qualifyingLevelRangeLow,
          qualifyingLevelRangeHigh: saved.teaching.qualifyingLevelRangeHigh,
          qualifyingLevels: saved.teaching.qualifyingLevels,
          pullbackLevels: saved.teaching.pullbackLevels?.length ? saved.teaching.pullbackLevels : saved.teaching.pullbackLevel !== undefined ? [saved.teaching.pullbackLevel] : [],
          setupType: saved.teaching.setupType,
          confidence: saved.teaching.confidence,
          explanation: saved.teaching.explanation,
        } : teachingDraft);
         setMessage(saved.teaching
           ? "Teaching example saved permanently. The active formula has not changed."
           : `${savedStatus ? "Updated" : "Submitted"} ${status.replaceAll("_", " ")} review.`);
        if (moveNext) {
          const next = categorySnapshots[categorySnapshots.findIndex((snapshot) => snapshot.snapshotId === activeSnapshot.snapshotId) + 1];
          if (next) setSelectedSnapshotId(next.snapshotId);
        }
      },
      onError: (error) => setMessage(`Unable to save this review: ${apiErrorMessage(error) ?? (error instanceof Error ? error.message : "The server rejected the submission.")}`),
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
            <GenerationPanel request={request} setRequest={(next) => {
              setRequest(next);
              if (typeof window !== "undefined" && next.source) window.localStorage.setItem("levelstory.visualReviewSource", next.source);
            }} onSubmit={submitGeneration} pending={createSet.isPending} message={message} />
             <CoverageRail
               data={data}
               loading={setQuery.isLoading}
               selectedStrategyKey={selectedStrategyKey}
               selectedCategory={selectedCategory}
               selectedSnapshot={activeSnapshot}
               selectedSnapshotIndex={categorySnapshots.findIndex((item) => item.snapshotId === activeSnapshot?.snapshotId)}
               selectedSnapshotTotal={categorySnapshots.length}
               onSelectStrategy={(key) => {
                 if (!confirmDiscardReview()) return;
                 setSelectedStrategyKey(key);
                 setSelectedCategory(null);
                 setSelectedSnapshotId("");
               }}
               onSelect={selectCategory}
               onPrevious={() => activeSnapshot && moveSnapshot(categorySnapshots, activeSnapshot, -1, selectSnapshot)}
               onNext={() => activeSnapshot && moveSnapshot(categorySnapshots, activeSnapshot, 1, selectSnapshot)}
             />
          </div>

          {setQuery.isLoading && !data ? <Panel><QuerySkeleton rows={6} /></Panel> : setQuery.isError && !data ? (
            <Panel accent><QueryError onRetry={() => setQuery.refetch()} message="The visual-validation set could not be loaded." /></Panel>
          ) : !data ? (
            <Panel><EmptyReview /></Panel>
          ) : (
            <>
              {data.funnelDiagnostics && <FunnelDiagnostics data={data.funnelDiagnostics} />}
              {activeSnapshot ? (
                <div className={`visual-review-workspace mt-5 ${workspaceExpanded ? "is-expanded" : ""}`} data-testid="visual-review-workspace">
                  <div className="visual-review-chart-column min-w-0 space-y-5">
                     <Panel>
                      <PanelTitle eyebrow="Raw market evidence / causal only" title="Chart evidence" right={<CausalTag />} />
                      <CausalChart snapshot={activeSnapshot} source={data.source} expanded={workspaceExpanded} lockedEntryCandle={lockedEntryCandle} teaching={teachingDraft} onToggleExpanded={() => setWorkspaceExpanded((current) => !current)} onLockCandle={(candle) => {
                        setLockedEntryCandle(candle);
                        if (!candle) return;
                        const entryIndex = activeSnapshot.reviewCandles.findIndex((item) => item.openTime === candle.openTime && item.closeTime === candle.closeTime);
                        const patience = entryIndex > 0 ? activeSnapshot.reviewCandles[entryIndex - 1] : null;
                        const direction = activeSnapshot.categoryAnchor.direction === "short" ? "short" : "long";
                        const tolerancePoints = levelTolerancePoints(teachingDraft?.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS);
                        const containedLevels = activeSnapshot.annotations
                          .filter((annotation) => annotation.available && annotation.price !== null && annotation.kind !== "candle")
                          .filter((annotation) => !patience || Math.max(0, (annotation.rangeLow ?? annotation.price as number) - patience.high, patience.low - (annotation.rangeHigh ?? annotation.price as number)) <= tolerancePoints);
                        const selectedLevel = containedLevels[0];
                        const pullbackLevel = selectedLevel?.price ?? candle.close;
                        const existingLevels = (current: NonNullable<typeof teachingDraft>) => current.pullbackLevels
                          .filter((price) => !patience || Math.max(0, price - patience.high, patience.low - price) <= levelTolerancePoints(current.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS));
                        setTeachingDraft((current) => ({
                          judgment: current?.judgment === "false_positive_trade" ? "missed_trade" : current?.judgment ?? "missed_trade",
                          direction: current?.direction ?? direction,
                          levelCandleOpenTime: patience?.openTime ?? candle.openTime,
                          levelCandleCloseTime: patience?.closeTime ?? candle.closeTime,
                          entryCandleOpenTime: candle.openTime,
                          entryCandleCloseTime: candle.closeTime,
                          patienceCandleOpenTime: patience?.openTime ?? "",
                          patienceCandleCloseTime: patience?.closeTime ?? "",
                          entryBufferTicks: current?.entryBufferTicks ?? 4,
                            levelToleranceTicks: current?.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS,
                          qualifyingLevelId: current?.qualifyingLevelId ?? selectedLevel?.id,
                          qualifyingLevelRangeLow: current?.qualifyingLevelRangeLow ?? selectedLevel?.rangeLow,
                          qualifyingLevelRangeHigh: current?.qualifyingLevelRangeHigh ?? selectedLevel?.rangeHigh,
                          pullbackLevels: current ? (existingLevels(current).length ? existingLevels(current) : [pullbackLevel]) : [pullbackLevel],
                          setupType: current?.setupType ?? activeSnapshot.strategyKey,
                          confidence: current?.confidence ?? "low",
                          explanation: current?.explanation ?? "",
                        }));
                      }} />
                    </Panel>
                    <ChartEvidence snapshot={activeSnapshot} />
                    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,.42fr)]">
                      <ReviewPanel snapshot={activeSnapshot} status={reviewStatus} setStatus={setReviewStatus} note={reviewNote} setNote={setReviewNote} dirty={reviewDirty} pending={recordReview.isPending} onSave={saveReview} message={message} lockedEntryCandle={lockedEntryCandle} teaching={teachingDraft} setTeaching={setTeachingDraft} authenticated={authenticated} />
                      <div className="space-y-5">
                        <SnapshotNavigator snapshots={categorySnapshots} active={activeSnapshot} onSelect={selectSnapshot} />
                        <DiscrepancyPanel report={report} open={reportOpen} setOpen={setReportOpen} pending={exportQuery.isFetching} onExport={exportReport} />
                         <ProposedRulePanel analysis={analysis} pending={analyzeRule.isPending} onAnalyze={() => {
                           if (!data) return;
                           analyzeRule.mutate({ data: { reviewSetId: data.reviewSetId, ...(activeSnapshot.review.teaching?.teachingId ? { teachingId: activeSnapshot.review.teaching.teachingId } : {}) } }, {
                             onSuccess: setAnalysis,
                           });
                         }} />
                      </div>
                    </div>
                  </div>
                </div>
              ) : <UnavailableWorkspace coverage={coverage} source={data.source} />}
            </>
          )}
        </div>
      </div>
    </LevelStoryShell>
  );
}

function FunnelDiagnostics({ data }: { data: NonNullable<VisualValidationSet["funnelDiagnostics"]> }) {
  return <Panel>
    <PanelTitle eyebrow="Detection funnel / every causal occurrence" title="Where evidence was retained" right={<span className="mono text-[10px] text-muted-foreground">{data.occurrenceCount} ledger occurrences · {data.sessionCount} sessions</span>} />
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-4" data-testid="detection-funnel">
      {data.stages.map((stage) => <div key={stage.stage} className="bg-card px-4 py-3">
        <div className="text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">{stage.stage.replaceAll("_", " ")}</div>
        <div className="mt-1 flex items-baseline gap-2"><span className="display text-2xl font-bold">{stage.count}</span><span className="mono text-[10px] text-muted-foreground">{stage.percentOfPreceding}% of prior</span></div>
      </div>)}
    </div>
    {data.rejectionCounts.length > 0 && <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
      <span className="font-semibold text-foreground">Recorded rejection gates:</span>{" "}
      {data.rejectionCounts.map((item) => `${item.stage.replaceAll("_", " ")} (${item.count})`).join(" · ")}
    </div>}
  </Panel>;
}

function GenerationPanel({ request, setRequest, onSubmit, pending, message }: { request: VisualValidationRequest; setRequest: (next: VisualValidationRequest) => void; onSubmit: (event: FormEvent) => void; pending: boolean; message: string }) {
  const update = (key: keyof VisualValidationRequest, value: string | number | boolean | undefined) => setRequest({ ...request, [key]: value });
  const updateSource = (source: VisualValidationRequest["source"]) => setRequest({
    ...request,
    source,
    seed: source === "simulated" ? (request.seed ?? 11) : undefined,
  });
  const hasError = ["could not", "not saved", "unable to save", "unavailable", "not found", "invalid", "requires", "must include"].some((term) => message.toLowerCase().includes(term));
  return <Panel accent>
    <PanelTitle eyebrow="Generate / deterministic replay" title="Build a review set" right={<SlidersHorizontal size={16} className="text-muted-foreground" />} />
    <form onSubmit={onSubmit} className="space-y-4 border-t border-border p-5 sm:p-6">
      <Field label={<span className="inline-flex items-center gap-1.5">Data source <InfoTip label="Data source" text="Historical Databento is the default and uses indexed MES contract candles. Simulated fixtures are available only as an explicit test option." /></span>}>
        <select
          className="field"
          value={request.source ?? "historical_databento"}
          onChange={(event) => updateSource(event.target.value as "simulated" | "historical_databento")}
          data-testid="select-visual-review-source"
        >
          <option value="historical_databento">Historical Databento data</option>
          <option value="simulated">Simulated fixture data · testing only</option>
        </select>
      </Field>
      <Field label={<span className="inline-flex items-center gap-1.5">Review mode <InfoTip label="Review mode" text="Trades-only keeps the main room focused on trade-linked evidence. The diagnostics option adds a separate, collapsed no-entry section for explicit rule inspection." /></span>}>
        <select className="field" value={request.reviewMode ?? "trades_only"} onChange={(event) => update("reviewMode", event.target.value as "trades_only" | "confirmed_signals" | "trades_and_diagnostics")} data-testid="select-visual-review-mode">
          <option value="trades_only">Trades only · default</option>
          <option value="confirmed_signals">Confirmed signals · may be unfinalized</option>
          <option value="trades_and_diagnostics">Trades + no-entry diagnostics</option>
        </select>
        <span className="mt-1 block text-[10px] text-muted-foreground">{request.source === "historical_databento" ? "Historical mode filters no-entry samples unless confirmed signals or diagnostics are explicitly enabled." : "Simulated fixtures remain available for deterministic contract testing."}</span>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Symbol"><select className="field mono" value={request.symbol} onChange={(event) => update("symbol", event.target.value as "MES")}><option value="MES">MES</option></select></Field>
        <Field label={<span className="inline-flex items-center gap-1.5">Seed <InfoTip label="Seed" text="Seeds affect simulated fixture generation only. Historical mode is immutable, so this control is disabled." /></span>}>
          <input className="field mono" type="number" min="0" max="1000000" value={request.seed ?? ""} disabled={request.source === "historical_databento"} aria-describedby="visual-review-seed-help" onChange={(event) => update("seed", event.target.value === "" ? undefined : Number(event.target.value))} />
          <span id="visual-review-seed-help" className="mt-1 block text-[10px] text-muted-foreground">{request.source === "historical_databento" ? "Not used for historical candles." : "Used to reproduce the same fixture set."}</span>
        </Field>
      </div>
      <Field label={<span className="inline-flex items-center gap-1.5">Review-period end date · New York <InfoTip label="Review-period end date" text="The last requested trading date in the review period. Individual examples may be earlier because the period includes in-sample and holdout sessions." /></span>}>
        <input required className="field mono" type="date" value={request.endDate} onChange={(event) => update("endDate", event.target.value)} />
      </Field>
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

function CoverageRail({ data, loading, selectedStrategyKey, selectedCategory, selectedSnapshot, selectedSnapshotIndex, selectedSnapshotTotal, onSelectStrategy, onSelect, onPrevious, onNext }: { data?: VisualValidationSet; loading: boolean; selectedStrategyKey: StrategyId | null; selectedCategory: VisualValidationCategory | null; selectedSnapshot?: VisualValidationSnapshot; selectedSnapshotIndex: number; selectedSnapshotTotal: number; onSelectStrategy: (key: StrategyId | null) => void; onSelect: (category: VisualValidationCategory) => void; onPrevious: () => void; onNext: () => void }) {
  if (loading && !data) return <Panel><QuerySkeleton rows={5} /></Panel>;
  if (!data) return <Panel><div className="flex min-h-[300px] items-center justify-center p-6 text-sm text-muted-foreground">Generate a set to open the review room.</div></Panel>;
  const historical = data.source === "historical_databento";
  const strategySnapshots = selectedStrategyKey ? data.snapshots.filter((snapshot) => snapshot.strategyKey === selectedStrategyKey) : data.snapshots;
  const tradeCategories = CATEGORIES.filter((category) => TRADE_CATEGORY_VALUES.has(category.value));
  const diagnostics = CATEGORIES.filter((category) => !TRADE_CATEGORY_VALUES.has(category.value));
  const coverageFor = (category: VisualValidationCategory) => data.categoryCoverage.find((entry) => entry.category === category);
  const isAvailable = (category: VisualValidationCategory) => {
    return strategySnapshots.some((snapshot) => snapshot.category === category);
  };
  const renderCategory = (category: (typeof CATEGORIES)[number]) => {
    const item = coverageFor(category.value);
    const count = strategySnapshots.filter((snapshot) => snapshot.category === category.value).length;
    const available = isAvailable(category.value);
    const selected = selectedCategory === category.value;
    return <button type="button" key={category.value} disabled={!available} onClick={() => onSelect(category.value)} className={`group min-h-[76px] bg-card px-4 py-3 text-left transition ${selected ? "bg-accent/12 ring-1 ring-inset ring-accent" : available ? "hover:bg-muted/55" : "cursor-not-allowed opacity-55"}`} aria-pressed={selected} data-testid={`button-category-${category.value}`}>
      <span className="flex items-start justify-between gap-2"><span className="text-xs font-semibold leading-4">{category.label}</span>{available ? <span className={`mono text-[11px] ${selected ? "text-accent-foreground" : "text-muted-foreground"}`}>{count}</span> : <X size={13} className="text-muted-foreground" aria-label="Unavailable" />}</span>
      <span className={`mt-3 block text-[9px] font-bold uppercase tracking-[.1em] ${available ? selected ? "text-accent-foreground" : "text-muted-foreground" : "text-muted-foreground"}`}>{available ? selected ? "Inspecting" : "Available" : historical ? "No trade-linked sample." : "Unavailable"}</span>
    </button>;
  };
  const diagnosticsEnabled = data.request.reviewMode === "trades_and_diagnostics" || data.source === "simulated";
  const diagnosticAvailable = diagnosticsEnabled && diagnostics.some((category) => isAvailable(category.value));
  return <Panel>
     <PanelTitle eyebrow="Coverage / strategy-linked samples" title="Select an available example" right={<span className="mono text-right text-[10px] text-muted-foreground" data-testid="review-period">Review period · {data.reviewPeriod.startDate} – {data.reviewPeriod.endDate}</span>} />
    <div className="flex flex-wrap gap-1 border-t border-border bg-muted/20 p-2" role="tablist" aria-label="Strategy review tabs">
      <button type="button" onClick={() => onSelectStrategy(null)} className={`rounded-sm px-3 py-2 text-[10px] font-bold uppercase ${selectedStrategyKey === null ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`} aria-selected={selectedStrategyKey === null} role="tab">All strategies</button>
      {STRATEGY_TABS.map((strategy) => {
        const count = data.snapshots.filter((snapshot) => snapshot.strategyKey === strategy.id).length;
        return <button type="button" key={strategy.id} onClick={() => onSelectStrategy(strategy.id)} className={`rounded-sm px-3 py-2 text-[10px] font-bold uppercase ${selectedStrategyKey === strategy.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`} aria-selected={selectedStrategyKey === strategy.id} role="tab">{strategy.label} · {count}</button>;
      })}
    </div>
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
      {tradeCategories.map(renderCategory)}
    </div>
    {diagnosticAvailable && <details className="border-t border-border" data-testid="diagnostic-categories">
      <summary className="cursor-pointer px-5 py-3 text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground sm:px-6">No-entry diagnostics · {diagnostics.filter((category) => isAvailable(category.value)).length} available</summary>
      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {diagnostics.map(renderCategory)}
      </div>
    </details>}
     {selectedSnapshot && <SnapshotHeaderContent snapshot={selectedSnapshot} request={data.request} index={selectedSnapshotIndex} total={selectedSnapshotTotal} onPrevious={onPrevious} onNext={onNext} />}
  </Panel>;
}

function SnapshotHeaderContent({ snapshot, request, index, total, onPrevious, onNext }: { snapshot: VisualValidationSnapshot; request: VisualValidationRequest; index: number; total: number; onPrevious: () => void; onNext: () => void }) {
  return <div className="border-t border-border bg-muted/20" data-testid="formula-development-sample">
    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="min-w-0">
        <div className="eyebrow mb-2 text-muted-foreground">Example {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")} · {snapshot.period === "in_sample" ? "formula-development sample" : "holdout sample"} <InfoTip label="Dataset role" text="Formula-development examples are in-sample. Holdout examples are out-of-sample and are not used to tune the rule." /></div>
        <div className="flex flex-wrap items-center gap-2"><h2 className="display text-2xl font-bold tracking-[-.045em]">{snapshot.categoryLabel}</h2><span className="border border-accent/45 bg-accent/10 px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em]">{snapshot.machineLabel}</span></div>
        <p className="mt-2 text-xs text-muted-foreground"><span className="font-semibold text-foreground">Example date</span> <span className="mono">{snapshot.tradingDate}</span> · <span className="font-semibold text-foreground">Contract</span> <span className="mono">{snapshot.contractSymbol}</span> · Formula evidence is machine-owned</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={onPrevious} disabled={index <= 0} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-muted disabled:opacity-35" aria-label="Previous sample"><ChevronLeft size={17} /></button>
        <button type="button" onClick={onNext} disabled={index < 0 || index >= total - 1} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-muted disabled:opacity-35" aria-label="Next sample"><ChevronRight size={17} /></button>
      </div>
    </div>
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
       <Metric label="Review-period end" value={request.endDate} sub="New York trading date" />
      <Metric label="Evaluation cursor" value={snapshot.evaluationCursor.newYork} sub={snapshot.evaluationCursor.utc} />
      <Metric label="Review cursor" value={snapshot.reviewCursor.newYork} sub={snapshot.reviewCursor.utc} />
       <Metric label="Machine candles" value={`${snapshot.machineCandles.length} candles`} sub={snapshot.futureCandleAccess ? "Future access detected" : "Future access: false"} />
        <Metric label="Review candles" value={`${snapshot.reviewCandles.length} candles`} sub={`${snapshot.coverage.find((item) => item.session === "primary")?.observedCandleCount ?? 0}/42 primary observed`} />
    </div>
    <div className="grid gap-px border-t border-border bg-border text-[10px] sm:grid-cols-3" data-testid="occurrence-provenance">
      <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Occurrence identity</div><div className="mono mt-1 break-all text-foreground">{snapshot.occurrenceId ?? `audit:${snapshot.machineEvidence.audit && typeof snapshot.machineEvidence.audit === "object" && "id" in snapshot.machineEvidence.audit ? String(snapshot.machineEvidence.audit.id) : "unavailable"}`}</div></div>
      <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Source fingerprint</div><div className="mono mt-1 break-all text-foreground">{snapshot.sourceFingerprint ?? "derived from visible source candles"}</div></div>
      <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Formula hash</div><div className="mono mt-1 break-all text-foreground">{snapshot.formulaHash}</div></div>
    </div>
  </div>;
}

function CausalTag() {
  return <span className="inline-flex items-center gap-1.5 border border-[hsl(var(--positive)/.3)] bg-[hsl(var(--positive)/.08)] px-2 py-1 text-[9px] font-bold uppercase tracking-[.1em] text-[hsl(var(--positive))]"><LockKeyhole size={11} />Causal boundary enforced</span>;
}

function CausalChart({ snapshot, source, expanded, lockedEntryCandle, teaching, onToggleExpanded, onLockCandle }: { snapshot: VisualValidationSnapshot; source: string; expanded: boolean; lockedEntryCandle: SessionCandle | null; teaching: NonNullable<VisualValidationReviewRequest["teaching"]> | null; onToggleExpanded: () => void; onLockCandle: (candle: SessionCandle | null) => void }) {
  const [sessionView, setSessionView] = useState<SessionView>(requestedSessionView);
  const [showPremarket, setShowPremarket] = useState(requestedPremarket);
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
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("levelstory.visualReviewWindow", sessionView);
  }, [sessionView]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof window === "undefined") return;
    const timer = window.setTimeout(() => frame.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    return () => window.clearTimeout(timer);
  }, [snapshot.snapshotId]);
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
    false,
  );
  const premarketCandles = showPremarket
    ? selectSessionCandles(
      snapshot.premarketCandles,
      snapshot.evaluationCursor.closeTime,
      snapshot.reviewCursor.closeTime,
      "primary",
      true,
    ).premarketCandles
    : [];
  const chartCandles = selection.regularCandles;
  const repetitive = hasRepetitiveFixtureData(chartCandles);
  const invalidIndices = invalidRawCandleIndices(chartCandles);
  const historical = source === "historical_databento" || source === "historical_databento_multicontract";
  const windowLabel = sessionView === "primary"
    ? "Primary trade window · 9:30 AM–2:00 PM ET"
    : "Full regular session · 9:30 AM–4:00 PM ET";
  const sourceLabel = `${windowLabel} · ${historical ? "Historical Databento" : "Simulated fixture data"}`;
  const primaryCoverage = snapshot.coverage.find((item) => item.session === "primary");
  const fullCoverage = snapshot.coverage.find((item) => item.session === "full_regular");
  return <div ref={frameRef} className={`chart-frame border-t border-border p-3 sm:p-5 ${isFullscreen ? "visual-review-chart-fullscreen" : ""}`} data-testid="visual-review-chart">
    <div className="mb-4 flex flex-col gap-2 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="eyebrow text-muted-foreground">Source / immutable candle bytes</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 border border-accent/45 bg-accent/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.1em]" data-testid="chart-data-source"><span className="h-1.5 w-1.5 rounded-full bg-accent" />{formatDataSource(source, snapshot.contractSymbol)}</span>
          <span className="mono text-[10px] text-muted-foreground" data-testid="chart-window-count">{selection.regularCandles.length} regular candles shown{showPremarket ? ` · ${premarketCandles.length} premarket` : ""} · raw OHLCV</span>
        </div>
        <div className="mt-2 text-xs font-semibold tracking-[-.01em]" data-testid="primary-trade-window-label">{sourceLabel}</div>
      </div>
       <div className="flex flex-col items-start gap-2 sm:items-end">
        <span className="mono text-[10px] text-muted-foreground">MES · {snapshot.contractSymbol}</span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="eyebrow">Chart window</span>
            <select className="field h-8 min-w-[190px] py-1 text-[10px]" value={sessionView} onChange={(event) => setSessionView(event.target.value as SessionView)} data-testid="select-session-view">
              <option value="primary">Primary window: 9:30 AM–2:00 PM</option>
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
      <CategoryAnchorBanner anchor={snapshot.categoryAnchor} />
      {showPremarket && <PremarketMiniChart candles={premarketCandles} snapshot={snapshot} />}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground" data-testid="compact-coverage-details">
        <span className="font-semibold text-foreground">Coverage</span>
        {primaryCoverage && <span className="mono">Primary {primaryCoverage.observedCandleCount}/{primaryCoverage.expectedCandleCount}</span>}
        {fullCoverage && <span className="mono">Full {fullCoverage.observedCandleCount}/{fullCoverage.expectedCandleCount}</span>}
        <span>{primaryCoverage?.complete && fullCoverage?.complete ? "complete; blank fixed slots remain inspectable" : "missing intervals preserved as blank fixed slots"}</span>
      </div>
        <CausalSvg snapshot={snapshot} candles={chartCandles} regularCandles={selection.regularCandles} premarketCandles={[]} sessionView={sessionView} focusOpenTime={snapshot.categoryAnchor.openTime} lockedEntryCandle={lockedEntryCandle} teaching={teaching} onReturnPrimary={() => setSessionView("primary")} onLockCandle={onLockCandle} />
     <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-[10px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[hsl(var(--positive))]" />up candle</span>
      <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[hsl(var(--negative))]" />down candle</span>
       <span className="inline-flex items-center gap-1.5"><i className="h-2 w-4 border-t-2 border-orange-500" />ORB / NTZ boundary</span>
       <span className="inline-flex items-center gap-1.5"><i className="h-2 w-4 border-t-2 border-[hsl(var(--positive))]" />premarket high / low</span>
       <span className="inline-flex items-center gap-1.5"><i className="h-2 w-4 border-t-2 border-green-500" />EMA 200</span>
       <span className="inline-flex items-center gap-1.5"><i className="h-2 w-4 border-t-2 border-red-600" />VWAP</span>
       <span className="inline-flex items-center gap-1.5"><i className="h-2 w-4 border-t-2 border-slate-900" />support / resistance</span>
       <span className="inline-flex items-center gap-1.5" data-testid="marker-legend-anchor"><i className="h-2 w-2 rounded-full bg-[hsl(var(--positive))] ring-2 ring-[hsl(var(--positive)/.2)]" />FOUND · category anchor</span>
       <span className="inline-flex items-center gap-1.5" data-testid="marker-legend-patience"><i className="h-2 w-2 rounded-full bg-[hsl(var(--positive))]" />patience comparison</span>
       <span className="inline-flex items-center gap-1.5" data-testid="marker-legend-entry"><i className="h-2 w-2 rounded-full bg-accent" />entry candle (E)</span>
       <span className="inline-flex items-center gap-1.5" data-testid="marker-legend-invalidation"><i className="h-px w-4 bg-[hsl(var(--negative))]" />invalidation / stop</span>
       <span className="inline-flex items-center gap-1.5"><i className="h-3 w-3 border border-foreground/20 bg-foreground/5" />shaded candles · human-only outcome context</span>
       <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 border border-foreground bg-card" />numbered markers · exact event occurrence</span>
       <span className="mono ml-auto">5m · NY / UTC · review-bounded</span>
    </div>
  </div>;
}

function CategoryAnchorBanner({ anchor }: { anchor: VisualValidationCategoryAnchor }) {
  const patience = anchor.relatedCandles.find((candle) => candle.role === "patience");
  const entry = anchor.relatedCandles.find((candle) => candle.role === "entry");
  return <div className="mb-4 border border-[hsl(var(--positive)/.4)] bg-[hsl(var(--positive)/.08)] p-3 sm:p-4" data-testid="category-anchor-banner">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="eyebrow flex items-center gap-1.5 text-[hsl(var(--positive))]"><Check size={12} />Category found</div>
        <div className="mt-1 text-sm font-bold">{anchor.label}</div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{anchor.detail || "The selected category resolves to an observed MES candle."}</p>
      </div>
      <div className="shrink-0 text-right">
        <div className="mono text-[11px] font-bold">{formatInterval(anchor.openTime, anchor.closeTime)}</div>
        <div className="mono mt-1 text-[10px] text-muted-foreground">{anchor.price == null ? "Price unavailable" : `${formatPriceAxisValue(anchor.price)} · ${anchor.direction ?? "direction unavailable"}`}</div>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[hsl(var(--positive)/.2)] pt-3 text-[10px]">
      {patience && <span className="inline-flex items-center gap-1.5 border border-[hsl(var(--positive)/.3)] bg-card/60 px-2 py-1"><i className="h-2 w-2 rounded-full bg-[hsl(var(--positive))]" />Patience · {formatInterval(patience.openTime, patience.closeTime)} · {patience.price == null ? "—" : formatPriceAxisValue(patience.price)}</span>}
      {entry && <span className="inline-flex items-center gap-1.5 border border-accent/35 bg-card/60 px-2 py-1"><i className="h-2 w-2 rounded-full bg-accent" />Entry (E) · {formatInterval(entry.openTime, entry.closeTime)} · {entry.price == null ? "—" : formatPriceAxisValue(entry.price)}</span>}
      <details className="ml-auto">
        <summary className="cursor-pointer text-[10px] font-bold text-muted-foreground">Technical details</summary>
        <span className="mono mt-2 block text-muted-foreground">audit {anchor.auditId}{anchor.tradeId ? ` · trade ${anchor.tradeId}` : ""} · {anchor.contractSymbol}</span>
      </details>
    </div>
  </div>;
}

function formatExactVolume(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

function CandleInspector({
  inspection,
  selectedSlot,
  activeCandle,
  onLockCandle,
}: {
  inspection: CandleInspection | null;
  selectedSlot: number | null;
  activeCandle: SessionCandle | null;
  onLockCandle: (candle: SessionCandle | null) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const selectedLabel = selectedSlot == null ? "Select a five-minute candle" : `Fixed slot ${String(selectedSlot + 1).padStart(2, "0")}`;
  return <section className={`candle-inspector ${collapsed ? "is-collapsed" : ""}`} aria-label="Selected candle inspector" data-testid="candle-inspector">
    <div className="flex items-center justify-between gap-3">
      <div>
        <span className="eyebrow block text-muted-foreground">Candle inspector · hover or arrow-key selection</span>
        <span className="mt-1 block text-xs font-bold">{inspection ? inspection.interval : selectedLabel}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {inspection && <span className={`text-[9px] font-bold uppercase ${inspection.machineVisible ? "text-[hsl(var(--positive))]" : "text-muted-foreground"}`}>{inspection.machineVisible ? "Machine visible" : "Human-only context"}</span>}
        {activeCandle && <button type="button" className="chart-control" disabled={!activeCandle.isComplete || !activeCandle.machineVisible} onClick={() => onLockCandle(activeCandle)} data-testid="button-lock-entry-candle"><LockKeyhole size={12} />{!activeCandle.machineVisible ? "Human-only candle" : activeCandle.isComplete ? "Lock as entry (E)" : "Candle incomplete"}</button>}
        <button type="button" className="chart-control" onClick={() => setCollapsed((current) => !current)} aria-expanded={!collapsed} aria-controls="candle-inspector-content" data-testid="toggle-candle-inspector">{collapsed ? "Expand" : "Collapse"}</button>
      </div>
    </div>
    {!collapsed && <div id="candle-inspector-content" className="inspector-content">
      {inspection ? <div className="inspector-ohlcv mt-3" data-testid="candle-inspector-ohlcv">
        {([["Open", inspection.open], ["High", inspection.high], ["Low", inspection.low], ["Close", inspection.close], ["Volume", formatExactVolume(inspection.volume)]] as const).map(([label, value]) => <div key={label} className="inspector-metric"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-1 text-[11px] font-bold">{typeof value === "number" ? value.toFixed(2) : value}</div></div>)}
      </div> : <p className="mt-3 border border-accent/25 bg-accent/5 px-3 py-2 text-[10px] leading-4 text-muted-foreground">No historical candle available for this fixed timestamp slot. The gap is preserved; no neighboring candle was substituted.</p>}
      <div className="inspector-meta mt-2 border-t border-border pt-2 text-[9px] text-muted-foreground" aria-hidden="true" />
    </div>}
  </section>;
}

function PremarketMiniChart({ candles, snapshot }: { candles: SessionCandle[]; snapshot: VisualValidationSnapshot }) {
  if (!candles.length) {
    return <details open className="mb-4 border border-border bg-muted/20" data-testid="premarket-mini-chart">
      <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">Premarket context · unavailable in this snapshot</summary>
    </details>;
  }
  const width = CHART_WIDTH;
  const height = 210;
  const left = CHART_LEFT;
  const right = CHART_RIGHT;
  const top = 24;
  const bottom = 166;
  const plotWidth = width - left - right;
  const step = plotWidth / PREMARKET_SLOT_COUNT;
  const domain = getCandleDomain(candles);
  const y = (price: number) => priceToY(price, domain, top, bottom);
  const volumeMax = Math.max(...candles.map((candle) => candle.volume), 1);
  const machineCount = candles.filter((candle) => candle.machineVisible).length;
  const boundaryX = left + Math.min(machineCount, PREMARKET_SLOT_COUNT) * step;
  return <details open className="mb-4 border border-border bg-muted/20" data-testid="premarket-mini-chart">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">
      <span>Premarket context · 4:00 AM–9:30 AM ET</span>
      <span className="mono font-normal">{candles.length} observed · separate scale</span>
    </summary>
    <div className="overflow-x-auto p-2 sm:p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[190px] min-w-[900px] w-full" role="img" aria-label="Separate premarket five-minute mini-chart.">
        <title>Premarket context, rendered separately from the primary regular-session chart.</title>
        {[domain.min, (domain.min + domain.max) / 2, domain.max].map((price) => <g key={`premarket-grid-${price}`}><line x1={left} x2={width - right} y1={y(price)} y2={y(price)} stroke="hsl(var(--border))" strokeDasharray="2 6" /><text x={width - 5} y={y(price) + 3} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">{formatPriceAxisValue(price)}</text></g>)}
        {boundaryX < width - right && <rect x={boundaryX} y={top} width={width - right - boundaryX} height={bottom - top + 25} fill="hsl(var(--foreground) / .07)" data-testid="premarket-human-only-region" />}
        {candles.map((candle, index) => {
          const geometry = getCandleGeometry(candle, index, step, domain, left);
          const color = candle.close >= candle.open ? "hsl(var(--positive))" : "hsl(var(--negative))";
          const volumeHeight = Math.max((candle.volume / volumeMax) * 25, 1.5);
          return <g key={candle.openTime} opacity={candle.machineVisible ? 1 : ".68"} data-testid={`premarket-candle-${index}`}>
            <line x1={geometry.x} x2={geometry.x} y1={geometry.highY} y2={geometry.lowY} stroke={color} strokeWidth="1.2" />
            <rect x={geometry.x - Math.max(step * .3, 2)} y={geometry.bodyTop} width={Math.max(step * .6, 3)} height={geometry.bodyHeight} fill={color} rx="1" />
            <rect x={geometry.x - Math.max(step * .25, 2)} y={bottom + 25 - volumeHeight} width={Math.max(step * .5, 3)} height={volumeHeight} fill={color} opacity=".4" />
          </g>;
        })}
        <line x1={left} x2={width - right} y1={bottom + 25} y2={bottom + 25} stroke="hsl(var(--border))" />
        <line x1={boundaryX} x2={boundaryX} y1={top} y2={bottom + 25} stroke="hsl(var(--foreground))" strokeDasharray="4 4" />
        <text x={left} y={height - 18} fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">4:00 AM</text>
        <text x={left + PREMARKET_SLOT_COUNT / 2 * step} y={height - 18} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">6:45 AM</text>
        <text x={left + PREMARKET_SLOT_COUNT * step} y={height - 18} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">9:30 AM ET</text>
        <text x={left} y={top - 8} fill="hsl(var(--muted-foreground))" fontSize="8.5" fontWeight="700" fontFamily="DM Mono">PREMARKET · RAW OHLCV</text>
      </svg>
      <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <span>Separate scale prevents premarket volatility from changing primary candle width or price domain.</span>
        <span className="mono shrink-0">{snapshot.contractSymbol}</span>
      </div>
    </div>
  </details>;
}

 function CausalSvg({
  snapshot,
  candles,
  regularCandles,
  premarketCandles,
  sessionView,
  focusOpenTime,
  lockedEntryCandle,
  teaching,
  onReturnPrimary,
  onLockCandle,
}: {
  snapshot: VisualValidationSnapshot;
  candles: SessionCandle[];
  regularCandles: SessionCandle[];
  premarketCandles: SessionCandle[];
  sessionView: SessionView;
  focusOpenTime: string;
  lockedEntryCandle: SessionCandle | null;
  teaching: NonNullable<VisualValidationReviewRequest["teaching"]> | null;
  onReturnPrimary: () => void;
  onLockCandle: (candle: SessionCandle | null) => void;
}) {
  const [hoveredSlot, setHoveredSlot] = useState<number | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [showAllAuditEvents, setShowAllAuditEvents] = useState(false);
  const [showRiskLevels, setShowRiskLevels] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const interactionRef = useRef<SVGSVGElement>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  useEffect(() => {
    const focusedIndex = findCandleIndexAtTimestamp(candles, focusOpenTime);
    setSelectedSlot(focusedIndex >= 0 ? getCandleSlotIndex(candles[focusedIndex]!, sessionView) : null);
    setHoveredSlot(null);
    setZoom(1);
    setPan(0);
    const timer = window.setTimeout(() => interactionRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [candles.length, focusOpenTime, sessionView, premarketCandles.length]);
  useEffect(() => () => {
    if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current);
  }, []);
  if (!candles.length) return <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">No causal candles were returned for this snapshot.</div>;
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const left = CHART_LEFT;
  const right = CHART_RIGHT;
  const top = CHART_TOP;
  const plotBottom = CHART_PLOT_BOTTOM;
  const volumeTop = CHART_VOLUME_TOP;
  const plotWidth = width - left - right;
  const slotCount = getSessionDomainSlotCount(sessionView);
  const step = plotWidth / Math.max(slotCount, 1);
  const orbCandles = regularCandles.slice(0, 3);
  const orbCompleteAtEvaluation = isOpeningRangeCompleteAtEvaluation(regularCandles, snapshot.evaluationCursor.closeTime);
   const annotations = mergeOrbNtzAnnotations(snapshot.annotations.filter((annotation) => annotation.available
     && (!["orb-high", "orb-low", "ntz-high", "ntz-low"].includes(annotation.id) || orbCompleteAtEvaluation)));
  const chartEvents = selectChartEvents(snapshot, candles, sessionView, showAllAuditEvents);
  const domain = getCandleDomain(candles);
  const priceAxis = getPriceAxis(domain);
  const y = (price: number) => priceToY(price, domain, top, plotBottom);
  const x = (index: number) => left + index * step + step / 2;
  const plotRight = width - right;
  const indicatorByOpenTime = new Map(snapshot.indicatorSeries.map((point) => [point.openTime, point]));
  const indicatorPath = (key: "vwap" | "ema200", visibility: "machine" | "human_only") => {
    const points = candles.flatMap((candle) => {
      const point = indicatorByOpenTime.get(candle.openTime);
      const value = point?.[key];
      if (!point || value == null || point.visibility !== visibility) return [];
      return [{ x: x(getCandleSlotIndex(candle, sessionView)), y: y(value) }];
    });
    return points.length > 1 ? points.map((point, index) => {
      const previous = points[index - 1];
      const slotGap = previous ? Math.abs(point.x - previous.x) / step : 0;
      return `${index === 0 || slotGap > 1.01 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }).join(" ") : "";
  };
  const visibleAtEvaluation = candles.filter((candle) => candle.machineVisible).length;
  const machineSlots = candles.filter((candle) => candle.machineVisible).map((candle) => getCandleSlotIndex(candle, sessionView));
  const boundarySlot = machineSlots.length ? Math.max(...machineSlots) + 1 : 0;
  const boundaryX = left + Math.min(boundarySlot, slotCount) * step;
  const volumeMax = Math.max(...candles.map((candle) => candle.volume), 1);
  const volumeAxis = getVolumeAxisTicks(volumeMax);
  const timeAxis = getFixedTimeAxisTicks(sessionView);
  const regularStartIndex = regularCandles.length ? getCandleSlotIndex(regularCandles[0], sessionView) : -1;
  const openingRangeX = regularStartIndex >= 0 ? left + regularStartIndex * step : null;
  const openingRangeWidth = orbCandles.length === 3 ? 3 * step : 0;
   const allLevels = annotations.filter((annotation) => annotation.kind !== "candle" && annotation.price !== null && !annotation.id.startsWith("fib-"));
  const criticalLevels = allLevels.filter((annotation) =>
    annotation.id.startsWith("critical-")
    && annotation.label !== "Critical · Premarket high",
  );
  const entryReference = allLevels.find((annotation) => annotation.id === "entry-buffer")?.price ?? null;
  const relevantCritical = [...criticalLevels]
    .sort((first, second) => entryReference == null
      ? 0
      : Math.abs((first.price ?? entryReference) - entryReference) - Math.abs((second.price ?? entryReference) - entryReference))
    .slice(0, 1);
   const riskLevelIds = new Set(["entry-buffer", "strategy-stop", "catastrophe-stop"]);
   const primaryLevels = allLevels
     .filter((annotation) => isPrimaryLevel(annotation) && !annotation.id.startsWith("critical-"))
     .concat(relevantCritical)
     .filter((annotation) => showRiskLevels || !riskLevelIds.has(annotation.id));
  const additionalLevels = allLevels.filter((annotation) => !primaryLevels.some((primary) => primary.id === annotation.id));
  const inRangeLevels = primaryLevels.filter((annotation) => annotation.price != null && annotation.price >= domain.min && annotation.price <= domain.max);
  const labelPositions = stackLabelPositions(inRangeLevels.map((annotation) => ({ id: annotation.id, y: y(annotation.price as number) })), top + 9, plotBottom - 5, 16);
  const labelYById = new Map(labelPositions.map((position) => [position.id, position.y]));
  const edgeIndicators = getEdgeIndicators(primaryLevels, domain);
  const edgeCounts: Record<"top" | "bottom", number> = { top: 0, bottom: 0 };
  const activeSlot = hoveredSlot ?? selectedSlot;
  const activeCandle = activeSlot == null ? null : candles.find((candle) => getCandleSlotIndex(candle, sessionView) === activeSlot) ?? null;
  const activeDetails = activeCandle ? getCandleInspection(activeCandle) : null;
  const activeEvents = activeCandle
    ? chartEvents
      .filter((event) => [event.openTime, event.closeTime].includes(activeCandle.openTime) || [event.openTime, event.closeTime].includes(activeCandle.closeTime))
      .map((event) => `${event.label}${event.price == null ? "" : ` · ${formatPriceAxisValue(event.price)}`}`)
    : [];
  const selectedIndicators = activeCandle
    ? indicatorByOpenTime.get(activeCandle.openTime) ?? null
    : null;
  const finalCandle = candles.at(-1);
  const finalIndicators = finalCandle ? indicatorByOpenTime.get(finalCandle.openTime) ?? null : null;
  const resolvePointer = (clientX: number, clientY: number) => resolveFixedSlotFromClientPoint(
    clientX,
    clientY,
    interactionRef.current?.getBoundingClientRect() ?? new DOMRect(),
    {
      viewBoxX: pan,
      viewBoxWidth: width / zoom,
      viewBoxHeight: height,
      plotLeft: left,
      plotRight,
      plotTop: top,
      plotBottom: volumeTop + CHART_VOLUME_HEIGHT,
      slotCount,
    },
  );
  const updateHoveredSlot = (clientX: number, clientY: number) => {
    const slot = resolvePointer(clientX, clientY);
    if (slot !== null) setHoveredSlot(slot);
  };
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    pendingPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (pointerFrameRef.current !== null) return;
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const pointer = pendingPointerRef.current;
      if (pointer) updateHoveredSlot(pointer.clientX, pointer.clientY);
    });
  };
  const selectPointerSlot = (event: ReactPointerEvent<SVGSVGElement>) => {
    const slot = resolvePointer(event.clientX, event.clientY);
    if (slot !== null) {
      setSelectedSlot(slot);
      setHoveredSlot(slot);
      const selectedCandle = candles.find((candle) => getCandleSlotIndex(candle, sessionView) === slot);
      if (selectedCandle?.isComplete && selectedCandle.machineVisible) onLockCandle(selectedCandle);
    }
  };
  const setIndexFromKeyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const current = selectedSlot ?? Math.max(0, boundarySlot - 1);
    const nextSlot = event.key === "ArrowLeft"
      ? Math.max(0, current - 1)
      : event.key === "ArrowRight"
        ? Math.min(slotCount - 1, current + 1)
        : event.key === "Home"
          ? 0
          : slotCount - 1;
    setSelectedSlot(nextSlot);
    setHoveredSlot(null);
  };
  const focusChartEvent = (event: typeof chartEvents[number]) => {
    if (event.markerSlot !== null) setSelectedSlot(event.markerSlot);
    setActiveEventId(event.id);
  };
  const markerIndex = (event: typeof chartEvents[number]) => findCandleIndexAtTimestamp(candles, event.openTime ?? event.closeTime);
  const markerY = (event: typeof chartEvents[number]) => {
    const index = markerIndex(event);
    const rawY = index >= 0 && event.price == null
      ? y(candles[index]!.close)
      : event.price == null
        ? top + 12
        : y(event.price);
    return Math.max(top + 5, Math.min(plotBottom - 5, rawY));
  };
  return <div className="relative w-full overflow-x-auto">
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
          <label className="ml-1 inline-flex min-h-8 items-center gap-2 border border-border bg-card px-2.5 text-[9px] font-bold uppercase tracking-[.04em]">
            <input type="checkbox" className="accent-[hsl(var(--accent))]" checked={showAllAuditEvents} onChange={(event) => { setShowAllAuditEvents(event.target.checked); setActiveEventId(null); }} data-testid="toggle-show-all-audit-events" />
            Show all audit events
          </label>
           <label className="inline-flex min-h-8 items-center gap-2 border border-border bg-card px-2.5 text-[9px] font-bold uppercase tracking-[.04em]">
             <input type="checkbox" className="accent-[hsl(var(--accent))]" checked={showRiskLevels} onChange={(event) => setShowRiskLevels(event.target.checked)} data-testid="toggle-show-risk-levels" />
             Show planned risk levels
           </label>
       </div>
     </div>
        <section className="event-strip" aria-label="Causal event strip" data-testid="event-strip">
          <div className="event-strip-heading">
            <div>
              <div className="eyebrow text-muted-foreground">Causal events</div>
              <div className="mt-1 text-[11px] font-bold">{chartEvents.length ? "Select a numbered marker or event" : "No category events in this window"}</div>
            </div>
            <span className="mono shrink-0 text-[9px] text-muted-foreground">{chartEvents.length} {showAllAuditEvents ? "audit" : "category"} events</span>
          </div>
          {chartEvents.length > 0 && <div className="event-strip-scroll" role="list">
            {chartEvents.map((event) => {
              const index = markerIndex(event);
              const selected = activeEventId === event.id || selectedSlot === event.markerSlot;
              const time = event.openTime && event.closeTime
                ? formatInterval(event.openTime, event.closeTime)
                : event.openTime ? formatCandleTime(event.openTime, "America/New_York") : "Time unavailable";
              return <button
                key={`event-strip-${event.id}`}
                type="button"
                role="listitem"
                className={`event-strip-item ${selected ? "is-selected" : ""} ${event.visibility === "human_only" ? "is-human" : ""}`}
                onMouseEnter={() => setActiveEventId(event.id)}
                onFocus={() => focusChartEvent(event)}
                onClick={() => focusChartEvent(event)}
                aria-pressed={selected}
                aria-label={`Event ${event.number}: ${event.label}. ${event.detail}. ${time}. ${event.price == null ? "Price unavailable" : formatPriceAxisValue(event.price)}. ${event.visibility}.${index < 0 ? " No exact marker in this window." : ""}`}
                data-testid={`event-strip-item-${event.id}`}
              >
                <span className="event-index-number">{event.number}</span>
                <span className="event-strip-copy">
                  <strong>{event.label}</strong>
                  <span>{time} · {event.price == null ? "—" : formatPriceAxisValue(event.price)}</span>
                </span>
              </button>;
            })}
          </div>}
        </section>
        <CandleInspector inspection={activeDetails} selectedSlot={activeSlot} activeCandle={activeCandle} onLockCandle={onLockCandle} />
        <CandleInspector inspection={activeDetails} selectedSlot={activeSlot} activeCandle={activeCandle} onLockCandle={onLockCandle} />
       <div className="chart-plot-shell mt-3">
         <svg ref={interactionRef} viewBox={`${pan} 0 ${width / zoom} ${height}`} className="visual-review-svg h-[700px] min-w-[900px] w-full" preserveAspectRatio="xMidYMid meet" role="application" tabIndex={0} aria-label={`Causal annotated five-minute OHLCV chart for ${snapshot.categoryLabel}. ${sessionView === "primary" ? "Primary trade window from 9:30 AM to 1:00 PM ET." : "Full regular session from 9:30 AM to 4:00 PM ET."} Hover across the plot and volume column or use the arrow keys to inspect an exact fixed five-minute slot. The right price gutter is not interactive.`} onPointerMove={handlePointerMove} onPointerDown={selectPointerSlot} onKeyDown={setIndexFromKeyboard}>
       <title>Causal annotated chart. The boundary notch identifies the last machine-visible candle; shaded candles after it are human-only context.</title>
         <rect x={left} y={top} width={plotWidth} height={volumeTop + CHART_VOLUME_HEIGHT - top} fill="transparent" pointerEvents="none" data-testid="chart-interaction-layer" />
         {activeSlot !== null && <rect x={left + activeSlot * step} y={top} width={step} height={volumeTop + CHART_VOLUME_HEIGHT - top} fill="hsl(var(--accent) / .08)" stroke="hsl(var(--accent) / .55)" strokeDasharray="3 3" pointerEvents="none" data-testid="selected-slot-column" />}
        {chartEvents.map((event) => {
          const index = markerIndex(event);
          if (index < 0) return null;
          const slot = event.markerSlot ?? getCandleSlotIndex(candles[index]!, sessionView);
          const eventX = left + slot * step + step / 2;
          const eventY = markerY(event);
          const color = event.visibility === "human_only"
            ? "hsl(var(--muted-foreground))"
            : event.kind === "found" ? "hsl(var(--positive))"
              : event.kind === "invalidation" || event.kind === "stop" || event.kind === "exit" ? "hsl(var(--negative))"
                : event.kind === "entry" ? "hsl(var(--accent))"
                  : "hsl(var(--foreground))";
           const active = activeEventId === event.id || selectedSlot === event.markerSlot;
           const previewEvent = () => setActiveEventId(event.id);
           const eventFocus = () => focusChartEvent(event);
           return <g key={`marker-${event.id}`} pointerEvents="none" data-testid={`event-marker-${event.id}`} aria-label={`Event ${event.number}: ${event.label}. ${event.detail}. ${event.visibility}.`}>
            <title>{`#${event.number} ${event.label} · ${event.detail} · ${event.visibility}${event.openTime ? ` · ${formatCandleTime(event.openTime, "America/New_York")} NY` : ""}${event.price == null ? "" : ` · ${formatPriceAxisValue(event.price)}`}`}</title>
            <circle cx={eventX} cy={eventY} r={active ? "6" : "4.5"} fill={event.visibility === "human_only" ? "hsl(var(--muted))" : "hsl(var(--card))"} stroke={color} strokeWidth={active ? "2" : "1.3"} />
            <text x={eventX} y={eventY + 3} textAnchor="middle" fill={color} fontSize="7.5" fontWeight="700" fontFamily="DM Mono">{event.number}</text>
          </g>;
        })}
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
      {openingRangeX !== null && openingRangeWidth > 0 && <g data-testid="opening-range-region">
        <rect x={openingRangeX} y={top} width={openingRangeWidth} height={volumeTop + CHART_VOLUME_HEIGHT - top} fill="hsl(var(--accent) / .08)" stroke="hsl(var(--accent) / .55)" strokeDasharray="4 3" />
        <path d={`M ${openingRangeX} ${top + 25} v -8 h ${openingRangeWidth} v 8`} fill="none" stroke="hsl(var(--accent))" strokeWidth="1.2" />
      </g>}
       <rect x={Math.max(boundaryX, left)} y={top} width={Math.max(width - right - boundaryX, 0)} height={volumeTop + CHART_VOLUME_HEIGHT - top} fill="hsl(var(--foreground) / .055)" data-testid="human-only-region" />
        <path d={`M ${Math.max(boundaryX - 6, left)} ${top} L ${boundaryX} ${top - 8} L ${Math.min(boundaryX + 6, plotRight)} ${top} Z`} fill="hsl(var(--foreground))" data-testid="causal-boundary-notch" />
        {indicatorPath("vwap", "machine") && <path pointerEvents="none" d={indicatorPath("vwap", "machine")} fill="none" stroke="hsl(5 58% 46%)" strokeWidth="2" data-testid="indicator-curve-vwap" />}
        {indicatorPath("vwap", "human_only") && <path pointerEvents="none" d={indicatorPath("vwap", "human_only")} fill="none" stroke="hsl(5 58% 46%)" strokeWidth="2" strokeDasharray="7 4" opacity=".55" data-testid="indicator-curve-vwap-human-only" />}
        {indicatorPath("ema200", "machine") && <path pointerEvents="none" d={indicatorPath("ema200", "machine")} fill="none" stroke="hsl(145 45% 42%)" strokeWidth="2" data-testid="indicator-curve-ema200" />}
        {indicatorPath("ema200", "human_only") && <path pointerEvents="none" d={indicatorPath("ema200", "human_only")} fill="none" stroke="hsl(145 45% 42%)" strokeWidth="2" strokeDasharray="7 4" opacity=".55" data-testid="indicator-curve-ema200-human-only" />}
       {snapshot.tradeEvents.length === 0 && <g data-testid="no-entry-marker"><rect x={left + 8} y={top + 30} width="132" height="24" rx="2" fill="hsl(var(--negative) / .12)" stroke="hsl(var(--negative) / .55)" /><text x={left + 74} y={top + 46} textAnchor="middle" fill="hsl(var(--negative))" fontSize="10" fontWeight="700" fontFamily="DM Mono">NO ENTRY</text></g>}
      {primaryLevels.map((annotation) => {
        if (annotation.price == null || annotation.price < domain.min || annotation.price > domain.max) return null;
        const orb = annotation.id === "orb-high" || annotation.id === "orb-low";
        const critical = annotation.id.startsWith("critical-");
        const stop = annotation.id === "strategy-stop" || annotation.id === "catastrophe-stop";
        const target = annotation.id === "target";
         const stroke = levelStroke(annotation);
          const labelY = labelYById.get(annotation.id) ?? y(annotation.price);
          const axisLabelX = plotRight + 7;
          const labelWidth = width - axisLabelX - 7;
          const displaced = isDisplacedLabel(labelY, y(annotation.price));
          const structural = ["previous-session-high", "previous-session-low", "two-sessions-high", "two-sessions-low"].includes(annotation.id);
          return <g key={annotation.id} pointerEvents="none" data-testid={`chart-level-${annotation.id}`}>
            <line pointerEvents="none" x1={left} x2={plotRight} y1={y(annotation.price)} y2={y(annotation.price)} stroke={stroke} strokeWidth={orb ? 2.8 : critical ? 2 : stop ? 1.8 : 1.4} strokeDasharray={target ? "7 5" : orb ? "10 4" : annotation.kind === "indicator" ? "2 5" : "none"} opacity={orb ? ".98" : ".8"} />
            <rect x={axisLabelX} y={labelY - 10} width={labelWidth} height="18" rx="2" fill="hsl(var(--card) / .94)" stroke={stroke} strokeOpacity=".32" />
            <text x={axisLabelX + 4} y={labelY + 3} fill={stroke} fontSize="8.5" fontWeight={orb || critical || structural ? "700" : "500"} fontFamily="DM Mono">{structural ? `${annotation.label} ${formatPriceAxisValue(annotation.price)}` : annotation.label}</text>
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
       const slotIndex = getCandleSlotIndex(candle, sessionView);
         const geometry = getCandleGeometry(candle, slotIndex, step, domain, left);
         const volumeHeight = Math.max((candle.volume / volumeMax) * CHART_VOLUME_HEIGHT, 2);
          const lockedAsEntry = lockedEntryCandle?.openTime === candle.openTime && lockedEntryCandle.closeTime === candle.closeTime;
          const lockedAsLevel = teaching?.levelCandleOpenTime === candle.openTime && teaching.levelCandleCloseTime === candle.closeTime;
          const lockedAsPatience = teaching?.patienceCandleOpenTime === candle.openTime && teaching.patienceCandleCloseTime === candle.closeTime;
          const entryMarkerY = Math.max(top + 12, geometry.highY - 15);
          const levelMarkerY = Math.max(top + 12, geometry.lowY + 15);
          const patienceMarkerY = Math.max(top + 12, geometry.lowY + (lockedAsLevel ? 31 : 15));
          return <g key={`${candle.openTime}-${index}`} data-testid={`chart-candle-${index}`} opacity={candle.machineVisible ? 1 : ".72"}>
            <title>{`${formatCandleTime(candle.openTime, "America/New_York")} NY · ${formatCandleTime(candle.openTime, "UTC")} UTC · O ${candle.open.toFixed(2)} H ${candle.high.toFixed(2)} L ${candle.low.toFixed(2)} C ${candle.close.toFixed(2)} · volume ${candle.volume}`}</title>
            <line x1={geometry.x} x2={geometry.x} y1={geometry.highY} y2={geometry.lowY} stroke={color} strokeWidth="1.6" />
            <rect x={geometry.x - Math.max(step * .3, 2)} y={geometry.bodyTop} width={Math.max(step * .6, 4)} height={geometry.bodyHeight} fill={color} rx="1" />
            <rect x={geometry.x - Math.max(step * .25, 2)} y={volumeTop + CHART_VOLUME_HEIGHT - volumeHeight} width={Math.max(step * .5, 3)} height={volumeHeight} fill={color} opacity=".43" />
            {lockedAsLevel && <g pointerEvents="none" data-testid="locked-level-marker" aria-label="Selected level interaction candle L">
              <circle cx={geometry.x} cy={levelMarkerY} r="8" fill="hsl(204 72% 48%)" stroke="hsl(var(--card))" strokeWidth="2" />
              <text x={geometry.x} y={levelMarkerY + 3} textAnchor="middle" fill="white" fontSize="9" fontWeight="800" fontFamily="DM Mono">L</text>
            </g>}
            {lockedAsPatience && <g pointerEvents="none" data-testid="locked-patience-marker" aria-label="Selected patience candle P">
              <circle cx={geometry.x} cy={patienceMarkerY} r="8" fill="hsl(var(--positive))" stroke="hsl(var(--card))" strokeWidth="2" />
              <text x={geometry.x} y={patienceMarkerY + 3} textAnchor="middle" fill="hsl(var(--positive-foreground))" fontSize="9" fontWeight="800" fontFamily="DM Mono">P</text>
            </g>}
            {lockedAsEntry && <g pointerEvents="none" data-testid="locked-entry-marker" aria-label="Selected entry candle E">
              <circle cx={geometry.x} cy={entryMarkerY} r="9" fill="hsl(var(--accent))" stroke="hsl(var(--card))" strokeWidth="2" />
              <text x={geometry.x} y={entryMarkerY + 3.5} textAnchor="middle" fill="hsl(var(--accent-foreground))" fontSize="10" fontWeight="800" fontFamily="DM Mono">E</text>
            </g>}
          </g>;
      })}
        <line x1={left} x2={width - right} y1={volumeTop + CHART_VOLUME_HEIGHT + 2} y2={volumeTop + CHART_VOLUME_HEIGHT + 2} stroke="hsl(var(--border))" />
       <line x1={left} x2={width - right} y1={volumeTop + CHART_VOLUME_HEIGHT + 2} y2={volumeTop + CHART_VOLUME_HEIGHT + 2} stroke="hsl(var(--border))" />
         {activeCandle && activeSlot !== null && <g pointerEvents="none" data-testid="chart-crosshair">
           <line x1={left} x2={plotRight} y1={y(activeCandle.close)} y2={y(activeCandle.close)} stroke="hsl(var(--foreground))" strokeDasharray="4 3" strokeWidth="1" opacity=".65" />
            <circle cx={x(activeSlot)} cy={y(activeCandle.close)} r="3.5" fill="hsl(var(--foreground))" />
        </g>}
        <line x1={left} x2={plotRight} y1={volumeTop + CHART_VOLUME_HEIGHT + 2} y2={volumeTop + CHART_VOLUME_HEIGHT + 2} stroke="hsl(var(--border))" />
         <text x={left} y={CHART_DATE_LABEL_Y} fill="hsl(var(--muted-foreground))" fontSize="10" fontWeight="700" fontFamily="DM Mono">{getDateLabel(candles)}</text>
        <text x={left} y={CHART_FOOTER_LABEL_Y} fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">PRICE · MES 0.25 TICK</text>
        <text x={plotRight} y={CHART_FOOTER_LABEL_Y} textAnchor="end" fill="hsl(145 45% 42%)" fontSize="9" fontFamily="DM Mono">EMA 200 · CAUSAL / SMA-SEEDED</text>
        <text x={plotRight} y={CHART_FOOTER_LABEL_Y + 13} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">VOLUME · COMPLETED 5M</text>
      </svg>
     <div className="sr-only" aria-live="polite" data-testid="selected-candle-announcement">
        {activeDetails ? `Active ${activeDetails.interval}. Open ${activeDetails.open.toFixed(2)}, high ${activeDetails.high.toFixed(2)}, low ${activeDetails.low.toFixed(2)}, close ${activeDetails.close.toFixed(2)}, volume ${formatExactVolume(activeDetails.volume)}. ${activeDetails.machineVisible ? "Machine visible." : "Human-only context."}` : activeSlot === null ? "No candle selected." : `Active fixed slot ${activeSlot + 1}; no historical candle is available.`}
     </div>
       </div>
      {activeSlot == null && <div className="mt-2 text-right text-[10px] text-muted-foreground">Hover the plot or volume column, click to keep a selection, or focus the chart and use ← / → to inspect fixed five-minute slots.</div>}
    {additionalLevels.length > 0 && <details className="mt-3 border-t border-border pt-3" data-testid="additional-levels">
      <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">Additional levels ({additionalLevels.length})</summary>
       <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{additionalLevels.map((annotation) => <div key={annotation.id} className="flex items-center justify-between gap-3 border border-border bg-muted/25 px-3 py-2 text-[10px]"><span className="truncate text-muted-foreground">{annotation.label}</span><span className="mono shrink-0">{annotation.price == null ? "—" : formatPriceAxisValue(annotation.price)}</span></div>)}</div>
    </details>}
   </div>;
}

function ChartEvidence({ snapshot }: { snapshot: VisualValidationSnapshot }) {
  const evidence = snapshot.machineEvidence;
  const market = typeof evidence.market === "object" && evidence.market !== null ? evidence.market as Record<string, unknown> : {};
  const audit = typeof evidence.audit === "object" && evidence.audit !== null ? evidence.audit as Record<string, unknown> : {};
  const breakout = typeof market.breakout === "object" && market.breakout ? (market.breakout as Record<string, unknown>).detail : null;
  const patience = typeof market.patience === "object" && market.patience ? (market.patience as Record<string, unknown>).detail : null;
  const thresholds = typeof audit.consolidationThresholds === "object" && audit.consolidationThresholds !== null
    ? audit.consolidationThresholds as Record<string, unknown>
    : null;
  const qualified = audit.rejectionCategory === "QUALIFIED" && evidence.trade;
  const behavior = [
    audit.trendEvidence,
    breakout,
    audit.pullbackEvidence,
    audit.volumeEvidence,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 2);
  const qualification = qualified
    ? "The setup passed the trade-qualification and risk gates."
    : typeof audit.rejectionSummary === "string" && audit.rejectionSummary
      ? audit.rejectionSummary
      : typeof audit.rejectionReason === "string" && audit.rejectionReason
        ? `Trade qualification stopped at ${audit.rejectionReason}.`
        : "The machine recorded market evidence without authorizing a modeled entry.";
   return <Panel data-testid="chart-evidence">
      <PanelTitle eyebrow="Plain-language summary / read-only" title="What the app found" right={<span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase text-muted-foreground"><Fingerprint size={13} />Machine-owned</span>} />
     <div className="grid gap-px border-t border-border bg-border sm:grid-cols-3" data-testid="trader-readable-reasoning">
        <div className="min-h-[104px] bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">What the app found</div><div className="mt-2 text-sm font-bold">{snapshot.categoryLabel}</div><div className="mt-1 text-[10px] text-muted-foreground">{safeValue(audit.setupType)}{audit.direction ? ` · ${safeValue(audit.direction)}` : ""}</div></div>
        <div className="min-h-[104px] bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">Why it matches this category</div><div className="mt-2 text-xs leading-5">{behavior.length ? behavior.join(" ") : "The category anchor and related candles match this review category."}</div></div>
        <div className="min-h-[104px] bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">What the app decided</div><div className="mt-2 text-xs leading-5">{qualification}</div></div>
     </div>
     <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2">
       <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Evaluation boundary</div><div className="mono mt-2 break-words text-[11px]">{safeValue(audit.evaluatedCandleOpenTime)} · {snapshot.evaluationCursor.visibleCandleCount} candles visible</div></div>
       <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Confirmation</div><div className="mt-2 text-[11px]">{safeValue(patience ?? audit.patienceState)}</div></div>
     </div>
      {thresholds && <div className="border-t border-border bg-card px-4 py-3 text-[10px]" data-testid="threshold-provenance"><div className="eyebrow text-muted-foreground">Governed threshold provenance</div><div className="mono mt-2 break-words">{safeValue(thresholds.version)} · min {safeValue(thresholds.minimumCandles)} candles · max {safeValue(thresholds.maximumRangeTicks)} ticks · expansion {safeValue(thresholds.maximumExpansionRatio)}×</div></div>}
     <details className="border-t border-border px-5 py-4 sm:px-6" data-testid="technical-details">
        <summary className="cursor-pointer text-xs font-semibold">Technical details</summary>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-sm bg-secondary/60 p-3 text-[10px] leading-4 text-muted-foreground">{JSON.stringify(evidence, null, 2)}</pre>
    </details>
      <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground sm:px-6">This is a machine explanation, not a human judgment. Compare it with the raw candles and use the review panel to record your call.</div>
  </Panel>;
}

function ReviewPanel({
  snapshot,
  status,
  setStatus,
  note,
  setNote,
  dirty,
  pending,
  onSave,
  message,
  lockedEntryCandle,
  teaching,
  setTeaching,
  authenticated,
}: {
  snapshot: VisualValidationSnapshot;
  status: Exclude<VisualValidationReviewStatus, "unreviewed"> | null;
  setStatus: (status: Exclude<VisualValidationReviewStatus, "unreviewed">) => void;
  note: string;
  setNote: (note: string) => void;
  dirty: boolean;
  pending: boolean;
  onSave: (status: Exclude<VisualValidationReviewStatus, "unreviewed">, moveNext?: boolean) => void;
  message: string;
  lockedEntryCandle: SessionCandle | null;
  teaching: NonNullable<VisualValidationReviewRequest["teaching"]> | null;
  setTeaching: (teaching: NonNullable<VisualValidationReviewRequest["teaching"]> | null) => void;
  authenticated: boolean;
}) {
  const savedStatus = snapshot.review.status === "unreviewed" ? null : snapshot.review.status;
  const hasSavedReview = savedStatus !== null;
  const needsTeaching = status === "missed_trade" || status === "false_positive_trade" || status === "rule_needs_clarification";
  const patience = teaching ? snapshot.reviewCandles.find((candle) => candle.openTime === teaching.patienceCandleOpenTime && candle.closeTime === teaching.patienceCandleCloseTime) : null;
  const levelCandle = teaching ? snapshot.reviewCandles.find((candle) => candle.openTime === teaching.levelCandleOpenTime && candle.closeTime === teaching.levelCandleCloseTime) : null;
  const calculatedEntryPrice = teaching && patience
    ? (teaching.direction === "long" ? patience.high + teaching.entryBufferTicks * 0.25 : patience.low - teaching.entryBufferTicks * 0.25).toFixed(2)
    : "—";
  const selectedIndicator = levelCandle ? snapshot.indicatorSeries.find((point) => point.openTime === levelCandle.openTime && point.closeTime === levelCandle.closeTime) : undefined;
  const availableLevels = snapshot.annotations
    .filter((annotation) => annotation.available && annotation.kind !== "candle" && (annotation.price !== null || annotation.id === "vwap" || annotation.id === "ema-200"))
    .map((annotation) => {
      const dynamic = annotation.id === "vwap" || annotation.id === "ema-200";
      const price = dynamic ? annotation.id === "vwap" ? selectedIndicator?.vwap ?? null : selectedIndicator?.ema200 ?? null : annotation.price;
      return { ...annotation, price, rangeLow: dynamic ? null : annotation.rangeLow, rangeHigh: dynamic ? null : annotation.rangeHigh };
    })
    .filter((annotation): annotation is typeof annotation & { price: number } => annotation.price !== null);
  const levelToleranceTicks = teaching?.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS;
  const levelTolerancePointsValue = levelTolerancePoints(levelToleranceTicks);
  const dynamicEvidence = (levelId: "vwap" | "ema-200") => {
    const level = availableLevels.find((candidate) => candidate.id === levelId);
    return evaluateDynamicLevelInteraction(level?.price, levelCandle?.high, levelCandle?.low, levelToleranceTicks);
  };
  const containedLevels = availableLevels.filter((level) => {
    if (!levelCandle) return false;
    if (level.id === "vwap" || level.id === "ema-200") return dynamicEvidence(level.id).qualifies;
    return Math.max(0, (level.rangeLow ?? level.price as number) - levelCandle.high, levelCandle.low - (level.rangeHigh ?? level.price as number)) <= levelTolerancePointsValue;
  });
  const selectableLevelCandles = snapshot.reviewCandles.filter((candle) => {
    const candleIndex = snapshot.reviewCandles.indexOf(candle);
    const patienceIndex = patience ? snapshot.reviewCandles.indexOf(patience) : -1;
    return candle.isComplete && Date.parse(candle.closeTime) <= Date.parse(snapshot.evaluationCursor.closeTime) && (patienceIndex < 0 || candleIndex <= patienceIndex);
  });
  const updateTeaching = (patch: Partial<NonNullable<VisualValidationReviewRequest["teaching"]>>) => {
    if (teaching) setTeaching({ ...teaching, ...patch });
  };
  useEffect(() => {
    if (!teaching || !levelCandle) return;
    const refreshed = (teaching.qualifyingLevels ?? []).flatMap((item) => {
      const level = availableLevels.find((candidate) => candidate.id === item.levelId);
      if (!level || !containedLevels.includes(level)) return [];
      return [{
        ...item,
        valueAtInteraction: level.price,
        sourceTimestamp: level.id === "vwap" || level.id === "ema-200" ? selectedIndicator?.openTime ?? item.sourceTimestamp : item.sourceTimestamp,
        rangeLow: level.id === "vwap" || level.id === "ema-200" ? null : level.rangeLow ?? null,
        rangeHigh: level.id === "vwap" || level.id === "ema-200" ? null : level.rangeHigh ?? null,
      }];
    });
    const compatibility = deriveTeachingCompatibilityFields(refreshed);
    const nextTeaching = {
      ...teaching,
      qualifyingLevels: refreshed,
      ...compatibility,
    };
    if (JSON.stringify(nextTeaching) !== JSON.stringify(teaching)) {
      setTeaching(nextTeaching);
    }
  }, [snapshot.snapshotId, levelCandle?.openTime, levelCandle?.closeTime, levelToleranceTicks, selectedIndicator?.openTime, selectedIndicator?.closeTime, selectedIndicator?.vwap, selectedIndicator?.ema200, JSON.stringify(teaching?.qualifyingLevels)]);
  return <Panel accent>
     <PanelTitle eyebrow="Human judgment / explicit submission" title="Does the story hold?" right={<ClipboardCheck size={17} className="text-accent" />} />
    <div className="border-t border-border bg-accent/8 px-5 py-4 text-xs leading-5 sm:px-6"><strong>Separate the two voices.</strong><span className="ml-1 text-muted-foreground">The machine has labeled this sample. Your task is to judge the raw causal candle story.</span></div>
    <div className="space-y-4 border-t border-border p-5 sm:p-6">
      {!authenticated && <div className="border border-accent/35 bg-accent/10 px-3 py-3 text-xs leading-5"><strong>Log in to save reviews.</strong><span className="ml-1 text-muted-foreground">Review evidence is readable without an account, but saving requires an authenticated reviewer.</span><a className="ml-2 font-bold text-accent underline underline-offset-2" href={`/api/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Log in</a></div>}
      <div className="grid gap-2">
         {REVIEW_OPTIONS.map((option) => <button type="button" key={option.value} onClick={() => setStatus(option.value)} disabled={pending || !authenticated} className={`flex items-start gap-3 border p-3 text-left transition hover:bg-muted/50 disabled:opacity-55 ${status === option.value ? "border-accent bg-accent/10" : "border-border"}`} aria-pressed={status === option.value} data-testid={`button-review-${option.value}`}>
           <span className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border ${status === option.value ? "border-accent bg-accent text-accent-foreground" : "border-muted-foreground/50"}`}>{status === option.value && <Check size={11} />}</span><span><span className="block text-xs font-bold">{option.label}</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{option.detail}</span></span>
        </button>)}
      </div>
       {needsTeaching && <div className="space-y-3 border border-accent/35 bg-accent/5 p-4" data-testid="teaching-example-form">
         <div className="flex items-start gap-2"><LockKeyhole size={14} className="mt-0.5 shrink-0 text-accent" /><div><div className="text-xs font-bold">Teach the formula from a locked candle pair</div><p className="mt-1 text-[10px] leading-4 text-muted-foreground">Select a completed E candle on the chart, then the immediately preceding completed candle is locked as P. This form never reads beyond the machine evaluation cursor.</p></div></div>
         {lockedEntryCandle && teaching ? <div className="grid gap-2 sm:grid-cols-2">
           <div className="border border-accent/30 bg-card px-3 py-2" data-testid="locked-entry-candle"><div className="eyebrow text-accent">Entry candle · E · locked</div><div className="mono mt-1 text-[10px]">{formatInterval(lockedEntryCandle.openTime, lockedEntryCandle.closeTime)}</div><div className="mono mt-1 text-[10px] text-muted-foreground">O {lockedEntryCandle.open.toFixed(2)} · H {lockedEntryCandle.high.toFixed(2)} · L {lockedEntryCandle.low.toFixed(2)} · C {lockedEntryCandle.close.toFixed(2)}</div></div>
           <div className="border border-[hsl(var(--positive)/.3)] bg-card px-3 py-2" data-testid="locked-patience-candle"><div className="eyebrow text-[hsl(var(--positive))]">Immediately preceding · P · locked</div><div className="mono mt-1 text-[10px]">{patience ? formatInterval(patience.openTime, patience.closeTime) : "Unavailable"}</div><div className="mono mt-1 text-[10px] text-muted-foreground">{patience ? `O ${patience.open.toFixed(2)} · H ${patience.high.toFixed(2)} · L ${patience.low.toFixed(2)} · C ${patience.close.toFixed(2)}` : "Choose an entry with a preceding candle."}</div></div>
         </div> : <div className="border border-dashed border-accent/40 px-3 py-3 text-[10px] text-muted-foreground">No completed entry candle is locked. Use the chart inspector's <strong>Lock as entry (E)</strong> control.</div>}
         {teaching && <div className="grid gap-3 sm:grid-cols-2">
           <Field label="Direction"><select className="field" value={teaching.direction} onChange={(event) => updateTeaching({ direction: event.target.value as "long" | "short" })}><option value="long">Long</option><option value="short">Short</option></select></Field>
           <Field label="Confirmation buffer"><select className="field mono" value={teaching.entryBufferTicks} onChange={(event) => updateTeaching({ entryBufferTicks: Number(event.target.value) as 3 | 4 })}><option value={3}>3 ticks · $1.50</option><option value={4}>4 ticks · $2.00</option></select></Field>
           <Field label="Qualifying level candle · L"><select className="field" value={levelCandle ? `${levelCandle.openTime}|${levelCandle.closeTime}` : ""} onChange={(event) => { const selected = selectableLevelCandles.find((candle) => `${candle.openTime}|${candle.closeTime}` === event.target.value); if (selected) updateTeaching({ levelCandleOpenTime: selected.openTime, levelCandleCloseTime: selected.closeTime }); }} data-testid="select-level-candle"><option value="" disabled>Select a causal L candle</option>{selectableLevelCandles.map((candle) => <option key={`${candle.openTime}|${candle.closeTime}`} value={`${candle.openTime}|${candle.closeTime}`}>{formatInterval(candle.openTime, candle.closeTime)}{patience && candle.openTime === patience.openTime ? " · direct L=P" : ""}</option>)}</select><span className="mt-1 block text-[9px] text-muted-foreground">L is the completed, machine-visible candle that qualifies the level. P and E remain locked.</span></Field>
           <div className="border border-border bg-card px-3 py-2" data-testid="level-indicator-evidence"><div className="eyebrow text-muted-foreground">Indicators at L</div><div className="mono mt-1 text-[10px]">VWAP {selectedIndicator?.vwap?.toFixed(3) ?? "—"} · EMA 200 {selectedIndicator?.ema200?.toFixed(3) ?? "—"}</div><div className="mt-1 text-[9px] text-muted-foreground">{selectedIndicator ? `Source ${formatInterval(selectedIndicator.openTime, selectedIndicator.closeTime)}` : "No causal indicator point at L"}</div></div>
           <fieldset className="sm:col-span-2"><legend className="eyebrow mb-1.5 block text-muted-foreground">Qualifying pullback levels</legend><div className="grid gap-2 sm:grid-cols-2">{availableLevels.map((level) => { const price = level.price; const dynamicId = level.id === "vwap" || level.id === "ema-200" ? level.id : null; const dynamic = dynamicId !== null; const evidence = dynamicId ? dynamicEvidence(dynamicId) : null; const selected = (teaching.qualifyingLevels ?? []).some((item) => item.levelId === level.id); const contained = containedLevels.includes(level); const levelType = dynamic ? "dynamic_indicator" as const : level.rangeLow !== null || level.rangeHigh !== null ? "level_range" as const : "fixed_level" as const; return <label key={`${level.id}-${level.price}`} className={`flex items-start gap-2 border px-3 py-2 text-[11px] transition ${selected ? "border-accent bg-accent/10" : contained ? "cursor-pointer border-border bg-card hover:bg-muted/40" : "cursor-not-allowed border-border bg-muted/30 opacity-50"}`}><input type="checkbox" checked={selected} disabled={!contained} onChange={(event) => { const nextStructured = event.target.checked ? [...(teaching.qualifyingLevels ?? []).filter((item) => item.levelId !== level.id), { levelId: level.id, levelType, valueAtInteraction: price, sourceTimestamp: selectedIndicator?.openTime ?? levelCandle?.openTime ?? "", rangeLow: levelType === "dynamic_indicator" ? null : level.rangeLow ?? null, rangeHigh: levelType === "dynamic_indicator" ? null : level.rangeHigh ?? null }] : (teaching.qualifyingLevels ?? []).filter((item) => item.levelId !== level.id); updateTeaching({ qualifyingLevels: nextStructured, ...deriveTeachingCompatibilityFields(nextStructured) }); }} /><span><span className="block font-bold">{level.label}</span><span className="mono text-muted-foreground">{formatPriceAxisValue(price)} · {level.id}</span>{dynamic && <span className="mt-1 block text-[9px] leading-4 text-muted-foreground">Value at L: {evidence?.value === null ? "—" : evidence?.value.toFixed(3)} · L range: {levelCandle ? `${levelCandle.low.toFixed(2)}–${levelCandle.high.toFixed(2)}` : "—"} · Tolerance: {levelToleranceTicks} ticks / {levelTolerancePointsValue.toFixed(2)} pt · Distance: {Number.isFinite(evidence?.distanceTicks) ? `${evidence?.distanceTicks} ticks` : "—"}<br /><span className={evidence?.qualifies ? "text-positive" : "text-negative"}>{evidence?.reason}</span></span>}{!dynamic && !contained && <span className="block text-[9px] text-negative">Outside {levelToleranceTicks}-tick zone at L</span>}</span></label>; })}</div><p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">Levels intersect L within the configured {levelToleranceTicks}-tick MES proximity zone. Dynamic VWAP and EMA values are captured from the indicator point at L; fixed levels retain their causal ranges.</p></fieldset>
            <Field label="Strategy"><select className="field" value={teaching.setupType} onChange={(event) => updateTeaching({ setupType: event.target.value as NonNullable<typeof teaching>["setupType"] })}><option value="ORB_PULLBACK_CONTINUATION">ORB pullback continuation</option><option value="CONSOLIDATION_BREAKOUT_CONTINUATION">Consolidation breakout continuation</option><option value="PATIENCE_CANDLE_CONTINUATION">Patience candle continuation</option><option value="EQUIVALENT_CANDLE_REVERSAL">Equivalent-candle reversal</option></select></Field>
           <Field label="Confidence"><select className="field" value={teaching.confidence} onChange={(event) => updateTeaching({ confidence: event.target.value as NonNullable<typeof teaching>["confidence"] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
           <div className="border border-border bg-card px-3 py-2"><div className="eyebrow text-muted-foreground">Calculated MES entry</div><div className="mono mt-1 text-sm font-bold" data-testid="calculated-mes-entry">{calculatedEntryPrice}</div><div className="mt-1 text-[9px] text-muted-foreground">{teaching.direction === "long" ? "P high" : "P low"} {teaching.direction === "long" ? "+" : "−"} {teaching.entryBufferTicks} × 0.25</div></div>
           <Field label="Level tolerance"><select className="field" value={teaching.levelToleranceTicks ?? DEFAULT_LEVEL_TOLERANCE_TICKS} onChange={(event) => updateTeaching({ levelToleranceTicks: Number(event.target.value) as 4 | 8 | 12 })}>{LEVEL_TOLERANCE_TICKS.map((ticks) => <option key={ticks} value={ticks}>{ticks} ticks · {levelTolerancePoints(ticks).toFixed(2)} pt{ticks === DEFAULT_LEVEL_TOLERANCE_TICKS ? " (default)" : ""}</option>)}</select><span className="mt-1 block text-[9px] text-muted-foreground">Allowed qualifying proximity: {DEFAULT_LEVEL_TOLERANCE_TICKS} MES ticks / {levelTolerancePoints(DEFAULT_LEVEL_TOLERANCE_TICKS).toFixed(2)} points by default. Saved reviews retain their selected tolerance.</span></Field>
           <label className="block sm:col-span-2"><span className="eyebrow mb-1.5 block text-muted-foreground">Teaching explanation · required</span><textarea maxLength={4000} rows={4} value={teaching.explanation} onChange={(event) => updateTeaching({ explanation: event.target.value })} className="field resize-none" placeholder="Explain what the formula missed or why this correction needs clarification." /><span className="mt-1 block text-right text-[10px] text-muted-foreground">{teaching.explanation.length} / 4000</span></label>
         </div>}
         {status === "rule_needs_clarification" && <div className="text-[10px] leading-4 text-muted-foreground">If the candle pair fails validation, save this as <strong>Rule needs clarification</strong>. A direct Missed trade submission is accepted only when timing, direction, level proximity, causal visibility, and buffer checks all pass.</div>}
       </div>}
       {status === "false_positive_trade" && <div className="border border-[hsl(var(--negative)/.35)] bg-[hsl(var(--negative)/.06)] p-3 text-[10px] leading-4 text-muted-foreground" data-testid="false-positive-guidance"><strong className="text-foreground">Machine trade locked.</strong> Explain which raw candle or causal rule disproves this exact trade. The formula remains unchanged.</div>}
      <label className="block"><span className="eyebrow mb-1.5 block text-muted-foreground">Reviewer note · optional</span><textarea maxLength={2000} rows={5} value={note} onChange={(event) => setNote(event.target.value)} className="field resize-none" placeholder="Name the exact candle, level, or rule ambiguity you observed." /><span className="mt-1 block text-right text-[10px] text-muted-foreground">{note.length} / 2000</span></label>
       {message && <div className="border border-[hsl(var(--positive)/.25)] bg-[hsl(var(--positive)/.08)] p-3 text-xs text-[hsl(var(--positive))]" role="status">{message}</div>}
       <div className="flex flex-wrap gap-2">
         <button type="button" onClick={() => status && onSave(status)} disabled={pending || !status || !dirty} className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-primary px-3 py-2.5 text-[10px] font-bold uppercase tracking-[.08em] text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45" data-testid="button-submit-review">{pending ? <LoaderCircle size={13} className="animate-spin" /> : <ClipboardCheck size={13} />}{hasSavedReview ? "Update review" : "Submit review"}</button>
         <button type="button" onClick={() => status && onSave(status, true)} disabled={pending || !status || !dirty} className="inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2.5 text-[10px] font-bold uppercase tracking-[.08em] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45" data-testid="button-submit-next">Submit & inspect next <ChevronRight size={13} /></button>
       </div>
        <div className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground"><LockKeyhole size={13} className="mt-0.5 shrink-0" />Selecting an option only creates a draft. {hasSavedReview ? "Update" : "Submit"} to persist it. Human judgments never mutate executable formula behavior.</div>
       <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[10px]">{hasSavedReview ? <span className="text-[hsl(var(--positive))]">Saved {savedStatus?.replaceAll("_", " ")} · {formatReviewTime(snapshot.review.reviewedAt ?? "")}</span> : <span className="text-muted-foreground">Not reviewed yet</span>}{dirty && <span className="font-semibold text-accent-foreground">Unsaved changes</span>}</div>
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

function ProposedRulePanel({ analysis, pending, onAnalyze }: { analysis: VisualValidationProposedRuleAnalysis | null; pending: boolean; onAnalyze: () => void }) {
  return <Panel>
    <div className="flex items-center justify-between gap-3 px-5 py-4 sm:px-6">
      <div><div className="eyebrow text-muted-foreground">Advisory / teaching patterns</div><h2 className="mt-1 text-[14px] font-bold">Propose a rule review</h2></div>
      <button type="button" onClick={onAnalyze} disabled={pending} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[.08em] hover:bg-muted disabled:opacity-55" data-testid="button-analyze-teaching">{pending ? <LoaderCircle size={13} className="animate-spin" /> : <Sparkles size={13} />}Analyze</button>
    </div>
    <div className="border-t border-border px-5 py-3 text-[11px] leading-5 text-muted-foreground sm:px-6">Compare persisted teaching examples for support, conflict, and likely disagreement causes. This output is advisory only and cannot approve a formula change or start a backtest.</div>
    {analysis && <div className="space-y-3 border-t border-border bg-accent/5 px-5 py-4 text-[10px] sm:px-6" data-testid="proposed-rule-analysis">
      <div className="flex items-start gap-2"><Sparkles size={14} className="mt-0.5 shrink-0 text-accent" /><div><div className="font-bold">{analysis.hypothesis}</div><div className="mt-1 text-muted-foreground">Formula {analysis.activeFormulaVersion} · {analysis.supportingExamples.length} supporting · {analysis.conflictingExamples.length} conflicting</div></div></div>
      <div><div className="eyebrow text-muted-foreground">Likely causes</div><ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">{analysis.likelyCauses.map((cause) => <li key={cause}>{cause}</li>)}</ul></div>
      <div className="border border-accent/30 bg-card px-3 py-2 font-semibold text-accent-foreground">Approval required. No executable rule was changed.</div>
      {analysis.insufficientEvidence && <div className="text-muted-foreground">Evidence remains insufficient; collect more structured examples before considering any approved rule change.</div>}
    </div>}
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

function InfoTip({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const tipRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!tipRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  const id = `info-tip-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return <span ref={tipRef} className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button type="button" className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`More information about ${label}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen((current) => !current)}><Info size={12} /></button>
    {open && <span id={id} role="tooltip" className="absolute bottom-full left-0 z-30 mb-2 w-56 rounded-md border border-border bg-popover p-2.5 text-[10px] font-normal normal-case leading-4 tracking-normal text-popover-foreground shadow-lg">{text}</span>}
  </span>;
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <label className="block"><span className="eyebrow mb-1.5 block text-muted-foreground">{label}</span>{children}</label>;
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-2 text-xs font-medium">{value}</div>{sub && <div className="mono mt-1 text-[9px] text-muted-foreground">{sub}</div>}</div>;
}

function ReviewDot({ status }: { status: VisualValidationReviewStatus }) {
  if (status === "unreviewed") return <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/50" aria-label="Unreviewed" />;
  const tone = status === "correct" ? "bg-[hsl(var(--positive))]" : status === "incorrect" ? "bg-[hsl(var(--negative))]" : "bg-accent";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} aria-label={status.replaceAll("_", " ")} />;
}