/**
 * Tujuan : Reset (WIPE) seluruh data transaksi lalu SEED data dummy lengkap untuk
 *          SEMUA divisi (Supervisor, Sales Manager, Claim, OM, Finance, Sales, Admin),
 *          mencakup OFF Program Control + Claim Workflow + Discount + Users.
 *
 * Caller : node scripts/seed-dummy-all.mjs --force        (WIPE + SEED penuh)
 *          node scripts/seed-dummy-all.mjs --force --small (volume kecil utk dev cepat)
 *          node scripts/seed-dummy-all.mjs                 (SEED hanya jika tabel kosong)
 *
 * Deps   : @libsql/client, better-auth/crypto (hashPassword scrypt), node:crypto
 *
 * Catatan timestamp:
 *   - Tabel domain (off_*, claim_*, off_discount_*) memakai Drizzle `mode:"timestamp"`
 *     => disimpan dalam DETIK (Math.floor(ms/1000)).
 *   - Tabel user/account diisi mengikuti pola seed QA yang sudah terbukti bisa login
 *     (ms via Date.getTime()). Login tidak bergantung pada timestamp ini.
 */

import { createClient } from "@libsql/client";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const eq = l.indexOf("=");
    if (eq <= 0) continue;
    const k = l.slice(0, eq).trim();
    let v = l.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const DB_URL = process.env.DATABASE_URL || "file:sqlite.db";
const FORCE = process.argv.includes("--force");
const SMALL = process.argv.includes("--small");
const db = createClient({ url: DB_URL });

// ─── Time helpers (DETIK utk tabel domain) ─────────────────────────────────────
const NOW = Math.floor(Date.now() / 1000);
const MS_NOW = Date.now();
const ago = (d) => (d != null ? NOW - Math.round(d) * 86400 : null);
const fwd = (d) => (d != null ? NOW + Math.round(d) * 86400 : null);
const iso = (sec) => (sec != null ? new Date(sec * 1000).toISOString().slice(0, 10) : null);
const B = (v) => (v ? 1 : 0);

// Generic insert: { col: value } -> INSERT aman positional.
async function insertRow(table, obj) {
  const cols = Object.keys(obj);
  // Quote identifiers: kolom seperti `to` (off_notification) adalah reserved keyword.
  const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  await db.execute({ sql, args: cols.map((c) => obj[c]) });
}

// ─── Master data ────────────────────────────────────────────────────────────────
const PRINCIPLES = [
  { name: "RECKITT BENCKISER, PT", code: "RB" },
  { name: "FKS FOOD SEJAHTERA, PT", code: "FKS" },
  { name: "FONTERRA BRANDS INDONESIA, PT", code: "FON" },
  { name: "GUMINDO BOGAMANIS, PT", code: "REBO" },
  { name: "MARKETAMA INDAH, PT", code: "MI" },
  { name: "PRIMARASA ABADI SEJAHTERA, PT", code: "PAS" },
  { name: "SUN PAPER SOURCE, PT", code: "SPS" },
  { name: "GODREJ DISTRIBUSI INDONESIA, PT", code: "GDI" },
  { name: "DOLPHIN, PT", code: "DOLPHIN" },
  { name: "UNIVERSAL INDOFOOD PRODUCT, PT", code: "UNIBIS" },
  { name: "URC INDONESIA, PT", code: "URC" },
  { name: "HEINZ ABC INDONESIA, PT", code: "HEINZ" },
  { name: "ENERGIZER INDONESIA, PT", code: "ENI" },
  { name: "GONDOWANGI TRADISIONAL KOSMETIK, PT", code: "NATUR" },
  { name: "MUSTIKA RATUBUANA INTERNATIONAL", code: "MR" },
  { name: "PRISKILA PRIMA MAKMUR, PT", code: "PRISKILA" },
  { name: "UNITAMA SARI MAS, PT", code: "USM" },
  { name: "VINDA INTERNATIONAL INDONESIA, PT", code: "VINDA" },
  { name: "KINO INDONESIA. TBK, PT", code: "KINO" },
  { name: "ABC PRESIDENT INDONESIA, PT", code: "ABC" },
  { name: "PZ CUSSONS INDONESIA, PT", code: "CUSSONS" },
  { name: "FOKUS RITEL NUSAPRIMA, PT", code: "SHINZUI" },
  { name: "FORISA NUSAPERSADA, PT", code: "FRS" },
  { name: "MOTASA INDONESIA, PT", code: "MOTASA" },
  { name: "PURATOS, PT", code: "PURATOS" },
];

const MONTHS = [
  { b: "01", y: "2025" }, { b: "02", y: "2025" }, { b: "03", y: "2025" },
  { b: "04", y: "2025" }, { b: "05", y: "2025" }, { b: "06", y: "2025" },
  { b: "07", y: "2025" }, { b: "08", y: "2025" }, { b: "09", y: "2025" },
  { b: "10", y: "2025" }, { b: "11", y: "2025" }, { b: "12", y: "2025" },
  { b: "01", y: "2026" }, { b: "02", y: "2026" }, { b: "03", y: "2026" },
  { b: "04", y: "2026" }, { b: "05", y: "2026" }, { b: "06", y: "2026" },
];

// Tipe program final (dropdown) + nilai legacy "kotor" utk uji normalisasi.
const PROG_TYPES = ["Display", "Visibility", "Promo On Store", "Event", "Sample"];
const LEGACY_TYPES = [
  { raw: "off display", norm: "Display" },
  { raw: "visibilty", norm: "Visibility" },
  { raw: "promo instore", norm: "Promo On Store" },
  { raw: "sampling area", norm: "Sample" },
  { raw: "off event", norm: "Event" },
];

const STORES = [
  "Alfamart Sudirman", "Indomaret Gatot Subroto", "Hypermart Semanggi",
  "Giant Kebayoran Baru", "Carrefour Lebak Bulus", "Hero Pondok Indah",
  "Superindo Kemang", "Transmart Cempaka Putih", "Lottemart Fatmawati",
  "Ranch Market Dharmawangsa", "Diamond Menteng", "Farmers Market SCBD",
  "Spar Cilandak", "Indogrosir Cililitan", "Makro BSD City",
  "Alfamart Mampang", "Indomaret Kuningan", "Hypermart Kalibata",
  "Giant Cibubur", "Carrefour Cilandak Town Square",
];

const PRODUCTS = [
  "Produk A Ukuran 1L", "Produk B Pack Isi 6", "Produk C Reguler",
  "Produk D Premium", "Produk E Economy Pack", "Produk F Botol 500ml",
  "Produk G Sachet 50gr", "Produk H Kaleng 400gr", "Produk I Refill Pack",
  "Produk J Travel Size", "Produk K Family Pack", "Produk L Trial Size",
  "Produk M Special Edition", "Produk N Bundle Pack", "Produk O Combo Set",
];

const NOMINALS = [
  1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000,
  4_500_000, 5_000_000, 6_000_000, 7_500_000, 8_000_000, 9_000_000,
  10_000_000, 12_000_000, 15_000_000,
];

const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

// ─── Users dummy per divisi ──────────────────────────────────────────────────
const PASSWORD = "Dummy123!";
const USERS = [
  { email: "admin.dummy@surya.test", name: "Admin Dummy", role: "admin" },
  { email: "spv.dummy@surya.test", name: "Supervisor Dummy", role: "supervisor" },
  { email: "sm.dummy@surya.test", name: "Sales Manager Dummy", role: "sm" },
  { email: "claim.dummy@surya.test", name: "Claim Dummy", role: "claim" },
  { email: "om.dummy@surya.test", name: "Operational Manager Dummy", role: "om" },
  { email: "finance.dummy@surya.test", name: "Finance Dummy", role: "finance" },
  { email: "sales.dummy@surya.test", name: "Sales Dummy", role: "sales" },
];

// ─── Skenario OFF batch (35) ────────────────────────────────────────────────────
const SC = [
  { status: "Draft", smSt: "Not Started", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 3, uDays: 3 },
  { status: "Draft", smSt: "Not Started", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 10, uDays: 8 },
  { status: "Draft", smSt: "Not Started", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 16, uDays: 14 },
  { status: "Submitted to SM", smSt: "Waiting Review", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 2, sDays: 1, uDays: 1 },
  { status: "Submitted to SM", smSt: "Waiting Review", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 5, sDays: 4, uDays: 4 },
  { status: "Submitted to SM", smSt: "Waiting Review", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 9, sDays: 8, uDays: 8 },
  { status: "Returned by SM", smSt: "Returned", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 4, sDays: 3, retDays: 2, uDays: 2 },
  { status: "Returned by SM", smSt: "Returned", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 8, sDays: 7, retDays: 5, uDays: 5 },
  { status: "Returned by SM", smSt: "Returned", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 0, berkasLengkap: false, claimDL: null, cDays: 13, sDays: 12, retDays: 10, uDays: 10 },
  { status: "Approved by SM", smSt: "Approved by SM", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: 20, cDays: 6, sDays: 5, smDays: 4, uDays: 4 },
  { status: "Approved by SM", smSt: "Approved by SM", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: false, claimDL: 14, cDays: 8, sDays: 7, smDays: 6, uDays: 6 },
  { status: "Approved by SM", smSt: "Approved by SM", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: 28, cDays: 3, sDays: 2, smDays: 1, uDays: 1 },
  { status: "Claim Approved", smSt: "Approved by SM", claimSt: "Approved", omSt: "Waiting Approval", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: 14, cDays: 8, sDays: 7, smDays: 6, clDays: 4, uDays: 4 },
  { status: "Claim Approved", smSt: "Approved by SM", claimSt: "Approved", omSt: "Waiting Approval", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: 7, cDays: 11, sDays: 10, smDays: 9, clDays: 7, uDays: 7 },
  { status: "Claim Approved", smSt: "Approved by SM", claimSt: "Approved", omSt: "Waiting Approval", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: 21, cDays: 4, sDays: 3, smDays: 2, clDays: 1, uDays: 1 },
  { status: "OM Approved", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Waiting Payment", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: -10, cDays: 25, sDays: 24, smDays: 22, clDays: 18, omDays: 14, uDays: 14 },
  { status: "OM Approved", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Waiting Payment", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: -20, cDays: 35, sDays: 34, smDays: 32, clDays: 28, omDays: 24, uDays: 24 },
  { status: "OM Approved", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Waiting Payment", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: 3, cDays: 12, sDays: 11, smDays: 9, clDays: 7, omDays: 5, uDays: 5 },
  { status: "Partial Paid", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Partial Paid", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: -5, cDays: 22, sDays: 21, smDays: 19, clDays: 15, omDays: 11, pDays: 8, uDays: 8, hasPayment: true, partialPayment: true },
  { status: "Partial Paid", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Partial Paid", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: -12, cDays: 28, sDays: 27, smDays: 25, clDays: 21, omDays: 17, pDays: 12, uDays: 12, hasPayment: true, partialPayment: true },
  { status: "Partial Paid", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Partial Paid", finalSt: "Not Started", locked: 1, berkasLengkap: true, claimDL: -2, cDays: 14, sDays: 13, smDays: 11, clDays: 9, omDays: 7, pDays: 2, uDays: 2, hasPayment: true, partialPayment: true },
  { status: "Paid", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Waiting Claim Final Verification", locked: 1, berkasLengkap: true, claimDL: -7, cDays: 25, sDays: 24, smDays: 22, clDays: 19, omDays: 15, pDays: 8, uDays: 8, hasPayment: true },
  { status: "Paid", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Waiting Claim Final Verification", locked: 1, berkasLengkap: false, claimDL: -10, cDays: 30, sDays: 29, smDays: 27, clDays: 24, omDays: 20, pDays: 12, uDays: 12, hasPayment: true },
  { status: "Paid", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Waiting Claim Final Verification", locked: 1, berkasLengkap: true, claimDL: -1, cDays: 16, sDays: 15, smDays: 13, clDays: 11, omDays: 8, pDays: 2, uDays: 2, hasPayment: true },
  { status: "Paid", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Pending Refund", locked: 1, berkasLengkap: true, claimDL: -15, cDays: 35, sDays: 34, smDays: 32, clDays: 29, omDays: 25, pDays: 18, uDays: 10, hasPayment: true, hasRefund: true, batchRefundStatus: "Pending Refund" },
  { status: "Paid", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Pending Refund", locked: 1, berkasLengkap: true, claimDL: -5, cDays: 22, sDays: 21, smDays: 19, clDays: 17, omDays: 13, pDays: 9, uDays: 2, hasPayment: true, hasRefund: true, batchRefundStatus: "Pending Refund" },
  { status: "Approved by SM", smSt: "Approved by SM", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: false, claimDL: -5, cDays: 18, sDays: 17, smDays: 14, uDays: 14 },
  { status: "Approved by SM", smSt: "Approved by SM", claimSt: "Not Started", omSt: "Not Started", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: false, claimDL: -15, cDays: 28, sDays: 27, smDays: 24, uDays: 24 },
  { status: "Completed", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Completed", locked: 1, berkasLengkap: true, claimDL: -25, cDays: 60, sDays: 59, smDays: 57, clDays: 54, omDays: 51, pDays: 40, uDays: 30, hasPayment: true },
  { status: "Completed", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Completed", locked: 1, berkasLengkap: true, claimDL: -35, cDays: 75, sDays: 74, smDays: 72, clDays: 69, omDays: 66, pDays: 55, uDays: 45, hasPayment: true },
  { status: "Completed", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Completed", locked: 1, berkasLengkap: true, claimDL: -45, cDays: 90, sDays: 89, smDays: 87, clDays: 84, omDays: 80, pDays: 70, uDays: 60, hasPayment: true },
  { status: "Completed", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Paid", finalSt: "Fully Refunded", locked: 1, berkasLengkap: true, claimDL: -50, cDays: 95, sDays: 94, smDays: 92, clDays: 89, omDays: 85, pDays: 75, uDays: 55, hasPayment: true, hasRefund: true, batchRefundStatus: "Fully Refunded" },
  { status: "Cancelled by OM", smSt: "Approved by SM", claimSt: "Approved", omSt: "Cancelled", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: false, claimDL: -20, cDays: 50, sDays: 49, smDays: 47, clDays: 44, canDays: 40, uDays: 40 },
  { status: "Cancelled by OM", smSt: "Approved by SM", claimSt: "Approved", omSt: "Cancelled", finSt: "Not Started", finalSt: "Not Started", locked: 1, berkasLengkap: false, claimDL: -30, cDays: 65, sDays: 64, smDays: 62, clDays: 59, canDays: 55, uDays: 55 },
  { status: "Returned to Finance", smSt: "Approved by SM", claimSt: "Approved", omSt: "Approved", finSt: "Need Correction", finalSt: "Not Started", locked: 1, berkasLengkap: false, claimDL: -15, cDays: 35, sDays: 34, smDays: 32, clDays: 29, omDays: 25, uDays: 18 },
];

const CLAIM_ELIGIBLE = new Set(["OM Approved", "Partial Paid", "Paid", "Completed", "Returned to Finance"]);
const CLAIM_NO_STATUSES = new Set(["Claim Approved", "OM Approved", "Partial Paid", "Paid", "Completed", "Cancelled by OM", "Returned to Finance"]);

// ─── WIPE ──────────────────────────────────────────────────────────────────────
async function wipe() {
  console.log("WIPE: mengosongkan tabel transaksi...");
  // Child -> parent (aman FK).
  const tables = [
    "claim_audit_log", "claim_payment", "claim_workflow_item", "claim_submission", "claim_workflow",
    "off_audit_log", "off_refund", "off_payment", "off_notification", "off_batch_item",
    "off_discount_audit_log", "off_discount_submission", "off_period_closure", "off_batch",
  ];
  for (const t of tables) {
    await db.execute(`DELETE FROM ${t};`).catch((e) => {
      if (!/no such table/i.test(String(e?.message || e))) throw e;
    });
  }
  // Users dummy saja (lindungi admin riil). Hapus session/account dulu.
  const dummyUsers = await db.execute(
    "SELECT id FROM user WHERE email LIKE '%.dummy@surya.test' OR email LIKE 'qa.%@local.test'"
  );
  for (const r of dummyUsers.rows) {
    await db.execute({ sql: "DELETE FROM session WHERE userId = ?", args: [r.id] }).catch(() => {});
    await db.execute({ sql: "DELETE FROM account WHERE userId = ?", args: [r.id] }).catch(() => {});
    await db.execute({ sql: "DELETE FROM user WHERE id = ?", args: [r.id] }).catch(() => {});
  }
  console.log(`WIPE: selesai (${tables.length} tabel + ${dummyUsers.rows.length} user dummy lama).`);
}

// ─── SEED: Users ─────────────────────────────────────────────────────────────
async function seedUsers() {
  const hash = await hashPassword(PASSWORD);
  const idByRole = {};
  for (const u of USERS) {
    const userId = randomUUID();
    await insertRow("user", {
      id: userId, name: u.name, email: u.email, emailVerified: 1,
      role: u.role, permissions: "{}", banned: 0,
      createdAt: MS_NOW, updatedAt: MS_NOW,
    });
    await insertRow("account", {
      id: randomUUID(), accountId: userId, providerId: "credential", userId,
      password: hash, createdAt: MS_NOW, updatedAt: MS_NOW,
    });
    idByRole[u.role] = { id: userId, name: u.name };
  }
  return idByRole;
}

// ─── SEED: OFF batch + item + payment + refund + audit ───────────────────────
function computeAmounts(totalNominal, sc) {
  const isCompleted = sc.status === "Completed";
  const isPaidFull = sc.status === "Paid" || isCompleted;
  const isPaidPartial = sc.partialPayment === true;
  const hasRefund = sc.hasRefund === true;

  const paidAmount = isPaidFull ? totalNominal : isPaidPartial ? Math.floor(totalNominal * 0.6) : null;
  const verifiedAmount = isCompleted ? totalNominal : hasRefund ? Math.floor(totalNominal * 0.85) : null;
  const refundAmt = hasRefund && verifiedAmount != null ? totalNominal - verifiedAmount : null;
  const totalRefunded = sc.batchRefundStatus === "Fully Refunded" ? refundAmt : null;
  return { isCompleted, isPaidFull, isPaidPartial, hasRefund, paidAmount, verifiedAmount, refundAmt, totalRefunded };
}

async function seedOff(users) {
  const BATCHES_PER_PRINCIPAL = SMALL ? 6 : 14;
  const stats = { batch: 0, item: 0, payment: 0, refund: 0, audit: 0, closure: 0, notif: 0 };
  // Kumpulan batch eligible utk claim workflow (dikembalikan utk fase berikutnya).
  const eligibleBatches = [];

  const spv = users.supervisor;
  const sm = users.sm;
  const claim = users.claim;
  const om = users.om;
  const fin = users.finance;

  for (const [pi, principle] of PRINCIPLES.entries()) {
    let suratSeq = 1;
    let claimNoSeq = 1;

    for (let bi = 0; bi < BATCHES_PER_PRINCIPAL; bi++) {
      // Offset skenario per principal supaya 35 skenario tercover lintas principal.
      const sc = SC[(bi + pi * 5) % SC.length];
      const monthIdx = (bi + pi) % MONTHS.length;
      const { b: bulan, y: tahun } = MONTHS[monthIdx];
      const gel = (bi % 3) + 1;
      const gel3 = String(gel).padStart(3, "0");

      // Dua sumber pengajuan: supervisor vs claim (CLM).
      const fromClaim = bi % 5 === 4;
      const noPengajuan = fromClaim
        ? `${gel3}/CLM/${principle.code}/${bulan}/${tahun}`
        : `${gel3}/${principle.code}/${bulan}/${tahun}`;
      const createdByRole = fromClaim ? "claim" : "supervisor";

      const batchId = randomUUID();
      const numItems = (bi % 4) + 1;

      // Build items
      const items = [];
      let totalNominal = 0;
      let batchHasTransfer = false;
      for (let ii = 0; ii < numItems; ii++) {
        const nominal = pick(NOMINALS, pi * 3 + bi * 7 + ii * 11);
        totalNominal += nominal;
        const isTransfer = (pi + bi + ii) % 5 !== 4; // ~80% Transfer, 20% Tunai
        if (isTransfer) batchHasTransfer = true;
        const isLegacy = ii === 0 && bi % 4 === 3; // sebagian item legacy
        const legacy = pick(LEGACY_TYPES, pi + bi);
        const finalType = isLegacy ? legacy.norm : pick(PROG_TYPES, bi + ii);
        items.push({
          id: randomUUID(),
          itemNo: ii + 1,
          noSurat: `${principle.code}/SR/${tahun}/${String(suratSeq++).padStart(5, "0")}`,
          namaProgram: `${finalType} - ${pick(PRODUCTS, pi * 5 + bi * 2 + ii * 3)}`,
          periode: `${tahun}-${bulan}-05 - ${tahun}-${bulan}-25`,
          toko: pick(STORES, pi * 7 + bi * 3 + ii),
          barang: pick(PRODUCTS, pi * 5 + bi * 2 + ii * 3),
          nominal,
          caraBayar: isTransfer ? "Transfer" : "Tunai",
          noRekening: isTransfer ? `${1000000000 + (pi * 1000 + bi * 10 + ii)} BCA a.n. ${principle.code}` : null,
          type: finalType,
          originalType: isLegacy ? legacy.raw : finalType,
          normalizedType: finalType,
          typeIsLegacy: isLegacy,
          pphExempt: (pi + ii) % 3 === 0,
          deadline: iso(fwd(30)),
          docsLengkap: sc.berkasLengkap,
        });
      }

      const amt = computeAmounts(totalNominal, sc);
      const hasClaimNo = CLAIM_NO_STATUSES.has(sc.status);
      const noClaimVal = hasClaimNo ? `CLAIM/${principle.code}/${tahun}/${String(claimNoSeq++).padStart(4, "0")}` : null;
      const claimDeadlineIso = sc.claimDL != null ? iso(fwd(sc.claimDL)) : null;
      const completenessStatus = sc.berkasLengkap ? "lengkap" : null;
      const createdAt = ago(sc.cDays);
      const updatedAt = ago(sc.uDays);
      const batchNoRek = batchHasTransfer ? `${2000000000 + pi * 100 + bi} BCA a.n. CV Surya Perkasa` : null;
      const paidAt = amt.isPaidFull && !amt.isPaidPartial ? ago(sc.pDays) : null;

      await insertRow("off_batch", {
        id: batchId, no_pengajuan: noPengajuan, gelombang: gel3,
        principle_code: principle.code, principle_name: principle.name, bulan, tahun,
        supervisor_name: spv.name, total_nominal: totalNominal,
        status: sc.status, sm_status: sc.smSt, claim_status: sc.claimSt, om_status: sc.omSt,
        finance_status: sc.finSt, final_status: sc.finalSt, locked: B(sc.locked),
        completeness_status: completenessStatus,
        created_by: createdByRole === "claim" ? claim.id : spv.id,
        created_by_role: createdByRole,
        submitted_by: sc.sDays != null ? spv.id : null, submitted_at: ago(sc.sDays),
        sm_approved_by: sc.smDays != null ? sm.id : null, sm_approved_at: ago(sc.smDays),
        sm_note: sc.smDays != null ? "Disetujui" : null,
        returned_by: sc.retDays != null ? sm.id : null, returned_at: ago(sc.retDays),
        return_note: sc.retDays != null ? "Harap lengkapi dokumen dan revisi data" : null,
        claim_reviewed_by: sc.clDays != null ? claim.id : null, claim_reviewed_at: ago(sc.clDays),
        claim_submitted_date: claimDeadlineIso, claim_deadline: claimDeadlineIso,
        no_claim: noClaimVal, claim_note: sc.clDays != null ? "Berkas diverifikasi, proses ke OM" : null,
        om_approved_by: sc.omDays != null ? om.id : null, om_approved_at: ago(sc.omDays),
        om_note: sc.omDays != null ? "Disetujui untuk pembayaran" : null,
        cancelled_by: sc.canDays != null ? om.id : null, cancelled_at: ago(sc.canDays),
        cancel_note: sc.canDays != null ? "Tidak memenuhi persyaratan program" : null,
        paid_by: amt.isPaidFull && !amt.isPaidPartial ? fin.id : null,
        paid_at: paidAt, payment_date: iso(paidAt),
        paid_amount: amt.paidAmount, payment_method: amt.isPaidFull ? "Transfer" : null,
        payment_sender_bank: amt.isPaidFull ? "Bank BCA" : null,
        verified_amount: amt.verifiedAmount,
        final_claim_note: amt.isCompleted ? "Semua dokumen final telah diverifikasi" : null,
        pdf_status: "pending", receipt_pdf_status: "pending",
        refund_status: sc.batchRefundStatus || "Not Applicable",
        refund_amount: amt.refundAmt, total_refunded: amt.totalRefunded,
        no_rekening: batchNoRek,
        updated_at: updatedAt, created_at: createdAt,
      });
      stats.batch++;

      for (const it of items) {
        const d = it.docsLengkap;
        await insertRow("off_batch_item", {
          id: it.id, batch_id: batchId, item_no: it.itemNo, row_no: it.itemNo,
          no_surat: it.noSurat, no_claim: noClaimVal, nama_program: it.namaProgram,
          periode: it.periode, toko: it.toko, barang: it.barang, nominal: it.nominal,
          cara_bayar: it.caraBayar, no_rekening: it.noRekening,
          finance_payment_status: amt.isPaidFull ? "paid" : "unpaid",
          type: it.type, original_type: it.originalType, normalized_type: it.normalizedType,
          type_is_legacy: B(it.typeIsLegacy),
          pph_exempt: B(it.pphExempt), deadline: it.deadline,
          kwt: 1, skp: B(d), fp: B(d), pc: B(d), foto: 1, rekap: B(d), others: 0,
          final_kwt: B(amt.isCompleted), final_skp: B(amt.isCompleted && d),
          final_fp: B(amt.isCompleted && d), final_pc: B(amt.isCompleted && d),
          final_foto: B(amt.isCompleted), final_rekap: B(amt.isCompleted && d), final_others: 0,
          created_at: createdAt, updated_at: updatedAt,
        });
        stats.item++;
      }

      // Payment records
      if (sc.hasPayment) {
        if (amt.isPaidPartial) {
          const p1 = Math.floor(totalNominal * 0.4);
          const p2 = Math.floor(totalNominal * 0.2);
          await insertRow("off_payment", {
            id: randomUUID(), batch_id: batchId, payment_no: 1, payment_date: iso(ago((sc.pDays || 0) + 2)),
            paid_amount: p1, payment_method: "Transfer", payment_sender_bank: "Bank BCA",
            note: "Pembayaran pertama [DUMMY]", created_by: fin.id, created_at: ago((sc.pDays || 0) + 2), updated_at: ago((sc.pDays || 0) + 2),
          });
          await insertRow("off_payment", {
            id: randomUUID(), batch_id: batchId, payment_no: 2, payment_date: iso(ago(sc.pDays || 0)),
            paid_amount: p2, payment_method: "Transfer", payment_sender_bank: "Bank BCA",
            note: "Pembayaran kedua [DUMMY]", created_by: fin.id, created_at: ago(sc.pDays || 0), updated_at: ago(sc.pDays || 0),
          });
          stats.payment += 2;
        } else {
          await insertRow("off_payment", {
            id: randomUUID(), batch_id: batchId, payment_no: 1, payment_date: iso(ago(sc.pDays || 0)),
            paid_amount: totalNominal, payment_method: "Transfer", payment_sender_bank: "Bank BCA",
            note: "Pembayaran lunas [DUMMY]", created_by: fin.id, created_at: ago(sc.pDays || 0), updated_at: ago(sc.pDays || 0),
          });
          stats.payment++;
        }
      }

      // Refund
      if (amt.hasRefund && amt.refundAmt) {
        const isVerified = sc.batchRefundStatus === "Fully Refunded";
        const days = sc.uDays || 1;
        await insertRow("off_refund", {
          id: randomUUID(), batch_id: batchId, refund_no: 1, refund_amount: amt.refundAmt,
          refund_method: "Transfer", refund_date: iso(ago(days + 1)),
          sender_name: "Principal [DUMMY]", receiver_bank: "Rekening Perusahaan",
          note: "Pengembalian selisih kelebihan bayar [DUMMY]",
          status: isVerified ? "Verified" : "Pending",
          verified_by: isVerified ? fin.id : null, verified_at: isVerified ? ago(days) : null,
          created_by: spv.id, created_at: ago(days), updated_at: ago(days),
        });
        stats.refund++;
      }

      // Audit timeline
      const audits = [{ action: "create_batch", from: null, to: "Draft", by: createdByRole === "claim" ? claim : spv, role: createdByRole, days: sc.cDays }];
      if (sc.sDays != null) audits.push({ action: "submit_batch", from: "Draft", to: "Submitted to SM", by: spv, role: "supervisor", days: sc.sDays });
      if (sc.smDays != null) audits.push({ action: "sm_approve", from: "Submitted to SM", to: "Approved by SM", by: sm, role: "sales_manager", days: sc.smDays });
      if (sc.retDays != null) audits.push({ action: "sm_return", from: "Submitted to SM", to: "Returned by SM", by: sm, role: "sales_manager", days: sc.retDays });
      if (sc.clDays != null) audits.push({ action: "claim_review", from: "Approved by SM", to: "Claim Approved", by: claim, role: "claim", days: sc.clDays });
      if (sc.omDays != null) audits.push({ action: "om_approve", from: "Claim Approved", to: "OM Approved", by: om, role: "operational_manager", days: sc.omDays });
      if (sc.canDays != null) audits.push({ action: "om_cancel", from: "Claim Approved", to: "Cancelled by OM", by: om, role: "operational_manager", days: sc.canDays });
      if (sc.pDays != null) audits.push({ action: "finance_payment", from: "OM Approved", to: sc.status, by: fin, role: "finance", days: sc.pDays });
      for (const a of audits) {
        await insertRow("off_audit_log", {
          id: randomUUID(), batch_id: batchId, actor_id: a.by.id, actor_name: a.by.name, actor_role: a.role,
          action: a.action, from_status: a.from, to_status: a.to,
          note: `[DUMMY] ${a.action} ${noPengajuan}`, created_at: ago(a.days),
        });
        stats.audit++;
      }

      // Notification utk batch yang sudah disubmit
      if (sc.sDays != null) {
        await insertRow("off_notification", {
          id: randomUUID(), batch_id: batchId, type: "submission", to: "sm.dummy@surya.test",
          subject: `Pengajuan ${noPengajuan} menunggu review`, message: "[DUMMY] Mohon review pengajuan OFF.",
          status: "created", created_at: ago(sc.sDays),
        });
        stats.notif++;
      }

      if (CLAIM_ELIGIBLE.has(sc.status)) {
        eligibleBatches.push({ batchId, noPengajuan, principle, items, createdAt });
      }
    }

    // Period closure per principal x bulan; sebagian ditutup.
    for (let mi = 0; mi < MONTHS.length; mi++) {
      const { b: bulan, y: tahun } = MONTHS[mi];
      const closed = (pi + mi) % 6 === 0; // ~1/6 ditutup
      await insertRow("off_period_closure", {
        id: randomUUID(), principle_code: principle.code, principle_name: principle.name,
        bulan, tahun, status: closed ? "Ditutup" : "Terbuka",
        total_submitted: 0, total_claimed: 0, submitted_count: 0, claimed_count: 0,
        closed_by: closed ? claim.id : null, closed_at: closed ? ago(20) : null,
        created_at: NOW, updated_at: NOW,
      });
      stats.closure++;
    }
  }

  return { stats, eligibleBatches };
}

// ─── SEED: Claim Workflow (dari batch OM Approved) ──────────────────────────
const PPN_RATE = 11;
const PPH_RATE = 2;

function calcItem(nominal, pphExempt) {
  const dpp = nominal;
  const ppnAmount = Math.round((dpp * PPN_RATE) / 100);
  const pphAmount = pphExempt ? 0 : Math.round((dpp * PPH_RATE) / 100);
  const nilaiKlaim = dpp + ppnAmount - pphAmount;
  return { dpp, ppnAmount, pphAmount, nilaiKlaim, ppnRate: PPN_RATE, pphRate: pphExempt ? 0 : PPH_RATE };
}

async function seedClaims(users, eligibleBatches) {
  const claim = users.claim;
  const stats = { workflow: 0, submission: 0, item: 0, payment: 0, audit: 0 };
  let ncSeq = 1;
  const nextNoClaim = (code, tahun) => `NC/${code}/${tahun}/${String(ncSeq++).padStart(4, "0")}`;

  // Buat workflow utk ~60% batch eligible, cycling 6 varian.
  let variant = 0;
  for (let idx = 0; idx < eligibleBatches.length; idx++) {
    if (idx % 5 >= 3) continue; // ~60%
    const eb = eligibleBatches[idx];
    const v = variant++ % 6;
    const wfId = randomUUID();
    const wfNo = `CLM/${eb.noPengajuan}`;
    const tahun = eb.principle ? (eb.items[0]?.periode?.slice(0, 4) || "2026") : "2026";
    const createdAt = eb.createdAt || ago(20);

    // Tentukan submission split
    const multi = v >= 3 && eb.items.length >= 2;
    const groups = multi
      ? [eb.items.slice(0, Math.ceil(eb.items.length / 2)), eb.items.slice(Math.ceil(eb.items.length / 2))]
      : [eb.items];

    // Pass 1: hitung semua submission di memori (TANPA write) supaya parent
    // claim_workflow bisa di-insert lebih dulu (hormati FK).
    const plans = [];
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      let sDpp = 0, sPpn = 0, sPph = 0, sClaim = 0;
      const calcRows = grp.map((it) => {
        const c = calcItem(it.nominal, it.pphExempt);
        sDpp += c.dpp; sPpn += c.ppnAmount; sPph += c.pphAmount; sClaim += c.nilaiKlaim;
        return { it, c };
      });

      // Status & payment per varian
      let subStatus = "Draft", noClaim = null, totalPaid = 0, submittedAt = null, closedAt = null;
      const payments = []; // {amount, voided, days}
      if (v === 0) { subStatus = "Draft"; }
      else if (v === 1) { subStatus = "Ready to Submit"; noClaim = nextNoClaim(eb.principle.code, tahun); }
      else if (v === 2) { subStatus = "Submitted to Principal"; noClaim = nextNoClaim(eb.principle.code, tahun); submittedAt = ago(20); }
      else if (v === 3) {
        noClaim = nextNoClaim(eb.principle.code, tahun); submittedAt = ago(25);
        if (g === 0) { subStatus = "Paid"; payments.push({ amount: sClaim, voided: false, days: 10 }); totalPaid = sClaim; }
        else { subStatus = "Partially Paid"; payments.push({ amount: Math.floor(sClaim * 0.5), voided: false, days: 8 }); payments.push({ amount: Math.floor(sClaim * 0.2), voided: true, days: 6 }); totalPaid = Math.floor(sClaim * 0.5); }
      } else if (v === 4) {
        noClaim = nextNoClaim(eb.principle.code, tahun); submittedAt = ago(40); subStatus = "Closed";
        payments.push({ amount: sClaim, voided: false, days: 30 }); totalPaid = sClaim; closedAt = ago(20);
      } else if (v === 5) {
        noClaim = nextNoClaim(eb.principle.code, tahun); submittedAt = ago(60); subStatus = "Submitted to Principal";
      }

      plans.push({
        subId: randomUUID(), g, calcRows, sDpp, sPpn, sPph, sClaim, totalPaid,
        subStatus, noClaim, submittedAt, closedAt, payments,
      });
    }

    // Workflow aggregate
    const tDpp = plans.reduce((s, x) => s + x.sDpp, 0);
    const tPpn = plans.reduce((s, x) => s + x.sPpn, 0);
    const tPph = plans.reduce((s, x) => s + x.sPph, 0);
    const tClaim = plans.reduce((s, x) => s + x.sClaim, 0);
    const tPaid = plans.reduce((s, x) => s + x.totalPaid, 0);
    const remainingWf = Math.max(tClaim - tPaid, 0);

    let wfStatus = "Draft";
    if (v === 1) wfStatus = "Ready to Submit";
    else if (v === 2) wfStatus = "Submitted to Principal";
    else if (v === 3) wfStatus = "Partially Paid";
    else if (v === 4) wfStatus = "Closed";
    else if (v === 5) wfStatus = "Outstanding";

    // workflow.no_claim hanya utk single-submission (unik global). Multi => NULL.
    const wfNoClaim = !multi ? plans[0].noClaim : null;

    // INSERT parent workflow LEBIH DULU.
    await insertRow("claim_workflow", {
      id: wfId, off_batch_id: eb.batchId, claim_workflow_no: wfNo,
      principle_code: eb.principle.code, principle_name: eb.principle.name,
      source_type: "off_program", aggregate_status: wfStatus, status: wfStatus,
      total_dpp: tDpp, total_ppn: tPpn, total_pph: tPph, total_claim: tClaim,
      total_paid: tPaid, remaining_amount: remainingWf,
      submitted_to_principal_at: v >= 2 ? ago(25) : null,
      no_claim: wfNoClaim, no_claim_assigned_at: wfNoClaim ? ago(22) : null,
      no_claim_assigned_by: wfNoClaim ? claim.id : null,
      closed_at: v === 4 ? ago(20) : null, closed_by: v === 4 ? claim.id : null,
      close_note: v === 4 ? "Semua submission selesai [DUMMY]" : null,
      created_by: claim.id, created_at: createdAt, updated_at: NOW,
    });
    stats.workflow++;

    // Pass 2: insert child (submission -> item -> payment).
    const submissions = [];
    for (const pl of plans) {
      const remaining = Math.max(pl.sClaim - pl.totalPaid, 0);
      await insertRow("claim_submission", {
        id: pl.subId, claim_workflow_id: wfId, no_claim: pl.noClaim,
        no_claim_assigned_at: pl.noClaim ? ago(22) : null, no_claim_assigned_by: pl.noClaim ? claim.id : null,
        scope: multi ? "per_item" : "per_pengajuan", scope_label: multi ? `Grup ${pl.g + 1}` : "Per Pengajuan",
        status: pl.subStatus, total_dpp: pl.sDpp, total_ppn: pl.sPpn, total_pph: pl.sPph,
        total_claim: pl.sClaim, total_paid: pl.totalPaid, remaining_amount: remaining,
        submitted_to_principal_at: pl.submittedAt, closed_at: pl.closedAt,
        closed_by: pl.closedAt ? claim.id : null, close_note: pl.closedAt ? "Klaim selesai [DUMMY]" : null,
        created_by: claim.id, created_at: createdAt, updated_at: NOW,
      });
      stats.submission++;

      for (const { it, c } of pl.calcRows) {
        await insertRow("claim_workflow_item", {
          id: randomUUID(), claim_workflow_id: wfId, claim_submission_id: pl.subId,
          off_batch_item_id: it.id, no_surat: it.noSurat, jenis_promosi: it.type,
          periode: it.periode, outlet: it.toko,
          dpp: c.dpp, ppn_rate: c.ppnRate, ppn_amount: c.ppnAmount,
          pph_rate: c.pphRate, pph_amount: c.pphAmount, nilai_klaim: c.nilaiKlaim,
          status: pl.subStatus === "Closed" ? "Closed" : pl.subStatus === "Paid" ? "Paid" : "active",
          created_at: createdAt, updated_at: NOW,
        });
        stats.item++;
      }

      for (const p of pl.payments) {
        await insertRow("claim_payment", {
          id: randomUUID(), claim_workflow_id: wfId, claim_submission_id: pl.subId,
          payment_date: iso(ago(p.days)), payment_amount: p.amount, payment_type: "Transfer",
          payment_note: p.voided ? "Pembayaran salah input [DUMMY]" : "Pembayaran principal [DUMMY]",
          created_by: claim.id,
          voided_at: p.voided ? ago(p.days - 1) : null, voided_by: p.voided ? claim.id : null,
          void_reason: p.voided ? "Koreksi nominal" : null,
          created_at: ago(p.days), updated_at: NOW,
        });
        stats.payment++;
      }

      submissions.push({ subId: pl.subId, noClaim: pl.noClaim, totalPaid: pl.totalPaid });
    }

    // Audit
    const wfAudits = [{ action: "create_from_off", scope: "workflow", days: 25, note: `Dibuat dari ${eb.noPengajuan}` }];
    for (const s of submissions) {
      if (s.noClaim) wfAudits.push({ action: "assign_no_claim", scope: "submission", sub: s.subId, days: 22, note: s.noClaim });
      if (s.totalPaid > 0) wfAudits.push({ action: "add_payment", scope: "submission", sub: s.subId, days: 10, note: `Bayar ${s.totalPaid}` });
    }
    if (v === 3) wfAudits.push({ action: "void_payment", scope: "submission", sub: submissions[1]?.subId, days: 5, note: "Void koreksi" });
    if (v === 4) wfAudits.push({ action: "close", scope: "workflow", days: 20, note: "Workflow ditutup" });
    for (const a of wfAudits) {
      await insertRow("claim_audit_log", {
        id: randomUUID(), claim_workflow_id: wfId, claim_submission_id: a.sub || null,
        audit_scope: a.scope, actor_id: claim.id, actor_name: claim.name, actor_role: "claim",
        action: a.action, note: `[DUMMY] ${a.note}`, created_at: ago(a.days),
      });
      stats.audit++;
    }
  }

  return stats;
}

// ─── SEED: Discount ──────────────────────────────────────────────────────────
async function seedDiscount(users) {
  const spv = users.supervisor;
  const stats = { submission: 0, audit: 0 };
  const count = SMALL ? 8 : 20;
  for (let i = 0; i < count; i++) {
    const principle = PRINCIPLES[i % PRINCIPLES.length];
    const subId = randomUUID();
    await insertRow("off_discount_submission", {
      id: subId, toko: pick(STORES, i), principle_code: principle.code, principle_name: principle.name,
      program: `${pick(PROG_TYPES, i)} Diskon`, nominal: pick(NOMINALS, i),
      alasan: "Permintaan diskon promosi toko [DUMMY]", tanggal: iso(ago(i + 1)),
      status: "Tercatat", catatan: "Dicatat oleh supervisor [DUMMY]",
      created_by_id: spv.id, created_by_name: spv.name, created_at: ago(i + 1), updated_at: ago(i + 1),
    });
    stats.submission++;
    await insertRow("off_discount_audit_log", {
      id: randomUUID(), submission_id: subId, actor_id: spv.id, actor_name: spv.name, actor_role: "supervisor",
      action: "discount_create", note: "[DUMMY] Pengajuan diskon dibuat", created_at: ago(i + 1),
    });
    stats.audit++;
  }
  return stats;
}

// ─── Guard: tabel sudah ada isinya? ──────────────────────────────────────────
async function hasExistingData() {
  const r = await db.execute("SELECT COUNT(*) c FROM off_batch");
  return Number(r.rows[0].c) > 0;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nSeed Dummy (Semua Divisi)\n  DB    : ${DB_URL}\n  Force : ${FORCE}\n  Small : ${SMALL}\n`);

  if (FORCE) {
    // Safety: WIPE menghapus SEMUA data transaksi (irreversible). Tolak target
    // DB non-file (remote/prod libSQL) kecuali di-override eksplisit, agar
    // `--force` tidak menghancurkan data riil saat DATABASE_URL bukan dev lokal.
    if (!DB_URL.startsWith("file:") && process.env.SEED_ALLOW_REMOTE !== "1") {
      console.error(`Menolak WIPE destruktif pada DB non-file: ${DB_URL}\nSet SEED_ALLOW_REMOTE=1 untuk override (hanya jika yakin ini DB dev).`);
      process.exit(1);
    }
    await wipe();
  } else if (await hasExistingData()) {
    console.error("Tabel off_batch tidak kosong. Jalankan dengan --force untuk WIPE + SEED.");
    process.exit(1);
  }

  console.log("SEED: users...");
  const users = await seedUsers();
  console.log("SEED: OFF batches...");
  const off = await seedOff(users);
  console.log("SEED: claim workflows...");
  const claims = await seedClaims(users, off.eligibleBatches);
  console.log("SEED: discounts...");
  const disc = await seedDiscount(users);

  console.log(`
Seed selesai.
  Users            : ${USERS.length} (password: ${PASSWORD})
  OFF batch        : ${off.stats.batch}
  OFF item         : ${off.stats.item}
  OFF payment      : ${off.stats.payment}
  OFF refund       : ${off.stats.refund}
  OFF audit        : ${off.stats.audit}
  OFF notif        : ${off.stats.notif}
  Period closure   : ${off.stats.closure}
  Claim workflow   : ${claims.workflow}
  Claim submission : ${claims.submission}
  Claim item       : ${claims.item}
  Claim payment    : ${claims.payment}
  Claim audit      : ${claims.audit}
  Discount         : ${disc.submission}
`);
  db.close();
}

main().catch((err) => {
  console.error("\nError:", err?.message || err);
  process.exit(1);
});
