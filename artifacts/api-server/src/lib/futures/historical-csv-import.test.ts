import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getFuturesContractSpecification } from "./contracts.js";
import {
  getHistoricalCsvFingerprint,
  historicalImportToReplayDataset,
  importHistoricalCsv,
} from "./historical-csv-import.js";
import { newYorkTimeToUtc, tradingDateForTimestamp } from "./session-calendar.js";

const specification = getFuturesContractSpecification("MES");

async function withCsv(rows: string[], callback: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "levelstory-csv-"));
  const path = join(directory, "test.MESU6.csv");
  await writeFile(path, ["ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol", ...rows].join("\n"));
  try {
    await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function row(timestamp: number, index: number): string {
  const price = 6800 + index;
  return `${new Date(timestamp).toISOString()},33,1,42003239,${price},${price + 1},${price - 1},${price + 0.5},${100 + index},MESU6`;
}

test("imports Databento OHLCV rows as a stream and reports validation statistics", async () => {
  const start = Date.parse("2026-08-26T13:30:00.000Z");
  const rows = Array.from({ length: 60 }, (_, index) => row(start + index * 60_000, index));
  rows.push(row(start + 59 * 60_000, 59));
  rows.push("2026-08-26T14:31:00.000000000Z,33,1,42003239,6800,6799,6801,6800,100,MESU6");
  rows.push("2026-08-26T14:32:00.000000000Z,33,1,42003239,6800,6801,6799,6800,-1,MESU6");
  rows.push("2026-08-26T14:33:00.000000000Z,33,1,42003239,6800,6801,6799,6800,100,MESZ5-MESU6");
  rows.push("not-a-timestamp,33,1,42003239,6800,6801,6799,6800,100,MESU6");
  await withCsv(rows, async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    assert.equal(imported.summary.detectedSymbol, "MESU6");
    assert.equal(imported.summary.totalRows, 65);
    assert.equal(imported.summary.validRows, 60);
    assert.equal(imported.summary.duplicateRowsRemoved, 1);
    assert.equal(imported.summary.rejectedRows, 4);
    assert.equal(imported.summary.rejectionReasons.INVALID_OHLC_RELATIONSHIP, 1);
    assert.equal(imported.summary.rejectionReasons.NEGATIVE_VOLUME, 1);
    assert.equal(imported.summary.rejectionReasons.CALENDAR_SPREAD_REJECTED, 1);
    assert.equal(imported.summary.rejectionReasons.INVALID_ISO_TIMESTAMP, 1);
    assert.equal(imported.summary.missingMinuteGaps, 0);
    assert.equal(imported.fiveMinute[0].open, 6800);
    assert.equal(imported.fiveMinute[0].close, 6804.5);
    assert.equal(imported.fiveMinute[0].volume, 510);
    assert.equal(imported.fiveMinute[0].isComplete, true);
    assert.equal(imported.fifteenMinute[0].close, 6814.5);
    assert.equal(imported.oneHour[0].volume, 3_435);
    assert.equal(imported.summary.regularSessionCandleCount, 60);
    assert.equal(imported.summary.overnightCandleCount, 0);
  });
});

test("detects missing minutes without treating a session boundary as a gap", async () => {
  const rows = [
    row(Date.parse("2026-08-26T13:30:00.000Z"), 0),
    row(Date.parse("2026-08-26T13:32:00.000Z"), 1),
    row(Date.parse("2026-08-27T13:30:00.000Z"), 2),
  ];
  await withCsv(rows, async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    assert.equal(imported.summary.missingGapSegments, 2);
    assert.equal(
      imported.summary.missingMinuteGaps,
      imported.summary.unexpectedMissingMinutes
        + imported.summary.expectedClosedMinutes
        + imported.summary.inactiveContractMinutes,
    );
  });
});

test("content fingerprints change when same-size CSV content changes", async () => {
  await withCsv([row(Date.parse("2026-08-26T13:30:00.000Z"), 0)], async (path) => {
    const first = await getHistoricalCsvFingerprint(path);
    const replacement = row(Date.parse("2026-08-26T13:30:00.000Z"), 1);
    assert.equal(replacement.length, row(Date.parse("2026-08-26T13:30:00.000Z"), 0).length);
    await writeFile(path, [
      "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol",
      replacement,
    ].join("\n"));
    const second = await getHistoricalCsvFingerprint(path);
    assert.notEqual(second, first);
  });
});

test("uses New York wall-clock session dates across daylight-saving time", async () => {
  const winter = newYorkTimeToUtc("2026-03-06", "09:30");
  const summer = newYorkTimeToUtc("2026-03-09", "09:30");
  assert.equal(new Date(winter).toISOString(), "2026-03-06T14:30:00.000Z");
  assert.equal(new Date(summer).toISOString(), "2026-03-09T13:30:00.000Z");
  assert.equal(tradingDateForTimestamp(winter), "2026-03-06");
  assert.equal(tradingDateForTimestamp(summer), "2026-03-09");
  await withCsv([row(winter, 0), row(summer, 1)], async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    assert.deepEqual(imported.summary.availableTradingDates, ["2026-03-06", "2026-03-09"]);
    assert.equal(imported.summary.regularSessionCandleCount, 2);
  });
});

test("historical replay selection keeps the imported source separate from simulation", async () => {
  const start = Date.parse("2026-08-24T13:30:00.000Z");
  const rows = Array.from({ length: 3 }, (_, index) => row(start + index * 86_400_000, index));
  await withCsv(rows, async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    const dataset = historicalImportToReplayDataset(imported, "2026-08-24", "2026-08-26", 2, 1);
    assert.equal(dataset.source, "historical_databento");
    assert.equal(dataset.quotesAvailable, false);
    assert.equal(dataset.inSampleDates.length, 2);
    assert.equal(dataset.outOfSampleDates.length, 1);
    assert.equal(dataset.candles.length, 3);
  });
});

test("selects the latest exact N plus M dates and exposes earlier dates as excluded", async () => {
  const start = Date.parse("2026-08-24T13:30:00.000Z");
  const rows = Array.from({ length: 4 }, (_, index) => row(start + index * 86_400_000, index));
  await withCsv(rows, async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    const dataset = historicalImportToReplayDataset(imported, "2026-08-24", "2026-08-27", 2, 1);
    assert.deepEqual(dataset.selectedDates, ["2026-08-25", "2026-08-26", "2026-08-27"]);
    assert.deepEqual(dataset.inSampleDates, ["2026-08-25", "2026-08-26"]);
    assert.deepEqual(dataset.outOfSampleDates, ["2026-08-27"]);
    assert.deepEqual(dataset.excludedDates, ["2026-08-24"]);
    assert.equal(dataset.contractSymbol, "MESU6");
  });
});

test("classifies regular-session and overnight gaps without counting maintenance as missing", async () => {
  const regularStart = Date.parse("2026-08-26T13:30:00.000Z");
  const rows = Array.from({ length: 391 }, (_, index) => index === 1 ? null : row(regularStart + index * 60_000, index))
    .filter((value): value is string => value !== null);
  rows.push(row(Date.parse("2026-08-26T22:00:00.000Z"), 500));
  rows.push(row(Date.parse("2026-08-26T22:02:00.000Z"), 501));
  await withCsv(rows, async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    assert.equal(imported.summary.regularSessionMissingMinutes, 1);
    assert.equal(imported.summary.unexpectedRegularSessionMissingMinutes, 1);
    assert.equal(imported.summary.unexpectedOvernightMissingMinutes, 1);
    assert.equal(imported.summary.overnightGapSegments, 1);
    assert.equal(imported.summary.expectedClosedMarketMinutes, 119);
  });
});

test("discloses inactive, missing, complete, and early-close session coverage", async () => {
  const regularStart = Date.parse("2026-07-02T13:30:00.000Z");
  const rows = Array.from({ length: 391 }, (_, index) => row(regularStart + index * 60_000, index));
  rows.push(row(Date.parse("2026-07-03T13:30:00.000Z"), 900));
  await withCsv(rows, async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    assert.equal(imported.summary.coverageScope, "full_file");
    assert.equal(imported.summary.inactiveContractThresholdPercent, 50);
    assert.equal(imported.summary.inactiveContractDays, 1);
    assert.deepEqual(imported.summary.completeRegularSessionDates, ["2026-07-02"]);
    assert.deepEqual(imported.summary.missingRegularSessionDates, ["2026-07-03"]);
    assert.deepEqual(imported.summary.earlyCloseDates, ["2026-07-03"]);
    assert.equal(imported.summary.overnightCoverageObserved, false);
  });
});

test("does not classify the Friday-to-Monday closure as unexpected overnight loss", async () => {
  const fridayStart = Date.parse("2026-08-28T13:30:00.000Z");
  const rows = Array.from({ length: 391 }, (_, index) => row(fridayStart + index * 60_000, index));
  rows.push(...Array.from({ length: 601 }, (_, index) => row(Date.parse("2026-08-30T22:00:00.000Z") + index * 60_000, 800 + index)));
  rows.push(row(Date.parse("2026-08-31T13:30:00.000Z"), 900));
  await withCsv(rows, async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    assert.equal(imported.summary.unexpectedOvernightMissingMinutes, 0);
    assert.equal(imported.summary.overnightCoverageObserved, true);
    assert.ok(imported.summary.maintenanceGapMinutes > 0);
    assert.ok(imported.summary.weekendHolidayClosedMinutes > 0);
    assert.equal(
      imported.summary.expectedClosedMinutes,
      imported.summary.maintenanceGapMinutes
        + imported.summary.weekendHolidayClosedMinutes
        + imported.summary.earlyCloseMinutes,
    );
    assert.equal(imported.summary.unexpectedMissingMinutes,
      imported.summary.unexpectedRegularSessionMissingMinutes
      + imported.summary.unexpectedOvernightMissingMinutes);
    assert.equal(
      imported.summary.missingMinuteGaps,
      imported.summary.unexpectedMissingMinutes
        + imported.summary.expectedClosedMinutes
        + imported.summary.inactiveContractMinutes,
    );
  });
});

test("actual historical source reconciles selected 5 plus 2 and 20 plus 2 ranges", async () => {
  const assetsDirectory = (
    await Promise.all([
      join(process.cwd(), "attached_assets"),
      join(process.cwd(), "..", "attached_assets"),
      join(process.cwd(), "..", "..", "attached_assets"),
    ].map(async (directory) => {
      try {
        await readdir(directory);
        return directory;
      } catch {
        return null;
      }
    }))
  ).find((directory): directory is string => directory !== null);
  assert.ok(assetsDirectory, "The attached_assets directory is required for this coverage test.");
  const filename = (await readdir(assetsDirectory))
    .find((entry) => entry.endsWith(".csv") && entry.includes("MESU6"));
  assert.ok(filename, "The uploaded MESU6 CSV fixture is required for this coverage test.");
  const imported = await importHistoricalCsv(join(assetsDirectory, filename), specification);
  for (const [inSampleDays, outOfSampleDays] of [[5, 2], [20, 2]]) {
    const dataset = historicalImportToReplayDataset(imported, "2025-08-27", "2026-08-26", inSampleDays, outOfSampleDays);
    const gapReport = dataset.gapReport!;
    assert.equal(dataset.selectedDates?.length, inSampleDays + outOfSampleDays);
    assert.equal(
      gapReport.missingMinuteGaps,
      gapReport.unexpectedMissingMinutes
        + gapReport.expectedClosedMinutes
        + gapReport.inactiveContractMinutes,
    );
    assert.equal(
      gapReport.expectedClosedMinutes,
      gapReport.maintenanceGapMinutes
        + gapReport.weekendHolidayClosedMinutes
        + gapReport.earlyCloseMinutes,
    );
    assert.equal(
      gapReport.unexpectedMissingMinutes,
      gapReport.unexpectedRegularSessionMissingMinutes
        + gapReport.unexpectedOvernightMissingMinutes,
    );
    assert.ok(gapReport.missingMinuteGaps >= gapReport.unexpectedMissingMinutes);
  }
});