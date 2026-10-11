-- =====================================================================
-- Preset grup BARU BL-37 (S7-1, matriks D-01 §B DISETUJUI owner 11 Okt 2026): Fakturist, Admin Incaso, Kasir, Admin Gudang.
--
-- Dijalankan IT Support (D-17), SATU KALI, sesudah image S7-1 terpasang (urutan tidak kritis: hanya data grup). Owner
-- 11 Okt K5: SQL INSERT terarah idempoten — `scripts/seed-rbac-presets.ts` TIDAK dipakai/diperluas (ia menghapus & mengisi
-- ulang izin 11 preset lama).
--
-- Jaminan:
--   * Grup yang SUDAH ADA dengan nama sama TIDAK disentuh sama sekali (ON CONFLICT (name) DO NOTHING; izin hanya disisipkan
--     untuk grup yang DIBUAT oleh pernyataan ini — CTE RETURNING). Grup lama lain tidak disentuh.
--   * Idempoten: jalan kedua = 0 baris berubah.
--   * Isi = PERSIS D-01 §B. Tidak satu pun memuat finance.resolve_unknown, finance.override_duplicate, order.resolve_unknown,
--     users.*, api_wrapper.* (D-14/D-18; Q2: Fakturist/Admin Incaso TIDAK diberi api_wrapper.view).
--   * is_preset = true aman terhadap seed-rbac-presets.ts: seed hanya memproses 11 nama di daftarnya sendiri (ON CONFLICT (name)
--     per nama itu) dan backfill ROLE_TO_GROUP ke 11 nama itu — empat grup ini tidak pernah dihapus/diisi ulang olehnya.
--     Efek is_preset di aplikasi S7-1: tidak bisa dihapus / diganti nama (deskripsi & izin tetap bisa diubah lewat layar).
--     Nama-nama ini TIDAK ada di peta role (GROUP_NAME_TO_ROLE) -> bintang pada grup ini tidak menurunkan user.role.
--   * Kasir: hanya dashboard.view sampai slice Kasir ↔ Incaso (BL-59) menambah kunci kasir.*.
--
-- Cara jalan (produksi, sesudah persetujuan):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_PRESET_BL37.sql
-- Uji di DB sintetis: lib/admin-otorisasi-pg.test.ts ("preset BL-37").
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

WITH isi(grup, kunci) AS (VALUES
    ('Fakturist', 'dashboard.view'), ('Fakturist', 'order.view'), ('Fakturist', 'order.create'), ('Fakturist', 'order.edit'),
    ('Fakturist', 'order.export'), ('Fakturist', 'sales_history.view'), ('Fakturist', 'principles.view'),
    ('Admin Incaso', 'dashboard.view'), ('Admin Incaso', 'pelunasan.kirim'), ('Admin Incaso', 'sales_history.view'),
    ('Kasir', 'dashboard.view'),
    ('Admin Gudang', 'dashboard.view'), ('Admin Gudang', 'rekapan_nota.view'), ('Admin Gudang', 'rekapan_nota.manage'),
    ('Admin Gudang', 'rekapan_nota.print'), ('Admin Gudang', 'rekapan_nota.approve_takeout'), ('Admin Gudang', 'order.view')
),
grup(nama, deskripsi) AS (VALUES
    ('Fakturist', 'Kirim faktur penjualan (Antrean) — preset BL-37, D-01 §B'),
    ('Admin Incaso', 'Kirim pelunasan ke Accurate — preset BL-37, D-01 §B'),
    ('Kasir', 'Kasir (kunci kasir.* menyusul slice Kasir/Incaso) — preset BL-37, D-01 §B'),
    ('Admin Gudang', 'Rekapan Nota + setujui take-out dengan alasan — preset BL-37, D-01 §B')
),
baru AS (
    INSERT INTO access_group (id, name, description, is_preset, created_at, updated_at)
    SELECT gen_random_uuid()::text, nama, deskripsi, true, now(), now() FROM grup
    ON CONFLICT (name) DO NOTHING
    RETURNING id, name
),
izin AS (
    INSERT INTO group_permission (group_id, permission_key)
    SELECT baru.id, isi.kunci FROM baru JOIN isi ON isi.grup = baru.name
    ON CONFLICT DO NOTHING
    RETURNING group_id
),
jejak AS (
    INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
    SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_PRESET_BL37', 'group.create', baru.id,
           jsonb_build_object('name', baru.name, 'preset', true, 'sumber', 'docs/handover/RBAC_PRESET_BL37.sql'), now()
    FROM baru
    RETURNING target_group_id
)
SELECT (SELECT count(*) FROM baru) AS grup_dibuat, (SELECT count(*) FROM izin) AS izin_disisipkan, (SELECT count(*) FROM jejak) AS audit;

COMMIT;

-- VERIFIKASI (baca-saja): tiap grup ada, preset, dan kuncinya PERSIS D-01 §B. `cocok = false` pada grup yang sudah ada
-- sebelum skrip ini = grup lama dengan nama sama (TIDAK disentuh) — laporkan ke owner, jangan diubah diam-diam.
WITH isi(grup, kunci) AS (VALUES
    ('Fakturist', 'dashboard.view'), ('Fakturist', 'order.view'), ('Fakturist', 'order.create'), ('Fakturist', 'order.edit'),
    ('Fakturist', 'order.export'), ('Fakturist', 'sales_history.view'), ('Fakturist', 'principles.view'),
    ('Admin Incaso', 'dashboard.view'), ('Admin Incaso', 'pelunasan.kirim'), ('Admin Incaso', 'sales_history.view'),
    ('Kasir', 'dashboard.view'),
    ('Admin Gudang', 'dashboard.view'), ('Admin Gudang', 'rekapan_nota.view'), ('Admin Gudang', 'rekapan_nota.manage'),
    ('Admin Gudang', 'rekapan_nota.print'), ('Admin Gudang', 'rekapan_nota.approve_takeout'), ('Admin Gudang', 'order.view')
)
SELECT n.grup, g.is_preset,
       coalesce((SELECT array_agg(permission_key ORDER BY permission_key) FROM group_permission WHERE group_id = g.id), '{}') AS kunci,
       coalesce((SELECT array_agg(permission_key ORDER BY permission_key) FROM group_permission WHERE group_id = g.id), '{}')
         = (SELECT array_agg(kunci ORDER BY kunci) FROM isi WHERE isi.grup = n.grup) AS cocok
FROM (SELECT DISTINCT grup FROM isi) n LEFT JOIN access_group g ON g.name = n.grup
ORDER BY n.grup;
