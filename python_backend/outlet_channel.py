"""Tujuan: Channel outlet menurut MASTER Accurate, ditanyakan ke Next — bukan disalin ke sini.
Caller: routers/orders.py (`store_order`) saat Order Sales / Order Masuk disimpan.
Dependensi: requests, env NEXT_INTERNAL_URL + CRON_SECRET. Main Functions: channels_of, verify.
Side Effects: HTTP keluar; cache di memori proses, tidak menulis apa pun.

KENAPA DITANYAKAN, BUKAN DISALIN.
Channel outlet adalah dasar keputusan gerbang: surat "KHUSUS CHANNEL GT" hanya boleh jatuh ke
outlet yang master kita sendiri menyebutnya TT. Salinan lokal akan BASI tepat di tempat yang
paling berbahaya — seluruh guna fitur ini adalah menyuruh admin MEMBETULKAN kategori di Accurate,
jadi data yang paling mungkin berubah justru data yang jadi dasar keputusannya. Bekasnya sudah
ada: `sync-item-prices` tidak pernah masuk cron, dan admin yang baru saja memperbaiki harga tetap
melihat barisnya tertahan.

Polanya SAMA PERSIS dengan `_verify_session_via_next` di `shared.py` yang sudah berjalan di
produksi, termasuk aturannya: cache ber-TTL pendek, dan KEGAGALAN JARINGAN TIDAK PERNAH DI-CACHE.

GAGAL TERTUTUP. Tidak ada jawaban berarti ordernya ditahan, bukan diloloskan. Itu satu-satunya
sikap yang masuk akal: kalau kita tidak tahu outlet ini channel apa, kita juga tidak tahu ia
berhak promo yang mana.
"""
import os
import time
from typing import Dict, Iterable, Optional

# Cache-nya SENGAJA pendek. Ia optimisasi, bukan sumber kebenaran: kategori yang baru dibetulkan
# di Accurate harus berlaku hampir seketika, kalau tidak kita cuma memindahkan masalah basi dari
# berkas ke memori.
TTL_DETIK = 60
BATAS_KODE = 200

_CACHE: Dict[str, tuple] = {}


def _base_url() -> str:
    """Alamat Next dari DALAM jaringan container, bukan lewat pintu depan.

    `AUTH_VERIFY_URL` sudah menyimpannya dan sudah terbukti di produksi
    (`http://accapi-frontend:3000/api/auth/verify`), jadi alamatnya diturunkan dari situ
    alih-alih menambah env baru yang harus diingat orang saat deploy — env yang harus di-set
    manual adalah env yang suatu hari lupa di-set, dan gerbang ini gagal tertutup, jadi lupanya
    akan menghentikan order. `NEXT_PUBLIC_APP_URL` sengaja jadi cadangan TERAKHIR: ia alamat
    publik, dan memutarkan panggilan antar-container lewat proxy internet hanya menambah satu
    hal lagi yang bisa mati.
    """
    langsung = os.getenv("NEXT_INTERNAL_URL")
    if langsung:
        return langsung.rstrip("/")
    verify = os.getenv("AUTH_VERIFY_URL") or ""
    if "/api/" in verify:
        return verify.split("/api/", 1)[0].rstrip("/")
    return (os.getenv("NEXT_PUBLIC_APP_URL") or "http://localhost:3000").rstrip("/")


class ChannelTidakPasti(Exception):
    """Channel outlet tidak bisa dipastikan; pemanggil WAJIB menahan, bukan melanjutkan."""


def _dari_cache(kode: str) -> Optional[str]:
    entry = _CACHE.get(kode)
    if entry and entry[0] > time.time():
        return entry[1]
    return None


def channels_of(customer_nos: Iterable[str]) -> Dict[str, str]:
    """Peta kode -> channel ("GT"/"MT"/...). Kode tanpa kategori di master -> string kosong.

    Kode yang TIDAK ADA di master tidak muncul di peta sama sekali; "tidak ada" dan "ada tapi
    kategorinya kosong" adalah dua masalah berbeda dengan dua perbaikan berbeda.
    """
    kode = sorted({str(satu or "").strip() for satu in customer_nos if str(satu or "").strip()})
    if not kode:
        return {}
    if len(kode) > BATAS_KODE:
        raise ChannelTidakPasti(f"Maksimal {BATAS_KODE} outlet sekali tanya")

    hasil = {}
    belum = []
    for satu in kode:
        nilai = _dari_cache(satu)
        if nilai is None:
            belum.append(satu)
        else:
            hasil[satu] = nilai
    if not belum:
        return hasil

    secret = os.getenv("CRON_SECRET")
    if not secret:
        raise ChannelTidakPasti("CRON_SECRET belum di-set, jadi channel outlet tidak bisa ditanyakan ke Next")
    try:
        import requests
        response = requests.get(
            f"{_base_url()}/api/outlet-channel",
            params={"no": ",".join(belum)},
            headers={"Authorization": f"Bearer {secret}"},
            timeout=5,
        )
    except Exception as error:  # jaringan, DNS, timeout
        raise ChannelTidakPasti(f"Tidak bisa menanyakan channel outlet ke Next: {error}") from None
    if response.status_code != 200:
        raise ChannelTidakPasti(f"Next menolak permintaan channel outlet (HTTP {response.status_code})")
    data = response.json()
    if not data.get("ok"):
        raise ChannelTidakPasti("Next tidak menjawab channel outlet")

    channels = data.get("channels") or {}
    sampai = time.time() + TTL_DETIK
    for satu in belum:
        if satu in channels:
            nilai = str(channels[satu] or "")
            _CACHE[satu] = (sampai, nilai)
            hasil[satu] = nilai
        # Yang tidak ada di master TIDAK di-cache: ia bisa muncul begitu master disinkronkan,
        # dan menahannya selama TTL berarti perbaikan orang tidak terasa.
    return hasil


def verify(customer_no: str, channel_diminta: str) -> str:
    """Pastikan channel yang dikirim SAMA dengan yang dikatakan master. Kembalikan channel master.

    Menolak, bukan menggantikan diam-diam. Order yang dikirim sebagai GT padahal outletnya MT
    bukan salah ketik yang boleh dibetulkan sendiri oleh sistem: salah satu dari dua hal itu
    keliru, dan yang mengirimnya harus tahu yang mana.
    """
    kode = str(customer_no or "").strip()
    diminta = str(channel_diminta or "").strip().upper()
    if not kode:
        raise ChannelTidakPasti("Kode pelanggan Accurate wajib diisi untuk memastikan channelnya")

    peta = channels_of([kode])
    if kode not in peta:
        raise ChannelTidakPasti(
            f"Outlet {kode} tidak ada di master pelanggan Accurate, jadi channelnya tidak bisa dipastikan.")
    master = peta[kode]
    if not master:
        raise ChannelTidakPasti(
            f"Outlet {kode} belum punya kategori (TT/MT) di Accurate, jadi channelnya tidak bisa dipastikan. "
            "Isi kategorinya di Accurate lebih dulu.")
    if diminta and diminta != master:
        raise ChannelTidakPasti(
            f"Order dikirim sebagai channel {diminta}, tetapi master Accurate menyimpan outlet {kode} "
            f"sebagai {master}. Promo per channel diputuskan dari master — betulkan channel ordernya, "
            "atau betulkan kategori outletnya di Accurate.")
    return master
