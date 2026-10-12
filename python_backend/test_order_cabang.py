"""Tujuan: Mengunci jembatan aturan cabang + harga ke Next (O1) — terutama caranya GAGAL dan jalur sesi vs layanan.
Caller: `python test_order_cabang.py` (tanpa framework; juga lewat run_checks). Dependensi: order_cabang.
Main Functions: main. Side Effects: tidak ada jaringan — modul `requests` dipalsukan di sys.modules.

Yang dijaga: (1) cookie kosong TIDAK pernah jatuh ke CRON_SECRET (jalur tanpa cakupan cabang salesman); (2) penolakan berkode Next
sampai ke pemanggil apa adanya; (3) jawaban rusak / tanpa harga / tidak cocok baris = TIDAK PASTI, bukan diloloskan; (4) harga klien
ditimpa harga server, kecuali `harga=False` (input internal).
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


LINES = [{"code": "A1", "unit": "krt", "quantity": "2", "price": "999999"}, {"code": "B2", "unit": "PCS", "quantity": "5"}]
OK = {"ok": True, "lines": [{"code": "A1", "unit": "KRT", "quantity": "2", "price": "456000"},
                            {"code": "B2", "unit": "PCS", "quantity": "5", "price": "1200.5"}]}


def harus(galat, fn):
    try:
        fn()
    except galat as error:
        return error
    raise AssertionError(f"seharusnya {galat.__name__}")


def main():
    os.environ["NEXT_INTERNAL_URL"] = "http://next.uji:3000"

    # Layanan tanpa CRON_SECRET: tidak pasti, tidak ada panggilan.
    os.environ.pop("CRON_SECRET", None)
    pasang(200, OK)
    harus(OrderCabangTidakPasti, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES))
    assert KIRIM == []

    # Layanan dengan secret: Bearer, alamat Next internal, harga server MENIMPA harga klien, kuantitas/satuan asli tetap.
    os.environ["CRON_SECRET"] = "rahasia"
    hasil = order_cabang.periksa("C-1", "2026-10-12", LINES)
    kirim = KIRIM[-1]
    assert kirim["url"] == "http://next.uji:3000/api/orders/harga", kirim
    assert kirim["headers"] == {"Authorization": "Bearer rahasia"}, kirim["headers"]
    assert kirim["json"]["harga"] is True and kirim["json"]["customer_no"] == "C-1", kirim["json"]
    assert [line["unit"] for line in kirim["json"]["lines"]] == ["KRT", "PCS"] and "price" not in kirim["json"]["lines"][0]
    assert [line["price"] for line in hasil] == ["456000", "1200.5"], hasil
    assert hasil[0]["quantity"] == "2" and hasil[0]["unit"] == "krt", hasil

    # Sesi: cookie diteruskan, TANPA Authorization — juga saat cookie kosong (Next menjawab 401 -> ditolak), walau CRON_SECRET ada.
    order_cabang.periksa("C-1", "2026-10-12", LINES, cookie="better-auth.session_token=abc")
    assert KIRIM[-1]["headers"] == {"cookie": "better-auth.session_token=abc"}, KIRIM[-1]["headers"]
    pasang(401, {"error": "Unauthorized"})
    e = harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES, cookie=""))
    assert KIRIM[-1]["headers"] == {"cookie": ""} and e.status == 401 and e.kode == "DITOLAK", (KIRIM[-1], e.kode)

    # Penolakan berkode Next sampai apa adanya, dengan rinciannya, dalam bentuk jawaban FastAPI.
    pasang(409, {"ok": False, "kode": "BARANG_BEDA_CABANG", "error": "Barang bukan barang cabang KINO", "barang": [{"code": "A1"}]})
    e = harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES))
    assert (e.status, e.kode) == (409, "BARANG_BEDA_CABANG"), (e.status, e.kode)
    assert e.isi() == {"ok": False, "detail": "Barang bukan barang cabang KINO", "kode": "BARANG_BEDA_CABANG", "barang": [{"code": "A1"}]}
    pasang(403, {"ok": False, "kode": "SALESMAN_BELUM_TERHUBUNG", "error": "Akun belum terhubung"})
    assert harus(OrderCabangDitolak, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES, cookie="x")).kode == "SALESMAN_BELUM_TERHUBUNG"

    # Tidak pasti: 5xx, bukan JSON, jaringan, ok palsu, jumlah/urutan baris tidak cocok, harga kosong.
    for status, data, gagal in [(500, {"error": "galat"}, None), (502, "<html>", None), (200, {}, OSError("putus")),
                                (200, {"ok": False}, None), (200, {"ok": True, "lines": OK["lines"][:1]}, None),
                                (200, {"ok": True, "lines": list(reversed(OK["lines"]))}, None),
                                (200, {"ok": True, "lines": [OK["lines"][0], {**OK["lines"][1], "price": ""}]}, None),
                                (200, {"ok": True, "lines": [OK["lines"][0], {**OK["lines"][1], "price": None}]}, None),
                                (400, "bukan json", None)]:
        pasang(status, data, gagal)
        harus(OrderCabangTidakPasti, lambda: order_cabang.periksa("C-1", "2026-10-12", LINES))

    # harga=False (input internal): hanya aturan cabang; baris & harga petugas kembali apa adanya.
    pasang(200, {"ok": True, "lines": [{**line, "price": ""} for line in OK["lines"]]})
    hasil = order_cabang.periksa("C-1", "2026-10-12", LINES, harga=False)
    assert KIRIM[-1]["json"]["harga"] is False
    assert hasil == LINES and hasil is not LINES, hasil
    print("order cabang bridge check: OK", json.dumps(len(KIRIM)))


if __name__ == "__main__":
    main()
