/**
 * seed-form-kontrol.mjs
 * Seeds realistic dummy data for Form Kontrol SUPER.
 * Run: node scripts/seed-form-kontrol.mjs
 *
 * Produces:
 *   - 3 salesmen × 4 principals × ~15 stores = ~180 jks_master rows
 *   - ao_control_daily for today + past 6 days (~1,260 rows)
 *   - merchandising_check for visited stores (~400 rows)
 *   - salesman_daily_report for past 7 days (21 rows)
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

// ── Salesmen ────────────────────────────────────────────────────────────────
const SALESMEN = [
  { code: "S001", name: "Budi Santoso",   spv: "SPV Joko",  sm: "SM Arif" },
  { code: "S002", name: "Wati Rahayu",    spv: "SPV Joko",  sm: "SM Arif" },
  { code: "S003", name: "Deni Kurniawan", spv: "SPV Siti",  sm: "SM Arif" },
];

const PRINCIPLES = ["GODREJ", "MONTISS", "MUSTIKA RATU", "SOFTEX"];
const HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const POLA = ["all", "ganjil", "genap"];
const FREQ = [1, 1, 1, 2, 2, 4]; // weighted: 1x most common
const MARKETS = ["Toko Kelontong", "Minimarket", "Supermarket", "Warung", "Apotek"];
const KOTAS = ["Bandung", "Cimahi", "Garut", "Sumedang"];
const AREAS = ["Area Barat", "Area Timur", "Area Selatan", "Area Utara"];
const RAYONS = ["Rayon 01", "Rayon 02", "Rayon 03", "Rayon 04", "Rayon 05"];

const STORE_PREFIXES = [
  "Toko Maju", "Warung Jaya", "Mini Mart", "Toko Barokah", "Warung Berkah",
  "Toko Makmur", "Kios Sejahtera", "Toko Harapan", "Warung Ceria", "Toko Indah",
  "Mart Pratama", "Toko Mandiri", "Warung Rezeki", "Toko Abadi", "Minimart Segar",
];

function randOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

// ── Generate stores per salesman × principle ─────────────────────────────────
const stores = [];
const usedCustCodes = new Set();

let storeSeq = 1;
for (const sm of SALESMEN) {
  for (const principle of PRINCIPLES) {
    const count = randInt(12, 18);
    for (let i = 0; i < count; i++) {
      let custCode;
      do { custCode = `C${String(storeSeq++).padStart(4, "0")}`; } while (usedCustCodes.has(custCode + principle));
      usedCustCodes.add(custCode + principle);

      const prefix = STORE_PREFIXES[(storeSeq - 1) % STORE_PREFIXES.length];
      stores.push({
        id: randomUUID(),
        salesCode: sm.code,
        salesName: sm.name,
        custCode,
        custName: `${prefix} ${custCode.slice(1)}`,
        market: randOf(MARKETS),
        alamat: `Jl. Raya No.${randInt(1, 200)}`,
        kota: randOf(KOTAS),
        hariKunjungan: randOf(HARI),
        mingguPattern: randOf(POLA),
        area: randOf(AREAS),
        rayon: randOf(RAYONS),
        principle,
        visitFrequency: randOf(FREQ),
        isActive: 1,
      });
    }
  }
}

console.log(`\n📋 Inserting ${stores.length} jks_master rows...`);
const insertJks = db.prepare(`
  INSERT OR IGNORE INTO jks_master
    (id, sales_code, sales_name, cust_code, cust_name, market, alamat, kota,
     hari_kunjungan, minggu_pattern, area, rayon, principle, channel,
     visit_frequency, is_active, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'TT',?,?,?,?)
`);
const now = Date.now();
db.transaction(() => {
  for (const s of stores) {
    insertJks.run(
      s.id, s.salesCode, s.salesName, s.custCode, s.custName,
      s.market, s.alamat, s.kota, s.hariKunjungan, s.mingguPattern,
      s.area, s.rayon, s.principle, s.visitFrequency, s.isActive,
      now, now
    );
  }
})();
console.log(`  ✅ jks_master: ${stores.length} rows`);

// ── Generate AO control for past 7 days ─────────────────────────────────────
const today = new Date();
const STATUSES = ["ordered","ordered","ordered","ordered","active","not_order","not_order","not_visited"];
const REASON_CODES = ["R01","R02","R03","R05","R07","R08","R14"];

const insertAo = db.prepare(`
  INSERT OR IGNORE INTO ao_control_daily
    (id, sales_code, cust_code, principle, date, period_month, period_year,
     status, order_value_dpp, is_visited, no_order_reason_code, no_order_note,
     auto_matched, source, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,'manual',?,?)
`);

let aoCount = 0;
db.transaction(() => {
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - dayOffset);
    const dateStr = d.toISOString().slice(0, 10);
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    const dayOfWeek = d.getDay();

    for (const store of stores) {
      if (dayOfWeek === 0) continue; // skip Sunday
      if (Math.random() < 0.30) continue; // ~30% skip per day

      const status = randOf(STATUSES);
      const isVisited = status !== "not_visited" ? 1 : 0;
      const orderValue = (status === "ordered" || status === "active")
        ? randInt(150_000, 5_000_000)
        : 0;
      const reasonCode = status === "not_order" ? randOf(REASON_CODES) : null;
      const reasonNote = reasonCode && Math.random() > 0.6
        ? "Toko minta kunjungan ulang minggu depan"
        : null;

      insertAo.run(
        randomUUID(),
        store.salesCode, store.custCode, store.principle,
        dateStr, month, year,
        status, orderValue, isVisited,
        reasonCode, reasonNote,
        now, now
      );
      aoCount++;
    }
  }
})();
console.log(`  ✅ ao_control_daily: ${aoCount} rows`);

// ── Merchandising checks for visited stores today ────────────────────────────
const todayStr = today.toISOString().slice(0, 10);
const visitedToday = db.prepare(
  `SELECT sales_code, cust_code, principle FROM ao_control_daily WHERE date=? AND is_visited=1`
).all(todayStr);

const insertMerch = db.prepare(`
  INSERT OR IGNORE INTO merchandising_check
    (id, sales_code, cust_code, principle, date,
     produk_jelas, display_rapi, dibersihkan, ditataulang, posisi_mudah, semua_sku,
     note, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

let merchCount = 0;
db.transaction(() => {
  for (const row of visitedToday) {
    if (Math.random() < 0.4) continue; // ~60% fill in merch
    const checks = Array.from({ length: 6 }, () => Math.random() > 0.3 ? 1 : 0);
    const note = checks.filter(Boolean).length < 4 ? "Display perlu diperbaiki" : null;
    insertMerch.run(
      randomUUID(),
      row.sales_code, row.cust_code, row.principle, todayStr,
      ...checks, note, now
    );
    merchCount++;
  }
})();
console.log(`  ✅ merchandising_check: ${merchCount} rows (today)`);

// ── Daily reports per salesman × 7 days ─────────────────────────────────────
const insertReport = db.prepare(`
  INSERT OR IGNORE INTO salesman_daily_report
    (id, sales_code, date, period_month, period_year,
     total_toko_jks, total_order, total_active, total_not_order, total_not_visited,
     reason_summary, tindak_lanjut, submitted_at, spv_ack)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)
`);

let reportCount = 0;
db.transaction(() => {
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - dayOffset);
    if (d.getDay() === 0) continue; // skip Sunday
    const dateStr = d.toISOString().slice(0, 10);
    const month = d.getMonth() + 1;
    const year = d.getFullYear();

    for (const sm of SALESMEN) {
      const rows = db.prepare(
        `SELECT status FROM ao_control_daily WHERE sales_code=? AND date=?`
      ).all(sm.code, dateStr);

      const totalJks = rows.length || randInt(18, 25);
      const order    = rows.filter(r => r.status === "ordered").length   || randInt(8, 14);
      const active   = rows.filter(r => r.status === "active").length    || randInt(2, 5);
      const notOrder = rows.filter(r => r.status === "not_order").length || randInt(2, 6);
      const notVisit = rows.filter(r => r.status === "not_visited").length || randInt(0, 3);

      const tindakLanjut = [
        `${notOrder} toko tidak order akan difollow-up besok pagi.`,
        `Toko dengan stok cukup dijadwalkan ulang minggu depan.`,
        `Koordinasi dengan SPV untuk toko yang butuh visit khusus.`,
      ].join(" ");

      insertReport.run(
        randomUUID(),
        sm.code, dateStr, month, year,
        totalJks, order, active, notOrder, notVisit,
        JSON.stringify({ R01: notOrder > 0 ? 1 : 0 }),
        tindakLanjut,
        now + randInt(0, 3_600_000)
      );
      reportCount++;
    }
  }
})();
console.log(`  ✅ salesman_daily_report: ${reportCount} rows`);

// ── Summary ──────────────────────────────────────────────────────────────────
const tables = ["jks_master","ao_control_daily","merchandising_check","salesman_daily_report","no_order_reason"];
const counts = tables.map(t => `${t}: ${db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c}`).join("\n  ");
console.log(`\n📊 Final counts:\n  ${counts}`);

db.pragma("foreign_keys = ON");
db.close();
console.log("\n✅ Seed done.");
