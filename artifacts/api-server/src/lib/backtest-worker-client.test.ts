import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  BacktestTimeoutError,
  BacktestWorkerError,
  runBacktestInWorker,
  type BacktestWorkerLike,
} from "./backtest-worker-client.js";
import type { BacktestReport } from "./phase9.js";

class ControlledWorker extends EventEmitter {
  terminated = false;

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

const input = {
  request: { symbol: "MES", endDate: "2026-08-28", inSampleDays: 1, outOfSampleDays: 1 },
};

function workerFactory(worker: ControlledWorker) {
  return () => worker as unknown as BacktestWorkerLike;
}

test("terminates a CPU-bound worker at the deadline and ignores late results", async () => {
  const worker = new ControlledWorker();
  const result = runBacktestInWorker(input, 10, workerFactory(worker));
  await assert.rejects(result, BacktestTimeoutError);
  assert.equal(worker.terminated, true);
  worker.emit("message", { type: "result", report: {} as BacktestReport });
  assert.equal(worker.terminated, true);
});

test("successful worker results resolve without a second execution", async () => {
  const worker = new ControlledWorker();
  const report = { audit: [] } as unknown as BacktestReport;
  const result = runBacktestInWorker(input, 100, workerFactory(worker));
  worker.emit("message", { type: "result", report });
  assert.equal(await result, report);
  assert.equal(worker.terminated, false);
});

test("worker errors and abnormal exits reject with a safe worker error", async () => {
  const errorWorker = new ControlledWorker();
  const errorResult = runBacktestInWorker(input, 100, workerFactory(errorWorker));
  errorWorker.emit("error", new Error("private worker detail"));
  await assert.rejects(errorResult, BacktestWorkerError);

  const exitWorker = new ControlledWorker();
  const exitResult = runBacktestInWorker(input, 100, workerFactory(exitWorker));
  exitWorker.emit("exit", 1);
  await assert.rejects(exitResult, BacktestWorkerError);
});