"""Tujuan: Self-check Fase 7 untuk cross-analysis multi-file.
Caller: Jalankan langsung dengan `python test_cross_analysis.py`.
Dependensi: pandas, sample XLS nyata, cross_analysis.build_data/generate_dashboard, app.Api.
Main Functions: demo.
Side Effects: Menulis output_cross_analysis.html untuk preview manual.
"""
import pandas as pd

from cross_analysis import build_data, generate_dashboard, has_supported_pair, supported_pair_labels

SAMPLES = {
    "Penjualan": "samples/Lap_Penjualan_20260626_172000.XLS",
    "LabaRugi": "samples/Lap_Laba_Rugi_Penjualan_20260626_174129.XLS",
    "PosisiStokGudang": "samples/Lap_Posisi_Barang_Per_Gudang_20260708_202110.XLS",
    "AnalisaStok": "samples/Lap_Analisa_Posisi_Barang_20260708_201944.XLS",
    "Retur": "samples/Lap_Retur_Penjualan_20260709_091934.XLS",
    "OutstandingSO": "samples/Lap_Outs_Sales_Order_20260709_091446.XLS",
}


def _matrix_map(data: dict) -> dict:
    return {row["label"]: row for row in data["matrix"]}


def demo():
    reports = {jenis: pd.read_excel(path) for jenis, path in SAMPLES.items()}
    data = build_data(reports)
    matrix = _matrix_map(data)

    assert matrix["Posisi Stok &times; Analisa Stok"]["overlap"] == "326/332 SKU"
    assert matrix["Retur Penjualan &times; Outstanding SO"]["overlap"] == "52 produk"
    assert matrix["Penjualan &times; Laba Rugi Penjualan"]["overlap"] == "115 customer"
    assert matrix["Laba Rugi Penjualan &times; Outstanding SO"]["overlap"] == "6 produk"
    assert matrix["Penjualan &times; Posisi/Analisa Stok"]["overlap"] == "0 produk"
    assert has_supported_pair(["PosisiStokGudang", "AnalisaStok"])
    assert has_supported_pair(["Retur", "OutstandingSO"])
    assert has_supported_pair(["Penjualan", "LabaRugi"])
    assert not has_supported_pair(["Penjualan", "AnalisaStok"])
    assert supported_pair_labels() == [
        "Posisi Stok + Analisa Stok",
        "Retur Penjualan + Outstanding SO",
        "Penjualan + Laba Rugi Penjualan",
    ]
    print("OK  Matriks overlap cocok: stok=326/332, risk=52, wallet=115, zero-cross tetap ditolak")

    stock = data["stock"]
    assert stock["total_posisi"] == 353477
    assert stock["total_analisa"] == 824004
    assert stock["sku_selisih"] == 273
    assert stock["rows"][0]["nama"] == "PROMAG TABLET 30S/180"
    assert stock["rows"][0]["diff"] == 49293
    assert stock["rows"][0]["batch"] == 31
    print("OK  Rekonsiliasi stok cocok: total Posisi/Analisa + top selisih PROMAG")

    risk = data["risk"]
    assert risk["overlap"] == 52
    assert risk["rows"][0]["nama"] == "INDOMIE GORENG SPECIAL"
    assert risk["rows"][0]["retur_nilai"] == 1052488
    assert risk["rows"][0]["outstanding_nilai"] == 129559994
    print("OK  Retur x Outstanding cocok: 52 produk, top INDOMIE GORENG SPECIAL")

    wallet = data["wallet"]
    assert wallet["both"] == 115
    assert wallet["only_ff"] == 1495
    assert wallet["only_sx"] == 50
    assert wallet["rows"][0]["nama"] == "MEGA MART 2 / HENGKY"
    assert wallet["rows"][0]["frisian_flag"] == 171301809
    assert wallet["rows"][0]["softex"] == 3537483
    print("OK  Wallet customer cocok: join pakai Kode Customer, bukan Nama Customer")

    html = generate_dashboard(reports)
    for sec in ["matrix", "stok", "risk", "wallet"]:
        assert f'data-sec="{sec}"' in html, f"section {sec} hilang"
    for text in ["326/332 SKU", "Rp 129.559.994", "MEGA MART 2 / HENGKY"]:
        assert text in html, f"angka/text acuan hilang: {text}"
    assert "__" not in html.split("<script>")[0], "ada token placeholder __X__ tersisa"
    print("OK  HTML lengkap: 4 section, angka acuan, tanpa placeholder sisa")

    from app import Api

    unsupported = Api().generate_cross([SAMPLES["Penjualan"], SAMPLES["AnalisaStok"]])
    assert not unsupported["ok"], "Penjualan + Analisa Stok harus ditolak cepat karena belum punya section detail"
    assert "belum didukung" in unsupported["error"]
    assert "Penjualan, Analisa Stok" in unsupported["error"]
    print("OK  Kombinasi Penjualan + Analisa Stok ditolak cepat sebelum baca full data")

    with open("output_cross_analysis.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("OK  ditulis ke dashboard-generator/output_cross_analysis.html buat di-preview")

    print("\nSemua self-check Fase 7 (Cross-Analysis) lulus.")


if __name__ == "__main__":
    demo()
