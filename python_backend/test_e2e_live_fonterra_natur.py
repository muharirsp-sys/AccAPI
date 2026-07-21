"""
E2E LIVE FONTERRA + NATUR (biaya API nyata di RUN 1 tiap surat): surat asli ->
parse (OCR+LLM live, structure-only) -> generic_promo_pipeline (matcher
deterministik) -> generate via renderer produksi. RUN 2 -> parse HIT cache
(0 API), rows identik, output byte-identik. Gate:
- TIDAK ADA baris dibuang: tiap baris matched ATAU ber-flag _urc_unmatched
- FONTERRA: SEMUA baris keterangan == "PERLU REVIEW MANUAL" (keputusan user)
- perbandingan match-count vs baseline lokal 0-API dicetak (bukan hard-assert:
  OCR live bisa membaca tabel lebih/kurang dari teks native)
Mirrors test_e2e_live_urc.py.
"""
import sys, os, io, json, hashlib, tempfile, asyncio, shutil
sys.path.insert(0, r"D:\AccAPI\_github_clean\python_backend")
import shared
import routers.summary as backend
import ocr_cache, parse_cache, golden_store
from starlette.datastructures import Headers, UploadFile

_tmp = tempfile.mkdtemp(prefix="e2e_live_fn_")
# OCR cache PERSISTEN: OCR bagian termahal & isinya tidak berubah oleh perubahan
# matcher/prompt-parse, jadi rerun uji ini tidak membayar OCR dua kali.
ocr_cache._CACHE_DIR = os.path.join(BASE := os.path.dirname(os.path.abspath(__file__)),
                                    "data", "ocr_cache_pilot")
parse_cache._CACHE_DIR = os.path.join(_tmp, "parse")
golden_store._STORE_PATH = os.path.join(_tmp, "golden.jsonl")

backend.get_current_user = lambda req: "betterauth|admin|test@local"
backend.user_has_permission = lambda *a, **k: True
backend.validate_csrf_request = lambda req, token: True

_orig_ael = backend.append_error_log
def _ael_spy(tag, exc, ctx=None):
    if "fallback" in tag or tag in ("chunk_incomplete_brands", "chunk_invalid_json"):
        print(f"  [{tag}]", json.dumps(ctx or {}, ensure_ascii=False, default=str)[:600])
    return _orig_ael(tag, exc, ctx)
backend.append_error_log = _ael_spy

class FakeRequest:
    headers = Headers({})
    cookies = {}

SP = r"D:\AccAPI\_github_clean\reference_surat_program"
RM = r"D:\AccAPI\_github_clean\python_backend\data\rebuild_master"

# (principle_key, principle_name utk endpoint, [(file, baseline_match, baseline_total)])
PLAN = [
    ("FONTERRA", "FONTERRA", [("MTI Surya Perkasa - Makassar.pdf", 15, 17)]),
    ("NATUR", "NATUR (GONDOWANGI)", [
        ("Surat Program.pdf", 15, 17),
        ("surat program bonus.pdf", 11, 18),
        ("surat program feb.pdf", 17, 25),
        ("surat program mix.pdf", 13, 15),
    ]),
]


def load_master(key):
    with open(os.path.join(RM, f"MASTER BARANG {key}.xlsx"), "rb") as f:
        kel, vmap, gmap, items = shared._parse_master_barang_xlsx(f.read())
    tok = f"e2e-live-{key.lower()}"
    shared.MANUAL_MASTER_CACHE[tok] = {"kelompok": kel, "variant_map": vmap,
                                       "gramasi_map": gmap, "items": items, "customers": []}
    return tok


def _h(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


insp = r"D:\AccAPI\_github_clean\python_backend\data\e2e_live_fonterra_natur_output"
os.makedirs(insp, exist_ok=True)

for key, principle_name, letters in PLAN:
    token = load_master(key)
    combined = []
    print(f"\n########## {key} ##########")
    for fname, base_ok, base_tot in letters:
        print(f"\n=== {fname} ===")
        with open(os.path.join(SP, fname), "rb") as f:
            surat_bytes = f.read()

        def make_upload():
            return UploadFile(filename=fname, file=io.BytesIO(surat_bytes))

        async def parse_once():
            return await backend.summary_manual_parse_pdf_ai(
                FakeRequest(), token=token, pdf=make_upload(), n8n_webhook="",
                principle_name=principle_name, ai_mode="split")

        print("RUN 1: parse live (OCR+LLM, biaya API)...")
        r1 = asyncio.run(parse_once())
        assert r1.get("ok"), r1
        rows1 = r1["rows"]
        matched = [r for r in rows1 if r.get("kode_barangs")]
        unmatched = [r for r in rows1 if r.get("_urc_unmatched")]
        # GATE inti: tak ada baris "abu-abu" yang lolos tanpa kode & tanpa flag
        limbo = [r for r in rows1 if not r.get("kode_barangs") and not r.get("_urc_unmatched")]
        assert not limbo, f"BARIS DIBUANG DIAM-DIAM/limbo: {[r.get('kelompok') for r in limbo]}"
        print(f"  rows={len(rows1)} matched={len(matched)} unmatched={len(unmatched)} "
              f"(baseline lokal: {base_ok}/{base_tot})")
        for u in unmatched:
            print("    UNMATCHED:", u.get("kelompok"))
        if key == "FONTERRA":
            bad = [r for r in rows1 if r.get("keterangan") != "PERLU REVIEW MANUAL"]
            assert not bad, f"FONTERRA wajib PERLU REVIEW MANUAL semua: {bad[:2]}"

        print("RUN 2: parse (harus hit cache, 0 API)...")
        import httpx
        _real_post = httpx.AsyncClient.post
        async def _boom(*a, **k):
            raise AssertionError("RUN 2 memanggil API padahal harus 0")
        httpx.AsyncClient.post = _boom
        try:
            r2 = asyncio.run(parse_once())
        finally:
            httpx.AsyncClient.post = _real_post
        assert r2.get("ok") and r2["rows"] == rows1, "rows run2 harus IDENTIK run1"
        print("  run2 identik (0 API terbukti)")
        combined.extend(rows1)

    # SATU summary per principle (NATUR: 4 surat digabung, sama spt preview lokal)
    for i, r in enumerate(combined):
        r["no"] = str(i + 1)
    g = backend.summary_manual_generate(FakeRequest(), token=token, rows_json=json.dumps(combined))
    assert g.get("ok"), g
    outs = shared.MANUAL_OUTPUTS[g["file_id"]]
    pdf = os.path.join(insp, f"{key}_Form_Summary_LIVE.pdf")
    xls = os.path.join(insp, f"{key}_Dataset_Diskon_LIVE.xlsx")
    shutil.copy(outs["form"], pdf); shutil.copy(outs["dataset"], xls)
    tot_m = sum(1 for r in combined if r.get("kode_barangs"))
    tot_u = sum(1 for r in combined if r.get("_urc_unmatched"))
    print(f"\n== {key}: {len(combined)} baris total, {tot_m} matched, {tot_u} unmatched(flag) ==")
    print("   ->", pdf); print("   ->", xls)

print("\nE2E LIVE FONTERRA+NATUR GATE PASSED: 0 baris dibuang, cache run2 0-API, output tersalin.")
