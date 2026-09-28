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
# "DISC ON PO 3%" (BP2609008707): kata DISC milik manfaatnya, bukan nama barang.
ON_PO = re.compile(r"\b(?:DISC\.?\s+)?ON\s+PO\s+([\d.,]+)\s*%", re.I)
# Beberapa produk ber-UKURAN berjajar sebelum SATU "DISC ON PO": "ELLIPS HAIR VITAMIN ULTRA LIGHT
# BTL 45ML SASHA SHAMPOO COLOR NATURAL BLACK 30ML DISC ON PO 3%". Ukuran menutup nama produk.
PRODUK_BERUKURAN = re.compile(r".+?\b\d+(?:[.,]\d+)?\s?(?:ML|GR|GRAM|G|KG|L|LTR)\b", re.I)
# Surat khusus akun NKA: "NKA - INDOMARET LISTING ...", ditambah "INDOGROSIR COVER INDOMARET".
AKUN_NKA = re.compile(r"\bNKA\s*-\s*([A-Z0-9]+)", re.I)
AKUN_COVER = re.compile(r"\b([A-Z0-9]+)\s+COVER\s+([A-Z0-9]+)\b", re.I)
FIRST_PO = re.compile(r"\bFIRST\s+PO\b", re.I)
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


def accounts(text):
    """Akun NKA yang disebut surat, akun utama lebih dulu; kosong = surat tidak khusus akun."""
    blob = flatten(text).upper()
    utama = [found.group(1) for found in AKUN_NKA.finditer(blob)]
    ikut = [found.group(1) for found in AKUN_COVER.finditer(blob) if found.group(2) in utama]
    return list(dict.fromkeys(utama + ikut))


SATUAN = {"BTL", "SCH", "PCS", "KRT", "CTN", "BOX", "JAR", "TUBE", "PCH", "BLR", "SACHET", "RTG", "PAK", "PACK"}
UKURAN = re.compile(r"^\d+(?:[.,]\d+)?(?:ML|GR|GRAM|G|KG|L|LTR)$")


def _kata(text):
    """Kata bermakna nama MASTER: "&" jadi pemisah, satuan kemasan dibuang."""
    return [t for t in re.sub(r"&", " ", flatten(text).upper()).split() if t not in SATUAN]


def _inti_master(nama):
    """"KNF ELLIPS H.VIT ULTRA LIGHT 45ML X 36 BTL" -> ([ELLIPS, H.VIT, ULTRA, LIGHT], "45ML")."""
    kata = _kata(re.split(r"\sX\s+\d", " " + flatten(nama).upper() + " ")[0])
    kata = kata[1:] if kata[:1] == ["KNF"] else kata
    ukuran = next((t for t in kata if UKURAN.match(t)), "")
    return [t for t in kata if not UKURAN.match(t)], ukuran


def _kemasan_master(nama):
    """"... 1ML X 12 JAR" -> "JAR". Kemasan membedakan PRODUK: ELLIPS H.VIT 1ML BLR dan JAR dua
    barang berbeda, dan surat MTI September menulis "ELLIPS HAIR VITAMIN JAR" saja."""
    found = re.search(r"\sX\s+\d+\s+([A-Z]+)\s*$", flatten(nama).upper())
    return found.group(1) if found else ""


def _cakup(token, kata, terpakai):
    """Indeks kata surat yang dijelaskan satu kata master; kosong = tidak cocok.

    Kata utuh cocok persis. Singkatan bertitik cocok bila TIAP bagiannya awalan kata surat yang
    berurutan: "H.VIT" = "HAIR VITAMIN", "NAT." = "NATURAL". Tanpa peta singkatan — master Kino
    memakai "H." untuk hair, hand, dan lainnya, jadi peta tetap akan salah di suatu saat.
    Kata surat yang sudah dipakai kata master lain tidak dipakai lagi ("B&B" = dua kata "B").
    """
    for indeks, kata_surat in enumerate(kata):
        if indeks not in terpakai and kata_surat == token:
            return {indeks}
    bagian = [b for b in token.split(".") if b]
    if "." not in token or not bagian:
        return set()
    for mulai in range(len(kata) - len(bagian) + 1):
        rentang = set(range(mulai, mulai + len(bagian)))
        if not rentang & terpakai and all(kata[mulai + i].startswith(b) for i, b in enumerate(bagian)):
            return rentang
    return set()


def match_products(rows, items, warnings):
    """Nama produk surat -> kode master, DETERMINISTIK dan gagal-tertutup.

    Surat Kino mencetak NAMA produk berukuran ("SASHA SHAMPOO COLOR NATURAL BLACK 30ML"), bukan
    kode, dan nama master memakai singkatan ("KNF ELLIPS H.VIT ULTRA LIGHT 45ML X 36 BTL") —
    `attach_codes` yang menuntut nama master utuh tidak pernah menemukannya (BP2609008707).
    Syarat sebuah barang master jadi kandidat: ukurannya SAMA, setiap kata masternya ada di surat,
    dan setiap kata surat dijelaskan kata master. Hanya satu produk yang diterima (kemasan berbeda
    dari produk yang sama ikut); lebih dari satu produk atau nol = DITAHAN dengan peringatan.
    Kelompok/varian/gramasi ditimpa nilai master supaya `_apply_native_kelompok` saat simpan
    menemukan barang yang sama, bukan memekarkannya se-kelompok.
    """
    katalog = []
    for item in items:
        inti, ukuran = _inti_master(item.get("nama_barang", ""))
        if inti and ukuran and str(item.get("kode_barang", "")).strip():
            katalog.append((inti, ukuran, _kemasan_master(item.get("nama_barang", "")), item))
    kemasan_dikenal = SATUAN | {kemasan for _, _, kemasan, _ in katalog if kemasan}
    for row in rows:
        if str(row.get("kode_barangs", "")).strip() or row.get("benefit_type") != "DISC_PCT":
            continue
        mentah = re.sub(r"&", " ", flatten(row.get("kelompok", "")).upper()).split()
        kemasan_surat = {t for t in mentah if t in kemasan_dikenal}
        kata = [t for t in mentah if t not in kemasan_dikenal]
        ukuran = next((t for t in kata if UKURAN.match(t)), "")
        kata = [t for t in kata if not UKURAN.match(t)]
        if not ukuran or not kata:
            continue
        cocok = []
        for inti, ukuran_master, kemasan, item in katalog:
            if ukuran_master != ukuran or (kemasan_surat and kemasan not in kemasan_surat):
                continue
            terpakai = set()
            for token in inti:
                cakupan = _cakup(token, kata, terpakai)
                if not cakupan:
                    break
                terpakai |= cakupan
            else:
                if terpakai == set(range(len(kata))):
                    cocok.append(((tuple(inti), kemasan), item))
        # Produk = kata inti + KEMASAN. Karton berbeda untuk kemasan yang sama (X 24 lawan X 36 BTL)
        # tetap satu produk; kemasan berbeda yang tidak disebut surat (BLR lawan JAR) = ambigu, ditahan.
        produk = {kunci for kunci, _ in cocok}
        if len(produk) != 1:
            if cocok:
                warnings.append(f"Baris {row['no']}: '{row['kelompok']}' cocok dengan {len(produk)} produk master "
                                f"({', '.join(sorted(str(i['kode_barang']) for _, i in cocok))}); kode tidak diisi, pilih manual.")
            else:
                warnings.append(f"Baris {row['no']}: '{row['kelompok']}' tidak ditemukan di master; kode tidak diisi.")
            continue
        barang = [item for _, item in cocok]
        row["kode_barangs"] = ",".join(sorted({str(item["kode_barang"]).strip() for item in barang}))
        for field in ("kelompok", "variant", "gramasi"):
            nilai = {str(item.get(field, "") or "").strip() for item in barang} - {""}
            if len(nilai) == 1:
                row[field] = nilai.pop()
        warnings.append(f"Baris {row['no']}: kode {row['kode_barangs']} dicocokkan dari nama produk surat "
                        f"'{row['ketentuan'].replace('Setiap pembelian ', '')}'.")


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
    # Surat untuk satu AKUN NKA (BP2609008707: "NKA - INDOMARET ... INDOGROSIR COVER INDOMARET",
    # Outlet/Account tetap tercetak ALL) juga bukan untuk semua outlet. Dibaca "semua", 3%-nya
    # membenarkan potongan yang sama di outlet mana pun. Ditambatkan ke daftar bernama nomor
    # suratnya seperti surat berlampiran: ditahan sampai anggota akunnya diunggah.
    akun = accounts(head.get("Nama Program Promo", "") + " " + detail) if mode == "all" and kode_aju else []
    if lampiran_outlet or akun:
        mode, classes, quote = "only", [kode_aju], ("AKUN NKA " + ", ".join(akun)) if akun else "LIST OUTLET TERLAMPIR"
    warnings = []
    channel = flatten(head.get("Type Of Promo", "")).upper() or "ALL"
    if channel not in CHANNELS and akun:
        # Outlet akun NKA berkategori NKA di master Accurate, bukan MT: channel MT akan membuat
        # aturannya diam-diam tidak pernah berlaku. Yang membatasi sudah daftar akunnya.
        channel = "ALL"
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
    if akun:
        warnings.append(f"Surat khusus akun NKA {', '.join(akun)}. Program ditambatkan ke daftar '{kode_aju}' "
                        f"dan DITAHAN SAMPAI outlet {', '.join(akun)} diunggah ke daftar itu; channel ALL karena "
                        "kategori outlet NKA bukan MT.")
    elif lampiran_outlet:
        warnings.append(f"Surat melampirkan daftar outlet peserta. Program ditambatkan ke daftar "
                        f"'{kode_aju}' dan DITAHAN SAMPAI anggotanya diunggah; daftar kosong berarti "
                        "belum diketahui siapa yang berhak, bukan semua berhak.")
    elif mode == "all":
        warnings.append("Surat tidak menyebut kelas outlet; aturan akan berlaku untuk SEMUA outlet.")
    else:
        warnings.append(f"Kelayakan outlet '{mode} {', '.join(classes)}' dibaca dari: {quote[:200]}")

    # "FIRST PO": hanya PO pertama (listing) yang berhak. Belum ada aturan yang bisa menilainya,
    # jadi dicatat di keterangan setiap baris dan diperingatkan — bukan dianggap berlaku terus.
    first_po = bool(FIRST_PO.search(head.get("Nama Program Promo", "") + " " + detail))
    if first_po:
        warnings.append("Surat hanya untuk PO PERTAMA (listing). Sistem belum menilai syarat ini: "
                        "PO berikutnya dengan potongan yang sama tetap terbaca sah, periksa sebelum klaim.")
    common = dict(principle="KINO", surat_program=head.get("Kode Aju", ""), nama_program=head.get("Nama Program Promo", ""),
                  promo_group_id=head.get("NO. PROMO ID", ""), channel_gtmt=channel,
                  channel_list=", ".join(akun), periode_start=start, periode_end=end, gramasi="", syarat_claim="",
                  keterangan="Hanya PO pertama (listing) per outlet" if first_po else "",
                  kode_barangs="", source_page=1, outlet_mode=mode,
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
        # Beberapa produk berukuran sebelum satu manfaat -> satu baris per produk. Hanya bila
        # potongan-potongannya menyusun ULANG seluruh teks; sisa apa pun = bukan daftar, biarkan utuh.
        daftar = [part.strip(" ,") for part in PRODUK_BERUKURAN.findall(produk)]
        if len(daftar) < 2 or PRODUK_BERUKURAN.sub("", produk).strip(" ,."):
            daftar = [produk] if produk else []
        for nama in daftar:
            add(kelompok=nama, variant=nama, ketentuan=f"Setiap pembelian {nama}",
                benefit_type="DISC_PCT", benefit=found.group(1),
                source_quote=f"{nama} ON PO {found.group(1)}%")
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
