# Tujuan: Summary manual, OCR Mistral 4.1, dan ekspor privat milik pengguna.
# Caller: dashboard Summary; Dependensi: shared, summary_store, summary_mistral, summary_library, summary_review.
# Main Functions: upload/options/generate/download/parse_pdf_ai, library draft, impor/koreksi detail setting.
# Side Effects: SQLite, file PDF/XLSX privat, HTTPS ke Mistral; tanpa log isi dokumen.
from fastapi import APIRouter

from shared import (
    APP_DEBUG,
    Any,
    BASE_DIR,
    BackgroundTasks,
    CORRECTIONS_PATH,
    Dict,
    File,
    FileResponse,
    Form,
    JSONResponse,
    List,
    MANUAL_MASTER_CACHE,
    MANUAL_OUTPUTS,
    MAX_EXCEL_UPLOAD_BYTES,
    MAX_PDF_UPLOAD_BYTES,
    Request,
    Tuple,
    UploadFile,
    _CORRECTION_IGNORE_KEYS,
    _apply_native_kelompok,
    _ensure_dir,
    _format_corrections_for_prompt,
    _load_corrections,
    _parse_master_barang_xlsx,
    _parse_master_customer_xlsx,
    accel_or_file_response,
    ai_extract_summary_rows,
    append_error_log,
    apply_stable_corrections,
    asyncio,
    build_summary_rows,
    canonical_signature,
    enable_pdf_determinism,
    extract_pdf_text,
    finalize_xlsx,
    get_current_user,
    golden_check_and_freeze,
    is_admin_user,
    json,
    load_stable_corrections,
    openpyxl,
    os,
    parse_cache_get,
    parse_cache_key,
    parse_cache_put,
    parse_number_id,
    re,
    read_upload_file_limited,
    regroup_rows_by_tier,
    s,
    user_has_permission,
    uuid,
    validate_csrf_request,
    write_summary_excel,
)

from summary_store import identity, owned, create_draft
from summary_mistral import extract as extract_mistral
import syarat_claim
from routers.summary_library import router as library_router
from routers.summary_review import router as review_router

router = APIRouter()
router.include_router(library_router)
router.include_router(review_router)


def kino_extraction(raw, master):
    """Surat Kino berlapis teks dibaca deterministik; surat lain (dan scan) tetap ke OCR.

    Dipakai sebelum Mistral karena surat Kino dicetak dari sistem mereka: lapisan teksnya
    utuh, jadi OCR hanya menambah biaya dan risiko salah baca. Gagal apa pun -> None supaya
    jalur OCR tetap jalan; parser ini tidak boleh menjadi titik gagal baru.
    """
    import hashlib

    from kino_letter import parse_pdf
    from summary_mistral import attach_codes

    try:
        result = parse_pdf(raw)
    except Exception:
        return None
    if not result["letter"].get("Kode Aju") or not result["letter"].get("Mekanisme Promo"):
        return None
    catalog = [{"code": str(item.get("kode_barang", "")).strip(), "name": str(item.get("nama_barang", "")),
                "group": str(item.get("kelompok", ""))} for item in master.get("items", [])]
    attach_codes(result["rows"], catalog, result["warnings"])
    return {"rows": result["rows"], "warnings": result["warnings"][:400], "page_count": result["page_count"],
            "model": "deterministic:kino_letter", "pipeline_version": 1, "cached": False,
            "on_faktur": result["on_faktur"], "mechanism": result["mechanism"],
            "source_hash": hashlib.sha256(raw).hexdigest()}


# Parser deterministik untuk principal yang suratnya berlapis teks. Dicoba sebelum OCR
# karena suratnya dicetak dari Word/Excel: lapisan teksnya utuh, jadi OCR hanya menambah
# biaya dan risiko salah baca. Tiap entri: (modul, penjaga) -- penjaga menjawab "surat ini
# memang milik parser saya", supaya parser DAHLIA tidak mengaku-aku surat VINDA.
#
# ATURAN LINTAS-PRINCIPAL yang ditegakkan SEMUA parser di daftar ini (keputusan pengguna
# 2026-09-18, jangan diubah di satu parser saja):
#   1. ON PO = ON FAKTUR. Surat yang diunggah ITULAH pernyataan on-fakturnya. Kata mekanisme
#      yang tercetak dicatat sebagai jejak audit di `keterangan`, TIDAK PERNAH menyaring baris.
#   2. Beban distributor bukan benefit. "Disc. Reg Dist" dan sejenisnya dicatat di
#      `keterangan`, tidak pernah menjadi `benefit`.
#   3. Kalau surat menyebut sesuatu dua kali dengan arah berbeda, jangan ambil yang pertama --
#      cari kalimat kewajiban/penetapannya ("toko WAJIB memakai harga MT"), bukan kebalikannya.
#   4. Fail-closed: data yang tidak ada atau ambigu DITAHAN + diberi keterangan, tidak ditebak
#      dan tidak dikosongkan diam-diam.
# Lebar kolom Form Summary sebagai pecahan lebar cetak, DIUKUR bukan dikira-kira. Patokannya
# satu: sebuah kolom harus memuat KATA TERPANJANG yang pernah masuk ke situ, karena kata yang
# lebih lebar dari kolomnya dipatahkan di tengah — "TOKO ONLINE" tercetak "TOK O ON LINE"
# (DAHLIA, 19 September 2026). Angka ini dari `stringWidth` atas baris Kino DAN DAHLIA:
#   Surat Program  butuh 75pt ("083/TMDH2/08/26#SUR030"), dulu hanya punya 71
#   GT / MT        butuh 25pt ("PARETO", "ONLINE", "GROSIR"), dulu hanya punya 22
#   Keterangan     butuh 54pt ("Independent=1000)."),       dulu hanya punya 43
# Tambahannya diambil dari kolom yang kelebihan menurut ukuran yang sama: Variant (88 dipakai
# 34), Nama Program (79 dipakai 38), Ketentuan (75 dipakai 34), Gramasi (51 dipakai 28).
# Keterangan diberi lebih dari sekadar cukup karena ia memuat teks terpanjang (402 karakter
# pada DAHLIA) dan makin sempit kolomnya makin tinggi barisnya.
# JUMLAHNYA WAJIB 1.000 — `audit_lebar` di e2e_dahlia_endpoint.py menjaga keduanya.
LEBAR_KOLOM = [
    0.025,  # No.
    0.108,  # Surat Program
    0.090,  # Nama Program
    0.050,  # GT / MT
    0.050,  # Daftar Outlet
    0.065,  # Periode
    0.085,  # Kelompok Barang
    0.095,  # Variant Barang
    0.060,  # Gramasi Barang
    0.085,  # Ketentuan Pengambilan
    0.070,  # Benefit
    0.070,  # Syarat Claim
    0.045,  # Update
    0.102,  # Keterangan
]

DETERMINISTIC_PARSERS = (
    ("dahlia_letter", lambda hasil: bool(hasil["rows"])),
    ("vinda_letter", lambda hasil: bool(hasil["rows"])),
    ("primarasa_letter", lambda hasil: bool(hasil["rows"])),
)


def deterministic_extraction(raw, master):
    """Surat berlapis teks dari principal ber-parser; bukan miliknya -> None supaya OCR jalan.

    Sama disiplinnya dengan `kino_extraction`: gagal apa pun mengembalikan None, parser ini
    tidak boleh menjadi titik gagal baru. Yang membedakannya cuma satu -- ia mencoba beberapa
    modul berurutan, dan modul yang suratnya bukan miliknya akan mengangkat pengecualian di
    `parse_pdf` (header tidak cocok / tidak ada lapisan teks) atau menghasilkan nol baris.
    """
    import hashlib
    import importlib

    items = master.get("items", [])
    for module_name, cocok in DETERMINISTIC_PARSERS:
        try:
            module = importlib.import_module(module_name)
            hasil = module.parse_pdf(raw)
            if not cocok(hasil):
                continue
            module.match_items(hasil["rows"], items, hasil["warnings"])
        except Exception:
            continue
        return {"rows": hasil["rows"], "warnings": hasil["warnings"][:400],
                "page_count": hasil["page_count"], "model": f"deterministic:{module_name}",
                "pipeline_version": 1, "cached": False,
                "on_faktur": hasil.get("on_faktur", True),
                "mechanism": hasil.get("mechanism", "") or hasil.get("mechanism_printed", ""),
                "source_hash": hashlib.sha256(raw).hexdigest()}
    return None


@router.post("/summary/manual")
async def summary_manual_auto_generate(
    request: Request,
    file: UploadFile = File(None),
    list_mode: str = Form("TANPA LIST"),
    template: str = Form("GUMINDO"),
    engine: str = Form("ai"),  # "ai" or "manual"
    model: str = Form("kimi-k2-250905"),
):
    """
    Auto summary generator (formerly /summary_generate).
    - engine="ai": use SumoPod model (Kimi/DeepSeek) to extract structured rows
    - engine="manual": use template parser (build_summary_rows)
    """
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    if file is None:
        return JSONResponse(status_code=400, content={"ok": False, "error": "File belum dipilih"})

    try:
        raw = await read_upload_file_limited(
            file,
            max_bytes=MAX_PDF_UPLOAD_BYTES,
            allowed_exts=(".pdf", ".xlsx", ".xls"),
            label="File Summary",
        )
        if file.filename and file.filename.lower().endswith((".xlsx", ".xls")):
            return JSONResponse(status_code=400, content={"ok": False, "error": "Excel belum didukung, upload PDF dulu."})

        text = extract_pdf_text(raw)
        if len(s(text)) < 50:
            return JSONResponse(status_code=400, content={"ok": False, "error": "OCR/PDF text kosong. Pastikan OCR tersedia di server."})

        engine_l = s(engine).lower()
        rows: List[Dict[str, str]] = []
        if engine_l in ("manual", "rule", "template"):
            rows = build_summary_rows(text, list_mode, s(template).upper())
        else:
            return JSONResponse(status_code=410, content={"ok": False, "error": "Gunakan editor Summary dengan OCR Mistral 4.1."})

        if not rows:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Template belum dikenali / hasil kosong."})

        file_id = str(uuid.uuid4())
        base_dir = os.path.dirname(os.path.abspath(__file__))
        out_dir = os.path.join(base_dir, "output")
        out_path = os.path.join(out_dir, f"summary_{file_id}.xlsx")
        write_summary_excel(rows, out_path)
        MANUAL_OUTPUTS[file_id] = {"owner": identity(user), "dataset": out_path}

        return JSONResponse({"ok": True, "file_id": file_id, "download_url": f"/summary_download/{file_id}"})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    except Exception as e:
        append_error_log("summary_manual_auto_generate", e, {"user": user})
        payload = {"ok": False, "error": "Gagal memproses summary otomatis."}
        if APP_DEBUG and is_admin_user(user):
            payload["detail"] = str(e)
        return JSONResponse(status_code=500, content=payload)

@router.get("/summary_download/{file_id}")
def summary_download(request: Request, file_id: str):
    from routers.summary_library import require_user
    user = require_user(request)
    output = MANUAL_OUTPUTS.get(file_id)
    if not owned(output, user):
        return JSONResponse(status_code=404, content={"ok": False, "error": "File tidak ditemukan"})
    return FileResponse(output["dataset"], filename="summary.xlsx", headers={"Cache-Control": "private, no-store"})



# ======================================================================================
# Summary Program Manual Web Input (Tom Select checkbox_options)
# - Variant & Gramasi: multi-select checkbox
# - "ALL VARIANT" / "ALL GRAMASI" exclusive (cannot be selected with other options)
# - User can create new values not in master (create:true)
# ======================================================================================

@router.post("/summary/manual/master/upload")
async def summary_manual_master_upload(
    request: Request, 
    master: UploadFile = File(...),
    master_customer: UploadFile = File(None)
):

    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        file_bytes = await read_upload_file_limited(
            master,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="Master Barang",
        )
        kelompok_list, variant_map, gramasi_map, items = _parse_master_barang_xlsx(file_bytes)
        
        customers = []
        if master_customer and master_customer.filename:
            cust_bytes = await read_upload_file_limited(
                master_customer,
                max_bytes=MAX_EXCEL_UPLOAD_BYTES,
                allowed_exts=(".xlsx", ".xls"),
                label="Master Customer",
            )
            customers = _parse_master_customer_xlsx(cust_bytes)
            
        token = str(uuid.uuid4())
        MANUAL_MASTER_CACHE[token] = {
            "owner": identity(user),
            "kelompok": kelompok_list,
            "variant_map": variant_map,
            "gramasi_map": gramasi_map,
            "items": items,
            "customers": customers,
            "principle_name": ""
        }
        return {"ok": True, "token": token, "kelompok_list": kelompok_list}
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        append_error_log("summary_manual_master_upload", e, {"user": user})
        if APP_DEBUG and is_admin_user(user):
            return {"ok": False, "error": str(e)}
        return {"ok": False, "error": "Gagal membaca master barang."}

@router.get("/summary/manual/master/options")
def summary_manual_master_options(request: Request, token: str, group: str):

    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    try:
        if not owned(MANUAL_MASTER_CACHE.get(token), user):
            return {"ok": False, "error": "Token master tidak ditemukan / expired"}

        cache = MANUAL_MASTER_CACHE[token]
        vlist = cache["variant_map"].get(group, [])
        glist = cache["gramasi_map"].get(group, [])

        variants = [{"value": "ALL VARIANT", "text": "ALL VARIANT", "disabled": False}] +                    [{"value": v, "text": v, "disabled": False} for v in vlist]
        gramasies = [{"value": "ALL GRAMASI", "text": "ALL GRAMASI", "disabled": False}] +                     [{"value": g, "text": g, "disabled": False} for g in glist]

        # SATUAN KEMASAN, diturunkan dari ekor nama barang ("... 1ML X 12 JAR"). Tidak ada
        # kolomnya di master, tetapi ia SATU-SATUNYA pembeda dua SKU yang kelompok, varian,
        # dan gramasinya sama persis — dan surat menyebutnya ("ELLIPS HAIR VITAMIN JAR").
        # Hanya kemasan yang benar-benar ada di kelompok ini yang ditawarkan.
        from shared import kemasan_of, norm
        ada = sorted({kemasan_of(it.get("nama_barang")) for it in (cache.get("items") or [])
                      if norm(it.get("kelompok")) == norm(group)} - {""})
        kemasans = [{"value": "ALL KEMASAN", "text": "ALL KEMASAN", "disabled": False}] + \
                   [{"value": k, "text": k, "disabled": False} for k in ada]

        return {"ok": True, "variants": variants, "gramasis": gramasies, "kemasans": kemasans}
    except Exception as e:
        append_error_log("summary_manual_master_options", e, {"user": user, "group": group, "token": token})
        payload = {"ok": False, "error": "Gagal memuat opsi master."}
        if APP_DEBUG and is_admin_user(user):
            payload["detail"] = str(e)
        return payload

@router.get("/summary/syarat-claim")
def summary_syarat_claim_get(request: Request, principle: str = ""):
    """Syarat klaim baku satu principal, per jenis program. Lihat `syarat_claim.py`."""
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    try:
        return {"ok": True, "principle": principle, "jenis": list(syarat_claim.JENIS),
                "syarat": syarat_claim.ambil(principle)}
    except Exception as e:
        append_error_log("summary_syarat_claim_get", e, {"user": user, "principle": principle})
        return {"ok": False, "error": "Gagal memuat syarat klaim."}


@router.post("/summary/syarat-claim")
async def summary_syarat_claim_set(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    if not validate_csrf_request(request, request.headers.get("X-CSRF-Token", "")):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        body = await request.json()
        syarat = body.get("syarat") or {}
        if not isinstance(syarat, dict):
            return JSONResponse(status_code=422, content={"ok": False, "error": "Isi syarat klaim tidak valid."})
        return {"ok": True, "syarat": syarat_claim.simpan(body.get("principle", ""), syarat)}
    except ValueError as e:
        return JSONResponse(status_code=422, content={"ok": False, "error": str(e)})
    except Exception as e:
        append_error_log("summary_syarat_claim_set", e, {"user": user})
        return {"ok": False, "error": "Gagal menyimpan syarat klaim."}


@router.post("/summary/manual/generate")
def summary_manual_generate(request: Request, token: str = Form(...), rows_json: str = Form(...)):

    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        if not owned(MANUAL_MASTER_CACHE.get(token), user):
            return {"ok": False, "error": "Token master tidak ditemukan / expired"}
        rows = json.loads(rows_json)
        if not isinstance(rows, list) or not 1 <= len(rows) <= 500 or len(rows_json) > 2 * 1024 * 1024:
            return JSONResponse(status_code=422, content={"ok": False, "error": "Isi 1–500 baris Summary, maksimal 2 MB."})
        if any(not isinstance(row, dict) for row in rows):
            return JSONResponse(status_code=422, content={"ok": False, "error": "Baris Summary tidak valid."})
        # FASE 5: identitas input DIUKUR DI SINI (rows msh murni, sblm diproses/dimutasi
        # di bawah -- _matched_items_cache dll ditempel belakangan). Order-sensitive: run
        # dokumen yg sama menghasilkan urutan baris yg sama (ekstraksi kini deterministik).
        _golden_input_key = canonical_signature(rows)

        cache = MANUAL_MASTER_CACHE[token]
        items = cache.get("items", [])
        principle_for_claim = str(cache.get("principle_name", "") or "").strip()
        # Keep direct PDF generation identical to draft save: explicit whole-master scope
        # resolves from the loaded master; an empty kelompok remains fail-closed.
        rows = _apply_native_kelompok(rows, items)

        def norm(x: object) -> str:
            return " ".join(str(x or "").strip().split()).upper()

        def split_list(val: str) -> List[str]:
            return [x.strip() for x in str(val or "").split(",") if x.strip()]

        def unit_from_text(text: str) -> str:
            t = norm(text)
            if "CTN" in t or "KRT" in t:
                return "CTN"
            return "PCS"

        def has_number(text: str) -> bool:
            return bool(re.search(r"\d", str(text or "")))

        # ponytail: nilai kelompok/variant/gramasi digabung pakai " & " saat konsolidasi, BUKAN koma.
        # split_list (koma) tak pernah memecahnya -> dulu tak ada compression/dedup. Pisah pakai " & ".
        # Pakai spasi wajib di sekitar & supaya varian spt "H.SHIN&STR HLD" tidak ikut terpecah.
        def split_amp(val: str) -> List[str]:
            return [x.strip() for x in re.split(r'\s+&\s+', str(val or "")) if x.strip()]

        def join_human(items: List[str]) -> str:
            if not items: return ""
            if len(items) == 1: return items[0]
            if len(items) == 2: return f"{items[0]} & {items[1]}"
            return ", ".join(items[:-1]) + f" & {items[-1]}"

        def format_array_human_readable(raw_str: str) -> str:
            seen = set()
            unique_arr = []
            for g in split_amp(raw_str):
                if g not in seen:
                    unique_arr.append(g)
                    seen.add(g)
            return join_human(unique_arr)

        def format_kelompoks_human_readable(raw_str: str) -> str:
            seen = set()
            unique_k = []
            for k in split_amp(raw_str):
                if k not in seen:
                    unique_k.append(k)
                    seen.add(k)

            from collections import defaultdict
            groups = defaultdict(list)
            order = []
            for k in unique_k:
                if " - " in k:
                    prefix, suffix = k.split(" - ", 1)
                    # "EDP - PRESTIGE" -> "EDP PRESTIGE" (rapikan dash internal sub-kelompok)
                    suffix = suffix.replace(" - ", " ").strip()
                else:
                    prefix, suffix = k, ""
                if prefix not in groups:
                    order.append(prefix)
                if suffix and suffix not in groups[prefix]:
                    groups[prefix].append(suffix)

            result_parts = []
            for prefix in order:
                clean = groups[prefix]
                if not clean:
                    result_parts.append(prefix)
                else:
                    result_parts.append(f"{prefix} - {join_human(clean)}")
            return join_human(result_parts)

        # Row Consolidation Algorithm: Merge rows that share exactly the same Base Prefix, Ketentuan, Benefit, and Channel.
        consolidated_rows_dict = {}
        idx_counter = 1
        
        for r in rows:
            # Safely extract prefix (e.g., 'BLAGIO HM' from 'BLAGIO HM - EDT')
            raw_k = str(r.get("kelompok", "")).strip()
            prefix = raw_k.split(" - ")[0] if " - " in raw_k else raw_k
            
            # The composite key dictates what gets merged together
            merge_key = (
                r.get("surat_program", ""),
                r.get("nama_program", ""),
                r.get("channel_gtmt", ""),
                r.get("periode", ""),
                prefix,
                norm(r.get("ketentuan", "")),
                norm(r.get("benefit", "")),
                norm(r.get("benefit_type", ""))
            )
            
            if merge_key not in consolidated_rows_dict:
                # First time seeing this combination, clone the row
                r_copy = dict(r)
                # Keep _matched_items_cache as a list of dictionaries if it exists
                cache = r_copy.get("_matched_items_cache", [])
                r_copy["_matched_items_cache"] = list(cache) if isinstance(cache, list) else []
                consolidated_rows_dict[merge_key] = r_copy
            else:
                # Merge into existing row
                target = consolidated_rows_dict[merge_key]
                
                # Append string fields using '&'
                for field in ["kelompok", "variant", "gramasi"]:
                    val1 = target.get(field, "")
                    val2 = r.get(field, "")
                    if val2:
                        target[field] = f"{val1} & {val2}" if val1 else val2
                        
                # Append comma separated fields
                for field in ["kode_barangs"]:
                    val1 = target.get(field, "")
                    val2 = r.get(field, "")
                    if val2:
                        target[field] = f"{val1},{val2}" if val1 else val2

                # KETERANGAN IKUT DIGABUNG, karena untuk baris yang DITAHAN ia satu-satunya
                # tempat barang itu menyebut namanya. Sampai 19 September 2026 hanya keterangan
                # baris pertama yang disimpan: surat DAHLIA 570 menahan DUA kode, `F601LB` dan
                # `F601SB`, keduanya melebur jadi satu baris cetak dan `F601SB` TIDAK MUNCUL
                # SAMA SEKALI di Form — pada lembar yang ditandatangani Operational Manager,
                # satu barang tertahan lenyap tanpa jejak. Baris bercocok kode tidak kehilangan
                # apa pun karena `kode_barangs` menyimpannya; baris tertahan tidak punya itu.
                # Yang sama persis tidak diulang: boilerplate "beban distributor" pada sepuluh
                # baris tetap tercetak sekali.
                ket_lama = str(target.get("keterangan", "") or "").strip()
                ket_baru = str(r.get("keterangan", "") or "").strip()
                if ket_baru:
                    sudah = [p.strip() for p in ket_lama.split(" | ") if p.strip()]
                    if ket_baru not in sudah:
                        target["keterangan"] = " | ".join(sudah + [ket_baru]) if sudah else ket_baru
                        
                # Merge caches
                incoming_cache = r.get("_matched_items_cache", [])
                if isinstance(incoming_cache, list):
                    target["_matched_items_cache"].extend(incoming_cache)

        # Re-assign the consolidated rows back to the main list
        rows = list(consolidated_rows_dict.values())
        
        # Apply Prefix Compressor and Formatter globally to all rows before PDF & Excel generation
        for i, r in enumerate(rows):
            r["no"] = str(i + 1)
            r["kelompok"] = format_kelompoks_human_readable(r.get("kelompok", ""))
            r["variant"] = format_array_human_readable(r.get("variant", ""))
            r["gramasi"] = format_array_human_readable(r.get("gramasi", ""))
            
            # Rebuild clean Kode Barangs without duplicates
            k_list = split_list(r.get("kode_barangs", ""))
            r["kode_barangs"] = ",".join(list(dict.fromkeys(k_list)))

        out_dir = os.path.join(BASE_DIR, "output", "summary_manual")
        _ensure_dir(out_dir)
        file_id = str(uuid.uuid4())

        form_path = os.path.join(out_dir, f"{file_id}_Form_Summary_Program.pdf")
        
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import landscape, A4
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
        from reportlab.lib.units import cm
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.enums import TA_CENTER, TA_RIGHT
        from reportlab.lib.units import inch
        from datetime import datetime
        
        # Get current date formatted for Indonesia
        now = datetime.now()
        months = ["JANUARI", "FEBRUARI", "MARET", "APRIL", "MEI", "JUNI", "JULI", "AGUSTUS", "SEPTEMBER", "OKTOBER", "NOVEMBER", "DESEMBER"]
        print_date = f"{now.month}/{now.day}/{now.year}"
        dibuat_date = f"{now.day:02d} {months[now.month - 1]} {now.year}"

        def my_canvas(canvas_obj, doc_obj):
            canvas_obj.saveState()
            canvas_obj.setFont('Helvetica-Bold', 7)
            # Top Left
            canvas_obj.drawString(doc_obj.leftMargin, landscape(A4)[1] - 0.5*cm, f"Di Print Tgl : {print_date}")
            # Top Right (Page Number)
            page_str = f"Hal {doc_obj.page}"
            canvas_obj.drawRightString(landscape(A4)[0] - doc_obj.rightMargin, landscape(A4)[1] - 0.5*cm, page_str)
            
            # Bottom of Header (Before Table Starts)
            canvas_obj.setFont('Helvetica', 8)
            canvas_obj.drawString(doc_obj.leftMargin, landscape(A4)[1] - 2*cm, f"Dibuat Tanggal : {dibuat_date}")
            canvas_obj.setFont('Helvetica-Bold', 8)
            canvas_obj.drawRightString(landscape(A4)[0] - doc_obj.rightMargin, landscape(A4)[1] - 2*cm, "(ON PRINCIPLE COKLAT)")
            
            canvas_obj.restoreState()

        # FASE 6: PDF reproducible (CreationDate/ModDate/doc-id tetap) -> byte-identik antar-run
        enable_pdf_determinism()
        # Update margins to give space for the custom canvas headers
        doc = SimpleDocTemplate(form_path, pagesize=landscape(A4), rightMargin=0.5*cm, leftMargin=0.5*cm, topMargin=2.2*cm, bottomMargin=0.5*cm)
        elements = []
        styles = getSampleStyleSheet()

        # Add Title and Subtitle properly centered
        title_style = styles["Heading3"].clone("TitleStyle")
        title_style.alignment = TA_CENTER
        title_style.fontSize = 12
        elements.append(Paragraph("<b>SUMMARY PROGRAM ON FAKTUR BEBAN PRINCIPLE (COKLAT)</b>", title_style))
        
        sub_style = styles["Normal"].clone("SubStyle")
        sub_style.alignment = TA_CENTER
        sub_style.fontSize = 11
        sub_style.fontName = 'Helvetica'
        
        # Determine Period globally from the first row if available
        global_period = rows[0].get("periode", "") if rows else ""
        period_text = f" PERIODE {global_period.upper()}" if global_period else ""
        elements.append(Paragraph(f"CV. SURYA PERKASA {period_text}", sub_style))
        elements.append(Spacer(1, 15))

        # KEPALA DUA BARIS. "Channel Outlet" memayungi dua kolom: channelnya (GT/MT) dan
        # ada-tidaknya daftar outlet peserta. Keduanya dipisah karena menjawab pertanyaan yang
        # berbeda — "di jalur mana" dan "untuk toko mana".
        KEPALA_ATAS = ["No.", "Surat Program", "Nama Program", "Channel Outlet", "", "Periode",
                       "Kelompok Barang", "Variant Barang", "Gramasi Barang", "Ketentuan Pengambilan",
                       "Benefit", "Syarat Claim", "Update", "Keterangan"]
        KEPALA_BAWAH = ["", "", "", "GT / MT", "Daftar Outlet", "", "", "", "", "", "", "", "", ""]
        KOL_OUTLET = 4
        # Kolom yang boleh digabung ke bawah bila isinya sama persis. `No`, `Ketentuan
        # Pengambilan`, dan `Benefit` TIDAK ikut: ketiganya yang membedakan baris satu sama lain,
        # dan menggabungkannya akan menyembunyikan strata.
        KOL_GABUNG = (1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13)

        header_style = styles["Normal"].clone("HeaderStyle")
        header_style.fontSize = 7
        header_style.leading = 8
        header_style.fontName = 'Helvetica-Bold'
        header_style.alignment = TA_CENTER
        header_style.textColor = colors.whitesmoke
        
        baris_teks: List[List[str]] = []

        cell_style = styles["Normal"].clone("CellStyle")
        cell_style.fontSize = 6
        cell_style.leading = 7
        cell_style.alignment = TA_CENTER

        from shared import xml_escape

        def sel(nilai):
            # ReportLab membaca teks Paragraph sebagai markup: "B&B ALL VARIANT" tercetak
            # "B&B; ALL VARIANT", dan satu "<" apa pun menggagalkan halaman. Isi sel adalah
            # data dari surat, bukan markup.
            return Paragraph(xml_escape(str(nilai)), cell_style)

        # Angka rupiah dicetak berdesimal. Yang disimpan tetap polos — pemisah ribuan dipasang
        # DI SINI saja, supaya yang menghitung tidak pernah menemukan titik di dalam angkanya.
        # Sengaja hanya angka yang jelas rupiah (didahului "Rp" atau berdiri di awal benefit),
        # supaya tahun seperti "2026" tidak ikut berubah jadi "2.026".
        def _titik(angka: str) -> str:
            return f"{int(angka):,}".replace(",", ".")

        def desimal(teks) -> str:
            return re.sub(r"(Rp\.?\s*)(\d{4,})", lambda m: m.group(1) + _titik(m.group(2)), str(teks or ""))

        # Tiga keadaan, bukan dua. "Hanya" dan "Kecuali" sama-sama memakai daftar outlet tetapi
        # ARAHNYA berlawanan; meleburnya jadi satu kata "Ada List" membalik arti surat pada
        # lembar yang justru dipakai mencocokkan dengan suratnya.
        def outlet_display(r) -> str:
            mode = str(r.get("outlet_mode", "") or "").strip().lower()
            return {"only": "Hanya List", "except": "Kecuali List"}.get(mode, "Tanpa List")

        # Batas waktu klaim tidak dicetak di lembar ini (keputusan pengguna 18 Sep 2026): ia
        # bukan bagian dari pencocokan fisik dengan surat, dan surat pernah mencantumkan tanggal
        # yang tidak ada ("31 Juni"). Peringatannya tetap hidup di layar saat surat dibaca.
        def syarat_display(r) -> str:
            teks = str(r.get("syarat_claim", "") or "").strip()
            return re.sub(r"[,;]?\s*selambat-?\s*lambatnya[^.]*\.?\s*$", "", teks, flags=re.I).strip()

        # "surat menyebut: ..." tidak dicetak lagi. Kolom ini untuk batasan yang menentukan
        # eksekusi, bukan untuk menggemakan kalimat suratnya.
        def keterangan_display(r) -> str:
            teks = str(r.get("keterangan", "") or "").strip()
            return "" if teks.lower().startswith("surat menyebut") else teks

        def benefit_display(r) -> str:
            # ponytail: cut price (DISC_RP) tampilkan per-satuan (default PCS) -> "4700/PCS".
            # BONUS_QTY sudah "1 PCS", DISC_PCT sudah "5%" -> biarkan apa adanya.
            b = str(r.get("benefit", "") or "").strip()
            bt = norm(r.get("benefit_type", ""))
            if bt == "DISC_RP" and re.fullmatch(r"\d{4,}", b):
                b = _titik(b)
            if bt == "DISC_RP" and has_number(b) and "/" not in b:
                # AMBANG RUPIAH BERARTI POTONGAN SENOTA, BUKAN PER SATUAN.
                #
                # Program MSG berbunyi "minimal belanja Rp 1.000.000 potong Rp 20.000" — satu
                # potongan untuk seluruh nota. Menuliskannya "20000/PCS" di lembar yang dibaca
                # orang berarti menjanjikan Rp 20.000 per barang; pada nota sepuluh baris itu
                # sepuluh kali lipat dari bunyi suratnya.
                from summary_rules import threshold_of
                _jenis, _, _ = threshold_of(str(r.get("ketentuan", "")))
                if _jenis == "value":
                    return f"{b}/NOTA"
                unit = unit_from_text(str(r.get("ketentuan", "")) + " " + b)
                return f"{b}/{unit}"
            # Pembaca surat mengeluarkan persen sebagai angka telanjang ("3"), dan angka itulah
            # yang dipakai menghitung. Di lembar yang diteken orang, "3" sendirian tidak berarti
            # apa-apa — satuannya dipasang di sini, bukan disimpan ke datanya.
            if bt == "DISC_PCT" and b and not b.endswith("%"):
                return f"{b}%"
            return b

        # ============================================================
        # SINGLE SOURCE OF TRUTH: cocokkan tiap baris surat ke item per-SKU SEKALI di sini.
        # PDF (loop di bawah) & Excel (setelah PDF, lihat blok Excel) SAMA-SAMA dibangun dari
        # hasil ini -- tidak ada lagi 2 pipeline independen yang bisa saling berbeda (akar
        # divergensi PDF vs Excel yg dilaporkan user).
        # ============================================================
        channel_seq: Dict[str, int] = {}
        pdf_meta: Dict[int, dict] = {}
        pdf_items: Dict[int, list] = {}
        excel_rows: List[Dict[str, Any]] = []
        flagged_mismatches: List[Dict[str, Any]] = []
        flagged_conflicts: List[Dict[str, Any]] = []

        for i, r in enumerate(rows):
            kelompok = str(r.get("kelompok","") or "").strip()
            vlist = split_list(r.get("variant",""))
            glist_raw = str(r.get("gramasi","") or "")
            glist = split_list(glist_raw)
            v_all = (not vlist) or any(norm(x) == "ALL VARIANT" for x in vlist)
            g_all = (not glist) or any(norm(x) == "ALL GRAMASI" for x in glist)

            ket = str(r.get("ketentuan","") or "").strip()
            promo_label = str(r.get("nama_program","") or "").strip()
            promo_group_id = str(r.get("promo_group_id","") or "").strip()
            promo_group = str(r.get("channel_gtmt","") or "").strip()
            # Kolom "Periode" membaca `periode`, tetapi baris draft menyimpan
            # `periode_start`/`periode_end` dan TIDAK ADA yang pernah menulis `periode` — jadi
            # kolomnya kosong di setiap Form Summary yang pernah dicetak. Diturunkan bila kosong.
            periode = str(r.get("periode","") or "").strip()
            if not periode:
                from shared import _label_periode
                periode = _label_periode(r.get("periode_start"), r.get("periode_end"))
            if not promo_group_id or promo_group_id.upper() == "NON_GROUP":
                promo_group_id = promo_group

            pdf_meta[i] = {
                "no": i + 1, "surat_program": r.get("surat_program",""), "nama_program": promo_label,
                "channel_gtmt": promo_group, "periode": periode, "ketentuan": ket,
                "benefit_type": r.get("benefit_type",""), "benefit": r.get("benefit",""),
                # Kolom "Syarat Claim" dicetak di setiap Form Summary dan tidak pernah ada
                # isinya, karena tidak ada satu pun tempat untuk mengisinya. Setelan baku per
                # principal + jenis program menempel di sini; baris yang punya syaratnya
                # sendiri TIDAK ditimpa.
                "syarat_claim": (str(r.get("syarat_claim", "") or "").strip()
                                 or syarat_claim.untuk(principle_for_claim or r.get("principle", ""), r.get("benefit_type", ""))),
                "keterangan": r.get("keterangan",""),
                "variant_display": r.get("variant",""), "kelompok_fallback": r.get("kelompok",""),
                # Kelayakan outlet ikut dicetak: tanpa ini lembarnya tidak bisa membedakan
                # program untuk peserta daftar dari program yang justru mengecualikan mereka.
                "outlet_mode": r.get("outlet_mode", ""),
                "update": r.get("update", ""),
            }
            pdf_items[i] = []

            matched_items = []
            klist = [k.strip() for k in str(r.get("kode_barangs", "")).split(",") if k.strip()]

            if klist:
                for it in items:
                    if str(it.get("kode_barang", "")).strip() in klist:
                        matched_items.append(it)
                # ponytail: guard V3b -- kode dari AI divalidasi silang ke gramasi yg BENERAN
                # diklaim baris surat ini (terbukti live: "Pomade 80gr" salah nyantol ke master
                # "PMD KIDZ" gramasi 40gr krn AI cuma percaya kode_barangs GPT tanpa cross-check).
                # Kalau gramasi master tidak muncul sama sekali di klaim surat -> buang & catat,
                # JANGAN diam-diam dipakai (akurasi finansial wajib, bukan tebak-tebakan).
                if not g_all and glist:
                    _kept = []
                    for it in matched_items:
                        it_gram = norm(it.get("gramasi"))
                        if any(it_gram and (norm(g) == it_gram or it_gram in norm(g) or norm(g) in it_gram) for g in glist):
                            _kept.append(it)
                        else:
                            flagged_mismatches.append({
                                "kode_barang": it.get("kode_barang"), "nama_barang": it.get("nama_barang"),
                                "gramasi_master": it.get("gramasi"), "gramasi_klaim_surat": glist_raw,
                                "channel": promo_group, "ketentuan": ket,
                            })
                    matched_items = _kept

            if not matched_items:
                fb_kelompok = kelompok
                if fb_kelompok and any(skip in fb_kelompok.lower() for skip in ["- kelompok -", "bisa meleset"]):
                    fb_kelompok = ""
                # BARIS TANPA KELOMPOK TIDAK MENCOCOK APA PUN — dan ini perbaikan mahal.
                #
                # Dulu kelompok kosong berarti `pool = items`: SELURUH master. Satu baris surat
                # yang tak tercocokkan lalu mengklaim setiap kode di channelnya, penjaga V4
                # melihat tiap kode dipakai dua baris, dan MEMBUANGNYA DARI KEDUANYA. Terbukti
                # 2026-09-16 pada Priskila: satu baris sisa membuat seluruh blok RETAIL terbit
                # "(TIDAK ADA ITEM COCOK DI MASTER)" padahal 163 kodenya sudah benar.
                #
                # Kelompok yang tidak ada di master diperlakukan sama. "Tidak tahu" bukan
                # "semuanya" — baris begitu memang harus ditandai untuk ditinjau orang, dan
                # itulah yang terjadi sekarang.
                pool = [it for it in items if norm(it.get("kelompok")) == norm(fb_kelompok)] if fb_kelompok else []
                for it in pool:
                    it_variant = norm(it.get("variant")); it_nama = norm(it.get("nama_barang"))
                    variant_match = v_all
                    if not variant_match:
                        for v in [norm(x) for x in vlist]:
                            if "- variant -" in v.lower() or "all variant" in v.lower() or "bisa meleset" in v.lower():
                                variant_match = True; break
                            if v == it_nama or v == it_variant or (len(v) > 5 and v in it_nama):
                                variant_match = True; break
                    if not variant_match: continue
                    it_gramasi = norm(it.get("gramasi"))
                    gramasi_match = g_all
                    if not gramasi_match:
                        for g in [norm(x) for x in glist]:
                            if "- gramasi -" in g.lower() or "all gramasi" in g.lower() or "bisa meleset" in g.lower():
                                gramasi_match = True; break
                            if g == it_gramasi or (len(g) > 2 and g in it_nama):
                                gramasi_match = True; break
                    if not gramasi_match: continue
                    matched_items.append(it)

            _seen_kb, _dedup = set(), []
            for _it in matched_items:
                _kb = str(_it.get("kode_barang","")).strip()
                if _kb and _kb in _seen_kb: continue
                _seen_kb.add(_kb); _dedup.append(_it)
            matched_items = _dedup

            # Ambang beli dibaca dengan PEMBACA YANG SAMA dengan aturan terbit (`threshold_of`).
            #
            # `parse_number_id` membuang semua non-angka dari kalimatnya lebih dulu, jadi
            # "Setiap pembelian 30 PCS OVALE 2IN1 CLEANSER MIX VARIANT" menjadi "3021" —
            # 30, lalu 2 dan 1 yang terkeruk dari "2IN1". Angka di dalam NAMA BARANG menular
            # ke ambang belinya. Kolom TRIGGER_QTY ini kolom yang sama yang dimuat ke
            # `promo_rule`, jadi aturannya tersimpan sebagai "beli 3021 PCS": rapi, terlihat
            # benar, dan tidak pernah cocok dengan potongan mana pun.
            trig_qty, trig_unit = "", ""
            if ket:
                from summary_rules import threshold_of
                _jenis, _min, _satuan = threshold_of(ket)
                if _jenis == "quantity":
                    trig_qty, trig_unit = _min, _satuan
                elif _jenis == "value":
                    trig_qty, trig_unit = _min, "RP"
            benefit_text = str(r.get("benefit","") or "").strip()
            benefit_type = str(r.get("benefit_type","") or "").strip()
            benefit_unit = unit_from_text(benefit_text) if benefit_text else ""

            if not matched_items:
                excel_rows.append({"pdf_key": i, "channel": promo_group, "kode_barang": "", "nama_barang": "",
                                    "promo_label": promo_label, "pg_id": promo_group_id, "periode": periode,
                                    "trig_qty": trig_qty, "trig_unit": trig_unit, "benefit_type": benefit_type,
                                    "benefit_text": benefit_text, "benefit_unit": benefit_unit})
                continue

            pdf_items[i].extend(matched_items)

            from collections import defaultdict
            grouped_by_master_kel = defaultdict(list)
            for it in matched_items:
                grouped_by_master_kel[str(it.get("kelompok","")).strip()].append(it)

            for master_kel, items_in_kel in grouped_by_master_kel.items():
                current_pg_id = promo_group_id
                if not current_pg_id or current_pg_id.upper() == "NON_GROUP" or current_pg_id == promo_group:
                    prefix = "".join(e for e in promo_group if e.isalnum())
                    if not prefix: prefix = "Retail"
                    channel_seq[prefix] = channel_seq.get(prefix, 0) + 1
                    current_pg_id = f"{prefix}_{channel_seq[prefix]}"
                for it in items_in_kel:
                    excel_rows.append({"pdf_key": i, "channel": promo_group, "kode_barang": str(it.get("kode_barang","")),
                                        "nama_barang": str(it.get("nama_barang","")), "promo_label": promo_label,
                                        "pg_id": current_pg_id, "periode": periode, "trig_qty": trig_qty,
                                        "trig_unit": trig_unit, "benefit_type": benefit_type, "benefit_text": benefit_text,
                                        "benefit_unit": benefit_unit})

        # ponytail: guard V4 -- 1 kode fisik tidak boleh nyantol di >1 baris-surat (tier beda) dlm
        # channel yg sama (terbukti live: "Pmd Wtr Bas" muncul di baris 4+1 DAN 7+1 sekaligus).
        # Akurasi finansial wajib -> JANGAN menebak salah satu benar, buang dari SEMUA sisi (Excel
        # & PDF) dan wajib direview manusia lewat tombol Laporkan Salah.
        #
        # POTONGAN SETINGKAT NOTA TIDAK IKUT DIUJI, dan itu bukan pelonggaran.
        #
        # Penjaga ini menangkap dua baris yang MENGKLAIM BARANG yang sama dengan paket berbeda —
        # "Pmd Wtr Bas" di baris 4+1 sekaligus 7+1. Di situ memang ada dua jawaban untuk satu
        # barang, dan menebak salah satunya berarti menebak uang.
        #
        # Program MSG tidak begitu. Ambangnya NILAI BELANJA (`trig_unit == "RP"`), potongannya
        # untuk SELURUH nota, dan daftar barangnya cuma menyatakan belanja mana yang ikut
        # dihitung — bukan klaim per barang. Sepuluh strata "Rp 1jt -> 20rb ... Rp 10jt -> 200rb"
        # karena itu menyentuh 647 kode yang sama sepuluh kali, dan penjaga ini membuang
        # SEMUANYA: Form Summary `BP2609006016` terbit penuh "(TIDAK ADA ITEM COCOK DI MASTER)"
        # padahal tidak ada satu pun pertentangan di dalamnya. Strata bukan bentrok — strata
        # justru bentuk yang sudah disatukan `compile_programs` menjadi satu program bertingkat.
        kode_channel_to_pdfkeys: Dict[Tuple[str, str], set] = {}
        for er in excel_rows:
            if er["kode_barang"] and str(er.get("trig_unit", "")).upper() != "RP":
                kode_channel_to_pdfkeys.setdefault((er["channel"], er["kode_barang"]), set()).add(er["pdf_key"])
        conflicted = {k for k, v in kode_channel_to_pdfkeys.items() if len(v) > 1}
        if conflicted:
            kept_excel_rows = []
            for er in excel_rows:
                ck = (er["channel"], er["kode_barang"])
                if er["kode_barang"] and ck in conflicted:
                    flagged_conflicts.append({"kode_barang": er["kode_barang"], "nama_barang": er["nama_barang"],
                                               "channel": er["channel"], "pg_id": er["pg_id"]})
                else:
                    kept_excel_rows.append(er)
            excel_rows = kept_excel_rows
            # PEMBUANGANNYA WAJIB IKUT CHANNEL, sama seperti pendeteksiannya.
            #
            # Dulu channel-nya dilepas di sini (`{kb for (_, kb) in conflicted}`), jadi satu kode
            # yang bentrok di MTI ikut dibuang dari RETAIL, GROSIR, dan STAR OUTLET — padahal di
            # sana ia tidak bentrok dengan apa pun. Excel tetap menyimpannya karena Excel memang
            # menyaring per pasangan (channel, kode); PDF-lah yang kehilangan. Hasilnya blok
            # RETAIL surat Priskila terbit penuh "(TIDAK ADA ITEM COCOK DI MASTER)" sementara
            # Dataset-nya berisi lengkap — persis ketidaksimetrisan yang dijaga baris I checklist.
            for i in pdf_items:
                channel_baris = str(pdf_meta.get(i, {}).get("channel_gtmt", ""))
                pdf_items[i] = [it for it in pdf_items[i]
                                if (channel_baris, str(it.get("kode_barang", "")).strip()) not in conflicted]

        for i in range(len(rows)):
            meta = pdf_meta[i]
            items_in_row = pdf_items.get(i, [])

            # PROGRAM SELURUH KATALOG DITULIS SEKALI, BUKAN DIURAIKAN.
            #
            # Surat seperti MSG (`BP2609006016`) berlaku untuk seluruh barang principal — 647
            # kode, 107 kelompok. Menguraikannya membuat SATU sel setinggi 9.631 titik, dan
            # ReportLab menolak mencetaknya sama sekali ("too large on page"): Form Summary-nya
            # gagal terbit, bukan sekadar jelek.
            #
            # Dan seandainya muat pun, lembar berisi 107 nama kelompok yang sama di sepuluh
            # strata bukan lembar yang lebih informatif. Yang perlu dibaca orang di meeting cuma:
            # berlaku untuk SEMUA barang, dengan ketentuan ini. Keputusan pengguna 17 Sep 2026.
            #
            # Kode barangnya TIDAK hilang — Dataset Excel tetap memuat ke-647 barisnya, dan
            # aturan yang dimuat ke `promo_rule` tetap dari daftar kode yang utuh.
            if norm(meta.get("kelompok_fallback", "")) == "ALL KELOMPOK BARANG":
                baris_teks.append([
                    str(meta["no"]),
                    str(meta.get("surat_program", "")),
                    str(meta.get("nama_program", "")),
                    str(meta.get("channel_gtmt", "")),
                    outlet_display(meta),
                    str(meta.get("periode", "")),
                    "ALL KELOMPOK BARANG",
                    "All Variant",
                    "All Gramasi",
                    desimal(meta.get("ketentuan", "")),
                    benefit_display(meta),
                    syarat_display(meta),
                    str(meta.get("update", "")),
                    keterangan_display(meta),
                ])
                continue

            seen_kel, kel_order = set(), []
            for it in items_in_row:
                k = str(it.get("kelompok","")).strip()
                if k and k not in seen_kel:
                    seen_kel.add(k); kel_order.append(k)
            # ponytail: JANGAN jatuh ke teks kelompok mentah klaim AI kalau semua item-nya sudah
            # dibuang guard (terbukti live: "BLAGIO HM - PMD KIDZ" halusinasi tetap bocor ke PDF
            # walau Excel-nya sudah bersih -- itu justru meniadakan tujuan guard V3b/V4). Kalau
            # tidak ada item valid sama sekali, tandai jelas utk direview, jangan tampilkan nama
            # yang belum tentu benar.
            if kel_order:
                kelompok_display = format_kelompoks_human_readable(" & ".join(kel_order))
            elif meta.get("kelompok_fallback",""):
                kelompok_display = "(TIDAK ADA ITEM COCOK DI MASTER -- PERLU REVIEW MANUAL)"
            else:
                kelompok_display = ""

            if not items_in_row or norm(meta.get("variant_display","")).replace(" ","") == "ALLVARIANT":
                variant_display = meta.get("variant_display","")
            else:
                seen_v, v_order = set(), []
                for it in items_in_row:
                    v = str(it.get("variant","")).strip()
                    if v and v not in seen_v:
                        seen_v.add(v); v_order.append(v)
                variant_display = format_array_human_readable(" & ".join(v_order)) if v_order else meta.get("variant_display","")

            # guard/fix E: SATU ENTRI GRAMASI PER KELOMPOK BARANG, urutan sesuai kelompok,
            # JANGAN di-dedupe lintas kelompok walau angkanya kebetulan sama (mis. 2 kelompok
            # sama-sama 100ml tetap harus tampil 2x sesuai posisi kelompoknya).
            gramasi_parts = []
            for k in kel_order:
                gram_for_k, seen_g = [], set()
                for it in items_in_row:
                    if str(it.get("kelompok","")).strip() == k:
                        g = str(it.get("gramasi","")).strip()
                        if g and g not in seen_g:
                            seen_g.add(g); gram_for_k.append(g)
                if gram_for_k:
                    gramasi_parts.append(",".join(gram_for_k))
            gramasi_display = join_human(gramasi_parts)

            baris_teks.append([
                str(meta["no"]),
                str(meta.get("surat_program","")),
                str(meta.get("nama_program","")),
                str(meta.get("channel_gtmt","")),
                outlet_display(meta),
                str(meta.get("periode","")),
                str(kelompok_display),
                str(variant_display),
                str(gramasi_display),
                desimal(meta.get("ketentuan","")),
                benefit_display(meta),
                syarat_display(meta),
                str(meta.get("update","")),
                keterangan_display(meta),
            ])
            
        # Ruang yang BENAR-BENAR bisa dipakai, bukan sekadar halaman dikurangi margin:
        # ReportLab menambah padding 6pt di tiap sisi `Frame` (bawaan `Frame`), jadi isi
        # halaman 12pt lebih sempit dan 12pt lebih pendek daripada `doc.width`/`doc.height`.
        # Selama ini lebar tabel dihitung dari margin saja, sehingga tabelnya 12pt LEBIH LEBAR
        # daripada frame yang memuatnya — ReportLab sendiri melaporkannya sebagai
        # frame 'normal'(801.5 x 506.7) saat ia menyerah pada surat DAHLIA.
        PADDING_FRAME = 6
        usable = doc.width - 2 * PADDING_FRAME
        tinggi_halaman = doc.height - 2 * PADDING_FRAME
        cw = [usable * bagian for bagian in LEBAR_KOLOM]
            
        table_data = [[Paragraph(h, header_style) for h in KEPALA_ATAS],
                      [Paragraph(h, header_style) for h in KEPALA_BAWAH]]
        table_data += [[sel(nilai) for nilai in baris] for baris in baris_teks]

        GAYA_DASAR = [
            ('BACKGROUND', (0, 0), (-1, 1), colors.HexColor('#9E7C85')), # Match the brownish pink header color
            ('TEXTCOLOR', (0, 0), (-1, 1), colors.black),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('FONTNAME', (0, 0), (-1, 1), 'Helvetica-Bold'),
            ('BOTTOMPADDING', (0, 0), (-1, 1), 6),
            ('TOPPADDING', (0, 0), (-1, 1), 6),
            ('BACKGROUND', (0, 2), (-1, -1), colors.white),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.black),
            ('WORDWRAP', (0, 0), (-1, -1), True),
            ('SPAN', (3, 0), (KOL_OUTLET, 0)),  # "Channel Outlet" memayungi dua kolom
        ]
        # Kepala satu kolom yang tidak punya sub-kolom membentang dua baris.
        GAYA_DASAR += [('SPAN', (i, 0), (i, 1)) for i in range(len(KEPALA_ATAS)) if i not in (3, KOL_OUTLET)]
        AWAL = 2  # dua baris kepala

        def bangun_tabel(potongan, boleh_pecah_dalam_baris=True):
            """Satu tabel utuh untuk SATU halaman, dengan penggabungan dihitung ULANG.

            SEL YANG ISINYA SAMA DIGABUNG KE BAWAH: sepuluh strata MSG sebenarnya SATU
            program dengan sepuluh tier, jadi mengulang nomor surat, nama program, channel,
            dan periodenya sepuluh kali hanya membuat lembarnya sulit dibaca. Tetapi
            penggabungan itu dihitung DI DALAM potongan ini saja — itulah inti perbaikannya,
            lihat catatan di pemanggilnya.
            """
            data = [[Paragraph(h, header_style) for h in KEPALA_ATAS],
                    [Paragraph(h, header_style) for h in KEPALA_BAWAH]]
            data += [[sel(nilai) for nilai in baris] for baris in potongan]
            gaya = list(GAYA_DASAR)
            for kolom in KOL_GABUNG:
                mulai = 0
                for i in range(1, len(potongan) + 1):
                    sama = i < len(potongan) and potongan[i][kolom] == potongan[mulai][kolom] \
                        and potongan[i][1] == potongan[mulai][1]  # jangan lintas surat program
                    if sama:
                        continue
                    if i - mulai > 1:
                        gaya.append(('SPAN', (kolom, AWAL + mulai), (kolom, AWAL + i - 1)))
                    mulai = i
            tabel = Table(data, repeatRows=2, colWidths=cw,
                          splitInRow=1 if boleh_pecah_dalam_baris else 0)
            tabel.setStyle(TableStyle(gaya))
            return tabel

        # SATU TABEL PER HALAMAN, DIPECAH SENDIRI — bukan diserahkan ke ReportLab.
        #
        # Sebabnya bukan kerapian. `baris_teks` memuat nilai LENGKAP di setiap baris;
        # penggabungan hanyalah gaya `SPAN`, dan ReportLab merender sel pertama sebuah span
        # lalu MENYEMBUNYIKAN sisanya. Begitu satu span terpotong batas halaman, yang tersisa
        # di halaman berikutnya adalah sel-sel tersembunyi itu: Surat Program, Nama Program,
        # Channel, dan Periode tercetak KOSONG. Pada lembar yang ditandatangani Operational
        # Manager itu bukan cacat tampilan — pembacanya tidak bisa tahu baris itu milik surat
        # yang mana. Terlihat 19 September 2026 pada Form DAHLIA halaman 2.
        #
        # Maka batas halaman ditentukan lebih dulu, lalu penggabungan dihitung ULANG di dalam
        # tiap potongan. Akibatnya setiap halaman selalu memulai bloknya sendiri dan nilai
        # identitasnya muncul lagi di baris teratas halaman itu.
        #
        # Yang menentukan batasnya tetap ReportLab sendiri (`Table.split`), jadi tinggi baris
        # tidak pernah kita tebak. `splitInRow=0` saat mengukur supaya pemotongan hanya terjadi
        # di batas baris; satu baris yang lebih tinggi dari satu halaman ditangani terpisah di
        # bawah, karena baris seperti itu memang tidak bisa utuh di mana pun.
        from reportlab.platypus import PageBreak

        # Halaman PERTAMA punya ruang lebih sedikit: judul dan nama perusahaan berdiri di atas
        # tabel sebagai flowable, bukan digambar canvas. Tanpa memperhitungkannya, potongan
        # pertama diukur terhadap halaman penuh, tidak muat bersama judulnya, lalu terdorong
        # utuh ke halaman berikutnya — meninggalkan halaman pertama kosong.
        tinggi_judul = sum(e.wrap(usable, tinggi_halaman)[1] for e in elements)

        sisa = list(baris_teks)
        halaman_pertama = True
        while sisa:
            tersedia = tinggi_halaman - (tinggi_judul if halaman_pertama else 0)
            ukur = bangun_tabel(sisa, boleh_pecah_dalam_baris=False)
            ukur.wrap(usable, tersedia)
            bagian = ukur.split(usable, tersedia)
            muat = len(sisa) if len(bagian) <= 1 else max(1, len(bagian[0]._cellvalues) - AWAL)

            # Ukuran di atas baru TEBAKAN AWAL, dan harus diperiksa ulang: menghitung
            # penggabungan per potongan MENGUBAH tinggi barisnya. Span yang di tabel penuh
            # membentang sepuluh baris, di potongan ini mungkin hanya membentang tiga — teks
            # yang sama kini harus muat di ruang yang lebih pendek, jadi barisnya meninggi.
            # Tanpa pemeriksaan ini potongannya meluber dan ReportLab memecahnya lagi, persis
            # kembali ke cacat yang sedang diperbaiki: halaman berikutnya tanpa identitas.
            while muat > 1:
                if bangun_tabel(sisa[:muat]).wrap(usable, tersedia)[1] <= tersedia:
                    break
                muat -= 1
            # Pecah-dalam-baris hanya untuk potongan SATU baris, yaitu baris yang lebih tinggi
            # daripada satu halaman dan memang tidak bisa utuh di mana pun. Untuk potongan yang
            # sudah pasti muat, mengizinkannya justru membuat ReportLab memecah lebih dulu
            # alih-alih menempatkan — hasilnya halaman berisi kepala tabel saja.
            _t = bangun_tabel(sisa[:muat], boleh_pecah_dalam_baris=(muat == 1))
            if os.getenv("SUMMARY_DEBUG_PAGINASI"):
                print(f"[paginasi] potongan {muat} baris, tinggi {_t.wrap(usable, tersedia)[1]:.1f} "
                      f"/ {tersedia:.1f}, sisa {len(sisa) - muat}")
            elements.append(_t)
            sisa = sisa[muat:]
            halaman_pertama = False
            if sisa:
                elements.append(PageBreak())
        
        # Add the Footer Signatures
        elements.append(Spacer(1, 25))
        
        footer_style_left = styles["Normal"].clone("FooterLeft")
        footer_style_left.fontSize = 8
        footer_style_left.fontName = 'Helvetica-Bold'
        
        footer_style_right = styles["Normal"].clone("FooterRight")
        footer_style_right.fontSize = 8
        footer_style_right.fontName = 'Helvetica-Bold'
        footer_style_right.alignment = TA_RIGHT

        footer_style_center = styles["Normal"].clone("FooterCenter")
        footer_style_center.fontSize = 8
        footer_style_center.fontName = 'Helvetica-Bold'
        footer_style_center.alignment = TA_CENTER
        footer_style_center.leading = 10

        # Lima penanda tangan, berurutan sesuai alur persetujuan: yang membuat, dua yang
        # mengetahui, yang memeriksa klaim, dan yang menyetujui.
        TANDA_TANGAN = [("Dibuat Oleh,", "Admin"),
                        ("Diketahui Oleh,", "SM"),
                        ("Diketahui Oleh,", "Kepala Accounting"),
                        ("Diperiksa Oleh,", "Claim"),
                        ("Disetujui Oleh,", "Operational Manager")]
        garis = "(.............................)"
        sig_data = [
            [Paragraph(peran, footer_style_center) for peran, _ in TANDA_TANGAN],
            [Spacer(1, 42)] * len(TANDA_TANGAN),  # ruang untuk tanda tangan
            [Paragraph(f"{nama}<br/>{garis}", footer_style_center) for _, nama in TANDA_TANGAN],
        ]

        elements.append(Paragraph(f"Makassar , {dibuat_date}", footer_style_right))
        elements.append(Spacer(1, 10))
        lebar_ttd = usable / float(len(TANDA_TANGAN))
        sig_table = Table(sig_data, colWidths=[lebar_ttd] * len(TANDA_TANGAN))
        sig_table.setStyle(TableStyle([
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 2),
            ('RIGHTPADDING', (0, 0), (-1, -1), 2),
        ]))

        elements.append(sig_table)
        
        doc.build(elements, onFirstPage=my_canvas, onLaterPages=my_canvas)

        dataset_path = os.path.join(out_dir, f"{file_id}_Dataset_Diskon_With_Channel.xlsx")
        wb2 = openpyxl.Workbook()
        ws2 = wb2.active
        ws2.title = "Dataset"
        headers2 = [
            "KODE_BARANG", "NAMA_BARANG", "PROMO_LABEL", "PROMO_GROUP_ID", "PROMO_GROUP",
            "PERIODE", "PROMO_ACTIVE", "TIER_NO", "TRIGGER_QTY", "TRIGGER_UNIT",
            "BENEFIT_TYPE", "BENEFIT_VALUE", "BENEFIT_UNIT", "BENEFIT_BEBAN"
        ]
        ws2.append(headers2)

        # FASE 4b: override koreksi manusia (stable key kode_barang+channel+no_surat) --
        # menang atas HASIL APA PUN (parser posisional, variant_resolver, atau LLM lama).
        # Key TIDAK PERNAH pakai posisi/index baris -> aman walau urutan OCR run berikutnya beda.
        for _er in excel_rows:
            _er["no_surat"] = pdf_meta.get(_er.get("pdf_key"), {}).get("surat_program", "")
        excel_rows, _correction_log = apply_stable_corrections(excel_rows, load_stable_corrections())

        # excel_rows sudah dihitung SEKALI di atas (dipakai jg utk PDF) -- di sini cuma tulis ke sheet.
        excel_tier_counter: Dict[Tuple[str, str, str, str], int] = {}
        for er in excel_rows:
            tkey = (er["promo_label"], er["pg_id"], er["channel"], er["kode_barang"])
            excel_tier_counter[tkey] = excel_tier_counter.get(tkey, 0) + 1
            ws2.append([
                er["kode_barang"], er["nama_barang"], er["promo_label"], er["pg_id"], er["channel"],
                er["periode"], True, excel_tier_counter[tkey], er["trig_qty"], er["trig_unit"],
                er["benefit_type"], er["benefit_text"], er["benefit_unit"], "PABRIK",
            ])
        wb2.save(dataset_path)
        # FASE 6: paku timestamp entry-zip + core.xml modified -> xlsx byte-identik antar-run
        finalize_xlsx(dataset_path)

        if flagged_mismatches or flagged_conflicts:
            append_error_log("summary_manual_generate_flags", Exception("data quality flags"), {
                "mismatch_count": len(flagged_mismatches), "conflict_count": len(flagged_conflicts),
            })

        MANUAL_OUTPUTS[file_id] = {"owner": identity(user), "form": form_path, "dataset": dataset_path}

        # FASE 5: golden snapshot. Input baris identik (dok+approval sama) HARUS -> output identik.
        # input_key: urutan baris diabaikan (identitas dok). output_sig: urutan DIPERTAHANKAN
        # (drift urutan pun terdeteksi). status "drift" = regresi non-determinisme -> dilaporkan
        # ke UI, golden TIDAK ditimpa diam2 (butuh approve manual). Gagal apa pun di sini tak
        # boleh menggagalkan generate -> dibungkus try (fitur audit, bukan jalur kritikal output).
        _determinism = None
        try:
            _output_sig = canonical_signature(excel_rows)
            _g = golden_check_and_freeze(_golden_input_key, _output_sig, {"user": user, "file_id": file_id})
            _determinism = _g["status"]
            if _determinism == "drift":
                append_error_log("summary_golden_drift", Exception("output berbeda utk input identik"), {
                    "input_key": _golden_input_key, "golden_sig": _g.get("golden_sig"),
                    "current_sig": _g.get("current_sig"), "user": user,
                })
        except Exception as _ge:
            append_error_log("summary_golden_error", _ge, {"user": user})

        return {"ok": True, "file_id": file_id, "flagged_mismatches": flagged_mismatches,
                "flagged_conflicts": flagged_conflicts, "determinism": _determinism}
    except Exception as e:
        append_error_log("summary_manual_generate", e, {"user": user, "token": token})
        payload = {"ok": False, "error": "Gagal membuat output summary manual."}
        # Sebabnya diperlihatkan kepada ADMIN, tidak lagi menunggu APP_DEBUG. Di produksi
        # APP_DEBUG mati, jadi selama ini satu-satunya orang yang berwenang membetulkannya
        # justru satu-satunya orang yang tidak diberi tahu apa yang rusak — dan galatnya sudah
        # ada di `error_log.jsonl` yang admin sama saja boleh baca. Kasus nyata 2026-09-16:
        # "No module named 'reportlab'" terbaca sebagai "Gagal membuat output summary manual."
        # Pengguna lain tetap hanya menerima kalimat umum.
        if is_admin_user(user):
            payload["detail"] = str(e)
        return payload

@router.get("/summary/manual/download/{file_id}/{kind}")
@router.get("/summary/manual/download/{file_id}/{kind}/{dummy:path}")
def summary_manual_download(request: Request, file_id: str, kind: str, dummy: str = None):
    from routers.summary_library import require_user
    user = require_user(request)
    if not owned(MANUAL_OUTPUTS.get(file_id), user):
        return JSONResponse({"ok": False, "error": "File tidak ditemukan"}, status_code=404)
    if kind not in ["form","dataset"]:
        return JSONResponse({"ok": False, "error": "Kind harus form/dataset"}, status_code=400)
    path = MANUAL_OUTPUTS[file_id].get(kind)
    if not path or not os.path.exists(path):
        return JSONResponse({"ok": False, "error": "File tidak ditemukan di server"}, status_code=404)
        
    filename = os.path.basename(path)
    
    content_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if kind == "form" and filename.endswith(".pdf"):
        content_type = "application/pdf"
        
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Access-Control-Expose-Headers": "Content-Disposition",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Type": content_type
    }
    return FileResponse(path, filename=filename, headers=headers)

@router.post("/summary/manual/parse_pdf_regex")
async def summary_manual_parse_pdf_regex(request: Request):
    return JSONResponse(status_code=410, content={"ok": False, "error": "Parser regex lama dinonaktifkan karena membuat nilai contoh. Gunakan OCR Mistral atau input manual."})


@router.post("/summary/manual/parse_pdf_ai")
async def summary_manual_parse_pdf_ai(request: Request, token: str = Form(...), pdf: UploadFile = File(...), principle_name: str = Form(default="")):
    from routers.summary_library import require_user
    user = require_user(request, True)
    master = MANUAL_MASTER_CACHE.get(token)
    if not owned(master, user):
        return JSONResponse(status_code=404, content={"ok": False, "error": "Master tidak tersedia. Muat master kembali."})
    try:
        raw = await read_upload_file_limited(pdf, max_bytes=MAX_PDF_UPLOAD_BYTES, allowed_exts=(".pdf",), label="PDF Program")
        result = (kino_extraction(raw, master) or deterministic_extraction(raw, master)
                  or await extract_mistral(raw, master, user, principle_name))
        # Yang jawabannya sudah pasti tidak perlu ditanyakan kepada peninjau: principal yang
        # sudah dipilih di layar, badan surat yang terbawa ke nama program, dan aturan
        # "tidak menyebut varian/gramasi tertentu berarti SEMUA". Lihat `baca_surat_rapi`.
        from baca_surat_rapi import rapikan_baris, judul_summary
        import surat_struktur

        # DUA JALUR, DAN KEDUANYA HARUS DIPILIH DI SINI.
        #
        # `rapikan_baris` dibuat untuk Kino: kelompok yang bukan nama master persis DIKOSONGKAN,
        # supaya peninjau memilih dari daftar bersih. Itu benar selama kata surat memang sedekat
        # itu dengan master kita. Untuk Priskila ia mengosongkan 124 dari 124 baris — surat itu
        # berbunyi "Bellagio Eau de Toilette 100ml" sedangkan master menulis "BLAGIO HM - EDT",
        # dan yang menjembatani keduanya adalah MATCHER, bukan orang.
        #
        # Jadi principal yang punya matcher deterministik tidak lewat `rapikan_baris` sama
        # sekali: barisnya langsung diserahkan ke `_apply_native_kelompok`, yang memilih matcher
        # dari penanda barisnya. Kino dan principal lain tetap di jalur lama, tidak berubah.
        jalur_det = surat_struktur.jalur(principle_name)
        if jalur_det:
            if jalur_det in ("FONTERRA", "NATUR", "ADNA", "FORISA"):
                # Penanda distempel DI SINI, bukan oleh model: baris satu principal tidak boleh
                # bisa nyasar ke matcher principal lain hanya karena modelnya salah menulis.
                for baris_gen in result["rows"]:
                    baris_gen["_gen_key"] = jalur_det
            result["rows"] = _apply_native_kelompok(result["rows"], (master or {}).get("items") or [])
        else:
            result["rows"] = rapikan_baris(result["rows"], (master or {}).get("items") or [], principle_name)

        # SATU SUMMARY YANG MENUMPUK, per principal + per bulan (keputusan pengguna 2026-09-16).
        #
        # Surat kedua menyusul ke grid yang sama, bukan membuat draft baru. Alasannya bukan
        # kerapian berkas: Form Summary itu SATU lembar yang ditandatangani OM, dan satu lembar
        # per surat berarti tumpukan tanda tangan yang tidak ada yang bisa mengikutinya. Yang
        # ditandatangani harus satu acuan.
        #
        # Yang sudah `published` tidak pernah disusul — publikasi itu beku, dan aturan faktur
        # yang sudah terbit tidak boleh berubah di belakang punggung yang menandatanganinya.
        # Surat yang datang setelah publikasi memulai Summary berikutnya.
        from summary_store import append_rows, find_open_draft
        judul = judul_summary(principle_name, result["rows"])
        berjalan = find_open_draft(user, judul)
        if berjalan is not None:
            sebelum = len(berjalan["content"].get("rows") or [])
            draft = append_rows(berjalan["id"], user, result["rows"], master)
            if draft is not None:
                # `rows` TETAP berarti "yang dihasilkan ekstraksi INI", bukan seluruh isi draft.
                #
                # Layar menambahkan hasil ekstraksi ke grid yang sudah ada
                # (`setRows(prev => [...prev, ...parsedRows])`). Sempat dikembalikan seluruh isi
                # draft di sini, dan akibatnya baris yang sudah ada di layar terhitung dua kali:
                # 1 baris lama + 6 baris "baru" = 7, dengan surat pertama muncul dua kali.
                #
                # Mengubah arti sebuah field tanpa mengubah yang membacanya selalu berakhir
                # begini. Yang dikembalikan adalah baris yang BENAR-BENAR bertambah — bukan yang
                # dikirim, karena yang kembar tidak jadi ditambahkan.
                bertambah = (draft["content"].get("rows") or [])[sebelum:]
                return {"ok": True, "rows": bertambah, "draft": draft, "disusulkan": True}
        draft = create_draft(user, judul, {"rows": result["rows"], "programs": [], "master": master, "extraction": {key: value for key, value in result.items() if key != "rows"}}, raw)
        return {"ok": True, "rows": result["rows"], "draft": draft}
    except ValueError as error:
        return JSONResponse(status_code=422, content={"ok": False, "error": str(error)})
    except Exception:
        return JSONResponse(status_code=500, content={"ok": False, "error": "Pemrosesan Summary gagal. Draft parsial tidak diterbitkan."})

@router.post("/summary/manual/report_correction")
async def summary_manual_report_correction(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        body = await request.json()
        before = body.get("before") if isinstance(body.get("before"), dict) else {}
        after = body.get("after") if isinstance(body.get("after"), dict) else {}
        if not before and not after:
            return {"ok": False, "error": "Data before/after kosong."}
        from datetime import datetime
        entry = {
            "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "user": user,
            "principle_name": s(body.get("principle_name", "")),
            "before": {k: v for k, v in before.items() if k not in _CORRECTION_IGNORE_KEYS},
            "after": {k: v for k, v in after.items() if k not in _CORRECTION_IGNORE_KEYS},
            "note": s(body.get("note", "")),
        }
        _ensure_dir(os.path.join(BASE_DIR, "data"))
        with open(CORRECTIONS_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return {"ok": True}
    except Exception as e:
        append_error_log("summary_manual_report_correction", e, {"user": user})
        return {"ok": False, "error": "Gagal menyimpan koreksi."}

@router.post("/summary/manual/email")
async def summary_manual_email(
    request: Request,
    background_tasks: BackgroundTasks,
    email: str = Form(...),
    file_id: str = Form(...)
):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    
    if not user_has_permission(user, "summary", "edit") or not owned(MANUAL_OUTPUTS.get(file_id), user):
        return JSONResponse(status_code=404, content={"ok": False, "error": "Generated files not found."})

    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})

    from shared import EMAIL_USER, EMAIL_PASSWORD, send_email_background
    if not EMAIL_USER or not EMAIL_PASSWORD:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Fitur email belum dikonfigurasi di server (EMAIL_USER / EMAIL_PASSWORD kosong)."})

    email = email.strip()
    if not email or "@" not in email:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Format email tidak valid."})
        
    try:
        background_tasks.add_task(send_email_background, user, email, file_id)
        return JSONResponse({"ok": True})
    except Exception as e:
         return JSONResponse(status_code=500, content={"ok": False, "error": "Gagal memulai tugas pengiriman email."})
