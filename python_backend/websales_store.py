"""Tujuan: Basis data Web Sales yang TERPISAH dari basis data internal.
Caller: routers/websales (tulis permintaan order), routers/orders (pull ke internal).
Dependensi: SQLite stdlib. Main Functions: connect, create_request, pending, mark_pulled.
Side Effects: SQLite WAL pada file lain dari store internal; tanpa tabel internal apa pun.

Pemisahan ini disengaja: aplikasi Web Sales tidak boleh menyentuh draft Summary,
aturan promo, maupun order internal. Karena dua basis data tidak bisa satu transaksi,
pull ke internal harus idempoten: internal menulis lebih dulu dengan `request_id`
unik, penandaan `pulled` menyusul, dan pull berikutnya aman diulang.
"""
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path


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
          status TEXT NOT NULL DEFAULT 'pending', pulled_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
        CREATE INDEX IF NOT EXISTS order_request_pending ON order_request(status,created_at,id);
        CREATE INDEX IF NOT EXISTS order_request_sales ON order_request(sales,created_at DESC,id);
        """)
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def create_request(sales, outlet, channel, order_date, note, lines):
    request_id = str(uuid.uuid4())
    with connect() as db:
        db.execute("INSERT INTO order_request(id,sales,outlet,channel,order_date,note,lines) VALUES(?,?,?,?,?,?,?)",
                   (request_id, sales, outlet[:160], channel[:80], order_date, note[:500],
                    json.dumps(lines, ensure_ascii=False)))
    return get_request(request_id, sales)


def get_request(request_id, sales=None):
    with connect() as db:
        query = "SELECT id,sales,outlet,channel,order_date,note,lines,status,pulled_at,created_at FROM order_request WHERE id=?"
        row = db.execute(query if sales is None else query + " AND sales=?",
                         (request_id,) if sales is None else (request_id, sales)).fetchone()
    if row is None:
        return None
    value = dict(row)
    value["lines"] = json.loads(value["lines"])
    return value


def pending(limit=200):
    """Permintaan yang belum ditarik, urut kedatangan; batch pull memakai daftar ini."""
    with connect() as db:
        rows = db.execute("SELECT id,sales,outlet,channel,order_date,note,lines FROM order_request "
                          "WHERE status='pending' ORDER BY created_at,id LIMIT ?", (max(1, min(limit, 500)),)).fetchall()
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
