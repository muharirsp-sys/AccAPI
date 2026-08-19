/**
 * Tujuan: Tambah kolom `last_update_at timestamptz` di sales_invoice supaya daftar faktur bisa
 *         diurutkan menurut WAKTU SIMPAN seperti tabel Accurate (apple-to-apple).
 *         Kolom `last_update` yang lama bertipe TEXT format "dd/MM/yyyy HH:mm:ss" — mengurutkannya
 *         sebagai teks salah (31/12/2025 dianggap > 01/01/2026).
 * Caller: Developer/admin sekali, sebelum/sesudah deploy perubahan sync.
 * Dependensi: pg, DATABASE_URL PostgreSQL.
 * Side Effects: DDL additive + backfill dari kolom teks yang sudah ada. Tidak menghapus apa pun.
 *
 * Zona: nilai teks Accurate ada di UTC+7 (dibuktikan dari webhook_events.log — receivedAt
 * 09:07:44Z berpasangan dengan timestamp "19/08/2026 16:07:43"). to_timestamp() menafsirkan
 * input memakai zona server (UTC di container), jadi WAJIB di-AT TIME ZONE '+07:00'.
 *
 * Catatan: indeks ekspresi `to_timestamp(...)` TIDAK bisa dipakai di Postgres — fungsinya STABLE,
 * bukan IMMUTABLE. Karena itu nilainya disimpan di kolom nyata (diisi lib/sync.ts saat upsert),
 * lalu diindeks seperti kolom biasa.
 */
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) throw new Error("DATABASE_URL PostgreSQL wajib di-set.");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

await client.query(`ALTER TABLE sales_invoice ADD COLUMN IF NOT EXISTS last_update_at timestamptz`);
console.log("OK: sales_invoice.last_update_at");

// Backfill dua bentuk yang benar-benar ada di kolom teks:
//   1) "dd/MM/yyyy HH:mm:ss" — bentuk asli Accurate.
//   2) ISO — fallback lama di lib/sync.ts saat Accurate tidak mengirim lastUpdate.
const dmy = await client.query(`
    UPDATE sales_invoice
       SET last_update_at = to_timestamp(last_update, 'DD/MM/YYYY HH24:MI:SS')::timestamp AT TIME ZONE '+07:00'
     WHERE last_update_at IS NULL
       AND last_update ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
`);
console.log(`Backfill dd/MM/yyyy: ${dmy.rowCount} baris`);

const iso = await client.query(`
    UPDATE sales_invoice
       SET last_update_at = last_update::timestamptz
     WHERE last_update_at IS NULL
       AND last_update ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
`);
console.log(`Backfill ISO: ${iso.rowCount} baris`);

// Urutan halaman: last_update_at DESC, id DESC. Indeks komposit menutupi keduanya.
await client.query(
    `CREATE INDEX IF NOT EXISTS idx_sales_invoice_last_update_at ON sales_invoice(last_update_at DESC, id DESC)`
);
console.log("OK: idx_sales_invoice_last_update_at");

const sisa = await client.query(`SELECT count(*) AS n FROM sales_invoice WHERE last_update_at IS NULL`);
console.log(`Masih NULL (format tak dikenal / kosong): ${sisa.rows[0].n}`);

client.release();
await pool.end();
