"""Tujuan: Order masuk dengan aturan promo terbit yang dibekukan pada saat pengiriman.
Caller: halaman order internal; Web Sales terpisah akan memakai endpoint yang sama.
Dependensi: shared auth/RBAC, summary_store, summary_rules (Program, calculate), websales_store.
Main Functions: published_rules, preview_order, create_order, pull_requests, list_orders, order_detail.
Side Effects: SQLite read/write; tidak menulis faktur Accurate dan tidak memanggil AI.
"""
import json
import sqlite3
import uuid
from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError
from shared import get_current_user, user_has_permission, validate_csrf_request
from summary_store import connect, identity
from summary_rules import Program, calculate, suggestions
import websales_store

router = APIRouter(prefix="/orders")


def require_user(request, create=False):
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Silakan login")
    if not user_has_permission(user, "order", "create" if create else "view"):
        raise HTTPException(403, "Akses order tidak diizinkan")
    if create and not validate_csrf_request(request, request.headers.get("X-CSRF-Token", "")):
        raise HTTPException(403, "Permintaan lintas situs ditolak")
    return user


def published_rules():
    """Aturan dari semua draft berstatus published.

    Urutan penerapan adalah urutan publikasi (surat yang lebih dulu terbit menang bila
    keduanya tidak boleh digabung), lalu urutan program di dalam suratnya. Prioritas
    ditulis ulang berurutan di sini supaya hasil tidak bergantung pada ID acak, dan
    urutan itu ikut dibekukan pada order. ID diberi awalan draft agar unik dan terlacak.
    """
    with connect() as db:
        rows = db.execute("SELECT id,revision,content FROM summary_draft WHERE status='published' ORDER BY updated_at,id").fetchall()
    programs, sources = [], []
    for row in rows:
        stored = json.loads(row["content"]).get("programs") or []
        if not stored:
            continue
        sources.append({"draft_id": row["id"], "revision": row["revision"]})
        for program in sorted(stored, key=lambda item: (item["priority"], item["id"])):
            programs.append(Program.model_validate({**program, "priority": len(programs) + 1,
                                                    "id": f"{row['id'][:8]}:{program['id']}"[:80]}))
    return programs, sources


def store_order(owner, outlet, channel, order_date, note, lines, request_id=None):
    """Hitung dengan aturan terbit lalu bekukan aturan, sumber, dan hasilnya pada order.

    Baris tanpa harga (permintaan dari Web Sales) TIDAK dihitung sebagai uang: order
    masuk berstatus `needs_price` dengan aturan belum dibekukan, supaya nilai transaksi
    tidak pernah ditentukan oleh klien. Harga diisi internal (tahap Accurate).
    """
    priced = all(str(line.get("price", "")).strip() for line in lines)
    programs, sources = published_rules()
    if not programs:
        raise HTTPException(409, "Belum ada aturan promo terbit; terbitkan Summary sebelum order dihitung")
    if priced:
        result = calculate(programs, lines, order_date, channel)
        frozen = [program.model_dump(mode="json") for program in programs]
        status = "draft"
    else:
        result, frozen, status = {"pending_price": True, "lines": lines}, [], "needs_price"
    order_id = str(uuid.uuid4())
    with connect() as db:
        db.execute("INSERT INTO sales_order(id,owner,outlet,channel,order_date,status,note,lines,rules,sources,result,request_id)"
                   " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                   (order_id, owner, outlet[:160], channel[:80], order_date, status, note,
                    json.dumps(lines, ensure_ascii=False), json.dumps(frozen, ensure_ascii=False),
                    json.dumps(sources, ensure_ascii=False), json.dumps(result, ensure_ascii=False), request_id))
    return order_id


def public_error(error):
    if isinstance(error, ValidationError):
        return "; ".join(".".join(map(str, entry["loc"])) + ": " + entry["msg"] for entry in error.errors()[:8])
    return str(error)


async def read_order_body(request, limit):
    raw = await request.body()
    if len(raw) > limit:
        raise HTTPException(413, "Permintaan terlalu besar")
    try:
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, "Format permintaan tidak valid") from None
    channel = str(body.get("channel", "")).strip().upper()
    order_date = str(body.get("order_date", "")).strip()
    lines = body.get("lines")
    if not channel or not order_date:
        raise HTTPException(400, "Channel dan tanggal order wajib diisi")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 500:
        raise HTTPException(400, "Order harus memiliki 1–500 baris")
    clean = []
    for line in lines:
        if not isinstance(line, dict):
            raise HTTPException(400, "Baris order tidak valid")
        clean.append({key: str(line.get(key, "")).strip() for key in ("code", "unit", "quantity", "price")})
    return body, channel, order_date, clean


@router.post("/preview")
async def preview_order(request: Request):
    """Nilai transaksi dan saran "kurang berapa lagi" sebelum order dikirim.

    Harga WAJIB datang dari pemanggil sisi server (hasil sinkronisasi Accurate),
    bukan dari perangkat sales. Tidak menyimpan apa pun.
    """
    require_user(request, True)
    _, channel, order_date, clean = await read_order_body(request, 512 * 1024)
    if any(not line["price"] for line in clean):
        raise HTTPException(400, "Setiap baris pratinjau butuh harga dari server")
    programs, sources = published_rules()
    try:
        result = calculate(programs, clean, order_date, channel) if programs else None
        advice = suggestions(programs, clean, order_date, channel) if programs else []
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, public_error(error)) from None
    return {"ok": True, "result": result, "suggestions": advice, "sources": sources}


@router.post("")
async def create_order(request: Request):
    user = require_user(request, True)
    raw = await request.body()
    if len(raw) > 512 * 1024:
        raise HTTPException(413, "Order maksimal 512 KB")
    try:
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, "Format permintaan tidak valid") from None
    outlet, channel = str(body.get("outlet", "")).strip(), str(body.get("channel", "")).strip().upper()
    order_date, note = str(body.get("order_date", "")).strip(), str(body.get("note", ""))[:500]
    lines = body.get("lines")
    if not outlet or not channel or not order_date:
        raise HTTPException(400, "Outlet, channel, dan tanggal order wajib diisi")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 500:
        raise HTTPException(400, "Order harus memiliki 1–500 baris")
    clean = []
    for line in lines:
        if not isinstance(line, dict):
            raise HTTPException(400, "Baris order tidak valid")
        clean.append({key: str(line.get(key, "")).strip() for key in ("code", "unit", "quantity", "price")})
    try:
        order_id = store_order(identity(user), outlet, channel, order_date, note, clean)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, public_error(error)) from None
    return {"ok": True, "order": order_detail_row(order_id, user)}


@router.post("/pull")
async def pull_requests(request: Request):
    """Tarik permintaan order Web Sales ke internal. Aman diulang.

    Dua basis data tidak bisa satu transaksi, jadi urutannya: tulis order internal
    dengan `request_id` unik lebih dulu, baru tandai permintaan sebagai `pulled`.
    Bila penandaan gagal, pull berikutnya menabrak kunci unik dan permintaan itu
    hanya ditandai, bukan digandakan.
    """
    user = require_user(request, True)
    if not user_has_permission(user, "order", "edit"):
        raise HTTPException(403, "Hanya petugas yang boleh menarik order Web Sales")
    imported, duplicated, failed = [], [], []
    for entry in websales_store.pending():
        try:
            order_id = store_order(identity(user), entry["outlet"], entry["channel"], entry["order_date"],
                                   entry["note"], entry["lines"], request_id=entry["id"])
            imported.append({"request_id": entry["id"], "order_id": order_id})
        except sqlite3.IntegrityError:
            duplicated.append(entry["id"])
        except HTTPException:
            raise
        except (ValueError, KeyError, TypeError) as error:
            failed.append({"request_id": entry["id"], "error": public_error(error)})
            continue
        websales_store.mark_pulled(entry["id"])
    for request_id in duplicated:
        websales_store.mark_pulled(request_id)
    return {"ok": True, "imported": imported, "already_imported": duplicated, "failed": failed}


def order_detail_row(order_id, user, everyone=False):
    with connect() as db:
        query = ("SELECT id,owner,outlet,channel,order_date,status,note,lines,sources,result,request_id,created_at"
                 " FROM sales_order WHERE id=?")
        row = db.execute(query if everyone else query + " AND owner=?", (order_id,) if everyone else (order_id, identity(user))).fetchone()
    if row is None:
        return None
    value = dict(row)
    for key in ("lines", "sources", "result"):
        value[key] = json.loads(value[key])
    return value


@router.get("")
def list_orders(request: Request, scope: str = "mine"):
    user = require_user(request)
    everyone = scope == "all" and user_has_permission(user, "order", "edit")
    with connect() as db:
        query = ("SELECT id,owner,outlet,channel,order_date,status,result,request_id,created_at FROM sales_order "
                 + ("" if everyone else "WHERE owner=? ") + "ORDER BY created_at DESC,id DESC LIMIT 100")
        rows = db.execute(query, () if everyone else (identity(user),)).fetchall()
    return {"ok": True, "scope": "all" if everyone else "mine",
            "orders": [{**dict(row), "result": json.loads(row["result"])} for row in rows]}


@router.get("/{order_id}")
def order_detail(request: Request, order_id: str):
    user = require_user(request)
    order = order_detail_row(order_id, user, user_has_permission(user, "order", "edit"))
    if order is None:
        raise HTTPException(404, "Order tidak ditemukan")
    return {"ok": True, "order": order}
