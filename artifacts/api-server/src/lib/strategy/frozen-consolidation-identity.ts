import { createHash } from "node:crypto";
import type { Direction } from "./types.js";

export const FROZEN_CONSOLIDATION_IDENTITY_VERSION = "frozen-consolidation-identity-v2";

export type FrozenConsolidationIdentityInput = {
  specificStrategyId: string | null;
  direction: Direction | null;
  contractSymbol: string;
  tradingDate: string;
  frozenZoneId: string | null;
  zoneLow: number | null;
  zoneHigh: number | null;
  midpointCalculationVersion: string | null;
  consolidationStart: string | null;
  consolidationEnd: string | null;
  constituentCandleTimestamps: readonly string[];
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function frozenConsolidationIdentity(
  input: FrozenConsolidationIdentityInput,
): string | null {
  if (
    !input.specificStrategyId
    || !input.direction
    || !input.contractSymbol
    || !input.tradingDate
    || input.zoneLow === null
    || input.zoneHigh === null
    || !input.midpointCalculationVersion
    || !input.consolidationStart
    || !input.consolidationEnd
  ) return null;
  const canonical = {
    version: FROZEN_CONSOLIDATION_IDENTITY_VERSION,
    ...input,
    constituentCandleTimestamps: [...input.constituentCandleTimestamps].sort(),
  };
  return `${FROZEN_CONSOLIDATION_IDENTITY_VERSION}:${createHash("sha256")
    .update(stableSerialize(canonical))
    .digest("hex")}`;
}