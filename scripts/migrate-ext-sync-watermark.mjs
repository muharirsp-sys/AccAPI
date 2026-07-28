/**
 * Tujuan: Tambah watermark lokal `synced_at` + index keyset pada tabel cache Accurate,
 *         sebagai sumber delta feed ke Web Sales (GET /api/ext/changes).
 * Caller: Developer/admin sekali sebelum endpoint /api/ext/changes dipakai.
 * Dependensi: pg, DATABASE_URL PostgreSQL.
 * Main Functions: ALTER TABLE ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS (idempotent).
 * Side Effects: DDL additive saja — tidak mengubah/menghapus data yang ada.
 */
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) throw new Error("DATABASE_URL PostgreSQL wajib di-set.");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

// Baris lama dapat synced_at = now() saat kolom ditambahkan. Konsekuensinya Web Sales
// menarik seluruh isi tabel sekali di sync pertama — itu memang yang kita mau.
for (const table of ["item", "customer", "sales_invoice", "sales_return"]) {
    await client.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS synced_at timestamptz NOT NULL DEFAULT now()`
    );
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_synced_at ON ${table}(synced_at, id)`
    );
    console.log(`OK: ${table}.synced_at + idx_${table}_synced_at`);
}

client.release();
await pool.end();
console.log("Selesai.");
