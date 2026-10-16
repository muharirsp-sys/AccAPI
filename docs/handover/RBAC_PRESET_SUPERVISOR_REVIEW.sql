-- =====================================================================
-- Kunci izin Supervisor Review ke grup preset — owner 16 Okt 2026 (spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §3.4):
--   SPV     : supervisor_review.view   (cakupan = timnya, resolveScope)
--   SM      : supervisor_review.view   (cakupan = semua SPV + salesman bawahannya)
--   Manager : supervisor_review.view   (cakupan global)
--   Admin   : supervisor_review.view   (cakupan global)
-- Grup lain TIDAK diberi. Tidak ada grup yang diberi kunci lain oleh berkas ini. Tab Koordinat Toko + No HP Hierarki memakai
-- form_kontrol.manage yang sudah ada (tidak diubah di sini).
--
-- URUTAN (IT Support, D-17): SESUDAH image SR-1 terpasang (kunci harus sudah ada di registry aplikasi) dan SESUDAH
--   docs/handover/DDL_SUPERVISOR_REVIEW.sql + scripts/backfill-ringkas-faktur.mjs.
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_PRESET_SUPERVISOR_REVIEW.sql
--
-- Jaminan (pola RBAC_PRESET_NOO.sql / RBAC_PRESET_KASIR.sql):
--   * Grup dicari lewat NAMA persis. Grup yang tidak ada -> NOTICE + dilewati (tidak gagal).
--   * HANYA INSERT ... ON CONFLICT DO NOTHING ke group_permission: tidak menghapus/mengubah kunci lain, tidak membuat grup.
--   * Idempoten: jalan kedua = 0 izin, 0 audit.
--   * Jejak: satu baris permission_audit_log `group_permission.sync` per grup yang benar-benar bertambah kuncinya.
--   * scripts/seed-rbac-presets.ts TIDAK dipakai ke produksi untuk kunci ini.
--
-- Uji di DB sintetis: lib/supervisor-review/supervisor-review-pg.test.ts ("RBAC_PRESET_SUPERVISOR_REVIEW").
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
    g text;
BEGIN
    FOREACH g IN ARRAY ARRAY['SPV', 'SM', 'Manager', 'Admin'] LOOP
        IF NOT EXISTS (SELECT 1 FROM access_group WHERE name = g) THEN
            RAISE NOTICE 'Supervisor Review: grup "%" tidak ada — kunci supervisor_review.view untuknya dilewati.', g;
        END IF;
    END LOOP;
END $$;

WITH isi(grup, kunci) AS (VALUES
    ('SPV', 'supervisor_review.view'),
    ('SM', 'supervisor_review.view'),
    ('Manager', 'supervisor_review.view'),
    ('Admin', 'supervisor_review.view')
),
izin AS (
    INSERT INTO group_permission (group_id, permission_key)
    SELECT g.id, isi.kunci FROM isi JOIN access_group g ON g.name = isi.grup
    ON CONFLICT DO NOTHING
    RETURNING group_id, permission_key
),
jejak AS (
    INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
    SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_PRESET_SUPERVISOR_REVIEW', 'group_permission.sync', group_id,
           jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                              'sumber', 'docs/handover/RBAC_PRESET_SUPERVISOR_REVIEW.sql'), now()
    FROM izin GROUP BY group_id
    RETURNING target_group_id
)
SELECT (SELECT count(*) FROM izin) AS izin_disisipkan, (SELECT count(*) FROM jejak) AS audit;

COMMIT;
