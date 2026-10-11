# Kontrak Kasir ↔ Incaso (K1a, BL-59) — tabel + lib murni untuk K1b / K2 / K3

Sumber keputusan: `scratch/fiori-intake/OWNER-ANSWERS-S7-2026-10-10.md` (C8 + Kasir 11 Okt), bukti `KASIR-BUKTI-PROBE-2026-10-11.md`,
eksplorasi `KASIR-EKSPLORASI-2026-10-11.md` §4–§5. Zona AGENTS §3: uang + skema.

## 1. Aturan (owner 11 Okt)

| Aturan | Isi | Di mana |
|---|---|---|
| Kolektor | salesman FAKTUR = `detailInvoice[].invoice.masterSalesmanId` | `alokasiPelunasan` |
| Uang Incaso | `chequeAmount` pelunasan (Tunai `CASH_OTHER` + Transfer `BANK_TRANSFER` + Giro `BANK_CHEQUE`); metode `OTHERS` (retur/ayat silang) DIKELUARKAN (`nonKas`, info) | `alokasiPelunasan` |
| Bagi per salesman | per baris faktur `invoicePayment`; Σ invoicePayment ≠ chequeAmount -> selisih (`sisa`, bisa negatif) ke ember **tak teralokasi** per pelunasan + `alasan` (`jumlah_invoice_payment_beda` / `tanpa_baris_faktur`) — TIDAK dibagi diam-diam. Invarian: Σ bagian + Σ sisa = Σ chequeAmount | `alokasiPelunasan` |
| Orang | id -> `accurate_employee.number` (kode) -> `sales_code_merge` (`decision='merge'`, bulan = bulan `tanggal`, rantai diikuti) -> ORANG; kode tanpa gabungan = orang sendiri; id null / tanpa kode -> `TANPA_SALESMAN` (`""`, baris terlihat + `salesmanIdTakDikenal`) | `orangDariSalesmanId`, `orangDariKode` |
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
- `alokasiPelunasan(Pelunasan[]) -> { bagian: BagianSalesman[], takTeralokasi: TakTeralokasi[], nonKas: Pelunasan[] }` (id pelunasan ganda = galat).
- `rekonsiliasiHari({ tanggal, pelunasan, setoran: SetoranRevisi[], catatan?: CatatanSelisih[], catatanTakTeralokasi?: { pelunasanId, sisa }[], peta: PetaOrang }) -> HasilRekonsiliasi`
  `{ tanggal, baris: BarisOrang[] (urut kode, Tanpa salesman terakhir), takTeralokasi: (TakTeralokasi & { dijelaskan })[], nonKas, total: { pelunasan, setoran, takTeralokasi, nonKas } }`.
  `catatanTakTeralokasi` = baris `kasir_tak_teralokasi_catatan` yang SUDAH disaring ke `database_id` yang dibaca.
  `BarisOrang = { orang, kode[], pelunasan, pelunasanPerMetode{metode->sen}, jumlahFaktur, setoran: {tunai,transfer,giro,total}|null, selisih|null, status, dijelaskan, salesmanIdTakDikenal[] }`.
  Pelunasan lain tanggal / revisi setoran ganda = galat pemanggil.
- `PetaOrang = { kodeSalesman: Map<id, number>, gabunganPerBulan: Map<"YYYY-MM", Map<from, to>> }` — dibangun pemanggil dari `accurate_employee` + `sales_code_merge`.
- `penghalangTutup(hasil) -> { bisaDitutup, alasan: string[], baris: BarisOrang[], takTeralokasi[] }` (alasan urut: orang, lalu ember; contoh
  "Uang tak teralokasi SR/2610/5 belum dijelaskan: Rp 100.000 (pelunasan Rp 1.000.000, faktur Rp 900.000).").
- `snapshotHari(hasil)` (JSON murni, `versi: 1`: `total`, `baris[]`, `takTeralokasi[]` {pelunasanId, nomor, sisa, alasan, dijelaskan}, `terhalang` = alasan
  penghalang) — disimpan di `kasir_hari_event.snapshot`; beda dengan snapshot baru = "berubah sejak ditutup".
- `statusHari(tanggal, EventHari[], sekarang) -> { terkunci, sebab: tutup|kunci|otomatis_20|null, kunciBerikutnya }`, `bolehDiubah(...)`, `batasKunci(tanggal)`, `hariKerja(tanggal)`.

## 3. Tabel (db/schema.ts; SQL = migrate-pg = `db/migrations/0029_kasir.sql` = `docs/handover/DDL_K1A.sql`)

| Tabel | Sifat | Kolom inti | Kendala |
|---|---|---|---|
| `kasir_setoran` | append-only (trigger + REVOKE di DDL) | `tanggal date`, `salesman_kode` (kode ORANG saat dicatat), `revisi`, `revisi_sebelumnya`, `tunai/transfer/giro numeric(18,2)` (wajib, tanpa default), `no_form_kasir`, `bukti_transfer`, `catatan`, `dicatat_oleh`, `dicatat_pada` | unik `(tanggal, salesman_kode, revisi)` (dobel-klik/balapan -> 23505 -> 409); FK `(tanggal, kode, revisi_sebelumnya)` -> revisi n; `revisi_sebelumnya = revisi − 1` (NULL hanya revisi 1); nominal ≥ 0; kode tidak kosong & tanpa spasi tepi; teks opsional tidak boleh hanya spasi |
| `kasir_selisih_catatan` | append-only | `tanggal`, `salesman_kode` (`''` = Tanpa salesman), `pelunasan`, `setoran` (angka saat dijelaskan), `penjelasan` (≥ 15), `tindak_lanjut` (`setor_susulan`/`koreksi_incaso`/`lapor_om`), `dicatat_oleh/pada` | setoran ≥ 0 |
| `kasir_hari_event` | append-only | `tanggal`, `jenis` (`tutup`/`kunci`/`buka`), `alasan`, `snapshot jsonb`, `oleh`, `pada` | buka: alasan ≥ 15 (NULL ditolak) & tanpa snapshot; tutup/kunci: snapshot objek wajib; **tutup: `snapshot.terhalang` wajib `[]`** (kunci boleh terhalang) |
| `kasir_tak_teralokasi_catatan` | append-only | `tanggal`, `database_id`, `pelunasan_id`, `sisa` (angka saat dijelaskan; berubah = tidak berlaku), `penjelasan` (≥ 15), `dicatat_oleh/pada` | sisa ≠ 0; TANPA FK ke cache (cache boleh dibaca ulang/dihapus, penjelasan tetap) |
| `kasir_pelunasan` | cache (upsert/hapus oleh K1b) | PK `(database_id, pelunasan_id)`, `nomor`, `tanggal` (transDate), `metode`, `cheque_amount`, `last_update` (teks Accurate apa adanya), `dibaca_pada` | indeks `(database_id, tanggal)`; TANPA raw_data |
| `kasir_pelunasan_faktur` | cache | PK `(database_id, pelunasan_id, faktur_id)`, `nomor_faktur`, `master_salesman_id`, `invoice_payment` | FK ke kepala ON DELETE CASCADE |

Penyimpangan dari usulan §4 eksplorasi: setoran SATU baris per revisi berisi tiga kolom metode (owner: per ORANG, dialog Tunai/Transfer/Giro)
alih-alih satu baris per metode; penunjuk revisi = FK komposit `revisi_sebelumnya` (rantai dijamin DB, tanpa trigger); penjelasan menyimpan
ANGKA, bukan hash `sidik`; cache dipecah kepala + baris (brief) dengan `nomor_faktur` opsional; `customer_no`/`payment_amount`/`discount_total`/
`salesman_sumber` tidak disimpan (tidak dipakai rekonsiliasi). `database_id` hanya di cache + penjelasan tak teralokasi (id Accurate unik per
database). Penjelasan tak teralokasi = TABEL SENDIRI, bukan perluasan `kasir_selisih_catatan`: kuncinya pelunasan (bukan orang) dan angkanya `sisa`
(bukan pelunasan/setoran) — memperluas tabel lama butuh kolom bersyarat + CHECK bersyarat; tabel kecil terpisah CHECK-nya sederhana.

## 4. Kewajiban pemakai

- **Semua penulis uang** lewat `keSen` -> `senKeTeks`: `numeric(18,2)` membulatkan > 2 desimal DIAM-DIAM (diuji).
- **K1b**: tulis cache hanya dari pembaca sistem (`resolveSyncCredentials`); nominal Accurate lewat `keSen` — pelunasan yang ditolak = galat terlihat,
  bukan dilewati; hapus kepala yang hilang di Accurate (baris ikut terhapus). Status "cache tanggal D lengkap/terpotong" BELUM ada tabelnya — K1b
  memutuskan (jangan tampilkan total sebagian sebagai lengkap; Tutup butuh pembacaan sukses terbaru, spec it11 Galat).
- **K2**: `requirePermission` `kasir.view` (GET), `kasir.catat` (setoran + jelaskan), `kasir.tutup`, `kasir.buka` (alasan ≥ 15). Sebelum menulis setoran/
  penjelasan/tutup: `bolehDiubah` (dan untuk tutup: `penghalangTutup(...).bisaDitutup`, snapshot dari `snapshotHari`) di DALAM transaksi yang sama dengan INSERT, diserialkan per tanggal (mis. `pg_advisory_xact_lock(hashtext('kasir:'||tanggal))`)
  agar Tutup dan Catat tidak berbalapan. Revisi baru = `max(revisi)+1` dengan `revisi_sebelumnya`; 23505 -> 409. Spec it11: Nomor Form Kasir wajib dan
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

## 6. Keputusan owner 11 Okt (dulu TERBUKA)

- **T1** Sesudah buka kembali: terkunci ulang otomatis **20.00 WITA berikutnya** (perilaku lib; uji `kunci hari T1`).
- **T2** Uang tak teralokasi **WAJIB dijelaskan sebelum Tutup** (uji lib `T2` + uji PG CHECK `tutup_tuntas`); kunci otomatis tetap mengunci dan snapshot-nya
  mencatat yang belum dijelaskan.
