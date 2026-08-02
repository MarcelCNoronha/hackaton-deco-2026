import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, isNull, gt } from "drizzle-orm";
import { verify } from "otplib";
import { db } from "../../db/client.js";
import { passwordResetTokens, twoFactorTrustedDevices, users } from "../../db/schema.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { createSession, destroyAllSessionsForUser, destroySession, getSessionContext, markSessionFullyAuthenticated } from "../../auth/session.js";
import { generateToken, hashToken } from "../../auth/tokens.js";
import { decryptCredentials } from "../../security/encryption.js";

const DEVICE_COOKIE = "device_token";
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// In-memory login throttle (email+ip -> attempts) — resets on server restart, which is fine for
// this scope; mirrors Mundial's 5-attempts guard without needing a dedicated table.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function checkLoginThrottle(key: string): boolean {
  const entry = loginAttempts.get(key);
  const now = Date.now();
  if (!entry || entry.resetAt < now) return true;
  return entry.count < MAX_LOGIN_ATTEMPTS;
}

function recordLoginAttempt(key: string, success: boolean): void {
  if (success) {
    loginAttempts.delete(key);
    return;
  }
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function publicUser(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: user.permissions as string[],
    twoFactorEnabled: user.twoFactorEnabled,
  };
}

const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const challengeBody = z.object({ code: z.string().min(6).max(6), rememberDevice: z.boolean().optional() });
const forgotBody = z.object({ email: z.string().email() });
const resetBody = z.object({ token: z.string().min(1), password: z.string().min(8) });

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (req, reply) => {
    const body = loginBody.parse(req.body);
    const throttleKey = `${body.email.toLowerCase()}|${req.ip}`;
    if (!checkLoginThrottle(throttleKey)) {
      return reply.status(429).send({ error: "Muitas tentativas — aguarde alguns minutos e tente de novo." });
    }

    const user = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) });
    const genericError = { error: "E-mail ou senha inválidos." };

    if (!user || !user.isActive || !(await verifyPassword(body.password, user.passwordHash))) {
      recordLoginAttempt(throttleKey, false);
      return reply.status(401).send(genericError);
    }
    recordLoginAttempt(throttleKey, true);

    if (!user.twoFactorEnabled) {
      await createSession({ userId: user.id, twoFactorPending: false, req, reply });
      return reply.send({ requiresTwoFactor: false, user: publicUser(user) });
    }

    const deviceToken = req.cookies[DEVICE_COOKIE];
    if (deviceToken) {
      const trusted = await db.query.twoFactorTrustedDevices.findFirst({
        where: and(eq(twoFactorTrustedDevices.userId, user.id), eq(twoFactorTrustedDevices.tokenHash, hashToken(deviceToken))),
      });
      if (trusted && trusted.expiresAt.getTime() > Date.now()) {
        await createSession({ userId: user.id, twoFactorPending: false, req, reply });
        return reply.send({ requiresTwoFactor: false, user: publicUser(user) });
      }
    }

    await createSession({ userId: user.id, twoFactorPending: true, req, reply });
    return reply.send({ requiresTwoFactor: true });
  });

  app.post("/api/auth/two-factor/challenge", async (req, reply) => {
    const body = challengeBody.parse(req.body);
    const ctx = await getSessionContext(req);
    if (!ctx || !ctx.session.twoFactorPending) {
      return reply.status(400).send({ error: "Nenhum desafio de 2FA pendente." });
    }
    if (!ctx.user.twoFactorSecretEncrypted) {
      return reply.status(400).send({ error: "2FA não está configurado para este usuário." });
    }

    const secret = decryptCredentials<string>(ctx.user.twoFactorSecretEncrypted);
    const result = await verify({ secret, token: body.code });
    if (!result.valid) {
      return reply.status(401).send({ error: "Código inválido." });
    }

    await markSessionFullyAuthenticated(ctx.session.id);

    if (body.rememberDevice) {
      const deviceToken = generateToken();
      await db.insert(twoFactorTrustedDevices).values({
        userId: ctx.user.id,
        tokenHash: hashToken(deviceToken),
        expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
      });
      reply.setCookie(DEVICE_COOKIE, deviceToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: DEVICE_TTL_MS / 1000,
      });
    }

    return reply.send({ user: publicUser(ctx.user) });
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await destroySession(req, reply);
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    const ctx = await getSessionContext(req);
    if (!ctx || ctx.session.twoFactorPending) {
      return reply.status(401).send({ error: "Não autenticado." });
    }
    return reply.send({ user: publicUser(ctx.user) });
  });

  app.post("/api/auth/forgot-password", async (req, reply) => {
    const body = forgotBody.parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) });
    // Always respond ok — never reveal whether an email is registered.
    if (!user) return reply.send({ ok: true });

    const token = generateToken();
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    });

    // No SMTP configured yet — the reset link is handed back directly instead of emailed.
    const origin = (req.headers.origin as string | undefined) ?? "http://localhost:5173";
    const resetUrl = `${origin}/reset-password?token=${token}`;
    return reply.send({ ok: true, resetUrl });
  });

  app.post("/api/auth/reset-password", async (req, reply) => {
    const body = resetBody.parse(req.body);
    const tokenHash = hashToken(body.token);
    const row = await db.query.passwordResetTokens.findFirst({
      where: and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())),
    });
    if (!row) return reply.status(400).send({ error: "Link inválido ou expirado." });

    const target = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
    const isPendingInvitation = !!target?.invitedAt && !target.invitationAcceptedAt;

    const passwordHash = await hashPassword(body.password);
    await db
      .update(users)
      .set({
        passwordHash,
        updatedAt: new Date(),
        ...(isPendingInvitation ? { isActive: true, invitationAcceptedAt: new Date() } : {}),
      })
      .where(eq(users.id, row.userId));
    await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id));
    await destroyAllSessionsForUser(row.userId);

    return reply.send({ ok: true });
  });
}
