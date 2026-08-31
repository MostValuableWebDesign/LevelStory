import { createHash } from "node:crypto";
import type { SimulatedHourlyCandle } from "../futures/simulated-feed.js";

export type LongTermZoneRole = "support" | "resistance" | "role-flip";
export type LongTermLookback = "six-month" | "one-year";

export type LongTermZoneTouch = {
  tradingDate: string;
  timestamp: number;
  pivotTimestamp: number;
  role: "support" | "resistance";
  price: number;
};

export type LongTermZone = {
  id: string;
  lower: number;
  upper: number;
  midpoint: number;
  role: LongTermZoneRole;
  lookback: LongTermLookback;
  touchCount: number;
  independentTradingDates: string[];
  firstTimestamp: number;
  latestTimestamp: number;
  sourcePivotTimestamps: number[];
  touches: LongTermZoneTouch[];
  strength: "verified" | "strong";
  detectorVersion: string;
  configurationHash: string;
};

const DETECTOR_VERSION = "hourly-causal-zones-v1";
const cache = new Map<string, LongTermZone[]>();

export function detectLongTermZones(
  bars: readonly SimulatedHourlyCandle[],
  options: {
    cursor?: number;
    tickSize?: number;
    widthTicks?: number;
    lookback: LongTermLookback;
    configurationHash?: string;
    seriesIdentity?: string;
  },
): LongTermZone[] {
  const tickSize = options.tickSize ?? 0.25;
  const widthTicks = options.widthTicks ?? 12;
  const cursor = options.cursor ?? Number.POSITIVE_INFINITY;
  const configurationHash = options.configurationHash ?? createHash("sha256")
    .update(`${DETECTOR_VERSION}|${tickSize}|${widthTicks}`)
    .digest("hex");
  const windowMs = options.lookback === "six-month" ? 183 : 366;
  const visible = bars.filter((bar) => bar.isComplete && bar.closeTime <= cursor)
    .sort((a, b) => a.openTime - b.openTime);
  const end = visible.at(-1)?.closeTime ?? cursor;
  const start = end - windowMs * 86_400_000;
  const scoped = visible.filter((bar) => bar.closeTime >= start);
  const contentFingerprint = createHash("sha256").update(scoped.map((bar) =>
    `${bar.openTime},${bar.closeTime},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`,
  ).join("|")).digest("hex");
  const key = `${options.seriesIdentity ?? "unknown-series"}|${contentFingerprint}|${configurationHash}|${options.lookback}|${start}|${end}`;
  const cached = cache.get(key);
  if (cached) return cached.map((zone) => ({ ...zone, touches: zone.touches.map((touch) => ({ ...touch })) }));

  const pivots: LongTermZoneTouch[] = [];
  for (let i = 2; i < scoped.length - 2; i++) {
    const bar = scoped[i]!;
    const neighbors = scoped.slice(i - 2, i + 3);
    const date = new Date(bar.openTime).toISOString().slice(0, 10);
    if (bar.high === Math.max(...neighbors.map((item) => item.high))) {
      pivots.push({ tradingDate: date, timestamp: bar.closeTime, pivotTimestamp: bar.openTime, role: "resistance", price: bar.high });
    }
    if (bar.low === Math.min(...neighbors.map((item) => item.low))) {
      pivots.push({ tradingDate: date, timestamp: bar.closeTime, pivotTimestamp: bar.openTime, role: "support", price: bar.low });
    }
  }
  const width = widthTicks * tickSize;
  const independentPivots = pivots.filter((pivot, index, all) =>
    index === all.findIndex((candidate) =>
      candidate.role === pivot.role
      && candidate.tradingDate === pivot.tradingDate
      && Math.abs(candidate.price - pivot.price) <= width,
    ));
  const clusters: LongTermZoneTouch[][] = [];
  for (const pivot of independentPivots) {
    const cluster = clusters.find((items) => Math.abs(pivot.price - items.reduce((sum, item) => sum + item.price, 0) / items.length) <= width);
    if (cluster) cluster.push(pivot); else clusters.push([pivot]);
  }
  const result = clusters.flatMap((touches) => {
    const dates = [...new Set(touches.map((touch) => touch.tradingDate))];
    if (touches.length < 3 || dates.length < 3) return [];
    const roles = new Set(touches.map((touch) => touch.role));
    const midpoint = touches.reduce((sum, touch) => sum + touch.price, 0) / touches.length;
    return [{
      id: `ltz|${options.lookback}|${Math.round(midpoint / tickSize)}`,
      lower: Number((midpoint - width).toFixed(2)),
      upper: Number((midpoint + width).toFixed(2)),
      midpoint: Number(midpoint.toFixed(2)),
      role: roles.size > 1 ? "role-flip" : [...roles][0]!,
      lookback: options.lookback,
      touchCount: touches.length,
      independentTradingDates: dates,
      firstTimestamp: Math.min(...touches.map((touch) => touch.timestamp)),
      latestTimestamp: Math.max(...touches.map((touch) => touch.timestamp)),
      sourcePivotTimestamps: touches.map((touch) => touch.pivotTimestamp),
      touches,
      strength: touches.length >= 5 ? "strong" : "verified",
      detectorVersion: DETECTOR_VERSION,
      configurationHash,
    } satisfies LongTermZone];
  }).sort((a, b) => b.touchCount - a.touchCount || b.latestTimestamp - a.latestTimestamp);
  cache.set(key, result);
  return result.map((zone) => ({ ...zone, touches: zone.touches.map((touch) => ({ ...touch })) }));
}

export function clearLongTermZoneCache(): void {
  cache.clear();
}