"""Tujuan: App desktop pywebview untuk generate dashboard dari file Excel Accurate.
Caller: Dijalankan langsung via python app.py atau dibundel PyInstaller di Fase 8.
Dependensi: pandas, pywebview, detector multi-sheet, modul dashboard Fase 2-7, guard pasangan CrossAnalysis.
Main Functions: read_detected_sheets, Api.report_types, Api.pick_file, Api.pick_files, Api.generate, Api.generate_cross, main.
Side Effects: Membuka dialog file native, membaca kolom terpakai dari semua sheet Excel sejenis, export HTML ke disk.
"""
import os

import pandas as pd
import webview

from detector import detect_report_type_from_file, SIGNATURES
from penjualan import generate_dashboard as generate_penjualan
from labarugi import generate_dashboard as generate_labarugi
from stok import generate_dashboard as generate_stok
from analisa import generate_dashboard as generate_analisa
from retur import generate_dashboard as generate_retur
from outstanding import generate_dashboard as generate_outstanding
from cross_analysis import generate_dashboard as generate_cross_analysis, has_supported_pair, supported_pair_labels
from umur_piutang import generate_dashboard as generate_umur_piutang

# ponytail: tambah 1 baris di sini tiap modul baru selesai; internal key tetap stabil utk detector/test.
MODULES = {
    "Penjualan": generate_penjualan,
    "LabaRugi": generate_labarugi,
    "PosisiStokGudang": generate_stok,
    "AnalisaStok": generate_analisa,
    "Retur": generate_retur,
    "OutstandingSO": generate_outstanding,
    "UmurPiutang": generate_umur_piutang,
}
DISPLAY_NAMES = {
    "Penjualan": "Penjualan",
    "LabaRugi": "Laba Rugi Penjualan",
    "PosisiStokGudang": "Posisi Stok",
    "AnalisaStok": "Analisa Stok",
    "Retur": "Retur Penjualan",
    "OutstandingSO": "Outstanding SO",
    "UmurPiutang": "Umur Piutang",
    "CrossAnalysis": "Cross Analysis",
}

READ_COLUMNS = {
    "Penjualan": {
        "No Invoice", "Tanggal", "Nilai Bruto", "Nilai Disc", "Kode Customer", "Nama Customer",
        "Kota Customer", "Kode Salesman", "Nama Salesman", "Kode Barang", "Nama Barang", "Qty",
        "Kode Principal", "Nama Principal", "Jenis Produk", "Nama Gudang", "Kecamatan", "Desa",
        "Region", "Market", "Jenis Market", "Golongan", "Kelompok Barang",
    },
    "LabaRugi": {
        "No.Nota", "Tanggal", "Nilai Jual", "JUM HPP", "Nilai HPP", "Biaya Lain", "Kode Customer",
        "Nama Customer", "Kota Customer", "Kode Barang", "Nama Barang", "Qty", "Kode Salesman",
        "Nama Salesman", "Job", "Market", "Golongan Barang",
    },
    "PosisiStokGudang": {
        "Kode Gudang", "Nama Gudang", "Kode", "Nama Barang", "Saldo Awal", "Debet", "Kredit",
        "Saldo Akhir", "Principal", "Golongan", "Jenis Produk", "Expired Date", "Kelompok",
    },
    "AnalisaStok": {
        "Kode", "Nama Barang", "Saldo Akhir Qty", "Saldo Akhir Nilai", "Satuan", "Golongan",
        "Jenis Produk", "Principle", "No.Batch",
    },
    "Retur": {
        "No.Retur", "Tanggal", "Deskripsi Issue", "Nilai Bruto", "Qty", "Kode Principal",
        "Nama Principal", "Kode Salesman", "Nama Salesman", "Market", "Kode Jenis Produk",
        "Kota Customer", "Nama Gudang", "Nama Barang",
    },
    "OutstandingSO": {
        "No.SO", "Tanggal", "Nama Job", "Kota", "Nama Customer", "Nama Barang", "Qty", "Satuan", "Nilai",
    },
    "UmurPiutang": {
        "No.Jurnal", "Tanggal", "Tgl JT", "Kode Customer", "Nama Customer", "Kode Salesman",
        "Nama Salesman", "Kota Customer", "Nama Job", "Nilai", "Nilai Belum JT", "Nilai JT 1",
        "Nilai JT 2", "Nilai JT 3", "Nilai JT 4", "Umur",
    },
}

APP_DIR = os.path.dirname(os.path.abspath(__file__))


def read_detected_sheets(path: str, result) -> pd.DataFrame:
    sheets = result.sheet_names or [result.sheet_name]
    wanted = READ_COLUMNS.get(result.jenis)
    usecols = (lambda col: col in wanted) if wanted else None
    frames = [pd.read_excel(path, sheet_name=sheet, usecols=usecols) for sheet in sheets]
    return frames[0] if len(frames) == 1 else pd.concat(frames, ignore_index=True, sort=False)


def sheet_label(result) -> str | int | None:
    sheets = result.sheet_names or [result.sheet_name]
    return sheets[0] if len(sheets) == 1 else ", ".join(str(sheet) for sheet in sheets)


class Api:
    def report_types(self):
        return [{"jenis": jenis, "label": DISPLAY_NAMES.get(jenis, jenis), "aktif": jenis in MODULES} for jenis in SIGNATURES]

    def pick_file(self):
        paths = webview.windows[0].create_file_dialog(
            webview.FileDialog.OPEN, file_types=("Excel Files (*.xls;*.xlsx)",)
        )
        if not paths:
            return None
        return paths if isinstance(paths, str) else paths[0]

    def pick_files(self):
        paths = webview.windows[0].create_file_dialog(
            webview.FileDialog.OPEN, allow_multiple=True, file_types=("Excel Files (*.xls;*.xlsx)",)
        )
        if not paths:
            return []
        return [paths] if isinstance(paths, str) else list(paths)

    def generate(self, path, jenis_selected):
        try:
            result = detect_report_type_from_file(path, preferred_jenis=jenis_selected)
            if not result.ok:
                return {"ok": False, "error": result.error}

            if jenis_selected and result.jenis != jenis_selected:
                detected_label = DISPLAY_NAMES.get(result.jenis, result.jenis)
                selected_label = DISPLAY_NAMES.get(jenis_selected, jenis_selected)
                return {
                    "ok": False,
                    "error": f'File ini terdeteksi sebagai "{detected_label}", bukan "{selected_label}" yang Anda '
                             f"pilih. Upload file yang sesuai template {selected_label}, atau pilih dashboard {detected_label}.",
                }

            module = MODULES.get(result.jenis)
            if module is None:
                detected_label = DISPLAY_NAMES.get(result.jenis, result.jenis)
                return {
                    "ok": False,
                    "error": f'File terdeteksi benar sebagai "{detected_label}", tapi modul dashboard-nya belum '
                             f"aktif di aplikasi ini.",
                }

            df = read_detected_sheets(path, result)
            html = module(df)
            return {
                "ok": True,
                "jenis": result.jenis,
                "label": DISPLAY_NAMES.get(result.jenis, result.jenis),
                "sheet": sheet_label(result),
                "sheets": result.sheet_names or [result.sheet_name],
                "html": html,
            }
        except Exception as e:
            return {"ok": False, "error": f"Gagal memproses file: {e}"}

    def generate_cross(self, paths):
        try:
            if not paths or len(paths) < 2:
                return {"ok": False, "error": "CrossAnalysis butuh minimal 2 file laporan berbeda."}

            report_infos = {}
            detected = []
            for path in paths:
                result = detect_report_type_from_file(path)
                name = os.path.basename(path)
                if not result.ok:
                    return {"ok": False, "error": f"{name}: {result.error}"}
                if result.jenis in report_infos:
                    label = DISPLAY_NAMES.get(result.jenis, result.jenis)
                    return {"ok": False, "error": f'Duplikat jenis "{label}". Pilih 1 file saja per jenis laporan.'}
                report_infos[result.jenis] = (path, result)
                detected.append(result.jenis)

            if len(report_infos) < 2:
                return {"ok": False, "error": "CrossAnalysis butuh minimal 2 jenis laporan berbeda."}
            if not has_supported_pair(report_infos):
                selected = ", ".join(DISPLAY_NAMES.get(jenis, jenis) for jenis in detected)
                supported = "; ".join(supported_pair_labels())
                return {
                    "ok": False,
                    "error": f"Kombinasi file terdeteksi: {selected}. Kombinasi ini belum didukung untuk section "
                             f"detail Cross Analysis. Pasangan aktif saat ini: {supported}. Aplikasi berhenti "
                             f"sebelum membaca full data agar file besar tidak loading lama tanpa hasil detail.",
                }

            reports = {
                jenis: read_detected_sheets(path, result)
                for jenis, (path, result) in report_infos.items()
            }

            html = generate_cross_analysis(reports)
            return {"ok": True, "jenis": "CrossAnalysis", "label": DISPLAY_NAMES["CrossAnalysis"], "html": html, "detected": detected}
        except Exception as e:
            return {"ok": False, "error": f"Gagal memproses CrossAnalysis: {e}"}

    def export_html(self, html, suggested_name):
        path = webview.windows[0].create_file_dialog(
            webview.FileDialog.SAVE, save_filename=suggested_name, file_types=("HTML Files (*.html)",)
        )
        if not path:
            return {"ok": False}
        path = path if isinstance(path, str) else path[0]
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)
        return {"ok": True, "path": path}


def main():
    webview.create_window(
        "Dashboard Generator",
        os.path.join(APP_DIR, "index.html"),
        js_api=Api(),
        width=1320,
        height=880,
        min_size=(900, 600),
    )
    webview.start()


if __name__ == "__main__":
    main()
