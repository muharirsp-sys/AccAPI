# Godrej Purchase Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aktifkan rekonsiliasi Pembelian GODREJ dari Accurate XLSX dan GRN CSV pada localhost:3000.

**Architecture:** Parser dan engine Pembelian berdiri sendiri agar aturan barang masuk tidak mengubah engine Faktur/Return. API memakai handler upload aman yang sudah ada, sedangkan UI memakai kontrak tabel hasil Return dengan label khusus Pembelian.

**Tech Stack:** TypeScript, Next.js App Router, SheetJS `xlsx`, React, Playwright.

## Global Constraints

- Kerjakan hanya pada branch `main` lokal; jangan push atau mengubah GitHub.
- Jangan menyentuh `.codex/`.
- Jangan menambah dependency.
- Reuse `data/reconciliation/GODREJ_RETURN.xlsx`; jangan membuat salinan master.
- Matching produk deterministik dan exact; fuzzy matching dilarang.
- Qty Accurate = `QTY × ISI/CTN`; Qty GODREJ = `Qty_Approved`.
- DPP GODREJ = `Amount_Uploaded / 1.11`; toleransi DPP default Rp1.
- TDD wajib: test harus gagal karena fitur belum ada sebelum produksi ditulis.

---

### Task 1: Purchase engine

**Files:**
- Create: `lib/off-program-control/purchase-reconciliation.ts`
- Create: `lib/off-program-control/godrej-purchase-reconciliation.test.ts`

**Interfaces:**
- Consumes: Accurate XLSX buffer, GRN CSV buffer, mapping XLSX buffer.
- Produces: `reconcileGodrejPurchases(accurateBuffer, principalBuffer, mappingBuffer, options?)` yang mengembalikan `ReturnReconciliationOutput`.

- [ ] **Step 1: Write the failing engine test**

Test harus membuktikan parsing `DMS Bill`, mapping nama exact unik, konversi
`QTY × ISI/CTN`, `Qty_Approved`, `Amount_Uploaded / 1.11`, status mismatch,
unmapped/ambigu/invalid, agregasi duplikat, dan nomor baris sumber.

- [ ] **Step 2: Run test to verify RED**

Run: `npx tsx lib/off-program-control/godrej-purchase-reconciliation.test.ts`

Expected: FAIL karena modul atau `reconcileGodrejPurchases` belum tersedia.

- [ ] **Step 3: Implement minimal engine**

Gunakan `xlsx` yang sudah terpasang untuk membaca XLSX/CSV. Validasi header,
angka finite/non-negatif, satuan KRT, status Approved, konsistensi invoice dan
kuantitas. Normalisasi nama hanya dengan uppercase, whitespace/punctuation,
dan membuang kode numerik akhir. Panggil satu fungsi rekonsiliasi lokal yang
mengagregasi exact key `invoice|internalProduct`.

- [ ] **Step 4: Verify GREEN and real data**

Run:
`npx tsx lib/off-program-control/godrej-purchase-reconciliation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\gdj Pembelian\rincian_faktur_pembelian_cvsuryaperkasa_260730091023.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\gdj Pembelian\GRNstatusreport-1785314000-5ac8b4b.csv" "data\reconciliation\GODREJ_RETURN.xlsx"`

Expected: PASS; real simulation reports 15 documents per side, 7 overlapping
documents, and 368 source rows per side in the overlap.

- [ ] **Step 5: Commit**

Commit message: `feat(reconciliation): add godrej purchase engine`

### Task 2: Authenticated purchase endpoint

**Files:**
- Create: `app/api/reconciliation/godrej/purchases/route.ts`
- Create: `lib/off-program-control/godrej-purchase-route.test.ts`
- Modify: `lib/off-program-control/kino-sales-route.ts`

**Interfaces:**
- Consumes: `reconcileGodrejPurchases` and internal GODREJ master.
- Produces: authenticated `POST /api/reconciliation/godrej/purchases`.

- [ ] **Step 1: Write the failing route test**

Test auth-before-multipart, exact two file fields, extension/MIME/size checks,
missing master, parser error masking, and successful engine response.

- [ ] **Step 2: Run test to verify RED**

Run: `npx tsx lib/off-program-control/godrej-purchase-route.test.ts`

Expected: FAIL karena route belum tersedia.

- [ ] **Step 3: Implement route**

Reuse `createKinoSalesPostHandler` dengan field `accurateFile` dan
`principalFile`, permission `reconciliation.run`, master
`data/reconciliation/GODREJ_RETURN.xlsx`, serta parser message GRN yang aman.

- [ ] **Step 4: Verify GREEN**

Run: `npx tsx lib/off-program-control/godrej-purchase-route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(reconciliation): expose godrej purchase endpoint`

### Task 3: Purchase UI and integration verification

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes: `POST /api/reconciliation/godrej/purchases` and the existing return-shaped result contract.
- Produces: active Pembelian tab, two upload controls, issue-first result table, and XLSX export.

- [ ] **Step 1: Write the failing Playwright test**

Test mengaktifkan Pembelian, memaksa principal GODREJ, mereset state,
menampilkan label `Rincian Faktur Pembelian (Accurate)` dan
`GRN Status Report GODREJ`, mengirim multipart ke endpoint purchases,
menampilkan penyebab selisih, mengekspor nama file Pembelian, dan menjaga
ketiga tema.

- [ ] **Step 2: Run scoped test to verify RED**

Run: `npx playwright test tests/reconciliation-ui.spec.ts`

Expected: FAIL pada skenario Pembelian yang masih nonaktif.

- [ ] **Step 3: Implement minimal UI**

Tambahkan `PEMBELIAN` ke tipe divisi dan tab. Reuse reset, upload, ringkasan,
filter, tabel, dan ekspor yang ada; hanya cabangkan endpoint dan label domain.

- [ ] **Step 4: Verify feature and regressions**

Run:

```text
npx tsx lib/off-program-control/godrej-purchase-reconciliation.test.ts
npx tsx lib/off-program-control/godrej-purchase-route.test.ts
npx tsc --noEmit
npx eslint "lib/off-program-control/purchase-reconciliation.ts" "lib/off-program-control/godrej-purchase-reconciliation.test.ts" "lib/off-program-control/godrej-purchase-route.test.ts" "lib/off-program-control/kino-sales-route.ts" "app/api/reconciliation/godrej/purchases/route.ts" "app/(dashboard)/reconciliation/page.tsx" "tests/reconciliation-ui.spec.ts"
npm run build
npx playwright test tests/reconciliation-ui.spec.ts
```

Expected: seluruh command exit 0; build memuat route purchases dan halaman
reconciliation.

- [ ] **Step 5: Run authenticated localhost simulation**

Start/reuse production server pada localhost:3000, login dengan akun admin
lokal tanpa mencetak password/cookie, POST dua file nyata, dan cocokkan hasil
HTTP dengan simulasi engine langsung.

- [ ] **Step 6: Commit**

Commit message: `feat(reconciliation): add godrej purchase UI`
