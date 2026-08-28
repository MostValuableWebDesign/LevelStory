import assert from "node:assert/strict";
import test from "node:test";
import { getHistoricalBacktestReadiness } from "../src/lib/backtest-state.ts";

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