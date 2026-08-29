import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateConfiguration, compareCandidate } from "./proposal-validator.js";

function teaching(id: string, judgment: string, buffer: number) {
  return {
    id,
    status: "submitted",
    judgment,
    selectedCandleTimestamp: "2026-08-26T14:00:00.000Z",
    patienceCandleTimestamp: "2026-08-26T13:55:00.000Z",
    entryBufferTicks: buffer,
    direction: "long",
    causalValidation: { valid: true },
    evidenceSnapshot: { futureCandleAccess: false, period: "holdout" },
    outcomeSnapshot: { netPnl: judgment === "missed_trade" ? 25 : -10, exitReason: "target", runner: true },
    machineDecision: "no_trade",
    sourceFingerprint: `source-${id}`,
    calendarFingerprint: `calendar-${id}`,
  } as never;
}

test("typed candidate comparison reports a real parent/candidate behavioral difference", () => {
  const result = compareCandidate([
    teaching("missed", "missed_trade", 3),
    teaching("false-positive", "false_positive_trade", 4),
  ], [{ field: "patienceEntryBufferTicks", value: 3 }]);

  assert.equal(result.holdoutCompleted, true);
  assert.equal(result.noFutureData, true);
  assert.equal(result.beforeMetrics.sampleCount, 2);
  assert.equal(result.afterMetrics.sampleCount, 2);
  assert.equal(result.holdoutMetrics.after.sampleCount, 2);
  assert.equal(result.inSampleMetrics.after.sampleCount, 0);
  assert.notEqual(result.parentFormulaHash, result.candidateFormulaHash);
});

test("candidate construction rejects free-form and unknown rule changes", () => {
  assert.throws(() => buildCandidateConfiguration({ mode: "execute arbitrary text" }), /typed deterministicRuleDiff/);
  assert.throws(() => buildCandidateConfiguration([{ field: "notAFormulaField", value: 1 }]), /Unknown or invalid/);
  assert.throws(() => buildCandidateConfiguration([{ field: "patienceEntryBufferTicks", value: 2 }]), /three or four ticks/);
});

test("candidate preserves non-default parent settings while changing only the typed rule", () => {
  const { parent, candidate } = buildCandidateConfiguration(
    [{ field: "patienceEntryBufferTicks", value: 3 }],
    { phase4BreakoutVolumeRatio: 1.9, patienceEntryBufferTicks: 4 },
  );
  assert.equal(parent.phase4BreakoutVolumeRatio, 1.9);
  assert.equal(candidate.phase4BreakoutVolumeRatio, 1.9);
  assert.equal(parent.patienceEntryBufferTicks, 4);
  assert.equal(candidate.patienceEntryBufferTicks, 3);
});