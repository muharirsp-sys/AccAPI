-- =====================================================================
-- S7-1b PENSIUN (AM-042; D-01 §D "Pensiunkan"): hapus kunci yang sudah keluar dari registry (= KUNCI_PENSIUN, lib/rbac/registry.ts)
-- dari group_permission. TIDAK dipetakan ke kunci granular / users.manage (memetakan = memperluas akses).
--   off_program_control.create, off_program_control.update, off_program_control.export,
--   users.create_user, users.edit_user, users.delete_user, users.set_role, users.set_permission
--   off_program_control.approve (S7-3: profil Beranda dari ★ grup utama; persetujuan SM ditegakkan sm_approve/sm_return).
--
-- URUTAN: SESUDAH image S7-3 (image sebelum S7-3 masih menebak profil Beranda SM dari off_program_control.approve). Berkas ini idempoten:
--   bila sudah dijalankan untuk S7-1b, jalan ulang hanya menghapus approve.
--   Sebelum berkas ini dijalankan, layar Akses Group tetap bisa disimpan (PATCH membuang kunci pensiun + mencatat `removed`).
-- MODE CEK (bawaan) = DIBATALKAN; ringkasan + VERIFIKASI tercetak lalu ERROR "S7-1b MODE CEK" (psql kode keluar 3 = yang diharapkan):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_S7_1B_PENSIUN.sql
-- TERAPKAN:
--   docker exec -i -e PGOPTIONS='-c rbac.terapkan=1' accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_S7_1B_PENSIUN.sql
--
-- Jaminan: HANYA DELETE baris kunci di daftar; idempoten (jalan kedua 0); satu baris permission_audit_log `group_permission.sync`
-- {added: [], removed, sumber} per grup yang kehilangan kunci. Uji: lib/rbac/s7-1b-pg.test.ts.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

WITH pensiun(kunci) AS (VALUES
    ('off_program_control.create'), ('off_program_control.update'), ('off_program_control.export'),
    ('users.create_user'), ('users.edit_user'), ('users.delete_user'), ('users.set_role'), ('users.set_permission'),
    ('off_program_control.approve')
),
hapus AS (
    DELETE FROM group_permission gp USING pensiun p
    WHERE gp.permission_key = p.kunci
    RETURNING gp.group_id, gp.permission_key
),
jejak AS (
    INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
    SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_S7_1B_PENSIUN', 'group_permission.sync', group_id,
           jsonb_build_object('added', '[]'::jsonb, 'removed', jsonb_agg(permission_key ORDER BY permission_key),
                              'sumber', 'docs/handover/RBAC_S7_1B_PENSIUN.sql'), now()
    FROM hapus GROUP BY group_id
    RETURNING target_group_id
)
SELECT (SELECT count(*) FROM hapus) AS izin_dihapus, (SELECT count(*) FROM jejak) AS audit;

-- VERIFIKASI (di dalam transaksi): sisa kunci pensiun harus 0.
SELECT 'VERIFIKASI' AS bagian, count(*) AS sisa_kunci_pensiun
FROM group_permission
WHERE permission_key IN ('off_program_control.create', 'off_program_control.update', 'off_program_control.export',
                         'users.create_user', 'users.edit_user', 'users.delete_user', 'users.set_role', 'users.set_permission',
                         'off_program_control.approve');

DO $$
BEGIN
    IF coalesce(current_setting('rbac.terapkan', true), '') <> '1' THEN
        RAISE EXCEPTION 'S7-1b MODE CEK: semua perubahan di atas DIBATALKAN (ROLLBACK). Terapkan dengan PGOPTIONS=''-c rbac.terapkan=1''.';
    END IF;
END $$;

COMMIT;
