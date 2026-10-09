-- DDL MANUAL ADR-004 rev 3.1 rilis A — accurate_write_attempt (+ _reopen): FK melingkar, immutability, REVOKE.
-- Rujukan: db/schema.ts (accurateWriteAttempt, accurateWriteAttemptReopen), scripts/migrate-pg.mjs (entri
-- accurate_write_attempt & accurate_write_attempt_reopen), ADR-004 di dokumen modernisasi (O5: siapa/kapan).
--
-- SIAPA & KAPAN (keputusan owner 9 Okt 2026): IT Support menjalankan SAAT DEPLOY S6-0a, sebagai role PEMILIK tabel
-- (bukan accapi_app), SESUDAH image baru hidup (migrate-pg membuat kedua tabel dalam bentuk final).
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_ADR004.sql
--
-- IDEMPOTEN untuk tiga keadaan awal (setiap langkah dijaga pg_constraint / pg_trigger / pg_indexes):
--   (a) tabel belum ada        -> semua langkah dilewati (NOTICE); jalankan image dulu, lalu ulangi berkas ini.
--   (b) definisi LAMA (B1 awal: index hidup 2 kolom, tanpa generasi; mis. DB evaluasi am040_push)
--       -> tambah kolom generasi + CHECK + UNIQUE identitas, tukar index (nama lama dipertahankan), buat tabel
--          reopen, lalu FK/trigger/REVOKE. Untuk keadaan ini berkas ini dijalankan SEBELUM image rilis A
--          (migrate-pg image baru akan crash bila tabel reopen dibuat terhadap definisi lama).
--   (c) definisi FINAL (dibuat migrate-pg image rilis A; = produksi) -> hanya FK melingkar, trigger, REVOKE.
-- Menjalankan ulang = tanpa perubahan.
--
-- YANG DIPASANG
--   1. FK melingkar attempt (reopen_id, operation, subject_key, generation, target_db_id) -> reopen (id, operation,
--      subject_key, to_generation, target_db_id). MATCH SIMPLE: baris generasi 0 (reopen_id NULL) tidak dicek.
--   2. Trigger accurate_write_attempt: UPDATE hanya transisi daftar putih (state final posted/rejected/not_sent/
--      resolved_absent tidak pernah berubah; kolom identitas tidak berubah; unknown -> posted|resolved_absent hanya
--      dengan resolution; resolved_absent selalu dengan resolution); DELETE & TRUNCATE ditolak.
--   3. Trigger accurate_write_attempt_reopen: INSERT hanya dari attempt posted dengan nomor/id lama yang SAMA;
--      UPDATE/DELETE/TRUNCATE ditolak.
--   4. REVOKE UPDATE, DELETE, TRUNCATE ON accurate_write_attempt_reopen FROM accapi_app (bila role ada).
--   Kode rilis A tidak pernah UPDATE baris posted / tidak menulis reopen, jadi trigger tidak mengubah perilakunya.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh: container accapi-am040-pg, DB am040_s6):
--   1) DB baru: drizzle-kit push + node scripts/migrate-pg.mjs (keadaan c), jalankan berkas ini DUA kali
--      (kedua kalinya tanpa perubahan), lalu blok VERIFIKASI di bawah harus semua ok = true.
--   2) AM040_DATABASE_URL=<url am040_s6> npx tsx --test lib/accurate-write-attempt.test.ts
--      -> semua lulus, termasuk uji "DDL manual ADR-004" (melewat bila berkas ini belum dijalankan di DB itu).
--
-- ROLLBACK DARURAT (hanya bila trigger menghalangi operasi sah; catat alasannya):
--   DROP TRIGGER IF EXISTS trg_accurate_write_attempt_guard ON accurate_write_attempt;  (dst. untuk 3 trigger lain)
--   FK & REVOKE boleh tetap. JANGAN drop tabel/kolom — jejak audit.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- (a) tabel belum ada -> lewati semuanya.
DO $$
BEGIN
    IF to_regclass('public.accurate_write_attempt') IS NULL THEN
        RAISE NOTICE 'ADR-004: accurate_write_attempt belum ada — jalankan image (migrate-pg) dulu, lalu ulangi berkas ini.';
    END IF;
END $$;

-- (b) definisi lama -> bentuk final (kolom, CHECK, UNIQUE identitas, tukar index dengan nama lama).
DO $$
BEGIN
    IF to_regclass('public.accurate_write_attempt') IS NULL THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'accurate_write_attempt' AND column_name = 'generation') THEN
        ALTER TABLE accurate_write_attempt ADD COLUMN generation integer NOT NULL DEFAULT 0;
        RAISE NOTICE 'ADR-004: kolom generation ditambahkan (definisi lama).';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'accurate_write_attempt' AND column_name = 'reopen_id') THEN
        ALTER TABLE accurate_write_attempt ADD COLUMN reopen_id text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.accurate_write_attempt'::regclass
                   AND conname = 'accurate_write_attempt_generation') THEN
        ALTER TABLE accurate_write_attempt ADD CONSTRAINT accurate_write_attempt_generation CHECK (generation >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.accurate_write_attempt'::regclass
                   AND conname = 'accurate_write_attempt_reopen_gen') THEN
        ALTER TABLE accurate_write_attempt ADD CONSTRAINT accurate_write_attempt_reopen_gen
            CHECK ((generation = 0) = (reopen_id IS NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.accurate_write_attempt'::regclass
                   AND conname = 'uq_accurate_write_attempt_identity') THEN
        ALTER TABLE accurate_write_attempt ADD CONSTRAINT uq_accurate_write_attempt_identity
            UNIQUE (id, operation, subject_key, generation, target_db_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_accurate_write_attempt_live'
                   AND indexdef LIKE '%generation%') THEN
        CREATE UNIQUE INDEX IF NOT EXISTS uq_accurate_write_attempt_live_gen
            ON accurate_write_attempt (operation, subject_key, generation) WHERE state IN ('sending', 'posted', 'unknown');
        DROP INDEX IF EXISTS uq_accurate_write_attempt_live;
        ALTER INDEX uq_accurate_write_attempt_live_gen RENAME TO uq_accurate_write_attempt_live;
        RAISE NOTICE 'ADR-004: index hidup ditukar ke (operation, subject_key, generation).';
    END IF;
END $$;

-- Tabel reopen (sama persis dengan entri migrate-pg; perlu di sini untuk keadaan b).
DO $$
BEGIN
    IF to_regclass('public.accurate_write_attempt') IS NULL OR to_regclass('public.accurate_write_attempt_reopen') IS NOT NULL THEN
        RETURN;
    END IF;
    CREATE TABLE accurate_write_attempt_reopen (
        id                  text PRIMARY KEY,
        operation           text NOT NULL,
        subject_key         text NOT NULL,
        from_attempt_id     text NOT NULL,
        target_db_id        text NOT NULL,
        actor               text NOT NULL,
        from_generation     integer NOT NULL,
        to_generation       integer NOT NULL,
        old_accurate_id     text NOT NULL DEFAULT '',
        old_accurate_number text NOT NULL DEFAULT '',
        reason              text NOT NULL,
        checked_source      text NOT NULL,
        verification        jsonb NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_accurate_write_attempt_reopen_generation UNIQUE (operation, subject_key, to_generation),
        CONSTRAINT uq_accurate_write_attempt_reopen_from UNIQUE (from_attempt_id),
        CONSTRAINT uq_accurate_write_attempt_reopen_identity UNIQUE (id, operation, subject_key, to_generation, target_db_id),
        CONSTRAINT fk_accurate_write_attempt_reopen_from
            FOREIGN KEY (from_attempt_id, operation, subject_key, from_generation, target_db_id)
            REFERENCES accurate_write_attempt (id, operation, subject_key, generation, target_db_id),
        CONSTRAINT accurate_write_attempt_reopen_from_generation CHECK (from_generation >= 0),
        CONSTRAINT accurate_write_attempt_reopen_to_generation CHECK (to_generation = from_generation + 1),
        CONSTRAINT accurate_write_attempt_reopen_old_ref CHECK (old_accurate_id <> '' OR old_accurate_number <> ''),
        CONSTRAINT accurate_write_attempt_reopen_reason CHECK (length(btrim(reason)) >= 15),
        CONSTRAINT accurate_write_attempt_reopen_checked_source CHECK (btrim(checked_source) <> ''),
        CONSTRAINT accurate_write_attempt_reopen_verification
            CHECK (coalesce(verification->>'method', '') IN ('manual_attestation', 'provider_readback'))
    );
    RAISE NOTICE 'ADR-004: tabel accurate_write_attempt_reopen dibuat (definisi lama).';
END $$;

-- 1. FK melingkar attempt -> reopen.
DO $$
BEGIN
    IF to_regclass('public.accurate_write_attempt_reopen') IS NULL THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.accurate_write_attempt'::regclass
                   AND conname = 'fk_accurate_write_attempt_reopen') THEN
        ALTER TABLE accurate_write_attempt ADD CONSTRAINT fk_accurate_write_attempt_reopen
            FOREIGN KEY (reopen_id, operation, subject_key, generation, target_db_id)
            REFERENCES accurate_write_attempt_reopen (id, operation, subject_key, to_generation, target_db_id);
    END IF;
END $$;

-- 2–3. Fungsi immutability (CREATE OR REPLACE = idempoten).
CREATE OR REPLACE FUNCTION accurate_write_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ADR-004: baris accurate_write_attempt % tidak boleh dihapus (jejak audit)', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.state IN ('posted', 'rejected', 'not_sent', 'resolved_absent') THEN
        RAISE EXCEPTION 'ADR-004: attempt % berstatus final % tidak boleh diubah', OLD.id, OLD.state
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.id, NEW.operation, NEW.subject_key, NEW.generation, NEW.reopen_id, NEW.target_db_id, NEW.actor, NEW.payload_hash, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.operation, OLD.subject_key, OLD.generation, OLD.reopen_id, OLD.target_db_id, OLD.actor, OLD.payload_hash, OLD.created_at) THEN
        RAISE EXCEPTION 'ADR-004: kolom identitas attempt % tidak boleh diubah', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.state = 'resolved_absent' AND NEW.resolution IS NULL THEN
        RAISE EXCEPTION 'ADR-004: resolved_absent wajib membawa resolution (attempt %)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = OLD.state OR OLD.state = 'sending' THEN
        RETURN NEW;
    END IF;
    IF OLD.state = 'unknown' AND NEW.state IN ('posted', 'resolved_absent') AND NEW.resolution IS NOT NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ADR-004: transisi attempt % dari % ke % tidak diizinkan', OLD.id, OLD.state, NEW.state
        USING ERRCODE = 'restrict_violation';
END $fn$;

CREATE OR REPLACE FUNCTION accurate_write_attempt_reopen_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
    a record;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'ADR-004: accurate_write_attempt_reopen immutable — % ditolak', TG_OP USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT state, accurate_id, accurate_number INTO a FROM accurate_write_attempt WHERE id = NEW.from_attempt_id;
    IF NOT FOUND OR a.state <> 'posted' THEN
        RAISE EXCEPTION 'ADR-004: reopen hanya dari attempt posted (%)', NEW.from_attempt_id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.old_accurate_id IS DISTINCT FROM a.accurate_id OR NEW.old_accurate_number IS DISTINCT FROM a.accurate_number THEN
        RAISE EXCEPTION 'ADR-004: nomor/id lama reopen harus sama dengan attempt asal %', NEW.from_attempt_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION accurate_write_attempt_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'ADR-004: % tidak boleh di-TRUNCATE (jejak audit)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $fn$;

DO $$
BEGIN
    IF to_regclass('public.accurate_write_attempt') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_guard'
                       AND tgrelid = 'public.accurate_write_attempt'::regclass) THEN
            CREATE TRIGGER trg_accurate_write_attempt_guard BEFORE UPDATE OR DELETE ON accurate_write_attempt
                FOR EACH ROW EXECUTE FUNCTION accurate_write_attempt_guard();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_no_truncate'
                       AND tgrelid = 'public.accurate_write_attempt'::regclass) THEN
            CREATE TRIGGER trg_accurate_write_attempt_no_truncate BEFORE TRUNCATE ON accurate_write_attempt
                FOR EACH STATEMENT EXECUTE FUNCTION accurate_write_attempt_no_truncate();
        END IF;
    END IF;
    IF to_regclass('public.accurate_write_attempt_reopen') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_reopen_guard'
                       AND tgrelid = 'public.accurate_write_attempt_reopen'::regclass) THEN
            CREATE TRIGGER trg_accurate_write_attempt_reopen_guard BEFORE INSERT OR UPDATE OR DELETE ON accurate_write_attempt_reopen
                FOR EACH ROW EXECUTE FUNCTION accurate_write_attempt_reopen_guard();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_reopen_no_truncate'
                       AND tgrelid = 'public.accurate_write_attempt_reopen'::regclass) THEN
            CREATE TRIGGER trg_accurate_write_attempt_reopen_no_truncate BEFORE TRUNCATE ON accurate_write_attempt_reopen
                FOR EACH STATEMENT EXECUTE FUNCTION accurate_write_attempt_no_truncate();
        END IF;
    END IF;
END $$;

-- 4. REVOKE lapis kedua (trigger = penjaga utama). Role absen = dilewati, bukan galat.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') AND to_regclass('public.accurate_write_attempt_reopen') IS NOT NULL THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON accurate_write_attempt_reopen FROM accapi_app;
    END IF;
END $$;

COMMIT;

-- ============================================================
-- VERIFIKASI (baca saja) — semua ok harus true; NULL = tidak berlaku (role accapi_app tidak ada)
-- ============================================================
SELECT cek, ok FROM (VALUES
    ('index hidup per generasi', (SELECT bool_or(indexdef LIKE '%(operation, subject_key, generation)%') FROM pg_indexes
                                   WHERE schemaname = 'public' AND indexname = 'uq_accurate_write_attempt_live')),
    ('UNIQUE identitas attempt', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_accurate_write_attempt_identity')),
    ('FK reopen -> attempt', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accurate_write_attempt_reopen_from')),
    ('FK melingkar attempt -> reopen', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accurate_write_attempt_reopen')),
    ('trigger attempt UPDATE/DELETE', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_guard')),
    ('trigger attempt TRUNCATE', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_no_truncate')),
    ('trigger reopen INSERT/UPDATE/DELETE', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_reopen_guard')),
    ('trigger reopen TRUNCATE', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_reopen_no_truncate')),
    ('accapi_app tanpa UPDATE/DELETE/TRUNCATE reopen', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        NOT (has_table_privilege('accapi_app', 'public.accurate_write_attempt_reopen', 'UPDATE')
          OR has_table_privilege('accapi_app', 'public.accurate_write_attempt_reopen', 'DELETE')
          OR has_table_privilege('accapi_app', 'public.accurate_write_attempt_reopen', 'TRUNCATE')) END),
    ('accapi_app boleh SELECT/INSERT/UPDATE attempt', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        has_table_privilege('accapi_app', 'public.accurate_write_attempt', 'SELECT')
        AND has_table_privilege('accapi_app', 'public.accurate_write_attempt', 'INSERT')
        AND has_table_privilege('accapi_app', 'public.accurate_write_attempt', 'UPDATE') END)
) AS v(cek, ok);
