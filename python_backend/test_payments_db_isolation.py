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


def check_stale_draft_cannot_resubmit():
    """AM-013 (H12-A): dua draft untuk LPB yang sama; setelah draft 1 diajukan, draft 2 ditolak."""
    client = payments_client()
    write_db({"lpb": {"L9": lpb("L9")}})
    drafts = []
    for _ in range(2):
        r = client.post("/payments/cart/create", json={"method": "NON_PANIN", "record_ids": ["L9"], "target_payment_date": "2026-10-01"})
        assert r.status_code == 200, r.text[:300]
        drafts.append(r.json()["draft_id"])
    items = [{"group_key": "PT UJI||LPB", "jenis_pembayaran": "TRF", "potongan": 0}]
    r = client.post("/payments/cart/submit", json={"draft_id": drafts[0], "items": items})
    assert r.status_code == 200 and r.json().get("ok"), r.text[:300]
    first = shared.load_payments_db()["lpb"]["L9"]
    r = client.post("/payments/cart/submit", json={"draft_id": drafts[1], "items": items})
    assert r.status_code == 409 and r.json().get("ok") is False, f"draft basi mengajukan LPB lagi: {r.status_code} {r.text[:200]}"
    after = shared.load_payments_db()
    assert after["lpb"]["L9"] == first, "record berubah oleh pengajuan yang ditolak"
    assert len(after["submissions"]) == 1, after["submissions"].keys()


def check_concurrent_submit_single_winner():
    """AM-013: dua submit BERSAMAAN atas LPB sama. Barrier di antara dua bagian lock memaksa
    keduanya lolos cek pertama dulu; cek ulang di dalam write lock harus menolak satu."""
    import threading

    import httpx
    from routers import payments

    client = payments_client()
    write_db({"lpb": {"C1": lpb("C1")}})
    drafts = [client.post("/payments/cart/create", json={"method": "NON_PANIN", "record_ids": ["C1"],
                                                         "target_payment_date": "2026-10-01"}).json()["draft_id"] for _ in range(2)]
    barrier = threading.Barrier(2, timeout=20)
    original = payments.write_invoice_excel
    payments.write_invoice_excel = lambda rows, path: barrier.wait()  # dijalankan via to_thread di antara dua lock
    app = FastAPI()
    app.include_router(payments.router)
    items = [{"group_key": "PT UJI||LPB", "jenis_pembayaran": "TRF", "potongan": 0}]

    async def both():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await asyncio.gather(*(c.post("/payments/cart/submit", json={"draft_id": d, "items": items}) for d in drafts))

    try:
        results = asyncio.run(both())
    finally:
        payments.write_invoice_excel = original
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 409], f"dua submit bersamaan: {codes} {[r.text[:120] for r in results]}"
    assert len(shared.load_payments_db()["submissions"]) == 1


def check_concurrent_writer_not_lost():
    """Review AM-012 #1: penulis lain (mapping finance) yang mendarat saat submit BANK_PANIN sedang
    me-render SPPD di dalam lock tidak boleh hilang ditimpa save submit (salinan per request)."""
    import time

    import httpx
    from routers import finance, payments

    payments_client()  # tambal identitas/izin router payments
    # asyncio.Lock terikat ke loop tempat ia pertama diperebutkan; tiap asyncio.run = loop baru
    # (produksi: satu loop). SATU objek lock baru untuk kedua router supaya tetap saling mengunci.
    payments._PAYMENTS_DB_LOCK = finance._PAYMENTS_DB_LOCK = asyncio.Lock()
    finance.get_current_user = lambda request: "betterauth|admin|uji@x.test"
    finance.user_has_permission = lambda user, module, action: True
    finance.validate_csrf_request = lambda request, token: True
    finance.append_audit_log = lambda *a, **k: None
    buf = io.BytesIO()
    pd.DataFrame([{"PRINCIPLE": "PT UJI", "NAMA BANK": "PANIN", "NOMOR REKENING": "123", "NAMA PENERIMA": "PT UJI"}]).to_excel(buf, index=False)
    open(shared.BANK_DATA_PATH, "wb").write(buf.getvalue())
    write_db({"lpb": {"R1": lpb("R1")}, "sppd_settings": {"last_sequence": 1}})
    app = FastAPI()
    app.include_router(payments.router)
    app.include_router(finance.router)
    draft = TestClient(app).post("/payments/cart/create", json={"method": "BANK_PANIN", "record_ids": ["R1"],
                                                                 "target_payment_date": "2026-10-01"}).json()["draft_id"]
    original = payments.render_sppd_docx
    payments.render_sppd_docx = lambda *a, **k: time.sleep(0.6)  # render lambat, dijalankan via to_thread di dalam lock

    async def both():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            async def mapping():
                await asyncio.sleep(0.2)
                return await c.post("/payments/finance/mapping", json={"principle": "PT UJI", "vendorNo": "V-9", "bankNo": "B-9"})
            return await asyncio.gather(
                c.post("/payments/cart/submit", json={"draft_id": draft, "items": [{"group_key": "PT UJI||LPB", "jenis_pembayaran": "TRF", "potongan": 0}]}),
                mapping())

    try:
        submit, mapped = asyncio.run(both())
    finally:
        payments.render_sppd_docx = original
    assert submit.status_code == 200 and mapped.status_code == 200, (submit.text[:120], mapped.text[:120])
    saved = json.load(open(DB_PATH, encoding="utf-8"))
    assert saved.get("finance_mappings"), "mapping finance hilang ditimpa save cart submit (lost update)"
    assert len(saved["submissions"]) == 1


def check_invalid_money_is_not_zero():
    """AM-044 (H07): angka uang nonempty invalid dari pengguna/berkas -> 400/galat baris, ledger utuh."""
    client = payments_client()
    write_db({"lpb": {"A": lpb("A")}})
    before = open(DB_PATH, encoding="utf-8").read()
    r = client.post("/payments/update", json={"items": [{"record_id": "A", "nilai_invoice": "abc"}]})
    assert r.status_code == 400 and "Nilai Invoice" in r.text, f"nilai_invoice 'abc' diterima: {r.status_code} {r.text[:200]}"
    r = client.post("/payments/manual/add", json={"tipe_pengajuan": "LPB", "no_lpb": "M1", "principle": "PT UJI", "nilai_invoice": "12abc"})
    assert r.status_code == 400, f"manual add '12abc' diterima: {r.status_code} {r.text[:200]}"
    draft = client.post("/payments/cart/create", json={"method": "NON_PANIN", "record_ids": ["A"], "target_payment_date": "2026-10-01"}).json()["draft_id"]
    before_submit = shared.load_payments_db()
    r = client.post("/payments/cart/submit", json={"draft_id": draft,
                                                    "items": [{"group_key": "PT UJI||LPB", "jenis_pembayaran": "TRF", "potongan": "abc"}]})
    assert r.status_code == 400 and "Potongan" in r.text, f"potongan 'abc' jadi 0: {r.status_code} {r.text[:200]}"
    assert shared.load_payments_db()["lpb"] == before_submit["lpb"], "record berubah oleh submit yang ditolak"
    assert json.loads(before)["lpb"]["A"]["nilai_invoice"] == shared.load_payments_db()["lpb"]["A"]["nilai_invoice"]
    # Sah tetap jalan: nol dan format rupiah.
    r = client.post("/payments/update", json={"items": [{"record_id": "A", "nilai_invoice": "Rp 1.250.000,-"}]})
    assert r.status_code == 200 and shared.load_payments_db()["lpb"]["A"]["nilai_invoice"] == 1250000.0, r.text[:200]

    # Import LPB & restore: seluruh upload dibatalkan dengan nomor baris + nilai mentah.
    buf = io.BytesIO()
    pd.DataFrame([
        {"TGL. SETOR": "01/09/2026", "NO. LPB": "X1", "TGL. WIN": "01/09/2026", "TGL. J. TEMPO WIN": "30/09/2026",
         "PRINCIPLE": "PT UJI", "NILAI WIN": "1.000.000", "TGL TERIMA BARANG": "01/09/2026"},
        {"TGL. SETOR": "01/09/2026", "NO. LPB": "X2", "TGL. WIN": "01/09/2026", "TGL. J. TEMPO WIN": "30/09/2026",
         "PRINCIPLE": "PT UJI", "NILAI WIN": "NOT-A-NUMBER", "TGL TERIMA BARANG": "01/09/2026"},
    ]).to_excel(buf, index=False)
    try:
        shared.parse_lpb_upload(buf.getvalue())
    except ValueError as e:
        assert "baris 3" in str(e) and "NOT-A-NUMBER" in str(e), e
    else:
        raise AssertionError("import LPB menerima NILAI WIN 'NOT-A-NUMBER' (dulu 0)")


def main():
    check_invalid_money_is_not_zero()
    check_isolation()
    check_corrupt_is_not_empty()
    check_sppd_sequence_survives_isolation()
    check_failed_batch_leaves_no_mutation()
    check_stale_draft_cannot_resubmit()
    check_concurrent_submit_single_winner()
    check_concurrent_writer_not_lost()
    print("OK test_payments_db_isolation")


if __name__ == "__main__":
    asyncio.set_event_loop(asyncio.new_event_loop())
    main()
