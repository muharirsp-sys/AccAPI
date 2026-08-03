# Tujuan: Menjaga preview laporan harian dapat membaca workbook PyExcelerate tanpa mengirim file penuh.
# Caller: Developer/CI melalui eksekusi Python langsung.
# Dependensi: pyexcelerate dan routers.laporan_harian.
# Main Functions: main() menguji preview 26 baris, path guard, dan file tidak ditemukan.
# Side Effects: Membuat dan menghapus workbook sementara.

import json
import tempfile
from pathlib import Path

from pyexcelerate import Workbook

from routers import laporan_harian as route


def payload(response) -> dict:
    return json.loads(response.body)


def main() -> None:
    original_runtime_dir = route.LH_RUNTIME_DIR
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            route.LH_RUNTIME_DIR = temp_dir
            run_id = "run-preview-1"
            file_name = "2026-07-30_HENDRIK.xlsx"
            run_dir = Path(temp_dir, run_id)
            run_dir.mkdir()

            workbook = Workbook()
            rows = [["NO_NOTA", "CUSTOMER", "DPP"]]
            rows.extend([[f"INV-{index:03d}", f"TOKO {index}", index * 1000] for index in range(30)])
            workbook.new_sheet("HENDRIK", data=rows)
            workbook.save(run_dir / file_name)

            response = route.laporan_harian_preview(run_id, file_name)
            data = payload(response)
            assert response.status_code == 200
            assert data["fileName"] == file_name
            assert data["sheetName"] == "HENDRIK"
            assert len(data["matrix"]) == 26
            assert data["matrix"][0] == ["NO_NOTA", "CUSTOMER", "DPP"]
            assert data["matrix"][1] == ["INV-000", "TOKO 0", 0]

            invalid = route.laporan_harian_preview("../run", file_name)
            assert invalid.status_code == 400
            missing = route.laporan_harian_preview(run_id, "2026-07-30_MISSING.xlsx")
            assert missing.status_code == 404
    finally:
        route.LH_RUNTIME_DIR = original_runtime_dir

    print("OK: preview PyExcelerate dibaca sebagai JSON ringkas")


if __name__ == "__main__":
    main()
