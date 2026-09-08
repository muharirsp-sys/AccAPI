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


def fake_auth(module):
    module.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    module.user_has_permission = lambda user, area, action: (
        action != "edit" or user == "admin@surya.local")
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

    ask = dict(outlet="TOKO SALES", channel="GT", order_date="2026-06-15",
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

    # Sales tidak boleh menarik order ke internal; itu wewenang petugas.
    assert client.post("/orders/pull", headers=SALES, json={}).status_code == 403

    pulled = client.post("/orders/pull", headers=ADMIN, json={})
    assert pulled.status_code == 200, pulled.text
    body = pulled.json()
    assert len(body["imported"]) == 2 and body["already_imported"] == [] and body["failed"] == [], body

    # Order hasil pull belum berharga: uang TIDAK dihitung dan aturan belum dibekukan.
    order_id = next(item["order_id"] for item in body["imported"] if item["request_id"] == request_id)
    order = client.get(f"/orders/{order_id}", headers=ADMIN).json()["order"]
    assert order["status"] == "needs_price" and order["request_id"] == request_id, order
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
    direct = client.post("/orders", headers=ADMIN, json={"outlet": "TOKO INTERNAL", "channel": "GT",
                                                         "order_date": "2026-06-15",
                                                         "lines": [dict(code="A", unit="PCS", quantity="10", price="1000")]})
    assert direct.json()["order"]["result"]["discount"] == "500.00", direct.text
    assert direct.json()["order"]["request_id"] is None, direct.json()["order"]
    print("websales split + pull check: OK")


if __name__ == "__main__":
    main()
