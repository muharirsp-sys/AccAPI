# Kontrak API principal resmi (S7-2, BL-64) — untuk S7b "Data principal"

Server: `app/api/principals/**` → logika `lib/principal/tulis.ts`. Normalizer baku `lib/principal/normalisasi.ts`, resolver
`lib/principal/resolver.ts`. Skema: `principal`, `principal_variant`, `principal_alias` (S7-0) + `principal_log` (S7-2).
Prasyarat deploy: `docs/handover/DDL_S7_0.sql` lalu `docs/handover/DDL_S7_2.sql` (role `accapi`, SEBELUM image).

## Aturan bersama

- Semua jawaban JSON. Sukses: `{ ok: true, ... }`. Gagal: `{ ok: false, code, error, ...detail }` — UI menampilkan `error`,
  bercabang pada `code`. Galat baca = `500 GAGAL` / `503 …`, **tidak pernah** daftar kosong.
- 401 tanpa sesi; 403 `{ error: "Forbidden" }` tanpa izin (pola `requirePermission`).
- Izin: baca `principles.view`; tulis `principles.upload`; hapus alias `principles.delete` (kunci registry yang sudah ada).
- Setiap tulis = SATU transaksi + baris `principal_log` (aktor = id user sesi). Tak ada yang menimpa: bentrok = 409 berkode.
- **503 `PRINCIPAL_DDL_BELUM`** `{ kurang: string[] }` — trigger penjaga (`trg_principal_code_tetap`,
  `trg_principal_log_append_only`, `trg_principal_log_no_truncate`) tidak ada/nonaktif; tidak ada yang ditulis. UI: "Hubungi IT
  Support". `503 PRINCIPAL_SKEMA_BELUM` = tabel belum ada.
- `code` principal **tidak bisa diubah** (tanpa jalur ubah; trigger DB menolak juga). Kode salah = buat principal baru +
  nonaktifkan yang lama. Nama resmi juga belum punya jalur ubah (TERBUKA).
- `alias_norm` selalu dihitung server dengan normalizer baku: NFKC, huruf besar, semua spasi Unicode/kendali → satu spasi, trim,
  karakter format tak terlihat dibuang; **tanda baca tetap** (`PT.`, koma, `**` OCR). Client tidak pernah mengirim `aliasNorm`.
- `variantKey`: tidak dikirim / `null` = principal **utuh**; `""` **persis** = varian dasar (hanya bila principal punya varian
  lain); selain itu `^[A-Z0-9_-]{1,20}$` sesudah dirapikan (huruf kecil dinaikkan; spasi di tengah ditolak — pakai `NON_FOOD`).
  Teks yang kosong SESUDAH dirapikan (`"   "`, lebar-nol) = 400 `VARIAN_TIDAK_SAH` — tidak pernah diam-diam jadi varian dasar.
- `jenis` wajib teks (array/objek = 400 `JENIS_TIDAK_SAH`).

## GET `/api/principals` (principles.view)

`200 { ok, principals: Principal[] }` — satu snapshot baca-saja, urut `code`.

```
Principal = { id, code, name, isActive, createdBy, createdAt, updatedBy, updatedAt,
              variants: { principalId, variantKey, name, isActive, createdBy, createdAt }[],      // urut variantKey
              aliases:  { id, aliasNorm, principalId, variantKey, aliasAsli, jenis, sumber, createdBy, createdAt }[] }
```
`jenis` ∈ `nama | kode_master_barang | label_mapping | nama_bank | nama_summary | nama_surat`. Alias `sumber = "kode_principal"`
= alias kode (dibuat bersama principal, tidak bisa dihapus — tampilkan tanpa tombol hapus).

## POST `/api/principals` (principles.upload) — buat principal

Body `{ code, name }`. `201 { ok, principal, aliases }` — principal + alias kode (`kode_principal`) + alias nama resmi
(`nama_resmi`, bila bentuk normalnya ≠ kode). 400 `BODY_TIDAK_SAH | KODE_TIDAK_SAH | TIDAK_SAH` (nama kosong/ > 200).
409 `KODE_SUDAH_ADA { principalId }`; 409 `ALIAS_TABRAKAN { pemilik: { principalId, code, variantKey, jenis, aliasAsli } }` bila
kode/nama sudah jadi alias principal lain (tidak ada yang dibuat).

## PATCH `/api/principals/{id}` (principles.upload) — aktif/nonaktif

Body **hanya** `{ isActive: boolean }`. `200 { ok, principal, berubah }` (`berubah:false` = status sama, tanpa riwayat).
400 `KODE_TETAP` bila body memuat `code`; 400 `FIELD_TIDAK_DIDUKUNG` untuk kunci lain; 400 `TIDAK_SAH`; 404 `PRINCIPAL_TIDAK_ADA`.
Nonaktif tidak menghapus varian/alias; resolver menandai `aktif:false`.

## POST `/api/principals/{id}/variants` (principles.upload) — tambah varian

Body `{ variantKey, name? }`. `201 { ok, variant, aliases }` (nama varian ikut jadi alias `nama_varian` bila diisi).
400 `VARIAN_TIDAK_SAH`; 404 `PRINCIPAL_TIDAK_ADA`; 409 `PRINCIPAL_NONAKTIF | VARIAN_SUDAH_ADA | VARIAN_DASAR_TANPA_LAIN |
ALIAS_TABRAKAN | ALIAS_SUDAH_ADA`.

## PATCH `/api/principals/{id}/variants` (principles.upload) — aktif/nonaktif varian

Body **hanya** `{ variantKey, isActive }`. `200 { ok, variant, berubah }`. 400 `FIELD_TIDAK_DIDUKUNG | KODE_TETAP | VARIAN_TIDAK_SAH
| TIDAK_SAH`; 404 `VARIAN_TIDAK_ADA`.

## POST `/api/principals/{id}/aliases` (principles.upload) — tambah alias

Body `{ alias, jenis, sumber?, variantKey? }` (`sumber` bawaan `"manual"`, ≤ 200; `"kode_principal"` ditolak).
`201 { ok, alias }`. 400 `TIDAK_SAH | JENIS_TIDAK_SAH | KODE_MB_TIDAK_SAH` (`kode_master_barang` = tepat 2 huruf/angka) `|
SUMBER_KHUSUS | VARIAN_TIDAK_SAH`; 404 `PRINCIPAL_TIDAK_ADA | VARIAN_TIDAK_ADA`; 409 `PRINCIPAL_NONAKTIF | VARIAN_NONAKTIF`;
409 `ALIAS_SUDAH_ADA { pemilik }` (ejaan sudah alias principal/varian ini) / `ALIAS_TABRAKAN { pemilik? }` (milik principal lain —
tidak ditimpa; `pemilik` absen bila bentrok terjadi bersamaan). Keunikan per ruang: kode Master Barang terpisah dari semua jenis
lain ("MI" boleh kode MB principal X dan kode principal MI); di ruang nama satu ejaan = satu alias (jenis = asal ejaan).

## DELETE `/api/principals/{id}/aliases/{aliasId}` (principles.delete)

`200 { ok, alias }` (isi lama; tercatat di riwayat). 404 `ALIAS_TIDAK_ADA`; 409 `ALIAS_KODE_TETAP`.

## GET `/api/principals/{id}/history?sebelum=<id>&batas=<1..200>` (principles.view)

`200 { ok, riwayat: Log[], sebelum: number | null }` terbaru dulu; `sebelum` = kursor halaman berikutnya (null = habis).
404 `PRINCIPAL_TIDAK_ADA`.
```
Log = { id, entitas: "principal"|"varian"|"alias", kunci, principalId, aksi: "buat"|"aktif"|"nonaktif"|"hapus",
        before: object|null, after: object|null, aktor, waktu }
```
`kunci`: principal = id; varian = `"<principal_id>:<variant_key>"`; alias = id alias. Benih memakai aktor `benih:S7-2`.

## Resolver (pemakai S7-2b)

Server-side: `resolvePrincipal(teks, await muatIndeksAlias(), ruang)` — `ruang` WAJIB: `"nama"` (nama/label/kode OPC/surat/
bank/Summary = semua jenis kecuali kode MB) atau `"kode_master_barang"` (kode 2 karakter Master Barang). Tidak ada saringan
per-jenis (satu ejaan di ruang nama hanya punya satu jenis = asal ejaan) dan tidak ada bawaan: tanpa ruang, kode MB pendek ("GD")
akan ikut cocok di teks bebas. Hasil: `cocok { norm, principalId, code, variantKey, aktif, alias[] }` | `tak_dikenal { norm }` |
`ambigu { norm, kandidat[] }`. Lewat alias SAJA, tak pernah menebak; `aktif:false` = principal/varian nonaktif (pemakai memutuskan).

### GET `/api/principals/resolve?teks=<teks>&ruang=nama|kode_master_barang` (principles.view)

Untuk pemakai luar (Python tahap 2) agar SATU normalizer dipakai. `200 { ok, hasil }` (bentuk hasil di atas). 400 `RUANG_TIDAK_SAH`
(ruang absen/lain), `TEKS_KOSONG` (kosong sesudah dinormalkan), `TIDAK_SAH` (> 200 karakter).

## TERBUKA

- Izin: slice ini memakai `principles.upload` / `principles.delete` yang sudah ada. Kunci `principals.manage` untuk membuat /
  menonaktifkan principal resmi = keputusan owner / matriks D-01.
- Ganti nama resmi principal / nama varian: belum ada jalur.

## Runbook laporan + benih (produksi, BACA-SAJA lalu ditinjau owner)

1. Sesudah `DDL_S7_0.sql` + `DDL_S7_2.sql` (VERIFIKASI semua `ok`), dari checkout repo yang sudah `npm ci` dan punya akses jaringan
   ke Postgres produksi (mis. terowongan SSH ke VPS; sebaiknya role baca-saja):
   `DATABASE_URL=<url> npx tsx scripts/principal-laporan.mjs --keluar scratch/principal-laporan/prod-<tanggal>`
   Skrip memasang `default_transaction_read_only=on` + transaksi `REPEATABLE READ READ ONLY` dan berhenti bila sesi tidak baca-saja;
   URL tidak pernah dicetak. Keluar `2` = ada sumber GAGAL dibaca (lihat `laporan.md`, galat ≠ kosong) — jangan dipakai sebagai lengkap.
2. Owner meninjau `laporan.md` (matched / ambiguous / unmatched per sumber, KONFLIK registri) dan `benih.sql`: blok aktif = registri
   (25 principal OPC, varian K9 + HEINZ, alias kode/nama/label No Claim/nama varian) + kode Master Barang yang namanya cocok PERSIS;
   blok "PERIKSA" (cocok longgar) ber-komentar; ambiguous/unmatched hanya dicantumkan.
3. IT Support menjalankan `benih.sql` yang sudah disetujui: `docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < benih.sql`
   — idempoten (`ON CONFLICT DO NOTHING`, tanpa UPDATE), menolak berjalan tanpa trigger penjaga, VERIFIKASI di akhir (baris `false` di atas).
4. Jalankan laporan lagi: usulan principal/varian = 0, tanpa KONFLIK. Baru sesudah itu pemakai beralih (S7-2b).
