/** A candle is immutable market data; timestamps are epoch milliseconds. */
export type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isComplete: boolean;
};

export type Replay = {
  candles: readonly Candle[];
  /** The replay clock. A candle is visible only when closeTime <= cursor. */
  cursor: number;
};

export function completedCandles(replay: Replay): Candle[] {
  return replay.candles
    .filter((c) => c.isComplete && c.closeTime <= replay.cursor)
    .sort((a, b) => a.closeTime - b.closeTime)
    .map((c) => ({ ...c }));
}

export type Direction = "long" | "short";
export type Level = { name: string; price: number; kind?: string };

export type TrendDirection = "bullish" | "bearish" | "neutral";
export type DecisionState = "NO TRADE" | "WAITING" | "SETUP FORMING" | "SETUP QUALIFIED" | "POSSIBLE REVERSAL" | "RISK LOCKOUT";