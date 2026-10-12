"""Tujuan: Self-check BL-49 (S6-0e butir 2) — rekaman yang posting Accurate-nya `posted`/`unknown` tidak bisa dikembalikan
  Finance ("Belum Transfer"/"Ajukan Ulang") dan tidak bisa diajukan ulang lewat keranjang Pembayaran.
Caller: `python test_finance_bl49.py` via run_checks.py. Dependensi: routers.finance, routers.payments, shared.
Main Functions: main; assert 409 berpesan Indonesia tanpa tulis (semua-atau-tidak per permintaan), `failed` berpesan
  jelas tetap boleh dikembalikan, keranjang create/submit menolak rekaman terkunci.
Side Effects: file sementara di direktori temp saja.
"""
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="finance-bl49-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["PAYMENTS_FILES_DIR"] = os.path.join(TMP, "files")
os.environ["BANK_DATA_PATH"] = os.path.join(TMP, "rekening.xlsx")
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import shared  # noqa: E402
from routers import finance, payments  # noqa: E402

for mod in (finance, payments):
    mod.get_current_user = lambda request: "betterauth|finance|fin@x.test"
    mod.user_has_permission = lambda user, module, action: True
    mod.validate_csrf_request = lambda request, token: True
app = FastAPI()
app.include_router(finance.router)
app.include_router(payments.router)
client = TestClient(app)


def rec(no, status, post, error="", principle="PT ABC", sub="S1"):
    return {"record_id": no, "tipe_pengajuan": "LPB", "no_lpb": no, "principle": principle, "invoice_no": f"INV-{no}",
            "tgl_invoice": "2026-10-01", "jt_invoice": "2026-10-30", "nilai_invoice": 1000.0, "status_pembayaran": status,
            "accurate_post_status": post, "accurate_post_error": error, "submission_id": sub, "draft_id": "D1",
            "submitted_at": "2026-10-09 10:00:00", "target_payment_date": "2026-10-10",
            "accurate_purchase_payment_number": "PP/1010/1" if post == "posted" else ""}


def seed(lpb):
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"lpb": lpb, "submissions": {}, "drafts": {}, "proofs": {}}, f)
    return open(DB_PATH, encoding="utf-8").read()


def raw():
    return open(DB_PATH, encoding="utf-8").read()


def mark(no, status):
    return client.post("/payments/finance/update", json={"items": [{"no_lpb": no, "status_pembayaran": status}]})


def check_finance_return():
    for post, error in [("posted", ""), ("unknown", "timeout"), ("failed", "Accurate tidak merespons (timeout)")]:
        before = seed({"A": rec("A", "Sudah Transfer", post, error)})
        for status in ("Belum Transfer", "Ajukan Ulang"):
            r = mark("A", status)
            assert r.status_code == 409, f"{status} diterima untuk posting {post}: {r.status_code} {r.text[:200]}"
            assert "Accurate" in r.json()["error"], r.json()
            assert raw() == before, "ditolak tetapi ledger berubah"

    # Grup per principal (jalur layar Finance): satu rekaman terposting = seluruh grup ditolak, tidak ada yang berubah.
    before = seed({"A": rec("A", "Sudah Transfer", "posted"), "B": rec("B", "Sudah Transfer", "")})
    r = client.post("/payments/finance/update", json={"items": [{"principle": "PT ABC", "submission_id": "S1", "status_pembayaran": "Ajukan Ulang"}]})
    assert r.status_code == 409 and raw() == before, f"grup sebagian dikembalikan: {r.status_code}"

    # failed berpesan JELAS / skipped / belum posting: Finance tetap boleh mengembalikan (owner 9 Okt).
    seed({"A": rec("A", "Sudah Transfer", "failed", "Vendor tidak ditemukan"), "B": rec("B", "Sudah Transfer", "skipped")})
    assert mark("A", "Ajukan Ulang").status_code == 200
    assert mark("B", "Belum Transfer").status_code == 200
    db = shared.load_payments_db()["lpb"]
    assert db["A"]["status_pembayaran"] == "Ajukan Ulang" and db["B"]["status_pembayaran"] == "Belum Transfer"


def check_cart_resubmit():
    # Data lama: "Ajukan Ulang" padahal sudah posted -> keranjang menolak (dulu _already_submitted meloloskan).
    before = seed({"A": rec("A", "Ajukan Ulang", "posted"), "C": rec("C", "", "", sub="")})
    r = client.post("/payments/cart/create", json={"method": "NON_PANIN", "record_ids": ["A", "C"]})
    assert r.status_code == 409, f"keranjang menerima rekaman terposting: {r.status_code} {r.text[:200]}"
    assert "A" in r.json()["error"] and raw() == before, r.json()

    # Draf dibuat SEBELUM rekaman terposting -> submit tetap menolak (cek ulang di dalam lock tulis).
    seed({"A": rec("A", "Ajukan Ulang", "failed", "Vendor tidak ditemukan"), "C": rec("C", "", "", sub="")})
    r = client.post("/payments/cart/create", json={"method": "NON_PANIN", "record_ids": ["A", "C"]})
    assert r.status_code == 200, r.text[:200]
    draft_id = r.json()["draft_id"]
    db = shared.load_payments_db()
    db["lpb"]["A"]["accurate_post_status"] = "posted"
    shared.save_payments_db(db)
    before = raw()
    items = [{"group_key": "PT ABC||LPB", "principle": "PT ABC", "jenis_pembayaran": "TRF", "potongan": 0}]
    r = client.post("/payments/cart/submit", json={"draft_id": draft_id, "items": items, "target_payment_date": "2026-10-11"})
    assert r.status_code == 409, f"submit menerima rekaman yang terposting setelah draf dibuat: {r.status_code} {r.text[:200]}"
    assert raw() == before, "submit ditolak tetapi ledger berubah"


def main_check():
    check_finance_return()
    check_cart_resubmit()
    print("OK test_finance_bl49")


if __name__ == "__main__":
    main_check()
