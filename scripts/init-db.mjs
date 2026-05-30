// Tujuan: Inisialisasi/migrasi SQLite runtime untuk Better Auth, RBAC, cache master, dan idempotency.
// Caller: Dockerfile.frontend startup command sebelum `next start`.
// Dependensi: @libsql/client dan filesystem volume DATABASE_URL.
// Main Functions: create table IF NOT EXISTS, migration ALTER TABLE, role/permission default update.
// Side Effects: Membuat folder DB dan menjalankan DDL/DML SQLite.
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";

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
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
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
  `ALTER TABLE off_batch_item ADD COLUMN no_claim TEXT;`,
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
];

for (const sql of migrations) {
  try {
    await db.execute(sql);
  } catch (error) {
    if (!String(error?.message || error).includes("duplicate column name")) {
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
);
await db.execute(
  `UPDATE user SET permissions = '{}' WHERE permissions IS NULL OR permissions = '';`,
);

console.log("SQLite tables are ready");
