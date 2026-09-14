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
  const snapshotsById = new Map(
    data.snapshots
      .filter((snapshot) => snapshot.category === "qualified_trade")
      .map((snapshot) => [snapshot.snapshotId, snapshot]),
  );
  const items = candidates
    .map((candidate) => {
      const snapshot = snapshotsById.get(candidate.snapshotId);
      return snapshot ? { candidate, snapshot } : null;
    })
    .filter((item): item is ReviewQueueItem => Boolean(item))
    .sort(compareQueueItems);

  return {
    items,
    candidates,
    unreviewableCandidates: candidates.filter((candidate) => !snapshotsById.has(candidate.snapshotId)),
  };
}