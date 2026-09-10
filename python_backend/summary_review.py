"""Tujuan: Paket review Summary, detail setting, dan koreksi persisten milik pengguna.
Caller: routers.summary_review. Dependensi: summary_store SQLite dan stdlib.
Main Functions: import_package, list_packages, get_package, save_detail, validate_package.
Side Effects: SQLite read/write atomik; tidak menerbitkan aturan atau menghitung realisasi.
"""
import copy
import hashlib
import json
import re
import uuid
from datetime import date
from decimal import Decimal, InvalidOperation
from summary_store import connect, identity

TEXT_FIELDS = {'threshold_metric','aggregation','unit','mix_scope','benefit_type','benefit_unit',
               'settlement','price_basis','bonus_selection','max_per_period'}
NUM_FIELDS = {'minimum','amount','max_per_invoice'}
BOOL_FIELDS = {'repeat','outlet_list_required','history_required','allocation_required'}
LIST_FIELDS = {'outlet_codes','include_tags','exclude_tags','region','exclusive_with'}


def ensure(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS summary_review_package(
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_hash TEXT NOT NULL,
      title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner,source_hash));
    CREATE INDEX IF NOT EXISTS summary_review_owner ON summary_review_package(owner,updated_at DESC,id);
    """)


def encode(value):
    return json.dumps(value,ensure_ascii=False,allow_nan=False,sort_keys=True,separators=(',',':'))


def numeric(value, label):
    if value is None:return
    if isinstance(value,bool) or not isinstance(value,(int,float)):
        raise ValueError(label+' harus angka atau kosong')
    try:n=Decimal(str(value))
    except InvalidOperation:raise ValueError(label+' bukan angka valid') from None
    if not n.is_finite() or n<0 or n>10**12:raise ValueError(label+' di luar batas')


def check_settings(settings):
    if not isinstance(settings,dict):raise ValueError('Setting harus object')
    if settings.get('enabled') is not False or settings.get('reviewed') is not False:
        raise ValueError('Paket review harus tetap tidak aktif dan belum diterbitkan')
    for key in TEXT_FIELDS:
        val=settings.get(key)
        if val is not None and not isinstance(val,(str,int,float)):raise ValueError(key+' harus teks atau angka')
        if isinstance(val,str) and len(val)>2000:raise ValueError(key+' terlalu panjang')
    for key in NUM_FIELDS:numeric(settings.get(key),key)
    for key in BOOL_FIELDS:
        if settings.get(key) is not None and type(settings[key]) is not bool:raise ValueError(key+' harus ya/tidak/kosong')
    for key in LIST_FIELDS:
        val=settings.get(key,[])
        if not isinstance(val,list) or len(val)>2000 or any(not isinstance(x,str) or not x.strip() or len(x)>160 for x in val):
            raise ValueError(key+' harus daftar teks yang valid')
        if len(val)!=len(set(val)):raise ValueError(key+' berisi duplikat')
    percentages=settings.get('percentages',[])
    if not isinstance(percentages,list) or len(percentages)>10:raise ValueError('Persen bertingkat tidak valid')
    for n in percentages:
        numeric(n,'Persen')
        if n is None or n>100:raise ValueError('Persen harus 0-100')
    if settings.get('benefit_type')=='percentage' and settings.get('amount') is not None and settings['amount']>100:
        raise ValueError('Persen harus 0-100')
    tiers=settings.get('tiers',[])
    if not isinstance(tiers,list) or len(tiers)>100:raise ValueError('Maksimal 100 tier per detail')
    for t in tiers:
        if not isinstance(t,dict):raise ValueError('Tier harus object')
        for key in ['minimum','maximum','amount','history_minimum','history_maximum']:numeric(t.get(key),'Tier '+key)
        if t.get('minimum') is not None and t.get('maximum') is not None and t['maximum']<t['minimum']:
            raise ValueError('Maksimum tier lebih kecil dari minimum')
        if t.get('benefit_type')=='percentage' and t.get('amount') is not None and t['amount']>100:
            raise ValueError('Persen tier harus 0-100')


def check_detail(r,master):
    if not isinstance(r,dict) or not isinstance(r.get('row_id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',r['row_id']):
        raise ValueError('ID detail tidak valid')
    codes=r.get('kode_barang')
    if not isinstance(codes,list) or len(codes)>3000 or any(not isinstance(c,str) or c not in master for c in codes):
        raise ValueError('Kode barang harus berasal dari master paket')
    if len(codes)!=len(set(codes)):raise ValueError('Kode barang duplikat')
    for key in ['start','end']:
        if r.get(key):date.fromisoformat(r[key])
    if r.get('start') and r.get('end') and r['end']<r['start']:raise ValueError('Periode akhir mendahului awal')
    if not isinstance(r.get('correction',''),str) or len(r.get('correction',''))>8000:raise ValueError('Koreksi maksimal 8000 karakter')
    check_settings(r.get('settings'))


def validate_package(raw):
    if not isinstance(raw,dict) or raw.get('schema_version')!='summary-review-v1' or raw.get('publication_status')!='draft':
        raise ValueError('Gunakan paket Summary review versi 1 berstatus draft')
    details,summary,master=raw.get('details'),raw.get('summary'),raw.get('master')
    if not isinstance(details,list) or not 1<=len(details)<=2000:raise ValueError('Isi 1-2000 detail')
    if not isinstance(master,dict) or not 1<=len(master)<=20000:raise ValueError('Master tidak valid')
    if any(not isinstance(c,str) or not isinstance(m,dict) or m.get('code')!=c for c,m in master.items()):raise ValueError('Identitas master tidak valid')
    ids=set()
    for r in details:
        check_detail(r,master)
        if r['row_id'] in ids:raise ValueError('ID detail duplikat')
        ids.add(r['row_id'])
    if not isinstance(summary,list) or not 1<=len(summary)<=2000:raise ValueError('Summary tidak valid')
    covered=set();summary_ids=set()
    for s in summary:
        if not isinstance(s,dict) or not isinstance(s.get('summary_id'),str) or not isinstance(s.get('detail_ids'),list):raise ValueError('Relasi summary tidak valid')
        if s['summary_id'] in summary_ids:raise ValueError('ID summary duplikat')
        if any(not isinstance(k,str) or k not in ids for k in s['detail_ids']):raise ValueError('Summary merujuk detail yang tidak ada')
        summary_ids.add(s['summary_id']);covered.update(s['detail_ids'])
    if covered!=ids:raise ValueError('Ada detail tanpa summary')
    encode(raw)  # Reject NaN/Infinity anywhere in the payload before storage.
    return raw


def import_package(user,raw):
    validate_package(raw)
    value=encode(raw);source_hash=hashlib.sha256(value.encode()).hexdigest()
    package_id=str(uuid.uuid4());title='Summary September 2026' if raw.get('created')=='2026-09-10' else 'Paket Summary Program'
    with connect() as db:
        ensure(db)
        db.execute('INSERT OR IGNORE INTO summary_review_package(id,owner,source_hash,title,content) VALUES(?,?,?,?,?)',
            (package_id,identity(user),source_hash,title,value))
        row=db.execute('SELECT id FROM summary_review_package WHERE owner=? AND source_hash=?',(identity(user),source_hash)).fetchone()
    return get_package(user,row['id'])


def list_packages(user):
    with connect() as db:
        ensure(db)
        return [dict(r) for r in db.execute('SELECT id,title,revision,updated_at FROM summary_review_package WHERE owner=? ORDER BY updated_at DESC,id LIMIT 100',(identity(user),))]


def get_package(user,package_id):
    with connect() as db:
        ensure(db)
        row=db.execute('SELECT id,title,revision,content,updated_at FROM summary_review_package WHERE id=? AND owner=?',(package_id,identity(user))).fetchone()
    if not row:return None
    result=dict(row);result['content']=json.loads(result['content']);return result


def save_detail(user,package_id,detail_id,revision,patch):
    value=get_package(user,package_id)
    if not value:return None
    if type(revision) is not int or revision!=value['revision']:raise RuntimeError('Revisi berubah. Muat ulang sebelum menyimpan.')
    if not isinstance(patch,dict) or set(patch)-{'start','end','kode_barang','settings','correction'}:raise ValueError('Field koreksi tidak didukung')
    target=next((r for r in value['content']['details'] if r['row_id']==detail_id),None)
    if target is None:return None
    original=target.get('original_review_values') or {k:copy.deepcopy(target.get(k)) for k in ['start','end','kode_barang','settings','correction']}
    target.update(patch);target['original_review_values']=original
    check_detail(target,value['content']['master'])
    with connect() as db:
        changed=db.execute("UPDATE summary_review_package SET content=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner=? AND revision=?",
            (encode(value['content']),package_id,identity(user),revision)).rowcount
        if not changed:raise RuntimeError('Revisi berubah. Muat ulang sebelum menyimpan.')
    return get_package(user,package_id)
