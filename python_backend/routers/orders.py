"""Tujuan: Order masuk dengan aturan promo terbit yang dibekukan pada saat pengiriman.
Caller: halaman order internal; Web Sales terpisah akan memakai endpoint yang sama.
Dependensi: shared auth/RBAC, summary_store, summary_rules (Program, calculate), websales_store.
Main Functions: published_rules, preview_order, create_order, pull_requests, list_orders, order_detail (termasuk aturan beku untuk faktur).
Side Effects: SQLite read/write; tidak menulis faktur Accurate dan tidak memanggil AI.
"""
import hmac
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request
from order_duplicate import duplicate_message, find_duplicate
from pydantic import ValidationError
from shared import get_current_user, user_has_permission, validate_csrf_request
from summary_store import JsonStore, connect, identity
from summary_rules import Program, calculate, suggestions
import outlet_class
import outlet_channel
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


def duplicate_check(owner, outlet, channel, order_date, lines):
    """Order lain milik outlet dan tanggal yang sama yang isinya MIRIP, atau None.

    Dijalankan sebelum order disimpan, dan menahan DUA jalur sekaligus karena keduanya lewat
    `store_order`: Order Sales (diketik) dan Order Masuk (tarikan Web Sales).

    Yang dibandingkan kode barangnya saja, bukan jumlah maupun harganya: ketikan ulang hampir
    selalu mengubah jumlah, dan justru itu yang membuatnya lolos kalau yang dibandingkan angka.
    """
    codes = [str(line.get("code", "")).strip() for line in lines]
    candidate = {"key": "", "outlet": outlet, "order_date": order_date, "item_codes": codes}
    # Jendela bandingnya dipersempit di SINI, bukan di dalam pemeta: channel yang berbeda
    # adalah jalur order yang berbeda, dan ketikan ulang hampir selalu mengulang channel yang
    # sama. Menyertakannya berarti menahan order MT hanya karena outletnya juga order GT hari itu.
    with connect() as db:
        rows = db.execute(
            "SELECT id,outlet,order_date,lines FROM sales_order WHERE owner=? AND outlet=? AND channel=? "
            "AND order_date=? AND status<>'cancelled' ORDER BY rowid DESC LIMIT 200",
            (owner, outlet[:160], channel[:80], order_date)).fetchall()
    existing = []
    for row in rows:
        try:
            isi = json.loads(row[3]) or []
        except (ValueError, TypeError):
            continue
        existing.append({"key": row[0], "outlet": row[1], "order_date": row[2],
                         "item_codes": [str(line.get("code", "")).strip() for line in isi]})
    return find_duplicate(candidate, existing)


def store_order(owner, outlet, channel, order_date, note, lines, request_id=None, customer_no="",
                confirm_duplicate=False):
    """Hitung dengan aturan terbit lalu bekukan aturan, sumber, dan hasilnya pada order.

    Baris tanpa harga (permintaan dari Web Sales) TIDAK dihitung sebagai uang: order
    masuk berstatus `needs_price` dengan aturan belum dibekukan, supaya nilai transaksi
    tidak pernah ditentukan oleh klien. Harga diisi internal (tahap Accurate).

    GERBANG ORDER GANDA: order yang outletnya sama dan barangnya MIRIP dengan order lain pada
    tanggal yang sama DITOLAK, sampai ada manusia yang menyatakan sudah memeriksanya lewat
    `confirm_duplicate`. Ditolak, bukan disimpan dengan tanda — order yang tersimpan akan
    terlihat seperti order biasa oleh setiap layar yang membacanya, dan tandanya akan terlewat.
    Yang datang dari Web Sales tidak hilang: permintaannya tetap `pending` dan dilaporkan sebagai
    `failed`, jadi ia menunggu keputusan manusia alih-alih ikut terproses.
    """
    # CHANNEL DIPASTIKAN KE MASTER, bukan dipercaya dari yang mengirim.
    #
    # `calculate` di bawah menyaring promo dengan `program.channel`, tetapi channel yang
    # dipakainya selama ini datang dari badan permintaan — diketik pengirim order. Yang
    # diperiksa jadi channel yang DIAKUI, bukan yang TERBUKTI, dan surat "KHUSUS CHANNEL GT"
    # bisa jatuh ke outlet yang master kita sendiri menyebutnya MT. Sudah ada contohnya di
    # jalur principal: HINDA MART (C-HIL009) disebut General Trade oleh Kino, master kita MT.
    #
    # Ditanyakan ke Next, bukan dibaca dari salinan lokal — lihat `outlet_channel`. Gagal
    # tertutup: tidak ada jawaban berarti ordernya ditahan. Diperiksa SEBELUM apa pun dihitung,
    # karena hasil hitungan dengan channel yang salah tidak layak disimpan meski cuma draft.
    try:
        outlet_channel.verify(customer_no, channel)
    except outlet_channel.ChannelTidakPasti as error:
        raise HTTPException(422, str(error)) from None

    priced = all(str(line.get("price", "")).strip() for line in lines)
    programs, sources = published_rules()
    if not programs:
        raise HTTPException(409, "Belum ada aturan promo terbit; terbitkan Summary sebelum order dihitung")
    if priced:
        result = calculate(programs, lines, order_date, channel,
                           outlet_classes=outlet_class.classes_of(customer_no), known_classes=outlet_class.known())
        frozen = [program.model_dump(mode="json") for program in programs]
        status = "draft"
    else:
        result, frozen, status = {"pending_price": True, "lines": lines}, [], "needs_price"
    # Gerbang ganda diperiksa SETELAH ordernya terbukti sah, bukan sebelum: order yang isinya
    # tidak valid harus ditolak karena tidak valid, bukan karena mirip. Meminta manusia
    # mengonfirmasi order yang toh tidak bisa disimpan hanya melatihnya menekan tombol.
    if not confirm_duplicate:
        hit = duplicate_check(owner, outlet, channel, order_date, lines)
        if hit:
            raise HTTPException(409, duplicate_message(hit))

    order_id = str(uuid.uuid4())
    # Jejak konfirmasi ikut pada catatan ordernya: siapa pun yang membuka order ini nanti harus
    # bisa tahu bahwa ia pernah ditahan sebagai dugaan ganda, dan sengaja diloloskan.
    if confirm_duplicate:
        note = (note + " | dikonfirmasi BUKAN order ganda").strip()[:500]
    with connect() as db:
        db.execute("INSERT INTO sales_order(id,owner,outlet,channel,order_date,status,note,lines,rules,sources,"
                   "result,request_id,customer_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (order_id, owner, outlet[:160], channel[:80], order_date, status, note,
                    json.dumps(lines, ensure_ascii=False), json.dumps(frozen, ensure_ascii=False),
                    json.dumps(sources, ensure_ascii=False), json.dumps(result, ensure_ascii=False), request_id,
                    customer_no[:80]))
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

    Boleh dipakai petugas internal (`order.create`) maupun sales (`websales.create`):
    sales HARUS melihat nilai transaksi dan promo yang berlaku; yang tidak boleh adalah
    klien MENENTUKAN harga.
    """
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Silakan login")
    if not (user_has_permission(user, "order", "create") or user_has_permission(user, "websales", "create")):
        raise HTTPException(403, "Akses pratinjau order tidak diizinkan")
    if not validate_csrf_request(request, request.headers.get("X-CSRF-Token", "")):
        raise HTTPException(403, "Permintaan lintas situs ditolak")
    body, channel, order_date, clean = await read_order_body(request, 512 * 1024)
    if any(not line["price"] for line in clean):
        raise HTTPException(400, "Setiap baris pratinjau butuh harga dari server")
    programs, sources = published_rules()
    # Kelayakan outlet ikut dihitung di pratinjau: sales harus melihat angka yang sama
    # dengan yang nanti dibekukan pada order, termasuk promo yang TIDAK berlaku untuknya.
    customer_no = str(body.get("customer_no", "")).strip()
    outlets, tahu = outlet_class.classes_of(customer_no), outlet_class.known()
    # Channel dilaporkan, TIDAK dilemparkan sebagai galat, di pratinjau: sales sedang mengetik,
    # dan angka harganya tetap berguna sambil ia membetulkan channelnya. Yang tidak boleh adalah
    # ia baru tahu ordernya akan ditolak setelah seluruh baris diketik — jadi sebabnya muncul
    # sekarang, dengan kalimat yang sama persis dengan yang nanti menolaknya.
    channel_masalah = ""
    try:
        outlet_channel.verify(customer_no, channel)
    except outlet_channel.ChannelTidakPasti as error:
        channel_masalah = str(error)
    try:
        result = calculate(programs, clean, order_date, channel, outlet_classes=outlets, known_classes=tahu) if programs else None
        advice = suggestions(programs, clean, order_date, channel, outlet_classes=outlets, known_classes=tahu) if programs else []
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, public_error(error)) from None
    return {"ok": True, "result": result, "suggestions": advice, "sources": sources,
            "channel_masalah": channel_masalah}


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
    customer_no = str(body.get("customer_no", "")).strip()
    lines = body.get("lines")
    if not outlet or not channel or not order_date:
        raise HTTPException(400, "Outlet, channel, dan tanggal order wajib diisi")
    # `customerNo` adalah field WAJIB sales-invoice/save.do dan nomor faktur milik Accurate;
    # order tanpa pelanggan tidak akan pernah bisa menjadi faktur, jadi ditolak di sini.
    if not customer_no:
        raise HTTPException(400, "Kode pelanggan Accurate wajib diisi")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 500:
        raise HTTPException(400, "Order harus memiliki 1–500 baris")
    clean = []
    for line in lines:
        if not isinstance(line, dict):
            raise HTTPException(400, "Baris order tidak valid")
        clean.append({key: str(line.get(key, "")).strip() for key in ("code", "unit", "quantity", "price")})
    try:
        order_id = store_order(identity(user), outlet, channel, order_date, note, clean,
                               customer_no=customer_no,
                               confirm_duplicate=body.get("confirm_duplicate") is True)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, public_error(error)) from None
    return {"ok": True, "order": order_detail_row(order_id, user)}


def pull_once(owner, confirm_duplicate=False):
    """Tarik permintaan order Web Sales ke internal. Aman diulang.

    Dua basis data tidak bisa satu transaksi, jadi urutannya: tulis order internal
    dengan `request_id` unik lebih dulu, baru tandai permintaan sebagai `pulled`.
    Bila penandaan gagal, pull berikutnya menabrak kunci unik dan permintaan itu
    hanya ditandai, bukan digandakan. Karena itu dua pull yang jalan bersamaan pun
    tidak menggandakan order — kunci unik yang menjaga, bukan penjadwalannya.
    """
    imported, duplicated, failed = [], [], []
    for entry in websales_store.pending():
        # SUDAH DITARIK diperiksa LEBIH DULU, bukan diserahkan ke kunci unik.
        #
        # Selama ini jaminannya dipegang `sales_order_request`: pull kedua menabrak kunci unik,
        # permintaannya ditandai, dan tidak ada order kedua. Gerbang order ganda yang datang
        # kemudian menahan permintaan itu lebih awal dengan HTTP 409, jadi kunci uniknya tidak
        # pernah sempat berbunyi — permintaan yang ordernya SUDAH ADA masuk ke `failed`, TIDAK
        # ditandai `pulled`, dan muncul lagi sebagai "dugaan order ganda" pada setiap tarikan
        # berikutnya. Yang ia gandakan memang dirinya sendiri; itu bukan pertanyaan untuk orang.
        with connect() as db:
            sudah = db.execute("SELECT id FROM sales_order WHERE request_id=?", (entry["id"],)).fetchone()
        if sudah:
            duplicated.append(entry["id"])
            continue
        try:
            order_id = store_order(owner, entry["outlet"], entry["channel"], entry["order_date"],
                                   entry["note"], entry["lines"], request_id=entry["id"],
                                   customer_no=entry.get("customer_no", ""),
                                   confirm_duplicate=confirm_duplicate)
            imported.append({"request_id": entry["id"], "order_id": order_id})
        except sqlite3.IntegrityError:
            duplicated.append(entry["id"])
        except HTTPException as error:
            # Dugaan order ganda hanya menahan permintaan ITU; permintaan lain pada tarikan yang
            # sama tetap diproses. Galat lain (mis. aturan promo belum terbit) memang menghentikan
            # seluruh tarikan, karena ia bukan soal satu permintaan.
            if error.status_code != 409:
                raise
            failed.append({"request_id": entry["id"], "error": error.detail, "duplicate": True})
            continue
        except (ValueError, KeyError, TypeError) as error:
            failed.append({"request_id": entry["id"], "error": public_error(error)})
            continue
        websales_store.mark_pulled(entry["id"])
    for request_id in duplicated:
        websales_store.mark_pulled(request_id)
    return {"imported": imported, "already_imported": duplicated, "failed": failed}


@router.post("/pull")
async def pull_requests(request: Request):
    """Tarik manual oleh petugas; jalur otomatis ada di /orders/pull-cron."""
    user = require_user(request, True)
    if not user_has_permission(user, "order", "edit"):
        raise HTTPException(403, "Hanya petugas yang boleh menarik order Web Sales")
    return {"ok": True, **pull_once(identity(user))}


# Koneksi Web Sales: petugas menyalakan, penarikan berjalan sampai dinonaktifkan.
#
# ponytail: TIDAK ada worker asyncio di dalam FastAPI. Penjadwalnya cron 5 menit yang sudah
# terpasang (pola sama dengan /api/cron/sync-accurate), dan endpoint ini no-op saat koneksi
# mati. Alasannya: status bertahan melewati restart, tidak ada dua worker saat uvicorn
# dijalankan multi-proses, dan tidak ada task yang harus dimatikan rapi. Naikkan ke worker
# in-process hanya kalau latensi 5 menit terbukti tidak cukup.
CONNECTION = JsonStore("websales_connection")
BLANK_CONNECTION = {"enabled": False, "owner": "", "updated_by": "", "updated_at": "",
                    "last_run_at": "", "last_result": None}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connection_state():
    try:
        return {**BLANK_CONNECTION, **CONNECTION["state"]}
    except (KeyError, ValueError):
        return dict(BLANK_CONNECTION)


@router.get("/connection")
def connection_status(request: Request):
    require_user(request)
    return {"ok": True, "connection": connection_state(), "pending": websales_store.pending_count()}


@router.post("/connection")
async def set_connection(request: Request):
    user = require_user(request, True)
    if not user_has_permission(user, "order", "edit"):
        raise HTTPException(403, "Hanya petugas yang boleh mengatur koneksi Web Sales")
    try:
        body = json.loads(await request.body() or b"{}")
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, "Format permintaan tidak valid") from None
    if not isinstance(body.get("enabled"), bool):
        raise HTTPException(400, "Kirim enabled true atau false")
    state = connection_state()
    # Order hasil tarik otomatis dimiliki petugas yang menyalakan koneksi — itu yang
    # membuatnya terlihat di "Milik saya" dan jelas siapa yang bertanggung jawab.
    state.update(enabled=body["enabled"], updated_by=identity(user), updated_at=now_iso())
    if body["enabled"]:
        state["owner"] = identity(user)
    CONNECTION["state"] = state
    return {"ok": True, "connection": state, "pending": websales_store.pending_count()}


@router.post("/pull-cron")
async def pull_cron(request: Request):
    """Dipanggil penjadwal tiap 5 menit; TIDAK memakai sesi pengguna.

    Secret dibandingkan konstan-waktu dan wajib ada: tanpa `CRON_SECRET` endpoint ini
    menolak, bukan terbuka.
    """
    secret = str(os.getenv("CRON_SECRET", "")).strip()
    if not secret:
        raise HTTPException(503, "CRON_SECRET belum dikonfigurasi di server")
    if not hmac.compare_digest(str(request.headers.get("X-Cron-Secret", "")), secret):
        raise HTTPException(403, "Secret penjadwal tidak cocok")
    state = connection_state()
    if not state["enabled"]:
        return {"ok": True, "skipped": "koneksi Web Sales dimatikan", "imported": [],
                "already_imported": [], "failed": []}
    if not state["owner"]:
        raise HTTPException(409, "Koneksi aktif tanpa pemilik; nyalakan ulang dari halaman Order Masuk")
    result = pull_once(state["owner"])
    state.update(last_run_at=now_iso(),
                 last_result={key: len(value) for key, value in result.items()})
    CONNECTION["state"] = state
    return {"ok": True, **result}


def order_detail_row(order_id, user, everyone=False):
    with connect() as db:
        query = ("SELECT id,owner,outlet,channel,order_date,status,note,lines,rules,sources,result,request_id,"
                 "customer_no,created_at FROM sales_order WHERE id=?")
        row = db.execute(query if everyone else query + " AND owner=?", (order_id,) if everyone else (order_id, identity(user))).fetchone()
    if row is None:
        return None
    value = dict(row)
    for key in ("lines", "rules", "sources", "result"):
        value[key] = json.loads(value[key])
    return value


@router.get("")
def list_orders(request: Request, scope: str = "mine"):
    user = require_user(request)
    everyone = scope == "all" and user_has_permission(user, "order", "edit")
    with connect() as db:
        query = ("SELECT id,owner,outlet,channel,order_date,status,result,request_id,customer_no,created_at"
                 " FROM sales_order "
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
