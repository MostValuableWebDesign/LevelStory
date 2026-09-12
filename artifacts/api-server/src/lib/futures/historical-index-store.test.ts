import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { HistoricalIndexStore } from "./historical-index-store.js";
import { getFuturesContractSpecification } from "./contracts.js";
import { sessionCalendarForContract } from "./session-calendar.js";
import type { HistoricalCsvImport } from "./historical-csv-import.js";

function fixtureImport(): HistoricalCsvImport {
  const specification = {
    ...getFuturesContractSpecification("MES"),
    fullContractSymbol: "MESU5",
    contractMonth: "2025-09",
  };
  const calendar = sessionCalendarForContract(specification);
  const openTime = Date.parse("2025-09-05T13:30:00.000Z");
  const candle = {
    timestamp: openTime,
    openTime,
    closeTime: openTime + 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 12,
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    contractSymbol: "MESU5",
    isComplete: true,
    intervalMinutes: 1 as const,
    quality: { valid: true, codes: [] },
  };
  return {
    specification,
    calendar,
    contentFingerprint: "fixture-source",
    oneMinute: [candle],
    fiveMinute: [{ ...candle, closeTime: openTime + 300_000, intervalMinutes: 5 as const }],
    fifteenMinute: [],
    oneHour: [],
    summary: {
      source: "historical_databento",
      filename: "fixture.csv",
      detectedSymbol: "MESU5",
      earliestTimestamp: new Date(openTime).toISOString(),
      latestTimestamp: new Date(openTime).toISOString(),
      totalRows: 1,
      validRows: 1,
      rejectedRows: 0,
      duplicateRowsRemoved: 0,
      missingMinuteGaps: 0,
      missingGapSegments: 0,
      unexpectedMissingMinutes: 0,
      unexpectedOpenSessionMissingMinutes: 0,
      unexpectedOvernightMissingMinutes: 0,
      unexpectedRegularSessionMissingMinutes: 0,
      regularSessionGapSegments: 0,
      overnightGapSegments: 0,
      regularSessionMissingMinutes: 0,
      expectedClosedMarketMinutes: 0,
      expectedClosedMinutes: 0,
      weekendHolidayClosedMinutes: 0,
      earlyCloseMinutes: 0,
      inactiveContractMinutes: 0,
      lowLiquidityInactiveMinutes: 0,
      coverageScope: "full_file",
      inactiveContractThresholdPercent: 50,
      inactiveContractDays: 0,
      missingRegularSessionDates: [],
      missingOvernightSessionDates: [],
      completeRegularSessionDates: ["2025-09-05"],
      maintenanceGapMinutes: 0,
      weekendHolidayGapMinutes: 0,
      earlyCloseDates: [],
      overnightCoverageObserved: false,
      regularSessionCandleCount: 1,
      overnightCandleCount: 0,
      availableTradingDates: ["2025-09-05"],
      rejectionReasons: {},
      errors: [],
      aggregationCounts: { oneMinute: 1, fiveMinute: 1, fifteenMinute: 0, oneHour: 0 },
    },
  };
}

test("stores and reloads date/timeframe partitions and the committed source manifest", async () => {
  const directory = await mkdtemp("/tmp/levelstory-index-");
  const path = join(directory, "history.sqlite");
  const store = await HistoricalIndexStore.createAtomic(path);
  const imported = fixtureImport();
  store.writeMetadata({
    indexKey: "fixture-index",
    contentFingerprint: imported.contentFingerprint,
    summary: { fixture: true },
    importerVersion: "fixture",
    scheduleVersion: "fixture",
    indexedAt: new Date().toISOString(),
  });
  store.writeImport(imported, imported.contentFingerprint);
  store.writeImport(imported, imported.contentFingerprint);
  store.writeManifest({
    indexKey: "fixture-index",
    source: "historical_databento_multicontract",
    rootSymbol: "MES",
    contentFingerprint: imported.contentFingerprint,
    importerVersion: "fixture",
    scheduleVersion: "fixture",
    sessionCalendarVersion: "fixture",
    summary: { fixture: true },
    indexedAt: new Date().toISOString(),
    committedAt: new Date().toISOString(),
    files: [{
      ordinal: 0,
      filename: "fixture.csv",
      contractSymbol: "MESU5",
      objectPath: "uploads/fixture",
      materializedPath: "/tmp/fixture.csv",
      expectedCompression: "none",
      contentFingerprint: imported.contentFingerprint,
      sizeBytes: 12,
      status: "accepted",
      rejectionReason: null,
    }],
  });
  assert.equal(store.getPartitionCount(), 2);
  await store.commitAtomic();

  const reopened = HistoricalIndexStore.create(path);
  assert.equal(reopened.readMetadata()?.indexKey, "fixture-index");
  assert.equal(reopened.readManifest()?.files[0]?.contractSymbol, "MESU5");
  assert.deepEqual(reopened.validateCommittedManifest({
    indexKey: "fixture-index",
    contentFingerprint: imported.contentFingerprint,
    importerVersion: "fixture",
    scheduleVersion: "fixture",
  }), []);
  assert.deepEqual(reopened.runMaintenanceValidation({
    aggregationCounts: { oneMinute: 1, fiveMinute: 1, fifteenMinute: 0, oneHour: 0 },
  }), []);
  const checkpoint = {
    sourceFingerprint: "fixture-source",
    currentFile: "fixture.csv",
    currentContract: "MESU5",
    currentTradingDate: "2025-09-05",
    sourceOffset: null,
    completedPartitions: ["MESU5:1:2025-09-05"],
    completedFiles: [],
    rowsProcessed: 1,
    acceptedRows: 1,
    rejectedRows: 0,
    stagingIndexPath: path,
    heartbeatAt: new Date().toISOString(),
    resumeNote: "fixture",
  } as const;
  reopened.writeCheckpoint(checkpoint);
  assert.deepEqual(reopened.readCheckpoint(), checkpoint);
  assert.deepEqual(reopened.getCandles("MESU5", "2025-09-05", 1).map((candle) => candle.close), [100.5]);
  assert.deepEqual(reopened.getCandles("MESU5", "2025-09-05", 5).map((candle) => candle.close), [100.5]);
  reopened.close();
});

test("preserves checkpointed staging for resumable cancellation and keeps replay writes idempotent", async () => {
  const directory = await mkdtemp("/tmp/levelstory-index-resume-");
  const committedPath = join(directory, "history.sqlite");
  const staged = await HistoricalIndexStore.createAtomic(committedPath);
  const checkpoint = {
    sourceFingerprint: "resume-source",
    currentFile: "fixture.csv",
    currentContract: "MESU5",
    currentTradingDate: "2025-09-05",
    sourceOffset: null,
    completedPartitions: ["MESU5:1:2025-09-05", "MESU5:5:2025-09-05"],
    completedFiles: [],
    rowsProcessed: 2,
    acceptedRows: 2,
    rejectedRows: 0,
    stagingIndexPath: staged.stagingPath!,
    heartbeatAt: new Date().toISOString(),
    resumeNote: "cancellation",
  } as const;
  staged.writeCheckpoint(checkpoint);
  const stagingPath = staged.stagingPath;
  assert.ok(stagingPath);
  assert.equal(staged.preserveAtomic(), stagingPath);

  const resumed = await HistoricalIndexStore.createAtomic(committedPath, stagingPath);
  assert.deepEqual(resumed.readCheckpoint(), checkpoint);
  const imported = fixtureImport();
  resumed.writeImport(imported, imported.contentFingerprint);
  resumed.writeImport(imported, imported.contentFingerprint);
  assert.equal(resumed.getPartitionCount(), 2);
  await resumed.abortAtomic();
});