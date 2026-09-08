import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEntryBlockFor,
  activeAccountPositionFromTrade,
} from "./account-position-gate.js";

const entry = "2026-08-25T14:00:00.000Z";

function position(overrides: Partial<Parameters<typeof activeAccountPositionFromTrade>[0]> = {}) {
  return activeAccountPositionFromTrade({
    tradeId: "trade-1",
    candidateId: "candidate-1",
    signalOccurrenceId: "occurrence-1",
    entryTime: "2026-08-25T13:35:00.000Z",
    exitTime: "2026-08-25T14:30:00.000Z",
    status: "closed",
    contracts: 1,
    remainingContracts: 0,
    runnerActive: false,
    ...overrides,
  });
}

test("a full exit before a later candidate permits entry", () => {
  assert.equal(accountEntryBlockFor(position({ exitTime: "2026-08-25T13:59:00.000Z" }), entry), null);
});

test("a full exit at the candidate timestamp permits entry", () => {
  assert.equal(accountEntryBlockFor(position({ exitTime: entry }), entry), null);
});

test("a later full exit blocks entry", () => {
  assert.equal(accountEntryBlockFor(position(), entry)?.reason, "ACCOUNT_ENTRY_BLOCKED_ACTIVE_POSITION");
});

test("an open one-contract position blocks entry", () => {
  assert.equal(accountEntryBlockFor(position({ exitTime: null, status: "open" }), entry)?.blockingStatus, "open");
});

test("an unscored position blocks conservatively", () => {
  assert.equal(accountEntryBlockFor(position({ exitTime: null, status: "unscored" }), entry)?.blockingStatus, "unscored");
});

test("an invalid exit timestamp blocks conservatively", () => {
  assert.equal(accountEntryBlockFor(position({ exitTime: "not-a-date" }), entry)?.reason, "ACCOUNT_ENTRY_BLOCKED_ACTIVE_POSITION");
});

test("an ambiguous but fully evidenced zero-quantity exit releases the gate", () => {
  const exitTime = "2026-08-25T14:20:00.000Z";
  const flatAmbiguous = position({
    status: "unscored",
    exitTime,
    exitCandleCloseTime: exitTime,
    exitLegs: [{ kind: "full", quantity: 1, exitCandleCloseTime: exitTime }],
    remainingContracts: 0,
  });
  assert.equal(accountEntryBlockFor(flatAmbiguous, "2026-08-25T14:20:00.000Z"), null);
  assert.equal(accountEntryBlockFor(flatAmbiguous, "2026-08-25T14:21:00.000Z"), null);
});

test("an ambiguous trade without authoritative full-exit evidence remains active", () => {
  const unresolved = position({ status: "unscored", exitTime: "2026-08-25T14:20:00.000Z", remainingContracts: 0 });
  assert.equal(accountEntryBlockFor(unresolved, "2026-08-25T14:21:00.000Z")?.blockingStatus, "unscored");
});

test("one-contract state reports no runner", () => {
  assert.equal(position({ contracts: 1, remainingContracts: 0 }).runnerActive, false);
});

test("two-contract state with remaining quantity reports a runner", () => {
  assert.equal(position({ contracts: 2, remainingContracts: 1 }).runnerActive, true);
});

test("explicit runner activation survives zero remaining quantity metadata", () => {
  assert.equal(position({ contracts: 2, remainingContracts: 0, runnerActive: true }).runnerActive, true);
});

test("closed two-contract trades retain their contract count in the block", () => {
  const block = accountEntryBlockFor(position({ contracts: 2 }), entry);
  assert.equal(block?.blockingContracts, 2);
});

test("blocked state retains the remaining runner quantity", () => {
  const block = accountEntryBlockFor(position({ contracts: 2, remainingContracts: 1 }), entry);
  assert.equal(block?.blockingRemainingContracts, 1);
});

test("blocked state retains the blocking trade identity", () => {
  const block = accountEntryBlockFor(position({ tradeId: "trade-blocker" }), entry);
  assert.equal(block?.blockingTradeId, "trade-blocker");
});

test("blocked state retains the blocking candidate identity", () => {
  const block = accountEntryBlockFor(position({ candidateId: "candidate-blocker" }), entry);
  assert.equal(block?.blockingCandidateId, "candidate-blocker");
});

test("blocked state retains both causal timestamps", () => {
  const block = accountEntryBlockFor(position(), entry);
  assert.equal(block?.blockingEntryTime, "2026-08-25T13:35:00.000Z");
  assert.equal(block?.blockedAt, entry);
});

test("a position on a prior trading date still blocks when it has not fully exited", () => {
  const block = accountEntryBlockFor(position({
    entryTime: "2026-08-25T19:00:00.000Z",
    exitTime: "2026-08-26T14:30:00.000Z",
  }), "2026-08-26T14:00:00.000Z");
  assert.equal(block?.reason, "ACCOUNT_ENTRY_BLOCKED_ACTIVE_POSITION");
});