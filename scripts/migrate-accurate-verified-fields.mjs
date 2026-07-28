/**
 * Tujuan: Tambah kolom stok, limit kredit, dan status faktur — nama field Accurate yang
 *         diverifikasi live 2026-07-28 (lihat docs/prd/INTEGRASI_WEB_SALES.md).
 * Caller: Developer/admin sekali sebelum lib/sync.ts versi baru (modul item_stock + field
 *         customerLimit* + statusName/age/dueDate) dijalankan.
 * Dependensi: pg, DATABASE_URL PostgreSQL.
 * Main Functions: ALTER TABLE ADD COLUMN IF NOT EXISTS (idempotent, additive).
 * Side Effects: DDL additive saja — tidak mengubah/menghapus data yang ada.
 */
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) throw new Error("DATABASE_URL PostgreSQL wajib di-set.");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

await client.query(`ALTER TABLE item ADD COLUMN IF NOT EXISTS quantity double precision`);
await client.query(`ALTER TABLE item ADD COLUMN IF NOT EXISTS quantity_in_all_unit text`);
console.log("OK: item.quantity + item.quantity_in_all_unit");

await client.query(`ALTER TABLE customer ADD COLUMN IF NOT EXISTS credit_limit_enabled boolean`);
await client.query(`ALTER TABLE customer ADD COLUMN IF NOT EXISTS credit_limit_amount double precision`);
await client.query(`ALTER TABLE customer ADD COLUMN IF NOT EXISTS credit_age_limit_enabled boolean`);
await client.query(`ALTER TABLE customer ADD COLUMN IF NOT EXISTS credit_age_limit_days integer`);
console.log("OK: customer.credit_limit_* + customer.credit_age_limit_*");

await client.query(`ALTER TABLE sales_invoice ADD COLUMN IF NOT EXISTS due_date text`);
await client.query(`ALTER TABLE sales_invoice ADD COLUMN IF NOT EXISTS age integer`);
console.log("OK: sales_invoice.due_date + sales_invoice.age");

client.release();
await pool.end();
console.log("Selesai.");
