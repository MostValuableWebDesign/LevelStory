import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateConfiguration, compareCandidate } from "./proposal-validator.js";

function teaching(id: string, judgment: string, buffer: number) {
  const candle = (openTime: string, open: number, close: number) => ({
    openTime,
    closeTime: new Date(Date.parse(openTime) + 5 * 60_000).toISOString(),
    open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close,
    volume: 1000, contractSymbol: "MES",
    isComplete: true,
  });
  return {
    id,
    status: "submitted",
    judgment,
    contract: "MES",
    selectedCandleTimestamp: "2026-08-26T14:00:00.000Z",
    patienceCandleTimestamp: "2026-08-26T13:55:00.000Z",
    entryBufferTicks: buffer,
    direction: "long",
    causalValidation: { valid: true },
    evidenceSnapshot: {
      futureCandleAccess: false, period: "holdout",
      machineEvidenceSnapshot: {
        quotesAvailable: false,
        sourceSchema: "historical_ohlcv",
        machineCandles: [
          candle("2026-08-26T13:55:00.000Z", 100, 100.5),
          candle("2026-08-26T14:00:00.000Z", 100.5, 101),
        ],
        premarketCandles: [],
        evaluationCursor: { closeTime: "2026-08-26T14:05:00.000Z" },
      },
    },
    outcomeSnapshot: { netPnl: judgment === "missed_trade" ? 25 : -10, exitReason: "target", runner: true },
    machineDecision: "no_trade",
    sourceFingerprint: `source-${id}`,
    calendarFingerprint: `calendar-${id}`,
  } as never;
}

test("typed candidate comparison reports a governed no-op for the fixed buffer", () => {
  const result = compareCandidate([
     teaching("missed", "missed_trade", 4),
     teaching("false-positive", "false_positive_trade", 4),
    ], [{ field: "patienceEntryBufferTicks", value: 4 }]);

  assert.equal(result.holdoutCompleted, true);
  assert.equal(result.noFutureData, true);
  assert.equal(result.beforeMetrics.sampleCount, 2);
  assert.equal(result.afterMetrics.sampleCount, 2);
  assert.equal(result.holdoutMetrics.after.sampleCount, 2);
  assert.equal(result.inSampleMetrics.after.sampleCount, 0);
   assert.equal(result.parentFormulaHash, result.candidateFormulaHash);
});

test("candidate construction rejects free-form and unknown rule changes", () => {
  assert.throws(() => buildCandidateConfiguration({ mode: "execute arbitrary text" }), /typed deterministicRuleDiff/);
   assert.throws(() => buildCandidateConfiguration([{ field: "notAFormulaField", value: 1 }]), /Unknown deterministic rule field/);
    assert.throws(() => buildCandidateConfiguration([{ field: "patienceEntryBufferTicks", value: 2 }]), /exactly 4/);
});

test("candidate preserves non-default parent settings while changing only the typed rule", () => {
  const { parent, candidate } = buildCandidateConfiguration(
     [{ field: "patienceEntryBufferTicks", value: 4 }],
      { phase4BreakoutVolumeRatio: 1.9, patienceEntryBufferTicks: 4 },
  );
   assert.equal(parent.phase4BreakoutVolumeRatio, 1.9);
   assert.equal(candidate.phase4BreakoutVolumeRatio, 1.9);
    assert.equal(parent.patienceEntryBufferTicks, 4);
    assert.equal(candidate.patienceEntryBufferTicks, 4);
});

test("typed rule validation rejects coercion, non-finite values, decimals, and duplicate fields", () => {
  assert.throws(
    () => buildCandidateConfiguration([{ field: "earlyOrbMomentumContinuationEnabled", value: "false" }]),
    /must be a boolean/,
  );
  assert.throws(
    () => buildCandidateConfiguration([{ field: "earlyOrbMomentumEligibilityCutoffMinutes", value: "630" }]),
    /finite integer/,
  );
  assert.throws(
    () => buildCandidateConfiguration([{ field: "earlyOrbMomentumEligibilityCutoffMinutes", value: Number.NaN }]),
    /finite integer/,
  );
  assert.throws(
    () => buildCandidateConfiguration([{ field: "earlyOrbMomentumEligibilityCutoffMinutes", value: 630.5 }]),
    /finite integer/,
  );
  assert.throws(
    () => buildCandidateConfiguration([
      { field: "earlyOrbMomentumMinimumCloseDistanceTicks", value: 1 },
      { field: "earlyOrbMomentumMinimumCloseDistanceTicks", value: 2 },
    ]),
    /Duplicate deterministic rule field/,
  );
});

test("typed rule validation enforces executable bounds and rejects unknown fields", () => {
  assert.throws(
    () => buildCandidateConfiguration([{ field: "earlyOrbMomentumEligibilityCutoffMinutes", value: -1 }]),
    /at least 0/,
  );
  assert.throws(
    () => buildCandidateConfiguration([{ field: "earlyOrbMomentumEligibilityCutoffMinutes", value: 1441 }]),
    /at most 1440/,
  );
  assert.throws(
    () => buildCandidateConfiguration([{ field: "earlyOrbMomentumMinimumCloseDistanceTicks", value: 0 }]),
    /at least 1/,
  );
  assert.throws(
    () => buildCandidateConfiguration([{ field: "unknownField", value: 1 }]),
    /Unknown deterministic rule field/,
  );
  assert.throws(
    () => buildCandidateConfiguration([{ field: "earlyOrbMomentumMinimumCloseDistanceTicks", value: 1, unit: "points" }]),
    /Unknown deterministic rule field property/,
  );
});