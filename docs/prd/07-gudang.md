# PRD 07 — Divisi Gudang (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.37.00.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Digitalisasi alur gudang: Rekapan Gudang digital dari Fakturist → picking (QR scan) →
checking terkontrol → pemisahan nota per rute & per mobil otomatis → rekapan nota → siap
delivery → tracking nota kembali (Success/Partial/Failed) → serah ke Incaso terkontrol.
Mengganti rekapan print, picking fisik, checker hafalan, dan pemisahan nota manual.

## Aktor
- **Staff Gudang** — terima rekapan, picking, checking.
- **Admin Gudang** — rekapan nota, alokasi rute/mobil, serah ke Incaso (overlap PRD 05).
- **Delivery** — konsumen "siap delivery" (PRD 06).

## Fitur inti
1. Rekapan Gudang digital (dari Fakturist, PRD 10) + status terima rekapan.
2. Picking barang dengan **QR scan**; checker terkontrol di sistem (bukan hafalan).
3. **Automation rute & mobil**: kelompokkan nota per rute → tentukan mobil → alokasi otomatis → konfirmasi.
4. Rekapan nota otomatis; status siap delivery.
5. Tracking nota kembali: Success / Partial / Failed; serah ke Incaso terkontrol.
6. Dashboard harian: rekapan masuk, sedang picking, sudah checking, dipisah per rute/mobil, rekapan selesai, siap delivery, nota belum kembali, retur masuk.

## Alur teknis (poster)
Terima rekapan → picking (QR) → checker → automation rute & mobil → rekapan nota → siap delivery → nota kembali (S/P/F) → serah ke Incaso.

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Rekapan Gudang | PRD 10 Fakturist (output rekapan) | Digital, bukan print |
| Item + barcode/QR | Accurate `item` (sudah sync) — kolom barcode **TBD** apakah terisi | QR bisa fallback ke kode item |
| Nota utk dipisah per rute | Accurate `sales-invoice` sync + master rute (baru, sama dgn PRD 04) | |
| Master mobil/armada | **TBD** — belum ada; tabel kecil internal | |
| Status picking/checking/packing | Aplikasi ini (tabel event per rekapan/nota) | |
| Retur masuk | Input gudang → dikonsumsi PRD 05/03 | |

## Dependensi
- PRD 10 Fakturist (hulu — rekapan digital). Urutan build: 10 → 07 → 06 → 05.
- Master rute + master mobil (baru).
- Perangkat scan QR: kamera HP cukup (PWA) — TBD scanner khusus.
- RBAC modul `gudang.*`.

## Status vs sistem sekarang
Belum ada sama sekali. (dashboard-generator punya dashboard *analisa* stok offline dari
export Accurate, tapi itu alat analisis file, bukan operasional gudang.)

## Asumsi & TBD
- A: "Automation rute & mobil" = rule-based (customer→rute dari master; kapasitas mobil), bukan optimasi VRP.
- TBD: aturan alokasi mobil (kapasitas? wilayah? manual pilih dgn saran sistem?).
- TBD: apakah picking per-item di-scan satu-satu atau per-nota konfirmasi.
