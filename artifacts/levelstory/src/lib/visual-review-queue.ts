import type {
  StrategyId,
  VisualValidationSet,
  VisualValidationSnapshot,
  VisualValidationTradeCandidate,
} from "@workspace/api-client-react";

export type ReviewQueueItem = {
  candidate: VisualValidationTradeCandidate;
  snapshot: VisualValidationSnapshot;
};

export type ReviewQueueModel = {
  items: ReviewQueueItem[];
  candidates: VisualValidationTradeCandidate[];
  unreviewableCandidates: VisualValidationTradeCandidate[];
};

const CANONICAL_EDGE_BY_STRATEGY: Record<string, string> = {
  ORB_PULLBACK_CONTINUATION: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
  ORB_BREAK_PULLBACK_CONTINUATION: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
  PATIENCE_CANDLE_CONTINUATION: "ORB_BREAK_PULLBACK_PATIENCE_CONTINUATION",
  CONSOLIDATION_BREAKOUT_CONTINUATION: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
};

function canonicalEdgeForStrategy(strategy: StrategyId): string {
  return CANONICAL_EDGE_BY_STRATEGY[strategy] ?? strategy;
}

function matchesStrategy(candidate: VisualValidationTradeCandidate, strategy: StrategyId): boolean {
  const edge = canonicalEdgeForStrategy(strategy);
  return candidate.primaryEdge === edge || candidate.matchedEdges.includes(edge);
}

function diagnosticCandidate(snapshot: VisualValidationSnapshot): VisualValidationTradeCandidate {
  const direction = snapshot.categoryAnchor.direction ?? "long";
  const trade = snapshot.machineEvidence.trade as { outcome?: VisualValidationTradeCandidate["outcome"] } | null;
  const primaryEdge = canonicalEdgeForStrategy(snapshot.strategyKey) as VisualValidationTradeCandidate["primaryEdge"];
  return {
    candidateId: `diagnostic|${snapshot.snapshotId}`,
    snapshotId: snapshot.snapshotId,
    signalOccurrenceId: snapshot.occurrenceId ?? snapshot.snapshotId,
    contractSymbol: snapshot.contractSymbol,
    tradingDate: snapshot.tradingDate,
    entryCandleOpenTime: snapshot.categoryAnchor.openTime,
    entryCandleCloseTime: snapshot.categoryAnchor.closeTime,
    direction,
    entryTriggerPrice: snapshot.categoryAnchor.price,
    primaryEdge,
    matchedEdges: [primaryEdge],
    supportingConfluences: [],
    setupGrade: "A",
    period: snapshot.period,
    outcome: trade?.outcome ?? "open",
    causalEvidence: snapshot.categoryAnchor.relatedCandles.map((candle) => ({
      kind: candle.role === "evaluation" ? "level" : candle.role === "patience" ? "patience" : "entry",
      timestamp: candle.closeTime,
      detail: `${candle.role} candle`,
    })),
  };
}

function compareQueueItems(left: ReviewQueueItem, right: ReviewQueueItem): number {
  return left.candidate.tradingDate.localeCompare(right.candidate.tradingDate)
    || left.candidate.entryCandleCloseTime.localeCompare(right.candidate.entryCandleCloseTime)
    || left.candidate.entryCandleOpenTime.localeCompare(right.candidate.entryCandleOpenTime)
    || left.candidate.candidateId.localeCompare(right.candidate.candidateId);
}

export function buildReviewQueue(
  data: VisualValidationSet | null | undefined,
  selectedStrategyKey: StrategyId | null,
): ReviewQueueModel {
  if (!data) return { items: [], candidates: [], unreviewableCandidates: [] };

  const seen = new Set<string>();
  const candidates = data.tradeCandidates.filter((candidate) => {
    if (seen.has(candidate.candidateId)) return false;
    seen.add(candidate.candidateId);
    return !selectedStrategyKey || matchesStrategy(candidate, selectedStrategyKey);
  });
  const qualifiedSnapshots = data.snapshots.filter((snapshot) => snapshot.category === "qualified_trade");
  const snapshotsByCandidateId = new Map<string, VisualValidationSnapshot[]>();
  for (const snapshot of qualifiedSnapshots) {
    const trade = snapshot.machineEvidence.trade as { candidateId?: string } | null;
    if (!trade?.candidateId) continue;
    const snapshots = snapshotsByCandidateId.get(trade.candidateId) ?? [];
    snapshots.push(snapshot);
    snapshotsByCandidateId.set(trade.candidateId, snapshots);
  }
  const snapshotForCandidate = (candidate: VisualValidationTradeCandidate): VisualValidationSnapshot | undefined => {
    const snapshots = snapshotsByCandidateId.get(candidate.candidateId) ?? [];
    const requestedEdge = canonicalEdgeForStrategy(
      selectedStrategyKey ?? candidate.primaryEdge as StrategyId,
    );
    const strategySnapshot = snapshots.find((snapshot) =>
      canonicalEdgeForStrategy(snapshot.strategyKey) === requestedEdge,
    );
    if (strategySnapshot) return strategySnapshot;
    return qualifiedSnapshots.find((snapshot) => snapshot.snapshotId === candidate.snapshotId);
  };
  const items = candidates
    .map((candidate) => {
      const snapshot = snapshotForCandidate(candidate);
      return snapshot ? { candidate, snapshot } : null;
    })
    .filter((item): item is ReviewQueueItem => Boolean(item))
    .sort(compareQueueItems);
  if (data.request.reviewMode === "trades_and_diagnostics") {
    const existingSnapshotIds = new Set(items.map((item) => item.snapshot.snapshotId));
    const diagnostics = data.snapshots
      .filter((snapshot) => snapshot.category !== "qualified_trade" && !existingSnapshotIds.has(snapshot.snapshotId))
      .filter((snapshot) => !selectedStrategyKey || snapshot.strategyKey === selectedStrategyKey)
      .map((snapshot) => ({ candidate: diagnosticCandidate(snapshot), snapshot }))
      .sort((left, right) => compareQueueItems(left, right));
    items.push(...diagnostics);
  }
  const reviewableCandidateIds = new Set(items.map((item) => item.candidate.candidateId));

  return {
    items,
    candidates,
    unreviewableCandidates: candidates.filter((candidate) => !reviewableCandidateIds.has(candidate.candidateId)),
  };
}