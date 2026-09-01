import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritativePatienceStopPrice,
  effectiveConfirmationThreshold,
  isStrictlyOutsideNtz,
  patienceCandleEngine,
  patienceArmLifecycleTransitions,
  phase5PatienceAnalysis,
  type PatienceEligibilityEvent,
  type PatienceOccurrence,
} from "./phase5.js";
import type { PullbackAnalysis } from "./phase4.js";
import type { Candle } from "./types.js";

const FIVE_MINUTES = 5 * 60_000;

function candle(index: number, open: number, high: number, low: number, close: number, isComplete = true): Candle {
  const openTime = index * FIVE_MINUTES;
  return { openTime, closeTime: openTime + FIVE_MINUTES, open, high, low, close, volume: 100, isComplete };
}

function eligibility(time = FIVE_MINUTES): PatienceEligibilityEvent[] {
  return [{ time, reason: "pullback", detail: "Retest reached a qualifying level." }];
}

test("attempt-level structural invalidation does not terminalize an active pullback arm", () => {
  const transitions = patienceArmLifecycleTransitions({
    patienceCandle: { closeTime: FIVE_MINUTES },
    qualificationStatus: "STRUCTURALLY_INVALIDATED",
    outcomeStatus: "INVALIDATED",
    eligibilityArmState: "active",
    evaluationCursor: FIVE_MINUTES,
    reasonCode: "PATIENCE_CANDLE_INSIDE_FINALIZED_NTZ",
  } as unknown as PatienceOccurrence);
  assert.deepEqual(transitions.map((transition) => transition.to), ["PATIENCE_ARMED"]);
});

function setup(direction: "long" | "short", trigger: Candle): Candle[] {
  const previous = direction === "long" ? candle(0, 10, 12, 8, 10.5) : candle(0, 10, 12, 8, 9.5);
  const patience = direction === "long" ? candle(1, 10.5, 10, 7, 10.8) : candle(1, 9.5, 13, 10, 9.2);
  return [previous, patience, trigger];
}

function datedCandle(
  openTime: string,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  const timestamp = Date.parse(openTime);
  return { openTime: timestamp, closeTime: timestamp + FIVE_MINUTES, open, high, low, close, volume: 100, isComplete: true };
}

test("valid bullish patience candle triggers only on the immediate next candle", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 12.1, 10.2, 12)), "long", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.triggerPrice, 12);
  assert.equal(result.patienceCandle?.isComplete, true);
});

test("valid bearish patience candle triggers below the patience low", () => {
  const result = patienceCandleEngine(setup("short", candle(2, 9.2, 9.8, 7.8, 8)), "short", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.triggerPrice, 8);
});

test("the Aug 5 10:45 short candidate is rejected when E is ambiguous", () => {
  const result = patienceCandleEngine(
    [
      datedCandle("2026-08-05T14:40:00.000Z", 7791.25, 7796.25, 7788, 7792),
      datedCandle("2026-08-05T14:45:00.000Z", 7792, 7799.75, 7790.25, 7798),
      datedCandle("2026-08-05T14:50:00.000Z", 7797.75, 7800.5, 7778.25, 7783.25),
    ],
    "short",
    {
      eligibilityEvents: [{
        time: Date.parse("2026-08-05T14:45:00.000Z"),
        reason: "pullback",
        detail: "Proximity to Prior day high.",
        eventId: "pullback|proximity|1785940800000|Prior day high|7786",
      }],
      finalizedNtz: { high: 7820.25, low: 7804, complete: true },
      requireFinalizedNtz: true,
    },
  );
  const occurrence = result.occurrences?.[0];
  assert.equal(occurrence?.patienceCandle.openTime, Date.parse("2026-08-05T14:45:00.000Z"));
  assert.equal(occurrence?.eligibilityEventId, "pullback|proximity|1785940800000|Prior day high|7786");
  assert.equal(occurrence?.status, "AMBIGUOUS_EVENT_ORDER");
  assert.equal(occurrence?.outcomeStatus, "INVALIDATED");
  assert.equal(occurrence?.confirmationThreshold, 7788.25);
  assert.equal(occurrence?.triggerCandle?.low, 7778.25);
});

test("patience strategy stops use exactly eight MES ticks beyond the frozen P extreme", () => {
  const long = patienceCandleEngine(
    setup("long", candle(2, 10.8, 12, 10.2, 11.75)),
    "long",
    { eligibilityEvents: eligibility(), tickSize: 0.25 },
  );
  const short = patienceCandleEngine(
    setup("short", candle(2, 9.2, 9.8, 7.75, 8)),
    "short",
    { eligibilityEvents: eligibility(), tickSize: 0.25 },
  );
  assert.equal(long.state, "ENTRY_TRIGGERED");
  assert.equal(long.strategyStopPrice, 5);
  assert.equal(short.state, "ENTRY_TRIGGERED");
  assert.equal(short.strategyStopPrice, 15);
  assert.equal(authoritativePatienceStopPrice("long", 6975.75), 6973.75);
  assert.equal(authoritativePatienceStopPrice("short", 6975.75), 6977.75);
});

test("the seventh tick does not confirm, while the eighth tick confirms", () => {
  const sevenTicks = patienceCandleEngine(
    setup("long", candle(2, 10.8, 11.75, 10.2, 11.75)),
    "long",
    { eligibilityEvents: eligibility(), tickSize: 0.25 },
  );
  const eightTicks = patienceCandleEngine(
    setup("long", candle(2, 10.8, 12, 10.2, 12)),
    "long",
    { eligibilityEvents: eligibility(), tickSize: 0.25 },
  );
  assert.notEqual(sevenTicks.state, "ENTRY_TRIGGERED");
  assert.equal(eightTicks.state, "ENTRY_TRIGGERED");
  assert.equal(eightTicks.strategyStopPrice, 5);
});

test("the exclusive primary cutoff uses E open time and propagates into occurrences", () => {
  const cases = [
    { label: "EDT 12:55 E open", p: "2026-08-25T16:50:00.000Z", e: "2026-08-25T16:55:00.000Z", confirmed: true },
    { label: "EDT 1:00 E open", p: "2026-08-25T16:55:00.000Z", e: "2026-08-25T17:00:00.000Z", confirmed: false },
    { label: "EST 12:55 E open", p: "2026-01-15T17:50:00.000Z", e: "2026-01-15T17:55:00.000Z", confirmed: true },
    { label: "EST 1:00 E open", p: "2026-01-15T17:55:00.000Z", e: "2026-01-15T18:00:00.000Z", confirmed: false },
  ];
  for (const item of cases) {
    const pOpen = Date.parse(item.p);
    const previous = datedCandle(new Date(pOpen - FIVE_MINUTES).toISOString(), 10, 12, 8, 10.5);
    const patience = datedCandle(item.p, 10.5, 11, 7, 10.8);
    const entry = datedCandle(item.e, 10.8, item.confirmed ? 13 : 12, 10.2, item.confirmed ? 13 : 12);
    const result = patienceCandleEngine([previous, patience, entry], "long", {
      eligibilityEvents: [{ time: pOpen, reason: "pullback", detail: "Cutoff regression" }],
      entryCutoffMinutes: 780,
    });
    assert.equal(result.occurrences?.[0]?.outcomeStatus, item.confirmed ? "CONFIRMED" : "EXPIRED_NO_IMMEDIATE_CONFIRMATION", item.label);
  }
});

test("effective confirmation uses the stricter NTZ threshold and accepts wick-only reach", () => {
  const patience = candle(1, 10.5, 11, 7, 10.8);
  const ntz = { high: 12, low: 9, complete: true };
  const threshold = effectiveConfirmationThreshold(patience, "long", 8, 0.25, ntz);
  assert.equal(threshold, 13);
  assert.equal(isStrictlyOutsideNtz({ high: 13, low: 10, }, "long", ntz, true, threshold), true);
  assert.equal(isStrictlyOutsideNtz({ high: 12, low: 10 }, "long", ntz, true, threshold), false);

  const result = patienceCandleEngine(
    setup("long", candle(2, 10.8, 12.25, 11.5, 11.75)),
    "long",
    { eligibilityEvents: eligibility(), tickSize: 0.25, finalizedNtz: ntz, requireFinalizedNtz: true },
  );
  assert.equal(result.state, "PATIENCE_CANDLE_EXPIRED");
  assert.equal(result.occurrences?.[0]?.reasonCode, "PATIENCE_CANDLE_INSIDE_FINALIZED_NTZ");
  assert.equal(result.occurrences?.[0]?.triggerCandle, null);
});

test("an outside-NTZ patience candle still uses the effective wick threshold", () => {
  const ntz = { high: 12, low: 9, complete: true };
   const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11.5, 10.8, 12.5),
     candle(2, 12.5, 13.5, 12.3, 13.25),
  ];
  const result = patienceCandleEngine(candles, "long", {
    eligibilityEvents: eligibility(),
    tickSize: 0.25,
    finalizedNtz: ntz,
    requireFinalizedNtz: true,
  });
  assert.equal(result.state, "ENTRY_TRIGGERED");
   assert.equal(result.entryBufferPrice, 13.5);
   assert.equal(result.triggerPrice, 13.5);
});

test("an incomplete patience candle cannot be validated", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 9, 10.8, false),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE_CANDLE_FORMING");
  assert.equal(result.patienceCandle?.isComplete, false);
});

test("a closed patience candle with no next candle waits for the trigger window", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 11, 9.2, 10.6)).slice(0, 2), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE_CANDLE_VALID");
  assert.equal(result.triggerCandle, null);
});

test("a later candle cannot be stored as the immediate-next entry candle", () => {
  const candles = setup("long", candle(2, 10.8, 11, 9.2, 10.6)).slice(0, 2);
  candles.push(candle(4, 10.8, 12.1, 10.2, 12));
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE_CANDLE_EXPIRED");
  assert.equal(result.triggerCandle, null);
  assert.equal(result.occurrences?.[0]?.outcomeStatus, "EXPIRED_MISSING_E");
  assert.equal(result.occurrences?.[0]?.nextObservedCandle?.openTime, candles[2].openTime);
  assert.match(result.detail, /immediate-next entry candle is missing/i);
  assert.match(result.detail, /00:10:00\.000Z.*00:15:00\.000Z/);
});

test("a missing immediate E uses the expected boundary even after a later candle", () => {
  const candles = setup("long", candle(2, 10.8, 11, 9.2, 10.6)).slice(0, 2);
  candles.push(candle(4, 10.8, 12.1, 10.2, 12));
  const occurrence = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() }).occurrences?.[0];
  assert.equal(occurrence?.outcomeStatus, "EXPIRED_MISSING_E");
  assert.equal(occurrence?.evaluationCursor, candles[1].closeTime);
  assert.equal(occurrence?.triggerCandle, null);
  assert.equal(occurrence?.nextObservedCandle?.openTime, candles[2].openTime);
});

test("a failed immediate trigger expires and a later candle cannot trigger it", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 7, 10.8),
    candle(2, 10.8, 11.2, 10.1, 10.4),
    candle(4, 10.4, 12.2, 10.1, 12.1),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "PATIENCE_CANDLE_EXPIRED");
  assert.equal(result.occurrences?.[0]?.outcomeStatus, "EXPIRED_NO_IMMEDIATE_CONFIRMATION");
  assert.equal(result.occurrences?.[0]?.triggerCandle?.openTime, candles[2].openTime);
  assert.equal(result.occurrences?.[0]?.nextObservedCandle?.openTime, candles[2].openTime);
  assert.equal(result.occurrences?.[0]?.expectedEntryCandleOpenTime, candles[2].openTime);
   assert.equal(result.occurrences?.[0]?.confirmationThreshold, 13);
  assert.ok((result.occurrences?.[0]?.actualConfirmationExcursion ?? 0) < 1);
  assert.match(result.detail, /confirmation buffer|new patience pattern/i);
});

test("an incomplete immediate E followed by a later interval expires at the expected boundary", () => {
  const candles = setup("long", candle(2, 10.8, 11.2, 10.1, 10.4)).slice(0, 2);
  candles.push(candle(2, 10.8, 11.2, 10.1, 10.4, false));
  candles.push(candle(3, 10.4, 12.2, 10.1, 12.1));
  const occurrence = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility() }).occurrences?.[0];
  assert.equal(occurrence?.outcomeStatus, "EXPIRED_INCOMPLETE_E");
  assert.equal(occurrence?.evaluationCursor, candles[1].closeTime);
  assert.equal(occurrence?.triggerCandle, null);
  assert.equal(occurrence?.nextObservedCandle?.openTime, candles[2].openTime);
});

test("an earlier ORB pullback patience sequence is not overwritten by a later candidate", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 7, 10.8),
    candle(2, 10.8, 11.2, 10.1, 10.4),
    candle(3, 10.4, 11.1, 9.2, 10.8),
     candle(4, 10.8, 13.25, 10.2, 13),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.patienceCandle?.openTime, candles[3].openTime);
  assert.equal(result.triggerCandle?.openTime, candles[4].openTime);
  assert.deepEqual(result.occurrences?.map((occurrence) => occurrence.status), ["PATIENCE_CANDLE_EXPIRED", "ENTRY_TRIGGERED"]);
  assert.deepEqual(result.occurrences?.map((occurrence) => occurrence.outcomeStatus), ["EXPIRED_NO_IMMEDIATE_CONFIRMATION", "CONFIRMED"]);
  assert.equal(result.occurrences?.[0]?.patienceCandle.openTime, candles[1].openTime);
  assert.equal(result.occurrences?.[0]?.nextObservedCandle?.openTime, candles[2].openTime);
  assert.equal(result.occurrences?.[1]?.patienceCandle.openTime, candles[3].openTime);
  assert.equal(result.occurrences?.[1]?.nextObservedCandle, null);
});

test("a later confirmed P→E sequence remains executable after an earlier ambiguous candidate", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 7, 10.8),
    candle(2, 10.8, 12.2, 6.8, 10.5),
    candle(3, 10.5, 11.1, 9.2, 10.8),
     candle(4, 10.8, 13.25, 9.3, 13),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.patienceCandle?.openTime, candles[3].openTime);
  assert.equal(result.triggerCandle?.openTime, candles[4].openTime);
  assert.deepEqual(result.occurrences?.map((occurrence) => occurrence.outcomeStatus), ["INVALIDATED", "CONFIRMED"]);
});

test("one pullback arm allows later successful P→E sequences", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 7, 10.8),
     candle(2, 10.8, 13, 10.2, 12.8),
    candle(3, 12.8, 14, 11, 13.5),
    candle(4, 13.5, 13, 10, 12),
    candle(5, 12, 15, 10.1, 14.8),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.deepEqual(
    result.occurrences?.filter((occurrence) => occurrence.status === "ENTRY_TRIGGERED").map((occurrence) => occurrence.patienceCandle.openTime),
    [candles[1].openTime, candles[4].openTime],
  );
  assert.equal(result.occurrences?.find((occurrence) => occurrence.patienceCandle.openTime === candles[1].openTime)?.triggerCandle?.openTime, candles[2].openTime);
  assert.equal(result.occurrences?.find((occurrence) => occurrence.patienceCandle.openTime === candles[1].openTime)?.eligibilityArmState, "active");
  assert.equal(result.occurrences?.find((occurrence) => occurrence.patienceCandle.openTime === candles[4].openTime)?.eligibilityArmState, "active");
});

test("a newer causal eligibility event explicitly supersedes an older active arm", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 7, 10.8),
    candle(2, 10.8, 10.95, 9.2, 10.9),
    candle(3, 10.9, 11.1, 9.4, 10.95),
  ];
  const events = [
    { time: FIVE_MINUTES, reason: "pullback" as const, eventId: "older-arm" },
    { time: 2 * FIVE_MINUTES, reason: "consolidation" as const, eventId: "newer-arm" },
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: events });
  assert.equal(result.occurrences?.[0]?.eligibilityArmId, "older-arm");
  assert.equal(result.occurrences?.[0]?.eligibilityArmState, "superseded");
});

test("an occurrence never reads an entry candle beyond the visible evaluation cursor", () => {
  const visible = setup("long", candle(2, 10.8, 10.95, 9.2, 10.9)).slice(0, 2);
  visible.push(candle(2, 10.8, 10.95, 9.2, 10.9, false));
  const result = patienceCandleEngine(visible, "long", { eligibilityEvents: eligibility() });
  assert.equal(result.occurrences?.[0]?.triggerCandle, null);
  assert.equal(result.occurrences?.[0]?.evaluationCursor, visible[1].closeTime);
  assert.equal(result.occurrences?.[0]?.outcomeStatus, "CANDIDATE");
});

test("an incomplete immediate candle cannot be replaced by a later interval", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 7, 10.8),
    candle(2, 10.8, 11.2, 10.1, 10.9, false),
    candle(3, 10.9, 12.2, 10.5, 12),
  ];
  const result = patienceCandleEngine(candles, "long", { eligibilityEvents: eligibility(), tickSize: 0.25 });
  const occurrence = result.occurrences?.find((item) => item.patienceCandle.openTime === candles[1].openTime);
  assert.equal(occurrence?.outcomeStatus, "EXPIRED_INCOMPLETE_E");
  assert.equal(occurrence?.triggerCandle, null);
  assert.equal(occurrence?.nextObservedCandle?.openTime, candles[2].openTime);
});

test("configured confirmation and stop buffers are retained on every patience occurrence", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 11.75, 10.1, 11.7)), "long", {
    eligibilityEvents: eligibility(),
    entryBufferTicks: 8,
    stopBufferTicks: 8,
  });
  assert.equal(result.occurrences?.[0]?.entryBufferTicks, 8);
  assert.equal(result.occurrences?.[0]?.stopBufferTicks, 8);
  assert.equal(result.occurrences?.[0]?.patienceCandleExtreme, result.occurrences?.[0]?.patienceCandle.low);
  assert.equal(result.occurrences?.[0]?.stopBufferPoints, 2);
  assert.equal(result.occurrences?.[0]?.finalStopBoundary, 5);
});

test("governed default patience stops use eight ticks on the P extreme", () => {
  const long = patienceCandleEngine(setup("long", candle(2, 10.8, 11.75, 10.1, 11.7)), "long", {
    eligibilityEvents: eligibility(),
  }).occurrences?.[0];
  const short = patienceCandleEngine(setup("short", candle(2, 10.8, 11.75, 10.1, 9.7)), "short", {
    eligibilityEvents: eligibility(),
  }).occurrences?.[0];
  assert.equal(long?.stopBufferTicks, 8);
  assert.equal(long?.stopBufferPoints, 2);
  assert.equal(long?.finalStopBoundary, long ? Math.round((long.patienceCandle.low - 2) / 0.25) * 0.25 : undefined);
  assert.equal(short?.stopBufferTicks, 8);
  assert.equal(short?.stopBufferPoints, 2);
  assert.equal(short?.finalStopBoundary, short ? Math.round((short.patienceCandle.high + 2) / 0.25) * 0.25 : undefined);
});

test("an active trigger candle does not need to close", () => {
  const result = patienceCandleEngine([
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 11, 7, 10.8),
    candle(2, 10.8, 10.95, 9.2, 10.9, false),
  ], "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "TRIGGER_CANDLE_ACTIVE");
});

test("bullish opposite-side-first gap invalidates the setup", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 8.8, 9.5, 6.5, 8, false)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "OPPOSITE_SIDE_INVALIDATION");
  assert.equal(result.triggerPrice, 7);
});

test("bearish opposite-side-first gap invalidates the setup", () => {
  const result = patienceCandleEngine(setup("short", candle(2, 11.2, 13.5, 10.2, 10.5, false)), "short", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "OPPOSITE_SIDE_INVALIDATION");
  assert.equal(result.triggerPrice, 13);
});

test("both sides touched without sequence proof are ambiguous", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10, 12.2, 6.8, 10.5)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.state, "AMBIGUOUS_EVENT_ORDER");
  assert.equal(result.triggerPrice, null);
});

test("touching the opposite patience wick without breaking it does not invalidate E", () => {
  const bullish = patienceCandleEngine(setup("long", candle(2, 10, 12.2, 7, 10.5)), "long", { eligibilityEvents: eligibility() });
  const bearish = patienceCandleEngine(setup("short", candle(2, 10, 13, 7.8, 10.5)), "short", { eligibilityEvents: eligibility() });
  assert.equal(bullish.state, "ENTRY_TRIGGERED");
  assert.equal(bearish.state, "ENTRY_TRIGGERED");
});

test("a proven first-touch sequence resolves a two-sided trigger conservatively", () => {
  const candles = setup("long", candle(2, 10, 12.2, 6.8, 10.5));
  const intended = patienceCandleEngine(candles, "long", {
    eligibilityEvents: eligibility(),
    intrabarEvidence: [{ candleOpenTime: candles[2].openTime, firstBreak: "intended-first" }],
  });
  const opposite = patienceCandleEngine(candles, "long", {
    eligibilityEvents: eligibility(),
    intrabarEvidence: [{ candleOpenTime: candles[2].openTime, firstBreak: "opposite-first" }],
  });
  assert.equal(intended.state, "ENTRY_TRIGGERED");
  assert.equal(opposite.state, "OPPOSITE_SIDE_INVALIDATION");
});

test("gaps through the intended side trigger at the opening print", () => {
  const bullish = patienceCandleEngine(setup("long", candle(2, 12.2, 12.5, 11.8, 12.3, false)), "long", { eligibilityEvents: eligibility() });
  const bearish = patienceCandleEngine(setup("short", candle(2, 7.8, 8.2, 7.5, 7.7, false)), "short", { eligibilityEvents: eligibility() });
  assert.equal(bullish.state, "ENTRY_BUFFER_REACHED");
  assert.equal(bearish.state, "ENTRY_BUFFER_REACHED");
});

test("raw patience breaks wait for the full confirmation buffer", () => {
  const bullish = patienceCandleEngine(setup("long", candle(2, 10.8, 11.1, 10.1, 10.9, false)), "long", { eligibilityEvents: eligibility() });
  const bearish = patienceCandleEngine(setup("short", candle(2, 9.2, 12, 8.9, 9, false)), "short", { eligibilityEvents: eligibility() });
  assert.equal(bullish.state, "BREAK_DETECTED_WAITING_FOR_BUFFER");
  assert.equal(bullish.entryBufferPrice, 12);
  assert.equal(bearish.state, "BREAK_DETECTED_WAITING_FOR_BUFFER");
  assert.equal(bearish.entryBufferPrice, 8);
});

test("eight-tick confirmation is governed and the thesis stop sits eight ticks beyond the opposite wick", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 13.75, 10.1, 13.7)), "long", {
    eligibilityEvents: eligibility(),
    entryBufferTicks: 8,
    stopBufferTicks: 8,
  });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.entryBufferTicks, 8);
  assert.equal(result.entryBufferPrice, 12);
  assert.equal(result.strategyStopPrice, 5);
});

test("a one-tick-short long and short excursion cannot confirm the governed buffer", () => {
  const long = patienceCandleEngine(setup("long", candle(2, 10.8, 11.75, 10.1, 11.7)), "long", { eligibilityEvents: eligibility() });
  const short = patienceCandleEngine(setup("short", candle(2, 9.2, 9.8, 8.25, 9)), "short", { eligibilityEvents: eligibility() });
  assert.equal(long.state, "PATIENCE_CANDLE_EXPIRED");
  assert.equal(short.state, "PATIENCE_CANDLE_EXPIRED");
  assert.equal(long.entryBufferPrice, 12);
  assert.equal(short.entryBufferPrice, 8);
});

test("generic continuation still requires a confirmed trend, but records the examined shape", () => {
  const neutral = patienceCandleEngine(setup("long", candle(2, 10.8, 10.9, 10.1, 10.7)), "long", {
    eligibilityEvents: eligibility(),
    trend: "neutral",
  });
  const opposingShape = patienceCandleEngine([
    candle(0, 10, 12, 8, 10.5),
    candle(1, 10.5, 13, 9, 12),
  ], "long", { eligibilityEvents: eligibility() });
  assert.equal(neutral.state, "PATIENCE_TREND_MISMATCH");
  assert.match(neutral.detail, /WAITING — TREND UNCLEAR/);
  assert.equal(neutral.occurrences?.length ?? 0, 0);
  assert.equal(opposingShape.state, "PATIENCE_TREND_MISMATCH");
});

test("ORB-directed bearish patience qualifies through a neutral 15-minute trend", () => {
  const result = patienceCandleEngine(setup("short", candle(2, 9.2, 9.8, 7.8, 8)), "short", {
    eligibilityEvents: eligibility(),
    trend: "neutral",
    directionSource: "ORB_BREAKOUT",
  });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.directionSource, "ORB_BREAKOUT");
  assert.equal(result.occurrences?.[0]?.qualificationStatus, "SIGNAL_CONFIRMED");
});

test("ORB-directed bullish patience qualifies through an opposing 15-minute trend", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 12.1, 10.2, 12)), "long", {
    eligibilityEvents: eligibility(),
    trend: "bearish",
    directionSource: "ORB_BREAKOUT",
  });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.directionSource, "ORB_BREAKOUT");
  assert.equal(result.occurrences?.[0]?.qualificationStatus, "SIGNAL_CONFIRMED");
});

test("generic continuation does not qualify without a causal direction", () => {
  const result = phase5PatienceAnalysis(
    setup("long", candle(2, 10.8, 12.1, 10.2, 12)),
    null,
    { status: "observed", events: [], evaluatedCandles: 2, maxCandles: 6, maxDurationMinutes: 30, elapsedMinutes: 5, proximityTolerance: 0.5, atr14: 1, qualifyingLevelCount: 1, detail: "observed" },
    null,
    [],
    undefined,
    "neutral",
  );
  assert.equal(result.direction, undefined);
  assert.equal(result.state, "PATIENCE_TREND_MISMATCH");
});

test("a qualifying patience shape remains eligible beyond thirty minutes", () => {
  const candles = [
    candle(0, 10, 12, 8, 10.5),
    candle(10, 10.5, 11, 7, 10.8),
     candle(11, 10.8, 13, 10.2, 12.8),
  ];
  const result = patienceCandleEngine(candles, "long", {
    eligibilityEvents: [{ time: candles[1].openTime, reason: "pullback" }],
    directionSource: "ORB_BREAKOUT",
    trend: "neutral",
  });
  assert.equal(result.state, "ENTRY_TRIGGERED");
  assert.equal(result.occurrences?.[0]?.patienceCandle.openTime, candles[1].openTime);
});

test("buffer configuration rejects unsupported confirmation widths", () => {
  assert.throws(() => patienceCandleEngine([], "long", { entryBufferTicks: 7 }), /exactly eight MES ticks/i);
  assert.throws(() => patienceCandleEngine([], "long", { stopBufferTicks: 1 }), /exactly eight MES ticks/i);
});

test("pullback and consolidation locations can open patience eligibility", () => {
  const pullback: PullbackAnalysis = {
    status: "observed",
    events: [{
      type: "touch",
      time: FIVE_MINUTES,
      level: "VWAP",
      price: 10,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      levelKind: "primary_indicator",
      levelSourceTimestamp: FIVE_MINUTES,
      detail: "touch",
    }],
    evaluatedCandles: 1,
    maxCandles: 6,
    maxDurationMinutes: 30,
    elapsedMinutes: 5,
    proximityTolerance: 0.5,
    atr14: 1,
    qualifyingLevelCount: 1,
    detail: "observed",
  };
  const consolidation = { ...pullback, events: [{ ...pullback.events[0], type: "consolidation" as const }] };
  const candles = setup("long", candle(2, 10.8, 10.95, 9.2, 10.9));
  const analysis = phase5PatienceAnalysis(candles, "long", pullback, null);
  assert.equal(analysis.eligibilityReason, "pullback");
  assert.equal(analysis.eligibilityProvenance?.levelKind, "primary_indicator");
  assert.equal(analysis.eligibilityProvenance?.levelSourceTimestamp, FIVE_MINUTES);
  assert.equal(phase5PatienceAnalysis(candles, "long", consolidation, null).eligibilityReason, "consolidation");
});

test("a terminal causal pullback arm cannot create another Phase 5 occurrence", () => {
  const pullback: PullbackAnalysis = {
    status: "expired",
    armId: "terminal-arm",
    armState: "SESSION_BOUNDARY_EXPIRED",
    armTransitions: [],
    terminalReason: "session boundary",
    structure: {
      detected: true,
      direction: "long",
      impulseExtreme: 12,
      impulseExtremeTime: 0,
      pullbackStart: FIVE_MINUTES,
      pullbackEnd: 2 * FIVE_MINUTES,
      depthPoints: 1,
      retracementPercent: 20,
      greaterThan50PercentWarning: false,
    },
    events: [{
      armId: "terminal-arm",
      type: "touch",
      time: FIVE_MINUTES,
      level: "VWAP",
      price: 10,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      detail: "terminal interaction",
    }],
    evaluatedCandles: 2,
    maxCandles: 6,
    maxDurationMinutes: 30,
    elapsedMinutes: 10,
    proximityTolerance: 3,
    atr14: 1,
    qualifyingLevelCount: 1,
    detail: "expired",
  };
  const result = phase5PatienceAnalysis(
    setup("long", candle(2, 10.8, 12.1, 10.2, 12)),
    "long",
    pullback,
    null,
  );
  assert.equal(result.occurrences?.length ?? 0, 0);
  assert.equal(result.state, "WAITING_FOR_LEVEL");
  assert.match(result.detail, /terminal/i);
});

test("a terminal boundary after confirmation preserves the earlier patience occurrence", () => {
  const pOpen = Date.parse("2026-08-25T16:00:00.000Z");
  const candles = [
    datedCandle("2026-08-25T15:55:00.000Z", 10, 12, 8, 10.5),
    datedCandle("2026-08-25T16:00:00.000Z", 10.5, 11, 7, 10.8),
    datedCandle("2026-08-25T16:05:00.000Z", 10.8, 13, 10.2, 13),
  ];
  const pullback: PullbackAnalysis = {
    status: "expired",
    armId: "cutoff-after-confirmation",
    armState: "ENTRY_CUTOFF_EXPIRED",
    armTransitions: [{
      from: "LEVEL_INTERACTION_FOUND",
      to: "ENTRY_CUTOFF_EXPIRED",
      time: pOpen + 10 * FIVE_MINUTES,
      reason: "entry cutoff",
    }],
    terminalReason: "entry cutoff",
    structure: {
      detected: true,
      direction: "long",
      impulseExtreme: 12,
      impulseExtremeTime: pOpen - FIVE_MINUTES,
      pullbackStart: pOpen,
      pullbackEnd: pOpen + FIVE_MINUTES,
      depthPoints: 1,
      retracementPercent: 20,
      greaterThan50PercentWarning: false,
    },
    events: [{
      armId: "cutoff-after-confirmation",
      type: "touch",
      time: pOpen,
      level: "VWAP",
      price: 10,
      distancePoints: 0,
      distanceTicks: 0,
      tolerancePoints: 3,
      toleranceTicks: 12,
      qualifies: true,
      detail: "confirmed before cutoff",
    }],
    evaluatedCandles: 2,
    maxCandles: 6,
    maxDurationMinutes: 30,
    elapsedMinutes: 10,
    proximityTolerance: 3,
    atr14: 1,
    qualifyingLevelCount: 1,
    detail: "expired after confirmation",
  };
  const result = phase5PatienceAnalysis(
    candles,
    "long",
    pullback,
    { high: 10, low: 0, complete: true },
    [],
    null,
    "bullish",
    0.25,
    8,
    8,
    false,
    "ORB_BREAKOUT",
  );
  assert.equal(result.occurrences?.[0]?.outcomeStatus, "CONFIRMED");
  assert.equal(result.occurrences?.[0]?.patienceCandle.openTime, pOpen);
});

test("extended consolidation inside NTZ can open patience eligibility", () => {
  const candles = [
    candle(0, 10, 11, 9, 10),
    candle(1, 10, 10.8, 9.2, 10.2),
    candle(2, 10.2, 10.7, 9.3, 10.3),
  ];
  const result = phase5PatienceAnalysis(candles, "long", {
    status: "pending",
    events: [],
    evaluatedCandles: 0,
    maxCandles: 6,
    maxDurationMinutes: 30,
    elapsedMinutes: 0,
    proximityTolerance: null,
    atr14: null,
    qualifyingLevelCount: 0,
    detail: "none",
  }, { high: 11, low: 9, complete: true });
  assert.equal(result.eligibilityReason, "ntz consolidation");
});

test("no qualifying location remains waiting", () => {
  const result = patienceCandleEngine(setup("long", candle(2, 10.8, 11.1, 10.2, 11)), "long");
  assert.equal(result.state, "WAITING_FOR_VALID_CONTEXT");
  assert.equal(result.eligible, false);
  assert.deepEqual(result.occurrences ?? [], []);
});

test("non-qualifying pullback events cannot open patience eligibility", () => {
  const result = phase5PatienceAnalysis(
    setup("long", candle(2, 10.8, 12.1, 10.2, 12)),
    "long",
    {
      status: "observed",
      events: [{
        type: "touch",
        time: FIVE_MINUTES,
        level: "VWAP",
        price: 10,
        distancePoints: 0,
        distanceTicks: 0,
        tolerancePoints: 1,
        toleranceTicks: 4,
        qualifies: false,
        detail: "Touch was outside the governed qualification rule.",
      }],
      evaluatedCandles: 1,
      maxCandles: 6,
      maxDurationMinutes: 30,
      elapsedMinutes: 5,
      proximityTolerance: 0.25,
      atr14: 1,
      qualifyingLevelCount: 0,
      detail: "Only a rejected pullback event was observed.",
    },
    null,
    [],
  );
  assert.equal(result.state, "WAITING_FOR_LEVEL");
  assert.equal(result.eligible, false);
});

test("wrong-side invalidation remains a diagnostic patience occurrence", () => {
   const result = patienceCandleEngine(setup("long", candle(2, 8.8, 9.5, 6.5, 8)), "long", { eligibilityEvents: eligibility() });
  assert.equal(result.occurrences?.[0]?.status, "OPPOSITE_SIDE_INVALIDATION");
  assert.equal(result.occurrences?.[0]?.triggerCandle?.openTime, candle(2, 8.8, 10.5, 6.5, 8).openTime);
});