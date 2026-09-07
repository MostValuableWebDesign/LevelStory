import type { Direction } from "./types.js";

export type ProfitTargetPlacement = "NEAR_SIDE_8_TICKS" | "NEAR_SIDE_ADAPTIVE_TICKS" | "EXACT_LEVEL";

export type KeyLevelTargetInput = {
  id: string;
  type: string;
  price?: number | null;
  rangeLow?: number | null;
  rangeHigh?: number | null;
  sourceTimestamp?: string | null;
};

export const KEY_LEVEL_TARGET_PLAN_VERSION = "key-level-target-search-v5-zone-aware-boundary";

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
  targetPlanVersion: string;
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
  sourceTimestamp: string | null;
  confluenceMembers?: readonly KeyLevelTargetInput[];
};

export type SkippedTargetLevel = FrozenTargetLevel & {
  reason:
    | "TARGET_LEVEL_SKIPPED_BELOW_1R"
    | "TARGET_LEVEL_SKIPPED_BEYOND_ACHIEVABLE_RANGE"
    | "TARGET_LEVEL_SKIPPED_WRONG_DIRECTION"
    | "TARGET_LEVEL_SKIPPED_DUPLICATE_CONFLUENCE"
    | "TARGET_LEVEL_SKIPPED_DIAGNOSTIC_ONLY"
    | "TARGET_LEVEL_SKIPPED_HARD_STRUCTURAL_OBSTRUCTION"
    | "OUTSIDE_20_POINTS"
    | "TARGET_NOT_PROFITABLE"
    | "INSUFFICIENT_REWARD_TO_RISK";
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
  targetPlanVersion: typeof KEY_LEVEL_TARGET_PLAN_VERSION;
  placementMode: ProfitTargetPlacement;
  disposition: "KEY_LEVEL_SELECTED" | "NO_ELIGIBLE_KEY_LEVEL";
  entryPrice: number;
  direction: Direction;
  tickSize: number;
  /** Maximum forward distance from entry for a key level to qualify as a target. */
  bufferTicks: number;
  bufferPoints: 20;
  /** Distance from the key level at which the executable target is placed. */
  placementTicks: number;
  /** Frozen adaptive near-side buffer used for this candidate. */
  targetBufferTicks: number;
  /** Minimum structural R required for candidate target selection. */
  initialRiskPoints?: number | null;
  targetR?: number | null;
  minimumTargetR?: number | null;
  /** Null means there is no maximum-R target cap; the 20-point distance cap remains authoritative. */
  maximumTargetR?: number | null;
  obstructingLevel?: FrozenTargetLevel | null;
  rejectionReason?: "INSUFFICIENT_REWARD_TO_RISK" | null;
  availableLevels: FrozenTargetLevel[];
  skippedLevels: SkippedTargetLevel[];
  selectedTargetLevel: FrozenTargetLevel | null;
  subsequentTargetLevels: FrozenTargetLevel[];
  targetPrice: number | null;
  fallbackUsed: boolean;
  fallbackReason: "ONE_R_FALLBACK_NO_ELIGIBLE_LEVEL" | null;
  searchRangePoints: number | null;
  searchRangeTicks: number | null;
  missingSourceTimestampLevelIds: string[];
  targetLevelSnapshot?: TargetLevelSnapshot;
};

export const PROFIT_TARGET_BUFFER_POINTS = 20;
export const PROFIT_TARGET_PLACEMENT_TICKS = 8;
const MIN_ADAPTIVE_TARGET_BUFFER_TICKS = 1;
const MAX_ADAPTIVE_TARGET_BUFFER_TICKS = 2;

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
      sourceTimestamp: level.sourceTimestamp ?? null,
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
      sourceTimestamp: level.sourceTimestamp ?? null,
      distancePoints: 0,
      distanceTicks: 0,
      confluenceMembers: [{
        id: level.id,
        type: level.type,
        ...(typeof level.price === "number" ? { price: level.price } : {}),
        ...(typeof level.rangeLow === "number" ? { rangeLow: level.rangeLow } : {}),
        ...(typeof level.rangeHigh === "number" ? { rangeHigh: level.rangeHigh } : {}),
        sourceTimestamp: level.sourceTimestamp ?? null,
      }],
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
        existing.sourceTimestamp = existing.sourceTimestamp
          ?? level.sourceTimestamp
          ?? null;
        existing.confluenceMembers = [
          ...(existing.confluenceMembers ?? []),
          ...(level.confluenceMembers ?? []),
        ];
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

function targetBoundaryForLevel(
  selected: FrozenTargetLevel,
  direction: Direction,
  entryPrice: number,
): number {
  const low = selected.rangeLow ?? selected.price;
  const high = selected.rangeHigh ?? selected.price;
  // When entry is already inside a level zone, the forward target boundary
  // is the far side of the zone. When entry is outside the zone, use the
  // near side so the executable target is reached before entering it.
  if (direction === "long") return low > entryPrice ? low : high;
  return high < entryPrice ? high : low;
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
  bufferPoints?: 20;
  placementMode?: ProfitTargetPlacement;
  targetBufferTicks?: number;
  atr14Ticks?: number | null;
  initialRiskPoints?: number | null;
  contracts?: number;
}): KeyLevelTargetPlan {
  const tickSize = input.tickSize ?? 0.25;
  const bufferPoints = input.bufferPoints ?? PROFIT_TARGET_BUFFER_POINTS;
  if (bufferPoints !== PROFIT_TARGET_BUFFER_POINTS) throw new Error("Key-level target distance must be exactly 20 MES points.");
  const bufferTicks = bufferPoints / tickSize;
  if (!Number.isFinite(input.entryPrice) || tickSize <= 0) throw new Error("Key-level target entry and tick size must be finite.");
  const placementMode = input.placementMode ?? "NEAR_SIDE_ADAPTIVE_TICKS";
  const targetBufferTicks = input.targetBufferTicks
    ?? (placementMode === "NEAR_SIDE_ADAPTIVE_TICKS"
      ? (
        Number.isFinite(input.atr14Ticks)
          ? Math.min(
            MAX_ADAPTIVE_TARGET_BUFFER_TICKS,
            Math.max(MIN_ADAPTIVE_TARGET_BUFFER_TICKS, Math.ceil(Math.max(0, input.atr14Ticks!) * 0.05)),
          )
          : (() => {
            throw new Error("Adaptive target planning requires completed-candle ATR14 ticks or an explicit adaptive target buffer.");
          })()
      )
      : placementMode === "NEAR_SIDE_8_TICKS" ? PROFIT_TARGET_PLACEMENT_TICKS : PROFIT_TARGET_PLACEMENT_TICKS);
  if (!Number.isInteger(targetBufferTicks)
    || targetBufferTicks < 1
    || targetBufferTicks > (placementMode === "NEAR_SIDE_ADAPTIVE_TICKS" ? MAX_ADAPTIVE_TARGET_BUFFER_TICKS : 8)) {
    throw new Error(
      placementMode === "NEAR_SIDE_ADAPTIVE_TICKS"
        ? "Adaptive target buffer must be a whole number between one and two MES ticks."
        : "Target buffer must be a whole number between one and eight MES ticks.",
    );
  }
  const directionalLevels = mergeLevels(input.levels, tickSize)
    .map((level) => {
      const encountered = targetBoundaryForLevel(level, input.direction, input.entryPrice);
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
    .sort((a, b) => a.distancePoints - b.distancePoints || a.id.localeCompare(b.id));
  const availableLevels = directionalLevels
    .filter((level) => level.distancePoints > 0);
  const targetPriceForLevel = (level: FrozenTargetLevel): number => {
    const levelBoundary = targetBoundaryForLevel(level, input.direction, input.entryPrice);
    return placementMode === "EXACT_LEVEL"
      ? levelBoundary
      : nearSideTargetPrice(
        input.direction,
        levelBoundary,
        targetBufferTicks * tickSize,
        tickSize,
      );
  };
  const riskPoints = input.initialRiskPoints ?? null;
  const validRisk = riskPoints !== null && Number.isFinite(riskPoints) && riskPoints > 0;
  const minimumTargetR = validRisk ? 1 : input.contracts === 1 ? 0.75 : input.contracts === 2 ? 0.5 : null;
  const oneRPrice = validRisk
    ? normalizePrice(
      input.direction === "long" ? input.entryPrice + riskPoints : input.entryPrice - riskPoints,
      tickSize,
    )
    : null;
  const maximumSearchDistancePoints = bufferPoints;
  const targetRForLevel = (level: FrozenTargetLevel): number | null => {
    if (!validRisk) return null;
    return Math.abs(targetPriceForLevel(level) - input.entryPrice) / riskPoints;
  };
  const majorLevel = (level: FrozenTargetLevel): boolean => /\b(?:major|support|resistance)\b/i.test(`${level.id} ${level.type}`);
  const skippedLevels: SkippedTargetLevel[] = [];
  for (const level of directionalLevels) {
    if (level.distancePoints <= 0) {
      if (validRisk) skippedLevels.push({ ...level, reason: "TARGET_LEVEL_SKIPPED_WRONG_DIRECTION" });
      continue;
    }
    const target = targetPriceForLevel(level);
    const executableDistancePoints = Math.abs(target - input.entryPrice);
    if (maximumSearchDistancePoints === null || executableDistancePoints > maximumSearchDistancePoints) {
      skippedLevels.push({
        ...level,
        reason: !validRisk
          ? "OUTSIDE_20_POINTS"
          : "TARGET_LEVEL_SKIPPED_BEYOND_ACHIEVABLE_RANGE",
      });
      continue;
    }
    const targetR = targetRForLevel(level);
    if (
      (targetR === null && validRisk)
      || (targetR !== null && targetR < (minimumTargetR ?? 0))
      || (input.direction === "long" ? target <= input.entryPrice : target >= input.entryPrice)
    ) {
      skippedLevels.push({
        ...level,
        reason: !validRisk
          ? "TARGET_NOT_PROFITABLE"
          : majorLevel(level)
          ? "TARGET_LEVEL_SKIPPED_HARD_STRUCTURAL_OBSTRUCTION"
          : "TARGET_LEVEL_SKIPPED_BELOW_1R",
      });
      continue;
    }
  }
  const obstructingLevel = validRisk
    ? directionalLevels.find((level) => {
      const targetR = targetRForLevel(level);
      return level.distancePoints > 0
        && majorLevel(level)
        && targetR !== null
        && targetR > 0
        && targetR < (minimumTargetR ?? 0);
    }) ?? null
    : null;
  const eligible = validRisk
    ? availableLevels.filter((level) => {
      const targetR = targetRForLevel(level);
      return maximumSearchDistancePoints !== null
        && Math.abs(targetPriceForLevel(level) - input.entryPrice) <= maximumSearchDistancePoints
        && targetR !== null
        && targetR >= (minimumTargetR ?? 0)
        && (input.direction === "long" ? targetPriceForLevel(level) > input.entryPrice : targetPriceForLevel(level) < input.entryPrice);
    })
    : availableLevels.filter((level) => {
      const target = targetPriceForLevel(level);
      return level.distancePoints <= bufferPoints
        && (input.direction === "long" ? target > input.entryPrice : target < input.entryPrice);
    });
  const selectedTargetLevel = eligible[0] ?? null;
  const subsequentTargetLevels = eligible.slice(1);
  const targetPrice = obstructingLevel !== null
    ? null
    : selectedTargetLevel === null
      ? oneRPrice
      : targetPriceForLevel(selectedTargetLevel);
  return {
    targetPlanVersion: KEY_LEVEL_TARGET_PLAN_VERSION,
    placementMode,
    disposition: selectedTargetLevel === null ? "NO_ELIGIBLE_KEY_LEVEL" : "KEY_LEVEL_SELECTED",
    entryPrice: normalizePrice(input.entryPrice, tickSize),
    direction: input.direction,
    tickSize,
    bufferTicks,
    bufferPoints,
    placementTicks: targetBufferTicks,
    targetBufferTicks,
    initialRiskPoints: riskPoints,
    targetR: targetPrice === null || !validRisk
      ? null
      : Math.abs(targetPrice - input.entryPrice) / riskPoints,
    minimumTargetR,
    maximumTargetR: null,
    obstructingLevel,
    rejectionReason: obstructingLevel !== null ? "INSUFFICIENT_REWARD_TO_RISK" : null,
    availableLevels,
    skippedLevels,
    selectedTargetLevel,
    subsequentTargetLevels,
    targetPrice,
    fallbackUsed: selectedTargetLevel === null && obstructingLevel === null && oneRPrice !== null,
    fallbackReason: selectedTargetLevel === null && obstructingLevel === null && oneRPrice !== null
      ? "ONE_R_FALLBACK_NO_ELIGIBLE_LEVEL"
      : null,
    searchRangePoints: maximumSearchDistancePoints,
    searchRangeTicks: maximumSearchDistancePoints === null ? null : Math.floor(maximumSearchDistancePoints / tickSize),
    missingSourceTimestampLevelIds: filterEligibleKeyLevelInputs(input.levels)
      .filter((level) => !level.sourceTimestamp)
      .map((level) => level.id)
      .sort(),
  };
}