"""Self-check Fase 2. Jalankan: python test_penjualan.py"""
import pandas as pd

from penjualan import build_data, generate_dashboard

SAMPLE = "samples/Lap_Penjualan_20260626_172000.XLS"


def demo():
    df = pd.read_excel(SAMPLE)
    data = build_data(df)
    ov = data["ov"]

    # Angka harus persis sama dengan reference/Dashboard_Penjualan.html (dibuat dari file yang sama)
    assert round(ov["netto"]) == 5447511339, ov["netto"]
    assert round(ov["bruto"]) == 5894371002, ov["bruto"]
    assert round(ov["disc"]) == 446859663, ov["disc"]
    assert ov["inv"] == 2625
    assert ov["cust"] == 1610
    assert ov["sales"] == 12
    assert ov["barang"] == 87
    assert round(ov["qty"]) == 108544
    assert ov["ps"] == "2026-06-02" and ov["pe"] == "2026-06-26"
    print("OK  KPI ringkasan cocok dgn reference:", ov["inv"], "invoice, netto", round(ov["netto"]))

    assert data["kota"]["labels"][0] == "KOTA PANGKAL PINANG"
    assert round(data["kota"]["netto"][0]) == 2692492459
    print("OK  Per kota: top kota =", data["kota"]["labels"][0])

    assert data["salesman"]["labels"][0] == "ANDRE"
    assert round(data["salesman"]["netto"][0]) == 1717119921
    print("OK  Salesman: top =", data["salesman"]["labels"][0])

    assert len(data["barang"]["labels"]) <= 15
    assert len(data["customer"]["labels"]) <= 15
    print("OK  Top-15 produk & customer dipotong dgn benar")

    # kolom "sering kosong" di file nyata ini (Kecamatan/Desa/Region/Market/Jenis Market/Golongan/Kelompok)
    # semua HARUS masuk skipped_cols (dicek di sesi sebelumnya: nunique<=1 atau placeholder)
    for col in ["Kecamatan", "Desa", "Region", "Market", "Jenis Market", "Golongan", "Kelompok Barang"]:
        assert col in data["_meta"]["skipped_cols"], f"{col} harusnya di-skip (placeholder di data nyata)"
    print("OK  7 kolom placeholder terdeteksi & di-skip:", data["_meta"]["skipped_cols"])

    # Jenis Produk & Nama Gudang WAJIB tetap ada (bukan kolom optional, data real-nya terisi)
    assert data["jenis"]["labels"][0] == "SCM"
    assert len(data["gudang"]["labels"]) == 10
    print("OK  Jenis Produk & Gudang (section wajib) tetap terisi:", data["jenis"]["labels"][:2], len(data["gudang"]["labels"]), "gudang")

    # generate HTML utuh, pastikan semua 9 section + toolbar chip ada, dan note honesty muncul
    html = generate_dashboard(df)
    for sec in ["overview", "trend", "wilayah", "salesman", "produk", "jenis", "customer", "gudang", "diskon"]:
        assert f'data-sec="{sec}"' in html, f"section {sec} hilang dari HTML"
    assert "Kecamatan" in html and "Catatan kejujuran data" in html
    assert "__" not in html.split("<script>")[0], "ada token placeholder __X__ yang belum ke-replace"
    print("OK  HTML lengkap: 9 section + toolbar + note honesty ada, tidak ada token placeholder sisa")

    with open("output_penjualan.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("OK  ditulis ke dashboard-generator/output_penjualan.html buat di-preview")

    print("\nSemua self-check Fase 2 lulus.")


if __name__ == "__main__":
    demo()
