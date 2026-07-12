"""Tujuan: Helper umum untuk format data, validasi kolom, dan asset dashboard offline.
Caller: Modul dashboard Fase 2-7 dan self-check terkait.
Dependensi: json, os, functools, assets/echarts.min.js.
Main Functions: safe_chart_column, fmt_rp, fmt_int, to_json, inline_echarts.
Side Effects: Membaca assets/echarts.min.js dari disk saat HTML dashboard dirender.
"""
from functools import lru_cache
import json
import os

PLACEHOLDER = {"=others=", "-", "_", ""}
ECHARTS_CDN_TAG = '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>'
APP_DIR = os.path.dirname(os.path.abspath(__file__))
ECHARTS_PATH = os.path.join(APP_DIR, "assets", "echarts.min.js")


def safe_chart_column(df, col: str) -> bool:
    """True kalau kolom ada di df DAN datanya bukan cuma placeholder / 1 nilai unik.

    Kolom seperti Kecamatan/Desa/Region sering "=Others=", Golongan/Kelompok sering "-"/"_".
    Chart dari kolom begini menyesatkan, jadi harus dicek dulu sebelum dipakai.
    """
    if col not in df.columns:
        return False
    vals = df[col].astype(str).str.strip()
    vals = vals[~vals.str.lower().isin(PLACEHOLDER)]
    return vals.nunique() > 1


def fmt_rp(n) -> str:
    sign = "-" if n < 0 else ""
    return sign + "Rp " + format(round(abs(n)), ",d").replace(",", ".")


def fmt_int(n) -> str:
    return format(round(n), ",d").replace(",", ".")


def to_json(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@lru_cache(maxsize=1)
def echarts_script_tag() -> str:
    if not os.path.exists(ECHARTS_PATH):
        raise FileNotFoundError(f"Asset ECharts offline tidak ditemukan: {ECHARTS_PATH}")
    with open(ECHARTS_PATH, "r", encoding="utf-8") as f:
        return "<script>\n" + f.read() + "\n</script>"


def inline_echarts(html: str) -> str:
    """Ganti CDN ECharts dengan asset inline agar preview/export tetap jalan offline."""
    return html.replace(ECHARTS_CDN_TAG, echarts_script_tag())
