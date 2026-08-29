# HANDOVER — handover12.md (Audit Insentif Sales + 8 fase perbaikan)

> Penerus [handover11.md](handover11.md). Periode kerja 2026-08-26 s/d 2026-08-29.
> Branch `main`, HEAD `7df863d` (sudah di origin). Semua angka, nama kolom, dan hasil
> verifikasi di dokumen ini diverifikasi ke kode/DB — bukan ingatan.
>
> Dokumen pendamping: [AUDIT_INSENTIF_SALES_2026-08-28.md](AUDIT_INSENTIF_SALES_2026-08-28.md)
> (43 temuan, metode 4 sub-agent paralel). Baca itu dulu kalau butuh detail temuan; dokumen
> ini hanya menjelaskan apa yang DIKERJAKAN dan apa yang MASIH HARUS dilakukan.
>
> **STATUS 2026-08-29 SORE: seluruh langkah produksi §1 SUDAH DIJALANKAN dan diverifikasi.**
> Rinciannya di §1.5. Yang tersisa untuk penerus ada di §3 (sengaja tidak dikerjakan) dan
> §5 (catatan), bukan di §1 lagi.

---

## 1. WAJIB DIJALANKAN DI PRODUKSI — ✅ SELESAI 2026-08-29

Urut. Nomor 1 dan 2 harus selesai sebelum deploy dianggap sehat.
**Semuanya sudah dijalankan; §1.1-§1.4 disimpan sebagai rujukan cara, hasilnya di §1.5.**

### 1.1 DDL pengerasan DB

```bash
docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
  -f - < docs/handover/DDL_INSENTIF_HARDENING_2026-08-29.sql
```

Bagian pertama file itu **mengecek duplikat lebih dulu**. Kalau ada baris keluar, jangan
dipaksa: realisasi periode itu sudah terhitung dobel dan harus dibereskan dulu.

### 1.2 Naikkan pool koneksi (tanpa deploy)

Set di env Coolify: `PG_POOL_MAX=50`.

Satu pemuatan tab Finance memakai ±19 koneksi (tiga dashboard paralel, tiap `db.select()`
dalam `Promise.all` mengambil koneksi sendiri), sementara pool `max: 20` dibagi dengan
better-auth. Ini penyebab "Data insentif belum berhasil dimuat" yang hilang-muncul.

### 1.3 PERIKSA SETELAH DEPLOY: siapa yang kehilangan akses

Perubahan paling berisiko di rilis ini. `getScopeForUser` sekarang **fail-closed**: user yang
**tidak punya** `insentif_sales.manage` / `manage_payment` / `manage_hierarchy` **dan** belum
diisi identitas hierarkinya akan melihat **0 baris** (sebelumnya: seluruh perusahaan).

Cek group mana yang terdampak:

```bash
docker exec -i accapi-postgres psql -U accapi -d accapi -c "
SELECT g.name AS grup,
       bool_or(gp.permission_key IN ('insentif_sales.manage','insentif_sales.manage_payment','insentif_sales.manage_hierarchy')) AS lihat_semua,
       count(*) FILTER (WHERE gp.permission_key LIKE 'insentif_sales.%') AS izin_insentif
FROM \"group\" g JOIN group_permission gp ON gp.group_id = g.id
GROUP BY g.name HAVING count(*) FILTER (WHERE gp.permission_key LIKE 'insentif_sales.%') > 0;"
```

Group ber-`lihat_semua = false` yang seharusnya melihat semua (mis. Finance yang hanya diberi
`view` + `input_support`) perlu satu dari dua ini:

```sql
-- Opsi A: beri izin kelola yang memang sesuai perannya (dianjurkan)
INSERT INTO group_permission (id, group_id, permission_key)
SELECT gen_random_uuid(), id, 'insentif_sales.manage_payment' FROM "group" WHERE name = 'Finance';

-- Opsi B: izin lihat-semua eksplisit. Kodenya SUDAH menerima key ini, tapi key-nya belum
-- terdaftar di lib/rbac/registry.ts (lihat §4) sehingga belum muncul di UI RBAC.
-- Tabelnya `access_group`, dan group_permission TIDAK punya kolom id (PK gabungan).
INSERT INTO group_permission (group_id, permission_key)
SELECT id, 'insentif_sales.view_all' FROM access_group WHERE name = '<nama grup>'
ON CONFLICT DO NOTHING;
```

Untuk SPV/SM/salesman perorangan, isi identitas hierarki lewat **Kelola Hierarki → Identitas
User**. Peran `Sales` sekarang tersedia; `hierarchyName`-nya adalah **KODE SALES** (mis.
`M-FS`), bukan nama orang. Penulisan SPV/SM harus **sama persis** dengan kolom di file target.

### 1.4 Unggah ulang closing

**Agustus 2026 TIDAK ADA closing-nya** (dikonfirmasi user 2026-08-29) — 960 baris yang dulu
dihapus rupanya sisa percobaan, bukan data nyata. Tidak ada yang perlu diunggah ulang di sana.

**Juli 2026 sudah diunggah ulang** dengan build pasca-perbaikan tanggal. Aturan tetap berlaku
untuk periode mana pun ke depan: **hapus periode dulu, baru unggah ulang**, kalau periodenya
pernah diunggah sebelum 2026-08-27. Sejak `uq_sdp_key` terpasang, upload ganda gagal keras
alih-alih menggandakan realisasi diam-diam — tapi kunci hapus tetap per tanggal, jadi data
bertanggal geser dari build lama tidak akan tertimpa dengan sendirinya.

### 1.5 Hasil eksekusi 2026-08-29 (diverifikasi ke DB, bukan ingatan)

| Langkah | Hasil |
|---|---|
| Cek duplikat sebelum UNIQUE | **0 baris** — bersih, aman dipasang |
| `uq_sdp_key` | terpasang |
| `idx_sdp_period_agg` (INCLUDE) | terpasang |
| `idx_inc_payments_year_month` | terpasang |
| `idx_sdp_code`, `idx_sdp_period` | dibuang (redundan) |
| `PG_POOL_MAX=50` | aktif di container (`printenv` = 50) |
| Closing Juli diunggah ulang | `dari = 2026-07-02`, `sampai = 2026-07-31`, 2.068 baris, 88 kode sales |
| Uji silang M-MC2 / FOKUS RITEL | AO **195**, EC **209**, DPP **102.856.223** — persis pivot Excel user |

**Dampak fail-closed pada user nyata: NOL.** Pemetaan grup saat pemeriksaan:

| Grup | Lihat semua? | User | Catatan |
|---|---|---|---|
| Admin, Admin Sales | ya (punya `manage`) | 4 | tidak terpengaruh |
| Finance | ya (`manage_payment`) | 0 | grupnya belum dipakai, lihat §5 |
| **Manager** | **tidak → DIPERBAIKI** | 2 (fiqhi, syafri) | diberi `insentif_sales.view_all` |
| SPV, SM, Salesman | tidak (memang seharusnya) | 8 | semuanya akun uji `@super.test` |

Kesepuluh user di grup ter-scope belum punya identitas hierarki sama sekali, tapi delapan di
antaranya akun uji dan dua sisanya (Manager) sudah ditutup dengan `view_all`. Jadi fail-closed
menyala tepat sebelum ada yang bergantung padanya.

Untuk mengisi identitas nanti, salin ejaan dari sumbernya supaya tidak salah ketik:

```sql
SELECT DISTINCT spv_name FROM sales_targets
WHERE period_month = 7 AND period_year = 2026 AND spv_name IS NOT NULL ORDER BY 1;
```

Catatan nama objek DB yang sempat menjebak: tabel grup bernama **`access_group`** (bukan
`group`), dan kolom identitas di tabel `user` **camelCase** — `"hierarchyRole"`,
`"hierarchyName"` — jadi wajib dikutip di psql.

---

## 2. APA YANG BERUBAH — 8 fase, 8 commit

| Fase | Commit | Isi |
|---|---|---|
| 1 | `3b8212f` | Tidak ada target = tidak ada insentif (keputusan user) + peringatannya |
| 2 | `a9fae96` | Filter tampilan tidak lagi mengubah nominal (C1, C2) |
| 3 | `120d363` | Filter kepemilikan setara Finance (C3, H2, H3, M2, M3) |
| 4 | `91525eb` | Integritas pembayaran (H4, M5) |
| 5 | `5e7ccc7` | Upload ditolak jelas, bukan gagal senyap (M4, M6, H10, M9, H12) |
| 6 | `08cd1f7` | Idempotensi upload + biaya query (H5, H6, M11) |
| 7 | `a016d44` | Angka menjelaskan dirinya sendiri (UX) |
| 8 | `7df863d` | Determinisme klaim, validasi strata, test yang jalan (M10, M15, LOW) |

### 2.1 Aturan uang yang BERUBAH — nominal akan bergeser

Empat hal di bawah ini mengubah angka yang dibayar. Semuanya keputusan sadar, bukan efek
samping.

1. **Target 0 → Rp 0.** Sebelumnya komponen AO memakai penyebut 240 dan tidak melihat target
   Value sama sekali, jadi baris yang targetnya belum diisi tetap berhak 70% pool
   (Rp 700.000). **Nominal turun** untuk baris seperti itu.
2. **Principal tanpa target tidak menghitung `n`** — baik di mix GT maupun di SPV. Di mix,
   konstanta pool anggota lain tidak lagi membengkak karena baris hantu (**turun**). Di SPV,
   rate tidak lagi diencerkan principal yang pasti tidak dibayar (**naik**: n=2 rate 800rb →
   n=1 rate 1,5jt).
3. **Filter Principal/Cabang tidak lagi mengubah nominal.** Angka yang dilihat Finance saat
   memfilter dulu bisa 2,5× lebih besar, dan angka itulah yang tersimpan saat Tandai Lunas.
4. **SPV ambang 100% per principal** (dari sesi sebelumnya, commit `28b1eed`).

**Konsekuensi operasional:** baris yang sudah ditandai lunas TIDAK berubah — ia menampilkan
snapshot yang benar-benar dibayar, dengan penanda selisih hitung-ulang untuk periode berjalan.
Yang belum lunas akan menampilkan angka baru setelah deploy.

### 2.2 Upload sekarang MENOLAK, yang dulu diterima diam-diam

File yang sebelumnya lolos bisa jadi ditolak 400 sekarang. Ini disengaja — semuanya dulu
berakhir sebagai angka salah tanpa peringatan:

- `Channel` selain GT/TT/MT (termasuk `"Gt"`) → ditolak bernomor baris. Dulu: seluruh baris itu
  insentifnya Rp 0 diam-diam.
- Satu kode sales dengan dua `tipeSales` → ditolak. Dulu: 3 × Rp 1jt alih-alih mix Rp 1,2jt.
- EC/AO/IA pecahan → ditolak. Dulu: Postgres menolak di tengah transaksi, seluruh upload
  rollback dengan pesan mentah tanpa menunjuk baris.
- Tanggal bukan `YYYY-MM-DD`, atau tanggal yang tidak cocok dengan periode terpilih → ditolak.
  Dulu: closing Juli yang diunggah saat dropdown menunjuk Agustus mendarat di bulan yang salah.
  **Tanggal 1 bulan berikutnya tetap sah** (konversi Excel membulatkan 31 Juli 23:59:35).
- Principal/Cabang kosong → ditolak (default demo `NESTLE`/`BANDUNG` dicabut dari klien).

### 2.3 Akses: ringkas

Semua endpoint uang kini memeriksa **data siapa yang disentuh**, bukan hanya permission:
`payments` (GET/POST/PATCH), `progress` (GET/POST), `support`, `spv-support`, `unmatched`, dan
kedua GET hierarki. Helper `payeeInScope` menangani ketiga bentuk `sales_code` (biasa, `SPV:`,
`SM:`) di satu tempat.

`POST /payments` juga menolak penerima yang bukan penerima sah: harus punya baris target
periode itu, bukan baris `_OFFICE`, dan berada dalam cakupan pemanggil.

---

## 3. YANG SENGAJA TIDAK DIKERJAKAN

1. **Hitung-ulang nominal pembayaran di server (sisa H4).** Menuntut ekstraksi seluruh
   perhitungan dashboard (grouping mix lintas principal, support, toggle AO) ke satu fungsi
   bersama. Mengerjakannya terburu-buru justru membahayakan angka yang sedang dilindungi.
   Sumber inflasi terbesarnya sudah ditutup (C1) dan penerima palsu sudah ditolak.
2. **Tabel audit trail before/after (M1).** Satu tabel + helper + 8 titik panggil. Ini
   pekerjaan tersendiri, bukan tempelan; polanya sudah ada di repo (`offAuditLog`,
   `claimAuditLog`). **Ini yang paling saya sarankan dikerjakan berikutnya.**
3. **`lib/rbac.ts`, `lib/rbac/registry.ts`, `components/SidebarLayout.tsx` tidak disentuh** —
   ketiganya memuat pekerjaan **Rekapan Nota** yang belum di-commit. Akibatnya dua LOW ditunda:
   permission `insentif_sales.view_all` belum terdaftar di registry (kodenya sudah menerimanya,
   lihat §1.3 Opsi B), dan `/insentif-sales` belum ada di `pagePermissions` sehingga halamannya
   ter-render untuk siapa pun ber-`dashboard.view` (datanya tetap 403).
   **Sudah dipakai di produksi:** grup Manager diberi `insentif_sales.view_all` lewat SQL
   2026-08-29 dan berfungsi penuh. Yang belum hanya kehadirannya di UI RBAC — jadi kalau nanti
   ada yang mengelola izin lewat layar, key itu tidak akan terlihat dan bisa terhapus tanpa
   sengaja. Daftarkan di `registry.ts` begitu pekerjaan Rekapan Nota sudah di-commit.
4. **`spv_name` NULL dari jalur Laporan Harian (M14).** Butuh keputusan apakah pipeline python
   punya kolom GOLONGAN. Sementara itu `/spv-mismatch` buta untuk baris dari jalur itu dan
   melaporkan "0 ketidaksinkronan" yang tidak berarti bersih.
5. **`achieved_ec/ao/ia` tetap `integer`.** Realisasi memang cacahan; yang diperbaiki adalah
   validasinya (400 bernomor baris), bukan tipe kolomnya.
6. **Prorata waktu.** "Tandai Lunas" di tengah bulan masih menyimpan angka yang belum matang.
   Keputusan produk, bukan bug.

---

## 4. VERIFIKASI SETELAH DEPLOY

```bash
# 1. Perhitungan murni (9 file, semuanya harus OK/pass)
for t in insentif-sales-calc insentif-mt-calc insentif-spv-calc insentif-sm-calc \
         insentif-payee insentif-value-source sales-code-merge excel-date insentif-sales-excel; do
  node --experimental-strip-types lib/$t.test.ts || node --experimental-strip-types --test lib/$t.test.ts
done
```

Di layar, periksa lima hal ini:

1. **Admin/Finance masih melihat seluruh baris** (§1.3). Kalau kosong, itu fail-closed bekerja
   dan grup-nya perlu izin — bukan bug.
2. **Spanduk kuning** kalau ada kombinasi tanpa target ATAU bertarget 0; daftarnya bisa dibuka
   dan punya kolom **Sebab**.
3. **Baris Rp 0 menyebutkan alasannya** di kolom Total Insentif.
4. **Rincian SPV** punya kolom Support, dan baris berpencapaian ≥100% yang nol berbunyi
   "ditanggung principle", bukan "belum 100%".
5. **Kolom IA/Toko** menampilkan angka puluhan (mis. 38,45), bukan ribuan.

---

## 5. CATATAN UNTUK PENERUS

**Grup Finance masih kosong (0 user).** Dikonfirmasi user 2026-08-29: grupnya belum dipakai,
timnya baru akan masuk setelah masa uji. Sampai itu terjadi, izin bayar menempel di grup Admin.
Saat Finance benar-benar dipakai, beri tiga izin ini dan cabut `manage_payment` dari Admin:

```sql
INSERT INTO group_permission (group_id, permission_key)
SELECT id, unnest(ARRAY['insentif_sales.view','insentif_sales.manage_payment','insentif_sales.input_support'])
FROM access_group WHERE name = 'Finance' ON CONFLICT DO NOTHING;
```

`manage_payment` sekaligus berarti "lihat semua" (lihat `LIHAT_SEMUA_KEYS` di
`lib/insentif-hierarchy-scope.ts`), jadi Finance tidak perlu identitas hierarki.

- **Jangan menaruh aturan uang di klien.** Agregasi closing masih dilakukan di browser
  (`page.tsx` meringkas 64.000 baris jadi ~2.000), dan payload itulah yang menentukan
  realisasi. Server sekarang memvalidasinya ketat, tapi arsitekturnya tetap begitu.
- **Kalkulasi murni adalah bagian paling sehat modul ini.** Sembilan dari sepuluh temuan
  audit bukan soal rumus, melainkan **konteks yang dikirim ke rumus itu**: filter tampilan,
  default palsu, target 0, kode sales di luar cakupan. Kalau ada gejala nominal aneh, curigai
  jalur masuknya dulu, bukan `lib/insentif-*-calc.ts`.
- **Setiap perubahan di modul ini diuji terhadap prinsip filter setara-Finance** yang kini
  tertulis di `SYSTEM_MAP.md`. Filter yang hanya menyembunyikan di UI adalah bug keamanan.
- Masih terbuka dari handover11: **`BETTER_AUTH_SECRET` lemah di produksi** (Better Auth
  memperingatkan dua kali tiap start), dan **fix webhook Accurate** yang masih menunggu
  persetujuan — webhook tetap gagal 100% sampai itu di-commit.
