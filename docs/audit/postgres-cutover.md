# D4 — Rencana Cutover SQLite → PostgreSQL (harus aman)

| Doc | Nilai |
|---|---|
| Status infra | ✅ SELESAI 2026-07-12 — PostgreSQL 16.14 jalan di VPS 43.156.118.114, container `accapi-postgres`, network `coolify` (internal-only, TANPA port publik), volume `accapi-pgdata`, kredensial di `/root/accapi-postgres.env` (chmod 600) |
| Status kode | 🔶 GERBANG 1–3 LOLOS 2026-07-13 (branch `migrate-postgres`): schema 50 pgTable + adapter pg (tsc bersih, drizzle-kit push = 50 tabel di PG VPS); `scripts/migrate-data-to-pg.mjs` 50/50 COUNT+sampel OK; uji lokal vs PG: login, /api/auth/verify (+permissions), OPC list+create, claim workflow, insentif dashboard, FastAPI get_current_user via AUTH_VERIFY_URL — semua hijau. SISA: Gerbang 4–5 (switch production, tunggu jadwal freeze dari user) |
| Scheduler | ✅ `/etc/cron.d/accapi` terpasang (sync 4×/hari, cleanup harian) — teruji hit `cleanup-uploads` 200 |

## Prinsip
Aplikasi produksi TIDAK disentuh sampai seluruh kode terverifikasi di DB baru. Rollback selalu tersedia: SQLite file tetap ada; env `DATABASE_URL` tinggal dikembalikan.

## Cakupan terukur (audit 2026-07-12)
- `db/schema.ts`: 50 `sqliteTable` → `pgTable` (timestamp `integer mode:"timestamp"` → `timestamp`; `real` → `numeric/doublePrecision`; JSON text → `jsonb` opsional).
- `lib/db.ts` + `lib/auth.ts`: klien libsql → `pg`/postgres-js + adapter drizzle-pg Better Auth.
- 1 pemakaian API sqlite-style (`.get()`) di kode app — minor.
- `python_backend`: auth sudah siap via `AUTH_VERIFY_URL` (F9, terpasang); sisa 2 titik `sqlite3.connect(BETTER_AUTH_DB_PATH)` (role/permission lookup ~baris 1186/1234) perlu ikut jalur verify; `database.sqlite` milik python sendiri TIDAK ikut migrasi.
- `sales-history-inv.db` SENGAJA tetap SQLite (arsip read-only 5 jt baris, by design).
- Scripts `init-db/migrate-*` → versi pg atau drizzle-kit push.

## Langkah cutover (urut, dengan gerbang verifikasi)
1. Branch `migrate-postgres`: konversi schema + db client + auth adapter. Gate: `tsc` bersih + `drizzle-kit push` ke Postgres VPS (via SSH tunnel) sukses membuat 50 tabel.
2. Skrip migrasi data `scripts/migrate-data-to-pg.mjs`: baca SQLite → tulis PG per tabel, verifikasi COUNT(*) identik per tabel + sampling checksum baris. Gate: hasil count match 100%.
3. Uji lokal full: login, OPC list/create, claim workflow, insentif dashboard terhadap PG. Gate: alur inti hijau.
4. Deploy: set `DATABASE_URL=postgres://...` (dari `/root/accapi-postgres.env`) + `AUTH_VERIFY_URL=http://accapi-frontend:3000/api/auth/verify` di env Coolify service; freeze tulis sebentar (malam), re-run migrasi data delta, switch, restart.
5. Verifikasi produksi: login + 3 alur inti + cron log. Rollback bila ada anomali: kembalikan `DATABASE_URL` file sqlite (file tidak dihapus).
6. Setelah 1 minggu stabil: backup rutin PG (`pg_dump` cron) menggantikan copy file sqlite.

## Kenapa tidak sekali jalan hari ini
Perubahan F1–F11 baru saja masuk; menumpuk penggantian engine DB di deploy yang sama menghilangkan kemampuan mengisolasi penyebab bila ada regresi ("pindahnya harus aman"). Cutover dijalankan sebagai fase berikutnya dengan gerbang di atas.
