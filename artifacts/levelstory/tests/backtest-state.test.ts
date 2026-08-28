import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptedOutrightFilesLabel,
  coverageEligibilityLabel,
  getHistoricalBacktestReadiness,
  getMultiContractCoverageTotals,
} from "../src/lib/backtest-state.ts";

test("historical backtest readiness stays gated through indexing and failures", () => {
  assert.deepEqual(getHistoricalBacktestReadiness("simulated", {
    importLoading: false,
    hasImport: false,
  }), { ready: true, label: "Ready" });
  assert.equal(getHistoricalBacktestReadiness("historical_databento_multicontract", {
    indexState: "indexing",
    importLoading: true,
    hasImport: false,
  }).ready, false);
  assert.equal(getHistoricalBacktestReadiness("historical_databento_multicontract", {
    indexState: "failed",
    importLoading: false,
    hasImport: false,
  }).label, "Historical index failed");
  assert.equal(getHistoricalBacktestReadiness("historical_databento_multicontract", {
    indexState: "ready",
    importLoading: false,
    hasImport: true,
  }).ready, true);
});

test("coverage totals reconcile observed and eligible dates independently", () => {
  assert.deepEqual(getMultiContractCoverageTotals({
    allObservedTradingDates: ["2025-09-10", "2025-09-12"],
    eligibleTradingDates: ["2025-09-10"],
    ineligibleObservedDates: [{ tradingDate: "2025-09-12", observedInAnyFile: true, backtestEligible: false }],
    allObservedDateCount: 2,
    eligibleScheduledReplayDateCount: 1,
    ineligibleObservedDateCount: 1,
    coverageReconciles: true,
  }), {
    allObservedDateCount: 2,
    eligibleScheduledReplayDateCount: 1,
    ineligibleObservedDateCount: 1,
    reconciles: true,
  });
  assert.equal(getMultiContractCoverageTotals({
    allObservedTradingDates: ["2025-09-10"],
    eligibleTradingDates: ["2025-09-10"],
    ineligibleObservedDates: [],
    allObservedDateCount: 2,
    eligibleScheduledReplayDateCount: 1,
    ineligibleObservedDateCount: 0,
    coverageReconciles: false,
  }).reconciles, false);
});

test("coverage labels stay dynamic and accessible without color", () => {
  assert.equal(acceptedOutrightFilesLabel(1), "1 accepted outright MES file");
  assert.equal(acceptedOutrightFilesLabel(9), "9 accepted outright MES files");
  assert.equal(coverageEligibilityLabel(true), "Eligible for backtest");
  assert.equal(coverageEligibilityLabel(false), "Not eligible for backtest");
});