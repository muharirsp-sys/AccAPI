# RUNBOOK RILIS FIORI — `feat/fiori` → `main` (= deploy produksi)

Disusun 12 Okt 2026 dari badan PR #116–#163, kepala tiap berkas `docs/handover/DDL_*.sql` / `RBAC_*.sql`, `scripts/migrate-pg.mjs`
dan HANDOFF-FIORI §00/§0. Dasar: `origin/main` 3382552b, `origin/feat/fiori` 2450c7c9. **S7-1b** dan **K2a** belum masuk feat/fiori:
langkahnya ditandai **[MENYUSUL]**. Dokumen ini hanya berisi perintah. Tidak ada yang sudah dijalankan ke produksi.

Tanda: **[IT]** IT Support (SSH VPS, Coolify, psql) · **[ORK]** orkestrator (GitHub `gh`, verifikasi) · **[OWNER]** keputusan ·
⛔ = titik henti: lanjut hanya bila semua butir di atasnya beres · **PERLU KONFIRMASI** = belum pasti, tanyakan dulu sebelum dijalankan.

## 0. Ringkasan

1. **Bagi pengguna:** semua layar memakai tampilan Fiori yang baru. Halaman Masuk/sandi baru, menu mengikuti izin, dan Beranda berbeda per peran.
   Pelunasan pindah ke `/pelunasan`. Antrean Faktur sekarang punya pratinjau dan status "Tidak pasti". Posting Finance tidak bisa ganda.
   Pembayaran yang sudah diajukan terkunci. Login Accurate pindah ke `/sesi-accurate`. Konsol hanya terbuka bagi pemegang `api_wrapper.view`.
   Layar User & Akses Group baru memakai ★ grup utama. Kasir baru sampai cache otomatis; layarnya menyusul.
2. **Durasi:** H-1 sekitar 1 jam. Hari-H sekitar 2,5–3,5 jam: cadangan 15–40 mnt, SQL 15 mnt, CI dan deploy 20–35 mnt,
   langkah sesudah image 30 mnt, uji asap 45 mnt. Bila prasyarat benar, situs mati hanya ±1–3 mnt saat container diganti.
3. **Pembagian kerja:** IT menjalankan VPS, Coolify, dan SQL. Orkestrator mengurus PR, CI, dan verifikasi, lalu merge atas perintah owner.
   Owner memutuskan go/no-go, memberi daftar user → grup baru, dan mengizinkan UAT pelunasan nyata.
4. **Titik henti:** ⛔1 akhir H-1 · ⛔2 cadangan terverifikasi · ⛔3 VERIFIKASI SQL pra-image · ⛔4 perintah merge owner ·
   ⛔5 container hidup + log migrate-pg bersih · ⛔6 uji asap → GO, atau ROLLBACK (§7).
5. **Syarat keras:** `DATABASE_MIGRATION_URL` (role `accapi`) wajib terpasang di Coolify sebelum merge. Tanpa itu container crash-loop dan situs 503.
   Alasannya ada di §3: tidak ada berkas DDL yang membuat tabel migrate-pg S6 (`accurate_write_attempt*`, `idempotency_override`, `invoice_outbox_event`).

**JANGAN:** jalankan `scripts/seed-rbac-presets.ts` ke produksi (PR #136/#158). Jangan menyunting `.env` service untuk nilai permanen,
karena deploy berikutnya menimpanya. Jangan memakai `docker restart` untuk menerapkan env. Jangan DROP tabel/kolom baru saat rollback.
Jangan mengirim sandi lewat chat. Jangan memakai auto-merge atau `--admin`.

## 1. H-1 (sehari sebelum, baca-saja kecuali 1.3)

### 1.1 Siapkan berkas SQL di VPS [ORK → IT]
Jalankan di PC orkestrator (Git Bash, checkout repo). `REF` = commit yang akan di-merge, sesudah S7-1b dan K2a masuk feat/fiori.
```bash
cd D:/AccAPI/_github_clean && git fetch origin && REF=origin/feat/fiori && mkdir -p tmp/rilis-fiori
for f in RILIS_CEK_PRA DDL_S7_0 RBAC_S7_1_CEK_ROLE DDL_K1A DDL_S7_2 DDL_K1B DDL_K2A RBAC_S7_1B_CEK RBAC_S7_1B_KUNCI DDL_ADR004 \
         DDL_OUTBOX_EVENT DDL_S6E2 RBAC_PRESET_BL37 RBAC_PRESET_KASIR RBAC_S7_1B_PENSIUN PRINCIPAL_EKSPOR; do
  git show "$REF:docs/handover/$f.sql" > "tmp/rilis-fiori/$f.sql" 2>/dev/null || { echo "BELUM ADA: $f"; rm -f "tmp/rilis-fiori/$f.sql"; }; done
ssh root@43.156.118.114 'mkdir -p /root/rilis-fiori' && scp tmp/rilis-fiori/*.sql root@43.156.118.114:/root/rilis-fiori/
```
Di VPS, setiap sesi SSH baru, definisikan dulu nama container dan fungsi pembantu. Fungsi tidak terbawa ke sesi berikutnya.
```bash
cd /root/rilis-fiori
F=$(docker ps --format '{{.Names}}' | grep '^accapi-frontend' | head -1); B=$(docker ps --format '{{.Names}}' | grep '^accapi-backend' | head -1); echo "$F | $B"
jalankan() { docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < "$1" > "log-$1.txt" 2>&1; echo "== $1 kode keluar: $? (0=ok, 3=galat SQL)"; tail -n 40 "log-$1.txt"; }
```
Kode keluar 0 belum berarti benar. Baca juga blok VERIFIKASI di akhir log: setiap `ok` harus `t`. `NULL`/kosong = tidak berlaku.

### 1.2 Cek baca-saja database [IT]
- [ ] `docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 -v sync_id="$(docker exec "$F" printenv ACCURATE_SYNC_USER_ID)" < RILIS_CEK_PRA.sql > cek-pra.txt 2>&1; echo $?` lalu `less cek-pra.txt`
- [ ] Bagian **1**: `accapi_app ada` = true, CREATE = false, kedua baris default privileges = **true**. Bila salah satu berbeda → BERHENTI dan lapor ORK.
- [ ] Bagian **2**: semua `sesuai = ya`. Bila ada `BEDA`, objek itu sudah pernah dibuat. SQL rilis tetap idempoten, tetapi laporkan ke ORK.
  Baris 10 (`idempotency_override`) menentukan posisi DDL_S6E2 (§3 dan §5).
- [ ] Bagian **3a** (E5) semuanya 0. Bila ada yang > 0 dan `ACCURATE_INVOICE_SEND=on` (1.3) → **PERLU KONFIRMASI** ORK: matikan kirim otomatis sampai §5 langkah 2.
- [ ] Bagian **3c** `tanpa_grup` = 0. Simpan **4a/4b/4c** untuk keputusan 1.7. Bagian **0**: catat `ukuran_db`.
- [ ] [MENYUSUL] `jalankan RBAC_S7_1B_CEK.sql` (baca-saja; sudah dijalankan ORK 12 Okt). Hasilnya memuat email staf, jadi simpan di VPS saja.

### 1.3 Env di container & Coolify [IT]
- [ ] Cetak hanya ADA/TIDAK, tanpa nilai:
```bash
for v in DATABASE_MIGRATION_URL ACCURATE_SYNC_USER_ID ACCURATE_INVOICE_DB_ID CRON_SECRET; do docker exec "$F" sh -c "[ -n \"\$$v\" ] && echo '$v: ADA' || echo '$v: TIDAK'"; done
docker exec "$F" sh -c 'echo "ACCURATE_INVOICE_SEND=${ACCURATE_INVOICE_SEND:-(kosong)}"; u="${DATABASE_MIGRATION_URL#*://}"; echo "pengguna migrasi: ${u%%[:@]*}"'
grep -n 'post-invoices' /etc/cron.d/accapi || echo "tidak ada cron post-invoices"
```
- [ ] `ACCURATE_SYNC_USER_ID`, `ACCURATE_INVOICE_DB_ID`, dan `CRON_SECRET` = ADA. Ketiganya sudah dipakai image main. Bila salah satu TIDAK → BERHENTI.
- [ ] **Pasang `DATABASE_MIGRATION_URL` lewat UI Coolify** (service AccAPI → Environment Variables; jangan dicentang sebagai build variable):
  `postgresql://accapi:<SANDI_ROLE_ACCAPI>@accapi-postgres:5432/accapi`. Host dan port sama dengan `DATABASE_URL`; hanya pengguna dan sandi yang berbeda.
  Sandi role `accapi` ada di `/root/accapi-postgres.env` (**PERLU KONFIRMASI** nama variabelnya). Salin langsung ke Coolify, jangan lewat chat.
- [ ] (Disarankan, **PERLU KONFIRMASI** owner: situs mati ±1 mnt) Coolify → **Redeploy** dengan image main yang sama.
  Lalu ulangi perintah ADA/TIDAK di atas (harus `DATABASE_MIGRATION_URL: ADA`, `pengguna migrasi: accapi`) dan periksa
  `docker logs "$F" 2>&1 | grep migrate-pg | tail -n 12`: 10 baris `SKIP` + `10 migrasi selesai`. Ini membuktikan env sampai ke container sebelum hari-H.

### 1.4 Sesi Accurate akun sinkron [IT + pemilik akun]
- [ ] Baca bagian **5** cek-pra: `env_terisi`, `user_ada`, `ada_sesi`, `session_terisi`, `database_terpilih` = t; `banned` = f; umur < 10 hari.
  Bila tidak, pemilik akun login ulang dan memilih database di Konsol `/api-wrapper` (sesudah rilis: `/sesi-accurate`). Token berlaku ±15 hari.
- [ ] [OWNER] Pastikan di Accurate bahwa akun itu admin yang melihat **SEMUA cabang** (PR #163). Akun yang hanya melihat sebagian cabang memicu `hapus_massal` di Kasir.

### 1.5 Pindai `payments.json` (field uang bertipe teks, PR #139) [IT]
```bash
docker exec -i "$B" python - <<'PY'
import json, os, re, collections
p = os.environ.get("PAYMENTS_DB_PATH", "/app/python_backend/data/payments.json")
d = json.load(open(p, encoding="utf-8")); print("objek JSON:", isinstance(d, dict), "| bagian:", sorted(d) if isinstance(d, dict) else "-")
F = {"nilai_invoice", "nilai_win", "potongan", "nilai_pembayaran", "gap_nilai"}  # = PAYMENT_MONEY_FIELDS python_backend/shared.py
hit, pola = collections.Counter(), collections.Counter()
def jalan(o, bag):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in F and isinstance(v, str): hit[(bag, k)] += 1; pola[re.sub(r"\d", "9", v)[:20]] += 1
            else: jalan(v, bag)
    elif isinstance(o, list):
        for v in o: jalan(v, bag)
for bag, isi in (d.items() if isinstance(d, dict) else []): jalan(isi, bag)
print("field uang bertipe teks:", sum(hit.values())); [print(" ", b, f, n) for (b, f), n in sorted(hit.items())]
[print("  pola", repr(x), n) for x, n in pola.most_common(10)]
PY
```
- [ ] `objek JSON: True`. Backend baru menolak berkas rusak; dulu berkas rusak dianggap kosong. Bila False → BERHENTI.
- [ ] `field uang bertipe teks: 0`. Bila > 0, kirim baris "pola" (angka sudah disamarkan) ke ORK. Parser baca yang longgar kini memberi 0 untuk pola cacat.

### 1.6 Ruang, jam, dan catatan image sekarang [IT]
- [ ] `df -h / /var/lib/docker`: ruang kosong ≥ 1 × `ukuran_db` (1.2) + 2 GB.
- [ ] `date; date -u; rpm -q cronie; grep -n 'max-time' /usr/local/bin/accapi-cron.sh`. Hasilnya dipakai untuk crontab di §5 langkah 11.
- [ ] `for c in "$F" "$B"; do docker inspect -f '{{.Name}} image={{.Image}} config={{.Config.Image}} dibuat={{.Created}}' "$c"; done | tee image-sebelum.txt`. Diperlukan untuk rollback cepat (§7).
- [ ] (Disarankan) Lakukan uji cadangan §2 malam ini untuk mengukur waktu. Hasilnya sekaligus menjadi cadangan tambahan.

### 1.7 Keputusan sebelum hari-H [OWNER, dicatat ORK]
- [ ] **Jendela waktu dan pembekuan.** Pilih Minggu, atau ≥ 21.00 WITA, dan hindari cron sinkron :15. Selama jendela, tidak ada kiriman pelunasan, faktur, atau unggah.
- [ ] **Daftar user → grup baru.** Grup Admin Incaso, Kasir, dan Admin Gudang dibuat KOSONG oleh BL37. Grup "Fakturist" sudah ada di produksi,
  sehingga BL37 **tidak menyentuhnya**; kuncinya dicocokkan manual dengan D-01 §B.
- [ ] **Kunci D-01 untuk grup lama** (§5 langkah 8): grup mana mendapat `pelunasan.kirim`. Lihat 4c "kirim tulis Konsol hari ini".
  Termasuk grup Admin? D-01 hanya menyebut Admin Incaso dan Finance (**PERLU KONFIRMASI**).
  Juga putuskan cara memberinya: layar sesudah image (ada jeda terkunci beberapa menit), atau SQL terarah sebelum image.
  Berkas SQL untuk ini BELUM ADA di repo (**PERLU KONFIRMASI**: ORK menulisnya dengan pola `RBAC_S7_1B_KUNCI.sql`).
- [ ] **Izin UAT** 1 pelunasan nyata kecil (§6). `idempotency_log` produksi kosong, jadi penjaga ganda belum pernah diuji dengan data nyata.

⛔1: semua butir 1.2–1.7 beres, `DATABASE_MIGRATION_URL` = ADA, dan owner memberi tanggal.
Bila owner menolak memasang `DATABASE_MIGRATION_URL`, rilis TERTAHAN sampai ORK menyiapkan SQL pemilik untuk 7 entri migrate-pg S6 (lihat §3 "Kenapa").

## 2. Cadangan (hari-H, sebelum SQL apa pun) [IT]
```bash
mkdir -p /root/cadangan && cd /root/cadangan && T=$(date +%Y%m%d-%H%M)
time docker exec accapi-postgres pg_dump -U accapi -d accapi -Fc -Z 6 > accapi-pra-fiori-$T.dump; echo "kode: $?"; ls -lh accapi-pra-fiori-$T.dump
docker exec -i accapi-postgres pg_restore -l < accapi-pra-fiori-$T.dump > daftar-$T.txt; echo "kode: $?"; grep -c 'TABLE DATA' daftar-$T.txt
docker cp "$B":/app/python_backend/data backend-data-$T && du -sh backend-data-$T      # payments.json, users.json, setelan SPPD
docker exec "$F" du -sh /app/data   # unggahan frontend (bukti Kasir K2a akan disimpan di sini). Bila < 2 GB: docker cp "$F":/app/data frontend-data-$T
```
- [ ] Kedua `kode: 0`, berkas dump > 0 byte, dan jumlah `TABLE DATA` kira-kira sama dengan `jumlah_tabel_public` (cek-pra bagian 0).
- [ ] Perkiraan waktu dump ±2 mnt per GB `ukuran_db` (VPS 2 core). Selama dump berjalan, aplikasi tetap hidup.
  SQL §3 baru boleh dijalankan **sesudah dump selesai**, karena dump menahan kunci baca dan `lock_timeout` 5 dtk di DDL akan gagal.
- [ ] (Opsional, **PERLU KONFIRMASI** owner, data sensitif) salin dump ke luar VPS.

⛔2: cadangan terverifikasi.

## 3. SQL SEBELUM image [IT] (urut; semuanya role pemilik `accapi`, idempoten, aman untuk image lama)
| # | Perintah (di `/root/rilis-fiori`) | Harus terlihat | Bila tidak |
|---|---|---|---|
| 1 | `jalankan DDL_S7_0.sql` | VERIFIKASI 13 baris `t`; VERIFIKASI BACKFILL 2 baris `t` | BERHENTI, lapor ORK |
| 2 | `jalankan RBAC_S7_1_CEK_ROLE.sql` (baca-saja) | 4 daftar; catat jumlah per daftar (pembanding §5) | — (informasi) |
| 3 | `jalankan DDL_K1A.sql` | VERIFIKASI semua `t` | BERHENTI |
| 4 | `jalankan DDL_S7_2.sql` (butuh #1) | VERIFIKASI semua `t` | BERHENTI. Galat "trigger trg_principal_code_tetap tidak terpasang persis" = ulangi #1 |
| 5 | `jalankan DDL_K1B.sql` (butuh #3) | VERIFIKASI semua `t` (termasuk "prasyarat K1a") | BERHENTI |
| 6 | [MENYUSUL K2a] `jalankan DDL_K2A.sql` | VERIFIKASI semua `t` | BERHENTI |
| 7 | [MENYUSUL S7-1b] mode cek: `jalankan RBAC_S7_1B_KUNCI.sql` | ringkasan NOTICE + VERIFIKASI, lalu ERROR "S7-1b MODE CEK" dan **kode 3** = NORMAL | — |
| 8 | [MENYUSUL S7-1b] terapkan: `docker exec -i -e PGOPTIONS='-c rbac.terapkan=1' accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < RBAC_S7_1B_KUNCI.sql` | kode 0; VERIFIKASI "audit_read tanpa audit_export" = 0 | BERHENTI |
| 9 | Hanya bila cek-pra bagian 2 baris 10 (`idempotency_override`) = **t**: `jalankan DDL_S6E2.sql` | VERIFIKASI 8 baris `t` | BERHENTI. Bila baris 10 = f → JANGAN di sini, pindah ke §5 |

**Kenapa DDL_ADR004 dan DDL_OUTBOX_EVENT TIDAK di sini** (berbeda dengan HANDOFF §0): menurut kepala kedua berkas, keduanya dijalankan
"SESUDAH image baru hidup". Sebelum image, tabelnya belum ada, jadi berkas hanya mencetak NOTICE dan tidak memasang apa pun.
DDL_S6E2 meng-ALTER `idempotency_override`, padahal tabel itu baru dibuat migrate-pg (entri `idempotency_lock_owner_override`).
Bila dijalankan sebelum tabel itu ada, berkas gagal "relation does not exist". Tabel S6 dibuat migrate-pg saat container start, dan
itu hanya mungkin dengan `DATABASE_MIGRATION_URL` (`accapi_app` tidak punya CREATE; `DDL_APP_ROLE_2026-08-24.sql`).
- [ ] Jalankan ulang `RILIS_CEK_PRA.sql` (simpan ke `cek-pra-2.txt`). Baris 18–26 (dan 27 bila K2a) kini `ada = t`; baris lain sama dengan H-1.

⛔3: semua VERIFIKASI `t`. Lalu umumkan "pembekuan mulai", dan pastikan tidak ada pelunasan yang sedang dikirim (`idempotency_log` bagian 3b tidak bertambah).

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

## 5. SESUDAH image [IT] (segera, berurutan; pembekuan tetap berlaku sampai langkah 3)
| # | Perintah | Harus terlihat |
|---|---|---|
| 1 | `jalankan DDL_ADR004.sql` lalu `docker exec accapi-postgres psql -U accapi -d accapi -c '\dp accurate_write_attempt*'` | VERIFIKASI 10 baris `t` (PR #136). `accapi_app` pada `_reopen` tanpa `w`/`d`/`D` |
| 2 | `jalankan DDL_OUTBOX_EVENT.sql` (sebelum ada yang menekan Kirim faktur atau cron kirim berjalan) | NOTICE "E5: n baris … dikunci" (sama dengan cek-pra 3a); VERIFIKASI 7 baris `t` |
| 3 | `jalankan DDL_S6E2.sql` (bila belum di §3 #9) | VERIFIKASI 8 baris `t` |
| 4 | `jalankan DDL_S7_0.sql` (ulang, untuk BACKFILL bintang; PR #155/#157) | VERIFIKASI + VERIFIKASI BACKFILL `t` |
| 5 | `jalankan RBAC_S7_1_CEK_ROLE.sql` | daftar 3 kosong; bandingkan dengan §3 #2 dan lapor ORK |
| 6 | `jalankan RBAC_PRESET_BL37.sql` | kode 0. "Fakturist" yang sudah ada dilewati (benar) |
| 7 | `jalankan RBAC_PRESET_KASIR.sql` (butuh #6) | kode 0, tanpa NOTICE "grup … tidak ada". Bila ada NOTICE: periksa nama grup OM/Admin |
| 8 | Admin di `/admin/groups` dan `/admin/users` (tekan Ctrl+Shift+R dulu; tab lama menganggap kunci baru "usang", PR #161) | lihat daftar di bawah |
| 9 | [MENYUSUL] `jalankan RBAC_S7_1B_CEK.sql` | bagian 2b dan 3 = 0 baris |
| 10 | [MENYUSUL] `RBAC_S7_1B_PENSIUN.sql`: mode cek dulu, terapkan **H+1** sesudah ⛔6 GO (PERLU KONFIRMASI) | mode cek kode 3; terapkan: "sisa_kunci_pensiun" = 0 |
| 11 | Crontab K1b + uji (lihat di bawah) | `?check=1` menjawab 200/202 |
| 12 | `docker exec -i accapi-postgres psql -U accapi -d accapi -qAt -v ON_ERROR_STOP=1 < PRINCIPAL_EKSPOR.sql > principal-ekspor.json` → ORK membuat laporan offline → owner meninjau `benih.sql` (tidak harus hari-H) | 1 baris JSON |

**Langkah 8, kunci & anggota** (D-01, PR #136/#141/#142/#150/#152/#159). Kerjakan di `/admin/groups`, simpan per grup:
- [ ] **Finance:** + `finance.resolve_unknown`, `finance.override_duplicate`, `finance.repost_payment`, `pelunasan.kirim`.
  `finance.update` dicabut dari Manager (Q3) nanti, sesudah audit D-17.
- [ ] **Manager:** + `order.resolve_unknown` (Q1).
- [ ] Setiap grup di cek-pra 4c "ajukan keranjang … tanpa sppd.download": + `sppd.download`.
- [ ] Grup di 4c "kirim tulis Konsol hari ini": + `pelunasan.kirim`, sesuai keputusan 1.7.
- [ ] **Fakturist** (grup lama) memegang `dashboard.view`, `order.view/create/edit/export`, `sales_history.view`, `principles.view`.
- [ ] `/admin/users`: masukkan user ke **Admin Incaso**, **Kasir**, dan **Admin Gudang** sesuai daftar owner. Tandai ★ untuk user yang punya > 1 grup (cek-pra 3c).
  Bintang pada grup preset MENURUNKAN `user.role`.

**Langkah 11, crontab K1b** (KASIR-KONTRAK §7; owner: UTC eksplisit, `--max-time 900`). Tulis berkas BARU `/etc/cron.d/accapi-kasir`:
```
CRON_TZ=UTC
*/15 23   * * 0-5 root /usr/local/bin/accapi-cron.sh /api/cron/kasir-pelunasan >> /var/log/accapi-kasir.log 2>&1
*/15 0-12 * * 1-6 root /usr/local/bin/accapi-cron.sh /api/cron/kasir-pelunasan >> /var/log/accapi-kasir.log 2>&1
0    13   * * 1-6 root /usr/local/bin/accapi-cron.sh /api/cron/kasir-pelunasan >> /var/log/accapi-kasir.log 2>&1
30   11   * * 1-6 root /usr/local/bin/accapi-cron.sh '/api/cron/kasir-pelunasan?penuh=1' >> /var/log/accapi-kasir.log 2>&1
```
Hasilnya 07.00–21.00 WITA Senin–Sabtu tiap 15 mnt, ditambah baca penuh 19.30 WITA. **PERLU KONFIRMASI** dari 1.6:
(a) cron = cronie, yang mendukung `CRON_TZ`. Bila tidak, hapus baris itu dan pakai jam WITA dari KASIR-KONTRAK §7
(`*/15 7-20 * * 1-6`, `0 21 * * 1-6`, `30 19 * * 1-6 …?penuh=1`).
(b) `accapi-cron.sh` memakai `--max-time` ≥ 900. Bila tidak, ganti pemanggilnya dengan
`curl -fsS --max-time 900 -H "Authorization: Bearer <CRON_SECRET dari .env service>" https://web-super.online/api/cron/kasir-pelunasan`.
- [ ] Uji: `/usr/local/bin/accapi-cron.sh '/api/cron/kasir-pelunasan?check=1'`. Jawaban 200 atau 202 = normal; 401 = secret; 503 = sesi sinkron (1.4).

## 6. Uji asap per peran [ORK + penguji tiap peran; sebelum pembekuan dicabut]
Semua akun: buka `/login` (tampilan baru), masuk, lalu periksa bahwa menu samping sesuai izin dan Beranda tampil tanpa strip galat merah.
Jangan menekan tombol tulis kecuali yang disebut di tabel.
| Peran | Buka | Harus aktif/terlihat |
|---|---|---|
| Admin | `/admin/users`, `/admin/groups`, `/sesi-accurate`, `/api-wrapper` | daftar + ★, Object Page (Grup/Keamanan/Riwayat); status sesi; Konsol terbuka |
| Fakturist | `/sesi-accurate` → `/antrean-faktur`, `/orders`, `/principal-order`, `/faktur` | database benar; kartu status; **Kirim** membuka pratinjau dengan nama database (tekan Batal); daftar terbaca |
| Admin Incaso | Beranda, `/pelunasan`, `/api-wrapper` | tile "Perlu tindakan" (angka atau 0); wizard sampai **Tinjau** dengan berkas kecil; `/api-wrapper` = Akses ditolak (BENAR) |
| Staff Keuangan | `/payments` (tab Pengajuan & SPPD), `/payments/sppd` | rekaman yang sudah diajukan terkunci + alasan; **unduh 1 dokumen SPPD berhasil** |
| Finance | `/finance`, `/pelunasan`, `/sesi-accurate` | daftar posting; "Selesaikan tidak pasti" aktif (bukan "tanpa izin"); `/pelunasan` terbuka |
| Manager | `/antrean-faktur`, `/off-program-control`, `/claim-workflow` | Selesaikan tidak pasti aktif; OPC semua tab + ekspor; Claim tetap bisa kelola |
| SPV / SM | `/off-program-control`, `/form-kontrol` (Dashboard SPV), `/insentif-sales` | antrean batch, tim, dashboard terbaca |
| Salesman (ponsel) | `/form-kontrol` (Rute hari ini, Kunjungan), `/sales` | layar 390 px tanpa gulir menyamping; draf order tersimpan |
| OM / Kasir | Beranda | tampil. `/kasir` belum punya layar (K2b menyusul) — wajar |
- [ ] **UAT pelunasan** (izin owner 1.7). Admin Incaso mengirim 1 pelunasan nyata kecil lewat `/pelunasan`. Hasilnya "terkirim" dengan nomor Accurate,
  dan nomor itu ada **satu kali** di Accurate. Unggah berkas yang sama lagi → baris **ditahan** (butuh izin Finance). Lalu periksa:
  `docker exec accapi-postgres psql -U accapi -d accapi -c 'SELECT status, "databaseId" IS NOT NULL AS ada_db FROM idempotency_log ORDER BY "updatedAt" DESC NULLS LAST LIMIT 3;'` → `ada_db = t`.

⛔6: [OWNER] GO, lalu ORK mengumumkan pembekuan selesai. Bila tidak → §7.

## 7. Rollback
**Kapan.** Container crash-loop atau 503 lebih dari 15 mnt dan perbaikan cepat di bawah tidak menolong.
Atau galat 5xx massal di login, Beranda, Antrean, atau Pelunasan yang tidak teratasi dalam 30 mnt.
Atau staf terkunci tanpa jalan cepat (kunci tidak bisa diberikan lewat §5 langkah 8). Atau dugaan posting ganda: hentikan kiriman dulu, baru putuskan.
**Siapa memutuskan:** owner. Bila owner tidak terjangkau dan situs mati > 30 mnt: **PERLU KONFIRMASI** siapa wakilnya.

**Perbaikan cepat (bukan rollback):**
- Log `42501`, `must be owner`, atau `permission denied for schema public` → `DATABASE_MIGRATION_URL` tidak sampai ke container. Periksa dengan perintah ADA/TIDAK (1.3), perbaiki di Coolify, lalu Redeploy.
- `/api/principals` menjawab 503 `PRINCIPAL_DDL_BELUM` → ulangi §3 #1 dan #4.
- Staf mendapat "Akses ditolak" → §5 langkah 8. Admin sendiri tidak bisa membuka `/admin/groups` → periksa grup Admin memegang `users.manage` (cek-pra 4a).

**Cara A (resmi) [ORK, atas perintah owner], ±20–35 mnt:** buat cabang dari `origin/main`, jalankan `git revert -m 1 <hash merge rilis>`,
commit dengan email noreply, push, buka PR → checks → `gh pr merge --merge`. Deploy-nya memasang kembali kode lama.
**Cara B (darurat di VPS) [IT], PERLU KONFIRMASI, belum pernah diuji:** pasang tag `latest` pada image lama dari `image-sebelum.txt`:
`docker tag <image-id-lama> ghcr.io/muharirsp-sys/accapi-frontend:latest` (backend sama), lalu
`cd /data/coolify/services/m3snvk67018khyzuz9dhkh4h && docker compose up -d --no-deps accapi-frontend accapi-backend`.
Image lama mungkin sudah dibersihkan Coolify; tag berbasis sha `:<sha main lama>` juga ada di GHCR. Deploy Coolify berikutnya menarik `latest` baru lagi,
jadi Cara A tetap wajib menyusul.

**Basis data TIDAK dikembalikan.** Semua DDL bersifat EXPAND dan image lama tetap jalan. Bukti dari kepala berkas:
- DDL_S7_0: "Image LAMA tidak terganggu (tabel baru tanpa pembaca + kolom ber-DEFAULT false)".
- DDL_K1A, DDL_S7_2, DDL_K1B: "Image LAMA tidak terganggu". DDL_K2A: "kolom baru nullable, tidak dibaca kode lama".
- DDL_S6E2: "Image LAMA tidak terganggu oleh kolom nullable + tabel baru (EXPAND)". migrate-pg S6: "EXPAND saja … Tanpa backfill, tanpa drop".
- DDL_ADR004 dan DDL_OUTBOX_EVENT hanya memasang trigger/REVOKE pada tabel baru yang tidak disentuh kode lama.

Yang TIDAK kembali sendiri:
- (a) E5 mengubah status antrean lama menjadi `unknown`. Image main mengenal status itu, tetapi tidak punya tombol "Selesaikan", jadi baris itu menunggu rilis berikutnya.
- (b) Perubahan user.role dari bintang atau perpindahan grup di layar baru tetap tersimpan.
- (c) **`RBAC_S7_1B_PENSIUN.sql` menghapus kunci yang dipakai image lama.** Karena itu langkah ini ditunda ke H+1. Bila sudah terlanjur dan harus rollback,
  pulihkan dari `permission_audit_log` (`actor_name = 'SQL RBAC_S7_1B_PENSIUN'`, `detail->'removed'`). SQL pemulihannya belum ada (**PERLU KONFIRMASI**, ORK menulis).

Kunci izin baru (`pelunasan.kirim`, `kasir.*`, `finance.*` baru) hanya berupa teks yang diabaikan image lama, jadi tidak merusaknya.
`DATABASE_MIGRATION_URL` juga aman bagi image lama: migrate-pg lama hanya mencetak SKIP.

## 8. Sosialisasi (kirim H-1; ulangi saat pembekuan selesai)
- **Semua:** tampilan baru. Sesudah rilis, tutup tab lama lalu muat ulang (Ctrl+Shift+R), atau tutup dan buka lagi aplikasi ponsel.
  "Akses ditolak" berarti izin belum diberikan; lapor Admin.
- **Login Accurate** (Fakturist, Admin Incaso, Finance): di halaman **Sesi Accurate** (`/sesi-accurate`), lalu pilih database. Konsol `/api-wrapper` hanya untuk pemegang izin Konsol.
- **Fakturist:** Kirim menampilkan pratinjau (database + daftar SO). "Tidak pasti" JANGAN dikirim ulang; yang menyelesaikan adalah Manager.
  Antre ulang mencari faktur di Accurate dulu, jadi sesi Accurate harus aktif. Faktur tidak bisa lagi ditulis lewat Konsol. Salesman wajib dipilih saat antre.
- **Admin Incaso:** Pelunasan lewat `/pelunasan` (Jenis → Unggah → Akun → Tinjau → Hasil). Pelunasan yang mirip riwayat (pelanggan + tanggal + faktur + nominal)
  ditahan sampai Finance mengizinkan. Kiriman yang dikunci sebelum rilis tidak bisa diteruskan; ulangi dari Tinjau.
- **Staff Keuangan:** rekaman yang sudah diajukan (SPPD terbit) terkunci sampai Finance memberi "Ajukan Ulang". No. LPB ganda ditolak.
  Unggahan memakai pratinjau dulu. Nomor SPPD tidak bisa turun dan mulai dari 001 setiap tahun.
- **Finance:** posting Purchase Payment terkunci ke database sesi. Jawaban Accurate yang belum pasti mengunci baris sampai di-"Selesaikan" (alasan ≥ 15 huruf).
  Izin kirim ulang pelunasan dan Selesaikan ada di `/pelunasan`.
- **Manager:** Selesaikan faktur tidak pasti. [MENYUSUL S7-1b] Di OPC hanya membaca dan mengekspor. Claim Workflow tetap seperti sekarang.
- **Admin:** layar User & Akses Group baru. ★ = grup utama: bintang pada grup preset menurunkan role, dan pindah ke grup custom menjadikan role viewer.
  User tidak boleh tanpa grup. Mengatur sandi atau menonaktifkan user mencabut sesinya. Admin terakhir tidak bisa dicabut.
- **Insentif:** impor Excel menolak teks yang bukan angka ("-" = 0). Tandai lunas terkunci bila konstanta gagal dibaca.
- **Kasir / OM:** layar Kasir menyusul (K2b). Data pelunasan mulai dibaca otomatis.

## 9. Lampiran
### 9.1 Prasyarat per PR (feat/fiori)
| PR | Slice | Prasyarat deploy (dari badan PR) |
|---|---|---|
| #116–#131, #135 | S0–S5 UI + jawaban owner | tidak ada (UI saja; server #132–#134 sudah di main) |
| #136 | S6-0a Finance anti ganda | kunci `finance.resolve_unknown/override_duplicate/repost_payment` ke Finance; `DATABASE_MIGRATION_URL`; DDL_ADR004 sesudah migrasi + `\dp`; sosialisasi |
| #137, #139 | S6-0b kunci ledger · S6-0c angka ketat | tidak ada migrasi/kunci. #139: pindai `payments.json` |
| #141 | S6-0d Outbox faktur | `DATABASE_MIGRATION_URL`; DDL_OUTBOX_EVENT sekali sebelum Kirim; `order.resolve_unknown`; sosialisasi Fakturist |
| #142 | S6-0e server Pembayaran | `sppd.download` ke grup pengunduh/pengaju; sosialisasi Staff Keuangan |
| #143–#149, #151, #153 | S6 UI + susulan | tidak ada (env `ACCURATE_INVOICE_DB_ID` sudah dipakai main) |
| #150 | S6e-2a server Pelunasan | `pelunasan.kirim` (Admin Incaso, Finance); DDL_S6E2; kunci sebelum rilis tak terkirim; round-trip baca-saja Accurate — SELESAI 11 Okt (`S6e2-BUKTI-ROUNDTRIP`) |
| #152 | S6e-2b wizard | Finance juga butuh `pelunasan.kirim`; Admin Incaso login Accurate (diselesaikan #159) |
| #155 | S7-0 skema | DDL_S7_0 SEBELUM image (crash-loop 42501 tanpa itu); BACKFILL diulang saat S7-1 |
| #156, #162 | S7c Masuk/sandi · susulan S7-sesi | tidak ada |
| #157 | S7-1 otorisasi | urutan S7_0 → CEK_ROLE → image → BACKFILL → CEK_ROLE → BL37 → KASIR; `ACCURATE_SYNC_USER_ID` WAJIB |
| #158 | K1a Kasir skema | DDL_K1A SEBELUM image (juga bila ada DATABASE_MIGRATION_URL); BL37 → KASIR sesudah |
| #159 | S7-sesi | tanpa env baru; Konsol tertutup bagi non-`api_wrapper.view` (sosialisasi); kunci D-01 terpasang |
| #160 | S7-2 principal | DDL_S7_0 → DDL_S7_2 SEBELUM image; PRINCIPAL_EKSPOR → owner meninjau benih |
| #161 | S7a UI User/Grup | sosialisasi Admin; muat ulang tab lama |
| #163 | K1b Kasir pembaca | K1A → S7_2 → K1B SEBELUM image; sync = admin semua cabang; crontab UTC |
| MENYUSUL | S7-1b kunci+proxy · K2a server Kasir | KUNCI sebelum image, PENSIUN sesudah (H+1) · DDL_K2A sebelum image |

### 9.2 Berkas SQL (commit terakhir yang mengubahnya)
DDL_S7_0 `0fd3c387` · DDL_K1A `94273e92` · DDL_S7_2 `d3027925` · DDL_K1B `d12bd886` · DDL_ADR004 `0b426ea4` · DDL_OUTBOX_EVENT `864781ba` ·
DDL_S6E2 `63b4f7d3` · RBAC_S7_1_CEK_ROLE `72f2efc5` · RBAC_PRESET_BL37 `a02d41e0` · RBAC_PRESET_KASIR `364f34d7` · PRINCIPAL_EKSPOR `d80614c1` ·
[MENYUSUL, cabang `feat/fiori-s7-1b-kunci`] RBAC_S7_1B_CEK `b629740c` · RBAC_S7_1B_KUNCI `9dec7f41` · RBAC_S7_1B_PENSIUN `653f85a3` ·
[MENYUSUL, cabang `feat/fiori-k2a-kasir-server`] DDL_K2A `1bc96802`. Hari-H, ambil semua dari commit yang di-merge (1.1), bukan dari cabang ini.

### 9.3 Kontak & peran (isi sebelum H-1)
| Peran | Tugas | Nama / kontak |
|---|---|---|
| Owner | go/no-go, merge, rollback, izin UAT, daftar user → grup | (isi) |
| Orkestrator | PR, CI, verifikasi log, membaca hasil SQL | (isi) |
| IT Support | SSH VPS, Coolify, psql, crontab | (isi) |
| Pemilik akun sinkron Accurate | login ulang + pilih database | (isi) |
| Penguji per peran (§6) | Admin, Fakturist, Admin Incaso, Staff Keuangan, Finance, Manager, SPV/SM, Salesman | (isi) |
