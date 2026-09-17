# ======================================================================================
# Tujuan: Mapping channel per-principle (fail-closed). OCR/parse model bisa membaca nama
#         channel dgn ejaan/format beda ("MTI" vs "MODERN TRADE INDEPENDENT LOKAL (MTI)",
#         "GROSIR" vs "Grosir"), padahal channel dipakai HITUNG PROGRAM PER CHANNEL ->
#         harus dibakukan. Tiap principle punya daftar alias->nama baku sendiri. Kalau saat
#         parse muncul channel yg TIDAK ada di mapping principle -> caller WAJIB berhenti &
#         tanya user (jangan menebak), sesuai keputusan user 2026-07-21.
# Caller: routers/summary.py (summary_manual_parse_pdf_ai) via _channel_gate.
# Dependensi: json, os (stdlib saja).
# Storage: python_backend/data/channel_map/<PRINCIPLE_SLUG>.json  -> {alias: nama_baku}.
#          Principle TANPA file mapping = fitur OFF utk principle itu (perilaku lama, tanpa
#          normalisasi & tanpa halt) -> rollout aman per-principle.
# Main Functions:
#   - load(principle_name) -> {normalized_alias: baku} | None (None = principle belum dipetakan)
#   - canonicalize_rows(rows, cmap) -> set(channel tak dikenal); yg dikenal diubah in-place
# ======================================================================================

import json
import os

_MAP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "channel_map")


def _norm(s) -> str:
    """Samakan utk pencocokan: uppercase + rapatkan spasi. Menyerap beda kapitalisasi
    ('GROSIR'=='Grosir') tanpa perlu 2 entri terpisah di file mapping."""
    return " ".join(str(s or "").strip().upper().split())


def principle_slug(principle_name: str) -> str:
    """Nama file mapping dari principle_name (aman utk filesystem)."""
    return "".join(c if c.isalnum() else "_" for c in _norm(principle_name)).strip("_")


def _path(principle_name: str) -> str:
    return os.path.join(_MAP_DIR, f"{principle_slug(principle_name)}.json")


def load(principle_name: str):
    """{normalized_alias: nama_baku} utk principle ini, atau None kalau belum ada file
    mapping (fitur OFF utk principle itu)."""
    p = _path(principle_name)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return None
    if not isinstance(raw, dict) or not raw:
        return None
    return {_norm(k): str(v) for k, v in raw.items()}


def canonicalize_rows(rows, cmap) -> set:
    """Ubah 'channel_gtmt' tiap row jadi nama baku sesuai cmap (in-place). Kembalikan set
    nilai channel yg TIDAK ada di cmap -> fail-closed: caller HARUS berhenti & tanya user.
    Channel kosong dilewati (bukan urusan mapping; guard lain yg menangani)."""
    unknown = set()
    for r in rows:
        raw = r.get("channel_gtmt", "")
        if not str(raw).strip():
            continue
        canon = cmap.get(_norm(raw))
        if canon is None:
            unknown.add(str(raw).strip())
        else:
            r["channel_gtmt"] = canon
    return unknown


if __name__ == "__main__":
    # Self-check offline (tanpa API): pakai data nyata Priskila 2026-07-21.
    import tempfile, shutil
    _orig = _MAP_DIR
    tmp = tempfile.mkdtemp(prefix="chanmap_test_")
    try:
        _MAP_DIR = tmp
        prin = "PT. PRISKILA PRIMA MAKMUR"
        with open(_path(prin), "w", encoding="utf-8") as f:
            json.dump({"RETAIL": "RETAIL", "MTI": "MTI",
                       "MODERN TRADE INDEPENDENT LOKAL (MTI)": "MTI",
                       "GROSIR": "Grosir", "STAR OUTLET": "STAR OUTLET"}, f)
        cmap = load(prin)
        assert cmap is not None, "file ada -> harus kebaca"

        # gemini (bentuk baku) & qwen (alias verbose/caps) sama-sama resolve, 0 unknown
        rows = [{"channel_gtmt": c} for c in
                ["RETAIL", "MTI", "Grosir", "STAR OUTLET",              # gemini
                 "MODERN TRADE INDEPENDENT LOKAL (MTI)", "GROSIR"]]     # qwen
        unk = canonicalize_rows(rows, cmap)
        assert unk == set(), f"harusnya 0 unknown, dapat {unk}"
        assert [r["channel_gtmt"] for r in rows] == \
            ["RETAIL", "MTI", "Grosir", "STAR OUTLET", "MTI", "Grosir"], rows

        # channel di luar mapping -> masuk set unknown (fail-closed), row TIDAK diubah
        bad = [{"channel_gtmt": "National MT1"}]
        assert canonicalize_rows(bad, cmap) == {"National MT1"}
        assert bad[0]["channel_gtmt"] == "National MT1", "unknown tak boleh diubah diam2"

        # principle tanpa file -> None (fitur off)
        assert load("PRINCIPLE TANPA MAPPING") is None
        print("channel_map self-check PASSED (alias+caps resolve, unknown fail-closed, off-when-absent)")
    finally:
        _MAP_DIR = _orig
        shutil.rmtree(tmp, ignore_errors=True)
