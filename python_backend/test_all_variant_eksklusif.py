"""Tujuan: Mengunci aturan P — "ALL VARIANT" tidak boleh menelan varian milik baris lain.
Caller: run_checks.py / pytest. Dependensi: shared. Side Effects: tidak ada.

KENAPA UJI INI ADA. Satu surat sering menyebut DUA program dalam SATU kelompok master: yang umum
dan yang bervarian. Pada `BP2609007713`, `RESIK V KHASIAT MANJAKANI` dan `RESIK V MANJAKANI
WHITENING` keduanya kelompok master `RESIK V MANJAKANI`. Tanpa aturan ini yang umum ikut menarik
tiga kode whitening, dan barang whitening mendapat bonus DUA KALI dari satu surat yang sama.

Bukan teori: 13 aturan Excel `BP2609007713` yang hidup di produksi hari ini melanggarnya.
Keputusan pengguna 16 September 2026 menutupnya; berkas ini yang menjaga tutupnya tidak terbuka
lagi.
"""
from shared import _terapkan_all_variant_eksklusif as terapkan

MANJAKANI = "K1370000005010,K1370000009010,K1370000020010"
WHITENING = "K1370001005010,K1370001009010,K1370001020010"


def _baris(surat, kelompok, variant, kode):
    return {"surat_program": surat, "kelompok": kelompok, "variant": variant, "kode_barangs": kode}


def test_all_variant_melepas_kode_milik_varian_bernama():
    rows = [
        _baris("BP2609007713", "RESIK V MANJAKANI", "ALL VARIANT", MANJAKANI + "," + WHITENING),
        _baris("BP2609007713", "RESIK V MANJAKANI", "WHITENING", WHITENING),
    ]
    terapkan(rows)
    assert rows[0]["kode_barangs"] == MANJAKANI, "baris umum harus tinggal 3 kode non-whitening"
    assert rows[1]["kode_barangs"] == WHITENING, "baris bervarian tidak boleh berubah"
    semua = [k for r in rows for k in r["kode_barangs"].split(",")]
    assert len(semua) == len(set(semua)), "tidak boleh ada kode yang muncul di dua baris"


def test_surat_berbeda_tidak_saling_mencabut():
    """Dua surat boleh memberi bonus pada barang yang sama — itu keputusan principal."""
    rows = [
        _baris("BP001", "RESIK V MANJAKANI", "ALL VARIANT", MANJAKANI + "," + WHITENING),
        _baris("BP002", "RESIK V MANJAKANI", "WHITENING", WHITENING),
    ]
    terapkan(rows)
    assert rows[0]["kode_barangs"] == MANJAKANI + "," + WHITENING


def test_kelompok_berbeda_tidak_saling_mencabut():
    rows = [
        _baris("BP001", "RESIK V MANJAKANI", "ALL VARIANT", MANJAKANI + "," + WHITENING),
        _baris("BP001", "RESIK V GODOKAN", "WHITENING", WHITENING),
    ]
    terapkan(rows)
    assert rows[0]["kode_barangs"] == MANJAKANI + "," + WHITENING


def test_dua_baris_all_variant_tidak_saling_mencabut():
    """Tidak ada yang lebih spesifik, jadi tidak ada yang berhak mencabut."""
    rows = [
        _baris("BP001", "K", "ALL VARIANT", "A,B"),
        _baris("BP001", "K", "ALL VARIANT", "B,C"),
    ]
    terapkan(rows)
    assert rows[0]["kode_barangs"] == "A,B" and rows[1]["kode_barangs"] == "B,C"


def test_baris_yang_akan_habis_dibiarkan_utuh():
    """Baris yang kehilangan SELURUH kodenya biasanya berarti suratnya dibaca keliru.

    Ia ditinggalkan apa adanya supaya `compile_programs` menahannya dan orang melihatnya —
    mengosongkannya diam-diam akan menghilangkan satu program tanpa ada yang tahu.
    """
    rows = [
        _baris("BP001", "K", "ALL VARIANT", WHITENING),
        _baris("BP001", "K", "WHITENING", WHITENING),
    ]
    terapkan(rows)
    assert rows[0]["kode_barangs"] == WHITENING


def test_cache_item_ikut_dipangkas():
    """Renderer memakai `_matched_items_cache`; kalau ia tidak ikut, PDF dan aturan berbeda isi."""
    rows = [
        {"surat_program": "BP001", "kelompok": "K", "variant": "ALL VARIANT",
         "kode_barangs": "A,B", "_matched_items_cache": [{"kode_barang": "A"}, {"kode_barang": "B"}]},
        _baris("BP001", "K", "WHITENING", "B"),
    ]
    terapkan(rows)
    assert rows[0]["kode_barangs"] == "A"
    assert [it["kode_barang"] for it in rows[0]["_matched_items_cache"]] == ["A"]
