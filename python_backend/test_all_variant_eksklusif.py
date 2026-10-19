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


def test_simpan_tidak_mencampur_sub_lini_sport():
    """Regazza EDT biasa (Beli 7) dan EDT Sport (Beli 4) sekelompok master. Saat Simpan, ekspansi
    "All Variant" hanya menarik saudara ber-qualifier sama -- dulu baris biasa menarik 4 kode Sport."""
    from shared import _apply_native_kelompok
    master = [{"kode_barang": k, "kelompok": "REGAZZA FM - EDT", "gramasi": "100ML", "variant": v,
               "nama_barang": f"REGAZZA EDT {v} 100ML", "principle": f"Regazza Femme {s}Eau De Toilette {v} 100ml"}
              for k, v, s in (("R1", "AZZURO", "Sport "), ("R2", "BIANCO", "Sport "),
                              ("R5", "CLASSY", ""), ("R6", "FEMININE", ""))]
    rows = [{"no": "1", "surat_program": "002", "kelompok": "REGAZZA FM - EDT", "variant": "All Variant",
             "gramasi": "100ML", "kode_barangs": kode, "ketentuan": ket}
            for kode, ket in (("R5", "Beli 7 PCS"), ("R1", "Beli 4 PCS"))]
    hasil = {r["ketentuan"]: set(r["kode_barangs"].split(",")) for r in _apply_native_kelompok(rows, master)}
    assert hasil == {"Beli 7 PCS": {"R5", "R6"}, "Beli 4 PCS": {"R1", "R2"}}, hasil


def test_channel_berbeda_tidak_saling_mencabut():
    """Satu nomor surat Priskila dibawa ke semua blok channel. Baris Grosir "Sport & All Variant"
    tidak boleh mencabut kode baris MTI berkelompok sama -- dulu MTI kehilangan 19 SKU diam-diam."""
    grosir = dict(_baris("002", "REGAZZA FM - EDT", "Sport & All Variant", "R1,R5"), channel_gtmt="GT GROSIR")
    mti = dict(_baris("002", "REGAZZA FM - EDT", "ALL VARIANT", "R1,R5,R6"), channel_gtmt="MT")
    terapkan([grosir, mti])
    assert mti["kode_barangs"] == "R1,R5,R6", mti


def _master_tiga_merek():
    return [{"kode_barang": k, "kelompok": kel, "gramasi": "25GR", "variant": v, "nama_barang": f"{kel} {v}"}
            for k, kel, v in (("A1", "ANLENE ACTIFIT", "COKLAT"), ("A2", "ANLENE ACTIFIT", "VANILA"),
                              ("G1", "ANLENE GOLD", "COKLAT"), ("B1", "ANCHOR BONEETO", "COKLAT"), ("X1", "ANMUM", "COKLAT"))]


def test_mix_produk_satu_baris_lintas_merek():
    """Owner 19 Okt 2026 (Fonterra provision): "Boleh Mix Produk" -> SATU baris lintas merek; tanpa penanda tetap dipecah."""
    from shared import _apply_native_kelompok
    baris = lambda ket: [{"no": "1", "surat_program": "F149SP", "kelompok": "ANLENE ACTIFIT & ANLENE GOLD & ANCHOR BONEETO",
                          "variant": "All Variant", "gramasi": "25GR", "kode_barangs": "A1,A2,G1,B1", "ketentuan": ket}]
    satu = _apply_native_kelompok(baris("Beli 6 RTG UP Boleh Mix Produk Beda Gramasi"), _master_tiga_merek())
    assert [set(r["kode_barangs"].split(",")) for r in satu] == [{"A1", "A2", "G1", "B1"}], satu
    pecah = _apply_native_kelompok(baris("Beli 6 RTG UP Mix Variant Beda Gramasi"), _master_tiga_merek())
    assert len(pecah) == 3, pecah


def test_aturan_p_per_kelompok_pada_baris_lintas_merek():
    """Varian bernama di SATU kelompok tetap mencabut kodenya dari baris "ALL VARIANT" lintas merek."""
    terapkan_rows = [_baris("F149SP", "ANLENE ACTIFIT & ANLENE GOLD", "ALL VARIANT", "A1,A2,G1"),
                     _baris("F149SP", "ANLENE ACTIFIT", "VANILA", "A2")]
    terapkan(terapkan_rows)
    assert terapkan_rows[0]["kode_barangs"] == "A1,G1", terapkan_rows
