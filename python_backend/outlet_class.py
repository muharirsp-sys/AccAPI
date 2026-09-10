"""Tujuan: Keanggotaan kelas outlet principal (LOYALTY/HYBRID/CONTRACTUAL/MSG) untuk gerbang promo.
Caller: routers/orders.py saat menghitung order; import_outlet_class.py saat memuat daftar.
Dependensi: summary_store (SQLite). Main Functions: load, known, classes_of.
Side Effects: SQLite read/write pada tabel outlet_class dan registri summary_kv.

Kunci datanya adalah KODE OUTLET DASAR, bukan customerNo Accurate. Satu outlet fisik punya
satu customerNo per cabang principal (`C-GAL006-KN` untuk Kino, `C-GAL006-RB` untuk Reckitt),
sedangkan keanggotaan loyalty melekat pada tokonya, bukan pada cabangnya.
"""
from datetime import datetime, timezone

from summary_rules import OUTLET_CLASSES
from summary_store import JsonStore, connect

REGISTRY = JsonStore("outlet_class_loaded")


def base_code(customer_no):
    """`C-GAL006-KN` -> `C-GAL006`. Kode tanpa akhiran cabang dikembalikan apa adanya."""
    code = str(customer_no or "").strip().upper()
    head, sep, tail = code.rpartition("-")
    return head if sep and head.count("-") >= 1 else code


def loaded():
    try:
        state = REGISTRY["state"]
    except (KeyError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def known():
    """Kelas yang daftarnya SUDAH dimuat — termasuk yang dimuat kosong dengan sengaja.

    Kosong-karena-dinyatakan dan kosong-karena-belum-dimuat harus bisa dibedakan: yang
    pertama membuat program berjalan, yang kedua menahannya. Karena itu registrinya
    terpisah dari jumlah barisnya.
    """
    return tuple(sorted(loaded()))


def classes_of(customer_no):
    """Kelas outlet ini. Dicocokkan pada kode dasar maupun kode penuh, mana pun yang tersimpan."""
    code = str(customer_no or "").strip().upper()
    if not code:
        return ()
    with connect() as db:
        rows = db.execute("SELECT DISTINCT klass FROM outlet_class WHERE customer_no IN (?,?)",
                          (code, base_code(code))).fetchall()
    return tuple(sorted(row[0] for row in rows))


def load(klass, customer_nos, source):
    """Ganti seluruh daftar satu kelas. Daftar kosong = pernyataan tegas "tidak ada di sini".

    Mengganti, bukan menambah: daftar Kino terbit ulang tiap kuartal dan outlet yang keluar
    dari program harus benar-benar hilang, bukan menumpuk dari muatan sebelumnya.
    """
    klass = str(klass).strip().upper()
    if klass not in OUTLET_CLASSES:
        raise ValueError(f"Kelas outlet tidak dikenal: {klass}; pilihan: {', '.join(OUTLET_CLASSES)}")
    codes = sorted({base_code(code) for code in customer_nos if str(code).strip()})
    with connect() as db:
        db.execute("DELETE FROM outlet_class WHERE klass=?", (klass,))
        db.executemany("INSERT INTO outlet_class(customer_no,klass) VALUES(?,?)", [(code, klass) for code in codes])
    REGISTRY["state"] = {**loaded(), klass: {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                             "source": str(source)[:200], "count": len(codes)}}
    return codes
