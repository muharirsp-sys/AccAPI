"""Tujuan: Menjaga agar penggabungan baris Form Summary tidak MENGHILANGKAN barang.

Baris yang sama persis pada surat/ketentuan/benefit dilebur jadi satu baris cetak. Untuk baris
yang punya kode barang itu aman -- `kode_barangs` menyimpan semuanya. Untuk baris yang DITAHAN
(kode tidak cocok ke master) `kode_barangs` kosong, sehingga `keterangan` adalah SATU-SATUNYA
tempat barang itu menyebut namanya. Sampai 19 September 2026 hanya keterangan baris pertama yang
disimpan: surat DAHLIA 570 menahan `F601LB` dan `F601SB`, keduanya melebur, dan `F601SB` tidak
muncul sama sekali di Form yang ditandatangani Operational Manager.

Caller: `python test_keterangan_merge.py`, dan run_checks.py.
Dependensi: routers.summary (endpoint sungguhan), reportlab. Side Effects: menulis PDF sementara
ke folder keluaran manual; tidak menyentuh DB, tidak memanggil AI.
"""
import json
import os
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
os.environ["SUMMARY_STORE_PATH"] = str(BASE / "data" / "test_keterangan_merge.sqlite3")
sys.path.insert(0, str(BASE))

from starlette.datastructures import Headers  # noqa: E402
from routers import summary as backend  # noqa: E402
from shared import MANUAL_MASTER_CACHE, MANUAL_OUTPUTS  # noqa: E402
from summary_store import identity  # noqa: E402

PENGGUNA = "betterauth|admin|uji@local"
TOKEN = "uji-keterangan-merge"


class FakeRequest:
    headers = Headers({})
    cookies = {}


def baris(no, keterangan, kode=""):
    """Dua baris yang HANYA berbeda pada keterangan (dan kodenya) -- justru yang dilebur."""
    return {
        "no": str(no), "principle": "UJI", "surat_program": "570/TMDH1/8/26#",
        "nama_program": "PROMO NASIONAL GT GROSIR", "channel_gtmt": "GT GROSIR",
        "periode_start": "2026-09-01", "periode_end": "2026-09-30",
        "kelompok": "", "variant": "ALL VARIANT", "gramasi": "", "kode_barangs": kode,
        "ketentuan": "Beli 12 LSN (Boleh Campur)", "benefit_type": "BONUS_QTY", "benefit": "1 LSN",
        "syarat_claim": "", "keterangan": keterangan, "outlet_classes": "", "outlet_mode": "",
        "channel_list": "", "source_page": 1, "source_quote": "uji",
    }


def teks_pdf(file_id):
    import pypdf
    import re
    jalur = MANUAL_OUTPUTS[file_id]["form"]
    with open(jalur, "rb") as f:
        halaman = pypdf.PdfReader(f).pages
        return re.sub(r"\s+", " ", "\n".join((h.extract_text() or "") for h in halaman))


def main():
    backend.get_current_user = lambda request: PENGGUNA
    backend.user_has_permission = lambda *a, **k: True
    backend.validate_csrf_request = lambda request, token: True
    MANUAL_MASTER_CACHE[TOKEN] = {"owner": identity(PENGGUNA), "kelompok": [], "variant_map": {},
                                  "gramasi_map": {}, "items": [], "customers": [],
                                  "principle_name": "UJI"}

    rows = [
        baris(1, "PERLU REVIEW MANUAL -- kode 'F601LB' tidak ada padanan persis di master."),
        baris(2, "PERLU REVIEW MANUAL -- kode 'F601SB' tidak ada padanan persis di master."),
    ]
    hasil = backend.summary_manual_generate(FakeRequest(), token=TOKEN, rows_json=json.dumps(rows))
    assert hasil.get("ok"), f"generate gagal: {hasil}"
    teks = teks_pdf(hasil["file_id"])
    assert "F601LB" in teks, "kode tertahan pertama hilang dari Form"
    assert "F601SB" in teks, ("kode tertahan KEDUA hilang dari Form -- keterangan baris yang "
                              "dilebur tidak ikut digabung, dan baris itu tidak punya kode barang "
                              "yang bisa menyimpannya")

    # Boilerplate yang sama persis TIDAK diulang: penggabungan menghilangkan duplikat, bukan
    # menumpuk kalimat yang sama sepuluh kali di satu sel sempit.
    sama = "Disc. Reg Dist 3% - 5% = beban distributor, bukan benefit principal."
    kembar = [baris(1, sama), baris(2, sama)]
    hasil2 = backend.summary_manual_generate(FakeRequest(), token=TOKEN, rows_json=json.dumps(kembar))
    assert hasil2.get("ok"), f"generate kedua gagal: {hasil2}"
    teks2 = teks_pdf(hasil2["file_id"])
    assert teks2.count("beban distributor") == 1, (
        f"boilerplate identik tercetak {teks2.count('beban distributor')}x, seharusnya sekali")

    print("OK -- keterangan baris yang dilebur ikut tergabung; yang identik tidak diulang")


if __name__ == "__main__":
    main()
