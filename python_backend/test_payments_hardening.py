"""Tujuan: Self-check pengetatan S6-0e butir 7 di jalur Pembayaran — cart-info tidak membocorkan PATH/daftar draf
  (pesan generik + log server), tanggal bayar bawaan keranjang = besok WITA (bukan besok jam server UTC).
Caller: `python test_payments_hardening.py` via run_checks.py. Dependensi: routers.payments, shared.
Main Functions: main.
Side Effects: file sementara di direktori temp saja.
"""
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="payments-hardening-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["PAYMENTS_FILES_DIR"] = os.path.join(TMP, "files")
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import shared  # noqa: E402
from routers import payments  # noqa: E402

payments.get_current_user = lambda request: "betterauth|admin|adm@x.test"
payments.user_has_permission = lambda user, module, action: True
payments.validate_csrf_request = lambda request, token: True
payments.is_admin_user = lambda user: True
app = FastAPI()
app.include_router(payments.router)
client = TestClient(app)


def main_check():
    rec = {"record_id": "A", "tipe_pengajuan": "LPB", "no_lpb": "A", "principle": "PT ABC", "invoice_no": "INV-A",
           "tgl_invoice": "2026-10-01", "jt_invoice": "2026-10-30", "nilai_invoice": 1000.0, "status_pembayaran": ""}
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"lpb": {"A": rec}, "drafts": {"rahasia1": {"id": "rahasia1", "created_by": "lain", "items": []}}}, f)

    # cart-info: admin dulu menerima "PATH=<lokasi payments.json>. Drafts: <id draf orang lain>".
    r = client.get("/payments/cart-info?draft=tidak-ada")
    assert r.status_code == 404, r.text[:200]
    assert r.json() == {"ok": False, "error": "Draft tidak ditemukan."}, f"cart-info membocorkan detail server: {r.text[:200]}"
    assert DB_PATH not in r.text and "rahasia1" not in r.text

    # Tanggal bayar bawaan = besok menurut WITA (23:30 WITA 5 Mar = 15:30 UTC: jam server UTC masih 5 Mar).
    payments.wita_now = lambda: shared.pd.Timestamp("2027-03-05 23:30:00")
    r = client.post("/payments/cart/create", json={"method": "NON_PANIN", "record_ids": ["A"]})
    assert r.status_code == 200, r.text[:200]
    draft = shared.load_payments_db()["drafts"][r.json()["draft_id"]]
    assert draft["target_payment_date"] == "2027-03-06", draft["target_payment_date"]
    draft_id = r.json()["draft_id"]
    db = shared.load_payments_db()
    db["drafts"][draft_id]["target_payment_date"] = ""
    shared.save_payments_db(db)
    r = client.get(f"/payments/cart-info?draft={draft_id}")
    assert r.status_code == 200 and r.json()["target_payment_date"] == "2027-03-06", r.text[:200]
    print("OK test_payments_hardening")


if __name__ == "__main__":
    main_check()
