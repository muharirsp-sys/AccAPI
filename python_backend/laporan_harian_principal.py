"""Tujuan: Mereplikasi filter dan format khusus Power Query laporan Principal.
Caller: laporan_harian.resolve_report_groups dan write_report_files.
Dependensi: pandas, laporan_harian_pl_mr.csv, laporan_harian_reckitt_items.csv.
Main Functions: apply_sales_rule, apply_stock_rule, build_principal_report, build_principal_stock,
                serta normalisasi pandas.NA yang null-safe.
Side Effects: Membaca dua CSV referensi lokal secara lazy; tidak menulis file.
"""

from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent

MUSTIKA_COLUMNS = [
    "Kode Dist", "Nama Dist", "AREA", "Kode Outlet", "Nama Outlet", "Type Outlet",
    "Kode Salesman", "Nama Salesman", "Kode Item", "Nama Item", "Tgl. Transaksi",
    "No.Faktur", "Kode Transaksi", "Quantity", "HET", "NET PENJUALAN", "DISC1",
    "BA / NON BA", "ALAMAT", "KOTA",
]
PRINCIPAL_STOCK_COLUMNS = [
    "Kode", "Nama Barang", "Kode Gudang", "Nama Gudang", "Satuan", "Principal", "Saldo Akhir",
]

MTI_L_REGIONS = {
    "LOKAL MINI MARKET_SELATAN KOTA", "LOKAL MINI MARKET_SELATAN PINGGIRAN",
    "LOKAL MINI MARKET_UTARA KOTA", "LOKAL MINI MARKET_UTARA PINGGIRAN",
    "LOKAL SUPER MARKET_SELATAN PINGGIRAN",
}
MTI_L_CUSTOMERS = {"C-CIT042", "C-CIT036", "C-CI0001", "C-CIT002"}
KA_MM_REGIONS = {"NKA MINI MARKET_KS", "NKA MINI MARKET_LUAR KOTA", "NKA MINI MARKET_SELATAN KOTA"}
GT_COS_REGIONS = {
    "COSMETIK_LUAR KOTA", "COSMETIK_SELATAN KOTA", "COSMETIK_SELATAN PINGGIRAN",
    "COSMETIK_UTARA KOTA", "COSMETIK_UTARA PINGGIRAN",
}
HRC_REGIONS = {
    "HOREKA_LUAR KOTA", "HOREKA_SELATAN KOTA", "HOREKA_SELATAN PINGGIRAN",
    "HOREKA_UTARA KOTA", "HOREKA_UTARA PINGGIRAN",
}
KOP_REGIONS = {
    "KOPERASI_LUAR KOTA", "KOPERASI_SELATAN KOTA", "KOPERASI_SELATAN PINGGIRAN",
    "KOPERASI_UTARA KOTA", "KOPERASI_UTARA PINGGIRAN",
}
KA_HM_CUSTOMERS = {"C-LO0013", "C-MA0041", "C-HE0027", "C-HE0001"}
APT_REGIONS = {
    "APOTIK & TOKO OBAT_LUAR KOTA", "APOTIK & TOKO OBAT_SELATAN KOTA",
    "APOTIK & TOKO OBAT_SELATAN PINGGIRAN", "APOTIK & TOKO OBAT_UTARA KOTA",
    "APOTIK & TOKO OBAT_UTARA PINGGIRAN",
}
GT_TK_REGIONS = {
    "BABY SHOP_LUAR KOTA", "BABY SHOP_SELATAN KOTA", "BABY SHOP_SELATAN PINGGIRAN",
    "BABY SHOP_UTARA KOTA", "BABY SHOP_UTARA PINGGIRAN", "BAHAN BANGUNAN_LUAR KOTA",
    "BAHAN BANGUNAN_SELATAN KOTA", "BAHAN BANGUNAN_UTARA KOTA",
    "BAHAN BANGUNAN_UTARA PINGGIRAN", "ELEKTONIK_LUAR KOTA", "ELEKTONIK_SELATAN KOTA",
    "ELEKTONIK_SELATAN PINGGIRAN", "ELEKTONIK_UTARA KOTA", "ELEKTONIK_UTARA PINGGIRAN",
    "KANVAS MOBIL_SELATAN KOTA", "KANVAS MOBIL_SELATAN PINGGIRAN", "KANVAS MOBIL_UTARA KOTA",
    "KANVAS MOBIL_UTARA PINGGIRAN", "KANVAS MOTOR_SELATAN KOTA",
    "KANVAS MOTOR_SELATAN PINGGIRAN", "KARYWAN ATAU PRINCIPLE_LUAR KOTA",
    "KARYWAN ATAU PRINCIPLE_SELATAN KOTA", "KARYWAN ATAU PRINCIPLE_SELATAN PINGGIRAN",
    "KARYWAN ATAU PRINCIPLE_UTARA KOTA", "KARYWAN ATAU PRINCIPLE_UTARA PINGGIRAN",
    "KEKURANGAN EXPEDISI_KS", "KEKURANGAN EXPEDISI_UTARA KOTA", "OTHERS",
    "OTHER_LUAR KOTA", "OTHER_SELATAN KOTA", "OTHER_SELATAN PINGGIRAN", "OTHER_UTARA KOTA",
    "OTHER_UTARA PINGGIRAN", "SUBDIST_LUAR KOTA", "SUBDIST_UTARA PINGGIRAN",
    "RTL BIG (600 KE ATAS)_KS", "RTL BIG (600 KE ATAS)_LUAR KOTA",
    "RTL BIG (600 KE ATAS)_SELATAN KOTA", "RTL BIG (600 KE ATAS)_SELATAN PINGGIRAN",
    "RTL BIG (600 KE ATAS)_UTARA KOTA", "RTL BIG (600 KE ATAS)_UTARA PINGGIRAN",
    "RTL SMALL (600 KE BAWAH)_KS", "RTL SMALL (600 KE BAWAH)_LUAR KOTA",
    "RTL SMALL (600 KE BAWAH)_SELATAN KOTA", "RTL SMALL (600 KE BAWAH)_SELATAN PINGGIRAN",
    "RTL SMALL (600 KE BAWAH)_TJ~", "RTL SMALL (600 KE BAWAH)_UTARA KOTA",
    "RTL SMALL (600 KE BAWAH)_UTARA PINGGIRAN",
}
BA_CUSTOMERS = {
    "C-GRA001", "C-GRA018", "C-TO0001", "C-TOS001", "C-IN0008",
    "C-TOP005", "C-SA0269", "C-SA0001", "C-CIT036", "C-MA0056",
}


def _normal(value) -> str:
    if value is None or pd.isna(value):
        return ""
    return " ".join(str(value).strip().upper().split())


def _code(value) -> str:
    if pd.isna(value):
        return ""
    if isinstance(value, (float, np.floating)) and float(value).is_integer():
        return f"{value:.0f}"
    return str(value).strip().upper()


def _series(frame: pd.DataFrame, name: str, default=None) -> pd.Series:
    if name in frame:
        return frame[name]
    return pd.Series(default, index=frame.index)


@lru_cache(maxsize=1)
def _price_list() -> pd.DataFrame:
    frame = pd.read_csv(BASE_DIR / "laporan_harian_pl_mr.csv", comment="#", dtype={"KODE BARANG": "string"})
    frame = frame.assign(_CODE=frame["KODE BARANG"].map(_code))
    for column in ("HARGA JUAL GT SAT KECIL", "HARGA JUAL MT SAT KECIL"):
        frame = frame.assign(**{column: pd.to_numeric(frame[column], errors="coerce")})
    return (frame.groupby("_CODE", as_index=False)
            .agg({"HARGA JUAL GT SAT KECIL": "first", "HARGA JUAL MT SAT KECIL": "first"})
            .set_index("_CODE"))


@lru_cache(maxsize=1)
def _reckitt_divisions() -> dict:
    frame = pd.read_csv(
        BASE_DIR / "laporan_harian_reckitt_items.csv",
        comment="#",
        dtype={"Kode Brg": "string"},
    )
    frame = frame.assign(_CODE=frame["Kode Brg"].map(_code))
    return (frame.dropna(subset=["Devisi"]).drop_duplicates("_CODE")
            .set_index("_CODE")["Devisi"].to_dict())


def apply_sales_rule(keyword: str, frame: pd.DataFrame) -> pd.DataFrame:
    """Terapkan filter tambahan setelah filter Principal kanonik."""
    key = _normal(keyword)
    out = frame.copy()
    if key == "FONTERRA":
        excluded = _series(out, "KODE_CUST", "").astype("string").str.contains("C-TUN020", na=False)
        out = out[~excluded].copy()
    elif key in {"MOTASA MKS 1", "MOTASA MKS 2"}:
        prefixes = (
            {"MS1", "MS2", "MS3", "MS4", "MS5", "MTS1"}
            if key.endswith("1") else
            {"MS6", "MS7", "MS8", "MS9", "MS10", "MTS2"}
        )
        salesman = _series(out, "SALESMAN", "").map(_normal).str.split("_").str[0]
        out = out[salesman.isin(prefixes)].copy()
    return out


def apply_stock_rule(keyword: str, frame: pd.DataFrame) -> pd.DataFrame:
    """Power Query khusus stock: FONTERRA hanya gudang GD01."""
    out = frame.copy()
    if _normal(keyword) == "FONTERRA":
        warehouse = next(
            (column for column in out.columns if _normal(column) in {"KODE GUDANG", "WAREHOUSE CODE"}),
            None,
        )
        if warehouse:
            out = out[out[warehouse].map(_normal) == "GD01"].copy()
    return out


def _mustika_market(frame: pd.DataFrame) -> pd.Series:
    region = _series(frame, "REGION", "").map(_normal)
    customer = _series(frame, "KODE_CUST", "").map(_normal)
    conditions = [
        region.isin(MTI_L_REGIONS) | customer.isin(MTI_L_CUSTOMERS),
        region.isin(KA_MM_REGIONS),
        region.isin(GT_COS_REGIONS),
        region.isin(HRC_REGIONS),
        region.isin(KOP_REGIONS),
        customer.isin(KA_HM_CUSTOMERS),
        region.isin(APT_REGIONS),
        region.isin(GT_TK_REGIONS),
    ]
    return pd.Series(
        np.select(conditions, ["MTI-L", "KA-MM", "GT-COS", "IS-HRC-RST", "IS-KOP", "KA-HM", "GT-APT", "GT-TK"], default="GT-WS"),
        index=frame.index,
    )


def _mustika_item_code(value):
    if pd.isna(value):
        return None
    text = str(value)
    position = text.find('"')
    return text[position + 1:position + 8] if position >= 0 else None


def _build_mustika(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    market = _mustika_market(out)
    quantity_column = "QTY_SATUANKECIL" if "QTY_SATUANKECIL" in out else "FIX QTY_SATUAN KECIL"
    quantity = pd.to_numeric(_series(out, quantity_column), errors="coerce")
    nilai_jual = pd.to_numeric(_series(out, "NILAI_JUAL"), errors="coerce")
    price = _price_list()
    codes = _series(out, "KODE_BARANG", "").map(_code)
    gt_price = codes.map(price["HARGA JUAL GT SAT KECIL"])
    mt_price = codes.map(price["HARGA JUAL MT SAT KECIL"])
    selected_price = mt_price.where(market.isin({"MTI-L", "KA-MM", "KA-HM"}), gt_price)
    fallback = (nilai_jual * 1.11 / quantity.replace(0, np.nan)).round(2)
    het = (selected_price * 1.11).where(selected_price.notna(), fallback).round(2)

    result = pd.DataFrame(index=out.index)
    result["Kode Dist"] = 2000222
    result["Nama Dist"] = "SURYA PERKASA, CV"
    result["AREA"] = "MAKASSAR"
    result["Kode Outlet"] = _series(out, "KODE_CUST")
    result["Nama Outlet"] = _series(out, "CUSTOMER")
    result["Type Outlet"] = market
    result["Kode Salesman"] = _series(out, "KODE_SALESMAN")
    result["Nama Salesman"] = _series(out, "SALESMAN")
    result["Kode Item"] = _series(out, "NAMA_BARANG").map(_mustika_item_code)
    result["Nama Item"] = _series(out, "NAMA_BARANG")
    result["Tgl. Transaksi"] = pd.to_datetime(_series(out, "TANGGAL"), errors="coerce").dt.strftime("%Y-%m-%d")
    result["No.Faktur"] = _series(out, "NO_NOTA")
    result["Kode Transaksi"] = _series(out, "JENIS_TRANSAKSI")
    result["Quantity"] = quantity
    result["HET"] = het
    result["NET PENJUALAN"] = pd.to_numeric(_series(out, "JUMLAH"), errors="coerce").round(2)
    result["DISC1"] = (pd.to_numeric(_series(out, "POTONGAN"), errors="coerce") * 1.11).round(2)
    result["BA / NON BA"] = np.where(_series(out, "KODE_CUST", "").map(_normal).isin(BA_CUSTOMERS), "BA", "NON BA")
    result["ALAMAT"] = _series(out, "ALAMAT")
    result["KOTA"] = _series(out, "KOTA")
    return result[MUSTIKA_COLUMNS].astype(object).where(pd.notna(result), None)


def build_principal_report(keyword: str, frame: pd.DataFrame, default_columns: list) -> pd.DataFrame:
    """Format khusus Mustika/Reckitt; Principal lain memakai kolom standar."""
    key = _normal(keyword)
    if key == "MUSTIKA RATU":
        return _build_mustika(frame)
    if key == "RECKIT":
        out = frame.copy()
        division = _series(out, "KODE_BARANG", "").map(_code).map(_reckitt_divisions())
        columns = [column for column in default_columns if column not in {"Mapping_PIC.NAMA SM", "Kategori Baru"}]
        result = out.reindex(columns=columns).copy().assign(Devisi=division)
        return result.astype(object).where(pd.notna(result), None)
    return pd.DataFrame()


def build_principal_stock(frame: pd.DataFrame) -> pd.DataFrame:
    """Samakan tujuh kolom stock semua query Principal lama."""
    aliases = {
        "Kode": ("KODE_BARANG", "Kode", "Kode Barang"),
        "Nama Barang": ("Nama Barang", "NAMA_BARANG"),
        "Kode Gudang": ("Kode Gudang", "KODE GUDANG"),
        "Nama Gudang": ("Nama Gudang", "NAMA GUDANG"),
        "Satuan": ("Satuan", "SATUAN"),
        "Principal": ("Principal", "PRINCIPAL"),
        "Saldo Akhir": ("QTY AKHIR", "Saldo Akhir", "Kuantitas in PCS"),
    }
    result = pd.DataFrame(index=frame.index)
    for output, candidates in aliases.items():
        source = next((candidate for candidate in candidates if candidate in frame), None)
        result[output] = frame[source] if source else None
    return result[PRINCIPAL_STOCK_COLUMNS].astype(object).where(pd.notna(result), None)
