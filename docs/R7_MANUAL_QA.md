# Phase R7 Manual QA Checklist

End-to-end manual QA untuk Claim Workflow R7 (Multi No Claim + Direct
Source). Hasil pengembangan semua R7a–R7f dengan pengecualian R7f apply
yang HOLD sampai operator approve. Run integration test sebagai
prerequisite sebelum manual QA.

## Prerequisite

```
npm.cmd exec tsc -- --noEmit --pretty false
node --check scripts/init-db.mjs
node --check scripts/migrate-r7a-default-submission.mjs
node --check scripts/migrate-r7f-nullable-off-batch.mjs
node --check scripts/test-r7c-documents.mjs
node --check scripts/test-r7d-submission-payments.mjs
node --check scripts/test-r7e-close-reports.mjs
node --check scripts/test-r7f-direct-source.mjs
node --check scripts/test-r7g-excel-no-claim.mjs
node --check scripts/test-r7h-excel-input-mode.mjs
node scripts/test-r7c-documents.mjs        # 88 PASS
node scripts/test-r7d-submission-payments.mjs # 41 PASS
node scripts/test-r7e-close-reports.mjs    # 36 PASS
node scripts/test-r7f-direct-source.mjs    # 7 PASS, 9 SKIP (HOLD)
node scripts/test-r7g-excel-no-claim.mjs   # 36 PASS
node scripts/test-r7h-excel-input-mode.mjs # 29 PASS
```

Semua harus exit 0.

---

## Section A — R7b Submission CRUD + Item Assignment

| # | Step | Expected |
|---|------|----------|
| A1 | Buat Claim Workflow dari OFF batch (`omStatus = "Approved"`) | Workflow created dengan 1 default submission (backfill atau create-from-OFF) |
| A2 | POST `/api/claim-workflow/[id]/submissions` dengan `scope=per_program`, `scopeLabel="Program A"`, `noClaim="CLM-001"` (admin/claim, status Draft) | 201, submission baru |
| A3 | POST submission tambahan ke workflow yang sama (admin/claim) | OK |
| A4 | POST `/api/claim-workflow/[id]/submissions/[subId]/items` dengan `itemIds=[itemA]` | Item A pindah ke submission baru, totals submission lama + baru di-recalc |
| A5 | PATCH `/api/claim-workflow/[id]/submissions/[subId]` ubah noClaim | OK; sync ke off_batch_item yang assigned ke submission ini |
| A6 | PATCH legacy `/[id]/no-claim` saat workflow multi-submission | 409 `MULTI_SUBMISSION_NO_CLAIM_ROUTE_DISABLED` |
| A7 | Staff (read-only) akses GET submissions | 200 |
| A8 | Staff POST submission | 403 |

---

## Section B — R7c Documents per Submission

| # | Step | Expected |
|---|------|----------|
| B1 | POST `/[id]/submissions/[subA]/claim-letter` dengan items yang assigned ke A | 201, file di `runtime/claim-workflow/{wfId}/submissions/{subA}/letter/...pdf`. Items hanya milik subA. |
| B2 | POST sama untuk `summary` dan `receipt` | 201 untuk masing-masing tipe |
| B3 | POST `/[id]/submissions/[subB]/claim-letter` | 201, file di submission B folder, items hanya milik subB |
| B4 | GET `/[id]/submissions/[subA]/claim-letter` | Stream PDF subA |
| B5 | GET legacy `/[id]/claim-letter` saat workflow multi-submission | 409 `MULTI_SUBMISSION_LETTER_ROUTE_DISABLED` (POST). GET path validation tetap berlaku jika cache workflow ada. |
| B6 | POST status `return_to_draft` | Cache workflow + semua kolom path PDF di setiap submission di-reset ke NULL; file di disk best-effort di-unlink |
| B7 | Workflow single-submission: POST legacy `/[id]/claim-letter` | OK, file di legacy dir + mirror ke submission tunggal |

---

## Section C — R7d Payment per Submission

| # | Step | Expected |
|---|------|----------|
| C1 | Submission A status Submitted to Principal, totalClaim 500k. POST `/[id]/submissions/[subA]/payments` 200k | 201, A.totalPaid=200k, A.remaining=300k, A.status `Partially Paid`, workflow aggregate `Partially Paid` |
| C2 | Submission B totalClaim 700k. POST submission B payment 700k | B.status `Paid`, B.remaining=0, A masih Partially Paid, workflow aggregate `Partially Paid` |
| C3 | POST submission A 300k (sisa) | A `Paid`, workflow aggregate `Paid` |
| C4 | POST submission A 1 (overpay) | 409 `CLAIM_PAYMENT_OVERPAYMENT` |
| C5 | POST `/[id]/submissions/[subB]/payments/[paymentId]/void` dengan reason | B revert ke Submitted to Principal, workflow aggregate `Partially Paid` (or Submitted) |
| C6 | POST legacy `/[id]/payments` saat multi | 409 `MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED` |
| C7 | POST legacy `/[id]/payments` di workflow single-submission | 201, payment ter-link ke submission tunggal |
| C8 | GET `/api/claim-workflow/outstanding` | Returns 1 row per submission yang remainingAmount > 0. Submission Paid/Closed excluded. |

---

## Section D — R7e Close per Submission + Workflow Aggregate

| # | Step | Expected |
|---|------|----------|
| D1 | Submission A Paid + 3 PDF + 1 active payment, POST `/[id]/submissions/[subA]/close` dengan note | A `Closed`, workflow aggregate masih bukan Closed (B belum Closed) |
| D2 | Submission B belum Paid → POST `/[id]/submissions/[subB]/close` | 409 `CLAIM_CLOSE_NOT_PAID` |
| D3 | Pay B full + B punya 3 PDF, POST close B | B `Closed`, workflow aggregate `Closed`, workflow status mirror `Closed`, workflow.closed_at terisi |
| D4 | POST legacy `/[id]/close` saat multi-submission | 409 `MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED` |
| D5 | Workflow single-submission: POST legacy close | OK, mirror cache workflow + status submission Closed |
| D6 | GET `/api/claim-workflow/reports/summary` | 1 row per submission, kolom `submissionId`, `noClaim`, `scope`, `submissionStatus`, `workflowAggregateStatus` |
| D7 | GET `/api/claim-workflow/reports/paid` | 1 row per payment dengan `submissionId`, `noClaim`, `scope`, `scopeLabel` |
| D8 | GET `/api/claim-workflow/reports/outstanding` | Submission rows dengan remainingAmount > 0; Closed/Paid excluded |
| D9 | Export CSV ketiga report | UTF-8 BOM, escape comma/quote/newline, Content-Disposition filename `claim-<name>-report-YYYYMMDD.csv` |

---

## Section E — R7f Direct/Manual Source (HOLD)

R7f saat ini berstatus **HOLD**. Schema masih `off_batch_id NOT NULL`.
Migration script tersedia tapi belum di-apply. Direct create route belum
di-implement untuk mencegah half-implementation.

| # | Step | Expected |
|---|------|----------|
| E1 | `node scripts/migrate-r7f-nullable-off-batch.mjs` (dry-run) | Print rencana eksekusi, no DB changes |
| E2 | `node scripts/test-r7f-direct-source.mjs` | 7 PASS + 9 SKIP, 0 FAIL |
| E3 | (Future) Apply migration: `node scripts/migrate-r7f-nullable-off-batch.mjs --apply` | Backup auto + rebuild table + foreign_key_check pass + row count sama. **Hanya jalankan dengan persetujuan operator + verifikasi backup.** |
| E4 | (Future, after E3) `POST /api/claim-workflow/from-direct` | Belum di-implement; route akan dibuat di phase berikut setelah E3 sukses |

**Tidak boleh apply E3 dalam manual QA tanpa konfirmasi eksplisit.**

---

## Section F — Compatibility & Boundary

| # | Step | Expected |
|---|------|----------|
| F1 | OFF Program Control flow tidak terpengaruh | OFF batch create/approve/payment/complete normal |
| F2 | OFF Completed gate tetap memvalidasi `claim_workflow.noClaim` + per-item `off_batch_item.noClaim` | Reject 409 `OFF_FINAL_NO_CLAIM_REQUIRED` jika belum ter-assign |
| F3 | `off_batch.status` tidak pernah berisi status Claim (`Submitted to Principal` / `Partially Paid` / `Paid` / `Closed`) | Inspect manual via `SELECT DISTINCT status FROM off_batch` |
| F4 | Status Claim tidak pernah masuk OFF status | sama sebaliknya |
| F5 | PEKA grep classification: production refs = 0 | `git grep -i "waiting_peka"`, `git grep -i "ec_received"`, `git grep -i "cn_received"`, `git grep -i "claim_peka_report"`, `git grep -i "peka-matches"` semua hanya hit docs retired / legacy cleanup script |

---

## Section G — RBAC Final Review

| Endpoint | admin/claim | staff (claim_workflow.view) | role lain |
|----------|-------------|------------------------------|-----------|
| GET `/api/claim-workflow/[id]` | ✓ | ✓ | 403 |
| GET `/api/claim-workflow/[id]/submissions` | ✓ | ✓ | 403 |
| POST `/api/claim-workflow/[id]/submissions` | ✓ | 403 | 403 |
| POST `/api/claim-workflow/[id]/submissions/from-items` | ✓ | 403 | 403 |
| PATCH submission | ✓ | 403 | 403 |
| POST item assign | ✓ | 403 | 403 |
| POST submission docs (letter/summary/receipt) | ✓ | 403 | 403 |
| POST submission payment | ✓ | 403 | 403 |
| POST submission void payment | ✓ | 403 | 403 |
| POST submission close | ✓ | 403 | 403 |
| GET reports | ✓ | ✓ | 403 |
| GET outstanding | ✓ | ✓ | 403 |

---

## Section H — R7g Excel-style No Claim + Per Item

R7g hanya mengubah frontend + tambah satu endpoint. Tidak menyentuh
schema. Source-of-truth No Claim tetap `claim_submission.noClaim`.

| # | Step | Expected |
|---|------|----------|
| H1 | Buka detail Claim Workflow `Draft`/`Need Revision` dengan minimal 1 paket. Pada editor No Claim per paket, klik toggle **Generate dari Excel**. | Form 5 field muncul: Nomor Urut, Kode Distributor (`SUPER`), Kode Principal (`GCPI` untuk Godrej), Bulan, Tahun. Default bulan/tahun mengikuti `Asia/Makassar`. |
| H2 | Isi sequence `1`, biarkan default lain. | Preview live: `01/SUPER-GCPI/{MM}/{YYYY}`. |
| H3 | Sequence `9` → `09/...`. Sequence `10` → `10/...`. Sequence `130` → `130/...`. | Padding hanya untuk 1-9; 10+ apa adanya. |
| H4 | Kosongkan sequence / set bulan `13` / set tahun `26`. | Preview menampilkan pesan validasi merah. Tombol "Gunakan No Claim Ini" disabled. |
| H5 | Sequence valid → klik **Gunakan No Claim Ini**. | Field input manual ter-isi nilai preview, generator tetap terbuka. Save belum otomatis dilakukan. |
| H6 | Edit field input manual sebelum Save → klik **Save**. | PATCH submission existing dipanggil; toast sukses muncul; detail reload. |
| H7 | Workflow multi-submission: editor workflow-level No Claim tetap tersembunyi. Generator hanya tampil di dalam panel Paket No Claim. | Sesuai. |
| H8 | Workflow Closed atau paket Closed: toggle Generator tidak tampil. | Sesuai (`canAssignNoClaim && submissionEditable`). |
| H9 | Section Paket No Claim: card "Buat Paket per Baris / Item" tampak untuk admin/claim saat workflow `Draft`/`Need Revision`. Klik tombol → confirm → endpoint `POST /[id]/submissions/from-items` mode `all_unassigned`. | Toast: "{N} paket per item dibuat." atau "Semua item sudah memiliki paket." Reload. |
| H10 | Setelah H9: setiap item klaim memiliki paket sendiri scope `per_item` dengan `scopeLabel` dari outlet/program/periode/no surat. `noClaim = null`. Workflow aggregate totals tetap sama dengan sum item. | Audit `claim_submissions_created_per_item` ditulis. |
| H11 | Klik tombol H9 sekali lagi (idempotent test). | Toast: "Semua item sudah memiliki paket." Tidak ada submission baru. |
| H12 | Workflow tanpa item: tombol H9 disabled (`items.length === 0`). | Sesuai. |
| H13 | Staff (`claim_workflow.view` only) buka detail. | Tidak ada toggle generator (No Claim view-only). Card "Buat Paket per Baris / Item" tidak tampil (`canEditItems` false). |
| H14 | `node scripts/test-r7g-excel-no-claim.mjs` | 36 PASS, 0 FAIL. |

---

## Section I — R7h Excel BASE Input Mode

R7h hanya menyentuh frontend halaman detail. Tidak ada endpoint baru.
Save tetap lewat PATCH item + PATCH submission existing.

| # | Step | Expected |
|---|------|----------|
| I1 | Buka detail Claim Workflow yang punya >= 1 item dan submission. | Mode tampilan default = **Excel Input**. localStorage `claimWorkflowSubmissionLayoutMode = "excel"` saat persist. |
| I2 | Switcher mode tampilan menampilkan opsi: Excel Input, Master Detail, Accordion, Kartu, Fokus, Status Board. Klik antar mode. | Switch berfungsi; Excel Input tetap memimpin daftar. |
| I3 | Toolbar Excel Input punya: Search, Filter status, Distributor (`SUPER`), Principal (auto `GCPI` untuk Godrej), Tahun, Bulan default (Asia/Makassar). | Default Tahun/Bulan mengikuti zona Makassar. Principal GCPI saat principle Godrej. |
| I4 | Tabel kolom: No, No Claim, Perihal, Periode, Surat Program, Outlet, DPP, PPN%, PPN Value, PPH%, PPH Value, Nilai Klaim, No.2, Bulan, Dokumen, Paid, Outstanding, Status, Aksi. | 19 kolom semua hadir; kolom kalkulasi (PPN Value, PPH Value, Nilai Klaim) read-only. |
| I5 | Edit DPP=100000, PPN%=11, PPH%=15. | Live preview: PPN Value 11000, PPH Value 15000, Nilai Klaim 96000. Row badge dirty (background amber). Tombol Simpan aktif. |
| I6 | Klik **Simpan**. | PATCH `/api/claim-workflow/[id]/items/[itemId]` dengan body `{ dpp, ppnRate, pphRate }`. Toast sukses. Detail reload. Submission/workflow totals update. |
| I7 | Edit No.2=`1`, Bulan=`02`. Klik tombol **Generate** di kolom Aksi row. | No Claim draft jadi `01/SUPER-GCPI/02/2026`. Tidak auto-save. |
| I8 | Klik **Simpan**. | PATCH `/api/claim-workflow/[id]/submissions/[submissionId]` dengan body `{ noClaim }`. Toast sukses. Submission `no_claim` tersimpan. |
| I9 | Edit No.2 + Bulan invalid (kosong / 13 / non-numeric tahun). | Validasi `toast.error` muncul. PATCH tidak dipanggil. |
| I10 | Edit baris yang itemnya belum punya submission (status fallback "Belum punya paket"). Klik Simpan setelah edit No Claim. | Toast minta klik "Buat Paket per Baris / Item" dulu. |
| I11 | Klik tombol toolbar **Buat Paket per Baris / Item**. | Reuse endpoint R7g `submissions/from-items`. Setelah reload, baris yang sebelumnya tanpa paket sekarang terhubung ke paket per_item baru dengan `noClaim = null`. |
| I12 | Filter "Belum No Claim" → menampilkan hanya baris dengan submission.noClaim kosong. | Sesuai. |
| I13 | Filter "Outstanding" → menampilkan baris submission yang `remainingAmount > 0`. | Sesuai. |
| I14 | Search `OUTLET-X` → tabel di-filter menurut substring case-insensitive (No Surat / Outlet / Perihal / No Claim). | Sesuai. |
| I15 | Klik tombol **Kelola Detail** di kolom Aksi salah satu row dengan submission. | Mode beralih ke Advanced (Master Detail). `selectedSubmissionId` = submissionId row. |
| I16 | Workflow status bukan Draft/Need Revision: input row read-only, tombol Simpan tidak tampil. | Sesuai. |
| I17 | Staff (`claim_workflow.view` only): tidak ada input edit DPP/PPN/PPH/No Claim/No.2/Bulan. Tombol "Siapkan Baris Claim" tidak tampil. | Sesuai (`canEditItems` false). |
| I18 | `node scripts/test-r7h-excel-input-mode.mjs` | 29 PASS, 0 FAIL. |

---

## Section J — R7i Staff Excel Mode Simplification

R7i hanya menyederhanakan presentasi UI. Tidak ada endpoint baru, schema
tidak berubah, regression R7c/R7d/R7e/R7g/R7h harus tetap hijau.

| # | Step | Expected |
|---|------|----------|
| J1 | Buka detail Claim Workflow di mode default. | Heading section utama: **"Daftar Claim"**. Subtitle: "Input No Claim, DPP, PPN, dan PPH seperti sheet BASE." |
| J2 | Switcher Mode Tampilan. | Hanya 2 tombol primer: `[Daftar Claim] [Advanced]`. Default Daftar Claim aktif. |
| J3 | Klik Advanced. | Submode kecil muncul: Master Detail / Accordion / Kartu / Fokus / Status Board. Caption "Advanced: gunakan hanya jika perlu menggabungkan/memecah baris claim atau mengelola detail dokumen, payment, dan close." |
| J4 | Reload halaman. | localStorage `claimWorkflowSubmissionLayoutMode` mempertahankan pilihan. Nilai legacy `master`/`accordion`/`card`/`focus`/`board` masuk ke Advanced. Nilai `excel` masuk ke Daftar Claim. |
| J5 | Mode Daftar Claim, ada item belum dipaketkan. | Banner kompak amber: "Ada baris claim yang belum siap diberi No Claim." + tombol **Siapkan Baris Claim**. Tidak ada form "Buat Paket No Claim Baru" / "Tipe Paket". |
| J6 | Klik **Siapkan Baris Claim** di banner. | POST `/[id]/submissions/from-items` mode `all_unassigned`. Toast sukses. Banner berubah jadi "Semua baris claim sudah siap diberi No Claim." setelah reload. |
| J7 | Mode Daftar Claim, semua item sudah `per_item`. | Hanya ada baris kecil "Semua baris claim sudah siap diberi No Claim." di bawah switcher. Tidak ada banner amber. |
| J8 | Mode Daftar Claim, workflow tanpa item. | Tidak ada banner. Tabel menampilkan empty state. |
| J9 | Mode Advanced. | Card "Siapkan Baris Claim" + section collapsible "+ Buat Kelompok Claim Manual" (sebelumnya "Buat Paket No Claim Baru") tampil. Form berisi Tipe Kelompok / Nama Kelompok / No Claim awal. Button "Buat Kelompok". |
| J10 | Header workflow. | Badge `{N} No Claim` (bukan "Paket No Claim"). Summary card "Jumlah No Claim". Helper text adaptive: multi → "Setiap baris claim dapat memiliki No Claim sendiri.", single → "Isi No Claim dan nilai klaim seperti di Excel BASE." |
| J11 | No Claim container info multi-submission. | Heading "No Claim per Baris". Tombol "Buka Daftar Claim" scroll ke section utama. |
| J12 | Tabel kolom Excel. | Header: `No. Urut` (bukan "No.2"), `Bulan Claim` (bukan "Bulan"). Aksi per row: tombol "Kelola Detail" (bukan "Kelola Paket"). |
| J13 | Workflow multi-submission, mode Daftar Claim. | Section workflow-level "Dokumen Klaim" disembunyikan dari default view (cuma `Pembayaran Principal` + `Close Workflow` + `Items` + `Audit` yang tetap tampil). |
| J14 | Workflow multi-submission, mode Advanced. | Section "Dokumen Klaim" workflow-level kembali muncul dengan helper amber: "Workflow memiliki beberapa No Claim. Dokumen dibuat per No Claim. Klik 'Kelola Detail' pada baris claim, atau gunakan Advanced untuk generate per No Claim." |
| J15 | Workflow single-submission. | Section workflow-level "Dokumen Klaim" tetap muncul di mode Daftar Claim maupun Advanced. |
| J16 | Master Detail panel (Advanced). | Empty state "Belum ada No Claim." (bukan "Paket No Claim"). Detail panel: "Detail No Claim Terpilih". Aria label list: "Daftar No Claim". |
| J17 | Regression: `node scripts/test-r7c-documents.mjs`, `r7d-submission-payments`, `r7e-close-reports`, `r7g-excel-no-claim`, `r7h-excel-input-mode`. | Semua 0 FAIL. |

---

## Section K — R7j Single Staff Excel Mode + Panduan Kerja Claim

R7j menghapus seluruh layout eksperimen dan switcher mode. Halaman
detail hanya punya satu tampilan: Daftar Claim. Tambah Detail Claim
panel inline dan Panduan Kerja Claim.

| # | Step | Expected |
|---|------|----------|
| K1 | Buka detail Claim Workflow. | Tidak ada switcher mode tampilan. Hanya satu render path: tabel Daftar Claim. |
| K2 | Cari kata "Paket" / "Submission" di halaman default. | Tidak ada di section utama (boleh ada di "Items" raw table footer dan "Audit"). |
| K3 | Tombol **Panduan Kerja Claim** ada di pojok kanan atas section Daftar Claim. | Default collapsed. Klik membuka panel berisi: Urutan Kerja (10 langkah), Penjelasan Kolom (13 entri), Rumus, Troubleshooting (4 skenario), Catatan Penting. |
| K4 | Klik tombol **Panduan Kerja Claim** kembali. | Panel tertutup. Tombol kembali ke teks "Panduan Kerja Claim". |
| K5 | Banner "Siapkan Baris Claim" tetap muncul saat ada item belum dipaketkan. | Klik tombol → endpoint `submissions/from-items` mode `all_unassigned`. Toast sukses. |
| K6 | Banner berubah jadi "Semua baris claim sudah siap diberi No Claim." setelah K5 atau saat semua item sudah `per_item`. | Sesuai. |
| K7 | Tombol **Detail** di kolom Aksi setiap row. | Klik → row expand jadi sub-row dengan `colSpan=19`. Tombol berubah jadi "Tutup Detail". |
| K8 | Detail panel inline isinya. | Header: scope label + No Claim mono. Ringkasan: DPP / PPN / PPH / Nilai Klaim. Dokumen 3 kartu (Letter/Summary/Kwitansi) dengan tombol Buka PDF + Generate. Summary pembayaran: Paid / Outstanding / Status. Helper note tentang section workflow-level. |
| K9 | Klik **Generate** di kartu Letter/Summary/Kwitansi dalam Detail panel. | Memanggil endpoint R7c per submission. Toast sukses. PDF path muncul. Detail reload. |
| K10 | Buka Detail row A, lalu klik Detail row B. | Row A otomatis collapse, row B expand. Hanya satu detail terbuka pada satu waktu. |
| K11 | Workflow multi-No-Claim, scroll ke bawah. | Section workflow-level "Dokumen Klaim" tidak muncul. |
| K12 | Workflow single-No-Claim. | Section workflow-level "Dokumen Klaim" tetap muncul untuk generate manual. |
| K13 | Edit DPP/PPN/PPH inline + Simpan. | PATCH item endpoint dipanggil. Detail Claim panel di row tetap konsisten setelah reload. |
| K14 | Edit No. Urut + Bulan Claim + klik Generate kemudian Simpan. | No Claim tersimpan ke `claim_submission.noClaim` (PATCH submission). |
| K15 | Staff (`claim_workflow.view` only). | Tidak ada input edit DPP/PPN/PPH/No Claim/No.2/Bulan. Tombol "Siapkan Baris Claim" tidak tampil. Tombol "Detail" tetap tampil dan menampilkan panel read-only. Tombol Generate dokumen tidak tampil bila `canEditItems` false. |
| K16 | localStorage `claimWorkflowSubmissionLayoutMode`. | R7j tidak baca dan tidak tulis key ini. Nilai legacy yang tertinggal di browser tidak berpengaruh. |
| K17 | Regression: `node scripts/test-r7c-documents.mjs`, `r7d-submission-payments`, `r7e-close-reports`, `r7g-excel-no-claim`, `r7h-excel-input-mode`. | Semua 0 FAIL. |
| K18 | (R7j-2 corrective) Default view setelah workflow load. | Tidak ada section "No Claim per Baris", "No Claim", atau "Dokumen Klaim" workflow-level. Heading utama "Daftar Claim" muncul tepat setelah Header + Langkah Berikutnya. |
| K19 | (R7j-2) Items raw table + Pembayaran Principal + Close Workflow + Audit. | Semua tersembunyi di balik card collapsible **Teknis / Riwayat** (default tertutup). Klik judul untuk buka. |
| K20 | (R7j-2) Copy guidance bilingual. | "X baris selesai" (bukan "paket"). Dialog confirm Siapkan Baris Claim memakai kata "baris claim". |

---

## Sign-off

| Section | Status | Notes |
|---------|--------|-------|
| A. R7b CRUD + items | | |
| B. R7c documents per submission | | |
| C. R7d payment per submission | | |
| D. R7e close + reports per submission | | |
| E. R7f HOLD verification | | |
| F. Compatibility & boundary | | |
| G. RBAC | | |
| H. R7g Excel-style No Claim + Per Item | | |
| I. R7h Excel BASE Input Mode | | |
| J. R7i Staff Excel Mode Simplification | | |
| K. R7j Single Staff Excel Mode + Panduan Kerja Claim | | |

QA dijalankan oleh: ___________________  Tanggal: __________
