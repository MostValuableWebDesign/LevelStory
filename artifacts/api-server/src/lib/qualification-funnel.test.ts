import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQualificationFunnel,
  QUALIFICATION_FUNNEL_VERSION,
  type BacktestAuditRecord,
  type BacktestReport,
  type HistoricalOccurrence,
} from "./phase9.js";
import { consolidationThresholds, DEFAULT_STRATEGY_CONFIG } from "./strategy/config.js";

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
    consolidationThresholds: consolidationThresholds(DEFAULT_STRATEGY_CONFIG),
    ...overrides,
  };
}

function report(audits: BacktestAuditRecord[], selectedDates: string[], contractSymbol = "MESU5", occurrences: HistoricalOccurrence[] = []): Pick<BacktestReport, "audit" | "trades" | "dataset" | "contract"> & { occurrences: HistoricalOccurrence[] } {
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
    occurrences,
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
  assert.ok(funnel.stages.every((stage) => stage.percentOfSessions >= 0 && stage.percentOfSessions <= 100));
  assert.equal(funnel.stages[0]?.percentOfSessions, 100);
  assert.equal(funnel.stages.find((stage) => stage.stage === "risk_approved")?.percentOfSessions, 100);
  const stageNames = funnel.stages.map((stage) => String(stage.stage));
  assert.equal(stageNames.includes("fibonacci_context_available"), false);
  assert.equal(stageNames.includes("volume_condition_passed"), false);
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

test("qualification funnel reconciles its ledger occurrence count", () => {
  const auditRecord = audit({ id: "ledger-audit" });
  const occurrence = {
    occurrenceId: "ledger-occurrence",
    auditId: auditRecord.id,
  } as HistoricalOccurrence;
  const funnel = buildQualificationFunnel([report([auditRecord], ["2026-08-24"], "MESU5", [occurrence])]);
  assert.equal(funnel.candidateCount, 1);
  assert.equal(funnel.occurrenceCount, 1);
});

test("strong breakout candidate passes without patience evidence", () => {
  const record = audit({
    id: "direct-breakout-no-patience",
    setupType: "CONSOLIDATION_BREAKOUT_CONTINUATION",
    decision: "SETUP QUALIFIED",
    rejectionReason: null,
    rejectionCategory: "QUALIFIED",
    rejectionSummary: null,
    ruleEvidence: [
      "PASS causalTrend: Causal bullish trend is established.",
      "PASS strongBreakout: The frozen-range eight-tick threshold was crossed.",
      "PASS extendedConsolidation: Four completed consolidation candles are present.",
      "PASS rangeStable: Consolidation quality passed.",
      "PASS postBreakoutContext: Direct consolidation context is present.",
      "FAIL validPatienceNearLevel: No patience candle is required for this contract.",
      "PASS immediateTrigger: The completed breakout is the authorized trigger.",
      "PASS riskApproved: Risk is approved.",
    ],
    patienceState: "PATIENCE_CANDLE_EXPIRED",
    patienceCandle: null,
    triggerCandle: null,
  });
  const funnel = buildQualificationFunnel([report([record], ["2026-08-24"])]);
  const candidate = funnel.candidates[0];
  assert.equal(funnel.version, QUALIFICATION_FUNNEL_VERSION);
  assert.equal(candidate?.reachedStage, "risk_approved");
  assert.notEqual(candidate?.primaryRejectionStage, "strong_breakout_candidate");
  assert.doesNotMatch(candidate?.rejectionDetail ?? "", /patience/i);
});

test("missing patience is attributed after a valid ORB breakout", () => {
  const record = audit({
    id: "orb-missing-patience",
    setupType: "ORB_PULLBACK_CONTINUATION",
    decision: "SETUP FORMING",
    rejectionReason: "PATIENT",
    rejectionCategory: "WAITING",
    rejectionSummary: "patienceCandleOutsideOrb: Waiting for patience.",
    orbState: "QUALIFIED_BREAKOUT",
    breakoutEvidence: "Qualified breakout confirmed.",
    pullbackEvidence: "PASS pullback: Retest completed.",
    criticalLevelEvidence: "PASS levelContext: Level interaction completed.",
    ruleEvidence: [
      "PASS ntzComplete: ORB finalized.",
      "PASS closeOutsideNtz: Breakout closed outside the ORB.",
      "PASS pullback: Retest completed.",
      "PASS levelContext: Critical level interaction completed.",
      "FAIL validPatienceCandle: No valid patience candle is available.",
      "FAIL immediateTrigger: No immediate trigger is available.",
    ],
    patienceState: "WAITING_FOR_VALID_CONTEXT",
  });
  const funnel = buildQualificationFunnel([report([record], ["2026-08-24"])]);
  const candidate = funnel.candidates[0];
  assert.equal(candidate?.reachedStage, "critical_level_interaction");
  assert.equal(candidate?.primaryRejectionStage, "valid_trend_aligned_patience_candle");
  assert.match(candidate?.rejectionDetail ?? "", /validPatienceCandle/);
  assert.doesNotMatch(candidate?.rejectionDetail ?? "", /strong breakout candidate/i);
});

test("early ORB missing patience is reported as an ORB-specific qualification failure", () => {
  const record = audit({
    id: "early-orb-missing-patience",
    setupType: "EARLY_ORB_MOMENTUM_CONTINUATION",
    decision: "SETUP FORMING",
    rejectionReason: "PATIENT",
    rejectionCategory: "WAITING",
    rejectionSummary: "patienceCandleOutsideOrb: Waiting for patience.",
    orbState: "ORB_PROBE_WAIT",
    breakoutEvidence: "The opening range is still being evaluated.",
    ruleEvidence: [
      "PASS ntzComplete: The opening range must be finalized before an early momentum arm can open.",
      "FAIL patienceCandleOutsideOrb: No qualifying patience candle closed at least one MES tick outside the finalized ORB.",
      "FAIL noPullbackRequired: The isolated early ORB path is not active.",
      "FAIL immediateTrigger: Early momentum state is WAITING_FOR_VALID_CONTEXT; only ENTRY_TRIGGERED qualifies.",
    ],
    patienceState: "WAITING_FOR_VALID_CONTEXT",
  });
  const funnel = buildQualificationFunnel([report([record], ["2026-08-24"])]);
  const candidate = funnel.candidates[0];
  assert.equal(candidate?.primaryRejectionStage, "strong_breakout_candidate");
  assert.match(candidate?.rejectionDetail ?? "", /patienceCandleOutsideOrb/);
  assert.match(candidate?.rejectionDetail ?? "", /outside the finalized ORB/);
  assert.doesNotMatch(candidate?.rejectionDetail ?? "", /eight ticks|breakout boundary/i);
});

test("missing immediate trigger is attributed after patience passes", () => {
  const record = audit({
    id: "orb-missing-trigger",
    setupType: "ORB_PULLBACK_CONTINUATION",
    decision: "SETUP FORMING",
    rejectionReason: "PATIENT",
    rejectionCategory: "WAITING",
    rejectionSummary: "immediateTrigger: No immediate trigger.",
    orbState: "QUALIFIED_BREAKOUT",
    breakoutEvidence: "Qualified breakout confirmed.",
    pullbackEvidence: "PASS pullback: Retest completed.",
    criticalLevelEvidence: "PASS levelContext: Level interaction completed.",
    ruleEvidence: [
      "PASS ntzComplete: ORB finalized.",
      "PASS closeOutsideNtz: Breakout closed outside the ORB.",
      "PASS pullback: Retest completed.",
      "PASS levelContext: Critical level interaction completed.",
      "PASS validPatienceCandle: Patience candle confirmed.",
      "FAIL immediateTrigger: The following candle did not confirm.",
    ],
    patienceState: "PATIENCE_CANDLE_VALID",
    patienceCandle: { open: 100, close: 101 },
  });
  const funnel = buildQualificationFunnel([report([record], ["2026-08-24"])]);
  const candidate = funnel.candidates[0];
  assert.equal(candidate?.reachedStage, "valid_trend_aligned_patience_candle");
  assert.equal(candidate?.primaryRejectionStage, "immediate_next_candle_confirmation");
  assert.match(candidate?.rejectionDetail ?? "", /immediateTrigger/);
});

test("equivalent-candle reversal failure is not a strong-breakout rejection", () => {
  const record = audit({
    id: "missing-equivalent-pattern",
    setupType: "EQUIVALENT_CANDLE_REVERSAL",
    decision: "NO TRADE",
    rejectionReason: "NO_PATTERN",
    rejectionCategory: "FAILURE",
    rejectionSummary: "equivalentContext: No equivalent opposing-candle structure.",
    breakoutEvidence: "No breakout strategy applies.",
    ruleEvidence: [
      "FAIL equivalentContext: No equivalent opposing-candle structure.",
      "FAIL directionalConfirmation: Completed opposing-candle evidence is missing.",
      "PASS validPatienceCandle: No separate patience candle required.",
      "FAIL immediateTrigger: No eligible pattern trigger.",
    ],
  });
  const funnel = buildQualificationFunnel([report([record], ["2026-08-24"])]);
  const candidate = funnel.candidates[0];
  assert.equal(candidate?.reachedStage, "strong_breakout_candidate");
  assert.equal(candidate?.primaryRejectionStage, "strategy_context_confirmed");
  assert.match(candidate?.rejectionDetail ?? "", /equivalentContext/);
  assert.doesNotMatch(candidate?.rejectionDetail ?? "", /patience/i);
});

test("failed breakout remains a strong-breakout rejection even when patience also fails", () => {
  const record = audit({
    id: "failed-breakout",
    setupType: "ORB_PULLBACK_CONTINUATION",
    decision: "SETUP FORMING",
    rejectionReason: "PATIENT",
    rejectionCategory: "WAITING",
    rejectionSummary: "patienceCandleOutsideOrb: Waiting for patience.",
    orbState: "QUALIFIED_BREAKOUT",
    breakoutEvidence: "ORB_PROBE_WAIT: required breakout boundary was not crossed.",
    ruleEvidence: [
      "PASS ntzComplete: ORB finalized.",
      "FAIL closeOutsideNtz: Required breakout boundary was not crossed.",
      "FAIL validPatienceCandle: No valid patience candle is available.",
      "FAIL immediateTrigger: No immediate trigger is available.",
    ],
    patienceState: "WAITING_FOR_VALID_CONTEXT",
  });
  const funnel = buildQualificationFunnel([report([record], ["2026-08-24"])]);
  const candidate = funnel.candidates[0];
  assert.equal(candidate?.primaryRejectionStage, "strong_breakout_candidate");
  assert.match(candidate?.rejectionDetail ?? "", /boundary was not crossed/i);
  assert.doesNotMatch(candidate?.rejectionDetail ?? "", /patience candle/i);
});
