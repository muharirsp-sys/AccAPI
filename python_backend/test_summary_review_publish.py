"""Tujuan: Check detail -> publikasi -> order beku, koreksi ringkas, penolakan syarat yang belum didukung.
Caller: python test_summary_review_publish.py. Dependensi: SQLite temp, summary_review/publish/rules.
Main Functions: main. Side Effects: SQLite sementara, tanpa Accurate/produksi.
"""
import copy
import os
import tempfile
from pathlib import Path
from summary_review import import_package, save_detail
from summary_review_publish import publish_detail, readiness
from summary_store import get_draft
from summary_rules import Program, calculate


def main():
    with tempfile.TemporaryDirectory() as temp:
        old=os.environ.get('SUMMARY_STORE_PATH');os.environ['SUMMARY_STORE_PATH']=str(Path(temp)/'test.sqlite3')
        try:
            s=dict(enabled=False,reviewed=False,minimum=1,amount=4700,benefit_type='rupiah_per_unit',unit='PCS',benefit_unit='PCS',
                repeat=False,tiers=[],percentages=[],outlet_codes=[],include_tags=[],exclude_tags=[],region=[],exclusive_with=[],
                settlement='on_invoice',aggregation='invoice',threshold_metric='quantity',mix_scope='same_sku',price_basis='gross')
            r=dict(row_id='S1',nama_program='Potongan per PCS',kode_barang=['A'],channel='GT',start='2026-09-01',end='2026-09-30',settings=s,correction='')
            raw=dict(schema_version='summary-review-v1',publication_status='draft',master={'A':{'code':'A','name':'A'}},details=[r],summary=[{'summary_id':'R1','detail_ids':['S1']}])
            p=import_package('owner',raw)
            changed=save_detail('owner',p['id'],'S1',1,{'settings':{**s,'amount':4000}})
            assert changed['content']['summary'][0]['benefit']=='4000/PCS'
            assert publish_detail('stranger',p['id'],'S1',2,True) is None
            try:publish_detail('owner',p['id'],'S1',2,False)
            except ValueError:pass
            else:raise AssertionError('Unreviewed publication accepted')
            done=publish_detail('owner',p['id'],'S1',2,True);link=done['content']['details'][0]['publication']
            draft=get_draft(link['draft_id'],'owner');assert draft['status']=='published'
            rules=[Program.model_validate(v) for v in draft['content']['programs']]
            result=calculate(rules,[dict(code='A',unit='PCS',quantity='30',price='10000')],'2026-09-10','GT')
            assert result['discount']=='120000.00'
            try:publish_detail('owner',p['id'],'S1',2,True)
            except RuntimeError:pass
            else:raise AssertionError('Duplicate publication accepted')
            for patch in [{'history_required':True},{'max_per_period':3},{'settlement':'rafaksi'},{'region':['JAVA']},
                {'benefit_unit':'CTN'},{'tiers':[dict(minimum=1,maximum=5,amount=100)]},
                {'benefit_type':'bonus','bonus_selection':'same_sku','mix_scope':'same_product_family'}]:
                bad=copy.deepcopy(r);bad['settings'].update(patch)
                assert readiness(bad,raw['master'])[1],patch
            assert readiness(r,raw['master'])[1]==[]
            print('PASS: review -> immutable published rules -> order; no unsupported eligibility/caps silently ignored')
        finally:
            if old is None:os.environ.pop('SUMMARY_STORE_PATH',None)
            else:os.environ['SUMMARY_STORE_PATH']=old


if __name__=='__main__':main()
