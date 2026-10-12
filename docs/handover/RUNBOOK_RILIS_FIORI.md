# RUNBOOK RILIS FIORI — `feat/fiori` → `main` (= deploy produksi)

Disusun 12 Okt 2026 dari badan PR #116–#163, kepala tiap berkas `docs/handover/DDL_*.sql` / `RBAC_*.sql`, `scripts/migrate-pg.mjs`
dan HANDOFF-FIORI §00/§0. Dasar: `origin/main` 3382552b, `origin/feat/fiori` 2450c7c9. **S7-1b** dan **K2a** belum masuk feat/fiori:
langkahnya ditandai **[MENYUSUL]**. Pra-cek baca-saja produksi sudah dijalankan orkestrator 12 Okt 09.33 WITA (§1.0). Selain itu,
belum ada yang dijalankan ke produksi.

Tanda: **[IT]** IT Support (SSH VPS, Coolify, psql) · **[ORK]** orkestrator (GitHub `gh`, verifikasi) · **[OWNER]** keputusan ·
⛔ = titik henti: lanjut hanya bila semua butir di atasnya beres · **PERLU KONFIRMASI** = belum pasti, tanyakan dulu sebelum dijalankan.

## 0. Ringkasan

1. **Bagi pengguna:** semua layar memakai tampilan Fiori yang baru. Halaman Masuk/sandi baru, menu mengikuti izin, dan Beranda berbeda per peran.
   Pelunasan pindah ke `/pelunasan`. Antrean Faktur sekarang punya pratinjau dan status "Tidak pasti". Posting Finance tidak bisa ganda.
   Pembayaran yang sudah diajukan terkunci. Login Accurate pindah ke `/sesi-accurate`. Konsol hanya terbuka bagi pemegang `api_wrapper.view`.
   Layar User & Akses Group baru memakai ★ grup utama. Kasir baru sampai cache otomatis; layarnya menyusul.
2. **Durasi:** H-1 sekitar 30 mnt (pra-cek ulang). Hari-H sekitar 2,5–3 jam: cadangan ±15 mnt (DB 2 GB + data frontend 5,4 GB),
   SQL 15 mnt, CI dan deploy 20–35 mnt, langkah sesudah image 30 mnt, uji asap 45 mnt. Situs mati hanya ±1–3 mnt saat container diganti.
3. **Pembagian kerja:** IT menjalankan VPS, Coolify, dan SQL. Orkestrator mengurus PR, CI, dan verifikasi, lalu merge atas perintah owner.
   Owner memutuskan go/no-go, memberi nama staf untuk grup baru, dan mengizinkan UAT pelunasan nyata.
4. **Titik henti:** ⛔1 akhir H-1 · ⛔2 cadangan terverifikasi · ⛔3 VERIFIKASI SQL pra-image · ⛔4 perintah merge owner ·
   ⛔5 container hidup + log migrate-pg bersih · ⛔6 uji asap → GO, atau ROLLBACK (§7).
5. **Syarat keras:** `DATABASE_MIGRATION_URL` (role `accapi`) harus terpasang. Per 12 Okt sudah **ADA**; periksa ulang hari-H.
   Tanpa itu container crash-loop dan situs 503, karena tidak ada berkas DDL yang membuat tabel migrate-pg S6
   (`accurate_write_attempt*`, `idempotency_override`, `invoice_outbox_event`). Alasan lengkap di §3.

**JANGAN:** jalankan `scripts/seed-rbac-presets.ts` ke produksi (PR #136/#158). Jangan menyunting `.env` service untuk nilai permanen,
karena deploy berikutnya menimpanya. Jangan memakai `docker restart` untuk menerapkan env. Jangan DROP tabel/kolom baru saat rollback.
Jangan mengirim sandi atau secret lewat chat. Jangan memakai auto-merge atau `--admin`.

## 1. H-1 (sehari sebelum; baca-saja)

### 1.0 Fakta pra-cek produksi 12 Okt 09.33 WITA (ORK, baca-saja; tanpa data staf)
- **DB:** Postgres 16.14, en_US.utf8, 2039 MB, 88 tabel. `accapi_app` ada, bukan superuser, tanpa CREATE.
  Default privileges tabel & sequence = true. Pemilik `idempotency_log` / `user_group` / `invoice_outbox` = `accapi`.
- **Objek (bagian 2):** 27/27 `sesuai = ya`; belum ada DDL Fiori terpasang. Baris 10 `idempotency_override` = f, jadi DDL_S6E2 dijalankan **sesudah** image.
- **Data:** E5 (3a) semua 0. `idempotency_log` = 0 baris. 25 user aktif, semuanya tepat 1 grup (tanpa grup 0, > 1 grup 0).
  Role: admin 4, admin_sales 1, claim 1, finance 1, manager 1, salesman 6, sm 1, spv 1, staff 6, viewer 3.
- **Izin (4a/4c):** tanpa kunci baru, Admin (4), Fakturist (2), dan Manager (1) kehilangan kirim pelunasan (`pelunasan.kirim`).
  Admin dan Manager memegang `finance.update` tanpa `finance.resolve_unknown`. Tidak ada risiko `sppd.download`.
  Grup Admin Incaso / Kasir / Admin Gudang belum ada.
- **Sesi akun sinkron:** sehat — role admin, database "CV Surya Perkasa", umur 0,7 hari.
- **Env:** `DATABASE_MIGRATION_URL` **ADA**. `ACCURATE_SYNC_USER_ID`, `ACCURATE_INVOICE_DB_ID`, `CRON_SECRET` ADA. `ACCURATE_INVOICE_SEND` kosong.
  Tidak ada cron `post-invoices`, jadi kiriman faktur otomatis mati dan E5 tidak terburu waktu.
- **`payments.json`:** objek JSON valid. 32 baris `lpb.nilai_invoice` bertipe teks, semuanya string kosong `''`. Vonis **GO**, lihat 1.5.
- **VPS:** cronie-1.6.1 (mendukung `CRON_TZ`). `/usr/local/bin/accapi-cron.sh` TANPA `--max-time`. Jam VPS CST = WITA (UTC+8).
  Disk kosong 48 GB. `/app/data` frontend 5,4 GB. Image sekarang: frontend `sha256:5580963f…`, backend `sha256:d293bd0b…`, dibuat 2026-10-09T15:32Z.
- **Keputusan owner 12 Okt:** `pelunasan.kirim` saat rilis = **Finance + Admin** (bukan Fakturist/Manager). Staf incaso = staf lain, namanya menyusul;
  grup Admin Incaso dibuat kosong oleh BL37 dan diisi sesudah rilis. PK-1: `api_wrapper.*` tidak diubah. Manager tetap mengelola Claim Workflow.

### 1.1 Siapkan berkas SQL di VPS [ORK → IT]
Jalankan di PC orkestrator (Git Bash, checkout repo). `REF` = commit yang akan di-merge, sesudah S7-1b dan K2a masuk feat/fiori.
```bash
cd D:/AccAPI/_github_clean && git fetch origin && REF=origin/feat/fiori && mkdir -p tmp/rilis-fiori
for f in RILIS_CEK_PRA DDL_S7_0 RBAC_S7_1_CEK_ROLE DDL_K1A DDL_S7_2 DDL_K1B DDL_K2A RBAC_S7_1B_CEK RBAC_S7_1B_KUNCI DDL_ADR004 DDL_OUTBOX_EVENT \
         DDL_S6E2 RBAC_D01_KUNCI RBAC_PRESET_BL37 RBAC_PRESET_KASIR RBAC_S7_1B_PENSIUN RBAC_S7_1B_PULIH PRINCIPAL_EKSPOR; do
  git show "$REF:docs/handover/$f.sql" > "tmp/rilis-fiori/$f.sql" 2>/dev/null || { echo "BELUM ADA: $f"; rm -f "tmp/rilis-fiori/$f.sql"; }; done
ssh root@43.156.118.114 'mkdir -p /root/rilis-fiori' && scp tmp/rilis-fiori/*.sql root@43.156.118.114:/root/rilis-fiori/
```
Di VPS, setiap sesi SSH baru, definisikan dulu nama container dan fungsi pembantu. Fungsi tidak terbawa ke sesi berikutnya.
```bash
cd /root/rilis-fiori
F=$(docker ps --format '{{.Names}}' | grep '^accapi-frontend' | head -1); B=$(docker ps --format '{{.Names}}' | grep '^accapi-backend' | head -1); echo "$F | $B"
jalankan() { docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < "$1" > "log-$1.txt" 2>&1; echo "== $1 kode keluar: $? (0=ok, 3=galat SQL)"; tail -n 40 "log-$1.txt"; }
terapkan() { docker exec -i -e PGOPTIONS='-c rbac.terapkan=1' accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < "$1" > "log-terapkan-$1.txt" 2>&1; echo "== TERAPKAN $1 kode keluar: $?"; tail -n 40 "log-terapkan-$1.txt"; }
```
Kode keluar 0 belum berarti benar. Baca juga blok VERIFIKASI di akhir log: setiap `ok` harus `t`. `NULL`/kosong = tidak berlaku.
Berkas `RBAC_*_KUNCI` / `PENSIUN` / `PULIH` punya **mode cek**: `jalankan` mencetak rencana lalu berhenti dengan ERROR "MODE CEK" dan kode 3.
Itu NORMAL, karena semua perubahan dibatalkan. Baru `terapkan` yang menyimpan.

### 1.2 Pra-cek ulang (H-1 sore, lalu sekali lagi hari-H sebelum §2) [IT]
- [ ] `docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 -v sync_id="$(docker exec "$F" printenv ACCURATE_SYNC_USER_ID)" < RILIS_CEK_PRA.sql > cek-pra.txt 2>&1; echo $?` lalu `less cek-pra.txt`
- [ ] Hasilnya harus sama dengan §1.0: bagian 1 benar; bagian 2 seluruhnya `sesuai = ya`; 3a = 0; 3b = 0; 3c `tanpa_grup` = 0; bagian 5 sehat.
  Bila ada yang berbeda → BERHENTI dan lapor ORK. Baris 3b > 0 berarti ada pelunasan baru; pastikan tidak ada yang sedang berjalan saat hari-H.
- [ ] [MENYUSUL] `jalankan RBAC_S7_1B_CEK.sql` (baca-saja; sudah dijalankan ORK 12 Okt). Hasilnya memuat email staf, jadi simpan di VPS saja.

### 1.3 Env [IT]
```bash
for v in DATABASE_MIGRATION_URL ACCURATE_SYNC_USER_ID ACCURATE_INVOICE_DB_ID CRON_SECRET; do docker exec "$F" sh -c "[ -n \"\$$v\" ] && echo '$v: ADA' || echo '$v: TIDAK'"; done
docker exec "$F" sh -c 'echo "ACCURATE_INVOICE_SEND=${ACCURATE_INVOICE_SEND:-(kosong)}"; u="${DATABASE_MIGRATION_URL#*://}"; echo "pengguna migrasi: ${u%%[:@]*}"'
```
- [ ] Keempatnya ADA; `pengguna migrasi: accapi`. Keadaan 12 Okt sudah begitu, jadi redeploy uji tidak perlu. Bila salah satu TIDAK → BERHENTI.
  `DATABASE_MIGRATION_URL` dipasang lewat UI Coolify (service AccAPI → Environment Variables, bukan build variable) dengan format
  `postgresql://accapi:<sandi>@accapi-postgres:5432/accapi`, lalu dicek ulang. Jangan pernah lewat chat.

### 1.4 Sesi Accurate akun sinkron [IT + pemilik akun]
- [ ] Bagian 5 cek-pra sehat dan umur < 10 hari. Pada 12 Okt umurnya 0,7 hari; token ±15 hari, jadi bila hari-H sesudah ±22 Okt, login ulang dulu.
  Login dan pilih database di Konsol `/api-wrapper` sebelum rilis; sesudah rilis lewat `/sesi-accurate`.
- [ ] [OWNER] Pastikan di Accurate bahwa akun itu admin yang melihat **SEMUA cabang** (PR #163). Akun yang hanya melihat sebagian cabang memicu `hapus_massal` di Kasir.

### 1.5 `payments.json` — 32 `nilai_invoice = ''` → vonis GO
`''` adalah bentuk "Nilai Invoice belum diisi" yang **ditulis sendiri** oleh kode unggah LPB:
`python_backend/shared.py:1557` dan `routers/payments.py:267` (`"nilai_invoice": nilai_invoice if nilai_invoice > 0 else ""`).
Semua pembaca di feat/fiori memperlakukannya sebagai 0:
- `parse_number_id` (`shared.py:311-322`, `t == "" → 0.0`) dipakai di finance.py:76/267 dan payments.py:107/148/257/629/674/856/930/1048/1068/1094/1121/1242.
- `parse_number_strict` (`shared.py:333-347`, `"" / "-" → 0.0`).
- `float(x or 0.0)` di payments.py:467.
- Tampilan `/payments/data` (payments.py:105-115) mengubah `''` → `''` dengan gap 0.
- Pembanding kunci BL-05 (`payment_field_changed`, shared.py:1925-1932): `''` vs 0 bukan perubahan.
- Satu-satunya penolakan adalah keranjang: "Nilai Invoice kosong" (payments.py:642/1053). Penolakan ini sudah ada di main (payments.py:599/986) — perilaku lama, bukan regresi.
Bukti uji 12 Okt dengan fungsi asli feat/fiori: `parse_number_id('')` = `parse_number_strict('')` = 0.0; `payment_field_changed('nilai_invoice','',0)` = False;
`python test_parse_number_id.py` → OK. Untuk dijalankan ulang (opsional), pemindai baca-saja:
`docker exec -i "$B" python -c "import json,os;d=json.load(open(os.environ.get('PAYMENTS_DB_PATH','/app/python_backend/data/payments.json')));print(isinstance(d,dict),sum(1 for r in d.get('lpb',{}).values() if isinstance(r,dict) and isinstance(r.get('nilai_invoice'),str) and r['nilai_invoice']!=''))"`
→ `True 0` (teks yang BUKAN kosong). Angka > 0 → lapor ORK.

### 1.6 Ruang & catatan image [IT]
- [ ] `df -h / /var/lib/docker` masih ≥ 15 GB kosong (12 Okt: 48 GB).
- [ ] `for c in "$F" "$B"; do docker inspect -f '{{.Name}} image={{.Image}} config={{.Config.Image}} dibuat={{.Created}}' "$c"; done | tee image-sebelum.txt`.
  Pada 12 Okt: frontend `5580963f…` dan backend `d293bd0b…`. Diperlukan untuk rollback cepat (§7).

### 1.7 Keputusan sebelum hari-H [OWNER, dicatat ORK]
- [x] Kunci D-01 untuk grup lama → `RBAC_D01_KUNCI.sql` (§5 langkah 4): Finance + Admin = `pelunasan.kirim`, dan seterusnya. Diputuskan owner 12 Okt.
- [ ] **Jendela waktu dan pembekuan.** Pilih Minggu, atau ≥ 21.00 WITA, dan hindari cron sinkron :15. Selama jendela, tidak ada kiriman pelunasan, faktur, atau unggah.
- [ ] **Nama staf** untuk Admin Incaso (menyusul), Kasir, dan Admin Gudang. Ketiga grup ini diisi sesudah rilis (§5 langkah 9).
  Grup "Fakturist" sudah ada di produksi, sehingga BL37 tidak menyentuhnya.
- [ ] **Izin UAT** 1 pelunasan nyata kecil (§6). `idempotency_log` produksi kosong, jadi penjaga ganda belum pernah diuji dengan data nyata.

⛔1: pra-cek 1.2 sama dengan §1.0, env 1.3 ADA, dan owner memberi tanggal.

## 2. Cadangan (hari-H, sebelum SQL apa pun) [IT]
```bash
mkdir -p /root/cadangan && cd /root/cadangan && T=$(date +%Y%m%d-%H%M)
time docker exec accapi-postgres pg_dump -U accapi -d accapi -Fc -Z 6 > accapi-pra-fiori-$T.dump; echo "kode: $?"; ls -lh accapi-pra-fiori-$T.dump
docker exec -i accapi-postgres pg_restore -l < accapi-pra-fiori-$T.dump > daftar-$T.txt; echo "kode: $?"; grep -c 'TABLE DATA' daftar-$T.txt   # ≈ 88
docker cp "$B":/app/python_backend/data backend-data-$T && du -sh backend-data-$T                        # payments.json, users.json, setelan SPPD
time docker exec "$F" tar -cf - -C /app data > frontend-data-$T.tar; echo "kode: $?"; ls -lh frontend-data-$T.tar  # ±5,4 GB unggahan
tar -tf frontend-data-$T.tar | wc -l
```
- [ ] Semua `kode: 0`. Dump > 0 byte dan `TABLE DATA` ≈ 88 (jumlah tabel public). Arsip frontend ±5,4 GB dan bisa didaftar isinya.
- [ ] Perkiraan waktu: dump DB 2 GB ±4–6 mnt; arsip frontend ±3–5 mnt. Ruang cukup: 48 GB kosong, perlu ±8 GB.
  Aplikasi tetap hidup selama cadangan berjalan. SQL §3 baru boleh dijalankan **sesudah dump selesai**, karena dump menahan kunci baca dan `lock_timeout` 5 dtk di DDL akan gagal.
- [ ] (Opsional, **PERLU KONFIRMASI** owner, data sensitif) salin dump ke luar VPS. Hapus arsip lama sesudah rilis stabil.

⛔2: cadangan terverifikasi.

## 3. SQL SEBELUM image [IT] (urut; semuanya role pemilik `accapi`, idempoten, aman untuk image lama)
| # | Perintah (di `/root/rilis-fiori`) | Harus terlihat | Bila tidak |
|---|---|---|---|
| 1 | `jalankan DDL_S7_0.sql` | VERIFIKASI 13 baris `t`; VERIFIKASI BACKFILL 2 baris `t` (25 user berbintang) | BERHENTI, lapor ORK |
| 2 | `jalankan RBAC_S7_1_CEK_ROLE.sql` (baca-saja) | 4 daftar; catat jumlah per daftar (pembanding §5) | — (informasi) |
| 3 | `jalankan DDL_K1A.sql` | VERIFIKASI semua `t` | BERHENTI |
| 4 | `jalankan DDL_S7_2.sql` (butuh #1) | VERIFIKASI semua `t` | BERHENTI. Galat "trigger trg_principal_code_tetap tidak terpasang persis" = ulangi #1 |
| 5 | `jalankan DDL_K1B.sql` (butuh #3) | VERIFIKASI semua `t` (termasuk "prasyarat K1a") | BERHENTI |
| 6 | [MENYUSUL K2a] `jalankan DDL_K2A.sql` | VERIFIKASI semua `t` | BERHENTI |
| 7 | [MENYUSUL S7-1b] `jalankan RBAC_S7_1B_KUNCI.sql` (mode cek) | NOTICE + VERIFIKASI, lalu ERROR "S7-1b MODE CEK" dan kode 3 = NORMAL | — |
| 8 | [MENYUSUL S7-1b] `terapkan RBAC_S7_1B_KUNCI.sql` (kunci lama yang dikenal image lama) | kode 0; VERIFIKASI "audit_read tanpa audit_export" = 0; Manager audit_read+audit_export = true | BERHENTI |
| 9 | (Pratinjau) `jalankan RBAC_D01_KUNCI.sql` (mode cek) | NOTICE "image rilis belum hidup — mode cek saja", "izin_disisipkan=6 audit=3"; VERIFIKASI true; kode 3 = NORMAL | lapor ORK (nama grup) |

Berkas yang **TIDAK** di sini, dan alasannya:
- **DDL_ADR004 dan DDL_OUTBOX_EVENT:** menurut kepala berkasnya, keduanya dijalankan "SESUDAH image baru hidup". Sebelum image, tabelnya belum ada,
  jadi berkas hanya mencetak NOTICE.
- **DDL_S6E2:** meng-ALTER `idempotency_override`, padahal tabel itu belum ada di produksi (pra-cek baris 10 = f). Tabel itu dibuat migrate-pg saat
  container start, dan migrate-pg hanya bisa membuatnya lewat `DATABASE_MIGRATION_URL`, karena `accapi_app` tidak punya CREATE.
- **RBAC_D01_KUNCI terapkan:** kelima kuncinya (`finance.resolve_unknown/override_duplicate/repost_payment`, `pelunasan.kirim`, `order.resolve_unknown`)
  TIDAK ada di registry image lama. Layar Akses Group lama mengirim semua kunci grup, dan PATCH lama menolak kunci tak dikenal
  (400 "Key tidak valid") — `app/api/admin/groups/[id]/route.ts:56-59` di main. Bila diterapkan sebelum image, grup Finance/Admin/Manager tidak bisa
  disimpan di layar lama, dan keadaan itu menetap bila rilis tertunda. Berkas ini sendiri menolak `terapkan` sebelum image.
- [ ] Jalankan ulang `RILIS_CEK_PRA.sql` (simpan ke `cek-pra-2.txt`). Baris 18–26 (dan 27 bila K2a) kini `ada = t` dan `sesuai = BEDA`, yang memang diharapkan; baris lain tetap `ya`.

⛔3: semua VERIFIKASI `t`. Lalu umumkan "pembekuan mulai", dan pastikan tidak ada pelunasan yang sedang dikirim (bagian 3b tidak bertambah).

## 4. Merge & deploy [ORK, atas perintah owner]
```bash
gh pr create --repo muharirsp-sys/AccAPI --base main --head feat/fiori --title "Rilis Fiori S0–S7 + Kasir K1 (feat/fiori → main)" --body-file <badan-pr.md>
gh pr update-branch <n> --repo muharirsp-sys/AccAPI                 # bila "not up to date" (ruleset main)
gh pr checks <n> --repo muharirsp-sys/AccAPI                        # baca vonis TIAP check; build-and-push "skipping" di PR = normal
gh pr view <n> --repo muharirsp-sys/AccAPI --json mergeStateStatus  # harus CLEAN
gh pr merge <n> --repo muharirsp-sys/AccAPI --merge                 # ⛔4: HANYA sesudah owner berkata "merge"
gh run list --repo muharirsp-sys/AccAPI --branch main --limit 3 && gh run watch <run-id> --repo muharirsp-sys/AccAPI --exit-status
```
Badan PR memuat ringkasan §0 dan tautan ke runbook ini. Workflow "Deploy to Coolify" hijau belum berarti versi baru sudah hidup.
Coolify baru mengganti container ±10–20 mnt kemudian. [IT] pantau:
```bash
while true; do docker ps --format '{{.Names}}  {{.Status}}  dibuat {{.CreatedAt}}' | grep accapi-; sleep 30; done   # Ctrl-C bila waktu "dibuat" sudah sesudah merge
F=$(docker ps --format '{{.Names}}' | grep '^accapi-frontend' | head -1); B=$(docker ps --format '{{.Names}}' | grep '^accapi-backend' | head -1)
docker inspect -f '{{.Created}}' "$F" "$B"; docker logs "$F" 2>&1 | grep -E 'migrate-pg|42501|must be owner|permission denied' | tail -n 30
curl -s -o /dev/null -w 'login: %{http_code}\n' https://web-super.online/login
```
- [ ] Waktu `.Created` kedua container sesudah merge. Status `Up`, bukan `Restarting`.
- [ ] Log migrate-pg menampilkan 10 `SKIP` lama, lalu **`OK`**: `accurate_write_attempt`, `accurate_write_attempt_reopen`, `idempotency_lock_owner_override`,
  `idempotency_log_lock_index`, `idempotency_s6e2`, `idempotency_override_database`, `invoice_outbox_event`.
  Setelah itu **`SKIP`**: `principal (+variant, +alias)`, `user_group.is_primary`, `kasir (…)`, `principal_log`, `kasir_pelunasan_baca (…)` [+ `kasir_setoran giro (K2a)`].
  Baris terakhir: `22 migrasi selesai.` (23 bila K2a). Tidak ada `GAGAL` maupun `42501`.
- [ ] `login: 200`. Bila 503 atau crash-loop, lihat §7 "perbaikan cepat" lebih dulu.

⛔5: container hidup, migrate-pg bersih, `/login` 200.

## 5. SESUDAH image [IT] (segera, berurutan; pembekuan tetap berlaku sampai langkah 4)
| # | Perintah | Harus terlihat |
|---|---|---|
| 1 | `jalankan DDL_ADR004.sql` lalu `docker exec accapi-postgres psql -U accapi -d accapi -c '\dp accurate_write_attempt*'` | VERIFIKASI 10 baris `t` (PR #136). `accapi_app` pada `_reopen` tanpa `w`/`d`/`D` |
| 2 | `jalankan DDL_OUTBOX_EVENT.sql` (sebelum ada yang menekan Kirim faktur) | NOTICE "E5: 0 baris …" (pra-cek 3a = 0); VERIFIKASI 7 baris `t` |
| 3 | `jalankan DDL_S6E2.sql` | VERIFIKASI 8 baris `t` |
| 4 | `jalankan RBAC_D01_KUNCI.sql`, lalu `terapkan RBAC_D01_KUNCI.sql` | Terapkan: "izin_disisipkan=6 audit=3", kode 0. VERIFIKASI: Finance 4 kunci / Admin / Manager = true; pelunasan.kirim = "Admin, Finance"; resolve/override = "Finance"; order.resolve_unknown = "Manager" |
| 5 | `jalankan DDL_S7_0.sql` (ulang, untuk BACKFILL bintang; PR #155/#157) | VERIFIKASI + VERIFIKASI BACKFILL `t` |
| 6 | `jalankan RBAC_S7_1_CEK_ROLE.sql` | daftar 3 kosong; bandingkan dengan §3 #2 dan lapor ORK |
| 7 | `jalankan RBAC_PRESET_BL37.sql` | kode 0. "Fakturist" yang sudah ada dilewati (benar); Admin Incaso (memegang `pelunasan.kirim`), Kasir, dan Admin Gudang dibuat kosong |
| 8 | `jalankan RBAC_PRESET_KASIR.sql` (butuh #7) | kode 0, tanpa NOTICE "grup … tidak ada". Bila ada NOTICE: periksa nama grup OM/Admin |
| 9 | Admin di `/admin/users` (tekan Ctrl+Shift+R dulu; tab lama menganggap kunci baru "usang", PR #161) | sisa manual, lihat daftar di bawah |
| 10 | [MENYUSUL] `jalankan RBAC_S7_1B_CEK.sql` | bagian 2b dan 3 = 0 baris |
| 11 | [MENYUSUL] `RBAC_S7_1B_PENSIUN.sql`: `jalankan` (mode cek) hari-H; `terapkan` **H+1** sesudah ⛔6 GO (PERLU KONFIRMASI) | mode cek kode 3; terapkan: "sisa_kunci_pensiun" = 0 |
| 12 | Crontab K1b + uji (lihat di bawah) | `check: 200` atau `202` |
| 13 | `docker exec -i accapi-postgres psql -U accapi -d accapi -qAt -v ON_ERROR_STOP=1 < PRINCIPAL_EKSPOR.sql > principal-ekspor.json` → ORK membuat laporan offline → owner meninjau `benih.sql` (tidak harus hari-H) | 1 baris JSON |

**Langkah 9, sisa manual** (kunci grup lama sudah ditangani langkah 4):
- [ ] **Admin Incaso:** masukkan staf incaso sesudah owner memberi nama. Sampai itu terjadi, pelunasan dikirim Admin atau Finance.
- [ ] **Kasir** dan **Admin Gudang:** masukkan anggota sesuai daftar owner. Kasir belum punya layar (K2b).
- [ ] **Fakturist** (grup lama, tidak disentuh BL37): pastikan memegang `dashboard.view`, `order.view/create/edit/export`, `sales_history.view`, `principles.view` (D-01 §B).
  `api_wrapper.*` dibiarkan (PK-1).
- [ ] Seorang user yang dipindah ke grup baru akan memiliki 2 grup; tandai ★ grup utamanya. Bintang pada grup preset menurunkan `user.role`.
- [ ] (Nanti, sesudah audit D-17, bukan hari-H) cabut `finance.update` dari Manager (Q3) di `/admin/groups`.

**Langkah 12, crontab K1b** (KASIR-KONTRAK §7; owner: UTC eksplisit, `curl --max-time 900`). Tulis berkas BARU `/etc/cron.d/accapi-kasir`.
Secret dibaca dari `.env` service ke variabel shell, tanpa dicetak; yang tampil hanya panjangnya:
```bash
S=$(grep -m1 '^CRON_SECRET=' /data/coolify/services/m3snvk67018khyzuz9dhkh4h/.env | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')
[ -n "$S" ] && echo "CRON_SECRET terbaca (${#S} karakter)" || echo "CRON_SECRET TIDAK terbaca — BERHENTI"
umask 077; { echo "CRON_TZ=UTC"; echo "CRON_SECRET=$S"; cat <<'CRON'
# K1b cache pelunasan Kasir: 07.00–21.00 WITA Senin–Sabtu tiap 15 mnt + baca penuh 19.30 WITA (jadwal UTC).
*/15 23   * * 0-5 root curl -fsS --max-time 900 -H "Authorization: Bearer $CRON_SECRET" https://web-super.online/api/cron/kasir-pelunasan >> /var/log/accapi-kasir.log 2>&1
*/15 0-12 * * 1-6 root curl -fsS --max-time 900 -H "Authorization: Bearer $CRON_SECRET" https://web-super.online/api/cron/kasir-pelunasan >> /var/log/accapi-kasir.log 2>&1
0    13   * * 1-6 root curl -fsS --max-time 900 -H "Authorization: Bearer $CRON_SECRET" https://web-super.online/api/cron/kasir-pelunasan >> /var/log/accapi-kasir.log 2>&1
30   11   * * 1-6 root curl -fsS --max-time 900 -H "Authorization: Bearer $CRON_SECRET" "https://web-super.online/api/cron/kasir-pelunasan?penuh=1" >> /var/log/accapi-kasir.log 2>&1
CRON
} > /etc/cron.d/accapi-kasir; chmod 600 /etc/cron.d/accapi-kasir; ls -l /etc/cron.d/accapi-kasir
curl -s -o /dev/null --max-time 60 -w 'check: %{http_code}\n' -H "Authorization: Bearer $S" 'https://web-super.online/api/cron/kasir-pelunasan?check=1'; unset S
```
- [ ] `check: 200` atau `202` = normal. `401` = secret salah. `503` = sesi akun sinkron (1.4).
  `ls -l` harus menampilkan `-rw-------`: berkas ini memuat secret, jadi tidak boleh dibaca selain root.
  Bila `CRON_SECRET` diganti di Coolify, jalankan ulang blok ini.
  `accapi-cron.sh` sengaja TIDAK dipakai karena tidak memakai `--max-time`, sedangkan route berjalan sampai ±13 mnt.

## 6. Uji asap per peran [ORK + penguji tiap peran; sebelum pembekuan dicabut]
Semua akun: buka `/login` (tampilan baru), masuk, lalu periksa bahwa menu samping sesuai izin dan Beranda tampil tanpa strip galat merah.
Jangan menekan tombol tulis kecuali yang disebut di tabel.
| Peran | Buka | Harus aktif/terlihat |
|---|---|---|
| Admin | `/admin/users`, `/admin/groups`, `/sesi-accurate`, `/api-wrapper`, `/pelunasan` | daftar + ★, Object Page (Grup/Keamanan/Riwayat); status sesi; Konsol terbuka; wizard Pelunasan terbuka |
| Fakturist | `/sesi-accurate` → `/antrean-faktur`, `/orders`, `/principal-order`, `/faktur` | database benar; kartu status; **Kirim** membuka pratinjau dengan nama database (tekan Batal); daftar terbaca. `/pelunasan` = Akses ditolak (BENAR) |
| Staff Keuangan | `/payments` (tab Pengajuan & SPPD), `/payments/sppd` | rekaman yang sudah diajukan terkunci + alasan; unduh 1 dokumen SPPD berhasil |
| Finance | `/finance`, `/pelunasan`, `/sesi-accurate` | daftar posting; "Selesaikan tidak pasti" aktif (bukan "tanpa izin"); `/pelunasan` terbuka, termasuk Selesaikan / izinkan kirim ulang |
| Manager | `/antrean-faktur`, `/off-program-control`, `/claim-workflow` | Selesaikan tidak pasti (faktur) aktif; OPC semua tab + ekspor; Claim tetap bisa kelola. `/pelunasan` = Akses ditolak (BENAR) |
| SPV / SM | `/off-program-control`, `/form-kontrol` (Dashboard SPV), `/insentif-sales` | antrean batch, tim, dashboard terbaca |
| Salesman (ponsel) | `/form-kontrol` (Rute hari ini, Kunjungan), `/sales` | layar 390 px tanpa gulir menyamping; draf order tersimpan |
| OM / Kasir | Beranda | tampil. `/kasir` belum punya layar (K2b menyusul) — wajar |
| Admin Incaso | (sesudah anggota diisi) Beranda, `/pelunasan`, `/api-wrapper` | tile "Perlu tindakan"; wizard sampai Tinjau; `/api-wrapper` = Akses ditolak (BENAR) |
- [ ] **UAT pelunasan** (izin owner 1.7). Admin atau Finance mengirim 1 pelunasan nyata kecil lewat `/pelunasan`. Hasilnya "terkirim" dengan nomor Accurate,
  dan nomor itu ada **satu kali** di Accurate. Unggah berkas yang sama lagi → baris **ditahan** (izin kirim ulang = Finance). Lalu periksa:
  `docker exec accapi-postgres psql -U accapi -d accapi -c 'SELECT status, "databaseId" IS NOT NULL AS ada_db FROM idempotency_log ORDER BY "updatedAt" DESC NULLS LAST LIMIT 3;'` → `ada_db = t`.

⛔6: [OWNER] GO, lalu ORK mengumumkan pembekuan selesai. Bila tidak → §7.

## 7. Rollback
**Kapan.** Container crash-loop atau 503 lebih dari 15 mnt dan perbaikan cepat di bawah tidak menolong.
Atau galat 5xx massal di login, Beranda, Antrean, atau Pelunasan yang tidak teratasi dalam 30 mnt.
Atau staf terkunci tanpa jalan cepat. Atau dugaan posting ganda: hentikan kiriman dulu, baru putuskan.
**Siapa memutuskan:** owner. Bila owner tidak terjangkau dan situs mati > 30 mnt: **PERLU KONFIRMASI** siapa wakilnya.

**Perbaikan cepat (bukan rollback):**
- Log `42501`, `must be owner`, atau `permission denied for schema public` → `DATABASE_MIGRATION_URL` tidak sampai ke container. Periksa dengan perintah ADA/TIDAK (1.3), perbaiki di Coolify, lalu Redeploy.
- `/api/principals` menjawab 503 `PRINCIPAL_DDL_BELUM` → ulangi §3 #1 dan #4.
- Staf mendapat "Akses ditolak" → periksa §5 langkah 4 (VERIFIKASI) dan langkah 9. Admin sendiri tidak bisa membuka `/admin/groups` → periksa grup Admin memegang `users.manage` (cek-pra 4a).

**Cara A (resmi) [ORK, atas perintah owner], ±20–35 mnt:** buat cabang dari `origin/main`, jalankan `git revert -m 1 <hash merge rilis>`,
commit dengan email noreply, push, buka PR → checks → `gh pr merge --merge`. Deploy-nya memasang kembali kode lama.
**Cara B (darurat di VPS) [IT], PERLU KONFIRMASI, belum pernah diuji:** pasang tag `latest` pada image lama dari `image-sebelum.txt`
(`5580963f…` / `d293bd0b…`): `docker tag <image-id-lama> ghcr.io/muharirsp-sys/accapi-frontend:latest` (backend sama), lalu
`cd /data/coolify/services/m3snvk67018khyzuz9dhkh4h && docker compose up -d --no-deps accapi-frontend accapi-backend`.
Image lama mungkin sudah dibersihkan Coolify; tag sha `:<sha main lama>` juga ada di GHCR. Deploy Coolify berikutnya menarik `latest` baru lagi,
jadi Cara A tetap wajib menyusul.

**Basis data TIDAK dikembalikan.** Semua DDL bersifat EXPAND dan image lama tetap jalan. Bukti dari kepala berkas:
- DDL_S7_0: "Image LAMA tidak terganggu (tabel baru tanpa pembaca + kolom ber-DEFAULT false)".
- DDL_K1A, DDL_S7_2, DDL_K1B: "Image LAMA tidak terganggu". DDL_K2A: "kolom baru nullable, tidak dibaca kode lama".
- DDL_S6E2: "Image LAMA tidak terganggu oleh kolom nullable + tabel baru (EXPAND)". migrate-pg S6: "EXPAND saja … Tanpa backfill, tanpa drop".
- DDL_ADR004 dan DDL_OUTBOX_EVENT hanya memasang trigger/REVOKE pada tabel baru yang tidak disentuh kode lama.

Yang TIDAK kembali sendiri:
- (a) E5 bisa mengubah status antrean lama menjadi `unknown`; pada 12 Okt ada 0 baris. Image main mengenal status itu, tetapi tidak punya tombol "Selesaikan".
- (b) Perubahan user.role dari bintang atau perpindahan grup di layar baru tetap tersimpan.
- (c) **`RBAC_S7_1B_PENSIUN.sql` menghapus kunci yang dipakai image lama.** Karena itu langkah ini ditunda ke H+1. Bila sudah terlanjur dan harus rollback,
  `jalankan RBAC_S7_1B_PULIH.sql` (mode cek) lalu `terapkan RBAC_S7_1B_PULIH.sql`. Berkas ini memulihkan pasangan grup-kunci dari jejak `permission_audit_log` PENSIUN;
  VERIFIKASI "belum kembali" harus 0. Hanya dijalankan sesudah image lama kembali hidup.
- (d) Kunci D-01 (`RBAC_D01_KUNCI`) dan kunci baru lain hanya berupa teks yang diabaikan image lama. Efek sampingnya: layar Akses Group lama menolak menyimpan
  grup Finance/Admin/Manager ("Key tidak valid"). Bila grup itu harus disunting sebelum rilis berikutnya, ORK menyiapkan SQL terarah untuk mencabut
  kunci tersebut (**PERLU KONFIRMASI**). `DATABASE_MIGRATION_URL` aman bagi image lama, karena migrate-pg lama hanya mencetak SKIP.

## 8. Sosialisasi (kirim H-1; ulangi saat pembekuan selesai)
- **Semua:** tampilan baru. Sesudah rilis, tutup tab lama lalu muat ulang (Ctrl+Shift+R), atau tutup dan buka lagi aplikasi ponsel.
  "Akses ditolak" berarti izin belum diberikan; lapor Admin.
- **Login Accurate** (Fakturist, Admin, Finance, kelak Admin Incaso): di halaman **Sesi Accurate** (`/sesi-accurate`), lalu pilih database.
  Konsol `/api-wrapper` hanya untuk pemegang izin Konsol (Admin, Fakturist, Manager).
- **Fakturist:** Kirim menampilkan pratinjau (database + daftar SO). "Tidak pasti" JANGAN dikirim ulang; yang menyelesaikan adalah Manager.
  Antre ulang mencari faktur di Accurate dulu, jadi sesi Accurate harus aktif. Faktur tidak bisa lagi ditulis lewat Konsol. Salesman wajib dipilih saat antre.
  **Pelunasan tidak lagi bisa dikirim Fakturist** (owner 12 Okt).
- **Admin & Finance (pengirim pelunasan sampai Admin Incaso terisi):** Pelunasan lewat `/pelunasan` (Jenis → Unggah → Akun → Tinjau → Hasil).
  Pelunasan yang mirip riwayat (pelanggan + tanggal + faktur + nominal) ditahan sampai Finance mengizinkan. Baris "Tidak pasti" diselesaikan Finance.
  Kiriman yang dikunci sebelum rilis tidak bisa diteruskan; ulangi dari Tinjau.
- **Staff Keuangan:** rekaman yang sudah diajukan (SPPD terbit) terkunci sampai Finance memberi "Ajukan Ulang". No. LPB ganda ditolak.
  Unggahan memakai pratinjau dulu. Nomor SPPD tidak bisa turun dan mulai dari 001 setiap tahun.
  Rekaman dengan Nilai Invoice kosong tetap tidak bisa masuk keranjang (seperti sekarang).
- **Finance:** posting Purchase Payment terkunci ke database sesi. Jawaban Accurate yang belum pasti mengunci baris sampai di-"Selesaikan" (alasan ≥ 15 huruf).
  Hanya Finance yang bisa menyelesaikan, termasuk untuk posting yang dibuat Admin atau Manager.
- **Manager:** Selesaikan faktur tidak pasti. [MENYUSUL S7-1b] Di OPC hanya membaca dan mengekspor. Claim Workflow tetap seperti sekarang. Pelunasan bukan wewenang Manager.
- **Admin:** layar User & Akses Group baru. ★ = grup utama: bintang pada grup preset menurunkan role, dan pindah ke grup custom menjadikan role viewer.
  User tidak boleh tanpa grup. Mengatur sandi atau menonaktifkan user mencabut sesinya. Admin terakhir tidak bisa dicabut.
- **Insentif:** impor Excel menolak teks yang bukan angka ("-" = 0). Tandai lunas terkunci bila konstanta gagal dibaca.
- **Kasir / OM:** layar Kasir menyusul (K2b). Data pelunasan mulai dibaca otomatis.

## 9. Lampiran
### 9.1 Prasyarat per PR (feat/fiori)
| PR | Slice | Prasyarat deploy (dari badan PR) |
|---|---|---|
| #116–#131, #135 | S0–S5 UI + jawaban owner | tidak ada (UI saja; server #132–#134 sudah di main) |
| #136 | S6-0a Finance anti ganda | kunci finance.* ke Finance (→ RBAC_D01_KUNCI); `DATABASE_MIGRATION_URL` (ADA); DDL_ADR004 sesudah migrasi + `\dp`; sosialisasi |
| #137, #139 | S6-0b kunci ledger · S6-0c angka ketat | tidak ada migrasi/kunci. #139: pindai `payments.json` (§1.5: GO) |
| #141 | S6-0d Outbox faktur | `DATABASE_MIGRATION_URL`; DDL_OUTBOX_EVENT sekali sebelum Kirim; `order.resolve_unknown` (→ RBAC_D01_KUNCI, Manager) |
| #142 | S6-0e server Pembayaran | `sppd.download` ke pengunduh/pengaju (pra-cek: tidak ada yang kurang); sosialisasi Staff Keuangan |
| #143–#149, #151, #153 | S6 UI + susulan | tidak ada (env `ACCURATE_INVOICE_DB_ID` sudah ADA) |
| #150 | S6e-2a server Pelunasan | `pelunasan.kirim` (→ RBAC_D01_KUNCI + BL37); DDL_S6E2; kunci sebelum rilis tak terkirim; round-trip baca-saja Accurate — SELESAI 11 Okt (`S6e2-BUKTI-ROUNDTRIP`) |
| #152 | S6e-2b wizard | Finance juga butuh `pelunasan.kirim` (→ RBAC_D01_KUNCI); login Accurate tanpa Konsol (#159) |
| #155 | S7-0 skema | DDL_S7_0 SEBELUM image; BACKFILL diulang saat S7-1 |
| #156, #162 | S7c Masuk/sandi · susulan S7-sesi | tidak ada |
| #157 | S7-1 otorisasi | urutan S7_0 → CEK_ROLE → image → BACKFILL → CEK_ROLE → BL37 → KASIR; `ACCURATE_SYNC_USER_ID` WAJIB (ADA) |
| #158 | K1a Kasir skema | DDL_K1A SEBELUM image; BL37 → KASIR sesudah |
| #159 | S7-sesi | tanpa env baru; Konsol tertutup bagi non-`api_wrapper.view` (sosialisasi); kunci D-01 terpasang |
| #160 | S7-2 principal | DDL_S7_0 → DDL_S7_2 SEBELUM image; PRINCIPAL_EKSPOR → owner meninjau benih |
| #161 | S7a UI User/Grup | sosialisasi Admin; muat ulang tab lama |
| #163 | K1b Kasir pembaca | K1A → S7_2 → K1B SEBELUM image; sync = admin semua cabang; crontab UTC (§5 langkah 12) |
| MENYUSUL | S7-1b kunci+proxy · K2a server Kasir | KUNCI sebelum image, PENSIUN sesudah (H+1; pulihkan = PULIH) · DDL_K2A sebelum image |

### 9.2 Berkas SQL (commit terakhir yang mengubahnya)
DDL_S7_0 `0fd3c387` · DDL_K1A `94273e92` · DDL_S7_2 `d3027925` · DDL_K1B `d12bd886` · DDL_ADR004 `0b426ea4` · DDL_OUTBOX_EVENT `864781ba` ·
DDL_S6E2 `63b4f7d3` · RBAC_S7_1_CEK_ROLE `72f2efc5` · RBAC_PRESET_BL37 `a02d41e0` · RBAC_PRESET_KASIR `364f34d7` · PRINCIPAL_EKSPOR `d80614c1` ·
[cabang `docs/fiori-runbook-rilis`] RILIS_CEK_PRA `76ebdc96` · RBAC_D01_KUNCI + RBAC_S7_1B_PULIH `74bef012` ·
[MENYUSUL, cabang `feat/fiori-s7-1b-kunci`] RBAC_S7_1B_CEK `b629740c` · RBAC_S7_1B_KUNCI `9dec7f41` · RBAC_S7_1B_PENSIUN `653f85a3` ·
[MENYUSUL, cabang `feat/fiori-k2a-kasir-server`] DDL_K2A `1bc96802`. Hari-H, ambil semua dari commit yang di-merge (1.1), bukan dari cabang ini.

### 9.3 Kontak & peran (isi sebelum H-1)
| Peran | Tugas | Nama / kontak |
|---|---|---|
| Owner | go/no-go, merge, rollback, izin UAT, nama staf grup baru | (isi) |
| Orkestrator | PR, CI, verifikasi log, membaca hasil SQL | (isi) |
| IT Support | SSH VPS, Coolify, psql, crontab | (isi) |
| Pemilik akun sinkron Accurate | login ulang + pilih database | (isi) |
| Penguji per peran (§6) | Admin, Fakturist, Staff Keuangan, Finance, Manager, SPV/SM, Salesman | (isi) |
