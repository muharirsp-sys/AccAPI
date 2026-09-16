"""Tujuan: Registry master principle bertahan, dan kegagalannya BERSUARA.
Caller: pytest python_backend/test_principles_registry.py. Dependensi: shared, tempfile.
Main Functions: dua test. Side Effects: SQLite di folder sementara; tanpa produksi.

Kenapa tes ini ada: dua kegagalan senyap bertumpuk di produksi sampai 2026-09-16 dan membuat
jalur Summary Promo mustahil dipakai. Tabel `principles` tidak pernah dibuat, jadi setiap
pembacaan jatuh ke `except` telanjang dan menjawab "belum ada principle" — jawaban yang sama
persis dengan jawaban yang benar. Yang diuji di sini bukan "bisa menyimpan", melainkan bahwa
KEDUA kegagalan itu tidak bisa kembali diam-diam.
"""
import tempfile
from pathlib import Path

import shared


def _pakai_folder_sementara(temp):
    shared.PRINCIPLES_DB_PATH = str(Path(temp) / "data" / "principles.sqlite3")


def test_registry_hidup_di_folder_yang_belum_ada():
    """Folder `data/` yang belum ada bukan galat: ia dibuat, bukan ditabrak."""
    lama = shared.PRINCIPLES_DB_PATH
    with tempfile.TemporaryDirectory() as temp:
        try:
            _pakai_folder_sementara(temp)
            assert not Path(shared.PRINCIPLES_DB_PATH).parent.exists()

            # Baca pertama pada registry kosong = kosong, bukan meledak.
            assert shared._load_principles() == {}

            shared._save_principles({"p1": {
                "name": "KINO NON FOOD", "filename": "p1_MASTER.xlsx",
                "uploaded_by": "ari@superadmin.com", "created_at": "2026-09-16"}})
            balik = shared._load_principles()
            assert list(balik) == ["p1"]
            assert balik["p1"]["name"] == "KINO NON FOOD"
            assert balik["p1"]["filename"] == "p1_MASTER.xlsx"

            # Ditulis ke BERKAS, bukan cuma memori: itu inti perbaikannya.
            assert Path(shared.PRINCIPLES_DB_PATH).exists()
        finally:
            shared.PRINCIPLES_DB_PATH = lama


def test_registry_rusak_berteriak_bukan_menjawab_kosong():
    """"Tidak bisa dibaca" TIDAK boleh terlihat sama dengan "belum ada principle"."""
    lama = shared.PRINCIPLES_DB_PATH
    with tempfile.TemporaryDirectory() as temp:
        try:
            jalur = Path(temp) / "data" / "principles.sqlite3"
            jalur.parent.mkdir(parents=True)
            jalur.write_bytes(b"ini jelas bukan basis data sqlite")
            shared.PRINCIPLES_DB_PATH = str(jalur)
            try:
                shared._load_principles()
            except Exception:
                pass
            else:
                raise AssertionError("registry rusak dijawab kosong — kegagalan senyap kembali")
        finally:
            shared.PRINCIPLES_DB_PATH = lama
