"""Tujuan: Self-check dashboard Umur Piutang. Jalankan: python test_umur_piutang.py.
Caller: Developer/local verification sebelum build exe.
Dependensi: pandas, umur_piutang.build_data/generate_dashboard, sample XLS real.
Main Functions: demo.
Side Effects: Menulis output_umur_piutang.html untuk preview manual.
"""
import pandas as pd

from umur_piutang import build_data, generate_dashboard

SAMPLE = "samples/LapUmurPiutang_20260711_084826.XLS"


def demo():
    df = pd.read_excel(SAMPLE)
    data = build_data(df)
    ov = data["ov"]

    assert round(ov["nilai"]) == 1173867369, ov["nilai"]
    assert round(ov["belum"]) == 368980538, ov["belum"]
    assert round(ov["overdue"]) == 804886832, ov["overdue"]
    assert round(ov["severe"]) == 81905755, ov["severe"]
    assert round(ov["jt4"]) == 4662358, ov["jt4"]
    assert ov["doc"] == 298
    assert ov["cust"] == 82
    assert ov["report_date"] == "2026-01-31"
    print("OK  KPI piutang cocok:", round(ov["nilai"]), "overdue", round(ov["overdue"]), "as-of", ov["report_date"])

    assert data["bucket"][0]["short"] == "Belum JT"
    assert data["bucket"][1]["short"] == "JT 1"
    assert [round(r["nilai"]) for r in data["bucket"]] == [368980538, 415281127, 307699950, 77243397, 4662358]
    print("OK  Bucket aging cocok: Belum JT, JT1, JT2, JT3, JT4")

    assert data["customer"][0]["label"] == "CV. ALFA GEMILANG"
    assert round(data["customer"][0]["nilai"]) == 267462119
    assert data["severe_customer"][0]["label"] == "CV. ALFA GEMILANG"
    assert round(data["severe_customer"][0]["severe"]) == 52727715
    print("OK  Top customer dan prioritas JT3+JT4 cocok")

    assert data["salesman"][0]["label"] == "AGUS VINDI"
    assert data["salesman"][1]["label"] == "(Belum ada salesman)"
    assert round(data["_meta"]["salesman_blank_nilai"]) == 388807683
    print("OK  Salesman kosong tetap dikelompokkan eksplisit")

    html = generate_dashboard(df)
    for sec in ["overview", "aging", "customer", "collection", "salesman", "wilayah", "dokumen", "detail"]:
        assert f'data-sec="{sec}"' in html, f"section {sec} hilang"
    for text in ["Dashboard Umur Piutang", "Rp 1.173.867.369", "CV. ALFA GEMILANG", "2026-01-31"]:
        assert text in html, f"text acuan hilang: {text}"
    assert "cdn.jsdelivr.net" not in html
    assert "__" not in html.split("<script>")[0], "ada token placeholder __X__ tersisa"
    print("OK  HTML lengkap, offline, tanpa placeholder")

    with open("output_umur_piutang.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("OK  ditulis ke dashboard-generator/output_umur_piutang.html buat di-preview")

    print("\nSemua self-check Umur Piutang lulus.")


if __name__ == "__main__":
    demo()
