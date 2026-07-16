# Tujuan: Menjaga header dan nilai file laporan harian tetap sejajar satu-ke-satu.
# Caller: Developer/CI melalui eksekusi Python langsung.
# Dependensi: pandas, openpyxl, laporan_harian.resolve_report_groups, dan write_report_files.
# Main Functions: main() memeriksa file SPV, SM, principal, alias, dan sheet Stock sesuai cakupan.
# Side Effects: Membuat lalu menghapus workbook sementara.

import tempfile
from pathlib import Path

import openpyxl
import pandas as pd

import laporan_harian as laporan


def main() -> None:
    source = pd.DataFrame([
        {"GOLONGAN": "DENNY", "NAMA_SM": "HENDRIK", "PRINCIPAL": "ENERGIZER INDONESIA, PT",
         "KODE_BARANG": "SKU-1", "AO": 7, "EC": 9, "IA": 11, "Item Aktif": 11},
        {"GOLONGAN": "YUDI", "NAMA_SM": "HENDRIK", "PRINCIPAL": "MOTASA INDONESIA, PT",
         "KODE_BARANG": "SKU-2", "AO": 1, "EC": 1, "IA": 1, "Item Aktif": 1},
    ])
    stock = pd.DataFrame([
        {"KODE_BARANG": "SKU-1", "QTY AKHIR": 25, "PRINCIPAL": "ENERGIZER INDONESIA, PT",
         "GOLONGAN": "DENNY", "NAMA_SM": "HENDRIK"},
        {"KODE_BARANG": "SKU-2", "QTY AKHIR": 10, "PRINCIPAL": "MOTASA INDONESIA, PT",
         "GOLONGAN": "YUDI", "NAMA_SM": "HENDRIK"},
    ])
    lookups = laporan.LookupTables({}, {}, {}, {}, {
        "ENERGIZER": {"group_type": "principal", "values": ["ENERGIZER INDONESIA, PT"]},
        "MOTASA MKS 1": {"group_type": "principal", "values": ["MOTASA INDONESIA, PT"]},
        "MOTASA MKS 2": {"group_type": "principal", "values": ["MOTASA INDONESIA, PT"]},
    })

    frame = laporan.build_report_frame(source)
    assert frame.columns.tolist() == laporan.REPORT_COLUMNS
    assert not frame.columns.duplicated().any()

    with tempfile.TemporaryDirectory() as temp_dir:
        written, unmatched = laporan.write_report_files(
            source, temp_dir, "2026-07-15",
            ["DENNY", "HENDRIK", "ENERGIZER", "MOTASA MKS 1", "MOTASA MKS 2", "UNKNOWN"],
            lookups, stock,
        )
        assert [item["keyword"] for item in written] == [
            "DENNY", "HENDRIK", "ENERGIZER", "MOTASA MKS 1", "MOTASA MKS 2",
        ]
        assert unmatched == ["UNKNOWN"]
        assert {item["groupType"] for item in written} == {"spv", "sm", "principal"}
        output = Path(next(item["path"] for item in written if item["keyword"] == "DENNY"))
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
        assert next(item["stockRows"] for item in written if item["keyword"] == "DENNY") == 1
        workbook.close()

    print("OK: file SPV/SM/principal dan sheet Stock sesuai mapping")


if __name__ == "__main__":
    main()
