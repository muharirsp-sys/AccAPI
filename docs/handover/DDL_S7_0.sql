-- DDL MANUAL S7-0 — principal resmi + varian + alias (BL-64) dan grup utama user_group.is_primary (BL-63).
-- Rujukan: db/schema.ts (principal, principalVariant, principalAlias, userGroup.isPrimary), scripts/migrate-pg.mjs (entri
-- "principal (+variant, +alias)" + "user_group.is_primary" = SQL sama dengan blok 1-2 di bawah), db/migrations/0027_principal.sql,
-- db/migrations/0028_user_group_primary.sql, lib/skema-s7-0-pg.test.ts. Keputusan owner: scratch/fiori-intake/OWNER-ANSWERS-S7-2026-10-10.md
-- (11 Okt: tabel resmi + alias; KINO NON FOOD / Forisa MT-GT / Heinz HZ-BS = varian; bintang grup utama opsional, 1 grup = otomatis utama).
--
-- SIAPA & KAPAN (pola S6e-2, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY S7-0, sebagai
-- role PEMILIK tabel (accapi, bukan accapi_app), SEBELUM image baru di-deploy. JANGAN dijalankan oleh loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_S7_0.sql
--
-- KENAPA SEBELUM:
--   - Image baru (Drizzle) menyertakan kolom user_group.is_primary pada SETIAP INSERT user_group -> tanpa kolom, menambah anggota
--     grup / ganti grup gagal 500.
--   - migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app yang tak punya CREATE/ALTER -> CREATE
--     TABLE principal / ALTER TABLE user_group gagal -> container crash loop. Sesudah berkas ini, kedua entri di-SKIP (sudahAda).
--   - Image LAMA tidak terganggu (tabel baru tanpa pembaca + kolom ber-DEFAULT false). Catatan: route lama POST
--     /api/admin/users/[id]/group (hapus semua lalu sisipkan satu) menghapus bintang user itu — S7-1 mempensiunkannya.
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; ditulis begitu agar uji PG bisa memakai skema sekali-pakai):
--   1. CREATE TABLE/INDEX IF NOT EXISTS principal, principal_variant, principal_alias (aditif, TANPA benih — benih = S7-2).
--      1a: principal_alias bentuk lama 893f8cbf (PK alias_norm; hanya DB evaluasi) yang KOSONG di-DROP lalu dibuat ulang;
--      bila BERISI berkas berhenti (RAISE) tanpa mengubah apa pun.
--      1b: trigger trg_principal_code_tetap — UPDATE yang MENGUBAH principal.code ditolak (HANYA di berkas ini, bukan migrate-pg).
--   2. ADD COLUMN IF NOT EXISTS user_group.is_primary boolean NOT NULL DEFAULT false + indeks unik parsial (satu bintang per user).
--   3. GRANT SELECT, INSERT, UPDATE, DELETE ke accapi_app (bila role ada; default privileges L1g biasanya sudah memberi ini).
--   4. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan).
--   5. BACKFILL (bagian terpisah di akhir berkas, transaksi sendiri): user dengan TEPAT 1 grup -> grup itu berbintang.
--      Idempoten; tidak menyentuh user dengan > 1 grup atau yang sudah berbintang; TIDAK mengubah user.role.
-- Menjalankan ulang seluruh berkas = tanpa perubahan (kecuali user baru yang kini punya tepat 1 grup tanpa bintang — sesuai aturan owner).
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg, DB am040_s70):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/skema-s7-0-pg.test.ts
--
-- ROLLBACK DARURAT (hanya bila DDL menghalangi operasi sah; catat alasannya): image lama tetap jalan dengan objek ini.
--   DROP INDEX IF EXISTS uq_user_group_primary;   -- melepas batas satu bintang; kolom & tabel JANGAN di-drop selama image baru hidup.
--   DROP TRIGGER IF EXISTS trg_principal_code_tetap ON principal;   -- mengizinkan ganti kode (periksa rujukan OPC/Klaim dulu).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Principal resmi + varian + alias (sama dengan entri migrate-pg "principal (+variant, +alias)").
--    alias_norm WAJIB hasil normalizer baku S7-2 (lib/principal) — jangan diisi tangan dari normalizer lain.
CREATE TABLE IF NOT EXISTS principal (
    id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    code       text NOT NULL,
    name       text NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT principal_code_format CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
    CONSTRAINT principal_name_isi CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_code ON principal (code);
CREATE TABLE IF NOT EXISTS principal_variant (
    principal_id text NOT NULL,
    variant_key  text NOT NULL DEFAULT '',
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT principal_variant_pkey PRIMARY KEY (principal_id, variant_key),
    CONSTRAINT principal_variant_principal_fk FOREIGN KEY (principal_id) REFERENCES principal (id) ON DELETE RESTRICT,
    CONSTRAINT principal_variant_key_format CHECK (variant_key ~ '^[A-Z0-9_-]{0,20}$')
);
-- B-SEDANG-2: nama tampilan varian (opsional, mis. "KINO NON FOOD") + aktif. ALTER (bukan kolom CREATE TABLE) agar DB
-- yang sudah punya tabel varian bentuk 893f8cbf ikut lengkap dan urutan kolom sama di semua jalur.
ALTER TABLE principal_variant ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE principal_variant ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
-- Aturan kanonik varian (B-RENDAH; lintas baris -> tidak bisa CHECK, DITEGAKKAN S7-2 saat benih/tulis): alias untuk principal
-- UTUH = variant_key NULL (bukan ''); varian '' hanya "varian dasar" pada principal yang JUGA punya varian lain (KINO '' vs
-- NON_FOOD); principal tanpa varian lain tidak punya baris varian ''. no_claim_template.variant_key '' = principal utuh.
-- alias_norm = bentuk normal normalizer S7-2 (CHECK): HURUF BESAR, tanpa spasi tepi, spasi tunggal (tanda baca bebas).
-- 1a. Bentuk lama 893f8cbf (hanya pernah ada di DB evaluasi): principal_alias ber-PK alias_norm tanpa kolom id. KOSONG -> dihapus
--     lalu dibuat ulang di bawah dalam bentuk baru; BERISI -> berhenti (konversi manual, jangan DROP data).
DO $$
BEGIN
    IF to_regclass('principal_alias') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'principal_alias' AND column_name = 'id') THEN
        IF EXISTS (SELECT 1 FROM principal_alias) THEN
            RAISE EXCEPTION 'S7-0: principal_alias bentuk lama 893f8cbf BERISI — hentikan, konversi manual (jangan DROP data)';
        END IF;
        DROP TABLE principal_alias;
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS principal_alias (
    id           text NOT NULL DEFAULT gen_random_uuid()::text,
    alias_norm   text NOT NULL,
    principal_id text NOT NULL,
    variant_key  text,
    alias_asli   text NOT NULL,
    jenis        text NOT NULL,
    sumber       text NOT NULL,
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT principal_alias_pkey PRIMARY KEY (id),
    CONSTRAINT principal_alias_principal_fk FOREIGN KEY (principal_id) REFERENCES principal (id) ON DELETE RESTRICT,
    CONSTRAINT principal_alias_variant_fk FOREIGN KEY (principal_id, variant_key)
        REFERENCES principal_variant (principal_id, variant_key) ON DELETE RESTRICT,
    CONSTRAINT principal_alias_norm_bentuk CHECK (alias_norm = upper(alias_norm) AND alias_norm ~ '^[^[:space:]]+( [^[:space:]]+)*$'),
    CONSTRAINT principal_alias_asli_isi CHECK (btrim(alias_asli) <> ''),
    CONSTRAINT principal_alias_sumber_isi CHECK (btrim(sumber) <> ''),
    CONSTRAINT principal_alias_jenis CHECK (jenis IN
        ('nama', 'kode_master_barang', 'label_mapping', 'nama_bank', 'nama_summary', 'nama_surat'))
);
-- Unik per kelompok (B-SEDANG-1): kode Master Barang 2 karakter terpisah dari nama/label/kode OPC. Tabrakan nama yang
-- sah tetap DITOLAK (masuk laporan ambiguous S7-2) — JANGAN PERNAH ON CONFLICT DO UPDATE (alias diam-diam pindah principal).
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_alias_kode_mb ON principal_alias (alias_norm) WHERE jenis = 'kode_master_barang';
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_alias_nama ON principal_alias (alias_norm) WHERE jenis <> 'kode_master_barang';
CREATE INDEX IF NOT EXISTS idx_principal_alias_principal ON principal_alias (principal_id, variant_key);

-- 1b. principal.code TETAP (B-SEDANG-3). Kode = kunci teks tanpa FK di OPC/Klaim (off_batch/claim_workflow.principle_code)
--     dan no_claim_template.principle_code -> mengganti kode memutus rujukan diam-diam. Kode salah = principal baru (+ nonaktifkan
--     yang lama). Hanya di berkas ini (pola repo: trigger = DDL manual, tidak di migrate-pg). CREATE OR REPLACE = idempoten (PG14+).
CREATE OR REPLACE FUNCTION principal_code_tetap() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'S7-0: principal.code tidak boleh diubah (% -> %) — buat principal baru, jangan ganti kode', OLD.code, NEW.code
        USING ERRCODE = 'restrict_violation';
END $fn$;
CREATE OR REPLACE TRIGGER trg_principal_code_tetap BEFORE UPDATE OF code ON principal
    FOR EACH ROW WHEN (OLD.code IS DISTINCT FROM NEW.code) EXECUTE FUNCTION principal_code_tetap();

-- 2. Grup utama (sama dengan entri migrate-pg "user_group.is_primary"). DEFAULT false = tanpa rewrite tabel.
ALTER TABLE user_group ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_group_primary ON user_group (user_id) WHERE is_primary;

-- 3. Hak role aplikasi (DML penuh: S7-2 mengelola principal/varian/alias, S7-1 menandai bintang). Role absen = dilewati.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON principal, principal_variant, principal_alias, user_group TO accapi_app;
    END IF;
END $$;

COMMIT;

-- 4. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('tabel principal', to_regclass('principal') IS NOT NULL),
    ('tabel principal_variant', to_regclass('principal_variant') IS NOT NULL),
    ('tabel principal_alias', to_regclass('principal_alias') IS NOT NULL),
    ('indeks unik principal.code', EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('uq_principal_code') AND indisunique)),
    ('trigger principal.code tetap', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_principal_code_tetap'
        AND tgrelid = to_regclass('principal') AND NOT tgisinternal)),
    ('PK principal_alias = id (bukan alias_norm)', EXISTS (SELECT 1 FROM pg_index x JOIN pg_attribute a ON a.attrelid = x.indrelid
        AND a.attnum = ANY (x.indkey) WHERE x.indexrelid = to_regclass('principal_alias_pkey') AND x.indisprimary AND x.indnatts = 1
        AND a.attname = 'id')),
    ('unik alias kode Master Barang (parsial)', EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('uq_principal_alias_kode_mb')
        AND indisunique AND indpred IS NOT NULL)),
    ('unik alias nama/label/kode OPC (parsial)', EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('uq_principal_alias_nama')
        AND indisunique AND indpred IS NOT NULL)),
    ('kolom principal_variant.name + is_active NOT NULL DEFAULT true', (SELECT count(*) = 2 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'principal_variant'
          AND ((column_name = 'name' AND is_nullable = 'YES') OR (column_name = 'is_active' AND is_nullable = 'NO' AND column_default = 'true')))),
    ('kolom user_group.is_primary NOT NULL DEFAULT false', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'user_group' AND column_name = 'is_primary'
          AND is_nullable = 'NO' AND column_default = 'false')),
    ('indeks unik PARSIAL satu bintang per user', EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('uq_user_group_primary')
        AND indisunique AND indpred IS NOT NULL)),
    ('accapi_app boleh SELECT/INSERT/UPDATE/DELETE principal*', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, p))
              FROM unnest(ARRAY['principal', 'principal_variant', 'principal_alias']) AS t,
                   unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p) END),
    ('accapi_app boleh UPDATE user_group (bintang)', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN has_table_privilege('accapi_app', 'user_group', 'UPDATE') END)
) AS v(cek, ok);

-- ===== BACKFILL (jalankan sekali, sesudah DDL) =====
-- Owner 11 Okt: "user dengan 1 grup -> grup itu otomatis utama". Hanya user dengan TEPAT 1 baris user_group yang belum
-- berbintang. User dengan > 1 grup TIDAK disentuh (bintangnya keputusan admin di layar S7a); user yang sudah berbintang tidak
-- disentuh. TIDAK mengubah user.role (identitas lama, dipakai cron Accurate) — penurunan role dari bintang = logika S7-1.
-- Idempoten: jalan kedua memperbarui 0 baris. Batas satu bintang dijaga indeks uq_user_group_primary.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
UPDATE user_group SET is_primary = true
WHERE NOT is_primary
  AND user_id IN (SELECT user_id FROM user_group GROUP BY user_id HAVING count(*) = 1);
COMMIT;

-- Informasi untuk owner/admin: user dengan > 1 grup yang belum berbintang (Beranda memakai fallback sampai admin menandai).
SELECT count(*) AS user_lebih_dari_1_grup_tanpa_bintang FROM (
    SELECT user_id FROM user_group GROUP BY user_id HAVING count(*) > 1 AND NOT bool_or(is_primary)) AS x;

-- VERIFIKASI BACKFILL (baca-saja) — semua ok harus true.
SELECT cek, ok FROM (VALUES
    ('user tepat 1 grup tanpa bintang = 0', NOT EXISTS (SELECT 1 FROM user_group WHERE NOT is_primary
        AND user_id IN (SELECT user_id FROM user_group GROUP BY user_id HAVING count(*) = 1))),
    ('maks. satu bintang per user', NOT EXISTS (SELECT 1 FROM user_group WHERE is_primary GROUP BY user_id HAVING count(*) > 1))
) AS v(cek, ok);
