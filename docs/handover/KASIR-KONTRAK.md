# Kontrak Kasir ↔ Incaso (K1a, BL-59) — tabel + lib murni untuk K1b / K2 / K3

Sumber keputusan: `scratch/fiori-intake/OWNER-ANSWERS-S7-2026-10-10.md` (C8 + Kasir 11 Okt), bukti `KASIR-BUKTI-PROBE-2026-10-11.md`,
eksplorasi `KASIR-EKSPLORASI-2026-10-11.md` §4–§5. Zona AGENTS §3: uang + skema.

## 1. Aturan (owner 11 Okt)

| Aturan | Isi | Di mana |
|---|---|---|
| Kolektor | salesman FAKTUR = `detailInvoice[].invoice.masterSalesmanId` | `alokasiPelunasan` |
| Uang Incaso | `chequeAmount` pelunasan (Tunai `CASH_OTHER` + Transfer `BANK_TRANSFER` + Giro `BANK_CHEQUE`); metode `OTHERS` (retur/ayat silang) DIKELUARKAN (`nonKas`, info). Daftar putih `METODE_UANG` dicocokkan PERSIS: metode lain (`CREDIT_CARD`, huruf/spasi beda) -> ember tak teralokasi `metode_tak_dikenal` (seluruh cheque, terlihat, wajib dijelaskan) — tidak pernah dihitung tunai diam-diam. Cheque metode UANG **negatif** -> ember `nominal_negatif` (seluruh cheque, wajib dijelaskan, TIDAK mengurangi total orang; owner 12 Okt K-1 a) | `alokasiPelunasan` |
| Bagi per orang (nominal = `chequeAmount`) | semua baris faktur milik SATU orang -> `chequeAmount` PENUH ke orang itu (lebih bayar / kredit ikut orangnya, tanpa ember). Multi-orang -> per baris `invoicePayment`; Σ ≠ `chequeAmount` -> selisih ke ember **tak teralokasi** per pelunasan: `sisa` = cheque − Σ (> 0 `lebih_bayar` "uang lebih / lebih bayar", < 0 `kredit` "kredit / non-kas"), `orang[]` dari baris faktur, `alasan` (`jumlah_invoice_payment_beda` / `tanpa_baris_faktur`) — TIDAK dibagi diam-diam. Invarian: Σ bagian + Σ sisa = Σ chequeAmount | `alokasiPelunasan` |
| Orang | id -> `accurate_employee.number` (kode) -> `sales_code_merge` (`decision='merge'`, bulan = bulan `tanggal`, rantai diikuti; rantai SIKLIK A->B->C->A = galat) -> ORANG; kode tanpa gabungan / peta ke diri sendiri = orang sendiri; id null / tanpa kode -> `TANPA_SALESMAN` (`""`, baris terlihat + `salesmanIdTakDikenal`) | `orangDariSalesmanId`, `orangDariKode` |
| Setoran | per ORANG per hari, Tunai + Transfer + Giro; revisi terbesar per kode berlaku; kode setoran juga dilipat lewat gabungan bulan itu (gabungan yang diputuskan belakangan tetap menyatukan) | `rekonsiliasiHari` |
| Klop | setoran = total PERSIS atau = ⌈total / Rp 100⌉ × Rp 100 (41.592.193 -> 41.592.200 klop; 41.592.300 selisih) | `klop`, `bulatkanKeAtas100` |
| Status | `klop` · `selisih` · `belum_setor` (tak ada baris setoran) · `setoran_tanpa_pelunasan`. Setoran 0 yang TERCATAT = angka (selisih), bukan belum setor. `dijelaskan` = ada catatan dengan angka (pelunasan, setoran) SAMA dengan sekarang | `rekonsiliasiHari` |
| Tutup (owner 11 Okt **T2**) | terhalang sampai SETIAP baris orang klop/dijelaskan DAN SETIAP ember tak teralokasi dijelaskan (`kasir_tak_teralokasi_catatan`, pelunasan + `sisa` sama). `alasan` = kalimat siap tampil. DB menolak event `tutup` yang `snapshot.terhalang` ≠ `[]` (CHECK `kasir_hari_event_tutup_tuntas`) | `penghalangTutup` |
| Kunci (owner 11 Okt **T1**) | terkunci bila event terakhir (menurut id) `tutup`/`kunci`, atau ≥ 20.00 WITA hari itu tanpa event; `buka` beralasan (≥ 15) membuka sampai 20.00 WITA berikutnya sesudah waktu buka, lalu terkunci ulang otomatis; hari belum tiba (WITA) tidak boleh diubah. Kunci ≠ tutup: kunci 20.00 TETAP mengunci walau terhalang | `statusHari`, `bolehDiubah`, `batasKunci` |
| Snapshot kunci | `snapshotHari` sama untuk tutup & kunci; snapshot KUNCI boleh berisi `terhalang` + `takTeralokasi[].dijelaskan = false` = catatan apa yang belum dijelaskan saat terkunci. Menjelaskannya sesudah itu butuh `buka` (OM/Admin, `kasir.buka`), lalu Kasir menjelaskan dan Tutup | `snapshotHari` |
| Hari kerja | Senin–Sabtu | `hariKerja` |

## 2. Lib `lib/kasir/rekonsiliasi.ts` (murni, tanpa I/O, tanpa jam sistem)

Semua nominal = **sen** (bilangan bulat aman). Nominal rusak = `RangeError` (gagal keras, bukan 0/dibulatkan).

- `keSen(number | string): Sen` — angka JSON Accurate / teks numeric Postgres -> sen tepat; > 2 desimal, notasi e, pemisah ribuan -> `RangeError`.
  Isian manusia ("Rp 1.250.000") = `parseLocaleNumber` (lib/insentif-sales-excel) lalu `keSen`. `senKeTeks(sen)` -> "108741.15" untuk kolom numeric.
- `alokasiPelunasan(Pelunasan[], PetaOrang) -> { bagian: BagianOrang[] (per pelunasan × orang: orang, kode[], salesmanIdTakDikenal[], jumlahFaktur, sen),
  takTeralokasi: TakTeralokasi[] (… sisa, arah, orang[]), nonKas: Pelunasan[] }` (id pelunasan ganda = galat).
- `rekonsiliasiHari({ tanggal, pelunasan, setoran: SetoranRevisi[], catatan?: CatatanSelisih[], catatanTakTeralokasi?: { pelunasanId, sisa }[], peta: PetaOrang }) -> HasilRekonsiliasi`
  `{ tanggal, baris: BarisOrang[] (urut kode, Tanpa salesman terakhir), takTeralokasi: (TakTeralokasi & { dijelaskan })[], nonKas, total: { pelunasan, setoran, takTeralokasi, nonKas } }`.
  `catatanTakTeralokasi` = baris `kasir_tak_teralokasi_catatan` yang SUDAH disaring ke `database_id` yang dibaca.
  `BarisOrang = { orang, kode[], pelunasan, pelunasanPerMetode{metode->sen}, jumlahFaktur, setoran: {tunai,transfer,giro,total}|null, setoranPerKode: {kode, revisi, tunai, transfer, giro, total}[], selisih|null, status, dijelaskan, salesmanIdTakDikenal[] }`.
  Galat pemanggil (dicek lib, tidak hanya CHECK DB): pelunasan lain tanggal; setoran negatif; revisi bukan bulat ≥ 1, ganda, atau berlubang (rantai
  per kode wajib 1..n lengkap — muat SEMUA revisi hari itu). `klop` dengan nilai negatif = `RangeError`.
- `PetaOrang = { kodeSalesman: Map<id, number>, gabunganPerBulan: Map<"YYYY-MM", Map<from, to>> }` — dibangun pemanggil dari `accurate_employee` + `sales_code_merge`.
- `rencanaSetoranOrang(baris, { tunai, transfer, giro }) -> RevisiBaru[]` ({ salesmanKode, revisi, revisiSebelumnya, tunai, transfer, giro }):
  catat/koreksi setoran ORANG — kode utama (= `orang`) dapat revisi baru bernominal baru, SETIAP rantai kode lain milik orang itu yang masih ≠ 0
  dapat revisi baru = 0 (rantai yang sudah 0 tidak ditulis ulang). Tanpa salesman / nominal negatif / bukan sen = galat.
- `penghalangTutup(hasil) -> { bisaDitutup, alasan: string[], baris: BarisOrang[], takTeralokasi[] }` (alasan urut: orang, lalu ember; contoh
  "Uang tak teralokasi SR/2610/5 belum dijelaskan: Rp 100.000 (pelunasan Rp 1.000.000, faktur Rp 900.000).").
- `snapshotHari(hasil)` (JSON murni, `versi: 1`: `total`, `baris[]`, `takTeralokasi[]` {pelunasanId, nomor, sisa, alasan, dijelaskan}, `terhalang` = alasan
  penghalang) — disimpan di `kasir_hari_event.snapshot`; beda dengan snapshot baru = "berubah sejak ditutup".
- `statusHari(tanggal, EventHari[], sekarang) -> { terkunci, sebab: tutup|kunci|otomatis_20|null, kunciBerikutnya }`, `bolehDiubah(...)`, `batasKunci(tanggal)`, `hariKerja(tanggal)`.
  `EventHari.pada` = `Date` (node-pg timestamptz) atau teks ISO BEROFSET (`Z` / `±hh:mm`); teks tanpa ofset = galat (zona tebakan menggeser kunci 20.00).

## 3. Tabel (db/schema.ts; SQL = migrate-pg = `db/migrations/0029_kasir.sql` = `docs/handover/DDL_K1A.sql`)

| Tabel | Sifat | Kolom inti | Kendala |
|---|---|---|---|
| `kasir_setoran` | append-only (trigger + REVOKE di DDL) | `tanggal date`, `salesman_kode` (kode ORANG saat dicatat), `revisi`, `revisi_sebelumnya`, `tunai/transfer/giro numeric(18,2)` (wajib, tanpa default), `no_form_kasir`, `bukti_transfer`, `catatan`, `dicatat_oleh`, `dicatat_pada` | unik `(tanggal, salesman_kode, revisi)` (dobel-klik/balapan -> 23505 -> 409); FK `(tanggal, kode, revisi_sebelumnya)` -> revisi n; `revisi_sebelumnya = revisi − 1` (NULL hanya revisi 1); nominal ≥ 0; kode tidak kosong & tanpa spasi tepi; teks opsional tidak boleh hanya spasi |
| `kasir_selisih_catatan` | append-only | `tanggal`, `salesman_kode` (`''` = Tanpa salesman), `pelunasan`, `setoran` (angka saat dijelaskan), `penjelasan` (≥ 15), `tindak_lanjut` (`setor_susulan`/`koreksi_incaso`/`lapor_om`), `dicatat_oleh/pada` | setoran ≥ 0 |
| `kasir_hari_event` | append-only | `tanggal`, `jenis` (`tutup`/`kunci`/`buka`), `alasan`, `snapshot jsonb`, `oleh`, `pada` | buka: alasan ≥ 15 (NULL ditolak) & tanpa snapshot; tutup/kunci: snapshot objek wajib; **tutup: `snapshot.terhalang` wajib `[]`** (kunci boleh terhalang) |
| `kasir_tak_teralokasi_catatan` | append-only | `tanggal`, `database_id`, `pelunasan_id`, `sisa` (angka saat dijelaskan; berubah = tidak berlaku), `penjelasan` (≥ 15), `dicatat_oleh/pada` | sisa ≠ 0; TANPA FK ke cache (cache boleh dibaca ulang/dihapus, penjelasan tetap) |
| `kasir_pelunasan` | cache (upsert/hapus oleh K1b) | PK `(database_id, pelunasan_id)`, `nomor`, `tanggal` (transDate), `metode`, `cheque_amount`, `last_update` (teks Accurate apa adanya), `dibaca_pada` | indeks `(database_id, tanggal)`; TANPA raw_data |
| `kasir_pelunasan_faktur` | cache | PK `(database_id, pelunasan_id, faktur_id)`, `nomor_faktur`, `master_salesman_id`, `invoice_payment` | FK ke kepala ON DELETE CASCADE |
| `kasir_pelunasan_baca` (K1b, §7) | status baca (UPDATE oleh pembaca; tanpa trigger, tanpa DELETE aplikasi) | PK `(database_id, tanggal)`, `status`, `sebab`, `pesan`, `jumlah_daftar`, `sisa_detail`, `ditolak jsonb`, `token`, `mulai_pada`, `selesai_pada`, `lengkap_pada`, `pemicu` | CHECK status/sebab/isi/konsisten (gagal ⇔ sebab; berjalan ⇔ token & tanpa selesai; lengkap ⇒ sisa 0, tanpa ditolak, lengkap_pada) |

Penyimpangan dari usulan §4 eksplorasi: setoran SATU baris per revisi berisi tiga kolom metode (owner: per ORANG, dialog Tunai/Transfer/Giro)
alih-alih satu baris per metode; penunjuk revisi = FK komposit `revisi_sebelumnya` (rantai dijamin DB, tanpa trigger); penjelasan menyimpan
ANGKA, bukan hash `sidik`; cache dipecah kepala + baris (brief) dengan `nomor_faktur` opsional; `customer_no`/`payment_amount`/`discount_total`/
`salesman_sumber` tidak disimpan (tidak dipakai rekonsiliasi). `database_id` hanya di cache + penjelasan tak teralokasi (id Accurate unik per
database). Penjelasan tak teralokasi = TABEL SENDIRI, bukan perluasan `kasir_selisih_catatan`: kuncinya pelunasan (bukan orang) dan angkanya `sisa`
(bukan pelunasan/setoran) — memperluas tabel lama butuh kolom bersyarat + CHECK bersyarat; tabel kecil terpisah CHECK-nya sederhana.

## 4. Kewajiban pemakai

- **Semua penulis uang** lewat `keSen` -> `senKeTeks`: `numeric(18,2)` membulatkan > 2 desimal DIAM-DIAM (diuji).
- **K1b** (SELESAI, §7): tulis cache hanya dari pembaca sistem (`resolveSyncCredentials`); nominal Accurate lewat `keSen` — pelunasan yang ditolak =
  galat terlihat, bukan dilewati; hapus kepala yang hilang di Accurate (baris ikut terhapus). Status baca = tabel `kasir_pelunasan_baca` (§7).
- **K2**: `requirePermission` `kasir.view` (GET), `kasir.catat` (setoran + jelaskan), `kasir.tutup`, `kasir.buka` (alasan ≥ 15). Sebelum menulis setoran/
  penjelasan/tutup: `bolehDiubah` (dan untuk tutup: `penghalangTutup(...).bisaDitutup`, snapshot dari `snapshotHari`) di DALAM transaksi yang sama dengan INSERT, diserialkan per tanggal (mis. `pg_advisory_xact_lock(hashtext('kasir:'||tanggal))`)
  agar Tutup dan Catat tidak berbalapan. **Catat/koreksi setoran = `rencanaSetoranOrang(baris, nominal)`; SEMUA baris rencana disisipkan dalam SATU
  transaksi** (satu gagal = semua batal). Alasan: orang multi-kode (gabungan `sales_code_merge` bisa diputuskan SESUDAH setoran dicatat per kode) —
  koreksi hanya di satu rantai membuat total orang dobel; rencana menolkan rantai lain. Revisi = revisi terakhir rantai + 1 dengan `revisi_sebelumnya`;
  23505 -> 409 (baca ulang, susun rencana lagi). Spec it11: Nomor Form Kasir wajib dan
  bukti wajib bila transfer > 0 — skema membiarkan nullable agar perubahan keputusan tidak butuh DDL; K2 menegakkan. Event `kunci` ditulis sistem
  (best effort, `oleh = 'sistem'`) saat pertama kali melihat hari terkunci otomatis tanpa event — kunci tidak bergantung pada baris itu.
- **K3**: Beranda hanya membaca cache + tabel ini (tidak pernah memicu Accurate).
- **Izin**: `kasir.view/catat/tutup/buka` terdaftar (`lib/rbac/registry.ts`), `kasir.buka` di `CAPABILITY_KEYS`; `/kasir` -> `kasir.view`. Kunci ke grup =
  `docs/handover/RBAC_PRESET_KASIR.sql` (Kasir: view/catat/tutup; OM & Admin: view/buka; lewat NAMA grup, INSERT ON CONFLICT DO NOTHING, grup absen =
  NOTICE, jejak `group_permission.sync`, laporan baca-saja di akhir). `scripts/seed-rbac-presets.ts` yang dijalankan ulang mengosongkan kasir.* grup OM ->
  jalankan ulang berkas preset ini sesudahnya.

## 5. Prasyarat deploy (IT Support, urut)

1. `docs/handover/DDL_K1A.sql` sebagai role pemilik, SEBELUM image K1a; semua baris VERIFIKASI `ok` (juga bila `DATABASE_MIGRATION_URL` terpasang).
2. Image K1a (migrate-pg men-SKIP entri kasir).
3. `docs/handover/RBAC_PRESET_BL37.sql` (S7-1, membuat grup Kasir) — lalu `docs/handover/RBAC_PRESET_KASIR.sql`; periksa laporan akhirnya (tiga grup `ada = true`).

**Catatan IT Support:** (a) `scripts/seed-rbac-presets.ts` bila dijalankan ulang menghapus & mengisi ulang izin 11 preset lama: Admin mendapat SEMUA kunci
`kasir.*` (termasuk `catat`/`tutup`) dari registry, OM KEHILANGAN `kasir.view`/`kasir.buka` -> jalankan `RBAC_PRESET_KASIR.sql` lagi sesudahnya.
(b) Blok VERIFIKASI `RBAC_PRESET_BL37.sql` akan menampilkan grup Kasir `cocok = false` SESUDAH preset KASIR dijalankan (Kasir kini memegang
`kasir.*` di samping `dashboard.view`) — itu wajar, bukan tanda grup lama bernama sama.

## 6. Keputusan owner 11 Okt (dulu TERBUKA)

- **T1** Sesudah buka kembali: terkunci ulang otomatis **20.00 WITA berikutnya** (perilaku lib; uji `kunci hari T1`).
- **T2** Uang tak teralokasi **WAJIB dijelaskan sebelum Tutup** (uji lib `T2` + uji PG CHECK `tutup_tuntas`); kunci otomatis tetap mengunci dan snapshot-nya
  mencatat yang belum dijelaskan.
- **K-1 (12 Okt, pilihan a)** Pelunasan Tunai/Transfer/Giro ber-`chequeAmount` NEGATIF -> SELURUH nominal ke ember tak teralokasi `nominal_negatif`
  (arah `kredit`, `orang[]` dari baris faktur, wajib dijelaskan sebelum Tutup seperti `metode_tak_dikenal`), TIDAK mengurangi total orang; orang lain
  tetap direkonsiliasi — tidak ada galat sehari (dulu `klop` melempar untuk semua orang). Metode tak dikenal bernominal negatif tetap
  `metode_tak_dikenal`; OTHERS tetap non-kas. Tanpa DDL: penjelasan ember berkunci `pelunasan_id` + `sisa` (negatif sah). Uji lib `K1b RENDAH 5b`.
- **K-3 (12 Okt, setuju)** Hari yang memuat pelunasan DITOLAK pembaca (bentuk/nominal/s:false) tak pernah `lengkap`; Tutup terhalang sampai
  diperbaiki di Accurate (tanpa jalan "jelaskan & tutup"); kunci 20.00 tetap berjalan. Uji `baca-pelunasan.test.ts` (ditolak = gagal, tetap gagal).

## 7. K1b — pembaca/cache Accurate pelunasan (12 Okt 2026)

Berkas: `lib/kasir/pembaca.ts` (murni), `lib/kasir/baca-pelunasan.ts` (server), `app/api/kasir/segarkan/route.ts`, `app/api/cron/kasir-pelunasan/route.ts`,
skema `kasir_pelunasan_baca` (`db/schema.ts` = migrate-pg = `db/migrations/0031_kasir_baca.sql` = `docs/handover/DDL_K1B.sql`).

**Cara membaca** (per tanggal, identitas SINKRON — Kasir tak punya sesi Accurate): lease baris status → `sales-receipt/list.do` filter `transDate`
SAJA, urut `id|asc`, 100/halaman, berurutan + jeda 150 ms → `detail.do` HANYA untuk id baru / `lastUpdate` beda TEKS (≤ 4 serentak; sesudah 429
turun ke 2 sampai akhir putaran) → per pelunasan SATU transaksi (upsert kepala + ganti baris faktur, token lease dicek `FOR SHARE`) → hapus id cache
yang tak ada di daftar (HANYA bila daftar lengkap) → status. "Inkremental" = per id, bukan kursor jam; `last_update` disimpan = nilai list.do yang
dibaca SEBELUM detail. `penuh` = tandai `last_update` tanggal itu NULL (isi tetap) lalu baca biasa → terputus pun, putaran berikut membaca sisanya.
Daftar fail-closed: `s:true` + `d` larik; `sp.pageCount` sah (0 hanya bila kosong) dan tidak turun; halaman kosong sebelum halaman terakhir = gagal;
`sp.rowCount` wajib; `rowCount` berubah antarhalaman / id unik ≠ `rowCount` → daftar diulang SEKALI lalu `terpotong`; `transDate` baris ≠ tanggal
= `bentuk` (filter diabaikan, tidak membaca seluruh riwayat); > 50 halaman = `terpotong`. Detail: `invoicePayment` absen = `bentuk` (TANPA
cadangan `paymentAmount`), > 2 desimal = `nominal`, faktur sama dua kali = dijumlah (salesman beda = `bentuk`), `transDate` pindah = tidak ditulis.

**Status `kasir_pelunasan_baca`** (PK `database_id, tanggal`):

| status | arti | K2 |
|---|---|---|
| `berjalan` | lease aktif (`aktif` = dimulai < 2 mnt lalu menurut jam DB); `aktif = false` = pembaca terhenti, boleh diklaim ulang | tampil "Membaca…", BUKAN lengkap |
| `lengkap` | daftar lengkap ∧ setiap id daftar ada di cache dengan `last_update` sama ∧ tanpa ditolak ∧ tanpa galat; `lengkap_pada` = saat itu | satu-satunya status yang boleh menampilkan total sebagai lengkap dan membuka Tutup |
| `sebagian` | batas waktu putaran (45 dtk) habis; `sisa_detail` = id belum cocok (null bila daftar belum selesai) | klien memanggil POST lagi ("Membaca n/N") |
| `gagal` | `sebab` = kelas galat di bawah; `pesan` disaring (tanpa token); `ditolak` = [{id, nomor, sebab, pesan}] | Galat terlihat; Tutup terhalang |

Galat TIDAK pernah menghapus cache atau memundurkan `lengkap_pada` (hanya maju). Hari dengan pelunasan DITOLAK (`bentuk`/`nominal`/`ditolak`) tak
pernah `lengkap` sampai diperbaiki di Accurate — **keputusan owner 12 Okt (K-3)**: Tutup terhalang sampai diperbaiki; tanpa jalan "jelaskan & tutup"; kunci
20.00 tetap berjalan. **Sesi sinkron mati** (kredensial gagal) sementara database sesi masih diketahui: status tanggal itu DITULIS `gagal`/`sesi_sinkron`
(lease dihormati, `lengkap_pada` tetap sebagai riwayat) — `lengkap` lama tidak tetap tampil. Kolom `akun_sinkron` = user.id akun Accurate sinkron yang
membaca; ke klien sebagai NAMA (`akun`), `pemicu` tanpa id (`pemicu` = cron/manual, `pemicuOleh` = nama); waktu = ISO UTC (`…Z`).

**Kelas galat (`sebab`)**: `sesi_sinkron` (HTTP 401 / kredensial absen — BERHENTI seketika), `hak_akses` (403 — berhenti), `batas_laju` (429 — ulang
0,5/1/2 dtk, Retry-After dihormati, lalu galat), `accurate_5xx` / `jaringan` (ulang ≤ 3×), `tidak_pasti` (timeout/abort/bukan JSON — ulang 1×),
`ditolak` (`s:false` / HTTP lain), `bentuk`, `nominal`, `terpotong`, `hapus_massal` (penjaga: satu putaran akan menghapus > 5 pelunasan DAN > 10 %
cache tanggal itu -> TIDAK dihapus, `ditolak` = daftar id/nomor; jalan keluar POST `konfirmasiHapus: true` oleh pemegang `kasir.buka`).

**Route & kode HTTP**: `POST /api/kasir/segarkan {tanggal, penuh?, konfirmasiHapus?}` (`kasir.view`; tanggal sah ≤ hari ini WITA; `penuh` &
`konfirmasiHapus` HANYA pemegang **`kasir.buka`** (kunci kapabilitas OM/Admin, D-01) -> selain itu 403): 200 `{ok, status}` lengkap/sebagian, 200
`{ok, dariCache: true}` bila lengkap < 60 dtk lalu (tanpa Accurate), 409 `SEDANG_DIBACA` + status, 409 `HAPUS_MASSAL` + status, 503 `SESI_SINKRON`
("Sesi Accurate akun sinkron kedaluwarsa — admin login ulang di /sesi-accurate lalu pilih database"), 502 `BACA_GAGAL` + status.
`GET /api/kasir/segarkan?tanggal=` → status TANPA Accurate (`belum_dibaca` bila tak ada baris). `GET /api/cron/kasir-pelunasan` (`CRON_SECRET`;
`?tanggal=`, `?penuh=1`, `?check=1`): bawaan hari ini WITA + mundur sampai hari kerja sebelumnya (Senin: Sabtu & Minggu), berurutan, `sebagian`
dilanjutkan ≤ 3×; tanggal yang lease-nya dipegang tombol/cron lain = `sedang_dibaca` berketerangan (BUKAN galat); `penuh=1` yang bertemu lease
MENUNGGU tiap 5 dtk sampai lease selesai/kedaluwarsa (≤ 2,5 mnt per tanggal) lalu `PENUH_TERTUNDA`. 200 = semua lengkap, 202 = sisanya hanya
`sedang_dibaca`, 503 = sesi mati, 502 = lainnya (rincian per tanggal). Tidak memulai putaran baru sesudah 13 menit (`tidak_sempat`).

**Fungsi untuk K2/K3** (`lib/kasir/baca-pelunasan.ts`, tanpa Accurate): `sesiSinkron()` / `databaseIdSinkron()` (database sesi sinkron saat ini; ""
= sesi tak ada → 503 SESI_SINKRON), `muatPelunasanHari(databaseId, tanggal)` → `{ status, pelunasan: Pelunasan[] }` (satu snapshot REPEATABLE READ;
sen lewat `keSen`) = masukan `rekonsiliasiHari`, `statusBaca(databaseId, tanggal)`, `publikkan(status)` (WAJIB sebelum status dikirim ke klien),
`segarUntukTutup(status, sekarang)` (lib/kasir/pembaca).

**Catatan untuk K2 (keputusan orkestrator 12 Okt)**: Tutup hari mensyaratkan `status === "lengkap"` DAN `lengkap_pada` ≤ **15 menit** lalu
(`segarUntukTutup`); bila lebih tua, UI memicu segarkan dulu dan memakai hasilnya. Periksa pada snapshot yang sama dengan angka yang ditutup (baca
ulang di dalam transaksi Tutup); snapshot hari (`snapshotHari`) sebaiknya memuat `{ status, lengkapPada, jumlahDaftar }` baca saat itu. Cache hanya
untuk `databaseIdSinkron()` saat ini — database lain = tidak dibaca. Klien yang mengulang POST selama `sebagian` wajib punya batas ulang. Halaman
daftar yang bergeser selama pembacaan = `terpotong` sekali, sembuh sendiri di putaran berikut (tanpa mekanisme baru).

**Plafon (ponytail)**: penjaga hapus massal = ambang heuristik (> 5 DAN > 10 %) — akun sinkron yang kehilangan SEDIKIT cabang tetap bisa menghapus
pelunasan cabang itu; jalan naik = bandingkan daftar cabang yang terlihat akun sinkron dengan harapan sebelum menghapus. Balapan dua tanggal yang
dibaca bersamaan saat pelunasan dipindah tanggal di Accurate dalam milidetik yang sama bisa meninggalkan satu baris basi sampai putaran berikut.
`sesiSinkron` menyalin pemilihan user `resolveSyncCredentials` (ubah keduanya bersama). Satu pelunasan bisa punya dua ember (`nominal_negatif` +
`jumlah_invoice_payment_beda`); penjelasan berkunci (pelunasan, sisa).

**TERBUKA**: K-2 (IT): crontab VPS (jadwal di bawah). K-1 dan K-3 sudah diputuskan owner (§6).

**Prasyarat deploy (IT, urut — feat/fiori BELUM di produksi)**: `docs/handover/DDL_K1A.sql` → `docs/handover/DDL_S7_2.sql` (entri migrate-pg
`principal_log` 0030 berjalan lebih dulu) → `docs/handover/DDL_K1B.sql`, semuanya sebagai role pemilik SEBELUM image (VERIFIKASI semua `ok`; baris
"prasyarat K1a" false = DDL_K1A belum jalan; baris "definisi persis" false = CHECK diubah/dilemahkan) → image → `ACCURATE_SYNC_USER_ID` = akun
**admin yang melihat SEMUA cabang** (sesi hidup + database terpilih; akun bercabang sebagian memicu `hapus_massal` / menghapus pelunasan cabang
lain) → crontab `/api/cron/kasir-pelunasan`. Tanpa env baru. Beban Accurate tambahan ±9 list.do per tanggal per putaran + detail yang berubah
(token dipakai bersama webhook faktur). Boleh rilis sebelum K2 (cache terisi tanpa UI).

**Crontab (K-2, usul; WITA = UTC+8, jadwal ditulis UTC EKSPLISIT untuk server ber-TZ UTC)** — 07.00–21.00 WITA Senin–Sabtu tiap 15 menit + baca penuh
19.30 WITA; Senin 07.00 WITA = **Minggu 23.00 UTC**:

```
# m   h     dom mon dow   (UTC)
*/15  23    *   *   0-5   curl -fsS --max-time 900 -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/kasir-pelunasan   # 07.00–07.45 WITA Sen–Sab
*/15  0-12  *   *   1-6   curl -fsS --max-time 900 -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/kasir-pelunasan   # 08.00–20.45 WITA
0     13    *   *   1-6   curl -fsS --max-time 900 -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/kasir-pelunasan   # 21.00 WITA
30    11    *   *   1-6   curl -fsS --max-time 900 -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/kasir-pelunasan?penuh=1"   # 19.30 WITA
```

Bila TZ server = WITA, pakai jam WITA langsung (`*/15 7-20 * * 1-6`, `0 21 * * 1-6`, `30 19 * * 1-6 …?penuh=1`). `--max-time` ≥ 900 (route berhenti
memulai putaran baru sesudah 13 menit). Kode 202 = normal (tanggal sedang dibaca tombol); 502/503 = periksa status di UI.
