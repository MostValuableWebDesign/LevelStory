import type { Direction } from "./types.js";
import type { StrategyConfig } from "./config.js";
import type { FuturesContractSpecification } from "../futures/contracts.js";

export type Fill = { entry: number; exit: number; contracts: number; gross: number; fees: number; net: number; stopped: "thesis" | "catastrophe" | "runner" | "target" | "manual" };
export function simulateFill(direction: Direction, entryQuote: number, exitQuote: number, contracts: number, config: StrategyConfig, specification: FuturesContractSpecification, stop: number, catastropheStop: number, target?: number, runnerProtected = false, runnerStop?: number): Fill {
  const entry = direction === "long" ? entryQuote + config.spread / 2 + config.slippage : entryQuote - config.spread / 2 - config.slippage;
  let exit = direction === "long" ? exitQuote - config.spread / 2 - config.slippage : exitQuote + config.spread / 2 + config.slippage;
  let stopped: Fill["stopped"] = "manual";
  // A runner may tighten its thesis stop after reaching the configured R trigger.
  const activeStop = runnerProtected && runnerStop !== undefined ? runnerStop : stop;
  if ((direction === "long" && exit <= catastropheStop) || (direction === "short" && exit >= catastropheStop)) { exit = catastropheStop; stopped = "catastrophe"; }
  else if ((direction === "long" && exit <= activeStop) || (direction === "short" && exit >= activeStop)) { exit = activeStop; stopped = runnerProtected ? "runner" : "thesis"; }
  else if (target !== undefined && ((direction === "long" && exit >= target) || (direction === "short" && exit <= target))) { exit = target; stopped = "target"; }
  const gross = (exit - entry) * contracts * specification.pointValue * specification.contractMultiplier * (direction === "long" ? 1 : -1);
  const fees = contracts * (specification.commissionPerContract + specification.exchangeAndRegulatoryFeesPerContract) * 2;
  return { entry, exit, contracts, gross, fees, net: gross - fees - config.profitBuffer, stopped };
}