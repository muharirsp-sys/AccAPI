"""Tujuan: Self-check pemisahan basis data Web Sales dan pull idempoten ke internal.
Caller: `python test_websales_pull.py` (tanpa framework). Dependensi: routers.orders, routers.websales.
Main Functions: main; assert dua basis data terpisah, tanpa harga dari klien, pull tidak menggandakan.
Side Effects: Dua SQLite sementara di direktori temp; tidak memanggil Mistral/Accurate.
"""
import json
import os
import tempfile

_root = tempfile.mkdtemp(prefix="websales-check-")
os.environ["SUMMARY_STORE_PATH"] = os.path.join(_root, "summary.sqlite3")
os.environ["WEBSALES_STORE_PATH"] = os.path.join(_root, "websales.sqlite3")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import websales_store  # noqa: E402
from routers import orders, websales  # noqa: E402
from summary_store import connect, create_draft  # noqa: E402

SALES = {"X-Test-User": "sales@surya.local"}
ADMIN = {"X-Test-User": "admin@surya.local"}


def publish():
    program = dict(id="P1", name="Promo", start="2026-06-01", end="2026-06-30", codes=["A"], channel="GT",
                   unit="PCS", mix=False, threshold="quantity", value_scope="eligible", basis="gross", stacking=False,
                   priority=1, source_page=1, source_quote="kutipan",
                   tiers=[dict(minimum="1", percentages=["5"], rupiah="0", rupiah_mode="once",
                               bonus_code="", bonus_quantity="0", bonus_unit="PCS", bonus_scope="code", repeat=False)])
    draft = create_draft("admin@surya.local", "Surat", {"rows": [], "programs": [program]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published' WHERE id=?", (draft["id"],))


# Izin nyata yang dipakai: sales HANYA punya `websales`, petugas punya `order` + `websales`.
# Ini yang mencegah sales memakai POST /orders internal (yang menerima harga dari klien).
PERMISSIONS = {
    "sales@surya.local": {("websales", "view"), ("websales", "create")},
    "admin@surya.local": {("order", "view"), ("order", "create"), ("order", "edit"),
                          ("websales", "view"), ("websales", "create")},
}


def fake_auth(module):
    module.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    module.user_has_permission = lambda user, area, action: (area, action) in PERMISSIONS.get(user, set())
    module.validate_csrf_request = lambda request, token: True


def main():
    fake_auth(orders)
    fake_auth(websales)
    app = FastAPI()
    app.include_router(orders.router)
    app.include_router(websales.router)
    client = TestClient(app)
    publish()

    # Basis data Web Sales hanya berisi tabel permintaan order; tidak ada tabel internal.
    with websales_store.connect() as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert tables == {"order_request"}, tables

    ask = dict(outlet="TOKO SALES", channel="GT", order_date="2026-06-15", customer_no="C-001",
               lines=[dict(code="A", unit="PCS", quantity="10")])
    created = client.post("/websales/orders", headers=SALES, json=ask)
    assert created.status_code == 200, created.text
    request_id = created.json()["request"]["id"]
    assert created.json()["request"]["status"] == "pending"

    # Harga dari klien diabaikan: baris tersimpan hanya kode, satuan, jumlah.
    with_price = client.post("/websales/orders", headers=SALES,
                             json={**ask, "lines": [dict(code="A", unit="PCS", quantity="4", price="999999")]})
    assert set(with_price.json()["request"]["lines"][0]) == {"code", "unit", "quantity"}, with_price.json()

    # Jumlah tidak wajar ditolak di pintu masuk Web Sales.
    for bad in ([dict(code="A", unit="PCS", quantity="0")], [dict(code="A", unit="PCS", quantity="-2")],
                [dict(code="", unit="PCS", quantity="1")], [dict(code="A", unit="", quantity="1")]):
        assert client.post("/websales/orders", headers=SALES, json={**ask, "lines": bad}).status_code == 400, bad
    assert client.post("/websales/orders", headers=SALES, json={**ask, "order_date": "15-06-2026"}).status_code == 400
    # Pelanggan Accurate wajib: order tanpa itu tidak akan pernah bisa menjadi faktur.
    assert client.post("/websales/orders", headers=SALES, json={**ask, "customer_no": ""}).status_code == 400

    # Sales tidak boleh menarik order ke internal; itu wewenang petugas.
    assert client.post("/orders/pull", headers=SALES, json={}).status_code == 403

    # Sales juga TIDAK boleh memakai input order internal: endpoint itu menerima harga dari
    # klien, jadi izin `websales.create` sengaja tidak membuka `POST /orders`.
    blocked = client.post("/orders", headers=SALES, json={"outlet": "TOKO", "channel": "GT",
                                                          "order_date": "2026-06-15", "customer_no": "C-001",
                                                          "lines": [dict(code="A", unit="PCS", quantity="1", price="1")]})
    assert blocked.status_code == 403, blocked.text
    # Tapi sales HARUS bisa melihat nilai transaksi: pratinjau terbuka untuk keduanya.
    peek = client.post("/orders/preview", headers=SALES,
                       json={"channel": "GT", "order_date": "2026-06-15",
                             "lines": [dict(code="A", unit="PCS", quantity="10", price="1000")]})
    assert peek.status_code == 200 and peek.json()["result"]["discount"] == "500.00", peek.text

    pulled = client.post("/orders/pull", headers=ADMIN, json={})
    assert pulled.status_code == 200, pulled.text
    body = pulled.json()
    assert len(body["imported"]) == 2 and body["already_imported"] == [] and body["failed"] == [], body

    # Order hasil pull belum berharga: uang TIDAK dihitung dan aturan belum dibekukan.
    order_id = next(item["order_id"] for item in body["imported"] if item["request_id"] == request_id)
    order = client.get(f"/orders/{order_id}", headers=ADMIN).json()["order"]
    assert order["status"] == "needs_price" and order["request_id"] == request_id, order
    # Pelanggan ikut terbawa dari sisi sales; tanpa ini faktur tidak bisa dibuat.
    assert order["customer_no"] == "C-001", order
    assert order["result"] == {"pending_price": True, "lines": order["lines"]}, order["result"]
    with connect() as db:
        assert json.loads(db.execute("SELECT rules FROM sales_order WHERE id=?", (order_id,)).fetchone()[0]) == []

    # Pull kedua tidak menggandakan order walau permintaan sempat gagal ditandai.
    assert client.post("/orders/pull", headers=ADMIN, json={}).json()["imported"] == []
    with websales_store.connect() as db:
        db.execute("UPDATE order_request SET status='pending',pulled_at=NULL WHERE id=?", (request_id,))
    repeat = client.post("/orders/pull", headers=ADMIN, json={}).json()
    assert repeat["imported"] == [] and repeat["already_imported"] == [request_id], repeat
    with connect() as db:
        count = db.execute("SELECT count(*) FROM sales_order WHERE request_id=?", (request_id,)).fetchone()[0]
    assert count == 1, count
    assert websales_store.get_request(request_id)["status"] == "pulled"

    # Input internal langsung tetap menghitung uang dan membekukan aturan.
    internal = {"outlet": "TOKO INTERNAL", "channel": "GT", "order_date": "2026-06-15",
                "customer_no": "C-002",
                "lines": [dict(code="A", unit="PCS", quantity="10", price="1000")]}
    assert client.post("/orders", headers=ADMIN, json={**internal, "customer_no": ""}).status_code == 400
    direct = client.post("/orders", headers=ADMIN, json=internal)
    assert direct.json()["order"]["result"]["discount"] == "500.00", direct.text
    assert direct.json()["order"]["customer_no"] == "C-002", direct.json()["order"]
    assert direct.json()["order"]["request_id"] is None, direct.json()["order"]

    check_connection(client)
    print("websales split + pull check: OK")


def check_connection(client):
    """Koneksi 5 menit: mati = no-op, hidup = menarik, secret salah/absen = tolak."""
    os.environ.pop("CRON_SECRET", None)
    assert client.post("/orders/pull-cron").status_code == 503

    os.environ["CRON_SECRET"] = "rahasia-uji"
    assert client.post("/orders/pull-cron", headers={"X-Cron-Secret": "salah"}).status_code == 403
    assert client.post("/orders/pull-cron").status_code == 403

    # Default mati: cron boleh terpasang tanpa efek apa pun.
    cron = {"X-Cron-Secret": "rahasia-uji"}
    # Status koneksi adalah urusan internal: sales tidak boleh melihatnya.
    assert client.get("/orders/connection", headers=SALES).status_code == 403
    status = client.get("/orders/connection", headers=ADMIN).json()
    assert status["connection"]["enabled"] is False, status
    assert client.post("/orders/pull-cron", headers=cron).json()["skipped"], "koneksi mati harus no-op"

    # Sales tidak boleh menyalakan koneksi; itu wewenang petugas.
    assert client.post("/orders/connection", headers=SALES, json={"enabled": True}).status_code == 403
    assert client.post("/orders/connection", headers=ADMIN, json={"enabled": "ya"}).status_code == 400

    client.post("/websales/orders", headers=SALES, json=dict(
        outlet="TOKO CRON", channel="GT", order_date="2026-06-15", customer_no="C-003",
        lines=[dict(code="A", unit="PCS", quantity="3")]))
    assert client.get("/orders/connection", headers=ADMIN).json()["pending"] == 1

    on = client.post("/orders/connection", headers=ADMIN, json={"enabled": True})
    assert on.status_code == 200 and on.json()["connection"]["owner"], on.text

    ran = client.post("/orders/pull-cron", headers=cron).json()
    assert len(ran["imported"]) == 1 and "skipped" not in ran, ran
    # Order otomatis dimiliki petugas yang menyalakan koneksi, bukan tanpa pemilik.
    order_id = ran["imported"][0]["order_id"]
    assert client.get(f"/orders/{order_id}", headers=ADMIN).status_code == 200
    after = client.get("/orders/connection", headers=ADMIN).json()
    assert after["connection"]["last_run_at"] and after["pending"] == 0, after
    assert after["connection"]["last_result"] == {"imported": 1, "already_imported": 0, "failed": 0}, after

    # Dimatikan: penarikan berhenti walau ada permintaan baru menunggu.
    client.post("/orders/connection", headers=ADMIN, json={"enabled": False})
    client.post("/websales/orders", headers=SALES, json=dict(
        outlet="TOKO SETELAH MATI", channel="GT", order_date="2026-06-15", customer_no="C-004",
        lines=[dict(code="A", unit="PCS", quantity="1")]))
    assert client.post("/orders/pull-cron", headers=cron).json()["skipped"], "koneksi mati harus berhenti menarik"
    assert client.get("/orders/connection", headers=ADMIN).json()["pending"] == 1


if __name__ == "__main__":
    main()
