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
import re
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

# CARA MENJALANKANNYA MENENTUKAN APAKAH IA MENGUJI SAMA SEKALI.
# Berkas bergaya pytest — hanya `def test_*()` tanpa `if __name__ == "__main__"` — TIDAK
# menjalankan apa pun bila dipanggil `python berkas.py`: Python mengimpornya, mendefinisikan
# fungsinya, lalu keluar dengan kode 0. Gerbangnya membaca 0 itu sebagai "OK".
#
# Sampai 17 September 2026 SEPULUH berkas di sini berbentuk begitu, dan gerbangnya melaporkan
# "38/38 lulus" sementara 59 uji di dalamnya — termasuk `test_draft_resolve_kode` dan
# `test_priskila_golden`, yang justru mengunci cacat "kelompok kosong mencocok seluruh katalog" —
# tidak dijalankan satu pun. Uji yang tidak dijalankan lebih buruk daripada uji yang tidak ada:
# ia membuat orang berhenti memeriksa.
def _perlu_pytest(jalur):
    isi = jalur.read_text(encoding="utf-8", errors="replace")
    return bool(re.search(r"^def test_", isi, re.M)) and "__main__" not in isi



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
    lewat = []
    for satu in berkas:
        nama = satu.name
        if nama in BUTUH_LAYANAN:
            print(f"LEWAT  {nama:<34} {BUTUH_LAYANAN[nama]}")
            continue
        mulai = time.time()
        try:
            perintah = ([sys.executable, "-m", "pytest", str(satu), "-q"]
                        if satu.suffix == ".py" and satu.name.startswith("test_") and _perlu_pytest(satu)
                        else [sys.executable, str(satu)])
            hasil = subprocess.run(perintah, cwd=str(BASE), capture_output=True,
                                   text=True, timeout=BATAS_DETIK)
        except subprocess.TimeoutExpired:
            print(f"GAGAL  {nama:<34} melebihi {BATAS_DETIK} detik")
            gagal.append((nama, f"timeout {BATAS_DETIK}s"))
            continue
        lama = time.time() - mulai
        if "No module named pytest" in (hasil.stdout + hasil.stderr):
            print(f"GAGAL  {nama:<34} butuh pytest, dan pytest tidak terpasang")
            gagal.append((nama, "Berkas ini bergaya pytest; tanpa pytest ia tidak menguji apa pun. Pasang: pip install pytest"))
            continue
        if hasil.returncode == 0:
            # LEWAT TIDAK BOLEH MENYAMAR SEBAGAI LULUS. Sebagian uji menuntut berkas yang sengaja
            # tidak ikut git (master principal `*.xlsx`, surat asli) dan melewat dengan sebabnya,
            # supaya CI tidak menuntut berkas yang tidak dikirim. Tetapi uji yang melewat tidak
            # menjaga apa pun, dan "38/38 lulus" yang diam-diam memuat 4 lewat adalah persis
            # kalimat yang membuat repo ini kehilangan kerja Juli selama dua bulan. Sebabnya
            # dicetak, jumlahnya dihitung, dan ringkasannya menyebut keduanya.
            sebab = next((b[len("LEWAT:"):].strip() for b in hasil.stdout.splitlines()
                          if b.startswith("LEWAT:")), None)
            if sebab:
                print(f"LEWAT  {nama:<34} {sebab}")
                lewat.append(nama)
            else:
                print(f"OK     {nama:<34} {lama:5.1f}s")
        else:
            print(f"GAGAL  {nama:<34} {lama:5.1f}s")
            gagal.append((nama, (hasil.stdout + hasil.stderr).strip()[-2000:]))

    if gagal:
        print(f"\n{len(gagal)} dari {len(berkas)} self-check GAGAL:\n")
        for nama, pesan in gagal:
            print(f"--- {nama} ---\n{pesan}\n")
        return 1
    jalan = len(berkas) - len(BUTUH_LAYANAN) - len(lewat)
    if lewat:
        print(f"\n{jalan} self-check Python lulus, {len(lewat)} MELEWAT: {', '.join(lewat)}")
        print("Yang melewat tidak menjaga apa pun di sini, hanya di mesin yang punya berkasnya.")
    else:
        print(f"\nSeluruh {jalan} self-check Python lulus.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
