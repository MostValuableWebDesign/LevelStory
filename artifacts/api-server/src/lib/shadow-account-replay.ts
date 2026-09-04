import type { BacktestTrade } from "./phase9.js";
import type { VisualValidationSet, VisualValidationTradeCandidate } from "./visual-validation.js";
import { SHADOW_CONTRACTS_PER_TRADE } from "./strategy/config.js";

export const DEFAULT_SHADOW_ACCOUNT_STARTING_BALANCE = 10_000;
export const DEFAULT_SHADOW_ACCOUNT_CONTRACTS = SHADOW_CONTRACTS_PER_TRADE;

export type ShadowAccountReplayOptions = {
  startingBalance?: number;
  contractsPerTrade?: number;
};

export type ShadowAccountReplaySegment = {
  enteredTrades: number;
  closedTrades: number;
  openTrades: number;
  unscoredTrades: number;
  wins: number;
  losses: number;
  flatTrades: number;
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
  tradingDate: string;
  entryTime: string;
  exitTime: string | null;
  contractSymbol: string;
  primaryEdge: string;
  direction: VisualValidationTradeCandidate["direction"];
  entryPrice: number;
  exitPrice: number | null;
  exitReason: string;
  contracts: number;
  grossPnl: number | null;
  fees: number | null;
  slippage: number | null;
  netPnl: number | null;
  runningBalance: number;
  supportingConfluences: string[];
  period: VisualValidationTradeCandidate["period"];
  status: "closed" | "open" | "unscored";
};

export type ShadowAccountReplayBreakdown = ShadowAccountReplaySegment & {
  value: string;
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
  unscoredTrades: number;
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
  processedDates: string[];
  datesWithTrades: string[];
  datesWithoutTrades: string[];
  byDate: ShadowAccountReplayBreakdown[];
  byPrimaryEdge: ShadowAccountReplayBreakdown[];
  byDirection: ShadowAccountReplayBreakdown[];
  bestTrade: ShadowAccountReplayTrade | null;
  worstTrade: ShadowAccountReplayTrade | null;
  bestTradingDay: ShadowAccountReplayBreakdown | null;
  worstTradingDay: ShadowAccountReplayBreakdown | null;
  inSample: ShadowAccountReplaySegment;
  outOfSample: ShadowAccountReplaySegment;
  equityCurve: Array<{
    tradeNumber: number;
    entryTime: string;
    balance: number;
    netPnl: number | null;
    status: "win" | "loss" | "flat" | "open" | "start";
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
  const unscored = trades.filter((trade) => trade.status === "unscored");
  const open = trades.length - closed.length - unscored.length;
  const wins = closed.filter((trade) => trade.netPnl! > 0);
  const losses = closed.filter((trade) => trade.netPnl! < 0);
  const flatTrades = closed.filter((trade) => trade.netPnl === 0);
  const netPnl = closed.reduce((total, trade) => total + (trade.netPnl ?? 0), 0);
  const grossWins = wins.reduce((total, trade) => total + (trade.netPnl ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((total, trade) => total + (trade.netPnl ?? 0), 0));
  return {
    enteredTrades: trades.length,
    closedTrades: closed.length,
    openTrades: open,
    unscoredTrades: unscored.length,
    wins: wins.length,
    losses: losses.length,
    flatTrades: flatTrades.length,
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

function scaleTradeValue(value: number, trade: BacktestTrade, contractsPerTrade: number): number {
  const sourceContracts = trade.contracts > 0 ? trade.contracts : 1;
  return roundMoney(value * (contractsPerTrade / sourceContracts));
}

function breakdown(value: string, trades: ShadowAccountReplayTrade[]): ShadowAccountReplayBreakdown {
  return { value, ...segmentStats(trades) };
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
  const contractsPerTrade = Math.max(2, Math.min(100, Math.floor(safePositive(options.contractsPerTrade, DEFAULT_SHADOW_ACCOUNT_CONTRACTS))));
  const candidatesById = new Map(set.tradeCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const matchingTrades: MatchedTrade[] = [];
  const seenTradeIds = new Set<string>();
  const warnings: string[] = [];
  const replaySources = Array.isArray(set.accountReplayTrades)
    ? set.accountReplayTrades
    : set.snapshots.flatMap((snapshot) => snapshot.machineEvidence.trade
      ? [{ candidate: candidatesById.get(snapshot.machineEvidence.trade.candidateId ?? ""), trade: snapshot.machineEvidence.trade, snapshotId: snapshot.snapshotId }]
      : []);

  for (const source of replaySources) {
    const trade = source.trade;
    if (!trade?.candidateId || !trade.signalOccurrenceId) continue;
    const candidate = source.candidate ?? candidatesById.get(trade.candidateId);
    if (!candidate || candidate.signalOccurrenceId !== trade.signalOccurrenceId) continue;
    if (seenTradeIds.has(trade.id)) continue;
    seenTradeIds.add(trade.id);
    matchingTrades.push({ candidate, snapshotId: source.snapshotId ?? candidate.snapshotId, trade });
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

  const processedDates = [...new Set(set.processedDates ?? [
    ...set.tradeCandidates.map((candidate) => candidate.tradingDate),
    ...matchingTrades.map((match) => match.trade.tradingDate),
  ])].sort();
  let runningBalance = startingBalance;
  const ledger: ShadowAccountReplayTrade[] = [];
  const equityCurve: ShadowAccountReplay["equityCurve"] = [];
  equityCurve.push({
    tradeNumber: 0,
    entryTime: processedDates[0] ? `${processedDates[0]}T00:00:00.000Z` : new Date(0).toISOString(),
    balance: startingBalance,
    netPnl: null,
    status: "start",
  });
  for (const match of [...selectedByCandidate.values()].sort((left, right) =>
    Date.parse(left.trade.entryTime) - Date.parse(right.trade.entryTime)
    || left.candidate.candidateId.localeCompare(right.candidate.candidateId))) {
    const { candidate, trade } = match;
    const unscored = Boolean(trade.ambiguityLabel || trade.audit?.ambiguityLabels?.length);
    const closed = !unscored && trade.exitTime !== null && trade.outcome !== "open";
    const status = unscored ? "unscored" as const : closed ? "closed" as const : "open" as const;
    const netPnl = closed ? scaleNetPnl(trade, contractsPerTrade) : null;
    if (netPnl !== null) runningBalance = roundMoney(runningBalance + netPnl);
    const ledgerTrade: ShadowAccountReplayTrade = {
      tradeNumber: ledger.length + 1,
      candidateId: candidate.candidateId,
      signalOccurrenceId: candidate.signalOccurrenceId,
      snapshotId: candidate.snapshotId,
      tradingDate: trade.tradingDate,
      entryTime: trade.entryTime,
      exitTime: closed ? trade.exitTime : null,
      contractSymbol: candidate.contractSymbol,
      primaryEdge: candidate.primaryEdge,
      direction: candidate.direction,
      entryPrice: trade.entryPrice,
      exitPrice: closed ? trade.exitPrice : null,
      exitReason: unscored ? "unscored" : closed ? (trade.audit?.exitReason ?? trade.outcome) : "open",
      contracts: contractsPerTrade,
      grossPnl: closed ? scaleTradeValue(trade.grossPnl, trade, contractsPerTrade) : null,
      fees: closed ? scaleTradeValue(trade.fees, trade, contractsPerTrade) : null,
      slippage: closed ? scaleTradeValue(trade.slippage, trade, contractsPerTrade) : null,
      netPnl,
      runningBalance,
      supportingConfluences: [...candidate.supportingConfluences],
      period: candidate.period,
      status,
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
  const datesWithTrades = [...new Set(ledger.map((trade) => trade.tradingDate))].sort();
  const datesWithoutTrades = processedDates.filter((date) => !datesWithTrades.includes(date));
  const byDate = processedDates.map((date) => breakdown(date, ledger.filter((trade) => trade.tradingDate === date)));
  const byPrimaryEdge = [...new Set(ledger.map((trade) => trade.primaryEdge))].sort()
    .map((value) => breakdown(value, ledger.filter((trade) => trade.primaryEdge === value)));
  const byDirection = ["long", "short"].filter((value) => ledger.some((trade) => trade.direction === value))
    .map((value) => breakdown(value, ledger.filter((trade) => trade.direction === value)));
  const closedLedger = ledger.filter((trade) => trade.status === "closed" && trade.netPnl !== null);
  const bestTrade = closedLedger.reduce<ShadowAccountReplayTrade | null>(
    (best, trade) => !best || trade.netPnl! > best.netPnl! ? trade : best,
    null,
  );
  const worstTrade = closedLedger.reduce<ShadowAccountReplayTrade | null>(
    (worst, trade) => !worst || trade.netPnl! < worst.netPnl! ? trade : worst,
    null,
  );
  const bestTradingDay = byDate.filter((item) => item.closedTrades > 0)
    .reduce<ShadowAccountReplayBreakdown | null>((best, item) => !best || item.netPnl > best.netPnl ? item : best, null);
  const worstTradingDay = byDate.filter((item) => item.closedTrades > 0)
    .reduce<ShadowAccountReplayBreakdown | null>((worst, item) => !worst || item.netPnl < worst.netPnl ? item : worst, null);
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
    unscoredTrades: summary.unscoredTrades,
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
    processedDates,
    datesWithTrades,
    datesWithoutTrades,
    byDate,
    byPrimaryEdge,
    byDirection,
    bestTrade,
    worstTrade,
    bestTradingDay,
    worstTradingDay,
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