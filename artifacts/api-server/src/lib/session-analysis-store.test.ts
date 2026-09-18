import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  sessionAnalysisResultsTable,
} from "@workspace/db";
import {
  buildVersionedAnalysisCacheKey,
} from "./analysis-cache.js";
import {
  PersistentSessionAnalysisStore,
  SESSION_ANALYSIS_RESULT_SCHEMA_VERSION,
} from "./session-analysis-store.js";
import type { SessionResultCacheDescriptor } from "./batch-backtest.js";
import type { BacktestReport } from "./phase9.js";

function descriptor(suffix = randomUUID(), formulaHash = "formula-a"): SessionResultCacheDescriptor {
  const dependencyIdentity = {
    cacheKeyVersion: `test-session-${suffix}`,
    session: {
      tradingDate: "2026-08-26",
      contractSymbol: "MESU6",
      partitionIdentity: `partition-${suffix}`,
      sourceFingerprint: `source-${suffix}`,
      datasetFingerprint: `dataset-${suffix}`,
      timeframe: [1, 5],
    },
    strategy: {
      strategyKey: "test-strategy",
      formulaVersion: "formula-v1",
      formulaHash,
      configFingerprint: `config-${suffix}`,
    },
    request: {
      executionMode: "ohlcv_modeled",
      visualReviewMode: "trades_only",
    },
    risk: { startingBalance: 100_000 },
    source: {
      source: "historical_databento_multicontract",
      contentFingerprint: `source-${suffix}`,
      lookbackFingerprint: `lookback-${suffix}`,
    },
    initialState: {
      accountPosition: "flat-for-session-analysis",
      combinedReplay: "chronological-selected-dates",
    },
  };
  return {
    cacheKey: buildVersionedAnalysisCacheKey("cataloged-session-strategy-result", dependencyIdentity),
    cacheKeyVersion: dependencyIdentity.cacheKeyVersion,
    sourceFingerprint: `source-${suffix}`,
    lookbackFingerprint: `lookback-${suffix}`,
    strategyIdentity: dependencyIdentity.strategy,
    formulaVersion: "formula-v1",
    formulaHash,
    executionSettings: { request: dependencyIdentity.request, risk: dependencyIdentity.risk },
    initialState: dependencyIdentity.initialState,
    dependencyIdentity,
  };
}

function result(trades: BacktestReport["trades"] = []): BacktestReport {
  return {
    symbol: "MES",
    formulaHash: "formula",
    executionMode: "ohlcv_modeled",
    dataset: {},
    audit: [],
    trades,
    tradeCandidates: [],
    occurrences: [],
    executionSummary: {},
  } as unknown as BacktestReport;
}

async function deleteResult(cacheKey: string): Promise<void> {
  await db.delete(sessionAnalysisResultsTable)
    .where(eq(sessionAnalysisResultsTable.cacheKey, cacheKey));
}

test("completed zero-trade result survives a separate process restart", async () => {
  const store = new PersistentSessionAnalysisStore();
  const identity = descriptor();
  const completed = result([]);
  await deleteResult(identity.cacheKey);
  try {
    let executions = 0;
    const saved = await store.getOrCompute(identity, async () => {
      executions += 1;
      return completed;
    });
    assert.equal(executions, 1);
    assert.equal(saved.trades.length, 0);

    const storeModule = pathToFileURL(resolve(process.cwd(), "../artifacts/api-server/src/lib/session-analysis-store.ts")).href;
    const script = `
      import { persistentSessionAnalysisStore } from "${storeModule}";
      (async () => {
        const descriptor = JSON.parse(Buffer.from(process.env.SESSION_DESCRIPTOR_B64, "base64").toString("utf8"));
        const result = await persistentSessionAnalysisStore.get(descriptor.cacheKey, descriptor);
        if (!result || !Array.isArray(result.trades) || result.trades.length !== 0) process.exit(2);
        console.log("persisted-zero-trade-hit");
      })().catch((error) => { console.error(error); process.exit(1); });
    `;
    const child = spawnSync("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", script], {
      cwd: resolve(process.cwd(), ".."),
      env: {
        ...process.env,
        SESSION_DESCRIPTOR_B64: Buffer.from(JSON.stringify(identity)).toString("base64"),
      },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /persisted-zero-trade-hit/);
  } finally {
    await deleteResult(identity.cacheKey);
  }
});

test("formula/configuration identity changes prevent persisted reuse", async () => {
  const store = new PersistentSessionAnalysisStore();
  const suffix = randomUUID();
  const identity = descriptor(suffix);
  await deleteResult(identity.cacheKey);
  try {
    await store.getOrCompute(identity, async () => result());
    const changed = descriptor(suffix, "formula-b");
    assert.notEqual(changed.cacheKey, identity.cacheKey);
    assert.equal(await store.get(changed.cacheKey, changed), null);
  } finally {
    await deleteResult(identity.cacheKey);
  }
});

test("persisted results with an older schema version are not reusable", async () => {
  const store = new PersistentSessionAnalysisStore();
  const identity = descriptor(randomUUID());
  await deleteResult(identity.cacheKey);
  try {
    await store.getOrCompute(identity, async () => result());
    await db.update(sessionAnalysisResultsTable)
      .set({ resultSchemaVersion: "session-analysis-result-legacy" })
      .where(eq(sessionAnalysisResultsTable.cacheKey, identity.cacheKey));
    assert.equal(await store.get(identity.cacheKey, identity), null);
  } finally {
    await deleteResult(identity.cacheKey);
  }
});

test("corrupt and interrupted persistent artifacts never become complete hits", async () => {
  const store = new PersistentSessionAnalysisStore();
  const identity = descriptor();
  await deleteResult(identity.cacheKey);
  try {
    await assert.rejects(store.getOrCompute(identity, async () => {
      throw new Error("interrupted");
    }), /interrupted/);
    assert.equal(await store.get(identity.cacheKey, identity), null);

    await store.getOrCompute(identity, async () => result());
    await db.update(sessionAnalysisResultsTable)
      .set({ resultPayload: { corrupted: true } })
      .where(eq(sessionAnalysisResultsTable.cacheKey, identity.cacheKey));
    assert.equal(await store.get(identity.cacheKey, identity), null);
  } finally {
    await deleteResult(identity.cacheKey);
  }
});

test("equivalent concurrent processes publish one valid session result", async () => {
  const firstStore = new PersistentSessionAnalysisStore();
  const secondStore = new PersistentSessionAnalysisStore();
  const identity = descriptor();
  await deleteResult(identity.cacheKey);
  try {
    let executions = 0;
    const compute = async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return result();
    };
    const [first, second] = await Promise.all([
      firstStore.getOrCompute(identity, compute),
      secondStore.getOrCompute(identity, compute),
    ]);
    assert.equal(executions, 1);
    assert.deepEqual(first.trades, second.trades);
  } finally {
    await deleteResult(identity.cacheKey);
  }
});

test("persistent cleanup removes expired artifacts without deleting current results", async () => {
  const store = new PersistentSessionAnalysisStore();
  const identity = descriptor();
  await deleteResult(identity.cacheKey);
  try {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60_000);
    await db.insert(sessionAnalysisResultsTable).values({
      cacheKey: identity.cacheKey,
      cacheKeyVersion: identity.cacheKeyVersion,
      resultSchemaVersion: SESSION_ANALYSIS_RESULT_SCHEMA_VERSION,
      sourceFingerprint: identity.sourceFingerprint,
      lookbackFingerprint: identity.lookbackFingerprint,
      strategyIdentity: identity.strategyIdentity,
      formulaVersion: identity.formulaVersion,
      formulaHash: identity.formulaHash,
      executionSettings: identity.executionSettings,
      initialState: identity.initialState,
      dependencyIdentity: identity.dependencyIdentity,
      resultPayload: result(),
      createdAt: old,
      lastAccessedAt: old,
    });
    await store.cleanup();
    assert.equal(await store.get(identity.cacheKey, identity), null);
  } finally {
    await deleteResult(identity.cacheKey);
  }
});