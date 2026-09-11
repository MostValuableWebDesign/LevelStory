export const ACCOUNT_POSITION_STATE_VERSION = "account-position-state-v2-authoritative-ambiguous-exits";

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

type ExitLegEvidence = {
  kind?: "target" | "runner" | "full";
  quantity?: number;
  exitCandleCloseTime?: string;
};

export class InvalidAccountPositionEvidenceError extends Error {
  readonly code = "INVALID_ACCOUNT_POSITION_TIMESTAMP";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAccountPositionEvidenceError";
  }
}

function validTimestamp(value: string | null | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function authoritativeFullExitTime(input: {
  status: AccountPositionStatus;
  exitTime: string | null;
  exitCandleCloseTime?: string | null;
  remainingContracts: number;
  exitLegs?: readonly ExitLegEvidence[];
}): string | null {
  if (!validTimestamp(input.exitTime) || input.remainingContracts > 0) return null;
  if (input.status === "closed") return input.exitTime;
  if (input.status !== "unscored") return null;

  const hasExitCandle = validTimestamp(input.exitCandleCloseTime);
  const hasExitLeg = (input.exitLegs ?? []).some((leg) =>
    Number.isFinite(leg.quantity)
    && (leg.quantity ?? 0) > 0
    && validTimestamp(leg.exitCandleCloseTime),
  );
  return hasExitCandle && hasExitLeg ? input.exitTime : null;
}

export function activeAccountPositionAt(
  position: ActiveAccountPosition,
  queryTime: string,
): boolean {
  const positionEntryTimestamp = Date.parse(position.entryTime);
  if (!Number.isFinite(positionEntryTimestamp)) {
    throw new InvalidAccountPositionEvidenceError(
      `Invalid account position entry timestamp for ${position.tradeId}.`,
    );
  }
  const queryTimestamp = Date.parse(queryTime);
  if (!Number.isFinite(queryTimestamp)) {
    throw new InvalidAccountPositionEvidenceError(
      `Invalid account position query timestamp for ${position.tradeId}.`,
    );
  }
  const exitTimestamp = position.fullExitTime === null ? Number.NaN : Date.parse(position.fullExitTime);
  if (!Number.isFinite(exitTimestamp)) return true;
  // A completed full exit is effective at its completed timestamp. If the
  // timestamps are ambiguous or the exit is later, remain conservative.
  return positionEntryTimestamp <= queryTimestamp && queryTimestamp < exitTimestamp;
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
  exitCandleCloseTime?: string | null;
  exitLegs?: readonly ExitLegEvidence[];
}): ActiveAccountPosition {
  const remainingContracts = Math.max(0, input.remainingContracts);
  return {
    tradeId: input.tradeId,
    candidateId: input.candidateId,
    signalOccurrenceId: input.signalOccurrenceId,
    entryTime: input.entryTime,
    fullExitTime: authoritativeFullExitTime({
      status: input.status,
      exitTime: input.exitTime,
      exitCandleCloseTime: input.exitCandleCloseTime,
      remainingContracts,
      exitLegs: input.exitLegs,
    }),
    status: input.status,
    contracts: input.contracts,
    remainingContracts,
    runnerActive: input.runnerActive || input.remainingContracts > 0 && input.contracts > 1,
  };
}