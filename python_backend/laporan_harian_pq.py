"""Tujuan: Replika setia Power Query Laporan Harian lama ("2. To Format Laporan" + "2.3 To SPV dan SM New")
           agar web menghasilkan berkas yang sama persis dengan arsip LaporanAuto.
Caller: laporan_harian.py (endpoint /laporan-harian/process), laporan_harian_bandingkan.py, test_laporan_harian_pq.py.
Dependensi: python-calamine (baca xlsx), laporan_harian_lookups.json, laporan_harian_pl_mr.csv,
            laporan_harian_reckitt_items.csv.
Main Functions: read_sheet, build_fix (Stage 1), salesbase (Stage 2), master_stock, build_report, write_workbook.
Side Effects: Membaca workbook/CSV/JSON; write_workbook menulis XLSX.

Semantik yang direplikasi (dibuktikan dengan eksperimen Excel/Power Query, Okt 2026):
- Table.NestedJoin LeftOuter (lihat join_order): kiri dan kanan dibaca bergantian sampai salah satu habis;
  baris yang tertampung keluar menurut urutan kemunculan pertama kuncinya (kiri didahulukan pada langkah sama).
- Table.Sort = introsort .NET Framework (tidak stabil), lihat introsort.
- Table.SelectRows atas kolom sumber didorong ke bawah rantai join (tabel flag AO/EC/IA tetap dihitung penuh);
  filter atas kolom hasil join (Mapping_PIC.*) dievaluasi setelah rantai penuh.
- "" (teks kosong) berbeda dari null: Number.From("") error -> sel kosong (Qty Los/Value Los baris INV).
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import zipfile
from functools import lru_cache
from pathlib import Path
from xml.sax.saxutils import escape

BASE = Path(__file__).resolve().parent
EPOCH = dt.datetime(1899, 12, 30)
PENJ = "1. Penjualan Bruto"
RETUR = "2. (-) Retur Penjualan"


class _Error:
    """Nilai error Power Query; dimuat ke Excel sebagai sel kosong."""
    __slots__ = ()

    def __repr__(self):
        return "Error"


ERR = _Error()


# ---------- semantik tipe M ----------
def num(v):
    if v is None or v is ERR:
        return v
    if isinstance(v, bool):
        return ERR
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, dt.datetime):
        return (v - EPOCH).total_seconds() / 86400
    if isinstance(v, dt.date):
        return float((v - EPOCH.date()).days)
    try:
        return float(v.strip())
    except ValueError:
        return ERR


def int64(v):
    x = num(v)
    return x if x is None or x is ERR else float(round(x))  # ponytail: pembulatan ToEven (data contoh selalu bulat)


def text(v):
    if v is None or v is ERR or isinstance(v, str):
        return v
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)  # ponytail: budaya en-ID tidak dipakai untuk pecahan
    if isinstance(v, dt.datetime):
        return v.strftime("%d/%m/%Y %H:%M:%S")
    if isinstance(v, dt.date):
        return v.strftime("%d/%m/%Y")
    return str(v)


def to_date(v):
    if v is None or v is ERR:
        return v
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    x = num(v)
    return x if x is ERR else (EPOCH + dt.timedelta(days=int(x))).date()


def to_datetime(v):
    d = v if isinstance(v, dt.datetime) else to_date(v)
    if d is None or d is ERR or isinstance(d, dt.datetime):
        return d
    return dt.datetime(d.year, d.month, d.day)


def trim(v):
    return v.strip() if isinstance(v, str) else v


def cat(a, b):
    return a + b if isinstance(a, str) and isinstance(b, str) else None


def _arith(a, b, op):
    if a is ERR or b is ERR:
        return ERR
    if a is None or b is None:
        return None
    try:
        return op(a, b)
    except ZeroDivisionError:
        return ERR  # Infinity/NaN tidak bisa disimpan Excel


def neg(v):
    return v if v is None or v is ERR else -v


def net_round(x, digits=2):
    """Number.Round(x, 2) = Math.Round(double, 2, ToEven) .NET Framework."""
    if x is None or x is ERR:
        return x
    p = 10.0 ** digits
    return round(x * p) / p


# ---------- urutan baris Power Query ----------
def join_order(left_keys: list, right_keys: list) -> list:
    """Indeks baris kiri dalam urutan keluaran Table.NestedJoin LeftOuter + Expand."""
    n, m = len(left_keys), len(right_keys)
    first = {}
    if m < n:  # kanan habis duluan -> semua yang tertampung dikeluarkan, sisanya mengalir berurutan
        nbuf = m + 1
        for i in range(nbuf):
            first.setdefault(left_keys[i], 2 * i)
            if i < m:
                first.setdefault(right_keys[i], 2 * i + 1)
        return sorted(range(nbuf), key=lambda i: (first[left_keys[i]], i)) + list(range(nbuf, n))
    seen_right = set()
    for i in range(min(m, n + 1)):
        if i < n:
            first.setdefault(left_keys[i], 2 * i)
        first.setdefault(right_keys[i], 2 * i + 1)
        seen_right.add(right_keys[i])
    out = sorted((i for i in range(n) if left_keys[i] in seen_right), key=lambda i: (first[left_keys[i]], i))
    waiting = {}
    for i in range(n):
        if left_keys[i] not in seen_right:
            waiting.setdefault(left_keys[i], []).append(i)
    for k in right_keys[min(m, n + 1):]:
        out += waiting.pop(k, [])
    return out + [i for rows in waiting.values() for i in rows]  # sisa tak berpasangan: dikelompokkan per kunci


def apply_join(rows: list, key, right_keys: list) -> list:
    return [rows[i] for i in join_order([key(r) for r in rows], right_keys)]


def introsort(items: list, key) -> list:
    """Table.Sort Power Query = ArraySortHelper.IntrospectiveSort .NET Framework (tidak stabil)."""
    a = list(items)
    k = [key(x) for x in a]

    def cmp(x, y):
        return (x > y) - (x < y)

    def swap(i, j):
        a[i], a[j] = a[j], a[i]
        k[i], k[j] = k[j], k[i]

    def swap_if_greater(i, j):
        if i != j and cmp(k[i], k[j]) > 0:
            swap(i, j)

    def insertion(lo, hi):
        for i in range(lo, hi):
            j, t, tk = i, a[i + 1], k[i + 1]
            while j >= lo and cmp(tk, k[j]) < 0:
                a[j + 1], k[j + 1] = a[j], k[j]
                j -= 1
            a[j + 1], k[j + 1] = t, tk

    def down_heap(i, n, lo):
        d, dk = a[lo + i - 1], k[lo + i - 1]
        while i <= n // 2:
            child = 2 * i
            if child < n and cmp(k[lo + child - 1], k[lo + child]) < 0:
                child += 1
            if not cmp(dk, k[lo + child - 1]) < 0:
                break
            a[lo + i - 1], k[lo + i - 1] = a[lo + child - 1], k[lo + child - 1]
            i = child
        a[lo + i - 1], k[lo + i - 1] = d, dk

    def heapsort(lo, hi):
        n = hi - lo + 1
        for i in range(n // 2, 0, -1):
            down_heap(i, n, lo)
        for i in range(n, 1, -1):
            swap(lo, lo + i - 1)
            down_heap(1, i - 1, lo)

    def partition(lo, hi):
        mid = lo + ((hi - lo) >> 1)
        swap_if_greater(lo, mid)
        swap_if_greater(lo, hi)
        swap_if_greater(mid, hi)
        pivot = k[mid]
        swap(mid, hi - 1)
        left, right = lo, hi - 1
        while left < right:
            left += 1
            while cmp(k[left], pivot) < 0:
                left += 1
            right -= 1
            while cmp(pivot, k[right]) < 0:
                right -= 1
            if left >= right:
                break
            swap(left, right)
        swap(left, hi - 1)
        return left

    stack = [(0, len(a) - 1, 2 * len(a).bit_length())]  # FloorLog2 .NET = jumlah bit panjang larik
    while stack:  # urutan proses partisi tidak memengaruhi hasil (rentang saling lepas)
        lo, hi, depth = stack.pop()
        size = hi - lo + 1
        if size < 2:
            continue
        if size <= 16:
            if size == 2:
                swap_if_greater(lo, hi)
            elif size == 3:
                swap_if_greater(lo, hi - 1)
                swap_if_greater(lo, hi)
                swap_if_greater(hi - 1, hi)
            else:
                insertion(lo, hi)
        elif depth == 0:
            heapsort(lo, hi)
        else:
            p = partition(lo, hi)
            stack += [(p + 1, hi, depth - 1), (lo, p - 1, depth - 1)]
    return a


# ---------- masukan ----------
def read_sheet(path: str, names) -> list:
    """Baris sheet pertama yang namanya cocok (header di baris 0); sel kosong -> None."""
    from python_calamine import CalamineWorkbook

    wb = CalamineWorkbook.from_path(path)
    wanted = [names] if isinstance(names, str) else list(names)
    sheet = next((n for n in wanted if n in wb.sheet_names), None)
    if sheet is None:
        raise ValueError(f"Sheet {wanted} tidak ditemukan; ada: {wb.sheet_names}")
    rows = wb.get_sheet_by_name(sheet).to_python()
    return [[None if v == "" else v for v in r] for r in rows]


def records(rows: list) -> list:
    header = ["" if h is None else str(h) for h in rows[0]]
    return [dict(zip(header, r)) for r in rows[1:]]


class Lookups:
    """Tabel master workbook lama: GOLONGAN (Table2), JENIS PRODUK (Table1), Mapping_PIC, PL_MR, RECKITT LIST."""

    def __init__(self, spv, jenis, mapping, pl_mr=None, reckitt=None):
        self.spv = [tuple(r) for r in spv]          # (KODE SPV, NAMA SPV, JENIS PRODUK)
        self.jenis = [tuple(r) for r in jenis]      # (JENISPRODUK, NAMA JENIS PRODUK)
        self.mapping = [tuple(r) for r in mapping]  # (PRINCIPLE, NAMA SPV, NAMA SM)
        self.pl_mr = pl_mr if pl_mr is not None else _pl_mr()
        self.reckitt = reckitt if reckitt is not None else _reckitt()
        self.spv_keys = [cat(text(k), text(j)) for k, _, j in self.spv]
        self.spv_name, self.spv_jenis = {}, {}
        for (_, nama, jenis), key in zip(self.spv, self.spv_keys):
            if key is not None and key not in self.spv_name:
                self.spv_name[key], self.spv_jenis[key] = text(nama), text(jenis)
        self.jp_keys = [text(k) for k, _ in self.jenis]
        self.jp_name = {}
        for k, v in self.jenis:
            self.jp_name.setdefault(text(k), text(v))
        self.map_keys = [text(p) for p, _, _ in self.mapping]
        self.conca_to_spv = self.spv_name  # nama atribut lama untuk laporan_harian_manager
        self.map_spv, self.map_sm = {}, {}
        for p, spv_name, sm in self.mapping:
            self.map_spv.setdefault(text(p), text(spv_name))
            self.map_sm.setdefault(text(p), text(sm))
        self.sm_map = self.map_sm


LOOKUPS_JSON = BASE / "laporan_harian_lookups.json"


@lru_cache(maxsize=1)
def _pl_mr():
    rows = list(csv.reader((BASE / "laporan_harian_pl_mr.csv").open(encoding="utf-8")))
    rows = [r for r in rows if r and not r[0].startswith("#")]
    return [[r[0], r[1], float(r[2]) if r[2] else None, None, float(r[4]) if r[4] else None, None] for r in rows[1:]]


@lru_cache(maxsize=1)
def _reckitt():
    rows = list(csv.reader((BASE / "laporan_harian_reckitt_items.csv").open(encoding="utf-8")))
    rows = [r for r in rows if r and not r[0].startswith("#")]
    return [r[:5] for r in rows[1:]]


def load_lookups(path=LOOKUPS_JSON) -> Lookups:
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    return Lookups(d["golongan"], d["jenis_produk"], d["mapping"])


# ---------- Stage 1: 2. To Format Laporan ----------
FIX_COLUMNS = [
    "NO_NOTA", "TANGGAL", "TGL_JT", "MATA_UANG", "KURS", "KODE_CUST", "CUSTOMER", "KODE_SALESMAN", "SALESMAN",
    "KODE_BARANG", "NAMA_BARANG", "QTY", "HARGA", "POTONGAN", "NILAI_JUAL", "DPP", "NILAI_PAJAK", "SATUAN", "NPWP",
    "NO_REF", "JNS_PAJAK", "UANG_MUKA", "GOLONGAN", "INTERVAL_KE", "INTERVAL", "GDG", "GDGNAMA", "ALAMAT", "KOTA",
    "QTYBONUS", "NILAI_BONUS", "JUMLAH", "DPP_UM", "CABANG_OR_COSTCENTER", "PRINCIPAL", "JENISPRODUK",
    "KELOMPOKPRODUK", "MARKET", "JENISMARKET", "REGION", "QTY_REF", "UNIT_REF", "TAHUN", "BULAN", "INTERVAL_HARI",
    "JENIS_TRANSAKSI", "POCUS", "REM_SO", "NOBATCH", "EXPIRED_DATE", "MULTIDISCVAL", "BRGREM", "BRGSPEC", "NO_SO",
    "QTYKONV", "FIX QTY_SATUAN KECIL", "SATUAN_KECIL", "DESA", "KECAMATAN", "REM", "WILAYAH", "Kuantitas (Unit)",
    "KTP / NPWP",
]
FX = {c: i for i, c in enumerate(FIX_COLUMNS)}
_EMPTY_BOTH = ("NO_REF", "JNS_PAJAK", "UANG_MUKA", "INTERVAL_KE", "INTERVAL", "DPP_UM", "QTY_REF", "UNIT_REF",
               "INTERVAL_HARI", "POCUS", "REM_SO", "NOBATCH", "EXPIRED_DATE", "MULTIDISCVAL", "BRGREM", "BRGSPEC",
               "QTYKONV", "KELOMPOKPRODUK")


def _fix_row(values: dict) -> list:
    row = [None] * len(FIX_COLUMNS)
    for c in _EMPTY_BOTH:
        row[FX[c]] = ""
    for c, v in values.items():
        row[FX[c]] = v
    return row


def _acc_row(r: dict, lk: Lookups) -> list:
    tanggal = to_date(int64(r.get("TANGGAL")))
    cabang, principal = text(r.get("CABANG_OR_COSTCENTER")), text(r.get("PRINCIPLE"))
    return _fix_row({
        "NO_NOTA": text(r.get("NO_NOTA")), "TANGGAL": tanggal, "TGL_JT": int64(r.get("TGL_JT")),
        "MATA_UANG": text(r.get("MATA_UANG")), "KURS": int64(r.get("KURS")),
        "KODE_CUST": text(r.get("KODE PELANGGAN INDUK")), "CUSTOMER": text(r.get("Nama Pelanggan Faktur Penjualan")),
        "KODE_SALESMAN": text(r.get("KODE_SALESMAN")), "SALESMAN": text(r.get("SALESMAN")),
        "KODE_BARANG": text(r.get("KODE_BARANG")), "NAMA_BARANG": text(r.get("NAMA_BARANG")),
        "QTY": int64(r.get("QTY")), "HARGA": num(r.get("HARGA")), "POTONGAN": num(r.get("POTONGAN")),
        "NILAI_JUAL": num(r.get("NILAI JUAL")), "DPP": num(r.get("DPP")), "NILAI_PAJAK": num(r.get("NILAI_PAJAK")),
        "SATUAN": text(r.get("SATUAN")), "NPWP": int64(r.get("NPWP Pelanggan Faktur Penjualan")),
        "GOLONGAN": lk.spv_name.get(cat(principal, cabang)), "GDG": text(r.get("GDG")),
        "GDGNAMA": text(r.get("GDGNAMA")), "ALAMAT": text(r.get("ALAMAT")), "KOTA": text(r.get("KOTA")),
        "QTYBONUS": "", "NILAI_BONUS": "", "JUMLAH": num(r.get("JUMLAH")), "CABANG_OR_COSTCENTER": cabang,
        "PRINCIPAL": principal, "JENISPRODUK": cabang, "MARKET": text(r.get("MARKET")), "JENISMARKET": "",
        "REGION": text(r.get("REGION")), "TAHUN": int64(r.get("TAHUN")),
        "BULAN": tanggal if tanggal in (None, ERR) else float(tanggal.month), "JENIS_TRANSAKSI": PENJ,
        "NO_SO": r.get("NO_SO"), "FIX QTY_SATUAN KECIL": int64(r.get("QTY_SATUANKECIL")),
        "SATUAN_KECIL": text(r.get("SATUAN_KECIL")), "DESA": "", "KECAMATAN": "", "REM": text(r.get("REM")),
        "WILAYAH": "", "Kuantitas (Unit)": text(r.get("Kuantitas (Unit)")), "KTP / NPWP": text(r.get("KTP / NPWP")),
    })


def _retur_jp(r: dict):
    return trim(text(r.get("Kode Jenis Produk")))


def _retur_dummy(r: dict, lk: Lookups):
    kode = _retur_jp(r)
    return cat(text(r.get("Nama Principal")), lk.jp_name.get(kode, kode) if kode is not None else None)


def _retur_row(r: dict, lk: Lookups) -> list:
    qty = int64(r.get("Qty"))
    bruto, disc, pajak = num(r.get("Nilai Bruto")), num(r.get("Nilai Disc")), num(r.get("Nilai Pajak"))
    dpp = _arith(bruto, disc, lambda a, b: a - b)
    tanggal = to_date(r.get("Tanggal"))
    satuan = trim(text(r.get("Satuan")))
    dummy = _retur_dummy(r, lk)
    # SATUAN ISI (Paste Cust Rep) kosong -> kemasan null; QTY_SATUANKECIL lalu FIX QTY_SATUAN KECIL.
    qsk = None if satuan in ("CTN", "KRT") else neg(qty)
    return _fix_row({
        "NO_NOTA": trim(text(r.get("No.Retur"))), "TANGGAL": tanggal, "TGL_JT": int64(r.get("Tgl JT")),
        "MATA_UANG": text(r.get("Mata Uang")), "KURS": int64(r.get("Kurs")),
        "KODE_CUST": trim(text(r.get("Kode Customer"))), "CUSTOMER": trim(text(r.get("Nama Customer"))),
        "KODE_SALESMAN": trim(text(r.get("Kode Salesman"))), "SALESMAN": trim(text(r.get("Nama Salesman"))),
        "KODE_BARANG": trim(text(r.get("Kode Barang"))), "NAMA_BARANG": text(r.get("Nama Barang")),
        "QTY": neg(qty), "HARGA": neg(_arith(bruto, qty, lambda a, b: a / b)), "POTONGAN": neg(disc),
        "NILAI_JUAL": neg(bruto), "DPP": neg(dpp), "NILAI_PAJAK": neg(pajak), "SATUAN": satuan,
        "NPWP": text(r.get("NPWP")), "GOLONGAN": lk.spv_name.get(dummy), "GDG": text(r.get("Kode Gudang")),
        "GDGNAMA": text(r.get("Nama Gudang")), "ALAMAT": text(r.get("Alamat Customer")),
        "KOTA": trim(text(r.get("Kota Customer"))), "QTYBONUS": int64(r.get("Qty Bonus")),
        "NILAI_BONUS": int64(r.get("Nilai Bonus")),
        "JUMLAH": neg(_arith(dpp, pajak, lambda a, b: a + b)), "CABANG_OR_COSTCENTER": "",
        "PRINCIPAL": trim(text(r.get("Nama Principal"))), "JENISPRODUK": lk.spv_jenis.get(dummy),
        "MARKET": text(r.get("Market")), "JENISMARKET": text(r.get("Jenis Market")), "REGION": text(r.get("Region")),
        "TAHUN": tanggal if tanggal in (None, ERR) else float(tanggal.year),
        "BULAN": tanggal if tanggal in (None, ERR) else float(tanggal.month), "JENIS_TRANSAKSI": RETUR,
        "NO_SO": "", "FIX QTY_SATUAN KECIL": neg(qty) if satuan in ("CTN", "KRT") and qsk is None else qsk,
        "SATUAN_KECIL": None, "DESA": text(r.get("Desa")), "KECAMATAN": text(r.get("Kecamatan")),
        "REM": trim(text(r.get("Keterangan"))), "WILAYAH": text(r.get("Wilayah")),
    })


def build_fix(acc_rows: list, retur_rows: list | None, lk: Lookups) -> list:
    """Paste Acc + Paste Lap. Retur -> baris FIX LAP PENJ (urutan Power Query)."""
    retur = [r for r in records(retur_rows) if r.get("Mata Uang") is not None] if retur_rows else []
    # Join SATUAN ISI & GOLONGAN (Paste Cust Rep/Paste Lap. Penj kosong) tidak mengubah urutan.
    retur = apply_join(retur, _retur_jp, lk.jp_keys)
    retur = apply_join(retur, lambda r: _retur_dummy(r, lk), lk.spv_keys)
    retur = apply_join(retur, lambda r: _retur_dummy(r, lk), lk.spv_keys)
    retur_fix = introsort([_retur_row(r, lk) for r in retur], key=lambda row: _sort_key(row[FX["NO_NOTA"]]))
    acc = [r for r in records(acc_rows) if r.get("MATA_UANG") is not None]
    acc = apply_join(acc, lambda r: cat(text(r.get("PRINCIPLE")), text(r.get("CABANG_OR_COSTCENTER"))), lk.spv_keys)
    return retur_fix + [_acc_row(r, lk) for r in acc]


def _sort_key(v):
    return (0, "") if v is None else (1, v)  # null paling awal pada Order.Ascending


def fix_from_table(rows: list) -> list:
    """Baris FIX LAP PENJ tersimpan (unggahan '2. To Format') -> baris FIX_COLUMNS nilai sel Excel."""
    header = ["" if h is None else str(h) for h in rows[0]]
    idx = [header.index(c) if c in header else None for c in FIX_COLUMNS]
    out = []
    for r in rows[1:]:
        row = [r[i] if i is not None and i < len(r) else None for i in idx]
        if row[FX["QTY_REF"]] is None:
            row[FX["QTY_REF"]] = ""  # ponytail: kolom konstanta "" Power Query; sel kosong terbaca null oleh calamine
        out.append(row)
    return out


# ---------- Stage 2: SalesBase ----------
SALES_COLUMNS = [
    "NO_NOTA", "TANGGAL", "TGL_JT", "KODE_CUST", "CUSTOMER", "KODE_SALESMAN", "SALESMAN", "KODE_BARANG",
    "NAMA_BARANG", "QTY", "HARGA", "POTONGAN", "NILAI_JUAL", "SATUAN", "NPWP", "GOLONGAN", "GDGNAMA", "ALAMAT",
    "KOTA", "QTYBONUS", "JUMLAH", "PRINCIPAL", "JENISPRODUK", "KELOMPOKPRODUK", "MARKET", "JENISMARKET", "REGION",
    "QTY_REF", "UNIT_REF", "TAHUN", "BULAN", "JENIS_TRANSAKSI", "QTYKONV", "QTY_SATUANKECIL", "SATUAN_KECIL", "REM",
    "Value Los", "AO", "EC", "Item batal", "Nota Batal", "Qty Los", "@ Toko Retur",
    "Value Retur Termasuk Batal (Exc.PPN)", "DPP", "Harga Sesuai Inputan", "Item Aktif", "Jumlah Nota Retur",
    "Mapping_PIC.NAMA SM", "Kategori Baru",
]
SX = {c: i for i, c in enumerate(SALES_COLUMNS)}
_SB_TEXT = ("NO_NOTA", "KODE_CUST", "CUSTOMER", "KODE_SALESMAN", "SALESMAN", "NAMA_BARANG", "SATUAN", "NPWP",
            "GOLONGAN", "GDGNAMA", "ALAMAT", "KOTA", "PRINCIPAL", "JENISPRODUK", "KELOMPOKPRODUK", "MARKET",
            "JENISMARKET", "REGION", "JENIS_TRANSAKSI", "SATUAN_KECIL", "REM")
_SB_INT = ("TGL_JT", "QTY", "QTYBONUS", "TAHUN", "BULAN")
_SB_NUM = ("HARGA", "POTONGAN", "NILAI_JUAL", "DPP", "JUMLAH")
_SB_ANY = ("KODE_BARANG", "QTY_REF", "UNIT_REF", "QTYKONV")


class SalesBase:
    """Kolom bertipe per baris FIX + flag AO/EC/IA/Nota Retur/Nota Batal (dihitung penuh, kunci RowID)."""

    def __init__(self, fix_rows: list, lk: Lookups):
        self.lk = lk
        self.rows = []
        for r in fix_rows:
            t = {c: text(r[FX[c]]) for c in _SB_TEXT}
            t.update({c: int64(r[FX[c]]) for c in _SB_INT})
            t.update({c: num(r[FX[c]]) for c in _SB_NUM})
            t.update({c: r[FX[c]] for c in _SB_ANY})
            t["TANGGAL"] = to_datetime(r[FX["TANGGAL"]])
            t["QTY_SATUANKECIL"] = int64(r[FX["FIX QTY_SATUAN KECIL"]])
            self.rows.append(t)
        n = len(self.rows)

        def first_rows(mask, key):
            seen, out = set(), []
            for i, t in enumerate(self.rows):
                if mask(t):
                    k = key(t)
                    if k not in seen:
                        seen.add(k)
                        out.append(i)
            return out

        def tanggal_date(t):
            v = t["TANGGAL"]
            return v.date() if isinstance(v, dt.datetime) else v

        non_retur = lambda t: t["JENIS_TRANSAKSI"] != RETUR
        retur = lambda t: t["JENIS_TRANSAKSI"] != PENJ
        self.batal = [1.0 if "BATAL" in (t["REM"] or "").upper() else 0.0 for t in self.rows]
        nota = lambda t: (t["PRINCIPAL"], t["KODE_SALESMAN"], t["NO_NOTA"], t["KODE_CUST"])
        self.flags = {
            "AO": first_rows(non_retur, lambda t: (t["KODE_SALESMAN"], t["KODE_CUST"], t["PRINCIPAL"])),
            "EC": first_rows(non_retur,
                             lambda t: (t["KODE_SALESMAN"], t["KODE_CUST"], t["PRINCIPAL"], tanggal_date(t))),
            "IA": first_rows(non_retur, lambda t: (t["KODE_CUST"], t["PRINCIPAL"], t["KODE_BARANG"])),
            "NR": first_rows(retur, nota),
            "NB": first_rows(lambda t: "BATAL" in (t["REM"] or "").upper(), nota),
        }
        self.flag_sets = {k: set(v) for k, v in self.flags.items()}
        self.n = n
        self.cache = {}  # rantai join penuh & hasil ADNAN dipakai ulang beberapa laporan

    def order(self, keep=None) -> list:
        """Urutan RowID keluaran SalesBase; keep = filter kolom sumber yang didorong ke bawah join."""
        if keep is None and "order" in self.cache:
            return self.cache["order"]
        rows = [i for i in range(self.n) if keep is None or keep(self.rows[i])]
        for name in ("AO", "EC", "IA", "NR", "NB"):
            rows = apply_join(rows, lambda i: i, self.flags[name])
        rows = apply_join(rows, lambda i: self.rows[i]["PRINCIPAL"], self.lk.map_keys)
        if keep is None:
            self.cache["order"] = rows
        return rows

    def output(self, i: int) -> list:
        t = self.rows[i]
        penj = t["JENIS_TRANSAKSI"] == PENJ
        qty_ref = t["QTY_REF"]
        ref_num = 0.0 if qty_ref is None else num(qty_ref)
        qty_num = 0.0 if t["QTY"] is None else t["QTY"]
        harga = 0.0 if t["HARGA"] is None else t["HARGA"]
        qty_los = _arith(ref_num, qty_num, lambda a, b: a - b) if penj else 0.0
        value_los = _arith(qty_los, harga, lambda a, b: a * b) if penj else 0.0
        dpp = t["DPP"]
        value_retur = 0.0 if penj else (ERR if dpp is ERR else abs(0.0 if dpp is None else dpp))
        nr = 1.0 if i in self.flag_sets["NR"] else 0.0
        nama = t["NAMA_BARANG"]
        if nama is None:
            kategori = ERR
        elif "SIRUP" in nama.upper():
            kategori = "Cordial"
        elif "NUTRIJELL" in nama.upper():
            kategori = "Nutrijell"
        else:
            kategori = "REGULER"
        out = [t.get(c) for c in SALES_COLUMNS]
        out[SX["Value Los"]] = value_los
        out[SX["AO"]] = 1.0 if i in self.flag_sets["AO"] else 0.0
        out[SX["EC"]] = 1.0 if i in self.flag_sets["EC"] else 0.0
        out[SX["Item batal"]] = self.batal[i]
        out[SX["Nota Batal"]] = 1.0 if i in self.flag_sets["NB"] else 0.0
        out[SX["Qty Los"]] = qty_los
        out[SX["@ Toko Retur"]] = nr
        out[SX["Value Retur Termasuk Batal (Exc.PPN)"]] = value_retur
        out[SX["Harga Sesuai Inputan"]] = t["HARGA"]
        out[SX["Item Aktif"]] = 1.0 if i in self.flag_sets["IA"] else 0.0
        out[SX["Jumlah Nota Retur"]] = nr
        out[SX["Mapping_PIC.NAMA SM"]] = self.lk.map_sm.get(t["PRINCIPAL"])
        out[SX["Kategori Baru"]] = kategori
        return out

    def table(self, keep=None, after=None) -> list:
        """Baris keluaran (50 kolom) untuk satu query target."""
        rows = [self.output(i) for i in self.order(keep)]
        return [r for r in rows if after(r)] if after else rows


# ---------- normalisasi teks query ANI/ADNAN/JONAL ----------
def normalize(v) -> str:
    if v is None or v is ERR:
        return ""
    return " ".join(p for p in v.replace("\xa0", " ").strip().upper().replace("\t", " ").replace("\n", " ")
                    .replace("\r", " ").split(" ") if p)


def principal_key(v) -> str:
    p = normalize(v)
    return "FOKUS RITEL NUSAPRIMA, PT" if p == "FOKUS RETAIL NUSAPRIMA, PT" else p


ANI_PRINCIPALS = frozenset({
    'FORISA NUSAPERSADA, PT', 'ENERGIZER INDONESIA, PT', 'GONDOWANGI TRADISIONAL KOSMETIK, PT',
    'MUSTIKA RATUBUANA INTERNATIONAL', 'PRISKILA PRIMA MAKMUR, PT', 'UNITAMA SARI MAS, PT',
    'ABC PRESIDENT INDONESIA, PT', 'PZ CUSSONS INDONESIA, PT', 'FOKUS RITEL NUSAPRIMA, PT',
    'VINDA INTERNATIONAL INDONESIA, PT', 'KINO INDONESIA. TBK, PT', 'DOLPHIN, PT',
})
JONAL_PRINCIPALS = frozenset({
    'FKS FOOD SEJAHTERA, PT', 'FONTERRA BRANDS INDONESIA, PT', 'GODREJ CONSUMER PRODUCTS INDONESIA, PT',
    'GUMINDO BOGAMANIS, PT', 'MARKETAMA INDAH, PT', 'MEGA SURYA MAS, PT', 'PRIMARASA ABADI SEJAHTERA, PT',
    'RECKITT BENCKISER, PT', 'UNIVERSAL INDOFOOD PRODUCT, PT', 'URC INDONESIA, PT',
})
MOTASA_SALESMAN = {
    "MOTASA MKS 1": frozenset({"MS1", "MS2", "MS3", "MS4", "MS5", "MTS1"}),
    "MOTASA MKS 2": frozenset({"MS6", "MS7", "MS8", "MS9", "MS10", "MTS2"}),
}


def _ani(t) -> bool:
    p, s = principal_key(t["PRINCIPAL"]), normalize(t["SALESMAN"])
    is_mt, is_office = "_MT" in s, "OFFICE" in s
    return p in ANI_PRINCIPALS and (is_mt or is_office) and (p != "FORISA NUSAPERSADA, PT" or is_mt)


def _motasa(keyword):
    def keep(t):
        if t["PRINCIPAL"] != "MOTASA INDONESIA, PT":
            return False
        s = "" if t["SALESMAN"] is None else t["SALESMAN"].strip().upper()
        return (s.split("_", 1)[0] if "_" in s else s) in MOTASA_SALESMAN[keyword]
    return keep


def _volume_kg(row: list):
    if row[SX["JENISPRODUK"]] != "PURATOS":
        return None
    nama = row[SX["NAMA_BARANG"]]
    if nama is None or "X" not in nama:
        return None
    after = nama.rsplit("X", 1)[1].strip()
    parts = [p for p in after.replace('"', " ").split(" ") if p]
    if not parts:
        return None
    token = parts[0].upper()
    digits = "".join(ch for ch in token if ch.isdigit() or ch in ",.").replace(",", ".")
    try:
        value = float(digits) if digits else None
    except ValueError:
        value = None
    qty = row[SX["QTY_SATUANKECIL"]]
    if value is None or qty is None or qty is ERR:
        return None
    if "GR" in token:
        return value / 1000 * qty
    if "KG" in token:
        return value * qty
    return None


def _adnan(rows: list, lk: Lookups) -> list:
    groups = {}
    for p, spv, _ in lk.mapping:
        names = groups.setdefault(normalize(text(p)), [])
        n = normalize(text(spv))
        if n and n not in names:
            names.append(n)
    if any(len(v) > 1 for v in groups.values()):
        raise ValueError("Mapping SPV berbeda untuk principal yang sama.")
    rows = apply_join(rows, lambda r: normalize(r[SX["PRINCIPAL"]]), list(groups))
    out = []
    for r in rows:
        p, s = normalize(r[SX["PRINCIPAL"]]), normalize(r[SX["SALESMAN"]])
        mt_office = "_MT" in s or "OFFICE" in s
        spv = (groups.get(p) or [None])[0]
        r = list(r)
        if p in JONAL_PRINCIPALS and mt_office:
            r[SX["GOLONGAN"]] = "JONAL"
        elif p == "DOLPHIN, PT" and mt_office:
            r[SX["GOLONGAN"]] = "ANI"
        elif spv:
            r[SX["GOLONGAN"]] = spv
        out.append(r)
    return out


def _adnan_rows(sb: "SalesBase") -> list:
    if "ADNAN" not in sb.cache:
        sb.cache["ADNAN"] = _adnan(sb.table(after=lambda r: r[SX["Mapping_PIC.NAMA SM"]] == "ADNAN"), sb.lk)
    return sb.cache["ADNAN"]


def _reckitt_rows(rows: list, lk: Lookups) -> list:
    devisi = {}
    keys = []
    for kode, _, _, _, dev in lk.reckitt:
        k = text(kode)
        keys.append(k)
        devisi.setdefault(k, []).append(dev or None)
    rows = apply_join(rows, lambda r: r[SX["KODE_BARANG"]], keys)
    cols = [SX[c] for c in SALES_COLUMNS if c not in ("Mapping_PIC.NAMA SM", "Kategori Baru")]
    out = []
    for r in rows:
        for dev in devisi.get(r[SX["KODE_BARANG"]], [None]):
            out.append([r[i] for i in cols] + [dev])
    return out


# ---------- MUSTIKA RATU (langsung dari FIX) ----------
# Daftar persis dari query M "MUSTIKA RATU" (List.Contains peka huruf; region di-Trim saja).
MTI_L_REGIONS = frozenset({
    'LOKAL MINI MARKET_SELATAN KOTA', 'LOKAL MINI MARKET_SELATAN PINGGIRAN', 'LOKAL MINI MARKET_UTARA KOTA',
    'LOKAL MINI MARKET_UTARA PINGGIRAN', 'LOKAL SUPER MARKET_SELATAN PINGGIRAN',
})
MTI_L_CUSTOMERS = frozenset({
    'C-CIT042', 'C-CIT036', 'C-CI0001', 'C-CIT002',
})
KA_MM_REGIONS = frozenset({
    'NKA MINI MARKET_KS', 'NKA MINI MARKET_LUAR KOTA', 'NKA MINI MARKET_SELATAN KOTA',
})
GT_COS_REGIONS = frozenset({
    'COSMETIK_LUAR KOTA', 'COSMETIK_SELATAN KOTA', 'COSMETIK_SELATAN PINGGIRAN', 'COSMETIK_UTARA KOTA',
    'COSMETIK_UTARA PINGGIRAN',
})
HRC_REGIONS = frozenset({
    'HOREKA_LUAR KOTA', 'HOREKA_SELATAN KOTA', 'HOREKA_SELATAN PINGGIRAN', 'HOREKA_UTARA KOTA',
    'HOREKA_UTARA PINGGIRAN',
})
KOP_REGIONS = frozenset({
    'KOPERASI_LUAR KOTA', 'KOPERASI_SELATAN KOTA', 'KOPERASI_SELATAN PINGGIRAN', 'KOPERASI_UTARA KOTA',
    'KOPERASI_UTARA PINGGIRAN',
})
KA_HM_CUSTOMERS = frozenset({
    'C-LO0013', 'C-MA0041', 'C-HE0027', 'C-HE0001',
})
APT_REGIONS = frozenset({
    'APOTIK & TOKO OBAT_LUAR KOTA', 'APOTIK & TOKO OBAT_SELATAN KOTA', 'APOTIK & TOKO OBAT_SELATAN PINGGIRAN',
    'APOTIK & TOKO OBAT_UTARA KOTA', 'APOTIK & TOKO OBAT_UTARA PINGGIRAN',
})
GT_TK_REGIONS = frozenset({
    'BABY SHOP_LUAR KOTA', 'BABY SHOP_SELATAN KOTA', 'BABY SHOP_SELATAN PINGGIRAN', 'BABY SHOP_UTARA KOTA',
    'BABY SHOP_UTARA PINGGIRAN', 'BAHAN BANGUNAN_LUAR KOTA', 'BAHAN BANGUNAN_SELATAN KOTA',
    'BAHAN BANGUNAN_UTARA KOTA', 'BAHAN BANGUNAN_UTARA PINGGIRAN', 'ELEKTONIK_LUAR KOTA', 'ELEKTONIK_SELATAN KOTA',
    'ELEKTONIK_SELATAN PINGGIRAN', 'ELEKTONIK_UTARA KOTA', 'ELEKTONIK_UTARA PINGGIRAN', 'KANVAS MOBIL_SELATAN KOTA',
    'KANVAS MOBIL_SELATAN PINGGIRAN', 'KANVAS MOBIL_UTARA KOTA', 'KANVAS MOBIL_UTARA PINGGIRAN',
    'KANVAS MOTOR_SELATAN KOTA', 'KANVAS MOTOR_SELATAN PINGGIRAN', 'KARYWAN ATAU PRINCIPLE_LUAR KOTA',
    'KARYWAN ATAU PRINCIPLE_SELATAN KOTA', 'KARYWAN ATAU PRINCIPLE_SELATAN PINGGIRAN',
    'KARYWAN ATAU PRINCIPLE_UTARA KOTA', 'KARYWAN ATAU PRINCIPLE_UTARA PINGGIRAN', 'KEKURANGAN EXPEDISI_KS',
    'KEKURANGAN EXPEDISI_UTARA KOTA', 'Others', 'OTHER_LUAR KOTA', 'OTHER_SELATAN KOTA', 'OTHER_SELATAN PINGGIRAN',
    'OTHER_UTARA KOTA', 'OTHER_UTARA PINGGIRAN', 'SUBDIST_LUAR KOTA', 'SUBDIST_UTARA PINGGIRAN',
    'RTL BIG (600 KE ATAS)_KS', 'RTL BIG (600 KE ATAS)_LUAR KOTA', 'RTL BIG (600 KE ATAS)_SELATAN KOTA',
    'RTL BIG (600 KE ATAS)_SELATAN PINGGIRAN', 'RTL BIG (600 KE ATAS)_UTARA KOTA',
    'RTL BIG (600 KE ATAS)_UTARA PINGGIRAN', 'RTL SMALL (600 KE BAWAH)_KS', 'RTL SMALL (600 KE BAWAH)_LUAR KOTA',
    'RTL SMALL (600 KE BAWAH)_SELATAN KOTA', 'RTL SMALL (600 KE BAWAH)_SELATAN PINGGIRAN',
    'RTL SMALL (600 KE BAWAH)_TJ~', 'RTL SMALL (600 KE BAWAH)_UTARA KOTA',
    'RTL SMALL (600 KE BAWAH)_UTARA PINGGIRAN',
})
BA_CUSTOMERS = frozenset({
    'C-GRA001', 'C-GRA018', 'C-TO0001', 'C-TOS001', 'C-IN0008', 'C-TOP005', 'C-SA0269', 'C-SA0001', 'C-CIT036',
    'C-MA0056',
})

MUSTIKA = "MUSTIKA RATUBUANA INTERNATIONAL"
MUSTIKA_COLUMNS = ["Kode Dist", "Nama Dist", "AREA", "Kode Outlet", "Nama Outlet", "Type Outlet", "Kode Salesman",
                   "Nama Salesman", "Kode Item", "Nama Item", "Tgl. Transaksi", "No.Faktur", "Kode Transaksi",
                   "Quantity", "HET", "NET PENJUALAN", "DISC1", "BA / NON BA", "ALAMAT", "KOTA"]


def _market_mr(region, cust):
    reg, cust = trim(region), trim(cust)
    if reg in MTI_L_REGIONS or cust in MTI_L_CUSTOMERS:
        return "MTI-L"
    for regions, label in ((KA_MM_REGIONS, "KA-MM"), (GT_COS_REGIONS, "GT-COS"), (HRC_REGIONS, "IS-HRC-RST"),
                           (KOP_REGIONS, "IS-KOP")):
        if reg in regions:
            return label
    if cust in KA_HM_CUSTOMERS:
        return "KA-HM"
    if reg in APT_REGIONS:
        return "GT-APT"
    if reg in GT_TK_REGIONS:
        return "GT-TK"
    return "GT-WS"


def mustika_rows(fix_rows: list, lk: Lookups) -> list:
    rows = [r for r in fix_rows if text(r[FX["PRINCIPAL"]]) == MUSTIKA]
    price = {}
    for kode, _, gt, _, mt, _ in lk.pl_mr:
        key = None if kode is None else text(kode).strip().upper()
        cur = price.setdefault(key, [None, None])
        cur[0] = cur[0] if cur[0] is not None else num(gt)
        cur[1] = cur[1] if cur[1] is not None else num(mt)
    keyf = lambda r: None if r[FX["KODE_BARANG"]] is None else text(r[FX["KODE_BARANG"]]).strip().upper()
    rows = apply_join(rows, keyf, list(price))
    out = []
    for r in rows:
        cust, nama = text(r[FX["KODE_CUST"]]), text(r[FX["NAMA_BARANG"]])
        market = _market_mr(text(r[FX["REGION"]]), cust)
        pos = nama.find('"') if nama is not None else -1
        qty = int64(r[FX["FIX QTY_SATUAN KECIL"]])
        nilai = num(r[FX["NILAI_JUAL"]])
        fallback = net_round(nilai * 1.11 / qty) if qty not in (None, ERR, 0.0) and nilai not in (None, ERR) else None
        gt, mt = price.get(keyf(r), (None, None))
        base = mt if market in ("MTI-L", "KA-MM", "KA-HM") else gt
        het = net_round(base * 1.11 if base is not None else fallback)
        jumlah, potongan = num(r[FX["JUMLAH"]]), num(r[FX["POTONGAN"]])
        out.append([
            2000222.0, "SURYA PERKASA, CV", "MAKASSAR", cust, text(r[FX["CUSTOMER"]]), market,
            text(r[FX["KODE_SALESMAN"]]), text(r[FX["SALESMAN"]]), nama[pos + 1:pos + 8] if pos >= 0 else None, nama,
            to_datetime(to_date(r[FX["TANGGAL"]])), text(r[FX["NO_NOTA"]]), text(r[FX["JENIS_TRANSAKSI"]]), qty, het,
            net_round(jumlah), net_round(potongan * 1.11 if potongan not in (None, ERR) else potongan),
            "BA" if cust in BA_CUSTOMERS else "NON BA", text(r[FX["ALAMAT"]]), text(r[FX["KOTA"]]),
        ])
    return out


# ---------- Stock (Master Stock) ----------
STOCK_COLUMNS = ["Kode", "Nama Barang", "Kode Gudang", "Nama Gudang", "Satuan", "Principal", "Saldo Akhir"]
_STOCK_TEXT = ("Kode", "Nama Barang", "Kode Gudang", "Nama Gudang", "Satuan", "Principal")


def master_stock(stock_rows: list) -> list:
    """3. Stock.xlsx Sheet1 -> baris bertipe (7 kolom) dalam urutan sumber."""
    out = []
    for r in records(stock_rows):
        out.append([text(r.get(c)) for c in _STOCK_TEXT] + [int64(r.get("Saldo Akhir"))])
    return out


def stock_table(stock: list, lk: Lookups, keep=None, after=None) -> list:
    """Filter kolom sumber (keep) didorong sebelum join Mapping_PIC; filter SPV/SM (after) setelahnya."""
    rows = [r for r in stock if keep is None or keep(r)]
    rows = apply_join(rows, lambda r: r[5], lk.map_keys)
    if after:
        rows = [r for r in rows if after(lk.map_spv.get(r[5]), lk.map_sm.get(r[5]))]
    return [list(r) for r in rows]


# ---------- definisi laporan per keyword (setara sheet workbook 2.3) ----------
GOLONGAN_TARGETS = {
    "SUMARTONO": "SUMARTONO", "MARTEN": "MARTEN", "SOFYAN": "SOFYAN", "HEINZ": "ZUL & ARUL", "SYAMSUL": "SYAMSUL",
    "STANLEY": "STANLEY", "YARMAN": "YARMAN", "RAMLY": "RAMLY", "RECKIT": "SOFYAN",
}
PRINCIPAL_TARGETS = {
    "GODREJJ": "GODREJ CONSUMER PRODUCTS INDONESIA, PT", "ENERGIZER": "ENERGIZER INDONESIA, PT",
    "ABCPI": "ABC PRESIDENT INDONESIA, PT", "FONTERRA": "FONTERRA BRANDS INDONESIA, PT", "URC": "URC INDONESIA, PT",
    "MUSTIKA RATU": MUSTIKA, "MOTASA MKS 1": "MOTASA INDONESIA, PT", "MOTASA MKS 2": "MOTASA INDONESIA, PT",
    "MSM": "MEGA SURYA MAS, PT", "DOLPHIN": "DOLPHIN, PT",
}
SM_TARGETS = {"ADNAN": "ADNAN", "IRMAN": "IRMAN"}
# Arsip berkas ini dibuat manual (tempel nilai ke workbook baru): sheet Sheet1/Sheet2, tanggal angka seri.
MANUAL_FORMAT = frozenset({"MSM", "DOLPHIN", "MOTASA MKS 1", "MOTASA MKS 2"})
# Kolom TGL_JT sheet FONTERRA dan URC di workbook 2.3 berformat tanggal (sel lain: angka seri).
TGL_JT_AS_DATE = frozenset({"FONTERRA", "URC"})
REPORT_KEYWORDS = tuple(sorted({*GOLONGAN_TARGETS, *PRINCIPAL_TARGETS, *SM_TARGETS, "ANI"}))


def group_type(keyword: str) -> str:
    if keyword in SM_TARGETS:
        return "sm"
    return "spv" if keyword in GOLONGAN_TARGETS or keyword == "ANI" else "principal"


def report_keyword(keyword: str):
    """Keyword penerima -> keyword laporan kanonik (tanpa beda huruf/spasi), atau None bila tidak dikenal."""
    norm = " ".join(str(keyword).upper().split())
    return next((k for k in REPORT_KEYWORDS if k == norm), None)


def build_report(keyword: str, sb: SalesBase, fix_rows: list, stock: list | None) -> list:
    """Sheet [(nama, header, baris)] untuk satu keyword, persis seperti workbook 2.3 / arsip LaporanAuto."""
    lk = sb.lk
    header = list(SALES_COLUMNS)
    if keyword in GOLONGAN_TARGETS:
        gol = GOLONGAN_TARGETS[keyword]
        rows = sb.table(keep=lambda t: t["GOLONGAN"] == gol)
        if keyword == "MARTEN":
            header.append("VOLUME_KG")
            rows = [r + [_volume_kg(r)] for r in rows]
        elif keyword == "RECKIT":
            header = [c for c in SALES_COLUMNS if c not in ("Mapping_PIC.NAMA SM", "Kategori Baru")] + ["Devisi"]
            rows = _reckitt_rows(rows, lk)
    elif keyword == "ADNAN":
        rows = _adnan_rows(sb)
    elif keyword in SM_TARGETS:
        sm = SM_TARGETS[keyword]
        rows = sb.table(after=lambda r: r[SX["Mapping_PIC.NAMA SM"]] == sm)
    elif keyword == "ANI":  # predikat berfungsi kustom tidak didorong ke bawah join oleh Power Query
        rows = sb.table(after=lambda r: _ani({"PRINCIPAL": r[SX["PRINCIPAL"]], "SALESMAN": r[SX["SALESMAN"]]}))
    elif keyword == "MUSTIKA RATU":
        header, rows = list(MUSTIKA_COLUMNS), mustika_rows(fix_rows, lk)
    elif keyword in ("MSM", "DOLPHIN"):
        principal = PRINCIPAL_TARGETS[keyword]
        rows = [r for r in _adnan_rows(sb) if r[SX["PRINCIPAL"]] == principal]
    elif keyword in MOTASA_SALESMAN:  # filter principal didorong ke bawah; filter kode salesman (try/otherwise) tidak
        keep_salesman = _motasa(keyword)
        rows = sb.table(keep=lambda t: t["PRINCIPAL"] == "MOTASA INDONESIA, PT",
                        after=lambda r: keep_salesman({"PRINCIPAL": r[SX["PRINCIPAL"]], "SALESMAN": r[SX["SALESMAN"]]}))
    elif keyword == "FONTERRA":
        principal = PRINCIPAL_TARGETS[keyword]
        rows = sb.table(keep=lambda t: t["PRINCIPAL"] == principal and "C-TUN020" not in (t["KODE_CUST"] or ""))
    elif keyword in PRINCIPAL_TARGETS:
        principal = PRINCIPAL_TARGETS[keyword]
        rows = sb.table(keep=lambda t: t["PRINCIPAL"] == principal)
    else:
        raise KeyError(keyword)
    if keyword in TGL_JT_AS_DATE:
        col = header.index("TGL_JT")
        rows = [r[:col] + [to_datetime(r[col])] + r[col + 1:] for r in rows]
    sheets = [(keyword, header, rows)]
    if stock is not None:
        sheets.append((f"{keyword} STOCK", list(STOCK_COLUMNS), _stock_for(keyword, stock, lk)))
    if keyword in MANUAL_FORMAT:
        sheets = [(f"Sheet{i + 1}", h, r) for i, (_, h, r) in enumerate(sheets)]
    return sheets


def _stock_for(keyword: str, stock: list, lk: Lookups) -> list:
    if keyword in GOLONGAN_TARGETS:
        spv = GOLONGAN_TARGETS[keyword]
        return stock_table(stock, lk, after=lambda s, _: s == spv)
    if keyword in SM_TARGETS:
        sm = SM_TARGETS[keyword]
        return stock_table(stock, lk, after=lambda _, s: s == sm)
    if keyword == "ANI":  # fungsi kustom: dievaluasi setelah join Mapping_PIC (tidak didorong ke bawah)
        return [r for r in stock_table(stock, lk) if principal_key(r[5]) in ANI_PRINCIPALS]
    principal = PRINCIPAL_TARGETS[keyword]
    if keyword == "FONTERRA":
        return stock_table(stock, lk, keep=lambda r: r[5] == principal and r[2] == "GD01")
    rows = stock_table(stock, lk, keep=lambda r: r[5] == principal)
    if keyword == "MUSTIKA RATU":
        # Tabel Excel MUSTIKA_RATU_STOCK menyimpan sortState kolom D (Nama Gudang); Excel mengurutkan ulang (stabil)
        # setiap refresh. ponytail: kolasi Excel didekati casefold; cukup untuk nama gudang huruf besar.
        rows.sort(key=lambda r: (r[3] is None, (r[3] or "").casefold()))
    return rows


# ---------- penulis XLSX (setara salinan nilai openpyxl arsip LaporanAuto) ----------
_STYLES = (
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd h:mm:ss"/></numFmts>'
    '<fonts count="1"><font><name val="Calibri"/><family val="2"/><color theme="1"/><sz val="11"/>'
    '<scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill/></fill>'
    '<fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/>'
    '<bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" '
    'borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1" xfId="0"/></cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
)
_ILLEGAL = {c: None for c in range(32) if c not in (9, 10, 13)}


def _col(n: int) -> str:
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _cell(ref: str, v, serial_dates: bool) -> str:
    if v is None or v is ERR or v == "":
        return ""
    if isinstance(v, bool):
        return f'<c r="{ref}" t="b"><v>{int(v)}</v></c>'
    if isinstance(v, (dt.date, dt.datetime)):
        d = v if isinstance(v, dt.datetime) else dt.datetime(v.year, v.month, v.day)
        serial = repr((d - EPOCH).total_seconds() / 86400).removesuffix(".0")
        return f'<c r="{ref}"><v>{serial}</v></c>' if serial_dates else f'<c r="{ref}" s="1"><v>{serial}</v></c>'
    if isinstance(v, (int, float)):
        return f'<c r="{ref}"><v>{repr(float(v)).removesuffix(".0")}</v></c>'
    s = escape(str(v).translate(_ILLEGAL))  # ponytail: karakter kontrol ilegal XML dibuang (openpyxl lama gagal)
    space = ' xml:space="preserve"' if s != s.strip() else ""
    return f'<c r="{ref}" t="inlineStr"><is><t{space}>{s}</t></is></c>'


def write_workbook(path: str, sheets: list, serial_dates: bool = False) -> None:
    """sheets: [(nama, header, baris)]. Tanggal = format 'yyyy-mm-dd h:mm:ss' kecuali serial_dates."""
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel_ns = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", (
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/'
            'content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.'
            'relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/'
            'workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.'
            'spreadsheetml.styles+xml"/>' + "".join(
                f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-'
                f'officedocument.spreadsheetml.worksheet+xml"/>' for i in range(len(sheets))) + "</Types>"))
        z.writestr("_rels/.rels", (
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/'
            '2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'))
        z.writestr("xl/workbook.xml", (
            f'<?xml version="1.0" encoding="UTF-8"?><workbook {ns} {rel_ns}><sheets>' + "".join(
                f'<sheet name="{escape(name, {chr(34): "&quot;"})}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
                for i, (name, _, _) in enumerate(sheets)) + "</sheets></workbook>"))
        z.writestr("xl/_rels/workbook.xml.rels", (
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/'
            '2006/relationships">' + "".join(
                f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                f'relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(sheets)))
            + f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/styles" Target="styles.xml"/></Relationships>'))
        z.writestr("xl/styles.xml", _STYLES)
        for i, (_, header, rows) in enumerate(sheets):
            with z.open(f"xl/worksheets/sheet{i + 1}.xml", "w") as f:
                f.write(f'<?xml version="1.0" encoding="UTF-8"?><worksheet {ns}><sheetData>'.encode())
                for r, values in enumerate([header] + rows, start=1):
                    cells = "".join(_cell(f"{_col(c)}{r}", v, serial_dates) for c, v in enumerate(values))
                    f.write(f'<row r="{r}">{cells}</row>'.encode("utf-8"))
                f.write(b"</sheetData></worksheet>")
