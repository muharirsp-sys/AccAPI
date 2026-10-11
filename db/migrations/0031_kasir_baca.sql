-- =====================================================================
-- Kasir ↔ Incaso (K1b, BL-59): status baca cache pelunasan per (database Accurate, tanggal).
--
--   kasir_pelunasan_baca : satu baris per (database_id, tanggal). Lease lintas instance = status 'berjalan' + token acak (kedaluwarsa
--                          2 menit menurut jam DB); setiap tulis cache memeriksa token (FOR SHARE) -> pembaca basi tak menimpa.
--                          lengkap ⇔ daftar list.do lengkap ∧ setiap id daftar ada di kasir_pelunasan dengan last_update sama ∧ tanpa
--                          pelunasan ditolak (bentuk/nominal/s:false). sebagian = batas waktu (klien memanggil lagi). gagal = sebab
--                          (kelas galat lib/kasir/pembaca KELAS_GALAT). lengkap_pada hanya maju (galat tidak memundurkannya).
-- Cache, bukan jejak: TANPA trigger. Hak accapi_app (SELECT/INSERT/UPDATE, tanpa DELETE) ada di docs/handover/DDL_K1B.sql.
-- Nomor 0031: SESUDAH 0030_principal_log.sql (S7-2 #160, merged); entri migrate-pg principal_log berjalan lebih dulu.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "kasir_pelunasan_baca (status baca K1b)") saat container start bila
-- DATABASE_MIGRATION_URL terpasang; selain itu docs/handover/DDL_K1B.sql SEBELUM image baru. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0031_kasir_baca.sql
-- Idempoten dan aditif; tidak menyentuh data yang ada.
-- =====================================================================

CREATE TABLE IF NOT EXISTS kasir_pelunasan_baca (
    database_id   text NOT NULL,
    tanggal       date NOT NULL,
    status        text NOT NULL,
    sebab         text,
    pesan         text,
    jumlah_daftar integer,
    sisa_detail   integer,
    ditolak       jsonb NOT NULL DEFAULT '[]'::jsonb,
    token         text,
    mulai_pada    timestamptz NOT NULL DEFAULT now(),
    selesai_pada  timestamptz,
    lengkap_pada  timestamptz,
    pemicu        text NOT NULL,
    akun_sinkron  text,
    penuh_tertunda_pada timestamptz,
    CONSTRAINT kasir_pelunasan_baca_pkey PRIMARY KEY (database_id, tanggal),
    CONSTRAINT kasir_pelunasan_baca_status CHECK (status IN ('berjalan', 'lengkap', 'sebagian', 'gagal')),
    CONSTRAINT kasir_pelunasan_baca_sebab CHECK (sebab IS NULL OR sebab IN ('sesi_sinkron', 'hak_akses', 'batas_laju', 'accurate_5xx',
        'jaringan', 'tidak_pasti', 'ditolak', 'bentuk', 'nominal', 'terpotong', 'hapus_massal')),
    CONSTRAINT kasir_pelunasan_baca_isi CHECK (btrim(database_id) <> '' AND btrim(pemicu) <> '' AND jsonb_typeof(ditolak) = 'array'
        AND jumlah_daftar >= 0 AND sisa_detail >= 0 AND sisa_detail <= jumlah_daftar),
    CONSTRAINT kasir_pelunasan_baca_konsisten CHECK ((status = 'gagal') = (sebab IS NOT NULL)
        AND (status = 'berjalan') = (token IS NOT NULL) AND (status = 'berjalan') = (selesai_pada IS NULL)
        AND (status <> 'lengkap' OR (coalesce(sisa_detail, -1) = 0 AND jumlah_daftar IS NOT NULL
            AND ditolak = '[]'::jsonb AND lengkap_pada IS NOT NULL)))
);
