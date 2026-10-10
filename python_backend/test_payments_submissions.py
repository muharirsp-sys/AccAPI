"""Tujuan: Self-check BL-50 (S6-0e butir 3) — daftar & detail Pengajuan/SPPD bisa dibuka ulang (baca-saja).
Caller: `python test_payments_submissions.py` via run_checks.py. Dependensi: routers.payments, shared.
Main Functions: main; assert izin payments.view, berkas hanya yang BENAR-BENAR ada (restore files=[] -> kosong,
  bukan tebakan), ringkasan transfer/posting per pengajuan, rute Panin = SPPD, waktu WITA, 404 berpesan Indonesia.
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

TMP = tempfile.mkdtemp(prefix="payments-subs-")
DB_PATH = os.path.join(TMP, "payments.json")
FILES = os.path.join(TMP, "files")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["PAYMENTS_FILES_DIR"] = FILES
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routers import payments  # noqa: E402

ALLOW = {"payments.view"}
payments.get_current_user = lambda request: "betterauth|staff|stf@x.test"
payments.user_has_permission = lambda user, module, action: f"{module}.{action}" in ALLOW
app = FastAPI()
app.include_router(payments.router)
client = TestClient(app)


def rec(no, sid, status, post="", pay=1000.0, principle="PT ABC"):
    return {"record_id": no, "tipe_pengajuan": "LPB", "no_lpb": no, "principle": principle, "invoice_no": f"INV-{no}",
            "nilai_invoice": pay + 100, "potongan": 100.0, "nilai_pembayaran": pay, "status_pembayaran": status,
            "accurate_post_status": post, "submission_id": sid, "draft_id": "D-" + sid, "sppd_no": "031/SPA/PDSB/X/2026" if sid == "S1" else "",
            "submitted_at": "2026-10-09 10:00:00", "submitted_by": "stf", "target_payment_date": "2026-10-10",
            "payment_method": "Bank Panin" if sid == "S1" else "Non Panin",
            "accurate_purchase_payment_number": "PP/1010/1" if post == "posted" else ""}


def seed():
    os.makedirs(FILES, exist_ok=True)
    for name in ("invoice_S1_pt-abc_lpb.xlsx", "sppd_S1.docx"):
        open(os.path.join(FILES, name), "wb").write(b"x")
    submissions = {
        "S1": {"id": "S1", "created_at": "2026-10-09 10:00:00", "created_by": "stf", "method": "BANK_PANIN",
               "target_payment_date": "2026-10-10", "record_ids": ["A", "B"], "sppd_file": "sppd_S1.docx", "sppd_no": "031/SPA/PDSB/X/2026",
               "files": [{"label": "Invoice PT ABC (LPB)", "url": "/payments/files/invoice_S1_pt-abc_lpb.xlsx"},
                         {"label": "Invoice HILANG", "url": "/payments/files/invoice_S1_hilang.xlsx"},
                         {"label": "SPPD Bank Panin", "url": "/payments/files/sppd_S1.docx"}],
               "cart_items": {"PT ABC||LPB": {"jenis_pembayaran": "TRF", "potongan": 200.0}}},
        # Hasil restore backup: files=[] (shared.rebuild_payment_submissions) -> berkas kosong, bukan tebakan nama.
        "S2": {"id": "S2", "created_at": "2026-10-08 09:00:00", "created_by": "stf", "method": "NON_PANIN",
               "target_payment_date": "2026-10-09", "record_ids": ["C"], "files": [], "sppd_file": "", "sppd_no": "", "cart_items": {}},
    }
    lpb = {"A": rec("A", "S1", "Sudah Transfer", "posted"), "B": rec("B", "S1", "Belum Transfer", pay=500.0),
           "C": rec("C", "S2", "Sudah Transfer", "failed"), "D": {**rec("D", "S3", "Ajukan Ulang"), "submitted_at": "2026-10-01 08:00:00"}, "E": rec("E", "", "")}
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"lpb": lpb, "submissions": submissions, "drafts": {}, "proofs": {}}, f)


def main_check():
    seed()
    before = open(DB_PATH, encoding="utf-8").read()
    r = client.get("/payments/submissions")
    assert r.status_code == 200, r.text[:300]
    data = {x["id"]: x for x in r.json()["data"]}
    assert set(data) == {"S1", "S2", "S3"}, data.keys()  # S3 hanya ada di rekaman (data lama) tetap terlihat
    assert [x["id"] for x in r.json()["data"]][:2] == ["S1", "S2"], "urutan bukan terbaru dulu"

    s1 = data["S1"]
    assert s1["sppd_no"] == "031/SPA/PDSB/X/2026" and s1["method"] == "BANK_PANIN" and s1["route_label"] == "Bank Panin (SPPD)", s1
    assert s1["record_count"] == 2 and s1["total_pembayaran"] == 1500.0 and s1["total_invoice"] == 1700.0, s1
    assert s1["transfer"] == {"Sudah Transfer": 1, "Belum Transfer": 1}, s1["transfer"]
    assert s1["posting"] == {"posted": 1, "belum": 1}, s1["posting"]
    assert [f["name"] for f in s1["files"]] == ["invoice_S1_pt-abc_lpb.xlsx", "sppd_S1.docx"], s1["files"]
    assert all(f["url"] == f"/payments/files/{f['name']}" for f in s1["files"]), s1["files"]
    assert s1["status"] == "sebagian", s1["status"]

    assert data["S2"]["files"] == [] and data["S2"]["route_label"] == "Non Panin", data["S2"]
    assert data["S3"]["files"] == [] and data["S3"]["record_count"] == 1 and data["S3"]["status"] == "dikembalikan", data["S3"]

    # Jejak waktu ledger ditulis jam server; tampil WITA = UTC+8 dari jam server itu.
    expected = "2026-10-09 18:00:00"  # jam server UTC 10:00 = 18:00 WITA
    assert s1["created_at_wita"] == expected, (s1["created_at_wita"], expected)

    r = client.get("/payments/submissions/S1")
    assert r.status_code == 200, r.text[:300]
    detail = r.json()["data"]
    rows = {x["record_id"]: x for x in detail["records"]}
    assert set(rows) == {"A", "B"} and rows["A"]["accurate_post_status"] == "posted" and rows["A"]["locked_reason"], rows
    assert "diajukan" in rows["B"]["locked_reason"] and rows["A"]["accurate_purchase_payment_number"] == "PP/1010/1", rows
    assert detail["cart_items"]["PT ABC||LPB"]["jenis_pembayaran"] == "TRF", detail["cart_items"]

    r = client.get("/payments/submissions/TIDAK-ADA")
    assert r.status_code == 404 and r.json() == {"ok": False, "error": "Pengajuan tidak ditemukan."}, r.text

    ALLOW.clear()
    for path in ("/payments/submissions", "/payments/submissions/S1"):
        assert client.get(path).status_code == 403, f"{path} tanpa payments.view"
    assert open(DB_PATH, encoding="utf-8").read() == before, "endpoint baca mengubah ledger"
    print("OK test_payments_submissions")


if __name__ == "__main__":
    main_check()
