"""Tujuan: Self-check BL-05 (S6-0e) — rekaman yang SUDAH DITRANSFER atau terposting/tidak pasti di Accurate terkunci
  di semua jalur tulis Pembayaran: update, delete, clear, Excel SPPD, ganti nama principal, auto-fix nama.
Caller: `python test_payments_lock.py` via run_checks.py. Dependensi: routers.payments, routers.sppd, main, shared.
Main Functions: main; assert penolakan semua-atau-tidak (409 + daftar rekaman terkunci, tanpa tulis), `ajukan`
  (pilihan layar) tetap boleh, nilai yang tidak berubah bukan pelanggaran, `failed` berpesan jelas tidak terkunci.
Side Effects: file sementara di direktori temp saja.
"""
import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="payments-lock-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["PAYMENTS_FILES_DIR"] = os.path.join(TMP, "files")
os.environ["BANK_DATA_PATH"] = os.path.join(TMP, "rekening.xlsx")
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

import pandas as pd  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import shared  # noqa: E402
import main  # noqa: E402
from routers import payments, sppd  # noqa: E402

for mod in (payments, sppd, main):
    mod.get_current_user = lambda request: "betterauth|admin|uji@x.test"
    mod.user_has_permission = lambda user, module, action: True
    mod.validate_csrf_request = lambda request, token: True
client = TestClient(main.app)


def rec(no, status="", post="", error="", principle="PT ABC", nilai=1000.0):
    return {"record_id": no, "tipe_pengajuan": "LPB", "no_lpb": no, "principle": principle, "invoice_no": f"INV-{no}",
            "nilai_invoice": nilai, "nilai_win": nilai, "status_pembayaran": status, "accurate_post_status": post,
            "accurate_post_error": error, "keterangan": "", "potongan": 0.0, "nilai_pembayaran": nilai,
            "submission_id": "S1" if status else ""}


def seed():
    lpb = {
        "OPEN-1": rec("OPEN-1"),
        "TRF-1": rec("TRF-1", "Sudah Transfer", "skipped"),
        # Data lama: "Ajukan Ulang" padahal sudah posted -> tetap terkunci (kunci dari posting, bukan status saja).
        "PST-1": rec("PST-1", "Ajukan Ulang", "posted"),
        # "failed" bergalat AMBIGU = unknown (tinjauan S6-0a) -> terkunci.
        "UNK-1": rec("UNK-1", "Belum Transfer", "failed", "Accurate tidak merespons dalam 30 detik (timeout)."),
        # "failed" berpesan JELAS (owner 9 Okt: boleh dikirim ulang) -> tidak terkunci.
        "FAIL-1": rec("FAIL-1", "Belum Transfer", "failed", "Vendor tidak ditemukan"),
    }
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump({"lpb": lpb, "submissions": {}, "drafts": {}, "proofs": {}}, f)
    return open(DB_PATH, encoding="utf-8").read()


def ledger():
    return shared.load_payments_db()["lpb"]


def raw():
    return open(DB_PATH, encoding="utf-8").read()


def xlsx(rows):
    buf = io.BytesIO()
    pd.DataFrame(rows).to_excel(buf, index=False)
    return {"file": ("sppd.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}


def check_helper():
    db = json.loads(seed())["lpb"]
    assert shared.payment_lock_reason(db["OPEN-1"]) == ""
    assert shared.payment_lock_reason(db["FAIL-1"]) == "", "failed berpesan jelas ikut terkunci"
    for key in ("TRF-1", "PST-1", "UNK-1"):
        assert shared.payment_lock_reason(db[key]), f"{key} tidak terkunci"


def check_update():
    before = seed()
    # Satu rekaman terkunci dalam permintaan = seluruh permintaan ditolak (kontrak semua-atau-tidak yang ada).
    r = client.post("/payments/update", json={"items": [
        {"record_id": "OPEN-1", "nilai_invoice": 2000},
        {"record_id": "TRF-1", "nilai_invoice": 5000},
    ]})
    assert r.status_code == 409, f"ubah nilai rekaman Sudah Transfer diterima: {r.status_code} {r.text[:200]}"
    body = r.json()
    assert body["ok"] is False and "TRF-1" in body["error"], body
    assert [x["record_id"] for x in body["locked"]] == ["TRF-1"] and body["locked"][0]["fields"] == ["nilai_invoice"], body
    assert raw() == before, "permintaan ditolak tetapi ledger berubah"

    for key, field, value in [("PST-1", "principle", "PT LAIN"), ("UNK-1", "invoice_no", "INV-X"), ("TRF-1", "tgl_pembayaran", "2026-10-01")]:
        r = client.post("/payments/update", json={"items": [{"record_id": key, field: value}]})
        assert r.status_code == 409, f"{key}.{field} terkunci tetapi diterima: {r.status_code}"
    assert raw() == before

    # `ajukan` = pilihan layar (it08 "Pilihan bukan data") tetap boleh; nilai yang SAMA bukan perubahan.
    r = client.post("/payments/update", json={"items": [{"record_id": "TRF-1", "ajukan": True, "principle": "PT ABC", "nilai_invoice": "1.000"}]})
    assert r.status_code == 200, r.text[:200]
    after = ledger()["TRF-1"]
    assert after["ajukan"] is True and after["principle"] == "PT ABC" and after["nilai_invoice"] == 1000.0, after

    # failed berpesan jelas & draf tetap bisa diubah.
    r = client.post("/payments/update", json={"items": [{"record_id": "FAIL-1", "nilai_invoice": 1500}, {"record_id": "OPEN-1", "invoice_no": "INV-BARU"}]})
    assert r.status_code == 200, r.text[:200]
    assert ledger()["FAIL-1"]["nilai_invoice"] == 1500.0 and ledger()["OPEN-1"]["invoice_no"] == "INV-BARU"


def check_delete_and_clear():
    before = seed()
    r = client.post("/payments/delete", json={"record_ids": ["OPEN-1", "PST-1"]})
    assert r.status_code == 409, f"hapus rekaman terposting diterima: {r.status_code} {r.text[:200]}"
    assert [x["record_id"] for x in r.json()["locked"]] == ["PST-1"], r.json()
    assert raw() == before, "hapus ditolak tetapi rekaman lain ikut terhapus"
    r = client.post("/payments/delete", json={"record_ids": ["OPEN-1"]})
    assert r.status_code == 200 and r.json()["deleted"] == 1, r.text[:200]
    assert "OPEN-1" not in ledger()

    before = raw()
    r = client.post("/payments/clear", json={"confirm": "CLEAR PAYMENTS"})
    assert r.status_code == 409, f"clear dengan rekaman terkunci diterima: {r.status_code} {r.text[:200]}"
    assert r.json()["locked_count"] == 3, r.json()
    assert raw() == before, "clear ditolak tetapi ledger berubah"


def check_sppd_excel():
    before = seed()
    files = xlsx([{"Record ID": "OPEN-1", "Keterangan": "boleh"}, {"Record ID": "TRF-1", "Nilai Pembayaran": 1}])
    r = client.post("/payments/sppd/upload", files=files)
    assert r.status_code == 409, f"Excel SPPD mengubah rekaman Sudah Transfer: {r.status_code} {r.text[:200]}"
    body = r.json()
    assert [x["record_id"] for x in body["locked"]] == ["TRF-1"], body
    assert body["locked"][0]["fields"][0]["field"] == "nilai_pembayaran", body
    assert raw() == before, "unggahan ditolak tetapi baris lain tersimpan"

    # Baris rekaman terkunci yang TIDAK mengubah apa pun bukan pelanggaran (berkas ekspor yang diunggah ulang).
    files = xlsx([{"Record ID": "OPEN-1", "Keterangan": "boleh"}, {"Record ID": "TRF-1", "Nilai Pembayaran": 1000}])
    r = client.post("/payments/sppd/upload", files=files)
    assert r.status_code == 200, r.text[:300]
    assert r.json()["updated"] == 1 and r.json()["unchanged"] == 1, r.json()
    assert ledger()["OPEN-1"]["keterangan"] == "boleh" and ledger()["TRF-1"]["nilai_pembayaran"] == 1000.0


def check_rename():
    seed()
    r = client.post("/api/bank-data/replace-principle-name", json={"old_name": "pt abc", "new_name": "PT ABC BARU"})
    assert r.status_code == 200, r.text[:200]
    body = r.json()
    assert body["replaced"] == 2 and body["locked_skipped"] == 3, body
    names = {k: v["principle"] for k, v in ledger().items()}
    assert names == {"OPEN-1": "PT ABC BARU", "FAIL-1": "PT ABC BARU", "TRF-1": "PT ABC", "PST-1": "PT ABC", "UNK-1": "PT ABC"}, names

    # Auto-fix memakai kunci yang sama: rekaman terkunci tidak di-rename.
    seed()
    pd.DataFrame([{"PRINCIPLE": "PT. ABC", "NAMA BANK": "PANIN", "NOMOR REKENING": "123", "NAMA PENERIMA": "ABC"}]).to_excel(
        os.environ["BANK_DATA_PATH"], index=False)
    preview = client.post("/api/bank-data/auto-fix-names", json={"confirm": False}).json()
    change = next((c for c in preview["changes"] if c["old"] == "PT ABC"), None)
    assert change and change["count"] == 2 and change["locked"] == 3, preview
    r = client.post("/api/bank-data/auto-fix-names", json={"confirm": True})
    assert r.status_code == 200 and r.json()["executed"], r.text[:200]
    names = {k: v["principle"] for k, v in ledger().items()}
    assert names["OPEN-1"] == "PT. ABC" and names["TRF-1"] == "PT ABC" and names["UNK-1"] == "PT ABC", names


def main_check():
    check_helper()
    check_update()
    check_delete_and_clear()
    check_sppd_excel()
    check_rename()
    print("OK test_payments_lock")


if __name__ == "__main__":
    main_check()
