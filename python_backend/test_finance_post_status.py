"""Tujuan: Self-check status posting purchase-payment Accurate di /payments/finance/update (AM-014, H05/H06).
Caller: `python test_finance_post_status.py` via run_checks.py. Dependensi: routers.finance, shared.
Main Functions: main; assert posted tidak bisa diturunkan, unknown tidak bisa dilewati tanpa catatan
  penyelesaian (atestasi manual berlabel), status tak dikenal ditolak — bukan dipaksa "failed".
Side Effects: file sementara di direktori temp saja.
"""
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="finance-post-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import shared  # noqa: E402
from routers import finance  # noqa: E402

finance.get_current_user = lambda request: "betterauth|finance|fin@x.test"
finance.user_has_permission = lambda user, module, action: True
finance.validate_csrf_request = lambda request, token: True
app = FastAPI()
app.include_router(finance.router)
client = TestClient(app)
PROOF = {"p1": {"proof_id": "p1", "sha256": "ab"}}


def seed(status, pp_id=""):
    rec = {"principle": "KINO", "no_lpb": "LPB-1", "status_pembayaran": "Belum Transfer",
           "accurate_post_status": status, "accurate_purchase_payment_id": pp_id}
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"lpb": {"LPB-1": rec}, "proofs": PROOF}, f)


def update(**fields):
    item = {"no_lpb": "LPB-1", "status_pembayaran": "Sudah Transfer", "transfer_date": "2026-09-29", "proof_id": "p1", **fields}
    return client.post("/payments/finance/update", json={"items": [item]})


def rec():
    return shared.load_payments_db()["lpb"]["LPB-1"]


def main():
    # 1) posted tidak bisa diturunkan klien (dulu: 200 dan id hilang -> tombol posting aktif lagi).
    seed("posted", "5501")
    r = update(accurate_post_status="failed", accurate_post_error="timeout")
    assert r.status_code == 409, f"posted diturunkan ke failed: {r.status_code} {r.text[:200]}"
    assert rec()["accurate_post_status"] == "posted" and rec()["accurate_purchase_payment_id"] == "5501"

    # 2) jawaban ambigu disimpan sebagai unknown (dulu dipaksa 'failed' = boleh posting ulang).
    seed("")
    r = update(accurate_post_status="unknown", accurate_post_error="timeout 30s")
    assert r.status_code == 200, r.text[:200]
    assert rec()["accurate_post_status"] == "unknown", rec()["accurate_post_status"]

    # 3) keluar dari unknown hanya dengan catatan penyelesaian, tercatat sebagai atestasi manual.
    r = update(accurate_post_status="failed")
    assert r.status_code == 409, f"unknown dilewati tanpa pemeriksaan: {r.status_code} {r.text[:200]}"
    assert rec()["accurate_post_status"] == "unknown"
    r = update(accurate_post_status="posted", accurate_purchase_payment_number="PP/0929/7",
               resolution_note="dicek di Accurate: PP/0929/7 ada")
    assert r.status_code == 200, r.text[:200]
    after = rec()
    assert after["accurate_post_status"] == "posted"
    res = after.get("accurate_post_resolution") or {}
    assert res.get("from") == "unknown" and res.get("source") == "manual_attestation" and res.get("by"), res

    # 3b) review #3: penyelesaian tidak menghapus bukti yang membuatnya unknown, dan butuh
    #     catatan bermakna serta status tujuan eksplisit (posted/failed).
    seed("")
    r = update(accurate_post_status="unknown", accurate_post_error="timeout 30s",
               accurate_post_response={"raw": "potongan"}, accurate_payload_digest="abc:123")
    assert r.status_code == 200, r.text[:200]
    for bad in [dict(accurate_post_status="failed", resolution_note="x"),
                dict(accurate_post_status="", resolution_note="dicek manual di Accurate: tidak ditemukan")]:
        r = update(**bad)
        assert r.status_code in (400, 409), f"penyelesaian lemah diterima: {bad} -> {r.status_code}"
        assert rec()["accurate_post_status"] == "unknown"
    r = update(accurate_post_status="failed", resolution_note="dicek manual di Accurate: tidak ditemukan")
    assert r.status_code == 200, r.text[:200]
    prev = (rec().get("accurate_post_resolution") or {}).get("previous") or {}
    assert prev.get("error") == "timeout 30s" and prev.get("response") == {"raw": "potongan"} and prev.get("digest") == "abc:123", prev

    # 4) status tak dikenal ditolak, bukan dipaksa 'failed'.
    seed("")
    r = update(accurate_post_status="verified")
    assert r.status_code == 400, f"status tak dikenal: {r.status_code} {r.text[:200]}"
    assert rec()["accurate_post_status"] == ""

    # 5) D-14 (owner 2026-09-30): keluar dari unknown hanya kewenangan Finance (finance.retry_post) —
    #    pemegang finance.update saja (mis. preset manager) ditolak walau catatannya lengkap.
    seed("unknown")
    finance.user_has_permission = lambda user, module, action: not (module == "finance" and action == "retry_post")
    try:
        r = update(accurate_post_status="failed", resolution_note="dicek manual di Accurate: tidak ditemukan")
        assert r.status_code == 409 and "retry_post" in r.text, f"non-Finance menyelesaikan unknown: {r.status_code} {r.text[:200]}"
        assert rec()["accurate_post_status"] == "unknown"
    finally:
        finance.user_has_permission = lambda user, module, action: True
    print("OK test_finance_post_status")


if __name__ == "__main__":
    main()
