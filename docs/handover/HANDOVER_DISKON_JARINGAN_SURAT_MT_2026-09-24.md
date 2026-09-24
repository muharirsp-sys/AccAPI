# Handover — Diskon jaringan, Normalisasi Diskon, C9, dan surat DAHLIA MT, 24 September 2026

Cabang `feat/surya-workspace`. Semua pekerjaan sesi ini **sudah di-merge dan hidup di produksi**
lewat PR [#89](https://github.com/muharirsp-sys/AccAPI/pull/89) (merge `472af77b`).
Handover sebelumnya: `HANDOVER_CELAH_UANG_2026-09-20.md` — butir 8b-nya ditutup di sini.

Yang paling penting dibaca lebih dulu: **bagian 5 (langkah wajib pasca-deploy)** dan
**bagian 7 (yang belum)**.

---

## 1. Empat commit, satu PR

| Commit | Isi |
|---|---|
| `8d37a852` | Validator Order Principal: DISC_5 rupiah, normalisasi posisi jaringan, tarif principal, rantai 5 slot, header |
| `6e495638` | Menu baru **Normalisasi Diskon** + tabel `discount_normalization` |
| `2d3b8cfb` | Verifier `tools/verify_form_summary.py`: empat cacat 8b ditutup, C9 berpijak pada surat |
| `06b23cbd` | Surat DAHLIA MT 083 dan 234: kode berhenti hilang dan berhenti bertambah |

---

## 2. Validator Order Principal (`8d37a852`)

Semua dari ORDER_DETAIL Kino 16 Sep 2026 yang dilampirkan pengguna.

### 2.1 DISC_5 berisi RUPIAH, dibaca persen

TK SUBHAN: `DISC_1 = 2` (persen, tarif distributor) **dan** `DISC_5 = 1.918,9189` (rupiah — bagian
baris dari potongan faktur MSG Rp 100.000). Parser hanya membedakan persen/rupiah bila **satu**
posisi terisi (tertulis sebagai `ponytail:` — batasnya kini tercapai), jadi layar menampilkan
`D5 1918.9189%` dan klaim se-SO terbaca **Rp 1,17 miliar**.

Kini tiap kolom ditafsir sendiri: semua gabungan persen/rupiah dicoba (maks 2^8), dipakai
**satu-satunya** yang mereproduksi `TOTAL_DISC`. Persen setara dihitung atas **sisa** sebelum
posisinya. Tidak ada yang cocok, atau lebih dari satu → tetap persen dan ditahan (gagal tertutup).

Bukti atas berkas asli: keenam SO MSG cocok tier-nya (TK SUBHAN: klaim Rp 90.108 = Rp 100.020
dengan PPN → tier 5 Rp 100.000, dalam toleransi nota Rp 100).

### 2.2 Jaringan Indomaret / Alfamart / Indogrosir / Alfamidi — posisi dimaklumi, nilai tidak

Fakta yang ditemukan, jangan diulang mencarinya:

- Tarif produksi C-AL0063 (dimuat pengguna **2026-09-15 01:41 UTC**): posisi 1 4% dan **posisi 2**
  2,25%, keduanya `DISTRIBUTOR`, catatan *"Dipindah ke posisi 2 atas keputusan pengguna
  2026-09-14: tanggungan distributor, bukan klaim principal."* Indomaret 3,1% di posisi 2
  ditambah manual 19 Sep dengan catatan yang sama.
- Kino tetap melaporkannya di **DISC_4**. Gerbang mencocokkan per posisi → setiap baris Alfamart
  tertahan sebagai "klaim principal tanpa aturan". Tidak ada kode yang pernah memindahkannya.
- Faktur Accurate ALFAMART selama ini: `4+2.25` — **151 baris, 45 faktur**. Posisi 2 memang praktik
  yang berjalan.

**Keputusan pengguna 24 Sep:** untuk outlet yang NAMA masternya memuat INDOMARET / ALFAMART /
INDOGROSIR / ALFAMIDI, posisi yang salah dimaklumi, **nilai yang berbeda ditolak** — contoh
pengguna: laporan `3.96+3.1+3.1` lawan tarif `3.96+3.1` → ditahan.

Implementasi `normalisasiJaringan` (lib/principal-validation.ts): tiap persen dipasangkan ke satu
posisi tarif bernilai sama; yang tanpa pasangan hanya boleh tinggal bila surat principal untuk
barang itu membenarkannya; selain itu seluruh baris dikembalikan apa adanya **dengan temuan
bersebab**. Hasilnya **disimpan** ke `principal_order_line.discounts` (dengan `reportPosition`),
jadi faktur terbit dengan posisi yang sama dengan yang dinilai gerbang. Validasi ulang selalu
dihitung dari posisi laporan. Outlet lain tetap per posisi apa adanya.

Replay dengan tarif produksi: ALFAMART **11/11**, Indomaret 3/4 (baris `3.96+3+3.1` ditolak — 3%
tidak ada di tarif, temuan asli).

### 2.3 Lainnya

- **Tarif PRINCIPAL posisi 4-5** (PT SUPRA BOGA 0,5%) tidak pernah bisa cocok — pesannya berbunyi
  "0,5% tidak sama dengan ... posisi 4 0,5%". `matchTariff` kini menerima `owner`. Replay 9/10;
  sisanya satu baris 2% di posisi 1 lawan tarif 3% (temuan asli).
- **NKA lawan "Modern Trade"** laporan tidak lagi dituduh selisih channel. Kelayakan surat
  ber-channel **tidak** dilebarkan: surat MT tetap hanya untuk kategori MT (lihat 7.3).
- **Rantai persen faktur selalu 5 slot**: `3.96+3.1+0+0+0` (permintaan pengguna). Verifikasi balik
  membuang nol di ekor saat membandingkan, jadi tidak terpengaruh.
- Chip diskon rupiah ditulis `Rp`, posisi yang dipindah menulis `(lap. D4)`; header tabel Order
  Principal tidak tembus pandang lagi.

---

## 3. Menu Normalisasi Diskon (`6e495638`)

Untuk faktur Accurate yang dibuat **di luar web** (tidak ada di `invoice_outbox` berstatus
`posted`). Potongan yang Rekap Promo sebut tak bertuan dikelompokkan per outlet × posisi × persen;
pengguna memilih **Disc Claim** atau **Disc Distributor**, dan bisa membatalkan.

- Tabel `discount_normalization` (migrasi 0022 + entri `migrate-pg.mjs`, aditif, tanpa DROP),
  kunci `(line_key, positions)` — `line_key` = `detailItem[].id` Accurate (terbukti unik pada
  41.761 baris September).
- **Nominal diadu saat rekap**: faktur yang diubah sesudah diputuskan membuat keputusannya tidak
  dipakai, dengan sebab tertulis.
- Diterapkan **paling akhir, hanya pada baris tak bertuan** — aturan terbit selalu menang.
- Disc Claim masuk program tersendiri `NORMALISASI`, tidak dicampur program surat.
- **TIDAK menulis ke Accurate.** Fakturnya tetap apa adanya.
- Izin: lihat `summary.view`, simpan/batal `summary.edit`.

---

## 4. Verifier dan surat DAHLIA MT (`2d3b8cfb`, `06b23cbd`)

### 4.1 Verifier (butir 8b handover 20 Sep)

1. `--strict-kelompok` **disambungkan**. Catatan koreksi: C7 sudah sejak lama menggagalkan kelompok
   yang tidak ada di master; satu-satunya kelonggaran kelompok ada di C9 — kode surat dianggap
   terwakili asal nama kelompok+gramasinya tercetak. Dengan bendera itu → FAIL; tanpanya →
   `PERINGATAN` tercatat.
2. `extract_column_cells` dihapus.
3. C9 per **token** (bukan substring), tanda hubung diabaikan (`BC002` = `BC-002`), dan **per surat**
   (kode surat 083 harus di baris surat 083). Keterangan hanya mewakili baris yang **ditahan**. C10
   ikut per token.
4. Pemotongan di "TOKO PANTAUAN" **dibuang**. Contoh nyata: surat 083 menulis *"list Toko Pantauan"*
   di Mekanisme Klaim **sebelum** tabel produknya → 11 kode tak pernah diperiksa, C9 hanya melihat
   `SUR030` (potongan nomor proposal). Kode toko kini tersaring karena keluarganya tidak ada di master.

`pdfplumber` diimpor saat dipakai (tidak ada di `requirements.txt`), supaya logika C9 teruji di CI
lewat `python_backend/test_verify_form_summary.py`.

### 4.2 Akar cacat 083 dan 234 — di HILIR parser

Parsernya (`dahlia_letter.py`) membaca kedua surat dengan benar. Yang merusak:

| Cacat | Akibat | Perbaikan |
|---|---|---|
| `summary_store.append_rows` membuang baris kembar dengan jati diri **tanpa barang** | 6 dari 7 kode 083 berafaksi Rp 1.000 hilang saat disusulkan ke draft; 6 grup 234 jadi 1 | jati diri + `kode_barangs` + `source_quote` |
| Pemekaran "ALL VARIANT" se-(kelompok, gramasi) di `_apply_native_kelompok` | rafaksi untuk barang yang **tidak disebut** surat 083: K31CV, K31GL, LT121, F601FL, F601TM | kolom matriks "Strata Account" = SATU barang; parser mengisi kelompok/varian/gramasi master |
| Kunci lebur Form: `DH AIR F` = induk `DH AIR F - HER` | F601AH & F601JO tercetak Heritage (C12) | kedalaman kelompok ikut kunci |
| Penyaring banded hanya `BND` kata utuh | `F601TK-BND ... BDD` ikut dimekarkan (juga di baris 542) | `\b(BND\|BDD)\b` |
| Baris tertahan tanpa benefit & kode dilebur | satu sel 234 lebih tinggi dari halaman → 7 halaman tanpa nomor surat | tidak dilebur (kutipan jadi kunci) |

Penanda baris (`_xxx`) **tidak bertahan** sampai tombol Generate — draft hanya menyimpan
`BARIS_DRAFT`. Satu-satunya sinyal "kode pasti" yang bertahan adalah varian yang **bukan**
ALL VARIANT. Bentuk A (542/570) sengaja tidak disentuh: di sana kolom ITEM adalah kode wakil
varian yang disebut surat, dan pemekarannya memang benar.

Bentuk C (234) sekarang: satu baris per grup, **semua ditahan**, dengan manfaat tertulis, kode yang
disebut surat, dan outlet lampiran (C-BEN007, C-TOP005, C-SI0049); kode kepala lampiran yang tak
bisa dipasangkan tanpa menebak tata letak dicatat pada satu baris lampiran.

---

## 5. Langkah wajib PASCA-DEPLOY — belum dilakukan

1. **Unggah ulang ORDER_DETAIL Kino 16 Sep.** Diskon disimpan saat unggah; batch lama masih membawa
   DISC_5 sebagai persen. Untuk jaringan dan Supra Boga cukup **Validasi ulang**.
2. **Bangun ulang draft Summary DAHLIA September** (unggah ulang suratnya ke draft baru), bila sudah
   ada di produksi. Baris yang terbuang saat disusulkan **tidak kembali** dengan Generate ulang.
3. **Buka menu Normalisasi Diskon di layar.** Belum pernah dibuka di browser — Postgres lokal tidak
   berjalan di mesin pengembang selama sesi ini.
4. SO `1671-SOP-260013234` lawan `...241` (ALFAMART, OVALE ×36 di keduanya) ditahan gerbang order
   ganda — itu **peringatan asli**, konfirmasi lewat tombolnya.

---

## 6. Keadaan produksi (terukur 2026-09-24)

| | |
|---|---|
| PR #89 | merged 2026-09-24T09:15:09Z, `472af77b` |
| Deploy | run `35980143161` success; container frontend+backend dibuat **09:34 UTC**, 0 restart |
| Migrasi | log `[migrate-pg] OK discount_normalization`, tabel ada, **0 baris** |
| Kode | halaman `/normalisasi-diskon` ada di image; backend memuat jati diri baru, `_BANDED`, `_exact_item` |
| `promo_rule` | 249 aturan, tidak disentuh sesi ini |

**Jebakan deploy yang memakan waktu:** workflow "Deploy to Coolify" sukses ≠ sudah hidup. Coolify
baru mengganti container ±20 menit kemudian — periksa `docker inspect .Created`. Repo **menolak
auto-merge GitHub**; merge manual `gh pr merge <n> --merge` setelah membaca vonis tiap check.
Kode backend di container ada di `/app/python_backend/`.

---

## 7. Yang BELUM dikerjakan

### 7.1 Dari sesi ini

| Hal | Keadaan |
|---|---|
| **Target per outlet (234)** | Min. qty dan bonus berbeda per outlet (BENTENG 72 pcs F601TK bonus 6, TOP MURAH 24 bonus 2). Model baris Summary tidak bisa menyatakannya → semua ditahan, tidak terbit. Perlu perluasan model, pekerjaan tersendiri |
| **Rafaksi beda strata (083)** | F607SB, F607TK, K31N ditahan: Diamond 1.500 lawan Gold 1.000. Perilaku lama, disengaja |
| **Invariant Form → surat (arah balik)** | C9 hanya menjamin setiap kode SURAT ada di Form. Kode di Form yang **tidak** disebut surat (over-claim 083) tidak dijaga invariant mana pun — ditemukan lewat analisis tangan. Ini celah uang yang masih terbuka |
| **Normalisasi → Accurate** | Menu hanya menggolongkan di Rekap Promo; faktur Accurate tidak dibetulkan posisinya. Pengguna belum memutuskan perlu atau tidak |
| **`SYSTEM_MAP.md`** | Belum mencatat menu Normalisasi Diskon — berkasnya sedang diubah lokal oleh pengguna |
| `python_backend/kino_discount.py` | Kembaran Python yang masih mengira DISC_n selalu persen. Tidak dipakai jalur mana pun (hanya ujinya sendiri) |

### 7.2 Warisan handover 20 Sep yang masih terbuka

- C12 untuk principal tanpa kode pendek (KINO) — perlu SKIP seperti C9.
- `tools/gate.sh` dan `fixtures/golden/` belum ada; verifier dijalankan manual per surat.
- Grid web belum menandai baris tertahan.
- Parser URC (6 surat), ABC/Heinz (538), GONDOWANGI. Catatan: `urc_benefit_parser.py`,
  `urc_matcher.py`, `urc_pipeline.py` **sudah ada** — blokirnya tata bahasa benefit, bukan nol.
- Cadangan `python_backend/data/cadangan_promo_rule_*.json` hanya di laptop (`.gitignore:52`).

### 7.3 Menunggu keputusan pengguna

- **Surat ber-channel MT untuk outlet NKA?** Sekarang tidak (keputusan 15 Sep "GT = TT saja,
  kategori lain apa adanya"). Tidak ada efek hari ini — satu-satunya surat MT (`BP2609007909`)
  berdaftar outlet INCLUDE dua outlet saja (C-BA0003, C-WA0012) — tetapi akan berefek pada surat
  MT berikutnya.

---

## 8. Gerbang dan bukti

```bash
npm test                                   # 290/290
npx tsc --noEmit --pretty false            # bersih
python -m pyflakes python_backend/*.py python_backend/routers/*.py
python python_backend/run_checks.py        # 53/53
python python_backend/e2e_dahlia_endpoint.py   # exit 0: 10 halaman, identitas tiap halaman, lebar kolom
python tools/verify_form_summary.py \
  --form   python_backend/data/e2e_dahlia_output/Form_Summary_DAHLIA_SEPT2026.pdf \
  --rows   python_backend/data/e2e_dahlia_output/Form_Summary_DAHLIA_SEPT2026.rows.json \
  --master "master_barang_principle/MASTER BARANG DAHLIA.xlsx" \
  --surat  reference_surat_program/sept26/542-*.pdf reference_surat_program/sept26/570-*.pdf \
           "reference_surat_program/sept26/MT Pareto promo_letter_136_dist_882_1787377184 (1).pdf" \
           "reference_surat_program/sept26/MT Silver promo_letter_139_dist_942_1787912657.pdf" \
  --expect-roles Admin SM "Kepala Accounting" Claim "Operational Manager" --strict-kelompok
```

Hasil saat handover ditulis: **GATE HIJAU PENUH 12/12, 0 SKIP**, keempat surat sekaligus —
542 24/24 kode, 570 6/6, 083 11/11, 234 6/6. `next build` sukses. CI PR #89: *Deterministic risk
gate* dan *typecheck* SUCCESS.

Uji mutasi — setiap perbaikan dibuktikan bisa merah: validator 8/8, C9 7/7, parser MT 8/8.

---

## 9. Pelajaran

**Jati diri lebur tanpa barang — ketiga kalinya.** 19 Sep: keterangan hilang di `merge_key`.
20 Sep: keterangan hilang di `append_rows`. 24 Sep: **kode** hilang di `append_rows` yang sama.
Setiap kali baris dilebur berdasarkan jati diri, periksa: apakah jati diri itu memuat BARANG-nya?

**Penambal kekurangan AI merusak parser deterministik.** Pemekaran "ALL VARIANT" dibuat untuk AI
yang menyebut terlalu sedikit kode; ia berlaku juga pada parser yang kodenya pasti, dan
menambah barang yang tidak disebut surat. Periksa penambal hilir setiap kali jalur baru dipasang.

**Mutasi menemukan uji yang lemah.** Penyaring banded `\bBND\b` ternyata juga cocok pada
`F601TK-BND` (tanda hubung = batas kata), jadi mutasi "hanya BND" lolos. Ujinya diperkuat dengan
barang yang hanya bertanda `BDD`. Uji yang tidak pernah merah bukan penjaga.

**Catatan DB bukan kode.** Keputusan "dipindah ke posisi 2" hidup lima hari hanya sebagai kalimat
di kolom `note`; tidak ada kode yang menegakkannya, dan setiap baris Alfamart tertahan selama itu.
Keputusan yang mengubah posisi/beban harus datang bersama kodenya — atau tidak dianggap selesai.

**Gerbang yang "hijau" tetap perlu diadu dengan data nyata.** Gerbang lama 12/12 untuk surat 570/542
padahal 083 dan 234 salah; yang menemukannya menjalankan verifier dengan SEMUA surat principal itu.

---

## 10. Berkas rujukan

- Validator: `lib/order-detail.ts` (`discountsOf`), `lib/principal-validation.ts`
  (`normalisasiJaringan`, `matchTariff`, `JARINGAN_POSISI_BEBAS`), `app/api/principal-order/validate/route.ts`
- Faktur: `lib/principal-invoice.ts` (`percentChain`)
- Normalisasi: `lib/promo-recap.ts` (`recap`, `kunciNormalisasi`), `app/api/promo-recap/normalisasi/route.ts`,
  `app/(dashboard)/normalisasi-diskon/page.tsx`, `db/migrations/0022_discount_normalization.sql`
- Verifier: `tools/verify_form_summary.py`, uji `python_backend/test_verify_form_summary.py`
- Surat MT: `python_backend/dahlia_letter.py`, `summary_store.py` (`append_rows`), `routers/summary.py`
  (`merge_key`), `shared.py` (`_BANDED`), uji `python_backend/test_surat_mt_dahlia.py`
