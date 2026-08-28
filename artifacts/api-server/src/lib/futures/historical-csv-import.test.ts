import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getFuturesContractSpecification } from "./contracts.js";
import {
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
    assert.equal(imported.summary.missingMinuteGaps, 1);
    assert.equal(imported.summary.missingGapSegments, 1);
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