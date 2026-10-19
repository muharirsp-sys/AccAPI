"""Tujuan: Self-check `surat_struktur.nomor_terbawa` -- nomor surat karangan model pada halaman
tanpa kop diganti nomor asli halaman sebelumnya, nomor asli tidak pernah ditimpa.
Caller: `python test_surat_struktur.py` (run_checks). Dependensi: surat_struktur. Side Effects: tidak ada.
Bentuk barisnya = hasil OCR nyata Trade GT Priskila Oktober 2026 (002/PPM/NSPM/X/2026, 9 halaman).
"""
from surat_struktur import nomor_terbawa


def nomor(rows):
    return [r["surat_program"] for r in rows]


def main():
    baris = [{"source_page": 3, "surat_program": "2"}, {"source_page": 7, "surat_program": "M 9.15"},
             {"source_page": 1, "surat_program": "002/PPM/NSPM/X/2026"}, {"source_page": 5, "surat_program": ""}]
    assert nomor_terbawa(baris) == 3 and nomor(baris) == ["002/PPM/NSPM/X/2026"] * 4, baris

    # PDF berisi dua surat: nomor asli halaman 3 tetap miliknya dan didahulukan untuk baris
    # sampah yang tercetak SEBELUMNYA di halaman yang sama; halaman 4 ikut halaman 3.
    dua = [{"source_page": 1, "surat_program": "001/PPM/NSPM/X/2026"}, {"source_page": 3, "surat_program": "2"},
           {"source_page": 3, "surat_program": "003/PPM/NSPM/X/2026"}, {"source_page": 4, "surat_program": ""}]
    nomor_terbawa(dua)
    assert nomor(dua) == ["001/PPM/NSPM/X/2026"] + ["003/PPM/NSPM/X/2026"] * 3, dua

    # Tanggal bukan nomor surat, dan tanpa nomor asli tidak ada yang ditebak ("F149SP" apa adanya).
    sendiri = [{"source_page": 1, "surat_program": "F149SP"}, {"source_page": 2, "surat_program": "01/10/2026"}]
    assert nomor_terbawa(sendiri) == 0 and nomor(sendiri) == ["F149SP", "01/10/2026"], sendiri
    print("OK test_surat_struktur: nomor surat terbawa ke halaman tanpa kop")


if __name__ == "__main__":
    main()
