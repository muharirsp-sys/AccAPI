"""Tujuan: Aturan order per cabang Accurate + harga server, DITANYAKAN ke Next (O1, owner 12 Okt 2026) — bukan disalin ke sini.
Caller: routers/orders.py `hitung_order` (simpan Order Baru, simpan Order Sales dengan cookie sesi sales -> cakupan cabang salesman,
tarik Order Masuk lewat CRON_SECRET -> semua cabang).
Dependensi: requests, env NEXT_INTERNAL_URL/AUTH_VERIFY_URL (alamat Next, sama dengan outlet_channel) + CRON_SECRET.
Main Functions: periksa, periksa_bonus, harga_petugas_sah. Side Effects: HTTP keluar ke Next `/api/orders/harga`; tidak menulis apa pun,
tanpa cache.

KENAPA DITANYAKAN: FastAPI tidak punya akses ke Postgres (master pelanggan/barang/cabang/harga ada di sana), dan harga + cabang adalah
dasar uang faktur — salinan lokal akan basi tepat di tempat yang mahal. Polanya sama dengan `outlet_channel`.

GAGAL TERTUTUP. Next menolak (4xx berkode) -> `OrderCabangDitolak` (order itu ditolak dengan sebabnya). Next tak terjangkau / 5xx /
jawaban rusak / secret ditolak -> `OrderCabangTidakPasti` (pemanggil menahan, tidak meneruskan tanpa harga).

HARGA (putaran 1 + owner sesi 13, 12 Okt 2026): per baris. `price` kosong = harga MASTER dari Next (wajib > 0; Next hanya memberi harga
daftar Accurate cabang pelanggan/default). `price` diisi = harga PETUGAS (Order Baru; pemanggil yang memastikan izinnya) — HANYA untuk
baris TANPA harga master sah (Next menolak 409 `HARGA_PETUGAS_TIDAK_DIIZINKAN`, diteruskan apa adanya), wajib > 0 (ditolak di sini
sebelum jaringan), dikirim apa adanya dan HARUS kembali sama. Hasil tiap baris membawa `sumber_harga` = "petugas" | "master".
"""
import logging
import os
import re
from decimal import Decimal, InvalidOperation

from outlet_channel import _base_url

BATAS_DETIK = 10
LOG = logging.getLogger("accapi.order_cabang")


class OrderCabangDitolak(Exception):
    """Order ini DITOLAK dengan kode (mis. BARANG_BEDA_CABANG, HARGA_BELUM_ADA, PRATINJAU_BERUBAH, CHANNEL_BEDA_MASTER)."""

    def __init__(self, status, kode, pesan, extra=None):
        super().__init__(pesan)
        self.status, self.kode, self.pesan, self.extra = int(status), str(kode), str(pesan), dict(extra or {})

    def isi(self):
        """Badan jawaban FastAPI: `detail` (dibaca layar lama) + `kode` dan rincian (barang/missing/wrong_unit) untuk layar baru."""
        return {"ok": False, "detail": self.pesan, "kode": self.kode, **self.extra}


class OrderCabangTidakPasti(Exception):
    """Aturan cabang/harga tidak bisa dipastikan; pemanggil WAJIB menahan (503), bukan melanjutkan atau menolak permanen."""

    def __init__(self, pesan, kode="LAYANAN_TIDAK_PASTI"):
        super().__init__(pesan)
        self.pesan, self.kode = str(pesan), str(kode)

    def isi(self):
        return {"ok": False, "detail": self.pesan, "kode": self.kode}


# Bentuk sama dengan Next (lib/order-cabang HARGA_PETUGAS): angka biasa, maksimal 4 desimal — tanpa eksponen/tanda/pemisah ribuan.
HARGA_PETUGAS = re.compile(r"\d{1,12}(?:\.\d{1,4})?")


def positif(teks):
    """Angka terbatas > 0 dari teks, atau None. Dipakai untuk harga master yang dijawab Next."""
    try:
        nilai = Decimal(str(teks).strip())
    except (InvalidOperation, ValueError):
        return None
    return nilai if nilai.is_finite() and nilai > 0 else None


def harga_petugas_sah(teks):
    """Harga ketikan petugas: angka biasa > 0 (bentuk HARGA_PETUGAS). Selain itu None (pemanggil menolak `HARGA_TIDAK_VALID`)."""
    teks = str(teks).strip()
    return positif(teks) if HARGA_PETUGAS.fullmatch(teks) else None


def _tanya(badan, cookie):
    """POST /api/orders/harga; kembalikan jawaban 200 `ok`. Gagal: `OrderCabangDitolak` (4xx berkode) / `OrderCabangTidakPasti`.

    `cookie` bukan None = sesi pemakai (Order Sales): Next menerapkan cakupan cabang salesman — cookie KOSONG tetap jalur sesi (Next
    menjawab 401 -> ditolak), TIDAK pernah jatuh ke CRON_SECRET yang tanpa cakupan. `cookie=None` = layanan (CRON_SECRET).
    """
    layanan = cookie is None
    if not layanan:
        headers = {"cookie": cookie}
    else:
        secret = os.getenv("CRON_SECRET")
        if not secret:
            raise OrderCabangTidakPasti("CRON_SECRET belum di-set, jadi cabang & harga order tidak bisa ditanyakan ke Next",
                                        kode="KONFIGURASI_SERVER")
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
    # Jalur LAYANAN ditolak 401/403 = CRON_SECRET FastAPI != Next (konfigurasi), BUKAN sesi pemakai berakhir dan BUKAN penolakan order:
    # menolak permanen di sini membuat permintaan Web Sales sah tercatat "ditolak" dan layar berkata "sesi login berakhir".
    if layanan and response.status_code in (401, 403):
        LOG.error("Next menolak CRON_SECRET FastAPI di /api/orders/harga (HTTP %s): samakan CRON_SECRET frontend dan backend",
                  response.status_code)
        raise OrderCabangTidakPasti("Konfigurasi server: Next menolak kunci layanan FastAPI (CRON_SECRET berbeda). Order TIDAK disimpan; "
                                    "hubungi admin sistem.", kode="KONFIGURASI_SERVER")
    if 400 <= response.status_code < 500 and isinstance(data, dict) and data.get("error"):
        extra = {k: v for k, v in data.items() if k not in ("ok", "error", "kode")}
        raise OrderCabangDitolak(response.status_code, data.get("kode") or "DITOLAK", data["error"], extra)
    if response.status_code != 200 or not isinstance(data, dict) or not data.get("ok"):
        raise OrderCabangTidakPasti(f"Next tidak menjawab pemeriksaan cabang & harga order (HTTP {response.status_code})")
    return data


def periksa_bonus(customer_no, order_date, codes, cookie=None):
    """Barang BONUS promo wajib bisa diorder untuk pelanggan ini (O1 putaran 2, butir 7): ada, tidak suspended, cabang = cabang pelanggan.

    Keputusannya di Next (`periksaBonus`, sama dengan pratinjau); gagal = `OrderCabangDitolak` 409 `BONUS_TIDAK_BISA_DIORDER` apa
    adanya — order itu DITOLAK, bonusnya tidak dibuang diam-diam. Dipanggil hanya bila hasil promo memuat bonus berkode.
    """
    kode = sorted({str(c or "").strip() for c in codes if str(c or "").strip()})
    if kode:
        _tanya({"customer_no": str(customer_no or "").strip(), "order_date": str(order_date or "").strip(), "lines": [], "bonus": kode}, cookie)


def periksa(customer_no, order_date, lines, cookie=None):
    """Periksa order di Next; kembalikan baris yang sama dengan `price` + `sumber_harga` (urutan = masukan). Jalur sesi/layanan: `_tanya`."""
    kirim = []
    for line in lines:
        baris = {"code": str(line.get("code", "")).strip(), "unit": str(line.get("unit", "")).strip().upper(),
                 "quantity": str(line.get("quantity", "")).strip()}
        petugas = str(line.get("price", "") or "").strip()
        if petugas:
            if harga_petugas_sah(petugas) is None:
                raise OrderCabangDitolak(400, "HARGA_TIDAK_VALID",
                                         f"Harga {baris['code']} harus angka lebih dari 0 (diisi: {petugas[:20]}). Kosongkan untuk memakai harga master.")
            baris["price"] = petugas
        kirim.append(baris)
    data = _tanya({"customer_no": str(customer_no or "").strip(), "order_date": str(order_date or "").strip(), "lines": kirim}, cookie)

    jawab = data.get("lines")
    if not isinstance(jawab, list) or len(jawab) != len(lines):
        raise OrderCabangTidakPasti("Jawaban harga Next tidak cocok dengan baris order")
    hasil = []
    for line, dikirim, item in zip(lines, kirim, jawab):
        if not isinstance(item, dict) or str(item.get("code", "")) != dikirim["code"] or str(item.get("unit", "")) != dikirim["unit"]:
            raise OrderCabangTidakPasti("Jawaban harga Next tidak cocok dengan baris order")
        price = str(item.get("price", "") if item.get("price") is not None else "").strip()
        sumber = str(item.get("sumber_harga", ""))
        # Baris tanpa harga petugas = harga master; `master_default` = master dari cabang DEFAULT (fallback, putaran 2 butir 9).
        boleh = ("petugas",) if "price" in dikirim else ("master", "master_default")
        if sumber not in boleh or (sumber == "petugas" and price != dikirim["price"]):
            # Harga petugas TIDAK pernah ditimpa; Next yang menjawab lain = jawaban yang tidak bisa dipercaya.
            raise OrderCabangTidakPasti(f"Jawaban harga Next untuk {dikirim['code']} tidak sesuai harga yang dikirim")
        if positif(price) is None:
            # Harga master 0/kosong/negatif tidak pernah boleh menjadi order: faktur Rp 0 tidak bisa ditarik (butir 3).
            raise OrderCabangDitolak(409, "HARGA_BELUM_ADA", f"Harga {dikirim['code']} {dikirim['unit']} dari master tidak sah ({price or 'kosong'}).",
                                     {"missing": [dikirim["code"]]})
        hasil.append({**line, "price": price, "sumber_harga": sumber})
    return hasil
