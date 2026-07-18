# main.py (PATCH v12) — Channel lookup uploader + Internal dataset optional + Required-file guard UI/API
# Tujuan: FastAPI backend untuk validator, Master Barang, payments restore/SPPD, finance approval, RBAC, proof upload, dan helper export berformat.
# Caller: Next.js dashboard routes, browser uploads, dan service local AccAPI.
# Dependensi: FastAPI, pandas/openpyxl, payments.py, template DOCX SPPD, Better Auth SQLite DB, filesystem JSON/output, auth utilities.
# Main Functions: master_barang_extract, render_sppd_docx, payments_upload/update/clear, SPPD/finance endpoints, dan router domain.
# Side Effects: HTTP response/download, OCR/AI call, file upload/read/write, payments.json backup/mutation, DOCX/XLSX generation, audit logging.
# =======================================================================================================
# You requested:
# 1) Engine reads program by channel using lookup "Data Channel by SUB" + data penjualan.
# 2) Add uploader for:
#    - Data Channel by SUB (required)
#    - Dataset Diskon Internal (optional)
# 3) If user doesn't upload Data Penjualan / Dataset Diskon Pabrik / Data Channel:
#    - block validate
#    - show message box: "Data Penjualan masih kosong tuh, upload dulu dong adiks-adiks/kakaks-kakaks"
#    (We'll use the same message for any missing required file to keep UX simple; details shown in UI text.)
# 4) Dataset Diskon Internal may be empty/missing (allow validate anyway).
#
# Notes:
# - This patch keeps v11 "Program Lock for DISC_PCT (match MDSTRING)" + v9 satpam trigger-unit.
# - Internal dataset is loaded (if provided) but NOT applied to expected yet (as per your earlier request).
#   We keep it ready for next patch to move TanpaTuan -> Internal.
#
# Run:
#   python -m uvicorn main:app --reload --port 8000


from shared import (
    AUTH_COOKIE,
    AUTH_COOKIE_SECURE,
    Any,
    BACKGROUND_JOBS,
    BANK_DATA_PATH,
    CORS_ALLOWED_ORIGINS,
    CSRF_COOKIE,
    CSRF_COOKIE_SAMESITE,
    CSRF_TTL_SECONDS,
    Dict,
    FastAPI,
    File,
    FileResponse,
    Form,
    JSONResponse,
    List,
    MANUAL_MASTER_CACHE,
    MASTERS_DIR,
    MAX_EXCEL_UPLOAD_BYTES,
    PATCH_VERSION,
    Request,
    UploadFile,
    _load_principles,
    _normalize_samesite,
    _parse_master_barang_xlsx,
    _save_principles,
    append_audit_log,
    build_security_headers,
    favicon_media_type,
    find_best_match,
    find_favicon_path,
    generate_import_report,
    get_current_user,
    get_or_create_csrf_token,
    io,
    load_bank_map,
    load_bank_map_with_normalized_keys,
    load_payments_db,
    os,
    pd,
    read_upload_file_limited,
    s,
    save_payments_db,
    time,
    user_has_permission,
    uuid,
)

app = FastAPI(title="Discount Validator API", version=f"PATCH-{PATCH_VERSION}")

from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1000)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    forwarded_proto = s(request.headers.get("x-forwarded-proto", "")).lower()
    is_https = request.url.scheme == "https" or forwarded_proto == "https"
    for k, v in build_security_headers(is_https).items():
        if k not in response.headers:
            response.headers[k] = v
    return response

@app.get("/api/me")
def api_me(request: Request):
    user = get_current_user(request)
    token = get_or_create_csrf_token(request)
    samesite = _normalize_samesite(CSRF_COOKIE_SAMESITE)
    resp = JSONResponse({
        "ok": True, 
        "authenticated": bool(user), 
        "user": user if user else None,
        "csrf_token": token
    })
    resp.set_cookie(
        CSRF_COOKIE, token, httponly=False, max_age=CSRF_TTL_SECONDS,
        path="/", samesite=samesite, secure=AUTH_COOKIE_SECURE
    )
    return resp

@app.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(AUTH_COOKIE)
    resp.delete_cookie(CSRF_COOKIE)
    return resp





@app.get("/favicon.ico")
@app.get("/favicon.png")
def favicon():
    path = find_favicon_path()
    if not path:
        return JSONResponse(status_code=404, content={"detail": "File not found"})
    return FileResponse(path, media_type=favicon_media_type(path))

# ---------------------------
# Bank Data / Rekening Principle Endpoints
# ---------------------------

@app.get("/api/bank-data")
def get_bank_data(request: Request):
    """Get all bank/rekening data from Excel master."""
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    bank_map = load_bank_map()
    items = []
    for key, info in bank_map.items():
        items.append({
            "principle": info["principle"],
            "bank": info["bank"],
            "rekening": info["rekening"],
            "penerima": info["penerima"],
            "has_rekening": bool(info["rekening"].strip()),
        })
    return {"ok": True, "items": items, "total": len(items), "source": BANK_DATA_PATH}


@app.get("/api/bank-data/match-report")
def get_bank_data_match_report(request: Request):
    """
    Generate report matching antara nama principle di payments.json vs data rekening Excel.
    Berguna untuk verifikasi sebelum submit SPPD.
    """
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    bank_map = load_bank_map()
    # Kumpulkan semua principle names dari payments DB
    db = load_payments_db()
    web_principles = set()
    for rec_key, r in db.get("lpb", {}).items():
        p = s(r.get("principle", ""))
        if p:
            web_principles.add(p)
    report = generate_import_report(bank_map, list(web_principles))
    return {
        "ok": True,
        "report": report,
        "total_excel_principles": len(bank_map),
        "total_web_principles": len(web_principles),
    }


@app.post("/api/bank-data/upload")
async def upload_bank_data(request: Request, file: UploadFile = File(None)):
    """
    Upload file Excel rekening principle baru. Menggantikan file existing.
    Validasi: harus punya kolom PRINCIPLE, NAMA BANK, NOMOR REKENING, NAMA PENERIMA.
    """
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden: butuh permission payments.view"})
    if file is None:
        return JSONResponse(status_code=400, content={"ok": False, "error": "File Excel belum diupload."})
    try:
        content = await read_upload_file_limited(
            file,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="File Rekening",
        )
        # Validasi kolom
        df = pd.read_excel(io.BytesIO(content), dtype=str)
        cols = {c.strip().upper(): c for c in df.columns}
        required = ["PRINCIPLE", "NAMA BANK", "NOMOR REKENING", "NAMA PENERIMA"]
        missing = [c for c in required if c not in cols]
        if missing:
            # Try header at row 2
            df = pd.read_excel(io.BytesIO(content), header=2, dtype=str)
            cols = {c.strip().upper(): c for c in df.columns}
            missing = [c for c in required if c not in cols]
        if missing:
            return JSONResponse(status_code=400, content={
                "ok": False,
                "error": f"Kolom wajib tidak ditemukan: {', '.join(missing)}. Kolom yang ada: {', '.join(df.columns.tolist())}"
            })
        # Hitung jumlah baris valid
        valid_count = 0
        for _, r in df.iterrows():
            p = s(r[cols["PRINCIPLE"]])
            if p:
                valid_count += 1
        if valid_count == 0:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Tidak ada baris dengan data Principle valid."})
        # Simpan file (overwrite)
        with open(BANK_DATA_PATH, "wb") as f:
            f.write(content)
        # Generate report
        new_bank_map = load_bank_map()
        db = load_payments_db()
        web_principles = set()
        for rec_key, r in db.get("lpb", {}).items():
            p = s(r.get("principle", ""))
            if p:
                web_principles.add(p)
        report = generate_import_report(new_bank_map, list(web_principles))
        append_audit_log(user, "bank_data_upload", "bank_data", {
            "filename": file.filename,
            "total_principles": valid_count,
            "matched": len(report["matched"]),
            "unmatched": len(report["unmatched"]),
            "ambiguous": len(report["ambiguous"]),
        })
        return {
            "ok": True,
            "message": f"File rekening berhasil diupload. {valid_count} principle ditemukan.",
            "total_principles": valid_count,
            "report": report,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": f"Gagal memproses file: {str(e)}"})


@app.get("/api/bank-data/lookup")
def lookup_bank_data(request: Request):
    """
    Lookup rekening untuk satu principle name tertentu (fuzzy match).
    Query param: ?principle=NAMA
    """
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    principle_name = s(request.query_params.get("principle", ""))
    if not principle_name:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Parameter 'principle' wajib diisi."})
    bank_map, norm_keys = load_bank_map_with_normalized_keys()
    info, status = find_best_match(principle_name, bank_map, norm_keys)
    if info:
        return {
            "ok": True,
            "status": status,
            "data": {
                "principle": info["principle"],
                "bank": info["bank"],
                "rekening": info["rekening"],
                "penerima": info["penerima"],
                "has_rekening": bool(info["rekening"].strip()),
            },
        }
    return {"ok": True, "status": status, "data": None, "message": f"Tidak ditemukan rekening untuk '{principle_name}'."}


@app.post("/api/bank-data/replace-principle-name")
async def replace_principle_name(request: Request):
    """
    Replace All: Ganti semua occurrence nama principle lama dengan nama baru di payments.json.
    Body JSON: { "old_name": "...", "new_name": "..." }
    Berguna ketika nama principle di web tidak sesuai data rekening.
    """
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden: butuh permission payments.view"})
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Body JSON tidak valid."})
    old_name = s(payload.get("old_name", ""))
    new_name = s(payload.get("new_name", ""))
    if not old_name:
        return JSONResponse(status_code=400, content={"ok": False, "error": "old_name wajib diisi."})
    if not new_name:
        return JSONResponse(status_code=400, content={"ok": False, "error": "new_name wajib diisi."})
    if old_name == new_name:
        return JSONResponse(status_code=400, content={"ok": False, "error": "old_name dan new_name tidak boleh sama."})

    db = load_payments_db()
    replaced_count = 0
    replaced_keys: List[str] = []
    for rec_key, rec in db.get("lpb", {}).items():
        current = s(rec.get("principle", ""))
        # Case-insensitive comparison for matching
        if current.upper() == old_name.upper():
            rec["principle"] = new_name
            replaced_count += 1
            replaced_keys.append(rec_key)
    if replaced_count > 0:
        save_payments_db(db)
        append_audit_log(user, "replace_principle_name", "lpb", {
            "old_name": old_name,
            "new_name": new_name,
            "count": replaced_count,
            "samples": replaced_keys[:20],
        })
    return {
        "ok": True,
        "replaced": replaced_count,
        "old_name": old_name,
        "new_name": new_name,
        "message": f"Berhasil mengganti {replaced_count} record dari '{old_name}' menjadi '{new_name}'." if replaced_count > 0 else f"Tidak ada record dengan principle '{old_name}'.",
    }


@app.post("/api/bank-data/auto-fix-names")
async def auto_fix_principle_names(request: Request):
    """
    Auto-fix: Untuk semua principle di payments.json yang bisa di-match (non-ambiguous)
    ke data rekening Excel, ganti namanya agar konsisten dengan format Excel.
    Dry-run by default (preview only). Kirim { "confirm": true } untuk eksekusi.
    """
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden: butuh permission payments.view"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    confirm = bool(payload.get("confirm", False))

    bank_map, norm_keys = load_bank_map_with_normalized_keys()
    db = load_payments_db()

    # Collect unique principle names from payments
    name_counts: Dict[str, int] = {}
    for rec_key, rec in db.get("lpb", {}).items():
        p = s(rec.get("principle", ""))
        if p:
            name_counts[p] = name_counts.get(p, 0) + 1

    changes: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []
    already_correct: List[str] = []

    for web_name, count in name_counts.items():
        info, status = find_best_match(web_name, bank_map, norm_keys)
        if status == "matched" and info:
            excel_name = info["principle"]
            if web_name != excel_name:
                changes.append({"old": web_name, "new": excel_name, "count": count})
            else:
                already_correct.append(web_name)
        elif status == "ambiguous":
            skipped.append({"name": web_name, "reason": "ambiguous", "count": str(count)})
        else:
            skipped.append({"name": web_name, "reason": "unmatched", "count": str(count)})

    total_records_affected = sum(c["count"] for c in changes)

    if confirm and changes:
        # Execute the renames
        for change in changes:
            old = change["old"]
            new = change["new"]
            for rec_key, rec in db.get("lpb", {}).items():
                if s(rec.get("principle", "")) == old:
                    rec["principle"] = new
        save_payments_db(db)
        append_audit_log(user, "auto_fix_principle_names", "lpb", {
            "changes": changes,
            "total_records": total_records_affected,
        })

    return {
        "ok": True,
        "executed": confirm and bool(changes),
        "changes": changes,
        "skipped": skipped,
        "already_correct": already_correct,
        "total_records_affected": total_records_affected,
        "message": (
            f"Berhasil mengupdate {total_records_affected} record ({len(changes)} nama principle)."
            if confirm and changes
            else f"Preview: {len(changes)} nama akan diubah ({total_records_affected} record). Kirim confirm=true untuk eksekusi."
        ),
    }


@app.get("/health")
def health():
    return {"status": "ok", "patch": PATCH_VERSION}

@app.get("/dev/dump_context")
def dev_dump_context(token: str, principle_name: str = "Priskila (Default)"):
    if token not in MANUAL_MASTER_CACHE: return {"error": "no token"}
    cache = MANUAL_MASTER_CACHE[token]
    raw_items = cache.get("items", [])
    
    if principle_name and principle_name.strip():
        items = [it for it in raw_items if principle_name.upper() in str(it.get("Nama Barang Principle", "")).upper()]
        if not items:
            items = raw_items 
    else:
        items = raw_items
        
    item_names_cache = set()
    kode_barang_map = {}
    for item in items:
        name = str(item.get("Nama Barang", "")).strip().upper()
        code = str(item.get("Kode Barang", "")).strip()
        if name: item_names_cache.add(name)
        if name not in kode_barang_map: kode_barang_map[name] = []
        if code and code not in kode_barang_map[name]: kode_barang_map[name].append(code)
            
    master_names_context = ""
    for n, kodes in kode_barang_map.items():
        s_kodes = ",".join(kodes)
        for master_item in items:
            nama_barang = str(master_item.get("Nama Barang", "")).strip().upper()
            nama_principle = str(master_item.get("Nama Barang Principle", "")).strip().upper()
            nama_aroma = ""
            for k, v in master_item.items():
                if "aroma" in str(k).lower() or "rasa" in str(k).lower() or "variant" in str(k).lower():
                    nama_aroma = str(v).strip()
                    break
            kelompok_asli = str(master_item.get("kelompok", "")).strip()
            if nama_barang == n:
                master_names_context += f"REF: {nama_principle} - {nama_barang} -> OUTPUT_KELOMPOK: {kelompok_asli} | OUTPUT_VARIANT: {nama_aroma} | OUTPUT_KODE: {s_kodes}\n"
                break
                
    return {"ok": True, "count": len(items), "context": master_names_context}

@app.post("/api/principles/add")
async def add_principle(request: Request, name: str = Form(...), file: UploadFile = File(...)):
    user = get_current_user(request)
    if not user: return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    pid = str(uuid.uuid4())
    safe_name = "".join(c for c in file.filename if c.isalnum() or c in " ._-")
    filename = f"{pid}_{safe_name}"
    filepath = os.path.join(MASTERS_DIR, filename)
    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)
    
    ps = _load_principles()
    ps[pid] = {"name": name, "filename": filename, "uploaded_by": user, "created_at": datetime.date.today().isoformat()}
    _save_principles(ps)
    return {"ok": True, "pid": pid}

@app.post("/api/principles/{pid}/delete")
def delete_principle(request: Request, pid: str):
    user = get_current_user(request)
    if not user: return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    ps = _load_principles()
    if pid in ps:
        filepath = os.path.join(MASTERS_DIR, ps[pid]["filename"])
        if os.path.exists(filepath):
            os.remove(filepath)
        del ps[pid]
        _save_principles(ps)
    return {"ok": True}

@app.post("/api/summary/manual/master/load_principle/{pid}")
def load_principle_master(request: Request, pid: str):
    user = get_current_user(request)
    if not user: return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "summary", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    
    ps = _load_principles()
    if pid not in ps:
        return {"ok": False, "error": "Principle tidak ditemukan."}
        
    filepath = os.path.join(MASTERS_DIR, ps[pid]["filename"])
    if not os.path.exists(filepath):
        return {"ok": False, "error": "File Excel Principle hilang."}
        
    try:
        with open(filepath, "rb") as f:
            file_bytes = f.read()
            
        kelompok_list, variant_map, gramasi_map, items = _parse_master_barang_xlsx(file_bytes)
        k_list = sorted(list(set(str(x.get("kelompok", "")).strip() for x in items if x.get("kelompok"))))
        token = str(uuid.uuid4())
        
        MANUAL_MASTER_CACHE[token] = {
            "expires": time.time() + 7200,
            "items": items,
            "kelompok_list": k_list,
            "variant_map": variant_map,
            "gramasi_map": gramasi_map,
        }
        return {"ok": True, "token": token, "kelompok_list": k_list}
    except Exception as e:
        return {"ok": False, "error": f"Gagal membaca Excel: {str(e)}"}

# --- RESTORED MISSING ROUTES ---

@app.get("/api/job_status/{job_id}")
async def get_job_status(job_id: str, request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    
    job = BACKGROUND_JOBS.get(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"ok": False, "error": "Job not found"})
        
    return JSONResponse(content={"ok": True, "status": job["status"], "result": job.get("result"), "error": job.get("error")})

@app.get("/api/principles")
def get_principles(request: Request):
    user = get_current_user(request)
    if not user: return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    ps = _load_principles()
    return {"ok": True, "principles": ps}

# ---------------------------
# Routers per domain (dipindahkan mekanis dari file ini; lihat routers/*.py)
# ---------------------------
from routers.validator import router as validator_router
from routers.payments import router as payments_router
from routers.sppd import router as sppd_router
from routers.finance import router as finance_router
from routers.summary import router as summary_router
from routers.laporan_harian import router as laporan_harian_router
from routers.master_barang import router as master_barang_router

app.include_router(payments_router)
app.include_router(sppd_router)
app.include_router(finance_router)
app.include_router(validator_router)
app.include_router(summary_router)
app.include_router(laporan_harian_router)
app.include_router(master_barang_router)
