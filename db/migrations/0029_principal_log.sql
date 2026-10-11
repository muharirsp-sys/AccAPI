-- =====================================================================
-- Riwayat principal / varian / alias APPEND-ONLY (S7-2 BL-64, 11 Okt 2026).
--
-- Satu baris per perubahan (buat, aktif, nonaktif, hapus alias), ditulis dalam transaksi
-- yang SAMA dengan perubahannya oleh lib/principal/tulis.ts (API /api/principals) dan benih SQL.
--   entitas : principal | varian | alias
--   kunci   : principal = id; varian = "<principal_id>:<variant_key>"; alias = id alias
--   before/after : isi baris sebelum/sesudah (jsonb), aktor = id user / "benih:S7-2".
-- Tanpa FK: riwayat bertahan apa pun yang terjadi pada barisnya.
-- Trigger tolak UPDATE/DELETE/TRUNCATE + REVOKE = docs/handover/DDL_S7_2.sql saja (pola repo:
-- trigger = DDL manual), bukan berkas ini. Jalur tulis menolak 503 bila trigger belum terpasang.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "principal_log") saat container start bila
-- DATABASE_MIGRATION_URL terpasang; selain itu docs/handover/DDL_S7_2.sql SEBELUM image baru. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0029_principal_log.sql
-- Idempoten dan aditif; tidak menyentuh data yang ada.
-- =====================================================================

CREATE TABLE IF NOT EXISTS principal_log (
    id           bigserial PRIMARY KEY,
    entitas      text NOT NULL,
    kunci        text NOT NULL,
    principal_id text NOT NULL,
    aksi         text NOT NULL,
    before       jsonb,
    after        jsonb,
    aktor        text NOT NULL,
    waktu        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT principal_log_entitas CHECK (entitas IN ('principal', 'varian', 'alias')),
    CONSTRAINT principal_log_aksi CHECK (aksi IN ('buat', 'aktif', 'nonaktif', 'hapus')),
    CONSTRAINT principal_log_aktor_isi CHECK (btrim(aktor) <> '')
);
CREATE INDEX IF NOT EXISTS idx_principal_log_principal ON principal_log (principal_id, id);
