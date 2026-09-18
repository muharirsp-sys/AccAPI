import sys

sys.path.insert(0, ".")
from shared import _apply_native_kelompok


def test_explicit_all_master_resolves_one_row_and_empty_stays_empty():
    master = [
        {"kode_barang": "A1", "kelompok": "A", "variant": "ONE", "gramasi": "1", "nama_barang": "A1"},
        {"kode_barang": "B1", "kelompok": "B", "variant": "ONE", "gramasi": "1", "nama_barang": "B1"},
        {"kode_barang": "BND1", "kelompok": "B", "variant": "BND", "gramasi": "1", "nama_barang": "BND1 BND"},
    ]
    base = {"variant": "ALL VARIANT", "gramasi": "ALL GRAMASI", "kode_barangs": "", "no": "1"}

    resolved = _apply_native_kelompok([{**base, "kelompok": "__ALL_MASTER__"}], master)
    assert len(resolved) == 1
    assert resolved[0]["kelompok"] == "ALL KELOMPOK BARANG"
    assert resolved[0]["kode_barangs"] == "A1,B1"

    unresolved = _apply_native_kelompok([{**base, "kelompok": ""}], master)
    assert unresolved == [{**base, "kelompok": ""}]


def test_second_save_of_all_master_row_is_idempotent():
    """Simpan kedua kali tidak boleh mengosongkan barisnya.

    Sesudah simpan pertama, `kelompok` di grid bukan lagi sentinel melainkan nilai kanonik
    `ALL KELOMPOK BARANG`. Kalau resolver tidak mengenali keluarannya sendiri, simpan kedua
    jatuh ke jalur "bukan kelompok master" -> 0 kode, dan PDF-nya mencetak baris kosong.
    """
    master = [
        {"kode_barang": "A1", "kelompok": "A", "variant": "ONE", "gramasi": "1", "nama_barang": "A1"},
        {"kode_barang": "B1", "kelompok": "B", "variant": "ONE", "gramasi": "1", "nama_barang": "B1"},
        {"kode_barang": "BND1", "kelompok": "B", "variant": "BND", "gramasi": "1", "nama_barang": "BND1 BND"},
    ]
    satu = _apply_native_kelompok(
        [{"kelompok": "__ALL_MASTER__", "variant": "", "gramasi": "", "kode_barangs": "", "no": "1"}], master)

    # Yang kembali ke grid, lalu dikirim lagi apa adanya -- tanpa bergantung pada `kode_barangs`
    # yang ikut terbawa, karena operator boleh menyunting baris itu sebelum menyimpan lagi.
    dua = _apply_native_kelompok(
        [{k: v for k, v in satu[0].items() if k not in ("kode_barangs", "_matched_items_cache")}], master)

    assert len(dua) == 1
    assert dua[0]["kode_barangs"] == satu[0]["kode_barangs"] == "A1,B1"
    assert dua[0]["kelompok"] == "ALL KELOMPOK BARANG"
