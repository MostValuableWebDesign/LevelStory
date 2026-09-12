import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";

const configuredRoot = process.env.LEVELSTORY_HISTORICAL_DATA_DIR?.trim();
const defaultRoot = join(process.env.HOME ?? process.cwd(), ".levelstory", "historical-data");

export const HISTORICAL_DATA_ROOT = configuredRoot || defaultRoot;

export function historicalDataPath(...segments: string[]): string {
  return join(HISTORICAL_DATA_ROOT, ...segments);
}

export function validateHistoricalDataRoot(): void {
  try {
    mkdirSync(HISTORICAL_DATA_ROOT, { recursive: true });
    accessSync(HISTORICAL_DATA_ROOT, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error(
      `Historical data directory is unavailable or not writable: ${HISTORICAL_DATA_ROOT}. `
      + "Set LEVELSTORY_HISTORICAL_DATA_DIR to a persistent writable directory.",
      { cause: error },
    );
  }
}

validateHistoricalDataRoot();