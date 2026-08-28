import { basename, resolve } from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  message?: string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

function decodedPath(value: string): string {
  let result = value;
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch {
      break;
    }
  }
  return result.replaceAll("\\", "/");
}

export function isBlockedPublicPath(pathname: string): boolean {
  const path = decodedPath(pathname).toLowerCase();
  return path.includes("/@fs/")
    || path.includes("/attached_assets/")
    || path.includes("/artifacts/api-server/src/")
    || path.includes("/workspace/")
    || path.endsWith(".csv")
    || /(^|\/)(manifest|metadata)\.json$/.test(path);
}

export function rejectPrivateFilePaths(req: Request, res: Response, next: NextFunction): void {
  if (isBlockedPublicPath(req.path)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

export function requestRateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip ?? "unknown"}:${req.path}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)));
      res.status(429).json({ error: options.message ?? "Too many requests. Try again later." });
      return;
    }
    next();
  };
}

export function requestTimeout(milliseconds: number): RequestHandler {
  return (_req, res, next) => {
    res.setTimeout(milliseconds, () => {
      if (!res.headersSent) res.status(408).json({ error: "Request timed out. Reduce the historical range and try again." });
    });
    next();
  };
}

export function boundedCsvPath(pathname: string, workspaceRoot = process.cwd()): string {
  const resolved = resolve(pathname);
  const publicRoots = [
    resolve(workspaceRoot, "artifacts/levelstory/public"),
    resolve(workspaceRoot, "artifacts/levelstory/dist"),
    resolve(workspaceRoot, "artifacts/api-server/dist"),
  ];
  if (publicRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    throw new Error("Historical CSV must be stored outside public and built asset directories.");
  }
  if (!resolved.toLowerCase().endsWith(".csv") || !/MES[A-Z]\d{1,2}/i.test(basename(resolved))) {
    throw new Error("Only a server-side MES contract CSV may be used for historical replay.");
  }
  return resolved;
}