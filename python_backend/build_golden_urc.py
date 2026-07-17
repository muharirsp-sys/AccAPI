"""
build_golden_urc.py

Builds data/golden_urc_expected.json INDEPENDENTLY of urc_matcher.py's
scoring algorithm -- expectations are hardcoded here as explicit
(kelompok, aroma, gramasi) lookup criteria per surat line, verified by
direct inspection of the master file + the two real letters + user
confirmation (Cheese merge, bare-Chocolate default) earlier this session.
Anti-circular: if a future matcher change breaks a real mapping, this
fixture won't have "learned" the bug from the matcher's own output.

Run: python build_golden_urc.py
"""

import json
import os
import openpyxl

_DIR = os.path.dirname(os.path.abspath(__file__))
_MASTER_PATH = os.path.join(_DIR, "..", "master_barang_principle", "MASTER BARANG URC.xlsx")
_OUT_PATH = os.path.join(_DIR, "data", "golden_urc_expected.json")


def _load_master():
    wb = openpyxl.load_workbook(_MASTER_PATH, data_only=True)
    ws = wb["Sheet1"]
    master = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        master.append({
            "kode_barang": (r[1] or "").strip(),
            "nama_barang": (r[2] or "").strip(),
            "klp": (r[5] or "").strip().upper(),
            "aroma": (r[11] or "").strip().upper(),
            "gramasi": (r[13] or "").strip().upper(),
        })
    return master


def _lookup(master, klp, aromas, gramasi):
    return [
        row["kode_barang"] for row in master
        if row["klp"] == klp and row["aroma"] in aromas and gramasi in row["gramasi"]
    ]


# (surat item_description, expected klp, expected aroma set, expected gramasi digits)
_ITEM_SPECS = [
    ("Lexus Cheese 76gx24PC", "LEXUS SANDWICH", {"C.CHEESE", "CREAM CHEESE"}, "76"),
    ("Lexus Chocolate 76gx24PC", "LEXUS SANDWICH", {"CHOCOLATE"}, "76"),
    ("Lexus Cookies Mixed Nut 189gx12PC", "LEXUS COOKIES", {"MIXED NUTS"}, "189"),
    ("Lexus Cookies Dark Chocolate 189gx12PC", "LEXUS COOKIES", {"DARK CHOCOLATE"}, "189"),
    ("Lexus Cookies Original 189gx12PC", "LEXUS COOKIES", {"ORIGINAL"}, "189"),
    ("Lexus Chocolate 190gx12PC", "LEXUS SANDWICH", {"CHOCOLATE"}, "190"),
    ("Lexus Choco Coated 200gx12PC", "LEXUS CHOCO", {"COATED CHOCO"}, "200"),
    ("Lexus Peanut 190gx12PC", "LEXUS SANDWICH", {"PEANUT BUTTER"}, "190"),
    ("Lexus Cheese 190gx12PC", "LEXUS SANDWICH", {"C.CHEESE", "CREAM CHEESE"}, "190"),
    ("Lexus Lemon 190gx12PC", "LEXUS SANDWICH", {"LEMON CREAM"}, "190"),
    ("Lexus Lychee 190gx12PC", "LEXUS SANDWICH", {"LYCHEE CREAM"}, "190"),
    ("Oat Krunch Chocolate 208gx12PC", "OAT CRUNCH", {"DARK CHOCOLATE"}, "208"),
    ("Oat Krunch Hazelnut 208gx12PC", "OAT CRUNCH", {"CHUNKY HAZELNUT"}, "208"),
    ("Oat Krunch Strawberry & Blackcurrant 208gx12PC", "OAT CRUNCH", {"STRWBRY&B.CRRNT"}, "208"),
    ("Oat Krunch Nutty Chocolate 208gx12PC", "OAT CRUNCH", {"NUTTY CHOCOLATE"}, "208"),
    ("Munchy's Original Cream Cracker 375gx12PC", "MUNCHYS CREAM CRACKERS", {"ORIGINAL"}, "375"),
    ("Munchy's Sugar Cracker 380gx12PC", "MUNCHYS MALKIST", {"SUGAR CRACKERS"}, "380"),
    ("Munchy's Wheat Cracker 276gx12PC", "MUNCHYS CRACKERS", {"WHEAT CRACKER"}, "276"),
    ("Munchy's Cream Cracker 300gx12PC", "MUNCHYS CRACKERS", {"CREAM CRACKER"}, "300"),
    ("Munchy's Vegetable Cracker 380gx12PC", "MUNCHYS CRACKERS", {"VEGE"}, "380"),
    ("Munchy's Choc Sandwich 258gx12PC", "MUNCHYS CRACKERS", {"CHOC SANDWICH"}, "258"),
]
# NOTE: "Topmix Assorted 295g" is NOT part of letter 004's real "Details SKU"
# table (confirmed 2026-07-17 from both the original PDF text and live OCR of
# the actual embedded table image: 19 items, no Topmix). It only appears in
# the Lampiran quota table for unrelated reasons -- an earlier assumption
# wrongly included it here. Kept as a standalone matcher regression test in
# test_urc_matcher.py (the gramasi-fallback mechanism it exercises is still
# valid), just not as part of this letter's golden fixture.

_LETTER_002_ITEMS = {
    "Lexus Cheese 76gx24PC", "Lexus Chocolate 76gx24PC",
}
_LETTER_004_ITEMS = {t[0] for t in _ITEM_SPECS} - _LETTER_002_ITEMS


def build():
    master = _load_master()
    resolved = {}
    for desc, klp, aromas, gramasi in _ITEM_SPECS:
        codes = _lookup(master, klp, aromas, gramasi)
        assert codes, f"No master rows found for {desc!r} ({klp}/{aromas}/{gramasi})"
        resolved[desc] = {"kelompok": klp, "kode_barangs": sorted(codes)}

    fixture = {
        "surat": [
            {
                "file": "002 - BTGO Lexus 76g NED Oct 25 - Feb 26 periode Jul-Sep 2025 (National MTI).pdf",
                "nama_program": "BUY 2 GET 1 FREE LEXUS 76g (EXPIRED OCT 2025 – FEB 2026)",
                "benefit": {"tier": "Beli 2", "benefit_type": "BONUS_QTY", "benefit": "1 PCS"},
                "items": [
                    {"item_description": d, **resolved[d]} for d in _LETTER_002_ITEMS
                ],
            },
            {
                "file": "004 - Diskon 25% Medium pack Munchys NED Dec 25-Feb 26 periode Jul-Aug 2025 (National MTI).pdf",
                "nama_program": "DISKON 25% MUNCHY’S MEDIUM PACK CATEGORY (EXPIRED DEC 2025 – FEB 2026)",
                "benefit": {"tier": "Beli 1", "benefit_type": "DISC_PCT", "benefit": "25%"},
                "items": [
                    {"item_description": d, **resolved[d]} for d in sorted(_LETTER_004_ITEMS)
                ],
            },
        ]
    }

    os.makedirs(os.path.dirname(_OUT_PATH), exist_ok=True)
    with open(_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=2)
    print(f"wrote {_OUT_PATH}: {sum(len(s['items']) for s in fixture['surat'])} items")


if __name__ == "__main__":
    build()
