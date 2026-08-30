import type { SetupType } from "./phase6.js";

export const STRATEGY_IDS = [
  "ORB_PULLBACK_CONTINUATION",
  "CONSOLIDATION_BREAKOUT_CONTINUATION",
  "PATIENCE_CANDLE_CONTINUATION",
  "EQUIVALENT_CANDLE_REVERSAL",
] as const;

export type StrategyId = typeof STRATEGY_IDS[number];
export type StrategyComponent =
  | "ORB_BREAKOUT"
  | "PULLBACK_INTERACTION"
  | "CONSOLIDATION"
  | "STRONG_BREAKOUT"
  | "BULLISH_PATIENCE"
  | "BEARISH_PATIENCE"
  | "ENTRY_CONFIRMATION"
  | "ENTRY_CONFIRMATION_FAILED"
  | "ENTRY_CONFIRMED"
  | "RISK_REJECTED"
  | "RISK_APPROVED_EXECUTION_UNAVAILABLE"
  | "MODELED_TRADE";
export type StrategyOutcome = "QUALIFIED_TRADE" | "ENTRY_CONFIRMATION_FAILED" | "ENTRY_CONFIRMED" | "RISK_REJECTED" | "RISK_APPROVED_EXECUTION_UNAVAILABLE" | "MODELED_TRADE" | "STOP_EXIT" | "TARGET_EXIT" | "RUNNER_EXIT";

export const STRATEGY_COMPONENT_TYPES: readonly StrategyComponent[] = [
  "ORB_BREAKOUT",
  "PULLBACK_INTERACTION",
  "CONSOLIDATION",
  "STRONG_BREAKOUT",
  "BULLISH_PATIENCE",
  "BEARISH_PATIENCE",
  "ENTRY_CONFIRMATION",
  "ENTRY_CONFIRMATION_FAILED",
  "ENTRY_CONFIRMED",
  "RISK_REJECTED",
  "RISK_APPROVED_EXECUTION_UNAVAILABLE",
  "MODELED_TRADE",
] as const;

export const STRATEGY_OUTCOME_TYPES: readonly StrategyOutcome[] = [
  "QUALIFIED_TRADE",
  "ENTRY_CONFIRMATION_FAILED",
  "ENTRY_CONFIRMED",
  "RISK_REJECTED",
  "RISK_APPROVED_EXECUTION_UNAVAILABLE",
  "MODELED_TRADE",
  "STOP_EXIT",
  "TARGET_EXIT",
  "RUNNER_EXIT",
] as const;

export type StrategyDefinition = {
  id: StrategyId;
  name: string;
  description: string;
  components: readonly string[];
  alertOnly: boolean;
};

export const STRATEGY_DEFINITIONS: readonly StrategyDefinition[] = [
  {
    id: "CONSOLIDATION_BREAKOUT_CONTINUATION",
    name: "Strong Breakout After Consolidation",
    description: "A bounded, stable price consolidation followed by a strong directional breakout, continuation, and risk approval.",
    components: ["consolidation", "strong breakout", "patience candle", "risk"],
    alertOnly: false,
  },
  { id: "PATIENCE_CANDLE_CONTINUATION", name: "Patience Candle Continuation", description: "A valid patience candle followed by the immediate buffered continuation candle.", components: ["trend", "level interaction", "patience candle", "immediate entry candle", "risk"], alertOnly: false },
  {
    id: "ORB_PULLBACK_CONTINUATION",
    name: "ORB Pullback Continuation",
    description: "A trend-aligned ORB/NTZ break, qualifying pullback interaction, and buffered continuation.",
    components: ["ORB/NTZ boundary", "breakout", "pullback", "Fibonacci", "volume", "patience candle", "risk"],
    alertOnly: false,
  },
  {
    id: "EQUIVALENT_CANDLE_REVERSAL",
    name: "Equivalent Candle Reversal",
    description: "Equivalent opposing candles at a major level followed by a directionally appropriate buffered continuation.",
    components: ["equivalent candles", "major level", "reversal context", "patience candle", "risk"],
    alertOnly: false,
  },
] as const;

export const STRATEGY_ID_SET = new Set<string>(STRATEGY_IDS);

export const LEGACY_STRATEGY_IDS: Record<StrategyId, readonly string[]> = {
  ORB_PULLBACK_CONTINUATION: ["ORB_BREAK_PULLBACK_CONTINUATION"],
  CONSOLIDATION_BREAKOUT_CONTINUATION: ["STRONG_BREAKOUT_AFTER_CONSOLIDATION", "EXTENDED_NTZ_CONSOLIDATION_BREAKOUT"],
  PATIENCE_CANDLE_CONTINUATION: [],
  EQUIVALENT_CANDLE_REVERSAL: ["BONUS_REVERSAL"],
} as const;

export function strategyIdsIncludingLegacy(strategyKey: StrategyId): readonly string[] {
  return [strategyKey, ...LEGACY_STRATEGY_IDS[strategyKey]];
}

export function isStrategyId(value: string): value is StrategyId {
  return STRATEGY_ID_SET.has(value);
}

export function strategyDefinition(strategyKey: string): StrategyDefinition | undefined {
  return STRATEGY_DEFINITIONS.find((item) => item.id === strategyKey);
}

export function canonicalStrategyId(value: string): StrategyId | null {
  if (isStrategyId(value)) return value;
  if (value === "ORB_BREAK_PULLBACK_CONTINUATION") return "ORB_PULLBACK_CONTINUATION";
  if (value === "STRONG_BREAKOUT_AFTER_CONSOLIDATION" || value === "EXTENDED_NTZ_CONSOLIDATION_BREAKOUT") return "CONSOLIDATION_BREAKOUT_CONTINUATION";
  if (value === "BONUS_REVERSAL") return "EQUIVALENT_CANDLE_REVERSAL";
  return null;
}

export function setupTypeForStrategy(strategyKey: StrategyId): SetupType {
  return strategyKey;
}

export function isStrategyComponent(value: string): boolean {
  return (STRATEGY_COMPONENT_TYPES as readonly string[]).includes(value);
}