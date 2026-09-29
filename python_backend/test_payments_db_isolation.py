"""Tujuan: Self-check store payments.json (AM-012, hipotesis H03/H04).
Caller: `python test_payments_db_isolation.py` via run_checks.py. Dependensi: shared, routers.payments.
Main Functions: main; assert (1) mutasi pada hasil load tidak bocor ke load berikutnya tanpa save,
  (2) file rusak melempar dan tidak ditimpa, (3) nomor SPPD tetap berurutan & tersimpan setelah
  isolasi (dulu kenaikannya hanya bertahan karena objek cache dibagi).
Side Effects: file sementara di direktori temp saja.
"""
import asyncio
import io
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="payments-db-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["BANK_DATA_PATH"] = os.path.join(TMP, "rekening.xlsx")
os.environ["PAYMENTS_FILES_DIR"] = os.path.join(TMP, "files")
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

import pandas as pd  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import shared  # noqa: E402


def write_db(obj):
    with open(DB_PATH, "w", encoding="utf-8") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj))


def check_isolation():
    write_db({"lpb": {"A": {"principle": "X"}}})
    db = shared.load_payments_db()
    db["lpb"]["A"]["principle"] = "MUTATED"  # persis pola payments_update sebelum `return 400`
    assert shared.load_payments_db()["lpb"]["A"]["principle"] == "X", "mutasi tanpa save bocor ke load berikutnya"

    os.remove(DB_PATH)
    ghost = shared.load_payments_db()
    ghost["lpb"]["GHOST"] = {}
    assert shared.load_payments_db()["lpb"] == {}, "store kosong berbagi dict bersarang dengan template modul"


def check_corrupt_is_not_empty():
    broken = '{"lpb": {"A": '
    write_db(broken)
    try:
        shared.load_payments_db()
    except Exception:
        pass
    else:
        raise AssertionError("payments.json rusak dibaca sebagai ledger kosong (boleh ditulis balik)")
    assert open(DB_PATH, encoding="utf-8").read() == broken, "file rusak ikut berubah"

    write_db("[1, 2]")
    try:
        shared.load_payments_db()
    except Exception:
        pass
    else:
        raise AssertionError("payments.json bukan objek dibaca sebagai ledger kosong")


def lpb(no):
    return {"principle": "PT UJI", "tipe_pengajuan": "LPB", "no_lpb": no, "tgl_invoice": "2026-09-01",
            "jt_invoice": "2026-09-30", "invoice_no": f"INV-{no}", "nilai_invoice": 1000000}


def payments_client():
    """Router payments asli; hanya identitas/izin/CSRF/audit yang ditambal."""
    from routers import payments

    payments.get_current_user = lambda request: "betterauth|admin|uji@x.test"
    payments.user_has_permission = lambda user, module, action: True
    payments.validate_csrf_request = lambda request, token: True
    payments.append_audit_log = lambda *a, **k: None
    app = FastAPI()
    app.include_router(payments.router)
    return TestClient(app)


def check_sppd_sequence_survives_isolation():
    client = payments_client()
    buf = io.BytesIO()
    pd.DataFrame([{"PRINCIPLE": "PT UJI", "NAMA BANK": "PANIN", "NOMOR REKENING": "123", "NAMA PENERIMA": "PT UJI"}]).to_excel(buf, index=False)
    open(shared.BANK_DATA_PATH, "wb").write(buf.getvalue())
    write_db({"lpb": {"L1": lpb("L1"), "L2": lpb("L2")}, "sppd_settings": {"last_sequence": 10}})

    numbers = []
    for rid in ["L1", "L2"]:
        r = client.post("/payments/cart/create", json={"method": "BANK_PANIN", "record_ids": [rid], "target_payment_date": "2026-10-01"})
        assert r.status_code == 200, r.text[:300]
        r = client.post("/payments/cart/submit", json={"draft_id": r.json()["draft_id"],
                                                        "items": [{"group_key": "PT UJI||LPB", "jenis_pembayaran": "TRF", "potongan": 0}]})
        assert r.status_code == 200 and r.json().get("ok"), r.text[:300]
        numbers.append(shared.load_payments_db()["lpb"][rid]["sppd_no"])
    saved = shared.load_payments_db()
    assert saved["sppd_settings"]["last_sequence"] == 12, f"urutan SPPD tidak tersimpan: {saved['sppd_settings']}"
    assert numbers[0] != numbers[1] and numbers[0].startswith("011") and numbers[1].startswith("012"), numbers


def check_failed_batch_leaves_no_mutation():
    """Batch A valid lalu B invalid -> 400, dan A tidak boleh tersaji/tersimpan oleh request lain."""
    client = payments_client()
    write_db({"lpb": {"A": lpb("A"), "B": lpb("B")}})
    r = client.post("/payments/update", json={"items": [{"record_id": "A", "tgl_invoice": "2099-01-01"},
                                                         {"record_id": "B", "tipe_pengajuan": "NON_LPB"}]})
    assert r.status_code == 400, r.text[:200]
    assert shared.load_payments_db()["lpb"]["A"]["tgl_invoice"] == "2026-09-01", "mutasi A dari request gagal tersaji"
    # Penulis berikutnya (request lain yang sah) tidak boleh ikut mempersist mutasi A.
    r = client.post("/payments/update", json={"items": [{"record_id": "B", "jt_invoice": "2026-10-31"}]})
    assert r.status_code == 200, r.text[:200]
    assert json.load(open(DB_PATH, encoding="utf-8"))["lpb"]["A"]["tgl_invoice"] == "2026-09-01", "mutasi A ikut tersimpan"


def main():
    check_isolation()
    check_corrupt_is_not_empty()
    check_sppd_sequence_survives_isolation()
    check_failed_batch_leaves_no_mutation()
    print("OK test_payments_db_isolation")


if __name__ == "__main__":
    asyncio.set_event_loop(asyncio.new_event_loop())
    main()
