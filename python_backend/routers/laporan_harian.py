# Tujuan: Endpoint FastAPI untuk proses, penyimpanan, dan unduhan laporan harian per target.
# Caller: Next.js app/api/laporan-harian/*.
# Dependensi: shared runtime config, laporan_harian pipeline, resolver target, dan writer XLSX.
# Main Functions: laporan_harian_process() menentukan tanggal transaksi terakhir, lalu laporan_harian_file().
# Side Effects: Membaca upload, menulis workbook runtime, dan mengirim file melalui HTTP.
from fastapi import APIRouter

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
    report_keywords: Optional[str] = Form(None),
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
        effective_report_date = LH.latest_sales_date(sb, report_date)
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
        stock_frame = None
        stock_spv = []
        if stock_path:
            try:
                stock_frame = LH.build_stock_frame(stock_path, sb)
                stock_spv = [
                    str(value)
                    for value in stock_frame["GOLONGAN"].dropna().unique()
                ]
            except Exception as exc:
                return ORJSONResponse(
                    {"ok": False, "error": f"Gagal memproses file stok: {exc}"},
                    status_code=400,
                )
        files_written = []
        unmatched_report_keywords = []
        if write_files and run_id:
            import json as _json, re as _re, datetime as _dt
            safe_run = _re.sub(r"[^A-Za-z0-9_-]", "", str(run_id))[:64]
            rdate = effective_report_date or _dt.date.today().strftime("%Y-%m-%d")
            out_dir = _os.path.join(LH_RUNTIME_DIR, safe_run)
            try:
                keywords = _json.loads(report_keywords or "[]")
                if not isinstance(keywords, list):
                    raise ValueError("report_keywords harus array")
            except Exception as exc:
                return ORJSONResponse(
                    {"ok": False, "error": f"Keyword laporan tidak valid: {exc}"},
                    status_code=400,
                )
            files_written, unmatched_report_keywords = LH.write_report_files(
                sb, out_dir, rdate, keywords, lk, stock_frame,
            )

        return ORJSONResponse({
            "ok": True,
            "files": files_written,
            "report_date": effective_report_date,
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
            "unmatched_report_keywords": unmatched_report_keywords,
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
    return FileResponse(path, filename=name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
