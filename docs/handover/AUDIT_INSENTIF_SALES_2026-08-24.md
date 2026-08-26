# AUDIT MODUL INSENTIF SALES — 2026-08-24

> Audit read-only saat ditulis. **Perbaikan menyusul** — lihat baris "Status" di tiap temuan.
> Ringkasan status per 2026-08-24: C0/C1/C3 FIXED; C2 & M1 & M7 menunggu DDL dijalankan di VPS;
> H1-H7 FIXED; M2-M6, M8, M9, M11-M13 FIXED; M10 sebagian; L1/L2 belum disentuh.
> Metode: 4 sub-agent paralel (kalkulasi, query/DBA, validasi & akses, konsistensi lintas layer)
> atas branch `main` HEAD `3ef1702` + perubahan uncommitted sesi ini. Setiap temuan di bawah sudah
> di-spot-check ulang langsung ke kode; yang tidak terbukti dipindah ke §3.

Peta modul: `SYSTEM_MAP.md` bagian "Insentif Sales — Kalkulasi Insentif" (diperbarui hari ini —
sebelumnya masih menulis "MT belum ada aturan insentif" dan "SPV belum di-wire", keduanya salah).

---

## 1. Temuan, urut dari paling berisiko

### C0 · CRITICAL · `SUM()` kolom integer balik sebagai STRING → `foldMerged` mengonkatenasi

> **Status: FIXED** (2026-08-24). `sql<number>` di `lib/insentif-sales.ts` sekarang cast
> `::double precision` pada 6 ekspresi SUM. Pure code, tidak ada dependensi DB/deploy.

**Apa:** `achievedEc/Ao/Ia` bertipe `integer` (`db/schema.ts:749-751`). Di PostgreSQL
`SUM(integer)` menghasilkan **bigint (OID 20)**, dan `pg-types` default **tidak punya parser** untuk
OID 20 → nilainya kembali sebagai `string`. Anotasi `sql<number>` di
`lib/insentif-sales.ts:160-163` dan `:203-206` hanya kebohongan tingkat tipe. Tidak ada
`setTypeParser` di mana pun di `lib/`.

Terverifikasi langsung:

```
node -e "require('pg-types').getTypeParser(20,'text')('42')"   -> string "42"
OID 23 (int4)   -> number 42
OID 701 (float8)-> number 42.5

achievedValueDpp : doublePrecision -> SUM = float8 -> number   AMAN
achievedEc/Ao/Ia : integer         -> SUM = bigint -> string   RUSAK
```

**Skenario gagal:** `foldMerged` (`insentif-sales.ts:103-121`) melakukan
`into.realAo += from.realAo` → **konkatenasi string**. Periode punya 1 keputusan merge
(`sales_code_merge.decision='merge'`, mis. `MS10A → MS10B`). Kode A AO 100, kode B AO 20 — total
nyata 120 dari target 240 = 50% → pengali 0 → insentif AO seharusnya **Rp 0**. Hasil nyata:
`realAo = "10020"` → `10020/240 = 41,75` → cap 1,00 → **insentif AO Rp 700.000 dibayar penuh**.
Selisih Rp 700.000 per salesman-merge per principal — dan ini menimpa tepat orang-orang yang fitur
`sales-code-merge` dibuat untuk mereka.

Pembagian tunggal (`realAo / 240` tanpa merge) tetap benar karena JS meng-coerce string saat
membagi. Jadi bug ini **hanya** aktif pada baris yang di-merge — plus satu efek yang selalu aktif:
baris TOTAL di Tabel Pencapaian (`page.tsx:276-281`) melakukan `reduce((a, r) => a + r.realAo, 0)`
→ `"0218150203"` bukan `571`, sehingga `grandTotal` achievement omong kosong.

**Rekomendasi minimal:** cast di SQL, bukan refactor. Tambahkan `::double precision` di dalam template `sql<number>`. Satu baris per KPI, dua fungsi. Alternatif satu-tempat
`pg.types.setTypeParser(20, Number)` di `lib/db.ts` **tidak** dipilih karena global untuk semua
modul di repo ini.

---

### C1 · CRITICAL · Upload Laporan Harian memusnahkan data closing Insentif Sales

> **Status: FIXED** (2026-08-24) — bagian scoping-nya. `replaceDailyProgressForPeriod` di
> `lib/laporan-harian/ingest.ts` sekarang menghapus per `(salesCode, principle, periode)` dari
> `rows` yang akan disisipkan, bukan seluruh `(month, year)`. Pure code, tidak ada dependensi
> DB/deploy. **Belum terjawab:** pertanyaan pemilik tabel tetap berlaku untuk kasus lain (kalau
> laporan-harian memang dimaksudkan mengganti seluruh bulan termasuk kombinasi yang TIDAK ada di
> upload baru, scoping ini mengubah perilaku itu — tanyakan kalau perilaku laporan-harian sendiri
> berubah dari yang diharapkan).

**Apa:** `sales_daily_progress` punya dua penulis dengan cakupan `DELETE` yang tidak kompatibel.

| Penulis | Cakupan DELETE | Isi `spv_name`? |
|---|---|---|
| `app/api/insentif-sales/progress/route.ts:86` | per `(salesCode, principle, periode)` — sengaja; komentarnya eksplisit di `:74` | ya |
| `lib/laporan-harian/ingest.ts:31` (`replaceDailyProgressForPeriod`) | **seluruh periode** — `period_month` + `period_year` saja | **tidak** (NULL) |

**Skenario gagal:** Admin upload closing 2 SM (~4.000 baris) untuk Juli. Siapa pun lalu menjalankan
upload Laporan Harian untuk Juli → seluruh 4.000 baris terhapus, diganti baris pipeline
laporan-harian saja. Semua dashboard (GT/MT/SPV/SM) menghitung dari himpunan data berbeda.
`computeMtdProgress` cuma men-`SUM` apa yang ada, jadi **tidak ada error, tidak ada peringatan —
angka insentif hanya berubah.** Deteksi `/spv-mismatch` ikut mati senyap karena `spv_name` NULL
untuk semua baris. Arah sebaliknya: upload closing per-SM menimpa sebagian baris laporan-harian →
satu periode berisi campuran dua sumber.

**Perlindungan yang ada sekarang:** hanya kebetulan bahwa kedua jalur belum dipakai untuk periode
yang sama.

**Rekomendasi minimal:** samakan cakupan `ingest.ts:31-32` menjadi per-`(salesCode, principle,
periode)` — bangun `scopes` Map seperti `progress/route.ts:76-82`. Sudah di dalam
`db.transaction`, jadi aman. **TAPI butuh keputusan user dulu:** kalau "ganti seluruh periode"
memang disengaja untuk laporan-harian, yang harus diputuskan adalah tabel ini milik siapa.
Jangan diselesaikan diam-diam di kode.

---

### C2 · CRITICAL · Tiga tabel uang tanpa UNIQUE constraint pada kunci upsert-nya

> **Status: SEBAGIAN** (2026-08-24). `db/schema.ts` sudah punya definisi
> `uq_sales_targets_key` / `uq_incentive_payments_key` / `uq_incentive_support_key`, dan DDL-nya
> ada di `docs/handover/DDL_UNIQUE_INSENTIF_2026-08-24.sql` (cek duplikat dulu, lalu
> `CREATE UNIQUE INDEX CONCURRENTLY`). **Sengaja BELUM dijalankan ke produksi** — repo ini tidak
> punya migration runner (drizzle-kit push manual, DDL dijalankan manual via `docker exec`, sama
> seperti tabel lain), dan saya tidak punya akses ke Postgres produksi untuk memverifikasi tidak
> ada duplikat lebih dulu. **Kode 3 handler (`targets`/`payments`/`support`) juga sengaja BELUM
> diubah ke `onConflictDoUpdate`** — kalau diubah sekarang, ketiga POST itu akan error 500 sampai
> DDL dijalankan di produksi (`ON CONFLICT` butuh constraint yang cocok, dan constraint itu belum
> ada di sana). Urutan yang aman: (1) jalankan DDL di VPS, (2) baru migrasi kode ke
> `onConflictDoUpdate` di sesi terpisah. Sampai itu terjadi, race yang mendasari tetap ada di
> kode aplikasi — DDL sendirian, begitu dijalankan, minimal mengubah "silently jadi duplikat"
> menjadi "gagal dengan error unique-violation yang jelas".

**Apa:** asimetri yang jelas tidak disengaja di `db/schema.ts:710-851`.

```
spv_support        uniqueIndex uq_spv_support             OK
sales_code_merge   uniqueIndex uq_sales_code_merge_from   OK
sales_targets      index period + index code              TIDAK ADA unique
incentive_payments index period + code + status           TIDAK ADA unique
incentive_support  index period + code                    TIDAK ADA unique
```

Kunci `(sales_code, principle, period_month, period_year)` hanya dijaga cek aplikasi
(SELECT-cek-lalu-INSERT), dan loop-nya di luar transaksi.

**Skenario gagal:** bukan soal volume — cukup satu kejadian. Klik Upload dua kali, atau retry
karena request lambat (upload 285 baris = 570 statement berurutan, mudah terasa lambat).
Akibatnya bukan cuma baris kembar: di `lib/insentif-sales-calc.ts:127` `jumlah = valid.length`,
jadi sales mix 3 principal yang salah satunya duplikat terbaca **n=4** → konstanta 1,2jt naik jadi
1,4jt dan `budgetAo` dibagi 4 bukan 3. **Nominal insentif salah tanpa error apa pun.** Panel
Finance menggabungkan duplikatnya lagi lewat key `salesCode::principle` sehingga tidak kelihatan.

Untuk `incentive_support` lebih jahat: `dashboard/route.ts:90` membangun `supportMap` dengan
`new Map(...)` tanpa `ORDER BY` → pada duplikat **baris terakhir menang secara acak**. Support yang
mengurangi konstanta insentif bisa beda antar refresh halaman yang sama.

**Rekomendasi minimal:** cek duplikat dulu, JANGAN langsung `CREATE`.

```sql
SELECT sales_code, principle, period_month, period_year, count(*)
FROM sales_targets GROUP BY 1,2,3,4 HAVING count(*) > 1;   -- ulangi utk 2 tabel lain
```

Kalau bersih:

```sql
CREATE UNIQUE INDEX CONCURRENTLY uq_sales_targets_key
  ON sales_targets (sales_code, principle, period_month, period_year);
CREATE UNIQUE INDEX CONCURRENTLY uq_inc_payments_key
  ON incentive_payments (sales_code, principle, period_month, period_year);
CREATE UNIQUE INDEX CONCURRENTLY uq_inc_support_key
  ON incentive_support (sales_code, principle, period_month, period_year);
```

Lalu ganti SELECT+UPDATE/INSERT di 3 handler jadi `onConflictDoUpdate` — sekaligus memangkas
2 round-trip/baris jadi 1.

---

### C3 · CRITICAL · Baris `_OFFICE` masih ikut di `/dashboard` — dan bisa ditandai Lunas

> **Status: FIXED** (2026-08-24). `isOfficeRow` diimpor dan dipasang di filter `targets` pada
> `app/api/insentif-sales/dashboard/route.ts`, persis pola yang sudah ada di `spv-dashboard`.
> Pure code, tidak ada dependensi DB/deploy.

**Apa:** `grep -c isOfficeRow app/api/insentif-sales/dashboard/route.ts` = **0**, sementara
`spv-dashboard/route.ts:64` dan `lib/insentif-sm-calc.ts:87` sengaja membuangnya.

**Skenario gagal:** `/dashboard` memberi data ke tab Sales **dan** ke `FinanceView`. Baris
`MTS1_OFFICE` (pos target kantor, bukan orang) muncul sebagai salesman dengan capaian rendah —
menyeret "Capaian Tim %" turun secara salah — lalu `computeExclusive`/`calculateInsentifMT` tetap
menghitung nominal untuknya. Di tab Finance baris itu bisa dicentang dan **ditandai Lunas**: sistem
membuat catatan pembayaran insentif untuk entitas yang bukan orang. Data nyata Juli 2026: 16 baris
`_OFFICE` membawa target Rp 13.446.598.066.

**Rekomendasi minimal:** satu `import { isOfficeRow } from "@/lib/insentif-sm-calc"` + satu
`continue` di loop `targets` — persis seperti yang sudah ada di `spv-dashboard/route.ts:64`.

---

### H1 · HIGH · Hanya 1 dari 7 POST yang atomik; `POST /targets` bisa `return` di tengah tulis

> **Status: FIXED — db.transaction + validasi pre-pass di targets/support/spv-support/code-merge.**

```
progress      db.transaction  OK   <- satu-satunya
targets  0    support  0    spv-support  0
code-merge 0  payments 0    spv-mismatch 0
```

**Skenario gagal:** `POST /targets` punya `return 403/400` di `:89`, `:106`, `:120` — di tengah loop
tulis. Upload 88 baris ADNAN, baris ke-50 punya "Status Insentif" tak dikenal (`normalizeStatus`
melempar) → user dapat 400 dan menyimpulkan "upload gagal", padahal 49 baris sudah permanen.
Lebih buruk untuk akun SPV: `return 403` di `:89` terjadi **setelah** beberapa
`spv_sales_assignment` sudah tertulis di `:101` — hierarki berubah walaupun request ditolak.

Untuk `/support`: `return 400` (support negatif) meninggalkan baris sebelumnya commit. Karena
`dashboard/route.ts` mengurangkan support dari konstanta, "setengah support masuk" =
**nominal insentif salah** untuk sebagian orang sampai ada yang menyadari.

**Rekomendasi minimal:** bungkus loop dengan `db.transaction` (pola yang **sudah ada** di
`progress/route.ts:85`), dan pindahkan semua validasi `normalizeTipe`/`normalizeStatus`/numerik ke
pass terpisah **sebelum** loop tulis. ~5 baris per route, nol DDL.

---

### H2 · HIGH · N+1 dengan full-scan di dalamnya pada `POST /targets`

> **Status: FIXED — getSpvOwnerMap() dihitung sekali di luar loop POST /targets.**

**Apa:** `targets/route.ts:87` memanggil `getCurrentSpvOwner` **di dalam** `for (const t of body)`.
Fungsi itu → `lib/insentif-hierarchy-scope.ts:69` → `effectiveSpvBySalesCode` (`:28-37`) yang
menjalankan `db.select().from(spvSalesAssignment)` **dan** `db.select().from(salesTargets)`
**tanpa WHERE**. `scope` dihitung sekali di `:74` dan tidak pernah di-refresh, jadi 5 baris mix
untuk `salesCode` yang sama mengulang seluruh siklus 5×.

**Skenario gagal:** SPV upload target ADNAN (88 baris belum ter-claim) ≈ **535 statement**, di
antaranya **176 scan penuh `sales_targets`**. Sekarang (~3.400 baris/tahun) masih ~2-4 detik.
Dengan ~14.000 baris (3-4 tahun) jadi ~2,5 juta baris dibaca per upload → timeout, dan karena tanpa
transaksi (H1) timeout meninggalkan setengah data.

**Rekomendasi minimal:** hitung `effectiveSpvBySalesCode()` **sekali** sebelum loop, simpan di
`Map`, lalu `spvOf.set(t.salesCode, identity.name)` setelah auto-claim. 88×2 query jadi 2 query.
~4 baris, nol DDL, nol index.

---

### H3 · HIGH · `handleMarkLunas` menembak ~100 POST paralel ke handler tanpa unique

**Apa:** `page.tsx:2258` — `Promise.allSettled` atas seluruh `checkedList`, satu HTTP POST per baris
terpilih secara serentak. Pool: `lib/db.ts:5` + `lib/auth.ts:19` = 20 koneksi.

**Skenario gagal:** Finance "pilih semua" bulan tutup (~97 sales + SPV + SM) ≈ 100 request × ~6
statement ≈ **600 statement** berebut pool 20. Request belakang mengantre, sebagian gagal →
`Promise.allSettled` menyisakan pilihan → user klik ulang → dua POST untuk key sama lolos
berbarengan → **dua baris payment untuk satu orang**.

**Rekomendasi minimal:** tercakup oleh unique index di C2 + `onConflictDoUpdate`. Tidak perlu
mengubah UI-nya.

---

### H4 · HIGH · Channel `GT` diperlakukan tidak konsisten di 3 tempat

> **Status: FIXED — GT ditambahkan ke ChannelType, 2 filter ttList, dan dropdown channel.**

```
dashboard/route.ts:87   isSchemeChannel = (ch) => ch === "GT" || ch === "TT"   OK
page.tsx:2045           r.channel === "GT" || "TT" || "MT"                     OK
page.tsx:487, 553       ttList = list.filter((r) => r.channel === "TT")        lupa GT
data.ts:11              type ChannelType = "TT" | "MT"                         GT tidak ada
page.tsx:1020           <option>TT</option><option>MT</option>                 GT tidak ada
```

**Skenario gagal:** tim yang seluruh salesman-nya `GT` melihat kolom **"AO TT (%)" dan "Ave IA TT"
= 0% terus-menerus** di tab SPV dan SM, padahal capaian AO/IA sungguhan ada — `ttList` selalu
kosong. Terpisah: admin tidak bisa memilih `GT` lewat form manual sama sekali, hanya lewat Excel.
Tipe `ChannelType` menyembunyikannya karena hasil route di-cast (`page.tsx:87`
`row.channel as ChannelType`), jadi `tsc` tidak protes.

**Rekomendasi minimal:** `|| r.channel === "GT"` di dua filter; tambah `"GT"` ke `ChannelType`;
tambah `<option>GT</option>`.

---

### M1 · MEDIUM-HIGH · `DELETE` di `POST /progress` tanpa index yang cocok

> **Status: SEBAGIAN — index ada di schema.ts; DDL menunggu dijalankan (DDL_AUDIT_INSENTIF_2026-08-24.sql).**

**Apa:** predikat `sales_code` + `principle` + `period_month` + `period_year`
(`progress/route.ts:87-97`); index yang ada hanya `(period_month, period_year)`, `(sales_code)`,
`(date)` — tidak ada komposit. Planner paling mungkin pakai `idx_sdp_code` lalu filter di heap, dan
jumlah baris per `sales_code` **tumbuh linier dengan riwayat**.

**Skenario gagal:** satu upload closing = ~90 kombinasi `(salesCode, principle)` → **90 DELETE
berurutan dalam satu transaksi**. Sekarang (~40 baris/sales_code) instan. Setelah 3 tahun dengan
3 principal per sales: ~2.400 baris per `sales_code` × 90 ≈ **216.000 baris dibaca per upload**,
sebagian besar random heap fetch. Upload yang sekarang 3-5 detik jadi puluhan detik, **dan selama
itu menahan row lock** — SM kedua yang upload bersamaan ikut menunggu. `.returning({ id })` di
`:97` menambah beban: seluruh id baris terhapus dikirim balik hanya untuk `del.length`.

**Rekomendasi minimal:**

```sql
CREATE INDEX CONCURRENTLY idx_sdp_code_prin_period
  ON sales_daily_progress (sales_code, principle, period_year, period_month);
DROP INDEX CONCURRENTLY idx_sdp_code;   -- jadi redundan (prefiks index baru)
```

Ganti juga `.returning({ id })` → `rowCount`.

---

### M2 · MEDIUM · `getScopeForUser` non-deterministik — masalah kebenaran, bukan performa

> **Status: FIXED — periode diteruskan ke getScopeForUser di 6 call-site.**

**Apa:** `lib/insentif-hierarchy-scope.ts:31` dan `:42` — `db.select().from(salesTargets)` tanpa
`WHERE`, membangun peta dari **seluruh riwayat**. Tanpa `ORDER BY`, `map.set` di `:34` membiarkan
baris terakhir yang dibaca menang, dan urutan seq-scan bisa berubah setelah `VACUUM`/update.

**Skenario gagal:** begitu satu `salesCode` pindah SPV antar bulan, scope bulan lama dan bulan baru
dihitung dari peta yang sama. Gejala: **SPV melihat/tidak melihat salesman lama secara tidak
konsisten antar refresh, tanpa perubahan data.** Sisi performa (4 scan penuh per request untuk
peran SM) baru terasa di ~50.000+ baris — bukan urgensi.

**Rekomendasi minimal:** teruskan `month`/`year` yang **sudah dipegang tiap route** ke
`getScopeForUser`, tambah `WHERE period_month = ? AND period_year = ?`. `idx_sales_targets_period`
sudah cocok. Satu parameter tambahan di 5 call-site.

---

### M3 · MEDIUM · Validasi numerik bolong — dan polanya sudah ada di repo sendiri

> **Status: FIXED — Number.isFinite di targets/support/payments/progress.**

```
support/route.ts:58      const amount = Number(s.supportAmount) || 0;   <- Infinity lolos
spv-support/route.ts:65  if (!Number.isFinite(amount) || amount < 0)     <- benar
```

`support` punya cek `amount < 0` tapi `Infinity > 0` sehingga lolos. Sama bolongnya:
`targets/route.ts:144-178` (`targetValue`/`targetEc`/`targetAo`/`targetIa`/`splmValue`),
`payments/route.ts:89-120` (`totalIncentive`), `progress/route.ts:103-119` (`achieved*`).

**Skenario gagal:** `supportAmount: Infinity` tersimpan → `konstanta − Infinity` ter-floor jadi 0 →
insentif sales itu **hilang tanpa error apa pun ke Finance**. `targetValue: "abc"` → `NaN` menjalar
ke total.

**Rekomendasi minimal:** salin satu baris dari `spv-support/route.ts:65` ke empat route itu.

---

### M4 · MEDIUM · `double precision` untuk uang + ambang dibandingkan langsung ke float

> **Status: FIXED — roundRatio(1e-6) di percentageMultiplier & rateSm.**

**Apa:** `db/schema.ts` `:721 :725 :748 :767 :782 :808 :844` semua `doublePrecision`. Konsumen:
`insentif-sm-calc.ts:75-77` (`ratio >= 1.1 / >= 1.0 / >= 0.9`) dan `insentif-sales-calc.ts:61`
(`if (r < 0.9)`), disuapi `SUM(achieved_value_dpp)`.

Yang nyata **bukan** presisi rupiah (galat penjumlahan 4.000 baris ada di orde pecahan rupiah),
tapi: **`SUM(double precision)` di Postgres tidak deterministik terhadap urutan**. Begitu tabel
cukup besar planner boleh memakai parallel aggregate, dan dua eksekusi query yang sama bisa beda di
digit terakhir.

**Skenario gagal:** ambang 100% SM. Kalau target diturunkan dari realisasi bulan lalu (praktik
umum), `ratio` bisa jatuh di 0,9999999999 vs 1,0000000001 → beda **Rp 1.000.000** (strata 1,5jt vs
2,5jt) **dan berubah antar refresh**. Gejala: "angka insentif saya berubah sendiri padahal data
tidak diupload lagi." Sangat sulit didiagnosis kalau tidak dicari.

**Rekomendasi minimal:** bulatkan rasio sebelum dibandingkan, di dua file pure yang **sudah punya
test**: `const r = Math.round(raw * 1e6) / 1e6` (presisi 0,0001%). Non-determinisme `SUM` ikut
hilang karena drift-nya ~1e-9. **Migrasi kolom ke `numeric` TIDAK direkomendasikan** — lihat §2.

---

### M5 · MEDIUM · Scope tim tidak diterapkan di `code-merge` & `spv-mismatch` GET

> **Status: FIXED — getScopeForUser diterapkan di code-merge & spv-mismatch GET.**

**Apa:** `grep -c getScopeForUser` = **0** di kedua file, sementara `dashboard/route.ts` = 2.
Permission-nya sama (`insentif_sales.view`).

**Skenario gagal:** SPV yang sudah di-opt-in ke scoping (hanya boleh lihat timnya di dashboard)
memanggil `GET /code-merge?month=8&year=2026` dengan permission yang sama yang dia sudah punya →
dapat daftar **seluruh kode sales + nama SPV/SM se-perusahaan**, lintas tim.

**Rekomendasi minimal:** salin pola filter dari `dashboard/route.ts:63-72`.

---

### M6 · MEDIUM · `POST /payments` selalu menulis `branch: ""` untuk baris Sales

> **Status: FIXED — branch: r.branch diteruskan ke POST /payments.**

**Apa:** `ApiRow` punya `branch` dan tersedia di `r`, tapi tidak disalin ke objek `sales`
(`page.tsx:2231`), lalu `:2269` mengirim `branch: ""`. Kolom `notNull` (`db/schema.ts:779`).
Bug lama, bukan dari perubahan sesi ini.

**Skenario gagal:** `GET /payments` sudah punya filter `?branch=` yang siap dipakai
(`payments/route.ts:31,36`). Begitu ada rekap per cabang, semua baris Sales yang pernah ditandai
lunas **tidak akan muncul di filter cabang mana pun**.

**Rekomendasi minimal:** `branch: r.branch` di `:2231`, lalu
`branch: row.role === "sales" ? row.branch : PAYEE_PRINCIPLE_ALL` di `:2269`.

---

### M7 · MEDIUM · Tidak ada jejak siapa mengubah target & nominal pembayaran

> **Status: SEBAGIAN — kolom updated_by ada di schema.ts + diisi route; DDL menunggu dijalankan.**

**Apa:** `incentive_support.inputBy` dan `spv_support.inputBy` ada; `sales_targets` dan
`incentive_payments` tidak punya `createdBy`/`updatedBy`. `paidBy` hanya terisi saat status jadi
`lunas` (`payments/[id]/route.ts:48-51`). Nilai lama tidak disimpan di mana pun — upsert menimpa.

**Skenario gagal:** dua staf Finance ber-`manage_payment` mengedit `totalIncentive` untuk salesCode
yang sama di hari berbeda sebelum ditandai lunas → tidak ada cara menelusuri siapa mengubah dari
Rp X ke Rp Y dan kapan. Hanya `updatedAt` yang berubah. Untuk data uang, ini temuan.

**Rekomendasi minimal:** kolom `updatedBy` (text, nullable) di 2 tabel, isi dari
`gate.session.user.id` — pola yang sudah ada di `support/route.ts:77,87`.

---

### M8 · MEDIUM · `POST /progress` & `POST /targets` tanpa `maxDuration`

> **Status: FIXED — maxDuration = 300 di progress & targets.**

**Apa:** konvensi repo menaikkan batas untuk route unggah berat —
`app/api/laporan-harian/upload/route.ts:28` dan `app/api/sales-history/import/route.ts:22` keduanya
`maxDuration = 300`. **0 dari 18 route `insentif-sales`** menyetelnya, padahal `POST /progress`
(~90 DELETE + insert borongan) dan `POST /targets` (570 statement) persis kelas beban yang sama.

Memperburuk H1: `POST /targets` yang kena timeout **tidak** rollback.

**Rekomendasi minimal:** `export const maxDuration = 300;` — satu baris per route.

---

### L1 · LOW · Sisa

| # | Temuan | Lokasi | Rekomendasi |
|---|---|---|---|
| L1a | `POST /spv-mismatch` menulis 2 tabel tanpa transaksi — kalau mati di tengah, `sales_targets.spv_name` berubah tapi `spv_sales_assignment` belum. Karena assignment adalah **override**, dashboard pakai nama lama sementara target pakai nama baru — persis mismatch yang route ini seharusnya menghapus, dan tidak muncul lagi di GET karena target sudah "benar". | `spv-mismatch/route.ts:109-138` | `db.transaction`; SELECT-cek di `:127` bisa jadi `onConflictDoUpdate` karena `spv_sales_assignment.sales_code` **sudah UNIQUE di produksi** |
| L1b | `dikecualikan`/`support`/`porsiDistributor` dihitung & dikirim route tapi tidak dibaca UI — saat ANI turun n=10→9 dan rate naik, tidak ada penjelasan di layar | `insentif-spv-calc.ts:64` vs `page.tsx:665-679` | tambah field ke interface + badge |
| L1c | `branch` bukan bagian kunci upsert `sales_targets` → satu `salesCode+principle` dengan 2 cabang, yang kedua menimpa yang pertama tanpa warning. Karena `realisasiValue()` memilih DPP vs NILAI_JUAL **berdasarkan cabang**, realisasi bisa dihitung dengan acuan cabang yang salah | `targets/route.ts:123-142` | jangan ubah kunci (keputusan bisnis, handover9 §8). Tambah deteksi: `Set` `code\|prin\|branch` vs `code\|prin` beda → 400 |
| L1d | `month`/`year` diparse tanpa cek rentang di hampir semua GET → `?month=abc` kemungkinan 500 alih-alih 400 | ~10 route | `Number.isFinite` + range 1-12 |
| L1e | `PaymentRow.paymentDate: number \| null` vs kolom `timestamp` (JSON → string ISO). Belum dirender jadi belum bergejala | `page.tsx:68` vs `db/schema.ts:785` | ubah tipe jadi `string \| null` |
| L1f | `xlsx@0.18.5` punya CVE tak dipatch di npm (prototype pollution, ReDoS). Semua pemakaian **client-side**, dampaknya sebatas tab si pengunggah | `package.json:36` | kandidat accepted risk, atau pindah ke registry SheetJS CDN |
| L1g | Satu kredensial DB, dan itu **pemilik database** — punya `DROP TABLE`. Data komersial (target value, support/rebate per-principal, payout per orang, DPP harian) diakses dengan kredensial yang sama yang dipakai Better Auth | `lib/db.ts:5`, `lib/auth.ts:19` | jalankan app sebagai role non-owner (`GRANT SELECT/INSERT/UPDATE/DELETE`), ganti `DATABASE_URL` **lewat Coolify UI** — bukan edit `docker-compose.yml`, file itu diregenerasi setiap redeploy. Nol perubahan kode |

---

### H5 · HIGH · Header "Tipe Sales"/"Status Insentif" dicocokkan string persis — salah ejaan = seluruh file jatuh ke default berbayar

> **Status: FIXED (be5580d) — pencocokan header case/whitespace-insensitive.**

**Apa:** `lib/insentif-sales-excel.ts:36-42` mengakses `row["Tipe Sales"]` dan
`row["Status Insentif"]` dengan kunci literal — tanpa normalisasi, **berbeda dari parser closing**
yang punya `norm()` case-insensitive (`page.tsx:1185`). Header `"TIPE SALES"` atau `"Tipe sales"` →
`undefined` → default `"exclusive"` / `"distributor_principle"` untuk SELURUH file, tanpa satu pun
error.

**Skenario gagal:** sales mix 3 principal, masing-masing target Rp 200 jt tercapai 100%. Benar
(mix, konstanta 1,2 jt) = **Rp 1.200.000**. Dengan header salah (semua exclusive, pool 1 jt per
principal) = **Rp 3.000.000** → kelebihan **Rp 1.800.000 per salesman**. Plus baris ENERGIZER yang
seharusnya `principle` (Rp 0) jadi `distributor_principle` → **+Rp 1.000.000**.

**Rekomendasi minimal:** pakai pola `norm()`/`get()` yang sudah terbukti di `page.tsx:1185-1192`
(Map dari `Object.entries(row)` dengan kunci `k.trim().toUpperCase()`), dan **hentikan default
silent** untuk 2 kolom itu: kalau kolomnya tidak ada sama sekali, tolak file dengan pesan.

---

### H6 · HIGH · GT mix dengan 1 principal valid dibayar Rp 0 — MT tidak

> **Status: FIXED — konstantaMix(1) jatuh ke RP_1JT. Dikonfirmasi user: mix 1 principal TETAP dapat insentif.**

**Apa:** komentar `konstantaMix` (`insentif-sales-calc.ts:39-41`) menulis "n<2 → 0 (pakai
exclusive)", tapi **tidak ada satu pun tempat yang melakukan fallback itu**. `computeMix`
mengembalikan `rincian: []`, dan route menerjemahkannya lewat `line?.total ?? 0` → Rp 0 tanpa
error. `computeMtMix` justru punya fallback yang benar (`insentif-mt-calc.ts:113`).

**Skenario gagal:** sales GT `tipe_sales = mix` memegang KINO (`distributor_principle`, target
300 jt tercapai 100%, AO 240) + ENERGIZER (`principle`). Valid = 1 → `konstantaMix(1) = 0` →
**insentif Rp 0**. Perlakuan exclusive memberi Rp 1.000.000. Sales MT dengan komposisi identik
dapat Rp 1.000.000.

**Rekomendasi minimal:** satu baris, sejajar MT yang sudah ada:
`const konstanta = jumlah === 1 ? RP_1JT : konstantaMix(jumlah);`. **Butuh konfirmasi user** apakah
itu memang aturannya — tapi "Rp 0 diam-diam" hampir pasti bukan.

---

### H7 · HIGH · `spv_name`/`sm_name` teks bebas tanpa `trim()` → grup pecah, rate naik, support SPV hilang

> **Status: FIXED — trim() spvName/smName di titik tulis POST /targets.**

**Apa:** `targets/route.ts:144-145` dan `:164-165` menyimpan `spvName: t.spvName ?? null` **tanpa
`trim()`**, lalu nama itu dipakai **langsung sebagai kunci `Map`** grouping
(`spv-dashboard/route.ts:65`, `sm-dashboard/route.ts:47`). `"MARTEN"` vs `"MARTEN "` vs `"Marten"`
= tiga SPV berbeda. Sementara `spv-support/route.ts:60` justru **men-trim** — jadi kunci support
tidak akan pernah cocok dengan kunci grouping.

**Skenario gagal:**
- **SPV:** MARTEN 6 principal (rate n=6 = 400rb → Rp 2.400.000). Kalau 3 baris ditulis `"MARTEN"`
  dan 3 `"Marten"` → 2 grup n=3 → rate 600rb → **Rp 3.600.000** (kelebihan Rp 1,2 jt), plus dua
  baris payee `SPV:MARTEN` dan `SPV:Marten` yang dua-duanya bisa ditandai lunas.
- **SM (lebih buruk, strata FLAT):** HENDRIK terpecah 2 grup, dua-duanya ≥90% →
  **2 × Rp 2.500.000 = Rp 5.000.000** untuk satu orang. `isSmBerhak` mem-normalisasi
  (`trim().toUpperCase()`) sehingga **kedua** grup lolos whitelist — normalisasinya ada di tempat
  yang salah.
- **Support SPV hilang:** target `"MARTEN "`, `spv_support` `"MARTEN"` →
  `supportBySpv.get("MARTEN ")` = `undefined` → MOTASA support 4,17 jt tidak mengeluarkan principal.
  Kasus MARTEN yang lulus di test justru gagal di produksi.

**Rekomendasi minimal:** `trim()` di titik tulis — `spvName: t.spvName?.trim() || null` dan sama
untuk `smName` (4 tempat di `targets/route.ts`). Jangan sebar normalisasi ke pembaca.

---

### M9 · MEDIUM · Snapshot `total_incentive` tidak diperbarui, UI menampilkan angka hitung-ulang di sebelah badge "lunas"

> **Status: FIXED — baris lunas menampilkan snapshot + penanda selisih hitung-ulang.**

**Apa:** `payments/[id]/route.ts:44-52` — PATCH tidak menyentuh `totalIncentive`. Untuk bulan
berjalan `detailRows` memakai `r.incentive.total` (hitung-ulang, `page.tsx:2231`); untuk bulan lain
memakai `p.totalIncentive` (snapshot, `:2245`).

**Skenario gagal:** `MS10/KINO` ditandai lunas Rp 1.000.000. Finance lalu memasukkan support
Rp 700.000. Tabel Finance menampilkan **"Rp 300.000 — lunas"**, sementara DB dan Rekap Tahunan
tetap Rp 1.000.000. Dua angka berbeda di satu halaman, tanpa indikasi Rp 700.000 sudah terbayar
lebih.

**Rekomendasi minimal:** kalau `pay.paymentStatus === "lunas"`, tampilkan `pay.totalIncentive`
sebagai angka utama dan tandai baris kalau `Math.abs(pay.totalIncentive − r.incentive.total) >= 1`.
Datanya sudah ada di `payments`; nol tabel/kolom baru.

---

### M10 · MEDIUM · Default `"NESTLE"`/`"BANDUNG"` bocor dari template demo; target bertipe teks jadi 0 diam-diam

> **Status: SEBAGIAN (be5580d) — EMPTY_ROW & validator diperbaiki; default "NESTLE" di parseTargetExcel MASIH ADA.**

**Apa:** `insentif-sales-excel.ts:32-34` — `Principal` kosong → `"NESTLE"`, `Cabang` kosong →
`"BANDUNG"`, `Channel` kosong → `"TT"` (= masuk skema GT berbayar). Untuk angka,
`Number("250.000.000")` = `NaN`, lalu `Number(r.targetValue || 0)` → **`NaN` falsy → 0**.

**Skenario gagal:** baris dengan kode salesman terisi tapi `Principal` kosong (baris
pemisah/subtotal) menghasilkan **target NESTLE hantu** — menambah `n` pada grup mix salesman itu
(konstanta 1,2 jt → 1,4 jt) dan memunculkan baris payee yang bisa ditandai lunas. Terpisah:
`Target Value` berformat teks → target 0 → komponen Value (30%, Rp 300.000) hilang diam-diam
sementara komponen AO tetap dibayar Rp 700.000 karena penyebutnya konstanta 240.

**Rekomendasi minimal:** default `""`, lalu masukkan `principle`/`branch` kosong ke validator
`invalid` yang **sudah ada** di `page.tsx:900-906`. Untuk angka: tolak baris kalau sel tidak kosong
tapi `Number()` menghasilkan `NaN` — jangan `|| 0`.

---

### M11 · MEDIUM · Parser angka closing hancur untuk format ribuan bertitik

> **Status: FIXED — num() mendeteksi format ribuan Indonesia vs Inggris.**

**Apa:** `page.tsx:1196` —
`parseFloat(val.replace(/[^\d.,-]/g,"").replace(/,/g,"")) || 0` mengasumsikan format Inggris
(koma = ribuan). Sel numerik asli aman (XLSX mengembalikan `number`); bug ini hanya muncul pada
CSV / kolom berformat teks — silent.

```
num("1,234,567.89") = 1234567.89   OK
num("1.234.567,89") = 1.234        SALAH
num("-533.000.000") = -533         SALAH
```

Angka `-533.000.000` itu justru yang dikutip di komentar kode `:1214` (retur ADNAN).

**Skenario gagal:** realisasi Value satu principal menyusut dari ratusan juta ke ribuan → pengali
Value 0 → komponen 30% hangus untuk seluruh sales di principal itu. Atau retur besar tidak pernah
mengurangi realisasi.

**Rekomendasi minimal:** deteksi separator terakhir — kalau cocok
`/^-?\d{1,3}(\.\d{3})+(,\d+)?$/`, buang titik lalu koma→titik; kalau tidak, jalur sekarang.
~3 baris di dalam `num`. Jaring aman: hasil `0` padahal input tidak kosong → laporkan lewat toast
(mekanisme `dibuang`/`ambigu` sudah ada di `:1287`).

---

### M12 · MEDIUM · Tidak ada pembulatan ke rupiah di sepanjang jalur bayar

> **Status: FIXED — Math.round di batas bayar (POST /payments + UI).**

**Apa:** seluruh perkalian (`WEIGHT_AO * K * pAo`, `porsiDistributor * pctValue`) menghasilkan
`double` dan tidak pernah dibulatkan sebelum masuk `incentive_payments.total_incentive`.
Contoh nyata: `computeMix().total = 1154100.0003456` — nilai itulah yang masuk DB dan diekspor.

Akumulasi antar ratusan baris tetap di bawah 1 rupiah (bukan kebocoran materiil), tapi total rekap
yang dijumlahkan dari nilai pecahan tidak akan sama dengan jumlah baris yang ditampilkan setelah
dibulatkan — dan transfer bank tidak bisa berisi sen.

**Rekomendasi minimal:** satu titik saja, pada batas pembayaran — `Math.round(row.total)` di
`page.tsx:2272`. **Jangan** sebar pembulatan ke setiap komponen KPI; itu justru bikin jumlah
komponen ≠ total.

---

### M13 · MEDIUM · "Idempoten per (salesCode, principle, periode)" menghapus upload sebelumnya kalau principal beririsan

> **Status: FIXED — date masuk kunci hapus di progress/route.ts DAN laporan-harian/ingest.ts. Dikonfirmasi user: closing yang sudah masuk tidak boleh hilang karena upload berikutnya.**

**Apa:** klaim di komentar `progress/route.ts:8-10` ("upload file SM lain tidak menyentuh data SM
ini") hanya benar kalau himpunan `(salesCode, principle)` antar file **tidak beririsan**. DELETE-nya
tanpa `branch` dan tanpa `date`, jadi kombinasi yang muncul di payload baru dihapus **total** dari
periode itu — termasuk baris tanggal lain dari upload sebelumnya.

**Skenario gagal:** upload closing minggu 1 lalu minggu 2 untuk sales & principal yang sama → baris
minggu 1 **terhapus**, realisasi MTD tinggal minggu 2 → pengali <0,9 → insentif Rp 0 tanpa pesan.
Toast `replaced N baris lama` terbaca sebagai konfirmasi normal, bukan peringatan. Ini pola
pemakaian yang wajar ("upload berkala").

**Rekomendasi minimal:** kalau semantik yang dimaui memang "ganti seluruh bulan", perbaiki
komentarnya dan buat toast eksplisit. Kalau "ganti per hari", tambahkan `date` ke kunci `scopes`
(`:78`) dan ke `where` — dua baris; agregasi browser sudah menghasilkan satu baris per
`(sales, principal, cabang, tanggal)` sehingga aman.

---

### L2 · LOW · Sisa dari audit kalkulasi

| # | Temuan | Lokasi | Rekomendasi |
|---|---|---|---|
| L2a | `percentageMultiplier` meneruskan `NaN` (`NaN < 0.9` dan `NaN > 1` dua-duanya false) → `JSON.stringify` mengubahnya jadi `null` → baris tampil Rp 0 total padahal komponen AO Rp 700.000. **Tidak ditemukan jalur HTTP yang bisa memasukkan `NaN` ke DB** — guard yang hilang, bukan bug hidup | `insentif-sales-calc.ts:63-69` | `if (!Number.isFinite(target) \|\| target <= 0) return 0;` + guard setelah pembagian |
| L2b | Realisasi negatif murni tidak menihilkan komponen AO — MOTASA target 700 jt realisasi **−21,4 jt** tetap dibayar Rp 700.000 kalau statusnya `distributor_principle`. Di produksi statusnya `principle` sehingga tidak terbayar — jadi risikonya bergantung pada satu kolom Excel (lihat H5, yang default-nya justru `distributor_principle`) | `insentif-sales-calc.ts:86-93`, `:143-146` | **jangan ubah tanpa konfirmasi** — bisa jadi memang aturannya (AO = kunjungan efektif, terpisah dari nilai). Layak ditanyakan |
| L2c | Cabang `existing` di `POST /payments` menandai lunas tanpa mengisi `paymentDate`/`paidBy`/`paidByName` — berbeda dari PATCH yang mengisinya. Terjangkau ketika cache klien basi sehingga `paymentId` masih null padahal barisnya ada | `payments/route.ts:89-101` vs `[id]/route.ts:48-52` | salin 3 baris dari PATCH |
| L2d | `isSmBerhak` dan `isOfficeRow` memakai `includes()` → SM baru bernama `"HENDRIKUS"` otomatis berhak sampai Rp 3,5 jt tanpa keputusan siapa pun; salesman yang namanya mengandung "OFFICE" dibuang. Sudah ditulis sebagai keputusan sadar di komentar | `insentif-sm-calc.ts:44-47`, `:53-55` | pertimbangkan `n.split(/\s+/).includes("HENDRIK")` — tetap menangkap "PAK HENDRIK", menolak "HENDRIKUS". Test yang ada tetap lulus |

---

## 2. Yang sengaja TIDAK direkomendasikan diubah

**Migrasi kolom uang ke `numeric`.** `ALTER TABLE ... TYPE numeric` menulis ulang seluruh tabel
dengan `ACCESS EXCLUSIVE` lock — untuk `sales_daily_progress` yang tumbuh, itu downtime. Lebih
buruk: driver `pg` mengembalikan `numeric` sebagai **string**, jadi setiap pembacaan di
`lib/insentif-sales.ts` + 4 modul kalkulasi harus di-`Number()`. Tanpa test yang menjaganya, satu
`"1000" + "2000" = "10002000"` yang lolos jauh lebih berbahaya daripada masalah yang mau
diperbaiki. Pembulatan rasio (M4) menutup gejala nyatanya dengan dua baris di kode yang sudah
punya test.

**Grant per-tabel untuk memisahkan support/payment dari tabel lain.** Butuh pemisahan kredensial di
kode (dua pool, dua env var) selama modul lain masih memakai `db` yang sama. Biayanya jauh lebih
besar daripada manfaatnya. Yang murah dan langsung mengurangi risiko terbesar hanya L1g
(role non-owner).

**Mengubah urutan kolom index `(month, year)` → `(year, month)` di semua tabel.** Benar secara
teknis untuk `GET /payments?year=` tanpa `month` (kolom pemimpin tidak dibatasi → tidak bisa range
scan), tapi `incentive_payments` ~2.400 baris/tahun sehingga seq scan **sekarang lebih cepat**
daripada index. Catat saja; kerjakan kalau tabel lewat ~100k baris.

**Mengindeks predikat range `lookupTierFromDb`.** `incentive_tiers` berisi puluhan baris, dan jalur
Strata-DB sudah tidak dipakai untuk insentif.

**`db.select().from(...)` tanpa WHERE pada tabel assignment.** `spv_sales_assignment` dibatasi 1
baris per `sales_code` (UNIQUE) → plafonnya jumlah salesman (~300-400); `sm_spv_assignment` ~10
baris. Tidak tumbuh dengan waktu; seq scan benar-benar lebih murah. Yang perlu diperbaiki hanya
scan `sales_targets` (M2).

**Kolom achievement ISQ yang salah** (`dashboard/route.ts`, `isqTgt = itemSuper(targetIa,
targetAo)` → GT 6/240 = 0,025 sehingga persentasenya meledak). Sudah dicatat di handover9 §10
sebagai utang teknis yang sengaja tidak diubah karena mengubah angka yang mungkin sudah dipakai
orang. Tetap begitu sampai user memutuskan.

**Memaksakan nama layer Controller/Service/Repository.** Codebase ini memakai route handler →
pure calc lib → query helper, tanpa lapisan repository. Menambahkannya sekarang tidak menutup satu
pun temuan di atas.

---

## 3. Dugaan yang dicek dan TIDAK terbukti

Bagian dari hasil audit — supaya tidak dicek ulang nanti.

- **Agregasi di JS, bukan di DB** — SALAH. `computeMtdProgress` (`insentif-sales.ts:157`) dan
  `computeMtdByPrinciple` (`:199`) memakai `SUM()` + `GROUP BY` **di SQL**; ~4.000 baris diringkas
  jadi ~90 sebelum lewat jaringan. Tidak ada satu pun dari 18 route yang menarik baris progress
  mentah. Ini bagian terkuat modul ini.
- **`POST /progress` bisa setengah jadi** — SALAH. `progress/route.ts:85-123` seluruhnya di dalam
  `db.transaction`, insert dipotong per 1.000 baris untuk batas parameter Postgres. Kalau gagal di
  tengah, rollback penuh. Pola inilah yang harus dicontoh 6 POST lainnya.
- **Route mutasi dijaga cuma `insentif_sales.view`** — SALAH. Semua 12 route tulis punya permission
  sendiri: `upload_target`, `upload_progress`, `input_support`, `manage_payment`, `manage`,
  `manage_hierarchy`. Tidak ada kasus "lihat = boleh tulis".
- **SPV bisa mencuri `salesCode` SPV lain lewat auto-claim** — SALAH. Kepemilikan diverifikasi lewat
  `getCurrentSpvOwner` sebelum klaim; kalau sudah dipegang SPV lain → 403. Nama SPV yang di-assign
  berasal dari `identity.name` **sisi server**, bukan body request, jadi tidak bisa dispoof.
- **IDOR `PATCH /payments/[id]` bisa mengubah nominal** — SALAH. Hanya `paymentStatus`,
  `paymentProofUrl`, `paymentDate` yang bisa di-set. `totalIncentive` hanya lewat `POST /payments`.
  Tidak ada cek scope pada `id`, tapi itu konsisten dengan peran Finance yang mengurus payroll
  seluruh perusahaan — catatan desain, bukan celah.
- **SQL injection** — tidak ada. Semua query Drizzle terparameter; satu-satunya tagged template
  (`insentif-sales.ts:71`) tetap parameterized.
- **Bypass auth lokal bisa aktif di produksi** — SALAH. Butuh `NODE_ENV=development` **dan**
  `LOCAL_AUTH_BYPASS=true` **dan** header `Host` = localhost.
- **Template Excel dan parser-nya bisa berbeda** — SALAH. `generateTargetTemplate` dan
  `parseTargetExcel` ada di file yang sama (`insentif-sales-excel.ts`) dengan string header identik.
- **Default `statusInsentif`/`tipeSales` beda antar layer** — SALAH. schema (`:727,729`) = route
  (`targets/route.ts:116-117`) = perilaku UI. Konsisten, termasuk setelah perbaikan hari ini.
- **Periode 0-index vs 1-index tercampur** — tidak ada. Semua route + UI konsisten 1-indexed.
- **Payload 2.000 baris melanggar batas body** — SALAH. ~400 KB; App Router tidak punya
  `bodyParser.sizeLimit`, tidak ada konfigurasi proxy yang membatasi. Yang bermasalah `maxDuration`
  (M8), bukan ukuran.
- **`getScopeForUser` fail-open untuk `hierarchyRole` korup** — SALAH, fail-closed dengan benar.
- **Index/constraint di schema tapi hilang di produksi** — tidak ada drift. Tabel hierarki masuk
  `db/schema.ts` (`19400a3` 2026-07-06, `88d3625` 2026-07-07) **mendahului** `drizzle-kit push` D4
  (2026-07-14) → UNIQUE-nya terbentuk. `spv_support`/`sales_code_merge` (2026-08-21) DDL manualnya
  di handover9 §5 memang menyertakan unique-nya.

Dari audit kalkulasi (7 test pure semuanya PASS — temuan di atas semua berada di jahitan antara
lib pure dan I/O, yang tidak punya test sama sekali):

- **Batas tier/strata: konsisten, tanpa celah maupun tumpang tindih.** `percentageMultiplier`
  (0,9 dan 1,0 inklusif), `rateSm` (celah 99%–100% memang tertutup ke strata 1,5 jt, persis seperti
  didokumentasikan), `ratePerPrincipalSpv` (n=2..6 cocok persis 800/600/500/440/400rb; n=7 = 371,4rb
  → ditahan 400rb sesuai keputusan user).
- **Target 0/null/negatif dan pembagian nol: terjaga di 6 tempat** — `percentageMultiplier:65`,
  `pct:50`, `itemSuper:55`, `calculateInsentifSM:107`, MT `fromPool:74`, `computeMix:148`. Tidak ada
  jalur yang menghasilkan `Infinity`.
- **Array kosong / n=0: terjaga** di keempat skema. Tidak ada crash, tidak ada `NaN`.
- **Upload closing dua kali TIDAK menggandakan realisasi** — idempotensi untuk file yang sama
  benar-benar berlaku. (Masalahnya justru sebaliknya, lihat M13.)
- **Non-monotonisitas `resolveValidSet` bukan bug** — principal yang dikeluarkan pada rate 600rb
  tetap keluar walaupun rate naik jadi 800rb: itu **persis contoh yang dikonfirmasi user**
  (`insentif-spv-calc.test.ts:89-99`), dan ambiguitasnya sudah didokumentasikan di `:163-171`.
  Loop batas 20 tidak bisa berputar tak berhingga karena `valid` selalu menyusut.
- **`foldMerged` tidak melipat baris target**, jadi agregasi SPV dan SM **tidak** dobel: total target
  tetap menghitung kedua kode, total realisasi tetap sama karena hanya dipindah.
- **`applyMergeMap` tidak bisa hang** — batas 10 hop pada data siklik.
- **SM menghitung status `principle` (ENERGIZER): disengaja & terdokumentasi** di `SYSTEM_MAP.md` dan
  header `insentif-sm-calc.ts:29-31` dengan tanggal konfirmasi user.
- **`incentive_payments` upsert key aman terhadap tabrakan SPV/SM vs Sales** — prefiks `SPV:`/`SM:`
  tidak mungkin muncul di kode sales asli; `PAYEE_PRINCIPLE_ALL = "-"` tidak bertabrakan dengan nama
  principal. Titipan tanpa migrasi DB ini benar.
- **Debu floating-point tidak menumpuk secara materiil** — `sum(rincian) − total = 0` pada
  `computeMix`; residu per baris orde 1e-4 rupiah. Masalahnya bukan akumulasi, tapi tidak adanya
  pembulatan sama sekali (M12).
- **`lib/insentif-value-source.ts` bersih** — normalisasi + `Set` exact-match; jebakan
  `MIX FOOD` ≠ `MIX NON FOOD` dan `KINO` ≠ `KINO NON FOOD` terjaga test.
- **Dua utang teknis yang sudah dicatat: dampaknya TIDAK lebih besar dari catatannya.** (a) `isqTgt`
  salah di `dashboard/route.ts:151`, tapi `pIsq` hanya masuk `totalAchieve` — **tidak pernah**
  menyentuh objek `incentive`, jadi murni tampilan. (b) Asumsi "IA per outlet" MT mengendalikan
  Rp 350.000 per baris MT, tapi guard `realisasi_ao > 0`-nya benar dan **tanpa** asumsi itu bobot IA
  selalu terbayar penuh — jadi asumsi yang ada lebih konservatif daripada alternatifnya.

### Risiko proses (bukan bug)

Repo **tidak punya folder `drizzle/` sama sekali** — nol migration file, nol `meta/`. Dan
`scripts/init-db.mjs:730-850` masih DDL rasa-SQLite (`REAL`, `created_at INTEGER`) yang self-skip
kalau `DATABASE_URL` bukan `file:`. Artinya tidak ada satu pun artefak di repo yang
merepresentasikan skema Postgres produksi. Kalau tabel berikutnya lupa dibuatkan DDL manual,
kegagalannya muncul sebagai `relation does not exist` **saat runtime**, bukan sebagai error deploy.

---

## 4. Urutan kerja yang disarankan (belum dieksekusi)

Blast radius diturunkan dulu: nomor 1-2 tidak menyentuh kode, hanya membaca DB.

| # | Langkah | Bentuk | Menutup |
|---|---|---|---|
| 1 | Jalankan 3 query cek duplikat di §C2 | read-only SQL | prasyarat C2 |
| 2 | Putuskan siapa pemilik `sales_daily_progress` | keputusan user | prasyarat C1 |
| 3 | Cast `::double precision` pada 6 `SUM()` | 6 baris | **C0** |
| 3b | `trim()` pada `spvName`/`smName` di titik tulis | 4 baris | H7 |
| 3c | `isOfficeRow` di `/dashboard` | 2 baris | C3 |
| 4 | `db.transaction` + validasi pre-pass di 4 POST; `maxDuration=300` di 2 route | ~5 baris/route | H1, M8 |
| 5 | 3 `CREATE UNIQUE INDEX CONCURRENTLY` + `onConflictDoUpdate` di 3 handler | DDL + ~10 baris/handler | C2, H3 |
| 6 | Cache `effectiveSpvBySalesCode` di luar loop | ~4 baris | H2 |
| 7 | `WHERE` periode di `getScopeForUser` + scope di 2 GET | 1 param, 5 call-site | M2, M5 |
| 8 | `idx_sdp_code_prin_period`, drop `idx_sdp_code` | DDL | M1 |
| 9 | Pembulatan rasio 1e-6; `Math.round` di batas bayar; `Number.isFinite` di 4 route; `GT` di 3 tempat; `branch: r.branch` | baris-baris kecil | M3, M4, M6, M12, H4 |
| 9b | Normalisasi header Excel + hentikan default silent; fallback `konstantaMix(1)`; parser angka ID | ~10 baris | H5, H6, M10, M11 |
| 10 | `updatedBy` di 2 tabel; sisa LOW | kolom + isian | M7, L1 |

Nol komponen baru, nol tabel baru, nol dependensi baru. Semua rekomendasi memakai pola yang sudah
ada di repo ini.
