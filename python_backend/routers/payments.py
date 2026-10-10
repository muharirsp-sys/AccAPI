# routers/payments.py — Endpoint payments: /payments/* (data, upload, update, cart, submit, files, dll).
# Dipindahkan mekanis dari main.py tanpa perubahan logic; hanya @app.* diganti @router.*.
from fastapi import APIRouter
import asyncio
import copy

from shared import (
    Any,
    Dict,
    File,
    FileResponse,
    HTMLResponse,
    JSONResponse,
    List,
    MAX_EXCEL_UPLOAD_BYTES,
    ORJSONResponse,
    PAYMENTS_DB_PATH,
    PAYMENTS_FILES_DIR,
    RedirectResponse,
    Request,
    SPPD_TEMPLATE_PATH,
    Tuple,
    UploadFile,
    _PAYMENTS_DB_LOCK,
    _can_access_draft,
    _excel_download_response,
    _normalize_yyyy_mm_dd,
    append_audit_log,
    append_error_log,
    empty_payments_db_preserving_config,
    effective_post_status,
    find_best_match,
    find_lpb_duplicate_key,
    format_idr,
    get_current_user,
    has_submitted_duplicate_payment,
    io,
    is_admin_user,
    load_bank_map_with_normalized_keys,
    load_payments_db,
    looks_like_payments_backup,
    lpb_upload_template_rows,
    make_payment_record_id,
    next_sppd_number,
    normalize_lpb_no,
    normalize_pengajuan_type,
    os,
    is_dry_run,
    lpb_upload_error_message,
    parse_lpb_upload_collect,
    plan_lpb_upload,
    parse_number_id,
    parse_number_strict,
    payment_lock_entry,
    payment_lock_message,
    payment_lock_reason,
    payment_locked_field_changes,
    PAYMENT_LOCK_EXEMPT_FIELDS,
    pd,
    read_upload_file_limited,
    render_sppd_docx,
    resolve_payment_record_key,
    s,
    save_payments_db,
    server_time_to_wita,
    slugify,
    user_has_permission,
    uuid,
    validate_csrf_request,
    wita_now,
    write_invoice_excel,
)

router = APIRouter()


def _already_submitted(rec: Dict[str, Any]) -> bool:
    """Record sudah punya pengajuan aktif (bukan 'Ajukan Ulang') — satu aturan untuk create & submit."""
    return bool(s(rec.get("submission_id", ""))) and s(rec.get("status_pembayaran", "")).lower() != "ajukan ulang"

@router.get("/payments/data")
def payments_data(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    db = load_payments_db()
    rows = []
    for key in sorted(db.get("lpb", {}).keys()):
        r = db["lpb"][key]
        row = dict(r)
        row["record_id"] = key
        row["tipe_pengajuan"] = normalize_pengajuan_type(row.get("tipe_pengajuan", "LPB"))
        row["jenis_dokumen"] = s(row.get("jenis_dokumen", ""))
        row["nomor_dokumen"] = s(row.get("nomor_dokumen", ""))
        if not s(row.get("no_lpb", "")) and row["tipe_pengajuan"] == "LPB":
            row["no_lpb"] = s(key)
        row["nilai_win_display"] = format_idr(float(row.get("nilai_win", 0) or 0.0))
        row["tgl_invoice"] = s(row.get("tgl_invoice", "")) or s(row.get("tgl_inv", ""))
        row["jt_invoice"] = s(row.get("jt_invoice", "")) or s(row.get("tgl_jtempo_pcp", ""))
        row["tgl_pembayaran"] = s(row.get("tgl_pembayaran", "")) or s(row.get("tgl_jtempo_pembayaran", ""))
        row["actual_date"] = s(row.get("actual_date", ""))
        nilai_invoice_raw = row.get("nilai_invoice", row.get("nilai_principle", ""))
        try:
            nilai_invoice_num = parse_number_id(nilai_invoice_raw)
        except Exception:
            nilai_invoice_num = 0.0
        raw_str = s(nilai_invoice_raw)
        empty_invoice = raw_str in ["", "0", "0.0"] or abs(nilai_invoice_num) < 1e-9
        row["nilai_invoice"] = "" if empty_invoice else format_idr(nilai_invoice_num)
        if empty_invoice:
            gap_val = 0.0
            row["gap_nilai"] = 0.0
            row["gap_nilai_display"] = ""
        else:
            try:
                gap_val = float(row.get("gap_nilai", 0) or 0.0)
            except Exception:
                gap_val = 0.0
            if abs(gap_val) < 1e-9:
                try:
                    gap_val = float(row.get("nilai_win", 0) or 0.0) - float(nilai_invoice_num or 0.0)
                except Exception:
                    gap_val = 0.0
            row["gap_nilai"] = gap_val
            row["gap_nilai_display"] = format_idr(gap_val)
        row["status_pembayaran"] = row.get("status_pembayaran", "")
        rows.append(row)
    return ORJSONResponse({"ok": True, "data": rows})

@router.get("/payments/export")
def payments_export(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})

    db = load_payments_db()
    rows: List[Dict[str, Any]] = []
    for key in sorted(db.get("lpb", {}).keys()):
        r = db["lpb"][key]
        nilai_sistem = parse_number_id(r.get("nilai_win", 0))
        nilai_invoice = parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0)))
        potongan = parse_number_id(r.get("potongan", 0))
        if "nilai_pembayaran" in r:
            nilai_pembayaran = parse_number_id(r.get("nilai_pembayaran", 0))
        else:
            nilai_pembayaran = nilai_invoice
        if nilai_pembayaran < 0:
            nilai_pembayaran = 0.0
        if potongan < 0:
            potongan = 0.0
        gap_nilai = parse_number_id(r.get("gap_nilai", nilai_sistem - nilai_invoice))
        rows.append(
            {
                "Record ID": s(key),
                "Tipe Pengajuan": normalize_pengajuan_type(s(r.get("tipe_pengajuan", "LPB"))),
                "No LPB": s(r.get("no_lpb", key)),
                "Principle": s(r.get("principle", "")),
                "Tgl Setor": s(r.get("tgl_setor", "")),
                "Tgl Win": s(r.get("tgl_win", "")),
                "Tgl J.Tempo Win": s(r.get("tgl_jtempo_win", "")),
                "Nilai Sistem": nilai_sistem,
                "Tgl Terima Barang": s(r.get("tgl_terima_barang", "")),
                "Tgl Invoice": s(r.get("tgl_invoice", "")) or s(r.get("tgl_inv", "")),
                "No Invoice": s(r.get("invoice_no", "")) or s(r.get("nomor_dokumen", "")) or s(r.get("no_lpb", "")),
                "Nilai Invoice": nilai_invoice,
                "Potongan": potongan,
                "Nilai Pembayaran": nilai_pembayaran,
                "J.T Invoice": s(r.get("jt_invoice", "")) or s(r.get("tgl_jtempo_pcp", "")),
                "Gap Nilai": gap_nilai,
                "Actual Date": s(r.get("actual_date", "")),
                "Tgl Pembayaran": s(r.get("tgl_pembayaran", "")) or s(r.get("tgl_jtempo_pembayaran", "")),
                "Status Pembayaran": s(r.get("status_pembayaran", "")),
                "Metode Pembayaran": s(r.get("payment_method", "")),
                "Jenis Pembayaran": s(r.get("jenis_pembayaran", "")),
                "Tanggal Pengajuan Pembayaran": _normalize_yyyy_mm_dd(s(r.get("target_payment_date", ""))),
                "Jenis Dokumen": s(r.get("jenis_dokumen", "")),
                "Nomor Dokumen": s(r.get("nomor_dokumen", "")),
                "Keterangan": s(r.get("keterangan", "")),
                "Draft ID": s(r.get("draft_id", "")),
                "Submission ID": s(r.get("submission_id", "")),
                "SPPD No": s(r.get("sppd_no", "")),
                "Submitted At": s(r.get("submitted_at", "")),
                "Submitted By": s(r.get("submitted_by", "")),
                "Created At": s(r.get("created_at", "")),
                "Created By": s(r.get("created_by", "")),
            }
        )

    ts = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_payments_{ts}.xlsx"
    return _excel_download_response(rows, filename, "PAYMENTS")


@router.get("/payments/template")
def payments_template_download(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse("/login")
    if not user_has_permission(user, "payments", "view"):
        return HTMLResponse("Forbidden", status_code=403)
    rows = lpb_upload_template_rows()
    return _excel_download_response(rows, "template_upload_lpb.xlsx", "LPB_TEMPLATE")

@router.post("/payments/upload")
async def payments_upload(request: Request, file: UploadFile = File(None)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    if file is None:
        return JSONResponse(status_code=400, content={"ok": False, "error": "File belum diupload."})
    try:
        content = await read_upload_file_limited(
            file,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="File LPB",
        )
        dry_run = is_dry_run(request)
        preview_df = await asyncio.to_thread(pd.read_excel, io.BytesIO(content), nrows=1)
        preview_cols = {str(c).strip().upper(): c for c in preview_df.columns}
        if looks_like_payments_backup(preview_cols):
            # S6-0e butir 5: restore backup = endpoint sendiri (sppd.edit_settings + pratinjau), bukan efek samping unggah LPB.
            return JSONResponse(status_code=400, content={"ok": False, "error": "Berkas ini backup PAYMENTS, bukan berkas LPB — gunakan Restore backup di Format SPPD."})

        rows, number_errors, date_errors = await asyncio.to_thread(parse_lpb_upload_collect, content)
        invalid_message = lpb_upload_error_message(number_errors, date_errors)
        if not rows and not invalid_message:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Data LPB kosong."})
        now = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
        async with _PAYMENTS_DB_LOCK:
            db = await asyncio.to_thread(load_payments_db)
            # S6-0e butir 4: pratinjau dan eksekusi memakai ringkasan yang SAMA; satu masalah = tidak ada yang ditulis.
            report = plan_lpb_upload(db, rows, number_errors + date_errors)
            error = (invalid_message
                     or (f"No. LPB {report['duplicates'][0]} sudah ada di sistem, gagal upload" if report["duplicates"] else "")
                     or (f"No. LPB {report['duplicates_in_file'][0]} ganda di berkas, gagal upload" if report["duplicates_in_file"] else ""))
            if dry_run:
                return JSONResponse({"ok": True, "dry_run": True, "can_apply": not error, **report, **({"error": error} if error else {})})
            if error:
                return JSONResponse(status_code=400, content={"ok": False, "error": error, **report})
            for r in rows:
                key = normalize_lpb_no(r["no_lpb"])
                nilai_invoice = parse_number_id(r.get("nilai_invoice", 0))
                gap_nilai = parse_number_id(r.get("gap_nilai", 0))
                db["lpb"][key] = {
                    **r,
                    "record_id": key,
                    "tipe_pengajuan": "LPB",
                    "tgl_invoice": s(r.get("tgl_invoice", "")),
                    "jt_invoice": s(r.get("jt_invoice", "")),
                    "tgl_pembayaran": s(r.get("tgl_pembayaran", "")),
                    "actual_date": s(r.get("actual_date", "")),
                    "nilai_invoice": nilai_invoice if nilai_invoice > 0 else "",
                    "gap_nilai": gap_nilai,
                    "invoice_no": s(r.get("invoice_no", "")),
                    "status_pembayaran": "",
                    "payment_method": "",
                    "submitted_at": "",
                    "submitted_by": "",
                    "submission_id": "",
                    "draft_id": "",
                    "potongan": 0.0,
                    "nilai_pembayaran": 0.0,
                    "target_payment_date": "",
                    "jenis_dokumen": s(r.get("jenis_dokumen", "")),
                    "nomor_dokumen": s(r.get("nomor_dokumen", "")),
                    "keterangan": s(r.get("keterangan", "")),
                    "created_at": now,
                    "created_by": user,
                }
            await asyncio.to_thread(save_payments_db, db)
        append_audit_log(user, "payments_upload", "lpb", {"added": len(rows)})
        return JSONResponse({"ok": True, "dry_run": False, "added": len(rows), **report})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    except Exception as e:
        append_error_log("payments_upload", e, {"user": user})
        return JSONResponse(status_code=500, content={"ok": False, "error": "Gagal memproses upload. Silakan coba lagi."})


@router.post("/payments/manual/add")
async def payments_manual_add(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    tipe = normalize_pengajuan_type(payload.get("tipe_pengajuan", "CBD"))
    no_lpb = s(payload.get("no_lpb", ""))
    principle = s(payload.get("principle", ""))
    invoice_no = s(payload.get("invoice_no", ""))
    try:
        nilai_invoice = parse_number_strict(payload.get("nilai_invoice", 0), "Nilai Invoice")
    except ValueError as ne:  # AM-044: "abc" dulu tersimpan 0
        return JSONResponse(status_code=400, content={"ok": False, "error": str(ne)})
    jenis_dokumen = s(payload.get("jenis_dokumen", ""))
    nomor_dokumen = s(payload.get("nomor_dokumen", ""))

    if not principle:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Principle wajib diisi."})
    if nilai_invoice <= 0:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Nilai Invoice wajib > 0."})
    if tipe == "LPB" and not no_lpb:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Tipe LPB wajib isi No. LPB."})
    if tipe == "NON_LPB" and (not jenis_dokumen or not nomor_dokumen):
        return JSONResponse(status_code=400, content={"ok": False, "error": "NON_LPB wajib isi Jenis Dokumen dan Nomor Dokumen."})

    now = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
    async with _PAYMENTS_DB_LOCK:
      db = await asyncio.to_thread(load_payments_db)
      if no_lpb and find_lpb_duplicate_key(db, no_lpb):
          return JSONResponse(status_code=400, content={"ok": False, "error": f"No. LPB {no_lpb} sudah ada di sistem."})
      if no_lpb:
          key = normalize_lpb_no(no_lpb)
          if key in db.get("lpb", {}):
              key = make_payment_record_id(tipe)
      else:
          key = make_payment_record_id(tipe)
      while key in db.get("lpb", {}):
          key = make_payment_record_id(tipe)
      db["lpb"][key] = {
        "record_id": key,
        "tipe_pengajuan": tipe,
        "no_lpb": no_lpb,
        "tgl_setor": "",
        "tgl_win": "",
        "tgl_jtempo_win": "",
        "principle": principle,
        "nilai_win": nilai_invoice,
        "tgl_terima_barang": "",
        "tgl_invoice": "",
        "jt_invoice": "",
        "tgl_pembayaran": "",
        "actual_date": "",
        "nilai_invoice": nilai_invoice,
        "gap_nilai": 0.0,
        "invoice_no": invoice_no,
        "status_pembayaran": "",
        "payment_method": "",
        "submitted_at": "",
        "submitted_by": "",
        "submission_id": "",
        "draft_id": "",
        "potongan": 0.0,
        "nilai_pembayaran": 0.0,
        "target_payment_date": "",
          "jenis_dokumen": jenis_dokumen,
          "nomor_dokumen": nomor_dokumen,
          "created_at": now,
          "created_by": user,
      }
      await asyncio.to_thread(save_payments_db, db)
    append_audit_log(user, "payments_manual_add", "lpb", {"record_id": key, "tipe_pengajuan": tipe})
    return JSONResponse({"ok": True, "record_id": key})

@router.post("/payments/update")
async def payments_update(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "update"):
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
    updated = []
    skipped = []
    locked: List[Dict[str, Any]] = []
    async with _PAYMENTS_DB_LOCK:
        db = await asyncio.to_thread(load_payments_db)
        for item in items:
            if not isinstance(item, dict):
                skipped.append("")
                continue
            row_id = s(item.get("record_id", "")) or s(item.get("id", "")) or s(item.get("no_lpb", ""))
            key = resolve_payment_record_key(db, row_id)
            if not key or key not in db.get("lpb", {}):
                skipped.append(row_id)
                continue
            rec = db["lpb"][key]
            before = copy.deepcopy(rec)
            tipe = normalize_pengajuan_type(item.get("tipe_pengajuan", rec.get("tipe_pengajuan", "LPB")))
            no_lpb = s(item.get("no_lpb", rec.get("no_lpb", "")))
            jenis_dokumen = s(item.get("jenis_dokumen", rec.get("jenis_dokumen", "")))
            nomor_dokumen = s(item.get("nomor_dokumen", rec.get("nomor_dokumen", "")))

            if tipe == "LPB" and not no_lpb:
                return JSONResponse(status_code=400, content={"ok": False, "error": "Tipe LPB wajib isi No. LPB."})
            if tipe == "NON_LPB" and (not jenis_dokumen or not nomor_dokumen):
                return JSONResponse(status_code=400, content={"ok": False, "error": "NON_LPB wajib isi Jenis Dokumen dan Nomor Dokumen."})
            if no_lpb:
                dup_key = find_lpb_duplicate_key(db, no_lpb, exclude_key=key)
                if dup_key:
                    return JSONResponse(status_code=400, content={"ok": False, "error": f"No. LPB {no_lpb} sudah dipakai record lain."})

            changed = False
            rec["record_id"] = key
            if "tipe_pengajuan" in item:
                rec["tipe_pengajuan"] = tipe
                changed = True
            if "no_lpb" in item:
                rec["no_lpb"] = no_lpb
                changed = True
            if "jenis_dokumen" in item:
                rec["jenis_dokumen"] = jenis_dokumen
                changed = True
            if "nomor_dokumen" in item:
                rec["nomor_dokumen"] = nomor_dokumen
                changed = True
            if "tgl_invoice" in item:
                rec["tgl_invoice"] = s(item.get("tgl_invoice", ""))
                changed = True
            if "jt_invoice" in item:
                rec["jt_invoice"] = s(item.get("jt_invoice", ""))
                changed = True
            if "tgl_pembayaran" in item:
                rec["tgl_pembayaran"] = s(item.get("tgl_pembayaran", ""))
                changed = True
            if "actual_date" in item:
                rec["actual_date"] = s(item.get("actual_date", ""))
                changed = True
            if "nilai_invoice" in item:
                try:
                    rec["nilai_invoice"] = parse_number_strict(item.get("nilai_invoice", 0), f"Nilai Invoice {key}")
                except ValueError as ne:  # AM-044; db salinan per request (AM-012) -> tidak ada yang tersimpan
                    return JSONResponse(status_code=400, content={"ok": False, "error": str(ne)})
                changed = True
            if "invoice_no" in item:
                rec["invoice_no"] = s(item.get("invoice_no", ""))
                changed = True
            if "principle" in item:
                rec["principle"] = s(item.get("principle", rec.get("principle", "")))
                changed = True
            if "ajukan" in item:
                rec["ajukan"] = bool(item.get("ajukan"))
                changed = True
            try:
                rec["gap_nilai"] = float(rec.get("nilai_win", 0) or 0.0) - float(rec.get("nilai_invoice", 0) or 0.0)
            except Exception:
                rec["gap_nilai"] = 0.0
            reason = payment_lock_reason(before)
            if reason:
                # BL-05: rekaman terkunci hanya boleh berubah di `ajukan`; nilai yang sama bukan perubahan.
                fields = payment_locked_field_changes(before, rec)
                if fields:
                    locked.append(payment_lock_entry(key, before, reason, fields=fields))
                    continue
                kept = {f: rec[f] for f in PAYMENT_LOCK_EXEMPT_FIELDS if f in rec}
                rec.clear()
                rec.update(before, **kept)
            if changed:
                updated.append(key)
        if locked:
            # Semua-atau-tidak (kontrak yang ada): satu rekaman terkunci = tidak ada yang disimpan.
            return JSONResponse(status_code=409, content={"ok": False, "error": payment_lock_message("Simpan", locked), "locked": locked})
        await asyncio.to_thread(save_payments_db, db)
    append_audit_log(user, "payments_update", "lpb", {"count": len(updated), "samples": updated[:10], "skipped": skipped[:10]})
    return JSONResponse({"ok": True, "updated": len(updated), "updated_ids": updated, "skipped": len(skipped)})

@router.post("/payments/delete")
async def payments_delete(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "delete"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    record_ids = payload.get("record_ids", payload.get("no_lpbs", []))
    if not isinstance(record_ids, list) or not record_ids:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Data belum dipilih."})

    # ponytail: to_thread menambah titik await, jadi read-modify-write ini
    # WAJIB dikunci — pola sama dengan route mutation lain di file ini.
    await _PAYMENTS_DB_LOCK.acquire()
    try:
        db = await asyncio.to_thread(load_payments_db)
        keys = [k for k in (resolve_payment_record_key(db, s(row_id)) for row_id in record_ids) if k in db.get("lpb", {})]
        # BL-05: rekaman Sudah Transfer/terposting tidak dihapus; satu saja = tidak ada yang dihapus.
        locked = [payment_lock_entry(k, db["lpb"][k], r) for k in dict.fromkeys(keys) if (r := payment_lock_reason(db["lpb"][k]))]
        if locked:
            return JSONResponse(status_code=409, content={"ok": False, "error": payment_lock_message("Hapus", locked), "locked": locked})
        deleted = 0
        for key in keys:
            if key in db["lpb"]:
                del db["lpb"][key]
                deleted += 1
        await asyncio.to_thread(save_payments_db, db)
    finally:
        _PAYMENTS_DB_LOCK.release()
    append_audit_log(user, "payments_delete", "lpb", {"count": deleted, "samples": [s(n) for n in record_ids][:10]})
    return JSONResponse({"ok": True, "deleted": deleted})

@router.post("/payments/clear")
async def payments_clear(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    # Review F2: key eksplisit dari izin efektif, bukan role admin (yang mengabaikan group).
    if not user_has_permission(user, "payments", "delete"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden: butuh permission payments.delete untuk clear seluruh data payments."})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if s(payload.get("confirm", "")) != "CLEAR PAYMENTS":
        return JSONResponse(status_code=400, content={"ok": False, "error": "Konfirmasi wajib tepat: CLEAR PAYMENTS"})
    if not PAYMENTS_DB_PATH:
        return JSONResponse(status_code=500, content={"ok": False, "error": "PAYMENTS_DB_PATH belum dikonfigurasi."})

    backup_name = ""
    try:
        async with _PAYMENTS_DB_LOCK:
            db = await asyncio.to_thread(load_payments_db)
            # BL-05: clear tidak boleh menghapus rekaman yang sudah ditransfer/terposting.
            locked = [payment_lock_entry(k, r, why) for k, r in db.get("lpb", {}).items() if (why := payment_lock_reason(r))]
            if locked:
                return JSONResponse(status_code=409, content={
                    "ok": False, "locked_count": len(locked), "locked": locked[:20],
                    "error": f"Clear ditolak: {len(locked)} rekaman sudah ditransfer/terposting dan terkunci. Tidak ada yang dihapus.",
                })
            before_counts = {
                "lpb": len(db.get("lpb", {}) or {}),
                "submissions": len(db.get("submissions", {}) or {}),
                "drafts": len(db.get("drafts", {}) or {}),
                "proofs": len(db.get("proofs", {}) or {}),
            }
            os.makedirs(os.path.dirname(PAYMENTS_DB_PATH), exist_ok=True)
            if os.path.exists(PAYMENTS_DB_PATH):
                ts = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
                backup_path = f"{PAYMENTS_DB_PATH}.backup_before_clear_{ts}"
                import shutil
                await asyncio.to_thread(shutil.copy2, PAYMENTS_DB_PATH, backup_path)
                backup_name = os.path.basename(backup_path)
            await asyncio.to_thread(save_payments_db, empty_payments_db_preserving_config(db))
        append_audit_log(user, "payments_clear_all", "payments", {"backup": backup_name, "before": before_counts})
        return JSONResponse({
            "ok": True,
            "cleared": before_counts,
            "backup_file": backup_name,
            "preserved": ["finance_mappings", "sppd_settings", "sppd_seq"],
        })
    except Exception as e:
        append_error_log("payments_clear", e, {"user": user, "backup": backup_name})
        return JSONResponse(status_code=500, content={"ok": False, "error": "Gagal clear data payments."})

@router.post("/payments/cart/create")
async def payments_cart_create(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    method = s(payload.get("method", ""))
    record_ids = payload.get("record_ids", payload.get("no_lpbs", []))
    target_payment_date = _normalize_yyyy_mm_dd(s(payload.get("target_payment_date", "")))
    if not target_payment_date:
        target_payment_date = (pd.Timestamp.now() + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    if method not in ["NON_PANIN", "BANK_PANIN"]:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Metode pembayaran tidak valid."})
    if not isinstance(record_ids, list) or not record_ids:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Data belum dipilih."})

    async with _PAYMENTS_DB_LOCK:
      db = await asyncio.to_thread(load_payments_db)
      selected = []
      for row_id in record_ids:
          key = resolve_payment_record_key(db, s(row_id))
          rec = db.get("lpb", {}).get(key)
          if rec:
              selected.append({**rec, "record_id": key})
      if not selected:
          return JSONResponse(status_code=400, content={"ok": False, "error": "Data pengajuan tidak ditemukan."})

    for rec in selected:
        tipe = normalize_pengajuan_type(rec.get("tipe_pengajuan", "LPB"))
        no_lpb = s(rec.get("no_lpb", ""))
        principle = s(rec.get("principle", ""))
        tgl_invoice = s(rec.get("tgl_invoice", "")) or s(rec.get("tgl_inv", ""))
        jt_invoice = s(rec.get("jt_invoice", "")) or s(rec.get("tgl_jtempo_pcp", ""))
        invoice_no = s(rec.get("invoice_no", ""))
        jenis_dokumen = s(rec.get("jenis_dokumen", ""))
        nomor_dokumen = s(rec.get("nomor_dokumen", ""))
        nilai_invoice = parse_number_id(rec.get("nilai_invoice", rec.get("nilai_principle", 0)))
        if not principle:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Principle wajib diisi sebelum diajukan."})
        if tipe == "LPB" and not no_lpb:
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Tipe LPB wajib isi No. LPB (record {rec.get('record_id','')})."})
        if tipe == "LPB" and (not tgl_invoice or not jt_invoice):
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Lengkapi tanggal invoice & jatuh tempo invoice untuk LPB {no_lpb or rec.get('record_id','')}."})
        if tipe == "LPB" and not invoice_no:
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Nomor Invoice kosong untuk LPB {no_lpb or rec.get('record_id','')}."})
        if tipe == "CBD" and (not invoice_no and not no_lpb):
            return JSONResponse(status_code=400, content={"ok": False, "error": f"CBD wajib isi No. Invoice atau No. LPB manual untuk principle {principle}."})
        if tipe == "NON_LPB" and (not jenis_dokumen or not nomor_dokumen):
            return JSONResponse(status_code=400, content={"ok": False, "error": f"NON_LPB wajib isi Jenis Dokumen dan Nomor Dokumen untuk principle {principle}."})
        if float(nilai_invoice or 0) <= 0:
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Nilai Invoice kosong untuk principle {principle}."})
        if tipe == "LPB" and has_submitted_duplicate_payment(db, s(rec.get("record_id", "")), rec):
            return JSONResponse(status_code=400, content={"ok": False, "error": f"LPB untuk principle {principle} terindikasi sudah pernah diajukan (kemungkinan case CBD). Cek data finance terlebih dulu."})
        if _already_submitted(rec):
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Record {no_lpb or rec.get('record_id','')} sudah pernah diajukan ke finance."})
        lock = payment_lock_reason(rec)
        if lock:
            # BL-49/BL-05 (S6-0e): "Ajukan Ulang" lama pada rekaman terposting tidak boleh menjadi pengajuan kedua.
            return JSONResponse(status_code=409, content={"ok": False, "error": f"Record {no_lpb or rec.get('record_id','')} {lock}; tidak bisa diajukan ulang."})

    order_keys: List[str] = []
    groups: Dict[str, List[Dict[str, Any]]] = {}
    group_meta: Dict[str, Dict[str, str]] = {}
    for rec in selected:
        pr = s(rec.get("principle", ""))
        tipe = normalize_pengajuan_type(rec.get("tipe_pengajuan", "LPB"))
        gk = f"{pr}||{tipe}"
        if gk not in groups:
            groups[gk] = []
            group_meta[gk] = {"principle": pr, "tipe_pengajuan": tipe}
            order_keys.append(gk)
        groups[gk].append(rec)

    items = []
    idx = 1
    for gk in order_keys:
        recs = groups[gk]
        meta = group_meta[gk]
        inv_list = [s(r.get("invoice_no", "")) for r in recs if s(r.get("invoice_no", ""))]
        ref_docs = [s(r.get("nomor_dokumen", "")) for r in recs if s(r.get("nomor_dokumen", ""))]
        lpb_refs = [s(r.get("no_lpb", "")) for r in recs if s(r.get("no_lpb", ""))]
        total = sum(parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0))) for r in recs)
        refs = inv_list if inv_list else (ref_docs if ref_docs else lpb_refs)
        ref_concat = ", ".join(refs)
        items.append({
            "no": idx,
            "group_key": gk,
            "principle": meta["principle"],
            "tipe_pengajuan": meta["tipe_pengajuan"],
            "total": total,
            "invoice_list": inv_list,
            "invoice_concat": ref_concat,
            "potongan": 0.0,
            "nilai_pembayaran": total,
            "jenis_pembayaran": "",
            "keterangan": "",
        })
        idx += 1

    draft_id = str(uuid.uuid4())[:8]
    now = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
    async with _PAYMENTS_DB_LOCK:
        db2 = await asyncio.to_thread(load_payments_db)
        db2["drafts"][draft_id] = {
            "id": draft_id,
            "created_at": now,
            "created_by": user,
            "method": method,
            "target_payment_date": target_payment_date,
            "record_ids": [s(r.get("record_id", "")) for r in selected],
            "items": items,
        }
        await asyncio.to_thread(save_payments_db, db2)
    append_audit_log(user, "payments_cart_create", "draft", {"draft_id": draft_id, "count": len(selected), "types": sorted({normalize_pengajuan_type(x.get("tipe_pengajuan", "")) for x in selected})})
    return JSONResponse({"ok": True, "draft_id": draft_id})


@router.get("/payments/cart-info")
def payments_cart_data(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    draft_id = s(request.query_params.get("draft", ""))
    db = load_payments_db()
    drafts = db.get("drafts", {})
    draft = drafts.get(draft_id) or drafts.get(draft_id.lower()) or drafts.get(draft_id.upper())
    if not draft or not _can_access_draft(user, draft):
        if is_admin_user(user):
            keys = list(drafts.keys())
            preview = ", ".join(keys[:8])
            msg = f"Draft tidak ditemukan. PATH={PAYMENTS_DB_PATH}. Drafts: {preview}"
            return JSONResponse(status_code=404, content={"ok": False, "error": msg})
        return JSONResponse(status_code=404, content={"ok": False, "error": "Draft tidak ditemukan."})
    items = []
    for it in draft.get("items", []):
        total = float(it.get("total", 0) or 0.0)
        potongan = parse_number_id(it.get("potongan", 0))
        if potongan < 0:
            potongan = 0.0
        if potongan > total:
            potongan = total
        nilai_pembayaran = parse_number_id(it.get("nilai_pembayaran", total - potongan))
        expected_pay = max(total - potongan, 0.0)
        if abs(nilai_pembayaran - expected_pay) > 0.5:
            nilai_pembayaran = expected_pay
        items.append({
            "no": it.get("no", ""),
            "group_key": s(it.get("group_key", "")),
            "principle": it.get("principle", ""),
            "tipe_pengajuan": normalize_pengajuan_type(it.get("tipe_pengajuan", "LPB")),
            "total": total,
            "total_display": format_idr(total),
            "invoice_concat": it.get("invoice_concat", ""),
            "potongan": potongan,
            "potongan_display": format_idr(potongan),
            "nilai_pembayaran": nilai_pembayaran,
            "nilai_pembayaran_display": format_idr(nilai_pembayaran),
            "jenis_pembayaran": it.get("jenis_pembayaran", ""),
            "keterangan": it.get("keterangan", ""),
        })
    method = s(draft.get("method", ""))
    method_label = "Bank Panin" if method == "BANK_PANIN" else ("Non Panin" if method == "NON_PANIN" else "")
    target_payment_date = _normalize_yyyy_mm_dd(s(draft.get("target_payment_date", "")))
    if not target_payment_date:
        target_payment_date = (pd.Timestamp.now() + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    return JSONResponse({
        "ok": True,
        "items": items,
        "method": method,
        "method_label": method_label,
        "target_payment_date": target_payment_date,
    })

@router.post("/payments/cart/submit")
async def payments_cart_submit(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    draft_id = s(payload.get("draft_id", ""))
    items = payload.get("items", [])
    target_payment_date = _normalize_yyyy_mm_dd(s(payload.get("target_payment_date", "")))
    if not draft_id:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Draft tidak valid."})
    if not isinstance(items, list):
        return JSONResponse(status_code=400, content={"ok": False, "error": "Format data tidak valid."})

    # Validasi item_input_map bisa dilakukan sebelum lock (pure CPU, tidak baca DB)
    item_input_map: Dict[str, Dict[str, Any]] = {}
    for it in items:
        group_key = s(it.get("group_key", ""))
        pr = s(it.get("principle", ""))
        jenis = s(it.get("jenis_pembayaran", "")).upper()
        ket = s(it.get("keterangan", ""))
        try:
            potongan = parse_number_strict(it.get("potongan", 0), f"Potongan {pr or group_key}")
        except ValueError as ne:  # AM-044: "abc" dulu menjadi potongan 0
            return JSONResponse(status_code=400, content={"ok": False, "error": str(ne)})
        if not group_key and pr:
            tipe = normalize_pengajuan_type(it.get("tipe_pengajuan", "LPB"))
            group_key = f"{pr}||{tipe}"
        if not group_key:
            continue
        if jenis not in ["TRF", "DF", "VA"]:
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Jenis pembayaran wajib diisi untuk {pr or group_key}."})
        if potongan < 0:
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Potongan tidak boleh minus untuk {pr or group_key}."})
        item_input_map[group_key] = {"jenis_pembayaran": jenis, "keterangan": ket, "potongan": potongan}

    # Lock mulai dari sini — semua read-modify-write dilindungi satu lock
    async with _PAYMENTS_DB_LOCK:
        db = await asyncio.to_thread(load_payments_db)
        draft = db.get("drafts", {}).get(draft_id)
        if not draft or not _can_access_draft(user, draft):
            return JSONResponse(status_code=404, content={"ok": False, "error": "Draft tidak ditemukan."})
        method = s(draft.get("method", ""))
        if method not in ["NON_PANIN", "BANK_PANIN"]:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Metode pembayaran tidak valid."})
        if not target_payment_date:
            target_payment_date = _normalize_yyyy_mm_dd(s(draft.get("target_payment_date", "")))
        if not target_payment_date:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Tanggal pengajuan pembayaran wajib diisi."})

        selected = []
        selected_ids = draft.get("record_ids", draft.get("lpb", []))
        for row_id in selected_ids:
            key = resolve_payment_record_key(db, s(row_id))
            rec = db.get("lpb", {}).get(key)
            if rec:
                selected.append({**rec, "record_id": key})
        if not selected:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Data pengajuan tidak ditemukan."})
        # AM-013: draft tidak me-reserve record; draft lain bisa sudah mengajukan record yang sama.
        taken = [s(r.get("no_lpb", "")) or r["record_id"] for r in selected if _already_submitted(r)]
        if taken:
            return JSONResponse(status_code=409, content={"ok": False, "error": f"Sudah diajukan lewat pengajuan lain: {', '.join(taken)}. Buat draft baru."})

    submission_id = str(uuid.uuid4())[:8]
    # Tanggal terbit SPPD (nomor + dokumen) = WITA (D-05/C10); jejak waktu ledger tetap jam server seperti sebelumnya.
    submit_dt = wita_now()
    now = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for rec in selected:
        pr = s(rec.get("principle", ""))
        tipe = normalize_pengajuan_type(rec.get("tipe_pengajuan", "LPB"))
        gk = f"{pr}||{tipe}"
        groups.setdefault(gk, []).append(rec)

    item_map: Dict[str, Dict[str, Any]] = {}
    for group_key, recs in groups.items():
        principle = s(recs[0].get("principle", ""))
        tipe = normalize_pengajuan_type(recs[0].get("tipe_pengajuan", "LPB"))
        if group_key not in item_input_map:
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Data cart untuk {principle} ({tipe}) tidak lengkap."})
        total_invoice = sum(parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0))) for r in recs)
        info = dict(item_input_map[group_key])
        potongan = float(info.get("potongan", 0.0) or 0.0)
        if potongan > total_invoice:
            return JSONResponse(status_code=400, content={"ok": False, "error": f"Potongan melebihi Nilai Invoice untuk {principle} ({tipe})."})
        info["group_key"] = group_key
        info["principle"] = principle
        info["tipe_pengajuan"] = tipe
        info["total_invoice"] = total_invoice
        info["nilai_pembayaran"] = max(total_invoice - potongan, 0.0)
        item_map[group_key] = info

    files = []
    for group_key, recs in groups.items():
        principle = s(recs[0].get("principle", ""))
        tipe = normalize_pengajuan_type(recs[0].get("tipe_pengajuan", "LPB"))
        inv_list = [s(r.get("invoice_no", "")) for r in recs if s(r.get("invoice_no", ""))]
        doc_list = [s(r.get("nomor_dokumen", "")) for r in recs if s(r.get("nomor_dokumen", ""))]
        lpb_refs = [s(r.get("no_lpb", "")) for r in recs if s(r.get("no_lpb", ""))]
        refs = inv_list if inv_list else (doc_list if doc_list else lpb_refs)
        cart_info = item_map.get(group_key, {})
        total = float(cart_info.get("total_invoice", 0.0) or 0.0)
        potongan = float(cart_info.get("potongan", 0.0) or 0.0)
        nilai_pembayaran = float(cart_info.get("nilai_pembayaran", total) or 0.0)
        rows = [{
            "No": 1,
            "Tipe Pengajuan": tipe,
            "Principle": principle,
            "Nilai Invoice (Total)": total,
            "No. Invoice / Dokumen": ", ".join(refs),
            "Potongan": potongan,
            "Nilai Pembayaran": nilai_pembayaran,
            "Jenis Pembayaran": cart_info.get("jenis_pembayaran", ""),
            "Keterangan": cart_info.get("keterangan", ""),
        }]
        fname = f"invoice_{submission_id}_{slugify(principle)}_{slugify(tipe)}.xlsx"
        out_path = os.path.join(PAYMENTS_FILES_DIR, fname)
        await asyncio.to_thread(write_invoice_excel, rows, out_path)
        files.append({"label": f"Invoice {principle} ({tipe})", "url": f"/payments/files/{fname}"})

    sppd_file = None
    sppd_no = None
    if method == "BANK_PANIN":
        bank_map, norm_keys = load_bank_map_with_normalized_keys()
        transfer_items = []
        total_all = 0.0
        for group_key, recs in groups.items():
            principle = s(recs[0].get("principle", ""))
            info, match_status = find_best_match(principle, bank_map, norm_keys)
            if not info or match_status == "ambiguous":
                return JSONResponse(status_code=400, content={"ok": False, "error": f"Data rekening untuk principle '{principle}' tidak ditemukan. Status: {match_status}"})
            cart_info = item_map.get(group_key, {})
            amount = float(cart_info.get("nilai_pembayaran", 0.0) or 0.0)
            total_all += amount
            transfer_items.append(
                {
                    "principle": info["principle"],
                    "bank": info["bank"],
                    "rekening": info["rekening"],
                    "penerima": info["penerima"],
                    "amount": amount,
                }
            )
        # Nomor SPPD & dokumennya dibuat di dalam write lock di bawah (AM-012).

    payment_alloc_by_lpb: Dict[str, float] = {}
    potongan_alloc_by_lpb: Dict[str, float] = {}
    for group_key, recs in groups.items():
        cart_info = item_map.get(group_key, {})
        total_invoice = float(cart_info.get("total_invoice", 0.0) or 0.0)
        total_pembayaran = float(cart_info.get("nilai_pembayaran", 0.0) or 0.0)
        remain = total_pembayaran
        for idx, rec in enumerate(recs):
            key = s(rec.get("record_id", ""))
            nilai_invoice = parse_number_id(rec.get("nilai_invoice", rec.get("nilai_principle", 0)))
            if idx == len(recs) - 1:
                nilai_bayar = remain
            elif total_invoice <= 0:
                nilai_bayar = 0.0
            else:
                nilai_bayar = total_pembayaran * (nilai_invoice / total_invoice)
                remain -= nilai_bayar
            nilai_bayar = max(0.0, min(float(nilai_invoice or 0.0), float(nilai_bayar or 0.0)))
            payment_alloc_by_lpb[key] = nilai_bayar
            potongan_alloc_by_lpb[key] = max(float(nilai_invoice or 0.0) - nilai_bayar, 0.0)

    # Tulis semua perubahan ke DB di dalam lock
    async with _PAYMENTS_DB_LOCK:
        db = await asyncio.to_thread(load_payments_db)
        # Lock dilepas di antara dua bagian: cek ulang sebelum mengubah apa pun (AM-013).
        taken = [k for k in (s(r.get("record_id", "")) for r in selected) if _already_submitted(db.get("lpb", {}).get(k, {}))]
        if taken:
            return JSONResponse(status_code=409, content={"ok": False, "error": f"Sudah diajukan lewat pengajuan lain: {', '.join(taken)}. Buat draft baru."})
        # BL-49 (S6-0e): rekaman bisa terposting/ditransfer sejak draf dibuat — cek di lock yang sama dengan tulis.
        locked = [payment_lock_entry(k, db["lpb"][k], why) for k in (s(r.get("record_id", "")) for r in selected)
                  if k in db.get("lpb", {}) and (why := payment_lock_reason(db["lpb"][k]))]
        if locked:
            return JSONResponse(status_code=409, content={"ok": False, "error": payment_lock_message("Ajukan", locked), "locked": locked})
        if method == "BANK_PANIN":
            # AM-012: nomor diambil dari ledger yang AKAN disimpan, di dalam lock yang sama.
            # Dulu diambil dari objek bagian lock pertama dan hanya bertahan karena load
            # berbagi objek cache; render gagal kini tidak menghabiskan nomor.
            _, sppd_no, sppd_settings = next_sppd_number(db, submit_dt)
            sppd_file = f"sppd_{submission_id}.docx"
            await asyncio.to_thread(render_sppd_docx, SPPD_TEMPLATE_PATH, os.path.join(PAYMENTS_FILES_DIR, sppd_file),
                                    submit_dt, sppd_no, transfer_items, sppd_settings)
            files.append({"label": "SPPD Bank Panin", "url": f"/payments/files/{sppd_file}"})
        for rec in selected:
            key = s(rec.get("record_id", ""))
            if key in db.get("lpb", {}):
                principle = s(db["lpb"][key].get("principle", ""))
                tipe = normalize_pengajuan_type(db["lpb"][key].get("tipe_pengajuan", "LPB"))
                group_key = f"{principle}||{tipe}"
                cart_info = item_map.get(group_key, {})
                db["lpb"][key]["payment_method"] = "Bank Panin" if method == "BANK_PANIN" else "Non Panin"
                db["lpb"][key]["status_pembayaran"] = "Belum Transfer"
                db["lpb"][key]["submitted_at"] = now
                db["lpb"][key]["submitted_by"] = user
                db["lpb"][key]["submission_id"] = submission_id
                db["lpb"][key]["draft_id"] = draft_id
                db["lpb"][key]["target_payment_date"] = target_payment_date
                db["lpb"][key]["jenis_pembayaran"] = cart_info.get("jenis_pembayaran", "")
                db["lpb"][key]["keterangan"] = cart_info.get("keterangan", "")
                db["lpb"][key]["potongan"] = float(potongan_alloc_by_lpb.get(key, 0.0) or 0.0)
                db["lpb"][key]["nilai_pembayaran"] = float(payment_alloc_by_lpb.get(key, 0.0) or 0.0)
                if sppd_no:
                    db["lpb"][key]["sppd_no"] = sppd_no

        db["submissions"][submission_id] = {
            "id": submission_id,
            "created_at": now,
            "created_by": user,
            "draft_id": draft_id,
            "method": method,
            "target_payment_date": target_payment_date,
            "record_ids": [s(r.get("record_id", "")) for r in selected],
            "files": files,
            "sppd_file": sppd_file,
            "sppd_no": sppd_no,
            "cart_items": item_map,
        }
        if draft_id in db.get("drafts", {}):
            del db["drafts"][draft_id]
        await asyncio.to_thread(save_payments_db, db)
    append_audit_log(
        user,
        "payments_cart_submit",
        "submission",
        {"submission_id": submission_id, "method": method, "count": len(selected)},
    )
    return JSONResponse({"ok": True, "submission_id": submission_id, "files": files})

@router.post("/payments/submit")
async def payments_submit(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    return JSONResponse(status_code=400, content={"ok": False, "error": "Gunakan keranjang dulu sebelum diajukan ke finance."})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    method = s(payload.get("method", ""))
    no_lpbs = payload.get("no_lpbs", [])
    if method not in ["NON_PANIN", "BANK_PANIN"]:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Metode pembayaran tidak valid."})
    if not isinstance(no_lpbs, list) or not no_lpbs:
        return JSONResponse(status_code=400, content={"ok": False, "error": "LPB belum dipilih."})

    # ponytail: to_thread menambah titik await, jadi read-modify-write ini
    # WAJIB dikunci — pola sama dengan route mutation lain di file ini.
    await _PAYMENTS_DB_LOCK.acquire()
    try:
        db = await asyncio.to_thread(load_payments_db)
        selected = []
        for no in no_lpbs:
            key = normalize_lpb_no(s(no))
            rec = db.get("lpb", {}).get(key)
            if rec:
                selected.append(rec)
        if not selected:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Data LPB tidak ditemukan."})

        for rec in selected:
            tgl_invoice = s(rec.get("tgl_invoice", "")) or s(rec.get("tgl_inv", ""))
            jt_invoice = s(rec.get("jt_invoice", "")) or s(rec.get("tgl_jtempo_pcp", ""))
            invoice_no = s(rec.get("invoice_no", ""))
            nilai_invoice = parse_number_id(rec.get("nilai_invoice", rec.get("nilai_principle", 0)))
            if not tgl_invoice or not jt_invoice:
                return JSONResponse(status_code=400, content={"ok": False, "error": f"Lengkapi tanggal invoice & jatuh tempo invoice untuk LPB {rec.get('no_lpb','')}"})
            if not invoice_no:
                return JSONResponse(status_code=400, content={"ok": False, "error": f"Nomor Invoice kosong untuk LPB {rec.get('no_lpb','')}"})
            if float(nilai_invoice or 0) <= 0:
                return JSONResponse(status_code=400, content={"ok": False, "error": f"Nilai Invoice kosong untuk LPB {rec.get('no_lpb','')}"})

        submission_id = str(uuid.uuid4())[:8]
        # Tanggal terbit SPPD (nomor + dokumen) = WITA (D-05/C10); jejak waktu ledger tetap jam server seperti sebelumnya.
        submit_dt = wita_now()
        now = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
        groups: Dict[str, List[Dict[str, Any]]] = {}
        for rec in selected:
            key = s(rec.get("principle", ""))
            groups.setdefault(key, []).append(rec)

        files = []
        for principle, recs in groups.items():
            inv_list = [s(r.get("invoice_no", "")) for r in recs if s(r.get("invoice_no", ""))]
            total = sum(parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0))) for r in recs)
            rows = [{
                "No": 1,
                "Principle": principle,
                "Nilai Invoice (Total)": total,
                "No. Invoice": ", ".join(inv_list),
                "Potongan": 0.0,
                "Nilai Pembayaran": total,
                "Jenis Pembayaran": "NON PANIN" if method == "NON_PANIN" else "BANK PANIN",
                "Keterangan": "",
            }]
            fname = f"invoice_{submission_id}_{slugify(principle)}.xlsx"
            out_path = os.path.join(PAYMENTS_FILES_DIR, fname)
            await asyncio.to_thread(write_invoice_excel, rows, out_path)
            files.append({"label": f"Invoice {principle}", "url": f"/payments/files/{fname}"})

        sppd_file = None
        sppd_no = None
        if method == "BANK_PANIN":
            bank_map, norm_keys = load_bank_map_with_normalized_keys()
            transfer_items = []
            total_all = 0.0
            for principle, recs in groups.items():
                info, match_status = find_best_match(principle, bank_map, norm_keys)
                if not info or match_status == "ambiguous":
                    return JSONResponse(status_code=400, content={"ok": False, "error": f"Data rekening untuk principle '{principle}' tidak ditemukan. Status: {match_status}"})
                amount = sum(parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0))) for r in recs)
                total_all += amount
                transfer_items.append(
                    {
                        "principle": info["principle"],
                        "bank": info["bank"],
                        "rekening": info["rekening"],
                        "penerima": info["penerima"],
                        "amount": amount,
                    }
                )
            _, sppd_no, sppd_settings = next_sppd_number(db, submit_dt)
            sppd_name = f"sppd_{submission_id}.docx"
            sppd_path = os.path.join(PAYMENTS_FILES_DIR, sppd_name)
            render_sppd_docx(SPPD_TEMPLATE_PATH, sppd_path, submit_dt, sppd_no, transfer_items, sppd_settings)
            files.append({"label": "SPPD Bank Panin", "url": f"/payments/files/{sppd_name}"})
            sppd_file = sppd_name

        for rec in selected:
            key = normalize_lpb_no(rec.get("no_lpb", ""))
            if key in db.get("lpb", {}):
                db["lpb"][key]["payment_method"] = "Bank Panin" if method == "BANK_PANIN" else "Non Panin"
                db["lpb"][key]["status_pembayaran"] = "Belum Transfer"
                db["lpb"][key]["submitted_at"] = now
                db["lpb"][key]["submitted_by"] = user
                db["lpb"][key]["submission_id"] = submission_id
                db["lpb"][key]["potongan"] = 0.0
                db["lpb"][key]["nilai_pembayaran"] = parse_number_id(db["lpb"][key].get("nilai_invoice", db["lpb"][key].get("nilai_principle", 0)))
                if sppd_no:
                    db["lpb"][key]["sppd_no"] = sppd_no

        db["submissions"][submission_id] = {
            "id": submission_id,
            "created_at": now,
            "created_by": user,
            "method": method,
            "lpb": [normalize_lpb_no(r.get("no_lpb", "")) for r in selected],
            "files": files,
            "sppd_file": sppd_file,
            "sppd_no": sppd_no,
        }
        await asyncio.to_thread(save_payments_db, db)
    finally:
        _PAYMENTS_DB_LOCK.release()
    append_audit_log(
        user,
        "payments_submit",
        "submission",
        {"submission_id": submission_id, "method": method, "count": len(selected)},
    )
    return JSONResponse({"ok": True, "submission_id": submission_id, "files": files})

@router.get("/payments/files/{file_name}")
def payments_files(request: Request, file_name: str):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    safe_name = os.path.basename(file_name)
    path = os.path.join(PAYMENTS_FILES_DIR, safe_name)
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={"detail": "File not found"})
    return FileResponse(path, filename=safe_name)


# ---------------------------------------------------------------------------------------------------------------
# BL-50 (S6-0e): Pengajuan & SPPD bisa dibuka ulang — BACA-SAJA. Berkas diunduh lewat /payments/files/{nama}.
# ---------------------------------------------------------------------------------------------------------------
_SUBMISSION_STATUS_LABEL = {
    "kosong": "Tanpa rekaman",
    "tidak_pasti": "Posting tidak pasti",
    "terposting": "Semua terposting",
    "dikembalikan": "Ada yang dikembalikan Finance",
    "ditransfer": "Semua ditransfer",
    "sebagian": "Sebagian ditransfer",
    "menunggu_transfer": "Menunggu transfer",
}


def _submission_files(sub: Dict[str, Any]) -> List[Dict[str, str]]:
    """Berkas yang BENAR-BENAR ada di PAYMENTS_FILES_DIR (restore backup membuat files=[] -> kosong, bukan tebakan)."""
    out: List[Dict[str, str]] = []
    seen = set()
    listed = [(s(f.get("label", "")), s(f.get("url", ""))) for f in (sub.get("files") or []) if isinstance(f, dict)]
    if s(sub.get("sppd_file", "")):
        listed.append(("SPPD Bank Panin", s(sub.get("sppd_file", ""))))
    for label, ref in listed:
        name = os.path.basename(ref)
        if not name or name in seen or not os.path.isfile(os.path.join(PAYMENTS_FILES_DIR, name)):
            continue
        seen.add(name)
        out.append({"label": label or name, "name": name, "url": f"/payments/files/{name}"})
    return out


def _submission_summary(sid: str, sub: Dict[str, Any], recs: List[Tuple[str, Dict[str, Any]]]) -> Dict[str, Any]:
    method = s(sub.get("method", ""))
    transfer: Dict[str, int] = {}
    posting: Dict[str, int] = {}
    for _, r in recs:
        st = s(r.get("status_pembayaran", "")) or "Belum diajukan"
        transfer[st] = transfer.get(st, 0) + 1
        post = effective_post_status(r) or "belum"
        posting[post] = posting.get(post, 0) + 1
    n = len(recs)
    if not n:
        status = "kosong"
    elif posting.get("unknown"):
        status = "tidak_pasti"
    elif posting.get("posted") == n:
        status = "terposting"
    elif transfer.get("Ajukan Ulang"):
        status = "dikembalikan"
    elif transfer.get("Sudah Transfer") == n:
        status = "ditransfer"
    elif transfer.get("Sudah Transfer"):
        status = "sebagian"
    else:
        status = "menunggu_transfer"
    created_at = s(sub.get("created_at", ""))
    return {
        "id": sid,
        "sppd_no": s(sub.get("sppd_no", "")) or next((s(r.get("sppd_no", "")) for _, r in recs if s(r.get("sppd_no", ""))), ""),
        "created_at": created_at,
        "created_at_wita": server_time_to_wita(created_at),
        "created_by": s(sub.get("created_by", "")),
        "target_payment_date": _normalize_yyyy_mm_dd(s(sub.get("target_payment_date", ""))),
        "method": method,
        # Rute Panin = SPPD (Surat Perintah Penarikan Dana, templat Bank Panin); Non Panin tanpa SPPD.
        "route_label": "Bank Panin (SPPD)" if method == "BANK_PANIN" else ("Non Panin" if method == "NON_PANIN" else method),
        "record_count": n,
        "principles": sorted({s(r.get("principle", "")) for _, r in recs if s(r.get("principle", ""))}),
        "total_invoice": sum(parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0))) for _, r in recs),
        "total_potongan": sum(parse_number_id(r.get("potongan", 0)) for _, r in recs),
        "total_pembayaran": sum(parse_number_id(r.get("nilai_pembayaran", 0)) for _, r in recs),
        "transfer": transfer,
        "posting": posting,
        "status": status,
        "status_label": _SUBMISSION_STATUS_LABEL[status],
        "files": _submission_files(sub),
    }


def _submissions_index(db: Dict[str, Any]) -> Dict[str, Tuple[Dict[str, Any], List[Tuple[str, Dict[str, Any]]]]]:
    """Pengajuan dari db["submissions"] DIGABUNG dengan submission_id di rekaman (data lama tanpa entri pengajuan)."""
    recs_by_sid: Dict[str, List[Tuple[str, Dict[str, Any]]]] = {}
    for key, r in db.get("lpb", {}).items():
        sid = s(r.get("submission_id", ""))
        if sid:
            recs_by_sid.setdefault(sid, []).append((s(key), r))
    subs = db.get("submissions", {}) if isinstance(db.get("submissions"), dict) else {}
    out = {}
    for sid in set(subs) | set(recs_by_sid):
        recs = recs_by_sid.get(sid, [])
        sub = subs.get(sid)
        if not isinstance(sub, dict):
            first = recs[0][1]
            sub = {"created_at": s(first.get("submitted_at", "")), "created_by": s(first.get("submitted_by", "")),
                   "target_payment_date": s(first.get("target_payment_date", "")), "files": [], "sppd_file": "",
                   "method": "BANK_PANIN" if s(first.get("payment_method", "")).lower() == "bank panin" else "NON_PANIN"}
        out[s(sid)] = (sub, recs)
    return out


@router.get("/payments/submissions")
def payments_submissions(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    db = load_payments_db()
    rows = [_submission_summary(sid, sub, recs) for sid, (sub, recs) in _submissions_index(db).items()]
    rows.sort(key=lambda x: (x["created_at"], x["id"]), reverse=True)
    return JSONResponse({"ok": True, "data": rows})


@router.get("/payments/submissions/{submission_id}")
def payments_submission_detail(request: Request, submission_id: str):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "payments", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    db = load_payments_db()
    found = _submissions_index(db).get(s(submission_id))
    if not found:
        return JSONResponse(status_code=404, content={"ok": False, "error": "Pengajuan tidak ditemukan."})
    sub, recs = found
    records = [{
        "record_id": key,
        "no_lpb": s(r.get("no_lpb", "")),
        "tipe_pengajuan": normalize_pengajuan_type(r.get("tipe_pengajuan", "LPB")),
        "principle": s(r.get("principle", "")),
        "invoice_no": s(r.get("invoice_no", "")) or s(r.get("nomor_dokumen", "")),
        "nilai_invoice": parse_number_id(r.get("nilai_invoice", r.get("nilai_principle", 0))),
        "potongan": parse_number_id(r.get("potongan", 0)),
        "nilai_pembayaran": parse_number_id(r.get("nilai_pembayaran", 0)),
        "jenis_pembayaran": s(r.get("jenis_pembayaran", "")),
        "status_pembayaran": s(r.get("status_pembayaran", "")),
        "transfer_date": s(r.get("transfer_date", "")),
        "accurate_post_status": effective_post_status(r),
        "accurate_purchase_payment_number": s(r.get("accurate_purchase_payment_number", "")),
        "locked_reason": payment_lock_reason(r),
    } for key, r in sorted(recs, key=lambda kv: kv[0])]
    cart_items = sub.get("cart_items") if isinstance(sub.get("cart_items"), dict) else {}
    return JSONResponse({"ok": True, "data": {**_submission_summary(s(submission_id), sub, recs), "records": records, "cart_items": cart_items}})
