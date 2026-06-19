/**
 * migrate-form-kontrol-v2.mjs
 * Adds checkin/checkout columns to ao_control_daily,
 * and step_photos column to merchandising_check.
 * Run: node scripts/migrate-form-kontrol-v2.mjs
 * Safe to run multiple times (uses try/catch per column).
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../sqlite.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
console.log("📦 DB:", DB_PATH);

const alterations = [
  { table: "ao_control_daily",    column: "checkin_at",         sql: "ALTER TABLE ao_control_daily ADD COLUMN checkin_at INTEGER" },
  { table: "ao_control_daily",    column: "checkin_photo_url",  sql: "ALTER TABLE ao_control_daily ADD COLUMN checkin_photo_url TEXT" },
  { table: "ao_control_daily",    column: "checkout_at",        sql: "ALTER TABLE ao_control_daily ADD COLUMN checkout_at INTEGER" },
  { table: "ao_control_daily",    column: "checkout_photo_url", sql: "ALTER TABLE ao_control_daily ADD COLUMN checkout_photo_url TEXT" },
  { table: "merchandising_check", column: "step_photos",        sql: "ALTER TABLE merchandising_check ADD COLUMN step_photos TEXT" },
];

for (const alt of alterations) {
  try {
    db.prepare(alt.sql).run();
    console.log(`  ✅ ${alt.table}.${alt.column} added`);
  } catch (e) {
    if (e.message?.includes("duplicate column")) {
      console.log(`  ⏭  ${alt.table}.${alt.column} already exists — skipped`);
    } else { throw e; }
  }
}

const cols = db.prepare("PRAGMA table_info(ao_control_daily)").all().map(r => r.name);
console.log("\n📋 ao_control_daily columns:", cols.join(", "));
db.close();
console.log("\n✅ Migration v2 done.");
