-- =====================================================================
-- Kasir ↔ Incaso (K1a, BL-59; owner 11 Okt 2026): setoran per ORANG per hari, penjelasan selisih, event hari, cache pelunasan.
--
--   kasir_setoran          : append-only; koreksi = baris revisi n+1 yang menunjuk revisi n (tanggal + kode sama, FK komposit);
--                            tunai/transfer/giro numeric(18,2) >= 0; dicatat_oleh/pada.
--   kasir_selisih_catatan  : append-only; angka pelunasan/setoran saat dijelaskan (berubah = tidak berlaku); salesman_kode '' =
--                            "Tanpa salesman".
--   kasir_hari_event       : append-only; tutup / kunci (snapshot kunci otomatis 20.00 WITA) / buka (alasan >= 15).
--   kasir_pelunasan(+_faktur): cache sales-receipt berkolom sempit untuk K1b (TANPA raw_data); ditulis pembaca sistem saja.
-- Trigger append-only + REVOKE/GRANT ada di docs/handover/DDL_K1A.sql SAJA (pola repo: trigger = DDL manual), bukan di berkas ini.
-- Uang numeric(18,2): Postgres membulatkan > 2 desimal diam-diam -> aplikasi menulis lewat lib/kasir keSen/senKeTeks.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "kasir (setoran, catatan, hari, cache pelunasan)") saat container start bila
-- DATABASE_MIGRATION_URL terpasang; selain itu docs/handover/DDL_K1A.sql SEBELUM image baru. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0029_kasir.sql
-- Idempoten dan aditif; tidak menyentuh data yang ada.
-- =====================================================================

CREATE TABLE IF NOT EXISTS kasir_setoran (
    id                bigserial PRIMARY KEY,
    tanggal           date NOT NULL,
    salesman_kode     text NOT NULL,
    revisi            integer NOT NULL,
    revisi_sebelumnya integer,
    tunai             numeric(18,2) NOT NULL,
    transfer          numeric(18,2) NOT NULL,
    giro              numeric(18,2) NOT NULL,
    no_form_kasir     text,
    bukti_transfer    text,
    catatan           text,
    dicatat_oleh      text NOT NULL,
    dicatat_pada      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_kasir_setoran_revisi UNIQUE (tanggal, salesman_kode, revisi),
    CONSTRAINT kasir_setoran_revisi_sebelumnya_fk FOREIGN KEY (tanggal, salesman_kode, revisi_sebelumnya)
        REFERENCES kasir_setoran (tanggal, salesman_kode, revisi),
    CONSTRAINT kasir_setoran_rantai CHECK (revisi >= 1 AND revisi_sebelumnya IS NOT DISTINCT FROM nullif(revisi - 1, 0)),
    CONSTRAINT kasir_setoran_nominal CHECK (tunai >= 0 AND transfer >= 0 AND giro >= 0),
    CONSTRAINT kasir_setoran_kode CHECK (salesman_kode <> '' AND salesman_kode = btrim(salesman_kode)),
    CONSTRAINT kasir_setoran_teks CHECK (btrim(coalesce(no_form_kasir, '-')) <> '' AND btrim(coalesce(bukti_transfer, '-')) <> ''
        AND btrim(coalesce(catatan, '-')) <> ''),
    CONSTRAINT kasir_setoran_oleh CHECK (btrim(dicatat_oleh) <> '')
);

CREATE TABLE IF NOT EXISTS kasir_selisih_catatan (
    id            bigserial PRIMARY KEY,
    tanggal       date NOT NULL,
    salesman_kode text NOT NULL,
    pelunasan     numeric(18,2) NOT NULL,
    setoran       numeric(18,2) NOT NULL,
    penjelasan    text NOT NULL,
    tindak_lanjut text NOT NULL,
    dicatat_oleh  text NOT NULL,
    dicatat_pada  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kasir_selisih_catatan_kode CHECK (salesman_kode = btrim(salesman_kode)),
    CONSTRAINT kasir_selisih_catatan_setoran CHECK (setoran >= 0),
    CONSTRAINT kasir_selisih_catatan_penjelasan CHECK (char_length(btrim(penjelasan)) >= 15),
    CONSTRAINT kasir_selisih_catatan_tindak_lanjut CHECK (tindak_lanjut IN ('setor_susulan', 'koreksi_incaso', 'lapor_om')),
    CONSTRAINT kasir_selisih_catatan_oleh CHECK (btrim(dicatat_oleh) <> '')
);
CREATE INDEX IF NOT EXISTS idx_kasir_selisih_catatan_hari ON kasir_selisih_catatan (tanggal, salesman_kode);

CREATE TABLE IF NOT EXISTS kasir_hari_event (
    id       bigserial PRIMARY KEY,
    tanggal  date NOT NULL,
    jenis    text NOT NULL,
    alasan   text,
    snapshot jsonb,
    oleh     text NOT NULL,
    pada     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kasir_hari_event_jenis CHECK (jenis IN ('tutup', 'kunci', 'buka')),
    CONSTRAINT kasir_hari_event_alasan_buka CHECK (jenis <> 'buka' OR char_length(btrim(coalesce(alasan, ''))) >= 15),
    CONSTRAINT kasir_hari_event_snapshot CHECK ((jenis = 'buka') = (snapshot IS NULL)
        AND (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object')),
    CONSTRAINT kasir_hari_event_oleh CHECK (btrim(oleh) <> '')
);
CREATE INDEX IF NOT EXISTS idx_kasir_hari_event_tanggal ON kasir_hari_event (tanggal, id);

CREATE TABLE IF NOT EXISTS kasir_pelunasan (
    database_id   text NOT NULL,
    pelunasan_id  bigint NOT NULL,
    nomor         text NOT NULL,
    tanggal       date NOT NULL,
    metode        text NOT NULL,
    cheque_amount numeric(18,2) NOT NULL,
    last_update   text,
    dibaca_pada   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kasir_pelunasan_pkey PRIMARY KEY (database_id, pelunasan_id),
    CONSTRAINT kasir_pelunasan_isi CHECK (btrim(database_id) <> '' AND btrim(nomor) <> '' AND btrim(metode) <> '')
);
CREATE INDEX IF NOT EXISTS idx_kasir_pelunasan_tanggal ON kasir_pelunasan (database_id, tanggal);

CREATE TABLE IF NOT EXISTS kasir_pelunasan_faktur (
    database_id        text NOT NULL,
    pelunasan_id       bigint NOT NULL,
    faktur_id          bigint NOT NULL,
    nomor_faktur       text,
    master_salesman_id bigint,
    invoice_payment    numeric(18,2) NOT NULL,
    CONSTRAINT kasir_pelunasan_faktur_pkey PRIMARY KEY (database_id, pelunasan_id, faktur_id),
    CONSTRAINT kasir_pelunasan_faktur_pelunasan_fk FOREIGN KEY (database_id, pelunasan_id)
        REFERENCES kasir_pelunasan (database_id, pelunasan_id) ON DELETE CASCADE
);
