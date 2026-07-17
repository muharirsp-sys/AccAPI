"""
E2E LIVE URC (biaya API nyata di RUN 1 tiap surat): 2 surat asli URC -> parse
(OCR+LLM live) -> generate. RUN 2 dok+principle sama -> parse HIT cache
(0 API) -> generate. Bukti akhir per surat:
- run2 parse = 0 panggilan API (rows identik run1)
- Dataset xlsx & Form PDF BYTE-IDENTIK antar 2 run penuh
- 0 UNMATCHED (semua item resolve ke SKU master)
Cache diarahkan ke tmp supaya tak mengotori data produksi & run1 pasti miss (jujur).
Mirrors test_e2e_live.py (Priskila) tapi untuk principle URC dan 2 surat.
"""
import sys, os, io, json, hashlib, tempfile, asyncio
sys.path.insert(0, r"D:\AccAPI\_github_clean\python_backend")
import shared
import routers.summary as backend
import ocr_cache, parse_cache, golden_store
from starlette.datastructures import Headers, UploadFile

_tmp = tempfile.mkdtemp(prefix="e2e_live_urc_")
ocr_cache._CACHE_DIR = os.path.join(_tmp, "ocr")
parse_cache._CACHE_DIR = os.path.join(_tmp, "parse")
golden_store._STORE_PATH = os.path.join(_tmp, "golden.jsonl")

backend.get_current_user = lambda req: "betterauth|admin|test@local"
backend.user_has_permission = lambda *a, **k: True
backend.validate_csrf_request = lambda req, token: True

_orig_ael = backend.append_error_log
def _ael_spy(tag, exc, ctx=None):
    if tag in ("urc_pipeline_fallback", "chunk_incomplete_brands", "chunk_invalid_json"):
        print(f"  [{tag}]", json.dumps(ctx or {}, ensure_ascii=False, default=str)[:800])
    return _orig_ael(tag, exc, ctx)
backend.append_error_log = _ael_spy

class FakeRequest:
    headers = Headers({})
    cookies = {}

MASTER = r"D:\AccAPI\_github_clean\master_barang_principle\MASTER BARANG URC.xlsx"
LETTERS = [
    r"D:\AccAPI\_github_clean\reference_surat_program\002 - BTGO Lexus 76g NED Oct 25 - Feb 26 periode Jul-Sep 2025 (National MTI).pdf",
    r"D:\AccAPI\_github_clean\reference_surat_program\004 - Diskon 25% Medium pack Munchys NED Dec 25-Feb 26 periode Jul-Aug 2025 (National MTI).pdf",
]
PRINCIPLE_NAME = "PT URC INDONESIA"

with open(MASTER, "rb") as f:
    kelompok_list, variant_map, gramasi_map, items = shared._parse_master_barang_xlsx(f.read())
token = "e2e-live-urc-tok"
shared.MANUAL_MASTER_CACHE[token] = {"kelompok": kelompok_list, "variant_map": variant_map,
                                     "gramasi_map": gramasi_map, "items": items, "customers": []}
print(f"master loaded: {len(items)} items")


def _h(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


results = []
for surat_path in LETTERS:
    fname = os.path.basename(surat_path)
    print(f"\n=== {fname} ===")
    with open(surat_path, "rb") as f:
        surat_bytes = f.read()

    def make_upload():
        return UploadFile(filename=fname, file=io.BytesIO(surat_bytes))

    async def parse_once():
        return await backend.summary_manual_parse_pdf_ai(
            FakeRequest(), token=token, pdf=make_upload(), n8n_webhook="",
            principle_name=PRINCIPLE_NAME, ai_mode="split")

    def gen(rows):
        return backend.summary_manual_generate(FakeRequest(), token=token, rows_json=json.dumps(rows))

    print("RUN 1: parse live (OCR+LLM, biaya API)...")
    r1 = asyncio.run(parse_once())
    assert r1.get("ok"), r1
    rows1 = r1["rows"]
    print(f"  run1 rows: {len(rows1)}")
    unmatched1 = [r for r in rows1 if r.get("_urc_unmatched")]
    if unmatched1:
        print(f"  !! UNMATCHED ({len(unmatched1)}):")
        for u in unmatched1:
            print("    -", u.get("item_description"))
    g1 = gen(rows1)
    assert g1.get("ok"), g1
    out1 = shared.MANUAL_OUTPUTS[g1["file_id"]]
    h1x, h1p = _h(out1["dataset"]), _h(out1["form"])
    print(f"  run1 xlsx={h1x[:12]} pdf={h1p[:12]}")

    print("RUN 2: parse (harus hit cache, 0 API)...")
    import httpx
    _real_post = httpx.AsyncClient.post
    async def _boom(*a, **k):
        raise AssertionError("RUN 2 memanggil API padahal harus 0 (parse cache gagal)")
    httpx.AsyncClient.post = _boom
    try:
        r2 = asyncio.run(parse_once())
    finally:
        httpx.AsyncClient.post = _real_post
    assert r2.get("ok"), r2
    rows2 = r2["rows"]
    print(f"  run2 rows: {len(rows2)} (0 panggilan API terbukti)")
    assert rows1 == rows2, "rows run2 harus IDENTIK run1 (frozen)"
    g2 = gen(rows2)
    out2 = shared.MANUAL_OUTPUTS[g2["file_id"]]
    h2x, h2p = _h(out2["dataset"]), _h(out2["form"])
    print(f"  run2 xlsx={h2x[:12]} pdf={h2p[:12]}")

    assert h1x == h2x, "Dataset xlsx WAJIB byte-identik"
    assert h1p == h2p, "Form PDF WAJIB byte-identik"

    results.append({"file": fname, "rows": rows1, "unmatched": len(unmatched1),
                     "out": out1, "xlsx_hash": h1x, "pdf_hash": h1p})

print("\n=== HASIL AKHIR ===")
total_unmatched = sum(r["unmatched"] for r in results)
for r in results:
    print(f"  {r['file']}: {len(r['rows'])} rows, {r['unmatched']} unmatched, "
          f"xlsx={r['xlsx_hash'][:12]} pdf={r['pdf_hash'][:12]}")
print(f"TOTAL UNMATCHED: {total_unmatched}")
assert total_unmatched == 0, "Ada baris UNMATCHED -- cek log di atas sebelum lanjut"
print("\nE2E LIVE URC GATE PASSED: 0 UNMATCHED, run1==run2 (0-API), output byte-identik.")

import shutil
insp = r"D:\AccAPI\_github_clean\python_backend\data\e2e_live_urc_output"
os.makedirs(insp, exist_ok=True)
for i, r in enumerate(results, start=1):
    for _src, _name in ((r["out"]["dataset"], f"Dataset_{i}.xlsx"), (r["out"]["form"], f"Form_Summary_{i}.pdf")):
        _dst = os.path.join(insp, _name)
        try:
            shutil.copy(_src, _dst)
        except PermissionError:
            print(f"  ! Tak bisa menimpa {_name} (terkunci). Sumber: {_src}")
print("output disalin ke:", insp)
