"""Tujuan: Self-check dashboard membaca semua sheet sejenis dalam satu workbook multi-sheet.
Caller: Jalankan langsung dengan `python test_multisheet_dashboard.py`.
Dependensi: pandas, tempfile, app.Api/read_detected_sheets, detector.detect_report_type_from_file, sample Laba Rugi nyata.
Main Functions: demo.
Side Effects: Membuat workbook temp .xlsx lalu menghapusnya.
"""
import os
import tempfile

import pandas as pd

from app import Api, read_detected_sheets
from detector import detect_report_type_from_file


SAMPLE = "samples/Lap_Laba_Rugi_Penjualan_20260626_174129.XLS"


def demo():
    df = pd.read_excel(SAMPLE)
    expected_total = round(df["Nilai Jual"].sum())

    tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
    tmp.close()
    try:
        mid = len(df) // 2
        df_1 = df.iloc[:mid].assign(**{"Kolom Ekstra Tidak Dipakai": "abaikan"})
        df_2 = df.iloc[mid:].assign(**{"Kolom Ekstra Tidak Dipakai": "abaikan"})
        with pd.ExcelWriter(tmp.name, engine="openpyxl") as writer:
            pd.DataFrame({"Ringkasan": ["bukan data"]}).to_excel(writer, sheet_name="Cover", index=False)
            df_1.to_excel(writer, sheet_name="Juni 1", index=False)
            df_2.to_excel(writer, sheet_name="Juni 2", index=False)

        res = Api().generate(tmp.name, "LabaRugi")
        assert res["ok"], res
        assert res["jenis"] == "LabaRugi"
        assert res["sheets"] == ["Juni 1", "Juni 2"], res["sheets"]
        assert "Rp 96.814.153" in res["html"], "nilai jual harus gabungan dua sheet, bukan sheet pertama saja"
        assert str(expected_total) == "96814153"
        detected = detect_report_type_from_file(tmp.name, preferred_jenis="LabaRugi")
        combined = read_detected_sheets(tmp.name, detected)
        assert "Kolom Ekstra Tidak Dipakai" not in combined.columns
        assert len(combined) == len(df)
        print("OK  dashboard Laba Rugi membaca dan menggabungkan semua sheet sejenis")
    finally:
        os.unlink(tmp.name)


if __name__ == "__main__":
    demo()
