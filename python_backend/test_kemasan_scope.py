"""Tujuan: Self-check penyaring SATUAN KEMASAN pada resolver kelompok master.
Caller: `python test_kemasan_scope.py`, run_checks. Dependensi: shared.
Main Functions: main. Side Effects: tidak ada; master di bawah dibuat di memori.

KENAPA DIMENSI INI ADA. Master membedakan dua SKU yang kelompok, varian, DAN gramasinya sama
persis hanya lewat satuan kemasannya:

    K1100007000110  KNF ELLIPS H.VIT SHINY BLACK 1ML X 72 BLR
    K1100007000140  KNF ELLIPS H.VIT SHINY BLACK 1ML X 12 JAR

Surat pun menyebutnya begitu — `BP2609007909` berbunyi "ELLIPS HAIR VITAMIN JAR ON PO 3%".
Tanpa penyaring ini baris itu mustahil dinyatakan di layar: apa pun yang dipilih operator akan
menarik KEDUANYA, dan separuh kodenya salah. Delapan dari sebelas SKU ELLIPS berkemasan JAR
punya kembaran semacam ini.
"""
import sys

sys.path.insert(0, ".")
from shared import _apply_native_kelompok, kemasan_of  # noqa: E402

MASTER = [
    {"kode_barang": "K-BLR", "nama_barang": "KNF ELLIPS H.VIT SHINY BLACK 1ML X 72 BLR",
     "kelompok": "ELLIPS", "variant": "H.VIT SHINY BLACK", "gramasi": "1ML"},
    {"kode_barang": "K-JAR", "nama_barang": "KNF ELLIPS H.VIT SHINY BLACK 1ML X 12 JAR",
     "kelompok": "ELLIPS", "variant": "H.VIT SHINY BLACK", "gramasi": "1ML"},
    {"kode_barang": "K-KLG", "nama_barang": "KNF ELLIPS DRY SHAMPOO BLOSSOM 200ML X 24 KLG",
     "kelompok": "ELLIPS", "variant": "DRY SHAMPOO BLOSSOM", "gramasi": "200ML"},
]


def kode(rows):
    return sorted(k.strip() for r in rows for k in str(r.get("kode_barangs", "")).split(",") if k.strip())


def baris(**lebih):
    return {"no": "1", "kelompok": "ELLIPS", "variant": "ALL VARIANT", "gramasi": "ALL GRAMASI",
            "kode_barangs": "", "surat_program": "BP2609007909", "ketentuan": "Setiap pembelian",
            "benefit_type": "DISC_PCT", "benefit": "3", **lebih}


def main():
    assert kemasan_of("KNF ELLIPS H.VIT SHINY BLACK 1ML X 12 JAR") == "JAR"
    assert kemasan_of("KNF ELLIPS H.VIT SHINY BLACK 1ML X 72 BLR") == "BLR"
    assert kemasan_of("KNF ELLIPS DRY SHAMPOO BLOSSOM 200ML X 24 KLG") == "KLG"
    # Nama tanpa ekor kemasan tidak dikarang jadi satuan apa pun.
    assert kemasan_of("KNF ELLIPS SESUATU 1ML") == ""
    assert kemasan_of(None) == ""

    # Tanpa kemasan = perilaku lama, seluruh kelompok ikut.
    assert kode(_apply_native_kelompok([baris()], MASTER)) == ["K-BLR", "K-JAR", "K-KLG"]

    # KEMASAN JAR MENYARING KEMBARANNYA. Inilah satu-satunya pembeda K-BLR dan K-JAR:
    # kelompok, varian, dan gramasinya sama persis.
    assert kode(_apply_native_kelompok([baris(kemasan="JAR")], MASTER)) == ["K-JAR"]
    assert kode(_apply_native_kelompok([baris(kemasan="BLR")], MASTER)) == ["K-BLR"]

    # "ALL KEMASAN" berarti semua, sama seperti ALL GRAMASI.
    assert kode(_apply_native_kelompok([baris(kemasan="ALL KEMASAN")], MASTER)) == ["K-BLR", "K-JAR", "K-KLG"]

    # Beberapa kemasan sekaligus, dipisah koma.
    assert kode(_apply_native_kelompok([baris(kemasan="JAR,KLG")], MASTER)) == ["K-JAR", "K-KLG"]

    # Kemasan yang tidak ada di master TIDAK jatuh ke "semua" — gagal tertutup, sama seperti
    # kelompok yang tidak dikenal. Kemasan salah ketik yang diam-diam menarik seluruh kelompok
    # adalah cara paling sunyi untuk memberi diskon ke SKU yang tidak disebut surat.
    assert kode(_apply_native_kelompok([baris(kemasan="SACHET")], MASTER)) == []

    print("kemasan scope check: OK")


if __name__ == "__main__":
    main()
