# MASTER HANDOVER CONTEXT — handover9.md (Modul Insentif Sales: MT, SPV, Support, Upload Closing)

> Penerus `handover8.md`. Fokus = **modul Insentif Sales** (`/insentif-sales`). Dibuat 2026-08-22. Branch `main`, HEAD saat dokumen ini dibuat `2de8e19` (sudah di origin). Semua angka, hash, dan nama kolom di dokumen ini diverifikasi ke git, file Excel sumber, dan Postgres produksi — bukan ingatan.

---

## 1. TUJUAN UTAMA

Menghitung insentif bulanan untuk **Sales (GT & MT)** dan **SPV** dari dua sumber:
- **File target** per bulan per principal (dibuat manual, Excel).
- **File closing** per SM per bulan (ekspor transaksi level baris barang, Excel).

Sesi ini menyelesaikan: skema insentif MT (sebelumnya selalu Rp 0), support principle untuk Sales & SPV, penggabungan kode sales saat pergantian orang, sinkronisasi SPV antar dua file, dan **memperbaiki bug upload yang membuang 70% realisasi**.

## 2. KONTEKS DASAR

- **Aplikasi:** AccAPI = ERP internal **CV. Surya Perkasa** (distributor FMCG multi-principal).
- **User:** Ari (git), tikuskyun7@gmail.com / muharir.sp@gmail.com. Bahasa Indonesia. Windows 11, PowerShell + Git Bash. Kerja lokal `D:\AccAPI\_github_clean`.
- **Stack:** Next.js 16 / React (TS); PostgreSQL via Drizzle ORM; Better Auth.
- **Produksi:** VPS Coolify `43.156.118.114`, domain `https://web-super.online`. Postgres container `accapi-postgres`, DB/user `accapi`.
- **Deploy:** GitHub Actions `.github/workflows/deploy.yml`, **hanya trigger di branch `main`**. Job `typecheck` menjalankan `npm run lint` lalu `npx tsc --noEmit`; keduanya harus bersih atau tidak ada deploy.
- **Halaman:** `https://web-super.online/insentif-sales`. Tab: Sales, SPV, SM, **Input Penjualan** (`?view=admin`), **Finance** (`?view=finance`).

## 3. ATURAN BISNIS YANG SUDAH FINAL

Semua sudah dikonfirmasi user dan **dikunci sebagai test**. Jangan ubah tanpa instruksi eksplisit.

### 3.1 Insentif Sales GT — `lib/insentif-sales-calc.ts`
1. 2 KPI: **AO bobot 70%, Value bobot 30%**.
2. **Target AO konstan 240** — khusus GT, bukan dari kolom AO file target.
3. Pengali pencapaian: `<90% → 0`; `90–100% → aktual`; `>100% → cap 1,00`.
4. Konstanta pool: exclusive 1jt; mix n=2→1jt, n=3→1,2jt, n=4→1,4jt, n=5→1,5jt, **n>5 cap 1,5jt**.
5. Porsi distributor = `konstanta − total support` (floor 0), lalu dibagi 70/30.

### 3.2 Insentif Sales MT — `lib/insentif-mt-calc.ts` (BARU sesi ini)
1. **4 KPI bobot nominal: VALUE 350rb, EC 150rb, OA 150rb, IA 350rb** = 1jt (Target Kontribusi 100%).
2. **Target OA MT diambil dari kolom AO file target per baris**, BUKAN konstanta 240. Range nyata 34–70.
3. **IA dinilai per outlet**: `realisasi_ia / realisasi_ao` dibanding `target_ia`. Alasan: kolom `Item Aktif` di closing adalah flag per baris transaksi (total 175–2.499), sementara Target IA berkisar 9–45. Rasionya yang sebanding — mis. M-FN target 40, realisasi 2499/65 = 38,4 → 96%. Kalau total mentah dipakai, IA selalu tembus cap dan 350rb dibayar tanpa syarat. **Ini asumsi Claude yang belum ditolak user — layak dikonfirmasi ulang.**
4. Threshold pengali & perlakuan support/status sama dengan GT.
5. MT mix (banyak principal) memakai KONSTANTA_MIX milik GT, pool dibagi rata. Hanya M-YVK yang terkena. Aturan mix khusus MT belum didefinisikan user.

### 3.3 Insentif SPV — `lib/insentif-spv-calc.ts`
1. **Murni Value**, tidak ada komponen AO.
2. Rate per principal: n=1 → flat 1,5jt; n=2..6 → `200rb + 1,2jt/n` (800/600/500/440/400rb); **n>6 → DITAHAN di 400rb**, tidak turun lagi. Dikonfirmasi 2026-08-21 untuk kasus SPV ANI yang pegang 10 principal → rate 400rb, total maks 4jt.
3. Principal valid = minimal 1 baris sales bawahan berstatus skema (bukan semua `principle`).
4. **Support principle SPV:** principal yang support-nya **LEBIH DARI** rate → keluar dari hitungan jumlah principal (rate untuk sisanya naik). Contoh user: 3 principal rate 600rb; satu principal support >600rb → dianggap pegang 2 → rate 800rb. Kasus nyata MARTEN, MOTASA support 4,17jt.
5. Support **tepat sama** dengan rate TIDAK mengeluarkan principal — tetap dihitung, distributor bayar 0 untuknya. Kriteria "lebih dari", bukan "minimal".
6. Support **sebagian** (< rate): principal tetap dihitung, distributor bayar `rate − support`. Contoh YARMAN, KINO 300rb vs rate 1,5jt → distributor 1,2jt.
7. Pengecualian dilakukan **serentak**, bukan satu per satu, supaya hasil tidak bergantung urutan iterasi. Satu lintasan sebenarnya cukup karena `rate(n)` NAIK ketika n turun — tidak mungkin ada gelombang pengecualian kedua.

### 3.4 Support principle untuk Sales
- Support < 1jt → **sisa ditanggung distributor sampai 1jt**, lalu dibagi 70/30 (GT) atau per bobot 4 KPI (MT). Contoh ABCPI Jalani support 540rb → distributor 460rb.
- Support ≥ pool → distributor bayar 0.
- Status `distributor` → support diabaikan, distributor bayar penuh.
- Status `principle` → baris tidak ikut skema dan tidak menambah hitungan principal.

### 3.5 Status Insentif
- **ENERGIZER (5 sales) = `principle`** (full principle). Di file rekap support tertulis "YES" yang artinya principle menanggung seluruhnya.
- **Semua principal lain = `distributor_principle`** (dikonfirmasi 2026-08-21). Ini sudah default kolom di `db/schema.ts:729`, jadi tidak perlu diisi manual.

### 3.6 Acuan Value per cabang — `lib/insentif-value-source.ts` (BARU sesi ini)
- Default semua cabang: **DPP**.
- **VINDA, KINO NON FOOD, MIX NON FOOD: NILAI_JUAL** (sebelum potongan).
- Selisih nyata pada closing Juli 2026: VINDA **23,1%**, MIX NON FOOD **9,9%**, KINO NON FOOD **4,0%**.
- Jebakan yang dijaga test: `MIX FOOD` (punya ADNAN) ≠ `MIX NON FOOD`; `KINO` ≠ `KINO NON FOOD`. Cabang tak dikenal jatuh ke DPP.

### 3.7 Penggabungan kode sales — `lib/sales-code-merge.ts` (BARU sesi ini)
- Pergantian orang di tengah bulan meninggalkan dua kode dengan **prefiks rute sama**: `MS10_ISMAIL KADIR` vs `MS10_TANSI`, `KN2_DINA WAHYUNI` vs `KN2_IRDAWATI ALIM`, `M2_1` dipakai 3 kode.
- Pencapaian digabung ke **sales terbaru**, tapi **TIDAK PERNAH otomatis** — prefiks sama belum tentu pergantian. Bukti: `FS1_GITO ADAM SAPUTRA` (GT) vs `FS1_MT_SYAHRUL RAMADAN` (MT) adalah dua orang berbeda, channel berbeda, nomor rute kebetulan sama.
- User memutuskan per kelompok: **Gabung** (pilih kode tujuan) atau **Pisah**. Keputusan disimpan per periode, diterapkan saat agregasi MTD sehingga bisa diubah tanpa upload ulang.

## 4. YANG DIKERJAKAN SESI INI (semua sudah di `main` & ter-deploy)

| Commit | Isi |
|---|---|
| `bed0cfa` | Skema insentif MT + panel deteksi SPV tidak sinkron + parser upload pindah ke XLSX |
| `9a3760e` | Panel konfirmasi penggabungan kode sales + input support untuk baris MT |
| `be0f853` | Support principle untuk SPV (tabel `spv_support` + aturan pengecualian) |
| `c4f3057` | Kriteria pengecualian SPV jadi "lebih dari" rate, bukan "minimal" |
| `a5e4fa7` | VINDA/KINO NON FOOD/MIX NON FOOD pakai NILAI_JUAL |
| `38bed3a` | **Fix bug upload buang 70% realisasi** + rate SPV n>6 ditahan 400rb |
| `0d398a5` | Fix 2 error tipe yang membuat `main` gagal build |

### File baru
- `lib/insentif-mt-calc.ts` + `.test.ts`
- `lib/insentif-value-source.ts` + `.test.ts`
- `lib/sales-code-merge.ts` + `.test.ts`
- `app/api/insentif-sales/spv-mismatch/route.ts`
- `app/api/insentif-sales/code-merge/route.ts`
- `app/api/insentif-sales/spv-support/route.ts`

### Bug besar yang diperbaiki: upload closing membuang 70% realisasi
Dedup lama memakai `(salesCode, invoiceNumber, periode)` dan meng-skip baris duplikat. **Salah** karena file closing berada di level **baris barang** — satu nota berisi banyak produk (sampai 99 baris di HENDRIK, 135 di ADNAN). Efeknya hanya baris pertama tiap nota tersimpan:

| | HENDRIK | ADNAN |
|---|---|---|
| Baris file | 64.392 | 70.910 |
| Nota unik | 13.378 | 12.258 |
| DPP seharusnya | 27,34 M | 25,01 M |
| DPP tersimpan | 7,90 M | 7,53 M |
| **Hilang** | **71,1%** | **69,9%** |

Upload melaporkan "sukses" tanpa error apa pun, sementara hampir semua sales jatuh di bawah 90% dan dapat Rp 0.

**Solusi:** agregasi di browser per `(salesCode, principle, branch, tanggal)` sebelum kirim → tidak ada lagi duplikat yang perlu di-dedup. Diverifikasi terhadap kedua file asli:

| | HENDRIK | ADNAN |
|---|---|---|
| Baris setelah agregasi | 2.068 (−96,8%) | 1.885 (−97,3%) |
| Baris dibuang | 0 | 0 |
| Selisih Value vs kebenaran | 0,0009 (float) | 0,0002 |

Perbaikan menyertai:
- **POST idempoten**: baris untuk tiap kombinasi `(salesCode, principle, periode)` di payload dihapus dulu lalu disisip borongan per 1000 dalam satu transaksi. Upload dua kali tidak menggandakan; upload file SM lain tidak menyentuh data SM ini.
- **Cabang kosong tidak lagi membuang baris.** File ADNAN punya 2.508 baris retur tanpa `JENISPRODUK` senilai **−533 juta**; membuangnya menaikkan realisasi dari yang sebenarnya. Cabang kini diturunkan dari `PRINCIPAL` memakai baris lain di file yang sama (HEINZ ABC INDONESIA→HEINZ, DOLPHIN→DOLPHIN). Principal ambigu (FORISA punya 2 cabang) dilaporkan lewat toast.
- **Tanggal dari kolom TANGGAL**, bukan tanggal hari upload.
- Parser pindah dari split-koma manual ke `XLSX.read` — menerima `.xlsx` langsung dan tidak salah kolom pada field ber-koma (`"ABC PRESIDENT INDONESIA, PT"`, alamat). Sebelumnya juga `replace(/\D/g,"")` pada DPP **membuang tanda minus** sehingga retur menambah realisasi.

## 5. MIGRASI DB YANG SUDAH DIJALANKAN DI PRODUKSI

Semua sudah `CREATE` sukses 2026-08-19..22. Drizzle tidak dipakai untuk migrate — DDL dijalankan manual via `docker exec`.

```sql
ALTER TABLE sales_daily_progress ADD COLUMN IF NOT EXISTS spv_name text;

CREATE TABLE sales_code_merge (id text PRIMARY KEY, period_month integer NOT NULL,
  period_year integer NOT NULL, prefix text NOT NULL, from_sales_code text NOT NULL,
  to_sales_code text, decision text NOT NULL, decided_by text,
  created_at timestamp NOT NULL, updated_at timestamp NOT NULL);
CREATE UNIQUE INDEX uq_sales_code_merge_from ON sales_code_merge (period_month, period_year, from_sales_code);
CREATE INDEX idx_sales_code_merge_period ON sales_code_merge (period_month, period_year);

CREATE TABLE spv_support (id text PRIMARY KEY, spv_name text NOT NULL, principle text NOT NULL,
  period_month integer NOT NULL, period_year integer NOT NULL,
  support_amount double precision NOT NULL DEFAULT 0, input_by text,
  created_at timestamp NOT NULL, updated_at timestamp NOT NULL);
CREATE UNIQUE INDEX uq_spv_support ON spv_support (spv_name, principle, period_month, period_year);
CREATE INDEX idx_spv_support_period ON spv_support (period_month, period_year);
```

Cara jalankan: `docker exec -it accapi-postgres psql -U accapi -d accapi -c '<SQL>'`.

## 6. PELAJARAN PENTING: CARA VERIFIKASI YANG BENAR

**Typecheck dan lint lokal di `D:\AccAPI\_github_clean` TIDAK BISA DIPERCAYA.** Ini menyebabkan CI #150 dan #151 gagal padahal sudah dilaporkan "0 error".

Penyebab: `.next/dev/types/routes.d.ts` yang dihasilkan dev server bisa dalam keadaan **terpotong**. Parse error di file itu membuat `tsc` **berhenti sebelum memeriksa kode asli**. Menyaring baris `.next` dari output (`grep -v '^\.next'`) menyembunyikan bahwa pemeriksaan tidak pernah selesai — hasilnya kosong dan tampak bersih. `tsconfig.json` juga memakai `incremental: true` dengan `tsconfig.tsbuildinfo` yang bisa basi. Lint lokal juga memberi 79 error palsu karena direktori kerja penuh file untracked.

**Cara yang benar — worktree bersih, sama seperti CI:**

```bash
git worktree add -q /tmp/verify -d HEAD
cd /tmp/verify
cmd //c "mklink /J node_modules D:\AccAPI\_github_clean\node_modules"   # Windows, hemat waktu
npm run lint          # harus 0 errors
npx tsc --noEmit      # harus exit 0
```

Lalu `git worktree remove --force /tmp/verify` (hapus junction `node_modules` dulu).

Angka acuan di worktree bersih: lint **255 warning, 0 error**; tsc **exit 0**.

**Test unit tetap sah** karena benar-benar menjalankan kode:
```bash
for t in insentif-sales-calc insentif-mt-calc insentif-spv-calc sales-code-merge insentif-value-source; do
  node --experimental-strip-types lib/$t.test.ts
done
```

## 7. POLA KERJA GIT YANG DIPAKAI USER

- Branch kerja lama: `feat/urc-deterministic-matcher`. **Deploy hanya dari `main`.**
- User **cherry-pick commit yang dibutuhkan ke `main`**, bukan merge seluruh branch (branch fitur pernah 40 commit / 15.300 baris di depan main).
- User sering bekerja **paralel di direktori yang sama** dan commit di antara pekerjaan agen. **Selalu `git fetch` + cek `git log origin/main..main` sebelum push**, dan push hanya commit yang relevan.
- Untuk cherry-pick tanpa mengganggu working tree user (30+ file untracked): pakai worktree terpisah dari `origin/main`, cherry-pick, verifikasi, push `tmp-branch:main`.
- Kalau push ditolak: **rebase, jangan force push**.

## 8. STRUKTUR FILE TARGET & CLOSING

### File target (`TARGET BULAN <BULAN> <TAHUN> ALL PRINCIPAL.xlsx`)
Kolom C..L: Principal, **Jenis Produk = Cabang**, Kode Salesman, Nama Salesman, Target Value, Target EC, Target OA, Target IA, SPV, SM.

Jebakan:
- **Kolom A "Conca" bergeser 1 baris** relatif ke C..L. Jangan dipakai sebagai kunci.
- 16 baris `_OFFICE` bukan salesman tapi bawa target besar — harus dibuang.
- Baris `SPV_SUMARTONO` (M-SMR) ada di daftar sales padahal dia SPV.
- Kolom **Channel, SPLM Value, Tipe Sales, Status Insentif tidak ada di file**. Channel & Tipe Sales bisa diturunkan (dari `_MT_` di nama, dan dari jumlah principal per kode); dua lainnya harus diisi.
- Kode dobel lintas principal = sales mix (M-BSR 5×, M-RDR/M-ABD/M-RNO 4×). Ini benar, kunci upsert `salesCode+principle+periode`.

### File closing (`REVISI CLOSING FIX_<tanggal>_<SM>.xlsx`)
Sheet 1 = transaksi (level baris barang), sheet 2 = stock. Kolom yang dipakai: `KODE_SALESMAN`, `SALESMAN`, `PRINCIPAL`, `JENISPRODUK`, `GOLONGAN` (=SPV), `TANGGAL`, `NO_NOTA`, `DPP`, `NILAI_JUAL`, `AO`, `EC`, `Item Aktif`, `Mapping_PIC.NAMA SM`.

`AO`/`EC` adalah **flag 0/1 per baris** — harus **SUM**, bukan MAX. (Catatan: `computeMtdProgress`/`computeMtdByPrinciple` di `lib/insentif-sales.ts` masih memakai `MAX` untuk AO & IA pada agregasi DB. Karena upload sekarang sudah mengagregasi per hari, MAX mengambil nilai harian tertinggi, bukan total bulan. **Ini perlu ditinjau** — lihat §10.)

## 9. HASIL PERHITUNGAN JULI 2026 (HENDRIK, offline replay)

Dihitung dengan modul produksi, asumsi status `distributor_principle` dan **support 0** (data support belum dimasukkan ke DB).

- **GT: 53 sales → Rp 12.488.220**
- **MT: 11 sales → Rp 7.188.347**
- **Total: Rp 19.676.567**

SPV (support belum masuk): ANI 10 principal, DENNY 7, SUMARTONO 4, MARTEN 3, YARMAN 1.

Cross-check target vs closing:
- 13 principal HENDRIK **cocok 100%** dengan file target.
- 93 dari 97 baris target punya realisasi.
- **22 pasangan sales×principal ada di closing tapi tidak di target**, terbesar `M-BSR2 / FRN5_BASRI YUSUF` DPP 271,6 jt — target menulis kode `M-BSR`, closing `M-BSR2`.
- **36 dari 93 baris SPV-nya beda** antara file target dan kolom GOLONGAN (target MARTEN vs closing YUDI; target ANI vs closing SAHAR/DENNY).
- **ADNAN tidak punya target sama sekali** — 13 principal, 88 pasangan sales×principal.

## 10. YANG MASIH TERBUKA

### Menunggu user
1. **Target 13 principal ADNAN** (GODREJ, HEINZ ABC, FONTERRA, URC, RECKITT, MEGA SURYA MAS, FKS FOOD, DOLPHIN, GUMINDO, MARKETAMA, PRIMARASA, SUN PAPER, UNIVERSAL INDOFOOD). Tanpa ini tim ADNAN tidak muncul di perhitungan mana pun. User bilang "menyusul".
2. **Konfirmasi asumsi IA per outlet** untuk MT (§3.2 poin 3).
3. **Sumber kebenaran SPV** — file target atau kolom GOLONGAN closing. Panel sudah ada, keputusan per baris belum diambil.
4. **Aturan mix khusus MT** kalau tidak mau memakai KONSTANTA_MIX milik GT.

### BLOCKER — harus diselesaikan sebelum angka produksi dipercaya

5. **`MAX` untuk AO & IA membuat komponen AO nyaris selalu 0.**
   `lib/insentif-sales.ts:152-153` (`computeMtdProgress`) dan `:192-193` (`computeMtdByPrinciple`) memakai `MAX(achieved_ao)` dan `MAX(achieved_ia)`, sementara Value & EC memakai `SUM`. Komentar aslinya bilang "AO/IA diambil MAX (snapshot harian, bukan kumulatif)" — asumsi itu berlaku untuk bentuk input lama di mana tiap baris harian membawa snapshot kumulatif. **Dengan ingesti file closing, asumsi itu salah:** `AO`/`EC` adalah flag 0/1 per baris transaksi, dan upload sekarang menjumlahkannya per hari.

   Akibatnya `MAX` mengembalikan **puncak satu hari**, bukan total bulan. Untuk GT dengan target AO 240, realisasi jadi belasan → pengali AO 0 → **komponen 70% hangus untuk hampir semua sales**.

   **Angka di §9 dihitung dengan SUM**, bukan MAX. Jadi output sistem yang ter-deploy saat ini akan **jauh lebih rendah** dari Rp 12.488.220 / Rp 7.188.347 yang dilaporkan. Skala membuktikan SUM yang benar: realisasi AO hasil SUM berkisar 150–256 terhadap target 240; MAX harian tidak sebanding dengan skala target mana pun.

   Perbaikan yang diusulkan: ubah keduanya jadi `SUM`. Perlu konfirmasi pemilik aturan dulu karena menyentuh nominal — tapi tanpa ini angka AO tidak bisa dipakai.

### Utang teknis yang ditemukan tapi belum disentuh
6. **Kolom achievement ISQ salah.** `app/api/insentif-sales/dashboard/route.ts` menghitung `isqTgt = itemSuper(targetIa, targetAo)` → untuk GT 6/240 = 0,025, sementara rasio realisasi sekitar 5, sehingga persentasenya meledak. Bug tampilan lama, berlaku semua channel. Sengaja tidak diubah karena mengubah angka yang mungkin sudah dipakai orang.
7. **Verifikasi browser belum pernah dilakukan.** Panel `SpvMismatchSection`, `CodeMergeSection`, `SpvSupportInputSection`, dan tabel insentif MT **belum pernah dilihat render**. Semua verifikasi berupa test unit + replay offline. Butuh `DATABASE_URL` ke Postgres VPS untuk menjalankan dev server.

## 11. LANGKAH PEMAKAIAN (untuk user)

Di `https://web-super.online/insentif-sales`:

> **JANGAN pakai angka insentif dari sistem sebelum blocker §10.5 (`MAX` vs `SUM` untuk AO) diputuskan.** Upload dan panel konfirmasi aman dijalankan; yang belum bisa dipercaya adalah nominal komponen AO.

1. **Tab Input Penjualan** → set periode **Juli 2026** (default bulan berjalan!) → mode Upload → drop `.xlsx` HENDRIK. Toast harusnya melaporkan sekitar **64.392 baris diringkas jadi ~2.068 baris harian**. Kalau jauh berbeda, ada yang salah.
2. Ulangi untuk ADNAN. **Jangan digabung jadi satu file** — kolom `Mapping_PIC.NAMA SM` sudah membedakan, upload idempoten per kombinasi, dan kalau gagal jadi tahu file mana.
3. Selesaikan **panel Konfirmasi Penggabungan Sales**. Ingat `FS1` (GITO GT vs SYAHRUL MT) = **Pisah**.
4. Selesaikan **panel SPV Tidak Sinkron** (36 baris).
5. **Tab Finance** → isi support per-sales (ABCPI 540rb ×4, KINO 500rb ×6, MOTASA per baris) dan **Support Principle — SPV** (YARMAN 300rb, MARTEN 4.172.278).
6. Perbaiki file target: `Status Insentif = principle` untuk 5 sales ENERGIZER, isi `SPLM Value`, perbaiki kode `M-BSR` → `M-BSR2`.

## 12. FILE REFERENSI DI LUAR REPO

Ada di `C:\Users\Muhar\Downloads\`:
- `TARGET BULAN JULI 2026 ALL PRINCIPAL (1).xlsx`
- `REVISI CLOSING FIX_2026-08-03_HENDRIK.xlsx`
- `REVISI CLOSING FIX_2026-08-03_ADNAN.xlsx`
- `REKAP SUPPORT INSENTIF PRINSIPAL_PAK HENDRIK.xlsx`

Rekap support: kolom DEVISI, NAMA SALES, DISTRIBUTOR (kosong), PRINSIPAL (nominal atau "YES"/"NO"). Baris `SPV` menandai batas kelompok. Pemetaan nama ke kode yang sudah dikonfirmasi: IRDA→M-IDW, ISHAK→M-ISQ, SULIS→M-SLT, RIDAYANTI→M-RST. Nama ganda (`EKA/SAIFUL`, `LUFIDAR/ZULFIKAR`, `KHADIJAH/SULIS`, `SUNARDI/YURLINA DARWIS`) → yang dapat hanya yang ada di file target.

Support SPV **tidak bisa diturunkan** dari support sales: rasionya beda per principal (KINO 10% dari total sales-nya, MOTASA 50%). Harus diinput manual.
