import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// D4 cutover: PostgreSQL. Rollback = kembalikan DATABASE_URL file:sqlite.db + revert branch.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);
