import { randomBytes } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { env } from "../config/env.js";

export const SESSION_COOKIE = "session_id";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionContext {
  session: typeof sessions.$inferSelect;
  user: typeof users.$inferSelect;
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

function userAgentOf(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

/** Creates a session row and sets the session cookie. `twoFactorPending=true` means the password
 *  was correct but the 2FA challenge hasn't been passed yet — the session exists but isn't fully
 *  authenticated (see getSessionContext/guards.ts). */
export async function createSession(params: {
  userId: number;
  twoFactorPending: boolean;
  req: FastifyRequest;
  reply: FastifyReply;
}): Promise<string> {
  const id = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id,
    userId: params.userId,
    twoFactorPending: params.twoFactorPending,
    ipAddress: params.req.ip,
    userAgent: userAgentOf(params.req),
    expiresAt,
  });
  params.reply.setCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return id;
}

/** Reads the session cookie and resolves the session+user, or null if missing/expired/deactivated.
 *  Callers must still check `session.twoFactorPending` themselves if partial-auth isn't acceptable
 *  (see guards.ts, which treats a pending session as unauthenticated for every protected route). */
export async function getSessionContext(req: FastifyRequest): Promise<SessionContext | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, token) });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, token));
    return null;
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
  if (!user || !user.isActive) return null;

  return { session, user };
}

export async function markSessionFullyAuthenticated(sessionId: string): Promise<void> {
  await db.update(sessions).set({ twoFactorPending: false }).where(eq(sessions.id, sessionId));
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await db.delete(sessions).where(eq(sessions.id, token));
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Invalidates every session for a user — used on password reset, mirroring Mundial's
 *  remember_token rotation (force re-login everywhere once the password changes). */
export async function destroyAllSessionsForUser(userId: number): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Same idea, but keeps one session alive — used when changing the password from inside an
 *  already-logged-in session, so the user isn't immediately logged out of their own change. */
export async function destroyOtherSessionsForUser(userId: number, keepSessionId: string): Promise<void> {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
}
