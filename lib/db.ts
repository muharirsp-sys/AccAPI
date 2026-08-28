import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// D4 cutover: PostgreSQL. Rollback = kembalikan DATABASE_URL file:sqlite.db + revert branch.
//
// Timeout WAJIB eksplisit. Default `pg` adalah connectionTimeoutMillis: 0 = menunggu
// SELAMANYA saat pool habis, dan tanpa statement_timeout satu query nyangkut menahan
// koneksinya tanpa batas. Kombinasi itu yang bikin request "pending" bermenit-menit
// tanpa error: pool kering, semua request antre di belakangnya.
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX || 20),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // ponytail: satu angka global. Naikkan lewat env kalau ada satu statement (bukan satu
    // route) yang memang perlu lebih lama — job panjang biasanya banyak query pendek.
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 60_000),
});

// Client idle yang diputus DB/proxy melempar error di luar konteks request; tanpa handler
// ini prosesnya ikut mati.
pool.on('error', (err) => {
    console.error('[pg] idle client error:', err.message);
});

export const db = drizzle(pool);
