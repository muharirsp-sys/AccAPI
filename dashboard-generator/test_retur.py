"""Self-check Fase 6a. Jalankan: python test_retur.py"""
import pandas as pd

from retur import build_data, generate_dashboard

SAMPLE = "samples/Lap_Retur_Penjualan_20260709_091934.XLS"


def demo():
    df = pd.read_excel(SAMPLE)
    data = build_data(df)
    ov = data["ov"]

    assert round(ov["nilai"]) == 47967002, ov["nilai"]
    assert ov["qty"] == 13746
    assert ov["n"] == 53
    assert ov["principal"] == 3
    assert ov["sales"] == 9
    assert ov["ps"] == "2026-07-01" and ov["pe"] == "2026-07-02"
    print("OK  KPI ringkasan cocok dgn reference:", round(ov["nilai"]), "Rupiah,", ov["n"], "transaksi")

    assert data["principal"]["labels"][0] == "INDOFOOD SUKSES MAKMUR"
    assert round(data["principal"]["nilai"][0]) in (33017515, 33017516)
    assert data["jenis"]["labels"][0] == "INDOMIE"
    assert round(data["jenis"]["nilai"][0]) in (26941939, 26941940)
    print("OK  Per principal & per jenis (Kode Jenis Produk) cocok dgn reference")

    # Deskripsi Issue kosong di seluruh data nyata ini -> note WAJIB muncul, chart alasan retur TIDAK dibuat
    assert data["_meta"]["has_issue"] is False
    html = generate_dashboard(df)
    assert "Deskripsi Issue" in html and "TIDAK bisa dibuat" in html
    print("OK  Kolom Deskripsi Issue kosong terdeteksi, note honesty muncul (bukan chart alasan retur palsu)")

    for sec in ["overview", "principal", "market", "jenis", "kota", "salesman", "gudang"]:
        assert f'data-sec="{sec}"' in html, f"section {sec} hilang"
    assert "__" not in html.split("<script>")[0], "ada token placeholder __X__ tersisa"
    print("OK  HTML lengkap: 7 section ada, tidak ada token placeholder sisa")

    # regression: kalau Deskripsi Issue TERISI beneran, note ini TIDAK boleh muncul
    df_filled = df.copy()
    df_filled["Deskripsi Issue"] = ["Rusak", "Salah Kirim"] * (len(df_filled) // 2) + ["Rusak"] * (len(df_filled) % 2)
    data_filled = build_data(df_filled)
    assert data_filled["_meta"]["has_issue"] is True
    html_filled = generate_dashboard(df_filled)
    assert "TIDAK bisa dibuat" not in html_filled
    print("OK  Kalau Deskripsi Issue terisi beneran, note kekosongan TIDAK muncul (bukan teks statis)")

    with open("output_retur.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("OK  ditulis ke dashboard-generator/output_retur.html buat di-preview")

    print("\nSemua self-check Fase 6a (Retur) lulus.")


if __name__ == "__main__":
    demo()
