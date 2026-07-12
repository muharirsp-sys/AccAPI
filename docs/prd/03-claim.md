# PRD 03 — Divisi Claim (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.36.33.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Satu sistem untuk SEMUA claim ke principal — diskon, biaya promo, dan **retur** — dengan
dokumen terpusat, deadline terpantau, tracking approval principal/CN, dan status real-time.
Mengganti claim via WA/email/file manual + form berbeda per principal.

## Aktor
- **Admin Claim** — input claim, upload dokumen, validasi internal, submit ke principal, follow-up CN, closing.
- **Principal** — pihak eksternal (approval + CN); tidak login (TBD).
- **Manajemen** — monitoring deadline & rekap per principal.

## Fitur inti
1. Claim 3 jenis dalam satu sistem: **diskon**, **biaya promo**, **retur**.
2. Upload dokumen program & bukti claim per claim.
3. Monitoring deadline claim (alert ≤ 7 hari), reminder follow-up otomatis.
4. Tracking approval principal / CN number / settlement status.
5. Dashboard: claim masuk, per jenis, dokumen belum lengkap, sudah submit, CN belum diterima, deadline dekat, closed; rekap per principal.

## Alur teknis (poster)
Data claim masuk → pilih jenis (diskon/promo/retur) → upload dokumen → validasi internal → submit ke principal → follow-up approval/CN → closing claim.

## Data yang dicatat (poster §7)
Principal, jenis claim, nilai claim (Rp), dokumen pendukung, deadline claim, status approval, CN number, settlement status.

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Claim diskon/promo | **Existing**: `claim_workflow` (+items/payments/submissions), OPC `off_batch` | Sudah jalan end-to-end utk klaim dari OPC |
| Claim retur | **GAP** — belum ada; Accurate `sales-return` via sync terjadwal sebagai sumber data retur | Perlu jenis claim baru |
| CN number / settlement | Existing `claim_payment` (pembayaran principal) — CN field TBD | Cek apakah kolom CN sudah ada |
| Deadline + reminder | Existing? `holidays.ts` dipakai OPC utk deadline; reminder otomatis belum ada | |
| Dokumen per claim | Existing `claim_submission` + document-paths | |

## Dependensi
- OPC (sumber claim diskon/promo) — sudah terhubung (`from-off-batch`).
- Retur: data dari Gudang/Admin Gudang (PRD 05/07) + Accurate `sales-return`.
- Email/reminder terjadwal (cron) — belum ada scheduler di repo.

## Status vs sistem sekarang — **modul paling matang**
Claim Workflow existing sudah meng-cover: dashboard list, detail, items, payments, surat klaim
PDF, kwitansi, laporan outstanding/paid, multi-submission (R7), audit log, gate OPC-paid.
**Gap vs poster:** (1) claim retur sebagai jenis; (2) reminder/alert deadline otomatis;
(3) rekap per principal satu layar; (4) upload dokumen program (bukan hanya dokumen klaim).

## Asumsi & TBD
- A: "Claim closed" = status Closed existing.
- TBD: apakah claim retur ikut skema claim_workflow existing (kolom jenis) atau tabel sendiri.
- TBD: CN number — field existing atau kolom baru.
