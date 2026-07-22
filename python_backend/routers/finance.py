# routers/finance.py — Endpoint finance: /payments/finance/* dan /payments/proofs/*.
# Dipindahkan mekanis dari main.py tanpa perubahan logic; hanya @app.* diganti @router.*.
from fastapi import APIRouter

from shared import (
    Any,
    Dict,
    File,
    FileResponse,
    JSONResponse,
    List,
    MAX_PROOF_UPLOAD_BYTES,
    PAYMENTS_PROOFS_DIR,
    Request,
    UploadFile,
    _excel_download_response,
    _normalize_yyyy_mm_dd,
    append_audit_log,
    append_error_log,
    build_proof_metadata,
    finance_mapping_key,
    format_idr,
    get_current_user,
    get_finance_mapping,
    load_payments_db,
    normalize_lpb_no,
    normalize_pengajuan_type,
    os,
    parse_number_id,
    pd,
    read_upload_file_limited,
    s,
    safe_upload_filename,
    save_payments_db,
    user_has_permission,
    uuid,
    validate_csrf_request,
)

router = APIRouter()

@router.get("/payments/finance/data")
def payments_finance_data(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "finance", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    date_filter = s(request.query_params.get("date", ""))
    if not date_filter:
        date_filter = pd.Timestamp.today().strftime("%Y-%m-%d")
    db = load_payments_db()
    groups: Dict[str, Dict[str, Any]] = {}
    total_all = 0.0
    for rec_key, r in db.get("lpb", {}).items():
        submitted_at = s(r.get("submitted_at", ""))
        if not submitted_at:
            continue
        target_payment_date = _normalize_yyyy_mm_dd(s(r.get("target_payment_date", "")))
        if not target_payment_date:
            target_payment_date = _normalize_yyyy_mm_dd(submitted_at.split(" ")[0])
        if date_filter and target_payment_date != date_filter:
            continue
        principle = s(r.get("principle", "")) or "-"
        tipe_pengajuan = normalize_pengajuan_type(r.get("tipe_pengajuan", "LPB"))
        submission_id = s(r.get("submission_id", ""))
        draft_id = s(r.get("draft_id", ""))
        group_ref = draft_id or submission_id or submitted_at or "-"
        group_key = f"{principle}||{tipe_pengajuan}||{group_ref}"
        nilai_invoice = parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0)))
        if "nilai_pembayaran" in r:
            amount = parse_number_id(r.get("nilai_pembayaran", 0))
        else:
            amount = nilai_invoice
        if amount < 0:
            amount = 0.0
        if "potongan" in r:
            potongan = parse_number_id(r.get("potongan", 0))
        else:
            potongan = max(nilai_invoice - amount, 0.0)
        if potongan < 0:
            potongan = 0.0
        total_all += amount
        g = groups.setdefault(group_key, {
            "principle": principle,
            "tipe_pengajuan": tipe_pengajuan,
            "submission_id": submission_id,
            "draft_id": draft_id,
            "total_nilai": 0.0,
            "total_invoice": 0.0,
            "total_potongan": 0.0,
            "methods": set(),
            "statuses": [],
            "invoice_list": [],
            "detail_invoices": [],
            "jenis_pembayaran": "",
            "keterangan": "",
            "sppd_no": "",
            "transfer_date": "",
            "transfer_proof": {},
            "accurate_post_status": "",
            "accurate_post_error": "",
            "accurate_purchase_payment_number": "",
            "accurate_purchase_payment_id": "",
            "submitted_date": target_payment_date,
        })
        g["total_nilai"] += amount
        g["total_invoice"] += nilai_invoice
        g["total_potongan"] += potongan
        pm = s(r.get("payment_method", ""))
        if pm:
            g["methods"].add(pm)
        st = s(r.get("status_pembayaran", ""))
        if st:
            g["statuses"].append(st)
        inv_no = s(r.get("invoice_no", ""))
        if not inv_no:
            inv_no = s(r.get("nomor_dokumen", ""))
        if not inv_no:
            inv_no = s(r.get("no_lpb", ""))
        if inv_no:
            g["invoice_list"].append(inv_no)
        g["detail_invoices"].append({
            "record_id": s(rec_key),
            "invoiceNo": inv_no,
            "paymentAmount": amount,
            "paymentAmountDisplay": format_idr(amount),
        })
        if not g["jenis_pembayaran"]:
            g["jenis_pembayaran"] = s(r.get("jenis_pembayaran", ""))
        if not g["keterangan"]:
            g["keterangan"] = s(r.get("keterangan", ""))
        if not g["sppd_no"]:
            g["sppd_no"] = s(r.get("sppd_no", ""))
        if not g["transfer_date"]:
            g["transfer_date"] = s(r.get("transfer_date", ""))
        if not g["transfer_proof"] and isinstance(r.get("transfer_proof"), dict):
            g["transfer_proof"] = r.get("transfer_proof", {})
        if not g["accurate_post_status"]:
            g["accurate_post_status"] = s(r.get("accurate_post_status", ""))
        if not g["accurate_post_error"]:
            g["accurate_post_error"] = s(r.get("accurate_post_error", ""))
        if not g["accurate_purchase_payment_number"]:
            g["accurate_purchase_payment_number"] = s(r.get("accurate_purchase_payment_number", ""))
        if not g["accurate_purchase_payment_id"]:
            g["accurate_purchase_payment_id"] = s(r.get("accurate_purchase_payment_id", ""))

    def pick_status(statuses: List[str]) -> str:
        lower = [s(x).lower() for x in statuses if s(x)]
        if any("ajukan ulang" in x for x in lower):
            return "Ajukan Ulang"
        if any("belum" in x for x in lower):
            return "Belum Transfer"
        if any("sudah" in x for x in lower):
            return "Sudah Transfer"
        return "Belum Transfer"

    rows = []
    ordered_groups = sorted(
        groups.values(),
        key=lambda x: (
            s(x.get("submitted_date", "")),
            s(x.get("draft_id", "")),
            s(x.get("submission_id", "")),
            s(x.get("tipe_pengajuan", "")),
            s(x.get("principle", "")),
        ),
    )
    for g in ordered_groups:
        pr = s(g.get("principle", "")) or "-"
        tipe_pengajuan = normalize_pengajuan_type(g.get("tipe_pengajuan", "LPB"))
        mapping = get_finance_mapping(db, pr)
        methods = list(g["methods"])
        method_val = methods[0] if len(methods) == 1 else ("Mixed" if methods else "")
        status_val = pick_status(g["statuses"])
        draft_label = s(g.get("draft_id", "")) or (f"SUB-{s(g.get('submission_id', ''))}" if s(g.get("submission_id", "")) else "-")
        rows.append({
            "principle": pr,
            "tipe_pengajuan": tipe_pengajuan,
            "submission_id": s(g.get("submission_id", "")),
            "draft_id": s(g.get("draft_id", "")),
            "draft_label": draft_label,
            "total_nilai": g["total_nilai"],
            "total_nilai_display": format_idr(g["total_nilai"]),
            "total_invoice": g["total_invoice"],
            "total_invoice_display": format_idr(g["total_invoice"]),
            "total_potongan": g["total_potongan"],
            "total_potongan_display": format_idr(g["total_potongan"]),
            "invoice_concat": ", ".join(g.get("invoice_list", [])),
            "detail_invoices": g.get("detail_invoices", []),
            "jenis_pembayaran": g.get("jenis_pembayaran", ""),
            "keterangan": g.get("keterangan", ""),
            "sppd_no": g.get("sppd_no", ""),
            "transfer_date": g.get("transfer_date", ""),
            "transfer_proof": g.get("transfer_proof", {}),
            "accurate_post_status": g.get("accurate_post_status", ""),
            "accurate_post_error": g.get("accurate_post_error", ""),
            "accurate_purchase_payment_number": g.get("accurate_purchase_payment_number", ""),
            "accurate_purchase_payment_id": g.get("accurate_purchase_payment_id", ""),
            "mapping": mapping,
            "payment_method": method_val,
            "status_pembayaran": status_val,
            "submitted_date": g["submitted_date"],
        })

    return JSONResponse({"ok": True, "data": rows, "total_all": total_all, "total_all_display": format_idr(total_all), "date": date_filter})

@router.get("/payments/finance/export")
def payments_finance_export(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "finance", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})

    from_q = s(request.query_params.get("from", ""))
    to_q = s(request.query_params.get("to", ""))
    from_date = _normalize_yyyy_mm_dd(from_q) if from_q else ""
    to_date = _normalize_yyyy_mm_dd(to_q) if to_q else ""
    if from_q and not from_date:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Format tanggal 'from' tidak valid (YYYY-MM-DD)."})
    if to_q and not to_date:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Format tanggal 'to' tidak valid (YYYY-MM-DD)."})
    if from_date and to_date and from_date > to_date:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Tanggal 'from' tidak boleh lebih besar dari 'to'."})

    db = load_payments_db()
    rows: List[Dict[str, Any]] = []
    for key in sorted(db.get("lpb", {}).keys()):
        r = db["lpb"][key]
        submitted_at = s(r.get("submitted_at", ""))
        if not submitted_at:
            continue
        target_payment_date = _normalize_yyyy_mm_dd(s(r.get("target_payment_date", "")))
        if not target_payment_date:
            target_payment_date = _normalize_yyyy_mm_dd(submitted_at.split(" ")[0])
        if from_date and (not target_payment_date or target_payment_date < from_date):
            continue
        if to_date and (not target_payment_date or target_payment_date > to_date):
            continue

        nilai_invoice = parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0)))
        if "nilai_pembayaran" in r:
            nilai_pembayaran = parse_number_id(r.get("nilai_pembayaran", 0))
        else:
            nilai_pembayaran = nilai_invoice
        if nilai_pembayaran < 0:
            nilai_pembayaran = 0.0
        if "potongan" in r:
            potongan = parse_number_id(r.get("potongan", 0))
        else:
            potongan = max(nilai_invoice - nilai_pembayaran, 0.0)
        if potongan < 0:
            potongan = 0.0

        rows.append(
            {
                "Tanggal Pengajuan Pembayaran": target_payment_date,
                "Waktu Submit Sistem": submitted_at,
                "Draft ID": s(r.get("draft_id", "")),
                "Submission ID": s(r.get("submission_id", "")),
                "Tipe Pengajuan": normalize_pengajuan_type(r.get("tipe_pengajuan", "LPB")),
                "No LPB": s(r.get("no_lpb", key)),
                "Principle": s(r.get("principle", "")),
                "No Invoice": s(r.get("invoice_no", "")) or s(r.get("nomor_dokumen", "")) or s(r.get("no_lpb", "")),
                "Jenis Dokumen": s(r.get("jenis_dokumen", "")),
                "Nomor Dokumen": s(r.get("nomor_dokumen", "")),
                "Nilai Invoice": nilai_invoice,
                "Potongan": potongan,
                "Nilai Pembayaran": nilai_pembayaran,
                "Status Pembayaran": s(r.get("status_pembayaran", "")),
                "Metode Pembayaran": s(r.get("payment_method", "")),
                "Jenis Pembayaran": s(r.get("jenis_pembayaran", "")),
                "Keterangan": s(r.get("keterangan", "")),
                "SPPD No": s(r.get("sppd_no", "")),
                "Tgl Setor": s(r.get("tgl_setor", "")),
                "Tgl Win": s(r.get("tgl_win", "")),
                "Tgl J.Tempo Win": s(r.get("tgl_jtempo_win", "")),
                "Tgl Terima Barang": s(r.get("tgl_terima_barang", "")),
                "Tgl Invoice": s(r.get("tgl_invoice", "")) or s(r.get("tgl_inv", "")),
                "J.T Invoice": s(r.get("jt_invoice", "")) or s(r.get("tgl_jtempo_pcp", "")),
                "Actual Date": s(r.get("actual_date", "")),
                "Tgl Pembayaran": s(r.get("tgl_pembayaran", "")) or s(r.get("tgl_jtempo_pembayaran", "")),
                "Submitted By": s(r.get("submitted_by", "")),
            }
        )

    rows.sort(
        key=lambda x: (
            s(x.get("Tanggal Pengajuan Pembayaran", "")),
            s(x.get("Draft ID", "")),
            s(x.get("Submission ID", "")),
            s(x.get("Tipe Pengajuan", "")),
            s(x.get("Principle", "")),
            s(x.get("No LPB", "")),
        )
    )
    ts = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
    suffix_from = from_date or "ALL"
    suffix_to = to_date or "ALL"
    filename = f"backup_finance_{suffix_from}_to_{suffix_to}_{ts}.xlsx"
    return _excel_download_response(rows, filename, "FINANCE")

@router.get("/payments/proofs/{file_name}")
def payments_proof_file(request: Request, file_name: str):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not (user_has_permission(user, "finance", "view") or user_has_permission(user, "payments", "view")):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    safe_name = os.path.basename(file_name)
    path = os.path.join(PAYMENTS_PROOFS_DIR, safe_name)
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={"ok": False, "error": "Bukti transfer tidak ditemukan."})
    return FileResponse(path, filename=safe_name)

@router.get("/payments/finance/mappings")
def payments_finance_mappings(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "finance", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    db = load_payments_db()
    mappings = db.get("finance_mappings", {})
    return JSONResponse({"ok": True, "data": list(mappings.values()) if isinstance(mappings, dict) else []})

@router.post("/payments/finance/mapping")
async def payments_finance_mapping_save(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "finance", "update"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    principle = s(payload.get("principle", ""))
    vendor_no = s(payload.get("vendorNo", ""))
    bank_no = s(payload.get("bankNo", ""))
    if not principle:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Principle wajib diisi."})
    if not vendor_no or not bank_no:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Vendor No dan Bank No Accurate wajib diisi."})
    db = load_payments_db()
    mapping = {
        "principle": principle,
        "vendorNo": vendor_no,
        "vendorName": s(payload.get("vendorName", "")),
        "bankNo": bank_no,
        "bankName": s(payload.get("bankName", "")),
        "updated_at": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S"),
        "updated_by": user,
    }
    db.setdefault("finance_mappings", {})[finance_mapping_key(principle)] = mapping
    save_payments_db(db)
    append_audit_log(user, "payments_finance_mapping_save", "finance_mapping", {"principle": principle, "vendorNo": vendor_no, "bankNo": bank_no})
    return JSONResponse({"ok": True, "mapping": mapping})

@router.post("/payments/finance/proof")
async def payments_finance_proof_upload(request: Request, file: UploadFile = File(None)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "finance", "update"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    if file is None:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Bukti transfer wajib diupload."})
    try:
        content = await read_upload_file_limited(
            file,
            max_bytes=MAX_PROOF_UPLOAD_BYTES,
            allowed_exts=(".pdf", ".jpg", ".jpeg", ".png"),
            label="Bukti Transfer",
        )
        original_name = safe_upload_filename(file.filename or "bukti-transfer")
        ext = os.path.splitext(original_name)[1].lower()
        proof_id = str(uuid.uuid4())[:12]
        stored_name = f"proof_{pd.Timestamp.now().strftime('%Y%m%d_%H%M%S')}_{proof_id}{ext}"
        os.makedirs(PAYMENTS_PROOFS_DIR, exist_ok=True)
        out_path = os.path.join(PAYMENTS_PROOFS_DIR, stored_name)
        with open(out_path, "wb") as f:
            f.write(content)
        meta = build_proof_metadata(proof_id, stored_name, original_name, content, user)
        db = load_payments_db()
        db.setdefault("proofs", {})[proof_id] = meta
        save_payments_db(db)
        append_audit_log(user, "payments_finance_proof_upload", "proof", {"proof_id": proof_id, "stored_filename": stored_name, "size": len(content)})
        return JSONResponse({"ok": True, "proof": meta})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    except Exception as e:
        append_error_log("payments_finance_proof_upload", e, {"user": user})
        return JSONResponse(status_code=500, content={"ok": False, "error": "Gagal menyimpan bukti transfer."})

@router.post("/payments/finance/update")
async def payments_finance_update(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "finance", "update"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    items = payload.get("items", [])
    if not isinstance(items, list):
        return JSONResponse(status_code=400, content={"ok": False, "error": "Format data tidak valid."})
    if not items:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Data finance yang akan diupdate tidak boleh kosong."})
    db = load_payments_db()
    updated_count = 0
    for item in items:
        no = normalize_lpb_no(s(item.get("no_lpb", "")))
        status = s(item.get("status_pembayaran", ""))
        principle = s(item.get("principle", "")).upper()
        tipe_pengajuan = normalize_pengajuan_type(item.get("tipe_pengajuan", ""))
        date_filter = s(item.get("date", ""))
        submission_id = s(item.get("submission_id", ""))
        draft_id = s(item.get("draft_id", ""))
        if status not in ["Belum Transfer", "Sudah Transfer", "Ajukan Ulang"]:
            continue
        transfer_date = _normalize_yyyy_mm_dd(s(item.get("transfer_date", "")))
        proof_id = s(item.get("proof_id", ""))
        proof_meta = db.get("proofs", {}).get(proof_id, {}) if proof_id else {}
        accurate_post_status = s(item.get("accurate_post_status", ""))
        if accurate_post_status not in ["", "posted", "failed", "skipped"]:
            accurate_post_status = "failed"
        if status == "Sudah Transfer":
            if not transfer_date:
                return JSONResponse(status_code=400, content={"ok": False, "error": "Tanggal transfer wajib diisi untuk status Sudah Transfer."})
            if not proof_id or not isinstance(proof_meta, dict) or not proof_meta:
                return JSONResponse(status_code=400, content={"ok": False, "error": "Bukti transfer wajib diupload sebelum status Sudah Transfer."})

        def apply_finance_update(rec: Dict[str, Any]) -> None:
            nonlocal updated_count
            rec["status_pembayaran"] = status
            if status == "Sudah Transfer":
                rec["transfer_date"] = transfer_date
                rec["proof_id"] = proof_id
                rec["transfer_proof"] = proof_meta
                rec["accurate_post_status"] = accurate_post_status or "skipped"
                rec["accurate_post_error"] = s(item.get("accurate_post_error", ""))
                rec["accurate_purchase_payment_number"] = s(item.get("accurate_purchase_payment_number", ""))
                rec["accurate_purchase_payment_id"] = s(item.get("accurate_purchase_payment_id", ""))
                rec["accurate_post_response"] = item.get("accurate_post_response", {})
                rec["accurate_payload_digest"] = s(item.get("accurate_payload_digest", ""))
                rec["accurate_posted_at"] = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S") if rec["accurate_post_status"] == "posted" else s(rec.get("accurate_posted_at", ""))
                rec["accurate_posted_by"] = user if rec["accurate_post_status"] == "posted" else s(rec.get("accurate_posted_by", ""))
            updated_count += 1

        if no and no in db.get("lpb", {}):
            apply_finance_update(db["lpb"][no])
            continue
        if principle:
            for k, r in db.get("lpb", {}).items():
                submitted_at = s(r.get("submitted_at", ""))
                submitted_date = _normalize_yyyy_mm_dd(submitted_at.split(" ")[0]) if submitted_at else ""
                target_date = _normalize_yyyy_mm_dd(s(r.get("target_payment_date", ""))) or submitted_date
                if date_filter and target_date != date_filter:
                    continue
                if submission_id and s(r.get("submission_id", "")) != submission_id:
                    continue
                if draft_id and s(r.get("draft_id", "")) != draft_id:
                    continue
                if tipe_pengajuan and normalize_pengajuan_type(r.get("tipe_pengajuan", "LPB")) != tipe_pengajuan:
                    continue
                if s(r.get("principle", "")).upper() == principle:
                    apply_finance_update(db["lpb"][k])
    if updated_count <= 0:
        return JSONResponse(status_code=404, content={"ok": False, "error": "Tidak ada data finance yang cocok untuk diupdate."})
    save_payments_db(db)
    append_audit_log(user, "payments_finance_update", "lpb", {"count": updated_count, "items": len(items)})
    return JSONResponse({"ok": True, "updated": updated_count})

