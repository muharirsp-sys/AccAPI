"""
test_urc_llm_contract.py

Verifies the shape the URC structure-only LLM prompt (routers/summary.py,
_is_urc branch) promises to emit -- one object per Details SKU row, with
{nama_program, item_description, category, principle, surat_program,
periode} and NO kelompok/variant/kode_barangs -- flows correctly through
shared._apply_native_kelompok (real routing + real master, no mocks) end
to end, for one real letter.
"""

import openpyxl

import shared

_MASTER_PATH = r"D:/AccAPI/_github_clean/master_barang_principle/MASTER BARANG URC.xlsx"


def _load_master():
    """Mirrors shared.py::_parse_master_barang_xlsx's row shape -- this is
    literally what _apply_native_kelompok receives as master_items in
    production, so the contract test must build it the same way."""
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


def _simulated_llm_rows():
    """Exactly the object shape documented in the URC prompt's
    "FIELD PER OBJECT" section -- never kelompok/variant/kode_barangs."""
    nama_program = "BUY 2 GET 1 FREE LEXUS 76g (EXPIRED OCT 2025 – FEB 2026)"
    common = {
        "principle": "PT URC INDONESIA",
        "surat_program": "002/176/URC/MT/VII/25",
        "periode": "JUL-SEP 2025",
        "channel_gtmt": "National MTI",
        "syarat_claim": "Klaim maks 45 hari setelah promo berakhir",
    }
    return [
        {"nama_program": nama_program, "item_description": "Lexus Cheese 76gx24PC",
         "category": "Small pack", **common},
        {"nama_program": nama_program, "item_description": "Lexus Chocolate 76gx24PC",
         "category": "Small pack", **common},
    ]


def test_llm_shaped_rows_route_and_resolve_via_shared_entrypoint():
    rows = _simulated_llm_rows()
    for r in rows:
        assert "kelompok" not in r and "variant" not in r and "kode_barangs" not in r

    out = shared._apply_native_kelompok(rows, MASTER)

    assert out, "expected at least one merged row"
    assert not any(r.get("_urc_unmatched") for r in out), out
    row = out[0]
    assert row["kelompok"] == "LEXUS SANDWICH"
    assert row["ketentuan"] == "Beli 2"
    assert row["benefit_type"] == "BONUS_QTY"
    assert row["benefit"] == "1 PCS"
    assert row["kode_barangs"], "expected resolved SKU codes"
    # Meta surat wajib ikut sampai baris output (permintaan user 2026-07-17).
    assert row["surat_program"] == "002/176/URC/MT/VII/25"
    assert row["periode"] == "JUL-SEP 2025"
    assert row["channel_gtmt"] == "National MTI"
    assert row["syarat_claim"] == "Klaim maks 45 hari setelah promo berakhir"
    assert row["keterangan"] == ""


if __name__ == "__main__":
    import sys
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
