"""Tujuan: Self-check gerbang order ganda pada jalur Order Sales dan Order Masuk.
Caller: `python test_order_duplicate_gate.py`. Dependensi: routers.orders, summary_store.
Side Effects: SQLite sementara; tidak memanggil Mistral/Accurate.

Yang dibuktikan di sini bukan rumusnya (itu urusan `test_order_duplicate.py`), melainkan bahwa
gerbangnya BENAR-BENAR menahan pada jalur yang dipakai orang — dan bahwa konfirmasi manusia
meloloskannya, bukan menyiasatinya.
"""
import json
import os
import tempfile

os.environ["SUMMARY_STORE_PATH"] = os.path.join(tempfile.mkdtemp(prefix="dupe-check-"), "summary.sqlite3")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import outlet_channel  # noqa: E402
from routers import orders  # noqa: E402
from summary_store import connect, create_draft  # noqa: E402

USER = {"X-Test-User": "sales@surya.local"}


def publish(codes):
    program = dict(id="P1", name="Promo", start="2026-06-01", end="2026-06-30", codes=codes, channel="GT",
                   unit="PCS", mix=False, threshold="quantity", value_scope="eligible", basis="gross",
                   stacking=False, priority=1, source_page=1, source_quote="kutipan",
                   tiers=[dict(minimum="1", percentages=["3"], rupiah="0", rupiah_mode="once",
                               bonus_code="", bonus_quantity="0", bonus_unit="PCS", bonus_scope="code",
                               repeat=False)])
    draft = create_draft("sales@surya.local", "Surat", {"rows": [], "programs": [program]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published' WHERE id=?", (draft["id"],))


def order(lines, **over):
    body = dict(outlet="TOKO UJI", channel="GT", order_date="2026-06-15", customer_no="C-001", lines=lines)
    body.update(over)
    return body


def line(code, qty="10"):
    return dict(code=code, unit="PCS", quantity=qty, price="1000")


def main():
    # Channel outlet ditanyakan ke Next sejak PR #64. Self-check tidak boleh menuntut layanan
    # hidup: yang diuji di sini alur order, bukan jembatan channelnya (itu `test_outlet_channel`).
    outlet_channel.verify = lambda customer_no, channel: channel
    orders.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    orders.user_has_permission = lambda user, area, action: True
    orders.validate_csrf_request = lambda request, token: True
    publish(["A", "B", "C", "D"])
    app = FastAPI()
    app.include_router(orders.router)
    client = TestClient(app)

    # Order pertama lolos: belum ada bandingannya.
    first = client.post("/orders", json=order([line("A"), line("B"), line("C")]), headers=USER)
    assert first.status_code == 200, first.text

    # Order kedua MIRIP tapi tidak sama persis (satu barang ditambah, jumlahnya diubah) —
    # justru bentuk ketikan ulang yang paling sering lolos. Wajib ditahan.
    mirip = client.post("/orders", json=order([line("A", "5"), line("B", "5"), line("C", "5"), line("D")]),
                        headers=USER)
    assert mirip.status_code == 409, mirip.text
    assert "bukan order ganda" in mirip.json()["detail"], mirip.text

    # Konfirmasi manusia meloloskannya, dan jejaknya ikut tersimpan pada catatan ordernya.
    ok = client.post("/orders", json=order([line("A", "5"), line("B", "5"), line("C", "5"), line("D")],
                                           confirm_duplicate=True), headers=USER)
    assert ok.status_code == 200, ok.text
    assert "dikonfirmasi BUKAN order ganda" in ok.json()["order"]["note"], ok.text

    # Outlet lain pada tanggal yang sama bukan order ganda.
    lain = client.post("/orders", json=order([line("A"), line("B"), line("C")], outlet="TOKO LAIN"), headers=USER)
    assert lain.status_code == 200, lain.text

    # Tanggal lain juga bukan: outlet memang wajar memesan barang yang sama di hari berbeda.
    besok = client.post("/orders", json=order([line("A"), line("B"), line("C")], order_date="2026-06-16"),
                        headers=USER)
    assert besok.status_code == 200, besok.text

    # Order yang isinya jauh berbeda tetap lolos tanpa konfirmasi.
    beda = client.post("/orders", json=order([line("D")], order_date="2026-06-17"), headers=USER)
    assert beda.status_code == 200, beda.text

    print("ok - gerbang order ganda menahan yang mirip, meloloskan yang bukan, dan menghormati konfirmasi")


if __name__ == "__main__":
    main()
