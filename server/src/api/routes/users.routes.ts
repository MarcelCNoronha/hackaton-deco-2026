import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { passwordResetTokens, twoFactorTrustedDevices, users } from "../../db/schema.js";
import { requireAdmin } from "../../auth/guards.js";
import { hashPassword } from "../../auth/password.js";
import { generateToken, hashToken } from "../../auth/tokens.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const SECTIONS = ["connections", "publish", "users"] as const;

const createUserBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["admin", "user"]).default("user"),
  permissions: z.array(z.enum(SECTIONS)).default([]),
});

const updateUserBody = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(["admin", "user"]).optional(),
  permissions: z.array(z.enum(SECTIONS)).optional(),
  isActive: z.boolean().optional(),
});

function publicUser(user: typeof users.$inferSelect) {
  const { passwordHash: _passwordHash, twoFactorSecretEncrypted: _secret, pendingTwoFactorSecret: _pending, ...rest } = user;
  return rest;
}

async function issueSetupLink(userId: number, origin: string): Promise<string> {
  const token = generateToken();
  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  });
  return `${origin}/reset-password?token=${token}`;
}

export async function usersRoutes(app: FastifyInstance) {
  app.get("/api/users", { preHandler: requireAdmin }, async () => {
    const rows = await db.query.users.findMany();
    return rows.map(publicUser);
  });

  app.post("/api/users", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createUserBody.parse(req.body);
    const existing = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) });
    if (existing) return reply.status(409).send({ error: "Já existe um usuário com esse e-mail." });

    // Placeholder password — never usable directly; the user sets a real one via the setup link.
    const passwordHash = await hashPassword(generateToken());
    const [created] = await db
      .insert(users)
      .values({
        name: body.name,
        email: body.email.toLowerCase(),
        passwordHash,
        role: body.role,
        permissions: body.role === "admin" ? [] : body.permissions,
        isActive: false,
        invitedAt: new Date(),
      })
      .returning();

    const origin = (req.headers.origin as string | undefined) ?? "http://localhost:5173";
    const setupUrl = await issueSetupLink(created.id, origin);
    return reply.send({ user: publicUser(created), setupUrl });
  });

  app.put<{ Params: { id: string } }>("/api/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const targetId = Number(req.params.id);
    const body = updateUserBody.parse(req.body);

    if (targetId === req.authUser!.id) {
      if (body.role && body.role !== "admin") {
        return reply.status(400).send({ error: "Você não pode remover seu próprio papel de admin." });
      }
      if (body.isActive === false) {
        return reply.status(400).send({ error: "Você não pode desativar sua própria conta." });
      }
    }

    const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
    if (!target) return reply.status(404).send({ error: "Usuário não encontrado." });

    const nextRole = body.role ?? target.role;
    await db
      .update(users)
      .set({
        name: body.name ?? target.name,
        role: nextRole,
        permissions: nextRole === "admin" ? [] : body.permissions ?? target.permissions,
        isActive: body.isActive ?? target.isActive,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetId));

    const updated = await db.query.users.findFirst({ where: eq(users.id, targetId) });
    return reply.send({ user: publicUser(updated!) });
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/reset-password", { preHandler: requireAdmin }, async (req, reply) => {
    const targetId = Number(req.params.id);
    const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
    if (!target) return reply.status(404).send({ error: "Usuário não encontrado." });

    const origin = (req.headers.origin as string | undefined) ?? "http://localhost:5173";
    const resetUrl = await issueSetupLink(targetId, origin);
    return reply.send({ resetUrl });
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/disable-two-factor", { preHandler: requireAdmin }, async (req, reply) => {
    const targetId = Number(req.params.id);
    await db
      .update(users)
      .set({ twoFactorSecretEncrypted: null, twoFactorEnabled: false, pendingTwoFactorSecret: null, updatedAt: new Date() })
      .where(eq(users.id, targetId));
    await db.delete(twoFactorTrustedDevices).where(eq(twoFactorTrustedDevices.userId, targetId));
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const targetId = Number(req.params.id);
    if (targetId === req.authUser!.id) {
      return reply.status(400).send({ error: "Você não pode excluir sua própria conta." });
    }
    await db.delete(users).where(eq(users.id, targetId));
    return reply.send({ ok: true });
  });
}
