"""Tujuan: Endpoint Web Sales: sales mengirim permintaan order berisi kuantitas saja.
Caller: layar Order Sales (app/(dashboard)/sales) dan pengujian.
Dependensi: shared auth/RBAC, websales_store, routers.orders (hitung_order + cocokkan: hitungan promo yang SAMA dengan pratinjau).
Main Functions: create_request_endpoint, list_requests.
Side Effects: Tulis ke basis data Web Sales; HTTP ke Next (order_cabang, outlet_channel) dan BACA aturan terbit saat simpan. Tidak
menulis store internal; harga tidak disimpan di permintaan.

Harga sengaja tidak diminta dari sales: uang dihitung server (harga master per cabang pelanggan + promo terbit), sehingga klien tidak
pernah menentukan nilai transaksi.

O1 (owner 12 Okt 2026): sebelum disimpan, permintaan dihitung LENGKAP dengan SESI sales ini (`hitung_order` + cookie): channel = master,
salesman tertaut ke karyawan Accurate dan hanya cabangnya, pelanggan aktif, barang = cabang pelanggan, harga sah, lalu promo — dan
angkanya WAJIB sama dengan pratinjau yang dilihat sales (`sidik`, `PRATINJAU_BERUBAH`). Ditolak berkode di sini, bukan baru gagal saat
tarik. Yang disimpan: kuantitas + sidik; angka uang dibekukan saat tarik dari sumber yang sama dan dicocokkan lagi dengan sidik ini.
"""
import json
from datetime import date
from fastapi import APIRouter, HTTPException, Request
import order_cabang
from routers import orders
from shared import get_current_user, user_has_permission, validate_csrf_request
from summary_store import identity
from websales_store import connect, create_request

router = APIRouter(prefix="/websales")


def require_sales(request, create=False):
    """Izin `websales`, BUKAN `order`.

    Sales tidak boleh punya `order.create`: `POST /orders` internal menerima harga dari
    klien (input manual petugas), jadi izin yang sama akan membuat sales bisa menentukan
    nilai transaksi lewat pintu lain. Petugas internal boleh punya keduanya.
    """
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Silakan login")
    if not user_has_permission(user, "websales", "create" if create else "view"):
        raise HTTPException(403, "Akses order sales tidak diizinkan")
    if create and not validate_csrf_request(request, request.headers.get("X-CSRF-Token", "")):
        raise HTTPException(403, "Permintaan lintas situs ditolak")
    return identity(user)


@router.post("/orders")
async def create_request_endpoint(request: Request):
    sales = require_sales(request, True)
    raw = await request.body()
    if len(raw) > 256 * 1024:
        raise HTTPException(413, "Permintaan order maksimal 256 KB")
    try:
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, "Format permintaan tidak valid") from None
    outlet = str(body.get("outlet", "")).strip()
    channel = str(body.get("channel", "")).strip().upper()
    order_date = str(body.get("order_date", "")).strip()
    customer_no = str(body.get("customer_no", "")).strip()
    lines = body.get("lines")
    try:
        # Tanggal diperiksa di pintu masuk; tanggal ngawur tidak boleh baru gagal saat pull.
        valid_date = date.fromisoformat(order_date).isoformat() == order_date
    except ValueError:
        valid_date = False
    if not outlet or not channel or not valid_date:
        raise HTTPException(400, "Outlet, channel, dan tanggal order (YYYY-MM-DD) wajib diisi")
    # Pelanggan Accurate wajib: tanpa `customerNo` order tidak bisa menjadi faktur.
    if not customer_no:
        raise HTTPException(400, "Kode pelanggan Accurate wajib diisi")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 200:
        raise HTTPException(400, "Permintaan order harus memiliki 1–200 baris")
    clean = []
    for line in lines:
        if not isinstance(line, dict):
            raise HTTPException(400, "Baris order tidak valid")
        code, unit = str(line.get("code", "")).strip(), str(line.get("unit", "")).strip().upper()
        quantity = str(line.get("quantity", "")).strip()
        if not code or not unit or not quantity.isdigit() or int(quantity) <= 0:
            raise HTTPException(400, "Setiap baris butuh kode, satuan, dan jumlah bulat lebih dari nol")
        # Harga dari klien TIDAK pernah dibaca: baris hanya kode, satuan, jumlah.
        clean.append({"code": code[:80], "unit": unit[:30], "quantity": quantity})
    try:
        hasil = orders.hitung_order(customer_no, channel, order_date, clean, cookie=request.headers.get("cookie", ""))
        orders.cocokkan(hasil, body.get("sidik"))
    except (order_cabang.OrderCabangDitolak, order_cabang.OrderCabangTidakPasti) as error:
        return orders.jawab(error)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, orders.public_error(error)) from None
    return {"ok": True, "request": create_request(sales, outlet, channel, order_date,
                                                  str(body.get("note", "")), clean, customer_no, hasil["sidik"])}


@router.get("/orders")
def list_requests(request: Request):
    sales = require_sales(request)
    with connect() as db:
        rows = db.execute("SELECT id,outlet,channel,order_date,customer_no,status,created_at,pulled_at,reject_code,reject_reason,rejected_at"
                          " FROM order_request WHERE sales=? ORDER BY created_at DESC,id DESC LIMIT 100", (sales,)).fetchall()
    return {"ok": True, "requests": [dict(row) for row in rows]}
