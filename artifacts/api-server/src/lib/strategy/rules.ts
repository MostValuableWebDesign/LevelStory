import type { StrategyConfig } from "./config.js";
import type { Candle, TrendDirection } from "./types.js";
import type { SessionLevels } from "./levels.js";

export type TrendEvidenceItem = {
  key: "structure" | "vwap" | "ema" | "emaSlope";
  label: string;
  status: "positive" | "negative" | "neutral";
  detail: string;
};
export type TrendEvidence = {
  direction: TrendDirection;
  score: number;
  evidence: string[];
  structure: string;
  candleCount: number;
  evidenceItems: TrendEvidenceItem[];
};

export function trendEvidence(candles: readonly Candle[], levels: SessionLevels, config: StrategyConfig): TrendEvidence {
  const fifteen = aggregate15(candles).slice(-config.trendCandleCount);
  if (fifteen.length < config.trendCandleCount) {
    const detail = `${fifteen.length}/${config.trendCandleCount} completed 15-minute candles available; trend is neutral until the window is complete.`;
    return {
      direction: "neutral",
      score: 0,
      evidence: [detail],
      structure: "Insufficient completed 15-minute candles",
      candleCount: fifteen.length,
      evidenceItems: [{ key: "structure", label: "15-minute structure", status: "neutral", detail }],
    };
  }

  const last = fifteen.at(-1)!;
  const higherHighs = fifteen.slice(1).every((candle, index) => candle.high > fifteen[index].high);
  const higherLows = fifteen.slice(1).every((candle, index) => candle.low > fifteen[index].low);
  const lowerHighs = fifteen.slice(1).every((candle, index) => candle.high < fifteen[index].high);
  const lowerLows = fifteen.slice(1).every((candle, index) => candle.low < fifteen[index].low);
  const bullishStructure = higherHighs && higherLows;
  const bearishStructure = lowerHighs && lowerLows;
  const structure = bullishStructure
    ? "higher highs / higher lows"
    : bearishStructure ? "lower highs / lower lows" : "mixed structure";
  const structureStatus = bullishStructure ? "positive" : bearishStructure ? "negative" : "neutral";
  const vwapStatus = Number.isFinite(levels.vwap)
    ? last.close > levels.vwap ? "positive" : last.close < levels.vwap ? "negative" : "neutral"
    : "neutral";
  const emaStatus = Number.isFinite(levels.ema)
    ? last.close > levels.ema ? "positive" : last.close < levels.ema ? "negative" : "neutral"
    : "neutral";
  const slopeStatus = Number.isFinite(levels.emaSlope)
    ? levels.emaSlope >= -config.trendEmaFlatThreshold
      ? "positive"
      : levels.emaSlope <= config.trendEmaFlatThreshold ? "negative" : "neutral"
    : "neutral";
  const evidenceItems: TrendEvidenceItem[] = [
    {
      key: "structure",
      label: "15-minute structure",
      status: structureStatus,
      detail: `${structure} across ${fifteen.length} completed 15-minute candles.`,
    },
    {
      key: "vwap",
      label: "Regular-session VWAP",
      status: vwapStatus,
      detail: Number.isFinite(levels.vwap) ? `Latest close ${relation(vwapStatus)} regular-session VWAP (${levels.vwap.toFixed(2)}).` : "Regular-session VWAP is unavailable.",
    },
    {
      key: "ema",
      label: "200 EMA",
      status: emaStatus,
      detail: Number.isFinite(levels.ema) ? `Latest close ${relation(emaStatus)} completed-candle EMA (${levels.ema.toFixed(2)}).` : "Completed-candle EMA is unavailable.",
    },
    {
      key: "emaSlope",
      label: "EMA slope",
      status: slopeStatus,
      detail: Number.isFinite(levels.emaSlope)
        ? `EMA slope over ${config.emaSlopeWindow} completed candles: ${levels.emaSlope.toFixed(2)}.`
        : "EMA slope is unavailable until its completed-candle window is populated.",
    },
  ];
  const score = evidenceItems.reduce((sum, item) =>
    sum + (item.status === "positive" ? (item.key === "structure" ? 2 : 1) : item.status === "negative" ? (item.key === "structure" ? -2 : -1) : 0), 0);
  const direction: TrendDirection = score >= 5 ? "bullish" : score <= -5 ? "bearish" : "neutral";
  const evidence = evidenceItems.map((item) => item.detail);
  return { direction, score, evidence, structure, candleCount: fifteen.length, evidenceItems };
}

function aggregate15(candles: readonly Candle[]): Candle[] {
  const sorted = candles.filter((candle) => candle.isComplete).sort((first, second) => first.openTime - second.openTime);
  const result: Candle[] = [];
  for (let i = 0; i + 2 < sorted.length; i += 3) {
    const group = sorted.slice(i, i + 3);
    if (group[1].openTime !== group[0].closeTime || group[2].openTime !== group[1].closeTime) continue;
    result.push({ openTime: group[0].openTime, closeTime: group[2].closeTime, open: group[0].open, high: Math.max(...group.map(c => c.high)), low: Math.min(...group.map(c => c.low)), close: group[2].close, volume: group.reduce((sum, c) => sum + c.volume, 0), isComplete: true });
  }
  return result;
}

function relation(status: TrendEvidenceItem["status"]): string {
  return status === "positive" ? "above" : status === "negative" ? "below" : "at or near";
}