import type { Direction } from "./types.js";
import type { StrategyConfig } from "./config.js";

export type Fill = { entry: number; exit: number; shares: number; gross: number; fees: number; net: number; stopped: "thesis" | "catastrophe" | "runner" | "target" | "manual" };
export function simulateFill(direction: Direction, entryQuote: number, exitQuote: number, shares: number, config: StrategyConfig, stop: number, catastropheStop: number, target?: number, runnerProtected = false, runnerStop?: number): Fill {
  const entry = direction === "long" ? entryQuote + config.spread / 2 + config.slippage : entryQuote - config.spread / 2 - config.slippage;
  let exit = direction === "long" ? exitQuote - config.spread / 2 - config.slippage : exitQuote + config.spread / 2 + config.slippage;
  let stopped: Fill["stopped"] = "manual";
  // A runner may tighten its thesis stop after reaching the configured R trigger.
  const activeStop = runnerProtected && runnerStop !== undefined ? runnerStop : stop;
  if ((direction === "long" && exit <= catastropheStop) || (direction === "short" && exit >= catastropheStop)) { exit = catastropheStop; stopped = "catastrophe"; }
  else if ((direction === "long" && exit <= activeStop) || (direction === "short" && exit >= activeStop)) { exit = activeStop; stopped = runnerProtected ? "runner" : "thesis"; }
  else if (target !== undefined && ((direction === "long" && exit >= target) || (direction === "short" && exit <= target))) { exit = target; stopped = "target"; }
  const gross = (exit - entry) * shares * (direction === "long" ? 1 : -1);
  const fees = shares * config.feePerShare * 2;
  return { entry, exit, shares, gross, fees, net: gross - fees - config.profitBuffer, stopped };
}