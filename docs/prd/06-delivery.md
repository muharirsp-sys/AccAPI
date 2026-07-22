# PRD 06 — Divisi Delivery (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.36.54.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Status pengiriman real-time dari lapangan: on-route → tiba → delivered/failed/partial-return,
bukti kirim terpusat (foto), nota keluar & kembali ter-track otomatis, reason code gagal kirim,
dan aging nota terlihat. Mengganti laporan manual & bukti kirim tersebar.

## Aktor
- **Driver/Delivery** — mobile app: update status, upload bukti, GPS timestamp.
- **Gudang / Admin Gudang** — hulu (terima barang+nota) & hilir (nota kembali).
- **Manajemen** — dashboard harian.

## Fitur inti
1. Mobile delivery status per pengiriman: On Route → Tiba di Outlet → Delivered / Failed / Partial Return, dengan **reason code** gagal kirim.
2. Route & GPS timestamp per perubahan status; upload **bukti kirim** (foto).
3. Tracking nota keluar & nota kembali ke gudang (link ke PRD 05/07).
4. Dashboard harian: nota keluar, delivered %, failed, partial return, bukti masuk %, nota kembali, **nota H+1**, **nota H+3**.

## Alur teknis (poster)
Terima barang + nota → On Route → Tiba di outlet → Delivered/Failed/Partial Return → upload bukti → nota kembali ke gudang.

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Daftar pengiriman (DO per rute/mobil) | PRD 07 Gudang (alokasi rute & mobil) + Accurate `delivery-order`/`sales-invoice` sync | TBD: perusahaan pakai DO Accurate atau langsung invoice |
| Status + GPS + waktu | Aplikasi ini (tabel event delivery) | Data lahir di lapangan |
| Bukti kirim (foto) | Upload app → storage `runtime/` pola existing | |
| Reason code | Master kecil internal (enum) | |
| Nota kembali | Status di tabel status-nota bersama | Dikonsumsi PRD 05 |

## Dependensi
- PRD 07 Gudang (sumber muatan per mobil/rute).
- PRD 05 Admin Gudang (konsumen status nota).
- Mobile: kandidat PWA sama dgn PRD 04; GPS via browser.
- RBAC modul `delivery.*` (scoping per driver — link user ↔ driver).

## Status vs sistem sekarang
Belum ada sama sekali.

## Asumsi & TBD
- A: GPS cukup snapshot koordinat saat aksi (bukan live tracking kontinu armada — poster cover menampilkan live map, ditandai nice-to-have).
- TBD: daftar reason code gagal kirim.
- TBD: partial return — apakah memicu draft retur di Accurate (`sales-return`) atau hanya catatan internal utk Admin Gudang.
