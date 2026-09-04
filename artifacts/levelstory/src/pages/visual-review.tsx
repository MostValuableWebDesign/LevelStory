import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
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
  useGetVisualValidationGenerationJob,
  useStartVisualValidationGenerationJob,
  useExportVisualValidationDiscrepancies,
  useGetVisualValidationSet,
  useGetShadowAccountReplay,
  useRecordVisualValidationReview,
  useAnalyzeVisualValidationTeaching,
} from "@workspace/api-client-react";
import type {
  VisualValidationAnnotation,
  VisualValidationCategoryAnchor,
  VisualValidationCategory,
  VisualValidationDiscrepancyReport,
  VisualValidationGenerationJob,
  VisualValidationRequest,
  VisualValidationReviewStatus,
  VisualValidationReviewRequest,
  VisualValidationProposedRuleAnalysis,
  VisualValidationSet,
  VisualValidationSnapshot,
  ShadowAccountReplay,
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
import { UploadedChartAnalysis } from "@/components/uploaded-chart-analysis";

const FRONTEND_BUILD_ID = import.meta.env.VITE_LEVELSTORY_BUILD_ID ?? "local-development";
const TRADE_TARGET_LEGEND_ID = "trade-target-exit";
const TRADE_RUNNER_LEGEND_ID = "trade-runner-exit";
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
   findConsolidationZones,
  getEdgeIndicators,
  getFixedTimeAxisTicks,
  getPriceAxis,
  getSessionDomainSlotCount,
  getVolumeAxisTicks,
  hasRepetitiveFixtureData,
  invalidRawCandleIndices,
  isVisualPresentationAnnotation,
  isDynamicIndicatorAnnotation,
  isOpeningRangeCompleteAtEvaluation,
  isPrimaryLevel,
   chartLevelLabel,
  INTRADAY_REFERENCE_PRESENTATION,
  mergeOrbNtzAnnotations,
  priceToY,
  resolveChartPointerFromClientPoint,
  selectSessionCandles,
  type SessionCandle,
  type SessionView,
  type CandleInspection,
} from "@/lib/visual-review-chart";

const TRADE_CATEGORY_VALUES = new Set<VisualValidationCategory>([
  "qualified_trade",
]);
const CHART_LEVEL_ORDER = [
  "vwap",
  "ema-200",
  "orb-high",
  "orb-low",
  "ntz-high",
  "ntz-low",
  "premarket-high",
  "premarket-low",
  "previous-session-high",
  "previous-session-low",
  "two-sessions-high",
  "two-sessions-low",
  "major",
  "confluence",
  "entry",
  "strategy-stop",
  "target",
  "runner",
] as const;
const STRATEGY_TABS: Array<{ id: StrategyId; label: string }> = [
  { id: "ORB_PULLBACK_CONTINUATION", label: "ORB Break–Pullback–Patience Continuation" },
  { id: "PATIENCE_CANDLE_CONTINUATION", label: "Patience Candle Continuation" },
  { id: "CONSOLIDATION_BREAKOUT_CONTINUATION", label: "Strong Breakout After Consolidation" },
  { id: "EQUIVALENT_CANDLE_REVERSAL", label: "Equivalent-Candle Reversal" },
];
type CandidateTradeView = {
  entryPrice?: number;
  primaryEdge?: string;
  matchedEdges?: string[];
  supportingConfluences?: string[];
  setupGrade?: "A" | "A+" | "A++";
};
type CandidateAuditView = { entryTriggerPrice?: number };
type TradeLegView = {
  kind?: string;
  quantity?: number;
  referencePrice?: number;
  fillPrice?: number;
  grossPnl?: number;
  slippage?: number;
  fees?: number;
  netPnl?: number;
  exitReason?: string;
  exitCandleOpenTime?: string;
  exitCandleCloseTime?: string;
};
type TradeEvidenceView = {
  direction?: "long" | "short";
  contracts?: number;
  entryTime?: string;
  exitTime?: string | null;
  entryPrice?: number;
  exitPrice?: number | null;
  grossPnl?: number;
  fees?: number;
  slippage?: number;
  netPnl?: number;
  outcome?: string;
  targetPlan?: {
    disposition?: string;
    targetPrice?: number | null;
    selectedTargetLevel?: { id: string; price: number } | null;
  };
  audit?: {
    oneRPrice?: number | null;
    oneRReached?: boolean;
    profitCheckpointPrice?: number | null;
    exitCandleOpenTime?: string | null;
    exitCandleCloseTime?: string | null;
    exitReason?: string;
    stopLevel?: "primary_level" | "strategy" | "catastrophe" | null;
    primaryLossExitLevel?: {
      id: string;
      type: string;
      price: number;
      stopPrice: number;
      qualificationTicks: number;
      bufferTicks: number;
    } | null;
    legs?: TradeLegView[];
  };
};
const CANONICAL_EDGE_BY_STRATEGY: Record<string, string> = {
  ORB_PULLBACK_CONTINUATION: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
  ORB_BREAK_PULLBACK_CONTINUATION: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
  CONSOLIDATION_BREAKOUT_CONTINUATION: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
};
const canonicalEdgeForStrategy = (strategy: StrategyId) => CANONICAL_EDGE_BY_STRATEGY[strategy] ?? strategy;
const edgeDisplayLabel = (edge: string) => STRATEGY_TABS.find((item) => item.id === edge || canonicalEdgeForStrategy(item.id) === edge)?.label ?? edge;

const REVIEW_OPTIONS: Array<{ value: Exclude<VisualValidationReviewStatus, "unreviewed">; label: string; detail: string }> = [
  { value: "correct", label: "Correct", detail: "Machine story matches the candles." },
  { value: "incorrect", label: "Incorrect", detail: "The machine label does not hold up." },
  { value: "uncertain", label: "Uncertain", detail: "Evidence is not decisive." },
  { value: "rule_needs_clarification", label: "Rule needs clarification", detail: "The rule or annotation needs a sharper definition." },
  { value: "missed_trade", label: "Missed trade", detail: "The candles contain a valid, causal trade the machine did not capture." },
  { value: "false_positive_trade", label: "False-positive trade", detail: "The machine trade is not supported by the raw causal candle story." },
];

type ReviewDisclosurePanel = "summary" | "judgment" | "replay";
type ReviewDisclosureState = Record<ReviewDisclosurePanel, boolean>;
const CLOSED_REVIEW_DISCLOSURES: ReviewDisclosureState = {
  summary: false,
  judgment: false,
  replay: false,
};

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

function clearStoredReviewSetSelection(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem("levelstory.visualReviewSetId");
  const url = new URL(window.location.href);
  if (!url.searchParams.has("reviewSetId")) return;
  url.searchParams.delete("reviewSetId");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function storedGenerationJobId(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem("levelstory.visualReviewGenerationJobId") ?? "";
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
}

function formatEstimate(milliseconds: number | null): string | null {
  if (milliseconds === null || milliseconds < 1000) return null;
  return `About ${formatDuration(milliseconds)} remaining`;
}

function requestedReviewCategory(): VisualValidationCategory | null {
  if (typeof window === "undefined") return null;
  const candidate = new URLSearchParams(window.location.search).get("category");
  return candidate === "qualified_trade" ? "qualified_trade" : null;
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

function formatReviewTime(value: string): string {
  if (!value) return "—";
  return value.replace("T", " ").replace("Z", " UTC");
}

function formatReplayTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatAccountMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatAccountPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatAccountNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function safeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(3) : "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return JSON.stringify(value);
}

function apiErrorMessage(error: unknown): string | null {
  if (error && typeof error === "object" && "data" in error) {
    const data = error.data;
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
      return data.error;
    }
  }
  return error instanceof Error ? error.message : null;
}

function historicalRangeRecovery(error: string | null): { requestedEndDate: string; availableEndDate: string } | null {
  if (!error) return null;
  const match = error.match(
    /Multi-contract historical range \d{4}-\d{2}-\d{2} through (\d{4}-\d{2}-\d{2}) contains 0 eligible trading dates; \d+ are required\. Available eligible history spans \d{4}-\d{2}-\d{2} through (\d{4}-\d{2}-\d{2})\./i,
  );
  if (!match || !match[1] || !match[2]) return null;
  return { requestedEndDate: match[1], availableEndDate: match[2] };
}

function apiErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error) || typeof error.status !== "number") return null;
  return error.status;
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
  if (annotation.id.startsWith("dynamite|")) return "#4169E1";
  if (annotation.id === "orb-high" || annotation.id === "orb-low") return "hsl(33 93% 52%)";
  if (annotation.id === "premarket-high" || annotation.id === "premarket-low") return "hsl(var(--positive))";
  if (annotation.id in INTRADAY_REFERENCE_PRESENTATION) {
    return INTRADAY_REFERENCE_PRESENTATION[annotation.id as keyof typeof INTRADAY_REFERENCE_PRESENTATION].color;
  }
  if (annotation.id === "vwap") return "hsl(5 58% 46%)";
  if (annotation.id === "ema-200") return "hsl(145 45% 42%)";
  if (annotation.id.startsWith("critical-") || annotation.id.includes("support") || annotation.id.includes("resistance")) return "hsl(214 37% 15%)";
  if (annotation.id === "entry-buffer") return "hsl(var(--positive))";
  if (annotation.id === "strategy-stop") return "hsl(var(--negative))";
   if (annotation.id === "target") return "hsl(var(--positive))";
  return annotationTone(annotation.color);
}

function chartLevelGroup(annotation: VisualValidationAnnotation): string {
  if (annotation.id === "vwap" || annotation.id === "ema-200") return annotation.id;
  if (["orb-high", "orb-low", "ntz-high", "ntz-low"].includes(annotation.id)) return annotation.id;
  if (annotation.id === "premarket-high" || annotation.id === "premarket-low") return annotation.id;
  if (["previous-session-high", "previous-session-low"].includes(annotation.id)) return annotation.id;
  if (["two-sessions-high", "two-sessions-low"].includes(annotation.id)) return annotation.id;
  if (annotation.id.startsWith("major-")) return "major";
  if (annotation.id.startsWith("dynamite|")) return "confluence";
  if (annotation.id === "entry-buffer") return "entry";
  if (annotation.id === "strategy-stop") return "strategy-stop";
  if (annotation.id === "target" || annotation.id === "one-r-target" || annotation.id === "selected-target-level" || annotation.id.startsWith("skipped-target-")) return "target";
  return annotation.id;
}

function chartLevelOrder(annotation: VisualValidationAnnotation): number {
  const group = chartLevelGroup(annotation);
  const index = CHART_LEVEL_ORDER.indexOf(group as typeof CHART_LEVEL_ORDER[number]);
  return index === -1 ? CHART_LEVEL_ORDER.length : index;
}

export default function VisualReview() {
  const [request, setRequest] = useState<VisualValidationRequest>(() => ({
    ...INITIAL_REQUEST,
    source: storedReviewSource(),
    seed: storedReviewSource() === "simulated" ? 11 : undefined,
  }));
  const [reviewSetId, setReviewSetId] = useState(storedReviewSetId);
  const [reviewSetRequested, setReviewSetRequested] = useState(false);
  const [localSet, setLocalSet] = useState<VisualValidationSet | null>(null);
  const [loadLatestReviewSet, setLoadLatestReviewSet] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<VisualValidationCategory | null>(requestedReviewCategory);
  const [selectedStrategyKey, setSelectedStrategyKey] = useState<StrategyId | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewStatus, setReviewStatus] = useState<Exclude<VisualValidationReviewStatus, "unreviewed"> | null>(null);
  const [lockedEntryCandle, setLockedEntryCandle] = useState<SessionCandle | null>(null);
  const [teachingDraft, setTeachingDraft] = useState<NonNullable<VisualValidationReviewRequest["teaching"]> | null>(null);
  const [message, setMessage] = useState("");
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [generationJobId, setGenerationJobId] = useState(storedGenerationJobId);
  const [startingBalance, setStartingBalance] = useState("10000");
  const [contractsPerTrade, setContractsPerTrade] = useState("2");
  const [openReviewPanels, setOpenReviewPanels] = useState<ReviewDisclosureState>(CLOSED_REVIEW_DISCLOSURES);
  const [report, setReport] = useState<VisualValidationDiscrepancyReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [analysis, setAnalysis] = useState<VisualValidationProposedRuleAnalysis | null>(null);
  const toggleReviewPanel = (panel: ReviewDisclosurePanel) => {
    setOpenReviewPanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

  const startGeneration = useStartVisualValidationGenerationJob();
  const pinnedReviewSetId = reviewSetRequested && !loadLatestReviewSet ? reviewSetId : "";
  const setQuery = useGetVisualValidationSet(
    pinnedReviewSetId ? { reviewSetId: pinnedReviewSetId } : undefined,
    { query: { enabled: reviewSetRequested && !startGeneration.isPending && !Boolean(generationJobId) && (Boolean(pinnedReviewSetId) || loadLatestReviewSet), staleTime: 30_000, queryKey: ["visual-validation-set", pinnedReviewSetId || "latest"] } },
  );
  const generationQuery = useGetVisualValidationGenerationJob(
    generationJobId,
    {
      query: {
        enabled: reviewSetRequested && Boolean(generationJobId),
        queryKey: ["visual-validation-generation-job", generationJobId],
        staleTime: 0,
        refetchInterval: (query) => {
          const status = query.state.data?.status;
          return status === "queued" || status === "running" ? 1500 : false;
        },
      },
    },
  );
  const recordReview = useRecordVisualValidationReview();
  const analyzeRule = useAnalyzeVisualValidationTeaching();
  const generationJob: VisualValidationGenerationJob | null = generationQuery.data ?? startGeneration.data ?? null;
  const generationActive = startGeneration.isPending
    || generationJob?.status === "queued"
    || generationJob?.status === "running"
    || (Boolean(generationJobId) && generationQuery.isLoading);
  const replayReviewSetId = reviewSetRequested ? localSet?.reviewSetId ?? setQuery.data?.reviewSetId ?? reviewSetId : "";
  const exportId = reviewSetRequested ? localSet?.reviewSetId ?? setQuery.data?.reviewSetId ?? reviewSetId : "";
  const exportQuery = useExportVisualValidationDiscrepancies(
    { reviewSetId: exportId || "00000000-0000-0000-0000-000000000000" },
    { query: { enabled: false, queryKey: ["visual-validation-discrepancies", exportId || "none"] } },
  );
  const replayParams = useMemo(() => ({
    reviewSetId: replayReviewSetId || "00000000-0000-0000-0000-000000000000",
    startingBalance: Number(startingBalance),
    contractsPerTrade: Number(contractsPerTrade),
  }), [contractsPerTrade, replayReviewSetId, startingBalance]);
  const shadowReplayQuery = useGetShadowAccountReplay(replayParams, {
    query: {
      enabled: Boolean(replayReviewSetId)
        && !generationActive
        && Number(startingBalance) > 0
        && Number(contractsPerTrade) >= 1
        && Number(contractsPerTrade) <= 100,
      queryKey: ["shadow-account-replay", replayParams.reviewSetId, replayParams.startingBalance, replayParams.contractsPerTrade],
      staleTime: 30_000,
    },
  });

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

  useEffect(() => {
    if (generationQuery.isError && generationJobId) {
      if (typeof window !== "undefined") window.sessionStorage.removeItem("levelstory.visualReviewGenerationJobId");
      setGenerationJobId("");
      setMessage(apiErrorMessage(generationQuery.error) ?? "The saved generation job is no longer available. Start a new generation.");
    }
  }, [generationJobId, generationQuery.error, generationQuery.isError]);

  useEffect(() => {
    if (localSet || generationActive) return;
    if (setQuery.data?.stale) {
      setMessage("The saved review set is stale under the current replay or projection versions. Generate fresh to create a new immutable set; existing reviews remain preserved.");
      return;
    }
    if (reviewSetId && !loadLatestReviewSet && setQuery.isError && apiErrorStatus(setQuery.error) === 404) {
      clearStoredReviewSetSelection();
      setReviewSetId("");
      setLoadLatestReviewSet(true);
      setMessage("The saved review set expired; switched to the latest available set.");
    }
  }, [generationActive, loadLatestReviewSet, localSet, reviewSetId, setQuery.data, setQuery.error, setQuery.isError]);

  useEffect(() => {
    if (!generationJob) return;
    if (generationJob.status === "completed" && generationJob.result) {
      setLocalSet(generationJob.result);
      setReviewSetId(generationJob.result.reviewSetId);
      setReviewStatus(null);
      setReviewNote("");
       setAnalysis(null);
      setOpenReviewPanels(CLOSED_REVIEW_DISCLOSURES);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("levelstory.visualReviewSetId", generationJob.result.reviewSetId);
        window.sessionStorage.removeItem("levelstory.visualReviewGenerationJobId");
      }
      const qualifiedCount = generationJob.result.snapshots.filter((snapshot) => snapshot.category === "qualified_trade").length;
      setMessage(qualifiedCount > 0
        ? `Generated ${qualifiedCount} authoritative trade candidate${qualifiedCount === 1 ? "" : "s"}.`
        : "Replay completed, but this date window contains no risk-approved candidate-owned fills. Try a window with a qualifying trade.");
    } else if (generationJob.status === "failed" && request.source === "historical_databento") {
      const recovery = historicalRangeRecovery(generationJob.error);
      if (recovery && request.endDate === recovery.requestedEndDate) {
        setRequest((current) => ({ ...current, endDate: recovery.availableEndDate }));
        setMessage(`The saved review date ended before eligible MES history. The date was reset to ${recovery.availableEndDate}; retry generation.`);
      }
    }
  }, [generationJob, request.endDate, request.source]);

  const currentSet = setQuery.data?.stale ? null : setQuery.data;
  const data = generationActive ? null : localSet ?? currentSet;
  const coverage = data?.categoryCoverage ?? [];
  const snapshots = data?.snapshots ?? [];
  const strategySnapshots = useMemo(
    () => (selectedStrategyKey
      ? snapshots.filter((snapshot) => snapshot.category === "qualified_trade" && snapshot.strategyKey === selectedStrategyKey)
      : snapshots.filter((snapshot) => snapshot.category === "qualified_trade")),
    [selectedStrategyKey, snapshots],
  );
  const availableCategories = useMemo(() => coverage
    .filter((item) => item.available && strategySnapshots.some((snapshot) => snapshot.category === item.category) && TRADE_CATEGORY_VALUES.has(item.category))
    .map((item) => item.category), [coverage, strategySnapshots]);
  const categorySnapshots = useMemo(
    () => strategySnapshots.filter((snapshot) => snapshot.category === selectedCategory),
    [selectedCategory, strategySnapshots],
  );
  const reviewQueue = strategySnapshots;
  const activeSnapshot = reviewQueue.find((snapshot) => snapshot.snapshotId === selectedSnapshotId)
    ?? categorySnapshots[0]
    ?? reviewQueue[0];

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
    if (!selectedCategory || !availableCategories.includes(selectedCategory)) {
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
    const snapshot = reviewQueue.find((item) => item.snapshotId === snapshotId);
    if (!snapshot) return;
    setSelectedCategory(snapshot.category);
    setSelectedSnapshotId(snapshotId);
  };

  const startReviewSetGeneration = (regenerateFresh = false) => {
    if (!confirmDiscardReview()) return;
    if (regenerateFresh && typeof window !== "undefined" && !window.confirm("Regenerate fresh for this review request? This recomputes only the derived review set, keeps existing review history intact, and does not rebuild the historical index.")) return;
    setReviewSetRequested(true);
    setGenerationJobId("");
    if (typeof window !== "undefined") window.sessionStorage.removeItem("levelstory.visualReviewGenerationJobId");
    setMessage("");
    setReport(null);
    setLocalSet(null);
    startGeneration.mutate({ data: { ...request, ...(regenerateFresh ? { regenerateFresh: true } : {}) } }, {
      onSuccess: (job) => {
        setGenerationJobId(job.jobId);
        if (typeof window !== "undefined") window.sessionStorage.setItem("levelstory.visualReviewGenerationJobId", job.jobId);
        if (job.status === "failed") setMessage(job.error ?? "The deterministic set could not be generated.");
      },
      onError: (error) => setMessage(apiErrorMessage(error) ?? "The generation job could not be started."),
    });
  };

  const generateReviewSet = () => startReviewSetGeneration(false);
  const regenerateFreshReviewSet = () => startReviewSetGeneration(true);

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

  const retryGeneration = () => {
    if (typeof window !== "undefined") window.sessionStorage.removeItem("levelstory.visualReviewGenerationJobId");
    setGenerationJobId("");
    startGeneration.reset();
    generateReviewSet();
  };

  const generationBusy = startGeneration.isPending || generationActive;

  const submitGeneration = (event: FormEvent) => {
    event.preventDefault();
    generateReviewSet();
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
              <div className="xl:col-span-2"><UploadedChartAnalysis activeSnapshot={activeSnapshot} authenticated={authenticated} /></div>
             <GenerationPanel request={request} setRequest={(next) => {
              setRequest(next);
              if (typeof window !== "undefined" && next.source) window.localStorage.setItem("levelstory.visualReviewSource", next.source);
             }} onSubmit={submitGeneration} onRegenerateFresh={regenerateFreshReviewSet} pending={Boolean(generationBusy)} message={message} />
             <CoverageRail
               data={data}
               loading={setQuery.isLoading}
               selectedStrategyKey={selectedStrategyKey}
               selectedCategory={selectedCategory}
               selectedSnapshot={activeSnapshot}
               selectedSnapshotIndex={reviewQueue.findIndex((item) => item.snapshotId === activeSnapshot?.snapshotId)}
               selectedSnapshotTotal={reviewQueue.length}
               onSelectStrategy={(key) => {
                 if (!confirmDiscardReview()) return;
                 setSelectedStrategyKey(key);
                 setSelectedCategory(null);
                 setSelectedSnapshotId("");
               }}
                 onSelectSnapshot={selectSnapshot}
               onPrevious={() => activeSnapshot && moveSnapshot(reviewQueue, activeSnapshot, -1, selectSnapshot)}
                onNext={() => activeSnapshot && moveSnapshot(reviewQueue, activeSnapshot, 1, selectSnapshot)}
                generationJob={generationJob}
                onRetryGeneration={retryGeneration}
             />
          </div>

           <div className="mt-5 w-full" data-testid="combined-shadow-replay-section">
             <ShadowAccountReplayPanel reviewSetId={replayReviewSetId} generationActive={generationActive} onRegenerateFresh={regenerateFreshReviewSet} query={shadowReplayQuery} startingBalance={startingBalance} setStartingBalance={setStartingBalance} contractsPerTrade={contractsPerTrade} setContractsPerTrade={setContractsPerTrade} open={openReviewPanels.replay} onToggleOpen={() => toggleReviewPanel("replay")} />
           </div>

            {generationActive ? <div className="mt-5"><Panel><QuerySkeleton rows={6} /></Panel></div> : setQuery.isLoading && !data ? <Panel><QuerySkeleton rows={6} /></Panel> : setQuery.isError && !data ? apiErrorStatus(setQuery.error) === 404 && reviewSetId ? (
             <Panel accent>
               <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                 <div><div className="eyebrow text-destructive">Review set unavailable</div><p className="mt-1 text-sm font-semibold">This review set expired or was generated by an older server process.</p><p className="mt-1 text-xs text-muted-foreground">Regenerate from the ready historical index; no source index rebuild is required.</p></div>
                 <button type="button" onClick={generateReviewSet} className="shrink-0 rounded-md bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:opacity-90">Regenerate review set</button>
               </div>
             </Panel>
           ) : (
            <Panel accent><QueryError onRetry={() => setQuery.refetch()} message="The visual-validation set could not be loaded." /></Panel>
          ) : !data ? (
            <div className="space-y-5">
              <Panel><EmptyReview /></Panel>
            </div>
          ) : (
            <>
               {(data.stale || data.currentBuildId !== FRONTEND_BUILD_ID) && <div className="mb-5 flex flex-col gap-3 border border-accent/45 bg-accent/10 px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between" role="alert"><div><strong>Stale review set — regenerate.</strong><span className="ml-2 text-muted-foreground">Generated build {data.buildId}; current build {data.currentBuildId}.</span></div><button type="button" onClick={generateReviewSet} className="shrink-0 rounded-md border border-accent/50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.08em] hover:bg-accent/15">Regenerate</button></div>}
                <ReviewSetProvenance data={data} />
                <ReviewSetDiagnostics data={data} />
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
                          entryBufferTicks: current?.entryBufferTicks ?? 8,
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
                     <ChartEvidence snapshot={activeSnapshot} open={openReviewPanels.summary} onToggleOpen={() => toggleReviewPanel("summary")} />
                    <ReviewPanel snapshot={activeSnapshot} status={reviewStatus} setStatus={setReviewStatus} note={reviewNote} setNote={setReviewNote} dirty={reviewDirty} pending={recordReview.isPending} onSave={saveReview} message={message} lockedEntryCandle={lockedEntryCandle} teaching={teachingDraft} setTeaching={setTeachingDraft} authenticated={authenticated} open={openReviewPanels.judgment} onToggleOpen={() => toggleReviewPanel("judgment")} />
                  </div>
                </div>
              ) : <div className="space-y-5"><UnavailableWorkspace coverage={coverage} source={data.source} /></div>}
            </>
          )}
           {data && activeSnapshot && <div className="mt-5 grid items-start gap-5 md:grid-cols-2">
             <DiscrepancyPanel report={report} open={reportOpen} setOpen={setReportOpen} pending={exportQuery.isFetching} onExport={exportReport} />
             <ProposedRulePanel analysis={analysis} pending={analyzeRule.isPending} onAnalyze={() => {
               analyzeRule.mutate({ data: { reviewSetId: data.reviewSetId, ...(activeSnapshot.review.teaching?.teachingId ? { teachingId: activeSnapshot.review.teaching.teachingId } : {}) } }, {
                 onSuccess: setAnalysis,
               });
             }} />
           </div>}
        </div>
      </div>
    </LevelStoryShell>
  );
}

type ShadowReplayQuery = ReturnType<typeof useGetShadowAccountReplay>;

function ShadowAccountReplayPanel({
  reviewSetId,
  generationActive = false,
  onRegenerateFresh,
  query,
  startingBalance,
  setStartingBalance,
  contractsPerTrade,
  setContractsPerTrade,
  open,
  onToggleOpen,
}: {
  reviewSetId: string;
  generationActive?: boolean;
  onRegenerateFresh: () => void;
  query: ShadowReplayQuery;
  startingBalance: string;
  setStartingBalance: (value: string) => void;
  contractsPerTrade: string;
  setContractsPerTrade: (value: string) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const replay = query.data as ShadowAccountReplay | undefined;
  const parsedStartingBalance = Number(startingBalance);
  const parsedContracts = Number(contractsPerTrade);
  const inputsValid = parsedStartingBalance > 0 && parsedContracts >= 2 && parsedContracts <= 100;

  const metric = (label: string, value: string, detail?: string, tone?: string) => (
    <div className="metric-cell min-w-0 bg-card px-4 py-3" key={label}>
      <div className="eyebrow text-muted-foreground">{label}</div>
      <div className={`mono mt-1 text-[15px] font-bold tracking-tight ${tone ?? ""}`}>{value}</div>
      {detail && <div className="mt-1 text-[10px] text-muted-foreground">{detail}</div>}
    </div>
  );

  const stateContent = () => {
    if (!reviewSetId) {
      return <div className="border border-dashed border-border bg-muted/20 px-4 py-5 text-sm text-muted-foreground" data-testid="shadow-replay-empty">Select or generate a Visual Review set to replay its candidate-owned trades.</div>;
    }
    if (generationActive) {
      return <div className="space-y-3" data-testid="shadow-replay-pending">
        <div className="skeleton h-16 w-full rounded" />
        <div className="grid grid-cols-1 gap-2"><div className="skeleton h-14 rounded" /><div className="skeleton h-14 rounded" /><div className="skeleton h-14 rounded" /></div>
        <div className="mono text-[10px] text-muted-foreground">The selected review set is being regenerated. Shadow account results will recompute when the immutable set is ready.</div>
      </div>;
    }
    if (!inputsValid) {
      return <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/10 px-3 py-3 text-xs text-destructive" role="alert" data-testid="shadow-replay-invalid-inputs"><AlertTriangle size={14} className="mt-0.5 shrink-0" />Starting balance must be greater than 0 and contracts per trade must be between 2 and 100.</div>;
    }
    if (query.isLoading || query.isFetching && !replay) return <QuerySkeleton rows={3} />;
    if (query.isError) return <QueryError onRetry={() => query.refetch()} message="The shadow replay could not be loaded." />;
    if (!replay) return <div className="border border-dashed border-border bg-muted/20 px-4 py-5 text-sm text-muted-foreground" data-testid="shadow-replay-empty">No replay has been computed for this review set yet.</div>;
    if (replay.enteredTrades === 0) {
       return <div className="border border-dashed border-border bg-muted/20 px-4 py-5" data-testid="shadow-replay-zero-trades">
         <div className="flex items-center gap-2 text-sm font-bold"><Info size={15} className="text-accent" />No entered trades in the processed date set.</div>
         <p className="mt-1 text-xs leading-5 text-muted-foreground">The complete {replay.processedDates.length}-date replay scope contains no risk-approved entries. The date coverage remains available below so zero-trade sessions are not hidden.</p>
      </div>;
    }
    return <ShadowReplayResults replay={replay} metric={metric} />;
  };

  return <div data-testid="shadow-account-replay-panel"><Panel accent className="shadow-replay-panel">
     <DisclosurePanelTitle
       panelId="combined-shadow-replay-content"
      eyebrow="Account impact / read-only"
       title="Combined Shadow Account Replay"
       right={<div className="flex items-center gap-2"><ShadowBadge /><LockKeyhole size={14} className="text-muted-foreground" /></div>}
       open={open}
       onToggleOpen={onToggleOpen}
    />
     {open && <div id="combined-shadow-replay-content" className="border-t border-border px-5 py-4 sm:px-6">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-xl text-xs leading-5 text-muted-foreground">
           <span className="font-bold text-foreground">Dummy money only.</span> Replays every processed date in the immutable Visual Review set with fixed contract sizing. It is independent of the selected chart snapshot; no compounding, broker, paper, or live action is available.
        </div>
        <div className="mono shrink-0 text-[9px] text-muted-foreground">SET · {reviewSetId ? `${reviewSetId.slice(0, 8)}…` : "NONE"}</div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 border border-border bg-muted/15 p-3" data-testid="shadow-replay-controls">
        <label className="block text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">
          Starting balance
          <div className="relative mt-1.5"><span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 mono text-xs text-muted-foreground">$</span><input className="field mono pl-6" type="number" min="0.01" step="0.01" value={startingBalance} onChange={(event) => setStartingBalance(event.target.value)} aria-label="Starting balance" data-testid="input-shadow-starting-balance" /></div>
        </label>
        <label className="block text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">
          Contracts per trade
           <input className="field mono mt-1.5" type="number" min="2" max="100" step="1" value={contractsPerTrade} onChange={(event) => setContractsPerTrade(event.target.value)} aria-label="Contracts per trade (minimum 2)" data-testid="input-shadow-contracts-per-trade" />
        </label>
        <button type="button" disabled={generationActive} onClick={onRegenerateFresh} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-accent/55 bg-accent/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[.06em] text-foreground transition hover:bg-accent/20 disabled:cursor-wait disabled:opacity-50" data-testid="button-shadow-regenerate-fresh"><RotateCcw size={14} />Regenerate fresh</button>
      </div>
      {replay?.stale && <div className="mt-3 flex flex-col gap-2 border border-accent/55 bg-accent/10 px-3 py-3 text-xs sm:flex-row sm:items-center sm:justify-between" role="alert" data-testid="shadow-replay-stale">
        <div className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-accent" /><span><strong>Replay is stale.</strong> Its source or execution projection changed. Use <span className="font-bold text-foreground">Regenerate fresh</span> to rebuild the selected review set before relying on these account outcomes.</span></div>
        <button type="button" disabled={generationActive} onClick={onRegenerateFresh} className="shrink-0 self-start border border-accent/55 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.08em] hover:bg-accent/15 disabled:cursor-wait disabled:opacity-50 sm:self-auto" data-testid="button-shadow-stale-regenerate">Regenerate fresh</button>
       </div>}
      <div className="mt-4">{stateContent()}</div>
     </div>}
  </Panel></div>;
}

function ShadowReplayResults({ replay, metric }: { replay: ShadowAccountReplay; metric: (label: string, value: string, detail?: string, tone?: string) => ReactNode }) {
  return <div className="space-y-4" data-testid="shadow-replay-results">
    <div className="border border-border bg-muted/12 px-4 py-4" data-testid="shadow-replay-date-scope">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow text-muted-foreground">Replay scope / complete set</div>
          <div className="mt-1 text-xs font-bold">Processed dates</div>
        </div>
        <div className="mono text-[10px] text-muted-foreground">{replay.processedDates.length} total · {replay.datesWithTrades.length} with trades · {replay.datesWithoutTrades.length} without trades</div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {replay.processedDates.map((date) => <span key={date} className={`border px-2 py-1 mono text-[10px] ${replay.datesWithTrades.includes(date) ? "border-[hsl(var(--positive)/.35)] bg-[hsl(var(--positive)/.08)] text-foreground" : "border-border text-muted-foreground"}`}>{date}{replay.datesWithTrades.includes(date) ? " · trade" : " · none"}</span>)}
      </div>
    </div>
    <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
      {metric("Ending realized balance", formatAccountMoney(replay.endingRealizedBalance), `Started at ${formatAccountMoney(replay.startingBalance)}`)}
      {metric("Realized net P/L", formatAccountMoney(replay.realizedNetPnl), formatAccountPercent(replay.percentReturn), replay.realizedNetPnl < 0 ? "status-negative" : "status-positive")}
      {metric("Return", formatAccountPercent(replay.percentReturn), "Fixed sizing · no compounding", replay.percentReturn < 0 ? "status-negative" : "status-positive")}
      {metric("Max drawdown", formatAccountMoney(replay.maxDrawdown), "Realized balance peak to trough", replay.maxDrawdown > 0 ? "status-negative" : undefined)}
    </div>
    <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
      {metric("Candidate trades", formatAccountNumber(replay.candidateTrades, 0), "Retained in the selected set")}
      {metric("Entered trades", formatAccountNumber(replay.enteredTrades, 0), `${replay.closedTrades} closed · ${replay.openTrades} open · ${replay.unscoredTrades} unscored`)}
      {metric("Wins / losses", `${replay.wins} / ${replay.losses}`, `${replay.openTrades} open · ${replay.unscoredTrades} unscored`)}
      {metric("Win rate", `${replay.winRate.toFixed(2)}%`, "Closed trade basis")}
      {metric("Average win", formatAccountMoney(replay.averageWin), "Per winning trade", "status-positive")}
      {metric("Average loss", formatAccountMoney(replay.averageLoss), "Per losing trade", "status-negative")}
      {metric("Profit factor", replay.profitFactor === null ? "—" : formatAccountNumber(replay.profitFactor, 2), "Gross wins ÷ gross losses")}
      {metric("Expectancy / trade", formatAccountMoney(replay.expectancyPerTrade), "Net expected value")}
      {metric("Max consecutive wins", formatAccountNumber(replay.maxConsecutiveWins, 0), "Closed sequence")}
      {metric("Max consecutive losses", formatAccountNumber(replay.maxConsecutiveLosses, 0), "Closed sequence")}
      {metric("Best trade", replay.bestTrade ? formatAccountMoney(replay.bestTrade.netPnl ?? 0) : "—", replay.bestTrade?.tradingDate ?? "No closed trades", "status-positive")}
      {metric("Worst trade", replay.worstTrade ? formatAccountMoney(replay.worstTrade.netPnl ?? 0) : "—", replay.worstTrade?.tradingDate ?? "No closed trades", replay.worstTrade ? "status-negative" : undefined)}
    </div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,.7fr)]">
      <ShadowEquityCurve replay={replay} />
      <ShadowSegmentSummary replay={replay} />
    </div>
    <div className="grid gap-4 xl:grid-cols-3" data-testid="shadow-replay-breakdowns">
      <ShadowBreakdownTable title="Daily breakdown" rows={replay.byDate} valueLabel="Trading date" />
      <ShadowBreakdownTable title="Primary edge breakdown" rows={replay.byPrimaryEdge} valueLabel="Primary edge" />
      <ShadowBreakdownTable title="Direction breakdown" rows={replay.byDirection} valueLabel="Direction" />
    </div>
    <ShadowLedger replay={replay} />
  </div>;
}

function ShadowBreakdownTable({
  title,
  rows,
  valueLabel,
}: {
  title: string;
  rows: ShadowAccountReplay["byDate"];
  valueLabel: string;
}) {
  return <div className="border border-border bg-muted/12">
    <div className="border-b border-border px-4 py-3">
      <div className="eyebrow text-muted-foreground">Reconciliation</div>
      <div className="mt-1 text-xs font-bold">{title}</div>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[360px] border-collapse text-left text-[10px]">
        <thead className="bg-muted/35 mono text-[9px] uppercase tracking-[.07em] text-muted-foreground"><tr>{[valueLabel, "Entered", "Closed", "Net P/L", "W / L"].map((heading) => <th key={heading} className="whitespace-nowrap border-b border-border px-3 py-2 font-medium">{heading}</th>)}</tr></thead>
        <tbody>
          {rows.length ? rows.map((row) => <tr key={row.value} className="border-b border-border/70 last:border-b-0">
            <td className="max-w-[180px] truncate px-3 py-2.5 font-semibold" title={row.value}>{valueLabel === "Primary edge" ? edgeDisplayLabel(row.value) : row.value}</td>
            <td className="mono px-3 py-2.5">{row.enteredTrades}</td>
            <td className="mono px-3 py-2.5">{row.closedTrades}</td>
            <td className={`mono px-3 py-2.5 font-bold ${row.netPnl < 0 ? "status-negative" : "status-positive"}`}>{formatAccountMoney(row.netPnl)}</td>
            <td className="mono px-3 py-2.5">{row.wins} / {row.losses}</td>
          </tr>) : <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">No entered trades.</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

function ShadowEquityCurve({ replay }: { replay: ShadowAccountReplay }) {
  const curve = replay.equityCurve;
  const width = 760;
  const height = 220;
  const pad = { top: 18, right: 18, bottom: 30, left: 56 };
  const values = [replay.startingBalance, ...curve.map((item) => item.balance)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const x = (index: number) => pad.left + (index / Math.max(curve.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + ((max - value) / range) * (height - pad.top - pad.bottom);
  const points = curve.map((item, index) => `${x(index)} ${y(item.balance)}`).join(" ");
  return <div className="border border-border bg-muted/12" data-testid="shadow-equity-curve">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div><div className="eyebrow text-muted-foreground">Balance path</div><div className="mt-1 text-xs font-bold">Realized equity curve</div></div>
      <div className="flex flex-wrap gap-3 mono text-[9px] text-muted-foreground"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[hsl(var(--positive))]" />Win</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[hsl(var(--negative))]" />Loss</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-muted-foreground" />Open</span></div>
    </div>
    <div className="overflow-x-auto px-2 py-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[220px] min-w-[560px] w-full" role="img" aria-label="Shadow account realized equity curve">
        {[0, .5, 1].map((step) => { const value = max - range * step; const yPosition = y(value); return <g key={step}><line x1={pad.left} x2={width - pad.right} y1={yPosition} y2={yPosition} stroke="hsl(var(--border))" strokeDasharray="3 5" /><text x={pad.left - 8} y={yPosition + 3} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">{formatAccountMoney(value)}</text></g>; })}
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="hsl(var(--border))" />
        {curve.length > 1 && <polyline points={points} fill="none" stroke="hsl(var(--foreground) / .7)" strokeWidth="2" strokeLinejoin="round" />}
         {curve.map((item, index) => {
           if (item.status === "start") return <circle key={`${item.tradeNumber}-${item.entryTime}`} cx={x(index)} cy={y(item.balance)} r="3" fill="hsl(var(--muted-foreground))" stroke="hsl(var(--card))" strokeWidth="2"><title>{`Starting balance: ${formatAccountMoney(item.balance)}`}</title></circle>;
           const fill = item.status === "win" ? "hsl(var(--positive))" : item.status === "loss" ? "hsl(var(--negative))" : "hsl(var(--muted-foreground))";
           return <circle key={`${item.tradeNumber}-${item.entryTime}`} cx={x(index)} cy={y(item.balance)} r="4" fill={fill} stroke="hsl(var(--card))" strokeWidth="2"><title>{`Trade ${item.tradeNumber}: ${formatAccountMoney(item.balance)}`}</title></circle>;
        })}
         {curve.length > 0 && <><text x={pad.left} y={height - 9} fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">START</text><text x={width - pad.right} y={height - 9} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">T{curve[curve.length - 1].tradeNumber}</text></>}
      </svg>
    </div>
  </div>;
}

function ShadowSegmentSummary({ replay }: { replay: ShadowAccountReplay }) {
  const segments = [{ label: "In-sample", value: replay.inSample }, { label: "Out-of-sample", value: replay.outOfSample }];
  return <div className="border border-border bg-muted/12" data-testid="shadow-segment-summary">
    <div className="border-b border-border px-4 py-3"><div className="eyebrow text-muted-foreground">Period split</div><div className="mt-1 text-xs font-bold">Sample performance</div></div>
    <div className="divide-y divide-border">
      {segments.map(({ label, value }) => <div key={label} className="p-4">
        <div className="flex items-center justify-between gap-3"><span className="text-xs font-bold">{label}</span><span className="mono text-[10px] text-muted-foreground">{value.enteredTrades} entered</span></div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
          <div><span className="block text-muted-foreground">Net P/L</span><strong className={`mono ${value.netPnl < 0 ? "status-negative" : "status-positive"}`}>{formatAccountMoney(value.netPnl)}</strong></div>
          <div><span className="block text-muted-foreground">Win rate</span><strong className="mono">{value.winRate.toFixed(2)}%</strong></div>
          <div><span className="block text-muted-foreground">Wins / losses</span><strong className="mono">{value.wins} / {value.losses}</strong></div>
           <div><span className="block text-muted-foreground">Open / unscored</span><strong className="mono">{value.openTrades} / {value.unscoredTrades}</strong></div>
          <div><span className="block text-muted-foreground">Expectancy</span><strong className="mono">{formatAccountMoney(value.expectancyPerTrade)}</strong></div>
        </div>
      </div>)}
    </div>
  </div>;
}

function ShadowLedger({ replay }: { replay: ShadowAccountReplay }) {
  return <div className="border border-border" data-testid="shadow-trade-ledger">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"><div><div className="eyebrow text-muted-foreground">Audit trail / fixed sizing</div><div className="mt-1 text-xs font-bold">Trade ledger</div></div><div className="mono text-[10px] text-muted-foreground">{replay.ledger.length} rows · {replay.startingBalance.toLocaleString("en-US", { style: "currency", currency: "USD" })} start</div></div>
    <div className="overflow-x-auto">
        <table className="w-full min-w-[1640px] border-collapse text-left text-[10px]">
        <thead className="bg-muted/35 mono text-[9px] uppercase tracking-[.07em] text-muted-foreground"><tr>{["Trade", "Trading date", "Entry ET", "Exit ET", "Candidate / occurrence", "Contract", "Contracts", "Edge / strategy", "Dir", "Entry", "Exit", "Gross P/L", "Fees", "Slippage", "Exit reason", "Net P/L", "Balance", "Confluences", "Period", "Status"].map((heading) => <th key={heading} className="whitespace-nowrap border-b border-border px-3 py-2.5 font-medium">{heading}</th>)}</tr></thead>
        <tbody>
          {replay.ledger.map((trade) => <tr key={`${trade.tradeNumber}-${trade.candidateId}`} className="border-b border-border/70 last:border-b-0 hover:bg-muted/20">
            <td className="mono px-3 py-2.5 font-bold">{trade.tradeNumber}</td>
            <td className="mono whitespace-nowrap px-3 py-2.5 text-muted-foreground">{trade.tradingDate}</td>
            <td className="mono whitespace-nowrap px-3 py-2.5 text-muted-foreground">{formatReplayTime(trade.entryTime)}</td>
            <td className="mono whitespace-nowrap px-3 py-2.5 text-muted-foreground">{trade.exitTime ? formatReplayTime(trade.exitTime) : "—"}</td>
            <td className="max-w-[190px] truncate px-3 py-2.5 mono text-[9px]" title={`${trade.candidateId} · ${trade.signalOccurrenceId}`}>{trade.candidateId}<br /><span className="text-muted-foreground">{trade.signalOccurrenceId}</span></td>
            <td className="px-3 py-2.5 font-bold">{trade.contractSymbol}</td>
            <td className="mono px-3 py-2.5">{trade.contracts}</td>
            <td className="max-w-[190px] truncate px-3 py-2.5" title={trade.primaryEdge}>{edgeDisplayLabel(trade.primaryEdge)}</td>
            <td className="px-3 py-2.5 font-bold uppercase">{trade.direction}</td>
            <td className="mono px-3 py-2.5">{formatAccountNumber(trade.entryPrice, 2)}</td>
            <td className="mono px-3 py-2.5">{trade.exitPrice === null ? "—" : formatAccountNumber(trade.exitPrice, 2)}</td>
            <td className="mono px-3 py-2.5">{trade.grossPnl === null ? "—" : formatAccountMoney(trade.grossPnl)}</td>
            <td className="mono px-3 py-2.5">{trade.fees === null ? "—" : formatAccountMoney(trade.fees)}</td>
            <td className="mono px-3 py-2.5">{trade.slippage === null ? "—" : formatAccountMoney(trade.slippage)}</td>
             <td className="max-w-[150px] truncate px-3 py-2.5 text-muted-foreground" title={trade.exitReason}>{trade.exitReason}</td>
            <td className={`mono px-3 py-2.5 font-bold ${trade.netPnl === null ? "text-muted-foreground" : trade.netPnl < 0 ? "status-negative" : "status-positive"}`}>{trade.netPnl === null ? "—" : formatAccountMoney(trade.netPnl)}</td>
            <td className="mono px-3 py-2.5 font-bold">{formatAccountMoney(trade.runningBalance)}</td>
             <td className="max-w-[180px] truncate px-3 py-2.5 text-muted-foreground" title={trade.supportingConfluences.join(", ")}>{trade.supportingConfluences.length ? trade.supportingConfluences.join(", ") : "—"}</td>
            <td className="px-3 py-2.5 text-muted-foreground">{trade.period === "in_sample" ? "In-sample" : "Out-of-sample"}</td>
             <td className="px-3 py-2.5"><span className={`inline-flex border px-1.5 py-1 text-[9px] font-bold uppercase ${trade.status === "open" || trade.status === "unscored" ? "border-border text-muted-foreground" : trade.netPnl !== null && trade.netPnl < 0 ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-[hsl(var(--positive)/.3)] bg-[hsl(var(--positive)/.1)] text-[hsl(var(--positive))]"}`}>{trade.status}</span></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>;
}

function FunnelDiagnostics({ data }: { data: NonNullable<VisualValidationSet["funnelDiagnostics"]> }) {
  const hiddenStageKeys = new Set([
    "session_loaded",
    "critical_level_interaction",
    "modeled_entry",
    "final_exit",
  ]);
  return <Panel>
    <PanelTitle eyebrow="Detection funnel / every causal occurrence" title="Where evidence was retained" right={<span className="mono text-[10px] text-muted-foreground">{data.occurrenceCount} ledger occurrences · {data.sessionCount} sessions</span>} />
    <div className="grid gap-px border-t border-border bg-border" data-testid="window-diagnostics">
      <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Trades taken</div><div className="display mt-1 text-xl font-bold">{data.window.riskApprovedEntries}</div><div className="mono mt-1 text-[10px] text-muted-foreground">{data.window.qualifyingPullbacks} qualifying pullbacks</div></div>
    </div>
    <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-4" data-testid="detection-funnel">
      {data.stages.filter((stage) => !hiddenStageKeys.has(stage.stage)).map((stage) => <div key={stage.stage} className="bg-card px-4 py-3">
        <div className="text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">{stage.stage.replaceAll("_", " ")}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="display text-2xl font-bold">{stage.count}</span><span className="mono text-[10px] text-muted-foreground">{stage.percentOfPreceding}% of prior candidates</span><span className="mono text-[10px] text-muted-foreground">{stage.percentOfSessions}% of sessions</span></div>
      </div>)}
    </div>
    {data.rejectionCounts.length > 0 && <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
      <span className="font-semibold text-foreground">Recorded rejection gates:</span>{" "}
       {data.rejectionCounts.map((item) => `${item.stage.replaceAll("_", " ")} (${item.count})`).join(" · ")}
       </div>}
  </Panel>;
}

function ReviewSetProvenance({ data }: { data: VisualValidationSet }) {
  const abbreviatedKey = `${data.cacheKey.slice(0, 10)}…${data.cacheKey.slice(-8)}`;
  return <Panel>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
      <div>
        <div className="eyebrow text-muted-foreground">Replay provenance</div>
        <div className="mt-1 text-xs font-semibold">{data.generationOrigin === "cached" ? "Cached compatible result" : "Freshly generated result"}</div>
      </div>
      <div className="mono text-right text-[10px] text-muted-foreground">
        <div>Generated {formatReviewTime(data.createdAt)}</div>
        <div>Cache {abbreviatedKey}</div>
      </div>
    </div>
    <div className="grid gap-px bg-border sm:grid-cols-3">
      <div className="bg-card px-5 py-3"><div className="eyebrow text-muted-foreground">Formula</div><div className="mono mt-1 text-[10px]">{data.formulaVersion}</div></div>
      <div className="bg-card px-5 py-3"><div className="eyebrow text-muted-foreground">Strategy engine</div><div className="mono mt-1 text-[10px]">{data.strategyVersion}</div></div>
      <div className="bg-card px-5 py-3"><div className="eyebrow text-muted-foreground">Snapshot projection</div><div className="mono mt-1 text-[10px]">{data.snapshotProjectionVersion}</div></div>
    </div>
  </Panel>;
}

function GenerationPanel({ request, setRequest, onSubmit, onRegenerateFresh, pending, message }: { request: VisualValidationRequest; setRequest: (next: VisualValidationRequest) => void; onSubmit: (event: FormEvent) => void; onRegenerateFresh: () => void; pending: boolean; message: string }) {
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
       <div className="grid gap-2 sm:grid-cols-2">
       <button type="submit" disabled={pending} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:cursor-wait disabled:opacity-55" data-testid="button-generate-visual-set">
          {pending ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}{pending ? "Generating trade candidates..." : "Generate trade candidates"}
      </button>
       <button type="button" disabled={pending} onClick={onRegenerateFresh} className="flex w-full items-center justify-center gap-2 rounded-md border border-accent/55 bg-accent/10 px-4 py-3 text-xs font-bold text-foreground transition hover:bg-accent/15 disabled:cursor-wait disabled:opacity-55" data-testid="button-regenerate-fresh">
         <RotateCcw size={15} />Regenerate fresh
       </button>
       </div>
       <LockedNote>{request.source === "historical_databento" ? "Historical mode reads the existing indexed MES contract candles only. It never rebuilds the index, connects to a broker, creates orders, or produces live execution." : "Generation replays deterministic data only. No broker connection, order creation, or live execution path exists here."}</LockedNote>
    </form>
  </Panel>;
}

function CoverageRail({ data, loading, selectedStrategyKey, selectedCategory, selectedSnapshot, selectedSnapshotIndex, selectedSnapshotTotal, onSelectStrategy, onSelectSnapshot, onPrevious, onNext, generationJob, onRetryGeneration }: { data?: VisualValidationSet | null; loading: boolean; selectedStrategyKey: StrategyId | null; selectedCategory: VisualValidationCategory | null; selectedSnapshot?: VisualValidationSnapshot; selectedSnapshotIndex: number; selectedSnapshotTotal: number; onSelectStrategy: (key: StrategyId | null) => void; onSelectSnapshot: (snapshotId: string) => void; onPrevious: () => void; onNext: () => void; generationJob: VisualValidationGenerationJob | null; onRetryGeneration: () => void }) {
  if (loading && !data) return <Panel><QuerySkeleton rows={5} /></Panel>;
  if (!data) {
    if (generationJob) return <GenerationProgressPanel job={generationJob} onRetry={onRetryGeneration} />;
    return <Panel><div className="flex min-h-[300px] items-center justify-center p-6 text-sm text-muted-foreground">Generate a set to open the review room.</div></Panel>;
  }
  const candidates = selectedStrategyKey
    ? data.tradeCandidates.filter((candidate) => candidate.primaryEdge === canonicalEdgeForStrategy(selectedStrategyKey) || candidate.matchedEdges.includes(canonicalEdgeForStrategy(selectedStrategyKey)))
    : data.tradeCandidates;
  const edgeCount = (strategy: StrategyId) => data.tradeCandidates.filter((candidate) => candidate.primaryEdge === canonicalEdgeForStrategy(strategy) || candidate.matchedEdges.includes(canonicalEdgeForStrategy(strategy))).length;
  return <Panel>
     <PanelTitle eyebrow="Coverage / Trade Candidates" title="Select a trade candidate" right={<span className="mono text-right text-[10px] text-muted-foreground" data-testid="review-period">Review period · {data.reviewPeriod.startDate} – {data.reviewPeriod.endDate}</span>} />
    <div className="flex flex-wrap gap-1 border-t border-border bg-muted/20 p-2" role="tablist" aria-label="Strategy review tabs">
       <button type="button" onClick={() => onSelectStrategy(null)} className={`rounded-sm px-3 py-2 text-[10px] font-bold uppercase ${selectedStrategyKey === null ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`} aria-selected={selectedStrategyKey === null} role="tab">All edges · {data.snapshots.filter((snapshot) => snapshot.category === "qualified_trade").length}</button>
      {STRATEGY_TABS.map((strategy) => {
         const count = edgeCount(strategy.id);
         return <button type="button" key={strategy.id} onClick={() => onSelectStrategy(strategy.id)} className={`rounded-sm px-3 py-2 text-[10px] font-bold uppercase ${selectedStrategyKey === strategy.id ? "bg-primary text-primary-foreground" : count ? "text-muted-foreground hover:bg-muted" : "cursor-not-allowed text-muted-foreground/50"}`} aria-selected={selectedStrategyKey === strategy.id} role="tab" disabled={!count}>{strategy.label} · {count}</button>;
      })}
    </div>
     <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2">
       {candidates.map((candidate) => {
         const snapshot = data.snapshots.find((item) => item.snapshotId === candidate.snapshotId);
         if (!snapshot) return null;
         const trade = snapshot.machineEvidence.trade as CandidateTradeView | null;
         const audit = snapshot.machineEvidence.audit as CandidateAuditView;
         const direction = candidate.direction === "short" ? "Short" : "Long";
         return <button type="button" key={candidate.candidateId} onClick={() => onSelectSnapshot(candidate.snapshotId)} className={`bg-card p-4 text-left transition hover:bg-muted/55 ${selectedSnapshot?.snapshotId === candidate.snapshotId ? "ring-1 ring-inset ring-accent" : ""}`} data-testid="button-trade-candidate">
           <div className="flex items-start justify-between gap-3"><div><div className="eyebrow text-muted-foreground">Trade candidate</div><div className="mt-1 text-sm font-bold">{candidate.tradingDate} · {candidate.contractSymbol}</div></div><span className="border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] font-bold">{direction}</span></div>
           <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]"><div><span className="text-muted-foreground">Entry</span><div className="mono mt-1">{safeValue(candidate.entryTriggerPrice ?? audit.entryTriggerPrice)}</div></div><div><span className="text-muted-foreground">Grade</span><div className="mono mt-1">{candidate.setupGrade}</div></div><div><span className="text-muted-foreground">Primary edge</span><div className="mt-1 font-semibold">{edgeDisplayLabel(candidate.primaryEdge)}</div></div><div><span className="text-muted-foreground">Matched edges</span><div className="mt-1">{candidate.matchedEdges.length} · {candidate.supportingConfluences.length} confluences</div></div></div>
           <div className="mt-3 mono text-[10px] text-muted-foreground">{candidate.period === "in_sample" ? "In-sample" : "Holdout"} · Entry {formatReviewTime(candidate.entryCandleOpenTime)}</div>
         </button>;
       })}
    </div>
     {selectedSnapshot && <SnapshotHeaderContent snapshot={selectedSnapshot} request={data.request} index={selectedSnapshotIndex} total={selectedSnapshotTotal} onPrevious={onPrevious} onNext={onNext} />}
  </Panel>;
}

const GENERATION_PHASE_ANNOUNCEMENTS: Record<VisualValidationGenerationJob["phase"], string> = {
  preparing: "Preparing historical replay",
  loading_sessions: "Loading trading sessions",
  replaying_sessions: "Replaying historical sessions",
  building_ledger: "Finding confirmed P to E signals",
  projecting_candidates: "Checking key-level pullbacks",
  building_snapshots: "Building chart review snapshots",
  completed: "Trade candidates ready",
};

function GenerationProgressPanel({ job, onRetry }: { job: VisualValidationGenerationJob; onRetry: () => void }) {
  const active = job.status === "queued" || job.status === "running";
  const percent = Math.max(0, Math.min(100, Math.round(job.percent)));
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  const estimate = formatEstimate(job.estimatedRemainingMs);
  return <Panel accent>
    <div className="flex min-h-[360px] flex-col items-center justify-center px-6 py-10 text-center sm:px-8" data-testid="visual-generation-progress-panel">
      <div
        className="relative h-44 w-44"
        role="progressbar"
        aria-label="Historical trade-candidate generation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <svg className="h-full w-full -rotate-90" viewBox="0 0 160 160" aria-hidden="true">
          <circle cx="80" cy="80" r={radius} fill="none" stroke="hsl(var(--muted))" strokeWidth="9" />
          <circle cx="80" cy="80" r={radius} fill="none" stroke="#4169E1" strokeWidth="9" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} className="transition-[stroke-dashoffset] duration-500 ease-out" />
          {active && <circle cx="80" cy="80" r={radius} fill="none" stroke="#4169E1" strokeWidth="3" strokeLinecap="round" strokeDasharray="30 360" className="origin-center animate-spin motion-reduce:animate-none" />}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {job.status === "completed" ? <Check size={30} className="text-[#4169E1]" aria-label="Complete" /> : <span className="display text-3xl font-bold tracking-tight">{percent}%</span>}
        </div>
      </div>
      <div className="mt-6 min-h-[72px]">
        <div className="text-sm font-bold">{job.status === "completed" ? "Trade candidates ready" : job.message}</div>
        <div className="mt-2 text-xs text-muted-foreground">{job.completedSessions} of {job.totalSessions} sessions completed</div>
        <div className="mt-1 mono text-[10px] text-muted-foreground">Elapsed: {formatDuration(job.elapsedMs)}</div>
        {estimate && active && <div className="mt-1 mono text-[10px] text-muted-foreground">{estimate}</div>}
      </div>
      <div className="sr-only" aria-live="polite">{GENERATION_PHASE_ANNOUNCEMENTS[job.phase]}</div>
      {job.status === "failed" && <div className="mt-5 w-full max-w-md border border-destructive/30 bg-destructive/10 p-3 text-left text-xs text-destructive" role="alert">
        <div className="font-bold">Generation failed</div>
        <div className="mt-1 break-words">{job.error ?? "The historical replay could not be completed."}</div>
        <button type="button" onClick={onRetry} className="mt-3 rounded-md bg-primary px-3 py-2 text-[10px] font-bold text-primary-foreground hover:opacity-90" data-testid="button-retry-visual-generation">Retry generation</button>
      </div>}
      {active && <p className="mt-5 max-w-sm text-[10px] leading-4 text-muted-foreground">You may leave this page open. Refreshing will resume this generation job.</p>}
    </div>
  </Panel>;
}

function ReviewSetDiagnostics({ data }: { data: VisualValidationSet }) {
  const prefix = (value: string) => value.slice(0, 12);
  const stale = data.stale || data.currentBuildId !== FRONTEND_BUILD_ID;
  return <div className="mb-5 grid gap-px border border-border bg-border text-[10px] sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-7" data-testid="review-set-diagnostics">
    <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Build</div><div className="mono mt-1 break-all text-foreground" title={data.buildId}>{data.buildId}</div></div>
    <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Formula</div><div className="mono mt-1 text-foreground" title={data.formulaHash}>{data.formulaVersion} · {prefix(data.formulaHash)}…</div></div>
    <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Source fingerprint</div><div className="mono mt-1 text-foreground" title={data.sourceFingerprint}>{prefix(data.sourceFingerprint)}…</div></div>
    <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Created</div><div className="mono mt-1 text-foreground">{formatReviewTime(data.createdAt)}</div></div>
    <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Review set</div><div className="mono mt-1 text-foreground" title={data.reviewSetId}>{prefix(data.reviewSetId)}…</div></div>
    <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Freshness</div><div className={`mt-1 font-bold ${stale ? "text-destructive" : "text-[hsl(var(--positive))]"}`}>{stale ? "stale" : "current"}</div><div className="mono mt-1 break-all text-muted-foreground" title={data.currentBuildId}>current {prefix(data.currentBuildId)}…</div></div>
    <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Default selection</div><div className="mt-1 leading-4 text-foreground">{data.defaultSelectionReason}</div></div>
  </div>;
}

function SnapshotHeaderContent({ snapshot, request, index, total, onPrevious, onNext }: { snapshot: VisualValidationSnapshot; request: VisualValidationRequest; index: number; total: number; onPrevious: () => void; onNext: () => void }) {
  return <div className="border-t border-border bg-muted/20" data-testid="formula-development-sample">
    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="min-w-0">
        <div className="eyebrow mb-2 text-muted-foreground">Example {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")} · {snapshot.period === "in_sample" ? "formula-development sample" : "holdout sample"} <InfoTip label="Dataset role" text="Formula-development examples are in-sample. Holdout examples are out-of-sample and are not used to tune the rule." /></div>
         <div className="flex flex-wrap items-center gap-2"><h2 className="display text-2xl font-bold tracking-[-.045em]">Trade candidate</h2><span className="border border-accent/45 bg-accent/10 px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em]">{STRATEGY_TABS.find((item) => item.id === ((snapshot.machineEvidence.trade as CandidateTradeView | null)?.primaryEdge ?? snapshot.strategyKey))?.label ?? snapshot.machineLabel}</span></div>
         <p className="mt-2 text-xs text-muted-foreground"><span className="font-semibold text-foreground">Example date</span> <span className="mono">{snapshot.tradingDate}</span> · <span className="font-semibold text-foreground">Contract</span> <span className="mono">{snapshot.contractSymbol}</span> · <span className={`font-semibold ${snapshot.entryWindow === "primary" ? "text-[hsl(var(--positive))]" : "text-muted-foreground"}`}>{snapshot.entryWindow === "primary" ? "Primary window" : "Outside primary window"}</span> · Formula evidence is machine-owned</p>
         <p className="mt-2 max-w-3xl text-[11px] leading-4 text-muted-foreground">{snapshot.selectionReason}</p>
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
    ? "Primary trade window · 9:30 AM–1:00 PM ET"
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
         <span className="inline-flex items-center gap-1.5" data-testid="marker-legend-consolidation"><i className="h-3 w-4 border border-red-400 bg-red-200/70" />consolidation zone (when present)</span>
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
  crosshairPrice,
}: {
  inspection: CandleInspection | null;
  selectedSlot: number | null;
  activeCandle: SessionCandle | null;
  onLockCandle: (candle: SessionCandle | null) => void;
  crosshairPrice: number | null;
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
      <div className="inspector-meta mt-3 border-t border-border pt-2 text-[9px] text-muted-foreground">
        <span>Crosshair price · </span><strong className="mono text-foreground">{crosshairPrice == null ? "Move across price plot" : formatPriceAxisValue(crosshairPrice)}</strong>
        <span className="ml-3">Nearest candle OHLCV · X position only</span>
      </div>
      {inspection ? <div className="inspector-ohlcv mt-3" data-testid="candle-inspector-ohlcv">
        {([["Open", inspection.open], ["High", inspection.high], ["Low", inspection.low], ["Close", inspection.close], ["Volume", formatExactVolume(inspection.volume)]] as const).map(([label, value]) => <div key={label} className="inspector-metric"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-1 text-[11px] font-bold">{typeof value === "number" ? value.toFixed(2) : value}</div></div>)}
      </div> : <p className="mt-3 border border-accent/25 bg-accent/5 px-3 py-2 text-[10px] leading-4 text-muted-foreground">No historical candle available for this fixed timestamp slot. The gap is preserved; no neighboring candle was substituted.</p>}
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
  const [pointerPosition, setPointerPosition] = useState<ReturnType<typeof resolveChartPointerFromClientPoint>>(null);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [activeLevelId, setActiveLevelId] = useState<string | null>(null);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const legendRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<SVGSVGElement>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  useEffect(() => {
    const focusedIndex = findCandleIndexAtTimestamp(candles, focusOpenTime);
    setSelectedSlot(focusedIndex >= 0 ? getCandleSlotIndex(candles[focusedIndex]!, sessionView) : null);
    setHoveredSlot(null);
    setPointerPosition(null);
    setActiveLevelId(null);
    setSelectedLevelId(null);
    setZoom(1);
    setPan(0);
    const timer = window.setTimeout(() => interactionRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [candles.length, focusOpenTime, sessionView, premarketCandles.length]);
  useEffect(() => () => {
    if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current);
  }, []);
  useEffect(() => {
    const clearPinnedLevelOutsideLegend = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-legend-level-button]")) return;
      setActiveLevelId(null);
      setSelectedLevelId(null);
    };
    document.addEventListener("pointerdown", clearPinnedLevelOutsideLegend);
    return () => document.removeEventListener("pointerdown", clearPinnedLevelOutsideLegend);
  }, []);
  if (!candles.length) return <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">No causal candles were returned for this snapshot.</div>;
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const left = CHART_LEFT;
  // The former right-side label rail consumed plot width. Price values remain
  // on the axis; names and exact values now live in the wrapping legend.
  const right = 34;
  const top = CHART_TOP;
  const plotBottom = CHART_PLOT_BOTTOM;
  const volumeTop = CHART_VOLUME_TOP;
  const plotWidth = width - left - right;
  const slotCount = getSessionDomainSlotCount(sessionView);
  const step = plotWidth / Math.max(slotCount, 1);
  const orbCandles = regularCandles.slice(0, 3);
  const orbCompleteAtEvaluation = isOpeningRangeCompleteAtEvaluation(regularCandles, snapshot.evaluationCursor.closeTime);
   const annotations = mergeOrbNtzAnnotations(snapshot.annotations.filter((annotation) => isVisualPresentationAnnotation(annotation) && annotation.available
     && (!["orb-high", "orb-low", "ntz-high", "ntz-low"].includes(annotation.id) || orbCompleteAtEvaluation)));
  const chartEvents = selectChartEvents(snapshot, candles, sessionView);
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
   const consolidationZones = (() => {
     const audit = typeof snapshot.machineEvidence.audit === "object" && snapshot.machineEvidence.audit !== null
       ? snapshot.machineEvidence.audit as Record<string, unknown>
       : null;
     const rawThresholds = typeof audit?.consolidationThresholds === "object" && audit.consolidationThresholds !== null
       ? audit.consolidationThresholds as Record<string, unknown>
       : null;
     const thresholds = rawThresholds
       && typeof rawThresholds.minCandles === "number"
       && typeof rawThresholds.maxRangeTicks === "number"
       && typeof rawThresholds.maxExpansionRatio === "number"
        && typeof rawThresholds.volatilityLookback === "number"
        && typeof rawThresholds.volatilityMultiplier === "number"
        && typeof rawThresholds.minOverlapRatio === "number"
        && typeof rawThresholds.minRejectionCount === "number"
        && typeof rawThresholds.maxDirectionalSequence === "number"
       ? {
         minCandles: rawThresholds.minCandles,
         maxRangeTicks: rawThresholds.maxRangeTicks,
         maxExpansionRatio: rawThresholds.maxExpansionRatio,
          volatilityLookback: rawThresholds.volatilityLookback,
          volatilityMultiplier: rawThresholds.volatilityMultiplier,
          minOverlapRatio: rawThresholds.minOverlapRatio,
          minRejectionCount: rawThresholds.minRejectionCount,
          maxDirectionalSequence: rawThresholds.maxDirectionalSequence,
       }
       : null;
     if (!thresholds) return [];
     return findConsolidationZones(candles, thresholds).flatMap((zone) => {
       const sourceSlots = zone.sourceCandleOpenTimes
         .map((openTime) => {
           const candleIndex = findCandleIndexAtTimestamp(candles, openTime);
           return candleIndex < 0 ? null : getCandleSlotIndex(candles[candleIndex]!, sessionView);
         })
         .filter((slot): slot is number => slot !== null && slot >= 0 && slot < slotCount);
       if (!sourceSlots.length) return [];
       const startSlot = Math.min(...sourceSlots);
       const endSlot = Math.min(slotCount, Math.max(...sourceSlots) + 1);
       const clippedLow = Math.max(domain.min, zone.low);
       const clippedHigh = Math.min(domain.max, zone.high);
       if (clippedLow >= clippedHigh || endSlot <= startSlot) return [];
       return [{
         x: left + startSlot * step,
         width: (endSlot - startSlot) * step,
         y: y(clippedHigh),
         height: Math.max(1, y(clippedLow) - y(clippedHigh)),
         zoneLow: zone.low,
         zoneHigh: zone.high,
         startSlot,
         endSlot,
         startTime: zone.startTime,
         endTime: zone.endTime,
         range: zone.range,
       }];
     });
   })();
    const fixedLevels = annotations.filter((annotation) =>
      isVisualPresentationAnnotation(annotation)
      && !isDynamicIndicatorAnnotation(annotation)
      && annotation.kind !== "candle"
      && annotation.price !== null,
    );
  const indicatorLegend = (["vwap", "ema-200"] as const)
    .map((id) => annotations.find((annotation) => annotation.id === id && isDynamicIndicatorAnnotation(annotation)))
    .filter((annotation): annotation is VisualValidationAnnotation => annotation !== undefined);
  const allLevels = [...fixedLevels, ...indicatorLegend];
  const entryReference = fixedLevels.find((annotation) => annotation.id === "entry-buffer")?.price ?? null;
   const primaryLevels = [
      ...fixedLevels.filter((annotation) => isPrimaryLevel(annotation)),
      ...indicatorLegend.filter((annotation) => isPrimaryLevel(annotation)),
    ];
   const additionalLevels = fixedLevels.filter((annotation) => !primaryLevels.some((primary) => primary.id === annotation.id));
  const edgeIndicators = getEdgeIndicators(primaryLevels, domain);
   const levelLegend = [...allLevels]
      .filter((annotation) => isDynamicIndicatorAnnotation(annotation) || (annotation.price != null && annotation.price >= domain.min && annotation.price <= domain.max))
     .sort((first, second) =>
       chartLevelOrder(first) - chartLevelOrder(second)
       || (first.price ?? 0) - (second.price ?? 0)
       || first.label.localeCompare(second.label),
     );
  const edgeCounts: Record<"top" | "bottom", number> = { top: 0, bottom: 0 };
   const activeSlot = hoveredSlot ?? selectedSlot;
   const activeIndicatorId = activeLevelId === "vwap" || activeLevelId === "ema-200"
     ? activeLevelId
     : selectedLevelId === "vwap" || selectedLevelId === "ema-200"
       ? selectedLevelId
       : null;
   const indicatorStyle = (id: "vwap" | "ema-200") => ({
     strokeWidth: activeIndicatorId === id ? 3 : 2,
     opacity: activeIndicatorId === null || activeIndicatorId === id ? 1 : .22,
   });
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
   const trade = snapshot.machineEvidence.trade as TradeEvidenceView | null;
   const entryEvent = snapshot.tradeEvents.find((event) => event.event === "entry_fill" || event.event === "entry");
   const entryOpenTime = entryEvent?.openTime ?? trade?.entryTime ?? null;
   const exitTime = trade?.exitTime ?? trade?.audit?.exitCandleCloseTime ?? null;
   const entryIndex = entryOpenTime ? findCandleIndexAtTimestamp(candles, entryOpenTime) : -1;
   const exitIndex = exitTime ? findCandleIndexAtTimestamp(candles, exitTime) : -1;
   const entryX = entryIndex >= 0 ? left + getCandleSlotIndex(candles[entryIndex]!, sessionView) * step + step / 2 : null;
   const exitX = exitIndex >= 0 ? left + getCandleSlotIndex(candles[exitIndex]!, sessionView) * step + step / 2 : null;
   const lifetimeEndX = exitX ?? plotRight;
   const entryPrice = trade?.entryPrice ?? snapshot.tradeEvents.find((event) => event.event === "entry_fill" || event.event === "fill")?.modeledPrice ?? null;
   const exitPrice = trade?.exitPrice ?? null;
   const tradeLegs = trade?.audit?.legs ?? [];
   const legOverlays = tradeLegs.map((leg, index) => {
     const legExitTime = leg.exitCandleCloseTime ?? leg.exitCandleOpenTime ?? exitTime;
     const legExitIndex = legExitTime ? findCandleIndexAtTimestamp(candles, legExitTime) : -1;
     return {
       leg,
       index,
       x: legExitIndex >= 0 ? left + getCandleSlotIndex(candles[legExitIndex]!, sessionView) * step + step / 2 : exitX,
     };
   });
  const resolvePointer = (clientX: number, clientY: number) => resolveChartPointerFromClientPoint(
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
      plotBottom,
      interactionRight: width - 5,
      slotCount,
      domain,
    },
  );
  const updateHoveredSlot = (clientX: number, clientY: number) => {
    const pointer = resolvePointer(clientX, clientY);
    setPointerPosition(pointer);
    setHoveredSlot(pointer?.slot ?? null);
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
    const pointer = resolvePointer(event.clientX, event.clientY);
    if (pointer !== null) {
      setSelectedSlot(pointer.slot);
      setHoveredSlot(pointer.slot);
      const selectedCandle = candles.find((candle) => getCandleSlotIndex(candle, sessionView) === pointer.slot);
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
    setPointerPosition(null);
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
   const focusedLevelId = activeLevelId ?? selectedLevelId;
   const focusedTradeExitKind = focusedLevelId === TRADE_TARGET_LEGEND_ID
     ? "target"
     : focusedLevelId === TRADE_RUNNER_LEGEND_ID
       ? "runner"
       : null;
   const focusLevel = (id: string) => setActiveLevelId(id);
   const selectLevel = (id: string) => {
      if (selectedLevelId === id) {
        setSelectedLevelId(null);
        setActiveLevelId(null);
      } else {
        setSelectedLevelId(id);
        setActiveLevelId(id);
      }
   };
   const handleLevelKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
     if (event.key === "Escape") {
       event.preventDefault();
       setActiveLevelId(null);
       setSelectedLevelId(null);
     } else if (event.key === "Enter" || event.key === " ") {
       event.preventDefault();
       selectLevel(id);
     }
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
       </div>
     </div>
        <section className="event-strip" aria-label="Causal event strip" data-testid="event-strip">
          <div className="event-strip-heading">
            <div>
              <div className="eyebrow text-muted-foreground">Causal events</div>
              <div className="mt-1 text-[11px] font-bold">{chartEvents.length ? "Select a numbered marker or event" : "No category events in this window"}</div>
            </div>
            <span className="mono shrink-0 text-[9px] text-muted-foreground">{chartEvents.length} category events</span>
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
         <CandleInspector inspection={activeDetails} selectedSlot={activeSlot} activeCandle={activeCandle} onLockCandle={onLockCandle} crosshairPrice={pointerPosition?.price ?? null} />
         <div ref={legendRef} className="mt-3 flex flex-wrap gap-1.5 border-y border-border py-2" data-testid="chart-level-legend" aria-label="Visible price-level legend">
          {levelLegend.map((annotation) => {
            const structural = ["previous-session-high", "previous-session-low", "two-sessions-high", "two-sessions-low"].includes(annotation.id);
             const selected = focusedLevelId === annotation.id;
             const exactPriceLabel = formatPriceAxisValue(annotation.price!);
             const valueLabel = annotation.rangeLow != null && annotation.rangeHigh != null
               ? `${formatPriceAxisValue(annotation.rangeLow)}–${formatPriceAxisValue(annotation.rangeHigh)}`
               : exactPriceLabel;
             return <button
               key={`legend-${annotation.id}`}
               type="button"
               className={`inline-flex items-center gap-1 border bg-card px-2 py-1 text-[9px] transition ${selected ? "border-accent bg-accent/10" : "border-border hover:bg-muted/50"}`}
               style={{ color: levelStroke(annotation), fontWeight: structural ? 700 : 500 }}
               onMouseEnter={() => focusLevel(annotation.id)}
               onMouseLeave={() => setActiveLevelId((current) => current === annotation.id ? null : current)}
               onFocus={() => focusLevel(annotation.id)}
               onBlur={() => setActiveLevelId((current) => current === annotation.id ? null : current)}
                onClick={() => selectLevel(annotation.id)}
               onKeyDown={(event) => handleLevelKeyDown(event, annotation.id)}
               aria-pressed={selected}
                aria-label={`${annotation.label}, ${valueLabel}. Press Enter or Space to keep highlighted; Escape clears selection.`}
                data-legend-level-button="true"
               data-testid={`legend-level-${annotation.id}`}
             >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
             <span>{annotation.label}</span>
             <span className="mono font-bold">{valueLabel}</span>
             </button>;
          })}
           {(["target", "runner"] as const)
             .filter((kind) => tradeLegs.some((leg) => leg.kind === kind))
             .map((kind) => {
               const id = kind === "target" ? TRADE_TARGET_LEGEND_ID : TRADE_RUNNER_LEGEND_ID;
                const label = kind === "target" ? "TARGET EXIT" : "RUNNER EXIT";
               const color = kind === "target" ? "hsl(var(--positive))" : "hsl(270 55% 48%)";
               const selected = focusedLevelId === id;
               return <button
                 key={id}
                 type="button"
                 className={`inline-flex items-center gap-1 border bg-card px-2 py-1 text-[9px] transition ${selected ? "border-accent bg-accent/10" : "border-border hover:bg-muted/50"}`}
                 style={{ color }}
                 onMouseEnter={() => focusLevel(id)}
                 onMouseLeave={() => setActiveLevelId((current) => current === id ? null : current)}
                 onFocus={() => focusLevel(id)}
                 onBlur={() => setActiveLevelId((current) => current === id ? null : current)}
                 onClick={() => selectLevel(id)}
                 onKeyDown={(event) => handleLevelKeyDown(event, id)}
                 aria-pressed={selected}
                 aria-label={`${label}. Press Enter or Space to keep highlighted; Escape clears selection.`}
                  data-legend-level-button="true"
                 data-testid={`legend-trade-${kind}-exit`}
               >
                 <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
                 <span>{label}</span>
               </button>;
             })}
        </div>
        <div className="chart-plot-shell mt-3">
          <svg ref={interactionRef} viewBox={`${pan} 0 ${width / zoom} ${height}`} className="visual-review-svg" preserveAspectRatio="xMidYMid meet" role="application" tabIndex={0} aria-label={`Causal annotated five-minute OHLCV chart for ${snapshot.categoryLabel}. ${sessionView === "primary" ? "Primary trade window from 9:30 AM to 1:00 PM ET." : "Full regular session from 9:30 AM to 4:00 PM ET."} Hover across the price plot or volume column to inspect the nearest candle and free-roaming crosshair price, or use the arrow keys to inspect an exact fixed five-minute slot. The right price gutter is not interactive.`} onPointerMove={handlePointerMove} onPointerLeave={() => { setPointerPosition(null); setHoveredSlot(null); }} onPointerDown={selectPointerSlot} onKeyDown={setIndexFromKeyboard}>
          <rect x={left} y={top} width={plotWidth} height={plotBottom - top} fill="transparent" pointerEvents="all" data-testid="chart-interaction-layer" />
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
         {consolidationZones.length > 0 && <g pointerEvents="none" data-testid="consolidation-zone-overlay">
           {consolidationZones.map((zone, index) => <g key={`${zone.startTime}-${zone.endTime}`} data-testid={`consolidation-zone-${index}`}>
             <title>{`Consolidation zone ${zone.zoneLow.toFixed(2)}–${zone.zoneHigh.toFixed(2)}, fixed from ${zone.startTime} through ${zone.endTime}; ${zone.range.toFixed(2)} point range.`}</title>
             <rect x={zone.x} y={zone.y} width={zone.width} height={zone.height} fill="#fecaca" fillOpacity=".28" stroke="#ef4444" strokeOpacity=".72" strokeWidth="1.4" strokeDasharray="6 4" data-testid={`consolidation-zone-band-${index}`} />
             {zone.width >= 42 && <text x={zone.x + 5} y={zone.y + 13} fill="#dc2626" fontSize="8.5" fontWeight="800" fontFamily="DM Mono">CONSOLIDATION</text>}
           </g>)}
         </g>}
          {trade && entryX !== null && entryPrice !== null && <g pointerEvents="none" data-testid="trade-lifetime-overlay">
            <line x1={entryX} x2={lifetimeEndX} y1={y(entryPrice)} y2={y(entryPrice)} stroke="hsl(var(--accent))" strokeWidth="2" strokeDasharray="5 3" />
            <circle cx={entryX} cy={y(entryPrice)} r="6" fill="hsl(var(--accent))" stroke="hsl(var(--card))" strokeWidth="2" data-testid="trade-entry-marker" />
            <text x={entryX} y={y(entryPrice) - 10} textAnchor="middle" fill="hsl(var(--accent))" fontSize="9" fontWeight="800" fontFamily="DM Mono">E · {formatPriceAxisValue(entryPrice)}</text>
            {exitX !== null && exitPrice !== null && <g data-testid="trade-exit-overlay">
              <line x1={entryX} x2={exitX} y1={y(exitPrice)} y2={y(exitPrice)} stroke="hsl(var(--negative))" strokeWidth="2" strokeDasharray="2 3" />
              <circle cx={exitX} cy={y(exitPrice)} r="6" fill="hsl(var(--negative))" stroke="hsl(var(--card))" strokeWidth="2" data-testid="trade-exit-marker" />
            </g>}
            {legOverlays.map(({ leg, index, x }) => x !== null && <g className={focusedTradeExitKind === leg.kind ? "levelstory-selected-pulse" : undefined} key={`trade-leg-overlay-${index}`} data-testid={`trade-leg-${leg.kind ?? "unknown"}-${index}`}>
               {(() => {
                 const legColor = leg.kind === "target" ? "hsl(var(--positive))" : "hsl(270 55% 48%)";
                 const legIsFocused = focusedTradeExitKind === leg.kind;
                 const legIsDimmed = focusedTradeExitKind !== null && !legIsFocused;
                  return <>
                    <line className={legIsFocused ? "levelstory-selected-pulse" : undefined} x1={entryX} x2={x} y1={y(leg.fillPrice ?? entryPrice)} y2={y(leg.fillPrice ?? entryPrice)} stroke={legColor} strokeWidth={legIsFocused ? "3" : "1.5"} strokeDasharray="1 4" opacity={legIsDimmed ? ".18" : "1"} data-testid={`trade-leg-line-${leg.kind ?? "unknown"}-${index}`} />
                   <circle className={legIsFocused ? "levelstory-selected-pulse" : undefined} cx={x} cy={y(leg.fillPrice ?? entryPrice)} r={legIsFocused ? "6" : "4"} fill={legColor} stroke="hsl(var(--card))" strokeWidth={legIsFocused ? "2" : "1.5"} opacity={legIsDimmed ? ".18" : "1"} />
                 </>;
               })()}
              <title>{`${leg.kind ?? "leg"} leg · ${leg.quantity ?? "—"} contracts · ${leg.exitReason ?? "exit"} · ${leg.fillPrice == null ? "price unavailable" : formatPriceAxisValue(leg.fillPrice)}`}</title>
            </g>)}
          </g>}
          {indicatorPath("vwap", "machine") && <path className={activeIndicatorId === "vwap" ? "levelstory-selected-pulse" : undefined} pointerEvents="none" d={indicatorPath("vwap", "machine")} fill="none" stroke="hsl(5 58% 46%)" {...indicatorStyle("vwap")} data-testid="indicator-curve-vwap" />}
          {indicatorPath("vwap", "human_only") && <path className={activeIndicatorId === "vwap" ? "levelstory-selected-pulse" : undefined} pointerEvents="none" d={indicatorPath("vwap", "human_only")} fill="none" stroke="hsl(5 58% 46%)" strokeDasharray="7 4" {...indicatorStyle("vwap")} opacity={activeIndicatorId === null ? .55 : activeIndicatorId === "vwap" ? .8 : .15} data-testid="indicator-curve-vwap-human-only" />}
          {indicatorPath("ema200", "machine") && <path className={activeIndicatorId === "ema-200" ? "levelstory-selected-pulse" : undefined} pointerEvents="none" d={indicatorPath("ema200", "machine")} fill="none" stroke="hsl(145 45% 42%)" {...indicatorStyle("ema-200")} data-testid="indicator-curve-ema200" />}
          {indicatorPath("ema200", "human_only") && <path className={activeIndicatorId === "ema-200" ? "levelstory-selected-pulse" : undefined} pointerEvents="none" d={indicatorPath("ema200", "human_only")} fill="none" stroke="hsl(145 45% 42%)" strokeDasharray="7 4" {...indicatorStyle("ema-200")} opacity={activeIndicatorId === null ? .55 : activeIndicatorId === "ema-200" ? .8 : .15} data-testid="indicator-curve-ema200-human-only" />}
           {snapshot.tradeEvents.length === 0 && <g data-testid="no-entry-marker"><rect x={left + 8} y={top + 30} width="132" height="24" rx="2" fill="hsl(var(--negative) / .12)" stroke="hsl(var(--negative) / .55)" /><text x={left + 74} y={top + 46} textAnchor="middle" fill="hsl(var(--negative))" fontSize="10" fontWeight="700" fontFamily="DM Mono">NO ENTRY</text></g>}
       {primaryLevels.map((annotation) => {
        if (annotation.price == null || annotation.price < domain.min || annotation.price > domain.max) return null;
        if (isDynamicIndicatorAnnotation(annotation)) return null;
        const orb = annotation.id === "orb-high" || annotation.id === "orb-low";
         const entry = annotation.id === "entry-buffer";
         const stop = annotation.id === "strategy-stop";
         const target = annotation.id === "target" || annotation.id === "one-r-target";
           const chartLabel = ["entry-buffer", "strategy-stop", "target", "one-r-target", "runner-threshold"].includes(annotation.id)
             ? chartLevelLabel(annotation)
             : null;
          const stroke = levelStroke(annotation);
          const selected = focusedLevelId === annotation.id;
          const hasRange = annotation.rangeLow != null && annotation.rangeHigh != null;
          const rangeLow = hasRange ? Math.min(annotation.rangeLow!, annotation.rangeHigh!) : null;
          const rangeHigh = hasRange ? Math.max(annotation.rangeLow!, annotation.rangeHigh!) : null;
          const isDynamite = annotation.id.startsWith("dynamite|");
          const rangeHeight = rangeLow != null && rangeHigh != null ? Math.abs(y(rangeLow) - y(rangeHigh)) : 0;
          const minimumBandHeight = Math.abs(y(annotation.price) - y(annotation.price + MES_TICK_SIZE));
          const bandHeight = Math.max(rangeHeight, minimumBandHeight);
          const bandY = rangeLow != null && rangeHigh != null && rangeHeight < minimumBandHeight
            ? y((rangeLow + rangeHigh) / 2) - minimumBandHeight / 2
            : rangeLow != null && rangeHigh != null
              ? Math.min(y(rangeLow), y(rangeHigh))
              : y(annotation.price);
                  return <g
            key={annotation.id}
                    className={selected ? "levelstory-selected-pulse" : undefined}
            pointerEvents="all"
            data-testid={`chart-level-${annotation.id}`}
            onMouseEnter={() => focusLevel(annotation.id)}
            onMouseLeave={() => setActiveLevelId((current) => current === annotation.id ? null : current)}
             onClick={() => focusLevel(annotation.id)}
            aria-label={`${annotation.label}, ${annotation.detail}`}
          >
            {hasRange && rangeLow != null && rangeHigh != null
               ? <rect x={left} y={bandY} width={plotRight - left} height={bandHeight} fill={isDynamite ? "#9dc9ee" : stroke} fillOpacity={isDynamite ? ".24" : ".1"} stroke={stroke} strokeWidth={selected ? "2.2" : isDynamite ? "1.8" : "1.2"} data-testid={`chart-level-band-${annotation.id}`} />
               : <>
                  <line x1={left} x2={plotRight} y1={y(annotation.price)} y2={y(annotation.price)} stroke={stroke} strokeWidth={selected ? 2.6 : orb ? 2.8 : entry || stop ? 2.4 : 1.4} strokeDasharray={target ? "7 5" : orb ? "10 4" : entry || stop ? "5 3" : annotation.kind === "indicator" ? "2 5" : "none"} opacity={orb ? ".98" : ".8"} />
                  {chartLabel && <text x={plotRight - 5} y={y(annotation.price) - 8} textAnchor="end" fill={stroke} fontSize="9" fontWeight="800" fontFamily="DM Mono" data-testid={`chart-level-label-${annotation.id}`}>{chartLabel} · {formatPriceAxisValue(annotation.price)}</text>}
               </>}
          </g>;
      })}
      {edgeIndicators.map(({ annotation, edge }) => {
         const edgeIndex = edgeCounts[edge]++;
         const edgeY = edge === "top" ? top + 8 + edgeIndex * 15 : plotBottom - 8 - edgeIndex * 15;
         const stroke = levelStroke(annotation);
         const label = `${chartLevelLabel(annotation)} · ${annotation.price?.toFixed(2)}`;
         const selected = focusedLevelId === annotation.id;
          return <g className={selected ? "levelstory-selected-pulse" : undefined} key={`edge-${annotation.id}`} data-testid={`edge-indicator-${annotation.id}`}><path d={edge === "top" ? `M ${left} ${edgeY - 7} l 7 7 l -14 0 z` : `M ${left} ${edgeY + 7} l 7 -7 l -14 0 z`} fill={stroke} /><text x={left + 12} y={edgeY + 4} fill={stroke} fontSize="9" fontWeight="700" fontFamily="DM Mono" data-testid={`edge-indicator-label-${annotation.id}`}>{edge === "top" ? "↑" : "↓"} {label}</text></g>;
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
           return <g key={`${candle.openTime}-${index}`} data-testid={`chart-candle-${index}`}>
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
          {pointerPosition && <g pointerEvents="none" data-testid="chart-crosshair">
            <line x1={left} x2={plotRight} y1={pointerPosition.y} y2={pointerPosition.y} stroke="hsl(var(--accent))" strokeDasharray="4 3" strokeWidth="1.2" opacity=".9" data-testid="crosshair-horizontal-line" />
            <line x1={pointerPosition.x} x2={pointerPosition.x} y1={top} y2={plotBottom} stroke="hsl(var(--accent))" strokeDasharray="4 3" strokeWidth="1.2" opacity=".9" data-testid="crosshair-vertical-line" />
            <circle cx={pointerPosition.x} cy={pointerPosition.y} r="3.5" fill="hsl(var(--accent))" stroke="hsl(var(--card))" strokeWidth="1" />
            <rect x={plotRight + 3} y={pointerPosition.y - 10} width={right - 8} height="18" rx="2" fill="hsl(var(--accent))" data-testid="crosshair-price-label-background" />
            <text x={width - 9} y={pointerPosition.y + 3.5} textAnchor="end" fill="hsl(var(--accent-foreground))" fontSize="9" fontWeight="800" fontFamily="DM Mono" data-testid="crosshair-price-label">{formatPriceAxisValue(pointerPosition.price)}</text>
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

function DisclosurePanelTitle({
  panelId,
  eyebrow,
  title,
  right,
  open,
  onToggleOpen,
}: {
  panelId: string;
  eyebrow?: string;
  title: string;
  right?: ReactNode;
  open: boolean;
  onToggleOpen: () => void;
}) {
  return <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5 sm:px-6">
    <div>
      {eyebrow && <div className="eyebrow mb-1.5 text-muted-foreground">{eyebrow}</div>}
      <h2 className="text-[14px] font-bold tracking-tight">{title}</h2>
    </div>
    <div className="flex items-center gap-3">
      {right}
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
        className="inline-flex items-center gap-1.5 rounded-sm border border-border px-2 py-1.5 text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground transition hover:bg-muted hover:text-foreground"
        data-testid={`toggle-${panelId}`}
      >
        <ChevronDown size={13} className={`transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
        <span className="hidden sm:inline">{open ? "Collapse" : "Expand"}</span>
      </button>
    </div>
  </div>;
}

function ChartEvidence({ snapshot, open, onToggleOpen }: { snapshot: VisualValidationSnapshot; open: boolean; onToggleOpen: () => void }) {
  const evidence = snapshot.machineEvidence;
  const market = typeof evidence.market === "object" && evidence.market !== null ? evidence.market as Record<string, unknown> : {};
  const audit = typeof evidence.audit === "object" && evidence.audit !== null ? evidence.audit as Record<string, unknown> : {};
  const breakout = typeof market.breakout === "object" && market.breakout ? (market.breakout as Record<string, unknown>).detail : null;
  const patience = typeof market.patience === "object" && market.patience ? (market.patience as Record<string, unknown>).detail : null;
  const qualified = audit.rejectionCategory === "QUALIFIED" && evidence.trade;
  const trade = evidence.trade as TradeEvidenceView | null;
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
       <DisclosurePanelTitle panelId="plain-language-summary-content" eyebrow="Plain-language summary / read-only" title="What the app found" right={<span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase text-muted-foreground"><Fingerprint size={13} />Machine-owned</span>} open={open} onToggleOpen={onToggleOpen} />
      {open && <div id="plain-language-summary-content">
      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-3" data-testid="trader-readable-reasoning">
        <div className="min-h-[104px] bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">What the app found</div><div className="mt-2 text-sm font-bold">{snapshot.categoryLabel}</div><div className="mt-1 text-[10px] text-muted-foreground">{safeValue(audit.setupType)}{audit.direction ? ` · ${safeValue(audit.direction)}` : ""}</div></div>
        <div className="min-h-[104px] bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">Why it matches this category</div><div className="mt-2 text-xs leading-5">{behavior.length ? behavior.join(" ") : "The category anchor and related candles match this review category."}</div></div>
        <div className="min-h-[104px] bg-card px-4 py-4"><div className="eyebrow text-muted-foreground">What the app decided</div><div className="mt-2 text-xs leading-5">{qualification}</div></div>
     </div>
     <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2">
       <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Evaluation boundary</div><div className="mono mt-2 break-words text-[11px]">{safeValue(audit.evaluatedCandleOpenTime)} · {snapshot.evaluationCursor.visibleCandleCount} candles visible</div></div>
       <div className="bg-card px-4 py-3"><div className="eyebrow text-muted-foreground">Confirmation</div><div className="mt-2 text-[11px]">{safeValue(patience ?? audit.patienceState)}</div></div>
     </div>
      <TradeInspector trade={trade} />
     <details className="border-t border-border px-5 py-4 sm:px-6" data-testid="technical-details">
        <summary className="cursor-pointer text-xs font-semibold">Technical details</summary>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-sm bg-secondary/60 p-3 text-[10px] leading-4 text-muted-foreground">{JSON.stringify(evidence, null, 2)}</pre>
    </details>
      <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground sm:px-6">This is a machine explanation, not a human judgment. Compare it with the raw candles and use the review panel to record your call.</div>
      </div>}
  </Panel>;
}

function formatTradePrice(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

function formatTradeMoney(value: number | null | undefined, open: boolean): string {
  return open || typeof value !== "number" || !Number.isFinite(value) ? "—" : `$${value.toFixed(2)}`;
}

function TradeInspector({ trade }: { trade: TradeEvidenceView | null }) {
  if (!trade) return null;
  const open = trade.outcome === "open" || trade.exitTime === null || trade.exitPrice == null;
  const legs = trade.audit?.legs ?? [];
  const hasKeyLevelTarget = typeof trade.targetPlan?.targetPrice === "number";
  const noEligibleKeyLevel = trade.targetPlan?.disposition === "NO_ELIGIBLE_KEY_LEVEL" || !hasKeyLevelTarget;
  const oneRPrice = typeof trade.audit?.oneRPrice === "number" ? trade.audit.oneRPrice : null;
  const targetBasis = hasKeyLevelTarget
    ? `Key-level · ${formatTradePrice(trade.targetPlan?.targetPrice)}`
    : oneRPrice !== null
      ? "1R fallback · no eligible key level"
      : "No target evidence";
  return <section className="border-t border-border bg-card px-5 py-4 sm:px-6" data-testid="trade-inspector">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><div className="eyebrow text-muted-foreground">Authoritative trade inspector</div><div className="mt-1 text-sm font-bold">{open ? "Open / unscored" : "Completed trade"}</div></div>
      <span className={`border px-2 py-1 text-[9px] font-bold uppercase ${open ? "border-accent/35 bg-accent/10 text-accent" : "border-border text-muted-foreground"}`}>{open ? "No exit yet" : safeValue(trade.outcome)}</span>
    </div>
    <div className="mt-3 grid gap-px border border-border bg-border text-[10px] sm:grid-cols-2 lg:grid-cols-4">
      {[
        ["Direction", trade.direction ? trade.direction.toUpperCase() : "—"],
        ["Quantity", trade.contracts == null ? "—" : `${trade.contracts} contract${trade.contracts === 1 ? "" : "s"}`],
        ["Entry price", formatTradePrice(trade.entryPrice)],
        ["Exit price", open ? "—" : formatTradePrice(trade.exitPrice)],
        ["Gross P/L", formatTradeMoney(trade.grossPnl, open)],
        ["Fees", formatTradeMoney(trade.fees, open)],
        ["Slippage", formatTradeMoney(trade.slippage, open)],
        ["Net P/L", formatTradeMoney(trade.netPnl, open)],
      ].map(([label, value]) => <div key={label} className="bg-card px-3 py-3"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-1 font-bold">{value}</div></div>)}
    </div>
    <div className="mt-3 grid gap-px border border-border bg-border text-[10px] sm:grid-cols-2 lg:grid-cols-4" data-testid="trade-target-summary">
      {[
        ["Target basis", targetBasis],
        ["1R checkpoint", oneRPrice === null ? "—" : formatTradePrice(oneRPrice)],
        ["1R status", oneRPrice === null ? "Not applicable" : hasKeyLevelTarget ? "Not active · key-level target" : trade.audit?.oneRReached ? "Reached" : "Not reached"],
        ["Single-contract rule", trade.contracts === 1 && noEligibleKeyLevel && oneRPrice !== null
          ? "Full exit at +1R"
          : trade.contracts === 1 && hasKeyLevelTarget
            ? "Key-level target has priority"
            : "—"],
      ].map(([label, value]) => <div key={label} className="bg-card px-3 py-3"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-1 font-bold">{value}</div></div>)}
    </div>
    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-muted-foreground">
      <span>Entry observed at E-close: <strong className="mono text-foreground">{trade.entryTime ? formatReviewTime(trade.entryTime) : "—"}</strong></span>
      <span>Exit reason: <strong className="text-foreground">{open ? "Open / unscored" : safeValue(trade.audit?.exitReason ?? trade.outcome)}</strong></span>
    </div>
    {legs.length > 0 && <div className="mt-3 border-t border-border pt-3" data-testid="trade-leg-inspector">
      <div className="eyebrow text-muted-foreground">Exit legs</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {legs.map((leg, index) => <div key={`${leg.kind}-${index}`} className="border border-border bg-muted/20 px-3 py-2 text-[10px]" data-testid={`trade-leg-detail-${index}`}>
          <div className="flex justify-between gap-3 font-bold"><span>{safeValue(leg.kind)} · {leg.quantity ?? "—"} contracts</span><span>{safeValue(leg.exitReason)}</span></div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground"><span>Ref <strong className="mono text-foreground">{formatTradePrice(leg.referencePrice)}</strong></span><span>Fill <strong className="mono text-foreground">{formatTradePrice(leg.fillPrice)}</strong></span><span>Gross <strong className="mono text-foreground">{formatTradeMoney(leg.grossPnl, open)}</strong></span><span>Net <strong className="mono text-foreground">{formatTradeMoney(leg.netPnl, open)}</strong></span></div>
        </div>)}
      </div>
    </div>}
  </section>;
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
  open,
  onToggleOpen,
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
  open: boolean;
  onToggleOpen: () => void;
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
     .filter((annotation) => isVisualPresentationAnnotation(annotation) && annotation.available && annotation.kind !== "candle" && (annotation.price !== null || annotation.id === "vwap" || annotation.id === "ema-200"))
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
     <DisclosurePanelTitle panelId="human-judgment-content" eyebrow="Human judgment / explicit submission" title="Does the story hold?" right={<ClipboardCheck size={17} className="text-accent" />} open={open} onToggleOpen={onToggleOpen} />
     {open && <div id="human-judgment-content">
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
           <Field label="Confirmation buffer"><select className="field mono" value={teaching.entryBufferTicks} onChange={(event) => updateTeaching({ entryBufferTicks: 8 })}><option value={8}>8 MES ticks · 2.00 points</option></select></Field>
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
     </div></div>}
  </Panel>;
}

function UnavailableWorkspace({ coverage, source }: { coverage: VisualValidationSet["categoryCoverage"]; source: VisualValidationSet["source"] }) {
  const historical = source === "historical_databento";
  return <Panel accent><div className="flex min-h-[280px] flex-col items-center justify-center px-8 py-12 text-center"><div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-muted text-muted-foreground"><AlertTriangle size={22} /></div><h2 className="display text-xl font-bold">No confirmed trade candidates found.</h2><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{historical ? "No confirmed trade candidates were found in this review period." : "This deterministic set did not produce a confirmed trade candidate."}</p><p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">Sessions searched and causal P→E outcomes remain available in the audit evidence. Extend the review period to search for more candidates.</p><div className="mt-5 flex flex-wrap justify-center gap-2">{coverage.filter((item) => item.category === "qualified_trade" && item.count > 0).map((item) => <span key={item.category} className="border border-border bg-muted/35 px-2.5 py-1.5 text-[10px] font-bold uppercase">Trade candidates · {item.count}</span>)}</div></div></Panel>;
}

function EmptyReview() {
  return <div className="flex min-h-[360px] flex-col items-center justify-center px-8 text-center"><div className="mb-5 flex h-14 w-14 items-center justify-center rounded-md bg-accent/20"><FileSearch size={24} /></div><h2 className="display text-2xl font-bold">No confirmed trade candidates were found in this review period.</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">Generate a deterministic review set to search for causal edge → P → immediate E candidates.</p><p className="mt-3 text-xs text-muted-foreground">Suggested action: extend the review period.</p></div>;
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
