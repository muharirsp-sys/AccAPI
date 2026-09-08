/**
 * Tujuan: Reset password satu user Better Auth secara lokal (lupa sandi tanpa email keluar).
 * Caller: manual oleh pemilik server. Pakai:
 *           RESET_EMAIL=x@x.com RESET_PASSWORD=<sandi baru> node scripts/reset-password.mjs
 * Dependensi: @noble/hashes (scrypt, format hash bawaan Better Auth), pg atau @libsql/client,
 *             DATABASE_URL dari .env.local.
 * Main Functions: hash scrypt + UPDATE account.password pada providerId 'credential'.
 * Side Effects: Mengubah satu baris `account`. Sandi hanya dibaca dari environment —
 *               jangan pernah ditulis di dalam file ini atau di riwayat perintah bersama.
 * Catatan: sejak cutover D4, DB utama adalah PostgreSQL. Jalur SQLite dipertahankan untuk
 *          instalasi lama; dulu skrip ini hanya SQLite sehingga gagal senyap di Postgres.
 */
import { scryptAsync } from "../node_modules/@noble/hashes/scrypt.js";
import { bytesToHex } from "../node_modules/@noble/hashes/utils.js";

try { process.loadEnvFile(".env.local"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
}

const email = process.env.RESET_EMAIL;
const password = process.env.RESET_PASSWORD;
if (!email || !password) {
    console.error("Usage: RESET_EMAIL=... RESET_PASSWORD=... node scripts/reset-password.mjs");
    process.exit(1);
}
if (password.length < 6) {
    console.error("Sandi minimal 6 karakter (minPasswordLength di lib/auth.ts).");
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

const url = process.env.DATABASE_URL || "file:sqlite.db";

if (url.startsWith("postgres")) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
        const found = await client.query('SELECT id FROM "user" WHERE lower(email) = lower($1)', [email]);
        const userId = found.rows[0]?.id;
        if (!userId) {
            console.error(`User tidak ditemukan: ${email}`);
            process.exit(1);
        }
        const updated = await client.query(
            `UPDATE account SET password = $1 WHERE "userId" = $2 AND "providerId" = 'credential'`,
            [hash, userId],
        );
        if (updated.rowCount === 0) {
            console.error("Tidak ada baris account yang diubah — user mungkin tanpa akun credential.");
            process.exit(1);
        }
        // Sesi lama dihapus supaya sandi lama benar-benar tidak bisa dipakai lagi.
        const cleared = await client.query('DELETE FROM session WHERE "userId" = $1', [userId]);
        console.log(`Password ${email} berhasil direset. Sesi lama dihapus: ${cleared.rowCount}.`);
    } finally {
        await client.end();
    }
} else {
    const { createClient } = await import("@libsql/client");
    const db = createClient({ url });
    const userRes = await db.execute({ sql: "SELECT id FROM user WHERE email = ?", args: [email] });
    const userId = userRes.rows[0]?.id;
    if (!userId) {
        console.error(`User tidak ditemukan: ${email}`);
        process.exit(1);
    }
    const upd = await db.execute({
        sql: "UPDATE account SET password = ? WHERE userId = ? AND providerId = 'credential'",
        args: [hash, userId],
    });
    if (upd.rowsAffected === 0) {
        console.error("Tidak ada baris account yang diubah — user mungkin tanpa akun credential.");
        process.exit(1);
    }
    console.log(`Password ${email} berhasil direset.`);
}
