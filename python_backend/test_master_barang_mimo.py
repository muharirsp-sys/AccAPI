"""Tujuan: Mengunci jawaban Master Barang atas galat MiMo, tanpa jaringan (httpx.MockTransport).
Yang dikunci: 402/401/429 menjadi ValueError berpesan jelas (router mengembalikannya sebagai 422),
bukan "Gagal mengekstrak" umum; jawaban sukses {"items": [...]} tetap terbaca. Dijalankan run_checks.py."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["MIMO_API_KEY"] = "dummy"
import httpx  # noqa: E402
from routers import master_barang  # noqa: E402

_REAL = httpx.AsyncClient


def run(status, body):
    master_barang.httpx.AsyncClient = lambda **kw: _REAL(transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body)), **kw)
    try:
        return asyncio.run(master_barang._vision_extract([(1, b"jpeg")], ""))
    finally:
        master_barang.httpx.AsyncClient = _REAL


def main():
    for status, kata in ((402, "Saldo akun MiMo habis"), (401, "ditolak"), (429, "kuota paket habis")):
        try:
            run(status, {"error": {"message": "x"}})
        except ValueError as error:
            assert kata in str(error), (status, str(error))
        else:
            raise AssertionError(f"HTTP {status} harus menjadi ValueError")
    ok = run(200, {"choices": [{"message": {"content": '{"items": [{"namaBarang": "BELLAGIO EDT 100ML", "isiCtn": "24"}]}'}}]})
    assert len(ok) == 1 and ok[0]["gramasi"] == "100 ML" and ok[0]["isiCtn"] == "24", ok
    print("master barang MiMo PASSED (402/401/429 berpesan jelas; jawaban sukses terbaca)")


if __name__ == "__main__":
    main()
