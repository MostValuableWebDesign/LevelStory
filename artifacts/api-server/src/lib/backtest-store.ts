import { createHash, randomUUID } from "node:crypto";
import type { BacktestAuditRecord, BacktestReport } from "./phase9.js";

const RUN_TTL_MS = 10 * 60_000;
const MAX_RUNS = 8;
const MAX_AUDIT_RECORDS_PER_RUN = 12_000;
const MAX_TOTAL_AUDIT_RECORDS = 40_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export type AuditPageFilters = {
  decision?: string;
  date?: string;
  setup?: string;
  patience?: string;
  category?: BacktestAuditRecord["rejectionCategory"];
  ambiguity?: boolean;
};

export type BacktestAuditPage = {
  runId: string;
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  filters: AuditPageFilters;
  audit: BacktestAuditRecord[];
};

type StoredRun = {
  report: BacktestReport;
  expiresAt: number;
  lastAccessedAt: number;
  cacheKey?: string;
};

const runs = new Map<string, StoredRun>();
const cacheKeys = new Map<string, string>();

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildBacktestCacheKey(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function deleteRun(runId: string): void {
  const stored = runs.get(runId);
  if (stored?.cacheKey) cacheKeys.delete(stored.cacheKey);
  runs.delete(runId);
}

function prune(now = Date.now()): void {
  for (const [runId, entry] of runs) {
    if (entry.expiresAt <= now) deleteRun(runId);
  }
  const auditCount = () => [...runs.values()].reduce((sum, entry) => sum + entry.report.audit.length, 0);
  while (runs.size > MAX_RUNS || auditCount() > MAX_TOTAL_AUDIT_RECORDS) {
    const oldest = [...runs.entries()].sort(([, first], [, second]) => first.lastAccessedAt - second.lastAccessedAt)[0]?.[0];
    if (!oldest) break;
    deleteRun(oldest);
  }
}

export function getCachedBacktestReport(cacheKey: string): { runId: string; report: BacktestReport } | null {
  prune();
  const runId = cacheKeys.get(cacheKey);
  if (!runId) return null;
  const stored = runs.get(runId);
  if (!stored) {
    cacheKeys.delete(cacheKey);
    return null;
  }
  stored.expiresAt = Date.now() + RUN_TTL_MS;
  stored.lastAccessedAt = Date.now();
  return { runId, report: stored.report };
}

export function storeBacktestReport(report: BacktestReport, cacheKey?: string): string {
  prune();
  if (report.audit.length > MAX_AUDIT_RECORDS_PER_RUN) {
    throw new Error(`Backtest audit exceeds the ${MAX_AUDIT_RECORDS_PER_RUN.toLocaleString()}-record safety limit.`);
  }
  const cached = cacheKey ? getCachedBacktestReport(cacheKey) : null;
  if (cached) return cached.runId;
  const runId = randomUUID();
  const now = Date.now();
  runs.set(runId, { report, expiresAt: now + RUN_TTL_MS, lastAccessedAt: now, cacheKey });
  if (cacheKey) cacheKeys.set(cacheKey, runId);
  prune(now);
  return runId;
}

export function getBacktestAuditPage(
  runId: string,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  filters: AuditPageFilters = {},
): BacktestAuditPage | null {
  prune();
  const stored = runs.get(runId);
  if (!stored) return null;
  stored.expiresAt = Date.now() + RUN_TTL_MS;
  stored.lastAccessedAt = Date.now();
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
  const filtered = stored.report.audit.filter((record) => {
    if (filters.decision && record.decision !== filters.decision) return false;
    if (filters.date && record.tradingDate !== filters.date) return false;
    if (filters.setup && record.setupType !== filters.setup) return false;
    if (filters.patience && record.patienceState !== filters.patience) return false;
    if (filters.category && record.rejectionCategory !== filters.category) return false;
    if (filters.ambiguity !== undefined && (record.ambiguityLabels.length > 0) !== filters.ambiguity) return false;
    return true;
  });
  const start = (safePage - 1) * safePageSize;
  return {
    runId,
    page: safePage,
    pageSize: safePageSize,
    total: filtered.length,
    hasMore: start + safePageSize < filtered.length,
    filters,
    audit: filtered.slice(start, start + safePageSize),
  };
}

export function compactBacktestReport(report: BacktestReport, runId: string): BacktestReport {
  const firstPage = getBacktestAuditPage(runId);
  if (!firstPage) throw new Error("Backtest result expired before it could be returned.");
  return {
    ...report,
    audit: firstPage.audit,
    auditPage: {
      runId,
      page: firstPage.page,
      pageSize: firstPage.pageSize,
      total: firstPage.total,
      hasMore: firstPage.hasMore,
    },
  };
}

export const backtestAuditLimits = {
  defaultPageSize: DEFAULT_PAGE_SIZE,
  maxPageSize: MAX_PAGE_SIZE,
  ttlMs: RUN_TTL_MS,
  maxRuns: MAX_RUNS,
  maxTotalAuditRecords: MAX_TOTAL_AUDIT_RECORDS,
};