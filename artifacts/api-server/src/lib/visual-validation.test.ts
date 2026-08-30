import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildVisualValidationSet,
  buildHistoricalVisualValidationSetFromReport,
  categoriesFor,
  createVisualValidationTeachingExample,
  matchingTrade,
  resolveQualifyingLevelAtCandle,
  validateVisualValidationTeaching,
  type VisualValidationTeachingInput,
  type VisualValidationRequest,
  type VisualValidationCategory,
} from "./visual-validation.js";
import { createVisualValidationFixtures } from "./visual-validation-fixtures.js";
import type { BacktestAuditRecord, BacktestTrade, HistoricalOccurrence } from "./phase9.js";
import { consolidationThresholds, DEFAULT_STRATEGY_CONFIG } from "./strategy/config.js";
import {
  buildVisualValidationDiscrepancyReport,
  getVisualValidationSet,
  recordVisualValidationReview,
  storeVisualValidationSet,
  analyzeVisualValidationTeaching,
  resolveObservedEntryCandle,
} from "./visual-validation-store.js";
import { analyzePullback, type BreakoutEvent } from "./strategy/phase4.js";
import { strategyConfig } from "./strategy/config.js";
import { getFuturesContractSpecification } from "./futures/contracts.js";
import type { Candle } from "./strategy/types.js";

const request: VisualValidationRequest = {
  symbol: "MES",
  endDate: "2026-08-26",
  inSampleDays: 2,
  outOfSampleDays: 1,
  seed: 11,
  premarketAvailable: true,
};

test("visual-validation sample selection is deterministic", () => {
  const first = buildVisualValidationSet(request);
  const second = buildVisualValidationSet(request);
  assert.deepEqual(first, second);
  assert.ok(first.snapshots.length > 0);
  assert.equal(first.formulaHash, second.formulaHash);
});

test("simulated visual-validation requests default their persisted source", () => {
  const set = buildVisualValidationSet(request);
  assert.equal(set.source, "simulated");
  assert.equal(set.request.source, "simulated");
});

test("visual-validation sets expose build, formula, source, and freshness provenance", () => {
  const set = buildVisualValidationSet(request);
  assert.ok(set.buildId.length > 0);
  assert.equal(set.currentBuildId, set.buildId);
  assert.equal(set.stale, false);
  assert.match(set.formulaHash, /^[0-9a-f]{64}$/);
  assert.match(set.sourceFingerprint, /^[0-9a-f]{64}$/);

  const stored = storeVisualValidationSet({ ...set, buildId: "previous-build" });
  assert.equal(stored.stale, true);
  assert.equal(stored.currentBuildId, set.currentBuildId);
});

test("historical projection keeps contract-local candles and truthful category gaps", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "strong_breakout");
  assert.ok(fixture);
  const firstCandle = fixture.dataset.candles[0];
  assert.ok(firstCandle);
  const foreignContractCandle = { ...firstCandle, contractSymbol: "MESH6" };
  const dataset = {
    ...fixture.dataset,
    source: "historical_databento_multicontract" as const,
    candles: [...fixture.dataset.candles, foreignContractCandle],
  };
  const set = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento", reviewMode: "trades_and_diagnostics" },
    dataset,
    {
      symbol: "MES",
      formulaHash: fixture.audit.id.padEnd(64, "0").slice(0, 64),
      executionMode: "ohlcv_modeled",
      audit: [fixture.audit],
      trades: fixture.trade ? [fixture.trade] : [],
    },
  );
  assert.equal(set.source, "historical_databento");
  assert.ok(set.snapshots.length >= 1);
  assert.ok(set.snapshots.some((snapshot) => snapshot.category === "strong_breakout"));
  assert.ok(set.snapshots.every((snapshot) => snapshot.reviewCandles.every((candle) => candle.contractSymbol === fixture.audit.contractSymbol)));
  assert.ok(set.snapshots.every((snapshot) => snapshot.machineCandles.every((candle) => candle.contractSymbol === fixture.audit.contractSymbol)));
  assert.equal(set.categoryCoverage.find((item) => item.category === "qualified_trade")?.available, false);
  assert.equal(set.categoryCoverage.find((item) => item.category === "strong_breakout")?.count, 1);
  assert.equal(set.snapshots[0]?.evaluationCursor.futureCandleAccess, false);
  assert.equal(set.snapshots[0]?.futureCandleAccess, false);
});

test("historical visual review keeps confirmed signals ledger-only and opts into no-entry diagnostics", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "strong_breakout");
  assert.ok(fixture);
  const dataset = { ...fixture.dataset, source: "historical_databento_multicontract" as const };
  const report = {
    symbol: "MES",
    formulaHash: fixture.audit.id.padEnd(64, "0").slice(0, 64),
    executionMode: "ohlcv_modeled" as const,
    audit: [fixture.audit],
    trades: [],
  };
  const tradeOnly = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento" },
    dataset,
    report,
  );
  assert.equal(tradeOnly.snapshots.length, 0);
  assert.equal(tradeOnly.categoryCoverage.find((item) => item.category === "strong_breakout")?.available, false);
  const confirmedSignals = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento", reviewMode: "confirmed_signals" },
    dataset,
    report,
  );
  assert.equal(confirmedSignals.snapshots.some((snapshot) => snapshot.category === "strong_breakout"), false);
  assert.equal(confirmedSignals.categoryCoverage.find((item) => item.category === "strong_breakout")?.available, false);
  const withDiagnostics = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento", reviewMode: "trades_and_diagnostics" },
    dataset,
    report,
  );
  assert.ok(withDiagnostics.snapshots.length >= 1);
  assert.ok(withDiagnostics.snapshots.some((snapshot) => snapshot.category === "strong_breakout"));
});

test("historical visual review retains every occurrence in a category", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "strong_breakout");
  assert.ok(fixture);
  const second = {
    ...fixture.audit,
    id: `${fixture.audit.id}-second`,
    evaluatedCandleOpenTime: new Date(Date.parse(fixture.audit.evaluatedCandleOpenTime) + 5 * 60_000).toISOString(),
  };
  const dataset = { ...fixture.dataset, source: "historical_databento_multicontract" as const };
  const set = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento", reviewMode: "trades_and_diagnostics" },
    dataset,
    {
      symbol: "MES",
      formulaHash: fixture.audit.id.padEnd(64, "0").slice(0, 64),
      executionMode: "ohlcv_modeled",
      audit: [fixture.audit, second],
      trades: [],
    },
  );
  const strong = set.snapshots.filter((snapshot) => snapshot.category === "strong_breakout");
  assert.equal(strong.length, 2);
  assert.equal(set.categoryCoverage.find((item) => item.category === "strong_breakout")?.count, 2);
  assert.notEqual(strong[0]?.snapshotId, strong[1]?.snapshotId);
});

test("historical trade matching keeps canonical strategy identity across audit labels", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "qualified_trade");
  assert.ok(fixture?.trade);
  const aliasedAudit = {
    ...fixture.audit,
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    id: "aliased-prior-date-audit",
    modeledFillObservationTime: null,
    exitCandleOpenTime: null,
    exitCandleCloseTime: null,
  };
  const matched = matchingTrade(aliasedAudit, [fixture.trade]);
  assert.equal(matched?.id, fixture.trade.id);
});

test("historical Visual Review prioritizes the earliest primary-window occurrence without dropping afternoon evidence", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "strong_breakout");
  assert.ok(fixture);
  const morning = {
    ...fixture.audit,
    id: "morning-breakout",
    evaluatedCandleOpenTime: "2026-08-26T14:30:00.000Z",
  };
  const afternoon = {
    ...fixture.audit,
    id: "afternoon-breakout",
    evaluatedCandleOpenTime: "2026-08-26T19:50:00.000Z",
  };
  const set = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento", reviewMode: "trades_and_diagnostics" },
    { ...fixture.dataset, source: "historical_databento_multicontract" as const },
    {
      symbol: "MES",
      formulaHash: fixture.audit.id.padEnd(64, "0").slice(0, 64),
      executionMode: "ohlcv_modeled",
      audit: [afternoon, morning],
      trades: [],
    },
  );
  const strong = set.snapshots.filter((snapshot) => snapshot.category === "strong_breakout");
  assert.equal(strong.length, 2);
  assert.equal(strong[0]?.entryWindow, "primary");
  assert.equal(strong[1]?.entryWindow, "outside_primary");
  assert.match(strong[0]?.selectionReason ?? "", /primary entry window/);
  assert.equal(set.defaultSelectionReason, strong[0]?.selectionReason);
});

test("historical Visual Review maps a ledger occurrence to its exact L anchor", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "pullback");
  assert.ok(fixture);
  const lCandle = fixture.dataset.candles.find((candle) => candle.isComplete);
  assert.ok(lCandle);
  const occurrence: HistoricalOccurrence = {
    occurrenceId: "occurrence-pullback-exact",
    auditId: fixture.audit.id,
    kind: "pullback",
    strategyCandidate: "ORB_PULLBACK_CONTINUATION",
    secondaryStrategyMatches: [],
    tradingDate: fixture.audit.tradingDate,
    contractSymbol: fixture.audit.contractSymbol,
    contractMonth: fixture.audit.contractMonth,
    direction: fixture.audit.direction,
    lTimestamp: new Date(lCandle.openTime).toISOString(),
    lEventId: "pullback|touch|exact",
    lInteractionType: "touch",
    lCandle: {
      openTime: lCandle.openTime,
      closeTime: lCandle.closeTime,
      open: lCandle.open,
      high: lCandle.high,
      low: lCandle.low,
      close: lCandle.close,
      volume: lCandle.volume,
      isComplete: lCandle.isComplete,
    },
    previousComparisonTimestamp: null,
    patienceTimestamp: null,
    patienceCandle: null,
    candidateShapeResult: null,
    expectedEntryTimestamp: null,
    confirmationThreshold: null,
    confirmationExcursion: null,
    entryTimestamp: null,
    entryCandle: null,
    levelIdentifiers: ["ORB"],
    levelValues: { ORB: lCandle.close },
    levelDistancesTicks: { ORB: 0 },
    levelTolerancePoints: { ORB: 3 },
    levelToleranceTicks: { ORB: 12 },
    levelInteractionTypes: { ORB: ["touch"] },
    confirmationBufferTicks: null,
    nextObservedCandle: null,
    status: "touch",
    reasonCode: "causal pullback interaction",
    evaluationCursor: new Date(lCandle.closeTime).toISOString(),
    formulaVersion: "test",
    formulaHash: "a".repeat(64),
    sourceFingerprint: "test",
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
    canonicalTrade: false,
  };
  const set = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento", reviewMode: "trades_and_diagnostics" },
    { ...fixture.dataset, source: "historical_databento_multicontract" as const },
    {
      symbol: "MES",
      formulaHash: fixture.audit.id.padEnd(64, "0").slice(0, 64),
      executionMode: "ohlcv_modeled",
      audit: [fixture.audit],
      trades: [],
      occurrences: [occurrence],
    },
  );
  const snapshot = set.snapshots.find((item) => item.category === "pullback");
  assert.ok(snapshot);
  assert.equal(snapshot.categoryAnchor?.occurrenceId, occurrence.occurrenceId);
  assert.equal(snapshot.categoryAnchor?.openTime, occurrence.lTimestamp);
});

test("Visual Review keeps expired P1 diagnostic-only and pairs the trade with adjacent P2 and E2", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "qualified_trade");
  assert.ok(fixture?.trade);
  const completed = fixture.dataset.candles
    .filter((candle) => candle.contractSymbol === fixture.audit.contractSymbol && candle.isComplete)
    .sort((first, second) => first.openTime - second.openTime);
  const p2Open = Date.parse(fixture.audit.patienceCandleOpenTime!);
  const p2Index = completed.findIndex((candle) => candle.openTime === p2Open);
  assert.ok(p2Index >= 2);
  const p1 = completed[p2Index - 2]!;
  const failedImmediate = completed[p2Index - 1]!;
  const p2 = completed[p2Index]!;
  const e2 = completed.find((candle) => candle.openTime === p2.closeTime);
  assert.ok(e2);
  const evidenceCandle = (candle: typeof p1): Record<string, number | boolean> => ({
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    isComplete: candle.isComplete,
  });
  const occurrence = (
    occurrenceId: string,
    patienceCandle: typeof p1,
    immediate: typeof failedImmediate,
    confirmed: boolean,
  ): HistoricalOccurrence => ({
    occurrenceId,
    auditId: fixture.audit.id,
    kind: "patience",
    strategyCandidate: "ORB_PULLBACK_CONTINUATION",
    secondaryStrategyMatches: [],
    tradingDate: fixture.audit.tradingDate,
    contractSymbol: fixture.audit.contractSymbol,
    contractMonth: fixture.audit.contractMonth,
    direction: "long",
    lTimestamp: null,
    lEventId: null,
    lInteractionType: null,
    lCandle: null,
    previousComparisonTimestamp: new Date(patienceCandle.openTime - 300_000).toISOString(),
    patienceTimestamp: new Date(patienceCandle.openTime).toISOString(),
    patienceCandle: evidenceCandle(patienceCandle),
    candidateShapeResult: true,
    expectedEntryTimestamp: new Date(patienceCandle.closeTime).toISOString(),
    confirmationThreshold: patienceCandle.high + 0.75,
    confirmationExcursion: Math.max(0, immediate.high - patienceCandle.high),
    entryTimestamp: confirmed ? new Date(immediate.openTime).toISOString() : null,
    entryCandle: confirmed ? evidenceCandle(immediate) : null,
    levelIdentifiers: [],
    levelValues: {},
    levelDistancesTicks: {},
    levelTolerancePoints: {},
    levelToleranceTicks: {},
    levelInteractionTypes: {},
    confirmationBufferTicks: 3,
    nextObservedCandle: confirmed ? null : evidenceCandle(immediate),
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
    status: confirmed ? "SIGNAL_CONFIRMED" : "EXPIRED_NO_IMMEDIATE_CONFIRMATION",
    reasonCode: confirmed ? "Immediate E2 confirmed P2." : "Immediate candle failed the three-tick buffer; P1 expired.",
    evaluationCursor: new Date(immediate.closeTime).toISOString(),
    formulaVersion: "test",
    formulaHash: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    canonicalTrade: confirmed,
  });
  const expired = occurrence("expired-p1", p1, failedImmediate, false);
  const confirmed = occurrence("confirmed-p2", p2, e2, true);
  const report = {
    symbol: "MES",
    formulaHash: "a".repeat(64),
    executionMode: "ohlcv_modeled" as const,
    audit: [fixture.audit],
    trades: [fixture.trade],
    occurrences: [expired, confirmed],
  };
  const tradeOnly = buildHistoricalVisualValidationSetFromReport(request, fixture.dataset, report);
  const tradePatience = tradeOnly.snapshots.filter((snapshot) => snapshot.category === "bullish_patience_candle");
  assert.deepEqual(tradePatience.map((snapshot) => snapshot.occurrenceId), ["confirmed-p2"]);
  assert.equal(tradePatience[0]?.tradeEvents.find((event) => event.event === "entry")?.openTime, confirmed.entryTimestamp);
  assert.equal(tradePatience[0]?.tradeEvents.find((event) => event.event === "patience")?.closeTime, confirmed.entryTimestamp);

  const diagnostics = buildHistoricalVisualValidationSetFromReport(
    { ...request, reviewMode: "trades_and_diagnostics" },
    fixture.dataset,
    report,
  );
  const expiredSnapshot = diagnostics.snapshots.find((snapshot) => snapshot.occurrenceId === "expired-p1");
  assert.ok(expiredSnapshot);
  assert.equal(expiredSnapshot.machineEvidence.trade, null);
  assert.deepEqual(expiredSnapshot.tradeEvents, []);
  assert.equal(expiredSnapshot.annotations.find((annotation) => annotation.id === "entry-candle")?.available, false);
  assert.equal(expiredSnapshot.annotations.find((annotation) => annotation.id === "patience-candle")?.label, "Expired patience candidate");

  const lateAudit = {
    ...fixture.audit,
    id: "late-audit",
    decision: "EXPIRED" as const,
    rejectionReason: "PATIENT",
    patienceState: "PATIENCE_CANDLE_EXPIRED" as const,
    triggerCandle: null,
    triggerCandleOpenTime: null,
    triggerCandleCloseTime: null,
  };
  const confirmedWithoutTrade = { ...confirmed, occurrenceId: "confirmed-late-audit", auditId: lateAudit.id, canonicalTrade: false };
  const confirmedSet = buildHistoricalVisualValidationSetFromReport(
    { ...request, reviewMode: "confirmed_signals" },
    fixture.dataset,
    {
      ...report,
      audit: [lateAudit],
      trades: [],
      occurrences: [confirmedWithoutTrade],
    },
  );
  assert.ok(confirmedSet.snapshots.some((snapshot) => snapshot.occurrenceId === confirmedWithoutTrade.occurrenceId));
  assert.equal(confirmedSet.snapshots.some((snapshot) => snapshot.category === "qualified_trade"), true);
});

test("visual-validation provides twelve distinct valid five-minute MES fixtures", () => {
  const set = buildVisualValidationSet(request);
  assert.equal(set.snapshots.length, 12);
  assert.deepEqual(
    set.snapshots.map((snapshot) => snapshot.category),
    [
      "qualified_trade",
      "stop_exit",
      "target_exit",
      "runner_exit",
      "bearish_patience_candle",
      "pullback",
      "consolidation",
      "ambiguous_candle",
      "bullish_patience_candle",
      "strong_breakout",
      "rejected_setup",
      "weak_orb_probe",
    ],
  );
  const fingerprints = new Set<string>();
  for (const snapshot of set.snapshots) {
    assert.equal(snapshot.symbol, "MES");
    assert.equal(snapshot.machineCandles.length, snapshot.evaluationCursor.visibleCandleCount);
    assert.ok(snapshot.reviewCandles.length >= snapshot.machineCandles.length);
    assert.equal(snapshot.outcomeContextEnd, snapshot.reviewCursor.closeTime);
    assert.ok(snapshot.machineCandles.length >= 35 && snapshot.machineCandles.length <= 50);
    const opens = snapshot.machineCandles.map((candle) => Date.parse(candle.openTime));
    for (let index = 0; index < snapshot.machineCandles.length; index += 1) {
      const candle = snapshot.machineCandles[index]!;
      assert.equal(Date.parse(candle.closeTime) - opens[index]!, 5 * 60_000);
      if (index > 0) assert.equal(opens[index]! - opens[index - 1]!, 5 * 60_000);
      assert.ok(candle.high >= Math.max(candle.open, candle.close));
      assert.ok(candle.low <= Math.min(candle.open, candle.close));
      assert.ok(candle.volume > 0);
    }
    assert.ok(new Set(snapshot.machineCandles.map((candle) => `${candle.open}:${candle.close}`)).size >= 12);
    assert.ok(new Set(snapshot.machineCandles.map((candle) => candle.volume)).size >= 12);
    fingerprints.add(snapshot.machineCandles.map((candle) => `${candle.openTime}:${candle.open}:${candle.high}:${candle.low}:${candle.close}:${candle.volume}`).join("|"));
  }
  assert.equal(fingerprints.size, set.snapshots.length);
  assert.ok(set.categoryCoverage.every((coverage) => coverage.available && coverage.count === 1));
});

test("visual-validation exposes separate premarket, causal indicator, coverage, and trade-event evidence", () => {
  const set = buildVisualValidationSet(request);
  const qualified = set.snapshots.find((snapshot) => snapshot.category === "qualified_trade");
  const rejected = set.snapshots.find((snapshot) => snapshot.category === "rejected_setup");
  assert.ok(qualified);
  assert.ok(rejected);
  assert.equal(qualified.premarketCandles.length, 66);
  assert.equal(qualified.indicatorSeries.length, qualified.reviewCandles.length);
  assert.ok(qualified.indicatorSeries.some((point) => point.visibility === "machine" && point.vwap !== null && point.ema200 !== null));
  assert.ok(qualified.indicatorSeries.some((point) => point.visibility === "human_only"));
  const patienceEvidence = qualified.machineEvidence.audit.patienceCandle as Record<string, unknown> | null;
  const patienceOpen = typeof patienceEvidence?.openTime === "number"
    ? patienceEvidence.openTime
    : typeof patienceEvidence?.openTime === "string" ? Date.parse(patienceEvidence.openTime) : Number.NaN;
  const patienceClose = typeof patienceEvidence?.closeTime === "number"
    ? patienceEvidence.closeTime
    : typeof patienceEvidence?.closeTime === "string" ? Date.parse(patienceEvidence.closeTime) : Number.NaN;
  const patienceIndicator = patienceEvidence
    ? qualified.indicatorSeries.find((point) => Date.parse(point.openTime) === patienceOpen && Date.parse(point.closeTime) === patienceClose)
    : undefined;
  const vwapAnnotation = qualified.annotations.find((annotation) => annotation.id === "vwap");
  assert.ok(patienceIndicator);
  assert.equal(vwapAnnotation?.price, patienceIndicator?.vwap);
  assert.ok(qualified.tradeEvents.some((event) => event.event === "entry"));
  assert.ok(qualified.tradeEvents.some((event) => event.event === "target"));
  assert.equal(rejected.tradeEvents.length, 0);
  assert.equal(rejected.coverage.find((item) => item.session === "primary")?.expectedCandleCount, 42);
  assert.equal(rejected.coverage.find((item) => item.session === "full_regular")?.expectedCandleCount, 78);
  assert.equal(rejected.futureCandleAccess, false);
});

test("every simulated category exposes an exact audit-derived anchor and related candle chain", () => {
  const set = buildVisualValidationSet(request);
  for (const snapshot of set.snapshots) {
    const anchor = snapshot.categoryAnchor;
    assert.equal(anchor.category, snapshot.category);
    assert.equal(anchor.auditId, snapshot.machineEvidence.audit.id);
    assert.equal(anchor.contractSymbol, snapshot.contractSymbol);
    assert.ok(snapshot.reviewCandles.some((candle) => candle.openTime === anchor.openTime));
    assert.ok(anchor.relatedCandles.some((candle) => candle.role === "evaluation"));
    assert.ok(anchor.relatedCandles.some((candle) => candle.role === "patience"));
    assert.ok(anchor.relatedCandles.some((candle) => candle.role === "entry"));
    assert.ok(anchor.relatedCandles.every((related) => snapshot.reviewCandles.some((candle) => candle.openTime === related.openTime)));
    if (snapshot.machineEvidence.trade) assert.equal(anchor.tradeId, snapshot.machineEvidence.trade.id);
  }
  const patience = set.snapshots.find((snapshot) => snapshot.category === "bullish_patience_candle");
  const breakout = set.snapshots.find((snapshot) => snapshot.category === "strong_breakout");
  assert.ok(patience);
  assert.ok(breakout);
  assert.equal(patience.categoryAnchor.openTime, patience.machineEvidence.audit.patienceCandleOpenTime);
  assert.equal(breakout.categoryAnchor.openTime, breakout.machineEvidence.audit.triggerCandleOpenTime);
});

test("historical category availability fails closed when its canonical anchor candle is absent", () => {
  const fixture = createVisualValidationFixtures(request).find((item) => item.category === "strong_breakout");
  assert.ok(fixture);
  assert.ok(fixture.audit.triggerCandleOpenTime);
  const triggerOpen = Date.parse(fixture.audit.triggerCandleOpenTime);
  const dataset = {
    ...fixture.dataset,
    source: "historical_databento_multicontract" as const,
    candles: fixture.dataset.candles.filter((candle) => candle.openTime !== triggerOpen),
  };
  const set = buildHistoricalVisualValidationSetFromReport(
    { ...request, source: "historical_databento" },
    dataset,
    {
      symbol: "MES",
      formulaHash: fixture.audit.id.padEnd(64, "0").slice(0, 64),
      executionMode: "ohlcv_modeled",
      audit: [fixture.audit],
      trades: fixture.trade ? [fixture.trade] : [],
    },
  );
  assert.equal(set.categoryCoverage.find((item) => item.category === "strong_breakout")?.available, false);
  assert.equal(set.snapshots.some((snapshot) => snapshot.category === "strong_breakout"), false);
});

test("primary review context keeps all 42 slots while full context reaches the 78-slot boundary", () => {
  const set = buildVisualValidationSet(request);
  const snapshot = set.snapshots[0];
  assert.ok(snapshot);
  assert.ok(snapshot.reviewCandles.some((candle) => candle.closeTime.endsWith("T20:00:00.000Z")));
  assert.equal(snapshot.coverage.find((item) => item.session === "primary")?.observedCandleCount, 42);
  assert.equal(snapshot.coverage.find((item) => item.session === "full_regular")?.observedCandleCount, 78);
  assert.equal(snapshot.coverage.find((item) => item.session === "primary")?.complete, true);
  assert.equal(snapshot.coverage.find((item) => item.session === "full_regular")?.complete, true);
});

test("visual-validation can explicitly omit premarket candles without changing primary evidence", () => {
  const withPremarket = buildVisualValidationSet(request);
  const withoutPremarket = buildVisualValidationSet({ ...request, premarketAvailable: false });
  assert.equal(withPremarket.snapshots[0]?.premarketCandles.length, 66);
  assert.equal(withoutPremarket.snapshots[0]?.premarketCandles.length, 0);
  assert.deepEqual(
    withoutPremarket.snapshots[0]?.machineCandles,
    withPremarket.snapshots[0]?.machineCandles,
  );
});

test("patience fixtures align direction and category evidence", () => {
  const set = buildVisualValidationSet(request);
  const bullish = set.snapshots.find((snapshot) => snapshot.category === "bullish_patience_candle");
  const bearish = set.snapshots.find((snapshot) => snapshot.category === "bearish_patience_candle");
  assert.ok(bullish);
  assert.ok(bearish);
  assert.equal(bullish.machineEvidence.audit.direction, "long");
  assert.match(bullish.machineEvidence.audit.trendEvidence, /^bullish:/);
  assert.equal(bullish.machineEvidence.audit.patienceState, "PATIENCE_CANDLE_VALID");
  assert.equal(bearish.machineEvidence.audit.direction, "short");
  assert.match(bearish.machineEvidence.audit.trendEvidence, /^bearish:/);
  assert.equal(bearish.machineEvidence.audit.patienceState, "PATIENCE_CANDLE_VALID");
  assert.notEqual(bullish.evaluationCursor.openTime, bearish.evaluationCursor.openTime);
  assert.notDeepEqual(bullish.machineCandles, bearish.machineCandles);
});

test("ORB, pullback, consolidation, and ambiguity fixtures expose explicit machine states", () => {
  const set = buildVisualValidationSet(request);
  const snapshot = (category: VisualValidationCategory) => {
    const result = set.snapshots.find((item) => item.category === category);
    assert.ok(result);
    return result;
  };
  assert.equal(snapshot("weak_orb_probe").machineEvidence.audit.orbState, "ORB_PROBE_WAIT");
  assert.match(snapshot("weak_orb_probe").machineEvidence.audit.volumeEvidence, /below the confirmation threshold/i);
  assert.match(snapshot("strong_breakout").machineEvidence.audit.breakoutEvidence, /closed beyond ORB/i);
  assert.match(snapshot("pullback").machineEvidence.audit.pullbackEvidence, /ORB high/i);
  assert.match(snapshot("pullback").machineEvidence.audit.criticalLevelEvidence, /recognized retracement level/i);
  assert.match(snapshot("consolidation").machineEvidence.audit.pullbackEvidence, /14 completed candles consolidated/i);
  assert.match(snapshot("ambiguous_candle").machineEvidence.audit.rejectionReason ?? "", /AMBIGUOUS_STOP_FIRST/);
  assert.deepEqual(snapshot("ambiguous_candle").machineEvidence.audit.ambiguityLabels, ["AMBIGUOUS_STOP_FIRST"]);
});

test("exit fixtures retain exact audit identity and outcome evidence", () => {
  const set = buildVisualValidationSet(request);
  const expectations: Array<[VisualValidationCategory, string]> = [
    ["stop_exit", "STRATEGY_STOP_REACHED"],
    ["target_exit", "TARGET_REACHED"],
    ["runner_exit", "RUNNER_EXITED"],
  ];
  for (const [category, eventLabel] of expectations) {
    const snapshot = set.snapshots.find((item) => item.category === category);
    assert.ok(snapshot);
    const audit = snapshot.machineEvidence.audit;
    const trade = snapshot.machineEvidence.trade;
    assert.ok(trade);
    assert.equal(matchingTrade(audit, [trade])?.id, trade.id);
    assert.equal(audit.exitCandleOpenTime, trade.audit?.exitCandleOpenTime);
    assert.equal(audit.exitCandleCloseTime, trade.audit?.exitCandleCloseTime);
    assert.ok(trade.audit?.eventLabels.includes(eventLabel));
  }
});

test("visual-validation snapshots never expose candles beyond their review cursor", () => {
  const set = buildVisualValidationSet(request);
  for (const snapshot of set.snapshots) {
    const reviewCursor = Date.parse(snapshot.reviewCursor.closeTime);
    for (const candle of snapshot.reviewCandles) {
      assert.ok(Date.parse(candle.closeTime) <= reviewCursor, `${candle.closeTime} is after ${snapshot.reviewCursor.closeTime}`);
    }
    for (const item of snapshot.annotations) {
      if (item.openTime) assert.ok(Date.parse(item.openTime) <= reviewCursor);
      if (item.closeTime) assert.ok(Date.parse(item.closeTime) <= reviewCursor);
    }
    assert.equal(snapshot.evaluationCursor.futureCandleAccess, false);
    assert.equal(snapshot.futureCandleAccess, false);
    assert.ok(snapshot.machineCandles.every((candle) => Date.parse(candle.closeTime) <= Date.parse(snapshot.evaluationCursor.closeTime)));
    assert.equal(snapshot.outcomeContextEnd, snapshot.reviewCursor.closeTime);
  }
});

test("visual-validation cursors carry distinct New York and UTC timestamps", () => {
  const set = buildVisualValidationSet(request);
  const cursor = set.snapshots[0]?.evaluationCursor;
  assert.ok(cursor);
  assert.notEqual(cursor.newYork, cursor.utc);
  assert.match(cursor.newYork, /2026/);
  assert.match(cursor.utc, /2026/);
});

test("human reviews remain separate from immutable machine evidence", () => {
  const stored = storeVisualValidationSet(buildVisualValidationSet(request));
  const snapshot = stored.snapshots[0];
  assert.ok(snapshot);
  const before = getVisualValidationSet(stored.reviewSetId);
  assert.ok(before);
  const review = recordVisualValidationReview(stored.reviewSetId, snapshot.snapshotId, "incorrect", "The level is not respected.");
  assert.ok(review);
  const after = getVisualValidationSet(stored.reviewSetId);
  assert.ok(after);
  const beforeSnapshot = before.snapshots.find((item) => item.snapshotId === snapshot.snapshotId);
  const afterSnapshot = after.snapshots.find((item) => item.snapshotId === snapshot.snapshotId);
  assert.ok(beforeSnapshot);
  assert.ok(afterSnapshot);
  assert.deepEqual(afterSnapshot.machineEvidence, beforeSnapshot.machineEvidence);
   assert.deepEqual(afterSnapshot.machineCandles, beforeSnapshot.machineCandles);
   assert.deepEqual(afterSnapshot.reviewCandles, beforeSnapshot.reviewCandles);
  assert.equal(afterSnapshot.review.status, "incorrect");
  assert.equal(beforeSnapshot.review.status, "unreviewed");
});

test("review export contains the full ledger and filters discrepancies to incorrect or uncertain", () => {
  const stored = storeVisualValidationSet(buildVisualValidationSet(request));
  const [first, second] = stored.snapshots;
  assert.ok(first);
  assert.ok(second);
  recordVisualValidationReview(stored.reviewSetId, first.snapshotId, "rule_needs_clarification", "Clarify the pullback tolerance.");
  const report = buildVisualValidationDiscrepancyReport(stored.reviewSetId);
  assert.ok(report);
  assert.equal(report.reviewedSnapshots, 1);
  assert.equal(report.reviews.length, 1);
  assert.equal(report.reviews[0]?.snapshotId, first.snapshotId);
  assert.equal(report.reviews[0]?.reviewerStatus, "rule_needs_clarification");
  assert.equal(report.reviews[0]?.note, "Clarify the pullback tolerance.");
  assert.equal(report.discrepancies.length, 0);
  assert.ok(second);
});

function teachingInput(snapshot: ReturnType<typeof buildVisualValidationSet>["snapshots"][number], direction: "long" | "short"): VisualValidationTeachingInput {
  const base = direction === "long"
    ? {
        previous: { openTime: "2026-08-26T13:25:00.000Z", closeTime: "2026-08-26T13:30:00.000Z", open: 100, high: 101.5, low: 99.5, close: 100.5 },
        patience: { openTime: "2026-08-26T13:30:00.000Z", closeTime: "2026-08-26T13:35:00.000Z", open: 100.5, high: 101.5, low: 100, close: 101 },
        entry: { openTime: "2026-08-26T13:35:00.000Z", closeTime: "2026-08-26T13:40:00.000Z", open: 101, high: 102.75, low: 100.75, close: 102 },
        level: 101,
      }
    : {
        previous: { openTime: "2026-08-26T13:25:00.000Z", closeTime: "2026-08-26T13:30:00.000Z", open: 103, high: 104, low: 101.5, close: 103 },
        patience: { openTime: "2026-08-26T13:30:00.000Z", closeTime: "2026-08-26T13:35:00.000Z", open: 103, high: 103.5, low: 101.5, close: 102 },
        entry: { openTime: "2026-08-26T13:35:00.000Z", closeTime: "2026-08-26T13:40:00.000Z", open: 102, high: 102.5, low: 100, close: 100.5 },
        level: 102,
      };
  snapshot.reviewCandles = [base.previous, base.patience, base.entry].map((candle) => ({
    ...candle,
    timestamp: candle.openTime,
    volume: 1000,
    bid: candle.close - 0.25,
    ask: candle.close,
    bidSize: 10,
    askSize: 10,
    contractSymbol: snapshot.contractSymbol,
    isComplete: true,
  }));
  snapshot.evaluationCursor = {
    ...snapshot.evaluationCursor,
    openTime: base.entry.openTime,
    closeTime: base.entry.closeTime,
  };
  snapshot.annotations = [
    ...snapshot.annotations,
    { id: `teaching-level-${direction}`, kind: "level", label: "Teaching level", price: base.level, available: true, color: "blue", detail: "Deterministic teaching level.", visibility: "machine", openTime: null, closeTime: null },
  ];
  return {
    judgment: "missed_trade",
    direction,
    entryCandleOpenTime: base.entry.openTime,
    entryCandleCloseTime: base.entry.closeTime,
    patienceCandleOpenTime: base.patience.openTime,
    patienceCandleCloseTime: base.patience.closeTime,
    entryBufferTicks: 4,
    pullbackLevels: [base.level],
    setupType: "ORB_PULLBACK_CONTINUATION",
    confidence: "medium",
    explanation: `${direction} example has an exact patience pair and buffered continuation.`,
  };
}

test("teaching validation accepts deterministic long and short buffered examples", () => {
  for (const direction of ["long", "short"] as const) {
    const snapshot = structuredClone(buildVisualValidationSet(request).snapshots[0]!);
    const input = teachingInput(snapshot, direction);
    const result = validateVisualValidationTeaching(snapshot, input);
    assert.equal(result.valid, true, `${direction}: ${result.messages.join("; ")}`);
    assert.equal(result.calculatedEntryPrice, direction === "long" ? 102.5 : 100.5);
  }
});

function dynamicLevelFixture() {
  const snapshot = structuredClone(buildVisualValidationSet(request).snapshots[0]!);
  const indicatorPoint = snapshot.indicatorSeries.find((item) => item.vwap !== null && item.ema200 !== null);
  assert.ok(indicatorPoint);
  const input = teachingInput(snapshot, "long");
  const previous = snapshot.reviewCandles[0]!;
  const patience = snapshot.reviewCandles[1]!;
  const entry = snapshot.reviewCandles[2]!;
  Object.assign(previous, { open: 6851, high: 6852, low: 6850.5, close: 6851.2 });
  Object.assign(patience, { open: 6851.2, high: 6851.75, low: 6851.3, close: 6851.5 });
  Object.assign(entry, { open: 6851.5, high: 6853, low: 6851.25, close: 6852.75 });
  const point = indicatorPoint;
  point.openTime = patience.openTime;
  point.closeTime = patience.closeTime;
  point.vwap = 6851.508;
  point.ema200 = 6851.492;
  point.visibility = "machine";
  const vwap = snapshot.annotations.find((item) => item.id === "vwap");
  assert.ok(vwap);
  vwap.available = true;
  vwap.visibility = "machine";
  const selection = {
    levelId: "vwap",
    levelType: "dynamic_indicator" as const,
    valueAtInteraction: 6851.508,
    sourceTimestamp: point.openTime,
    rangeLow: null,
    rangeHigh: null,
  };
  return { snapshot, input, selection };
}

test("fractional VWAP at L validates, persists at full precision, and stays out of legacy levels", () => {
  const { snapshot, input, selection } = dynamicLevelFixture();
  const dynamicInput = { ...input, pullbackLevels: [6851.508], qualifyingLevels: [selection] };
  const validation = validateVisualValidationTeaching(snapshot, dynamicInput);
  assert.equal(validation.valid, true, validation.messages.join("; "));
  const example = createVisualValidationTeachingExample(snapshot, dynamicInput, null);
  const persistedLevels = example.qualifyingLevels ?? [];
  assert.equal(persistedLevels[0]?.valueAtInteraction, 6851.508);
  assert.equal(persistedLevels[0]?.sourceTimestamp, selection.sourceTimestamp);
  assert.equal(persistedLevels[0]?.rangeLow, null);
  assert.equal(persistedLevels[0]?.rangeHigh, null);
  assert.deepEqual(example.pullbackLevels, []);
});

test("fractional EMA validates while an off-tick fixed executable level remains rejected", () => {
  const { snapshot, input, selection } = dynamicLevelFixture();
  const emaSelection = { ...selection, levelId: "ema-200", valueAtInteraction: 6851.492 };
  const accepted = validateVisualValidationTeaching(snapshot, {
    ...input,
    pullbackLevels: [],
    qualifyingLevels: [emaSelection],
  });
  assert.equal(accepted.valid, true, accepted.messages.join("; "));
  const fixed = validateVisualValidationTeaching(snapshot, {
    ...input,
    pullbackLevels: [6851.1],
    qualifyingLevels: [],
  });
  assert.equal(fixed.valid, false);
  assert.ok(fixed.messages.some((message) => message.includes("0.25 tick")));
});

test("dynamic qualifying-level tampering is rejected against immutable L evidence", () => {
  const { snapshot, input, selection } = dynamicLevelFixture();
  for (const tampered of [
    { ...selection, valueAtInteraction: 6851.75 },
    { ...selection, sourceTimestamp: "2026-08-26T13:25:00.000Z" },
    { ...selection, levelType: "fixed_level" as const },
    { ...selection, rangeLow: 6851, rangeHigh: 6852 },
  ]) {
    const result = validateVisualValidationTeaching(snapshot, {
      ...input,
      pullbackLevels: [],
      qualifyingLevels: [tampered],
    });
    assert.equal(result.valid, false);
  }
});

test("migration preserves existing rows while adding validator and calendar fingerprints", () => {
  const migration = readFileSync(new URL("../../../../lib/db/migrations/0001_dynamic_level_safety.sql", import.meta.url), "utf8");
  const proposalValidationRunBlock = migration.match(/ALTER TABLE levelstory_proposal_validation_runs[\s\S]*?(?=\nALTER TABLE|$)/)?.[0] ?? "";
  assert.match(proposalValidationRunBlock, /ALTER TABLE levelstory_proposal_validation_runs/);
  assert.match(proposalValidationRunBlock, /ADD COLUMN IF NOT EXISTS validator_version TEXT/);
  assert.match(proposalValidationRunBlock, /ADD COLUMN IF NOT EXISTS calendar_fingerprint TEXT/);
  assert.doesNotMatch(migration, /\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});

test("teaching validation uses the default twelve-tick proximity zone instead of exact containment", () => {
  const snapshot = structuredClone(buildVisualValidationSet(request).snapshots[0]!);
  const input = teachingInput(snapshot, "long");
  snapshot.annotations.push({ id: "test-pdl", kind: "level", label: "Previous Day Low", price: 102.25, available: true, color: "blue", detail: "Test level.", visibility: "machine", openTime: null, closeTime: null });
  const result = validateVisualValidationTeaching(snapshot, { ...input, pullbackLevels: [102.25] });
  assert.equal(result.valid, true, result.messages.join("; "));
  assert.equal(result.levelInteractions[0]?.distanceTicks, 3);
  assert.equal(result.levelInteractions[0]?.allowedToleranceTicks, 12);
  assert.match(result.levelInteractions[0]?.reason ?? "", /Previous Day Low/);
});

test("detector and Visual Review return identical distance, ticks, and qualification", () => {
  const source = buildVisualValidationSet(request).snapshots.find((item) => item.category === "pullback");
  assert.ok(source);
  const snapshot = structuredClone(source);
  const levelCandle = snapshot.reviewCandles[1]!;
  const breakoutCandle = snapshot.reviewCandles[0]!;
  const level = levelCandle.high + 3.00000000005;
  snapshot.annotations.push({
    id: "parity-level",
    kind: "level",
    label: "Parity level",
    price: level,
    available: true,
    color: "blue",
    detail: "Focused parity fixture.",
    visibility: "machine",
    openTime: null,
    closeTime: null,
  });
  const toDetectorCandle = (value: typeof levelCandle): Candle => ({
    openTime: Date.parse(value.openTime),
    closeTime: Date.parse(value.closeTime),
    open: value.open,
    high: value.high,
    low: value.low,
    close: value.close,
    volume: value.volume,
    isComplete: value.isComplete,
  });
  const first = toDetectorCandle(breakoutCandle);
  const l = toDetectorCandle(levelCandle);
  const breakout = {
    detected: true,
    direction: "long",
    time: first.closeTime,
    candleOpenTime: first.openTime,
    state: "QUALIFIED_BREAKOUT",
    candidateTime: first.closeTime,
    candidateCandleOpenTime: first.openTime,
    distanceOutside: 1,
    meaningfulDistance: 1,
    breakoutVolume: first.volume,
    baselineVolume: first.volume,
    volumeRatio: 1,
    volumeSupported: true,
    bodyRatio: 1,
    closeLocationRatio: 1,
    candleStructureSupported: true,
    continuationConfirmed: true,
    continuationCondition: "IMMEDIATE_DIRECTIONAL_EXTENSION",
    failed: false,
    detail: "focused parity fixture",
  } satisfies BreakoutEvent;
  const detectorEvent = analyzePullback(
    [first, l],
    breakout,
    [{ name: "Parity level", price: level }],
    getFuturesContractSpecification("MES"),
    strategyConfig(),
  ).events.find((event) => event.level === "Parity level" && event.type === "proximity");
  const visual = resolveQualifyingLevelAtCandle(snapshot, levelCandle, "parity-level", 12);
  assert.ok(detectorEvent);
  assert.equal(detectorEvent.distancePoints, visual.distancePoints);
  assert.equal(detectorEvent.distanceTicks, visual.distanceTicks);
  assert.equal(detectorEvent.tolerancePoints, 3);
  assert.equal(detectorEvent.toleranceTicks, visual.toleranceTicks);
  assert.equal(detectorEvent.qualifies, visual.qualifies);
});

test("teaching validation rejects levels beyond the configured proximity tolerance", () => {
  const snapshot = structuredClone(buildVisualValidationSet(request).snapshots[0]!);
  const input = teachingInput(snapshot, "long");
  snapshot.annotations.push({ id: "test-vwap", kind: "indicator", label: "VWAP", price: 103, available: true, color: "blue", detail: "Test indicator.", visibility: "machine", openTime: null, closeTime: null });
  const result = validateVisualValidationTeaching(snapshot, { ...input, pullbackLevels: [103], levelToleranceTicks: 4 });
  assert.equal(result.valid, false);
  assert.equal(result.levelInteractions[0]?.distanceTicks, 6);
  assert.match(result.messages.join(" "), /remained 6 ticks from VWAP/);
});

test("teaching validation accepts multiple mapped pullback levels", () => {
  const snapshot = structuredClone(buildVisualValidationSet(request).snapshots[0]!);
  const input = teachingInput(snapshot, "long");
  snapshot.annotations.push({
    id: "teaching-level-secondary",
    kind: "level",
    label: "Secondary teaching level",
    price: 100.75,
    available: true,
    color: "blue",
    detail: "Second deterministic teaching level.",
    visibility: "machine",
    openTime: null,
    closeTime: null,
  });
  const result = validateVisualValidationTeaching(snapshot, {
    ...input,
    pullbackLevels: [101, 100.75, 101],
  });
  assert.equal(result.valid, true, result.messages.join("; "));
  const example = createVisualValidationTeachingExample(snapshot, {
    ...input,
    pullbackLevels: [101, 100.75, 101],
  }, null);
  assert.deepEqual(example.pullbackLevels, [100.75, 101]);
});

test("teaching validation enforces the exclusive 1:00 PM ET boundary", () => {
  const snapshot = structuredClone(buildVisualValidationSet(request).snapshots[0]!);
  const input = teachingInput(snapshot, "long");
  const lateStart = Date.parse("2026-08-26T16:45:00.000Z");
  snapshot.reviewCandles = snapshot.reviewCandles.map((candle, index) => {
    const openTime = new Date(lateStart + index * 5 * 60_000).toISOString();
    const closeTime = new Date(lateStart + (index + 1) * 5 * 60_000).toISOString();
    return { ...candle, openTime, closeTime, timestamp: openTime };
  });
  const boundaryEntry = snapshot.reviewCandles[2]!;
  snapshot.evaluationCursor = {
    ...snapshot.evaluationCursor,
    openTime: boundaryEntry.openTime,
    closeTime: boundaryEntry.closeTime,
  };
  const boundaryInput = {
    ...input,
    entryCandleOpenTime: snapshot.reviewCandles[2]!.openTime,
    entryCandleCloseTime: snapshot.reviewCandles[2]!.closeTime,
    patienceCandleOpenTime: snapshot.reviewCandles[1]!.openTime,
    patienceCandleCloseTime: snapshot.reviewCandles[1]!.closeTime,
  };
  const accepted = validateVisualValidationTeaching(snapshot, boundaryInput);
  assert.equal(accepted.valid, true, accepted.messages.join("; "));

  const afterBoundary = {
    ...input,
    entryCandleOpenTime: "2026-08-26T17:00:00.000Z",
    entryCandleCloseTime: "2026-08-26T17:05:00.000Z",
  };
  snapshot.reviewCandles = snapshot.reviewCandles.map((candle, index) => index === 2
    ? { ...candle, openTime: afterBoundary.entryCandleOpenTime, closeTime: afterBoundary.entryCandleCloseTime, timestamp: afterBoundary.entryCandleOpenTime }
    : candle);
  snapshot.evaluationCursor = {
    ...snapshot.evaluationCursor,
    openTime: afterBoundary.entryCandleOpenTime,
    closeTime: afterBoundary.entryCandleCloseTime,
  };
  const rejected = validateVisualValidationTeaching(snapshot, afterBoundary);
  assert.equal(rejected.valid, false);
  assert.ok(rejected.messages.some((message) => message.includes("9:30 AM–1:00 PM ET")));
});

test("teaching validation rejects future, non-adjacent, and non-MES-buffer corrections", () => {
  const snapshot = structuredClone(buildVisualValidationSet(request).snapshots[0]!);
  const input = teachingInput(snapshot, "long");
  const invalid = {
    ...input,
    entryBufferTicks: 3 as 3,
    patienceCandleCloseTime: "2026-08-26T13:34:00.000Z",
    entryCandleCloseTime: "2026-08-26T14:40:00.000Z",
    explanation: "invalid teaching case",
  };
  const result = validateVisualValidationTeaching(snapshot, invalid);
  assert.equal(result.valid, false);
  assert.ok(result.messages.some((message) => message.includes("Choose both") || message.includes("immediate-next")));
  assert.ok(result.messages.some((message) => message.includes("causal") || message.includes("future")));
  assert.ok(result.messages.length >= 3);
});

test("teaching revisions preserve immutable evidence and analysis stays advisory", () => {
  const baseSet = buildVisualValidationSet(request);
  const firstSnapshot = structuredClone(baseSet.snapshots[0]!);
  const secondSnapshot = structuredClone(baseSet.snapshots[1]!);
  const firstTeaching = teachingInput(firstSnapshot, "long");
  const secondTeaching = teachingInput(secondSnapshot, "short");
  const stored = storeVisualValidationSet({ ...baseSet, snapshots: [firstSnapshot, secondSnapshot] });
  const machineEvidenceBefore = structuredClone(firstSnapshot.machineEvidence);
  const firstReview = recordVisualValidationReview(stored.reviewSetId, firstSnapshot.snapshotId, "incorrect", "Initial machine disagreement.");
  assert.ok(firstReview);
  const secondReview = recordVisualValidationReview(stored.reviewSetId, firstSnapshot.snapshotId, "missed_trade", null, firstTeaching);
  assert.ok(secondReview?.teaching);
  assert.equal(secondReview?.revision, 2);
  assert.equal(secondReview?.supersedesReviewId, firstReview?.reviewId);
  assert.deepEqual(getVisualValidationSet(stored.reviewSetId)?.snapshots[0]?.machineEvidence, machineEvidenceBefore);
  recordVisualValidationReview(stored.reviewSetId, secondSnapshot.snapshotId, "rule_needs_clarification", "Second example needs review.", secondTeaching);
  const analysis = analyzeVisualValidationTeaching(stored.reviewSetId);
  assert.ok(analysis);
  assert.equal(analysis?.status, "advisory");
  assert.equal(analysis?.approvalRequired, true);
  assert.equal(analysis?.activeFormulaHash, baseSet.formulaHash);
  assert.equal(getVisualValidationSet(stored.reviewSetId)?.formulaHash, baseSet.formulaHash);
});

function audit(overrides: Partial<BacktestAuditRecord> = {}): BacktestAuditRecord {
  return {
    id: "audit-1",
    tradingDate: "2026-08-26",
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    period: "in_sample",
    evaluatedCandleOpenTime: "2026-08-26T13:30:00.000Z",
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long",
    decision: "SETUP QUALIFIED",
    alertOnly: false,
    rejectionReason: null,
    rejectionCategory: "QUALIFIED",
    rejectionSummary: null,
    ruleEvidence: [],
    orbState: "ENTRY_TRIGGERED",
    breakoutEvidence: "Strong confirmed breakout.",
    volumeEvidence: "Supported volume.",
    pullbackEvidence: "touch at VWAP (pullback interaction).",
    criticalLevelEvidence: "No critical level evidence.",
    trendEvidence: "bullish: higher highs / higher lows.",
    patienceState: "PATIENCE_CANDLE_VALID",
    patienceCandle: { openTime: 100, closeTime: 200, close: 101 },
    triggerCandle: { openTime: 200, closeTime: 300, close: 102 },
    patienceCandleOpenTime: "2026-08-26T13:20:00.000Z",
    patienceCandleCloseTime: "2026-08-26T13:25:00.000Z",
    triggerCandleOpenTime: "2026-08-26T13:25:00.000Z",
    triggerCandleCloseTime: "2026-08-26T13:30:00.000Z",
    modeledFillObservationTime: null,
    exitCandleOpenTime: null,
    exitCandleCloseTime: null,
    entryTriggerPrice: 102,
    strategyStopPrice: 99,
    catastropheStopPrice: 98,
    targetPrice: 108,
    eventLabels: [],
    ambiguityLabels: [],
    executionMode: "quote_based_shadow",
    fees: 0,
    slippage: 0,
    grossPnl: null,
    netPnl: null,
    exitReason: null,
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
    ...overrides,
  };
}

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    id: "trade-1",
    tradingDate: "2026-08-26",
    contractSymbol: "MESU6",
    contractMonth: "2026-09",
    period: "in_sample",
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long",
    entryTime: "2026-08-26T13:30:00.000Z",
    exitTime: "2026-08-26T14:00:00.000Z",
    entryPrice: 102,
    exitPrice: 108,
    contracts: 1,
    grossPnl: 300,
    fees: 5,
    slippage: 1,
    netPnl: 294,
    outcome: "target",
    ambiguityLabel: null,
    source: "tick",
    segmentation: {} as BacktestTrade["segmentation"],
    ...overrides,
  };
}

test("trade matching requires an exact unique causal anchor", () => {
  const record = audit();
  const exact = trade({
    audit: {
      patienceCandleOpenTime: record.patienceCandleOpenTime,
      patienceCandleCloseTime: record.patienceCandleCloseTime,
      triggerCandleOpenTime: record.triggerCandleOpenTime,
      triggerCandleCloseTime: record.triggerCandleCloseTime,
      modeledFillObservationTime: null,
    } as BacktestTrade["audit"],
  });
  assert.equal(matchingTrade(record, [exact])?.id, "trade-1");
  assert.equal(matchingTrade(record, [exact, { ...exact, id: "trade-2", entryTime: "2026-08-26T13:31:00.000Z" }]), null);
  assert.equal(matchingTrade(record, [{ ...exact, contractSymbol: "MESH6" }]), null);
});

test("trade matching rejects an unrelated exit or causal timestamp", () => {
  const record = audit({
    modeledFillObservationTime: "2026-08-26T13:35:00.000Z",
    exitCandleOpenTime: "2026-08-26T13:55:00.000Z",
    exitCandleCloseTime: "2026-08-26T14:00:00.000Z",
  });
  const exact = trade({
    audit: {
      patienceCandleOpenTime: record.patienceCandleOpenTime,
      patienceCandleCloseTime: record.patienceCandleCloseTime,
      triggerCandleOpenTime: record.triggerCandleOpenTime,
      triggerCandleCloseTime: record.triggerCandleCloseTime,
      modeledFillObservationTime: record.modeledFillObservationTime,
      exitCandleOpenTime: record.exitCandleOpenTime,
      exitCandleCloseTime: record.exitCandleCloseTime,
    } as BacktestTrade["audit"],
  });
  assert.equal(matchingTrade(record, [exact])?.id, "trade-1");
  assert.equal(matchingTrade(record, [{
    ...exact,
    audit: {
      ...exact.audit!,
      exitCandleCloseTime: "2026-08-26T14:05:00.000Z",
    } as BacktestTrade["audit"],
  }]), null);
  assert.equal(matchingTrade({ ...record, modeledFillObservationTime: "2026-08-26T13:40:00.000Z" }, [exact]), null);
  assert.equal(matchingTrade({ ...record, triggerCandleOpenTime: "2026-08-26T13:30:00.000Z" }, [exact]), null);
});

test("entry time equal to a candle close resolves to that completed candle", () => {
  const snapshot = buildVisualValidationSet(request).snapshots[0]!;
  const first = snapshot.reviewCandles[0]!;
  const second = snapshot.reviewCandles[1]!;
  const observed = resolveObservedEntryCandle(snapshot, { entryTime: first.closeTime });
  assert.equal(observed?.openTime, first.openTime);
  assert.notEqual(observed?.openTime, second.openTime);
});

test("category gates use explicit trend, mapped-level, and measured-state evidence", () => {
  const aligned = audit();
  assert.deepEqual(categoriesFor(aligned, null), [
    "bullish_patience_candle",
    "strong_breakout",
    "pullback",
  ]);
  assert.equal(categoriesFor({ ...aligned, trendEvidence: "bearish: lower highs / lower lows." }, null).includes("bullish_patience_candle"), false);
  assert.equal(categoriesFor({ ...aligned, pullbackEvidence: "Pullback observed." }, null).includes("pullback"), false);
  assert.equal(categoriesFor({ ...aligned, pullbackEvidence: "consolidation pending near VWAP" }, null).includes("consolidation"), false);
  assert.equal(categoriesFor({ ...aligned, pullbackEvidence: "2 consecutive completed candles consolidated near VWAP." }, null).includes("consolidation"), true);
});

test("exit annotations expose explicit machine and human-only event markers", () => {
  const set = buildVisualValidationSet(request);
  const labels = set.snapshots.flatMap((snapshot) => snapshot.annotations.map((item) => item.label));
  const qualifyingLevels = set.snapshots.flatMap((snapshot) => snapshot.annotations.filter((item) => item.id === "ema-200" || item.id === "vwap"));
  assert.ok(qualifyingLevels.some((item) => item.id === "ema-200" && item.label === "200 MA"));
  assert.ok(qualifyingLevels.some((item) => item.id === "vwap" && item.label === "VWAP"));
  assert.ok(labels.includes("Entry candle (E)"));
  assert.ok(labels.includes("Modeled fill"));
  assert.ok(labels.some((label) => ["Strategy stop hit", "Catastrophe stop hit", "Target hit", "Runner activation", "Runner exit"].includes(label)));
  for (const snapshot of set.snapshots) {
    const cursor = Date.parse(snapshot.evaluationCursor.closeTime);
    for (const marker of snapshot.annotations.filter((item) => item.visibility === "human_only")) {
      assert.ok(marker.openTime);
      assert.ok(Date.parse(marker.openTime) > cursor);
    }
  }
});
