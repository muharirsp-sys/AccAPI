# laporan_harian.py
# Tujuan     : Lapisan web Laporan Harian di atas replika Power Query (laporan_harian_pq.py): baca unggahan,
#              bangun FIX LAP PENJ + SalesBase, tulis berkas per keyword penerima (sama persis dengan arsip
#              LaporanAuto), snapshot "2. To Format", agregat progress harian untuk dashboard insentif-sales.
# Caller     : routers/laporan_harian.py (endpoint /laporan-harian/process).
# Dependensi : laporan_harian_pq (replika), pandas.
# Main Functions:
#   load_inputs(penjualan, retur, fix) -> baris FIX; load_stock(path) -> baris stok 7 kolom.
#   write_report_files(...) -> berkas per keyword; latest_sales_date, aggregate_progress, summarize.
#   fix_frame(...) / write_to_format_file(...) / create_run_archive(...).
# Masukan yang diterima (dibuktikan sama dengan pipeline Excel, lihat laporan_harian_bandingkan.py):
#   penjualan = export Accurate "Rincian Faktur Penjualan" atau workbook "1. Paste Data" (sheet Paste Acc;
#               sheet Paste Lap. Retur ikut dipakai bila retur tidak diunggah terpisah);
#   retur     = export "Rincian Retur Penjualan" / sheet Paste Lap. Retur (kolom No.Retur; judul export Accurate
#               yang berbeda dibaca per posisi seperti ditempel admin) atau Rincian RJN (kolom NO_NOTA, dipetakan);
#   fix       = "2. To Format Laporan" (sheet FIX LAP PENJ) jadi; stock = "3. Stock" Sheet1 atau export
#               Accurate "Kuantitas Barang per Gudang".
# Side Effects: Membaca unggahan, menulis XLSX ke direktori run; tidak mengirim email.
from __future__ import annotations

import os
from typing import Optional

import pandas as pd

import laporan_harian_pq as pq

PENJ_LABEL = pq.PENJ
RETUR_LABEL = pq.RETUR
PENJUALAN_SHEETS = ("Paste Acc", "Rincian Faktur Penjualan")
RETUR_SHEETS = ("Paste Lap. Retur", "Rincian Faktur Penjualan", "Rincian Retur Penjualan")
# Export Rincian RJN (kolom Accurate) -> nama kolom "Laporan Retur" yang dibaca query Paste Lap. Retur.
RINCIAN_TO_RETUR = {
    "NO_NOTA": "No.Retur", "TANGGAL": "Tanggal", "TGL_JT": "Tgl JT", "MATA_UANG": "Mata Uang", "KURS": "Kurs",
    "KODE PELANGGAN INDUK": "Kode Customer", "Nama Pelanggan Faktur Penjualan": "Nama Customer",
    "ALAMAT": "Alamat Customer", "KOTA": "Kota Customer", "KODE_SALESMAN": "Kode Salesman",
    "SALESMAN": "Nama Salesman", "KODE_BARANG": "Kode Barang", "NAMA_BARANG": "Nama Barang", "QTY": "Qty",
    "NILAI JUAL": "Nilai Bruto", "POTONGAN": "Nilai Disc", "NILAI_PAJAK": "Nilai Pajak", "SATUAN": "Satuan",
    "NPWP Pelanggan Faktur Penjualan": "NPWP", "MARKET": "Market", "REGION": "Region", "GDG": "Kode Gudang",
    "GDGNAMA": "Nama Gudang", "PRINCIPLE": "Nama Principal", "JENIS PRODUK": "Kode Jenis Produk",
    "REM": "Keterangan",
}
# Export Accurate "Kuantitas Barang per Gudang" -> kolom "3. Stock". Spacer Accurate menggeser judul:
# "Nama Gudang" berisi kode (GD01), "Deskripsi Gudang" berisi nama.
ACCURATE_STOCK = {"Kode Barang": "Kode", "Nama Barang": "Nama Barang", "Nama Gudang": "Kode Gudang",
                  "Deskripsi Gudang": "Nama Gudang", "Nama Satuan": "Satuan", "Principle": "Principal",
                  "Principal": "Principal", "Kuantitas In Pcs": "Saldo Akhir", "Kuantitas in PCS": "Saldo Akhir"}


def load_lookups_json(path=pq.LOOKUPS_JSON) -> pq.Lookups:
    return pq.load_lookups(path)


def _sheet_names(path: str) -> list:
    from python_calamine import CalamineWorkbook

    return CalamineWorkbook.from_path(path).sheet_names


def _first_sheet(path: str, preferred: tuple) -> list:
    names = _sheet_names(path)
    return pq.read_sheet(path, [n for n in preferred if n in names] or names[:1])


# Judul sheet "1. Paste Data". Admin menempel NILAI export Accurate di bawah judul tetap ini, jadi export yang
# judulnya berbeda (mis. Rincian Retur Penjualan: KODE PELANGGAN INDUK, Catatan, JENIS PRODUK) dibaca per posisi.
PASTE_ACC_HEADERS = [
    "NO_NOTA", "TANGGAL", "TGL_JT", "MATA_UANG", "KURS", "KODE PELANGGAN INDUK", "CUSTOMER", "KODE_SALESMAN",
    "SALESMAN", "KODE_BARANG", "NAMA_BARANG", "QTY", "Nama Pelanggan Faktur Penjualan", "HARGA", "POTONGAN",
    "NILAI JUAL", "DPP", "NILAI_PAJAK", "SATUAN", "NIK Pelanggan Faktur Penjualan", "NPWP Pelanggan Faktur Penjualan",
    "GDG", "GDGNAMA", "Kuantitas (Unit)", "ALAMAT", "KOTA", "JUMLAH", "CABANG_OR_COSTCENTER", "PRINCIPLE",
    "JENIS PRODUK", "MARKET", "REGION", "TAHUN", "BULAN", "NO_SO", "QTY_SATUANKECIL", "SATUAN_KECIL", "REM",
    "KTP / NPWP", "", "DISKON",
]
PASTE_RETUR_HEADERS = [
    "No.Retur", "Tanggal", "Tgl JT", "Mata Uang", "Kurs", "Kode Customer", "Nama Customer", "Alamat Customer",
    "Kota Customer", "Kode Salesman", "Nama Salesman", "Kode Barang", "Nama Barang", "Qty", "Qty Bonus",
    "Nilai Bonus", "Nilai Bruto", "Nilai Disc", "Nilai Pajak", "Kode Job", "Nama Job", "Satuan", "NPWP", "Market",
    "Jenis Market", "Region", "Kode Gudang", "Nama Gudang", "No.Batch/Spec", "Expired Date", "Keterangan Barang",
    "Spec Barang", "Kode Issue", "Deskripsi Issue", "Keterangan", "Kode Principal", "Nama Principal", "Desa",
    "Kecamatan", "Wilayah", "Kode Jenis Produk", "No.Invoice",
]


def _paste_rows(rows: list, canonical: list, label: str) -> list:
    """Baris seperti ditempel ke sheet Paste: judul sama dipakai apa adanya; export Accurate (kolom pemisah
    kosong, judul berbeda, urutan sama) dipetakan per posisi; baris judul berulang dibuang."""
    header = ["" if h is None else str(h).strip() for h in rows[0]]
    if not set(canonical) - {""} - set(header):
        return [header] + [r for r in rows[1:] if r and r[0] != header[0]]
    keep = [i for i, h in enumerate(header) if h]
    if len(keep) != len(canonical) or header[keep[0]] != canonical[0]:
        missing = sorted(set(canonical) - {""} - set(header))
        raise ValueError(f"Kolom file {label} tidak dikenali (beda dari sheet Paste): {', '.join(missing[:8])}")
    first = header[keep[0]]
    return [list(canonical)] + [[r[i] if i < len(r) else None for i in keep] for r in rows[1:]
                                if r and (r[keep[0]] if keep[0] < len(r) else None) != first]


def _retur_rows(rows: list) -> list:
    header = ["" if h is None else str(h).strip() for h in rows[0]]
    if "No.Retur" in header:
        return _paste_rows(rows, PASTE_RETUR_HEADERS, "retur")
    if "NO_NOTA" in header:
        return [[RINCIAN_TO_RETUR.get(h, h) for h in header]] + rows[1:]
    raise ValueError("File retur harus berkolom 'No.Retur' (Rincian Retur Penjualan) atau 'NO_NOTA' (Rincian RJN).")


def load_inputs(penjualan_path: Optional[str], retur_path: Optional[str], fix_path: Optional[str],
                lk: pq.Lookups) -> list:
    """Baris FIX LAP PENJ dari unggahan web (urutan dan nilai seperti refresh Power Query)."""
    if penjualan_path:
        acc = _first_sheet(penjualan_path, PENJUALAN_SHEETS)
        if "NO_NOTA" not in ["" if h is None else str(h).strip() for h in acc[0]]:
            raise ValueError("File penjualan harus berkolom NO_NOTA (export Rincian Faktur Penjualan).")
        acc = _paste_rows(acc, PASTE_ACC_HEADERS, "penjualan")
        if retur_path:
            retur = _retur_rows(_first_sheet(retur_path, RETUR_SHEETS))
        elif "Paste Lap. Retur" in _sheet_names(penjualan_path):
            retur = _retur_rows(pq.read_sheet(penjualan_path, "Paste Lap. Retur"))
        else:
            retur = None
        return pq.build_fix(acc, retur, lk)
    if fix_path:
        return pq.fix_from_table(_first_sheet(fix_path, ("FIX LAP PENJ",)))
    raise ValueError("Wajib upload 'penjualan' (+retur) atau 'fix'.")


def load_stock(stock_path: str) -> list:
    """Stok tujuh kolom; "3. Stock" Sheet1 dipakai apa adanya, export Accurate dipetakan."""
    names = _sheet_names(stock_path)
    sheet = next((n for n in names if "gudang" in n.lower() or "kuantitas" in n.lower()), names[0])
    rows = pq.read_sheet(stock_path, sheet)
    header_at = next((i for i, r in enumerate(rows)
                      if any(str(c).strip().lower() in ("kode", "kode barang") for c in r if c is not None)), 0)
    header = ["" if h is None else str(h).strip() for h in rows[header_at]]
    if "Saldo Akhir" not in header:
        header = [ACCURATE_STOCK.get(h, h) for h in header]
    return pq.master_stock([header] + rows[header_at + 1:])


def write_report_files(sb: pq.SalesBase, fix_rows: list, stock: Optional[list], out_dir: str,
                       report_date: str, report_keywords: list) -> tuple:
    """Tulis satu workbook per keyword penerima yang dikenal; kembalikan (ditulis, keyword tak dikenal)."""
    os.makedirs(out_dir, exist_ok=True)
    written, unmatched = [], []
    for raw in dict.fromkeys(str(k).strip() for k in report_keywords):
        keyword = pq.report_keyword(raw)
        if keyword is None:
            unmatched.append(raw)
            continue
        sheets = pq.build_report(keyword, sb, fix_rows, stock)
        file_name = f"{report_date}_{keyword.replace('/', '-').replace(chr(92), '-')}.xlsx"
        path = os.path.join(out_dir, file_name)
        pq.write_workbook(path, sheets, serial_dates=keyword in pq.MANUAL_FORMAT)
        written.append({
            "keyword": keyword,
            "groupType": pq.group_type(keyword),
            "fileName": file_name,
            "path": path,
            "rows": len(sheets[0][2]),
            "stockRows": len(sheets[1][2]) if len(sheets) > 1 else 0,
        })
    return written, unmatched


def sales_frame(sb: pq.SalesBase) -> pd.DataFrame:
    """SalesBase penuh sebagai DataFrame (urutan tidak penting) untuk agregat dashboard."""
    rows = [sb.output(i) for i in range(sb.n)]
    frame = pd.DataFrame(rows, columns=pq.SALES_COLUMNS).astype(object)
    return frame.map(lambda v: None if v is pq.ERR else v)


def latest_sales_date(fix_rows: list, fallback: Optional[str] = None) -> Optional[str]:
    """Tanggal transaksi penjualan bruto terakhir; retur yang lebih baru tidak menggeser tanggal laporan."""
    dates = [r[pq.FX["TANGGAL"]] for r in fix_rows if r[pq.FX["JENIS_TRANSAKSI"]] == PENJ_LABEL]
    dates = [pq.to_date(d) for d in dates if d is not None and d is not pq.ERR] or \
        [pq.to_date(r[pq.FX["TANGGAL"]]) for r in fix_rows if r[pq.FX["TANGGAL"]] not in (None, pq.ERR)]
    return max(dates).strftime("%Y-%m-%d") if dates else fallback


def aggregate_progress(sales: pd.DataFrame) -> pd.DataFrame:
    """Agregat -> salesDailyProgress: per salesCode+principle+date."""
    d = sales.copy()
    d["date"] = pd.to_datetime(d["TANGGAL"], errors="coerce").dt.strftime("%Y-%m-%d")
    for c in ("DPP", "EC", "AO", "Item Aktif"):
        d[c] = pd.to_numeric(d[c], errors="coerce").fillna(0)
    grp = d.groupby(["KODE_SALESMAN", "PRINCIPAL", "GOLONGAN", "date"], dropna=False)
    out = grp.agg(achievedValueDpp=("DPP", "sum"), achievedEc=("EC", "sum"),
                  achievedAo=("AO", "sum"), achievedIa=("Item Aktif", "sum")).reset_index()
    out = out.rename(columns={"KODE_SALESMAN": "salesCode", "PRINCIPAL": "principle", "GOLONGAN": "branch"})
    out["periodMonth"] = pd.to_datetime(out["date"], errors="coerce").dt.month
    out["periodYear"] = pd.to_datetime(out["date"], errors="coerce").dt.year
    return out.astype(object).where(pd.notna(out), None)


def summarize(sales: pd.DataFrame) -> pd.DataFrame:
    d = sales.copy()
    for c in ("DPP", "AO", "EC", "Item Aktif"):
        d[c] = pd.to_numeric(d[c], errors="coerce").fillna(0)
    return (d.groupby("GOLONGAN", dropna=True)
             .agg(rows=("NO_NOTA", "size"), dpp=("DPP", "sum"), ao=("AO", "sum"), ec=("EC", "sum"),
                  ia=("Item Aktif", "sum"))
             .reset_index().sort_values("GOLONGAN"))


def fix_frame(fix_rows: list) -> pd.DataFrame:
    frame = pd.DataFrame(fix_rows, columns=pq.FIX_COLUMNS).astype(object)
    return frame.map(lambda v: None if v is pq.ERR else v)


def write_to_format_file(fix_rows: list, lk: pq.Lookups, out_dir: str, report_date: str) -> dict:
    """Snapshot download-only setara workbook "2. To Format Laporan" (FIX LAP PENJ + tabel lookup)."""
    os.makedirs(out_dir, exist_ok=True)
    file_name = f"{report_date}_2.To Format Laporan.xlsx"
    path = os.path.join(out_dir, file_name)
    pq.write_workbook(path, [
        ("FIX LAP PENJ", list(pq.FIX_COLUMNS), fix_rows),
        ("JENIS PRODUK", ["JENISPRODUK", "NAMA JENIS PRODUK"], [list(r) for r in lk.jenis]),
        ("GOLONGAN", ["KODE SPV", "NAMA SPV", "JENIS PRODUK"], [list(r) for r in lk.spv]),
    ])
    return {"fileName": file_name, "path": path, "rows": len(fix_rows)}


def create_run_archive(out_dir: str, report_date: str) -> dict:
    """Buat ZIP arsip berisi seluruh workbook run (tidak pernah dikirim email)."""
    import zipfile

    file_name = f"{report_date}_Laporan_Harian_Arsip.zip"
    path = os.path.join(out_dir, file_name)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in sorted(os.listdir(out_dir)):
            if name.lower().endswith((".xlsx", ".xlsm", ".html")):
                archive.write(os.path.join(out_dir, name), arcname=name)
    return {"fileName": file_name, "path": path}
