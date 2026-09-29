"""Tujuan: Self-check paritas izin FastAPI dengan Next (AM-010, hipotesis H01/H02).
Caller: `python test_rbac_parity.py` via run_checks.py. Dependensi: shared, main (TestClient).
Main Functions: main; assert izin efektif dari /api/auth/verify otoritatif (group Next menang atas
  role legacy & jalan pintas admin), serta endpoint mutasi menolak izin view-saja tanpa efek.
Side Effects: file sementara di direktori temp; `requests.get` ditambal — tidak ada jaringan.
"""
import io
import os
import sys
import tempfile
import types

TMP = tempfile.mkdtemp(prefix="rbac-parity-")
os.environ["BETTER_AUTH_DB_PATH"] = os.path.join(TMP, "absent.db")
os.environ["BANK_DATA_PATH"] = os.path.join(TMP, "rekening.xlsx")
# Semua jejak tulis diarahkan ke temp: bila guard mundur, uji ini gagal TANPA mengotori data/.
os.environ["AUDIT_LOG_PATH"] = os.path.join(TMP, "audit.jsonl")
os.environ["ERROR_LOG_PATH"] = os.path.join(TMP, "error.jsonl")
os.environ["PAYMENTS_DB_PATH"] = os.path.join(TMP, "payments.json")
os.environ["AUTH_VERIFY_URL"] = "http://verify.invalid/api/auth/verify"

VERIFY = {}  # token -> payload /api/auth/verify palsu


class _Resp:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def _fake_get(url, headers=None, timeout=None):
    token = headers["cookie"].split("=", 1)[1].split(".")[0]
    return _Resp(VERIFY[token])


sys.modules["requests"] = types.SimpleNamespace(get=_fake_get)

import pandas as pd  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.requests import Request  # noqa: E402

import shared  # noqa: E402


def identity(token, **payload):
    VERIFY[token] = {"ok": True, "email": f"{token}@x.test", "name": token, **payload}
    cookie = f"better-auth.session_token={token}.sig".encode()
    return shared.get_current_user(Request({"type": "http", "headers": [(b"cookie", cookie)]}))


def check_policy():
    has = shared.user_has_permission
    # User ber-group "Salesman": role legacy tak dikenal -> dulu jatuh ke preset viewer yang
    # memuat payments/finance.view. Izin efektif Next tidak memuatnya -> wajib ditolak.
    sales = identity("sls", role="salesman", permissions="{}", effectivePermissions=["websales.view", "websales.create"])
    assert not has(sales, "payments", "view"), "group tanpa payments tetap dapat payments.view"
    assert not has(sales, "finance", "view"), "group tanpa finance tetap dapat finance.view"
    assert has(sales, "websales", "create")

    # Role admin yang group-nya dibatasi admin lain: group otoritatif, jalan pintas admin tidak.
    admin = identity("adm", role="admin", permissions="{}", effectivePermissions=["payments.view"])
    assert has(admin, "payments", "view")
    assert not has(admin, "payments", "edit"), "jalan pintas role admin mengabaikan group"

    # Modul yang ada di registry Next harus dikenali FastAPI (dulu master_barang dibuang diam-diam).
    staff = identity("stf", role="staff", permissions="{}", effectivePermissions=["master_barang.upload"])
    assert has(staff, "master_barang", "upload")

    # Group ada tapi kosong: tidak ada izin sama sekali.
    empty = identity("emp", role="viewer", permissions="{}", effectivePermissions=[])
    assert not has(empty, "payments", "view")

    # Kompatibilitas: Next lama tanpa effectivePermissions -> perilaku legacy dipertahankan.
    legacy = identity("old", role="viewer", permissions="{}")
    assert has(legacy, "payments", "view")


def check_mutation_routes():
    import main

    main.MASTERS_DIR = os.path.join(TMP, "masters")
    shared.PRINCIPLES_DB_PATH = os.path.join(TMP, "principles.sqlite3")
    client = TestClient(main.app)
    main.get_current_user = lambda request: identity(
        "vw", role="viewer", permissions="{}", effectivePermissions=["payments.view", "sppd.view", "principles.view"])
    open(shared.BANK_DATA_PATH, "wb").write(b"ASLI")

    buf = io.BytesIO()
    pd.DataFrame([{"PRINCIPLE": "X", "NAMA BANK": "B", "NOMOR REKENING": "999", "NAMA PENERIMA": "Z"}]).to_excel(buf, index=False)
    files = {"file": ("r.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    r = client.post("/api/bank-data/upload", files=files)
    assert r.status_code == 403, f"upload rekening dengan izin view: {r.status_code} {r.text[:200]}"
    assert open(shared.BANK_DATA_PATH, "rb").read() == b"ASLI", "file rekening tertimpa walau ditolak"

    for path, body in [("/api/bank-data/replace-principle-name", {"old_name": "A", "new_name": "B"}),
                       ("/api/bank-data/auto-fix-names", {"confirm": True})]:
        r = client.post(path, json=body)
        assert r.status_code == 403, f"{path} dengan izin view: {r.status_code} {r.text[:200]}"
    # Preview auto-fix tidak mengubah apa pun -> izin view tetap cukup (fitur tidak hilang).
    r = client.post("/api/bank-data/auto-fix-names", json={"confirm": False})
    assert r.status_code == 200 and r.json()["executed"] is False, r.text[:200]

    r = client.post("/api/principles/add", data={"name": "UJI"}, files={"file": ("m.xlsx", b"x", "application/octet-stream")})
    assert r.status_code == 403, f"principles/add dengan izin view: {r.status_code} {r.text[:200]}"
    r = client.post("/api/principles/uji/delete")
    assert r.status_code == 403, f"principles/delete dengan izin view: {r.status_code} {r.text[:200]}"

    # Kontrol positif: pemegang izin yang benar tetap bisa bekerja (guard bukan tolak-semua).
    main.get_current_user = lambda request: identity(
        "fin", role="viewer", permissions="{}", effectivePermissions=["sppd.edit_settings"])
    r = client.post("/api/bank-data/upload", files=files)
    assert r.status_code == 200, f"pemegang sppd.edit_settings ditolak: {r.status_code} {r.text[:200]}"
    assert open(shared.BANK_DATA_PATH, "rb").read() != b"ASLI"


def main_check():
    check_policy()
    check_mutation_routes()
    print("OK test_rbac_parity")


if __name__ == "__main__":
    main_check()
