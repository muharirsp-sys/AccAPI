"""
E2E LIVE (biaya API nyata di RUN 1 saja): surat asli Priskila -> parse (OCR+LLM live,
termasuk PASS 3 self-correction) -> generate. RUN 2 dok+principle sama -> parse HIT cache
(0 API) -> generate. Bukti akhir:
- run2 parse = 0 panggilan API (rows identik run1)
- Dataset xlsx & Form PDF BYTE-IDENTIK antar 2 run penuh (FASE 6)
- golden determinism: new lalu match
- patch PASS 3 (kalau ada) dicetak utk inspeksi
Cache diarahkan ke tmp supaya tak mengotori data produksi & run1 pasti miss (jujur).
Catatan F10: endpoint summary kini hidup di routers/summary.py (bukan main.py).
"""
import sys, os, io, json, hashlib, tempfile, asyncio
sys.path.insert(0, r"D:\AccAPI\_github_clean\python_backend")
import shared
import routers.summary as backend
import ocr_cache, parse_cache, golden_store
from starlette.datastructures import Headers, UploadFile

# redirect semua cache/golden ke tmp (run1 miss, tak sentuh prod)
_tmp = tempfile.mkdtemp(prefix="e2e_live_")
ocr_cache._CACHE_DIR = os.path.join(_tmp, "ocr")
parse_cache._CACHE_DIR = os.path.join(_tmp, "parse")
golden_store._STORE_PATH = os.path.join(_tmp, "golden.jsonl")

# bypass auth (nama di-bind ke namespace router saat import -> patch di router)
backend.get_current_user = lambda req: "betterauth|admin|test@local"
backend.user_has_permission = lambda *a, **k: True
backend.validate_csrf_request = lambda req, token: True

# tampilkan patch PASS 3 yg diajukan editor QA (log-nya lewat append_error_log)
_orig_ael = backend.append_error_log
def _ael_spy(tag, exc, ctx=None):
    if tag == "self_correction_patches":
        print("  PASS 3 patches:", json.dumps((ctx or {}).get("patches", []), ensure_ascii=False, indent=2))
    return _orig_ael(tag, exc, ctx)
backend.append_error_log = _ael_spy

class FakeRequest:
    headers = Headers({})
    cookies = {}

SURAT = r"D:\AccAPI\_github_clean\reference_surat_program\TRADE PROGRAM GT BULAN MARET 2026.pdf"
MASTER = r"D:\AccAPI\MASTER BARANG PRISKILA.xlsx"

with open(MASTER, "rb") as f:
    kelompok_list, variant_map, gramasi_map, items = shared._parse_master_barang_xlsx(f.read())
token = "e2e-live-tok"
shared.MANUAL_MASTER_CACHE[token] = {"kelompok": kelompok_list, "variant_map": variant_map,
                                     "gramasi_map": gramasi_map, "items": items, "customers": []}
print(f"master loaded: {len(items)} items")

with open(SURAT, "rb") as f:
    surat_bytes = f.read()

def make_upload():
    return UploadFile(filename="TRADE PROGRAM GT BULAN MARET 2026.pdf", file=io.BytesIO(surat_bytes))

async def parse_once():
    return await backend.summary_manual_parse_pdf_ai(
        FakeRequest(), token=token, pdf=make_upload(), n8n_webhook="", principle_name="", ai_mode="split")

def gen(rows):
    return backend.summary_manual_generate(FakeRequest(), token=token, rows_json=json.dumps(rows))

def _h(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()

# ---- RUN 1: live OCR+LLM (+PASS 3 editor) ----
print("RUN 1: parse live (OCR+LLM+editor, biaya API)...")
r1 = asyncio.run(parse_once())
assert r1.get("ok"), r1
rows1 = r1["rows"]
print(f"  run1 rows: {len(rows1)}")
g1 = gen(rows1)
assert g1.get("ok"), g1
out1 = shared.MANUAL_OUTPUTS[g1["file_id"]]
h1x, h1p = _h(out1["dataset"]), _h(out1["form"])
print(f"  run1 determinism={g1.get('determinism')}  xlsx={h1x[:12]} pdf={h1p[:12]}")

# ---- RUN 2: harus HIT parse cache (0 API) ----
print("RUN 2: parse (harus hit cache, 0 API)...")
# sabotase httpx supaya kalau run2 nekat manggil API -> meledak (bukti 0 panggilan)
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
print(f"  run2 determinism={g2.get('determinism')}  xlsx={h2x[:12]} pdf={h2p[:12]}")

print("\n=== HASIL ===")
print("rows identik run1==run2 :", rows1 == rows2)
print("Dataset xlsx byte-identik:", h1x == h2x)
print("Form PDF   byte-identik  :", h1p == h2p)
print("golden run1/run2         :", g1.get("determinism"), "/", g2.get("determinism"))
assert rows1 == rows2
assert h1x == h2x, "Dataset xlsx WAJIB byte-identik"
assert h1p == h2p, "Form PDF WAJIB byte-identik"
assert g2.get("determinism") == "match"
print("\nE2E LIVE GATE PASSED: dok sama -> rows identik (0 API run2) -> output 0-byte-diff, golden match")

# simpan output run1 utk inspeksi manual user. Best-effort: gate SUDAH lulus di atas;
# kegagalan copy (mis. file tujuan sedang dibuka di viewer PDF -> Windows lock) JANGAN
# menggagalkan test. File sumber (out1) tetap ada di path aslinya utk diperiksa.
import shutil
insp = r"D:\AccAPI\_github_clean\python_backend\data\e2e_live_output"
os.makedirs(insp, exist_ok=True)
for _src, _name in ((out1["dataset"], "Dataset_Diskon.xlsx"), (out1["form"], "Form_Summary.pdf")):
    _dst = os.path.join(insp, _name)
    try:
        shutil.copy(_src, _dst)
    except PermissionError:
        print(f"  ! Tak bisa menimpa {_name} (terkunci -- tutup viewer PDF/Excel-nya). Sumber: {_src}")
print("output run1 disalin ke:", insp)
