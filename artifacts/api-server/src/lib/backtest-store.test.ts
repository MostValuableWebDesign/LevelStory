import assert from "node:assert/strict";
import test from "node:test";
import { buildBacktestCacheKey, getBacktestAuditPage, getCachedBacktestReport, storeBacktestReport } from "./backtest-store.js";
import type { BacktestAuditRecord, BacktestReport } from "./phase9.js";

function audit(id: string, date: string, category: BacktestAuditRecord["rejectionCategory"]): BacktestAuditRecord {
  return {
    id, tradingDate: date, contractSymbol: "MESU6", contractMonth: "2026-09", period: "in_sample",
    evaluatedCandleOpenTime: `${date}T13:30:00.000Z`, setupType: "TEST", direction: null, decision: "WAITING",
    alertOnly: false, rejectionReason: "test", rejectionCategory: category, rejectionSummary: "test",
    ruleEvidence: [], orbState: "ORB_FORMING", breakoutEvidence: "", volumeEvidence: "", pullbackEvidence: "",
    criticalLevelEvidence: "", trendEvidence: "", patienceState: "WAITING", patienceCandle: null, triggerCandle: null,
    patienceCandleOpenTime: null, patienceCandleCloseTime: null, triggerCandleOpenTime: null, triggerCandleCloseTime: null,
     modeledFillObservationTime: null, exitCandleOpenTime: null, exitCandleCloseTime: null, entryTriggerPrice: null, strategyStopPrice: null,
     catastropheStopPrice: null, eventLabels: [], targetPrice: null, ambiguityLabels: [], executionMode: "ohlcv_modeled", fees: 0,
    slippage: 0, grossPnl: null, netPnl: null, exitReason: null,
  };
}

test("backtest audit pages are stable, bounded, and server-filterable", () => {
  const report = { audit: [
    audit("first", "2026-08-20", "FAILURE"),
    audit("second", "2026-08-21", "AMBIGUITY"),
    audit("third", "2026-08-21", "FAILURE"),
  ] } as BacktestReport;
  const runId = storeBacktestReport(report);
  assert.deepEqual(getBacktestAuditPage(runId, 1, 2)?.audit.map((row) => row.id), ["first", "second"]);
  assert.deepEqual(getBacktestAuditPage(runId, 1, 50, { date: "2026-08-21", category: "FAILURE" })?.audit.map((row) => row.id), ["third"]);
  assert.equal(getBacktestAuditPage("missing-run"), null);
});

test("completed reports reuse a normalized cache key and preserve the run id", () => {
  const first = { audit: [] } as unknown as BacktestReport;
  const keyA = buildBacktestCacheKey({ request: { b: 2, a: 1 }, source: "file:1" });
  const keyB = buildBacktestCacheKey({ source: "file:1", request: { a: 1, b: 2 } });
  assert.equal(keyA, keyB);
  const firstRun = storeBacktestReport(first, keyA);
  const secondRun = storeBacktestReport({ audit: [] } as unknown as BacktestReport, keyB);
  assert.equal(secondRun, firstRun);
  assert.equal(getCachedBacktestReport(keyA)?.runId, firstRun);
});

test("source content, risk, and execution changes invalidate cache identity", () => {
  const base = {
    request: { symbol: "MES", endDate: "2026-08-28", inSampleDays: 5, outOfSampleDays: 2 },
    risk: { accountSize: 10_000, riskPercent: 1 },
    executionPolicy: { entryBufferTicks: 4, slippageTicks: 1 },
  };
  const sourceA = buildBacktestCacheKey({ ...base, historicalSource: { fingerprint: "a" } });
  const sourceB = buildBacktestCacheKey({ ...base, historicalSource: { fingerprint: "b" } });
  const riskChanged = buildBacktestCacheKey({ ...base, risk: { ...base.risk, riskPercent: 2 }, historicalSource: { fingerprint: "a" } });
  const executionChanged = buildBacktestCacheKey({
    ...base,
    executionPolicy: { ...base.executionPolicy, slippageTicks: 2 },
    historicalSource: { fingerprint: "a" },
  });
  assert.notEqual(sourceA, sourceB);
  assert.notEqual(sourceA, riskChanged);
  assert.notEqual(sourceA, executionChanged);
});