-- =====================================================================
-- S7-1b PULIH — kembalikan kunci yang dihapus RBAC_S7_1B_PENSIUN.sql, dari jejaknya sendiri di permission_audit_log
-- (actor_name = 'SQL RBAC_S7_1B_PENSIUN', action = 'group_permission.sync', detail->'removed', target_group_id).
--
-- KAPAN: HANYA bila rilis Fiori di-ROLLBACK ke image lama SESUDAH PENSIUN terlanjur dijalankan (runbook §7 butir c). Image lama masih
--   membaca kunci pensiun (off_program_control.create/update/export dipakai OPC lama, users.* lama di layar User lama, profil Beranda).
--   JANGAN dijalankan selama image rilis (S7-1b) hidup: registry baru tidak mengenal kunci ini dan layar Akses Group baru membuangnya lagi
--   saat grup disimpan (tercatat `removed`).
-- Yang dipulihkan: pasangan (grup, kunci) dari SEMUA baris jejak PENSIUN, dibatasi ke daftar kunci pensiun (termasuk off_program_control.approve
--   bila S7-3 pernah ikut), hanya untuk grup yang masih ada. Kunci yang dibuang layar Akses Group baru (aktor = admin, bukan SQL) TIDAK ikut —
--   lihat permission_audit_log grup itu bila perlu.
--
-- MODE CEK (bawaan): semua perubahan DIBATALKAN — ringkasan (NOTICE) dan VERIFIKASI tercetak, lalu berhenti dengan
--   ERROR "S7-1b PULIH MODE CEK" (psql ON_ERROR_STOP keluar kode 3 = YANG DIHARAPKAN; transaksi di-ROLLBACK):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < RBAC_S7_1B_PULIH.sql
-- TERAPKAN:
--   docker exec -i -e PGOPTIONS='-c rbac.terapkan=1' accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < RBAC_S7_1B_PULIH.sql
--
-- Jaminan: HANYA INSERT ... ON CONFLICT DO NOTHING (tidak menghapus apa pun, tidak membuat grup); idempoten (jalan kedua 0 izin, 0 audit);
-- satu baris permission_audit_log `group_permission.sync` {added, removed: [], sumber} per grup yang benar-benar bertambah.
-- Uji (12 Okt, DB sekali-pakai): PENSIUN terapkan -> PULIH cek (0 tersimpan) -> PULIH terapkan (semua kembali) -> jalan kedua 0/0.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
    n_jejak bigint;
    n_izin bigint;
    n_audit bigint;
BEGIN
    SELECT count(*) INTO n_jejak FROM permission_audit_log
    WHERE actor_name = 'SQL RBAC_S7_1B_PENSIUN' AND action = 'group_permission.sync';
    IF n_jejak = 0 THEN
        RAISE NOTICE 'S7-1b PULIH: tidak ada jejak RBAC_S7_1B_PENSIUN — tidak ada yang dipulihkan.';
    END IF;

    WITH pensiun(kunci) AS (VALUES
        ('off_program_control.create'), ('off_program_control.update'), ('off_program_control.export'), ('off_program_control.approve'),
        ('users.create_user'), ('users.edit_user'), ('users.delete_user'), ('users.set_role'), ('users.set_permission')
    ),
    target AS (
        SELECT DISTINCT pal.target_group_id AS group_id, k.kunci
        FROM permission_audit_log pal
        CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(pal.detail->'removed') = 'array' THEN pal.detail->'removed' ELSE '[]'::jsonb END) AS k(kunci)
        JOIN pensiun p ON p.kunci = k.kunci
        JOIN access_group ag ON ag.id = pal.target_group_id
        WHERE pal.actor_name = 'SQL RBAC_S7_1B_PENSIUN' AND pal.action = 'group_permission.sync'
    ),
    izin AS (
        INSERT INTO group_permission (group_id, permission_key)
        SELECT group_id, kunci FROM target
        ON CONFLICT DO NOTHING
        RETURNING group_id, permission_key
    ),
    jejak AS (
        INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
        SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_S7_1B_PULIH', 'group_permission.sync', group_id,
               jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                                  'sumber', 'docs/handover/RBAC_S7_1B_PULIH.sql'), now()
        FROM izin GROUP BY group_id
        RETURNING target_group_id
    )
    SELECT (SELECT count(*) FROM izin), (SELECT count(*) FROM jejak) INTO n_izin, n_audit;

    RAISE NOTICE 'S7-1b PULIH: baris_jejak_pensiun=% izin_dipulihkan=% audit=%', n_jejak, n_izin, n_audit;
END $$;

-- VERIFIKASI (di dalam transaksi; mode cek = keadaan yang AKAN tersimpan): pasangan dari jejak PENSIUN yang BELUM kembali harus 0
-- (grup yang sudah dihapus tidak dihitung).
SELECT 'VERIFIKASI' AS bagian, 'pasangan grup-kunci dari jejak PENSIUN yang belum kembali (harus 0)' AS cek, count(*)::text AS nilai
FROM (
    SELECT DISTINCT pal.target_group_id, k.kunci
    FROM permission_audit_log pal
    CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(pal.detail->'removed') = 'array' THEN pal.detail->'removed' ELSE '[]'::jsonb END) AS k(kunci)
    JOIN access_group ag ON ag.id = pal.target_group_id
    WHERE pal.actor_name = 'SQL RBAC_S7_1B_PENSIUN' AND pal.action = 'group_permission.sync'
      AND k.kunci IN ('off_program_control.create', 'off_program_control.update', 'off_program_control.export', 'off_program_control.approve',
                      'users.create_user', 'users.edit_user', 'users.delete_user', 'users.set_role', 'users.set_permission')
      AND NOT EXISTS (SELECT 1 FROM group_permission gp WHERE gp.group_id = pal.target_group_id AND gp.permission_key = k.kunci)
) AS sisa
UNION ALL
SELECT 'VERIFIKASI', 'grup yang memegang kunci pensiun sesudah berkas ini',
       coalesce((SELECT string_agg(DISTINCT ag.name, ', ') FROM group_permission gp JOIN access_group ag ON ag.id = gp.group_id
                 WHERE gp.permission_key IN ('off_program_control.create', 'off_program_control.update', 'off_program_control.export',
                                             'users.create_user', 'users.edit_user', 'users.delete_user', 'users.set_role', 'users.set_permission')), '-');

-- Pengaman mode cek: tanpa rbac.terapkan=1 transaksi DIBATALKAN (COMMIT di bawah tidak tercapai / menjadi ROLLBACK).
DO $$
BEGIN
    IF coalesce(current_setting('rbac.terapkan', true), '') <> '1' THEN
        RAISE EXCEPTION 'S7-1b PULIH MODE CEK: semua perubahan di atas DIBATALKAN (ROLLBACK). Terapkan dengan PGOPTIONS=''-c rbac.terapkan=1''.';
    END IF;
END $$;

COMMIT;
