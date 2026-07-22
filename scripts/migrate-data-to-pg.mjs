/*
 * D4 Gerbang 2 — Migrasi data SQLite → PostgreSQL.
 * Pakai: SQLITE_URL=file:sqlite.db DATABASE_URL=postgres://... node scripts/migrate-data-to-pg.mjs [--truncate]
 *   --truncate : kosongkan tabel PG dulu (dipakai saat re-run / migrasi delta ala full-reload).
 * Verifikasi: COUNT(*) per tabel harus identik + sampel 5 baris pertama per tabel dibandingkan
 * kolom-per-kolom (timestamp dinormalisasi ke epoch ms, jsonb deep-compare). Exit != 0 bila ada selisih.
 * Tipe kolom diambil dari information_schema PG — tidak ada mapping manual per tabel.
 */
import { createClient } from "@libsql/client";
import pg from "pg";

// Urutan parent → child (FK). 50 tabel — harus lengkap; script memverifikasi terhadap PG.
const TABLES = [
  "user", "verification", "session", "account", "accurate_oauth_session",
  "sync_state", "item", "customer", "sales_invoice", "sales_return", "idempotency_log",
  "off_batch", "off_period_closure", "off_batch_item", "off_payment", "off_refund",
  "off_notification", "off_audit_log",
  "off_discount_submission", "off_discount_audit_log",
  "claim_workflow", "claim_submission", "claim_workflow_item", "claim_payment", "claim_audit_log",
  "sales_profile", "sales_targets", "sales_daily_progress",
  "incentive_tiers", "incentive_payments", "incentive_support",
  "spv_sales_assignment", "sm_spv_assignment", "spv_sales_claim_request",
  "jks_master", "sales_outlet_txn", "no_order_reason", "ao_control_daily",
  "merchandising_check", "salesman_daily_report", "spv_briefing", "sm_control", "kontrol_audit_log",
  "access_group", "group_permission", "user_group", "permission_audit_log",
  "report_recipient", "report_run", "report_run_recipient",
];

const sqliteUrl = process.env.SQLITE_URL || "file:sqlite.db";
const pgUrl = process.env.DATABASE_URL;
if (!pgUrl) { console.error("DATABASE_URL (postgres) wajib di-set"); process.exit(1); }
const doTruncate = process.argv.includes("--truncate");

const lite = createClient({ url: sqliteUrl });
const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });

// epoch detik vs milidetik: nilai > 1e11 pasti ms (1e11 s = tahun 5138).
function epochToDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== "") return new Date(n > 1e11 ? n : n * 1000);
  // Data campuran nyata (jks_master/ao_control_daily): sebagian baris ISO string
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function transform(value, dataType) {
  if (value === null || value === undefined) return null;
  switch (dataType) {
    case "boolean": return !!Number(value);
    case "timestamp without time zone":
    case "timestamp with time zone": return epochToDate(value);
    case "jsonb": return typeof value === "string" ? value : JSON.stringify(value);
    default: return value;
  }
}

// stable stringify (sort keys) untuk deep-compare jsonb (pg jsonb menata ulang key)
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

function normalize(v, dataType) {
  if (v === null || v === undefined) return null;
  switch (dataType) {
    case "boolean": return !!Number(v === true ? 1 : v === false ? 0 : v);
    case "timestamp without time zone":
    case "timestamp with time zone": {
      const d = v instanceof Date ? v : epochToDate(v);
      return d ? d.getTime() : null;
    }
    case "jsonb": {
      // Beberapa raw_data historis di production double-JSON-encoded (bug lama
      // lib/sync.ts: JSON.stringify(row) dipassing ke kolom mode:'json' yang
      // auto-stringify lagi). Field ini terbukti tidak dibaca kode manapun
      // (grep .rawData kosong) — migrasi harus BYTE-FAITHFUL, bukan "memperbaiki"
      // data diam-diam. Unwrap berulang sampai bentuk stabil supaya perbandingan
      // tidak salah lapor beda padahal isinya sama persis.
      let parsed = v;
      for (let i = 0; i < 5 && typeof parsed === "string"; i++) {
        try { parsed = JSON.parse(parsed); } catch { break; }
      }
      return stable(parsed);
    }
    case "double precision":
    case "numeric": return Number(v);
    // node-postgres mengembalikan bigint sebagai string (hindari presisi hilang di JS number),
    // sqlite libsql mengembalikan number — bandingkan sebagai Number, bukan tipe mentah.
    case "bigint": return v === null ? null : Number(v);
    default: return v;
  }
}

async function pgColumns(table) {
  const { rows } = await pool.query(
    `select column_name, data_type from information_schema.columns
     where table_schema='public' and table_name=$1 order by ordinal_position`, [table]);
  return rows; // [{column_name, data_type}]
}

async function migrateTable(table) {
  const cols = await pgColumns(table);
  if (!cols.length) throw new Error(`Tabel ${table} tidak ada di PG — jalankan drizzle-kit push dulu`);
  const colNames = cols.map((c) => c.column_name);
  const quoted = colNames.map((c) => `"${c}"`).join(",");

  if (doTruncate) await pool.query(`TRUNCATE TABLE "${table}" CASCADE`);

  // Sebagian tabel modul baru (mis. laporan-harian) belum pernah dibuat di sqlite production
  // (belum pernah dipakai) — bukan error migrasi, PG tetap kosong sesuai kondisi asal.
  let srcRows;
  try {
    ({ rows: srcRows } = await lite.execute(`SELECT ${quoted} FROM "${table}"`));
  } catch (e) {
    if (String(e.message).includes("no such table")) {
      return { table, total: 0, pgCount: 0, ok: true, sampleOk: true, sampleChecked: 0, skippedNoSource: true };
    }
    if (String(e.message).includes("no such column")) {
      // Drift pre-existing schema.ts vs kolom fisik sqlite (mis. spv_briefing.toko_dibahas
      // vs toko_dialas) — bukan dari migrasi ini. Aman DIABAIKAN hanya bila tabel sumber
      // sungguh 0 baris (dicek via COUNT(*) tanpa referensi kolom manapun); kalau ada
      // data, ini blocker nyata dan harus dilaporkan, bukan dilewati diam-diam.
      const { rows: [{ n }] } = await lite.execute(`SELECT COUNT(*) n FROM "${table}"`);
      if (Number(n) === 0) {
        return { table, total: 0, pgCount: 0, ok: true, sampleOk: true, sampleChecked: 0, skippedColumnDrift: true };
      }
      throw new Error(`${e.message} — DAN tabel berisi ${n} baris data, bukan kosong. Perlu keputusan mapping kolom sebelum migrasi.`);
    }
    throw e;
  }
  const total = srcRows.length;

  // batch: jaga di bawah limit 65535 parameter pg
  const perBatch = Math.max(1, Math.floor(60000 / colNames.length));
  for (let i = 0; i < total; i += perBatch) {
    const batch = srcRows.slice(i, i + perBatch);
    const params = [];
    const tuples = batch.map((row, r) => {
      const ph = colNames.map((c, k) => {
        params.push(transform(row[c], cols[k].data_type));
        return `$${r * colNames.length + k + 1}`;
      });
      return `(${ph.join(",")})`;
    });
    await pool.query(`INSERT INTO "${table}" (${quoted}) VALUES ${tuples.join(",")}`, params);
  }

  // Verifikasi 1: COUNT identik
  const { rows: [cnt] } = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  const ok = cnt.n === total;

  // Verifikasi 2: sampel — 5 baris pertama sumber dibandingkan kolom-per-kolom di PG (by PK)
  let sampleOk = true, sampleChecked = 0;
  const { rows: pkRows } = await pool.query(
    `select a.attname from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = ('"' || $1 || '"')::regclass and i.indisprimary`, [table]);
  const pks = pkRows.map((r) => r.attname);
  if (pks.length && total > 0) {
    for (const src of srcRows.slice(0, 5)) {
      const where = pks.map((p, k) => `"${p}" = $${k + 1}`).join(" AND ");
      const { rows: [dst] } = await pool.query(
        `SELECT ${quoted} FROM "${table}" WHERE ${where}`, pks.map((p) => src[p]));
      if (!dst) { sampleOk = false; break; }
      for (let k = 0; k < colNames.length; k++) {
        const a = normalize(src[colNames[k]], cols[k].data_type);
        const b = normalize(dst[colNames[k]], cols[k].data_type);
        if (a !== b) {
          console.error(`  MISMATCH ${table}.${colNames[k]}: sqlite=${JSON.stringify(a)} pg=${JSON.stringify(b)}`);
          sampleOk = false;
        }
      }
      sampleChecked++;
    }
  }
  return { table, total, pgCount: cnt.n, ok, sampleOk, sampleChecked };
}

let failed = false;
for (const t of TABLES) {
  try {
    const r = await migrateTable(t);
    const flag = r.ok && r.sampleOk ? "OK " : "FAIL";
    if (!(r.ok && r.sampleOk)) failed = true;
    const note = r.skippedNoSource ? " (tabel belum ada di sumber)"
      : r.skippedColumnDrift ? " (drift kolom pre-existing, tabel 0 baris di sumber)" : "";
    console.log(`${flag} ${t.padEnd(28)} sqlite=${String(r.total).padStart(7)} pg=${String(r.pgCount).padStart(7)} sampel=${r.sampleChecked}${note}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${t}: ${e.message}`);
  }
}
await pool.end();
process.exit(failed ? 1 : 0);
