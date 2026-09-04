import assert from "node:assert/strict";
import test from "node:test";
import {
  detectImageMime,
  evaluateUploadedChart,
  imageChecksum,
  uploadedChartDuplicateWarning,
  uploadedChartReplayEligibility,
  validateUploadedChartBytes,
  type ChartExtraction,
  type UploadedChartMetadata,
} from "./uploaded-chart-analysis.js";
import { isSafeUploadedChartObjectPath } from "./uploaded-chart-storage.js";

const metadata: UploadedChartMetadata = {
  tradingDate: "2026-09-04",
  symbol: "MES",
  timeframe: "5m",
  timezone: "America/New_York",
  session: "regular",
  originalFilename: "chart.png",
  objectPath: "/objects/uploads/chart/123e4567-e89b-12d3-a456-426614174000",
  mimeType: "image/png",
  sizeBytes: 32,
};

function extraction(overrides: Partial<ChartExtraction> = {}): ChartExtraction {
  return {
    summary: "Visible causal P to E sequence.",
    rules: [],
    calibration: { priceAxisVisible: true, timeAxisVisible: true, pricesCalibrated: true, timestampsCalibrated: true, notes: "" },
    trend: "bullish",
    candles: [
      { openTime: "2026-09-04T13:30:00.000Z", open: 100, high: 102, low: 98, close: 100.5, volume: 100, isComplete: true },
      { openTime: "2026-09-04T13:35:00.000Z", open: 100.5, high: 102, low: 97, close: 101.5, volume: 120, isComplete: true },
      { openTime: "2026-09-04T13:40:00.000Z", open: 101.5, high: 104, low: 100, close: 104, volume: 140, isComplete: true },
    ],
    levels: [],
    direction: "long",
    previousCandleIndex: 0,
    patienceCandleIndex: 1,
    entryDecisionCandleIndex: 2,
    entryPrice: 104,
    entryTimestamp: "2026-09-04T13:40:00.000Z",
    entryActivated: true,
    exitCandleIndex: null,
    exitPrice: null,
    exitTimestamp: null,
    exitReason: null,
    confidence: 0.92,
    ...overrides,
  };
}

test("uploaded image validation accepts PNG, JPEG, and WebP signatures only", () => {
  assert.equal(detectImageMime(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(detectImageMime(Buffer.from([255, 216, 255, 0])), "image/jpeg");
  assert.equal(detectImageMime(Buffer.from("RIFFxxxxWEBP")), "image/webp");
  assert.equal(detectImageMime(Buffer.from("<svg></svg>")), null);
});

test("server-side byte validation rejects spoofed MIME, SVG, and oversized input", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(validateUploadedChartBytes(png, "image/png"), "image/png");
  assert.throws(() => validateUploadedChartBytes(png, "image/jpeg"), /not a valid/);
  assert.throws(() => validateUploadedChartBytes(Buffer.from("<svg></svg>"), "image/png"), /not a valid/);
  assert.throws(() => validateUploadedChartBytes(Buffer.alloc(10 * 1024 * 1024 + 1), "image/png"), /10 MB/);
});

test("private object paths are constrained to generated chart paths", () => {
  assert.equal(isSafeUploadedChartObjectPath(metadata.objectPath), true);
  assert.equal(isSafeUploadedChartObjectPath("/objects/uploads/chart/../../secrets"), false);
  assert.equal(isSafeUploadedChartObjectPath("/objects/other/file.png"), false);
});

test("a calibrated causal sequence reuses the Phase 5 patience predicate", () => {
  const result = evaluateUploadedChart(extraction(), metadata, imageChecksum(Buffer.from("chart")));
  assert.equal(result.status, "Qualified setup—entry activated, outcome open");
  assert.equal(result.candidate?.source, "uploaded_chart");
  assert.equal(result.candidate?.entryTriggerPrice, 104);
  assert.equal(result.candidate?.stopPrice, 94);
  assert.equal(result.candidate?.pnl, null);
});

test("future candles cannot influence setup qualification", () => {
  const result = evaluateUploadedChart(extraction({
    candles: [
      ...extraction().candles,
      { openTime: "2026-09-04T13:45:00.000Z", open: 104, high: 104.5, low: 90, close: 91, volume: 300, isComplete: true },
    ],
  }), metadata, imageChecksum(Buffer.from("future-candle")));
  assert.equal(result.status, "Qualified setup—entry activated, outcome open");
  assert.equal(result.candidate?.evaluationCutoff, "2026-09-04T13:45:00.000Z");
});

test("missing calibration produces insufficient evidence instead of a candidate", () => {
  const result = evaluateUploadedChart(extraction({
    calibration: { priceAxisVisible: false, timeAxisVisible: true, pricesCalibrated: false, timestampsCalibrated: true, notes: "Price axis is cropped." },
  }), metadata, imageChecksum(Buffer.from("uncalibrated")));
  assert.equal(result.status, "Insufficient chart evidence");
  assert.equal(result.candidate, null);
  assert.match(result.missingEvidence.join(" "), /price axis/i);
});

test("duplicate detection compares causal identity instead of image filename", () => {
  const result = evaluateUploadedChart(extraction(), metadata, imageChecksum(Buffer.from("duplicate")));
  assert.ok(result.candidate);
  const duplicate = uploadedChartDuplicateWarning({
    ...metadata,
    activeCandidate: {
      tradingDate: metadata.tradingDate,
      contractSymbol: metadata.symbol,
      direction: "long",
      entryCandleOpenTime: "2026-09-04T13:40:00.000Z",
      entryTriggerPrice: 104,
      primaryEdge: "PATIENCE_CANDLE_CONTINUATION",
    },
  }, result.candidate);
  assert.equal(duplicate?.possibleDuplicateOf, "active_generated_candidate");
});

test("combined replay requires reviewer confirmation, calibration, activation, and bounded risk", () => {
  const candidate = { entryActivated: true, riskDollars: 100 };
  assert.equal(uploadedChartReplayEligibility({ reviewerStatus: "unreviewed", candidate, calibrated: true }), false);
  assert.equal(uploadedChartReplayEligibility({ reviewerStatus: "confirmed", candidate, calibrated: false }), false);
  assert.equal(uploadedChartReplayEligibility({ reviewerStatus: "confirmed", candidate: { ...candidate, entryActivated: false }, calibrated: true }), false);
  assert.equal(uploadedChartReplayEligibility({ reviewerStatus: "confirmed", candidate: { ...candidate, riskDollars: 501 }, calibrated: true }), false);
  assert.equal(uploadedChartReplayEligibility({ reviewerStatus: "confirmed", candidate, calibrated: true }), true);
});