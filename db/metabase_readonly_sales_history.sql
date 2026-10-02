-- Tambahan GRANT untuk Metabase: tabel sales_history_export (mirror dari sales-history-inv.db,
-- lihat scripts/sync-sales-history-to-postgres.mjs). Jalankan SETELAH db/metabase_readonly.sql
-- (role metabase_readonly harus sudah ada) dan SETELAH db/migrations/0002_sales_history_export.sql
-- (tabelnya harus sudah ada).
--
-- Catatan: db/metabase_readonly.sql saat ini BELUM di-commit ke git (file lokal, untracked, di
-- checkout utama) -- file ini dibuat terpisah supaya tidak menimpa file itu. Gabungkan ke
-- metabase_readonly.sql (mengikuti pola GRANT per-kolom di sana) kalau/ketika file itu di-commit.
--
-- Jalankan: psql "$DATABASE_URL" -f db/metabase_readonly_sales_history.sql

BEGIN;

-- customer_npwp sengaja TIDAK ADA di tabel sales_history_export sama sekali (bukan cuma tidak
-- di-grant) -- lihat catatan di db/migrations/0002_sales_history_export.sql -- jadi seluruh tabel
-- boleh di-GRANT tanpa whitelist per-kolom seperti tabel lain di metabase_readonly.sql.
GRANT SELECT ON sales_history_export TO metabase_readonly;

COMMIT;

-- Self-check -----------------------------------------------------------
DO $$
BEGIN
  ASSERT has_table_privilege('metabase_readonly', 'sales_history_export', 'SELECT'),
         'sales_history_export tidak ke-grant';
  -- customer_npwp sengaja tidak pernah dibuat di tabel ini sama sekali (lihat
  -- db/migrations/0002_sales_history_export.sql) -- has_column_privilege akan ERROR (bukan return
  -- false) untuk kolom yang tidak ada, jadi itu sendiri sudah pembuktian yang cukup; tidak perlu
  -- assert tambahan di sini.
  RAISE NOTICE 'sales_history_export grant OK';
END
$$;
