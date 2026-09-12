import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { getFuturesContractSpecification } from "./contracts.js";
import {
  getHistoricalCsvFingerprint,
  historicalImportToReplayDataset,
  importHistoricalCsv,
  importHistoricalCsvBatch,
  mergeHistoricalCsvImportSummaries,
  mergeHistoricalCsvImports,
} from "./historical-csv-import.js";
import { newYorkTimeToUtc, sessionCalendarForContract, tradingDateForTimestamp } from "./session-calendar.js";

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

async function withGenericCsv(
  rows: string[],
  compressed: boolean,
  callback: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "levelstory-generic-csv-"));
  const plainPath = join(directory, "generic-databento.csv");
  const content = ["ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol", ...rows].join("\n");
  const path = compressed ? `${plainPath}.zst` : plainPath;
  await writeFile(path, compressed ? zstdCompressSync(content) : content);
  try {
    await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function genericRow(timestamp: number, symbol: string, index: number, close = 6800 + index + 0.5): string {
  const price = 6800 + index;
  return `${new Date(timestamp).toISOString()},33,1,42003239,${price},${price + 1},${price - 1},${close},${100 + index},${symbol}`;
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

test("counts every verified shortened holiday session through the 1:00 p.m. ET halt", async () => {
  const sessions = [
    ["2025-09-01", "2025-09-01T13:30:00.000Z"],
    ["2026-01-19", "2026-01-19T14:30:00.000Z"],
    ["2026-02-16", "2026-02-16T14:30:00.000Z"],
    ["2026-05-25", "2026-05-25T13:30:00.000Z"],
    ["2026-06-19", "2026-06-19T13:30:00.000Z"],
  ] as const;
  for (const [date, start] of sessions) {
    const regularStart = Date.parse(start);
    const rows = Array.from({ length: 210 }, (_, index) => row(regularStart + index * 60_000, index));
    rows.push(row(regularStart + 211 * 60_000, 211));
    await withCsv(rows, async (path) => {
      const imported = await importHistoricalCsv(path, specification);
      assert.equal(imported.summary.regularSessionCandleCount, 210);
      assert.equal(imported.summary.earlyCloseDates.includes(date), true);
      assert.deepEqual(imported.summary.completeRegularSessionDates, [date]);
      assert.deepEqual(imported.summary.missingRegularSessionDates, []);
      assert.equal(imported.summary.unexpectedMissingMinutes, 0);
      assert.ok(imported.summary.earlyCloseMinutes > 0);
      const dataset = historicalImportToReplayDataset(imported, date, date, 1, 0, [date]);
      assert.deepEqual(dataset.selectedDates, [date]);
      assert.equal(dataset.gapReport?.unexpectedMissingMinutes, 0);
    });
  }
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

test("actual historical source reconciles selected 5 plus 2 and rejects more than 10 sessions", async () => {
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
  const recentStart = imported.summary.availableTradingDates.at(-7)!;
  const recentEnd = imported.summary.availableTradingDates.at(-1)!;
  for (const [inSampleDays, outOfSampleDays] of [[5, 2]]) {
    const dataset = historicalImportToReplayDataset(imported, recentStart, recentEnd, inSampleDays, outOfSampleDays);
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
  assert.throws(
    () => historicalImportToReplayDataset(imported, imported.summary.availableTradingDates[0]!, recentEnd, 1, 1),
    /at most 10 sessions/i,
  );
});

test("merges overlapping fragments deterministically and retains all aggregate intervals", async () => {
  const start = Date.parse("2026-08-26T13:30:00.000Z");
  const rows = Array.from({ length: 10 }, (_, index) => row(start + index * 60_000, index));
  await withCsv(rows.slice(0, 6), async (firstPath) => {
    await withCsv(rows.slice(5), async (secondPath) => {
      const first = await importHistoricalCsv(firstPath, specification);
      const second = await importHistoricalCsv(secondPath, specification);
      const merged = mergeHistoricalCsvImports([second, first]);
      assert.equal(merged.oneMinute.length, 10);
      assert.equal(merged.summary.duplicateRowsRemoved, 1);
      assert.deepEqual(merged.oneMinute.map((candle) => candle.openTime), rows.map((_, i) => start + i * 60_000));
      assert.ok(merged.fiveMinute.length > 0);
      assert.ok(merged.fifteenMinute.length > 0);
      assert.ok(merged.oneHour.length > 0);
    });
  });
});

test("rejects conflicting same-timestamp rows across fragments", async () => {
  const timestamp = Date.parse("2026-08-26T13:30:00.000Z");
  await withCsv([row(timestamp, 0)], async (firstPath) => {
    await withCsv([row(timestamp, 1)], async (secondPath) => {
      const first = await importHistoricalCsv(firstPath, specification);
      const second = await importHistoricalCsv(secondPath, specification);
      assert.throws(
        () => mergeHistoricalCsvImports([first, second]),
        /Conflicting OHLCV rows/,
      );
    });
  });
});

test("rejects non-minute-aligned timestamps and streams compressed zstd inputs", async () => {
  await withCsv([row(Date.parse("2026-08-26T13:30:30.000Z"), 0)], async (path) => {
    const imported = await importHistoricalCsv(path, specification);
    assert.equal(imported.summary.rejectionReasons.MISALIGNED_MINUTE_TIMESTAMP, 1);
    assert.equal(imported.oneMinute.length, 0);
  });
  const directory = await mkdtemp(join(tmpdir(), "levelstory-zst-"));
  const path = join(directory, "historical.csv.zst");
  try {
    const csv = ["ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol", row(Date.parse("2026-08-26T13:30:00.000Z"), 0)].join("\n");
    await writeFile(path, zstdCompressSync(Buffer.from(csv)));
    const imported = await importHistoricalCsv(path, specification);
    assert.equal(imported.summary.validRows, 1);
    assert.equal(imported.summary.detectedSymbol, "MESU6");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a Databento filename and internal symbol mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "levelstory-mismatch-"));
  const path = join(directory, "glbx-mdp3-20260901-20260902.ohlcv-1m.MESU6.csv");
  try {
    await writeFile(path, [
      "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol",
      row(Date.parse("2026-08-26T13:30:00.000Z"), 0).replace("MESU6", "MESZ6"),
    ].join("\n"));
    const imported = await importHistoricalCsv(path, specification);
    assert.equal(imported.summary.rejectionReasons.FILENAME_SYMBOL_MISMATCH, 1);
    assert.equal(imported.oneMinute.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("demultiplexes interleaved outright MES symbols in one streaming pass", async () => {
  const start = Date.parse("2026-08-26T13:30:00.000Z");
  await withGenericCsv([
    genericRow(start, "MESH6", 0),
    genericRow(start, "MESM6", 10),
    genericRow(start + 60_000, "MESH6", 1),
    genericRow(start + 60_000, "MESM6", 11),
  ], false, async (path) => {
    const batch = await importHistoricalCsvBatch(path, specification, {
      aggregations: [5],
      onBatch: () => undefined,
    });
    assert.deepEqual([...batch.imports.keys()], ["MESH6", "MESM6"]);
    assert.equal(batch.imports.get("MESH6")?.summary.validRows, 2);
    assert.equal(batch.imports.get("MESM6")?.summary.validRows, 2);
    assert.equal(batch.rejectedRows.length, 0);
  });
});

test("keeps duplicate and conflict diagnostics at contract/date scope", async () => {
  const first = Date.parse("2026-08-26T13:30:00.000Z");
  const second = Date.parse("2026-08-27T13:30:00.000Z");
  await withGenericCsv([
    genericRow(first, "MESH6", 0),
    genericRow(first, "MESH6", 0),
    genericRow(first, "MESH6", 0, 6800.75),
    genericRow(second, "MESH6", 1),
    genericRow(first, "MESM6", 10),
    genericRow(second, "MESM6", 11),
  ], false, async (path) => {
    const batch = await importHistoricalCsvBatch(path, specification, {
      aggregations: [5],
      onBatch: () => undefined,
    });
    const mesh = batch.imports.get("MESH6")!;
    const mesm = batch.imports.get("MESM6")!;
    assert.equal(mesh.summary.duplicateRowsRemoved, 1);
    assert.equal(mesh.summary.untrustedTradingDates?.["2026-08-26"]?.includes("CONFLICTING_DUPLICATE_TIMESTAMP"), true);
    assert.equal(mesh.summary.untrustedTradingDates?.["2026-08-27"], undefined);
    assert.equal(mesm.summary.rejectedRows, 0);
  });
});

test("demultiplexes compressed generic Databento files without rereading per symbol", async () => {
  const start = Date.parse("2026-08-26T13:30:00.000Z");
  await withGenericCsv([
    genericRow(start, "MESH6", 0),
    genericRow(start, "MESM6", 10),
  ], true, async (path) => {
    const batch = await importHistoricalCsvBatch(path, specification, {
      aggregations: [5],
      onBatch: () => undefined,
    });
    assert.equal(batch.imports.size, 2);
    assert.equal(batch.rowsRead, 2);
    assert.equal(batch.flushCount, 2);
  });
});

test("preserves bounded fragment summaries without retained candle arrays", async () => {
  await withGenericCsv([
    "2025-09-05T13:30:00.000Z,1,1,1,100,101,99,100.5,12,MESU5",
    "2025-09-05T13:31:00.000Z,1,1,1,100.5,101.5,100,101,13,MESU5",
    "2025-09-05T13:32:00.000Z,1,1,1,101,102,100.5,101.5,14,MESU5",
    "2025-09-05T13:33:00.000Z,1,1,1,101.5,102.5,101,102,15,MESU5",
    "2025-09-05T13:34:00.000Z,1,1,1,102,103,101.5,102.5,16,MESU5",
  ], false, async (path) => {
    const batch = await importHistoricalCsvBatch(path, specification, {
      retainCandles: false,
      aggregations: [5],
      batchSize: 2,
      onBatch: async () => undefined,
    });
    const fragment = batch.imports.get("MESU5");
    assert.ok(fragment);
    assert.equal(fragment.oneMinute.length, 0);
    assert.equal(fragment.summary.validRows, 5);
    assert.equal(fragment.summary.aggregationCounts.oneMinute, 5);
    assert.equal(fragment.summary.aggregationCounts.fiveMinute, 1);
    const merged = mergeHistoricalCsvImportSummaries(
      [fragment.summary],
      { ...specification, fullContractSymbol: "MESU5", contractMonth: "2025-09" },
      sessionCalendarForContract({ ...specification, fullContractSymbol: "MESU5", contractMonth: "2025-09" }),
      fragment.contentFingerprint,
    );
    assert.equal(merged.summary.validRows, 5);
    assert.equal(merged.summary.availableTradingDates.length, 1);
    assert.equal(merged.summary.aggregationCounts.fiveMinute, 1);
  });
});

test("does not let one contract's malformed row invalidate another contract", async () => {
  const start = Date.parse("2026-08-26T13:30:00.000Z");
  await withGenericCsv([
    genericRow(start, "MESH6", 0).replace(",6801,6799,", ",6799,6801,"),
    genericRow(start, "MESM6", 10),
  ], false, async (path) => {
    const batch = await importHistoricalCsvBatch(path, specification, { aggregations: [5] });
    assert.equal(batch.imports.get("MESH6")?.summary.validRows, 0);
    assert.equal(batch.imports.get("MESH6")?.summary.rejectedRows, 1);
    assert.equal(batch.imports.get("MESM6")?.summary.validRows, 1);
    assert.equal(batch.imports.get("MESM6")?.summary.rejectedRows, 0);
  });
});