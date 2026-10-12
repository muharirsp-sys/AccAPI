-- =====================================================================
-- S7-1b PULIH — kembalikan kunci pensiun yang hilang pada SIKLUS RILIS TERAKHIR, dari permission_audit_log (detail->'removed'):
--   (1) jejak RBAC_S7_1B_PENSIUN.sql (actor_name = 'SQL RBAC_S7_1B_PENSIUN'), dan
--   (2) jejak PATCH layar Akses Group image S7-1b (actor_user_id terisi): route itu MEMBUANG kunci pensiun dari setiap simpan
--       (app/api/admin/groups/[id]/route.ts:55-57) — pembuangan otomatis, bukan keputusan admin (kunci pensiun tidak tampil di layar baru).
--   PATCH image LAMA tidak pernah menulis `removed` (hanya keyCount), dan berkas KUNCI/D-01/PULIH menulis removed: [] -> tidak terbaca di sini.
-- SIKLUS TERAKHIR = jejak yang dibuat SESUDAH jalan PULIH terakhir yang memulihkan sesuatu (baris 'SQL RBAC_S7_1B_PULIH'); tanpa PULIH
--   sebelumnya = semua jejak. Jadi rollback ganda (rilis -> rollback -> PULIH -> rilis ulang -> rollback) tidak memulihkan kunci yang
--   SENGAJA dicabut admin di antara dua siklus.
--
-- KAPAN: HANYA bila rilis Fiori di-ROLLBACK ke image lama SESUDAH kunci pensiun terlanjur hilang (runbook §7 butir c). Image lama masih
--   membaca kunci pensiun (off_program_control.create/update/export di OPC lama, users.* lama di layar User lama). JANGAN dijalankan selama
--   image S7-1b hidup: registry baru tidak mengenal kunci ini dan layar baru membuangnya lagi saat grup disimpan.
-- Dibatasi ke daftar kunci pensiun S7-1b + off_program_control.approve (hanya pernah dihapus bila S7-3 ikut), dan grup yang masih ada.
-- BATAS: created_at bertipe timestamp tanpa zona; jejak SQL memakai now() pada zona sesi Postgres, jejak aplikasi memakai waktu UTC dari
--   Node. Pada server ber-TimeZone UTC (bawaan image postgres) keduanya sama; NOTICE mencetak TimeZone. Bila bukan UTC dan siklus ulang
--   terjadi < 8 jam sesudah PULIH sebelumnya, periksa daftar NOTICE secara manual.
--
-- MODE CEK (bawaan): semua perubahan DIBATALKAN — ringkasan (NOTICE) dan VERIFIKASI tercetak, lalu berhenti dengan
--   ERROR "S7-1b PULIH MODE CEK" (psql ON_ERROR_STOP keluar kode 3 = YANG DIHARAPKAN; transaksi di-ROLLBACK):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < RBAC_S7_1B_PULIH.sql
-- TERAPKAN:
--   docker exec -i -e PGOPTIONS='-c rbac.terapkan=1' accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < RBAC_S7_1B_PULIH.sql
--
-- Jaminan: HANYA INSERT ... ON CONFLICT DO NOTHING (tidak menghapus apa pun, tidak membuat grup); idempoten (jalan kedua 0 izin, 0 audit);
-- satu baris permission_audit_log `group_permission.sync` {added, removed: [], sumber} per grup yang benar-benar bertambah (= penanda siklus).
-- Uji (12 Okt, DB sekali-pakai): PATCH tiruan + PENSIUN -> PULIH cek 0 tersimpan -> terapkan (6 pasangan termasuk dari PATCH) -> jalan kedua
-- 0/0 -> siklus 2 (kunci dicabut sengaja di antara siklus + PENSIUN lagi) -> PULIH memulihkan siklus 2 saja.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Pasangan yang hilang pada siklus terakhir (dipakai INSERT dan VERIFIKASI). Tabel sementara hilang saat transaksi selesai.
CREATE TEMP TABLE pulih_target ON COMMIT DROP AS
WITH pensiun(kunci) AS (VALUES
    ('off_program_control.create'), ('off_program_control.update'), ('off_program_control.export'), ('off_program_control.approve'),
    ('users.create_user'), ('users.edit_user'), ('users.delete_user'), ('users.set_role'), ('users.set_permission')
),
batas AS (
    SELECT coalesce(max(created_at), '-infinity'::timestamp) AS sejak
    FROM permission_audit_log WHERE actor_name = 'SQL RBAC_S7_1B_PULIH'
)
SELECT DISTINCT pal.target_group_id AS group_id, k.kunci,
       CASE WHEN pal.actor_name = 'SQL RBAC_S7_1B_PENSIUN' THEN 'PENSIUN' ELSE 'PATCH layar' END AS sumber
FROM permission_audit_log pal
CROSS JOIN batas
CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(pal.detail->'removed') = 'array' THEN pal.detail->'removed' ELSE '[]'::jsonb END) AS k(kunci)
JOIN pensiun p ON p.kunci = k.kunci
JOIN access_group ag ON ag.id = pal.target_group_id
WHERE pal.action = 'group_permission.sync'
  AND (pal.actor_name = 'SQL RBAC_S7_1B_PENSIUN' OR pal.actor_user_id IS NOT NULL)
  AND pal.created_at > batas.sejak;

DO $$
DECLARE
    n_target bigint;
    n_izin bigint;
    n_audit bigint;
BEGIN
    SELECT count(*) INTO n_target FROM (SELECT DISTINCT group_id, kunci FROM pulih_target) x;
    RAISE NOTICE 'S7-1b PULIH: TimeZone sesi = %; pasangan siklus terakhir = % (PENSIUN %, PATCH layar %)', current_setting('TimeZone'), n_target,
        (SELECT count(*) FROM pulih_target WHERE sumber = 'PENSIUN'), (SELECT count(*) FROM pulih_target WHERE sumber = 'PATCH layar');
    IF n_target = 0 THEN
        RAISE NOTICE 'S7-1b PULIH: tidak ada jejak kunci pensiun yang hilang pada siklus terakhir — tidak ada yang dipulihkan.';
    END IF;

    WITH izin AS (
        INSERT INTO group_permission (group_id, permission_key)
        SELECT DISTINCT group_id, kunci FROM pulih_target
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

    RAISE NOTICE 'S7-1b PULIH: izin_dipulihkan=% audit=%', n_izin, n_audit;
END $$;

-- VERIFIKASI (di dalam transaksi; mode cek = keadaan yang AKAN tersimpan).
-- Baris 2 sengaja TANPA off_program_control.approve: tanpa S7-3 kunci itu tidak dipensiunkan dan sah dipegang banyak grup (profil Beranda,
-- OPC), jadi mencantumkannya hanya menambah derau; bila S7-3 pernah ikut, kembalinya approve tetap terhitung di baris 1.
SELECT 'VERIFIKASI' AS bagian, 'pasangan grup-kunci siklus terakhir yang belum kembali (harus 0)' AS cek,
       count(*)::text AS nilai
FROM (SELECT DISTINCT group_id, kunci FROM pulih_target) t
WHERE NOT EXISTS (SELECT 1 FROM group_permission gp WHERE gp.group_id = t.group_id AND gp.permission_key = t.kunci)
UNION ALL
SELECT 'VERIFIKASI', 'grup yang memegang kunci pensiun (tanpa approve) sesudah berkas ini',
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
