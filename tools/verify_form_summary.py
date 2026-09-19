#!/usr/bin/env python3
"""
verify_form_summary.py — gate objektif untuk PDF "Summary Program On Faktur".

Memeriksa PDF hasil generate terhadap master barang (xlsx) dan, bila diberikan,
surat program sumbernya. Setiap pemeriksaan mengembalikan PASS/FAIL dengan
lokasi halaman, supaya agen/CI tidak bisa menyatakan "selesai" berdasarkan kesan.

Exit code: 0 = semua invariant hijau, 1 = ada FAIL, 2 = error input.

Dipakai:
    python verify_form_summary.py \
        --form out/Form_Summary.pdf \
        --master data/MASTER_BARANG_DAHLIA.xlsx data/MASTER_BARANG_PRISKILA.xlsx \
        --surat input/570-11410.pdf \
        [--json report.json] [--strict-kelompok]

Ketergantungan: pdfplumber, openpyxl
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

try:
    import pdfplumber
except ImportError:  # pragma: no cover
    sys.exit("butuh pdfplumber: pip install pdfplumber")
try:
    import openpyxl
except ImportError:  # pragma: no cover
    sys.exit("butuh openpyxl: pip install openpyxl")


# --------------------------------------------------------------------------
# Konstanta domain
# --------------------------------------------------------------------------

# Label peran pada blok tanda tangan. Semuanya wajib berada di halaman TERAKHIR.
SIGNATURE_ROLE_ANCHORS = [
    "Dibuat Oleh",
    "Diketahui Oleh",
    "Diperiksa Oleh",
    "Disetujui Oleh",
    "Diajukan Oleh",
]
SIGNATURE_PLACE_ANCHOR = "Makassar"
SIGNATURE_SLOT_RE = re.compile(r"\(\.{3,}")  # "(.........."

# Header tabel. Wajib muncul di SETIAP halaman badan dan dengan x yang sama.
REQUIRED_HEADERS = [
    "Surat Program",
    "Nama Program",
    "Periode",
    "Kelompok",
    "Variant",
    "Gramasi",
    "Ketentuan",
    "Benefit",
    "Syarat Claim",
    "Keterangan",
]

PAGE_LABEL_RE = re.compile(r"\bHal\s*(\d+)\b", re.IGNORECASE)

# Kode barang pendek yang dipakai surat program: F601TM, F609RC, P2071001, dst.
# Diambil dari token pertama "Nama Barang" di master; regex ini hanya jaring
# kandidat dari surat, keputusan akhir selalu lewat perbandingan ke master.
CODE_CANDIDATE_RE = re.compile(r"\b[A-Z]{1,3}\d{3,4}[A-Z0-9]{0,4}(?:-[A-Z]{2,4})?\b")

# Pemisah antar tail kelompok / antar gramasi pada satu sel.
TAIL_SPLIT_RE = re.compile(r"\s*(?:,|&|\bdan\b)\s*", re.IGNORECASE)

DEFAULT_X_TOLERANCE = 1.5      # pt, toleransi pergeseran kolom antar halaman
DEFAULT_EDGE_MARGIN = 6.0      # pt, batas minimum tepi kanan/bawah


# --------------------------------------------------------------------------
# Hasil pemeriksaan
# --------------------------------------------------------------------------

@dataclass
class Check:
    id: str
    title: str
    ok: bool = True
    details: list[str] = field(default_factory=list)

    def fail(self, msg: str) -> None:
        self.ok = False
        self.details.append(msg)

    def note(self, msg: str) -> None:
        self.details.append(msg)


# --------------------------------------------------------------------------
# Master barang
# --------------------------------------------------------------------------

@dataclass
class Master:
    """Isi master barang yang relevan untuk verifikasi."""
    kelompok: set[str] = field(default_factory=set)              # "DH AIR F"
    codes: set[str] = field(default_factory=set)                 # "F601TM"
    code_to_kelompok: dict[str, str] = field(default_factory=dict)
    kelompok_to_gramasi: dict[str, set[str]] = field(default_factory=dict)
    code_to_gramasi: dict[str, str] = field(default_factory=dict)


def _norm(s: Any) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def load_master(paths: list[Path]) -> Master:
    """Baca satu atau lebih MASTER_BARANG_*.xlsx.

    Kolom dicari berdasarkan nama header, bukan indeks, supaya tidak pecah
    kalau urutan kolom di file berubah.
    """
    m = Master()
    for p in paths:
        wb = openpyxl.load_workbook(p, data_only=True, read_only=True)
        for ws in wb.worksheets:
            rows = ws.iter_rows(values_only=True)
            try:
                header = [_norm(c) for c in next(rows)]
            except StopIteration:
                continue

            def col(*needles: str) -> int | None:
                """Cari indeks kolom: cocok persis dulu, baru substring.

                Urutan ini penting — master punya 'Nama Barang Principle' (kosong)
                SEBELUM 'Nama Barang' (terisi); substring-first akan salah ambil.
                """
                want = " ".join(needles).lower()
                for i, h in enumerate(header):
                    if re.sub(r"\s+", " ", h).lower() == want:
                        return i
                for i, h in enumerate(header):
                    flat = re.sub(r"\s+", " ", h).lower()
                    if all(n.lower() in flat for n in needles):
                        return i
                return None

            i_nama = col("nama barang")
            i_klp = col("nama klp")
            i_gram = col("gramasi")
            if i_nama is None or i_klp is None:
                continue

            for r in rows:
                nama = _norm(r[i_nama] if i_nama < len(r) else "")
                klp = _norm(r[i_klp] if i_klp < len(r) else "")
                gram = _norm(r[i_gram] if (i_gram is not None and i_gram < len(r)) else "")
                if not nama:
                    continue
                if klp:
                    m.kelompok.add(klp.upper())
                    if gram:
                        m.kelompok_to_gramasi.setdefault(klp.upper(), set()).add(gram.upper())
                # kode pendek = token pertama "Nama Barang"
                code = nama.split()[0].upper()
                if re.fullmatch(r"[A-Z0-9][A-Z0-9\-]{2,}", code):
                    m.codes.add(code)
                    if klp:
                        m.code_to_kelompok[code] = klp.upper()
                    if gram:
                        m.code_to_gramasi[code] = gram.upper()
        wb.close()
    return m


# --------------------------------------------------------------------------
# Pembacaan PDF
# --------------------------------------------------------------------------

@dataclass
class PageView:
    index: int                 # 1-based
    width: float
    height: float
    words: list[dict]
    text: str


def read_pages(path: Path) -> list[PageView]:
    pages: list[PageView] = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            words = page.extract_words(
                use_text_flow=False, keep_blank_chars=False, extra_attrs=[]
            )
            pages.append(
                PageView(
                    index=i,
                    width=float(page.width),
                    height=float(page.height),
                    words=words,
                    text=page.extract_text() or "",
                )
            )
    return pages


def page_has(page: PageView, needle: str) -> bool:
    return needle.lower() in page.text.lower()


# --------------------------------------------------------------------------
# C1 / C2 — blok tanda tangan
# --------------------------------------------------------------------------

def check_signature(pages: list[PageView], edge_margin: float,
                    expect_roles: list[str] | None = None) -> list[Check]:
    last = len(pages)
    c1 = Check("C1_SIGNATURE_LAST_PAGE",
               "Blok tanda tangan utuh dan hanya di halaman terakhir")
    c2 = Check("C2_SIGNATURE_NOT_CLIPPED",
               "Blok tanda tangan tidak terpotong tepi halaman")

    pages_with_roles: dict[int, list[str]] = {}
    for p in pages:
        found = [a for a in SIGNATURE_ROLE_ANCHORS if page_has(p, a)]
        if found:
            pages_with_roles[p.index] = found

    if not pages_with_roles:
        c1.fail("tidak ada label tanda tangan sama sekali "
                f"(dicari: {', '.join(SIGNATURE_ROLE_ANCHORS)})")
        c2.note("dilewati: blok tanda tangan tidak ditemukan")
        return [c1, c2]

    early = sorted(i for i in pages_with_roles if i != last)
    if early:
        for i in early:
            c1.fail(f"label tanda tangan {pages_with_roles[i]} muncul di halaman {i} "
                    f"(seharusnya hanya halaman {last})")
    if last not in pages_with_roles:
        c1.fail(f"halaman terakhir ({last}) tidak memuat label tanda tangan sama sekali")
    if len(pages_with_roles) > 1:
        c1.fail("blok tanda tangan terbelah ke "
                f"{len(pages_with_roles)} halaman: {sorted(pages_with_roles)}")

    lp = pages[last - 1]
    if not page_has(lp, SIGNATURE_PLACE_ANCHOR):
        c1.fail(f"baris kota/tanggal ('{SIGNATURE_PLACE_ANCHOR} , <tgl>') "
                f"tidak ada di halaman {last}")

    n_roles = sum(lp.text.lower().count(a.lower()) for a in SIGNATURE_ROLE_ANCHORS)
    n_slots = len(SIGNATURE_SLOT_RE.findall(lp.text))
    if n_slots < n_roles:
        c1.fail(f"halaman {last}: {n_roles} label peran tapi hanya {n_slots} "
                f"kolom tanda tangan '(......)' — ada yang terpotong")
    else:
        c1.note(f"halaman {last}: {n_roles} label peran / {n_slots} kolom tanda tangan")

    # Susunan penanda tangan berbeda per principal/cabang — diambil dari berkas
    # aturan cabang, bukan ditebak. Mis. Dahlia/CV. SURYA PERKASA memakai 5 peran
    # (Admin, SM, Kepala Accounting, Claim, Operational Manager).
    if expect_roles:
        lp_low = lp.text.lower()
        for role in expect_roles:
            if role.lower() not in lp_low:
                c1.fail(f"halaman {last}: penanda tangan '{role}' yang diwajibkan "
                        f"aturan cabang tidak ada di lembar")
        if n_slots != len(expect_roles):
            c1.fail(f"halaman {last}: aturan cabang minta {len(expect_roles)} kolom "
                    f"tanda tangan, tercetak {n_slots}")

    # C2 — geometri
    sig_words = []
    for w in lp.words:
        t = w["text"]
        if SIGNATURE_SLOT_RE.search(t) or any(
            a.split()[0].lower() == t.lower().rstrip(",") for a in SIGNATURE_ROLE_ANCHORS
        ) or t.lower().startswith(SIGNATURE_PLACE_ANCHOR.lower()):
            sig_words.append(w)
    if sig_words:
        right_limit = lp.width - edge_margin
        bottom_limit = lp.height - edge_margin
        for w in sig_words:
            if w["x1"] > right_limit:
                c2.fail(f"halaman {last}: '{w['text']}' melewati tepi kanan "
                        f"(x1={w['x1']:.1f} > {right_limit:.1f})")
            if w["bottom"] > bottom_limit:
                c2.fail(f"halaman {last}: '{w['text']}' melewati tepi bawah "
                        f"(bottom={w['bottom']:.1f} > {bottom_limit:.1f})")
        w_min = min((w["x0"] for w in sig_words), default=None)
        if w_min is not None and w_min < edge_margin:
            c2.fail(f"halaman {last}: blok tanda tangan terpotong tepi kiri "
                    f"(x0={w_min:.1f})")
    else:
        c2.note("tidak ada kata blok tanda tangan yang bisa diukur")

    return [c1, c2]


# --------------------------------------------------------------------------
# C3 / C4 / C5 / C6 — grid, overflow, header, nomor halaman
# --------------------------------------------------------------------------

def locate_headers(page: PageView) -> tuple[dict[str, float], list[str], float]:
    """Cari x0 tiap label header, dibatasi ke BARIS HEADER saja.

    Tanpa pembatasan ini kata di subjudul (mis. 'CV. SURYA PERKASA PERIODE
    MARET 2026') ikut terbaca sebagai header dan memalsukan pergeseran kolom.
    Baris header dipilih sebagai pita-y yang memuat paling banyak label berbeda.

    Mengembalikan (posisi_x_per_label, label_yang_terpotong). Label terpotong =
    kolom terlalu sempit sehingga kata header pecah ('Keteranga' + 'n').
    """
    lowered = [(w, w["text"].lower().strip(".,")) for w in page.words]
    firsts = {label: label.split()[0].lower() for label in REQUIRED_HEADERS}

    def match_label(t: str, first: str) -> tuple[bool, bool]:
        """(cocok, terpotong)"""
        if t == first:
            return True, False
        if len(t) >= 5 and first.startswith(t) and t != first:
            return True, True
        return False, False

    # kandidat: setiap kata yang bisa jadi kata pertama sebuah header
    cands: list[tuple[dict, str, bool]] = []
    for w, t in lowered:
        for label, first in firsts.items():
            ok, trunc = match_label(t, first)
            if ok:
                cands.append((w, label, trunc))
    if not cands:
        return {}, [], 0.0

    # kelompokkan per pita-y (toleransi 6pt), pilih pita dengan label terbanyak
    bands: dict[int, list[tuple[dict, str, bool]]] = {}
    for w, label, trunc in cands:
        bands.setdefault(int(round(w["top"] / 6.0)), []).append((w, label, trunc))
    # gabungkan pita bertetangga — header sering dua baris ("Kelompok"/"Barang")
    merged: dict[int, list[tuple[dict, str, bool]]] = {}
    for key in sorted(bands):
        target = next((k for k in merged if abs(k - key) <= 3), key)
        merged.setdefault(target, []).extend(bands[key])
    best = max(merged.values(), key=lambda items: len({l for _, l, _ in items}))

    found: dict[str, float] = {}
    truncated: list[str] = []
    for w, label, trunc in sorted(best, key=lambda it: it[0]["x0"]):
        if label in found:
            continue
        if " " in label:  # label dua kata: pastikan kata kedua ada di sebelah/bawah
            second = label.split()[1].lower()
            near = any(
                t2.startswith(second[:4])
                and abs(w2["top"] - w["top"]) < 16
                and 0 <= w2["x0"] - w["x1"] < 45
                for w2, t2 in lowered
            )
            below = any(
                t2.startswith(second[:4])
                and 0 < w2["top"] - w["top"] < 26
                and abs(w2["x0"] - w["x0"]) < 45
                for w2, t2 in lowered
            )
            if not (near or below):
                continue
        found[label] = round(float(w["x0"]), 2)
        if trunc:
            truncated.append(label)
    # batas bawah baris header — dihitung HANYA dari pita header, supaya kata
    # body seperti 'Kelompok dan Gramasi Barang Sama' di kolom Ketentuan
    # tidak ikut mendorong batas ini ke bawah halaman.
    band_top = min(w["top"] for w, _, _ in best)
    band_bottom = max(
        (w["bottom"] for w in page.words if band_top - 4 <= w["top"] <= band_top + 26),
        default=max(w["bottom"] for w, _, _ in best),
    )
    return found, truncated, float(band_bottom)


def check_grid(pages: list[PageView], x_tol: float, edge_margin: float) -> list[Check]:
    c3 = Check("C3_COLUMN_GRID_STABLE", "Posisi kolom identik di semua halaman")
    c4 = Check("C4_NO_EDGE_OVERFLOW", "Tidak ada teks melewati tepi halaman")
    c5 = Check("C5_HEADER_REPEATS", "Header tabel terulang di setiap halaman badan")
    c6 = Check("C6_PAGE_LABEL", "Label 'Hal N' ada dan berurutan")
    c11 = Check("C11_HEADER_NOT_TRUNCATED", "Label header tidak terpotong oleh kolom sempit")

    located = {p.index: locate_headers(p) for p in pages}
    per_page = {i: h for i, (h, _, _) in located.items()}
    for i, (_, trunc, _) in located.items():
        for label in trunc:
            c11.fail(f"halaman {i}: label '{label}' tercetak terpotong "
                     f"(kolom terlalu sempit — kata pecah antar baris)")
    body_pages = [i for i, h in per_page.items() if len(h) >= 3]
    if not body_pages:
        c3.fail("tidak ada halaman yang mengandung header tabel")
        c5.fail("header tabel tidak ditemukan di halaman mana pun")
    else:
        ref_i = body_pages[0]
        ref = per_page[ref_i]
        for i in body_pages:
            cur = per_page[i]
            missing = [h for h in ref if h not in cur]
            extra = [h for h in cur if h not in ref]
            if missing:
                c3.fail(f"halaman {i}: kolom hilang dibanding halaman {ref_i}: {missing}")
            if extra:
                c3.fail(f"halaman {i}: kolom tak terduga: {extra}")
            for h, x in cur.items():
                if h in ref and abs(x - ref[h]) > x_tol:
                    c3.fail(f"halaman {i}: kolom '{h}' bergeser {x - ref[h]:+.1f}pt "
                            f"(x={x:.1f} vs {ref[h]:.1f} di halaman {ref_i})")
        c3.note(f"halaman badan: {body_pages}; kolom acuan: {sorted(ref)}")

        # C5 — seluruh REQUIRED_HEADERS wajib ada di tiap halaman badan
        for i in body_pages:
            miss = [h for h in REQUIRED_HEADERS if h not in per_page[i]]
            if miss:
                c5.fail(f"halaman {i}: header wajib tidak terbaca: {miss}")

    # C4 — overflow
    for p in pages:
        right_limit = p.width - edge_margin
        over = [w for w in p.words if w["x1"] > right_limit or w["x0"] < 0]
        if over:
            sample = ", ".join(f"'{w['text']}'@x1={w['x1']:.1f}" for w in over[:4])
            c4.fail(f"halaman {p.index}: {len(over)} kata melewati tepi "
                    f"(limit {right_limit:.1f}): {sample}")

    # C6 — Hal N
    for p in pages:
        m = PAGE_LABEL_RE.search(p.text)
        if not m:
            c6.fail(f"halaman {p.index}: tidak ada label 'Hal N'")
        elif int(m.group(1)) != p.index:
            c6.fail(f"halaman {p.index}: label tertulis 'Hal {m.group(1)}'")

    return [c3, c4, c5, c6, c11]


# --------------------------------------------------------------------------
# C7 / C8 — kelompok barang & gramasi
# --------------------------------------------------------------------------

def split_tails(cell: str) -> list[str]:
    cell = _norm(cell)
    if not cell:
        return []
    parts = [p.strip() for p in TAIL_SPLIT_RE.split(cell) if p.strip()]
    return parts


def parse_kelompok_cell(cell: str) -> tuple[str, list[str]]:
    """'BLAGIO HM - EDP, CLAY & ROLL ON' -> ('BLAGIO HM', ['EDP','CLAY','ROLL ON'])."""
    cell = _norm(cell).upper()
    if " - " in cell:
        prefix, rest = cell.split(" - ", 1)
        return _norm(prefix), split_tails(rest)
    return "", ([cell] if cell else [])


def extract_column_cells(pages: list[PageView], label: str) -> list[tuple[int, str]]:
    """Ambil teks kolom `label` per baris-visual.

    Batas kolom diambil dari x0 header `label` sampai x0 header berikutnya.
    Baris dibentuk dengan mengelompokkan kata berdasarkan `top` (toleransi 3pt),
    lalu baris-baris berdekatan yang masih satu sel digabung oleh pemanggil.
    """
    out: list[tuple[int, str]] = []
    for p in pages:
        hdrs, _, header_bottom = locate_headers(p)
        if label not in hdrs:
            continue
        xs = sorted(hdrs.values())
        x0 = hdrs[label]
        nxt = [x for x in xs if x > x0 + 1]
        x1 = min(nxt) if nxt else p.width
        cell_words = [
            w for w in p.words
            if x0 - 2 <= w["x0"] < x1 - 2 and w["top"] > header_bottom + 2
        ]
        # kelompokkan per baris visual
        lines: dict[int, list[dict]] = {}
        for w in cell_words:
            key = int(round(w["top"] / 3.0))
            lines.setdefault(key, []).append(w)
        ordered = [
            " ".join(w["text"] for w in sorted(ws, key=lambda w: w["x0"]))
            for _, ws in sorted(lines.items())
        ]
        for line in ordered:
            if line.strip():
                out.append((p.index, line.strip()))
    return out


def check_semantics(rows: list[dict] | None, master: Master) -> list[Check]:
    """C7/C8/C12 — dijalankan atas SIDECAR JSON, bukan hasil bongkar PDF.

    Membongkar sel tabel dari PDF hasil ReportLab terbukti rapuh: teks kolom
    tetangga ('All Variant') bocor ke rentang-x kolom Kelompok dan menghasilkan
    temuan palsu. Karena itu generator WAJIB menulis sidecar JSON berisi baris
    persis seperti yang dirender; verifikasi semantik memakai data itu.
    """
    c7 = Check("C7_KELOMPOK_RESOLVABLE",
               "Setiap kelompok tercetak terpetakan ke 'Nama KLP' di master")
    c8 = Check("C8_GRAMASI_ALIGNED",
               "Gramasi sejajar 1:1 dengan tail kelompok, dan nyata di master")
    c12 = Check("C12_CODE_IN_RIGHT_KELOMPOK",
                "Setiap kode barang berada di kelompok yang benar menurut master")

    if rows is None:
        for c in (c7, c8, c12):
            c.note("tidak ada --rows: generator belum meng-emit sidecar JSON. "
                   "Tambahkan itu — semantik tidak boleh diverifikasi dengan "
                   "menebak posisi teks di PDF.")
        return [c7, c8, c12]
    if not master.kelompok:
        for c in (c7, c8, c12):
            c.note("master kosong — dilewati")
        return [c7, c8, c12]

    for row in rows:
        no = row.get("no", "?")
        kel_cell = _norm(row.get("kelompok", ""))
        gram_cell = _norm(row.get("gramasi", ""))
        codes = [str(c).upper() for c in (row.get("kode_barangs") or [])]
        held = bool(row.get("held"))

        if held or not kel_cell:
            # baris tertahan: justru WAJIB kosong — menebak kelompok itu cacat
            if kel_cell or gram_cell:
                c7.fail(f"baris {no}: baris tertahan tapi Kelompok/Gramasi terisi "
                        f"('{kel_cell}' / '{gram_cell}') — ini tebakan, bukan data")
            continue

        prefix, tails = parse_kelompok_cell(kel_cell)
        if not tails:
            c7.fail(f"baris {no}: kolom Kelompok kosong padahal baris tidak ditahan")
            continue
        full_names = [f"{prefix} {t}".strip() if prefix else t for t in tails]
        for full in full_names:
            if _norm(full).upper() not in master.kelompok:
                c7.fail(f"baris {no}: '{full}' (dari sel '{kel_cell}') tidak ada di "
                        f"kolom 'Nama KLP' master — prefix di-faktor keliru atau "
                        f"kelompok dikarang")

        grams = split_tails(gram_cell)
        if len(grams) != len(tails):
            c8.fail(f"baris {no}: {len(tails)} tail kelompok ({', '.join(tails)}) "
                    f"tapi {len(grams)} nilai gramasi ('{gram_cell}') — "
                    f"pembaca tidak bisa tahu gramasi mana milik kelompok mana")
        else:
            for full, g in zip(full_names, grams):
                known = master.kelompok_to_gramasi.get(_norm(full).upper(), set())
                if known and _norm(g).upper() not in known:
                    c8.fail(f"baris {no}: gramasi '{g}' tidak ada untuk kelompok "
                            f"'{full}' di master (yang ada: {sorted(known)})")

        for code in codes:
            real = master.code_to_kelompok.get(code)
            if real is None:
                c12.fail(f"baris {no}: kode '{code}' tercetak sebagai barang cocok "
                         f"tapi tidak ada di master — seharusnya masuk baris tertahan")
            elif real not in {_norm(f).upper() for f in full_names}:
                c12.fail(f"baris {no}: kode '{code}' sebenarnya kelompok '{real}', "
                         f"tapi dicetak di baris kelompok '{kel_cell}'")

    c7.note(f"{len(rows)} baris diperiksa terhadap {len(master.kelompok)} kelompok master")
    return [c7, c8, c12]


# --------------------------------------------------------------------------
# C9 — coverage kode barang dari surat
# --------------------------------------------------------------------------

def check_code_coverage(pages: list[PageView], master: Master,
                        surat_paths: list[Path]) -> Check:
    c9 = Check("C9_KODE_COVERAGE",
               "Setiap kode barang di surat muncul di Form (tercetak atau ditahan)")
    if not surat_paths:
        c9.note("tidak ada --surat, dilewati")
        return c9

    form_text = " ".join(p.text for p in pages).upper()
    for sp in surat_paths:
        raw = ""
        with pdfplumber.open(sp) as pdf:
            for page in pdf.pages:
                raw += (page.extract_text() or "") + "\n"
        if not raw.strip():
            c9.fail(f"{sp.name}: PDF tanpa layer teks (hasil scan). "
                    f"Coverage kode tidak bisa dibuktikan otomatis — "
                    f"pipeline wajib mencatat extraction_mode=vision dan "
                    f"menyimpan daftar kode hasil ekstraksi untuk diperiksa di sini.")
            continue
        cands = {m.group(0).upper() for m in CODE_CANDIDATE_RE.finditer(raw.upper())}
        # hanya kode yang memang dikenal master ATAU berpola kode barang principal
        codes = {c for c in cands if c in master.codes or re.fullmatch(r"[A-Z]\d{3}[A-Z]{1,3}", c)}
        if not codes:
            c9.note(f"{sp.name}: tidak ada kandidat kode barang terdeteksi")
            continue
        covered, missing = 0, []
        for c in sorted(codes):
            if c in form_text:
                covered += 1
                continue
            # Kode yang COCOK ke master boleh diwakili barisnya: kalau kelompok
            # DAN gramasi-nya tercetak, pembaca masih bisa mengenali barangnya.
            klp = master.code_to_kelompok.get(c)
            gram = master.code_to_gramasi.get(c)
            if klp and klp in form_text and (not gram or gram in form_text):
                covered += 1
                continue
            missing.append(c)
        c9.note(f"{sp.name}: {len(codes)} kode di surat, {covered} terwakili di Form")
        for c in missing:
            if c in master.codes:
                c9.fail(f"{sp.name}: kode '{c}' ada di surat, cocok ke master "
                        f"(kelompok '{master.code_to_kelompok.get(c)}'), tapi baris "
                        f"kelompok/gramasi-nya TIDAK tercetak — barang ini tidak "
                        f"terwakili di lembar")
            else:
                c9.fail(f"{sp.name}: kode '{c}' TIDAK ada di master dan TIDAK tercetak "
                        f"di Form — barang tertahan lenyap tanpa jejak dari lembar "
                        f"yang ditandatangani; kode tertahan wajib disebut literal "
                        f"di kolom Keterangan")
    return c9


# --------------------------------------------------------------------------
# C10 — baris tertahan wajib menyebut kodenya
# --------------------------------------------------------------------------

def check_held_rows(pages: list[PageView], rows: list[dict] | None) -> Check:
    """C10 — setiap kode yang DITAHAN wajib tercetak namanya di lembar.

    Ini invariant yang menangkap cacat merge: ketika dua baris tertahan dilebur,
    'keterangan' hanya milik baris pertama yang tersimpan, sehingga kode kedua
    lenyap dari lembar yang ditandatangani.
    """
    c10 = Check("C10_HELD_CODE_PRINTED",
                "Setiap kode yang ditahan tercetak di kolom Keterangan")
    if rows is None:
        c10.note("tidak ada --rows: butuh sidecar JSON untuk tahu kode mana yang ditahan")
        return c10

    form_text = " ".join(p.text for p in pages).upper()
    total = 0
    for row in rows:
        if not row.get("held"):
            continue
        ket = _norm(row.get("keterangan", "")).upper()
        for code in (str(c).upper() for c in (row.get("kode_ditahan") or [])):
            total += 1
            if code not in ket:
                c10.fail(f"baris {row.get('no','?')}: kode ditahan '{code}' tidak "
                         f"disebut di Keterangan baris itu — kemungkinan hilang saat "
                         f"merge (keterangan tidak ikut digabung)")
            elif code not in form_text:
                c10.fail(f"kode ditahan '{code}' ada di data tapi TIDAK tercetak di "
                         f"PDF — pada lembar yang ditandatangani barang ini lenyap")
    c10.note(f"{total} kode tertahan diperiksa")
    return c10


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--form", required=True, type=Path, help="PDF Form Summary hasil generate")
    ap.add_argument("--master", nargs="*", default=[], type=Path, help="MASTER_BARANG_*.xlsx")
    ap.add_argument("--surat", nargs="*", default=[], type=Path, help="PDF surat program sumber")
    ap.add_argument("--rows", type=Path,
                    help="sidecar JSON berisi baris persis seperti yang dirender "
                         "(wajib untuk C7/C8/C10/C12)")
    ap.add_argument("--json", type=Path, help="tulis laporan JSON ke file ini")
    ap.add_argument("--x-tolerance", type=float, default=DEFAULT_X_TOLERANCE)
    ap.add_argument("--edge-margin", type=float, default=DEFAULT_EDGE_MARGIN)
    ap.add_argument("--expect-roles", nargs="*", default=None,
                    help="nama penanda tangan wajib menurut aturan cabang, mis. "
                         "Admin SM 'Kepala Accounting' Claim 'Operational Manager'")
    ap.add_argument("--strict-kelompok", action="store_true",
                    help="kelompok yang tidak terpetakan menjadi FAIL, bukan WARN")
    args = ap.parse_args()

    if not args.form.exists():
        print(f"ERROR: {args.form} tidak ada", file=sys.stderr)
        return 2

    pages = read_pages(args.form)
    if not pages:
        print("ERROR: PDF kosong", file=sys.stderr)
        return 2
    master = load_master([p for p in args.master if p.exists()])

    rows: list[dict] | None = None
    if args.rows and args.rows.exists():
        payload = json.loads(args.rows.read_text(encoding="utf-8"))
        rows = payload.get("rows", payload) if isinstance(payload, dict) else payload

    checks: list[Check] = []
    checks += check_signature(pages, args.edge_margin, args.expect_roles)
    checks += check_grid(pages, args.x_tolerance, args.edge_margin)
    checks += check_semantics(rows, master)
    checks.append(check_code_coverage(pages, master, [p for p in args.surat if p.exists()]))
    checks.append(check_held_rows(pages, rows))

    width = max(len(c.id) for c in checks)
    print(f"\n  {args.form.name} — {len(pages)} halaman, "
          f"master: {len(master.kelompok)} kelompok / {len(master.codes)} kode\n")
    for c in checks:
        mark = "PASS" if c.ok else "FAIL"
        print(f"  [{mark}] {c.id:<{width}}  {c.title}")
        for d in c.details:
            print(f"         - {d}")
    failed = [c for c in checks if not c.ok]
    print()
    if failed:
        print(f"  GATE MERAH — {len(failed)}/{len(checks)} invariant gagal: "
              f"{', '.join(c.id for c in failed)}\n")
    else:
        print(f"  GATE HIJAU — {len(checks)}/{len(checks)} invariant lolos\n")

    if args.json:
        args.json.write_text(json.dumps(
            {"form": str(args.form), "pages": len(pages),
             "checks": [asdict(c) for c in checks],
             "ok": not failed}, indent=2, ensure_ascii=False), encoding="utf-8")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
