import { randomUUID } from "node:crypto";
import type { BacktestAuditRecord, BacktestReport } from "./phase9.js";

const RUN_TTL_MS = 10 * 60_000;
const MAX_RUNS = 8;
const MAX_AUDIT_RECORDS_PER_RUN = 12_000;
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
};

const runs = new Map<string, StoredRun>();

function prune(now = Date.now()): void {
  for (const [runId, entry] of runs) {
    if (entry.expiresAt <= now) runs.delete(runId);
  }
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (!oldest) break;
    runs.delete(oldest);
  }
}

export function storeBacktestReport(report: BacktestReport): string {
  prune();
  if (report.audit.length > MAX_AUDIT_RECORDS_PER_RUN) {
    throw new Error(`Backtest audit exceeds the ${MAX_AUDIT_RECORDS_PER_RUN.toLocaleString()}-record safety limit.`);
  }
  const runId = randomUUID();
  runs.set(runId, { report, expiresAt: Date.now() + RUN_TTL_MS });
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
};