# CUSSONS Return Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambahkan rekonsiliasi Return CUSSONS dua-file yang exact, aman, tampil di localhost, dan teruji dengan data nyata.

**Architecture:** Parser Accurate dan TXN_NOTEPRD dinormalisasi ke `CanonicalReturnLine`, lalu memakai `reconcileParsedReturns`. Mapping memakai `parseCussonsMappings`; route memakai handler multipart bersama; UI memakai alur Return yang sudah ada.

**Tech Stack:** Next.js App Router, React, TypeScript, SheetJS `xlsx`, Node assert tests, Playwright.

## Global Constraints

- Hanya `main` lokal; jangan push atau mengubah GitHub.
- Jangan menambah dependency atau fuzzy matching.
- Master internal harus byte-for-byte sama dengan file pengguna.
- Gunakan TDD: test gagal karena fitur belum ada sebelum production code ditulis.
- Jangan stage/commit `.codex/` atau `.superpowers/sdd/`.

---

### Task 1: Engine CUSSONS Return dan Master

**Files:**
- Create: `lib/off-program-control/cussons-return-reconciliation.test.ts`
- Modify: `lib/off-program-control/return-reconciliation.ts`
- Create: `data/reconciliation/CUSSONS_RETURN.xlsx`

**Interfaces:**
- Consumes: `parseCussonsMappings(mappingBuffer)`
- Produces: `reconcileCussonsReturns(accurateBuffer, principalBuffer, mappingBuffer, options?)`
- Returns: `ReturnReconciliationOutput`

- [ ] **Step 1: Write failing engine test**

Uji exact CN+produk, diskon, agregasi, batas toleransi Rp1, EA/CS, formula invalid, CN invalid, customer ganda, mapping invalid, missing, dan acceptance file nyata 21 MATCH + 7 MISSING_PRINCIPAL.

- [ ] **Step 2: Run RED**

Run: `npx tsx lib/off-program-control/cussons-return-reconciliation.test.ts`

Expected: FAIL karena `reconcileCussonsReturns` belum diekspor.

- [ ] **Step 3: Implement minimal parser and matching seam**

Tambah parser CUSSONS di `return-reconciliation.ts`, reuse `parseCussonsMappings`, dan tambahkan opsi privat key customer hanya bila dibutuhkan agar CUSSONS mencocokkan CN+produk tanpa mengubah prinsipal lama.

- [ ] **Step 4: Copy master byte-for-byte**

Salin master user ke `data/reconciliation/CUSSONS_RETURN.xlsx`; buktikan SHA-256 sumber dan tujuan sama.

- [ ] **Step 5: Run GREEN and regression**

```powershell
npx tsx lib/off-program-control/cussons-return-reconciliation.test.ts
npx tsx lib/off-program-control/heinz-return-reconciliation.test.ts
npx tsx lib/off-program-control/godrej-return-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `feat(reconciliation): add cussons return engine`

### Task 2: Endpoint CUSSONS Return

**Files:**
- Create: `lib/off-program-control/cussons-return-route.test.ts`
- Modify: `lib/off-program-control/kino-sales-route.ts`
- Create: `app/api/reconciliation/cussons/returns/route.ts`

**Interfaces:**
- Consumes: `reconcileCussonsReturns`
- Produces: `POST /api/reconciliation/cussons/returns`

- [ ] **Step 1: Write failing actual-route test**

Import `POST` asli dan uji auth-before-parse, permission, tepat dua file, extension/MIME/size/NUL/rusak, master hilang, safe parser 422, masking internal, dan success parity.

- [ ] **Step 2: Run RED**

Run: `npx tsx lib/off-program-control/cussons-return-route.test.ts`

Expected: FAIL karena route belum ada.

- [ ] **Step 3: Add safe allowlist and thin route**

Tambahkan hanya pola pesan parser CUSSONS Return yang exact ke allowlist, lalu route tipis yang membaca master internal dan memanggil engine dengan toleransi Rp1.

- [ ] **Step 4: Run GREEN and route regressions**

```powershell
npx tsx lib/off-program-control/cussons-return-route.test.ts
npx tsx lib/off-program-control/heinz-return-route.test.ts
npx tsx lib/off-program-control/godrej-return-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat(reconciliation): expose cussons return endpoint`

### Task 3: UI CUSSONS Return

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes: `POST /api/reconciliation/cussons/returns`
- Produces: pilihan CUSSONS Return dan input CSV `TXN_NOTEPRD CUSSONS`.

- [ ] **Step 1: Write failing Playwright test**

Pilih Return+CUSSONS; pastikan label/accept CSV, dua-file gating, endpoint dan field multipart benar, hasil/penyebab/ekspor tampil, lalu pindah prinsipal dan kembali untuk membuktikan reset.

- [ ] **Step 2: Run RED**

Run: `npx playwright test tests/reconciliation-ui.spec.ts --grep "CUSSONS Return"`

Expected: FAIL karena CUSSONS belum tersedia pada Return.

- [ ] **Step 3: Implement minimal UI**

Tambah CUSSONS ke `returnPrinciples`, label/CSV condition, dan biarkan alur endpoint/reset/ekspor yang sudah generik bekerja.

- [ ] **Step 4: Run GREEN and UI regression**

```powershell
npx playwright test tests/reconciliation-ui.spec.ts --grep "CUSSONS Return"
npx playwright test tests/reconciliation-ui.spec.ts
```

Expected: focused 1 PASS dan seluruh rekonsiliasi PASS.

- [ ] **Step 5: Commit**

Commit: `feat(reconciliation): add cussons return UI`

### Task 4: Integrasi dan Simulasi Nyata

**Files:**
- Modify only when a verified defect requires a TDD fix.

**Interfaces:**
- Consumes: complete engine, endpoint, UI.
- Produces: fresh verification evidence and latest localhost build.

- [ ] **Step 1: Run engine and route regressions**

Jalankan seluruh test reconciliation/return route dengan runner yang sesuai.

- [ ] **Step 2: Run static verification**

```powershell
npx tsc --noEmit
npx eslint <all changed files>
npm run build
```

Expected: exit 0; warning NFT lama boleh tetap ada.

- [ ] **Step 3: Simulate real files**

Jalankan engine dengan Accurate, CSV, dan master user; jalankan actual endpoint dengan dua file upload serta master internal. Assert 28 Accurate lines, 21 principal lines, 28 results, `MATCH=21`, `MISSING_PRINCIPAL=7`, status lain 0, serta seluruh hasil memiliki source rows.

- [ ] **Step 4: Run full Playwright and serve latest build**

Run: `npx playwright test tests/reconciliation-ui.spec.ts`

Expected: all PASS. Akhiri dengan build terbaru aktif pada `localhost:3000`.

- [ ] **Step 5: Final review**

Review seluruh diff terhadap spec; perbaiki setiap Critical/Important finding via TDD dan re-review.
