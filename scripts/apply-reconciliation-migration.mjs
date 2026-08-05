import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export async function runReconciliationMigration(client, sql) {
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  try { process.loadEnvFile(".env.local"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL wajib di-set.");
  const url = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    throw new Error("Refused: migration hanya boleh diterapkan ke PostgreSQL lokal.");

  const sqlPath = fileURLToPath(new URL("../db/migrations/0001_reconciliation_storage.sql", import.meta.url));
  const sql = await readFile(sqlPath, "utf8");
  await runReconciliationMigration(new pg.Client({ connectionString: databaseUrl }), sql);
  console.log("Applied db/migrations/0001_reconciliation_storage.sql");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
