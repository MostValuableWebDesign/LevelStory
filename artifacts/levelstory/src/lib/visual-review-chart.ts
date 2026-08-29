import type { VisualValidationAnnotation, VisualValidationCandle } from "@workspace/api-client-react";

export const CHART_WIDTH = 1040;
export const CHART_HEIGHT = 430;
export const CHART_LEFT = 58;
export const CHART_RIGHT = 34;
export const CHART_TOP = 30;
export const CHART_PLOT_BOTTOM = 306;
export const CHART_VOLUME_TOP = 326;
export const CHART_VOLUME_HEIGHT = 34;
export const CANDLE_WINDOW_MIN = 30;
export const CANDLE_WINDOW_MAX = 50;
export const CANDLE_WINDOW_TARGET = 40;
export const CANDLE_PADDING_RATIO = 0.08;
export const DOJI_BODY_HEIGHT = 4;

export type FocusedCandle = VisualValidationCandle & {
  machineVisible: boolean;
};

export type ChartDomain = {
  min: number;
  max: number;
  rawMin: number;
  rawMax: number;
  padding: number;
};

export type CandleGeometry = {
  x: number;
  openY: number;
  highY: number;
  lowY: number;
  closeY: number;
  bodyTop: number;
  bodyHeight: number;
};

export type Edge = "top" | "bottom";

export type EdgeIndicator = {
  annotation: VisualValidationAnnotation;
  edge: Edge;
};

export type LabelPosition = {
  id: string;
  y: number;
};

function finitePrices(candles: readonly VisualValidationCandle[]): number[] {
  return candles.flatMap((candle) => [candle.high, candle.low]).filter(Number.isFinite);
}

function timestamp(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

export function isValidRawCandle(candle: VisualValidationCandle): boolean {
  return candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite);
}

export function invalidRawCandleIndices(candles: readonly VisualValidationCandle[]): number[] {
  return candles.reduce<number[]>((indices, candle, index) => {
    if (!isValidRawCandle(candle)) indices.push(index);
    return indices;
  }, []);
}

export function selectFocusedCandles(
  rawCandles: readonly VisualValidationCandle[],
  evaluationCloseTime: string,
  reviewCloseTime: string,
  target = CANDLE_WINDOW_TARGET,
): FocusedCandle[] {
  const evaluation = timestamp(evaluationCloseTime);
  const review = timestamp(reviewCloseTime);
  const boundedCandles = rawCandles.filter((candle) => {
    const close = timestamp(candle.closeTime);
    return Number.isFinite(close) && (!Number.isFinite(review) || close <= review);
  });

  if (!boundedCandles.length) return [];

  const evaluationIndex = boundedCandles.reduce((last, candle, index) => (
    timestamp(candle.closeTime) <= evaluation ? index : last
  ), -1);
  const safeTarget = Math.max(CANDLE_WINDOW_MIN, Math.min(CANDLE_WINDOW_MAX, target));
  const count = Math.min(safeTarget, boundedCandles.length);
  const anchor = evaluationIndex >= 0 ? evaluationIndex : Math.min(Math.floor(boundedCandles.length / 2), boundedCandles.length - 1);
  const beforeCount = Math.min(30, anchor + 1);
  const start = Math.max(0, Math.min(anchor - beforeCount + 1, boundedCandles.length - count));
  const focused = boundedCandles.slice(start, start + count);

  return focused.map((candle) => ({
    ...candle,
    machineVisible: timestamp(candle.closeTime) <= evaluation,
  }));
}

export function getCandleDomain(
  candles: readonly VisualValidationCandle[],
  paddingRatio = CANDLE_PADDING_RATIO,
): ChartDomain {
  const prices = finitePrices(candles);
  if (!prices.length) return { min: 0, max: 1, rawMin: 0, rawMax: 1, padding: 0.5 };
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const rawSpan = rawMax - rawMin;
  const padding = rawSpan > 0
    ? rawSpan * paddingRatio
    : Math.max(Math.abs(rawMax) * 0.005, 0.01);
  return {
    min: rawMin - padding,
    max: rawMax + padding,
    rawMin,
    rawMax,
    padding,
  };
}

export function priceToY(price: number, domain: ChartDomain, top = CHART_TOP, bottom = CHART_PLOT_BOTTOM): number {
  return bottom - ((price - domain.min) / Math.max(domain.max - domain.min, 0.01)) * (bottom - top);
}

export function getCandleGeometry(
  candle: VisualValidationCandle,
  index: number,
  step: number,
  domain: ChartDomain,
  left = CHART_LEFT,
): CandleGeometry {
  const openY = priceToY(candle.open, domain);
  const highY = priceToY(candle.high, domain);
  const lowY = priceToY(candle.low, domain);
  const closeY = priceToY(candle.close, domain);
  return {
    x: left + index * step + step / 2,
    openY,
    highY,
    lowY,
    closeY,
    bodyTop: Math.min(openY, closeY),
    bodyHeight: Math.max(Math.abs(closeY - openY), DOJI_BODY_HEIGHT),
  };
}

export function getEdgeIndicators(
  annotations: readonly VisualValidationAnnotation[],
  domain: ChartDomain,
): EdgeIndicator[] {
  return annotations.flatMap((annotation) => {
    if (!annotation.available || annotation.price == null) return [];
    if (annotation.price > domain.max) return [{ annotation, edge: "top" }];
    if (annotation.price < domain.min) return [{ annotation, edge: "bottom" }];
    return [];
  });
}

export function stackLabelPositions(
  labels: readonly Array<{ id: string; y: number }>,
  minY = CHART_TOP + 10,
  maxY = CHART_PLOT_BOTTOM - 4,
  gap = 15,
): LabelPosition[] {
  if (!labels.length) return [];
  const ordered = labels
    .map((label) => ({ id: label.id, y: Math.max(minY, Math.min(maxY, label.y)) }))
    .sort((first, second) => first.y - second.y);
  const positioned: LabelPosition[] = [];
  let nextY = minY;
  for (const label of ordered) {
    const y = Math.max(label.y, nextY);
    positioned.push({ id: label.id, y });
    nextY = y + gap;
  }
  const overflow = Math.max(0, (positioned.at(-1)?.y ?? maxY) - maxY);
  return positioned.map((label) => ({ ...label, y: Math.max(minY, label.y - overflow) }));
}

export function findCandleIndexAtTimestamp(
  candles: readonly VisualValidationCandle[],
  value: string | null | undefined,
): number {
  const target = timestamp(value);
  if (!Number.isFinite(target)) return -1;
  return candles.findIndex((candle) => (
    timestamp(candle.openTime) === target || timestamp(candle.closeTime) === target
  ));
}

export function hasRepetitiveFixtureData(candles: readonly VisualValidationCandle[]): boolean {
  if (candles.length < 6) return false;
  let longestRun = 1;
  let currentRun = 1;
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    const same = previous.open === current.open
      && previous.high === current.high
      && previous.low === current.low
      && previous.close === current.close;
    currentRun = same ? currentRun + 1 : 1;
    longestRun = Math.max(longestRun, currentRun);
  }
  const narrowBodyCount = candles.filter((candle) => {
    const range = candle.high - candle.low;
    return range > 0 && Math.abs(candle.close - candle.open) / range <= 0.08;
  }).length;
  return longestRun >= 3 || narrowBodyCount / candles.length >= 0.8;
}

export function formatCandleTime(value: string, timeZone: "America/New_York" | "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(value));
}

export function formatDataSource(source: string, contractSymbol?: string): string {
  if (source === "simulated") return "Simulated fixture data";
  if (source === "historical_databento" || source === "historical_databento_multicontract") {
    return `Historical Databento data${contractSymbol ? ` — ${contractSymbol}` : ""}`;
  }
  return source;
}

export function isPrimaryLevel(annotation: VisualValidationAnnotation): boolean {
  return /^(orb-high|orb-low|ntz-high|ntz-low|vwap|ema-200|critical-|entry-buffer|strategy-stop|catastrophe-stop|target$|runner-threshold)/i.test(annotation.id);
}