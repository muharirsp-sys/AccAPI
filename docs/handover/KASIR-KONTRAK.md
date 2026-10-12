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
cache-nya TERAKHIR DITERAPKAN dari daftar LENGKAP (tidak ditimpa saat klaim; tetap akun lama bila putaran gagal sebelum langkah hapus — 5xx/401/
terpotong/waktu habis/sesi mati — dan selama penjaga ganti-akun menahan hapus); ke klien sebagai NAMA (`akun`),
`pemicu` tanpa id (`pemicu` = cron/manual, `pemicuOleh` = nama); waktu = ISO UTC (`…Z`). `penuh_tertunda_pada` (`penuhTertundaPada`) = baca penuh
cron yang menyerah menunggu lease: terlihat di UI, dan klaim BERIKUTNYA (cron 15 menit / tombol, juga dalam jeda lengkap 60 dtk) menjalankan baca
penuh lalu mengosongkannya. Baca penuh menandai cache basi SEGERA sesudah klaim (sebelum list.do): putaran yang kehabisan waktu di tengah daftar
tidak pernah berakhir `lengkap` tanpa membaca ulang (probe P1d).

**Kelas galat (`sebab`)**: `sesi_sinkron` (HTTP 401 / kredensial absen — BERHENTI seketika), `hak_akses` (403 — berhenti), `batas_laju` (429 — ulang
0,5/1/2 dtk, Retry-After dihormati, lalu galat), `accurate_5xx` / `jaringan` (ulang ≤ 3×), `tidak_pasti` (timeout/abort/bukan JSON — ulang 1×),
`ditolak` (`s:false` / HTTP lain), `bentuk`, `nominal`, `terpotong`, `hapus_massal` (penjaga: satu putaran akan menghapus > 5 pelunasan DAN > 10 %
cache tanggal itu, ATAU akun sinkron berganti sejak cache terakhir diterapkan dan putaran akan menghapus ≥ 1 baris -> TIDAK dihapus, `ditolak` =
daftar id/nomor; bertahan sampai POST `konfirmasiHapus: true` oleh pemegang `kasir.buka`).

**Route & kode HTTP**: `POST /api/kasir/segarkan {tanggal, penuh?, konfirmasiHapus?}` (`kasir.view`; tanggal sah ≤ hari ini WITA; `penuh` &
`konfirmasiHapus` HANYA pemegang **`kasir.buka`** (kunci kapabilitas OM/Admin, D-01) -> selain itu 403): 200 `{ok, status}` lengkap/sebagian, 200
`{ok, dariCache: true}` bila lengkap < 60 dtk lalu (tanpa Accurate), 409 `SEDANG_DIBACA` + status, 409 `HAPUS_MASSAL` + status, 503 `SESI_SINKRON`
("Sesi Accurate akun sinkron kedaluwarsa — admin login ulang di /sesi-accurate lalu pilih database"), 502 `BACA_GAGAL` + status.
`GET /api/kasir/segarkan?tanggal=` → status TANPA Accurate (`belum_dibaca` bila tak ada baris). `GET /api/cron/kasir-pelunasan` (`CRON_SECRET`;
`?tanggal=`, `?penuh=1`, `?check=1`): bawaan hari ini WITA + mundur sampai hari kerja sebelumnya (Senin: Sabtu & Minggu), berurutan, `sebagian`
dilanjutkan ≤ 3×; tanggal yang lease-nya dipegang tombol/cron lain = `sedang_dibaca` berketerangan (BUKAN galat); `penuh=1` yang bertemu lease
MENUNGGU tiap 5 dtk sampai lease selesai/kedaluwarsa (≤ 2,5 mnt per tanggal) lalu `PENUH_TERTUNDA` (dicatat `penuh_tertunda_pada`; klaim berikut
membaca penuh; tanggal `tidak_sempat` di bawah `penuh=1` juga ditandai). Cron bawaan IKUT membaca tanggal ≤ 7 hari yang masih bertanda
tertunda (mis. Sabtu/Minggu yang ditandai Senin; klaimnya otomatis penuh); penanda > 7 hari = kedaluwarsa, tetap terlihat di status, tidak
dijalankan otomatis (`?tanggal=…&penuh=1` manual). 200 = semua lengkap, 202 = sisanya hanya
`sedang_dibaca`, 503 = sesi mati, 502 = lainnya (rincian per tanggal). Tidak memulai putaran baru sesudah 13 menit (`tidak_sempat`).

**Fungsi untuk K2/K3** (`lib/kasir/baca-pelunasan.ts`, tanpa Accurate): `sesiSinkron()` / `databaseIdSinkron()` (database sesi sinkron saat ini; ""
= sesi tak ada → 503 SESI_SINKRON), `muatPelunasanHari(databaseId, tanggal)` → `{ status, pelunasan: Pelunasan[] }` (satu snapshot REPEATABLE READ;
sen lewat `keSen`) = masukan `rekonsiliasiHari` (K2a: isinya = `muatPelunasanDalam(tx, …)` di transaksi pemanggil, perilaku sama), `statusBaca(databaseId, tanggal)`, `publikkan(status)` (WAJIB sebelum status dikirim ke klien),
`segarUntukTutup(status, sekarang)` (lib/kasir/pembaca).

**Catatan untuk K2 (keputusan orkestrator 12 Okt)**: Tutup hari mensyaratkan `status === "lengkap"` DAN `lengkap_pada` ≤ **15 menit** lalu
(`segarUntukTutup`); bila lebih tua, UI memicu segarkan dulu dan memakai hasilnya. Periksa pada snapshot yang sama dengan angka yang ditutup (baca
ulang di dalam transaksi Tutup); snapshot hari (`snapshotHari`) sebaiknya memuat `{ status, lengkapPada, jumlahDaftar }` baca saat itu. Cache hanya
untuk `databaseIdSinkron()` saat ini — database lain = tidak dibaca. Klien yang mengulang POST selama `sebagian` / `SEDANG_DIBACA` wajib memberi
jeda **≥ 6 dtk** antarpanggilan (cron baca penuh mencoba klaim tiap 5 dtk; klien yang mengulang tiap 0,3 dtk merebut lease setiap kali lepas dan
menunda baca penuh) dan punya batas ulang. Halaman daftar yang bergeser selama pembacaan (batas yang DISENGAJA): bila jumlah baris berubah ->
`terpotong` sekali; bila hapus + tambah dalam jumlah SAMA -> bisa `lengkap` KELIRU (satu baris terlewat, bahkan terhapus dari cache) sampai putaran
berikut / baca penuh 19.30 — sembuh sendiri, tanpa mekanisme baru.
**INFO**: saat sesi sinkron mati, cron berhenti di tanggal PERTAMA (hari ini) dengan 503; tanggal sebelumnya tetap `lengkap` lama, tetapi Tutup tetap
terhalang aturan `lengkap_pada` ≤ 15 menit.

**Plafon (ponytail)**: penjaga hapus massal = ambang heuristik (> 5 DAN > 10 %) — akun sinkron yang kehilangan SEDIKIT cabang tetap bisa menghapus
pelunasan cabang itu; jalan naik = bandingkan daftar cabang yang terlihat akun sinkron dengan harapan sebelum menghapus. Balapan dua tanggal yang
dibaca bersamaan saat pelunasan dipindah tanggal di Accurate dalam milidetik yang sama bisa meninggalkan satu baris basi sampai putaran berikut.
`sesiSinkron` menyalin pemilihan user `resolveSyncCredentials` (ubah keduanya bersama). Satu pelunasan bisa punya dua ember (`nominal_negatif` +
`jumlah_invoice_payment_beda`); penjelasan berkunci (pelunasan, sisa).

**TERBUKA**: K-2 (IT): crontab VPS (jadwal di bawah). K-1 dan K-3 sudah diputuskan owner (§6).

**Prasyarat deploy (IT, urut — feat/fiori BELUM di produksi)**: `docs/handover/DDL_K1A.sql` → `docs/handover/DDL_S7_2.sql` (entri migrate-pg
`principal_log` 0030 berjalan lebih dulu) → `docs/handover/DDL_K1B.sql`, semuanya sebagai role pemilik SEBELUM image (VERIFIKASI semua `ok`; baris
"prasyarat K1a" false = DDL_K1A belum jalan; baris "definisi persis" false = CHECK diubah/dilemahkan, atau tabel VERSI AWAL K1b — itu hanya pernah
ada di DB uji: `DROP TABLE kasir_pelunasan_baca` lalu jalankan ulang; ADD COLUMN di berkas = EXPAND kolom saja, CHECK tidak diperluas) → image →
`ACCURATE_SYNC_USER_ID` = akun
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

## 8. K2a — server Kasir: GET hari, setoran, jelaskan, Tutup/Buka (12 Okt 2026)

Keputusan: `scratch/fiori-intake/OWNER-ANSWERS-K1b-S7-1b-2026-10-12.md` (K2) + `OWNER-ANSWERS-S7-2026-10-10.md` (C8, Kasir, T1/T2).
Berkas: `lib/kasir/hari.ts` (muat + tulis, deps disuntik), `lib/kasir/bukti.ts` (berkas bukti transfer), route `app/api/kasir/route.ts` (GET),
`app/api/kasir/{setoran,jelaskan,tutup,buka}/route.ts` (POST), `app/api/kasir/bukti/route.ts` (GET unduh). Tanpa Accurate (cache K1b saja).
K2b (UI `/kasir`) boleh membangun mock `page.route` LANGSUNG dari bagian ini.

### 8.1 Aturan umum

- **Uang masuk & keluar = TEKS desimal**, titik desimal, maks. 2 desimal, tanpa pemisah ribuan, tanpa tanda: `"1250000"`, `"1250000.5"`.
  Keluar selalu `"1250000.00"` (`senKeTeks`). Isian manusia ("Rp 1.250.000") dinormalkan KLIEN (`parseLocaleNumber`) sebelum dikirim.
  Negatif / notasi e / pemisah ribuan / > 2 desimal / bukan teks -> 400 `INPUT_SALAH` + `field`. Server menghitung ulang dari DB; angka klien
  hanya PEMBANDING (bukan sumber).
- **Waktu** keluar = ISO UTC `…Z`; tampilan WITA urusan klien (`waktuWita`). **`tanggal`** = `YYYY-MM-DD`, tanggal yang ada, ≤ hari ini WITA
  (jam SERVER) -> selain itu 400 `INPUT_SALAH` `field: "tanggal"`. Hari Minggu TIDAK diblokir (`hari.hariKerja` hanya info).
- **Panjang teks** (Form Kasir, nomor BG, catatan, penjelasan, alasan) dihitung per CODE POINT sesudah trim (= `char_length` Postgres).
- **Bentuk galat**: `{ ok: false, kode, error, field?, alasan?, keadaan? }` — `error` = kalimat siap tampil (tanpa pesan DB mentah). 401/403 =
  bentuk bawaan `requirePermission` (`{ error: "Unauthorized" | "Forbidden" }`, tanpa `kode`). Sukses: `{ ok: true, … }`.
- **Serialisasi**: setiap tulis (setoran, jelaskan, tutup, buka, catat kunci otomatis) = SATU transaksi READ COMMITTED yang pernyataan
  pertamanya `pg_advisory_xact_lock(hashtextextended('kasir:' || tanggal, 0))`, lalu baca ulang event -> `statusHari`/`bolehDiubah` (jam server)
  -> hitung ulang dari DB -> INSERT. Tanpa UPDATE/DELETE tabel jejak. Tutup juga `SELECT … FROM kasir_pelunasan_baca … FOR SHARE` (klaim
  pembaca K1b menunggu sampai Tutup selesai; cache diam selama transaksi).
- **Kunci 20.00 WITA dicatat malas** (orkestrator 12 Okt, tanpa cron): aksi PERTAMA (GET atau POST apa pun) yang melihat hari terkunci
  otomatis (`statusHari.sebab = "otomatis_20"`: ≥ 20.00 WITA tanpa event, atau jendela buka sudah lewat) menyisipkan event `kunci`
  (`oleh = "sistem"`, snapshot = `snapshotHari` + `baca`) di transaksi terkunci — sekali walau serentak. POST yang menabrak kunci tetap
  MENYIMPAN baris kunci itu lalu menjawab 409 `HARI_TERKUNCI`. Dilewati (dicoba lagi aksi berikutnya) bila sesi sinkron tanpa database ATAU
  status baca tanggal itu `belum_dibaca` (mis. GET 1900-01-01: tanpa baris kunci bersnapshot nol) —
  kunci tidak bergantung pada baris itu. Gagal mencatat tidak menggagalkan GET.

### 8.2 Kode HTTP — mana yang PASTI

| HTTP | `kode` | Arti | Hasil tulis |
|---|---|---|---|
| 400 | `INPUT_SALAH` (+ `field`) | isian tidak sah (lihat tiap route) | pasti TIDAK tersimpan |
| 401 / 403 | — (bawaan) | tanpa sesi / tanpa kunci izin | pasti TIDAK tersimpan |
| 404 | `TIDAK_ADA` | (GET bukti) baris/berkas bukti tidak ada | — |
| 413 | `BADAN_TERLALU_BESAR` | (setoran) badan > 6 MB: `content-length` > 6 MB ditolak tanpa membaca; badan TANPA `content-length` (chunked) dibaca bertahap dan diputus begitu melewati 6 MB | pasti TIDAK tersimpan |
| 409 | `SETORAN_BERUBAH` | `dasar` ≠ revisi terakhir sekarang (klik ganda / pengguna lain) | pasti TIDAK tersimpan |
| 409 | `ANGKA_BERUBAH` | angka/sidik klien ≠ hitungan server sekarang | pasti TIDAK tersimpan |
| 409 | `TIDAK_PERLU_DIJELASKAN` | baris klop / ember tidak ada lagi | pasti TIDAK tersimpan |
| 409 | `HARI_TERKUNCI` | hari terkunci (tutup / kunci / 20.00 WITA) | pasti TIDAK tersimpan (baris `kunci` sistem boleh tersimpan) |
| 409 | `TIDAK_TERKUNCI` | (buka) hari sedang terbuka | pasti TIDAK tersimpan |
| 409 | `BACA_BELUM_SEGAR` | (tutup) status baca ≠ `lengkap` atau `lengkap_pada` > 15 mnt | pasti TIDAK tersimpan |
| 409 | `TERHALANG` (+ `alasan[]`) | (tutup) masih ada selisih / tak teralokasi belum dijelaskan | pasti TIDAK tersimpan |
| 409 | `NOMINAL_DI_LUAR_BATAS` | (setoran) total setoran hari + kiriman ini > Rp 10 triliun (`keadaan: { batasHari, totalHariLain }`) | pasti TIDAK tersimpan |
| 422 | `ANGKA_TIDAK_SAH` | angka TERSIMPAN (setoran / cache pelunasan) di luar batas aman — hari tak bisa dihitung (GET/tulis), minta IT | pasti TIDAK tersimpan |
| 500 | `GALAT_INTERNAL` | galat SEBELUM commit (transaksi dibatalkan) | pasti TIDAK tersimpan |
| 502 | `TIDAK_PASTI` | galat SAAT/SESUDAH commit (mis. koneksi putus di COMMIT) | **TIDAK PASTI** |
| 503 | `SESI_SINKRON` | sesi Accurate akun sinkron tanpa database (jelaskan, tutup) | pasti TIDAK tersimpan |

**Aturan klien (K2b)** — jawaban PASTI = HTTP < 500, ATAU HTTP ≥ 500 dengan badan JSON ber-`kode` `GALAT_INTERNAL` / `SESI_SINKRON` (route Kasir
di atas) dan `BACA_GAGAL` (502) / `SESI_SINKRON` (503) dari `POST /api/kasir/segarkan` (§7, baca-saja). **TIDAK PASTI** = koneksi putus /
abort / timeout, badan bukan JSON (halaman proxy), `kode: "TIDAK_PASTI"`, atau ≥ 500 tanpa `kode` yang dikenal -> tampil "hasilnya belum
pasti", muat ulang GET lalu bandingkan revisi terakhir / penjelasan terakhir / event terakhir, TANPA ulang otomatis. (`tulis()`
`principal-order/bersama.ts` menganggap SEMUA ≥ 502 tidak pasti — JANGAN dipakai apa adanya untuk Kasir.) Setiap 409 membawa `keadaan`
terbaru (lihat route) — klien memperbarui tampilan dari situ atau muat ulang.

**Klik ganda / ulang** (server, bukan hanya tombol nonaktif): setoran -> POST kedua ber-`dasar` sama = 409 `SETORAN_BERUBAH` (satu revisi;
klien membandingkan `keadaan.setoranPerKode` dengan yang dikirim); jelaskan identik dengan penjelasan terakhir yang masih berlaku (angka +
teks + tindak lanjut sama) = 200 `{ ok: true, sudahAda: true }` tanpa baris kedua; tutup saat event terakhir `tutup` = 200 `{ ok: true,
sudahDitutup: true }`; buka kedua = 409 `TIDAK_TERKUNCI` + `keadaan.hari.kunciBerikutnya`.

### 8.3 `GET /api/kasir?tanggal=&orang=` (`kasir.view`, TANPA Accurate)

Membaca satu snapshot (REPEATABLE READ, baca-saja) dari cache K1b database sinkron + tabel jejak. `orang=` (kode) menambah `rincian`.

```
{ ok: true, tanggal, sekarang,
  hari: { terkunci, sebab: "tutup"|"kunci"|"otomatis_20"|null, kunciBerikutnya: ISO|null, bolehDiubah, hariKerja,
          berubahSejakDitutup: boolean|null,              // angka sekarang ≠ snapshot event tutup/kunci TERAKHIR; null = tak ada event / Incaso tak lengkap
          event: [{ id, jenis: "tutup"|"kunci"|"buka", alasan|null, oleh: <nama>|"Sistem", pada }] },   // urut id
  baca: StatusPublik|null,                                // §7 publikkan(); null = SESI_SINKRON
  segarUntukTutup: boolean,                               // lengkap ∧ lengkap_pada ≤ 15 mnt (jam server)
  incaso: { lengkap: boolean, sebab: null|"SESI_SINKRON"|"BACA_BELUM_LENGKAP", pesan: string|null },
  total: { pelunasan|null, setoran, selisih|null, takTeralokasi|null, takTeralokasiBelumDijelaskan: number|null, nonKas|null,
           klop: number|null, jumlahOrang: number },
  orang: [{ orang: "<kode kanonik>"|"" (Tanpa salesman), nama, kode: string[],
            pelunasan|null, pelunasanPerMetode: { CASH_OTHER?, BANK_TRANSFER?, BANK_CHEQUE? }|null, jumlahFaktur: number|null,
            setoran: { tunai, transfer, giro, total }|null,      // null = belum ada setoran; "0.00" tercatat ≠ null
            dasar: [{ kode, revisi }],                           // KIRIM BALIK apa adanya di POST setoran
            setoranPerKode: [{ kode, revisi, tunai, transfer, giro, total }],
            setoranTerakhir: { id, kode, revisi, noFormKasir, buktiUrl|null, giroNomor, giroJatuhTempo, catatan, oleh, pada }|null,  // revisi terakhir kode utama (= dasar buktiLama); belum ada -> revisi terbaru kode lain
            selisih|null, status: "klop"|"selisih"|"belum_setor"|"setoran_tanpa_pelunasan"|null, dijelaskan: boolean|null,
            salesmanIdTakDikenal: number[]|null }],              // urut kode, Tanpa salesman terakhir
  takTeralokasi: [{ pelunasanId, nomor, metode, chequeAmount, jumlahInvoicePayment, sisa, arah: "lebih_bayar"|"kredit",
                    alasan: "jumlah_invoice_payment_beda"|"tanpa_baris_faktur"|"metode_tak_dikenal"|"nominal_negatif",
                    orang: [{ orang, nama }], dijelaskan }]|null,
  nonKas: [{ pelunasanId, nomor, metode, chequeAmount }]|null,
  penghalangTutup: { bisaDitutup, alasan: string[] }|null,
  sidik: string|null,                                     // sidik angka hari + metode + revisi setoran (kirim di POST tutup); null bila Incaso tak lengkap
  riwayat: { setoran: [{ id, kode, orang, revisi, tunai, transfer, giro, total, noFormKasir, buktiUrl|null, giroNomor, giroJatuhTempo,
                         catatan, oleh, pada }],          // SEMUA revisi hari itu, urut kode lalu revisi
             penjelasan: [{ id, jenis: "selisih", orang, pelunasan, setoran, penjelasan, tindakLanjut, oleh, pada, berlaku: boolean|null }
                        | { id, jenis: "tak_teralokasi", pelunasanId, sisa, penjelasan, oleh, pada, berlaku: boolean|null }] },
  pegawai: [{ kode, orang, nama }],                       // accurate_employee salesman ∧ ¬suspended (pilihan "setoran tanpa pelunasan")
  rincian?: { orang, pelunasan: [{ pelunasanId, nomor, metode, chequeAmount, bagian,
                                   faktur: [{ fakturId, nomorFaktur, invoicePayment }] }] } | null }   // hanya bila ?orang= ∧ Incaso lengkap
```

- **Angka Incaso hanya bila status baca `lengkap`** (umur bebas; Tutup yang menuntut ≤ 15 mnt): selain itu `pelunasan`, `pelunasanPerMetode`,
  `jumlahFaktur`, `selisih`, `status`, `dijelaskan`, `salesmanIdTakDikenal`, `total.pelunasan/selisih/takTeralokasi/nonKas/klop`,
  `takTeralokasi`, `nonKas`, `penghalangTutup`, `sidik`, `berubahSejakDitutup`, `riwayat.penjelasan[].berlaku`, `rincian` = `null` dan
  `incaso.sebab` terisi (Incaso "belum terbaca", BUKAN 0). Setoran (`setoran`, `dasar`, `setoranPerKode`, `setoranTerakhir`, `total.setoran`,
  `riwayat.setoran`) SELALU ada. Sesi sinkron tanpa database -> `baca: null`, `incaso.sebab: "SESI_SINKRON"` (GET tetap 200).
- Baris orang = setiap orang yang punya pelunasan di cache ATAU setoran (dengan angka Incaso `null` bila tak lengkap).
- `buktiUrl` = `/api/kasir/bukti?id=<kasir_setoran.id>`. Nama/pencatat = nama user (`"(akun tak dikenal)"` bila tidak ada).
- Galat: 400 `INPUT_SALAH` (`field: "tanggal"`, atau `"orang"` > 100 huruf), 500 `GALAT_INTERNAL`. `orang=` yang tak dikenal -> `rincian.pelunasan: []`.

### 8.4 `POST /api/kasir/setoran` (`kasir.catat`)

Badan `application/json`, ATAU `multipart/form-data` dengan bagian `data` (teks JSON, bentuk sama) + bagian berkas `bukti`:

```
{ tanggal, orang, tunai, transfer, giro, noFormKasir?, giroNomor?, giroJatuhTempo?, buktiLama?: true, catatan?, dasar: [{ kode, revisi }] }
```

- `orang` = kode (dilipat ke kode kanonik lewat `sales_code_merge` bulan itu); BUKAN Tanpa salesman (`""`); harus dikenal (nomor
  `accurate_employee` atau kode setoran hari itu) -> selain itu 400 `field: "orang"`.
- `tunai`/`transfer`/`giro` WAJIB teks (aturan §8.1), masing-masing ≤ Rp 100.000.000.000 (400). **`noFormKasir` WAJIB bila total > 0** (1–100 huruf); setoran 0 tidak wajib.
- **Transfer > 0 -> bukti WAJIB**: berkas `bukti` baru (jpg/png/pdf, dicek MAGIC BYTES — JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, PDF
  `%PDF-` — bukan ekstensi/`type`; ≤ 5 MB) ATAU `buktiLama: true` = pakai berkas revisi terakhir kode
  utama, hanya bila revisi itu punya bukti DAN transfernya sama. Transfer 0 + berkas/`buktiLama` -> 400. `field: "buktiTransfer"`.
- **Giro > 0 -> `giroNomor` (nomor BG, 1–100 huruf) + `giroJatuhTempo` (`YYYY-MM-DD`, antara tanggal setoran − 7 hari dan tanggal yang sama
  tahun depan, inklusif) WAJIB**; giro 0 + salah satunya -> 400.
- `catatan` ≤ 500 huruf (opsional). `dasar` = larik `{ kode, revisi }` dari GET (`[]` untuk setoran pertama) -> ≠ revisi terakhir sekarang
  (sebagai himpunan) = 409 `SETORAN_BERUBAH`, `keadaan: { orang, dasar, setoranPerKode, setoran }`.
- Hari terkunci -> 409 `HARI_TERKUNCI`, `keadaan: { hari }`. TIDAK bergantung status baca (setoran tetap bisa saat Accurate gagal).
- Tulis = `rencanaSetoranOrang` -> SEMUA baris dalam SATU transaksi: kode utama = revisi baru bernominal baru (+ Form Kasir, bukti, giro,
  catatan); rantai kode lain milik orang itu yang ≠ 0 = revisi baru bernilai 0 (catatan otomatis). 23505 -> 409 `SETORAN_BERUBAH`.
- 200 `{ ok: true, orang, revisi: [{ kode, revisi }], buktiUrl: string|null }`.

**Berkas bukti**: disimpan di volume data frontend `data/uploads/kasir-bukti/<uuid>.<jpg|pdf>` (mekanisme sama dengan foto Form
Kontrol, `/app/data` = volume `accapi_frontend_data`). **Gambar (jpg/png) di-encode ulang** dengan sharp: orientasi diterapkan, SEMUA metadata
(EXIF/GPS) dan muatan polyglot terbuang, sisi terpanjang ≤ 2000 px (tanpa memperbesar), JPEG kualitas 80 -> selalu `.jpg`; gambar tak terbaca
-> 400 `buktiTransfer`. PDF disimpan apa adanya. Nama dibuat SERVER (`randomUUID`), ditulis eksklusif (`wx`) SEBELUM transaksi, namanya
disimpan di `kasir_setoran.bukti_transfer`. Galat PASTI (400/409/413/422/500) -> berkas dihapus (gagal hapus selain ENOENT dicatat log);
`TIDAK_PASTI` -> dibiarkan (yatim, tak terjangkau). Tidak pernah ditimpa/dihapus sesudahnya (koreksi = revisi baru + berkas baru atau
`buktiLama`); cron `cleanup-uploads` hanya menyentuh `form-kontrol` (retensi bukti = permanen, cadangan = volume data).
`GET /api/kasir/bukti?id=<kasir_setoran.id>` (`kasir.view`): berkas tersimpan, `Content-Type` dari jenis tersimpan, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store`; gambar `inline`, PDF `attachment`; nama unduhan
`bukti-<tanggal>-<kode>-r<revisi>.<ext>`. Path dari DB (pola UUID ketat + `basename`), tak pernah dari input pengguna. 400 `INPUT_SALAH` (id),
404 `TIDAK_ADA` (baris/berkas tidak ada), 500 `GALAT_INTERNAL` (galat baca selain ENOENT — dicatat, bukan 404 diam).

### 8.5 `POST /api/kasir/jelaskan` (`kasir.catat`)

```
{ tanggal, jenis: "selisih", orang, angka: { pelunasan, setoran }, penjelasan, tindakLanjut: "setor_susulan"|"koreksi_incaso"|"lapor_om" }
{ tanggal, jenis: "tak_teralokasi", pelunasanId, angka: { sisa }, penjelasan }
```

- TIDAK mensyaratkan status `lengkap` (orkestrator 12 Okt): server menghitung ulang dari cache SEKARANG; penjelasan berkunci ANGKA, jadi angka
  yang berubah sesudahnya otomatis membuat penjelasan tak berlaku (Tutup menuntut `lengkap` ≤ 15 mnt). Butuh database sinkron -> 503
  `SESI_SINKRON`.
- `penjelasan` 15–1000 huruf (sesudah trim) -> selain itu 400 `field: "penjelasan"`. `tindakLanjut` wajib untuk `selisih`. `orang` `""` =
  Tanpa salesman (boleh dijelaskan). `angka.setoran` untuk belum setor = `"0"`.
- Selisih: baris orang tak ada / `klop` -> 409 `TIDAK_PERLU_DIJELASKAN`; angka ≠ -> 409 `ANGKA_BERUBAH`, `keadaan: { angka: { pelunasan,
  setoran }, status }`. Ember: tak ada ember untuk `pelunasanId` -> 409 `TIDAK_PERLU_DIJELASKAN`; ada tetapi `sisa` beda -> 409
  `ANGKA_BERUBAH`, `keadaan: { angka: { sisa: [..] } }`. Identik dengan penjelasan terakhir yang berlaku -> 200 `sudahAda`.
- Hari terkunci -> 409 `HARI_TERKUNCI`. 200 `{ ok: true, id }` | `{ ok: true, sudahAda: true }`.

### 8.6 `POST /api/kasir/tutup` (`kasir.tutup`)

`{ tanggal, sidik }`. Urutan: event terakhir `tutup` -> 200 `{ ok: true, sudahDitutup: true }`; terkunci (kunci/20.00) -> 409 `HARI_TERKUNCI`;
tanpa database sinkron -> 503 `SESI_SINKRON`; status baca (FOR SHARE) bukan `lengkap` atau `lengkap_pada` > 15 mnt -> 409 `BACA_BELUM_SEGAR`
(`keadaan: { baca, segarUntukTutup: false }` — klien segarkan berjeda ≥ 6 dtk lalu muat ulang); `penghalangTutup` -> 409 `TERHALANG` +
`alasan[]`; `sidik` ≠ -> 409 `ANGKA_BERUBAH` (`keadaan: { sidik }`). INSERT event `tutup`, snapshot = `snapshotHari` + `baca: { status,
lengkapPada, jumlahDaftar, akun }` (CHECK `kasir_hari_event_tutup_tuntas` = jaring kedua; 23514 -> 409 `TERHALANG`). Pelunasan DITOLAK
pembaca -> status tak pernah `lengkap` -> Tutup terhalang (K-3, tanpa jalan jelaskan). 200 `{ ok: true, event: { id, pada } }`.

### 8.7 `POST /api/kasir/buka` (`kasir.buka`, OM/Admin)

`{ tanggal, alasan }`; `alasan` 15–1000 huruf -> selain itu 400 `field: "alasan"`. Hari tidak terkunci -> 409 `TIDAK_TERKUNCI` (`keadaan:
{ hari }`). INSERT event `buka` (hari otomatis terkunci lagi 20.00 WITA berikutnya sesudah waktu buka, T1). 200 `{ ok: true, kunciBerikutnya }`.

### 8.8 DDL K2a (owner: Giro wajib nomor BG + jatuh tempo)

`kasir_setoran.giro_nomor text` (CHECK tidak hanya spasi) + `giro_jatuh_tempo date`, nullable. Aturan owner JUGA di DB (keputusan orkestrator
sesudah tinjauan B; tabel kosong sampai K2a): CHECK `kasir_setoran_giro_wajib` (giro > 0 -> nomor BG + jatuh tempo), `kasir_setoran_bukti_wajib`
(transfer > 0 -> `bukti_transfer`), `kasir_setoran_form_wajib` (nominal > 0 -> `no_form_kasir`) — server menegakkannya lebih dulu (400 berkode);
mengubah keputusan ini kini butuh DDL. `docs/handover/DDL_K2A.sql` (pemilik, SESUDAH DDL_K1B, SEBELUM image; VERIFIKASI definisi persis) =
entri migrate-pg `kasir_setoran giro (K2a)` (sudahAda lewat katalog, juga tanpa hak tabel) = `db/migrations/0032_kasir_setoran_giro.sql` =
Drizzle. Tanpa env baru.

### 8.9 Prasyarat deploy K2 (IT, urut) + plafon

1. `DDL_K1A.sql` -> `DDL_S7_2.sql` -> `DDL_K1B.sql` -> **`DDL_K2A.sql`** sebagai role pemilik, SEBELUM image (VERIFIKASI semua `ok`; NULL = role
   `accapi_app` tidak ada). Tanpa DDL_K2A, migrate-pg (accapi_app, bukan pemilik) gagal ALTER -> crash loop.
2. Image (K1b + K2a [+ K2b]). Direktori `data/uploads/kasir-bukti` dibuat otomatis di volume `accapi_frontend_data` (`/app/data`, ditulis frontend).
3. `RBAC_PRESET_BL37.sql` -> `RBAC_PRESET_KASIR.sql` (Kasir: view/catat/tutup; OM & Admin: view/buka). `ACCURATE_SYNC_USER_ID` + crontab K-2 (§7).

Plafon (ponytail): kunci 20.00 dicatat malas -> snapshot `kunci` mencerminkan cache SAAT aksi pertama sesudah 20.00 (cron K1b masih jalan s/d
21.00), bukan tepat 20.00 — setoran tetap tak bisa berubah sesudah 20.00 (kunci dihitung dari jam); jalan naik = cron 20.00 yang memanggil GET.
Berkas bukti di volume satu instance (pola Form Kontrol): multi-instance / cadangan terpisah -> kolom bytea + DDL. Berkas yatim dari jawaban
`TIDAK_PASTI` tidak dibersihkan otomatis (tak terjangkau; nama UUID).
