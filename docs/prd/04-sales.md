# PRD 04 — Divisi Sales (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.36.39.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Aplikasi Sales mobile: rute harian termonitor, check-in/check-out wajib per outlet, input order,
apply promo, cek & tagih tagihan, upload bukti bayar + nomor nota — semua real-time ke Incaso.
Sales TIDAK melakukan pelunasan di sistem (pelunasan diproses Incaso). Mengganti nota fisik,
foto via WA, dan input manual.

## Aktor
- **Salesman** — pengguna utama mobile app.
- **SPV/SM** — monitoring achievement & rute (via dashboard existing insentif-sales).
- **Admin Incaso** — konsumen data bukti bayar (PRD 02).

## Fitur inti
1. Rute hari ini + tracking kunjungan; **check-in wajib** (waktu, lokasi, outlet) & **check-out wajib** (status: Order Ya/Tidak, Tagihan Tertagih Ya/Tidak, catatan).
2. Ambil nota dari Incaso (daftar tagihan yang dibawa hari ini) → cek tagihan → upload bukti bayar + input nomor nota.
3. Input order (item, qty, value, promo) dari outlet.
4. Dashboard achievement: target vs realisasi, call rate, effective call, outlet dikunjungi, AOV, route progress, visit compliance, order hari ini.
5. Dashboard tagihan: tagihan hari ini, bukti bayar uploaded, nota terinput, tertagih/belum, menunggu validasi Incaso, customer overdue, selisih validasi, form setoran terbentuk.

## Alur teknis (poster, 13 langkah)
Ambil nota dari Incaso → rute hari ini → check-in (wajib) → kunjungan outlet → input order → apply promo → cek tagihan hari ini → upload bukti bayar → input nomor nota → check-out (wajib) → isi status → Incaso validasi & pelunasan → akumulasi tagihan → form setoran ke kasir.

## Data yang dicatat (poster)
Kunjungan (check-in/out), order (item/qty/value/promo), bukti bayar, nomor nota, status order, status tagihan, rute & lokasi, catatan salesman.

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Master outlet/customer | Accurate `customer` via `lib/sync.ts` — **KOREKSI audit: sync belum pernah jalan** (dead code, tabel 0 baris; lihat findings K2/F3) | Prasyarat: hidupkan F3 |
| Master item + harga/promo | Accurate `item` via sync (prasyarat F3 juga); promo/diskon: master promo internal (summary program existing menghasilkan Dataset Diskon) | TBD: bentuk master promo yg bisa di-apply |
| Tagihan per outlet | Sync piutang `sales-invoice` (sama dgn PRD 02) | |
| Order hasil input | Tabel baru → opsional push ke Accurate `sales-order` | TBD apakah order masuk Accurate atau hanya internal |
| Check-in/out + GPS | Aplikasi ini (tabel baru) | Data lahir di lapangan |
| Target & achievement | **Existing**: `sales_targets` + insentif-sales dashboard | Realisasi existing dihitung dari data penjualan |
| Rute/JKS | **KOREKSI audit: sudah ada** — `jks_master` (356 baris) + upload Excel di `app/api/form-kontrol/jks` | Prasyarat PRD 02 (Form Tagihan otomatis) |

## Dependensi
- PRD 02 Incaso (konsumen bukti bayar; sumber daftar nota dibawa).
- Master rute/JKS (baru).
- Mobile: kandidat PWA (ServiceWorker + InstallPrompt sudah ada di repo) — hemat vs native. GPS via browser API. TBD offline-mode.
- RBAC modul `sales_app.*` (scoping per salesman — perlu link user.id ↔ salesCode; gap yang sama dgn hierarki insentif).

## Status vs sistem sekarang (dikoreksi audit — findings K1)
Insentif-sales (target, achievement 4-KPI, insentif GT, SPV dashboard) & laporan harian
sudah meng-cover sisi *pelaporan*. **Check-in/out + GPS + foto, visit, dan JKS SUDAH setengah
jadi** di modul `form-kontrol` (`app/api/form-kontrol/checkin|checkout|visit|jks`; data hidup:
`ao_control_daily` 1.216 baris). Yang benar-benar belum ada: input order lapangan, upload
bukti bayar, integrasi ke Incaso, offline queue. Rekomendasi: **extend form-kontrol** (D8).

## Asumsi & TBD
- A: "Real-time ke Incaso" = tersimpan langsung ke DB pusat saat online.
- TBD: perilaku offline (sinyal buruk di lapangan) — antri lokal?
- TBD: apakah "apply promo" menghitung harga final atau hanya menandai promo yang dipakai.
- TBD: sumber "customer overdue" (umur piutang — bisa dari sync piutang).
