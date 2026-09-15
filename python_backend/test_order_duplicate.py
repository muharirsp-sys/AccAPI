"""Tujuan: Mengunci jawaban `order_duplicate` pada contoh yang SAMA PERSIS dengan
`lib/order-duplicate.test.ts`. Caller: `python test_order_duplicate.py`.
Dua jawaban berbeda tentang "apakah order ini ganda" lebih buruk daripada tidak memeriksa.
"""
from order_duplicate import duplicate_message, find_duplicate


def order(key, item_codes, **over):
    row = {"key": key, "outlet": "C-BA0003", "order_date": "2026-09-12", "item_codes": item_codes}
    row.update(over)
    return row


def test_mirip_tapi_tidak_sama_persis():
    hit = find_duplicate(order("SO-2", ["K1", "K2", "K3", "K4"]), [order("SO-1", ["K1", "K2", "K3"])])
    assert hit and hit["key"] == "SO-1"
    assert hit["shared"] == ["K1", "K2", "K3"]
    assert hit["containment"] == 1
    assert hit["identical"] is False
    assert "mirip 100%" in duplicate_message(hit)
    assert "SO-1" in duplicate_message(hit)


def test_persis_sama_juga_ditahan():
    hit = find_duplicate(order("SO-2", ["K1", "K2"]), [order("SO-1", ["K2", "K1"])])
    assert hit and hit["identical"] is True
    assert "PERSIS SAMA" in duplicate_message(hit)


def test_containment_bukan_jaccard():
    besar = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "K10"]
    hit = find_duplicate(order("SO-2", ["K1", "K2", "K3"]), [order("SO-1", besar)])
    assert hit and hit["containment"] == 1


def test_outlet_atau_tanggal_berbeda_bukan_ganda():
    isi = ["K1", "K2", "K3"]
    assert find_duplicate(order("SO-2", isi), [order("SO-1", isi, outlet="C-LAIN01")]) is None
    assert find_duplicate(order("SO-2", isi), [order("SO-1", isi, order_date="2026-09-13")]) is None
    assert find_duplicate(order("SO-2", isi), [order("SO-1", isi, outlet=" c-ba0003 ")])


def test_ambang_bisa_digeser():
    sedikit = [order("SO-1", ["K1", "K9", "K8", "K7"])]
    assert find_duplicate(order("SO-2", ["K1", "K2", "K3", "K4"]), sedikit) is None
    assert find_duplicate(order("SO-2", ["K1", "K2", "K3", "K4"]), sedikit, 0.25)


def test_yang_dikembalikan_paling_mirip():
    hit = find_duplicate(order("SO-3", ["K1", "K2", "K3", "K4"]), [
        order("SO-1", ["K1", "K2", "K9", "K8"]),
        order("SO-2", ["K1", "K2", "K3", "K4"]),
    ])
    assert hit["key"] == "SO-2"


def test_kosong_dan_diri_sendiri():
    assert find_duplicate(order("SO-1", []), [order("SO-2", ["K1"])]) is None
    assert find_duplicate(order("SO-1", ["K1", "K2"]), [order("SO-1", ["K1", "K2"])]) is None
    assert find_duplicate(order("SO-2", ["K1"]), [order("SO-1", [])]) is None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok -", name)
    print("semua lolos")
