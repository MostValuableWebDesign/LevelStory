import { Worker } from "node:worker_threads";
import type { BacktestRequest, BacktestReport, CausalReplayDataset } from "./phase9.js";

export class BacktestTimeoutError extends Error {
  constructor() {
    super("BACKTEST_TIMEOUT");
    this.name = "BacktestTimeoutError";
  }
}

export class BacktestWorkerError extends Error {
  constructor() {
    super("BACKTEST_WORKER_FAILED");
    this.name = "BacktestWorkerError";
  }
}

export type BacktestWorkerInput = {
  request: BacktestRequest;
  risk?: { accountSize: number; riskPercent: number; maxDailyLoss: number; dailyLossUsed: number; isLocked: boolean };
  replayDataset?: CausalReplayDataset;
};

type WorkerMessage =
  | { type: "result"; report: BacktestReport }
  | { type: "error"; message: string };

export type BacktestWorkerLike = {
  once(event: "message", listener: (message: WorkerMessage) => void): BacktestWorkerLike;
  once(event: "error", listener: (error: Error) => void): BacktestWorkerLike;
  once(event: "exit", listener: (code: number) => void): BacktestWorkerLike;
  terminate(): Promise<number>;
};

export type BacktestWorkerFactory = (input: BacktestWorkerInput) => BacktestWorkerLike;

const workerUrl = new URL("./lib/backtest-worker.mjs", import.meta.url);

const defaultWorkerFactory: BacktestWorkerFactory = (input) =>
  new Worker(workerUrl, { workerData: input }) as unknown as BacktestWorkerLike;

export function runBacktestInWorker(
  input: BacktestWorkerInput,
  timeoutMs: number,
  workerFactory: BacktestWorkerFactory = defaultWorkerFactory,
): Promise<BacktestReport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: BacktestWorkerLike | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    timer = setTimeout(() => {
      finish(() => {
        void worker?.terminate();
        reject(new BacktestTimeoutError());
      });
    }, timeoutMs);

    try {
      worker = workerFactory(input);
      worker.once("message", (message) => {
        if (message.type === "result") {
          finish(() => resolve(message.report));
        } else {
          finish(() => reject(new BacktestWorkerError()));
        }
      });
      worker.once("error", () => {
        finish(() => reject(new BacktestWorkerError()));
      });
      worker.once("exit", (code) => {
        if (code !== 0) finish(() => reject(new BacktestWorkerError()));
        else if (!settled) finish(() => reject(new BacktestWorkerError()));
      });
    } catch {
      finish(() => reject(new BacktestWorkerError()));
    }
  });
}