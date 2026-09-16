"""Tujuan: Perintah "SALIN SAJA" per principal — model membaca struktur surat, matcher yang memutuskan.
Caller: summary_mistral.extract dan routers/summary.py. Dependensi: tidak ada. Murni.
Main Functions: jalur, kontrak. Side Effects: tidak ada.

KENAPA ADA, DAN KENAPA INI BUKAN "PROMPT PER SURAT".
Perintah tunggal yang dipakai sejak September meminta model MENAFSIRKAN: mengisi kelompok,
ketentuan, dan benefit sekaligus. Untuk Kino itu jalan, karena surat Kino memakai kata-kata yang
mirip master kita. Untuk Priskila ia kehilangan kolom PAKET pada blok RETAIL — 33 dari 124 baris
pulang tanpa "Beli 7"/"Beli 4", dan lembar Summary-nya jadi kosong ketentuan.

Perintah di bawah ini tidak meminta tafsiran sama sekali. Model hanya menyalin sel surat APA
ADANYA ke satu field (`group_item_text`, `item_description`, `product_line_text`), lalu matcher
deterministik yang memetakannya ke SKU master. Yang membedakan principal cuma DI SEL MANA teks
itu berada — karena tiap principal menyusun tabelnya sendiri. Itu satu perintah per principal,
sekali, bukan satu per surat.

Dibuat Juli 2026 di `feat/urc-deterministic-matcher`, terbukti benar pada Priskila (golden 118
baris), lalu tidak pernah sampai ke jalur produksi. Disalin ke sini apa adanya.
"""


def jalur(principle_name):
    """Nama jalur matcher deterministik untuk principal ini, atau "" bila jalur lama."""
    nama = str(principle_name or "").upper()
    if "PRISKILA" in nama:
        return "PRISKILA"
    if "URC" in nama:
        return "URC"
    if "FONTERRA" in nama:
        return "FONTERRA"
    if "NATUR" in nama or "GONDOWANGI" in nama:
        return "NATUR"
    if "ADNA" in nama or "GUMINDO" in nama:
        return "ADNA"
    if "FORISA" in nama:
        return "FORISA"
    return ""


PROMPT = {
    "PRISKILA": """
Dokumen promosi ini milik principle: {principle_name.upper()}.
Tugas Anda HANYA menyalin STRUKTUR tabel surat apa adanya ke ARRAY JSON. JANGAN mencocokkan
ke daftar barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris "GROUP ITEM" di tabel surat. DILARANG KERAS menggabungkan
   beberapa baris/varian/merek menjadi satu object. Kalau tabel punya 20 baris GROUP ITEM,
   keluarkan TEPAT 20 object.
3. Salin teks sel "GROUP ITEM" APA ADANYA (verbatim) ke field "group_item_text" -- termasuk
   kata merek, jenis, dan gramasi (mis. "Bellagio Eau de Toilette 100ml"). JANGAN diringkas,
   JANGAN diubah ejaan/satuannya.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "channel_gtmt": (String) nama channel sesuai header tabel (Retail / MTI / Grosir / Star Outlet).
- "brand": (String) merek utama di kolom BRAND baris itu (mis. "BELLAGIO"). Kalau sel BRAND
  kosong karena rowspan, pakai merek yang sama dgn baris di atasnya.
- "group_item_text": (String) sel GROUP ITEM verbatim (lihat aturan 3).
- "paket": (String) sel PAKET verbatim (mis. "7+1", "4+1"). Kalau tabel cut-price MTI tanpa
  kolom PAKET, isi angka CUT PRICE-nya saja (mis. "4700").
- "cr": (String) nilai kolom CR / Cost Ratio kalau ada, selain itu "".
- "principle": (String) nama principle.
- "surat_program": (String) nomor surat program.
- "nama_program": (String) nama program/promo.
- "periode": (String) PERIODE PROGRAM, disalin dari JUDUL/KOP surat (mis. "TRADE PROGRAM
  GT BULAN MARET 2026" -> "MARET 2026"). NILAINYA SAMA UNTUK SETIAP OBJECT tanpa kecuali,
  termasuk baris blok MTI, Grosir, dan Star Outlet: periode dinyatakan SEKALI di kop surat,
  bukan per blok dan bukan per baris.
  DILARANG KERAS mengambilnya dari kalimat batas klaim. Kalimat seperti "claim ... paling
  lambat tanggal 31 September 2026" adalah TENGGAT KLAIM, bukan periode program; ia milik
  field "syarat_claim". Bila blok MTI/Grosir/Star Outlet tidak menuliskan periodenya sendiri,
  SALIN periode dari kop surat -- JANGAN mengosongkannya, dan JANGAN mengarang tanggal.
- "syarat_claim": (String) ringkasan SINGKAT bagian syarat/mekanisme klaim di surat
  (batas waktu klaim + dokumen wajib). Di sinilah kalimat "paling lambat tanggal ..." ditaruh.
  Jika surat tidak punya bagian itu, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
""",
    "URC": """
Dokumen promosi ini milik principle: {principle_name.upper()}.
Tugas Anda HANYA menyalin STRUKTUR surat apa adanya ke ARRAY JSON. JANGAN mencocokkan ke daftar
barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris di tabel "Details SKU" (kolom Details SKU + Category).
   Kalau tabelnya punya 20 baris, keluarkan TEPAT 20 object.
3. Salin teks sel "Details SKU" APA ADANYA (verbatim) ke field "item_description" --
   termasuk nama produk dan gramasi (mis. "Lexus Cheese 76g x 24"). JANGAN diringkas,
   JANGAN diubah ejaan/satuannya.
4. Field "nama_program" diambil dari baris "Nama Program" di header surat (satu nilai
   yang SAMA untuk semua object -- surat ini hanya punya SATU program/benefit, dinyatakan
   sekali di header, BUKAN per baris tabel).
5. ABAIKAN SELURUH tabel lampiran/alokasi kuota per RD/kota/bulan (biasanya di halaman
   setelah tabel "Details SKU", berjudul "Lampiran" dengan kolom Area/City/RD/QTY ED per
   bulan). JANGAN membacanya, JANGAN mengekstrak isinya ke JSON manapun.
6. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "nama_program": (String) isi baris "Nama Program" di header surat, verbatim.
- "item_description": (String) sel "Details SKU" verbatim (lihat aturan 3).
- "category": (String) sel "Category" pada baris yang sama (mis. "Small pack", "Medium pack").
- "principle": (String) nama principle.
- "surat_program": (String) nomor surat di kop surat (baris "No. ..." di bawah judul
  AUTHORIZATION LETTER, mis. "004/178/URC/MT/VII/25").
- "periode": (String) isi baris "Periode" di header surat, verbatim.
- "channel_gtmt": (String) isi baris "Area Program" di header surat, ringkas (mis.
  "National MTI" -- tanpa kalimat keterangan dalam kurung).
- "syarat_claim": (String) ringkasan SINGKAT bagian "Mekanisme Kontrol & klaim": batas
  waktu klaim + dokumen yang wajib dilampirkan (mis. "Klaim maks 45 hari setelah promo
  berakhir; lampiran: AL, Cover Klaim URC, Faktur Pajak, Rekap Data Penjualan & print out
  system; nilai dari DBP/RBP exc PPN"). Jika bagian itu TIDAK ADA di surat, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
""",
    "FONTERRA": """
Dokumen promosi ini milik principle: {principle_name.upper()}.
Tugas Anda HANYA menyalin STRUKTUR surat apa adanya ke ARRAY JSON. JANGAN mencocokkan ke daftar
barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris promo produk (baris bullet ">" berpola
   "BELI N <PRODUK> <GRAMASI> ... GRATIS <HADIAH>"). Kalau surat punya 17 baris promo,
   keluarkan TEPAT 17 object. JANGAN menggabung, JANGAN melewatkan baris.
3. Salin baris promo VERBATIM (termasuk kata BELI, angka, gramasi, GRATIS, dan hadiahnya)
   ke field "product_line_text". JANGAN diringkas, JANGAN diubah ejaan/satuannya.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "product_line_text": (String) baris promo verbatim (lihat aturan 3).
- "principle": (String) nama principle.
- "surat_program": (String) nomor/identitas surat program di kop.
- "nama_program": (String) nama program/promo di header surat.
- "periode": (String) periode program, verbatim.
- "channel_gtmt": (String) channel program (mis. MTI / GT), ringkas.
- "syarat_claim": (String) ringkasan SINGKAT syarat/mekanisme klaim (dokumen wajib +
  batas waktu). Jika surat tidak punya bagian itu, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
""",
    "ADNA": """
Dokumen promosi ini milik principle: {principle_name.upper()} (PT Gumindo Bogamanis, merek Kuaci Rebo).
Tugas Anda HANYA menyalin STRUKTUR surat apa adanya ke ARRAY JSON. JANGAN mencocokkan ke daftar
barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU aturan pembelian produk di bagian "Mekanisme Program"
   (kalimat berpola "Setiap pembelian <PRODUK+GRAMASI> (min N ctn) ... maka mendapatkan
   disc <NILAI>"). Kalau ada 2 aturan produk, keluarkan TEPAT 2 object.
   JANGAN membuat object untuk kalimat yang bukan aturan pembelian produk
   (mis. syarat growth, cara klaim, penutup surat).
3. Salin bagian PRODUK + GRAMASI verbatim ke "product_line_text", termasuk bila satu
   aturan menyebut DUA gramasi (mis. "Kuaci Rebo 150 gr/ 140 gr"). JANGAN dipecah,
   JANGAN diringkas, JANGAN diubah satuannya.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "product_line_text": (String) produk + gramasi verbatim (lihat aturan 3).
- "minimal_order": (String) minimal pembelian berikut SATUANNYA, verbatim (mis. "2 ctn").
  Jika tidak disebut, "".
- "discount": (String) benefit baris itu verbatim (mis. "disc Rp. 24.500/ctn"). Jika tidak ada, "".
- "principle": (String) nama principle.
- "surat_program": (String) nomor surat di kop (mis. "0074/GBM/MKT/V/24-Rev1").
- "nama_program": (String) isi baris "Hal" di kop surat, verbatim.
- "periode": (String) isi baris "Berlaku", verbatim.
- "channel_gtmt": (String) isi baris "Lokasi" (mis. "Nasional").
- "syarat_claim": (String) ringkasan SINGKAT syarat klaim (dokumen wajib + batas waktu
  klaim grosir/subdist). Jika bagian itu TIDAK ADA, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
""",
    "NATUR": """
Dokumen promosi ini milik principle: {principle_name.upper()} (merek NATUR, AZALEA, HG).
Tugas Anda HANYA menyalin STRUKTUR tabel surat apa adanya ke ARRAY JSON. JANGAN mencocokkan
ke daftar barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris produk/SKU di tabel promo surat. Kalau tabel punya 20
   baris produk, keluarkan TEPAT 20 object. JANGAN menggabung, JANGAN melewatkan baris.
3. Salin sel nama produk VERBATIM (termasuk merek dan gramasi, mis.
   "NATUR SHAMPOO GINSENG 140ML") ke field "product_line_text". JANGAN diringkas,
   JANGAN diubah ejaan/satuannya.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "product_line_text": (String) sel nama produk verbatim (lihat aturan 3).
- "minimal_order": (String) nilai kolom minimal order/pembelian baris itu, verbatim
  (mis. ">= 6", "6"). Jika tidak ada, "".
- "discount": (String) nilai kolom diskon/benefit baris itu, verbatim
  (mis. "5%", "add disc 5%", "1+1"). Jika tidak ada, "".
- "principle": (String) nama principle.
- "surat_program": (String) nomor surat program (biasanya diawali "PROID").
- "nama_program": (String) isi bagian "Nama Program", verbatim.
- "periode": (String) periode program, verbatim.
- "channel_gtmt": (String) channel dari nomor surat: "/MTI/" -> "MTI", "/GT/" -> "GT",
  "/ONLINE/" -> "ONLINE"; selain itu "".
- "syarat_claim": (String) ringkasan SINGKAT syarat klaim (mis. kalimat "maksimal
  diklaim ..."). Jika surat tidak punya bagian itu, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
""",
}

# Field yang diminta tiap perintah; diambil dari teks perintahnya sendiri supaya skema
# JSON dan perintahnya tidak akan pernah berbeda pendapat.
BIDANG = {
    "PRISKILA": ['brand', 'channel_gtmt', 'cr', 'group_item_text', 'nama_program', 'paket', 'periode', 'principle', 'surat_program', 'syarat_claim'],
    "URC": ['category', 'channel_gtmt', 'item_description', 'nama_program', 'periode', 'principle', 'surat_program', 'syarat_claim'],
    "FONTERRA": ['channel_gtmt', 'nama_program', 'periode', 'principle', 'product_line_text', 'surat_program', 'syarat_claim'],
    "ADNA": ['channel_gtmt', 'discount', 'minimal_order', 'nama_program', 'periode', 'principle', 'product_line_text', 'surat_program', 'syarat_claim'],
    "NATUR": ['channel_gtmt', 'discount', 'minimal_order', 'nama_program', 'periode', 'principle', 'product_line_text', 'surat_program', 'syarat_claim'],
}

# FORISA memakai perintah generik yang sama dengan FONTERRA (keduanya baris "BELI N ... GRATIS").
PROMPT["FORISA"] = PROMPT["FONTERRA"]
BIDANG["FORISA"] = BIDANG["FONTERRA"]


def kontrak(nama_jalur, principle_name):
    """(daftar field, teks perintah) untuk jalur ini."""
    teks = PROMPT[nama_jalur].replace("{principle_name.upper()}", str(principle_name or "").upper())
    return BIDANG[nama_jalur], teks
