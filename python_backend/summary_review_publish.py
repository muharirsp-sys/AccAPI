"""Tujuan: Terbitkan detail review yang sudah lengkap menjadi aturan order versi tetap.
Caller: routers.summary_review. Dependensi: summary_review, summary_rules, summary_store.
Main Functions: readiness, publish_detail. Side Effects: transaksi SQLite paket + draft terbit; tanpa faktur.
"""
import copy
import json
import uuid
from collections import defaultdict
from summary_review import get_package, encode
from summary_store import connect, identity
from summary_rules import Program


def readiness(row, master):
    s=row['settings'];issues=[]
    if not row.get('start') or not row.get('end'):issues.append('Lengkapi tanggal mulai dan selesai')
    if not row['kode_barang']:issues.append('Pilih SKU dari master')
    if s.get('settlement')!='on_invoice':issues.append('Pilih mekanisme on faktur; klaim rafaksi terpisah tidak memotong faktur')
    if s.get('aggregation')!='invoice':issues.append('Akumulasi lintas faktur belum dapat diterbitkan dari paket ini')
    for key,label in [('history_required','Riwayat pembelian'),('allocation_required','Alokasi outlet'),('max_per_period','Batas pemakaian per periode'),('region','Wilayah'),('exclusive_with','Pengecualian program')]:
        if s.get(key):issues.append(label+' harus diselesaikan sebelum aktivasi')
    if s.get('outlet_codes') or s.get('outlet_list_required'):issues.append('Daftar outlet khusus belum terikat aturan paket ini')
    if s.get('include_tags') or s.get('exclude_tags'):issues.append('Kelas outlet harus ditinjau melalui pustaka aturan Kino terlebih dahulu')
    if s.get('threshold_metric') not in ('quantity','value'):issues.append('Tentukan ambang kuantitas atau nilai')
    if s.get('mix_scope') not in ('same_sku','same_master_group_and_size','same_product_family'):issues.append('Tentukan cakupan mix')
    if s.get('repeat') is None:issues.append('Tentukan apakah berlaku kelipatan')
    if s.get('price_basis') not in ('before_vat','gross','net'):issues.append('Tentukan dasar harga: gross atau net sebelum PPN')
    if not s.get('unit'):issues.append('Tentukan satuan pembelian')
    if s.get('benefit_type') not in ('bonus','percentage','rupiah_per_unit','rupiah_per_invoice'):issues.append('Jenis benefit belum dapat dihitung')
    if s.get('benefit_type')=='bonus' and s.get('bonus_selection') not in ('same_sku',):issues.append('Pilih bonus SKU sama; bonus pilihan/harga sama memerlukan pemilihan SKU pada order')
    if s.get('benefit_type')=='bonus' and s.get('mix_scope')!='same_sku':issues.append('Bonus mix membutuhkan pemilihan SKU; jangan menetapkan SKU pertama sebagai bonus')
    if s.get('benefit_type')=='rupiah_per_unit' and s.get('benefit_unit')!=s.get('unit'):issues.append('Satuan potongan harus sama dengan satuan pembelian; konversi tidak boleh ditebak')
    if s.get('max_per_invoice') is not None:issues.append('Batas per faktur belum didukung pada publikasi paket ini')
    tiers=s.get('tiers') or [dict(minimum=s.get('minimum'),amount=s.get('amount'))]
    if any(t.get('maximum') is not None or t.get('grade') or t.get('history_minimum') is not None for t in tiers):issues.append('Batas atas/grade strata perlu aturan lengkap; tidak boleh diabaikan')
    if issues:return [],issues
    groups=defaultdict(list)
    for code in row['kode_barang']:
        item=master[code]
        if s['mix_scope']=='same_master_group_and_size':
            if not item.get('group') or not item.get('size'):return [],['Kelompok atau gramasi master belum lengkap']
            key=(item['group'],item['size'])
        else:key=code if s['benefit_type']=='bonus' or s['mix_scope']=='same_sku' else 'all'
        groups[key].append(code)
    result=[]
    for i,codes in enumerate(groups.values(),1):
        built=[]
        for t in tiers:
            tier=dict(minimum=str(t.get('minimum')),repeat=s['repeat'])
            amount=t.get('amount',s.get('amount'))
            if s['benefit_type']=='percentage':tier['percentages']=[str(n) for n in s.get('percentages') or [amount]]
            elif s['benefit_type']=='bonus':tier.update(bonus_code=codes[0],bonus_quantity=str(amount),bonus_unit=s.get('benefit_unit') or s['unit'])
            else:tier.update(rupiah=str(amount),rupiah_mode='per_unit' if s['benefit_type']=='rupiah_per_unit' else 'once')
            built.append(tier)
        try:
            result.append(Program.model_validate(dict(id=row['row_id']+'-'+str(i),name=(row.get('nama_program') or row['row_id'])[:160],
                start=row['start'],end=row['end'],codes=codes,channel=row.get('channel') or 'ALL',unit=s['unit'],
                mix=s['mix_scope']!='same_sku',threshold=s['threshold_metric'],value_scope='eligible',basis='net' if s['price_basis']=='net' else 'gross',
                stacking=False,priority=i,tiers=built,source_page=row.get('source_page') or 1,
                source_quote=(row.get('source_quote') or row.get('ketentuan_pengambilan') or row['row_id'])[:4000])).model_dump(mode='json'))
        except ValueError:return [],['Minimum, benefit, satuan atau strata belum valid']
    if len(result)>100:return [],['Terlalu banyak kelompok; pecah detail program sebelum aktivasi']
    return result,[]


def publish_detail(user,package_id,detail_id,revision,reviewed):
    if reviewed is not True:raise ValueError('Periksa sumber dan semua ketentuan sebelum menerbitkan')
    package=get_package(user,package_id)
    if not package:return None
    if type(revision) is not int or revision!=package['revision']:raise RuntimeError('Revisi berubah; muat ulang')
    row=next((r for r in package['content']['details'] if r['row_id']==detail_id),None)
    if not row:return None
    if row.get('publication'):raise RuntimeError('Detail sudah diterbitkan; versi order tetap mengacu publikasi semula')
    programs,issues=readiness(row,package['content']['master'])
    if issues:raise ValueError('; '.join(issues))
    draft_id=str(uuid.uuid4());content=dict(programs=programs,rows=[],period={'start':row['start'],'end':row['end']},
        master={'items':[{'kode_barang':c,'nama_barang':package['content']['master'][c]['name']} for c in row['kode_barang']]},
        extraction={'page_count':max(p['source_page'] for p in programs),'on_faktur':True},
        reviewed_by=identity(user),review_detail=copy.deepcopy(row),review_package={'id':package_id,'revision':revision})
    row['publication']={'draft_id':draft_id,'revision':1}
    with connect() as db:
        changed=db.execute("UPDATE summary_review_package SET content=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner=? AND revision=?",
            (encode(package['content']),package_id,identity(user),revision)).rowcount
        if not changed:raise RuntimeError('Revisi berubah; muat ulang')
        db.execute("INSERT INTO summary_draft(id,owner,title,status,content) VALUES(?,?,?,'published',?)",
            (draft_id,identity(user),(row.get('nama_program') or detail_id)[:160],json.dumps(content,ensure_ascii=False,allow_nan=False)))
    return get_package(user,package_id)
