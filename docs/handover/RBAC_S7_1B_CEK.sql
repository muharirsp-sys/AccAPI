-- =====================================================================
-- CEK BACA-SAJA S7-1b (AM-042 nasib 31 kunci D-01 §D, AM-024 `api_wrapper.execute` di /api/proxy, AM-026 Manager OPC).
-- Untuk orkestrator/IT Support: SEBELUM owner menjawab PK-1 dan SEBELUM RBAC_S7_1B_KUNCI.sql; ulangi sesudah deploy (langkah 6).
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/RBAC_S7_1B_CEK.sql
--
-- Tidak mengubah apa pun: dibungkus transaksi READ ONLY yang di-ROLLBACK (tulisan apa pun ditolak Postgres).
-- Hanya kolom yang sudah ada di image main (TIDAK memakai user_group.is_primary DDL_S7_0) — aman dijalankan di produksi sekarang.
-- Kolom pertama `cek` = nomor bagian:
--   1  per grup: kunci dari 31 kunci D-01 §D yang dipegang + jumlah anggota.
--   2  per grup pemegang api_wrapper.view / api_wrapper.execute (PK-1) + anggota; `nasib_rilis` tanpa INSERT PK-1.
--   2b per USER aktif (gabungan semua grupnya): memegang api_wrapper.view TANPA api_wrapper.execute = kehilangan tulis Konsol saat rilis.
--   3  user AKTIF tanpa grup: akses = preset role lama (lib/rbac.ts), TIDAK terjangkau SQL (role admin/manager = execute legacy).
--   4  isi grup Manager (semua kunci) + apakah sudah memegang audit_read / audit_export (§C).
--   5  grup pemegang kunci pensiun (RBAC_S7_1B_PENSIUN.sql menghapusnya SESUDAH image; off_program_control.approve menunggu S7-3).
--   6  pasangan PK-2 (kunci gerbang lama -> kunci baru): grup yang akan mendapat kunci baru (1b = RBAC_S7_1B_KUNCI.sql, 1c = slice S7-1c).
-- Hasil = bahan keputusan owner (PK-1); JANGAN ubah massal dari kueri ini.
-- =====================================================================

BEGIN READ ONLY;

-- 1. Per grup: kunci dari 31 (urutan tabel brief S7-1b; nasib di lib/rbac/nasib-kunci.test.ts).
WITH k31(kunci) AS (VALUES
    ('api_wrapper.execute'), ('off_program_control.audit_export'),
    ('off_program_control.create'), ('off_program_control.update'), ('off_program_control.export'), ('off_program_control.approve'),
    ('users.create_user'), ('users.edit_user'), ('users.delete_user'), ('users.set_role'), ('users.set_permission'),
    ('finance.post_accurate'), ('finance.upload_proof'), ('finance.transfer'), ('finance.export'),
    ('payments.create'), ('payments.upload'), ('payments.submit'), ('payments.export'), ('sppd.generate'),
    ('summary.upload'), ('summary.generate'), ('summary.email'), ('summary.export'),
    ('insentif_sales.view_dashboard'),
    ('finance.approve'), ('finance.retry_post'), ('summary.update'), ('order.export'), ('sales_history.export'),
    ('finance.repost_payment')
)
SELECT '1 grup x 31 kunci' AS cek, ag.name AS grup, ag.is_preset AS preset,
       (SELECT count(*) FROM user_group ug WHERE ug.group_id = ag.id) AS anggota,
       (SELECT count(*) FROM group_permission gp JOIN k31 ON k31.kunci = gp.permission_key WHERE gp.group_id = ag.id) AS jumlah,
       coalesce((SELECT string_agg(gp.permission_key, ', ' ORDER BY gp.permission_key)
                 FROM group_permission gp JOIN k31 ON k31.kunci = gp.permission_key WHERE gp.group_id = ag.id), '-') AS kunci_dari_31
FROM access_group ag
ORDER BY ag.name;

-- 2. Per grup pemegang api_wrapper.* (PK-1). Tanpa INSERT PK-1: view tanpa execute = anggotanya kehilangan tulis Konsol
--    (sales-return, purchase-order, purchase-return, master data) KECUALI memegang execute lewat grup lain (lihat 2b).
WITH a AS (
    SELECT group_id, bool_or(permission_key = 'api_wrapper.view') AS v, bool_or(permission_key = 'api_wrapper.execute') AS x
    FROM group_permission WHERE permission_key IN ('api_wrapper.view', 'api_wrapper.execute') GROUP BY group_id
)
SELECT '2 api_wrapper per grup (PK-1)' AS cek, ag.name AS grup, a.v AS view, a.x AS execute,
       CASE WHEN a.v AND NOT a.x THEN 'view tanpa execute: KEHILANGAN tulis Konsol'
            WHEN a.x AND NOT a.v THEN 'execute tanpa view: tulis proxy tetap, halaman Konsol tertutup'
            ELSE 'tetap (view + execute)' END AS nasib_rilis,
       (SELECT count(*) FROM user_group ug WHERE ug.group_id = ag.id) AS anggota,
       coalesce((SELECT string_agg(u.name || ' <' || u.email || '>' || CASE WHEN coalesce(u.banned, false) THEN ' [nonaktif]' ELSE '' END,
                                   '; ' ORDER BY u.email)
                 FROM user_group ug JOIN "user" u ON u.id = ug.user_id WHERE ug.group_id = ag.id), '-') AS daftar_anggota
FROM a JOIN access_group ag ON ag.id = a.group_id
ORDER BY a.x, ag.name;

-- 2b. Per user AKTIF (gabungan grup = getUserPermissions): view tanpa execute.
SELECT '2b user kehilangan tulis Konsol' AS cek, u.name, u.email, u.role,
       string_agg(DISTINCT ag.name, ', ' ORDER BY ag.name) AS grup
FROM "user" u
JOIN user_group ug ON ug.user_id = u.id
JOIN access_group ag ON ag.id = ug.group_id
LEFT JOIN group_permission gp ON gp.group_id = ug.group_id AND gp.permission_key IN ('api_wrapper.view', 'api_wrapper.execute')
WHERE NOT coalesce(u.banned, false)
GROUP BY u.id, u.name, u.email, u.role
HAVING bool_or(gp.permission_key = 'api_wrapper.view') AND NOT coalesce(bool_or(gp.permission_key = 'api_wrapper.execute'), false)
ORDER BY u.email;

-- 3. User AKTIF tanpa grup (target 0): akses = preset role lama, tidak terjangkau SQL KUNCI/PENSIUN.
SELECT '3 aktif tanpa grup' AS cek, u.name, u.email, u.role,
       CASE WHEN u.role IN ('admin', 'manager') THEN 'preset lama: api_wrapper.view + execute' ELSE '-' END AS catatan
FROM "user" u
WHERE NOT coalesce(u.banned, false) AND NOT EXISTS (SELECT 1 FROM user_group ug WHERE ug.user_id = u.id)
ORDER BY u.email;

-- 4. Isi grup Manager. `ada = false` = tidak ada grup bernama persis "Manager".
SELECT '4 isi grup Manager' AS cek, n.nama AS grup, ag.id IS NOT NULL AS ada, ag.is_preset AS preset,
       (SELECT count(*) FROM user_group ug WHERE ug.group_id = ag.id) AS anggota,
       EXISTS (SELECT 1 FROM group_permission gp WHERE gp.group_id = ag.id AND gp.permission_key = 'off_program_control.audit_read') AS audit_read,
       EXISTS (SELECT 1 FROM group_permission gp WHERE gp.group_id = ag.id AND gp.permission_key = 'off_program_control.audit_export') AS audit_export,
       (SELECT count(*) FROM group_permission gp WHERE gp.group_id = ag.id) AS jumlah_kunci,
       coalesce((SELECT string_agg(gp.permission_key, ', ' ORDER BY gp.permission_key) FROM group_permission gp WHERE gp.group_id = ag.id), '-') AS kunci
FROM (VALUES ('Manager')) AS n(nama)
LEFT JOIN access_group ag ON ag.name = n.nama;

-- 5. Grup pemegang kunci pensiun (= KUNCI_PENSIUN lib/rbac/registry.ts + off_program_control.approve sesudah S7-3).
WITH p(kunci) AS (VALUES
    ('off_program_control.create'), ('off_program_control.update'), ('off_program_control.export'), ('off_program_control.approve'),
    ('users.create_user'), ('users.edit_user'), ('users.delete_user'), ('users.set_role'), ('users.set_permission')
)
SELECT '5 pemegang kunci pensiun' AS cek, ag.name AS grup, count(*) AS jumlah,
       string_agg(gp.permission_key, ', ' ORDER BY gp.permission_key) AS kunci_pensiun
FROM group_permission gp
JOIN p ON p.kunci = gp.permission_key
JOIN access_group ag ON ag.id = gp.group_id
GROUP BY ag.name
ORDER BY ag.name;

-- 6. Pasangan PK-2 (semantik tegakkan = lama ∧ baru; SQL memberi kunci baru ke pemegang kunci lama). `akan_diberi` = memegang lama, belum baru.
WITH pasangan(urut, slice, lama, baru) AS (VALUES
    (1, '1b', 'off_program_control.audit_read', 'off_program_control.audit_export'),
    (2, '1c', 'finance.update', 'finance.post_accurate'),
    (3, '1c', 'finance.update', 'finance.upload_proof'),
    (4, '1c', 'finance.update', 'finance.transfer'),
    (5, '1c', 'finance.view', 'finance.export'),
    (6, '1c', 'payments.edit', 'payments.create'),
    (7, '1c', 'payments.edit', 'payments.upload'),
    (8, '1c', 'payments.edit', 'payments.submit'),
    (9, '1c', 'payments.view', 'payments.export'),
    (10, '1c', 'payments.edit', 'sppd.generate'),
    (11, '1c', 'summary.edit', 'summary.upload'),
    (12, '1c', 'summary.edit', 'summary.generate'),
    (13, '1c', 'summary.edit', 'summary.email'),
    (14, '1c', 'summary.edit', 'summary.export')
),
calon AS (
    SELECT p.urut, ag.name
    FROM pasangan p
    JOIN group_permission l ON l.permission_key = p.lama
    JOIN access_group ag ON ag.id = l.group_id
    WHERE NOT EXISTS (SELECT 1 FROM group_permission b WHERE b.group_id = l.group_id AND b.permission_key = p.baru)
)
SELECT '6 pasangan PK-2' AS cek, p.slice, p.lama || ' -> ' || p.baru AS pasangan,
       (SELECT count(*) FROM group_permission b WHERE b.permission_key = p.baru) AS sudah_punya_baru,
       (SELECT count(*) FROM calon c WHERE c.urut = p.urut) AS akan_diberi,
       coalesce((SELECT string_agg(c.name, ', ' ORDER BY c.name) FROM calon c WHERE c.urut = p.urut), '-') AS grup_akan_diberi
FROM pasangan p
ORDER BY p.urut;

ROLLBACK;
