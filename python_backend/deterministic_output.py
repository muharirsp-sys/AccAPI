# ======================================================================================
# Tujuan: FASE 6 -- jamin file OUTPUT (Dataset xlsx + Form PDF) BYTE-IDENTIK antar-run utk
#         isi yang sama. Dua sumber non-determinisme byte-level yg TERBUKTI (diukur):
#           1. ReportLab PDF menaruh /CreationDate, /ModDate, dan document ID acak.
#           2. openpyxl xlsx menaruh timestamp entry-zip (waktu save) + menimpa
#              docProps/core.xml <dcterms:modified> dgn now() SETIAP save (abaikan properti).
#         Modul ini menetralkan keduanya -> signature isi (FASE 5) kini setara diff byte.
# Caller: python_backend/main.py (summary_manual_generate): panggil enable_pdf_determinism()
#         SEBELUM doc.build(...), dan finalize_xlsx(path) SETELAH wb.save(path).
# Dependensi: re, io, zipfile (stdlib). reportlab.rl_config (sudah dependensi PDF).
# Main Functions:
#   - enable_pdf_determinism() -> None   Set rl_config.invariant=1 (idempotent). PDF dpt
#       CreationDate/ModDate tetap + doc ID berbasis konten -> reproducible.
#   - finalize_xlsx(path) -> None   Tulis-ulang zip xlsx di tempat: urutan entry terurut,
#       timestamp entry beku (1980-01-01), dan <dcterms:modified> core.xml dipaku ke nilai
#       tetap. Aman dipanggil ulang (idempotent).
# Side Effects: finalize_xlsx menimpa file xlsx di 'path' (baca lalu tulis-ulang).
# ======================================================================================

import io
import re
import zipfile

_FIXED_ENTRY_DT = (1980, 1, 1, 0, 0, 0)          # batas bawah zip; tetap antar-run
_FIXED_XML_TS = "2020-01-01T00:00:00Z"           # nilai <dcterms:created/modified> yg dipaku
_MODIFIED_RE = re.compile(rb'(<dcterms:modified[^>]*>)[^<]*(</dcterms:modified>)')
_CREATED_RE = re.compile(rb'(<dcterms:created[^>]*>)[^<]*(</dcterms:created>)')


def enable_pdf_determinism() -> None:
    from reportlab import rl_config
    rl_config.invariant = 1


def finalize_xlsx(path: str) -> None:
    with open(path, "rb") as f:
        raw = f.read()
    src = zipfile.ZipFile(io.BytesIO(raw))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(src.namelist()):  # urutan entry stabil
            data = src.read(name)
            if name == "docProps/core.xml":
                # openpyxl memaksa modified=now() saat save -> paku ke nilai tetap.
                # \g<1>/\g<2> (bukan \1/\2) -- \1 diikuti digit literal ("2020...")
                # ditafsir re sebagai backreference \12/octal, bukan "\1"+teks -> XML corrupt.
                data = _MODIFIED_RE.sub(rb'\g<1>' + _FIXED_XML_TS.encode() + rb'\g<2>', data)
                data = _CREATED_RE.sub(rb'\g<1>' + _FIXED_XML_TS.encode() + rb'\g<2>', data)
            zi = zipfile.ZipInfo(name, _FIXED_ENTRY_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
    with open(path, "wb") as f:
        f.write(out.getvalue())


if __name__ == "__main__":
    import hashlib, os, tempfile, time
    import openpyxl

    tmpdir = tempfile.mkdtemp(prefix="detout_test_")

    def make_xlsx(p):
        wb = openpyxl.Workbook(); ws = wb.active
        ws.append(["KODE", "QTY"]); ws.append(["P1", 7])
        wb.save(p)
        finalize_xlsx(p)

    p1 = os.path.join(tmpdir, "a.xlsx"); p2 = os.path.join(tmpdir, "b.xlsx")
    make_xlsx(p1); time.sleep(1.1); make_xlsx(p2)
    h1 = hashlib.sha256(open(p1, "rb").read()).hexdigest()
    h2 = hashlib.sha256(open(p2, "rb").read()).hexdigest()
    assert h1 == h2, "xlsx harus byte-identik setelah finalize_xlsx"

    # wajib: file hasil finalize_xlsx harus BISA DIBUKA (hash-sama tidak berarti valid --
    # bug nyata pernah lolos self-check ini karena \1/\2 diikuti digit ditafsir re sbg
    # backreference \12/octal, bikin docProps/core.xml corrupt tapi tetap "byte-identik").
    import xml.dom.minidom as _minidom
    reopened = openpyxl.load_workbook(p1)
    assert reopened.active["A1"].value == "KODE", "xlsx hasil finalize_xlsx harus terbaca ulang"
    with zipfile.ZipFile(p1) as _z:
        _minidom.parseString(_z.read("docProps/core.xml"))  # raise kalau XML tak well-formed

    # idempotent: finalize lagi tak mengubah bytes
    finalize_xlsx(p1)
    assert hashlib.sha256(open(p1, "rb").read()).hexdigest() == h1, "finalize_xlsx harus idempotent"

    # PDF: rl_config.invariant -> build 2x byte-identik
    enable_pdf_determinism()
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Paragraph
    from reportlab.lib.styles import getSampleStyleSheet

    def make_pdf():
        b = io.BytesIO()
        SimpleDocTemplate(b, pagesize=A4).build([Paragraph("hi", getSampleStyleSheet()["Normal"])])
        return b.getvalue()

    d1 = make_pdf(); time.sleep(1.1); d2 = make_pdf()
    assert hashlib.sha256(d1).hexdigest() == hashlib.sha256(d2).hexdigest(), "pdf harus byte-identik dgn invariant"

    import shutil; shutil.rmtree(tmpdir, ignore_errors=True)
    print("deterministic_output self-check PASSED (xlsx & pdf byte-identik antar-run, finalize idempotent)")
