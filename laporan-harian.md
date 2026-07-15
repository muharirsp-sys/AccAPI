<!--
Tujuan: Panduan operasi pipeline Laporan Harian per SPV/SM.
Caller: Developer/admin saat setup, parallel-run, troubleshooting, atau pengiriman laporan.
Dependensi: Next.js API, FastAPI laporan_harian, PostgreSQL, SMTP, dan file Accurate.
Main Functions: Menjelaskan upload, dry-run, feed dashboard, send/retry, serta checklist go-live.
Side Effects: Tidak ada; dokumentasi operasional.
-->
# Modul Laporan Harian per SPV/SM

Menggantikan pipeline Excel lama (Power Query `2.3 To SPV dan SM New.xlsx` +
`generate_laporan_from_sheets.exe` + `kirim_laporan_gui.exe`, ~35 menit) dengan alur web
di AccAPI (proses ~detik).

## Alur

```
Tarik 3 laporan dari Accurate: Penjualan (rincian faktur INV) + Retur (RJN) + Stock (Kuantitas per Gudang)
        │  upload 3 file via web  (menu "Laporan Harian")
        ▼
POST /api/laporan-harian/upload        (permission: laporan_harian.upload)
  -> FastAPI /laporan-harian/process
     - build_fix_from_accurate(penjualan, retur, lookups)  = web BANGUN "2. To Format" sendiri
       (retur RJN otomatis dinegasikan; lookup GOLONGAN/JENIS PRODUK/SM dari laporan_harian_lookups.json)
     - SalesBase = AO/EC/IA + turunan; split per SPV
     - tulis file per-SPV -> runtime/laporan-harian/<runId>/<tanggal>_<SPV>.xlsx
  -> feed dashboard: sales_daily_progress (batch replace-per-periode, lib/laporan-harian/ingest.ts)
  -> catat report_run (dry_run) + report_run_recipient (pending, dari report_recipient)
  <- ringkasan per SPV + PREVIEW penerima (EMAIL BELUM DIKIRIM)
        │  review
        ▼
POST /api/laporan-harian/<runId>/send   (permission: laporan_harian.send)  ← GATED
  - WAJIB body { "confirm": true }; kalau tidak -> 400 (tidak kirim)
  - claim atomik `dry_run|failed` -> `sending`; status `sent|sending` ditolak
  - ambil file per-SPV dari FastAPI /laporan-harian/file, kirim (nodemailer + attachment)
  - update status per penerima + report_run.status; retry hanya penerima `failed`
```

## Sumber lookup master

`python_backend/laporan_harian_lookups.json` (di-commit) berisi principal→SPV, principal+jenis→SPV,
kode jenis produk→nama, principal→NAMA SM. **Perbarui** bila ada principal/SPV/SM baru:
regenerasi dari sheet GOLONGAN/JENIS PRODUK ("2. To Format") + Mapping ("2.3").

## Setup (sekali)

```bash
cd AccAPI/_github_clean
DATABASE_URL=postgres://... npx drizzle-kit push
DATABASE_URL=postgres://... node --experimental-strip-types scripts/seed-rbac-presets.ts
DATABASE_URL=postgres://... node scripts/sync-insentif-hierarchy.mjs
# pastikan python_backend punya calamine (baca Excel cepat):
pip install python-calamine pyexcelerate
# SMTP di .env.local: SMTP_HOST/PORT/USER/PASSWORD/FROM  (email nol sebelum diisi)
```

`report_recipient` ikut migrasi data D4 dari SQLite ke PostgreSQL. Untuk instalasi PostgreSQL
kosong, isi mapping penerima melalui data migration/admin sebelum tombol Kirim dipakai.

## Tabel

- `report_recipient` — keyword (SPV/principal) -> daftar email (pengganti mapping_laporan.csv).
- `report_run` — audit tiap proses (dry_run|sending|sent|failed, jumlah file/email/baris).
- `report_run_recipient` — log per-email per run.

## Checklist go-live (parallel-run)

1. Jalankan `node scripts/migrate-laporan-harian.mjs`, cek `report_recipient` terisi.
2. Untuk 1 periode: proses via web + refresh Excel `2.3` manual pada FIX yang sama.
3. Bandingkan per SPV: **jumlah baris + DPP + AO/EC/Item Aktif** (tab ringkasan web vs sheet 2.3).
4. Cek dashboard insentif-sales realisasi (`sales_daily_progress`) muncul benar.
5. Uji `/send` ke email internal dulu (edit report_recipient sementara) sebelum ke penerima asli.
6. Setelah cocok minimal 1 periode, matikan alur Excel lama.

## Catatan / TODO

- **Mapping NAMA SM**: match nama principal FIX vs sheet Mapping `2.3` masih exact-string;
  normalisasi via `python_backend/principle_matcher.py` bila banyak yang tak ke-match.
- **Otomasi penuh (opsional)**: tarik langsung dari Accurate API (tanpa upload) +
  cron `app/api/cron/laporan-harian` — belum dibangun (butuh endpoint retur & saldo stock Accurate).
- **CUSTOMER** = KODE PELANGGAN INDUK (kolom F Paste Acc); resolve ke nama pakai `Mapping_Customer.xlsx` bila perlu.
