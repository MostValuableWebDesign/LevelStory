import { completedCandles, type Candle, type Replay } from "../strategy/types.js";

export type ReplayModule = {
  cursor: number;
  visibleCandleCount: number;
  mode: "replay";
};

export function replayVisibleCandles(replay: Replay): Candle[] {
  return completedCandles(replay);
}

export function replayMetadata(replay: Replay): ReplayModule {
  return { cursor: replay.cursor, visibleCandleCount: completedCandles(replay).length, mode: "replay" };
}