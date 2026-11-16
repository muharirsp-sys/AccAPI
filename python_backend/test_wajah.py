"""Tujuan: Self-check endpoint sidik wajah Form Kontrol (POST /wajah/sidik): izin, foto ditolak, dan perilaku model.
Caller: `python test_wajah.py` via run_checks.py, dan pytest.
Dependensi: routers.wajah, FastAPI TestClient, OpenCV + numpy (foto sintetis — TIDAK ada foto orang sungguhan di repo).
Main Functions: test_sesi, test_foto_ditolak, test_model; main.
Side Effects: Tidak ada — auth ditambal, tanpa jaringan; model dibaca dari WAJAH_MODEL_DIR bila ada.

Model TIDAK diunduh di CI, jadi uji model berlaku dua arah: tanpa model wajib 503 MODEL_WAJAH_TIDAK_ADA; dengan model, foto tanpa
orang wajib `wajah: 0, sidik: null`. Jalur 503 tetap diuji di mesin yang punya model, dengan mengarahkan MODEL_DIR ke folder kosong.
"""
import tempfile
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import wajah

SALES = {"X-Test-User": "sales@surya.local"}

# Cukup sesi login (izin form_kontrol.submit ditegakkan route check-in Next sebelum memanggil endpoint ini; lihat routers/wajah.py).
wajah.get_current_user = lambda request: request.headers.get("X-Test-User") or None
app = FastAPI()
app.include_router(wajah.router)
client = TestClient(app)


def png(lebar, tinggi):
    """Gradien abu-abu tanpa orang."""
    baris = np.linspace(0, 255, lebar).astype(np.uint8)
    return cv2.imencode(".png", np.dstack([np.tile(baris, (tinggi, 1))] * 3))[1].tobytes()


def kirim(isi, headers=SALES):
    return client.post("/wajah/sidik", content=isi, headers={**headers, "Content-Type": "application/octet-stream"})


def test_sesi():
    assert kirim(png(64, 64), headers={}).status_code == 401


def test_foto_ditolak():
    assert kirim(b"").status_code == 400
    sampah = kirim(b"bukan foto" * 100)
    assert sampah.status_code == 400 and sampah.json()["detail"] == "Foto tidak terbaca", sampah.text
    assert kirim(b"\0" * (wajah.BATAS_BYTE + 1)).status_code == 413


def test_model():
    asli = wajah.MODEL_DIR
    wajah.MODEL_DIR, wajah._model = Path(tempfile.mkdtemp(prefix="wajah-kosong-")), None
    try:
        kosong = kirim(png(64, 64))
    finally:
        wajah.MODEL_DIR = asli
    assert kosong.status_code == 503 and kosong.json()["detail"] == "MODEL_WAJAH_TIDAK_ADA", kosong.text

    hasil = kirim(png(2600, 1950))  # > 1280 px: jalur perkecil ikut dilewati
    if not all((asli / nama).is_file() for nama in (wajah.DETEKTOR, wajah.PENGENAL)):
        assert hasil.status_code == 503 and hasil.json()["detail"] == "MODEL_WAJAH_TIDAK_ADA", hasil.text
        print(f"catatan: model wajah tidak ada di {asli}; hanya jalur 503 yang diuji, deteksi tidak")
        return
    assert hasil.status_code == 200 and hasil.json() == {"ok": True, "wajah": 0, "sidik": None, "skor": None}, hasil.text
    for lebar, tinggi in ((1, 1), (1280, 32)):  # sisi <= 32 px: YuNet memberi wajah hantu skor 1.0 (lihat SISI_MIN)
        tipis = kirim(png(lebar, tinggi))
        assert tipis.status_code == 200 and tipis.json()["wajah"] == 0, (lebar, tinggi, tipis.text)


if __name__ == "__main__":
    test_sesi()
    test_foto_ditolak()
    test_model()
    print("OK test_wajah")
