# routers/sppd.py — Endpoint SPPD: /payments/sppd/* (upload excel + settings).
# Dipindahkan mekanis dari main.py tanpa perubahan logic; hanya @app.* diganti @router.*.
from fastapi import APIRouter

from shared import (
    _PAYMENTS_DB_LOCK,
    File,
    JSONResponse,
    MAX_EXCEL_UPLOAD_BYTES,
    Request,
    SPPD_TEMPLATE_PATH,
    UploadFile,
    _normalize_yyyy_mm_dd,
    append_audit_log,
    apply_sppd_excel_rows,
    payment_lock_message,
    append_error_log,
    format_sppd_number_with_template,
    get_current_user,
    get_sppd_settings,
    is_dry_run,
    load_payments_db,
    normalize_sppd_settings,
    parse_sppd_excel_rows,
    pd,
    read_upload_file_limited,
    s,
    save_payments_db,
    sppd_last_sequence_for_year,
    user_has_permission,
    validate_csrf_request,
    wita_now,
)

router = APIRouter()

@router.post("/payments/sppd/upload")
async def payments_sppd_upload(request: Request, file: UploadFile = File(None)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "sppd", "upload_excel"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    if file is None:
        return JSONResponse(status_code=400, content={"ok": False, "error": "File Excel belum diupload."})
    try:
        content = await read_upload_file_limited(
            file,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="File SPPD",
        )
        rows, ignored_columns, blocked_columns = parse_sppd_excel_rows(content)
        if not rows:
            return JSONResponse(status_code=400, content={"ok": False, "error": "Tidak ada baris valid untuk diupdate."})
        # AM-012: satu lock untuk semua penulis ledger (salinan per request -> tanpa lock = lost update).
        async with _PAYMENTS_DB_LOCK:
            db = load_payments_db()
            # S6-0e: satu jalur untuk pratinjau dan eksekusi; BL-05 baris rekaman terkunci = seluruh unggahan ditolak.
            report = apply_sppd_excel_rows(db, rows)
            dry_run = is_dry_run(request)
            body = {
                "ok": True,
                "dry_run": dry_run,
                "can_apply": not report["errors"] and not report["locked"] and bool(report["updated"] or report["unchanged"]),
                **report,
                "not_found": report["not_found"][:20],
                "ignored_columns": ignored_columns[:30],
                "blocked_columns": blocked_columns[:30],
            }
            if dry_run:
                # Pratinjau = laporan yang sama dengan eksekusi, tanpa simpan (S6-0e butir 4).
                return JSONResponse(body)
            if report["errors"]:
                return JSONResponse(status_code=400, content={**body, "ok": False, "error": report["errors"][0]})
            if report["locked"]:
                return JSONResponse(status_code=409, content={**body, "ok": False, "error": payment_lock_message("Unggahan Excel SPPD", report["locked"])})
            if not report["updated"] and not report["unchanged"]:
                return JSONResponse(status_code=400, content={"ok": False, "error": "Tidak ada record yang cocok untuk diupdate.", "not_found": report["not_found"][:20]})
            if report["updated"]:
                save_payments_db(db)
            append_audit_log(user, "payments_sppd_excel_upload", "lpb", {
                "updated": report["updated"],
                "unchanged": report["unchanged"],
                "not_found": len(report["not_found"]),
                "changed_fields": report["changed_fields"],
                "blocked_columns": blocked_columns,
            })
            return JSONResponse(body)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    except Exception as e:
        append_error_log("payments_sppd_upload", e, {"user": user})
        return JSONResponse(status_code=500, content={"ok": False, "error": "Gagal memproses upload Excel SPPD."})

@router.get("/payments/sppd/settings")
def payments_sppd_settings_get(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "sppd", "view"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    db = load_payments_db()
    settings = get_sppd_settings(db)
    preview_date = _normalize_yyyy_mm_dd(s(request.query_params.get("date", ""))) or wita_now().strftime("%Y-%m-%d")
    preview_dt = pd.to_datetime(preview_date)
    next_seq = sppd_last_sequence_for_year(settings, int(preview_dt.year)) + 1
    return JSONResponse({
        "ok": True,
        "settings": settings,
        "next_sequence": next_seq,
        # Urutan terakhir yang BERLAKU untuk tahun pratinjau (0 di tahun baru) — dipakai pratinjau halaman.
        "effective_last_sequence": next_seq - 1,
        "preview_number": format_sppd_number_with_template(next_seq, preview_dt, s(settings.get("number_template", ""))),
        "preview_date": preview_date,
        "template_path": SPPD_TEMPLATE_PATH,
    })

@router.post("/payments/sppd/settings")
async def payments_sppd_settings_save(request: Request):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "sppd", "edit_settings"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    # AM-012: satu lock untuk semua penulis ledger (salinan per request -> tanpa lock = lost update).
    async with _PAYMENTS_DB_LOCK:
        db = load_payments_db()
        current = get_sppd_settings(db)
        payload = payload if isinstance(payload, dict) else {}
        # Tahun urutan dikelola sistem (nomor terbit / setelan / restore), bukan klien.
        payload.pop("sequence_year", None)
        # AM-019 (H08): urutan SPPD hanya boleh diubah oleh halaman yang MELIHAT nilai sekarang.
        # Halaman basi (submit BANK_PANIN sudah menaikkan urutan) atau yang gagal memuat (default 0)
        # dulu memundurkan urutan diam-diam -> nomor SPPD ganda.
        if "last_sequence" in payload:
            expected = payload.pop("expected_last_sequence", None)
            try:
                matches = expected is not None and int(expected) == int(current.get("last_sequence", 0))
            except (TypeError, ValueError):
                matches = False
            if not matches:
                return JSONResponse(status_code=409, content={
                    "ok": False, "current_last_sequence": current.get("last_sequence"),
                    "error": f"Urutan SPPD sudah {current.get('last_sequence')} (halaman basi atau gagal dimuat). Muat ulang lalu ulangi.",
                })
            try:
                requested = int(payload["last_sequence"])
            except (TypeError, ValueError):
                return JSONResponse(status_code=400, content={"ok": False, "error": "Nomor surat terakhir harus bilangan bulat."})
            if requested == int(current.get("last_sequence", 0)):
                payload.pop("last_sequence")  # halaman mengirim ulang nilai yang sama: bukan perubahan urutan
            else:
                # D-05/C10 (owner 8 Okt 2026): di dalam satu tahun terbit (WITA) nomor urut TIDAK BOLEH turun —
                # nomor yang sudah terbit akan terbit lagi. Tahun baru mulai dari 0, jadi angka berapa pun = naik.
                year = int(wita_now().year)
                effective = sppd_last_sequence_for_year(current, year)
                if requested < effective:
                    return JSONResponse(status_code=409, content={
                        "ok": False, "current_last_sequence": current.get("last_sequence"),
                        "error": f"Nomor urut SPPD tidak boleh turun di dalam satu tahun: nomor terakhir {year} adalah {effective}.",
                    })
                payload["last_sequence"] = requested
                payload["sequence_year"] = year
        previous_sequence = current.get("last_sequence")
        settings = normalize_sppd_settings({**current, **payload}, db)
        settings["updated_at"] = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
        settings["updated_by"] = user
        db["sppd_settings"] = settings
        db["sppd_seq"] = int(settings.get("last_sequence", 0))
        save_payments_db(db)
        append_audit_log(user, "payments_sppd_settings_save", "sppd_settings", {
            "previous_last_sequence": previous_sequence,
            "last_sequence": settings.get("last_sequence"),
            "sequence_year": settings.get("sequence_year"),
            "fixed_jaminan_date": settings.get("fixed_jaminan_date"),
            "maturity_months": settings.get("maturity_months"),
        })
        preview_dt = wita_now()
        next_seq = sppd_last_sequence_for_year(settings, int(preview_dt.year)) + 1
        return JSONResponse({
            "ok": True,
            "settings": settings,
            "next_sequence": next_seq,
            "effective_last_sequence": next_seq - 1,
            "preview_number": format_sppd_number_with_template(next_seq, preview_dt, s(settings.get("number_template", ""))),
        })


