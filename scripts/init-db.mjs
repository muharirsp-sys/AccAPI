// Initialize SQLite tables used by Better Auth and local cache when the runtime volume is empty.
// Safe to run repeatedly because all statements use IF NOT EXISTS.
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
    id TEXT PRIMARY KEY NOT NULL,
    no_pengajuan TEXT NOT NULL UNIQUE,
    gelombang TEXT NOT NULL,
    principle_code TEXT NOT NULL,
    principle_name TEXT NOT NULL,
    bulan TEXT NOT NULL,
    tahun TEXT NOT NULL,
    supervisor_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft',
    sm_status TEXT NOT NULL DEFAULT 'Waiting',
    claim_status TEXT NOT NULL DEFAULT 'Not Started',
    om_status TEXT NOT NULL DEFAULT 'Not Started',
    finance_status TEXT NOT NULL DEFAULT 'Not Started',
    final_status TEXT NOT NULL DEFAULT 'Not Started',
    locked INTEGER NOT NULL DEFAULT 0,
    sm_note TEXT,
    claim_note TEXT,
    om_note TEXT,
    finance_note TEXT,
    final_claim_note TEXT,
    no_claim TEXT,
    claim_submitted_date TEXT,
    claim_deadline TEXT,
    payment_date TEXT,
    paid_amount REAL,
    verified_amount REAL,
    pdf_path TEXT,
    pdf_status TEXT NOT NULL DEFAULT 'pending',
    pdf_generated_at INTEGER,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS off_batch_item (
    id TEXT PRIMARY KEY NOT NULL,
    batch_id TEXT NOT NULL,
    item_no INTEGER NOT NULL,
    row_no INTEGER NOT NULL,
    no_surat TEXT,
    no_claim TEXT,
    nama_program TEXT NOT NULL,
    periode TEXT,
    toko TEXT,
    barang TEXT,
    nominal REAL NOT NULL DEFAULT 0,
    cara_bayar TEXT,
    type TEXT,
    deadline TEXT,
    kwt INTEGER NOT NULL DEFAULT 0,
    skp INTEGER NOT NULL DEFAULT 0,
    fp INTEGER NOT NULL DEFAULT 0,
    pc INTEGER NOT NULL DEFAULT 0,
    foto INTEGER NOT NULL DEFAULT 0,
    rekap INTEGER NOT NULL DEFAULT 0,
    others INTEGER NOT NULL DEFAULT 0,
    others_text TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES off_batch(id)
  );`,
  `CREATE TABLE IF NOT EXISTS off_payment (
    id TEXT PRIMARY KEY NOT NULL,
    batch_id TEXT NOT NULL,
    payment_no INTEGER NOT NULL,
    payment_date TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    paid_amount REAL NOT NULL DEFAULT 0,
    sender_bank TEXT,
    payment_proof_name TEXT NOT NULL,
    payment_proof_path TEXT,
    payment_proof_mime TEXT,
    payment_proof_size INTEGER,
    note TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES off_batch(id)
  );`,
  `CREATE TABLE IF NOT EXISTS off_notification (
    id TEXT PRIMARY KEY NOT NULL,
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
    id TEXT PRIMARY KEY NOT NULL,
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
    created_at INTEGER NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES off_batch(id)
  );`,
];

for (const sql of statements) {
  await db.execute(sql);
}

const migrations = [
  `ALTER TABLE user ADD COLUMN role TEXT DEFAULT 'viewer';`,
  `ALTER TABLE user ADD COLUMN banned INTEGER DEFAULT 0;`,
  `ALTER TABLE user ADD COLUMN banReason TEXT;`,
  `ALTER TABLE user ADD COLUMN banExpires INTEGER;`,
  `ALTER TABLE session ADD COLUMN impersonatedBy TEXT;`,
  `ALTER TABLE off_batch_item ADD COLUMN no_claim TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN payment_proof_path TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN payment_proof_mime TEXT;`,
  `ALTER TABLE off_payment ADD COLUMN payment_proof_size INTEGER;`,
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

await db.execute(
  `UPDATE user SET role = 'viewer' WHERE role IS NULL OR role = '';`,
);

console.log("SQLite tables are ready");
