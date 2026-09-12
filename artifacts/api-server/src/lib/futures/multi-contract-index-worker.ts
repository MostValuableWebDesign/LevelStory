import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { importHistoricalCsv, type HistoricalCsvProgress } from "./historical-csv-import.js";
import type { FuturesContractSpecification } from "./contracts.js";

type WorkerInput = {
  filePath: string;
  specification: FuturesContractSpecification;
  fingerprint: string;
};

const input = workerData as WorkerInput;

async function run(): Promise<void> {
  const value = await importHistoricalCsv(input.filePath, input.specification, {
  analyzeCoverage: true,
  aggregations: [5],
  fastParse: true,
  contentFingerprint: input.fingerprint,
  onProgress: (progress: HistoricalCsvProgress) => parentPort?.postMessage({ type: "progress", progress }),
  });
  const dataPath = `${input.filePath}.index-${randomUUID()}.jsonl`;
  const output = createWriteStream(dataPath, { flags: "wx" });
  for (const candle of value.oneMinute) {
    if (!output.write(`${JSON.stringify(candle)}\n`)) {
      await new Promise<void>((resolve, reject) => {
        output.once("drain", resolve);
        output.once("error", reject);
      });
    }
  }
  output.end();
  await finished(output);
  parentPort?.postMessage({
    type: "result",
    ok: true,
    summary: value.summary,
    fingerprint: value.contentFingerprint,
    dataPath,
  });
}

run().catch((error: unknown) => parentPort?.postMessage({
    type: "result",
    ok: false,
    error: error instanceof Error ? error.message : "Historical CSV indexing failed.",
}));