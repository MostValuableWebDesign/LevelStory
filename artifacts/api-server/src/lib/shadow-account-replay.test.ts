import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildShadowAccountReplay,
  DEFAULT_SHADOW_ACCOUNT_STARTING_BALANCE,
} from "./shadow-account-replay.js";
import type { BacktestTrade } from "./phase9.js";
import type {
  VisualValidationSet,
  VisualValidationSnapshot,
  VisualValidationTradeCandidate,
} from "./visual-validation.js";

const reviewSetId = "00000000-0000-0000-0000-000000000001";

function candidate(id: string, period: VisualValidationTradeCandidate["period"] = "in_sample"): VisualValidationTradeCandidate {
  return {
    candidateId: id,
    snapshotId: `snapshot-${id}`,
    signalOccurrenceId: `occurrence-${id}`,
    contractSymbol: "MESU26",
    tradingDate: "2026-08-25",
    entryCandleOpenTime: "2026-08-25T13:30:00.000Z",
    entryCandleCloseTime: "2026-08-25T13:35:00.000Z",
    direction: "long",
    entryTriggerPrice: 100,
    primaryEdge: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
    matchedEdges: ["ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION"],
    supportingConfluences: ["VWAP"],
    setupGrade: "A+",
    period,
    outcome: "target",
    causalEvidence: [],
  };
}

function trade(
  id: string,
  netPnl: number,
  candidateId: string,
  overrides: Partial<BacktestTrade> = {},
): BacktestTrade {
  return {
    id,
    tradingDate: "2026-08-25",
    contractSymbol: "MESU26",
    contractMonth: "2026-09",
    period: "in_sample",
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long",
    entryTime: "2026-08-25T13:35:00.000Z",
    exitTime: "2026-08-25T14:00:00.000Z",
    entryPrice: 100,
    exitPrice: 105,
    contracts: 1,
    grossPnl: netPnl,
    fees: 0,
    slippage: 0,
    netPnl,
    outcome: netPnl >= 0 ? "target" : "strategy stop",
    ambiguityLabel: null,
    source: "tick",
    segmentation: {
      contract: "MESU26",
      contractMonth: "2026-09",
      setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
      direction: "long",
      timeOfDay: "open",
      trend: "bullish",
      fibonacciDepth: "normal",
      volumeCondition: "supported",
      levelType: "ORB",
      confluence: "normal",
      patienceCharacteristic: "ENTRY_TRIGGERED",
      orbState: "ENTRY_TRIGGERED",
      marketRegime: "trend",
    },
    candidateId,
    signalOccurrenceId: `occurrence-${candidateId}`,
    ...overrides,
  };
}

function snapshot(tradeRecord: BacktestTrade | null): VisualValidationSnapshot {
  return { machineEvidence: { trade: tradeRecord } } as unknown as VisualValidationSnapshot;
}

function replaySet(
  candidates: VisualValidationTradeCandidate[],
  snapshots: VisualValidationSnapshot[],
  stale = false,
): VisualValidationSet {
  return {
    reviewSetId,
    stale,
    cacheKey: "cache-key",
    formulaHash: "formula-hash",
    sourceFingerprint: "source-fingerprint",
    candidateProjectionVersion: "candidate-v1",
    executionManagementVersion: "execution-v1",
    tradeCandidates: candidates,
    snapshots,
  } as unknown as VisualValidationSet;
}

test("two wins and one loss update the fixed-size ending balance", () => {
  const candidates = ["a", "b", "c"].map((id) => candidate(id));
  const result = buildShadowAccountReplay(replaySet(candidates, [
    snapshot(trade("trade-a", 100, "a")),
    snapshot(trade("trade-b", -50, "b", { entryTime: "2026-08-25T14:35:00.000Z" })),
    snapshot(trade("trade-c", 200, "c", { entryTime: "2026-08-25T15:35:00.000Z" })),
  ]));

  assert.equal(result.startingBalance, DEFAULT_SHADOW_ACCOUNT_STARTING_BALANCE);
  assert.equal(result.endingRealizedBalance, 10500);
  assert.equal(result.realizedNetPnl, 500);
  assert.equal(result.wins, 2);
  assert.equal(result.losses, 1);
  assert.equal(result.maxConsecutiveWins, 1);
  assert.equal(result.maxConsecutiveLosses, 1);
});

test("open trades are listed but excluded from realized account metrics", () => {
  const open = trade("open", 0, "open", { exitTime: null, exitPrice: null, outcome: "open" });
  const result = buildShadowAccountReplay(replaySet(
    [candidate("open"), candidate("closed")],
    [snapshot(open), snapshot(trade("closed", 100, "closed", { entryTime: "2026-08-25T14:35:00.000Z" }))],
  ));

  assert.equal(result.enteredTrades, 2);
  assert.equal(result.openTrades, 1);
  assert.equal(result.closedTrades, 1);
  assert.equal(result.realizedNetPnl, 200);
  assert.equal(result.ledger[0]?.netPnl, null);
  assert.equal(result.equityCurve[0]?.status, "start");
  assert.equal(result.equityCurve[1]?.status, "open");
});

test("ambiguous outcomes remain visible as unscored without changing realized balance", () => {
  const result = buildShadowAccountReplay(replaySet(
    [candidate("ambiguous")],
    [snapshot(trade("ambiguous-trade", 100, "ambiguous", { ambiguityLabel: "AMBIGUOUS_STOP_FIRST" }))],
  ));

  assert.equal(result.enteredTrades, 1);
  assert.equal(result.unscoredTrades, 1);
  assert.equal(result.closedTrades, 0);
  assert.equal(result.realizedNetPnl, 0);
  assert.equal(result.ledger[0]?.status, "unscored");
  assert.equal(result.ledger[0]?.netPnl, null);
});

test("candidates without modeled trades do not affect the account", () => {
  const result = buildShadowAccountReplay(replaySet(
    [candidate("modeled"), candidate("missing")],
    [snapshot(trade("modeled-trade", 75, "modeled"))],
  ));

  assert.equal(result.candidateTrades, 2);
  assert.equal(result.enteredTrades, 1);
  assert.equal(result.realizedNetPnl, 150);
});

test("orphan and mismatched legacy trades are ignored", () => {
  const linked = trade("linked", 100, "linked");
  const orphan = trade("orphan", 999, "orphan");
  const mismatched = trade("mismatched", 500, "linked", { signalOccurrenceId: "wrong-occurrence" });
  const result = buildShadowAccountReplay(replaySet(
    [candidate("linked")],
    [snapshot(orphan), snapshot(mismatched), snapshot(linked)],
  ));

  assert.equal(result.enteredTrades, 1);
  assert.equal(result.realizedNetPnl, 200);
  assert.equal(result.ledger[0]?.candidateId, "linked");
});

test("in-sample and out-of-sample metrics remain separated", () => {
  const inSample = candidate("in", "in_sample");
  const outOfSample = candidate("out", "out_of_sample");
  const result = buildShadowAccountReplay(replaySet(
    [inSample, outOfSample],
    [
      snapshot(trade("in-trade", 100, "in")),
      snapshot(trade("out-trade", -40, "out", {
        period: "out_of_sample",
        entryTime: "2026-08-25T14:35:00.000Z",
      })),
    ],
  ));

  assert.equal(result.inSample.netPnl, 200);
  assert.equal(result.inSample.wins, 1);
  assert.equal(result.outOfSample.netPnl, -80);
  assert.equal(result.outOfSample.losses, 1);
  assert.equal(result.realizedNetPnl, 120);
});

test("replay source has no broker, live-order, or paper-trading path", () => {
  const source = readFileSync(new URL("./shadow-account-replay.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createOrder|placeOrder|submitOrder|paper trading/i);
});

test("aggregates authoritative trades across dates with carried balance and zero-trade coverage", () => {
  const first = candidate("first");
  const second = { ...candidate("second"), tradingDate: "2026-08-26", entryCandleOpenTime: "2026-08-26T13:30:00.000Z", entryCandleCloseTime: "2026-08-26T13:35:00.000Z" };
  const third = { ...candidate("third"), tradingDate: "2026-08-28", entryCandleOpenTime: "2026-08-28T13:30:00.000Z", entryCandleCloseTime: "2026-08-28T13:35:00.000Z", direction: "short" as const, primaryEdge: "STRONG_BREAKOUT_AFTER_CONSOLIDATION" };
  const firstTrade = trade("trade-first", 100, "first");
  const secondTrade = trade("trade-second", -40, "second", {
    tradingDate: "2026-08-26",
    entryTime: "2026-08-26T13:35:00.000Z",
    exitTime: "2026-08-26T14:00:00.000Z",
  });
  const thirdTrade = trade("trade-third", 75, "third", {
    tradingDate: "2026-08-28",
    entryTime: "2026-08-28T13:35:00.000Z",
    exitTime: "2026-08-28T14:00:00.000Z",
    direction: "short",
    primaryEdge: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
  });
  const replaySetWithDates = {
    ...replaySet([first, second, third], []),
    processedDates: ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"],
    accountReplayTrades: [
      { candidate: first, trade: firstTrade, snapshotId: first.snapshotId },
      { candidate: second, trade: secondTrade, snapshotId: second.snapshotId },
      { candidate: third, trade: thirdTrade, snapshotId: null },
      { candidate: third, trade: thirdTrade, snapshotId: null },
    ],
  } as unknown as VisualValidationSet;

  const result = buildShadowAccountReplay(replaySetWithDates, { startingBalance: 10_000, contractsPerTrade: 1 });

  assert.deepEqual(result.processedDates, ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]);
  assert.deepEqual(result.datesWithTrades, ["2026-08-25", "2026-08-26", "2026-08-28"]);
  assert.deepEqual(result.datesWithoutTrades, ["2026-08-27"]);
  assert.deepEqual(result.ledger.map((item) => item.candidateId), ["first", "second", "third"]);
  assert.deepEqual(result.ledger.map((item) => item.runningBalance), [10200, 10120, 10270]);
  assert.equal(result.equityCurve[0]?.balance, 10_000);
  assert.equal(result.equityCurve.length, 4);
  assert.equal(result.byDate.length, 4);
  assert.equal(result.byDate.find((item) => item.value === "2026-08-27")?.enteredTrades, 0);
  assert.equal(result.byDirection.find((item) => item.value === "short")?.netPnl, 150);
  assert.equal(result.byPrimaryEdge.find((item) => item.value === "STRONG_BREAKOUT_AFTER_CONSOLIDATION")?.netPnl, 150);
  assert.equal(result.bestTrade?.candidateId, "first");
  assert.equal(result.worstTrade?.candidateId, "second");
  assert.equal(result.bestTradingDay?.value, "2026-08-25");
  assert.equal(result.worstTradingDay?.value, "2026-08-26");
  assert.equal(result.byDate.reduce((total, item) => total + item.netPnl, 0), result.realizedNetPnl);
});
