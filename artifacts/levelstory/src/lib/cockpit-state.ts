export const COCKPIT_PREVIEW_STATES = [
  { value: "live", label: "Live calculated view", group: "baseline", tone: "neutral", description: "Showing the current deterministic snapshot from the API." },
  { value: "loading", label: "Loading", group: "feed", tone: "neutral", description: "Skeleton treatment for a snapshot that has not arrived yet." },
  { value: "market_closed", label: "Market closed", group: "feed", tone: "warning", description: "Last calculated context remains visible; no new session evidence is implied." },
  { value: "empty", label: "Empty", group: "feed", tone: "neutral", description: "No candles, signals, or review history are available in this state." },
  { value: "stale", label: "Stale data", group: "feed", tone: "warning", description: "The last snapshot is retained for context but should not be treated as current." },
  { value: "disconnected", label: "Disconnected", group: "feed", tone: "danger", description: "The simulated feed is unavailable and must be reconnected before relying on it." },
  { value: "error", label: "Error", group: "feed", tone: "danger", description: "The snapshot request failed; retry is available and no decision is asserted." },
  { value: "no_trade", label: "No trade", group: "decision", tone: "danger", description: "The required chain is not complete. Attention is not earned." },
  { value: "setup_forming", label: "Setup forming", group: "decision", tone: "warning", description: "Evidence is developing, but at least one mandatory rule remains incomplete." },
  { value: "qualified", label: "Setup qualified", group: "decision", tone: "positive", description: "Display-only qualified-state treatment; the evaluator result below remains the source of truth." },
  { value: "active_shadow_trade", label: "Active shadow trade", group: "decision", tone: "positive", description: "A modeled fill is active in Shadow Mode only. No broker or paper order exists." },
  { value: "runner_active", label: "Runner active", group: "decision", tone: "positive", description: "A modeled target leg has completed and the runner is being tracked in Shadow Mode only." },
  { value: "risk_lockout", label: "Risk lockout", group: "decision", tone: "danger", description: "Risk guardrails block the plan; no simulated entry should be treated as permission." },
  { value: "ambiguous", label: "Ambiguous", group: "decision", tone: "warning", description: "Intrabar evidence touches conflicting outcomes and is conservatively withheld." },
] as const;

export type CockpitPreviewState = (typeof COCKPIT_PREVIEW_STATES)[number]["value"];
export type CockpitPreview = (typeof COCKPIT_PREVIEW_STATES)[number];

export function getCockpitPreview(value: string): CockpitPreview {
  return COCKPIT_PREVIEW_STATES.find((item) => item.value === value) ?? COCKPIT_PREVIEW_STATES[0];
}

export function isFeedPreviewState(value: CockpitPreviewState): boolean {
  return COCKPIT_PREVIEW_STATES.find((item) => item.value === value)?.group === "feed";
}

export function isDecisionPreviewState(value: CockpitPreviewState): boolean {
  return COCKPIT_PREVIEW_STATES.find((item) => item.value === value)?.group === "decision";
}