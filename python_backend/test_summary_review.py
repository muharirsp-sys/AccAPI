"""Tujuan: Check impor/koreksi detail, isolasi pemilik, validasi angka dan konflik revisi.
Caller: python test_summary_review.py [paket.json]. Dependensi: summary_review, SQLite sementara.
Main Functions: main. Side Effects: DB temp yang dibersihkan; tanpa API eksternal/order asli.
"""
import copy
import json
import os
import sys
import tempfile
from pathlib import Path
import summary_review as service


def main():
    settings=dict(enabled=False,reviewed=False,minimum=1,amount=4700,benefit_type='rupiah_per_unit',
        unit='PCS',benefit_unit='PCS',repeat=False,tiers=[],percentages=[],outlet_codes=[],include_tags=[],exclude_tags=[],region=[],exclusive_with=[])
    raw=dict(schema_version='summary-review-v1',publication_status='draft',
        master={'A':{'code':'A','name':'Barang A'}},summary=[{'summary_id':'R001','detail_ids':['S001']}],
        details=[dict(row_id='S001',kode_barang=['A'],start='2026-09-01',end='2026-09-30',settings=settings,correction='')])
    with tempfile.TemporaryDirectory() as temp:
        previous=os.environ.get('SUMMARY_STORE_PATH');os.environ['SUMMARY_STORE_PATH']=str(Path(temp)/'test.sqlite3')
        try:
            a=service.import_package('owner',raw);b=service.import_package('owner',raw)
            assert a['id']==b['id'] and a['revision']==1
            assert service.get_package('stranger',a['id']) is None
            assert service.save_detail('stranger',a['id'],'S001',1,{'correction':'forbidden'}) is None
            changed=service.save_detail('owner',a['id'],'S001',1,{'settings':{**settings,'amount':6000},'correction':'Nominal September'})
            row=changed['content']['details'][0]
            assert row['settings']['amount']==6000 and row['original_review_values']['settings']['amount']==4700
            assert service.import_package('owner',raw)['revision']==2  # Re-import must not overwrite corrections.
            try:service.save_detail('owner',a['id'],'S001',1,{'correction':'stale'})
            except RuntimeError:pass
            else:raise AssertionError('Stale revision accepted')
            for patch in [{'kode_barang':['UNKNOWN']},{'settings':{**settings,'enabled':True}},
                {'settings':{**settings,'amount':-1}},{'settings':{**settings,'amount':float('nan')}},
                {'settings':{**settings,'minimum':True}},{'end':'2026-08-01'},{'status':'published'}]:
                try:service.save_detail('owner',a['id'],'S001',2,patch)
                except (ValueError,TypeError):pass
                else:raise AssertionError('Invalid correction accepted')
            assert service.get_package('owner',a['id'])['revision']==2
            for bad in ['missing','duplicate']:
                value=copy.deepcopy(raw)
                if bad=='missing':value['summary'][0]['detail_ids']=['unknown']
                else:value['details'].append(value['details'][0])
                try:service.import_package('owner',value)
                except ValueError:pass
                else:raise AssertionError('Invalid relations accepted')
            if len(sys.argv)>1:
                live=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
                result=service.import_package('review-test',live)
                assert len(result['content']['details'])==len(live['details'])
                print(f"Actual package: {len(live['details'])} details persisted, {len(live['summary'])} summaries")
            # Test actual HTTP routes while replacing only identity/CSRF at the auth boundary.
            import types
            from fastapi import FastAPI, HTTPException
            from fastapi.testclient import TestClient
            auth=types.ModuleType('routers.summary_library')
            def require_user(request,edit=False):
                user=request.headers.get('x-test-user')
                if not user:raise HTTPException(401,'login')
                if edit and request.headers.get('x-test-csrf')!='valid':raise HTTPException(403,'csrf')
                return user
            auth.require_user=require_user
            old_auth=sys.modules.get('routers.summary_library');sys.modules['routers.summary_library']=auth
            try:
                from routers.summary_review import router
                app=FastAPI();app.include_router(router);client=TestClient(app)
                assert client.get('/summary/review').status_code==401
                assert client.post('/summary/review/import',json=raw,headers={'x-test-user':'owner'}).status_code==403
                headers={'x-test-user':'owner','x-test-csrf':'valid'}
                response=client.post('/summary/review/import',json=raw,headers=headers)
                assert response.status_code==200 and response.json()['package']['revision']==2
                assert client.get('/summary/review/'+a['id'],headers={'x-test-user':'stranger'}).status_code==404
                assert client.post('/summary/review/import',content='{"value":NaN}',headers=headers).status_code==400
                assert client.post('/summary/review/import',content=' '* (8*1024*1024+1),headers=headers).status_code==413
                assert client.put('/summary/review/'+a['id']+'/details/S001',json={'revision':1,'patch':{'correction':'old'}},headers=headers).status_code==409
            finally:
                if old_auth is None:sys.modules.pop('routers.summary_library',None)
                else:sys.modules['routers.summary_library']=old_auth
            print('PASS: persistence, idempotency, ownership, revisions, validation; no live data changed')
        finally:
            if previous is None:os.environ.pop('SUMMARY_STORE_PATH',None)
            else:os.environ['SUMMARY_STORE_PATH']=previous


if __name__=='__main__':main()
