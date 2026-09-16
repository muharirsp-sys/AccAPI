"""Tujuan: Menjalankan SELURUH self-check `python_backend/test_*.py` sebagai satu gerbang.
Caller: `npm run test:python`, dan alur CI `deploy.yml` sebelum image dibangun.
Dependensi: hanya pustaka standar; tiap berkas uji dijalankan sebagai proses sendiri.
Main Functions: main; keluar dengan kode 1 begitu ada satu uji yang gagal.
Side Effects: menjalankan uji anak (SQLite sementara); tidak memanggil Accurate maupun Mistral.

KENAPA BERKAS INI ADA.
Sampai 16 September 2026 repo ini punya 21 self-check Python dan 72 uji TypeScript, dan TIDAK ADA
SATU PUN yang dijalankan CI — `deploy.yml` hanya `npm run lint` lalu `tsc --noEmit`, lalu
membangun image dan men-deploy. Akibatnya bukan teori: empat self-check sudah rusak di `main`
tanpa ada yang tahu, salah satunya `test_e2e_live` — satu-satunya uji yang benar-benar
menghasilkan Form PDF dan Dataset Excel dari surat sungguhan. Ia mati sejak `main.py` dipecah
menjadi router. Selama itu jalur Summary diperbaiki sebelas kali, satu per satu, lewat mata
manusia di layar produksi.

Menjalankan uji sebagai PROSES TERPISAH disengaja: tiap self-check menulis `os.environ` dan
menambal modul global (auth, channel outlet) di tingkat impor. Dalam satu proses mereka akan
saling mewarisi tambalan, dan uji yang lulus karena tambalan tetangganya lebih buruk daripada
uji yang tidak ada.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent

# Uji yang MEMBUTUHKAN LAYANAN HIDUP, beserta sebabnya. Sengaja daftar tertutup dan bernama:
# pengecualian yang tidak disebut alasannya akan tumbuh sampai gerbangnya tidak menjaga apa pun.
BUTUH_LAYANAN = {}

# `test_e2e_live` memanggil Mistral bila cache-nya kosong. Ia TIDAK dikecualikan — ia melewat
# sendiri dengan sebabnya bila tak ada kunci API dan tak ada cache, jadi di CI ia gratis dan di
# mesin pengembang ia benar-benar menguji.

# Modul yang menyimpan self-check-nya SENDIRI di bawah `if __name__ == "__main__"`, bukan di
# berkas `test_*.py`. Mereka ikut dijalankan karena justru di sinilah cacat termahal bersembunyi:
# self-check `deterministic_output` membuktikan Excel-nya byte-identik antar-run, tetapi sampai
# 16 September 2026 ia TIDAK pernah membuka ulang berkasnya — dan berkas yang dihasilkannya
# memang corrupt. A/B tool (`ab_*`) sengaja TIDAK di sini: ia menuntut kunci API dan argumen.
# Sebagian modul ini belum masuk git (alat bantu lokal); yang tidak ada DILEWATI dengan
# sebabnya, bukan menggagalkan gerbang — CI tidak boleh menuntut berkas yang tidak dikirim.
SELF_CHECK_MODUL = [
    "correction_store.py",
    "deterministic_output.py",
    "golden_store.py",
    "ocr_cache.py",
    "ocr_text_compare.py",
    "parse_cache.py",
    "tier_parser.py",
    "variant_resolver.py",
]

BATAS_DETIK = int(os.getenv("CHECK_TIMEOUT", "600"))


def main():
    modul = []
    for nama in SELF_CHECK_MODUL:
        jalur = BASE / nama
        if jalur.is_file():
            modul.append(jalur)
        else:
            print(f"LEWAT  {nama:<34} tidak ada di pohon kerja ini")
    berkas = sorted(BASE.glob("test_*.py")) + modul
    if not berkas:
        print("Tidak ada self-check yang ditemukan — itu sendiri sebuah kegagalan.")
        return 1

    gagal = []
    for satu in berkas:
        nama = satu.name
        if nama in BUTUH_LAYANAN:
            print(f"LEWAT  {nama:<34} {BUTUH_LAYANAN[nama]}")
            continue
        mulai = time.time()
        try:
            hasil = subprocess.run([sys.executable, str(satu)], cwd=str(BASE), capture_output=True,
                                   text=True, timeout=BATAS_DETIK)
        except subprocess.TimeoutExpired:
            print(f"GAGAL  {nama:<34} melebihi {BATAS_DETIK} detik")
            gagal.append((nama, f"timeout {BATAS_DETIK}s"))
            continue
        lama = time.time() - mulai
        if hasil.returncode == 0:
            print(f"OK     {nama:<34} {lama:5.1f}s")
        else:
            print(f"GAGAL  {nama:<34} {lama:5.1f}s")
            gagal.append((nama, (hasil.stdout + hasil.stderr).strip()[-2000:]))

    if gagal:
        print(f"\n{len(gagal)} dari {len(berkas)} self-check GAGAL:\n")
        for nama, pesan in gagal:
            print(f"--- {nama} ---\n{pesan}\n")
        return 1
    print(f"\nSeluruh {len(berkas) - len(BUTUH_LAYANAN)} self-check Python lulus.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
