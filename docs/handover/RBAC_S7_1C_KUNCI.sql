-- =====================================================================
-- S7-1c KUNCI (PK-O1 baris 12–24; PK-2 owner 12 Okt "pertahankan akses").
-- Semantik tegakkan = kunci gerbang lama ∧ kunci baru (Python routers/finance.py, payments.py, summary.py + Next
-- POST /api/finance/purchase-payment). Berkas ini MEMBERI kunci baru ke SETIAP grup yang memegang kunci lamanya, jadi tidak ada yang
-- terkunci saat image S7-1c terpasang. Pemangkasan ke matriks D-01 = IT Support lewat layar Akses Group sesudahnya.
--   finance.update -> finance.post_accurate, finance.upload_proof, finance.transfer
--   finance.view   -> finance.export
--   payments.edit  -> payments.create, payments.upload, payments.submit, sppd.generate (render SPPD di cart/submit & submit)
--   payments.view  -> payments.export
--   summary.edit   -> summary.upload, summary.generate, summary.email
--   summary.view   -> summary.export (gerbang lama unduhan Summary = require_user = summary.view + pemilik berkas)
-- Semua kunci yang disisipkan sudah ada di registry image lama (origin/main lib/rbac/registry.ts) -> aman dijalankan SEBELUM image.
-- Preset legacy (user TANPA grup, lib/rbac.ts + python_backend/shared.py) ikut diperluas di kode S7-1c dengan aturan yang sama.
--
-- URUTAN DEPLOY (IT Support + orkestrator):
--   1. Cadangan DB (pg_dump group_permission + permission_audit_log).
--   2. BERKAS INI, mode cek lalu terapkan — SEBELUM image S7-1c.
--   3. Image S7-1c (merge PR atas perintah owner).
--
-- MODE CEK (bawaan): semua perubahan DIBATALKAN — ringkasan (NOTICE) dan VERIFIKASI tercetak, lalu berhenti dengan
--   ERROR "S7-1c MODE CEK" (psql ON_ERROR_STOP keluar kode 3 = YANG DIHARAPKAN; transaksi di-ROLLBACK):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_S7_1C_KUNCI.sql
-- TERAPKAN:
--   docker exec -i -e PGOPTIONS='-c rbac.terapkan=1' accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_S7_1C_KUNCI.sql
--
-- Jaminan: HANYA INSERT ... ON CONFLICT DO NOTHING (tidak menghapus/mengubah kunci lain, tidak membuat grup, tidak menyentuh
-- api_wrapper.* — PK-1); idempoten (jalan kedua 0 izin, 0 audit); satu baris permission_audit_log `group_permission.sync`
-- {added, removed: [], sumber} per grup yang benar-benar bertambah. Uji: lib/rbac/s7-1c-pg.test.ts.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
    n_izin bigint;
    n_audit bigint;
BEGIN
    WITH pasangan(lama, baru) AS (VALUES
        ('finance.update', 'finance.post_accurate'), ('finance.update', 'finance.upload_proof'), ('finance.update', 'finance.transfer'),
        ('finance.view', 'finance.export'),
        ('payments.edit', 'payments.create'), ('payments.edit', 'payments.upload'), ('payments.edit', 'payments.submit'),
        ('payments.edit', 'sppd.generate'),
        ('payments.view', 'payments.export'),
        ('summary.edit', 'summary.upload'), ('summary.edit', 'summary.generate'), ('summary.edit', 'summary.email'),
        ('summary.view', 'summary.export')
    ),
    izin AS (
        INSERT INTO group_permission (group_id, permission_key)
        SELECT DISTINCT gp.group_id, p.baru FROM group_permission gp JOIN pasangan p ON p.lama = gp.permission_key
        ON CONFLICT DO NOTHING
        RETURNING group_id, permission_key
    ),
    jejak AS (
        INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
        SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_S7_1C_KUNCI', 'group_permission.sync', group_id,
               jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                                  'sumber', 'docs/handover/RBAC_S7_1C_KUNCI.sql'), now()
        FROM izin GROUP BY group_id
        RETURNING target_group_id
    )
    SELECT (SELECT count(*) FROM izin), (SELECT count(*) FROM jejak) INTO n_izin, n_audit;

    RAISE NOTICE 'S7-1c KUNCI: izin_disisipkan=% audit=%', n_izin, n_audit;
END $$;

-- VERIFIKASI (di dalam transaksi; mode cek = keadaan yang AKAN tersimpan): grup pemegang kunci lama TANPA kunci barunya — harus 0 semua.
SELECT 'VERIFIKASI' AS bagian, p.lama || ' -> ' || p.baru AS cek,
       (SELECT count(*) FROM group_permission r WHERE r.permission_key = p.lama
          AND NOT EXISTS (SELECT 1 FROM group_permission e WHERE e.group_id = r.group_id AND e.permission_key = p.baru))::text AS nilai
FROM (VALUES
    ('finance.update', 'finance.post_accurate'), ('finance.update', 'finance.upload_proof'), ('finance.update', 'finance.transfer'),
    ('finance.view', 'finance.export'),
    ('payments.edit', 'payments.create'), ('payments.edit', 'payments.upload'), ('payments.edit', 'payments.submit'),
    ('payments.edit', 'sppd.generate'),
    ('payments.view', 'payments.export'),
    ('summary.edit', 'summary.upload'), ('summary.edit', 'summary.generate'), ('summary.edit', 'summary.email'),
    ('summary.view', 'summary.export')
) AS p(lama, baru)
ORDER BY 2;

-- Pengaman mode cek: tanpa rbac.terapkan=1 transaksi DIBATALKAN (COMMIT di bawah tidak tercapai / menjadi ROLLBACK).
DO $$
BEGIN
    IF coalesce(current_setting('rbac.terapkan', true), '') <> '1' THEN
        RAISE EXCEPTION 'S7-1c MODE CEK: semua perubahan di atas DIBATALKAN (ROLLBACK). Terapkan dengan PGOPTIONS=''-c rbac.terapkan=1''.';
    END IF;
END $$;

COMMIT;
