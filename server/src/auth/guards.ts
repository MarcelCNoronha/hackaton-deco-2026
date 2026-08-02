import type { FastifyReply, FastifyRequest } from "fastify";
import { getSessionContext } from "./session.js";
import type { users } from "../db/schema.js";

export type AppSection = "connections" | "publish" | "users";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: typeof users.$inferSelect;
  }
}

async function loadFullyAuthenticatedUser(req: FastifyRequest): Promise<typeof users.$inferSelect | null> {
  const ctx = await getSessionContext(req);
  if (!ctx || ctx.session.twoFactorPending) return null;
  return ctx.user;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await loadFullyAuthenticatedUser(req);
  if (!user) {
    reply.status(401).send({ error: "Não autenticado." });
    return;
  }
  req.authUser = user;
}

/** Admins bypass every section check (mirrors Mundial's admin/master role). */
export function requireSection(section: AppSection) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = await loadFullyAuthenticatedUser(req);
    if (!user) {
      reply.status(401).send({ error: "Não autenticado." });
      return;
    }
    req.authUser = user;
    if (user.role === "admin") return;
    const permissions = (user.permissions as string[]) ?? [];
    if (!permissions.includes(section)) {
      reply.status(403).send({ error: "Sem permissão para esta seção." });
    }
  };
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await loadFullyAuthenticatedUser(req);
  if (!user) {
    reply.status(401).send({ error: "Não autenticado." });
    return;
  }
  req.authUser = user;
  if (user.role !== "admin") {
    reply.status(403).send({ error: "Apenas administradores." });
  }
}
