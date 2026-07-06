// Tujuan: Inisialisasi/migrasi SQLite runtime untuk Better Auth, RBAC, cache master, dan idempotency.
// Caller: Dockerfile.frontend startup command sebelum `next start`, juga dipanggil lokal via `node scripts/init-db.mjs`.
// Dependensi: @libsql/client dan filesystem volume DATABASE_URL.
// Main Functions: create table IF NOT EXISTS, migration ALTER TABLE, role/permission default update.
// Side Effects: Membuat folder DB dan menjalankan DDL/DML SQLite.
import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Load .env dari working directory supaya `DATABASE_URL=file:sqlite.db` di
// `.env` lokal kepakai saat dijalankan langsung dari CLI dev.
function loadEnvFile() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const databaseUrl = process.env.DATABASE_URL || "file:/app/data/sqlite.db";
const filePath = databaseUrl.startsWith("file:")
  ? databaseUrl.slice("file:".length)
  : null;
if (filePath?.startsWith("/")) {
  mkdirSync(filePath.replace(/\/[^/]*$/, ""), { recursive: true });
}

const db = createClient({ url: databaseUrl });

const statements = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL,
    image TEXT,
    role TEXT DEFAULT 'viewer',
    permissions TEXT DEFAULT '{}',
    banned INTEGER DEFAULT 0,
    banReason TEXT,
    banExpires INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY NOT NULL,
    expiresAt INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL,
    impersonatedBy TEXT,
    FOREIGN KEY (userId) REFERENCES user(id)
  );`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt INTEGER,
    refreshTokenExpiresAt INTEGER,
    scope TEXT,
    password TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (userId) REFERENCES user(id)
  );`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER,
    updatedAt INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    module TEXT PRIMARY KEY NOT NULL,
    last_sync_timestamp TEXT,
    last_page INTEGER DEFAULT 1,
    status TEXT DEFAULT 'idle',
    updated_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS item (
    id INTEGER PRIMARY KEY NOT NULL,
    no TEXT NOT NULL,
    name TEXT NOT NULL,
    itemType TEXT,
    unitPrice INTEGER,
    raw_data TEXT,
    last_update TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS customer (
    id INTEGER PRIMARY KEY NOT NULL,
    customerNo TEXT NOT NULL,
    name TEXT NOT NULL,
    balance INTEGER,
    raw_data TEXT,
    last_update TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS idempotency_log (
    key TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    invoiceNo TEXT,
    customerNo TEXT,
    amount REAL,
    transDate TEXT,
    paymentMethod TEXT,
    source TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS accurate_oauth_session (
    user_id TEXT PRIMARY KEY NOT NULL,
    access_token TEXT NOT NULL,
    session_host TEXT,
    session_id TEXT,
    database_id TEXT,
    database_alias TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user(id)
  );`,
  `CREATE TABLE IF NOT EXISTS off_batch (
    id TEXT PRIMARY KEY,
    no_pengajuan TEXT NOT NULL UNIQUE,
    gelombang TEXT NOT NULL,
    principle_code TEXT NOT NULL,
    principle_name TEXT NOT NULL,
    bulan TEXT NOT NULL,
    tahun TEXT NOT NULL,
    supervisor_name TEXT NOT NULL,
    total_nominal REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Draft',
    sm_status TEXT NOT NULL DEFAULT 'Not Started',
    claim_status TEXT NOT NULL DEFAULT 'Not Started',
    om_status TEXT NOT NULL DEFAULT 'Not Started',
    finance_status TEXT NOT NULL DEFAULT 'Not Started',
    final_status TEXT NOT NULL DEFAULT 'Not Started',
    locked INTEGER DEFAULT 0,
    created_by TEXT,
    submitted_by TEXT,
    submitted_at INTEGER,
    sm_approved_by TEXT,
    sm_approved_at INTEGER,
    sm_note TEXT,
    returned_by TEXT,
    returned_at INTEGER,
    return_note TEXT,
    claim_reviewed_by TEXT,
    claim_reviewed_at INTEGER,
    claim_submitted_date TEXT,
    claim_deadline TEXT,
    no_claim TEXT,
    claim_note TEXT,
    completeness_status TEXT,
    om_approved_by TEXT,
    om_approved_at INTEGER,
    om_note TEXT,
    cancelled_by TEXT,
    cancelled_at INTEGER,
    cancel_note TEXT,
    paid_by TEXT,
    paid_at INTEGER,
    payment_date TEXT,
    paid_amount REAL DEFAULT 0,
    payment_proof_path TEXT,
    payment_proof_name TEXT,
    payment_proof_mime TEXT,
    payment_proof_size INTEGER,
    payment_method TEXT,
    payment_sender_bank TEXT,
    finance_note TEXT,
    verified_amount REAL DEFAULT 0,
    final_claim_note TEXT,
    pdf_path TEXT,
    pdf_generated_at INTEGER,
    pdf_status TEXT DEFAULT 'pending',
    receipt_pdf_path TEXT,
    receipt_pdf_generated_at INTEGER,
    receipt_pdf_status TEXT DEFAULT 'pending',
    refund_status TEXT NOT NULL DEFAULT 'Not Applicable',
    refund_amount REAL,
    total_refunded REAL,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS off_period_closure (
    id TEXT PRIMARY KEY,
    principle_code TEXT NOT NULL,
    principle_name TEXT NOT NULL,
    bulan TEXT NOT NULL,
    tahun TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Terbuka',
    total_submitted REAL NOT NULL DEFAULT 0,
    total_claimed REAL NOT NULL DEFAULT 0,
    submitted_count INTEGER NOT NULL DEFAULT 0,
    claimed_count INTEGER NOT NULL DEFAULT 0,
    closed_by TEXT,
    closed_at INTEGER,
    unlocked_by TEXT,
    unlocked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS off_batch_item (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    item_no INTEGER NOT NULL,
    row_no INTEGER,
    no_surat TEXT,
    no_claim TEXT,
    nama_program TEXT,
    periode TEXT,
    toko TEXT,
    barang TEXT,
    nominal REAL DEFAULT 0,
    cara_bayar TEXT,
    finance_payment_status TEXT NOT NULL DEFAULT 'unpaid',
    finance_paid_at INTEGER,
    finance_payment_id TEXT,
    finance_paid_amount REAL,
    type TEXT,
    deadline TEXT,
    kwt INTEGER DEFAULT 0,
    skp INTEGER DEFAULT 0,
    fp INTEGER DEFAULT 0,
    pc INTEGER DEFAULT 0,
    foto INTEGER DEFAULT 0,
    rekap INTEGER DEFAULT 0,
    others INTEGER DEFAULT 0,
    others_text TEXT,
    final_kwt INTEGER NOT NULL DEFAULT 0,
    final_skp INTEGER NOT NULL DEFAULT 0,
    final_fp INTEGER NOT NULL DEFAULT 0,
    final_pc INTEGER NOT NULL DEFAULT 0,
    final_foto INTEGER NOT NULL DEFAULT 0,
    final_rekap INTEGER NOT NULL DEFAULT 0,
    final_others INTEGER NOT NULL DEFAULT 0,
    final_others_text TEXT,
    final_completeness_note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES off_batch(id)
  );`,
  `CREATE TABLE IF NOT EXISTS off_payment (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    payment_no INTEGER NOT NULL,
    payment_date TEXT NOT NULL,
    paid_amount REAL NOT NULL DEFAULT 0,
    payment_method TEXT,
    payment_sender_bank TEXT,
    sender_bank TEXT,
    payment_proof_path TEXT,
    payment_proof_name TEXT,
    payment_proof_mime TEXT,
    payment_proof_size INTEGER,
    note TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES off_batch(id)
  );`,
  `CREATE TABLE IF NOT EXISTS off_refund (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    refund_no INTEGER NOT NULL,
    refund_amount REAL NOT NULL DEFAULT 0,
    refund_method TEXT NOT NULL,
    refund_date TEXT NOT NULL,
    sender_name TEXT,
    receiver_bank TEXT,
    proof_path TEXT,
    proof_name TEXT,
    proof_mime TEXT,
    proof_size INTEGER,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    verified_by TEXT,
    verified_at INTEGER,
    verification_note TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES off_batch(id)
  );`,
  `CREATE TABLE IF NOT EXISTS off_notification (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    type TEXT NOT NULL,
    "to" TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES off_batch(id)
  );`,
  `CREATE TABLE IF NOT EXISTS off_audit_log (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    item_id TEXT,
    actor_id TEXT,
    actor_name TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    note TEXT,
    metadata TEXT,
    corrected_by TEXT,
    corrected_at INTEGER,
    correction_reason TEXT,
    previous_value TEXT,
    new_value TEXT,
    parent_audit_log_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES off_batch(id)
  );`,
  `CREATE TABLE IF NOT EXISTS off_discount_submission (
    id TEXT PRIMARY KEY,
    toko TEXT NOT NULL,
    principle_code TEXT,
    principle_name TEXT,
    program TEXT,
    nominal REAL NOT NULL DEFAULT 0,
    alasan TEXT,
    tanggal TEXT,
    status TEXT NOT NULL DEFAULT 'Tercatat',
    catatan TEXT,
    document_path TEXT,
    document_name TEXT,
    document_mime TEXT,
    document_size INTEGER,
    created_by_id TEXT,
    created_by_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS off_discount_audit_log (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    note TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (submission_id) REFERENCES off_discount_submission(id)
  );`,
  // --- Claim Workflow (may start after OFF OM Approved) --- //
  `CREATE TABLE IF NOT EXISTS claim_workflow (
    id TEXT PRIMARY KEY,
    off_batch_id TEXT NOT NULL UNIQUE,
    claim_workflow_no TEXT NOT NULL UNIQUE,
    principle_code TEXT NOT NULL,
    principle_name TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'off_program',
    source_ref_id TEXT,
    aggregate_status TEXT,
    status TEXT NOT NULL DEFAULT 'Draft',
    total_dpp REAL NOT NULL DEFAULT 0,
    total_ppn REAL NOT NULL DEFAULT 0,
    total_pph REAL NOT NULL DEFAULT 0,
    total_claim REAL NOT NULL DEFAULT 0,
    total_paid REAL NOT NULL DEFAULT 0,
    remaining_amount REAL NOT NULL DEFAULT 0,
    submitted_to_principal_at INTEGER,
    claim_letter_pdf_path TEXT,
    claim_letter_generated_at INTEGER,
    claim_letter_generated_by TEXT,
    summary_pdf_path TEXT,
    summary_generated_at INTEGER,
    summary_generated_by TEXT,
    receipt_pdf_path TEXT,
    receipt_generated_at INTEGER,
    receipt_generated_by TEXT,
    no_claim TEXT,
    no_claim_assigned_at INTEGER,
    no_claim_assigned_by TEXT,
    closed_at INTEGER,
    closed_by TEXT,
    close_note TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (off_batch_id) REFERENCES off_batch(id)
  );`,
  `CREATE TABLE IF NOT EXISTS claim_workflow_item (
    id TEXT PRIMARY KEY,
    claim_workflow_id TEXT NOT NULL,
    claim_submission_id TEXT,
    off_batch_item_id TEXT,
    no_surat TEXT,
    jenis_promosi TEXT,
    periode TEXT,
    outlet TEXT,
    dpp REAL NOT NULL DEFAULT 0,
    ppn_rate REAL NOT NULL DEFAULT 0,
    ppn_amount REAL NOT NULL DEFAULT 0,
    pph_rate REAL NOT NULL DEFAULT 0,
    pph_amount REAL NOT NULL DEFAULT 0,
    nilai_klaim REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Draft',
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (claim_workflow_id) REFERENCES claim_workflow(id),
    FOREIGN KEY (off_batch_item_id) REFERENCES off_batch_item(id)
  );`,
  `CREATE TABLE IF NOT EXISTS claim_payment (
    id TEXT PRIMARY KEY,
    claim_workflow_id TEXT NOT NULL,
    claim_submission_id TEXT,
    payment_date TEXT NOT NULL,
    payment_amount REAL NOT NULL DEFAULT 0,
    payment_type TEXT,
    payment_note TEXT,
    proof_path TEXT,
    created_by TEXT,
    voided_at INTEGER,
    voided_by TEXT,
    void_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (claim_workflow_id) REFERENCES claim_workflow(id)
  );`,
  `CREATE TABLE IF NOT EXISTS claim_audit_log (
    id TEXT PRIMARY KEY,
    claim_workflow_id TEXT NOT NULL,
    claim_submission_id TEXT,
    audit_scope TEXT,
    actor_id TEXT,
    actor_name TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    note TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (claim_workflow_id) REFERENCES claim_workflow(id)
  );`,
  `CREATE TABLE IF NOT EXISTS claim_submission (
    id TEXT PRIMARY KEY,
    claim_workflow_id TEXT NOT NULL,
    no_claim TEXT,
    no_claim_assigned_at INTEGER,
    no_claim_assigned_by TEXT,
    scope TEXT NOT NULL DEFAULT 'per_pengajuan',
    scope_label TEXT,
    status TEXT NOT NULL DEFAULT 'Draft',
    total_dpp REAL NOT NULL DEFAULT 0,
    total_ppn REAL NOT NULL DEFAULT 0,
    total_pph REAL NOT NULL DEFAULT 0,
    total_claim REAL NOT NULL DEFAULT 0,
    total_paid REAL NOT NULL DEFAULT 0,
    remaining_amount REAL NOT NULL DEFAULT 0,
    submitted_to_principal_at INTEGER,
    claim_letter_pdf_path TEXT,
    claim_letter_generated_at INTEGER,
    claim_letter_generated_by TEXT,
    summary_pdf_path TEXT,
    summary_generated_at INTEGER,
    summary_generated_by TEXT,
    receipt_pdf_path TEXT,
    receipt_generated_at INTEGER,
    receipt_generated_by TEXT,
    closed_at INTEGER,
    closed_by TEXT,
    close_note TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (claim_workflow_id) REFERENCES claim_workflow(id)
  );`,
];

for (const sql of statements) {
  await db.execute(sql);
}

const migrations = [
  `ALTER TABLE user ADD COLUMN role TEXT DEFAULT 'viewer';`,
  `ALTER TABLE user ADD COLUMN permissions TEXT DEFAULT '{}';`,
  `ALTER TABLE user ADD COLUMN banned INTEGER DEFAULT 0;`,
  `ALTER TABLE user ADD COLUMN banReason TEXT;`,
  `ALTER TABLE user ADD COLUMN banExpires INTEGER;`,
  `ALTER TABLE session ADD COLUMN impersonatedBy TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN gelombang TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN bulan TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN tahun TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN supervisor_name TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN total_nominal REAL DEFAULT 0;`,
  `ALTER TABLE off_batch ADD COLUMN submitted_by TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN submitted_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN sm_approved_by TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN sm_approved_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN returned_by TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN returned_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN return_note TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN claim_reviewed_by TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN claim_reviewed_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN no_claim TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN claim_submitted_date TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN claim_deadline TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN completeness_status TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN om_approved_by TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN om_approved_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN cancelled_by TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN cancelled_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN cancel_note TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN paid_by TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN paid_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN payment_date TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN paid_amount REAL DEFAULT 0;`,
  `ALTER TABLE off_batch ADD COLUMN payment_proof_path TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN payment_proof_name TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN payment_proof_mime TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN payment_proof_size INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN payment_method TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN payment_sender_bank TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN finance_note TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN verified_amount REAL DEFAULT 0;`,
  `ALTER TABLE off_batch ADD COLUMN final_claim_note TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN pdf_path TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN pdf_generated_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN pdf_status TEXT DEFAULT 'pending';`,
  `ALTER TABLE off_batch ADD COLUMN receipt_pdf_path TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN receipt_pdf_generated_at INTEGER;`,
  `ALTER TABLE off_batch ADD COLUMN receipt_pdf_status TEXT DEFAULT 'pending';`,
  `ALTER TABLE off_batch ADD COLUMN refund_status TEXT NOT NULL DEFAULT 'Not Applicable';`,
  `ALTER TABLE off_batch ADD COLUMN refund_amount REAL;`,
  `ALTER TABLE off_batch ADD COLUMN total_refunded REAL;`,
  `ALTER TABLE off_batch ADD COLUMN no_rekening TEXT;`,
  `ALTER TABLE off_batch ADD COLUMN created_by_role TEXT;`,
  `ALTER TABLE sales_targets ADD COLUMN tipe_sales TEXT NOT NULL DEFAULT 'exclusive';`,
  `ALTER TABLE sales_targets ADD COLUMN status_insentif TEXT NOT NULL DEFAULT 'distributor_principle';`,
  `ALTER TABLE off_batch_item ADD COLUMN no_claim TEXT;`,
  `ALTER TABLE off_batch_item ADD COLUMN no_rekening TEXT;`,
  `ALTER TABLE off_batch_item ADD COLUMN finance_payment_status TEXT NOT NULL DEFAULT 'unpaid';`,
  `ALTER TABLE off_batch_item ADD COLUMN finance_paid_at INTEGER;`,
  `ALTER TABLE off_batch_item ADD COLUMN finance_payment_id TEXT;`,
  `ALTER TABLE off_batch_item ADD COLUMN finance_paid_amount REAL;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_kwt INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_skp INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_fp INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_pc INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_foto INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_rekap INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_others INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_others_text TEXT;`,
  `ALTER TABLE off_batch_item ADD COLUMN final_completeness_note TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN payment_sender_bank TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN sender_bank TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN payment_proof_path TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN payment_proof_name TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN payment_proof_mime TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN payment_proof_size INTEGER;`,
  `ALTER TABLE off_payment ADD COLUMN note TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN created_by TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN updated_at INTEGER;`,
  `ALTER TABLE off_audit_log ADD COLUMN item_id TEXT;`,
  // Tipe Program revisi (legacy-safe)
  `ALTER TABLE off_batch_item ADD COLUMN original_type TEXT;`,
  `ALTER TABLE off_batch_item ADD COLUMN normalized_type TEXT;`,
  `ALTER TABLE off_batch_item ADD COLUMN type_is_legacy INTEGER NOT NULL DEFAULT 0;`,
  // PPh level item/toko (HOLD, nullable)
  `ALTER TABLE off_batch_item ADD COLUMN pph_exempt INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE off_batch_item ADD COLUMN pph_amount REAL;`,
  `ALTER TABLE off_batch_item ADD COLUMN adjustment_pph REAL;`,
  // Audit log correction (non-destruktif) untuk Claim
  `ALTER TABLE off_audit_log ADD COLUMN corrected_by TEXT;`,
  `ALTER TABLE off_audit_log ADD COLUMN corrected_at INTEGER;`,
  `ALTER TABLE off_audit_log ADD COLUMN correction_reason TEXT;`,
  `ALTER TABLE off_audit_log ADD COLUMN previous_value TEXT;`,
  `ALTER TABLE off_audit_log ADD COLUMN new_value TEXT;`,
  `ALTER TABLE off_audit_log ADD COLUMN parent_audit_log_id TEXT;`,
  // Phase R7a — Claim Workflow additive columns
  `ALTER TABLE claim_workflow ADD COLUMN source_type TEXT NOT NULL DEFAULT 'off_program';`,
  `ALTER TABLE claim_workflow ADD COLUMN source_ref_id TEXT;`,
  `ALTER TABLE claim_workflow ADD COLUMN aggregate_status TEXT;`,
  `ALTER TABLE claim_workflow_item ADD COLUMN claim_submission_id TEXT;`,
  `ALTER TABLE claim_payment ADD COLUMN claim_submission_id TEXT;`,
  `ALTER TABLE claim_audit_log ADD COLUMN claim_submission_id TEXT;`,
  `ALTER TABLE claim_audit_log ADD COLUMN audit_scope TEXT;`,
  // Form-kontrol — GPS check-in + anti-fraud flag (additive, legacy-safe)
  `ALTER TABLE ao_control_daily ADD COLUMN checkin_lat REAL;`,
  `ALTER TABLE ao_control_daily ADD COLUMN checkin_lng REAL;`,
  `ALTER TABLE ao_control_daily ADD COLUMN checkin_accuracy REAL;`,
  `ALTER TABLE ao_control_daily ADD COLUMN gps_flag TEXT;`,
];

for (const sql of migrations) {
  try {
    await db.execute(sql);
  } catch (error) {
    const msg = String(error?.message || error);
    if (!msg.includes("duplicate column name") && !msg.includes("no such table") && !msg.includes("no such column")) {
      throw error;
    }
  }
}

// --- Backfill metadata legacy tipe program (revisi A / Prioritas 5) ---
// Data lama (pre-dropdown) tidak punya metadata legacy. Backfill ini:
//  1) Menandai data lama sebagai legacy (type_is_legacy=1) -> badge "Data Lama".
//  2) Menyimpan jejak nilai tipe asli ke original_type (tidak menghapus type).
//  3) Mengisi normalized_type dari hasil normalisasi (exact/alias) atau fallback Sample.
// Heuristik "data lama": baris dengan normalized_type masih NULL (input baru selalu
// mengisi normalized_type). Semua statement idempotent: setelah terisi, WHERE tidak
// lagi cocok pada run berikutnya.
const legacyKey = "LOWER(TRIM(COALESCE(type, '')))";
const legacyBackfill = [
  // 1) Tandai data lama sebagai legacy SEBELUM normalized_type diisi.
  //    Termasuk data yang exact match dropdown (tetap "Data Lama").
  `UPDATE off_batch_item
     SET type_is_legacy = 1
   WHERE normalized_type IS NULL
     AND (type_is_legacy = 0 OR type_is_legacy IS NULL);`,
  // 2) Simpan jejak nilai tipe asli (jangan hapus type tanpa menyimpan original_type).
  `UPDATE off_batch_item
     SET original_type = type
   WHERE (original_type IS NULL OR original_type = '')
     AND type IS NOT NULL
     AND type <> '';`,
  // 3) Isi normalized_type: exact + alias umum -> dropdown final, selain itu Sample.
  //    Mirror dari EXPLICIT_ALIASES di lib/off-program-control/program-type.ts.
  //    Catatan: typo berat / nilai tak dikenal aman jatuh ke fallback "Sample".
  `UPDATE off_batch_item
     SET normalized_type = CASE
       WHEN ${legacyKey} IN ('display','off display','off-display','endcap','endcap support') THEN 'Display'
       WHEN ${legacyKey} IN ('visibility','visibilty','visibilyty','visibilityy','visiblity','visibiliti','visibilitas','area visibility') THEN 'Visibility'
       WHEN ${legacyKey} IN ('promo on store','promo onstore','promo on-store','promo instore','promo in store') THEN 'Promo On Store'
       WHEN ${legacyKey} IN ('event','off event') THEN 'Event'
       WHEN ${legacyKey} IN ('sample','sampling','sampling area','sampel') THEN 'Sample'
       ELSE 'Sample'
     END
   WHERE normalized_type IS NULL;`,
];

for (const sql of legacyBackfill) {
  try {
    await db.execute(sql);
  } catch (error) {
    // Toleransi bila kolom belum ada di skema sangat lama; jangan gagalkan init.
    const message = String(error?.message || error);
    if (!/no such column|no such table/i.test(message)) {
      throw error;
    }
  }
}

await db.execute(
  `UPDATE user SET role = 'viewer' WHERE role IS NULL OR role = '';`,
  `UPDATE off_batch_item
     SET no_rekening = (
       SELECT off_batch.no_rekening
       FROM off_batch
       WHERE off_batch.id = off_batch_item.batch_id
     )
   WHERE (no_rekening IS NULL OR no_rekening = '')
     AND LOWER(COALESCE(cara_bayar, '')) = 'transfer'
     AND batch_id IN (
       SELECT id FROM off_batch WHERE no_rekening IS NOT NULL AND no_rekening <> ''
     );`,
);
await db.execute(
  `UPDATE user SET permissions = '{}' WHERE permissions IS NULL OR permissions = '';`,
);

// --- Claim Workflow Indexes --- //
const claimIndexes = [
  `CREATE INDEX IF NOT EXISTS idx_claim_workflow_item_workflow_id ON claim_workflow_item(claim_workflow_id);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_workflow_item_off_batch_item_id ON claim_workflow_item(off_batch_item_id);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_workflow_item_submission_id ON claim_workflow_item(claim_submission_id);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_payment_workflow_id ON claim_payment(claim_workflow_id);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_payment_voided_at ON claim_payment(voided_at);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_payment_submission_id ON claim_payment(claim_submission_id);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_audit_log_workflow_id ON claim_audit_log(claim_workflow_id);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_audit_log_created_at ON claim_audit_log(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_audit_log_submission_id ON claim_audit_log(claim_submission_id);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_submission_workflow_id ON claim_submission(claim_workflow_id);`,
  `CREATE INDEX IF NOT EXISTS idx_claim_submission_status ON claim_submission(status);`,
  // No Claim lookup index (NOT unique — same No Claim allowed within one workflow).
  // Cross-workflow uniqueness enforced at app layer.
  `DROP INDEX IF EXISTS idx_claim_submission_no_claim_unique;`,
  `CREATE INDEX IF NOT EXISTS idx_claim_submission_no_claim ON claim_submission(no_claim) WHERE no_claim IS NOT NULL AND no_claim <> '';`,
  // Partial unique index: No Claim pada claim_workflow level (legacy cache).
  // Kept for backward compat but workflow.noClaim is only used for single-submission legacy.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_workflow_no_claim_unique ON claim_workflow(no_claim) WHERE no_claim IS NOT NULL;`,
];

for (const sql of claimIndexes) {
  try {
    await db.execute(sql);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/already exists|no such table/i.test(message)) {
      throw error;
    }
  }
}

// --- Insentif Sales tables ---
const insentifStatements = [
  `CREATE TABLE IF NOT EXISTS sales_targets (
    id TEXT PRIMARY KEY NOT NULL,
    sales_code TEXT NOT NULL,
    sales_name TEXT NOT NULL,
    principle TEXT NOT NULL,
    branch TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'TT',
    spv_name TEXT,
    sm_name TEXT,
    period_month INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    target_value REAL NOT NULL DEFAULT 0,
    target_ec INTEGER NOT NULL DEFAULT 0,
    target_ao INTEGER NOT NULL DEFAULT 0,
    target_ia INTEGER NOT NULL DEFAULT 0,
    splm_value REAL NOT NULL DEFAULT 0,
    tipe_sales TEXT NOT NULL DEFAULT 'exclusive',
    status_insentif TEXT NOT NULL DEFAULT 'distributor_principle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS incentive_support (
    id TEXT PRIMARY KEY NOT NULL,
    sales_code TEXT NOT NULL,
    principle TEXT NOT NULL,
    period_month INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    support_amount REAL NOT NULL DEFAULT 0,
    input_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS sales_daily_progress (
    id TEXT PRIMARY KEY NOT NULL,
    sales_code TEXT NOT NULL,
    principle TEXT NOT NULL,
    branch TEXT NOT NULL,
    date TEXT NOT NULL,
    period_month INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    invoice_number TEXT,
    achieved_value_dpp REAL NOT NULL DEFAULT 0,
    achieved_ec INTEGER NOT NULL DEFAULT 0,
    achieved_ao INTEGER NOT NULL DEFAULT 0,
    achieved_ia INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS incentive_tiers (
    id TEXT PRIMARY KEY NOT NULL,
    principle TEXT NOT NULL DEFAULT 'ALL',
    branch TEXT NOT NULL DEFAULT 'ALL',
    kpi_type TEXT NOT NULL,
    min_percentage REAL NOT NULL,
    max_percentage REAL NOT NULL,
    incentive_amount REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS incentive_payments (
    id TEXT PRIMARY KEY NOT NULL,
    sales_code TEXT NOT NULL,
    sales_name TEXT NOT NULL,
    principle TEXT NOT NULL,
    branch TEXT NOT NULL,
    period_month INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    total_incentive REAL NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'belum',
    payment_proof_url TEXT,
    payment_date INTEGER,
    paid_by TEXT,
    paid_by_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_sales_targets_period ON sales_targets(period_month, period_year);`,
  `CREATE INDEX IF NOT EXISTS idx_sales_targets_code ON sales_targets(sales_code);`,
  `CREATE INDEX IF NOT EXISTS idx_sdp_period ON sales_daily_progress(period_month, period_year);`,
  `CREATE INDEX IF NOT EXISTS idx_sdp_code ON sales_daily_progress(sales_code);`,
  `CREATE INDEX IF NOT EXISTS idx_sdp_date ON sales_daily_progress(date);`,
  `CREATE INDEX IF NOT EXISTS idx_incentive_tiers_kpi ON incentive_tiers(kpi_type);`,
  `CREATE INDEX IF NOT EXISTS idx_inc_payments_period ON incentive_payments(period_month, period_year);`,
  `CREATE INDEX IF NOT EXISTS idx_inc_payments_code ON incentive_payments(sales_code);`,
  `CREATE INDEX IF NOT EXISTS idx_inc_payments_status ON incentive_payments(payment_status);`,
  `CREATE INDEX IF NOT EXISTS idx_inc_support_period ON incentive_support(period_month, period_year);`,
  `CREATE INDEX IF NOT EXISTS idx_inc_support_code ON incentive_support(sales_code);`,
  // Hierarki SM->SPV->Sales (Bagian C) — additive, belum di-wire ke kalkulasi/RBAC.
  `CREATE TABLE IF NOT EXISTS spv_sales_assignment (
    id TEXT PRIMARY KEY NOT NULL,
    sales_code TEXT NOT NULL UNIQUE,
    spv_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS sm_spv_assignment (
    id TEXT PRIMARY KEY NOT NULL,
    spv_name TEXT NOT NULL UNIQUE,
    sm_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_spv_sales_assignment_spv ON spv_sales_assignment(spv_name);`,
  `CREATE INDEX IF NOT EXISTS idx_sm_spv_assignment_sm ON sm_spv_assignment(sm_name);`,
];

for (const sql of insentifStatements) {
  try {
    await db.execute(sql);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/already exists/i.test(message)) {
      throw error;
    }
  }
}

// --- Form Kontrol tables ---
// Catatan: kolom *_at adalah INTEGER (unix timestamp) agar cocok dengan
// drizzle schema (mode: "timestamp"). `date` tetap TEXT 'YYYY-MM-DD'.
const formKontrolStatements = [
  `CREATE TABLE IF NOT EXISTS jks_master (
    id TEXT PRIMARY KEY NOT NULL,
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
    updated_at INTEGER NOT NULL,
    UNIQUE(sales_code, cust_code, principle)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_jks_sales_principle ON jks_master(sales_code, principle);`,
  `CREATE INDEX IF NOT EXISTS idx_jks_cust_code ON jks_master(cust_code);`,
  `CREATE INDEX IF NOT EXISTS idx_jks_principle_hari ON jks_master(principle, hari_kunjungan);`,
  `CREATE TABLE IF NOT EXISTS ao_control_daily (
    id TEXT PRIMARY KEY NOT NULL,
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
    checkin_at INTEGER,
    checkin_photo_url TEXT,
    checkout_at INTEGER,
    checkout_photo_url TEXT,
    checkin_lat REAL,
    checkin_lng REAL,
    checkin_accuracy REAL,
    gps_flag TEXT,
    auto_matched INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(sales_code, cust_code, principle, date)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ao_sales_date ON ao_control_daily(sales_code, date);`,
  `CREATE INDEX IF NOT EXISTS idx_ao_cust_period ON ao_control_daily(cust_code, period_month, period_year);`,
  `CREATE INDEX IF NOT EXISTS idx_ao_status ON ao_control_daily(status);`,
  `CREATE TABLE IF NOT EXISTS no_order_reason (
    id TEXT PRIMARY KEY NOT NULL,
    reason_code TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    category TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1
  );`,
  `CREATE TABLE IF NOT EXISTS merchandising_check (
    id TEXT PRIMARY KEY NOT NULL,
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
    step_photos TEXT,
    note TEXT,
    created_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_merch_sales_date ON merchandising_check(sales_code, date);`,
  `CREATE TABLE IF NOT EXISTS salesman_daily_report (
    id TEXT PRIMARY KEY NOT NULL,
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
  );`,
  `CREATE TABLE IF NOT EXISTS spv_briefing (
    id TEXT PRIMARY KEY NOT NULL,
    spv_name TEXT NOT NULL,
    date TEXT NOT NULL,
    session TEXT NOT NULL DEFAULT 'pagi',
    agenda TEXT,
    toko_dialas TEXT,
    penyebab TEXT,
    solusi TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS sm_control (
    id TEXT PRIMARY KEY NOT NULL,
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
  );`,
  `CREATE TABLE IF NOT EXISTS kontrol_audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT,
    payload TEXT,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS sales_profile (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL UNIQUE,
    sales_code TEXT NOT NULL UNIQUE,
    sales_name TEXT NOT NULL,
    principle TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'TT',
    spv_name TEXT,
    sm_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_sales_profile_code ON sales_profile(sales_code);`,
  `CREATE INDEX IF NOT EXISTS idx_sales_profile_user ON sales_profile(user_id);`,
  `CREATE TABLE IF NOT EXISTS sales_outlet_txn (
    id TEXT PRIMARY KEY NOT NULL,
    sales_code TEXT NOT NULL,
    cust_code TEXT NOT NULL,
    principle TEXT NOT NULL,
    date TEXT NOT NULL,
    period_month INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    invoice_number TEXT,
    value_dpp REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );`,
];

for (const sql of formKontrolStatements) {
  try {
    await db.execute(sql);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/already exists/i.test(message)) throw error;
  }
}

// Migrasi additive untuk tabel form-kontrol yang mungkin dibuat versi DDL lama
// (mis. sales_profile sebelum kolom channel ada). Toleran duplicate/no-such-table.
const formKontrolMigrations = [
  `ALTER TABLE sales_profile ADD COLUMN channel TEXT NOT NULL DEFAULT 'TT';`,
];
for (const sql of formKontrolMigrations) {
  try {
    await db.execute(sql);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/duplicate column name|no such table|no such column/i.test(message)) throw error;
  }
}

// Dynamic RBAC (Access Group) — additive, idempotent. Dibuat di sini supaya
// otomatis ada di produksi tiap deploy (CMD container = init-db sebelum start),
// tanpa perlu better-sqlite3 / seed manual di VPS.
const rbacStatements = [
  `CREATE TABLE IF NOT EXISTS access_group (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     description  TEXT,
     is_preset    INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS group_permission (
     group_id        TEXT NOT NULL REFERENCES access_group(id),
     permission_key  TEXT NOT NULL,
     PRIMARY KEY (group_id, permission_key)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_group_permission_group ON group_permission(group_id);`,
  `CREATE TABLE IF NOT EXISTS user_group (
     user_id      TEXT NOT NULL REFERENCES user(id),
     group_id     TEXT NOT NULL REFERENCES access_group(id),
     assigned_by  TEXT,
     assigned_at  INTEGER NOT NULL,
     PRIMARY KEY (user_id, group_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_user_group_user  ON user_group(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_user_group_group ON user_group(group_id);`,
  `CREATE TABLE IF NOT EXISTS permission_audit_log (
     id              TEXT PRIMARY KEY,
     actor_user_id   TEXT,
     actor_name      TEXT,
     action          TEXT NOT NULL,
     target_user_id  TEXT,
     target_group_id TEXT,
     detail          TEXT,
     created_at      INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_pal_actor        ON permission_audit_log(actor_user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_pal_target_user  ON permission_audit_log(target_user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_pal_target_group ON permission_audit_log(target_group_id);`,
];
for (const sql of rbacStatements) {
  try {
    await db.execute(sql);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/already exists/i.test(message)) throw error;
  }
}

// Seed 11 grup preset Access Group — SEKALI SAJA (insert-if-name-not-exists).
// Grup yang sudah ada TIDAK disentuh → perubahan izin/anggota manual via UI aman.
// Backfill user_group hanya untuk user yang BELUM punya grup sama sekali.
const PERMISSION_REGISTRY = {
  dashboard: ["view"],
  api_wrapper: ["view", "execute"],
  payments: ["view", "create", "edit", "update", "delete", "upload", "export", "submit"],
  sppd: ["view", "edit_settings", "upload_excel", "generate", "download"],
  finance: ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update"],
  principles: ["view", "upload", "delete"],
  summary: ["view", "upload", "generate", "email", "export", "edit", "update"],
  validator: ["view", "upload", "run", "download", "edit"],
  off_program_control: ["view", "create", "update", "approve", "export", "create_batch", "edit_returned_batch", "submit_batch", "sm_approve", "sm_return", "claim_review", "claim_final", "om_approve", "om_cancel", "finance_payment", "submit_refund", "audit_read", "audit_export", "audit_correct", "period_close", "period_unlock", "discount_view", "discount_manage"],
  claim_workflow: ["view", "create", "edit", "update", "submit", "approve", "export"],
  users: ["view", "create_user", "edit_user", "delete_user", "set_role", "set_permission", "manage"],
  form_kontrol: ["view", "submit", "manage"],
  insentif_sales: ["view", "manage", "upload_target", "upload_progress", "input_support", "manage_payment"],
};
const allPresetKeys = Object.entries(PERMISSION_REGISTRY).flatMap(([m, acts]) => acts.map((a) => `${m}.${a}`));
const kk = (mod, acts) => acts.map((a) => `${mod}.${a}`);
const PRESETS = [
  { name: "Admin", desc: "Akses penuh semua modul", keys: allPresetKeys },
  { name: "Manager", desc: "Manajer lintas modul", keys: [...kk("dashboard", ["view"]), ...kk("api_wrapper", ["view", "execute"]), ...kk("payments", ["view", "export", "submit", "edit", "update"]), ...kk("sppd", ["view", "generate", "download"]), ...kk("finance", ["view", "approve", "export", "update"]), ...kk("principles", ["view"]), ...kk("summary", ["view", "export"]), ...kk("validator", ["view", "download"]), ...kk("off_program_control", ["view", "update", "approve", "export"]), ...kk("claim_workflow", ["view", "approve", "export"]), ...kk("form_kontrol", ["view", "submit", "manage"]), ...kk("insentif_sales", ["view", "upload_target", "upload_progress"])] },
  { name: "Finance", desc: "Keuangan / pembayaran", keys: [...kk("dashboard", ["view"]), ...kk("payments", ["view", "export"]), ...kk("sppd", ["view", "download"]), ...kk("finance", ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update"]), ...kk("off_program_control", ["view", "update", "finance_payment", "submit_refund"]), ...kk("claim_workflow", ["view", "update", "export"]), ...kk("principles", ["view"]), ...kk("insentif_sales", ["view", "input_support", "manage_payment"])] },
  { name: "Staff", desc: "Staf input operasional", keys: [...kk("dashboard", ["view"]), ...kk("payments", ["view", "create", "edit", "upload", "submit"]), ...kk("sppd", ["view", "generate", "download"]), ...kk("principles", ["view"]), ...kk("summary", ["view", "upload", "generate", "export", "edit", "update"]), ...kk("validator", ["view", "upload", "run", "download", "edit"]), ...kk("off_program_control", ["view", "create", "update"]), ...kk("claim_workflow", ["view"])] },
  { name: "Viewer", desc: "Hanya lihat", keys: [...kk("dashboard", ["view"]), ...kk("payments", ["view"]), ...kk("sppd", ["view"]), ...kk("finance", ["view"]), ...kk("off_program_control", ["view"]), ...kk("claim_workflow", ["view"]), ...kk("summary", ["view"]), ...kk("validator", ["view"])] },
  { name: "SPV", desc: "Supervisor — OPC pengajuan + Form Kontrol tim", keys: [...kk("dashboard", ["view"]), ...kk("off_program_control", ["view", "create", "update", "create_batch", "edit_returned_batch", "submit_batch", "submit_refund", "discount_view", "discount_manage"]), ...kk("form_kontrol", ["view", "submit"]), ...kk("insentif_sales", ["view", "upload_progress"])] },
  { name: "SM", desc: "Sales Manager — approve OPC + Form Kontrol", keys: [...kk("dashboard", ["view"]), ...kk("off_program_control", ["view", "sm_approve", "sm_return", "submit_refund"]), ...kk("form_kontrol", ["view", "submit"]), ...kk("insentif_sales", ["view"])] },
  { name: "Claim", desc: "Tim Klaim — review & klaim", keys: [...kk("dashboard", ["view"]), ...kk("off_program_control", ["view", "export", "claim_review", "claim_final", "audit_read", "audit_export", "audit_correct", "period_close", "create_batch", "submit_batch", "edit_returned_batch"]), ...kk("claim_workflow", ["view", "create", "edit", "update", "submit", "approve", "export"])] },
  { name: "OM", desc: "Operational Manager — approve akhir OPC", keys: [...kk("dashboard", ["view"]), ...kk("off_program_control", ["view", "om_approve", "om_cancel"])] },
  { name: "Salesman", desc: "Sales lapangan — Form Kontrol & insentif sendiri", keys: [...kk("dashboard", ["view"]), ...kk("form_kontrol", ["view", "submit"]), ...kk("insentif_sales", ["view"])] },
  { name: "Admin Sales", desc: "Admin sales — kelola Form Kontrol & target insentif", keys: [...kk("dashboard", ["view"]), ...kk("form_kontrol", ["view", "submit", "manage"]), ...kk("insentif_sales", ["view", "manage", "upload_target", "upload_progress", "input_support", "manage_payment"])] },
];
const ROLE_TO_GROUP = {
  admin: "Admin", super_admin: "Admin", manager: "Manager", finance: "Finance", staff: "Staff", viewer: "Viewer",
  spv: "SPV", supervisor: "SPV", sm: "SM", sales_manager: "SM", claim: "Claim", om: "OM", operational_manager: "OM",
  salesman: "Salesman", sales: "Salesman", admin_sales: "Admin Sales",
};

try {
  const seedNow = Date.now();
  const groupIdByName = {};
  for (const p of PRESETS) {
    const existing = await db.execute({ sql: "SELECT id FROM access_group WHERE name = ?", args: [p.name] });
    if (existing.rows.length > 0) {
      groupIdByName[p.name] = String(existing.rows[0].id);
      continue; // sudah ada → jangan timpa izin/anggota yang mungkin sudah diubah manual
    }
    const id = randomUUID();
    groupIdByName[p.name] = id;
    await db.execute({ sql: "INSERT INTO access_group (id, name, description, is_preset, created_at, updated_at) VALUES (?,?,?,1,?,?)", args: [id, p.name, p.desc, seedNow, seedNow] });
    for (const key of p.keys) {
      await db.execute({ sql: "INSERT OR IGNORE INTO group_permission (group_id, permission_key) VALUES (?,?)", args: [id, key] });
    }
  }

  // Backfill: hanya user yang BELUM punya grup apa pun (jangan ganggu kurasi manual).
  const assignedRows = await db.execute("SELECT DISTINCT user_id FROM user_group");
  const hasGroup = new Set(assignedRows.rows.map((r) => String(r.user_id)));
  const userRows = await db.execute("SELECT id, role FROM user");
  for (const u of userRows.rows) {
    const uid = String(u.id);
    if (hasGroup.has(uid)) continue;
    const roleKey = String(u.role ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const groupName = ROLE_TO_GROUP[roleKey];
    if (!groupName || !groupIdByName[groupName]) continue;
    await db.execute({ sql: "INSERT OR IGNORE INTO user_group (user_id, group_id, assigned_by, assigned_at) VALUES (?,?,?,?)", args: [uid, groupIdByName[groupName], "init-db-seed", seedNow] });
  }
} catch (error) {
  console.warn("[init-db] seed grup preset dilewati:", String(error?.message || error));
}

console.log("SQLite tables are ready");
