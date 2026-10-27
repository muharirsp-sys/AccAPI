-- =====================================================================
-- Jejak pencabutan APPEND-ONLY (audit desain 001 No 6 dan 18, owner 27 Okt 2026).
--
-- Satu baris per pencabutan keputusan manusia, ditulis dalam transaksi yang SAMA dengan DELETE-nya:
--   jenis      : nama tabel asal: invoice_verify_note (Verifikasi balik, Cabut) | order_dupe_ack (Order Principal, Cabut konfirmasi)
--   kunci      : invoice_verify_note = "<order_id>|<jenis>"; order_dupe_ack = "<principal>|<so_no>"
--   baris_lama : isi baris yang dicabut (jsonb, kunci camelCase properti db/schema)
--   alasan     : alasan wajib dari dialog (server menolak < 10 karakter sesudah trim)
--   oleh       : email sesi yang mencabut
-- Tanpa FK: jejak bertahan apa pun yang terjadi pada baris asal. Role aplikasi accapi_app hanya SELECT/INSERT (bila role itu ada).
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "pencabutan_log") saat container start bila DATABASE_MIGRATION_URL terpasang;
-- selain itu jalankan berkas ini sebagai role pemilik SEBELUM image baru:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0038_pencabutan_log.sql
-- Idempoten dan aditif; tidak menyentuh tabel lain.
-- =====================================================================

CREATE TABLE IF NOT EXISTS pencabutan_log (
    id          bigserial PRIMARY KEY,
    jenis       text NOT NULL,
    kunci       text NOT NULL,
    baris_lama  jsonb NOT NULL,
    alasan      text NOT NULL,
    oleh        text NOT NULL,
    waktu       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pencabutan_log_jenis CHECK (jenis IN ('invoice_verify_note', 'order_dupe_ack')),
    CONSTRAINT pencabutan_log_alasan CHECK (btrim(alasan) <> '')
);
CREATE INDEX IF NOT EXISTS idx_pencabutan_log_kunci ON pencabutan_log (jenis, kunci, id);
DO $pencabutan$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON pencabutan_log FROM accapi_app;
    GRANT SELECT, INSERT ON pencabutan_log TO accapi_app;
    GRANT USAGE, SELECT ON SEQUENCE pencabutan_log_id_seq TO accapi_app;
  END IF;
END $pencabutan$;
