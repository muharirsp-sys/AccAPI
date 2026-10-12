"""Tujuan: Self-check order masuk: aturan terbit dibekukan pada order dan izin ditegakkan.
Caller: `python test_orders.py` (tanpa framework). Dependensi: routers.orders, summary_store, outlet_class.
Main Functions: main; assert pembekuan versi, filter channel/tanggal, izin, dan kepemilikan. O1 putaran 1: simpan Order Baru WAJIB
sidik pratinjau (pratinjau = tersimpan, termasuk kelas outlet pelanggan); harga petugas per baris menang & tidak ditimpa, kosong = harga
master; harga petugas <= 0 ditolak sebelum Next.
Side Effects: SQLite sementara di direktori temp; tidak memanggil Mistral/Accurate.
"""
import json
import os
import tempfile

os.environ["SUMMARY_STORE_PATH"] = os.path.join(tempfile.mkdtemp(prefix="order-check-"), "summary.sqlite3")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import order_cabang  # noqa: E402
import outlet_channel  # noqa: E402
import outlet_class  # noqa: E402
from routers import orders  # noqa: E402
from summary_store import connect, create_draft  # noqa: E402

SALES = {"X-Test-User": "sales@surya.local"}
ADMIN = {"X-Test-User": "admin@surya.local"}
GUEST = {"X-Test-User": "tamu@surya.local"}


def publish(percentage, code="A", program_id="P1", **lain):
    """Draft terbit berisi satu program persen; dipakai untuk menguji pembekuan versi."""
    program = dict(id=program_id, name="Promo", start="2026-06-01", end="2026-06-30", codes=[code], channel="GT",
                   unit="PCS", mix=False, threshold="quantity", value_scope="eligible", basis="gross", stacking=False,
                   priority=1, source_page=1, source_quote="kutipan", **lain,
                   tiers=[dict(minimum="1", percentages=[percentage], rupiah="0", rupiah_mode="once",
                               bonus_code="", bonus_quantity="0", bonus_unit="PCS", bonus_scope="code", repeat=False)])
    draft = create_draft("sales@surya.local", "Surat", {"rows": [], "programs": [program]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published' WHERE id=?", (draft["id"],))
    return draft["id"]


PERIKSA_ASLI = order_cabang.periksa


def periksa_internal(customer_no, order_date, lines, cookie=None):
    """Jembatan Next palsu: harga petugas kembali SAMA (tidak ditimpa); baris tanpa harga = harga master 1000."""
    assert cookie is None, "Order Baru = jalur layanan"
    return [{**line, "sumber_harga": "petugas"} if line.get("price") else {**line, "price": "1000", "sumber_harga": "master"}
            for line in lines]


def berharga(body):
    """Baris seperti dijawab Next untuk pratinjau (kode, satuan, jumlah, harga dipakai)."""
    return [{k: line[k] for k in ("code", "unit", "quantity", "price")}
            for line in periksa_internal(body["customer_no"], body["order_date"], [dict(line) for line in body["lines"]])]


def simpan(client, body, headers=SALES, **extra):
    """Alur layar Order Baru: pratinjau (harga seperti dijawab Next) lalu simpan dengan sidiknya."""
    lihat = client.post("/orders/preview", headers=headers, json={**body, "lines": berharga(body)})
    assert lihat.status_code == 200, lihat.text
    return client.post("/orders", headers=headers, json={**body, "sidik": lihat.json()["sidik"], **extra})


def main():
    # Channel outlet ditanyakan ke Next sejak PR #64. Self-check tidak boleh menuntut layanan
    # hidup: yang diuji di sini alur order, bukan jembatan channelnya (itu `test_outlet_channel`).
    outlet_channel.verify = lambda customer_no, channel: channel
    # Aturan cabang + harga ditanyakan ke Next sejak O1 (`test_order_cabang`). Input internal membawa harga petugas: barisnya kembali
    # dengan harga yang sama — harga petugas TIDAK ditimpa.
    order_cabang.periksa = periksa_internal
    orders.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    orders.user_has_permission = lambda user, area, action: (
        user != "tamu@surya.local" and (action != "edit" or user == "admin@surya.local"))
    orders.validate_csrf_request = lambda request, token: True
    app = FastAPI()
    app.include_router(orders.router)
    client = TestClient(app)
    body = dict(outlet="TOKO UJI", channel="GT", order_date="2026-06-15", customer_no="C-001",
                lines=[dict(code="A", unit="PCS", quantity="10", price="1000")])

    # Tanpa aturan terbit, order tidak boleh dihitung diam-diam (pratinjau pun menolak berkode).
    kosong = client.post("/orders", headers=SALES, json={**body, "sidik": "x"})
    assert kosong.status_code == 409 and kosong.json()["kode"] == "ATURAN_BELUM_TERBIT", kosong.text
    assert client.post("/orders/preview", headers=SALES, json=body).json()["kode"] == "ATURAN_BELUM_TERBIT"

    first = publish("5")
    # Pratinjau = tersimpan: tanpa sidik DITOLAK, tidak pernah dihitung ulang diam-diam.
    tanpa = client.post("/orders", headers=SALES, json=body)
    assert tanpa.status_code == 400 and tanpa.json()["kode"] == "SIDIK_WAJIB", tanpa.text
    lihat = client.post("/orders/preview", headers=SALES, json=body).json()
    created = client.post("/orders", headers=SALES, json={**body, "sidik": lihat["sidik"]})
    assert created.status_code == 200, created.text
    order = created.json()["order"]
    assert order["result"]["discount"] == "500.00" and order["status"] == "draft", order
    assert order["result"] == lihat["result"], "angka tersimpan = angka pratinjau, per baris"
    assert order["sources"] == [{"draft_id": first, "revision": 1}], order["sources"]

    # Promo baru TIDAK mengubah order lama; order berikutnya memakai aturan baru.
    publish("10", code="A", program_id="P2")
    again = client.get(f"/orders/{order['id']}", headers=SALES).json()["order"]
    assert again["result"]["discount"] == "500.00", again["result"]
    assert len(again["sources"]) == 1, again["sources"]
    # Dua surat terbit, keduanya tidak boleh digabung: yang lebih dulu terbit menang, bukan yang ID-nya kebetulan kecil.
    # Order kedua dengan isi yang SAMA ditahan gerbang order ganda — memang itu gunanya.
    # Di sini ia sengaja dikonfirmasi, persis seperti admin yang sudah memeriksanya.
    # Pratinjau sebelum P2 terbit TIDAK usang: P1 (terbit lebih dulu) tetap menang, angkanya sama -> sidik sama, aturan yang tidak
    # mengubah angka order ini tidak membatalkan pratinjaunya.
    lama = client.post("/orders", headers=SALES, json={**body, "sidik": lihat["sidik"], "confirm_duplicate": True})
    assert lama.status_code == 200, lama.text
    ditahan = simpan(client, body)
    assert ditahan.status_code == 409 and "bukan order ganda" in ditahan.json()["detail"], ditahan.text
    assert ditahan.json()["kode"] == "ORDER_GANDA", ditahan.text
    newer = simpan(client, body, confirm_duplicate=True).json()["order"]
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
    other = simpan(client, {**body, "channel": "MT"}).json()["order"]
    assert other["result"]["discount"] == "0.00", other["result"]
    later = simpan(client, {**body, "order_date": "2026-07-01"}).json()["order"]
    assert later["result"]["discount"] == "0.00", later["result"]

    # Baris dan tanggal tidak valid ditolak dengan pesan, tanpa order tersimpan.
    for bad, note in [({**body, "lines": []}, "kosong"),
                      ({**body, "lines": [dict(code="A", unit="PCS", quantity="0", price="1000")]}, "kuantitas nol"),
                      ({**body, "order_date": "15 Juni 2026"}, "tanggal tidak baku"),
                      ({**body, "outlet": ""}, "outlet kosong"),
                      # Tanpa pelanggan Accurate, order tidak akan pernah bisa menjadi faktur.
                      ({**body, "customer_no": ""}, "pelanggan kosong")]:
        assert client.post("/orders", headers=SALES, json={**bad, "sidik": "x"}).status_code == 400, note

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

    check_harga_petugas(client, body)
    check_kelas_outlet(client, body)
    print("order freeze check: OK")


def check_harga_petugas(client, body):
    """Butir 7: harga petugas per baris MENANG dan tercatat; baris kosong = harga master; tidak ada yang ditimpa; <= 0 ditolak."""
    publish("5", code="B", program_id="PB")
    campur = {**body, "outlet": "TOKO CAMPUR", "lines": [dict(code="A", unit="PCS", quantity="10", price="1500"),
                                                          dict(code="B", unit="PCS", quantity="2", price="")]}
    order = simpan(client, campur).json()["order"]
    assert [(line["code"], line["price"], line["sumber_harga"]) for line in order["lines"]] == [
        ("A", "1500", "petugas"), ("B", "1000", "master")], order["lines"]
    # Satuan huruf kecil dari klien = satuan yang sama dengan pratinjau Next (huruf besar): angka & sidik tetap sama.
    kecil = {**campur, "outlet": "TOKO SATUAN", "lines": [dict(code="A", unit="pcs", quantity="10", price="1500")]}
    besar = {**kecil, "lines": [dict(code="A", unit="PCS", quantity="10", price="1500")]}
    lihat = client.post("/orders/preview", headers=SALES, json={**besar, "lines": berharga(besar)}).json()
    satuan = client.post("/orders", headers=SALES, json={**kecil, "sidik": lihat["sidik"]})
    assert satuan.status_code == 200 and satuan.json()["order"]["result"] == lihat["result"], satuan.text
    assert satuan.json()["order"]["lines"][0]["unit"] == "PCS", satuan.json()["order"]["lines"]
    # Jembatan ASLI: harga petugas <= 0 / bukan angka DITOLAK sebelum Next ditanya (tanpa jaringan di uji ini).
    order_cabang.periksa = PERIKSA_ASLI
    try:
        for buruk in ("0", "-1", "abc"):
            nol = client.post("/orders", headers=SALES, json={**campur, "outlet": "TOKO NOL", "sidik": "x",
                                                              "lines": [dict(code="A", unit="PCS", quantity="1", price=buruk)]})
            assert nol.status_code == 400 and nol.json()["kode"] == "HARGA_TIDAK_VALID", (buruk, nol.text)
    finally:
        order_cabang.periksa = periksa_internal


def check_kelas_outlet(client, body):
    """Pratinjau MEMAKAI kelas outlet pelanggan (customer_no diteruskan) — dulu tidak, sehingga promo LOYALTY beda saat simpan."""
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='withdrawn'")
    publish("7", code="L", program_id="LOY", outlet_mode="only", outlet_classes=["LOYALTY"])
    outlet_class.load("LOYALTY", ["C-LOY"], "uji")
    for customer_no, diskon in (("C-LOY-KN", "70.00"), ("C-BIASA-KN", "0.00")):
        isi = {**body, "outlet": f"TOKO {customer_no}", "customer_no": customer_no, "lines": [dict(code="L", unit="PCS", quantity="1")]}
        lihat = client.post("/orders/preview", headers=SALES, json={**isi, "lines": berharga(isi)}).json()
        assert lihat["result"]["discount"] == diskon, (customer_no, lihat["result"])
        order = client.post("/orders", headers=SALES, json={**isi, "sidik": lihat["sidik"]}).json()["order"]
        assert order["result"] == lihat["result"], (customer_no, order["result"])
    # Pratinjau TANPA kelas outlet (bentuk lama: customer_no tidak diteruskan) tidak cocok dengan simpan pelanggan LOYALTY.
    isi = {**body, "outlet": "TOKO LAMA", "customer_no": "C-LOY-KN", "lines": [dict(code="L", unit="PCS", quantity="1")]}
    lama = client.post("/orders/preview", headers=SALES, json={**isi, "customer_no": "", "lines": berharga(isi)}).json()
    beda = client.post("/orders", headers=SALES, json={**isi, "sidik": lama["sidik"]})
    assert beda.status_code == 409 and beda.json()["kode"] == "PRATINJAU_BERUBAH", beda.text
    assert beda.json()["pratinjau"]["result"]["discount"] == "70.00", beda.json()["pratinjau"]


if __name__ == "__main__":
    main()
