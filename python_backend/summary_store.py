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
        CREATE TABLE IF NOT EXISTS outlet_class(customer_no TEXT NOT NULL, klass TEXT NOT NULL, PRIMARY KEY(customer_no,klass));
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


def find_open_draft(user, title):
    """Draft yang MASIH `draft` dengan judul ini, yang terbaru. None kalau tidak ada.

    Dipakai Summary yang menumpuk: surat kedua menyusul ke grid yang sama, bukan membuat draft
    baru. Judulnya sengaja jadi kuncinya karena judul itulah yang dilihat orang di daftar
    "Muat draft tersimpan" — kunci yang tidak terlihat akan membingungkan saat salah menumpuk.

    Yang sudah `published` TIDAK pernah disusul: publikasi itu beku, dan aturan faktur yang
    sudah terbit tidak boleh berubah di belakang punggung orang yang menandatanganinya.
    """
    with connect() as db:
        row = db.execute(
            "SELECT id FROM summary_draft WHERE owner=? AND title=? AND status='draft'"
            " ORDER BY updated_at DESC,id DESC LIMIT 1",
            (identity(user), title[:160])).fetchone()
    return get_draft(row["id"], user) if row else None


def append_rows(draft_id, user, rows, master=None):
    """Susulkan baris ke draft yang sudah ada. Kembalikan draft terbaru.

    Master ikut diperbarui supaya baris surat baru punya kamus barangnya; baris lama tetap
    utuh karena kode barangnya sudah diturunkan dan disimpan pada barisnya sendiri.
    """
    draft = get_draft(draft_id, user)
    if draft is None or draft["status"] != "draft":
        return None
    content = draft["content"]
    lama = content.get("rows") or []

    # SATU PROGRAM HANYA SEKALI DALAM SATU SUMMARY.
    #
    # Ini penjaga di sambungan, bukan tambalan atas satu bug tertentu: apa pun yang terjadi di
    # hulu — pembaca surat yang mengembalikan baris berlebih, tombol yang tertekan dua kali,
    # permintaan yang terkirim ulang — sebuah Summary yang memuat program yang sama dua kali
    # selalu salah. Ia akan dicetak dua baris untuk ditandatangani, dan kalau kelompoknya
    # sempat terisi, dimuat dua kali ke `promo_rule`.
    #
    # Terbukti perlu 2026-09-16: menyusulkan surat kedua menghasilkan satu salinan surat
    # PERTAMA di draft, verbatim sampai `promo_group_id`-nya. Sebab hulunya belum ditemukan;
    # penjaga ini tidak menunggu sebab itu ketemu, dan tetap benar setelah ia ketemu.
    #
    # Jati diri satu baris program: surat + ketentuan + benefit + BARANGNYA (kode dan kutipan
    # baris surat). Bukan `id` (baris dari pembaca surat belum punya), dan bukan kelompoknya
    # (justru itu yang sedang dikoreksi orang).
    #
    # Barang WAJIB ikut. Sampai 24 September 2026 jati dirinya tanpa barang, dan surat DAHLIA
    # 083 yang memberi rafaksi Rp 1.000 kepada tujuh kode berbeda kehilangan enam di antaranya
    # di sini: ketujuh baris "kembar", yang pertama disimpan, sisanya dibuang. Surat 234
    # kehilangan lima dari enam grupnya dengan cara yang sama. Surat yang sama yang diunggah
    # dua kali tetap tertangkap -- kode dan kutipannya pun sama persis.
    def _jatidiri(baris):
        return tuple(" ".join(str(baris.get(k) or "").split()).upper()
                     for k in ("surat_program", "ketentuan", "benefit_type", "benefit", "kode_barangs", "source_quote"))

    # Baris kembar DIBUANG, tetapi KETERANGANNYA DISELAMATKAN.
    #
    # Jati diri sengaja tidak memuat kelompok. Baris tertahan tanpa kode dan tanpa kutipan
    # bisa melebur -- dan keterangan adalah satu-satunya tempat barang yang DITAHAN menyebut
    # namanya, jadi membuangnya berarti barang itu lenyap sebelum Form sempat melihatnya.
    #
    # Terbukti 20 September 2026: surat 570 menahan `F601LB` dan `F601SB`; keduanya hilang di
    # sini, bukan di perender. Gerbang `tools/verify_form_summary.py` (C9) yang menemukannya.
    # Perbaikan yang sama sudah dipasang di `summary_manual_generate`; ini sambungan keduanya.
    sudah = {}
    for b in lama:
        sudah.setdefault(_jatidiri(b), b)
    baru_saja = []
    for baris in rows or []:
        kunci = _jatidiri(baris)
        kembar = sudah.get(kunci)
        if kembar is not None:
            ket_baru = " ".join(str(baris.get("keterangan") or "").split())
            if ket_baru:
                bagian = [p.strip() for p in str(kembar.get("keterangan") or "").split(" | ") if p.strip()]
                if ket_baru not in bagian:
                    kembar["keterangan"] = " | ".join([*bagian, ket_baru]) if bagian else ket_baru
            continue
        sudah[kunci] = baris
        baru_saja.append(baris)

    content["rows"] = [*lama, *baru_saja]
    for nomor, baris in enumerate(content["rows"], 1):
        baris["no"] = str(nomor)
    if master:
        content["master"] = master
    content.pop("programs", None)
    with connect() as db:
        db.execute(
            "UPDATE summary_draft SET content=?,revision=revision+1,"
            "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner=? AND status='draft'",
            (json.dumps(content, ensure_ascii=False, allow_nan=False), draft_id, identity(user)))
    return get_draft(draft_id, user)


def get_draft(draft_id, user):
    with connect() as db:
        row = db.execute("SELECT id,title,revision,status,content,created_at,updated_at FROM summary_draft WHERE id=? AND owner=?", (draft_id, identity(user))).fetchone()
    if row is None:
        return None
    value = dict(row)
    value["content"] = json.loads(value["content"])
    return value
