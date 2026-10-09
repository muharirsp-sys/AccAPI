"""Tujuan: Self-check urutan nomor SPPD (AM-019 H08 + keputusan owner D-05/C10, 8 Okt 2026).
Caller: `python test_sppd_settings_sequence.py` via run_checks.py. Dependensi: routers.sppd, shared.
Main Functions: main; assert (1) halaman basi / gagal-muat tidak bisa mengubah last_sequence, (2) nomor urut
  terakhir TIDAK PERNAH turun di dalam satu tahun — lewat setelan (409) maupun restore backup, (3) tahun baru
  (tanggal terbit WITA) otomatis mulai 001, (4) field lain tak terganggu.
Side Effects: file sementara di direktori temp saja.
"""
import json
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="sppd-seq-")
DB_PATH = os.path.join(TMP, "payments.json")
os.environ["PAYMENTS_DB_PATH"] = DB_PATH
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import shared  # noqa: E402
from routers import sppd  # noqa: E402

pd = shared.pd
sppd.get_current_user = lambda request: "betterauth|admin|adm@x.test"
sppd.user_has_permission = lambda user, module, action: True
sppd.validate_csrf_request = lambda request, token: True
app = FastAPI()
app.include_router(sppd.router)
client = TestClient(app)
TPL = "{seq:03d}/SPA/PDSB/{roman_month}/{year}"


def seq():
    return shared.load_payments_db()["sppd_settings"]["last_sequence"]


def write_db(data):
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f)


def settings_route():
    # Data lama tanpa sequence_year = dianggap tahun berjalan (urutan diteruskan, tidak turun).
    write_db({"sppd_settings": {"last_sequence": 12}})

    # Halaman yang GET-nya gagal mengirim default last_sequence 0 (tanpa versi): dulu tersimpan.
    r = client.post("/payments/sppd/settings", json={"last_sequence": 0, "number_template": TPL})
    assert r.status_code == 409, f"last_sequence tanpa versi diterima: {r.status_code} {r.text[:160]}"
    assert seq() == 12

    # Halaman basi (dimuat saat 10, sementara submit BANK_PANIN sudah memakai 11 dan 12).
    r = client.post("/payments/sppd/settings", json={"last_sequence": 10, "expected_last_sequence": 10})
    assert r.status_code == 409, f"halaman basi memundurkan urutan: {r.status_code} {r.text[:160]}"
    assert seq() == 12

    # D-05: menurunkan DENGAN versi cocok pun ditolak 409 (dulu 200 "reset = keputusan bisnis").
    r = client.post("/payments/sppd/settings", json={"last_sequence": 11, "expected_last_sequence": 12})
    assert r.status_code == 409, f"penurunan nomor SPPD diterima: {r.status_code} {r.text[:160]}"
    assert "turun" in r.json().get("error", ""), r.text[:200]
    assert seq() == 12

    # Menaikkan dengan versi cocok tetap boleh.
    r = client.post("/payments/sppd/settings", json={"last_sequence": 15, "expected_last_sequence": 12})
    assert r.status_code == 200, r.text[:200]
    assert seq() == 15

    # Field lain tanpa menyentuh urutan tidak butuh versi.
    r = client.post("/payments/sppd/settings", json={"maturity_months": 7})
    assert r.status_code == 200, r.text[:200]
    assert seq() == 15 and shared.load_payments_db()["sppd_settings"]["maturity_months"] == 7

    # Halaman lama selalu mengirim last_sequence apa adanya + sequence_year dari GET: tidak mengubah apa pun,
    # dan tahun urutan TIDAK bisa diatur klien (dikelola sistem).
    r = client.post("/payments/sppd/settings", json={"last_sequence": 15, "expected_last_sequence": 15,
                                                     "sequence_year": 1999, "maturity_months": 8})
    assert r.status_code == 200, r.text[:200]
    st = shared.load_payments_db()["sppd_settings"]
    assert st["last_sequence"] == 15 and st.get("sequence_year") != 1999 and st["maturity_months"] == 8, st


def settings_route_new_year():
    # Urutan tersimpan milik 2026; sekarang (WITA) sudah 2027 dan belum ada SPPD terbit tahun ini.
    write_db({"sppd_settings": {"last_sequence": 45, "sequence_year": 2026}})
    asli = sppd.wita_now
    sppd.wita_now = lambda: pd.Timestamp("2027-01-03 09:00")
    try:
        g = client.get("/payments/sppd/settings?date=2027-01-03")
        assert g.status_code == 200 and g.json()["next_sequence"] == 1, g.text[:200]
        assert g.json()["preview_number"] == "001/SPA/PDSB/I/2027", g.text[:200]
        # Pratinjau halaman (last_sequence + 1 = 046) salah di Januari -> server mengirim urutan efektif tahun itu.
        assert g.json()["effective_last_sequence"] == 0, g.text[:200]
        # Di tahun baru urutan efektif 0: mengisi 3 (mis. tiga SPPD manual) = naik, bukan turun.
        r = client.post("/payments/sppd/settings", json={"last_sequence": 3, "expected_last_sequence": 45})
        assert r.status_code == 200 and r.json()["effective_last_sequence"] == 3, r.text[:200]
        st = shared.load_payments_db()["sppd_settings"]
        assert st["last_sequence"] == 3 and st["sequence_year"] == 2027, st
        r = client.post("/payments/sppd/settings", json={"last_sequence": 2, "expected_last_sequence": 3})
        assert r.status_code == 409 and seq() == 3, f"turun di dalam 2027 diterima: {r.status_code}"
    finally:
        sppd.wita_now = asli


def yearly_numbering():
    db = {"sppd_settings": {"last_sequence": 45, "sequence_year": 2026}}
    n, no, _ = shared.next_sppd_number(db, pd.Timestamp("2026-12-31 23:50"))
    assert (n, no) == (46, "046/SPA/PDSB/XII/2026"), (n, no)
    n, no, _ = shared.next_sppd_number(db, pd.Timestamp("2027-01-01 00:05"))
    assert (n, no) == (1, "001/SPA/PDSB/I/2027"), f"tahun baru tidak mulai 001: {(n, no)}"
    n, no, _ = shared.next_sppd_number(db, pd.Timestamp("2027-02-10 10:00"))
    assert (n, no) == (2, "002/SPA/PDSB/II/2027"), (n, no)
    assert db["sppd_settings"]["sequence_year"] == 2027
    # Data lama tanpa tahun DAN tanpa nomor terbit: diteruskan (tidak turun, tidak mulai ulang diam-diam).
    legacy = {"sppd_settings": {"last_sequence": 30}}
    n, no, _ = shared.next_sppd_number(legacy, pd.Timestamp("2026-10-09 08:00"))
    assert (n, no) == (31, "031/SPA/PDSB/X/2026") and legacy["sppd_settings"]["sequence_year"] == 2026, (n, no)
    # Review S6-0a: data lama tanpa sequence_year yang nomor pertamanya terbit SETELAH 1 Jan 2027 -> tahun urutan
    # diturunkan dari nomor tertinggi yang sudah terbit (lpb + submissions): mulai 001, bukan 046.
    def legacy_db():
        return {"sppd_settings": {"last_sequence": 45},
                "lpb": {"a": {"sppd_no": "045/SPA/PDSB/XII/2026"}, "b": {"sppd_no": ""}},
                "submissions": {"s": {"sppd_no": "044/SPA/PDSB/XII/2026"}, "t": {"sppd_no": "009/SPA/PDSB/III/2025"}}}
    db2 = legacy_db()
    n, no, _ = shared.next_sppd_number(db2, pd.Timestamp("2027-01-04 09:00"))
    assert (n, no) == (1, "001/SPA/PDSB/I/2027"), f"data lama di tahun baru tidak mulai 001: {(n, no)}"
    db3 = legacy_db()
    n, no, _ = shared.next_sppd_number(db3, pd.Timestamp("2026-12-20 09:00"))
    assert (n, no) == (46, "046/SPA/PDSB/XII/2026"), (n, no)
    db4 = legacy_db()
    db4["submissions"]["u"] = {"sppd_no": "001/SPA/PDSB/I/2027"}  # tahun terbit terbaru menang
    assert shared.get_sppd_settings(db4)["sequence_year"] == 2027
    # Tinjauan: nomor tak standar ("045/SPA/0123") bukan tahun 123 — di luar 2000–9999 diabaikan (klem sama dengan
    # normalize_sppd_settings), jadi tidak memicu reset 001 di tengah tahun.
    odd = {"sppd_settings": {"last_sequence": 45}, "lpb": {"a": {"sppd_no": "045/SPA/0123"}}}
    n, no, _ = shared.next_sppd_number(odd, pd.Timestamp("2026-10-09 08:00"))
    assert (n, no) == (46, "046/SPA/PDSB/X/2026"), f"nomor tak standar memicu reset: {(n, no)}"
    odd2 = {"sppd_settings": {"last_sequence": 45}, "lpb": {"a": {"sppd_no": "045/SPA/0123"}, "b": {"sppd_no": "044/SPA/PDSB/IX/2026"}}}
    assert shared.get_sppd_settings(odd2)["sequence_year"] == 2026

    # Tanggal terbit = WITA (UTC+8), bukan jam server (produksi berjalan UTC): 00:30 WITA 1 Jan = 16:30 UTC 31 Des.
    utc = pd.Timestamp.now(tz="UTC").tz_localize(None)
    delta = (shared.wita_now() - utc).total_seconds()
    assert abs(delta - 8 * 3600) < 60, f"wita_now bukan UTC+8: selisih {delta} detik"


def restore_backup_sequence():
    db = {"sppd_settings": {"last_sequence": 5, "sequence_year": 2026}}
    now = pd.Timestamp("2026-10-09 10:00")
    shared.raise_sppd_sequence_from_records(db, [{"sppd_no": "010/SPA/PDSB/X/2026"}, {"sppd_no": "099/SPA/PDSB/XII/2025"}], now)
    assert db["sppd_settings"]["last_sequence"] == 10, f"restore tidak menaikkan urutan: {db['sppd_settings']}"
    # Restore TIDAK PERNAH menurunkan urutan.
    shared.raise_sppd_sequence_from_records(db, [{"sppd_no": "003/SPA/PDSB/X/2026"}], now)
    assert db["sppd_settings"]["last_sequence"] == 10, db["sppd_settings"]
    # Tahun baru: nomor 2027 yang dipulihkan menjadi dasar urutan 2027 (nomor berikutnya 003, bukan 001 ganda).
    later = pd.Timestamp("2027-01-04 10:00")
    shared.raise_sppd_sequence_from_records(db, [{"sppd_no": "002/SPA/PDSB/I/2027"}, {"sppd_no": "050/SPA/PDSB/XII/2026"}], later)
    assert (db["sppd_settings"]["last_sequence"], db["sppd_settings"]["sequence_year"]) == (2, 2027), db["sppd_settings"]
    n, no, _ = shared.next_sppd_number(db, later)
    assert (n, no) == (3, "003/SPA/PDSB/I/2027"), (n, no)
    # Nomor tak standar tanpa tahun yang sah ("050/SPA/0123") dihitung seperti nomor tanpa tahun (fail-closed: naik).
    shared.raise_sppd_sequence_from_records(db, [{"sppd_no": "050/SPA/0123"}], later)
    assert db["sppd_settings"]["last_sequence"] == 50, db["sppd_settings"]


def main():
    settings_route()
    settings_route_new_year()
    yearly_numbering()
    restore_backup_sequence()
    print("OK test_sppd_settings_sequence")


if __name__ == "__main__":
    main()
