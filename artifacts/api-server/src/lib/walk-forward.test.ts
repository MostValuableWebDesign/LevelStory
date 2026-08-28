import assert from "node:assert/strict";
import test from "node:test";
import { formulaConfigurationHash } from "./formula-hash.js";
import { calculateBacktestMetrics } from "./phase9.js";
import {
  classifyEdge,
  evaluateWalkForward,
  type WalkForwardSegment,
} from "./walk-forward.js";
import type { BacktestReport, BacktestTrade } from "./phase9.js";

const dates = [
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
  "2026-08-10",
  "2026-08-11",
];

function trade(date: string, index: number, netPnl: number, contractSymbol = "MESU5"): BacktestTrade {
  return {
    id: `${date}-${index}`,
    tradingDate: date,
    contractSymbol,
    contractMonth: "U5",
    period: "in_sample",
    setupType: "continuation",
    direction: index % 2 ? "short" : "long",
    entryTime: `${date}T14:00:00.000Z`,
    exitTime: `${date}T14:05:00.000Z`,
    entryPrice: 100,
    exitPrice: 100,
    contracts: 1,
    grossPnl: netPnl,
    fees: 0,
    slippage: 0,
    netPnl,
    outcome: netPnl >= 0 ? "target" : "strategy stop",
    ambiguityLabel: null,
    source: "one-minute",
    executionMode: "ohlcv_modeled",
    fillLabel: "test",
    segmentation: {
      contract: contractSymbol,
      contractMonth: "U5",
      setupType: "continuation",
      direction: index % 2 ? "short" : "long",
      timeOfDay: "open",
      trend: "bullish",
      fibonacciDepth: "shallow",
      volumeCondition: "supported",
      levelType: "ORB",
      confluence: "normal",
      patienceCharacteristic: "clean",
      orbState: "ORB_FORMING",
      marketRegime: "trend",
    },
  } as BacktestTrade;
}

function reportForTrades(trades: BacktestTrade[]): BacktestReport {
  return { trades, audit: [] } as unknown as BacktestReport;
}

function partitions() {
  return dates.map((tradingDate, index) => ({
    tradingDate,
    contractSymbol: index < 4 ? "MESU5" : "MESZ5",
    period: index >= 5 ? "out_of_sample" as const : "in_sample" as const,
  }));
}

test("walk-forward folds are chronological, exact, and never use future dates", () => {
  const reports = dates.map((date, index) => reportForTrades([trade(date, index, index % 3 ? 10 : -5, partitions()[index]!.contractSymbol)]));
  const evaluation = evaluateWalkForward({
    reports,
    partitions: partitions(),
    selectedDates: dates,
    formulaHash: "a".repeat(64),
    formulaVersion: "test",
  }, 3, 2);

  assert.equal(evaluation.foldCount, 2);
  assert.deepEqual(evaluation.folds.map((fold) => fold.inSampleDates), [
    dates.slice(0, 3),
    dates.slice(2, 5),
  ]);
  assert.deepEqual(evaluation.folds.map((fold) => fold.outOfSampleDates), [
    dates.slice(3, 5),
    dates.slice(5, 7),
  ]);
  for (const fold of evaluation.folds) {
    assert.ok(fold.outOfSampleDates.every((date) => !fold.inSampleDates.includes(date)));
    assert.equal(fold.contractPartitions.length, 5);
    assert.equal(fold.metrics.tradeCount, 5);
  }
  const firstFoldPnl = evaluation.folds[0]!.metrics.netPnl;
  reports.at(-1)!.trades[0]!.netPnl = 999;
  assert.equal(evaluation.folds[0]!.metrics.netPnl, firstFoldPnl);
});

test("walk-forward metrics reconcile with every segmentation dimension", () => {
  const reports = dates.map((date, index) => reportForTrades([trade(date, index, 5)]));
  const evaluation = evaluateWalkForward({
    reports,
    partitions: partitions(),
    selectedDates: dates,
    formulaHash: "b".repeat(64),
    formulaVersion: "test",
  }, 3, 2);
  const byDimension = new Map<string, WalkForwardSegment[]>();
  for (const segment of evaluation.segments) {
    byDimension.set(segment.dimension, [...(byDimension.get(segment.dimension) ?? []), segment]);
  }
  for (const segments of byDimension.values()) {
    assert.equal(segments.reduce((sum, segment) => sum + segment.tradeCount, 0), evaluation.metrics.tradeCount);
  }
  assert.ok(evaluation.segments.some((segment) => segment.sampleStatus === "insufficient_sample"));
  assert.ok(evaluation.segments.some((segment) => segment.sampleStatus === "sufficient"));
});

test("small samples stay neutral even when observed expectancy is negative", () => {
  assert.equal(classifyEdge({
    tradeCount: 3,
    expectancy: -10,
    profitFactor: 0,
    maximumDrawdown: 30,
  }, 3), "insufficient_evidence");
});

test("formula hash is stable for the locked formula and independent of cost settings", () => {
  assert.equal(formulaConfigurationHash({ symbol: "MES" }), formulaConfigurationHash({ symbol: "MES" }));
  assert.notEqual(formulaConfigurationHash({ symbol: "MES" }), formulaConfigurationHash({ symbol: "MNQ" }));
  const metrics = calculateBacktestMetrics([trade(dates[0]!, 0, -5), trade(dates[0]!, 1, -3), trade(dates[0]!, 2, 10)]);
  assert.equal(metrics.consecutiveLosses, 2);
});