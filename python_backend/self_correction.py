# ======================================================================================
# Tujuan: PASS 3 "self-correction" ala Reducto ("VLMs make corrections to mistakes --
#         like a human editor"). Setelah LLM mengekstrak rows dari teks OCR, panggilan
#         KEDUA menyodorkan kembali {teks sumber + rows hasil ekstraksi} dan menyuruh
#         model bertindak sbg EDITOR QA: temukan nilai yang tidak cocok dgn teks sumber,
#         ajukan PATCH. Model TIDAK boleh menulis-ulang/menghapus/menambah baris --
#         hanya patch field per-row by id (anti-regresi: koreksi tak bisa merusak
#         struktur hasil ekstraksi yg sudah benar).
# Caller: python_backend/main.py (summary_manual_parse_pdf_ai), setelah all_rows terkumpul,
#         SEBELUM _apply_native_kelompok (koreksi kelompok ikut ter-resolve ulang) dan
#         SEBELUM parse_cache_put (yg dibekukan = hasil terkoreksi). Lihat SYSTEM_MAP.md.
# Dependensi: json, re (stdlib). Panggilan HTTP disuntik via post_fn (testable offline).
# Main Functions:
#   - verify_and_correct_rows(source_text, rows, post_fn, model) -> (rows, patches_applied)
#       post_fn: async callable(payload_dict) -> content string (jawaban model).
#       Gagal apa pun (HTTP error, JSON rusak, patch tak valid) -> rows KEMBALI APA ADANYA
#       (pass ini hanya boleh memperbaiki, tak pernah boleh menggagalkan parse).
# Side Effects: tidak ada (pure; 1 panggilan LLM via post_fn milik caller).
# ======================================================================================

import json
import re
from typing import Callable, List, Tuple

# Field yang boleh dikoreksi editor. id/kode_barangs SENGAJA tidak ada: identitas baris
# dan resolusi kode ke master adalah wewenang _apply_native_kelompok/variant_resolver
# (deterministik), bukan wewenang LLM editor.
_PATCHABLE_FIELDS = {
    "ketentuan", "benefit", "benefit_type", "kelompok", "variant",
    "gramasi", "channel_gtmt", "periode", "surat_program", "nama_program",
}

_EDITOR_PROMPT = """Anda adalah EDITOR QA data. Di bawah ada TEKS SUMBER (hasil OCR surat program promo) dan ARRAY JSON hasil ekstraksi dari teks itu.

Tugas Anda SATU-SATUNYA: bandingkan setiap baris JSON dengan TEKS SUMBER, temukan nilai yang SALAH KUTIP dari sumber (angka trigger salah, benefit salah, nama kelompok/varian/gramasi tidak sesuai teks, channel/periode keliru).

KEMBALIKAN HANYA array JSON berisi patch, format:
[{{"id": "<id baris>", "field": "<nama field>", "to": "<nilai benar sesuai teks sumber>", "alasan": "<kutipan singkat dari teks sumber>"}}]

ATURAN KERAS:
1. HANYA laporkan kesalahan yang BISA Anda buktikan dengan kutipan dari TEKS SUMBER. Ragu = JANGAN patch.
2. DILARANG menambah/menghapus baris. DILARANG mengubah field 'id' atau 'kode_barangs'.
3. Field yang boleh dipatch: {fields}.
4. Tidak ada kesalahan -> kembalikan [] persis.
5. Jawab HANYA array JSON, diawali '[', tanpa markdown, tanpa penjelasan.

=== TEKS SUMBER ===
{source}

=== HASIL EKSTRAKSI ===
{rows}"""


async def verify_and_correct_rows(source_text: str, rows: List[dict],
                                   post_fn: Callable, model: str) -> Tuple[List[dict], List[dict]]:
    if not rows:
        return rows, []
    try:
        # rows dikirim tanpa kode_barangs panjang (hemat token; editor tak boleh menyentuhnya)
        slim = [{k: v for k, v in r.items() if k != "kode_barangs"} for r in rows]
        prompt = _EDITOR_PROMPT.format(
            fields=", ".join(sorted(_PATCHABLE_FIELDS)),
            source=source_text,
            rows=json.dumps(slim, ensure_ascii=False),
        )
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a strict QA editor. You ONLY output a valid JSON array starting with '['."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.0,
            "max_tokens": 4000,
        }
        raw = await post_fn(payload)
        m = re.search(r"\[.*\]", str(raw or ""), re.DOTALL)
        patches = json.loads(m.group(0)) if m else []
    except Exception:
        return rows, []  # editor gagal -> hasil asli utuh, jangan pernah menggagalkan parse

    by_id = {str(r.get("id", "")): r for r in rows}
    applied: List[dict] = []
    for p in patches if isinstance(patches, list) else []:
        try:
            rid, field = str(p.get("id", "")), str(p.get("field", ""))
            if field not in _PATCHABLE_FIELDS or rid not in by_id or "to" not in p:
                continue
            row = by_id[rid]
            old = row.get(field)
            if old == p["to"]:
                continue
            row[field] = p["to"]
            applied.append({"id": rid, "field": field, "from": old, "to": p["to"],
                            "alasan": p.get("alasan", "")})
        except Exception:
            continue
    return rows, applied


if __name__ == "__main__":
    import asyncio

    rows = [
        {"id": "r1", "kelompok": "Bellagio EDT 100ml", "ketentuan": "Beli 4",
         "benefit": "1 PCS", "kode_barangs": "P1"},
        {"id": "r2", "kelompok": "Bellagio Roll On 50ml", "ketentuan": "Beli 4",
         "benefit": "1 PCS", "kode_barangs": "P3"},
    ]
    src = "| Bellagio EDT 100ml | 7+1 |\n| Bellagio Roll On 50ml | 4+1 |"

    async def fake_post(payload):
        # editor menemukan r1 salah (7+1 di sumber, bukan Beli 4) + patch nakal yg HARUS ditolak
        return json.dumps([
            {"id": "r1", "field": "ketentuan", "to": "Beli 7", "alasan": "sumber: 7+1"},
            {"id": "r1", "field": "kode_barangs", "to": "HACK"},     # field terlarang -> tolak
            {"id": "r99", "field": "ketentuan", "to": "Beli 1"},      # id tak ada -> tolak
            {"id": "r2", "field": "ketentuan", "to": "Beli 4"},       # sama dgn nilai lama -> skip
        ])

    out, applied = asyncio.run(verify_and_correct_rows(src, rows, fake_post, "test-model"))
    assert out[0]["ketentuan"] == "Beli 7", out[0]
    assert out[0]["kode_barangs"] == "P1", "kode_barangs tak boleh tersentuh"
    assert out[1]["ketentuan"] == "Beli 4"
    assert len(applied) == 1 and applied[0]["field"] == "ketentuan", applied

    async def broken_post(payload):
        return "maaf saya tidak bisa"  # bukan JSON -> rows harus utuh

    out2, applied2 = asyncio.run(verify_and_correct_rows(src, rows, broken_post, "test-model"))
    assert out2 == rows and applied2 == [], "editor gagal -> no-op"
    print("self_correction self-check PASSED (patch valid diterapkan, patch nakal/id asing/no-op ditolak, gagal=utuh)")
