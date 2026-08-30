import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQualificationFunnel,
  type BacktestAuditRecord,
  type BacktestReport,
} from "./phase9.js";

function audit(overrides: Partial<BacktestAuditRecord> = {}): BacktestAuditRecord {
  return {
    id: "audit-1",
    tradingDate: "2026-08-24",
    contractSymbol: "MESU5",
    contractMonth: "2025-09",
    period: "in_sample",
    evaluatedCandleOpenTime: "2026-08-24T13:35:00.000Z",
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long",
    decision: "WAITING FOR PATIENCE CANDLE",
    alertOnly: true,
    rejectionReason: "PATIENT",
    rejectionCategory: "WAITING",
    rejectionSummary: "Waiting for the confirmation candle.",
    ruleEvidence: [],
    orbState: "ORB_PROBE_WAIT",
    breakoutEvidence: "Breakout candidate is forming.",
    volumeEvidence: "Volume neutral.",
    pullbackEvidence: "No pullback evidence.",
    criticalLevelEvidence: "No critical level evidence.",
    trendEvidence: "Trend aligned.",
    patienceState: "WAITING",
    patienceCandle: null,
    triggerCandle: null,
    patienceCandleOpenTime: null,
    patienceCandleCloseTime: null,
    triggerCandleOpenTime: null,
    triggerCandleCloseTime: null,
    modeledFillObservationTime: null,
    exitCandleOpenTime: null,
    exitCandleCloseTime: null,
    entryTriggerPrice: null,
    strategyStopPrice: null,
    catastropheStopPrice: null,
    targetPrice: null,
    eventLabels: [],
    ambiguityLabels: [],
    executionMode: "ohlcv_modeled",
    fees: 0,
    slippage: 0,
    grossPnl: null,
    netPnl: null,
    exitReason: null,
    ...overrides,
  };
}

function report(audits: BacktestAuditRecord[], selectedDates: string[], contractSymbol = "MESU5"): Pick<BacktestReport, "audit" | "trades" | "dataset" | "contract"> {
  return {
    audit: audits,
    trades: [],
    dataset: {
      startDate: selectedDates[0] ?? "",
      endDate: selectedDates.at(-1) ?? "",
      requestedStartDate: selectedDates[0] ?? "",
      requestedEndDate: selectedDates.at(-1) ?? "",
      selectedDates,
      inSampleDates: selectedDates,
      outOfSampleDates: [],
      excludedDates: [],
      untouchedOutOfSample: true,
      optimizationApplied: false,
      activeContractByDate: selectedDates.map((tradingDate) => ({ tradingDate, contractSymbol })),
    },
    contract: { fullContractSymbol: contractSymbol } as BacktestReport["contract"],
  };
}

test("qualification funnel retains each occurrence and keeps each occurrence's evidence", () => {
  const weak = audit({ id: "weak", evaluatedCandleOpenTime: "2026-08-24T13:35:00.000Z" });
  const strong = audit({
    id: "strong",
    evaluatedCandleOpenTime: "2026-08-24T13:40:00.000Z",
    decision: "SETUP QUALIFIED",
    rejectionReason: null,
    rejectionCategory: "QUALIFIED",
    rejectionSummary: null,
    orbState: "QUALIFIED_BREAKOUT",
    breakoutEvidence: "Strong breakout confirmed.",
    volumeEvidence: "PASS supporting volume",
    pullbackEvidence: "PASS pullback retest",
    criticalLevelEvidence: "PASS critical level interaction",
    ruleEvidence: [
      "PASS NTZ / ORB completed",
      "PASS strong breakout",
      "PASS continuation alignment",
      "PASS pullback",
      "PASS critical level",
      "PASS Fibonacci context",
      "PASS volume",
      "PASS risk approved",
    ],
    patienceState: "VALID",
    patienceCandle: { open: 100, close: 101 },
    triggerCandle: { open: 101, close: 102 },
    modeledFillObservationTime: "2026-08-24T13:45:00.000Z",
  });
  const funnel = buildQualificationFunnel([
    report([weak, strong, strong], ["2026-08-24"]),
  ]);
  assert.equal(funnel.candidateCount, 2);
  assert.equal(funnel.sessionCount, 1);
  const strongCandidate = funnel.candidates.find((candidate) => candidate.evidence.evaluatedCandleOpenTime === strong.evaluatedCandleOpenTime);
  assert.equal(strongCandidate?.reachedStage, "risk_approved");
  assert.equal(strongCandidate?.primaryRejectionStage, "modeled_entry");
  assert.equal(strongCandidate?.evidence.evaluatedCandleOpenTime, strong.evaluatedCandleOpenTime);
  for (let index = 1; index < funnel.stages.length; index += 1) {
    assert.ok((funnel.stages[index]?.count ?? 0) <= (funnel.stages[index - 1]?.count ?? 0));
  }
});

test("rollover candidates remain isolated by active contract", () => {
  const u5 = audit({ id: "u5", contractSymbol: "MESU5" });
  const z5 = audit({ id: "z5", contractSymbol: "MESZ5" });
  const funnel = buildQualificationFunnel([
    report([u5, u5], ["2026-08-24"], "MESU5"),
    report([z5], ["2026-08-24"], "MESZ5"),
  ]);
  assert.equal(funnel.candidateCount, 2);
  assert.deepEqual(funnel.candidates.map((candidate) => candidate.contractSymbol), ["MESU5", "MESZ5"]);
  assert.equal(funnel.sessionCount, 2);
});

test("qualification funnel retains distinct causal occurrences", () => {
  const first = audit({ id: "first", evaluatedCandleOpenTime: "2026-08-24T13:35:00.000Z" });
  const second = audit({ id: "second", evaluatedCandleOpenTime: "2026-08-24T13:40:00.000Z" });
  const funnel = buildQualificationFunnel([report([first, second], ["2026-08-24"])]);
  assert.equal(funnel.candidateCount, 2);
  assert.deepEqual(funnel.candidates.map((candidate) => candidate.evidence.evaluatedCandleOpenTime), [
    first.evaluatedCandleOpenTime,
    second.evaluatedCandleOpenTime,
  ]);
});
