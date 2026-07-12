# PRD Overview — Ops Control Tower (CV. Surya Perkasa)

| Doc | Nilai |
|---|---|
| Sumber | `poster/ChatGPT Image 26 Mei 2026, 11.20.29.png` (cover/login) + 10 poster divisi |
| Status | DRAFT — Fase A (dokumen saja, tanpa perubahan kode) |
| Tanggal | 2026-07-12 |
| Catatan | Semua ANGKA di poster FIKTIF — hanya contoh bentuk KPI, bukan target/requirement |

## Visi
Satu "Ops Control Tower" terintegrasi untuk distribusi FMCG: setiap divisi punya dashboard
operasional real-time, alur kerja terkontrol (bukan WhatsApp/nota fisik/Excel tersebar),
dan manajemen melihat semuanya dalam satu layar (traffic light + daily closing).

## Peta Divisi → PRD

| # | PRD | Divisi | Inti | Overlap dgn modul existing |
|---|---|---|---|---|
| 01 | [01-audit.md](01-audit.md) | Audit | Temuan, kepatuhan SOP, follow-up lintas divisi | `off_audit_log`, `claim_audit_log` (log saja, bukan temuan) |
| 02 | [02-incaso.md](02-incaso.md) | Incaso | Nota tagihan, Form Tagihan, validasi bukti bayar, closing | `python_backend` payments/LPB, api-wrapper bulk sales receipt |
| 03 | [03-claim.md](03-claim.md) | Claim | Claim diskon/promo/retur ke principal | **Claim Workflow (sudah jalan)** + OPC |
| 04 | [04-sales.md](04-sales.md) | Sales | Mobile app: rute, check-in/out, order, bukti bayar | insentif-sales (target/achievement), laporan harian |
| 05 | [05-admin-gudang.md](05-admin-gudang.md) | Administrasi Gudang | Kontrol nota keluar/kembali, aging H+1/H+3, retur | — (belum ada) |
| 06 | [06-delivery.md](06-delivery.md) | Delivery | Status kirim, GPS, bukti kirim, nota kembali | — (belum ada) |
| 07 | [07-gudang.md](07-gudang.md) | Gudang | Rekapan, picking QR, checking, alokasi rute/mobil | — (belum ada) |
| 08 | [08-management-dashboard.md](08-management-dashboard.md) | Manajemen | Traffic light semua divisi, daily closing, alert | dashboard-generator (offline, file-based) |
| 09 | [09-control-center.md](09-control-center.md) | Sekretaris OM | Ticket issue, pending board, timer 2 jam, eskalasi OM | — (belum ada) |
| 10 | [10-fakturist.md](10-fakturist.md) | Fakturist | PO B2B Scratcher AI, OCR→Accurate, Rekapan Gudang | summary OCR pipeline (pola sama), api-wrapper |

## Rantai dokumen fisik (lintas divisi)
```
Fakturist (input PO → nota) → Gudang (rekapan, picking, siap delivery)
  → Delivery (kirim, bukti, nota kembali) → Admin Gudang (kontrol nota/aging/retur)
  → Incaso (form tagihan → Sales menagih → validasi bukti bayar → kasir)
  → Claim (diskon/promo/retur ke principal) ; Audit & Control Center memantau semua.
```
Entitas sentral: **NOTA (sales invoice)** — semua divisi memantau status nota pada
tahap berbeda. Ini argumen kuat untuk SATU tabel status-nota bersama, bukan 7 silo.

## Prinsip data (aturan proyek)
- Sumber utama = **Accurate API**. Pola default: **sync terjadwal → DB lokal**,
  BUKAN panggil live per request. (Catatan audit: `lib/sync.ts` item/customer ada sebagai
  kode tapi **belum pernah dijalankan** — dead code, tabel kosong; lihat findings K2/F3.)
- Catatan: prompt menyebut Postgres; repo saat ini SQLite/libSQL (`DATABASE_URL=file:`).
  Diperlakukan sebagai TBD infra — PRD netral terhadap engine.
- Data lapangan (check-in, foto bukti) lahir di aplikasi ini, bukan di Accurate.

## Asumsi global (berlaku semua PRD)
- A1: Angka di poster fiktif; KPI card = bentuk, bukan nilai.
- A2: "Real-time" cukup near-real-time (refresh ≤ interval sync; tidak perlu websocket kecuali disebut).
- A3: Aktor memakai auth + RBAC existing (Better Auth + permission registry `module.action`).
- A4: Mobile app Sales/Delivery = TBD platform (PWA existing sudah ada ServiceWorker+InstallPrompt → kandidat termurah).
