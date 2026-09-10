"""Tujuan: Draft Summary persisten, sumber privat, publikasi immutable, dan simulasi promo.
Caller: SummaryLibrary web; adaptor order membaca hanya versi published.
Dependensi: shared auth/RBAC, summary_store, summary_rules, summary_mistral.
Main Functions: list/get/save/publish/withdraw/source/simulate; versi terbit termasuk asal paket review memakai snapshot tervalidasi.
Side Effects: SQLite read/write dan respons PDF privat; tidak menulis faktur.
"""
import json
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import ValidationError
from shared import get_current_user, user_has_permission, validate_csrf_request
from summary_store import connect, get_draft, identity
from summary_rules import validate_programs, calculate, compile_programs
from summary_mistral import status

router = APIRouter(prefix="/summary/library")


def require_user(request, edit=False):
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Silakan login")
    if not user_has_permission(user, "summary", "edit" if edit else "view"):
        raise HTTPException(403, "Akses Summary tidak diizinkan")
    if edit and not validate_csrf_request(request, request.headers.get("X-CSRF-Token", "")):
        raise HTTPException(403, "Permintaan lintas situs ditolak")
    return user


async def read_body(request):
    raw = await request.body()
    if len(raw) > 2 * 1024 * 1024:
        raise HTTPException(413, "Draft maksimal 2 MB")
    try:
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
        return body
    except (ValueError, TypeError):
        raise HTTPException(400, "Format permintaan tidak valid") from None


def programs_for(draft):
    """Aturan selalu disusun ulang dari baris yang ditinjau; versi terbit memakai salinan beku."""
    content = draft["content"]
    codes = {str(item.get("kode_barang", "")).strip() for item in content["master"].get("items", [])}
    pages = content["extraction"]["page_count"]
    if draft["status"] != "draft" and content.get("programs"):
        return validate_programs(content["programs"], codes, pages)
    programs, issues = compile_programs(content.get("rows", []), content.get("period"))
    if issues:
        raise ValueError("Perbaiki baris draft sebelum aturan dapat disusun: " + "; ".join(issues[:8]))
    return validate_programs(programs, codes, pages)


def with_rules(draft):
    rules, issues = preview(draft)
    return {"ok": True, "draft": draft, "programs": rules, "issues": issues}


def preview(draft):
    """Pratinjau aturan untuk ditinjau manusia; kegagalan dilaporkan, bukan disembunyikan."""
    if draft['status']!='draft' and draft['content'].get('programs'):
        return [p.model_dump(mode='json') for p in programs_for(draft)],[]
    issues = compile_programs(draft["content"].get("rows", []), draft["content"].get("period"))[1]
    try:
        return [program.model_dump(mode="json") for program in programs_for(draft)], issues
    except (ValueError, KeyError, ValidationError) as error:
        return [], issues or [public_error(error)]


def public_error(error):
    if isinstance(error, ValidationError):
        return "; ".join(".".join(map(str, entry["loc"])) + ": " + entry["msg"] for entry in error.errors()[:8])
    return str(error)


@router.get("/status")
def provider_status(request: Request):
    require_user(request)
    return {"ok": True, **status()}


@router.get("")
def list_drafts(request: Request):
    user = require_user(request)
    with connect() as db:
        rows = db.execute("SELECT id,title,revision,status,updated_at FROM summary_draft WHERE owner=? ORDER BY updated_at DESC,id DESC LIMIT 100", (identity(user),)).fetchall()
    return {"ok": True, "drafts": [dict(row) for row in rows]}


@router.get("/published")
def published(request: Request, after: str = "", after_id: str = ""):
    require_user(request)
    with connect() as db:
        rows = db.execute("SELECT id,title,revision,status,content,updated_at FROM summary_draft WHERE status IN ('published','withdrawn') AND (updated_at,id)>(?,?) ORDER BY updated_at,id LIMIT 50", (after, after_id)).fetchall()
    return {"ok": True, "programs": [{"id": r["id"], "title": r["title"], "revision": r["revision"], "status": r["status"], "updated_at": r["updated_at"],
             "rules": json.loads(r["content"])["programs"] if r["status"] == "published" else []} for r in rows],
            "next": {"after": rows[-1]["updated_at"], "after_id": rows[-1]["id"]} if rows else None}


@router.get("/{draft_id}")
def detail(request: Request, draft_id: str):
    user = require_user(request)
    draft = get_draft(draft_id, user)
    if not draft:
        raise HTTPException(404, "Draft tidak ditemukan")
    return with_rules(draft)


@router.get("/{draft_id}/source")
def source(request: Request, draft_id: str):
    user = require_user(request)
    with connect() as db:
        row = db.execute("SELECT source FROM summary_draft WHERE id=? AND owner=?", (draft_id, identity(user))).fetchone()
    if not row or not row[0]:
        raise HTTPException(404, "Sumber tidak ditemukan")
    return Response(bytes(row[0]), media_type="application/pdf", headers={"Cache-Control": "private, no-store", "Content-Disposition": 'attachment; filename="surat-program.pdf"', "X-Content-Type-Options": "nosniff"})


@router.put("/{draft_id}")
async def save(request: Request, draft_id: str):
    user = require_user(request, True)
    body = await read_body(request)
    draft = get_draft(draft_id, user)
    if not draft:
        raise HTTPException(404, "Draft tidak ditemukan")
    rows, title, period = body.get("rows"), body.get("title"), body.get("period") or ["", ""]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 2000 or not isinstance(title, str) or not title.strip():
        raise HTTPException(400, "Isi judul dan baris draft yang valid")
    if not isinstance(period, list) or len(period) != 2 or any(not isinstance(value, str) or len(value) > 10 for value in period):
        raise HTTPException(400, "Periode draft harus dua tanggal YYYY-MM-DD atau dikosongkan")
    from summary_mistral import FIELDS
    if any(not isinstance(row, dict) or any(not isinstance(row.get(field, ""), str) for field in FIELDS) for row in rows):
        raise HTTPException(400, "Format baris draft tidak valid")
    content = draft["content"]
    content["rows"] = [{key: row.get(key, "") for key in [*FIELDS, "id", "no", "source_page"]} for row in rows]
    content["period"] = period
    content.pop("programs", None)
    with connect() as db:
        changed = db.execute("UPDATE summary_draft SET title=?,content=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner=? AND status='draft' AND revision=?",
            (title[:160], json.dumps(content, allow_nan=False), draft_id, identity(user), body.get("revision"))).rowcount
        if not changed:
            raise HTTPException(409, "Draft berubah atau sudah diterbitkan. Muat ulang sebelum menyimpan")
    return with_rules(get_draft(draft_id, user))


@router.post("/{draft_id}/publish")
async def publish(request: Request, draft_id: str):
    user = require_user(request, True)
    body = await read_body(request)
    draft = get_draft(draft_id, user)
    if not draft:
        raise HTTPException(404, "Draft tidak ditemukan")
    if body.get("reviewed") is not True:
        raise HTTPException(400, "Periksa sumber, kode, periode, dan semua ketentuan terlebih dahulu")
    # Aturan terbit dipakai memotong faktur. Surat yang mekanismenya BUKAN on faktur
    # (mis. "DISC ON PO", "ADDITIONAL DISCOUNT") tidak boleh masuk ke sana lewat pintu ini.
    if draft["content"].get("extraction", {}).get("on_faktur") is False:
        raise HTTPException(409, "Mekanisme surat bukan on faktur; program ini diklaim di luar faktur, jangan diterbitkan sebagai aturan order")
    try:
        programs = programs_for(draft)
    except (ValueError, KeyError) as error:
        raise HTTPException(400, public_error(error)) from None
    content = draft["content"]
    content["programs"] = [program.model_dump(mode="json") for program in programs]
    content["reviewed_by"] = identity(user)
    with connect() as db:
        changed = db.execute("UPDATE summary_draft SET content=?,status='published',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner=? AND status='draft' AND revision=?",
            (json.dumps(content), draft_id, identity(user), body.get("revision"))).rowcount
        if not changed:
            raise HTTPException(409, "Draft berubah atau sudah diterbitkan; muat ulang")
    return with_rules(get_draft(draft_id, user))


@router.post("/{draft_id}/withdraw")
async def withdraw(request: Request, draft_id: str):
    user = require_user(request, True)
    body = await read_body(request)
    with connect() as db:
        changed = db.execute("UPDATE summary_draft SET status='withdrawn',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner=? AND status='published' AND revision=?", (draft_id, identity(user), body.get("revision"))).rowcount
        if not changed:
            raise HTTPException(409, "Versi berubah atau tidak tersedia")
    return with_rules(get_draft(draft_id, user))


@router.post("/{draft_id}/simulate")
async def simulate(request: Request, draft_id: str):
    user = require_user(request, True)
    body = await read_body(request)
    draft = get_draft(draft_id, user)
    if not draft:
        raise HTTPException(404, "Draft tidak ditemukan")
    try:
        return {"ok": True, "result": calculate(programs_for(draft), body["lines"], body["date"], body["channel"])}
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, public_error(error)) from None
