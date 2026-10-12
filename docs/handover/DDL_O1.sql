-- DDL MANUAL O1 — Order per cabang Accurate (go-live Order Sales + Order Masuk, owner 12 Okt 2026; putaran perbaikan 1).
-- Rujukan: db/schema.ts (item.branchId/suspended/charField2, customer.suspended, salesProfile.accurateLinked), scripts/migrate-pg.mjs
-- (entri "order cabang (item/customer/sales_profile O1)" = SQL sama dengan blok 1), db/migrations/0033_order_cabang.sql, lib/order-cabang.ts,
-- lib/sync.ts, app/api/admin/users/[id]/salesman/route.ts, lib/order-cabang-pg.test.ts, docs/handover/O1-KONTRAK-ORDER-CABANG.md.
--
-- SIAPA & KAPAN (pola K1a/K1b, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY O1, sebagai role
-- PEMILIK tabel (accapi, bukan accapi_app), SEBELUM image baru. JANGAN dijalankan loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_O1.sql
--
-- KENAPA SEBELUM: ALTER TABLE item/customer/sales_profile butuh PEMILIK. migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan
--   sebagai accapi_app -> ALTER 42501 -> container crash loop. Sesudah berkas ini entri migrate-pg di-SKIP (sudahAda via pg_attribute).
--   Image LAMA tidak terganggu (kolom baru tidak dibacanya; insert lama memakai DEFAULT).
-- KUNCI: ALTER mengambil ACCESS EXCLUSIVE sesaat (tanpa tulis ulang tabel: DEFAULT konstan). lock_timeout 5 dtk — bila sync cron sedang
--   menulis item/customer dan berkas gagal "lock timeout", jalankan ulang (idempoten).
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; agar uji PG bisa memakai skema sekali-pakai):
--   1. item.branch_id bigint, item.suspended boolean NOT NULL DEFAULT false, item.char_field2 text,
--      customer.suspended boolean NOT NULL DEFAULT false, sales_profile.accurate_linked boolean NOT NULL DEFAULT false
--      (tautan salesman AKTIF; DEFAULT false = profil yang sudah ada TIDAK membuka order sampai admin menautkannya). Tanpa indeks,
--      tanpa trigger, tanpa data.
--   2. Tanpa GRANT baru: hak tabel accapi_app mencakup kolom baru. VERIFIKASI memeriksanya, ditambah hak tautan salesman
--      (sales_profile SELECT/INSERT/UPDATE, permission_audit_log INSERT, baca 4 tabel Form Kontrol untuk penjaga ganti kode).
--   3. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan). Termasuk:
--      - UNIQUE sales_profile.sales_code (`pg_get_constraintdef` = 'UNIQUE (sales_code)'): satu-satunya penjamin "satu karyawan <-> satu
--        akun" saat dua admin menautkan bersamaan. false = JANGAN deploy; laporkan (jangan membuat constraint tanpa memeriksa duplikat).
--      - Tripwire grup: tidak ada grup ber-`websales.create` + `order.view` TANPA `order.create` (akun sales seperti itu akan mendapat
--        cakupan SEMUA cabang; aplikasi menolaknya `IZIN_TIDAK_KONSISTEN`). false = betulkan grup lewat layar Grup sebelum go-live.
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- SESUDAH IMAGE (WAJIB, urut): kolom baru kosong sampai sync ulang. Selama jendela itu SEMUA barang ber-branch_id NULL -> Order Sales /
--   Order Baru / tarikan Web Sales DITOLAK `BARANG_BEDA_CABANG` (gagal tertutup, bukan salah order). Picu sync (CRON_SECRET, jaringan
--   container; HANYA header Authorization — `?secret=` tidak diterima lagi):
--     curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
--       "http://accapi-frontend:3000/api/cron/sync-accurate?modules=branch,employee,item,customer"
--   Perkiraan: branch 1 halaman (<5 dtk), employee 1–3 halaman, item ±43 halaman list.do (±1–3 menit), customer ±330 halaman (±32 rb,
--   ±8–15 menit). Hasil `results.item.tagTakDikenal` = tag charField2 yang tak dipetakan (barangnya tak bisa diorder) — kirim ke
--   orkestrator; kosong = semua tag dikenal. Periksa sesudahnya (baca-saja):
--     SELECT b.name, count(*) FROM item i LEFT JOIN branch b ON b.id = i.branch_id GROUP BY 1 ORDER BY 2 DESC;
--     SELECT count(*) FILTER (WHERE suspended) AS suspended, count(*) FROM customer;   -- 0 suspended = Accurate mungkin mengabaikan field
--     SELECT count(*) FILTER (WHERE (raw_data #>> '{}')::jsonb ? 'charField2') AS ada_key, count(*) FROM item;   -- harus = count(*)
--   Lalu admin menautkan akun salesman (layar User; DEFAULT false = belum ada yang tertaut).
--   CATATAN: raw_data berubah (field baru) -> synced_at semua item & pelanggan maju sekali -> feed /api/ext/changes mengirim ulang seluruh
--   master satu kali.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg, DB am040_o1):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/order-cabang-pg.test.ts
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan kolom ini. Kolom boleh dibiarkan (aditif); JANGAN DROP tanpa alasan tercatat.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Kolom (sama dengan entri migrate-pg "order cabang (item/customer/sales_profile O1)" dan db/migrations/0033_order_cabang.sql).
ALTER TABLE item ADD COLUMN IF NOT EXISTS branch_id bigint;
ALTER TABLE item ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
ALTER TABLE item ADD COLUMN IF NOT EXISTS char_field2 text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
ALTER TABLE sales_profile ADD COLUMN IF NOT EXISTS accurate_linked boolean NOT NULL DEFAULT false;

COMMIT;

-- 3. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('item.branch_id bigint NULL', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('item') AND attname = 'branch_id'
        AND NOT attisdropped AND atttypid = 'bigint'::regtype AND NOT attnotnull)),
    ('item.suspended boolean NOT NULL DEFAULT false', EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid
        AND d.adnum = a.attnum WHERE a.attrelid = to_regclass('item') AND a.attname = 'suspended' AND NOT a.attisdropped
        AND a.atttypid = 'boolean'::regtype AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = 'false')),
    ('item.char_field2 text NULL', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('item') AND attname = 'char_field2'
        AND NOT attisdropped AND atttypid = 'text'::regtype AND NOT attnotnull)),
    ('customer.suspended boolean NOT NULL DEFAULT false', EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid
        AND d.adnum = a.attnum WHERE a.attrelid = to_regclass('customer') AND a.attname = 'suspended' AND NOT a.attisdropped
        AND a.atttypid = 'boolean'::regtype AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = 'false')),
    ('sales_profile.accurate_linked boolean NOT NULL DEFAULT false', EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d
        ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = to_regclass('sales_profile') AND a.attname = 'accurate_linked'
        AND NOT a.attisdropped AND a.atttypid = 'boolean'::regtype AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = 'false')),
    ('UNIQUE sales_profile.sales_code (satu karyawan <-> satu akun)', EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('sales_profile') AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (sales_code)')),
    ('tripwire: tidak ada grup websales.create + order.view tanpa order.create', NOT EXISTS (SELECT 1 FROM group_permission ws
        WHERE ws.permission_key = 'websales.create'
          AND EXISTS (SELECT 1 FROM group_permission v WHERE v.group_id = ws.group_id AND v.permission_key = 'order.view')
          AND NOT EXISTS (SELECT 1 FROM group_permission c WHERE c.group_id = ws.group_id AND c.permission_key = 'order.create'))),
    ('accapi_app boleh SELECT/INSERT/UPDATE kolom baru (sync + tautan)', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_column_privilege('accapi_app', k.t, k.c, p)) FROM (VALUES ('item', 'branch_id'), ('item', 'suspended'),
              ('item', 'char_field2'), ('customer', 'suspended'), ('sales_profile', 'accurate_linked')) AS k(t, c),
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p) END),
    ('accapi_app boleh SELECT/INSERT/UPDATE sales_profile (tautan salesman)', CASE
        WHEN to_regclass('sales_profile') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'sales_profile', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p) END),
    ('accapi_app boleh SELECT 4 tabel Form Kontrol (penjaga ganti kode sales)', CASE
        WHEN to_regclass('salesman_daily_report') IS NULL OR to_regclass('ao_control_daily') IS NULL
            OR to_regclass('merchandising_check') IS NULL OR to_regclass('jks_master') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, 'SELECT'))
              FROM unnest(ARRAY['salesman_daily_report', 'ao_control_daily', 'merchandising_check', 'jks_master']) AS t) END),
    ('accapi_app boleh INSERT permission_audit_log (jejak tautan)', CASE
        WHEN to_regclass('permission_audit_log') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN has_table_privilege('accapi_app', 'permission_audit_log', 'INSERT') END)
) AS v(cek, ok);
