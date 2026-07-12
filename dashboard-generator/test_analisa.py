"""Self-check Fase 5. Jalankan: python test_analisa.py"""
import pandas as pd

from analisa import build_data, generate_dashboard

SAMPLE = "samples/Lap_Analisa_Posisi_Barang_20260708_201944.XLS"


def demo():
    df = pd.read_excel(SAMPLE)
    data = build_data(df)
    ov = data["ov"]

    # Angka harus persis sama dengan reference/dashboard_analisa_stok.html
    assert round(ov["nilai"]) == 11615604762, ov["nilai"]
    assert ov["qty"] == 824004
    assert ov["sku"] == 332
    assert ov["golongan"] == 19
    assert ov["jenis"] == 29
    assert ov["principal"] == 5
    print("OK  KPI ringkasan cocok dgn reference:", round(ov["nilai"]), "Rupiah,", ov["qty"], "qty")

    # Kontribusi nilai vs volume (top golongan) harus cocok persis dgn reference
    kontribusi = dict(zip(data["kontribusi"]["labels"], zip(data["kontribusi"]["pct_nilai"], data["kontribusi"]["pct_qty"])))
    assert kontribusi["SAKA 2"] == (27.1, 15.2)
    assert kontribusi["SABUN BATANG"] == (17.2, 31.1)
    print("OK  Kontribusi nilai vs volume per golongan cocok persis dgn reference")

    assert data["top_sku"]["labels"][0] == "PROMAG TABLET 30S/180"
    assert round(data["top_sku"]["nilai"][0]) == 1634673017
    print("OK  Top SKU by nilai cocok dgn reference")

    # Satuan seragam "PCS" -> harus terdeteksi, note ttg harga per unit harus muncul
    assert data["_meta"]["satuan_uniform"] is True
    # 97 SKU multi-batch (legit, bukan duplikasi)
    assert data["_meta"]["multi_batch_sku"] == 97
    print("OK  Satuan seragam terdeteksi, 97 SKU multi-batch terdeteksi (legit)")

    html = generate_dashboard(df)
    for sec in ["overview", "golongan", "jenis", "principal", "kontribusi", "topsku"]:
        assert f'data-sec="{sec}"' in html, f"section {sec} hilang"
    assert "harga rata-rata per unit" in html and "TIDAK" in html
    assert "97 SKU" in html
    assert "__" not in html.split("<script>")[0], "ada token placeholder __X__ tersisa"
    print("OK  HTML lengkap: 6 section + note satuan/multi-batch ada, tidak ada token placeholder sisa")

    # regression: kalau Satuan BERAGAM (bukan seragam), note "harga per unit" TIDAK boleh muncul
    df_mixed = df.copy()
    df_mixed.loc[df_mixed.index[:5], "Satuan"] = "DUS"
    data_mixed = build_data(df_mixed)
    assert data_mixed["_meta"]["satuan_uniform"] is False
    html_mixed = generate_dashboard(df_mixed)
    assert "harga rata-rata per unit" not in html_mixed
    print("OK  Kalau Satuan sudah beragam, note ttg satuan seragam TIDAK muncul (bukan teks statis)")

    with open("output_analisa.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("OK  ditulis ke dashboard-generator/output_analisa.html buat di-preview")

    print("\nSemua self-check Fase 5 lulus.")


if __name__ == "__main__":
    demo()
