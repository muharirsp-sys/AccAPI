"""Tujuan: E2E surat asli -> parse (OCR Mistral) -> Form PDF + Dataset Excel, dan buktikan
dokumen yang sama selalu menghasilkan berkas yang sama persis.
Caller: `python test_e2e_live.py` (tanpa framework). Dependensi: routers.summary, shared, summary_store.
Main Functions: main; assert rows run1==run2 (0 panggilan API di run2), xlsx & pdf byte-identik, golden match.
Side Effects: SQLite e2e terpisah di `data/e2e_store.sqlite3`; menyalin keluaran ke `data/e2e_live_output`.

KENAPA BERKAS INI PERNAH MATI, dan kenapa itu penting.
Ia satu-satunya uji yang benar-benar menghasilkan PDF dan Excel dari surat sungguhan. Ia memanggil
`main.summary_manual_parse_pdf_ai`; fungsi itu pindah ke `routers/summary.py` saat main dipecah,
dan sejak itu berkas ini mati dengan `AttributeError`. Tidak ada yang tahu, karena TIDAK ADA satu
pun alur CI yang menjalankan uji — `deploy.yml` hanya `npm run lint` dan `tsc --noEmit`. Jalur
Summary lalu diperbaiki sebelas kali lewat mata manusia di layar produksi.

BIAYA. Penyimpanan e2e SENGAJA persisten (`data/e2e_store.sqlite3`): cache OCR Mistral tinggal di
sana, jadi menjalankan ulang berkas ini tidak membayar apa pun. `E2E_FRESH=1` memakai penyimpanan
kosong — run 1 benar-benar memanggil API, dan itulah satu-satunya cara membuktikan jalur OCR-nya
masih hidup. Tanpa kunci API DAN tanpa cache, berkas ini MELEWAT dengan sebabnya, bukan gagal:
gerbang yang menuntut uang tiap kali akan dimatikan orang, dan gerbang yang dimatikan tidak menjaga.

YANG DIBUKTIKANNYA, DAN YANG TIDAK. Ia membuktikan mesinnya MENGULANG DIRINYA (determinisme).
Ia TIDAK membuktikan keluarannya SESUAI SURATNYA — untuk itu perlu keluaran yang diharapkan,
ditulis orang, per surat. Selama itu belum ada, benar/salahnya masih dinilai mata manusia.
"""
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SURAT = REPO / "reference_surat_program" / "TRADE PROGRAM GT BULAN MARET 2026.pdf"
# MASTER YANG SAMA DENGAN KUNCI JAWABANNYA, dan itu bukan detail kecil.
#
# Ada DUA master Priskila di mesin ini: `master_barang_principle/MASTER BARANG PRISKILA.xlsx`
# (259 barang, kelompok "BLAGIO HM EDT") dan yang dipakai menyusun golden Juli 2026
# (274 barang, kelompok "BLAGIO HM - EDT"). Matcher memisah merek dari jenis pada " - ", jadi
# master tanpa tanda hubung tidak cocok satu baris pun — lembarnya terbit penuh
# "(TIDAK ADA ITEM COCOK DI MASTER)" padahal matchernya benar.
#
# Uji ini memakai master yang SAMA dengan `test_priskila_golden.py`. Dua gerbang yang mengukur
# master berbeda bukan dua gerbang; ia satu gerbang dan satu kebingungan.
MASTER_CACHE = BASE / "data" / "manual_cache" / "master_cache.json"
# Nama principal-nya IKUT: ia yang memilih perintah "salin saja" Priskila dan matcher
# deterministiknya. Tanpa itu suratnya jatuh ke jalur lama dan lembarnya kosong ketentuan.
PRINCIPAL = "PT.PRISKILA PRIMA MAKMUR"
KELUARAN = BASE / "data" / "e2e_live_output"

FRESH = os.getenv("E2E_FRESH") == "1"
STORE = Path(tempfile.mkdtemp(prefix="e2e-fresh-")) / "summary.sqlite3" if FRESH else BASE / "data" / "e2e_store.sqlite3"
STORE.parent.mkdir(parents=True, exist_ok=True)
os.environ["SUMMARY_STORE_PATH"] = str(STORE)

# Kunci Mistral hidup di `.env.local` akar repo, sedangkan backend memuat `.env` miliknya sendiri.
if not os.getenv("MISTRAL_API_KEY"):
    berkas = REPO / ".env.local"
    if berkas.is_file():
        for baris in berkas.read_text(encoding="utf-8", errors="ignore").splitlines():
            if baris.strip().startswith("MISTRAL_API_KEY="):
                os.environ["MISTRAL_API_KEY"] = baris.split("=", 1)[1].strip()
                break

sys.path.insert(0, str(BASE))

import asyncio  # noqa: E402
from starlette.datastructures import Headers, UploadFile  # noqa: E402

import golden_store  # noqa: E402

# Golden diarahkan ke tmp: uji ini membuktikan RUN 1 == RUN 2 pada kode yang SAMA, bukan bahwa
# keluarannya sama dengan versi kode bulan lalu. Golden lintas-versi tetap milik produksi, dan di
# sanalah "drift" memang harus berbunyi dan minta persetujuan orang.
golden_store._STORE_PATH = str(Path(tempfile.mkdtemp(prefix="e2e-golden-")) / "golden.jsonl")

from routers import summary as backend, summary_library  # noqa: E402
from shared import MANUAL_MASTER_CACHE, MANUAL_OUTPUTS  # noqa: E402
from summary_store import identity  # noqa: E402

PENGGUNA = "betterauth|admin|e2e@local"
TOKEN = "e2e-live-tok"


class FakeRequest:
    headers = Headers({})
    cookies = {}


def _master_items(isi):
    """Daftar `items` di dalam master_cache, di kedalaman mana pun ia disimpan."""
    if isinstance(isi, dict):
        if isinstance(isi.get("items"), list):
            return isi["items"]
        for nilai in isi.values():
            hasil = _master_items(nilai)
            if hasil:
                return hasil
    return None


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _punya_cache():
    """Cache OCR untuk dokumen ini sudah ada? Menentukan apakah run 1 gratis."""
    from summary_store import JsonStore
    return len(JsonStore("mistral-v1")) > 0


def main():
    # Master principal dan surat asli adalah dokumen bisnis nyata dan SENGAJA tidak ikut git
    # (`*.xlsx` dan `reference_surat_program/` di .gitignore). Tanpa berkasnya uji ini MELEWAT
    # dengan sebabnya, bukan mati dengan FileNotFoundError: CI tidak boleh menuntut berkas yang
    # tidak dikirim. `run_checks.py` mencetak sebab lewatnya dan menghitungnya di ringkasan,
    # jadi lewat tidak bisa menyamar sebagai lulus.
    for wajib in (SURAT, MASTER_CACHE):
        if not wajib.is_file():
            print(f"LEWAT: berkas contoh tidak ada di pohon kerja ini ({wajib})")
            return

    if FRESH and not os.getenv("MISTRAL_API_KEY"):
        print("LEWAT: E2E_FRESH=1 menuntut panggilan API, tetapi MISTRAL_API_KEY tidak ada.")
        return
    if not os.getenv("MISTRAL_API_KEY") and not _punya_cache():
        print(f"LEWAT: tanpa MISTRAL_API_KEY dan tanpa cache di {STORE.name}, surat tidak bisa dibaca.")
        return

    backend.get_current_user = lambda request: PENGGUNA
    backend.user_has_permission = lambda *a, **k: True
    backend.validate_csrf_request = lambda request, token: True
    summary_library.get_current_user = lambda request: PENGGUNA
    summary_library.user_has_permission = lambda *a, **k: True
    summary_library.validate_csrf_request = lambda request, token: True

    items = _master_items(json.loads(MASTER_CACHE.read_text(encoding="utf-8")))
    kelompok = sorted({str(it.get("kelompok") or "").strip() for it in items if str(it.get("kelompok") or "").strip()})
    MANUAL_MASTER_CACHE[TOKEN] = {"owner": identity(PENGGUNA), "kelompok": kelompok,
                                  "variant_map": {}, "gramasi_map": {}, "items": items, "customers": []}
    print(f"master: {len(items)} barang, {len(kelompok)} kelompok")

    surat = SURAT.read_bytes()

    def bersihkan_draft():
        """Tiap run mulai dari nol draft, tetapi cache OCR TETAP.

        Sejak keputusan #74 ekstraksi MENUMPUK ke draft berjudul sama, jadi parse kedua atas
        surat yang sama menjawab "0 baris bertambah" — benar menurut alurnya, tetapi membuat
        perbandingan run1 lawan run2 kehilangan isinya. Yang diuji di sini determinisme mesinnya,
        bukan penumpukannya (itu `test_append_rows`).
        """
        from summary_store import connect
        with connect() as db:
            db.execute("DELETE FROM summary_draft")

    def parse():
        berkas = UploadFile(filename=SURAT.name, file=io.BytesIO(surat))
        return asyncio.run(backend.summary_manual_parse_pdf_ai(FakeRequest(), token=TOKEN, pdf=berkas, principle_name=PRINCIPAL))

    def generate(rows):
        return backend.summary_manual_generate(FakeRequest(), token=TOKEN, rows_json=json.dumps(rows))

    print(f"RUN 1: parse ({'API hidup' if FRESH else 'cache bila ada'})...")
    bersihkan_draft()
    satu = parse()
    assert satu.get("ok"), satu
    baris1 = satu["rows"]
    print(f"  run1: {len(baris1)} baris")
    hasil1 = generate(baris1)
    assert hasil1.get("ok"), hasil1
    keluar1 = MANUAL_OUTPUTS[hasil1["file_id"]]
    xlsx1, pdf1 = _sha(keluar1["dataset"]), _sha(keluar1["form"])
    print(f"  run1 determinism={hasil1.get('determinism')} xlsx={xlsx1[:12]} pdf={pdf1[:12]}")

    # Run 2 dilarang menyentuh jaringan: kalau cache parse gagal, ia MELEDAK, bukan diam-diam bayar.
    print("RUN 2: parse wajib dari cache, nol panggilan API...")
    import httpx
    asli_post, asli_get = httpx.AsyncClient.post, httpx.AsyncClient.get

    async def _meledak(*a, **k):
        raise AssertionError("RUN 2 memanggil API padahal harus nol — cache parse tidak bekerja")

    bersihkan_draft()
    httpx.AsyncClient.post = _meledak
    httpx.AsyncClient.get = _meledak
    try:
        dua = parse()
    finally:
        httpx.AsyncClient.post, httpx.AsyncClient.get = asli_post, asli_get
    assert dua.get("ok"), dua
    baris2 = dua["rows"]
    print(f"  run2: {len(baris2)} baris (nol panggilan API terbukti)")

    hasil2 = generate(baris2)
    assert hasil2.get("ok"), hasil2
    keluar2 = MANUAL_OUTPUTS[hasil2["file_id"]]
    xlsx2, pdf2 = _sha(keluar2["dataset"]), _sha(keluar2["form"])
    print(f"  run2 determinism={hasil2.get('determinism')} xlsx={xlsx2[:12]} pdf={pdf2[:12]}")

    # `id` baris memang lahir baru tiap run (`uuid4` untuk baris hasil pecahan matcher), jadi ia
    # bukan bagian dari "hasil yang sama". Yang harus identik adalah ISINYA — dan bukti paling
    # keras tetap dua berkas di bawah: xlsx dan pdf byte-identik.
    def tanpa_id(baris):
        return [{k: v for k, v in b.items() if k not in ("id", "_matched_items_cache")} for b in baris]

    assert tanpa_id(baris1) == tanpa_id(baris2), "isi baris run2 harus IDENTIK run1"
    assert xlsx1 == xlsx2, "Dataset xlsx WAJIB byte-identik"
    assert pdf1 == pdf2, "Form PDF WAJIB byte-identik"
    assert hasil2.get("determinism") == "match", hasil2.get("determinism")

    KELUARAN.mkdir(parents=True, exist_ok=True)
    shutil.copy(keluar1["dataset"], KELUARAN / "Dataset_Diskon.xlsx")
    shutil.copy(keluar1["form"], KELUARAN / "Form_Summary.pdf")
    print(f"e2e summary check: OK — keluaran disalin ke {KELUARAN}")


if __name__ == "__main__":
    main()
