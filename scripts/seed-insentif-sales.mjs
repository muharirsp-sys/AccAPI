/**
 * Seed script: isi DB dengan demo data Insentif Sales dari mock constants.
 * Jalankan: node scripts/seed-insentif-sales.mjs
 * Akan upsert: sales_targets, sales_daily_progress, incentive_tiers (Juni 2026).
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../sqlite.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const PERIOD_MONTH = 6;
const PERIOD_YEAR = 2026;
const NOW = Math.floor(Date.now() / 1000);

const SALESMEN = [
    { code: "SLS-001", name: "Andi Pratama",   principle: "NESTLE",   branch: "BANDUNG",  channel: "TT", spv: "Budi Santoso", sm: "Hendra Wijaya", targetValue: 250_000_000, targetEc: 320, targetAo: 180, targetIa: 540, realValue: 168_500_000, realEc: 198, realAo: 142, realIa: 421, splmValue: 142_300_000 },
    { code: "SLS-002", name: "Siti Rahmawati", principle: "NESTLE",   branch: "BANDUNG",  channel: "MT", spv: "Budi Santoso", sm: "Hendra Wijaya", targetValue: 210_000_000, targetEc: 280, targetAo: 160, targetIa: 480, realValue: 205_900_000, realEc: 271, realAo: 158, realIa: 502, splmValue: 188_400_000 },
    { code: "SLS-003", name: "Rudi Hartono",   principle: "UNILEVER", branch: "CIMAHI",   channel: "TT", spv: "Dewi Lestari", sm: "Hendra Wijaya", targetValue: 300_000_000, targetEc: 360, targetAo: 200, targetIa: 600, realValue: 132_700_000, realEc: 158, realAo: 121, realIa: 318, splmValue: 151_900_000 },
    { code: "SLS-004", name: "Maya Anggraini", principle: "UNILEVER", branch: "CIMAHI",   channel: "MT", spv: "Dewi Lestari", sm: "Hendra Wijaya", targetValue: 180_000_000, targetEc: 240, targetAo: 140, targetIa: 420, realValue: 161_400_000, realEc: 219, realAo: 133, realIa: 408, splmValue: 144_600_000 },
    { code: "SLS-005", name: "Fajar Nugroho",  principle: "INDOFOOD", branch: "SUMEDANG", channel: "TT", spv: "Eko Saputra",  sm: "Hendra Wijaya", targetValue: 220_000_000, targetEc: 300, targetAo: 170, targetIa: 510, realValue: 142_800_000, realEc: 174, realAo: 139, realIa: 372, splmValue: 138_100_000 },
    { code: "SLS-006", name: "Lina Marlina",   principle: "INDOFOOD", branch: "SUMEDANG", channel: "MT", spv: "Eko Saputra",  sm: "Hendra Wijaya", targetValue: 195_000_000, targetEc: 260, targetAo: 150, targetIa: 450, realValue: 196_200_000, realEc: 258, realAo: 151, realIa: 471, splmValue: 170_500_000 },
];

const INCENTIVE_TIERS = [
    { kpiType: "value", minPct: 80,  maxPct: 90,     amount: 250_000 },
    { kpiType: "value", minPct: 90,  maxPct: 100,    amount: 500_000 },
    { kpiType: "value", minPct: 100, maxPct: 110,    amount: 850_000 },
    { kpiType: "value", minPct: 110, maxPct: 999999, amount: 1_200_000 },
    { kpiType: "ec",    minPct: 80,  maxPct: 100,    amount: 150_000 },
    { kpiType: "ec",    minPct: 100, maxPct: 999999, amount: 350_000 },
    { kpiType: "ao",    minPct: 80,  maxPct: 100,    amount: 200_000 },
    { kpiType: "ao",    minPct: 100, maxPct: 999999, amount: 450_000 },
    { kpiType: "ia",    minPct: 80,  maxPct: 100,    amount: 175_000 },
    { kpiType: "ia",    minPct: 100, maxPct: 999999, amount: 400_000 },
];

function upsertTarget(s) {
    const existing = db.prepare(
        "SELECT id FROM sales_targets WHERE sales_code=? AND period_month=? AND period_year=?"
    ).get(s.code, PERIOD_MONTH, PERIOD_YEAR);

    if (existing) {
        db.prepare(`
            UPDATE sales_targets SET sales_name=?, principle=?, branch=?, channel=?,
                spv_name=?, sm_name=?, target_value=?, target_ec=?, target_ao=?,
                target_ia=?, splm_value=?, updated_at=?
            WHERE id=?
        `).run(s.name, s.principle, s.branch, s.channel, s.spv, s.sm,
               s.targetValue, s.targetEc, s.targetAo, s.targetIa, s.splmValue, NOW, existing.id);
        return "updated";
    }
    db.prepare(`
        INSERT INTO sales_targets
            (id, sales_code, sales_name, principle, branch, channel, spv_name, sm_name,
             period_month, period_year, target_value, target_ec, target_ao, target_ia,
             splm_value, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(randomUUID(), s.code, s.name, s.principle, s.branch, s.channel, s.spv, s.sm,
           PERIOD_MONTH, PERIOD_YEAR, s.targetValue, s.targetEc, s.targetAo, s.targetIa,
           s.splmValue, NOW, NOW);
    return "inserted";
}

function upsertProgress(s) {
    const date = `${PERIOD_YEAR}-${String(PERIOD_MONTH).padStart(2, "0")}-16`;
    const existing = db.prepare(
        "SELECT id FROM sales_daily_progress WHERE sales_code=? AND period_month=? AND period_year=? AND date=?"
    ).get(s.code, PERIOD_MONTH, PERIOD_YEAR, date);

    if (existing) {
        db.prepare(`
            UPDATE sales_daily_progress SET
                achieved_value_dpp=?, achieved_ec=?, achieved_ao=?, achieved_ia=?
            WHERE id=?
        `).run(s.realValue, s.realEc, s.realAo, s.realIa, existing.id);
        return "updated";
    }
    db.prepare(`
        INSERT INTO sales_daily_progress
            (id, sales_code, principle, branch, date, period_month, period_year,
             invoice_number, achieved_value_dpp, achieved_ec, achieved_ao, achieved_ia,
             uploaded_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(randomUUID(), s.code, s.principle, s.branch, date,
           PERIOD_MONTH, PERIOD_YEAR, null, s.realValue, s.realEc, s.realAo, s.realIa, "seed", NOW);
    return "inserted";
}

function seedTiers() {
    db.prepare("DELETE FROM incentive_tiers WHERE principle='ALL' AND branch='ALL'").run();
    for (const t of INCENTIVE_TIERS) {
        db.prepare(`
            INSERT INTO incentive_tiers
                (id, principle, branch, kpi_type, min_percentage, max_percentage, incentive_amount, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
        `).run(randomUUID(), "ALL", "ALL", t.kpiType, t.minPct, t.maxPct, t.amount, NOW, NOW);
    }
    return INCENTIVE_TIERS.length;
}

console.log(`\nSeeding Insentif Sales — ${PERIOD_MONTH}/${PERIOD_YEAR}\n`);

console.log("sales_targets:");
for (const s of SALESMEN) {
    console.log(`  ${upsertTarget(s)}: ${s.code} ${s.name}`);
}

console.log("\nsales_daily_progress:");
for (const s of SALESMEN) {
    console.log(`  ${upsertProgress(s)}: ${s.code} value=${s.realValue.toLocaleString("id-ID")}`);
}

console.log("\nincentive_tiers:");
console.log(`  inserted ${seedTiers()} tiers`);

const tCount = db.prepare("SELECT COUNT(*) as c FROM sales_targets").get().c;
const pCount = db.prepare("SELECT COUNT(*) as c FROM sales_daily_progress").get().c;
const iCount = db.prepare("SELECT COUNT(*) as c FROM incentive_tiers").get().c;
console.log(`\nDB state: targets=${tCount}, progress=${pCount}, tiers=${iCount}`);
db.close();
