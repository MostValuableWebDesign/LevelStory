import type { SetupType } from "./phase6.js";

export const STRATEGY_IDS = [
  "PATIENCE_CANDLE_CONTINUATION",
  "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
  "ORB_BREAK_PULLBACK_CONTINUATION",
  "EQUIVALENT_CANDLE_REVERSAL",
] as const;

export type StrategyId = typeof STRATEGY_IDS[number];

export type StrategyDefinition = {
  id: StrategyId;
  name: string;
  description: string;
  components: readonly string[];
  alertOnly: boolean;
};

export const STRATEGY_DEFINITIONS: readonly StrategyDefinition[] = [
  {
    id: "PATIENCE_CANDLE_CONTINUATION",
    name: "Patience Candle Continuation",
    description: "A valid patience candle followed by the immediate buffered continuation candle.",
    components: ["trend", "level interaction", "patience candle", "immediate entry candle", "risk"],
    alertOnly: false,
  },
  {
    id: "STRONG_BREAKOUT_AFTER_CONSOLIDATION",
    name: "Strong Breakout After Consolidation",
    description: "A stable 45–60 minute NTZ consolidation followed by a supported breakout and buffered continuation.",
    components: ["NTZ consolidation", "breakout", "volume", "patience candle", "risk"],
    alertOnly: false,
  },
  {
    id: "ORB_BREAK_PULLBACK_CONTINUATION",
    name: "ORB Break Pullback Continuation",
    description: "A trend-aligned ORB/NTZ break, qualifying pullback interaction, and buffered continuation.",
    components: ["ORB/NTZ boundary", "breakout", "pullback", "Fibonacci", "volume", "patience candle", "risk"],
    alertOnly: false,
  },
  {
    id: "EQUIVALENT_CANDLE_REVERSAL",
    name: "Equivalent Candle Reversal",
    description: "An alert-only reversal context using equivalent opposing candles and independent rejection evidence.",
    components: ["equivalent candles", "major level", "rejection", "volume", "Fibonacci"],
    alertOnly: true,
  },
] as const;

export const STRATEGY_ID_SET = new Set<string>(STRATEGY_IDS);

export function isStrategyId(value: string): value is StrategyId {
  return STRATEGY_ID_SET.has(value);
}

export function strategyDefinition(strategyKey: string): StrategyDefinition | undefined {
  return STRATEGY_DEFINITIONS.find((item) => item.id === strategyKey);
}

export function canonicalStrategyId(value: string): StrategyId | null {
  if (isStrategyId(value)) return value;
  if (value === "EXTENDED_NTZ_CONSOLIDATION_BREAKOUT") return "STRONG_BREAKOUT_AFTER_CONSOLIDATION";
  if (value === "BONUS_REVERSAL") return "EQUIVALENT_CANDLE_REVERSAL";
  return null;
}

export function setupTypeForStrategy(strategyKey: StrategyId): SetupType {
  return strategyKey;
}

export function isStrategyComponent(value: string): boolean {
  return !isStrategyId(value);
}