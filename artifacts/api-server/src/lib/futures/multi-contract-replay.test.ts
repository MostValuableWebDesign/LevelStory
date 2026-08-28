import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MES_ROLLOVER_SCHEDULE,
  MES_ROLLOVER_SCHEDULE_VERSION,
  buildRolloverBoundaries,
  buildMultiContractDateEligibility,
  compareMesContractSymbols,
  contractSpecificationForMesSymbol,
  multiContractImportToReplayDataset,
  parseMesContractSymbol,
  scheduledMesContractForDate,
  assertMultiContractCoverageReconciles,
  type HistoricalMultiContractImport,
} from "./multi-contract-replay.js";
import { newYorkTimeToUtc, sessionCalendarForContract } from "./session-calendar.js";

test("parses MES month codes and orders quarterly contracts chronologically", () => {
  assert.deepEqual(parseMesContractSymbol(" mesz5 "), {
    rootSymbol: "MES",
    contractSymbol: "MESZ5",
    monthCode: "Z",
    contractMonth: "2025-12",
    year: 2025,
    quarter: 4,
  });
  assert.equal(parseMesContractSymbol("MES-A5"), null);
  assert.equal(parseMesContractSymbol("MESA5"), null);
  assert.deepEqual(["MESU5", "MESH6", "MESZ5"].sort(compareMesContractSymbols), ["MESU5", "MESZ5", "MESH6"]);
});

test("uses the versioned rollover schedule by trading date", () => {
  assert.equal(scheduledMesContractForDate("2025-09-10"), "MESU5");
  assert.equal(scheduledMesContractForDate("2025-09-11"), "MESZ5");
  assert.equal(scheduledMesContractForDate("2026-06-11"), "MESU6");
  assert.equal(scheduledMesContractForDate("2025-01-01"), null);
  assert.deepEqual(buildRolloverBoundaries(), MES_ROLLOVER_SCHEDULE.map((item, index) => ({
    effectiveDate: item.effectiveDate,
    fromContractSymbol: MES_ROLLOVER_SCHEDULE[index - 1]?.contractSymbol ?? null,
    toContractSymbol: item.contractSymbol,
    scheduleVersion: MES_ROLLOVER_SCHEDULE_VERSION,
  })));
});

test("selects contract-local candles on each rollover date without blending", () => {
  const dates = ["2025-09-10", "2025-09-11"];
  const contracts = new Map<string, any>();
  for (const [contractSymbol, tradingDate] of [["MESU5", dates[0]], ["MESZ5", dates[1]]] as const) {
    const specification = contractSpecificationForMesSymbol(contractSymbol);
    const calendar = sessionCalendarForContract(specification);
    const openTime = newYorkTimeToUtc(tradingDate, "09:30");
    const candle = {
      timestamp: openTime,
      openTime,
      closeTime: openTime + 60_000,
      open: contractSymbol === "MESU5" ? 100 : 200,
      high: contractSymbol === "MESU5" ? 101 : 201,
      low: contractSymbol === "MESU5" ? 99 : 199,
      close: contractSymbol === "MESU5" ? 100.5 : 200.5,
      volume: 10,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      contractSymbol,
      isComplete: true,
      intervalMinutes: 1 as const,
      quality: { valid: true, codes: [] },
    };
    contracts.set(contractSymbol, {
      summary: { availableTradingDates: [tradingDate] },
      oneMinute: [candle],
      fiveMinute: [{ ...candle, closeTime: openTime + 300_000, intervalMinutes: 5 as const }],
      fifteenMinute: [],
      oneHour: [],
      specification,
      calendar,
    });
  }
  const imported = {
    summary: {
      availableTradingDates: dates,
      eligibleTradingDates: dates,
      acceptedContracts: ["MESU5", "MESZ5"],
    },
    contracts,
  } as unknown as HistoricalMultiContractImport;

  const dataset = multiContractImportToReplayDataset(imported, dates[0], dates[1], 1, 1);
  assert.equal(dataset.source, "historical_databento_multicontract");
  assert.deepEqual(dataset.contractSchedule?.activeContractByDate, [
    { tradingDate: dates[0], contractSymbol: "MESU5" },
    { tradingDate: dates[1], contractSymbol: "MESZ5" },
  ]);
  assert.deepEqual([...new Set(dataset.candles.map((candle) => candle.contractSymbol))], ["MESU5", "MESZ5"]);
  assert.equal(dataset.contractSchedule?.version, MES_ROLLOVER_SCHEDULE_VERSION);
  assert.equal(dataset.contractSchedule?.boundaries.length, 5);
});

test("rejects an explicit sparse sample when one requested date is ineligible", () => {
  const date = "2025-09-10";
  const specification = contractSpecificationForMesSymbol("MESU5");
  const calendar = sessionCalendarForContract(specification);
  const openTime = newYorkTimeToUtc(date, "09:30");
  const candle = {
    timestamp: openTime,
    openTime,
    closeTime: openTime + 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    contractSymbol: "MESU5",
    isComplete: true,
    intervalMinutes: 1 as const,
    quality: { valid: true, codes: [] },
  };
  const imported = {
    summary: {
      availableTradingDates: [date, "2025-09-12"],
      eligibleTradingDates: [date],
      ineligibleDates: [{
        tradingDate: "2025-09-12",
        scheduledContractSymbol: "MESZ5",
        status: "missing_scheduled_file",
        reason: "MISSING_SCHEDULED_CONTRACT_FILE:MESZ5",
      }],
      acceptedContracts: ["MESU5"],
    },
    contracts: new Map([["MESU5", {
      summary: { availableTradingDates: [date] },
      oneMinute: [candle],
      fiveMinute: [{ ...candle, intervalMinutes: 5 as const }],
      fifteenMinute: [],
      oneHour: [],
      specification,
      calendar,
    }]]),
  } as unknown as HistoricalMultiContractImport;
  assert.throws(
    () => multiContractImportToReplayDataset(imported, date, "2025-09-12", 1, 1, [date, "2025-09-12"]),
    /not eligible.*2025-09-12/i,
  );
});

function summaryForDates(
  availableTradingDates: string[],
  completeRegularSessionDates: string[] = availableTradingDates,
  overrides: Record<string, unknown> = {},
): any {
  return {
    availableTradingDates,
    completeRegularSessionDates,
    rejectedRows: 0,
    duplicateRowsRemoved: 0,
    ...overrides,
  };
}

function importedSummary(
  contractSymbol: string,
  availableTradingDates: string[],
  completeRegularSessionDates: string[] = availableTradingDates,
  overrides: Record<string, unknown> = {},
): any {
  const specification = contractSpecificationForMesSymbol(contractSymbol);
  return {
    summary: summaryForDates(availableTradingDates, completeRegularSessionDates, overrides),
    specification,
    calendar: sessionCalendarForContract(specification),
  };
}

test("calculates observed dates independently from eligible scheduled replay dates", () => {
  const observedDates = ["2025-09-10", "2025-09-12"];
  const calendar = sessionCalendarForContract(contractSpecificationForMesSymbol("MESU5"));
  const rows = buildMultiContractDateEligibility(
    new Map([
      ["MESU5", importedSummary("MESU5", ["2025-09-10"])],
      ["MESZ6", importedSummary("MESZ6", ["2025-09-12"])],
    ]),
    observedDates,
    calendar,
  );
  const eligible = rows.filter((row) => row.backtestEligible).map((row) => row.tradingDate);
  const observedIneligible = rows.filter((row) => row.observedInAnyFile && !row.backtestEligible).map((row) => row.tradingDate);
  assert.deepEqual(eligible, ["2025-09-10"]);
  assert.deepEqual(observedIneligible, ["2025-09-12"]);
  assert.equal(rows.find((row) => row.tradingDate === "2025-09-12")?.status, "missing_scheduled_file");
  assert.equal(observedDates.length, eligible.length + observedIneligible.length);
});

test("marks an observed date with no scheduled-contract candles as ineligible", () => {
  const date = "2025-09-10";
  const calendar = sessionCalendarForContract(contractSpecificationForMesSymbol("MESU5"));
  const rows = buildMultiContractDateEligibility(
    new Map([
      ["MESU5", importedSummary("MESU5", [], [])],
      ["MESZ6", importedSummary("MESZ6", [date])],
    ]),
    [date],
    calendar,
  );
  const row = rows.find((item) => item.tradingDate === date);
  assert.equal(row?.observedInAnyFile, true);
  assert.equal(row?.scheduledContractFileAvailable, true);
  assert.equal(row?.scheduledContractDataAvailable, false);
  assert.equal(row?.status, "no_scheduled_contract_candles");
  assert.equal(row?.backtestEligible, false);
});

test("fails closed when coverage totals do not reconcile", () => {
  const dateEligibility = [{
    tradingDate: "2025-09-10",
    observedInAnyFile: true,
    backtestEligible: true,
  }, {
    tradingDate: "2025-09-12",
    observedInAnyFile: true,
    backtestEligible: false,
  }] as any;
  assert.doesNotThrow(() => assertMultiContractCoverageReconciles({
    allObservedTradingDates: ["2025-09-10", "2025-09-12"],
    eligibleTradingDates: ["2025-09-10"],
    ineligibleObservedDates: dateEligibility.slice(1),
    allObservedDateCount: 2,
    eligibleScheduledReplayDateCount: 1,
    ineligibleObservedDateCount: 1,
    coverageReconciles: true,
  }));
  assert.throws(() => assertMultiContractCoverageReconciles({
    allObservedTradingDates: ["2025-09-10", "2025-09-12"],
    eligibleTradingDates: ["2025-09-10"],
    ineligibleObservedDates: dateEligibility.slice(1),
    allObservedDateCount: 3,
    eligibleScheduledReplayDateCount: 1,
    ineligibleObservedDateCount: 1,
    coverageReconciles: false,
  }), /do not reconcile/i);
});