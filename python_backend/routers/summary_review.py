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
