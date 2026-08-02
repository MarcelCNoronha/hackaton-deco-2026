import { eq } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";

async function main() {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password || !name) {
    console.error('Uso: npm run create-admin -- "email@exemplo.com" "senha" "Nome"');
    process.exit(1);
  }

  const existing = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
  if (existing) {
    console.error(`Já existe um usuário com o e-mail ${email}.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db
    .insert(users)
    .values({
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: "admin",
      permissions: [],
      isActive: true,
    })
    .returning();

  console.log(`Admin criado: ${created.email} (id ${created.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
