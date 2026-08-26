export type MarketSnapshot = {
  symbol: string;
  company: string;
  price: number;
  change: number;
  changePercent: number;
  marketStatus: "premarket" | "open" | "closed";
  session: string;
  updatedAt: string;
  candles: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  levels: {
    premarketHigh: number;
    premarketLow: number;
    previousDayHigh: number;
    previousDayLow: number;
    previousDayClose: number;
    openingRangeHigh: number;
    openingRangeLow: number;
  };
  indicators: {
    rsi: number;
    ema200: number;
    fib382: number;
    fib5: number;
    fib618: number;
    volumeRatio: number;
  };
  signals: Array<{
    key: "orb" | "pullback" | "patience" | "volume";
    label: string;
    status: "confirmed" | "watching" | "blocked";
    detail: string;
  }>;
};

const companies: Record<string, string> = {
  NVDA: "NVIDIA Corporation",
  TSLA: "Tesla, Inc.",
  AMD: "Advanced Micro Devices",
  SPY: "SPDR S&P 500 ETF Trust",
};

export function createMarketSnapshot(symbol: string, session: string): MarketSnapshot {
  const normalized = symbol.trim().toUpperCase();
  const base = normalized === "NVDA" ? 183.42 : normalized === "TSLA" ? 344.18 : normalized === "AMD" ? 174.26 : normalized === "SPY" ? 646.32 : 126.84;
  const candles = Array.from({ length: 42 }, (_, index) => {
    const wave = Math.sin(index / 3.2) * 0.9 + Math.cos(index / 6.5) * 0.42;
    const drift = index * 0.075;
    const close = Number((base - 2.9 + drift + wave).toFixed(2));
    const open = Number((close - Math.sin(index * 1.7) * 0.65).toFixed(2));
    return {
      time: `${String(9 + Math.floor((index + 2) / 12)).padStart(2, "0")}:${String((30 + (index * 5) % 60) % 60).padStart(2, "0")}`,
      open,
      high: Number((Math.max(open, close) + 0.65 + (index % 3) * 0.1).toFixed(2)),
      low: Number((Math.min(open, close) - 0.52 - (index % 2) * 0.08).toFixed(2)),
      close,
      volume: 182000 + index * 9600 + (index % 5) * 24000,
    };
  });
  const price = candles[candles.length - 1].close;
  const previousClose = Number((base - 1.84).toFixed(2));
  const high = Number((base + 1.18).toFixed(2));
  const low = Number((base - 3.9).toFixed(2));
  const fibRange = high - low;

  return {
    symbol: normalized,
    company: companies[normalized] ?? `${normalized} Holdings`,
    price,
    change: Number((price - previousClose).toFixed(2)),
    changePercent: Number((((price - previousClose) / previousClose) * 100).toFixed(2)),
    marketStatus: session === "premarket" ? "premarket" : "open",
    session: session === "premarket" ? "Premarket" : "Regular session",
    updatedAt: new Date().toISOString(),
    candles,
    levels: {
      premarketHigh: Number((base + 0.32).toFixed(2)),
      premarketLow: Number((base - 1.74).toFixed(2)),
      previousDayHigh: high,
      previousDayLow: low,
      previousDayClose: previousClose,
      openingRangeHigh: Number((base + 0.56).toFixed(2)),
      openingRangeLow: Number((base - 0.82).toFixed(2)),
    },
    indicators: {
      rsi: 58.4,
      ema200: Number((base - 2.46).toFixed(2)),
      fib382: Number((high - fibRange * 0.382).toFixed(2)),
      fib5: Number((high - fibRange * 0.5).toFixed(2)),
      fib618: Number((high - fibRange * 0.618).toFixed(2)),
      volumeRatio: 1.34,
    },
    signals: [
      { key: "orb", label: "Opening range breakout", status: "confirmed", detail: "Price reclaimed the opening-range high and held for two candles." },
      { key: "pullback", label: "Pullback confirmation", status: "watching", detail: "Waiting for a clean retest of 183.98 with lower selling pressure." },
      { key: "patience", label: "Patience candle", status: "confirmed", detail: "The last candle closed in the top third of its range." },
      { key: "volume", label: "Volume check", status: "watching", detail: "Volume is above average, but not yet at an expansion threshold." },
    ],
  };
}