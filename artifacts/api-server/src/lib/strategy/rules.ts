import type { StrategyConfig } from "./config.js";
import type { Candle, DecisionState, Direction, Level, RuleEvidence, TrendDirection } from "./types.js";
import type { SessionLevels } from "./levels.js";
import { ema } from "./indicators.js";

export type TrendEvidence = { direction: TrendDirection; score: number; evidence: string[]; structure: string };
export type PatienceStatus = "ready" | "waiting" | "forming" | "invalid";
export type CandleAlert = { reversal: boolean; doji: boolean; detail: string };

export function trendEvidence(candles: readonly Candle[], levels: SessionLevels): TrendEvidence {
  if (!candles.length) return { direction: "neutral", score: 0, evidence: [], structure: "No completed candles" };
  const fifteen = aggregate15(candles);
  const last = fifteen.at(-1) ?? candles.at(-1)!;
  const prior = fifteen[Math.max(0, fifteen.length - 3)] ?? candles[Math.max(0, candles.length - 4)];
  const evidence: string[] = [];
  let score = 0;
  if (last.close > levels.vwap) { score++; evidence.push("above VWAP"); } else { score--; evidence.push("below VWAP"); }
  if (last.close > levels.ema) { score++; evidence.push("above EMA"); } else { score--; evidence.push("below EMA"); }
  const slope = last.close - prior.close;
  if (slope > 0) { score++; evidence.push("EMA/trend slope rising"); } else if (slope < 0) { score--; evidence.push("EMA/trend slope falling"); }
  const structure = slope > 0 ? "higher highs / higher lows" : slope < 0 ? "lower highs / lower lows" : "unclear structure";
  if (slope > 0) evidence.push(structure); else if (slope < 0) evidence.push(structure);
  return { direction: score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral", score, evidence, structure };
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

export function patienceCandle(previous: Candle | undefined, candle: Candle | undefined, direction: Direction, config: StrategyConfig): { status: PatienceStatus; detail: string } {
  if (!previous || !candle) return { status: "waiting", detail: "Waiting for two completed candles." };
  if (!candle.isComplete) return { status: "forming", detail: "Patience candle is still forming." };
  if (candle.high > previous.high + config.patienceContainmentTolerance || candle.low < previous.low - config.patienceContainmentTolerance) return { status: "invalid", detail: "Close is not contained within the previous candle range." };
  const range = candle.high - candle.low;
  if (range <= 0) return { status: "invalid", detail: "Zero-range candle." };
  const body = Math.abs(candle.close - candle.open) / range;
  const favorable = direction === "long" ? candle.close >= candle.low + range * .66 : candle.close <= candle.high - range * .66;
  if (body < config.dojiBodyRatio) return { status: "waiting", detail: "Contained candle has insufficient directional intent." };
  return favorable ? { status: "ready", detail: "Contained close rejects the level with directional intent." } : { status: "invalid", detail: "Contained close is adverse to the trend." };
}

export function patience(candle: Candle, direction: Direction): { status: PatienceStatus; detail: string } {
  return patienceCandle({ ...candle, high: candle.high + 1, low: candle.low - 1 }, candle, direction, { ...({} as StrategyConfig), patienceContainmentTolerance: 0, dojiBodyRatio: .1 });
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
  const trend = trendEvidence(candles, levels);
  const breakoutIndex = candles.findIndex(c => levels.orb ? (direction === "long" ? c.close > levels.orb.high : c.close < levels.orb.low) : false);
  const pullback = last && breakoutIndex >= 0 && breakoutIndex < candles.length - 1 ? pullbackConfluence(last, levels.orb, levels.levels, direction, config.levelTolerance) : false;
  const volume = volumeCheck(candles, config, direction, breakoutIndex >= 0 ? breakoutIndex : Math.max(0, candles.length - 2));
  const patienceResult = patienceCandle(candles.at(-2), last, direction, config);
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
  const result: Candle[] = [];
  for (let i = 0; i + 2 < candles.length; i += 3) {
    const group = candles.slice(i, i + 3);
    result.push({ openTime: group[0].openTime, closeTime: group[2].closeTime, open: group[0].open, high: Math.max(...group.map(c => c.high)), low: Math.min(...group.map(c => c.low)), close: group[2].close, volume: group.reduce((sum, c) => sum + c.volume, 0), isComplete: group.every(c => c.isComplete) });
  }
  return result;
}