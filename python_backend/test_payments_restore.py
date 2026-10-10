"""Tujuan: Self-check S6-0e butir 5 — Restore backup PAYMENTS dipisah dari unggah LPB: endpoint sendiri berizin
  sppd.edit_settings + CSRF + pratinjau ringkas; nomor SPPD tidak pernah turun karena restore (D-05/C10).
Caller: `python test_payments_restore.py` via run_checks.py. Dependensi: routers.payments, routers.sppd, shared.
Main Functions: main; assert unggah LPB menolak berkas backup (400, tanpa tulis), pratinjau restore = hasil eksekusi
  tanpa tulis, konflik = semua-atau-tidak, izin & CSRF ditegakkan, urutan SPPD naik ke yang dipulihkan, tak pernah turun.
Side Effects: file sementara di direktori temp saja.
"""
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="payments-restore-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["PAYMENTS_FILES_DIR"] = os.path.join(TMP, "files")
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import shared  # noqa: E402
from routers import payments, sppd  # noqa: E402

ALLOW = {"payments.view", "payments.edit", "sppd.edit_settings"}
CSRF_OK = [True]
for mod in (payments, sppd):
    mod.get_current_user = lambda request: "betterauth|admin|uji@x.test"
    mod.user_has_permission = lambda user, module, action: f"{module}.{action}" in ALLOW
    mod.validate_csrf_request = lambda request, token: CSRF_OK[0]
app = FastAPI()
app.include_router(payments.router)
app.include_router(sppd.router)
client = TestClient(app)
YEAR = shared.wita_now().year
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def write(obj):
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    return open(DB_PATH, encoding="utf-8").read()


def raw():
    return open(DB_PATH, encoding="utf-8").read()


def rec(no, sid="", sppd_no=""):
    return {"record_id": no, "tipe_pengajuan": "LPB", "no_lpb": no, "principle": "PT ABC", "nilai_invoice": 1000.0,
            "nilai_win": 1000.0, "potongan": 0.0, "nilai_pembayaran": 1000.0 if sid else 0.0, "invoice_no": f"INV-{no}",
            "status_pembayaran": "Belum Transfer" if sid else "", "submission_id": sid, "sppd_no": sppd_no,
            "submitted_at": f"{YEAR}-10-09 10:00:00" if sid else "", "payment_method": "Bank Panin" if sid else ""}


def backup_file(lpb):
    """Berkas backup ASLI dari /payments/export (bukan buatan tangan)."""
    write({"lpb": lpb})
    r = client.get("/payments/export")
    assert r.status_code == 200, r.text[:200]
    return {"file": ("backup_payments.xlsx", r.content, XLSX)}


def sppd_seq():
    settings = shared.load_payments_db()["sppd_settings"]
    return settings["last_sequence"], settings.get("sequence_year")


def main_check():
    files = backup_file({"A": rec("A", "S9", f"045/SPA/PDSB/X/{YEAR}"), "B": rec("B", "S9", f"045/SPA/PDSB/X/{YEAR}"), "C": rec("C")})
    target = {"lpb": {"OLD": rec("OLD")}, "sppd_settings": {"last_sequence": 30, "sequence_year": YEAR}}

    # 1) Unggah LPB menolak berkas backup (dulu: restore diam-diam dengan izin payments.edit saja).
    before = write(target)
    r = client.post("/payments/upload", files=files)
    assert r.status_code == 400 and "Restore backup" in r.json()["error"], r.text[:200]
    assert raw() == before, "unggah LPB menulis berkas backup"

    # 2) Izin & CSRF.
    ALLOW.discard("sppd.edit_settings")
    r = client.post("/payments/sppd/restore-backup", files=files)
    assert r.status_code == 403 and raw() == before, f"restore tanpa sppd.edit_settings: {r.status_code}"
    ALLOW.add("sppd.edit_settings")
    CSRF_OK[0] = False
    r = client.post("/payments/sppd/restore-backup", files=files)
    assert r.status_code == 403 and raw() == before, f"restore tanpa CSRF: {r.status_code}"
    CSRF_OK[0] = True

    # 3) Pratinjau ringkas tanpa tulis = hasil eksekusi.
    pre = client.post("/payments/sppd/restore-backup?dry_run=1", files=files)
    assert pre.status_code == 200 and raw() == before, pre.text[:300]
    p = pre.json()
    assert p["dry_run"] is True and p["can_apply"] is True, p
    assert (p["records"], p["submissions"], p["new_submissions"], p["draft_records"]) == (3, 1, 1, 1), p
    assert p["sppd"] == {"year": YEAR, "last_sequence_before": 30, "max_restored": 45, "last_sequence_after": 45,
                         "next_number": shared.format_sppd_number(46, shared.wita_now())}, p["sppd"]
    run = client.post("/payments/sppd/restore-backup", files=files)
    assert run.status_code == 200, run.text[:300]
    keys = ("records", "submissions", "new_submissions", "draft_records", "sppd", "conflicts")
    assert {k: p[k] for k in keys} == {k: run.json()[k] for k in keys}, (p, run.json())
    db = shared.load_payments_db()
    assert set(db["lpb"]) == {"OLD", "A", "B", "C"} and db["submissions"]["S9"]["files"] == [], db["submissions"]
    assert sppd_seq() == (45, YEAR), sppd_seq()

    # 4) Konflik = semua-atau-tidak (pratinjau melaporkan, eksekusi 400 tanpa tulis).
    before = raw()
    p = client.post("/payments/sppd/restore-backup?dry_run=1", files=files).json()
    assert p["can_apply"] is False and any("A" in c for c in p["conflicts"]), p
    r = client.post("/payments/sppd/restore-backup", files=files)
    assert r.status_code == 400 and raw() == before, r.text[:200]

    # 5) D-05: restore TIDAK PERNAH menurunkan nomor SPPD tahun berjalan.
    files = backup_file({"Z": rec("Z", "S8", f"010/SPA/PDSB/X/{YEAR}")})
    write({"lpb": {}, "sppd_settings": {"last_sequence": 30, "sequence_year": YEAR}})
    r = client.post("/payments/sppd/restore-backup", files=files)
    assert r.status_code == 200 and r.json()["sppd"]["last_sequence_after"] == 30, r.text[:300]
    assert sppd_seq() == (30, YEAR), f"restore menurunkan nomor SPPD: {sppd_seq()}"

    # 6) Berkas yang bukan backup ditolak di endpoint restore.
    r = client.post("/payments/sppd/restore-backup", files={"file": ("x.xlsx", backup_bytes_not_backup(), XLSX)})
    assert r.status_code == 400, r.text[:200]
    print("OK test_payments_restore")


def backup_bytes_not_backup():
    import io
    buf = io.BytesIO()
    shared.pd.DataFrame([{"NO. LPB": "X"}]).to_excel(buf, index=False)
    return buf.getvalue()


if __name__ == "__main__":
    main_check()
