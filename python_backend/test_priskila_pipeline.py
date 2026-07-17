"""Offline integration test for the Priskila pipeline (Tasks 8-10).

Feeds the SAME surat-structured lines that ``build_golden.py`` parses out of
``data/debug_ai.txt`` through ``apply_priskila_matching`` (the integration glue
that resolves + merges), then asserts against the frozen golden:

  * every golden SKU appears in exactly one merged output row for its
    (channel, tier, brand-prefix) -- NO SKU is dropped by the merge, and
  * the 11 line-level correction invariants still hold at merged-row level.
"""
import json
import re

import priskila_matcher as pm
from priskila_pipeline import apply_priskila_matching

GOLDEN = "data/golden_priskila_expected.json"


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


def _parse_surat_rows():
    """Stable surat lines (channel, brand, item, paket) from the FROZEN golden
    fixture. Reads `group_item_text` straight from the golden JSON rather than
    parsing `data/debug_ai.txt` -- that debug dump is transient (any live parse
    of a different surat overwrites it), so coupling the test to it made the
    suite fail spuriously after an April/Mei/Juni run. Brand is left blank; the
    matcher derives it from the item text."""
    golden = json.load(open(GOLDEN, encoding="utf-8"))
    return [(g["channel"], "", g["group_item_text"], g["paket"]) for g in golden]


def _pipeline_rows():
    master = _load_master()
    surat = _parse_surat_rows()
    rows = [
        {
            "channel_gtmt": ch,
            "brand": br,
            "group_item_text": item,
            "paket": paket,
            "principle": "PT. PRISKILA PRIMA MAKMUR",
        }
        for (ch, br, item, paket) in surat
    ]
    return apply_priskila_matching(rows, master), master


def _prefix_of(kelompok):
    k = str(kelompok or "").strip()
    return k.split(" - ")[0].strip() if " - " in k else k


def _brand_base(kelompok):
    """Brand base ignoring the HM/FM gender code, e.g.
    'CSBNCA HM - DEO ANTI P ROLL ON' -> 'CSBNCA'. A single surat line can
    resolve to BOTH genders, which the pipeline (like the renderer) splits into
    separate HM/FM prefix rows, so coverage is checked at the brand base."""
    return re.sub(r"\s+(HM|FM)$", "", _prefix_of(kelompok)).strip()


def test_pipeline_parses_lines():
    rows = _parse_surat_rows()
    assert len(rows) >= 100, len(rows)


def test_no_golden_sku_dropped():
    """Every golden SKU must land in a merged row whose (channel, tier,
    brand-prefix) matches the golden entry -- and land exactly once."""
    out, _ = _pipeline_rows()
    golden = json.load(open(GOLDEN, encoding="utf-8"))

    # index merged output: (channel, tier, prefix) -> set(kode_barang)
    idx = {}
    for r in out:
        if r.get("_priskila_unmatched"):
            continue
        base = _brand_base((r.get("kelompok", "") or "").split(" & ")[0])
        key = (r["channel_gtmt"], r["ketentuan"].split(" Boleh")[0], base)
        codes = [c.strip() for c in str(r.get("kode_barangs", "")).split(",") if c.strip()]
        idx.setdefault(key, set()).update(codes)

    missing = []
    for g in golden:
        base = _brand_base(g["kelompoks"][0]) if g["kelompoks"] else ""
        key = (g["channel"], g["tier"], base)
        have = idx.get(key, set())
        for kb in g["kode_barangs"]:
            if kb not in have:
                missing.append((g["channel"], g["tier"], g["group_item_text"], kb))
    assert not missing, missing


def test_channel_distinct_sku_totals_match_golden():
    """Distinct SKUs per channel in merged output == distinct SKUs per channel
    in golden (no leak, no loss)."""
    out, _ = _pipeline_rows()
    golden = json.load(open(GOLDEN, encoding="utf-8"))

    def by_channel(pairs):
        d = {}
        for ch, codes in pairs:
            d.setdefault(ch, set()).update(codes)
        return d

    got = by_channel(
        (r["channel_gtmt"], [c.strip() for c in str(r.get("kode_barangs", "")).split(",") if c.strip()])
        for r in out if not r.get("_priskila_unmatched")
    )
    exp = by_channel((g["channel"], g["kode_barangs"]) for g in golden)

    for ch in exp:
        assert got.get(ch, set()) == exp[ch], (
            ch,
            "missing", sorted(exp[ch] - got.get(ch, set())),
            "extra", sorted(got.get(ch, set()) - exp[ch]),
        )


# --- 11 correction invariants at merged-row level (mirror test_priskila_golden) ---

def _kels_for_channel(out, channel):
    s = set()
    for r in out:
        if r["channel_gtmt"] == channel:
            for k in str(r.get("kelompok", "")).split(" & "):
                if k.strip():
                    s.add(k.strip().upper())
    return s


def test_invariants_present():
    out, _ = _pipeline_rows()
    assert any("PMD WTR BAS" in k for k in _kels_for_channel(out, "RETAIL"))
    assert any("PMD OIL BASED" in k for k in _kels_for_channel(out, "RETAIL"))
    assert any("B.PARFUME" in k or "B. MIST" in k for k in _kels_for_channel(out, "RETAIL"))
    assert any("EDP - PRESTIGE" in k for k in _kels_for_channel(out, "MTI"))
    assert any(k == "CAMELLIA - B. MIST" for k in _kels_for_channel(out, "MTI"))
    assert any("PMD OIL BASED" in k for k in _kels_for_channel(out, "GROSIR"))  # decision 1a


def test_invariants_absent():
    out, _ = _pipeline_rows()
    assert not any(k == "REGAZZA FM - EDP" for k in _kels_for_channel(out, "MTI"))
    assert not any("SANITIZER" in k for k in _kels_for_channel(out, "GROSIR"))
    assert not any("SPORT EDT" in k for k in _kels_for_channel(out, "GROSIR"))  # decision 1b
    assert not any("EDP - DE LUXE" in k for k in _kels_for_channel(out, "GROSIR"))
    assert not any(k == "CSBNCA FM - B. MIST" for k in _kels_for_channel(out, "GROSIR"))


def test_variant_all_variant_for_blagio_edt():
    """Regression for the ACCELERATE bug: Bellagio EDT merged row shows the
    generic 'All Variant', never a single variant name."""
    out, _ = _pipeline_rows()
    hits = [
        r for r in out
        if r["channel_gtmt"] == "RETAIL" and "BLAGIO HM - EDT" in str(r.get("kelompok", "")).upper()
    ]
    assert hits
    for r in hits:
        assert r["variant"] == "All Variant", r["variant"]


def test_sport_variant_label_positional():
    """User 2026-07-15: baris ber-kelompok hasil qualifier 'Sport' harus melabeli
    kolom Variant secara posisional ('Sport & All Variant'), bukan 'All Variant'
    rata; label ditandai _priskila_variant_label agar renderer tak menimpanya."""
    out, _ = _pipeline_rows()
    retail_b4 = [r for r in out if r["channel_gtmt"] == "RETAIL"
                 and "REGAZZA" in r.get("kelompok", "") and "Sport" in r.get("variant", "")]
    assert retail_b4, "baris RETAIL Regazza ber-label Sport tidak ditemukan"
    r = retail_b4[0]
    parts = [p.strip() for p in r["variant"].split("&")]
    kels = [k.strip() for k in r["kelompok"].split("&")]
    assert len(parts) == len(kels)                      # posisional 1:1 dgn kelompok
    assert parts[kels.index("REGAZZA FM - EDT")] == "Sport"
    assert r["_priskila_variant_label"] is True
