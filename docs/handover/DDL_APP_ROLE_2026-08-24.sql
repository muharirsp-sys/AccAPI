-- L1g — jalankan aplikasi sebagai role NON-OWNER.
-- Audit: docs/handover/AUDIT_INSENTIF_SALES_2026-08-24.md temuan L1g.
--
-- MASALAH: lib/db.ts dan lib/auth.ts sama-sama memakai DATABASE_URL, dan kredensial itu
-- menunjuk user `accapi` yang adalah PEMILIK database — otomatis punya hak penuh atas semua
-- objek, termasuk DROP TABLE. Data komersial (target value, support/rebate per-principal,
-- payout per orang, DPP harian) diakses dengan kredensial yang sama yang juga dipakai
-- Better Auth untuk tabel session/user. Satu route yang bocor di modul mana pun dari ~50
-- tabel memberi akses baca-tulis ke semuanya, dan tidak ada lapisan yang bisa bilang "tidak".
--
-- YANG DIKERJAKAN: bikin role baru yang HANYA bisa DML (SELECT/INSERT/UPDATE/DELETE),
-- tidak bisa DDL. Nol perubahan kode. User `accapi` TETAP ADA dan tetap dipakai untuk
-- migrasi manual via docker exec — jadi cara kerja yang sekarang tidak berubah.
--
-- YANG TIDAK DIKERJAKAN (sengaja): grant per-tabel untuk memisahkan support/payment dari
-- tabel lain. Itu butuh dua pool + dua env var di kode selama modul lain memakai `db` yang
-- sama — biayanya jauh lebih besar daripada manfaatnya. Lihat §2 laporan audit.
--
-- ============================================================
-- PRASYARAT
-- ============================================================
-- - Lakukan saat TIDAK ADA yang sedang upload (langkah 3 butuh redeploy = aplikasi restart).
--
-- PASSWORD: generate di VPS, JANGAN ketik manual dan JANGAN kirim lewat chat/email —
-- password yang lewat kanal itu harus dianggap sudah bocor. Simpan ke variabel shell dulu,
-- lalu pakai variabelnya di langkah-langkah berikut:
--
--   APP_PW="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"; echo "$APP_PW"
--
-- Huruf/angka saja (tanpa / + =) supaya aman dipakai di dalam URL koneksi tanpa encoding.
-- $APP_PW hanya hidup di terminal itu. Kalau hilang sebelum sempat ditempel ke Coolify,
-- tidak perlu mengulang dari awal — cukup set ulang:
--
--   ALTER ROLE accapi_app PASSWORD '<yang baru>';

-- ============================================================
-- LANGKAH 1 — buat role + beri hak DML atas objek yang SUDAH ada
-- ============================================================
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 <<SQL
--   ...isi blok di bawah...
--   SQL

-- Heredoc-nya <<SQL TANPA kutip supaya ${APP_PW} terisi shell.
CREATE ROLE accapi_app LOGIN PASSWORD '${APP_PW}';

GRANT CONNECT ON DATABASE accapi TO accapi_app;
GRANT USAGE   ON SCHEMA public   TO accapi_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO accapi_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO accapi_app;

-- Tabel/sequence yang dibuat NANTI (oleh migrasi manual sebagai accapi) otomatis ikut
-- ter-grant — tanpa baris ini, setiap tabel baru harus di-grant manual dan lupanya baru
-- ketahuan sebagai "permission denied" saat runtime.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO accapi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO accapi_app;

-- ============================================================
-- LANGKAH 2 — verifikasi SEBELUM mengganti DATABASE_URL
-- ============================================================
-- Jalankan sebagai role baru. Yang pertama HARUS berhasil, yang kedua HARUS ditolak.
--
--   docker exec -i accapi-postgres psql "postgresql://accapi_app:${APP_PW}@localhost/accapi" -c "SELECT count(*) FROM sales_targets;"
--     -> harus keluar angka
--
--   docker exec -i accapi-postgres psql "postgresql://accapi_app:${APP_PW}@localhost/accapi" -c "CREATE TABLE coba_hapus_saya (x int);"
--     -> HARUS gagal: "permission denied for schema public"
--
-- Kalau CREATE TABLE malah BERHASIL, role-nya masih terlalu kuat — hentikan, jangan lanjut
-- ke langkah 3, dan periksa apakah accapi_app tidak sengaja mewarisi role lain.
-- (Kalau terlanjur terbuat: DROP TABLE coba_hapus_saya;)

-- ============================================================
-- LANGKAH 3 — ganti DATABASE_URL di Coolify, lalu Redeploy
-- ============================================================
-- LEWAT UI COOLIFY, BUKAN dengan mengedit docker-compose.yml — file itu DIREGENERASI setiap
-- redeploy, jadi perubahan manual di sana akan hilang tanpa jejak.
--
-- Cetak nilai finalnya dulu, lalu salin SELURUH barisnya:
--   echo "DATABASE_URL=postgresql://accapi_app:${APP_PW}@accapi-postgres:5432/accapi"
--
-- (host `accapi-postgres` = nama container, sama seperti nilai lama; yang berubah hanya
--  user dan password.)
--
-- Setelah Redeploy, cek aplikasi masih normal: buka /insentif-sales, muat satu periode,
-- lalu coba SATU tulisan ringan (mis. simpan support 1 baris) untuk memastikan INSERT/UPDATE
-- benar-benar jalan — SELECT saja tidak membuktikan hak tulis.

-- ============================================================
-- ROLLBACK
-- ============================================================
-- Kembalikan DATABASE_URL ke kredensial `accapi` lewat Coolify UI, lalu Redeploy.
-- Role accapi_app boleh dibiarkan ada — tidak mengganggu.

-- ============================================================
-- CATATAN untuk migrasi berikutnya
-- ============================================================
-- DDL tetap dijalankan sebagai `accapi` (pemilik), persis seperti sekarang:
--   docker exec -it accapi-postgres psql -U accapi -d accapi -c '<DDL>'
-- Aplikasi tidak akan pernah bisa menjalankan DDL lagi — itu memang tujuannya.
