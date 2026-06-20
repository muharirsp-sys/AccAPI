/**
 * Seed Insentif Sales (skema GT konstanta-bobot) — SINKRON dengan form-kontrol.
 * Sumber salesman + principle diambil dari `jks_master` (form-kontrol) supaya kedua
 * modul memakai master salesman yang sama. Channel di-set "GT" agar memakai skema
 * insentif baru (lib/insentif-sales-calc); semua principle = tipe "mix".
 *
 * Jalankan: DATABASE_URL=file:sqlite.db node scripts/seed-insentif-gt.mjs
 */
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";

const c = createClient({ url: process.env.DATABASE_URL || "file:sqlite.db" });
const M = 6, Y = 2026, NOW = Math.floor(Date.now() / 1000);
const DATE = `${Y}-${String(M).padStart(2, "0")}-16`;

// Ambil kombinasi salesman+principle dari form-kontrol (single source of truth).
const combos = (await c.execute(
    "SELECT DISTINCT sales_code, sales_name, principle FROM jks_master ORDER BY sales_code, principle"
)).rows;

if (combos.length === 0) {
    console.error("jks_master kosong — seed form-kontrol dulu (scripts/seed-form-kontrol.mjs).");
    process.exit(1);
}

// Target nilai per principle (sintetis, untuk demo). Realisasi ~95% → pengali 0.95.
const TARGET_VALUE = 100_000_000;
const TARGET_AO = 240;          // konstan sesuai spec
const REAL_VALUE = 95_000_000;  // 95%
const REAL_AO = 228;            // 95% dari 240

async function upsertTarget(code, name, prin) {
    await c.execute({ sql: "DELETE FROM sales_targets WHERE sales_code=? AND principle=? AND period_month=? AND period_year=?", args: [code, prin, M, Y] });
    await c.execute({
        sql: `INSERT INTO sales_targets (id,sales_code,sales_name,principle,branch,channel,spv_name,sm_name,period_month,period_year,target_value,target_ec,target_ao,target_ia,splm_value,tipe_sales,status_insentif,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [randomUUID(), code, name, prin, "MAKASSAR", "GT", "SPV Demo", "SM Demo", M, Y, TARGET_VALUE, 300, TARGET_AO, 500, 0, "mix", "distributor_principle", NOW, NOW],
    });
}

async function upsertProgress(code, prin) {
    await c.execute({ sql: "DELETE FROM sales_daily_progress WHERE sales_code=? AND principle=? AND period_month=? AND period_year=?", args: [code, prin, M, Y] });
    await c.execute({
        sql: `INSERT INTO sales_daily_progress (id,sales_code,principle,branch,date,period_month,period_year,invoice_number,achieved_value_dpp,achieved_ec,achieved_ao,achieved_ia,uploaded_by,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [randomUUID(), code, prin, "MAKASSAR", DATE, M, Y, null, REAL_VALUE, 285, REAL_AO, 475, "seed-gt", NOW],
    });
}

console.log(`\nSeeding Insentif GT (sinkron form-kontrol) — ${M}/${Y}\n`);
for (const r of combos) {
    await upsertTarget(r.sales_code, r.sales_name, r.principle);
    await upsertProgress(r.sales_code, r.principle);
    console.log(`  ${r.sales_code} ${r.sales_name} / ${r.principle}`);
}

const salesmen = new Set(combos.map((r) => r.sales_code)).size;
console.log(`\nDone: ${combos.length} baris target+progress untuk ${salesmen} salesman (channel GT, tipe mix).`);
