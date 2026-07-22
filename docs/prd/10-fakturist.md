# PRD 10 — Divisi Fakturist (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.38.34.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Gerbang administrasi sebelum Gudang & Accurate: PO dari portal B2B NKA/Sub-distributor
ditarik & dibaca otomatis (**B2B Scratcher AI**: auto-download → OCR & mapping → validasi
manusia → learning dari revisi), diproses ke Accurate, nota di-print, Rekapan Gudang dibuat,
dan pendingan orderan termonitor. Mengganti login portal satu-per-satu, copy/download PO
input ulang, dan validasi SKU/promo manual.

## Aktor
- **Fakturist** — validasi hasil AI, proses ke Accurate, print nota, buat Rekapan Gudang.
- **Gudang** — konsumen Rekapan Gudang (PRD 07).

## Fitur inti
1. **B2B Scratcher AI**: login/tarik PO dari portal B2B (NKA & sub-distributor), auto-download ke folder tujuan, OCR & mapping PO → SKU internal, antrian "PO perlu revisi".
2. Validasi hasil AI oleh Fakturist; **learning dari revisi** (koreksi tersimpan dipakai lagi).
3. Proses ke Accurate (buat sales order/invoice) + print nota.
4. Buat Rekapan Gudang (digital, dikirim ke PRD 07).
5. Dashboard: PO masuk, PO berhasil AI (%), PO perlu revisi, pending orderan, nota sudah print, rekapan selesai/belum/terkirim ke gudang.

## Alur teknis (poster)
Login B2B → B2B Scratcher AI → save to folder → OCR & mapping → validasi Fakturist → proses ke Accurate → print nota → buat Rekapan Gudang → antar ke Gudang.

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| PO B2B (file) | Portal B2B eksternal per NKA — **TBD daftar portal & mekanisme akses** (scraping vs download manual ke folder terpantau) | Risiko: portal berubah, captcha, kredensial |
| Mapping SKU customer ↔ SKU internal | Tabel mapping baru + master `item` (sudah sync) | Pola persis `variant_mapping.json` + `correction_store.py` existing (summary pipeline) |
| Order → Accurate | Accurate `sales-order` / `sales-invoice` (**tulis**) | Pakai pola api-wrapper + idempotency existing |
| Hasil OCR + koreksi | Pipeline OCR existing python_backend (ocr_cache, parse, correction_store) — **reusable langsung** | Determinisme FASE 1–5 sudah dibangun utk kasus serupa |
| Rekapan Gudang | Output modul ini (tabel + PDF/print) | Kontrak dgn PRD 07 |

## Dependensi
- python_backend OCR pipeline (existing, terbukti) — perluasan domain dari surat program ke PO B2B.
- Accurate write path (proxy + idempotency existing).
- PRD 07 Gudang (konsumen rekapan).
- RBAC modul `fakturist.*`.

## Status vs sistem sekarang
Belum ada modul PO B2B. Namun **fondasi teknis paling banyak reuse**: OCR cache + LLM parse
+ koreksi manusia + golden snapshot (summary pipeline) dan jalur tulis Accurate (api-wrapper).
Gap utama: konektor portal B2B, mapping SKU per customer, antrian validasi, rekapan gudang.

## Asumsi & TBD
- A: "Learning dari revisi" = lookup koreksi deterministik (pola correction_store), BUKAN retraining model.
- TBD: daftar portal B2B & apakah auto-login diizinkan (ToS portal); alternatif aman v1: folder terpantau, user download manual.
- TBD: PO masuk Accurate sebagai sales-order dulu atau langsung invoice.
- TBD: format Rekapan Gudang yang gudang pakai sekarang (contoh dokumen belum ada).
