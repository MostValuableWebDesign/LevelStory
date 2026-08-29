import { type NextFunction, type Request, type Response } from "express";
import * as oidc from "openid-client";
import {
  clearSession,
  getOidcConfig,
  getSession,
  getSessionId,
  updateSession,
  type AuthUser,
  type SessionData,
} from "../lib/auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      isAuthenticated(): this is Request & { user: AuthUser };
    }
  }
}

async function refreshIfExpired(sid: string, session: SessionData): Promise<SessionData | null> {
  const now = Math.floor(Date.now() / 1000);
  if (!session.expires_at || now <= session.expires_at) return session;
  if (!session.refresh_token) return null;
  try {
    const tokens = await oidc.refreshTokenGrant(await getOidcConfig(), session.refresh_token);
    session.access_token = tokens.access_token;
    session.refresh_token = tokens.refresh_token ?? session.refresh_token;
    session.expires_at = tokens.expiresIn() ? now + tokens.expiresIn()! : session.expires_at;
    await updateSession(sid, session);
    return session;
  } catch {
    return null;
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request["isAuthenticated"];
  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }
  const session = await getSession(sid);
  if (!session?.user?.id) {
    await clearSession(res, sid);
    next();
    return;
  }
  const refreshed = await refreshIfExpired(sid, session);
  if (!refreshed) {
    await clearSession(res, sid);
    next();
    return;
  }
  req.user = refreshed.user;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication is required for this action." });
    return;
  }
  next();
}

export function requireRole(role: "reviewer" | "approver" | "activator") {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Authentication is required for this action." });
      return;
    }
    const configured = (process.env.LEVELSTORY_AUTH_ROLES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const userRoles = configured.filter((item) => item.startsWith(`${req.user.id}:`)).map((item) => item.slice(req.user.id.length + 1));
    const allowed = userRoles.length === 0
      ? role === "reviewer"
      : userRoles.includes("admin") || userRoles.includes(role);
    if (!allowed) {
      res.status(403).json({ error: `This action requires the ${role} role.` });
      return;
    }
    next();
  };
}