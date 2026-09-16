"""Tujuan: Mengunci pembacaan periode surat dan penjaga "satu surat = satu periode".
Caller: run_checks.py / pytest. Dependensi: periode_surat, priskila_pipeline.
Main Functions: uji pembacaan, penolakan kalimat klaim, dan pewarisan periode antar blok.
Side Effects: tidak ada.

KENAPA UJI INI ADA. Satu surat Priskila Maret 2026 pulang dengan lima baris ber-`periode`
"September" dan satu "31 Juni 2026" -- tanggal yang tidak ada di kalender -- karena model
menyalin kalimat BATAS KLAIM alih-alih periode program. Tanpa rentang tanggal yang sah,
`compile_programs` menolak barisnya dan draftnya berhenti sebelum jadi `promo_rule`; dengan
rentang yang SALAH, aturan promo berlaku di bulan yang tidak pernah disebut surat. Yang kedua
jauh lebih mahal, jadi yang diuji di sini terutama APA YANG DITOLAK.
"""
from periode_surat import rentang
from priskila_pipeline import _satukan_periode


def test_bulan_penuh():
    assert rentang("MARET 2026") == ("2026-03-01", "2026-03-31")
    assert rentang("Periode September 2026") == ("2026-09-01", "2026-09-30")
    assert rentang("Februari 2024") == ("2024-02-01", "2024-02-29")   # kabisat


def test_rentang_eksplisit():
    assert rentang("1 - 30 September 2026") == ("2026-09-01", "2026-09-30")
    assert rentang("01 Maret 2026 s/d 31 Maret 2026") == ("2026-03-01", "2026-03-31")
    assert rentang("Maret - April 2026") == ("2026-03-01", "2026-04-30")


def test_kalimat_batas_klaim_ditolak():
    """Inti berkas ini: tenggat klaim BUKAN periode program."""
    assert rentang("paling lambat tanggal 31 September 2026") == ("", "")
    assert rentang("31 Juni 2026") == ("", "")        # 31 Juni bukan tanggal
    assert rentang("September") == ("", "")           # tanpa tahun: potongan kalimat
    assert rentang("30 - 1 September 2026") == ("", "")  # mundur


def test_tahun_bawaan_hanya_bila_diberi():
    assert rentang("September") == ("", "")
    assert rentang("September", 2026) == ("2026-09-01", "2026-09-30")


def test_blok_tanpa_periode_mewarisi_periode_suratnya():
    rows = [
        {"surat_program": "002/PPM", "periode": "MARET 2026", "periode_start": "2026-03-01", "periode_end": "2026-03-31"},
        {"surat_program": "002/PPM", "periode": "MARET 2026", "periode_start": "2026-03-01", "periode_end": "2026-03-31"},
        {"surat_program": "002/PPM", "periode": "September", "periode_start": "", "periode_end": ""},
        {"surat_program": "002/PPM", "periode": "31 Juni 2026", "periode_start": "", "periode_end": ""},
    ]
    _satukan_periode(rows)
    assert all(r["periode_start"] == "2026-03-01" and r["periode_end"] == "2026-03-31" for r in rows)
    assert all(r["periode"] == "MARET 2026" for r in rows)


def test_surat_tanpa_satu_pun_tanggal_terbaca_tidak_ditebak():
    """Menebak di sini akan menerbitkan aturan untuk bulan yang tidak pernah disebut surat."""
    rows = [{"surat_program": "LAIN/01", "periode": "September", "periode_start": "", "periode_end": ""}]
    _satukan_periode(rows)
    assert rows[0]["periode_start"] == "" and rows[0]["periode_end"] == ""


def test_surat_berbeda_tidak_saling_mewarisi():
    rows = [
        {"surat_program": "A/1", "periode": "MARET 2026", "periode_start": "2026-03-01", "periode_end": "2026-03-31"},
        {"surat_program": "B/2", "periode": "rusak", "periode_start": "", "periode_end": ""},
    ]
    _satukan_periode(rows)
    assert rows[1]["periode_start"] == "", "periode surat A tidak boleh bocor ke surat B"
