# MASTER HANDOVER CONTEXT — handover10.md (Sentry: `/admin/groups` crash + `/payments` "loading terus")

> Penerus `handover9.md`. Fokus = **dua bug produksi yang dilaporkan lewat Sentry & keluhan user**, bukan fitur baru. Dibuat 2026-08-24. Branch `main`. HEAD sebelum sesi: `bad364d`. Semua klaim di dokumen ini diverifikasi ke git, kode, `node_modules/better-auth`, dan probe HTTP ke produksi — bukan ingatan.

---

## 1. RINGKASAN SESI

Dua masalah terpisah, **penyebab berbeda**, dikerjakan berurutan:

| # | Gejala | Penyebab | Status |
|---|--------|----------|--------|
| A | Sentry: `SyntaxError: Failed to execute 'json' on 'Response'` di `/admin/groups`, 43 event × 2 issue | `r.json()` tanpa cek `r.ok`; body 500 kosong/HTML | **SELESAI & di-deploy** (`a72fe58`, `2de8e19`) |
| B | `/payments` **loading terus** di satu PC, PC lain lancar | Event loop uvicorn tersumbat operasi blocking + frontend tanpa timeout | **SELESAI, belum di-deploy** (lihat §5) |
| C | Sentry: puluhan issue `Failed query: select ...` | **BUKAN bug kode** — Postgres dev tidak jalan | Tidak ada aksi; lihat §6.1 |

## 2. KONTEKS DASAR (sama dengan handover9)

- **Aplikasi:** AccAPI = ERP internal **CV. Surya Perkasa** (distributor FMCG multi-principal).
- **User:** Ari, bahasa Indonesia, Windows 11 (PowerShell + Git Bash), kerja lokal `D:\AccAPI\_github_clean`.
- **Stack:** Next.js 16 / React 19 (TS); PostgreSQL via Drizzle; Better Auth; backend kedua FastAPI (`python_backend/`).
- **Produksi:** VPS Coolify `43.156.118.114`, `https://web-super.online`. Diverifikasi hidup saat sesi ini: `/login` → 200 dalam 0,65 s.
- **Deploy:** GitHub Actions `.github/workflows/deploy.yml`, **hanya branch `main`**. Job `typecheck` = `npm run lint` lalu `npx tsc --noEmit`; gagal salah satu → tidak ada image, tidak ada deploy.

---

## 3. MASALAH A — `/admin/groups` meledak saat API balas 500 (SELESAI)

### 3.1 Akar masalah
[`GroupManagement.tsx`](../../app/(dashboard)/admin/groups/GroupManagement.tsx) memanggil `await r.json()` di **5 tempat** tanpa cek `r.ok`. Saat route balas 500, body-nya kosong/HTML → `.json()` melempar `SyntaxError` yang tidak tertangani → halaman mati tanpa pesan apa pun.

### 3.2 Perbaikan
- File baru [`lib/json-fetch.ts`](../../lib/json-fetch.ts):
  - `jsonOrThrow(res)` — baca `text()` dulu, parse defensif, lempar `Error` berpesan (`error` dari server, atau `HTTP <status>`).
  - `getJson(url)` — gaya **result** (`{ok:true,data} | {ok:false,error}`); dipakai di call site yang dulunya `try/catch`. Menangkap juga `fetch` yang reject (mis. `ECONNREFUSED`), bukan cuma status jelek.
- Test [`lib/json-fetch.test.ts`](../../lib/json-fetch.test.ts) — 7 kasus, semua lulus: `npx tsx --test lib/json-fetch.test.ts`.

### 3.3 JEBAKAN yang menghabiskan satu siklus CI (jangan terulang)
Commit `a72fe58` **membuat CI #153 gagal** di `npm run lint`, bukan di typecheck.

Penyebabnya halus dan penting dipahami: aturan `react-hooks/set-state-in-effect` menyala **karena kodenya jadi lebih rapi**. Versi lama lolos hanya karena `await r.json()` bertipe `any`, sehingga analisis rule menyerah. Begitu tipenya jelas (`getJson<T>`), `setState` terbukti terjangkau dari effect → error.

- Rule ini **`error` di seluruh repo**; hanya diturunkan jadi `warn` untuk beberapa path di [`eslint.config.mjs:37`](../../eslint.config.mjs) — dan `admin/groups` **bukan** salah satunya.
- Dua jalan tanpa suppression sudah dicoba dan **tetap gagal**: restrukturisasi `try/catch`, dan indireksi `void Promise.all([...])`. Rule-nya menolak effect yang memanggil callback pembawa `setState`, apa pun bentuknya.
- Solusi akhir = satu `eslint-disable-next-line` berkomentar, mengikuti preseden yang sudah ada di [`SidebarLayout.tsx:107`](../../components/SidebarLayout.tsx) dan pola inline-IIFE di [`insentif-sales/page.tsx:2049`](../../app/(dashboard)/insentif-sales/page.tsx).

### 3.4 Hasil
Commit `2de8e19` → CI run `32569073000` **hijau** (typecheck 1m16s, build-and-push 6m18s), image terkirim ke GHCR.

---

## 4. MASALAH B — `/payments` loading terus (INTI SESI INI)

### 4.1 Gejala yang dilaporkan user
> "Bisa login, namun pada saat sudah login, terutama di halaman `/payments`, itu datanya loading terus." — PC lain di **jaringan kantor yang sama** lancar. Makin sering belakangan ini.

### 4.2 Diagnosis yang SALAH (dicatat agar tidak diulang)
Sebelum tahu gejala persisnya, dua hipotesis dikejar dan **keduanya salah untuk kasus ini**:
1. **Rate limit login kolektif.** [`lib/auth.ts:47`](../../lib/auth.ts) — `"/sign-in/email": { window: 900, max: 5 }`. Kunci rate-limit better-auth = **IP + path** (`node_modules/better-auth/dist/utils/get-request-ip.mjs` → ambil entri pertama `x-forwarded-for`), jadi satu kantor di belakang NAT berbagi kuota **5 login / 15 menit**. Ini bug nyata (lihat §6.3) tapi **bukan** penyebab, karena user bisa login.
2. **Service worker menyajikan HTML basi.** Juga bug nyata (§6.2), tapi gejalanya layar putih / versi lama, bukan spinner abadi.

**Pelajaran:** tanya dulu apa yang benar-benar muncul di layar. "Loading terus" ≠ "gagal" — spinner abadi berarti request **menggantung**, bukan error. Request yang error akan memicu `catch`; yang menggantung tidak memicu apa pun.

### 4.3 Akar masalah sebenarnya (rantai lengkap, semua terverifikasi)
1. **Satu proses saja.** [`Dockerfile.backend:40`](../../Dockerfile.backend) — `uvicorn main:app` **tanpa `--workers`**. Satu event loop melayani seluruh user.
2. **Endpoint `async def` mengerjakan operasi blocking langsung di event loop.** Di `routers/payments.py` ditemukan **24 call site** di dalam 8 endpoint `async def`: `pd.read_excel`, `save_payments_db`, `load_payments_db`, `write_invoice_excel`, `shutil.copy2`. Selama salah satunya berjalan, event loop **berhenti melayani request lain sama sekali**.
3. **Datanya satu file JSON.** [`shared.py:1358`](../../python_backend/shared.py) `save_payments_db` menulis ulang **seluruh** file dengan `json.dump(..., indent=2)` setiap mutasi, lalu membatalkan cache mtime → pembacaan berikutnya mem-parse ulang seluruh file.
4. **Frontend tanpa timeout.** [`payments/page.tsx`](../../app/(dashboard)/payments/page.tsx) — `fetch` tanpa `signal`. Kalau server tak pernah menjawab, `await` menggantung selamanya dan blok `finally { setLoading(false) }` **tidak pernah jalan** → spinner abadi, tanpa toast, tanpa jejak Sentry.

**Jadi:** begitu ada satu orang upload Excel / submit di `/payments`, event loop tersumbat; request `/payments/data` dari PC lain yang masuk saat itu menggantung dan **tidak pernah pulih sendiri**. Ini soal **timing, bukan PC-nya** — itu sebabnya terasa acak dan pindah-pindah. Makin sering belakangan ini karena file JSON terus tumbuh → jendela tersumbat melebar.

### 4.4 Perbaikan yang diterapkan

**(1) Frontend — memutus hang** ([`payments/page.tsx`](../../app/(dashboard)/payments/page.tsx))
- `AbortSignal.timeout()`: GET 45 s, POST 180 s (POST lebih longgar karena ikut generate Excel), `/api/me` 15 s.
- Pesan toast dibedakan: timeout dapat pesan "Server Python tidak menjawab dalam 45 detik (kemungkinan sedang sibuk memproses upload)".
- `isTimeoutError()` sengaja **tidak diexport** — export bernama dari `page.tsx` berisiko ditolak validasi export Next.js.

**(2) Backend — memperbaiki akar** ([`routers/payments.py`](../../python_backend/routers/payments.py))
- 24 call site blocking dibungkus `await asyncio.to_thread(...)` → event loop bebas, user lain tidak lagi menggantung.
- **KONSEKUENSI PENTING:** `to_thread` menambah titik `await`, sehingga *read-modify-write* yang tadinya **atomik karena kebetulan** (tidak ada `await` di antara load dan save) sekarang bisa interleave → **lost update**. Enam route sudah aman karena berada di dalam `async with _PAYMENTS_DB_LOCK`. Dua route **tidak**: `payments_delete` dan `payments_submit` — keduanya kini dibungkus `await _PAYMENTS_DB_LOCK.acquire()` + `try/finally release()`. Tanpa langkah ini, perbaikan #2 justru **menambah** bug baru.

### 4.5 Bukti verifikasi
- `python -m py_compile routers/payments.py` → OK.
- Test invariant baru [`python_backend/test_payments_event_loop.py`](../../python_backend/test_payments_event_loop.py) — 3 test, semua lulus:
  - tidak ada blocking call langsung di `async def`;
  - setiap `save_payments_db` dipanggil sambil memegang lock;
  - tidak ada `acquire` bersarang (`asyncio.Lock` **tidak reentrant** → bersarang = deadlock permanen).
- Test-nya **sudah diuji-mutasi**: satu `to_thread` dikembalikan jadi blocking → test gagal dengan benar (`212 payments_upload`), lalu file dipulihkan dan test lulus lagi. Jadi bukan lulus semu.
- `npm run lint` + `npx tsc --noEmit` → bersih.
- Diverifikasi juga bahwa `async with _PAYMENTS_DB_LOCK` ganda di `payments_upload`, `payments_cart_create`, `payments_cart_submit` bersifat **sekuensial, bukan bersarang** (indent lebih dangkal) → aman.

### 4.6 ⚠️ JANGAN tambah `--workers` pada uvicorn
Jalan pintas yang tampak menggoda tapi **akan merusak data**: state payments ada di satu file JSON dan dikunci `asyncio.Lock` yang **hanya berlaku dalam satu proses**. Dua worker akan menulis file yang sama tanpa saling mengunci → *last-writer-wins*, kehilangan data diam-diam. Multi-worker hanya boleh **setelah** data payments pindah ke Postgres.

---

## 5. STATUS DEPLOY

| Perubahan | Commit | Di origin? | Di produksi? |
|---|---|---|---|
| Masalah A (json-fetch) | `a72fe58` + `2de8e19` | ✅ | ✅ (CI `32569073000` hijau) |
| Masalah B (timeout + to_thread + lock) | lihat commit terakhir sesi ini | ✅ | ⏳ **verifikasi setelah deploy** |

**Cara memastikan Masalah B benar-benar sembuh di produksi:** minta satu orang upload Excel payments, dan **pada saat yang sama** orang lain buka `/payments` dari PC lain. Sebelum perbaikan: PC kedua spinner abadi. Sesudah: data muncul normal. Kalau tetap menggantung, kecurigaan berikutnya adalah §6.4 (router lain yang masih blocking) — karena mereka berbagi event loop yang sama.

---

## 6. YANG BELUM DIKERJAKAN (temuan audit, semua bug nyata)

### 6.1 Sentry penuh issue `Failed query` — dev, bukan produksi
Puluhan issue (`137`, `111`, `110`, `90` event…) semuanya satu sebab: **Postgres dev tidak jalan**. Diverifikasi: `connect ECONNREFUSED 127.0.0.1:5432`. Semuanya **event dev** (`params: local-dev-admin` hanya mungkin saat `NODE_ENV=development` + `LOCAL_AUTH_BYPASS=true` + host localhost — lihat [`lib/local-dev-auth.ts`](../../lib/local-dev-auth.ts)). Produksi tidak terpengaruh.
**Saran:** tambahkan filter `beforeSend` di [`sentry.server.config.ts`](../../sentry.server.config.ts) supaya dev tidak lagi mengotori Sentry. Sudah ditawarkan ke user, belum diminta.

### 6.2 Service worker: `VERSION` tidak pernah dinaikkan
[`public/sw.js`](../../public/sw.js) — `VERSION = "accapi-v3"`, terakhir dinaikkan **2026-06-22**, padahal komentar di file itu sendiri memerintahkan menaikkannya **setiap deploy**. Puluhan deploy sejak itu tidak pernah mem-purge cache. Handler navigasi juga menyimpan **setiap** respons tanpa cek status (termasuk 500 dan redirect), dan Cache API **mengabaikan** `Cache-Control` — jadi header `no-store` untuk route dashboard di [`next.config.ts`](../../next.config.ts) dibatalkan oleh SW ini (risiko halaman user sebelumnya tersaji setelah logout di PC bersama).

### 6.3 Rate limit login kolektif per IP
[`lib/auth.ts:47`](../../lib/auth.ts) — 5 login / 15 menit **dibagi seluruh jaringan kantor**; percobaan salah password ikut menghabiskan kuota. Komentar di kode menyebut aturan ini "gentler than the 3/10s default" — itu **keliru**: default better-auth untuk path sign-in adalah `window:10, max:3` (rolling 10 detik ≈ 270 percobaan / 15 menit), jadi aturan custom ini justru **~54× lebih ketat**. Belum menimpa user sejauh ini, tapi akan menggigit saat banyak orang login bersamaan (mis. pagi hari).

### 6.4 Router lain masih blocking di event loop
Pola yang sama masih ada di router lain — mereka **berbagi event loop yang sama**, jadi bisa membuat `/payments` menggantung lagi:
- `routers/finance.py` — 6 call site
- `routers/sppd.py` — 4 call site
- `routers/summary.py` — 1 call site

Perbaikannya identik dengan §4.4, **tapi wajib memeriksa lock lebih dulu** (§4.4 poin KONSEKUENSI PENTING) — jangan bungkus `to_thread` tanpa memastikan read-modify-write-nya terkunci.

### 6.5 `pg.Pool` tanpa handler `error` → proses bisa mati
[`lib/db.ts:5`](../../lib/db.ts) dan [`lib/auth.ts:19`](../../lib/auth.ts) membuat dua `new Pool()` terpisah, keduanya **tanpa `pool.on('error')`**, tanpa `max`/timeout. Ini perilaku terdokumentasi `node-postgres`: error pada client idle (Postgres restart, koneksi terputus) tanpa listener → `uncaughtException` → **proses Node mati**, container restart, semua user dapat 502 sesaat.

### 6.6 `npm run lint` melint seluruh working tree
Saat ini ada **24 file dengan lint error yang semuanya untracked** (direktori lokal `ponytail/` dan `scripts/_msm_prices.ts`) — itu sebabnya CI tetap hijau. **Kalau file-file itu sampai di-commit, CI langsung gagal** oleh error yang tidak berhubungan dengan kode aplikasi. Pencegahan: tambahkan `ponytail/**` ke `globalIgnores` di [`eslint.config.mjs`](../../eslint.config.mjs). Sudah ditawarkan, belum diminta.

---

## 7. UTANG TEKNIS UTAMA (rekomendasi prioritas)

`payments.json` sebagai penyimpanan utama adalah sumber dari hampir semua masalah di §4: setiap mutasi menulis ulang seluruh file, semua mutasi diserialkan satu lock global ([`shared.py:1370`](../../python_backend/shared.py) — komentarnya sendiri menyebut ceiling ini), dan multi-worker jadi mustahil (§4.6). Perbaikan sesi ini **melebarkan langit-langitnya, tidak menghapusnya** — makin banyak data, makin sempit lagi. Migrasi tabel payments ke Postgres (yang sudah dipakai sisa aplikasi) akan menghapus §4.3 poin 3, §4.6, dan §6.4 sekaligus.
