"""Tujuan: Rekap Pak Fahdhar dari transaksi run, mengikuti kolom template aktif.
Caller: routers.laporan_harian setelah laporan penerima selesai dibuat.
Dependensi: pandas, pyexcelerate, laporan_harian_layout; tidak memakai target periode lama.
Main Functions: build_manager_rows, write_manager_report.
Side Effects: Menulis XLSX XML UTF-8 standar dengan formula/cache dan HTML screenshot ke direktori run.
"""
from decimal import Decimal, ROUND_HALF_UP
from html import escape
from pathlib import Path
import math
import zipfile
import xml.etree.ElementTree as ET

import pandas as pd
from pyexcelerate import Workbook
from laporan_harian_layout import NS, apply_layout, report_layout


def rounded(value):
    return int(Decimal(str(value)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def build_manager_rows(sb, lookups):
    """Agregasi sekali dari JUMLAH termasuk pajak, net retur, tanpa overlap SPV/SM.

    Cabang Accurate dipertahankan untuk kelompok rekap, termasuk retur yang jenis produk
    historisnya tidak cocok di format eksternal. Missing mapping tetap terlihat.
    """
    source = sb.copy()
    branch = source.get('CABANG_OR_COSTCENTER', source['JENISPRODUK']).astype('string').str.strip()
    source['JENISPRODUK'] = branch.where(branch.notna() & branch.ne(''), source['JENISPRODUK'])
    key = source['PRINCIPAL'].fillna('') + source['JENISPRODUK'].fillna('')
    source['GOLONGAN'] = key.map(lookups.conca_to_spv)
    source['SM'] = source['PRINCIPAL'].map(lookups.sm_map)
    if 'JUMLAH' not in source:
        raise ValueError('Rekap Pak Fahdhar memerlukan kolom JUMLAH.')
    values = pd.to_numeric(source['JUMLAH'], errors='coerce')
    if values.isna().any() or not values.map(math.isfinite).all():
        raise ValueError('Rekap Pak Fahdhar memerlukan JUMLAH numerik pada setiap transaksi.')
    source['amount'] = values
    fields = ['SM', 'GOLONGAN', 'JENISPRODUK', 'PRINCIPAL']
    grouped = source.groupby(fields, dropna=False, sort=True)['amount'].sum().reset_index()
    rows = []
    for index, row in grouped.iterrows():
        text = {k: '' if pd.isna(row[k]) else str(row[k]) for k in fields}
        amount = float(row['amount'])
        whole = rounded(amount)
        rows.append([index + 1, text['JENISPRODUK'] + text['PRINCIPAL'], text['SM'],
                     text['GOLONGAN'], text['JENISPRODUK'], text['PRINCIPAL'],
                     amount, whole, math.trunc(whole / 1000), None, None, None])
    return rows


def _finish_workbook(path, rows):
    """Formula sederhana dengan cache hasil aktual; tabel native menjaga banding template."""
    temp = path.with_suffix('.final.xlsx')
    count = len(rows)
    main_ns = '{' + NS + '}'
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(temp, 'w', zipfile.ZIP_DEFLATED) as dst:
        for entry in src.infolist():
            data = src.read(entry.filename)
            if entry.filename == 'xl/worksheets/sheet1.xml':
                root = ET.fromstring(data)
                for row in root.find(main_ns + 'sheetData'):
                    r = int(row.attrib['r'])
                    for cell in row:
                        address = cell.attrib['r']
                        col = ''.join(c for c in address if c.isalpha())
                        formula = None
                        if 2 <= r <= count + 1:
                            if col == 'H': formula = f'ROUND(G{r},0)'
                            elif col == 'I': formula = f'TRUNC(H{r}/1000,0)'
                        elif r == count + 2 and col in ('G', 'H', 'I'):
                            formula = f'SUM({col}2:{col}{count+1})'
                        if formula:
                            cell.insert(0, ET.Element(main_ns + 'f'))
                            cell[0].text = formula
                table_parts = ET.SubElement(root, main_ns + 'tableParts', {'count':'1'})
                ET.SubElement(table_parts, main_ns+'tablePart', {'{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id':'rIdFahdhar'})
                data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
            elif entry.filename == '[Content_Types].xml':
                pos = data.rfind(b'</')
                override = b'<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>'
                data = data[:pos] + override + data[pos:]
            dst.writestr(entry, data)
        header = report_layout('Pak Fahdhar')['sheets'][0]['headers'][1:]
        table = ET.Element(main_ns+'table', {'id':'1','name':'FahdharSummary','displayName':'FahdharSummary','ref':f'B1:L{count+1}','totalsRowShown':'0'})
        columns = ET.SubElement(table,main_ns+'tableColumns',{'count':'11'})
        for i,name in enumerate(header,1):
            ET.SubElement(columns,main_ns+'tableColumn',{'id':str(i),'name':name})
        ET.SubElement(table,main_ns+'tableStyleInfo',{'name':'TableStyleLight1','showFirstColumn':'0','showLastColumn':'0','showRowStripes':'1','showColumnStripes':'0'})
        dst.writestr('xl/tables/table1.xml',ET.tostring(table,encoding='utf-8',xml_declaration=True))
        rel = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFahdhar" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>'
        dst.writestr('xl/worksheets/_rels/sheet1.xml.rels',rel)
    temp.replace(path)


def write_manager_report(sb, lookups, out_dir, report_date):
    rows = build_manager_rows(sb, lookups)
    if not rows:
        raise ValueError('Tidak ada transaksi untuk rekap Pak Fahdhar.')
    directory = Path(out_dir)
    file_name = f'{report_date}_Laporan_Pak_Fahdhar.xlsx'
    html_name = f'{report_date}_Laporan_Pak_Fahdhar.html'
    totals = [None, 'Total', None, None, None, None,
              sum(r[6] for r in rows), sum(r[7] for r in rows), sum(r[8] for r in rows), None, None, None]
    layout = report_layout('Pak Fahdhar')['sheets'][0]
    workbook = Workbook()
    workbook.new_sheet(layout['name'], data=[layout['headers']] + rows + [totals])
    workbook.save(directory / file_name)
    apply_layout(directory / file_name, 'Pak Fahdhar')
    _finish_workbook(directory / file_name, rows)
    visible = [0, 2, 3, 4, 5, 8, 9, 10, 11]
    widths = [25, 73, 116, 148, 253, 132, 94, 113, 55]
    table_head = ''.join(f'<th>{escape(layout["headers"][i])}</th>' for i in visible)
    body = []
    for row in rows:
        body.append('<tr>' + ''.join(
            f'<td class="num">{row[i]:,}</td>'.replace(',', '.') if i == 8 else
            f'<td>{escape(str(row[i])) if row[i] is not None else ""}</td>' for i in visible) + '</tr>')
    footer = f'<tr class="total"><td></td><td colspan="4">Total</td><td class="num">{totals[8]:,}</td><td></td><td></td><td></td></tr>'.replace(',', '.')
    unmapped = sum(not r[2] or not r[3] for r in rows)
    notice = 'Target September belum dimuat.' if report_date.startswith('2026-09') else 'Target periode laporan belum dimuat.'
    if unmapped:
        notice += f' {unmapped} kelompok belum memiliki mapping SPV/SM.'
    months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember']
    period = f'1–{int(report_date[-2:])} {months[int(report_date[5:7])-1]} {report_date[:4]}'
    html = f'''<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Laporan Pak Fahdhar — {escape(report_date)}</title><style>
*{{box-sizing:border-box}}body{{margin:24px;background:white;color:#111;font:11pt Calibri,Arial,sans-serif}}main{{width:1109px}}h1{{font-size:16pt;margin:0 0 5px}}p{{margin:0 0 16px;color:#444}}table{{border-collapse:collapse;table-layout:fixed;width:1109px}}th{{font-weight:bold;border-bottom:1px solid #222}}th:first-child{{white-space:nowrap;padding:5px 1px}}th,td{{padding:5px 4px;vertical-align:middle;overflow-wrap:break-word}}tbody tr:nth-child(odd){{background:#d9d9d9}}td:first-child{{border:1px solid #222;text-align:center}}.num{{text-align:right}}.total{{font-weight:bold;border-top:1px solid #222}}small{{display:block;margin-top:12px}}@media print{{body{{margin:0}}@page{{size:A4 landscape;margin:10mm}}}}
</style><main><h1>Laporan Penjualan</h1><p>{escape(period)} · Pencapaian dalam ribuan rupiah, termasuk pajak dan net retur</p>
<table><colgroup>{''.join(f'<col style="width:{w}px">' for w in widths)}</colgroup><thead><tr>{table_head}</tr></thead><tbody>{''.join(body)}</tbody><tfoot>{footer}</tfoot></table><small>{escape(notice)}</small></main></html>'''
    (directory / html_name).write_text(html, encoding='utf8')
    return {'fileName': file_name, 'previewFileName': html_name, 'rows': len(rows),
            'totalJumlah': totals[6], 'totalPencapaian': totals[8], 'missingTargets': True,
            'unmappedGroups': unmapped, 'sourceSheet': report_layout('Pak Fahdhar')['source_sheet']}
