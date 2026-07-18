// Seed/refresh a local admin user in PostgreSQL (Better Auth credential).
// Usage: DATABASE_URL=postgres://... ADMIN_EMAIL=a@b.c ADMIN_PASSWORD=secret node scripts/seed-admin.mjs
// Idempotent: creates the user+credential if absent, else updates role=admin + password.
import { scryptAsync } from "../node_modules/@noble/hashes/scrypt.js";
import { bytesToHex } from "../node_modules/@noble/hashes/utils.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const email = (process.env.ADMIN_EMAIL || "admin@accapi.local").toLowerCase();
const password = process.env.ADMIN_PASSWORD || "admin12345";
const name = process.env.ADMIN_NAME || "Local Admin";
const url = process.env.DATABASE_URL;
if (!url || url.startsWith("file:")) { console.error("DATABASE_URL must be a postgres:// URL"); process.exit(1); }

const saltBytes = new Uint8Array(16);
crypto.getRandomValues(saltBytes);
const salt = bytesToHex(saltBytes);
const key = await scryptAsync(password.normalize("NFKC"), salt, { N: 16384, r: 16, p: 1, dkLen: 64, maxmem: 128 * 16384 * 16 * 2 });
const hash = `${salt}:${bytesToHex(key)}`;

const pool = new Pool({ connectionString: url });
const c = await pool.connect();
try {
  await c.query("BEGIN");
  const now = new Date();
  const existing = await c.query('SELECT id FROM "user" WHERE email = $1', [email]);
  let userId = existing.rows[0]?.id;
  if (userId) {
    await c.query('UPDATE "user" SET role = $1, "emailVerified" = true, "updatedAt" = $2 WHERE id = $3', ["admin", now, userId]);
  } else {
    userId = randomUUID();
    await c.query('INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES ($1,$2,$3,true,$4,$5,$5)', [userId, name, email, "admin", now]);
  }
  const acct = await c.query("SELECT id FROM account WHERE \"userId\" = $1 AND \"providerId\" = 'credential'", [userId]);
  if (acct.rows[0]?.id) {
    await c.query('UPDATE account SET password = $1, "updatedAt" = $2 WHERE id = $3', [hash, now, acct.rows[0].id]);
  } else {
    await c.query('INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1,$2,\'credential\',$3,$4,$5,$5)', [randomUUID(), userId, userId, hash, now]);
  }
  await c.query("COMMIT");
  console.log(`OK — admin ready: ${email}  (password: ${password})  role=admin userId=${userId}`);
} catch (e) {
  await c.query("ROLLBACK");
  console.error("FAILED:", e.message);
  process.exit(1);
} finally {
  c.release();
  await pool.end();
}
process.exit(0);
