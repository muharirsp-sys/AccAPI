"""Tujuan: Satu Summary tidak boleh memuat program yang sama dua kali.
Caller: pytest python_backend/test_append_rows.py. Dependensi: summary_store (SQLite sementara).
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _baris(surat, ketentuan="Beli 30 PCS", benefit="1 PCS"):
    return {"surat_program": surat, "ketentuan": ketentuan, "benefit_type": "BONUS_QTY",
            "benefit": benefit, "kelompok": "", "kode_barangs": ""}


def test_program_yang_sama_tidak_disusulkan_dua_kali():
    """Terbukti perlu: menyusulkan surat kedua sempat membawa satu salinan surat PERTAMA."""
    with tempfile.TemporaryDirectory() as temp:
        lama = os.environ.get("SUMMARY_STORE_PATH")
        os.environ["SUMMARY_STORE_PATH"] = str(Path(temp) / "uji.sqlite3")
        try:
            import importlib
            import summary_store
            importlib.reload(summary_store)

            draft = summary_store.create_draft("uji@x", "KINO NON FOOD - SEPTEMBER 2026",
                                               {"rows": [_baris("BP2609007664")], "master": {"items": []}})
            # Surat kedua datang membawa 4 barisnya SENDIRI plus satu salinan surat pertama.
            hasil = summary_store.append_rows(draft["id"], "uji@x", [
                _baris("BP2609007664"),
                *[_baris("BP2609007713", f"Beli 30 PCS varian {i}") for i in range(1, 5)],
            ])
            rows = hasil["content"]["rows"]
            assert len(rows) == 5, [r["surat_program"] + "|" + r["ketentuan"] for r in rows]
            assert sum(1 for r in rows if r["surat_program"] == "BP2609007664") == 1
            assert sum(1 for r in rows if r["surat_program"] == "BP2609007713") == 4
            # Nomor barisnya disusun ulang supaya pesan "Baris N" menunjuk yang benar.
            assert [r["no"] for r in rows] == ["1", "2", "3", "4", "5"]

            # Program yang BEDA ketentuannya tetap masuk — penjaga ini bukan penyaring surat.
            hasil2 = summary_store.append_rows(draft["id"], "uji@x", [_baris("BP2609007664", "Beli 60 PCS")])
            assert len(hasil2["content"]["rows"]) == 6
        finally:
            if lama is None:
                os.environ.pop("SUMMARY_STORE_PATH", None)
            else:
                os.environ["SUMMARY_STORE_PATH"] = lama
