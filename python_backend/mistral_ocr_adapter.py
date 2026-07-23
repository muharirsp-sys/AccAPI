"""Tujuan: Adapter Mistral OCR 4 eksperimental untuk Summary Program.

Caller: ``routers.summary.summary_manual_parse_pdf_ai`` ketika
``SUMOPOD_OCR_MODEL`` menunjuk model ``mistral-ocr-*``. Dependensi: httpx dan
Mistral ``/v1/ocr``. Main Functions: ``ocr_pdf_to_text``. Side Effects:
panggilan HTTPS berbayar ke Mistral; tidak menulis file dan tidak menyimpan key.

PDF dikirim langsung agar kualitas scan tidak turun. Tabel HTML/Markdown
disisipkan kembali ke posisi placeholder; HTML mempertahankan ``rowspan``,
sedangkan Markdown tersedia untuk A/B parser. O/o hanya dinormalisasi menjadi 0
saat menempel digit.
"""

import asyncio
import base64
import re
from typing import Optional

import httpx


_ADJ_DIGIT_O = re.compile(r"(?<=\d)[Oo]|[Oo](?=\d)")


def normalize_numeric_o(text: str) -> str:
    """Ubah O/o menjadi 0 hanya bila berdampingan dengan digit."""
    previous = None
    while previous != text:
        previous = text
        text = _ADJ_DIGIT_O.sub("0", text)
    return text


def _page_text(page: dict) -> str:
    """Sisipkan tabel terpisah ke placeholder Markdown pada satu halaman."""
    markdown = str(page.get("markdown") or "")
    missing_tables = []
    for table in page.get("tables") or []:
        table_id = str(table.get("id") or "").strip()
        content = str(table.get("content") or "").strip()
        if not content:
            continue
        replaced = False
        if table_id:
            for placeholder in (f"[{table_id}]({table_id})", f"![{table_id}]({table_id})"):
                if placeholder in markdown:
                    markdown = markdown.replace(placeholder, content)
                    replaced = True
        if not replaced:
            missing_tables.append(content)
    if missing_tables:
        markdown = "\n\n".join([markdown, *missing_tables]).strip()
    return normalize_numeric_o(markdown)


async def ocr_pdf_to_text(
    file_bytes: bytes,
    api_key: str,
    *,
    model: str = "mistral-ocr-4-0",
    page_count: int,
    table_format: str = "html",
    client: Optional[httpx.AsyncClient] = None,
) -> str:
    """OCR halaman ``0..page_count-1`` dan kembalikan teks berlabel halaman."""
    if not file_bytes:
        raise ValueError("PDF kosong")
    if not api_key or any(ch.isspace() for ch in api_key):
        raise ValueError("MISTRAL_API_KEY kosong atau formatnya tidak valid")
    if page_count < 1:
        raise ValueError("page_count harus minimal 1")
    if table_format not in ("html", "markdown"):
        raise ValueError("table_format harus html atau markdown")

    payload = {
        "model": model,
        "document": {
            "type": "document_url",
            "document_url": "data:application/pdf;base64," + base64.b64encode(file_bytes).decode("ascii"),
        },
        "pages": list(range(page_count)),
        "table_format": table_format,
        "include_blocks": True,
        "confidence_scores_granularity": "word",
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    owned_client = client is None
    http = client or httpx.AsyncClient(timeout=300.0)
    try:
        response = None
        for attempt in range(3):
            response = await http.post(
                "https://api.mistral.ai/v1/ocr", json=payload, headers=headers
            )
            if response.status_code not in (429, 500, 502, 503, 504) or attempt == 2:
                break
            await asyncio.sleep(2 ** attempt)
        assert response is not None
        if response.status_code != 200:
            detail = response.text[:500].replace(api_key, "[REDACTED]")
            raise RuntimeError(f"Mistral OCR HTTP {response.status_code}: {detail}")
        data = response.json()
        pages = sorted(data.get("pages") or [], key=lambda p: int(p.get("index", 0)))
        if not pages:
            raise RuntimeError("Mistral OCR tidak mengembalikan halaman")
        chunks = [
            f"--- HALAMAN {int(page.get('index', index)) + 1} ---\n{_page_text(page)}"
            for index, page in enumerate(pages)
        ]
        return "\n\n".join(chunks)
    finally:
        if owned_client:
            await http.aclose()


if __name__ == "__main__":
    assert normalize_numeric_o("15OML 1OO OLIVEOIL") == "150ML 100 OLIVEOIL"
    sample = {
        "markdown": "awal\n\n[tbl-0.html](tbl-0.html)\n\nakhir",
        "tables": [{"id": "tbl-0.html", "content": '<table><td rowspan="2">8OML</td></table>'}],
    }
    rendered = _page_text(sample)
    assert "rowspan" in rendered and "80ML" in rendered and "tbl-0.html](" not in rendered
    print("mistral_ocr_adapter self-check PASSED")
