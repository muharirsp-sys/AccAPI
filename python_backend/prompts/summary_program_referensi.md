<!--
Tujuan       : Daftar keputusan pemilik yang MENGIKAT untuk ekstraksi surat program -> summary_program.
               Dikirim ke model sebagai REFERENSI_KEPUTUSAN, supaya peringatan yang sudah diputuskan tidak muncul lagi tiap bulan.
Caller       : Pemanggil prompt_summary_program.md (bagian 2, {{REFERENSI_KEPUTUSAN}}): kirim bagian "Lintas principal"
               + bagian principal yang sedang diproses.
Dependensi   : prompt_summary_program.md, summary_program.schema.json.
Main Functions: L01-L22 (aturan lintas principal), satu bagian per principal.
Side Effects : Tidak ada (file teks). Tambah entri baru setiap kali pemilik menjawab peringatan; jangan hapus jejak tanggal/sumber.
-->

# Referensi keputusan Summary Program

Cara pakai:
- Hal yang sudah diatur di sini **tidak dibuat flag perlu_cek**. Cukup flag `info` yang menyebut nomor aturannya,
  mis. `SELESAI L08: berlaku kelipatan`.
- Bila bunyi surat **jelas berbeda** dari keputusan (mis. surat menyebut "tidak berlaku kelipatan"), yang menang adalah surat,
  dan buat flag `tidak_konsisten`.
- Rilis hanya bila tidak ada flag `kritis`/`perlu_cek` (sel kuning). Peringatan baru yang dijawab pemilik ditambahkan ke file ini.

## Lintas principal

| No | Aturan | Sumber |
|---|---|---|
| L01 | Kode stok bonus berakhiran **B** (nama Accurate diawali `B>`) **tidak ikut** program, walau satu kelompok dan gramasi. Bila kode master suatu barang hanya versi B, rule jadi tanpa kode dan diberi flag: cari kode jual di Accurate (sering berakhiran N). | Pemilik 28 Okt 2026 (perluasan keputusan P> 14 Okt) |
| L02 | Kode kemasan promo URC **P>** (berakhiran P) tidak ikut program. Untuk L01 dan L02: `kelompok_barang` dan `gramasi` hanya dari kode yang tersisa (bukan "PIATTOS, P> PIATTOS" atau gramasi kode B/P>). | Pemilik 14 Okt 2026; form 29 Okt 2026 |
| L03 | Kode **banded/BND/BDD** ikut hanya bila surat menyebut banded (mis. "berlaku juga untuk stock banded barcode sama"). Surat diam atau mengecualikan banded: keluar. | Pemilik 28 Okt 2026 |
| L04 | Porsi **beban distributor** yang tertulis di surat masuk rantai benefit sebagai komponen ber-`beban: distributor` (mis. Vinda `15+5+20`, Gondowangi `7+12,1372%`, MSM Amago `8+3+1,5%`). Keterangan menyebut bagian distributor; klaim ke principal dikurangi bagian itu. | Pemilik 16 Okt (Vinda), diperluas 28 Okt 2026 |
| L05 | Batas, dasar, atau dokumen klaim **tidak tercantum** di surat: `batas_klaim_aturan` = "Tidak tercantum di surat - ikut ketentuan klaim principal". Tidak menahan rilis. | Pemilik 28 Okt 2026 |
| L06 | Program yang periodenya **sudah selesai** sebelum tanggal proses tetap dicetak sebagai arsip klaim, tetapi tidak disetting. Program periode lalu (mis. kuartal sebelumnya) tanpa surat perpanjangan dikeluarkan dari summary bulan berjalan. | Pemilik 28 Okt 2026 |
| L07 | Program "hanya toko terlampir/terdaftar" yang daftarnya belum ada: Form terbit, tetapi aturan tidak memotong faktur siapa pun sampai daftar diunggah (gagal tertutup). Bila surat menyebut channel luas sekaligus "hanya toko terlampir", **daftar yang menang**. | Pemilik 28 Okt 2026 |
| L08 | Paket bonus atau potongan per paket yang surat **tidak menyebut kelipatan** = **berlaku kelipatan**, dibatasi maks bila surat menyebut maks (mis. Dahlia "max bonus 12 pcs"). Strata bertingkat dengan "berlaku kelipatan": sisa di atas strata tertinggi dihitung ulang dari strata bawah (URC Cloud9: 44 CS = 1 CS + 5 db). | Pemilik 28 Okt 2026 |
| L09 | Tanda `>` di awal strata dibaca **minimal** (>=). Batas atas = minimum strata berikutnya - 1; strata terakhir ditulis "UP" (mis. Rp300.000 - Rp499.999, Rp500.000 UP; 500 - 1199, 1200 CTN UP). | Summary Fonterra Juni 2026 bertanda tangan; aturan S pemilik 8 Okt |
| L10 | Bila **tabel rinci** bertentangan dengan judul atau teks mekanisme, yang dipakai tabel (URC 023: judul "min. buy 24 CS", tabel bonus mulai 4 CS; Vinda: teks 1-5/6-10 ctn, tabel <2 ... >1200 ctn). | Summary Okt 2026 yang ditinjau pemilik |
| L11 | "MIX VARIANT" = campur varian **gramasi sama**, kecuali surat menyebut beda gramasi. Paket "beli N + bonus M" yang tidak menyebut campur: boleh mix kelompok & gramasi sama, satuan PCS, bonus = barang yang sama. | Pemilik 7 Okt 2026; acuan Priskila Maret, pemilik 28 Okt 2026 |
| L12 | **ALL VARIANT eksklusif**: baris umum = semua varian **kecuali** yang dipegang baris lain pada surat dan kelompok yang sama (mis. Regazza EDT umum tanpa varian Sport). | Pemilik 16 Sep 2026 |
| L13 | Surat yang menyebut **kelas harga** (eceran/HET "1000", "2000"), bukan gramasi: pakai daftar kode di bagian principal di bawah. Kode baru yang tidak ada di daftar = flag perlu_cek. | Pemilik 28 Okt 2026 (daftar Summary Okt 2026 yang ditinjau 14 Okt, minus L01/L02) |
| L14 | Summary hanya memuat **diskon (% / Rp) + bonus barang produk yang on faktur**. Benefit `voucher`, `gimmick` (tumbler, Sipahh/sedotan, cutting box, mug, barang non-produk) dan `sewa_display` (sewa pajangan, lampion) **tidak masuk summary**; **kecuali sewa hanger permanent** (komponen "Sewa hanger"), yang dibayar on faktur dan tetap masuk (pemilik 29 Okt 2026; `OUT_OF_SCOPE` produksi masih memuat HANGER, sesuaikan saat port). Yang keluar: tidak dicetak di Form, tidak disetting. Tetap diekstrak dengan tipe yang benar, lalu dibuang kode (`luar_cakupan`) dan dilaporkan dalam satu flag info `di_luar_cakupan` (bukan hilang diam-diam). Program yang isinya hanya itu (mis. Fonterra F148SP voucher + gimmick) keluar seluruhnya. | Pemilik 19 Jul 2026 (`generic_promo_pipeline.OUT_OF_SCOPE`); ditegaskan ulang 29 Okt 2026 |
| L15 | Barang yang tidak ada di master: **cek dulu tabel item Accurate** (baca-saja) sebelum menyimpulkan tidak ada. Tetap tidak ada: rule tanpa kode, dicetak bertanda, tidak disetting. | Pemilik 28 Okt 2026 |
| L16 | "Setiap Pengambilan" = tanpa minimum, satuan apa pun. | Pemilik 16 Okt 2026 |
| L17 | CTN/CS/karton = **KRT** Accurate. | Pemilik 14 Okt 2026 |
| L18 | Surat yang diunggah/diminta = **on faktur** ("ON PO = ON Faktur"); kata mekanisme dicatat, bukan penyaring. | Pemilik 18 Sep 2026 |
| L19 | SUMMARY_LAMA hanya pembanding. Beda dengan Summary lama diselesaikan dengan membuktikan bunyi surat (kutipan); yang menang surat + aturan di file ini. | Prompt bagian 1 |
| L20 | Mesin on faktur menilai strata **per order/faktur**. ABC PI: surat menulis kumulatif sebulan, tetap dihitung per order, selisih lewat klaim. Principal lain yang suratnya menyebut akumulasi: flag perlu_cek, tanyakan dulu. | Pemilik 19 Okt 2026 (ABC PI) |
| L21 | Teks sisa surat lama (bulan/tahun lain di badan surat) tidak mengubah periode; periode mengikuti kop/tabel periode. | Konvensi pembacaan (flag info) |
| L22 | Bila label master bertentangan dengan nama barang di Accurate untuk kode yang sama, **nama Accurate yang menang**. | Bukti tabel item Accurate 28 Okt 2026 |

## Per principal

### ABC PI
- SIAPI diabaikan; program tidak dibatasi daftar outlet. Paperpack = dua NU TEA 225ML "PO", dikecualikan. Food (Bag) = NDB + NDB - GURIMI saja
  (tanpa cup, mangkok, kecap). Strata per order (L20). Pemilik 19 Okt 2026.
- "Cluster A" = satu-satunya tabel strata di surat untuk distributor ini.
- **KIN bukan lagi produk Surya Perkasa**: kode KIN (mis. KIN - DAIRY) dikeluarkan dari program walau surat menyebutnya;
  Beverages = NU saja (mix antar-varian NU, bukan lintas merek). Pemilik 29 Okt 2026.

### DAHLIA
- Core/Fresh Signature **tidak boleh dicampur** Heritage untuk mencapai minimum (pemilik 16 Okt 2026).
- Heritage = `DH AIR F - HER` + `H ARUM DALU 70GR` (nama principal: "Heritage Cendana Padmasana/Teh Keraton", "Heritage Arum Dalu").
  Fresh Signature = AF Gel 55GR (Apple Harmony, Fresh Lychee, Tropical Melon, Jolly Orange). Core = AF Gel 75GR non-Heritage.
- Strata "≥ 144 pcs / 6 krt": ambang **144 PCS**; "6 krt" hanya catatan kemasan isi 24 (pemilik 28 Okt 2026).
- Strata **Rejuve** ditahan (rule tanpa kode) sampai Dahlia mengirim daftar SKU Rejuve (pemilik 28 Okt 2026).
- "Add. Discount 0.05" = **5%** (pemilik 28 Okt 2026). Surat GT mengecualikan banded; surat MT diam, jadi banded juga keluar (L03).

### FONTERRA
- Apotik "ALL PRODUK POWDER (BIB)" = semua susu bubuk **box** kecuali sachet (bukan UHT, keju, Anlene Total 10 kaleng, polybag);
  Grosir Bintang & sewa pajangan = semua produk; stickpack = ANLENE ACTIFIT POLYBAG 30/32GR. Revisi pemilik 19 Okt 2026.
- MATERNA = MATNA; ANLENE GOLD "800GR" = master 850GR & 825GR; Habbat "560 GR" = HABATUSSAUDA 580GR (F2020040580010).
- 1 RTG = 10 SCH. "Beli 6 renceng discount Rp3.000" = Rp3.000 per 6 RTG, berlaku kelipatan (L08).
- Lampion, sewa pajangan grosir (+0,5% / +1%) dan seluruh F148SP MT (voucher + gimmick) di luar cakupan (L14);
  yang dicetak: provision Rp3.000/6 RTG, hanger permanent Rp25.000/bulan & tambahan Rp50.000/3 bulan (on faktur),
  pharmacy 3%/5%, grosir bintang 2,5%/3%/4%. Pemilik 29 Okt 2026.

### GONDOWANGI (NATUR / AZALEA / HG)
- NATUR SHAMPOO ARGAN OIL 140ML = **19011040140000** "NATUR SHMP ARGAN OLIVE OIL 48 PCS X 140ML" (pemilik 28 Okt 2026).
- NATUR COND. ARGAN OIL & OLIVE OIL 160ML: **tanpa kode**; 19013050165000 di Accurate bernama MORINGA ARGAN OIL, bukan barang ini (pemilik 28 Okt 2026).
- NATUR COND ALOE VERA 165ML = **19013010165000**; COND GINSENG 165ML = 19013020165000. Master NATUR menukar keduanya (L22).
- NATUR HAIR VIT ARGAN 80ML = 19014020080000N. AZALEA Zaitun Oil 135ML = kode kemasan baru isi 24 (berakhiran N).
- Existing Outlet "24+1 / 10+1 / 12+1" = **bonus barang** yang sama walau mekanisme menulis "diskon on invoice" (pemilik 28 Okt 2026).
- Surat menyebut banded ikut (L03); paket 013 = rantai Disc Distributor 7% + Disc Gondowangi 12,1372% (L04).

### GUMINDO (ADNA)
- "All Variant HET 1000" (L13) = 17011010013000, 17011020013000, 17011030013000, 17011060013000, 17011040010000.

### MSM
- Amago "TPR x% + Add disc y%" = **bertingkat**; beban TPR principal (pemilik 28 Okt 2026). Porsi add disc distributor masuk rantai (L04).

### PRISKILA
- Casablanca Deo Body Spray 150ml = `P DEO` + `P DEO B. MIST` (nama principal: "Perfumed Deodorant Body Spray Pink Crush / White Clouds").
- Regazza EDT Sport 100ml = REGAZZA FM - EDT varian AZZURO/BIANCO/NERO/ROSSO; Regazza EDT umum = sisanya (L12);
  REGAZZA SPORT COLOGNE adalah cologne, bukan EDT.
- Casablanca Spray Cologne Series = WHITE SR + BLACK SR (SR = Series); GLASS dikecualikan (pemilik 15 Jul 2026).
- Paket N+M: L11 + L08. Kode BND keluar kecuali surat menyebut banded (L03).

### PURATOS
- **Ditahan** (pemilik 28 Okt 2026): tidak dirilis sampai surat utuh diterima; lampiran 1/2/4 terpotong dan tabel Diskon Launching tanpa kop.
- Aristo Croissant 10x1Kg (SKU 4029255) = **37011011001000**. Coldfil Strawberry/Blueberry 1KG tidak ada di Accurate (hanya 5KG/25KG).
- Kode Accurate Puratos memuat SKU principal di nama (`"4029255"`): cocokkan lewat SKU surat lebih dulu.

### URC
- 029/030 (periode Q3, Jul-Sep 2026) **dikeluarkan** dari Summary Oktober; tanpa surat perpanjangan tidak disetting (L06, pemilik 28 Okt 2026).
- Kelas harga (L13), tanpa P>/B:
  - Piattos 2000 = 76020010015000, 76020040015000, 76020070050002, 76020010018000, 76020020018000, 76020020018001, 76020040018000,
    76020070018000, 76020010020000, 76020020020000, 76020070020000. Piattos 13GR+7G promo (76020010013004, 76020040013004) **tidak** ikut.
  - Poppins 2000 = 76040010016000, 76040020016000, 76040010020000, 76040010022000.
  - KING 2000 = 76240010015000, 76240010015000N, 76250010015000, 76261010015000 (tanpa CHIZ KING).
  - Cloud 9 1000 = 76093010014000, 76093010015003, 76093030015003, 76093040015003.
  - Piattos Big Pack 65/68/75GR = kode 68/70/75GR isi 30 PCS (26 kode, lihat Summary Okt 2026); Piattos DUO 50GR tidak ikut.
- "Buy 4 CS free 1 renceng" berlaku kelipatan (L08); Cloud9 bonus satuan "db" = display box (L10 untuk judul vs tabel).

### VINDA
- Benefit = rantai Disc-1 + Bgt DB + Claim (mis. `15+5+20`); Bgt DB beban distributor (pemilik 16 Okt 2026). Disc-1 menggantikan
  Disc. Strata Reguler, jadi jangan dipotong dobel.
- Strata: <=1 / 2-24 / 25-100 / 101-300 / 301-499 / 500-1199 / 1200 CTN UP (L09). Lock volume 25+1 berlaku kelipatan, bonus SKU sama (L08).
- Deluxe FT SP 3PLY L 16x(2x330) strata 1200 UP = Claim **29,8%** sesuai surat (lebih kecil dari 33,3%); konfirmasi ke Vinda tetap diminta
  (pemilik 28 Okt 2026).
