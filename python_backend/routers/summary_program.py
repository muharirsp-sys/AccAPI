"""Tujuan: Endpoint Summary Program (Mistral tiga pembaca + penjaga) dan Form ringkasnya.
Caller: halaman Summary Program di Next.js, memanggil FastAPI langsung seperti Summary lama.
Dependensi: summary_program (ekstrak, validasi, fakta), summary_program_form (PDF), shared (master yang dimuat di layar Summary),
            summary_store (JsonStore, owned, identity), validator_engine.read_upload_file_limited, routers.summary_library.require_user.
Main Functions: ekstrak, form, setujui.
Side Effects: ekstrak memanggil Mistral (berbayar); setujui menyimpan Summary yang disetujui di summary_kv "summary-program-disetujui"
              sebagai ingatan bulan berikutnya. Tidak menulis ke Accurate maupun promo_rule.
"""
import re
from datetime import date, datetime

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, Response

import summary_program as sp
import summary_program_form as spf
from shared import MANUAL_MASTER_CACHE, MAX_PDF_UPLOAD_BYTES
from summary_store import JsonStore, identity, owned
from validator_engine import read_upload_file_limited

router = APIRouter()
DISETUJUI = JsonStore("summary-program-disetujui")


def _user(request, edit=False):
    from routers.summary_library import require_user
    return require_user(request, edit)


def _master(token, user):
    """Master principal yang dimuat pengguna di layar Summary (cache 'master', milik pengguna itu)."""
    master = MANUAL_MASTER_CACHE.get(token)
    if not owned(master, user):
        raise ValueError("Master tidak tersedia. Muat master kembali.")
    return [{"kode_barang": str(x.get("kode_barang", "")).strip(), "nama_barang": str(x.get("nama_barang") or ""),
             "kelompok_barang": str(x.get("kelompok_barang") or x.get("kelompok") or ""), "variant": str(x.get("variant") or ""),
             "gramasi": str(x.get("gramasi") or "")} for x in master.get("items", []) if str(x.get("kode_barang", "")).strip()]


def _kunci(principal):
    return re.sub(r"[^A-Z0-9]", "", str(principal).upper())


def _gagal(status, pesan):
    return JSONResponse(status_code=status, content={"ok": False, "error": pesan})


@router.post("/summary/program/ekstrak")
async def ekstrak(request: Request, token: str = Form(...), principal: str = Form(...), tanggal: str = Form(default=""),
                  surat: list[UploadFile] = File(...)):
    user = _user(request, True)
    try:
        master = _master(token, user)
        tanggal = date.fromisoformat(tanggal).isoformat() if tanggal else date.today().isoformat()
        if not principal.strip() or not 1 <= len(surat) <= 10:
            raise ValueError("Pilih principal dan unggah 1-10 surat program")
        berkas = [(f.filename or f"surat-{i}", await read_upload_file_limited(f, max_bytes=MAX_PDF_UPLOAD_BYTES, allowed_exts=(".pdf", ".jpg", ".jpeg", ".png"),
                                                                             label="Surat program")) for i, f in enumerate(surat, 1)]
        lalu = DISETUJUI.get(_kunci(principal))  # baris yang sama dengan Summary terakhir yang disetujui tidak ditanya lagi
        doc = await sp.ekstrak(principal.strip(), berkas, master, tanggal, frozenset(sp.fakta(lalu["doc"])) if lalu else frozenset())
        return {"ok": True, "doc": doc, "pembanding": lalu and {"pada": lalu["pada"]}}
    except ValueError as error:
        return _gagal(422, str(error))
    except Exception:
        return _gagal(500, "Ekstraksi Summary Program gagal; tidak ada yang disimpan.")


@router.post("/summary/program/form")
async def form(request: Request):
    """Body {docs: [summary_program], token?, dibuat?: YYYY-MM-DD} -> PDF. Untuk pratinjau (masih berflag) maupun Form final."""
    user = _user(request)
    try:
        body = await request.json()
        urut = {x["kode_barang"]: i for i, x in enumerate(_master(body["token"], user))} if body.get("token") else {}
        dibuat = date.fromisoformat(body["dibuat"]) if body.get("dibuat") else date.today()
        pdf = spf.form_pdf([(d, urut) for d in body["docs"]], dibuat)
    except (ValueError, KeyError, TypeError) as error:
        return _gagal(422, f"Form tidak dapat dirakit: {error}")
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": 'inline; filename="Form_Summary_Program.pdf"'})


@router.post("/summary/program/setujui")
async def setujui(request: Request):
    """Gerbang rilis (pemilik 28 Okt 2026): ditolak selama ada flag kritis/perlu_cek atau referensi/kode yang salah."""
    user = _user(request, True)
    try:
        body = await request.json()
        doc, master = body["doc"], _master(body["token"], user)
        err = sp.validasi(doc, {x["kode_barang"] for x in master})
        sisa = [f for f in doc["flags"] if f["tingkat"] in ("kritis", "perlu_cek")]
        if err or sisa:
            return _gagal(422, f"Belum bisa disetujui: {len(sisa)} peringatan belum dijawab" + (f"; {err[0]}" if err else ""))
        DISETUJUI[_kunci(body.get("principal") or doc["principal"])] = {"doc": doc, "oleh": identity(user),
                                                                        "pada": datetime.now().isoformat(timespec="seconds")}
    except ValueError as error:
        return _gagal(422, str(error))
    except (KeyError, TypeError) as error:
        return _gagal(422, f"Summary tidak lengkap: {error}")
    return {"ok": True}
