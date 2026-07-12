"""Tujuan: Self-check dashboard Laba Rugi Penjualan, termasuk alias kolom HPP.
Caller: Jalankan langsung dengan `python test_labarugi.py`.
Dependensi: pandas, sample XLS nyata, labarugi.build_data/generate_dashboard.
Main Functions: demo.
Side Effects: Menulis output_labarugi.html untuk preview manual.
"""
import pandas as pd

from labarugi import build_data, generate_dashboard

SAMPLE = "samples/Lap_Laba_Rugi_Penjualan_20260626_174129.XLS"


def demo():
    df = pd.read_excel(SAMPLE)
    data = build_data(df)
    ov = data["ov"]

    # Angka harus persis sama dengan reference/dashboard_laba_rugi.html (dibuat dari file yang sama)
    assert round(ov["jual"]) == 96814153, ov["jual"]
    assert round(ov["hpp"]) == 89765347, ov["hpp"]
    assert round(ov["laba"]) == 7048806, ov["laba"]
    assert ov["margin"] == 7.3
    assert ov["nota"] == 176
    assert ov["cust"] == 165
    assert ov["barang"] == 60
    assert ov["sales"] == 10
    print("OK  KPI ringkasan cocok dgn reference: laba", round(ov["laba"]), "margin", ov["margin"], "%")

    hpp_values = df["JUM HPP"].copy()
    df_hpp_alias = df.drop(columns=[c for c in ["JUM HPP", "Nilai HPP"] if c in df.columns])
    df_hpp_alias = df_hpp_alias.assign(**{"Nilai HPP": hpp_values})
    alias_ov = build_data(df_hpp_alias)["ov"]
    assert round(alias_ov["hpp"]) == 89765347
    assert round(alias_ov["laba"]) == 7048806
    assert "Dashboard Laba Rugi Penjualan" in generate_dashboard(df_hpp_alias)
    print("OK  Alias HPP 'Nilai HPP' dihitung sama seperti 'JUM HPP'")

    # Produk RUGI wajib ada 3, nama & kerugian persis sama dgn reference
    rugi = dict(zip(data["barang_rugi"]["labels"], data["barang_rugi"]["laba"]))
    assert len(rugi) == 3
    assert round(rugi["CONFIDENCE PANTS TIPIS PAS L 48X1S"]) == -169924
    assert round(rugi["CONFIDENCE PANTS TIPIS PAS M 1S"]) == -88282
    assert round(rugi["CONFIDENCE PANTS DAILY FRESH L 8X8S"]) == -11476
    print("OK  3 produk rugi cocok persis dgn reference (nama & nilai kerugian)")

    # RANKING WAJIB by laba (bukan jual) untuk salesman & customer -- cek non-monoton thd jual tapi
    # monoton thd laba, buktikan bukan cuma kebetulan ranking sama dgn jual
    salesman_laba = data["salesman"]["laba"]
    assert salesman_laba == sorted(salesman_laba, reverse=True), "salesman harus terurut by laba"
    assert data["salesman"]["labels"][0] == "ISMAIL"  # ISMAIL laba #1 walau jual-nya < JUWITA VERONIKA
    salesman_jual = data["salesman"]["jual"]
    assert salesman_jual != sorted(salesman_jual, reverse=True), "sanity: urutan jual TIDAK sama dgn urutan laba (buktikan ranking memang pakai laba, bukan kebetulan)"
    print("OK  Salesman diranking by LABA, bukan jual (ISMAIL #1 meski omzetnya bukan tertinggi)")

    customer_laba = data["customer"]["laba"]
    assert customer_laba == sorted(customer_laba, reverse=True), "customer harus terurut by laba"
    print("OK  Customer diranking by LABA")

    # Kota TIDAK wajib by laba (ikuti reference: by nilai jual)
    kota_jual = data["kota"]["jual"]
    assert kota_jual == sorted(kota_jual, reverse=True)
    print("OK  Kota tetap diranking by nilai jual (sesuai reference)")

    # kolom placeholder (Job/Market/Golongan Barang) harus ke-skip
    for col in ["Job", "Market", "Golongan Barang"]:
        assert col in data["_meta"]["skipped_cols"], f"{col} harusnya di-skip"
    print("OK  Kolom placeholder ter-skip:", data["_meta"]["skipped_cols"])

    html = generate_dashboard(df)
    for sec in ["overview", "trend", "produk", "rugi", "salesman", "kota", "customer"]:
        assert f'data-sec="{sec}"' in html, f"section {sec} hilang"
    assert "CONFIDENCE PANTS TIPIS PAS L 48X1S" in html and "Kerugian" in html
    assert "__" not in html.split("<script>")[0], "ada token placeholder __X__ tersisa"
    print("OK  HTML lengkap: 7 section + tabel produk rugi ada, tidak ada token placeholder sisa")

    # regression: section rugi HARUS tampil pesan positif kalau kosong (bukan section hilang)
    df_no_rugi = df.assign(**{"JUM HPP": df["Nilai Jual"] * 0.5})  # paksa semua untung
    data_no_rugi = build_data(df_no_rugi)
    assert data_no_rugi["_meta"]["rugi_count"] == 0
    html_no_rugi = generate_dashboard(df_no_rugi)
    assert "Tidak ada produk rugi" in html_no_rugi
    assert 'data-sec="rugi"' in html_no_rugi, "section Produk Rugi tidak boleh hilang walau kosong"
    print("OK  Kalau tidak ada produk rugi, section tetap ada dgn pesan positif (tidak disembunyikan)")

    with open("output_labarugi.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("OK  ditulis ke dashboard-generator/output_labarugi.html buat di-preview")

    print("\nSemua self-check Fase 3 lulus.")


if __name__ == "__main__":
    demo()
