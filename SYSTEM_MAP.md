<!--
Tujuan: Peta navigasi arsitektur, alur fungsi, dan status modul utama repository.
Caller: Developer/agent sebelum trace, analisis, atau perubahan kode.
Dependensi: Struktur source repository dan flow runtime yang telah diverifikasi.
Main Functions: Menunjukkan entry point, handler, business logic, data access, storage, dan test kunci.
Side Effects: Tidak ada; dokumen ini hanya menjadi kompas dan wajib disinkronkan saat flow berubah.
-->
# SYSTEM_MAP.md
> Navigasi utama proyek — dibuat otomatis via trace-by-function/flow.
> Update file ini setiap kali ada modul baru atau perubahan arsitektur signifikan.

---

## Project Summary

**Tujuan:** ERP internal CV. Surya Perkasa — distributor yang mengelola biaya promosi off-program (OPC), klaim ke principal, pembayaran, SPPD, validasi data penjualan, dan integrasi Accurate ERP.

**Tech Stack Utama:**

| Layer | Teknologi |
|---|---|
| Frontend/API | Next.js 16 (App Router), React 19, TypeScript |
| Backend Sidecar | Python FastAPI (port 8000) |
| Database | PostgreSQL via `pg` + Drizzle (D4 code cutover); Sales History tetap SQLite terpisah |
| ORM | Drizzle ORM + drizzle-kit |
| Auth | Better Auth 1.x (email/password, admin plugin, RBAC) |
| PDF | pdf-lib |
| Excel | xlsx |
| Email | nodemailer (SMTP) |
| Styling | Tailwind CSS 4 |
| State/Form | React Hook Form, Zod, TanStack React Table |
| Search (opsional) | Elasticsearch (fallback ke in-memory fuzzy) |
| ERP Eksternal | Accurate Online API (OAuth2 + proxy) |
| AI/OCR (opsional) | SumoPod API, OpenAI (Python backend) |

**Pola Arsitektur:**
- **Next.js App Router monorepo** — satu repo, dua runtime (Next.js + Python FastAPI).
- **Route Group** `(auth)` untuk halaman login/register, `(dashboard)` untuk seluruh halaman aplikasi yang dilindungi guard layout.
- Layer `lib/*` memisahkan business logic dari route handler.
- `lib/db.ts`, `lib/auth.ts`, `db/schema.ts`, dan `drizzle.config.ts` memakai PostgreSQL. `sqlite.db` adalah sumber/rollback migrasi lama, bukan runtime route Next.js.
- RBAC tiga lapis: **Dynamic Permission-Group** (access_group + group_permission + user_group, default-deny) ∪ legacy **role global** (Better Auth) ∪ legacy **custom permissions** (user.permissions). Union resolver di `lib/rbac/resolve.ts`; sistem lama tetap berjalan selama transisi.
- Permission key format: `"module.action"` (mis. `"off_program_control.sm_approve"`). Sumber tunggal: `lib/rbac/registry.ts` (92 key). Endpoint wajib pakai `requirePermission`/`requirePermissionH` — key tidak terdaftar → 403.
- Email-domain role inference dihapus. OFF-specific role (`resolveOffRoleFromUser`) tetap ada untuk audit/state-machine, TIDAK untuk authz.

---

## Core Logic Flow (Function-Level Flowchart)

### 1. Autentikasi & Guard Halaman
```
Browser -> /login page
  -> app/(auth)/actions.ts [signIn(email, password)]
  -> lib/auth.ts [auth.api.signInWithEmailAndPassword]
  -> Better Auth + Drizzle SQLite (tabel user/session)
  -> Redirect /dashboard

Browser -> any /dashboard/* route
  -> app/(dashboard)/layout.tsx [DashboardLayout]
  -> lib/auth.ts [auth.api.getSession]
  -> lib/rbac.ts [canAccessPath(pathname, role, permissions)]  ← page-level (legacy)
  -> [OK] render SidebarLayout | [FAIL] redirect /login atau /

Browser -> any /api/* route (modul baru)
  -> requirePermission(request, "module.action")              ← API-level (baru)
     -> auth.api.getSession
     -> getUserPermissions(userId)                            ← lib/rbac/resolve.ts
        -> DB: user_group + group_permission (sistem baru)
        -> permissionMapForUser(role, permissions)            ← legacy union
     -> perms.has(key) ? proceed : 403
```

### 2. OFF Program Control — Buat & Submit Pengajuan
```
UI: OffProgramControlPage (tab supervisor)
  -> POST /api/off-program-control/batches
  -> batches/route.ts [POST]
     -> requireOffSession() — lib/off-program-control/helpers.ts
     -> canActorPerformOffAction(actor, "create_batch") — lib/off-program-control/access.ts
     -> getPrincipleByName() / findOffNoSuratConflicts() — lib/off-program-control/data.ts
     -> db.insert(offBatch) + db.insert(offBatchItem) — Drizzle SQLite
     -> writeOffAudit() — lib/off-program-control/helpers.ts
  <- { ok: true, batchId, noPengajuan }

UI: Supervisor submit batch
  -> POST /api/off-program-control/batches/[id]/submit
     -> canActorPerformOffAction(actor, "submit_batch")
     -> generateOffBatchPdf() — lib/off-program-control/pdf.ts [pdf-lib -> file system]
     -> db.update(offBatch, { status: "Submitted to SM" })
     -> writeOffAudit()
```

### 3. OFF Program Control — Approval Chain (SM → Claim → OM → Finance)
```
SM Approve:
  -> PATCH /api/off-program-control/batches/[id]/sm-approve
     -> canActorPerformOffAction(actor, "sm_approve")
     -> db.update(offBatch, { smStatus: "Approved by SM" })
     -> writeOffAudit()

Claim Review:
  -> PATCH /api/off-program-control/batches/[id]/claim-review
     -> canActorPerformOffAction(actor, "claim_review")
     -> db.update(offBatch, { claimStatus: "Approved" })
     -> writeOffAudit()

OM Approve:
  -> PATCH /api/off-program-control/batches/[id]/om-decision
     -> canActorPerformOffAction(actor, "om_approve")
     -> db.update(offBatch) + db.insert(claimWorkflow) [auto-create]
     -> writeOffAudit()

Finance Payment:
  -> POST /api/off-program-control/batches/[id]/finance-payment
     -> canActorPerformOffAction(actor, "finance_payment")
     -> canProcessFinancePayment(batch) — lib/off-program-control/workflow.ts
     -> db.insert(offPayment) + db.update(offBatch, { financeStatus })
     -> writeOffAudit()
```

### 4. Claim Workflow — Input, Dokumen, Pembayaran
```
UI: ClaimWorkflow detail page (/claim-workflow/[id])
  -> GET /api/claim-workflow/[id]
     -> requireClaimSession() — lib/claim-workflow/access.ts
     -> canActorReadClaimWorkflow(actor)
     -> db.select(claimWorkflow + items + payments + submissions)

Input item klaim:
  -> PATCH /api/claim-workflow/[id]/items/[itemId]
     -> validateClaimItem() — lib/claim-workflow/calculations.ts
     -> db.update(claimWorkflowItem)

Generate Surat Klaim (PDF):
  -> POST /api/claim-workflow/[id]/claim-letter
     -> buildClaimLetterPdf() — lib/claim-workflow/pdf.ts [pdf-lib]
     -> writeFile() ke runtime/claim-workflow/letters/
     -> db.update(claimWorkflow, { claimLetterPdfPath })

Record pembayaran dari principal:
  -> POST /api/claim-workflow/[id]/payments
     -> db.insert(claimPayment)
     -> recalculateTotals() -> db.update(claimWorkflow, { totalPaid, remainingAmount })
```

### 5. Accurate ERP Sync & Proxy
```
UI: API Wrapper page (/api-wrapper)
  -> POST /api/proxy
     -> route.ts [POST] — forward ke Accurate API (sessionHost + Bearer apiKey)
     <- JSON response

Idempotency guard (bulk sales receipt):
  -> POST /api/idempotency/lock — cek & kunci fingerprint di SQLite idempotency_log
  -> [bulk POST ke Accurate]
  -> POST /api/idempotency/complete — tandai selesai

Data Sync (item/customer):
  -> lib/sync.ts [syncModule(moduleName, endpoint, creds)]
     -> AccuratePaginator() — generator async + 150ms throttle per page
     -> db.insert(item|customer).onConflictDoNothing() — SQLite local cache
     -> db.update(syncState, { lastPage, status })
```

### 6. Python FastAPI Backend (Validator & Payments)
```
Browser -> NEXT_PUBLIC_FASTAPI_BASE_URL (port 8000)
  -> python_backend/main.py [FastAPI app]
     -> /payments/upload — parse Excel LPB, simpan ke payments.json
     -> /payments/finance/data — data finance approval
     -> /payments/finance/proof — upload bukti transfer
     -> /validator/upload — upload data penjualan/channel
     -> /validator/run — validator_engine.py [compare expected vs actual]
     -> /sppd/generate — render_sppd_docx() — buat DOCX SPPD
     -> auth.py — RBAC + rate limiter login internal FastAPI
```

---

### 7. Dashboard Generator Desktop (Fase 2-8)
```
User -> dashboard-generator/app.py [pywebview desktop window]
  -> dashboard-generator/index.html [sidebar terkelompok + upload UI]
     -> Pembelian [Dashboard Pembelian, Retur Pembelian, dan Outstanding PO aktif]
     -> Penjualan / Laba Rugi [Dashboard Penjualan, Laba Rugi, Retur, Outstanding SO]
     -> Persediaan [Dashboard Posisi Stok, Analisa Stok]
     -> Keuangan [Dashboard Umur Hutang dan Umur Piutang aktif]
     -> Cross Analysis [Stok vs Analisa; Retur Jual vs Outs SO; Penjualan vs Laba Rugi; Kandidat Discontinue disembunyikan sementara, engine tetap ada]

Single report:
  -> Api.pick_file() [native dialog XLS/XLSX/CSV/TSV untuk seluruh dashboard aktif]
  -> Api.generate(path, selected_type)
     -> detector.detect_report_type_from_file(path, preferred_jenis=selected_type)
        [Excel: scan header semua sheet; CSV/TSV: baca header saja]
     -> CSV/TSV atau XLSX >=64 MiB: pilih adapter large menurut jenis laporan
        -> Penjualan: penjualan_large.build_data_from_file(path, sheet_names, header_rows)
        -> Pembelian/LabaRugi/Retur Penjualan/Retur Pembelian/OutstandingSO: large_operational.build_data_from_file(...)
        -> PosisiStok/AnalisaStok/OutstandingPO/UmurPiutang/UmurHutang: large_inventory_finance.build_data_from_file(...)
        [DuckDB memory limit 1 GB; CSV/TSV out-of-core; XLSX streaming 50.000 baris -> DB temporer]
     -> XLS/XLSX kecil: read_detected_sheets(path, result)
        [pandas.read_excel memakai offset header masing-masing sheet, baca kolom terpakai saja, concat jika >1 sheet]
     -> module.generate_dashboard(df) atau LARGE_RENDERERS[jenis](data)
         modules: pembelian, penjualan, labarugi, stok, analisa, retur, retur_pembelian, outstanding, outstanding_po, umur_piutang, umur_hutang
  <- HTML preview in iframe + optional export_html()

Cross-analysis + Data Alchemist (Fase 7+):
  -> Api.pick_files() [multi-file XLS/XLSX/CSV/TSV]
   -> Api.generate_cross(paths, cross_type)
     -> detector.detect_report_type_from_file(path) per file
     -> reject duplicate report type / unknown signature
      -> reject cepat bila 2+ jenis file tidak sama dengan kebutuhan menu yang dipilih
     -> bila salah satu CSV/TSV atau XLSX >=64 MiB:
        -> cross_large.build_cross_data_from_files(report_infos, cross_type)
        -> agregasi setiap sumber pada SKU/produk/customer di DuckDB sebelum join pandas
     -> selain itu: read_detected_sheets(path, result)
        -> CrossLifecycle: cross_lifecycle.build_data(...) -> render_html(...)
        -> Cross 2-file lama: cross_analysis.build_data(...) -> render_html(...)
         -> satu analisis spesifik per menu; CrossLifecycle memakai outer join tiga sumber pada Kode Barang
         -> export_rows berisi seluruh hasil gabungan, bukan hanya ranking HTML
  <- HTML preview + export_html()
  -> Api.export_cross_excel()
     -> cross_excel.write_cross_workbook(data, cross_type, path)
     -> Ringkasan formula-driven + detail penuh + chart prioritas + Kamus Data
  <- workbook .xlsx
```

| File | Fungsi Utama | Peran |
|---|---|---|
| `dashboard-generator/app.py` | `READ_COLUMNS`, `LARGE_RENDERERS`, `large_source_args`, `CROSS_REQUIREMENTS`, `Api.generate`, `Api.generate_cross`, `Api.export_cross_excel`, `main` | Entrypoint desktop; routing jalur kecil/besar, validasi kebutuhan 2+ laporan per Cross, simpan dataset Cross terakhir, export HTML/XLSX |
| `dashboard-generator/index.html` | `MENU_GROUPS`, `CROSS_TYPES`, `CROSS_FILE_COUNTS`, sidebar, picker, export handlers | Lima kelompok client; 14 menu aktif ditampilkan; CrossLifecycle disembunyikan sementara tetapi konfigurasi/engine 3 file tetap ada |
| `dashboard-generator/detector.py` | `detect_report_type_from_file`, `detect_report_sheets_from_file` | Signature kolom, bukan nama file; mengenali alias export Pembelian (`No.Jurnal`/Bruto/Pajak), PO langsung, Retur Pembelian, dan Umur Hutang; memilih sheet kanonik Pembelian/Master; header-offset per sheet; header-only CSV/TSV |
| `dashboard-generator/pembelian.py` | `build_data`, `render_html`, `generate_dashboard` | Pembelian setelah PPN: `Nilai Bruto - Nilai Disc + Nilai Pajak` bila DPP tidak tersedia, atau DPP + PPN unik dokumen; alokasi PPN proporsional; GOL/JENIS/PCL opsional dan kosong diberi notifikasi |
| `dashboard-generator/penjualan.py` | `build_data`, `render_html`, `generate_dashboard` | Penjualan setelah PPN (`Bruto - Diskon + Pajak`) untuk semua nilai; Ringkasan Market/Region/Gol/PCL; one-look dan formula hover |
| `dashboard-generator/penjualan_large.py` | `should_use_large_reader`, `build_data_from_file` | Engine DuckDB/streaming Penjualan multi-GB; offset header per sheet; schema parity Ringkasan Market/Region/Gol/PCL; filter footer `No Invoice` |
| `dashboard-generator/large_source.py` | `ColumnSpec`, `SourceMeta`, `open_large_source` | Reader bersama: CSV/TSV DuckDB out-of-core, XLSX read-only per 50.000 baris, XLS legacy fallback; DB temporer dan memory limit 1 GB |
| `dashboard-generator/large_operational.py` | `build_data_from_file` | Adapter large Pembelian, Laba Rugi, Retur Penjualan/Pembelian, dan Outstanding SO; HPP satuan dihitung di query sebagai HPP x Qty tanpa materialisasi tabel 5 GB |
| `dashboard-generator/large_inventory_finance.py` | `build_data_from_file` | Adapter large Posisi Stok, Analisa Stok, Outstanding PO, Umur Piutang, dan Umur Hutang; agregasi NULL-safe dan offset multi-sheet |
| `dashboard-generator/shared.py` + `assets/echarts.min.js` | `inline_echarts` | Chart ECharts dibundel lokal dan diinjeksi inline agar preview/export jalan offline tanpa CDN |
| `dashboard-generator/hpp.py` | `normalise_hpp_frame`, `hpp_sql_expression`, `hpp_uses_unit` | Kontrak HPP bersama: `Nilai HPP x Qty`; `JUM HPP` menjadi kontrol/fallback total dan tidak pernah dikalikan ulang |
| `dashboard-generator/labarugi.py` | `build_data`, `render_html`, `generate_dashboard` | Laba Rugi: `Nilai Jual - (HPP Satuan x Qty) - Biaya Lain = Laba`; rekonsiliasi ke HPP total sumber, Ringkasan Market/Gol, formula hover |
| `dashboard-generator/stok.py` + `analisa.py` | `build_data`, `render_html`, `generate_dashboard` | Dashboard persediaan: rekonsiliasi snapshot/nilai/qty, insight satu-lihat, formula KPI/chart saat hover tanpa menciptakan harga per unit semu |
| `dashboard-generator/retur.py` + `outstanding.py` | `build_data`, `render_html`, `generate_dashboard` | Retur memakai nilai setelah PPN (`Bruto - Disc + Pajak`); Outstanding SO menampilkan aging dari tanggal laporan dikurangi tanggal order; keduanya punya rekonsiliasi dan formula hover |
| `dashboard-generator/retur_pembelian.py` | `build_data`, `render_html`, `generate_dashboard` | Retur Pembelian setelah PPN: `Nilai Bruto - Nilai Disc + Nilai Pajak`, supplier/item/jenis/gudang, dan formula hover |
| `dashboard-generator/outstanding_po.py` | `build_data`, `render_html`, `generate_dashboard` | Outstanding PO menerima legacy `Sisa` + QC `Order-Kirim-Batal-Reject` atau export langsung `Qty Outstanding x Harga PO`; status PPN tidak diklaim tanpa kolom sumber |
| `dashboard-generator/umur_piutang.py` | `build_data`, `generate_dashboard` | Dashboard Umur Piutang: `Debit - Kredit/Retur = Piutang Net`, rekonsiliasi 5 aging bucket, formula hover; tanggal laporan mode hanya diklaim konsisten bila semua baris sama |
| `dashboard-generator/umur_hutang.py` | `build_data`, `render_html`, `generate_dashboard` | Dashboard Umur Hutang: `-Nilai` kredit sumber menjadi Hutang Net positif, rekonsiliasi 5 bucket aging, supplier/akun/kota, dan formula hover |
| `dashboard-generator/test_umur_piutang.py` | `main` | Self-check Umur Piutang dengan sample XLS nyata dan validasi output offline |
| `dashboard-generator/cross_analysis.py` | `has_supported_pair`, `build_data`, `render_html` | Stok memakai union/overlap Kode SKU; Retur memakai nilai setelah PPN; Penjualan-vs-Laba Rugi memakai HPP grain-aware dan merupakan rekonsiliasi selisih dengan kontrol periode |
| `dashboard-generator/cross_lifecycle.py` | `master_status_labels`, `build_data`, `build_from_aggregates`, `render_html` | Cross tiga sumber Penjualan × Posisi Stok × Master Barang; tujuh status item, guardrail periode 90 hari, formula hover, dan chart offline |
| `dashboard-generator/cross_excel.py` | `build_cross_workbook`, `write_cross_workbook` | Workbook Data Alchemist 2+ sumber dengan formula detail/ringkasan, filter/table, conditional formatting, chart, dan kamus definisi |
| `dashboard-generator/cross_large.py` | `should_use_large_cross`, `build_cross_data_from_files` | Cross multi-GB 2+ sumber; agregasi sebelum join, termasuk HPP satuan x Qty di DuckDB, dengan kontrak data sama untuk HTML/Excel |
| `dashboard-generator/test_procurement_finance_exports.py` | `main` | Self-check deteksi, formula, render offline, adapter large, dan sample nyata empat export baru |
| `dashboard-generator/PANDUAN_RUMUS_DASHBOARD.md` | panduan dashboard, mode multi-GB, roadmap Cross | Dokumen client untuk grain, rumus, status PPN, batas interpretasi, dan saran Data Alchemist |
| `dashboard-generator/test_cross_analysis.py` | `demo` | Self-check Fase 7 dengan 6 sample XLS nyata |
| `dashboard-generator/test_cross_excel.py` | `main` | Roundtrip tiga workbook Cross: detail penuh, formula audit, tabel, chart, dan sheet kamus |
| `dashboard-generator/test_cross_lifecycle.py` | `main` | Self-check Cross tiga laporan: tujuh klasifikasi, outer join SKU, parity DuckDB, HTML offline, dan Excel formula-driven |
| `dashboard-generator/test_pembelian.py` | `main` | Self-check PPN dokumen, dimensi opsional/notifikasi, formula setelah PPN, dan sample Faktur Pembelian nyata |
| `dashboard-generator/test_large_operational.py` + `test_large_inventory_finance.py` | `main` | Parity adapter large untuk delapan dashboard non-Penjualan lewat CSV/TSV/XLS/XLSX dan offset header/multi-sheet |
| `dashboard-generator/test_cross_large.py` + `test_large_app_routing.py` | `main` | Parity Cross large dan smoke routing API desktop untuk Cross dua maupun tiga laporan ke HTML/Excel-ready |
| `dashboard-generator/test_outstanding_po.py` | `main` | Self-check Outstanding PO termasuk formula QC dan catatan PPN |
| `dashboard-generator/test_multisheet_dashboard.py` | `demo` | Self-check workbook multi-sheet sejenis dibaca dan digabung ke dashboard |
| `dashboard-generator/test_no_company_branding.py` | `main` | Self-check agar source/output dashboard generator tidak membawa hardcoded nama perusahaan internal |
| `dashboard-generator/DashboardGenerator.spec` | PyInstaller build graph | Build satu-file `dist/DashboardGenerator.exe`; include UI/ECharts offline serta runtime pandas/xlrd/openpyxl/DuckDB untuk jalur file besar |

---

## Summary Program — Determinisme Pipeline (FASE 1–6 + Pass 3)

**Masalah:** surat program (foto/PDF scan) → Dataset Diskon (xlsx) + Form Summary (PDF) via OCR+LLM
non-deterministik: dokumen SAMA bisa keluar hasil BEDA tiap run (tier bergeser, varian ditebak,
baris ke-split, byte file beda). Solusi: buang keputusan LLM dari jalur yang harus pasti, ganti dgn
lookup/parser deterministik + freeze cache + snapshot regresi + netralisir non-determinisme
byte-level. Semua modul additive (jalur lama tetap sbg fallback). Refactor F10: logic ini semua
hidup di `python_backend/routers/summary.py` (BUKAN `main.py`, yang kini 559 baris app-setup saja).

```
surat (bytes) + principle_name
  │  parse_key = sha256(bytes + "|" + PRINCIPLE_UPPER)
  ▼
[FASE 1b] parse_cache.py ── cache hit? ── ya ─▶ rows FINAL BEKU (0 panggilan API sama sekali)
  │ tidak:
  │  ocr_cache_key = sha256(bytes)
  ▼
  [FASE 1] ocr_cache.py ── cache hit? ── ya ─▶ teks OCR BEKU (Gemini 0 panggilan, determinis)
  │ tidak: OCR per-halaman (gemini) → simpan (freeze, tak pernah ditimpa)
  ▼
LLM parse per-channel (gpt-4.1-mini, 1 chunk = 1 channel biar tak kehabisan max_tokens)
  ▼
Pass 3 self_correction.py :: verify_and_correct_rows  (SUMMARY_SELF_CORRECT=1 default)
  editor QA PATCH-BASED: model HANYA boleh kirim {id, field, to, alasan} atas field di
  _PATCHABLE_FIELDS (ketentuan/benefit/kelompok/variant/gramasi/...). DILARANG tambah/hapus
  baris atau sentuh id/kode_barangs. Patch invalid/id asing/gagal apa pun → rows utuh (no-op).
  Log SELALU (termasuk 0 patch) → "editor bersih" beda dari "editor gagal diam-diam".
  ▼
_apply_native_kelompok (match ke master)
  │                            [FASE 3b] variant_resolver.py + variant_mapping.json
  │                            resolusi varian via TABEL deklaratif (bukan tebakan LLM):
  │                            cth "Spray Cologne Series" → White+Black SR (GLASS excluded),
  │                            "EDT Sport" → 4 varian tertentu. Return None → fallback jalur lama.
  ▼
[FASE 2b] tier_parser.py :: regroup_rows_by_tier
  parser POSISIONAL tabel OCR (kolom PAKET/CUT PRICE by posisi) = tier OTORITATIF, bukan LLM.
  kode_barang ter-bridge keyakinan-tinggi (overlap token + gramasi sama) → trigger/benefit
  di-override & baris ber-tier sama DIGABUNG (fix Bellagio EDT & EDP Prestige ke-split).
  Ragu → kode TIDAK disentuh (no silent guess).
  ▼
[FASE 1b] parse_cache_put(rows final) — freeze; run ke-2 dok+principle sama = 0 API total
  ▼
summary_manual_generate → excel_rows (single source of truth utk Excel + PDF)
  │  guard V3b (cross-check gramasi), V4 (buang duplikat lintas-tier)
  │
  │  [FASE 4b] correction_store.py :: apply_corrections (alias apply_stable_corrections)
  │  override koreksi manusia (tombol "Laporkan Salah") via STABLE KEY
  │  (kode_barang, channel, no_surat) — BUKAN index baris (aman walau urutan OCR beda).
  │  Menang atas hasil apa pun. Sejak wiring endpoint report_correction: field yg berubah
  │  di tabel edit disimpan otomatis ke sini (SELAIN hint lama parse_corrections.jsonl).
  ▼
[FASE 6] deterministic_output.py — netralisir non-determinisme BYTE-LEVEL (bukan cuma isi):
  enable_pdf_determinism() sblm doc.build (ReportLab rl_config.invariant=1 → CreationDate/
  doc-id reproducible). finalize_xlsx(path) setelah wb2.save (openpyxl timpa
  docProps/core.xml modified=now() tiap save + timestamp entry-zip acak → dipaku tetap).
  ▼
[FASE 5] golden_store.py :: golden_check_and_freeze
  input_key = sig(rows murni, SEBELUM mutasi apa pun) ; output_sig = sig(excel_rows).
  new = dibekukan | match = deterministik terbukti | drift = input SAMA output BEDA (regresi,
  dilaporkan, golden TIDAK ditimpa; refresh butuh approve_golden manual).
  response.determinism = new|match|drift
```

| File | Fungsi Utama | Peran |
|---|---|---|
| `python_backend/ocr_cache.py` | `ocr_cache_key`, `ocr_cache_get/put` | FASE 1: cache OCR by content-hash, freeze-on-first-write (run ke-2 dok sama = 0 panggilan Gemini) |
| `python_backend/parse_cache.py` | `parse_cache_key`, `parse_cache_get/put` | FASE 1b: freeze rows FINAL per (doc_hash, principle) — run ke-2 = 0 panggilan API sama sekali (bukan cuma OCR) |
| `python_backend/tier_parser.py` | `parse_positional_tables`, `match_item_to_tablerow`, `regroup_rows_by_tier` | FASE 2/2b: tier dari POSISI tabel OCR (no LLM); regroup baris LLM ke tier otoritatif; self-check `__main__` |
| `python_backend/variant_resolver.py` + `variant_mapping.json` | `load_variant_mapping`, `resolve_variant` | FASE 3/3b: resolusi varian via tabel deklaratif; None = fallback; anti-halusinasi |
| `python_backend/correction_store.py` | `save_correction`, `apply_corrections`, `correction_key` | FASE 4/4b: koreksi manusia stable-key, override deterministik (bukan hint prompt); ditulis otomatis dari endpoint `report_correction` |
| `python_backend/golden_store.py` | `canonical_signature`, `golden_check_and_freeze`, `approve_golden` | FASE 5: snapshot determinisme; deteksi drift output utk input identik; self-check `__main__` |
| `python_backend/deterministic_output.py` | `enable_pdf_determinism`, `finalize_xlsx` | FASE 6: paku non-determinisme BYTE-LEVEL (ReportLab doc-id/CreationDate; openpyxl zip-timestamp + `docProps/core.xml`). **Bug ditemukan+diperbaiki 2026-07-13**: `\1`/`\2` di replacement regex diikuti digit literal ditafsir Python `re` sbg backreference/octal → `docProps/core.xml` corrupt (file tak bisa dibuka) walau tetap "byte-identik" antar-run (self-check lama cuma cek hash, tak cek well-formed). Fix: `\g<1>`/`\g<2>`; self-check kini juga `load_workbook` ulang + parse XML. |
| `python_backend/self_correction.py` | `verify_and_correct_rows` | Pass 3 (arsitektur ala Reducto): editor LLM QA PATCH-BASED atas hasil parse; whitelist field, dilarang sentuh id/kode_barangs/jumlah baris; gagal apa pun → no-op; `SUMMARY_SELF_CORRECT=0` utk nonaktifkan |

Titik integrasi (F10: **BUKAN** `main.py`, lihat `python_backend/routers/summary.py`):
import blok FASE 1/1b/2b/3b/4b/5/6 + Pass 3 di `shared.py` (~baris 19–25) & re-export ke router;
`parse_cache_get` di awal + Pass 3 + `regroup_rows_by_tier` + `parse_cache_put` di akhir
`summary_manual_parse_pdf_ai`; `apply_stable_corrections` + `enable_pdf_determinism`/`finalize_xlsx`
+ golden check di `summary_manual_generate`.

---

## Clean Tree

```
AccAPI/_github_clean/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   ├── register/page.tsx
│   │   ├── forgot-password/page.tsx
│   │   └── reset-password/page.tsx
│   ├── global-error.tsx               # Root error boundary (render <html>/<body> sendiri)
│   ├── (dashboard)/
│   │   ├── layout.tsx                  # Auth guard + RBAC gate semua halaman dashboard (denied → <AccessDenied/>)
│   │   ├── error.tsx                   # Error boundary segmen dashboard (pesan rapi, tanpa stack)
│   │   ├── page.tsx                    # Home/dashboard utama
│   │   ├── off-program-control/
│   │   │   └── page.tsx                # Cockpit OPC (SPV/SM/Claim/OM/Finance/Audit tabs)
│   │   ├── claim-workflow/
│   │   │   ├── page.tsx                # Daftar claim workflow
│   │   │   ├── [id]/page.tsx           # Detail + aksi per workflow
│   │   │   └── reports/page.tsx        # Laporan outstanding/paid
│   │   ├── payments/
│   │   │   ├── page.tsx
│   │   │   ├── cart/[draftId]/page.tsx
│   │   │   └── sppd/page.tsx
│   │   ├── api-wrapper/
│   │   │   ├── page.tsx                # UI proxy Accurate ERP
│   │   │   └── parsers/                # Parser bulk sales receipt
│   │   ├── finance/page.tsx
│   │   ├── summary/page.tsx
│   │   ├── validator/page.tsx
│   │   ├── principles/page.tsx
│   │   ├── admin/users/                # User management + legacy RBAC editor
│   │   └── admin/groups/               # Dynamic RBAC: kelola Access Group + permission + member
│   └── api/
│       ├── auth/
│       │   ├── [...all]/route.ts       # Better Auth catch-all handler
│       │   ├── callback/route.ts       # Accurate OAuth callback
│       │   ├── db-list/route.ts
│       │   └── open-db/route.ts
│       ├── off-program-control/
│       │   ├── batches/
│       │   │   ├── route.ts            # GET list + POST create
│       │   │   └── [id]/
│       │   │       ├── route.ts        # GET detail + PATCH edit
│       │   │       ├── submit/route.ts
│       │   │       ├── sm-approve/route.ts
│       │   │       ├── sm-return/route.ts
│       │   │       ├── claim-review/route.ts
│       │   │       ├── final-claim/route.ts
│       │   │       ├── om-decision/route.ts
│       │   │       ├── finance-payment/route.ts
│       │   │       ├── refund/route.ts
│       │   │       ├── pdf/route.ts
│       │   │       ├── kwitansi/route.ts
│       │   │       └── audit/route.ts
│       │   ├── periods/route.ts        # Tutup periode per principal
│       │   ├── principles/route.ts
│       │   ├── discount/route.ts
│       │   ├── payments/[paymentId]/proof/route.ts
│       │   └── audit/route.ts          # Export audit log OPC
│       ├── claim-workflow/
│       │   ├── route.ts                # GET list (paginated/cursor)
│       │   ├── [id]/
│       │   │   ├── route.ts
│       │   │   ├── items/[itemId]/route.ts
│       │   │   ├── payments/route.ts + [paymentId]/void/route.ts
│       │   │   ├── claim-letter/route.ts
│       │   │   ├── receipt/route.ts
│       │   │   ├── summary/route.ts
│       │   │   ├── status/route.ts
│       │   │   ├── close/route.ts
│       │   │   ├── no-claim/route.ts
│       │   │   ├── audit/route.ts
│       │   │   ├── documents/generate-all/route.ts
│       │   │   └── submissions/        # Multi No Claim (Phase R7+)
│       │   ├── from-off-batch/[offBatchId]/route.ts
│       │   ├── outstanding/route.ts
│       │   └── reports/                # outstanding/paid/summary (+ export)
│       ├── idempotency/
│       │   ├── lock/route.ts           # Kunci fingerprint bulk upload
│       │   └── complete/route.ts
│       ├── proxy/route.ts              # Proxy ke Accurate ERP API
│       ├── webhook/accurate/route.ts   # Terima webhook dari Accurate
│       └── admin/
│           ├── bootstrap/route.ts      # One-time admin setup
│           ├── users/permissions/route.ts
│           └── groups/
│               ├── route.ts            # GET list + POST create Access Group
│               └── [id]/
│                   ├── route.ts        # GET detail + PATCH sync perms + DELETE
│                   └── members/route.ts # POST add / DELETE remove user dari group
├── components/
│   ├── SidebarLayout.tsx               # Shell navigasi dashboard
│   ├── DataTable.tsx                   # TanStack Table reusable; caption, loading/live status, kolom, pagination aksesibel
│   ├── AccessDenied.tsx                # Pesan "Akses ditolak" eksplisit (guard layout + page admin)
│   ├── PWAInstallPrompt.tsx
│   ├── ServiceWorkerRegistration.tsx
│   ├── ThemeSwitcher.tsx
│   ├── off-program-control/
│   │   ├── OffBreadcrumb.tsx
│   │   ├── OffGlobalSearch.tsx
│   │   └── OffNotificationBell.tsx
│   └── ui/                             # Input, Select, DatePickerField (dialog kalender + keyboard), AsyncSearchSelect, Dialog native, AsyncState bersama
├── lib/
│   ├── auth.ts                         # Konfigurasi Better Auth server
│   ├── auth-client.ts                  # Better Auth client (browser)
│   ├── rbac.ts                         # RBAC legacy (union layer selama transisi)
│   ├── rbac/
│   │   ├── registry.ts                 # PERMISSION_REGISTRY — sumber tunggal 87 key
│   │   ├── resolve.ts                  # getUserPermissions, requirePermission/H, resolveRequestPermissions/H
│   │   └── registry.test.ts            # Self-check: integritas registry + scan route.ts
│   ├── db.ts                           # Drizzle client singleton
│   ├── email.ts                        # nodemailer sendEmail
│   ├── sync.ts                         # AccuratePaginator + syncModule
│   ├── apiFetcher.ts                   # Fetch helper client-side
│   ├── fuzzySearch.ts
│   ├── pdf-text.ts                     # uppercasePageText helper PDF
│   ├── off-program-control/
│   │   ├── index.ts                    # Re-export barrel
│   │   ├── access.ts                   # resolveOffRole, canPerformOffAction
│   │   ├── dev-fixtures.ts              # `?mock=N` development-only; generator maksimum 2.000 batch OFF in-memory
│   │   ├── workflow.ts                 # canProcessFinancePayment, computeBatchProgress
│   │   ├── data.ts                     # getBatchWithItems, findOffNoSuratConflicts
│   │   ├── helpers.ts                  # requireOffSession, writeOffAudit, publicBatch
│   │   ├── payments.ts                 # computeOffPaymentSummary, computeOffFinancePaymentSummary
│   │   ├── pdf.ts                      # buildPdf (pengajuan OFF) + kwitansi
│   │   ├── reconciliation-pdf.ts       # PDF rekonsiliasi periode
│   │   ├── constants.ts                # offPrinciples, offFinanceStatuses, dll
│   │   ├── types.ts                    # OffBatchRow, OffItemRow, dll
│   │   ├── program-type.ts             # OFF_PROGRAM_TYPES, resolveProgramType
│   │   ├── search.ts                   # matchesSearch, buildSearchHaystack
│   │   ├── problematic.ts              # Validasi problem-code / item bermasalah
│   │   └── holidays.ts                 # Kalender hari libur nasional (deadline calc)
│   └── claim-workflow/
│       ├── index.ts                    # Re-export barrel
│       ├── access.ts                   # requireClaimSession, canActorReadClaimWorkflow
│       ├── calculations.ts             # Hitung DPP/PPN/PPh/nilaiKlaim
│       ├── audit.ts                    # writeClaimAudit
│       ├── pdf.ts                      # buildClaimLetterPdf (surat klaim)
│       ├── pdf-summary.ts              # buildClaimSummaryPdf
│       ├── pdf-receipt.ts              # buildClaimReceiptPdf
│       ├── reports.ts                  # Query laporan outstanding/paid
│       ├── submissions.ts              # Helper Multi No Claim (Phase R7a+)
│       ├── document-paths.ts           # Path builder dokumen klaim per submission
│       ├── no-claim-rules.ts           # Validasi aturan No Claim
│       ├── off-finance-gate.ts         # Gate: OPC harus lunas sebelum klaim tutup
│       ├── constants.ts                # Status list, label, dll
│       └── types.ts                    # ClaimWorkflowRow, ClaimSubmissionRow, dll
├── db/
│   └── schema.ts                       # Satu file Drizzle schema (semua tabel)
├── python_backend/
│   ├── main.py                         # FastAPI headless JSON API — validator, payments, SPPD, finance (auth via cookie Better Auth; UI/auth HTML dihapus #7)
│   ├── auth.py                         # Rate limiter login + security headers Python backend
│   ├── payments.py                     # Template row builder untuk Excel
│   ├── validator_engine.py             # Engine validasi data penjualan vs diskon
│   └── principle_matcher.py            # Fuzzy matcher nama principal
├── scripts/
│   ├── init-db.mjs                     # Inisialisasi tabel SQLite pertama kali
│   ├── migrate-local.mjs               # Migrasi lokal (dev)
│   ├── migrate-opc-columns.mjs         # Migrasi kolom OPC
│   ├── seed-opc-dummy.mjs              # Seed 1.275 dummy batch OPC (testing)
│   ├── test-phase0-ui-guards.mjs        # Regression guard trust/persistence UI Fase 0
│   ├── test-phase5-build-guards.mjs     # Guard dashboard dinamis + standalone tidak menyalin seluruh project root
│   ├── test-phase7-interaction-guards.mjs # Guard target sentuh, keyboard kalender, dan shell Laporan Harian
│   └── test-r7*.mjs                    # Test script Phase R7 claim workflow
├── config/                             # Konfigurasi static (principles, dll)
├── public/                             # Static assets, icons, SW
├── .env.example                        # Template env lengkap
├── .env.local                          # Env lokal aktif (tidak di-commit)
├── drizzle.config.ts                   # Drizzle kit config (schema + output migrations)
├── next.config.ts                      # Next.js config
├── docker-compose.yml                  # Deploy: frontend + backend container
├── Dockerfile.frontend
├── Dockerfile.backend
└── proxy.ts                            # Dev proxy config
```

---

## Module Map (The Chapters)

### Auth & Session

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/auth.ts` | `auth` (betterAuth instance) | Konfigurasi server auth: email/password, admin plugin, SQLite adapter, email reset/verify |
| `lib/auth-client.ts` | `authClient` | Client-side Better Auth hooks untuk browser |
| `lib/rbac.ts` | `canAccess`, `canAccessPath`, `permissionMapForUser`, `normalizeRole` | RBAC legacy: preset per role, custom per-user — masih aktif sebagai legacy union layer |
| `lib/rbac/registry.ts` | `PERMISSION_REGISTRY`, `allPermissionKeys`, `isValidPermissionKey` | **Sumber tunggal** 85 permission key (`module.action`). Zero import — pure data. Test-guard scan semua route.ts saat CI |
| `lib/rbac/resolve.ts` | `getUserPermissions`, `requirePermission`, `requirePermissionH`, `resolveRequestPermissions`, `resolveRequestPermissionsH` | Union resolver: DB group + legacy role/permissions. Guard endpoint default-deny. `requirePermissionH` untuk route pakai `next/headers` |
| `lib/rbac/registry.test.ts` | self-check script | Validasi integritas registry + scan semua route.ts: gagal jika ada key tidak terdaftar. Jalankan: `node --experimental-strip-types lib/rbac/registry.test.ts` |
| `app/(dashboard)/layout.tsx` | `DashboardLayout`, `dynamic = "force-dynamic"` | Guard semua halaman dashboard: session check + RBAC path check; selalu render per request karena membaca header/session |
| `app/(dashboard)/admin/users/` | `UserManagement` | UI kelola user internal, set role, set legacy custom permission |
| `app/(dashboard)/admin/groups/` | `GroupManagement` | **UI Dynamic RBAC**: buat/edit Access Group, assign permission key per group, assign user ke group |
| `app/api/auth/[...all]/route.ts` | Better Auth catch-all | Mount semua endpoint auth Better Auth |
| `app/api/admin/bootstrap/route.ts` | `POST` | One-time setup akun admin pertama via token |
| `app/api/admin/groups/route.ts` | `GET`, `POST` | List + buat Access Group; gate: `users.manage` |
| `app/api/admin/groups/[id]/route.ts` | `GET`, `PATCH`, `DELETE` | Detail + sync permission + hapus group; tulis `permission_audit_log` |
| `app/api/admin/groups/[id]/members/route.ts` | `POST`, `DELETE` | Assign/remove user dari group; tulis `permission_audit_log` |

### OFF Program Control (OPC)

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/off-program-control/access.ts` | `resolveOffRole`, `getOffAccessibleTabs`, `canPerformOffAction` | Resolver role OPC domain-specific (7 role: admin/SPV/SM/claim/OM/finance/sales) |
| `lib/off-program-control/helpers.ts` | `requireOffSession`, `writeOffAudit`, `publicBatch`, `buildNoPengajuan` | Session resolver OPC, audit writer, serializer output batch |
| `lib/off-program-control/workflow.ts` | `canProcessFinancePayment`, `computeBatchProgress`, `hasMinimalFinalChecklist` | Guard transisi status workflow OPC |
| `lib/off-program-control/data.ts` | `getBatchWithItems`, `findOffNoSuratConflicts`, `isOffPeriodClosedForBatch` | Query compound batch+items, validasi duplikat No Surat, cek tutup periode |
| `lib/off-program-control/payments.ts` | `computeOffPaymentSummary`, `computeOffFinancePaymentSummary` | Kalkulasi total tunai/transfer, sisa bayar, status lunas |
| `lib/off-program-control/pdf.ts` | `buildPdf`, `generateOffBatchPdf`, `generateOffKwitansiPdf` | Cetak PDF pengajuan OPC (summary + kwitansi) via pdf-lib |
| `lib/off-program-control/reconciliation-pdf.ts` | `generateReconciliationPdf` | PDF rekonsiliasi periode per principal |
| `app/api/off-program-control/batches/route.ts` | `GET`, `POST` | Daftar + buat batch OPC (filter periode, search Elasticsearch/lokal) |
| `app/api/off-program-control/batches/[id]/route.ts` | `GET`, `PATCH` | Detail + revisi batch |
| `app/api/off-program-control/batches/[id]/submit/route.ts` | `POST` | Submit ke SM, generate PDF |
| `app/api/off-program-control/batches/[id]/sm-approve/route.ts` | `POST` | Persetujuan SM |
| `app/api/off-program-control/batches/[id]/claim-review/route.ts` | `POST` | Review & approve Claim |
| `app/api/off-program-control/batches/[id]/finance-payment/route.ts` | `POST` | Input pembayaran Finance |
| `app/api/off-program-control/batches/[id]/refund/route.ts` | `POST` | Submit refund kelebihan bayar |
| `app/(dashboard)/off-program-control/page.tsx` | `OffProgramControlPage` + tab components | Cockpit OPC full; data runtime hanya dari API dan error tidak diganti fixture. Untuk stress test UI lokal, `?mock=N` mengaktifkan maksimum 2.000 batch sintetis in-memory hanya pada development; bulk SPV tetap mulai dari baris kosong. Tab dan detail batch tersinkron ke query URL, tab mendukung roving keyboard, overlay kritis memakai Dialog native bersama, hierarchy/density memakai semantic cockpit tokens, shell sesi memakai loading skeleton |

### Form Kontrol

| File | Fungsi Utama | Peran |
|---|---|---|
| `app/(dashboard)/form-kontrol/page.tsx` | `FormKontrolPage`, `loadScope`, `selectTab` | Memuat `/api/form-kontrol/my-scope` secara fail-closed; loading memakai skeleton, error punya retry, lalu tab dibuka sesuai role dan tersinkron ke query URL |
| `app/(dashboard)/form-kontrol/visit/[custCode]/page.tsx` | `VisitWizardPage`, `PhotoInput` | Flow check-in -> status order -> simpan merchandising -> check-out; langkah hanya maju sesudah persistence sukses |
| `components/form-kontrol/camera-capture.tsx` | `CameraCapture` | Kamera/pratinjau foto dalam Dialog native; tetap terbuka dan dapat retry sampai callback upload+persistence resolve |
| `components/ui/Dialog.tsx` | `Dialog` | Primitive modal native bersama: focus trap/restoration browser, Escape, label/deskripsi, dan backdrop opsional |
| `components/DataTable.tsx` | `DataTable` | Tabel generik dengan caption, status live, loading skeleton, empty state eksplisit, sorting semantik, kontrol kolom/pagination aksesibel, sticky header, dan density baris konsisten |
| `components/off-program-control/OffGlobalSearch.tsx` | `OffGlobalSearch` | Quick jump OFF via Ctrl/Cmd+K; combobox/listbox mendukung Arrow, Home/End, Enter, dan Escape tanpa mengambil alih Ctrl/Cmd+F browser; hasil membuka deep-link batch di overview |
| `components/off-program-control/OffNotificationBell.tsx` | `OffNotificationBell` | Ringkasan masalah SLA dengan progressive disclosure dan aksi langsung membuka batch terkait tanpa pencarian ulang |
| `app/(dashboard)/insentif-sales/page.tsx` | `InsentifSalesPage`, `updateContext` | View serta filter principle/cabang tersinkron ke query URL; dashboard/finance memakai loading skeleton, error recovery, empty state reset, dan seluruh tabel memakai density semantic bersama |
| `app/globals.css` | semantic cockpit classes | Sumber token lebar halaman, spacing, radius, page hierarchy, tab, toolbar, panel, tabel, dan action hierarchy untuk route operasional |
| `components/ui/AsyncState.tsx` | `LoadingState`, `ErrorState`, `EmptyState` | Primitive feedback async bersama; skeleton mengikuti reduced-motion, error meneruskan retry, empty state dapat membawa recovery action |

### Payments UI Safety

| File | Fungsi Utama | Peran |
|---|---|---|
| `app/(dashboard)/payments/page.tsx` | `fetchData`, `handleSaveBulk`, `handleSubmitCart` | Refresh focus/visibility ditahan saat ada edit lokal; perubahan wajib tersimpan sebelum draft cart dibuat |

### Claim Workflow

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/claim-workflow/access.ts` | `requireClaimSession`, `canActorReadClaimWorkflow`, `canActorWriteClaimWorkflow` | Resolver session klaim, gate baca/tulis workflow |
| `lib/claim-workflow/calculations.ts` | `calcClaimItemTotals`, `recalcWorkflowTotals` | Hitung DPP/PPN/PPh/nilaiKlaim per item dan agregasi workflow |
| `lib/claim-workflow/pdf.ts` | `buildClaimLetterPdf` | Generate surat klaim ke principal (pdf-lib) |
| `lib/claim-workflow/pdf-summary.ts` | `buildClaimSummaryPdf` | Generate rekapitulasi klaim (pdf-lib) |
| `lib/claim-workflow/pdf-receipt.ts` | `buildClaimReceiptPdf` | Generate kwitansi penerimaan klaim (pdf-lib) |
| `lib/claim-workflow/reports.ts` | `getOutstandingReport`, `getPaidReport`, `getSummaryReport` | Query laporan klaim (outstanding/paid/summary) |
| `lib/claim-workflow/submissions.ts` | `createDefaultSubmission`, `backfillDefaultSubmission` | Helper Multi No Claim: satu workflow bisa banyak submission |
| `lib/claim-workflow/document-paths.ts` | `buildSubmissionDocumentFilePath` | Resolver path file dokumen per submission |
| `lib/claim-workflow/no-claim-rules.ts` | `validateNoClaimAssignment` | Validasi aturan bisnis penugasan No Claim |
| `lib/claim-workflow/off-finance-gate.ts` | `checkOffFinanceGate` | Gate: OPC harus sudah Paid sebelum klaim bisa Close |
| `app/api/claim-workflow/route.ts` | `GET` | Daftar workflow (cursor pagination, filter status/principal) |
| `app/api/claim-workflow/[id]/route.ts` | `GET`, `PATCH` | Detail + update workflow |
| `app/api/claim-workflow/[id]/claim-letter/route.ts` | `POST`, `GET` | Generate + serve PDF surat klaim |
| `app/api/claim-workflow/[id]/payments/route.ts` | `GET`, `POST` | Daftar + tambah pembayaran dari principal |
| `app/api/claim-workflow/[id]/submissions/` | routes | Multi-submission: CRUD + dokumen per submission (Phase R7+) |
| `app/api/claim-workflow/reports/` | routes | Laporan + export Excel outstanding/paid/summary |

### Accurate ERP Integration

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/sync.ts` | `AccuratePaginator`, `syncModule` | Sync paginated data Accurate ke SQLite lokal (item/customer) dengan checkpoint |
| `app/api/proxy/route.ts` | `POST` | Forward request ke Accurate API (autentikasi + payload flattening) |
| `app/api/auth/callback/route.ts` | `GET` | OAuth2 callback dari Accurate (tukar code ke token) |
| `app/api/webhook/accurate/route.ts` | `POST` | Terima event webhook dari Accurate (IP whitelist + simpan log) |
| `app/(dashboard)/api-wrapper/page.tsx` | UI | Antarmuka manual query/bulk-submit ke Accurate |
| `app/(dashboard)/api-wrapper/parsers/` | `parsePurchaseReturnBulkSave` | Parse Excel ke payload bulk API Accurate |

### Python FastAPI Backend

| File | Fungsi Utama | Peran |
|---|---|---|
| `python_backend/main.py` | FastAPI headless JSON API | Validator, payments management, SPPD DOCX, finance. Auth via sesi Better Auth (cookie); auth paralel + UI HTML lama dihapus (#7) |
| `python_backend/validator_engine.py` | `extract_pdf_text_safe`, `read_upload_file_limited` | Engine ekstraksi & validasi data (PDF/Excel) |
| `python_backend/payments.py` | `lpb_upload_template_rows`, `validator_*_template_rows` | Template row builder untuk Excel upload |
| `python_backend/principle_matcher.py` | `find_best_match`, `normalize_principle_name` | Fuzzy matching nama principal antar dataset |
| `python_backend/auth.py` | `LoginRateLimiter`, `build_security_headers` | Rate limiter login + security headers Python backend |

### Idempotency & Utilities

| File | Fungsi Utama | Peran |
|---|---|---|
| `app/api/idempotency/lock/route.ts` | `POST` | Kunci fingerprint bulk upload sales receipt (cegah submit ganda) |
| `app/api/idempotency/complete/route.ts` | `POST` | Tandai idempotency key selesai diproses |
| `lib/fuzzySearch.ts` | `fuzzySearch` | Pencarian fuzzy in-memory fallback |
| `lib/pdf-text.ts` | `uppercasePageText` | Uppercase teks untuk header PDF |
| `lib/off-program-control/holidays.ts` | `isHoliday`, `getNextWorkday` | Kalender hari libur untuk kalkulasi deadline |

---

## Data & Config

### Env Config
- **`.env.example`** — template lengkap semua variabel (tidak mengandung secret)
- **`.env.local`** — env aktif lokal (tidak di-commit ke git)

**Variabel kunci:**

| Variabel | Fungsi |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL (`postgres://...`) untuk runtime Next.js |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` | Base URL + secret Better Auth |
| `NEXT_PUBLIC_APP_URL` | URL publik Next.js (browser) |
| `NEXT_PUBLIC_FASTAPI_BASE_URL` | URL Python backend (browser) |
| `ACCURATE_CLIENT_ID` / `ACCURATE_CLIENT_SECRET` | OAuth2 Accurate |
| `ADMIN_SETUP_TOKEN` | Token one-time bootstrap admin pertama |
| `SMTP_*` | Konfigurasi email (host/port/user/pass/from) |
| `SUMOPOD_API_KEY` | AI/OCR backend (opsional) |

### Skema Data (Tabel Inti & Relasi)

```
user ──────────────────────────── session (userId)
  │                                account (userId)
  │                                verification
  │
  └─ [auth only, tidak FK ke domain]

off_batch ──── off_batch_item (batchId)
  │        ├── off_payment (batchId)
  │        ├── off_refund (batchId)
  │        ├── off_notification (batchId)
  │        └── off_audit_log (batchId)
  │
  └─────────── off_period_closure (principleCode + bulan + tahun)

off_discount_submission ─── off_discount_audit_log (submissionId)

claim_workflow (offBatchId -> off_batch.id) [1:1 unique]
  ├── claim_workflow_item (claimWorkflowId)
  ├── claim_payment (claimWorkflowId)
  ├── claim_audit_log (claimWorkflowId)
  └── claim_submission (claimWorkflowId) [1:N, Phase R7+]
        ├── claim_workflow_item.claimSubmissionId
        └── claim_payment.claimSubmissionId

sync_state [checkpoint per modul]
item [cache Accurate items]
customer [cache Accurate customers]
idempotency_log [fingerprint bulk upload]

# Dynamic RBAC (additive — Fase 2/4; user.role & user.permissions TIDAK dihapus)
access_group ──── group_permission (group_id)   [permission_key = "module.action"]
  └──────────── user_group (group_id + user_id)  [akses user = UNION group]
permission_audit_log [siapa ubah group/permission siapa, kapan]
```

**Status Lifecycle offBatch:**
`Draft -> Submitted to SM -> [Returned by SM] -> Approved by SM -> Claim Approved -> Ready for OM -> Approved by OM -> Waiting Payment -> Partial Paid -> Paid -> [Cancelled / Cancelled by OM]`

**Status Lifecycle claimWorkflow:**
`Draft -> In Progress -> Submitted -> Paid -> Partially Paid -> Closed / Overpaid`

### Migrasi & Seed

| File | Fungsi |
|---|---|
| `scripts/init-db.mjs` | Buat semua tabel SQLite dari schema (dev pertama kali) |
| `scripts/migrate-local.mjs` | Jalankan migrasi drizzle-kit lokal |
| `scripts/migrate-opc-columns.mjs` | Migrasi tambahan kolom OPC |
| `db/migrations/` | Output drizzle-kit (SQL migration files) |
| `scripts/seed-opc-dummy.mjs` | 1.275 batch dummy OPC (51 batch x 25 principal, semua 12 problem code) |
| `scripts/migrate-rbac-groups.mjs` | Buat tabel Dynamic RBAC (access_group, group_permission, user_group, permission_audit_log) — additive & idempotent |
| `scripts/seed-rbac-presets.ts` | Sinkron preset Dynamic RBAC termasuk `manage_hierarchy` dan Laporan Harian + backfill user_group (`node --experimental-strip-types`) — PostgreSQL, idempotent |
| `scripts/sync-insentif-hierarchy.mjs` | Upsert assignment SPV→Sales dan SM→SPV dari target periode terbaru; tidak menebak identitas akun login |

### Output & Runtime Artifacts

| Path | Isi |
|---|---|
| `sqlite.db` | Snapshot/sumber migrasi dan rollback SQLite lama; bukan runtime route Next.js setelah D4 |
| `runtime/off-program-control/` | PDF pengajuan OPC |
| `runtime/claim-workflow/` | PDF surat klaim, summary, kwitansi, per-submission |
| `runtime_logs/` | Log runtime (dipakai Python backend) |
| `webhook_events.log` | Log event webhook Accurate (append-only) |

---

## External Integrations

| Service | Tipe | Modul Pemangil |
|---|---|---|
| **Accurate Online ERP** | REST API (OAuth2, Bearer token) | `lib/sync.ts`, `app/api/proxy/route.ts`, `app/api/auth/callback/route.ts` |
| **Accurate Webhook** | Inbound HTTP POST (IP whitelist) | `app/api/webhook/accurate/route.ts` |
| **SMTP Email** | Outbound (nodemailer) | `lib/email.ts` <- `lib/auth.ts` (reset/verifikasi) |
| **Elasticsearch** (opsional) | REST search index | `lib/off-program-control/search.ts` <- `app/api/off-program-control/batches/route.ts` |
| **SumoPod AI / OpenAI** (opsional) | LLM/OCR API | `python_backend/main.py` (validator + dokumen) |

---

## Insentif Sales — Kalkulasi Insentif

UI Finance di `app/(dashboard)/insentif-sales/page.tsx` memakai key seleksi `salesCode::principle`, memproses pembayaran dengan `Promise.allSettled`, mempertahankan pilihan yang gagal, dan membedakan error API dari status `belum`.

Dua model insentif hidup berdampingan, dipisah oleh `channel`:

| Model | Berlaku | Logic | File |
|---|---|---|---|
| **Strata-DB** (4 KPI: Value/EC/AO/IA, rata-rata) | tidak dipakai lagi untuk insentif (achievement 4-KPI tetap jalan) | `lookupTierFromDb` (tabel `incentive_tiers`) | `lib/insentif-sales.ts` |
| **Konstanta-bobot** (2 KPI: AO 70% + Value 30%) | channel **GT dan TT** (sinonim) | `computeExclusive` / `computeMix` (pure) | `lib/insentif-sales-calc.ts` |
| MT (belum ada aturan insentif) | channel **MT** | insentif selalu 0 | `dashboard/route.ts` |

Konstanta-bobot (GT):
- Pengali %: `<0.90→0`, `0.90–1.00→aktual`, `>1.00→cap 1.00`. Target AO konstan **240**.
- Distributor bayar = `konstanta − total_support` (floor 0), split 70/30 × pencapaian.
- **Exclusive** (1 principle): konstanta 1jt. **Mix** (n principle): 2=1jt, 3=1.2jt, 4=1.4jt, 5=1.5jt (cap). Value mix global → dialokasikan proporsional `target_value` per principle.
- **Status Insentif** (`distributor_principle`/`distributor`/`principle`): hanya 2 pertama ikut skema & masuk count; `principle` (full principle, mis. Motasa/Heinz) tidak dihitung. **Tipe Sales** (`mix`/`exclusive`) di kolom target.
- Kolom DB: `sales_targets.tipe_sales`, `sales_targets.status_insentif`. Support per `salesCode+principle+period` di tabel **`incentive_support`** (diisi Finance saat payout).

Alur: target Excel (kolom Tipe Sales + Status Insentif, kunci upsert `salesCode+principle+period`) → `dashboard/route.ts` (GT pakai calc baru, non-GT strata; achievement 4-KPI tetap untuk semua) → Finance input support (`/api/insentif-sales/support`) → dashboard hitung ulang.

Self-check: `node --experimental-strip-types lib/insentif-sales-calc.test.ts` (Case 1 exclusive=300rb, Case 2 mix=500rb sebagai angka acuan).

### Insentif SPV — Strata Value (`lib/insentif-spv-calc.ts`)

Terpisah dari insentif Sales — **murni berbasis Value** (tidak ada komponen AO). Pure calc, **belum di-wire** ke route/UI manapun (belum ada tabel/route target-SPV — SPV tidak punya target sendiri, dihitung on-the-fly dari agregat sales bawahan via `spv_name` teks bebas di `sales_targets`, lihat catatan hierarki di bawah).

- `calculateInsentifSPV(rows: SpvSalesRow[])`: group baris sales per `principle`, SUM `targetValue`/`realisasiValue` lintas channel (GT/TT/MT — cakupan bisnis SPV, bukan skema insentif per-Sales).
- Principal valid (masuk count) jika **minimal 1 baris sales bawahan** berstatus skema (`distributor`/`distributor_principle`, reuse `isSchemePrincipal` dari `lib/insentif-sales-calc.ts`) — bukan seluruhnya `principle` (full principle).
- Rate per principal (`ratePerPrincipalSpv`): n=1 → flat Rp1.500.000 (kasus khusus). n≥2 (termasuk ekstrapolasi n>6) → `Total(n) = 1.200.000 + 200.000×n`, `rate = Total(n)/n`. Cocok persis ke tabel given n=1..6 (1.5jt/800rb/600rb/500rb/440rb/400rb per principal).
- Threshold pencapaian: reuse `percentageMultiplier` (sama seperti Sales) — `<0.90→0`, `0.90–1.00→aktual`, `>1.00→cap 1.00`.
- Insentif_n = rate × pctValue; Total = sum(Insentif_n).

Self-check: `node --experimental-strip-types lib/insentif-spv-calc.test.ts` (total n=1..6 tervalidasi ke tabel given, n=7/10 ekstrapolasi, SUM lintas sales, exclude campur status).

**Wiring:** [GET /api/insentif-sales/spv-dashboard](app/api/insentif-sales/spv-dashboard/route.ts) — group `sales_targets` per `spv_name` (teks bebas), SUM realisasi via `computeMtdByPrinciple`, panggil `calculateInsentifSPV`. Tampil di UI sebagai `SpvIncentiveTable` pada tab SPV (`page.tsx`, expand-per-principal).

### Hierarki SM → SPV → Sales (Bagian C — aktif sebagai override/fallback)

Tabel additive di `db/schema.ts`: `spvSalesAssignment` (`sales_code` UNIQUE → `spv_name`) dan `smSpvAssignment` (`spv_name` UNIQUE → `sm_name`). Key masih teks bebas (bukan FK ke `user.id`) — konsisten dgn `sales_targets.spv_name`/`sm_name` yang sudah ada, karena SPV/SM belum tentu punya akun login.

- CRUD: [/api/insentif-sales/hierarchy/spv-sales](app/api/insentif-sales/hierarchy/spv-sales/route.ts), [/api/insentif-sales/hierarchy/sm-spv](app/api/insentif-sales/hierarchy/sm-spv/route.ts). GET pakai `insentif_sales.view`; POST/DELETE pakai **`insentif_sales.manage_hierarchy`**, terdaftar di registry dan preset Admin/Admin Sales.
- UI: `HierarchyAssignmentSection` di `AdminView` (page.tsx) — 2 mini-form assign + list + hapus.
- Dashboard SPV dan row-level scope membaca assignment sebagai override, lalu fallback ke `sales_targets.spv_name/sm_name`. `scripts/sync-insentif-hierarchy.mjs` mengisi assignment awal dari target terbaru secara idempotent.
- Akun login dapat ditautkan melalui `user.hierarchyRole/hierarchyName`; null berarti belum discoping. Link akun tetap manual agar nama SPV/SM tidak ditebak.
- Dashboard utama menerima periode `month/year` dari URL dan menyediakan input bulan; pace historis=100%, masa depan=0%, bulan aktif mengikuti hari kerja berjalan.

---

## History Penjualan (Sales History)

Halaman browse riwayat penjualan dari data **Data_Penjualan** internal (2022-2025, jutaan baris item) plus mapping customer. Cascade aktif: **Tahun -> Principal -> Customer/Toko**; hanya referensi **INV/** yang ditampilkan (RJN/SRT dikeluarkan). **No Faktur** tampil sebagai row tabel faktur, lalu klik row membuka detail transaksi dengan qty+satuan dan diskon ganda (%/Rp).

**DB terpisah:** `sales-history-inv.db` (env `SALES_HISTORY_DATABASE_URL`, default `file:sales-history-inv.db`) - diisolasi dari `sqlite.db` ERP agar backup ERP tetap ramping. Tabel:
- `sales_history_item` (flat, 1 row/item dari `Data_Penjualan/**.xlsx`, termasuk qty+satuan), index `referensi`/`tanggal`/`customer_nama`/`source_file`.
- `customer_map` (kode -> nama, alamat, kota) dari `Mapping_Customer.xlsx` (sumber otoritatif nama/alamat). Kolom `region`/`npwp` dibuang 2026-06-27 (tak dipakai di kode mana pun; backup `sales-history-inv.db.bak`).
- `invoice_map` (referensi=NO_NOTA -> kode_cust, principal, tanggal) dari `Data_Penjualan/**.xlsx`, kolom `salesman` dibuang 2026-06-27 (tak dipakai), index `principal`/`kode_cust` plus composite `principal+kode_cust`, `principal+tanggal`, `kode_cust+tanggal`, `kode_cust+principal+tanggal`, `tanggal+principal`, dan `tanggal`.

Full rebuild besar memakai `scripts/build-sales-history-staging.mjs`: strategi latest-wins dari file mtime terbaru ke terlama, filter hanya `INV/`, skip referensi lama yang sudah muncul di file terbaru, lalu create index di akhir. `scripts/import-sales-mapping.mjs` tetap ada untuk incremental/backfill kecil dan opsional Elasticsearch, bukan jalur utama rebuild penuh.

**Cascade penuh:** Tahun -> Principal -> Customer/Toko -> tabel faktur -> detail. Dropdown bersumber dari `invoice_map`/`customer_map` (kecil, terindeks); seluruh read path membatasi `referensi LIKE 'INV/%'`. Tabel faktur membaca `invoice_map` + agregat `sales_history_item`; detail item dari `sales_history_item` hanya saat 1 faktur dipilih. Filter tahun memakai range `tanggal >= yyyy-01-01 AND tanggal < yyyy+1-01-01`, bukan `substr()` di WHERE, agar index tanggal tetap efektif. Join: `sales_history_item.referensi` = `invoice_map.referensi` = `NO_NOTA` (`INV/2401/AB0001`). Nama/alamat customer dari `customer_map` (data penjualan tidak ter-update). Search produk memakai Elasticsearch index `ELASTICSEARCH_SALES_HISTORY_INDEX` bila tersedia; fallback lokal memakai SQLite `LIKE` page refs tanpa count exact dan menandai `totalApproximate`.

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/sales-history/parse.ts` | `parseEfakturLines`, `splitCsvLine`, `parseFkContext`, `parseOfItem`, `parseIdrDate` | Parser pure CSV e-Faktur (FK/FAPR/OF). FAPR=penjual dan baris legenda di-skip. Self-check: `node --experimental-strip-types lib/sales-history/parse.ts` |
| `lib/sales-history/db.ts` | `salesDb`, `salesClient`, `salesHistoryItem`, `customerMap`, `invoiceMap`, `ensureSalesHistorySchema` | Klien libsql + Drizzle DB terpisah; schema idempotent (CREATE IF NOT EXISTS) |
| `lib/sales-history/service.ts` | `getSalesHistoryDatabaseStatus`, `listSalesHistoryYears`, `listSalesHistoryPrincipals`, `listSalesHistoryCustomers`, `listSalesHistoryInvoices`, `listSalesHistoryItems` | Service backend DB Sales History: status, cascade, tabel faktur, detail item, pagination, fallback SQLite product search |
| `lib/sales-history/search.ts` | `searchSalesHistoryRefsWithElasticsearch`, `ensureSalesHistoryElasticsearchIndex`, `bulkIndexSalesHistoryDocuments`, `getSalesHistoryElasticsearchStatus` | Adapter product search + backend indexing Elasticsearch via REST; **dormant** bila `ELASTICSEARCH_URL` unset → jatuh ke fuzzy SQLite |
| `lib/sales-history/fuzzy.ts` | `damerau`, `wordMatches`, `resolveFuzzyProduct`, `invalidateProductVocabulary` | Fuzzy product search toleran-typo (Damerau-Levenshtein di kamus nama unik ~11rb) pengganti Elasticsearch; dipakai `service.ts` via IN-clause berindeks. Self-check: `node lib/sales-history/fuzzy.ts` (#5) |
| `app/api/sales-history/route.ts` | `GET` | Root status backend: kesiapan DB, count customer/faktur/item, tahun, dan status Elasticsearch. Guard `sales_history.view` |
| `app/api/sales-history/import/route.ts` | `POST` | Impor CSV streaming (memori terbatas), idempotent per `source_file`. Guard `sales_history.manage` |
| `app/api/sales-history/years/route.ts` | `GET` | Daftar Tahun (cascade L1) dari invoice_map. Guard `sales_history.view` |
| `app/api/sales-history/principals/route.ts` | `GET` | Daftar Principal (cascade L2), opsional filter tahun. Guard `sales_history.view` |
| `app/api/sales-history/customers/route.ts` | `GET` | Customer per Tahun/Principal (cascade L3), join customer_map (nama/alamat fresh). Guard `sales_history.view` |
| `app/api/sales-history/invoices/route.ts` | `GET` | Tabel faktur dari invoice_map+customer_map+agregat item, filter tahun/principal/kodeCust/product. Product search: Elasticsearch lalu SQLite fallback. Guard `sales_history.view` |
| `app/api/sales-history/items/route.ts` | `GET` | Detail item per REFERENSI (equality terindeks). Guard `sales_history.view` |
| `app/api/sales-history/search-index/route.ts` | `GET`, `POST` | Backend operasional Elasticsearch: status index dan bulk indexing cursor-based dari `sales-history-inv.db`. Guard `sales_history.manage` |
| `scripts/build-sales-history-staging.mjs` | script | Full rebuild DBA-grade: latest-wins, filter hanya `INV/`, skip duplikat lama sebelum insert item, lalu create index di akhir; output timestamped di `runtime/sales-history-build*`. |
| `scripts/import-sales-mapping.mjs` | script | Legacy/incremental backfill customer_map, invoice_map, sales_history_item untuk referensi `INV/` saja, termasuk satuan item; opsional bulk index Elasticsearch. Bisa dibatasi dengan `SALES_HISTORY_IMPORT_YEAR` / `SALES_HISTORY_IMPORT_FILE`, tapi tidak dipakai untuk rebuild penuh jutaan baris. |
| `app/(dashboard)/sales-history/page.tsx` | `SalesHistoryPage` | Cascade UI Tahun -> Principal -> Customer/Toko + search produk + tabel faktur INV + detail item fixed-layout qty+satuan |

RBAC: module `sales_history` (`view`/`export`/`manage`) di `lib/rbac/registry.ts` + `lib/rbac.ts` (appModules, pagePermissions `/sales-history`, preset), menu sidebar `History Penjualan`.

---

## Laporan Harian per SPV/SM (Daily Report Pipeline) — IMPLEMENTED (Tahap 0–4)

> UI dan API aktif pada route existing. Menggantikan pipeline Excel lama (Power Query `2.3 To SPV dan SM New.xlsx` + `generate_laporan_from_sheets.exe` + `kirim_laporan_gui.exe`).
> Tujuan: **1 kali upload → laporan per SPV/SM (email) + feed dashboard sales**, tanpa buka Excel.

**Masalah lama (terukur):** refresh Power Query ~15–20 mnt + generate ~15 mnt (~35 mnt total). Sebab utama audit:
- Query `SalesBase` (baca `2. To Format Laporan.xlsx` = 132.120 baris × 63 kol; 8 `Table.NestedJoin` + 5 `Table.Group`) **dihitung ulang 22×** karena 22 query pakai `Source = SalesBase` **tanpa `Table.Buffer`**.
- Semua data di-load ke worksheet (bukan Data Model) → file **86 MB**, .xlsx (XML). 0 formula/0 conditional-format di sheet besar → recalc/volatile BUKAN penyebab.

**Alur target:**
```
UI: modul /laporan-harian
  -> POST /api/laporan-harian/upload  (multipart: penjualan wajib, retur dan stock opsional)
     -> requirePermission("laporan_harian.upload")
     -> teruskan ke python_backend FastAPI: POST /laporan-harian/process
        -> pandas replika logika Power Query SalesBase:
           merge flag AO/EC/IA, Nota Retur/Batal, map Golongan(SPV)+NAMA SM, Kategori Baru
        -> output: (a) rows per SPV & per SM, (b) rows stock per SPV, (c) agregat progress harian
     -> tulis file per-SPV/SM ke runtime/laporan-harian/<tanggal>/
     -> feed dashboard: BULK upsert ke sales_daily_progress (batch, hindari N+1)
  <- { ok, runId, ringkasan per SPV, daftar penerima (PREVIEW, belum kirim) }
UI: tombol "Kirim" terpisah (gated, confirm:true) -> POST /api/laporan-harian/[runId]/send
     -> requirePermission("laporan_harian.send") -> claim status `sending`
     -> ambil file per-SPV/SM dari backend -> kirim email (nodemailer)
     -> penerima `failed` dapat di-retry tanpa mengirim ulang penerima yang sudah `sent`
```

State machine pure: `lib/laporan-harian/send-state.ts`; self-check:
`node --experimental-strip-types lib/laporan-harian/send-state.test.ts`.

---

## Dokumen Perencanaan (docs/)

| Path | Isi |
|---|---|
| `docs/prd/00-overview.md` | Peta visi Ops Control Tower dari 11 poster (`poster/`) + rantai dokumen lintas divisi |
| `docs/prd/01..10-*.md` | PRD per divisi: Audit, Incaso, Claim, Sales, Admin Gudang, Delivery, Gudang, Management Dashboard, Control Center, Fakturist — angka poster FIKTIF |
| `docs/audit/findings.md` | Fase B: gap vs PRD + tantangan atas kode yang sudah jalan (baseline, klaim, rollback, ranking) |

---

## Risks / Blind Spots

| Area | Catatan |
|---|---|
| **Python backend integrasi Next.js** | Tidak ada shared session antar Next.js dan FastAPI. FastAPI punya auth sendiri (`auth.py`); sinkronisasi user hanya via filesystem/env, bukan DB shared. |
| **Elasticsearch optional** | Jika env tidak di-set, search fallback ke in-memory fuzzy. Perilaku ini tidak eksplisit diuji di test script. |
| **PPh HOLD** | Kolom PPh disiapkan di schema tapi perhitungan final ditahan (`// PPh HOLD` tersebar di beberapa file). Belum aktif secara bisnis. |
| **Phase R7 (Multi No Claim)** | Fitur `claim_submission` tabel (R7a+) masih dalam rollout bertahap. Phase R7b-R7k tercakup di `scripts/test-r7*.mjs` tapi belum semua route production-ready. |
| **Webhook Accurate** | (Dikoreksi audit 2026-07-12) IP whitelist AKTIF & fail-closed (`route.ts:11-16`). Masalah sebenarnya: webhook hanya append `webhook_events.log` — tidak memicu proses apa pun (logger buntu). |
| **`lib/sync.ts`** | (Fix F2/F3 2026-07-12) Hidup: registry 4 modul (item/customer/sales_invoice/sales_return), upsert `onConflictDoUpdate`, watermark `lastSyncTimestamp`. Dipicu `GET /api/cron/sync-accurate` (Bearer CRON_SECRET) via cron VPS 4×/hari. **Prasyarat: minimal 1 login OAuth Accurate di production** (`accurate_oauth_session` masih 0 baris) atau set `ACCURATE_SYNC_USER_ID`. |
| **`config/`** | Folder berisi data statik (principles, dll) — tidak ter-trace penuh karena bukan TypeScript eksportabel; kemungkinan JSON/YAML. |
| **`runtime/` path** | `GET /api/cron/cleanup-runtime` membersihkan artefak regenerable dengan retensi terdaftar; arsip PDF OPC/claim sengaja dikecualikan. Production tetap memerlukan scheduler eksternal dan `CRON_SECRET`. |
| **`app/(dashboard)/finance/page.tsx`** | Memanggil Python FastAPI backend langsung via `NEXT_PUBLIC_FASTAPI_BASE_URL`. Jika backend mati, halaman finance tidak berfungsi. |
| **D4 env/deploy belum sinkron** | Kode DB sudah PostgreSQL, tetapi `.env.local`, `.env.example`, Docker Compose, dan Dockerfile masih default `file:sqlite.db`. Local/deploy wajib memakai `DATABASE_URL=postgres://...`; tanpa itu route ber-DB tidak operasional. |
| **`rekprinciple.xlsx`** | File Excel di root — tidak jelas apakah dipakai runtime atau hanya referensi manual. |
| **Laporan Harian: stock Accurate & openpyxl** | File stock export Accurate tidak terbaca `openpyxl` (perlu `python-calamine` terpasang di server). |

---

## Summary Promo Editor (Manual) — `/summary`

On-demand (bukan cron). UI `app/(dashboard)/summary/page.tsx` hanya proxy tampilan; **semua logic di Python FastAPI**, tanpa DB. Alur: load Master Barang → upload surat PDF → ekstrak (Regex atau AI OCR) → edit grid → generate **Form PDF + Dataset Diskon xlsx** → download/email. Cache master & output = dict **in-memory** (`MANUAL_MASTER_CACHE`/`MANUAL_OUTPUTS`, hilang saat restart / pecah bila uvicorn multi-worker).

| Endpoint (`python_backend/main.py`) | Peran |
|---|---|
| `POST /summary/manual/master/upload` (6727), `load_principle/{pid}` (7355) | Parse `MASTER BARANG` → kelompok/variant/gramasi/items |
| `POST /summary/manual/parse_pdf_ai` (7584) | OCR gemini **per-halaman** → parse JSON deepseek → `_apply_native_kelompok` |
| `POST /summary/manual/parse_pdf_regex` (7403) | Regex `PROID-`; **guard**: PDF scan tanpa teks ditolak (bukan 0 baris diam) |
| `POST /summary/manual/generate` (6805) | Match item→master (dedupe by kode), consolidate, build Form PDF + Dataset xlsx |

**Audit 2026-07-08 (fix terpasang):** (4) dedupe Kode Barang kembar cegah baris/TIER_NO dobel; (2) filter principle diperbaiki (keyword match, bukan no-op); (5a) cap `doc[:10]`→`SUMMARY_MAX_OCR_PAGES`(40)+warning; (5b) OCR single-call (mentok `finish_reason=length`, buang ~12% teks) → **per-halaman** (finish=stop). Env: `SUMOPOD_OCR_MODEL` (default `gemini/gemini-2.5-flash`), `SUMOPOD_MODEL` parse (default `deepseek-v4-pro`).
