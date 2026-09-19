"""Tujuan: Menjaga penyambung `routers.summary.deterministic_extraction` -- satu loop yang
mencoba beberapa parser deterministik sebelum OCR. Yang diuji BUKAN isi parsernya (itu tugas
test_dahlia_letter/test_vinda_letter/test_primarasa_letter), melainkan tiga sifat loopnya:
  1. Surat sampai ke parser yang BENAR; tidak ada parser yang membajak surat principal lain.
  2. Surat yang bukan milik siapa pun -> None, supaya jalur OCR tetap jalan.
  3. Masukan rusak -> None, bukan pengecualian yang merobohkan endpoint.
Caller: `python test_deterministic_extraction.py`, dan run_checks.py.
Dependensi: surat asli di reference_surat_program/sept26 + master di master_barang_principle.
Side Effects: hanya membaca berkas; tidak memanggil AI, tidak menyentuh DB.
"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SEPT = REPO / "reference_surat_program" / "sept26"
MASTERS = REPO / "master_barang_principle"
sys.path.insert(0, str(BASE))

from routers.summary import deterministic_extraction  # noqa: E402
from shared import _parse_master_barang_xlsx  # noqa: E402

# (surat, master, modul yang HARUS mengakuinya)
KASUS = [
    ("570-11410 (C62) - PROMO NASIONAL GT GROSIR KHUSUS ITEM REJUVE SEPT 2026 - SULAWESI 1.pdf",
     "MASTER BARANG DAHLIA.xlsx", "deterministic:dahlia_letter"),
    ("13. SKP Strata disc GT  LKA  Jul-Sep'26.pdf",
     "MASTER BARANG VINDA.xlsx", "deterministic:vinda_letter"),
    ("re-Surat Program Diskon Spesial Collins 06 Mei 2026.pdf",
     "MASTER BARANG PRIMARASA.xlsx", "deterministic:primarasa_letter"),
]


def master_of(name):
    *_, items = _parse_master_barang_xlsx((MASTERS / name).read_bytes())
    return {"items": items}


def main():
    tersedia = [k for k in KASUS if (SEPT / k[0]).exists() and (MASTERS / k[1]).exists()]
    if not tersedia:
        print("LEWAT -- surat/master rujukan tidak ada di klona ini")
        return

    for surat, master_name, modul in tersedia:
        raw = (SEPT / surat).read_bytes()
        master = master_of(master_name)
        hasil = deterministic_extraction(raw, master)
        assert hasil is not None, f"{surat}: tidak ada parser yang mengakuinya"
        assert hasil["model"] == modul, f"{surat}: diakui {hasil['model']}, seharusnya {modul}"
        assert hasil["rows"], f"{surat}: diakui {modul} tetapi nol baris"
        # Sifat 1 sisi lain: surat ini diuji dengan master principal LAIN pun tidak boleh
        # berpindah parser -- yang menentukan pemiliknya adalah bentuk suratnya, bukan masternya.
        for _, master_lain, _ in tersedia:
            if master_lain == master_name:
                continue
            silang = deterministic_extraction(raw, master_of(master_lain))
            assert silang is None or silang["model"] == modul, (
                f"{surat} berpindah ke {silang['model']} saat dipakaikan {master_lain}")

    kosong = {"items": []}
    assert deterministic_extraction(b"bukan pdf sama sekali", kosong) is None
    assert deterministic_extraction(b"", kosong) is None
    # PDF sah tetapi bukan milik siapa pun: pakai surat principal lain yang memang
    # tidak punya parser (URC), harus jatuh ke OCR, bukan dibajak.
    asing = SEPT / "020 - Loyalty JRM (Jack n Jill Member Red) Q3 2026.pdf"
    if asing.exists():
        assert deterministic_extraction(asing.read_bytes(), kosong) is None, (
            "surat tanpa parser dibajak; jalur OCR jadi tidak pernah jalan")

    print(f"OK -- {len(tersedia)} surat diakui parser yang benar, tanpa pembajakan silang")


if __name__ == "__main__":
    main()
