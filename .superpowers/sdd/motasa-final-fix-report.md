# MOTASA Final Fix Report

## Temuan

Mapping produk bersatuan `SCH` boleh tidak memiliki `ISI/CTN`. Jika baris Sales Order memakai `KRT`, parser sebelumnya mengalikan kuantitas dengan `null`, menghasilkan `0` tetapi tetap berstatus `OK`.

## RED

- Ditambahkan regression test: mapping `SCH-EMPTY` (`caseSize: null`, status awal `OK`) + Sales Order `KRT`.
- Perintah: `node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts`
- Gagal sesuai harapan: aktual `OK`, ekspektasi `UNIT_CONVERSION_ERROR`.

## GREEN

- Cabang `KRT` kini hanya mengalikan kuantitas bila `caseSize` finite dan positif.
- Jika `caseSize` null, tidak finite, nol, atau negatif: `mappingStatus = UNIT_CONVERSION_ERROR`; kuantitas sumber tidak diubah menjadi nol.
- Focused MOTASA test: lulus.

## Verifikasi

- Seluruh 7 tes parser/API `lib/off-program-control/*.test.ts`: lulus.
- ESLint dua file berubah: lulus.
- `git diff --check`: lulus (hanya peringatan konversi line ending Git di Windows).
- Acceptance tiga file asli MOTASA: lulus; assertion tetap `402` hasil, `14 MATCH`, `388 MISSING_PRINCIPAL`, status selisih lain `0`.
- Tidak ada perubahan main, push, deploy, atau dependency.

## Concern

- Node mencetak peringatan `MODULE_TYPELESS_PACKAGE_JSON` yang sudah ada sebelumnya; tidak diatasi karena di luar lingkup fix.
