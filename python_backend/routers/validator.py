# routers/validator.py — Endpoint validator diskon: /validate, /validate_json, /download/{file_id}, /validator/template/*.
# Dipindahkan mekanis dari main.py tanpa perubahan logic; hanya @app.* diganti @router.*.
from fastapi import APIRouter

from shared import (
    APP_DEBUG,
    File,
    HTMLResponse,
    JSONResponse,
    MAX_EXCEL_UPLOAD_BYTES,
    REQUIRED_MISSING_MSG,
    RedirectResponse,
    Request,
    UploadFile,
    _excel_download_response,
    accel_or_file_response,
    append_error_log,
    get_current_user,
    is_admin_user,
    os,
    read_upload_file_limited,
    run_engine,
    user_has_permission,
    uuid,
    validate_csrf_request,
    validator_channel_template_rows,
    validator_promo_template_rows,
    validator_sales_template_rows,
    write_excel,
)

router = APIRouter()

# ---------------------------
# Endpoints
# ---------------------------
@router.post("/validate_json")
async def validate_json(
    request: Request,
    sales: UploadFile = File(None),
    promo: UploadFile = File(None),
    channel: UploadFile = File(None),
    internal: UploadFile = File(None),
):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "validator", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    # Server-side guard (in case someone calls API directly)
    if sales is None or promo is None or channel is None:
        return JSONResponse(status_code=400, content={"ok": False, "error": REQUIRED_MISSING_MSG})

    try:
        sales_bytes = await read_upload_file_limited(
            sales,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="Data Penjualan",
        )
        promo_bytes = await read_upload_file_limited(
            promo,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="Dataset Diskon Pabrik",
        )
        channel_bytes = await read_upload_file_limited(
            channel,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="Data Channel by SUB",
        )
        internal_bytes = None
        if internal is not None:
            try:
                internal_bytes = await read_upload_file_limited(
                    internal,
                    max_bytes=MAX_EXCEL_UPLOAD_BYTES,
                    allowed_exts=(".xlsx", ".xls"),
                    label="Dataset Diskon Internal",
                )
            except:
                internal_bytes = None

        out_df = run_engine(sales_bytes, promo_bytes, channel_bytes, internal_bytes)

        file_id = str(uuid.uuid4())[:8]
        base_dir = os.path.dirname(os.path.abspath(__file__))
        out_dir = os.path.join(base_dir, "output")
        out_path = os.path.join(out_dir, f"hasil_validasi_{file_id}.xlsx")
        write_excel(out_df, out_path)

        counts = out_df["StatusValidasi"].value_counts(dropna=False).to_dict()
        return JSONResponse({
            "ok": True,
            "file_id": file_id,
            "download_url": f"/download/{file_id}",
            "counts": {"A": int(counts.get("A", 0)), "B": int(counts.get("B", 0)), "C": int(counts.get("C", 0))},
        })
    except ValueError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    except Exception as e:
        append_error_log("validate_json", e, {"user": user})
        payload = {"ok": False, "error": "Terjadi kesalahan saat memproses validasi."}
        if APP_DEBUG and is_admin_user(user):
            payload["detail"] = str(e)
        return JSONResponse(status_code=500, content=payload)

@router.post("/validate")
async def validate(
    request: Request,
    sales: UploadFile = File(None),
    promo: UploadFile = File(None),
    channel: UploadFile = File(None),
    internal: UploadFile = File(None),
):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Unauthorized"})
    if not user_has_permission(user, "validator", "edit"):
        return JSONResponse(status_code=403, content={"ok": False, "error": "Forbidden"})
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not validate_csrf_request(request, csrf_token):
        return JSONResponse(status_code=403, content={"ok": False, "error": "CSRF token invalid"})
    if sales is None or promo is None or channel is None:
        return JSONResponse(status_code=400, content={"ok": False, "error": REQUIRED_MISSING_MSG})

    try:
        sales_bytes = await read_upload_file_limited(
            sales,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="Data Penjualan",
        )
        promo_bytes = await read_upload_file_limited(
            promo,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="Dataset Diskon Pabrik",
        )
        channel_bytes = await read_upload_file_limited(
            channel,
            max_bytes=MAX_EXCEL_UPLOAD_BYTES,
            allowed_exts=(".xlsx", ".xls"),
            label="Data Channel by SUB",
        )
        internal_bytes = None
        if internal is not None:
            try:
                internal_bytes = await read_upload_file_limited(
                    internal,
                    max_bytes=MAX_EXCEL_UPLOAD_BYTES,
                    allowed_exts=(".xlsx", ".xls"),
                    label="Dataset Diskon Internal",
                )
            except:
                internal_bytes = None

        out_df = run_engine(sales_bytes, promo_bytes, channel_bytes, internal_bytes)

        base_dir = os.path.dirname(os.path.abspath(__file__))
        out_dir = os.path.join(base_dir, "output")
        out_path = os.path.join(out_dir, "hasil_validasi.xlsx")
        write_excel(out_df, out_path)

        return accel_or_file_response(out_path, "hasil_validasi.xlsx")
    except ValueError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    except Exception as e:
        append_error_log("validate", e, {"user": user})
        payload = {"ok": False, "error": "Terjadi kesalahan saat memproses validasi."}
        if APP_DEBUG and is_admin_user(user):
            payload["detail"] = str(e)
        return JSONResponse(status_code=500, content=payload)

@router.get("/download/{file_id}")
def download(request: Request, file_id: str):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    if not user_has_permission(user, "validator", "view"):
        return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    base_dir = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(base_dir, "output", f"hasil_validasi_{file_id}.xlsx")
    return accel_or_file_response(out_path, "hasil_validasi.xlsx")


@router.get("/validator/template/sales")
def validator_template_sales(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse("/login")
    if not user_has_permission(user, "validator", "view"):
        return HTMLResponse("Forbidden", status_code=403)
    return _excel_download_response(validator_sales_template_rows(), "template_data_penjualan.xlsx", "SALES_TEMPLATE")


@router.get("/validator/template/promo")
def validator_template_promo(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse("/login")
    if not user_has_permission(user, "validator", "view"):
        return HTMLResponse("Forbidden", status_code=403)
    return _excel_download_response(validator_promo_template_rows(), "template_dataset_diskon_pabrik.xlsx", "PROMO_TEMPLATE")


@router.get("/validator/template/channel")
def validator_template_channel(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse("/login")
    if not user_has_permission(user, "validator", "view"):
        return HTMLResponse("Forbidden", status_code=403)
    return _excel_download_response(validator_channel_template_rows(), "template_data_channel_by_sub.xlsx", "CHANNEL_TEMPLATE")

