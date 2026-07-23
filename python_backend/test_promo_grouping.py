"""Tujuan: Self-check grouping/deduplikasi promo yang tahan variasi model.

Caller: developer/CI manual dengan ``python test_promo_grouping.py``.
Dependensi: ``promo_grouping`` dan Python standard library.
Main Functions: ``run_self_check``.
Side Effects: hanya mencetak status self-check.
"""

from promo_grouping import (
    allows_legacy_master_fallback, assign_stable_group_ids, bridge_group_triggers, canonical_promo_text, consolidation_identity,
    deduplicate_promo_rows, program_identity, propagate_table_benefits, stable_sort_promo_rows,
)


def _row(surat, sku, qty, benefit="5%", kelompok="NATUR SHAMPOO"):
    return {
        "surat_program": surat, "program_key": program_identity({"surat_program": surat}),
        "channel": "MTI", "kode_barang": sku, "nama_barang": f"ITEM {sku}",
        "master_kel": kelompok, "trig_qty": str(qty), "trig_unit": "PCS",
        "benefit_type": "DISC_PCT", "benefit_text": benefit, "benefit_unit": "%",
        "auto_group_id": True,
    }


def run_self_check():
    assert canonical_promo_text("Add disc 5% + 3%") == canonical_promo_text("Add disc 5%+3%")
    assert consolidation_identity({"kode_barangs": "200,100,100"}) == ("SKU", "100", "200")
    assert consolidation_identity({"kode_barangs": "100"}) != consolidation_identity({"kode_barangs": "200"})
    assert not allows_legacy_master_fallback({"principle": "NATUR (GONDOWANGI)", "_urc_unmatched": True})
    assert allows_legacy_master_fallback({"principle": "PRISKILA"})
    bridged = propagate_table_benefits([
        {"surat_program": "A", "benefit": "Add disc 10%", "benefit_type": "DISC_PCT"},
        {"surat_program": "A", "benefit": "(diskon per SKU tidak terbaca dari surat -- review manual)"},
        {"surat_program": "B", "benefit": ""},
    ])
    assert bridged[1]["benefit"] == "Add disc 10%"
    assert bridged[2]["benefit"] == ""
    assert propagate_table_benefits([{"surat_program": "A", "benefit": "Add disc 5% + 3%"}])[0]["benefit"] == "Add disc 5%+3%"
    october = _row("PROID-TP/MTI/25100001", "100", 12, "5%+3%")
    rowspan_duplicate = _row("PROID-TP/MTI/25100001", "100", 1, "5%+3%")
    february = _row("PROID-TP/MTI/26020001", "100", 24, "5%")
    tier = _row("PROID-TP/MTI/26020001", "100", 12, "5%")
    bridged_trigger = bridge_group_triggers([october, _row("PROID-TP/MTI/25100001", "200", 1, "5%+3%")])
    assert {row["trig_qty"] for row in bridged_trigger} == {"12"}
    deduped, dropped = deduplicate_promo_rows([rowspan_duplicate, february, october, tier])
    assert dropped == 1
    assert {(row["program_key"], row["trig_qty"]) for row in deduped} == {
        (october["program_key"], "12"), (february["program_key"], "24"), (february["program_key"], "12"),
    }
    canonical_a = stable_sort_promo_rows(assign_stable_group_ids(deduped))
    canonical_b = stable_sort_promo_rows(assign_stable_group_ids(list(reversed(deduped))))
    project = lambda values: [(r["program_key"], r["kode_barang"], r["trig_qty"], r["pg_id"]) for r in values]
    assert project(canonical_a) == project(canonical_b)
    assert canonical_a[0]["pg_id"] != canonical_a[-1]["pg_id"]
    print("promo_grouping self-check passed")


if __name__ == "__main__":
    run_self_check()
