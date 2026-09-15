"""Tujuan: Terapkan layout arsip ke workbook hasil tanpa mengubah nilai sumber.
Caller: laporan_harian.write_report_files dan write_to_format_file.
Dependensi: stdlib ZIP/XML UTF-8 standar, laporan_harian_layouts.json (metadata tanpa transaksi).
Main Functions: report_layout, apply_layout (termasuk relasi paket styles/theme).
Side Effects: Baca metadata; tulis ulang XLSX secara atomik di direktori run.
"""
from functools import lru_cache
import json
from pathlib import Path
import re
import zipfile
import xml.etree.ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'


@lru_cache(maxsize=1)
def _layouts():
    return json.loads(Path(__file__).with_name('laporan_harian_layouts.json').read_text(encoding='utf8'))


def report_layout(keyword):
    return _layouts().get(keyword, {})


def apply_layout(path, keyword):
    """Salin font, format tanggal, lebar, tinggi, dan nama sheet dari profil referensi.

    ponytail: profil memakai style header/baris data; laporan detail ini tidak punya subtotal
    berformat khusus. Tambahkan profil baris terpisah bila kontrak laporan memperkenalkannya.
    """
    profile = report_layout(keyword)
    if not profile:
        return
    path = Path(path)
    temp = path.with_suffix('.layout.xlsx')
    try:
        with zipfile.ZipFile(path) as src, zipfile.ZipFile(temp, 'w', zipfile.ZIP_DEFLATED) as dest:
            for entry in src.infolist():
                data = src.read(entry.filename)
                if entry.filename == '[Content_Types].xml':
                    extras = []
                    if b'/xl/styles.xml' not in data:
                        extras.append('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>')
                    if profile.get('theme') and b'/xl/theme/theme1.xml' not in data:
                        extras.append('<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>')
                    pos = data.rfind(b'</')
                    data = data[:pos] + ''.join(extras).encode('utf-8') + data[pos:]
                elif entry.filename == 'xl/_rels/workbook.xml.rels':
                    extras = []
                    for kind, target in [('styles','styles.xml')] + ([('theme','theme/theme1.xml')] if profile.get('theme') else []):
                        if f'/relationships/{kind}"'.encode() not in data:
                            extras.append(f'<Relationship Id="rIdLayout{kind}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/>')
                    pos = data.rfind(b'</')
                    data = data[:pos] + ''.join(extras).encode('utf-8') + data[pos:]
                elif entry.filename == 'xl/styles.xml':
                    data = profile['styles'].encode('utf8')
                elif entry.filename == 'xl/theme/theme1.xml' and profile.get('theme'):
                    data = profile['theme'].encode('utf8')
                else:
                    match = re.fullmatch(r'xl/worksheets/sheet(\d+)\.xml', entry.filename)
                    if match and int(match[1]) <= len(profile['sheets']):
                        sheet = profile['sheets'][int(match[1])-1]
                        root = ET.fromstring(data)
                        body = root.find(f'{{{NS}}}sheetData')
                        for row in body:
                            styles = sheet['styles'][0 if row.attrib.get('r') == '1' else -1]
                            for cell in row:
                                col = re.sub(r'\d', '', cell.attrib['r'])
                                cell.attrib.pop('s', None)
                                if col in styles:
                                    cell.set('s', styles[col])
                        for child in list(root):
                            if child.tag.rsplit('}', 1)[-1] in sheet['metadata']:
                                root.remove(child)
                        # Worksheet schema order: views/format/cols, sheetData, print settings.
                        before = ['sheetViews', 'sheetFormatPr', 'cols']
                        for tag in before:
                            if tag in sheet['metadata']:
                                root.insert(list(root).index(body), ET.fromstring(sheet['metadata'][tag]))
                        for tag in ['printOptions', 'pageMargins', 'pageSetup']:
                            if tag in sheet['metadata']:
                                root.append(ET.fromstring(sheet['metadata'][tag]))
                        data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
                dest.writestr(entry, data)
            if profile.get('theme') and 'xl/theme/theme1.xml' not in src.namelist():
                dest.writestr('xl/theme/theme1.xml', profile['theme'].encode('utf-8'))
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)
