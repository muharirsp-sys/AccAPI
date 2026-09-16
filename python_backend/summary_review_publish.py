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
from summary_rules import Program, number


def minimum_of(tier):
    """Ambang satu strata; TANPA syarat beli berarti SATU, bukan nol.

    `Tier` menolak minimum <= 0, jadi surat yang memang tidak menyebut syarat beli ("diskon 3%
    on faktur", tanpa "beli N") dulu gagal terbit dengan pesan yang tidak menyebut sebabnya.
    Padahal artinya jelas dan tidak ambigu: SETIAP pembelian dapat. Dalam satuan terkecil,
    "setiap pembelian" adalah satu.

    Yang TIDAK dilakukan di sini: menebak. Angka yang tertulis tetap dipakai apa adanya; yang
    diganti hanya yang kosong atau nol. Ambang yang salah baca akan tetap salah, dan itu urusan
    pembaca suratnya, bukan urusan nilai bawaan ini.
    """
    tulisan = str(tier.get('minimum') or '').strip()
    if not tulisan:
        return '1'
    try:
        return tulisan if number(tulisan) > 0 else '1'
    except ValueError:
        # Bukan angka sama sekali -> biarkan `Tier` yang menolaknya dengan sebabnya sendiri.
        return tulisan


def peserta(row, s):
    """Siapa yang berhak ikut: SATU daftar, SATU arah — atau ditolak dengan sebabnya.

    Kembalikan `(outlet_mode, outlet_classes, masalah)`.

    Sebelum ini setiap surat yang membatasi pesertanya ditolak mentah, jadi yang terbit dari
    Summary SELALU "semua outlet" dan pembatasannya harus dipasang tangan lewat impor Excel.
    Tiga dari empat surat September produksi justru bentuk itu.

    `promo_rule` hanya punya SATU tempat daftar peserta dan SATU arahnya, karena itulah yang
    bisa ditanyakan gerbang atas satu baris faktur. Surat yang menyebut lebih dari satu daftar
    tidak bisa dinyatakan utuh — dan separuh aturan peserta akan meloloskan potongan kepada
    toko yang justru dikecualikan suratnya.

    Daftar KODE outlet sengaja tidak dijawab di sini: jembatan sudah menamai daftarnya dengan
    nomor suratnya sendiri dan menuliskan anggotanya ke `promo_outlet`. Yang diputuskan di sini
    hanya KELAS outlet.
    """
    include=[t.strip() for t in (s.get('include_tags') or []) if str(t).strip()]
    exclude=[t.strip() for t in (s.get('exclude_tags') or []) if str(t).strip()]
    codes=[c for c in (s.get('outlet_codes') or []) if str(c).strip()]
    kelas=include or exclude
    if include and exclude:
        return 'all',[],'Surat menyebut kelas outlet yang diikutkan DAN yang dikecualikan; satu aturan hanya bisa menunjuk satu daftar, satu arah'
    if kelas and codes:
        return 'all',[],'Surat menyebut kelas outlet DAN daftar kode outlet; pilih salah satu, karena satu aturan hanya menunjuk satu daftar'
    if len(kelas)>1:
        return 'all',[],f'Surat menyebut {len(kelas)} kelas outlet; satu aturan hanya bisa menunjuk SATU daftar peserta'
    if kelas:
        return ('only' if include else 'except'),[kelas[0]],None
    if s.get('outlet_list_required') and not codes:
        # "LIST OUTLET TERLAMPIR": daftarnya tidak ikut di setelan, jadi aturannya ditambatkan
        # ke daftar bernama NOMOR SURATNYA — nama yang sama persis dengan yang dibuat layar
        # "Daftar outlet peserta" saat suratnya diunggah. Selama lampirannya belum diunggah,
        # daftar itu kosong, dan INCLUDE kosong berarti TIDAK ADA yang berhak. Gagal tertutup.
        surat=str(row.get('document_id') or '').strip()
        if not surat:
            return 'all',[],'Surat menyebut lampiran daftar outlet tetapi nomor suratnya kosong, jadi daftarnya tidak punya nama untuk ditunjuk'
        return 'only',[surat],None
    return 'all',[],None


def readiness(row, master):
    s=row['settings'];issues=[]
    if not row.get('start') or not row.get('end'):issues.append('Lengkapi tanggal mulai dan selesai')
    if not row['kode_barang']:issues.append('Pilih SKU dari master')
    if s.get('settlement')!='on_invoice':issues.append('Pilih mekanisme on faktur; klaim rafaksi terpisah tidak memotong faktur')
    if s.get('aggregation')!='invoice':issues.append('Akumulasi lintas faktur belum dapat diterbitkan dari paket ini')
    for key,label in [('history_required','Riwayat pembelian'),('allocation_required','Alokasi outlet'),('max_per_period','Batas pemakaian per periode'),('region','Wilayah'),('exclusive_with','Pengecualian program')]:
        if s.get(key):issues.append(label+' harus diselesaikan sebelum aktivasi')
    outlet_mode,outlet_classes,masalah_peserta=peserta(row,s)
    if masalah_peserta:issues.append(masalah_peserta)
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
            tier=dict(minimum=minimum_of(t),repeat=s['repeat'])
            amount=t.get('amount',s.get('amount'))
            if s['benefit_type']=='percentage':tier['percentages']=[str(n) for n in s.get('percentages') or [amount]]
            elif s['benefit_type']=='bonus':tier.update(bonus_code=codes[0],bonus_quantity=str(amount),bonus_unit=s.get('benefit_unit') or s['unit'])
            else:tier.update(rupiah=str(amount),rupiah_mode='per_unit' if s['benefit_type']=='rupiah_per_unit' else 'once')
            built.append(tier)
        try:
            result.append(Program.model_validate(dict(id=row['row_id']+'-'+str(i),name=(row.get('nama_program') or row['row_id'])[:160],
                start=row['start'],end=row['end'],codes=codes,channel=row.get('channel') or 'ALL',
                outlet_mode=outlet_mode,outlet_classes=outlet_classes,unit=s['unit'],
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
