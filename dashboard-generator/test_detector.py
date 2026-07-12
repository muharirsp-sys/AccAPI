"""Tujuan: Self-check detector jenis laporan, termasuk multi-sheet dan alias kolom.
Caller: Jalankan langsung dengan `python test_detector.py`.
Dependensi: pandas, detector.detect_report_type/detect_report_type_from_file, sample XLS nyata.
Main Functions: demo.
Side Effects: Membuat workbook temp untuk uji multi-sheet lalu menghapusnya.
"""
import os
import tempfile

import pandas as pd

from detector import detect_report_type, detect_report_type_from_file

SAMPLES = {
    "Penjualan": ["No Invoice", "Tanggal", "Nilai Bruto", "Nilai Disc", "Kode Salesman", "Kode Principal", "Kota Customer"],
    "LabaRugi": ["No.Nota", "Tanggal", "Nilai Jual", "JUM HPP", "Biaya Lain", "Kode Salesman"],
    "PosisiStokGudang": ["Kode Gudang", "Nama Gudang", "Kode Barang", "Saldo Awal", "Debet", "Kredit", "Saldo Akhir"],
    "AnalisaStok": ["Kode Barang", "Saldo Awal Qty", "Saldo Akhir Nilai", "Kode Perkiraan", "No.Batch"],
    "Retur": ["No.Retur", "Tanggal", "Deskripsi Issue", "Kode Barang"],
    "OutstandingSO": ["No.SO", "Nama Job", "Tanggal Order", "Customer"],
    "UmurPiutang": ["No.Jurnal", "Nilai Belum JT", "Nilai JT 1", "Nilai JT 4", "Umur"],
}


def demo():
    # 1 sample sintetis per jenis (kolom saja, sesuai signature Fase 1) -> harus terdeteksi benar
    for expected, cols in SAMPLES.items():
        r = detect_report_type(cols)
        assert r.ok, f"{expected}: gagal dideteksi, kolom={cols}"
        assert r.jenis == expected, f"kolom {cols} salah dideteksi sbg {r.jenis}, harusnya {expected}"
        print(f"OK  {expected:<20} <- {cols}")

    laba_alias = ["No.Nota", "Tanggal", "Nilai Jual", "Nilai HPP", "Biaya Lain", "Kode Salesman"]
    r = detect_report_type(laba_alias)
    assert r.ok and r.jenis == "LabaRugi", f"alias Nilai HPP harus terdeteksi LabaRugi, hasil={r}"
    print("OK  LabaRugi terdeteksi juga saat HPP bernama Nilai HPP")

    # AnalisaStok TIDAK boleh salah kedeteksi sbg PosisiStokGudang (kasus "Saldo Awal Qty" vs "Saldo Awal")
    r = detect_report_type(SAMPLES["AnalisaStok"])
    assert r.jenis == "AnalisaStok"
    print("OK  AnalisaStok tidak tertukar dgn PosisiStokGudang (suffix Qty/Nilai dibedakan)")

    # kolom tak dikenal -> error jelas, bukan dipaksa proses
    r = detect_report_type(["Kolom Random 1", "Kolom Random 2"])
    assert not r.ok
    assert "tidak dikenali" in r.error
    print(f"OK  kolom tak dikenal -> error: {r.error}")

    # file Excel asli di repo (Data_Penjualan) -> kolomnya beda dari signature Fase 1 (raw export Accurate,
    # bukan salah satu dari 6 format target), jadi HARUS ditolak jujur, bukan dipaksa jadi "Penjualan"
    real_path = "../Data_Penjualan/2024/07 PENJUALAN 7 - CLOSING JULI 2024.xlsx"
    r = detect_report_type_from_file(real_path)
    assert not r.ok, "file Data_Penjualan seharusnya tidak cocok signature manapun (kolom raw beda)"
    print("OK  file nyata Data_Penjualan/...JULI 2024.xlsx -> ditolak dgn benar (bukan format target Fase 1)")

    # 7 file XLS asli (template dari user, format Accurate Lap_* .XLS lama) -> harus terdeteksi semua benar.
    # Regression case: Lap_Retur_Penjualan ikut bawa kolom invoice asal (No.Invoice, Kode Salesman, Kode
    # Principal, Nilai Bruto, Nilai Disc) yang sempat salah kedeteksi jadi Penjualan sebelum _PRIORITY dibuat.
    real_samples = {
        "Retur": "samples/Lap_Retur_Penjualan_20260709_091934.XLS",
        "OutstandingSO": "samples/Lap_Outs_Sales_Order_20260709_091446.XLS",
        "AnalisaStok": "samples/Lap_Analisa_Posisi_Barang_20260708_201944.XLS",
        "PosisiStokGudang": "samples/Lap_Posisi_Barang_Per_Gudang_20260708_202110.XLS",
        "Penjualan": "samples/Lap_Penjualan_20260626_172000.XLS",
        "LabaRugi": "samples/Lap_Laba_Rugi_Penjualan_20260626_174129.XLS",
        "UmurPiutang": "samples/LapUmurPiutang_20260711_084826.XLS",
    }
    for expected, path in real_samples.items():
        r = detect_report_type_from_file(path)
        assert r.jenis == expected, f"{path}: terdeteksi {r.jenis}, harusnya {expected}"
        print(f"OK  file nyata {expected:<18} -> {path}")

    # Workbook multi-sheet: sheet pertama bisa cover/summary, data target ada di sheet lain.
    tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
    tmp.close()
    try:
        with pd.ExcelWriter(tmp.name, engine="openpyxl") as writer:
            pd.DataFrame({"Ringkasan": ["bukan data laporan"]}).to_excel(writer, sheet_name="Cover", index=False)
            pd.DataFrame(columns=SAMPLES["LabaRugi"]).to_excel(writer, sheet_name="Data Laba 1", index=False)
            pd.DataFrame(columns=SAMPLES["LabaRugi"]).to_excel(writer, sheet_name="Data Laba 2", index=False)
            pd.DataFrame(columns=SAMPLES["Retur"]).to_excel(writer, sheet_name="Data Retur", index=False)

        r = detect_report_type_from_file(tmp.name, preferred_jenis="LabaRugi")
        assert r.ok and r.jenis == "LabaRugi", r
        assert r.sheet_name == "Data Laba 1", r.sheet_name
        assert r.sheet_names == ["Data Laba 1", "Data Laba 2"], r.sheet_names
        print("OK  workbook multi-sheet: preferred LabaRugi mengembalikan semua sheet data Laba")

        r = detect_report_type_from_file(tmp.name, preferred_jenis="Retur")
        assert r.ok and r.jenis == "Retur", r
        assert r.sheet_name == "Data Retur", r.sheet_name
        print("OK  workbook multi-sheet: preferred Retur ditemukan di sheet Data Retur")
    finally:
        os.unlink(tmp.name)

    print("\nSemua self-check Fase 1 lulus.")


if __name__ == "__main__":
    demo()
