"""Tujuan: Self-check pemisahan basis data Web Sales dan pull idempoten ke internal.
Caller: `python test_websales_pull.py` (tanpa framework). Dependensi: routers.orders, routers.websales.
Main Functions: main; assert dua basis data terpisah, tanpa harga dari klien, pull tidak menggandakan, dan (O1/BL-18) order tarikan
berharga server -> draft siap antre faktur; aturan cabang ditanya di simpan (sesi sales) dan di tarik (layanan).
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

import order_cabang  # noqa: E402
import outlet_channel  # noqa: E402
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


# Jembatan Next `/api/orders/harga` dipalsukan (perilaku HTTP-nya diuji di `test_order_cabang`). Harga server 1000 per baris;
# TOLAK[kode pelanggan] = (status, kode) menolak order pelanggan itu. PANGGILAN mencatat jalur (sesi/layanan) dan mode harga.
PANGGILAN = []
TOLAK = {}


def periksa_palsu(customer_no, order_date, lines, cookie=None, harga=True):
    PANGGILAN.append({"customer_no": customer_no, "sesi": cookie is not None, "harga": harga})
    if customer_no in TOLAK:
        status, kode = TOLAK[customer_no]
        if kode == "TIDAK_PASTI":
            raise order_cabang.OrderCabangTidakPasti("Next tidak menjawab")
        raise order_cabang.OrderCabangDitolak(status, kode, f"ditolak {kode}", {"barang": ["A"]})
    return [{**line, "price": "1000"} if harga else dict(line) for line in lines]


def fake_auth(module):
    module.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    module.user_has_permission = lambda user, area, action: (area, action) in PERMISSIONS.get(user, set())
    module.validate_csrf_request = lambda request, token: True


def main():
    # Channel outlet ditanyakan ke Next sejak PR #64. Self-check tidak boleh menuntut layanan
    # hidup: yang diuji di sini alur order, bukan jembatan channelnya (itu `test_outlet_channel`).
    outlet_channel.verify = lambda customer_no, channel: channel
    order_cabang.periksa = periksa_palsu
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
    # O1: simpan Order Sales memeriksa aturan cabang lewat SESI sales (cakupan cabang salesman), dengan harga (tersedia?) —
    # tetapi harganya TIDAK disimpan di permintaan (dibekukan saat tarik).
    assert PANGGILAN[-1] == {"customer_no": "C-001", "sesi": True, "harga": True}, PANGGILAN
    assert set(created.json()["request"]["lines"][0]) == {"code", "unit", "quantity"}, created.json()

    # Ditolak Next (mis. barang beda cabang / salesman belum tertaut) -> kodenya sampai ke sales, tidak ada yang tersimpan.
    TOLAK["C-TOLAK"] = (409, "BARANG_BEDA_CABANG")
    sebelum = websales_store.pending_count()
    ditolak = client.post("/websales/orders", headers=SALES, json={**ask, "outlet": "TOKO TOLAK", "customer_no": "C-TOLAK"})
    assert ditolak.status_code == 409 and ditolak.json()["kode"] == "BARANG_BEDA_CABANG", ditolak.text
    assert ditolak.json()["detail"] and ditolak.json()["barang"] == ["A"], ditolak.text
    TOLAK["C-SALES"] = (403, "SALESMAN_BELUM_TERHUBUNG")
    belum = client.post("/websales/orders", headers=SALES, json={**ask, "outlet": "TOKO X", "customer_no": "C-SALES"})
    assert belum.status_code == 403 and belum.json()["kode"] == "SALESMAN_BELUM_TERHUBUNG", belum.text
    # Next tak pasti -> 503, juga tidak tersimpan (gagal tertutup).
    TOLAK["C-DIAM"] = (0, "TIDAK_PASTI")
    assert client.post("/websales/orders", headers=SALES, json={**ask, "outlet": "TOKO Y", "customer_no": "C-DIAM"}).status_code == 503
    assert websales_store.pending_count() == sebelum

    # Harga dari klien diabaikan: baris tersimpan hanya kode, satuan, jumlah.
    # Outletnya sengaja BERBEDA dari `ask`: gerbang order ganda menahan dua order berbarang sama
    # di outlet dan tanggal yang sama, dan yang diuji di sini bukan gerbang itu.
    with_price = client.post("/websales/orders", headers=SALES,
                             json={**ask, "outlet": "TOKO SALES DUA", "customer_no": "C-003",
                                   "lines": [dict(code="A", unit="PCS", quantity="4", price="999999")]})
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

    # Permintaan yang SUDAH tersimpan lalu ditolak saat tarik (mis. harga belum disinkron) tetap pending, sebabnya berkode di
    # `failed`; permintaan lain pada tarikan yang sama tetap masuk.
    tertahan = client.post("/websales/orders", headers=SALES,
                           json={**ask, "outlet": "TOKO TERTAHAN", "customer_no": "C-NANTI"}).json()["request"]["id"]
    TOLAK["C-NANTI"] = (409, "HARGA_BELUM_ADA")
    pulled = client.post("/orders/pull", headers=ADMIN, json={})
    assert pulled.status_code == 200, pulled.text
    body = pulled.json()
    assert len(body["imported"]) == 2 and body["already_imported"] == [], body
    assert body["failed"] == [{"request_id": tertahan, "error": "ditolak HARGA_BELUM_ADA", "kode": "HARGA_BELUM_ADA"}], body
    assert websales_store.get_request(tertahan)["status"] == "pending"
    # Tarikan memakai jalur LAYANAN (tanpa sesi: cron tak punya cookie) dan meminta harga.
    assert PANGGILAN[-1]["sesi"] is False and PANGGILAN[-1]["harga"] is True, PANGGILAN[-1]

    # BL-18: order hasil pull BERHARGA server -> dihitung, aturan dibekukan, status draft (siap diantrekan ke faktur).
    order_id = next(item["order_id"] for item in body["imported"] if item["request_id"] == request_id)
    order = client.get(f"/orders/{order_id}", headers=ADMIN).json()["order"]
    assert order["status"] == "draft" and order["request_id"] == request_id, order
    # Pelanggan ikut terbawa dari sisi sales; tanpa ini faktur tidak bisa dibuat.
    assert order["customer_no"] == "C-001", order
    assert [line["price"] for line in order["lines"]] == ["1000"], order["lines"]
    assert order["result"]["discount"] == "500.00" and not order["result"].get("pending_price"), order["result"]
    with connect() as db:
        assert json.loads(db.execute("SELECT rules FROM sales_order WHERE id=?", (order_id,)).fetchone()[0]) != []
    # Harga klien 999999 TIDAK pernah dipakai: order permintaan kedua juga berharga server.
    kedua = next(item["order_id"] for item in body["imported"] if item["request_id"] != request_id)
    assert [line["price"] for line in client.get(f"/orders/{kedua}", headers=ADMIN).json()["order"]["lines"]] == ["1000"]
    # Sesudah harganya tersedia, permintaan tertahan ikut masuk pada tarikan berikutnya.
    del TOLAK["C-NANTI"]
    lagi = client.post("/orders/pull", headers=ADMIN, json={}).json()
    assert [item["request_id"] for item in lagi["imported"]] == [tertahan] and lagi["failed"] == [], lagi

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
