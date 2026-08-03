# Tujuan: Endpoint FastAPI untuk proses, penyimpanan, dan unduhan laporan harian per SPV.
# Caller: Next.js app/api/laporan-harian/*.
# Dependensi: shared runtime config serta laporan_harian pipeline dan writer XLSX/ZIP dan rule distribusi.
# Main Functions: laporan_harian_process(), laporan_harian_file(), dan laporan_harian_mapping().
# Side Effects: Membaca upload, menulis workbook/ZIP runtime, mengubah lookup backend, dan mengirim file melalui HTTP.
from fastapi import APIRouter, Header

from shared import (
    File,
    FileResponse,
    Form,
    LH_RUNTIME_DIR,
    ORJSONResponse,
    Optional,
    UploadFile,
    os,
)

router = APIRouter()

@router.post("/laporan-harian/process")
async def laporan_harian_process(
    penjualan: Optional[UploadFile] = File(None),
    retur: Optional[UploadFile] = File(None),
    fix: Optional[UploadFile] = File(None),
    stock: Optional[UploadFile] = File(None),
    run_id: Optional[str] = Form(None),
    report_date: Optional[str] = Form(None),
    write_files: Optional[str] = Form(None),
):
    import tempfile, os as _os
    import laporan_harian as LH

    tmpdir = tempfile.mkdtemp(prefix="lh_")

    async def _save(uf, name):
        if uf is None:
            return None
        p = _os.path.join(tmpdir, name)
        with open(p, "wb") as f:
            f.write(await uf.read())
        return p

    penj_path = await _save(penjualan, "penjualan.xlsx")
    ret_path = await _save(retur, "retur.xlsx")
    fix_path = await _save(fix, "fix.xlsx")
    stock_path = await _save(stock, "stock.xlsx")

    try:
        lk = LH.load_lookups_json()   # master GOLONGAN/JENIS PRODUK/Mapping (untuk NAMA SM juga)
        if penj_path:
            fix_df = LH.build_fix_from_accurate(penj_path, ret_path, lk)   # web bangun 2.ToFormat sendiri
        elif fix_path:
            fix_df = LH.load_fix(fix_path)                                  # backward-compat: upload FIX jadi
        else:
            return ORJSONResponse({"ok": False, "error": "Wajib upload 'penjualan' (+retur) atau 'fix'."}, status_code=400)
        sb = LH.build_salesbase(fix_df, lk)
        progress = LH.aggregate_progress(sb)
        summary = (sb.groupby("GOLONGAN", dropna=True)
                     .agg(rows=("NO_NOTA", "size"), dpp=("DPP", "sum"),
                          ao=("AO", "sum"), ec=("EC", "sum"), ia=("Item Aktif", "sum"))
                     .reset_index().sort_values("GOLONGAN"))
        # periode dominan
        pm = int(progress["periodMonth"].dropna().mode().iloc[0]) if len(progress) else None
        py = int(progress["periodYear"].dropna().mode().iloc[0]) if len(progress) else None
        prog_records = []
        for r in progress.to_dict("records"):
            prog_records.append({
                "salesCode": None if r["salesCode"] is None else str(r["salesCode"]),
                "principle": None if r["principle"] is None else str(r["principle"]),
                "branch": None if r["branch"] is None else str(r["branch"]),
                "date": None if r["date"] is None else str(r["date"]),
                "periodMonth": None if r["periodMonth"] is None else int(r["periodMonth"]),
                "periodYear": None if r["periodYear"] is None else int(r["periodYear"]),
                "achievedValueDpp": float(r["achievedValueDpp"] or 0),
                "achievedEc": int(r["achievedEc"] or 0),
                "achievedAo": int(r["achievedAo"] or 0),
                "achievedIa": int(r["achievedIa"] or 0),
            })
        stock_by_spv = {}
        stock_spv = []
        if stock_path:
            try:
                stock_by_spv = LH.build_stock(stock_path, sb, lk)
                stock_spv = [k for k in stock_by_spv.keys() if k != "__error__"]
            except Exception as exc:
                return ORJSONResponse(
                    {"ok": False, "error": f"Gagal memproses file stok: {exc}"},
                    status_code=400,
                )
        files_written = []
        to_format = None
        archive = None
        if write_files and run_id:
            import re as _re, datetime as _dt
            safe_run = _re.sub(r"[^A-Za-z0-9_-]", "", str(run_id))[:64]
            rdate = report_date or _dt.date.today().strftime("%Y-%m-%d")
            out_dir = _os.path.join(LH_RUNTIME_DIR, safe_run)
            files_written = LH.write_per_spv_files(sb, out_dir, rdate, stock_by_spv)
            files_written += LH.write_dimension_files(sb, out_dir, rdate, "NAMA_SM", "SM", stock_by_spv)
            files_written += LH.write_dimension_files(sb, out_dir, rdate, "PRINCIPAL", "PRINCIPLE", stock_by_spv)
            files_written += LH.write_distribution_files(
                sb, out_dir, rdate, LH.load_distribution_rules(), stock_by_spv
            )
            to_format = LH.write_to_format_file(fix_df, out_dir, rdate)
            archive = LH.create_run_archive(out_dir, rdate)
        return ORJSONResponse({
            "ok": True,
            "files": files_written,
            "to_format": to_format,
            "archive": archive,
            "sales_rows": int(len(sb)),
            "net_dpp": float(sb["DPP"].sum()),
            "period": {"month": pm, "year": py},
            "spv_list": [str(x) for x in summary["GOLONGAN"].tolist()],
            "summary": [
                {"spv": str(r["GOLONGAN"]), "rows": int(r["rows"]), "dpp": float(r["dpp"]),
                 "ao": int(r["ao"]), "ec": int(r["ec"]), "ia": int(r["ia"])}
                for r in summary.to_dict("records")
            ],
            "progress": prog_records,
            "stock_spv": stock_spv,
        })
    except Exception as e:
        import traceback
        return ORJSONResponse({"ok": False, "error": str(e), "trace": traceback.format_exc()[-1500:]}, status_code=500)
    finally:
        try:
            import shutil as _sh; _sh.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass



@router.get("/laporan-harian/file")
async def laporan_harian_file(run: str, name: str):
    """Stream 1 file laporan per-SPV (run-scoped). Guard path traversal."""
    import re as _re
    safe_run = _re.sub(r"[^A-Za-z0-9_-]", "", str(run))[:64]
    if "/" in name or "\\" in name or ".." in name:
        return ORJSONResponse({"error": "nama file tidak valid"}, status_code=400)
    path = os.path.join(LH_RUNTIME_DIR, safe_run, name)
    if not os.path.isfile(path):
        return ORJSONResponse({"error": "file tidak ditemukan"}, status_code=404)
    media_type = (
        "application/zip" if name.lower().endswith(".zip")
        else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    return FileResponse(path, filename=name, media_type=media_type)


@router.get("/laporan-harian/mapping")
async def laporan_harian_mapping():
    """Baca mapping yang dipakai pipeline laporan harian."""
    import json as _json
    import laporan_harian as LH
    with open(LH.LOOKUPS_JSON, encoding="utf-8") as handle:
        return ORJSONResponse(_json.load(handle))


@router.put("/laporan-harian/mapping")
async def laporan_harian_mapping_update(payload: dict, x_lh_mapping_token: Optional[str] = Header(None)):
    """Simpan mapping secara atomik agar proses berikutnya memakai versi terbaru."""
    import json as _json
    import os as _os
    import tempfile as _tempfile
    import laporan_harian as LH

    expected_token = _os.getenv("LH_MAPPING_TOKEN", "").strip()
    runtime_env = _os.getenv("APP_ENV", "production").strip().lower()
    if runtime_env in {"production", "prod"} and not expected_token:
        return ORJSONResponse({"error": "Token mapping backend belum dikonfigurasi"}, status_code=503)
    if expected_token and x_lh_mapping_token != expected_token:
        return ORJSONResponse({"error": "Token mapping tidak valid"}, status_code=403)
    required = ("principal_to_spv", "conca_to_spv", "jp_map", "sm_map")
    if not all(isinstance(payload.get(key), dict) for key in required) or not isinstance(payload.get("distribution_rules"), list):
        return ORJSONResponse({"error": "Format mapping tidak valid"}, status_code=400)
    directory = _os.path.dirname(LH.LOOKUPS_JSON)
    fd, temp_path = _tempfile.mkstemp(prefix="laporan_harian_", suffix=".json", dir=directory)
    try:
        with _os.fdopen(fd, "w", encoding="utf-8") as handle:
            output = {key: payload[key] for key in required}
            output["distribution_rules"] = payload["distribution_rules"]
            _json.dump(output, handle, ensure_ascii=False, indent=2)
        _os.replace(temp_path, LH.LOOKUPS_JSON)
    finally:
        if _os.path.exists(temp_path):
            _os.unlink(temp_path)
    return ORJSONResponse({"ok": True})
