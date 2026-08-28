import assert from "node:assert/strict";
import test from "node:test";
import { getBacktestAuditPage, storeBacktestReport } from "./backtest-store.js";
import type { BacktestAuditRecord, BacktestReport } from "./phase9.js";

function audit(id: string, date: string, category: BacktestAuditRecord["rejectionCategory"]): BacktestAuditRecord {
  return {
    id, tradingDate: date, contractSymbol: "MESU6", contractMonth: "2026-09", period: "in_sample",
    evaluatedCandleOpenTime: `${date}T13:30:00.000Z`, setupType: "TEST", direction: null, decision: "WAITING",
    alertOnly: false, rejectionReason: "test", rejectionCategory: category, rejectionSummary: "test",
    ruleEvidence: [], orbState: "ORB_FORMING", breakoutEvidence: "", volumeEvidence: "", pullbackEvidence: "",
    criticalLevelEvidence: "", trendEvidence: "", patienceState: "WAITING", patienceCandle: null, triggerCandle: null,
    patienceCandleOpenTime: null, patienceCandleCloseTime: null, triggerCandleOpenTime: null, triggerCandleCloseTime: null,
    modeledFillObservationTime: null, exitCandleOpenTime: null, entryTriggerPrice: null, strategyStopPrice: null,
    catastropheStopPrice: null, targetPrice: null, ambiguityLabels: [], executionMode: "ohlcv_modeled", fees: 0,
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