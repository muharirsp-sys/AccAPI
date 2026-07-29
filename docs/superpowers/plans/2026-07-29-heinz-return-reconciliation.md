# HEINZ Return Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambahkan rekonsiliasi Return HEINZ tiga-file yang aman, exact, tampil di localhost, dan teruji dengan file nyata.

**Architecture:** Parser HEINZ dinormalisasi ke `CanonicalReturnLine` lalu memakai comparator Return yang sama. Shared multipart handler mendapat dukungan input HEADER opsional tanpa mengubah kontrak route dua-file lama; UI hanya menampilkan input ketiga untuk Return HEINZ.

**Tech Stack:** Next.js App Router, React, TypeScript, SheetJS `xlsx`, CSV parser yang sudah terpasang, Node assert tests, Playwright.

## Global Constraints

- Hanya `main` lokal; jangan push atau mengubah GitHub.
- Jangan menambah dependency atau fuzzy matching.
- Master internal harus byte-for-byte sama dengan file user.
- Gunakan TDD: test harus gagal karena fitur belum ada sebelum production code ditulis.
- Jangan stage/commit `.codex/` atau `.superpowers/sdd/`.

---

### Task 1: HEINZ Return Engine dan Master

**Files:**
- Create: `lib/off-program-control/heinz-return-reconciliation.test.ts`
- Modify: `lib/off-program-control/return-reconciliation.ts`
- Create: `data/reconciliation/HEINZ_RETURN.xlsx`

**Interfaces:**
- Produces: `reconcileHeinzReturns(accurateBuffer, headerBuffer, detailBuffer, mappingBuffer, options?)`
- Returns: `ReturnReconciliationOutput`

- [ ] **Step 1: Write the failing engine test**

Test synthetic CSV/XLSX untuk MATCH exact `CN + customer + mapped SKU`, `Approved`, qty `eaches_quantity`, nilai `gross_value / 1.11`, agregasi, invalid CN, invalid join/line count, mapping conflict, UNMAPPED, dan missing.

- [ ] **Step 2: Run RED**

Run: `npx tsx lib/off-program-control/heinz-return-reconciliation.test.ts`

Expected: FAIL karena `reconcileHeinzReturns` belum diekspor.

- [ ] **Step 3: Implement minimal parser**

Tambahkan parser exact HEADER, DETAIL, Accurate, dan mapping HEINZ ke `return-reconciliation.ts`. Reuse `reconcileParsedReturns`; tambah parameter key callback hanya jika dibutuhkan tanpa mengubah output prinsipal lama.

- [ ] **Step 4: Copy master byte-for-byte**

Salin `FIX_FORM MASTER BARANG - HEINZ.xlsx` ke `data/reconciliation/HEINZ_RETURN.xlsx`, lalu buktikan SHA-256 sumber dan tujuan sama.

- [ ] **Step 5: Run GREEN and regression**

Run:

```powershell
npx tsx lib/off-program-control/heinz-return-reconciliation.test.ts
npx tsx lib/off-program-control/godrej-return-route.test.ts
```

Expected: kedua test PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(reconciliation): add heinz return engine`

### Task 2: API Tiga File yang Aman

**Files:**
- Create: `lib/off-program-control/heinz-return-route.test.ts`
- Modify: `lib/off-program-control/kino-sales-route.ts`
- Create: `app/api/reconciliation/heinz/returns/route.ts`

**Interfaces:**
- Consumes: `reconcileHeinzReturns`
- Produces: `POST /api/reconciliation/heinz/returns`

- [ ] **Step 1: Write failing actual-route test**

Import `POST` asli dan uji auth sebelum parse, permission, tiga file wajib, duplicate/unknown field, ext/MIME/size/NUL/rusak, missing master, safe masking, serta success sama dengan pemanggilan engine langsung.

- [ ] **Step 2: Run RED**

Run: `npx tsx lib/off-program-control/heinz-return-route.test.ts`

Expected: FAIL karena route belum ada atau `headerFile` belum didukung.

- [ ] **Step 3: Extend shared handler minimally**

Tambahkan konfigurasi optional untuk `headerFile` CSV dan callback reconcile empat buffer. Callers dua-file lama tetap memakai kontrak lama dan test regresinya harus tetap hijau.

- [ ] **Step 4: Add thin HEINZ route**

Authorize `reconciliation.run`, baca `data/reconciliation/HEINZ_RETURN.xlsx`, dan panggil engine dengan toleransi DPP Rp1.

- [ ] **Step 5: Run GREEN and route regression**

Run:

```powershell
npx tsx lib/off-program-control/heinz-return-route.test.ts
npx tsx lib/off-program-control/godrej-return-route.test.ts
```

Expected: PASS tanpa perubahan perilaku GODREJ.

- [ ] **Step 6: Commit**

Commit message: `feat(reconciliation): expose heinz return endpoint`

### Task 3: UI Return HEINZ

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes: `POST /api/reconciliation/heinz/returns`
- Produces: pilihan HEINZ dan tiga input file kondisional.

- [ ] **Step 1: Write failing Playwright test**

Tambahkan skenario HEINZ pada test Return existing: pilih HEINZ, lihat label HEADER dan DETAIL, tombol disabled sampai tiga file, request berisi nama ketiga field, hasil/kolom/penyebab tampil, pindah prinsipal mereset.

- [ ] **Step 2: Run RED**

Run: `npx playwright test tests/reconciliation-ui.spec.ts --grep "HEINZ Return"`

Expected: FAIL karena opsi/input HEINZ belum ada.

- [ ] **Step 3: Implement minimal UI**

Tambah HEINZ pada union/daftar Return, state `headerFile`, kartu CSV ketiga hanya untuk Return HEINZ, append `headerFile`, kondisi tombol, teks bantuan, reset, dan prefix ekspor.

- [ ] **Step 4: Run GREEN**

Run: `npx playwright test tests/reconciliation-ui.spec.ts --grep "HEINZ Return"`

Expected: PASS.

- [ ] **Step 5: Run full reconciliation UI regression**

Run: `npx playwright test tests/reconciliation-ui.spec.ts`

Expected: seluruh test PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(reconciliation): add heinz return UI`

### Task 4: Integrasi dan Simulasi Nyata

**Files:**
- Modify only if a verified defect requires a TDD fix.

**Interfaces:**
- Consumes: complete HEINZ engine, API, and UI.
- Produces: fresh verification evidence and deterministic real-file counts.

- [ ] **Step 1: Run engine/route regression**

Run all `lib/off-program-control/*reconciliation*.test.ts` and `*return-route.test.ts` with `npx tsx`.

- [ ] **Step 2: Run static verification**

Run:

```powershell
npx tsc --noEmit
npm run lint
npm run build
```

Expected: exit code 0; existing non-fatal Turbopack NFT warning may remain.

- [ ] **Step 3: Simulate real HTTP**

POST the user-provided Accurate, HEADER, and DETAIL files to the running local endpoint with an authorized local session. Assert result count equals sum of exact unmatched groups, no MATCH is invented, and all source rows remain traceable.

- [ ] **Step 4: Run Playwright**

Run: `npx playwright test tests/reconciliation-ui.spec.ts`

Expected: all reconciliation UI tests PASS.

- [ ] **Step 5: Final review**

Review the complete diff against `docs/superpowers/specs/2026-07-29-heinz-return-reconciliation-design.md`; fix every Critical/Important finding through TDD, then re-run affected verification.

