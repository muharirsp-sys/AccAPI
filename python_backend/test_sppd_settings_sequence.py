"""Tujuan: Self-check urutan nomor SPPD di /payments/sppd/settings (AM-019, H08).
Caller: `python test_sppd_settings_sequence.py` via run_checks.py. Dependensi: routers.sppd, shared.
Main Functions: main; assert halaman basi / gagal-muat tidak bisa memundurkan last_sequence
  (nomor SPPD ganda), perubahan sengaja dengan versi cocok tetap bisa, field lain tak terganggu.
Side Effects: file sementara di direktori temp saja.
"""
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="sppd-seq-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import shared  # noqa: E402
from routers import sppd  # noqa: E402

sppd.get_current_user = lambda request: "betterauth|admin|adm@x.test"
sppd.user_has_permission = lambda user, module, action: True
sppd.validate_csrf_request = lambda request, token: True
app = FastAPI()
app.include_router(sppd.router)
client = TestClient(app)


def seq():
    return shared.load_payments_db()["sppd_settings"]["last_sequence"]


def main():
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"sppd_settings": {"last_sequence": 12}}, f)

    # Halaman yang GET-nya gagal mengirim default last_sequence 0 (tanpa versi): dulu tersimpan.
    r = client.post("/payments/sppd/settings", json={"last_sequence": 0, "number_template": "{seq:03d}/SPA/PDSB/{roman_month}/{year}"})
    assert r.status_code == 409, f"last_sequence tanpa versi diterima: {r.status_code} {r.text[:160]}"
    assert seq() == 12

    # Halaman basi (dimuat saat 10, sementara submit BANK_PANIN sudah memakai 11 dan 12).
    r = client.post("/payments/sppd/settings", json={"last_sequence": 10, "expected_last_sequence": 10})
    assert r.status_code == 409, f"halaman basi memundurkan urutan: {r.status_code} {r.text[:160]}"
    assert seq() == 12

    # Perubahan sengaja dengan versi yang cocok tetap boleh (termasuk reset — keputusan bisnis).
    r = client.post("/payments/sppd/settings", json={"last_sequence": 15, "expected_last_sequence": 12})
    assert r.status_code == 200, r.text[:200]
    assert seq() == 15

    # Field lain tanpa menyentuh urutan tidak butuh versi.
    r = client.post("/payments/sppd/settings", json={"maturity_months": 7})
    assert r.status_code == 200, r.text[:200]
    assert seq() == 15 and shared.load_payments_db()["sppd_settings"]["maturity_months"] == 7
    print("OK test_sppd_settings_sequence")


if __name__ == "__main__":
    main()
