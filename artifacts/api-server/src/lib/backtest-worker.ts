import { parentPort, workerData } from "node:worker_threads";
import { runCausalBacktest, type BacktestRequest, type BacktestReport, type CausalReplayDataset } from "./phase9.js";

type BacktestWorkerInput = {
  request: BacktestRequest;
  risk?: { accountSize: number; riskPercent: number; maxDailyLoss: number; dailyLossUsed: number; isLocked: boolean };
  replayDataset?: CausalReplayDataset;
};

if (!parentPort) {
  throw new Error("Backtest worker must be started by a parent thread.");
}

try {
  const input = workerData as BacktestWorkerInput;
  const report = runCausalBacktest(input.request, input.risk, input.replayDataset);
  parentPort.postMessage({ type: "result", report } satisfies { type: "result"; report: BacktestReport });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : "Backtest worker failed.",
  });
} finally {
  parentPort.close();
}