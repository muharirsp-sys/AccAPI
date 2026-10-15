"""Tujuan: Basis data Web Sales yang TERPISAH dari basis data internal.
Caller: routers/websales (tulis permintaan order), routers/orders (pull ke internal).
Dependensi: SQLite stdlib. Main Functions: connect, create_request, pending, mark_pulled, mark_rejected.
Side Effects: SQLite WAL pada file lain dari store internal; tanpa tabel internal apa pun.

Pemisahan ini disengaja: aplikasi Web Sales tidak boleh menyentuh draft Summary,
aturan promo, maupun order internal. Karena dua basis data tidak bisa satu transaksi,
pull ke internal harus idempoten: internal menulis lebih dulu dengan `request_id`
unik, penandaan `pulled` menyusul, dan pull berikutnya aman diulang.

O1 putaran 1 (12 Okt 2026): permintaan menyimpan `sidik` pratinjau yang dilihat sales (bukan harga — angka uang tetap hanya di order
internal) supaya tarikan bisa membuktikan angka beku = angka pratinjau; permintaan yang DITOLAK PERMANEN saat tarik ditandai
`rejected` + kode + sebab (dulu tetap `pending` selamanya dan ikut dicoba ulang tiap tarikan).
"""
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

# Kolom yang ditambahkan sesudah tabel pertama dibuat: ALTER bila belum ada (pola sama dengan customer_no).
KOLOM_SUSULAN = {
    # Pelanggan Accurate ikut dari sisi sales: tanpa `customerNo` order tidak bisa
    # menjadi faktur (field wajib sales-invoice/save.do).
    "customer_no": "TEXT NOT NULL DEFAULT ''",
    "sidik": "TEXT NOT NULL DEFAULT ''",
    "reject_code": "TEXT NOT NULL DEFAULT ''",
    "reject_reason": "TEXT NOT NULL DEFAULT ''",
    "rejected_at": "TEXT",
}


@contextmanager
def connect():
    path = Path(os.environ.get("WEBSALES_STORE_PATH", str(Path(__file__).parent / "data" / "websales.sqlite3")))
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS order_request(
          id TEXT PRIMARY KEY, sales TEXT NOT NULL, outlet TEXT NOT NULL, channel TEXT NOT NULL,
          order_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', lines TEXT NOT NULL,
          customer_no TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending', pulled_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
        CREATE INDEX IF NOT EXISTS order_request_pending ON order_request(status,created_at,id);
        CREATE INDEX IF NOT EXISTS order_request_sales ON order_request(sales,created_at DESC,id);
        """)
        ada = {row[1] for row in db.execute("PRAGMA table_info(order_request)")}
        for kolom, tipe in KOLOM_SUSULAN.items():
            if kolom not in ada:
                db.execute(f"ALTER TABLE order_request ADD COLUMN {kolom} {tipe}")
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def create_request(sales, outlet, channel, order_date, note, lines, customer_no="", sidik=""):
    request_id = str(uuid.uuid4())
    with connect() as db:
        db.execute("INSERT INTO order_request(id,sales,outlet,channel,order_date,note,lines,customer_no,sidik)"
                   " VALUES(?,?,?,?,?,?,?,?,?)",
                   (request_id, sales, outlet[:160], channel[:80], order_date, note[:500],
                    json.dumps(lines, ensure_ascii=False), customer_no[:80], str(sidik)[:128]))
    return get_request(request_id, sales)


def get_request(request_id, sales=None):
    with connect() as db:
        query = ("SELECT id,sales,outlet,channel,order_date,note,lines,customer_no,status,pulled_at,created_at,"
                 "reject_code,reject_reason,rejected_at FROM order_request WHERE id=?")
        row = db.execute(query if sales is None else query + " AND sales=?",
                         (request_id,) if sales is None else (request_id, sales)).fetchone()
    if row is None:
        return None
    value = dict(row)
    value["lines"] = json.loads(value["lines"])
    return value


def pending(limit=200, setelah=None):
    """Permintaan yang belum ditarik, urut kedatangan; batch pull memakai daftar ini.

    `setelah` = (created_at, id) baris terakhir halaman sebelumnya (keyset): permintaan yang DITAHAN di depan antrean tidak menyumbat
    permintaan sesudahnya.
    """
    kunci, argumen = "", ()
    if setelah:
        kunci, argumen = " AND (created_at>? OR (created_at=? AND id>?))", (setelah[0], setelah[0], setelah[1])
    with connect() as db:
        rows = db.execute("SELECT id,sales,outlet,channel,order_date,note,lines,customer_no,sidik,created_at FROM order_request "
                          "WHERE status='pending'" + kunci + " ORDER BY created_at,id LIMIT ?",
                          (*argumen, max(1, min(limit, 500)))).fetchall()
    return [{**dict(row), "lines": json.loads(row["lines"])} for row in rows]


def pending_count():
    """Berapa permintaan yang masih menunggu; dipakai status koneksi, bukan untuk pull."""
    with connect() as db:
        return db.execute("SELECT count(*) FROM order_request WHERE status='pending'").fetchone()[0]


def mark_pulled(request_id):
    """Ditandai SETELAH order internal tersimpan; aman dijalankan ulang."""
    with connect() as db:
        db.execute("UPDATE order_request SET status='pulled',pulled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                   "WHERE id=? AND status='pending'", (request_id,))


def mark_rejected(request_id, kode, alasan):
    """Ditolak PERMANEN saat tarik (kode + sebab terlihat sales di daftar ordernya); tidak dicoba lagi. Hanya dari `pending`."""
    with connect() as db:
        db.execute("UPDATE order_request SET status='rejected',reject_code=?,reject_reason=?,"
                   "rejected_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='pending'",
                   (str(kode)[:60], str(alasan)[:500], request_id))
