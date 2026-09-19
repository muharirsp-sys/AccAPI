"""Tujuan: Self-check parser surat PT Primarasa Abadi Sejahtera (merek Collins).
Caller: `python test_primarasa_letter.py`. Dependensi: primarasa_letter.
Main Functions: main; assert dua aturan diskon terbaca, ON PO = ON FAKTUR (surat tanpa kata
mekanisme faktur TETAP menghasilkan baris), ukuran "6 x 1kg" yang TIDAK ADA di master
dilaporkan dan tidak dialihkan, serta tanggal akhir yang tak tercetak dibiarkan kosong.
Side Effects: tidak ada. Fixture = salinan verbatim lapisan teks (pypdf) surat asli
`re-Surat Program Diskon Spesial Collins 06 Mei 2026.pdf`.
"""
import sys

sys.path.insert(0, ".")
from primarasa_letter import parse_text, match_items  # noqa: E402

COLLINS = """Jakarta, 06 Mei 2026

Nomor : 01/COLLINS/V/2026
Perihal : Program Discount Special Collins

Kepada Yth,
Segenap Pelanggan dan Distributor
PT. Primarasa Abadi Sejahtera

Di Tempat

Dengan Hormat,
Melalui surat ini kami  PT. P rimarasa Abadi Sejahtera ingin m emberitahukan
Program Discount Special untuk Produk Collins, yaitu sebagai berikut:
1. Seluruh produk Collins Dip Glaze 6 x 1kg harga per pcsnya sama dengan
Collins Dip Glaze 12 x 1kg (per pcs nya discount Rp1.000),
2. Seluruh produk Collins Dip Glaze ukuran 6 x 1 kg, 12 x 1 kg,  5 kg,
dan 24  x 300 gr mendapatkan discount  6%,

Program ini berlaku mulai tanggal 06 Mei 2026 dan berlaku tanpa syarat.

Note: program discount special ini terbatas, siapa cepat dia dapat.

Demikian yang dapat kami sampaikan, besar harapan kami bapak/ibu berminat
dengan program yang kami tawarkan. Atas perhatian dan kerjasamanya kami
ucapkan terima kasih.

Hormat kami,

PT. Primarasa Abadi Sejahtera"""


def _it(kode, nama, gram, kem="PCS"):
    return {"kode_barang": kode, "nama_barang": nama, "kelompok": "COLLINS DIP GLAZE",
            "variant": "", "gramasi": gram}


# Potongan MASTER BARANG PRIMARASA.xlsx -- master TIDAK punya kemasan 6 x 1kg.
MASTER_ITEMS = [
    _it("P3011001100120", "COLLINS DIP GLAZE CAPPUCINO 1KG X 12 PCS", "1KG"),
    _it("P3011002100120", "COLLINS DIP GLAZE CHEESE 1KG X 12 PCS", "1KG"),
    _it("P3011005100120", "COLLINS DIP GLAZE DARK CHOCO 1KG X 12 PCS", "1KG"),
    _it("P3011001100510", "COLLINS DIP GLAZE CAPPUCINO 5KG X 1 PAIL", "5KG"),
    _it("P3011005100510", "COLLINS DIP GLAZE DARK CHOCO 5KG X 1 PAIL", "5KG"),
    _it("P3011104102020", "COLLINS DIP GLAZE REG CHOCO FILING 5KG X 4 PCS", "5KG"),
    _it("P3011005030020", "COLLINS DIP GLAZE DARK CHOCO 300GR X 24 PCS", "300GR"),
    _it("P3011006030020", "COLLINS DIP GLAZE MATCHA 300GR X 24 PCS", "300GR"),
    # Barang principal lain: tidak boleh ikut terbawa.
    {"kode_barang": "P3020001000110", "nama_barang": "COLLINS SELAI NANAS 1KG X 12 PCS",
     "kelompok": "COLLINS SELAI", "variant": "", "gramasi": "1KG"},
]


def main():
    hasil = parse_text(COLLINS)
    head = hasil["letter"]
    assert head["surat_program"] == "01/COLLINS/V/2026", head
    assert head["nama_program"].startswith("Program Discount Special Collins"), head

    # Tanggal MULAI tercetak, tanggal AKHIR tidak -> dibiarkan kosong + diperingatkan,
    # bukan dikarang. compile_programs yang akan menahannya.
    assert head["periode_start"] == "2026-05-06" and head["periode_end"] == "", head
    assert any("tanggal BERAKHIR" in w for w in hasil["warnings"]), hasil["warnings"]
    # Channel & syarat klaim tidak tercetak -> kosong + peringatan (tidak ditebak).
    assert head["channel_gtmt"] == "", head
    assert any("channel" in w.lower() for w in hasil["warnings"]), hasil["warnings"]
    assert any("SYARAT KLAIM" in w for w in hasil["warnings"]), hasil["warnings"]

    # ATURAN ON PO = ON FAKTUR: surat ini tidak pernah menyebut faktur/PO sama sekali,
    # dan itu TIDAK menahan barisnya.
    assert len(hasil["rows"]) == 2, [r["source_quote"][:60] for r in hasil["rows"]]
    satu, dua = hasil["rows"]
    assert satu["benefit_type"] == "DISC_RP" and satu["benefit"] == "1000", satu
    assert "per pcs" in satu["keterangan"].lower(), satu
    assert dua["benefit_type"] == "DISC_PCT" and dua["benefit"] == "6", dua
    # "berlaku tanpa syarat" = surat menyatakan sendiri tak ada minimum.
    assert satu["ketentuan"] == "Tidak ada minimum pembelian", satu

    rows = match_items(hasil["rows"], MASTER_ITEMS)
    satu, dua = rows

    # Aturan 1 hanya menyangkut kemasan 6 x 1kg, yang TIDAK ADA di master -> DITAHAN,
    # dan TIDAK dialihkan ke 12 x 1kg yang mirip.
    assert satu["kode_barangs"] == "" and satu.get("_primarasa_unmatched"), satu
    assert "6 x 1KG" in satu["keterangan"], satu
    assert "tidak dialihkan" in satu["keterangan"], satu

    # Aturan 2 menyebut empat ukuran; tiga ada di master, "6 x 1kg" dilaporkan hilang.
    kode = sorted(dua["kode_barangs"].split(","))
    assert kode == ["P3011001100120", "P3011001100510", "P3011002100120", "P3011005030020",
                    "P3011005100120", "P3011005100510", "P3011006030020", "P3011104102020"], kode
    assert "6 x 1KG" in dua["keterangan"] and "UKURAN TIDAK ADA DI MASTER" in dua["keterangan"], dua
    # Barang principal lain (Collins Selai) tidak boleh ikut.
    assert "P3020001000110" not in dua["kode_barangs"], dua

    print("OK -- semua self-check primarasa_letter lulus")


if __name__ == "__main__":
    main()
