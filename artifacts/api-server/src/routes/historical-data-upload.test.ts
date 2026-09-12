import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import express from "express";
import test from "node:test";
import router from "./historical-data-upload.js";

async function startServer(authenticated: boolean): Promise<{ server: Server; port: number }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).isAuthenticated = () => authenticated;
    if (authenticated) req.user = { id: "historical-test-user" } as never;
    next();
  });
  app.use("/api", router);
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");
  return { server, port: address.port };
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      port,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (response) => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { content += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(content) }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("rejects unauthenticated historical upload requests", async () => {
  const { server, port } = await startServer(false);
  try {
    const result = await post(port, "/api/historical-data/uploads/request-url", {
      originalFilename: "glbx-mdp3.ohlcv-1m.MESU5.csv.zst",
      mimeType: "application/zstd",
      sizeBytes: 10,
    });
    assert.equal(result.status, 401);
  } finally {
    server.close();
  }
});

test("accepts an import as a background job without waiting for materialization", async () => {
  const { server, port } = await startServer(true);
  try {
    const started = Date.now();
    const result = await post(port, "/api/historical-data/import", {
      files: [{
        objectPath: "/objects/uploads/historical/not-a-real-object",
        originalFilename: "glbx-mdp3.ohlcv-1m.MESU5.csv.zst",
      }],
    });
    assert.equal(result.status, 202);
    assert.match(result.body.jobId, /^hist_/);
    assert.ok(["queued", "materializing"].includes(result.body.state));
    assert.equal(result.body.requestedFileCount, 1);
    assert.ok(Date.now() - started < 1000);
  } finally {
    server.close();
  }
});