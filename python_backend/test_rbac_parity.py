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
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


def _fake_get(url, headers=None, timeout=None):
    token = headers["cookie"].split("=", 1)[1].split(".")[0]
    reply = VERIFY[token]
    return _Resp(reply[1], reply[0]) if isinstance(reply, tuple) else _Resp(reply)


sys.modules["requests"] = types.SimpleNamespace(get=_fake_get)

import pandas as pd  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.requests import Request  # noqa: E402

import shared  # noqa: E402


def current(token):
    cookie = f"better-auth.session_token={token}.sig".encode()
    return shared.get_current_user(Request({"type": "http", "headers": [(b"cookie", cookie)]}))


def identity(token, **payload):
    VERIFY[token] = {"ok": True, "email": f"{token}@x.test", "name": token, **payload}
    return current(token)


def check_fail_closed():
    """Review F1/F5: tanpa profil efektif yang hidup, AUTH_VERIFY_URL aktif -> tolak, bukan legacy."""
    has = shared.user_has_permission
    admin = identity("adm2", role="admin", permissions="{}", effectivePermissions=["payments.view"])
    email = "adm2@x.test"
    shared._AUTH_VERIFY_PERMS[email] = (0.0, shared._AUTH_VERIFY_PERMS[email][1])  # izin kedaluwarsa, sesi masih hidup
    assert not has(admin, "payments", "edit"), "izin kedaluwarsa jatuh ke jalan pintas role admin"
    shared._AUTH_VERIFY_PERMS.pop(email)
    assert not has(admin, "finance", "approve"), "izin hilang jatuh ke jalan pintas role admin"

    odd = identity("odd", role="admin", permissions="{}", effectivePermissions="payments.edit")
    assert not has(odd, "payments", "edit"), "effectivePermissions bukan list diperlakukan legacy"

    # Verify 5xx (mis. DB Next sesaat gagal) tidak boleh di-cache 60 s sebagai 'sesi invalid'.
    VERIFY["blip"] = (503, {"ok": False})
    assert current("blip") is None
    VERIFY["blip"] = {"ok": True, "email": "blip@x.test", "name": "blip", "role": "viewer", "effectivePermissions": []}
    assert current("blip") is not None, "kegagalan sementara verify di-cache sebagai sesi invalid"


def check_registry_parity():
    """Setiap key yang dicek FastAPI harus terdaftar di registry Next & dikenali filter Python."""
    import re
    root = os.path.dirname(os.path.abspath(__file__))
    registry = open(os.path.join(root, "..", "lib", "rbac", "registry.ts"), encoding="utf-8").read()
    block = registry.split("PERMISSION_REGISTRY = {", 1)[1].split("} as const", 1)[0]
    block = re.sub(r"//[^\n]*", "", block)
    declared = {m: set(re.findall(r'"([a-z_]+)"', acts)) for m, acts in re.findall(r"([a-z_]+):\s*\[([^\]]*)\]", block)}
    used = set()
    for dirpath, _, files in os.walk(root):
        for name in files:
            if name.endswith(".py") and not name.startswith("test_"):
                text = open(os.path.join(dirpath, name), encoding="utf-8", errors="replace").read()
                used |= set(re.findall(r'user_has_permission\([^,]+,\s*"([a-z_]+)",\s*"([a-z_]+)"', text))
    assert len(used) > 10, used  # regex masih menemukan pemanggil
    missing = sorted(f"{m}.{a}" for m, a in used if a not in declared.get(m, set()))
    assert not missing, f"key FastAPI tidak ada di lib/rbac/registry.ts: {missing}"
    unknown = sorted(f"{m}.{a}" for m, a in used if m not in shared.PERMISSION_MODULES or a not in shared.PERMISSION_ACTIONS)
    assert not unknown, f"key FastAPI dibuang normalize_permissions: {unknown}"
    # Re-review 748b73aa LOW: SEMUA action registry dari modul yang dikenal Python harus lolos filter, bukan
    # hanya yang sudah dipanggil — key yang kelak dicek FastAPI tidak boleh ditolak diam-diam.
    dropped = sorted(f"{m}.{a}" for m in shared.PERMISSION_MODULES for a in declared.get(m, set()) if a not in shared.PERMISSION_ACTIONS)
    assert not dropped, f"action registry dibuang normalize_permissions: {dropped}"


def check_policy():
    has = shared.user_has_permission
    # Sesi 5 (owner): kapabilitas Finance terpisah lewat jalur izin efektif NYATA — retry_post lama dan kunci
    # kapabilitas lain tidak memberi resolve_unknown.
    fin = identity("fin5", role="finance", permissions="{}",
                   effectivePermissions=["finance.update", "finance.retry_post", "finance.override_duplicate", "finance.repost_payment"])
    assert not has(fin, "finance", "resolve_unknown"), "kunci finance lain memberi resolve_unknown"
    res = identity("res5", role="viewer", permissions="{}", effectivePermissions=["finance.resolve_unknown"])
    assert has(res, "finance", "resolve_unknown"), "finance.resolve_unknown dibuang filter Python"
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

    # Review F3: baca rekening seluruh principle butuh sppd.view (guard halaman SPPD di Next).
    r = client.get("/api/bank-data")
    assert r.status_code == 200, f"pemegang sppd.view ditolak: {r.status_code}"
    main.get_current_user = lambda request: identity("nosppd", role="viewer", permissions="{}", effectivePermissions=["websales.view"])
    for path in ["/api/bank-data", "/api/bank-data/match-report", "/api/bank-data/lookup?principle=X"]:
        r = client.get(path)
        assert r.status_code == 403, f"{path} tanpa sppd.view: {r.status_code} {r.text[:120]}"

    # Review F2: clear seluruh payments butuh key eksplisit, bukan sekadar role admin.
    from routers import payments
    payments.get_current_user = lambda request: identity("adm3", role="admin", permissions="{}", effectivePermissions=["payments.view"])
    r = client.post("/payments/clear", json={"confirm": "CLEAR PAYMENTS"})
    assert r.status_code == 403, f"role admin dengan group terbatas bisa clear payments: {r.status_code} {r.text[:120]}"

    # Kontrol positif: pemegang izin yang benar tetap bisa bekerja (guard bukan tolak-semua).
    main.get_current_user = lambda request: identity(
        "fin", role="viewer", permissions="{}", effectivePermissions=["sppd.edit_settings"])
    r = client.post("/api/bank-data/upload", files=files)
    assert r.status_code == 200, f"pemegang sppd.edit_settings ditolak: {r.status_code} {r.text[:200]}"
    assert open(shared.BANK_DATA_PATH, "rb").read() != b"ASLI"


def check_csrf_bank_data():
    """S6-0e butir 7: mutasi master rekening & nama principal butuh CSRF (dulu tanpa CSRF sama sekali)."""
    import main

    client = TestClient(main.app)
    main.get_current_user = lambda request: identity(
        "csrf", role="viewer", permissions="{}", effectivePermissions=["sppd.edit_settings", "payments.edit", "payments.view"])
    evil = {"Origin": "http://evil.invalid"}
    open(shared.BANK_DATA_PATH, "wb").write(b"ASLI")
    buf = io.BytesIO()
    pd.DataFrame([{"PRINCIPLE": "X", "NAMA BANK": "B", "NOMOR REKENING": "999", "NAMA PENERIMA": "Z"}]).to_excel(buf, index=False)
    files = {"file": ("r.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    r = client.post("/api/bank-data/upload", files=files, headers=evil)
    assert r.status_code == 403, f"upload rekening lintas origin tanpa CSRF: {r.status_code} {r.text[:200]}"
    assert open(shared.BANK_DATA_PATH, "rb").read() == b"ASLI", "file rekening tertimpa walau CSRF gagal"
    for path, body in [("/api/bank-data/replace-principle-name", {"old_name": "A", "new_name": "B"}),
                       ("/api/bank-data/auto-fix-names", {"confirm": True})]:
        r = client.post(path, json=body, headers=evil)
        assert r.status_code == 403 and "CSRF" in r.text, f"{path} lintas origin tanpa CSRF: {r.status_code} {r.text[:200]}"
    # Token sah (cookie = header) tetap lolos dari origin lain (halaman :3000 -> backend :8000).
    token = shared.make_csrf_token()
    client.cookies.set(shared.CSRF_COOKIE, token)
    r = client.post("/api/bank-data/replace-principle-name", json={"old_name": "A", "new_name": "B"}, headers={**evil, "X-CSRF-Token": token})
    assert r.status_code == 200, f"token CSRF sah ditolak: {r.status_code} {r.text[:200]}"
    client.cookies.clear()


def check_resolve_parity():
    """S6-0e butir 7: pemegang finance.resolve_unknown TANPA finance.update menuntaskan ledger pada jalur resolve
    (paritas dengan route Next /resolve) — tanpa hak update umum. Dulu: attempt server selesai, ledger 403 = terbelah."""
    import json
    import main
    from routers import finance

    client = TestClient(main.app)
    finance.get_current_user = lambda request: identity(
        "res7", role="viewer", permissions="{}", effectivePermissions=["finance.view", "finance.resolve_unknown"])
    base = {"principle": "PT ABC", "status_pembayaran": "Sudah Transfer", "transfer_date": "2026-10-09", "proof_id": "p1",
            "transfer_proof": {"proof_id": "p1"}}
    ledger = {"lpb": {"UNK": {**base, "no_lpb": "UNK", "accurate_post_status": "unknown", "accurate_post_error": "timeout"},
                      "OK": {**base, "no_lpb": "OK", "accurate_post_status": "failed", "accurate_post_error": "Vendor tidak ditemukan"}},
              "proofs": {"p1": {"proof_id": "p1"}, "p2": {"proof_id": "p2"}}}
    with open(shared.PAYMENTS_DB_PATH, "w", encoding="utf-8") as f:
        json.dump(ledger, f)
    before = open(shared.PAYMENTS_DB_PATH, encoding="utf-8").read()
    note = "dicek manual di Accurate: PP/1009/3 ada"

    def upd(**item):
        return client.post("/payments/finance/update", json={"items": [item]})

    # Bukan penyelesaian -> 403 tanpa tulis (hak update umum tidak ikut).
    for bad in [dict(no_lpb="UNK", status_pembayaran="Belum Transfer"),
                dict(no_lpb="OK", status_pembayaran="Sudah Transfer", accurate_post_status="posted", resolution_note=note),
                dict(no_lpb="UNK", status_pembayaran="Sudah Transfer", accurate_post_status="posted", resolution_note="pendek")]:
        r = upd(**bad)
        assert r.status_code == 403, f"resolve-only melakukan update umum: {bad} -> {r.status_code} {r.text[:200]}"
    assert open(shared.PAYMENTS_DB_PATH, encoding="utf-8").read() == before
    # Penyelesaian sah: posted + nomor + catatan; tanggal/bukti transfer dari permintaan TIDAK dipakai.
    r = upd(no_lpb="UNK", status_pembayaran="Sudah Transfer", transfer_date="2030-01-01", proof_id="p2",
            accurate_post_status="posted", accurate_purchase_payment_number="PP/1009/3", resolution_note=note)
    assert r.status_code == 200, f"pemegang resolve_unknown ditolak menuntaskan ledger: {r.status_code} {r.text[:200]}"
    rec = shared.load_payments_db()["lpb"]["UNK"]
    assert rec["accurate_post_status"] == "posted" and rec["accurate_post_resolution"]["source"] == "manual_attestation", rec
    assert rec["transfer_date"] == "2026-10-09" and rec["proof_id"] == "p1", f"resolve-only mengubah data transfer: {rec}"
    # Tanpa keduanya tetap 403.
    finance.get_current_user = lambda request: identity("nores", role="viewer", permissions="{}", effectivePermissions=["finance.view"])
    assert upd(no_lpb="UNK", status_pembayaran="Belum Transfer").status_code == 403


def main_check():
    check_policy()
    check_fail_closed()
    check_registry_parity()
    check_mutation_routes()
    check_csrf_bank_data()
    check_resolve_parity()
    print("OK test_rbac_parity")


if __name__ == "__main__":
    main_check()
