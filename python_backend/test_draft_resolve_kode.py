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


def test_kelayakan_outlet_tidak_boleh_hilang_saat_disimpan():
    """Pembatasan peserta yang hilang GAGAL TERBUKA: bonus jatuh ke toko yang bukan peserta.

    `build_programs` sudah lama membaca `outlet_mode`/`outlet_classes`, dan pembaca surat sudah
    lama mengeluarkannya ("KHUSUS CHANNEL GT PESERTA LOYALTY" -> only/LOYALTY). Yang membuangnya
    adalah penyaring kunci saat menyimpan draft, karena keduanya tidak ada di `FIELDS`. Tidak ada
    galat yang timbul — hanya surat yang berubah arti diam-diam.
    """
    hasil = resolve_kode_barangs(
        [_baris(outlet_mode="only", outlet_classes="LOYALTY")], MASTER)
    assert hasil[0]["outlet_mode"] == "only"
    assert hasil[0]["outlet_classes"] == "LOYALTY"


def test_kelompok_kosong_tidak_mencocok_seluruh_katalog():
    """Kelompok kosong = "belum tahu", BUKAN "semuanya". Ini gagal-terbuka yang paling mahal.

    Dulu `_apply_native_kelompok` memakai SELURUH master sebagai pool begitu kelompoknya kosong.
    Karena varian dan gramasi baris itu juga "ALL", setiap barang principal ikut cocok, dan satu
    baris pecah jadi satu baris per kelompok — masing-masing dengan kode barang NYATA. Yang
    membuatnya berbahaya: `issues` jadi KOSONG, jadi draftnya terlihat sah dan bisa diterbitkan
    sebagai aturan yang menahan faktur. Terbukti 2026-09-16: satu draft berubah dari 7 baris jadi
    607 hanya karena disimpan ulang untuk mengganti judulnya.

    Kelompok kosong justru keadaan NORMAL tiap baris SESUDAH ekstraksi (lihat `baca_surat_rapi`,
    yang sengaja tidak menebak kelompok), jadi tanpa penjaga ini setiap surat berpeluang
    menerbitkan promo untuk seluruh katalog principal.
    """
    hasil = resolve_kode_barangs([_baris(kelompok="", kode_barangs="")], MASTER)
    assert len(hasil) == 1, f"baris tanpa kelompok tidak boleh pecah jadi {len(hasil)} baris"
    assert hasil[0]["kode_barangs"] == "", hasil[0]["kode_barangs"]


def test_kelompok_yang_bukan_kelompok_master_juga_tidak_mencocok_semuanya():
    """Kelompok salah ketik/halusinasi jatuh ke jalur yang sama, dan diam-diam.

    Dulu pool kosong (karena tak ada yang cocok) dibalikkan menjadi SELURUH master. Salah ketik
    satu huruf berarti barisnya mengklaim seisi katalog, tanpa satu pun galat.
    """
    hasil = resolve_kode_barangs([_baris(kelompok="OVALE FACIAL LOTIONN", kode_barangs="")], MASTER)
    assert len(hasil) == 1 and hasil[0]["kode_barangs"] == "", hasil


def test_simpan_ulang_pasangan_spray_cologne_tidak_beranak():
    """Spray Cologne Series = WHITE SR (FM) + BLACK SR (HM), dan pasangannya beda merek.

    Separuh pasangan menarik separuh lainnya ke baris pecahan sendiri -- benar sekali. Tetapi
    hasil pecahan itu, disimpan lagi, dulu menarik pasangannya LAGI dan melahirkan kembaran tiap
    Simpan: golden Priskila 53 -> 61 -> 77 -> 109 baris (15 Okt 2026).
    """
    master = {"master": {"items": [
        {"kode_barang": "P2049101010010", "nama_barang": "CSBNCA HM SPRAY COLG BLACK SR BLACK 100ML X 72 BTL",
         "kelompok": "CSBNCA HM - SPRAY COLG - BLACK SR", "variant": "BLACK", "gramasi": "100ML"},
        {"kode_barang": "P2038101010010", "nama_barang": "CSBNCA FM SPRAY COL WHITE SR WHITE 100ML X 72 BTL",
         "kelompok": "CSBNCA FM - SPRAY COL - WHITE SR", "variant": "WHITE", "gramasi": "100ML"},
        # Kelompok ketiga: tanpa ini barisnya mencakup SELURUH master dan jadi ALL KELOMPOK BARANG.
        {"kode_barang": "P2044001010010", "nama_barang": "CSBNCA HM EDP ROYAL 100ML X 24 BTL",
         "kelompok": "CSBNCA HM - EDP", "variant": "ROYAL", "gramasi": "100ML"},
    ]}}
    satu = resolve_kode_barangs(
        [_baris(kelompok="CSBNCA HM - SPRAY COLG - BLACK SR", kode_barangs="P2049101010010")], master)
    dua = resolve_kode_barangs(satu, master)
    bentuk = lambda rows: [(r["id"], r["kelompok"], r["kode_barangs"]) for r in rows]
    assert [r["kode_barangs"] for r in satu] == ["P2049101010010", "P2038101010010"], bentuk(satu)
    assert bentuk(dua) == bentuk(satu), bentuk(dua)
