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
    if (selectedStrategyKey) {
      const requestedEdge = canonicalEdgeForStrategy(selectedStrategyKey);
      const strategySnapshot = snapshots.find((snapshot) =>
        canonicalEdgeForStrategy(snapshot.strategyKey) === requestedEdge,
      );
      if (strategySnapshot) return strategySnapshot;
    }
    return qualifiedSnapshots.find((snapshot) => snapshot.snapshotId === candidate.snapshotId);
  };
  const items = candidates
    .map((candidate) => {
      const snapshot = snapshotForCandidate(candidate);
      return snapshot ? { candidate, snapshot } : null;
    })
    .filter((item): item is ReviewQueueItem => Boolean(item))
    .sort(compareQueueItems);
  const reviewableCandidateIds = new Set(items.map((item) => item.candidate.candidateId));

  return {
    items,
    candidates,
    unreviewableCandidates: candidates.filter((candidate) => !reviewableCandidateIds.has(candidate.candidateId)),
  };
}