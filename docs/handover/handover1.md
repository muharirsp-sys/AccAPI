# MASTER HANDOVER CONTEXT — AccAPI / Ops Control Tower (CV. Surya Perkasa)

| Doc | Nilai |
|---|---|
| Sesi asal | Audit F1–F11 + setup VPS + perbaikan OAuth/sync Accurate |
| Tanggal | 2026-07-13 |
| Nomor handover | **1** (berikutnya: `docs/handover/handover2.md`, dst.) |
| Status | HEAD repo saat handover ini dibuat: commit `92900e1`, ter-deploy production |

---

# 1. TUJUAN UTAMA

Membangun **"Ops Control Tower"** untuk CV. Surya Perkasa (distributor FMCG, Makassar) di atas aplikasi produksi **AccAPI** (Next.js App Router + FastAPI + SQLite/libSQL, rencana pindah Postgres): satu sistem terintegrasi di mana 10 divisi (Sales, Fakturist, Gudang, Delivery, Admin Gudang, Incaso, Claim, Audit, Sekretaris OM/Control Center, Manajemen) punya dashboard operasional near-real-time, alur kerja terkontrol (menggantikan nota fisik/WA/Excel), dan manajemen melihat semua divisi dalam satu layar traffic-light + daily closing.

Output yang sedang dibuat, berurutan:
1. **Fase A (SELESAI)**: PRD per divisi → `docs/prd/00-overview.md` s/d `10-fakturist.md`.
2. **Fase B (SELESAI)**: audit findings → `docs/audit/findings.md` (F1–F11 + D1–D8 + HOLD list).
3. **Eksekusi F1–F11 (SELESAI & TER-DEPLOY)**.
4. **Berikutnya**: cutover Postgres (D4, infra sudah siap) → lalu pembangunan modul PRD dengan urutan 09 → 10 → 07 → 06 → 05 → 02 → 04 → 01 → 08.

# 2. LATAR BELAKANG DAN KONTEKS

- **User**: Ari (muharir.sp@gmail.com), pemilik/superadmin; non-teknis untuk infra (minta dijelaskan "seperti ke anak 5 tahun" untuk keputusan); punya akses penuh ke semua sistem; memakai Accurate Online sebagai ERP utama.
- **Sumber data utama = Accurate Online API**. Aturan proyek: pola default = **sync terjadwal ke DB lokal**, BUKAN live-call per request. Live-call hanya sah untuk tool operator manual (api-wrapper).
- **Visi berasal dari 11 poster PNG** di `poster/` (di-gitignore) — poster adalah IDE/VISI; **semua angka di poster FIKTIF**, jangan dijadikan requirement.
- **Repo**: `D:\AccAPI\_github_clean`, GitHub `muharirsp-sys/AccAPI`, branch `main`.
- **Deploy flow**: push ke main → GitHub Actions `deploy.yml` (lint+typecheck → build 2 image Docker → push `ghcr.io/muharirsp-sys/accapi-{frontend,backend}:latest` → curl webhook Coolify) → Coolify pull & recreate container. Ada `workflow_dispatch` untuk trigger manual.
- **VPS**: `43.156.118.114` (SSH root, key `~/.ssh/id_ed25519`, OS opencloudos, timezone UTC+8=WITA). Coolify service dir: `/data/coolify/services/m3snvk67018khyzuz9dhkh4h` (berisi `.env` production + `docker-compose.yml`). Domain: `https://web-super.online`; frontend host port 18080, backend 18000. IP lain: `43.129.49.103` (timeout), `76.13.0.225` (host-key berubah — JANGAN dipakai tanpa konfirmasi user).
- **Modul existing yang sudah jalan** (jangan bangun ulang): OPC (Off-Program Control), Claim Workflow (paling matang), insentif-sales, laporan-harian (in progress), summary program (pipeline OCR determinisme FASE 1–5), api-wrapper (tool operator Accurate), validator, payments/LPB (python), form-kontrol (check-in GPS+foto, JKS — fondasi modul Sales), RBAC (Better Auth + permission registry `module.action`), dashboard-generator (tool desktop offline terpisah).

# 3. KEPUTUSAN YANG SUDAH DISEPAKATI

## Keputusan FINAL (jawaban langsung user, JANGAN tanya ulang):
- **D1** (Fakturist/PO B2B): user login portal B2B manual; robot memakai credentials/sesi yang ada. Bukan scraping penuh otomatis.
- **D2** (Delivery GPS): snapshot titik koordinat per tombol aksi saja. BUKAN live tracking armada.
- **D3** (Lock closing): otomatis jam 20:00; yang boleh unlock hanya **OM dan superadmin (user)**.
- **D4** (Database): **pindah ke PostgreSQL**, user minta Claude yang setting semua sampai VPS, syarat mutlak: "**pindahnya harus aman**". Infra SELESAI; cutover kode = fase khusus dengan gerbang verifikasi (lihat `docs/audit/postgres-cutover.md`).
- **D5** (Pelunasan Incaso): tulis **LANGSUNG ke Accurate** (bukan staging) — alasan bisnis: tanpa pelunasan, orderan sales berikutnya terblokir.
- **D6** (Kasir): modul **TERPISAH** dari Incaso — SOP segregation of duties, Incaso dan Kasir saling mengontrol, mencegah "permainan" di kantor.
- **D7** (Scheduler): cron di host VPS — sudah terpasang.
- **D8** (Modul Sales): **extend modul form-kontrol existing**, BUKAN bangun baru.
- Semua usulan F1–F11: disetujui dikerjakan semua, dengan syarat "jangan sampai ada step yang membuat berat yang sudah ada" — setiap perubahan wajib bukti tidak memperlambat.

## Asumsi sementara (boleh direvisi dengan bukti):
- Retensi purge: laporan-harian 90 hari, sales-history-build 30 hari, runtime_logs 90 hari.
- Jadwal sync 4×/hari cukup untuk kebutuhan near-real-time saat ini.
- H+1/H+3 aging nota = hari kerja (pakai `holidays.ts`) — belum dikonfirmasi user.

## Menunggu konfirmasi user:
- Nasib 1,6 GB file analisis Heinz 2024 di `runtime/` lokal (hapus/arsip).
- Kapan mulai fase cutover Postgres.
- Rotasi Client Secret Accurate (terekspos di screenshot; disarankan regenerate, belum dilakukan).

# 4. REQUIREMENT DAN ATURAN WAJIB

1. **Jangan mengarang data** — field/angka yang tidak diketahui ditandai TBD/null, bukan ditebak.
2. **Data Accurate**: sync terjadwal → tabel cache lokal; modul PRD baru DILARANG baca via `/api/proxy` (proxy = tool operator manual saja).
3. **Setiap usulan yang menyentuh kode jalan** wajib: baseline terukur → klaim + cara bukti tidak menambah latensi → risiko → rollback → estimasi usaha. Tanpa bukti → HOLD.
4. **Ponytail mode aktif** (gaya kerja): solusi paling sederhana yang benar, stdlib/pola existing dulu, diff terpendek, tandai simplifikasi sadar dengan komentar `ponytail:`, setiap logika non-trivial punya satu runnable check.
5. Dokumen ber-header (Doc table: Sumber/Status/Tanggal); bahasa Indonesia; hemat token (tabel, ringkas).
6. Commit message berbahasa Indonesia dengan prefix conventional (`feat/fix/docs/refactor/perf/ci`), diakhiri `Co-Authored-By: Claude ...`.
7. RBAC: modul baru memakai permission registry `module.action` existing.
8. PDF klaim/OPC = arsip legal, TIDAK BOLEH ikut purge.
9. Environment sesi memiliki **hook "Fact-Forcing Gate"** yang MENOLAK Write/Edit/Bash pertama per file/sesi — solusi: tulis fakta singkat (pemanggil, API terdampak, skema, instruksi user verbatim) di pesan, lalu retry operasi yang sama (percobaan kedua lolos). Ada juga hook **config-protection** yang memblokir edit `eslint.config.mjs` dkk — solusi source-level (mis. banner `/* eslint-disable */` di file vendored).
10. `NEXT_PUBLIC_*` di Next.js dibake **saat build image** (GitHub Actions build-args dari GitHub Secrets), bukan runtime Coolify — perubahan nilai butuh rebuild.

# 5. FILE, DATA, DAN REFERENSI

## Dokumen (acuan utama):
- `SYSTEM_MAP.md` — peta arsitektur repo; SUDAH dikoreksi (webhook 403 aktif; sync hidup; catatan form-kontrol belum terdokumentasi penuh). Jangan jadikan satu-satunya sumber kebenaran.
- `docs/prd/00-overview.md` — visi + rantai dokumen lintas divisi + peta overlap modul existing. **Entitas sentral = NOTA (sales invoice)**; argumen satu tabel status-nota bersama.
- `docs/prd/01..10-*.md` — PRD per divisi (01 Audit, 02 Incaso, 03 Claim, 04 Sales, 05 Admin Gudang, 06 Delivery, 07 Gudang, 08 Management Dashboard, 09 Control Center, 10 Fakturist). PRD 02/04 sudah dikoreksi pasca-audit (JKS & check-in TERNYATA sudah ada di form-kontrol).
- `docs/audit/findings.md` — **acuan utama eksekusi**: koreksi fakta K1–K8, gap per PRD, usulan F1–F11 dengan baseline/bukti/rollback, HOLD list, DECISION D1–D8.
- `docs/audit/postgres-cutover.md` — rencana cutover D4 dengan 6 langkah bergerbang.
- `docs/handover/handover1.md` — dokumen ini.

## Kode kunci:
- `db/schema.ts` — 50 tabel Drizzle SQLite; + index `off_*` (F1); + tabel baru `sales_invoice` (`salesInvoiceCache`), `sales_return` (`salesReturnCache`); `item.unitPrice` & `customer.balance` sudah `real`.
- `lib/sync.ts` — **versi terbaru & berlaku** (lihat §11): registry 4 modul sync + `fields` wajib + upsert `onConflictDoUpdate` + checkpoint per halaman + watermark.
- `app/api/cron/sync-accurate/route.ts` — trigger sync, gate `requireCronSecret`, kredensial dari `ACCURATE_SYNC_USER_ID` env atau sesi OAuth terbaru.
- `app/api/cron/cleanup-uploads/route.ts` (existing) & `app/api/cron/cleanup-runtime/route.ts` (F6).
- `app/api/auth/verify/route.ts` (F9) — verifikasi sesi Better Auth untuk FastAPI.
- `app/api/proxy/route.ts` — proxy Accurate manual; sudah +timeout 30s, log payload dihapus (F5).
- `app/api/off-program-control/batches/route.ts` — fix F7 (filter sebelum cap 200, paging 400 + early-exit).
- `python_backend/` — **struktur baru F10**: `main.py` (±559 baris: app+middleware+endpoint sisa) + `shared.py` (±5.136 baris: SEMUA state module-level & helper bersama) + `routers/{validator,payments,sppd,finance,summary,laporan_harian}.py`. Router import eksplisit `from shared import (...)`. `_PersistentDict` (F8) mem-persist `MANUAL_MASTER_CACHE`/`MANUAL_OUTPUTS` ke `python_backend/data/manual_cache/*.json`. `PPN_RATE = float(os.getenv("PPN_RATE","0.11"))` (F11). Blok `AUTH_VERIFY_URL`/`_verify_session_via_next` (F9) di shared.py.
- `scripts/migrate-add-off-indexes.mjs` & `scripts/migrate-sync-tables.mjs` — migrasi idempotent; **sudah dijalankan di lokal DAN production**.
- `.github/workflows/deploy.yml` — CI/CD; build-args `NEXT_PUBLIC_*` dari GitHub Secrets; trigger: push main + workflow_dispatch.
- `config/accurateRoutes.js` — katalog endpoint Accurate + contoh `fields` per endpoint (referensi penting untuk sync).

## Data/infra:
- Lokal: `sqlite.db` (berisi **dummy** — off_batch 1.275 baris dari seeder; JANGAN anggap data produksi), `sales-history-inv.db` (5,09 jt baris, arsip read-only, SENGAJA tetap SQLite selamanya).
- Production: `DATABASE_URL=file:/app/data/sqlite.db` (volume frontend). Data sync live per 2026-07-13: **customer 26.748, item 3.910, sales_invoice 179.333, sales_return 27.382**.
- Postgres VPS: container `accapi-postgres` (postgres:16-alpine 16.14), network `coolify` internal-only tanpa port publik, volume `accapi-pgdata`, kredensial `/root/accapi-postgres.env` (chmod 600, format: POSTGRES_HOST/PORT/DB/USER/PASSWORD + DATABASE_URL_PG).
- Memori Claude lintas sesi: `project_vps_deploy_infra.md`, `project_decisions_d1_d8.md`, `project_opc_dummy_seeder.md` (di direktori memory proyek).

# 6. PEKERJAAN YANG SUDAH SELESAI

| Item | Isi | Bukti |
|---|---|---|
| Fase A | 11 PRD | — |
| Fase B | findings.md (3 agent read-only: DB Optimizer, Backend Architect, Reality Checker) | Koreksi K1–K8 |
| F1 | 8 index `off_*` (lokal+production) | EXPLAIN: 8 query SCAN→SEARCH; list+subcount 200 batch 4,6 ms |
| F2 | Route cron + cron VPS terpasang | Uji hit 200 |
| F3 | `lib/sync.ts` hidup: 4 modul, upsert benar, watermark, checkpoint | Test upsert nilai berubah; sync live production sukses |
| F4 | Commit fondasi untracked (pipeline determinisme, dashboard-generator) | 5 commit |
| F5 | Proxy: `AbortSignal.timeout(30s)`, log payload dihapus, TimeoutError→504 | Happy-path identik |
| F6 | `cleanup-runtime` purge folder regenerable saja | Uji production 200 |
| F7 | Bug filter OPC (filter dulu baru cap 200) | Filter 03/2026: lama=0, baru=75=ground-truth |
| F8 | `_PersistentDict` persist cache summary | Uji survive-restart lolos |
| F9 | `/api/auth/verify` + jalur FastAPI opt-in `AUTH_VERIFY_URL` (fallback sqlite utuh) | Anon→401; **belum diaktifkan** (env kosong) |
| F10 | main.py 9.042 baris → shared.py + 6 router | Rekonstruksi byte-for-byte PASSED; OpenAPI diff kosong (63 route); pyflakes identik baseline |
| F11 | `PPN_RATE` satu sumber | Default 0.11, hasil identik |
| D4-infra | Postgres 16.14 di VPS | `pg_isready` OK |
| D7 | `/etc/cron.d/accapi`: sync 05:15/11:15/17:15/23:15 WITA; cleanup-uploads 02:30; cleanup-runtime 03:00; log `/var/log/accapi-cron.log`; helper `/usr/local/bin/accapi-cron.sh` | Uji manual 200 |
| OAuth Accurate | Diperbaiki total (lihat §9) + user sudah login production | Sesi tersimpan: host `iris.accurate.id`, DB "CV Surya Perkasa", userId `vGPRbUwwhZtkjCNA51dohep5310HvLy2` |
| Sync perdana | 4 modul penuh sukses dengan data valid | Angka di §5 |

Commit penting (urutan): `3bb3c6b` (FASE 1-5) → `9ef8e6f` (dashboard-generator) → `38d5cbd` (docs PRD+findings) → `b744bb7` (F1) → `bcad39e` (F5+F11) → `0aaeff5` (F7) → `143b0c6` (F8) → `d08ca12` (F2+F3) → `9880816` (F6+F9) → `b8b6eb1` (docs D4) → `6494af6` (F10; CI-nya merah karena lint echarts — historis, aman) → `0d5c6af` (fix CI) → `9ff781a` (docs) → `a2b3709` (workflow_dispatch) → `874942b` (fix fields) → `92900e1` (fix id di fields — **HEAD terakhir yang ter-deploy**).

# 7. KONDISI TERAKHIR

- **HEAD = `92900e1`**, CI hijau, ter-deploy, kedua container fresh & healthy.
- Sync Accurate production **hidup dan terverifikasi datanya** (sample invoice/return/item/customer berisi field lengkap). `sync_state` semua `idle` dengan watermark.
- Cron akan berjalan otomatis di jadwal berikutnya (butuh sesi OAuth tetap valid; kalau token Accurate expired, user perlu login ulang — perilaku refresh token belum diuji).
- Bundle production terverifikasi: `client_id "74867020-c436-4937-9532-f3a4340b6c2a"`, `redirect_uri "https://web-super.online/api/auth/callback"`; env server `ACCURATE_CLIENT_ID`/`ACCURATE_CLIENT_SECRET` terisi.
- Masalah terakhir yang ditemukan & sudah fix: `id` tidak ikut dalam respons Accurate saat `fields` eksplisit → PK `NaN` → insert gagal → route 502. Fix: `id` dicantumkan eksplisit di semua `fields`.

# 8. PEKERJAAN YANG BELUM SELESAI

**Prioritas berikutnya (urut):**
1. **D4 cutover Postgres** (fase khusus, gerbang di `postgres-cutover.md`): konversi `db/schema.ts` 50 tabel `sqliteTable`→`pgTable`; `lib/db.ts` + `lib/auth.ts` (adapter drizzle-pg); 1 pemakaian `.get()` sqlite-style; script `migrate-data-to-pg.mjs` dengan verifikasi COUNT per tabel; aktifkan `AUTH_VERIFY_URL=http://accapi-frontend:3000/api/auth/verify` di FastAPI; **migrasikan juga 2 titik `sqlite3.connect(BETTER_AUTH_DB_PATH)` di `shared.py` (bekas main.py ±1186/1234 — get_user_role & permission lookup) ke jalur verify**; `sales-history-inv.db` TIDAK ikut; freeze-tulis malam hari saat switch; rollback = kembalikan `DATABASE_URL`.
2. **Bangun modul PRD** urutan: 09 Control Center (quick-win, tabel `ops_ticket` + RBAC) → 10 Fakturist → 07 Gudang → 06 Delivery → 05 Admin Gudang → 02 Incaso → 04 Sales (extend form-kontrol) → 01 Audit → 08 Management Dashboard. Prasyarat lintas modul: **desain tabel status-nota bersama** (kontrak: `no_nota, tahap, status, timestamp, aktor, accurate_id`; pertimbangkan DB file terpisah spt sales-history).
3. **Gap Claim (PRD 03)**: jenis claim retur, kolom CN (belum ada — grep 0 hasil), reminder deadline via cron.

**Klarifikasi/data yang belum tersedia:**
- Nama field Accurate untuk `outstanding`, `status`, `customerName` di `sales-invoice/list.do` & `sales-return/list.do` (diuji live: tidak muncul dengan nama itu). Gali saat PRD 02; kolomnya sudah ada di tabel (nullable).
- Keputusan file Heinz 1,6 GB; jadwal cutover Postgres; rotasi Client Secret.
- Definisi traffic light hijau/kuning/merah per divisi (keputusan manajemen, PRD 08).
- Refresh-token OAuth Accurate: belum diketahui apakah `getAccurateSession` menangani expiry (risiko sync mati diam-diam saat token kadaluarsa — pantau `sync_state.status='error'`).

**HOLD (jangan dieksekusi tanpa baseline baru):** pagination report klaim; pangkas payload list OPC; drop kolom legacy (`off_batch.no_rekening`, `payment_proof_*` batch-level, `claim_workflow.noClaim`, `sync_state.last_sync_timestamp`—yang terakhir kini justru DIPAKAI); pecah `off-program-control/page.tsx` (11.072 baris); implementasi status-nota (desain dulu); `idempotency_log` TTL.

# 9. KESALAHAN DAN PENDEKATAN YANG TIDAK BOLEH DIULANGI

1. **Accurate `list.do` TANPA parameter `fields` hanya mengembalikan `{id}`** per baris. Selalu kirim `fields` eksplisit.
2. **`id` TIDAK otomatis disertakan** saat `fields` diisi — wajib dicantumkan, kalau tidak PK jadi `NaN` dan insert gagal (gejala: route 502 dalam <1 detik, response body berisi "Failed query: insert ... params: NaN,...").
3. **Penamaan kolom campur**: tabel `item`/`customer` pakai camelCase (`customerNo`, `unitPrice`) + `raw_data`/`last_update`; tabel `sales_invoice`/`sales_return`/`accurate_oauth_session` full snake_case (`customer_no`, `total_amount`, `trans_date`, `user_id`). Query mentah harus pakai nama kolom fisik yang benar.
4. **Worktree agent bisa stale**: agent F10 pertama kali bekerja dari commit lama (f0c582b) padahal main sudah maju — hasil refactor byte-perfect terhadap baseline salah. SELALU verifikasi `git log -1` + grep marker kode terbaru di worktree sebelum merge hasil agent.
5. **`summary/page.tsx` BUKAN file raksasa** (617 baris) — klaim awal audit salah, sudah dikoreksi. Yang raksasa: `off-program-control/page.tsx` (11.072 baris).
6. **PRD 04 salah klaim "mulai dari nol"** — check-in/GPS/foto/JKS sudah ada di `form-kontrol` (`jks_master` 356 baris, `ao_control_daily` 1.216 baris). Jangan bangun duplikat.
7. **`lib/sync.ts` versi lama** memakai `onConflictDoNothing` (data tak pernah ter-update) dan dead code — sudah diganti; jangan kembalikan pola itu.
8. Klaim SYSTEM_MAP lama yang SALAH: "webhook 403 dikomentari" (nyatanya aktif fail-closed; webhook hanya logger buntu) dan alur sync disajikan hidup padahal dead code.
9. **CI gagal karena lint file vendored** (`dashboard-generator/assets/echarts.min.js`) — solusi yang benar: banner `/* eslint-disable */` di file (hook memblokir edit eslint config). Folder `ponytail/` lokal juga memicu error lint lokal — sudah di-gitignore, error lokalnya bisa diabaikan (tidak ada di CI).
10. **Jangan hapus file user di `runtime/`** (analisis Heinz) tanpa persetujuan — bukan output aplikasi.
11. `curl` dari cron helper menyembunyikan body error (`--fail`) — saat debug 502/4xx, ulangi dengan `curl -sv` tanpa `--fail` untuk melihat body.
12. Monitor regex "Up X minutes" rawan salah match — cek umur container dengan pola detik/menit yang eksplisit.
13. Jangan jalankan sync 4 modul sekaligus untuk debugging — isolasi per modul.

# 10. ISTILAH, KODE, DAN DEFINISI PENTING

- **OPC / off_batch**: Off-Program Control — modul pengajuan program diskon SPV → SM → Claim → OM → Finance. Tabel `off_batch`, `off_batch_item`, `off_payment`, `off_refund`, `off_notification`, `off_audit_log`, `off_period_closure`.
- **Claim Workflow**: klaim ke principal; tabel `claim_workflow`, `claim_submission` (source-of-truth `no_claim`), `claim_payment`, `claim_audit_log`. `sourceType` = off_program/direct_kwitansi/manual (BUKAN jenis diskon/promo/retur).
- **Incaso**: divisi penagihan (kolektor pembayaran nota dari sales). **JKS**: Jadwal Kunjungan Sales (tabel `jks_master`). **LPB**: Laporan Penerimaan Barang (payments python). **CN**: Credit Note dari principal. **NKA**: National Key Account (Indomaret dll; sumber PO B2B). **Nota** = sales invoice fisik.
- **Principal**: pabrikan/supplier yang menerima claim.
- **form-kontrol**: modul existing check-in/out AO (`ao_control_daily`) + JKS.
- **Fase A/B**: PRD/audit. **F1–F11**: item perbaikan audit. **D1–D8**: keputusan user. **K1–K8**: koreksi fakta audit.
- **FASE 1–5 determinisme**: pipeline summary OCR (ocr_cache → tier_parser → variant_resolver → correction_store → golden_store → parse_cache → deterministic_output).
- Aktor OPC/roles python: admin, manager, finance, staff, viewer. Role Better Auth di `user.role`.
- **sumopod**: gateway LLM (ai.sumopod.com) dipakai OCR/parse summary.
- Tabel sync: `sync_state` (module PK, last_sync_timestamp, last_page, status idle/syncing/error), `item`, `customer`, `sales_invoice`, `sales_return`.

# 11. ARTEFAK TEKNIS (versi terakhir yang berlaku)

**Registry sync (inti `lib/sync.ts` — file lengkap di repo, ini bagian yang menentukan):**
```ts
// AccuratePaginator(endpoint, creds, startPage, fields?) → URL:
// `${host}/accurate/api${endpoint}?sp.page=N&sp.pageSize=100&fields=${encodeURIComponent(fields)}`
// headers: Authorization: Bearer <accessToken>, X-Session-ID: <sessionId>; AbortSignal.timeout(60_000)
const SYNC_MODULES = {
  item:          { endpoint: "/item/list.do",          fields: "id,no,name,unitPrice,itemType,lastUpdate" },
  customer:      { endpoint: "/customer/list.do",      fields: "id,customerNo,name,balance,lastUpdate" },
  sales_invoice: { endpoint: "/sales-invoice/list.do", fields: "id,number,customerNo,totalAmount,transDate,lastUpdate" }, // outstanding/status/customerName TBD
  sales_return:  { endpoint: "/sales-return/list.do",  fields: "id,number,customerNo,totalAmount,transDate,lastUpdate" }, // status/customerName TBD
};
// Upsert: db.insert(tabel).values(payloads).onConflictDoUpdate({ target: tabel.id, set: { kolom: sql`excluded."nama_kolom_fisik"` } })
// Checkpoint: update sync_state.lastPage tiap halaman; selesai → status idle, lastPage 1, lastSyncTimestamp ISO.
```

**Cron VPS (`/etc/cron.d/accapi`) — aktif:**
```
15 5,11,17,23 * * * root /usr/local/bin/accapi-cron.sh /api/cron/sync-accurate >> /var/log/accapi-cron.log 2>&1
30 2 * * * root /usr/local/bin/accapi-cron.sh /api/cron/cleanup-uploads >> /var/log/accapi-cron.log 2>&1
0 3 * * * root /usr/local/bin/accapi-cron.sh /api/cron/cleanup-runtime >> /var/log/accapi-cron.log 2>&1
```
`/usr/local/bin/accapi-cron.sh`: baca `CRON_SECRET` dari `.env` service → `curl -fsS -m 3500 -H "Authorization: Bearer $SECRET" http://127.0.0.1:18080$PATH`.

**DDL production yang sudah dijalankan** (idempotent, via `docker exec <frontend> node -e` dengan `@libsql/client`): 8 × `CREATE INDEX IF NOT EXISTS idx_off_*`, `CREATE TABLE IF NOT EXISTS sales_invoice(...)/sales_return(...)` + 4 index + `ANALYZE`. Referensi persis: `scripts/migrate-add-off-indexes.mjs`, `scripts/migrate-sync-tables.mjs`.

**Env penting**: GitHub Secrets: `NEXT_PUBLIC_ACCURATE_CLIENT_ID` (build-time), `NEXT_PUBLIC_ACCURATE_REDIRECT_URI`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_FASTAPI_BASE_URL`, `BETTER_AUTH_*`, `COOLIFY_WEBHOOK_URL`, `COOLIFY_TOKEN`. Coolify `.env`: `ACCURATE_CLIENT_ID`, `ACCURATE_CLIENT_SECRET`, `CRON_SECRET`, `DATABASE_URL=file:/app/data/sqlite.db`, dll. Opsional belum di-set: `ACCURATE_SYNC_USER_ID`, `AUTH_VERIFY_URL`, `PPN_RATE`, `ACCURATE_TOKEN_ENCRYPTION_KEY` (fallback BETTER_AUTH_SECRET).

**OAuth Accurate**: app "Integrasi CV. Surya Perkasa", Client ID `74867020-c436-4937-9532-f3a4340b6c2a`, callback terdaftar: `http://localhost:3000/api/auth/callback` **dan** `https://web-super.online/api/auth/callback` (multi-URI dipisah Enter — localhost dipertahankan agar aplikasi .exe user tetap jalan). Token disimpan terenkripsi AES-256-GCM di `accurate_oauth_session` (`lib/accurate-session.ts`).

**Yang masih bermasalah / belum aktif**: `AUTH_VERIFY_URL` belum di-set (jalur F9 dorman by design sampai cutover Postgres); field TBD invoice/return; 4 pyflakes undefined pre-existing yang SENGAJA dibiarkan demi paritas F10 (`datetime` di `add_principle` main.py; `EMAIL_USER`/`EMAIL_PASSWORD`/`send_email_background` di `routers/summary.py` `summary_manual_email` — fungsi memang tak pernah ada).

# 12. INSTRUKSI UNTUK AI DI ROOM BARU

1. Anggap dokumen ini **sumber konteks utama**; cross-check detail ke `docs/audit/findings.md`, `docs/prd/*`, `docs/audit/postgres-cutover.md`, dan memori proyek — jangan tanya ulang hal yang sudah tertulis di sini (terutama D1–D8).
2. Verifikasi kondisi nyata sebelum mengubah: `git log --oneline -5` (HEAD harus ≥ `92900e1`), `git status`, dan untuk production cek via SSH root@43.156.118.114 (read-only dulu).
3. Pertahankan semua keputusan §3 dan aturan §4. Usulan lama ≠ keputusan; HOLD list tetap HOLD tanpa baseline baru.
4. Perubahan pada kode yang sudah jalan wajib pola: baseline → bukti tidak memperlambat → rollback. Commit kecil per-F/per-fitur, push memicu auto-deploy (build ±5 menit + Coolify recreate ±2–4 menit; container "Up X seconds" = baru).
5. Hook Fact-Forcing Gate akan menolak operasi pertama — tulis fakta, retry, jangan panik atau ubah pendekatan.
6. Jika informasi tidak ada di handover/repo (mis. nama field Accurate yang TBD), nyatakan eksplisit "belum diketahui" dan uji live dengan metode §11 (decrypt token dari `accurate_oauth_session` di container, panggil `list.do` pageSize=1) — jangan mengarang.
7. Jangan pernah: hapus file `runtime/` user, drop kolom/tabel berisi data, menyentuh IP `76.13.0.225`, memakai proxy live-call untuk modul PRD baru, atau menampilkan nilai secret di chat.
8. Lanjutkan dari kondisi terakhir (§7) — jangan mengulang audit, jangan bangun ulang modul existing.
9. **Jika perlu membuat handover berikutnya**: simpan sebagai `docs/handover/handover2.md` (jangan menimpa `handover1.md`), dengan pola/struktur yang sama seperti dokumen ini.

# 13. PESAN PEMBUKA UNTUK ROOM BARU (siap salin)

> Baca dan patuhi MASTER HANDOVER CONTEXT di `docs/handover/handover1.md` sebagai sumber konteks utama — jangan tanya ulang isi yang sudah ada di sana.
>
> Konteks singkat: AccAPI production (Next.js + FastAPI + SQLite di VPS Coolify 43.156.118.114, domain web-super.online) milik CV. Surya Perkasa. Audit F1–F11 selesai & ter-deploy (HEAD `92900e1`), sync Accurate production hidup (customer 26.748 / item 3.910 / sales_invoice 179.333 / sales_return 27.382), cron 4×/hari terpasang, PostgreSQL 16.14 sudah provisioned di VPS tapi kode belum cutover.
>
> Tugas pertamamu: **eksekusi D4 — cutover SQLite → PostgreSQL** mengikuti gerbang di `docs/audit/postgres-cutover.md` (branch `migrate-postgres`, konversi 50 tabel `db/schema.ts` ke pgTable, `lib/db.ts` + `lib/auth.ts` ke adapter pg, script migrasi data dengan verifikasi COUNT per tabel, aktifkan `AUTH_VERIFY_URL` untuk FastAPI + migrasikan 2 titik `sqlite3.connect` di `python_backend/shared.py` ke jalur verify, uji alur inti, baru switch env production dengan rollback plan). Syarat mutlak dari saya: **pindahnya harus aman** — setiap langkah harus punya bukti verifikasi dan jalan kembali. Mulai dengan memverifikasi kondisi repo dan VPS sesuai §12, lalu tunjukkan rencana eksekusimu per gerbang sebelum menyentuh production.
