# Catatan Handoff Proyek Rekonsiliasi

Tanggal pembaruan: 21 Juli 2026
Worktree lokal: `.worktrees/shinzui-reconciliation` di bawah repository
Branch lokal: `codex/shinzui-reconciliation`
HEAD saat catatan dibuat: `63e4c60e`
Status integrasi: **lokal saja; belum merge ke main, belum push, belum deploy**

## 1. Tujuan dokumen

Dokumen ini adalah pegangan untuk melanjutkan proyek dari divisi Faktur/Penjualan ke dua divisi berikutnya:

1. Pembelian.
2. Return/Retur.

Dokumen ini mencatat apa yang benar-benar sudah dibuat, aturan bersama, aturan khusus tiap prinsipal, hasil pengujian, batasan lokal, dan discovery gate sebelum Pembelian atau Return boleh diimplementasikan.

Aturan utama untuk sesi berikutnya:

- Jangan menganggap aturan Faktur otomatis berlaku untuk Pembelian atau Return.
- Jangan mengarang kunci, tanda quantity, rumus nilai, toleransi, atau arah missing tanpa sampel nyata dan persetujuan bisnis.
- Gunakan kembali pola yang sudah terbukti; jangan membuat framework generik sebelum perbedaan nyata terlihat.
- Jangan menyentuh `main`, push, atau deploy sebelum pengguna membahas dan menyetujuinya.

## 2. Status proyek saat ini

### 2.1 Divisi yang sudah dibuat

Divisi yang sudah berfungsi adalah **Faktur/Penjualan** dengan lima prinsipal:

| Prinsipal UI | Format principal | Endpoint | Status |
| --- | --- | --- | --- |
| KINO | XLSX | `POST /api/reconciliation/kino/sales` | Kode selesai; master lokal tidak tersedia di worktree ini |
| GODREJ/GDI | XLSX | `POST /api/reconciliation/godrej/sales` | Kode selesai; master lokal tidak tersedia di worktree ini |
| SHINZUI | XLSX | `POST /api/reconciliation/shinzui/sales` | Selesai dan master lokal tersedia |
| MOTASA | XLSX | `POST /api/reconciliation/motasa/sales` | Selesai dan master lokal tersedia |
| CUSSONS | CSV | `POST /api/reconciliation/cussons/sales` | Selesai, diuji end-to-end, master lokal tersedia |

### 2.2 Prinsipal yang pernah dibahas tetapi belum dibuat

- **RECKITT**: baru ada artefak analisis read-only di `.superpowers/reckitt-analysis/`. Belum ada kontrak bisnis final, parser, route, pilihan UI, master lokal aktif, atau acceptance test.
- **HEINZ**: file pernah diberikan dan dibahas, tetapi belum ada parser, route, pilihan UI, atau acceptance contract Faktur.

Jangan menampilkan RECKITT atau HEINZ sebagai prinsipal aktif sebelum alur lengkapnya disetujui dan diuji.

### 2.3 Yang belum dibuat

- Divisi Pembelian.
- Divisi Return sebagai proses tersendiri.
- Penyimpanan riwayat batch ke database.
- Review note/finalisasi/reopen batch.
- Upload master mapping melalui UI.
- Auto-correction atau write-back ke Accurate/prinsipal.
- Deployment atau integrasi ke `main`.

### 2.4 Kondisi worktree dan aturan keselamatan Git

Worktree ini **bukan worktree kosong**. Saat catatan dibuat terdapat banyak artefak untracked yang sudah ada sebelumnya, terutama:

- `.superpowers/sdd/**`;
- `.superpowers/reckitt-analysis/**`;
- `.superpowers/notes/**`;
- `task_plan.md`, `findings.md`, dan `progress.md` di root worktree;
- file laporan/screenshot/export pengujian lokal.

Aturan untuk agent/sesi berikutnya:

- Selalu jalankan `git rev-parse --show-toplevel`, `git branch --show-current`, dan `git status --short` sebelum bekerja.
- Jangan gunakan `git add .`, `git add -A`, `git clean`, atau penghapusan massal.
- Jangan stage, commit, memindahkan, atau menghapus artefak untracked yang tidak dibuat oleh task aktif.
- Stage hanya path yang secara eksplisit menjadi deliverable task.
- Pertahankan master dan file bisnis sebagai ignored/untracked.

## 3. Arsitektur yang sudah berjalan

```text
/reconciliation
  -> pengguna memilih prinsipal
  -> upload accurateFile + principalFile
  -> POST /api/reconciliation/<principal>/sales
  -> permission reconciliation.run
  -> validasi multipart, file, ukuran, format, dan master lokal
  -> parser Accurate + parser prinsipal + parser mapping
  -> CanonicalSalesLine
  -> agregasi strict union/full outer
  -> klasifikasi status + summary
  -> JSON ReconciliationOutput
  -> UI fokus selisih + filter + ekspor semua hasil
```

Peta file utama:

- `app/(dashboard)/reconciliation/page.tsx`: UI upload, pilihan prinsipal, filter, penyebab selisih, tema, tabel, dan ekspor.
- `app/api/reconciliation/<principal>/sales/route.ts`: adapter endpoint tipis untuk setiap prinsipal.
- `lib/off-program-control/kino-sales-route.ts`: trust boundary bersama untuk auth, multipart, limit file, buffering, master, status HTTP, dan masking error.
- `lib/off-program-control/sales-reconciliation.ts`: parser, mapping, canonical line, normalisasi, agregasi, rekonsiliasi, dan wrapper lima prinsipal.
- `lib/off-program-control/*sales-validation.test.ts`: self-check parser/engine dan acceptance file nyata opsional.
- `lib/off-program-control/*sales-route.test.ts`: self-check batas upload/API. MOTASA belum memiliki file route test sendiri; sebagian kontraknya memakai handler bersama.
- `tests/reconciliation-ui.spec.ts`: Playwright untuk alur UI, reset file, issue-first, endpoint, dan ekspor.

Catatan kompatibilitas:

- Nama `createKinoSalesPostHandler` dan properti output `kinoLines` masih dipakai untuk seluruh prinsipal.
- Nama tersebut adalah kontrak lama yang dipertahankan agar regresi kecil. Jangan rename hanya untuk kosmetik; itu membutuhkan migrasi kontrak dan test.

## 4. Alur pengguna Faktur

1. Buka `http://localhost:3000/reconciliation`.
2. Login dan pastikan user mempunyai `reconciliation.view` serta `reconciliation.run`.
3. Pilih prinsipal.
4. Upload `Rincian Faktur Penjualan` Accurate dalam XLSX.
5. Upload laporan prinsipal:
   - XLSX untuk KINO/GODREJ/SHINZUI/MOTASA.
   - CSV untuk CUSSONS.
6. Tombol tetap nonaktif sampai dua file dipilih.
7. Aplikasi mengirim kedua file ke endpoint prinsipal.
8. API membaca master mapping lokal dari `data/reconciliation/`.
9. Parser membentuk baris canonical, mapping SKU, class, quantity terkecil, dan lima nilai.
10. Engine mengagregasi dan membandingkan strict union dua sumber.
11. Bila ada masalah, UI otomatis membuka `ISSUES_ONLY` dan menampilkan penyebabnya.
12. Pengguna dapat memilih `ALL` atau status tertentu.
13. Ekspor XLSX selalu berisi **seluruh** `results`, bukan hanya baris yang sedang terlihat.

Saat prinsipal diganti, aplikasi wajib mengosongkan:

- file Accurate;
- file prinsipal;
- hasil;
- filter;
- error.

Aturan reset ini mencegah file lama dari prinsipal lain dikirim diam-diam.

## 5. Kontrak upload, keamanan, dan error

### 5.1 Permission

- Halaman: `reconciliation.view`.
- Menjalankan API: `reconciliation.run`.
- Auth diperiksa sebelum body upload diparsing atau master dibaca.

### 5.2 Validasi file

- Field multipart hanya `accurateFile` dan `principalFile`.
- Field tidak dikenal, ganda, atau hilang ditolak.
- Maksimum 10 MiB per file.
- Accurate selalu XLSX dan harus mempunyai magic ZIP `PK`.
- Principal XLSX juga harus mempunyai magic ZIP `PK`.
- CUSSONS CSV harus tidak kosong dan tidak mengandung NUL byte.
- Nama upload tidak pernah dijadikan filesystem path.
- Upload diproses di memori dan tidak disimpan ke disk/database.

### 5.3 Status HTTP

| HTTP | Arti |
| --- | --- |
| 400 | Multipart/field/ekstensi/MIME tidak valid atau file wajib hilang |
| 401 | Belum login |
| 403 | Tidak mempunyai permission run |
| 413 | File melebihi 10 MiB |
| 422 | Struktur atau isi file tidak dapat dipercaya/diparsing |
| 500 | Master lokal hilang atau error internal; pesan internal dimasking |

Error parser hanya boleh ditampilkan bila termasuk pesan aman. Path lokal, stack trace, detail database, atau isi sensitif tidak boleh kembali ke browser.

### 5.4 Master lokal

| Prinsipal | Path yang diharapkan | Tersedia saat catatan dibuat |
| --- | --- | --- |
| KINO | `data/reconciliation/Kino.xlsx` | Tidak |
| GODREJ | `data/reconciliation/GDI.xlsx` | Tidak |
| SHINZUI | `data/reconciliation/SHINZUI.xlsx` | Ya |
| MOTASA | `data/reconciliation/MOTASA.xlsx` | Ya |
| CUSSONS | `data/reconciliation/CUSSONS.xlsx` | Ya |

Semua `*.xlsx` dan `*.csv` bisnis di-ignore Git. Jangan force-add master atau file laporan nyata.

## 6. Model canonical Faktur

Kedua sumber dinormalisasi menjadi bentuk yang setara, minimal:

- sumber dan source row;
- nomor dokumen/order/invoice;
- tanggal;
- kode customer dan salesman;
- kode produk mentah dan internal;
- nama produk;
- `transactionClass`: `NORMAL`, `BONUS`, atau `RETURN`;
- quantity original, unit original, quantity terkecil, unit terkecil;
- gross, discount, DPP, tax, net;
- mapping status dan warnings.

Canonical key Faktur yang benar-benar dipakai:

```text
normalized order/invoice token
+ internal product code
+ transaction class
```

Customer, salesman, nama produk, tanggal, dan nomor nota disimpan untuk audit tetapi bukan bagian key bersama saat ini.

## 7. Normalisasi, agregasi, dan toleransi bersama

- Text di-trim, uppercase, NBSP/zero-width dibersihkan.
- Alias unit yang sudah diketahui: `BT -> BTL`, `TUB -> TUBE`, `INB -> BOX`.
- Identifier selalu diperlakukan sebagai string agar leading zero tidak hilang.
- Semua baris dengan key sama dijumlahkan sebelum dibandingkan.
- Engine memakai strict union/full outer, bukan inner join.
- Source rows dipertahankan untuk audit.
- Quantity harus sama persis; belum ada quantity tolerance.
- Uang disimpan fixed-point skala empat desimal (`10,000` unit per rupiah).
- Perbandingan agregat memakai toleransi Rp1 per komponen.
- Lima komponen dibandingkan terpisah: gross, discount, DPP, tax, net.
- Perbedaan net yang nol tidak menutupi selisih gross/diskon/DPP/pajak.
- `amountDifferences` hanya berisi komponen yang melewati toleransi.

## 8. Status dan precedence

Status yang benar-benar tersedia:

- `MATCH`
- `QTY_MISMATCH`
- `VALUE_MISMATCH`
- `QTY_AND_VALUE_MISMATCH`
- `MISSING_INTERNAL`: ada di prinsipal, tidak ada di Accurate.
- `MISSING_PRINCIPAL`: ada di Accurate, tidak ada di prinsipal.
- `UNMAPPED_SKU`
- `UNIT_CONVERSION_ERROR`
- `INVALID_DATA`

Precedence mapping per key:

```text
INVALID_DATA > UNIT_CONVERSION_ERROR > UNMAPPED_SKU > OK
```

Precedence status akhir yang benar-benar ada di source:

1. `INVALID_DATA`
2. `UNMAPPED_SKU`
3. `UNIT_CONVERSION_ERROR`
4. `MISSING_INTERNAL`
5. `MISSING_PRINCIPAL`
6. `QTY_AND_VALUE_MISMATCH`
7. `QTY_MISMATCH`
8. `VALUE_MISMATCH`
9. `MATCH`

Dokumen rencana awal juga menyebut `PARTIAL_MATCH`, `DUPLICATE`, `PENDING_CUTOFF`, dan status batch. Status tersebut **belum diimplementasikan** pada engine Faktur aktif.

## 9. Aturan per prinsipal Faktur

### 9.1 KINO

Sumber:

- Accurate: XLSX `Rincian Faktur Penjualan`.
- Principal: XLSX `Sheet1`; baris `TOTAL FOR...` dan `GRAND TOTAL` diabaikan.
- Master: `Kino.xlsx`, sheet `Mapping_Prd`, `Mapping_Customer`, `Mapping_Sls`.

Kunci dan mapping:

- Token order harus tepat satu `1671-SOP-\d+`.
- Accurate mengambil token dari `REM`; KINO dari `ORDER_NO`.
- `PRODUCT_CODE -> Mapping_Prd.KODE ALIAS -> KODE ITEM -> Accurate.KODE_BARANG`.
- Banyak alias KINO boleh menuju satu SKU Accurate; agregasi dilakukan setelah mapping.
- `FLAG_BONUS=Y -> BONUS`, `N -> NORMAL`; selain itu upload ditolak.

Quantity dan nilai:

- Quantity KINO memakai `INVOICE_QTY` langsung.
- UOM principal harus sama dengan unit mapping; `ISI` mapping belum dipakai untuk perkalian.
- Gross = `INVOICE_GROSS`.
- Discount = `INVOICE_TOTALLINEDISC + INVOICE_PROMO + INVOICE_CASHDISC`.
- DPP = gross - discount.
- Tax = `INVOICE_TAX`.
- Net = `INVOICE_NET`.
- Belum ada validasi internal KINO bahwa net = DPP + tax.

Error/mapping:

- SKU tidak terpetakan: `UNMAPPED_SKU`, key `UNMAPPED:<PRODUCT_CODE>`.
- UOM tidak sesuai: `UNIT_CONVERSION_ERROR`.
- Customer/salesman tidak termapping hanya warning.

Acceptance historis yang tertanam di test:

- 238 union results.
- 236 `MATCH`.
- 2 `QTY_AND_VALUE_MISMATCH`.
- Missing kedua arah: 0.

Catatan operasional: `data/reconciliation/Kino.xlsx` sedang tidak tersedia di worktree ini.

### 9.2 GODREJ / GDI

Sumber:

- Accurate XLSX.
- Principal GDI/GODREJ XLSX `Sheet1`.
- Master `GDI.xlsx`, sheet `Pvt Map 1`.

Kunci dan mapping:

- Token menerima `FK/BFG-<digits>`, `FK-<digits>`, atau `BFG-<digits>` lalu dinormalisasi menjadi `BFG-<digits>`.
- Accurate mengambil token dari `REM`; principal dari `IV_NO`.
- Principal SKU `INV_NO` dipetakan melalui `KODE PCPL -> KODE BARANG WIN2`.
- Bila satu kode mempunyai banyak kandidat, kandidat harus dapat dipilih tepat satu dari SKU Accurate pada invoice yang sama. Jika nol atau lebih dari satu kandidat: `INVALID_DATA`.
- Class selalu `NORMAL`.

Quantity dan rumus:

- Quantity = `IV_TOTPCS` langsung.
- Gross = `IV_TOTPCS * IV_PRICE / IV_FRA`.
- Discount = gross * `IV_DISC1 / 100`.
- DPP = round4(gross) - round4(discount).
- Tax = round4(DPP * 11%).
- Net = DPP + tax.
- `IV_DISC1` harus 0..100, quantity/harga nonnegatif, `IV_FRA` positif.
- Adjustment lain seperti `IV_DISC2`, stamp, additional/cash/regular discount tidak boleh nonzero karena belum ada rumus yang disetujui.
- `AR_AMT` bukan sumber authoritative.

Belum ada baseline acceptance file nyata yang final. `data/reconciliation/GDI.xlsx` juga sedang tidak tersedia.

### 9.3 SHINZUI

Sumber:

- Accurate XLSX.
- SHINZUI XLSX, sheet `PenjualanInvoice`, header nyata sekitar baris fisik 4.
- Master lokal `SHINZUI.xlsx`, sheet `Pvt Map 1`.

Kunci, class, quantity:

- Token harus tepat satu `INVGTS\d+-\d+-\d+`.
- Principal SKU `ID PRODUK` dipetakan ke SKU Accurate.
- Mapping ambigu diselesaikan memakai SKU Accurate pada invoice yang sama; harus tepat satu kandidat.
- `JUAL` dan `PROMO -> NORMAL`; `RETUR -> RETURN`.
- Quantity canonical principal = `QTY SMALL`.
- `QTY TRX-INV` dipakai untuk validasi gross, bukan untuk konversi.
- Mapping `ISI/CTN` wajib positif, tetapi tidak dipakai menghitung quantity canonical.

Nilai authoritative dan validasi:

- Gross = `VALUE EXCL DISC`.
- Discount = `TOTAL DISC INV`.
- DPP = `DPP INV`.
- Tax = `PPN INV`.
- Net = `TOTAL INV`.
- Validasi round4:
  - gross = `QTY TRX-INV * HARGA`;
  - total discount = jumlah seluruh kolom diskon yang disetujui;
  - DPP = gross - discount;
  - tax = round4(DPP * 11%);
  - net = DPP + tax.
- `RETUR` principal boleh bertanda negatif. Accurate parser bersama saat ini menolak quantity negatif, sehingga aturan Return lintas kedua sumber belum general.

Acceptance file nyata:

- 181 union results.
- 130 `MATCH`.
- 35 `VALUE_MISMATCH`.
- 1 `QTY_AND_VALUE_MISMATCH`.
- 15 `MISSING_INTERNAL` (return hanya ada pada principal).

### 9.4 MOTASA

Sumber:

- Accurate XLSX.
- MOTASA Sales Order XLSX `Sheet1`.
- Master lokal `MOTASA.xlsx`, sheet authoritative `Form Fix`, header fisik baris 5.

Kunci, class, quantity:

- Token harus standalone `MK\d{10}` dari Accurate `REM` dan MOTASA `NO.INV`.
- `KODE PRODUK` MOTASA sudah sama dengan internal SKU.
- Hanya `TIPE=SD`, class `NORMAL`.
- Unit `KRT`: quantity kecil = `PRD_QTY * ISI/CTN`.
- Unit `SCH`: quantity langsung.
- Unit asing atau pack KRT invalid: `UNIT_CONVERSION_ERROR`.

Rumus:

1. Harga dibulatkan satu desimal.
2. Gross = `PRD_QTY * roundedPrice`.
3. `DISC.1` sampai `DISC.5` diterapkan bertingkat/sequential.
4. DPP = sisa setelah diskon persen - `FIX DISC. VALUE`.
5. Discount = round4(gross) - round4(DPP).
6. Tax = round4(DPP * 11%).
7. Net = DPP + tax.

Semua rate diskon harus 0..100; quantity, harga, fixed discount nonnegatif; DPP tidak boleh negatif.

Acceptance file nyata:

- 402 union results.
- 14 `MATCH`.
- 388 `MISSING_PRINCIPAL`.
- Status lain 0.

### 9.5 CUSSONS

Sumber:

- Accurate XLSX.
- Principal `detail.csv`.
- Master lokal `CUSSONS.xlsx`, sheet authoritative `Form Fix`, header fisik baris 5/data baris 6.

Kunci, mapping, class:

- Token harus tepat satu standalone `TI\d{6}`.
- Accurate mengambil token dari `REM`; CUSSONS dari `INVOICE NO`.
- `PRODUCT CODE -> KODE PCPL -> KODE BARANG WIN2`.
- `SELLING TYPE` hanya `S`; lainnya menjadi `INVALID_DATA` per key.
- Class selalu `NORMAL`.
- Unmapped/conflict memakai deterministic key `CUSSONS_INVALID:<PRODUCT CODE>`.

Quantity:

- `EA`: `PRODUCT QUANTITY` langsung; pack tidak diperlukan.
- `CS`: `PRODUCT QUANTITY * ISI/CTN`; pack wajib positif.
- UOM lain: `UNIT_CONVERSION_ERROR`.

Nilai authoritative:

- Gross = `GROSS AMOUNT`.
- Discount = `DISCOUNT AMOUNT + CUSTOMER DISCOUNT`.
- DPP = `AMOUNT AFTER SKU DISC - CUSTOMER DISCOUNT`.
- Tax = `TOTAL TAX AMOUNT`.
- Net = `TOTAL NET AMOUNT`.

Validasi per baris pada skala empat desimal, maksimum beda Rp0,0001:

- gross = quantity sumber * round4(`UOM LIST PRICE`);
- amount after SKU discount = gross - SKU discount;
- tax = DPP * tax percentage / 100;
- net = DPP + tax;
- `TAX CODE = PPN_OUTPUT`;
- tax percentage = 11.

Sel kosong/non-numeric pada numeric wajib menolak seluruh upload 422. Numeric valid tetapi formula/tax/selling tidak konsisten menjadi `INVALID_DATA` per key.

Acceptance nyata terakhir:

- Accurate lines/union results: 52.
- Principal lines: 39.
- 39 `MATCH`.
- 13 `MISSING_PRINCIPAL` dari satu invoice Accurate-only.
- Status lain 0.
- Exact identifier dan nilai komersial sengaja tidak direproduksi di dokumen ini. Nilai tersebut sudah diwarisi dari pekerjaan sebelumnya di test acceptance yang ter-track serta artefak lokal yang ignored. Jangan menyalinnya ke dokumen/fixture baru atau push/deploy; keputusan redaksi test lama harus dibahas terpisah sebelum integrasi.

## 10. UI yang sudah dibuat

Fitur UI aktif:

- Satu halaman `/reconciliation`.
- Pilihan lima prinsipal.
- Accurate selalu XLSX; CUSSONS principal CSV; prinsipal lain XLSX.
- Loading, error, empty state, button gating, reset state.
- KPI total, cocok, bermasalah, selisih, missing, unmapped, conversion.
- Filter `ALL`, `MATCH_ONLY`, `ISSUES_ONLY`, dan setiap status.
- Default `ISSUES_ONLY` bila ada masalah.
- Penyebab selisih quantity dan setiap komponen nilai.
- Missing/unmapped/conversion/invalid dijelaskan dengan bahasa awam.
- Source rows, warning, class, dan data kedua sisi tersedia.
- Pagination 50 baris.
- Ekspor workbook `Ringkasan` + `Detail` dari seluruh hasil.
- Formula injection pada teks awal `=`, `+`, `-`, `@` dinetralkan.
- Tiga tema: `office-calm`, `neon`, `ios`.
- Fokus keyboard dan responsive layout.

Catatan: user dengan `reconciliation.view` tetapi tanpa `reconciliation.run` masih dapat melihat upload UI; API tetap menolak run dengan 403.

## 11. Pengujian dan baseline

### 11.1 Provenance verifikasi

Pisahkan dua jenis bukti berikut:

- **Rerun pada sesi dokumentasi/HEAD `63e4c60e`:** sembilan Node self-check parser/validation/route di bawah dijalankan oleh agent audit dan semuanya exit 0.
- **Bukti historis pada HEAD yang sama dari sesi implementasi/pengujian sebelumnya:** real-file CUSSONS, Playwright, lint, build webpack, live HTTP, tiga tema, dan isi export pernah lulus. Bukti ini tersimpan di artefak `.superpowers/sdd`, tetapi tidak dijalankan ulang dalam sesi pembuatan catatan ini.

Karena itu, sebelum implementasi Pembelian/Return dimulai, jalankan ulang baseline lengkap. Jangan menganggap bukti historis sebagai pengganti verifikasi fresh setelah kode berubah.

Pemeriksaan yang tersedia:

```powershell
node --experimental-strip-types lib/off-program-control/sales-reconciliation.test.ts
node --experimental-strip-types lib/off-program-control/godrej-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/cussons-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/kino-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/godrej-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/cussons-sales-route.test.ts
npx eslint "lib/off-program-control/sales-reconciliation.ts" "lib/off-program-control/kino-sales-route.ts" "lib/off-program-control/*sales-validation.test.ts" "lib/off-program-control/*sales-route.test.ts" "app/api/reconciliation/*/sales/route.ts" "app/(dashboard)/reconciliation/page.tsx" "tests/reconciliation-ui.spec.ts"
npx tsc --noEmit
npx playwright test tests/reconciliation-ui.spec.ts --project=msedge
npx next build --webpack
```

Pengujian CUSSONS historis terakhir mencakup:

- real frontend tanpa mock;
- upload XLSX + CSV;
- 52/39/13 hasil;
- 13 penyebab missing-principal;
- tiga tema;
- reset saat ganti prinsipal;
- tanpa console/page error;
- ekspor pada `ISSUES_ONLY` tetap berisi 52 baris;
- backend live 200/400/401/413/422/500;
- build dan lint berhasil.

`tsc --noEmit` dicantumkan sebagai baseline wajib berikutnya, tetapi belum dibuktikan ulang dalam sesi dokumentasi ini.

Warning yang diketahui:

- Direct TS self-check menghasilkan `MODULE_TYPELESS_PACKAGE_JSON` warning, bukan failure.
- Build lokal dapat memperingatkan `BETTER_AUTH_SECRET` default; secret non-default wajib sebelum deployment.
- Tidak ada dedicated `motasa-sales-route.test.ts`.
- Ada test RBAC lama terkait `insentif_sales.manage_hierarchy` yang gagal di luar scope rekonsiliasi.

## 12. Batas reuse untuk Pembelian dan Return

Yang aman digunakan kembali:

- Permission view/run.
- Auth sebelum body/master.
- Validasi field/ekstensi/MIME/ukuran/magic.
- In-memory upload dan safe error masking.
- Halaman `/reconciliation`, dua kartu upload jika dua sumber terbukti cukup.
- Selector, loading/error/reset, issue-first, filter, pagination, tiga tema, a11y.
- Strict union, source-row lineage, warning, per-key status.
- Fixed-point uang empat desimal sebagai teknik penyimpanan.
- Envelope `{ results, summary }`.
- Export seluruh hasil dengan formula-injection protection.
- Pola parser khusus + route adapter tipis + acceptance sintetis dan nyata.

Yang **tidak boleh** langsung digunakan sebagai kontrak lintas divisi:

- `CanonicalSalesLine`.
- Nama `kinoLines`.
- Nama `orderNumber`.
- Lima nilai gross/discount/DPP/tax/net bila laporan baru mempunyai arti berbeda.
- Key Faktur.
- Tanda quantity/nilai.
- Class `RETURN` Faktur.
- Status/precedence tanpa persetujuan proses baru.
- Dua file upload bila Pembelian ternyata tiga arah (PO, penerimaan, invoice).
- Toleransi Rp1 tanpa pembuktian.

Khusus Return: SHINZUI Faktur mempunyai row `RETUR`, tetapi itu bukan bukti divisi Return sudah tersedia. Divisi Return dapat mempunyai invoice asal, return number, reason, approval, receiving, replacement, credit note, warehouse, lot, dan aturan tanda yang berbeda.

## 13. Struktur minimum untuk dua divisi berikutnya

Struktur ini hanya rekomendasi setelah spesifikasi pilot disetujui:

```text
lib/off-program-control/
  sales-reconciliation.ts          # existing; jangan dipecah dulu
  purchase-reconciliation.ts       # pilot Pembelian
  purchase-reconciliation.test.ts
  return-reconciliation.ts         # dibuat setelah pilot Return disetujui
  return-reconciliation.test.ts

app/api/reconciliation/<principal>/
  sales/route.ts                    # existing
  purchases/route.ts                # pilot Pembelian
  returns/route.ts                  # pilot Return

app/(dashboard)/reconciliation/page.tsx
tests/reconciliation-ui.spec.ts
data/reconciliation/               # master lokal ignored bila diperlukan
```

UI minimal menambah selector divisi:

```text
Faktur | Pembelian | Return
```

Ganti divisi atau prinsipal wajib reset dua file, hasil, filter, dan error. Jangan tambah wizard, database history, chart, state library, atau konfigurasi generik pada pilot pertama.

## 14. Discovery gate Pembelian

Jangan mulai coding sebelum hal berikut tersedia dan disetujui:

1. Nama proses dan pemilik keputusan bisnis.
2. File Accurate dan file prinsipal nyata untuk minimal dua periode.
3. Nama sheet, posisi header, kolom, subtotal/footer, dan tipe data.
4. Apakah Pembelian dua arah atau tiga arah:
   - PO;
   - penerimaan/GR;
   - purchase invoice.
5. Identifier lintas sumber yang stabil.
6. Apakah supplier, warehouse, batch/lot, tax invoice, atau tanggal penerimaan menjadi key/warning/informasi.
7. Quantity yang dibandingkan: ordered, received, invoiced, accepted, atau lainnya.
8. Aturan partial receipt/backorder.
9. Komponen nilai authoritative: diskon, freight, tax, withholding, landed cost, rounding.
10. Debit/credit note, cancellation, replacement, duplicate, dan cutoff.
11. Master mapping resmi, arah mapping, owner, versi, dan cardinality.
12. Definisi MATCH/mismatch/missing/invalid/duplicate/pending.
13. Expected row, key, status, dan total yang diverifikasi bisnis.
14. Role pengguna Pembelian untuk view/run/export.
15. Timezone bisnis, periode, waktu cutoff, late posting, dan kapan pending berubah menjadi missing.
16. Aturan pembatalan, finalisasi, reopen, dan apakah proses tetap stateless atau memerlukan batch.
17. Jumlah sumber final dan boundary tiap sumber; jika lebih dari dua, tetapkan bagaimana hasil digabung dan ditampilkan.

Jika prosesnya tiga arah, pola dua file Faktur tidak cukup dan tidak boleh dipaksakan.

## 15. Discovery gate Return

1. Tentukan apakah ini sales return, purchase return, atau dua proses terpisah.
2. Sediakan file Accurate dan principal untuk minimal dua periode dengan overlap nyata.
3. Tentukan apakah wajib terkait invoice/order asal.
4. Tentukan identifier stabil: return number, invoice asal, SKU, reason, batch/lot, warehouse, party, tanggal.
5. Putuskan tanda quantity/nilai: positif bertipe Return atau negatif.
6. Tentukan aturan partial/multiple return atas invoice yang sama.
7. Tetapkan status bisnis: requested, received, approved, rejected, destroyed, replacement, credit note issued, posted, atau status resmi lain.
8. Tetapkan komponen nilai/tax/discount authoritative dan reversal/rounding.
9. Tentukan arah missing dan cutoff.
10. Cegah double-count dengan row Return yang mungkin muncul pada export Faktur.
11. Sediakan master mapping resmi dan expected acceptance totals.
12. Konfirmasi role view/run/export.
13. Tentukan apakah Return dua arah, tiga arah, atau multi-stage serta boundary setiap sumber.
14. Catat owner/versi/arah/cardinality mapping, duplicate identik, conflict, dan aturan ambigu.
15. Tetapkan timezone, cutoff, late posting, pending-to-missing, finalisasi, dan reopen.

## 16. Urutan kerja berikutnya

1. **Discovery Pembelian satu prinsipal.** Pilih berdasarkan kelengkapan data, overlap, master resmi, dan owner bisnis; tidak harus KINO.
2. **Profiling read-only.** Catat sheet/header/kolom, unique keys, overlap, unit, signs, formula, mapping cardinality, subtotal, dan invalid row.
3. **Bekukan desain Pembelian.** File contract, canonical row, key, formula, tolerance, status, API/UI, dan expected totals harus disetujui sebelum coding.
4. **Implementasi pilot minimum.** Parser/engine satu prinsipal, satu route, selector UI, test sintetis/route/real-file; semua Faktur tetap lulus.
5. **Stabilisasi dua periode.** Audit seluruh missing/mismatch dengan owner bisnis.
6. **Discovery Return.** Ulangi dari nol; jangan menurunkan rule dari class `RETURN` Faktur.
7. **Implementasi pilot Return.** Minimum dan terpisah setelah desain disetujui.
8. **Ekspansi prinsipal.** Tambah parser/mapping/route khusus berdasarkan delta nyata.
9. Database batch/history/review/finalisasi hanya dikerjakan dalam fase/spesifikasi tersendiri.

Urutan Pembelian sebelum Return berasal dari rencana awal. Ubah urutan hanya jika pengguna membuat keputusan bisnis baru.

## 17. Acceptance matrix divisi baru

Setiap pilot minimal menguji:

- perfect match;
- data hanya di Accurate;
- data hanya di principal;
- quantity mismatch;
- setiap komponen nilai mismatch;
- quantity + value mismatch;
- SKU tidak termapping;
- mapping identik dan mapping konflik;
- seluruh UOM nyata dan factor invalid;
- repeated/multi-line key;
- partial/cancellation/reversal bila disetujui;
- boundary tolerance;
- sheet/header/kolom hilang;
- angka/tanggal/identifier invalid;
- subtotal/footer;
- unauthenticated/forbidden;
- field/extension/MIME/magic salah;
- file >10 MiB;
- master hilang;
- exception internal dimasking;
- ganti divisi/prinsipal menghapus state lama;
- keyboard, mobile, tiga tema;
- export seluruh result, source rows, dan formula injection;
- acceptance file nyata minimal dua periode dengan row/status/total eksak;
- semua regression Faktur tetap lulus.

## 18. Aturan data lokal

- Semua pekerjaan tetap di worktree/branch lokal ini.
- Jangan merge `main`, push, deploy, atau mengubah `.env` tanpa permintaan eksplisit.
- Master dan laporan bisnis tetap ignored dan untracked.
- Jangan commit raw row, data customer/supplier, nilai komersial, path sensitif, atau secret baru. Test acceptance lama yang sudah ter-track mengandung exact acceptance CUSSONS; perlakukan sebagai data sensitif warisan dan putuskan redaksi secara terpisah sebelum integrasi/push.
- Jangan log stack/path lokal ke response.
- Jangan menulis upload ke disk/database tanpa spesifikasi baru.
- Jangan mengevaluasi formula/macro Excel.
- Escape teks export yang diawali `=`, `+`, `-`, atau `@`.
- Pertahankan source-row lineage, tetapi jangan mengirim seluruh raw row tanpa kebutuhan audit.
- Tidak ada auto-correction/write-back pada pilot.

## 19. Definition of Ready untuk mulai implementasi divisi baru

Satu pilot baru boleh masuk tahap coding hanya jika tersedia:

- satu divisi + satu prinsipal yang dipilih;
- owner bisnis;
- sampel minimal dua periode dan overlap yang diketahui;
- master resmi;
- owner, versi, arah, cardinality, duplicate, conflict, dan ambiguity rule untuk mapping;
- sheet/header/kolom dan aturan invalid;
- canonical fields;
- key dan agregasi;
- unit conversion;
- formula/toleransi/tanda;
- status dan precedence;
- cutoff;
- timezone, late posting, pending-to-missing, finalisasi, dan reopen;
- jumlah sumber dan boundary rekonsiliasi dua arah/tiga arah/multi-stage;
- expected status counts dan totals;
- role/access;
- batas lokal/stateless atau desain batch terpisah;
- desain tertulis yang disetujui.

Sebelum Definition of Ready lengkap, pekerjaan yang aman hanya profiling/read-only dan pembuatan fixture sintetis tanpa data sensitif.

## 20. Referensi utama

Rencana awal:

- `%USERPROFILE%\Downloads\PLAN_REKONSILIASI_OFF_PROGRAM_CONTROL.txt`

Desain dan rencana ter-track:

- `docs/superpowers/specs/2026-07-13-kino-sales-reconciliation-ui-design.md`
- `docs/superpowers/specs/2026-07-13-kino-reconciliation-ui-refresh-final-design.md`
- `docs/superpowers/specs/2026-07-14-reconciliation-difference-focus-design.md`
- `docs/superpowers/specs/2026-07-15-shinzui-reconciliation-design.md`
- `docs/superpowers/specs/2026-07-16-motasa-sales-reconciliation-design.md`
- `docs/superpowers/plans/2026-07-16-motasa-sales-reconciliation.md`
- `docs/superpowers/specs/2026-07-18-cussons-sales-reconciliation-design.md`
- `docs/superpowers/plans/2026-07-18-cussons-sales-reconciliation.md`

Implementasi:

- `lib/off-program-control/sales-reconciliation.ts`
- `lib/off-program-control/kino-sales-route.ts`
- `app/api/reconciliation/*/sales/route.ts`
- `app/(dashboard)/reconciliation/page.tsx`
- `tests/reconciliation-ui.spec.ts`

## 21. Suggested skills dan agent workflow

Untuk discovery berikutnya:

- `spreadsheets` / `xlsx`: profiling file, header, formula, unit, mapping, overlap, dan totals.
- `csv-query`: query data CSV tanpa mengubah sumber.
- `domain-modeling`: mendefinisikan canonical row, key, dan status.
- `brainstorming`: mengunci pilihan bisnis sebelum desain.
- `writing-plans`: membuat rencana implementasi setelah desain disetujui.
- `subagent-driven-development`: implementasi task per task dengan agent implementer dan reviewer terpisah.
- `test-driven-development`: RED -> GREEN untuk parser, route, dan UI.
- `webapp-testing`: simulasi frontend/full-stack lokal.
- `verification-before-completion`: bukti test/build sebelum klaim selesai.

Agent yang disarankan per pilot:

1. Agent profiling Accurate.
2. Agent profiling principal/master.
3. Agent audit overlap/formula/key.
4. Agent reviewer bisnis untuk menyatukan kontrak.
5. Implementer per task.
6. Reviewer per task.
7. Final whole-feature reviewer.
