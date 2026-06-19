// One-time script: reset a user's password in the Better Auth SQLite DB.
// Usage: RESET_EMAIL=x@x.com RESET_PASSWORD=newpass node scripts/reset-password.mjs
import { scryptAsync } from "../node_modules/@noble/hashes/scrypt.js";
import { bytesToHex } from "../node_modules/@noble/hashes/utils.js";
import { createClient } from "@libsql/client";

const email = process.env.RESET_EMAIL;
const password = process.env.RESET_PASSWORD;
if (!email || !password) {
    console.error("Usage: RESET_EMAIL=... RESET_PASSWORD=... node scripts/reset-password.mjs");
    process.exit(1);
}

const saltBytes = new Uint8Array(16);
crypto.getRandomValues(saltBytes);
const salt = bytesToHex(saltBytes);
const key = await scryptAsync(password.normalize("NFKC"), salt, {
    N: 16384, r: 16, p: 1, dkLen: 64,
    maxmem: 128 * 16384 * 16 * 2,
});
const hash = `${salt}:${bytesToHex(key)}`;

const db = createClient({ url: process.env.DATABASE_URL || "file:sqlite.db" });
const userRes = await db.execute({ sql: "SELECT id FROM user WHERE email = ?", args: [email] });
const userId = userRes.rows[0]?.id;
if (!userId) { console.error(`User not found: ${email}`); process.exit(1); }

const upd = await db.execute({
    sql: "UPDATE account SET password = ? WHERE userId = ? AND providerId = 'credential'",
    args: [hash, userId],
});
if (upd.rowsAffected === 0) {
    console.error("No account row updated — user may not have a credential account");
    process.exit(1);
}
console.log(`Password reset successful for ${email}`);
