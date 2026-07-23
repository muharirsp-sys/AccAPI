# Tujuan: Endpoint dan business flow Summary Program (/summary/* dan download).
# Caller: FastAPI router dari main.py dan runner E2E Summary Program.
# Dependensi: shared pipeline, cache OCR/parse, Sumopod parser, adapter RapidOCR/Mistral,
#             serta promo_grouping untuk identitas/deduplikasi/group ID stabil.
# Main Functions: summary_manual_parse_pdf_ai, summary_manual_generate, endpoint download.
# Side Effects: baca upload/master, panggilan API OCR/LLM, cache, serta output PDF/XLSX.
import channel_map
from generic_promo_pipeline import canonical_master_gram
from promo_grouping import (
    allows_legacy_master_fallback,
    assign_stable_group_ids,
    bridge_group_triggers,
    canonical_promo_text,
    consolidation_identity,
    deduplicate_promo_rows,
    program_identity,
    propagate_table_benefits,
    stable_sort_promo_rows,
)
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
    save_correction,
    user_has_permission,
    uuid,
    validate_csrf_request,
    verify_and_correct_rows,
    write_summary_excel,
)

router = APIRouter()


def _is_priskila(principle_name) -> bool:
    """True when the principle is Priskila (case-insensitive substring).
    Priskila routes to the deterministic matcher: a structure-only LLM prompt
    (below) + the ``priskila_pipeline`` matcher branch inside
    ``_apply_native_kelompok``. Every other principle keeps the legacy path."""
    return "PRISKILA" in str(principle_name or "").upper()


def _is_urc(principle_name) -> bool:
    """True when the principle is URC (case-insensitive substring). URC
    routes to its own deterministic matcher: a structure-only LLM prompt
    (below) + the ``urc_pipeline`` matcher branch inside
    ``_apply_native_kelompok``. Checked separately from Priskila -- URC rows
    carry a different marker field (``item_description``) so the two never
    cross-route."""
    return "URC" in str(principle_name or "").upper()


def _generic_det_key(principle_name):
    """Kunci RULES generic_promo_pipeline utk principle ber-matcher deterministik
    generik (structure-only prompt + apply_generic_matching), atau None -> legacy.
    NATUR mencakup merek AZALEA+HG (vendor GONDOWANGI, keputusan user)."""
    p = str(principle_name or "").upper()
    if "FONTERRA" in p:
        return "FONTERRA"
    if "NATUR" in p or "GONDOWANGI" in p:
        return "NATUR"
    if "ADNA" in p or "GUMINDO" in p:
        return "ADNA"
    if "FORISA" in p:
        return "FORISA"
    return None


# Penanda baris surat yang TIDAK punya item cocok di master -> wajib direview manusia.
# Dipakai BERSAMA oleh PDF (kolom Kelompok) & Excel (kolom NAMA_BARANG) supaya keduanya
# tidak pernah drift: dulu PDF nulis flag ini tapi Excel dibiarkan KOSONG polos (silent).
REVIEW_FLAG_TEXT = "(TIDAK ADA ITEM COCOK DI MASTER -- PERLU REVIEW MANUAL)"

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
            # AI first, fallback to template parser if AI fails
            try:
                rows = ai_extract_summary_rows(text, list_mode, s(template).upper(), model=model)
            except Exception as ai_err:
                rows = build_summary_rows(text, list_mode, s(template).upper())
                if not rows:
                    raise ai_err

        if not rows:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Template belum dikenali / hasil kosong."})

        file_id = str(uuid.uuid4())[:8]
        base_dir = os.path.dirname(os.path.abspath(__file__))
        out_dir = os.path.join(base_dir, "output")
        out_path = os.path.join(out_dir, f"summary_{file_id}.xlsx")
        write_summary_excel(rows, out_path)

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
    # Auth check removed to support direct downloads from Next.js cross-origin links
    # The UUID acts as the access token.
    base_dir = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(base_dir, "output", f"summary_{file_id}.xlsx")
    return accel_or_file_response(out_path, "summary.xlsx")



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
            "kelompok": kelompok_list,
            "variant_map": variant_map,
            "gramasi_map": gramasi_map,
            "items": items,
            "customers": customers
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
        if token not in MANUAL_MASTER_CACHE:
            return {"ok": False, "error": "Token master tidak ditemukan / expired"}

        cache = MANUAL_MASTER_CACHE[token]
        vlist = cache["variant_map"].get(group, [])
        glist = cache["gramasi_map"].get(group, [])

        variants = [{"value": "ALL VARIANT", "text": "ALL VARIANT", "disabled": False}] +                    [{"value": v, "text": v, "disabled": False} for v in vlist]
        gramasies = [{"value": "ALL GRAMASI", "text": "ALL GRAMASI", "disabled": False}] +                     [{"value": g, "text": g, "disabled": False} for g in glist]

        return {"ok": True, "variants": variants, "gramasis": gramasies}
    except Exception as e:
        append_error_log("summary_manual_master_options", e, {"user": user, "group": group, "token": token})
        payload = {"ok": False, "error": "Gagal memuat opsi master."}
        if APP_DEBUG and is_admin_user(user):
            payload["detail"] = str(e)
        return payload

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
        if token not in MANUAL_MASTER_CACHE:
            return {"ok": False, "error": "Token master tidak ditemukan / expired"}
        rows = json.loads(rows_json)
        # FASE 5: identitas input DIUKUR DI SINI (rows msh murni, sblm diproses/dimutasi
        # di bawah -- _matched_items_cache dll ditempel belakangan). Order-sensitive: run
        # dokumen yg sama menghasilkan urutan baris yg sama (ekstraksi kini deterministik).
        _golden_input_key = canonical_signature(rows)

        try:
            with open("d:/disc_web/debug_payload.json", "w") as f:
                json.dump(rows, f, indent=4)
        except: pass
        
        cache = MANUAL_MASTER_CACHE[token]
        items = cache.get("items", [])

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
        rows = propagate_table_benefits(rows)
        consolidated_rows_dict = {}
        idx_counter = 1
        
        for r in rows:
            # Safely extract prefix (e.g., 'BLAGIO HM' from 'BLAGIO HM - EDT')
            raw_k = str(r.get("kelompok", "")).strip()
            prefix = raw_k.split(" - ")[0] if " - " in raw_k else raw_k
            
            # Generic pipeline sudah membawa hasil match deterministik. Jangan
            # mega-merge hanya dari prefix (semua "NATUR - ..." akan menjadi
            # satu baris bila model kebetulan konsisten menulis spasi benefit).
            _generic_name = str(r.get("_gen_key") or r.get("principle") or "").upper()
            generic_scope = consolidation_identity(r) if any(name in _generic_name for name in ("NATUR", "FONTERRA")) else prefix
            merge_key = (
                r.get("surat_program", ""),
                r.get("nama_program", ""),
                r.get("channel_gtmt", ""),
                r.get("periode", ""),
                generic_scope,
                norm(r.get("ketentuan", "")),
                canonical_promo_text(r.get("benefit", "")),
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

        headers_str = ["No", "Surat Program", "Nama Program", "Channel", "Periode", 
                   "Kelompok Barang", "Variant", "Gramasi", "Ketentuan", "Benefit", "Syarat Claim", "Keterangan"]
        
        header_style = styles["Normal"].clone("HeaderStyle")
        header_style.fontSize = 7
        header_style.leading = 8
        header_style.fontName = 'Helvetica-Bold'
        header_style.alignment = TA_CENTER
        header_style.textColor = colors.whitesmoke
        
        table_data = [[Paragraph(h, header_style) for h in headers_str]]
        # Nilai TEKS mentah paralel dgn table_data (dipakai utk deteksi span di
        # bawah -- Paragraph bukan string, jadi kesamaan konten harus dicek dari
        # sini, bukan dari objek Paragraph-nya).
        row_texts: List[List[str]] = []

        cell_style = styles["Normal"].clone("CellStyle")
        cell_style.fontSize = 6
        cell_style.leading = 7
        cell_style.alignment = TA_CENTER

        def benefit_display(r) -> str:
            # ponytail: cut price (DISC_RP) tampilkan per-satuan (default PCS) -> "4700/PCS".
            # BONUS_QTY sudah "1 PCS", DISC_PCT sudah "5%" -> biarkan apa adanya.
            b = str(r.get("benefit", "") or "").strip()
            bt = norm(r.get("benefit_type", ""))
            if bt == "DISC_RP" and has_number(b) and "/" not in b:
                unit = unit_from_text(str(r.get("ketentuan", "")) + " " + b)
                return f"{b}/{unit}"
            return b

        # ============================================================
        # SINGLE SOURCE OF TRUTH: cocokkan tiap baris surat ke item per-SKU SEKALI di sini.
        # PDF (loop di bawah) & Excel (setelah PDF, lihat blok Excel) SAMA-SAMA dibangun dari
        # hasil ini -- tidak ada lagi 2 pipeline independen yang bisa saling berbeda (akar
        # divergensi PDF vs Excel yg dilaporkan user).
        # ============================================================
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
            periode = str(r.get("periode","") or "").strip()
            program_key = program_identity(r)
            if not promo_group_id or promo_group_id.upper() == "NON_GROUP":
                promo_group_id = promo_group
            auto_group_id = not promo_group_id or promo_group_id.upper() == "NON_GROUP" or promo_group_id == promo_group

            pdf_meta[i] = {
                "no": i + 1, "surat_program": r.get("surat_program",""), "nama_program": promo_label,
                "channel_gtmt": promo_group, "periode": periode, "ketentuan": ket,
                "program_key": program_key,
                "master_gramasi_authoritative": not allows_legacy_master_fallback(r),
                "benefit_type": r.get("benefit_type",""), "benefit": r.get("benefit",""),
                "syarat_claim": r.get("syarat_claim",""), "keterangan": r.get("keterangan",""),
                "variant_display": r.get("variant",""), "kelompok_fallback": r.get("kelompok",""),
                # Priskila: label variant dari pipeline bersifat FINAL (posisional
                # per kelompok, mis. "Sport & All Variant") -- jangan ditimpa.
                # kel_variant = peta kelompok->label utk disusun ulang sesuai
                # urutan tampilan kelompok renderer (kel_order).
                "variant_locked": bool(r.get("_priskila_variant_label")),
                "kel_variant": r.get("_priskila_kel_variant") or {},
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
                if not g_all and glist and allows_legacy_master_fallback(r):
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

            if not matched_items and allows_legacy_master_fallback(r):
                fb_kelompok = kelompok
                if fb_kelompok and any(skip in fb_kelompok.lower() for skip in ["- kelompok -", "bisa meleset"]):
                    fb_kelompok = ""
                pool = [it for it in items if norm(it.get("kelompok")) == norm(fb_kelompok)] if fb_kelompok else items
                if not pool: pool = items
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

            trig_has_num = has_number(ket)
            trig_qty = parse_number_id(ket) if trig_has_num else ""
            trig_unit = unit_from_text(ket) if trig_has_num else ""
            benefit_text = str(r.get("benefit","") or "").strip()
            benefit_type = str(r.get("benefit_type","") or "").strip()
            benefit_unit = unit_from_text(benefit_text) if benefit_text else ""

            if not matched_items:
                # kode_barang tetap KOSONG (dipakai guard V4 & PROMO_ACTIVE utk kenali "bukan SKU
                # nyata"), tapi nama_barang diberi flag review -- simetris dgn PDF, tak lagi blank.
                excel_rows.append({"pdf_key": i, "channel": promo_group, "kode_barang": "", "nama_barang": REVIEW_FLAG_TEXT,
                                    "promo_label": promo_label, "pg_id": promo_group_id, "periode": periode,
                                    "program_key": program_key, "master_kel": "", "auto_group_id": auto_group_id,
                                    "trig_qty": trig_qty, "trig_unit": trig_unit, "benefit_type": benefit_type,
                                    "benefit_text": benefit_text, "benefit_unit": benefit_unit})
                continue

            pdf_items[i].extend(matched_items)

            from collections import defaultdict
            grouped_by_master_kel = defaultdict(list)
            for it in matched_items:
                grouped_by_master_kel[str(it.get("kelompok","")).strip()].append(it)

            for master_kel, items_in_kel in grouped_by_master_kel.items():
                for it in items_in_kel:
                    excel_rows.append({"pdf_key": i, "channel": promo_group, "kode_barang": str(it.get("kode_barang","")),
                                        "nama_barang": str(it.get("nama_barang","")), "promo_label": promo_label,
                                        "pg_id": promo_group_id, "periode": periode, "program_key": program_key,
                                        "master_kel": master_kel, "auto_group_id": auto_group_id, "trig_qty": trig_qty,
                                        "trig_unit": trig_unit, "benefit_type": benefit_type, "benefit_text": benefit_text,
                                        "benefit_unit": benefit_unit})

        # Model berbeda boleh memecah rowspan tabel menjadi jumlah baris berbeda.
        # Deduplikasi wajib scoped per identitas program; SKU program Oktober dan
        # Februari tidak boleh lagi dianggap konflik hanya karena channel sama.
        excel_rows = bridge_group_triggers(excel_rows)
        excel_rows, _dedup_count = deduplicate_promo_rows(excel_rows)
        excel_rows = assign_stable_group_ids(excel_rows)
        if _dedup_count:
            # Sinkronkan pdf_items ke excel_rows FINAL: item hanya tampil di PDF kalau kode-nya
            # masih hidup di excel_rows utk pdf_key itu (buang duplikat rowspan OCR).
            surviving: Dict[int, set] = {}
            for er in excel_rows:
                if er["kode_barang"]:
                    surviving.setdefault(er["pdf_key"], set()).add(er["kode_barang"])
            for i in pdf_items:
                pdf_items[i] = [it for it in pdf_items[i]
                                if str(it.get("kode_barang", "")).strip() in surviving.get(i, set())]

        for i in range(len(rows)):
            meta = pdf_meta[i]
            items_in_row = pdf_items.get(i, [])

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
                kelompok_display = REVIEW_FLAG_TEXT
            else:
                kelompok_display = ""

            if meta.get("variant_locked") and kel_order:
                # Priskila: susun label per kelompok MENGIKUTI urutan tampilan
                # kel_order (urutan master), bukan urutan surat -- kolom Variant
                # harus sejajar posisional dgn kolom Kelompok & Gramasi.
                _kv = meta.get("kel_variant") or {}
                variant_display = " & ".join(_kv.get(k, "All Variant") for k in kel_order)
            elif not items_in_row or meta.get("variant_locked") or norm(meta.get("variant_display","")).replace(" ","") == "ALLVARIANT":
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
                        g = (canonical_master_gram(it) if meta.get("master_gramasi_authoritative")
                             else str(it.get("gramasi", "")).strip())
                        if g and g not in seen_g:
                            seen_g.add(g); gram_for_k.append(g)
                if gram_for_k:
                    gramasi_parts.append(",".join(gram_for_k))
            gramasi_display = join_human(gramasi_parts)

            _row_vals = [
                str(meta["no"]), str(meta.get("surat_program","")), str(meta.get("nama_program","")),
                str(meta.get("channel_gtmt","")), str(meta.get("periode","")), kelompok_display,
                variant_display, gramasi_display, str(meta.get("ketentuan","")), benefit_display(meta),
                str(meta.get("syarat_claim","")), str(meta.get("keterangan","")),
            ]
            row_texts.append(_row_vals)
            table_data.append([Paragraph(v, cell_style) for v in _row_vals])

        # Total A4 landscape width is ~842. Margins are 0.5cm each (approx 14 points each, total 28 pts margin)
        # Usable width = 842 - 28 = 814 points
        usable = landscape(A4)[0] - (1 * cm)
        cw = [
            usable * 0.03, # No
            usable * 0.12, # Surat Program
            usable * 0.12, # Nama Program
            usable * 0.05, # Channel
            usable * 0.08, # Periode
            usable * 0.09, # Kelompok
            usable * 0.14, # Variant
            usable * 0.08, # Gramasi
            usable * 0.08, # Ketentuan
            usable * 0.08, # Benefit
            usable * 0.07, # Syarat Claim
            usable * 0.06  # Keterangan
        ]
            
        # Rowspan (SPAN) baris yang isinya SAMA PERSIS di kolom yang memang
        # berlaku utk seluruh surat (Surat Program/Nama Program/Channel/
        # Periode/Ketentuan/Benefit/Syarat Claim/Keterangan) -- mis. satu surat
        # URC = satu benefit utk semua kelompok, jadi kolom itu tak perlu
        # diulang tiap baris. Kolom No/Kelompok/Variant/Gramasi SENGAJA
        # dikecualikan (permintaan user 2026-07-15/17): tiap kelompok barang
        # harus tetap tampil sbg baris tersendiri utk audit trail, walau
        # kebetulan isinya sama dgn kelompok lain.
        SPANNABLE_COLS = {1, 2, 3, 4, 8, 9, 10, 11}
        # SPAN yang membentang tanpa putus membuat tabel TIDAK BISA dipotong
        # antar-halaman (ReportLab menolak split di tengah span -> error
        # "flowable too large" begitu surat punya banyak baris, mis. 25 baris
        # NATUR). Potong setiap run pada grid global tiap SPAN_SPLIT_EVERY
        # baris: batas segmen jatuh di baris yang sama utk SEMUA kolom,
        # sehingga selalu ada titik potong halaman yang bebas span.
        def _span_cmds(split_every):
            cmds = []
            for col in SPANNABLE_COLS:
                r = 1  # table_data row 0 = header; data rows start at 1
                while r < len(table_data):
                    val = row_texts[r - 1][col]
                    r2 = r
                    while r2 + 1 < len(table_data) and row_texts[r2][col] == val:
                        r2 += 1
                    if val and r2 > r and split_every:
                        s = r
                        while s <= r2:
                            e = min(r2, ((s - 1) // split_every + 1) * split_every)
                            if e > s:
                                cmds.append(('SPAN', (col, s), (col, e)))
                            s = e + 1
                    r = r2 + 1
            return cmds

        footer_style_left = styles["Normal"].clone("FooterLeft")
        footer_style_left.fontSize = 8
        footer_style_left.fontName = 'Helvetica-Bold'
        
        footer_style_right = styles["Normal"].clone("FooterRight")
        footer_style_right.fontSize = 8
        footer_style_right.fontName = 'Helvetica-Bold'
        footer_style_right.alignment = TA_RIGHT

        # ponytail: blok span berisi baris tinggi bisa melebihi tinggi frame ->
        # ReportLab LayoutError "flowable too large" (terbukti live NATUR 4 surat,
        # baris UNMATCHED/benefit panjang). Retry dgn span makin pendek; percobaan
        # terakhir TANPA span (selalu bisa split per baris) -- konten identik,
        # hanya visual-merge yang dikorbankan.
        from reportlab.platypus.doctemplate import LayoutError
        _base_elements = list(elements)
        for _split_every in (12, 6, 3, 0):
            elements = list(_base_elements)
            t = Table(table_data, repeatRows=1, colWidths=cw)
            t.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#9E7C85')), # Match the brownish pink header color
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.black),
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 6),
                ('TOPPADDING', (0, 0), (-1, 0), 6),
                ('BACKGROUND', (0, 1), (-1, -1), colors.white),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.black),
                ('WORDWRAP', (0, 0), (-1, -1), True),
            ] + _span_cmds(_split_every)))
            elements.append(t)

            # Add the Footer Signatures
            elements.append(Spacer(1, 25))
            sig_data = [
                [Paragraph(f"Makassar , {dibuat_date}", footer_style_left), ""],
                [Paragraph("Diajukan Oleh,", footer_style_left), Paragraph("Disetujui Oleh,", footer_style_right)],
                [Spacer(1, 40), Spacer(1, 40)], # Space for signature
                [Paragraph("SM<br/>(.................................................)", footer_style_left),
                 Paragraph("OPERATIONAL MANAGER<br/>(.................................................)", footer_style_right)]
            ]
            # Table takes up full usable width so left is left, right is right
            sig_table = Table(sig_data, colWidths=[usable/2.0, usable/2.0])
            sig_table.setStyle(TableStyle([
                ('ALIGN', (0, 0), (0, -1), 'LEFT'),
                ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ]))
            elements.append(sig_table)

            try:
                doc.build(elements, onFirstPage=my_canvas, onLaterPages=my_canvas)
                break
            except LayoutError:
                if _split_every == 0:
                    raise
                append_error_log("summary_pdf_span_retry",
                                 Exception(f"LayoutError, retry span<={_split_every//2 or 'tanpa span'}"),
                                 {"rows": len(table_data) - 1})
                # doc yang gagal build tidak bisa dipakai ulang -> buat baru
                doc = SimpleDocTemplate(form_path, pagesize=landscape(A4), rightMargin=0.5*cm,
                                        leftMargin=0.5*cm, topMargin=2.2*cm, bottomMargin=0.5*cm)

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
        excel_rows = stable_sort_promo_rows(excel_rows)

        # excel_rows sudah dihitung SEKALI di atas (dipakai jg utk PDF) -- di sini cuma tulis ke sheet.
        excel_tier_counter: Dict[Tuple[str, str, str, str], int] = {}
        for er in excel_rows:
            tkey = (er["promo_label"], er["pg_id"], er["channel"], er["kode_barang"])
            excel_tier_counter[tkey] = excel_tier_counter.get(tkey, 0) + 1
            ws2.append([
                er["kode_barang"], er["nama_barang"], er["promo_label"], er["pg_id"], er["channel"],
                # PROMO_ACTIVE=False utk baris review-flag (kode kosong) -- jangan sampai
                # ke-import ERP sbg promo aktif padahal belum ada SKU-nya (silent bad data).
                er["periode"], bool(er["kode_barang"]), excel_tier_counter[tkey], er["trig_qty"], er["trig_unit"],
                er["benefit_type"], er["benefit_text"], er["benefit_unit"], "PABRIK",
            ])
        wb2.save(dataset_path)
        # FASE 6: paku timestamp entry-zip + core.xml modified -> xlsx byte-identik antar-run
        finalize_xlsx(dataset_path)

        if flagged_mismatches or flagged_conflicts:
            append_error_log("summary_manual_generate_flags", Exception("data quality flags"), {
                "mismatches": flagged_mismatches, "conflicts": flagged_conflicts, "user": user,
            })

        MANUAL_OUTPUTS[file_id] = {"form": form_path, "dataset": dataset_path}

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
        if APP_DEBUG and is_admin_user(user):
            payload["detail"] = str(e)
        return payload

@router.get("/summary/manual/download/{file_id}/{kind}")
@router.get("/summary/manual/download/{file_id}/{kind}/{dummy:path}")
def summary_manual_download(request: Request, file_id: str, kind: str, dummy: str = None):
    # Auth check removed to support direct downloads from Next.js cross-origin links
    # The UUID acts as the access token.
    if file_id not in MANUAL_OUTPUTS:
        return JSONResponse({"ok": False, "error": "File ID tidak ditemukan"}, status_code=404)
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
        "Content-Type": content_type
    }
    return FileResponse(path, filename=filename, headers=headers)

@router.post("/summary/manual/parse_pdf_regex")
async def summary_manual_parse_pdf_regex(request: Request, token: str = Form(...), pdf: UploadFile = File(...)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token): return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    
    try:
        if token not in MANUAL_MASTER_CACHE: return {"ok": False, "error": "Token master tidak ditemukan / expired"}
        file_bytes = await read_upload_file_limited(pdf, max_bytes=MAX_PDF_UPLOAD_BYTES, allowed_exts=(".pdf",))
        
        import fitz
        import re
        import uuid
        
        pdf_text = ""
        with fitz.open(stream=file_bytes, filetype="pdf") as doc:
            for page in doc: pdf_text += page.get_text() + "\n"

        # ponytail: PDF scan (image-only) -> get_text() kosong -> regex mustahil. Jangan balas 0 baris diam-diam.
        if not pdf_text.strip():
            return {"ok": False, "error": "PDF ini hasil scan (tanpa teks). Regex tidak bisa membaca gambar — gunakan tombol 'Ekstrak Cerdas' (AI/OCR)."}

        rows = []
        # Basic Regex implementation (Fragile, structure-dependent)
        # Looks for lines starting with "PROID-..." and captures nearby context naively
        matches = re.finditer(r"(PROID-[A-Z0-9/\-]+)", pdf_text)
        idx = 1
        for match in matches:
            surat_program = match.group(1)
            rows.append({
                "id": str(uuid.uuid4()),
                "no": str(idx),
                "principle": "Auto (Regex)",
                "surat_program": surat_program,
                "nama_program": "Hasil RegEx Terbatas",
                "channel_gtmt": "MT",
                "kelompok": "Bisa Meleset",
                "variant": "...",
                "gramasi": "...",
                "ketentuan": "Beli XX",
                "benefit_type": "DISC_PCT",
                "benefit": "5%",
                "syarat_claim": "Faktur",
                "keterangan": "Automated OCR/Regex"
            })
            idx += 1
            
        rows = _apply_native_kelompok(rows, MANUAL_MASTER_CACHE[token].get("items", []))
        return {"ok": True, "rows": rows}
    except Exception as e:
        import traceback; traceback.print_exc()
        return {"ok": False, "error": f"Regex Parser Error: {str(e)}"}


def _channel_gate(rows, principle_name):
    """Bakukan channel per principle (fail-closed). Return dict-error kalau ada channel di
    luar mapping principle -> caller HARUS berhenti & minta user lengkapi mapping (keputusan
    user 2026-07-21). Return None kalau aman (rows dibakukan in-place) ATAU principle belum
    punya file mapping (fitur off utk principle itu -> perilaku lama)."""
    cmap = channel_map.load(principle_name)
    if cmap is None:
        return None
    unknown = channel_map.canonicalize_rows(rows, cmap)
    if unknown:
        _u = ", ".join(sorted(unknown))
        return {"ok": False, "need_channel_mapping": True, "principle_name": principle_name,
                "unknown_channels": sorted(unknown),
                "error": (f"Channel berikut belum terdaftar di mapping principle "
                          f"'{principle_name}': {_u}. Tambahkan alias->nama channel baku ke "
                          f"data/channel_map/{channel_map.principle_slug(principle_name)}.json "
                          f"lalu proses ulang. (Proses dihentikan agar channel tak salah baca "
                          f"masuk ke hitungan program per channel.)")}
    return None


@router.post("/summary/manual/parse_pdf_ai")
async def summary_manual_parse_pdf_ai(request: Request, token: str = Form(...), pdf: UploadFile = File(...), n8n_webhook: str = Form(default=""), principle_name: str = Form(default=""), ai_mode: str = Form(default="split")):
    
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    
    try:
        if token not in MANUAL_MASTER_CACHE:
            return {"ok": False, "error": "Token master tidak ditemukan / expired"}
            
        file_bytes = await read_upload_file_limited(pdf, max_bytes=MAX_PDF_UPLOAD_BYTES, allowed_exts=(".pdf",), label="PDF Program")

        # FASE 1b: hasil parse dibekukan per (dokumen, principle). Hit -> lewati OCR+LLM total
        # (0 biaya API) & rows IDENTIK dgn run pertama -> pipeline dok->rows deterministik penuh.
        # Default produksi = Mistral OCR (terbukti setara Gemini di URC & Priskila:
        # SKU set + SKU->benefit identik). Set SUMOPOD_OCR_MODEL=gemini/gemini-3.5-flash
        # untuk kembali ke Gemini. Provider OCR eksplisit memakai satu sumber teks di
        # namespace cache terpisah, jadi ganti default tidak mencampur cache lama.
        ocr_model = os.getenv("SUMOPOD_OCR_MODEL", "mistral-ocr-4-0")
        _use_rapid = ocr_model == "rapidocr"
        _use_mistral = ocr_model.startswith("mistral-ocr-")
        _explicit_ocr = _use_rapid or _use_mistral
        _parse_namespace = f"{ocr_model}:single-source-v1" if _explicit_ocr else ""
        _parse_key = parse_cache_key(file_bytes, principle_name, namespace=_parse_namespace)
        _cached_rows = parse_cache_get(_parse_key)
        if _cached_rows is not None:
            _gate = _channel_gate(_cached_rows, principle_name)
            if _gate: return _gate
            return {"ok": True, "rows": _cached_rows}

        # Direct Python native parsing via OpenAI SDK (Sumopod)
        api_key = os.getenv("SUMOPOD_API_KEY") or os.getenv("OPENAI_API_KEY")
        if not api_key:
             return {"ok": False, "error": "API Key belum dikonfigurasi. Pastikan SUMOPOD_API_KEY atau OPENAI_API_KEY ada di file .env."}
             
        import fitz
        from openai import AsyncOpenAI
        import json
        import uuid
        import re
        
        # Fetch Official DB Product Names to ground the AI's deductions
        cache = MANUAL_MASTER_CACHE[token]
        raw_items = cache.get("items", [])
        
        # SANGAT PENTING: Filter context supaya API Proxy tidak memuntah/terpotong (Tokens Limit)
        # Hanya gunakan barang yang sesuai dengan Principle yang sedang diproses!
        # Generic deterministik (FONTERRA/NATUR): JANGAN filter master by keyword principal.
        # Kasus nyata: "NATUR (GONDOWANGI)" -> keyword NATUR menyaring item AZALEA/HG keluar
        # dari master -> semua baris AZALEA/HG salah jadi UNMATCHED (bug kelas sama dgn
        # "AZALEA/HG hilang" di jalur legacy). Filter ini cuma perlu utk prompt legacy yg
        # menyisipkan daftar barang ke LLM; prompt structure-only tidak.
        if principle_name and principle_name.strip() and not _generic_det_key(principle_name):
            # ponytail: dulu dicocokkan ke kolom 'principle' (nama produk) -> "Priskila" tak pernah match -> 0.
            # Cocokkan tiap keyword principal (>=4 huruf) ke principle ATAU nama_barang; kosong -> pakai semua
            # (master per-principal itu normal; kolom 'Nama Pcpl' memang blank).
            _kw = [w for w in re.sub(r"\(.*?\)", "", principle_name).upper().split() if len(w) >= 4]
            def _match_principal(it):
                blob = (str(it.get("principle", "")) + " " + str(it.get("nama_barang", ""))).upper()
                return any(w in blob for w in _kw)
            items = [it for it in raw_items if _match_principal(it)] if _kw else raw_items
            if not items:
                items = raw_items # Fallback: master ini memang katalog 1 principal
        else:
            items = raw_items
        
        # Bikin mapping text yang panjang tapi detail
        item_names_cache = set()
        kode_barang_map = {}
        for item in items:
            name = str(item.get("nama_barang", "")).strip().upper()
            code = str(item.get("kode_barang", "")).strip()
            
            if name: item_names_cache.add(name)
            
            # Kita map nama ke array kode karena 1 nama bisa banyak gramasi
            if name not in kode_barang_map: kode_barang_map[name] = []
            
            if code and code not in kode_barang_map[name]: kode_barang_map[name].append(code)
            
        master_names_context = ""
        for n, kodes in kode_barang_map.items():
            s_kodes = ",".join(kodes)
            
            # Cari baris yang bener-bener punya nama barang ini
            for master_item in items:
                nama_barang = str(master_item.get("nama_barang", "")).strip().upper()
                nama_principle = str(master_item.get("principle", "")).strip().upper()
                
                # Dynamic matching for Aroma / Variant
                nama_aroma = ""
                for k, v in master_item.items():
                    if "aroma" in str(k).lower() or "rasa" in str(k).lower() or "variant" in str(k).lower():
                        nama_aroma = str(v).strip()
                        break
                        # Fetch pre-combined Kelompok string from Master cache
                kelompok_asli = str(master_item.get("kelompok", "")).strip()
                
                # Format: REF: [Principle] - [Nama Barang] -> OUTPUT_KELOMPOK: [Kelompok Asli] | OUTPUT_VARIANT: [Variant] | OUTPUT_KODE: [Kode]
                if nama_barang == n:
                    master_names_context += f"REF: {nama_principle} - {nama_barang} -> OUTPUT_KELOMPOK: {kelompok_asli} | OUTPUT_VARIANT: {nama_aroma} | OUTPUT_KODE: {s_kodes}\n"
                    break
        
        # Fetch Master Customers if available
        db_customers = cache.get("customers", [])
        customer_names = sorted([f"{c.get('kode_customer','')} | {c.get('nama_customer','')}" for c in db_customers])
        master_customers_context = "\n".join(customer_names) if customer_names else "TIDAK ADA DATA CUSTOMER"
        
        try:
            with open("d:/disc_web/debug_ai_context.txt", "w", encoding="utf-8") as _f:
                _f.write(master_names_context)
        except: pass
        
        try:
            import httpx
            import base64
            # 1. Extract pure text and highly compressed images from PDF
            pdf_text = ""
            base64_images = []
            
            ocr_labels = []
            with fitz.open(stream=file_bytes, filetype="pdf") as doc:
                # ponytail: dulu doc[:10] -> halaman 11+ hilang diam-diam. Proses semua sampai cap longgar.
                MAX_OCR_PAGES = int(os.getenv("SUMMARY_MAX_OCR_PAGES", "40"))
                pages_total = doc.page_count
                for _pg_no, page in enumerate(doc[:MAX_OCR_PAGES]):
                    txt = page.get_text()
                    pdf_text += txt + "\n"
                    # Compress the image so the Base64 string doesn't eat the token budget
                    pix = page.get_pixmap(matrix=fitz.Matrix(1.0, 1.0))
                    img_bytes = pix.tobytes("jpeg", 80)
                    b64 = base64.b64encode(img_bytes).decode("utf-8")
                    base64_images.append(b64)
                    ocr_labels.append(f"HALAMAN {_pg_no + 1}")
                    # Gambar TEMPELAN (mis. tabel Excel di-paste sbg PNG ke surat -- pola URC):
                    # di render halaman 72-DPI di atas, tabel spt itu menciut sampai tak
                    # terbaca dan vision OCR MEMBUANG seluruh tabel diam-diam (terbukti live,
                    # surat URC 004; menaikkan zoom render pun tidak menolong). Ekstrak
                    # gambar tempelannya secara NATIVE (resolusi penuh) sbg input OCR
                    # tambahan. Ambang w>=300 & h>=60: tabel pendek 2-baris (563x88) ikut,
                    # tanda tangan (~120x78/237x109) tersaring; logo kop (762x86) ikut
                    # ter-OCR -- tak berbahaya, cuma jadi sebaris teks brand.
                    _n_emb = 0
                    for _im in page.get_images(full=True):
                        try:
                            _meta = doc.extract_image(_im[0])
                            if _meta["width"] < 300 or _meta["height"] < 60:
                                continue
                            _epix = fitz.Pixmap(doc, _im[0])
                            if _epix.alpha:
                                _epix = fitz.Pixmap(_epix, 0)
                            if _epix.colorspace and _epix.colorspace.n > 3:
                                _epix = fitz.Pixmap(fitz.csRGB, _epix)
                            base64_images.append(base64.b64encode(_epix.tobytes("jpeg", 80)).decode("utf-8"))
                            _n_emb += 1
                            ocr_labels.append(f"HALAMAN {_pg_no + 1} - GAMBAR TEMPELAN {_n_emb}")
                        except Exception as _emb_err:
                            append_error_log("embedded_image_extract_failed", _emb_err,
                                             {"page": _pg_no + 1, "xref": _im[0]})
            pages_truncated = pages_total > MAX_OCR_PAGES
                    
            if not pdf_text.strip() and not base64_images:
                return {"ok": False, "error": "PDF kosong atau tidak memiliki halaman valid."}

            # 2. Call Sumopod proxy directly via HTTP POST
            prompt = f"""
SANGAT PENTING: Dokumen promosi ini berkaitan dengan Brand / Keluarga Produk: {principle_name.upper()}.
Meskipun teks di PDF mungkin buram atau terpotong, JIKA ada kemiripan, Anda WAJIB memprioritaskan penyocokan kode barang dengan nama-nama resmi yang mengandung kata kunci brand ini!

Tugas Anda: EKSTRAK SEMUA TABEL PROMO/DISKON dari dokumen ini ke dalam ARRAY JSON.
KEMBALIKAN HASILNYA SAJA DALAM FORMAT JSON VALID! (JANGAN ada teks pembuka/penutup).

ATURAN REASONING & EKSTRAKSI (WAJIB DIIKUTI 100%):
1. COST RATIO (CR): Kolom 'CR' / 'Cost Ratio' HANYA angka referensi internal (BUKAN benefit/diskon) -- ABAIKAN KOLOM ITU SAJA. JANGAN abaikan kolom LAIN di tabel yang sama hanya karena tabel tersebut JUGA punya kolom CR! Kolom 'CUT PRICE' / 'HET' / 'PAKET' di tabel yang sama TETAP WAJIB diekstrak sebagai benefit (lihat aturan 2 & 3) -- CR cuma 1 kolom yang diabaikan, bukan alasan mengosongkan seluruh baris/tabel.
2. BONUS QTY (Beli X Gratis Y): JIKA mekanismenya memberikan gratis barang (misal: "Beli 2 gratis 1"), isi 'benefit_type' dengan "BONUS_QTY". Nilai 'benefit' adalah jumlah barang gratisnya (1).
   ATURAN FORMAT "X+Y" (SANGAT PENTING - kolom PAKET biasa tertulis "7+1", "4+1", "10+2", "65+7"):
   Angka ini BUKAN penjumlahan! "7+1" artinya BELI 7 GRATIS 1. Maka: 'ketentuan' = "Beli 7" (angka KIRI saja, JANGAN dijumlah jadi "Beli 8"!), 'benefit_type' = "BONUS_QTY", 'benefit' = "1 PCS" (angka KANAN + satuan). Contoh: "10+2" -> ketentuan "Beli 10", benefit "2 PCS". "65+7" -> ketentuan "Beli 65", benefit "7 PCS". DILARANG KERAS menjumlahkan kiri+kanan.
3. POTONGAN HARGA (Cut Price): Isi 'benefit_type' dengan "DISC_RP" dan 'benefit' angkanya SAJA (TANPA huruf "Cut Price" atau "Potongan"). JANGAN SEKALI-KALI MENGGANTI NILAI `ketentuan` (Trigger Beli) DENGAN TEKS POTONGAN HARGA INI! `ketentuan` WAJIB TETAP BERISI "Beli 1", "Beli 2", dll.
4. KETENTUAN TRIGGER QTY: Jika di surat tertulis "Setiap pembelian", "Setiap pengambilan", ATAU "TIDAK ADA ANGKA MINIMAL", WAJIB ubah teks 'ketentuan' menjadi "Beli 1".
4b. TABEL FORMAT "CUT PRICE" TANPA TEKS TRIGGER SAMA SEKALI (channel MTI/Modern Trade biasanya
    begini -- WAJIB tetap diekstrak, JANGAN dikosongkan/dilewati hanya karena tidak ada frasa "Beli X"):
    Kalau tabel HANYA berisi kolom seperti "CUT PRICE | HET | CR" tanpa kolom "PAKET" dan tanpa kalimat
    trigger apa pun, maka SETIAP baris tabel = 1 promo terpisah dengan 'ketentuan'="Beli 1",
    'benefit_type'="DISC_RP", 'benefit'=angka di kolom CUT PRICE SAJA (tanpa titik/koma ribuan diubah
    jadi angka polos). ABAIKAN kolom HET dan CR (bukan benefit). WAJIB ekstrak SEMUA baris/brand
    sampai baris TERAKHIR tabel, walau tabelnya panjang dan tidak ada kalimat pemicu di setiap barisnya.
    CONTOH KONKRET (WAJIB DIIKUTI POLA INI):
      Input tabel: "| BELLAGIO | Bellagio Eau de Toilette 100ml | 4,700 | 31,628 | 13% |"
      Output JSON: {{"kelompok": "Bellagio Eau de Toilette 100ml", "ketentuan": "Beli 1",
                    "benefit_type": "DISC_RP", "benefit": "4700"}}
      Input tabel: "|          | Bellagio Pomade Kidz 40gr        | 1,400 | 12,600 | 10% |"
      Output JSON: {{"kelompok": "Bellagio Pomade Kidz 40gr", "ketentuan": "Beli 1",
                    "benefit_type": "DISC_RP", "benefit": "1400"}}
      (Catatan: "Pomade Kidz" BEDA dari "Pomade" biasa -- keduanya bisa SAMA-SAMA ada di channel yang
      sama dengan harga cut price berbeda, JANGAN dianggap duplikat/salah satu dibuang.)
5. CHANNEL PROMO: Isi 'channel_gtmt' dengan NAMA ASLI channel sesuai di surat.
6. ATURAN PEMISAHAN & PENGGABUNGAN MEREK (MUTLAK - PROMPT EXPLODER):
   - HANYA BOLEH GABUNGKAN item-item promo ke dalam 1 baris JSON APABILA mereka memiliki MEREK UTAMA (Brand Keluarga) yang sama 100%. (Misal: Sesama Bellagio Homme boleh digabung).
     * JIKA Anda menggabungkan beberapa produk/varian/gramasi ke dalam 1 baris (karena mereknya sama), MAKA string `ketentuan` WAJIB ditambah " Boleh Mix Kelompok dan Gramasi Barang Sama" di akhir teks! (Contoh: "Beli 7 Boleh Mix Kelompok dan Gramasi Barang Sama").
   - JIKA dalam satu tabel/promo dokumen PDF mencakup beberapa MEREK UTAMA yang berbeda (Misal: "Bellagio" dan "Camellia" mendapat promo diskon yang sama), ANDA DILARANG KERAS menggabungkannya ke dalam 1 object array JSON!
   - ANDA WAJIB MENDUPLIKASI / MEMECAH (EXPLODE) promo tersebut menjadi beberapa baris object JSON yang terpisah secara independen!
     * JSON Object 1: KHUSUS berisi kelompok "Bellagio" dengan `kode_barangs` yang HANYA milik Bellagio.
     * JSON Object 2: KHUSUS berisi kelompok "Camellia" dengan `kode_barangs` yang HANYA milik Camellia.
     * (Keduanya memiliki isi ketentuan, benefit_type, dan benefit yang sama dari hasil duplikasi. JANGAN LUPA tambahkan " Boleh Mix Kelompok dan Gramasi Barang Sama" pada masing-masing baris jika di dalamnya masih merupakan gabungan varian dari merek tersebut).
   - Ingat: 1 Object JSON = MAKSIMAL 1 MEREK UTAMA (KELOMPOK)! Jangan pernah ada penggabungan silang brand di kolom `kelompok` atau `kode_barangs`!
7. TIERING PROMO: Beda 'Ketentuan' (trigger qty) = baris JSON harus dipisah! (e.g., Beli 1 diskon 5%, Beli 10 diskon 10% -> 2 baris json).
8. PARTISI ITEM PER PAKET (MUTLAK - PENYEBAB UTAMA KESALAHAN!):
   Di dalam SATU merek, TIAP baris GROUP ITEM punya nilai PAKET/CUT PRICE-nya SENDIRI. Kamu WAJIB mengelompokkan item berdasarkan nilai paket yang PERSIS SAMA, lalu buat 1 baris JSON per nilai paket.
   - SATU item (kode_barang) hanya boleh masuk ke SATU baris JSON -- yaitu baris dengan paket yang sesuai barisnya di surat. DILARANG KERAS memasukkan item yang sama ke lebih dari satu baris ketentuan!
   - CONTOH BENAR (Bellagio, channel Retail):
       * "Bellagio Eau de Toilette 100ml"=7+1 dan "Bellagio EDP Prestige 50ml"=7+1 -> 1 baris: ketentuan "Beli 7", kode HANYA kedua item itu.
       * "Bellagio Roll On 50ml"=4+1, "Bellagio EDP 50ml"=4+1, "Bellagio Pomade 80gr"=4+1, "Bellagio Clay 90gr"=4+1, "Bellagio Body Spray 80ml"=4+1 -> 1 baris TERPISAH: ketentuan "Beli 4", kode HANYA kelima item itu.
   - CONTOH SALAH (JANGAN LAKUKAN): menaruh SEMUA item Bellagio ke baris "Beli 7" DAN juga ke baris "Beli 4". Item EDT 100ml TIDAK boleh muncul di baris Beli 4, dan Roll On TIDAK boleh muncul di baris Beli 7.
   - Jadi jumlah `kode_barangs` gabungan dari semua baris 1 merek = TEPAT sama dengan jumlah item merek itu di surat (tidak ada item dobel lintas baris).

=== DAFTAR REFERENSI BARANG ===
{master_names_context}
=== AKHIR DAFTAR REFERENSI BARANG ===

=== DAFTAR DATA CUSTOMER (KODE | NAMA) ===
{master_customers_context}
=== AKHIR DAFTAR DATA CUSTOMER ===

TUGAS PENCOCOKAN KEYWORD DAN KODE (ATURAN MUTLAK!):
Ubah logika pencarianmu dari Exact Match menjadi Keyword Mapping cerdas!
Saat dokumen PDF menyebutkan nama/varian barang (misal: 'Bellagio Eau de Toilete'), silakan cari baris 'REF:' yang paling relevan di "DAFTAR REFERENSI BARANG" di atas berdasarkan MEREK dan JENISNYA. 
Catat KESELURUHAN angka `Kode Barang` (-kode angka) dari referensi yang cocok tersebut dan gabungkan dengan koma di `kode_barangs`.

ATURAN PENGISIAN PROPERTI JSON (HURUF KECIL):
- "principle": (String) Nama Perusahaan
- "surat_program": (String) Nomor surat program
- "nama_program": (String) Nama Promo / Program
- "promo_group_id": (String) Isi NON_GROUP jika channel umum. Isi KODE CUSTOMER (C-XXX) jika ini adalah program khusus OUTLET/Toko tertentu.
- "channel_gtmt": (String) Nama Spesifik Channel (Misal: Retail, MTI, Star Outlet).
- "periode": (String) Ekstrak periode dari surat (misal "Februari 2024").
- "kelompok": (String) Jika nama kelompok tidak spesifik, JIBLAK EXACT dari `OUTPUT_KELOMPOK` referensi. Jika tidak ada referensi, isi string kosong "".
- "variant": (String) ATURAN MUTLAK: Jika surat program menyebut semua tipe/wangi, WAJIB isi dengan 'All Variant'.
- "gramasi": (String) Gramasi/volume LENGKAP DENGAN SATUAN persis seperti di surat (mis. "22ml", "100gr", "50ml", "80gr"). JANGAN buang satuannya. Kalau ada beberapa, pisah koma.
- "kode_barangs": (String) Angka Kode Barang dari `OUTPUT_KODE`. Pisahkan koma jika > 1.
- "ketentuan": (String) Syarat Beli (Misal "Beli 7"). JIKA PROMO BERLAKU UNTUK GABUNGAN VARIAN/GRAMASI, WAJIB tambahkan kalimat " Boleh Mix Kelompok dan Gramasi Barang Sama" di akhir teks! (Contoh: "Beli 7 Boleh Mix Kelompok dan Gramasi Barang Sama").
- "benefit_type": (String) DISC_RP, DISC_PCT, atau BONUS_QTY
- "benefit": (String) KHUSUS BONUS QTY (Brg fisik), WAJIB TULIS SATUAN (Misal "1 PCS" / "1 Grt"). Jika DISC_RP/PCT biarkan angkanya saja.
- "syarat_claim": (String) Ringkasan SINGKAT bagian syarat/mekanisme klaim di surat (mis. "Mekanisme Kontrol & klaim": batas waktu klaim + dokumen wajib). Jika surat TIDAK punya bagian syarat klaim, isi string kosong "".
- "keterangan": (String) KOSONGKAN SAJA

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
"""
            # PRISKILA (Task 9): matching surat->master TIDAK lagi ditebak LLM. LLM CUKUP
            # menyalin STRUKTUR surat (persepsi), lalu priskila_pipeline (matcher deterministik
            # teruji) yang memetakan ke SKU master. Maka utk Priskila kita GANTI TOTAL skema baris
            # di atas dengan skema struktur-saja: 1 object per BARIS GROUP ITEM surat, DILARANG
            # menebak kelompok/variant/kode_barangs & DILARANG menggabung baris.
            if _is_priskila(principle_name):
                prompt = f"""
Dokumen promosi ini milik principle: {principle_name.upper()}.
Tugas Anda HANYA menyalin STRUKTUR tabel surat apa adanya ke ARRAY JSON. JANGAN mencocokkan
ke daftar barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris "GROUP ITEM" di tabel surat. DILARANG KERAS menggabungkan
   beberapa baris/varian/merek menjadi satu object. Kalau tabel punya 20 baris GROUP ITEM,
   keluarkan TEPAT 20 object.
3. Salin teks sel "GROUP ITEM" APA ADANYA (verbatim) ke field "group_item_text" -- termasuk
   kata merek, jenis, dan gramasi (mis. "Bellagio Eau de Toilette 100ml"). JANGAN diringkas,
   JANGAN diubah ejaan/satuannya.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "channel_gtmt": (String) nama channel sesuai header tabel (Retail / MTI / Grosir / Star Outlet).
- "brand": (String) merek utama di kolom BRAND baris itu (mis. "BELLAGIO"). Kalau sel BRAND
  kosong karena rowspan, pakai merek yang sama dgn baris di atasnya.
- "group_item_text": (String) sel GROUP ITEM verbatim (lihat aturan 3).
- "paket": (String) sel PAKET verbatim (mis. "7+1", "4+1"). Kalau tabel cut-price MTI tanpa
  kolom PAKET, isi angka CUT PRICE-nya saja (mis. "4700").
- "cr": (String) nilai kolom CR / Cost Ratio kalau ada, selain itu "".
- "principle": (String) nama principle.
- "surat_program": (String) nomor surat program.
- "nama_program": (String) nama program/promo.
- "periode": (String) periode surat.
- "syarat_claim": (String) ringkasan SINGKAT bagian syarat/mekanisme klaim di surat
  (batas waktu klaim + dokumen wajib). Jika surat tidak punya bagian itu, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
"""
            # URC (Task 6): sama filosofi dgn Priskila (Task 9) -- LLM CUKUP menyalin
            # struktur surat, urc_pipeline (matcher deterministik + benefit parser teruji)
            # yang memetakan ke SKU master. Beda dari Priskila: URC menyatakan benefit
            # SEKALI di header "Nama Program" (bukan per baris "paket"), dan surat juga
            # memuat tabel alokasi kuota per RD/bulan (Lampiran) yang SENGAJA DIABAIKAN --
            # LLM tidak diminta membacanya sama sekali (keputusan user 2026-07-17).
            elif _is_urc(principle_name):
                prompt = f"""
Dokumen promosi ini milik principle: {principle_name.upper()}.
Tugas Anda HANYA menyalin STRUKTUR surat apa adanya ke ARRAY JSON. JANGAN mencocokkan ke daftar
barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris di tabel "Details SKU" (kolom Details SKU + Category).
   Kalau tabelnya punya 20 baris, keluarkan TEPAT 20 object.
3. Salin teks sel "Details SKU" APA ADANYA (verbatim) ke field "item_description" --
   termasuk nama produk dan gramasi (mis. "Lexus Cheese 76g x 24"). JANGAN diringkas,
   JANGAN diubah ejaan/satuannya.
4. Field "nama_program" diambil dari baris "Nama Program" di header surat (satu nilai
   yang SAMA untuk semua object -- surat ini hanya punya SATU program/benefit, dinyatakan
   sekali di header, BUKAN per baris tabel).
5. ABAIKAN SELURUH tabel lampiran/alokasi kuota per RD/kota/bulan (biasanya di halaman
   setelah tabel "Details SKU", berjudul "Lampiran" dengan kolom Area/City/RD/QTY ED per
   bulan). JANGAN membacanya, JANGAN mengekstrak isinya ke JSON manapun.
6. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "nama_program": (String) isi baris "Nama Program" di header surat, verbatim.
- "item_description": (String) sel "Details SKU" verbatim (lihat aturan 3).
- "category": (String) sel "Category" pada baris yang sama (mis. "Small pack", "Medium pack").
- "principle": (String) nama principle.
- "surat_program": (String) nomor surat di kop surat (baris "No. ..." di bawah judul
  AUTHORIZATION LETTER, mis. "004/178/URC/MT/VII/25").
- "periode": (String) isi baris "Periode" di header surat, verbatim.
- "channel_gtmt": (String) isi baris "Area Program" di header surat, ringkas (mis.
  "National MTI" -- tanpa kalimat keterangan dalam kurung).
- "syarat_claim": (String) ringkasan SINGKAT bagian "Mekanisme Kontrol & klaim": batas
  waktu klaim + dokumen yang wajib dilampirkan (mis. "Klaim maks 45 hari setelah promo
  berakhir; lampiran: AL, Cover Klaim URC, Faktur Pajak, Rekap Data Penjualan & print out
  system; nilai dari DBP/RBP exc PPN"). Jika bagian itu TIDAK ADA di surat, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
"""
            # FONTERRA/NATUR: filosofi sama dgn Priskila/URC -- LLM CUKUP menyalin
            # struktur surat verbatim, generic_promo_pipeline (matcher deterministik,
            # disetujui user via preview lokal) yang memetakan ke SKU master.
            elif _generic_det_key(principle_name) == "FONTERRA":
                prompt = f"""
Dokumen promosi ini milik principle: {principle_name.upper()}.
Tugas Anda HANYA menyalin STRUKTUR surat apa adanya ke ARRAY JSON. JANGAN mencocokkan ke daftar
barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris promo produk (baris bullet ">" berpola
   "BELI N <PRODUK> <GRAMASI> ... GRATIS <HADIAH>"). Kalau surat punya 17 baris promo,
   keluarkan TEPAT 17 object. JANGAN menggabung, JANGAN melewatkan baris.
3. Salin baris promo VERBATIM (termasuk kata BELI, angka, gramasi, GRATIS, dan hadiahnya)
   ke field "product_line_text". JANGAN diringkas, JANGAN diubah ejaan/satuannya.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "product_line_text": (String) baris promo verbatim (lihat aturan 3).
- "principle": (String) nama principle.
- "surat_program": (String) nomor/identitas surat program di kop.
- "nama_program": (String) nama program/promo di header surat.
- "periode": (String) periode program, verbatim.
- "channel_gtmt": (String) channel program (mis. MTI / GT), ringkas.
- "syarat_claim": (String) ringkasan SINGKAT syarat/mekanisme klaim (dokumen wajib +
  batas waktu). Jika surat tidak punya bagian itu, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
"""
            elif _generic_det_key(principle_name) == "ADNA":
                prompt = f"""
Dokumen promosi ini milik principle: {principle_name.upper()} (PT Gumindo Bogamanis, merek Kuaci Rebo).
Tugas Anda HANYA menyalin STRUKTUR surat apa adanya ke ARRAY JSON. JANGAN mencocokkan ke daftar
barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU aturan pembelian produk di bagian "Mekanisme Program"
   (kalimat berpola "Setiap pembelian <PRODUK+GRAMASI> (min N ctn) ... maka mendapatkan
   disc <NILAI>"). Kalau ada 2 aturan produk, keluarkan TEPAT 2 object.
   JANGAN membuat object untuk kalimat yang bukan aturan pembelian produk
   (mis. syarat growth, cara klaim, penutup surat).
3. Salin bagian PRODUK + GRAMASI verbatim ke "product_line_text", termasuk bila satu
   aturan menyebut DUA gramasi (mis. "Kuaci Rebo 150 gr/ 140 gr"). JANGAN dipecah,
   JANGAN diringkas, JANGAN diubah satuannya.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "product_line_text": (String) produk + gramasi verbatim (lihat aturan 3).
- "minimal_order": (String) minimal pembelian berikut SATUANNYA, verbatim (mis. "2 ctn").
  Jika tidak disebut, "".
- "discount": (String) benefit baris itu verbatim (mis. "disc Rp. 24.500/ctn"). Jika tidak ada, "".
- "principle": (String) nama principle.
- "surat_program": (String) nomor surat di kop (mis. "0074/GBM/MKT/V/24-Rev1").
- "nama_program": (String) isi baris "Hal" di kop surat, verbatim.
- "periode": (String) isi baris "Berlaku", verbatim.
- "channel_gtmt": (String) isi baris "Lokasi" (mis. "Nasional").
- "syarat_claim": (String) ringkasan SINGKAT syarat klaim (dokumen wajib + batas waktu
  klaim grosir/subdist). Jika bagian itu TIDAK ADA, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
"""
            elif _generic_det_key(principle_name) == "NATUR":
                prompt = f"""
Dokumen promosi ini milik principle: {principle_name.upper()} (merek NATUR, AZALEA, HG).
Tugas Anda HANYA menyalin STRUKTUR tabel surat apa adanya ke ARRAY JSON. JANGAN mencocokkan
ke daftar barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris produk/SKU di tabel promo surat. Kalau tabel punya 20
   baris produk, keluarkan TEPAT 20 object. JANGAN menggabung, JANGAN melewatkan baris.
3. Salin sel nama produk VERBATIM (termasuk merek dan gramasi, mis.
   "NATUR SHAMPOO GINSENG 140ML") ke field "product_line_text". JANGAN diringkas,
   JANGAN diubah ejaan/satuannya.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "product_line_text": (String) sel nama produk verbatim (lihat aturan 3).
- "minimal_order": (String) nilai kolom minimal order/pembelian baris itu, verbatim
  (mis. ">= 6", "6"). Jika tidak ada, "".
- "discount": (String) nilai kolom diskon/benefit baris itu, verbatim
  (mis. "5%", "add disc 5%", "1+1"). Jika tidak ada, "".
- "principle": (String) nama principle.
- "surat_program": (String) nomor surat program (biasanya diawali "PROID").
- "nama_program": (String) isi bagian "Nama Program", verbatim.
- "periode": (String) periode program, verbatim.
- "channel_gtmt": (String) channel dari nomor surat: "/MTI/" -> "MTI", "/GT/" -> "GT",
  "/ONLINE/" -> "ONLINE"; selain itu "".
- "syarat_claim": (String) ringkasan SINGKAT syarat klaim (mis. kalimat "maksimal
  diklaim ..."). Jika surat tidak punya bagian itu, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
"""
            # Principle generik lain (mis. FORISA) yang belum punya prompt khusus:
            # kontrak structure-only yang SAMA (product_line_text + minimal_order +
            # discount), cukup tambah nama principle di _generic_det_key + RULES.
            elif _generic_det_key(principle_name):
                prompt = f"""
Dokumen promosi ini milik principle: {principle_name.upper()}.
Tugas Anda HANYA menyalin STRUKTUR surat apa adanya ke ARRAY JSON. JANGAN mencocokkan ke daftar
barang, JANGAN menebak kode/kelompok. Sistem lain yang akan mencocokkan ke master.

ATURAN MUTLAK:
1. Kembalikan HANYA JSON array valid (tanpa teks pembuka/penutup, tutup dengan `]`).
2. SATU object JSON = SATU baris produk/SKU pada tabel atau daftar promo di surat.
   Kalau ada 20 baris produk, keluarkan TEPAT 20 object. JANGAN menggabung baris,
   JANGAN melewatkan baris, JANGAN membuat object untuk kalimat yang bukan baris produk.
3. Salin nama produk VERBATIM (termasuk merek, varian, dan gramasi/isi) ke
   "product_line_text". JANGAN diringkas, JANGAN diubah ejaan/satuannya. Bila satu baris
   menyebut dua ukuran (mis. "150 gr/ 140 gr"), salin apa adanya dalam satu field.
4. DILARANG mengeluarkan field "kelompok", "variant", "gramasi", ATAU "kode_barangs".
   Field-field itu akan diisi oleh sistem pencocokan, BUKAN oleh Anda.

FIELD PER OBJECT (huruf kecil, HANYA field ini):
- "product_line_text": (String) nama produk verbatim (lihat aturan 3).
- "minimal_order": (String) syarat minimal pembelian baris itu BERIKUT SATUANNYA,
  verbatim (mis. "2 ctn", ">= 6 pcs", "5 karton"). Jika tidak ada, "".
- "discount": (String) benefit/diskon baris itu verbatim (mis. "5%", "add disc 3%",
  "Rp 24.500/ctn", "1+1"). Jika tidak ada, "".
- "principle": (String) nama principle.
- "surat_program": (String) nomor/identitas surat program di kop.
- "nama_program": (String) nama program/promo.
- "periode": (String) periode program, verbatim.
- "channel_gtmt": (String) channel program (mis. GT / MTI / Nasional), ringkas.
- "syarat_claim": (String) ringkasan SINGKAT syarat/mekanisme klaim (dokumen wajib +
  batas waktu). Jika surat TIDAK punya bagian itu, isi "".

SANGAT PENTING: JANGAN BERIKAN TEKS APAPUN SELAIN JSON ARRAY VALID! PASTIKAN JSON DITUTUP SEMPURNA DENGAN `]` PADA AKHIRNYA!
"""
            # ponytail: "AI learning" dari koreksi manual user (tombol Laporkan Salah) -- bukan fine-tune
            # model, tapi few-shot: inject before->after koreksi lama ke prompt supaya kesalahan yg sama
            # tidak terulang utk principal yg sama.
            prompt += _format_corrections_for_prompt(_load_corrections(principle_name))

            # Prepare multimodal payload for Gemini 2.5 Flash
            import httpx
            import json
            import uuid
            
            all_rows = []
            
            async with httpx.AsyncClient(timeout=300.0) as client_http:
                # ==========================
                # SPLIT MODE LOGIC
                # ==========================
                if True: # Split Mode (Gemini OCR per-halaman + deepseek JSON parse)
                    # --- Phase 1: OCR PER-HALAMAN ---
                    # ponytail: dulu 1 request untuk SEMUA gambar -> mentok max_tokens (finish_reason=length)
                    # dan buang ~12% teks di dok 9 hlm (terbukti live). Per-halaman bikin tiap call finish=stop.
                    # Model OCR: gemini/gemini-2.5-flash (kualitas OCR dokumen unggul, dipilih user).
                    # Parse JSON pakai gpt-4.1-mini (non-reasoning, murah). mimo-v2.5/deepseek = reasoning
                    # (risiko token kebakar di halaman padat), gpt-4.1-mini juga vision kalau perlu fallback.
                    ocr_prompt = "Tugas Anda adalah melakukan OCR (Optical Character Recognition). Baca gambar halaman dokumen ini. Ekstrak SELURUH teks di dalamnya persis seperti aslinya, baris demi baris, tabel demi tabel. JANGAN diringkas, JANGAN ada kata atau angka yang terlewat sekecil apapun!"
                    headers = {
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json"
                    }
                    # gemini-2.5-flash DITARIK provider (404 "no longer available to new
                    # users", terbukti live 2026-07-19) -> default ke generasi flash terbaru.
                    # FASE 1: OCR cache by content hash -- surat byte-identik TIDAK di-OCR ulang
                    # (fondasi determinisme: run ke-2 ambil teks beku, Gemini 0 panggilan).
                    from ocr_cache import ocr_cache_key, ocr_cache_get, ocr_cache_put
                    # Provider eksperimen tidak boleh membaca cache Gemini untuk PDF sama.
                    _mistral_table_format = os.getenv("MISTRAL_OCR_TABLE_FORMAT", "html").strip().lower()
                    _cache_namespace = (
                        f"{ocr_model}:{_mistral_table_format}" if _use_mistral
                        else ocr_model if _use_rapid else ""
                    )
                    _doc_hash = ocr_cache_key(file_bytes, namespace=_cache_namespace)
                    _cached_ocr = ocr_cache_get(_doc_hash)
                    ocr_chunks = []
                    for _pg_idx, (_pg_label, b64) in enumerate([] if (_cached_ocr is not None or _use_rapid or _use_mistral) else zip(ocr_labels, base64_images)):
                        ocr_payload = {
                            "model": ocr_model,
                            "messages": [
                                {"role": "system", "content": "You are an expert Data Entry and OCR assistant."},
                                {"role": "user", "content": [
                                    {"type": "text", "text": ocr_prompt},
                                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                                ]}
                            ],
                            "temperature": 0.1,
                            "max_tokens": 8192
                        }
                        # ponytail: Gemini kadang balas 503 "high demand, usually temporary" -> retry
                        # singkat dgn backoff sebelum nyerah ke placeholder (terbukti live: 4/9 hlm gagal
                        # tanpa retry -> combined_text penuh placeholder -> parser downstream balik kosong).
                        _pg_text = None
                        _last_ocr_err = None
                        for _attempt in range(3):
                            try:
                                ocr_resp = await client_http.post("https://ai.sumopod.com/v1/chat/completions", json=ocr_payload, headers=headers)
                                if ocr_resp.status_code in (503, 429) and _attempt < 2:
                                    append_error_log("gemini_ocr_retry", Exception(f"HTTP {ocr_resp.status_code} hlm {_pg_idx+1} attempt {_attempt+1}"), {"text": ocr_resp.text[:300]})
                                    await asyncio.sleep(3 * (_attempt + 1))
                                    continue
                                if ocr_resp.status_code != 200:
                                    append_error_log("gemini_ocr_error", Exception(f"HTTP {ocr_resp.status_code} hlm {_pg_idx+1}"), {"text": ocr_resp.text})
                                    ocr_resp.raise_for_status()
                                _pg_text = ocr_resp.json().get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                                # ponytail: halaman minim-konten (mis. tanda tangan) kadang bikin model OCR
                                # nyasar ke loop repetisi karakter tanpa henti (terbukti live: 1 halaman jadi
                                # >120rb karakter underscore). Deteksi & retry spt 503, biar tak membengkakkan
                                # chunk lain yang menempel di akhir teks.
                                _degenerate = bool(re.search(r'(.)\1{199,}', _pg_text))
                                if _degenerate and _attempt < 2:
                                    append_error_log("gemini_ocr_degenerate", Exception(f"repetition loop hlm {_pg_idx+1} attempt {_attempt+1}"), {"len": len(_pg_text)})
                                    _pg_text = None
                                    await asyncio.sleep(3 * (_attempt + 1))
                                    continue
                                if _degenerate:
                                    # percobaan terakhir masih degenerate -> potong sebelum repetisi mulai,
                                    # simpan konten valid yg sempat terbaca drpd buang seluruh halaman
                                    _pg_text = re.split(r'(.)\1{199,}', _pg_text, maxsplit=1)[0].strip() or None
                                break
                            except Exception as _ocr_e:
                                _last_ocr_err = _ocr_e
                                if _attempt < 2:
                                    await asyncio.sleep(3 * (_attempt + 1))
                                    continue
                        if _pg_text is not None:
                            ocr_chunks.append(f"--- {_pg_label} ---\n{_pg_text}")
                        else:
                            append_error_log("gemini_ocr_page_fail", _last_ocr_err or Exception("unknown"), {"page": _pg_label})
                            ocr_chunks.append(f"--- {_pg_label} (OCR GAGAL setelah 3x percobaan) ---")
                    if _cached_ocr is not None:
                        ocr_text = _cached_ocr.get("ocr_text", "")  # cache hit: teks OCR beku, Gemini tak dipanggil
                    elif _use_rapid:
                        import rapidocr_adapter
                        _valid_gramasi = rapidocr_adapter.build_gramasi_whitelist(
                            MANUAL_MASTER_CACHE.get(token, {}).get("items", []))
                        ocr_text = rapidocr_adapter.ocr_pdf_to_text(file_bytes, valid_gramasi=_valid_gramasi)
                        if ocr_text.strip():
                            ocr_cache_put(_doc_hash, getattr(pdf, "filename", "") or "", ocr_text, pages_total, len(base64_images))
                        elif not pdf_text.strip():
                            append_error_log("ocr_all_pages_failed", Exception("RapidOCR kosong"),
                                             {"file": getattr(pdf, "filename", ""), "model": ocr_model, "user": user})
                            return {"ok": False, "error": "RapidOCR tak menghasilkan teks & PDF tak punya teks native."}
                    elif _use_mistral:
                        import mistral_ocr_adapter
                        _mistral_key = os.getenv("MISTRAL_API_KEY", "").strip()
                        if not _mistral_key:
                            return {"ok": False, "error": "MISTRAL_API_KEY belum dikonfigurasi."}
                        try:
                            ocr_text = await mistral_ocr_adapter.ocr_pdf_to_text(
                                file_bytes,
                                _mistral_key,
                                model=ocr_model,
                                page_count=min(pages_total, MAX_OCR_PAGES),
                                table_format=_mistral_table_format,
                                client=client_http,
                            )
                        except Exception as _mistral_error:
                            append_error_log(
                                "mistral_ocr_error",
                                _mistral_error,
                                {"file": getattr(pdf, "filename", "") or "", "model": ocr_model, "user": user},
                            )
                            # Provider eksplisit harus fail-closed. Fallback diam-diam ke
                            # native text membuat E2E terlihat menguji Mistral padahal API gagal.
                            return {"ok": False, "error": f"Mistral OCR gagal: {_mistral_error}"}
                        if ocr_text.strip():
                            ocr_cache_put(
                                _doc_hash,
                                getattr(pdf, "filename", "") or "",
                                ocr_text,
                                pages_total,
                                min(pages_total, MAX_OCR_PAGES),
                            )
                        else:
                            return {"ok": False, "error": "Mistral OCR tak menghasilkan teks; fallback native text dinonaktifkan untuk provider eksplisit."}
                    else:
                        ocr_text = "\n\n".join(ocr_chunks)
                        # Jangan BEKUKAN kegagalan: kalau tak ada satu pun halaman yang
                        # sukses, cache-nya akan membuat run berikutnya "sukses kosong"
                        # selamanya tanpa cara tahu kenapa.
                        _ocr_ok = [c for c in ocr_chunks if "OCR GAGAL" not in c]
                        if _ocr_ok or not ocr_chunks:
                            ocr_cache_put(_doc_hash, getattr(pdf, "filename", "") or "", ocr_text, pages_total, len(base64_images))
                        elif not pdf_text.strip():
                            # Semua halaman gagal OCR & PDF tak punya teks native -> tidak ada
                            # apa pun untuk di-parse. Berhenti SEBELUM memanggil LLM: dulu
                            # tetap lanjut & retry parse 6x atas teks kosong (biaya terbakar
                            # tanpa hasil, terbukti live 2026-07-19).
                            append_error_log("ocr_all_pages_failed", Exception("semua halaman gagal OCR"),
                                             {"file": getattr(pdf, "filename", ""), "pages": len(base64_images),
                                              "model": ocr_model, "user": user})
                            return {"ok": False, "error": (
                                f"OCR gagal untuk SEMUA {len(base64_images)} halaman/gambar (model {ocr_model}) "
                                "dan PDF tidak punya teks native. Cek ketersediaan model OCR / kunci API "
                                "(lihat data/error_log.jsonl tag gemini_ocr_error). Tidak ada baris yang di-generate.")}
                    # PDF Natur punya text layer lengkap; menambah OCR lagi membuat tabel 18 baris
                    # tampil dua kali dan parser menghasilkan 36 object/tier silang. Untuk provider
                    # OCR eksplisit, OCR adalah satu-satunya sumber parser. Jalur Gemini/default
                    # dipertahankan agar perilaku produksi tidak berubah sebelum parity disetujui.
                    combined_text = ocr_text if _explicit_ocr else pdf_text + "\n\n=== HASIL OCR DARI GAMBAR ===\n\n" + ocr_text
                    if pages_truncated:
                        combined_text += f"\n\n[PERINGATAN: surat {pages_total} halaman, hanya {len(base64_images)} halaman pertama diproses. Naikkan SUMMARY_MAX_OCR_PAGES.]"

                    # --- Phase 2: Parsing JSON PER-CHANNEL ---
                    # ponytail: 1 panggilan utk SELURUH dokumen kehabisan max_tokens di tengah channel
                    # pertama (Retail) krn format JSON per-SKU sangat verbose (puluhan kode per baris) ->
                    # channel MTI/Grosir/Star Outlet tak pernah ke-generate meski JSON yg dihasilkan valid
                    # (terbukti live: qwen3.6-flash & gpt-4.1-mini keduanya berhenti persis stlh Retail).
                    # Fix: pecah teks per section "N. ... CHANNEL ..." lalu parse tiap bagian terpisah
                    # (pola sama dgn fix OCR per-halaman) -> tiap panggilan dapat budget token penuh.
                    import re
                    # [\s*#>_-]* di depan: OCR kadang membungkus header dgn markdown (terbukti run
                    # live 2026-07-14: "**3. ... CHANNEL GROSIR:**" -> header GROSIR TAK terdeteksi,
                    # konten GROSIR ke-merge ke chunk lain & hilang). Toleransi markdown depan angka.
                    _hdr_re = re.compile(r'^[\s*#>_-]*\d+\.\s*.{0,80}?channel', re.IGNORECASE | re.MULTILINE)
                    _hdrs = list(_hdr_re.finditer(combined_text))
                    if len(_hdrs) >= 2:
                        _preamble = combined_text[:_hdrs[0].start()]
                        channel_chunks = [
                            combined_text[_hdrs[i].start(): _hdrs[i + 1].start() if i + 1 < len(_hdrs) else len(combined_text)]
                            for i in range(len(_hdrs))
                        ]
                    else:
                        _preamble = ""
                        channel_chunks = [combined_text]

                    # ponytail: guard V1/D -- deteksi TERBUKTI SALAH kalau pakai regex baris-tabel
                    # markdown (rapuh, gagal kalau OCR format tabelnya beda per run -- chunk MTI live
                    # sempat balik expected_brands KOSONG shg guard lolos trivial padahal brand hilang
                    # total). Ganti: alias brand (ejaan surat vs abrev master, spt "BELLAGIO"->"BLAGIO"
                    # yg sudah dipakai di _apply_native_kelompok) + substring BEBAS di teks mentah,
                    # BUKAN bergantung struktur tabel -- tahan terhadap variasi format OCR apa pun.
                    _BRAND_ALIASES = {
                        "BLAGIO": ["BLAGIO", "BELLAGIO"],
                        "CAMELLIA": ["CAMELLIA"],
                        "CSBNCA": ["CSBNCA", "CASABLANCA"],
                        "EXCELO": ["EXCELO", "EXCELLO"],
                        "MARIE JOSE": ["MARIE JOSE", "MARIE-JOSE", "MARIEJOSE"],
                        "REGAZZA": ["REGAZZA", "REGZZA", "REGGAZZA"],
                    }
                    def _extract_expected_brands(_chunk_text_for_ai):
                        _upper = _chunk_text_for_ai.upper()
                        return {p for p, aliases in _BRAND_ALIASES.items() if any(a in _upper for a in aliases)}

                    async def _parse_json_chunk(_chunk_text_for_ai, _label):
                        _parsing_prompt = f"{prompt}\n\n====================\nBERIKUT ADALAH TEKS DOKUMEN PROMO ({_label}):\n{_chunk_text_for_ai}\n\n====================\nPENTING: Ekstrak tabel dari teks di atas dan KEMBALIKAN ARRAY JSON SEKARANG JUGA DIAWALI DENGAN SIMBOL '['. JANGAN TULIS HAL LAIN."
                        _payload = {
                            "model": os.getenv("SUMOPOD_MODEL", "gpt-4.1-mini"),
                            "messages": [
                                {"role": "system", "content": "You are a STRICT data extraction AI. You ONLY speak in valid JSON array format starting with '['. You NEVER output regular text, markdown, or greetings. You MUST obey the schema."},
                                {"role": "user", "content": _parsing_prompt}
                            ],
                            "temperature": 0.1,
                            # ponytail: HANYA "max_tokens" -- OpenAI/litellm menolak 400 kalau max_tokens &
                            # max_completion_tokens dikirim BERSAMAAN (terbukti live dgn gpt-4.1-mini).
                            "max_tokens": int(os.getenv("SUMMARY_PARSE_MAX_TOKENS", "16000"))
                        }
                        _full_raw = ""
                        for _loop_idx in range(5):
                            _resp = await client_http.post("https://ai.sumopod.com/v1/chat/completions", json=_payload, headers=headers)
                            if _resp.status_code != 200:
                                append_error_log("claude_400_debug", Exception(f"HTTP {_resp.status_code} chunk={_label}"), {"text": _resp.text})
                            _resp.raise_for_status()
                            _chunk_msg = _resp.json().get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                            _clean = re.sub(r"```json", "", _chunk_msg, flags=re.IGNORECASE)
                            _clean = re.sub(r"```", "", _clean)
                            _overlap = 0
                            if _full_raw:
                                for _i in range(min(100, len(_full_raw), len(_clean)), 0, -1):
                                    if _full_raw[-_i:] == _clean[:_i]:
                                        _overlap = _i
                                        break
                            _full_raw += _clean[_overlap:]
                            if _full_raw.strip().endswith("]"):
                                break
                            if not _chunk_msg:
                                break
                            _payload["messages"].append({"role": "assistant", "content": _chunk_msg})
                            _payload["messages"].append({"role": "user", "content": "Teks JSON terpotong karena batas token! WAJIB lanjutkan string JSON di atas TEPAT mulai dari huruf/simbol yang terputus tanpa basa-basi pengantar, tanpa markdown ```json. Langsung sambung karakternya!"})
                        return _full_raw.strip()

                    all_rows = []
                    _debug_dump = []
                    for _ci, _chunk in enumerate(channel_chunks):
                        # ponytail: preamble berisi No surat (mis. "002/PPM/NSPM/III/2026") -> WAJIB ikut
                        # ke SEMUA chunk termasuk chunk pertama (dulu _ci>0 bikin Retail kosong surat_program).
                        _chunk_full = (_preamble + "\n\n" + _chunk) if _preamble else _chunk
                        _label = f"bagian {_ci + 1}/{len(channel_chunks)}"
                        _chunk_rows = []
                        # ponytail: 2 kegagalan berbeda yg pernah kejadian live: (a) model balas [] valid
                        # padahal chunk jelas ada datanya (non-deterministik), (b) model balas SEBAGIAN
                        # brand saja lalu berhenti (MTI: cuma 2 dari 6 brand tertangkap, JSON tetap valid
                        # jadi tidak "kosong"). Guard emptiness SAJA tidak menangkap (b) -- tambah cek
                        # kelengkapan brand (dari kolom BRAND tabel OCR, generik, tidak spesifik principal),
                        # retry sampai lengkap, simpan percobaan TERBAIK (paling sedikit brand hilang).
                        _expected_brands = _extract_expected_brands(_chunk_full)
                        _best_rows, _best_missing = [], None
                        for _retry in range(6):  # ponytail: akurasi wajib > biaya -- retry lebih banyak sampai brand lengkap
                            _raw = await _parse_json_chunk(_chunk_full, _label)
                            _debug_dump.append(f"=== CHUNK {_label} (percobaan {_retry + 1}) ===\n{_raw}\n")
                            if not _raw:
                                append_error_log("chunk_empty_response", Exception("No text returned"), {"chunk": _label, "attempt": _retry + 1, "user": user})
                                continue
                            _match = re.search(r"\[.*\]", _raw, re.DOTALL)
                            _clean_text = _match.group(0).strip() if _match else _raw.strip()
                            if _clean_text.startswith("[") and not _clean_text.endswith("]"):
                                _last_brace = _clean_text.rfind("}")
                                if _last_brace != -1:
                                    _clean_text = _clean_text[:_last_brace + 1] + "\n]"
                            try:
                                _chunk_data = json.loads(_clean_text, strict=False)
                            except json.JSONDecodeError:
                                append_error_log("chunk_invalid_json", Exception("Non-JSON payload"), {"chunk": _label, "attempt": _retry + 1, "raw": _raw[:500]})
                                continue
                            if isinstance(_chunk_data, list):
                                _chunk_rows = _chunk_data
                            elif isinstance(_chunk_data, dict) and "rows" in _chunk_data:
                                _chunk_rows = _chunk_data["rows"]
                            if not _chunk_rows:
                                continue
                            # ponytail: cek kelengkapan brand HARUS pakai kelompok HASIL MATCHING ke
                            # master (yg sungguhan masuk Excel/PDF), BUKAN teks tebakan AI mentah --
                            # terbukti live keduanya bisa berbeda (raw text bilang "hilang" padahal
                            # setelah di-match ke master brand-nya sebenarnya ketemu, atau sebaliknya).
                            import copy as _copy
                            try:
                                _resolved_probe = _apply_native_kelompok(_copy.deepcopy(_chunk_rows), items)
                            except Exception:
                                _resolved_probe = _chunk_rows
                            _got_text = " ".join(str(_r.get("kelompok","")) + " " + str(_r.get("principle","")) for _r in _resolved_probe).upper()
                            _missing = [b for b in _expected_brands if b not in _got_text]
                            if _best_missing is None or len(_missing) < len(_best_missing):
                                _best_rows, _best_missing = _chunk_rows, _missing
                            if not _missing:
                                break
                        if _best_missing:
                            append_error_log("chunk_incomplete_brands", Exception("Brand tidak lengkap setelah retry"), {"chunk": _label, "missing_brands": _best_missing, "user": user})
                        # Channel OTORITATIF dari HEADER chunk, BUKAN label LLM. Chunk displit per
                        # "N. ... CHANNEL X" -> channel tiap chunk sudah pasti. Terbukti (run live
                        # 2026-07-14): LLM kadang salah-label -- baris GROSIR ditulis "STAR OUTLET"
                        # -> data pindah channel & Marie Jose hilang dari GROSIR. Paksa dari header
                        # (kalau header tak terbaca, biarkan label LLM apa adanya -> aman).
                        _hdr_line = _chunk.lstrip().splitlines()[0] if _chunk.strip() else ""
                        _m_ch = re.search(r'channel\s*:?\s*(.+)', _hdr_line, re.IGNORECASE)
                        # strip markdown/kolon di kedua ujung (header ter-OCR "GROSIR:**" dll).
                        _chunk_channel = _m_ch.group(1).strip().strip("*:#_ ").strip() if _m_ch else ""
                        if _chunk_channel:
                            for _r in _best_rows:
                                _r["channel_gtmt"] = _chunk_channel
                        all_rows.extend(_best_rows)

                    try:
                        with open(os.path.join(BASE_DIR, "data", "debug_ai.txt"), "w", encoding="utf-8") as f:
                            f.write(f"=== OCR PHASE 1 ===\n{ocr_text if 'ocr_text' in locals() else 'N/A'}\n\n=== JSON PHASE 2 (per-channel) ===\n" + "\n".join(_debug_dump))
                    except Exception:
                        pass

                    if not all_rows:
                        return {"ok": False, "error": "AI tidak menemukan tabel promo valid di dalam dokumen, atau gagal mengekstrak."}

                    for idx, row in enumerate(all_rows):
                        if "id" not in row:
                            row["id"] = str(uuid.uuid4())
                        if "no" not in row:
                            row["no"] = str(idx + 1)

                    # PASS 3 (ala Reducto "VLMs make corrections"): editor QA LLM membandingkan
                    # rows vs teks sumber OCR, ajukan PATCH per-field (tak boleh tambah/hapus
                    # baris/sentuh kode_barangs). Dijalankan SEBELUM native mapping (koreksi
                    # kelompok ikut ter-resolve) & SEBELUM parse_cache_put (yg dibekukan =
                    # hasil terkoreksi). Gagal apa pun -> rows utuh. Off: SUMMARY_SELF_CORRECT=0.
                    if os.getenv("SUMMARY_SELF_CORRECT", "1") != "0":
                        async def _editor_post(_pl):
                            _r = await client_http.post("https://ai.sumopod.com/v1/chat/completions", json=_pl, headers=headers)
                            _r.raise_for_status()
                            return _r.json().get("choices", [{}])[0].get("message", {}).get("content", "")
                        all_rows, _p3_patches = await verify_and_correct_rows(
                            combined_text, all_rows, _editor_post, os.getenv("SUMOPOD_MODEL", "gpt-4.1-mini"))
                        # ponytail: log SELALU (termasuk 0 patch) -- tanpa ini "editor bersih"
                        # tak bisa dibedakan dari "editor gagal diam-diam" saat diagnosis.
                        append_error_log("self_correction_patches", Exception(f"{len(_p3_patches)} patch editor"), {"patches": _p3_patches, "user": user})

                    # TAHAP 2: Native Master DB Mapping (Injects Kelompok perfectly)
                    # Stempel _gen_key (FONTERRA/NATUR) -- router yang menentukan, bukan LLM,
                    # supaya _apply_native_kelompok me-route ke generic_promo_pipeline.
                    _gk = _generic_det_key(principle_name)
                    if _gk:
                        for _r in all_rows:
                            _r["_gen_key"] = _gk
                    all_rows = _apply_native_kelompok(all_rows, items)

                    # FASE 2b: regroup baris berdasarkan tier OTORITATIF dari tabel OCR (bukan LLM) --
                    # kode_barang yg terbukti (keyakinan tinggi) py trigger/benefit sama digabung jadi
                    # 1 baris (kasus nyata: Bellagio EDT & EDP Prestige ke-split LLM padahal 7+1 sama).
                    # Kode yg tak ter-bridge dgn keyakinan tinggi TIDAK disentuh (aman, no silent guess).
                    # PRISKILA (Task 10): matcher deterministik SUDAH mengeluarkan baris 1:1 (sudah
                    # ter-merge per (channel, prefix, tier) di priskila_pipeline) -- regroup tier
                    # heuristik LLM/OCR di sini DILEWATI supaya tidak menggabung ulang / merusak.
                    # (generic FONTERRA/NATUR juga dilewati: barisnya sudah 1:1 deterministik)
                    if not (_is_priskila(principle_name) or _gk):
                        all_rows, _tier_regroup_log = regroup_rows_by_tier(all_rows, items, ocr_text)

                    # FASE 1b: bekukan rows hasil parse (freeze-on-first-write) -> run berikut
                    # dok+principle sama pakai ini, tanpa OCR/LLM lagi (deterministik + hemat).
                    # Channel gate (fail-closed per principle) SEBELUM freeze: channel di luar
                    # mapping principle -> berhenti & minta user lengkapi mapping; JANGAN bekukan
                    # hasil cacat (kalau dibekukan, run berikut replay channel salah dari cache).
                    _gate = _channel_gate(all_rows, principle_name)
                    if _gate: return _gate
                    parse_cache_put(_parse_key, all_rows, getattr(pdf, "filename", "") or "", principle_name)

                    # TAHAP 3: Return raw rows directly to frontend so the user can see/edit individual variants natively.
                    # (The actual grouping and Prefix Compression runs natively during summary_manual_generate)
                    return {"ok": True, "rows": all_rows}

                # ==========================
                # FULL MODE LOGIC (dead code, ai_mode selalu "split" di UI -- dibiarkan sbg fallback lama)
                # ==========================
                else: 
                    # Original logic using only Gemini
                    user_content = [{"type": "text", "text": prompt}]
                    # GLM-5 and Claude sonnet on some proxy setups reject image_url.
                    current_model = os.getenv("SUMOPOD_MODEL", "glm/glm-5").lower()
                    if "glm-5" not in current_model and "kimi" not in current_model and "deepseek" not in current_model:
                        for b64 in base64_images:
                            user_content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
                        
                    messages = [
                        {"role": "system", "content": "You are a helpful AI assistant that extracts precise JSON tables from text and scanned images."},
                        {"role": "user", "content": user_content}
                    ]
                    
                    payload = {
                        "model": os.getenv("SUMOPOD_MODEL", "glm/glm-5"),
                        "messages": messages,
                        "temperature": 0.1,
                        "max_completion_tokens": 8192,
                        "max_tokens": 8192
                    }
                    
                    headers = {
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json"
                    }
    
                    full_raw_text = ""
                    for loop_idx in range(5):
                        resp = await client_http.post(
                            "https://ai.sumopod.com/v1/chat/completions",
                            json=payload,
                            headers=headers
                        )
                        
                        if resp.status_code != 200:
                            append_error_log("gemini_400_debug", Exception(f"HTTP {resp.status_code}"), {"text": resp.text})
                        resp.raise_for_status()
                        
                        response_json = resp.json()
                        chunk_text = response_json.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                        
                        # Bersihkan markdown formatting di tengah-tengah jika ini adalah sambungan
                        import re
                        clean_chunk = re.sub(r"```json", "", chunk_text, flags=re.IGNORECASE)
                        clean_chunk = re.sub(r"```", "", clean_chunk)
                        
                        # Gemini sometimes repeats the last few characters when asked to continue.
                        # We must find the overlap and slice it out before appending.
                        overlap_len = 0
                        if full_raw_text:
                            # Check overlapping strings up to 100 characters max
                            for i in range(min(100, len(full_raw_text), len(clean_chunk)), 0, -1):
                                if full_raw_text[-i:] == clean_chunk[:i]:
                                    overlap_len = i
                                    break
                                    
                        full_raw_text += clean_chunk[overlap_len:]
                        
                        # Cek apakah JSON sudah tertutup seutuhnya
                        if full_raw_text.strip().endswith("]"):
                            break # Yey selesai!
                        
                        # Jika belum selesai tapi chunk kosong, AI nyerah
                        if not chunk_text:
                            break
                            
                        # Minta AI melanjutkan TEPAT dari karakter terakhir yang terpotong
                        payload["messages"].append({"role": "assistant", "content": chunk_text})
                        payload["messages"].append({"role": "user", "content": "Teks JSON terpotong karena batas token! WAJIB lanjutkan string JSON di atas TEPAT mulai dari huruf/simbol yang terputus tanpa basa-basi pengantar, tanpa markdown ```json. Langsung sambung karakternya!"})


                raw_text = full_raw_text.strip()
                try:
                    with open(os.path.join(BASE_DIR, "data", "debug_ai.txt"), "w", encoding="utf-8") as f:
                        f.write(f"=== OCR PHASE 1 ===\n{ocr_text if 'ocr_text' in locals() else 'N/A'}\n\n=== JSON PHASE 2 ===\n{raw_text}\n")
                except Exception:
                    pass
                if not raw_text:
                    append_error_log("gemini_empty_response", Exception("No text returned"), {"user": user})
                    return {"ok": False, "error": "AI mengembalikan respons kosong."}
                    
                # Extract JSON block just in case
                match = re.search(r"\[.*\]", raw_text, re.DOTALL)
                if match:
                    clean_text = match.group(0).strip()
                else:
                    clean_text = raw_text.strip()
                    
                # Auto-heal truncated JSON jika proxy benar-benar mati
                if clean_text.startswith("[") and not clean_text.endswith("]"):
                    last_brace = clean_text.rfind("}")
                    if last_brace != -1:
                        clean_text = clean_text[:last_brace+1] + "\n]"
                        
                try:
                    batch_data = json.loads(clean_text, strict=False)
                except json.JSONDecodeError:
                    append_error_log("gemini_invalid_json", Exception("Non-JSON Payload String Loop"), {"raw": raw_text[:500]})
                    return {"ok": False, "error": f"AI gagal mengirim struktur JSON yang benar.\n\nContoh respons:\n{raw_text[:200]}"}
                    
                if isinstance(batch_data, list):
                    all_rows = batch_data
                elif isinstance(batch_data, dict) and "rows" in batch_data:
                    all_rows = batch_data["rows"]
                
            if not all_rows:
                return {"ok": False, "error": "AI tidak menemukan tabel promo valid di dalam dokumen, atau gagal mengekstrak."}
                
            try:
                import json
                with open("/tmp/ai_dump.json", "w") as f:
                    json.dump(all_rows, f, indent=2)
            except: pass
            
            for idx, row in enumerate(all_rows):
                if "id" not in row:
                    row["id"] = str(uuid.uuid4())
                if "no" not in row:
                    row["no"] = str(idx + 1)
                    
            # TAHAP 2: Native Master DB Mapping (Injects Kelompok perfectly)
            all_rows = _apply_native_kelompok(all_rows, items)
            
            # TAHAP 3: Return raw rows directly to frontend so the user can see/edit individual variants natively.
            # (The actual grouping and Prefix Compression runs natively during summary_manual_generate)
            return {"ok": True, "rows": all_rows}
                
        except Exception as api_err:
             append_error_log("gemini_api_error", api_err, {"user": user})
             return {"ok": False, "error": f"Gagal menghubungi Google Gemini AI: {str(api_err)}"}

        
    except Exception as e:
        import traceback
        err_msg = traceback.format_exc()
        print("====== FATAL N8N PARSE ERROR ======")
        print(err_msg)
        return {"ok": False, "error": f"Internal Server Error: {str(e)}"}
        print("===================================")
        append_error_log("summary_manual_parse_pdf_n8n", e, {"user": user, "token": token})
        payload = {"ok": False, "error": "Kegagalan sistem internal saat memproses PDF."}
        if APP_DEBUG and is_admin_user(user):
            payload["detail"] = str(e)
        return payload

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

        # FASE 4b: SELAIN hint lama di atas (JANGAN dihapus), simpan tiap field yg berubah
        # ke correction_store dgn stable key (kode_barang, channel, no_surat) -- override
        # deterministik di generate berikutnya, tak tergantung posisi baris/hasil AI.
        channel = s(after.get("channel_gtmt", "") or before.get("channel_gtmt", ""))
        no_surat = s(after.get("surat_program", "") or before.get("surat_program", ""))
        kode_list = [k.strip() for k in str(after.get("kode_barangs", "") or "").split(",") if k.strip()]
        stable_saved = 0
        for field, correct_value in after.items():
            if field in _CORRECTION_IGNORE_KEYS or field in ("kode_barangs", "channel_gtmt", "surat_program"):
                continue
            wrong_value = before.get(field)
            if wrong_value == correct_value:
                continue
            for kode_barang in kode_list:
                save_correction(kode_barang, channel, no_surat, field, wrong_value, correct_value,
                                 corrected_by=user, note=entry["note"])
                stable_saved += 1
        return {"ok": True, "stable_corrections_saved": stable_saved}
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
    
    if file_id not in MANUAL_OUTPUTS:
        return JSONResponse(status_code=404, content={"ok": False, "error": "Generated files not found."})

    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})

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
