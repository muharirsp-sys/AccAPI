# Product

<!-- impeccable:product-schema 1 -->
<!--
Tujuan: Konteks produk yang tahan lama untuk skill desain (Impeccable, Taste, antislop). Bukan arah visual (lihat DESIGN.md).
Caller: agen sebelum audit/redesign layar. Sumber: AGENTS.md, SYSTEM_MAP.md, docs/prd/00-overview.md, docs/UI_DESIGN_SYSTEM.md.
Side Effects: Tidak ada.
-->

## Platform

web

## Users

Karyawan internal CV. Surya Perkasa, satu akun dengan izin per grup (`config/workspace-navigation.ts` › `ROLE_PROFILES`):
- **Fakturist / Admin order:** order principal dan order cabang → faktur di Accurate; antrean faktur; summary promo.
- **Kasir / Incaso / Finance:** pelunasan, kasir, transfer, pembayaran principal, SPPD.
- **Admin klaim:** Claim Workflow, OFF Program Control, rekap dan normalisasi promo.
- **SM / SPV / OM:** persetujuan OPC, dashboard tim, Supervisor Review, Laporan Sales, insentif.
- **Salesman (ponsel):** rute hari ini, kunjungan, order, insentif saya.
- **Admin sistem:** pengguna, grup izin, sesi Accurate, master barang, data principal.

Sebagian besar bekerja di desktop berjam-jam; salesman dan SPV lapangan memakai ponsel 360–400 px.

## Product Purpose

Memindahkan pekerjaan distributor multi-principal (Godrej, Kino, Reckitt, Cussons, Heinz, Priskila, Forisa, dll.) dari
WhatsApp, nota fisik, dan Excel tersebar ke alur terkontrol yang memposting ke Accurate Online. Berhasil = dokumen benar
masuk Accurate sekali (tanpa ganda), status setiap dokumen jelas, dan tidak ada kesimpulan "aman" yang salah.

## Operating Context

Accurate Online adalah data of record; AccAPI memposting faktur, pelunasan, retur, PO, dan pembayaran yang menjadi jurnal
nyata. Input berasal dari surat promo principal (PDF/OCR), file Excel principal, dan isian lapangan. Zona waktu WITA.

## Capabilities and Constraints

- Setiap tulis ke Accurate dianggap tidak bisa dibatalkan → konfirmasi eksplisit dengan jumlah, nilai, tujuan.
- Jawaban server yang tidak pasti (putus, ≥ 502) disebut tidak pasti, bukan gagal atau sukses.
- Logic bisnis tidak diubah oleh pekerjaan UI (`docs/UI_DESIGN_SYSTEM.md` › aturan 9).
- Migrasi Fiori belum tuntas: beberapa halaman masih bertema Surya lama (lihat `docs/UI_DESIGN_SYSTEM.md` › Status).

## Brand Commitments

- Logo resmi CV. Surya Perkasa (`public/brand/`), warna PWA `#004c97`.
- Bahasa tugas Indonesia; istilah Accurate dan principal dipertahankan.
- Data contoh generik: PRINCIPLE A/B, CABANG A, SALES A — bukan nama principal atau orang nyata (owner 8 Okt 2026).

## Evidence on Hand

Tidak ada testimoni, rating, atau angka pemasaran; produk internal. Angka di poster PRD (`docs/prd/00-overview.md`)
fiktif dan tidak boleh dipakai sebagai target.

## Product Principles

1. Status jujur lebih penting daripada tampilan rapi: memuat ≠ kosong ≠ galat.
2. Kepadatan informasi dipertahankan; operator membandingkan banyak baris sekaligus.
3. Satu aksi utama per layar; aksi merusak dan tulis selalu dikonfirmasi.
4. Perubahan terkecil yang koheren; tidak mendesain ulang karena selera.

## Accessibility & Inclusion

Fokus terlihat, target sentuh 44 px di layar sentuh, `prefers-reduced-motion` dihormati, status tidak bergantung pada
warna saja, kontras teks WCAG AA.
