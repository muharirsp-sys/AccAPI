-- =====================================================================
-- CEK BACA-SAJA S7-1 (BL-63): grup utama efektif vs user.role — untuk IT Support SEBELUM dan SESUDAH deploy S7-1
-- (peninjau S7-0 #4). Tidak mengubah apa pun. Jalankan sesudah DDL_S7_0.sql (kolom user_group.is_primary).
--   docker exec -i accapi-postgres psql -U accapi -d accapi < docs/handover/RBAC_S7_1_CEK_ROLE.sql
--
-- Grup utama efektif = grup berbintang; tanpa bintang dan user tepat 1 grup = grup itu (sama dengan getPrimaryGroup).
-- Peta role hanya untuk grup PRESET (is_preset) bernama di bawah (= GROUP_NAME_TO_ROLE, lib/rbac/otorisasi.ts).
-- Hasil TIDAK otomatis salah: role bisa sengaja berbeda (mis. diatur sebelum S7). Keputusan perbaikan = admin lewat layar
-- (tandai ulang bintang) atau owner; JANGAN ubah massal dari kueri ini.
-- Dibungkus transaksi READ ONLY yang di-ROLLBACK (tinjauan B #8): tulisan apa pun di dalamnya ditolak Postgres.
-- =====================================================================

BEGIN READ ONLY;

-- 1. User dengan grup utama PRESET berpeta yang user.role-nya BERBEDA dari peta.
WITH peta(nama, role) AS (VALUES
    ('Admin', 'admin'), ('Manager', 'manager'), ('Finance', 'finance'), ('Staff', 'staff'), ('Viewer', 'viewer'),
    ('SPV', 'spv'), ('SM', 'sm'), ('Claim', 'claim'), ('OM', 'om'), ('Salesman', 'salesman'), ('Admin Sales', 'admin_sales')
),
g AS (
    SELECT ug.user_id, ag.name, ag.is_preset, ug.is_primary, count(*) OVER (PARTITION BY ug.user_id) AS n
    FROM user_group ug JOIN access_group ag ON ag.id = ug.group_id
),
utama AS (
    SELECT DISTINCT ON (user_id) user_id, name, is_preset, is_primary
    FROM g WHERE is_primary OR n = 1 ORDER BY user_id, is_primary DESC
)
SELECT '1 role != peta grup utama' AS cek, u.email, u.role AS role_sekarang, ut.name AS grup_utama, ut.is_primary AS berbintang,
       p.role AS role_menurut_peta
FROM "user" u JOIN utama ut ON ut.user_id = u.id JOIN peta p ON p.nama = ut.name AND ut.is_preset
WHERE u.role IS DISTINCT FROM p.role
ORDER BY u.email;

-- 2. user.role = 'admin' TANPA grup utama preset Admin (identitas lama tertinggal: gerbang OPC/Claim/Form Kontrol berbasis role,
--    dan pickSyncUserId bila ACCURATE_SYNC_USER_ID kosong).
WITH g AS (
    SELECT ug.user_id, ag.name, ag.is_preset, ug.is_primary, count(*) OVER (PARTITION BY ug.user_id) AS n
    FROM user_group ug JOIN access_group ag ON ag.id = ug.group_id
),
utama AS (
    SELECT DISTINCT ON (user_id) user_id, name, is_preset FROM g WHERE is_primary OR n = 1 ORDER BY user_id, is_primary DESC
)
SELECT '2 role admin tanpa utama Admin' AS cek, u.email, coalesce(u.banned, false) AS banned, ut.name AS grup_utama,
       (SELECT string_agg(ag.name, ', ' ORDER BY ag.name) FROM user_group ug JOIN access_group ag ON ag.id = ug.group_id WHERE ug.user_id = u.id) AS semua_grup
FROM "user" u LEFT JOIN utama ut ON ut.user_id = u.id
WHERE u.role = 'admin' AND NOT (coalesce(ut.is_preset, false) AND ut.name = 'Admin')
ORDER BY u.email;

-- 3. User TANPA grup (akses = preset role lama; S7-1 menolak membuat keadaan ini, tetapi data lama bisa ada).
SELECT '3 tanpa grup' AS cek, u.email, u.role, coalesce(u.banned, false) AS banned
FROM "user" u WHERE NOT EXISTS (SELECT 1 FROM user_group ug WHERE ug.user_id = u.id)
ORDER BY u.email;

-- 4. User > 1 grup tanpa bintang (Beranda memakai fallback; role tidak diturunkan sampai admin menandai).
SELECT '4 >1 grup tanpa bintang' AS cek, u.email, u.role, count(*) AS jumlah_grup
FROM "user" u JOIN user_group ug ON ug.user_id = u.id
GROUP BY u.id, u.email, u.role HAVING count(*) > 1 AND NOT bool_or(ug.is_primary)
ORDER BY u.email;

ROLLBACK;
