"""Tujuan: Kolom TRIGGER_QTY pada Excel Detail dibaca pembaca yang SAMA dengan aturan terbit.
Caller: pytest python_backend/test_excel_trigger_qty.py. Dependensi: summary_rules. Tanpa I/O.

Kenapa tes ini ada: Excel Detail dulu memakai `parse_number_id` atas SELURUH kalimat ketentuan,
dan fungsi itu membuang semua non-angka. "Setiap pembelian 30 PCS OVALE 2IN1 CLEANSER" karena
itu menjadi 3021 — 30, lalu 2 dan 1 yang terkeruk dari "2IN1". Kolom itu kolom yang sama yang
dimuat ke `promo_rule`, jadi aturannya tersimpan sebagai "beli 3021 PCS": rapi, terlihat benar,
dan tidak pernah cocok dengan potongan mana pun.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from summary_rules import threshold_of


def excel_trigger(ketentuan):
    """Cerminan persis logika kolom TRIGGER_QTY/TRIGGER_UNIT di `shared.py`."""
    if not str(ketentuan or "").strip():
        return "", ""
    jenis, minimum, satuan = threshold_of(ketentuan)
    if jenis == "quantity":
        return minimum, satuan
    if jenis == "value":
        return minimum, "RP"
    return "", ""


def test_angka_dalam_nama_barang_tidak_ikut_terkeruk():
    """Kasus nyata BP2609007664: "2IN1" dulu menempel ke ambangnya jadi 3021."""
    qty, unit = excel_trigger("Setiap pembelian 30 PCS OVALE 2IN1 CLEANSER MIX VARIANT berlaku kelipatan")
    assert (qty, unit) == ("30", "PCS"), (qty, unit)
    assert qty != "3021"

    # Nama barang lain yang mengandung angka tidak boleh menular ke ambangnya.
    assert excel_trigger("Beli 4 PCS BLAGIO HM 100ML & 50ML") == ("4", "PCS")


def test_ambang_rupiah_bersatuan_RP_bukan_PCS():
    assert excel_trigger("Pembelian minimal Rp 1.000.000") == ("1000000", "RP")


def test_tanpa_ambang_menjawab_kosong_bukan_menebak():
    """"Diskon 3% on faktur" dulu terbaca sebagai "beli 3" — persen disangka jumlah beli."""
    assert excel_trigger("Diskon 3% on faktur") == ("", "")
    assert excel_trigger("") == ("", "")
