// Initialize SQLite tables used by Better Auth and local cache when the runtime volume is empty.
// Safe to run repeatedly because all statements use IF NOT EXISTS.
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';

const databaseUrl = process.env.DATABASE_URL || 'file:/app/data/sqlite.db';
const filePath = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : null;
if (filePath?.startsWith('/')) {
  mkdirSync(filePath.replace(/\/[^/]*$/, ''), { recursive: true });
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
  );`
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
];

for (const sql of migrations) {
  try {
    await db.execute(sql);
  } catch (error) {
    if (!String(error?.message || error).includes('duplicate column name')) {
      throw error;
    }
  }
}

await db.execute(`UPDATE user SET role = 'viewer' WHERE role IS NULL OR role = '';`);

console.log('SQLite tables are ready');
