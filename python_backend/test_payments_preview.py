"""Tujuan: Self-check pratinjau (dry-run) S6-0e butir 4 — unggah LPB, Excel SPPD, ganti nama principal: `?dry_run=1`
  TIDAK menulis apa pun, dan jawabannya = hasil eksekusi pada data yang sama (kode yang sama).
Caller: `python test_payments_preview.py` via run_checks.py. Dependensi: routers.payments, routers.sppd, main, shared.
Main Functions: main; assert ledger byte-identik setelah pratinjau, ringkasan pratinjau == ringkasan eksekusi,
  duplikat (sistem & di berkas) / angka invalid / rekaman terkunci / tidak ditemukan terlaporkan.
Side Effects: file sementara di direktori temp saja.
"""
import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="payments-preview-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["PAYMENTS_FILES_DIR"] = os.path.join(TMP, "files")
os.environ["BANK_DATA_PATH"] = os.path.join(TMP, "rekening.xlsx")
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

import pandas as pd  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
from routers import payments, sppd  # noqa: E402

for mod in (payments, sppd, main):
    mod.get_current_user = lambda request: "betterauth|admin|uji@x.test"
    mod.user_has_permission = lambda user, module, action: True
    mod.validate_csrf_request = lambda request, token: True
client = TestClient(main.app)
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def seed():
    lpb = {
        "LPB-OLD": {"record_id": "LPB-OLD", "tipe_pengajuan": "LPB", "no_lpb": "LPB-OLD", "principle": "PT ABC", "nilai_invoice": 1000.0,
                    "keterangan": "", "status_pembayaran": "", "accurate_post_status": ""},
        "LPB-TRF": {"record_id": "LPB-TRF", "tipe_pengajuan": "LPB", "no_lpb": "LPB-TRF", "principle": "PT ABC", "nilai_invoice": 2000.0,
                    "keterangan": "", "status_pembayaran": "Sudah Transfer", "accurate_post_status": "posted", "submission_id": "S1"},
    }
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"lpb": lpb, "submissions": {}, "drafts": {}, "proofs": {},
                   "finance_mappings": {"PT ABC": {"principle": "PT ABC", "vendorNo": "V1", "bankNo": "B1"}}}, f)
    return open(DB_PATH, encoding="utf-8").read()


def raw():
    return open(DB_PATH, encoding="utf-8").read()


def xlsx(rows, name="f.xlsx"):
    buf = io.BytesIO()
    pd.DataFrame(rows).to_excel(buf, index=False)
    return {"file": (name, buf.getvalue(), XLSX)}


def lpb_row(no, nilai, principle="PT XYZ"):
    return {"TGL. SETOR": "01/10/2026", "NO. LPB": no, "TGL. WIN": "01/10/2026", "TGL. J. TEMPO WIN": "30/10/2026",
            "PRINCIPLE": principle, "NILAI WIN": nilai, "TGL TERIMA BARANG": "01/10/2026", "Nilai Invoice": nilai}


def strip(body, *keys):
    return {k: v for k, v in body.items() if k not in keys}


SUMMARY_KEYS = ("rows", "total_nilai_win", "total_nilai_invoice", "duplicates", "duplicates_in_file", "invalid")


def check_lpb():
    before = seed()
    good = [lpb_row("LPB-N1", "1.500.000"), lpb_row("LPB-N2", 2500000)]
    pre = client.post("/payments/upload?dry_run=1", files=xlsx(good))
    assert pre.status_code == 200, pre.text[:300]
    assert raw() == before, "pratinjau LPB menulis ledger"
    p = pre.json()
    assert p["dry_run"] is True and p["can_apply"] is True and p["rows"] == 2 and p["total_nilai_win"] == 4000000.0, p
    run = client.post("/payments/upload", files=xlsx(good))
    assert run.status_code == 200 and run.json()["added"] == 2, run.text[:300]
    assert {k: p[k] for k in SUMMARY_KEYS} == {k: run.json()[k] for k in SUMMARY_KEYS}, (p, run.json())

    # Duplikat sistem + duplikat DI BERKAS (dulu baris kedua diam-diam menimpa baris pertama) + angka invalid.
    before = seed()
    bad = [lpb_row("LPB-OLD", 10), lpb_row("LPB-D", 10), lpb_row("lpb-d", 20), lpb_row("LPB-X", "abc")]
    pre = client.post("/payments/upload?dry_run=1", files=xlsx(bad))
    assert pre.status_code == 200 and raw() == before, pre.text[:300]
    p = pre.json()
    assert p["can_apply"] is False and p["duplicates"] == ["LPB-OLD"] and p["duplicates_in_file"] == ["lpb-d"], p
    assert len(p["invalid"]) == 2 and all("abc" in x and "baris 5" in x for x in p["invalid"]), p["invalid"]
    run = client.post("/payments/upload", files=xlsx(bad))
    assert run.status_code == 400 and raw() == before, run.text[:300]
    assert {k: p[k] for k in SUMMARY_KEYS} == {k: run.json()[k] for k in SUMMARY_KEYS}, (p, run.json())

    bad = [lpb_row("LPB-D", 10), lpb_row("LPB-D", 20)]
    run = client.post("/payments/upload", files=xlsx(bad))
    assert run.status_code == 400 and "ganda di berkas" in run.json()["error"] and raw() == before, run.text[:300]


def check_lpb_key_collision():
    """Putaran 2 butir 1: KUNCI dict rekaman lama = No. LPB baru, padahal no_lpb rekaman itu sudah diganti -> dulu
    lolos cek duplikat (per no_lpb) lalu `db["lpb"]["1234"]` tertimpa: jejak transfer + PP hilang."""
    trf = {"record_id": "1234", "tipe_pengajuan": "LPB", "no_lpb": "5678", "principle": "PT ABC", "nilai_invoice": 1000.0,
           "status_pembayaran": "Sudah Transfer", "accurate_post_status": "posted", "accurate_purchase_payment_number": "PP-1",
           "submission_id": "S1"}
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"lpb": {"1234": trf}}, f)
    before = raw()
    p = client.post("/payments/upload?dry_run=1", files=xlsx([lpb_row("1234", 10)])).json()
    assert p["can_apply"] is False and p["duplicates"] == ["1234"], p
    r = client.post("/payments/upload", files=xlsx([lpb_row("1234", 10)]))
    assert r.status_code == 400 and raw() == before, f"rekaman berkunci '1234' tertimpa unggah LPB: {r.status_code} {r.text[:200]}"


def check_sppd_excel():
    rows = [{"Record ID": "LPB-OLD", "Keterangan": "baru", "Nilai Invoice": 1500}, {"Record ID": "LPB-TRF", "Nilai Invoice": 2000},
            {"Record ID": "TIDAK-ADA", "Keterangan": "x"}]
    before = seed()
    pre = client.post("/payments/sppd/upload?dry_run=1", files=xlsx(rows))
    assert pre.status_code == 200 and raw() == before, pre.text[:300]
    p = pre.json()
    assert p["dry_run"] is True and p["can_apply"] is True and p["updated"] == 1 and p["unchanged"] == 1, p
    diff = {d["field"]: (d["old"], d["new"]) for d in p["changes"][0]["fields"]}
    assert diff == {"keterangan": ("", "baru"), "nilai_invoice": (1000.0, 1500.0)}, diff
    assert p["not_found"] == ["TIDAK-ADA"], p
    run = client.post("/payments/sppd/upload", files=xlsx(rows))
    assert run.status_code == 200, run.text[:300]
    assert strip(p, "dry_run", "can_apply") == strip(run.json(), "dry_run", "can_apply"), (p, run.json())

    # Rekaman terkunci yang berubah: pratinjau menyebutnya (can_apply false), eksekusi 409 dengan isi yang sama.
    before = seed()
    rows = [{"Record ID": "LPB-OLD", "Keterangan": "baru"}, {"Record ID": "LPB-TRF", "Nilai Invoice": 9}]
    p = client.post("/payments/sppd/upload?dry_run=1", files=xlsx(rows)).json()
    assert p["can_apply"] is False and [x["record_id"] for x in p["locked"]] == ["LPB-TRF"] and raw() == before, p
    run = client.post("/payments/sppd/upload", files=xlsx(rows))
    assert run.status_code == 409 and raw() == before, run.text[:300]
    assert strip(p, "dry_run", "can_apply", "ok", "error") == strip(run.json(), "dry_run", "can_apply", "ok", "error")


def check_rename():
    before = seed()
    pre = client.post("/api/bank-data/replace-principle-name?dry_run=1", json={"old_name": "PT ABC", "new_name": "PT ABC BARU"})
    assert pre.status_code == 200 and raw() == before, pre.text[:300]
    p = pre.json()
    assert p["dry_run"] is True and p["replaced"] == 1 and p["locked_skipped"] == 1, p
    assert p["per_status"] == {"Draf": 1, "Sudah Transfer": 1}, p["per_status"]
    assert p["finance_mapping"] == {"old_name_has_mapping": True, "new_name_has_mapping": False, "needs_remap": True}, p
    # Badan JSON `dry_run: true` setara query.
    assert client.post("/api/bank-data/replace-principle-name", json={"old_name": "PT ABC", "new_name": "PT ABC BARU", "dry_run": True}).json()["dry_run"] is True
    assert raw() == before
    run = client.post("/api/bank-data/replace-principle-name", json={"old_name": "PT ABC", "new_name": "PT ABC BARU"})
    assert run.status_code == 200 and run.json()["dry_run"] is False, run.text[:300]
    assert strip(p, "dry_run", "message") == strip(run.json(), "dry_run", "message"), (p, run.json())
    assert json.loads(raw())["lpb"]["LPB-OLD"]["principle"] == "PT ABC BARU"


def main_check():
    check_lpb()
    check_lpb_key_collision()
    check_sppd_excel()
    check_rename()
    print("OK test_payments_preview")


if __name__ == "__main__":
    main_check()
