# ======================================================================================
# Tujuan: FASE 1b -- bekukan HASIL PARSE (rows final setelah OCR+LLM+_apply_native_kelompok
#         +tier regroup) per-dokumen. FASE 1 (ocr_cache) hanya membekukan teks OCR; langkah
#         LLM JSON-parse SETELAHNYA masih stokastik -> run ke-2 dok sama bisa beda rows.
#         Modul ini menutup celah itu: run ke-2 dok identik = 0 panggilan LLM & rows IDENTIK
#         -> pipeline dok->rows sepenuhnya deterministik (fondasi 0-byte-diff e2e).
# Caller: python_backend/main.py (summary_manual_parse_pdf_ai): cek di awal (skip OCR+LLM
#         kalau hit), freeze di akhir sebelum return rows.
# Dependensi: json, os, hashlib (stdlib saja).
# Main Functions:
#   - parse_cache_key(pdf_bytes, principle_name) -> str   sha256(bytes)+principle (master beda
#       principle -> rows beda -> key beda).
#   - parse_cache_get(key) -> list | None
#   - parse_cache_put(key, rows, nama_file="", principle_name="") -> None  (freeze, idempotent:
#       kalau file sudah ada TIDAK ditimpa).
# Side Effects: baca/tulis python_backend/data/parse_cache/<key>.json.
# ======================================================================================

import hashlib
import json
import os
from typing import List, Optional

_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "parse_cache")


def parse_cache_key(pdf_bytes: bytes, principle_name: str = "") -> str:
    h = hashlib.sha256(pdf_bytes)
    h.update(b"|")
    h.update(" ".join(str(principle_name or "").strip().upper().split()).encode("utf-8"))
    return h.hexdigest()


def _path(key: str) -> str:
    return os.path.join(_CACHE_DIR, f"{key}.json")


def parse_cache_get(key: str) -> Optional[List[dict]]:
    p = _path(key)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f).get("rows")
    except Exception:
        return None


def parse_cache_put(key: str, rows: List[dict], nama_file: str = "", principle_name: str = "") -> None:
    os.makedirs(_CACHE_DIR, exist_ok=True)
    p = _path(key)
    if os.path.exists(p):
        return  # freeze: jangan timpa hasil parse pertama (determinisme)
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"nama_file": nama_file, "principle_name": principle_name,
                   "rows_count": len(rows), "rows": rows}, f, ensure_ascii=False)


if __name__ == "__main__":
    import tempfile, shutil
    _orig = _CACHE_DIR
    tmpdir = tempfile.mkdtemp(prefix="parsecache_test_")
    _CACHE_DIR = tmpdir
    try:
        b = b"%PDF-1.4 fake bytes"
        rows = [{"kode_barangs": "P1", "ketentuan": "Beli 7"}]
        k = parse_cache_key(b, "Priskila")
        assert parse_cache_get(k) is None, "belum ada -> None"
        parse_cache_put(k, rows, "TP.pdf", "Priskila")
        assert parse_cache_get(k) == rows, "hit -> rows identik"

        # freeze: put lagi dgn rows beda TIDAK menimpa
        parse_cache_put(k, [{"kode_barangs": "X9"}], "TP.pdf", "Priskila")
        assert parse_cache_get(k) == rows, "freeze: hasil pertama tak boleh tertimpa"

        # principle beda -> key beda -> miss
        k2 = parse_cache_key(b, "Casablanca")
        assert parse_cache_get(k2) is None, "principle beda = key beda = miss"
        print("parse_cache self-check PASSED (miss->put->hit, freeze, principle memisah key)")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        _CACHE_DIR = _orig
