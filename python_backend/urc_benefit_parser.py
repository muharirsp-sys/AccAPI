"""
urc_benefit_parser.py

Pure parser for URC's promo-letter benefit grammar, which differs from
Priskila's: URC states ONE benefit for the whole letter in the "Nama Program"
header (not a per-row "paket" tier cell), and applies it to every SKU listed.

Two grammars seen so far:
  - "BUY N GET M FREE ..."  -> same shape as Priskila's bonus-qty benefit,
    so it reuses BONUS_QTY (no new benefit_type needed).
  - "DISKON P% ..."         -> new benefit_type DISC_PCT (flat percentage,
    no bonus product).

Public API:
    parse_program_benefit(nama_program: str) -> dict(tier, benefit_type, benefit)
"""

import re
from typing import Dict

_BTGO_RE = re.compile(r"BUY\s*(\d+)\s*GET\s*(\d+)\s*FREE", re.IGNORECASE)
_DISC_PCT_RE = re.compile(r"DISKON\s*(\d+)\s*%", re.IGNORECASE)


def parse_program_benefit(nama_program: str) -> Dict[str, str]:
    text = str(nama_program or "").strip()

    m = _BTGO_RE.search(text)
    if m:
        return {"tier": f"Beli {m.group(1)}", "benefit_type": "BONUS_QTY", "benefit": f"{m.group(2)} PCS"}

    m = _DISC_PCT_RE.search(text)
    if m:
        return {"tier": "Beli 1", "benefit_type": "DISC_PCT", "benefit": f"{m.group(1)}%"}

    return {"tier": "Beli 1", "benefit_type": "", "benefit": ""}


def _demo():
    cases = [
        ("BUY 2 GET 1 FREE LEXUS 76g (EXPIRED OCT 2025 – FEB 2026)",
         {"tier": "Beli 2", "benefit_type": "BONUS_QTY", "benefit": "1 PCS"}),
        ("DISKON 25% MUNCHY’S MEDIUM PACK CATEGORY (EXPIRED DEC 2025 – FEB 2026)",
         {"tier": "Beli 1", "benefit_type": "DISC_PCT", "benefit": "25%"}),
        ("PROGRAM TIDAK DIKENAL", {"tier": "Beli 1", "benefit_type": "", "benefit": ""}),
    ]
    for text, expected in cases:
        got = parse_program_benefit(text)
        assert got == expected, f"{text!r} -> {got} != {expected}"
    print("urc_benefit_parser: all demo cases passed")


if __name__ == "__main__":
    _demo()
