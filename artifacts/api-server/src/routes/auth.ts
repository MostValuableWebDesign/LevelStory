import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import * as oidc from "openid-client";
import {
  clearSession,
  createSession,
  deleteSession,
  getOidcConfig,
  getSessionId,
  ISSUER_URL,
  SESSION_COOKIE,
  SESSION_TTL,
  type AuthUser,
  type SessionData,
} from "../lib/auth.js";

const router: IRouter = Router();
const OIDC_COOKIE_TTL = 10 * 60 * 1000;

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function safeReturnTo(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL });
}

function setOidcCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: OIDC_COOKIE_TTL });
}

async function upsertUser(claims: Record<string, unknown>): Promise<AuthUser> {
  const data = {
    id: String(claims.sub),
    email: typeof claims.email === "string" ? claims.email : null,
    firstName: typeof claims.first_name === "string" ? claims.first_name : null,
    lastName: typeof claims.last_name === "string" ? claims.last_name : null,
    profileImageUrl: typeof claims.profile_image_url === "string" ? claims.profile_image_url : typeof claims.picture === "string" ? claims.picture : null,
  };
  const [user] = await db.insert(usersTable).values(data).onConflictDoUpdate({ target: usersTable.id, set: { ...data, updatedAt: new Date() } }).returning();
  return user;
}

router.get("/auth/user", (req, res) => {
  res.json({ user: req.isAuthenticated() ? req.user : null });
});

router.get("/login", async (req, res) => {
  const config = await getOidcConfig();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${getOrigin(req)}/api/callback`,
    scope: "openid email profile offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    state,
    nonce,
  });
  setOidcCookie(res, "code_verifier", codeVerifier);
  setOidcCookie(res, "nonce", nonce);
  setOidcCookie(res, "state", state);
  setOidcCookie(res, "return_to", safeReturnTo(req.query.returnTo));
  res.redirect(redirectTo.href);
});

router.get("/callback", async (req, res) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;
  const codeVerifier = req.cookies?.code_verifier;
  const expectedState = req.cookies?.state;
  const returnTo = safeReturnTo(req.cookies?.return_to);
  if (!codeVerifier || !expectedState) {
    res.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}authError=missing_login_state`);
    return;
  }
  try {
    const currentUrl = new URL(`${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`);
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: req.cookies?.nonce,
      expectedState,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("Missing claims");
    const user = await upsertUser(claims as unknown as Record<string, unknown>);
    const now = Math.floor(Date.now() / 1000);
    const session: SessionData = {
      user,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
    };
    const sid = await createSession(session);
    setSessionCookie(res, sid);
    res.clearCookie("code_verifier", { path: "/" });
    res.clearCookie("nonce", { path: "/" });
    res.clearCookie("state", { path: "/" });
    res.clearCookie("return_to", { path: "/" });
    res.redirect(returnTo);
  } catch (error) {
    req.log?.error({ error: error instanceof Error ? error.message : "unknown" }, "Authentication callback failed");
    res.clearCookie("code_verifier", { path: "/" });
    res.clearCookie("nonce", { path: "/" });
    res.clearCookie("state", { path: "/" });
    res.clearCookie("return_to", { path: "/" });
    res.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}authError=callback_failed`);
  }
});

router.get("/logout", async (req, res) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  try {
    const endSessionUrl = oidc.buildEndSessionUrl(await getOidcConfig(), {
      client_id: process.env.REPL_ID!,
      post_logout_redirect_uri: new URL(safeReturnTo(req.query.returnTo), getOrigin(req)).href,
    });
    res.redirect(endSessionUrl.href);
  } catch {
    res.redirect(safeReturnTo(req.query.returnTo));
  }
});

router.post("/mobile-auth/logout", async (req, res) => {
  const sid = getSessionId(req);
  if (sid) await deleteSession(sid);
  res.json({ success: true });
});

export default router;