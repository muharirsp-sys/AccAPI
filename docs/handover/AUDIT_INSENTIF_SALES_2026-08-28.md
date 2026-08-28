# AUDIT MODUL INSENTIF SALES — 2026-08-28

> Read-only. **Tidak ada satu baris kode pun yang diubah untuk audit ini.**
> Metode: 4 sub-agent paralel (kalkulasi, query/DBA, akses & kebocoran data, konsistensi lintas
> layer) atas `main` HEAD `f85fab9` + perubahan uncommitted. Penerus
> [AUDIT_INSENTIF_SALES_2026-08-24.md](AUDIT_INSENTIF_SALES_2026-08-24.md) — temuan yang di sana
> sudah FIXED tidak diulang, kecuali dua residu yang ditandai eksplisit.
> Tanda **[V]** = klaim diverifikasi ulang langsung ke kode oleh sesi utama, bukan hanya laporan agent.

## Ringkasan

66 temuan dari empat agent, setelah dedup jadi 43. Yang paling penting:

- **3 CRITICAL** — dua di antaranya membuat nominal yang **ditulis Finance ke database** salah, satu
  membuka data seluruh perusahaan ke user yang lupa dikonfigurasi.
- **12 HIGH** — didominasi satu pola: **filter kepemilikan ada di jalur baca utama tapi tidak ada di
  jalur tulis dan jalur rekap.** Empat endpoint yang menyentuh uang tidak memeriksa data siapa yang
  disentuh, hanya memeriksa permission.
- Nol temuan pada: batas tier/strata, pembagian nol/`NaN`/`Infinity`, `SUM()` bigint-sebagai-string
  (C0 tuntas), double-trigger `incentive_payments`, dan pembulatan rupiah.

Pola paling berulang di seluruh audit: **aturan bisnis benar di layer kalkulasi, tapi konteks yang
dikirim ke layer itu bisa salah** (filter UI, default palsu, target 0, kode sales di luar cakupan).
Kalkulasi murni di `lib/insentif-*-calc.ts` justru bagian paling sehat dari modul ini.

---

## CRITICAL

### C1 · Filter Principal/Cabang mengubah nominal insentif mix, dan nominal itu yang dibayar **[V]**

- **Lokasi:** [dashboard/route.ts:71-78](../../app/api/insentif-sales/dashboard/route.ts) (filter) →
  `:110` (`mixGroups`) dan `:132` (`mtMixGroups`) mengiterasi `targets` yang **sudah difilter**;
  [page.tsx:3045](<../../app/(dashboard)/insentif-sales/page.tsx>) menulis `totalIncentive` dari nilai itu.
- **Skenario:** salesman mix 3 principal (A/B/C), konstanta n=3 = Rp 1,2jt → baris A = Rp 400.000.
  Finance memfilter `?principle=A` → grup jadi n=1 → konstanta Rp 1jt → baris A = **Rp 1.000.000**.
  **2,5× untuk data yang sama.** Filter tampil di tab Verifikasi Finance dan persist di URL antar tab.
  Klik "Tandai Lunas" menyimpan angka inflasi itu permanen; sejak M9 baris lunas menampilkan snapshot
  itu sebagai angka yang benar. Rincian di layar tidak bisa membongkarnya — `SalesBreakdown`
  menghitung gabungan dari `semuaBaris` yang juga sudah difilter.
- **Rekomendasi minimal:** satu variabel baru; grup mix dibangun dari daftar TANPA filter tampilan:
  `const groupTargets = scopedTargets.filter((t) => !isOfficeRow(...))`, dipakai loop `:110` dan `:132`;
  `targets` yang difilter tetap dipakai `rows.map`. Nol perubahan di `lib/`.

### C2 · Default demo `NESTLE`/`BANDUNG` dipasang ulang di klien — M10 terbuka lagi **[V]**

- **Lokasi:** [page.tsx:1250-1251](<../../app/(dashboard)/insentif-sales/page.tsx>)
  `String(r.principle || "NESTLE")` / `String(r.branch || "BANDUNG")`, vs parser yang sudah benar
  ([insentif-sales-excel.ts:151](../../lib/insentif-sales-excel.ts)) dan tiga validator di
  `page.tsx:1275` + [targets/route.ts:112](../../app/api/insentif-sales/targets/route.ts).
- **Skenario:** baris pemisah/subtotal Excel (kode+nama ada, Principal kosong) → klien mengubahnya
  jadi `NESTLE`/`BANDUNG` **sebelum** validasi → ketiga lapis memeriksa nilai yang sudah dipalsukan →
  tersimpan target hantu. `n` mix naik 1 (konstanta 1,2jt → 1,4jt), `budgetAo` dibagi lebih banyak,
  dan muncul baris penerima yang bisa ditandai Lunas.
- **Catatan:** status M10 di audit lama ("ditolak di 3 lapis") **tidak akurat** untuk jalur upload Excel.
  Jalur Simpan Manual tetap terjaga.
- **Rekomendasi minimal:** ganti dua fallback itu jadi `""`. Validator yang ada langsung bekerja.

### C3 · Scope kepemilikan **fail-open**; tidak ada peran untuk salesman perorangan **[V]**

- **Lokasi:** [insentif-hierarchy-scope.ts:114](../../lib/insentif-hierarchy-scope.ts) —
  `if (!row?.hierarchyRole || !row.hierarchyName) return null;` dan `null` berarti **tanpa filter**.
- **Skenario:** SPV baru diberi group `insentif_sales.view` tapi admin lupa mengisi identitas
  hierarki → `GET /dashboard` mengembalikan target, realisasi, support, dan nominal insentif
  **seluruh salesman semua cabang semua principal**, tanpa error dan tanpa tanda apa pun.
  `hierarchyRole` hanya mengenal `spv` dan `sm` — seorang salesman **tidak bisa** dibatasi ke datanya
  sendiri dengan desain sekarang.
- **Rekomendasi minimal:** balik defaultnya jadi fail-closed (`Set` kosong) dan pindahkan "lihat
  semua" ke permission eksplisit baru `insentif_sales.view_all`, diberikan ke group Admin/Finance saat
  migrasi supaya tidak ada regresi. Tambahkan `hierarchyRole = "sales"` (scope = kode sales itu sendiri).

---

## HIGH

| # | Temuan | Lokasi | Inti risiko |
|---|---|---|---|
| H1 | `GET /payments` tanpa row-level filter **[V]** | `payments/route.ts:20-44` | SPV mana pun mengambil seluruh `incentive_payments` 12 bulan: nama, nominal, status, siapa membayar — untuk semua sales, semua SPV lain, semua SM. Bocor di API **dan** di UI (strip Rekap bulan non-berjalan merender `payments` mentah). Inilah celah "lupa di endpoint rekap" yang paling dikhawatirkan. |
| H2 | `POST /progress` tanpa cek kepemilikan **[V]** | `progress/route.ts:68` | Pola DELETE-lalu-INSERT dengan `salesCode` dari payload. Pemegang `upload_progress` bisa menghapus permanen realisasi tim lain (kirim nilai 0 untuk beberapa tanggal → insentif tim itu jadi Rp 0) atau menaikkan angka timnya sendiri. Baris yang dihapus tidak meninggalkan jejak. Jalur kedua `POST /api/laporan-harian/upload` menulis tabel yang sama hanya dengan permission modul lain. |
| H3 | `POST /support` & `/spv-support` tanpa cek kepemilikan **[V]** | `support/route.ts:41`, `spv-support/route.ts:45` | Support memotong pool insentif = uang. Kirim `supportAmount: 50000000` untuk kode sales orang lain → insentifnya nol; kirim 0 untuk diri sendiri → pool penuh. |
| H4 | `POST /payments` menerima nominal dari klien tanpa hitung ulang **[V]** | `payments/route.ts:58-128` | `totalIncentive` dipakai apa adanya; `salesCode` teks bebas, tidak dicek ada di `sales_targets`, tidak dicek `isOfficeRow`, tidak dicek scope. Penerima fiktif dengan nominal karangan bisa dicatat lunas. Untuk bulan lampau tidak ada pembanding hitung-ulang sama sekali. |
| H5 | `sales_daily_progress` tanpa UNIQUE → realisasi dobel saat retry **[V]** | `db/schema.ts:761-787` | Idempotensi hanya dijaga aplikasi. Pada READ COMMITTED, upload #2 yang dijalankan sebelum #1 commit menghapus 0 baris lalu menyisipkan semuanya → realisasi dua kali lipat, pengali naik ke cap, insentif dibayar dobel, tanpa error. 502 pada jalur upload sudah pernah terjadi di sistem ini, jadi retry bukan hipotesis. |
| H6 | ~2.000 statement DELETE berurutan per upload dalam satu transaksi | `progress/route.ts:103-126`, `laporan-harian/ingest.ts:42-63` | Jumlah DELETE ≈ jumlah baris payload. Sekarang 2-5 detik; pada 10× data jadi puluhan detik sampai menit, memegang satu koneksi pool dan row lock selama itu → memicu 502 → memicu H5. Perbaikannya satu DELETE dengan daftar tuple (2.000 round-trip → 2), dan kolomnya persis prefiks indeks yang sudah ada. |
| H7 | Fan-out koneksi per pemuatan halaman melebihi pool **[V]** | `lib/db.ts:12` (`max: 20`, dibagi dengan better-auth) | Tab Finance menembak `/dashboard` + `/spv-dashboard` + `/sm-dashboard` paralel; tiap `db.select()` di dalam `Promise.all` memakai koneksi sendiri ≈ 19 koneksi untuk satu user satu halaman. Dua user bersamaan, atau satu user + satu upload, membuat request mengantre lalu mati di `connectionTimeoutMillis` → pesan "Data insentif belum berhasil dimuat" yang hilang-muncul. **Perbaikan tanpa deploy: set `PG_POOL_MAX=50` di env Coolify.** |
| H8 | Toggle Target AO = "file": baris ber-Target-AO 0 kehilangan seluruh komponen 70% | `dashboard/route.ts:96`, `insentif-sales-calc.ts:124` | `aoTargetOf` meneruskan 0 apa adanya; `?? TARGET_AO_MIN` tidak menolong karena 0 bukan `undefined`. Baris seperti ini nyata (commit `be5580d` mencatat 4 baris target Juli kosong). Satu klik toggle memindahkan Rp 700.000 per baris. Fix: `gtAoMode === "file" && t > 0 ? t : undefined`. |
| H9 | Baris bertarget 0 tetap dibayar Rp 700.000 dari komponen AO | `insentif-sales-calc.ts:115-130` | `hasPositiveNetSales` menjaga realisasi, bukan target. Komponen AO memakai penyebut 240 dan tidak melihat target Value sama sekali. Di mix, baris hantu bertarget 0 menaikkan pool untuk semua anggota grup. **Perlu keputusan Anda** — memperbaikinya menurunkan nominal. |
| H10 | `achieved_ec/ao/ia` masih `integer` sementara API menerima pecahan **[V]** | `db/schema.ts:773-775`, `progress/route.ts:84-96` | Kelas bug yang sama dengan `target_ia = 204.8` yang baru diperbaiki; kolom realisasi tidak ikut dilebarkan. Satu sel `0,5` di file closing atau satu input manual `1.5` → `invalid input syntax for type integer` → seluruh upload 2.000 baris rollback dengan pesan Postgres mentah. Fix termurah: tambah `Number.isInteger` ke validator supaya jadi 400 bernomor baris. |
| H11 | Support SPV dipetakan ke `spv_name` file, sementara yang membayar memakai override assignment | `page.tsx:2624-2633` vs `spv-dashboard/route.ts:65` | Setelah salesman dipindah antar SPV lewat Kelola Hierarki, panel support masih menampilkan nama SPV lama → support tersimpan atas nama yang salah → `supportOf` = 0 → principal tidak dikeluarkan dari hitungan rate. Contoh terukur: total Rp 1.800.000 alih-alih Rp 1.600.000, dan support Rp 4,17jt tidak memotong apa pun. Fix: kirim `effectiveSpvName`/`effectiveSmName` dari server, jangan biarkan klien menurunkannya. |
| H12 | `period_month`/`period_year` diambil dari dropdown, bukan diturunkan dari `date` | `progress/route.ts:141-142` ← `page.tsx:1854` | Default dropdown = bulan berjalan. Upload closing Juli di awal Agustus tanpa mengubah dropdown → 2.000 baris bertanggal Juli tersimpan sebagai periode 8. DELETE-per-scope tidak akan pernah membersihkannya. **Ini sudah pernah terjadi di sistem ini.** Fix: turunkan periode dari `date`, atau tolak baris yang bulannya tidak cocok. |

---

## MEDIUM

| # | Temuan | Lokasi | Inti |
|---|---|---|---|
| M1 | Tidak ada audit trail before/after untuk perubahan angka | seluruh modul | Yang ada hanya kolom penulis terakhir yang **ditimpa** setiap perubahan. `incentive_tiers`, `spv_sales_assignment`, `sm_spv_assignment`, dan `user.hierarchyRole` bahkan tidak punya kolom aktor. DELETE di `progress` tidak tercatat sama sekali. Modul lain punya `offAuditLog`/`claimAuditLog`/`kontrolAuditLog`; insentif tidak. |
| M2 | Empat GET lain tanpa scope: `/support`, `/spv-support`, `/progress`, `/unmatched` | masing-masing | Dengan `/progress` + `/support`, seorang SPV bisa **merekonstruksi sendiri** insentif personal setiap orang meski `/dashboard` sudah memfilter — drill-down yang dilarang prinsip agregat. `/unmatched` menambahkan nomor nota. |
| M3 | Peta hierarki se-perusahaan bocor lewat 2 GET | `hierarchy/spv-sales:23`, `hierarchy/sm-spv:17` | M5 memperbaiki `code-merge` dan `spv-mismatch` tapi melewatkan dua route ini. Isinya justru input yang dibutuhkan untuk menyalahgunakan H2/H3/H4 (perlu tahu kode sales orang lain). |
| M4 | `channel` tidak pernah dinormalisasi, tapi dibaca dengan perbandingan literal **[V]** | `insentif-sales-excel.ts:155`, `dashboard/route.ts:99` | `"Gt"` atau `"gt"` di file target → tidak cocok GT/TT/MT → seluruh baris itu insentif Rp 0, kolom Pencapaian tetap normal sehingga tidak terlihat salah, dan barisnya hilang dari panel Support. Bandingkan `tipeSales`/`statusInsentif` yang punya `normalizeX` + `throw`. |
| M5 | `POST /payments` tanpa `paymentStatus` **mereset baris lunas jadi "belum"** | `payments/route.ts:101,115` | `paymentStatus` dan `paymentProofUrl` ada di dalam blok `onConflictDoUpdate.set` tanpa guard "hanya kalau dikirim". Uang yang sudah ditransfer bisa tampil kembali sebagai utang. Nilai status juga tidak pernah divalidasi: `"Lunas"` tersimpan dan dibaca sebagai belum di tiga tempat. |
| M6 | `tipeSales` tidak dijaga konsisten per kode sales | `targets/route.ts:149-169` | Tiga baris satu salesman yang semuanya tertulis `Exclusive` → 3 × Rp 1jt = Rp 3jt, padahal mix n=3 = Rp 1,2jt. Fix: tolak payload di mana satu `salesCode` punya lebih dari satu `tipeSales` (pola `seen`-map yang sudah ada). |
| M7 | Salesman lintas channel (GT + MT) mendapat dua pool konstanta | `dashboard/route.ts:110,132` | Rp 2jt alih-alih Rp 1,4jt untuk 4 principal. Biaya pemeriksaan nol: kalau data seperti ini tidak ada, temuan tertutup dengan bukti. |
| M8 | Principal bertarget 0 ikut menghitung `n` SPV → rate turun | `insentif-spv-calc.ts:157` | Principal yang pasti tidak dibayar (target 0 → pengali 0) hanya mengencerkan rate: total Rp 800.000 alih-alih Rp 1.500.000. **Perlu keputusan Anda** — memperbaikinya menaikkan nominal. |
| M9 | `date` closing diterima apa adanya; nilai sampah lolos ke tabel uang | `excel-date.ts:26`, `progress/route.ts:79` | Upload menerima `.csv` di mana TANGGAL bukan `Date`. `"45841"` → `"+045841-01"`; `"03/07/2026"` → bulan salah; hari 13-31 jatuh ke fallback tanggal 1, sehingga upload berikutnya untuk tanggal 1 menghapus 19 hari sekaligus. Fix: tolak `date` yang tidak cocok `^\d{4}-\d{2}-\d{2}$`, dan hentikan upload alih-alih fallback. |
| M10 | `getCurrentSpvOwner` memakai seluruh riwayat tanpa `ORDER BY`, dan itu memutuskan otorisasi klaim | `insentif-hierarchy-scope.ts:93` | Residu M2. Baris riwayat lama bisa menang (urutan berubah setelah VACUUM) → klaim SPV lolos langsung atau tertahan approval tanpa pola, berubah antar percobaan tanpa data berubah. |
| M11 | Agregasi periode penuh dijalankan 3× per pemuatan halaman tanpa indeks penutup | `insentif-sales.ts:199-236` | Ketiga dashboard menghitung agregat yang persis sama. Pada 10× data: 1-3 detik per agregasi, tab Finance 5-9 detik. Fix satu indeks `INCLUDE`. |
| M12 | "Ave IA TT/MT" memakai total Item Aktif, bukan per-outlet; "Avg AO/Sales" dihitung dua cara | `page.tsx:820,884` vs `:818` | Kolom menampilkan ~1.200 sementara angka yang dipakai membayar 10,4 — pola yang sama dengan ISQ 6.103%. Dan dua tabel bersebelahan memberi angka berbeda 3× untuk label yang sama. |
| M13 | `user.hierarchyName` dicocokkan `===` ke nama yang hanya di-`trim()` | `insentif-hierarchy-scope.ts:120` | `"Marten"` vs `"MARTEN"` → scope kosong → SPV melihat 0 baris tanpa error dan seluruh uploadnya ditolak 403, tanpa cara membedakannya dari "target belum diupload". |
| M14 | Dua penulis `sales_daily_progress` masih berbeda soal `spv_name` | `progress/route.ts:139` vs `laporan-harian/ingest.ts:67-82` | Baris dari Laporan Harian punya `spv_name` NULL → tidak pernah muncul di `/spv-mismatch` → panel melaporkan "0 ketidaksinkronan" untuk jalur yang sekarang dipakai bersamaan. Residu C1. |
| M15 | `POST /tiers` tanpa validasi numerik, tanpa transaksi, tanpa jejak | `tiers/route.ts:44-91` | Perbaikan M3 tidak diterapkan di sini. `Infinity`/`NaN` bisa tersimpan dan mengubah strata seluruh perusahaan; tabelnya tidak punya kolom aktor. |
| M16 | `POST /spv-mismatch` & `/code-merge` tanpa cek kepemilikan baris | keduanya | Kalau `manage_hierarchy` diberikan ke seorang SPV (namanya terdengar seperti "kelola tim saya"), ia bisa memindahkan salesman SPV lain ke grupnya, melewati seluruh alur klaim/approval yang sengaja dibuat. |

---

## LOW

`/insentif-sales` tidak terdaftar di `pagePermissions` sehingga halaman ter-render untuk siapa pun
ber-`dashboard.view` (data tetap 403) · `insentif_sales` absen dari preset legacy sehingga bypass
dev-lokal tidak bisa dipakai menguji perbaikan scope · `inputBy` diisi nama di satu route dan user id
di route lain · `parseInt(month)` tanpa validasi → 500 alih-alih 400 · `idx_sdp_code` redundan
struktural (prefiks murni indeks lain) dan dibayar tiap upload · `idx_inc_payments_period` urutan
kolomnya tidak melayani query "setahun" · `POST /targets` satu INSERT per baris · status
`"tunggakan"` dirender di 4 tempat tanpa satu pun jalur tulis · `EMPTY_ROW.channel = "GT"` vs default
`"TT"` di tiga layer lain · dua test (`excel-date`, `insentif-sales-excel`) mengimpor tanpa `.ts`
sehingga **tidak jalan** di loop self-check yang didokumentasikan di handover11 §8 — termasuk test
regresi tanggal yang baru jadi sumber masalah · `data.ts:89-238` memuat tabel aturan insentif KEDUA
yang mati dan bertentangan dengan aturan hidup · `computeMix().total` ≠ jumlah `rincian` sejak guard
L2b (selisih Rp 112rb pada contoh terukur; dashboard hanya memakai `rincian`, jadi belum bergejala) ·
`SpvBreakdown` tanpa kolom support sehingga selisih rate-vs-dibayar tak terjelaskan dan label
"Rp 0 · belum 100%" muncul untuk baris berpencapaian 130% · kolom ISQ GT/TT sekarang meleset ke bawah
dan tetap menyeret "Total Pencapaian" yang merata-rata 4 KPI padahal GT dibayar atas 2 · `PATCH
/payments/[id]` tidak pernah memperbarui nominal (laten sampai ada baris non-lunas) · tidak ada
prorata waktu sehingga "Tandai Lunas" di tengah bulan menyimpan angka yang belum matang.

---

## Yang sengaja TIDAK direkomendasikan untuk diubah

1. **Grouping SPV/SM di JavaScript, bukan SQL.** Aturannya (mix, support yang menutup rate, whitelist,
   `_OFFICE`) tidak bisa dinyatakan sebagai agregat SQL. Memaksakannya ke SQL akan memindahkan aturan
   uang ke tempat yang tidak bisa dites murni. Ini keputusan yang tepat, bukan utang.
2. **`getTargetsForPeriod` di `/dashboard` dipanggil tanpa filter principal di level DB.** Perhitungan
   mix membutuhkan seluruh principal salesman itu; memfilter di DB justru akan mengubah nominal. Yang
   salah adalah filter di memori sesudahnya (C1), bukan query-nya.
3. **`resolveValidSet` yang non-monoton** (principal yang dikecualikan tidak masuk lagi saat rate naik)
   — sudah dikonfirmasi sebagai perilaku yang dikehendaki dan dikunci test.
4. **Celah strata SM 99-100%** — sengaja masuk strata Rp 1,5jt, dikonfirmasi.
5. **Setelan ambang AO bersifat global, bukan per periode.** Per-periode terdengar lebih benar, tapi
   menambah satu dimensi pada setiap pembacaan setelan dan pada UI-nya. Periode yang sudah lunas
   sudah terlindung snapshot + penanda drift, jadi biaya dari kesederhanaan ini kecil.
6. **Dua salinan `pct`/`itemSuper`** di `lib/insentif-sales.ts` dan `data.ts` — byte-identik dan sudah
   terverifikasi sama. Menyatukannya berarti klien mengimpor modul server. Biarkan, tapi jangan
   menambah salinan ketiga.
7. **Refactor besar apa pun** di modul ini. Semua rekomendasi di atas berbentuk satu variabel, satu
   predikat, satu indeks, atau satu env — karena yang rusak bukan arsitekturnya.

---

## Filter data setara Finance — status per endpoint

Prinsip yang dipakai menilai (ditambahkan ke `SYSTEM_MAP.md`): row-level filter berbasis kepemilikan
**di layer query, bukan UI**; least privilege per peran; audit trail before/after untuk setiap
perubahan angka; agregat tidak boleh bisa di-drill-down jadi angka personal orang lain.

| Route | Scope pada baca | Scope pada tulis | Audit trail | Risiko |
|---|---|---|---|---|
| `dashboard`, `spv-dashboard`, `sm-dashboard` | **ya** | — | n/a | aman (kecuali C1/C3) |
| `targets` | **ya** | **ya** (`:171-195`) | penulis terakhir saja | rendah |
| `targets/template`, `hierarchy/my-identity`, `hierarchy/spv-sales/requests`, `settings` | n/a / ya | n/a / ya | ada | **aman** |
| `payments`, `payments/[id]` | **TIDAK** | **TIDAK** | tanpa before/after | **H1, H4** — rekap uang seluruh perusahaan |
| `progress` | **TIDAK** | **TIDAK** | DELETE tanpa jejak | **H2** — bisa hapus realisasi tim lain |
| `support`, `spv-support` | **TIDAK** | **TIDAK** | ditimpa | **H3** — bisa menolkan insentif orang lain |
| `unmatched` | **TIDAK** | — | n/a | M2 — kode sales + nota se-perusahaan |
| `hierarchy/spv-sales` (GET), `hierarchy/sm-spv` (GET) | **TIDAK** | POST ya / TIDAK | tanpa aktor | M3 — peta hierarki lengkap |
| `code-merge`, `spv-mismatch` | ya | **TIDAK** | penulis terakhir | M16 |
| `tiers` | n/a (global) | n/a | **tidak ada** | M15 |
| `hierarchy/user-identity` | admin-only | admin-only | **tidak ada** | M1 — ini yang menentukan siapa lihat data siapa |
| `laporan-harian/upload` (lintas modul) | — | **TIDAK** | INSERT saja | **H2** — menulis tabel insentif dengan permission modul lain |

**Tidak ditemukan** endpoint export/cetak/Excel terpisah yang menyentuh data insentif: `app/(cetak)/**`
hanya Rekapan Nota, dan `lib/insentif-sales-excel.ts` hanya template + parser. Celah "lupa di endpoint
export" di modul ini bermanifestasi sebagai H1 (`GET /payments`), bukan sebagai route export.

**Urutan yang disarankan:** C3 lebih dulu. Begitu defaultnya fail-closed, H1/M2/M3 menjadi satu baris
filter yang seragam, bukan sepuluh perbaikan terpisah.

---

## UX/UI

Dinilai dengan dial `VARIANCE 3 / MOTION 2 / DENSITY 7` — ini panel operasional harian, bukan halaman
pemasaran. Kepadatan tinggi memang tujuannya.

### Quick win (styling/layout, tanpa perubahan data)

1. **Sebab di samping angka nol.** Baris Rp 0 tidak pernah menjelaskan dirinya. Yang paling sering
   ditanyakan: "kenapa dapat/tidak dapat". Rincian sudah ada; tinggal satu badge di kolom total:
   `belum 90%` / `target belum diisi` / `ditanggung principle` / `bukan skema`.
2. **Bedakan "tidak ada data" dari "tidak ada akses".** Scope kosong (M13) dan target belum diupload
   menghasilkan layar identik. Satu banner: "Identitas hierarki Anda: MARTEN — 0 baris cocok".
3. **Kolom yang tidak sebanding jangan diberi label yang sama** (M12). "Ave IA" → "IA/Toko", dan
   samakan pembagi "Avg AO/Sales" di dua tabel.
4. **Filter yang aktif harus terlihat saat menandai Lunas.** Selama C1 belum diperbaiki ini mitigasi
   termurah: tampilkan "Filter aktif: KINO" di header tabel pembayaran, merah.
5. **Nonaktifkan "Tandai Lunas" untuk periode berjalan** (LOW soal prorata) — atau konfirmasi kedua.
6. **Toggle ambang AO menyebutkan dampaknya**: "12 baris ber-Target-AO 0 akan kehilangan komponen AO".

### Perlu kerja lebih besar

7. **Satu ringkasan atas untuk Finance**: total insentif periode, sudah dibayar, sisa, dan jumlah baris
   yang butuh perhatian (tanpa target / tanpa support / drift). Sekarang informasi itu tersebar di
   empat panel. Perlu satu endpoint ringkasan supaya tidak menarik semua baris ke klien.
8. **Virtualisasi tabel target.** Input manual me-render 95 baris × ~14 input; pada 300 baris halaman
   akan terasa berat. Baru kerjakan kalau memang sudah terasa.
9. **Riwayat perubahan per baris** — begitu tabel audit (M1) ada, tampilkan "diubah oleh X, dari Rp A
   ke Rp B" di rincian. Ini yang membuat angka bisa dipertanggungjawabkan, bukan cuma benar.

Tidak diusulkan: redesign, bahasa visual baru, animasi tambahan, atau grafik baru. Yang ada sudah
konsisten; masalahnya bukan tampilan, tapi angka yang tidak menjelaskan dirinya.

---

## Catatan proses

- Komentar di `db/schema.ts:757, 786, 826, 885` masih berbunyi "belum aktif di produksi" padahal DDL-nya
  sudah dijalankan — menyesatkan pembaca berikutnya.
- Perbaikan `excel-date` sesi ini menggeser `date` yang dihasilkan dari file yang sama, sehingga
  **upload ulang periode lama akan MENAMBAH, bukan menimpa**. Juli dan Agustus 2026 sudah dihapus
  manual (dikonfirmasi user 2026-08-27), jadi keduanya bersih. Juni 2026 masih menyimpan 6 baris dari
  jalur lama. Aturan tetap: hapus periode dulu, baru upload ulang.
