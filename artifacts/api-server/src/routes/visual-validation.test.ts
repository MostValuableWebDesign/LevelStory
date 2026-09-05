import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import test from "node:test";
import { createVisualValidationRouter } from "./visual-validation.js";
import { storeVisualValidationSet } from "../lib/visual-validation-store.js";
import type { VisualValidationSet } from "../lib/visual-validation.js";

function candidate(id: string, date: string) {
  return {
    candidateId: id,
    snapshotId: `snapshot-${id}`,
    signalOccurrenceId: `occurrence-${id}`,
    contractSymbol: "MESU26",
    tradingDate: date,
    entryCandleOpenTime: `${date}T13:30:00.000Z`,
    entryCandleCloseTime: `${date}T13:35:00.000Z`,
    direction: "long" as const,
    entryTriggerPrice: 100,
    primaryEdge: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
    matchedEdges: ["ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION"],
    supportingConfluences: [],
    setupGrade: "A" as const,
    period: "in_sample" as const,
    outcome: "target" as const,
    causalEvidence: [],
  };
}

function trade(id: string, candidateId: string, occurrenceId: string, date: string, entryTime: string, netPnl: number) {
  return {
    id,
    tradingDate: date,
    contractSymbol: "MESU26",
    contractMonth: "2026-09",
    period: "in_sample" as const,
    setupType: "ORB_BREAK_PULLBACK_CONTINUATION",
    direction: "long" as const,
    entryTime,
    exitTime: `${date}T14:00:00.000Z`,
    entryPrice: 100,
    exitPrice: 105,
    contracts: 1,
    grossPnl: netPnl,
    fees: 0,
    slippage: 0,
    netPnl,
    outcome: netPnl >= 0 ? "target" : "strategy stop",
    ambiguityLabel: null,
    source: "tick",
    segmentation: {},
    candidateId,
    signalOccurrenceId: occurrenceId,
  };
}

async function getJson(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ port, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

test("replay route returns every authoritative report trade across dates", async () => {
  const first = candidate("route-first", "2026-08-25");
  const second = candidate("route-second", "2026-08-26");
  const firstTrade = trade("route-trade-first", first.candidateId, first.signalOccurrenceId, first.tradingDate, "2026-08-25T13:35:00.000Z", 100);
  const secondTrade = trade("route-trade-second", second.candidateId, second.signalOccurrenceId, second.tradingDate, "2026-08-26T13:35:00.000Z", -50);
  const set = storeVisualValidationSet({
    reviewSetId: undefined,
    createdAt: undefined,
    buildId: "route-test",
    currentBuildId: "route-test",
    stale: false,
    cacheKey: "route-test-cache",
    cacheKeyVersion: "route-test",
    strategyVersion: "route-test",
    formulaHash: "route-test",
    formulaVersion: "route-test",
    sourceFingerprint: "route-test",
    generationOrigin: "fresh",
    candidateProjectionVersion: "route-test",
    executionManagementVersion: "route-test",
    snapshotProjectionVersion: "route-test",
    chartProjectionVersion: "route-test",
    sessionCalendarVersion: "route-test",
    source: "historical_databento",
    symbol: "MES",
    request: {
      symbol: "MES",
      endDate: "2026-08-26",
      inSampleDays: 2,
      outOfSampleDays: 0,
      premarketAvailable: true,
      source: "historical_databento",
      reviewMode: "trades_only",
    },
    reviewPeriod: {
      endDate: "2026-08-26",
      inSampleDates: ["2026-08-25", "2026-08-26"],
      outOfSampleDates: [],
      selectedDates: ["2026-08-25", "2026-08-26"],
    },
    processedDates: ["2026-08-25", "2026-08-26"],
    snapshots: [],
    tradeCandidates: [first, second],
    accountReplayTrades: [
      { candidate: first, snapshotId: null, trade: firstTrade },
      { candidate: second, snapshotId: null, trade: secondTrade },
    ],
    categoryCoverage: [],
    defaultSelectionReason: "route test",
  } as unknown as Omit<VisualValidationSet, "reviewSetId" | "createdAt">);

  const app = express();
  app.use("/api", createVisualValidationRouter());
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");

  try {
    const response = await getJson(address.port, `/api/backtest/visual-validation/replay?reviewSetId=${set.reviewSetId}&startingBalance=10000&contractsPerTrade=1`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.processedDates, ["2026-08-25", "2026-08-26"]);
    assert.equal(response.body.enteredTrades, 2);
    assert.equal((response.body.ledger as unknown[]).length, 2);
    assert.equal(response.body.endingRealizedBalance, 10050);
    const invalidResponse = await getJson(address.port, `/api/backtest/visual-validation/replay?reviewSetId=${set.reviewSetId}&startingBalance=10000&contractsPerTrade=3`);
    assert.equal(invalidResponse.status, 400);
    assert.match(String(invalidResponse.body.error), /less than or equal to 2|exactly 1 or 2/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});