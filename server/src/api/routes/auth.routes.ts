import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq, and, isNull, gt } from "drizzle-orm";
import { verify } from "otplib";
import { db } from "../../db/client.js";
import { passwordResetTokens, twoFactorTrustedDevices, users } from "../../db/schema.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { createSession, destroyAllSessionsForUser, destroySession, getSessionContext, rotateSessionAfterTwoFactor } from "../../auth/session.js";
import { generateToken, hashToken } from "../../auth/tokens.js";
import { decryptCredentials } from "../../security/encryption.js";
import { buildEmailClient, buildPasswordResetEmail } from "../../clients/email.client.js";
import { env } from "../../config/env.js";
import { checkRateLimit, recordAttempt } from "../../auth/rate-limit.js";

/** Prefer the server-configured base URL over the request's `Origin` header — that header is
 *  client-supplied, so trusting it lets an attacker redirect a real password-reset/invite email's
 *  link to an attacker-controlled domain by just setting a different Origin on the request that
 *  triggers it. Falls back to Origin (then localhost) only when APP_BASE_URL isn't set, so local
 *  dev keeps working without extra config. */
export function resolveAppBaseUrl(req: FastifyRequest): string {
  return env.APP_BASE_URL ?? (req.headers.origin as string | undefined) ?? "http://localhost:5173";
}

const DEVICE_COOKIE = "device_token";
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// Valkey-backed (rate-limit.ts) rather than an in-memory Map — shared across every server
// instance and surviving restarts, so it can't be bypassed just by hitting a different container
// or waiting out a redeploy.
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_TWO_FACTOR_ATTEMPTS = 5;
const TWO_FACTOR_WINDOW_SECONDS = 15 * 60;

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
    const throttleKey = `login:${body.email.toLowerCase()}|${req.ip}`;
    if (!(await checkRateLimit(throttleKey, MAX_LOGIN_ATTEMPTS))) {
      return reply.status(429).send({ error: "Muitas tentativas — aguarde alguns minutos e tente de novo." });
    }

    const user = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) });
    const genericError = { error: "E-mail ou senha inválidos." };

    if (!user || !user.isActive || !(await verifyPassword(body.password, user.passwordHash))) {
      await recordAttempt(throttleKey, false, LOGIN_WINDOW_SECONDS);
      return reply.status(401).send(genericError);
    }
    await recordAttempt(throttleKey, true, LOGIN_WINDOW_SECONDS);

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

    // Keyed by the pending session id — that id is what an attacker with a stolen/planted cookie
    // would replay guesses against, and it's constant for the lifetime of this one challenge.
    const throttleKey = `2fa:${ctx.session.id}`;
    if (!(await checkRateLimit(throttleKey, MAX_TWO_FACTOR_ATTEMPTS))) {
      return reply.status(429).send({ error: "Muitas tentativas — aguarde alguns minutos e tente de novo." });
    }

    const secret = decryptCredentials<string>(ctx.user.twoFactorSecretEncrypted);
    const result = await verify({ secret, token: body.code });
    if (!result.valid) {
      await recordAttempt(throttleKey, false, TWO_FACTOR_WINDOW_SECONDS);
      return reply.status(401).send({ error: "Código inválido." });
    }
    await recordAttempt(throttleKey, true, TWO_FACTOR_WINDOW_SECONDS);

    await rotateSessionAfterTwoFactor({ pendingSessionId: ctx.session.id, userId: ctx.user.id, req, reply });

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

    const resetUrl = `${resolveAppBaseUrl(req)}/reset-password?token=${token}`;

    const emailClient = buildEmailClient();
    if (!emailClient) {
      // No Resend configured — same dev-friendly fallback as before: hand the link back directly.
      return reply.send({ ok: true, resetUrl });
    }

    const { subject, html } = buildPasswordResetEmail(resetUrl);
    await emailClient.send({ to: user.email, subject, html });
    return reply.send({ ok: true });
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
