-- =====================================================================
-- Persetujuan Tax di Claim Workflow (owner 6 Nov 2026):
--   claim_workflow.tax_review : tim Tax menyetujui atau mengembalikan klaim ber-PPN/PPh. Surat, kwitansi, dan rekap klaim itu
--                               baru bisa dicetak Claim setelah disetujui. Kunci KAPABILITAS (centang modul tidak memberinya).
--   Grup "Tax" (dibuat bila belum ada): dashboard.view + claim_workflow.view + claim_workflow.tax_review. Grup "Admin": tax_review.
--
-- Dijalankan IT Support SATU KALI sesudah image dengan kunci ini terpasang. Idempoten (ON CONFLICT DO NOTHING; jalan kedua = 0 baris).
-- Hanya MENAMBAH grup/izin; tidak ada izin yang dicabut. Sesudahnya tambahkan anggota tim Tax ke grup "Tax" di /admin/groups.
--
-- Cara jalan (produksi, sesudah persetujuan):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_PRESET_CLAIM_TAX.sql
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

WITH baru AS (
    INSERT INTO access_group (id, name, description, is_preset, created_at, updated_at)
    VALUES (gen_random_uuid()::text, 'Tax', 'Periksa dan setujui PPN/PPh klaim sebelum dokumen dicetak (owner 6 Nov 2026)', true, now(), now())
    ON CONFLICT (name) DO NOTHING
    RETURNING id, name
)
INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_PRESET_CLAIM_TAX', 'group.create', id,
       jsonb_build_object('name', name, 'preset', true, 'sumber', 'docs/handover/RBAC_PRESET_CLAIM_TAX.sql'), now()
FROM baru;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM access_group WHERE name = 'Admin') THEN
        RAISE NOTICE 'Claim Tax: grup "Admin" tidak ada — izinnya dilewati.';
    END IF;
END $$;

WITH isi(grup, kunci) AS (VALUES
    ('Tax', 'dashboard.view'), ('Tax', 'claim_workflow.view'), ('Tax', 'claim_workflow.tax_review'),
    ('Admin', 'claim_workflow.tax_review')
),
izin AS (
    INSERT INTO group_permission (group_id, permission_key)
    SELECT g.id, isi.kunci FROM isi JOIN access_group g ON g.name = isi.grup
    ON CONFLICT DO NOTHING
    RETURNING group_id, permission_key
),
jejak AS (
    INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
    SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_PRESET_CLAIM_TAX', 'group_permission.sync', group_id,
           jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                              'sumber', 'docs/handover/RBAC_PRESET_CLAIM_TAX.sql'), now()
    FROM izin GROUP BY group_id
    RETURNING target_group_id
)
SELECT (SELECT count(*) FROM izin) AS izin_disisipkan, (SELECT count(*) FROM jejak) AS audit;

COMMIT;

-- VERIFIKASI (baca-saja)
SELECT n.grup, g.id IS NOT NULL AS ada,
       coalesce((SELECT array_agg(permission_key ORDER BY permission_key) FROM group_permission
                 WHERE group_id = g.id AND permission_key IN ('dashboard.view', 'claim_workflow.view', 'claim_workflow.tax_review')), '{}') AS kunci
FROM (VALUES ('Tax'), ('Admin')) AS n(grup) LEFT JOIN access_group g ON g.name = n.grup
ORDER BY n.grup;
