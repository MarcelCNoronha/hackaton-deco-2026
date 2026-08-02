import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { generateSecret, generateURI, verify } from "otplib";
import { db } from "../../db/client.js";
import { twoFactorTrustedDevices, users } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { destroyOtherSessionsForUser, getSessionContext } from "../../auth/session.js";
import { encryptCredentials } from "../../security/encryption.js";

const profileBody = z.object({ name: z.string().min(1) });
const passwordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) });
const confirmTwoFactorBody = z.object({ code: z.string().min(6).max(6) });
const disableTwoFactorBody = z.object({ currentPassword: z.string().min(1) });

export async function accountRoutes(app: FastifyInstance) {
  app.put("/api/account/profile", { preHandler: requireAuth }, async (req, reply) => {
    const body = profileBody.parse(req.body);
    await db.update(users).set({ name: body.name, updatedAt: new Date() }).where(eq(users.id, req.authUser!.id));
    return reply.send({ ok: true });
  });

  app.put("/api/account/password", { preHandler: requireAuth }, async (req, reply) => {
    const body = passwordBody.parse(req.body);
    const user = req.authUser!;
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return reply.status(401).send({ error: "Senha atual incorreta." });
    }
    const passwordHash = await hashPassword(body.newPassword);
    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, user.id));

    const ctx = await getSessionContext(req);
    if (ctx) await destroyOtherSessionsForUser(user.id, ctx.session.id);
    return reply.send({ ok: true });
  });

  app.post("/api/account/two-factor/setup", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authUser!;
    const secret = generateSecret();
    await db.update(users).set({ pendingTwoFactorSecret: secret, updatedAt: new Date() }).where(eq(users.id, user.id));

    const uri = generateURI({ issuer: "CatalogIA", label: user.email, secret });
    const qrDataUrl = await QRCode.toDataURL(uri);
    return reply.send({ secret, qrDataUrl });
  });

  app.post("/api/account/two-factor/confirm", { preHandler: requireAuth }, async (req, reply) => {
    const body = confirmTwoFactorBody.parse(req.body);
    const user = req.authUser!;
    if (!user.pendingTwoFactorSecret) {
      return reply.status(400).send({ error: "Nenhuma configuração de 2FA em andamento — inicie de novo." });
    }

    const result = await verify({ secret: user.pendingTwoFactorSecret, token: body.code });
    if (!result.valid) {
      return reply.status(401).send({ error: "Código inválido." });
    }

    await db
      .update(users)
      .set({
        twoFactorSecretEncrypted: encryptCredentials(user.pendingTwoFactorSecret),
        twoFactorEnabled: true,
        pendingTwoFactorSecret: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return reply.send({ ok: true });
  });

  app.post("/api/account/two-factor/disable", { preHandler: requireAuth }, async (req, reply) => {
    const body = disableTwoFactorBody.parse(req.body);
    const user = req.authUser!;
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return reply.status(401).send({ error: "Senha atual incorreta." });
    }

    await db
      .update(users)
      .set({ twoFactorSecretEncrypted: null, twoFactorEnabled: false, pendingTwoFactorSecret: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await db.delete(twoFactorTrustedDevices).where(eq(twoFactorTrustedDevices.userId, user.id));

    return reply.send({ ok: true });
  });
}

