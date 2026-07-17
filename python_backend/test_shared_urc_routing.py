"""
test_shared_urc_routing.py

Regression test for the routing guard added to shared.py::_apply_native_kelompok
in Task 5 of the URC plan. Confirms:
  - rows carrying `item_description` route to urc_pipeline.apply_urc_matching
  - rows carrying `group_item_text` STILL route to priskila_pipeline.apply_priskila_matching
    (unchanged -- URC's new branch must never intercept Priskila rows)
  - rows carrying neither marker fall through to the legacy path unchanged
"""

from unittest.mock import patch

import shared


def test_item_description_rows_route_to_urc_pipeline():
    rows = [{"item_description": "Lexus Cheese 76gx24PC", "nama_program": "x"}]
    sentinel = [{"kelompok": "SENTINEL_URC"}]
    with patch("urc_pipeline.apply_urc_matching", return_value=sentinel) as mock_urc, \
         patch("priskila_pipeline.apply_priskila_matching") as mock_prisk:
        out = shared._apply_native_kelompok(rows, [])
    assert out == sentinel
    mock_urc.assert_called_once()
    mock_prisk.assert_not_called()


def test_group_item_text_rows_still_route_to_priskila_pipeline():
    rows = [{"group_item_text": "Bellagio Eau de Toilette 100ml", "brand": "BELLAGIO"}]
    sentinel = [{"kelompok": "SENTINEL_PRISKILA"}]
    with patch("urc_pipeline.apply_urc_matching") as mock_urc, \
         patch("priskila_pipeline.apply_priskila_matching", return_value=sentinel) as mock_prisk:
        out = shared._apply_native_kelompok(rows, [])
    assert out == sentinel
    mock_urc.assert_not_called()
    mock_prisk.assert_called_once()


def test_rows_with_neither_marker_do_not_hit_either_new_pipeline():
    rows = [{"kelompok": "SOME LEGACY KELOMPOK", "kode_barangs": "X1,X2"}]
    with patch("urc_pipeline.apply_urc_matching") as mock_urc, \
         patch("priskila_pipeline.apply_priskila_matching") as mock_prisk:
        shared._apply_native_kelompok(rows, [])
    mock_urc.assert_not_called()
    mock_prisk.assert_not_called()


def test_urc_pipeline_failure_falls_back_without_raising():
    rows = [{"item_description": "Lexus Cheese 76gx24PC"}]
    with patch("urc_pipeline.apply_urc_matching", side_effect=RuntimeError("boom")), \
         patch("priskila_pipeline.apply_priskila_matching") as mock_prisk:
        # must not raise -- falls through past the URC guard (and, since this
        # row has no group_item_text, past the Priskila guard too) to legacy.
        shared._apply_native_kelompok(rows, [])
    mock_prisk.assert_not_called()


if __name__ == "__main__":
    import sys
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
