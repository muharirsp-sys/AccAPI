"""Tujuan: Baris hasil baca surat dirapikan sesuai aturan yang memang sudah pasti.
Caller: pytest python_backend/test_baca_surat_rapi.py. Dependensi: baca_surat_rapi. Tanpa I/O.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baca_surat_rapi import rapikan_baris

MASTER = [
    {"kode_barang": "K1", "kelompok": "OVALE FACIAL LOTION", "variant": "ANTI ACNE", "gramasi": "60ML"},
    {"kode_barang": "K2", "kelompok": "OVALE FACIAL LOTION", "variant": "EXTRA MILD", "gramasi": "100ML"},
    {"kode_barang": "K3", "kelompok": "RESIK V", "variant": "MANJAKANI", "gramasi": "90ML"},
]

# Persis yang dikeluarkan OCR untuk BP2609007664.
MENTAH = {
    "principle": "KINO",
    "nama_program": "HPC_TP NAS_PROMO BRAND OVALE 2IN1 CLEANSER PERIODE SEPTEMBER 2026 Kepada Yth. "
                    "Owner / Pimpinan Cabang Subdistributor Dengan hormat, Sehubungan dengan upaya",
    "kelompok": "OVALE 2IN1 CLEANSER MIX VARIANT",
    "variant": "OVALE 2IN1 CLEANSER MIX VARIANT",
    "gramasi": "",
    "keterangan": "",
}


def test_lima_koreksi_tangan_tinggal_satu():
    r = rapikan_baris([MENTAH], MASTER, "KINO NON FOOD")[0]
    assert r["principle"] == "KINO NON FOOD"                     # dipilih orang, bukan ditebak
    assert r["nama_program"] == "HPC_TP NAS_PROMO BRAND OVALE 2IN1 CLEANSER PERIODE SEPTEMBER 2026"
    assert r["variant"] == "ALL VARIANT"                          # tidak menyebut varian tertentu
    assert r["gramasi"] == "ALL GRAMASI"                          # tidak menyebut gramasi tertentu
    # Kelompok yang bukan kelompok master DIKOSONGKAN, bukan ditebak — tetapi katanya disimpan.
    assert r["kelompok"] == ""
    assert "OVALE 2IN1 CLEANSER MIX VARIANT" in r["keterangan"]


def test_varian_yang_memang_disebut_surat_tidak_dilebarkan_jadi_semua():
    """Ini yang paling berbahaya kalau salah: melebarkan promo ke varian yang tidak berhak."""
    r = rapikan_baris([{**MENTAH, "variant": "ANTI ACNE"}], MASTER, "KINO NON FOOD")[0]
    assert r["variant"] == "ANTI ACNE"
    r2 = rapikan_baris([{**MENTAH, "gramasi": "60ML"}], MASTER, "KINO NON FOOD")[0]
    assert r2["gramasi"] == "60ML"


def test_kelompok_yang_sudah_benar_tidak_disentuh():
    r = rapikan_baris([{**MENTAH, "kelompok": "RESIK V"}], MASTER, "KINO NON FOOD")[0]
    assert r["kelompok"] == "RESIK V"
    assert r["keterangan"] == ""


def test_tanpa_principle_terpilih_tebakan_model_dibiarkan():
    r = rapikan_baris([MENTAH], MASTER, "")[0]
    assert r["principle"] == "KINO"
