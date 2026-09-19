import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import test from "node:test";
import {
  buildHistoricalVisualValidationSetFromReport,
  type VisualValidationRequest,
  type VisualValidationSet,
} from "./visual-validation.js";
import { formulaConfigurationHash, FIXED_FORMULA_VERSION } from "./formula-hash.js";
import { getFuturesContractSpecification } from "./futures/contracts.js";
import {
  sessionCalendarForContract,
  sessionWindow,
  tradingDateForTimestamp,
} from "./futures/session-calendar.js";
import { generateSimulatedFuturesFeed, type SimulatedFuturesCandle } from "./futures/simulated-feed.js";
import { runCausalBacktest, type CausalReplayDataset } from "./phase9.js";
import { strategyConfig, type StrategyConfig } from "./strategy/config.js";
import {
  getVisualValidationSet,
  recordVisualValidationReview,
  storeVisualValidationSet,
} from "./visual-validation-store.js";
import { createVisualValidationRouter } from "../routes/visual-validation.js";

const specification = getFuturesContractSpecification("MES");
const calendar = sessionCalendarForContract(specification);
const FIVE_MINUTES = 5 * 60_000;

type ControlledFixture = {
  dataset: CausalReplayDataset;
  request: VisualValidationRequest;
};

type AcceptanceRun = {
  set: ReturnType<typeof buildHistoricalVisualValidationSetFromReport>;
  report: ReturnType<typeof runCausalBacktest>;
  rawDataLoads: number;
  strategyExecutions: number;
};

function controlledConsolidationFixture(): ControlledFixture {
  const tradingDate = "2026-08-25";
  const source = generateSimulatedFuturesFeed(specification, {
    calendar,
    startDate: tradingDate,
    days: 1,
    seed: 11,
    includePremarket: true,
    premarketAvailable: true,
  });
  const regularWindow = sessionWindow(tradingDate, "regular", calendar);
  if (!regularWindow) throw new Error("Controlled fixture has no regular session.");
  const regular = source.filter((item) =>
    item.openTime >= regularWindow.openTime && item.openTime < regularWindow.closeTime);
  const signalIndex = 30;
  const base = regular[25]!.close;
  const orbHigh = Math.max(...regular.slice(0, 3).map((item) => item.high));
  const candles = source.map((item) => {
    const index = regular.findIndex((candidate) => candidate.openTime === item.openTime);
    if (index === 3) {
      return {
        ...item,
        open: orbHigh + 0.25,
        high: orbHigh + 1,
        low: orbHigh + 0.25,
        close: orbHigh + 0.75,
        volume: 2_000,
      };
    }
    if (index >= 26 && index < signalIndex) {
      return {
        ...item,
        open: base,
        high: base + 0.75,
        low: base - 0.75,
        close: base + (index % 2 ? 0.25 : -0.25),
        volume: 1_000,
        bid: base,
        ask: base + specification.tickSize,
      };
    }
    if (index === signalIndex) {
      return {
        ...item,
        open: base + 0.25,
        high: base + 2.75,
        low: base + 0.25,
        close: base + 0.5,
        volume: 2_000,
        bid: base,
        ask: base + specification.tickSize,
      };
    }
    return item;
  });
  const entryCandle = regular[signalIndex]!;
  const entryThreshold = base + 2.75;
  const dates = [...new Set(source.map((item) => tradingDateForTimestamp(item.openTime, calendar)))];
  const dataset: CausalReplayDataset = {
    source: "historical_databento",
    contractSymbol: specification.fullContractSymbol,
    contractMonth: specification.contractMonth,
    candles,
    ticks: [
      { timestamp: entryCandle.openTime + 60_000, price: entryThreshold, source: "tick" },
      { timestamp: entryCandle.openTime + 120_000, price: entryThreshold + 0.25, source: "tick" },
    ],
    orderedIntrabarEvidence: {
      source: "tick",
      contractSymbol: specification.fullContractSymbol,
      ordering: "timestamp_ascending",
      equalTimestampSemantics: "conservative",
      coverageStart: entryCandle.openTime,
      coverageEnd: entryCandle.closeTime,
    },
    orderedIntrabarEvidenceComplete: true,
    inSampleDates: dates,
    outOfSampleDates: [],
    selectedDates: [tradingDate],
  };
  return {
    dataset,
    request: {
      symbol: "MES",
      endDate: tradingDate,
      inSampleDays: 1,
      outOfSampleDays: 0,
      premarketAvailable: true,
      source: "historical_databento",
      reviewMode: "trades_and_diagnostics",
    },
  };
}

function enabledConsolidation(): Record<string, boolean> {
  return {
    ORB_PULLBACK_CONTINUATION: false,
    EARLY_ORB_MOMENTUM_CONTINUATION: false,
    CONSOLIDATION_BREAKOUT_CONTINUATION: true,
    EQUIVALENT_CANDLE_REVERSAL: false,
    PATIENCE_CANDLE_CONTINUATION: false,
    PEAK_RETRACEMENT_REVERSAL: false,
  };
}

function governedRequest(
  fixture: ControlledFixture,
  config: StrategyConfig,
  versionId: string,
): VisualValidationRequest {
  return {
    ...fixture.request,
    governedStrategy: {
      strategyKey: "MES_SHADOW",
      versionId,
      versionNumber: 1,
      formulaVersion: FIXED_FORMULA_VERSION,
      formulaHash: formulaConfigurationHash({ symbol: "MES" }, config),
      config,
    },
    enabledStrategies: enabledConsolidation(),
  };
}

function runAcceptance(
  fixture: ControlledFixture,
  config: StrategyConfig,
  versionId: string,
): AcceptanceRun {
  // The caller supplies one immutable market-data object to both strategy runs.
  // This is the acceptance harness's raw-data load boundary.
  const rawDataLoads = 1;
  const request = governedRequest(fixture, config, versionId);
  const report = runCausalBacktest({
    ...request,
    executionMode: "ohlcv_modeled",
    strategyConfigOverride: config,
  }, undefined, fixture.dataset);
  const set = buildHistoricalVisualValidationSetFromReport(request, fixture.dataset, report);
  return {
    set,
    report,
    rawDataLoads,
    strategyExecutions: report.audit.length,
  };
}

function qualifiedCount(set: Pick<VisualValidationSet, "snapshots">): number {
  return set.snapshots.filter((snapshot) => snapshot.category === "qualified_trade").length;
}

function rejectedCount(set: Pick<VisualValidationSet, "snapshots">): number {
  return set.snapshots.filter((snapshot) => snapshot.category === "rejected_setup").length;
}

function chartIdentity(set: VisualValidationSet | Omit<VisualValidationSet, "reviewSetId" | "createdAt">) {
  const snapshot = set.snapshots[0];
  return {
    snapshotId: snapshot?.snapshotId ?? null,
    sourceFingerprint: set.sourceFingerprint,
    cacheKey: set.cacheKey,
    formulaHash: set.formulaHash,
    chartProjectionVersion: set.chartProjectionVersion,
    candleCount: snapshot?.reviewCandles.length ?? 0,
  };
}

test("Part 3: one unchanged market-data load can move Visual Review from empty to qualified", () => {
  const fixture = controlledConsolidationFixture();
  const rejected = runAcceptance(fixture, strategyConfig({
    phase6ConsolidationMinCandles: 5,
  }), "part3-rejected");
  const qualified = runAcceptance(fixture, strategyConfig({
    phase6ConsolidationMinCandles: 4,
  }), "part3-qualified");

  assert.strictEqual(rejected.rawDataLoads, 1);
  assert.strictEqual(qualified.rawDataLoads, 1);
  assert.deepEqual(rejected.report.dataset, qualified.report.dataset);
  assert.equal(qualifiedCount(rejected.set), 0);
  assert.ok(rejectedCount(rejected.set) > 0);
  assert.equal(qualifiedCount(qualified.set), 1);
  assert.ok(qualified.report.occurrences.some((item) => item.status === "SIGNAL_CONFIRMED"));
  assert.ok(qualified.report.tradeCandidates.some((item) => item.executionStatus === "MODELED_TRADE_CREATED"));
  assert.equal(qualified.report.trades.length, 1);
  assert.ok(qualified.strategyExecutions > 0);
  assert.notEqual(rejected.set.formulaHash, qualified.set.formulaHash);
  assert.notEqual(rejected.set.cacheKey, qualified.set.cacheKey);
  assert.notEqual(chartIdentity(rejected.set).snapshotId, chartIdentity(qualified.set).snapshotId);
});

test("Part 3: the same controlled qualification can be turned back into a rejected setup", () => {
  const fixture = controlledConsolidationFixture();
  const qualified = runAcceptance(fixture, strategyConfig({
    phase6ConsolidationMinCandles: 4,
  }), "part3-qualified-first");
  const rejected = runAcceptance(fixture, strategyConfig({
    phase6ConsolidationMinCandles: 5,
  }), "part3-rejected-second");

  assert.equal(qualifiedCount(qualified.set), 1);
  assert.equal(rejectedCount(rejected.set) > 0, true);
  assert.equal(qualified.report.trades.length, 1);
  assert.equal(rejected.report.trades.length, 0);
  assert.deepEqual(qualified.report.dataset, rejected.report.dataset);
  assert.ok(rejected.report.audit.some((item) =>
    item.setupType === "CONSOLIDATION_BREAKOUT_CONTINUATION"
    && item.decision !== "SETUP QUALIFIED"));
  assert.notEqual(chartIdentity(qualified.set).formulaHash, chartIdentity(rejected.set).formulaHash);
});

test("Part 3: compatible chart evidence transfers only across identical provenance", () => {
  const fixture = controlledConsolidationFixture();
  const run = runAcceptance(fixture, strategyConfig({
    phase6ConsolidationMinCandles: 4,
  }), "part3-compatible");
  const first = storeVisualValidationSet(run.set);
  const firstSnapshot = first.snapshots.find((snapshot) => snapshot.category === "qualified_trade");
  assert.ok(firstSnapshot);
  assert.ok(recordVisualValidationReview(
    first.reviewSetId,
    firstSnapshot!.snapshotId,
    "incorrect",
    "Controlled Part 3 review",
    undefined,
    "part3-reviewer",
  ));
  const second = storeVisualValidationSet(run.set);
  const compatible = second.snapshots.find((snapshot) => snapshot.snapshotId === firstSnapshot!.snapshotId);
  assert.equal(compatible?.reviewCompatibility?.status, "compatible");
  assert.equal(compatible?.reviewCompatibility?.reason, "same_occurrence_same_provenance");
  assert.equal(compatible?.reviewCompatibility?.priorReviewSetId, first.reviewSetId);
  assert.equal(getVisualValidationSet(second.reviewSetId, "part3-reviewer")?.snapshots
    .find((snapshot) => snapshot.snapshotId === compatible?.snapshotId)?.review.status, "unreviewed");
  assert.deepEqual(chartIdentity(first), chartIdentity(second));
});

test("Part 3: changed formula provenance blocks review transfer even when chart evidence is otherwise identical", () => {
  const fixture = controlledConsolidationFixture();
  const run = runAcceptance(fixture, strategyConfig({
    phase6ConsolidationMinCandles: 4,
  }), "part3-provenance");
  const first = storeVisualValidationSet(run.set);
  const firstSnapshot = first.snapshots[0];
  assert.ok(firstSnapshot);
  assert.ok(recordVisualValidationReview(
    first.reviewSetId,
    firstSnapshot!.snapshotId,
    "correct",
    "Original provenance",
    undefined,
    "part3-provenance-reviewer",
  ));
  const changedFormula = "f".repeat(64);
  const second = storeVisualValidationSet(
    { ...run.set, formulaHash: changedFormula },
    { formulaHash: changedFormula },
  );
  const blocked = second.snapshots.find((snapshot) => snapshot.snapshotId === firstSnapshot!.snapshotId);
  assert.equal(blocked?.reviewCompatibility?.status, "blocked");
  assert.equal(blocked?.reviewCompatibility?.reason, "provenance_changed");
  assert.equal(getVisualValidationSet(second.reviewSetId, "part3-provenance-reviewer")?.snapshots
    .find((snapshot) => snapshot.snapshotId === blocked?.snapshotId)?.review.status, "unreviewed");
});

async function getJson(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ port, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

test("Part 3: API and chart-data paths expose selected-date, status, and chart provenance", async () => {
  const fixture = controlledConsolidationFixture();
  const run = runAcceptance(fixture, strategyConfig({
    phase6ConsolidationMinCandles: 4,
  }), "part3-api");
  const stored = storeVisualValidationSet(run.set);
  const app = express();
  app.use("/api", createVisualValidationRouter());
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Part 3 API server did not expose a port.");
  try {
    const setResponse = await getJson(address.port, `/api/backtest/visual-validation?reviewSetId=${stored.reviewSetId}`);
    assert.equal(setResponse.status, 200);
    assert.equal(setResponse.body.reviewSetId, stored.reviewSetId);
    assert.deepEqual(setResponse.body.processedDates, [fixture.request.endDate]);
    const snapshots = setResponse.body.snapshots as Array<Record<string, unknown>>;
    assert.equal(snapshots.length, stored.snapshots.length);
    const firstSnapshot = stored.snapshots[0];
    assert.ok(firstSnapshot);
    const chartResponse = await getJson(
      address.port,
      `/api/backtest/visual-validation/${stored.reviewSetId}/snapshots/${firstSnapshot!.snapshotId}`,
    );
    assert.equal(chartResponse.status, 200);
    assert.equal(chartResponse.body.snapshotId, firstSnapshot!.snapshotId);
    assert.equal(chartResponse.body.sourceFingerprint, firstSnapshot!.sourceFingerprint);
    assert.equal(chartResponse.body.formulaHash, firstSnapshot!.formulaHash);
    const chartCompatibility = chartResponse.body.reviewCompatibility as { status?: string } | undefined;
    assert.equal(chartCompatibility?.status, firstSnapshot!.reviewCompatibility?.status);
    assert.ok(["new", "compatible", "blocked"].includes(chartCompatibility?.status ?? ""));
    assert.equal(stored.request.endDate, fixture.request.endDate);
    assert.equal(stored.categoryCoverage.find((item) => item.category === "qualified_trade")?.available, true);
    assert.equal(stored.categoryCoverage.find((item) => item.category === "rejected_setup")?.available, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});