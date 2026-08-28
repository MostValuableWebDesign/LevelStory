import { parentPort, workerData } from "node:worker_threads";
import { importHistoricalCsv } from "./historical-csv-import.js";
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
})
  .then((value) => parentPort?.postMessage({ ok: true, value }))
  .catch((error: unknown) => parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "Historical CSV indexing failed.",
  }));