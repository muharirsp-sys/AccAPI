"""Tujuan: Self-check `gabung_bulan` — satu Summary per principal per bulan, susulan di bawah.
Caller: `python test_summary_bulanan.py` (dijalankan `run_checks.py`). Dependensi: routers.summary_library.
Side Effects: tidak ada. Data meniru publikasi Kino September/Oktober 2026 di produksi.
"""
import sys

sys.path.insert(0, ".")
from routers.summary_library import gabung_bulan  # noqa: E402

K = "KINO NON FOOD"


def baris(surat, mulai, selesai, ket="", principle=K):
    return {"principle": principle, "surat_program": surat, "periode_start": mulai, "periode_end": selesai, "ketentuan": ket}


def surat(rows):
    return [(r["surat_program"], r["ketentuan"]) for r in rows]


def main():
    # Urut terbit: 16 Sep (7664 lama), 16 Sep (7664 terbit ulang + 7713), 26 Sep (NKA 8707 Sep-Des),
    # 1 Okt (8789), lalu grid editor (MSG Okt + Indomaret 8343 Agu-Des + Summary DAHLIA nyasar).
    terbit = [
        [baris("BP2609007664", "2026-09-01", "2026-09-30", "lama")],
        [baris("BP2609007664", "2026-09-01", "2026-09-30", "baru"), baris("BP2609007713", "2026-09-01", "2026-09-30")],
        [baris("BP2609008707", "2026-09-15", "2026-12-31")],
        [baris("BP2610008789", "2026-10-01", "2026-10-31", "a"), baris("BP2610008789", "2026-10-01", "2026-10-31", "b")],
    ]
    editor = [baris("BP2610009095", "2026-10-01", "2026-10-31"), baris("BP2608008343", "2026-08-28", "2026-12-31"),
              baris("570/TMDH1", "2026-09-01", "2026-09-30", principle="DAHLIA")]

    # September: terbit ulang MENGGANTIKAN isi 7664 di tempatnya; surat lintas bulan (8707,
    # 8343) ikut; MSG Oktober dan principal lain tidak; susulan dari grid jatuh paling bawah.
    assert surat(gabung_bulan(terbit + [editor], K, "2026-09-01", "2026-09-30")) == [
        ("BP2609007664", "baru"), ("BP2609007713", ""), ("BP2609008707", ""), ("BP2608008343", "")]

    # Oktober: surat September–Desember yang masih berjalan tetap ada, Summary Oktober yang
    # sudah terbit utuh di atas, tambahan grid di bawahnya.
    assert surat(gabung_bulan(terbit + [editor], K, "2026-10-01", "2026-10-31")) == [
        ("BP2609008707", ""), ("BP2610008789", "a"), ("BP2610008789", "b"), ("BP2610009095", ""), ("BP2608008343", "")]

    # Grid yang memuat ulang surat yang sudah terbit menggantikan isinya, tidak menggandakan.
    ulang = [baris("BP2610008789", "2026-10-01", "2026-10-31", "koreksi")]
    assert surat(gabung_bulan(terbit + [ulang], K, "2026-10-01", "2026-10-31")) == [
        ("BP2609008707", ""), ("BP2610008789", "koreksi")]

    # Baris tanpa nomor surat tidak pernah dileburkan satu sama lain.
    kosong = [baris("", "", "", "x"), baris("", "", "", "y")]
    assert surat(gabung_bulan([kosong], K, "2026-10-01", "2026-10-31")) == [("", "x"), ("", "y")]

    # Draft tujuan unggahan: surat yang MASIH BERJALAN masuk lembar bulan berjalan (susulan Oktober),
    # surat yang sudah lewat atau belum mulai tetap di bulan mulainya.
    from baca_surat_rapi import judul_summary
    hari_ini = "2026-10-02"
    assert judul_summary(K, [baris("x", "2026-08-28", "2026-12-31")], hari_ini) == f"{K} - OKTOBER 2026"
    assert judul_summary(K, [baris("x", "2026-01-01", "2026-12-31")], hari_ini) == f"{K} - OKTOBER 2026"
    assert judul_summary(K, [baris("x", "2026-09-01", "2026-09-30")], hari_ini) == f"{K} - SEPTEMBER 2026"
    assert judul_summary(K, [baris("x", "2026-11-01", "2026-11-30")], hari_ini) == f"{K} - NOVEMBER 2026"
    assert judul_summary(K, [{}], hari_ini) == K
    print("summary bulanan check: OK")


if __name__ == "__main__":
    main()
