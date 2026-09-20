"""Tujuan: Menjaga agar barang yang DITAHAN tidak lenyap saat baris kembar dibuang di draft.

`summary_store.append_rows` membuang baris yang jati dirinya sama — surat + ketentuan +
benefit, sengaja TANPA kelompok. Itu benar untuk barisnya: satu program tidak boleh tercetak
dua kali. Tetapi `keterangan` adalah satu-satunya tempat barang yang ditahan menyebut namanya,
dan membuangnya berarti barang itu hilang dari Summary SEBELUM Form sempat melihatnya.

Terbukti 20 September 2026: surat `570/TMDH1/8/26#` menahan `F601LB` dan `F601SB`; keenam
barisnya berketentuan seragam "Beli 12 LSN (Boleh Campur)", melebur jadi satu, dan kedua kode
itu tidak muncul di mana pun pada lembar yang ditandatangani. Yang menemukannya gerbang
`tools/verify_form_summary.py` (C9), bukan mata manusia.

Caller: `python test_append_rows_keterangan.py`, dan run_checks.py.
Side Effects: menulis draft ke SQLite sementara; tidak menyentuh produksi.
"""
import os
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
_TMP = tempfile.mkdtemp(prefix="uji_append_")
os.environ["SUMMARY_STORE_PATH"] = str(Path(_TMP) / "uji.sqlite3")
sys.path.insert(0, str(BASE))

from summary_store import append_rows, create_draft, get_draft  # noqa: E402

PENGGUNA = "betterauth|admin|uji@local"


def baris(no, keterangan, kelompok=""):
    """Dua baris yang HANYA berbeda pada kelompok dan keterangan — justru yang dilebur."""
    return {"no": str(no), "surat_program": "570/TMDH1/8/26#", "nama_program": "PROMO",
            "ketentuan": "Beli 12 LSN (Boleh Campur)", "benefit_type": "BONUS_QTY",
            "benefit": "1 LSN", "kelompok": kelompok, "keterangan": keterangan,
            "kode_barangs": "", "channel_gtmt": "GT"}


def main():
    draft = create_draft(PENGGUNA, "UJI", {"rows": [baris(1, "PERLU REVIEW -- kode 'F601LB' tidak ada padanan.")]})
    assert draft is not None, "draft gagal dibuat"

    sesudah = append_rows(draft["id"], PENGGUNA, [
        baris(2, "PERLU REVIEW -- kode 'F601SB' tidak ada padanan."),
        baris(3, "PERLU REVIEW -- kode 'F601LB' tidak ada padanan."),  # sama persis: tidak diulang
    ])
    assert sesudah is not None, "append_rows menolak draft yang sah"
    rows = sesudah["content"]["rows"]

    # Barisnya tetap SATU: satu program tidak boleh tercetak dua kali.
    assert len(rows) == 1, f"{len(rows)} baris, seharusnya 1 — penjaga 'satu program sekali' bocor"

    ket = rows[0]["keterangan"]
    assert "F601LB" in ket, "kode tertahan PERTAMA hilang"
    assert "F601SB" in ket, ("kode tertahan KEDUA hilang — keterangan baris kembar tidak ikut "
                             "digabung, dan baris itu tidak punya kode barang yang menyimpannya")
    assert ket.count("F601LB") == 1, f"keterangan identik diulang: {ket!r}"

    # Draft tersimpan, bukan cuma nilai kembalian.
    tersimpan = get_draft(draft["id"], PENGGUNA)
    assert "F601SB" in tersimpan["content"]["rows"][0]["keterangan"], "gabungan tidak tersimpan"

    print("OK -- keterangan baris kembar ikut tergabung; yang identik tidak diulang")


if __name__ == "__main__":
    main()
