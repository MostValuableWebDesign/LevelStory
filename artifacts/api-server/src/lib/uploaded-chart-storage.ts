import { randomUUID } from "node:crypto";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const parts = normalized.split("/");
  if (parts.length < 3 || !parts[1] || !parts.slice(2).join("/")) {
    throw new Error("Invalid private object path.");
  }
  return { bucketName: parts[1]!, objectName: parts.slice(2).join("/") };
}

export function isSafeUploadedChartObjectPath(objectPath: string): boolean {
  return /^\/objects\/uploads\/chart\/[a-f0-9-]+$/.test(objectPath);
}

function privateObjectDir(): string {
  const value = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!value) throw new Error("Private object storage is not configured.");
  return value.replace(/\/+$/, "");
}

export function newUploadedChartObjectPath(): string {
  return `/objects/uploads/chart/${randomUUID()}`;
}

export async function signUploadedChartObjectUrl(
  objectPath: string,
  method: "GET" | "PUT",
  ttlSec = 900,
): Promise<string> {
  if (!isSafeUploadedChartObjectPath(objectPath)) {
    throw new Error("Invalid uploaded chart object path.");
  }
  const objectName = objectPath.slice("/objects/".length);
  const { bucketName } = parseObjectPath(`${privateObjectDir()}/${objectName}`);
  const signed = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: `${privateObjectDir().replace(/^\/[^/]+\//, "")}/${objectName}`,
      method,
      expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!signed.ok) throw new Error(`Unable to sign private object URL (${signed.status}).`);
  const body = await signed.json() as { signed_url?: string };
  if (!body.signed_url) throw new Error("Private object URL signer returned no URL.");
  return body.signed_url;
}

export async function readUploadedChartObject(objectPath: string): Promise<{
  bytes: Buffer;
  contentType: string | null;
}> {
  const url = await signUploadedChartObjectUrl(objectPath, "GET", 120);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Uploaded chart object could not be read (${response.status}).`);
  const maxBytes = 10 * 1024 * 1024;
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) throw new Error("The uploaded chart exceeds the 10 MB limit.");
  if (!response.body) throw new Error("Uploaded chart object returned no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The uploaded chart exceeds the 10 MB limit.");
    }
    chunks.push(next.value);
  }
  return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), contentType: response.headers.get("content-type") };
}