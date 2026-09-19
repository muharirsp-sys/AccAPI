# Tujuan: Penyedia baris template Excel untuk workflow payments LPB lengkap.
# Caller: python_backend/main.py saat endpoint template download dipanggil.
# Dependensi: typing standar Python.
# Main Functions: lpb_upload_template_rows.
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
            "TGL INVOICE": "2026-02-05",
            "NO INVOICE": "INV/2602/0001",
            "NILAI INVOICE": 12500000,
            "J.T INVOICE": "2026-03-05",
            "ACTUAL DATE": "2026-02-05",
            "TGL PEMBAYARAN": "",
            "JENIS DOKUMEN": "",
            "NOMOR DOKUMEN": "",
            "KETERANGAN": "Contoh LPB lengkap; kolom setelah TGL TERIMA BARANG boleh dikosongkan jika belum ada invoice.",
        }
    ]


