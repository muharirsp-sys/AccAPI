"""Jaga dua invariant di routers/payments.py yang mudah rusak tanpa sengaja.

Latar: endpoint `async def` yang memanggil operasi blocking (pd.read_excel,
save_payments_db, write_invoice_excel) menyumbat event loop uvicorn — satu
proses, jadi SEMUA user lain menggantung sampai selesai. Gejala di lapangan:
halaman /payments "loading terus" di PC yang requestnya masuk saat tersumbat.

Konsekuensi dari perbaikannya: to_thread menambah titik `await`, sehingga
read-modify-write yang tadinya atomik-karena-kebetulan sekarang WAJIB dikunci.

Jalankan: python test_payments_event_loop.py
"""
import re
import sys
from pathlib import Path

SRC = Path(__file__).parent / "routers" / "payments.py"
BLOCKING = ("pd.read_excel", "save_payments_db", "load_payments_db", "write_invoice_excel", "shutil.copy2")


def scan():
    """Kembalikan (nama_fungsi, jenis, baris, teks) per baris beserta status lock."""
    out = []
    kind = name = None
    locked = False
    for lineno, line in enumerate(SRC.read_text(encoding="utf-8").split("\n"), 1):
        m = re.match(r"(async def|def) (\w+)", line)
        if m:
            kind, name, locked = m.group(1), m.group(2), False
        if "_PAYMENTS_DB_LOCK" in line and ("async with" in line or ".acquire()" in line):
            locked = True
        out.append((name, kind, locked, lineno, line))
    return out


def test_no_blocking_call_directly_in_async_endpoint():
    """Operasi blocking di dalam `async def` harus lewat asyncio.to_thread."""
    bad = [
        (lineno, name, line.strip())
        for name, kind, _lock, lineno, line in scan()
        if kind == "async def"
        and any(b + "(" in line for b in BLOCKING)
        and "to_thread" not in line
    ]
    assert not bad, "blocking call langsung di event loop:\n" + "\n".join(map(str, bad))


def test_every_save_is_under_the_db_lock():
    """save_payments_db harus dipanggil sambil memegang _PAYMENTS_DB_LOCK."""
    bad = [
        (lineno, name, line.strip())
        for name, kind, locked, lineno, line in scan()
        if "save_payments_db" in line
        and "to_thread, save_payments_db" in line  # hanya call site, bukan baris import
        and not locked
    ]
    assert not bad, "save tanpa lock (risiko lost update):\n" + "\n".join(map(str, bad))


def test_lock_is_never_acquired_twice_while_held():
    """asyncio.Lock tidak reentrant: acquire bersarang = deadlock permanen."""
    depth = {}
    for name, _kind, _locked, _lineno, line in scan():
        if "_PAYMENTS_DB_LOCK" in line and ("async with" in line or ".acquire()" in line):
            indent = len(line) - len(line.lstrip())
            prev = depth.get(name, [])
            # Bersarang jika ada acquire lain di fungsi sama pada indent LEBIH DANGKAL
            # yang blocknya masih membungkus baris ini.
            assert all(indent <= p for p in prev), f"{name}: acquire bersarang, deadlock"
            depth[name] = prev + [indent]


if __name__ == "__main__":
    failed = 0
    for fn in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        try:
            fn()
            print(f"ok   {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{'GAGAL' if failed else 'SEMUA LULUS'} ({failed} gagal)")
    sys.exit(1 if failed else 0)
