"""Tujuan: Sidik wajah (embedding SFace, 128 angka) dari swafoto check-in Form Kontrol.
Caller: route Next Form Kontrol — meneruskan cookie sales + byte foto mentah; pembandingan cosine dengan sidik acuan dilakukan di Node.
Dependensi: OpenCV (YuNet deteksi, SFace pengenal), dua model ONNX di WAJAH_MODEL_DIR (diunduh saat build image), shared auth/RBAC.
Main Functions: sidik.
Side Effects: Tidak ada — hitung murni, tidak menyimpan foto maupun sidik. Model dimuat sekali lalu tinggal di memori proses (±40 MB).

Wajah tidak cocok TIDAK menahan kunjungan (hanya ditandai untuk supervisor), jadi endpoint ini wajib tahan foto aneh: tak terbaca = 400,
tanpa wajah = 200 dengan `sidik: null`, model tidak ada = 503 — tidak pernah crash, dan impor modul ini tidak pernah gagal karena model.
"""
import os

# Bom dekompresi: PNG 8 MB bisa berisi 30.000x30.000 piksel (±2,7 GB setelah didekode) dan mematikan backend yang juga melayani
# pembayaran. Batas bawaan OpenCV 1 gigapiksel; 100 MP masih menampung kamera ponsel 50 MP. Wajib di-set SEBELUM `import cv2`.
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(100_000_000))

import asyncio  # noqa: E402
import threading  # noqa: E402
from pathlib import Path  # noqa: E402

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import APIRouter, HTTPException, Request  # noqa: E402

from shared import get_current_user  # noqa: E402

router = APIRouter(prefix="/wajah")

MODEL_DIR = Path(os.getenv("WAJAH_MODEL_DIR") or Path(__file__).resolve().parent.parent / "models")
DETEKTOR = "face_detection_yunet_2023mar.onnx"
PENGENAL = "face_recognition_sface_2021dec.onnx"
BATAS_BYTE = 8 * 1024 * 1024
SISI_MAKS = 1280  # sisi terpanjang sebelum deteksi: VPS 2 core, dan wajah swafoto tetap besar di 1280 px
# YuNet memberi "wajah hantu" (skor 1.0, berubah-ubah antar-run) pada foto yang salah satu sisinya <= 32 px — diukur 16 Nov 2026,
# OpenCV 4.14, foto abu-abu polos & derau. Wajah sekecil itu juga tak berguna bagi SFace (112x112), jadi dianggap tanpa wajah.
SISI_MIN = 64

# ponytail: SATU kunci untuk memuat DAN menjalankan model — objek YuNet/SFace OpenCV tidak aman dipakai dua thread sekaligus
# (setInputSize mengubah state). Plafonnya: satu foto dihitung pada satu waktu (±100–200 ms di 1280 px, diukur lokal). Bila
# antrean check-in pagi terasa, ganti dengan kolam N pasang model (queue.Queue) — bukan model per thread (37 MB x jumlah thread).
_kunci = threading.Lock()
_model = None


def _muat():
    """Pasangan (detektor, pengenal), dimuat sekali. Gagal = None dan TIDAK di-cache: model yang baru dipasang terpakai tanpa restart."""
    global _model
    if _model is None:
        try:
            _model = (cv2.FaceDetectorYN.create(str(MODEL_DIR / DETEKTOR), "", (320, 320), score_threshold=0.8, nms_threshold=0.3,
                                                top_k=5000),
                      cv2.FaceRecognizerSF.create(str(MODEL_DIR / PENGENAL), ""))
        except cv2.error:
            return None
    return _model


def _hitung(raw):
    try:
        foto = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)  # IMREAD_COLOR: orientasi EXIF ponsel ikut diterapkan
    except cv2.error:
        foto = None
    if foto is None:
        raise HTTPException(400, "Foto tidak terbaca")
    tinggi, lebar = foto.shape[:2]
    skala = SISI_MAKS / max(tinggi, lebar)
    if skala < 1:
        foto = cv2.resize(foto, (max(1, round(lebar * skala)), max(1, round(tinggi * skala))), interpolation=cv2.INTER_AREA)
        tinggi, lebar = foto.shape[:2]
    with _kunci:
        model = _muat()
        if model is None:
            raise HTTPException(503, "MODEL_WAJAH_TIDAK_ADA")
        detektor, pengenal = model
        try:
            wajah = None
            if min(lebar, tinggi) >= SISI_MIN:
                detektor.setInputSize((lebar, tinggi))
                wajah = detektor.detect(foto)[1]
            if wajah is None:
                return {"ok": True, "wajah": 0, "sidik": None, "skor": None}
            # Wajah TERBESAR = sales di depan kamera; wajah kecil di latar (pembeli, poster) tidak dipakai.
            pilih = max(wajah, key=lambda baris: baris[2] * baris[3])
            fitur = pengenal.feature(pengenal.alignCrop(foto, pilih))
        except cv2.error:
            raise HTTPException(400, "Foto tidak terbaca") from None
    # Baris YuNet: x, y, w, h, 5 titik wajah (10 angka), skor deteksi di indeks 14.
    return {"ok": True, "wajah": len(wajah), "sidik": [round(float(x), 6) for x in fitur.ravel()], "skor": round(float(pilih[14]), 4)}


@router.post("/sidik")
async def sidik(request: Request):
    # Tanpa CSRF: hitung murni tanpa perubahan state; pemanggilnya server Next yang meneruskan cookie sales.
    # ponytail: cukup sesi login. Izin form_kontrol.submit sudah ditegakkan route check-in Next sebelum memanggil ini, dan Python belum
    # mengenal modul form_kontrol (shared.PERMISSION_MODULES — kode auth, tidak diubah di sini). Pengguna lain yang login hanya bisa
    # menghitung sidik foto MILIKNYA sendiri; tidak ada data yang dibaca/ditulis. Bila kelak perlu, daftarkan form_kontrol di shared.py.
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Silakan login")
    raw = await request.body()
    if not raw:
        raise HTTPException(400, "Foto kosong")
    if len(raw) > BATAS_BYTE:
        raise HTTPException(413, "Foto maksimal 8 MB")
    # Dekode + deteksi ±100 ms CPU: di luar event loop supaya permintaan lain (pembayaran, summary) tidak ikut menunggu.
    return await asyncio.to_thread(_hitung, raw)
