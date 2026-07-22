# ======================================================================================
# Tujuan: Cache hasil OCR surat program per-konten (SHA-256 byte file PDF). Surat yang
#         SAMA (byte-identik) tidak pernah di-OCR dua kali -> jadi fondasi determinisme:
#         run ke-2 mengambil teks OCR beku dari cache, TIDAK memanggil Gemini lagi.
# Caller: python_backend/main.py -> summary_manual_parse_pdf_ai (fase OCR).
# Dependensi: hashlib, json, os, datetime (stdlib saja).
# Main Functions:
#   - ocr_cache_key(pdf_bytes)   -> str (sha256 hex)
#   - ocr_cache_get(doc_hash)    -> dict | None (hasil OCR beku + metadata, None jika miss)
#   - ocr_cache_put(doc_hash, nama_file_asli, ocr_text, pages_total, pages_processed)
# Side Effects: baca/tulis file JSON di python_backend/data/ocr_cache/{hash}.json (persisten).
# ======================================================================================

import hashlib
import json
import os
from datetime import datetime
from typing import Optional

_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ocr_cache")


def _ensure_dir() -> None:
    os.makedirs(_CACHE_DIR, exist_ok=True)


def ocr_cache_key(pdf_bytes: bytes) -> str:
    """SHA-256 hex dari byte file surat PDF -- identitas konten, bukan nama file."""
    return hashlib.sha256(pdf_bytes).hexdigest()


def _path_for(doc_hash: str) -> str:
    return os.path.join(_CACHE_DIR, f"{doc_hash}.json")


def ocr_cache_get(doc_hash: str) -> Optional[dict]:
    """Kembalikan hasil OCR beku untuk hash ini, atau None kalau belum pernah di-OCR."""
    path = _path_for(doc_hash)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or "ocr_text" not in data:
            return None  # korup -> anggap miss (aman, akan di-OCR ulang)
        return data
    except Exception:
        return None


def ocr_cache_put(doc_hash: str, nama_file_asli: str, ocr_text: str,
                  pages_total: int = 0, pages_processed: int = 0) -> None:
    """Simpan hasil OCR pertama + metadata. Idempotent: kalau sudah ada, JANGAN timpa
    (freeze -- teks OCR pertama dianggap kebenaran, konsisten untuk run berikutnya)."""
    _ensure_dir()
    path = _path_for(doc_hash)
    if os.path.exists(path):
        return  # sudah beku, jangan overwrite
    payload = {
        "hash": doc_hash,
        "nama_file_asli": nama_file_asli or "",
        "tanggal_ocr_pertama": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "pages_total": pages_total,
        "pages_processed": pages_processed,
        "ocr_text": ocr_text,
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)  # atomik -- hindari file setengah tertulis kalau proses mati


if __name__ == "__main__":
    # Self-check: hash stabil, put lalu get identik, put kedua tidak overwrite (freeze).
    import tempfile, shutil
    _CACHE_DIR = tempfile.mkdtemp(prefix="ocrcache_test_")
    try:
        b = b"contoh isi pdf surat program"
        h = ocr_cache_key(b)
        assert h == ocr_cache_key(b), "hash tidak stabil"
        assert ocr_cache_get(h) is None, "harusnya miss di awal"
        ocr_cache_put(h, "surat.pdf", "TEKS OCR HALAMAN 1", pages_total=3, pages_processed=3)
        got = ocr_cache_get(h)
        assert got and got["ocr_text"] == "TEKS OCR HALAMAN 1", "get tidak balik teks yg sama"
        ocr_cache_put(h, "surat.pdf", "TEKS BERBEDA", pages_total=3, pages_processed=3)
        assert ocr_cache_get(h)["ocr_text"] == "TEKS OCR HALAMAN 1", "freeze gagal: cache tertimpa"
        print("ocr_cache self-check PASSED")
    finally:
        shutil.rmtree(_CACHE_DIR, ignore_errors=True)
