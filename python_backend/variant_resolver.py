# ======================================================================================
# Tujuan: Resolusi VARIAN (mis. "Casablanca Spray Cologne Series" -> White SR + Black SR;
#         "Regazza EDT Sport" -> 4 varian Azzuro/Bianco/Nero/Rosso) via LOOKUP TABEL
#         DEKLARATIF (variant_mapping.json), BUKAN tebakan LLM. Dicoba SEBELUM fuzzy-match
#         LLM/native_kelompok apa pun -- kalau ketemu rule, hasil deterministik & final.
# Caller: python_backend/main.py (rencana integrasi FASE 3b, sebelum _apply_native_kelompok).
# Dependensi: json, re, os (stdlib saja).
# Main Functions:
#   - load_variant_mapping(path=None) -> dict          Baca variant_mapping.json.
#   - resolve_variant(group_item_text, master_items, mapping) -> List[dict] | None
#       None = tidak ada rule yg cocok -> caller HARUS jatuh ke jalur lama (fuzzy/LLM).
#       List[dict] (bisa kosong []) = rule ketemu, INI hasil final (jangan ditimpa LLM).
# Side Effects: baca file variant_mapping.json (read-only).
# ======================================================================================

import json
import os
import re
from typing import Dict, List, Optional

_DEFAULT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "variant_mapping.json")


def load_variant_mapping(path: Optional[str] = None) -> Dict[str, dict]:
    path = path or _DEFAULT_PATH
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        mapping = json.load(f)
    for key, rule in mapping.items():
        try:
            re.compile(rule["match_pattern"], re.IGNORECASE)
        except (KeyError, re.error) as e:
            raise ValueError(f"variant_mapping.json rule '{key}' tidak valid: {e}")
    return mapping


def _norm(x) -> str:
    return " ".join(str(x or "").strip().split()).upper()


def resolve_variant(group_item_text: str, master_items: List[dict],
                     mapping: Dict[str, dict]) -> Optional[List[dict]]:
    """Cocokkan group_item_text ke rule variant_mapping (urutan dict = urutan prioritas,
    rule lebih spesifik HARUS ditaruh sebelum rule fallback umum di JSON-nya).
    Return None kalau tak ada rule cocok (caller pakai jalur lama). Return list (bisa
    kosong) kalau rule cocok tapi kelompok/principle-nya tak ketemu di master manapun
    -- anti-halusinasi: list kosong TETAP final, jangan biarkan LLM menebak.
    """
    for _key, rule in mapping.items():
        if not re.search(rule["match_pattern"], group_item_text, re.IGNORECASE):
            continue

        pool = master_items
        if "resolve_to_kelompok" in rule:
            wanted = {_norm(k) for k in rule["resolve_to_kelompok"]}
            pool = [it for it in pool if _norm(it.get("kelompok")) in wanted]
        elif "kelompok" in rule:
            wanted = _norm(rule["kelompok"])
            pool = [it for it in pool if _norm(it.get("kelompok")) == wanted]

        if "exclude_kelompok" in rule:
            excluded = {_norm(k) for k in rule["exclude_kelompok"]}
            pool = [it for it in pool if _norm(it.get("kelompok")) not in excluded]

        if "principle_contains" in rule:
            needle = _norm(rule["principle_contains"])
            pool = [it for it in pool if needle in _norm(it.get("principle"))]
        if "principle_excludes" in rule:
            needle = _norm(rule["principle_excludes"])
            pool = [it for it in pool if needle not in _norm(it.get("principle"))]

        seen, out = set(), []
        for it in pool:
            kb = str(it.get("kode_barang", "")).strip()
            if kb and kb not in seen:
                seen.add(kb)
                out.append(it)
        return out

    return None


if __name__ == "__main__":
    master = [
        {"kode_barang": "W1", "kelompok": "CSBNCA FM - SPRAY COL - WHITE SR", "principle": "Casablanca Femme Spray Cologne White Series W01 (White) 100ml"},
        {"kode_barang": "W2", "kelompok": "CSBNCA FM - SPRAY COL - WHITE SR", "principle": "Casablanca Femme Spray Cologne White Series W02 (Red) 100ml"},
        {"kode_barang": "B1", "kelompok": "CSBNCA HM - SPRAY COLG - BLACK SR", "principle": "Casablanca Homme Spray Cologne Black Series (Black) 100ml"},
        {"kode_barang": "B2", "kelompok": "CSBNCA HM - SPRAY COLG - BLACK SR", "principle": "Casablanca Homme Spray Cologne Black Series (Blue) 100ml"},
        {"kode_barang": "G1", "kelompok": "CSBNCA FM - SPRAY COL - GLASS", "principle": "Casablanca Femme Spray Cologne GLASS Classic 100ml"},
        {"kode_barang": "R1", "kelompok": "REGAZZA FM - EDT", "principle": "Regazza Femme Sport Eau De Toilette (EDT) Azzuro (Blue) 100ml"},
        {"kode_barang": "R2", "kelompok": "REGAZZA FM - EDT", "principle": "Regazza Femme Sport Eau De Toilette (EDT) Bianco (White) 100ml"},
        {"kode_barang": "R3", "kelompok": "REGAZZA FM - EDT", "principle": "Regazza Femme Sport Eau De Toilette (EDT) Nero (Black) 100ml"},
        {"kode_barang": "R4", "kelompok": "REGAZZA FM - EDT", "principle": "Regazza Femme Sport Eau De Toilette (EDT) Rosso (Red) 100ml"},
        {"kode_barang": "R5", "kelompok": "REGAZZA FM - EDT", "principle": "Regazza Femme Eau De Toilette (EDT) Classy (Blue) 100ml"},
        {"kode_barang": "R6", "kelompok": "REGAZZA FM - EDT", "principle": "Regazza Femme Eau De Toilette (EDT) Feminine (Pink) 100ml"},
    ]
    mapping = load_variant_mapping()

    for _run in range(10):
        cologne = resolve_variant("Casablanca Spray Cologne Series 100ml", master, mapping)
        assert {it["kode_barang"] for it in cologne} == {"W1", "W2", "B1", "B2"}, cologne

        sport = resolve_variant("Regazza EDT Sport 100ml", master, mapping)
        assert {it["kode_barang"] for it in sport} == {"R1", "R2", "R3", "R4"}, sport

        regular = resolve_variant("Regazza Eau de Toilette 100ml", master, mapping)
        assert {it["kode_barang"] for it in regular} == {"R5", "R6"}, regular

        no_match = resolve_variant("Marie Jose Body Mist 100ml", master, mapping)
        assert no_match is None, no_match

    print("variant_resolver self-check PASSED (10x run, resolusi 100% identik)")
