"""Regenerate the March golden fixture for the Priskila deterministic matcher.

Source of truth = the MARCH surat OCR pulled from the STABLE ocr_cache (keyed by
the March PDF's content hash), NOT the transient data/debug_ai.txt (which any
later live parse of a different surat overwrites).

Run EXPLICITLY to regenerate:  python build_golden.py
Importing this module has NO side effects (no file writes, no prints) -- the
earlier version executed at import time and silently clobbered the golden.
"""
import re
import json
import hashlib
import sys

sys.path.insert(0, ".")
import priskila_matcher as pm

MARCH_PDF = r"D:\AccAPI\_github_clean\reference_surat_program\TRADE PROGRAM GT BULAN MARET 2026.pdf"
GOLDEN_PATH = "data/golden_priskila_expected.json"


def load_master():
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


def march_ocr_text():
    import ocr_cache
    h = hashlib.sha256(open(MARCH_PDF, "rb").read()).hexdigest()
    entry = ocr_cache.ocr_cache_get(h)
    if not entry:
        raise SystemExit(
            "March OCR not in cache. Run the March pipeline once first "
            "(scratchpad/run_live_priskila.py) so the OCR gets cached."
        )
    return entry.get("ocr_text", "")


def parse_surat_lines(ocr_text):
    """Parse the surat markdown tables into (channel, brand, item, paket)."""
    channel = None
    brand = None
    rows = []
    for ln in ocr_text.split("\n"):
        s = ln.strip()
        up = s.upper()
        m = re.search(r"CHANNEL\s*:?\s*(RETAIL|MODERN TRADE|GROSIR|STAR OUTLET)", up)
        if m:
            key = m.group(1)
            channel = "MTI" if key == "MODERN TRADE" else key
            continue
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if len(cells) < 3:
            continue
        if set("".join(cells)) <= set("-: "):
            continue
        if cells[0].upper() in ("BRAND", "") and "GROUP ITEM" in " ".join(cells).upper():
            continue
        b = cells[0].strip()
        if b:
            brand = b
        item = cells[1].strip()
        paket = cells[2].strip() if len(cells) > 2 else ""
        if not item or item.upper() == "GROUP ITEM":
            continue
        rows.append((channel, brand, item, paket))
    return rows


def _tier(paket):
    m = re.match(r"\s*(\d+)\s*\+\s*(\d+)", str(paket))
    return f"Beli {m.group(1)}" if m else "Beli 1"  # MTI rupiah cut-price -> Beli 1


def build_golden(master, rules, rows):
    golden = []
    for ch, br, item, paket in rows:
        res = pm.resolve_surat_line(br, item, master, rules)
        golden.append({
            "channel": ch, "group_item_text": item, "paket": paket, "tier": _tier(paket),
            "kelompoks": res["kelompoks"],
            "kode_barangs": sorted(it["kode_barang"] for it in res["sku_list"]),
        })
    return golden


if __name__ == "__main__":
    master = load_master()
    rules = pm.load_rules()
    rows = parse_surat_lines(march_ocr_text())
    print(f"Parsed {len(rows)} March surat lines")

    unmatched = [(ch, br, item) for ch, br, item, paket in rows
                 if not pm.resolve_surat_line(br, item, master, rules)["sku_list"]]
    print(f"UNMATCHED ({len(unmatched)}):")
    for u in unmatched:
        print("  ", u)

    golden = build_golden(master, rules, rows)
    json.dump(golden, open(GOLDEN_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    total = sum(len(g["kode_barangs"]) for g in golden)
    distinct = len({c for g in golden for c in g["kode_barangs"]})
    print(f"Wrote golden: {len(golden)} rows, {total} SKU-slots, {distinct} distinct SKUs")

    def kels(ch):
        return {k.upper() for g in golden if g["channel"] == ch for k in g["kelompoks"]}
    checks = [
        ("RETAIL Blagio Pmd Wtr Bas present", any("PMD WTR BAS" in k for k in kels("RETAIL"))),
        ("RETAIL Csbnca HM Pmd Oil Based present", any("PMD OIL BASED" in k for k in kels("RETAIL"))),
        ("MTI Blagio EDP Prestige present", any("EDP - PRESTIGE" in k for k in kels("MTI"))),
        ("MTI Camellia regular B.Mist present", any(k == "CAMELLIA - B. MIST" for k in kels("MTI"))),
        ("GROSIR Csbnca HM Pmd Oil Based present (1a)", any("PMD OIL BASED" in k for k in kels("GROSIR"))),
        ("GROSIR Camellia SANITIZER absent", not any("SANITIZER" in k for k in kels("GROSIR"))),
        ("GROSIR Blagio SPORT EDT absent (1b)", not any("SPORT EDT" in k for k in kels("GROSIR"))),
        ("GROSIR Regazza EDP DE LUXE absent", not any("EDP - DE LUXE" in k for k in kels("GROSIR"))),
    ]
    print("\n=== INVARIANT CHECKS ===")
    ok = True
    for name, passed in checks:
        print(f"  {'OK  ' if passed else 'FAIL'} {name}")
        ok = ok and passed
    print("ALL PASS" if ok else "SOME FAILED")
