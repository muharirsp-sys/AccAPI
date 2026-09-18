"""Tujuan: Baca surat program Kino berlapis teks menjadi baris draft Summary, tanpa OCR.
Caller: router Summary (unggah surat), self-check kino_letter_check.
Dependensi: pypdf (sudah ada di container), re/datetime stdlib. Main Functions: parse_pdf, parse_text.
Side Effects: Tidak ada I/O selain membaca PDF di memori; tidak memanggil AI dan tidak menulis DB.

Surat Kino dicetak dari sistem mereka, bukan hasil scan, jadi lapisan teksnya utuh dan bisa
dibaca deterministik. Jalur Mistral tetap dipakai untuk surat principal yang memang hasil scan.
"""
import re
from datetime import date

from summary_rules import OUTLET_CLASSES

# Label baku pada kop surat Kino. Nilai sebuah label adalah teks sampai label berikutnya.
LABELS = ("Print Date", "NO. PROMO ID", "Tanggal Aju", "PID External", "Kode Aju", "Nama Program Promo",
          "Skala Program", "Objective / Tujuan Promo", "Periode Promo", "Divisi", "Brand", "Group Of Promo",
          "Type Of Promo", "Class Of Promo", "Activity Promo", "Mekanisme Promo", "Detail Promo", "Outlet/Account")
LABEL_AT = re.compile("(" + "|".join(re.escape(label) for label in LABELS) + r")\s*:\s*")

MONTHS = {"JANUARI": 1, "JANUARY": 1, "FEBRUARI": 2, "FEBRUARY": 2, "MARET": 3, "MARCH": 3, "APRIL": 4,
          "MEI": 5, "MAY": 5, "JUNI": 6, "JUNE": 6, "JULI": 7, "JULY": 7, "AGUSTUS": 8, "AUGUST": 8,
          "SEPTEMBER": 9, "OKTOBER": 10, "OCTOBER": 10, "NOVEMBER": 11, "DESEMBER": 12, "DECEMBER": 12}
DAY_MONTH_YEAR = re.compile(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})")

# Bullet dan tanda hubung surat ini keluar sebagai U+FFFD karena memakai font simbol.
BULLET = "�"
JUTA = re.compile(r"([\d.,]+)\s*JT\b\s*(?:[" + BULLET + r"\-–]|s/?d)?\s*(?:[\d.,]+\s*JT\b)?\s*(?:UP)?\s*"
                  r"POTONGAN\s+ON\s+FAKTUR\s+([\d.,]+)", re.I)
BONUS = re.compile(r"SETIAP\s+PEMBELIAN\s+(\d+)\s+([A-Z]{2,4})\s+(.+?)\s+AKAN\s+MENDAPATKAN\s+BONUS\s+(\d+)\s+([A-Z]{2,4})", re.I)
PERSEN = re.compile(r"DISC\.?\s*ON\s*FAKTUR\s*:?\s*([\d.,]+)\s*%", re.I)
# "ELLIPS HAIR MIST ON PO 3%": satu butir per produk, tanpa tanda hubung pemisah.
ON_PO = re.compile(r"\bON\s+PO\s+([\d.,]+)\s*%", re.I)
# Channel diambil dari kalimat KEWAJIBAN saja. Surat yang sama memuat klausa kebalikannya
# ("jika toko menggunakan harga GT maka promo tidak dapat di klaim"); membaca harga mana pun
# yang lebih dulu muncul akan memungut channel yang justru dilarang.
HARGA_CHANNEL = re.compile(r"\bWAJIB\s+(?:\w+\s+){0,3}HARGA\s+(GT|MT)\b", re.I)
CHANNELS = ("GT", "MT", "ALL")
ATTACHMENT = re.compile(r"TERLAMPIR|LAMPIRAN|HIT\s+LIST", re.I)


def flatten(text):
    """pypdf mengeluarkan satu token per baris; surat ini hanya bermakna sebagai satu kalimat."""
    return " ".join(str(text).split())


def fields_of(text):
    """Label -> nilai. Label yang tidak tercetak tidak dibuat-buat, cukup tidak ada."""
    blob = flatten(text)
    found, marks = {}, list(LABEL_AT.finditer(blob))
    for index, mark in enumerate(marks):
        end = marks[index + 1].start() if index + 1 < len(marks) else len(blob)
        # `PID External` tercetak dua kali dengan nilai sama; yang pertama menang.
        found.setdefault(mark.group(1), blob[mark.end():end].strip())
    return found


def iso_period(value):
    """"1 September 2026 - 30 September 2026" -> ("2026-09-01", "2026-09-30")."""
    dates = []
    for day, month, year in DAY_MONTH_YEAR.findall(value or ""):
        number = MONTHS.get(month.upper())
        if number:
            dates.append(date(int(year), number, int(day)).isoformat())
    return (dates[0], dates[-1]) if len(dates) >= 2 else ("", "")


def bullets(detail):
    """Pecah Detail Promo per butir. Rentang tier ("1JT � 1.99 JT") tetap satu butir."""
    parts = re.split(r"\s(?:-|" + BULLET + r"|•)\s", " " + flatten(detail) + " ")
    return [part.strip(" :-") for part in parts if len(part.strip(" :-")) > 3]


def outlet_rule(detail):
    """Kelayakan outlet dari kalimat channel. EXCLUDE menang atas PESERTA.

    "EXCLUDE PESERTA PROGRAM IKATAN LOYALTY / HYBRID / CONTRACTUAL & MSG" memuat kedua kata;
    membaca PESERTA lebih dulu akan membalik arti surat dan memberi potongan ke outlet
    yang justru dikecualikan.
    """
    for part in bullets(detail):
        upper = part.upper()
        if "CHANNEL" not in upper and "PESERTA" not in upper:
            continue
        classes = [name for name in OUTLET_CLASSES if re.search(r"\b" + name + r"\b", upper)]
        if not classes:
            continue
        return ("except" if "EXCLUDE" in upper else "only"), classes, part
    return "all", [], ""


def rupiah(text):
    """"20.000" -> "20000"; pemisah ribuan surat Kino selalu titik."""
    return re.sub(r"[.,]", "", text.strip())


def juta(text):
    """"1" -> "1000000", "1.99" -> "1990000". Titik di sini desimal, bukan ribuan."""
    whole, _, fraction = text.strip().replace(",", ".").partition(".")
    return str(int(whole or 0) * 1000000 + int((fraction + "00")[:2]) * 10000)


def parse_text(text, page_count=1):
    """Surat -> baris draft Summary + peringatan. Yang tidak tercetak dilaporkan, tidak ditebak."""
    head = fields_of(text)
    detail = head.get("Detail Promo", "")
    mechanism = flatten(head.get("Mekanisme Promo", "")).upper()
    # Surat yang diunggah ke program BERARTI on faktur (aturan pengguna 18 Sep 2026: "ON PO =
    # ON Faktur", dan surat tanpa keterangan apa pun tetap dibuat karena ia diminta/diunggah).
    # Mekanisme yang tercetak tetap dicatat apa adanya sebagai jejak audit, tidak dipakai menyaring.
    on_faktur = True
    start, end = iso_period(head.get("Periode Promo", ""))
    mode, classes, quote = outlet_rule(detail)
    # Surat yang MELAMPIRKAN daftar outlet pesertanya sendiri (BP2609007909: ±100 outlet di
    # halaman 2-3) tidak boleh jatuh ke "semua outlet". Daftar yang belum dimuat berarti kita
    # belum tahu siapa yang berhak — bukan berarti semua berhak. Programnya ditambatkan ke
    # daftar bernama nomor suratnya sendiri; gerbang menahannya selama daftar itu kosong,
    # dan jembatan sudah memetakan bentuk ini ke `promo_outlet` (summary-bridge.ts).
    kode_aju = flatten(head.get("Kode Aju", "")).upper()
    lampiran_outlet = mode == "all" and bool(ATTACHMENT.search(detail)) and bool(kode_aju)
    if lampiran_outlet:
        mode, classes, quote = "only", [kode_aju], "LIST OUTLET TERLAMPIR"
    warnings = []
    channel = flatten(head.get("Type Of Promo", "")).upper() or "ALL"
    if channel not in CHANNELS:
        # "CONSUMER PROMO" bukan channel. Yang menentukan klaim adalah harga yang dipakai toko,
        # dan surat mencetaknya ("toko wajib menggunakan harga MT"). Tidak tercetak = dikosongkan,
        # bukan ditebak: channel yang salah membuat aturan diam-diam tidak pernah cocok.
        found = HARGA_CHANNEL.search(detail)
        channel = found.group(1).upper() if found else ""
        if not channel:
            warnings.append(f"Type Of Promo '{flatten(head.get('Type Of Promo', ''))}' bukan channel "
                            "(GT/MT/ALL) dan surat tidak menyebut harga GT/MT; isi channel manual.")
    if not (start and end):
        warnings.append("Periode Promo tidak terbaca; isi manual sebelum publikasi.")
    if lampiran_outlet:
        warnings.append(f"Surat melampirkan daftar outlet peserta. Program ditambatkan ke daftar "
                        f"'{kode_aju}' dan DITAHAN SAMPAI anggotanya diunggah; daftar kosong berarti "
                        "belum diketahui siapa yang berhak, bukan semua berhak.")
    elif mode == "all":
        warnings.append("Surat tidak menyebut kelas outlet; aturan akan berlaku untuk SEMUA outlet.")
    else:
        warnings.append(f"Kelayakan outlet '{mode} {', '.join(classes)}' dibaca dari: {quote[:200]}")

    common = dict(principle="KINO", surat_program=head.get("Kode Aju", ""), nama_program=head.get("Nama Program Promo", ""),
                  promo_group_id=head.get("NO. PROMO ID", ""), channel_gtmt=channel,
                  channel_list="", periode_start=start, periode_end=end, gramasi="", syarat_claim="",
                  keterangan="", kode_barangs="", source_page=1, outlet_mode=mode,
                  outlet_classes=",".join(classes))
    rows = []

    def add(**row):
        rows.append({**common, **row, "no": str(len(rows) + 1)})

    for minimum, potongan in JUTA.findall(detail):
        add(kelompok=head.get("Brand", ""), variant="", ketentuan=f"Minimal belanja Rp {juta(minimum)}",
            benefit_type="DISC_RP", benefit=rupiah(potongan), source_quote=f"{minimum}JT potongan on faktur {potongan}")
    # Bonus dibaca PER BUTIR: satu surat bisa memuat empat sub-program, dan "berlaku
    # kelipatan" milik butirnya sendiri, bukan milik seluruh surat.
    for butir in bullets(detail):
        found = BONUS.search(butir)
        if not found:
            continue
        beli, unit, produk, bonus, unit_bonus = found.groups()
        kelipatan = "berlaku kelipatan" if "KELIPATAN" in butir.upper() else ""
        add(kelompok=flatten(produk), variant=flatten(produk),
            ketentuan=f"Setiap pembelian {beli} {unit.upper()} {flatten(produk)} {kelipatan}".strip(),
            benefit_type="BONUS_QTY", benefit=f"{bonus} {unit_bonus.upper()}",
            source_quote=f"Setiap pembelian {beli} {unit} {produk} mendapatkan bonus {bonus} {unit_bonus}")
    # Potongan ON PO per produk: nama produk adalah teks sejak butir sebelumnya.
    # Ketentuan WAJIB menyebut produknya. Jati diri sebuah baris pada penjaga "satu program
    # sekali dalam satu Summary" (summary_store.append_rows) adalah surat+ketentuan+benefit,
    # sengaja tanpa kelompok; ketentuan yang seragam akan meleburkan kelima baris jadi satu.
    body, batas = flatten(detail), 0
    for found in ON_PO.finditer(body):
        produk, batas = body[batas:found.start()], found.end()
        # Judul program ikut terbawa pada butir pertama ("... ON PO 1 SEPTEMBER 2026 - 30
        # SEPTEMBER 2026 ELLIPS HAIR VITAMIN JAR"). Nama barang tidak memuat tahun, jadi apa
        # pun sampai tahun terakhir dibuang.
        produk = re.sub(r"^.*\b(?:19|20)\d{2}\b", "", produk).strip(" :-,.")
        if produk:
            add(kelompok=produk, variant=produk, ketentuan=f"Setiap pembelian {produk}",
                benefit_type="DISC_PCT", benefit=found.group(1),
                source_quote=f"{produk} ON PO {found.group(1)}%")
    if not rows:
        for persen in PERSEN.findall(detail):
            add(kelompok=head.get("Brand", ""), variant="", ketentuan="Setiap pembelian",
                benefit_type="DISC_PCT", benefit=persen, source_quote=f"Disc. on faktur {persen}%")
    if not rows:
        warnings.append("Tidak ada mekanisme yang terbaca; isi baris manual dari Detail Promo.")
    if ATTACHMENT.search(detail):
        warnings.append("Surat merujuk LAMPIRAN (hit list / size paket). Aturan belum lengkap tanpa lampiran itu.")
    return {"letter": head, "mechanism": mechanism, "on_faktur": on_faktur, "rows": rows,
            "warnings": warnings, "page_count": page_count, "detail": flatten(detail)}


def parse_pdf(raw):
    """Hanya untuk surat berlapis teks. Tanpa lapisan teks -> tolak, jangan diam-diam kosong."""
    import pypdf

    reader = pypdf.PdfReader(__import__("io").BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages]
    if len(flatten(pages[0] if pages else "")) < 200:
        raise ValueError("Halaman pertama tidak punya lapisan teks; surat ini hasil scan, pakai jalur OCR")
    result = parse_text(pages[0], len(pages))
    if len(pages) > 1:
        result["warnings"].append(f"Surat punya {len(pages) - 1} halaman lampiran yang TIDAK ikut dibaca menjadi aturan.")
        result["attachment_text"] = flatten(" ".join(pages[1:]))
    return result
