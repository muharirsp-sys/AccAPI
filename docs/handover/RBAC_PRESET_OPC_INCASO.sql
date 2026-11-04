-- =====================================================================
-- Izin OPC baru (owner 3 Nov 2026):
--   off_program_control.potong_tagihan : item ber-cara bayar Potong Tagihan dicatat Incaso dengan nomor faktur (bukan Keuangan).
--                                        Grup "Admin Incaso" + "Admin". Admin Incaso juga butuh off_program_control.view
--                                        untuk membuka OFF Program Control (tab Potong Tagihan).
--   off_program_control.pantau_sales   : halaman /off-program-control/pantau, salesman melihat pengajuan principal profilnya.
--                                        Grup "Salesman" + "Admin".
--
-- Dijalankan IT Support SATU KALI sesudah image dengan kunci ini terpasang (urutan tidak kritis: hanya data izin).
-- Idempoten (ON CONFLICT DO NOTHING; jalan kedua = 0 baris). Hanya MENAMBAH izin ke grup yang sudah ada; grup yang belum ada
-- dilewati dengan NOTICE (Admin Incaso dibuat RBAC_PRESET_BL37.sql). Tidak ada izin yang dicabut.
--
-- Peran OPC Incaso berasal dari grup utama (bintang) "Admin Incaso" -> user.role "admin_incaso" (GROUP_NAME_TO_ROLE, rilis ini).
-- Anggota yang sudah berbintang SEBELUM rilis ini: bintang ulang grupnya di /admin/groups agar role-nya diturunkan.
--
-- Cara jalan (produksi, sesudah persetujuan):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_PRESET_OPC_INCASO.sql
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
    g text;
BEGIN
    FOREACH g IN ARRAY ARRAY['Admin Incaso', 'Salesman', 'Admin'] LOOP
        IF NOT EXISTS (SELECT 1 FROM access_group WHERE name = g) THEN
            RAISE NOTICE 'OPC Incaso: grup "%" tidak ada — izinnya dilewati.', g;
        END IF;
    END LOOP;
END $$;

WITH isi(grup, kunci) AS (VALUES
    ('Admin Incaso', 'off_program_control.view'), ('Admin Incaso', 'off_program_control.potong_tagihan'),
    ('Salesman', 'off_program_control.pantau_sales'),
    ('Admin', 'off_program_control.potong_tagihan'), ('Admin', 'off_program_control.pantau_sales')
),
izin AS (
    INSERT INTO group_permission (group_id, permission_key)
    SELECT g.id, isi.kunci FROM isi JOIN access_group g ON g.name = isi.grup
    ON CONFLICT DO NOTHING
    RETURNING group_id, permission_key
),
jejak AS (
    INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
    SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_PRESET_OPC_INCASO', 'group_permission.sync', group_id,
           jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                              'sumber', 'docs/handover/RBAC_PRESET_OPC_INCASO.sql'), now()
    FROM izin GROUP BY group_id
    RETURNING target_group_id
)
SELECT (SELECT count(*) FROM izin) AS izin_disisipkan, (SELECT count(*) FROM jejak) AS audit;

COMMIT;

-- VERIFIKASI (baca-saja)
SELECT n.grup, g.id IS NOT NULL AS ada,
       coalesce((SELECT array_agg(permission_key ORDER BY permission_key) FROM group_permission
                 WHERE group_id = g.id AND permission_key IN ('off_program_control.view', 'off_program_control.potong_tagihan',
                                                              'off_program_control.pantau_sales')), '{}') AS kunci
FROM (VALUES ('Admin Incaso'), ('Salesman'), ('Admin')) AS n(grup) LEFT JOIN access_group g ON g.name = n.grup
ORDER BY n.grup;
