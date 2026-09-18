import { asc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  db,
  sessionAnalysisResultsTable,
} from "@workspace/db";
import { buildVersionedAnalysisCacheKey } from "./analysis-cache.js";
import type { BacktestReport } from "./phase9.js";
import type {
  SessionResultCacheDescriptor,
} from "./batch-backtest.js";

export const SESSION_ANALYSIS_RESULT_SCHEMA_VERSION = "session-analysis-result-v1";
export const SESSION_ANALYSIS_RESULT_RETENTION_MS = 180 * 24 * 60 * 60_000;
export const SESSION_ANALYSIS_RESULT_MAX_ROWS = 10_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function isBacktestReport(value: unknown): value is BacktestReport {
  if (!isRecord(value)) return false;
  return typeof value.symbol === "string"
    && typeof value.formulaHash === "string"
    && typeof value.executionMode === "string"
    && isRecord(value.dataset)
    && Array.isArray(value.audit)
    && Array.isArray(value.trades)
    && Array.isArray(value.tradeCandidates)
    && Array.isArray(value.occurrences)
    && isRecord(value.executionSummary);
}

function validDescriptor(descriptor: SessionResultCacheDescriptor): boolean {
  return descriptor.cacheKey === buildVersionedAnalysisCacheKey(
    "cataloged-session-strategy-result",
    descriptor.dependencyIdentity,
  );
}

function staleBefore(now = Date.now()): Date {
  return new Date(now - SESSION_ANALYSIS_RESULT_RETENTION_MS);
}

export type SessionAnalysisStoreStats = {
  persisted: number;
  memoryPending: number;
};

export type PersistentSessionCacheResolution = "persistent_hit" | "computed";

export class PersistentSessionAnalysisStore {
  private readonly pending = new Map<string, Promise<BacktestReport>>();

  async get(cacheKey: string, descriptor: SessionResultCacheDescriptor): Promise<BacktestReport | null> {
    if (!validDescriptor(descriptor)) return null;
    const [row] = await db.select().from(sessionAnalysisResultsTable)
      .where(eq(sessionAnalysisResultsTable.cacheKey, cacheKey))
      .limit(1);
    if (!row
      || row.cacheKeyVersion !== descriptor.cacheKeyVersion
      || row.resultSchemaVersion !== SESSION_ANALYSIS_RESULT_SCHEMA_VERSION
      || row.sourceFingerprint !== descriptor.sourceFingerprint
      || row.lookbackFingerprint !== descriptor.lookbackFingerprint
      || row.formulaVersion !== descriptor.formulaVersion
      || row.formulaHash !== descriptor.formulaHash
      || stableSerialize(row.dependencyIdentity) !== stableSerialize(descriptor.dependencyIdentity)
      || !isBacktestReport(row.resultPayload)) {
      return null;
    }
    await db.update(sessionAnalysisResultsTable)
      .set({ lastAccessedAt: new Date() })
      .where(eq(sessionAnalysisResultsTable.cacheKey, cacheKey));
    return structuredClone(row.resultPayload);
  }

  async getOrCompute(
    descriptor: SessionResultCacheDescriptor,
    compute: () => Promise<BacktestReport>,
    onResolution?: (resolution: PersistentSessionCacheResolution) => void,
  ): Promise<BacktestReport> {
    if (!validDescriptor(descriptor)) {
      throw new Error("SESSION_ANALYSIS_CACHE_IDENTITY_INVALID");
    }
    const existingPending = this.pending.get(descriptor.cacheKey);
    if (existingPending) return existingPending;

    const computation = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${descriptor.cacheKey}))`);
      const [stored] = await tx.select().from(sessionAnalysisResultsTable)
        .where(eq(sessionAnalysisResultsTable.cacheKey, descriptor.cacheKey))
        .limit(1);
      if (stored
        && stored.cacheKeyVersion === descriptor.cacheKeyVersion
        && stored.resultSchemaVersion === SESSION_ANALYSIS_RESULT_SCHEMA_VERSION
        && stored.sourceFingerprint === descriptor.sourceFingerprint
        && stored.lookbackFingerprint === descriptor.lookbackFingerprint
        && stored.formulaVersion === descriptor.formulaVersion
        && stored.formulaHash === descriptor.formulaHash
        && stableSerialize(stored.dependencyIdentity) === stableSerialize(descriptor.dependencyIdentity)
        && isBacktestReport(stored.resultPayload)) {
        onResolution?.("persistent_hit");
        await tx.update(sessionAnalysisResultsTable)
          .set({ lastAccessedAt: new Date() })
          .where(eq(sessionAnalysisResultsTable.cacheKey, descriptor.cacheKey));
        return structuredClone(stored.resultPayload);
      }

      onResolution?.("computed");
      const result = await compute();
      if (!isBacktestReport(result)) {
        throw new Error("SESSION_ANALYSIS_RESULT_SCHEMA_INVALID");
      }
      const now = new Date();
      await tx.insert(sessionAnalysisResultsTable).values({
        cacheKey: descriptor.cacheKey,
        cacheKeyVersion: descriptor.cacheKeyVersion,
        resultSchemaVersion: SESSION_ANALYSIS_RESULT_SCHEMA_VERSION,
        sourceFingerprint: descriptor.sourceFingerprint,
        lookbackFingerprint: descriptor.lookbackFingerprint,
        strategyIdentity: descriptor.strategyIdentity,
        formulaVersion: descriptor.formulaVersion,
        formulaHash: descriptor.formulaHash,
        executionSettings: descriptor.executionSettings,
        initialState: descriptor.initialState,
        dependencyIdentity: descriptor.dependencyIdentity,
        resultPayload: result,
        createdAt: now,
        lastAccessedAt: now,
      }).onConflictDoUpdate({
        target: sessionAnalysisResultsTable.cacheKey,
        set: {
          cacheKeyVersion: descriptor.cacheKeyVersion,
          resultSchemaVersion: SESSION_ANALYSIS_RESULT_SCHEMA_VERSION,
          sourceFingerprint: descriptor.sourceFingerprint,
          lookbackFingerprint: descriptor.lookbackFingerprint,
          strategyIdentity: descriptor.strategyIdentity,
          formulaVersion: descriptor.formulaVersion,
          formulaHash: descriptor.formulaHash,
          executionSettings: descriptor.executionSettings,
          initialState: descriptor.initialState,
          dependencyIdentity: descriptor.dependencyIdentity,
          resultPayload: result,
          lastAccessedAt: now,
        },
      });
      await this.cleanup(tx, now);
      return structuredClone(result);
    });
    this.pending.set(descriptor.cacheKey, computation);
    try {
      return await computation;
    } finally {
      if (this.pending.get(descriptor.cacheKey) === computation) this.pending.delete(descriptor.cacheKey);
    }
  }

  async cleanup(executor: any = db, now = new Date()): Promise<void> {
    const oldBefore = new Date(now.getTime() - SESSION_ANALYSIS_RESULT_RETENTION_MS);
    await executor.delete(sessionAnalysisResultsTable)
      .where(lt(sessionAnalysisResultsTable.lastAccessedAt, oldBefore));
    const rows: Array<{ cacheKey: string }> = await executor.select({
      cacheKey: sessionAnalysisResultsTable.cacheKey,
    }).from(sessionAnalysisResultsTable)
      .orderBy(asc(sessionAnalysisResultsTable.lastAccessedAt), asc(sessionAnalysisResultsTable.createdAt));
    if (rows.length <= SESSION_ANALYSIS_RESULT_MAX_ROWS) return;
    const excess = rows.slice(0, rows.length - SESSION_ANALYSIS_RESULT_MAX_ROWS).map((row) => row.cacheKey);
    if (excess.length) {
      await executor.delete(sessionAnalysisResultsTable)
        .where(inArray(sessionAnalysisResultsTable.cacheKey, excess));
    }
  }

  async getStats(): Promise<SessionAnalysisStoreStats> {
    const rows = await db.select({ cacheKey: sessionAnalysisResultsTable.cacheKey })
      .from(sessionAnalysisResultsTable);
    return { persisted: rows.length, memoryPending: this.pending.size };
  }

  clearPending(): void {
    this.pending.clear();
  }
}

export const persistentSessionAnalysisStore = new PersistentSessionAnalysisStore();