// Tujuan: Membuat / mereset user lokal Better Auth tanpa perlu menjalankan server Next.js.
// Caller: Operator lokal via `node scripts/create-user.mjs`.
// Dependensi: better-auth (hashPassword scrypt), @libsql/client untuk akses SQLite.
// Side Effects: Menulis ke tabel `user` dan `account` di SQLite (DATABASE_URL atau ./sqlite.db).
//
// Penggunaan:
//   node scripts/create-user.mjs
//     -> default: buat user@local.test / Password123! role admin + reset admin@local.test
//   node scripts/create-user.mjs --email foo@bar --password Secret123 --role admin --name "Foo"
//   node scripts/create-user.mjs --force  (override safety guard di env non-lokal)
//
// Guards:
// - Menolak dijalankan saat NODE_ENV=production kecuali di-pass --force.
// - Menolak DATABASE_URL non-lokal (libsql remote / http) kecuali --force.
//
// Catatan: Script ini sudah set emailVerified=true sehingga login langsung bisa dipakai.

import { createClient } from "@libsql/client";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal .env loader supaya tidak butuh dependency tambahan.
function loadEnv() {
    const envPath = resolve(process.cwd(), ".env");
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnv();

function parseArgs(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
            result[key] = true;
        } else {
            result[key] = next;
            i++;
        }
    }
    return result;
}

const args = parseArgs(process.argv.slice(2));
const force = Boolean(args.force);

function isLocalDatabaseUrl(url) {
    if (url.startsWith("file:")) {
        const filePath = url.slice("file:".length);
        // Path container production seperti /app/data/sqlite.db dianggap non-lokal.
        if (filePath.startsWith("/app/")) return false;
        return true;
    }
    if (url.startsWith("libsql://localhost") || url.startsWith("http://localhost") || url.startsWith("https://localhost")) {
        return true;
    }
    if (url.startsWith("libsql://127.0.0.1") || url.startsWith("http://127.0.0.1") || url.startsWith("https://127.0.0.1")) {
        return true;
    }
    return false;
}

function refuse(message) {
    console.error(`[create-user] REFUSED: ${message}`);
    console.error("[create-user] Re-run with --force to override (only for trusted local databases).");
    process.exit(2);
}

if (process.env.NODE_ENV === "production" && !force) {
    refuse("NODE_ENV=production. Script ini mengubah credential dan hanya untuk dev lokal.");
}

const databaseUrl = process.env.DATABASE_URL || "file:sqlite.db";
if (!isLocalDatabaseUrl(databaseUrl) && !force) {
    refuse(`DATABASE_URL terlihat non-lokal (${databaseUrl}).`);
}

const targets = [];

if (args.email) {
    targets.push({
        email: String(args.email).toLowerCase(),
        password: String(args.password || "Password123!"),
        role: String(args.role || "admin"),
        name: String(args.name || args.email),
    });
} else {
    // Default behavior: buat user baru + reset admin lama.
    targets.push({
        email: "user@local.test",
        password: "Password123!",
        role: "admin",
        name: "Local User",
    });
    targets.push({
        email: "admin@local.test",
        password: "Password123!",
        role: "admin",
        name: "Local Admin",
    });
}

const db = createClient({ url: databaseUrl });

async function getRowByEmail(email) {
    const result = await db.execute({
        sql: "SELECT id FROM user WHERE email = ? LIMIT 1",
        args: [email],
    });
    return result.rows[0] || null;
}

async function getCredentialAccount(userId) {
    const result = await db.execute({
        sql: "SELECT id FROM account WHERE userId = ? AND providerId = 'credential' LIMIT 1",
        args: [userId],
    });
    return result.rows[0] || null;
}

async function upsert(target) {
    const now = Date.now();
    const passwordHash = await hashPassword(target.password);
    const existing = await getRowByEmail(target.email);

    if (existing) {
        const userId = String(existing.id);
        const account = await getCredentialAccount(userId);
        const accountStatement = account
            ? {
                  sql: `UPDATE account SET password = ?, updatedAt = ? WHERE id = ?`,
                  args: [passwordHash, now, String(account.id)],
              }
            : {
                  sql: `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
                        VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
                  args: [randomUUID(), userId, userId, passwordHash, now, now],
              };

        // Atomic update: libsql.batch("write") membungkus dalam transaction.
        await db.batch(
            [
                {
                    sql: `UPDATE user
                          SET name = ?, role = ?, emailVerified = 1, banned = 0, banReason = NULL, banExpires = NULL,
                              updatedAt = ?
                          WHERE id = ?`,
                    args: [target.name, target.role, now, userId],
                },
                accountStatement,
            ],
            "write",
        );

        return { action: "updated", userId };
    }

    const userId = randomUUID();
    await db.batch(
        [
            {
                sql: `INSERT INTO user (id, name, email, emailVerified, role, permissions, banned, createdAt, updatedAt)
                      VALUES (?, ?, ?, 1, ?, '{}', 0, ?, ?)`,
                args: [userId, target.name, target.email, target.role, now, now],
            },
            {
                sql: `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
                      VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
                args: [randomUUID(), userId, userId, passwordHash, now, now],
            },
        ],
        "write",
    );
    return { action: "created", userId };
}

async function main() {
    const summary = [];
    for (const target of targets) {
        const result = await upsert(target);
        summary.push({ email: target.email, role: target.role, ...result });
    }
    console.log("DATABASE_URL:", databaseUrl);
    console.table(summary);
    console.log("\nGunakan kredensial berikut untuk login di http://localhost:3000/login :");
    for (const target of targets) {
        console.log(`  email: ${target.email}  password: ${target.password}  role: ${target.role}`);
    }
}

main().catch((error) => {
    console.error("[create-user] FAILED:", error);
    process.exit(1);
});
