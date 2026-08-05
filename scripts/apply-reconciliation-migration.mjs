import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

try { process.loadEnvFile(".env.local"); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL wajib di-set.");
const url = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname))
  throw new Error("Refused: migration hanya boleh diterapkan ke PostgreSQL lokal.");

const sqlPath = fileURLToPath(new URL("../db/migrations/0001_reconciliation_storage.sql", import.meta.url));
const sql = await readFile(sqlPath, "utf8");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  console.log("Applied db/migrations/0001_reconciliation_storage.sql");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
