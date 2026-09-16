"""Tujuan: Draft yang disimpan menurunkan kode barang dan kelompok kanonik dari MASTER.
Caller: pytest python_backend/test_draft_resolve_kode.py. Dependensi: routers.summary_library.
Main Functions: tiga test. Side Effects: tidak ada; murni, tanpa HTTP dan tanpa SQLite.

Kenapa tes ini ada: `_apply_native_kelompok` sudah lama benar, tetapi hanya dipanggil saat
men-generate PDF Summary. Draft di grid karena itu memegang keluaran mentah LLM — `kode_barangs`
kosong dan `kelompok` berisi kalimat surat — dan `build_programs` menolaknya dengan "kode barang
belum dipilih". Yang membuatnya buntu bukan tebakan yang meleset, melainkan bahwa manusia tidak
punya jalan membetulkannya. Yang diuji di sini adalah jalan itu.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from routers.summary_library import resolve_kode_barangs

MASTER = {"master": {"items": [
    {"kode_barang": "K1330001006010", "nama_barang": "KNF OVALE FACIAL LOTION ANTI ACNE 60ML X 36 BTL",
     "kelompok": "OVALE FACIAL LOTION", "variant": "ANTI ACNE", "gramasi": "60ML"},
    {"kode_barang": "K1330001010010", "nama_barang": "KNF OVALE FACIAL LOTION ANTI ACNE 100ML X 36 BTL",
     "kelompok": "OVALE FACIAL LOTION", "variant": "ANTI ACNE", "gramasi": "100ML"},
    {"kode_barang": "K1330002006010", "nama_barang": "KNF OVALE FACIAL LOTION EXTRA MILD 60ML X 36 BTL",
     "kelompok": "OVALE FACIAL LOTION", "variant": "EXTRA MILD", "gramasi": "60ML"},
    {"kode_barang": "K9990001000010", "nama_barang": "KNF ABSTRACT EYELASH F01 VIBRANT X 100 BOX",
     "kelompok": "ABSTRACT EYELASH", "variant": "F01 VIBRANT", "gramasi": ""},
]}}


def _baris(**ubah):
    row = {"principle": "KINO NON FOOD", "surat_program": "BP2609007664", "nama_program": "OVALE",
           "kelompok": "OVALE FACIAL LOTION", "variant": "ALL VARIANT", "gramasi": "ALL GRAMASI",
           "ketentuan": "Beli 30 PCS", "benefit_type": "BONUS_QTY", "benefit": "1 PCS",
           "kode_barangs": "", "id": "r1", "no": "1"}
    row.update(ubah)
    return row


def test_kode_barang_diturunkan_dari_kelompok_yang_dibetulkan_manusia():
    """Inilah jalan keluar yang dulu tidak ada: betulkan kelompoknya, kodenya menyusul."""
    hasil = resolve_kode_barangs([_baris()], MASTER)
    assert len(hasil) == 1
    kode = hasil[0]["kode_barangs"].split(",")
    assert sorted(kode) == ["K1330001006010", "K1330001010010", "K1330002006010"], kode
    # Barang dari kelompok lain TIDAK boleh ikut terseret.
    assert "K9990001000010" not in kode
    # Kelompoknya ditulis ulang dengan nama MASTER, bukan yang diketik/ditebak.
    assert hasil[0]["kelompok"] == "OVALE FACIAL LOTION"


def test_varian_tertentu_mempersempit_bukan_memperluas():
    hasil = resolve_kode_barangs([_baris(variant="EXTRA MILD")], MASTER)
    assert hasil[0]["kode_barangs"] == "K1330002006010"


def test_tanpa_master_baris_dibiarkan_apa_adanya():
    """Tanpa master tidak ada kamus; menebak kode barang jauh lebih buruk daripada diam."""
    rows = [_baris()]
    assert resolve_kode_barangs(rows, {}) == rows
    assert resolve_kode_barangs(rows, {"master": {"items": []}}) == rows
