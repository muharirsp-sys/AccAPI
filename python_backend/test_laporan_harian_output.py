# Tujuan: Menjaga header dan nilai file laporan harian tetap sejajar satu-ke-satu.
# Caller: Developer/CI melalui eksekusi Python langsung.
# Dependensi: pandas, openpyxl, dan laporan_harian.write_per_spv_files.
# Main Functions: main() memeriksa AO/EC/Item Aktif serta sheet Stock per SPV.
# Side Effects: Membuat lalu menghapus workbook sementara.

import tempfile
from pathlib import Path

import openpyxl
import pandas as pd

import laporan_harian as laporan


def main() -> None:
    source = pd.DataFrame([{
        "GOLONGAN": "DENNY",
        "AO": 7,
        "EC": 9,
        "IA": 11,
        "Item Aktif": 11,
    }])
    stock = pd.DataFrame([{
        "KODE_BARANG": "SKU-1",
        "QTY AKHIR": 25,
        "GOLONGAN": "DENNY",
    }])

    frame = laporan.build_report_frame(source)
    assert frame.columns.tolist() == laporan.REPORT_COLUMNS
    assert not frame.columns.duplicated().any()

    with tempfile.TemporaryDirectory() as temp_dir:
        written = laporan.write_per_spv_files(source, temp_dir, "2026-07-15", {"DENNY": stock})
        output = Path(written[0]["path"])
        workbook = openpyxl.load_workbook(output, read_only=True, data_only=True)
        assert workbook.sheetnames == ["DENNY", "DENNY Stock"]
        sheet = workbook["DENNY"]
        headers = [cell.value for cell in sheet[1]]
        values = [cell.value for cell in sheet[2]]

        assert headers[:len(laporan.REPORT_COLUMNS)] == laporan.REPORT_COLUMNS
        assert all(value is None for value in headers[len(laporan.REPORT_COLUMNS):])
        assert all(value is None for value in values[len(laporan.REPORT_COLUMNS):])
        assert values[headers.index("AO")] == 7
        assert values[headers.index("EC")] == 9
        assert values[headers.index("Item Aktif")] == 11
        stock_sheet = workbook["DENNY Stock"]
        stock_headers = [cell.value for cell in stock_sheet[1]]
        stock_values = [cell.value for cell in stock_sheet[2]]
        assert stock_values[stock_headers.index("KODE_BARANG")] == "SKU-1"
        assert stock_values[stock_headers.index("QTY AKHIR")] == 25
        assert written[0]["stockRows"] == 1
        workbook.close()

    print("OK: AO/EC/Item Aktif sejajar dan sheet Stock tersedia")


if __name__ == "__main__":
    main()
