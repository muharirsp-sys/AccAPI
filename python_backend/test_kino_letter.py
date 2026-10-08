"""Tujuan: Self-check parser surat Kino berlapis teks (tanpa OCR, tanpa PDF di repo).
Caller: `python test_kino_letter.py`. Dependensi: kino_letter, summary_rules.
Main Functions: main; assert klasifikasi on-faktur, kelayakan outlet, tier, dan bonus per butir.
Side Effects: Tidak ada. Teks di bawah adalah salinan verbatim lapisan teks surat September 2026.
"""
import sys

sys.path.insert(0, ".")
from kino_letter import match_products, parse_text  # noqa: E402
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


NKA = """NO. PROMO ID : PN26006696 Tanggal Aju : 15 September 2026 Kode Aju : BP2609008707
Nama Program Promo : NKA - INDOMARET LISTING & SUPPORT DISC 3% (FIRST PO) ELLIPS ULTRA LIGHT, SASHA HAIR SHAMPOO SEPTEMBER 2026 - DESEMBER 2026
Periode Promo : 15 September 2026 - 31 December 2026 Divisi : HOME PERSONAL CARE Group Of Promo : MODERN
Type Of Promo : LISTING FEE & SUPPORT Class Of Promo : FEE Mekanisme Promo : LISTING FEE
Detail Promo : NKA - INDOMARET LISTING & SUPPORT DISC 3% (FIRST PO) ELLIPS ULTRA LIGHT, SASHA HAIR SHAMPOO SEPTEMBER 2026 - DESEMBER 2026
ELLIPS HAIR VITAMIN ULTRA LIGHT BTL 45ML
SASHA SHAMPOO COLOR NATURAL BLACK 30ML
DISC ON PO 3%
INDOGROSIR COVER INDOMARET
Outlet/Account : ALL"""

# BP2601000851 (Farmers/Ranch Market): surat hanya judul + periode; ketentuannya keputusan pengguna.
FARMERS = """NO. PROMO ID : PN26000322 Tanggal Aju : 26 December 2025 Kode Aju : BP2601000851
Nama Program Promo : RANCH MARKET HPC OTHERS JANUARY - DECEMBER 2026
Periode Promo : 1 January 2026 - 31 December 2026 Divisi : HOME PERSONAL CARE Brand : HOME PERSONAL CARE
Group Of Promo : MODERN Type Of Promo : TRADING TERM (TT) EXPENSE Class Of Promo : OTHERS (GO DISCOUNT, RELAUNCH, SEASONAL, ANNIVERSARY)
Activity Promo : OTHERS Mekanisme Promo : OTHERS
Detail Promo : RANCH MARKET HPC OTHERS JANUARY - DECEMBER 2026
Outlet/Account : ALL"""

# BP2608008343: besaran HANYA di judul; Detail = produk berukuran + kalimat akun.
NKA_JUDUL = """NO. PROMO ID : PN26006192 Tanggal Aju : 28 August 2026 Kode Aju : BP2608008343
Nama Program Promo : NKA - INDOMARET LISTING & SUPPORT DISC 3% (FIRST PO) THEORY EXTRAIT AGUSTUS 2026 - DESEMBER 2026
Periode Promo : 28 August 2026 - 31 December 2026 Divisi : HOME PERSONAL CARE Brand : HOME PERSONAL CARE
Group Of Promo : MODERN Type Of Promo : LISTING FEE & SUPPORT Class Of Promo : FEE Mekanisme Promo : LISTING FEE
Detail Promo : NKA - INDOMARET LISTING & SUPPORT DISC 3% (FIRST PO) THEORY EXTRAIT AGUSTUS 2026 - DESEMBER 2026
Theory Extrait De Parfum Royal Oud 40ML
Theory Extrait De Parfum Midnight Wave 40ML
Indogrosir cover indomaret.
Outlet/Account : ALL"""


def main():
    # Surat akun NKA (BP2609008707, 22 Sep 2026). Dua produk sebelum SATU "DISC ON PO 3%" harus
    # jadi dua baris — dulu terbaca satu kelompok "... 45ML SASHA ... 30ML DISC" tanpa kode barang.
    nka = parse_text(NKA)
    assert [r["kelompok"] for r in nka["rows"]] == ["ELLIPS HAIR VITAMIN ULTRA LIGHT BTL 45ML",
        "SASHA SHAMPOO COLOR NATURAL BLACK 30ML"], nka["rows"]
    assert all(r["benefit_type"] == "DISC_PCT" and r["benefit"] == "3" for r in nka["rows"]), nka["rows"]
    assert (nka["rows"][0]["periode_start"], nka["rows"][0]["periode_end"]) == ("2026-09-15", "2026-12-31")
    # "Outlet/Account : ALL" tercetak, tetapi suratnya khusus akun Indomaret (+ Indogrosir). Dibaca
    # semua outlet, 3% itu membenarkan potongan yang sama di toko mana pun. Ditahan sampai daftarnya ada.
    assert (nka["rows"][0]["outlet_mode"], nka["rows"][0]["outlet_classes"]) == ("only", "BP2609008707"), nka["rows"][0]
    assert nka["rows"][0]["channel_list"] == "INDOMARET, INDOGROSIR", nka["rows"][0]
    # Outlet Indomaret berkategori NKA di master: channel MT akan membuat aturannya tidak pernah berlaku.
    assert nka["rows"][0]["channel_gtmt"] == "ALL", nka["rows"][0]
    assert all("PO pertama" in r["keterangan"] for r in nka["rows"]), nka["rows"]
    assert any("PO PERTAMA" in w for w in nka["warnings"]), nka["warnings"]
    assert not any("SEMUA outlet" in w for w in nka["warnings"]), nka["warnings"]

    check_match_products(nka)

    msg = parse_text(MSG)
    assert msg["on_faktur"] and msg["mechanism"] == "CB ON FAKTUR VALUE", msg["mechanism"]
    assert len(msg["rows"]) == 4, msg["rows"]
    # Rentang tiap strata dicetak seperti bunyi surat (7 Okt 2026); minimumnya tetap angka pertama,
    # jadi "9JT � 9.99 JT" adalah batas BAWAH 9 juta — membaca 9.99 menaikkan syarat.
    # Batas atas = minimum strata berikutnya - 1 (8 Okt 2026), bukan "1.99 JT" tertulis: tanpa
    # celah dan tanpa angka yang muncul di dua strata. Contoh surat ini melompat 2JT -> 9JT.
    assert [r["ketentuan"] for r in msg["rows"]][:2] == ["Minimal belanja Rp 1000000 s/d Rp 1999999",
                                                         "Minimal belanja Rp 2000000 s/d Rp 8999999"]
    assert msg["rows"][2] == {**msg["rows"][2], "ketentuan": "Minimal belanja Rp 9000000 s/d Rp 9999999", "benefit": "180000"}
    assert msg["rows"][3]["ketentuan"] == "Minimal belanja Rp 10000000 UP"
    assert msg["rows"][3]["source_quote"] == "10JT UP potongan on faktur 200.000", msg["rows"][3]["source_quote"]
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
    # "MIX VARIANT" = campur varian dalam gramasi yang sama (7 Okt 2026); surat yang diam soal
    # gramasi ditegaskan di ketentuan, surat yang mengizinkan lintas gramasi tidak.
    assert resik["rows"][0]["ketentuan"] == "Setiap pembelian 30 PCS RESIK V KHASIAT MANJAKANI MIX VARIANT, GRAMASI SAMA berlaku kelipatan", resik["rows"][0]["ketentuan"]
    lintas = parse_text(RESIK.replace("MIX VARIANT AKAN", "MIX VARIANT BEDA GRAMASI AKAN", 1))
    assert "GRAMASI SAMA" not in lintas["rows"][0]["ketentuan"] and "BEDA GRAMASI" in lintas["rows"][0]["ketentuan"]

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
    # Brand = Divisi tanpa lampiran = seluruh katalog (keputusan 17 Sep 2026, MSG ALL BRAND).
    assert {r["kelompok"] for r in msg["rows"]} == {"__ALL_MASTER__"}, msg["rows"]
    # "KHUSUS LD JAWA" ditandai (router tidak membuat barisnya); "LUAR JAWA" tidak.
    assert small["khusus_jawa"] and not mti["khusus_jawa"]
    assert not parse_text(SMALL.replace("KHUSUS LD JAWA", "KHUSUS LUAR JAWA"))["khusus_jawa"]
    # Besaran dari judul: dua produk berukuran jadi dua baris 3%, kalimat akun bukan produk;
    # tetap khusus akun Indomaret + Indogrosir dan tetap PO pertama.
    judul = parse_text(NKA_JUDUL)
    assert [(r["kelompok"], r["benefit_type"], r["benefit"]) for r in judul["rows"]] == [
        ("Theory Extrait De Parfum Royal Oud 40ML", "DISC_PCT", "3"),
        ("Theory Extrait De Parfum Midnight Wave 40ML", "DISC_PCT", "3")], judul["rows"]
    assert (judul["rows"][0]["outlet_mode"], judul["rows"][0]["outlet_classes"], judul["rows"][0]["channel_list"]) == (
        "only", "BP2608008343", "INDOMARET, INDOGROSIR"), judul["rows"][0]
    assert (judul["rows"][0]["periode_start"], judul["rows"][0]["periode_end"]) == ("2026-08-28", "2026-12-31")
    assert all("PO pertama" in r["keterangan"] for r in judul["rows"])
    # Surat tanpa mekanisme tercetak + keputusan pengguna: satu baris 0,5% All Brand HPC, sepanjang
    # periode suratnya, HANYA daftar bernama nomor surat itu (Farmers C-PT0029), channel ALL.
    farmers = parse_text(FARMERS)
    assert [(r["kelompok"], r["benefit_type"], r["benefit"], r["outlet_mode"], r["outlet_classes"], r["channel_gtmt"],
             r["periode_start"], r["periode_end"]) for r in farmers["rows"]] == [
        ("__ALL_MASTER__", "DISC_PCT", "0.5", "only", "BP2601000851", "ALL", "2026-01-01", "2026-12-31")], farmers["rows"]
    assert "C-PT0029" in farmers["rows"][0]["keterangan"], farmers["rows"][0]
    assert not any("bukan channel" in w or "SEMUA outlet" in w for w in farmers["warnings"]), farmers["warnings"]
    check_match_groups()
    print("kino letter check: OK")


def check_match_groups():
    """Frasa kelompok surat -> kelompok/varian/kemasan/kode tanpa operator (Kino Okt 2026)."""
    from kino_letter import match_groups
    from shared import _apply_native_kelompok

    master = [dict(kode_barang=k, nama_barang=n, kelompok=g, variant=v, gramasi=s) for k, n, g, v, s in (
        ("K1100001000110", "KNF ELLIPS H.VIT HAIR TREATMENT 1ML X 72 BLR", "ELLIPS", "H.VIT HAIR TREATMENT", "1ML"),
        ("K1100001000140", "KNF ELLIPS H.VIT HAIR TREATMENT 1ML X 12 JAR", "ELLIPS", "H.VIT HAIR TREATMENT", "1ML"),
        ("K1100007000110", "KNF ELLIPS H.VIT SHINY BLACK 1ML X 72 BLR", "ELLIPS", "H.VIT SHINY BLACK", "1ML"),
        ("K1100007000140", "KNF ELLIPS H.VIT SHINY BLACK 1ML X 12 JAR", "ELLIPS", "H.VIT SHINY BLACK", "1ML"),
        ("K1101011000110", "KNF ELLIPS H.VIT BALI NOURISH&PROTECT 1ML X 72 BLR", "ELLIPS - H.VIT BALI", "NOURISH&PROTECT", "1ML"),
        ("K1102106000120", "KNF ELLIPS HVIT KERATIN 15C HAIR REPAIR 1ML X 24 JAR", "ELLIPS - HVIT KERATIN 15C HAIR", "REPAIR", "1ML"),
        ("K1090001010010", "KNF ELLIPS HAIR MIST FRESH&SMOOTH 100ML X 24 BTL", "ELLIPS HAIR MIST", "FRESH&SMOOTH", "100ML"),
        ("K1502000007020", "KNF SLEEK BABY BN CLEANSER 70ML X 36 PCH", "SLEEK BABY - BN CLEANSER", "", "70ML"),
        # Kode dipakai ulang Kino: nama lama (GEL MONDAY) dan baru (DREAMY BLUE) pada satu kode.
        ("K1111002005010", "KNF ESKULIN COLOGNE DREAMY BLUE 50ML X 36 BTL", "ESKULIN - COLOGNE", "DREAMY BLUE", "50ML"),
        ("K1111002005010", "KNF ESKULIN COLOGNE GEL MONDAY 50ML X 36 BTL", "ESKULIN - COLOGNE", "GEL MONDAY", "50ML"),
        ("K1111009005010", "KNF ESKULIN COLOGNE ENCHANTING WHITE 50ML X 36 BTL", "ESKULIN - COLOGNE", "ENCHANTING WHITE", "50ML"),
        ("K1111009010010", "KNF ESKULIN COLOGNE GEL ENCHANTING 100ML X 36 BTL", "ESKULIN - COLOGNE", "GEL ENCHANTING", "100ML"),
        ("K1122001010010", "KNF ESKULIN HIJAB C.GEL FRESH DAY 100ML X 36 BTL", "ESKULIN HIJAB - C.GEL", "FRESH DAY", "100ML"),
        ("K1041001025010", "KNF B&B HAIR BODY WASH RIKO 250ML X 24 BTL", "B&B - HAIR BODY WASH", "RIKO", "250ML"),
        ("K1045001006010", "KNF B&B POWDER BLOSSOM 60GR X 36 BTL", "B&B - POWDER", "BLOSSOM", "60GR"),
        ("K1521001004010", "KNF THEORY EXT DP ROYAL OUD 40ML X 36 BTL", "THEORY - EXT DP", "ROYAL OUD", "40ML"),
        ("K1521002004010", "KNF THEORY EXT DP MIDNIGHT WAVE 40ML X 36 BTL", "THEORY - EXT DP", "MIDNIGHT WAVE", "40ML"))]

    def pilih(frasa):
        row = dict(no="1", kelompok=frasa, variant=frasa, kode_barangs="", keterangan="", benefit_type="DISC_PCT")
        return [(r["kelompok"], r["variant"], r.get("kemasan", ""), r["kode_barangs"]) for r in match_groups([row], master, [])]

    # Kata kemasan surat mempersempit; H.VIT dan HVIT = HAIR VITAMIN. Satu FRASA surat = satu
    # baris (7 Okt 2026): kelompok master yang tercakup digabung " & ", bukan jadi baris kembar.
    assert pilih("ELLIPS HAIR VITAMIN BLISTER") == [
        ("ELLIPS & ELLIPS - H.VIT BALI", "ALL VARIANT", "BLR", "K1100001000110,K1100007000110,K1101011000110")], pilih("ELLIPS HAIR VITAMIN BLISTER")
    assert pilih("ELLIPS HAIR VITAMIN JAR") == [
        ("ELLIPS & ELLIPS - HVIT KERATIN 15C HAIR", "ALL VARIANT", "JAR", "K1100001000140,K1100007000140,K1102106000120")], pilih("ELLIPS HAIR VITAMIN JAR")
    # Inisial master "BN" = BOTTLE NIPPLE; kata ganda surat ("BABY BABY") tidak mengganggu.
    assert pilih("SLEEK BABY BABY BOTTLE NIPPLE") == [("SLEEK BABY - BN CLEANSER", "ALL VARIANT", "", "K1502000007020")]
    assert [g for g, *_ in pilih("B&B ALL VARIANT")] == ["B&B - HAIR BODY WASH & B&B - POWDER"]
    # Perapi baris (jalur parse Kino) tidak mengosongkan kelompok gabungan yang tiap bagiannya master.
    from baca_surat_rapi import rapikan_baris
    rapi = rapikan_baris([dict(kelompok="ELLIPS & ELLIPS - H.VIT BALI", variant="ALL VARIANT", gramasi="ALL GRAMASI"),
                          dict(kelompok="ELLIPS & RESIK V CAIR", variant="ALL VARIANT", gramasi="ALL GRAMASI")], master)
    assert [r["kelompok"] for r in rapi] == ["ELLIPS & ELLIPS - H.VIT BALI", ""], rapi
    # Padanan tersimpan 1 Okt 2026: seluruh ESKULIN - COLOGNE termasuk nama lama; Hijab C.GEL tidak.
    assert pilih("ESKULIN COLOGNE GEL REJUVENATION MIX VARIANT") == [
        ("ESKULIN - COLOGNE", "ALL VARIANT", "", "K1111002005010,K1111009005010,K1111009010010")]
    # Tidak ditemukan -> baris dibiarkan (ditahan untuk operator), tidak ditebak.
    assert pilih("RESIK V CAIR") == [("RESIK V CAIR", "RESIK V CAIR", "", "")]
    # Produk berukuran lewat singkatan master: "EXT" = EXTRAIT, "DP" = DE PARFUM; ukuran wajib sama.
    assert pilih("Theory Extrait De Parfum Royal Oud 40ML") == [
        ("THEORY - EXT DP", "ROYAL OUD", "", "K1521001004010")], pilih("Theory Extrait De Parfum Royal Oud 40ML")
    assert pilih("Theory Extrait De Parfum Royal Oud 100ML")[0][3] == ""
    # Satu produk berukuran dalam DUA kemasan (BLR dan JAR) yang tidak disebut surat tetap ditahan.
    assert pilih("ELLIPS HAIR VITAMIN HAIR TREATMENT 1ML")[0][3] == ""

    def kode(**row):
        base = dict(no="1", kelompok="", variant="ALL VARIANT", gramasi="ALL GRAMASI", kemasan="", kode_barangs="")
        return {k for r in _apply_native_kelompok([{**base, **row}], master) for k in r["kode_barangs"].split(",") if k}
    # Bug 2: varian master dipilih persis — "GEL ENCHANTING" tidak menarik "ENCHANTING WHITE".
    assert kode(kelompok="ESKULIN - COLOGNE", variant="GEL ENCHANTING") == {"K1111009010010"}
    # Bug 3: kode yang sudah terisi + ALL VARIANT tidak dimekarkan ke kemasan lain saat Form dibuat.
    assert kode(kelompok="ELLIPS", kemasan="BLR", kode_barangs="K1100001000110,K1100007000110") == {
        "K1100001000110", "K1100007000110"}


def check_match_products(nka):
    """Nama produk surat -> kode master tanpa ditebak. Nama master persis dari MASTER BARANG KINO."""
    master = [dict(kode_barang=k, nama_barang=n, kelompok=g, variant=v, gramasi=s) for k, n, g, v, s in (
        ("K1100010004520", "KNF ELLIPS H.VIT ULTRA LIGHT 45ML X 36 BTL", "ELLIPS", "H.VIT ULTRA LIGHT", "45ML"),
        ("K1531001003011", "KNF SASHA SHAMPOO COLOR NATURAL BLACK 30ML X 72 SCH", "SASHA SHAMPOO - COLOR", "NATURAL BLACK", "30ML"),
        ("K1531002003011", "KNF SASHA SHAMPOO COLOR NAT. DARK BROWN 30ML X 72 SCH", "SASHA SHAMPOO - COLOR", "NAT. DARK BROWN", "30ML"),
        ("K1100001000110", "KNF ELLIPS H.VIT HAIR TREATMENT 1ML X 72 BLR", "ELLIPS", "H.VIT HAIR TREATMENT", "1ML"),
        ("K1100001000140", "KNF ELLIPS H.VIT HAIR TREATMENT 1ML X 12 JAR", "ELLIPS", "H.VIT HAIR TREATMENT", "1ML"),
        ("K1041001025010", "KNF B&B HAIR BODY WASH RIKO 250ML X 24 BTL", "B&B", "HAIR BODY WASH RIKO", "250ML"),
        ("K1041001025011", "KNF B&B HAIR BODY WASH RIKO 250ML X 36 BTL", "B&B", "HAIR BODY WASH RIKO", "250ML"))]
    rows = [dict(r) for r in nka["rows"]]
    warnings = []
    match_products(rows, master, warnings)
    # "H.VIT" = "HAIR VITAMIN" (tiap bagian singkatan = awalan kata berurutan); NATURAL BLACK bukan DARK BROWN.
    assert [r["kode_barangs"] for r in rows] == ["K1100010004520", "K1531001003011"], rows
    # Kolom master ikut ditulis, supaya `_apply_native_kelompok` saat simpan menemukan barang yang sama.
    assert (rows[1]["kelompok"], rows[1]["variant"], rows[1]["gramasi"]) == ("SASHA SHAMPOO - COLOR", "NATURAL BLACK", "30ML")

    def kode(frasa):
        row = {"no": "1", "kelompok": frasa, "ketentuan": frasa, "benefit_type": "DISC_PCT", "kode_barangs": ""}
        match_products([row], master, [])
        return row["kode_barangs"]
    # KEMASAN membedakan produk: BLR dan JAR dua barang. Disebut -> hanya itu; tidak disebut -> ditahan.
    assert kode("ELLIPS HAIR VITAMIN HAIR TREATMENT JAR 1ML") == "K1100001000140"
    assert kode("ELLIPS HAIR VITAMIN HAIR TREATMENT 1ML") == ""
    # Karton berbeda (X 24 / X 36) untuk kemasan yang sama tetap satu produk; "B&B" = dua kata B.
    assert kode("B&B HAIR BODY WASH RIKO 250ML") == "K1041001025010,K1041001025011"
    # Ukuran lain, kata yang tidak dijelaskan master, atau nama tanpa ukuran -> tidak diisi.
    assert kode("SASHA SHAMPOO COLOR NATURAL BLACK 60ML") == ""
    assert kode("SASHA SHAMPOO COLOR NATURAL BLACK EXTRA 30ML") == ""
    assert kode("ELLIPS HAIR MIST") == ""


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
    # MIX VARIANT = gramasi sama (7 Okt 2026): dengan master, programnya dipecah per gramasi;
    # 20 pcs 50ML + 10 pcs 200ML bukan 30 pcs, dan 30 pcs 50ML saja yang berbonus.
    master = [dict(kode_barang="K1", gramasi="50ML"), dict(kode_barang="K2", gramasi="200ML")]
    per_gramasi = validate_programs(compile_programs([{**resik["rows"][0], "kode_barangs": ",".join(codes)}], None, master)[0], set(codes), 1)
    assert [(p.kelompok, p.codes) for p in per_gramasi] == [
        ("RESIK V KHASIAT MANJAKANI MIX VARIANT 50ML", ["K1"]), ("RESIK V KHASIAT MANJAKANI MIX VARIANT 200ML", ["K2"])], per_gramasi
    campur = calculate(per_gramasi, [dict(code="K1", unit="PCS", quantity="20", price="10000"),
                                     dict(code="K2", unit="PCS", quantity="10", price="10000")],
                       "2026-09-03", "GT", outlet_classes=("LOYALTY",), known_classes=("LOYALTY",))
    assert campur["bonuses"] == [], campur["bonuses"]
    sama = calculate(per_gramasi, [dict(code="K1", unit="PCS", quantity="30", price="10000")],
                     "2026-09-03", "GT", outlet_classes=("LOYALTY",), known_classes=("LOYALTY",))
    assert [(b["quantity"], b["eligible_codes"]) for b in sama["bonuses"]] == [("1", ["K1"])], sama["bonuses"]


if __name__ == "__main__":
    main()
