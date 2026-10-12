-- =====================================================================
-- RILIS_CEK_PRA.sql — CEK BACA-SAJA sebelum rilis feat/fiori -> main (docs/handover/RUNBOOK_RILIS_FIORI.md §1.2 dan §3).
-- Untuk IT Support / orkestrator: H-1, lalu sekali lagi tepat sebelum SQL hari-H, dan sesudah langkah §3 (pembanding).
-- Tidak mengubah apa pun: BEGIN READ ONLY ... ROLLBACK (tulisan apa pun ditolak Postgres).
-- Aman di skema image main: objek baru Fiori hanya diperiksa lewat katalog (to_regclass, pg_attribute, pg_trigger, pg_indexes,
-- pg_constraint) — tidak pernah dibaca langsung. Tabel yang dibaca isinya hanya tabel yang SUDAH ada di main.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < RILIS_CEK_PRA.sql > cek-pra.txt 2>&1
--
-- Dengan cek sesi akun sinkron (bagian 5) — id user diambil dari env container frontend, tidak tercetak di layar:
--   F=$(docker ps --format '{{.Names}}' | grep '^accapi-frontend' | head -1)
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     -v sync_id="$(docker exec "$F" printenv ACCURATE_SYNC_USER_ID)" < RILIS_CEK_PRA.sql > cek-pra.txt 2>&1
--
-- Kolom pertama = bagian:
--   0  lingkungan (versi, superuser, collation, ukuran DB -> perkiraan waktu & ruang pg_dump)
--   1  peran & hak (accapi_app tidak boleh CREATE; default privileges accapi -> accapi_app untuk tabel yang dibuat migrate-pg)
--   2  objek per berkas DDL / entri migrate-pg: ada / belum. Kolom `sesuai` = 'ya' bila sama dengan HARAPAN SEBELUM RILIS.
--      Sesudah langkah §3 runbook, baris S7_0 / K1A / S7_2 / K1B (/ K2A) berubah menjadi BEDA — itu memang tujuannya.
--   3  data penentu langkah (E5 antrean faktur, idempotency_log, grup per user, role)
--   4  grup & kunci izin yang disentuh rilis (siapa terkunci bila kunci baru belum diberikan)
--   5  sesi Accurate akun sinkron (hanya bila -v sync_id diberikan)
-- Hasil memuat nama grup & hitungan saja — TANPA email, nama staf, atau token. Tetap simpan cek-pra.txt di VPS; jangan salin ke repo.
-- =====================================================================

BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

-- 0. Lingkungan.
SELECT '0 lingkungan' AS bagian, current_setting('server_version') AS postgres, current_user AS pengguna,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS pengguna_superuser,
       (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS collation,
       pg_size_pretty(pg_database_size(current_database())) AS ukuran_db,
       (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') AS jumlah_tabel_public;

-- 1. Peran & hak. migrate-pg dengan DATABASE_MIGRATION_URL (role accapi) membuat tabel baru; aplikasi (accapi_app) mendapat hak atas
--    tabel itu HANYA lewat default privileges (DDL_APP_ROLE_2026-08-24.sql langkah 1). Bila baris default privileges = false, BERHENTI:
--    tabel accurate_write_attempt / idempotency_override akan tanpa GRANT -> galat "permission denied" saat dipakai.
SELECT '1 peran & hak' AS bagian, cek, nilai FROM (VALUES
    (1, 'role accapi_app ada (HARUS true)', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')::text),
    (2, 'accapi_app superuser (HARUS false)', (SELECT rolsuper::text FROM pg_roles WHERE rolname = 'accapi_app')),
    (3, 'accapi_app boleh CREATE di schema public (HARUS false)', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN has_schema_privilege('accapi_app', 'public', 'CREATE')::text END),
    (4, 'default privileges accapi -> accapi_app untuk TABEL baru (HARUS true)', EXISTS (SELECT 1 FROM pg_default_acl d
        WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'accapi') AND d.defaclobjtype = 'r'
          AND d.defaclacl::text LIKE '%accapi_app=%')::text),
    (5, 'default privileges accapi -> accapi_app untuk SEQUENCE baru (HARUS true)', EXISTS (SELECT 1 FROM pg_default_acl d
        WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'accapi') AND d.defaclobjtype = 'S'
          AND d.defaclacl::text LIKE '%accapi_app=%')::text),
    (6, 'pemilik idempotency_log (di-ALTER migrate-pg)', (SELECT tableowner::text FROM pg_tables WHERE schemaname = 'public' AND tablename = 'idempotency_log')),
    (7, 'pemilik user_group (di-ALTER DDL_S7_0)', (SELECT tableowner::text FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_group')),
    (8, 'pemilik invoice_outbox (diubah E5 DDL_OUTBOX_EVENT)', (SELECT tableowner::text FROM pg_tables WHERE schemaname = 'public' AND tablename = 'invoice_outbox'))
) AS v(no, cek, nilai) ORDER BY no;

-- 2. Objek per berkas. HARAPAN sebelum rilis: prasyarat = true, sisanya false (produksi belum pernah menerima DDL Fiori).
SELECT '2 objek' AS bagian, no, berkas, objek, ada, harapan_sebelum_rilis,
       CASE WHEN ada = harapan_sebelum_rilis THEN 'ya' ELSE 'BEDA' END AS sesuai
FROM (VALUES
    (1, 'prasyarat (image main)', 'tabel invoice_outbox', to_regclass('public.invoice_outbox') IS NOT NULL, true),
    (2, 'prasyarat (image main)', 'tabel idempotency_log', to_regclass('public.idempotency_log') IS NOT NULL, true),
    (3, 'prasyarat (image main)', 'tabel access_group + group_permission + user_group + permission_audit_log',
        (SELECT count(*) = 4 FROM unnest(ARRAY['public.access_group', 'public.group_permission', 'public.user_group',
            'public.permission_audit_log']) AS t WHERE to_regclass(t) IS NOT NULL), true),
    (4, 'migrate-pg accurate_write_attempt', 'tabel accurate_write_attempt', to_regclass('public.accurate_write_attempt') IS NOT NULL, false),
    (5, 'migrate-pg accurate_write_attempt', 'indeks uq_accurate_write_attempt_live',
        EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_accurate_write_attempt_live'), false),
    (6, 'migrate-pg accurate_write_attempt_reopen', 'tabel accurate_write_attempt_reopen',
        to_regclass('public.accurate_write_attempt_reopen') IS NOT NULL, false),
    (7, 'DDL_ADR004.sql (sesudah image)', 'trigger trg_accurate_write_attempt_guard',
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accurate_write_attempt_guard' AND NOT tgisinternal), false),
    (8, 'DDL_ADR004.sql (sesudah image)', 'FK melingkar fk_accurate_write_attempt_reopen',
        EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accurate_write_attempt_reopen'), false),
    (9, 'migrate-pg idempotency_lock_owner_override', 'kolom idempotency_log."lockId" + "lockedBy"',
        (SELECT count(*) = 2 FROM pg_attribute WHERE attrelid = to_regclass('public.idempotency_log')
            AND attname IN ('lockId', 'lockedBy') AND NOT attisdropped), false),
    (10, 'migrate-pg idempotency_lock_owner_override', 'tabel idempotency_override (prasyarat DDL_S6E2 sebelum image)',
        to_regclass('public.idempotency_override') IS NOT NULL, false),
    (11, 'migrate-pg idempotency_log_lock_index', 'indeks idx_idempotency_log_lock',
        EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_idempotency_log_lock'), false),
    (12, 'DDL_S6E2.sql', 'kolom idempotency_log."databaseId"',
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.idempotency_log') AND attname = 'databaseId'
            AND NOT attisdropped), false),
    (13, 'DDL_S6E2.sql', 'kolom idempotency_override.database_id',
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.idempotency_override') AND attname = 'database_id'
            AND NOT attisdropped), false),
    (14, 'DDL_S6E2.sql', 'tabel idempotency_resolution', to_regclass('public.idempotency_resolution') IS NOT NULL, false),
    (15, 'DDL_S6E2.sql', 'trigger trg_idempotency_resolution_guard',
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_idempotency_resolution_guard' AND NOT tgisinternal), false),
    (16, 'migrate-pg invoice_outbox_event', 'tabel invoice_outbox_event', to_regclass('public.invoice_outbox_event') IS NOT NULL, false),
    (17, 'DDL_OUTBOX_EVENT.sql (sesudah image)', 'trigger trg_invoice_outbox_event_guard',
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoice_outbox_event_guard' AND NOT tgisinternal), false),
    (18, 'DDL_S7_0.sql', 'tabel principal / principal_variant / principal_alias (salah satu)',
        (SELECT count(*) > 0 FROM unnest(ARRAY['public.principal', 'public.principal_variant', 'public.principal_alias']) AS t
            WHERE to_regclass(t) IS NOT NULL), false),
    (19, 'DDL_S7_0.sql', 'kolom user_group.is_primary',
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.user_group') AND attname = 'is_primary'
            AND NOT attisdropped), false),
    (20, 'DDL_S7_0.sql', 'indeks uq_user_group_primary',
        EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_user_group_primary'), false),
    (21, 'DDL_S7_0.sql', 'trigger trg_principal_code_tetap',
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_principal_code_tetap' AND NOT tgisinternal), false),
    (22, 'DDL_K1A.sql', 'tabel kasir_* (salah satu dari 6)',
        (SELECT count(*) > 0 FROM unnest(ARRAY['public.kasir_setoran', 'public.kasir_selisih_catatan', 'public.kasir_hari_event',
            'public.kasir_tak_teralokasi_catatan', 'public.kasir_pelunasan', 'public.kasir_pelunasan_faktur']) AS t
            WHERE to_regclass(t) IS NOT NULL), false),
    (23, 'DDL_K1A.sql', 'trigger trg_kasir_setoran_append_only',
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_kasir_setoran_append_only' AND NOT tgisinternal), false),
    (24, 'DDL_S7_2.sql', 'tabel principal_log', to_regclass('public.principal_log') IS NOT NULL, false),
    (25, 'DDL_S7_2.sql', 'trigger trg_principal_log_append_only',
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_principal_log_append_only' AND NOT tgisinternal), false),
    (26, 'DDL_K1B.sql', 'tabel kasir_pelunasan_baca', to_regclass('public.kasir_pelunasan_baca') IS NOT NULL, false),
    (27, 'DDL_K2A.sql (MENYUSUL)', 'kolom kasir_setoran.giro_nomor',
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.kasir_setoran') AND attname = 'giro_nomor'
            AND NOT attisdropped), false)
) AS v(no, berkas, objek, ada, harapan_sebelum_rilis)
ORDER BY no;

-- 3a. E5 (DDL_OUTBOX_EVENT.sql): baris antrean faktur LAMA yang akan dikunci "tidak pasti" / dikembalikan ke Ditolak sesudah image.
--     Produksi 9 Okt: antre_ulang_lama = 0. Angka > 0 pada kolom mana pun = laporkan ke orkestrator SEBELUM merge (runbook §1.2).
SELECT '3a E5 antrean faktur' AS bagian,
       count(*) FILTER (WHERE state = 'sending' AND updated_at < now() - interval '15 minutes') AS sending_lebih_15_menit,
       count(*) FILTER (WHERE state = 'posted' AND btrim(accurate_id) = '') AS posted_tanpa_accurate_id,
       count(*) FILTER (WHERE state = 'rejected' AND btrim(last_error) !~ '^\["') AS ditolak_tanpa_amplop_accurate,
       count(*) FILTER (WHERE state = 'queued' AND attempts > 0) AS antre_ulang_lama,
       count(*) FILTER (WHERE state = 'queued') AS antre_total,
       count(*) FILTER (WHERE state = 'unknown') AS tidak_pasti_sekarang
FROM invoice_outbox;

-- 3b. idempotency_log (kunci kiriman pelunasan). Kunci yang dibuat SEBELUM rilis tidak bisa dikirim lagi sesudah rilis (database tidak
--     tercatat, PR #150 butir 3) -> hari-H, sebelum merge, tidak boleh ada pelunasan yang sedang berjalan.
SELECT '3b idempotency_log' AS bagian, (SELECT count(*) FROM idempotency_log) AS total,
       coalesce((SELECT string_agg(status || '=' || n, ', ' ORDER BY status)
                 FROM (SELECT status, count(*) AS n FROM idempotency_log GROUP BY status) s), '-') AS per_status;

-- 3c. User aktif per jumlah grup. tepat_1_grup = yang diberi bintang otomatis oleh BACKFILL DDL_S7_0.sql;
--     lebih_1_grup = admin menandai bintangnya sendiri di layar /admin/users; tanpa_grup HARUS 0 (S7-1 menolak keadaan itu).
SELECT '3c user aktif x grup' AS bagian, count(*) AS user_aktif,
       count(*) FILTER (WHERE g = 0) AS tanpa_grup,
       count(*) FILTER (WHERE g = 1) AS tepat_1_grup,
       count(*) FILTER (WHERE g > 1) AS lebih_1_grup
FROM (SELECT u.id, (SELECT count(*) FROM user_group ug WHERE ug.user_id = u.id) AS g
      FROM "user" u WHERE NOT coalesce(u.banned, false)) AS x;

-- 3d. Sebaran user.role (user aktif). Bintang grup preset sesudah S7-1 MENURUNKAN role; pindah ke grup custom -> viewer.
SELECT '3d role user aktif' AS bagian,
       coalesce(string_agg(r || '=' || n, ', ' ORDER BY r), '-') AS per_role
FROM (SELECT coalesce(role, '(kosong)') AS r, count(*) AS n FROM "user" WHERE NOT coalesce(banned, false) GROUP BY 1) s;

-- 4a. Grup + kunci yang disentuh rilis. Kunci baru (pelunasan.kirim, finance.resolve_unknown/override_duplicate/repost_payment,
--     order.resolve_unknown, kasir.*) belum ada di produksi — wajar kosong sebelum rilis.
WITH relevan(kunci) AS (VALUES
    ('api_wrapper.view'), ('api_wrapper.execute'), ('pelunasan.kirim'), ('finance.view'), ('finance.update'), ('finance.resolve_unknown'),
    ('finance.override_duplicate'), ('finance.repost_payment'), ('order.view'), ('order.edit'), ('order.resolve_unknown'), ('payments.submit'),
    ('sppd.download'), ('users.manage'), ('users.view'), ('kasir.view'), ('kasir.buka'),
    ('off_program_control.audit_read'), ('off_program_control.audit_export')
)
SELECT '4a grup' AS bagian, ag.name AS grup, ag.is_preset AS preset,
       (SELECT count(*) FROM user_group ug JOIN "user" u ON u.id = ug.user_id
        WHERE ug.group_id = ag.id AND NOT coalesce(u.banned, false)) AS anggota_aktif,
       (SELECT count(*) FROM group_permission gp WHERE gp.group_id = ag.id) AS jumlah_kunci,
       coalesce((SELECT string_agg(gp.permission_key, ', ' ORDER BY gp.permission_key)
                 FROM group_permission gp JOIN relevan r ON r.kunci = gp.permission_key WHERE gp.group_id = ag.id), '-') AS kunci_relevan
FROM access_group ag
ORDER BY ag.name;

-- 4b. Nama grup yang dirujuk SQL rilis (dicari lewat NAMA persis; grup absen = dilewati diam-diam dengan NOTICE).
SELECT '4b nama grup' AS bagian, n.nama, EXISTS (SELECT 1 FROM access_group WHERE name = n.nama) AS ada, n.dipakai_oleh
FROM (VALUES
    (1, 'Admin', 'RBAC_PRESET_KASIR (kasir.view + kasir.buka)'),
    (2, 'OM', 'RBAC_PRESET_KASIR (kasir.view + kasir.buka)'),
    (3, 'Manager', 'RBAC_S7_1B_KUNCI; D-01 Q1 order.resolve_unknown'),
    (4, 'Finance', 'D-01: finance.resolve_unknown/override_duplicate/repost_payment + pelunasan.kirim'),
    (5, 'Fakturist', 'RBAC_PRESET_BL37 — bila SUDAH ada, BL37 TIDAK menyentuhnya (kunci diperiksa manual)'),
    (6, 'Admin Incaso', 'RBAC_PRESET_BL37 (dibuat baru, tanpa anggota)'),
    (7, 'Kasir', 'RBAC_PRESET_BL37 lalu RBAC_PRESET_KASIR'),
    (8, 'Admin Gudang', 'RBAC_PRESET_BL37 (dibuat baru, tanpa anggota)')
) AS n(no, nama, dipakai_oleh)
ORDER BY n.no;

-- 4c. Risiko terkunci SESUDAH image bila kunci baru belum diberikan (RBAC_D01_KUNCI.sql, runbook §5 langkah 4). Satu baris = satu grup yang perlu ditangani.
--     Dua baris terakhir ("pemegang kunci Selesaikan tanpa kunci lihat halaman") hanya bisa muncul SESUDAH kunci baru ada — jalankan berkas ini
--     lagi sesudah §5 langkah 4 sebagai pemeriksaan akhir (harus 0 baris untuk keduanya).
SELECT '4c risiko terkunci' AS bagian, x.risiko, ag.name AS grup,
       (SELECT count(*) FROM user_group ug JOIN "user" u ON u.id = ug.user_id
        WHERE ug.group_id = ag.id AND NOT coalesce(u.banned, false)) AS anggota_aktif
FROM access_group ag
JOIN (VALUES
    ('kirim tulis Konsol hari ini (api_wrapper.execute) -> kirim pelunasan butuh pelunasan.kirim', 'api_wrapper.execute', 'pelunasan.kirim'),
    ('ajukan keranjang (payments.submit) tanpa sppd.download -> unduh dokumen SPPD 403', 'payments.submit', 'sppd.download'),
    ('posting Finance (finance.update) tanpa finance.resolve_unknown -> tidak bisa Selesaikan tidak pasti', 'finance.update', 'finance.resolve_unknown'),
    ('lihat Konsol (api_wrapper.view) tanpa api_wrapper.execute -> kehilangan tulis Konsol', 'api_wrapper.view', 'api_wrapper.execute'),
    ('Selesaikan Finance (finance.resolve_unknown) tanpa finance.view -> tidak bisa membuka /finance', 'finance.resolve_unknown', 'finance.view'),
    ('Selesaikan faktur (order.resolve_unknown) tanpa order.view -> tidak bisa membuka /antrean-faktur', 'order.resolve_unknown', 'order.view')
) AS x(risiko, punya, belum)
  ON EXISTS (SELECT 1 FROM group_permission gp WHERE gp.group_id = ag.id AND gp.permission_key = x.punya)
 AND NOT EXISTS (SELECT 1 FROM group_permission gp WHERE gp.group_id = ag.id AND gp.permission_key = x.belum)
ORDER BY x.risiko, ag.name;

-- 5. Sesi Accurate akun sinkron (ACCURATE_SYNC_USER_ID). Harus: env_terisi, user_ada, tidak banned, ada_sesi, session & database terisi,
--    umur < 12 hari (token ±15 hari; tabel tidak menyimpan refresh token). "Melihat SEMUA cabang" diperiksa owner di Accurate, bukan di sini.
\if :{?sync_id}
SELECT '5 sesi akun sinkron' AS bagian,
       nullif(:'sync_id', '') IS NOT NULL AS env_terisi,
       EXISTS (SELECT 1 FROM "user" WHERE id = :'sync_id') AS user_ada,
       (SELECT role FROM "user" WHERE id = :'sync_id') AS role_user,
       (SELECT coalesce(banned, false) FROM "user" WHERE id = :'sync_id') AS banned,
       EXISTS (SELECT 1 FROM accurate_oauth_session WHERE user_id = :'sync_id') AS ada_sesi,
       (SELECT coalesce(session_id, '') <> '' FROM accurate_oauth_session WHERE user_id = :'sync_id') AS session_terisi,
       (SELECT coalesce(database_id, '') <> '' FROM accurate_oauth_session WHERE user_id = :'sync_id') AS database_terpilih,
       (SELECT database_alias FROM accurate_oauth_session WHERE user_id = :'sync_id') AS nama_database,
       (SELECT round(((extract(epoch FROM now()) - extract(epoch FROM created_at)) / 86400)::numeric, 1)
        FROM accurate_oauth_session WHERE user_id = :'sync_id') AS perkiraan_umur_hari_dibuat,
       (SELECT round(((extract(epoch FROM now()) - extract(epoch FROM updated_at)) / 86400)::numeric, 1)
        FROM accurate_oauth_session WHERE user_id = :'sync_id') AS perkiraan_umur_hari_diubah,
       (SELECT count(*) FROM accurate_oauth_session) AS jumlah_sesi_accurate_semua_user;
\else
SELECT '5 sesi akun sinkron' AS bagian, 'dilewati — jalankan dengan -v sync_id=... (lihat kepala berkas)' AS catatan;
\endif

ROLLBACK;
