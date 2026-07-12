"""Tujuan: Self-check agar output aplikasi tidak membawa hardcoded nama perusahaan internal.
Caller: Jalankan langsung dengan `python test_no_company_branding.py`.
Dependensi: pathlib; scan file teks dashboard-generator selain sample/reference/build/dist.
Main Functions: main.
Side Effects: Membaca file teks lokal untuk validasi.
"""
from pathlib import Path


FORBIDDEN = ("Surya Perkasa", "CV. Surya", "CV Surya")
TEXT_EXT = {".py", ".html", ".js", ".css", ".md", ".spec"}
SKIP_DIRS = {"samples", "reference", "build", "dist", "__pycache__"}


def _iter_text_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_EXT:
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def main():
    root = Path(__file__).resolve().parent
    hits = []
    for path in _iter_text_files(root):
        if path.name == Path(__file__).name:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for term in FORBIDDEN:
            if term.lower() in text.lower():
                hits.append(f"{path.relative_to(root)}: {term}")

    assert not hits, "Hardcoded nama perusahaan masih ditemukan:\n" + "\n".join(hits)
    print("OK  tidak ada hardcoded nama perusahaan internal di source/output dashboard generator")


if __name__ == "__main__":
    main()
