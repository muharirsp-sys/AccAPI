"""Tujuan: Membuat hasil acuan uji paritas dengan menjalankan query Power Query ASLI workbook Laporan Harian lama
           ("2. To Format Laporan" + "2.3 To SPV dan SM New") lewat Excel, bukan lewat kode replika.
Caller: Developer (Windows + Excel + pywin32), mis.
        python laporan_harian_excel_pq.py "<2. To Format>.xlsx" "<2.3 To SPV dan SM New>.xlsx" fixtures/laporan_harian.json.gz
        (bagian "masukan" berkas fixture dibaca, bagian "acuan" ditulis ulang).
Dependensi: Excel desktop (COM), pywin32, python-calamine, laporan_harian_pq (tabel master + normalisasi).
Main Functions: extract_queries (DataMashup -> kode M), run (muat query ke sheet), main.
Side Effects: Membuka Excel tersembunyi, menulis workbook sementara dan memperbarui bagian "acuan" fixture
              (JSON gzip; *.gz di-gitignore, berkas ini dilacak dengan git add -f).
"""
import base64
import gzip
import io
import json
import os
import re
import sys
import tempfile
import zipfile

import laporan_harian_pq as pq

# Sheet laporan (keyword) -> query 2.3 yang memuatnya (nama query lama dipertahankan workbook owner).
QUERIES = {
    "SUMARTONO": ("SUMARTONO", "SUMARTONO STOCK"), "MARTEN": ("MARTEN", "YUDI STOCK"),
    "SOFYAN": ("SOFYAN", "ANDRI STOCK"), "ADNAN": ("ADNAN", "ADNAN STOCK"), "IRMAN": ("HENDRIK", "HENDRIK STOCK"),
    "ANI": ("ANI", "ANI STOCK"), "JONAL": ("JONAL", "JONAL STOCK"), "HEINZ": ("ZUL&ARUL", "ZUL&ARUL STOCK"), "SYAMSUL": ("SYAMSUL", "SYAMSUL STOCK"),
    "STANLEY": ("DENNY", "SULTAN STOCK"), "YARMAN": ("YARMAN", "STANLEY STOCK"), "RAMLY": ("ANDRI", "SOFYAN STOCK"),
    "MUSTIKA RATU": ("MUSTIKA RATU", "MUSTIKA RATU STOCK"), "RECKIT": ("RECKITT", "RECKITT STOCK"),
    "MOTASA MKS 1": ("MOTASA 1", "MOTASA 1 STOCK"), "MOTASA MKS 2": ("MOTASA 2", "MOTASA 2 STOCK"),
    "FONTERRA": ("FONTERRA", "FONTERRA STOCK"), "URC": ("URC", "URC STOCK"), "ABCPI": ("ABC", "ABC STOCK"),
    "ENERGIZER": ("ENERGIZER", "ENI STOCK"), "GODREJJ": ("GODREJ", "GODREJ STOCK"),
}


def extract_queries(path: str) -> dict:
    """Kode M per query dari DataMashup workbook."""
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not (name.startswith("customXml/item") and name.endswith(".xml")):
                continue
            raw = z.read(name)
            text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8", "ignore")
            m = re.search(r"<DataMashup[^>]*>(.*?)</DataMashup>", text, re.S)
            if not m:
                continue
            blob = base64.b64decode(m.group(1))
            size = int.from_bytes(blob[4:8], "little")
            with zipfile.ZipFile(io.BytesIO(blob[8:8 + size])) as package:
                section = package.read("Formulas/Section1.m").decode("utf-8-sig")
            parts = re.split(r"\nshared ", "\n" + section.split("\n", 1)[1])
            out = {}
            for part in parts[1:]:
                head, body = part.split(" = ", 1)
                out[head.strip().strip("#").strip('"')] = body.rstrip().rstrip(";")
            return out
    raise ValueError(f"DataMashup tidak ditemukan di {path}")


def _source(code: str, file_name: str, path: str) -> str:
    return re.sub(r'File\.Contents\("[^"]*' + re.escape(file_name) + r'"\)',
                  lambda _: f'File.Contents("{path}")', code)


def run(queries: dict, tables: list, load: list, save_as=None, rename=None, sort=None) -> dict:
    """tables: [(nama tabel, baris)]. load: query yang dimuat. sort: {query: indeks kolom} -> sort Excel A-Z."""
    import win32com.client as win32

    xl = win32.DispatchEx("Excel.Application")
    xl.Visible = False
    xl.DisplayAlerts = False
    out = {}
    try:
        wb = xl.Workbooks.Add()
        for table, rows in tables:
            ws = wb.Worksheets.Add()
            rng = ws.Range(ws.Cells(1, 1), ws.Cells(len(rows), len(rows[0])))
            rng.Value = [tuple(r) for r in rows]
            ws.ListObjects.Add(1, rng, None, 1).Name = table
        for name, code in queries.items():
            wb.Queries.Add(name, code)
        for name in load:
            ws = wb.Worksheets.Add()
            conn = f'OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=$Workbook$;Location="{name}";Extended Properties=""'
            lo = ws.ListObjects.Add(0, conn, True, 1, ws.Range("$A$1"))
            lo.QueryTable.CommandType = 2
            lo.QueryTable.CommandText = f"SELECT * FROM [{name}]"
            lo.QueryTable.BackgroundQuery = False
            lo.QueryTable.Refresh(False)
            if rename and name in rename:
                lo.Name = rename[name]
            if sort and name in sort:  # sortState tabel Excel (bukan bagian query M)
                lo.Sort.SortFields.Clear()
                lo.Sort.SortFields.Add(lo.ListColumns(sort[name] + 1).DataBodyRange, 0, 1)
                lo.Sort.Header = 1
                lo.Sort.Apply()
            values = lo.Range.Value
            out[name] = [[_plain(v) for v in r] for r in values]
        if save_as:
            wb.SaveAs(save_as, 51)
        wb.Close(False)
    finally:
        xl.Quit()
    return out


def _plain(v):
    if hasattr(v, "year"):
        return {"date": f"{v.year:04d}-{v.month:02d}-{v.day:02d}"}
    return v


def decode(v):
    """Nilai fixture JSON -> nilai sel ({"date": ISO} = tanggal)."""
    import datetime as dt

    return dt.date.fromisoformat(v["date"]) if isinstance(v, dict) else v


def encode(v):
    import datetime as dt

    if isinstance(v, dt.date):
        return {"date": v.isoformat()[:10]}
    return v


def main(argv=None) -> int:
    to_format, spv_sm, fixture_path = (argv or sys.argv[1:])[:3]
    tmp = tempfile.mkdtemp(prefix="lh_excel_")
    lk = pq.load_lookups()
    with gzip.open(fixture_path, "rt", encoding="utf-8") as f:
        fixture = json.load(f)
    rows = {name: [[decode(v) for v in r] for r in data] for name, data in fixture["masukan"].items()}
    paste = os.path.join(tmp, "paste.xlsx")
    stock = os.path.join(tmp, "stock.xlsx")
    fix_path = os.path.join(tmp, "fix.xlsx")
    from openpyxl import Workbook

    for path, sheets in ((paste, [(n, r) for n, r in rows.items() if n != "Stock"]),
                         (stock, [("Sheet1", rows["Stock"])])):
        wb = Workbook()
        wb.remove(wb.active)
        for name, data in sheets:
            ws = wb.create_sheet(name)
            for r in data:
                ws.append(r)
        wb.save(path)
    m2 = {k: _source(v, "1. Paste Data.xlsx", paste) for k, v in extract_queries(to_format).items()}
    stage1 = run(m2, [("Table1", [["JENISPRODUK", "NAMA JENIS PRODUK"]] + [list(r) for r in lk.jenis]),
                      ("Table2", [["KODE SPV", "NAMA SPV", "JENIS PRODUK"]] + [list(r) for r in lk.spv])],
                 ["FIX LAP PENJ"], save_as=fix_path, rename={"FIX LAP PENJ": "FIX_LAP_PENJ"})
    m23 = extract_queries(spv_sm)
    m23 = {k: _source(_source(v, "2. To Format Laporan.xlsx", fix_path), "3. Stock.xlsx", stock) for k, v in m23.items()}
    load = sorted({q for pair in QUERIES.values() for q in pair})
    tables = [("Mapping_PIC", [["PRINCIPLE", "NAMA SPV", "NAMA SM"]] + [list(r) for r in lk.mapping]),
              ("PL_MR", [["KODE BARANG", "NAMA BARANG", "HARGA JUAL GT SAT KECIL", "HARGA JUAL GT SAT BESAR",
                          "HARGA JUAL MT SAT KECIL", "HARGA JUAL MT SAT BESAR"]] + [list(r) for r in lk.pl_mr]),
              ("Table1", [["Kode Brg", "Nama Barang", "Satuan", "Kelompok Brg", "Devisi"]] + [list(r) for r in lk.reckitt])]
    stage2 = run(m23, tables, load, sort={"MUSTIKA RATU STOCK": pq.STOCK_COLUMNS.index("Nama Gudang")})
    fixture["acuan"] = {"fix": stage1["FIX LAP PENJ"],
                        "sheets": {k: [stage2[q] for q in pair] for k, pair in QUERIES.items()}}
    with gzip.open(fixture_path, "wt", encoding="utf-8", newline="\n") as f:
        json.dump(fixture, f, ensure_ascii=False, separators=(",", ":"))
    print("acuan ditulis", fixture_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
