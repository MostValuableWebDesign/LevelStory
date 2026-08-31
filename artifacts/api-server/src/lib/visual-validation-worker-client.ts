import { Worker } from "node:worker_threads";
import type { VisualValidationRequest, VisualValidationSet } from "./visual-validation.js";
import type { CausalReplayProgress } from "./phase9.js";

type WorkerMessage =
  | { type: "result"; set: Omit<VisualValidationSet, "reviewSetId" | "createdAt"> }
  | { type: "progress"; progress: VisualValidationWorkerProgress }
  | { type: "error"; message: string };

export type VisualValidationWorkerPhase =
  | "preparing"
  | "loading_sessions"
  | "replaying_sessions"
  | "building_ledger"
  | "projecting_candidates"
  | "building_snapshots";

export type VisualValidationWorkerProgress = CausalReplayProgress & {
  phase: VisualValidationWorkerPhase;
  completedUnits: number;
  totalUnits: 100;
  message: string;
};

type WorkerLike = {
  once(event: "message", listener: (message: WorkerMessage) => void): WorkerLike;
  once(event: "error", listener: (error: Error) => void): WorkerLike;
  once(event: "exit", listener: (code: number) => void): WorkerLike;
  terminate(): Promise<number>;
};

const workerUrl = new URL("./lib/visual-validation-worker.mjs", import.meta.url);

export class VisualValidationWorkerError extends Error {
  constructor(detail?: string) {
    super(detail ? `VISUAL_VALIDATION_WORKER_FAILED: ${detail}` : "VISUAL_VALIDATION_WORKER_FAILED");
    this.name = "VisualValidationWorkerError";
  }
}

export function buildHistoricalVisualValidationSetInWorker(
  request: VisualValidationRequest,
  timeoutMs: number,
  onProgress?: (progress: VisualValidationWorkerProgress) => void,
): Promise<Omit<VisualValidationSet, "reviewSetId" | "createdAt">> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: WorkerLike | undefined;
    let messageReceived = false;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const failAndTerminate = async (error: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await worker?.terminate();
      } catch {
        // Preserve the worker failure if termination itself fails.
      }
      reject(error);
    };

    timer = setTimeout(() => {
      void failAndTerminate(new VisualValidationWorkerError("Historical replay timed out."));
    }, timeoutMs);

    try {
      worker = new Worker(workerUrl, { workerData: request }) as unknown as WorkerLike;
      worker.once("message", (message) => {
        if (message.type === "result") {
          messageReceived = true;
          finish(() => resolve(message.set));
        } else if (message.type === "progress" && !settled) {
          onProgress?.(message.progress);
        } else if (message.type === "error") {
          messageReceived = true;
          finish(() => reject(new VisualValidationWorkerError(message.message)));
        }
      });
      worker.once("error", (error) => {
        finish(() => reject(new VisualValidationWorkerError(error.message)));
      });
      worker.once("exit", (code) => {
        if (code !== 0) finish(() => reject(new VisualValidationWorkerError(`Worker exited with code ${code}.`)));
        else if (!settled) {
          setTimeout(() => {
            if (!settled && !messageReceived) finish(() => reject(new VisualValidationWorkerError()));
          }, 25);
        }
      });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new VisualValidationWorkerError()));
    }
  });
}