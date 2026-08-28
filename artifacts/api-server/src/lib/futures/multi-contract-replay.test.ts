import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MES_ROLLOVER_SCHEDULE,
  MES_ROLLOVER_SCHEDULE_VERSION,
  buildRolloverBoundaries,
  compareMesContractSymbols,
  contractSpecificationForMesSymbol,
  multiContractImportToReplayDataset,
  parseMesContractSymbol,
  scheduledMesContractForDate,
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
    summary: { availableTradingDates: dates, acceptedContracts: ["MESU5", "MESZ5"] },
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