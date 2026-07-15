# Tujuan: Menjaga header dan nilai file laporan harian tetap sejajar satu-ke-satu.
# Caller: Developer/CI melalui eksekusi Python langsung.
# Dependensi: pandas, openpyxl, dan laporan_harian.write_per_spv_files.
# Main Functions: main() membuat satu laporan minimum dan memeriksa AO/EC/Item Aktif.
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

    frame = laporan.build_report_frame(source)
    assert frame.columns.tolist() == laporan.REPORT_COLUMNS
    assert not frame.columns.duplicated().any()

    with tempfile.TemporaryDirectory() as temp_dir:
        written = laporan.write_per_spv_files(source, temp_dir, "2026-07-15")
        output = Path(written[0]["path"])
        workbook = openpyxl.load_workbook(output, read_only=True, data_only=True)
        sheet = workbook.active
        headers = [cell.value for cell in sheet[1]]
        values = [cell.value for cell in sheet[2]]
        workbook.close()

        assert headers[:len(laporan.REPORT_COLUMNS)] == laporan.REPORT_COLUMNS
        assert all(value is None for value in headers[len(laporan.REPORT_COLUMNS):])
        assert all(value is None for value in values[len(laporan.REPORT_COLUMNS):])
        assert values[headers.index("AO")] == 7
        assert values[headers.index("EC")] == 9
        assert values[headers.index("Item Aktif")] == 11

    print("OK: kolom AO/EC/Item Aktif sejajar dengan header")


if __name__ == "__main__":
    main()
