-- DDL MANUAL S6-0d — invoice_outbox_event append-only (BL-17 + R6) + E5 data lama antrean faktur dikunci TIDAK PASTI.
-- Rujukan: db/schema.ts (invoiceOutboxEvent), scripts/migrate-pg.mjs (entri `invoice_outbox_event` = pembuatan tabel),
-- scratch/fiori-intake/S6-0d-PERTENTANGAN-2026-10-09.md §E5/§F (keputusan owner 9 Okt 2026), lib/invoice-outbox-event.test.ts.
--
-- SIAPA & KAPAN: IT Support, SAAT DEPLOY S6-0d, sebagai role PEMILIK tabel (bukan accapi_app), SESUDAH image baru hidup
-- (migrate-pg membuat invoice_outbox_event). JANGAN dijalankan oleh loop/agen ke produksi.
-- WAJIB dijalankan SEBELUM `ACCURATE_INVOICE_SEND=on` dan SEBELUM tombol Kirim dipakai setelah deploy: E5 (d) mengembalikan
-- antrean hasil "antre ulang" versi lama (tanpa pencarian) ke Ditolak — tanpa itu Kirim/cron mengirimnya tanpa pencarian.
-- E5 = pembersihan data LAMA, dijalankan SEKALI saat deploy S6-0d. Predikat E5 (a) `rejected` lebih lebar daripada keluaran
-- klasifikasi baru (mis. penolakan beramplop ["…"] dari 5xx lama tidak terbedakan, dan last_error bukan-amplop apa pun
-- dikunci): menjalankannya lagi kemudian hanya menambah baris tidak pasti yang harus diselesaikan manusia (aman, tapi bukan
-- tanpa biaya). Bagian trigger/REVOKE/GRANT boleh diulang kapan saja.
--
-- PRASYARAT: tabel invoice_outbox_event dibuat migrate-pg saat container start. Role aplikasi (accapi_app) BUKAN owner dan
-- tidak boleh DDL (runbook L1g) -> SEBELUM deploy pastikan `DATABASE_MIGRATION_URL` (role ber-hak DDL) terpasang di Coolify,
-- ATAU jalankan dulu SQL entri `invoice_outbox_event` dari scripts/migrate-pg.mjs sebagai role owner. Tanpa salah satunya
-- migrate-pg gagal dan container tidak hidup (sengaja: kode butuh tabelnya).
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_OUTBOX_EVENT.sql
--
-- KENAPA MANUAL: scripts/migrate-pg.mjs hanya boleh berisi perubahan aditif — "JANGAN: UPDATE/DELETE data" (kepala berkas itu).
-- E5 mengubah status baris lama, dan trigger/REVOKE mengikuti pola DDL_ADR004.sql (S6-0a). Bila owner memutuskan E5 harus
-- otomatis saat container start, blok E5 di bawah bisa dipindah apa adanya ke entri migrate-pg (idempoten).
--
-- IDEMPOTEN (satu transaksi; menjalankan ulang = tanpa perubahan):
--   (a) invoice_outbox_event belum ada -> semua langkah dilewati (NOTICE); jalankan image dulu, lalu ulangi berkas ini.
--   (b) sudah ada -> trigger/REVOKE dipasang bila belum; E5 hanya menyentuh baris yang MASIH cocok (yang sudah unknown tidak).
--
-- YANG DIPASANG
--   1. Trigger invoice_outbox_event: UPDATE & DELETE ditolak per baris; TRUNCATE ditolak. INSERT bebas (append-only).
--   2. REVOKE UPDATE, DELETE, TRUNCATE ON invoice_outbox_event FROM accapi_app; GRANT SELECT, INSERT + USAGE sequence
--      (bila role ada) — aplikasi hanya menambah riwayat.
--   3. E5 (owner 9 Okt): baris antrean yang statusnya tidak bisa dipercaya dikunci TIDAK PASTI + event `unknown`
--      (aktor `ddl:E5`, salinan last_error/accurate_id/attempts di detail):
--        - `rejected` dengan last_error BUKAN amplop penolakan Accurate `["…"]` (mis. {"message":"Bad Gateway"},
--          {"error":"invalid_token"} — dulu semua JSON tanpa s:true dianggap Ditolak dan boleh dikirim ulang);
--        - `posted` tanpa accurate_id (verifikasi balik tidak mungkin);
--        - `sending` yang tidak berubah > 15 menit. `sending` yang lebih muda = sedang dikirim proses hidup; mengubahnya
--          di sini akan membuang jawaban sah yang sedang datang — itu tugas penyapu (lib/invoice-sender.sapuSending).
--      (d) `queued` dengan attempts > 0 = pernah dikirim lalu "antre ulang" versi lama TANPA pencarian faktur -> `rejected`
--          + event `rejected` (aktor `ddl:E5`; last_error amplop ["E5: …"]). Antre ulang berikutnya (kode S6-0d) MENCARI
--          dulu. Dikecualikan: baris yang event terakhirnya `antre_ulang`/`antre` membawa hasil pencarian (sudah dicari).
--      Produksi 9 Okt (§G): 0 baris seperti ini — pagar, bukan perbaikan.
--      Batas yang diketahui: penolakan 5xx beramplop `["…"]` (dulu rejected, kini unknown) tidak terbedakan dari
--      last_error saja; status HTTP lama tidak pernah disimpan (§G: tidak ada pola 5xx di produksi).
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh: container accapi-am040-pg, DB am040_s6):
--   AM040_DATABASE_URL=<url am040_s6> npx tsx --test lib/invoice-outbox-event.test.ts
--   -> uji "DDL manual" menjalankan berkas ini DUA kali (kedua kalinya tanpa perubahan) + blok VERIFIKASI semua ok.
--
-- ROLLBACK DARURAT (hanya bila trigger menghalangi operasi sah; catat alasannya):
--   DROP TRIGGER IF EXISTS trg_invoice_outbox_event_guard ON invoice_outbox_event;
--   DROP TRIGGER IF EXISTS trg_invoice_outbox_event_no_truncate ON invoice_outbox_event;
--   E5 TIDAK di-rollback otomatis: baris yang dikunci diselesaikan lewat "Selesaikan tidak pasti" (pencarian faktur,
--   izin order.resolve_unknown) — riwayat `ddl:E5` menyimpan status & last_error lamanya.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
    IF to_regclass('public.invoice_outbox_event') IS NULL THEN
        RAISE NOTICE 'S6-0d: invoice_outbox_event belum ada — jalankan image (migrate-pg) dulu, lalu ulangi berkas ini.';
    END IF;
END $$;

-- 1. Append-only (CREATE OR REPLACE = idempoten).
CREATE OR REPLACE FUNCTION invoice_outbox_event_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'S6-0d: invoice_outbox_event append-only — % ditolak (riwayat antrean faktur)', TG_OP
        USING ERRCODE = 'restrict_violation';
END $fn$;

DO $$
BEGIN
    IF to_regclass('public.invoice_outbox_event') IS NULL THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoice_outbox_event_guard'
                   AND tgrelid = 'public.invoice_outbox_event'::regclass) THEN
        CREATE TRIGGER trg_invoice_outbox_event_guard BEFORE UPDATE OR DELETE ON invoice_outbox_event
            FOR EACH ROW EXECUTE FUNCTION invoice_outbox_event_guard();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoice_outbox_event_no_truncate'
                   AND tgrelid = 'public.invoice_outbox_event'::regclass) THEN
        CREATE TRIGGER trg_invoice_outbox_event_no_truncate BEFORE TRUNCATE ON invoice_outbox_event
            FOR EACH STATEMENT EXECUTE FUNCTION invoice_outbox_event_guard();
    END IF;
END $$;

-- 2. Hak role aplikasi: tambah & baca saja. Role absen = dilewati, bukan galat.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') AND to_regclass('public.invoice_outbox_event') IS NOT NULL THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON invoice_outbox_event FROM accapi_app;
        GRANT SELECT, INSERT ON invoice_outbox_event TO accapi_app;
        GRANT USAGE, SELECT ON SEQUENCE invoice_outbox_event_id_seq TO accapi_app;
    END IF;
END $$;

-- 3. E5: data lama dikunci TIDAK PASTI + event. Satu pernyataan (CTE): tidak ada baris berubah tanpa jejak.
DO $$
DECLARE
    dikunci integer;
BEGIN
    IF to_regclass('public.invoice_outbox') IS NULL OR to_regclass('public.invoice_outbox_event') IS NULL THEN RETURN; END IF;
    WITH sasaran AS (
        SELECT order_id, state, last_error, accurate_id, attempts, updated_at,
               CASE
                   WHEN state = 'sending' THEN 'E5: tertahan "mengirim" > 15 menit (data lama)'
                   WHEN state = 'posted' THEN 'E5: terposting tanpa accurate_id — tidak bisa diverifikasi'
                   ELSE 'E5: "Ditolak" tanpa amplop penolakan Accurate — belum terbukti tidak tersimpan'
               END AS sebab
        FROM invoice_outbox
        WHERE (state = 'sending' AND updated_at < now() - interval '15 minutes')
           OR (state = 'posted' AND btrim(accurate_id) = '')
           OR (state = 'rejected' AND btrim(last_error) !~ '^\["')
        FOR UPDATE
    ), catat AS (
        INSERT INTO invoice_outbox_event (order_id, jenis, state_from, state_to, actor, reason, detail)
        SELECT order_id, 'unknown', state, 'unknown', 'ddl:E5', sebab,
               jsonb_build_object('last_error', last_error, 'accurate_id', accurate_id, 'attempts', attempts,
                                  'updated_at', updated_at)
        FROM sasaran
    ), kunci AS (
        UPDATE invoice_outbox o
           SET state = 'unknown', updated_at = now(),
               last_error = left(s.sebab || '. Cari fakturnya di Accurate (Selesaikan tidak pasti); jangan dikirim ulang. '
                                 || 'Sebelumnya: ' || o.last_error, 1000)
          FROM sasaran s
         WHERE o.order_id = s.order_id
        RETURNING o.order_id
    )
    SELECT count(*) INTO dikunci FROM kunci;
    RAISE NOTICE 'S6-0d E5: % baris antrean dikunci TIDAK PASTI.', dikunci;

    -- (d) antre ulang versi lama -> Ditolak (bukan tidak pasti: Accurate memang menjawab dan menolak percobaan terakhirnya).
    WITH sasaran AS (
        SELECT o.order_id, o.attempts, o.last_error, o.updated_at
        FROM invoice_outbox o
        WHERE o.state = 'queued' AND o.attempts > 0
          AND NOT EXISTS (
              SELECT 1 FROM (
                  SELECT e.jenis, e.detail FROM invoice_outbox_event e
                  WHERE e.order_id = o.order_id ORDER BY e.created_at DESC, e.id DESC LIMIT 1
              ) terakhir
              WHERE terakhir.jenis IN ('antre_ulang', 'antre') AND terakhir.detail ? 'pencarian')
        FOR UPDATE OF o
    ), catat AS (
        INSERT INTO invoice_outbox_event (order_id, jenis, state_from, state_to, actor, reason, detail)
        SELECT order_id, 'rejected', 'queued', 'rejected', 'ddl:E5',
               'E5: antre ulang versi lama tanpa pencarian faktur — kembali ke Ditolak',
               jsonb_build_object('last_error', last_error, 'attempts', attempts, 'updated_at', updated_at)
        FROM sasaran
    ), kembali AS (
        UPDATE invoice_outbox o
           SET state = 'rejected', updated_at = now(),
               last_error = left(jsonb_build_array('E5: diantre ulang tanpa pencarian faktur (versi lama) — antre ulang lagi '
                                 || 'agar faktur dicari dulu di Accurate. Sebelumnya: ' || o.last_error)::text, 1000)
          FROM sasaran s
         WHERE o.order_id = s.order_id
        RETURNING o.order_id
    )
    SELECT count(*) INTO dikunci FROM kembali;
    RAISE NOTICE 'S6-0d E5 (d): % baris antre ulang versi lama dikembalikan ke Ditolak.', dikunci;
END $$;

COMMIT;

-- ============================================================
-- VERIFIKASI (baca saja) — semua ok harus true; NULL = tidak berlaku (role accapi_app atau tabel tidak ada).
-- ============================================================
SELECT cek, ok FROM (VALUES
    ('tabel invoice_outbox_event ada', to_regclass('public.invoice_outbox_event') IS NOT NULL),
    ('trigger UPDATE/DELETE', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoice_outbox_event_guard')),
    ('trigger TRUNCATE', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoice_outbox_event_no_truncate')),
    ('accapi_app tanpa UPDATE/DELETE/TRUNCATE event', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        AND to_regclass('public.invoice_outbox_event') IS NOT NULL THEN
        NOT (has_table_privilege('accapi_app', 'public.invoice_outbox_event', 'UPDATE')
          OR has_table_privilege('accapi_app', 'public.invoice_outbox_event', 'DELETE')
          OR has_table_privilege('accapi_app', 'public.invoice_outbox_event', 'TRUNCATE')) END),
    ('accapi_app boleh SELECT/INSERT event', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        AND to_regclass('public.invoice_outbox_event') IS NOT NULL THEN
        has_table_privilege('accapi_app', 'public.invoice_outbox_event', 'SELECT')
        AND has_table_privilege('accapi_app', 'public.invoice_outbox_event', 'INSERT') END),
    ('E5: tidak ada lagi baris lama yang meragukan', CASE WHEN to_regclass('public.invoice_outbox') IS NOT NULL THEN
        NOT EXISTS (SELECT 1 FROM invoice_outbox
                    WHERE (state = 'sending' AND updated_at < now() - interval '15 minutes')
                       OR (state = 'posted' AND btrim(accurate_id) = '')
                       OR (state = 'rejected' AND btrim(last_error) !~ '^\["')) END),
    ('E5 (d): tidak ada antre ulang lama tanpa pencarian', CASE WHEN to_regclass('public.invoice_outbox_event') IS NOT NULL THEN
        NOT EXISTS (SELECT 1 FROM invoice_outbox o WHERE o.state = 'queued' AND o.attempts > 0
                    AND NOT EXISTS (SELECT 1 FROM (SELECT e.jenis, e.detail FROM invoice_outbox_event e WHERE e.order_id = o.order_id
                                                   ORDER BY e.created_at DESC, e.id DESC LIMIT 1) t
                                    WHERE t.jenis IN ('antre_ulang', 'antre') AND t.detail ? 'pencarian')) END)
) AS v(cek, ok);
