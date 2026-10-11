-- =====================================================================
-- Kunci kasir.* ke grup preset (K1a BL-59; matriks D-01 §B disetujui owner 11 Okt 2026, catatan orkestrator 11 Okt):
--   Kasir : kasir.view, kasir.catat, kasir.tutup
--   OM    : kasir.view, kasir.buka   (buka kembali hari terkunci, alasan tercatat — kunci kapabilitas)
--   Admin : kasir.view, kasir.buka
-- Kasir TIDAK memegang kasir.buka; tidak ada grup yang diberi kunci lain oleh berkas ini.
--
-- URUTAN (IT Support, D-17; sesudah image K1a terpasang — kunci kasir.* harus sudah ada di registry aplikasi):
--   1. docs/handover/RBAC_PRESET_BL37.sql (S7-1) — membuat grup "Kasir".
--   2. berkas ini.
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_PRESET_KASIR.sql
--
-- Jaminan:
--   * Grup dicari lewat NAMA persis. Grup yang tidak ada -> NOTICE + dilewati (tidak gagal); jalankan ulang sesudah grupnya dibuat.
--   * HANYA INSERT ... ON CONFLICT DO NOTHING ke group_permission: tidak menghapus/mengubah kunci lain, tidak membuat grup.
--   * Idempoten: jalan kedua = 0 izin, 0 audit.
--   * Jejak: satu baris permission_audit_log `group_permission.sync` per grup yang benar-benar bertambah kuncinya.
--   * scripts/seed-rbac-presets.ts (bila dijalankan ulang) menghapus & mengisi ulang izin 11 preset lama: Admin tetap mendapat
--     semua kunci registry, tetapi OM kehilangan kasir.* -> jalankan ulang berkas ini sesudahnya.
--
-- Uji di DB sintetis: lib/kasir/skema-pg.test.ts ("RBAC_PRESET_KASIR").
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
    g text;
BEGIN
    FOREACH g IN ARRAY ARRAY['Kasir', 'OM', 'Admin'] LOOP
        IF NOT EXISTS (SELECT 1 FROM access_group WHERE name = g) THEN
            RAISE NOTICE 'K1a: grup "%" tidak ada — kunci kasir.* untuknya dilewati (grup Kasir dibuat RBAC_PRESET_BL37.sql; jalankan ulang berkas ini sesudahnya).', g;
        END IF;
    END LOOP;
END $$;

WITH isi(grup, kunci) AS (VALUES
    ('Kasir', 'kasir.view'), ('Kasir', 'kasir.catat'), ('Kasir', 'kasir.tutup'),
    ('OM', 'kasir.view'), ('OM', 'kasir.buka'),
    ('Admin', 'kasir.view'), ('Admin', 'kasir.buka')
),
izin AS (
    INSERT INTO group_permission (group_id, permission_key)
    SELECT g.id, isi.kunci FROM isi JOIN access_group g ON g.name = isi.grup
    ON CONFLICT DO NOTHING
    RETURNING group_id, permission_key
),
jejak AS (
    INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
    SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_PRESET_KASIR', 'group_permission.sync', group_id,
           jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                              'sumber', 'docs/handover/RBAC_PRESET_KASIR.sql'), now()
    FROM izin GROUP BY group_id
    RETURNING target_group_id
)
SELECT (SELECT count(*) FROM izin) AS izin_disisipkan, (SELECT count(*) FROM jejak) AS audit;

COMMIT;

-- LAPORAN (baca-saja): grup -> kunci kasir.* yang terpasang. `ada = false` = grup belum dibuat (lihat NOTICE di atas).
SELECT n.grup, g.id IS NOT NULL AS ada,
       coalesce((SELECT array_agg(permission_key ORDER BY permission_key) FROM group_permission
                 WHERE group_id = g.id AND permission_key LIKE 'kasir.%'), '{}') AS kunci_kasir
FROM (VALUES ('Kasir'), ('OM'), ('Admin')) AS n(grup) LEFT JOIN access_group g ON g.name = n.grup
ORDER BY n.grup;
