import type { BacktestTrade } from "./phase9.js";
import type { VisualValidationSet, VisualValidationTradeCandidate } from "./visual-validation.js";

export const DEFAULT_SHADOW_ACCOUNT_STARTING_BALANCE = 10_000;
export const DEFAULT_SHADOW_ACCOUNT_CONTRACTS = 1;

export type ShadowAccountReplayOptions = {
  startingBalance?: number;
  contractsPerTrade?: number;
};

export type ShadowAccountReplaySegment = {
  enteredTrades: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number | null;
  expectancyPerTrade: number;
};

export type ShadowAccountReplayTrade = {
  tradeNumber: number;
  candidateId: string;
  signalOccurrenceId: string;
  snapshotId: string;
  entryTime: string;
  contractSymbol: string;
  primaryEdge: string;
  direction: VisualValidationTradeCandidate["direction"];
  entryPrice: number;
  exitPrice: number | null;
  exitReason: string;
  netPnl: number | null;
  runningBalance: number;
  supportingConfluences: string[];
  period: VisualValidationTradeCandidate["period"];
  status: "closed" | "open";
};

export type ShadowAccountReplay = {
  reviewSetId: string;
  startingBalance: number;
  endingRealizedBalance: number;
  realizedNetPnl: number;
  percentReturn: number;
  candidateTrades: number;
  enteredTrades: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number | null;
  maxDrawdown: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  expectancyPerTrade: number;
  inSample: ShadowAccountReplaySegment;
  outOfSample: ShadowAccountReplaySegment;
  equityCurve: Array<{
    tradeNumber: number;
    entryTime: string;
    balance: number;
    netPnl: number | null;
    status: "win" | "loss" | "flat" | "open";
  }>;
  ledger: ShadowAccountReplayTrade[];
  stale: boolean;
  cacheKey: string;
  formulaHash: string;
  sourceFingerprint: string;
  candidateProjectionVersion: string;
  executionManagementVersion: string;
  warnings: string[];
};

type MatchedTrade = {
  candidate: VisualValidationTradeCandidate;
  snapshotId: string;
  trade: BacktestTrade;
};

function safePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function segmentStats(trades: ShadowAccountReplayTrade[]): ShadowAccountReplaySegment {
  const closed = trades.filter((trade) => trade.status === "closed" && trade.netPnl !== null);
  const open = trades.length - closed.length;
  const wins = closed.filter((trade) => trade.netPnl! > 0);
  const losses = closed.filter((trade) => trade.netPnl! < 0);
  const netPnl = closed.reduce((total, trade) => total + (trade.netPnl ?? 0), 0);
  const grossWins = wins.reduce((total, trade) => total + (trade.netPnl ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((total, trade) => total + (trade.netPnl ?? 0), 0));
  return {
    enteredTrades: trades.length,
    closedTrades: closed.length,
    openTrades: open,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    netPnl: roundMoney(netPnl),
    averageWin: wins.length ? roundMoney(grossWins / wins.length) : 0,
    averageLoss: losses.length ? roundMoney(-grossLosses / losses.length) : 0,
    profitFactor: grossLosses > 0 ? roundMoney(grossWins / grossLosses) : wins.length ? null : 0,
    expectancyPerTrade: closed.length ? roundMoney(netPnl / closed.length) : 0,
  };
}

function isWithinEntryCutoff(entryTime: string): boolean {
  const timestamp = Date.parse(entryTime);
  if (!Number.isFinite(timestamp)) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) && (hour < 13 || (hour === 13 && minute === 0));
}

function scaleNetPnl(trade: BacktestTrade, contractsPerTrade: number): number {
  const sourceContracts = trade.contracts > 0 ? trade.contracts : 1;
  return roundMoney(trade.netPnl * (contractsPerTrade / sourceContracts));
}

function consecutiveStats(trades: ShadowAccountReplayTrade[]): { maxWins: number; maxLosses: number } {
  let wins = 0;
  let losses = 0;
  let maxWins = 0;
  let maxLosses = 0;
  for (const trade of trades) {
    if (trade.status !== "closed" || trade.netPnl === null) continue;
    if (trade.netPnl > 0) {
      wins += 1;
      losses = 0;
      maxWins = Math.max(maxWins, wins);
    } else if (trade.netPnl < 0) {
      losses += 1;
      wins = 0;
      maxLosses = Math.max(maxLosses, losses);
    } else {
      wins = 0;
      losses = 0;
    }
  }
  return { maxWins, maxLosses };
}

export function buildShadowAccountReplay(
  set: VisualValidationSet,
  options: ShadowAccountReplayOptions = {},
): ShadowAccountReplay {
  const startingBalance = roundMoney(safePositive(options.startingBalance, DEFAULT_SHADOW_ACCOUNT_STARTING_BALANCE));
  const contractsPerTrade = Math.max(1, Math.min(100, Math.floor(safePositive(options.contractsPerTrade, DEFAULT_SHADOW_ACCOUNT_CONTRACTS))));
  const candidatesById = new Map(set.tradeCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const matchingTrades: MatchedTrade[] = [];
  const seenTradeIds = new Set<string>();
  const warnings: string[] = [];

  for (const snapshot of set.snapshots) {
    const trade = snapshot.machineEvidence.trade;
    if (!trade?.candidateId || !trade.signalOccurrenceId) continue;
    const candidate = candidatesById.get(trade.candidateId);
    if (!candidate || candidate.signalOccurrenceId !== trade.signalOccurrenceId) continue;
    if (seenTradeIds.has(trade.id)) continue;
    seenTradeIds.add(trade.id);
    matchingTrades.push({ candidate, snapshotId: candidate.snapshotId, trade });
  }

  matchingTrades.sort((left, right) =>
    Date.parse(left.trade.entryTime) - Date.parse(right.trade.entryTime)
    || left.candidate.candidateId.localeCompare(right.candidate.candidateId)
    || left.trade.id.localeCompare(right.trade.id));

  const selectedByCandidate = new Map<string, MatchedTrade>();
  for (const match of matchingTrades) {
    if (!isWithinEntryCutoff(match.trade.entryTime)) {
      warnings.push(`Ignored candidate ${match.candidate.candidateId}: entry is after the existing 1:00 PM ET cutoff or has an invalid timestamp.`);
      continue;
    }
    if (selectedByCandidate.has(match.candidate.candidateId)) {
      warnings.push(`Ignored duplicate candidate-owned modeled trade for ${match.candidate.candidateId}.`);
      continue;
    }
    selectedByCandidate.set(match.candidate.candidateId, match);
  }

  let runningBalance = startingBalance;
  const ledger: ShadowAccountReplayTrade[] = [];
  const equityCurve: ShadowAccountReplay["equityCurve"] = [];
  for (const match of [...selectedByCandidate.values()].sort((left, right) =>
    Date.parse(left.trade.entryTime) - Date.parse(right.trade.entryTime)
    || left.candidate.candidateId.localeCompare(right.candidate.candidateId))) {
    const { candidate, trade } = match;
    const closed = trade.exitTime !== null && trade.outcome !== "open";
    const netPnl = closed ? scaleNetPnl(trade, contractsPerTrade) : null;
    if (netPnl !== null) runningBalance = roundMoney(runningBalance + netPnl);
    const ledgerTrade: ShadowAccountReplayTrade = {
      tradeNumber: ledger.length + 1,
      candidateId: candidate.candidateId,
      signalOccurrenceId: candidate.signalOccurrenceId,
      snapshotId: candidate.snapshotId,
      entryTime: trade.entryTime,
      contractSymbol: candidate.contractSymbol,
      primaryEdge: candidate.primaryEdge,
      direction: candidate.direction,
      entryPrice: trade.entryPrice,
      exitPrice: closed ? trade.exitPrice : null,
      exitReason: closed ? (trade.audit?.exitReason ?? trade.outcome) : "open",
      netPnl,
      runningBalance,
      supportingConfluences: [...candidate.supportingConfluences],
      period: candidate.period,
      status: closed ? "closed" : "open",
    };
    ledger.push(ledgerTrade);
    equityCurve.push({
      tradeNumber: ledgerTrade.tradeNumber,
      entryTime: ledgerTrade.entryTime,
      balance: runningBalance,
      netPnl,
      status: netPnl === null ? "open" : netPnl > 0 ? "win" : netPnl < 0 ? "loss" : "flat",
    });
  }

  const closedTrades = ledger.filter((trade) => trade.status === "closed");
  const summary = segmentStats(ledger);
  const inSample = segmentStats(ledger.filter((trade) => trade.period === "in_sample"));
  const outOfSample = segmentStats(ledger.filter((trade) => trade.period === "out_of_sample"));
  let peak = startingBalance;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.balance);
    maxDrawdown = Math.max(maxDrawdown, peak - point.balance);
  }
  const consecutive = consecutiveStats(ledger);
  const realizedNetPnl = roundMoney(closedTrades.reduce((total, trade) => total + (trade.netPnl ?? 0), 0));

  return {
    reviewSetId: set.reviewSetId,
    startingBalance,
    endingRealizedBalance: roundMoney(startingBalance + realizedNetPnl),
    realizedNetPnl,
    percentReturn: roundMoney((realizedNetPnl / startingBalance) * 100),
    candidateTrades: set.tradeCandidates.length,
    enteredTrades: ledger.length,
    closedTrades: summary.closedTrades,
    openTrades: summary.openTrades,
    wins: summary.wins,
    losses: summary.losses,
    winRate: summary.winRate,
    averageWin: summary.averageWin,
    averageLoss: summary.averageLoss,
    profitFactor: summary.profitFactor,
    maxDrawdown: roundMoney(maxDrawdown),
    maxConsecutiveWins: consecutive.maxWins,
    maxConsecutiveLosses: consecutive.maxLosses,
    expectancyPerTrade: summary.expectancyPerTrade,
    inSample,
    outOfSample,
    equityCurve,
    ledger,
    stale: set.stale,
    cacheKey: set.cacheKey,
    formulaHash: set.formulaHash,
    sourceFingerprint: set.sourceFingerprint,
    candidateProjectionVersion: set.candidateProjectionVersion,
    executionManagementVersion: set.executionManagementVersion,
    warnings: [...new Set(warnings)],
  };
}