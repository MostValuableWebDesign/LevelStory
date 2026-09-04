import { useEffect, useRef, useState, type DragEvent, type ChangeEvent, type ReactNode } from "react";
import { Check, FileImage, Info, LoaderCircle, Maximize2, Upload, X } from "lucide-react";
import type { VisualValidationSnapshot } from "@workspace/api-client-react";
import { Panel, PanelTitle } from "@/components/levelstory-ui";

type AnalysisResponse = {
  analysisId: string;
  imageUrl: string;
  source: "uploaded_chart";
  tradingDate: string;
  symbol: string;
  timeframe: string;
  timezone: string;
  session: string;
  status: string;
  machineExtraction: {
    modelVersion?: string;
    extraction?: {
      summary?: string;
      rules?: Array<{
        name: string;
        status: "pass" | "fail" | "uncertain" | "not_visible";
        value: string | null;
        confidence: number;
        explanation: string;
        mandatory: boolean;
        reviewerConfirmationRequired: boolean;
      }>;
      calibration?: {
        pricesCalibrated: boolean;
        timestampsCalibrated: boolean;
        notes: string;
      };
    };
    evaluation?: {
      causalCutoff: string | null;
      strategyDetail: string;
      missingEvidence: string[];
      riskApproved: boolean;
    };
  };
  reviewerCorrections: Record<string, unknown> | null;
  candidate: {
    candidateId: string;
    direction: "long" | "short";
    primaryEdge: string;
    setupGrade: string;
    entryTriggerPrice: number;
    stopPrice: number;
    targetPrice: number | null;
    contracts: number;
    riskDollars: number;
    evaluationCutoff: string;
    entryActivated: boolean;
    outcome: string;
    exitPrice: number | null;
    pnl: number | null;
  } | null;
  reviewerStatus: "unreviewed" | "confirmed" | "rejected" | "uncertain";
  reviewerNote: string | null;
  includeInCombinedReplay: boolean;
  duplicateWarning: { reason: string } | null;
};

type Props = {
  activeSnapshot?: VisualValidationSnapshot;
};

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

function apiError(response: Response, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return `${response.status} ${response.statusText}`;
}

function dateFromSnapshot(snapshot?: VisualValidationSnapshot): string {
  return snapshot?.tradingDate ?? "";
}

export function UploadedChartAnalysis({ activeSnapshot }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [tradingDate, setTradingDate] = useState(() => dateFromSnapshot(activeSnapshot));
  const [symbol, setSymbol] = useState(() => activeSnapshot?.contractSymbol ?? "MES");
  const [timeframe, setTimeframe] = useState("5m");
  const [timezone, setTimezone] = useState("America/New_York");
  const [session, setSession] = useState<"regular" | "extended">("regular");
  const [visibleStart, setVisibleStart] = useState("");
  const [visibleEnd, setVisibleEnd] = useState("");
  const [indicators, setIndicators] = useState("");
  const [chartNote, setChartNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<AnalysisResponse["reviewerStatus"]>("unreviewed");
  const [reviewNote, setReviewNote] = useState("");
  const [includeInReplay, setIncludeInReplay] = useState(false);
  const [correctionEntry, setCorrectionEntry] = useState("");
  const [correctionStop, setCorrectionStop] = useState("");
  const [correctionTarget, setCorrectionTarget] = useState("");

  useEffect(() => {
    if (activeSnapshot && !analysis) {
      setTradingDate(activeSnapshot.tradingDate);
      setSymbol(activeSnapshot.contractSymbol);
    }
  }, [activeSnapshot, analysis]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const setSelectedFile = (next: File | null) => {
    setMessage("");
    if (!next) {
      setFile(null);
      setPreviewUrl("");
      return;
    }
    if (!ACCEPTED_TYPES.includes(next.type)) {
      setMessage("Use a PNG, JPEG/JPG, or WebP chart image.");
      return;
    }
    if (next.size > MAX_BYTES) {
      setMessage("That image is larger than the 10 MB limit.");
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(next);
    setPreviewUrl(URL.createObjectURL(next));
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => setSelectedFile(event.target.files?.[0] ?? null);
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setSelectedFile(event.dataTransfer.files?.[0] ?? null);
  };

  const analyze = async () => {
    if (!file || !tradingDate || !timeframe || !timezone) {
      setMessage("Trading date, image, timeframe, and timezone are required.");
      return;
    }
    setBusy(true);
    setMessage("Uploading the private chart image…");
    try {
      const urlResponse = await fetch("/api/uploaded-chart/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ originalFilename: file.name, mimeType: file.type, sizeBytes: file.size }),
      });
      const urlBody = await urlResponse.json() as { uploadUrl?: string; objectPath?: string; error?: string };
      if (!urlResponse.ok || !urlBody.uploadUrl || !urlBody.objectPath) throw new Error(apiError(urlResponse, urlBody));
      setMessage("Image stored. Reading visible chart evidence…");
      const uploadResponse = await fetch(urlBody.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!uploadResponse.ok) throw new Error("Private image storage rejected the upload.");
      const analysisResponse = await fetch("/api/uploaded-chart/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          objectPath: urlBody.objectPath,
          originalFilename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          tradingDate,
          symbol,
          timeframe,
          timezone,
          session,
          visibleStart: visibleStart || null,
          visibleEnd: visibleEnd || null,
          chartNote: `${chartNote}${indicators ? `\nIndicators/settings: ${indicators}` : ""}`.trim() || null,
          activeCandidate: activeSnapshot ? {
            tradingDate: activeSnapshot.tradingDate,
            contractSymbol: activeSnapshot.contractSymbol,
            direction: activeSnapshot.categoryAnchor.direction === "short" ? "short" : "long",
            entryCandleOpenTime: activeSnapshot.evaluationCursor.closeTime,
            entryTriggerPrice: typeof activeSnapshot.machineEvidence.trade === "object" && activeSnapshot.machineEvidence.trade && "entryPrice" in activeSnapshot.machineEvidence.trade ? Number(activeSnapshot.machineEvidence.trade.entryPrice) : null,
            primaryEdge: activeSnapshot.strategyKey,
          } : null,
        }),
      });
      const analysisBody = await analysisResponse.json() as AnalysisResponse & { error?: string };
      if (!analysisResponse.ok) throw new Error(apiError(analysisResponse, analysisBody));
      setAnalysis(analysisBody);
      setReviewStatus(analysisBody.reviewerStatus);
      setReviewNote(analysisBody.reviewerNote ?? "");
      setIncludeInReplay(analysisBody.includeInCombinedReplay);
      setMessage(analysisBody.status);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Chart analysis failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveReview = async () => {
    if (!analysis || reviewStatus === "unreviewed") {
      setMessage("Choose a reviewer status before saving.");
      return;
    }
    setBusy(true);
    setMessage("Saving reviewer confirmation…");
    try {
      const response = await fetch(`/api/uploaded-chart/${analysis.analysisId}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          status: reviewStatus,
          note: reviewNote.trim() || null,
          includeInCombinedReplay: includeInReplay,
          corrections: {
            entryPrice: correctionEntry ? Number(correctionEntry) : null,
            stopPrice: correctionStop ? Number(correctionStop) : null,
            targetPrice: correctionTarget ? Number(correctionTarget) : null,
          },
        }),
      });
      const body = await response.json() as AnalysisResponse & { error?: string };
      if (!response.ok) throw new Error(apiError(response, body));
      setAnalysis(body);
      setMessage(body.includeInCombinedReplay ? "Review saved; candidate is eligible for Combined Shadow Replay." : "Review saved. The original machine extraction remains preserved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reviewer update failed.");
    } finally {
      setBusy(false);
    }
  };

  const extraction = analysis?.machineExtraction.extraction;
  const evaluation = analysis?.machineExtraction.evaluation;
  const candidate = analysis?.candidate;
  const errorMessage = /failed|unable|rejected|required|larger|invalid|unavailable|not found/i.test(message);

  return <div data-testid="uploaded-chart-analysis"><Panel accent>
    <PanelTitle eyebrow="Chart Analysis / uploaded evidence" title="Analyze a chart without placing an order" right={<span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"><FileImage size={14} />Shadow Mode only</span>} />
    <div className="space-y-5 border-t border-border p-5 sm:p-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Trading date *"><input className="field mono" type="date" value={tradingDate} onChange={(event) => setTradingDate(event.target.value)} /></Field>
        <Field label="Symbol / contract"><input className="field mono" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></Field>
        <Field label="Chart timeframe *"><input className="field mono" placeholder="5m" value={timeframe} onChange={(event) => setTimeframe(event.target.value)} /></Field>
        <Field label="Timezone *"><input className="field mono" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Session"><select className="field" value={session} onChange={(event) => setSession(event.target.value as "regular" | "extended")}><option value="regular">Regular hours</option><option value="extended">Extended hours</option></select></Field>
        <Field label="Visible start"><input className="field mono" placeholder="09:30" value={visibleStart} onChange={(event) => setVisibleStart(event.target.value)} /></Field>
        <Field label="Visible end"><input className="field mono" placeholder="13:00" value={visibleEnd} onChange={(event) => setVisibleEnd(event.target.value)} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Indicators and settings"><input className="field" placeholder="VWAP, EMA 200, RSI 14, Fib…" value={indicators} onChange={(event) => setIndicators(event.target.value)} /></Field>
        <Field label="Optional chart note"><input className="field" placeholder="Anything the reviewer wants the model to check" value={chartNote} onChange={(event) => setChartNote(event.target.value)} /></Field>
      </div>
      <div
        className="relative flex min-h-[150px] cursor-pointer flex-col items-center justify-center border border-dashed border-accent/50 bg-accent/5 px-5 py-7 text-center transition hover:bg-accent/10"
        onClick={() => fileInput.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        data-testid="uploaded-chart-dropzone"
      >
        <input ref={fileInput} className="sr-only" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" onChange={onInputChange} />
        {file ? <><Check size={22} className="text-[hsl(var(--positive))]" /><div className="mt-2 text-sm font-bold">{file.name}</div><div className="mt-1 mono text-[10px] text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB · {file.type}</div></> : <><Upload size={22} className="text-accent" /><div className="mt-2 text-sm font-bold">Drop a chart image here or choose a file</div><div className="mt-1 text-[10px] text-muted-foreground">PNG, JPEG/JPG, or WebP · max 10 MB</div></>}
      </div>
      {file && <div className="flex flex-wrap items-center gap-2"><button type="button" className="rounded-md border border-border px-3 py-2 text-[10px] font-bold" onClick={() => fileInput.current?.click()}>Replace image</button><button type="button" className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-[10px] font-bold text-muted-foreground" onClick={() => setSelectedFile(null)}><X size={13} />Remove</button></div>}
      {previewUrl && <div className="relative overflow-hidden border border-border bg-black/5"><img src={previewUrl} alt="Uploaded trading chart preview" className="max-h-[330px] w-full object-contain" /><button type="button" className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-md bg-background/90 px-3 py-2 text-[10px] font-bold shadow" onClick={() => setLightbox(true)}><Maximize2 size={13} />Full size</button></div>}
      {message && <div className={`flex items-start gap-2 border p-3 text-xs ${errorMessage ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-[hsl(var(--positive)/.25)] bg-[hsl(var(--positive)/.08)] text-[hsl(var(--positive))]"}`} role="status"><Info size={14} className="mt-0.5 shrink-0" />{message}</div>}
      <button type="button" disabled={busy || !file} onClick={analyze} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-xs font-bold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">{busy ? <LoaderCircle size={15} className="animate-spin" /> : <FileImage size={15} />}{busy ? "Analyzing visible evidence…" : "Analyze uploaded chart"}</button>

      {analysis && <div className="space-y-4 border-t border-border pt-5" data-testid="uploaded-chart-result">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="eyebrow text-muted-foreground">Machine decision · Source: Uploaded chart</div><div className="mt-1 text-lg font-bold">{analysis.status}</div><div className="mt-1 text-[11px] text-muted-foreground">{extraction?.summary ?? "No summary returned."}</div></div><span className="border border-accent/45 bg-accent/10 px-2 py-1 text-[10px] font-bold uppercase">{analysis.reviewerStatus}</span></div>
        <div className="grid gap-px border border-border bg-border sm:grid-cols-3"><Metric label="Causal cutoff" value={evaluation?.causalCutoff ? new Date(evaluation.causalCutoff).toLocaleString() : "Unavailable"} /><Metric label="Price/time calibration" value={extraction?.calibration?.pricesCalibrated && extraction.calibration.timestampsCalibrated ? "Supported" : "Insufficient"} /><Metric label="Model confidence" value={extraction ? `${Math.round((extraction as { confidence?: number }).confidence ?? 0 * 100)}%` : "—"} /></div>
        {evaluation?.missingEvidence.length ? <div className="border border-accent/30 bg-accent/5 p-3 text-xs"><div className="font-bold">Insufficient evidence to promote all fields</div><ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">{evaluation.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
        <div><div className="eyebrow mb-2 text-muted-foreground">Structured rule results</div><div className="grid gap-2 sm:grid-cols-2">{(extraction?.rules ?? []).map((rule) => <div key={rule.name} className="border border-border bg-card p-3 text-[11px]"><div className="flex items-start justify-between gap-2"><span className="font-bold">{rule.name}</span><span className={`mono text-[9px] font-bold uppercase ${rule.status === "pass" ? "text-[hsl(var(--positive))]" : rule.status === "fail" ? "text-destructive" : "text-muted-foreground"}`}>{rule.status}</span></div><div className="mt-1 text-muted-foreground">{rule.explanation}</div>{rule.value && <div className="mono mt-2 text-[10px]">{rule.value}</div>}</div>)}</div></div>
        {candidate && <div className="border border-[hsl(var(--positive)/.3)] bg-[hsl(var(--positive)/.06)] p-4"><div className="eyebrow text-[hsl(var(--positive))]">Candidate / Shadow Mode</div><div className="mt-2 grid gap-3 text-[11px] sm:grid-cols-4"><Metric label="Direction" value={candidate.direction} /><Metric label="Entry" value={candidate.entryTriggerPrice.toFixed(2)} /><Metric label="Stop" value={candidate.stopPrice.toFixed(2)} /><Metric label="Target" value={candidate.targetPrice?.toFixed(2) ?? "Not visible"} /><Metric label="Contracts" value={String(candidate.contracts)} /><Metric label="Modeled risk" value={`$${candidate.riskDollars.toFixed(2)}`} /><Metric label="Grade" value={candidate.setupGrade} /><Metric label="Outcome" value={candidate.outcome.replaceAll("_", " ")} /></div></div>}
        {analysis.duplicateWarning && <div className="border border-accent/40 bg-accent/10 p-3 text-xs"><strong>Possible duplicate.</strong> {analysis.duplicateWarning.reason} Do not silently count both.</div>}
        <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-3"><Field label="Reviewer entry correction"><input className="field mono" placeholder="Keep machine value" value={correctionEntry} onChange={(event) => setCorrectionEntry(event.target.value)} /></Field><Field label="Reviewer stop correction"><input className="field mono" placeholder="Keep machine value" value={correctionStop} onChange={(event) => setCorrectionStop(event.target.value)} /></Field><Field label="Reviewer target correction"><input className="field mono" placeholder="Keep machine value" value={correctionTarget} onChange={(event) => setCorrectionTarget(event.target.value)} /></Field></div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]"><Field label="Reviewer note"><textarea className="field min-h-[74px]" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Explain confirmation or correction." /></Field><Field label="Review status"><select className="field" value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as AnalysisResponse["reviewerStatus"])}><option value="unreviewed">Choose…</option><option value="confirmed">Confirmed</option><option value="uncertain">Uncertain</option><option value="rejected">Rejected</option></select></Field></div>
        <label className={`flex items-start gap-3 border p-3 text-xs ${candidate && reviewStatus === "confirmed" ? "border-accent/40 bg-accent/5" : "border-border bg-muted/20 opacity-60"}`}><input type="checkbox" className="mt-0.5 accent-[hsl(var(--accent))]" checked={includeInReplay} disabled={!candidate || reviewStatus !== "confirmed"} onChange={(event) => setIncludeInReplay(event.target.checked)} /><span><span className="block font-bold">Include confirmed uploaded-chart trade in Combined Shadow Replay</span><span className="mt-1 block text-muted-foreground">Off by default. Requires reviewer confirmation, supported entry activation, calibrated prices/timestamps, and risk approval.</span></span></label>
        <button type="button" disabled={busy || reviewStatus === "unreviewed"} onClick={saveReview} className="rounded-md border border-accent/50 bg-accent/10 px-4 py-2.5 text-xs font-bold disabled:opacity-50">{busy ? "Saving…" : "Save reviewer confirmation"}</button>
      </div>}
    </div>
    {lightbox && previewUrl && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-5" role="dialog" aria-label="Full-size uploaded chart" onClick={() => setLightbox(false)}><img src={previewUrl} alt="Full-size uploaded trading chart" className="max-h-full max-w-full object-contain" /><button type="button" className="absolute right-5 top-5 rounded-md bg-background p-2" onClick={() => setLightbox(false)}><X size={18} /></button></div>}
  </Panel></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="eyebrow mb-1.5 block text-muted-foreground">{label}</span>{children}</label>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-card px-3 py-2.5"><div className="eyebrow text-muted-foreground">{label}</div><div className="mono mt-1 break-words text-[11px] font-bold">{value}</div></div>;
}