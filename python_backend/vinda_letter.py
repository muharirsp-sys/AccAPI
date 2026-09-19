"""Tujuan: Baca surat "SURAT KESEPAKATAN PROMO" (SKP) PT Vinda International Indonesia
menjadi baris draft Summary, deterministik dan TANPA OCR/LLM (surat ini dicetak dari
Word/Excel, lapisan teksnya utuh).
Caller: dimaksudkan dipasang di ``routers/summary.py`` persis seperti ``kino_extraction``
(dicoba lebih dulu, gagal apa pun -> None supaya jalur OCR tetap jalan). BELUM dipasang di
sana pada commit ini -- lihat catatan di kepala e2e_vinda_sept.py.
Dependensi: pypdf (ekstraksi teks), re/datetime stdlib. Main Functions: parse_pdf, parse_text,
match_items. Side Effects: tidak ada I/O selain membaca PDF di memori; tidak memanggil AI.

KENAPA DETERMINISTIK, BUKAN OCR "SALIN SAJA": dua surat SKP Vinda nyata (September 2026)
punya bentuk yang SANGAT berbeda satu sama lain (satu tabel strata nasional ringkas, satu lagi
lampiran per-distributor dengan barcode+harga per SKU) -- prompt tunggal generik akan gagal
di salah satunya. Karena hanya 2 surat dan pola tekstualnya stabil (dicetak, bukan scan),
regex langsung lebih murah dan lebih bisa diperiksa daripada memaksakan prompt LLM baru.

ATURAN YANG DITEGAKKAN DI SINI
  - ON PO = ON FAKTUR (keputusan pengguna 2026-09-18): surat yang diunggah/diminta ITULAH
    pernyataan on-fakturnya. Kata mekanisme yang tercetak DICATAT sebagai jejak audit
    (``mechanism_printed``, ``on_faktur_printed``) dan TIDAK PERNAH dipakai menyaring baris.
    Surat tanpa kalimat "on faktur" sekalipun tetap menghasilkan baris.
  - FAIL-CLOSED hanya untuk DATA yang memang tidak ada/ambigu:
      * pengecualian SKU tanpa menyebut SKU-nya ("exclude 3 SKU GT") -> baris tetap dibuat
        dengan tingkat diskon yang tercetak, tetapi cakupan barangnya DITAHAN + diberi
        keterangan supaya operator memilih; tidak ditebak.
      * baris produk yang tidak cocok definitif ke SATU barang master (family + ukuran +
        isi/ctn + total lembar) DITAHAN, bukan ditebak dari kecocokan sebagian.
"""
import re
from datetime import date

MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "MEI": 5, "JUN": 6, "JUNI": 6,
          "JUL": 7, "JULI": 7, "AUG": 8, "AGU": 8, "SEP": 9, "SEPT": 9, "OCT": 10, "OKT": 10,
          "NOV": 11, "DEC": 12, "DES": 12}

# "01 Aug 2026 - 30 Sep 2026" / "01 Aug 2026 – 30 Sep 2026"
LONG_RANGE = re.compile(r"(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})")
# "01JUL'26-30SEP'26" (surat pakai tanda kutip lurus atau lengkung, keduanya sah)
COMPACT_RANGE = re.compile(r"(\d{1,2})([A-Za-z]{3,4})['’](\d{2})\s*[-–]\s*(\d{1,2})([A-Za-z]{3,4})['’](\d{2})")

ON_FAKTUR_RE = re.compile(r"\bON\s*[-\s]?\s*(?:FAKTUR|INVOICE)\b", re.I)
NOMOR_SKP_RE = re.compile(r"SURAT\s+KESEPAKATAN\s+PROMO\s*\n?\s*([0-9][0-9A-Za-z/.\-]{5,60})")
DISTRIBUTOR_RE = re.compile(r"Distributor\s*:\s*([^\n]+)", re.I)
AREA_RE = re.compile(r"\bArea\s*:\s*([^\n]+)", re.I)
PERIODE_LABEL_RE = re.compile(r"Periode\s*:\s*([^\n]+)", re.I)
EXCLUDE_UNNAMED_RE = re.compile(r"exclude\s+(\d+)\s+SKU", re.I)
MEKANISME_RE = re.compile(r"Mekanisme\s*:?\s*(.{0,200}?)(?:Periode|Distributor|Kelengkapan|$)", re.I)
# Tabel strata: "1-5 CTN : Disc 10%" dan "10 CTN Up : Disc 15%".
TIER_RANGE_RE = re.compile(r"(\d+)\s*-\s*\d+\s*(CTN|LUSIN|LSN|PCS)\s*:?\s*Disc\.?\s*([\d.,]+)\s*%", re.I)
TIER_UP_RE = re.compile(r"(\d+)\s*(CTN|LUSIN|LSN|PCS)\s*Up\s*:?\s*Disc\.?\s*([\d.,]+)\s*%", re.I)
SCOPE_ALL_RE = re.compile(r"All\s+SKU[^:]{0,40}?exclude\s+\d+\s+SKU\s+\w+", re.I)
SCOPE_SUBSET_RE = re.compile(r"\b\d+\s+SKU\s+GT\b", re.I)
UNIT_CANON = {"LUSIN": "LSN", "LSN": "LSN", "CTN": "CTN", "PCS": "PCS"}

# Baris produk lampiran barcode, mis. "6901236334812 VINDA DELUXE FT SP 3PLY L 16x(2x330PLY) ..."
PRODUCT_LINE_RE = re.compile(
    r"(\d{13})\s+(VINDA\s+(DELUXE|CLASSIC|PRESTIGE)\s+FT\s+\w+\s+\dPLY)\s+([SML])\s+"
    r"(\d+)x\(?(?:(\d+)x)?(\d+)PLY\)?", re.I)
LOCK_VOLUME_RE = re.compile(r"Pembelian\s+(\d+)\s*ctn\s+FREE\s+(\d+)\s*ctn", re.I)


def flatten(text):
    return " ".join(str(text).split())


def month_num(token):
    return MONTHS.get(token.strip().upper()[:4]) or MONTHS.get(token.strip().upper()[:3])


def iso_period(text):
    """Kedua bentuk tanggal surat Vinda -> (start_iso, end_iso), atau ("","") bila tak lengkap."""
    blob = text or ""
    m = LONG_RANGE.search(blob)
    if m:
        d1, mo1, y1, d2, mo2, y2 = m.groups()
        n1, n2 = month_num(mo1), month_num(mo2)
        if n1 and n2:
            return date(int(y1), n1, int(d1)).isoformat(), date(int(y2), n2, int(d2)).isoformat()
    m = COMPACT_RANGE.search(blob)
    if m:
        d1, mo1, y1, d2, mo2, y2 = m.groups()
        n1, n2 = month_num(mo1), month_num(mo2)
        if n1 and n2:
            return date(2000 + int(y1), n1, int(d1)).isoformat(), date(2000 + int(y2), n2, int(d2)).isoformat()
    return "", ""


def _common(text):
    blob = flatten(text)
    # Label "X : nilai" dibaca dari teks MENTAH (baris asli pypdf) supaya `[^\n]+` berhenti di
    # akhir baris sungguhan -- pada `blob` yang sudah diratakan, tanpa `\n`, pola itu akan
    # menelan sisa surat.
    raw = str(text or "")
    nomor = NOMOR_SKP_RE.search(blob)
    dist = DISTRIBUTOR_RE.search(raw)
    area = AREA_RE.search(raw)
    periode_label = PERIODE_LABEL_RE.search(raw)
    start, end = iso_period(flatten(periode_label.group(1)) if periode_label else blob)
    return {
        "surat_program": nomor.group(1).strip() if nomor else "",
        "principle": "VINDA",
        "periode_start": start,
        "periode_end": end,
        "channel_list": area.group(1).strip() if area else "",
        "syarat_claim": "",
        "keterangan": "",
        "kode_barangs": "",
        "source_page": 1,
        "no": "1",
        "_distributor": dist.group(1).strip() if dist else "SEMUA / NASIONAL (surat tidak menyebut satu distributor)",
    }


def _strata_blocks(blob):
    """Tabel strata -> [(label cakupan, [(minimum, satuan, persen, kutipan), ...]), ...].

    Tiap tingkat diikatkan ke label cakupan TERDEKAT DI SEBELUM-nya, supaya blok "All SKU
    ... exclude 3 SKU GT" dan blok "3 SKU GT" tidak tertukar tingkatnya.
    """
    labels = [(m.start(), flatten(m.group(0))) for m in SCOPE_ALL_RE.finditer(blob)]
    ditutupi = [(m.start(), m.end()) for m in SCOPE_ALL_RE.finditer(blob)]
    for m in SCOPE_SUBSET_RE.finditer(blob):
        if not any(a <= m.start() < b for a, b in ditutupi):
            labels.append((m.start(), flatten(m.group(0))))
    labels.sort()

    tiers = []
    for pola in (TIER_RANGE_RE, TIER_UP_RE):
        for m in pola.finditer(blob):
            tiers.append((m.start(), m.group(1), UNIT_CANON.get(m.group(2).upper(), "CTN"),
                          m.group(3).replace(",", "."), flatten(m.group(0))))
    tiers.sort()

    blocks, urut = {}, []
    for pos, minimum, unit, persen, kutipan in tiers:
        sebelum = [(p, teks) for p, teks in labels if p < pos]
        label = sebelum[-1][1] if sebelum else "(cakupan barang tidak tertulis di surat)"
        if label not in blocks:
            blocks[label] = []
            urut.append(label)
        blocks[label].append((minimum, unit, persen, kutipan))
    return [(label, blocks[label]) for label in urut]


def parse_text(text, page_count=1):
    """Surat SKP Vinda -> baris draft Summary + peringatan. Fail-closed: tidak menebak
    mekanisme, SKU yang dikecualikan, atau produk yang tak bisa dicocokkan definitif."""
    blob = flatten(text)
    common = _common(text)
    warnings = []
    rows = []

    # Jejak audit saja. ON PO = ON FAKTUR: ini TIDAK menyaring baris apa pun.
    on_faktur = bool(ON_FAKTUR_RE.search(blob))
    mekanisme = MEKANISME_RE.search(blob)
    mechanism_printed = flatten(mekanisme.group(1))[:200] if mekanisme else ""
    if not on_faktur:
        warnings.append("Catatan audit: surat tidak mencetak kata 'on faktur'/'on invoice'. "
                         "Baris TETAP dibuat -- surat yang diunggah adalah pernyataan on-fakturnya.")

    exclude = EXCLUDE_UNNAMED_RE.search(blob)
    if exclude and not PRODUCT_LINE_RE.search(blob):
        # Bentuk 1: tabel strata % per kelompok SKU. Tingkat diskonnya TERCETAK jelas, jadi
        # barisnya dibuat; yang tidak diketahui hanya CAKUPAN BARANG-nya ("exclude 3 SKU GT"
        # tanpa menamai SKU-nya) -- itu yang ditahan, bukan seluruh suratnya.
        catatan = (f"CAKUPAN BARANG DITAHAN: surat menyebut 'exclude {exclude.group(1)} SKU' tanpa "
                   "menamainya (lampiran tidak ada di berkas ini); pilih kode barang manual.")
        for scope_label, tiers in _strata_blocks(blob):
            for minimum, unit, persen, kutipan in tiers:
                rows.append({**common, "no": str(len(rows) + 1), "kelompok": "", "variant": "",
                             "gramasi": "", "ketentuan": f"Beli {minimum} {unit}",
                             "benefit_type": "DISC_PCT", "benefit": persen,
                             "_scope_text": scope_label, "keterangan": flatten(f"{scope_label}. {catatan}"),
                             "source_quote": kutipan[:300]})
        if not rows:
            warnings.append("Tabel strata diskon tidak terbaca; isi baris manual dari surat.")
        else:
            warnings.append(f"{len(rows)} baris strata diskon dibuat; cakupan barangnya ditahan "
                             f"karena surat menyebut 'exclude {exclude.group(1)} SKU' tanpa menamainya.")
        return {"letter": common, "on_faktur": on_faktur, "mechanism_printed": mechanism_printed,
                "rows": rows, "warnings": warnings, "page_count": page_count, "held_rows": [],
                "mechanism": "STRATA_DISC_PCT_UNNAMED_SKU"}

    bonus = LOCK_VOLUME_RE.search(blob)
    products = list(PRODUCT_LINE_RE.finditer(blob))
    if not products:
        warnings.append("Tidak ada baris produk (barcode+nama+pack) yang terbaca dari surat; "
                         "isi baris manual dari lampiran.")
        return {"letter": common, "on_faktur": on_faktur, "mechanism_printed": mechanism_printed,
                "rows": [], "warnings": warnings, "page_count": page_count, "held_rows": [],
                "mechanism": ""}

    if not bonus:
        warnings.append("Baris produk terbaca tetapi mekanisme benefit (mis. 'Lock Volume') "
                         "tidak terbaca; baris DITAHAN.")

    for match in products:
        barcode, family_text, family, size, isi_ctn, inner_mult, sheets_per_unit = match.groups()
        total_sheets = int(sheets_per_unit) * (int(inner_mult) if inner_mult else 1)
        row = {
            **common, "no": str(len(rows) + 1),
            "kelompok": f"VINDA SOFT PACK - {family.upper()} - FACIAL",
            "variant": size.upper(),
            "gramasi": f"{total_sheets}S",
            "ketentuan": f"Beli {bonus.group(1)} CTN" if bonus else "",
            "benefit_type": "BONUS_QTY" if bonus else "",
            "benefit": f"{bonus.group(2)} CTN" if bonus else "",
            "source_quote": flatten(match.group(0)),
            "_barcode": barcode, "_isi_ctn": isi_ctn,
        }
        rows.append(row)

    for row in rows:  # jejak audit di tiap baris, bukan penyaring
        row["keterangan"] = flatten(f"{row.get('keterangan', '')} "
                                     f"[mekanisme tercetak: {mechanism_printed or '(tidak tercetak)'}]")
    return {"letter": common, "on_faktur": on_faktur, "mechanism_printed": mechanism_printed,
            "rows": rows, "warnings": warnings, "page_count": page_count, "held_rows": [],
            "mechanism": f"BONUS_QTY {bonus.group(1)}+{bonus.group(2)} CTN" if bonus else ""}


def match_items(rows, items, warnings=None):
    """Cocokkan tiap baris ke SATU barang master via (kelompok, variant/ukuran, gramasi=total
    lembar) DAN isi/ctn pada nama barang master -- bukan tebakan substring. Tidak ketemu atau
    ketemu >1 -> DITAHAN (``_vinda_unmatched=True``), tidak pernah dikosongkan diam-diam.

    `warnings` ada supaya tanda tangannya sama dengan dahlia/primarasa dan satu penyambung
    bisa memanggil ketiganya; baris yang ditahan sudah menjelaskan dirinya di `keterangan`,
    jadi di sini ia hanya diringkas.
    """
    by_key = {}
    for it in items:
        by_key.setdefault((it.get("kelompok", ""), it.get("variant", ""), it.get("gramasi", "")), []).append(it)
    for row in rows:
        key = (row.get("kelompok", ""), row.get("variant", ""), row.get("gramasi", ""))
        candidates = by_key.get(key, [])
        isi_ctn = row.pop("_isi_ctn", None)
        if isi_ctn:
            narrowed = [it for it in candidates if f"X {int(isi_ctn)} PCS" in str(it.get("nama_barang", "")).upper()]
            if narrowed:
                candidates = narrowed
        if len(candidates) == 1:
            row["kode_barangs"] = candidates[0]["kode_barang"]
        else:
            row["kode_barangs"] = ""
            row["_vinda_unmatched"] = True
            row["keterangan"] = ("PERLU REVIEW MANUAL -- TIDAK ADA barang master yang cocok definitif"
                                  if not candidates else
                                  f"PERLU REVIEW MANUAL -- {len(candidates)} barang master cocok, ambigu")
    if warnings is not None:
        held = sum(1 for row in rows if row.get("_vinda_unmatched"))
        if held:
            warnings.append(f"{held} baris ditahan: tidak ada barang master yang cocok definitif.")
    return rows


def parse_pdf(raw):
    """Hanya surat berlapis teks (Vinda dicetak dari Word/Excel). Tanpa lapisan teks -> tolak."""
    import pypdf

    reader = pypdf.PdfReader(__import__("io").BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages]
    full_text = "\n".join(pages)
    if len(flatten(pages[0] if pages else "")) < 100:
        raise ValueError("Halaman pertama tidak punya lapisan teks; surat ini mungkin hasil scan, pakai jalur OCR")
    if "SURAT KESEPAKATAN PROMO" not in full_text.upper() and "KESEPAKATAN PROMO" not in full_text.upper():
        raise ValueError("Bukan surat SKP Vinda (header 'SURAT KESEPAKATAN PROMO' tidak ditemukan)")
    result = parse_text(full_text, len(pages))
    return result
