import type {
  VisualValidationAnnotation,
  VisualValidationCandle,
  VisualValidationCategoryAnchor,
  VisualValidationCategoryCoverage,
  VisualValidationSnapshot,
  VisualValidationTradeEvent,
} from "@workspace/api-client-react";

export const CHART_WIDTH = 1040;
export const CHART_HEIGHT = 748;
export const CHART_LEFT = 58;
export const CHART_RIGHT = 150;
export const CHART_TOP = 112;
export const CHART_PLOT_BOTTOM = 558;
export const CHART_VOLUME_TOP = 582;
export const CHART_VOLUME_HEIGHT = 64;
export const CHART_TIME_TICK_Y = 668;
export const CHART_DATE_LABEL_Y = 702;
export const CHART_FOOTER_LABEL_Y = 730;
export const CHART_EVENT_RAIL_TOP = 3;
export const CHART_EVENT_RAIL_HEIGHT = 96;
export const CHART_EVENT_RAIL_LANE_HEIGHT = 18;
export const CHART_EVENT_RAIL_LANE_COUNT = 4;
export const CANDLE_WINDOW_MIN = 36;
export const CANDLE_WINDOW_MAX = 48;
export const CANDLE_WINDOW_TARGET = 42;
export const CANDLE_PADDING_RATIO = 0.08;
export const DOJI_BODY_HEIGHT = 4;
export const MES_TICK_SIZE = 0.25;
export const PRIMARY_SESSION_START_MINUTES = 9 * 60 + 30;
export const PRIMARY_SESSION_END_MINUTES = 13 * 60;
export const REGULAR_SESSION_END_MINUTES = 16 * 60;
export const PREMARKET_START_MINUTES = 4 * 60;
export const PREMARKET_END_MINUTES = PRIMARY_SESSION_START_MINUTES;
export const PREMARKET_SLOT_COUNT = (PREMARKET_END_MINUTES - PREMARKET_START_MINUTES) / 5;
export const PRIMARY_SLOT_COUNT = (PRIMARY_SESSION_END_MINUTES - PRIMARY_SESSION_START_MINUTES) / 5;
export const REGULAR_SLOT_COUNT = (REGULAR_SESSION_END_MINUTES - PRIMARY_SESSION_START_MINUTES) / 5;

export type FocusedCandle = VisualValidationCandle & {
  machineVisible: boolean;
};

export type SessionView = "primary" | "full_regular";

export type SessionCandle = FocusedCandle & {
  session: "premarket" | "regular";
};

export type SessionCandleSelection = {
  candles: SessionCandle[];
  regularCandles: SessionCandle[];
  premarketCandles: SessionCandle[];
};

export type SessionSlot = {
  index: number;
  label: string;
  session: "premarket" | "regular";
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

export type TimeAxisTick = {
  index: number;
  label: string;
  position?: number;
};

export type PriceAxis = {
  step: number;
  ticks: number[];
};

export type VolumeAxisTick = {
  value: number;
  label: string;
};

export type CategoryCoverageSummary = {
  available: VisualValidationCategoryCoverage[];
  unavailable: VisualValidationCategoryCoverage[];
};

export type CandleInspection = {
  interval: string;
  newYork: string;
  utc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  contractSymbol: string;
  machineVisible: boolean;
};

export type FixedSlotPointerOptions = {
  viewBoxX: number;
  viewBoxY?: number;
  viewBoxWidth: number;
  viewBoxHeight: number;
  plotLeft?: number;
  plotRight?: number;
  plotTop?: number;
  plotBottom?: number;
  interactionRight?: number;
  slotCount: number;
};

export type ChartPointerPosition = {
  x: number;
  y: number;
  slot: number;
  price: number;
};

export const INTRADAY_REFERENCE_PRESENTATION = {
  "previous-session-high": { label: "Previous-day high", color: "hsl(145 55% 36%)" },
  "previous-session-low": { label: "Previous-day low", color: "hsl(145 55% 36%)" },
  "two-sessions-high": { label: "Two-days-ago high", color: "hsl(270 55% 48%)" },
  "two-sessions-low": { label: "Two-days-ago low", color: "hsl(270 55% 48%)" },
} as const;

/**
 * Resolve a pointer against the fixed timestamp grid, not against observed
 * candles. The caller passes the SVG viewBox currently in use so zoom and pan
 * are inverted before plot/gutter bounds are checked.
 */
export function resolveFixedSlotFromClientPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  options: FixedSlotPointerOptions,
): number | null {
  const viewBoxY = options.viewBoxY ?? 0;
  const plotLeft = options.plotLeft ?? CHART_LEFT;
  const plotRight = options.plotRight ?? CHART_WIDTH - CHART_RIGHT;
  const plotTop = options.plotTop ?? CHART_TOP;
  const plotBottom = options.plotBottom ?? CHART_VOLUME_TOP + CHART_VOLUME_HEIGHT;
  if (
    !Number.isFinite(clientX)
    || !Number.isFinite(clientY)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
    || options.viewBoxWidth <= 0
    || options.viewBoxHeight <= 0
    || options.slotCount <= 0
  ) return null;

  // preserveAspectRatio="xMidYMid meet" letterboxes the viewBox when the
  // rendered SVG and viewBox have different aspect ratios.
  const scale = Math.min(rect.width / options.viewBoxWidth, rect.height / options.viewBoxHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const renderedWidth = options.viewBoxWidth * scale;
  const renderedHeight = options.viewBoxHeight * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  const svgX = options.viewBoxX + (clientX - rect.left - offsetX) / scale;
  const svgY = viewBoxY + (clientY - rect.top - offsetY) / scale;
  if (svgX < plotLeft || svgX >= plotRight || svgY < plotTop || svgY >= plotBottom) return null;

  const step = (plotRight - plotLeft) / options.slotCount;
  const slot = Math.floor((svgX - plotLeft) / step);
  return slot >= 0 && slot < options.slotCount ? slot : null;
}

export function resolveChartPointerFromClientPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  options: FixedSlotPointerOptions & { domain: ChartDomain },
): ChartPointerPosition | null {
  const viewBoxY = options.viewBoxY ?? 0;
  const plotLeft = options.plotLeft ?? CHART_LEFT;
  const plotRight = options.plotRight ?? CHART_WIDTH - CHART_RIGHT;
  const plotTop = options.plotTop ?? CHART_TOP;
  const plotBottom = options.plotBottom ?? CHART_PLOT_BOTTOM;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / options.viewBoxWidth, rect.height / options.viewBoxHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offsetX = (rect.width - options.viewBoxWidth * scale) / 2;
  const offsetY = (rect.height - options.viewBoxHeight * scale) / 2;
  const x = options.viewBoxX + (clientX - rect.left - offsetX) / scale;
  const y = viewBoxY + (clientY - rect.top - offsetY) / scale;
  if (x < plotLeft || x > (options.interactionRight ?? plotRight) || y < plotTop || y > plotBottom) return null;
  const step = (plotRight - plotLeft) / options.slotCount;
  const slot = Math.min(options.slotCount - 1, Math.max(0, Math.floor((x - plotLeft) / step)));
  const rawPrice = options.domain.max - ((y - plotTop) / Math.max(plotBottom - plotTop, 1)) * (options.domain.max - options.domain.min);
  return { x, y, slot, price: snapPrice(rawPrice) };
}

export type EventRailEventKind =
  | "found"
  | "evaluation"
  | "patience"
  | "entry"
  | "fill"
  | "invalidation"
  | "stop"
  | "target"
  | "runner"
  | "exit"
  | "supporting";

export type EventRailEvent = {
  id: string;
  kind: EventRailEventKind;
  label: string;
  shortLabel: string;
  detail: string;
  openTime: string | null;
  closeTime: string | null;
  price: number | null;
  visibility: "machine" | "human_only";
  priority: number;
  markerSlot: number | null;
};

export type EventRailPlacedEvent = EventRailEvent & {
  order: number;
  lane: number;
  labelX: number;
  labelY: number;
  labelWidth: number;
  markerX: number;
  overflow: boolean;
};

export type EventRailLayout = {
  events: EventRailPlacedEvent[];
  laneCount: number;
  hasOverflow: boolean;
};

export type EventRailLayoutOptions = {
  left?: number;
  right?: number;
  slotCount?: number;
  cursorX?: number;
  cursorWidth?: number;
  laneCount?: number;
  laneTop?: number;
  laneHeight?: number;
  labelGap?: number;
};

/** The compact evidence item used by the chart and its ordered index. */
export type ChartEvent = EventRailEvent & {
  number: number;
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

export function isExactFiveMinuteCandle(candle: VisualValidationCandle): boolean {
  const open = timestamp(candle.openTime);
  const close = timestamp(candle.closeTime);
  const interval = close - open;
  return candle.isComplete
    && Number.isFinite(open)
    && Number.isFinite(close)
    && open % (5 * 60_000) === 0
    && interval === 5 * 60_000
    && isValidRawCandle(candle);
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
    return isExactFiveMinuteCandle(candle)
      && Number.isFinite(close)
      && (!Number.isFinite(review) || close <= review);
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

function localMinutes(value: string, timeZone = "America/New_York"): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function sessionForCandle(candle: VisualValidationCandle): "premarket" | "regular" | null {
  const open = localMinutes(candle.openTime);
  const close = localMinutes(candle.closeTime);
  if (open >= PREMARKET_START_MINUTES && close <= PREMARKET_END_MINUTES) return "premarket";
  if (open >= PRIMARY_SESSION_START_MINUTES && close <= REGULAR_SESSION_END_MINUTES) return "regular";
  return null;
}

export function selectSessionCandles(
  rawCandles: readonly VisualValidationCandle[],
  evaluationCloseTime: string,
  reviewCloseTime: string,
  view: SessionView = "primary",
  showPremarket = false,
): SessionCandleSelection {
  const evaluation = timestamp(evaluationCloseTime);
  const review = timestamp(reviewCloseTime);
  const regularEnd = view === "primary" ? PRIMARY_SESSION_END_MINUTES : REGULAR_SESSION_END_MINUTES;
  const regularCandles: SessionCandle[] = [];
  const premarketCandles: SessionCandle[] = [];

  for (const candle of rawCandles) {
    if (!isExactFiveMinuteCandle(candle)) continue;
    const close = timestamp(candle.closeTime);
    if (!Number.isFinite(close) || (Number.isFinite(review) && close > review)) continue;
    const session = sessionForCandle(candle);
    if (session === "regular" && localMinutes(candle.closeTime) <= regularEnd) {
      regularCandles.push({ ...candle, machineVisible: close <= evaluation, session });
    } else if (session === "premarket" && showPremarket) {
      premarketCandles.push({ ...candle, machineVisible: close <= evaluation, session });
    }
  }

  regularCandles.sort((first, second) => timestamp(first.openTime) - timestamp(second.openTime));
  premarketCandles.sort((first, second) => timestamp(first.openTime) - timestamp(second.openTime));
  return {
    candles: [...premarketCandles, ...regularCandles],
    regularCandles,
    premarketCandles,
  };
}

export function getSessionSlotCount(view: SessionView): number {
  return view === "primary" ? PRIMARY_SLOT_COUNT : REGULAR_SLOT_COUNT;
}

export function getSessionDomainSlotCount(view: SessionView, showPremarket = false): number {
  return getSessionSlotCount(view) + (showPremarket ? PREMARKET_SLOT_COUNT : 0);
}

export function getCandleSlotIndex(
  candle: Pick<VisualValidationCandle, "openTime">,
  view: SessionView,
  showPremarket = false,
): number {
  const minutes = localMinutes(candle.openTime);
  if (showPremarket && minutes >= PREMARKET_START_MINUTES && minutes < PREMARKET_END_MINUTES) {
    return Math.floor((minutes - PREMARKET_START_MINUTES) / 5);
  }
  return (showPremarket ? PREMARKET_SLOT_COUNT : 0) + Math.floor((minutes - PRIMARY_SESSION_START_MINUTES) / 5);
}

function formatWallClockMinute(minutes: number): string {
  const normalized = ((minutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function getFixedTimeAxisTicks(
  view: SessionView,
  showPremarket = false,
): TimeAxisTick[] {
  const ticks: TimeAxisTick[] = [];
  if (showPremarket) {
    for (let minute = PREMARKET_START_MINUTES; minute < PREMARKET_END_MINUTES; minute += 60) {
      ticks.push({
        index: Math.floor((minute - PREMARKET_START_MINUTES) / 5),
        position: Math.floor((minute - PREMARKET_START_MINUTES) / 5) + 0.5,
        label: formatWallClockMinute(minute),
      });
    }
  }
  const offset = showPremarket ? PREMARKET_SLOT_COUNT : 0;
  const sessionEnd = view === "primary" ? PRIMARY_SESSION_END_MINUTES : REGULAR_SESSION_END_MINUTES;
  const tickInterval = view === "primary" ? 15 : 30;
  for (let minute = PRIMARY_SESSION_START_MINUTES; minute < sessionEnd; minute += tickInterval) {
    const slot = Math.floor((minute - PRIMARY_SESSION_START_MINUTES) / 5);
    ticks.push({
      index: offset + slot,
      position: offset + slot + 0.5,
      label: formatWallClockMinute(minute),
    });
  }
  ticks.push({
    index: offset + getSessionSlotCount(view),
    position: offset + getSessionSlotCount(view),
    label: formatWallClockMinute(sessionEnd),
  });
  return ticks;
}

export function isOpeningRangeCompleteAtEvaluation(
  regularCandles: readonly Pick<VisualValidationCandle, "closeTime">[],
  evaluationCloseTime: string,
): boolean {
  const evaluation = timestamp(evaluationCloseTime);
  return regularCandles.length >= 3
    && Number.isFinite(evaluation)
    && regularCandles.slice(0, 3).every((candle) => timestamp(candle.closeTime) <= evaluation);
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

function formatHourMinute(value: string, timeZone: "America/New_York" | "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

export function formatInterval(value: string, closeValue: string, timeZone: "America/New_York" | "UTC" = "America/New_York"): string {
  const zoneLabel = timeZone === "America/New_York" ? " ET" : " UTC";
  return `${formatHourMinute(value, timeZone)}–${formatHourMinute(closeValue, timeZone)}${zoneLabel}`;
}

export function formatAxisDate(value: string, timeZone: "America/New_York" | "UTC" = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function getTimeAxisTicks(
  candles: readonly VisualValidationCandle[],
  timeZone: "America/New_York" | "UTC" = "America/New_York",
  includeCloseBoundary = false,
): TimeAxisTick[] {
  const ticks = candles.reduce<TimeAxisTick[]>((result, candle, index) => {
    const date = new Date(candle.openTime);
    const minute = Number(new Intl.DateTimeFormat("en-US", {
      timeZone,
      minute: "numeric",
    }).format(date));
    if (minute % 15 === 0) {
      result.push({ index, position: index + 0.5, label: formatHourMinute(candle.openTime, timeZone) });
    }
    return result;
  }, []);
  if (includeCloseBoundary && candles.length) {
    const last = candles[candles.length - 1];
    ticks.push({
      index: candles.length,
      position: candles.length,
      label: formatHourMinute(last.closeTime, timeZone),
    });
  }
  return ticks;
}

export function snapPrice(price: number, tickSize = MES_TICK_SIZE): number {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(2));
}

const PRICE_STEPS = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];

export function getPriceAxis(
  domain: ChartDomain,
  tickSize = MES_TICK_SIZE,
  targetCount = 8,
): PriceAxis {
  const range = Math.max(domain.max - domain.min, tickSize);
  const candidates = PRICE_STEPS.filter((step) => step >= tickSize);
  const step = candidates.reduce((best, candidate) => {
    const bestCount = Math.round(range / best);
    const candidateCount = Math.round(range / candidate);
    const bestDistance = Math.abs(bestCount - targetCount);
    const candidateDistance = Math.abs(candidateCount - targetCount);
    return candidateDistance < bestDistance ? candidate : best;
  }, candidates[0] ?? tickSize);
  const first = Math.floor(domain.min / step) * step;
  const last = Math.ceil(domain.max / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= last + step / 2; value += step) {
    ticks.push(snapPrice(value, tickSize));
  }
  if (ticks.length < 6) {
    const center = snapPrice((domain.min + domain.max) / 2, tickSize);
    const minimumStart = center - step * 3;
    return {
      step,
      ticks: Array.from({ length: 7 }, (_, index) => snapPrice(minimumStart + index * step, tickSize)),
    };
  }
  return { step, ticks };
}

export function formatPriceAxisValue(value: number): string {
  return snapPrice(value).toFixed(2);
}

export function getCandleInspection(candle: FocusedCandle): CandleInspection {
  return {
    interval: formatInterval(candle.openTime, candle.closeTime),
    newYork: formatCandleTime(candle.openTime, "America/New_York"),
    utc: formatCandleTime(candle.openTime, "UTC"),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    contractSymbol: candle.contractSymbol,
    machineVisible: candle.machineVisible,
  };
}

function niceVolumeStep(max: number): number {
  const rough = Math.max(max / 3, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

export function getVolumeAxisTicks(maxVolume: number): VolumeAxisTick[] {
  const step = niceVolumeStep(maxVolume);
  return [0, step, step * 2, step * 3].map((value) => ({
    value,
    label: value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : Math.round(value).toString(),
  }));
}

export function getDateLabel(candles: readonly VisualValidationCandle[], timeZone: "America/New_York" | "UTC" = "America/New_York"): string {
  return candles[0] ? formatAxisDate(candles[0].openTime, timeZone) : "";
}

export function summarizeCategoryCoverage(
  coverage: readonly VisualValidationCategoryCoverage[],
): CategoryCoverageSummary {
  return {
    available: coverage.filter((item) => item.available && item.count > 0),
    unavailable: coverage.filter((item) => !item.available || item.count === 0),
  };
}

export function isDisplacedLabel(labelY: number, valueY: number, threshold = 2): boolean {
  return Math.abs(labelY - valueY) > threshold;
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
  return annotations.reduce<EdgeIndicator[]>((indicators, annotation) => {
    if (!annotation.available || annotation.price == null) return indicators;
    if (annotation.price > domain.max) indicators.push({ annotation, edge: "top" });
    if (annotation.price < domain.min) indicators.push({ annotation, edge: "bottom" });
    return indicators;
  }, []);
}

export function stackLabelPositions(
  labels: ReadonlyArray<{ id: string; y: number }>,
  minY = CHART_TOP + 10,
  maxY = CHART_PLOT_BOTTOM - 4,
  gap = 15,
): LabelPosition[] {
  if (!labels.length) return [];
  const ordered = labels
    .map((label) => ({ id: label.id, y: Math.max(minY, Math.min(maxY, label.y)) }))
    .sort((first, second) => first.y - second.y);
  const effectiveGap = ordered.length > 1
    ? Math.min(gap, (maxY - minY) / (ordered.length - 1))
    : gap;
  return ordered.map((label, index) => ({
    id: label.id,
    y: minY + index * effectiveGap,
  }));
}

export function findCandleIndexAtTimestamp(
  candles: readonly VisualValidationCandle[],
  value: string | null | undefined,
): number {
  const target = timestamp(value);
  if (!Number.isFinite(target)) return -1;
  const openIndex = candles.findIndex((candle) => timestamp(candle.openTime) === target);
  if (openIndex >= 0) return openIndex;
  return candles.findIndex((candle) => timestamp(candle.closeTime) === target);
}

const EVENT_RAIL_PRIORITY: Record<EventRailEventKind, number> = {
  found: 1,
  entry: 4,
  fill: 2,
  exit: 2,
  patience: 3,
  invalidation: 5,
  stop: 5,
  target: 5,
  runner: 5,
  supporting: 6,
  evaluation: 7,
};

function railKindForTradeEvent(event: VisualValidationTradeEvent): EventRailEventKind {
  if (event.event === "entry") return "entry";
  if (event.event === "fill") return "fill";
  if (event.event === "stop") return "stop";
  if (event.event === "target") return "target";
  if (event.event.includes("runner")) return "runner";
  if (event.event === "exit") return "exit";
  return "supporting";
}

function railShortLabel(kind: EventRailEventKind, eventName?: string): string {
  if (kind === "found") return "F";
  if (kind === "evaluation") return "EVAL";
  if (kind === "patience") return "P";
  if (kind === "entry" || kind === "fill") return "E";
  if (kind === "invalidation") return "X";
  if (kind === "stop") return "S";
  if (kind === "target") return "TP";
  if (kind === "runner") return eventName?.includes("exit") ? "RX" : "RA";
  if (kind === "exit") return "X";
  return "·";
}

function railMarkerSlot(
  candles: readonly VisualValidationCandle[],
  value: string | null | undefined,
  sessionView: SessionView,
): number | null {
  const index = findCandleIndexAtTimestamp(candles, value);
  return index < 0 ? null : getCandleSlotIndex(candles[index]!, sessionView);
}

export function buildEventRailEvents(
  snapshot: VisualValidationSnapshot,
  candles: readonly VisualValidationCandle[],
  sessionView: SessionView,
): EventRailEvent[] {
  const events: EventRailEvent[] = [];
  const add = (event: Omit<EventRailEvent, "priority" | "markerSlot">) => {
    events.push({
      ...event,
      priority: EVENT_RAIL_PRIORITY[event.kind],
      markerSlot: railMarkerSlot(candles, event.openTime ?? event.closeTime, sessionView),
    });
  };

  add({
    id: `anchor-${snapshot.categoryAnchor.auditId}`,
    kind: "found",
    label: snapshot.categoryAnchor.label,
    shortLabel: railShortLabel("found"),
    detail: snapshot.categoryAnchor.detail,
    openTime: snapshot.categoryAnchor.openTime,
    closeTime: snapshot.categoryAnchor.closeTime,
    price: snapshot.categoryAnchor.price,
    visibility: snapshot.categoryAnchor.visibility,
  });

  for (const related of snapshot.categoryAnchor.relatedCandles) {
    add({
      id: `anchor-${related.role}-${related.openTime}`,
      kind: related.role,
      label: `${related.role === "evaluation" ? "Evaluation" : related.role[0]!.toUpperCase() + related.role.slice(1)} candle`,
      shortLabel: railShortLabel(related.role),
      detail: `${related.visibility} related candle`,
      openTime: related.openTime,
      closeTime: related.closeTime,
      price: related.price,
      visibility: related.visibility,
    });
  }

  for (const tradeEvent of snapshot.tradeEvents) {
    const kind = railKindForTradeEvent(tradeEvent);
    add({
      id: `trade-${tradeEvent.id}`,
      kind,
      label: tradeEvent.label,
      shortLabel: railShortLabel(kind, tradeEvent.event),
      detail: tradeEvent.detail,
      openTime: tradeEvent.openTime,
      closeTime: tradeEvent.closeTime,
      price: tradeEvent.modeledPrice ?? tradeEvent.triggerPrice,
      visibility: tradeEvent.visibility,
    });
  }

  for (const annotation of snapshot.annotations) {
    if (!annotation.available) continue;
    if (!hasExactCandleAnchor(annotation)) continue;
    const duplicateEventIds = ["patience-candle", "entry-candle", "immediate-trigger", "entry-trigger", "modeled-fill"];
    if (duplicateEventIds.includes(annotation.id)) continue;
    const kind: EventRailEventKind = annotation.id === "strategy-stop" || annotation.id === "catastrophe-stop"
      ? "invalidation"
      : annotation.id === "target"
        ? "target"
        : annotation.id === "runner-threshold"
          ? "runner"
          : annotation.kind === "candle"
            ? "supporting"
            : "supporting";
    if (annotation.kind !== "candle" && !["strategy-stop", "catastrophe-stop", "target", "runner-threshold"].includes(annotation.id)) continue;
    add({
      id: `annotation-${annotation.id}`,
      kind,
      label: annotation.label,
      shortLabel: railShortLabel(kind),
      detail: annotation.detail,
      openTime: annotation.openTime,
      closeTime: annotation.closeTime,
      price: annotation.price,
      visibility: annotation.visibility,
    });
  }

  return events;
}

const CATEGORY_EVENT_KINDS: Record<string, readonly EventRailEventKind[]> = {
  qualified_trade: ["found", "evaluation", "patience", "entry", "fill", "invalidation", "stop", "target", "runner", "exit"],
  rejected_setup: ["found", "evaluation", "patience", "entry", "invalidation", "supporting"],
  bullish_patience_candle: ["found", "evaluation", "patience", "entry", "supporting"],
  bearish_patience_candle: ["found", "evaluation", "patience", "entry", "supporting"],
  weak_orb_probe: ["found", "evaluation", "entry", "invalidation", "supporting"],
  strong_breakout: ["found", "evaluation", "entry", "supporting"],
  pullback: ["found", "evaluation", "entry", "supporting"],
  consolidation: ["found", "evaluation", "supporting"],
  ambiguous_candle: ["found", "evaluation", "supporting"],
  stop_exit: ["found", "evaluation", "stop", "exit", "invalidation"],
  target_exit: ["found", "evaluation", "target", "exit"],
  runner_exit: ["found", "evaluation", "runner", "exit"],
};

function compareChartEvents(first: EventRailEvent, second: EventRailEvent): number {
  return eventTime(first) - eventTime(second)
    || first.priority - second.priority
    || first.id.localeCompare(second.id);
}

/**
 * Build the complete event set without changing any source timestamps or prices.
 * This remains presentation-only; the API's immutable evidence is the source of truth.
 */
export function buildChartEvents(
  snapshot: VisualValidationSnapshot,
  candles: readonly VisualValidationCandle[],
  sessionView: SessionView,
): EventRailEvent[] {
  return buildEventRailEvents(snapshot, candles, sessionView).sort(compareChartEvents);
}

/**
 * Select the category's causal story by default. The explicit all-events state is
 * intentionally opt-in so unrelated audit noise never competes with the category.
 */
export function selectChartEvents(
  snapshot: VisualValidationSnapshot,
  candles: readonly VisualValidationCandle[],
  sessionView: SessionView,
  showAllAuditEvents = false,
): ChartEvent[] {
  const allEvents = buildChartEvents(snapshot, candles, sessionView);
  const allowed = new Set(CATEGORY_EVENT_KINDS[snapshot.category] ?? ["found", "evaluation"]);
  const selected = showAllAuditEvents
    ? allEvents
    : allEvents.filter((event) => allowed.has(event.kind));
  return selected.map((event, index) => ({ ...event, number: index + 1 }));
}

/**
 * ORB and NTZ are two engine-facing names for the same first-three-candle
 * boundaries. Keep the source annotations intact and collapse only their
 * chart presentation into one labeled pair.
 */
export function mergeOrbNtzAnnotations(
  annotations: readonly VisualValidationAnnotation[],
): VisualValidationAnnotation[] {
  const aliases: Array<{ side: "High" | "Low"; ids: string[] }> = [
    { side: "High", ids: ["orb-high", "ntz-high"] },
    { side: "Low", ids: ["orb-low", "ntz-low"] },
  ];
  const merged = aliases.flatMap(({ side, ids }) => {
    const source = annotations.find((annotation) => ids.includes(annotation.id) && annotation.available && annotation.price != null);
    return source
      ? [{ ...source, id: ids[0], label: `ORB / NTZ ${side}` }]
      : [];
  });
  return [
    ...annotations.filter((annotation) => !aliases.some(({ ids }) => ids.includes(annotation.id))),
    ...merged,
  ];
}

export function hasExactCandleAnchor(annotation: Pick<VisualValidationAnnotation, "openTime" | "closeTime">): boolean {
  return Boolean(annotation.openTime || annotation.closeTime);
}

function eventTime(event: EventRailEvent): number {
  return timestamp(event.openTime ?? event.closeTime);
}

function eventLabelWidth(event: EventRailEvent): number {
  return Math.max(58, Math.min(176, 25 + event.label.length * 5.4));
}

function intervalsOverlap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number, gap: number): boolean {
  return firstStart < secondEnd + gap && secondStart < firstEnd + gap;
}

export function layoutEventRail(
  events: readonly EventRailEvent[],
  options: EventRailLayoutOptions = {},
): EventRailLayout {
  const left = options.left ?? CHART_LEFT;
  const right = options.right ?? CHART_WIDTH - CHART_RIGHT - 8;
  const slotCount = Math.max(options.slotCount ?? PRIMARY_SLOT_COUNT, 1);
  const cursorWidth = options.cursorWidth ?? 124;
  const laneCount = Math.max(options.laneCount ?? CHART_EVENT_RAIL_LANE_COUNT, 1);
  const laneTop = options.laneTop ?? CHART_EVENT_RAIL_TOP + 23;
  const laneHeight = options.laneHeight ?? CHART_EVENT_RAIL_LANE_HEIGHT;
  const labelGap = options.labelGap ?? 8;
  const cursorX = options.cursorX;
  const cursorStart = cursorX == null ? Number.POSITIVE_INFINITY : cursorX - cursorWidth / 2;
  const cursorEnd = cursorX == null ? Number.NEGATIVE_INFINITY : cursorX + cursorWidth / 2;
  const occupied: Array<Array<{ start: number; end: number }>> = Array.from({ length: laneCount }, () => []);
  const sorted = [...events].sort((first, second) =>
    eventTime(first) - eventTime(second)
    || first.priority - second.priority
    || first.id.localeCompare(second.id));
  const placed = sorted.map((event, order) => {
    const markerX = event.markerSlot == null
      ? right
      : left + ((event.markerSlot + 0.5) / slotCount) * (right - left);
    const labelWidth = event.visibility === "human_only" && cursorX != null && right - cursorX - labelGap >= 44
      ? Math.min(eventLabelWidth(event), right - cursorX - labelGap)
      : eventLabelWidth(event);
    const centeredLabelX = Math.max(left, Math.min(markerX - labelWidth / 2, right - labelWidth));
    const humanSideLabelX = cursorX == null
      ? centeredLabelX
      : Math.max(centeredLabelX, Math.min(cursorX + labelGap, right - labelWidth));
    const labelX = event.visibility === "human_only" ? humanSideLabelX : centeredLabelX;
    const labelStart = labelX;
    const labelEnd = labelX + labelWidth;
    let lane = -1;
    for (let candidate = 0; candidate < laneCount; candidate += 1) {
      const cursorConflict = candidate === 0 && cursorX != null && intervalsOverlap(labelStart, labelEnd, cursorStart, cursorEnd, labelGap);
      const labelConflict = occupied[candidate]!.some((interval) => intervalsOverlap(labelStart, labelEnd, interval.start, interval.end, labelGap));
      if (!cursorConflict && !labelConflict) {
        lane = candidate;
        break;
      }
    }
    const overflow = lane < 0;
    if (overflow) lane = laneCount - 1;
    occupied[lane]!.push({ start: labelStart, end: labelEnd });
    return {
      ...event,
      order,
      lane,
      labelX,
      labelY: laneTop + lane * laneHeight,
      labelWidth,
      markerX,
      overflow,
    };
  });
  return {
    events: placed,
    laneCount,
    hasOverflow: placed.some((event) => event.overflow),
  };
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
  return /^(premarket-high|premarket-low|orb-high|orb-low|ntz-high|ntz-low|vwap|ema-200|critical-|entry-buffer|strategy-stop|catastrophe-stop|target$|runner-threshold)/i.test(annotation.id);
}