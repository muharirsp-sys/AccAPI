"""test_urc_benefit_parser.py -- pytest coverage for urc_benefit_parser.py."""

from urc_benefit_parser import parse_program_benefit


def test_btgo_reuses_bonus_qty_shape():
    got = parse_program_benefit("BUY 2 GET 1 FREE LEXUS 76g (EXPIRED OCT 2025 – FEB 2026)")
    assert got == {"tier": "Beli 2", "benefit_type": "BONUS_QTY", "benefit": "1 PCS"}


def test_disc_pct_is_new_benefit_type():
    got = parse_program_benefit("DISKON 25% MUNCHY’S MEDIUM PACK CATEGORY (EXPIRED DEC 2025 – FEB 2026)")
    assert got == {"tier": "Beli 1", "benefit_type": "DISC_PCT", "benefit": "25%"}


def test_unknown_grammar_returns_empty_benefit_not_exception():
    got = parse_program_benefit("PROGRAM TIDAK DIKENAL")
    assert got == {"tier": "Beli 1", "benefit_type": "", "benefit": ""}


def test_empty_text_returns_empty_benefit_not_exception():
    for text in ("", None):
        got = parse_program_benefit(text)
        assert got == {"tier": "Beli 1", "benefit_type": "", "benefit": ""}


def test_btgo_is_case_insensitive():
    got = parse_program_benefit("buy 3 get 2 free something")
    assert got == {"tier": "Beli 3", "benefit_type": "BONUS_QTY", "benefit": "2 PCS"}
