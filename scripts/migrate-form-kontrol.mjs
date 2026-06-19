/**
 * migrate-form-kontrol.mjs
 * Creates Form Kontrol SUPER tables and seeds no_order_reason.
 * Run: node scripts/migrate-form-kontrol.mjs
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../sqlite.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF");
console.log("📦 DB:", DB_PATH);

const ddl = [
  {
    name: "jks_master",
    sql: `CREATE TABLE IF NOT EXISTS jks_master (
      id TEXT PRIMARY KEY,
      sales_code TEXT NOT NULL,
      sales_name TEXT NOT NULL,
      cust_code TEXT NOT NULL,
      cust_name TEXT NOT NULL,
      market TEXT,
      alamat TEXT,
      kota TEXT,
      hari_kunjungan TEXT,
      minggu_pattern TEXT NOT NULL DEFAULT 'all',
      area TEXT,
      rayon TEXT,
      principle TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'TT',
      visit_frequency INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  },
  { name: "idx_jks_sales_principle", sql: `CREATE INDEX IF NOT EXISTS idx_jks_sales_principle ON jks_master(sales_code, principle)` },
  { name: "idx_jks_cust_code",       sql: `CREATE INDEX IF NOT EXISTS idx_jks_cust_code ON jks_master(cust_code)` },
  { name: "idx_jks_principle_hari",  sql: `CREATE INDEX IF NOT EXISTS idx_jks_principle_hari ON jks_master(principle, hari_kunjungan)` },
  { name: "idx_jks_unique",          sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_jks_unique ON jks_master(sales_code, cust_code, principle)` },
  {
    name: "sales_outlet_txn",
    sql: `CREATE TABLE IF NOT EXISTS sales_outlet_txn (
      id TEXT PRIMARY KEY,
      sales_code TEXT NOT NULL,
      cust_code TEXT NOT NULL,
      principle TEXT NOT NULL,
      date TEXT NOT NULL,
      period_month INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      invoice_number TEXT,
      value_dpp REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
  },
  { name: "idx_sot_cust_date",    sql: `CREATE INDEX IF NOT EXISTS idx_sot_cust_date ON sales_outlet_txn(cust_code, date)` },
  { name: "idx_sot_sales_period", sql: `CREATE INDEX IF NOT EXISTS idx_sot_sales_period ON sales_outlet_txn(sales_code, period_month, period_year)` },
  {
    name: "no_order_reason",
    sql: `CREATE TABLE IF NOT EXISTS no_order_reason (
      id TEXT PRIMARY KEY,
      reason_code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    )`,
  },
  {
    name: "ao_control_daily",
    sql: `CREATE TABLE IF NOT EXISTS ao_control_daily (
      id TEXT PRIMARY KEY,
      sales_code TEXT NOT NULL,
      cust_code TEXT NOT NULL,
      principle TEXT NOT NULL,
      date TEXT NOT NULL,
      period_month INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_visited',
      order_value_dpp REAL,
      invoice_number TEXT,
      is_visited INTEGER,
      no_order_reason_code TEXT,
      no_order_note TEXT,
      auto_matched INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  },
  { name: "idx_ao_sales_date",   sql: `CREATE INDEX IF NOT EXISTS idx_ao_sales_date ON ao_control_daily(sales_code, date)` },
  { name: "idx_ao_cust_period",  sql: `CREATE INDEX IF NOT EXISTS idx_ao_cust_period ON ao_control_daily(cust_code, period_month, period_year)` },
  { name: "idx_ao_status",       sql: `CREATE INDEX IF NOT EXISTS idx_ao_status ON ao_control_daily(status)` },
  { name: "idx_ao_unique",       sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_ao_unique ON ao_control_daily(sales_code, cust_code, principle, date)` },
  {
    name: "merchandising_check",
    sql: `CREATE TABLE IF NOT EXISTS merchandising_check (
      id TEXT PRIMARY KEY,
      sales_code TEXT NOT NULL,
      cust_code TEXT NOT NULL,
      principle TEXT NOT NULL,
      date TEXT NOT NULL,
      produk_jelas INTEGER NOT NULL DEFAULT 0,
      display_rapi INTEGER NOT NULL DEFAULT 0,
      dibersihkan INTEGER NOT NULL DEFAULT 0,
      ditataulang INTEGER NOT NULL DEFAULT 0,
      posisi_mudah INTEGER NOT NULL DEFAULT 0,
      semua_sku INTEGER NOT NULL DEFAULT 0,
      photo_url TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    )`,
  },
  { name: "idx_merch_sales_date", sql: `CREATE INDEX IF NOT EXISTS idx_merch_sales_date ON merchandising_check(sales_code, date)` },
  { name: "idx_merch_cust_date",  sql: `CREATE INDEX IF NOT EXISTS idx_merch_cust_date ON merchandising_check(cust_code, date)` },
  {
    name: "salesman_daily_report",
    sql: `CREATE TABLE IF NOT EXISTS salesman_daily_report (
      id TEXT PRIMARY KEY,
      sales_code TEXT NOT NULL,
      date TEXT NOT NULL,
      period_month INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      total_toko_jks INTEGER NOT NULL DEFAULT 0,
      total_order INTEGER NOT NULL DEFAULT 0,
      total_active INTEGER NOT NULL DEFAULT 0,
      total_not_order INTEGER NOT NULL DEFAULT 0,
      total_not_visited INTEGER NOT NULL DEFAULT 0,
      reason_summary TEXT,
      tindak_lanjut TEXT,
      submitted_at INTEGER,
      spv_ack INTEGER NOT NULL DEFAULT 0,
      spv_ack_by TEXT,
      spv_ack_at INTEGER
    )`,
  },
  { name: "idx_sdr_sales_period", sql: `CREATE INDEX IF NOT EXISTS idx_sdr_sales_period ON salesman_daily_report(sales_code, period_month, period_year)` },
  { name: "idx_sdr_date",         sql: `CREATE INDEX IF NOT EXISTS idx_sdr_date ON salesman_daily_report(date)` },
  { name: "idx_sdr_unique",       sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_sdr_unique ON salesman_daily_report(sales_code, date)` },
  {
    name: "spv_briefing",
    sql: `CREATE TABLE IF NOT EXISTS spv_briefing (
      id TEXT PRIMARY KEY,
      spv_name TEXT NOT NULL,
      date TEXT NOT NULL,
      session TEXT NOT NULL,
      agenda TEXT,
      toko_dibahas TEXT,
      penyebab TEXT,
      solusi TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    )`,
  },
  { name: "idx_briefing_spv_date", sql: `CREATE INDEX IF NOT EXISTS idx_briefing_spv_date ON spv_briefing(spv_name, date)` },
  {
    name: "sm_control",
    sql: `CREATE TABLE IF NOT EXISTS sm_control (
      id TEXT PRIMARY KEY,
      sm_name TEXT NOT NULL,
      date TEXT NOT NULL,
      spv_checked TEXT,
      jks_checked INTEGER NOT NULL DEFAULT 0,
      foto_checked INTEGER NOT NULL DEFAULT 0,
      coaching_note TEXT,
      deviations TEXT,
      follow_up TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    )`,
  },
  { name: "idx_sm_control_date", sql: `CREATE INDEX IF NOT EXISTS idx_sm_control_date ON sm_control(sm_name, date)` },
  {
    name: "kontrol_audit_log",
    sql: `CREATE TABLE IF NOT EXISTS kontrol_audit_log (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL
    )`,
  },
  { name: "idx_kal_entity", sql: `CREATE INDEX IF NOT EXISTS idx_kal_entity ON kontrol_audit_log(entity, entity_id)` },
  { name: "idx_kal_actor",  sql: `CREATE INDEX IF NOT EXISTS idx_kal_actor ON kontrol_audit_log(actor_id)` },
];

for (const m of ddl) {
  db.prepare(m.sql).run();
  console.log(`  ✅ ${m.name}`);
}

const reasons = [
  { code: "R01", label: "Stok masih cukup",               category: "stok",    order: 1 },
  { code: "R02", label: "SKU belum lengkap",               category: "produk",  order: 2 },
  { code: "R03", label: "Produk belum terpajang",          category: "produk",  order: 3 },
  { code: "R04", label: "Produk sulit ditemukan konsumen", category: "produk",  order: 4 },
  { code: "R05", label: "PIC belum mengenal produk",       category: "relasi",  order: 5 },
  { code: "R06", label: "PIC belum percaya",               category: "relasi",  order: 6 },
  { code: "R07", label: "Toko masih punya tagihan OD",     category: "tagihan", order: 7 },
  { code: "R08", label: "Salesmanship belum kuat",         category: "proses",  order: 8 },
  { code: "R09", label: "Negosiasi belum berhasil",        category: "proses",  order: 9 },
  { code: "R10", label: "Kunjungan kurang rutin",          category: "proses",  order: 10 },
  { code: "R11", label: "Toko kurang diperhatikan",        category: "proses",  order: 11 },
  { code: "R12", label: "SKU terbatas",                    category: "produk",  order: 12 },
  { code: "R13", label: "Prioritas toko rendah",           category: "proses",  order: 13 },
  { code: "R14", label: "Lainnya",                         category: "lainnya", order: 14 },
];

const insertReason = db.prepare(
  "INSERT OR IGNORE INTO no_order_reason (id, reason_code, label, category, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1)"
);
db.transaction(() => { for (const r of reasons) insertReason.run(randomUUID(), r.code, r.label, r.category, r.order); })();
console.log("  ✅ no_order_reason seeded (14 rows)");

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log("\n📋 Tables:", tables.join(", "));
db.pragma("foreign_keys = ON");
db.close();
console.log("\n✅ Done.");
