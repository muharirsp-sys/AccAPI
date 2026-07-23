"""Tujuan: Adapter RapidOCR untuk eksperimen OCR Summary Program.

Caller: ``routers.summary.summary_manual_parse_pdf_ai`` saat model eksplisit
``rapidocr``; bukan default produksi. Dependensi: PyMuPDF, RapidOCR ONNX, dan
whitelist gramasi master. Main Functions: ``build_gramasi_whitelist``,
``normalize_text``, ``reconstruct_layout``, ``ocr_pdf_to_text``. Side Effects:
render PDF ke PNG temporer, menjalankan inferensi CPU, lalu menghapus PNG.

Koordinat OCR direkonstruksi menjadi baris biasa atau tabel berpipa. Tabel
dideteksi dari header Channel/Barcode/Nama Produk/Min Order/Diskon; setiap
record ditambatkan ke koordinat barcode agar sel gabungan dan teks bertumpuk
tidak menggeser produk ke record tetangga. Normalisasi O/o -> 0 hanya berlaku
ketika O menempel digit. Koreksi digit sisipan hanya memakai kandidat unik dari
whitelist gramasi master; kasus ambigu dibiarkan untuk fail-safe downstream.
"""
import os
import re
import tempfile

_NUM_UNIT = re.compile(r"(\d{2,4})(\s*)(ML|GR|G)\b")


def build_gramasi_whitelist(master_items) -> set:
    """Kumpulkan semua angka gramasi valid (dgn satuan ML/GR/G) dari kolom
    'gramasi' master barang principle. dict-items ATAU objek apa pun dgn
    key/attr 'gramasi' diterima."""
    valid = set()
    for it in master_items or []:
        g = str((it.get("gramasi") if isinstance(it, dict) else getattr(it, "gramasi", "")) or "")
        for m in _NUM_UNIT.finditer(g.upper()):
            valid.add(int(m.group(1)))
    return valid


def correct_gramasi_digits(text: str, valid_sizes: set) -> str:
    """Kalau angka+satuan gramasi TIDAK ada di valid_sizes, coba hapus SATU
    digit -- kalau hasilnya ADA & UNIK di valid_sizes, ganti (pola salah-sisip-
    digit terbukti live: '900ML'->'90ML', '800ML'->'80ML'). Ambigu (>1 kandidat
    valid) atau tak ada whitelist -> biarkan apa adanya (aman, tak menebak)."""
    if not valid_sizes:
        return text

    def _fix(m):
        num, sep, unit = m.group(1), m.group(2), m.group(3)
        if int(num) in valid_sizes or len(num) < 3:
            return m.group(0)
        candidates = {num[:i] + num[i + 1:] for i in range(len(num))}
        candidates = {c for c in candidates if c and not c.startswith("0") and int(c) in valid_sizes}
        if len(candidates) == 1:
            return candidates.pop() + sep + unit
        return m.group(0)

    return _NUM_UNIT.sub(_fix, text)

_ENGINE = None


def _engine():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR
        _ENGINE = RapidOCR()
    return _ENGINE


_ADJ_DIGIT_O = re.compile(r"(?<=\d)[Oo]|[Oo](?=\d)")


def normalize_text(text: str) -> str:
    """O/o -> 0 HANYA bila menempel digit (gramasi salah baca '15OML'->'150ML',
    '8OML'->'80ML'). Nama produk yg ter-glue TANPA digit menempel ('SMOOTH',
    'OLIVEOIL', 'ALOEVERA') TAK tersentuh. Jalankan 2x utk run '1OO'->'100'."""
    prev = None
    while prev != text:
        prev = text
        text = _ADJ_DIGIT_O.sub("0", text)
    return text


def _layout_items(boxes):
    items = []
    for box, txt, _score in boxes:
        ys = [float(p[1]) for p in box]
        xs = [float(p[0]) for p in box]
        text = normalize_text(str(txt).strip())
        if text:
            items.append({"yc": sum(ys) / len(ys), "xl": min(xs), "xr": max(xs),
                          "y0": min(ys), "y1": max(ys), "h": max(ys) - min(ys),
                          "txt": text})
    return items


def _cluster_rows(items, threshold):
    """Kelompokkan kotak yang pusat vertikalnya sejajar; overlap koordinat
    dipakai sebagai pengaman untuk font/tinggi kotak yang berbeda."""
    if not items:
        return []
    rows = []
    for item in sorted(items, key=lambda it: (it["yc"], it["xl"])):
        best = None
        for row in rows[-3:]:
            overlap = max(0.0, min(row["y1"], item["y1"]) - max(row["y0"], item["y0"]))
            min_h = max(1.0, min(row["h"], item["h"]))
            if abs(item["yc"] - row["yc"]) <= threshold or overlap / min_h >= 0.35:
                best = row
        if best is None:
            rows.append({"items": [item], "yc": item["yc"], "y0": item["y0"],
                         "y1": item["y1"], "h": max(item["h"], 1.0)})
            continue
        best["items"].append(item)
        best["yc"] = sum(it["yc"] for it in best["items"]) / len(best["items"])
        best["y0"] = min(it["y0"] for it in best["items"])
        best["y1"] = max(it["y1"] for it in best["items"])
        best["h"] = best["y1"] - best["y0"]
    for row in rows:
        row["items"].sort(key=lambda it: it["xl"])
    return rows


def _header_kind(text):
    compact = re.sub(r"[^A-Z]", "", text.upper())
    if "CHANNEL" in compact:
        return "CHANNEL"
    if "BARCODE" in compact:
        return "BARCODE"
    if "NAMAPRODUK" in compact:
        return "NAMA PRODUK"
    if "MINORDER" in compact:
        return "MIN ORDER"
    if "DISKON" in compact and ("FAKTUR" in compact or "INVOICE" in compact):
        return "DISKON"
    return None


def _barcode_like(text):
    digits = re.sub(r"\D", "", text)
    return 10 <= len(digits) <= 16


def _render_plain(rows):
    return ["  ".join(it["txt"] for it in row["items"]) for row in rows]


def _render_table(items, rows, header_index, header_cells, med_h):
    """Render satu tabel berdasarkan pusat-x header dan pusat-y barcode.

    Barcode adalah anchor record karena nama/benefit/min-order dapat berupa sel
    gabungan atau wrapped. Kotak lain ditempelkan ke anchor-y terdekat, lalu ke
    kolom dengan pusat-x terdekat. Ini mempertahankan struktur tanpa menebak
    karakter atau menciptakan record baru.
    """
    ordered = sorted(header_cells.items(), key=lambda pair: pair[1])
    names = [name for name, _center in ordered]
    centers = [center for _name, center in ordered]
    header_bottom = rows[header_index]["y1"]
    after = [it for it in items if it["yc"] > header_bottom + med_h * 0.25]
    anchors = sorted({it["yc"] for it in after if _barcode_like(it["txt"])})
    if len(anchors) < 2:
        return None

    # Hentikan tabel sesudah barcode terakhir; paragraf lanjutan tidak boleh
    # tersedot hanya karena pusat-x kebetulan berada di kolom Barcode.
    table_end = anchors[-1] + med_h * 1.75
    table_items = [it for it in after if it["yc"] <= table_end]
    grid = [[[] for _ in names] for _ in anchors]
    for item in table_items:
        row_i = min(range(len(anchors)), key=lambda i: abs(item["yc"] - anchors[i]))
        if abs(item["yc"] - anchors[row_i]) > med_h * 2.25:
            continue
        xc = (item["xl"] + item["xr"]) / 2.0
        col_i = min(range(len(centers)), key=lambda i: abs(xc - centers[i]))
        grid[row_i][col_i].append(item)

    # Sel Min Order/Diskon sering di-merge vertikal: OCR hanya memberi kotak
    # pada pusat sel, bukan pada setiap SKU yang dicakup. Isi baris kosong dari
    # anchor-y terdekat di kolom yang sama. ponytail: khusus dua kolom mekanisme;
    # jangan propagasikan nama/barcode/channel karena itu dapat mencipta SKU atau
    # memindahkan channel lintas grup bila layout punya beberapa blok.
    for merge_name in ("MIN ORDER", "DISKON"):
        if merge_name not in names:
            continue
        col_i = names.index(merge_name)
        sources = [i for i, cells in enumerate(grid) if cells[col_i]]
        for row_i, cells in enumerate(grid):
            if not cells[col_i] and sources:
                nearest = min(sources, key=lambda i: abs(anchors[row_i] - anchors[i]))
                cells[col_i] = list(grid[nearest][col_i])

    output = ["| " + " | ".join(names) + " |"]
    for cells in grid:
        values = []
        for cell in cells:
            cell.sort(key=lambda it: (it["yc"], it["xl"]))
            values.append(" ".join(it["txt"] for it in cell))
        output.append("| " + " | ".join(values) + " |")

    before = rows[:header_index]
    after_rows = [row for row in rows[header_index + 1:] if row["yc"] > table_end]
    return _render_plain(before) + output + _render_plain(after_rows)


def reconstruct_layout(boxes) -> str:
    """Rekonstruksi koordinat RapidOCR ke teks dengan tabel berpipa bila
    minimal empat header tabel promo dikenali; selain itu fallback ke baris."""
    items = _layout_items(boxes)
    if not items:
        return ""
    heights = sorted(it["h"] for it in items)
    med_h = heights[len(heights) // 2] or 1.0
    rows = _cluster_rows(items, 0.55 * med_h)
    for index, row in enumerate(rows):
        cells = {}
        for item in row["items"]:
            kind = _header_kind(item["txt"])
            if kind:
                cells[kind] = (item["xl"] + item["xr"]) / 2.0
        required = {"CHANNEL", "BARCODE", "NAMA PRODUK"}
        if required.issubset(cells) and len(cells) >= 4:
            rendered = _render_table(items, rows, index, cells, med_h)
            if rendered is not None:
                return "\n".join(rendered)
    return "\n".join(_render_plain(rows))


def ocr_pdf_to_text(file_bytes: bytes, max_pages: int = 40, valid_gramasi: set = None) -> str:
    """Return teks OCR seluruh halaman, format `--- HALAMAN N ---\\n<teks>`.
    valid_gramasi: whitelist angka gramasi master (dari build_gramasi_whitelist) --
    dipakai koreksi salah-sisip-digit sebelum teks diserahkan ke parser."""
    import fitz
    eng = _engine()
    chunks = []
    with fitz.open(stream=file_bytes, filetype="pdf") as doc:
        for _i, page in enumerate(doc[:max_pages]):
            pix = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0))  # 3x DPI, sesuai probe
            fd, path = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            try:
                pix.save(path)
                res, _ = eng(path)
                page_text = reconstruct_layout(res) if res else ""
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass
            if valid_gramasi:
                page_text = correct_gramasi_digits(page_text, valid_gramasi)
            chunks.append(f"--- HALAMAN {_i + 1} ---\n{page_text}")
    return "\n\n".join(chunks)


if __name__ == "__main__":
    # normalisasi digit: O menempel digit -> 0; O di dalam kata (tanpa digit) tetap O
    assert normalize_text("15OML") == "150ML", normalize_text("15OML")
    assert normalize_text("8OML") == "80ML"
    assert normalize_text("OLIVEOIL") == "OLIVEOIL"          # tanpa digit menempel
    assert normalize_text("AZALEASMOOTHFOOTCREAM35GR") == "AZALEASMOOTHFOOTCREAM35GR"
    assert normalize_text("NATUR OLIVEOIL 8OML") == "NATUR OLIVEOIL 80ML"
    # rekonstruksi 2 baris (y beda jauh), urut x dalam baris
    boxes = [
        [[[100, 50], [140, 50], [140, 70], [100, 70]], "150ML", 0.9],   # baris1 kanan
        [[[10, 52], [90, 52], [90, 72], [10, 72]], "AZALEA", 0.9],       # baris1 kiri
        [[[10, 200], [90, 200], [90, 220], [10, 220]], "NATUR", 0.9],    # baris2
    ]
    r = reconstruct_layout(boxes)
    assert r == "AZALEA  150ML\nNATUR", repr(r)

    # tabel: urutan input acak, O->0 hanya pada sel numerik, paragraf setelah
    # barcode terakhir tetap di luar tabel.
    table_boxes = [
        [[[300, 10], [380, 10], [380, 30], [300, 30]], "Barcode", .9],
        [[[100, 10], [180, 10], [180, 30], [100, 30]], "Channel", .9],
        [[[500, 10], [640, 10], [640, 30], [500, 30]], "Nama Produk", .9],
        [[[720, 10], [820, 10], [820, 30], [720, 30]], "Min Order", .9],
        [[[900, 10], [1020, 10], [1020, 30], [900, 30]], "Diskon On Faktur", .9],
        [[[300, 50], [400, 50], [400, 70], [300, 70]], "899 0000 000001", .9],
        [[[500, 50], [690, 50], [690, 70], [500, 70]], "NATUR ALOE 8OML", .9],
        [[[720, 50], [800, 50], [800, 70], [720, 70]], ">=12", .9],
        [[[300, 90], [400, 90], [400, 110], [300, 110]], "899 0000 000002", .9],
        [[[500, 90], [690, 90], [690, 110], [500, 110]], "NATUR OLIVEOIL", .9],
        [[[100, 130], [600, 130], [600, 150], [100, 150]], "Catatan sesudah tabel", .9],
    ]
    table = reconstruct_layout(table_boxes)
    assert "| CHANNEL | BARCODE | NAMA PRODUK | MIN ORDER | DISKON |" in table, table
    assert "NATUR ALOE 80ML" in table and "NATUR OLIVEOIL" in table, table
    assert "|  | 899 0000 000002 | NATUR OLIVEOIL | >=12 |  |" in table, table
    assert table.rstrip().endswith("Catatan sesudah tabel"), table

    # koreksi salah-sisip-digit: whitelist dari gramasi master (bukan tebakan buta)
    wl = build_gramasi_whitelist([{"gramasi": "150ML"}, {"gramasi": "24 PCS X 90ML"},
                                   {"gramasi": "80ML"}])
    assert wl == {150, 90, 80}, wl
    assert correct_gramasi_digits("NATUR HAIR TONIC GINSENG 900 ML", wl) == \
        "NATUR HAIR TONIC GINSENG 90 ML"
    assert correct_gramasi_digits("NATUR HAIR VIT ALOVERA VIT B5 800ML", wl) == \
        "NATUR HAIR VIT ALOVERA VIT B5 80ML"
    # sudah valid -> tak disentuh; ambigu (0 atau >1 kandidat valid) -> dibiarkan
    assert correct_gramasi_digits("AZALEA 150ML", wl) == "AZALEA 150ML"
    assert correct_gramasi_digits("PRODUK ANEH 999ML", wl) == "PRODUK ANEH 999ML"
    assert correct_gramasi_digits("APAPUN 900ML", set()) == "APAPUN 900ML"  # tanpa whitelist = no-op
    print("PASSED")
