import { and, desc, eq } from "drizzle-orm";
import { db, strategyVersionsTable, type StrategyVersion } from "@workspace/db";
import { DEFAULT_STRATEGY_CONFIG, strategyConfig, type StrategyConfig } from "./strategy/config.js";
import { FIXED_FORMULA_VERSION } from "./formula-hash.js";
import { createHash } from "node:crypto";

export type ActiveShadowStrategy = {
  strategyKey: "MES_SHADOW";
  config: StrategyConfig;
  formulaVersion: string;
  formulaHash: string;
  versionId: string | null;
  versionNumber: number | null;
  activatedAt: Date | null;
  activatedBy: string | null;
  source: "baseline" | "database";
};

function hashConfig(config: StrategyConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function validateVersion(version: StrategyVersion): ActiveShadowStrategy {
  if (version.strategyKey !== "MES_SHADOW" || version.formulaVersion.trim() === "") {
    throw new Error("Active Shadow strategy has an invalid identity.");
  }
  const rawConfig = version.configSnapshot as Partial<StrategyConfig>;
  const config = strategyConfig({ ...rawConfig, patienceStopBufferTicks: 12 });
  const expectedHash = hashConfig(config);
  const legacyConfig = {
    ...DEFAULT_STRATEGY_CONFIG,
    ...rawConfig,
    patienceStopBufferTicks: rawConfig.patienceStopBufferTicks,
  } as StrategyConfig;
  const legacyHash = hashConfig(legacyConfig);
  if (version.formulaHash !== expectedHash && version.formulaHash !== legacyHash) throw new Error("Active Shadow strategy formula hash does not match its typed configuration.");
  return {
    strategyKey: "MES_SHADOW", config, formulaVersion: version.formulaVersion,
    formulaHash: expectedHash, versionId: version.id, versionNumber: version.versionNumber,
    activatedAt: version.activatedAt, activatedBy: version.activatedBy, source: "database",
  };
}

const baseline: ActiveShadowStrategy = {
  strategyKey: "MES_SHADOW", config: strategyConfig(DEFAULT_STRATEGY_CONFIG),
  formulaVersion: FIXED_FORMULA_VERSION, formulaHash: hashConfig(strategyConfig(DEFAULT_STRATEGY_CONFIG)),
  versionId: null, versionNumber: null, activatedAt: null, activatedBy: null, source: "baseline",
};
let cached = baseline;

export async function resolveActiveShadowStrategy(): Promise<ActiveShadowStrategy> {
  const [version] = await db.select().from(strategyVersionsTable)
    .where(and(eq(strategyVersionsTable.strategyKey, "MES_SHADOW"), eq(strategyVersionsTable.status, "active")))
    .orderBy(desc(strategyVersionsTable.versionNumber)).limit(1);
  cached = version ? validateVersion(version) : baseline;
  return cached;
}

export function activeShadowStrategySnapshot(): ActiveShadowStrategy {
  return cached;
}

export function refreshActiveShadowStrategy(): void {
  void resolveActiveShadowStrategy().catch((error) => {
    console.error("Active Shadow strategy resolution failed:", error);
    cached = baseline;
  });
}