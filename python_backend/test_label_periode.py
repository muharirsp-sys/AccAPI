"""Tujuan: Kolom "Periode" pada Form Summary terisi, dan tidak menyembunyikan separuh periodenya.
Caller: pytest python_backend/test_label_periode.py. Dependensi: shared. Side Effects: tidak ada.

Kenapa tes ini ada: pembuat PDF membaca kunci `periode`, sedangkan baris draft menyimpan
`periode_start`/`periode_end` — dan tidak ada yang pernah menulis `periode`. Akibatnya kolom
Periode KOSONG di setiap Form Summary yang pernah dicetak, tanpa satu galat pun.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shared import _label_periode


def test_satu_bulan_penuh_ditulis_sebagai_nama_bulannya():
    assert _label_periode("2026-09-01", "2026-09-30") == "SEPTEMBER 2026"
    assert _label_periode("2026-03-01", "2026-03-31") == "MARET 2026"
    # Sebagian bulan tetap bulan itu; yang dibaca orang adalah bulannya.
    assert _label_periode("2026-09-05", "2026-09-20") == "SEPTEMBER 2026"


def test_lintas_bulan_tidak_diringkas_jadi_satu_bulan():
    """Meringkasnya akan MENYEMBUNYIKAN separuh periode — diskon bisa dinilai di bulan salah."""
    hasil = _label_periode("2026-09-15", "2026-10-15")
    assert "SEP" in hasil and "OKT" in hasil, hasil


def test_tanggal_tidak_lengkap_menjawab_kosong_bukan_menebak():
    for a, b in [("", "2026-09-30"), ("2026-09-01", ""), (None, None), ("bukan tanggal", "2026-09-30")]:
        assert _label_periode(a, b) == ""
