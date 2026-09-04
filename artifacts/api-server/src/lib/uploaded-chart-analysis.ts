import crypto from "node:crypto";
import { z } from "zod";
import { patienceCandleEngine } from "./strategy/phase5.js";
import type { Candle, Direction, TrendDirection } from "./strategy/types.js";

export const uploadedChartMetadataSchema = z.object({
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  symbol: z.string().trim().min(1).max(32).default("MES"),
  timeframe: z.string().trim().min(1).max(32),
  timezone: z.string().trim().min(1).max(64),
  session: z.enum(["regular", "extended"]),
  visibleStart: z.string().trim().max(32).nullable().optional(),
  visibleEnd: z.string().trim().max(32).nullable().optional(),
  chartNote: z.string().max(2000).nullable().optional(),
  originalFilename: z.string().trim().min(1).max(255),
  objectPath: z.string().regex(/^\/objects\/uploads\/chart\/[a-f0-9-]+$/),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  activeCandidate: z.object({
    tradingDate: z.string(),
    contractSymbol: z.string(),
    direction: z.enum(["long", "short"]),
    entryCandleOpenTime: z.string(),
    entryTriggerPrice: z.number().nullable(),
    primaryEdge: z.string(),
  }).nullable().optional(),
});

const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  status: z.enum(["pass", "fail", "uncertain", "not_visible"]),
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  explanation: z.string().max(500),
  region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
  mandatory: z.boolean(),
  reviewerConfirmationRequired: z.boolean(),
});

const extractedCandleSchema = z.object({
  openTime: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nonnegative(),
  isComplete: z.boolean(),
});

const extractedLevelSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  price: z.number().nullable(),
  confidence: z.number().min(0).max(1),
});

export const chartExtractionSchema = z.object({
  summary: z.string().max(2000),
  rules: z.array(ruleSchema).max(40),
  calibration: z.object({
    priceAxisVisible: z.boolean(),
    timeAxisVisible: z.boolean(),
    pricesCalibrated: z.boolean(),
    timestampsCalibrated: z.boolean(),
    notes: z.string().max(600),
  }),
  trend: z.enum(["bullish", "bearish", "neutral"]),
  candles: z.array(extractedCandleSchema).max(120),
  levels: z.array(extractedLevelSchema).max(40),
  direction: z.enum(["long", "short"]).nullable(),
  previousCandleIndex: z.number().int().nullable(),
  patienceCandleIndex: z.number().int().nullable(),
  entryDecisionCandleIndex: z.number().int().nullable(),
  entryPrice: z.number().nullable(),
  entryTimestamp: z.string().nullable(),
  entryActivated: z.boolean(),
  exitCandleIndex: z.number().int().nullable(),
  exitPrice: z.number().nullable(),
  exitTimestamp: z.string().nullable(),
  exitReason: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type ChartExtraction = z.infer<typeof chartExtractionSchema>;
export type UploadedChartMetadata = z.infer<typeof uploadedChartMetadataSchema>;

export type UploadedChartCandidate = {
  candidateId: string;
  source: "uploaded_chart";
  direction: Direction;
  primaryEdge: "PATIENCE_CANDLE_CONTINUATION";
  matchedEdges: string[];
  supportingConfluences: string[];
  setupGrade: "A" | "A+" | "A++";
  patienceCandle: { openTime: string; closeTime: string; high: number; low: number };
  entryDecisionCandle: { openTime: string; closeTime: string };
  entryTriggerPrice: number;
  stopPrice: number;
  targetPrice: number | null;
  contracts: 2;
  riskDollars: number;
  evaluationCutoff: string;
  entryActivated: true;
  outcome: "open_unscored" | "closed_modeled";
  exitPrice: number | null;
  exitTimestamp: string | null;
  pnl: number | null;
  formulaVersion: string;
  formulaHash: string;
};

export type UploadedChartStatus =
  | "No strategy setup detected"
  | "Potential setup—more evidence required"
  | "Qualified setup—entry not activated"
  | "Qualified setup—entry activated, outcome open"
  | "Qualified setup—closed modeled Shadow trade"
  | "Rejected by risk rules"
  | "Insufficient chart evidence"
  | "Analysis failed";

export type UploadedChartEvaluation = {
  status: UploadedChartStatus;
  candidate: UploadedChartCandidate | null;
  missingEvidence: string[];
  causalCutoff: string | null;
  strategyDetail: string;
  riskApproved: boolean;
};

const MODEL_VERSION = "gpt-5.4-mini";
const FORMULA_VERSION = "phase5-uploaded-chart-v1";

export function imageChecksum(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function detectImageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function validateUploadedChartBytes(
  bytes: Buffer,
  declaredMime: UploadedChartMetadata["mimeType"],
): "image/png" | "image/jpeg" | "image/webp" {
  if (bytes.length > 10 * 1024 * 1024) throw new Error("The uploaded chart exceeds the 10 MB limit.");
  const detected = detectImageMime(bytes);
  if (!detected || detected !== declaredMime) throw new Error("The uploaded bytes are not a valid PNG, JPEG, or WebP image.");
  return detected;
}

export function uploadedChartDuplicateWarning(
  metadata: UploadedChartMetadata,
  candidate: UploadedChartCandidate | null,
): { possibleDuplicateOf: string; reason: string } | null {
  const active = metadata.activeCandidate;
  if (!active || !candidate) return null;
  if (
    active.tradingDate === metadata.tradingDate
    && active.contractSymbol === metadata.symbol
    && active.direction === candidate.direction
    && active.entryTriggerPrice === candidate.entryTriggerPrice
    && active.primaryEdge === candidate.primaryEdge
  ) {
    return {
      possibleDuplicateOf: "active_generated_candidate",
      reason: "The uploaded candidate matches the active generated candidate on date, contract, direction, edge, and entry price.",
    };
  }
  return null;
}

export function uploadedChartReplayEligibility(input: {
  reviewerStatus: "unreviewed" | "confirmed" | "rejected" | "uncertain";
  candidate: { entryActivated?: boolean; riskDollars?: number } | null;
  calibrated: boolean;
}): boolean {
  return input.reviewerStatus === "confirmed"
    && Boolean(input.candidate?.entryActivated)
    && input.calibrated
    && Boolean(input.candidate?.riskDollars && input.candidate.riskDollars > 0 && input.candidate.riskDollars <= 500);
}

function levelByKind(extraction: ChartExtraction, kind: string): number | null {
  return extraction.levels.find((level) => level.kind === kind && level.price !== null)?.price ?? null;
}

function asCandle(input: ChartExtraction["candles"][number]): Candle | null {
  const openTime = Date.parse(input.openTime);
  if (!Number.isFinite(openTime) || ![input.open, input.high, input.low, input.close, input.volume].every(Number.isFinite)) return null;
  return { openTime, closeTime: openTime + 5 * 60_000, open: input.open, high: input.high, low: input.low, close: input.close, volume: input.volume, isComplete: input.isComplete };
}

export function evaluateUploadedChart(
  extraction: ChartExtraction,
  metadata: UploadedChartMetadata,
  checksum: string,
): UploadedChartEvaluation {
  const missingEvidence: string[] = [];
  if (!extraction.calibration.pricesCalibrated) missingEvidence.push("Unreadable or uncalibrated price axis");
  if (!extraction.calibration.timestampsCalibrated) missingEvidence.push("Missing or uncalibrated timestamps");
  if (!extraction.direction) missingEvidence.push("Entry direction");
  if (extraction.previousCandleIndex === null || extraction.patienceCandleIndex === null || extraction.entryDecisionCandleIndex === null) missingEvidence.push("Previous, patience, and entry-decision candles");
  const candles = extraction.candles.map(asCandle);
  if (candles.some((candle) => candle === null)) missingEvidence.push("Complete OHLC candle values");
  const normalized = candles.filter((candle): candle is Candle => candle !== null).sort((a, b) => a.openTime - b.openTime);
  const entryIndex = extraction.entryDecisionCandleIndex;
  const patienceIndex = extraction.patienceCandleIndex;
  const previousIndex = extraction.previousCandleIndex;
  if (entryIndex === null || patienceIndex === null || previousIndex === null || previousIndex !== patienceIndex - 1 || patienceIndex !== entryIndex - 1) {
    missingEvidence.push("A contiguous causal P→E candle sequence");
  }
  if (missingEvidence.length) {
    return { status: "Insufficient chart evidence", candidate: null, missingEvidence, causalCutoff: extraction.entryTimestamp, strategyDetail: "The image did not provide enough calibrated causal evidence to run the existing patience predicate.", riskApproved: false };
  }
  const previousIndexValue = previousIndex as number;
  const patienceIndexValue = patienceIndex as number;
  const entryIndexValue = entryIndex as number;
  const previous = normalized[previousIndexValue]!;
  const patience = normalized[patienceIndexValue]!;
  const entry = normalized[entryIndexValue]!;
  const direction = extraction.direction!;
  const trend: TrendDirection = extraction.trend;
  const ntzHigh = levelByKind(extraction, "ntz_high");
  const ntzLow = levelByKind(extraction, "ntz_low");
  const engine = patienceCandleEngine(normalized.slice(0, entryIndexValue + 1), direction, {
    eligibilityEvents: [{ time: patience.openTime, reason: "pullback", detail: "Uploaded chart marked a qualifying pullback context." }],
    trend,
    directionSource: "CONFIRMED_15M_TREND",
    tickSize: 0.25,
    finalizedNtz: ntzHigh !== null && ntzLow !== null ? { high: ntzHigh, low: ntzLow, complete: true } : null,
    requireFinalizedNtz: ntzHigh !== null && ntzLow !== null,
  });
  const cutoff = new Date(entry.closeTime).toISOString();
  if (engine.state !== "ENTRY_TRIGGERED" || engine.triggerPrice === null || engine.strategyStopPrice === null) {
    const hasShape = engine.state === "PATIENCE_CANDLE_VALID" || engine.state === "TRIGGER_CANDLE_ACTIVE" || engine.state === "BREAK_DETECTED_WAITING_FOR_BUFFER";
    return {
      status: hasShape ? "Qualified setup—entry not activated" : "No strategy setup detected",
      candidate: null,
      missingEvidence: hasShape && !extraction.entryActivated ? ["Entry activation at the governed 8-tick confirmation buffer"] : [],
      causalCutoff: cutoff,
      strategyDetail: engine.detail,
      riskApproved: false,
    };
  }
  if (!extraction.entryActivated) {
    return { status: "Qualified setup—entry not activated", candidate: null, missingEvidence: ["Entry activation is not visible"], causalCutoff: cutoff, strategyDetail: engine.detail, riskApproved: false };
  }
  const targetPrice = extraction.levels.find((level) => level.kind === "target" && level.price !== null)?.price ?? null;
  const riskPoints = Math.abs(engine.triggerPrice - engine.strategyStopPrice);
  const riskDollars = Number((riskPoints * 5 * 2).toFixed(2));
  const candidate: UploadedChartCandidate = {
    candidateId: `uploaded:${checksum.slice(0, 20)}:${entry.openTime}`,
    source: "uploaded_chart",
    direction,
    primaryEdge: "PATIENCE_CANDLE_CONTINUATION",
    matchedEdges: [],
    supportingConfluences: extraction.rules.filter((rule) => rule.status === "pass" && !rule.mandatory).map((rule) => rule.name),
    setupGrade: extraction.confidence >= 0.9 ? "A++" : extraction.confidence >= 0.75 ? "A+" : "A",
    patienceCandle: { openTime: new Date(patience.openTime).toISOString(), closeTime: new Date(patience.closeTime).toISOString(), high: patience.high, low: patience.low },
    entryDecisionCandle: { openTime: new Date(entry.openTime).toISOString(), closeTime: new Date(entry.closeTime).toISOString() },
    entryTriggerPrice: engine.triggerPrice,
    stopPrice: engine.strategyStopPrice,
    targetPrice: targetPrice ?? null,
    contracts: 2,
    riskDollars,
    evaluationCutoff: cutoff,
    entryActivated: true,
    outcome: "open_unscored",
    exitPrice: extraction.exitPrice,
    exitTimestamp: extraction.exitTimestamp,
    pnl: null,
    formulaVersion: FORMULA_VERSION,
    formulaHash: crypto.createHash("sha256").update(FORMULA_VERSION).digest("hex"),
  };
  return {
    status: candidate.outcome === "closed_modeled" ? "Qualified setup—closed modeled Shadow trade" : "Qualified setup—entry activated, outcome open",
    candidate,
    missingEvidence: candidate.targetPrice === null ? ["Authoritative target level"] : [],
    causalCutoff: cutoff,
    strategyDetail: engine.detail,
    riskApproved: riskDollars > 0 && riskDollars <= 500,
  };
}

export async function analyzeChartImage(
  bytes: Buffer,
  metadata: UploadedChartMetadata,
): Promise<{ extraction: ChartExtraction; evaluation: UploadedChartEvaluation }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  const mime = detectImageMime(bytes);
  if (!mime || mime !== metadata.mimeType) throw new Error("The uploaded bytes do not match an allowed PNG, JPEG, or WebP image.");
  const prompt = `You are a strict evidence extractor for LevelStory, a deterministic MES Shadow Mode strategy.
Analyze only what is visible in the chart image. Do not infer hidden candles, Level 2, tape, prices, timestamps, or exits.
Return JSON only with the requested schema. Extract at most 120 visible completed 5-minute candles in chronological order when their OHLC values and timestamps can be calibrated.
The causal candidate must use only candles at or before the entry-decision candle. Later candles may describe an exit, but must never change setup qualification.
Set pricesCalibrated or timestampsCalibrated false when the axis cannot support reliable numeric values.
The patience rule is inclusive: a long patience high may equal the previous high, and a short patience low may equal the previous low.
Metadata supplied by the reviewer: ${JSON.stringify({
    tradingDate: metadata.tradingDate,
    symbol: metadata.symbol,
    timeframe: metadata.timeframe,
    timezone: metadata.timezone,
    session: metadata.session,
    visibleStart: metadata.visibleStart,
    visibleEnd: metadata.visibleEnd,
    chartNote: metadata.chartNote,
  })}`;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL_VERSION,
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: [{ type: "text", text: "Extract the visible LevelStory evidence from this image." }, { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}`, detail: "high" } }] },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Vision analysis failed (${response.status}).`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("Vision analysis returned no structured result.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Vision analysis returned malformed structured output.");
  }
  const validated = chartExtractionSchema.safeParse(parsed);
  if (!validated.success) throw new Error("Vision analysis returned incomplete or invalid evidence.");
  const extraction = validated.data;
  return { extraction, evaluation: evaluateUploadedChart(extraction, metadata, imageChecksum(bytes)) };
}