"""Tujuan: Aturan order per cabang Accurate + harga server, DITANYAKAN ke Next (O1, owner 12 Okt 2026) — bukan disalin ke sini.
Caller: routers/websales.py (`POST /websales/orders`, cookie sesi sales -> cakupan cabang salesman), routers/orders.py (`store_order`:
Order Baru internal + tarikan Web Sales, CRON_SECRET -> semua cabang).
Dependensi: requests, env NEXT_INTERNAL_URL/AUTH_VERIFY_URL (alamat Next, sama dengan outlet_channel) + CRON_SECRET.
Main Functions: periksa. Side Effects: HTTP keluar ke Next `/api/orders/harga`; tidak menulis apa pun, tanpa cache.

KENAPA DITANYAKAN: FastAPI tidak punya akses ke Postgres (master pelanggan/barang/cabang/harga ada di sana), dan harga + cabang adalah
dasar uang faktur — salinan lokal akan basi tepat di tempat yang mahal. Polanya sama dengan `outlet_channel`.

GAGAL TERTUTUP. Next menolak (4xx berkode) -> `OrderCabangDitolak` (order itu ditolak dengan sebabnya). Next tak terjangkau / 5xx /
jawaban rusak -> `OrderCabangTidakPasti` (pemanggil menahan, tidak meneruskan tanpa harga).
"""
import os

from outlet_channel import _base_url

BATAS_DETIK = 10


class OrderCabangDitolak(Exception):
    """Next menolak order ini dengan kode (mis. BARANG_BEDA_CABANG, HARGA_BELUM_ADA, SALESMAN_BELUM_TERHUBUNG)."""

    def __init__(self, status, kode, pesan, extra=None):
        super().__init__(pesan)
        self.status, self.kode, self.pesan, self.extra = int(status), str(kode), str(pesan), dict(extra or {})

    def isi(self):
        """Badan jawaban FastAPI: `detail` (dibaca layar lama) + `kode` dan rincian (barang/missing/wrong_unit) untuk layar baru."""
        return {"ok": False, "detail": self.pesan, "kode": self.kode, **self.extra}


class OrderCabangTidakPasti(Exception):
    """Aturan cabang/harga tidak bisa dipastikan; pemanggil WAJIB menahan, bukan melanjutkan."""


def periksa(customer_no, order_date, lines, cookie=None, harga=True):
    """Periksa order di Next; kembalikan baris yang sama dengan `price` server (atau apa adanya bila `harga=False`).

    `cookie` bukan None = sesi pemakai (Order Sales): Next menerapkan cakupan cabang salesman — cookie KOSONG tetap jalur sesi (Next
    menjawab 401 -> ditolak), TIDAK pernah jatuh ke CRON_SECRET yang tanpa cakupan. `cookie=None` = layanan (CRON_SECRET).
    `harga=False` = hanya aturan cabang; input internal membawa harga petugas sendiri dan tidak ditimpa.
    """
    badan = {"customer_no": str(customer_no or "").strip(), "order_date": str(order_date or "").strip(), "harga": bool(harga),
             "lines": [{"code": str(line.get("code", "")).strip(), "unit": str(line.get("unit", "")).strip().upper(),
                        "quantity": str(line.get("quantity", "")).strip()} for line in lines]}
    if cookie is not None:
        headers = {"cookie": cookie}
    else:
        secret = os.getenv("CRON_SECRET")
        if not secret:
            raise OrderCabangTidakPasti("CRON_SECRET belum di-set, jadi cabang & harga order tidak bisa ditanyakan ke Next")
        headers = {"Authorization": f"Bearer {secret}"}
    try:
        import requests
        response = requests.post(f"{_base_url()}/api/orders/harga", json=badan, headers=headers, timeout=BATAS_DETIK)
    except Exception as error:  # jaringan, DNS, timeout
        raise OrderCabangTidakPasti(f"Tidak bisa menanyakan cabang & harga order ke Next: {error}") from None
    try:
        data = response.json()
    except ValueError:
        data = None
    if 400 <= response.status_code < 500 and isinstance(data, dict) and data.get("error"):
        extra = {k: v for k, v in data.items() if k not in ("ok", "error", "kode")}
        raise OrderCabangDitolak(response.status_code, data.get("kode") or "DITOLAK", data["error"], extra)
    if response.status_code != 200 or not isinstance(data, dict) or not data.get("ok"):
        raise OrderCabangTidakPasti(f"Next tidak menjawab pemeriksaan cabang & harga order (HTTP {response.status_code})")

    jawab = data.get("lines")
    if not isinstance(jawab, list) or len(jawab) != len(lines):
        raise OrderCabangTidakPasti("Jawaban harga Next tidak cocok dengan baris order")
    hasil = []
    for line, item in zip(lines, jawab):
        sama = (str(item.get("code", "")) == str(line.get("code", "")).strip()
                and str(item.get("unit", "")) == str(line.get("unit", "")).strip().upper())
        if not sama:
            raise OrderCabangTidakPasti("Jawaban harga Next tidak cocok dengan baris order")
        if not harga:
            hasil.append(dict(line))
            continue
        price = str(item.get("price", "")).strip()
        if not price or price in ("None", "null"):
            raise OrderCabangTidakPasti(f"Next menjawab tanpa harga untuk {line.get('code')}")
        hasil.append({**line, "price": price})
    return hasil
