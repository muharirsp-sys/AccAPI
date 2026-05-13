import io
import time
from typing import Optional, Sequence

from fastapi import UploadFile


def _normalized_ext_list(allowed_exts: Optional[Sequence[str]]) -> Sequence[str]:
    if not allowed_exts:
        return []
    return [str(x).strip().lower() for x in allowed_exts if str(x).strip()]


def _ext_ok(filename: str, allowed_exts: Optional[Sequence[str]]) -> bool:
    normalized = _normalized_ext_list(allowed_exts)
    if not normalized:
        return True
    lower = (filename or "").strip().lower()
    return any(lower.endswith(ext) for ext in normalized)


async def read_upload_file_limited(
    upload: UploadFile,
    max_bytes: int,
    allowed_exts: Optional[Sequence[str]] = None,
    label: str = "File",
) -> bytes:
    if upload is None:
        raise ValueError(f"{label} belum dipilih.")
    filename = (upload.filename or "").strip()
    if allowed_exts and not _ext_ok(filename, allowed_exts):
        raise ValueError(f"{label} tidak valid. Gunakan file: {', '.join(_normalized_ext_list(allowed_exts))}")
    limit = max(1, int(max_bytes))
    data = await upload.read(limit + 1)
    if len(data) > limit:
        mb = limit / (1024 * 1024)
        raise ValueError(f"{label} terlalu besar. Maksimal {mb:.1f} MB.")
    return data


def extract_pdf_text_safe(
    pdf_bytes: bytes,
    max_pdf_bytes: int,
    max_pages: int,
    total_timeout_seconds: int,
    per_page_ocr_timeout_seconds: int,
) -> str:
    if not isinstance(pdf_bytes, (bytes, bytearray)) or len(pdf_bytes) == 0:
        return ""
    if len(pdf_bytes) > int(max_pdf_bytes):
        mb = int(max_pdf_bytes) / (1024 * 1024)
        raise ValueError(f"File PDF terlalu besar. Maksimal {mb:.1f} MB.")

    text = ""
    try:
        import pypdf

        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        page_limit = min(len(reader.pages), max(1, int(max_pages)))
        for i in range(page_limit):
            try:
                text += (reader.pages[i].extract_text() or "") + "\n"
            except Exception:
                continue
    except Exception:
        text = ""

    if len(text.strip()) > 50:
        return text

    try:
        import fitz
        from PIL import Image
        import pytesseract
        import os
        
        # Configure Tesseract Path for Windows
        if os.name == 'nt':
            pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

        page_limit = max(1, int(max_pages))
        deadline = time.monotonic() + max(1, int(total_timeout_seconds))
        per_page_timeout = max(1, int(per_page_ocr_timeout_seconds))
        
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        limit = min(doc.page_count, page_limit)
        
        ocr_text = []
        for i in range(limit):
            if time.monotonic() >= deadline:
                break
            try:
                page = doc.load_page(i)
                pix = page.get_pixmap(dpi=300)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                ocr_text.append(pytesseract.image_to_string(img, timeout=per_page_timeout))
            except Exception:
                continue
        joined = "\n".join(ocr_text).strip()
        return joined or text
    except Exception:
        return text
