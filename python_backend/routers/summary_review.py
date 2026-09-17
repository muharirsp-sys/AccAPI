"""Tujuan: API impor dan koreksi detail pengaturan Summary.
Caller: /summary/settings web. Dependensi: summary_review, summary_library auth/CSRF.
Main Functions: list/import/get/update/publish detail. Side Effects: SQLite paket privat dan aturan terbit, baca paket referensi volume.
"""
import json
import os
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from routers.summary_library import require_user
import summary_review as service
from summary_review_publish import publish_detail, readiness

router=APIRouter(prefix='/summary/review')


async def body(request):
    raw=await request.body()
    if len(raw)>8*1024*1024:raise HTTPException(413,'Paket maksimal 8 MB')
    try:return json.loads(raw,parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError,RecursionError):raise HTTPException(400,'JSON tidak valid') from None


@router.get('')
def list_packages(request:Request):
    return {'ok':True,'packages':service.list_packages(require_user(request))}


@router.post('/import')
async def import_package(request:Request):
    user=require_user(request,True)
    try:return {'ok':True,'package':service.import_package(user,await body(request))}
    except (ValueError,TypeError,KeyError,RecursionError):raise HTTPException(400,'Paket tidak valid. Periksa ID, master, tanggal, angka, dan status draft.') from None


def _ringkas(row):
    """Satu publikasi -> keterangan singkat, tanpa membongkar seluruh isinya."""
    content = json.loads(row[3])
    detail = content.get('review_detail') or {}
    programs = content.get('programs') or []
    baris = content.get('rows') or []

    def _unik(nilai):
        """Nilai berbeda, urut kemunculannya. Kosong disaring — bukan jawaban, hanya ketiadaan."""
        hasil = []
        for satu in nilai:
            satu = str(satu or '').strip()
            if satu and satu not in hasil:
                hasil.append(satu)
        return hasil

    # SATU PUBLIKASI BISA MEMUAT BANYAK SURAT (keputusan #74). Sampai 2026-09-16 kolom ini hanya
    # membaca `review_detail`, yang milik paket review — pustaka Summary tidak menitipkannya, jadi
    # daftar "Tarik dari Summary" menulis "tanpa nomor" untuk publikasi yang nomor suratnya jelas
    # ada. Yang membaca daftar itu adalah orang yang akan menekan Muat, dan nomor surat inilah yang
    # ikut tersimpan pada catatan persetujuannya.
    surat = _unik([detail.get('document_id')] + [p.get('surat_program') for p in programs]
                  + [r.get('surat_program') for r in baris])
    mulai = _unik(p.get('start') for p in programs)
    selesai = _unik(p.get('end') for p in programs)
    periode = content.get('period')
    if isinstance(periode, (list, tuple)):
        periode = {'start': str(periode[0]) if periode else '', 'end': str(periode[1]) if len(periode) > 1 else ''}
    periode = periode if isinstance(periode, dict) else {}

    return {
        'draft_id': row[0], 'title': row[1], 'published_at': row[2],
        'surat_program': ', '.join(surat),
        'principal': str(detail.get('principal') or (baris[0].get('principle') if baris else '') or ''),
        'nama_program': str(detail.get('nama_program') or ''),
        'kelompok': ', '.join(_unik([detail.get('variant_barang')] + [p.get('kelompok') for p in programs])),
        'period': {'start': periode.get('start') or (min(mulai) if mulai else ''),
                   'end': periode.get('end') or (max(selesai) if selesai else '')},
        'programs': len(programs),
        'codes': sorted({code for program in programs for code in (program.get('codes') or [])}),
    }


@router.get('/published/list')
def published_list(request: Request):
    """Publikasi yang siap dijembatani ke aturan promo.

    Hanya yang berstatus `published`: itulah satu-satunya tempat manusia sudah menyatakan
    "saya sudah memeriksa ini". Draft tidak pernah boleh menyeberang ke gerbang faktur.
    """
    user = require_user(request)
    with service.connect() as db:
        rows = db.execute(
            "SELECT id,title,updated_at,content FROM summary_draft "
            "WHERE owner=? AND status='published' ORDER BY updated_at DESC LIMIT 200",
            (service.identity(user),)).fetchall()
    return {'ok': True, 'published': [_ringkas(row) for row in rows]}


@router.get('/published/{draft_id}')
def published_one(request: Request, draft_id: str):
    """Isi satu publikasi, apa adanya. Pembacanya yang menerjemahkan, bukan endpoint ini."""
    user = require_user(request)
    with service.connect() as db:
        row = db.execute(
            "SELECT id,title,updated_at,content FROM summary_draft "
            "WHERE id=? AND owner=? AND status='published'",
            (draft_id, service.identity(user))).fetchone()
    if not row:
        raise HTTPException(404, 'Publikasi tidak ditemukan')
    return {'ok': True, 'published': _ringkas(row), 'content': json.loads(row[3])}


@router.get('/{package_id}')
def get_package(request:Request,package_id:str):
    value=service.get_package(require_user(request),package_id)
    if not value:raise HTTPException(404,'Paket tidak ditemukan')
    return {'ok':True,'package':value}


@router.post('/reference/september')
def reference(request:Request):
    user=require_user(request,True)
    path=Path(os.getenv('SUMMARY_REVIEW_REFERENCE',str(Path(__file__).resolve().parents[1]/'data'/'summary_review_seed.json')))
    if not path.is_file():raise HTTPException(404,'Paket referensi September belum tersedia')
    if path.stat().st_size>8*1024*1024:raise HTTPException(413,'Paket referensi terlalu besar')
    return {'ok':True,'package':service.import_package(user,json.loads(path.read_text(encoding='utf8')))}


@router.get('/{package_id}/details/{detail_id}/readiness')
def detail_readiness(request:Request,package_id:str,detail_id:str):
    value=service.get_package(require_user(request),package_id)
    row=next((r for r in value['content']['details'] if r['row_id']==detail_id),None) if value else None
    if not row:raise HTTPException(404,'Detail tidak ditemukan')
    programs,issues=readiness(row,value['content']['master'])
    return {'ok':True,'programs':programs,'issues':issues}


@router.post('/{package_id}/details/{detail_id}/publish')
async def publish(request:Request,package_id:str,detail_id:str):
    user=require_user(request,True);payload=await body(request)
    if not isinstance(payload,dict):raise HTTPException(400,'Isi publikasi tidak valid')
    try:value=publish_detail(user,package_id,detail_id,payload.get('revision'),payload.get('reviewed'))
    except ValueError as error:raise HTTPException(400,str(error)) from None
    except RuntimeError as error:raise HTTPException(409,str(error)) from None
    if not value:raise HTTPException(404,'Detail tidak ditemukan')
    return {'ok':True,'package':value}


@router.put('/{package_id}/details/{detail_id}')
async def update_detail(request:Request,package_id:str,detail_id:str):
    user=require_user(request,True);payload=await body(request)
    if not isinstance(payload,dict):raise HTTPException(400,'Isi koreksi tidak valid')
    try:value=service.save_detail(user,package_id,detail_id,payload.get('revision'),payload.get('patch'))
    except RuntimeError as error:raise HTTPException(409,str(error)) from None
    except (ValueError,TypeError,KeyError):raise HTTPException(400,'Periksa angka, tanggal, kode barang dan status draft pada koreksi.') from None
    if not value:raise HTTPException(404,'Detail tidak ditemukan')
    return {'ok':True,'package':value}
