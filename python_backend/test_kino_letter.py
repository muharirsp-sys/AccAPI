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
Nama Program Promo : MTI - HPC CONSUMER PROMO ON PO 1 SEPTEMBER 2026 - 30 SEPTEMBER 2026
Periode Promo : 1 September 2026 - 30 September 2026 Type Of Promo : CONSUMER PROMO
Class Of Promo : DISC ON PO Mekanisme Promo : ADDITIONAL DISCOUNT
Detail Promo : MTI - HPC CONSUMER PROMO ON PO 1 SEPTEMBER 2026 - 30 SEPTEMBER 2026
ELLIPS HAIR VITAMIN JAR ON PO 3% ELLIPS HAIR MIST ON PO 3% SLEEK BABY BABY BOTTLE NIPPLE ON PO 3%
RESIK V CAIR ON PO 3% B&B ALL VARIANT ON PO 3%
Satu toko satu mekanisme (tidak diperbolehkan double mekanisme) Toko wajib menggunakan harga MT (Jika toko menggunakan harga GT maka promo tidak dapat di klaim), Pronas RAFAKSI / ON FAKTUR wajib melampirkan SKP LIST OUTLET TERLAMPIR
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

    # Surat yang diunggah ke program BERARTI on faktur (aturan pengguna 18 Sep 2026: "ON PO =
    # ON Faktur"). Mekanisme yang tercetak tetap dicatat apa adanya untuk jejak audit.
    mti = parse_text(MTI)
    assert mti["on_faktur"] and mti["mechanism"] == "ADDITIONAL DISCOUNT", mti["mechanism"]
    assert [r["kelompok"] for r in mti["rows"]] == ["ELLIPS HAIR VITAMIN JAR", "ELLIPS HAIR MIST",
        "SLEEK BABY BABY BOTTLE NIPPLE", "RESIK V CAIR", "B&B ALL VARIANT"], mti["rows"]
    assert all(r["benefit_type"] == "DISC_PCT" and r["benefit"] == "3" for r in mti["rows"]), mti["rows"]
    # Ketentuan harus menyebut produknya: jati diri baris pada penjaga "satu program sekali"
    # adalah surat+ketentuan+benefit, jadi ketentuan seragam akan meleburkan kelimanya jadi satu.
    assert mti["rows"][1]["ketentuan"] == "Setiap pembelian ELLIPS HAIR MIST", mti["rows"][1]["ketentuan"]
    assert len({r["ketentuan"] for r in mti["rows"]}) == 5, mti["rows"]
    # "CONSUMER PROMO" bukan channel. Yang menentukan klaim adalah harga yang dipakai toko, dan
    # surat mencetaknya; channel yang salah membuat aturan diam-diam tidak pernah cocok.
    assert mti["rows"][0]["channel_gtmt"] == "MT", mti["rows"][0]["channel_gtmt"]
    assert any("LAMPIRAN" in w for w in mti["warnings"]), mti["warnings"]
    # Surat melampirkan daftar outlet pesertanya sendiri. Daftar yang belum dimuat berarti
    # belum diketahui siapa yang berhak — BUKAN semua berhak. Programnya ditambatkan ke daftar
    # bernama nomor suratnya, dan gerbang menahannya selama daftar itu kosong.
    assert (mti["rows"][0]["outlet_mode"], mti["rows"][0]["outlet_classes"]) == ("only", "BP2609007909"), mti["rows"][0]
    assert any("ditahan sampai" in w.lower() for w in mti["warnings"]), mti["warnings"]

    # Aturannya TETAP MUAT — nama daftar = nomor suratnya sendiri diterima gerbang — tetapi
    # TIDAK BERLAKU sampai daftar pesertanya diunggah. Potongan yang kurang bisa dibayar
    # susulan; potongan yang terlanjur masuk faktur outlet yang salah tidak bisa ditarik.
    program, tertahan = compile_programs([{**mti["rows"][1], "kode_barangs": "K1"}])
    assert program and not tertahan, tertahan
    aturan = validate_programs(program, {"K1"}, 1)
    satu = [dict(code="K1", unit="PCS", quantity="1", price="100000")]
    lepas = calculate(aturan, satu, "2026-09-03", "MT", outlet_classes=(), known_classes=())
    assert lepas["discount"] == "0.00", lepas
    assert "belum dimuat" in lepas["blocked"][0]["reason"], lepas["blocked"]
    # Sesudah daftarnya dimuat, peserta dapat 3% dan yang bukan peserta tetap tidak.
    kena = calculate(aturan, satu, "2026-09-03", "MT",
                     outlet_classes=("BP2609007909",), known_classes=("BP2609007909",))
    assert kena["discount"] == "3000.00", kena
    bukan = calculate(aturan, satu, "2026-09-03", "MT",
                      outlet_classes=("LOYALTY",), known_classes=("BP2609007909",))
    assert bukan["discount"] == "0.00", bukan

    # Tanpa kalimat harga itu, channel TIDAK ditebak: dikosongkan dan diperingatkan.
    buta = parse_text(MTI.replace("menggunakan harga MT", "konfirmasi lebih dulu"))
    assert buta["rows"][0]["channel_gtmt"] == "", buta["rows"][0]["channel_gtmt"]
    assert any("bukan channel" in w for w in buta["warnings"]), buta["warnings"]

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
