import type { StrategyConfig } from "./config.js";
import type { Candle, DecisionState, Direction, Level, RuleEvidence, TrendDirection } from "./types.js";
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
export type PatienceStatus = "ready" | "waiting" | "forming" | "invalid";
export type CandleAlert = { reversal: boolean; doji: boolean; detail: string };

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

export function orbBreakout(candles: readonly Candle[], orb: SessionLevels["orb"], direction: Direction): boolean {
  if (!orb || !candles.length) return false;
  return candles.some(c => direction === "long" ? c.close > orb.high : c.close < orb.low);
}

/** A breakout is never actionable without a subsequent retest and a confluence level. */
export function pullbackConfluence(candle: Candle, orb: SessionLevels["orb"], levels: readonly Level[], direction: Direction, tolerance = 0.05): boolean {
  if (!orb) return false;
  const edge = direction === "long" ? orb.high : orb.low;
  const touched = candle.low <= edge + tolerance && candle.high >= edge - tolerance;
  const confluence = levels.some(l => l.name !== "ORB high" && l.name !== "ORB low" && candle.low <= l.price + tolerance && candle.high >= l.price - tolerance);
  return touched && confluence && (direction === "long" ? candle.close >= edge : candle.close <= edge);
}

export function volumeCheck(candles: readonly Candle[], config: StrategyConfig, direction: Direction, breakoutIndex = Math.max(0, candles.length - 2)): { ratio: number; confirmed: boolean; adverseWarning: boolean; pullbackVolume: number; breakoutVolume: number; averageVolume: number } {
  if (!candles.length) return { ratio: NaN, confirmed: false, adverseWarning: false, pullbackVolume: NaN, breakoutVolume: NaN, averageVolume: NaN };
  const current = candles[candles.length - 1], prior = candles.slice(-config.volumeLookback - 1, -1);
  const average = prior.length ? prior.reduce((s, c) => s + c.volume, 0) / prior.length : current.volume;
  const breakout = candles[breakoutIndex] ?? current;
  const ratio = average ? current.volume / average : NaN;
  const adverse = direction === "long" ? current.close < current.open : current.close > current.open;
  const confirmed = current.volume <= breakout.volume && ratio < config.volumeExpansionRatio;
  return { ratio, confirmed, adverseWarning: current.volume >= breakout.volume * config.adverseVolumeRatio && adverse, pullbackVolume: current.volume, breakoutVolume: breakout.volume, averageVolume: average };
}

export function patienceCandle(
  previous: Candle | undefined,
  candle: Candle | undefined,
  direction: Direction,
  config: StrategyConfig,
  trend: TrendDirection = direction === "long" ? "bullish" : "bearish",
): { status: PatienceStatus; detail: string } {
  if (!previous || !candle) return { status: "waiting", detail: "Waiting for two completed candles." };
  if (!candle.isComplete) return { status: "forming", detail: "Patience candle is still forming." };
  if (trend !== (direction === "long" ? "bullish" : "bearish")) return { status: "invalid", detail: `Patience trend mismatch: ${direction} patience requires a ${direction === "long" ? "bullish" : "bearish"} 15-minute trend.` };
  if (direction === "long" ? candle.high > previous.high : candle.low < previous.low) {
    return { status: "invalid", detail: direction === "long"
      ? "Opposing patience shape: candidate high exceeded the preceding completed high."
      : "Opposing patience shape: candidate low broke below the preceding completed low." };
  }
  const range = candle.high - candle.low;
  if (range <= 0) return { status: "invalid", detail: "Zero-range candle." };
  const body = Math.abs(candle.close - candle.open) / range;
  const favorable = direction === "long" ? candle.close >= candle.low + range * .66 : candle.close <= candle.high - range * .66;
  if (body < config.dojiBodyRatio) return { status: "waiting", detail: "Patience candle has insufficient directional intent." };
  return favorable ? { status: "ready", detail: "Trend-aligned patience candle holds the facing extreme using exact wick highs/lows." } : { status: "invalid", detail: "Patience candle close is adverse to the trend." };
}

export function patience(candle: Candle, direction: Direction): { status: PatienceStatus; detail: string } {
  return patienceCandle(candle, candle, direction, { ...({} as StrategyConfig), dojiBodyRatio: .1 });
}

export function candleAlert(candle: Candle, direction: Direction, config?: Pick<StrategyConfig, "dojiBodyRatio">): CandleAlert {
  const range = candle.high - candle.low, body = Math.abs(candle.close - candle.open);
  const doji = range === 0 || body / range <= (config?.dojiBodyRatio ?? .1);
  const reversal = direction === "long" ? candle.close < candle.open && candle.close <= candle.low + range * .35 : candle.close > candle.open && candle.close >= candle.high - range * .35;
  return { doji, reversal, detail: reversal ? "adverse reversal candle" : doji ? "doji/equivalent indecision" : "no reversal alert" };
}

export type LevelInteraction = Level & { interaction: "clean break" | "rejection" | "hold" | "retest" | "touch" };

export function levelInteractions(candle: Candle, levels: readonly Level[], tolerance = .05): LevelInteraction[] {
  return levels.filter(l => candle.high >= l.price - tolerance && candle.low <= l.price + tolerance).map(l => {
    const crossed = candle.open < l.price && candle.close > l.price || candle.open > l.price && candle.close < l.price;
    const rejection = candle.high - l.price > tolerance && candle.close < l.price || l.price - candle.low > tolerance && candle.close > l.price;
    return { ...l, interaction: crossed ? "clean break" : rejection ? "rejection" : candle.close >= l.price - tolerance && candle.close <= l.price + tolerance ? "hold" : "touch" };
  });
}

export type LevelStory = {
  interactions: LevelInteraction[];
  bias: Direction | "neutral";
  summary: string;
};

/** A deterministic, explainable account of what the latest candle did at known levels. */
export function levelStory(candle: Candle, levels: readonly Level[], tolerance = .05): LevelStory {
  const interactions = levelInteractions(candle, levels, tolerance);
  const bias = candle.close > candle.open ? "long" : candle.close < candle.open ? "short" : "neutral";
  const names = interactions.map(i => `${i.interaction} ${i.name}`).join(", ");
  return { interactions, bias, summary: names ? `${bias} candle; ${names}` : `${bias} candle; no level interaction` };
}

export function fullDecision(candles: readonly Candle[], levels: SessionLevels, config: StrategyConfig, direction: Direction, riskAllowed = true): { decision: DecisionState; rules: RuleEvidence[]; trend: TrendEvidence; volume: ReturnType<typeof volumeCheck>; patience: ReturnType<typeof patienceCandle> } {
  const last = candles.at(-1);
  const trend = trendEvidence(candles, levels, config);
  const breakoutIndex = candles.findIndex(c => levels.orb ? (direction === "long" ? c.close > levels.orb.high : c.close < levels.orb.low) : false);
  const pullback = last && breakoutIndex >= 0 && breakoutIndex < candles.length - 1 ? pullbackConfluence(last, levels.orb, levels.levels, direction, config.levelTolerance) : false;
  const volume = volumeCheck(candles, config, direction, breakoutIndex >= 0 ? breakoutIndex : Math.max(0, candles.length - 2));
  const patienceResult = patienceCandle(candles.at(-2), last, direction, config, trend.direction);
  const outsideNtz = !!levels.ntz && !!last && (direction === "long" ? last.close > levels.ntz.high : last.close < levels.ntz.low);
  const rules: RuleEvidence[] = [
    { key: "trend", label: "15-minute trend identified", passed: trend.direction === (direction === "long" ? "bullish" : "bearish"), detail: trend.evidence.join(", ") || "No trend evidence" },
    { key: "ntz", label: "Completed candle outside NTZ", passed: outsideNtz, detail: outsideNtz ? "Latest completed close is outside NTZ." : "Normal entries remain blocked inside or before NTZ." },
    { key: "orb", label: "Completed ORB close", passed: breakoutIndex >= 0, detail: breakoutIndex >= 0 ? "A completed candle closed beyond the opening range." : "Waiting for a completed close beyond the opening range." },
    { key: "pullback", label: "Mandatory pullback reached confluence", passed: pullback, detail: pullback ? "Retest touched the ORB edge and another mapped level." : "No qualifying post-breakout pullback/confluence yet." },
    { key: "volume", label: "Pullback volume passed safety check", passed: volume.confirmed && !volume.adverseWarning, detail: volume.adverseWarning ? "HIGH-VOLUME PULLBACK — POSSIBLE REVERSAL" : `${volume.pullbackVolume.toFixed(0)} vs ${volume.breakoutVolume.toFixed(0)} breakout volume; ${volume.ratio.toFixed(2)}x average.` },
    { key: "patience", label: "Valid patience candle closed", passed: patienceResult.status === "ready", detail: patienceResult.detail },
    { key: "risk", label: "Risk controls passed", passed: riskAllowed, detail: riskAllowed ? "Position size and daily controls passed." : "Risk lockout or sizing rule blocked this setup." },
  ];
  const failed = rules.filter(r => !r.passed);
  const decision: DecisionState = !riskAllowed ? "RISK LOCKOUT" : failed.length === 0 ? "SETUP QUALIFIED" : failed.some(r => ["ntz", "orb", "pullback", "patience"].includes(r.key)) ? "WAITING" : "NO TRADE";
  return { decision, rules, trend, volume, patience: patienceResult };
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