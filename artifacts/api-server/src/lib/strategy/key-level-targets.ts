import type { Direction } from "./types.js";

export type ProfitTargetPlacement = "NEAR_SIDE_20_TICKS" | "EXACT_LEVEL";

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
  reason: "ENTRY_WITHIN_30_TICKS";
};

export type PrimaryLossExitReference = {
  id: string;
  type: string;
  price: number;
  rangeLow: number | null;
  rangeHigh: number | null;
  distancePoints: number;
  distanceTicks: number;
  stopPrice: number;
};

export type KeyLevelTargetPlan = {
  placementMode: ProfitTargetPlacement;
  disposition: "KEY_LEVEL_SELECTED" | "NO_ELIGIBLE_KEY_LEVEL";
  entryPrice: number;
  direction: Direction;
  tickSize: number;
  bufferTicks: 30;
  bufferPoints: number;
  placementTicks: 20;
  availableLevels: FrozenTargetLevel[];
  skippedLevels: SkippedTargetLevel[];
  selectedTargetLevel: FrozenTargetLevel | null;
  subsequentTargetLevels: FrozenTargetLevel[];
  targetPrice: number | null;
  targetLevelSnapshot?: TargetLevelSnapshot;
};

export const PROFIT_TARGET_BUFFER_TICKS = 30;
export const PROFIT_TARGET_PLACEMENT_TICKS = 20;

const DYNAMITE_MERGE_TOLERANCE_TICKS = 8;
const PRIMARY_LOSS_EXIT_STOP_BUFFER_TICKS = 8;

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
  const tolerancePoints = DYNAMITE_MERGE_TOLERANCE_TICKS * tickSize;
  const normalized = filterEligibleKeyLevelInputs(levels).flatMap((level) => {
    const low = typeof level.rangeLow === "number" ? Math.min(level.rangeLow, level.rangeHigh ?? level.rangeLow) : null;
    const high = typeof level.rangeHigh === "number" ? Math.max(level.rangeHigh, level.rangeLow ?? level.rangeHigh) : null;
    const price = priceForLevel(level);
    if (!level.id || price === null || !Number.isFinite(price)) return [];
    const normalizedLow = normalizePrice(low ?? price, tickSize);
    const normalizedHigh = normalizePrice(high ?? price, tickSize);
    return [{
      id: level.id,
      type: level.type,
      price: normalizePrice(price, tickSize),
      rangeLow: normalizedLow,
      rangeHigh: normalizedHigh,
      distancePoints: 0,
      distanceTicks: 0,
    } satisfies FrozenTargetLevel];
  }).sort((first, second) =>
    first.rangeLow! - second.rangeLow!
    || first.rangeHigh! - second.rangeHigh!
    || first.id.localeCompare(second.id));
  const merged: FrozenTargetLevel[] = [];
  for (const level of normalized) {
    const existing = merged.at(-1);
    if (existing) {
      const overlaps = level.rangeLow! <= existing.rangeHigh!;
      const combinedSpan = Math.max(existing.rangeHigh!, level.rangeHigh!)
        - Math.min(existing.rangeLow!, level.rangeLow!);
      if (overlaps || combinedSpan <= tolerancePoints) {
        existing.id = [...new Set(`${existing.id}|${level.id}`.split("|"))].sort().join("|");
        existing.type = [...new Set(`${existing.type}|${level.type}`.split("|"))].sort().join("|");
        existing.rangeLow = normalizePrice(Math.min(existing.rangeLow!, level.rangeLow!), tickSize);
        existing.rangeHigh = normalizePrice(Math.max(existing.rangeHigh!, level.rangeHigh!), tickSize);
        existing.price = existing.rangeLow;
        continue;
      }
    }
    merged.push({ ...level });
  }
  return merged.map((level) => {
    if (level.rangeLow === level.rangeHigh) {
      return {
        ...level,
        rangeLow: null,
        rangeHigh: null,
      };
    }
    return level;
  });
}

function rawNearBoundaryForLevel(
  selected: FrozenTargetLevel,
  levels: readonly KeyLevelTargetInput[],
  direction: Direction,
): number {
  const matchingInputs = filterEligibleKeyLevelInputs(levels).filter((level) =>
    selected.id === level.id || selected.id.includes(level.id),
  );
  const boundaries = matchingInputs.flatMap((level) => {
    const low = typeof level.rangeLow === "number" ? Math.min(level.rangeLow, level.rangeHigh ?? level.rangeLow) : null;
    const high = typeof level.rangeHigh === "number" ? Math.max(level.rangeHigh, level.rangeLow ?? level.rangeHigh) : null;
    if (direction === "long") return [low ?? level.price].filter((price): price is number => typeof price === "number");
    return [high ?? level.price].filter((price): price is number => typeof price === "number");
  });
  if (!boundaries.length) {
    return direction === "long"
      ? selected.rangeLow ?? selected.price
      : selected.rangeHigh ?? selected.price;
  }
  return direction === "long" ? Math.min(...boundaries) : Math.max(...boundaries);
}

function nearSideTargetPrice(
  direction: Direction,
  levelBoundary: number,
  bufferPoints: number,
  tickSize: number,
): number {
  const unrounded = direction === "long"
    ? levelBoundary - bufferPoints
    : levelBoundary + bufferPoints;
  // Round toward the key level so the executable MES price never lands
  // farther than the governed placement distance from the raw level.
  const tickIndex = unrounded / tickSize;
  const roundedIndex = direction === "long"
    ? Math.ceil(tickIndex - 1e-9)
    : Math.floor(tickIndex + 1e-9);
  return Number((roundedIndex * tickSize).toFixed(10));
}

function distanceToRange(price: number, rangeLow: number, rangeHigh: number): number {
  if (price < rangeLow) return rangeLow - price;
  if (price > rangeHigh) return price - rangeHigh;
  return 0;
}

/**
 * A losing position may use a causal primary level/indicator as the first
 * adverse exit reference when the patience candle's opposite wick is within
 * the governed 12-tick vicinity. The P-wick strategy stop remains the
 * secondary fallback and is intentionally not replaced globally.
 */
export function primaryLossExitReferenceForPatience(input: {
  direction: Direction;
  entryPrice: number;
  patienceLow: number;
  patienceHigh: number;
  levels: readonly KeyLevelTargetInput[];
  tickSize?: number;
  bufferTicks?: 12;
}): PrimaryLossExitReference | null {
  const tickSize = input.tickSize ?? 0.25;
  const bufferTicks = input.bufferTicks ?? 12;
  if (bufferTicks !== 12) throw new Error("Primary loss-exit vicinity must be exactly 12 MES ticks.");
  if (
    !Number.isFinite(input.entryPrice)
    || !Number.isFinite(input.patienceLow)
    || !Number.isFinite(input.patienceHigh)
    || tickSize <= 0
  ) return null;

  const oppositeWick = input.direction === "long" ? input.patienceLow : input.patienceHigh;
  const bufferPoints = bufferTicks * tickSize;
  const adverseLevels = filterEligibleKeyLevelInputs(input.levels).filter((level) => {
    const rangeLow = typeof level.rangeLow === "number"
      ? Math.min(level.rangeLow, level.rangeHigh ?? level.rangeLow)
      : level.price;
    const rangeHigh = typeof level.rangeHigh === "number"
      ? Math.max(level.rangeHigh, level.rangeLow ?? level.rangeHigh)
      : level.price;
    if (typeof rangeLow !== "number" || typeof rangeHigh !== "number") return false;
    return input.direction === "long"
      ? rangeHigh < input.entryPrice
      : rangeLow > input.entryPrice;
  });
  return mergeLevels(adverseLevels, tickSize)
    .flatMap((level) => {
      const rangeLow = level.rangeLow ?? level.price;
      const rangeHigh = level.rangeHigh ?? level.price;
      const distancePoints = distanceToRange(oppositeWick, rangeLow, rangeHigh);
      if (distancePoints > bufferPoints) return [];
      const stopBufferPoints = PRIMARY_LOSS_EXIT_STOP_BUFFER_TICKS * tickSize;
      const stopPrice = input.direction === "long"
        ? rangeHigh - stopBufferPoints
        : rangeLow + stopBufferPoints;
      return [{
        id: level.id,
        type: level.type,
        price: level.price,
        rangeLow: level.rangeLow,
        rangeHigh: level.rangeHigh,
        distancePoints: Number(distancePoints.toFixed(10)),
        distanceTicks: Math.ceil(distancePoints / tickSize - 1e-9),
        stopPrice: normalizePrice(stopPrice, tickSize),
      } satisfies PrimaryLossExitReference];
    })
    .sort((first, second) =>
      first.distancePoints - second.distancePoints
      || first.stopPrice - second.stopPrice
      || first.id.localeCompare(second.id),
    )[0] ?? null;
}

export function buildKeyLevelTargetPlan(input: {
  direction: Direction;
  entryPrice: number;
  levels: readonly KeyLevelTargetInput[];
  tickSize?: number;
  bufferTicks?: 30;
  placementMode?: ProfitTargetPlacement;
}): KeyLevelTargetPlan {
  const tickSize = input.tickSize ?? 0.25;
  const bufferTicks = input.bufferTicks ?? PROFIT_TARGET_BUFFER_TICKS;
  if (bufferTicks !== 30) throw new Error("Key-level target buffer must be exactly 30 MES ticks.");
  if (!Number.isFinite(input.entryPrice) || tickSize <= 0) throw new Error("Key-level target entry and tick size must be finite.");
  const placementMode = input.placementMode ?? "EXACT_LEVEL";
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
    .map((level) => ({ ...level, reason: "ENTRY_WITHIN_30_TICKS" }));
  const eligible = availableLevels.filter((level) => level.distancePoints > bufferPoints);
  const selectedTargetLevel = eligible[0] ?? null;
  const subsequentTargetLevels = eligible.slice(1);
  const targetPrice = selectedTargetLevel === null
    ? null
    : placementMode === "EXACT_LEVEL"
      ? rawNearBoundaryForLevel(selectedTargetLevel, input.levels, input.direction)
      : nearSideTargetPrice(
        input.direction,
        rawNearBoundaryForLevel(selectedTargetLevel, input.levels, input.direction),
        PROFIT_TARGET_PLACEMENT_TICKS * tickSize,
        tickSize,
      );
  return {
    placementMode,
    disposition: selectedTargetLevel === null ? "NO_ELIGIBLE_KEY_LEVEL" : "KEY_LEVEL_SELECTED",
    entryPrice: normalizePrice(input.entryPrice, tickSize),
    direction: input.direction,
    tickSize,
    bufferTicks: 30,
    bufferPoints,
    placementTicks: PROFIT_TARGET_PLACEMENT_TICKS,
    availableLevels,
    skippedLevels,
    selectedTargetLevel,
    subsequentTargetLevels,
    targetPrice,
  };
}