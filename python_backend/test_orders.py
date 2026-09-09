"""Tujuan: Self-check order masuk: aturan terbit dibekukan pada order dan izin ditegakkan.
Caller: `python test_orders.py` (tanpa framework). Dependensi: routers.orders, summary_store.
Main Functions: main; assert pembekuan versi, filter channel/tanggal, izin, dan kepemilikan.
Side Effects: SQLite sementara di direktori temp; tidak memanggil Mistral/Accurate.
"""
import json
import os
import tempfile

os.environ["SUMMARY_STORE_PATH"] = os.path.join(tempfile.mkdtemp(prefix="order-check-"), "summary.sqlite3")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routers import orders  # noqa: E402
from summary_store import connect, create_draft  # noqa: E402

SALES = {"X-Test-User": "sales@surya.local"}
ADMIN = {"X-Test-User": "admin@surya.local"}
GUEST = {"X-Test-User": "tamu@surya.local"}


def publish(percentage, code="A", program_id="P1"):
    """Draft terbit berisi satu program persen; dipakai untuk menguji pembekuan versi."""
    program = dict(id=program_id, name="Promo", start="2026-06-01", end="2026-06-30", codes=[code], channel="GT",
                   unit="PCS", mix=False, threshold="quantity", value_scope="eligible", basis="gross", stacking=False,
                   priority=1, source_page=1, source_quote="kutipan",
                   tiers=[dict(minimum="1", percentages=[percentage], rupiah="0", rupiah_mode="once",
                               bonus_code="", bonus_quantity="0", bonus_unit="PCS", bonus_scope="code", repeat=False)])
    draft = create_draft("sales@surya.local", "Surat", {"rows": [], "programs": [program]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published' WHERE id=?", (draft["id"],))
    return draft["id"]


def main():
    orders.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    orders.user_has_permission = lambda user, area, action: (
        user != "tamu@surya.local" and (action != "edit" or user == "admin@surya.local"))
    orders.validate_csrf_request = lambda request, token: True
    app = FastAPI()
    app.include_router(orders.router)
    client = TestClient(app)
    body = dict(outlet="TOKO UJI", channel="GT", order_date="2026-06-15", customer_no="C-001",
                lines=[dict(code="A", unit="PCS", quantity="10", price="1000")])

    # Tanpa aturan terbit, order tidak boleh dihitung diam-diam.
    assert client.post("/orders", headers=SALES, json=body).status_code == 409

    first = publish("5")
    created = client.post("/orders", headers=SALES, json=body)
    assert created.status_code == 200, created.text
    order = created.json()["order"]
    assert order["result"]["discount"] == "500.00" and order["status"] == "draft", order
    assert order["sources"] == [{"draft_id": first, "revision": 1}], order["sources"]

    # Promo baru TIDAK mengubah order lama; order berikutnya memakai aturan baru.
    publish("10", code="A", program_id="P2")
    again = client.get(f"/orders/{order['id']}", headers=SALES).json()["order"]
    assert again["result"]["discount"] == "500.00", again["result"]
    assert len(again["sources"]) == 1, again["sources"]
    # Dua surat terbit, keduanya tidak boleh digabung: yang lebih dulu terbit menang, bukan yang ID-nya kebetulan kecil.
    newer = client.post("/orders", headers=SALES, json=body).json()["order"]
    assert newer["result"]["discount"] == "500.00", newer["result"]
    assert newer["result"]["applications"][0]["program_id"].endswith(":P1"), newer["result"]["applications"]
    assert len(newer["sources"]) == 2 and newer["sources"][0]["draft_id"] == first, newer["sources"]

    # Pratinjau: nilai transaksi + saran, tanpa menyimpan order, dan menolak baris tanpa harga.
    before = len(client.get("/orders", headers=SALES).json()["orders"])
    preview = client.post("/orders/preview", headers=SALES, json=body)
    assert preview.status_code == 200, preview.text
    assert preview.json()["result"]["discount"] == "500.00", preview.json()["result"]
    assert len(client.get("/orders", headers=SALES).json()["orders"]) == before, "pratinjau tidak boleh menyimpan"
    assert client.post("/orders/preview", headers=SALES,
                       json={**body, "lines": [dict(code="A", unit="PCS", quantity="10")]}).status_code == 400

    # Saran muncul saat order belum mencapai tier; program 12+1 pada order 10 pcs.
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='withdrawn'")
    paket = dict(id="PKT", name="Paket", start="2026-06-01", end="2026-06-30", codes=["A"], channel="GT",
                 unit="PCS", mix=False, threshold="quantity", value_scope="eligible", basis="gross", stacking=False,
                 priority=1, source_page=1, source_quote="kutipan",
                 tiers=[dict(minimum="12", percentages=[], rupiah="0", rupiah_mode="once", bonus_code="A",
                             bonus_quantity="1", bonus_unit="PCS", bonus_scope="code", repeat=False)])
    draft = create_draft("sales@surya.local", "Paket", {"rows": [], "programs": [paket]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published' WHERE id=?", (draft["id"],))
    advice = client.post("/orders/preview", headers=SALES, json=body).json()["suggestions"]
    assert len(advice) == 1 and advice[0]["gap"] == "2", advice
    assert "Tambah 2 PCS lagi" in advice[0]["message"], advice[0]["message"]
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='withdrawn' WHERE id=?", (draft["id"],))
        db.execute("UPDATE summary_draft SET status='published' WHERE id!=?", (draft["id"],))

    # Channel dan tanggal di luar cakupan menghasilkan nol benefit, bukan galat.
    other = client.post("/orders", headers=SALES, json={**body, "channel": "MT"}).json()["order"]
    assert other["result"]["discount"] == "0.00", other["result"]
    later = client.post("/orders", headers=SALES, json={**body, "order_date": "2026-07-01"}).json()["order"]
    assert later["result"]["discount"] == "0.00", later["result"]

    # Baris dan tanggal tidak valid ditolak dengan pesan, tanpa order tersimpan.
    for bad, note in [({**body, "lines": []}, "kosong"),
                      ({**body, "lines": [dict(code="A", unit="PCS", quantity="0", price="1000")]}, "kuantitas nol"),
                      ({**body, "order_date": "15 Juni 2026"}, "tanggal tidak baku"),
                      ({**body, "outlet": ""}, "outlet kosong"),
                      # Tanpa pelanggan Accurate, order tidak akan pernah bisa menjadi faktur.
                      ({**body, "customer_no": ""}, "pelanggan kosong")]:
        assert client.post("/orders", headers=SALES, json=bad).status_code == 400, note

    # Izin: tamu ditolak, pemilik hanya melihat ordernya, admin boleh melihat semua.
    assert client.post("/orders", json=body).status_code == 401
    assert client.post("/orders", headers=GUEST, json=body).status_code == 403
    assert client.get(f"/orders/{order['id']}", headers=ADMIN).status_code == 200
    assert client.get(f"/orders/{order['id']}", headers={"X-Test-User": "lain@surya.local"}).status_code == 404
    assert client.get("/orders", headers=SALES).json()["scope"] == "mine"
    assert client.get("/orders?scope=all", headers=ADMIN).json()["scope"] == "all"
    assert client.get("/orders?scope=all", headers=SALES).json()["scope"] == "mine"

    # Aturan beku tersimpan utuh pada order, bukan hanya nomor versinya.
    with connect() as db:
        stored = json.loads(db.execute("SELECT rules FROM sales_order WHERE id=?", (order["id"],)).fetchone()[0])
    assert len(stored) == 1 and stored[0]["tiers"][0]["percentages"] == ["5"], stored
    print("order freeze check: OK")


if __name__ == "__main__":
    main()
