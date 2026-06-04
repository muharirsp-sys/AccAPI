# Demo Data Lokal — OFF Program Control & Claim Workflow

Dokumen ini menjelaskan seed data demo lokal untuk menguji UI dashboard
OFF Program Control dan Claim Workflow tanpa perlu menjalankan flow approval
dari awal.

> **Local-only.** Seed script HANYA boleh dijalankan terhadap database
> SQLite lokal (`file:sqlite.db`). Jangan jalankan terhadap database
> produksi/staging.

---

## Tujuan

- Mengisi seluruh stage OFF (Draft → Submitted to SM → Approved by SM →
  Returned by SM/Claim → Claim Approved → Cancelled by OM → OM Approved →
  Partial Paid → Paid → Completed) dengan batch contoh.
- Mengisi seluruh status Claim Workflow production yang sudah didefinisikan
  di `lib/claim-workflow/constants.ts`: `Draft`, `Need Revision`,
  `Ready to Submit`, `Submitted to Principal`, `Partially Paid`, `Paid`,
  `Outstanding`, `Closed` (plus `Cancelled`).
- Membuat tiga dokumen klaim aktual (Claim Letter, Claim Summary, Kwitansi
  Claim) di `runtime/claim-workflow/{letters,summaries,receipts}/` untuk
  Claim Workflow yang sudah `Ready to Submit` atau lebih lanjut.

---

## Cara Menjalankan

```powershell
node scripts/seed-demo-workflows.mjs
# atau
npm run seed:demo
```

Script akan:

1. Memverifikasi `DATABASE_URL` adalah SQLite lokal. Kalau bukan, abort
   dengan exit code 2.
2. Membersihkan demo lama berdasarkan prefix (idempotent — bisa
   di-rerun berapa kali pun). Termasuk pembersihan baris legacy
   `claim_peka_report` (kalau tabel tersebut masih ada di DB lokal lama).
3. Insert OFF batches per status.
4. Insert Claim Workflow records.
5. Generate Claim Letter / Summary / Receipt PDF demo (kalau `pdf-lib` tersedia).

---

## Demo Prefix

Semua data demo memakai prefix yang jelas supaya mudah dibedakan dari
data nyata:

| Prefix          | Dipakai di                                                         |
|-----------------|--------------------------------------------------------------------|
| `DEMO-OFF-`     | `off_batch.no_pengajuan`                                           |
| `DEMO-CLAIM-`   | `claim_workflow.claim_workflow_no` dan `claim_workflow_item.no_surat` |
| `DEMO-NOCLAIM-` | `claim_workflow.no_claim`                                          |
| `DEMO-PAYMENT-` | catatan di `claim_payment.payment_note`                            |

---

## Status yang Dicover

### OFF Program Control

`Draft`, `Submitted to SM`, `Returned by SM`, `Approved by SM`,
`Returned by Claim`, `Claim Approved`, `Cancelled by OM`, `OM Approved`,
`Partial Paid`, `Paid`, `Completed`.

### Claim Workflow (production setelah cleanup PEKA)

`Draft`, `Need Revision`, `Ready to Submit`, `Submitted to Principal`,
`Partially Paid`, `Paid`, `Outstanding`, `Closed`.

> Status di luar `lib/claim-workflow/constants.ts` di-skip dengan log
> warning. Workflow lama yang sempat punya `Waiting PEKA`, `EC Received`,
> dan `CN Received` sudah retired dan tidak lagi diseed.
> Row legacy tersebut hanya kompatibilitas tampilan dan tidak termasuk
> laporan atau Monitor Outstanding production.

---

## Verifikasi UI

Setelah seed selesai:

1. Buka `/off-program-control` — daftar batch demo per status muncul.
2. Buka `/claim-workflow` — daftar Claim Workflow demo per status muncul.
   - Card metric `Outstanding` menampilkan jumlah workflow yang masih
     punya `remainingAmount > 0` (akurat dari endpoint
     `/api/claim-workflow/outstanding`).
   - Section `Monitor Outstanding` di atas daftar utama menampilkan
     ringkasan dan tabel workflow yang belum lunas.
   - Tab `All` / `Outstanding` / `Paid / Closed` di tabel utama dapat
     dipakai filter cepat.
3. Klik salah satu Claim Workflow → buka detail page. Pastikan:
   - Card **Claim Letter**, **Claim Summary**, dan **Kwitansi Claim**
     menunjukkan status `Generated` untuk demo `Ready to Submit` ke atas.
   - Tombol `Open PDF` membuka file di
     `runtime/claim-workflow/{letters,summaries,receipts}/`.
   - Section **Pembayaran Principal / Paid** menampilkan summary cards
     (Total Claim, Total Paid, Remaining, Payment Status) dan tabel
     payment. Demo `Partially Paid` / `Paid` / `Closed` punya minimal 1
     row payment active.
   - Section **Close Workflow** muncul pada workflow dalam domain
     payment/closure (`Partially Paid`, `Paid`, `Closed`, atau Submitted
     yang sudah punya payment). Demo `Paid` menampilkan checklist penuh
     "OK" dan tombol Close enabled (R4).
   - Demo `Closed` menampilkan banner emerald berisi `closed_at` dan
     close note.
   - Audit log berisi event `claim_letter_generated`,
     `claim_summary_generated`, `claim_receipt_generated`. Demo
     `Partially Paid` / `Paid` / `Closed` juga punya event
     `payment_created` (via path lain di route lokal — di seed pakai
     prefix `demo_payment_seeded`). Demo `Closed` punya event
     `closed_seeded` sebagai fallback audit (production menulis
     `claim_closed` lewat endpoint dedicated).

---

## Catatan Penting

- Seed **tidak** menulis kolom legacy `ec_peka` / `cn_number` /
  `nomor_ec_internal`. Workflow PEKA/EC/CN sudah retired (lihat
  `docs/CLAIM_WORKFLOW_AI_CONTEXT.md` bagian "Cleanup PEKA").
- Seed **tidak** mengubah API/UI route. Hanya mengisi data tabel.
- Audit log demo ditandai dengan metadata `{"demo": true}` sehingga
  mudah disaring saat audit reporting nanti.
- File PDF di `runtime/claim-workflow/...` mengandung label "DEMO"
  yang jelas dan keterangan bahwa ini bukan dokumen klaim sebenarnya.
- `runtime/` sudah di-`.gitignore`, jadi PDF demo tidak akan ikut commit.
- `sqlite.db` juga di-`.gitignore`. Jangan commit `sqlite.db` atau
  `webhook_events.log*`.

## Re-run / Cleanup

Karena seed idempotent, jalankan ulang `npm run seed:demo` kapan pun
untuk reset demo data ke kondisi awal. Untuk hapus semua data
transaksional (termasuk data nyata, hati-hati), pakai
`node scripts/reset-data.mjs`.

## Peringatan

- Jangan jalankan terhadap database produksi. Script akan refuse jika
  `DATABASE_URL` mengarah ke `/app/...` (path container produksi
  default).
- Jangan commit `sqlite.db`, `runtime/`, `webhook_events.log*`, atau
  PDF demo ke repo. `.gitignore` sudah mencakup semua ini.
