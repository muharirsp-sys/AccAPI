# FASE B — Audit Findings: Gap vs PRD + Tantangan atas Kode yang Sudah Jalan

| Doc | Nilai |
|---|---|
| Sumber | 3 agent audit paralel (Database Optimizer, Backend Architect, Reality Checker), semua **read-only** — tidak ada kode/DB diubah |
| Basis bukti | Grep/read kode + `EXPLAIN QUERY PLAN` + row count via `@libsql/client` ke `file:sqlite.db` (read-only) |
| PRD acuan | `docs/prd/00..10-*.md` |
| Tanggal | 2026-07-12 |
| Status | MENUNGGU PILIHAN USER — tidak ada eksekusi sebelum dipilih |

## ⚠️ Konteks baseline
`sqlite.db` lokal (3,3 MB) berisi **data dummy** (off_batch = 1.275 baris dari seeder; claim hampir kosong; `item`/`customer`/`idempotency_log` = 0). Angka waktu di bawah = **sinyal struktural** (SCAN vs SEARCH), bukan latensi produksi. `sales-history-inv.db` (5,09 jt item) sudah terindeks baik — **tidak ada temuan** di sana.

---

## 0. Koreksi fakta dulu (Reality Check — membantah klaim PRD & SYSTEM_MAP)

| # | Klaim yang salah/stale | Fakta + bukti |
|---|---|---|
| K1 | PRD 04: "check-in/out belum ada sama sekali"; PRD 02/04: "JKS TBD belum ada" | **SALAH.** Modul `form-kontrol` sudah setengah jadi & dipakai nyata: `app/api/form-kontrol/checkin` (lat/lng/accuracy/foto), `checkout`, `visit`, `jks` (upload Excel); `jks_master` = 356 baris, `ao_control_daily` = 1.216 baris. PRD 04 harus jadi **extend form-kontrol**, bukan bangun dari nol |
| K2 | PRD 00/04: "customer/item **sudah di-sync**", "precedent sync terjadwal ada" | **SALAH.** `lib/sync.ts` = **dead code** — tidak diimpor file mana pun, tidak ada route/scheduler; `item`=0, `customer`=0, `sync_state`=0 baris. Semua PRD yang bergantung "sync piutang/stok" berdiri di atas fondasi yang belum pernah jalan |
| K3 | SYSTEM_MAP: "webhook return 403 dikomentari" | **STALE.** Kode aktif & fail-closed (`app/api/webhook/accurate/route.ts:11-16`). Catatan baru: webhook hanya append log — **buntu**, tidak memicu proses apa pun |
| K4 | PRD 10: fondasi OCR "existing, terbukti" | Benar secara fungsi, TAPI `variant_resolver/correction_store/golden_store/parse_cache/ocr_cache/tier_parser` **belum di-commit ke git** (`??` untracked) padahal diimpor `main.py:41-46` produksi. Risiko kehilangan fondasi |
| K5 | PRD 03: "CN number — TBD cek field" | **Belum ada.** Grep `cnNumber/cn_number/creditNote` = 0 hasil; `claim_payment` tidak punya kolom CN. Kolom baru wajib |
| K6 | SYSTEM_MAP | Tidak mendokumentasikan modul `form-kontrol` sama sekali; menyajikan alur sync sebagai hidup. Jangan dipakai sebagai satu-satunya sumber kebenaran |
| K7 | Kematangan Claim/OPC | Terbukti dari kode+route (30+ route claim-workflow), BUKAN dari volume produksi (claim_workflow=2 baris, claim_payment=0 di DB lokal) |
| K8 | Elasticsearch | **Dormant** (env tidak di-set); yang jalan = fuzzy lokal. Sesuai desain, bukan bug |

---

## 1. Gap vs PRD (per divisi)

| PRD | Status | Fondasi reusable | Gap kritis |
|---|---|---|---|
| 01 Audit | TIDAK ADA | Pola `*_audit_log`, upload `runtime/`, email | Tabel `audit_finding`; reminder → butuh F2 |
| 02 Incaso | TIDAK ADA (fondasi setengah) | Write sales-receipt + idempotency (api-wrapper); `jks_master` SUDAH ada (K1) | Sync piutang (F3), Form Tagihan dari JKS, antrian validasi, closing harian |
| 03 Claim | **ADA & JALAN** (terlengkap) | claim_workflow end-to-end, multi-submission, PDF, laporan | Jenis retur (kolom jenis tidak ada — `sourceType` ≠ jenis claim), kolom CN (K5), reminder deadline (F2), sync `sales-return` (F3) |
| 04 Sales | **SETENGAH** (koreksi K1) | form-kontrol: check-in/out+GPS+foto, visit, JKS; `sales_targets` + insentif dashboard; PWA shell nyata (sw.js versioned) | Input order lapangan, upload bukti bayar, integrasi Incaso, offline queue, link `user.id↔salesCode` |
| 05 Admin Gudang | TIDAK ADA | `holidays.ts` utk aging H+1/H+3 | Tabel status-nota bersama (F-HOLD) — hilir 06/07 |
| 06 Delivery | TIDAK ADA | PWA shell, pola upload | Event delivery + GPS; konsumen status-nota |
| 07 Gudang | TIDAK ADA | `item` sync (setelah F3; barcode TBD) | Master rute/mobil, event picking; hulu = PRD 10 |
| 08 Mgmt Dashboard | TIDAK ADA (murni derivatif) | Claim/OPC siap setor status duluan | Kontrak `daily_closing` + lock → butuh F2 |
| 09 Control Center | TIDAK ADA — **quick-win** | Nyaris tanpa dependensi; timer dihitung saat render (v1 tanpa cron) | Hanya `ops_ticket` + RBAC key |
| 10 Fakturist | TIDAK ADA — **reuse terbesar** | OCR pipeline (setelah K4 di-commit), jalur tulis Accurate + idempotency | Konektor portal B2B (v1: folder terpantau), mapping SKU, rekapan gudang |

**Urutan build disarankan:** F2–F3 (fondasi) → 09 (quick-win) → 10 → 07 → 06 → 05 → 02 → 04 → 01 → 08.

---

## 2. Tantangan atas yang SUDAH JALAN — usulan berperingkat

Format wajib per item: Baseline → Klaim + cara bukti tidak menambah latensi → Risiko → Rollback → Usaha.

### F1. Index yang hilang di `off_*` (dampak tinggi / usaha S / risiko rendah)
- **Baseline (terukur):** Kelima tabel anak (`off_batch_item`, `off_payment`, `off_audit_log`, `off_refund`, `off_notification`) hanya punya autoindex PK (bukti `sqlite_master`). Query list OPC (`batches/route.ts:262-263`) → `EXPLAIN`: `SCAN off_batch_item` 42,2 ms @ 3.150 baris dummy; `SCAN off_payment`. Plus `off_batch`: `ORDER BY created_at DESC LIMIT 200` → SCAN + TEMP B-TREE (22,2 ms @ 1.275); filter `created_by` → SCAN; `principle_code+bulan+tahun` (dipanggil tiap create batch, hingga 5× retry) → SCAN.
- **Klaim:** 8 index (`batch_id` ×5, `created_at DESC`, `(created_by,created_at)`, `(principle_code,tahun,bulan)`) mengubah plan ke SEARCH. **Bukti:** skrip EXPLAIN yang sama before/after; read path hanya bisa lebih cepat, overhead write = 1 entri B-tree per insert (interaktif tunggal, tak terasa).
- **Risiko:** sangat rendah (additive). **Rollback:** `DROP INDEX`. **Usaha:** S.

### F2. Scheduler — replikasi pola `/api/cron/*` existing (fondasi 5 PRD)
- **Baseline (terukur):** 0 lib cron di package.json; satu-satunya cron route: `app/api/cron/cleanup-uploads/route.ts` (45 baris, gated `requireCronSecret`) — polanya sudah ada, pemanggil eksternal belum ada (tidak ada vercel.json crons / cron container).
- **Klaim:** route cron baru (sync F3, reminder deadline 01/03, lock closing 08, purge F6) berjalan **out-of-band** — tidak menyentuh request path user sama sekali. **Bukti:** log durasi per run; zero perubahan pada endpoint existing.
- **Risiko:** rendah (additive). **Rollback:** matikan trigger eksternal. **Usaha:** S (per job) + keputusan infra pemanggil (DECISION D7).

### F3. Hidupkan & perbaiki `lib/sync.ts` (sekarang dead code + semantik salah)
- **Baseline (terukur):** dead code (0 importer); `onConflictDoNothing()` (baris 120/122) = baris existing **tidak pernah menerima update** dari Accurate (stale permanen); `last_sync_timestamp` tidak pernah ditulis (delta sync tidak ada); `item.unitPrice` bertipe `integer` (harga desimal terpotong).
- **Klaim:** ganti ke `onConflictDoUpdate`, tambah registry modul (sales-invoice/piutang, sales-return), panggil via F2. **Bukti:** job background ber-throttle 150 ms/halaman — biaya upsert vs ignore tidak signifikan vs network; uji sync 2×, ubah 1 field → nilai lokal ikut. Tidak menyentuh request path user.
- **Risiko:** rendah–sedang (belum dipakai produksi — 0 baris; validasi reconciliation count vs Accurate). **Rollback:** revert; tabel cache bisa rebuild penuh. **Usaha:** M. Ubah `unitPrice`→`real` sekarang selagi tabel kosong (biaya nol).

### F4. Commit fondasi python_backend yang untracked (git hygiene kritis)
- **Baseline:** `ocr_cache/tier_parser/variant_resolver/variant_mapping.json/correction_store/golden_store/parse_cache/deterministic_output/test_e2e_live` semua `??` di git, padahal diimpor `main.py:41-46` yang jalan produksi.
- **Klaim:** `git add + commit` — zero risiko runtime (tidak mengubah byte kode). **Bukti:** diff kosong pada file yang sudah tracked. **Rollback:** revert commit. **Usaha:** S.

### F5. Hardening proxy Accurate (`app/api/proxy/route.ts`) — bukan mengganti pola
- **Baseline (terukur):** 115 baris; 0 timeout/AbortSignal, 0 retry; `console.log` payload & data Accurate (baris 72, 93-97) = data bisnis bocor ke log; 25 call-site `accurateFetch(`.
- **Klaim:** tambah `AbortSignal.timeout(30s)` + hapus log payload. Timeout tidak menambah latensi happy-path (hanya cap); hapus log justru mengurangi kerja. **Bukti:** respons happy-path identik; uji timeout dgn endpoint lambat buatan.
- **Aturan turunan:** api-wrapper = tool operator manual → live-call sah; **modul PRD baru dilarang baca via proxy** — wajib lewat sync (F3). **Risiko:** rendah. **Rollback:** revert 1 file. **Usaha:** S.

### F6. Purge `runtime/` (sudah 1,7 GB)
- **Baseline (terukur):** `runtime/` = 1,7 GB; retensi hanya ada utk form-kontrol uploads (90 hari); PDF OPC/claim/laporan-harian tanpa purge.
- **Klaim:** extend cleanup route (via F2), retensi panjang + exclude list per folder. Out-of-band, tidak menyentuh request path. **Bukti:** byte terhapus per run di log.
- **Risiko:** rendah, TAPI PDF klaim mungkin wajib arsip → default retensi konservatif (mis. ≥ 1 tahun) + konfirmasi kebijakan. **Rollback:** naikkan retensi/matikan job. **Usaha:** S.

### F7. Bug korektnes: filter periode & search OPC berjalan SETELAH `LIMIT 200`
- **Baseline (terukur):** `batches/route.ts:256-259` ambil 200 batch terbaru dulu, filter periode/search di JS (`:284-321`). Dengan 1.275 baris dummy, filter "bulan X" hanya melihat 200 terbaru — **hasil hilang diam-diam** (bug, bukan sekadar perf).
- **Klaim:** dorong filter ke SQL (`created_at`/`claim_submitted_date`/`payment_date` bisa WHERE; periode `program` via `EXISTS` ke item). **Bukti tidak menambah latensi:** baris yang di-load berkurang; EXPLAIN tetap SEARCH setelah F1; test paritas hasil lama-vs-baru pada seed 1.275 batch.
- **Risiko:** sedang (4 mode filter + fallback). **Rollback:** revert route (filter JS lama masih ada). **Usaha:** M.

### F8. Persistensi cache Summary manual (`MANUAL_MASTER_CACHE`/`MANUAL_OUTPUTS`)
- **Baseline (terukur):** 2 dict in-memory (`main.py:6584-6585`), 21 titik referensi; hilang saat restart, pecah bila uvicorn `workers>1`.
- **Klaim:** persist ke SQLite/file dgn pola yang SUDAH ada di repo (`ocr_cache.py`/`parse_cache.py`). **Bukti:** ukur p95 `/summary/manual/generate` sebelum/sesudah (lookup SQLite by key <1 ms); fallback dict dipertahankan di balik flag.
- **Risiko:** rendah. **Rollback:** feature-flag kembali ke dict. **Usaha:** S–M.

### F9. Dual-auth Next↔FastAPI — dokumentasikan constraint (v1), endpoint verify (v2)
- **Baseline:** FastAPI membuka `sqlite.db` Better Auth **langsung** via `sqlite3.connect` (`main.py:109`, 1129-1168) — bukan cookie forwarding. Pecah total bila DATABASE_URL pindah remote (Turso); risiko WAL lock 2 runtime.
- **Klaim v1 (S):** dokumentasikan constraint "DB wajib file lokal shared" — zero latensi. **v2 (M):** `GET /api/auth/verify` di Next + cache TTL 60 s per token (~1-2 ms localhost, ukur dgn timing log).
- **Risiko:** sedang (jalur auth) → v1 dokumentasi dulu. **Rollback:** kembali ke direct-read. **Usaha:** S/M.

### F10. Pecah `python_backend/main.py` per `APIRouter`
- **Baseline (terukur):** 8.963 baris / 401 KB / 59 endpoint, semua domain dalam 1 file.
- **Klaim:** mechanical move ke `routers/*.py`, zero perubahan logic. **Bukti:** `test_e2e_live.py` + diff OpenAPI schema before/after identik.
- **Risiko:** sedang (state module-level MANUAL_* — kerjakan SETELAH F8). **Rollback:** git revert. **Usaha:** M. Catatan: PRD 10 jangan menumpuk di monolit ini.

### F11. Konsolidasi konstanta PPN (duplikasi kalkulasi)
- **Baseline:** `lib/claim-workflow/calculations.ts` parametrized `ppnRate` vs `main.py:5961,6025` hardcode `/1.11`; "PPh HOLD" tersebar.
- **Klaim:** konstanta/env per runtime; pure calc. **Bukti:** self-check test existing tetap hijau. **Risiko:** rendah. **Rollback:** revert. **Usaha:** S.

### HOLD — tidak direkomendasikan eksekusi (baseline tak membenarkan / tak bisa dibuktikan)
| Item | Alasan HOLD |
|---|---|
| Pagination/limit report klaim (`lib/claim-workflow/reports.ts`) | Hanya 6 submission live; pola query sudah benar (COVERING INDEX terbukti). Revisit > 5–10 rb submission |
| Pangkas payload list OPC (`searchText` + 4 array tanggal × 200 batch) | Pembengkakan nyata tapi belum diukur di jaringan produksi — ukur dulu |
| Drop kolom legacy (`off_batch.no_rekening`, `payment_proof_*` batch-level, `claim_workflow.noClaim`, `sync_state.last_sync_timestamp`) | Verifikasi pemakaian produksi dulu; drop = destruktif |
| Pecah `off-program-control/page.tsx` (11.072 baris / 432 KB) | Frontend, usaha L; tidak ada baseline UX/bundle terukur. (Koreksi: `summary/page.tsx` hanya 617 baris — tidak raksasa) |
| Implementasi tabel status-nota bersama | Desain kontrak dulu (dikonsumsi 6 PRD): `no_nota, tahap, status, timestamp, aktor, accurate_id`. Pertimbangkan DB file terpisah (preseden `sales-history-inv.db`) karena volume event tinggi |
| Migrasi Postgres | Belum ada ukuran beban tulis konkuren yang memaksa; tapi lihat DECISION D4 |
| `idempotency_log` TTL/purge | 0 baris sekarang; gabungkan ke F6 saat ada volume |

---

## 3. DECISION-NEEDED (keputusan Anda, bukan teknis)

| # | Keputusan |
|---|---|
| D1 | PRD 10: auto-login/scraping portal B2B (ToS, captcha, simpan kredensial) vs v1 folder terpantau |
| D2 | PRD 06: GPS live tracking armada (janji poster cover) vs snapshot per aksi (asumsi PRD) |
| D3 | PRD 08: lock closing otomatis 20:00 + siapa boleh unlock |
| D4 | Engine DB: 7+ divisi menulis konkuren ke SQLite single-writer = risiko nyata; putuskan SQLite/libSQL (Turso) vs Postgres SEBELUM modul lapangan (04/06/07) dibangun |
| D5 | PRD 02: pelunasan langsung tulis Accurate vs staging+batch (rekomendasi: staging) |
| D6 | PRD 08: divisi "Kasir" di traffic light tanpa modul/poster — perlu modul atau digabung Incaso? |
| D7 | Infra pemanggil cron (Task Scheduler host / container cron / layanan eksternal) — prasyarat F2 |
| D8 | PRD 04: extend `form-kontrol` existing (rekomendasi — data & RBAC sudah hidup) vs modul `sales_app` baru |

---

## 4. Ringkasan eksekutif
1. **Terlengkap:** Claim (PRD 03) — gap kecil (retur, CN, reminder). **Terkosong:** 05/06/07/08/09.
2. **Koreksi terbesar:** Sales (PRD 04) tidak mulai dari nol — form-kontrol sudah punya check-in/GPS/JKS; dan premis "sync Accurate sudah ada" salah (dead code, tabel kosong).
3. **Fondasi yang membuka semuanya:** F2 (scheduler) + F3 (sync hidup & benar) — hampir semua PRD menggantung di dua ini.
4. **Perbaikan termurah-berdampak:** F1 (index), F4 (commit file untracked), F5 (proxy timeout+log), F6 (purge 1,7 GB).
5. Tidak ada usulan menyentuh jalur panas tanpa cara pembuktian; yang tak terbukti → HOLD.
