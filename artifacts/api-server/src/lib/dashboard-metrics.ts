import type { JournalEntry } from "@workspace/db";

export type DashboardJournalEntry = Pick<
  JournalEntry,
  "setup" | "tradingDate" | "execution" | "pnl" | "netPnl"
>;

export type DashboardSetupPerformance = {
  setupType: string;
  reviewCount: number;
  triggeredCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  netPnl: number;
};

export function summarizeDashboardEntries(
  entries: readonly DashboardJournalEntry[],
  tradingDate: string,
) {
  const scopedEntries = entries.filter((entry) => entry.tradingDate === tradingDate);
  const recentEntries = scopedEntries.slice(0, 5);
  const isTriggeredTrade = (entry: DashboardJournalEntry) => entry.execution !== null;
  const pnlFor = (entry: DashboardJournalEntry) => entry.netPnl ?? entry.pnl ?? 0;
  const triggeredTrades = scopedEntries.filter(isTriggeredTrade);
  const openTrades = triggeredTrades.filter((entry) => entry.pnl === null);
  const closedTrades = triggeredTrades.filter((entry) => entry.pnl !== null);
  const wins = closedTrades.filter((entry) => pnlFor(entry) > 0);
  const losses = closedTrades.filter((entry) => pnlFor(entry) < 0);
  const breakeven = closedTrades.filter((entry) => pnlFor(entry) === 0);
  const pnl = closedTrades.reduce((total, entry) => total + pnlFor(entry), 0);
  const setupTypes = [
    "ORB_BREAK_PULLBACK_CONTINUATION",
    "EXTENDED_NTZ_CONSOLIDATION_BREAKOUT",
    "BONUS_REVERSAL",
  ];
  const setupPerformance: DashboardSetupPerformance[] = setupTypes.map((setupType) => {
    const setupEntries = scopedEntries.filter((entry) => entry.setup === setupType);
    const setupTriggered = setupEntries.filter(isTriggeredTrade);
    const setupClosed = setupTriggered.filter((entry) => entry.pnl !== null);
    const setupPnl = setupClosed.reduce((total, entry) => total + pnlFor(entry), 0);
    const setupWins = setupClosed.filter((entry) => pnlFor(entry) > 0).length;
    return {
      setupType,
      reviewCount: setupEntries.length,
      triggeredCount: setupTriggered.length,
      closedCount: setupClosed.length,
      wins: setupWins,
      losses: setupClosed.filter((entry) => pnlFor(entry) < 0).length,
      breakeven: setupClosed.filter((entry) => pnlFor(entry) === 0).length,
      winRate: setupClosed.length ? Number(((setupWins / setupClosed.length) * 100).toFixed(1)) : 0,
      netPnl: Number(setupPnl.toFixed(2)),
    };
  });

  return {
    scopedEntries,
    recentEntries,
    sessionPnl: Number(pnl.toFixed(2)),
    triggeredTradeCount: triggeredTrades.length,
    reviewCount: scopedEntries.length,
    openTradeCount: openTrades.length,
    closedTradeCount: closedTrades.length,
    winCount: wins.length,
    lossCount: losses.length,
    breakevenCount: breakeven.length,
    winRate: closedTrades.length ? Number(((wins.length / closedTrades.length) * 100).toFixed(1)) : 0,
    setupPerformance,
  };
}