-- =====================================================================
-- Kunci izin NOO (toko baru) ke grup preset — jawaban owner 13 Okt 2026 (P2) + keputusan 13 Okt malam:
--   SPV   : form_kontrol.noo_setujui              (setujui/tolak NOO tim + lihat KTP lengkap NOO tim)
--   SM    : form_kontrol.noo_setujui              (menyetujui bila SPV berhalangan + lihat KTP lengkap: NOO di bawah SPV bawahannya)
--   Admin : form_kontrol.noo_setujui, form_kontrol.noo_ktp, form_kontrol.noo_tautkan
--           (noo_ktp = KAPABILITAS lihat KTP lengkap semua NOO, dicatat audit; noo_tautkan = KAPABILITAS tautkan NOO ke pelanggan Accurate)
-- Admin Sales dan Manager TIDAK diberi (owner: Admin Sales tidak melihat KTP; HANYA grup Admin yang menautkan). Manager tetap MELIHAT
-- daftar/rincian NOO lewat form_kontrol.manage yang sudah ada di presetnya. Tidak ada grup yang diberi kunci lain oleh berkas ini.
--
-- URUTAN (IT Support, D-17): SESUDAH image NOO terpasang (kunci harus sudah ada di registry aplikasi) dan SESUDAH docs/handover/DDL_NOO.sql.
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_PRESET_NOO.sql
--
-- Jaminan (pola RBAC_PRESET_KASIR.sql):
--   * Grup dicari lewat NAMA persis. Grup yang tidak ada -> NOTICE + dilewati (tidak gagal).
--   * HANYA INSERT ... ON CONFLICT DO NOTHING ke group_permission: tidak menghapus/mengubah kunci lain, tidak membuat grup.
--   * Idempoten: jalan kedua = 0 izin, 0 audit.
--   * Jejak: satu baris permission_audit_log `group_permission.sync` per grup yang benar-benar bertambah kuncinya.
--   * scripts/seed-rbac-presets.ts (bila dijalankan ulang) mengisi ulang 11 preset dari definisinya (SPV/SM memuat noo_setujui; Admin semua
--     kunci registry) — berkas ini tetap aman dijalankan sesudahnya.
--
-- Uji di DB sintetis: lib/form-kontrol/noo-pg.test.ts ("RBAC_PRESET_NOO").
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
    g text;
BEGIN
    FOREACH g IN ARRAY ARRAY['SPV', 'SM', 'Admin'] LOOP
        IF NOT EXISTS (SELECT 1 FROM access_group WHERE name = g) THEN
            RAISE NOTICE 'NOO: grup "%" tidak ada — kunci form_kontrol.noo_* untuknya dilewati.', g;
        END IF;
    END LOOP;
END $$;

WITH isi(grup, kunci) AS (VALUES
    ('SPV', 'form_kontrol.noo_setujui'),
    ('SM', 'form_kontrol.noo_setujui'),
    ('Admin', 'form_kontrol.noo_setujui'), ('Admin', 'form_kontrol.noo_ktp'), ('Admin', 'form_kontrol.noo_tautkan')
),
izin AS (
    INSERT INTO group_permission (group_id, permission_key)
    SELECT g.id, isi.kunci FROM isi JOIN access_group g ON g.name = isi.grup
    ON CONFLICT DO NOTHING
    RETURNING group_id, permission_key
),
jejak AS (
    INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
    SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_PRESET_NOO', 'group_permission.sync', group_id,
           jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                              'sumber', 'docs/handover/RBAC_PRESET_NOO.sql'), now()
    FROM izin GROUP BY group_id
    RETURNING target_group_id
)
SELECT (SELECT count(*) FROM izin) AS izin_disisipkan, (SELECT count(*) FROM jejak) AS audit;

COMMIT;
