"""Tujuan: Bandingkan / profilkan TEKS OCR MENTAH satu surat antar provider, tanpa
memanggil LLM parse sama sekali (mode termurah untuk menilai provider OCR baru).

Caller: manual. Dependensi: ocr_cache (stdlib saja). Main Functions: ``profile``,
``compare``. Side Effects: hanya membaca ``data/ocr_cache*/`` dan mencetak; tidak
memanggil API dan tidak menulis apa pun.

Pemakaian:
    python ocr_text_compare.py                      # profil semua surat yg ada teks bekunya
    python ocr_text_compare.py <ns_baseline> <ns_kandidat>   # diff dua provider

``ns`` = namespace cache provider, mis. "mistral-ocr-4-0:html", "chandra:html",
"" (Gemini). Teks yang dibaca adalah teks BEKU dari ocr_cache, jadi mode diff hanya
jalan setelah surat yang sama pernah di-OCR oleh kedua provider.

Metrik dipilih yang benar-benar menentukan hasil Summary Program:
struktur tabel (``<table>``/``rowspan`` -- kalau hilang, baris produk saling tumpang),
token gramasi (salah 1 digit = SKU salah), dan token persen (nilai diskon).
"""

import collections
import glob
import json
import os
import re
import sys

from ocr_cache import ocr_cache_key

_CACHE_DIRS = ("data/ocr_cache", "data/ocr_cache_pilot")
_NUM_UNIT = re.compile(r"(\d{2,4})\s*(ML|GR|G)\b", re.IGNORECASE)  # samakan dgn rapidocr_adapter


def _tok(num: str, unit: str) -> str:
    """Token gramasi kanonik. GR dan G disatukan: master menulis '76GR', surat '76g'
    -- kalau tidak disatukan, seluruh SKU gram tampak salah padahal identik."""
    return f"{num}{'ML' if unit.upper() == 'ML' else 'G'}"
_PERCENT = re.compile(r"(\d{1,2}(?:[.,]\d+)?)\s*%")
_PAGE = re.compile(r"^--- HALAMAN (\d+)", re.MULTILINE)
# Tahun 3 digit yang diawali 20 (mis. "Oct 205" dari "Oct 2025") = digit hilang.
# Bukan bukti mutlak, tapi kandidat kuat kesalahan OCR yang harus dilihat manusia.
_SHORT_YEAR = re.compile(r"\b20\d\b")

# (label principle, path surat). Semua relatif ke root repo.
_SP = r"D:\AccAPI\_github_clean\reference_surat_program"
LETTERS = [
    ("URC", os.path.join(_SP, "002 - BTGO Lexus 76g NED Oct 25 - Feb 26 periode Jul-Sep 2025 (National MTI).pdf")),
    ("URC", os.path.join(_SP, "004 - Diskon 25% Medium pack Munchys NED Dec 25-Feb 26 periode Jul-Aug 2025 (National MTI).pdf")),
    ("PRISKILA", os.path.join(_SP, "TRADE PROGRAM GT BULAN MARET 2026.pdf")),
    ("NATUR", os.path.join(_SP, "Surat Program.pdf")),
    ("NATUR", os.path.join(_SP, "surat program bonus.pdf")),
    ("NATUR", os.path.join(_SP, "surat program feb.pdf")),
    ("NATUR", os.path.join(_SP, "surat program mix.pdf")),
]
NAMESPACES = ("mistral-ocr-4-0:html", "chandra:html", "")


def _all_cached() -> dict[str, str]:
    """{hash: path} untuk seluruh cache OCR yang ada."""
    out = {}
    for d in _CACHE_DIRS:
        for p in glob.glob(os.path.join(d, "*.json")):
            out[os.path.basename(p)[:-5]] = p
    return out


def load_text(pdf_path: str, namespace: str, cached: dict[str, str]) -> str | None:
    """Teks OCR beku untuk (surat, provider), atau None kalau belum pernah di-OCR."""
    with open(pdf_path, "rb") as f:
        # `namespace` BUKAN bagian kunci: satu dokumen punya satu hash, dan provider
        # dibedakan oleh direktori cache-nya (`_CACHE_DIRS`). Pemanggilan dua-argumen di
        # sini sudah lama mati dengan TypeError, tanpa ada yang menjalankannya.
        h = ocr_cache_key(f.read())
    path = cached.get(h)
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f).get("ocr_text")


def metrics(text: str) -> dict:
    """Ukuran mentah + multiset token yang menentukan benar/salahnya SKU & diskon."""
    return {
        "pages": len(_PAGE.findall(text)),
        "chars": len(text),
        "tables": text.lower().count("<table"),
        "rowspan": text.lower().count("rowspan"),
        "gramasi": collections.Counter(
            _tok(m.group(1), m.group(2)) for m in _NUM_UNIT.finditer(text)),
        "persen": collections.Counter(m.group(1) for m in _PERCENT.finditer(text)),
        "tahun_pendek": sorted(set(_SHORT_YEAR.findall(text))),
    }


def master_gramasi(master_xlsx: str) -> set[str]:
    """Himpunan gramasi SAH dari master barang principle, mis. {'150ML','35GR'}.

    Sel master boleh berisi notasi ganda ('150/135ML') -> kedua angka dianggap sah,
    karena surat kadang menulis salah satu pecahan saja.
    """
    import shared  # impor lokal: profil/diff dasar tak butuh openpyxl+parser master

    with open(master_xlsx, "rb") as f:
        *_, items = shared._parse_master_barang_xlsx(f.read())
    valid = set()
    for it in items:
        raw = str((it.get("gramasi") if isinstance(it, dict) else "") or "").upper()
        unit_match = re.search(r"(ML|GR|G)\b", raw)
        if not unit_match:
            continue
        for num in re.findall(r"\d{1,4}", raw):
            valid.add(_tok(num, unit_match.group(1)))
    return valid


def score_vs_master(text: str, valid: set[str]) -> list[str]:
    """Token gramasi di teks OCR yang TIDAK ada di master = kandidat salah baca.

    Ini satu-satunya metrik di file ini yang punya kebenaran acuan (master), jadi
    dipakai untuk menilai provider -- bukan cuma membandingkan dua provider.

    ponytail: whitelist GLOBAL per principle, bukan per variant. Jadi '135ML' lolos
    karena ADA di master (milik HABBATUSSAUDA) walau dipasang ke ROSEHIP yang cuma
    150ML -- salah-pasang antar variant tak terdeteksi di sini. Naikkan ke whitelist
    per (kelompok, variant) kalau salah-pasang mulai lolos ke Dataset.
    """
    got = collections.Counter(_tok(m.group(1), m.group(2)) for m in _NUM_UNIT.finditer(text))
    return sorted(f"{tok}x{n}" for tok, n in got.items() if tok not in valid)


def profile(label: str, name: str, text: str) -> None:
    m = metrics(text)
    print(f"  [{label:<8}] {name[:46]:<46} hlm={m['pages']:<2} char={m['chars']:>6} "
          f"tabel={m['tables']:<3} rowspan={m['rowspan']:<3} "
          f"gramasi={sum(m['gramasi'].values()):<3} persen={sum(m['persen'].values()):<3}")
    if m["tahun_pendek"]:
        print(f"             ! tahun 3-digit (kandidat digit hilang): {m['tahun_pendek']}")


def compare(name: str, base_ns: str, base: str, cand_ns: str, cand: str) -> bool:
    """Cetak diff dua provider untuk satu surat. True kalau token kunci identik."""
    a, b = metrics(base), metrics(cand)
    print(f"\n  {name}")
    for k in ("pages", "chars", "tables", "rowspan"):
        flag = "" if a[k] == b[k] else "   <-- BEDA"
        print(f"    {k:<9} {base_ns or 'gemini':>20} = {a[k]:<7} {cand_ns:>20} = {b[k]:<7}{flag}")
    ok = True
    for k in ("gramasi", "persen"):
        only_a, only_b = a[k] - b[k], b[k] - a[k]
        if only_a or only_b:
            ok = False
            print(f"    {k}: hanya baseline={dict(only_a)} hanya kandidat={dict(only_b)}")
        else:
            print(f"    {k}: identik ({sum(a[k].values())} token)")
    return ok


if __name__ == "__main__":
    if os.getenv("SELFCHECK") == "1":
        t = "--- HALAMAN 1 ---\n<table rowspan=2>NATUR SHAMPOO 170ML diskon 12,5%</table>\nOct 205"
        m = metrics(t)
        assert m == {**m, "pages": 1, "tables": 1, "rowspan": 1}
        assert m["gramasi"] == {"170ML": 1} and m["persen"] == {"12,5": 1}
        assert m["tahun_pendek"] == ["205"], m["tahun_pendek"]
        # G dan GR WAJIB jadi satu token, kalau tidak tiap SKU gram tampak salah baca.
        assert metrics("76g dan 76GR dan 76 GR")["gramasi"] == {"76G": 3}
        assert score_vs_master("LEXUS 76g", {"76G"}) == []
        assert score_vs_master("LEXUS 76g", {"75G"}) == ["76Gx1"]
        print("ocr_text_compare self-check PASSED")
        sys.exit(0)

    cached = _all_cached()
    if len(sys.argv) == 3:
        base_ns, cand_ns = sys.argv[1], sys.argv[2]
        pairs = 0
        for label, path in LETTERS:
            base = load_text(path, base_ns, cached)
            cand = load_text(path, cand_ns, cached)
            if base is None or cand is None:
                missing = base_ns if base is None else cand_ns
                print(f"\n  SKIP {os.path.basename(path)[:46]} -- belum ada teks utk "
                      f"{missing or 'gemini'!r}")
                continue
            compare(f"{label}: {os.path.basename(path)}", base_ns, base, cand_ns, cand)
            pairs += 1
        print(f"\n{pairs} surat dibandingkan.")
        sys.exit(0)

    print("PROFIL TEKS OCR BEKU (0 panggilan API):")
    for label, path in LETTERS:
        if not os.path.exists(path):
            print(f"  [{label}] FILE HILANG: {path}")
            continue
        found = False
        for ns in NAMESPACES:
            text = load_text(path, ns, cached)
            if text:
                profile(f"{label}/{ns or 'gemini'}", os.path.basename(path), text)
                found = True
        if not found:
            print(f"  [{label:<8}] {os.path.basename(path)[:46]:<46} -- belum ada teks beku")
