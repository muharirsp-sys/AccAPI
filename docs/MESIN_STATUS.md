<!--
Tujuan: Daftar semua mesin status (state machine) di AccAPI: di mana statusnya disimpan, nilainya, dan
        berkas mana yang memegang aturannya. Dibaca manusia dan agen SEBELUM menyentuh kolom status apa pun.
Caller: Developer, reviewer, agen (AGENTS.md "Mesin status").
Dependensi: db/schema.ts, lib/**, python_backend/**. Sapuan kode 16 Nov 2026 pada main b841ced8.
Side Effects: Dokumentasi saja.
-->
# Mesin status AccAPI

## Aturannya (satu, untuk semua)

1. **Satu berkas pure per mesin.** Nilai status (union/`as const`), siapa boleh pindah ke mana, dan ambang waktunya
   tinggal di satu modul tanpa DB — contoh rumah: `lib/rekapan-nota/wave-state.ts`.
2. **Server dan layar mengimpor dari berkas itu.** Route tidak menulis `if (status !== "...")` sendiri; komponen tidak
   menyalin daftar status atau syarat tombol.
3. **Kolomnya bertipe.** `text("status").$type<Union>()` di `db/schema.ts` (hanya tipe, tanpa migrasi) supaya literal
   salah ketik gagal di `tsc`. CHECK di database menyusul lewat migrasi biasa bila nilainya sudah bersih.
4. **Tulisnya atomik.** `UPDATE ... WHERE status = <asal>` atau baris terkunci; bukan baca-lalu-tulis.
5. **Satu tes.** Perilaku yang dikunci ada di `lib/mesin-status.test.ts` atau tes modulnya.

Tanpa pustaka baru: pola ini sudah dipakai wave, kasir, dan percobaan tulis Accurate.

## Daftar

Kolom **Aturan**: `satu` = sudah satu sumber · `sebagian` = ada fungsi pure tapi masih ada penulis/salinan di luar ·
`tersebar` = literal dan `if` per route/komponen.

### Tulis ke Accurate, sinkron, anti-ganda

| Mesin | Disimpan di | Nilai | Aturan | Berkas aturan / catatan |
|---|---|---|---|---|
| Percobaan pembayaran pembelian | `accurate_write_attempt.state` | sending, posted, rejected, unknown, not_sent, resolved_absent | satu | `lib/accurate-write-attempt.ts` + CHECK + trigger (`DDL_ADR004.sql`). `rejected` tidak pernah dihasilkan kode. |
| Antrean faktur | `invoice_outbox.state` | queued, sending, posted, unknown, rejected | satu (sejak PR ini) | `lib/accurate-invoice-write.ts`: `OUTBOX_STATES`, `sendable/resendable/discardable`, `DISCARDABLE_STATES`, `SAPU_SETELAH_MENIT`. Belum ada CHECK. Label layar masih 4 peta (sengaja beda sudut pandang; belum disatukan). |
| Kunci pelunasan | `idempotency_log.status` | PROCESSING, SENDING, SUCCESS, FAILED, UNKNOWN | sebagian | `lib/idempotency-lock.ts`, `lib/idempotency-resolve.ts`. Teks bebas, literal di ±6 berkas. |
| Izin timpa sekali pakai | `idempotency_override.consumed_at` | null → waktu | satu | `lib/sales-receipt-guard.ts` (FOR UPDATE SKIP LOCKED). |
| Sinkron master | `sync_state.status` | idle, syncing, error (+ `running` dari sinkron harga) | tersebar | `lib/sync.ts`, `lib/item-price-sync.ts`. Tidak ada yang membaca kolom ini. |
| Sesi Accurate | `accurate_oauth_session` (kolom nullable) | tanpa token → token → sesi di DB X → dihapus | tersebar | `lib/accurate-session.ts`. |
| Rekonsiliasi | `reconciliation_run.status` | processing, success, failed | satu | `lib/off-program-control/reconciliation-store.ts` + CHECK. Run macet `processing` tidak disapu. |

### Klaim dan Off-Program Control

| Mesin | Disimpan di | Nilai | Aturan | Berkas aturan / catatan |
|---|---|---|---|---|
| Pengajuan OPC | `off_batch.status` + `sm_status`, `claim_status`, `om_status`, `finance_status`, `final_status`, `locked` | lihat `lib/off-program-control/constants.ts` | sebagian | Gerbang server di `lib/off-program-control/workflow.ts` (`canSubmitBatch`, `canReviewSm`, `canReviewClaim`, `canDecideOm`, `canProcessFinancePayment`, `canOpenFinalClaim`). Tulisnya masih baca-lalu-tulis per route. Antrean Klaim di layar memakai `canReviewClaim` yang sama; predikat SM/OM di `lib/opc-ui.ts` masih salinan. |
| Refund OPC | `off_refund.status`, `off_batch.refund_status` | Pending → Verified / Rejected | tersebar | `app/api/off-program-control/**/refund/route.ts`. |
| Tutup periode | `off_period_closure.status` | Terbuka, Ditutup | tersebar | `app/api/off-program-control/periods/route.ts`. |
| Claim Workflow | `claim_workflow.status` | Draft, Need Revision, Ready to Submit, Submitted to Principal, Partially Paid, Paid, Outstanding, Closed, Cancelled | sebagian | Transisi manual: `claimWorkflowTransitions` di `lib/claim-workflow/constants.ts`. Status bayar: `lib/claim-workflow/submissions.ts`. Closed: route close. Need Revision/Outstanding/Cancelled tidak punya penulis. |
| Submission klaim | `claim_submission.status` | sama dengan Claim Workflow | sebagian | `lib/claim-workflow/submissions.ts`. |
| Permintaan klaim SPV | `spv_sales_claim_request.status` | pending, approved, rejected | tersebar | `app/api/insentif-sales/**/requests/route.ts`. |

### Lapangan (Form Kontrol)

| Mesin | Disimpan di | Nilai | Aturan | Berkas aturan / catatan |
|---|---|---|---|---|
| Kunjungan toko | `ao_control_daily.status` + `checkin_at`, `order_dicatat_pada`, baris merchandising, `checkout_at` | not_visited, ordered, not_order, priority (`active` tak pernah ditulis) | tersebar | `lib/form-kontrol/db.ts`. Fase kunjungan tidak disimpan; diturunkan ulang di ±6 tempat. Server menolak check-out tanpa check-in (BL-28); langkah lain masih dijaga layar. |
| Wizard kunjungan | `Kunjungan.tsx` (`maks`, `lihat`) | langkah 0–5 | sebagian | `visit/[custCode]/langkah.tsx` + turunan di `Kunjungan.tsx`. |
| NOO | `noo_toko.status` | menunggu_spv, disetujui, ditolak, terdaftar | satu | `lib/form-kontrol/noo.ts` (`hakNoo`) + CHECK. |
| Pengajuan lokasi | `pengajuan_lokasi.status` | menunggu, disetujui, ditolak | sebagian | `lib/form-kontrol/lokasi-db.ts` + CHECK. |
| Titik toko | `toko_koordinat.status` | fix, validasi | tersebar | 4 penulis, yang terakhir menang. |
| Kunjungan luar rute | `kunjungan_luar_rute.konfirmasi` | menunggu, jks, tidak (+ batal) | sebagian | `lib/form-kontrol/luar-rute.ts` + CHECK. |
| Laporan harian salesman | `salesman_daily_report.submitted_at`, `spv_ack` | belum → terkirim → diketahui SPV | tersebar | `lib/form-kontrol/db.ts`. |

### Order, faktur, kasir, insentif

| Mesin | Disimpan di | Nilai | Aturan | Berkas aturan / catatan |
|---|---|---|---|---|
| Wave rekapan | `wave.status` (pgEnum) | draft, released, confirmed, cancelled | satu | `lib/rekapan-nota/wave-state.ts`. |
| Exception wave | `wave_exception.status` (pgEnum) | open, diabaikan, selesai | tersebar | 2 route; buka-ulang lewat unggah. |
| Hari kasir | `kasir_hari_event.jenis` | tutup, kunci, buka | satu | `lib/kasir/rekonsiliasi.ts` (`statusHari`). |
| Baca pelunasan kasir | `kasir_pelunasan_baca.status` | berjalan, lengkap, sebagian, gagal | satu | `lib/kasir/baca-pelunasan.ts` + CHECK + lease 2 menit. |
| Run Laporan Harian | `report_run.status` (+ jam klaim di `note`) | dry_run, sending, sent, failed | satu | `lib/laporan-harian/send-state.ts` (`canClaimReportRun`, `runMacet`, `catatSendingAt`). Run macet > 10 menit bisa diklaim ulang. |
| Penerima Laporan Harian | `report_run_recipient.send_status` | pending, sent, failed, skipped | sebagian | idem. |
| Pembayaran insentif | `incentive_payments.payment_status` | belum, lunas, tunggakan | sebagian | Daftar sah `STATUS_BAYAR_INSENTIF` + `tolakMundurLunas` di `lib/insentif-payment-date.ts`: lunas tidak mundur. |
| Batch order principal | `principal_order_batch.status`, `principal_order_line.status` | parsed/review/validated; pending/ok/review | tersebar | Status batch tidak dibaca siapa pun (gerbang memakai `validatedAt`). |
| Master Barang | `master_barang.status` + `confirmation_state` | blocked_similarity, draft, review, ready | satu | `lib/master-barang/status.ts` (`MasterStatus`, `tolakNamaMirip` — gerbang upload, simpan kamus, finalisasi). Penulis: `lib/master-barang/service.ts`. |

### FastAPI (`python_backend/`)

| Mesin | Disimpan di | Nilai | Aturan | Berkas aturan / catatan |
|---|---|---|---|---|
| Status transfer pembayaran | `payments.json` → `status_pembayaran` | "", Belum Transfer, Sudah Transfer, Ajukan Ulang | tersebar | `routers/payments.py`, `routers/finance.py`, `shared.py`; disalin di `lib/payments-ui.ts`, `lib/finance-ui.ts`. |
| Status posting di buku | `payments.json` → `accurate_post_status` | "", posted, failed, skipped, unknown | sebagian | `routers/finance.py`, `shared.py` (`effective_post_status`). Diselaraskan dengan `accurate_write_attempt` hanya oleh peramban. |
| Draf summary promo | `summary_draft.status` | draft, published, withdrawn | sebagian | `summary_library.py`, `summary_store.py`, `summary_review_publish.py`. |
| Order Web Sales | `order_request.status` | pending, pulled, rejected | sebagian | `websales_store.py`. |
| Sambungan Web Sales | `summary_kv` "websales_connection" | on/off | tersebar | `routers/orders.py`. |
| Job latar | `BACKGROUND_JOBS` (memori) | processing, done, error | kode mati | `shared.py`; tidak ada pemanggil. |

### Alur di layar (klien)

Sudah satu variabel status/dialog: Kasir, Finance, Rekapan Nota, Pelunasan (Tinjau/Kirim), `ConfirmDialog`, `useLoad`.
Masih beberapa `useState` terpisah untuk satu alur: `api-wrapper/page.tsx` (Konsol Accurate),
`principal-order/LangkahBatch.tsx`, `summary/Summary.tsx`, `summary/settings/page.tsx`, `payments/Rekaman.tsx`,
`orders/OrderBaru.tsx`, `form-kontrol/tabs/NooFormulir.tsx`.

## Perbaikan perilaku 17 Nov 2026 (disetujui owner)

Delapan celah dari sapuan ini ditutup atas perintah owner. Yang berubah untuk pengguna:

1. **OPC — Klaim hanya meninjau pengajuan yang belum diputuskannya (BL-06).** Dulu `canReviewClaim` hanya memeriksa
   `sm_status`, jadi Klaim bisa mengembalikan atau menyetujui ulang pengajuan yang sudah disetujui OM atau dibayar;
   submit ulang lalu mengosongkan `finance_status` padahal pembayarannya masih ada. Kini server memakai aturan yang
   sama dengan antrean layar (`PREDIKAT.klaimAntrean` memanggil `canReviewClaim`); layar tidak berubah.
2. **Finance — rekaman yang belum pernah diajukan tidak bisa diubah status transfernya.**
   `python_backend/routers/finance.py` `never_submitted`: jalur `no_lpb` menjawab 409, jalur `principle` melewatinya.
   Rekaman lama tanpa `submission_id` tetapi sudah berstatus atau berjam ajuan tetap diproses.
3. **Form Kontrol — check-out ditolak bila toko belum check-in (BL-28).** `saveCheckout` hanya memperbarui baris yang
   `checkin_at`-nya terisi; selain itu 409 `BELUM_CHECKIN` dan pengajuan lokasi tidak ditulis.
4. **Laporan Harian — run macet bisa dikirim ulang (BL-29).** Jam klaim dicatat di `report_run.note`
   (`sending_at:<ISO>`, tanpa migrasi). Run "Mengirim" lebih dari 10 menit sejak klaim = macet: tombol "Kirim ulang…"
   muncul, penerima yang sudah `sent` dilewati, dan dua klaim serentak dibedakan lewat note. Label "Macet" kini
   dihitung dari jam klaim, bukan jam unggah. Akibat yang diterima: satu berkas yang sedang dikirim saat proses mati
   bisa terkirim dua kali.
5. **Insentif — baris lunas tidak bisa dikembalikan ke belum/tunggakan lewat POST/PATCH** (`tolakMundurLunas`, 409).
   Tidak ada layar yang mengirimnya; yang tertutup adalah panggilan API langsung.
6. **Master Barang — simpan Kamus Kode pada master "Nama mirip" ditolak** sampai 3 konfirmasi selesai
   (`lib/master-barang/status.ts` `tolakNamaMirip`: upload, kamus, finalisasi). Tombolnya masih aktif di layar; pesan
   penolakan tampil di dialog. Master yang SUDAH lolos lewat celah ini sebelum perbaikan tidak disentuh — cari dengan
   `status <> 'blocked_similarity' AND (confirmation_state->'similarity'->>'complete') = 'false'`.
7. **Konsol Accurate — halaman terkunci selagi berkas dibaca, dan yang dikirim = yang dikonfirmasi.** Selama membaca:
   Kirim, pilihan endpoint, dan unggah nonaktif. Dialog konfirmasi menyimpan isi dan endpoint; bila salah satunya
   berubah sebelum dikonfirmasi, tidak ada yang dikirim.
8. **Ringkasan `GET /api/form-kontrol/ao-control` tanpa salesman** tidak lagi menghitung "belum dikunjungi" dua kali.

Belum terbukti dengan dijalankan (tidak ada Postgres lokal, tidak diuji di peramban): gerbang server butir 1, 3, 4, 5
dan layar butir 4, 7 dibuktikan lewat baca kode, tsc, dan tes fungsi pure (`lib/mesin-status.test.ts`); butir 2
lewat `python_backend/test_finance_bl49.py`.

Sisa yang diketahui: `Kunjungan.tsx` masih memuat catatan varian BL-28 lama; check-in ulang sesudah check-out masih
menimpa `checkin_at`; layar OPC lain (`smAntrean`, `omAntrean`) masih punya predikat sendiri yang lebih ketat dari server.
