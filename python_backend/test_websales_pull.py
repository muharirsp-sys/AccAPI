"""Tujuan: Self-check pemisahan basis data Web Sales dan pull idempoten ke internal.
Caller: `python test_websales_pull.py` (tanpa framework). Dependensi: routers.orders, routers.websales.
Main Functions: main; assert dua basis data terpisah, tanpa harga dari klien, pull tidak menggandakan, dan (O1/BL-18) order tarikan
berharga server -> draft siap antre faktur; aturan cabang ditanya di simpan (sesi sales) dan di tarik (layanan).
O1 putaran 1: simpan Order Sales WAJIB sidik pratinjau (pratinjau = tersimpan); tarik membekukan angka yang SAMA atau menolak permanen
(`rejected` berkode, tidak dicoba lagi); Next tak pasti / konfigurasi = 503 dan tarikan berhenti tanpa menolak apa pun (S12); permintaan
yang ditahan dugaan ganda tidak menyumbat halaman antrean.
Side Effects: Dua SQLite sementara di direktori temp; tidak memanggil Mistral/Accurate.
"""
import json
import os
import sys
import tempfile
import types

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


def program(pid="P1", percent="5", code="A"):
    return dict(id=pid, name="Promo", start="2026-06-01", end="2026-06-30", codes=[code], channel="GT",
                unit="PCS", mix=False, threshold="quantity", value_scope="eligible", basis="gross", stacking=False,
                priority=1, source_page=1, source_quote="kutipan",
                tiers=[dict(minimum="1", percentages=[percent], rupiah="0", rupiah_mode="once",
                            bonus_code="", bonus_quantity="0", bonus_unit="PCS", bonus_scope="code", repeat=False)])


def publish(*programs):
    draft = create_draft("admin@surya.local", "Surat", {"rows": [], "programs": list(programs) or [program()]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published' WHERE id=?", (draft["id"],))
    return draft["id"]


def withdraw(draft_id):
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='withdrawn' WHERE id=?", (draft_id,))


# Izin nyata yang dipakai: sales HANYA punya `websales`, petugas punya `order` + `websales`.
# Ini yang mencegah sales memakai POST /orders internal (yang menerima harga dari klien).
PERMISSIONS = {
    "sales@surya.local": {("websales", "view"), ("websales", "create")},
    "admin@surya.local": {("order", "view"), ("order", "create"), ("order", "edit"),
                          ("websales", "view"), ("websales", "create")},
}


# Jembatan Next `/api/orders/harga` dipalsukan (perilaku HTTP-nya diuji di `test_order_cabang`). Harga master server HARGA[kode
# pelanggan] (bawaan 1000) per baris; TOLAK[kode pelanggan] = (status, kode) menolak order pelanggan itu. PANGGILAN mencatat jalur.
PANGGILAN = []
TOLAK = {}
HARGA = {}


def periksa_palsu(customer_no, order_date, lines, cookie=None):
    PANGGILAN.append({"customer_no": customer_no, "sesi": cookie is not None})
    if customer_no in TOLAK:
        status, kode = TOLAK[customer_no]
        if kode in ("LAYANAN_TIDAK_PASTI", "KONFIGURASI_SERVER"):
            raise order_cabang.OrderCabangTidakPasti("Next tidak menjawab", kode=kode)
        raise order_cabang.OrderCabangDitolak(status, kode, f"ditolak {kode}", {"barang": ["A"]})
    return [{**line, "price": line["price"], "sumber_harga": "petugas"} if line.get("price")
            else {**line, "price": HARGA.get(customer_no, "1000"), "sumber_harga": "master"} for line in lines]


CHANNEL_BEDA = set()
CHANNEL_PUTUS = set()
CHANNEL_KONFIG = set()
# Jembatan bonus Next palsu (putaran 2, butir 7): kode di BONUS_BURUK = barang bonus tak bisa diorder untuk pelanggan.
BONUS_BURUK = set()
BONUS_PANGGIL = []
# Susulan uji: periksa_bonus ASLI (sebelum dipalsukan di main) + `requests` palsu -> galat HTTP cek bonus diuji ujung ke ujung.
PERIKSA_BONUS_ASLI = order_cabang.periksa_bonus
NEXT_BONUS = []


def next_bonus_rusak(status=500, gagal=None):
    """Next `/api/orders/harga` (mode bonus) menjawab 5xx, atau `requests.post` gagal (jaringan / timeout)."""
    def post(url, json=None, headers=None, timeout=None):
        NEXT_BONUS.append({"json": json, "headers": dict(headers or {})})
        if gagal:
            raise gagal
        return types.SimpleNamespace(status_code=status, json=lambda: {"error": "galat internal"})
    sys.modules["requests"] = types.SimpleNamespace(post=post)


def bonus_palsu(customer_no, order_date, codes, cookie=None):
    kode = sorted({c for c in codes if c})
    if not kode:
        return
    BONUS_PANGGIL.append({"customer_no": customer_no, "sesi": cookie is not None, "kode": kode})
    buruk = [c for c in kode if c in BONUS_BURUK]
    if buruk:
        raise order_cabang.OrderCabangDitolak(409, "BONUS_TIDAK_BISA_DIORDER", f"bonus {buruk} tidak bisa diorder",
                                              {"bonus": [{"code": c, "alasan": "barang cabang lain"} for c in buruk]})


def verify_palsu(customer_no, channel):
    if customer_no in CHANNEL_BEDA:
        raise outlet_channel.ChannelBedaMaster(f"Order dikirim sebagai channel {channel}, tetapi master Accurate menyimpan outlet {customer_no} sebagai MT.")
    if customer_no in CHANNEL_PUTUS:
        raise outlet_channel.ChannelTidakPasti("Tidak bisa menanyakan channel outlet ke Next: connection refused")
    if customer_no in CHANNEL_KONFIG:
        raise outlet_channel.ChannelKonfigurasi("Konfigurasi server: Next menolak kunci layanan FastAPI saat menanyakan channel outlet")
    return channel


def fake_auth(module):
    module.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    module.user_has_permission = lambda user, area, action: (area, action) in PERMISSIONS.get(user, set())
    module.validate_csrf_request = lambda request, token: True


def pratinjau(client, ask, headers=SALES):
    """Pratinjau seperti Next untuk sales: baris TANPA harga klien diberi harga master server (periksa yang sama), lalu FastAPI
    /orders/preview -> sidik."""
    berharga = periksa_palsu(ask["customer_no"], ask["order_date"],
                             [{k: line[k] for k in ("code", "unit", "quantity")} for line in ask["lines"]])
    PANGGILAN.pop()
    r = client.post("/orders/preview", headers=headers, json={**ask, "lines": [
        {k: line[k] for k in ("code", "unit", "quantity", "price")} for line in berharga]})
    assert r.status_code == 200, r.text
    return r.json()


def kirim(client, ask, **extra):
    """Simpan Order Sales dengan sidik pratinjau terakhir (alur layar)."""
    return client.post("/websales/orders", headers=SALES, json={**ask, "sidik": pratinjau(client, ask)["sidik"], **extra})


def main():
    # Channel outlet ditanyakan ke Next sejak PR #64. Self-check tidak boleh menuntut layanan
    # hidup: yang diuji di sini alur order, bukan jembatan channelnya (itu `test_outlet_channel`).
    outlet_channel.verify = verify_palsu
    order_cabang.periksa = periksa_palsu
    order_cabang.periksa_bonus = bonus_palsu
    fake_auth(orders)
    fake_auth(websales)
    app = FastAPI()
    app.include_router(orders.router)
    app.include_router(websales.router)
    client = TestClient(app)
    p1 = publish()

    # Basis data Web Sales hanya berisi tabel permintaan order; tidak ada tabel internal.
    with websales_store.connect() as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert tables == {"order_request"}, tables

    ask = dict(outlet="TOKO SALES", channel="GT", order_date="2026-06-15", customer_no="C-001",
               lines=[dict(code="A", unit="PCS", quantity="10")])
    lihat = pratinjau(client, ask)
    assert lihat["result"]["discount"] == "500.00" and len(lihat["sidik"]) == 64, lihat
    # Pratinjau = tersimpan: tanpa sidik DITOLAK (bukan dihitung ulang diam-diam), sidik lain DITOLAK dengan pratinjau baru.
    tanpa = client.post("/websales/orders", headers=SALES, json=ask)
    assert tanpa.status_code == 400 and tanpa.json()["kode"] == "SIDIK_WAJIB", tanpa.text
    lain = client.post("/websales/orders", headers=SALES, json={**ask, "sidik": "0" * 64})
    assert lain.status_code == 409 and lain.json()["kode"] == "PRATINJAU_BERUBAH", lain.text
    assert lain.json()["pratinjau"]["sidik"] == lihat["sidik"] and lain.json()["pratinjau"]["result"] == lihat["result"], lain.json()
    assert websales_store.pending_count() == 0

    created = client.post("/websales/orders", headers=SALES, json={**ask, "sidik": lihat["sidik"]})
    assert created.status_code == 200, created.text
    request_id = created.json()["request"]["id"]
    assert created.json()["request"]["status"] == "pending"
    # O1: simpan Order Sales memeriksa aturan cabang + harga lewat SESI sales (cakupan cabang salesman) — tetapi harganya TIDAK
    # disimpan di permintaan (dibekukan saat tarik, dicocokkan dengan sidik yang disimpan).
    assert PANGGILAN[-1] == {"customer_no": "C-001", "sesi": True}, PANGGILAN
    assert set(created.json()["request"]["lines"][0]) == {"code", "unit", "quantity"}, created.json()
    with websales_store.connect() as db:
        assert db.execute("SELECT sidik FROM order_request WHERE id=?", (request_id,)).fetchone()[0] == lihat["sidik"]

    # Ditolak Next (mis. barang beda cabang / salesman belum tertaut) -> kodenya sampai ke sales, tidak ada yang tersimpan.
    TOLAK["C-TOLAK"] = (409, "BARANG_BEDA_CABANG")
    sebelum = websales_store.pending_count()
    ditolak = client.post("/websales/orders", headers=SALES, json={**ask, "outlet": "TOKO TOLAK", "customer_no": "C-TOLAK", "sidik": "x"})
    assert ditolak.status_code == 409 and ditolak.json()["kode"] == "BARANG_BEDA_CABANG", ditolak.text
    assert ditolak.json()["detail"] and ditolak.json()["barang"] == ["A"], ditolak.text
    TOLAK["C-SALES"] = (403, "SALESMAN_BELUM_TERHUBUNG")
    belum = client.post("/websales/orders", headers=SALES, json={**ask, "outlet": "TOKO X", "customer_no": "C-SALES", "sidik": "x"})
    assert belum.status_code == 403 and belum.json()["kode"] == "SALESMAN_BELUM_TERHUBUNG", belum.text
    # Next tak pasti / konfigurasi -> 503 berkode, juga tidak tersimpan (gagal tertutup).
    for kode in ("LAYANAN_TIDAK_PASTI", "KONFIGURASI_SERVER"):
        TOLAK["C-DIAM"] = (0, kode)
        diam = client.post("/websales/orders", headers=SALES, json={**ask, "outlet": "TOKO Y", "customer_no": "C-DIAM", "sidik": "x"})
        assert diam.status_code == 503 and diam.json()["kode"] == kode, diam.text
    # Channel beda master DITOLAK saat simpan (dulu baru ketahuan saat tarik).
    CHANNEL_BEDA.add("C-MT")
    beda = client.post("/websales/orders", headers=SALES, json={**ask, "outlet": "TOKO MT", "customer_no": "C-MT", "sidik": "x"})
    assert beda.status_code == 422 and beda.json()["kode"] == "CHANNEL_BEDA_MASTER", beda.text
    CHANNEL_BEDA.discard("C-MT")
    assert websales_store.pending_count() == sebelum

    # Harga dari klien diabaikan: baris tersimpan hanya kode, satuan, jumlah; harga yang dibekukan = harga server.
    # Outletnya sengaja BERBEDA dari `ask`: gerbang order ganda menahan dua order berbarang sama
    # di outlet dan tanggal yang sama, dan yang diuji di sini bukan gerbang itu.
    dua = {**ask, "outlet": "TOKO SALES DUA", "customer_no": "C-003", "lines": [dict(code="A", unit="PCS", quantity="4")]}
    with_price = kirim(client, {**dua, "lines": [dict(code="A", unit="PCS", quantity="4", price="999999")]})
    assert with_price.status_code == 200, with_price.text
    assert set(with_price.json()["request"]["lines"][0]) == {"code", "unit", "quantity"}, with_price.json()

    # Jumlah tidak wajar ditolak di pintu masuk Web Sales.
    for bad in ([dict(code="A", unit="PCS", quantity="0")], [dict(code="A", unit="PCS", quantity="-2")],
                [dict(code="", unit="PCS", quantity="1")], [dict(code="A", unit="", quantity="1")]):
        assert client.post("/websales/orders", headers=SALES, json={**ask, "lines": bad, "sidik": "x"}).status_code == 400, bad
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

    # S12 (butir 9): Next TIDAK PASTI saat TARIK -> 503 berkode, tarikan BERHENTI, permintaan tetap pending, tidak ada order/penolakan.
    tertunda = kirim(client, {**ask, "outlet": "TOKO TERTUNDA", "customer_no": "C-TUNDA"}).json()["request"]["id"]
    with connect() as db:
        order_sebelum = db.execute("SELECT count(*) FROM sales_order").fetchone()[0]
    for kode in ("LAYANAN_TIDAK_PASTI", "KONFIGURASI_SERVER"):
        TOLAK["C-001"] = (0, kode)
        putus = client.post("/orders/pull", headers=ADMIN, json={})
        assert putus.status_code == 503 and putus.json()["kode"] == kode, putus.text
    CHANNEL_PUTUS.add("C-001")
    del TOLAK["C-001"]
    assert client.post("/orders/pull", headers=ADMIN, json={}).status_code == 503, "jaringan channel putus = berhenti, bukan tolak"
    CHANNEL_PUTUS.discard("C-001")
    with connect() as db:
        assert db.execute("SELECT count(*) FROM sales_order").fetchone()[0] == order_sebelum
    assert websales_store.get_request(request_id)["status"] == "pending"
    assert websales_store.get_request(tertunda)["status"] == "pending"

    # Ditolak PERMANEN saat tarik (butir 8): harga hilang, channel kini beda master, angka beku beda pratinjau -> `rejected`
    # berkode + sebab, tidak dicoba lagi; permintaan lain pada tarikan yang sama tetap masuk.
    harga_hilang = kirim(client, {**ask, "outlet": "TOKO HARGA", "customer_no": "C-NANTI"}).json()["request"]["id"]
    TOLAK["C-NANTI"] = (409, "HARGA_BELUM_ADA")
    channel_baru = kirim(client, {**ask, "outlet": "TOKO KATEGORI", "customer_no": "C-KAT"}).json()["request"]["id"]
    CHANNEL_BEDA.add("C-KAT")
    harga_naik = kirim(client, {**ask, "outlet": "TOKO NAIK", "customer_no": "C-NAIK"}).json()["request"]["id"]
    HARGA["C-NAIK"] = "1100"
    pulled = client.post("/orders/pull", headers=ADMIN, json={})
    assert pulled.status_code == 200, pulled.text
    body = pulled.json()
    assert sorted(item["request_id"] for item in body["imported"]) == sorted([request_id, with_price.json()["request"]["id"], tertunda]), body
    assert body["already_imported"] == [] and body["failed"] == [], body
    assert sorted((r["request_id"], r["kode"]) for r in body["rejected"]) == sorted(
        [(harga_hilang, "HARGA_BELUM_ADA"), (channel_baru, "CHANNEL_BEDA_MASTER"), (harga_naik, "PRATINJAU_BERUBAH")]), body
    for rid, kode in ((harga_hilang, "HARGA_BELUM_ADA"), (channel_baru, "CHANNEL_BEDA_MASTER"), (harga_naik, "PRATINJAU_BERUBAH")):
        row = websales_store.get_request(rid)
        assert row["status"] == "rejected" and row["reject_code"] == kode and row["reject_reason"] and row["rejected_at"], row
    # Sales melihat sebabnya di daftar ordernya.
    daftar = {r["id"]: r for r in client.get("/websales/orders", headers=SALES).json()["requests"]}
    assert daftar[harga_naik]["status"] == "rejected" and daftar[harga_naik]["reject_code"] == "PRATINJAU_BERUBAH", daftar[harga_naik]
    # Tarikan memakai jalur LAYANAN (tanpa sesi: cron tak punya cookie).
    assert PANGGILAN[-1]["sesi"] is False, PANGGILAN[-1]
    # Ditolak = tidak dicoba lagi walau sebabnya hilang (sales kirim ulang dengan pratinjau baru).
    del TOLAK["C-NANTI"]
    CHANNEL_BEDA.discard("C-KAT")
    lagi = client.post("/orders/pull", headers=ADMIN, json={}).json()
    assert lagi["imported"] == [] and lagi["rejected"] == [] and lagi["failed"] == [], lagi

    # BL-18: order hasil pull BERHARGA server -> dihitung, aturan dibekukan, status draft (siap diantrekan ke faktur), dan angkanya
    # = pratinjau yang dilihat sales (per baris).
    order_id = next(item["order_id"] for item in body["imported"] if item["request_id"] == request_id)
    order = client.get(f"/orders/{order_id}", headers=ADMIN).json()["order"]
    assert order["status"] == "draft" and order["request_id"] == request_id, order
    # Pelanggan ikut terbawa dari sisi sales; tanpa ini faktur tidak bisa dibuat.
    assert order["customer_no"] == "C-001", order
    assert [(line["price"], line["sumber_harga"]) for line in order["lines"]] == [("1000", "master")], order["lines"]
    assert order["result"] == lihat["result"], "angka beku = angka pratinjau, per baris"
    with connect() as db:
        assert json.loads(db.execute("SELECT rules FROM sales_order WHERE id=?", (order_id,)).fetchone()[0]) != []
    # Harga klien 999999 TIDAK pernah dipakai: order permintaan kedua juga berharga server.
    kedua = next(item["order_id"] for item in body["imported"] if item["request_id"] == with_price.json()["request"]["id"])
    assert [line["price"] for line in client.get(f"/orders/{kedua}", headers=ADMIN).json()["order"]["lines"]] == ["1000"]

    # Aturan diubah SESUDAH beku: order tersimpan tidak berubah (aturan utuh di order).
    withdraw(p1)
    p2 = publish(program("P2", "10"))
    assert client.get(f"/orders/{order_id}", headers=ADMIN).json()["order"]["result"] == lihat["result"]
    # Aturan berubah ANTARA simpan dan tarik: angka beku akan beda dari pratinjau -> ditolak permanen, bukan diam-diam 10%.
    withdraw(p2)
    p3 = publish()
    sebelum_ubah = kirim(client, {**ask, "outlet": "TOKO UBAH", "customer_no": "C-UBAH"}).json()["request"]["id"]
    withdraw(p3)
    publish(program("P2", "10"))
    ubah = client.post("/orders/pull", headers=ADMIN, json={}).json()
    assert [(r["request_id"], r["kode"]) for r in ubah["rejected"]] == [(sebelum_ubah, "PRATINJAU_BERUBAH")], ubah

    # Aturan belum terbit sama sekali = galat GLOBAL: tarikan berhenti 409, tidak ada yang ditolak.
    tanpa_aturan = kirim(client, {**ask, "outlet": "TOKO TANPA ATURAN", "customer_no": "C-TA"}).json()["request"]["id"]
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='withdrawn'")
    henti = client.post("/orders/pull", headers=ADMIN, json={})
    assert henti.status_code == 409 and henti.json()["kode"] == "ATURAN_BELUM_TERBIT", henti.text
    assert websales_store.get_request(tanpa_aturan)["status"] == "pending"
    publish(program("P2", "10"))
    websales_store.mark_rejected(tanpa_aturan, "UJI", "dibersihkan uji")

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

    check_halaman(client)
    check_putaran2(client)
    check_connection(client)
    print("websales split + pull check: OK")


def check_putaran2(client):
    """Putaran 2: (6) aturan terbit rusak = galat GLOBAL, tarikan berhenti, tidak ada yang ditolak; (7) bonus tak bisa diorder = ditolak
    berkode saat simpan DAN tarik, tidak dibuang; (8) channel 401/403 = KONFIGURASI_SERVER."""
    ask = dict(outlet="TOKO P2", channel="GT", order_date="2026-06-15", customer_no="C-P2", lines=[dict(code="A", unit="PCS", quantity="2")])

    # (8) CRON_SECRET ditolak Next saat menanyakan CHANNEL (cache dingin) -> 503 KONFIGURASI_SERVER (simpan) dan tarikan berhenti.
    CHANNEL_KONFIG.add("C-P2")
    simpan = client.post("/websales/orders", headers=SALES, json={**ask, "sidik": "x"})
    assert simpan.status_code == 503 and simpan.json()["kode"] == "KONFIGURASI_SERVER", simpan.text
    CHANNEL_KONFIG.discard("C-P2")
    tertunda = kirim(client, ask).json()["request"]["id"]
    CHANNEL_KONFIG.add("C-P2")
    henti = client.post("/orders/pull", headers=ADMIN, json={})
    assert henti.status_code == 503 and henti.json()["kode"] == "KONFIGURASI_SERVER", henti.text
    assert websales_store.get_request(tertunda)["status"] == "pending"
    CHANNEL_KONFIG.discard("C-P2")

    # (6) Satu aturan terbit RUSAK (tidak lolos Program) -> 409 ATURAN_TERBIT_RUSAK berkode; tarikan berhenti, permintaan TETAP pending.
    rusak = create_draft("admin@surya.local", "Rusak", {"rows": [], "programs": [{**program("RUSAK"), "tiers": []}]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published' WHERE id=?", (rusak["id"],))
    tarik = client.post("/orders/pull", headers=ADMIN, json={})
    assert tarik.status_code == 409 and tarik.json()["kode"] == "ATURAN_TERBIT_RUSAK", tarik.text
    assert websales_store.get_request(tertunda)["status"] == "pending", "keadaan server bukan alasan menolak permintaan"
    pv = client.post("/orders/preview", headers=SALES, json={**ask, "lines": [dict(code="A", unit="PCS", quantity="2", price="1000")]})
    assert pv.status_code == 409 and pv.json()["kode"] == "ATURAN_TERBIT_RUSAK", pv.text
    withdraw(rusak["id"])
    assert [i["request_id"] for i in client.post("/orders/pull", headers=ADMIN, json={}).json()["imported"]] == [tertunda]

    # (7) Bonus barang: dicek sesudah promo dihitung, lewat jembatan Next (sesi sales saat simpan, layanan saat tarik).
    bonus = publish({**program("BONUS"), "codes": ["B"], "tiers": [dict(minimum="1", percentages=[], rupiah="0", rupiah_mode="once",
                     bonus_code="Y", bonus_quantity="1", bonus_unit="PCS", bonus_scope="code", repeat=False)]})
    tanya = {**ask, "outlet": "TOKO BONUS", "lines": [dict(code="B", unit="PCS", quantity="1")]}
    BONUS_BURUK.add("Y")
    ditolak = kirim(client, tanya)
    assert ditolak.status_code == 409 and ditolak.json()["kode"] == "BONUS_TIDAK_BISA_DIORDER", ditolak.text
    assert ditolak.json()["bonus"] == [{"code": "Y", "alasan": "barang cabang lain"}] and BONUS_PANGGIL[-1]["sesi"] is True
    BONUS_BURUK.discard("Y")
    simpan = kirim(client, tanya)
    assert simpan.status_code == 200, simpan.text
    BONUS_BURUK.add("Y")  # barang bonus jadi suspended/pindah cabang sesudah sales menyimpan -> ditolak PERMANEN saat tarik
    tarik = client.post("/orders/pull", headers=ADMIN, json={}).json()
    assert [(r["request_id"], r["kode"]) for r in tarik["rejected"]] == [(simpan.json()["request"]["id"], "BONUS_TIDAK_BISA_DIORDER")], tarik
    assert BONUS_PANGGIL[-1]["sesi"] is False and BONUS_PANGGIL[-1]["kode"] == ["Y"], BONUS_PANGGIL[-1]
    BONUS_BURUK.discard("Y")

    # Susulan uji: cek bonus Next 500 / OSError / timeout = TIDAK PASTI -> 503 saat simpan (tidak disimpan) DAN saat tarik (berhenti);
    # permintaan TETAP pending (bukan rejected), lalu masuk sesudah Next pulih.
    tunda = {**tanya, "outlet": "TOKO BONUS TUNDA"}
    menunggu = kirim(client, tunda).json()["request"]["id"]
    requests_asli = sys.modules.get("requests")
    env_asli = {k: os.environ.get(k) for k in ("NEXT_INTERNAL_URL", "CRON_SECRET")}
    os.environ.update(NEXT_INTERNAL_URL="http://next.uji:3000", CRON_SECRET="rahasia-bonus")
    order_cabang.periksa_bonus = PERIKSA_BONUS_ASLI
    try:
        for status, gagal in ((500, None), (200, OSError("connection refused")), (200, TimeoutError("read timed out"))):
            next_bonus_rusak(status, gagal)
            sebelum = websales_store.pending_count()
            simpan = kirim(client, tunda)
            assert simpan.status_code == 503 and simpan.json()["kode"] == "LAYANAN_TIDAK_PASTI", (status, gagal, simpan.text)
            assert websales_store.pending_count() == sebelum, "tidak pasti saat simpan = tidak disimpan"
            tarik = client.post("/orders/pull", headers=ADMIN, json={})
            assert tarik.status_code == 503 and tarik.json()["kode"] == "LAYANAN_TIDAK_PASTI", (status, gagal, tarik.text)
            baris = websales_store.get_request(menunggu)
            assert baris["status"] == "pending" and not baris["reject_code"], (status, gagal, baris)
        assert {p["headers"].get("Authorization") for p in NEXT_BONUS} == {None, "Bearer rahasia-bonus"}, "jalur sesi DAN layanan"
        assert all(p["json"]["bonus"] == ["Y"] for p in NEXT_BONUS), NEXT_BONUS
    finally:
        order_cabang.periksa_bonus = bonus_palsu
        if requests_asli is None:
            sys.modules.pop("requests", None)
        else:
            sys.modules["requests"] = requests_asli
        for k, v in env_asli.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    with connect() as db:
        assert db.execute("SELECT count(*) FROM sales_order WHERE request_id=?", (menunggu,)).fetchone()[0] == 0
    assert [i["request_id"] for i in client.post("/orders/pull", headers=ADMIN, json={}).json()["imported"]] == [menunggu]
    withdraw(bonus)


def check_halaman(client):
    """Permintaan DITAHAN (dugaan ganda, tetap pending) di depan antrean tidak menyumbat permintaan sesudahnya (butir 8)."""
    orders.HALAMAN = 2
    try:
        ganda = {"outlet": "TOKO GANDA", "channel": "GT", "order_date": "2026-06-15", "customer_no": "C-GANDA",
                 "lines": [dict(code="A", unit="PCS", quantity="2")]}
        pertama = kirim(client, ganda).json()["request"]["id"]
        assert [i["request_id"] for i in client.post("/orders/pull", headers=ADMIN, json={}).json()["imported"]] == [pertama]
        ditahan = [kirim(client, {**ganda, "lines": [dict(code="A", unit="PCS", quantity=str(3 + i))]}).json()["request"]["id"]
                   for i in range(3)]
        baru = kirim(client, {**ganda, "outlet": "TOKO SESUDAH"}).json()["request"]["id"]
        hasil = client.post("/orders/pull", headers=ADMIN, json={}).json()
        assert [f["request_id"] for f in hasil["failed"]] == ditahan and all(f["kode"] == "ORDER_GANDA" for f in hasil["failed"]), hasil
        assert [i["request_id"] for i in hasil["imported"]] == [baru], "halaman kedua tetap ditarik"
        assert all(websales_store.get_request(r)["status"] == "pending" for r in ditahan), "ditahan menunggu manusia (BL-20)"
        for r in ditahan:
            websales_store.mark_rejected(r, "UJI", "dibersihkan uji")
    finally:
        orders.HALAMAN = 200


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

    kirim(client, dict(outlet="TOKO CRON", channel="GT", order_date="2026-06-15", customer_no="C-003",
                       lines=[dict(code="A", unit="PCS", quantity="3")]))
    assert client.get("/orders/connection", headers=ADMIN).json()["pending"] == 1

    on = client.post("/orders/connection", headers=ADMIN, json={"enabled": True})
    assert on.status_code == 200 and on.json()["connection"]["owner"], on.text

    # Cron juga berhenti 503 berkode saat Next tak pasti (tidak ada yang ditolak, last_result tidak ditimpa).
    TOLAK["C-003"] = (0, "LAYANAN_TIDAK_PASTI")
    putus = client.post("/orders/pull-cron", headers=cron)
    assert putus.status_code == 503 and putus.json()["kode"] == "LAYANAN_TIDAK_PASTI", putus.text
    del TOLAK["C-003"]

    ran = client.post("/orders/pull-cron", headers=cron).json()
    assert len(ran["imported"]) == 1 and "skipped" not in ran, ran
    # Order otomatis dimiliki petugas yang menyalakan koneksi, bukan tanpa pemilik.
    order_id = ran["imported"][0]["order_id"]
    assert client.get(f"/orders/{order_id}", headers=ADMIN).status_code == 200
    after = client.get("/orders/connection", headers=ADMIN).json()
    assert after["connection"]["last_run_at"] and after["pending"] == 0, after
    assert after["connection"]["last_result"] == {"imported": 1, "already_imported": 0, "failed": 0, "rejected": 0}, after

    # Dimatikan: penarikan berhenti walau ada permintaan baru menunggu.
    client.post("/orders/connection", headers=ADMIN, json={"enabled": False})
    kirim(client, dict(outlet="TOKO SETELAH MATI", channel="GT", order_date="2026-06-15", customer_no="C-004",
                       lines=[dict(code="A", unit="PCS", quantity="1")]))
    assert client.post("/orders/pull-cron", headers=cron).json()["skipped"], "koneksi mati harus berhenti menarik"
    assert client.get("/orders/connection", headers=ADMIN).json()["pending"] == 1


if __name__ == "__main__":
    main()
