import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: {
    // D4: isi DATABASE_URL postgres:// (lokal: via SSH tunnel ke Postgres VPS)
    url: process.env.DATABASE_URL || "postgres://localhost:5432/accapi",
  },
});
