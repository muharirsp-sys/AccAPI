# MASTER HANDOVER CONTEXT — handover11.md (Insentif SM, Finance SPV/SM, Audit Modul Insentif Sales)

> Penerus `handover10.md`. Fokus = **modul Insentif Sales** (`/insentif-sales`): fitur insentif SM,
> penyambungan SPV/SM ke Finance, lalu **audit menyeluruh 4-agent paralel** atas seluruh modul dan
> perbaikannya. Dibuat 2026-08-24. Branch `main`, HEAD `b843029` (sudah di origin).
> Semua angka, hash, nama kolom, dan hasil verifikasi di dokumen ini diverifikasi ke git, file Excel
> sumber, dan output psql produksi — bukan ingatan.

---

## 1. RINGKASAN SESI

Sesi ini menghasilkan **8 commit** (`772d0d8` → `b843029`), semuanya sudah di `origin/main`.

| Commit | Isi |
|---|---|
| `772d0d8` | Insentif SM + SPV/SM masuk alur pembayaran Finance; fix C0/C1/C3 dari audit |
| `be5580d` | Upload target tidak lagi menyimpan target 0 & principal dummy |
| `879a34f` | Perbaikan audit Kelompok 1–4 (H1–H7, M1–M13) |
| `7eb58ee` | C2 tuntas — 5 handler pindah ke `onConflictDoUpdate` |
| `c9dab6a` | M10 — baris tanpa Principal/Cabang ditolak |
| `80aa90b` | L2b & L1c; runbook role DB non-owner (L1g) |
| `5374691` | L2d — whitelist SM & filter `_OFFICE` pakai kata utuh |
| `b843029` | Runbook L1g: password di-generate di VPS |

Verifikasi setiap commit: worktree bersih, `npx tsc --noEmit` exit 0, `npm run lint` **255 warning,
0 error**, 7 test unit pure PASSED.

---

## 2. FITUR BARU

### 2.1 Insentif SM — `lib/insentif-sm-calc.ts`

**Strata FLAT berbasis Value saja.** Tidak dikali persentase, tidak ada komponen AO/EC/IA.
Satu pembayaran per SM per periode.

| Pencapaian | Insentif |
|---|---|
| < 90 % | Rp 0 |
| 90 – 99,99 % | Rp 1.500.000 |
| 100 – 109,99 % | Rp 2.500.000 |
| ≥ 110 % | Rp 3.500.000 |

Celah 99–100 % **sengaja** masuk strata 1,5jt (dikonfirmasi user).

Aturan yang dikunci sebagai test:
- **Whitelist**: `SM_BERHAK_INSENTIF = ["HENDRIK"]`. ADNAN tidak ikut skema (total 0, tapi tetap
  tampil dengan pencapaiannya + label "tidak ikut skema").
- **SEMUA status principal dihitung, TERMASUK `principle`/ENERGIZER** — beda dari GT/MT/SPV.
  Dikonfirmasi user: yang dinilai adalah Value total wilayah SM, bukan porsi distributor.
- **Baris `_OFFICE` dibuang** (`isOfficeRow`).

### 2.2 SPV & SM masuk alur pembayaran Finance — `lib/insentif-payee.ts`

Dititipkan ke tabel `incentive_payments` yang sudah ada lewat **prefiks `sales_code`**:
`SPV:<nama>` / `SM:<nama>`, dengan `principle` = `"-"` (`PAYEE_PRINCIPLE_ALL`). **Tanpa migrasi DB.**

`payeeCode()` / `parsePayee()` — kode sales asli tidak pernah memakai `:`, jadi tidak bisa
bertabrakan. Test mengunci kasus paling gampang salah: `SPV_SUMARTONO` (kode sales nyata di file
target, pakai underscore) **tidak** boleh terbaca sebagai SPV.

UI: tabel pembayaran Finance dapat kolom **Peran** (badge Sales/SPV/SM), header "Salesman" →
"Penerima". Alur Tandai Lunas sama persis — tidak ada kode terpisah untuk SPV/SM.

### 2.3 `GET /payments` — `month` jadi OPSIONAL

Dulu absen → default bulan berjalan, sehingga strip "Rekap Pembayaran Tahunan" yang cuma mengirim
`?year=` **selalu balik 1 bulan saja** dan 11 bulan lain tampak "belum ada data". Sekarang tanpa
`month` = seluruh tahun.

---

## 3. AUDIT MODUL — `docs/handover/AUDIT_INSENTIF_SALES_2026-08-24.md`

Metode: 4 sub-agent paralel (kalkulasi, query/DBA, validasi & akses, konsistensi lintas layer).
26 temuan. Setiap klaim struktural di-spot-check ulang langsung ke kode sebelum dilaporkan.

**Laporan lengkapnya ada di file itu** — jangan ulangi auditnya, baca dulu. Isinya termasuk
§2 "yang sengaja TIDAK direkomendasikan diubah" dan §3 "dugaan yang dicek dan TIDAK terbukti".

### 3.1 Empat temuan CRITICAL (semua sudah FIXED)

**C0 · `SUM()` kolom integer balik sebagai STRING.** `achievedEc/Ao/Ia` bertipe `integer`;
`SUM(integer)` di Postgres = **bigint (OID 20)**, dan `pg-types` tidak punya parser untuk OID 20 →
nilainya kembali sebagai `string`. Anotasi `sql<number>` hanya kebohongan tingkat tipe.
`foldMerged` lalu melakukan `into.realAo += from.realAo` = **konkatenasi**. AO 100 + AO 20 →
`"10020"` → `10020/240` → cap 1,00 → **insentif AO Rp 700.000 dibayar penuh padahal seharusnya 0**.
Menimpa tepat orang-orang yang fitur `sales-code-merge` dibuat untuk mereka.
Fix: `::double precision` pada 6 ekspresi SUM di `lib/insentif-sales.ts`.

> **Verifikasi cepat:** `node -e "require('pg-types').getTypeParser(20,'text')('42')"` → `"42"` (string).
> `achievedValueDpp` aman karena `doublePrecision` → SUM = float8 → number.

**C1 · Upload Laporan Harian memusnahkan data closing Insentif Sales.** Dua penulis ke
`sales_daily_progress` dengan cakupan DELETE tidak kompatibel: `progress/route.ts` per
`(salesCode, principle, periode)`; `laporan-harian/ingest.ts` **seluruh periode**. Upload Laporan
Harian untuk bulan yang sama membuang seluruh ~4.000 baris closing, tanpa error. `spv_name` juga
tidak diisi → deteksi `/spv-mismatch` mati senyap.
Fix: cakupan disamakan, **plus `date` masuk kunci** (lihat M13).

**C2 · Tiga tabel uang tanpa UNIQUE constraint.** `spv_support` & `sales_code_merge` punya;
`sales_targets`, `incentive_payments`, `incentive_support` tidak — asimetri yang jelas kelupaan.
Duplikat membuat `n` mix salah → konstanta naik → nominal salah tanpa error. Untuk
`incentive_support` lebih jahat: dashboard membacanya lewat `new Map()` tanpa `ORDER BY` →
**baris terakhir menang secara acak**, support beda antar refresh.
Fix: DDL dijalankan di produksi + 5 handler pindah ke `onConflictDoUpdate` (lihat §4).

**C3 · Baris `_OFFICE` masih ikut di `/dashboard`.** Karena `/dashboard` menyuapi `FinanceView`,
baris `MTS1_OFFICE` **bisa ditandai Lunas** — sistem membuat catatan pembayaran untuk pos kantor.
Data nyata Juli 2026: 16 baris `_OFFICE` membawa target Rp 13.446.598.066.

### 3.2 Temuan lain yang layak diingat

| Kode | Inti masalah |
|---|---|
| **H2** | `getCurrentSpvOwner` dipanggil DI DALAM loop `POST /targets` → upload 88 baris = **176 full-scan** `sales_targets`. Sekarang dihitung sekali (`getSpvOwnerMap`). |
| **H5** | Header Excel dicocokkan string PERSIS. Excel bisa menyimpan versi terformat (`cell.w`) berbeda dari nilai mentah (`cell.v`) — file user punya `" Target Value (Rp) "` berspasi → **seluruh file jatuh ke target 0**. Ini benar-benar terjadi. |
| **H7** | `spvName`/`smName` tanpa `trim()`. `"MARTEN"` vs `"MARTEN "` = dua grup. Untuk SM yang strata-nya FLAT: **Rp 5 juta untuk satu orang**. |
| **M4** | `SUM(double)` di Postgres tidak deterministik terhadap urutan → rasio 0,9999999999 vs 1,0000000001 = beda Rp 1 juta **yang berubah antar refresh**. Fix: `roundRatio(1e-6)`. |
| **M9** | Baris LUNAS dulu menampilkan angka hitung-ulang di sebelah badge "lunas". Sekarang tampil snapshot yang benar-benar dibayar + penanda selisih. |
| **M11** | Parser angka closing tidak mengenal format Indonesia: `-533.000.000` terbaca **`-533`**. |
| **M13** | `date` tidak ikut kunci hapus → upload closing minggu-2 menghapus minggu-1. |

### 3.3 Yang ternyata SUDAH BENAR (jangan diaudit ulang)

- Agregasi memakai `SUM()` + `GROUP BY` **di SQL**, bukan di JS. ~4.000 baris diringkas jadi ~90
  sebelum lewat jaringan. Ini bagian terkuat modul ini.
- `POST /progress` **sudah** transaksional dengan chunk 1.000 baris sejak awal — pola yang dicontoh
  6 POST lainnya.
- Tidak ada route mutasi yang dijaga cuma `insentif_sales.view`. Semua 12 route tulis punya
  permission sendiri.
- Auto-claim `salesCode` tidak bisa dipakai mencuri kode SPV lain — nama diambil dari
  `identity.name` **sisi server**, bukan body request.
- Tidak ada SQL injection. Bypass auth lokal butuh 3 syarat sekaligus.
- Semua batas tier/strata konsisten, tanpa celah maupun tumpang tindih.
- **Utang teknis lama yang dikonfirmasi TIDAK lebih besar dari catatannya:** kolom ISQ salah di
  `dashboard/route.ts` murni tampilan (`pIsq` tidak pernah menyentuh objek `incentive`); asumsi
  "IA per outlet" MT justru **lebih konservatif** daripada alternatifnya.

---

## 4. ATURAN BISNIS BARU YANG DIKONFIRMASI USER (2026-08-24)

Semua sudah **dikunci sebagai test**. Jangan ubah tanpa instruksi eksplisit.

### 4.1 H6 — mix dengan 1 principal valid TETAP dapat insentif
`konstantaMix(1)` dulu = 0 → insentif **Rp 0 diam-diam**. Sekarang jatuh ke `RP_1JT`, sejajar
`computeMtMix` (MT) yang sudah punya fallback itu sejak awal.
Kasus nyata: sales pegang KINO (skema) + ENERGIZER (`principle`) → valid tinggal 1.

### 4.2 L2b — penjualan bersih harus POSITIF sebelum komponen aktivitas dibayar
> "tidak mungkin ada AO tanpa adanya penjualan bersih positif"

Dua KPI GT dulu independen: Value memakai realisasi (negatif → 0, benar), tapi **AO memakai
konstanta 240 sebagai penyebut dan tidak melihat Value sama sekali**. Kasus nyata MOTASA: target
Rp 700jt, realisasi **−Rp 21,4jt** (retur murni) → tetap dibayar Rp 700.000.

- `computeExclusive`: realisasi ≤ 0 → ZERO
- `computeMix`: per-baris. Principal minus tidak dapat AO **maupun** porsi Value global — alokasi
  Value memakai share **target**, jadi tanpa guard ini tetap kebagian.
- **MT ikut**: `fromPool()` menolak realisasi ≤ 0. Logikanya sama untuk EC/OA/IA — semuanya
  dihitung dari transaksi.

### 4.3 M13 — closing yang sudah masuk tidak boleh hilang karena upload berikutnya
`date` masuk kunci hapus di **dua** penulis: `progress/route.ts` DAN `laporan-harian/ingest.ts`.

### 4.4 L1c — satu kode sales hanya boleh punya SATU baris per principal
Kode sama dengan principle **berbeda** tetap sah (itu sales mix). Yang ditolak: pasangan
`salesCode+principle` muncul dua kali dalam satu upload. Pesan error menyebut kodenya + kedua
cabangnya kalau berbeda — karena itu gejala paling berbahaya (acuan Value berubah DPP↔NILAI_JUAL).

### 4.5 M10 — baris tanpa Principal/Cabang DITOLAK
Default `"NESTLE"`/`"BANDUNG"` dicabut dari `parseTargetExcel` (keduanya data DEMO dari `data.ts`).
Ditolak di **3 lapis**: parser, validator upload, `POST /targets`.
`Channel` tetap default `"TT"` — sama dengan default kolom di `db/schema.ts`, bukan nilai karangan.

---

## 5. MIGRASI DB YANG SUDAH DIJALANKAN DI PRODUKSI (2026-08-24)

Dijalankan user, semua sukses, semua `indisvalid = t`. Cek duplikat **bersih (0 rows)** di ketiga
tabel sebelum unique index dibuat.

```sql
-- docs/handover/DDL_AUDIT_INSENTIF_2026-08-24.sql
ALTER TABLE sales_targets      ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE incentive_payments ADD COLUMN IF NOT EXISTS updated_by text;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sdp_code_prin_period_date
  ON sales_daily_progress (sales_code, principle, period_year, period_month, date);

-- docs/handover/DDL_UNIQUE_INSENTIF_2026-08-24.sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sales_targets_key
  ON sales_targets (sales_code, principle, period_month, period_year);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_incentive_payments_key
  ON incentive_payments (sales_code, principle, period_month, period_year);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_incentive_support_key
  ON incentive_support (sales_code, principle, period_month, period_year);
```

**Urutan ini penting dan sengaja:** DDL dijalankan DULU, kode `onConflictDoUpdate` menyusul di
commit terpisah. Kalau dibalik, ketiga POST itu error 500 sampai DDL jalan — `ON CONFLICT` butuh
constraint yang cocok sudah ada di DB.

Setelah DDL sukses, 5 handler pindah ke `onConflictDoUpdate` (`7eb58ee`): `targets`, `payments`,
`support`, `spv-support`, `code-merge` (+ `onConflictDoNothing` untuk klaim `spv_sales_assignment`
— klaim lama TIDAK ditimpa). Round-trip DB per baris turun dari 2 jadi 1.

`createdAt` sengaja **tidak** ikut di-set saat konflik — baris lama mempertahankan waktu buatnya.

---

## 6. L1g — ROLE DB NON-OWNER (SEDANG DIKERJAKAN USER)

Runbook: `docs/handover/DDL_APP_ROLE_2026-08-24.sql`.

**Masalah:** `lib/db.ts` dan `lib/auth.ts` sama-sama memakai `DATABASE_URL`, dan kredensial itu
menunjuk user `accapi` yang **pemilik database** — punya `DROP TABLE`. Data komersial (target
value, support/rebate per-principal, payout per orang, DPP harian) diakses dengan kredensial yang
sama yang dipakai Better Auth untuk tabel session/user.

**Status per 2026-08-24, sudah diverifikasi di produksi:**

| Pengecekan | Hasil |
|---|---|
| Role `accapi_app` login | ✅ `accapi_app \| accapi` |
| `rolsuper/rolcreatedb/rolcreaterole/rolcanlogin` | ✅ `f f f t` |
| Tabel ter-grant | ✅ 53 |
| `CREATE TABLE` sebagai `accapi_app` | ✅ **ditolak** — `permission denied for schema public` |
| Ganti `DATABASE_URL` di Coolify + Redeploy | ⏳ **belum** |

**Sisa langkah:** tempel baris `DATABASE_URL` ke **Coolify UI** (BUKAN edit `docker-compose.yml` —
file itu diregenerasi tiap redeploy), Redeploy, lalu **lakukan satu tulisan ringan** di aplikasi
(mis. simpan support 1 baris). Halaman yang berhasil dimuat cuma membuktikan `SELECT`.

**Rollback:** kembalikan `DATABASE_URL` ke kredensial `accapi` lewat Coolify UI → Redeploy.
Role `accapi_app` boleh dibiarkan ada.

**Pelajaran dari sesi ini (dua kali hampir salah):**
- Heredoc `<<'SQL'` (dengan kutip) membuat `${APP_PW}` tersimpan **harfiah** sebagai password.
  Untuk blok yang memakai variabel, wajib `<<SQL` tanpa kutip.
- `rolcreatedb`/`rolcreaterole` **tidak** menentukan boleh-tidaknya bikin TABEL — itu hak `CREATE`
  di level schema. Di PostgreSQL < 15, schema `public` memberi `CREATE` ke semua role secara
  bawaan, jadi uji `CREATE TABLE` yang HARUS gagal itu bukan formalitas. (Produksi ternyata 15+.)
- Password **jangan** dikirim lewat chat/email. Generate di VPS ke variabel shell:
  `APP_PW="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"`. Huruf/angka saja supaya
  aman di dalam URL tanpa encoding. Kalau hilang: `ALTER ROLE accapi_app PASSWORD '<baru>';`

---

## 7. YANG MASIH TERBUKA

### 7.1 Menunggu user
1. **Selesaikan L1g** (§6) — tinggal Coolify + Redeploy + verifikasi tulis.
2. **Upload ulang target Juli 2026.** Target di DB kemungkinan masih **0 semua** dari upload yang
   gagal karena H5. Kunci upsert `salesCode+principle+periode`, jadi baris yang ada ter-update
   bukan menambah duplikat. Toast harus melaporkan **95 baris**.
3. **Target 13 principal ADNAN** — belum ada sama sekali (dari handover9, masih berlaku).
4. **Konfirmasi asumsi IA per outlet** untuk MT (dari handover9, masih berlaku).
5. **Sumber kebenaran SPV** — file target atau kolom GOLONGAN closing. Panel sudah ada, keputusan
   per baris belum diambil (dari handover9).

### 7.2 Temuan LOW yang belum disentuh
Tidak ada yang menyentuh nominal uang.

| Kode | Isi |
|---|---|
| **L1b** | `dikecualikan` sudah dihitung `calculateInsentifSPV` & dikirim route, tapi tidak dibaca UI. Saat SPV turun dari n=10 ke n=9 dan rate naik, tidak ada penjelasan di layar. ~5 baris. |
| **L1d** | `month`/`year` diparse tanpa cek rentang di ~10 route GET. `?month=abc` → kemungkinan 500, bukan 400. |
| **L1e** | `PaymentRow.paymentDate: number \| null` vs kolom `timestamp` (JSON → string ISO). Belum bergejala karena belum dirender. 1 baris. |
| **L1f** | `xlsx@0.18.5` punya CVE tak dipatch di npm. Semua pemakaian **client-side**, file diunggah user internal. Kandidat *accepted risk*. |

### 7.3 Risiko proses (bukan bug)
Repo **tidak punya folder `drizzle/`** — nol migration file, nol `meta/`. Dan
`scripts/init-db.mjs` masih DDL rasa-SQLite yang self-skip kalau `DATABASE_URL` bukan `file:`.
Artinya **tidak ada satu pun artefak di repo yang merepresentasikan skema Postgres produksi**.
Tabel berikutnya yang lupa dibuatkan DDL manual akan gagal sebagai `relation does not exist`
saat runtime, bukan sebagai error deploy.

---

## 8. CARA VERIFIKASI (WAJIB — tidak berubah dari handover9)

**Typecheck & lint di working dir TIDAK BISA DIPERCAYA.** `.next/dev/types/routes.d.ts` bisa
terpotong dan membuat `tsc` berhenti sebelum memeriksa kode asli.

```bash
git worktree add -q /tmp/verify -d HEAD
cd /tmp/verify
cmd //c "mklink /J node_modules D:\AccAPI\_github_clean\node_modules"   # Windows
# salin file yang diubah dari working dir ke sini
npm run lint          # harus 255 warning, 0 error
npx tsc --noEmit      # harus exit 0
```
Lalu `rm -f /tmp/verify/node_modules && git worktree remove --force /tmp/verify`.

`npm run lint` bisa lewat 2 menit — pakai timeout lebih panjang.

Test unit pure (7 modul, semuanya tanpa DB):
```bash
for t in insentif-sales-calc insentif-mt-calc insentif-spv-calc insentif-sm-calc \
         insentif-payee insentif-value-source sales-code-merge; do
  node --experimental-strip-types lib/$t.test.ts
done
```

---

## 9. POLA KERJA GIT (tidak berubah)

- Deploy **hanya** dari `main`. GitHub Actions `.github/workflows/deploy.yml`, job `typecheck`
  menjalankan `npm run lint` lalu `npx tsc --noEmit`.
- User sering bekerja **paralel di direktori yang sama**. **Selalu `git fetch` + cek
  `git log origin/main..main` sebelum push.**
- **Stage per file, jangan `git add docs/` atau `git add -A`.** Working dir penuh file untracked
  milik user (`dashboard-generator/*.py`, `docs/handover/handover2..8.md`, `python_backend/`,
  `outputs/`, dll). Sesi ini sempat tidak sengaja men-stage 10 handover lama — untung ketahuan
  sebelum commit.
- Kalau push ditolak: **rebase, jangan force push**.

---

## 10. FILE REFERENSI

Di repo:
- `docs/handover/AUDIT_INSENTIF_SALES_2026-08-24.md` — laporan audit lengkap, 26 temuan + status
- `docs/handover/DDL_UNIQUE_INSENTIF_2026-08-24.sql` — ✅ sudah dijalankan
- `docs/handover/DDL_AUDIT_INSENTIF_2026-08-24.sql` — ✅ sudah dijalankan
- `docs/handover/DDL_APP_ROLE_2026-08-24.sql` — ⏳ runbook L1g, sedang dikerjakan
- `SYSTEM_MAP.md` bagian "Insentif Sales — Kalkulasi Insentif" — **sudah diperbarui**; sebelumnya
  masih menulis "MT belum ada aturan insentif" dan "SPV belum di-wire", keduanya salah

Di luar repo, `C:\Users\Muhar\Downloads\`:
- `TARGET BULAN JULI 2026 ALL PRINCIPAL (1).xlsx`
- `target_template_7_2026.xlsx` — hasil Download Template yang sudah diisi user; **file inilah yang
  membongkar H5** (4 kolom angka punya header terformat berspasi)
- `REVISI CLOSING FIX_2026-08-03_HENDRIK.xlsx`
- `REKAP SUPPORT INSENTIF PRINSIPAL_PAK HENDRIK.xlsx` — baris `DEVISI = "SPV"` menandai support
  SPV untuk grup di atasnya: SUMARTONO/ABCPI "NO"→0, YARMAN/KINO 300rb, DENNY/ENERGIZER "NO"→0,
  MARTEN/MOTASA 4.172.278

---

## 11. HASIL REPLAY OFFLINE JULI 2026 (SM HENDRIK)

Dihitung dengan modul produksi sebelum perbaikan H6/L2b/`_OFFICE`-di-dashboard, jadi **angka ini
akan berubah** setelah upload ulang. Dicatat sebagai titik banding, bukan target.

| | |
|---|---|
| **SM HENDRIK** | 81 baris (97 − 16 `_OFFICE`), target Rp 15,83 M, realisasi Rp 17,01 M = **107,42 %** → **Rp 2.500.000** |
| **SPV total** | **Rp 8.668.441** (ANI 3.568.441 · DENNY 1.600.000 · MARTEN 800.000 · SUMARTONO 1.500.000 · YARMAN 1.200.000) |

Temuan penting dari replay: **MOTASA nyangkut ke ANI hanya lewat dua baris `_OFFICE`**
(`M-SP26 MTS1_OFFICE`, `M-SP35 MTS2_OFFICE`, SPV=ANI di file target). Semua 10 salesman MOTASA
nyata ada di bawah MARTEN. Begitu `_OFFICE` dibuang, MOTASA hilang sendiri dari ANI — tidak perlu
perbaikan data.

Juga: **Rp 294 juta di closing tanpa baris target** (26 pasangan), terbesar
`M-BSR2 / FOKUS RITEL` Rp 271,6 juta — file target menulis `M-BSR`, closing `M-BSR2`.
Plus 3 pasangan dengan `KODE_SALESMAN` kosong (Rp 4,0 juta). Semuanya hangus.
