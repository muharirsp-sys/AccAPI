# HANDOVER — handover13.md (Modul Rekapan Nota / wave-based picking)

**Status: kode selesai & terverifikasi lokal. BELUM di-deploy, BELUM migrasi produksi.**
Branch: `feat/rekapan-nota` (sudah di-push ke origin).
Sumber kebenaran spesifikasi: `PRD_Rekapan_Nota.md` v1.2 (17 keputusan bisnis tertutup).
Peta sistem sudah diperbarui: `SYSTEM_MAP.md` (§8 Core Logic Flow, Module Map, Skema Data, Risks).

---

## 0. BACA INI DULU — dua jebakan yang bisa merusak

### 0.1 ~~Branch ini TIDAK murni Rekapan Nota~~ — SUDAH BERES, jangan dipisah

Kekhawatiran aslinya benar (13 commit Insentif Sales nyasar ke branch ini), tapi keputusannya
sudah tidak relevan: **11 dari 13 commit Insentif itu sudah mendarat di `main` lewat jalur
lain** (cherry-pick, SHA berbeda, pesan sama). Buktikan sendiri — `-` artinya patch-nya sudah
ada di upstream:

```bash
git cherry -v origin/main feat/rekapan-nota
```

`origin/main` sudah di-merge masuk ke branch ini (commit `e482610`), jadi git sudah membuang
duplikatnya sendiri. Dua konflik yang muncul sudah diselesaikan:

- `lib/rbac.ts` — 6 konflik, semuanya penambahan murni dari sisi Rekapan Nota (`main` tidak
  menghapus apa pun). Ambil kedua sisi.
- `scripts/migrate-pg.mjs` — versi `main` yang menang, dan itu benar: `main` menambahkan
  `DATABASE_MIGRATION_URL` + guard `information_schema`, sementara branch ini tidak menambah
  apa pun soal rekapan di file itu.

**Jangan coba memisah commit-nya sekarang.** Interleaved, menyentuh sidebar & RBAC yang sama,
dan menukar kode terverifikasi dengan riwayat yang rapi adalah pertukaran yang buruk.

Status branch: **0 di belakang `main`**, 27 di depan, sudah di-push. Siap merge.

### 0.2 Urutan deploy TERBALIK dari dugaan: migrasi DULU, baru merge

`.github/workflows/deploy.yml` men-deploy pada tiap push ke `main`. Kalau kode mendarat
sebelum migrasi jalan, siapa pun yang membuka `/rekapan-nota` kena 500.

Sudah dicek: modul lama **aman** kalau urutannya terbalik — tidak ada `select().from(customer)`
di mana pun, dan `lib/sync.ts` hanya `insert().onConflictDoUpdate()` dengan daftar kolom
eksplisit, jadi kolom baru tidak ikut terbaca. Tapi tetap: migrasi dulu.

---

## 1. YANG HARUS DIJALANKAN DI PRODUKSI (belum dikerjakan)

### 1.1 Migrasi DDL — pakai role ber-DDL, BUKAN `accapi_app`

```bash
psql "$DATABASE_URL_DDL" -v ON_ERROR_STOP=1 -f db/migrations/0002_rekapan_nota.sql
```

`ON_ERROR_STOP=1` wajib: tanpa itu psql lanjut setelah error dan Anda dapat migrasi separuh
jadi. Jalankan **dua kali** — yang kedua harus tetap sukses (idempoten by design).

Lalu buktikan jaminannya benar-benar ada, jangan puas karena "tidak error":

```bash
psql "$DATABASE_URL_DDL" -c "select conname from pg_constraint where conname in ('ck_takeout','ck_kanvas_sesuai_wave','fk_wave_assignment_tipe'); select indexname from pg_indexes where indexname in ('uq_nota_aktif','ix_wave_assignment_wave');"
```

Harus keluar **3 constraint + 2 index**. Kalau `uq_nota_aktif` tidak muncul, **berhenti** —
itu satu-satunya yang menjamin satu nota tidak turun dua kali.

Catatan: `scripts/apply-rekapan-migration.mjs` sengaja **menolak host non-localhost**. Untuk
produksi pakai `psql` langsung.

### 1.2 Impor master

```bash
DATABASE_URL="<produksi>" node scripts/import-rekapan-master.mjs "<path workbook.xlsx>"
```

Membaca sheet `Konversi` (8.169 SKU), `Master Area Heinz` (3.378 outlet + alamat), dan
`Pemisah`. Script **melaporkan** yang tidak cocok dan tidak menelannya.

**BACA LAPORANNYA SEBELUM MERGE.** Yang harus diperiksa:

- Angka cocok `Konversi -> item`. Kalau jauh di bawah jumlah item aktif, kemungkinan format
  `item.no` di produksi beda dengan `Konversi.BRG`. Yang sudah diketahui: separuh kode di
  workbook tersimpan sebagai **angka** (4.174) dan separuh **teks** (3.999); nol berawalan nol;
  panjang maksimum 15 digit. Uji lokal cocok 1.338/1.354, jadi konversi angka→teks bukan masalah.
- Baris `Item tanpa isi_per_karton setelah impor: N` — **N > 0 itu benar**, bukan bug. Itu
  yang memicu exception `KONVERSI_TIDAK_ADA` dan mencetak `KONVERSI BELUM ADA` di kertas.
- Script **berhenti** kalau `customer.customerNo` tidak unik. Sudah dikonfirmasi user: Accurate
  menolak kode toko ganda, jadi ini seharusnya tidak pernah kena.

**`customer.alamat` WAJIB terisi.** Tanpa itu cakupan mesin usulan area runtuh dari ~79% ke ~21%
— Kel./Kec. di alamat adalah satu-satunya sinyalnya, dan cache Accurate tidak membawa alamat.

### 1.3 Merge ke `main` → deploy otomatis

### 1.4 Beri permission — "Admin otomatis dapat semua" ITU SALAH

Kalimat itu ada di versi handover sebelumnya dan **menyesatkan**. Yang sebenarnya berlaku,
dari `lib/rbac/resolve.ts:36-43`: begitu seorang user tergabung di **minimal satu** Access
Group, group itu jadi **satu-satunya** sumber permission-nya — preset role legacy (termasuk
`admin`) diabaikan total. Tidak ada bypass untuk `role = 'admin'` di `requirePermission()`.

Akibatnya: sesudah deploy, **tidak seorang pun** bisa membuka `/rekapan-nota` sampai key-nya
ditambahkan ke group, admin sekalipun. Preset `manager` di `lib/rbac.ts:240` hanya menolong
user yang belum pernah dimasukkan ke group mana pun — di produksi hampir tidak ada.

Jadi langkahnya: buka `/admin/groups`, centang `rekapan_nota.{view,manage,print,approve_takeout}`
pada group yang berhak. `approve_takeout` sengaja dipisah — tidak semua orang boleh menarik
nota keluar dari wave.

Cek siapa yang akan kena 403 sebelum Anda pergi:

```sql
SELECT g.name,
       count(*) FILTER (WHERE gp.permission_key LIKE 'rekapan_nota.%') AS punya_rekapan,
       count(ug.user_id) AS jumlah_user
FROM access_group g
LEFT JOIN group_permission gp ON gp.group_id = g.id
LEFT JOIN user_group      ug ON ug.group_id = g.id
GROUP BY g.name ORDER BY 1;
```

---

## 2. APA YANG SUDAH DIVERIFIKASI (dan dengan apa)

Semua di Postgres 16 lokal (container Docker), data di-seed dari file export nyata.

| Uji | Hasil |
|---|---|
| Parser vs `Paste Data Sore` 21 Agu 2026 | **131/131 nota, 776 baris, nol selisih** |
| Upload multi-principal (6.164 baris, 22 principal) | 989 nota / 6.119 baris, 15 detik |
| Pool tersedia 21 Agu | 130 nota (1 dikecualikan NON), 19 tanpa area — **persis angka PRD §1.2** |
| Eksklusivitas: tambah nota yang sama dua kali | HTTP 409 + identitas wave pemiliknya |
| Pembanding lawan workbook per SKU per grup | **6 lembar HNZ, 139/139 SKU, nol selisih** |
| Mesin usulan area, leave-one-out 3.379 outlet | **87,1%** (baseline PRD 86,3%) |
| 168 outlet belum terpetakan | 133 dapat usulan; 16 TINGGI identik dengan analisis offline |
| Exception `KONVERSI_TIDAK_ADA` | menyala sendiri untuk 9 SKU pada data multi-principal |
| Exception `KONVERSI_BEDA_DENGAN_EXPORT` | dibuktikan menyala dengan menggeser satu master |
| Gerbang confirm | ditolak selama ada `KONVERSI_*` open |
| Take-out | alasan < 5 karakter ditolak; nota kembali ke pool; tercatat di `wave_event` |
| Wave kanvas | nota non-kanvas ditolak masuk; tanda tidak bisa dicabut setelah wave rilis |
| Nomor halaman lembar cetak | diadu ke halaman fisik PDF: 15/15, 19/19, 7/7, 2/2 **cocok** |
| Subtotal per halaman | jumlah 13 halaman = 691 KRT / 85.108 pcs = total global **cocok** |
| `npm run test:rekapan` | 17 self-check lulus (4 di antaranya paginasi TTF) |
| `tsc` · `eslint` · `npm run build` | bersih |

Perintah harian selama shadow run:

```bash
npx tsx scripts/bandingkan-rekapan-excel.ts --wave <id>
```

Exit 1 kalau ada selisih yang **tidak bisa dibuktikan sebabnya ke DB**. "Nota tidak ada di
wave ini" ditolak sebagai alasan gratis — tiap nota penyumbang harus terbukti ada di wave
lain, ditandai kanvas, atau areanya dikecualikan.

**Batas yang harus disebut:** pembanding ini mengadu AccAPI dengan **data** di `Paste Data
Sore`, BUKAN dengan lembar `Print Rekapan Sore-*`. Cacat E2/E3/E4 hidup di lembar cetak itu.
"LULUS" berarti *"AccAPI = Excel kalau Excel benar"*, bukan *"AccAPI = kertas kemarin"*.

---

## 3. YANG BELUM / SENGAJA TIDAK DIKERJAKAN

**Diputuskan user: diabaikan** (tidak ada datanya) — kolom LOKASI rak + sortir per rak,
kolom AKTUAL, ED/batch, put list untuk sortasi ke nota, split wave per picker.

**Ditunda dari cakupan awal** — `wave_rekonsiliasi` + `ck_neraca` (PRD §3.7), `wave_print_log`
+ preset cetak (§3.8). Neraca two-step tetap dijamin struktural (satu CTE, dua proyeksi).

**Belum pernah menyala** — exception `SATUAN_TIDAK_KONSISTEN` dan `PRINCIPAL_BELUM_MASUK`.
Yang kedua memang belum bisa: butuh riwayat upload beberapa hari.

**Sisa pekerjaan kecil yang sudah diidentifikasi:**

- ~~**TTF 49 halaman masih tanpa nomor halaman.**~~ **SELESAI.** Paginasi TTF kini dihitung
  di server (`lib/rekapan-nota/ttf-paginasi.ts`, diuji 4 self-check): tiap lembar punya
  "Halaman X dari Y", subtotal lembar faktur sendiri, rentang nomor nota, dan paraf hanya di
  lembar terakhir. Konsekuensi yang harus diketahui: nama outlet **dipaksa satu baris**
  (`white-space: nowrap`, dipotong elipsis). Itu bukan pilihan estetika — dengan nama boleh
  membungkus, tinggi baris melompat 10,98mm → 14,4mm dan tinggi baris berhenti seragam,
  sehingga nomor halaman jadi bohong lagi. Kalau nama panjang ternyata mengganggu sopir,
  pilihannya: biarkan dua baris **dan** ukur ulang konstanta (jadi ~15 baris/lembar, +15
  lembar per hari), bukan sekadar mencabut `nowrap`. Jumlah lembar sekarang ~51 (dari 49).
- **Shadow run 10 hari kerja berturut-turut** (kriteria lulus Fase 3) baru jalan 1 hari.
- **Uji cetak fisik belum pernah dilakukan.** Yang diverifikasi baru HTML/CSS/PDF; margin
  dan keterbacaan di printer gudang belum dicoba dengan kertas sungguhan.
- **Antrean mapping area**: 226 outlet tanpa area pada data 27 Agu. Pekerjaan berjalan.

**Master data — diperbaiki di Accurate, bukan di generator:** `BT` (harusnya `BTL`) di
C1231001010010, kode `F40711020085101` 15 digit sementara sesama Zen BCL 14 digit, 5 item
MSM Medicare tanpa konversi, satuan tidak konsisten dalam satu famili (Anlene Gold `PCS`
vs Anlene Actifit `SCH`). `KONVERSI BELUM ADA` di kertas **memang sedang bekerja** dengan
memunculkannya — jangan "perbaiki" dengan menyembunyikannya.

**Ide user yang belum dieksekusi: tarik item & customer lewat webhook Accurate.**
Mekanismenya sama dengan webhook Faktur Penjualan yang sudah jalan, tapi:
1. Subscription dibuat **manual di portal** `account.accurate.id` — tidak ada kode yang
   mendaftarkan; repo hanya memanggil `webhook-renew.do`.
2. **JANGAN tulis parser sebelum bentuk payload terbukti live.** Tebakan awal untuk faktur
   (`{eventType, module, id}`) SALAH; bentuk sebenarnya (`{type:"SALES_INVOICE", data:[...]}`)
   baru ketahuan dari `webhook_events.log` produksi. Daftarkan modulnya, biarkan mencatat
   sehari, baru baca lognya.
3. Webhook **tidak** menyelesaikan masalah kecocokan kode `Konversi` ↔ `item.no` — ia hanya
   menghapus keterlambatan (cron sekarang 4×/hari). Untuk `customer` itu berarti (outlet baru
   langsung masuk antrean mapping); untuk `item` manfaatnya tipis.
4. Masa aktif webhook Accurate cuma **7 hari**. Tambahkan sebagai pelengkap, **jangan matikan
   cron**.

---

## 4. JEBAKAN YANG SUDAH DIBAYAR MAHAL — jangan diulang

1. **`excelDateToIso` wajib, dan `cellDates: true` wajib menyertainya.** Tanpa `cellDates`,
   TANGGAL kembali sebagai serial mentah (46255) dan fungsi itu menolak semuanya — pembanding
   pernah melaporkan "GAGAL 139 SKU" yang isinya omong kosong. Serial 46255 = **21 Agu 2026**;
   SheetJS membacanya sebagai 20 Agu 23:59:35, dan koreksi itulah alasan `lib/excel-date.ts` ada.
2. **`jsonb_to_recordset` mencocokkan kunci per NAMA.** Parser mengeluarkan camelCase; payload
   wajib snake_case persis seperti definisi kolom, atau seluruh pool masuk NULL.
3. **`INSERT ... SELECT` tidak cast implisit ke enum.** Butuh `::pick_dimensi` eksplisit.
4. **`ck_wave_released` versi PRD memblokir pembatalan wave draft.** Dilonggarkan jadi
   `released_at IS NOT NULL OR status IN ('draft','cancelled')`.
5. **`docker exec` tanpa `-i` tidak meneruskan stdin.** Perintah `psql` lewat heredoc diam-diam
   tidak berjalan, dan tabel hasil `drizzle-kit push` (tanpa CHECK/INCLUDE) sempat lolos.
6. **Root layout memasang tiga lapis gradient `position: fixed`.** Elemen fixed diulang di
   tiap halaman cetak dan gradient tidak bisa digambar sebagai vektor → tiap halaman
   dirasterisasi jadi bitmap A4 penuh. PDF 596 KB → 236 KB setelah dinetralkan di `@media print`.
7. **`<tfoot>` default-nya `table-footer-group`** — diulang di tiap halaman. Baris "total" jadi
   grand total palsu yang menyamar sebagai subtotal. Itu sebabnya paginasi dihitung di server.
8. **`table-layout: fixed` membaca lebar kolom dari BARIS PERTAMA.** Kalau baris pertama
   ber-`colSpan` penuh (kop), lebar per-kolom diabaikan → wajib `<colgroup>`.
9. **Jangan percaya regex analisis sendiri.** Saya sempat melaporkan "1.660 persegi per halaman"
   sebagai penyebab PDF berat; angka itu salah karena pola `re` ikut mencocok teks di dalam
   string glyph. Jumlah sebenarnya 211, dan penyebabnya poin 6.
10. **Anggaran tinggi halaman harus DIUKUR, bukan ditebak.** Tebakan 7mm/baris (kenyataan
    8,8mm) membuat 6 dari 10 halaman meluber, dan nomor "Halaman X dari Y" jadi bohong.

---

## 5. CARA MENJALANKAN LOKAL

Postgres lokal via Docker (Docker Desktop di mesin ini **tidak stabil**, mati beberapa kali
di tengah pekerjaan — biarkan terbuka):

```bash
docker run -d --name accapi-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=accapi -p 5432:5432 postgres:16
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/accapi" npx drizzle-kit push --force
# lalu DROP objek rekapan hasil push, dan jalankan 0002 supaya constraint aslinya terbentuk:
docker exec -i accapi-pg psql -U postgres -d accapi -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS wave_event, wave_exception, wave_pick_group, pick_group_member, pick_group, nota_kanvas, kanvas_nihil, wave_assignment, wave, wave_line_pool, rekap_upload CASCADE; DROP TYPE IF EXISTS wave_status, wave_tipe, wave_prioritas, pick_dimensi, wave_exception_jenis, wave_exception_status CASCADE;"
node scripts/apply-rekapan-migration.mjs
```

Akses admin lokal tanpa password: `LOCAL_AUTH_BYPASS=true` di `.env.local` (hanya bekerja saat
`NODE_ENV=development` **dan** host localhost). **Hapus setelah selesai.** Butuh baris `user`
ber-id `local-dev-admin` supaya FK tidak gagal.

`item`/`customer` di DB uji di-seed dari file export itu sendiri, jadi angka "tidak cocok"
di laporan impor master pada lingkungan uji **bukan temuan** — di produksi keduanya berisi
katalog Accurate penuh.

---

## 6. FILE PENTING

| Path | Isi |
|---|---|
| `db/migrations/0002_rekapan_nota.sql` | Seluruh DDL: 11 tabel, 6 enum, kolom aditif `item`/`customer`, seed 17 `pick_group` + 3 `app_setting` |
| `lib/rekapan-nota/parse.ts` | Parser export Accurate, pure. Petakan per **nama header**, bukan huruf kolom |
| `lib/rekapan-nota/query.ts` | Satu CTE, dua proyeksi (withdrawal + allocation). Balance dijamin struktural |
| `lib/rekapan-nota/exception.ts` | Deteksi set-based sekali per release, idempoten |
| `lib/rekapan-nota/area-suggest.ts` | Usulan area; memakai `damerau()` dari `lib/sales-history/fuzzy.ts` |
| `app/(cetak)/` | Grup route cetak: tanpa sidebar, guard sendiri, paginasi dihitung di server |
| `scripts/bandingkan-rekapan-excel.ts` | Kriteria lulus Fase 3, per SKU per grup |
| `scripts/import-rekapan-master.mjs` | Impor sekali `Konversi`/`Master Area Heinz`/`Pemisah` |

---

## 7. PERTANYAAN TERBUKA UNTUK PEMILIK PROSES

1. Kolom **PCS / ISI** di lembar picking sering hanya mengulang kolom AMBIL (baris tanpa
   pecahan karton). Dibuang, atau ditampilkan hanya saat ada pecahan?
2. Satuan di slot angka besar berubah-ubah: "180 **PCS**" tampil sebesar "39 **KRT**", padahal
   180 keping kurang dari satu karton. Perlu dikecilkan satu tingkat?
3. **TTF 49 halaman** untuk 958 nota — masuk akal dipakai harian, atau perlu dipecah per
   salesman / per rute?
