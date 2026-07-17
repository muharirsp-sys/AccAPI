"""Golden regression for the Priskila deterministic matcher.

`data/golden_priskila_expected.json` is the frozen expected resolution of EVERY
surat line (118 lines) for principle Priskila, derived independently from the
surat OCR + master + human decisions (2026-07-15). This test asserts the matcher
reproduces it exactly, and that each of the user's line-level corrections holds.
Regenerate golden with `python build_golden.py` only after a deliberate,
human-verified change.
"""
import json
import priskila_matcher as pm

GOLDEN = "data/golden_priskila_expected.json"


def _load_golden():
    return json.load(open(GOLDEN, encoding="utf-8"))


def _load_master():
    d = json.load(open("data/manual_cache/master_cache.json", encoding="utf-8"))

    def fi(o):
        if isinstance(o, dict):
            if isinstance(o.get("items"), list):
                return o["items"]
            for v in o.values():
                r = fi(v)
                if r:
                    return r
        return None

    return fi(d) or []


def test_matcher_reproduces_golden():
    """Determinism/regression: re-resolving each golden line yields the same SKUs."""
    golden = _load_golden()
    master = _load_master()
    rules = pm.load_rules()
    assert golden, "golden empty"
    for row in golden:
        res = pm.resolve_surat_line("", row["group_item_text"], master, rules)
        got = sorted(it["kode_barang"] for it in res["sku_list"])
        assert got == row["kode_barangs"], (row["channel"], row["group_item_text"], got, row["kode_barangs"])


def test_no_unmatched():
    golden = _load_golden()
    assert all(row["kode_barangs"] for row in golden), \
        [r["group_item_text"] for r in golden if not r["kode_barangs"]]


def _kels(golden, channel):
    out = set()
    for r in golden:
        if r["channel"] == channel:
            out |= {k.upper() for k in r["kelompoks"]}
    return out


def test_user_corrections_present():
    """Under-includes the user reported must now appear."""
    g = _load_golden()
    assert any("PMD WTR BAS" in k for k in _kels(g, "RETAIL"))          # Bellagio Pomade Water Based
    assert any("PMD OIL BASED" in k for k in _kels(g, "RETAIL"))        # Casablanca HM Pomade Oil Based
    assert any("B.PARFUME" in k or "B. MIST - B.PARFUME" in k for k in _kels(g, "RETAIL"))  # Regazza Fragrance Mist
    assert any("EDP - PRESTIGE" in k for k in _kels(g, "MTI"))          # Bellagio EDP Prestige (MTI)
    assert any(k == "CAMELLIA - B. MIST" for k in _kels(g, "MTI"))      # Camellia regular Body Mist (MTI)
    assert any("PMD OIL BASED" in k for k in _kels(g, "GROSIR"))        # decision 1a: GROSIR HM Pomade Oil Based


def test_user_corrections_absent():
    """Over-includes / dropped items the user reported must NOT appear."""
    g = _load_golden()
    assert not any("REGAZZA FM - EDP" == k for k in _kels(g, "MTI"))    # MTI Regazza EDP 50ml over-include
    assert not any("SANITIZER" in k for k in _kels(g, "GROSIR"))        # GROSIR Camellia sanitizer
    assert not any("SPORT EDT" in k for k in _kels(g, "GROSIR"))        # decision 1b: GROSIR Blagio Sport EDT
    assert not any("EDP - DE LUXE" in k for k in _kels(g, "GROSIR"))    # GROSIR Regazza EDP De Luxe
    assert not any(k == "CSBNCA FM - B. MIST" for k in _kels(g, "GROSIR"))  # GROSIR Casablanca FM Body Mist
