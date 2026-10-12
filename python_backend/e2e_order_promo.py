"""Tujuan: Server FastAPI UJI untuk e2e O1 putaran 1 (promo terhubung, pratinjau = tersimpan) — router orders + websales ASLI, auth palsu.
Caller: lib/order-cabang-pg.test.ts (uji PG "e2e promo") menjalankannya sebagai proses anak: `python e2e_order_promo.py <port>`.
Dependensi: fastapi, uvicorn, routers.orders, routers.websales, summary_store, outlet_class. Env dari pemanggil: SUMMARY_STORE_PATH,
WEBSALES_STORE_PATH (SQLite sementara), NEXT_INTERNAL_URL (server Next uji yang menjalankan route ASLI /api/orders/harga +
/api/outlet-channel di atas Postgres uji), CRON_SECRET.
Main Functions: main. Side Effects: HTTP lokal 127.0.0.1 saja; SQLite sementara. BUKAN produksi; tidak masuk run_checks (awalan e2e_).

Yang ASLI: hitung_promo/hitung_order/cocokkan/store_order/pull_once, order_cabang (HTTP sungguhan ke Next uji), outlet_channel, outlet_class.
Yang palsu: identitas (cookie `uji_user=<id>`) + izin (peta tetap) + CSRF. Endpoint `/_uji/*` hanya ada di server uji ini.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, Request  # noqa: E402
import uvicorn  # noqa: E402

import outlet_class  # noqa: E402
from routers import orders, websales  # noqa: E402
from summary_store import connect, create_draft  # noqa: E402

IZIN = {
    "u-sa": {("websales", "view"), ("websales", "create")},
    "u-admin": {("order", "view"), ("order", "create"), ("order", "edit"), ("websales", "view"), ("websales", "create")},
}


def pemakai(request):
    for bagian in request.headers.get("cookie", "").split(";"):
        kunci, _, nilai = bagian.strip().partition("=")
        if kunci == "uji_user" and nilai:
            return nilai
    return None


for modul in (orders, websales):
    modul.get_current_user = pemakai
    modul.user_has_permission = lambda user, area, action: (area, action) in IZIN.get(user, set())
    modul.validate_csrf_request = lambda request, token: True

app = FastAPI()
app.include_router(orders.router)
app.include_router(websales.router)


@app.get("/_uji/hidup")
def hidup():
    return {"ok": True}


@app.post("/_uji/terbit")
async def terbit(request: Request):
    """Satu surat terbit berisi `programs` (bentuk Program summary_rules)."""
    body = await request.json()
    draft = create_draft("admin@uji", body.get("judul", "Surat uji"), {"rows": [], "programs": body["programs"]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", (draft["id"],))
    return {"ok": True, "draft_id": draft["id"]}


@app.post("/_uji/cabut")
async def cabut(request: Request):
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='withdrawn' WHERE id=?", ((await request.json())["draft_id"],))
    return {"ok": True}


@app.post("/_uji/kelas")
async def kelas(request: Request):
    body = await request.json()
    return {"ok": True, "codes": outlet_class.load(body["klass"], body["codes"], "uji e2e")}


@app.post("/_uji/secret")
async def secret(request: Request):
    """Ganti CRON_SECRET proses ini (uji butir 5: secret FastAPI != Next)."""
    os.environ["CRON_SECRET"] = (await request.json())["secret"]
    return {"ok": True}


def main():
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")


if __name__ == "__main__":
    main()
