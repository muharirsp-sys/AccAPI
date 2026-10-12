-- =====================================================================
-- S7-1b KUNCI (AM-042 / AM-024 / AM-026; D-01 §C-§D disetujui owner 11 Okt; PK-2 owner 12 Okt "pertahankan akses").
-- Semantik tegakkan = kunci gerbang lama ∧ kunci baru. Berkas ini MEMBERI kunci baru ke grup yang memegang kunci lama, jadi tidak ada
-- yang terkunci saat image S7-1b terpasang. Pemangkasan ke target D-01 = IT Support lewat layar Akses Group sesudah audit D-17 (baris 8).
--   (1) pasangan PK-2 baris 2 : setiap grup ber-off_program_control.audit_read  -> + off_program_control.audit_export
--   (2) D-01 §C Manager       : grup bernama persis "Manager"                   -> + off_program_control.audit_read, audit_export
--   (3) PK-1 api_wrapper.execute: owner 12 Okt "biarkan seperti sekarang" — berkas ini TIDAK menulis api_wrapper.* sama sekali.
-- Semua kunci yang disisipkan sudah ada di registry image lama (origin/main lib/rbac/registry.ts) -> aman dijalankan SEBELUM image.
--
-- URUTAN DEPLOY (IT Support + orkestrator):
--   1. Prasyarat: DDL lebih dulu; RBAC_PRESET_BL37.sql -> RBAC_PRESET_KASIR.sql.
--   2. RBAC_S7_1B_CEK.sql (baca-saja) di produksi — dijalankan 12 Okt; owner menjawab PK-1 = biarkan (lihat blok PK-1 di bawah).
--   3. BERKAS INI, mode cek lalu terapkan — SEBELUM image S7-1b.
--   4. Image S7-1b.  5. RBAC_S7_1B_PENSIUN.sql (mode cek -> terapkan) SESUDAH image.  6. RBAC_S7_1B_CEK.sql ulang.
--
-- MODE CEK (bawaan): semua perubahan DIBATALKAN — ringkasan (NOTICE) dan VERIFIKASI tercetak, lalu berhenti dengan
--   ERROR "S7-1b MODE CEK" (psql ON_ERROR_STOP keluar kode 3 = YANG DIHARAPKAN; transaksi di-ROLLBACK):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_S7_1B_KUNCI.sql
-- TERAPKAN:
--   docker exec -i -e PGOPTIONS='-c rbac.terapkan=1' accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_S7_1B_KUNCI.sql
--
-- Jaminan: grup lewat NAMA persis; grup absen = NOTICE + dilewati; HANYA INSERT ... ON CONFLICT DO NOTHING (tidak menghapus/mengubah kunci
-- lain, tidak membuat grup); idempoten (jalan kedua 0 izin, 0 audit); satu baris permission_audit_log `group_permission.sync`
-- {added, removed: [], sumber} per grup yang benar-benar bertambah. Uji: lib/rbac/s7-1b-pg.test.ts.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ===== PK-1 (owner 12 Okt, sesudah RBAC_S7_1B_CEK.sql baca-saja di produksi): "BIARKAN SEPERTI SEKARANG".
-- Fakta produksi 12 Okt: pemegang api_wrapper.view = Admin (4 anggota), Fakturist (2), Manager (1) — KETIGANYA sudah memegang
-- api_wrapper.execute; CEK bagian 2b (kehilangan tulis Konsol) dan 3 (user aktif tanpa grup) = 0 baris. Maka berkas ini TIDAK
-- memuat INSERT/DELETE api_wrapper.* apa pun; pemegang execute tetap, tidak ada yang kehilangan tulis Konsol saat rilis.
-- ===== akhir PK-1

DO $$
DECLARE
    g text;
    n_izin bigint;
    n_audit bigint;
BEGIN
    FOREACH g IN ARRAY ARRAY['Manager'] LOOP
        IF NOT EXISTS (SELECT 1 FROM access_group WHERE name = g) THEN
            RAISE NOTICE 'S7-1b: grup "%" tidak ada — kuncinya dilewati (periksa ejaan / buat grup lalu jalankan ulang).', g;
        END IF;
    END LOOP;

    WITH target(group_id, kunci) AS (
        SELECT gp.group_id, 'off_program_control.audit_export'
        FROM group_permission gp WHERE gp.permission_key = 'off_program_control.audit_read'
        UNION
        SELECT ag.id, k.kunci FROM access_group ag
        CROSS JOIN (VALUES ('off_program_control.audit_read'), ('off_program_control.audit_export')) AS k(kunci)
        WHERE ag.name = 'Manager'
    ),
    izin AS (
        INSERT INTO group_permission (group_id, permission_key)
        SELECT group_id, kunci FROM target
        ON CONFLICT DO NOTHING
        RETURNING group_id, permission_key
    ),
    jejak AS (
        INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
        SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_S7_1B_KUNCI', 'group_permission.sync', group_id,
               jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                                  'sumber', 'docs/handover/RBAC_S7_1B_KUNCI.sql'), now()
        FROM izin GROUP BY group_id
        RETURNING target_group_id
    )
    SELECT (SELECT count(*) FROM izin), (SELECT count(*) FROM jejak) INTO n_izin, n_audit;

    RAISE NOTICE 'S7-1b KUNCI: izin_disisipkan=% audit=%', n_izin, n_audit;
END $$;

-- VERIFIKASI (di dalam transaksi; mode cek = keadaan yang AKAN tersimpan).
SELECT 'VERIFIKASI' AS bagian, 'audit_read tanpa audit_export' AS cek,
       (SELECT count(*) FROM group_permission r WHERE r.permission_key = 'off_program_control.audit_read'
          AND NOT EXISTS (SELECT 1 FROM group_permission e WHERE e.group_id = r.group_id AND e.permission_key = 'off_program_control.audit_export'))::text AS nilai
UNION ALL
SELECT 'VERIFIKASI', 'Manager audit_read+audit_export',
       coalesce((SELECT (count(*) FILTER (WHERE gp.permission_key IN ('off_program_control.audit_read', 'off_program_control.audit_export')) = 2)::text
                 FROM access_group ag LEFT JOIN group_permission gp ON gp.group_id = ag.id WHERE ag.name = 'Manager' GROUP BY ag.id), 'grup Manager tidak ada')
UNION ALL
SELECT 'VERIFIKASI', 'pemegang api_wrapper.execute (tidak diubah berkas ini)',
       coalesce((SELECT string_agg(ag.name, ', ' ORDER BY ag.name) FROM group_permission gp JOIN access_group ag ON ag.id = gp.group_id
                 WHERE gp.permission_key = 'api_wrapper.execute'), '-');

-- Pengaman mode cek: tanpa rbac.terapkan=1 transaksi DIBATALKAN (COMMIT di bawah tidak tercapai / menjadi ROLLBACK).
DO $$
BEGIN
    IF coalesce(current_setting('rbac.terapkan', true), '') <> '1' THEN
        RAISE EXCEPTION 'S7-1b MODE CEK: semua perubahan di atas DIBATALKAN (ROLLBACK). Terapkan dengan PGOPTIONS=''-c rbac.terapkan=1''.';
    END IF;
END $$;

COMMIT;
