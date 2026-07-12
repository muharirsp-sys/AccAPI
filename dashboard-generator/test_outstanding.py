"""Self-check Fase 6b. Jalankan: python test_outstanding.py"""
import pandas as pd

from outstanding import build_data, generate_dashboard

SAMPLE = "samples/Lap_Outs_Sales_Order_20260709_091446.XLS"


def demo():
    df = pd.read_excel(SAMPLE)
    data = build_data(df)
    ov = data["ov"]

    # Angka harus persis sama dengan reference/dashboard_outstanding_so.html
    assert round(ov["nilai"]) == 302817895, ov["nilai"]
    assert ov["so"] == 37
    assert ov["cust"] == 37
    assert ov["kota"] == 4
    assert ov["ps"] == "2026-01-02" and ov["pe"] == "2026-07-09"
    assert ov["report_date"] == "2026-07-09"
    print("OK  KPI ringkasan cocok dgn reference:", round(ov["nilai"]), "Rupiah,", ov["so"], "SO")

    # AGING WAJIB: bucket persis sama dgn reference (n=[197,1,0,38], >90 hari = 38 senilai 99.264.007)
    assert data["aging"]["n"] == [197, 1, 0, 38]
    assert ov["over90_n"] == 38
    assert ov["over90_nilai"] == 99264007
    print("OK  Aging bucket cocok persis dgn reference: n=", data["aging"]["n"], "over90=", ov["over90_nilai"])

    assert data["kota"]["labels"][0] == "KABUPATEN BANGKA"
    assert data["customer"]["labels"][0] == "PT. INDOMARCO ADI PRIMA"
    print("OK  Per kota & per customer cocok dgn reference")

    # Satuan campur (CTN/PCS/RCG/BTL) -> qty per baris di detail TIDAK boleh dijumlahkan lintas satuan
    assert all("satuan" in r and "qty" in r for r in data["top_so"])
    print("OK  Detail order tampilkan qty+satuan per baris (bukan agregat lintas satuan)")

    # order >90 hari WAJIB ditandai (flag) di tabel detail
    html = generate_dashboard(df)
    assert "&#9888;" in html and "103 hari" in html  # SOJ/2603/NA4022 aging 103 hari dari reference
    for sec in ["overview", "aging", "job", "kota", "customer", "detail"]:
        assert f'data-sec="{sec}"' in html, f"section {sec} hilang"
    assert "satuan campur" in html
    assert "__" not in html.split("<script>")[0], "ada token placeholder __X__ tersisa"
    print("OK  HTML lengkap: 6 section + flag >90 hari + catatan satuan campur ada")

    with open("output_outstanding.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("OK  ditulis ke dashboard-generator/output_outstanding.html buat di-preview")

    print("\nSemua self-check Fase 6b (Outstanding SO) lulus.")


if __name__ == "__main__":
    demo()
