"""Tujuan: Self-check parser surat Kino berlapis teks (tanpa OCR, tanpa PDF di repo).
Caller: `python test_kino_letter.py`. Dependensi: kino_letter, summary_rules.
Main Functions: main; assert klasifikasi on-faktur, kelayakan outlet, tier, dan bonus per butir.
Side Effects: Tidak ada. Teks di bawah adalah salinan verbatim lapisan teks surat September 2026.
"""
import sys

sys.path.insert(0, ".")
from kino_letter import parse_text  # noqa: E402
from summary_rules import calculate, compile_programs, validate_programs  # noqa: E402

# U+FFFD adalah bullet dan tanda rentang surat Kino; font simbolnya tidak punya padanan Unicode.
B = "�"

MSG = f"""NO. PROMO ID : PN26004457 Kode Aju : BP2609006016
Nama Program Promo : HPC_TP NAS_MSG PROGRAM ALL BRAND HPC PERIODE SEPTEMBER 2026
Periode Promo : 1 September 2026 - 30 September 2026 Divisi : HOME PERSONAL CARE
Brand : HOME PERSONAL CARE Group Of Promo : SALES Type Of Promo : GT
Class Of Promo : TP NASIONAL Activity Promo : ADDITIONAL DISCOUNT NASIONAL
Mekanisme Promo : CB ON FAKTUR VALUE
Detail Promo : MEKANISME : - PROGRAM INI KHUSUS CHANNEL GT EXCLUDE LOYALTY DAN CONTRACTUAL
- REWARD DIBERIKAN DENGAN MINIMAL TRANSAKSI SEBAGAI BERIKUT:
{B} 1JT {B} 1.99 JT POTONGAN ON FAKTUR 20.000 {B} 2JT {B} 2.99 JT POTONGAN ON FAKTUR 40.000
{B} 9JT {B} 9.99 JT POTONGAN ON FAKTUR 180.000 {B} 10JT UP POTONGAN ON FAKTUR 200.000
- BERLAKU ON FAKTUR
Outlet/Account : ALL"""

RESIK = f"""NO. PROMO ID : PN26005867 Kode Aju : BP2609007713
Nama Program Promo : HPC_TP NAS_PROMO BRAND RESIK V PERIODE SEPTEMBER 2026
Periode Promo : 1 September 2026 - 30 September 2026 Brand : HOME PERSONAL CARE
Type Of Promo : GT Mekanisme Promo : BONUS BARANG ON FAKTUR
Detail Promo : MEKANISME : - PROGRAM INI KHUSUS CHANNEL GT PESERTA LOYALTY
- SETIAP PEMBELIAN 30 PCS RESIK V KHASIAT MANJAKANI MIX VARIANT AKAN MENDAPATKAN BONUS 1 PCS PRODUK DENGAN HARGA YANG SAMA (BERLAKU KELIPATAN)
- SETIAP PEMBELIAN 30 PCS RESIK V GODOKAN SIRIH AKAN MENDAPATKAN BONUS 1 PCS PRODUK DENGAN HARGA YANG SAMA
Outlet/Account : ALL"""

MTI = """NO. PROMO ID : PN26006070 Kode Aju : BP2609007909
Nama Program Promo : MTI - HPC CONSUMER PROMO ON PO
Periode Promo : 1 September 2026 - 30 September 2026 Type Of Promo : CONSUMER PROMO
Class Of Promo : DISC ON PO Mekanisme Promo : ADDITIONAL DISCOUNT
Detail Promo : ELLIPS HAIR VITAMIN JAR ON PO 3% Pronas RAFAKSI / ON FAKTUR wajib melampirkan SKP LIST OUTLET TERLAMPIR
Outlet/Account : ALL"""

SMALL = f"""NO. PROMO ID : PN26006104 Kode Aju : BP2609008021
Nama Program Promo : HPC_TP NAS_PROGRAM SMALL PACKAGE SEPTEMBER 2026
Periode Promo : 1 September 2026 - 30 September 2026 Type Of Promo : GT
Mekanisme Promo : CB ON FAKTUR DISC %
Detail Promo : MEKANISME : {B} PROGRAM INI KHUSUS CHANNEL GT EXCLUDE PESERTA PROGRAM IKATAN LOYALTY / HYBRID / CONTRACTUAL & MSG (HIT LIST OUTLET TERLAMPIR)
{B} PROGRAM INI KHUSUS LD JAWA SESUAI LIST TERLAMPIR {B} DISC. ON FAKTUR: 1%
Outlet/Account : ALL"""


def main():
    msg = parse_text(MSG)
    assert msg["on_faktur"] and msg["mechanism"] == "CB ON FAKTUR VALUE", msg["mechanism"]
    assert len(msg["rows"]) == 4, msg["rows"]
    assert [r["ketentuan"] for r in msg["rows"]][:2] == ["Minimal belanja Rp 1000000", "Minimal belanja Rp 2000000"]
    # Rentang "9JT � 9.99 JT" harus terbaca sebagai batas BAWAH; membaca 9.99 menaikkan syarat.
    assert msg["rows"][2] == {**msg["rows"][2], "ketentuan": "Minimal belanja Rp 9000000", "benefit": "180000"}
    assert msg["rows"][3]["ketentuan"] == "Minimal belanja Rp 10000000"
    assert msg["rows"][0]["periode_start"] == "2026-09-01" and msg["rows"][0]["periode_end"] == "2026-09-30"
    assert (msg["rows"][0]["outlet_mode"], msg["rows"][0]["outlet_classes"]) == ("except", "LOYALTY,CONTRACTUAL")

    # EXCLUDE menang atas PESERTA; membacanya terbalik memberi potongan ke outlet yang dilarang.
    small = parse_text(SMALL)
    assert (small["rows"][0]["outlet_mode"], small["rows"][0]["outlet_classes"]) == ("except", "LOYALTY,HYBRID,CONTRACTUAL,MSG")
    assert small["rows"][0]["benefit_type"] == "DISC_PCT" and small["rows"][0]["benefit"] == "1"
    assert any("LAMPIRAN" in w for w in small["warnings"]), small["warnings"]

    # Empat sub-program jadi empat baris; "berlaku kelipatan" milik butirnya sendiri.
    resik = parse_text(RESIK)
    assert [r["outlet_mode"] for r in resik["rows"]] == ["only", "only"], resik["rows"]
    assert "berlaku kelipatan" in resik["rows"][0]["ketentuan"]
    assert "kelipatan" not in resik["rows"][1]["ketentuan"], resik["rows"][1]["ketentuan"]
    assert "MIX VARIANT" in resik["rows"][0]["ketentuan"] and "MIX" not in resik["rows"][1]["ketentuan"]

    # Klasifikasi on-faktur dibaca dari field Mekanisme Promo, bukan dari badan teks yang
    # kebetulan menyebut "ON FAKTUR".
    mti = parse_text(MTI)
    assert not mti["on_faktur"] and mti["rows"] == []
    assert any("bukan on faktur" in w for w in mti["warnings"]), mti["warnings"]

    check_end_to_end(msg, resik)
    print("kino letter check: OK")


def check_end_to_end(msg, resik):
    """Baris hasil parser harus benar-benar menjadi aturan yang bisa dihitung."""
    codes = ["K1", "K2"]
    rules = validate_programs(compile_programs([{**r, "kode_barangs": ",".join(codes)} for r in msg["rows"]])[0], set(codes), 1)
    assert len(rules) == 1 and len(rules[0].tiers) == 4, rules

    def hitung(nilai, outlet=(), known=("LOYALTY", "CONTRACTUAL")):
        lines = [dict(code="K1", unit="PCS", quantity="1", price=nilai)]
        return calculate(rules, lines, "2026-09-03", "GT", outlet_classes=outlet, known_classes=known)

    assert hitung("9375135")["discount"] == "180000.00", hitung("9375135")
    assert hitung("999999")["discount"] == "0.00"
    assert hitung("12000000")["discount"] == "200000.00"
    # Tier nilai dihitung sekeranjang: dua baris Rp 5 juta = tier Rp 10 juta, bukan dua kali 5 juta.
    keranjang = calculate(rules, [dict(code="K1", unit="PCS", quantity="1", price="5000000"),
                                  dict(code="K2", unit="CTN", quantity="1", price="5000000")],
                          "2026-09-03", "GT", known_classes=("LOYALTY", "CONTRACTUAL"))
    assert keranjang["discount"] == "200000.00", keranjang
    # Outlet yang dikecualikan tidak dapat apa-apa, dan alasannya tercatat pada hasil.
    ditolak = hitung("9375135", outlet=("LOYALTY",))
    assert ditolak["discount"] == "0.00" and ditolak["blocked"][0]["reason"] == "outlet termasuk LOYALTY"
    # Daftar outlet belum dimuat = program ditahan, bukan diterapkan ke semua.
    assert hitung("9375135", known=())["discount"] == "0.00"

    # Bonus barang: 30 PCS -> 1 PCS, berlaku kelipatan, bonus dari barang yang dibeli.
    bonus = validate_programs(compile_programs([{**resik["rows"][0], "kode_barangs": ",".join(codes)}])[0], set(codes), 1)
    hasil = calculate(bonus, [dict(code="K1", unit="PCS", quantity="60", price="10000")],
                      "2026-09-03", "GT", outlet_classes=("LOYALTY",), known_classes=("LOYALTY",))
    assert hasil["bonuses"][0]["quantity"] == "2" and hasil["bonuses"][0]["code"] == "", hasil["bonuses"]


if __name__ == "__main__":
    main()
