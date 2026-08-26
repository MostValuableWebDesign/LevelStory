import type { FuturesContractSpecification } from "../futures/contracts.js";
import type { SimulatedHourlyCandle } from "../futures/simulated-feed.js";
import type { StrategyConfig } from "./config.js";

export type MajorLevelKind = "support" | "resistance";
export type ConfluenceClass = "normal" | "strong" | "dynamite";

export type LevelComponent = {
  name: string;
  price: number;
};

export type MajorLevel = {
  name: string;
  kind: MajorLevelKind;
  price: number;
  zoneLow: number;
  zoneHigh: number;
  reactionCount: number;
  strength: number;
  recencyScore: number;
  reactionMagnitude: number;
  volumeScore: number;
  components: string[];
  componentCount: number;
  confluence: ConfluenceClass;
};

type Reaction = {
  price: number;
  openTime: number;
  magnitude: number;
  volume: number;
  tolerance: number;
};

type ReactionCluster = {
  kind: MajorLevelKind;
  reactions: Reaction[];
};

export function majorLevels(
  hourly: readonly SimulatedHourlyCandle[],
  specification: FuturesContractSpecification,
  config: StrategyConfig,
  referenceComponents: readonly LevelComponent[] = [],
): MajorLevel[] {
  if (!hourly.length) return [];
  const sorted = hourly
    .filter((candle) => candle.isComplete)
    .sort((first, second) => first.openTime - second.openTime);
  if (!sorted.length) return [];

  const averageVolume = sorted.reduce((sum, candle) => sum + candle.volume, 0) / sorted.length;
  const candidates: Array<Reaction & { kind: MajorLevelKind }> = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const candle = sorted[index];
    const atr = hourlyAtr(sorted, index);
    const tolerance = proximityTolerance(
      candle.close,
      atr,
      specification.tickSize,
      config,
    );
    const range = Math.max(candle.high - candle.low, specification.tickSize);
    const supportMagnitude = candle.close - candle.low;
    const resistanceMagnitude = candle.high - candle.close;
    if (candle.close >= candle.open && supportMagnitude >= range * 0.45) {
      candidates.push({
        kind: "support",
        price: candle.low,
        openTime: candle.openTime,
        magnitude: supportMagnitude / Math.max(atr, specification.tickSize),
        volume: averageVolume ? candle.volume / averageVolume : 1,
        tolerance,
      });
    }
    if (candle.close <= candle.open && resistanceMagnitude >= range * 0.45) {
      candidates.push({
        kind: "resistance",
        price: candle.high,
        openTime: candle.openTime,
        magnitude: resistanceMagnitude / Math.max(atr, specification.tickSize),
        volume: averageVolume ? candle.volume / averageVolume : 1,
        tolerance,
      });
    }
  }

  const clusters: ReactionCluster[] = [];
  for (const candidate of candidates) {
    const cluster = clusters.find((item) =>
      item.kind === candidate.kind
      && Math.abs(candidate.price - clusterPrice(item)) <= Math.max(candidate.tolerance, clusterTolerance(item)),
    );
    if (cluster) cluster.reactions.push(candidate);
    else clusters.push({ kind: candidate.kind, reactions: [candidate] });
  }

  const referenceTime = sorted.at(-1)!.closeTime;
  return clusters
    .filter((cluster) => cluster.reactions.length >= config.majorLevelMinReactions)
    .map((cluster) => scoreCluster(cluster, referenceTime, averageVolume, referenceComponents, specification, config))
    .sort((first, second) => second.strength - first.strength || first.price - second.price);
}

export function proximityTolerance(
  price: number,
  hourlyAtr: number,
  tickSize: number,
  config: StrategyConfig,
): number {
  return Math.max(
    tickSize * config.majorLevelProximityTicks,
    price * config.majorLevelProximityPercent,
    hourlyAtr * config.majorLevelProximityAtrFactor,
  );
}

function scoreCluster(
  cluster: ReactionCluster,
  referenceTime: number,
  averageVolume: number,
  referenceComponents: readonly LevelComponent[],
  specification: FuturesContractSpecification,
  config: StrategyConfig,
): MajorLevel {
  const reactions = cluster.reactions;
  const price = reactions.reduce((sum, reaction) => sum + reaction.price, 0) / reactions.length;
  const tolerance = Math.max(...reactions.map((reaction) => reaction.tolerance));
  const recencyScore = reactions.reduce((sum, reaction) => {
    const ageDays = Math.max(0, (referenceTime - reaction.openTime) / 86_400_000);
    return sum + Math.exp(-ageDays / config.majorLevelRecencyHalfLifeDays);
  }, 0) / reactions.length;
  const reactionMagnitude = Math.min(1, reactions.reduce((sum, reaction) => sum + reaction.magnitude, 0) / reactions.length);
  const volumeScore = Math.min(1, reactions.reduce((sum, reaction) => sum + reaction.volume, 0) / reactions.length);
  const countScore = Math.min(1, reactions.length / (config.majorLevelMinReactions * 2));
  const strength = Math.round((countScore * 0.35 + recencyScore * 0.25 + reactionMagnitude * 0.25 + volumeScore * 0.15) * 100);
  const components = [
    `Hourly ${cluster.kind}`,
    ...referenceComponents
      .filter((component) =>
        Number.isFinite(component.price)
        && Math.abs(component.price - price) <= specification.tickSize * config.majorLevelConfluenceToleranceTicks,
      )
      .map((component) => component.name),
  ].filter((name, index, all) => all.indexOf(name) === index);
  const componentCount = components.length;
  const confluence: ConfluenceClass = componentCount >= 3 ? "dynamite" : componentCount === 2 ? "strong" : "normal";
  return {
    name: `${cluster.kind === "support" ? "Major support" : "Major resistance"} ${price.toFixed(2)}`,
    kind: cluster.kind,
    price: Number(price.toFixed(2)),
    zoneLow: Number((price - tolerance).toFixed(2)),
    zoneHigh: Number((price + tolerance).toFixed(2)),
    reactionCount: reactions.length,
    strength,
    recencyScore: Number(recencyScore.toFixed(3)),
    reactionMagnitude: Number(reactionMagnitude.toFixed(3)),
    volumeScore: Number(volumeScore.toFixed(3)),
    components,
    componentCount,
    confluence,
  };
}

function clusterPrice(cluster: ReactionCluster): number {
  return cluster.reactions.reduce((sum, reaction) => sum + reaction.price, 0) / cluster.reactions.length;
}

function clusterTolerance(cluster: ReactionCluster): number {
  return Math.max(...cluster.reactions.map((reaction) => reaction.tolerance));
}

function hourlyAtr(candles: readonly SimulatedHourlyCandle[], index: number): number {
  const start = Math.max(0, index - 13);
  const ranges: number[] = [];
  for (let cursor = start; cursor <= index; cursor += 1) {
    const candle = candles[cursor];
    const previous = candles[cursor - 1];
    ranges.push(previous
      ? Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close))
      : candle.high - candle.low);
  }
  return ranges.reduce((sum, range) => sum + range, 0) / Math.max(ranges.length, 1);
}