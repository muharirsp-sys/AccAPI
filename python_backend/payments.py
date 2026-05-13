# Tujuan: Penyedia baris template Excel untuk workflow payments dan validator.
# Caller: python_backend/main.py saat endpoint template download dipanggil.
# Dependensi: typing standar Python.
# Main Functions: lpb_upload_template_rows, validator_sales_template_rows, validator_promo_template_rows, validator_channel_template_rows.
# Side Effects: Tidak ada; hanya mengembalikan struktur data template.

from typing import Any, Dict, List


def lpb_upload_template_rows() -> List[Dict[str, Any]]:
    return [
        {
            "TGL. SETOR": "2026-02-01",
            "NO. LPB": "LPB/2602/0001",
            "TGL. WIN": "2026-02-01",
            "TGL. J. TEMPO WIN": "2026-03-03",
            "PRINCIPLE": "CONTOH PRINCIPLE",
            "NILAI WIN": 12500000,
            "TGL TERIMA BARANG": "2026-02-02",
        }
    ]


def validator_sales_template_rows() -> List[Dict[str, Any]]:
    return [
        {
            "INVOICENO": "INV/2602/001",
            "INVOICEDATE": "2026-02-01",
            "SUB": "SUB A",
            "BRG": "ITEM001",
            "QTY": 10,
            "UNIT": "PCS",
            "PACKAGING": "1",
            "QTYPCS": 10,
            "GROSSAMOUNT": 2500000,
            "DISC_PCT": "10+5",
            "DISC_AMT": 300000,
            "MDSTRING": "10%+5%",
        }
    ]


def validator_promo_template_rows() -> List[Dict[str, Any]]:
    return [
        {
            "KODE_BARANG": "ITEM001",
            "PROMO_LABEL": "PROMO CONTOH",
            "PROMO_GROUP": "STD",
            "PROMO_GROUP_ID": "NON_GROUP",
            "TRIGGER_UNIT": "PCS",
            "MIN_QTY": 1,
            "MAX_QTY": 999999,
            "BENEFIT_TYPE": "DISC_PCT",
            "BENEFIT_VALUE": "10+5",
        }
    ]


def validator_channel_template_rows() -> List[Dict[str, Any]]:
    return [
        {
            "SUB": "SUB A",
            "CHANNEL": "GT",
        }
    ]
