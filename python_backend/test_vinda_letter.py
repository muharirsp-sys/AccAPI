"""Tujuan: Self-check parser surat SKP Vinda (deterministik, tanpa OCR).
Caller: `python test_vinda_letter.py`. Dependensi: vinda_letter.
Main Functions: main; assert klasifikasi on-faktur, penahanan SKU tak bernama, dan
pencocokan barang master by pack-size untuk kedua surat SKP Vinda nyata (Sept 2026).
Side Effects: tidak ada. Teks di bawah adalah salinan verbatim lapisan teks (pypdf) surat asli
`13. SKP Strata disc GT  LKA  Jul-Sep'26.pdf` dan `08 2026_SKP On Faktur Channel GT-Addendum
CV. Surya Perkasa.pdf` di reference_surat_program/sept26/ (berkas itu sendiri TIDAK ikut git).
"""
import sys

sys.path.insert(0, ".")
from vinda_letter import parse_text, match_items  # noqa: E402

# Surat 1: strata nasional, TIDAK menyebut on faktur, dan "exclude 3 SKU GT" tanpa menamai SKU.
STRATA_GTLKA = """
PT. VINDA Int’l Indonesia,
Graha Mustika Ratu Lt.7,
Jl Gatot Subroto Kav 74-75
DKI Jakarta
 PT VINDA INTERNATIONAL  INDONESIA

 SURAT KESEPAKATAN PROMO
013/PTVI/GTLKA/VI/2026

Nama  : Baskoro - PT VINDA INTERNATIONAL INDONESIA
PIC/Posisi  : Head Of Sales
Alamat  : Jakarta
email/ Ph  : Baskoro@vinda.com/ 0877 7403 4888


Strata Disc GTLKA

PERIODE CHANNEL SKU MEKANISME
01JUL’26-30SEP’26 GTLKA
All SKU Vinda exclude
3 SKU GT
1-5 CTN : Disc 10%
6-10 CTN : Disc 12%
10 CTN Up : Disc 15%
3 SKU GT
1-5 CTN : Disc 5%
6-10 CTN : Disc 7.5%
10 CTN Up : Disc 10%


Pembayaran :
   Potong tagihan Distributor masing masing area
   Harap dilampirkan data sell out dari toko terkait

Catatan :
 SKP ini merupakan surat konfirmasi promo dan pemberitahuan kepada
Mitra All Distributor ( Nasional )  untuk dapat menerima claim dari promo ini.

Pihak PT Vinda International Indonesia

Jakarta 15 June 2026

Sales Director    Country Head   Manager Finance

    Baskoro     Abraham Nandiwardhana  Qiswanto Sinaga
x"""

# Surat 2: addendum per-distributor (CV Surya Perkasa), on faktur eksplisit, 5 baris barcode +
# program "Lock Volume 25ctn FREE 1ctn" berlaku untuk kelima produk itu.
ADDENDUM_SURYA = """
PT. Vinda International Indonesia
Jl. M.H Thamrin No.31,Kel. Kebon Melati, Kec. Tanah Abang, Kota Jakarta Pusat DKI

SURAT KESEPAKATAN PROMO
                                              041/EXTERNAL/TRADEPROMO/GT/DISTRIBUTOR/VII/2026-ADDENDUM

Nama : Baskoro
Jabatan : Sales Director
Alamat : PT. Vinda International Indonesia - Jl. M.H Thamrin No.31,Jakarta Pusat
Email  : baskoro@vinda.com
Background : -Meningkatkan distribusi dan penjualan selling out distributor untuk channel GT
Mekanisme : -Diskon on faktur untuk outlet GT
   -Strata pengambilan 25 free 1 berlaku untuk pengambilan >25ctn
Periode : 01 Aug 2026 – 30 Sep 2026
Distributor : CV. Surya Perkasa
Area : Sulawesi Selatan



Kelengkapan dokumen :
1. Klaim atas diskon on faktor (purchase order) melampirkan faktur/invoice dari distributor ke toko


Demikian surat ini kami buat dan digunakan sebagaimana mestinya. Atas perhatiannya kami ucapkan
terima kasih.


PT. Vinda International Indonesia


Jakarta, 30 Juli 2026






                       Ivander Gervais                           Cipta Pratama                            Baskoro
                                ASM                                          RSM      Sales Direct
Surya Perkasa - per 01 Aug
Inc.PPn Inc.PPn Inc.PPn Inc.PPn Inc.PPn Inc.PPn
6901236334805 VINDA DELUXE FT TP 3PLY S 96x150PLY 3,917                     4,348                   96 (392)       (212)       6.0% 3,304                                               3,304                                               3,043                                               2,783                                               2,609                                               2,348                                               25 1
6901236334812 VINDA DELUXE FT SP 3PLY L 16x(2x330PLY) 15,856                   17,600                 16 (1,586)   (856)       6.0% 11,679                                            11,679                                            11,405                                            10,261                                            10,000                                            9,879                                               25 1
 6901236334799 VINDA DELUXE FT SP 3PLY L 36x480PLY 9,117                     10,120                 36 (912)       (738)       9.0% 6,784                                               6,784                                               6,608                                               6,348                                               6,174                                               5,913                                               25 1
 6901236334836 VINDA CLASSIC FT SP 2PLY L 32x400PLY 8,324                     9,240                   32 (832)       (674)       9.0% 6,184                                               6,184                                               6,007                                               5,478                                               5,304                                               5,043                                               25 1
 6901236334829 VINDA CLASSIC FT SP 2PLY L 24x320PLY 6,501                     7,216                   24 (650)       (527)       9.0% 5,240                                               5,240                                               4,803                                               4,609                                               4,435                                               4,329                                               25 1
>101 ctn - 300 ctn
Barcode Product
RBP *Reguler
Isi / Ctn
10.0%
Exc. PPN Inc. PPN Claim RBP RBP RBP RBP RBP
PROGRAM: Lock Volume
Pembelian 25ctn FREE 1ctn
>301 ctn - 499 ctn >500ctn >1200ctn
Bgt DB
>2ctn - <=24ctn >25 ctn - <=100 ctn
RBP"""

# Potongan relevan master_barang_principle/MASTER BARANG VINDA.xlsx (shape shared._parse_master_barang_xlsx
# menghasilkan: kelompok = "KLP - SubKLP - SubKLP2", variant = Aroma/Rasa, gramasi = Gramasi).
MASTER_ITEMS = [
    {"kode_barang": "V1012101015010", "nama_barang": "VINDA SOFT PACK DELUXE FACIAL S 150S X 96 PCS",
     "kelompok": "VINDA SOFT PACK - DELUXE - FACIAL", "variant": "S", "gramasi": "150S"},
    {"kode_barang": "V1012103066010", "nama_barang": "VINDA SOFT PACK DELUXE FACIAL L 660S X 16 PCS",
     "kelompok": "VINDA SOFT PACK - DELUXE - FACIAL", "variant": "L", "gramasi": "660S"},
    {"kode_barang": "V1012103048010", "nama_barang": "VINDA SOFT PACK DELUXE FACIAL L 480S X 36 PCS",
     "kelompok": "VINDA SOFT PACK - DELUXE - FACIAL", "variant": "L", "gramasi": "480S"},
    {"kode_barang": "V1013103040010", "nama_barang": "VINDA SOFT PACK CLASSIC FACIAL L 400S X 32 PCS",
     "kelompok": "VINDA SOFT PACK - CLASSIC - FACIAL", "variant": "L", "gramasi": "400S"},
    {"kode_barang": "V1013103032010", "nama_barang": "VINDA SOFT PACK CLASSIC FACIAL L 320S X 24 PCS",
     "kelompok": "VINDA SOFT PACK - CLASSIC - FACIAL", "variant": "L", "gramasi": "320S"},
    # Umpan (foil): kelompok/variant sama tapi isi/ctn beda -- HARUS tidak dipilih untuk baris manapun.
    {"kode_barang": "V1012102048010", "nama_barang": "VINDA SOFT PACK DELUXE FACIAL M 480S X 36 PCS",
     "kelompok": "VINDA SOFT PACK - DELUXE - FACIAL", "variant": "M", "gramasi": "480S"},
]


def main():
    # ---- Surat 1: ON PO = ON FAKTUR -------------------------------------------------------
    # Surat ini TIDAK pernah mencetak kata "on faktur". Barisnya TETAP harus dibuat: yang
    # diunggah/diminta itulah pernyataan on-fakturnya (keputusan pengguna 2026-09-18).
    # Yang ditahan hanya CAKUPAN BARANG-nya, karena "exclude 3 SKU GT" tidak menamai SKU-nya.
    strata = parse_text(STRATA_GTLKA)
    assert strata["on_faktur"] is False, strata
    assert strata["rows"], "surat tanpa kata 'on faktur' TETAP harus menghasilkan baris"
    assert strata["letter"]["surat_program"] == "013/PTVI/GTLKA/VI/2026", strata["letter"]
    assert (strata["letter"]["periode_start"], strata["letter"]["periode_end"]) == ("2026-07-01", "2026-09-30"), strata["letter"]

    # Dua blok cakupan x tiga tingkat = enam baris, tiap tingkat memakai batas BAWAH-nya.
    assert len(strata["rows"]) == 6, [(r["ketentuan"], r["benefit"]) for r in strata["rows"]]
    tingkat = [(r["ketentuan"], r["benefit_type"], r["benefit"]) for r in strata["rows"]]
    assert tingkat == [("Beli 1 CTN", "DISC_PCT", "10"), ("Beli 6 CTN", "DISC_PCT", "12"),
                       ("Beli 10 CTN", "DISC_PCT", "15"), ("Beli 1 CTN", "DISC_PCT", "5"),
                       ("Beli 6 CTN", "DISC_PCT", "7.5"), ("Beli 10 CTN", "DISC_PCT", "10")], tingkat
    # Tiga tingkat pertama milik blok "All SKU ... exclude 3 SKU GT", tiga sisanya blok "3 SKU GT".
    assert "exclude" in strata["rows"][0]["_scope_text"].lower(), strata["rows"][0]
    assert "exclude" not in strata["rows"][3]["_scope_text"].lower(), strata["rows"][3]
    # Cakupan barang ditahan (bukan ditebak), dan sebabnya tertulis di baris.
    assert all(r["kelompok"] == "" and r["kode_barangs"] == "" for r in strata["rows"]), strata["rows"]
    assert all("CAKUPAN BARANG DITAHAN" in r["keterangan"] for r in strata["rows"]), strata["rows"][0]
    assert any("exclude 3 SKU" in w for w in strata["warnings"]), strata["warnings"]

    # ---- Surat 2: on faktur eksplisit, 5 baris produk, bonus Lock Volume 25+1 ---------------
    addendum = parse_text(ADDENDUM_SURYA)
    assert addendum["on_faktur"] is True, addendum
    assert addendum["letter"]["surat_program"] == "041/EXTERNAL/TRADEPROMO/GT/DISTRIBUTOR/VII/2026-ADDENDUM"
    assert addendum["letter"]["periode_start"] == "2026-08-01" and addendum["letter"]["periode_end"] == "2026-09-30", addendum["letter"]
    assert len(addendum["rows"]) == 5, addendum["rows"]
    assert all(r["benefit_type"] == "BONUS_QTY" and r["ketentuan"] == "Beli 25 CTN" and r["benefit"] == "1 CTN"
               for r in addendum["rows"]), addendum["rows"]

    expect = [
        ("VINDA SOFT PACK - DELUXE - FACIAL", "S", "150S", "96"),
        ("VINDA SOFT PACK - DELUXE - FACIAL", "L", "660S", "16"),
        ("VINDA SOFT PACK - DELUXE - FACIAL", "L", "480S", "36"),
        ("VINDA SOFT PACK - CLASSIC - FACIAL", "L", "400S", "32"),
        ("VINDA SOFT PACK - CLASSIC - FACIAL", "L", "320S", "24"),
    ]
    got = [(r["kelompok"], r["variant"], r["gramasi"], r["_isi_ctn"]) for r in addendum["rows"]]
    assert got == expect, got

    # ---- Pencocokan ke master: SATU kode per baris, tepat, bukan tebakan ---------------------
    matched = match_items([dict(r) for r in addendum["rows"]], MASTER_ITEMS)
    kodes = [r["kode_barangs"] for r in matched]
    assert kodes == ["V1012101015010", "V1012103066010", "V1012103048010",
                      "V1013103040010", "V1013103032010"], kodes
    assert not any(r.get("_vinda_unmatched") for r in matched), matched

    # Ambiguitas: dua kandidat kelompok+variant+gramasi sama -> DITAHAN, bukan pilih sembarang.
    ambiguous_master = MASTER_ITEMS + [
        {"kode_barang": "V-DUPLIKAT", "nama_barang": "VINDA SOFT PACK DELUXE FACIAL S 150S X 96 PCS (DUP)",
         "kelompok": "VINDA SOFT PACK - DELUXE - FACIAL", "variant": "S", "gramasi": "150S"},
    ]
    dup_row = match_items([dict(addendum["rows"][0])], ambiguous_master)[0]
    assert dup_row["_vinda_unmatched"] is True and dup_row["kode_barangs"] == "", dup_row

    print("OK -- semua self-check vinda_letter lulus")


if __name__ == "__main__":
    main()
