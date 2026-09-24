"""Tujuan: Baca surat promo PT Unitama Sari Mas (master principal DAHLIA: merek Dahlia,
AF Gel/Freshgo, LT Kiriko, Seagull, Blue Clean) menjadi baris draft Summary -- deterministik,
tanpa OCR/LLM (surat dicetak dari Excel, lapisan teksnya utuh).
Caller: dimaksudkan dipasang di `routers/summary.py` seperti `kino_extraction`; BELUM dipasang
(lihat catatan pemasangan di kepala e2e_dahlia_sept.py). Dipakai langsung oleh e2e_dahlia_sept.py.
Dependensi: pypdf, periode_surat.rentang, re/datetime stdlib.
Main Functions: parse_pdf, parse_text, match_items. Side Effects: tidak ada I/O selain membaca
PDF di memori; tidak memanggil AI, tidak menyentuh DB.

TIGA BENTUK SURAT, SATU PRINCIPAL. Empat surat nyata September 2026 memakai tiga tata letak:
  A. "PROMO NASIONAL ..." -- tabel Regional/Group Product/Item/Strata/Disc/ITEM/Suggest HET
     (542-11410 C61 Toko Online, 570-11410 C62 GT Grosir).
  B. "Strata Account" -- matriks kode barang x strata outlet berisi nilai rafaksi (MT Pareto).
  C. "Mekanisme Program" -- grid Grup Produk, target per outlet di lampiran (MT Silver).

ATURAN YANG DITEGAKKAN DI SINI
  - Mekanisme yang tercetak ("Rafraksi", "Consumer Promo GT", "Add. Disc (On faktur)") DICATAT
    sebagai jejak audit di `mechanism_printed`/`keterangan`, TIDAK PERNAH dipakai sebagai
    penyaring. Surat yang diunggah = surat yang diminta = on faktur (keputusan pengguna
    2026-09-18). Yang menahan baris hanyalah DATA yang memang tidak ada.
  - "Disc. Reg Dist" (mis. "8% - 10%") adalah beban DISTRIBUTOR, bukan benefit principal:
    dicatat di `keterangan`, TIDAK pernah jadi `benefit`. Yang jadi benefit hanya
    "Add. Disc (On faktur)" dan "Add. Promo" (bonus barang).
  - FAIL-CLOSED pada data yang benar-benar tidak ada/ambigu: kode yang tidak cocok persis ke
    master, keluarga kode yang bertabrakan dengan baris lain, dan (bentuk B) nilai rafaksi yang
    BERBEDA antar strata outlet -- ditahan + diberi keterangan, tidak pernah ditebak dan tidak
    pernah dijumlahkan.
  - Barang BANDED (token "BND"/"BDD" di nama master) tidak pernah ikut (checklist baris E).
"""
import re
from datetime import date

# --- kosakata angka/tanggal -------------------------------------------------------------
MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "MEI": 5, "JUN": 6, "JUL": 7,
          "AUG": 8, "AGU": 8, "SEP": 9, "OCT": 10, "OKT": 10, "NOV": 11, "DEC": 12, "DES": 12}
# "01-Sep-2026 – 30-Sep-2026"
DASH_RANGE = re.compile(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})\s*[-–]\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})")

HET_LINE = re.compile(r"^(?P<lead>.*?)(?P<code>[A-Z][A-Z0-9][A-Z0-9 \-]{1,18}?)\s{2,}(?P<het>\d{1,3}(?:\.\d{3})+)\s*$")
BARE_CODE = re.compile(r"^\s*(?P<code>[A-Z]{1,3}\d{2,4}[A-Z0-9\-]*)\s*$")
STRATA = re.compile(r"[≥>]=?\s*(\d+)\s*(Lusin|Ctn|Pcs|Dus|Karton|Lsn)", re.I)
DISC_REG = re.compile(r"(\d+(?:[.,]\d+)?)\s*%\s*-\s*(\d+(?:[.,]\d+)?)\s*%")
LONE_PCT = re.compile(r"(?<![-\d])(\d+(?:[.,]\d+)?)\s*%")
BONUS = re.compile(r"(\d+)\s*bonus\s*(\d+)", re.I)
PROPOSAL = re.compile(r"No\.?\s*Proposal\s*:\s*([0-9][^\s]*)", re.I)
PROPOSAL_MT = re.compile(r"NO\.?\s*PROPOSAL\s*:\s*([0-9][^\s]*)", re.I)
PERIODE_PROGRAM = re.compile(r"Periode\s*Program\s*:\s*([A-Za-z]+\s*\d{4})", re.I)
CHANNEL = re.compile(r"Channel\s*:\s*([A-Za-z0-9 ]+?)\s*(?:Nama\s*Distributor|$|\n)", re.I)
BATAS_KLAIM = re.compile(r"BATAS\s*KLAIM\s*:\s*([^\n]+)", re.I)
STRATA_ACCOUNT = re.compile(r"Strata\s+Account\s+(.+)$", re.I | re.M)
UNIT_OF = {"LUSIN": "LSN", "LSN": "LSN", "CTN": "CTN", "KARTON": "CTN", "DUS": "DUS", "PCS": "PCS"}

# Penanda bahwa sel ITEM menunjuk KELUARGA kode, bukan satu kode (dibaca dari teks surat,
# bukan diasumsikan): "K313 Series", "F610 ALL", "SG533 P/W".
FAMILY_MARKS = re.compile(r"\b(SERIES|ALL|P\s*/\s*W)\b", re.I)
# Awalan keluarga yang DITULIS surat, mis. "K313 Series" / "F610 ALL" / "SG533 P/W".
FAMILY_PREFIX = re.compile(r"\b([A-Z]{1,3}\d{2,4}[A-Z]?)\s*(?:SERIES|ALL|P\s*/\s*W)\b", re.I)
BANDED = re.compile(r"\b(BND|BDD)\b", re.I)
# Kolom "Regional" ("Nasional LK") bukan bagian nama kelompok barang.
REGIONAL = re.compile(r"^\s*Nasional(\s+LK)?\s*", re.I)
JENIS_PROGRAM = re.compile(r"Jenis Program\s*:\s*(.{0,80}?)\s*(?:No\.?\s*Proposal|Periode|$)", re.I)


def flatten(text):
    return " ".join(str(text).split())


def norm_code(value):
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def iso_period_month(text):
    """"September 2026" -> ("2026-09-01", "2026-09-30"). Bulan yang disebut utuh adalah
    rentang bulan itu; ini membaca surat, bukan mengarang tanggal."""
    from periode_surat import rentang
    try:
        hasil = rentang(str(text or ""))
    except Exception:
        return "", ""
    if isinstance(hasil, (tuple, list)) and len(hasil) >= 2 and hasil[0] and hasil[1]:
        return str(hasil[0]), str(hasil[1])
    return "", ""


def iso_period_dash(text):
    found = DASH_RANGE.search(str(text or ""))
    if not found:
        return "", ""
    d1, m1, y1, d2, m2, y2 = found.groups()
    n1, n2 = MONTHS.get(m1.upper()), MONTHS.get(m2.upper())
    if not (n1 and n2):
        return "", ""
    return date(int(y1), n1, int(d1)).isoformat(), date(int(y2), n2, int(d2)).isoformat()


def _base_row(head, no):
    return {"no": str(no), "principle": "DAHLIA", "surat_program": head.get("surat_program", ""),
            "nama_program": head.get("nama_program", ""), "channel_gtmt": head.get("channel_gtmt", ""),
            "channel_list": head.get("area", ""), "periode_start": head.get("periode_start", ""),
            "periode_end": head.get("periode_end", ""), "syarat_claim": head.get("syarat_claim", ""),
            "outlet_mode": "all", "outlet_classes": "", "kode_barangs": "", "gramasi": "",
            "variant": "", "source_page": 1, "keterangan": ""}


# =========================================================================================
# BENTUK A -- "PROMO NASIONAL ..." (542 C61 Toko Online, 570 C62 GT Grosir)
# =========================================================================================
def _head_promo_nasional(lines, blob):
    judul = next((flatten(l) for l in lines if l.strip().upper().startswith("PROMO NASIONAL")), "PROMO NASIONAL")
    nomor = PROPOSAL.search(blob)
    periode = PERIODE_PROGRAM.search(blob)
    start, end = iso_period_month(periode.group(1) if periode else "")
    channel = CHANNEL.search(blob)
    area = re.search(r"Area\s*:\s*([A-Za-z0-9 ]+?)\s*Channel", blob, re.I)
    klaim = re.search(r"(Batas klaim[^\n:]*?\d+\s*hari[^\n]*)", blob, re.I)
    return {"surat_program": nomor.group(1).strip() if nomor else "",
            "nama_program": judul, "periode_start": start, "periode_end": end,
            "channel_gtmt": flatten(channel.group(1)).upper() if channel else "",
            "area": flatten(area.group(1)) if area else "",
            "syarat_claim": flatten(klaim.group(1)) if klaim else ""}


def _parse_promo_nasional(lines, blob, page_count):
    head = _head_promo_nasional(lines, blob)
    warnings = []
    if not (head["periode_start"] and head["periode_end"]):
        warnings.append("Periode Program tidak terbaca; isi manual sebelum publikasi.")
    if not head["channel_gtmt"]:
        warnings.append("Channel tidak tercetak di kop; baris ditahan sampai operator mengisinya.")

    # Satu blok benefit (C62) vs banyak blok (C61) dibedakan dari jumlah baris strata.
    strata_hits = [l for l in lines if STRATA.search(l)]
    single_block = len(strata_hits) == 1

    state = {"strata": "", "unit": "PCS", "mix": False, "disc_reg": "", "add_disc": "", "bonus": "",
             "group": ""}
    # Sel ITEM sering terpotong beberapa baris oleh pypdf ("F610 ALL" di baris atas, kode +
    # HET di baris bawah). Penanda keluarga dicari pada jendela baris terakhir, bukan satu baris.
    jendela = []
    if single_block:
        only = strata_hits[0]
        found = STRATA.search(only)
        state["strata"], state["unit"] = found.group(1), UNIT_OF.get(found.group(2).upper(), "PCS")
        state["mix"] = "campur" in only.lower()
        reg = DISC_REG.search(only)
        state["disc_reg"] = f"{reg.group(1)}% - {reg.group(2)}%" if reg else ""
        bonus = BONUS.search(only)
        state["bonus"] = f"{bonus.group(1)}+{bonus.group(2)}" if bonus else ""
        tail = only[reg.end():] if reg else only
        lone = LONE_PCT.search(BONUS.sub(" ", tail))
        state["add_disc"] = lone.group(1) if lone else ""

    rows = []
    for raw_line in lines:
        line = raw_line.rstrip()
        if not line.strip():
            continue
        jendela = (jendela + [flatten(line)])[-3:]
        het = HET_LINE.match(line)
        bare = BARE_CODE.match(line)
        if not single_block:
            found = STRATA.search(line)
            if found:
                state["strata"], state["unit"] = found.group(1), UNIT_OF.get(found.group(2).upper(), "PCS")
                state["mix"] = "campur" in line.lower()
            reg = DISC_REG.search(line)
            if reg:
                # Kelompok diskon baru: nilai "Add." lama TIDAK boleh ikut terbawa ke baris ini.
                state["disc_reg"] = f"{reg.group(1)}% - {reg.group(2)}%"
                state["add_disc"], state["bonus"] = "", ""
            bonus = BONUS.search(line)
            if bonus:
                state["bonus"] = f"{bonus.group(1)}+{bonus.group(2)}"
            segment = line[reg.end():] if reg else line
            if het:
                segment = segment[:segment.find(het.group("code"))] if het.group("code") in segment else segment
            lone = LONE_PCT.search(DISC_REG.sub(" ", BONUS.sub(" ", segment)))
            if lone:
                state["add_disc"] = lone.group(1)
            # Baris teks murni = nama Group Product kolom kiri. DIGANTI, bukan ditumpuk:
            # menumpuknya membuat "Seagull Kamper Toilet Ball" menempel pada baris AF Gel.
            if not het and not bare and not found and not reg and not BONUS.search(line) \
                    and not re.search(r"\d", line) and len(line.strip()) > 3:
                calon = flatten(line)
                if not REGIONAL.fullmatch(calon):
                    state["group"] = REGIONAL.sub("", calon).strip() or state["group"]
        if not (het or bare):
            continue
        code_text = flatten(het.group("code") if het else bare.group("code"))
        if code_text.upper() in ("RBP", "HET", "ITEM", "PCS"):
            continue
        # Nama kelompok: keterangan yang tercetak DI BARIS KODE ITU SENDIRI lebih dipercaya
        # daripada nama Group Product terakhir (mis. "Dahlia Blue Clean BC002 ...").
        # Sel ITEM adalah SATU token. pypdf kadang menulis nama kolom kiri dan kode pada satu
        # baris ("SG535 SG535   13.400"); ambil token terakhir hanya bila ia memang berbentuk
        # kode barang -- kalau bukan ("F601 Reg"), biarkan apa adanya supaya jujur tak cocok.
        bagian = code_text.split()
        if len(bagian) > 1 and re.fullmatch(r"[A-Z]{1,3}\d{2,4}[A-Z0-9\-]*", bagian[-1]):
            code_text = bagian[-1]
        lead = REGIONAL.sub("", flatten(het.group("lead"))).strip() if het else ""
        lead = re.split(r"[≥>]|\d+\s*%", lead)[0].strip(" :-")
        item_label = flatten(f"{lead or state['group']} {code_text}".strip())
        row = _base_row(head, len(rows) + 1)
        mix_note = " (Boleh Campur)" if state["mix"] else ""
        row.update(
            kelompok=item_label,
            ketentuan=(f"Beli {state['strata']} {state['unit']}{mix_note}" if state["strata"] else ""),
            _item_code=code_text,
            _item_text=item_label,
            _context=" | ".join(jendela)[:300],
            source_quote=flatten(line)[:400],
            keterangan=flatten(f"Disc. Reg Dist {state['disc_reg']} = beban distributor, bukan benefit principal."
                                if state["disc_reg"] else ""))
        if state["add_disc"]:
            row.update(benefit_type="DISC_PCT", benefit=state["add_disc"])
        elif state["bonus"]:
            beli, gratis = state["bonus"].split("+")
            row.update(benefit_type="BONUS_QTY", benefit=f"{gratis} {state['unit']}",
                       ketentuan=f"Beli {beli} {state['unit']}{mix_note}")
        else:
            row.update(benefit_type="", benefit="")
            row["keterangan"] = flatten(row["keterangan"] + " Benefit on-faktur tidak tercetak untuk baris ini; ditahan.")
        rows.append(row)
        # Baris yang punya DUA benefit (add disc % DAN bonus barang) ditulis dua baris supaya
        # keduanya terbawa; compile_programs menyatukannya kembali jadi satu tier.
        if state["add_disc"] and state["bonus"]:
            beli, gratis = state["bonus"].split("+")
            extra = dict(row)
            extra.update(no=str(len(rows) + 1), benefit_type="BONUS_QTY", benefit=f"{gratis} {state['unit']}",
                         ketentuan=f"Beli {beli} {state['unit']}{mix_note}")
            rows.append(extra)
    if not rows:
        warnings.append("Tidak ada baris ITEM yang terbaca dari tabel surat.")
    return {"format": "PROMO_NASIONAL", "letter": head, "rows": rows, "warnings": warnings,
            "page_count": page_count,
            "mechanism_printed": flatten(JENIS_PROGRAM.search(blob).group(1)) if JENIS_PROGRAM.search(blob) else ""}


# =========================================================================================
# BENTUK B -- matriks "Strata Account" x kode barang (MT Pareto): nilai rafaksi per strata
# =========================================================================================
def _parse_strata_matrix(lines, blob, page_count):
    judul = flatten(lines[0]) if lines else "PROMO NASIONAL MT"
    nomor = PROPOSAL_MT.search(blob)
    start, end = iso_period_dash(blob)
    channel = re.search(r"CHANNEL\s*:\s*([^\n]+)", blob, re.I)
    klaim = BATAS_KLAIM.search(blob)
    jenis = re.search(r"JENIS\s*PROGRAM\s*:\s*([^\n]+)", blob, re.I)
    head = {"surat_program": nomor.group(1).strip() if nomor else "", "nama_program": judul,
            "periode_start": start, "periode_end": end,
            "channel_gtmt": flatten(channel.group(1)).upper() if channel else "",
            "area": "", "syarat_claim": ("Batas klaim " + flatten(klaim.group(1))) if klaim else ""}
    warnings = []

    header = STRATA_ACCOUNT.search(blob)
    if not header:
        return {"format": "STRATA_MATRIX", "letter": head, "rows": [], "page_count": page_count,
                "warnings": ["Baris header 'Strata Account' tidak ditemukan; tabel tidak dibaca."],
                "mechanism_printed": flatten(jenis.group(1)) if jenis else ""}
    codes = [c for c in header.group(1).split() if re.fullmatch(r"[A-Z]{1,3}\d{2,4}[A-Z0-9\-]*", c)]

    per_code = {c: {} for c in codes}
    for line in lines:
        text = line.strip()
        if not text or "(" in text or text.lower().startswith("strata account"):
            continue
        numbers = re.findall(r"\b\d{1,3}(?:\.\d{3})+\b|\b\d+\b", text)
        if len(numbers) != len(codes) or not codes:
            continue
        label = flatten(text[:text.find(numbers[0])]).strip()
        if not label or re.search(r"\d", label):
            continue
        for code, amount in zip(codes, numbers):
            per_code[code][label] = amount.replace(".", "")
    if not any(per_code.values()):
        warnings.append("Header kode terbaca tetapi tidak ada baris strata yang jumlah angkanya cocok; "
                        f"tabel ditahan ({len(codes)} kode).")

    rows = []
    for code in codes:
        by_strata = per_code.get(code) or {}
        row = _base_row(head, len(rows) + 1)
        detail = "; ".join(f"{k}={v}" for k, v in by_strata.items())
        # `_exact_item`: kolom matriks adalah SATU barang, bukan wakil keluarganya (lihat
        # `match_items`). Surat 083 menyebut K31GJ dan K31SF tetapi TIDAK K31CV/K31GL; tanpa
        # penanda ini pemekaran "ALL VARIANT" hilir memberi rafaksi kepada keduanya.
        row.update(kelompok=code, _item_code=code, _item_text=code, _exact_item=True,
                   ketentuan="Tidak ada minimum pembelian",
                   source_quote=f"Strata Account {code}: {detail}"[:400])
        nilai = set(by_strata.values())
        if len(nilai) == 1:
            row.update(benefit_type="DISC_RP", benefit=nilai.pop(),
                       keterangan=flatten(f"Rafaksi per pcs, sama untuk semua strata outlet ({detail})."))
        else:
            row.update(benefit_type="", benefit="",
                       keterangan=flatten("DITAHAN: nilai rafaksi BERBEDA antar strata outlet "
                                           f"({detail}); model baris belum bisa menyatakan strata outlet MT, "
                                           "pilih nilainya secara manual."))
            warnings.append(f"{code}: nilai rafaksi beda antar strata outlet ({detail}); ditahan, tidak dijumlahkan.")
        rows.append(row)
    return {"format": "STRATA_MATRIX", "letter": head, "rows": rows, "warnings": warnings,
            "page_count": page_count, "mechanism_printed": flatten(jenis.group(1)) if jenis else ""}


# =========================================================================================
# BENTUK C -- grid "Mekanisme Program" tanpa kode barang (MT Silver)
# =========================================================================================
GROUP_ROW = re.compile(r"^\s*(\d{1,2})\s+([A-Za-z][A-Za-z0-9 .\-/()]{3,60}?)\s*(?:\*|$)")
# Kode barang yang DITULIS surat: "(F617TK)" pada nama grup, "WAJIB ada item K316EU", dan
# kepala lampiran per outlet ("F601AD F601TK", "LT122N LT123").
KODE_SURAT = re.compile(r"\b([A-Z]{1,3}\d{2,4}[A-Z0-9]*(?:-[A-Z0-9]+)?)\b")
ADD_DISC = re.compile(r"%\s+(\d+(?:[.,]\d+)?)\s+-\s+-\s*$")
KODE_OUTLET = re.compile(r"\{\s*C-\s*([A-Z0-9]+)\s*\}")
LAMPIRAN = "DETAIL ITEM PER DISTRIBUTOR"


def _kutip_kode(codes):
    """`kode 'X'` per kode: bentuk yang dibaca sidecar Form (`kode_ditahan`) dan gerbang C9/C10."""
    return ", ".join(f"kode '{c}'" for c in codes)


def _parse_grup_produk(lines, blob, page_count):
    """Bentuk C: tiap baris "Mekanisme Program" satu baris Summary, SEMUANYA DITAHAN.

    Minimum qty dan bonusnya ditetapkan PER OUTLET di lampiran ("Detail Item per Distributor /
    Account": BENTENG BARU 72 pcs F601TK bonus 6, TOP MURAH 24 bonus 2, ...). Model baris belum
    bisa menyatakan target per outlet, dan menerbitkan "12 bonus 1" untuk semua outlet MT Pareto
    berarti memberi bonus kepada outlet yang tidak disebut surat -- jadi tidak ada yang diterbitkan.

    Yang TIDAK boleh hilang adalah isi suratnya: tiap grup membawa manfaat yang tertulis, kode
    yang disebut surat untuk grup itu, dan daftar outlet lampiran; kode yang hanya disebut di
    kepala lampiran dicatat pada satu baris lampiran. Sampai 24 September 2026 keenam grup
    melebur jadi SATU baris tanpa satu kode pun (lihat `summary_store.append_rows`), dan gerbang
    lama meloloskannya karena kode-kode itu kebetulan tercetak di baris surat lain.
    """
    judul = flatten(lines[0]) if lines else "PROMO NASIONAL MT SILVER"
    nomor = PROPOSAL_MT.search(blob)
    start, end = iso_period_dash(blob)
    channel = re.search(r"CHANNEL\s*:\s*([^\n]+)", blob, re.I)
    klaim = BATAS_KLAIM.search(blob)
    jenis = re.search(r"JENIS\s*PROGRAM\s*:\s*([^\n]+)", blob, re.I)
    head = {"surat_program": nomor.group(1).strip() if nomor else "", "nama_program": judul,
            "periode_start": start, "periode_end": end,
            "channel_gtmt": flatten(channel.group(1)).upper() if channel else "",
            "area": "", "syarat_claim": ("Batas klaim " + flatten(klaim.group(1))) if klaim else ""}

    upper_lines = [line.upper() for line in lines]
    batas = next((i for i, line in enumerate(upper_lines) if LAMPIRAN in line), len(lines))
    outlets = sorted(set(KODE_OUTLET.findall(re.sub(r"\s+", "", blob.upper()))))
    catatan_outlet = (f" Berlaku hanya untuk outlet lampiran: {', '.join('C-' + o for o in outlets)}."
                      if outlets else "")

    # Grup dan baris-baris sesudahnya (sampai grup berikutnya / lampiran) -- di situlah manfaat,
    # "(Boleh Campur ...)", dan "WAJIB ada item ..." milik grup itu tercetak.
    groups = []
    for index, line in enumerate(lines[:batas]):
        found = GROUP_ROW.match(line)
        if not found:
            continue
        nama = flatten(found.group(2))
        if len(nama) < 4 or nama.lower().startswith(("melampirkan", "distributor", "program", "wajib", "faktur")):
            continue
        groups.append((index, nama))

    rows, warnings, disebut = [], [], set()
    for position, (index, nama) in enumerate(groups):
        akhir = groups[position + 1][0] if position + 1 < len(groups) else batas
        blok = [flatten(line) for line in lines[index:akhir]]
        teks = " ".join(blok)
        kode = list(dict.fromkeys(KODE_SURAT.findall(teks.upper())))
        disebut.update(kode)
        manfaat = [flatten(f"{m.group(1)} bonus {m.group(2)}") for m in BONUS.finditer(teks)]
        add = ADD_DISC.search(" ".join(blok[-2:]))
        if add:
            manfaat.append(f"Add. Disc (On Faktur) {add.group(1)} (satuannya tidak tertulis)")
        reg = DISC_REG.search(teks)
        campur = re.search(r"\((Tidak\s+Boleh\s+Campur|Boleh\s+Campur)[^)]*\)", teks, re.I)
        row = _base_row(head, len(rows) + 1)
        # Kelompok DIKOSONGKAN: nama grup surat ("AF Gel - Heritage") bukan kelompok master, dan
        # memilih kelompoknya berarti memilih barang yang dapat promo. Namanya ada di keterangan.
        row.update(kelompok="", _item_code="", _item_text=nama,
                   ketentuan="Sesuai Min. Qty Pembelian terlampir (per outlet)", benefit_type="", benefit="",
                   source_quote=flatten(" ".join(blok[:3]))[:400],
                   keterangan=flatten(
                       f"DITAHAN: grup {nama}, min. qty dan bonus PER OUTLET di lampiran -- pilih kelompok "
                       "+ kode manual."
                       + (f" Tertulis: {'; '.join(manfaat)}." if manfaat else "")
                       + (f" {campur.group(0)}." if campur else "")
                       + (f" Disc. Reg Dist {reg.group(0)} = beban distributor, bukan benefit principal." if reg else "")
                       + (f" Surat menyebut {_kutip_kode(kode)}." if kode else "")
                       + catatan_outlet))
        rows.append(row)

    # Kepala lampiran menyebut kode per kolom grup ("F601AD F601TK", "LT122N LT123"). Kolomnya
    # tidak bisa dipasangkan ke grup tanpa menebak tata letak, jadi kode yang belum disebut grup
    # mana pun dicatat pada SATU baris lampiran -- tercetak, bukan hilang.
    lampiran = []
    for line in lines[batas:]:
        for code in KODE_SURAT.findall(line.upper()):
            if code not in outlets and code not in disebut and code not in lampiran:
                lampiran.append(code)
    if lampiran:
        row = _base_row(head, len(rows) + 1)
        row.update(kelompok="", _item_code="", _item_text="", ketentuan="Sesuai Min. Qty Pembelian terlampir (per outlet)",
                   benefit_type="", benefit="",
                   source_quote=flatten(f"Detail Item per Distributor / Account: {' '.join(lampiran)}")[:400],
                   keterangan=flatten(
                       f"DITAHAN: lampiran per outlet menyebut {_kutip_kode(lampiran)} beserta min. qty dan bonus "
                       "PER OUTLET; kolomnya per grup produk, pasangkan ke grupnya secara manual." + catatan_outlet))
        rows.append(row)
    if rows:
        warnings.append(f"{len(groups)} grup produk bertarget per outlet; semua ditahan untuk dipilih operator.")
    return {"format": "GRUP_PRODUK", "letter": head, "rows": rows, "warnings": warnings,
            "page_count": page_count, "mechanism_printed": flatten(jenis.group(1)) if jenis else ""}


# =========================================================================================
def parse_text(text, page_count=1):
    lines = str(text or "").splitlines()
    blob = str(text or "")
    upper = blob.upper()
    if "STRATA ACCOUNT" in upper:
        result = _parse_strata_matrix(lines, blob, page_count)
    elif "MEKANISME PROGRAM" in upper and "GRUP PRODUK" in upper:
        result = _parse_grup_produk(lines, blob, page_count)
    else:
        result = _parse_promo_nasional(lines, blob, page_count)
    # Jejak audit: mekanisme yang tercetak DICATAT, tidak dipakai menyaring baris.
    if result.get("mechanism_printed"):
        for row in result["rows"]:
            row["keterangan"] = flatten(f"{row.get('keterangan', '')} "
                                         f"[mekanisme tercetak: {result['mechanism_printed']}]")
    return result


def match_items(rows, items, warnings=None):
    """Kode ITEM surat -> kode master, lewat token pertama `nama_barang` master.

    Cocok persis menang. Sel yang menyebut KELUARGA ("K313 Series", "F610 ALL", "SG533 P/W")
    memakai awalan kode, DIKURANGI kode yang sudah diklaim baris lain pada surat yang sama
    (aturan checklist baris P), dan barang BANDED selalu dibuang. Selain itu: DITAHAN.
    """
    catalog = []
    for it in items:
        nama = str(it.get("nama_barang", "") or "")
        token = nama.split()[0] if nama.split() else ""
        if not token:
            continue
        catalog.append({"token": token, "norm": norm_code(token), "banded": bool(BANDED.search(nama)), "item": it})
    exact = {}
    for entry in catalog:
        exact.setdefault(entry["norm"], []).append(entry)

    # "Diklaim baris lain" dihitung PER SURAT (checklist baris P: kelompok yang sama DI SURAT
    # YANG SAMA) -- kode yang dipakai surat lain tidak boleh mengurangi cakupan surat ini.
    claimed = {}
    for row in rows:
        surat = str(row.get("surat_program", ""))
        hit = exact.get(norm_code(row.get("_item_code", "")))
        if hit and not all(e["banded"] for e in hit):
            claimed.setdefault(surat, set()).update(e["norm"] for e in hit if not e["banded"])

    for row in rows:
        code_text = str(row.get("_item_code", "") or "")
        key = norm_code(code_text)
        milik_surat = claimed.get(str(row.get("surat_program", "")), set())
        row.pop("_item_code", None)
        exact_item = bool(row.pop("_exact_item", False))
        item_text = str(row.pop("_item_text", "") or "")
        context = str(row.pop("_context", "") or "")
        if not key:
            row["kode_barangs"] = ""
            row["_dahlia_unmatched"] = True
            continue
        # Kata "Series"/"ALL"/"P/W" tercetak di BARIS surat, bukan di sel kode -- jadi penanda
        # keluarga dicari pada kutipan baris itu, bukan hanya pada label kelompok.
        family_text = f"{item_text} {context} {row.get('source_quote', '')}"
        # Awalan keluarga yang DITULIS surat: "K313 Series", "F610 ALL", "SG533 P/W".
        stated = FAMILY_PREFIX.search(family_text)
        prefix = norm_code(stated.group(1)) if stated else key

        def _kin(awalan):
            return [e for e in catalog
                    if e["norm"].startswith(awalan) and e["norm"] != key and not e["banded"]
                    and e["norm"] not in milik_surat]

        hit = [e for e in exact.get(key, []) if not e["banded"]]
        if hit:
            row["kode_barangs"] = ",".join(sorted({e["item"]["kode_barang"] for e in hit}))
            if exact_item:
                # Kelompok, varian, dan gramasi MASTER barang itu sendiri. Hanya kolom yang
                # tersimpan di draft yang bertahan sampai Form dibuat, dan hanya varian yang
                # BUKAN "ALL VARIANT" yang mencegah pemekaran se-kelompok -- penanda lain hilang
                # di `BARIS_DRAFT`. Satu nilai saja; nilai ganda dibiarkan, dan kodenya tetap.
                for field in ("kelompok", "variant", "gramasi"):
                    nilai = {str(e["item"].get(field, "") or "").strip() for e in hit} - {""}
                    if len(nilai) == 1:
                        row[field] = nilai.pop()
                continue
            # Kode persis ADA, tetapi surat menyebut KELUARGA ("SG533 P/W", "K31 Series").
            # Tidak diperluas diam-diam (bisa over-claim) dan tidak didiamkan (bisa
            # under-claim): saudara kodenya DITULIS supaya operator memutuskan.
            siblings = _kin(prefix) if stated else []
            if siblings:
                row["_dahlia_family_question"] = True
                row["keterangan"] = flatten(
                    f"{row.get('keterangan','')} PERIKSA CAKUPAN: surat menulis keluarga "
                    f"'{flatten(stated.group(0))}'; selain {code_text} master juga punya "
                    f"{', '.join(sorted(e['token'] for e in siblings))} -- BELUM diikutkan, putuskan manual.")
            continue
        if stated:
            family = _kin(prefix)
            if family:
                row["kode_barangs"] = ",".join(sorted({e["item"]["kode_barang"] for e in family}))
                row["keterangan"] = flatten(f"{row.get('keterangan','')} Keluarga kode '{code_text}' "
                                             f"({len(family)} barang: {', '.join(sorted(e['token'] for e in family))}) "
                                             "dibaca dari kata 'Series/ALL/P-W' di surat, dikurangi kode yang "
                                             "diklaim baris lain.")
                continue
        row["kode_barangs"] = ""
        row["_dahlia_unmatched"] = True
        row["keterangan"] = flatten(f"{row.get('keterangan','')} PERLU REVIEW MANUAL -- kode '{code_text}' "
                                     "tidak ada padanan persis di master (dan surat tidak menyatakannya "
                                     "sebagai keluarga kode); tidak ditebak.")
        if warnings is not None:
            warnings.append(f"kode '{code_text}' tidak cocok ke master; baris ditahan.")
    return rows


def parse_pdf(raw):
    """Hanya surat berlapis teks. Tanpa lapisan teks -> tolak, jangan diam-diam kosong."""
    import pypdf

    reader = pypdf.PdfReader(__import__("io").BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages]
    if len(flatten(pages[0] if pages else "")) < 100:
        raise ValueError("Halaman pertama tidak punya lapisan teks; pakai jalur OCR")
    return parse_text("\n".join(pages), len(pages))
