"""Tujuan: Mengunci jembatan aturan cabang + harga ke Next (O1) — terutama caranya GAGAL dan jalur sesi vs layanan.
Caller: `python test_order_cabang.py` (tanpa framework; juga lewat run_checks). Dependensi: order_cabang.
Main Functions: main. Side Effects: tidak ada jaringan — modul `requests` dipalsukan di sys.modules.

Yang dijaga: (1) cookie kosong TIDAK pernah jatuh ke CRON_SECRET (jalur tanpa cakupan cabang salesman); (2) penolakan berkode Next
sampai ke pemanggil apa adanya; (3) jawaban rusak / tanpa harga / tidak cocok baris = TIDAK PASTI, bukan diloloskan; (4) harga klien
tanpa izin tidak pernah terkirim: baris tanpa `price` = harga MASTER server, baris ber-`price` = harga PETUGAS yang tidak pernah
ditimpa; (5) putaran 1: harga <= 0 ditolak (petugas sebelum jaringan, master dari Next), secret layanan ditolak Next = KONFIGURASI
(503, bukan "ditolak"/"sesi berakhir").
"""
import json
import os
import sys
import types

import order_cabang
from order_cabang import OrderCabangDitolak, OrderCabangTidakPasti

KIRIM = []


class Jawab:
    def __init__(self, status, data):
        self.status_code, self._data = status, data

    def json(self):
        if isinstance(self._data, str):
            raise ValueError("bukan JSON")
        return self._data


def pasang(status=200, data=None, gagal=None):
    def post(url, json=None, headers=None, timeout=None):
        KIRIM.append({"url": url, "json": json, "headers": dict(headers or {}), "timeout": timeout})
        if gagal:
            raise gagal
        return Jawab(status, data)
    sys.modules["requests"] = types.SimpleNamespace(post=post)


# Baris master (tanpa price) — harga klien dari Web Sales tidak pernah sampai ke sini (websales membuangnya).
LINES = [{"code": "A1", "unit": "krt", "quantity": "2"}, {"code": "B2", "unit": "PCS", "quantity": "5"}]
OK = {"ok": True, "lines": [{"code": "A1", "unit": "KRT", "quantity": "2", "price": "456000", "sumber_harga": "master"},
                            {"code": "B2", "unit": "PCS", "quantity": "5", "price": "1200.5", "sumber_harga": "master"}]}


def harus(galat, fn):
    try:
        fn()
    except galat as error:
        return error
    raise AssertionError(f"seharusnya {galat.__name__}")


def main():
    os.environ["NEXT_INTERNAL_URL"] = "http://next.uji:3000"

    # Layanan tanpa CRON_SECRET: tidak pasti (konfigurasi), tidak ada panggilan.
    os.environ.pop("CRON_SECRET", None)
    pasang(200, OK)
    e = harus(OrderCabangTidakPasti, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES))
    assert e.kode == "KONFIGURASI_SERVER" and KIRIM == [], (e.kode, KIRIM)

    # Layanan dengan secret: Bearer, alamat Next internal, harga MASTER server, kuantitas/satuan asli tetap.
    os.environ["CRON_SECRET"] = "rahasia"
    hasil = order_cabang.periksa("C-1", "2026-10-12", LINES)
    kirim = KIRIM[-1]
    assert kirim["url"] == "http://next.uji:3000/api/orders/harga", kirim
    assert kirim["headers"] == {"Authorization": "Bearer rahasia"}, kirim["headers"]
    assert kirim["json"]["customer_no"] == "C-1" and "harga" not in kirim["json"], kirim["json"]
    assert [line["unit"] for line in kirim["json"]["lines"]] == ["KRT", "PCS"] and "price" not in kirim["json"]["lines"][0]
    assert [line["price"] for line in hasil] == ["456000", "1200.5"], hasil
    assert [line["sumber_harga"] for line in hasil] == ["master", "master"], hasil
    assert hasil[0]["quantity"] == "2" and hasil[0]["unit"] == "krt", hasil

    # Harga PETUGAS (Order Baru): dikirim per baris, kembali SAMA, bertanda petugas; baris lain harga master.
    campur = [{**LINES[0], "price": " 450000 "}, LINES[1]]
    pasang(200, {"ok": True, "lines": [{**OK["lines"][0], "price": "450000", "sumber_harga": "petugas"}, OK["lines"][1]]})
    hasil = order_cabang.periksa("C-1", "2026-10-12", campur)
    assert [line.get("price") for line in KIRIM[-1]["json"]["lines"]] == ["450000", None], KIRIM[-1]["json"]
    assert [(line["price"], line["sumber_harga"]) for line in hasil] == [("450000", "petugas"), ("1200.5", "master")], hasil
    # Next yang "membetulkan" harga petugas = jawaban yang tidak bisa dipercaya (harga petugas TIDAK pernah ditimpa).
    for salah in ({**OK["lines"][0], "price": "456000", "sumber_harga": "petugas"}, {**OK["lines"][0], "price": "450000"}):
        pasang(200, {"ok": True, "lines": [salah, OK["lines"][1]]})
        harus(OrderCabangTidakPasti, lambda: order_cabang.periksa("C-1", "2026-10-12", campur))
    # Harga petugas <= 0 / bukan angka / eksponen DITOLAK sebelum jaringan (butir 7).
    for buruk in ("0", "0.00", "-5", "abc", "1e3", "1.23456", "12,5"):
        sebelum = len(KIRIM)
        e = harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", [{**LINES[0], "price": buruk}]))
        assert (e.status, e.kode) == (400, "HARGA_TIDAK_VALID") and len(KIRIM) == sebelum, (buruk, e.kode)
    # Harga MASTER <= 0 dari Next ditolak berkode (butir 3: tanggal mundur -> "0" -> draft -> faktur 0).
    for nol in ("0", "-1", "0.0"):
        pasang(200, {"ok": True, "lines": [{**OK["lines"][0], "price": nol}, OK["lines"][1]]})
        e = harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES))
        assert (e.status, e.kode, e.extra) == (409, "HARGA_BELUM_ADA", {"missing": ["A1"]}), (nol, e.kode)

    # Sesi: cookie diteruskan, TANPA Authorization — juga saat cookie kosong (Next menjawab 401 -> ditolak), walau CRON_SECRET ada.
    pasang(200, OK)
    order_cabang.periksa("C-1", "2026-10-12", LINES, cookie="better-auth.session_token=abc")
    assert KIRIM[-1]["headers"] == {"cookie": "better-auth.session_token=abc"}, KIRIM[-1]["headers"]
    pasang(401, {"error": "Unauthorized"})
    e = harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES, cookie=""))
    assert KIRIM[-1]["headers"] == {"cookie": ""} and e.status == 401 and e.kode == "DITOLAK", (KIRIM[-1], e.kode)

    # Butir 5: jalur LAYANAN ditolak 401/403 = CRON_SECRET beda -> TIDAK PASTI berkode konfigurasi (503), bukan penolakan order.
    for status in (401, 403):
        pasang(status, {"error": "Unauthorized"})
        e = harus(OrderCabangTidakPasti, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES))
        assert e.kode == "KONFIGURASI_SERVER" and "CRON_SECRET" in e.pesan, (status, e.kode, e.pesan)
        assert e.isi() == {"ok": False, "detail": e.pesan, "kode": "KONFIGURASI_SERVER"}

    # Penolakan berkode Next sampai apa adanya, dengan rinciannya, dalam bentuk jawaban FastAPI.
    pasang(409, {"ok": False, "kode": "BARANG_BEDA_CABANG", "error": "Barang bukan barang cabang KINO", "barang": [{"code": "A1"}]})
    e = harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES))
    assert (e.status, e.kode) == (409, "BARANG_BEDA_CABANG"), (e.status, e.kode)
    assert e.isi() == {"ok": False, "detail": "Barang bukan barang cabang KINO", "kode": "BARANG_BEDA_CABANG", "barang": [{"code": "A1"}]}
    # Owner sesi 13: harga petugas pada baris berharga master -> Next 409 berkode + rincian per baris, diteruskan apa adanya.
    pasang(409, {"ok": False, "kode": "HARGA_PETUGAS_TIDAK_DIIZINKAN", "error": "Harga master sudah ada",
                 "barang": [{"code": "A1", "unit": "KRT", "hargaMaster": 456000}]})
    e = harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", [{**LINES[0], "price": "450000"}]))
    assert (e.status, e.kode, e.extra) == (409, "HARGA_PETUGAS_TIDAK_DIIZINKAN", {"barang": [{"code": "A1", "unit": "KRT", "hargaMaster": 456000}]}), e.extra
    pasang(403, {"ok": False, "kode": "SALESMAN_BELUM_TERHUBUNG", "error": "Akun belum terhubung"})
    assert harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES, cookie="x")).kode == "SALESMAN_BELUM_TERHUBUNG"

    # Tidak pasti: 5xx, bukan JSON, jaringan, ok palsu, jumlah/urutan baris tidak cocok, harga/sumber kosong.
    for status, data, gagal in [(500, {"error": "galat"}, None), (502, "<html>", None), (200, {}, OSError("putus")),
                                (200, {"ok": False}, None), (200, {"ok": True, "lines": OK["lines"][:1]}, None),
                                (200, {"ok": True, "lines": list(reversed(OK["lines"]))}, None),
                                (200, {"ok": True, "lines": [OK["lines"][0], {**OK["lines"][1], "sumber_harga": ""}]}, None),
                                (200, {"ok": True, "lines": [OK["lines"][0], "bukan objek"]}, None),
                                (400, "bukan json", None)]:
        pasang(status, data, gagal)
        e = harus(OrderCabangTidakPasti, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES))
        assert e.kode == "LAYANAN_TIDAK_PASTI", (status, e.kode)
    # Harga kosong / None dari Next = harga tidak sah (ditolak berkode), bukan diloloskan.
    for kosong in ("", None):
        pasang(200, {"ok": True, "lines": [OK["lines"][0], {**OK["lines"][1], "price": kosong}]})
        assert harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES)).kode == "HARGA_BELUM_ADA"
    # Putaran 2 (butir 9): harga master dari cabang DEFAULT bertanda `master_default` — diterima untuk baris master, tidak untuk petugas.
    pasang(200, {"ok": True, "lines": [OK["lines"][0], {**OK["lines"][1], "sumber_harga": "master_default"}]})
    assert [line["sumber_harga"] for line in order_cabang.periksa("C-1", "2026-10-12", LINES)] == ["master", "master_default"]
    pasang(200, {"ok": True, "lines": [{**OK["lines"][0], "price": "450000", "sumber_harga": "master_default"}, OK["lines"][1]]})
    harus(OrderCabangTidakPasti, lambda: order_cabang.periksa("C-1", "2026-10-12", [{**LINES[0], "price": "450000"}, LINES[1]]))

    # Putaran 2 (butir 7): bonus — kode unik terurut, baris kosong, jalur sesi/layanan sama; tanpa bonus = tanpa panggilan; 409 apa adanya.
    sebelum = len(KIRIM)
    order_cabang.periksa_bonus("C-1", "2026-10-12", ["", None, " "])
    assert len(KIRIM) == sebelum, "tanpa bonus berkode tidak bertanya ke Next"
    pasang(200, {"ok": True, "lines": [], "bonus": ["K-03", "K-09"]})
    order_cabang.periksa_bonus("C-1", "2026-10-12", ["K-09", " K-03 ", "K-09"], cookie="sesi=1")
    assert KIRIM[-1]["json"] == {"customer_no": "C-1", "order_date": "2026-10-12", "lines": [], "bonus": ["K-03", "K-09"]}, KIRIM[-1]
    assert KIRIM[-1]["headers"] == {"cookie": "sesi=1"}
    pasang(409, {"ok": False, "kode": "BONUS_TIDAK_BISA_DIORDER", "error": "Barang bonus tidak bisa diorder",
                 "bonus": [{"code": "H-01", "alasan": "barang cabang HEINZ"}]})
    e = harus(OrderCabangDitolak, lambda: order_cabang.periksa_bonus("C-1", "2026-10-12", ["H-01"]))
    assert (e.status, e.kode, e.extra) == (409, "BONUS_TIDAK_BISA_DIORDER", {"bonus": [{"code": "H-01", "alasan": "barang cabang HEINZ"}]})
    pasang(401, {"error": "Unauthorized"})
    assert harus(OrderCabangTidakPasti, lambda: order_cabang.periksa_bonus("C-1", "2026-10-12", ["H-01"])).kode == "KONFIGURASI_SERVER"
    print("order cabang bridge check: OK", json.dumps(len(KIRIM)))


if __name__ == "__main__":
    main()
