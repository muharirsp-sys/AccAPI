/**
 * migrate-rbac-groups.mjs
 * Membuat tabel Dynamic RBAC (Access Group) secara additive & idempotent.
 * ADDITIVE ONLY — tidak menyentuh user.role / user.permissions (override legacy).
 * Run: node scripts/migrate-rbac-groups.mjs
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../sqlite.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("DB:", DB_PATH);

const statements = [
  `CREATE TABLE IF NOT EXISTS access_group (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     description  TEXT,
     is_preset    INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS group_permission (
     group_id        TEXT NOT NULL REFERENCES access_group(id),
     permission_key  TEXT NOT NULL,
     PRIMARY KEY (group_id, permission_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_group_permission_group ON group_permission(group_id)`,

  `CREATE TABLE IF NOT EXISTS user_group (
     user_id      TEXT NOT NULL REFERENCES user(id),
     group_id     TEXT NOT NULL REFERENCES access_group(id),
     assigned_by  TEXT,
     assigned_at  INTEGER NOT NULL,
     PRIMARY KEY (user_id, group_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_group_user  ON user_group(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_group_group ON user_group(group_id)`,

  `CREATE TABLE IF NOT EXISTS permission_audit_log (
     id              TEXT PRIMARY KEY,
     actor_user_id   TEXT,
     actor_name      TEXT,
     action          TEXT NOT NULL,
     target_user_id  TEXT,
     target_group_id TEXT,
     detail          TEXT,
     created_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pal_actor        ON permission_audit_log(actor_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pal_target_user  ON permission_audit_log(target_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pal_target_group ON permission_audit_log(target_group_id)`,
];

const tx = db.transaction(() => {
  for (const ddl of statements) db.prepare(ddl).run();
});
tx();

const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('access_group','group_permission','user_group','permission_audit_log') ORDER BY name`)
  .all()
  .map((r) => r.name);

console.log("Tabel RBAC siap:", tables.join(", "));
console.log("Migrasi RBAC group selesai (additive, idempotent).");
db.close();
