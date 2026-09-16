"""
test_urc_matcher.py

Offline unit tests for urc_matcher.py, asserting against the 22 real SKU
lines from the two URC letters read this session (BTGO Lexus 76g,
Diskon 25% Munchy's Medium Pack).
"""

import os
import openpyxl
import urc_matcher as um

_MASTER_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..",
    "master_barang_principle", "MASTER BARANG URC.xlsx",
)


def _load_master():
    """Mirrors shared.py::_parse_master_barang_xlsx's row shape exactly
    (kelompok = KLP + Sub KLP + Sub KLP2 joined, variant = Nama Aroma/Rasa)
    -- that is the shape urc_matcher actually receives in production via
    _apply_native_kelompok, NOT raw klp/aroma column names."""
    wb = openpyxl.load_workbook(_MASTER_PATH, data_only=True)
    ws = wb["Sheet1"]
    master = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        klp, sub1, sub2 = (r[5] or "").strip(), (r[7] or "").strip(), (r[9] or "").strip()
        kelompok = " - ".join(x for x in (klp, sub1, sub2) if x)
        master.append({
            "kode_barang": (r[1] or "").strip(),
            "nama_barang": (r[2] or "").strip(),
            "kelompok": kelompok,
            "variant": (r[11] or "").strip(),
            "gramasi": (r[13] or "").strip(),
        })
    return master


MASTER = _load_master()
RULES = um.load_rules()


def _resolve(text):
    return um.resolve_surat_line(text, MASTER, RULES)


def test_lexus_chocolate_76g_does_not_leak_other_gramasi():
    res = _resolve("Lexus Chocolate 76gx24PC")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert all("76GR" in n.upper() for n in names), names
    assert all("CHOCOLATE" in n.upper() for n in names), names


def test_lexus_chocolate_190g_does_not_leak_other_gramasi():
    res = _resolve("Lexus Chocolate 190gx12PC")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert all("190GR" in n.upper() for n in names), names


def test_lexus_peanut_190g():
    res = _resolve("Lexus Peanut 190gx12PC")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert all("PEANUT BUTTER" in n.upper() and "190GR" in n.upper() for n in names), names


def test_lexus_cookies_variants():
    for text, flavor in [
        ("Lexus Cookies Mixed Nut 189gx12PC", "MIXED NUTS"),
        ("Lexus Cookies Dark Chocolate 189gx12PC", "DARK CHOCOLATE"),
        ("Lexus Cookies Original 189gx12PC", "ORIGINAL"),
    ]:
        res = _resolve(text)
        assert not res["unmatched"], text
        names = {r["nama_barang"] for r in res["rows"]}
        assert all(flavor in n.upper() for n in names), (text, names)


def test_lexus_choco_coated_200g():
    res = _resolve("Lexus Choco Coated 200gx12PC")
    assert not res["unmatched"]


def test_lexus_lemon_lychee_190g():
    for text, flavor in [
        ("Lexus Lemon 190gx12PC", "LEMON CREAM"),
        ("Lexus Lychee 190gx12PC", "LYCHEE CREAM"),
    ]:
        res = _resolve(text)
        assert not res["unmatched"], text
        names = {r["nama_barang"] for r in res["rows"]}
        assert all(flavor in n.upper() for n in names), (text, names)


def test_oat_krunch_spelling_synonym_and_no_false_positive():
    """Regression for the baseline bug: naive token-overlap silently matched
    this to Dark Chocolate because both share the token OAT. The real
    matcher must resolve it to the STRAWBERRY/BLACKCURRANT flavor (via the
    abbreviation token_map) and must NOT fall back to Dark Chocolate."""
    res = _resolve("Oat Krunch Strawberry & Blackcurrant 208gx12PC")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert all("STRWBRY" in n.upper() for n in names), names
    assert not any("DARK CHOCOLATE" in n.upper() for n in names), names


def test_oat_krunch_hazelnut_and_nutty_chocolate():
    for text, flavor in [
        ("Oat Krunch Hazelnut 208gx12PC", "CHUNKY HAZELNUT"),
        ("Oat Krunch Nutty Chocolate 208gx12PC", "NUTTY CHOCOLATE"),
    ]:
        res = _resolve(text)
        assert not res["unmatched"], text
        names = {r["nama_barang"] for r in res["rows"]}
        assert all(flavor in n.upper() for n in names), (text, names)


def test_munchys_cracker_variants():
    for text, flavor in [
        ("Munchy's Original Cream Cracker 375gx12PC", "ORIGINAL"),
        ("Munchy's Sugar Cracker 380gx12PC", "SUGAR CRACKERS"),
        ("Munchy's Wheat Cracker 276gx12PC", "WHEAT CRACKER"),
        ("Munchy's Cream Cracker 300gx12PC", "CREAM CRACKER"),
        ("Munchy's Choc Sandwich 258gx12PC", "CHOC SANDWICH"),
    ]:
        res = _resolve(text)
        assert not res["unmatched"], text
        names = {r["nama_barang"] for r in res["rows"]}
        assert all(flavor in n.upper() for n in names), (text, names)


def test_munchys_vegetable_cracker_abbreviation_synonym():
    """Regression: master abbreviates 'Vegetable' as 'VEGE'."""
    res = _resolve("Munchy's Vegetable Cracker 380gx12PC")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert all("VEGE" in n.upper() for n in names), names


def test_topmix_gramasi_mismatch_fallback():
    """Regression: surat says 295g, master's only Topmix SKU is 259G --
    confirmed by the user as the same product, not a data error."""
    res = _resolve("Topmix Assorted 295gx12PC")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert all("TOP MIX" in n.upper() and "259G" in n.upper() for n in names), names


def test_lexus_cheese_76g_merges_ccheese_and_cream_cheese_skus():
    """C.CHEESE and CREAM CHEESE are the same product under two SKU codes
    (user-confirmed) -- must merge into one group with BOTH SKUs, not tie."""
    res = _resolve("Lexus Cheese 76gx24PC")
    assert not res["unmatched"]
    codes = {r["kode_barang"] for r in res["rows"]}
    assert len(codes) == 2, codes  # LX18 (C.CHEESE) + LX09 (CREAM CHEESE)
    names = {r["nama_barang"] for r in res["rows"]}
    assert any("C.CHEESE" in n.upper() for n in names), names
    assert any("CREAM CHEESE" in n.upper() for n in names), names


def test_lexus_cheese_190g_merges_ccheese_and_cream_cheese_skus():
    res = _resolve("Lexus Cheese 190gx12PC")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert any("C.CHEESE" in n.upper() for n in names), names
    assert any("CREAM CHEESE" in n.upper() for n in names), names


def test_oat_krunch_bare_chocolate_defaults_to_dark_chocolate():
    """'Chocolate' alone (user-confirmed) means DARK CHOCOLATE, not the
    also-present NUTTY CHOCOLATE flavor."""
    res = _resolve("Oat Krunch Chocolate 208gx12PC")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert all("DARK CHOCOLATE" in n.upper() for n in names), names
    assert not any("NUTTY" in n.upper() for n in names), names


def test_oat_krunch_bare_chocolate_defaults_to_dark_chocolate_unitless_pack_suffix():
    """Regression: live OCR of this exact letter rendered the pack suffix
    as "208g x 12" (no PC/PCS unit word) instead of "208gx12PC". Without a
    unit word, stray "X"/"12" tokens used to leak into the token set and
    silently break the aroma_default tie-break's exact-match check,
    UNMATCHING a line the clean-format test above already proves resolvable."""
    res = _resolve("Oat Krunch Chocolate 208g x 12")
    assert not res["unmatched"]
    names = {r["nama_barang"] for r in res["rows"]}
    assert all("DARK CHOCOLATE" in n.upper() for n in names), names


if __name__ == "__main__":
    import sys
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
