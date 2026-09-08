export const ACCOUNT_POSITION_STATE_VERSION = "account-position-state-v1-single-active-trade";

export type AccountPositionStatus = "closed" | "open" | "unscored";

export type ActiveAccountPosition = {
  tradeId: string;
  candidateId: string;
  signalOccurrenceId: string;
  entryTime: string;
  fullExitTime: string | null;
  status: AccountPositionStatus;
  contracts: number;
  remainingContracts: number;
  runnerActive: boolean;
};

export type AccountEntryBlock = {
  reason: "ACCOUNT_ENTRY_BLOCKED_ACTIVE_POSITION";
  blockedAt: string;
  blockingTradeId: string;
  blockingCandidateId: string;
  blockingSignalOccurrenceId: string;
  blockingEntryTime: string;
  blockingFullExitTime: string | null;
  blockingStatus: AccountPositionStatus;
  blockingContracts: number;
  blockingRemainingContracts: number;
  blockingRunnerActive: boolean;
};

export function activeAccountPositionAt(
  position: ActiveAccountPosition,
  entryTime: string,
): boolean {
  const entryTimestamp = Date.parse(entryTime);
  if (!Number.isFinite(entryTimestamp)) return true;
  const exitTimestamp = position.fullExitTime === null ? Number.NaN : Date.parse(position.fullExitTime);
  if (!Number.isFinite(exitTimestamp)) return true;
  // A completed full exit is effective at its completed timestamp. If the
  // timestamps are ambiguous or the exit is later, remain conservative.
  return exitTimestamp > entryTimestamp;
}

export function accountEntryBlockFor(
  position: ActiveAccountPosition,
  entryTime: string,
): AccountEntryBlock | null {
  if (!activeAccountPositionAt(position, entryTime)) return null;
  return {
    reason: "ACCOUNT_ENTRY_BLOCKED_ACTIVE_POSITION",
    blockedAt: entryTime,
    blockingTradeId: position.tradeId,
    blockingCandidateId: position.candidateId,
    blockingSignalOccurrenceId: position.signalOccurrenceId,
    blockingEntryTime: position.entryTime,
    blockingFullExitTime: position.fullExitTime,
    blockingStatus: position.status,
    blockingContracts: position.contracts,
    blockingRemainingContracts: position.remainingContracts,
    blockingRunnerActive: position.runnerActive,
  };
}

export function activeAccountPositionFromTrade(input: {
  tradeId: string;
  candidateId: string;
  signalOccurrenceId: string;
  entryTime: string;
  exitTime: string | null;
  status: AccountPositionStatus;
  contracts: number;
  remainingContracts: number;
  runnerActive: boolean;
}): ActiveAccountPosition {
  return {
    tradeId: input.tradeId,
    candidateId: input.candidateId,
    signalOccurrenceId: input.signalOccurrenceId,
    entryTime: input.entryTime,
    fullExitTime: input.exitTime,
    status: input.status,
    contracts: input.contracts,
    remainingContracts: Math.max(0, input.remainingContracts),
    runnerActive: input.runnerActive || input.remainingContracts > 0 && input.contracts > 1,
  };
}