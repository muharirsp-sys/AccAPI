"""Tujuan: Deteksi jenis laporan dari signature kolom Excel, termasuk semua sheet cocok di workbook multi-sheet.
Caller: app.Api.generate, app.Api.generate_cross, test_detector.py.
Dependensi: pandas ExcelFile/read_excel header-only, regex normalisasi kolom, alias kolom laporan.
Main Functions: detect_report_type, detect_report_type_from_file, detect_report_sheets_from_file.
Side Effects: Membaca metadata/header workbook dari disk; tidak membaca data penuh.
"""
import re
from dataclasses import dataclass

import pandas as pd

SIGNATURES = {
    "Penjualan": ["No Invoice", "Nilai Bruto", "Nilai Disc", "Kode Salesman", "Kode Principal"],
    "LabaRugi": ["No.Nota", "Nilai Jual", "JUM HPP", "Biaya Lain"],
    "PosisiStokGudang": ["Kode Gudang", "Saldo Awal", "Debet", "Kredit", "Saldo Akhir"],
    "AnalisaStok": ["Saldo Awal Qty", "Saldo Akhir Nilai", "Kode Perkiraan"],
    "Retur": ["No.Retur", "Deskripsi Issue"],
    "OutstandingSO": ["No.SO", "Nama Job"],
    "UmurPiutang": ["No.Jurnal", "Nilai Belum JT", "Nilai JT 1", "Nilai JT 4", "Umur"],
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


# ponytail: normalize dengan strip semua non-alfanumerik, jadi "No.Nota" == "no nota" == "NO_NOTA"
# ini juga yang membedakan "Saldo Awal" (PosisiStok) dari "Saldo Awal Qty" (AnalisaStok) tanpa logic khusus
_SIG_NORM = {jenis: {_norm(c) for c in cols} for jenis, cols in SIGNATURES.items()}
_LABARUGI_REQUIRED = {_norm(c) for c in ["No.Nota", "Nilai Jual", "Biaya Lain"]}
_LABARUGI_HPP_ALIASES = {_norm(c) for c in ["JUM HPP", "Nilai HPP"]}

# Urutan cek dari paling spesifik ke paling generik. Ditemukan dari file XLS nyata: export Retur
# (Lap_Retur_Penjualan) ikut membawa kolom invoice asalnya (No.Invoice, Kode Salesman, Kode Principal,
# Nilai Bruto, Nilai Disc) -- persis signature Penjualan -- jadi Retur WAJIB dicek duluan, kalau tidak
# semua file retur akan salah kedeteksi jadi Penjualan. Penjualan ditaruh paling akhir krn signature-nya
# paling generik/gampang ke-subset oleh laporan lain yang berasal dari transaksi penjualan juga.
_PRIORITY = ["UmurPiutang", "OutstandingSO", "Retur", "AnalisaStok", "PosisiStokGudang", "LabaRugi", "Penjualan"]


def _matches_signature(jenis: str, norm_cols: set[str]) -> bool:
    if jenis == "LabaRugi":
        return _LABARUGI_REQUIRED <= norm_cols and bool(_LABARUGI_HPP_ALIASES & norm_cols)
    return _SIG_NORM[jenis] <= norm_cols


@dataclass
class DetectResult:
    jenis: str | None
    matched_columns: list[str]
    found_columns: list[str]
    sheet_name: str | int | None = None
    sheet_names: list[str | int] | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.jenis is not None


def detect_report_type(df_or_columns, sheet_name: str | int | None = None) -> DetectResult:
    """Deteksi jenis laporan dari kolom DataFrame atau list nama kolom."""
    columns = list(df_or_columns.columns) if hasattr(df_or_columns, "columns") else list(df_or_columns)
    norm_cols = {_norm(c) for c in columns}

    for jenis in _PRIORITY:
        if _matches_signature(jenis, norm_cols):
            sheet_names = [sheet_name] if sheet_name is not None else None
            return DetectResult(
                jenis=jenis,
                matched_columns=SIGNATURES[jenis],
                found_columns=columns,
                sheet_name=sheet_name,
                sheet_names=sheet_names,
            )

    return DetectResult(
        jenis=None,
        matched_columns=[],
        found_columns=columns,
        sheet_name=sheet_name,
        error="Format file tidak dikenali, kolom yang ditemukan: " + ", ".join(str(c) for c in columns),
    )


def detect_report_type_from_file(path: str, preferred_jenis: str | None = None) -> DetectResult:
    """.xls/.xlsx: scan header semua sheet, kembalikan semua sheet cocok, tanpa baca data penuh."""
    return detect_report_sheets_from_file(path, preferred_jenis=preferred_jenis)


def detect_report_sheets_from_file(path: str, preferred_jenis: str | None = None) -> DetectResult:
    """.xls/.xlsx: scan header semua sheet dan kumpulkan sheet yang cocok untuk 1 jenis laporan."""
    matches: list[DetectResult] = []
    other_matches: list[DetectResult] = []
    sheet_summaries = []

    with pd.ExcelFile(path) as xl:
        for sheet in xl.sheet_names:
            try:
                df = pd.read_excel(xl, sheet_name=sheet, nrows=0)
            except Exception as e:
                sheet_summaries.append(f"{sheet}: gagal baca header ({e})")
                continue

            result = detect_report_type(df, sheet_name=sheet)
            if result.ok:
                if preferred_jenis is None or result.jenis == preferred_jenis:
                    matches.append(result)
                else:
                    other_matches.append(result)
            else:
                preview = ", ".join(str(c) for c in result.found_columns[:8])
                sheet_summaries.append(f"{sheet}: {preview}")

    if matches:
        jenis = preferred_jenis or matches[0].jenis
        same_kind = [m for m in matches if m.jenis == jenis]
        first = same_kind[0]
        return DetectResult(
            jenis=first.jenis,
            matched_columns=first.matched_columns,
            found_columns=first.found_columns,
            sheet_name=first.sheet_name,
            sheet_names=[m.sheet_name for m in same_kind],
        )

    if preferred_jenis and other_matches:
        available = ", ".join(f"{m.jenis} di sheet \"{m.sheet_name}\"" for m in other_matches)
        return DetectResult(
            jenis=None,
            matched_columns=[],
            found_columns=[],
            error=f'Workbook ini punya sheet terdeteksi ({available}), tapi tidak ada sheet cocok untuk "{preferred_jenis}".',
        )

    detail = "; ".join(sheet_summaries) if sheet_summaries else "tidak ada sheet terbaca"
    return DetectResult(
        jenis=None,
        matched_columns=[],
        found_columns=[],
        error="Format file tidak dikenali di semua sheet. Ringkasan sheet: " + detail,
    )
