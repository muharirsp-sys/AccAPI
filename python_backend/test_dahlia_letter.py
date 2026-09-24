"""Tujuan: Self-check parser surat DAHLIA / PT Unitama Sari Mas (deterministik, tanpa OCR).
Caller: `python test_dahlia_letter.py`. Dependensi: dahlia_letter.
Main Functions: main; assert ketiga bentuk surat, aturan ON PO = ON FAKTUR (mekanisme tercetak
hanya jejak audit, BUKAN penyaring), pemisahan Disc. Reg Dist vs benefit principal, ekspansi
keluarga kode yang DITULIS surat, dan penahanan data yang memang tidak ada.
Side Effects: tidak ada. Teks fixture adalah salinan verbatim lapisan teks (pypdf) surat asli
di reference_surat_program/sept26/ (berkas PDF-nya sendiri TIDAK ikut git).
"""
import sys

sys.path.insert(0, ".")
from dahlia_letter import parse_text, match_items  # noqa: E402

# --- 542-11410 (C61) PROMO TOKO ONLINE SEPTEMBER 2026 - SULAWESI 1 (potongan verbatim) ----
C61 = """PROMO NASIONAL  TOKO ONLINE
Budget Code : 11410 / C61 Jenis Program : 11410 - Consumer  Promo GT (LK) No. Proposal : 542/TMDH1/8/26#
Tanggal Pengajuan : 31 Agustus 2026 : C61 - Trade Promo GT Online Periode Program : September  2026
Area : SULAWESI  1 Channel : TOKO ONLINE Nama Distributor : CV. SURYA PERKASA
Mekanisme
Promo berlaku di Toko Online Pantauan  TM. Tidak berlaku untuk GT Grosir, GT Retail, MT dan Special Channel : CV. NURHIDAYAT  ABADI NUSANTARA
Batas klaim maksimum  distributor  30 hari setelah periode program  selesai : MITRA ARISLAN,  UD. (BAU BAU)
Regional Group Product Item Strata Min Order Disc. Reg Dist *
Promo
ITEM Suggest HETAdd. Disc
(On faktur) Add. Promo
Nasional LK
DAHLIA  Kamper Toilet
K31 Series
≥ 2 Lusin (Boleh Campur)
8% - 10% 5% K31N                      24.900
K313 Series 8% - 10% 5% K313                      16.250
K24 Apple, Lemon, Orange, Grape
(Gantung  dan Refill) ≥ 2 Lusin (Boleh Campur) 8% - 10% 5%
K24SRA                      13.300
K24SGRA                      13.900
Dahlia Kamper  Lemari
K240 Berry Blossom, Cherry Blossom,
Jasmine Blossom
(Gantung  dan Refill)
≥ 2 Lusin (Boleh Campur) 8% - 10% 5%
K240CB                      13.300
K240GCB                      13.900
DAHLIA  Kamper
Ruangan K316 Series ≥ 2 Lusin (Boleh Campur) 8% - 10% 5% K316CI                      26.200
Seagull Kamper Toilet
Ball
SG533 P/W
≥ 1 Ctn (Boleh Campur Putih/Warna) 8% - 10%
SG533                      20.850
SG535 SG535                      13.400
Dahlia Blue Clean BC002 ≥ 6 Lusin (Boleh Campur) 8% - 10% BC002                      23.000
LT Kiriko LT122 ≥ 1 Lusin 8% - 10% LT122                      15.500
AF Gel
F601 Core (Non Heritage) ≥ 2 Lusin (Boleh Campur) 3% - 5% 5% F601 Reg                      12.750
F601 Heritage ≥ 2 Lusin (Boleh Campur) 3% - 5% 5% F601TK                      12.750
AF Refill Matic
F607 Core ≥ 2 Lusin (Boleh Campur) 3% - 5% 5% F607CB                      35.150
F607 Heritage ≥ 2 Lusin (Boleh Campur) 3% - 5% 5% F607TK                      36.850
Matic Dispenser F608 ≥ 1 Lusin 3% - 5% 5% F608                      78.700
AF Aerosol F617TK ≥ 1 Lusin 3% - 5% 5% F617TK                      28.900
AF Reed Diffuser
F610 ALL ≥ 1 Lusin (Boleh Campur)
3% - 5%
5% F610                      50.100
F611 ALL ≥ 1 Lusin (Boleh Campur) 5% F611                      33.250
*Catatan: 1. Regulasi diskon mengikuti  ketentuan  diskon reguler distributor"""

# --- 570-11410 (C62) PROMO NASIONAL GT GROSIR (potongan verbatim) -------------------------
C62 = """PROMO NASIONAL GT GROSIR
Budget Code : 11410 / C62 Jenis Program : 11410 - Consumer Promo GT (LK) No. Proposal : 570/TMDH1/8/26#
Tanggal Pengajuan : 31 Agustus 2026 : C62 - Trade Promo GT Offline + Toko Others (Distribusi) Periode Program : September 2026
Area : SULAWESI 1 Channel : GT Grosir Nama Distributor : CV. SURYA PERKASA
Mekanisme
Promo berlaku di All GT Grosir. Tidak Berlaku untuk toko MT Pareto dan Toko Online : PT. INDO MAKMUR MULIA
Batas klaim maksimum distributor 30 hari setelah periode program selesai :
Regional Group Product Item Strata Min Order Disc. Reg Dist *
Promo
Add. Disc
(On faktur) Add. Promo
Nasional LK AF Gel
F601TM
≥ 1 Lusin (Boleh Campur) 3% - 5% 12 Bonus 1
F601JO
F601AH
F601FL
F601LB
F601SB
*Catatan: 1. Regulasi diskon mengikuti ketentuan diskon reguler distributor"""

# --- MT Pareto promo_letter_136 (potongan verbatim) ---------------------------------------
MT_PARETO = """PROMO NASIONAL MT SEPTEMBER 2026
BUDGET CODE : 11402
JENIS PROGRAM : Rafraksi Nasional MT
CHANNEL : MT PARETO
MEKANISME : Program dijalankan sesuai dengan periode tercantum
NO. PROPOSAL : 083/TMDH2/08/26#SUR030
PERIODE PROP : 01-Sep-2026 – 30-Sep-2026
BATAS KLAIM : 31-Dec-2026
NAMA DISTRIBUTOR : CV SURYA PERKASA
Full Month
Air Freshener Kamper Dahlia LT Kiriko
Strata Account F601AH F601JO F601TK F607SB F607SP F607TK K316CI K31GJ K31N K31SF LT122N
(1-30) (1-30) (1-30) (1-30) (1-30) (1-30) (1-30) (1-30) (1-30) (1-30) (1-30)
Diamond Independent 1.000 1.000 1.000 1.500 1.000 1.500 1.000 1.000 1.500 1.000 1.500
Gold Independent 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.500
MT DIAMOND SATU SAMA 1.000 1.000 1.000 1.500 1.000 1.500 1.000 1.000 1.500 1.000 1.500
Platinum Independent 1.000 1.000 1.000 1.500 1.000 1.500 1.000 1.000 1.000 1.000 1.500"""

# Potongan MASTER BARANG DAHLIA.xlsx (bentuk shared._parse_master_barang_xlsx).
def _it(kode, nama):
    return {"kode_barang": kode, "nama_barang": nama, "kelompok": "DH", "variant": "", "gramasi": ""}


MASTER_ITEMS = [
    _it("U3073203020010", "K31N DH KAMPER TOILET FRESH & CLEAN 200GRX120PCS"),
    _it("U3073206020010", "K31GJ DH KAMPER TOILET GANTUNG JERUK 200GRX120PCS"),
    _it("U3073207020010", "K31SF DH KAMPER TOILET SOFT FLORAL 200GRX120PCS"),
    _it("U3073101015010", "K313FL DH KAMPER TOILET FLORAL 150GRX120PCS"),
    _it("U3073102015010", "K313GL DH KAMPER TOILET GREEN LEMON 150GRX120PCS"),
    _it("U3073101015010", "K313N DH KAMPER TOILET FRESH 150GRX120PCS"),
    _it("U3052101008010", "K24SGRA DH FRSHNR FRUIT GTG REF APPLE 80GRX120PCS"),
    _it("U3050108008010", "K240CB DH KAMPER LEMARI REF CHERY BLSM 80GRX120PCS"),
    _it("U3053107008010", "K240GCB DH FRSHNR GTG REF WHITE BLOSOM 80GRX120PCS"),
    _it("U3072101020010", "K316CI DH KAMPER RUANGAN AS CTRONELA 200 GRX120PCS"),
    _it("U3072103020010", "K316EU DH KAMPER RUANGAN AS EUCLYPTS 200 GRX120PCS"),
    _it("U3111501015010", "SG533 SEAGULL KAMPER TOILET BALL PUTIH 150GRX96PCS"),
    _it("U3111501015011", "SG533W SEAGULL KAMPER TOILET BALL WARNA 150GRX96PCS"),
    _it("U3111200009010", "SG535 SEAGULL KAMPER TOILET BALL 90GRX96PCS"),
    _it("U3030102010010", "BC-002 DH BLUE CLEAN PEMBRSH CLOSET 2P 100MLX72PCS"),
    _it("U3101002007530", "LT122 LT KIRIKO PEWANGI 75MLX30PCS"),
    _it("U3020202007510", "F601TK DH AIR F HER TEH KERATON 75GRX72PCS"),
    _it("U3020202007511", "F601TK-BND DH AIR F HER TEH KERATON 75GRX72PCS BDD"),
    _it("U3020012005510", "F601TM DH AIR F TROPICAL MELON 55GRX24PCS"),
    _it("U3020013005510", "F601JO DH AIR F JOLLY ORANGE 55GRX24PCS"),
    _it("U3020003005511", "F601AH DH AIR F APPLE HARMONY 55GRX24PCS"),
    _it("U3020011005510", "F601FL DH AIR F FRESH LYCHEE 55GRX24PCS"),
    _it("U3020007007511", "F601L-BND DH AIR F LEMON 75GRX72PCS BND"),
    _it("U3061101022510", "F607CB DH FRESHGO MTC AER CHERY BLOSOM 225MLX24PCS"),
    _it("U3011103022510", "F607TK DH AEROSOL MTC HER TEH KERATON 225MLX24PCS"),
    _it("U3061102007510", "F607SB DH FRESHGO MTC AER SAKURA BLISS 75GRX24PCS"),
    _it("U3011105022510", "F607SP DH AEROSOL MTC HER SWARNA PADI 225MLX24PCS"),
    _it("U3061000022510", "F608 DH FRESHGO MTC 225MLX12PCS"),
    _it("U3010103035011", "F617TK DH AEROSOL THE KERATON 350MLX12PCS +50ML"),
    _it("U3021001003010", "F610CP DH AIR F RD DIFSR CNDNA PAD 30MLX36PCS"),
    _it("U3021002003010", "F610TK DH AIR F RD DIFSR TEH KERATON 30MLX36PCS"),
    _it("U3021101003010", "F611CP DH AIR F RD DIFSR REF CNDNA PAD 30MLX72PCS"),
    _it("U3021102003010", "F611TK DH AIR F RD DIFSR REF TEH KRATON 30MLX72PCS"),
]


def by_code(rows, code):
    # Baris matriks MT membawa kelompok MASTER (lihat `_exact_item`), jadi kodenya dicari juga
    # pada kutipan suratnya.
    return next(r for r in rows if code in str(r.get("kelompok", ""))
                or f"Strata Account {code}:" in str(r.get("source_quote", "")))


def main():
    # ============ C61: tabel PROMO NASIONAL, banyak blok diskon ===========================
    c61 = parse_text(C61)
    assert c61["format"] == "PROMO_NASIONAL", c61["format"]
    head = c61["letter"]
    assert head["surat_program"] == "542/TMDH1/8/26#", head
    assert (head["periode_start"], head["periode_end"]) == ("2026-09-01", "2026-09-30"), head
    assert head["channel_gtmt"] == "TOKO ONLINE", head

    # ATURAN ON PO = ON FAKTUR: mekanisme tercetak ("Consumer Promo GT") hanya jejak audit.
    # Ia TIDAK BOLEH menahan satu baris pun.
    assert "Consumer Promo GT" in c61["mechanism_printed"], c61["mechanism_printed"]
    assert len(c61["rows"]) >= 18, len(c61["rows"])
    assert all("mekanisme tercetak" in r["keterangan"] for r in c61["rows"]), c61["rows"][0]

    rows61 = match_items(c61["rows"], MASTER_ITEMS)

    # Disc. Reg Dist adalah beban DISTRIBUTOR: dicatat, tidak pernah jadi benefit.
    k31n = by_code(rows61, "K31N")
    assert k31n["benefit_type"] == "DISC_PCT" and k31n["benefit"] == "5", k31n
    assert "8% - 10%" in k31n["keterangan"] and "beban distributor" in k31n["keterangan"], k31n
    assert k31n["kode_barangs"] == "U3073203020010", k31n
    assert k31n["ketentuan"] == "Beli 2 LSN (Boleh Campur)", k31n
    # "K31 Series" + kode persis K31N -> tidak diperluas diam-diam, TAPI saudaranya ditulis.
    assert k31n.get("_dahlia_family_question") and "PERIKSA CAKUPAN" in k31n["keterangan"], k31n
    assert "K31GJ" in k31n["keterangan"] and "K31SF" in k31n["keterangan"], k31n

    # "K313 Series" tanpa kode persis -> keluarga awalan K313 (K313FL/GL/N -> 2 kode unik).
    k313 = by_code(rows61, "K313")
    assert sorted(k313["kode_barangs"].split(",")) == ["U3073101015010", "U3073102015010"], k313

    # K24SRA tidak ada di master -> DITAHAN, tidak ditebak ke K24SA/K24SGRA yang mirip.
    k24sra = by_code(rows61, "K24SRA")
    assert k24sra["kode_barangs"] == "" and k24sra.get("_dahlia_unmatched"), k24sra
    assert "tidak ditebak" in k24sra["keterangan"], k24sra

    # Kolom Add. Disc KOSONG pada blok Seagull/Blue Clean/LT Kiriko di surat ini:
    # benefit tidak boleh terbawa dari blok DAHLIA di atasnya.
    for kode in ("SG533", "SG535", "BC002", "LT122"):
        row = by_code(rows61, kode)
        assert row["benefit_type"] == "" and row["benefit"] == "", (kode, row)
        assert "tidak tercetak" in row["keterangan"], (kode, row)
    assert by_code(rows61, "SG535")["kode_barangs"] == "U3111200009010", "sel 'SG535 SG535' harus terbaca satu kode"

    # "F610 ALL" ditulis di baris ATAS kodenya (pypdf memecah sel) -> tetap terbaca keluarga.
    f610 = by_code(rows61, "F610")
    assert sorted(f610["kode_barangs"].split(",")) == ["U3021001003010", "U3021002003010"], f610
    f611 = by_code(rows61, "F611")
    assert sorted(f611["kode_barangs"].split(",")) == ["U3021101003010", "U3021102003010"], f611

    # Barang BANDED tidak pernah ikut (checklist baris E): F601TK punya saudara -BND.
    f601tk = by_code(rows61, "F601TK")
    assert f601tk["kode_barangs"] == "U3020202007510", f601tk

    # ============ C62: satu blok benefit untuk semua kode ==================================
    c62 = parse_text(C62)
    rows62 = match_items(c62["rows"], MASTER_ITEMS)
    assert c62["letter"]["channel_gtmt"] == "GT GROSIR", c62["letter"]
    assert len(rows62) == 6, [r["kelompok"] for r in rows62]
    assert all(r["ketentuan"] == "Beli 12 LSN (Boleh Campur)" and r["benefit_type"] == "BONUS_QTY"
               and r["benefit"] == "1 LSN" for r in rows62), rows62
    cocok = {r["kelompok"]: r["kode_barangs"] for r in rows62}
    assert cocok["F601TM"] == "U3020012005510" and cocok["F601AH"] == "U3020003005511", cocok
    # F601LB hanya punya padanan BANDED (F601L-BND) -> DITAHAN, bukan dipetakan ke banded.
    assert cocok["F601LB"] == "", cocok
    # F601SB tidak ada di master (mirip F607SB, tapi menebak dilarang) -> DITAHAN.
    assert cocok["F601SB"] == "", cocok

    # ============ MT Pareto: matriks kode x strata outlet ==================================
    mt = parse_text(MT_PARETO)
    assert mt["format"] == "STRATA_MATRIX", mt["format"]
    assert mt["letter"]["surat_program"] == "083/TMDH2/08/26#SUR030", mt["letter"]
    assert (mt["letter"]["periode_start"], mt["letter"]["periode_end"]) == ("2026-09-01", "2026-09-30"), mt["letter"]
    # Mekanisme tercetak "Rafraksi" -- surat TETAP menghasilkan baris (ON PO = ON FAKTUR).
    assert mt["mechanism_printed"].startswith("Rafraksi"), mt["mechanism_printed"]
    rows_mt = match_items(mt["rows"], MASTER_ITEMS)
    assert len(rows_mt) == 11, [r["kelompok"] for r in rows_mt]

    seragam = by_code(rows_mt, "F601AH")
    assert seragam["benefit_type"] == "DISC_RP" and seragam["benefit"] == "1000", seragam
    assert seragam["ketentuan"] == "Tidak ada minimum pembelian", seragam

    # Nilai rafaksi BERBEDA antar strata -> DITAHAN, dan TIDAK PERNAH dijumlahkan.
    for kode in ("F607SB", "F607TK", "K31N"):
        row = by_code(rows_mt, kode)
        assert row["benefit_type"] == "" and row["benefit"] == "", (kode, row)
        assert "BERBEDA antar strata" in row["keterangan"], (kode, row)
        assert "Gold Independent=1000" in row["keterangan"], (kode, row)
    assert by_code(rows_mt, "LT122N")["benefit"] == "1500", by_code(rows_mt, "LT122N")

    print("OK -- semua self-check dahlia_letter lulus")


if __name__ == "__main__":
    main()
