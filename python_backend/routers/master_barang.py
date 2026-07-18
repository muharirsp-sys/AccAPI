# Tujuan: Ekstraksi item sumber Master Barang dari Excel/CSV, PDF teks/scan, dan gambar menjadi JSON terstruktur untuk AccAPI.
# Caller: Next.js app/api/master-barang (multipart upload setelah guard RBAC).
# Dependensi: FastAPI shared auth/upload guard, pandas/openpyxl, PyMuPDF, httpx, dan OCR vision Sumopod opsional.
# Main Functions: master_barang_extract(), _extract_table_file(), _extract_pdf_or_image().
# Side Effects: Membaca upload dan dapat melakukan HTTP call OCR/AI; tidak menulis DB/file permanen.
import base64
import io
import json
import os
import re
from typing import Any, Dict, List, Tuple

import fitz
import httpx
import pandas as pd
from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse

from shared import get_current_user, read_upload_file_limited, user_has_permission

router = APIRouter()
MAX_SOURCE_BYTES = int(os.getenv("MASTER_BARANG_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
ALLOWED_EXTS = (".xlsx", ".xls", ".csv", ".tsv", ".pdf", ".png", ".jpg", ".jpeg", ".webp")


def _clean(value: Any) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _header_key(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]+", "", _clean(value).upper())


def _find_header(rows: List[List[Any]]) -> Tuple[int, Dict[str, int]]:
    aliases = {
        "kodePcpl": {"KODEPCPL", "KODEPRINCIPLE", "ITEMCODE", "KODEBARANG", "SKU"},
        "kelompokPcpl": {"KLPBRGPCPL", "KELOMPOKPCPL", "KATEGORI", "CATEGORY"},
        "namaBarang": {"NAMABARANGPRINCIPLE", "NAMABARANG", "NAMAPRODUK", "PRODUK", "PRODUCT", "ITEMDESCRIPTION", "DESCRIPTION"},
        "isiCtn": {"ISICTN", "ISIKARTON", "PACKSIZE", "CTN", "QTYCTN"},
        "satuan": {"SATUANFIXWIN", "SATUAN", "UOM", "UNIT"},
        "gramasi": {"NAMAGRAMASIATAUJUMLAHPACKPERCTN", "GRAMASI", "SIZE", "WEIGHT"},
        "kemasan": {"NAMAJENISKEMASAN", "KEMASAN", "PACKAGING"},
        "aroma": {"NAMAAROMARASA", "AROMARASA", "VARIANT", "VARIAN"},
    }
    best = (-1, {}, 0)
    for row_no, row in enumerate(rows[:80]):
        keys = [_header_key(value) for value in row]
        mapping: Dict[str, int] = {}
        for field, names in aliases.items():
            for col_no, key in enumerate(keys):
                if key in names:
                    mapping[field] = col_no
                    break
        score = len(mapping)
        if "namaBarang" in mapping and score > best[2]:
            best = (row_no, mapping, score)
    if best[0] < 0:
        raise ValueError("Header nama produk/barang tidak ditemukan.")
    return best[0], best[1]


def _infer_fields(name: str) -> Dict[str, str]:
    upper = name.upper()
    gramasi_matches = list(re.finditer(r"(?:\b|X)(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LTR|LT|L)\b", upper))
    gramasi = ""
    if gramasi_matches:
        match = gramasi_matches[-1]
        unit = {"G": "GR", "LTR": "L", "LT": "L"}.get(match.group(2), match.group(2))
        gramasi = f"{match.group(1).replace(',', '.')} {unit}"
    kemasan = ""
    for pattern, label in ((r"\b(SACHET|SCH)\b", "SCH"), (r"\b(POUCH|PCH|REFILL)\b", "PCH"), (r"\b(BOTTLE|BOTOL|BTL)\b", "BTL"), (r"\b(CAN|KALENG)\b", "CAN"), (r"\bJAR\b", "JAR"), (r"\bCUP\b", "CUP")):
        if re.search(pattern, upper):
            kemasan = label
            break
    isi = ""
    pack = re.search(r"\b(\d{1,4})\s*(PCS|PC|PCE|BTL|BOTOL|SACHET|SCH)\b", upper)
    if pack:
        isi = pack.group(1)
    return {"gramasi": gramasi, "kemasan": kemasan, "isiCtn": isi}


def _rows_to_items(rows: List[List[Any]], header_no: int, mapping: Dict[str, int]) -> List[Dict[str, Any]]:
    items = []
    for row_no, row in enumerate(rows[header_no + 1 :], start=header_no + 2):
        def val(field: str) -> str:
            index = mapping.get(field, -1)
            return _clean(row[index]) if 0 <= index < len(row) else ""
        name = val("namaBarang")
        if not name or name.startswith("="):
            continue
        inferred = _infer_fields(name)
        items.append({
            "sourceRow": row_no, "kodePcpl": val("kodePcpl"), "kelompokPcpl": val("kelompokPcpl"),
            "namaBarang": name, "isiCtn": val("isiCtn") or inferred["isiCtn"], "satuan": val("satuan"),
            "gramasi": val("gramasi") or inferred["gramasi"], "kemasan": val("kemasan") or inferred["kemasan"],
            "aroma": val("aroma"), "confidence": 0.98, "reviewNotes": [],
        })
    return items


def _extract_table_file(raw: bytes, extension: str) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    if extension in (".csv", ".tsv"):
        separator = "\t" if extension == ".tsv" else None
        frame = pd.read_csv(io.BytesIO(raw), sep=separator, engine="python", header=None, dtype=str, keep_default_na=False)
        sheets = {"CSV": frame}
    else:
        sheets = pd.read_excel(io.BytesIO(raw), sheet_name=None, header=None, dtype=str, keep_default_na=False)
    best = None
    errors = []
    for sheet_name, frame in sheets.items():
        rows = frame.fillna("").values.tolist()
        try:
            header_no, mapping = _find_header(rows)
            items = _rows_to_items(rows, header_no, mapping)
            candidate = (len(items), sheet_name, header_no, items)
            if items and (best is None or candidate[0] > best[0]):
                best = candidate
        except Exception as exc:
            errors.append(f"{sheet_name}: {exc}")
    if best is None:
        raise ValueError("Tidak ada tabel item yang dapat dibaca. " + "; ".join(errors[:5]))
    return best[3], {"engine": "table", "sheetName": best[1], "headerRow": best[2] + 1, "warnings": []}


def _heuristic_text_items(text: str) -> List[Dict[str, Any]]:
    items = []
    seen = set()
    for line_no, line in enumerate(text.splitlines(), start=1):
        line = _clean(line)
        if len(line) < 8 or not re.search(r"\d", line):
            continue
        inferred = _infer_fields(line)
        if not inferred["gramasi"] and not inferred["isiCtn"]:
            continue
        key = line.upper()
        if key in seen:
            continue
        seen.add(key)
        items.append({"sourceRow": line_no, "namaBarang": line, **inferred, "confidence": 0.55, "reviewNotes": ["Parser heuristik tanpa OCR/AI; wajib review nama, isi, dan gramasi."]})
    return items


def _json_array(content: str) -> List[Dict[str, Any]]:
    cleaned = re.sub(r"```(?:json)?", "", content, flags=re.IGNORECASE).replace("```", "").strip()
    match = re.search(r"\[.*\]", cleaned, flags=re.DOTALL)
    if not match:
        raise ValueError("OCR/AI tidak mengembalikan array JSON.")
    parsed = json.loads(match.group(0))
    if not isinstance(parsed, list):
        raise ValueError("Respons OCR/AI bukan array.")
    result = []
    for row in parsed:
        if not isinstance(row, dict) or not _clean(row.get("namaBarang")):
            continue
        inferred = _infer_fields(_clean(row.get("namaBarang")))
        result.append({
            "sourcePage": int(row.get("sourcePage") or 0) or None,
            "kodePcpl": _clean(row.get("kodePcpl")), "kelompokPcpl": _clean(row.get("kelompokPcpl")),
            "namaBarang": _clean(row.get("namaBarang")), "isiCtn": _clean(row.get("isiCtn")) or inferred["isiCtn"],
            "satuan": _clean(row.get("satuan")), "klp": _clean(row.get("klp")), "subKlp": _clean(row.get("subKlp")),
            "subKlp2": _clean(row.get("subKlp2")), "aroma": _clean(row.get("aroma")),
            "gramasi": _clean(row.get("gramasi")) or inferred["gramasi"], "kemasan": _clean(row.get("kemasan")) or inferred["kemasan"],
            "promo": _clean(row.get("promo")), "sachet": _clean(row.get("sachet")), "golongan": _clean(row.get("golongan")),
            "confidence": max(0.0, min(1.0, float(row.get("confidence") or 0.75))),
            "reviewNotes": row.get("reviewNotes") if isinstance(row.get("reviewNotes"), list) else [],
        })
    return result


async def _vision_extract(images: List[Tuple[int, bytes]], native_text: str) -> List[Dict[str, Any]]:
    api_key = os.getenv("SUMOPOD_API_KEY", "").strip()
    if not api_key:
        heuristic_items = _heuristic_text_items(native_text) if native_text.strip() else []
        if heuristic_items:
            return heuristic_items
        raise ValueError("Dokumen adalah scan/gambar tetapi SUMOPOD_API_KEY belum dikonfigurasi untuk OCR.")
    prompt = """Ekstrak daftar SKU/barang dari price list/master barang ini. Salin nama produk, ISI/KARTON, gramasi, dan kemasan PERSIS dari sumber; jangan mengarang nilai yang kosong. Abaikan semua harga. Pecah setiap produk/SKU menjadi satu objek. Kembalikan HANYA array JSON dengan field: sourcePage, kodePcpl, kelompokPcpl, namaBarang, isiCtn, satuan, klp, subKlp, subKlp2, aroma, gramasi, kemasan, promo, sachet, golongan, confidence (0..1), reviewNotes (array string). Untuk tabel multi-variant, setiap variant adalah item tersendiri. Nama dan gramasi harus sama dengan dokumen."""
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt + (f"\n\nTeks native pendukung:\n{native_text[:30000]}" if native_text.strip() else "")}]
    for page_no, image in images:
        content.append({"type": "text", "text": f"HALAMAN {page_no}"})
        content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")}})
    payload = {"model": os.getenv("MASTER_BARANG_OCR_MODEL", "gemini/gemini-2.5-flash"), "messages": [{"role": "user", "content": content}], "temperature": 0, "max_tokens": int(os.getenv("MASTER_BARANG_OCR_MAX_TOKENS", "16000"))}
    base_url = os.getenv("SUMOPOD_BASE_URL", "https://ai.sumopod.com/v1").rstrip("/")
    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.post(f"{base_url}/chat/completions", json=payload, headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
        response.raise_for_status()
        message = response.json().get("choices", [{}])[0].get("message", {}).get("content", "")
    return _json_array(message)


async def _extract_pdf_or_image(raw: bytes, extension: str) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    images: List[Tuple[int, bytes]] = []
    native_text = ""
    native_pages: Dict[int, str] = {}
    if extension == ".pdf":
        with fitz.open(stream=raw, filetype="pdf") as document:
            limit = int(os.getenv("MASTER_BARANG_MAX_PAGES", "40"))
            if document.page_count > limit:
                raise ValueError(f"PDF {document.page_count} halaman melebihi batas {limit} halaman.")
            for page_no, page in enumerate(document, start=1):
                page_text = page.get_text()
                native_pages[page_no] = page_text
                native_text += f"\n--- HALAMAN {page_no} ---\n{page_text}"
                pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
                images.append((page_no, pixmap.tobytes("jpeg", jpg_quality=82)))
    else:
        document = fitz.open(stream=raw, filetype=extension.lstrip("."))
        try:
            page = document[0]
            pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
            images.append((1, pixmap.tobytes("jpeg", jpg_quality=82)))
        finally:
            document.close()
    items: List[Dict[str, Any]] = []
    # Batasi 6 halaman per request agar tabel padat tidak terpotong; hasil digabung deterministik.
    for start in range(0, len(images), 6):
        chunk = images[start : start + 6]
        native_chunk = "\n".join(f"--- HALAMAN {page_no} ---\n{native_pages.get(page_no, '')}" for page_no, _ in chunk)
        items.extend(await _vision_extract(chunk, native_chunk))
    if not items and native_text.strip():
        items = _heuristic_text_items(native_text)
    if not items:
        raise ValueError("Tidak ada item yang berhasil diekstrak dari dokumen.")
    engine = "vision_ai" if os.getenv("SUMOPOD_API_KEY", "").strip() else "native_text_heuristic"
    return items, {"engine": engine, "pages": len(images), "nativeTextChars": len(native_text), "warnings": [] if engine == "vision_ai" else ["OCR/AI tidak aktif; seluruh hasil wajib review."]}


@router.post("/master-barang/extract")
async def master_barang_extract(request: Request, file: UploadFile = File(...)):
    user = get_current_user(request)
    if not user:
        return JSONResponse({"ok": False, "error": "Unauthorized"}, status_code=401)
    if not user_has_permission(user, "master_barang", "upload"):
        return JSONResponse({"ok": False, "error": "Forbidden: butuh master_barang.upload"}, status_code=403)
    try:
        raw = await read_upload_file_limited(file, max_bytes=MAX_SOURCE_BYTES, allowed_exts=ALLOWED_EXTS, label="Sumber Master Barang")
        extension = os.path.splitext(file.filename or "")[1].lower()
        if extension in (".xlsx", ".xls", ".csv", ".tsv"):
            items, metadata = _extract_table_file(raw, extension)
        else:
            items, metadata = await _extract_pdf_or_image(raw, extension)
        return {"ok": True, "items": items, "extraction": metadata, "sourceKind": extension.lstrip(".") or "unknown"}
    except ValueError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=422)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": "Gagal mengekstrak sumber Master Barang.", "detail": str(exc) if os.getenv("APP_DEBUG") == "1" else None}, status_code=500)
