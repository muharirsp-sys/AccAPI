"""Self-check Fase 4. Jalankan: python test_stok.py"""
import pandas as pd

from stok import build_data, generate_dashboard

SAMPLE = "samples/Lap_Posisi_Barang_Per_Gudang_20260708_202110.XLS"


def demo():
    df = pd.read_excel(SAMPLE)
    data = build_data(df)
    ov = data["ov"]

    # Angka harus persis sama dengan reference/dashboard_posisi_stok.html
    assert ov["saldo"] == 353477, ov["saldo"]
    assert ov["sku"] == 332
    assert ov["baris"] == 617
    assert ov["gudang"] == 7
    assert ov["principal"] == 5
    assert ov["golongan"] == 19
    assert ov["jenis"] == 29
    print("OK  KPI ringkasan cocok dgn reference:", ov["saldo"], "unit,", ov["sku"], "SKU,", ov["gudang"], "gudang")

    # CEK WAJIB snapshot: Debet/Kredit nol, Saldo Awal==Saldo Akhir semua baris (data nyata ini memang begitu)
    assert data["_meta"]["is_snapshot"] is True
    print("OK  Terdeteksi sbg laporan snapshot (Debet=Kredit=0, Saldo Awal==Saldo Akhir semua baris)")

    # Utama vs Kanvas -- deteksi kata "KANVAS" di Nama Gudang, totalnya harus cocok dgn reference
    tipe = dict(zip(data["tipe_gudang"]["labels"], data["tipe_gudang"]["saldo"]))
    assert tipe["Gudang Utama"] == 344200
    assert tipe["Kanvas (Mobile)"] == 9277
    print("OK  Utama vs Kanvas:", tipe)

    assert data["golongan"]["labels"][0] == "SABUN BATANG"
    assert data["top_sku"]["labels"][0] == "PROMAG TABLET 30S/180"
    print("OK  Top golongan & top SKU cocok dgn reference")

    # Expired Date & Kelompok placeholder ("01/01/0001" & "-") -> harus ke-skip
    assert data["_meta"]["has_expired"] is False
    assert data["_meta"]["has_kelompok"] is False
    print("OK  Expired Date & Kelompok terdeteksi placeholder (di-skip)")

    html = generate_dashboard(df)
    for sec in ["overview", "golongan", "jenis", "principal", "gudang", "tipe", "topsku"]:
        assert f'data-sec="{sec}"' in html, f"section {sec} hilang"
    assert "snapshot posisi akhir" in html, "note honesty snapshot harus muncul"
    assert "dead stock" in html
    assert "__" not in html.split("<script>")[0], "ada token placeholder __X__ tersisa"
    print("OK  HTML lengkap: 7 section + note snapshot honesty ada, tidak ada token placeholder sisa")

    # regression: kalau ada pergerakan asli (Debet>0), JANGAN tampilkan note snapshot / anggap snapshot
    df_movement = df.copy()
    df_movement.loc[df_movement.index[0], "Debet"] = 100
    data_movement = build_data(df_movement)
    assert data_movement["_meta"]["is_snapshot"] is False
    html_movement = generate_dashboard(df_movement)
    assert "snapshot posisi akhir" not in html_movement
    print("OK  Kalau ada Debet/Kredit asli, note snapshot TIDAK muncul (bukan dipaksa selalu tampil)")

    with open("output_stok.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("OK  ditulis ke dashboard-generator/output_stok.html buat di-preview")

    print("\nSemua self-check Fase 4 lulus.")


if __name__ == "__main__":
    demo()
