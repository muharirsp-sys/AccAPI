"""Tujuan: Baca surat program PT Primarasa Abadi Sejahtera (merek Collins) menjadi baris draft
Summary -- deterministik, tanpa OCR/LLM (surat berlapis teks).
Caller: dimaksudkan dipasang di `routers/summary.py` seperti `kino_extraction`; BELUM dipasang
(lihat catatan di kepala e2e_primarasa.py). Dipakai langsung oleh e2e_primarasa.py.
Dependensi: pypdf, re/datetime stdlib. Main Functions: parse_pdf, parse_text, match_items.
Side Effects: tidak ada I/O selain membaca PDF di memori; tidak memanggil AI.

BENTUK SURATNYA. Surat naratif pendek: kop + nomor + "Perihal", lalu aturan bernomor
("1. ...", "2. ..."), lalu kalimat masa berlaku. Tidak ada tabel sama sekali, jadi yang
menentukan cakupan barang adalah UKURAN KEMASAN yang disebut di kalimat aturan
("6 x 1kg", "12 x 1 kg", "5 kg", "24 x 300 gr").

ATURAN YANG DITEGAKKAN DI SINI
  - ON PO = ON FAKTUR (keputusan pengguna 2026-09-18): surat ini tidak menyebut mekanisme
    faktur sama sekali, dan itu TIDAK menahan satu baris pun. Barisnya tetap dibuat.
  - FAIL-CLOSED untuk data yang memang tidak ada:
      * ukuran kemasan yang disebut surat tetapi TIDAK ADA di master (mis. "6 x 1kg")
        tidak pernah dipetakan ke ukuran lain yang mirip -- ia dilaporkan;
      * aturan yang SELURUH ukurannya tak ada di master -> baris ditahan (tanpa kode);
      * tanggal akhir yang tidak tercetak dibiarkan kosong (gerbang compile_programs yang
        akan menahannya), tidak dikarang;
      * channel dan syarat klaim yang tidak tercetak -> kosong + peringatan.
"""
import re
from datetime import date

BULAN = {"JANUARI": 1, "FEBRUARI": 2, "MARET": 3, "APRIL": 4, "MEI": 5, "JUNI": 6, "JULI": 7,
         "AGUSTUS": 8, "SEPTEMBER": 9, "OKTOBER": 10, "NOVEMBER": 11, "DESEMBER": 12}

NOMOR_RE = re.compile(r"Nomor\s*:\s*([0-9][0-9A-Za-z/.\-]{4,50})", re.I)
PERIHAL_RE = re.compile(r"Perihal\s*:\s*([^\n]{3,120})", re.I)
MULAI_RE = re.compile(r"berlaku\s+mulai\s+tanggal\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", re.I)
SAMPAI_RE = re.compile(r"(?:s/?d|sampai|hingga|berakhir\s+(?:pada\s+)?tanggal)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", re.I)
ATURAN_RE = re.compile(r"(?:^|\s)(\d)\.\s+(.{10,600}?)(?=\s\d\.\s|\Z)", re.S)
# Bagian aturan berakhir di kalimat masa berlaku / penutup; tanpa batas ini aturan TERAKHIR
# ikut menyeret seluruh badan surat dan malah tidak cocok sama sekali.
AKHIR_ATURAN_RE = re.compile(r"\b(?:Program ini berlaku|Demikian|Note\s*:)", re.I)
PERSEN_RE = re.compile(r"discount\s+([\d.,]+)\s*%", re.I)
RUPIAH_RE = re.compile(r"discount\s+Rp\.?\s*([\d.,]+)", re.I)
# "6 x 1kg", "12 x 1 kg", "24 x 300 gr", "5 kg"
PACK_RE = re.compile(r"(?:(\d{1,3})\s*x\s*)?(\d{1,4})\s*(kg|gr|gram)\b", re.I)
PRODUK_RE = re.compile(r"(Collins[A-Za-z ]*?)(?=\s*(?:\d+\s*x|\d+\s*kg|ukuran|\d+\s*gr|,|\.|$))", re.I)
# Kalimat pembanding harga: kemasan yang disebut SESUDAH frasa ini adalah ACUAN HARGA,
# bukan sasaran diskon. "Collins Dip Glaze 6 x 1kg harga per pcsnya SAMA DENGAN ... 12 x 1kg"
# -- memberi diskon ke 12 x 1kg berarti membalik arti surat.
PEMBANDING_RE = re.compile(r"\b(?:sama\s+dengan|setara\s+dengan|mengikuti\s+harga|sesuai\s+harga)\b", re.I)


def flatten(text):
    return " ".join(str(text).split())


def _tanggal(hari, nama_bulan, tahun):
    nomor = BULAN.get(str(nama_bulan).upper())
    return date(int(tahun), nomor, int(hari)).isoformat() if nomor else ""


def _pack_label(jumlah, ukuran, satuan):
    satuan = "KG" if satuan.upper().startswith("KG") else "GR"
    return (f"{jumlah} x {ukuran}{satuan}" if jumlah else f"{ukuran}{satuan}"), f"{ukuran}{satuan}", jumlah


def packs_of(text):
    """Ukuran kemasan yang DISEBUT kalimat aturan -> [(label, gramasi, isi_per_karton|None)]."""
    hasil, terlihat = [], set()
    for jumlah, ukuran, satuan in PACK_RE.findall(text or ""):
        label, gram, isi = _pack_label(jumlah, ukuran, satuan)
        if label not in terlihat:
            terlihat.add(label)
            hasil.append((label, gram, isi))
    return hasil


def parse_text(text, page_count=1):
    blob = flatten(text)
    nomor = NOMOR_RE.search(blob)
    # "Perihal : ..." dibaca dari teks MENTAH supaya `[^\n]+` berhenti di akhir baris asli;
    # pada blob yang sudah diratakan ia akan menelan sisa surat.
    perihal = PERIHAL_RE.search(str(text or ""))
    mulai = MULAI_RE.search(blob)
    sampai = SAMPAI_RE.search(blob)
    warnings = []

    start = _tanggal(*mulai.groups()) if mulai else ""
    end = _tanggal(*sampai.groups()) if sampai else ""
    if not end:
        warnings.append("Surat tidak mencetak tanggal BERAKHIR ('berlaku mulai ...' saja); "
                         "periode dibiarkan kosong -- isi manual, jangan dikarang.")
    if not re.search(r"\bchannel\b|\bGT\b|\bMT\b", blob, re.I):
        warnings.append("Surat tidak menyebut channel; kolom channel dikosongkan untuk diisi operator.")
    if not re.search(r"klaim|claim", blob, re.I):
        warnings.append("SYARAT KLAIM TIDAK DITEMUKAN DI SURAT -- wajib konfirmasi manual.")

    common = {"principle": "PRIMARASA", "surat_program": nomor.group(1).strip() if nomor else "",
              "nama_program": flatten(perihal.group(1)) if perihal else "", "channel_gtmt": "",
              "channel_list": "", "periode_start": start, "periode_end": end, "syarat_claim": "",
              "outlet_mode": "all", "outlet_classes": "", "variant": "", "source_page": 1,
              "kode_barangs": "", "keterangan": ""}

    # "berlaku tanpa syarat" = surat menyatakan sendiri tidak ada minimum pembelian.
    tanpa_syarat = bool(re.search(r"tanpa\s+syarat", blob, re.I))
    batas = AKHIR_ATURAN_RE.search(blob)
    bagian_aturan = blob[:batas.start()] if batas else blob
    rows = []
    for _, kalimat in ATURAN_RE.findall(bagian_aturan):
        kalimat = flatten(kalimat)
        persen, rupiah = PERSEN_RE.search(kalimat), RUPIAH_RE.search(kalimat)
        if not (persen or rupiah):
            continue
        produk = PRODUK_RE.search(kalimat)
        # Hanya kemasan SEBELUM frasa pembanding yang jadi sasaran; sisanya acuan harga.
        pembanding = PEMBANDING_RE.search(kalimat)
        sasaran = kalimat[:pembanding.start()] if pembanding else kalimat
        packs = packs_of(sasaran)
        acuan = [p[0] for p in packs_of(kalimat[pembanding.end():])] if pembanding else []
        row = {**common, "no": str(len(rows) + 1),
               "kelompok": flatten(produk.group(1)).upper() if produk else "COLLINS",
               "gramasi": ", ".join(p[1] for p in packs),
               "ketentuan": "Tidak ada minimum pembelian" if tanpa_syarat else "",
               "source_quote": kalimat[:400], "_packs": packs}
        if persen:
            row.update(benefit_type="DISC_PCT", benefit=persen.group(1).replace(",", "."))
        else:
            row.update(benefit_type="DISC_RP", benefit=re.sub(r"[.,]", "", rupiah.group(1)),
                       keterangan="Potongan per pcs (surat menulis 'per pcs nya discount').")
        if acuan:
            row["keterangan"] = flatten(f"{row.get('keterangan', '')} Kemasan {', '.join(acuan)} "
                                         "disebut sebagai ACUAN HARGA, bukan sasaran diskon -- tidak diikutkan.")
        rows.append(row)
    if not rows:
        warnings.append("Tidak ada aturan diskon yang terbaca; isi baris manual dari surat.")
    return {"letter": common, "rows": rows, "warnings": warnings, "page_count": page_count,
            "mechanism_printed": ""}


def match_items(rows, items, warnings=None):
    """Ukuran kemasan yang disebut surat -> kode master pada kelompok yang sama.

    Kecocokan memakai gramasi master DAN isi per karton yang tercetak di `nama_barang`
    ("1KG X 12 PCS"). Ukuran yang disebut surat tetapi tidak ada di master TIDAK pernah
    dialihkan ke ukuran lain -- ia dilaporkan di `keterangan`.
    """
    for row in rows:
        packs = row.pop("_packs", []) or []
        kelompok = str(row.get("kelompok", "")).upper()
        kunci = [k for k in kelompok.split() if k not in ("PRODUK", "SELURUH")]
        kandidat = [it for it in items
                    if all(k in str(it.get("kelompok", "")).upper() for k in kunci)] if kunci else []
        if not kandidat:
            kandidat = [it for it in items if "COLLINS" in str(it.get("nama_barang", "")).upper()]

        cocok, hilang = [], []
        for label, gram, isi in packs:
            terpakai = []
            for it in kandidat:
                if str(it.get("gramasi", "")).upper().replace(" ", "") != gram.upper():
                    continue
                nama = str(it.get("nama_barang", "")).upper()
                if isi and not re.search(rf"\bX\s*{int(isi)}\s+(?:PCS|PAIL)\b", nama):
                    continue
                terpakai.append(it)
            if terpakai:
                cocok.extend(terpakai)
            else:
                hilang.append(label)

        kode = sorted({str(it.get("kode_barang", "")).strip() for it in cocok if it.get("kode_barang")})
        row["kode_barangs"] = ",".join(kode)
        catatan = []
        if hilang:
            catatan.append("UKURAN TIDAK ADA DI MASTER: " + "; ".join(hilang) +
                           " -- tidak dialihkan ke ukuran lain, periksa master/kemasan.")
        if not kode:
            row["_primarasa_unmatched"] = True
            catatan.append("PERLU REVIEW MANUAL -- tidak ada barang master untuk ukuran yang disebut surat.")
            if warnings is not None:
                warnings.append(f"baris {row.get('no')}: tidak ada barang master untuk {packs}.")
        if cocok:
            row["gramasi"] = ", ".join(sorted({str(it.get("gramasi", "")) for it in cocok if it.get("gramasi")}))
        if catatan:
            row["keterangan"] = flatten(f"{row.get('keterangan', '')} " + " ".join(catatan))
    return rows


def parse_pdf(raw):
    """Hanya surat berlapis teks. Tanpa lapisan teks -> tolak, jangan diam-diam kosong."""
    import pypdf

    reader = pypdf.PdfReader(__import__("io").BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages]
    if len(flatten(pages[0] if pages else "")) < 100:
        raise ValueError("Halaman pertama tidak punya lapisan teks; pakai jalur OCR")
    return parse_text("\n".join(pages), len(pages))
