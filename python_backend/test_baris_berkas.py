"""Self-check `baris_berkas`: berkas JSON baris -> baris draft tanpa membaca surat (jalur darurat tanpa OCR)."""
import json

import fitz

from routers.summary import baris_berkas


def pdf(halaman):
    doc = fitz.open()
    for _ in range(halaman):
        doc.new_page()
    return doc.tobytes()


def main():
    hasil = baris_berkas(json.dumps([{"principle": "MSM", "surat_program": "278/MSM", "benefit": 3, "keterangan": "kuota beli",
                                      "outlet_mode": None, "asing": "dibuang"}]).encode(), pdf(2))
    baris = hasil["rows"][0]
    assert hasil["page_count"] == 2 and hasil["model"] == "berkas" and hasil["on_faktur"] is True
    assert baris["benefit"] == "3" and baris["keterangan"] == "kuota beli" and baris["outlet_mode"] == ""
    assert baris["source_page"] == "1" and "asing" not in baris and "id" not in baris
    for rusak in (b"bukan json", b"{}", b"[]", b"[1]"):
        try:
            baris_berkas(rusak, pdf(1))
        except ValueError:
            continue
        raise AssertionError(f"berkas rusak diterima: {rusak!r}")
    print("baris_berkas: OK")


if __name__ == "__main__":
    main()
