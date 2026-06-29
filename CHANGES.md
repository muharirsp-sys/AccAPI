# CHANGES — Remediation Audit AccAPI

> Disiapkan untuk review & commit manual. BELUM di-commit/push.

## TIER 4 — Housekeeping

| Item # | Apa diubah | File | Checker lulus? | Workflow terpengaruh? |
|---|---|---|---|---|
| #11 | Polish loading/empty state | `app/(dashboard)/validator/page.tsx` (panel proses), `app/(dashboard)/form-kontrol/page.tsx` (empty state) | ✅ `tsc --noEmit` 0 error | Tidak |
| #12 | Redirect senyap → pesan "Akses ditolak" eksplisit | `components/AccessDenied.tsx` (baru), `app/(dashboard)/layout.tsx`, `admin/users/page.tsx`, `admin/groups/page.tsx` | ✅ `tsc --noEmit` 0 error | Tidak |

### Catatan #11
- **Validator**: dulu hanya tombol disabled "Memproses Data…". Ditambah panel proses menonjol (spinner + pesan) saat `isProcessing`, karena engine Python bisa lama. Summary sudah punya state `isPdfParsing`; form-kontrol sudah punya spinner `scopeLoading`.
- **Form-Kontrol**: kotak konten blank bila `visibleTabs` kosong (peran tanpa modul) → ditambah pesan empty-state.

### Catatan #12
- Komponen reusable `AccessDenied` (pesan + tombol kembali). Dipakai di guard pusat `layout.tsx` (render **di dalam** SidebarLayout, user tetap bisa navigasi) menggantikan `redirect("/")` senyap; plus `admin/users` & `admin/groups` (guard permission).
- `redirect("/login")` untuk no-session tetap dipertahankan.

### Catatan #13–#15 (diperiksa — TIDAK diubah)
- **#13 Sunset RBAC legacy**: `resolve.ts` UNION group ∪ legacy "selama transisi". Hapus = risiko patahkan akses user belum migrasi. **Pertahankan.**
- **#14 Webhook Accurate**: `app/api/webhook/accurate/route.ts` sudah punya IP allowlist fail-closed. **Bukan celah**; tak perlu aksi.
- **#15 `parse_pdf_ai`**: dipicu tombol terpisah (`handlePdfExtract('ai')`), **bukan default**. Premis audit keliru. **Tak perlu aksi.**

### Item ditunda/skip (disetujui user)
- **#8** Split OPC 11k baris — skip (manfaat tipis: akses sudah per-role, hanya hemat unduhan bundle).
- **#9** Split claim-workflow — ditunda (monolit 2.7k baris, lebih berisiko dari #8).
- **#10** Phase R7 (Multi No Claim) — skip ("skip saja dulu").

### Rencana commit (dieksekusi sesi ini, push ke origin/main)
1. `fix(perf)` #1,#4,#6 · 2. `feat(reliability)` #2 error boundary · 3. `refactor(python)!` #7 headless API · 4. `feat(ux)` #11,#12 · 5. `chore` gitignore+SYSTEM_MAP+CHANGES · 6. `feat(sales-history)` fitur Sales History + #5 fuzzy.
- **Hardblock**: `.gitignore` diperbarui cover `*.rar *.exe *.apl *.bak* *.db-wal/-shm/-journal` + `runtime/` (folder rebuild DB) → file data raksasa (`sales-history-inv.db.bak` 2,3GB, `.bak2`, dll.) tak masuk git.

### Integrasi merge dengan origin/main (push 55eaf0c)
- Saat push, `origin/main` sudah maju 1 commit: `99f2474 fix: payments race condition` (sesi paralel). Konflik di `python_backend/main.py` + `app/(dashboard)/payments/page.tsx`.
- **Temuan**: commit #7 lokal **tak sengaja menyertakan draft race-fix payments** (`_PAYMENTS_DB_LOCK`×9, `touch_payment_record`, `payment_write_timestamp`, `payments_conflict_response`) yang sudah ada sbg uncommitted di working tree saat sesi mulai — bukan hasil kerja #7.
- **Resolusi (disetujui user)**: `main.py` di-rekonstruksi = **versi payments origin (race-fix final, `_PAYMENTS_DB_LOCK`×13) + strip auth/HTML #7**; draft payments lokal dibuang. `page.tsx` = gabung (`pageOverride` #4 + `useEffect` anti-stale origin). Verifikasi: `py_compile` OK, `tsc` 0 error, auth/HTML symbol 0, draft helpers 0.

## TIER 3 — Refactor Berisiko (per-item, butuh izin)

| Item # | Apa diubah | File | Checker lulus? | Workflow terpengaruh? |
|---|---|---|---|---|
| #7 | **Hapus auth paralel Python** (scope **Auth-only**, disetujui user). Backend kini hanya menerima identitas via sesi Better Auth. | `python_backend/main.py` | ✅ `py_compile` OK; 0 referensi tersisa ke simbol terhapus | Tidak (approval chain & RBAC Better Auth tak disentuh) |

### Catatan #7 (Auth-only — disetujui user)
- **Temuan arsitektur**: FastAPI publik di `https://web-super.online/fastapi`, dipanggil Next.js sbg JSON API. `get_current_user()` sudah memvalidasi sesi Better Auth (cookie `better-auth.session_token` → `sqlite.db` bersama). Jalur kedua (token Python + `users.json` + env `AUTH_USERS`) = auth paralel lebih lemah (sha256 tanpa salt / fallback plaintext), terbuka ke internet, mem-bypass RBAC Next.js → **itu lubangnya**.
- **Yang dihapus** (15 blok, 429 baris):
  - `get_current_user`: cabang legacy-token dibuang → **hanya Better Auth**.
  - `get_auth_user_records`: dinetralkan → selalu `{}` (mematikan `users.json` + env `AUTH_USERS` sbg sumber kredensial/role di satu titik).
  - Route: `/login`(GET+POST), `/api/login`, `/logout`, `/change-password`(GET+POST), `/users`(GET), `/users/save`, `/users/delete`, `/api/users`, `/api/users/save`, `/api/users/delete`.
  - Helper: `verify_user`, `make_token`, `validate_token`.
- **Dipertahankan**: `/api/me` (mint cookie CSRF utk Next.js), `/api/logout`, semua endpoint JSON data, mesin CSRF, `user_has_permission`/`get_user_role`/`get_user_permissions_info` (jalur `betterauth|` tetap utuh).
- **Tidak hilang fitur**: `/validator`, `/summary`, `/payments` versi Next.js sudah ada & panggil JSON API yang tetap hidup. Next.js terverifikasi **tak** memanggil route yang dihapus (hanya `/api/me` + `/api/logout`).
- **Piece 2 — SELESAI (Python kini headless JSON API)**: dead-code HTML/template dihapus (24 blok, **3.288 baris**) via codemod `ast`:
  - Route HTML view (7): `/`, `/validator`, `/summary`, `/payments`, `/payments/finance`, `/payments/cart/{draft_id}` (GET), `/summary/manual` (GET) — semua sudah ada versi Next.js; sub-route JSON (`/summary/manual/generate`, `/master/options`, `/download/*`, `/payments/cart/submit`, `/cart-info`, dll.) **tetap utuh** (codemod hanya target route ber-`response_class=HTMLResponse`).
  - Template konstanta (8): `HOME_HTML`, `SUMMARY_HTML`, `PAYMENTS_HTML`, `PAYMENTS_CART_HTML`, `FINANCE_HTML`, `LOGIN_HTML`, `CHANGE_PASSWORD_HTML`, `USERS_HTML`.
  - Fungsi (9): `render_ui`, `render_html_with_csrf`, `login_bg`, + cluster helper password mati `parse_auth_users`, `load_users_json`, `save_users_json`, `detect_password_scheme`, `hash_password`, `verify_password_hash`.
  - Import mati `from ui_templates import inject_world_class_ui` dihapus; file `python_backend/ui_templates.py` dihapus.
  - **CSRF tetap utuh** (`make_csrf_token`/`validate_csrf_request`/`get_or_create_csrf_token` dipakai `/api/me` + JSON POST).
  - Verifikasi: `py_compile` OK (2×: setelah strip + setelah hapus import) · grep 0 referensi yatim ke 18 simbol terhapus · endpoint JSON kunci (`/api/me`, `/api/logout`, `/payments/data`, `/summary/manual/*`, `/api/principles`, `/validate`) terkonfirmasi selamat.
  - Total #7: `main.py` 12.242 → **8.525 baris** (−3.717) + `ui_templates.py` dihapus.
- **Reality-Checker (jujur)**: terverifikasi = `py_compile` lulus + grep 0 referensi tersisa ke simbol terhapus + route penting (`/api/me`, `/api/logout`, dll.) selamat. TIDAK dijalankan = uji auth live (app menyala + login Better Auth + hit endpoint). Mekanik terbukti; uji runtime bisa terpisah bila diminta.

## TIER 2 — Performance & Reliability

| Item # | Apa diubah | File | Checker lulus? | Workflow terpengaruh? |
|---|---|---|---|---|
| #4 | Server-side pagination + filter (`q`, `tipe`, `page`, `page_size`) pada `/payments/data`. Early-exit filter sebelum formatting mahal. Frontend refetch on page/pageSize change, `serverTotal` state drive page count. | `python_backend/main.py`, `app/(dashboard)/payments/page.tsx` | ✅ typecheck 0 error; backward-compat (tanpa `page` param = return all) | Tidak (read-only list view) |
| #5 | **ES → fuzzy SQLite** (Sales History). Edit-distance Damerau-Levenshtein di kamus nama unik (11rb), bukan FTS5/spellfix1. | `lib/sales-history/fuzzy.ts` (baru), `lib/sales-history/service.ts` | ✅ typecheck 0 error; self-check lulus; **bukti nyata 4.5jt row** | Tidak |
| #6 | **Optimistic locking STRICT** pada PATCH item pajak (DPP/PPN/PPh). Client wajib kirim `expectedUpdatedAt`; backend pre-check + UPDATE bersyarat. | `app/api/claim-workflow/[id]/items/[itemId]/route.ts`, `app/(dashboard)/claim-workflow/[id]/page.tsx` | ✅ typecheck 0 error; mekanik lock terbukti (stale→409, fresh→sukses) | Tidak (hanya edit nilai saat Draft/Need Revision; state-machine approval tak disentuh) |

### Catatan #6 (STRICT — disetujui user)
- **Target nyata**: `PATCH /api/claim-workflow/[id]/items/[itemId]` (edit DPP/PPN/PPh) — hotspot dua editor saling timpa. `[id]/route.ts` ternyata **hanya GET** (tak ada PATCH free-form); perubahan workflow-level lewat endpoint state-machine (status/no-claim/submissions) yang sudah dijaga cek status — bukan edit nilai bebas, jadi di luar scope locking ini.
- **STRICT**: body tanpa `expectedUpdatedAt` → **400** (`VERSION_REQUIRED`). Versi tak cocok `item.updatedAt` → **409** (`CONFLICT`).
- **Anti-TOCTOU**: selain pre-check, UPDATE di dalam transaksi diberi syarat `WHERE updatedAt = expectedDate`; bila `rowsAffected=0` (penulis lain menyelip) → `OptimisticLockError` → rollback → 409. Terbukti di test in-memory libSQL (stale=0, fresh=1).
- **Frontend** (`page.tsx`): dua call-site PATCH item (`saveEdit` inline + `saveExcelRow` mode Excel) kini mengirim `expectedUpdatedAt` dari `item.updatedAt`. Type `WorkflowItem` ditambah `updatedAt`. Pesan 409 menginstruksikan user muat ulang.
- **Reality-Checker (jujur)**: uji konkurensi 2-request live di server berjalan TIDAK dijalankan (butuh app+DB+login). Yang diverifikasi: typecheck 0 error + mekanik SQL conditional-update/rowsAffected + round-trip timestamp. Mekanik inti terbukti; integrasi penuh bisa diuji terpisah bila diminta.

### Catatan #5 (REVISI dari rencana awal — disetujui user)
- **Rencana awal "FTS5 trigram + spellfix1" DIGANTI** setelah temuan & pertanyaan user. Alasan teknis:
  1. FTS5 **trigram tidak menangani transposisi huruf** (mis. ketik "marei" tak ketemu "marie") — gagal memenuhi kebutuhan user.
  2. spellfix1 = extension native, butuh compile per-platform, `@libsql/client` tak dukung bersih.
- **Insight kunci**: 4.540.827 baris, tapi **nama produk unik hanya 11.239** (+ 7.068 kode objek). Fuzzy edit-distance cukup jalan di kamus kecil ini, lalu map balik via `IN`-clause berindeks (`idx_shi_nama_produk`).
- **Implementasi**: `lib/sales-history/fuzzy.ts` — Damerau-Levenshtein (transposisi = 1 op) + ambang gaya ES `fuzziness:AUTO` + match prefix/substring. Kamus di-cache in-memory (TTL 10 menit, refresh otomatis ikut data baru). `service.ts`: dua fallback SQLite (`sqliteProductRefs` + item-search) ganti `LIKE '%x%'` (full-scan) → `resolveFuzzyProduct` → `IN`.
- **ES tidak dihapus** — jadi dormant. `search.ts:210` return null bila `ELASTICSEARCH_URL` unset → jatuh mulus ke fuzzy. **Matikan ES = unset `ELASTICSEARCH_URL` + stop proses JVM.** Hemat RAM VPS tanpa hapus kode.
- **OPC search**: TIDAK disentuh (data kecil; substring fallback `matchesSearch()` sudah cukup). FTS5 di OPC = bloat.
- **Bukti nyata (DB 4.5jt row)**: `"marei susu"` → "MARIE SUSU 120 X 24GR..." (12ms); `"minyak gorng"` → "MINYAK GORENG ROSEBRAND..." (12ms); transposisi `"3r01"→"3r10"` → sample asli ketemu (27ms). Kamus load 1.8s sekali (cache).
- **Trade-off**: ranking relevansi tak sehalus ES BM25; untuk product-search internal, edit-distance + IN sudah memadai.

### Catatan #4
- Backend: filter `q` (haystack: principle+no_lpb+invoice+nomor_dokumen), `tipe` (exact match), `page`/`page_size` (default 100, max 500). Early-exit sebelum format mahal. Response tambah: `total`, `page`, `page_size`.
- Frontend: `fetchData` pass `?page=N&page_size=M`. State `serverTotal` dari `res.data.total`. `useEffect([page, pageSize])` trigger refetch saat navigasi. Mutation handlers (upload, manual-add, delete, clear) panggil `setPage(1) + fetchData({pageOverride:1})`. `paginatedRecords` = `filteredRecords` langsung. Filter kompleks (date, principle multi-select, ajukan, no_lpb) tetap client-side.

---

## TIER 1 — Quick Win

| Item # | Apa diubah | File | Checker lulus? | Workflow terpengaruh? |
|---|---|---|---|---|
| #1 | Fix N+1: status pembayaran dari 1 query/baris → 1 query grouped + `paymentMap` (pola `supportMap`) | `app/api/insentif-sales/dashboard/route.ts` | ✅ typecheck 0 error; query 3+N → 4; response shape identik | Tidak (read-only dashboard) |
| #2 | Tambah error boundary: dashboard segment + root | `app/(dashboard)/error.tsx` (baru), `app/global-error.tsx` (baru) | ✅ typecheck 0 error; no-stack-leak by construction (lihat catatan) | Tidak |
| #3 | Review PPh "HOLD" → **TIDAK dihapus** (lihat alasan) | — | ✅ (keputusan: skip, lapor) | Tidak |

### File baru
- `app/(dashboard)/error.tsx` — error boundary segmen dashboard (client; render pesan rapi + tombol "Coba lagi"; tidak render stack).
- `app/global-error.tsx` — root error boundary (render `<html>/<body>` sendiri).

### Perubahan DB
- Tidak ada.

### Dependency dihapus
- Tidak ada.

### Catatan per item
- **#1**: Sebelumnya `targets.map(async t => await db.select(incentivePayments)...)` = 1 query payment per baris target (N+1). Sekarang semua payment periode di-load 1 query di `Promise.all` awal, dibangun ke `paymentMap` keyed `salesCode|principle`, lookup di map. Query turun dari **3+N → 4**. Asumsi: 1 payment per (salesCode, principle, periode) — sama dgn perilaku lama yang pakai `.limit(1)`. Jika ada duplikat (tak diharapkan), lama ambil "first by default order", baru ambil "last in result" — keduanya sama-sama arbitrer; tidak mengubah kasus normal.
- **#2**: `error.message`/`stack`/`digest` **tidak pernah** di-render ke UI (hanya `console.error`) → zero stack-leak by construction. Verifikasi live (trigger throw via browser) TIDAK dijalankan: route dashboard auth-gated (butuh login flow penuh), mahal & berisiko di batas context. Bila diminta, bisa dilakukan terpisah.
- **#3**: Klaim Fase 5 ("PPh HOLD = dead code, 16 occ") **keliru** — grep `HOLD` mencampur "Kwitansi HOLD". Faktanya: PPh **live** di `lib/claim-workflow/calculations.ts` (`pphAmount`, `nilaiKlaim`), schema `pphRate/pphAmount/totalPph` `.notNull()`, UI input "PPH %". Satu-satunya "HOLD" asli = 3 kolom nullable PPh level item OFF batch (kalkulasi ditahan) — menghapusnya = migrasi **destruktif** demi nyaris nol manfaat. **Tidak dihapus.**

### Workflow Update
- Tidak ada perubahan perilaku workflow (approval chain SPV→SM→CLAIM→OM→KEUANGAN tak tersentuh).
