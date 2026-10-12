-- =====================================================================
-- RBAC D-01 KUNCI — kunci izin BARU rilis Fiori ke grup LAMA (matriks D-01 §A/§C disetujui owner 11 Okt; keputusan owner 12 Okt).
--   Finance : finance.resolve_unknown, finance.override_duplicate, finance.repost_payment, pelunasan.kirim   (D-01 §A; PR #136/#150/#152)
--   Admin   : pelunasan.kirim                                                                             (owner 12 Okt: kirim pelunasan saat rilis = Finance + Admin)
--   Manager : order.resolve_unknown                                                                       (D-01 Q1; PR #141)
-- SENGAJA TIDAK diberikan (dasar):
--   - Admin TIDAK mendapat finance.resolve_unknown / finance.override_duplicate / order.resolve_unknown: D-01 §A memberi Selesaikan &
--     izinkan-kirim-ulang HANYA ke Finance dan Selesaikan faktur ke Manager (Q1); D-14/D-18 "yang mengirim ≠ yang menyelesaikan / mengizinkan
--     kirim ulang" — Admin kini MENGIRIM pelunasan, jadi tidak boleh menjadi pemeriksanya sendiri. Preset seed "Admin = semua kunci registry"
--     TIDAK dipakai (owner K5 11 Okt: scripts/seed-rbac-presets.ts tidak dijalankan ke produksi). Pemegang finance.update selain Finance
--     (Admin, Manager — cek pra 12 Okt bagian 4c) tetap tanpa finance.resolve_unknown: posting tidak pasti diselesaikan Finance (maker ≠ checker).
--   - Fakturist / Manager TIDAK mendapat pelunasan.kirim (owner 12 Okt). Admin Incaso mendapatnya lewat RBAC_PRESET_BL37.sql (grup baru).
--   - kasir.* = RBAC_PRESET_KASIR.sql. api_wrapper.* TIDAK disentuh (PK-1 owner 12 Okt). Pencabutan finance.update dari Manager (Q3) = layar
--     Akses Group sesudah audit D-17 — berkas ini tanpa DELETE.
--
-- KAPAN: SESUDAH image rilis hidup (runbook §5, tepat sesudah DDL_ADR004 / DDL_OUTBOX_EVENT / DDL_S6E2, masih dalam pembekuan).
--   Kelima kunci TIDAK ada di registry image lama (origin/main lib/rbac/registry.ts: finance tanpa resolve_unknown/override_duplicate/
--   repost_payment, order tanpa resolve_unknown, modul pelunasan belum ada). Layar Akses Group LAMA (GroupManagement.tsx) mengirim SEMUA kunci
--   grup saat simpan dan PATCH lama (app/api/admin/groups/[id]/route.ts) menolak kunci tak dikenal (400 "Key tidak valid: …") -> bila disisipkan
--   SEBELUM image, izin grup Finance/Admin/Manager tidak bisa disimpan di layar lama sampai image baru hidup (selamanya bila rilis batal/
--   ditunda). Image lama sendiri tidak terganggu (getUserPermissions hanya menambah teks kunci). Sesudah image, jeda tanpa kunci = beberapa
--   menit dalam pembekuan (tidak ada yang mengirim pelunasan / menyelesaikan).
--   PENJAGA: mode TERAPKAN menolak bila tabel accurate_write_attempt belum ada (= migrate-pg image rilis belum pernah jalan). Mode cek boleh kapan saja.
--
-- MODE CEK (bawaan): semua perubahan DIBATALKAN — ringkasan (NOTICE) dan VERIFIKASI tercetak, lalu berhenti dengan
--   ERROR "D-01 MODE CEK" (psql ON_ERROR_STOP keluar kode 3 = YANG DIHARAPKAN; transaksi di-ROLLBACK):
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < RBAC_D01_KUNCI.sql
-- TERAPKAN:
--   docker exec -i -e PGOPTIONS='-c rbac.terapkan=1' accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < RBAC_D01_KUNCI.sql
--
-- Jaminan: grup lewat NAMA persis; grup absen = NOTICE + dilewati; HANYA INSERT ... ON CONFLICT DO NOTHING (tidak menghapus/mengubah kunci
-- lain, tidak membuat grup); idempoten (jalan kedua 0 izin, 0 audit); satu baris permission_audit_log `group_permission.sync`
-- {added, removed: [], sumber} per grup yang benar-benar bertambah (pola RBAC_S7_1B_KUNCI.sql).
-- Uji (12 Okt, DB sekali-pakai = salinan am040_fiori + grup sintetis seperti produksi): mode cek 0 tersimpan; terapkan 6 izin + 3 audit;
-- jalan kedua 0/0; terapkan tanpa accurate_write_attempt ditolak.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
    g text;
    n_izin bigint;
    n_audit bigint;
BEGIN
    IF to_regclass('public.accurate_write_attempt') IS NULL THEN
        IF coalesce(current_setting('rbac.terapkan', true), '') = '1' THEN
            RAISE EXCEPTION 'D-01: image rilis belum hidup (tabel accurate_write_attempt belum ada) — jalankan berkas ini SESUDAH image (runbook §5).';
        END IF;
        RAISE NOTICE 'D-01: image rilis belum hidup (accurate_write_attempt belum ada) — mode cek saja; TERAPKAN hanya sesudah image.';
    END IF;

    FOREACH g IN ARRAY ARRAY['Finance', 'Admin', 'Manager'] LOOP
        IF NOT EXISTS (SELECT 1 FROM access_group WHERE name = g) THEN
            RAISE NOTICE 'D-01: grup "%" tidak ada — kuncinya dilewati (periksa ejaan / buat grup lalu jalankan ulang).', g;
        END IF;
    END LOOP;

    WITH isi(grup, kunci) AS (VALUES
        ('Finance', 'finance.resolve_unknown'), ('Finance', 'finance.override_duplicate'), ('Finance', 'finance.repost_payment'),
        ('Finance', 'pelunasan.kirim'),
        ('Admin', 'pelunasan.kirim'),
        ('Manager', 'order.resolve_unknown')
    ),
    izin AS (
        INSERT INTO group_permission (group_id, permission_key)
        SELECT ag.id, isi.kunci FROM isi JOIN access_group ag ON ag.name = isi.grup
        ON CONFLICT DO NOTHING
        RETURNING group_id, permission_key
    ),
    jejak AS (
        INSERT INTO permission_audit_log (id, actor_user_id, actor_name, action, target_group_id, detail, created_at)
        SELECT gen_random_uuid()::text, NULL, 'SQL RBAC_D01_KUNCI', 'group_permission.sync', group_id,
               jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'removed', '[]'::jsonb,
                                  'sumber', 'docs/handover/RBAC_D01_KUNCI.sql'), now()
        FROM izin GROUP BY group_id
        RETURNING target_group_id
    )
    SELECT (SELECT count(*) FROM izin), (SELECT count(*) FROM jejak) INTO n_izin, n_audit;

    RAISE NOTICE 'D-01 KUNCI: izin_disisipkan=% audit=%', n_izin, n_audit;
END $$;

-- VERIFIKASI (di dalam transaksi; mode cek = keadaan yang AKAN tersimpan). `nilai` = true / daftar; 'grup … tidak ada' = periksa nama.
SELECT 'VERIFIKASI' AS bagian, v.cek,
       coalesce((SELECT (count(*) FILTER (WHERE gp.permission_key = ANY (v.kunci)) = cardinality(v.kunci))::text
                 FROM access_group ag LEFT JOIN group_permission gp ON gp.group_id = ag.id WHERE ag.name = v.grup GROUP BY ag.id),
                'grup ' || v.grup || ' tidak ada') AS nilai
FROM (VALUES
    (1, 'Finance memegang 4 kunci (resolve/override/repost + pelunasan.kirim)', 'Finance',
        ARRAY['finance.resolve_unknown', 'finance.override_duplicate', 'finance.repost_payment', 'pelunasan.kirim']),
    (2, 'Admin memegang pelunasan.kirim', 'Admin', ARRAY['pelunasan.kirim']),
    (3, 'Manager memegang order.resolve_unknown', 'Manager', ARRAY['order.resolve_unknown'])
) AS v(no, cek, grup, kunci)
UNION ALL
SELECT 'VERIFIKASI', 'pemegang pelunasan.kirim (harapan: Admin, Finance [+ Admin Incaso sesudah BL37])',
       coalesce((SELECT string_agg(ag.name, ', ' ORDER BY ag.name) FROM group_permission gp JOIN access_group ag ON ag.id = gp.group_id
                 WHERE gp.permission_key = 'pelunasan.kirim'), '-')
UNION ALL
SELECT 'VERIFIKASI', 'pemegang finance.resolve_unknown / override_duplicate (harapan: Finance saja)',
       coalesce((SELECT string_agg(DISTINCT ag.name, ', ') FROM group_permission gp JOIN access_group ag ON ag.id = gp.group_id
                 WHERE gp.permission_key IN ('finance.resolve_unknown', 'finance.override_duplicate')), '-')
UNION ALL
SELECT 'VERIFIKASI', 'pemegang order.resolve_unknown (harapan: Manager saja)',
       coalesce((SELECT string_agg(ag.name, ', ' ORDER BY ag.name) FROM group_permission gp JOIN access_group ag ON ag.id = gp.group_id
                 WHERE gp.permission_key = 'order.resolve_unknown'), '-')
UNION ALL
SELECT 'VERIFIKASI', 'pemegang api_wrapper.execute (tidak diubah berkas ini)',
       coalesce((SELECT string_agg(ag.name, ', ' ORDER BY ag.name) FROM group_permission gp JOIN access_group ag ON ag.id = gp.group_id
                 WHERE gp.permission_key = 'api_wrapper.execute'), '-');

-- Pengaman mode cek: tanpa rbac.terapkan=1 transaksi DIBATALKAN (COMMIT di bawah tidak tercapai / menjadi ROLLBACK).
DO $$
BEGIN
    IF coalesce(current_setting('rbac.terapkan', true), '') <> '1' THEN
        RAISE EXCEPTION 'D-01 MODE CEK: semua perubahan di atas DIBATALKAN (ROLLBACK). Terapkan dengan PGOPTIONS=''-c rbac.terapkan=1''.';
    END IF;
END $$;

COMMIT;
