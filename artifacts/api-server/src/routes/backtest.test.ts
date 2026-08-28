import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import express, { type Express } from "express";
import test from "node:test";
import {
  runBacktestInWorker,
  type BacktestWorkerInput,
  type BacktestWorkerLike,
  type BacktestWorkerOptions,
} from "../lib/backtest-worker-client.js";
import {
  runCausalBacktest,
  type BacktestReport,
} from "../lib/phase9.js";
import { createBacktestRouter } from "./backtest.js";

type TestWorkerMode = "timeout" | "success" | "error" | "exit";

class ControlledWorker extends EventEmitter {
  terminated = false;

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

type TestWorkerRunner = ReturnType<typeof createTestWorkerRunner>;

function createTestWorkerRunner(initialMode: TestWorkerMode) {
  let mode = initialMode;
  let callCount = 0;
  const workers: ControlledWorker[] = [];
  const run = (
    input: BacktestWorkerInput,
    options: BacktestWorkerOptions,
  ): Promise<BacktestReport> => {
    callCount += 1;
    const worker = new ControlledWorker();
    workers.push(worker);
    const result = runBacktestInWorker(
      input as never,
      options,
      () => worker as unknown as BacktestWorkerLike,
    );
    if (mode === "success") {
      setImmediate(() => {
        worker.emit("message", {
          type: "result",
          report: runCausalBacktest(input.request, input.risk, input.replayDataset),
        });
      });
    } else if (mode === "error") {
      setImmediate(() => worker.emit("error", new Error("private worker detail")));
    } else if (mode === "exit") {
      setImmediate(() => worker.emit("exit", 1));
    }
    return result;
  };
  return {
    run,
    workers,
    get callCount() {
      return callCount;
    },
    setMode(nextMode: TestWorkerMode) {
      mode = nextMode;
    },
  };
}

async function startTestServer(
  runner: TestWorkerRunner,
  options: { requestTimeoutMs: number; workerDeadlineMs: number },
): Promise<{ server: Server; port: number }> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createBacktestRouter({
    ...options,
    loadRisk: async () => undefined,
    runBacktest: runner.run,
  }));
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");
  return { server, port: address.port };
}

function backtestBody(seed: number) {
  return {
    symbol: "MES",
    endDate: "2026-08-28",
    inSampleDays: 1,
    outOfSampleDays: 1,
    seed,
    source: "simulated" as const,
    executionMode: "quote_based_shadow" as const,
  };
}

async function postBacktest(
  port: number,
  body: ReturnType<typeof backtestBody>,
): Promise<{ statusCode: number; responseCount: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    let responseCount = 0;
    const request = httpRequest({
      port,
      path: "/api/backtest",
      method: "POST",
      headers: { "content-type": "application/json" },
    }, (response) => {
      responseCount += 1;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode ?? 0,
            responseCount,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function disconnectBacktest(
  port: number,
  body: ReturnType<typeof backtestBody>,
  started: () => boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let abortTimer: NodeJS.Timeout | undefined;
    let fallbackTimer: NodeJS.Timeout | undefined;
    let destroyed = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (abortTimer) clearInterval(abortTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (error) reject(error);
      else resolve();
    };
    const request = httpRequest({
      port,
      path: "/api/backtest",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET" || error.code === "ERR_STREAM_PREMATURE_CLOSE") {
        finish();
      } else {
        finish(error);
      }
    });
    request.end(JSON.stringify(body));
    abortTimer = setInterval(() => {
      if (!started()) return;
      clearInterval(abortTimer);
      destroyed = true;
      request.destroy();
      finish();
    }, 1);
    fallbackTimer = setTimeout(() => {
      if (destroyed) return;
      destroyed = true;
      request.destroy();
      finish(new Error("Test request did not reach the worker."));
    }, 1_000);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("forced route timeout writes one 408, terminates both workers, and recovers capacity", async () => {
  const runner = createTestWorkerRunner("timeout");
  const { server, port } = await startTestServer(runner, {
    requestTimeoutMs: 80,
    workerDeadlineMs: 20,
  });
  try {
    const body = backtestBody(9001);
    const [first, second] = await Promise.all([
      postBacktest(port, body),
      postBacktest(port, { ...body, seed: 9002 }),
    ]);
    assert.equal(first.statusCode, 408);
    assert.equal(second.statusCode, 408);
    assert.equal(first.responseCount, 1);
    assert.equal(second.responseCount, 1);
    assert.equal(first.body.error, "Backtest timed out. Reduce the historical range and try again.");
    assert.equal(runner.workers.length, 2);
    assert.equal(runner.workers.every((worker) => worker.terminated), true);

    runner.setMode("success");
    const recovered = await postBacktest(port, body);
    assert.equal(recovered.statusCode, 200);
    assert.equal(runner.callCount, 3);
  } finally {
    await closeServer(server);
  }
});

test("client disconnect terminates workers and releases both active slots", async () => {
  const runner = createTestWorkerRunner("timeout");
  const { server, port } = await startTestServer(runner, {
    requestTimeoutMs: 500,
    workerDeadlineMs: 400,
  });
  try {
    await Promise.all([
      disconnectBacktest(port, backtestBody(9011), () => runner.workers.length >= 1),
      disconnectBacktest(port, backtestBody(9012), () => runner.workers.length >= 2),
    ]);
    for (let attempt = 0; attempt < 20 && runner.workers.some((worker) => !worker.terminated); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(runner.workers.length, 2);
    assert.equal(runner.workers.every((worker) => worker.terminated), true);

    runner.setMode("success");
    const recovered = await postBacktest(port, backtestBody(9011));
    assert.equal(recovered.statusCode, 200);
    assert.equal(runner.callCount, 3);
  } finally {
    await closeServer(server);
  }
});

test("worker failure and abnormal exit return one safe 500 response each", async () => {
  const runner = createTestWorkerRunner("error");
  const { server, port } = await startTestServer(runner, {
    requestTimeoutMs: 500,
    workerDeadlineMs: 400,
  });
  try {
    const body = backtestBody(9021);
    const failed = await postBacktest(port, body);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.responseCount, 1);
    assert.equal(failed.body.error, "Unable to run the causal backtest with the supplied constraints.");

    runner.setMode("exit");
    const exited = await postBacktest(port, { ...body, seed: 9022 });
    assert.equal(exited.statusCode, 500);
    assert.equal(exited.responseCount, 1);
    assert.equal(exited.body.error, "Unable to run the causal backtest with the supplied constraints.");
  } finally {
    await closeServer(server);
  }
});

test("successful result is cached only after completion and reuses its run ID", async () => {
  const runner = createTestWorkerRunner("success");
  const { server, port } = await startTestServer(runner, {
    requestTimeoutMs: 500,
    workerDeadlineMs: 400,
  });
  try {
    const body = backtestBody(9023);
    const firstSuccess = await postBacktest(port, body);
    const cachedSuccess = await postBacktest(port, body);
    assert.equal(firstSuccess.statusCode, 200);
    assert.equal(cachedSuccess.statusCode, 200);
    assert.equal(firstSuccess.responseCount, 1);
    assert.equal(cachedSuccess.responseCount, 1);
    assert.equal(firstSuccess.body.auditPage && typeof firstSuccess.body.auditPage === "object", true);
    assert.deepEqual(
      (firstSuccess.body.auditPage as { runId: string }).runId,
      (cachedSuccess.body.auditPage as { runId: string }).runId,
    );
    assert.equal(runner.callCount, 1);
  } finally {
    await closeServer(server);
  }
});

test("successful route result matches the direct deterministic engine", async () => {
  const runner = createTestWorkerRunner("success");
  const { server, port } = await startTestServer(runner, {
    requestTimeoutMs: 500,
    workerDeadlineMs: 400,
  });
  try {
    const body = backtestBody(9031);
    const response = await postBacktest(port, body);
    const direct = runCausalBacktest({
      ...body,
      premarketAvailable: true,
      targetDollars: 75,
      slippageMode: "normal",
      ohlcvEntryBufferTicks: 4,
      ohlcvStopBufferTicks: 1,
      ohlcvSlippageTicks: 1,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.metrics, direct.metrics);
    assert.equal(runner.callCount, 1);
  } finally {
    await closeServer(server);
  }
});