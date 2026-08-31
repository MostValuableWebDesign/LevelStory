import type { Direction } from "./types.js";

export type ProfitTargetPlacement = "NEAR_SIDE_12_TICKS" | "EXACT_LEVEL";

export type KeyLevelTargetInput = {
  id: string;
  type: string;
  price?: number | null;
  rangeLow?: number | null;
  rangeHigh?: number | null;
};

export type TargetLevelSnapshot = {
  frozenAt: string;
  /** The audit cursor that first supplied this completed-E snapshot, when known. */
  sourceAuditCursor?: string;
  sourceAuditId: string;
  eOpenTimestamp: string | null;
  eCloseTimestamp: string | null;
  sourceFingerprint: string;
  formulaHash: string;
  configurationHash: string;
  frozenLevelInputs: readonly KeyLevelTargetInput[];
};

export type FrozenTargetLevel = {
  id: string;
  type: string;
  price: number;
  rangeLow: number | null;
  rangeHigh: number | null;
  distancePoints: number;
  distanceTicks: number;
};

export type SkippedTargetLevel = FrozenTargetLevel & {
  reason: "ENTRY_WITHIN_12_TICKS";
};

export type KeyLevelTargetPlan = {
  placementMode: ProfitTargetPlacement;
  disposition: "KEY_LEVEL_SELECTED" | "NO_ELIGIBLE_KEY_LEVEL";
  entryPrice: number;
  direction: Direction;
  tickSize: number;
  bufferTicks: 12;
  bufferPoints: number;
  availableLevels: FrozenTargetLevel[];
  skippedLevels: SkippedTargetLevel[];
  selectedTargetLevel: FrozenTargetLevel | null;
  subsequentTargetLevels: FrozenTargetLevel[];
  targetPrice: number | null;
  targetLevelSnapshot?: TargetLevelSnapshot;
};

function normalizedLevelText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

/**
 * Target selection is deliberately narrower than the set of levels used by
 * qualification. Management artifacts and generic critical aliases are not
 * valid profit-target inputs even when they carry a finite price.
 */
export function isEligibleKeyLevelInput(level: KeyLevelTargetInput): boolean {
  if (!level.id.trim() || !level.type.trim()) return false;
  const id = normalizedLevelText(level.id);
  const type = normalizedLevelText(level.type);
  const text = `${id} ${type}`;
  if (/\b(?:fib|fibonacci)\b/.test(text)) return false;
  if (/\bcritical\b/.test(text)) return false;
  if (/\bprevious day close\b|\bprior day close\b|\bprevious session close\b|\bprior session close\b/.test(text)) return false;
  if (/\b(?:entry buffer|confirmation buffer|stop|runner|target|management)\b/.test(text)) return false;
  if (/\b(?:vwap)\b/.test(text)) return true;
  if (/\b(?:ema ?200|200 ema)\b/.test(text)) return true;
  if (/\b(?:dynamite)\b/.test(text)) return true;
  if (/\b(?:major|support|resistance)\b/.test(text) && !/\bcritical\b/.test(text)) return true;
  if (/\b(?:orb|opening range)\b/.test(text)) return true;
  if (/\b(?:ntz|no trade zone)\b/.test(text)) return true;
  if (/\b(?:premarket|pre market)\b/.test(text)) return true;
  if (/\b(?:previous|prior)(?: (?:day|session))?\b/.test(text) && /\b(?:high|low)\b/.test(text)) return true;
  if (/\b(?:two days ago|two sessions ago|day before yesterday)\b/.test(text)
    && /\b(?:high|low)\b/.test(text)) return true;
  return false;
}

export function filterEligibleKeyLevelInputs(
  levels: readonly KeyLevelTargetInput[],
): KeyLevelTargetInput[] {
  return levels
    .filter(isEligibleKeyLevelInput)
    .map((level) => ({
      id: level.id,
      type: level.type,
      ...(typeof level.price === "number" ? { price: level.price } : {}),
      ...(typeof level.rangeLow === "number" ? { rangeLow: level.rangeLow } : {}),
      ...(typeof level.rangeHigh === "number" ? { rangeHigh: level.rangeHigh } : {}),
    }));
}

function priceForLevel(level: KeyLevelTargetInput): number | null {
  const low = typeof level.rangeLow === "number" ? level.rangeLow : null;
  const high = typeof level.rangeHigh === "number" ? level.rangeHigh : null;
  if (low !== null && high !== null) return Math.min(low, high);
  return typeof level.price === "number" ? level.price : low ?? high;
}

function normalizePrice(price: number, tickSize: number): number {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(10));
}

function mergeLevels(levels: readonly KeyLevelTargetInput[], tickSize: number): FrozenTargetLevel[] {
  const merged = new Map<string, FrozenTargetLevel>();
  for (const level of filterEligibleKeyLevelInputs(levels)) {
    const low = typeof level.rangeLow === "number" ? Math.min(level.rangeLow, level.rangeHigh ?? level.rangeLow) : null;
    const high = typeof level.rangeHigh === "number" ? Math.max(level.rangeHigh, level.rangeLow ?? level.rangeHigh) : null;
    const price = priceForLevel(level);
    if (!level.id || price === null || !Number.isFinite(price)) continue;
    const key = `${low ?? price}|${high ?? price}`;
    const existing = merged.get(key);
    if (existing) {
      existing.id = [...new Set(`${existing.id}|${level.id}`.split("|"))].sort().join("|");
      existing.type = [...new Set(`${existing.type}|${level.type}`.split("|"))].sort().join("|");
      continue;
    }
    merged.set(key, {
      id: level.id,
      type: level.type,
      price: normalizePrice(price, tickSize),
      rangeLow: low === null ? null : normalizePrice(low, tickSize),
      rangeHigh: high === null ? null : normalizePrice(high, tickSize),
      distancePoints: 0,
      distanceTicks: 0,
    });
  }
  return [...merged.values()];
}

export function buildKeyLevelTargetPlan(input: {
  direction: Direction;
  entryPrice: number;
  levels: readonly KeyLevelTargetInput[];
  tickSize?: number;
  bufferTicks?: 12;
  placementMode?: ProfitTargetPlacement;
}): KeyLevelTargetPlan {
  const tickSize = input.tickSize ?? 0.25;
  const bufferTicks = input.bufferTicks ?? 12;
  if (bufferTicks !== 12) throw new Error("Key-level target buffer must be exactly 12 MES ticks.");
  if (!Number.isFinite(input.entryPrice) || tickSize <= 0) throw new Error("Key-level target entry and tick size must be finite.");
  const placementMode = input.placementMode ?? "NEAR_SIDE_12_TICKS";
  const bufferPoints = bufferTicks * tickSize;
  const availableLevels = mergeLevels(input.levels, tickSize)
    .map((level) => {
      const encountered = input.direction === "long"
        ? level.rangeLow ?? level.price
        : level.rangeHigh ?? level.price;
      const distancePoints = input.direction === "long"
        ? encountered - input.entryPrice
        : input.entryPrice - encountered;
      return {
        ...level,
        price: normalizePrice(encountered, tickSize),
        distancePoints: Number(distancePoints.toFixed(10)),
        distanceTicks: Math.round(distancePoints / tickSize),
      };
    })
    .filter((level) => level.distancePoints > 0)
    .sort((a, b) => a.distancePoints - b.distancePoints || a.id.localeCompare(b.id));
  const skippedLevels: SkippedTargetLevel[] = availableLevels
    .filter((level) => level.distancePoints <= bufferPoints)
    .map((level) => ({ ...level, reason: "ENTRY_WITHIN_12_TICKS" }));
  const eligible = availableLevels.filter((level) => level.distancePoints > bufferPoints);
  const selectedTargetLevel = eligible[0] ?? null;
  const subsequentTargetLevels = eligible.slice(1);
  const targetPrice = selectedTargetLevel === null
    ? null
    : placementMode === "EXACT_LEVEL"
      ? selectedTargetLevel.price
      : normalizePrice(
        input.direction === "long"
          ? (selectedTargetLevel.rangeLow ?? selectedTargetLevel.price) - bufferPoints
          : (selectedTargetLevel.rangeHigh ?? selectedTargetLevel.price) + bufferPoints,
        tickSize,
      );
  return {
    placementMode,
    disposition: selectedTargetLevel === null ? "NO_ELIGIBLE_KEY_LEVEL" : "KEY_LEVEL_SELECTED",
    entryPrice: normalizePrice(input.entryPrice, tickSize),
    direction: input.direction,
    tickSize,
    bufferTicks: 12,
    bufferPoints,
    availableLevels,
    skippedLevels,
    selectedTargetLevel,
    subsequentTargetLevels,
    targetPrice,
  };
}