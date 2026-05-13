import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';

const databaseUrl = process.env.DATABASE_URL || 'file:sqlite.db';
const databaseFile = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : null;
if (databaseFile?.startsWith('/')) {
  mkdirSync(databaseFile.replace(/\/[^/]*$/, ''), { recursive: true });
}

const client = createClient({ url: databaseUrl });
export const db = drizzle(client);
