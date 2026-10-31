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
- RBAC: **Dynamic Permission-Group** (access_group + group_permission + user_group, default-deny) OTORITATIF begitu user punya ≥1 group; legacy **role global** / **custom permissions** (user.permissions) hanya fallback untuk user yang belum pernah ber-group. Resolver tunggal `getUserPermissions()` di `lib/rbac/resolve.ts`. FastAPI tidak menghitung izin sendiri: `/api/auth/verify` mengirim `effectivePermissions` dari resolver yang sama dan `python_backend/shared.py` `user_has_permission` memakainya (ADR-001, `docs/modernization/ARCHITECTURE_ADR.md`).
- Permission key format: `"module.action"` (mis. `"off_program_control.sm_approve"`). Sumber tunggal: `lib/rbac/registry.ts` (111 key sesudah S7-1b; kunci pensiun = `KUNCI_PENSIUN`, nasib 31 kunci D-01 §D = `lib/rbac/nasib-kunci.test.ts`). Endpoint wajib pakai `requirePermission`/`requirePermissionH` — key tidak terdaftar → 403.
- Email-domain role inference dihapus. OFF-specific role (`resolveOffRoleFromUser`) tetap ada untuk audit/state-machine, TIDAK untuk authz.

---

## Core Logic Flow (Function-Level Flowchart)

### Rekonsiliasi Return KINO — koreksi dengan PAJAK_NO INV
Pasangan tambahan dikonfirmasi pengguna: KINO `C-AL0063` → Accurate `C-ALF052`, dengan aturan fallback yang sama (kode asli pada invoice yang sama selalu didahulukan).
Pasangan tambahan lain: KINO `C-HE0027` → Accurate `C-MIT058` dan KINO `322630771184` → Accurate `C-CIT780`, menggunakan fallback yang sama. Semua pasangan hanya berlaku pada Return KINO.
Mapping pelanggan lokal yang dikonfirmasi pengguna 22 Okt 2026: KINO `C-IN0050` → Accurate `C-IN0087` hanya sebagai fallback lintas invoice Return KINO. Pasangan `C-IN0050` pada invoice yang sama selalu diprioritaskan; alias hanya dipakai bila kode asli tidak ada dan `C-IN0087` ada pada invoice tersebut di Accurate. `customerCodeRaw` menyimpan kode sumber; kode pelanggan lain dan data Accurate tidak berubah. PERLU PERSETUJUAN PEMILIK sebelum rilis.
`/reconciliation` → `/api/reconciliation/kino/returns` → `reconcileKinoReturns` di `lib/off-program-control/return-reconciliation.ts`.
Baris Sales Detail `RET01` dengan `PAJAK_NO` berawalan `INV` (abaikan besar/kecil huruf dan spasi tepi) dicocokkan dengan pasangan Accurate terverifikasi. Jika qty sama dan selisih DPP dalam toleransi, hasilnya `MATCH` dengan keterangan Tidak ada selisih. Jika belum cocok atau belum ada pasangan, hasilnya `KOREKSI` dengan penyebab; KOREKSI tidak dihitung sebagai masalah. Pasangan Accurate hanya disertakan jika invoice KINO, mapping produk, dan referensi INV lengkap di REM cocok; retur aktif dengan invoice/produk yang sama tetap diperiksa. Kolom PAJAK_NO tidak ada/kosong mengikuti aturan biasa. Nomor baris sumber, invoice, referensi INV, produk, nilai, dan keterangan tetap tersedia untuk audit.
Layar menampilkan KOREKSI di tabel hasil dan filter; ekspor XLSX menaruhnya pada lembar `Detail` dengan keterangan koreksi dan selisih kosong. `reconciliation-store.ts` menyimpan hasil koreksi di JSON riwayat yang sudah ada; hitungan masalah mengecualikan KOREKSI. Riwayat lama dengan `ignoredLines` tetap terbaca. Tidak mengubah skema atau mapping. Uji: `kino-return-validation.test.ts`, `reconciliation-store.test.ts`, `tests/kino-return-inv.spec.ts`. Tidak memanggil Accurate.

### Detail Pengaturan Summary dan realisasi program (September 2026)
`/summary` -> `/summary/settings` -> API `/summary/review` -> `summary_review.py`
-> tabel SQLite `summary_review_package` pada volume Summary yang sama.

- `app/(dashboard)/summary/settings/page.tsx`: ringkasan pendek sesuai contoh URC/Priskila; buka paket rujukan dari volume (label tombol dari
  `GET /summary/review/reference`, nonaktif beralasan bila paket tidak ada), koreksi detail, periksa kesiapan, lalu publikasi eksplisit.
- `python_backend/routers/summary_review.py`: auth Summary view/edit + CSRF, batas JSON 8 MB, endpoint list/import/get/update/readiness/publish.
  Paket rujukan (audit desain 001 No 81, 27 Okt 2026): `GET /summary/review/reference` (izin `summary.view`; baca-saja: `{tersedia, sebab, periode, judul}` dari
  berkas env `SUMMARY_REVIEW_REFERENCE`; terdaftar SEBELUM `GET /{package_id}`), `POST /summary/review/reference` (izin `summary.edit` + CSRF; impor lewat
  `import_package`, idempoten per owner+hash) dan alias lama `POST /reference/september` (fungsi sama). Tidak ada berkas 404, > 8 MB 413, JSON/paket
  rusak 400. Judul paket `judul_paket(raw)` = "Summary <Bulan> <Tahun>" dari field `created` (tanpa `created` sah: "Paket Summary Program").
- `python_backend/summary_review.py`: validasi relasi ID dan master, kepemilikan, deduplikasi `(owner, source_hash)`, revisi optimistis; nilai sumber sebelum koreksi tetap disimpan.
- `python_backend/summary_review_publish.py`: validasi setting per faktur yang didukung -> satu transaksi `summary_review_package` + `summary_draft(status=published)`. Batas historis, grade, alokasi, wilayah, pilihan bonus mix, dan klaim di luar faktur ditahan dengan alasan; tidak diabaikan. `test_summary_review_publish.py` membuktikan publikasi -> perhitungan order.
- `python_backend/test_summary_review.py`: runnable check impor/koreksi/auth/CAS dengan SQLite sementara; dapat diberi path paket OCR asli.
- Efisiensi: list mengambil metadata saja memakai indeks owner/tanggal; detail mengambil satu primary key. Satu perubahan menulis satu paket dalam transaksi singkat dengan pemeriksaan revisi; maksimum 8 MB per paket, tanpa HTTP di dalam transaksi.

`summary_draft published` -> `routers/orders.py: published_rules/store_order` -> order menyimpan aturan, sumber, hasil -> `GET /orders/{id}` menyertakan aturan beku -> `POST /api/orders/{id}/invoice` (`salesman` WAJIB saat antre, C7: `lib/order-salesman` cek `accurate_employee` aktif -> `masterSalesmanId` + `salesmanListNumber` di setiap baris, bentuk sama dengan Order Principal; daftar pilihan `GET /api/orders/salesmen`) -> PostgreSQL `invoice_outbox` menyimpan payload dan snapshot program dalam satu insert. Status per order di daftar Order Masuk: `GET /api/orders/invoice-status?ids=` (baca saja).

- `lib/accurate-invoice-write.ts`: membawa bonus SKU pasti sebagai baris gratis; bonus yang SKU-nya belum dipilih menahan pembuatan payload.
- `lib/program-realization.ts`: cocokkan database (caller), record ID, pelanggan, tanggal, cabang, SKU, unit, harga, jumlah, dan diskon. Mismatch tidak menjadi realisasi; biaya bonus kosong, bukan nol.
- `lib/program-realization-store.ts`: baca faktur Accurate dan simpan hasil verifikasi pada antrean yang beridentitas tepat. Pemicu: setelah cron mengirim faktur, detail webhook/sync, atau tombol Periksa Accurate.
- `/summary/program` (`app/(dashboard)/summary/program/SummaryProgram.tsx`) -> FastAPI `/summary/program/{ekstrak,form,setujui}`: Summary Program On Faktur jalur Mistral tiga pembaca + penjaga; peringatan dijawab per baris di samping kutipan surat, Setujui terkunci sampai 0 peringatan, Form PDF ReportLab. Tidak menulis aturan promo; tombol masuk dari header /summary.
- `/summary/realization` -> `/api/summary/realization`: laporan per periode, paginasi keyset 100 order, rencana vs realisasi terverifikasi per program, jumlah bonus, waktu pemeriksaan, ekspor CSV. Nilai sebelum retur; penyesuaian retur dan harga pokok bonus belum otomatis.
- Klik nomor faktur -> `/faktur?invoiceId=&databaseId=` -> panel detail yang sudah ada -> API faktur memeriksa database sesi sebelum mengambil record. Tidak mencari atau memasangkan lewat nomor faktur.
- POST pemeriksaan realisasi memakai `lib/request-origin.ts`: Origin harus cocok dengan alamat publik terkonfigurasi (BETTER_AUTH_URL/NEXT_PUBLIC_APP_URL), bukan alamat internal proxy. Konfigurasi produksi kosong dan origin asing ditolak; `request-origin.test.ts` menguji batas ini.
- `db/migrations/0005_program_realization.sql`: tiga kolom nullable pada outbox + indeks periode dan identitas faktur; baris lama tidak diberi snapshot karangan. `lib/program-realization.test.ts` menguji diskon per PCS, bonus, mismatch, dan pengulangan pemeriksaan.
- Pengiriman Accurate tetap memerlukan gate aktif, database tujuan cocok, petugas eksplisit, dan pemeriksaan satu faktur uji. Memasang fitur tidak mengirim faktur atau mengaktifkan draft secara otomatis.

Surat Kino berlapis teks -> `python_backend/kino_letter.py` -> draft; scan memakai Mistral OCR 4.1. Kelompok/varian/kemasan/kode diisi otomatis oleh `kino_letter.match_groups` (kata surat dijelaskan nama master, atau padanan `ALIAS_KELOMPOK`), diterima hanya bila `_apply_native_kelompok` menurunkan kode yang sama; yang tidak pasti tetap kosong untuk operator. Surat "KHUSUS LD JAWA" tidak dibuat barisnya. `summary_rules.py` memeriksa kelas outlet; `outlet_class.py` menyimpan keanggotaan kode outlet dasar, `import_outlet_class.py` memuat hit list. Kelas belum dimuat menahan program. `test_kino_letter.py` dan `test_summary_rules.py` menguji parser, tier, dan kelas outlet.

### Order per cabang Accurate (O1, Oktober 2026 — DRAFT zona §3; putaran perbaikan 1)
Keputusan owner 12 Okt: pelanggan cabang X hanya dipesankan barang ber-cabang X; cabang salesman = cabang karyawannya di Accurate;
`FRN` -> SHINZUI; promo terhubung di Order Sales DAN Order Baru dengan pratinjau = tersimpan.
Kontrak O2: `docs/handover/O1-KONTRAK-ORDER-CABANG.md`. Skema: `db/migrations/0033_order_cabang.sql` / `docs/handover/DDL_O1.sql`.

`lib/sync.ts` item/list.do (`charField2` tag divisi, `suspended`) -> `barisItem` -> `lib/order-cabang.ts cabangDariTag` (konstanta `TAG_KE_CABANG` + tabel `branch`) -> `item.branch_id` (NULL = tak bisa diorder; tag tak dikenal dihitung di `tagTakDikenal` hasil sync; jawaban tanpa key `charField2` = cabang lama tetap, `tagBila`); customer/list.do `suspended` -> `customer.suspended` (field absen di detail.do webhook tidak menimpa).
Order Sales/Order Baru -> `GET /api/customers/search`, `GET /api/items/search` (`cabangTanpaBarang`), `GET /api/customers/lookup` (salesman per cabang), `GET /api/customers/rute` (FK-MSM: kode toko JKS tanpa akhiran -> pelanggan cabang salesman, `cocokKodeRute`/`pilihPelangganRute`; dipakai pemilih "Toko di rute hari ini") -> `POST /api/orders/preview` -> `cakupanCabang` (`tripwireIzin`; internal `order.view` = semua; sales = `sales_profile.sales_code` + `accurate_linked` -> `accurate_employee.branch_id`) + `periksaOrder` (pelanggan aktif/bercabang/dalam cakupan, barang = cabang pelanggan, harga per baris `putusanHarga`: master `hargaSah` = tier cabang PELANGGAN/default > 0 bila ada — harga petugas di baris itu 409 `HARGA_PETUGAS_TIDAK_DIIZINKAN`; harga petugas `order.create` > 0 hanya baris tanpa master sah) -> FastAPI `/orders/preview` (`customer_no` diteruskan) -> `hitung_promo` (aturan terbit + kelas outlet + channel) -> `result` per baris + `sidik`.
Simpan (WAJIB `sidik`, `cocokkan` -> `PRATINJAU_BERUBAH`): Order Sales FastAPI `POST /websales/orders` -> `hitung_order` (channel master + `order_cabang.periksa` cookie sesi sales -> `POST /api/orders/harga` + `hitung_promo`) -> permintaan (kuantitas + sidik); tarik `pull_once` (halaman keyset) -> `store_order` -> `hitung_order` (CRON_SECRET) -> cocok sidik -> DIBEKUKAN `draft` (lines berharga + `sumber_harga`, rules, sources, result); tidak cocok/aturan cabang/channel = `rejected` permanen (`websales_store.mark_rejected`); Next tak pasti / CRON_SECRET beda = 503 berhenti. Order Baru FastAPI `POST /orders` -> `store_order` sama (harga petugas hanya baris tanpa master sah, tidak ditimpa). Rilis O1 + O2 bersamaan (owner sesi 13).
Satuan lintas baris (owner 16 Okt 2026): `periksaOrder` menyertakan `rasio` per baris (`rasioSatuan`: unit1 = 1, unit2..5 = ratio item Accurate) di jawaban `/api/orders/harga` dan badan pratinjau ke FastAPI; `order_cabang.periksa` meneruskannya; `summary_rules.calculate`/`suggestions` mengonversi jumlah ke satuan program (`jumlah_dalam`; CTN = KRT) untuk ambang/kelipatan/potongan per satuan, semua baris yang terhitung ikut diskon; rasio yang dibutuhkan kosong -> `RasioKosong` -> `hitung_promo` 409 `RASIO_SATUAN_KOSONG` (order ditahan). Tanpa `rasio` (simulasi Summary) = satuan sama saja. "Setiap Pengambilan"/tanpa minimum = satuan `SEMUA`, hanya diskon persen.
Putaran 2: bonus promo -> `periksaBonus` (pratinjau sesudah promo; FastAPI `order_cabang.periksa_bonus` -> `/api/orders/harga` mode bonus saat simpan/tarik) -> `BONUS_TIDAK_BISA_DIORDER`; `published_rules` rusak -> `ATURAN_TERBIT_RUSAK` GLOBAL (tarikan berhenti); `outlet_channel` 401/403 -> `ChannelKonfigurasi` -> `KONFIGURASI_SERVER`; `sumber_harga` `master_default`; tautan `pindahkanProfil`. -> `POST /api/orders/[id]/invoice` memakai harga beku; salesman wajib cabang pelanggan (`salesmanBedaCabang`). Antre Faktur: `GET /api/orders/salesmen?branchId=`. Tautan akun↔karyawan: `GET|PUT|DELETE /api/admin/users/[id]/salesman` (DELETE = lepas `accurate_linked`, profil Form Kontrol tetap; ganti kode berlaporan = `KODE_DIPAKAI_FORM_KONTROL`; audit `salesman.link/unlink`). `requireCronSecret` = Bearer konstan-waktu saja.
Uji: `lib/order-cabang.test.ts` (tanpa DB), `lib/order-cabang-pg.test.ts` (PG + E2E promo lintas proses dengan `python_backend/e2e_order_promo.py`), `lib/order-route.test.ts`, `lib/order-salesman.test.ts`, `python_backend/test_order_cabang.py`, `test_websales_pull.py`, `test_orders.py`, `test_order_duplicate_gate.py`, `test_outlet_channel.py`.

UI O2 (Oktober 2026, tahap 1): `components/order/*` — `order-cabang.ts` (logika murni: kode galat O1 -> kalimat + tindakan `galatDariJawaban`, URL pencarian, `barisBedaCabang`, promo per baris/order `promoBaris`/`ringkasPromo`), `order-cabang-api.ts` (cari pelanggan/barang + probe "cabang tanpa barang", `muatCakupan`, `hitungPratinjau` yang selalu mengirim `customer_no`), `useCari.ts` (jeda 300 ms, min 2 huruf, `AbortController`), `PemilihPelanggan.tsx`, `PemilihBarang.tsx`, `PanelPromo.tsx`. Dipakai `app/(dashboard)/sales/OrderSales.tsx` (salesman; probe `GET /api/customers/search?limit=1` = cakupan cabang, `SALESMAN_BELUM_TERHUBUNG`/`SALESMAN_TIDAK_AKTIF` = penjelasan "hubungi Admin" menggantikan formulir; draf ponsel disimpan sebagai kode lalu pelanggan + barang dibaca ulang saat Pulihkan) dan `orders/OrderBaru.tsx` (petugas, semua cabang + saringan cabang, ganti pelanggan beda cabang = konfirmasi buang baris). `orders/AntreFaktur.tsx`: cabang pelanggan dari pratinjau `branch.branchId` -> `GET /api/orders/salesmen?branchId=`. `components/admin/TautanSalesman.tsx` (bagian "Karyawan Accurate (salesman)" di layar User; `GET|PUT|DELETE /api/admin/users/[id]/salesman`). Tahap 2 (kontrak O1 putaran 2): pratinjau membawa `sidik`; simpan Order Sales + Order Baru mengirim `sidik` pratinjau TERAKHIR (kunci pratinjau = channel, tanggal, pelanggan, kode/satuan/jumlah/harga petugas tiap baris — isian berubah = sidik lama usang = simpan terkunci); `PRATINJAU_BERUBAH` (409) = belum tersimpan, angka lama -> baru ditampilkan, pratinjau dihitung ulang, simpan lagi lewat dialog konfirmasi; harga petugas HANYA untuk baris tanpa harga master sah (master baca-saja, `price` tidak pernah dikirim untuk baris master); ORDER_GANDA = centang konfirmasi -> `confirm_duplicate`; kode galat O1 lainnya dipetakan di `order-cabang.ts` (`ATURAN`); ringkasan berlabel "sebelum PPN"; harga cabang default bertanda. Layar User: lepas = tautan mati (profil tetap), ganti kode berlaporan = konfirmasi (`konfirmasiGantiKode`), profil akun lain = pindahkan (`pindahkanProfil`). Promo "hampir dapat" (`suggestions[]` server, bentuk `summary_rules.suggestions`): `bacaSaran`/`pecahSaran` -> kartu kemajuan per baris (`KartuPromoBaris` di `PanelPromo.tsx`); tombol "Tambah N UNIT" HANYA program jumlah satu kode = kode baris dengan satuan program (dibaca dari kalimat server) = satuan baris — tombol hanya mengubah jumlah (pratinjau dihitung ulang, sidik lama batal, tidak pernah menyimpan); mix tanpa tombol ("Dihitung dari" di baris pertama), program nilai di ringkasan order; program tercapai = penanda "Program X terpakai". Uji: `components/order/order-cabang.test.ts`; Playwright `tests/fiori-order-cabang.spec.ts` + mock bersama `tests/helpers/order-cabang-mock.ts`.
O3 riwayat beli toko (12 Okt 2026 sesi 13): panel "Biasa diambil toko ini" `components/order/RiwayatBeli.tsx` (Order Sales + Order Baru, sesudah pelanggan dipilih) -> `GET /api/customers/riwayat-beli?customerNo=&bulan=3` (izin/cakupan = `customers/search`; `cakupanCabang` + `tolakCabangLain`) -> SATU kueri `sales_invoice` per pelanggan (indeks `customer_no`; `trans_date` teks dd/MM/yyyy, `raw_data` string JSON -> `detailItem[]` hanya untuk faktur di jendela 90 hari, CTE `w` MATERIALIZED = diurai sekali per faktur; faktur rusak — tanggal mustahil / raw_data bukan JSON — dilewati + dihitung `ringkasan.dilewati`, bukan 500; faktur yang dihapus di Accurate masih terhitung: cache tanpa penanda) -> `lib/riwayat-beli.ts` (murni: `ringkasRiwayat` per barang + satuan, `bulanTeramati` = definisi rata-rata, bonus harga 0 tidak dihitung, faktur tanpa rincian dilaporkan) + master `item` (`alasanBonus` = barang yang kini tak bisa diorder bertanda). Tombol Tambah: `bacaBarangKode` (items/search cabang pelanggan; dibatalkan bila pelanggan diganti sebelum jawaban tiba) + `satuanTambah` -> `sisipkanBaris` (jumlah = `jumlahTambah` pembulatan ke atas) -> pratinjau dihitung ulang (sidik). Uji: `lib/riwayat-beli.test.ts`, `lib/riwayat-beli-pg.test.ts`, Playwright `tests/fiori-order-cabang.spec.ts` (O3). Kontrak: `docs/handover/O1-KONTRAK-ORDER-CABANG.md` §3.

### Aturan Promo, Rekap Promo & Normalisasi Diskon (Oktober 2026)
`/aturan-promo` -> `GET/POST/PATCH/DELETE/PUT /api/promo-rule` -> tabel `promo_rule` (sama dengan importir Rekap Promo dan jembatan Summary).
`/rekap-promo`, `/normalisasi-diskon` -> `GET /api/promo-recap` -> `lib/promo-recap.ts recap()` atas `sales_invoice.raw_data` + `promo_rule` aktif + `promo_outlet` + `discount_normalization`.

- Saringan **Periode** Aturan Promo: `?dari=&sampai=` (ISO), semantik BERSINGGUNGAN (`bersinggungan()` di `lib/promo-recap.ts`): ujung kosong = tak terbatas di aturan maupun saringan; digabung dengan principal/jenis/beban/q di server. Rentang terbalik -> 400.
- **Normalisasi wajib beraturan**: `alasanTakBerlaku(rule, baris, golongan, daftarOutlet, poPertama)` = satu-satunya definisi "aturan berlaku" — principal = cabang faktur, tanggal dalam periode, outlet diizinkan daftar peserta / tarif milik outlet, bentuk potongan (tingkat faktur ↔ aturan seluruh nota; per barang ↔ aturan barang itu atau tarif outlet), PO pertama, beban (Disc Claim = PRINCIPAL, Disc Distributor = DISTRIBUTOR). Nilai/posisi sengaja tidak dicocokkan.
  - Rujukan keputusan = KUNCI aturan `kunciAturan()` (principal, surat, kelompok, barang, outlet, tingkat = kolom `idx_promo_rule_key`), id hanya jejak/cadangan. Impor Summary/Excel yang mengganti id tidak memutus keputusan; isi aturan tetap dinilai ulang tiap rekap.
  - `recap()` mengisi `calonAturan` per baris tak bertuan dan hanya memakai keputusan yang aturannya masih berlaku; `aturanId` = id aturan yang berlaku SEKARANG. Disc Claim yang dipakai masuk program surat yang dirujuk (`ProgramRecap.normalisasi/normalisasiBaris` = bagiannya, tampil "termasuk Rp … dari normalisasi" di Rekap Promo); tidak ada lagi baris program "NORMALISASI".
  - Keputusan yang TIDAK dipakai (lama tanpa aturan — keputusan pengguna 2 Okt 2026; aturan hilang/nonaktif/tak berlaku; nominal berubah) tetap tersimpan dan melekat di barisnya (`bekasNormalisasi` + sebab), bisa disaring di Normalisasi Diskon dan dirujukkan ulang (simpan menimpa keputusan lama).
  - Pilihan di layar = SURAT yang punya aturan berlaku untuk setiap potongan terpilih; tiap potongan memakai aturannya sendiri (aturan surat dibuat per barang). `POST /api/promo-recap/normalisasi` wajib `rows[].promoRuleId` per baris (`promoRuleId` di badan = cadangan); opsi layar "Otomatis per baris" hanya memilih bila potongan punya TEPAT SATU aturan bernilai sama (selain itu dilewati); aturan hilang/nonaktif -> 409, tidak berlaku -> 422 dengan sebabnya. Syarat PO pertama hanya dinilai rekap (butuh riwayat).
  - `db/migrations/0025_discount_normalization_rule.sql`: `discount_normalization.promo_rule_id bigint` + `promo_rule_key text`, NULL-able, TANPA FK (impor mengganti id aturan; keputusan yang kuncinya hilang tidak dipakai rekap, bukan dihapus).
- Uji: `lib/promo-recap.test.ts` (penjaga + periode, logika murni), `tests/normalisasi-aturan-promo.spec.ts` (Playwright, API dipalsukan).

### Ruang Kerja (shell Fiori sejak S1a, Oktober 2026)
```
DashboardLayout -> session + RBAC union -> SidebarLayout (identitas akun)
  -> config/workspace-navigation.ts: 18 modul dalam 6 kelompok + Beranda
  -> navigasi samping Fiori (kelompok dari izin) + cari menu Ctrl K; favorit/rail lama dihapus (S1a)
Beranda (Fiori, S1b) -> profil peran dari izin -> tile tugas (lib/beranda.ts, GET endpoint yang ada; profil kasir: /api/kasir/ringkasan, K3) + Pintasan + Pantauan + Semua aplikasi
  -> Admin Incaso (pelunasan.kirim, S6e-2b): tile Tidak pasti/Gagal + Pantauan dari GET /api/idempotency/summary?rows=1 (perDatabase,
     database aktif dari /api/auth/accurate-session); jawaban tanpa angka/daftar = galat, bukan 0
RootLayout -> app/globals.css (dasar Tailwind: target sentuh, fokus, reduced-motion) + app/fiori.css; semua isi di dalam .fiori
  (tema lama Office Calm/Neon/iOS/Surya pensiun, remap kelas Tailwind lama dihapus)
SidebarLayout (shell Fiori, S1a) -> shell bar: logo resmi, cari menu Ctrl K, menu profil (Mode/Density, Bantuan -> ChatWidget, Keluar)
  -> navigasi samping dari izin; drawer ponsel (Dialog native); navigasi bawah = Beranda + 3 pintasan ROLE_PROFILES + Menu;
     profil = ★ grup utama (`profileFor`, peta nama preset S7-3), fallback tebakan izin (`roleProfile`)
```
Validasi: `npx tsx --test components/SidebarLayout.test.ts` dan
`npx playwright test tests/workspace-redesign.spec.ts tests/sidebar-tooltip-contrast.spec.ts`
pada server development lokal (navigasi, Ctrl K, menu profil, drawer/navigasi bawah ponsel, chat, kontras terang/gelap).
Referensi visual: `docs/design/surya-workspace-reference.png`.

### Design system Fiori (S0, Oktober 2026)
```
RootLayout -> app/fiori.css (token + kelas fi-*, di-scope ke .fiori; halaman lama tidak berubah)
  -> skrip pra-render components/fiori/scheme.ts: localStorage fiori-scheme/fiori-density -> html[data-scheme|data-density]
Halaman yang dimigrasi -> <FioriScope> (components/fiori/Scope.tsx: Plus Jakarta Sans + Geist Mono)
  -> components/fiori/core.tsx (presentasional) + interactive.tsx (dialog, form, filter bar, SchemeSwitcher)
/dev/ui-kit -> semua komponen x 6 keadaan; 404 di build produksi
```
Validasi: `npx playwright test tests/fiori-ui-kit.spec.ts` pada server development lokal (LOCAL_AUTH_BYPASS);
baseline di `tests/fiori-ui-kit.spec.ts-snapshots/`. Aturan: `docs/UI_DESIGN_SYSTEM.md`.
Arah visual tunggal untuk agen/skill desain: `DESIGN.md` (token + aturan, format design.md) dan `PRODUCT.md` (pengguna, prinsip).
Audit desain 001 (25 Okt 2026, 151 temuan + laporan akhir): `docs/audit/audit-desain-001-2026-10-25.md`. Semua halaman dashboard
kini Fiori (enam halaman lama master data/klaim/summary dimigrasi; spec `tests/fiori-master-lama.spec.ts`).
Format tampilan bersama: `lib/tampil.ts` (`KOSONG`, `tanggalWita`, `waktuWita` dd/mm/yyyy hh.mm WITA, `hariIniWita`, `sebabHttp`);
helper tanggal lokal per modul mendelegasikan ke sini. Hanya teks tampilan, tidak untuk nilai yang dikirim ke server.
ConfirmDialog menulis alasan nonaktif di kaki dialog kecuali teks yang sama sudah ada di isi dialog; Button `disabledReason` =
`aria-disabled` (tetap bisa di-Tab) + gelembung alasan, klik/submit ditahan.
Hasil browser desktop/mobile: `docs/design/surya-workspace-desktop.png`, `docs/design/surya-workspace-mobile.png`.
Checkpoint implementasi dan instruksi resume: `docs/SURYA_IMPLEMENTATION.md` (keputusan, bukti validasi, file yang disentuh, lingkungan uji, dan langkah berikutnya).
Status: UI redesign tervalidasi lokal. Audit build menemukan tracing `webhook-backfill -> next.config.ts` memasukkan kunci OCR lokal; pengemasan dihentikan dan salinan kunci di artefak dihapus. Lihat handover sebelum deployment.

### 0. Laporan Harian Sales & Stock
```
UI upload laporan harian
  -> python_backend/routers/laporan_harian.py
  -> laporan_harian.load_inputs() -> laporan_harian_pq.build_fix()  (replika query "2. To Format Laporan")
       penjualan = Rincian Faktur Penjualan INV / "1. Paste Data" (Paste Acc); retur = Rincian Retur Penjualan (No.Retur) /
       Rincian RJN; export Accurate yang judulnya beda dari sheet Paste dibaca per posisi kolom (seperti ditempel admin)
       atau FIX LAP PENJ jadi (fix_from_table)
  -> laporan_harian_pq.SalesBase  (replika query SalesBase "2.3 To SPV dan SM New": flag AO/EC/IA/Nota Retur/Batal)
  -> laporan_harian.load_stock() -> master_stock()  ("3. Stock" Sheet1; export Accurate dipetakan)
  -> laporan_harian.write_report_files() -> laporan_harian_pq.build_report() + write_workbook()
       -> 22 keyword LaporanAuto + JONAL, sama persis dengan arsip/sheet 2.3 (nilai, kolom, urutan baris, nama sheet, format)
  -> laporan_harian_manager.write_manager_report() -> Excel + HTML Pak Fahdhar untuk unduhan/screenshot
       -> agregasi JUMLAH net retur sekali, mapping cabang/principal -> SPV/SM; target periode belum tersedia tetap kosong
Paritas: laporan_harian_bandingkan.py <hasil> <arsip LaporanAuto> (sel demi sel); test_laporan_harian_pq.py
  (fixture + acuan dari Excel via laporan_harian_excel_pq.py)
```

### 1. Autentikasi & Guard Halaman
```
Browser -> /login page (app/(auth)/login/page.tsx; kerangka Fiori app/(auth)/layout.tsx untuk login/lupa/atur ulang/daftar)
  -> authClient.signIn.email -> /api/auth/sign-in/email (lib/auth.ts; 5 percobaan/15 menit/IP)
  -> Better Auth + Drizzle Postgres (tabel user/session)
  -> window.location.assign("/") | galat generik (401) · "belum diverifikasi" (403) · "terlalu banyak percobaan" (429)
  ?error= (hari ini hanya /api/auth/callback tanpa sesi app) -> kalimat terpetakan; kode tak dikenal -> kalimat umum (teks query tidak dicetak)

Browser -> /forgot-password -> authClient.requestPasswordReset -> layar NETRAL identik (tanpa mengulang email)
  -> email tautan /api/auth/reset-password/<token> -> /reset-password?token=… | ?error=INVALID_TOKEN
  -> /reset-password: tanpa token/tak berlaku -> "Tautan tidak berlaku" + Minta tautan baru; sandi ≥ 6 + ketik ulang sama -> authClient.resetPassword

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

**Sesi Accurate (S7-sesi, AM-033, 11 Okt 2026).** Masuk Accurate + pilih database tanpa Konsol: halaman `/sesi-accurate`
(pagePermissions `anyOf` = `SESI_ACCURATE_KEYS`: `api_wrapper.view` | `order.edit` | `pelunasan.kirim` | `finance.update` |
`finance.resolve_unknown`; tautan di menu profil). Kartu `components/accurate/SesiAccurate.tsx` dipakai juga oleh Konsol `/api-wrapper`.
```
Kartu "Masuk Accurate" -> GET /api/auth/accurate-login?returnTo=<daftar putih>
  -> Sec-Fetch-Site=cross-site -> alasan=lintas_situs; tanpa sesi app -> /login?error=…; baca sesi melempar -> alasan=galat_server
  -> state = randomBytes(32); Set-Cookie __Secure-accurate_oauth_state="<state>:<returnTo>" (HttpOnly, Secure, SameSite=Lax, 600 dtk, Path=/api/auth/callback)
  -> 307 https://account.accurate.id/oauth/authorize?client_id&redirect_uri&scope(TETAP, lib/accurate-oauth.ts)&state
Accurate -> GET /api/auth/callback?code&state
  -> baca sesi app melempar     -> alasan=galat_server (bukan 500)
  -> tanpa sesi app            -> /login?error=Accurate+login+requires+app+session (nilai lama, dibaca S7c)
  -> cookie state tidak ada     -> alasan=state_hilang   (code TIDAK ditukar)
  -> state query hilang/beda    -> alasan=state_beda     (code TIDAK ditukar; cookie DIBIARKAN: tab lain/pihak luar tak membatalkan)
  -> tanpa code / env kurang    -> alasan=tanpa_kode / konfigurasi
  -> POST oauth/token gagal / tanpa access_token -> alasan=tukar_token_gagal (log: status HTTP saja)
  -> exception                  -> alasan=galat_server (log: nama galat saja)
  -> sukses: upsertAccurateSession(token, database dikosongkan) -> accurate=connected
  -> cabang lain menghapus cookie; mendarat di halaman berkartu: returnTo=/api-wrapper -> /api-wrapper?…,
     selain itu -> /sesi-accurate?…[&returnTo=/pelunasan|/antrean-faktur|/finance] (tombol Kembali)
Kartu membaca ?accurate=&alasan= -> MessageStrip dari pemetaan kode (GALAT_ACCURATE), lalu membuang keduanya dari URL.
Route sesi (GET/DELETE accurate-session, GET db-list, POST open-db, accurate-login, callback) cukup sesi app — tidak ada kunci; tidak ada
route tulis baru. open-db sukses = {ok, databaseId, databaseAlias, host} (session database Accurate tidak ke peramban; GET dihapus).
Kartu: Ganti database (open-db menimpa), Keluar lewat konfirmasi, daftar kosong = keadaan kosong, 401 = tautan masuk ulang.
Gerbang klien: SidebarLayout menghitung ulang canAccessPathWithKeys(usePathname) — navigasi klien ke halaman terlarang = AccessDenied
(layout server tidak berjalan ulang pada navigasi klien; otoritas tetap server + guard API).
db-list/open-db galat = {ok:false, code, error netral}: SESI_BELUM_TERHUBUNG 400, DATABASE_ID_KOSONG 400, ACCURATE_MENOLAK 502
  (+accurateStatus), GALAT_SERVER 500 — isi jawaban Accurate/pesan exception tidak ke peramban maupun log.
```
**Gerbang halaman Konsol (S7-sesi).** `proxy.ts` memasang `x-current-path` yang dibaca layout. Matcher lama `(?!api|…)` ikut melewatkan
halaman `/api-wrapper`, sehingga layout menilai "/" dan `dashboard.view` cukup membuka Konsol. Kini hanya `/api` dan `/api/...`
dikecualikan (`lib/proxy-matcher.test.ts`). **Dampak produksi saat rilis:** user tanpa `api_wrapper.view` (mis. Fakturist, Admin Incaso)
kehilangan Konsol (Akses ditolak); login Accurate + pilih database pindah ke `/sesi-accurate` (menu profil).

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
Peran OFF (lib/off-program-control/access.ts normalizeOffRole): S7-1b AM-026 (D-01 §C "manager bukan admin") — role `manager`
  = peran sendiri: PEMBACA 7 tab + audit_read/audit_export saja; tidak lolos periode tutup, tanpa alternatif role admin di refund.
  Admin tidak berubah. Ekspor CSV audit = audit_read ∧ audit_export. "Manager bukan admin" HANYA OPC (owner 12 Okt): Claim Workflow
  tetap memperlakukan Manager seperti sebelum S7-1b — requireClaimSession (lib/claim-workflow/access.ts) memetakan manager -> admin
  (kelola klaim, route close/items/void).

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
     -> route.ts [POST] — forward ke Accurate API (sessionHost + Bearer apiKey) lewat lib/accurate-forward.ts
        (menolak 403 PURCHASE_PAYMENT_VIA_FINANCE tulis purchase-payment/(bulk-)save.do — hanya lewat command Finance di bawah;
         menolak 403 SALES_INVOICE_VIA_OUTBOX tulis sales-invoice/(bulk-)save.do — hanya lewat Antrean Faktur, S6-0d E4;
         tulis sales-receipt = cabang Pelunasan di bawah (pelunasan.kirim; api_wrapper.execute tidak diminta & tidak cukup);
         S7-1b AM-024: tulis LAIN = api_wrapper.execute (403 PERMISSION_REQUIRED {permission, sent:false}) + hanya save/bulk-save
         katalog Konsol config/accurateRoutes.js (isCatalogWrite; delete.do & endpoint tak dikenal 403 ENDPOINT_TIDAK_DIIZINKAN) —
         semua SEBELUM sesi Accurate/DB/jaringan; baca = GET jalur kanonik {list,detail,get-stock,list-stock}.do (isAccurateRead),
         cukup sesi app (Finance & Pelunasan membaca tanpa api_wrapper.*). [PROXY FIRE] tulis mencatat id pengguna.)
     <- JSON response
  Klien: lib/apiFetcher.ts classifyWriteError — 4xx + sent:false = rejected (tidak terkirim), bukan TIDAK PASTI; Konsol berhenti
  di tahap yang ditolak dan menampilkan pesan server.

Antrean Faktur / outbox sales-invoice (S6-0d, DRAFT — zona tulis Accurate):
  antre: POST /api/principal-order/queue | /api/orders/{id}/invoice -> lib/invoice-outbox-actions antrekan()
     -> invoice_outbox(queued) + invoice_outbox_event `antre` (satu transaksi); kunci PERNAH dibuang -> cariFaktur dulu
  kirim: POST /api/invoice-outbox/send (order.edit) | GET /api/cron/post-invoices -> lib/invoice-sender sendQueuedInvoices
     -> sapuSending (sending > 15 mnt -> unknown + event `sapu`) -> rencanaKirim (kueri created_at, order_id; tanggal pilihan;
        tolak persen+rupiah) -> cekSesiBacaSaja (GET branch/list.do; gagal = batal tanpa klaim)
     -> per baris: CTE klaim queued->sending + event `kirim` (aktor) -> save.do -> classifySaveResponse:
        {s:true,r.id bulat positif}=posted; {s:false,d:[teks…]} non-5xx (bukan 401/403/429) = rejected; lainnya = unknown
        (klaim mensyaratkan payload yang diperiksa; yang dikirim = payload RETURNING klaim)
     -> CTE hasil (WHERE state='sending') + event (status HTTP, potongan ≤ 500, kode galat)
  pratinjau BL-39: GET /api/invoice-outbox/send/preview -> pratinjauKirim (rencanaKirim yang sama + nilaiPayload)
  antre ulang/buang: POST /api/invoice-outbox -> aksiAntrean: resend = cariFaktur dulu (ketemu -> posted, tidak dikirim;
     gagal -> 409); discard = DELETE baris + event `buang` (salinan baris)
  tidak pasti: POST /api/invoice-outbox/resolve (order.resolve_unknown) -> selesaikanTidakPasti: pencarian langsung +
     alasan ≥ 15 -> posted (wajib ketemu) | rejected (wajib tidak_ketemu_dicek DAN kirim terakhir ≥ 15 mnt, jam DB) + event
  cariFaktur (lib/invoice-search, BACA SAJA): cache sales_invoice per customer_no + created_at ≥ antre −1 hari (hit cache
     dikonfirmasi 1 detail.do) -> list.do filter.customerId + filter.lastUpdate ≥ antre −10 mnt (TERBUKTI §I 10 Okt; tetap
     disaring ulang, batas 300 baris) -> charField1 di baris list.do diputuskan langsung (EQUAL); absen/kosong -> detail.do
     (≤ 25 calon): kepala, baris, lalu description "Order <kunci> |". Tanpa filter.charField1 (diabaikan Accurate).
  riwayat: invoice_outbox_event append-only (migrate-pg; trigger/REVOKE + E5 data lama = docs/handover/DDL_OUTBOX_EVENT.sql)
     baca: GET /api/invoice-outbox/riwayat?orderId= (order.view) -> bacaRiwayat: 200 TERBARU urut lama→baru + `terpotong`,
       tanpa salinan payload event `buang`
  UI (S6c Fiori): /antrean-faktur -> AntreanFaktur.tsx (kartu status = GET /api/invoice-outbox ?state= | ?overdue=1)
     Kirim = Dialog.KirimDialog: GET send/preview -> POST send { orderIds HASIL PRATINJAU, invoiceDate } -> hasil per order
     (Kirim memeriksa ulang pratinjau tepat sebelum POST; berubah = batal + dialog diperbarui; pilihan = baris yang terlihat)
     Selesaikan = GET /api/invoice-outbox/resolve?orderId= (cariTidakPasti, BACA SAJA: pencarian + salinan lokal + sisa
       masa tunggu, tanpa penyapu; sekaliJalan per penekan×order; sesi wajib pada ACCURATE_INVOICE_DB_ID terisi) -> POST resolve
       (mencari ulang; keputusan selalu dipilih petugas); Antre ulang/Buang (alasan wajib di layar) = POST /api/invoice-outbox;
     jawaban tidak pasti (putus/batas waktu, bukan JSON, >= 502 tanpa amplop {ok:false,error}) = "belum pasti" + muat ulang +
       tulis terkunci; Verifikasi balik = /api/invoice-verify
  Verifikasi balik (audit desain 001 No 6, owner 27 Okt 2026): POST /api/invoice-verify (order.edit) {orderId, jenis sales|isi, sidik, note}
     -> note WAJIB untuk kedua jenis (Terima sales = alasan dari dialog; tanpa kalimat bawaan lagi), maks. 500 karakter (lib/pencabutan; lebih = 400,
        tidak dipotong) -> upsert invoice_verify_note
     DELETE /api/invoice-verify (order.edit) {orderId, jenis, alasan} -> alasan 10..500 karakter (lib/pencabutan; di luar = 400 SEBELUM DB)
        -> db.transaction: DELETE invoice_verify_note ... RETURNING + INSERT pencabutan_log (jenis invoice_verify_note, kunci "<order_id>|<jenis>",
           baris_lama, alasan, oleh = email sesi); log gagal = DELETE batal. Jawaban {ok, dicabut}.
  Cabut konfirmasi order ganda (audit desain 001 No 18): DELETE /api/principal-order/dupe-ack?principal=&soNo= (order.create) + body {alasan}
     -> aturan alasan sama -> db.transaction: DELETE order_dupe_ack ... RETURNING + INSERT pencabutan_log (jenis order_dupe_ack,
        kunci "<principal>|<so_no>"). UI: LangkahBatch.tsx dialog Cabut (alasan wajib; batas sama ditolak di dialog). GET/POST dupe-ack tidak berubah.

Posting purchase-payment Finance (AM-014 / C.12, DRAFT):
  UI Finance (/finance, Fiori S6b: finance/posting.ts postingPurchasePayment — urutan & clientRef = recordKey lama; dialog pp)
  -> GET /api/auth/accurate-session (database terbuka; dialog pp membaca SEGAR, id = expectedDatabaseId; beda = berhenti
     sebelum tulis) -> FastAPI GET /payments/finance/data (baca ulang baris; nilai/faktur/status berubah = batal tanpa
     tulis, S6b B-5) -> FastAPI /payments/finance/mapping -> /payments/finance/proof
  -> POST /api/finance/purchase-payment (finance.update) {clientRef, expectedDatabaseId, payload} — tanpa expectedDatabaseId
     = 400, database sesi saat POST ≠ expectedDatabaseId = 409 {code: database_changed, claimed:false} SEBELUM klaim (S6b A-1)
     -> lib/accurate-write-attempt.ts runGuardedWrite: INSERT ... SELECT accurate_write_attempt state=sending
        generasi 0 (ADR-004 rilis A; subjek ber-reopen -> 409 reopened_use_repost {claimed:false}, tanpa klaim/kiriman) — unique partial index per
        himpunan faktur × generasi; attempt hidup -> 409 {live, generation, currentGeneration} SEBELUM kirim
     -> forwardAccurate purchase-payment/bulk-save.do (tanpa transaksi DB terbuka)
     -> classifyProviderReply -> posted / unknown / not_sent (C11: penolakan Accurate belum terbukti = unknown)
  -> UI melaporkan status ke FastAPI POST /payments/finance/update (payments.json) seperti semula
  Penyelesaian TIDAK PASTI: POST /api/finance/purchase-payment/resolve (atestasi manual + sumber cek;
    hanya finance.resolve_unknown). Gagal sebelum klaim = {claimed:false} (pasti tidak terkirim).
  payments.json: "failed" lama bergalat ambigu (timeout/502/504/non-JSON/jaringan) = unknown
    (shared.effective_post_status) -> terkunci sampai diselesaikan Finance.
  Ledger: pemegang finance.resolve_unknown tanpa finance.update menuntaskan /payments/finance/update HANYA untuk
    unknown -> posted/failed + catatan (S6-0e). Belum Transfer/Ajukan Ulang ditolak 409 bila posted/unknown (BL-49).
  Baca status: GET /api/finance/purchase-payment/attempts?invoices=… (finance.view, latestAttemptsBySubject; S6-0e).
  Pemilih tujuan (S6b): /api/proxy method GET vendor/list.do & glaccount/list.do (Kas/Bank) — baca-saja, master Accurate sesi.

Idempotency guard (bulk sales receipt, API Wrapper; gerbang = endpoint routeConfig.path, bukan URL halaman):
  Orkestrasi klien = lib/pelunasan/kirim.ts kirimPelunasan (S6e-2): lock -> paket 100 -> hasil per baris
     {terposting | gagal (sent:false) | tidak_pasti | ditahan} -> complete. Kontrak: docs/handover/S6e2-KONTRAK-API.md.
  -> POST /api/idempotency/lock — preview + kunci fingerprint (lib/sales-receipt-fingerprint.ts) di idempotency_log
     (pemilik lockId/lockedBy; non-preview butuh pelunasan.kirim; override hanya finance.override_duplicate + alasan ->
     idempotency_override, termasuk allowHistoryKeys = blockReason ACCURATE_HISTORY; kunci ISI_KODE_AKUN_ = 400)
  -> POST /api/proxy sales-receipt/bulk-save.do WAJIB idempotencyLockId + expectedDatabaseId (lib/sales-receipt-guard.ts):
     placeholder akun 400 -> pelunasan.kirim 403 -> database sesi ≠ expected 409 database_changed -> lock dinilai
     (dry-run) -> riwayat Accurate dibaca server (lib/pelunasan/pratinjau-ganda.ts periksaRiwayatAccurate, fail-closed,
     4 serentak, 60 dtk) -> baris yang punya SATU faktur bernominal sama (per faktur, tanpa potongan, tanpa beda huruf)
     dengan pelunasan pelanggan+tanggal mana pun / tak terbaca tanpa override 409 ACCURATE_HISTORY ->
     baris milik lock ditandai SENDING -> kirim -> hasil per baris dicatat SERVER (classifySalesReceiptReply:
     s:true = SUCCESS, selain itu UNKNOWN — C11; server tidak pernah menyimpulkan FAILED)
  -> POST /api/idempotency/complete — klien hanya menaikkan; FAILED hanya untuk baris PROCESSING (belum dikirim)
  -> GET/POST /api/idempotency/resolve — Selesaikan tidak pasti (finance.resolve_unknown; cari dulu = kandidat pelunasan
     pelanggan+tanggal yang menyentuh faktur segmen key; tidak_ada ditolak 409 similar_found bila ada; terposting kandidat tak
     identik wajib acceptSimilar (409 similar_not_identical; hint takeover = override takeover lock; identik hanya bila sidik jari
     key terurai pasti: Σ bayar+potongan = amount baris, tanpa angka negatif); lalu CAS status +
     jejak idempotency_resolution, lib/idempotency-resolve.ts). Lock mencatat database di idempotency_log."databaseId" DAN
     idempotency_override.database_id (DDL_S6E2.sql); proxy menolak bila salah satunya ≠ database sesi
  -> GET /api/idempotency/summary — Tidak pasti / Gagal boleh diulang (BL-41; pelunasan.kirim ATAU finance.resolve_unknown)
  UI (S6e-2b): /pelunasan wizard Jenis -> Unggah -> Akun -> Tinjau -> Hasil (app/(dashboard)/pelunasan/*); pratinjau membaca ulang sesi
     di akhir (database berganti selama pratinjau = dibuang); nomor Hasil = nomor terposting (item r.number / keputusan Selesaikan),
     nomor mirip di kolom Excel terpisah; galat lock dipetakan menurut
     GalatKirim.code; Selesaikan (Selesaikan.tsx: GET pencarian dulu -> POST keputusan; kode 409 menutup pilihan) dari Hasil dan dari
     daftar Perlu tindakan (?rows=1) di langkah Jenis

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
     -> /payments/upload — parse Excel LPB, simpan ke payments.json (?dry_run=1 = pratinjau; berkas backup DITOLAK)
     -> /payments/sppd/restore-backup — restore backup PAYMENTS (sppd.edit_settings + CSRF + ?dry_run=1)
     -> BL-05 shared.payment_lock_reason: Sudah Transfer / posted / unknown TERKUNCI di update, delete, clear,
        Excel SPPD (apply_sppd_excel_rows, ?dry_run=1), replace-principle-name (?dry_run=1) & auto-fix (dilewati)
     -> /payments/submissions (+/{id}) — baca Pengajuan & SPPD, berkas yang benar-benar ada (BL-50)
     -> /payments/finance/data — data finance approval
     -> /payments/finance/proof — upload bukti transfer
     -> /validator/upload — upload data penjualan/channel
     -> /validator/run — validator_engine.py [compare expected vs actual]
     -> /sppd/generate — render_sppd_docx() — buat DOCX SPPD
     -> nomor SPPD (shared.next_sppd_number): {seq:03d}/SPA/PDSB/{romawi}/{tahun}, tanggal terbit WITA; tahun baru
        mulai 001; di dalam satu tahun tidak pernah turun (setelan 409, restore backup hanya menaikkan) — D-05/C10
     -> auth.py — rate limiter login + security headers; izin = effectivePermissions dari Next /api/auth/verify (shared.user_has_permission)
```

### 6A. Repository Guardian & Risk Issue Sync
```
pull_request (fork/same repository)
  -> .github/workflows/pr-guardian.yml [contents:read; tanpa secrets/comment write]
  -> public Git fetch tanpa token untuk PR head + Guardian dari base SHA tepercaya secara terpisah
     [bootstrap pertama saja: exact SHA dari repository variable GUARDIAN_BOOTSTRAP_SHA]
  -> scripts/guardian/pr-guardian.mjs
       -> git diff --name-status -z (tanpa shell interpolation)
       -> classifyChanges() -> domain + LOW/MEDIUM/HIGH/CRITICAL
       -> selectChecks() -> lint/typecheck, Python compile, dan test repository yang benar-benar tersedia
       -> tests/guardian dipulihkan dari Guardian base tepercaya sebelum self-test agar PR tidak dapat melemahkan test-nya sendiri
       -> runChecks() -> hasil eksplisit PASSED/FAILED/NOT EXECUTED
       -> renderGuardianReport() -> PASS / PASS WITH WARNINGS / HUMAN REVIEW REQUIRED / BLOCKED
  -> job summary; required check gagal memblokir gate, sedangkan HIGH/CRITICAL wajib review manusia via branch rule + CODEOWNERS
  -> .github/CODEOWNERS menetapkan dua collaborator aktif terverifikasi sebagai owner seluruh repository

push SYSTEM_MAP.md ke main / workflow_dispatch
  -> .github/workflows/system-map-issues.yml [contents:read + issues:write; concurrency tunggal]
  -> scripts/guardian/system-map-issues.mjs
       -> extractRisks() hanya blok <!-- accapi-risk ... --> eksplisit
       -> planIssueSync() -> CREATE/UPDATE/SKIP/REOPEN/STALE
       -> hanya issue berlabel accapi-guardian yang boleh memiliki fingerprint otoritatif; marker issue publik tanpa label diabaikan
       -> CREATE wajib stabil pada 3 pembacaan API; batas integer 5 CREATE/25 mutasi; duplicate fingerprint fail-closed
       -> closed issue hanya REOPEN bila operator mengaktifkan allow_reopen
       -> source hilang ditandai VERIFICATION REQUIRED, tidak pernah auto-close
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

### 8. Rekapan Nota (Wave-Based Picking)
```
--- 8.1 Upload export Accurate (menggantikan paste manual) ---
UI /rekapan-nota -> upload "Rincian Faktur Penjualan" (.xlsx dari Accurate)
  -> POST /api/rekapan-nota/upload
     -> requirePermission("rekapan_nota.manage")
     -> lib/rekapan-nota/parse.ts : parseAccurateExport()
          * petakan per NAMA HEADER yang dinormalkan, bukan huruf kolom
            (export menyisipkan 1 kolom kosong di antara tiap kolom data)
          * filter JENIS_TRANSAKSI = "1. Penjualan Bruto"   (retur tidak masuk)
          * filter TANGGAL yang dipilih   (satu file memuat rentang, bukan 1 hari)
          * agregasi per (NO_NOTA, KODE_BARANG); turunkan konv_tersirat = QTY_SATUANKECIL / QTY
     -> satu transaksi, pg_advisory_xact_lock per tanggal (dua unggah serentak tanggal sama diserialkan)
     -> INSERT rekap_upload ... ON CONFLICT (sha256) DO NOTHING; file sama TIDAK ditolak: baris lamanya dipakai ulang
        dan file diproses ulang per nota (idempoten). Pool dari unggahan lebih baru (id lebih besar) tidak ditimpa
        file lama (kelas lebih_baru -> notaLebihBaru)
     -> BL-54: per nota vs pool tanggal itu (sidik = kode_cust + baris kode_barang/qty/satuan/qty_pcs/konv):
          belum ada            -> ditulis
          isi sama             -> dilewati (file sore memuat nota pagi; tidak ditulis ulang)
          berubah, belum wave  -> baris lama DIHAPUS, diganti isi terbaru
          berubah, di wave aktif -> pool TIDAK diubah; wave_exception REKONSILIASI_SELISIH (ref nota; "[sidik x]" di
                                    keterangan: selisih sama tidak membuka ulang, selisih BARU membuka lagi yang sudah ditutup)
     -> tulis wave_line_pool + upsert pick_group dimensi jenis_produk
  <- { uploadId, tanggal, jumlahNota, jumlahBaris, principal[], tanggalTersedia[],
       fileSama, notaBaru, notaSudahAda, notaLebihBaru, notaDiganti, notaSelisih[{noNota, waveId, wave}] }

--- 8.2 Menyusun & merilis wave ---
UI /rekapan-nota/wave/[id]
  -> GET  /api/rekapan-nota/pool?tanggal=...   (anti-join ke wave_assignment)
       * buang nota bertanda kanvas (outlet ber-area NON / LUAR KOTA IKUT, seperti TTF Excel — owner 19 Okt 2026)
       * area/grup outlet dari masterOutletSql(): kode outlet export (C-500003) cocok dengan customer persis ATAU
         berakhiran principal (C-500003-HZ, -KN, ...) — sama dengan COCOK_OUTLET impor master (20 Okt 2026)
  -> POST /api/rekapan-nota/wave/[id]/nota     INSERT ... ON CONFLICT DO NOTHING RETURNING
       * uq_nota_aktif menolak nota yang sudah aktif di wave lain -> 409 + identitas pemiliknya
       * simpan snapshot: snap_grup_all, snap_grup_gdi, snap_area, snap_pareto, snap_total_krt
       * pg_advisory_xact_lock_shared per tanggal (unggah = eksklusif): snapshot dibaca sesudah unggah yang
         sedang mengganti isi nota selesai
  -> PATCH /api/rekapan-nota/wave/[id] { aksi: "release" }
       -> lib/rekapan-nota/exception.ts : deteksiException()  (set-based, ON CONFLICT DO NOTHING)
       -> lib/rekapan-nota/wave-state.ts : transisiWave()     (release boleh dengan exception open;
                                                               confirm ditolak selama KONVERSI_* open)
       -> UPDATE wave ... WHERE id AND status = <lama>  (0 baris = layar lain lebih dulu -> 409; BL-25)
  -> PATCH /api/rekapan-nota/wave/[id] { aksi: "cancel", alasan }
       -> transaksi sama: UPDATE wave_assignment SET dilepas=true, dilepas_alasan='wave dibatalkan', at/by
          (semua nota aktif kembali ke pool; wave_event.payload.nota_kembali)
  -> PATCH /api/rekapan-nota/wave/[id]/exception { exceptionId, aksi: selesai|abaikan, alasan }   (BL-24)
       -> rekapan_nota.manage; abaikan wajib alasan >= 5 karakter; ditolak 409 pada wave batal
       -> UPDATE wave_exception SET status, resolved_at/by WHERE ... AND status='open' (0 baris -> 409)
       -> wave_event wave.exception_resolved {exception_id, jenis, ref_kode, status, alasan}
       -> GET detail menampilkan nilai master saat ini (item.isi_per_karton / customer.area) + penutupan
  * Penjaga isi (BL-25): tambah (draft), take-out / prioritas / set_grup (draft|released), tutup exception
    (bukan cancelled) membaca status wave FOR SHARE di transaksinya -> lib/rekapan-nota/wave-state.ts : tolakUbahIsi() -> 409

--- 8.3 Cetak (menggantikan 29+ sheet Print) ---
UI pilih pick_group -> /rekapan-nota/wave/[id]/cetak?grup=...   (server component, grup (cetak))
  -> lib/rekapan-nota/query.ts : buildRekapan()
       SATU CTE `baris`, DUA proyeksi:
         withdrawal : GROUP BY kode_barang  -> Total, Konv, Krt Desimal, Sat Bsr, Sat Kcl
         allocation : GROUP BY no_nota      -> Nomor Nota & Rayon
       (balance dijamin struktural: sumbernya satu)
       grup sedimensi di-OR, antar-dimensi di-AND (HNZ1 = Area 1/10/PGU DAN Non Pareto)
  -> DUA PANEL per halaman (owner 20 Okt 2026): withdrawal kiri, allocation (nota + rayon) kanan, dipaginasi
     sendiri-sendiri & bernomor sendiri (baris kanan tidak sejajar kiri); kop: No. RKP/<yymm>/<wave>/<grup> + jam cetak WITA;
     judul halaman = nama PDF (RKP-...-<grup>_<yyyymmdd-HHmm>)
  -> window.print(); kaki halaman memuat wave, grup, jumlah SKU, total pcs, waktu cetak
  CETAK SEMUA (owner 24 Okt 2026): /rekapan-nota/wave/[id]/cetak-semua -> lembarCetakSemua(): satu lembar per divisi
     (jenis produk; grup JP-* dibuat otomatis saat unggah), HEINZ ABC = HNZ1..n per grup area (non-pareto), HNZ(n+1) pareto,
     HNZ-ALL tanpa area; lalu key account (outlet_all selain Gabung) & MT GDI (outlet_gdi) lembar sendiri lintas divisi
     (nota itu keluar dari lembar divisi; outlet_all menang atas MT GDI); lalu TTF. Tiap lembar nomor & halaman sendiri;
     grup outlet_gdi (OG-*) hanya berlaku untuk baris GODREJ (owner 31 Okt 2026) -- di Cetak Semua maupun pilih grup manual;
     tombol aktif sesudah Rilis.
     Komponen bersama: app/(cetak)/rekapan-nota/LembarRekapan.tsx + LembarTtf.tsx.
  Isi per karton = ISI_SQL: konv dari transaksi > item.isi_per_karton (lembar Konversi) > rasio satuan karton Accurate.

--- 8.4 TTF (Tanda Terima Faktur) ---
/rekapan-nota/wave/[id]/ttf  -> lib/rekapan-nota/query.ts : buildTtf()
  -> agregasi per NO_NOTA atas wave yang sama
  -> Lembar = CEILING(jumlah_baris_nota / app_setting["rekapan.baris_per_lembar_faktur"])
  -> kolom SRB / Batal / Paraf / Tgl Antr dicetak KOSONG (diisi tangan di kertas)

--- 8.5 Take-out berapproval ---
PATCH /api/rekapan-nota/wave/[id]/nota { aksi: "takeout" }  -> butuh rekapan_nota.approve_takeout
  -> UPDATE wave_assignment SET dilepas=true, dilepas_alasan/at/by   (ck_takeout memaksa terisi)
  -> nota kembali ke pool; wave_event: wave.nota_released

--- 8.7 Penandaan nota kanvas (Q16) ---
UI /rekapan-nota/kanvas -> GET /api/rekapan-nota/kanvas?tanggal=...
  * daftar nota hari itu DIKELOMPOKKAN PER SALESMAN (di situlah nota kanvas menggumpal)
  -> POST   .../kanvas  multi-select; setelah tanda pertama, tawaran sekali:
       "Salesman M-XXX punya N nota lain hari ini - tandai semua?"
  -> DELETE .../kanvas  batal tandai; DITOLAK kalau notanya sudah di wave kanvas rilis
  * nota bertanda keluar dari pool reguler (R3.5); jumlahnya tetap DITAMPILKAN di layar
    penyusunan wave supaya hilangnya tidak diam-diam

--- 8.6 Usulan mapping area ---
GET /api/rekapan-nota/area   (antrean = outlet tanpa area yang punya nota HEINZ ABC saja; hanya Heinz dibagi
                              per area. Exception OUTLET_TANPA_AREA + kartu "Outlet tanpa area" ikut aturan sama — owner 19 Okt 2026)
  -> lib/rekapan-nota/area-suggest.ts : usulkanArea()
       1. Kel./Kec. di alamat -> area mayoritas di master  (LOO terukur 87,1%)
       2. fallback kemiripan token alamat+nama -> memakai damerau() dari lib/sales-history/fuzzy.ts
  -> POST .../area  (terima satuan atau massal untuk keyakinan TINGGI)
```

---

## Summary Program — Determinisme Pipeline (FASE 1–6 + Pass 3)

**Masalah:** surat program (foto/PDF scan) → Dataset Diskon (xlsx) + Form Summary (PDF) via OCR+LLM
non-deterministik: dokumen SAMA bisa keluar hasil BEDA tiap run (tier bergeser, varian ditebak,
baris ke-split, byte file beda). Solusi: buang keputusan LLM dari jalur yang harus pasti, ganti dgn
lookup/parser deterministik + freeze cache + snapshot regresi + netralisir non-determinisme
byte-level. Semua modul additive (jalur lama tetap sbg fallback). Refactor F10: logic ini semua
hidup di `python_backend/routers/summary.py` (BUKAN `main.py`, yang kini 559 baris app-setup saja).

```
surat (PDF) + principle_name → summary_manual_parse_pdf_ai (routers/summary.py)
  │
  ├─ kino_extraction / deterministic_extraction — surat berlapis teks, 0 panggilan API
  │
  └─ summary_mistral.extract — Mistral OCR 4.1, 1 panggilan per halaman, skema JSON ketat
       │  perintah: surat_struktur.kontrak (principal ber-matcher, "salin saja") atau generik
       │  cache `mistral-v1`: kunci = pemilik + hash PDF + hash master + model + versi
       │  + sidik perintah + editor → ganti perintah = OCR ulang sekali (berbayar)
       ▼
     Pass 3 self_correction.py :: verify_and_correct_rows — aktif bila MIMO_API_KEY diset
       (SUMMARY_SELF_CORRECT=0 mematikan; model SUMMARY_EDITOR_MODEL, default mimo-v2.6-flash)
       editor QA PATCH-BASED: model HANYA boleh kirim {id, field, to, alasan} atas field hasil
       salinan perintahnya (tanpa kode_barangs/source_quote); DILARANG tambah/hapus baris.
       `alasan` WAJIB kutipan yang benar-benar ada di teks OCR, selain itu patch dibuang.
       Tiap patch → peringatan "Baris N: … diubah editor QA"; editor gagal → rows utuh +
       peringatan "Editor QA tidak berjalan" (beda dari editor bersih = 0 patch).
       Yang dibekukan di cache = hasil terkoreksi (run ke-2 = 0 panggilan API).
  ▼
_apply_native_kelompok (principal ber-matcher; variant_resolver di dalamnya) / rapikan_baris (lainnya)
  ▼
draft Summary (summary_store.create_draft / append_rows)
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
| `python_backend/ocr_cache.py` | `ocr_cache_key`, `ocr_cache_get/put` | FASE 1 (jalur Gemini lama): **tidak dipanggil** jalur parse sejak pindah ke Mistral; cache yang berlaku kini `mistral-v1` di `summary_mistral` |
| `python_backend/parse_cache.py` | `parse_cache_key`, `parse_cache_get/put` | FASE 1b (jalur lama): **tidak dipanggil** `summary_manual_parse_pdf_ai` lagi |
| `python_backend/tier_parser.py` | `parse_positional_tables`, `match_item_to_tablerow`, `regroup_rows_by_tier` | FASE 2/2b (jalur lama): tier dari POSISI tabel OCR; `regroup_rows_by_tier` **tidak dipanggil** jalur parse lagi; self-check `__main__` |
| `python_backend/variant_resolver.py` + `variant_mapping.json` | `load_variant_mapping`, `resolve_variant` | FASE 3/3b: resolusi varian via tabel deklaratif; None = fallback; anti-halusinasi |
| `python_backend/correction_store.py` | `save_correction`, `apply_corrections`, `correction_key` | FASE 4/4b: koreksi manusia stable-key, override deterministik (bukan hint prompt); ditulis otomatis dari endpoint `report_correction` |
| `python_backend/golden_store.py` | `canonical_signature`, `golden_check_and_freeze`, `approve_golden` | FASE 5: snapshot determinisme; deteksi drift output utk input identik; self-check `__main__` |
| `python_backend/deterministic_output.py` | `enable_pdf_determinism`, `finalize_xlsx` | FASE 6: paku non-determinisme BYTE-LEVEL (ReportLab doc-id/CreationDate; openpyxl zip-timestamp + `docProps/core.xml`). **Bug ditemukan+diperbaiki 2026-07-13**: `\1`/`\2` di replacement regex diikuti digit literal ditafsir Python `re` sbg backreference/octal → `docProps/core.xml` corrupt (file tak bisa dibuka) walau tetap "byte-identik" antar-run (self-check lama cuma cek hash, tak cek well-formed). Fix: `\g<1>`/`\g<2>`; self-check kini juga `load_workbook` ulang + parse XML. |
| `python_backend/self_correction.py` | `verify_and_correct_rows`, `mimo_post` | Pass 3 (arsitektur ala Reducto), dipanggil `summary_mistral.extract`: editor LLM QA PATCH-BASED via MiMo; whitelist field = field perintah, kutipan wajib ada di teks OCR, dilarang sentuh id/kode_barangs/jumlah baris; gagal apa pun → no-op + peringatan; `SUMMARY_SELF_CORRECT=0` utk nonaktifkan; uji `test_summary_editor.py` |
| `python_backend/prompts/prompt_summary_program.md` | SYSTEM PROMPT (§1), USER MESSAGE TEMPLATE (§2), catatan untuk kode (§3: validasi, expand rule → record per kode_barang, perakitan form ringkas) | Prompt ekstraksi surat program → JSON `summary_program` (detail aturan per item untuk setting sistem + metadata Form Summary ringkas). Jalur TERPISAH dari Mistral/MiMo di atas; dipanggil `summary_program.pesan` (Mistral chat, json_schema strict). Header doc = komentar HTML di atas file |
| `python_backend/prompts/summary_program.schema.json` | objek `summary_program`: `programs` → `sections` → `kolom` (maks. 6), `item_rules` (atomik: baris produk × kolom × segmen), `flags`, `validasi` | JSON Schema 2020-12 untuk output prompt di atas: `input_schema` tool / structured output + validasi sebelum simpan. Header doc = field `$comment`. Dipakai `summary_program.FORMAT` sebagai response_format strict Mistral |
| `python_backend/prompts/summary_program_referensi.md` | L01–L22 (aturan lintas principal), satu bagian per principal | Keputusan pemilik yang mengikat, dikirim ke prompt sebagai `{{REFERENSI_KEPUTUSAN}}` (lintas principal + bagian principal yang diproses), supaya peringatan yang sudah diputuskan tidak muncul lagi. Gerbang rilis = tidak ada flag kritis/perlu_cek; jawaban pemilik atas peringatan baru ditambahkan di sini. Header doc = komentar HTML di atas file |
| `python_backend/summary_program.py` | `ekstrak`, `baca`, `umum`, `jaga`, `fakta`, `gabung`, `validasi`, `rapikan` | Jalur Summary Program (30 Okt 2026): OCR Mistral per halaman + OCR tabel 300 dpi → tiga pembaca (`mistral-large-4` + gambar = utama; `mistral-large-latest` teks & + gambar = pemeriksa, WAJIB model lain) → aturan umum lintas principal (kode B/P, L14 on faktur + hanger, kolom CR bukan potongan, "N+M" = beli N gratis M, L08) → penjaga G1–G4, G6–G8 + ingatan Summary yang disetujui. Surat ≥ 4 halaman dibaca per halaman. Cache `summary-program-v1`. Ukuran akurasi: `tmp/ukur_mistral/LAPORAN.md`; uji `test_summary_program.py` (Mistral tiruan) |
| `python_backend/summary_program_form.py` | `form_pdf`, `susun`, `baris_seksi`, `jenis_beban` | Form "Summary Program On Faktur" ringkas dengan ReportLab (Helvetica + Symbol): judul + kepala kolom tiap halaman, "Hal. x dari y" per principal, COKLAT/PINK/MERAH, catatan & peringatan di kolom Update keterangan, tanda tangan ikut blok terakhir; uji `test_summary_program_form.py` |
| `python_backend/routers/summary_program.py` | `POST /summary/program/ekstrak`, `/form`, `/setujui` | Endpoint jalur di atas. `setujui` = gerbang rilis (0 flag kritis/perlu_cek, kode di master) → simpan ke `summary-program-disetujui` (ingatan bulan berikutnya). Tidak menulis ke Accurate maupun promo_rule; uji `test_summary_program_router.py` |

Titik integrasi (F10: **BUKAN** `main.py`, lihat `python_backend/routers/summary.py`):
parse = `summary_manual_parse_pdf_ai` → `summary_mistral.extract` (Pass 3 di dalamnya) →
`_apply_native_kelompok`/`rapikan_baris`; generate = `apply_stable_corrections` +
`enable_pdf_determinism`/`finalize_xlsx` + golden check di `summary_manual_generate`.

---

## Clean Tree

```
AccAPI/_github_clean/
├── app/
│   ├── (auth)/
│   │   ├── layout.tsx                  # Kerangka Fiori: panel merek + kartu (S7c)
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
│   │   │   ├── page.tsx                # Server tipis: izin + FioriScope → OpcApp
│   │   │   ├── OpcApp.tsx              # Klien: peran OPC, navigasi ?tab=, lonceng/pencarian → ?batch=, penjaga draf
│   │   │   └── opc/                    # Bersama.tsx (hook data, Antrean, KerjaPeran FCL), ObjectPageBatch.tsx, peran/{Spv,Sm,Klaim,Om,Keuangan,Ringkasan,Audit}.tsx
│   │   ├── claim-workflow/
│   │   │   ├── page.tsx                # Daftar claim workflow
│   │   │   ├── [id]/page.tsx           # Detail + aksi per workflow
│   │   │   └── reports/page.tsx        # Laporan outstanding/paid
│   │   ├── payments/                   # Fiori S6a (it08): server tipis (izin + FioriScope) → klien
│   │   │   ├── page.tsx                # → Rekaman.tsx (+ RekamanDialog.tsx): List Report, simpan per rekaman, dialog unggah/manual/keranjang/hapus
│   │   │   ├── bersama.tsx             # HTTP FastAPI (CSRF /api/me, kode status, "belum pasti"), RangkaPembayaran + subnavigasi
│   │   │   ├── cart/[draftId]/         # page.tsx → Keranjang.tsx: Tinjau (rekening, nomor SPPD, tanggal WITA) → Diajukan
│   │   │   ├── pengajuan/              # BL-50: page.tsx → Pengajuan.tsx (daftar); [id]/ → PengajuanDetail.tsx (Object Page)
│   │   │   └── sppd/page.tsx           # → ../FormatSppd.tsx (+ FormatSppdDialog.tsx): setelan, rekening, operasi Pratinjau → Terapkan
│   │   ├── api-wrapper/
│   │   │   ├── page.tsx                # UI proxy Accurate ERP
│   │   │   └── parsers/                # Parser bulk sales receipt
│   │   ├── finance/                # page.tsx (izin + tanggal WITA) · Finance.tsx (worklist + detail + dialog) · posting.ts (HTTP + orkestrasi)
│   │   ├── summary/page.tsx
│   │   ├── validator/page.tsx
│   │   ├── principles/page.tsx
│   │   ├── admin/users/                # User management + legacy RBAC editor
│   │   └── admin/groups/               # Dynamic RBAC: kelola Access Group + permission + member
│   └── api/
│       ├── auth/
│       │   ├── [...all]/route.ts       # Better Auth catch-all handler
│       │   ├── accurate-login/route.ts # Mulai OAuth Accurate: state + returnTo di cookie httpOnly (AM-033)
│       │   ├── callback/route.ts       # Accurate OAuth callback (cocokkan state, galat berkode)
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
│       │   ├── periods/route.ts        # Status (GET) + tutup/buka kunci (POST) periode per principal
│       │   ├── principles/route.ts
│       │   ├── discount/route.ts
│       │   ├── payments/[paymentId]/proof/route.ts
│       │   └── audit/route.ts          # Audit log OPC (JSON audit_read; CSV + audit_export, S7-1b)
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
│   ├── fiori/                          # Design system Fiori: Scope (font + .fiori), core, interactive, scheme
│   ├── off-program-control/
│   │   ├── OffGlobalSearch.tsx
│   │   └── OffNotificationBell.tsx
│   └── ui/                             # Dialog native bersama
├── lib/
│   ├── tampil.ts                       # Format tampilan bersama: KOSONG, tanggal/waktu WITA, hariIniWita, sebabHttp (+ tampil.test.ts)
│   ├── auth.ts                         # Konfigurasi Better Auth server
│   ├── auth-client.ts                  # Better Auth client (browser)
│   ├── rbac.ts                         # RBAC legacy (union layer selama transisi)
│   ├── rbac/
│   │   ├── registry.ts                 # PERMISSION_REGISTRY — sumber tunggal 111 key + KUNCI_PENSIUN (S7-1b)
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
│   ├── principle_matcher.py            # Fuzzy matcher nama principal
│   └── prompts/                        # prompt_summary_program.md + summary_program.schema.json + summary_program_referensi.md (ekstraksi surat program → JSON; dipanggil summary_program.py)
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
├── docker-compose.yml                  # Deploy: frontend + backend; auth secret wajib diinjeksi tanpa fallback
├── .dockerignore                       # Keluarkan env/compose/runtime data dari build context
├── Dockerfile.frontend
├── Dockerfile.backend
└── proxy.ts                            # Pasang x-current-path untuk gerbang halaman (matcher: semua kecuali /api, /api/..., aset)
```

---

## Module Map (The Chapters)

### Repository Guardian Automation

| File | Fungsi Utama | Peran |
|---|---|---|
| `.github/workflows/pr-guardian.yml` | event PR, permission read-only, trusted-base checkout, job summary | Gate PR tanpa `pull_request_target`, secret, comment write, atau interpolasi metadata PR ke shell |
| `scripts/guardian/pr-guardian.mjs` | `changedFilesFromGit`, `classifyChanges`, `selectChecks`, `evaluateGuardian`, `renderGuardianReport` | Klasifikasi risiko dan eksekusi check deterministik; finance/payment/database/migration/seed tidak dapat turun di bawah CRITICAL, sedangkan auth/RBAC/Guardian/SYSTEM_MAP tidak dapat turun di bawah HIGH |
| `.github/workflows/system-map-issues.yml` | push path filter, manual dispatch, serialized issue mutation | Memisahkan permission `issues:write` dari PR Guardian dan mencegah run sync normal berlomba |
| `scripts/guardian/system-map-issues.mjs` | `extractRisks`, `planIssueSync`, `stabilizeCreatePlan`, `fetchManagedIssues`, `applyIssuePlan` | Sinkronisasi issue berbasis stable ID + label otoritatif, timeout API, spam guard, dan lifecycle tanpa auto-close |
| `tests/guardian/*.test.mjs` | simulasi classifier/report/sync | Self-check pure Node tanpa GitHub API atau DB production |

### Auth & Session

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/auth.ts` | `auth` (betterAuth instance) | Konfigurasi server auth: email/password, admin plugin, adapter PostgreSQL, email reset/verify. S7-1: `disabledPaths` menutup 15 endpoint `/api/auth/admin/*` plugin dari browser (404; `auth.api.*` server-side tetap jalan); `revokeSessionsOnPasswordReset` (reset lupa sandi mencabut sesi lama) |
| `lib/auth-client.ts` | `authClient` | Client-side Better Auth hooks untuk browser |
| `lib/rbac.ts` | `canAccess`, `canAccessPath`, `permissionMapForUser`, `normalizeRole`, `canAccessPathWithKeys` (`anyOf`), `SESI_ACCURATE_KEYS`, `actionLabels`, `permissionModuleLabels`, `permissionKeyLabel`, `auditActionLabels` | RBAC legacy: preset per role (fallback user tanpa grup); `pagePermissions` boleh memuat `anyOf` (kunci alternatif, dipakai `/sesi-accurate`). S7-1: SATU sumber label izin (20 modul registry + 18 aksi OPC granular) & label aksi audit untuk layar S7a |
| `lib/accurate-oauth.ts` | `urlAuthorize`, `returnToAman`, `halamanMendarat`, `kabarAccurate`, `GALAT_ACCURATE` | Bagian murni OAuth Accurate (server+klien): scope tetap, daftar putih returnTo, kode galat → kalimat |
| `components/accurate/SesiAccurate.tsx` | `SesiAccurate` | Kartu Sesi Accurate bersama `/sesi-accurate` dan Konsol: status, Masuk, daftar/buka database, Keluar, kabar callback |
| `lib/rbac/registry.ts` | `PERMISSION_REGISTRY`, `allPermissionKeys`, `isValidPermissionKey`, `KUNCI_PENSIUN` | **Sumber tunggal** 111 permission key (`module.action`); `KUNCI_PENSIUN` (S7-1b) dibuang PATCH grup tanpa 400 + dihapus RBAC_S7_1B_PENSIUN.sql. Zero import — pure data. Test-guard scan semua route.ts saat CI |
| `lib/rbac/resolve.ts` | `getUserPermissions`, `getPrimaryGroup`, `requirePermission`, `requirePermissionH`, `resolveRequestPermissions`, `resolveRequestPermissionsH` | Resolver: grup (otoritatif) / legacy role bila tanpa grup. Guard endpoint default-deny. `getPrimaryGroup` (BL-63) = grup berbintang atau satu-satunya grup; dipakai layout + Beranda untuk profil (S7-3) |
| `lib/rbac/otorisasi.ts` | `transaksiOtorisasi`, `adminAktif`, `evaluasiPenjaga`, `mulaiUtama`/`selesaiUtama`, `pasangBintang`, `roleTurunan`, `GROUP_NAME_TO_ROLE` | S7-1: SATU penjaga BL-61 (admin = aktif + `users.manage` efektif; 409 `ADMIN_TERAKHIR`/`AKSES_SENDIRI`/`GRUP_TERAKHIR`) di dalam transaksi + `pg_advisory_xact_lock`; grup utama + penurunan `user.role` dari grup preset di transaksi yang sama. Kontrak `docs/handover/S7-KONTRAK-ADMIN-API.md` |
| `lib/rbac/riwayat.ts` | `jawabRiwayat` | Riwayat `permission_audit_log` per user/grup, keyset presisi mikrodetik |
| `lib/rbac/registry.test.ts` | self-check script | Validasi integritas registry + scan semua route.ts: gagal jika ada key tidak terdaftar. Jalankan: `node --experimental-strip-types lib/rbac/registry.test.ts` |
| `app/(dashboard)/layout.tsx` | `DashboardLayout`, `dynamic = "force-dynamic"` | Guard semua halaman dashboard: session check + RBAC path check; selalu render per request karena membaca header/session |
| `app/(dashboard)/admin/users/` | `Pengguna` (FCL Fiori) | **User (S7a)**: daftar (cari, saring grup/status) -> Object Page Grup (semua grup + bintang utama; tambah/keluarkan/bintang dengan peringatan role identitas), Keamanan (atur sandi bertopeng ketik dua kali, aktif/nonaktif), Riwayat berkursor; dialog buat user. Halaman: `users.view` ATAU `users.manage` (`users.view` = baca-saja, tulis = `users.manage` ditegakkan API); kalimat galat per `code` di `components/admin/admin-ui.ts`. `pagePermissions` `/admin/users` = `users.view` + `anyOf: [users.manage]` (layout dan gerbang klien SidebarLayout); `/admin/groups` = `users.manage` |
| `app/(dashboard)/admin/groups/` | `AksesGrup` (FCL Fiori) | **Akses Group (S7a)**: daftar grup -> Object Page (izin per modul 20 modul, label satu sumber `lib/rbac`; anggota; info; riwayat), footer Simpan -> dialog SELISIH izin (ditambah/dicabut, anggota terkena; mencabut `users.manage` = peringatan + tombol tegas, tanpa isian alasan karena server belum mencatatnya), hapus grup custom (ditolak bila preset/`GRUP_TERAKHIR`), grup baru. Bersama: `components/admin/{Bersama.tsx,admin-ui.ts}` |
| `app/api/auth/[...all]/route.ts` | Better Auth catch-all | Mount semua endpoint auth Better Auth |
| `app/api/admin/bootstrap/route.ts` | `POST` | One-time setup akun admin pertama via token |
| `app/api/admin/groups/route.ts` | `GET`, `POST` | List + buat Access Group; gate: `users.manage` |
| `app/api/admin/groups/[id]/route.ts` | `GET`, `PATCH`, `DELETE` | Detail + sync permission + hapus group (satu transaksi + penjaga BL-61; preset tak bisa diganti nama, `users.manage` preset Admin terkunci; hapus grup menghitung ulang grup utama/role tiap anggota); tulis `permission_audit_log` |
| `app/api/admin/groups/[id]/members/route.ts` | `POST`, `DELETE` | Assign/remove user dari group; penjaga BL-61 + grup utama/role satu transaksi; tulis `permission_audit_log` |
| `app/api/admin/groups/[id]/history/route.ts` | `GET` | Riwayat grup (`users.manage` \| `users.view`) |
| `app/api/admin/users/route.ts` | `POST` | BL-62 buat user: `auth.api.createUser` server-side (banned "sedang disiapkan") -> transaksi app (grup, bintang, role, buka ban, audit) -> kompensasi bila gagal |
| `app/api/admin/users/[id]/password/route.ts` | `POST` | Atur sandi (hasher Better Auth), cabut semua sesi, audit tanpa sandi |
| `app/api/admin/users/[id]/status/route.ts` | `POST` | Aktif/nonaktif (ban + cabut sesi; tidak menghapus) |
| `app/api/admin/users/[id]/primary-group/route.ts` | `PUT`, `DELETE` | BL-63 tandai/lepas bintang grup utama (dua langkah) -> `user.role` dari grup preset |
| `app/api/admin/users/[id]/group/route.ts` | `POST` | LAMA, dipensiunkan: kini tambah + bintang (bukan "ganti semua") |
| `app/api/admin/users/[id]/history/route.ts` | `GET` | Riwayat user (`users.manage` \| `users.view`) |
| `app/api/admin/users/permissions/route.ts` | `GET` | Daftar user + semua grup + grup utama efektif (`users.manage` \| `users.view`) |

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
| `app/api/off-program-control/periods/route.ts` | `GET`, `POST` | GET (audit desain 001 No 27): status penutupan `off_period_closure` per `?bulan=&tahun=[&principleCode=]` (sesi OPC + `off_program_control.view`; bulan/tahun tidak sah 400; baca-saja: status, penutup/pembuka + nama dari `user`, waktu) dipakai Ringkasan › Tutup periode (status nyata, Buka kunci untuk periode tertutup di server). POST close/unlock tidak berubah (izin `period_close`/`period_unlock`, total pengajuan = total klaim, audit per batch) |
| `app/(dashboard)/off-program-control/page.tsx` | `OffProgramControlPage` | Rute Fiori S4d: izin server (`resolveRequestPermissionsH`) + `FioriScope` → `OpcApp` |
| `app/(dashboard)/off-program-control/OpcApp.tsx` | `OpcApp` | Peran OPC sama dengan kode lama (sesi + `useLocalAuthRole` → `resolveOffRole`, SM hanya tab Sales Manager); navigasi `?tab=` lama; lonceng + pencarian membuka `?batch=` di kolom kedua untuk peran apa pun; `?mock=N` fixture dev; dialog "Tinggalkan perubahan?" + `useUnsavedGuard` |
| `app/(dashboard)/off-program-control/opc/Bersama.tsx` | `useDaftarBatch`, `useDetailBatch`, `KerjaPeran`, `Antrean`, `ambilOpc`, `tulisOpc` | Satu daftar 200 batch (polling 45 dtk + fokus tab, SLA `detectProblematicBatches`), detail batch (+ refund, audit per batch), worklist + saringan + FCL; header berisi KONTRAK untuk modul peran |
| `app/(dashboard)/off-program-control/opc/ObjectPageBatch.tsx` | `ObjectPageBatch` | Object Page batch: header + Flow 7 tahap + lewat SLA, Item, Validasi klaim, Pembayaran dan refund, Riwayat (log + enam sumbu status), Alur dokumen; slot `bagian`/`gantiItem`/`strip`/`aksi`/`pesanFooter`/`draf` |
| `app/(dashboard)/off-program-control/opc/peran/*.tsx` | `Spv`, `Sm`, `Klaim`, `Om`, `Keuangan`, `Ringkasan`, `Audit` | Satu modul per tab; header tiap modul mendaftar fitur lama yang dibawa (rentang baris kode lama) |
| `lib/opc-ui.ts` | `tahapBatch`, `infoTahap`, `alurBatch`, `PREDIKAT`, `TAMPILAN`, `tabTerlihat`, `saringBatch`, `izinAksi` | Murni: enam sumbu status → 7 tahap (Draf → SM → Klaim → OM → Bayar → Final → Selesai + Dikembalikan/Dibatalkan), predikat antrean salinan kode lama, label Indonesia, format WITA (uji: `lib/opc-ui.test.ts`) |

### Form Kontrol

| File | Fungsi Utama | Peran |
|---|---|---|
| `app/(dashboard)/form-kontrol/page.tsx` | `FormKontrolPage`, `loadScope`, `selectTab` | Memuat `/api/form-kontrol/my-scope` secara fail-closed; loading memakai skeleton, error punya retry, lalu tab dibuka sesuai role dan tersinkron ke query URL |
| `app/(dashboard)/form-kontrol/**` + `app/(dashboard)/sales/**` (Fiori S5) | `FormKontrol` (shell tab per peran), `TabAo` (Rute hari ini), `Kunjungan` + `FotoBukti` (wizard Check-in → Status → Merchandising → Check-out, Kembali di tiap langkah), `OrderSales`, `DashboardSpv`, tab tim; helper `shared.tsx` (`hariIniWita`, `ambilFk`/`tulisFk`, `useIzinFk`, `principalAwal`, `penjelasanTanpaJks`) dan `lapangan.ts` | Rute server tipis + FioriScope; tanggal "hari ini" dihitung WITA di klien dan dikirim ke server (BL-28 penetapan server belum); langkah wizard hanya maju sesudah persistence sukses; galat ≠ kosong; jawaban tidak pasti disebut |
| `lib/form-kontrol/{db,scope,constants}.ts` + `app/api/form-kontrol/*` (FK-MSM, 12 Okt 2026) | `getTodayRoute`, `getJksPrinciples`, `upsertJksRows`, `getJksList`, `getSpvDashboard`, `acknowledgeReport`, `resolveScope`, `kunciHari`/`hariBaku`, `kunciNama` | Principal = JKS AKTIF cakupan (`my-scope.principles`; satu = langsung terpilih, tanpa JKS = penjelasan). Rute/laporan/saringan hari membandingkan KUNCI hari (huruf besar tanpa spasi/tanda: "SENIN"/"JUM'AT" terbaca) + pola minggu ter-trim; paritas minggu = `paritasMinggu` (keputusan owner 12 Okt: selang-seling dari acuan `ACUAN_MINGGU_GENAP` Senin 12 Okt 2026 = genap, BUKAN minggu ISO); unggah JKS menyimpan hari baku, hari tak dikenal (termasuk "1"/"-") ditolak per baris (`ditolak`). GET jks + frequency dibatasi cakupan server (SPV tim, salesman miliknya, admin semua; luar cakupan 403). Dashboard SPV: nama SPV dari `resolveScope` (SPV tanpa `sales_profile` bisa; salesman/SM 403); nama SPV/SM dibandingkan upper(trim()), disimpan ter-trim (juga briefing, daftar SPV milik SM, Kontrol SM — satu baris per SPV); ack hanya tim sendiri. Briefing/Kontrol SM/sm-briefings: nama dari sesi (`namaSpvBoleh`/`namaSmBoleh` + `namaDalamCakupan`) — salesman hanya membaca briefing SPV-nya, SPV atas namanya, SM atas namanya + SPV bawahannya, admin semua; nama klien di luar cakupan = 403. Uji: `lib/form-kontrol/fk-msm{,-pg}.test.ts`, Playwright `tests/fiori-form-kontrol-msm.spec.ts` |
| `app/api/form-kontrol/sales-profiles/route.ts` + `tabs/TabHierarki.tsx` (Hierarki Sales, owner 13 Okt 2026) | `namaAkunPeran` (scope.ts), `pilihNamaAkun`/`kunciNama` (constants.ts), `stripRoleSuffix` | Cakupan SPV/SM (`resolveScope`) = nama AKUN sesi tanpa akhiran "(SPV)"/"(SM)" dicocokkan `kunciNama` dengan `sales_profile.spv_name`/`sm_name`, jadi nama di Hierarki DIPILIH dari akun. `GET` (cakupan global saja, selain itu 403) -> `{ rows, spvOptions, smOptions }` = nama akun AKTIF (tidak banned; banned kedaluwarsa = aktif) ber-`user.role` spv/sm, akhiran dibuang, satu per nama, urut `localeCompare("id")`. `PUT { salesCode, spvName, smName }`: non-kosong WAJIB tepat satu akun aktif ber-role itu -> 400 `SPV_TIDAK_DIKENAL`/`SM_TIDAK_DIKENAL`, lebih dari satu (cakupan bocor) 409 `NAMA_GANDA`, bukan teks 400 `INPUT_TIDAK_VALID` (`{ ok:false, kode, error }`); kode sales tanpa profil 404 `PROFIL_TIDAK_ADA`; disimpan ejaan AKUN; kosong/null = melepas; 200 `{ success, spvName, smName }`. Draf baris dibandingkan `kunciNama` (ejaan lama "adnan" = akun "ADNAN" bukan perubahan). Layar: `<select>` "— kosong —" + akun; nilai tersimpan yang tak cocok = opsi "(tidak cocok dengan akun)" + peringatan baris "tidak melihat timnya" (kasus SYAMSUL vs akun SPV_SYAMSUL); galat berkode tampil di dialog (`pesanServer` meneruskan `error` bila ada `kode`). Uji: `fk-msm{,-pg}.test.ts` (Hierarki), `tests/fiori-lapangan-tim.spec.ts` |
| `lib/form-kontrol/luar-rute.ts` + `app/api/form-kontrol/luar-rute/**` + `app/(dashboard)/form-kontrol/tabs/LuarRute.tsx` (FK-MSM2, 12 Okt 2026; DRAFT zona §3 skema) | `tambahLuarRute`, `daftarLuarRute`, `konfirmasiLuarRute`, `periksaKeputusan`, `kodeJksUntuk` (constants), `TambahLuarRute`, `KonfirmasiLuarRute` | Kunjungan LUAR RUTE: Rute hari ini → "Tambah toko luar rute" (`PemilihPelanggan` O2 → `GET /api/customers/search`) → `POST /api/form-kontrol/luar-rute` `{salesCode, principle, date, customerNo}` (201 baru / 200 baris sama; HANYA salesman pemilik dari sesi `BUKAN_PEMILIK` 403; tanggal = hari ini WITA server `TANGGAL_BUKAN_HARI_INI` 400; pelanggan aktif cabang O1 `cakupanCabang` `PELANGGAN_TIDAK_DITEMUKAN` 404, galat tautan O1 diteruskan; principal = JKS aktif salesman, tanpa JKS = nama cabang Accurate (`my-scope.principalCabang`/`alasanCabang`) `PRINCIPAL_LUAR_CAKUPAN` 403; toko di rute JKS hari ini (kode pendek/lengkap, `cocokKodeRute`, hari + `paritasMinggu`) `SUDAH_DI_RUTE` 409; toko di JKS sendiri hari lain = `sudah_jks`) → `kunjungan_luar_rute` + audit `luar_rute/tambah`. `getTodayRoute`/`getVisitDetail`/`getSpvDashboard` memuat baris itu (`luarRute: true`; juga hari tanpa jadwal & salesman tanpa JKS; satu toko satu kartu: kode JKS persis sama = kartu JKS, kode berbeda tetapi cocok `cocokKodeRute` = kartu luar rute); check-in/status/merchandising = alur toko JKS (`ao_control_daily`, kunci cust_code LENGKAP). FK-MSM3 (13 Okt): `saveCheckin`/`upsertAoControl`/`saveMerchandising` (db.ts) menulis HANYA untuk toko di rute salesman pada tanggal itu — `galatBukanRute` di transaksi tulis yang sama: JKS aktif hari + pola minggu (kode persis, saringan getTodayRoute; tanpa kunci) atau baris luar rute belum batal `SELECT … FOR SHARE` (berserialisasi dengan batal FOR UPDATE: tulis dulu → batal 409 `SUDAH_DIKUNJUNGI`; batal dulu → tulis 409); toko yang SUDAH punya baris AO salesman itu pada tanggal itu tetap lolos (owner 13 Okt: status/merch lanjutan bila JKS dipindah hari; batal menolak toko ber-AO) → selain itu 409 `KUNJUNGAN_DIBATALKAN` (toko punya luar rute tanggal itu yang dibatalkan) / `BUKAN_RUTE_HARI_INI` (juga toko JKS hari lain / kode sembarang, dulu 200); kalimat menyebut nama toko (jks_master/luar rute), saran "tambahkan lewat Kunjungan luar rute" hanya bila route memberi `penulis` = salesman pemilik + tanggal hari ini WITA (SPV/admin, tanggal lain = kalimat lain); route `checkin`/`ao-control`/`merchandising` → `jawabGalat`; tanpa baris AO yatim. Check-in dan status = satu `INSERT … ON CONFLICT (idx_ao_unique)` (serentak tanpa 23505/500): check-in memperbarui kolom check-in saja, status kolom status/alasan + `is_visited` COALESCE (tidak ditimpa null). Layar: `ditolakBukanRute` (lapangan.ts, `GagalKirim.kode`) → Kunjungan diganti penjelasan (judul "Kunjungan luar rute ini sudah dibatalkan" / "Toko ini tidak ada di rute hari ini", isian tak tersimpan disebut, fokus ke penjelasan) + Rute hari ini `#luar-rute` (TambahLuarRute `id=luar-rute` digulir + tombol terfokus); Kirim status berhenti, menyebut toko yang belum dikirim, rute dimuat ulang; Toko Tidak Order dimuat ulang + strip tab "Alasan N toko tidak tersimpan" bernama toko, ketikan toko yang masih ada terbawa. Check-out (UPDATE saja) dan merchandising (tanpa indeks unik) tidak memakai ON CONFLICT. `GET /api/form-kontrol/visit` membawa `bukanRute: {kode, error} | null` dari penjaga yang sama (`cekRuteKunjungan` = `galatBukanRute` di luar transaksi) → Kunjungan langsung menampilkan penjelasan tanpa wizard/foto check-in ("Kunjungan tidak bisa dimulai dari layar ini"). Laporan harian → `GET /api/form-kontrol/luar-rute?salesCode=&date=` (cakupan `canAccessSales`; baris tanggal itu + `menunggu` tanggal lama yang sudah check-in; `jksSaya`/`jksLain`) → `POST /api/form-kontrol/luar-rute/konfirmasi` `{id, salesCode, keputusan: "jks", hari, mingguPattern: ganjil|genap|all}` atau `{keputusan: "tidak"}` (pemilik saja; `KEPUTUSAN_TIDAK_SAH` 400, `LUAR_RUTE_TIDAK_ADA` 404, `SUDAH_DIKONFIRMASI`/`SUDAH_DI_JKS` 409; toko SUDAH di JKS sendiri (unggahan kode pendek/lengkap, atau baris luar rute lain toko sama yang sudah dikonfirmasi — juga serentak: `onConflictDoUpdate setWhere is_active = false`) → baris ini jadi `sudah_jks` + audit `konfirmasi_sudah_jks` lalu 409 `SUDAH_DI_JKS`, untuk `jks` maupun `tidak`; `jks` wajib kunjungan nyata (check-in / hasil order-aktif-tidak order / merchandising; "tidak dikunjungi" bukan) 409 `BELUM_DIKUNJUNGI`; JKS salesman lain = `jksLain` peringatan, tetap ditulis) → transaksi + `FOR UPDATE`: baris `jks_master` salesman (kode pelanggan LENGKAP, hari baku, pola, channel JKS terbanyak/profil, frekuensi 4/2) + `jks_id` + `dikonfirmasi_*` + audit. "Nanti" = tidak memanggil (tetap `menunggu`, laporan tetap terkirim; dialog kirim menyebut jumlahnya). Pilihan minggu menandai "(minggu ini)" = `paritasMinggu(tanggal)`. Laporan harian: kartu "Luar rute dikunjungi" terpisah dari Total toko JKS (Order/Tidak order termasuk luar rute). Jejak: `getJksList.tambahanSalesman` (siapa/kapan/dari kunjungan) → Kontrol JKS kolom Asal "Ditambahkan salesman"; unggah JKS tidak menghapus baris tambahan, kecuali berkas memuat toko yang sama berkode JKS lain untuk salesman + principal sama DAN berhari (baris berkas tanpa hari tidak menggantikan) → baris tambahan DINONAKTIFKAN + `digantikan`. Batalkan (owner 13 Okt): kartu toko luar rute hari ini tanpa check-in/status → "Batalkan" (dialog) → `POST /api/form-kontrol/luar-rute/batal` `{id}` (pemilik dari SESI `BUKAN_MILIK` 403; `BUKAN_HARI_INI` 409 (WITA server); baris `ao_control_daily` apa pun (check-in, status, "tidak dikunjungi" dari Kirim status) atau merchandising toko itu hari itu `SUDAH_DIKUNJUNGI` 409; `SUDAH_DIBATALKAN`/`SUDAH_DIKONFIRMASI` 409; `LUAR_RUTE_TIDAK_ADA` 404) → `batalLuarRute` (FOR UPDATE; batal LUNAK `dibatalkan_pada/oleh` + audit `luar_rute/batal`, tanpa DELETE). Baris batal tidak dibaca rute/kunjungan/daftar konfirmasi/Dashboard SPV; konfirmasi 409 `SUDAH_DIBATALKAN`; tambah ulang toko sama = baris BARU (UNIQUE parsial). Jawaban tak pasti = dialog "belum pasti" + semua Batalkan dikunci sampai muat ulang; tombol hanya untuk luar rute tanpa check-in DAN tanpa baris AO apa pun (`adaStatus`), di baris bawah kartu. Konfirmasi di Laporan: 404/409/jawaban tak pasti → daftar dimuat ulang (baris jadi keadaan server); muat ulang gagal = strip "hasil sebelumnya" + Coba lagi; keputusan dikunci selama daftar tidak siap; kendali bernama toko, alasan nonaktif terlihat. Tambah luar rute tak pasti → rute dimuat ulang. Tanda prioritas belum dikirim (TabAo, FK-MSM3 R-7) = keinginan per toko dalam peta berkunci salesman|principal|tanggal (sessionStorage `fk-draf-prioritas`, hanya tanggal tampil; tanpa storage = di layar saja), bertahan melewati muat ulang rute, pindah principal, dan buka Kunjungan lalu kembali, diterapkan ke baris terbaru; saat rute termuat tanda untuk toko yang hilang dari rute / sudah punya hasil kunjungan GUGUR (`gugur`, tidak hidup lagi bila toko ditambah ulang) → strip "N tanda prioritas dibuang" bernama toko per sebab; strip ganti hari menyebut tanda belum dikirim yang tidak dibawa ke hari baru. Konfirmasi/Batalkan dikunci selama daftar/rute dimuat ulang (uji D7/B2). Belum: NOO (toko belum di Accurate), persetujuan SPV. Uji: `lib/form-kontrol/fk-msm2{,-pg}.test.ts` (FK-MSM3: halaman basi, kunci berserialisasi, serentak 15×, kesetaraan tulis ⇔ rute 15 tanggal, check-in ∥ status 30× + deterministik baris AO belum COMMIT, AO lolos, kalimat per penulis, GET visit `bukanRute`), Playwright `tests/fiori-form-kontrol-luar-rute.spec.ts` |
| `components/form-kontrol/camera-capture.tsx` | `CameraCapture` | Kamera/pratinjau foto dalam Dialog native; tetap terbuka dan dapat retry sampai callback upload+persistence resolve |
| `lib/form-kontrol/{noo,noo-aturan}.ts` + `app/api/form-kontrol/noo/**` + `tabs/{NooFormulir,TabNoo}.tsx` (NOO toko baru, owner 13 Okt 2026; zona §3 skema + DATA PRIBADI) | `buatNoo`, `daftarNoo`, `ambilNoo`, `hakNoo`/`bolehBacaNoo`/`lihatPembanding`, `putuskanNoo`, `tautkanNoo`, `kunjungiNoo`, `lihatKtp`, `bacaFotoToko`, `saranPelanggan`, `tolakOrderNoo`; murni `galatIsianNoo`/`periksaIsianNoo`, `normalHp`, `periksaNik`, `samarkanNik`, `isKodeNoo`; `olahFoto` (uploads.ts, `limitInputPixels` 40 MP); layar `useJagaPindah`, `useNooMenunggu` (shared.tsx) | Toko yang BELUM ada di Accurate (aplikasi TIDAK menulis ke Accurate). Rute hari ini → "Toko baru (belum ada di Accurate)" (`TambahNoo`, 390 px: nama toko, pemilik, alamat, HP, foto toko, GPS WAJIB `ambilLokasi` — izin ditolak dijelaskan, KTP = NIK 16 angka + nama + foto) → `POST /api/form-kontrol/noo` multipart `{id UUID klien, salesCode, principle, …, fotoToko, fotoKtp, pemilikSama?, alasanDuplikat?}` (`form_kontrol.submit`; salesman pemilik dari SESI `BUKAN_PEMILIK` 403; hari ini WITA server; cabang O1 `cakupanCabang`; principal JKS/cabang `PRINCIPAL_LUAR_CAKUPAN`; Content-Length > 2×5 MB + 512 KB = 413 `FOTO_TERLALU_BESAR` sebelum body dibaca; tanpa Content-Length (chunked/proxy) body dibaca bertahap dan diputus 413 di batas yang sama; foto > 40 MP `FOTO_TIDAK_SAH`; isian 400 `ISIAN_*`/`NIK_TIDAK_SAH`/`HP_TIDAK_SAH`/`GPS_WAJIB`/`FOTO_*` tanpa nilai pribadi; layar: galat per isian sesudah disentuh + "Ke isian yang belum benar"; id sama + isian sama = baris lama 200, isian berbeda 409 `ID_BEDA_ISI` {kodeNoo}, akun lain `ID_TERPAKAI`) → NIK/HP sama dengan NOO belum ditolak = 409 `NOO_DUPLIKAT` + `pembanding` (kode/toko/status HANYA NOO milik salesman itu; milik orang lain hanya `lain` [{cocok}] — bukan oracle NIK/HP→toko; tanpa NIK) kecuali `pemilikSama=ya` + alasan ≥ 10 (`duplikat_dengan`); foto `olahFoto` (rotate, `.flatten` putih, ≤ 1600 px; cap toko; pita KTP "KHUSUS PENDAFTARAN PELANGGAN · kode") ditulis BERURUTAN ke `data/private/noo/<uuid>.jpg` (NOO_DIR, di luar data/uploads → tidak tersaji route foto lama `app/api/uploads/form-kontrol/[file]` (#176), tidak disapu cron 90 hari); foto KTP + toko DISIMPAN SELAMANYA (owner 14 Okt 2026: tanpa penghapusan/retensi otomatis, juga sesudah terdaftar/ditolak); transaksi + `pg_advisory_xact_lock` → `noo_toko` + kunjungan `kunjungan_luar_rute` hari ini (cust_code = kode NOO `NOO-XXXXXXXX`, customer_id NULL) + audit `noo/buat` (tanpa NIK/HP); pengajuan GAGAL (termasuk tulis foto kedua gagal) = berkas yang sudah tertulis di-unlink — satu-satunya penghapusan berkas NOO. Formulir terisi: klik tab/menu DAN tombol Kembali peramban (entri riwayat penjaga + `popstate`) ditanya "Buang isian?" (`useJagaPindah`); galat isian diumumkan `aria-live`. Kunjungan NOO = alur luar rute biasa (check-in/status/merchandising/Batalkan/Dashboard SPV "Toko baru (NOO)"); kunjungan NOO (customer_id NULL + bentuk kode NOO) dikecualikan dari daftar/konfirmasi JKS luar rute (409 `NOO_BELUM_TERDAFTAR`, tanpa membaca noo_toko); ORDER/aktif untuk kode NOO = 409 `NOO_BELUM_TERDAFTAR` (`tolakOrderNoo` di ao-control POST; Kunjungan hanya TIDAK ORDER); NOO tidak masuk daftar toko Order Sales (`simpanRute`). Tab "Toko Baru (NOO)" (`TabNoo`): `GET /api/form-kontrol/noo?status=&salesCode=` + `GET …/noo/[id]?cari=` (`form_kontrol.view`; salesman miliknya, SPV/SM tim `resolveScope`, peran global hanya dengan `manage`/`noo_setujui`/`noo_ktp`/`noo_tautkan` — Manager preset melihat tanpa KTP/aksi; luar cakupan 404 `NOO_TIDAK_ADA`; NIK hanya `nikTersamar`, daftar tanpa HP/pemilik; `boleh` per baris; daftar: status aktif menunggu/disetujui SELALU lengkap, selesai terdaftar/ditolak 300 terbaru + `selesaiTerpotong`/`batasSelesai`; `duplikat` boolean, `duplikatDengan` + pembanding rincian hanya untuk non-salesman/salesman pemilik pembanding; galat muat ulang rincian/cari = strip galat + aksi dikunci, bukan kosong; lencana NOO menunggu di tab (dimuat ulang lewat event `fk:noo-berubah` sesudah aksi; tab berlencana digulir ke layar ponsel) + strip Dashboard SPV `useNooMenunggu`) · `GET …/[id]/foto-toko` (`private, no-store`) · `POST …/[id]/ktp` "Lihat KTP" (`hakNoo().ktp`: `form_kontrol.noo_ktp` grup Admin, SPV/SM pemegang `noo_setujui` untuk timnya (SM = pengganti, owner 13 Okt malam), pengaju selama menunggu; Admin Sales & Manager 403 `KTP_TIDAK_BOLEH`; audit `noo/lihat_ktp` {kode} SEBELUM NIK + foto data URL `no-store`; dialog selalu terpasang, isi KTP dibuang saat ditutup, fokus kembali ke tombol) · `POST …/[id]` `{aksi}`: `setujui`/`tolak` (`form_kontrol.noo_setujui` + cakupan non-salesman: SPV tim, SM atas SPV bawahannya, grup Admin; bukan pengaju `BUKAN_PEMUTUS`; FOR UPDATE + UPDATE bersyarat `status='menunggu_spv'` (dua lapis) `SUDAH_DIPUTUSKAN`; tolak alasan ≥ 5 `ALASAN_WAJIB`; duplikat WAJIB `konfirmasiPemilikSama` `KONFIRMASI_DUPLIKAT_WAJIB` + CHECK DB), `tautkan` (`form_kontrol.noo_tautkan` HANYA grup Admin, owner 13 Okt malam — `manage` Manager/Admin Sales tidak cukup; dari `disetujui` `BELUM_DISETUJUI`; FOR UPDATE + UPDATE bersyarat `status='disetujui'`; pelanggan ada/aktif/cabang sama `PELANGGAN_*`/`CABANG_BERBEDA`; sekali `PELANGGAN_SUDAH_TERTAUT` + UNIQUE; saran = pelanggan cabang sama yang masuk/berubah di sync sejak NOO diajukan, diurut kemiripan kata nama+alamat, atau `cari`), `kunjungi` (pengaju, menunggu/disetujui, hari ini; terdaftar `SUDAH_TERDAFTAR` → luar rute berkode pelanggan). Status menunggu_spv → disetujui | ditolak (final) ; disetujui → terdaftar; audit `noo/setujui|tolak|tautkan` tanpa NIK/isi alasan. Izin baru (registry): `form_kontrol.noo_setujui` (preset SPV/SM), `form_kontrol.noo_ktp` + `form_kontrol.noo_tautkan` (KAPABILITAS; grup Admin) → `docs/handover/RBAC_PRESET_NOO.sql` (5 izin, 3 audit grup). Retensi KTP: SIMPAN SELAMANYA (owner 14 Okt 2026); tidak ada kode yang menghapus KTP sesudah penautan. Uji: `lib/form-kontrol/noo{,-pg}.test.ts`, Playwright `tests/fiori-form-kontrol-noo.spec.ts` |
| `lib/supervisor-review/{kontrak,ringkas-faktur,ringkasan,db}.ts` + `app/api/supervisor-review/{route,koordinat/route}.ts` + `scripts/backfill-ringkas-faktur.mjs` (Supervisor Review SR-1 server, owner 16 Okt 2026; spec `docs/superpowers/specs/2026-10-16-supervisor-review-design.md`; zona §3 skema + sinkron) | `ringkasFaktur` (murni, tanpa impor), `hitungRingkasan`/`waUrl`/`haversineM`/`periksaKoordinat` (murni), `muatSupervisorReview`/`ringkasanKoordinat`/`simpanKoordinat`, `backfill` | Ringkasan harian per salesman untuk SPV/SM/Admin/Manager. Sinkron faktur (`lib/sync.ts` `SYNC_MODULES.sales_invoice.upsertPage` = webhook, webhook-backfill, invoice-outbox/send, cron list.do) mengisi `sales_invoice.salesman_id/qty_total/jumlah_item/dpp` lewat `ringkasFaktur` (masterSalesmanId; Σ quantityDefault, cadangan quantity×unitRatio; jumlah baris; Σ dppAmount); list.do tanpa detailItem = null -> `coalesce` mempertahankan (salesman: jawaban BER-rincian menang utuh). Backfill 60 hari per hari (id dulu, raw_data per 50 PK, hanya `qty_total IS NULL`, `--cek` menghitung, synced_at tetap; di container `node --experimental-strip-types`). `GET /api/supervisor-review?tanggal=&cabang=&principle=` (`supervisor_review.view`; DI LUAR /api/form-kontrol yang di-cache 5 mnt; `private, no-store`; tanggal bawaan `witaToday()`, salah = 400 `TANGGAL_TIDAK_SAH`): cakupan `resolveScope` (SPV tim, SM bawahan — tidak 403, Admin/Manager/admin_sales global; non-global kosong = `pesan HIERARKI_BELUM_TERTAUT`) -> sales_profile + cabang karyawan Accurate (branch) -> faktur INV `trans_date` dd/MM/yyyy -> orang `muatPetaOrang`/`orangDariSalesmanId` (gabungan bulan itu); `qty_total` NULL = `fakturBelumTerbaca` per cabang (cabang pelanggan); tanpa kode = baris "Tanpa salesman terpetakan" (global saja) -> JKS aktif (jadwal = filter `getTodayRoute`: kunci hari + pola minggu ∈ {all, paritasMinggu}) + `ao_control_daily` (checkin/checkout = UTC tanpa zona, dibaca Drizzle sebagai UTC -> ISO +08:00) + luar rute belum batal + noo_toko + toko_koordinat -> `hitungRingkasan` (EC = ORDER/aktif ∪ toko berfaktur, satu toko sekali; Call Non Rute = check-in di luar rencana + faktur tanpa check-in; toko faktur -> kode JKS `kodeJksUntuk`; TOTAL cabang dari jumlah; WhatsApp `wa.me/628…` + ≤ 15 toko terjadwal belum dikunjungi). Filter principle = `sales_profile.principle` (faktur tanpa salesman/belum terbaca disembunyikan). `GET/POST /api/supervisor-review/koordinat` (`form_kontrol.manage`): xlsx (kode toko, latitude, longitude; content-length/berkas > 5 MB = 413 sebelum body dibaca, > 20.000 baris = 400 `BARIS_TERLALU_BANYAK`) -> `periksaKoordinat` (kode JKS, angka/koma desimal, wilayah Indonesia, ganda) ditolak per baris Excel (`__rowNum__`), baris sah di-upsert; GET = toko JKS aktif / berkoordinat / ≤ 200 contoh tanpa koordinat. No HP: `/api/form-kontrol/sales-profiles` GET rows + `noHp`; PUT `noHp` opsional (`normalHp`; tidak sah 400 `NO_HP_TIDAK_SAH`; kiriman noHp saja tidak mengubah hierarki). Izin `supervisor_review.view` (menu Operasional Sales › Supervisor Review) -> `docs/handover/RBAC_PRESET_SUPERVISOR_REVIEW.sql` (SPV, SM, Manager, Admin). Uji: `lib/supervisor-review/{ringkas-faktur,ringkasan,supervisor-review-pg}.test.ts` |
| `lib/sales-invoice-change.ts` + tabel `sales_invoice_line_change` (0037) (pencatat perubahan rincian faktur, owner 23 Okt 2026; spec `docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md`; zona §3 skema + sinkron) | `diffInvoiceLines`, `deletedInvoiceLines` (murni), `parsePrintedView` | `lib/sync.ts upsertSalesInvoiceById(id, creds, ctx)` (webhook / webhook-backfill / invoice-outbox/send) dalam SATU transaksi `pg_advisory_xact_lock(hashtextextended('sales_invoice:'||id,0))`: baca `raw_data` lama -> upsert -> INSERT selisih baris INV (kunci id baris + kode barang; `removed`/`added`/`changed`, faktur tiada -> `invoice_deleted`) di SAVEPOINT (gagal = log `[perubahan-faktur]`, cache tetap). `app_key` dari amplop webhook (`''` = orang di layar Accurate, NULL = penambal/kirim), `saved_at` = `timestamp` amplop (WIB), `printed_at` = `printedTimeView` (WIB), `base_qty_delta` = qty×rasio baru − lama (negatif = stok Accurate naik). Kolom pembanding: qty, satuan, rasio, harga, diskon %, diskon Rp, gudang. Uji: `lib/sales-invoice-change{,-pg}.test.ts` |
| `lib/laporan-sales/kontrak.ts` + `app/(dashboard)/laporan-sales/{page,LaporanSales}.tsx` + `tab/*.tsx` + `app/api/laporan-sales/<tab>/route.ts` + `lib/laporan-sales/<tab>.ts` (Laporan Sales, owner 20 Okt 2026; padanan fungsi EskaLink DMS3SFA `scratch/eskalink-dms3sfa/PETA-LAYAR-2026-10-20.md`) | `TAB`, `tabTerlihat`, `bulanSah`, `rentangBulan` (murni) | Satu halaman, enam tab, satu slice per tab; izin = kunci LAMA per tab (halaman `anyOf` IZIN_HALAMAN, `lib/rbac.ts`): Top 30 + Drop Size `sales_history.view` (Top 30 = SQLite History Penjualan; Drop Size = faktur INV `sales_invoice.dpp` × `customer.category_name`), Target vs Realisasi `insentif_sales.view_all` (target + progres insentif per cabang × principal, hitungan `lib/insentif-sales`), Monitoring Harian / Coverage Ganda / Tidak Order `supervisor_review.view` + cakupan `resolveScope` (faktur INV per pelanggan D1–D31; JKS aktif dilayani > 1 salesman; `ao_control_daily` tanpa order per `no_order_reason`). `?bulan=YYYY-MM`; cabang = cabang Accurate (= divisi principal). Baca-saja. Uji: `lib/laporan-sales/*.test.ts` |
| `components/ui/Dialog.tsx` | `Dialog` | Primitive modal native bersama: focus trap/restoration browser, Escape, label/deskripsi, dan backdrop opsional |
| `components/DataTable.tsx` | `DataTable` | Tabel generik dengan caption, status live, loading skeleton, empty state eksplisit, sorting semantik, kontrol kolom/pagination aksesibel, sticky header, dan density baris konsisten |
| `components/off-program-control/OffGlobalSearch.tsx` | `OffGlobalSearch` | Pencarian pengajuan OFF lewat "/" (diabaikan saat mengetik di isian atau dialog modal terbuka; Ctrl K milik cari menu shell); combobox/listbox mendukung Arrow, Home/End, Enter, dan Escape (hanya saat isian fokus); hasil membuka batch di kolom kedua tab aktif |
| `components/off-program-control/OffNotificationBell.tsx` | `OffNotificationBell` | Tombol berjumlah + popover masalah SLA per peran; "Buka pengajuan" = tautan nyata `?batch=` (tab baru bisa), klik biasa membuka batch di kolom kedua; Sembunyikan berlaku sampai muat ulang |
| `app/(dashboard)/insentif-sales/**` (Fiori S4c) | `InsentifSalesPage`, `InsentifRangka`, `usePeriode`, `useDashboard`, `aksesInsentif`, `halamanTerlihat` | Enam rute (Dashboard, `/saya`, `/pembayaran`, `/data-periode`, `/support`, `/pengaturan`); navigasi dari izin + identitas hierarki (server); periode/principal/cabang di query URL untuk semua halaman; `?view=` lama dialihkan; enam keadaan per layar, aksi tulis lewat ConfirmDialog |
| `app/globals.css` | dasar global | Tailwind + target sentuh 44 px, cincin fokus global, reduced-motion, PWA, `@theme inline` ke token Fiori; komponen dan token tampilan ada di `app/fiori.css` |

### Payments UI Safety

| File | Fungsi Utama | Peran |
|---|---|---|
| `app/(dashboard)/payments/Rekaman.tsx` | `simpanDraf`, tile/saringan, pilihan layar | Kunci baris dari `locked_reason` server; draf isian disimpan SATU `/payments/update` per rekaman (hasil per baris); pilihan tidak dikirim sebagai `ajukan`; keranjang butuh draf kosong; jawaban tidak pasti = muat ulang + kunci tulis |
| `app/(dashboard)/payments/bersama.tsx` | `baca`, `tulis`, `sebab` | 401/403 diterjemahkan menurut kode status; 403 diulang sekali dengan token CSRF baru; putus/≥502/bukan JSON = "belum pasti" |
| `app/(dashboard)/payments/cart/[draftId]/Keranjang.tsx` | `ajukan` | Rekening (lookup) + nomor SPPD sebelum Ajukan; potongan angka ketat; submit tidak pasti → muat ulang; 404 = draf terpakai, terkunci |
| `app/(dashboard)/payments/FormatSppd.tsx` | `simpan` | Simpan terkunci saat setelan gagal/sedang dimuat (AM-019); nomor terakhir hanya dikirim bila diubah + `expected_last_sequence`; nomor tidak boleh turun dalam setahun (D-05) |
| `lib/payments-ui.ts` | `statusRekaman`, `kurangLengkap`, `izinPembayaran`, `pratinjauNomor` | Helper murni (cermin validasi cart/create, izin → alasan nonaktif, templat nomor SPPD); diuji `payments-ui.test.ts` |

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
| `app/api/proxy/route.ts` | `POST` | Forward request ke Accurate API (autentikasi + payload flattening via `lib/accurate-forward.ts`); tolak tulis purchase-payment & sales-invoice; sales-receipt = `pelunasan.kirim`; tulis lain = `api_wrapper.execute` + katalog Konsol (S7-1b) |
| `app/api/finance/purchase-payment/route.ts` | `POST` | Command posting purchase-payment Finance (`finance.update` ∧ `finance.post_accurate`, S7-1c): database sesi wajib = `expectedDatabaseId` (409 `database_changed`), klaim `accurate_write_attempt` sebelum kirim, 409 bila attempt hidup |
| `app/api/finance/purchase-payment/resolve/route.ts` | `POST` | Atestasi manual attempt purchase-payment tidak pasti (alasan + sumber pemeriksaan) |
| `app/api/finance/purchase-payment/attempts/route.ts` | `GET` | Baca-saja status attempt terbaru per kelompok faktur (S6-0e; kontrak `docs/handover/S6-0e-KONTRAK-API.md`) |
| `app/api/auth/accurate-login/route.ts` | `GET` | Mulai OAuth2 Accurate: `state` acak + `returnTo` daftar putih di cookie httpOnly berumur 10 menit, 307 ke authorize (scope tetap) |
| `app/api/auth/callback/route.ts` | `GET` | OAuth2 callback dari Accurate: tolak state hilang/beda SEBELUM tukar code, simpan token, alihkan dengan `accurate=connected` atau `accurate=error&alasan=<kode>` |
| `app/api/faktur/route.ts` | `GET` | Daftar faktur dari cache `sales_invoice` (cari nomor/pelanggan, default hanya nomor mengandung INV, `?all=1` untuk semua) |
| `app/api/faktur/[id]/route.ts` | `GET` | Detail 1 faktur + baris item (qty/harga) live dari `sales-invoice/detail.do`; `?raw=1` menampilkan respons Accurate mentah |
| `app/api/webhook/accurate/route.ts` | `POST` | Terima event webhook Faktur Penjualan dari Accurate (IP whitelist fail-closed + log rotasi + upsert `sales_invoice` + catat perubahan rincian INV ke `sales_invoice_line_change` dengan appKey/timestamp amplop) |
| `app/api/cron/webhook-backfill/route.ts` | `GET` | Membaca log hanya dari runtime path; dynamic file probe diabaikan oleh Turbopack tracing agar standalone image tidak menyalin seluruh repository |
| `app/(dashboard)/api-wrapper/page.tsx` | UI | Antarmuka manual query/bulk-submit ke Accurate. Audit desain 001 (No 7/78/29, usulan G, 27 Okt 2026): log galat dan laporan Retur Manual tidak lagi diunduh otomatis (strip bertahan + tombol "Unduh log galat" / "Unduh retur manual (Excel)"; isi, sheet, nama berkas sama); tab Unggah Excel = Kirim nonaktif beralasan sampai berkas diunggah (tidak ada kiriman contoh payload bawaan endpoint); jalur Payload JSON (URL, method, body, urutan, idempotensi, override duplikat) tidak berubah |
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
| `app/api/idempotency/resolve/route.ts` | `GET` | Pratinjau pencarian Selesaikan pelunasan tidak pasti (baca-saja) |
| `app/api/idempotency/summary/route.ts` | `GET` | Ringkasan pelunasan Tidak pasti / Gagal boleh diulang (Beranda BL-41) |
| `lib/fuzzySearch.ts` | `fuzzySearch` | Pencarian fuzzy in-memory fallback |
| `lib/pdf-text.ts` | `uppercasePageText` | Uppercase teks untuk header PDF |
| `lib/off-program-control/holidays.ts` | `isHoliday`, `getNextWorkday` | Kalender hari libur untuk kalkulasi deadline |

### Rekapan Nota

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/rekapan-nota/parse.ts` | `parseAccurateExport`, `normalizeHeader`, `deriveKonvTersirat` | Parser export Accurate, pure. Uji regresi: 131 nota HEINZ ABC 21 Agu 2026 vs `Paste Data Sore` -> 131/131 nota, 776 baris, nol selisih |
| `lib/rekapan-nota/classify.ts` | `resolveKlasifikasi`, `hitungPareto`, `klasifikasiSirup`, `isiPerKarton` | Aturan grup/area/pareto/sirup. Pure (eksklusi NON/LUAR KOTA dihapus 19 Okt 2026) |
| `lib/rekapan-nota/query.ts` | `buildRekapan`, `buildTtf`, `notaPool`, `ambilPickGroup`, `ambilSetting` | Satu CTE, dua proyeksi (withdrawal + allocation); pool anti-join; TTF |
| `lib/rekapan-nota/exception.ts` | `deteksiException`, `hitungExceptionOpen` | Deteksi set-based sekali per release, idempoten lewat `uq_wave_exception` |
| `lib/rekapan-nota/area-suggest.ts` | `parseKelKec`, `bangunIndeks`, `usulkanArea`, `usulkanSemua` | Usulan area; memakai `lib/sales-history/fuzzy.ts`, tidak menulis matcher baru |
| `lib/rekapan-nota/wave-state.ts` | `transisiWave`, `tolakUbahIsi` | State machine draft->released->confirmed/cancelled + penjaga ubah isi per status (BL-25). Pure |
| `lib/rekapan-nota/wave-penjaga-pg.test.ts` | 10 uji PG | BL-24/25/54 pada route asli di skema sekali-pakai (migrasi 0002), termasuk 409 serentak deterministik; dilewati tanpa `AM040_DATABASE_URL` |
| `lib/rekapan-nota/parse.test.ts` + `rules.test.ts` + `area-suggest.test.ts` | 13 self-check | `npm run test:rekapan`. Uji file-based SKIP (bukan lulus diam-diam) kalau sumbernya tidak ada |
| `app/api/rekapan-nota/upload/route.ts` | `POST` | Upload + parse + isi pool, idempoten per sha256; nota yang sudah ada dilewati/diganti/jadi exception selisih (BL-54). Guard `rekapan_nota.manage` |
| `app/api/rekapan-nota/pool/route.ts` | `GET` | Nota tersedia per tanggal. Guard `rekapan_nota.view` |
| `app/api/rekapan-nota/wave/route.ts` | `GET`,`POST` | Daftar wave per tanggal; buat wave (N wave/hari, bukan 2 hardcode) |
| `app/api/rekapan-nota/wave/[id]/route.ts` | `GET`,`PATCH` | Detail wave; release/confirm/cancel bersyarat status lama (409); cancel melepas semua nota; pilih pick_group (409 pada wave tertutup) |
| `app/api/rekapan-nota/wave/[id]/nota/route.ts` | `POST`,`PATCH` | Tambah nota (409 + identitas pemilik), ubah prioritas, take-out berapproval; semua 409 pada wave tertutup |
| `app/api/rekapan-nota/wave/[id]/exception/route.ts` | `PATCH` | Tutup exception: Selesai / Abaikan + alasan (BL-24); 409 bila sudah ditutup |
| `app/api/rekapan-nota/area/route.ts` | `GET`,`POST` | Antrean mapping area + usulan; terima satuan/massal |
| `app/(dashboard)/rekapan-nota/page.tsx` | `RekapanNotaPage` | Wave monitor + upload export |
| `app/(dashboard)/rekapan-nota/wave/[id]/page.tsx` | `WavePage` | Susun wave dari pool, pilih grup cetak, rilis/konfirmasi |
| `app/(dashboard)/rekapan-nota/area/page.tsx` | `AreaMappingPage` | Antrean mapping area + terima massal TINGGI |
| `app/api/rekapan-nota/kanvas/route.ts` | `GET`,`POST`,`DELETE` | Nota per salesman + tandai/batal tandai kanvas. Menolak menandai nota yang sudah di wave reguler, dan menolak mencabut tanda yang sudah di wave kanvas rilis |
| `app/(dashboard)/rekapan-nota/kanvas/page.tsx` | `KanvasPage` | Penandaan kanvas: kelompok per salesman, multi-select, tawaran sekali "tandai semua nota salesman ini" |
| `app/(cetak)/layout.tsx` + `BingkaiCetak.tsx` | `CetakLayout`, `BingkaiCetak` | Grup route cetak: tanpa sidebar, guard `rekapan_nota.print` sendiri, CSS `@page`/`@media print`. Bilah Fiori di LAYAR pratinjau (judul + Wave #id, Kembali ke wave, Cetak = `window.print()`); `FioriScope.layar-saja` → `display:none` saat cetak, kertas tidak berubah |
| `app/(cetak)/rekapan-nota/wave/[id]/cetak/page.tsx` | `CetakRekapanPage` | SATU template lembar rekapan berparameter grup (server component) |
| `app/(cetak)/rekapan-nota/wave/[id]/ttf/page.tsx` | `CetakTtfPage` | SATU template TTF berparameter wave |

RBAC: module `rekapan_nota` (`view`/`manage`/`print`/`approve_takeout`) di `lib/rbac/registry.ts`
+ `lib/rbac.ts` (appModules, moduleLabels, moduleActions, pagePermissions `/rekapan-nota`, preset manager),
menu sidebar `Rekapan Nota`.


---

## Data & Config

### Env Config
- **`.env.example`** — template lengkap semua variabel (tidak mengandung secret)
- **`.env.local`** — env aktif lokal (tidak di-commit ke git)

**Variabel kunci:**

| Variabel | Fungsi |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL (`postgres://...`) untuk runtime Next.js |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` | Base URL + secret Better Auth; secret wajib diinjeksi runtime, tanpa fallback di Compose atau image |
| `NEXT_PUBLIC_APP_URL` | URL publik Next.js (browser) |
| `NEXT_PUBLIC_FASTAPI_BASE_URL` | URL Python backend (browser) |
| `ACCURATE_CLIENT_ID` / `ACCURATE_CLIENT_SECRET` | OAuth2 Accurate |
| `ADMIN_SETUP_TOKEN` | Token one-time bootstrap admin pertama |
| `SMTP_*` | Konfigurasi email (host/port/user/pass/from) |
| `MIMO_API_KEY` | MiMo (OpenAI-compatible, `MIMO_BASE_URL` default `https://api.xiaomimimo.com/v1`): OCR vision Master Barang + editor QA Summary (opsional) |

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
idempotency_log [fingerprint bulk upload; lockId/lockedBy] ── idempotency_override [jejak override Finance]
accurate_write_attempt [klaim tulis Accurate per subjek × generasi] ── accurate_write_attempt_reopen [repost D-15, rilis B]
  (FK melingkar + trigger immutability + REVOKE = DDL manual docs/handover/DDL_ADR004.sql, dijalankan saat deploy)

# Dynamic RBAC (additive — Fase 2/4; user.role & user.permissions TIDAK dihapus)
access_group ──── group_permission (group_id)   [permission_key = "module.action"]
  └──────────── user_group (group_id + user_id)  [akses user = UNION group; is_primary = bintang grup utama, maks. 1/user — S7-0, dibaca mulai S7-1/S7-3]
permission_audit_log [siapa ubah group/permission/user siapa, kapan; dibaca riwayat S7-1]

# Kunjungan luar rute (FK-MSM2; db/migrations/0034_kunjungan_luar_rute.sql sesudah 0033; DDL manual docs/handover/DDL_FK_MSM2.sql SESUDAH DDL_O1.sql, SEBELUM image)
kunjungan_luar_rute [(sales_code, cust_code, principle, tanggal) unik WHERE dibatalkan_pada IS NULL = satu toko luar rute AKTIF per salesman/hari;
  cust_code = customerNo Accurate LENGKAP; konfirmasi menunggu|jks|tidak|sudah_jks (CHECK; jks WAJIB jks_id + hari + pola + dikonfirmasi_pada);
  batal lunak dibatalkan_pada/oleh (CHECK berpasangan, baris jks tidak bisa batal); accapi_app SELECT/INSERT/UPDATE, TANPA DELETE (jejak)]
  └── jks_id -> jks_master.id (tanpa FK; jejak "ditambahkan salesman", jks_master tidak diubah bentuknya) · kunjungan = ao_control_daily (cust_code sama)
  migrate-pg entri "kunjungan_luar_rute (FK-MSM2)" (sudahAda pg_indexes + pg_attribute 4 kolom termasuk dibatalkan_pada; non-pemilik = SKIP sesudah DDL manual)

# NOO toko baru (owner 13 Okt 2026; db/migrations/0035_noo_toko.sql sesudah 0034; DDL manual docs/handover/DDL_NOO.sql SESUDAH DDL_FK_MSM2.sql, SEBELUM image;
#   izin ke grup docs/handover/RBAC_PRESET_NOO.sql SESUDAH image)
noo_toko [id = UUID klien (idempoten); kode NOO-XXXXXXXX unik; status menunggu_spv|disetujui|ditolak|terdaftar; DATA PRIBADI nik (16 angka) + foto_ktp
  (nama berkas acak di volume /app/data/private/noo, satu kolom per foto; DISIMPAN SELAMANYA, owner 14 Okt 2026); 7 CHECK (status, isi, pribadi, gps, duplikat — disetujui WAJIB duplikat_dikonfirmasi,
  keputusan, tautan); UNIQUE customer_id WHERE terisi = satu pelanggan satu NOO; indeks nik/no_hp WHERE belum ditolak (cek ganda);
  accapi_app SELECT/INSERT/UPDATE TANPA DELETE; Metabase TIDAK diberi]
  └── kode = kunjungan_luar_rute.cust_code (kunjungan NOO, customer_id NULL; tanpa FK) · customer_id -> customer.id sesudah ditautkan Admin (cabang sama)
  migrate-pg entri "noo_toko (NOO)" (sudahAda pg_indexes idx_noo_customer + pg_attribute 4 kolom)

# Supervisor Review (owner 16 Okt 2026; db/migrations/0036_supervisor_review.sql sesudah 0035; DDL manual docs/handover/DDL_SUPERVISOR_REVIEW.sql SEBELUM image;
#   lalu scripts/backfill-ringkas-faktur.mjs; izin ke grup docs/handover/RBAC_PRESET_SUPERVISOR_REVIEW.sql SESUDAH image)
sales_invoice + salesman_id bigint, qty_total numeric, jumlah_item integer, dpp numeric(18,2) [nullable tanpa default; NULL = rincian belum terbaca; diisi sinkron + backfill]
sales_profile + no_hp text [CHECK sales_profile_no_hp 08… (= noo_toko_pribadi); NULL boleh; diisi Admin di tab Hierarki]
toko_koordinat [cust_code PK = kode JKS; lat/lng NOT NULL, CHECK toko_koordinat_wilayah (lat -11…6, lng 95…141); diperbarui_pada/oleh; accapi_app SELECT/INSERT/UPDATE TANPA DELETE]
  migrate-pg entri "supervisor review (SR-1)" (sudahAda pg_attribute 4 + 1 kolom + pg_constraint 2 CHECK; lock_timeout 5 dtk + hak toko_koordinat bila
    accapi_app ada — produksi PUNYA DATABASE_MIGRATION_URL, jadi DDL manual lebih dulu agar entri ini SKIP dan ALTER tidak bersaing dengan kunci saat deploy)

# Jejak pencabutan (audit desain 001 No 6 dan 18, owner 27 Okt 2026; db/migrations/0038_pencabutan_log.sql = entri migrate-pg "pencabutan_log";
#   tanpa DATABASE_MIGRATION_URL jalankan 0038 sebagai role pemilik SEBELUM image: Cabut di dua route butuh tabel ini)
pencabutan_log [append-only: id bigserial, jenis (CHECK invoice_verify_note | order_dupe_ack), kunci, baris_lama jsonb (baris yang dicabut, kunci
  camelCase), alasan (CHECK btrim <> '', server 10..500), oleh (email sesi), waktu; indeks (jenis, kunci, id); tanpa FK; accapi_app SELECT/INSERT
  saja (REVOKE UPDATE/DELETE/TRUNCATE bila role ada)]
  └── ditulis dalam transaksi yang SAMA dengan DELETE invoice_verify_note (Verifikasi balik) / order_dupe_ack (Order Principal)

# Principal resmi (S7-0/S7-2 BL-64; DDL manual docs/handover/DDL_S7_0.sql lalu DDL_S7_2.sql SEBELUM image)
principal [code unik = kode OPC/Klaim, TETAP] ── principal_variant (principal_id + variant_key; '' = varian dasar)
  └──────────── principal_alias [id; alias_norm unik per kelompok: kode Master Barang | nama/label/kode OPC -> principal (+ varian); nilai WAJIB dari normalizer baku lib/principal/normalisasi.ts]
principal_log [append-only (trigger + REVOKE di DDL_S7_2): satu baris per buat/aktif/nonaktif/hapus, transaksi sama dengan perubahannya]
  Riwayat GET /api/principals/{id}/history (riwayatPrincipal) LEFT JOIN "user" ON user.id = principal_log.aktor -> `actorName` per baris (null untuk
  benih:… atau akun yang sudah tidak ada); layar Riwayat menulis nama, id akun hanya cadangan (audit desain 001 No 87).
  API app/api/principals/** (lib/principal/tulis.ts; kontrak docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md): GET daftar/riwayat
  (principles.view), tulis (principles.upload; hapus alias principles.delete) — 409 berkode tanpa menimpa, 503 tanpa trigger penjaga.
  Resolver lib/principal/resolver.ts (ruang WAJIB nama | kode_master_barang; alias saja: cocok | tak_dikenal | ambigu; GET /api/principals/resolve).
  Layar S7b /data-principal (components/principal/*; menu Pengaturan; pagePermissions principles.view; tombol tulis disembunyikan tanpa principles.upload / principles.delete):
  daftar + Object Page (varian, alias, riwayat, Dipakai di = tautan). Rute lama (/principles, /principal-mapping) TIDAK dialihkan (menyusul).
  Laporan + benih: docs/handover/PRINCIPAL_EKSPOR.sql (psql -qAt di VPS, baca-saja -> 1 baris JSON) lalu OFFLINE npx tsx scripts/principal-laporan.mjs
  --dari-json (atau DATABASE_URL langsung, berkas SQL yang sama) -> laporan.md/json + benih.sql (INSERT ... ON CONFLICT DO NOTHING) untuk ditinjau owner.
  Pemakai S7-2b (lib/principal/pemakai.ts): Mapping Principal (PUT/impor/GET/DELETE app/api/principal-mapping/**) + Master Barang
  (createMaster/adapt_legacy) WAJIB principal dikenal alias (400 PRINCIPAL_TIDAK_DIKENAL + saran / 409 PRINCIPAL_NONAKTIF), disimpan dengan
  NAMA RESMI (nama varian | nama principal); kode Master Barang 2 karakter = alias kode_master_barang (400 KODE_MB_TIDAK_COCOK; tanpa kode
  otomatis). Python Master Principle, OPC/Klaim, Finance/SPPD belum beralih (langkah 3–5).

# Kasir ↔ Incaso (K1a BL-59; skema + lib murni lib/kasir/rekonsiliasi.ts; pembaca K1b, UI K2; DDL manual docs/handover/DDL_K1A.sql SEBELUM image; kontrak docs/handover/KASIR-KONTRAK.md)
kasir_setoran [append-only; (tanggal, salesman_kode=ORANG, revisi) unik; revisi n+1 -> revisi n (FK komposit); tunai/transfer/giro >= 0; K2a: giro_nomor/giro_jatuh_tempo, bukti_transfer = nama berkas <uuid>.<jpg|png|pdf>]
kasir_selisih_catatan [append-only; angka pelunasan/setoran saat dijelaskan; '' = Tanpa salesman] · kasir_tak_teralokasi_catatan [append-only; per pelunasan, angka sisa]
kasir_hari_event [append-only; tutup (snapshot.terhalang WAJIB [] — owner T2) | kunci (otomatis 20.00 WITA, boleh terhalang) | buka(alasan >= 15)]
  izin ke grup: docs/handover/RBAC_PRESET_KASIR.sql SESUDAH RBAC_PRESET_BL37.sql (S7-1)
  S7-1b (urutan di header SQL): RBAC_S7_1B_CEK.sql baca-saja -> PK-1 owner (12 Okt: biarkan — KUNCI tidak menulis api_wrapper.*;
  Admin/Fakturist/Manager sudah memegang execute) -> RBAC_S7_1B_KUNCI.sql SEBELUM image -> image ->
  RBAC_S7_1B_PENSIUN.sql SESUDAH image -> CEK ulang (mode cek bawaan = ROLLBACK; terapkan PGOPTIONS='-c rbac.terapkan=1')
  S7-1c (PK-2: tegakkan = kunci lama ∧ baru di Python finance/payments/summary + POST /api/finance/purchase-payment):
  cadangan -> RBAC_S7_1C_KUNCI.sql (mode cek -> terapkan) SEBELUM image -> image (pasangan: lib/rbac/s7-1c-pg.test.ts)
kasir_pelunasan (database_id + pelunasan_id; chequeAmount, metode, last_update) ── kasir_pelunasan_faktur (faktur_id, master_salesman_id, invoice_payment) [cache K1b, TANPA raw_data]
  masterSalesmanId -> accurate_employee.number -> sales_code_merge (merge, per bulan) -> ORANG; OTHERS dikeluarkan; Σ invoicePayment ≠ chequeAmount -> ember tak teralokasi; cheque uang < 0 -> ember nominal_negatif (K-1 a)
kasir_pelunasan_baca (database_id + tanggal; status berjalan|lengkap|sebagian|gagal, sebab (+hapus_massal), sisa_detail, ditolak, token lease 2 mnt, lengkap_pada, akun_sinkron, penuh_tertunda_pada) [K1b; DDL_K1A -> DDL_S7_2 -> DDL_K1B SEBELUM image; 0031 sesudah 0030]
  pembaca K1b (lib/kasir/baca-pelunasan.ts, identitas SINKRON resolveSyncCredentials; murni lib/kasir/pembaca.ts):
    POST /api/kasir/segarkan {tanggal, penuh?, konfirmasiHapus?} (kasir.view; penuh/konfirmasi = kasir.buka) | GET /api/cron/kasir-pelunasan (CRON_SECRET; hari ini WITA + mundur ke hari kerja sebelumnya; penuh=1 menunggu lease; sedang_dibaca = 202)
      -> lease (INSERT .. ON CONFLICT .. WHERE lease basi) -> sales-receipt/list.do filter transDate (fail-closed pageCount/rowCount) -> detail.do HANYA id baru/lastUpdate beda
         (≤ 4 serentak, 429 -> 2) -> upsert kasir_pelunasan + ganti _faktur per pelunasan (token FOR SHARE) -> hapus id hilang (daftar lengkap saja) -> status
    GET /api/kasir/segarkan?tanggal= (status tanpa Accurate) | muatPelunasanHari(databaseIdSinkron(), tanggal) -> Pelunasan[] untuk K2/K3 (Tutup hanya bila lengkap)
  server K2a (lib/kasir/hari.ts; kontrak KASIR-KONTRAK §8; DDL_K2A = kolom giro_nomor/giro_jatuh_tempo SESUDAH DDL_K1B; 0032):
    GET /api/kasir?tanggal=&orang= (kasir.view) -> [kunci 20.00 belum dicatat? catatKunciOtomatis] -> snapshot REPEATABLE READ: event + setoran + catatan
        + muatPelunasanDalam (cache sinkron) + muatPetaOrang -> rekonsiliasiHari -> bentukJawabanHari (angka Incaso HANYA bila status baca lengkap)
    POST /api/kasir/setoran (kasir.catat; JSON | multipart data+bukti; bacaBadanTerbatas ≤ 6 MB, chunked diputus -> 413) -> uraiSetoran (kolom ≤ Rp 100 miliar)
      -> [bukti: magic bytes, ≤ 5 MB -> normalkanBukti (sharp: gambar -> alfa diratakan putih -> JPEG ≤ 2000 px tanpa EXIF; PDF apa adanya) -> simpanBukti data/uploads/kasir-bukti/<uuid>]
      -> catatSetoran (total hari ≤ Rp 10 triliun sebelum INSERT; CHECK DB giro_wajib/bukti_wajib/form_wajib = jaring kedua)
    POST /api/kasir/jelaskan (kasir.catat) | POST /api/kasir/tutup (kasir.tutup) | POST /api/kasir/buka (kasir.buka) | GET /api/kasir/bukti?id= (kasir.view)
      tulis = transaksiHari: READ COMMITTED -> pg_advisory_xact_lock(hashtextextended('kasir:'||tanggal,0)) -> [tutup: SELECT kasir_pelunasan_baca FOR SHARE]
        -> muatDalam -> pastikanKunci (event kunci 'sistem' bila otomatis_20) -> bolehDiubah/statusHari -> hitung ulang -> INSERT (append-only)
        galat di dalam = rollback (pasti) | galat sesudah callback = 502 TIDAK_PASTI
  UI K2b /kasir (menu Keuangan › Kasir ↔ Incaso; app/(dashboard)/kasir: Kasir.tsx FCL + DialogKasir.tsx + bersama.ts):
    GET /api/kasir (hari) + ?orang= (rincian faktur) -> KPI/daftar orang/ember/non-kas; angka Incaso null = "belum terbaca" (bukan 0)
    Setoran… (JSON | multipart data+bukti) / Jelaskan… / Buka kembali… -> POST route K2a; jawaban PASTI vs TIDAK PASTI menurut §8.2 (bersama.nilaiJawab)
    Tutup hari… -> [!segarUntukTutup] POST /api/kasir/segarkan berulang (jeda 6 dtk, maks 20, Batal) -> GET -> dialog hanya bila penghalang kosong -> POST tutup {sidik}
    tidak pasti -> muat ulang + banding revisi/penjelasan/event, tanpa ulang otomatis; lewat kunciBerikutnya -> muat ulang sendiri
  K3 tile Beranda Kasir (profil kasir saja, ★ grup utama; kontrak KASIR-KONTRAK §9; lib/kasir/ringkasan.ts):
    GET /api/kasir/ringkasan?tanggal= (kasir.view, BACA-SAJA: tanpa Accurate, tanpa catat kunci otomatis) -> muatDalam (muatan sama dengan GET /api/kasir)
        + event Tutup jendela (hari ini + 7 hari kerja) -> bentukRingkasan: selisih (orang + ember belum dijelaskan), belumSetor, hariBelumDitutup (statusHari.sebab != tutup)
        Incaso belum lengkap -> selisih/belumSetor null -> tile "belum terbaca" (lib/beranda.ts SOURCES.kasir.valid wajib; bukan 0, bukan semua beres)
```

**Status Lifecycle offBatch:**
`Draft -> Submitted to SM -> [Returned by SM] -> Approved by SM -> Claim Approved -> Ready for OM -> Approved by OM -> Waiting Payment -> Partial Paid -> Paid -> [Cancelled / Cancelled by OM]`

**Status Lifecycle claimWorkflow:**
`Draft -> In Progress -> Submitted -> Paid -> Partially Paid -> Closed / Overpaid`

**Rekapan Nota (modul baru):**

```
rekap_upload ──── wave_line_pool (upload_id)      [sumber baris nota, dari export Accurate]
nota_kanvas [penanda manual; berkunci no_nota, selamat dari upload ulang]

wave ──── wave_assignment (wave_id)               [uq_nota_aktif: 1 nota = 1 penugasan aktif]
  │        └─ FK komposit (wave_id, wave_tipe) -> wave(id, tipe)
  │           + CHECK snap_kanvas = (wave_tipe = 'kanvas')
  ├──────── wave_pick_group (wave_id + pick_group_id)
  ├──────── wave_exception (wave_id)
  └──────── wave_event (wave_id)                  [append-only audit trail]

pick_group ──── pick_group_member (pick_group_id)
  dimensi: outlet_all | outlet_gdi | area | volume | jenis_produk | sirup
  17 grup di-seed migrasi; grup `jenis_produk` di-upsert dari data tiap upload

Kolom tambahan pada tabel existing (aditif):
  item.isi_per_karton, item.satuan_besar
  customer.area, customer.grup_all, customer.grup_gdi, customer.alamat
    (alamat WAJIB: Kel./Kec. di dalamnya adalah satu-satunya sinyal mesin usulan area.
     Cache Accurate tidak membawanya -> diisi dari `Master Area Heinz` saat impor master,
     lalu dijaga segar dari alamat yang ikut tiap baris nota saat upload.)

Parameter di app_setting (tabel existing, bukan tabel baru):
  rekapan.ambang_pareto_karton    = 50
  rekapan.baris_per_lembar_faktur = 13
  (rekapan.area_dikecualikan masih ada di tabel tetapi TIDAK dibaca lagi sejak 19 Okt 2026)

Status Lifecycle wave:
  Draft -> Released -> Confirmed / Cancelled
  (Released boleh jalan dengan exception open; Confirmed tidak, selama ada KONVERSI_* open)
```


### Migrasi & Seed

| File | Fungsi |
|---|---|
| `scripts/init-db.mjs` | Buat semua tabel SQLite dari schema (dev pertama kali) |
| `scripts/migrate-local.mjs` | Jalankan migrasi drizzle-kit lokal |
| `scripts/migrate-opc-columns.mjs` | Migrasi tambahan kolom OPC |
| `db/migrations/` | Output drizzle-kit (SQL migration files) |
| `scripts/seed-opc-dummy.mjs` | 1.275 batch dummy OPC (51 batch x 25 principal, semua 12 problem code) |
| `scripts/migrate-rbac-groups.mjs` | Buat tabel Dynamic RBAC (access_group, group_permission, user_group, permission_audit_log) — additive & idempotent |
| `scripts/seed-rbac-presets.ts` | Sinkron preset Dynamic RBAC termasuk `manage_hierarchy` dan Laporan Harian + backfill user_group (`node --experimental-strip-types`) — PostgreSQL; MENGGANTI izin grup preset (izin manual via UI hilang), wajib `RBAC_PRESET_SYNC=reset-preset-groups` |
| `db/migrations/0002_rekapan_nota.sql` | DDL modul Rekapan Nota (10 tabel + 6 enum + kolom item/customer) + seed 17 pick_group & 3 app_setting; idempoten |
| `scripts/apply-rekapan-migration.mjs` | Terapkan 0002 ke PostgreSQL LOKAL dalam satu transaksi (guard hostname; produksi manual dengan role ber-DDL) |
| `scripts/bandingkan-rekapan-excel.ts` | Kriteria lulus Fase 3: adu hasil AccAPI vs `Paste Data Sore` PER SKU PER GRUP (bukan grand total). Selisih wajib punya sebab yang dibuktikan ke DB; kalau tidak, exit 1. `npx tsx scripts/bandingkan-rekapan-excel.ts --wave <id>` |
| `scripts/import-rekapan-master.mjs` | Impor sekali `Konversi`/`Master Area Heinz`/`Pemisah` dari workbook ke item & customer; melaporkan yang tidak cocok, tidak menelannya |
| `scripts/sync-insentif-hierarchy.mjs` | Upsert assignment SPV→Sales dan SM→SPV dari target periode terbaru; tidak menebak identitas akun login |

### Output & Runtime Artifacts

| Path | Isi |
|---|---|
| `sqlite.db` | Snapshot/sumber migrasi dan rollback SQLite lama; bukan runtime route Next.js setelah D4 |
| `runtime/off-program-control/` | PDF pengajuan OPC |
| `runtime/claim-workflow/` | PDF surat klaim, summary, kwitansi, per-submission |
| `runtime_logs/` | Log runtime (dipakai Python backend) |
| `data/uploads/kasir-bukti/` | Bukti setoran Transfer Kasir (K2a; `<uuid>.<jpg\|png\|pdf>`, volume data frontend, retensi permanen — cron cleanup-uploads tidak menyentuh) |
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

> Diperbarui 2026-08-28 (audit modul kedua, 4 agent paralel). Temuan lengkap:
> [docs/handover/AUDIT_INSENTIF_SALES_2026-08-28.md](docs/handover/AUDIT_INSENTIF_SALES_2026-08-28.md).
> Sebelumnya tertulis "MT belum ada aturan insentif" dan "SPV belum di-wire" — keduanya sudah tidak benar.
>
> **Diperbaiki 19 Okt 2026 (BL-26):** `getScopeForUser` kini fail-closed: tanpa izin kelola dan tanpa `hierarchyRole` = cakupan kosong, Dashboard menampilkan "belum ditautkan" (C3).
>
> **Belum diperbaiki (menunggu persetujuan, lihat dokumen audit):** filter Principal/Cabang mengubah
> nominal mix (C1); default demo `NESTLE`/`BANDUNG` masih dipasang klien di `page.tsx:1250` sehingga
> M10 terbuka lagi untuk jalur upload Excel (C2); dan 4 endpoint uang tanpa row-level scope pada jalur tulis.

### Peta layer (trace-by-flow)

| Layer | Lokasi |
|---|---|
| **Entry point UI** | `app/(dashboard)/insentif-sales/` — rute server tipis (`page.tsx`, `saya/`, `pembayaran/`, `data-periode/`, `support/`, `pengaturan/`) → klien `Dashboard`, `Saya`, `Pembayaran`, `DataPeriode`(+`Kualitas`), `Support`, `Pengaturan`(+`Hierarki`); kerangka `Rangka.tsx`, rincian/PPh bersama `Rincian.tsx`; halaman per izin di `lib/insentif-ui.ts` (`HALAMAN`), peran dari `lib/insentif-akses.ts`. `?view=sm|spv|sales|finance|admin` lama dialihkan |
| **Handler/route** | `app/api/insentif-sales/*/route.ts` (20 route, daftar di bawah) |
| **Business logic (pure)** | `lib/insentif-sales-calc.ts` (GT), `lib/insentif-mt-calc.ts` (MT), `lib/insentif-spv-calc.ts` (SPV), `lib/insentif-sm-calc.ts` (SM), `lib/insentif-value-source.ts`, `lib/sales-code-merge.ts`, `lib/insentif-payee.ts`, `lib/excel-date.ts` (tanggal Excel, anti geser 1 hari) |
| **Setelan aturan** | `lib/insentif-settings.ts` + tabel `app_setting` — ambang Target AO GT/TT (`fixed240` \| `file`) + pengecualian **per baris per periode** (key `insentif_ao_file:YYYY-MM`, daftar `KODE\|PRINCIPAL`; tombol "Pakai target file" di tabel Input Support Principle → `PATCH /api/insentif-sales/targets/ao-file`, izin `upload_target` + cakupan tim) + principal yang tetap dihitung untuk **SPV** walau semua sales bawahannya `principle` (key `insentif_spv_ikut:YYYY-MM`, daftar `NAMA SPV|PRINCIPAL`; tombol di panel Input Support Principle - SPV → `PATCH /api/insentif-sales/spv-ikut`, hanya izin lihat-semua; dibaca `spv-dashboard` → `calculateInsentifSPV(…, ikutPaksa)`), daftar cabang NILAI_JUAL, daftar SM berhak, dan **semua konstanta uang** (`lib/insentif-konstanta.ts`, key `insentif_konstanta`: pool & bobot GT/MT, ambang bayar, ambang IA MT, rate SPV, strata SM, tarif PPh). Diubah lewat `PATCH /api/insentif-sales/settings` (izin `manage`) dari panel Admin → "Konstanta skema insentif". Gagal baca: dashboard (`getKonstanta`) jatuh ke bawaan `DEFAULT_KONSTANTA`; jalur tulis memakai `readKonstanta`/`readKonstantaVersi` yang MELEMPAR (AM-020), dan `GET settings` melabeli `konstantaSumber: "gagal_baca"` sehingga editor Pengaturan terkunci. Versi (AM-045): `konstantaVersi` = `updatedAt` ISO; `PATCH` konstanta wajib membawanya (tanpa → 400, beda → 409 `KONSTANTA_BERUBAH`, tulis bersyarat pada isi yang dibaca). Fungsi kalkulasi menerimanya sebagai parameter `k`, tanpa `k` memakai bawaan. |
| **Data access** | `lib/insentif-sales.ts` (`getTargetsForPeriod`, `computeMtdProgress`, `computeMtdByPrinciple`, `getMergeMap`), `lib/insentif-hierarchy-scope.ts` (row-level scope) |
| **Parser Excel** | `lib/insentif-sales-excel.ts` (`parseTargetExcel`), agregasi closing di browser (`page.tsx`) |
| **DB** | `sales_targets`, `sales_daily_progress`, `incentive_support`, `spv_support`, `incentive_payments`, `incentive_tiers`, `sales_code_merge`, `spv_sales_assignment`, `sm_spv_assignment`, `spv_sales_claim_request`, `app_setting` |

Route: `dashboard`, `spv-dashboard`, `sm-dashboard`, `progress`, `targets`, `targets/template`,
`support`, `spv-support`, `payments`, `payments/[id]`, `tiers`, `code-merge`, `spv-mismatch`,
`settings`, `unmatched`, `hierarchy/{spv-sales,spv-sales/requests,sm-spv,user-identity,my-identity}`.

**Aturan yang berubah sejak 2026-08-26:**
- **SPV: ambang 100% per principal.** `spvMultiplier` (`lib/insentif-spv-calc.ts`) menggantikan
  `percentageMultiplier`: di bawah 100% principal itu Rp 0, ≥100% dibayar rate penuh. Principal yang
  gagal target tetap dihitung sebagai principal yang dipegang. Fungsi terpisah dengan sengaja —
  berbagi dengan Sales/MT berarti mengubah aturan SPV ikut mengubah nominal Sales.
- **Target EC/AO/IA `sales_targets` kini `double precision`** (file target nyata berisi 204,8).
  `achieved_ec/ao/ia` di `sales_daily_progress` **masih `integer`** — risiko yang sama belum ditutup.
- **Target IA adalah rata-rata per outlet**, bukan total. Jangan dibagi lagi dengan target AO;
  `lib/insentif-mt-calc.ts` membandingkan `realisasi_ia/realisasi_ao` langsung ke `target_ia`.
- **Ambang AO GT/TT bisa dipindah** antara 240 dan Target AO file lewat setelan di atas.

### Empat skema insentif, dipisah peran + channel

| Skema | Berlaku | Logic | File |
|---|---|---|---|
| **GT/TT** — 2 KPI: AO 70% + Value 30%, pool konstanta | channel `GT`/`TT` | `computeExclusive` / `computeMix` | `lib/insentif-sales-calc.ts` |
| **MT** — 4 KPI bobot nominal: VALUE 350rb, EC 150rb, OA 150rb, IA 350rb | channel `MT` | `calculateInsentifMT` | `lib/insentif-mt-calc.ts` |
| **SPV** — murni Value, rate per principal | per `spv_name` | `calculateInsentifSPV` | `lib/insentif-spv-calc.ts` |
| **SM** — murni Value, strata FLAT (nominal, tidak dikali %) | per `sm_name`, whitelist | `calculateInsentifSM` | `lib/insentif-sm-calc.ts` |
| **Strata-DB** (4 KPI rata-rata) | **tidak dipakai lagi** untuk insentif; achievement 4-KPI tetap jalan | `lookupTierFromDb` (`incentive_tiers`) | `lib/insentif-sales.ts` |

**GT/TT:** pengali `<0.90→0`, `0.90–1.00→aktual`, `>1.00→cap 1.00`. Target AO konstan **240**
(khusus GT, bukan kolom AO target). Distributor bayar = `konstanta − total_support` (floor 0),
split 70/30 × pencapaian. Exclusive 1jt; mix n=2→1jt, 3→1.2jt, 4→1.4jt, 5→1.5jt, **n>5 cap 1.5jt**.
Value mix global dialokasikan proporsional `target_value` per principle.

**MT:** target OA diambil dari kolom AO file target per baris (bukan 240). **IA dinilai per outlet**
(`realisasi_ia / realisasi_ao` dibanding `target_ia`) — asumsi yang belum dikonfirmasi user.
MT mix memakai KONSTANTA_MIX milik GT, pool dibagi rata.

**SPV:** rate n=1 → flat 1.5jt; n=2..6 → `200rb + 1.2jt/n`; **n>6 DITAHAN 400rb** (tidak turun lagi).
Principal valid = minimal 1 baris sales bawahan berstatus skema. Support principle SPV yang
**LEBIH DARI** rate mengeluarkan principal itu dari hitungan n (pengecualian serentak, `resolveValidSet`).
Support sebagian → distributor bayar `rate − support`.

**SM:** `<90%→0`, `90–99,99%→1.5jt`, `100–109,99%→2.5jt`, `≥110%→3.5jt`. Whitelist
`SM_BERHAK_INSENTIF = ["HENDRIK"]` (substring, case-insensitive). **Semua status principal
dihitung, termasuk `principle`/ENERGIZER** — beda dari GT/MT/SPV. Baris `_OFFICE` dibuang
(`isOfficeRow`), dipakai juga oleh `spv-dashboard`.

### Acuan Value & normalisasi input

- `lib/insentif-value-source.ts` — default **DPP**; cabang **VINDA, KINO NON FOOD, MIX NON FOOD**
  pakai **NILAI_JUAL**. Jebakan yang dijaga test: `MIX FOOD` ≠ `MIX NON FOOD`, `KINO` ≠ `KINO NON FOOD`.
- `lib/sales-code-merge.ts` — pergantian orang meninggalkan 2 kode dengan prefiks rute sama.
  Penggabungan **tidak pernah otomatis**: keputusan `gabung`/`pisah` per periode di `sales_code_merge`,
  diterapkan saat agregasi MTD (`foldMerged`), jadi bisa diubah tanpa upload ulang.
- `AO`/`EC`/`Item Aktif` di file closing adalah **flag 0/1 per baris transaksi** → **SUM**, bukan MAX
  (diperbaiki di `5320b79`). Upload sudah mengagregasi per `(salesCode, principle, branch, tanggal)`
  di browser, POST `progress` idempoten per `(salesCode, principle, periode)`.

### Status Insentif & Tipe Sales

`status_insentif` ∈ `distributor_principle` (default) | `distributor` | `principle`.
Untuk GT/MT/SPV hanya 2 pertama ikut skema (`isSchemePrincipal`); `principle` (mis. ENERGIZER)
tidak dihitung. SM mengabaikan aturan ini. `tipe_sales` ∈ `mix` | `exclusive`.
Keduanya divalidasi di route lewat `normalizeStatus` / `normalizeTipe` (trust boundary → 400).

### Support

| Tabel | Untuk | Route | Kunci |
|---|---|---|---|
| `incentive_support` | Sales (GT & MT) | `/api/insentif-sales/support` | `salesCode + principle + period` |
| `spv_support` | SPV | `/api/insentif-sales/spv-support` | `spvName + principle + period` |

Support SPV **tidak bisa diturunkan** dari support sales (rasionya beda per principal) → input manual.
SM belum punya konsep support.

### Pembayaran (Finance)

`incentive_payments`, kunci upsert `sales_code + principle + period`. **SPV & SM dititipkan ke tabel
yang sama** lewat prefiks `sales_code`: `SPV:<nama>` / `SM:<nama>`, `principle` = `-`
(`lib/insentif-payee.ts` — `payeeCode` / `parsePayee` / `PAYEE_PRINCIPLE_ALL`). Tidak ada migrasi DB.
`GET /payments` menerima `month` **opsional** — tanpa `month` = seluruh tahun (dipakai strip 12 bulan).
UI Finance memakai key seleksi `salesCode::principle`, memproses dengan `Promise.allSettled`,
mempertahankan pilihan yang gagal, dan membedakan error API dari status `belum`.

### ⚠ `sales_daily_progress` punya DUA penulis — cakupan hapus sudah disamakan, sisanya belum

Cakupan DELETE kedua penulis sekarang **identik**: per `(salesCode, principle, periode, TANGGAL)`
(C1/M13 selesai). Akibatnya keduanya tidak lagi saling menghapus — mereka **berdampingan** dalam satu
periode, dan itu memunculkan masalah yang berbeda:

| Penulis | Isi `spv_name`? | Periode diturunkan dari |
|---|---|---|
| `app/api/insentif-sales/progress/route.ts` (upload closing, agregasi di browser) | ya (kolom GOLONGAN) | **dropdown UI**, bukan dari `date` — risiko salah bulan |
| `lib/laporan-harian/ingest.ts` (dipanggil `app/api/laporan-harian/upload/route.ts`) | **tidak** — NULL | dari `date` (python backend) |

Konsekuensi yang masih terbuka: baris dari Laporan Harian tak pernah muncul di `/spv-mismatch`
(`isNotNull(spvName)`), jadi panel itu melaporkan "0 ketidaksinkronan" untuk jalur yang justru dipakai
bersamaan. Dan tabel ini **tidak punya UNIQUE index**, sehingga retry upload setelah 502 bisa
menggandakan realisasi tanpa error (audit 2026-08-28, H5).

`maxDuration = 300` sudah dipasang di `POST /targets` dan `POST /progress`. Yang belum: keduanya masih
mengeksekusi satu statement per baris di dalam satu transaksi (~2.000 DELETE per upload closing).

**Upload ulang periode lama: HAPUS DULU.** `lib/excel-date.ts` (2026-08-27) memperbaiki tanggal yang
sebelumnya tersimpan mundur satu hari. Untuk file yang sama, `date` yang dihasilkan sekarang berbeda,
jadi upload ulang **menambah** alih-alih menimpa. Juli & Agustus 2026 sudah dihapus manual; Juni 2026
masih memuat 6 baris dari jalur lama.

### Prinsip WAJIB: data insentif diperlakukan seketat data Finance

Ditetapkan 2026-08-28. Ini bukan preferensi, ini standar penerimaan untuk setiap perubahan di modul ini.

1. **Row-level & column-level filter berbasis kepemilikan.** Sales/SPV/SM hanya boleh melihat data
   miliknya/timnya. Filter WAJIB berada di layer service/query (`getScopeForUser`), **bukan** di UI.
   Filter yang hanya menyembunyikan di layar adalah bug keamanan, bukan fitur.
2. **Least privilege per peran.** Siapa menghitung ulang, siapa meng-approve/menandai lunas, siapa
   hanya melihat — dibedakan permission, bukan satu peran generik.
3. **Audit trail untuk setiap perubahan angka**: siapa, kapan, **sebelum/sesudah**. Kolom
   "penulis terakhir" tidak memenuhi ini karena nilainya ditimpa. Modul lain sudah punya polanya
   (`offAuditLog`, `claimAuditLog`, `kontrolAuditLog`, `permissionAuditLog`); insentif belum.
4. **Agregat tidak boleh bisa di-drill-down** jadi angka personal orang lain tanpa otorisasi. Endpoint
   realisasi + support yang tak ter-scope memungkinkan rekonstruksi manual meski dashboard sudah
   memfilter — itu tetap pelanggaran.
5. **Filter harus konsisten di SEMUA entry point**, termasuk rekap, export, dan cetak. Celah paling
   umum: benar di endpoint dashboard, lupa di endpoint rekap. Di modul ini celahnya adalah
   `GET /payments`.

Status kepatuhan per endpoint: lihat tabel di
[AUDIT_INSENTIF_SALES_2026-08-28.md](docs/handover/AUDIT_INSENTIF_SALES_2026-08-28.md) bagian
"Filter data setara Finance".

### Alur end-to-end

```
Excel target (parseTargetExcel)  ─┐
                                  ├─> POST /targets ──> sales_targets
Excel closing (agregasi browser) ─┴─> POST /progress ─> sales_daily_progress
                                                            │
        getTargetsForPeriod + computeMtdProgress/ByPrinciple │ (+ getMergeMap → foldMerged)
                                                            ▼
   GET /dashboard (GT+MT per sales) · GET /spv-dashboard · GET /sm-dashboard
                                                            │
        Finance input support (incentive_support, spv_support)│
                                                            ▼
                        POST /payments (Sales + SPV + SM) ─> incentive_payments
```

### Self-check (semua pure, tanpa DB)

```bash
for t in insentif-sales-calc insentif-mt-calc insentif-spv-calc insentif-sm-calc insentif-konstanta insentif-pph \
         insentif-payee insentif-value-source sales-code-merge; do
  node --experimental-strip-types lib/$t.test.ts
done
```

Typecheck/lint lokal di working dir **tidak bisa dipercaya** (`.next/dev/types/routes.d.ts` bisa
terpotong dan membuat `tsc` berhenti sebelum memeriksa kode asli). Verifikasi wajib di worktree
bersih; acuan: lint **255 warning, 0 error**, `tsc --noEmit` exit 0.

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
| `app/api/sales-history/import/route.ts` | `POST` | Impor CSV streaming (memori terbatas), idempotent per `source_file`; membuang salinan Accurate untuk faktur yang sama. Nama berkas `accurate` ditolak. Guard `sales_history.manage` |
| `lib/sales-history/accurate.ts` | `fakturKeHistory`, `namaPrincipal` | Pemeta murni faktur Accurate (`sales_invoice.raw_data` detail.do) -> baris History; principal = `charField1` master barang; ADNA SENTRAL NIAGA -> GUMINDO BOGAMANIS. Uji: `lib/sales-history/accurate.test.ts` |
| `app/api/cron/sales-history-accurate/route.ts` | `GET` | Cron (CRON_SECRET): salin faktur INV Postgres -> SQLite History, kursor keyset `(synced_at,id)` di tabel `sync_cursor`; `source_file='accurate'`; faktur yang sudah punya baris berkas closing/CSV dilewati. Tidak menulis ke Accurate |
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

## Laporan Harian per SPV/SM/Principal (Daily Report Pipeline) — IMPLEMENTED (Tahap 0–4)

> UI dan API aktif pada route existing. Menggantikan pipeline Excel lama (Power Query `2.3 To SPV dan SM New.xlsx` + `generate_laporan_from_sheets.exe` + `kirim_laporan_gui.exe`).
> Tujuan: **1 kali upload → laporan per SPV/SM/principal (email) + feed dashboard sales**, tanpa buka Excel.

**Masalah lama (terukur):** refresh Power Query ~15–20 mnt + generate ~15 mnt (~35 mnt total). Sebab utama audit:
- Query `SalesBase` (baca `2. To Format Laporan.xlsx` = 132.120 baris × 63 kol; 8 `Table.NestedJoin` + 5 `Table.Group`) **dihitung ulang 22×** karena 22 query pakai `Source = SalesBase` **tanpa `Table.Buffer`**.
- Semua data di-load ke worksheet (bukan Data Model) → file **86 MB**, .xlsx (XML). 0 formula/0 conditional-format di sheet besar → recalc/volatile BUKAN penyebab.

**Alur target:**
```
UI: modul /laporan-harian
  -> POST /api/laporan-harian/upload  (multipart: penjualan wajib, retur dan stock opsional)
     -> requirePermission("laporan_harian.upload")
     -> teruskan ke python_backend FastAPI: POST /laporan-harian/process
        -> laporan_harian_pq.py = replika SETIA Power Query "2. To Format Laporan" + "2.3 To SPV dan SM New"
           (dibuktikan 26 Okt 2026: FIX tersimpan + 3. Stock -> 22 berkas = arsip LaporanAuto 24 Okt, 0 selisih):
           - urutan baris meniru mesin Power Query: Table.NestedJoin (baca kiri/kanan bergantian, baris tertampung
             keluar menurut kemunculan pertama kunci), Table.Sort = introsort .NET (tidak stabil), filter kolom
             sumber didorong ke bawah join (filter Mapping_PIC/ANI/prefix salesman MOTASA tidak)
           - "" vs null dipertahankan (Qty Los/Value Los baris INV kosong karena Number.From("") error)
           - tabel master (GOLONGAN, JENIS PRODUK, Mapping_PIC) di `laporan_harian_lookups.json`; PL_MR dan RECKITT
             LIST di CSV read-only `python_backend/`
        -> output: (a) berkas per keyword, (b) agregat progress harian (salesDailyProgress), (c) ringkasan per SPV
     -> keyword aktif `report_recipient` dicocokkan PERSIS ke 23 laporan (`REPORT_KEYWORDS`):
        SUMARTONO, MARTEN(+VOLUME_KG), SOFYAN, HEINZ(GOLONGAN ZUL & ARUL), SYAMSUL, STANLEY, YARMAN, RAMLY,
        RECKIT(+Devisi), ADNAN/IRMAN (NAMA SM; ADNAN menetapkan ulang GOLONGAN JONAL/ANI), ANI (principal MT/OFFICE),
        MUSTIKA RATU (format 20 kolom; stok diurutkan Nama Gudang = sortState tabel Excel), MOTASA MKS 1/2,
        FONTERRA (tanpa C-TUN020, stok GD01), URC, ABCPI, ENERGIZER, GODREJJ, MSM/DOLPHIN (= ADNAN difilter principal),
        JONAL (MT Jonal: principal kelompok Jonal, salesman _MT/OFFICE; sheet JONAL di 2.3);
        keyword lain dilaporkan `unmatched_report_keywords`
     -> tanggal run/nama file/subject memakai tanggal transaksi penjualan terakhir; retur lebih baru tidak menggesernya
     -> tulis file per keyword ke `LH_RUNTIME_DIR/<runId>/` (sheet `<Keyword>` + `<Keyword> STOCK`, TANGGAL format
        `yyyy-mm-dd h:mm:ss`, TGL_JT tanggal hanya FONTERRA/URC; MSM/DOLPHIN/MOTASA MKS 1/2 meniru arsip manual:
        `Sheet1`/`Sheet2`, tanggal angka seri). MSM ikut dibuat untuk unduhan walaupun tidak tercantum pada mapping email
        (container: `/app/python_backend/output/laporan-harian`, tersimpan di volume `accapi_backend_output`)
     -> tulis juga download-only `<tanggal>_2.To Format Laporan.xlsx` (snapshot FIX LAP PENJ, tidak
        pernah dikirim email; 63 kolom + sheet lookup JENIS PRODUK/GOLONGAN)
     -> `laporan_harian_manager.write_manager_report`: rekap JUMLAH termasuk pajak/net retur tanpa
        menggandakan overlap laporan SPV/SM; 12 kolom mengikuti sheet aktif template Pak Fahdhar
        `Paste Pivot Pencapaian April25`, B/G/H tersembunyi, ROUND/TRUNC dalam ribuan dengan cache;
        target periode tidak disalin dari bulan lama (J/K/L kosong, status missingTargets)
     -> ZIP arsip `<tanggal>_Laporan_Harian_Arsip.zip` memuat seluruh workbook dan HTML manager run
     -> normalisasi progress kosong salesCode -> `UNMAPPED:<branch>` + warning eksplisit (nilai tidak dibuang/tidak ditebak)
     -> feed dashboard: BULK replace ke sales_daily_progress (batch, hindari N+1)
     -> verifikasi coverage exact-key `salesCode|principle` terhadap target periode Insentif Sales;
        UI Laporan Harian dan Insentif Sales menampilkan status masuk/belum cocok tanpa menyalin target lama
  <- { ok, runId, ringkasan per SPV, daftar penerima (PREVIEW, belum kirim) }
UI: pilih `Semua penerima` atau `Pilih penerima tertentu` dari mapping email,
    dan pilihan `Laporan closing` (gated, confirm:true) -> POST /api/laporan-harian/[runId]/send
     -> server memvalidasi pilihan terhadap `report_run_recipient`, claim status `sending`,
        mengirim hanya yang dipilih, dan menandai sisanya `skipped` agar tidak terkirim saat retry
     -> requirePermission("laporan_harian.send")
     -> ambil file per-SPV/SM dari backend -> subject `[Laporan Harian|Laporan Closing] <tanggal transaksi terakhir>` -> kirim email (nodemailer)
     -> mode harian/closing dicatat di `report_run.note` saat claim pertama agar retry tidak dapat mengganti jenis subject
     -> penerima `failed` dapat di-retry tanpa mengirim ulang penerima yang sudah `sent`
UI: review file opsional -> GET /api/laporan-harian/[runId]/preview?file=...
     -> preview: FastAPI /laporan-harian/preview membaca maksimal 26 baris dengan
        python-calamine (openpyxl fallback)
        -> Next.js memilih 10 kolom kunci dan mengirim JSON kecil (tidak parse XLSX via SheetJS)
     -> download=1: Next.js meneruskan body FileResponse sebagai stream dan metadata range/size
        (tidak menahan seluruh XLSX di memori); `2.To Format`/arsip ZIP diunduh lewat jalur yang sama
     -> HTML bernama tepat `<tanggal>_Laporan_Pak_Fahdhar.html` ditampilkan inline dengan sandbox CSP;
        UI otomatis menyediakan tombol screenshot dan unduhan Excel Pak Fahdhar sesudah generate
```

Laporan ABCPI otomatis (FTP + email, 26 Okt 2026; pengganti otomasi Excel/FTP-ABC.exe di laptop):
```
cron VPS 20.00/21.00/22.00 WITA -> GET /api/cron/abcpi-harian (CRON_SECRET; ?tanggal= opsional)
UI /laporan-harian bagian "Laporan ABCPI" (AbcpiKirim.tsx) -> GET/POST /api/laporan-harian/abcpi
     (view: riwayat + ?pratinjau=YYYY-MM-DD xlsx tanpa kirim; send: {tanggal, confirm:true})
  -> lib/abcpi/jalankan.ts jalankanAbcpi: API Accurate BACA-SAJA (sesi sinkron) cabang ABC (branchId 550),
     transDate 1..tanggal: sales-invoice list+detail (INV/ saja), sales-return list+detail (tanpa RSJ),
     item/list-stock.do semua gudang + GD0BS
  -> lib/abcpi/laporan.ts: template ABCPI.xlsx 41 kolom (diskon bertingkat -> Disc1..5_Ext, EC=1 baris pertama
     tiap faktur, retur negatif, freegoods B bernilai 0) + stok (Baik = semua − GD0BS); kode principle dari
     lib/abcpi/peta-barang.json (daftar harga ABC PI), cadangan charField3 barang; barang tanpa kode = tidak dikirim
  -> arsip data/abcpi/<YYYY-MM>/SP_<tgl>_{SALES,STOCK}.csv + ABCPI_SP_<tgl>.xlsx, status per tanggal, log.jsonl
  -> lib/abcpi/ftp.ts unggah CSV pipe ke FTP ABC (dicek SIZE) + email xlsx + CSV ke report_recipient keyword ABCPI; stok pakai asOfDate = tanggal laporan
  -> email ringkasan/galat ke admin. Akhir bulan dari cron = DITAHAN (berkas ke admin), kirim dari UI.
  Konfigurasi: data/abcpi/config.json {ftp:{host,port,user,password,dir}, adminEmail} di volume data (bukan env).
```

Laporan Enigma / Enesis — PT Marketama Indah (portal enigma.enesis.com, 26 Okt 2026; pengganti workbook "Format Report Enigma Enesis.xlsx"):
```
cron VPS 20.30/21.30/22.30 WITA -> GET /api/cron/enigma-harian (CRON_SECRET; ?tanggal= opsional)
UI /laporan-harian bagian "Laporan Enigma" (KirimPrincipal.tsx kode "enigma") -> GET/POST /api/laporan-harian/enigma
  -> lib/enigma/jalankan.ts: Accurate cabang MIX FOOD (150) 1..tanggal; faktur INV + retur tanpa RSJ via detail.do per 200
     (cache sales_invoice TIDAK dipakai: list.do menaikkan last_update tanpa mengganti rincian); jatah laju bersama ABCPI (≤4 req/dtk)
  -> lib/enigma/laporan.ts: baris barang preferedVendorId 14150 (PT Marketama Indah), 33 kolom template_enigma.xlsx;
     PRICE_JUAL = Tabel1 (KRT harga karton, selain itu harga pcs), BRUTO = harga × qty, DISC_RUTIN = potongan × (1+PPN),
     NETTO = BRUTO − DISC; kode MI + harga + TYPE_OUTLET dari lib/enigma/peta.json (barang tanpa kode dilewati + peringatan)
  -> lib/enigma/portal.ts: login {subdist_id,password}, POST / multipart excel_file + __ncforminfo, tunggu status Riwayat Upload,
     baca /upload_detail/<id> -> email admin (success / validation_error + Detail log ringkas / gagal)
  Arsip + status + log.jsonl: data/enigma; konfigurasi data/enigma/config.json {subdistId, password, adminEmail} (volume).
  Cron hanya mengulang gagal teknis; validation_error tidak diunggah ulang otomatis.
```

Admin mapping: `/laporan-harian/mapping` -> `app/api/laporan-harian/mapping/route.ts` -> CRUD
`report_recipient` (keyword/emails/active) langsung dari Next.js, tanpa FastAPI. Permission
`laporan_harian.manage`. Keyword harus salah satu `REPORT_KEYWORDS` di `laporan_harian_pq.py` (nama laporan
LaporanAuto) -- halaman ini hanya mengatur siapa menerima email per keyword.

State machine pure: `lib/laporan-harian/send-state.ts`; self-check:
`node --experimental-strip-types lib/laporan-harian/send-state.test.ts`.
Normalisasi progress pure: `lib/laporan-harian/progress-normalize.ts`; self-check:
`node --experimental-strip-types lib/laporan-harian/progress-normalize.test.ts`.
Definisi laporan per keyword ada di `python_backend/laporan_harian_pq.py` (`build_report`). Sumber audit penerima ada di
`config/mapping_laporan.csv`; sinkronkan secara transaksional dengan
`node scripts/sync-laporan-recipients.mjs` agar tepat 21 keyword aktif dan keyword lama dinonaktifkan
(26 Okt 2026, keputusan owner: HENDRIK->IRMAN, YUDI->MARTEN, DENNY->STANLEY, SAHAR->ANI, tambah JONAL = MT Jonal).

Validasi paritas 26 Oktober 2026 (masukan + arsip LaporanAuto 24 Okt, salinan lokal, tanpa email/produksi):
`python python_backend/laporan_harian_bandingkan.py <folder hasil> <folder arsip> --tanggal 2026-10-24` -> 0 selisih.
Self-check: `python python_backend/test_laporan_harian_pq.py` (fixture `python_backend/fixtures/laporan_harian/`,
acuan dibuat Excel menjalankan query M owner lewat `laporan_harian_excel_pq.py`).
Simulasi menu web dengan tiga ekspor asli: `tests/laporan-harian-parity.spec.ts`, opt-in
`LAPORAN_PARITY_FILES=1`, `LAPORAN_PARITY_SOURCE_DIR`, dan `PLAYWRIGHT_BASE_URL` lokal.
File transaksi/bukti simulasi berada di `outputs/parity/` lokal dan tidak untuk disertakan ke Git.

---

## Dokumen Perencanaan (docs/)

| Path | Isi |
|---|---|
| `docs/prd/00-overview.md` | Peta visi Ops Control Tower dari 11 poster (`poster/`) + rantai dokumen lintas divisi |
| `docs/prd/01..10-*.md` | PRD per divisi: Audit, Incaso, Claim, Sales, Admin Gudang, Delivery, Gudang, Management Dashboard, Control Center, Fakturist — angka poster FIKTIF |
| `docs/audit/findings.md` | Fase B: gap vs PRD + tantangan atas kode yang sudah jalan (baseline, klaim, rollback, ranking) |

---

## Risks / Blind Spots

Blok `accapi-risk` di bawah adalah kontrak input eksplisit untuk automation issue. Wording boleh diperbarui, tetapi `id` tidak boleh diganti untuk risiko yang sama. Penghapusan blok hanya menandai issue sebagai `SOURCE NO LONGER DETECTED — VERIFICATION REQUIRED`; automation tidak menutup issue. Issue terkelola memakai label `accapi-guardian` dan `risk:P0..P3`; label terkelola tanpa fingerprint atau marker body yang rusak membuat sinkronisasi gagal tertutup.

<!-- accapi-risk
id: deploy-database-runtime-mismatch
title: Complete PostgreSQL runtime health and authenticated route verification
priority: P1
category: deployment-data-integrity
affected-area: Dockerfile.frontend, Coolify runtime environment, database startup migrations
business-impact: Finance and operational routes can fail or target the wrong storage when DATABASE_URL is absent or points to SQLite.
technical-impact: Application DB code uses PostgreSQL; live container 2026-09-08 terbukti memakai skema postgresql ke accapi-postgres dan SELECT 1 berhasil, tetapi frontend belum punya healthcheck dan route DB terautentikasi belum di-smoke-test.
acceptance-criteria: Add a frontend healthcheck and capture an authenticated read-only DB route smoke test in addition to the proven PostgreSQL connection before declaring runtime verification complete.
suggested-tests: Recreate the production container, inspect its effective environment without printing credentials, then smoke-test health plus one authenticated read-only DB route.
-->

<!-- accapi-risk
id: deploy-coolify-immutable-image
title: Make Coolify deploy the exact commit-SHA image
priority: P1
category: deployment-release-integrity
affected-area: GHCR image publication and Coolify webhook deployment
business-impact: Rollback and incident attribution remain ambiguous, and a failed half-build can leave frontend/backend latest tags from different revisions.
technical-impact: CI serializes runs and publishes immutable github.sha tags, but it pushes each mutable latest tag before both builds are known-good; Coolify consumes latest and running images have no source-revision label.
acceptance-criteria: Promote a coordinated frontend/backend release only after both builds succeed, make Coolify consume the triggering SHA or pinned digest pair, and expose the same source revision on both running containers.
suggested-tests: Force the second image build to fail and prove no deployable tag pair advances, then deploy two controlled revisions, verify both running digests/revision labels, and roll back to the prior pair.
-->

<!-- accapi-risk
id: guardian-branch-protection-required
title: Validate protected Guardian behavior with a real external fork PR
priority: P1
category: repository-security-validation
affected-area: GitHub external-fork workflow approval, branch rules, CODEOWNERS, and .github/workflows/pr-guardian.yml
business-impact: Without one real external-fork run, token/secret isolation and approval behavior remain inferred from configuration rather than end-to-end evidence.
technical-impact: Ruleset 22329681 is active with no bypass, strict Guardian check, CODEOWNERS review, and all_external_contributors workflow approval; negative and metadata attacks passed in same-repository PRs, but the repository has zero forks and no external account was available for a real fork test.
acceptance-criteria: A controlled external fork PR requires maintainer workflow approval, receives no secrets or write permission, runs the trusted-base Guardian, and remains unmergeable when its required check fails.
suggested-tests: From a non-collaborator fork, submit malicious title/body/filename plus a failing code change, inspect runner permissions and secret availability, then confirm the ruleset blocks merge.
-->

<!-- accapi-risk
id: production-dependency-high-advisories
title: Triage and remediate high-severity production dependency advisories
priority: P1
category: application-security
affected-area: xlsx workbook parsing in upload/reporting flows
business-impact: A hostile workbook may cause denial of service or prototype pollution in finance-sensitive import flows.
technical-impact: Better Auth, Next.js, Nodemailer, Sharp, PostCSS, Browserslist, fast-uri, nanoid, and brace-expansion findings were upgraded; npm audit --omit=dev now reports only xlsx, for which the npm registry has no fixed release.
acceptance-criteria: Replace xlsx or adopt a verified fixed SheetJS distribution, then run hostile-workbook and import/export regression tests until npm audit has no unaccepted HIGH production finding.
suggested-tests: Parse oversized, regex-adversarial, and prototype-pollution workbooks under CPU/memory/time limits, then rerun all upload/reporting regressions.
-->

<!-- accapi-risk
id: rotate-exposed-better-auth-secret
title: Rotate Better Auth secret exposed through Compose fallback and deployed image
priority: P0
category: authentication-secret-exposure
affected-area: docker-compose.yml, frontend image filesystem, GitHub Actions secret, Coolify runtime environment, active sessions
business-impact: A reusable authentication credential was committed and embedded in a readable production image, so session and token integrity cannot be trusted until rotation.
technical-impact: Live inspection on 2026-09-08 found the effective BETTER_AUTH_SECRET literal in /app/docker-compose.yml inside the running image; source fallback and future build-context inclusion are fixed, but the deployed credential and image remain compromised.
acceptance-criteria: Rotate BETTER_AUTH_SECRET in GitHub and Coolify, redeploy an image built after this fix, invalidate old sessions, and prove the old literal is absent from image files and runtime configuration.
suggested-tests: Scan the rebuilt image for the old secret without printing it, verify new and old session behavior, confirm login/logout, and inspect container health after redeploy.
-->

| Area | Catatan |
|---|---|
| **Python backend integrasi Next.js** | Tidak ada shared session antar Next.js dan FastAPI. FastAPI punya auth sendiri (`auth.py`); sinkronisasi user hanya via filesystem/env, bukan DB shared. |
| **Elasticsearch optional** | Jika env tidak di-set, search fallback ke in-memory fuzzy. Perilaku ini tidak eksplisit diuji di test script. |
| **PPh HOLD** | Kolom PPh disiapkan di schema tapi perhitungan final ditahan (`// PPh HOLD` tersebar di beberapa file). Belum aktif secara bisnis. |
| **Phase R7 (Multi No Claim)** | Fitur `claim_submission` tabel (R7a+) masih dalam rollout bertahap. Phase R7b-R7k tercakup di `scripts/test-r7*.mjs` tapi belum semua route production-ready. |
| **Webhook Accurate** | (Dikoreksi 2026-08-18) HIDUP, bukan lagi logger buntu. IP whitelist fail-closed; payload di-parse `lib/accurate-webhook.ts` (bentuk asli terbukti live 2026-08-11: array envelope `type: "SALES_INVOICE"` + `data[].salesInvoiceId`), tiap faktur di-`detail.do` lalu upsert lewat `upsertSalesInvoiceById`. Gagal sebagian -> 502 supaya Accurate retry (upsert idempoten). `webhook_events.log` dirotasi 1 slot pada 20 MB. Diagnostik: `GET /api/admin/accurate-webhook-history` (from/to wajib, jendela maks 24 jam). Perpanjangan masa aktif: `GET /api/cron/accurate-webhook-renew` -> `webhook-renew.do` tanpa parameter, balas `{s:true, d:"dd/MM/yyyy"}` = tanggal kedaluwarsa baru. **Masa aktif webhook hanya 7 hari** (terverifikasi live 2026-08-19), jadi cron VPS-nya HARIAN 04:00 — mingguan tidak punya margin kalau satu run gagal. Hanya modul Faktur Penjualan yang di-subscribe. Nomor `RJN/*` (retur) ikut masuk lewat kanal `SALES_INVOICE` yang sama dan tersimpan di tabel `sales_invoice` — ini DISENGAJA (dikonfirmasi 2026-08-19): retur mengurangi piutang, jadi total piutang baru benar kalau keduanya satu tabel. Jangan 'perbaiki' dengan memfilternya keluar; halaman /faktur hanya menyembunyikannya di tampilan lewat filter INV. **Jenis dokumen di tabel `sales_invoice`** (hitungan live 2026-08-19): `INV` faktur penjualan 168.571 baris (+84,89 M), `RJN` retur 24.636 (-2,93 M), `SRT` **retur penjualan juga**, hanya beda penomoran (dikonfirmasi user 2026-08-19): 14.577 baris (-1,60 M), `DFT.*` draft 105 baris (nilai 0/null). Sisa tagihan ada di kolom `outstanding` (dari `primeOwing`); retur bernilai NEGATIF sehingga `sum(outstanding)` langsung = piutang bersih. Cross-check 2026-08-19: cache 80,37 M vs laporan Accurate 79,2 M (selisih 1,5%, sedang ditelusuri). **PENTING — nomor faktur TIDAK unik:** Accurate memakai ulang nomor faktur setelah faktur dihapus. Dibuktikan 2026-08-19: `INV/2608/MS01107` ada 2 baris — id 307620 (ZAKI TK, sudah dihapus di Accurate) dan id 311801 (NAYA TK, sah). Identitas yang bisa dipercaya hanya kolom `id`; jangan pakai `number` untuk join/matching. **Baris yatim:** `syncModule` hanya upsert, TIDAK pernah delete — faktur yang dihapus di Accurate menetap di cache (166 baris per 2026-08-19, dibersihkan manual, cadangan di tabel `sales_invoice_yatim_20260819`). Deteksinya: bandingkan `count(*)` cache dengan `sp.rowCount` dari list.do. |
| **`lib/sync.ts`** | (Fix F2/F3 2026-07-12) Hidup: registry 4 modul (item/customer/sales_invoice/sales_return), upsert `onConflictDoUpdate`, watermark `lastSyncTimestamp`. Dipicu `GET /api/cron/sync-accurate` (Bearer CRON_SECRET) via cron VPS 4×/hari. **Prasyarat: minimal 1 login OAuth Accurate oleh user ber-role `admin`** atau set `ACCURATE_SYNC_USER_ID` — fallback `resolveSyncCredentials()` hanya memilih sesi terbaru milik admin (insiden 2026-09-19: sesi fakturist merebut identitas cron, retur berhenti tersinkron). |
| **`config/`** | Folder berisi data statik (principles, dll) — tidak ter-trace penuh karena bukan TypeScript eksportabel; kemungkinan JSON/YAML. |
| **`runtime/` path** | `GET /api/cron/cleanup-runtime` membersihkan artefak regenerable dengan retensi terdaftar; arsip PDF OPC/claim sengaja dikecualikan. Production tetap memerlukan scheduler eksternal dan `CRON_SECRET`. |
| **`app/(dashboard)/finance/page.tsx`** | Memanggil Python FastAPI backend langsung via `NEXT_PUBLIC_FASTAPI_BASE_URL`. Jika backend mati, halaman finance tidak berfungsi. |
| **D4 env/deploy verifikasi parsial** | Dockerfile baru fail-closed pada URL non-PostgreSQL. Live container 2026-09-08 memakai PostgreSQL dan query konektivitas berhasil, tetapi belum ada healthcheck frontend atau authenticated DB-route smoke test. |
| **Rekapan Nota: sumber baris nota** | UPLOAD MANUAL export Accurate, bukan sync live. Kalau admin lupa upload, pool kosong dan wave tidak bisa disusun — gagalnya kelihatan, bukan diam-diam. Jalur upgrade: `sales-invoice/detail.do` per faktur (mahal, ~850 nota/hari). |
| **Rekapan Nota: master konversi** | Diimpor sekali dari sheet `Konversi` (8.173 SKU); export tidak membawa `QTYKONV`. Yang menjaga master tetap benar adalah `konv_tersirat` tiap upload (baseline: cocok 65/65 SKU). Item ganti kemasan -> exception `KONVERSI_BEDA_DENGAN_EXPORT`, bukan orang. |
| **Rekapan Nota: mapping area** | `Master Area Heinz` belum lengkap. Per 21 Agu 2026, 19 dari 131 nota Heinz tidak muncul di lembar HNZ mana pun karena outletnya belum dipetakan. Mesin usulan menutup ~79% (133/168) dengan LOO 87,1%; sisanya tetap antrean kerja manual, dan tidak ada yang dikarang. **Cakupan itu runtuh ke ~21% kalau `customer.alamat` kosong** — jalankan `scripts/import-rekapan-master.mjs` sebelum mengandalkan layar mapping. |
| **Rekapan Nota: nota kanvas** | Penandaan MANUAL lewat `/rekapan-nota/kanvas` (kelompok per salesman, multi-select, tawaran "tandai semua nota salesman ini"). Constraint DB membuat nota kanvas mustahil masuk wave reguler dan sebaliknya. Sisa risikonya orang, bukan sistem: kalau lupa ditandai, notanya ikut rekapan reguler padahal barangnya sudah keluar lewat pemindahan gudang. Peredamnya, layar penyusunan wave menampilkan berapa nota yang disembunyikan karena tanda itu — hilangnya tidak diam-diam. Deteksi otomatis dari GDG belum bisa dibuktikan (butuh export multi-gudang). |
| **Rekapan Nota: pembanding Excel tidak menyentuh lembar cetak** | `scripts/bandingkan-rekapan-excel.ts` mengadu AccAPI dengan DATA di `Paste Data Sore`, BUKAN dengan lembar `Print Rekapan Sore-*`. E2/E3/E4 (referensi sel bergeser, blok formula kependekan, filter pivot menua) hidup di lembar cetak itu, jadi kertas yang sampai ke gudang memang berbeda dari data yang menghasilkannya. "LULUS" berarti "AccAPI = Excel kalau Excel benar", bukan "AccAPI = kertas kemarin". |
| **Rekapan Nota: belum dibangun** | `wave_rekonsiliasi` + `ck_neraca` (PRD §3.7) dan `wave_print_log` + preset cetak (§3.8) sengaja ditunda. Neraca two-step tetap dijamin struktural (satu CTE), tapi rekonsiliasi terhadap file upload belum ada. |
| **Rekapan Nota: `item.no` tanpa index** | Cek `EXPLAIN` pada join `wave_line_pool -> item` sebelum menambah `ix_item_no`; jangan menambah index tanpa bukti. |
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
