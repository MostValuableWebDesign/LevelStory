import { parentPort, workerData } from "node:worker_threads";
import { importHistoricalCsv, type HistoricalCsvProgress } from "./historical-csv-import.js";
import type { FuturesContractSpecification } from "./contracts.js";

type WorkerInput = {
  filePath: string;
  specification: FuturesContractSpecification;
  fingerprint: string;
};

const input = workerData as WorkerInput;

importHistoricalCsv(input.filePath, input.specification, {
  analyzeCoverage: true,
  aggregations: [5],
  fastParse: true,
  contentFingerprint: input.fingerprint,
  onProgress: (progress: HistoricalCsvProgress) => parentPort?.postMessage({ type: "progress", progress }),
})
  .then((value) => parentPort?.postMessage({
    type: "result",
    ok: true,
    summary: value.summary,
    fingerprint: value.contentFingerprint,
  }))
  .catch((error: unknown) => parentPort?.postMessage({
    type: "result",
    ok: false,
    error: error instanceof Error ? error.message : "Historical CSV indexing failed.",
  }));