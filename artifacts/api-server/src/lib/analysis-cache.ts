import { createHash } from "node:crypto";

export const CAUSAL_FEATURE_CACHE_KEY_VERSION = "causal-features-cache-v1";
export const STRATEGY_RESULT_CACHE_KEY_VERSION = "strategy-result-cache-v6-stale-superseded-snapshot-filter";
export const BATCH_AGGREGATION_CACHE_KEY_VERSION = "batch-aggregation-v2-filtered-canonical-evidence";
export const LIFECYCLE_RECONCILIATION_VERSION = "pullback-lifecycle-v2-preserved-transition-history";

export type AnalysisCacheStatus = "complete" | "incomplete" | "failed";
export type AnalysisCacheResolution = "memory_hit" | "pending_reuse" | "computed";

export type AnalysisCacheRecord<T> = {
  cacheKey: string;
  status: AnalysisCacheStatus;
  value?: T;
  error?: string;
  createdAt: number;
  lastAccessedAt: number;
};

type StoredRecord<T> = AnalysisCacheRecord<T>;

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function buildVersionedAnalysisCacheKey(
  domain: string,
  dependencies: Record<string, unknown>,
): string {
  return createHash("sha256").update(stableSerialize({
    domain,
    ...dependencies,
  })).digest("hex");
}

export type VersionedAnalysisCacheOptions = {
  maxEntries?: number;
  ttlMs?: number;
};

export class VersionedAnalysisCache<T> {
  private readonly records = new Map<string, StoredRecord<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: VersionedAnalysisCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 64));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? 30 * 60_000));
  }

  private prune(now = Date.now()): void {
    for (const [key, record] of this.records) {
      if (now - record.lastAccessedAt > this.ttlMs) this.records.delete(key);
    }
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }

  getRecord(cacheKey: string): AnalysisCacheRecord<T> | null {
    const record = this.records.get(cacheKey);
    if (!record) return null;
    const now = Date.now();
    if (now - record.lastAccessedAt > this.ttlMs) {
      this.records.delete(cacheKey);
      return null;
    }
    record.lastAccessedAt = now;
    this.records.delete(cacheKey);
    this.records.set(cacheKey, record);
    return record;
  }

  get(cacheKey: string): T | null {
    const record = this.getRecord(cacheKey);
    return record?.status === "complete" && record.value !== undefined ? record.value : null;
  }

  setComplete(cacheKey: string, value: T): void {
    const now = Date.now();
    this.records.delete(cacheKey);
    this.records.set(cacheKey, {
      cacheKey,
      status: "complete",
      value,
      createdAt: now,
      lastAccessedAt: now,
    });
    this.prune(now);
  }

  setIncomplete(cacheKey: string, error?: string): void {
    this.setNonComplete(cacheKey, "incomplete", error);
  }

  setFailed(cacheKey: string, error?: string): void {
    this.setNonComplete(cacheKey, "failed", error);
  }

  private setNonComplete(cacheKey: string, status: Exclude<AnalysisCacheStatus, "complete">, error?: string): void {
    const now = Date.now();
    this.records.delete(cacheKey);
    this.records.set(cacheKey, {
      cacheKey,
      status,
      ...(error ? { error } : {}),
      createdAt: now,
      lastAccessedAt: now,
    });
    this.prune(now);
  }

  async getOrCompute(
    cacheKey: string,
    compute: () => Promise<T>,
    onResolution?: (resolution: AnalysisCacheResolution) => void,
  ): Promise<T> {
    const cached = this.get(cacheKey);
    if (cached !== null) {
      onResolution?.("memory_hit");
      return cached;
    }
    const pending = this.pending.get(cacheKey);
    if (pending) {
      onResolution?.("pending_reuse");
      return pending;
    }
    onResolution?.("computed");
    const computation = Promise.resolve()
      .then(compute)
      .then((value) => {
        this.setComplete(cacheKey, value);
        return value;
      })
      .catch((error: unknown) => {
        this.setFailed(cacheKey, error instanceof Error ? error.message : "Analysis computation failed.");
        throw error;
      });
    this.pending.set(cacheKey, computation);
    try {
      return await computation;
    } finally {
      if (this.pending.get(cacheKey) === computation) this.pending.delete(cacheKey);
    }
  }

  clear(): void {
    this.records.clear();
    this.pending.clear();
  }

  getStats(): { entries: number; pending: number } {
    this.prune();
    return { entries: this.records.size, pending: this.pending.size };
  }
}