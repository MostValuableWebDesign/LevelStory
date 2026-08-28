import { Worker } from "node:worker_threads";
import type { BacktestRequest, BacktestReport, CausalReplayDataset } from "./phase9.js";

export class BacktestTimeoutError extends Error {
  constructor() {
    super("BACKTEST_TIMEOUT");
    this.name = "BacktestTimeoutError";
  }
}

export class BacktestRequestAbortedError extends Error {
  constructor() {
    super("BACKTEST_REQUEST_ABORTED");
    this.name = "BacktestRequestAbortedError";
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

export type BacktestWorkerOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  onTiming?: (timing: { workerStartupMs: number }) => void;
};

const workerUrl = new URL("./lib/backtest-worker.mjs", import.meta.url);

const defaultWorkerFactory: BacktestWorkerFactory = (input) =>
  new Worker(workerUrl, { workerData: input }) as unknown as BacktestWorkerLike;

export function runBacktestInWorker(
  input: BacktestWorkerInput,
  timeoutOrOptions: number | BacktestWorkerOptions,
  workerFactory: BacktestWorkerFactory = defaultWorkerFactory,
): Promise<BacktestReport> {
  const options = typeof timeoutOrOptions === "number"
    ? { timeoutMs: timeoutOrOptions }
    : timeoutOrOptions;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: BacktestWorkerLike | undefined;
    let workerCreatedAt: number | undefined;
    const signal = options.signal;
    let onAbort = (): void => {};

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const finishAfterTermination = async (error: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await worker?.terminate();
      } catch {
        // Preserve the original safe timeout/abort outcome if termination itself fails.
      }
      reject(error);
    };

    onAbort = (): void => {
      const reason = signal?.reason;
      void finishAfterTermination(
        reason instanceof BacktestTimeoutError
          ? reason
          : new BacktestRequestAbortedError(),
      );
    };

    if (signal?.aborted) {
      void finishAfterTermination(
        signal.reason instanceof BacktestTimeoutError
          ? signal.reason
          : new BacktestRequestAbortedError(),
      );
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      void finishAfterTermination(new BacktestTimeoutError());
    }, Math.max(0, options.timeoutMs));

    try {
      if (settled) return;
      workerCreatedAt = Date.now();
      worker = workerFactory(input);
      options.onTiming?.({ workerStartupMs: Date.now() - workerCreatedAt });
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