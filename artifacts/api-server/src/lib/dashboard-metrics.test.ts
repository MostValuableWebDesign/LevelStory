import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDashboardEntries, type DashboardJournalEntry } from "./dashboard-metrics.js";

function entry(
  setup: string,
  pnl: number | null,
  triggered: boolean,
  tradingDate = "2026-08-25",
): DashboardJournalEntry {
  return {
    setup,
    tradingDate,
    execution: triggered ? {} : null,
    pnl,
    netPnl: pnl,
  };
}

test("dashboard metrics use every applicable record, not only the five recent reviews", () => {
  const entries = [
    entry("ORB_BREAK_PULLBACK_CONTINUATION", null, true),
    entry("ORB_BREAK_PULLBACK_CONTINUATION", 100, true),
    entry("ORB_BREAK_PULLBACK_CONTINUATION", 50, true),
    entry("ORB_BREAK_PULLBACK_CONTINUATION", -40, true),
    entry("ORB_BREAK_PULLBACK_CONTINUATION", -20, true),
    entry("ORB_BREAK_PULLBACK_CONTINUATION", 0, true),
    entry("ORB_BREAK_PULLBACK_CONTINUATION", 0, true),
    entry("EXTENDED_NTZ_CONSOLIDATION_BREAKOUT", null, false),
    entry("ORB_BREAK_PULLBACK_CONTINUATION", 999, true, "2026-08-26"),
  ];
  const summary = summarizeDashboardEntries(entries, "2026-08-25");

  assert.equal(summary.reviewCount, 8);
  assert.equal(summary.recentEntries.length, 5);
  assert.equal(summary.triggeredTradeCount, 7);
  assert.equal(summary.openTradeCount, 1);
  assert.equal(summary.closedTradeCount, 6);
  assert.equal(summary.winCount, 2);
  assert.equal(summary.lossCount, 2);
  assert.equal(summary.breakevenCount, 2);
  assert.equal(summary.sessionPnl, 90);
  assert.equal(summary.winRate, 33.3);
});

test("descriptive evaluations stay reviews and never become trades", () => {
  const summary = summarizeDashboardEntries([
    entry("BONUS_REVERSAL", null, false),
    entry("BONUS_REVERSAL", null, false),
  ], "2026-08-25");
  const reversal = summary.setupPerformance.find((item) => item.setupType === "BONUS_REVERSAL")!;

  assert.equal(summary.reviewCount, 2);
  assert.equal(summary.triggeredTradeCount, 0);
  assert.equal(summary.closedTradeCount, 0);
  assert.equal(summary.winCount, 0);
  assert.equal(summary.lossCount, 0);
  assert.equal(summary.breakevenCount, 0);
  assert.equal(reversal.reviewCount, 2);
  assert.equal(reversal.triggeredCount, 0);
  assert.equal(reversal.closedCount, 0);
});