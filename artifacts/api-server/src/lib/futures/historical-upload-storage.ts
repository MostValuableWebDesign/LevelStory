import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { signPrivateObjectUrl } from "../uploaded-chart-storage.js";

export const MAX_HISTORICAL_UPLOAD_BYTES = 512 * 1024 * 1024;
const SAFE_PATH = /^\/objects\/uploads\/historical\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  options: { expectedSizeBytes?: number | null; maxBytes?: number } = {},
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
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  const maxBytes = options.maxBytes ?? MAX_HISTORICAL_UPLOAD_BYTES;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) throw new Error(`Historical object exceeds the ${maxBytes} byte upload limit.`);
  const hash = createHash("sha256");
  let bytes = 0;
  const body = Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>);
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        callback(new Error(`Historical object exceeds the ${maxBytes} byte upload limit.`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(body, bounded, createWriteStream(temporaryPath, { flags: "wx" }));
    const fileStats = await stat(temporaryPath);
    if (options.expectedSizeBytes !== null && options.expectedSizeBytes !== undefined
      && fileStats.size !== options.expectedSizeBytes) {
      throw new Error(`Historical object size mismatch: expected ${options.expectedSizeBytes}, received ${fileStats.size}.`);
    }
    await rename(temporaryPath, outputPath);
    return {
      path: outputPath,
      objectPath,
      originalFilename: safeFilename,
      expectedCompression: safeFilename.toLowerCase().endsWith(".zst") ? "zstd" : "none",
      contentFingerprint: hash.digest("hex"),
      sizeBytes: fileStats.size,
    };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}