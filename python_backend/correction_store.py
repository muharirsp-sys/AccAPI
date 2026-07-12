# ======================================================================================
# Tujuan: Simpan koreksi manusia (tombol Laporkan Salah) dengan STABLE KEY
#         (kode_barang, channel, no_surat) -- BUKAN index/nomor baris (yg bisa bergeser
#         antar run OCR). Koreksi di-APPLY sbg OVERRIDE deterministik ke output final
#         (bukan sekadar hint prompt LLM spt mekanisme lama parse_corrections.jsonl).
# Caller: python_backend/main.py (rencana integrasi FASE 4b, dipanggil sblm return final
#         di summary_manual_generate -- override field yg dikoreksi manusia).
# Dependensi: json, os, datetime (stdlib saja).
# Main Functions:
#   - correction_key(kode_barang, channel, no_surat) -> str
#   - save_correction(kode_barang, channel, no_surat, field, wrong_value, correct_value,
#                      corrected_by="user", note="") -> None
#   - load_corrections() -> Dict[str, List[dict]]   key -> list of correction record
#   - apply_corrections(rows, corrections) -> (rows_baru, applied_log)
#       rows: list of dict per-SKU (wajib py 'kode_barang','channel'/'promo_group','
#       no_surat'/'surat_program'). Override in-place field yg cocok, catat di applied_log
#       (transparansi: mana yg murni deterministik vs override manusia).
# Side Effects: baca/tulis python_backend/data/correction_store.jsonl (persisten, append-only).
# ======================================================================================

import json
import os
from datetime import datetime
from typing import Dict, List, Tuple

_STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "correction_store.jsonl")


def correction_key(kode_barang: str, channel: str, no_surat: str) -> str:
    def _n(x):
        return " ".join(str(x or "").strip().split()).upper()
    return f"{_n(kode_barang)}|{_n(channel)}|{_n(no_surat)}"


def save_correction(kode_barang: str, channel: str, no_surat: str, field: str,
                     wrong_value, correct_value, corrected_by: str = "user", note: str = "") -> None:
    os.makedirs(os.path.dirname(_STORE_PATH), exist_ok=True)
    record = {
        "key": correction_key(kode_barang, channel, no_surat),
        "kode_barang": kode_barang,
        "channel": channel,
        "no_surat": no_surat,
        "field_corrected": field,
        "wrong_value": wrong_value,
        "correct_value": correct_value,
        "corrected_by": corrected_by,
        "corrected_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "note": note,
    }
    with open(_STORE_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_corrections() -> Dict[str, List[dict]]:
    if not os.path.exists(_STORE_PATH):
        return {}
    out: Dict[str, List[dict]] = {}
    with open(_STORE_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            out.setdefault(rec.get("key", ""), []).append(rec)
    return out


def apply_corrections(rows: List[dict], corrections: Dict[str, List[dict]]) -> Tuple[List[dict], List[dict]]:
    """Override field di 'rows' berdasarkan stable key. TIDAK pernah pakai posisi/index
    baris -- kalau urutan baris berubah antar run (OCR beda), koreksi tetap ke item yg
    benar selama (kode_barang, channel, no_surat) sama."""
    applied_log: List[dict] = []
    for row in rows:
        kode = row.get("kode_barang") or row.get("KODE_BARANG", "")
        channel = row.get("channel") or row.get("channel_gtmt") or row.get("PROMO_GROUP", "")
        no_surat = row.get("no_surat") or row.get("surat_program") or row.get("PROMO_LABEL", "")
        key = correction_key(kode, channel, no_surat)
        for rec in corrections.get(key, []):
            field = rec["field_corrected"]
            if field in row:
                applied_log.append({
                    "key": key, "field": field,
                    "from": row[field], "to": rec["correct_value"],
                    "corrected_by": rec.get("corrected_by"), "corrected_at": rec.get("corrected_at"),
                })
                row[field] = rec["correct_value"]
    return rows, applied_log


if __name__ == "__main__":
    import tempfile, shutil
    _orig = _STORE_PATH
    tmpdir = tempfile.mkdtemp(prefix="corrstore_test_")
    _STORE_PATH = os.path.join(tmpdir, "correction_store.jsonl")
    try:
        save_correction("P123", "RETAIL", "002/PPM/NSPM/III/2026", "TRIGGER_QTY", 7, 4,
                         note="Bellagio Pomade seharusnya Beli 4 bukan Beli 7")
        corrections = load_corrections()
        assert len(corrections) == 1, corrections

        rows_shuffled = [
            {"kode_barang": "P999", "channel": "RETAIL", "surat_program": "002/PPM/NSPM/III/2026", "TRIGGER_QTY": 4},
            {"kode_barang": "P123", "channel": "RETAIL", "surat_program": "002/PPM/NSPM/III/2026", "TRIGGER_QTY": 7},
            {"kode_barang": "P123", "channel": "GROSIR", "surat_program": "002/PPM/NSPM/III/2026", "TRIGGER_QTY": 7},
        ]
        rows_out, log = apply_corrections(rows_shuffled, corrections)
        assert rows_out[0]["TRIGGER_QTY"] == 4, "item lain (P999) tidak boleh ikut ter-override"
        assert rows_out[1]["TRIGGER_QTY"] == 4, "P123/RETAIL harusnya ter-override jadi 4"
        assert rows_out[2]["TRIGGER_QTY"] == 7, "P123/GROSIR beda channel, TIDAK boleh ikut ter-override"
        assert len(log) == 1 and log[0]["field"] == "TRIGGER_QTY"
        print("correction_store self-check PASSED (stable key, urutan diacak, override tepat sasaran)")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
