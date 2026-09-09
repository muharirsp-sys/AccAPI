"""Tujuan: Penyimpanan Summary atomik lintas proses pada volume runtime lokal.
Caller: shared, router Summary/library. Dependensi: SQLite stdlib, filesystem.
Main Functions: connect (skema draft + order), JsonStore, identity, owned, create_draft, get_draft.
Side Effects: SQLite WAL read/write; transaksi singkat, tanpa HTTP dalam lock.
"""
import json
import os
import sqlite3
import uuid
from collections.abc import MutableMapping
from contextlib import contextmanager
from pathlib import Path


def identity(user):
    return str(user or "").split("|", 2)[-1].strip().lower()


def owned(value, user):
    return bool(value and value.get("owner") == identity(user))


@contextmanager
def connect():
    path = Path(os.environ.get("SUMMARY_STORE_PATH", str(Path(__file__).parent / "data" / "summary.sqlite3")))
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS summary_kv(namespace TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(namespace,key));
        CREATE TABLE IF NOT EXISTS summary_draft(
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'draft', content TEXT NOT NULL, source BLOB,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
        CREATE INDEX IF NOT EXISTS summary_draft_owner ON summary_draft(owner,updated_at DESC,id);
        CREATE INDEX IF NOT EXISTS summary_draft_status ON summary_draft(status,updated_at DESC,id);
        CREATE TABLE IF NOT EXISTS sales_order(
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, outlet TEXT NOT NULL, channel TEXT NOT NULL,
          order_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', note TEXT NOT NULL DEFAULT '',
          lines TEXT NOT NULL, rules TEXT NOT NULL, sources TEXT NOT NULL, result TEXT NOT NULL,
          request_id TEXT, customer_no TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
        CREATE INDEX IF NOT EXISTS sales_order_owner ON sales_order(owner,created_at DESC,id);
        CREATE INDEX IF NOT EXISTS sales_order_status ON sales_order(status,created_at DESC,id);
        """)
        # Kunci anti-ganda untuk order hasil pull; NULL (input internal langsung) tidak bertabrakan.
        columns = {row[1] for row in db.execute("PRAGMA table_info(sales_order)")}
        if "request_id" not in columns:
            db.execute("ALTER TABLE sales_order ADD COLUMN request_id TEXT")
        # Pelanggan Accurate WAJIB ada pada order: `customerNo` adalah field wajib
        # sales-invoice/save.do, jadi order tanpa itu tidak bisa menjadi faktur.
        if "customer_no" not in columns:
            db.execute("ALTER TABLE sales_order ADD COLUMN customer_no TEXT NOT NULL DEFAULT ''")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS sales_order_request ON sales_order(request_id)")
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


class JsonStore(MutableMapping):
    """Keyed JSON writes avoid lost updates from whole-file/in-memory caches."""
    def __init__(self, namespace):
        self.namespace = namespace

    def __getitem__(self, key):
        with connect() as db:
            row = db.execute("SELECT value FROM summary_kv WHERE namespace=? AND key=?", (self.namespace, key)).fetchone()
        if row is None:
            raise KeyError(key)
        return json.loads(row[0])

    def __setitem__(self, key, value):
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, default=str)
        with connect() as db:
            db.execute("INSERT INTO summary_kv VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value", (self.namespace, key, encoded))

    def __delitem__(self, key):
        with connect() as db:
            if not db.execute("DELETE FROM summary_kv WHERE namespace=? AND key=?", (self.namespace, key)).rowcount:
                raise KeyError(key)

    def __iter__(self):
        with connect() as db:
            keys = [r[0] for r in db.execute("SELECT key FROM summary_kv WHERE namespace=?", (self.namespace,))]
        return iter(keys)

    def __len__(self):
        with connect() as db:
            return db.execute("SELECT count(*) FROM summary_kv WHERE namespace=?", (self.namespace,)).fetchone()[0]


def create_draft(user, title, content, source=None):
    draft_id = str(uuid.uuid4())
    with connect() as db:
        db.execute("INSERT INTO summary_draft(id,owner,title,content,source) VALUES(?,?,?,?,?)",
                   (draft_id, identity(user), title[:160], json.dumps(content, ensure_ascii=False, allow_nan=False), source))
    return get_draft(draft_id, user)


def get_draft(draft_id, user):
    with connect() as db:
        row = db.execute("SELECT id,title,revision,status,content,created_at,updated_at FROM summary_draft WHERE id=? AND owner=?", (draft_id, identity(user))).fetchone()
    if row is None:
        return None
    value = dict(row)
    value["content"] = json.loads(value["content"])
    return value
