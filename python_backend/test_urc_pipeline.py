"""
test_urc_pipeline.py

Runs apply_urc_matching over the 2 real letters (data/golden_urc_expected.json)
and checks the merged output's kode_barangs per kelompok match the golden
fixture's expectations, and that the single per-letter benefit is applied
to every row.
"""

import json
import os
import openpyxl

import urc_pipeline as up

_DIR = os.path.dirname(os.path.abspath(__file__))
_MASTER_PATH = os.path.join(_DIR, "..", "master_barang_principle", "MASTER BARANG URC.xlsx")
_GOLDEN_PATH = os.path.join(_DIR, "data", "golden_urc_expected.json")


def _load_master():
    """Mirrors shared.py::_parse_master_barang_xlsx's row shape (kelompok =
    KLP+Sub KLP+Sub KLP2 joined, variant = Nama Aroma/Rasa) -- what
    urc_pipeline actually receives in production."""
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
with open(_GOLDEN_PATH, "r", encoding="utf-8") as f:
    GOLDEN = json.load(f)


def _expected_kode_barangs_by_kelompok(surat):
    expected = {}
    for item in surat["items"]:
        expected.setdefault(item["kelompok"], set()).update(item["kode_barangs"])
    return expected


def test_each_letter_zero_unmatched_and_one_row_per_kelompok_matches_golden():
    """User 2026-07-17: SATU baris per kelompok (bukan digabung) -- Kelompok/
    Variant/Gramasi/SKU tetap terpisah per kelompok utk audit trail. Kolom
    yang genuinely identik (Ketentuan/Benefit/dst) di-merge SECARA VISUAL
    oleh renderer PDF/Excel, bukan oleh pipeline."""
    for surat in GOLDEN["surat"]:
        rows = [
            {"nama_program": surat["nama_program"], "item_description": item["item_description"]}
            for item in surat["items"]
        ]
        out = up.apply_urc_matching(rows, MASTER)

        unmatched = [r for r in out if r.get("_urc_unmatched")]
        assert not unmatched, (surat["file"], unmatched)

        expected = _expected_kode_barangs_by_kelompok(surat)
        got = {r["kelompok"]: set(r["kode_barangs"].split(",")) for r in out}
        assert got.keys() == expected.keys(), (surat["file"], got.keys(), expected.keys())
        for klp, codes in expected.items():
            assert got[klp] == codes, (surat["file"], klp, got[klp], codes)


def test_missing_syarat_claim_is_flagged_not_silent():
    rows = [{"nama_program": "BUY 2 GET 1 FREE LEXUS 76g", "item_description": "Lexus Chocolate 76gx24PC"}]
    out = up.apply_urc_matching(rows, MASTER)
    assert "SYARAT KLAIM TIDAK DITEMUKAN" in out[0]["keterangan"]

    rows_ok = [dict(rows[0], syarat_claim="Klaim maks 45 hari")]
    out_ok = up.apply_urc_matching(rows_ok, MASTER)
    assert out_ok[0]["keterangan"] == ""
    assert out_ok[0]["syarat_claim"] == "Klaim maks 45 hari"


def test_same_benefit_applied_to_every_row_in_a_letter():
    for surat in GOLDEN["surat"]:
        rows = [
            {"nama_program": surat["nama_program"], "item_description": item["item_description"]}
            for item in surat["items"]
        ]
        out = up.apply_urc_matching(rows, MASTER)
        benefit = surat["benefit"]
        for r in out:
            assert r["ketentuan"] == benefit["tier"], surat["file"]
            assert r["benefit_type"] == benefit["benefit_type"], surat["file"]
            assert r["benefit"] == benefit["benefit"], surat["file"]


def test_unmatched_line_is_flagged_not_dropped():
    rows = [{"nama_program": "BUY 2 GET 1 FREE X", "item_description": "Some Unknown Product 999gx1PC"}]
    out = up.apply_urc_matching(rows, MASTER)
    assert len(out) == 1
    assert out[0]["_urc_unmatched"] is True
    assert out[0]["kode_barangs"] == ""


if __name__ == "__main__":
    import sys
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
