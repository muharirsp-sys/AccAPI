"""Tujuan: Self-check S6-0e butir 6 — baris /payments/finance/data memuat siapa & kapan memposting (WITA) dan
  penyelesaian posting tidak pasti (atestasi manual), tanpa membocorkan bukti mentah `previous`.
Caller: `python test_finance_data_fields.py` via run_checks.py. Dependensi: routers.finance, shared.
Main Functions: main; assert accurate_posted_by, accurate_posted_at (WITA), accurate_post_resolution ringkas.
Side Effects: file sementara di direktori temp saja.
"""
import json
import os
import tempfile

import subprocess
import sys

# Server produksi berjalan UTC: jalankan ulang uji ini dengan zona proses UTC supaya konversi WITA benar-benar diuji
# (di mesin berzona WITA, jam server == WITA dan konversi yang hilang tidak akan ketahuan).
if os.environ.get("TZ") != "UTC0":
    sys.exit(subprocess.call([sys.executable, os.path.abspath(__file__)], env={**os.environ, "TZ": "UTC0"}))

TMP = tempfile.mkdtemp(prefix="finance-fields-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routers import finance  # noqa: E402

finance.get_current_user = lambda request: "betterauth|finance|fin@x.test"
finance.user_has_permission = lambda user, module, action: True
app = FastAPI()
app.include_router(finance.router)
client = TestClient(app)


def wita(text):
    assert text == "2026-10-10 02:15:00"
    return "2026-10-10 10:15:00"  # jam server UTC 02:15 = 10:15 WITA


def main_check():
    base = {"principle": "PT ABC", "tipe_pengajuan": "LPB", "submitted_at": "2026-10-09 10:00:00", "target_payment_date": "2026-10-10",
            "status_pembayaran": "Sudah Transfer", "submission_id": "S1", "draft_id": "D1"}
    lpb = {
        "A": {**base, "no_lpb": "A", "accurate_post_status": "posted", "accurate_purchase_payment_number": "PP/1010/1",
              "accurate_posted_by": "betterauth|finance|fin@x.test", "accurate_posted_at": "2026-10-10 02:15:00",
              "accurate_post_resolution": {"from": "unknown", "to": "posted", "source": "manual_attestation", "by": "betterauth|finance|fin@x.test",
                                           "at": "2026-10-10 02:15:00", "note": "dicek manual di Accurate: PP/1010/1 ada",
                                           "previous": {"error": "timeout", "response": {"raw": "rahasia"}}}},
        "B": {**base, "no_lpb": "B", "principle": "PT XYZ", "accurate_post_status": "", "submission_id": "S2", "draft_id": "D2"},
    }
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"lpb": lpb}, f)
    rows = {r["principle"]: r for r in client.get("/payments/finance/data?date=2026-10-10").json()["data"]}
    a = rows["PT ABC"]
    assert a["accurate_posted_by"] == "betterauth|finance|fin@x.test", a
    assert a["accurate_posted_at"] == wita("2026-10-10 02:15:00"), (a["accurate_posted_at"], wita("2026-10-10 02:15:00"))
    res = a["accurate_post_resolution"]
    assert res == {"from": "unknown", "to": "posted", "source": "manual_attestation", "by": "betterauth|finance|fin@x.test",
                   "at": wita("2026-10-10 02:15:00"), "note": "dicek manual di Accurate: PP/1010/1 ada"}, res
    b = rows["PT XYZ"]
    assert b["accurate_posted_by"] == "" and b["accurate_posted_at"] == "" and b["accurate_post_resolution"] is None, b
    print("OK test_finance_data_fields")


if __name__ == "__main__":
    main_check()
