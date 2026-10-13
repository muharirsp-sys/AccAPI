# O1 — Kontrak server Order per cabang Accurate (untuk O2 UI)

Status: DRAFT O1 + putaran perbaikan 1 (12 Okt 2026), zona AGENTS §3 (sync Accurate, harga, jalur order → faktur) — 2 peninjau Opus sebelum
merge. Putaran 1 = `scratch/fiori-intake/O1-PERBAIKAN-PUTARAN1-2026-10-12.md` butir 1–15.
Keputusan owner (mengikat): `scratch/fiori-intake/OWNER-ANSWERS-ORDER-CABANG-2026-10-12.md`.

## 1. Aturan

| Aturan | Sumber | Di mana ditegakkan |
|---|---|---|
| Pelanggan cabang X hanya boleh dipesankan barang ber-cabang X | owner 12 Okt | `lib/order-cabang.ts periksaOrder` (pratinjau + simpan), pencarian barang |
| Cabang barang = tag divisi `item.charField2` → cabang (`TAG_KE_CABANG`: nama cabang persis; `24MNF1`/`21MNF2` → MIX NON FOOD; `FRN` → SHINZUI (revisi owner); `HEINZ ABC` → HEINZ; `MIX2` → DOLPHIN; `FKS` → MIX FOOD). Non-jual (ALAT TULIS KANTOR, ASSET, AMARON, LAKBAN BENING, PEMBELIAN ASET, PRINTER), tag kosong, tag tak dikenal → `item.branch_id` NULL = tak bisa diorder. Jawaban Accurate TANPA key `charField2` = cabang lama dipertahankan (butir 10) | owner 12 Okt | `lib/sync.ts` (item/list.do + webhook item) |
| Cabang salesman = `accurate_employee.branch_id` karyawan yang ditautkan ke akun | owner 12 Okt | `cakupanCabang` |
| Petugas internal (punya `order.view`: admin/fakturist/Order Masuk) = semua cabang; akun lain (sales: `websales.*` saja) = cabang karyawannya. Tripwire: `websales.create` + `order.view` TANPA `order.create` = `IZIN_TIDAK_KONSISTEN` (bukan semua cabang) | O1 (tafsir teknis) + butir 11 | `cakupanCabang`/`tripwireIzin`; DDL_O1 VERIFIKASI per grup |
| Pelanggan/barang suspended di Accurate tidak bisa diorder | brief O1 | sync (`suspended`) + `periksaOrder` + pencarian |
| Harga master = daftar harga Accurate (`tier`) cabang PELANGGAN (dibaca server), tanggal berlaku terbaru ≤ tanggal order; cabang pelanggan tanpa baris berlaku → cabang DEFAULT. Harga standar `item.unitPrice` (satu angka semua satuan), harga ≤ 0, harga cabang LAIN = TIDAK sah → `HARGA_BELUM_ADA` | lib/item-price + butir 3 | `hargaSah`: pratinjau, `/api/orders/harga`, pencarian barang (`price: null`); Python menolak ≤ 0 |
| Harga petugas (Order Baru, `order.create`) HANYA untuk baris TANPA harga master sah; baris berharga master + harga petugas = `HARGA_PETUGAS_TIDAK_DIIZINKAN`; harga petugas > 0, tercatat `sumber_harga: "petugas"`, tidak pernah ditimpa | butir 7 + owner sesi 13 | `putusanHarga` → `periksaOrder` (pratinjau + simpan), `order_cabang.periksa` meneruskan, §4.4 |
| Order Web Sales dibekukan BERHARGA saat ditarik (tidak lagi `needs_price`); faktur memakai harga beku | BL-18 | FastAPI `store_order` ← `/api/orders/harga` |
| Promo: pratinjau = tersimpan (`sidik`), satu fungsi hitung | owner 12 Okt (revisi) | §4 |
| Salesman faktur (Antre Faktur) = salesman cabang PELANGGAN order | butir 4 | `/api/orders/[id]/invoice` (`salesmanBedaCabang`), pratinjau + antre |
| Barang BONUS promo = syarat barang order (ada, tidak suspended, cabang = cabang pelanggan; non-jual/tanpa cabang = tidak) → gagal `BONUS_TIDAK_BISA_DIORDER`, order ditolak (bonus tidak dibuang) | putaran 2 butir 7 (orkestrator, aturan owner) | `alasanBonus`/`periksaBonus`: pratinjau sesudah promo + `/api/orders/harga` mode bonus (simpan + tarik) |
| Harga master dari cabang DEFAULT (fallback) bertanda `sumber_harga: "master_default"` / `hargaDefault: true` | putaran 2 butir 9 | `sumberHarga`; pratinjau, harga, pencarian barang, baris beku |
| Aturan terbit rusak (tidak lolos `Program`) = galat GLOBAL `ATURAN_TERBIT_RUSAK`, bukan penolakan order | putaran 2 butir 6 | `published_rules`, `pull_once` (diperiksa sekali sebelum menyentuh permintaan) |

Tautan akun ↔ karyawan disimpan di `sales_profile.sales_code` (= `accurate_employee.number`) + `sales_profile.accurate_linked` (tautan AKTIF;
bawaan false). Lepas = `accurate_linked` false — baris, kode, dan hierarki Form Kontrol tetap (butir 12). `sales_profile.accurate_branch_id`
TIDAK dibaca/diisi (salinan cabang akan basi).

## 2. Kode galat (`{ ok:false, kode, error, ... }`; FastAPI: `{ ok:false, detail, kode, ... }`)

| Kode | HTTP | Arti / tindakan UI |
|---|---|---|
| `SALESMAN_BELUM_TERHUBUNG` | 403 | Akun belum ditautkan ke karyawan salesman Accurate (atau kodenya tak ada / >1 profil). Tampilkan kalimatnya; jangan tampilkan daftar kosong. |
| `SALESMAN_TIDAK_AKTIF` | 403 | Karyawan tertaut suspended / bukan salesman / tanpa cabang di Accurate. |
| `CABANG_DI_LUAR_CAKUPAN` | 403 | Salesman meminta cabang/pelanggan cabang lain. |
| `PELANGGAN_WAJIB` | 400 | Pratinjau/simpan tanpa kode pelanggan. |
| `PELANGGAN_TIDAK_ADA` | 409 | Kode/id pelanggan tak ada di master hasil sync. |
| `PELANGGAN_SUSPENDED` | 409 | Pelanggan suspended di Accurate. |
| `PELANGGAN_TANPA_CABANG` | 409 | Pelanggan tanpa cabang di Accurate. |
| `BARANG_TIDAK_ADA` | 409 | `barang: [kode]`. |
| `BARANG_SUSPENDED` | 409 | `barang: [kode]`. |
| `BARANG_BEDA_CABANG` | 409 | `barang: [{code, name, branchId, branchName, tag}]` — termasuk barang tanpa cabang (non-jual/tag tak dikenal). |
| `SATUAN_SALAH` | 409 | `wrong_unit: [{code, unit, known_units}]` (bentuk lama dipertahankan). |
| `HARGA_BELUM_ADA` | 409 | `missing: [kode]` (bentuk lama dipertahankan). Kalimat menyebut sebab per baris: belum ada / harga standar / harga 0 / harga cabang lain. |
| `HARGA_TIDAK_VALID` | 400 | Harga petugas bukan angka > 0 (maks 4 desimal, tanpa titik ribuan). `barang: [kode]`. |
| `HARGA_PETUGAS_TIDAK_DIIZINKAN` | 409 | Harga petugas dikirim untuk baris yang SUDAH punya harga master sah (owner sesi 13). `barang: [{code, unit, hargaMaster}]` per baris; kosongkan harganya. |
| `INPUT_TIDAK_VALID` | 400 | Query/badan tidak valid — termasuk `price` dikirim dari Order Sales (sales tidak menentukan harga). |
| `TIDAK_DIIZINKAN` | 403 | Izin layar tidak ada. |
| `IZIN_TIDAK_KONSISTEN` | 403 | Akun punya `websales.create` + `order.view` tanpa `order.create` (butir 11). Admin membetulkan grup. |
| `SALESMAN_BEDA_CABANG` | 409 | Antre Faktur: salesman bukan cabang pelanggan order / tanpa cabang (butir 4). |
| `KODE_DIPAKAI_FORM_KONTROL` | 409 | Tautan admin mengganti kode sales yang punya laporan Form Kontrol (`laporan: {laporanHarian, ao, merchandising, jks, total}`); kirim ulang `konfirmasiGantiKode: true` bila disengaja. |
| `KODE_DIPAKAI_PROFIL_LAIN` | 409 | Kode karyawan masih dipegang profil Form Kontrol akun lain yang tautannya dilepas (kode unik). Salesman ganti akun → PUT ulang `pindahkanProfil: true`. |
| `PROFIL_TUJUAN_ADA` | 409 | `pindahkanProfil` ke akun yang sudah punya profil sales — rapikan dulu. |
| `BONUS_TIDAK_BISA_DIORDER` | 409 | Barang bonus promo tidak bisa diorder untuk pelanggan ini. `bonus: [{code, name, alasan}]` (tidak ada / suspended / tanpa cabang (tag) / barang cabang lain). Pratinjau DAN simpan/tarik. |
| `ATURAN_TERBIT_RUSAK` | 409 | Satu aturan terbit tidak lolos validasi (keadaan server). Pratinjau/simpan ditolak; tarikan BERHENTI (permintaan tetap pending). Admin Summary menarik/memperbaiki publikasinya. |
| Promo/simpan FastAPI | — | `SIDIK_WAJIB`, `PRATINJAU_BERUBAH`, `CHANNEL_BEDA_MASTER`, `ORDER_GANDA`, `ATURAN_BELUM_TERBIT`, `ATURAN_TERBIT_RUSAK`, `DATA_TIDAK_VALID`, `KONFIGURASI_SERVER` (CRON_SECRET kosong/ditolak di jembatan harga MAUPUN channel), `LAYANAN_TIDAK_PASTI` — §4.3/§4.5. |

## 3. Endpoint

### `GET /api/customers/search?q=&branchId=&limit=`
Izin `websales.create` ATAU `order.create`. `limit` 1–50 (20). Cari nama/kode (ILIKE, `%`/`_` literal), kode persis di atas.
Tanpa suspended, tanpa cabang kosong. Salesman: hanya cabangnya (`branchId` lain → 403). Internal: semua atau saring `branchId`.
200: `{ ok, cakupan: {semua, branchId, branchName}, items: [{ id, customerNo, name, branchId, branchName, categoryName, channel ("GT"/"MT"/…), priceCategoryName, alamat }] }`.

### `GET /api/items/search?q=&branchId=&customerId=&tanggal=&limit=`
Izin sama. Dengan `customerId` (= `customer.id`): cabang = cabang pelanggan (`branchId` beda → 400), plus harga per satuan.
Tanpa `customerId`: salesman = cabangnya; internal = `branchId` atau semua. Tanpa suspended / tanpa cabang. `tanggal` bawaan hari ini WITA.
200: `{ ok, tanggal, branchId, cabangTanpaBarang, items: [{ id, no, name, branchId, branchName, tag, units: [{ unit, price?, source?, branchName?, effectiveDate?, hargaDefault? }] }] }`
(`hargaDefault: true` = harga sah dari cabang DEFAULT karena cabang pelanggan tak punya baris berlaku — beri label "harga cabang default").
(`price/source/...` hanya bila `customerId`; `units: []` = belum ada daftar harga; `price: null` = harga master TIDAK sah untuk order
(standar/0/cabang lain — `source`/`branchName` menjelaskan) → tidak bisa dipilih kecuali harga petugas Order Baru).
`cabangTanpaBarang: true` = hasil kosong karena cabang itu memang tanpa barang orderan (sync barang belum jalan / cabang tanpa tag divisi),
bukan karena pencarian tidak cocok — layar menampilkan penjelasan, bukan "tidak ada hasil".

### `GET /api/customers/rute?kode=&kode=…` (baru, FK-MSM butir 6 — 12 Okt 2026)
Pemilih "Toko di rute hari ini" Order Sales. Kode toko JKS TANPA akhiran cabang (`C-100001`) -> pelanggan Accurate cabang pemakai
(`C-100001-<akhiran>`). Izin & cakupan = pencarian pelanggan (`websales.create` ATAU `order.create`; salesman HANYA cabangnya, internal semua).
1–200 kode unik per permintaan (ganda digabung; > 200 = 400 berkalimat — pemilih Order Sales memecah rute yang lebih panjang per 200;
kode > 80 huruf = `masalah: "KODE_TIDAK_SAH"` untuk toko itu saja). Cocok = `customerNo` persis ATAU kode + `-` + SATU akhiran (tanpa `-` lagi), tak peka huruf,
spasi dalam kode dipertahankan; tepat SATU pelanggan aktif = dipilih. Data JKS tidak diubah.
200: `{ ok, cakupan, rute: [{ kode, pelanggan: <item pencarian> | null, masalah: null | "TIDAK_ADA" | "GANDA" | "NONAKTIF" | "KODE_TIDAK_SAH", kandidat: [customerNo], alasan }] }`
(`TIDAK_ADA` termasuk kode yang hanya ada di cabang lain — tidak pernah ditawarkan; `alasan` = kalimat untuk layar per toko). Galat §2
(`SALESMAN_BELUM_TERHUBUNG`, …), `INPUT_TIDAK_VALID` 400.

### `GET /api/customers/lookup?no=` (berubah, butir 14)
Salesman hanya pelanggan cabangnya: kode cabang lain / tanpa cabang → 403 `CABANG_DI_LUAR_CAKUPAN`; akun belum tertaut →
`SALESMAN_BELUM_TERHUBUNG`. Kode tak ada = 200 `found:false` (bentuk lama). Internal (`order.view`) semua cabang.
Pelanggan suspended → 409 `PELANGGAN_SUSPENDED` (putaran 2; selaras pencarian & pratinjau).

### `POST /api/orders/preview` (berubah)
`customer_no` WAJIB; cabang harga dari pelanggan (badan `branch_id` diabaikan); galat §2. Bentuk jawaban + `sidik` + harga petugas: §4.2.

### `POST /api/orders/harga` (layanan; juga boleh sesi)
Dipanggil FastAPI (`python_backend/order_cabang.py`). CRON_SECRET (Bearer) = semua cabang; sesi `websales.create`/`order.create` = cakupan pemakai.
Badan `{ customer_no, order_date, lines: [{code, unit, quantity?, price?}] }` (1–500 baris). `price` = harga petugas (hanya CRON atau sesi
`order.create`; sesi sales → 400), hanya baris tanpa harga master sah (lainnya 409 `HARGA_PETUGAS_TIDAK_DIIZINKAN`). `harga:false` (bentuk
lama) DIHAPUS — tidak lagi melewati harga master.
200: `{ ok, pelanggan, lines: [{code, unit, quantity, price, sumber_harga: "master"|"petugas"}] }` (urutan = masukan; harga petugas
kembali APA ADANYA). Tanpa efek samping. CRON_SECRET hanya header `Authorization: Bearer` (konstan-waktu; `?secret=` ditolak — butir 6).

### `GET /api/orders/salesmen?branchId=` (berubah)
Izin `order.edit`. `branchId` = hanya salesman aktif cabang itu (Antre Faktur: kirim cabang pelanggan order — ambil dari
`branch.branchId` jawaban pratinjau `POST /api/orders/[id]/invoice` `queue:false`). Kosong = semua (perilaku lama).
Server MENOLAK salesman cabang lain saat pratinjau/antre faktur: 409 `{ ok:false, kode: "SALESMAN_BEDA_CABANG", error }` (butir 4).

### `GET|PUT|DELETE /api/admin/users/[id]/salesman` (baru)
- GET (izin `users.manage` atau `users.view`): `{ ok, tautan: [{ salesCode, salesName, employeeId, employeeName, branchId, branchName, salesman, suspended, terhubung, aktif }], pilihan: [{ id, number, name, branchId, branchName, terhubungKe: {userId, name, email, terhubung} | null }] }` — `pilihan` = karyawan salesman aktif, urut cabang lalu nama; `terhubungKe.terhubung: false` = kode dipegang profil Form Kontrol akun lain yang tautannya dilepas. `aktif` = tertaut + salesman + tidak suspended + bercabang.
- PUT `{ employeeNumber, konfirmasiGantiKode?, pindahkanProfil? }` (izin `users.manage`): tetapkan/ganti/tautkan ulang. `pindahkanProfil: true`
  (putaran 2): kode dipegang profil akun LAIN yang tautannya dilepas → BARIS profil itu dipindah ke akun ini (kode persis tetap → riwayat
  Form Kontrol + spv/sm ikut), tautan menyala; akun tujuan berprofil → 409 `PROFIL_TUJUAN_ADA`; audit `salesman.link` `detail.dipindahDari`. 200 `{ ok, changed, tautan: { salesCode, employeeName, employeeId, branchId, branchName } }`. Galat (`code`): `KARYAWAN_TIDAK_ADA` 404, `KARYAWAN_GANDA`/`KARYAWAN_BUKAN_SALESMAN_AKTIF`/`KARYAWAN_TANPA_CABANG`/`KARYAWAN_SUDAH_TERHUBUNG` (+`terhubungKe`)/`KODE_DIPAKAI_PROFIL_LAIN`/`KODE_DIPAKAI_FORM_KONTROL` (+`laporan`)/`PROFIL_GANDA` 409, `USER_TIDAK_ADA` 404, `IZIN_BERUBAH` 403.
- DELETE (izin `users.manage`): LEPAS tautan (`accurate_linked` = false); baris `sales_profile`, kode, dan hierarki Form Kontrol TETAP (butir 12). 200 `{ ok, changed }`.
- Audit `permission_audit_log`: `salesman.link` (`detail.sebelum/sesudah`, + `laporanKodeLama` bila kode diganti dengan konfirmasi), `salesman.unlink` (`detail.dilepas`) — tampil di Riwayat user (label di `lib/rbac.ts`).

### FastAPI (berubah)
- `POST /websales/orders`: dihitung LENGKAP dengan sesi sales (channel master, cabang, harga, promo) + WAJIB `sidik`; ditolak → status +
  `{ ok:false, detail, kode, ... }`; Next tak pasti → 503 berkode. Harga TIDAK disimpan di permintaan (hanya kuantitas + `sidik`). §4.3.
- `POST /orders` (Order Baru): harga petugas hanya baris tanpa harga master sah, tidak ditimpa, ≤ 0 ditolak; WAJIB `sidik`. §4.3–4.4.
- `POST /api/orders/harga` mode BONUS (putaran 2): badan `{ customer_no, order_date, lines: [], bonus: [kode] }` (maks 50; `lines` boleh kosong
  bila ada `bonus`) — dipanggil FastAPI sesudah promo dihitung (simpan + tarik). 200 `{ ok, pelanggan, lines: [], bonus }` / 409
  `BONUS_TIDAK_BISA_DIORDER`. `sumber_harga` kini `"master" | "master_default" | "petugas"`.
- Tarik (`/orders/pull`, `/orders/pull-cron`): order dibekukan berharga server → `draft` bila angka = sidik sales; `failed` (ditahan) vs
  `rejected` (permanen, status `rejected` + sebab); Next tak pasti / CRON_SECRET beda → 503 `{ok:false, detail, kode}` (tarikan berhenti,
  tidak ada yang ditolak). §4.5.

## 4. Promo — pratinjau = tersimpan (owner 12 Okt 2026, putaran perbaikan 1)

Owner (revisi 12 Okt): program promo (Summary terbit) terhubung di Order Sales DAN Order Manual (Order Baru); angka yang dilihat di
pratinjau (diskon/bonus/net per baris) = angka yang tersimpan/dibekukan. Tidak ada hitung ulang diam-diam yang berbeda.

### 4.1 Satu fungsi, masukan sama
- **Hitung promo = SATU fungsi** FastAPI `hitung_promo` (`python_backend/routers/orders.py`): `published_rules()` + `calculate(...)` dengan
  kelas outlet pelanggan (`outlet_class.classes_of(customer_no)` + `known()`). Dipakai: pratinjau (`POST /orders/preview`), simpan Order Baru
  (`POST /orders`), simpan Order Sales (`POST /websales/orders`), tarik (`/orders/pull`, `/orders/pull-cron`).
- **Harga = SATU pemeriksa** Next `periksaOrder` (`lib/order-cabang.ts`): pratinjau memanggilnya langsung; simpan/tarik lewat
  `POST /api/orders/harga` (FastAPI `order_cabang.periksa`). Cabang harga = cabang pelanggan (server), tanggal berlaku ≤ `order_date`.
- **Masukan:** `customer_no` (→ cabang/principal, harga, kelas outlet), `channel` (simpan menolak bila ≠ master: `CHANNEL_BEDA_MASTER`;
  pratinjau melaporkannya di `channel_masalah` dengan kalimat yang sama), `order_date`, baris berharga `[kode, satuan, jumlah, harga]`.
- **Principal cabang pelanggan** ditegakkan lewat kode barang: semua baris order = barang cabang pelanggan (`BARANG_BEDA_CABANG`), dan
  program hanya berlaku pada baris yang kodenya ada di `codes` program → hanya program principal cabang itu yang bisa kena.
- **`sidik`** = sha256 atas `{customer_no, channel, order_date, baris [kode, satuan, jumlah, harga], result}` (angka dinormalkan). Pratinjau
  mengembalikannya; simpan WAJIB membawanya dan server menghitung ulang dengan fungsi + masukan yang sama: beda = DITOLAK
  `PRATINJAU_BERUBAH` (409) beserta pratinjau baru — tidak disimpan. Yang disimpan selalu hitungan server, bukan angka klien.
- **Dibekukan:** Order Baru saat simpan. Order Sales dicocokkan saat simpan (sesi sales) lalu DIBEKUKAN saat tarik (cocok `sidik` lagi;
  beda = permintaan `rejected` `PRATINJAU_BERUBAH`, sales kirim ulang). Sesudah beku, aturan diubah/ditarik TIDAK mengubah order
  (`rules` utuh, `sources`, `result`, `lines` berharga tersimpan di order).

### 4.2 `POST /api/orders/preview` — bentuk jawaban (dipakai Order Sales DAN Order Baru)
Badan: `{ customer_no, channel, order_date, lines: [{ code, unit, quantity, price? }] }`. `price` = harga petugas, HANYA izin `order.create`
(Order Baru); akun tanpa `order.create` mengirim `price` → 400 `INPUT_TIDAK_VALID`.
```
200 { ok: true,
  pelanggan: { customerNo, name, branchId, branchName },
  lines:  [{ code, unit, quantity, price: "7207", sumber_harga: "master" | "master_default" | "petugas" }],   // harga DIPAKAI (string)
  prices: [{ code, unit, price, source: "tier" | "petugas", hargaMaster, hargaDefault, priceCategoryName, branchName, effectiveDate, knownUnits }],
  result: { gross, discount, net,
            lines: [{ code, unit, quantity, gross, net, percents: ["10"], cash }],   // PER BARIS = yang dibekukan
            bonuses: [{ program_id, code, unit, quantity, eligible_codes? }],
            applications: [{ program_id, minimum, discount }],
            blocked: [{ program_id, program_name, reason }] },                        // program yang tertahan kelas outlet
  suggestions: [{ program_id, message, codes, ... }],
  sources: [{ draft_id, revision }],
  channel_masalah: "",            // tidak kosong = simpan akan ditolak CHANNEL_BEDA_MASTER (tampilkan, jangan izinkan simpan)
  sidik: "<64 hex>" }
```
`hargaMaster` = harga master sah baris itu; baris `petugas` SELALU null (harga petugas hanya boleh di baris tanpa master — sesi 13). Galat FastAPI diteruskan berkode
`{ ok:false, kode, error }` (mis. `ATURAN_BELUM_TERBIT` / `ATURAN_TERBIT_RUSAK` 409); galat Next §2 tetap. Sesudah promo dihitung, barang bonus
`result.bonuses[].code` diperiksa (`periksaBonus`, sama dengan simpan/tarik) → 409 `BONUS_TIDAK_BISA_DIORDER` (`bonus: [{code, name, alasan}]`).

**Catatan O2 (putaran 2, peninjau A):**
- Angka pratinjau (`gross`/`discount`/`net`, per baris) = DPP **sebelum PPN**. PPN 11% ditambahkan Accurate di atas DPP saat faktur — label
  wajib "sebelum PPN"; jangan menampilkan `net` sebagai total yang dibayar.
- Netto faktur Accurate boleh beda ≤ Rp 1 per baris dari `result.lines[].net` (pembulatan persen Accurate; `lib/accurate-invoice-write.ts`
  menolak selisih > Rp 1) — tidak perlu ditampilkan sebagai galat.
- `sumber_harga: "master_default"` / `prices[].hargaDefault` = harga dari cabang DEFAULT (Kantor Pusat) karena cabang pelanggan tak punya
  baris berlaku pada tanggal order (mis. tanggal mundur) — beri label "harga cabang default" agar petugas/sales menyadarinya.

### 4.3 Simpan (FastAPI) — WAJIB membawa `sidik` pratinjau terakhir
- Order Baru `POST /orders`: `{ outlet, channel, order_date, note, customer_no, lines: [{ code, unit, quantity, price? }], sidik,
  confirm_duplicate? }` — `price` HANYA baris TANPA harga master sah yang diketik petugas (kosong = harga master; `price` di baris berharga
  master = 409 `HARGA_PETUGAS_TIDAK_DIIZINKAN`). 200 `{ ok, order }`; `order.lines[]` membawa
  `price` + `sumber_harga`, `order.result` = `result` pratinjau.
- Order Sales `POST /websales/orders`: `{ outlet, channel, order_date, note, customer_no, lines: [{ code, unit, quantity }], sidik }` → 200
  `{ ok, request }` (permintaan TANPA harga; `sidik` disimpan, dicocokkan lagi saat tarik). `GET /websales/orders` menambah
  `reject_code`, `reject_reason`, `rejected_at` (status `pending` | `pulled` | `rejected`).
- Galat (`{ ok:false, detail, kode, ... }`): `SIDIK_WAJIB` 400 · `PRATINJAU_BERUBAH` 409 + `pratinjau: { lines, result, sources, sidik }`
  (tampilkan angka baru, minta konfirmasi, simpan ulang dengan sidik baru) · `CHANNEL_BEDA_MASTER` 422 · `HARGA_TIDAK_VALID` 400 ·
  `HARGA_PETUGAS_TIDAK_DIIZINKAN` 409 (+`barang`) ·
  `ORDER_GANDA` 409 (Order Baru: `confirm_duplicate:true` sesudah diperiksa) · `ATURAN_BELUM_TERBIT` 409 · kode §2 (Next) ·
  `KONFIGURASI_SERVER` / `LAYANAN_TIDAK_PASTI` 503 (TIDAK tersimpan; jangan tampilkan "sesi berakhir").

### 4.4 Harga petugas (Order Baru) — HANYA baris tanpa harga master sah (owner sesi 13, 12 Okt 2026)
Harga master SAH = daftar harga Accurate (`tier`) cabang pelanggan — atau cabang default bila cabang pelanggan tak punya baris berlaku —
dan > 0 (`hargaSah`). Per baris (`putusanHarga`, satu keputusan untuk pratinjau DAN simpan → sidik konsisten):
- master sah ada, `price` kosong → harga master (`sumber_harga: "master"`);
- master sah ada, `price` diisi → DITOLAK 409 `HARGA_PETUGAS_TIDAK_DIIZINKAN` (`barang: [{code, unit, hargaMaster}]`) — tidak diabaikan
  diam-diam, tidak menimpa master;
- master sah TIDAK ada (belum ada / harga standar / 0 / cabang lain), `price` diisi > 0 → harga petugas (`sumber_harga: "petugas"`, tidak
  ditimpa); `price` ≤ 0 / bukan angka → `HARGA_TIDAK_VALID` 400; `price` kosong → `HARGA_BELUM_ADA` 409 (`missing`).
Menggantikan "harga petugas selalu menang" (putaran 1). Order Sales tidak pernah membawa harga (400).
Alur layar O2: pratinjau tanpa harga → `HARGA_BELUM_ADA.missing` = baris yang BOLEH diberi harga petugas → isi harga baris itu saja →
pratinjau ulang → simpan dengan sidiknya. Baris lain: harga master tampil read-only.

### 4.5 Tarik (`/orders/pull`, `/orders/pull-cron`)
200 `{ ok, imported: [{request_id, order_id}], already_imported: [id], failed: [{request_id, error, kode: "ORDER_GANDA", duplicate: true}],
rejected: [{request_id, kode, error}] }`. `failed` = DITAHAN (tetap `pending`, menunggu keputusan — BL-20). `rejected` = PERMANEN
(status `rejected` + sebab; tidak dicoba lagi): kode §2, `PRATINJAU_BERUBAH`, `CHANNEL_BEDA_MASTER`, `BONUS_TIDAK_BISA_DIORDER`,
`SIDIK_WAJIB`, `DATA_TIDAK_VALID`. 503 `{ ok:false, detail, kode }` (Next tak pasti / konfigurasi — harga MAUPUN channel) dan 409
`ATURAN_BELUM_TERBIT` / `ATURAN_TERBIT_RUSAK` (diperiksa SEKALI sebelum permintaan disentuh) = tarikan BERHENTI, tidak ada yang ditolak.

## 5. Tugas O2 (UI)
0. Promo (§4): Order Sales & Order Baru menampilkan `result` pratinjau per baris (bruto, persen, potongan rupiah, netto) + `bonuses` +
   `blocked`; simpan membawa `sidik` pratinjau TERAKHIR (pratinjau usang/masih dihitung = tombol simpan terkunci). `PRATINJAU_BERUBAH` →
   tampilkan `pratinjau` baru dan minta konfirmasi ulang. Order Baru: kolom harga hanya aktif untuk baris tanpa harga master sah
   (§4.4); `price` hanya untuk baris itu. Label "sebelum PPN", label harga cabang default, `BONUS_TIDAK_BISA_DIORDER` = kalimat server +
   daftar `bonus` (catatan O2 §4.2).
1. Order Sales & Order Baru: pemilih pelanggan (`customers/search`) → tampilkan cabang + channel; pemilih barang (`items/search?customerId=`) → hanya barang cabang itu, satuan dari `units`, harga per satuan. Tampilkan galat berkode §2 sebagai kalimat (bukan "kosong").
2. Order Sales: `SALESMAN_BELUM_TERHUBUNG` = layar penjelas (hubungi admin), bukan form kosong.
3. User admin: panel "Salesman Accurate" (GET/PUT/DELETE tautan), pilihan dari `pilihan` (tandai yang sudah tertaut ke akun lain;
   `terhubung:false` = profil dilepas). `KODE_DIPAKAI_FORM_KONTROL` → dialog konfirmasi berisi hitungan laporan → PUT ulang
   `konfirmasiGantiKode:true`. Tombol "Lepas" = tautan mati, profil Form Kontrol tetap (kalimatnya jangan "hapus").
   `KODE_DIPAKAI_PROFIL_LAIN` → tawarkan "Pindahkan profil ke akun ini" (PUT ulang `pindahkanProfil:true`, konfirmasi menyebut akun asal).
4. Antre Faktur: `GET /api/orders/salesmen?branchId=<cabang pelanggan>`; `SALESMAN_BEDA_CABANG` = kalimat server apa adanya.
5. Order Masuk: hasil tarik `failed[]` (ditahan, dugaan ganda) dan `rejected[]` (permanen) tampil per permintaan dengan kodenya; 503
   `KONFIGURASI_SERVER` = "konfigurasi server" (BUKAN "sesi login berakhir"). Order Sales: daftar "Order saya" menampilkan
   `rejected` + `reject_reason`.
6. Pencarian pelanggan/barang (butir 15): debounce ≥ 300 ms, minimal 2 huruf sebelum memanggil server (kosong/1 huruf = tidak memanggil),
   batalkan permintaan lama (`AbortController`) dan abaikan jawaban yang datang terlambat untuk kata kunci lama. Hasil kosong:
   `cabangTanpaBarang: true` → penjelasan "Cabang <nama> belum punya barang yang bisa diorder (sync barang / tag divisi)"; selain itu
   "Tidak ada yang cocok". Galat (non-2xx) ≠ kosong: tampilkan kalimat server + "Coba lagi".

## 6. Deploy (urut)
1. IT Support: `docs/handover/DDL_O1.sql` sebagai pemilik SEBELUM image (VERIFIKASI semua `ok`, termasuk UNIQUE `sales_profile.sales_code`
   dan tripwire grup; `false` = berhenti, laporkan).
2. Image baru; ikuti kepala DDL_O1 "SESUDAH IMAGE" a–d: cek `sync_state.last_page` item/customer (≠ 1 → sync dua kali), picu lewat
   `/usr/local/bin/accapi-cron.sh "/api/cron/sync-accurate?modules=branch,employee,item,customer"`, ulangi sampai `ada_key` = jumlah
   barang. Sebelum sync item selesai semua order ditolak `BARANG_BEDA_CABANG` (gagal tertutup).
3. Kirim `results.item.tagTakDikenal` ke orkestrator; periksa sebaran barang per cabang dan jumlah pelanggan suspended.
4. Admin menautkan akun salesman (sebelum sales memakai Order Sales) — `accurate_linked` bawaan false: profil lama tidak membuka order.
   Grup sales = `websales.view` + `websales.create` SAJA, tanpa `order.view` (tidak ada preset); VERIFIKASI tripwire grup + per user `t`.
4a. Pastikan CRON_SECRET frontend = backend (FastAPI → Next `/api/orders/harga`): beda = tarik/simpan 503 `KONFIGURASI_SERVER` + log
   `accapi.order_cabang` "Next menolak CRON_SECRET FastAPI". Pemicu manual/seed: header `Authorization: Bearer`, bukan `?secret=`.
4b. RILIS: O1 + O2 BERSAMAAN dalam satu deploy (keputusan owner sesi 13, bersama PR #166 runbook) sesudah peninjau APPROVE. TIDAK ada
   mode "simpan tanpa sidik": layar lama tanpa `sidik` ditolak `SIDIK_WAJIB` (produksi: 0 order/0 permintaan).
5. Order `needs_price` LAMA: probe produksi 12 Okt = 0 baris `sales_order` dan 0 `order_request` → tidak ada yang buntu (selesai tanpa keputusan).

## 7. TERBUKA
- Penanda "petugas internal = `order.view`" (semua cabang) adalah tafsir teknis dari "admin/fakturist boleh semua cabang"; bila owner mau kunci khusus, tambahkan kapabilitas.
- 31 nilai `charField2` probe tidak tersedia sebagai berkas; uji memakai superset (22 nama cabang + 6 pemetaan + 6 non-jual + tak dikenal). Sesudah sync pertama `tagTakDikenal` membuktikan tidak ada yang terlewat.
- `customer/list.do` & `item/list.do` `suspended`: bila Accurate mengabaikan field itu, semua tetap `false` — periksa sesudah sync pertama.
- `item/list.do` tanpa key `charField2` untuk barang tak bertag (bila Accurate membuang field null): cabang lama dipertahankan (butir 10) →
  tag yang DIHAPUS di Accurate tidak mengosongkan cabang. Periksa sesudah sync pertama (DDL_O1: `ada_key` harus = jumlah barang).
- Permintaan yang ditahan dugaan ganda (BL-20) tetap `pending` tanpa jalur lepas di layar; halaman keyset mencegah antrean macet, tetapi
  keputusan "bukan order ganda" untuk Web Sales belum ada.
- `/api/items/units` (pembaca satuan + nama barang lama) tidak dibatasi cabang — hanya nama & satuan, tanpa harga; layar O2 memakai
  `items/search`. Batasi atau pensiunkan bila owner mau.
- Migrasi: O1 memakai `db/migrations/0033_order_cabang.sql` + entri migrate-pg terakhir; K2a (cabang lain) memakai 0032 dan juga menambah
  entri di `scripts/migrate-pg.mjs` → konflik teks saat merge (urutan entri bebas: keduanya aditif + `sudahAda`). Nomor TIDAK diubah.
- `?secret=` dihapus dari `requireCronSecret`: pemakai yang tidak tercatat di repo (skrip pribadi/bookmark) akan mendapat 401 — gunakan header.
