# PRD 02 — Divisi Incaso (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.36.27.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Incaso = penghubung Sales ↔ Kasir untuk tagihan. Nota masuk tercatat real-time, Form Tagihan
dibuat otomatis dari JKS Sales, bukti bayar dari Sales tervalidasi (nomor nota + nominal),
hasil valid diinput ke sistem/Account Receiving, Form Kasir dicetak dari sistem, closing harian
terpantau. Mengganti distribusi nota manual + cek bukti satu-per-satu.

## Aktor
- **Admin Incaso** — terima nota, buat Form Tagihan, validasi bukti bayar, input ke sistem, print Form Kasir, closing.
- **Sales** — sumber bukti bayar (lihat PRD 04).
- **Kasir** — penerima Form Kasir + setoran.

## Fitur inti
1. Dashboard nota masuk real-time (nota diterima hari ini, aging nota).
2. Form Tagihan otomatis berdasarkan **JKS Sales** (jadwal kunjungan sales) — nota mana dibawa sales mana hari ini.
3. Validasi bukti bayar: match nomor nota + nominal vs tagihan; antrian "menunggu validasi".
4. Input hasil valid ke sistem / Account Receiving (= pelunasan di Accurate, format kerja Account Receiving).
5. Print Form Kasir dari sistem; serah ke Kasir dengan status jelas; closing harian (jika klop).
6. Monitoring aging nota & follow-up collection.

## Alur teknis (poster)
Terima nota → buat Form Tagihan (JKS Sales) → bukti bayar masuk dari Sales → validasi & input ke sistem → print Form Kasir → serahkan ke Kasir → closing (jika klop).

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Nota/faktur + outstanding | Accurate `sales-invoice` (list piutang/outstanding) via **sync terjadwal** | Kunci: no nota, customer, nilai, sisa tagihan, jatuh tempo |
| Pelunasan | Accurate `sales-receipt` — **tulis** ke Accurate saat input hasil valid | Sudah ada precedent bulk sales receipt di api-wrapper + idempotency lock |
| JKS Sales (jadwal kunjungan) | **KOREKSI audit: sudah ada** — `jks_master` (356 baris, upload via form-kontrol); belum dipakai utk Form Tagihan | Prasyarat Form Tagihan otomatis |
| Bukti bayar (foto/transfer) | Upload dari app Sales → tabel baru | Data lahir di aplikasi |
| Form Tagihan / Form Kasir | Generate PDF (pdf-lib, pola existing OPC/claim) | |
| Closing harian | Tabel baru (batch closing per hari) | |

## Dependensi
- **PRD 04 Sales** (bukti bayar + JKS) — Incaso adalah konsumen utamanya.
- Sync piutang Accurate terjadwal (baru — `lib/sync.ts` baru meng-cover item/customer).
- Kasir (tidak ada poster sendiri; diasumsikan aktor pasif penerima Form Kasir — TBD apakah butuh UI).
- RBAC modul `incaso.*`.

## Status vs sistem sekarang
`python_backend` payments (upload LPB Excel, finance approval, bukti transfer) menyentuh area
pembayaran tapi berbeda objek (pembayaran vendor/LPB, bukan tagihan customer). Bulk sales
receipt manual via api-wrapper ada. Belum ada: dashboard nota, Form Tagihan otomatis,
antrian validasi, closing harian.

## Asumsi & TBD
- A: "Account Receiving" = pencatatan pelunasan ke Accurate sales-receipt.
- TBD: apakah input pelunasan langsung tulis ke Accurate atau staging dulu (rekomendasi: staging + submit batch dgn idempotency, pola existing).
- TBD: definisi "klop" untuk closing (total valid = total setor kasir?).
