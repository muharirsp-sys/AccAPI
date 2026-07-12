# ======================================================================================
# Tujuan: FASE 5 -- "golden snapshot" determinisme. Untuk INPUT baris yg identik (dokumen
#         + approval sama), OUTPUT (isi Dataset) WAJIB identik antar-run. Modul ini membekukan
#         tanda-tangan output pertama kali (freeze), lalu tiap run berikutnya membandingkan:
#           new   = belum pernah dilihat -> dibekukan sekarang
#           match = identik dgn golden -> pipeline terbukti deterministik utk input ini
#           DRIFT = input SAMA tapi output BEDA -> regresi non-determinisme (BUG, jangan
#                   ditimpa diam2; laporkan supaya manusia sadar & approve refresh manual)
# Caller: python_backend/main.py (summary_manual_generate) -- lihat SYSTEM_MAP.md FASE 5.
# Dependensi: json, os, hashlib, datetime (stdlib saja).
# Main Functions:
#   - canonical_signature(obj, sort_rows=False) -> str   SHA-256 stabil atas struktur JSON.
#       sort_rows=True  -> urutan list DIABAIKAN (utk KEY identitas input: "dok sama?").
#       sort_rows=False -> urutan list DIPERTAHANKAN (utk SIG output: drift urutan = drift).
#   - golden_check_and_freeze(input_key, output_sig, meta=None) -> dict
#       {"status": "new"|"match"|"drift", "golden_sig": <sig beku>, ...}. Freeze idempotent
#       (status "new" hanya sekali; "drift" TIDAK menimpa golden -- butuh approve manual).
#   - approve_golden(input_key, output_sig, meta=None) -> None   Timpa golden secara EKSPLISIT
#       (dipanggil hanya kalau manusia setuju output baru jadi golden yg baru).
# Side Effects: baca/tulis python_backend/data/golden_snapshots.jsonl (append-only, freeze).
# ======================================================================================

import hashlib
import json
import os
from datetime import datetime
from typing import Optional

_STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "golden_snapshots.jsonl")


def _canon(obj, sort_rows: bool):
    """Normalisasi rekursif -> struktur yg json.dumps-nya stabil (kunci dict terurut).
    List di-sort HANYA kalau sort_rows (dipakai utk key identitas input, bukan output)."""
    if isinstance(obj, dict):
        return {k: _canon(obj[k], sort_rows) for k in sorted(obj.keys())}
    if isinstance(obj, list):
        items = [_canon(x, sort_rows) for x in obj]
        if sort_rows:
            items = sorted(items, key=lambda x: json.dumps(x, sort_keys=True, ensure_ascii=False))
        return items
    return obj


def canonical_signature(obj, sort_rows: bool = False) -> str:
    payload = json.dumps(_canon(obj, sort_rows), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _load_golden(input_key: str) -> Optional[dict]:
    """Golden TERAKHIR utk key ini (append-only -> baris terakhir menang, mendukung approve refresh)."""
    if not os.path.exists(_STORE_PATH):
        return None
    found = None
    with open(_STORE_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("input_key") == input_key:
                found = rec
    return found


def _append(rec: dict) -> None:
    os.makedirs(os.path.dirname(_STORE_PATH), exist_ok=True)
    with open(_STORE_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def golden_check_and_freeze(input_key: str, output_sig: str, meta: Optional[dict] = None) -> dict:
    golden = _load_golden(input_key)
    if golden is None:
        _append({
            "input_key": input_key, "output_sig": output_sig,
            "frozen_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "kind": "freeze", "meta": meta or {},
        })
        return {"status": "new", "golden_sig": output_sig}
    if golden.get("output_sig") == output_sig:
        return {"status": "match", "golden_sig": golden.get("output_sig")}
    # input sama, output beda -> non-determinisme. JANGAN timpa golden diam-diam.
    return {"status": "drift", "golden_sig": golden.get("output_sig"), "current_sig": output_sig}


def approve_golden(input_key: str, output_sig: str, meta: Optional[dict] = None) -> None:
    """Refresh golden secara EKSPLISIT (persetujuan manusia bhw output baru = golden baru)."""
    _append({
        "input_key": input_key, "output_sig": output_sig,
        "frozen_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "kind": "approve_refresh", "meta": meta or {},
    })


if __name__ == "__main__":
    import tempfile, shutil
    _orig = _STORE_PATH
    tmpdir = tempfile.mkdtemp(prefix="golden_test_")
    _STORE_PATH = os.path.join(tmpdir, "golden_snapshots.jsonl")
    try:
        rows = [
            {"kode_barang": "P1", "channel": "RETAIL", "trig_qty": 7},
            {"kode_barang": "P2", "channel": "RETAIL", "trig_qty": 7},
        ]
        # KEY identitas input: urutan baris tak boleh mengubah key (dok yg sama).
        k1 = canonical_signature(rows, sort_rows=True)
        k2 = canonical_signature(list(reversed(rows)), sort_rows=True)
        assert k1 == k2, "urutan baris berbeda TIDAK boleh mengubah key identitas input"

        # SIG output: urutan berbeda HARUS terdeteksi (drift urutan = drift).
        s1 = canonical_signature(rows, sort_rows=False)
        s2 = canonical_signature(list(reversed(rows)), sort_rows=False)
        assert s1 != s2, "sig output harus sensitif thd urutan"

        # run 1 -> new (freeze)
        r1 = golden_check_and_freeze(k1, s1, {"doc": "TP MARET"})
        assert r1["status"] == "new", r1

        # run 2 identik -> match (deterministik terbukti)
        r2 = golden_check_and_freeze(k1, s1)
        assert r2["status"] == "match", r2

        # run 3 output beda utk input sama -> DRIFT, golden TIDAK tertimpa
        r3 = golden_check_and_freeze(k1, "sig_yang_berbeda_deadbeef")
        assert r3["status"] == "drift" and r3["golden_sig"] == s1, r3
        r3b = golden_check_and_freeze(k1, s1)
        assert r3b["status"] == "match", "golden tidak boleh tertimpa oleh drift"

        # approve refresh eksplisit -> golden baru menang
        approve_golden(k1, "sig_baru_disetujui")
        r4 = golden_check_and_freeze(k1, "sig_baru_disetujui")
        assert r4["status"] == "match", r4
        print("golden_store self-check PASSED (freeze, match, drift-tanpa-timpa, approve-refresh)")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        _STORE_PATH = _orig
