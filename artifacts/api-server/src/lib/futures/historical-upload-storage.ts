import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { signPrivateObjectUrl } from "../uploaded-chart-storage.js";

const SAFE_PATH = /^\/objects\/uploads\/historical\/[a-f0-9-]+$/;

export type MaterializedHistoricalObject = {
  path: string;
  objectPath: string;
  originalFilename: string;
  expectedCompression: "none" | "zstd";
  contentFingerprint: string;
  sizeBytes: number;
};

export function isSafeHistoricalObjectPath(objectPath: string): boolean {
  return SAFE_PATH.test(objectPath);
}

export function newHistoricalObjectPath(): string {
  return `/objects/uploads/historical/${randomUUID()}`;
}

export async function signHistoricalObjectUrl(
  objectPath: string,
  method: "GET" | "PUT",
  ttlSec = 900,
): Promise<string> {
  if (!isSafeHistoricalObjectPath(objectPath)) throw new Error("Invalid historical data object path.");
  return signPrivateObjectUrl(objectPath, method, ttlSec);
}

export async function materializeHistoricalObject(
  objectPath: string,
  originalFilename: string,
): Promise<MaterializedHistoricalObject> {
  const url = await signHistoricalObjectUrl(objectPath, "GET", 120);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Historical object could not be read (${response.status}).`);
  const safeFilename = basename(originalFilename).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safeFilename || safeFilename === "." || safeFilename === "..") {
    throw new Error("Historical upload filename is invalid.");
  }
  const directory = join(process.cwd(), ".cache", "historical-uploads");
  await mkdir(directory, { recursive: true });
  const outputPath = join(directory, `${objectPath.split("/").at(-1)}-${safeFilename}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(outputPath));
  const fileStats = await stat(outputPath);
  return {
    path: outputPath,
    objectPath,
    originalFilename: safeFilename,
    expectedCompression: safeFilename.toLowerCase().endsWith(".zst") ? "zstd" : "none",
    contentFingerprint: hash.digest("hex"),
    sizeBytes: fileStats.size,
  };
}