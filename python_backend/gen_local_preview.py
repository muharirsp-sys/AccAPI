"""Preview LOKAL (0 API) via RENDERER PRODUKSI (summary_manual_generate) --
template Form_Summary.pdf + Dataset_Diskon.xlsx persis URC/Priskila.
Principle: FONTERRA (surat MTI) + NATUR (4 surat -> SATU summary).
Baris di-resolve dulu ke master (aturan siapa-tak-match = flag, bukan tebak)."""
import sys, os, io, json, re, uuid, tempfile, shutil
sys.path.insert(0, r"D:\AccAPI\_github_clean\python_backend")
import fitz
import shared
import routers.summary as backend
import ocr_cache, parse_cache, golden_store
from starlette.datastructures import Headers

_tmp = tempfile.mkdtemp(prefix="gen_local_")
ocr_cache._CACHE_DIR = os.path.join(_tmp, "ocr")
parse_cache._CACHE_DIR = os.path.join(_tmp, "parse")
golden_store._STORE_PATH = os.path.join(_tmp, "golden.jsonl")
backend.get_current_user = lambda req: "betterauth|admin|test@local"
backend.user_has_permission = lambda *a, **k: True
backend.validate_csrf_request = lambda req, token: True

class FakeRequest:
    headers = Headers({})
    cookies = {}

SP = r"D:\AccAPI\_github_clean\reference_surat_program"
RM = r"D:\AccAPI\_github_clean\python_backend\data\rebuild_master"
OUT = os.path.dirname(os.path.abspath(__file__))

# Matcher core dipindah ke generic_promo_pipeline.py (dipakai juga jalur LIVE
# di routers/summary.py via _apply_native_kelompok) -- satu sumber kebenaran.
from generic_promo_pipeline import (ALL_PRODUCTS, GRAM_RE, RULES, STOP, _ket_ben,
                                    build_row as mkrow, in_scope,
                                    match_line as _core_match_line, norm_g, norm_unit,
                                    prepare_items, toks)


def load_master(principle):
    path = os.path.join(RM, f"MASTER BARANG {principle}.xlsx")
    with open(path, "rb") as f:
        kel, vmap, gmap, items = shared._parse_master_barang_xlsx(f.read())
    items = prepare_items(items, RULES[principle])
    tok = f"local-{principle.lower()}"
    shared.MANUAL_MASTER_CACHE[tok] = {"kelompok": kel, "variant_map": vmap,
                                       "gramasi_map": gmap, "items": items, "customers": []}
    return tok, items


def match_line(prod, principle, items):
    return _core_match_line(prod, RULES[principle], items)



def parse_fonterra():
    doc = fitz.open(os.path.join(SP, "MTI Surya Perkasa - Makassar.pdf"))
    lines = [" ".join(l.split()) for p in doc for l in p.get_text().splitlines() if l.strip()]
    syarat = "; ".join(dict.fromkeys(l.strip("> ").strip() for l in lines
                                     if "WAJIB MELAMPIRKAN" in l.upper() or "SURAT KERJASAMA" in l.upper()))
    meta = {"principle": "FONTERRA", "surat_program": "MTI Surya Perkasa - Makassar",
            "nama_program": "BONUS GIMMICK (01 - 31 JULI 2025)", "periode": "01 - 31 JULI 2025",
            "channel_gtmt": "MTI", "syarat_claim": syarat,
            "keterangan": "" if syarat else "SYARAT KLAIM TIDAK DITEMUKAN DI SURAT -- wajib konfirmasi manual"}
    out = []
    for ln in lines:
        # Hanya bullet yang menyatakan HADIAH ("... GRATIS ...") yang merupakan baris
        # promo. Bullet lain di surat ini cuma daftar produk peserta mekanisme
        # voucher/spin-wheel -- bukan baris program (koreksi user 2026-07-19).
        if not ln.lstrip().startswith(">") or not re.search(r"\bGRATIS\b", ln, re.I):
            continue
        body = ln.lstrip("> ").strip()
        mt = re.search(r"BELI\s+(\d+)", body, re.I)
        tier = f"Beli {mt.group(1)}" if mt else "Beli 1"
        mb = re.search(r"GRATIS\s+(.+)$", body, re.I)
        benefit = ("GRATIS " + mb.group(1).strip()) if mb else "(benefit tidak tertera di teks surat -- konfirmasi)"
        prod = re.split(r"\bGRATIS\b", body, flags=re.I)[0]
        prod = re.sub(r"^BELI\s+\d+", "", prod, flags=re.I)
        prod = re.sub(r"\bALL\s+VARIANT\b", "", prod, flags=re.I).strip()
        out.append((prod, tier, benefit))
    return meta, out


NATUR_FILES = ["Surat Program.pdf", "surat program bonus.pdf", "surat program feb.pdf", "surat program mix.pdf"]
ITEM_RE = re.compile(r"\d+\s*(ML|GR)\b", re.I)


def parse_natur(fname):
    doc = fitz.open(os.path.join(SP, fname))
    lines = [" ".join(l.split()) for p in doc for l in p.get_text().splitlines() if l.strip()]
    no = next((l for l in lines if l.startswith("PROID")), fname)
    periode = ""
    for i, l in enumerate(lines):
        if "PERIODE" in l.upper() and i + 1 < len(lines):
            m = re.search(r":\s*(.+)$", l) or re.search(r"^(.*\d{4}.*)$", lines[i + 1])
            if m and re.search(r"\d{4}", m.group(1)):
                periode = m.group(1).strip(); break
    chan = "MTI" if "/MTI/" in no else ("GT" if "/GT/" in no else ("ONLINE" if "/ONLINE/" in no else ""))
    nama_prog = ""
    for i, l in enumerate(lines):
        if l.strip().upper() == "NAMA PROGRAM" and i + 1 < len(lines):
            nama_prog = lines[i + 1].strip(); break
    syarat = "; ".join(dict.fromkeys(l.strip() for l in lines if "MAKSIMAL DIKLAIM" in l.upper()))
    meta = {"principle": "NATUR (GONDOWANGI)", "surat_program": no, "nama_program": nama_prog,
            "periode": periode, "channel_gtmt": chan, "syarat_claim": syarat,
            "keterangan": "" if syarat else "SYARAT KLAIM TIDAK DITEMUKAN DI SURAT -- wajib konfirmasi manual"}
    items = []
    for i, l in enumerate(lines):
        if not (ITEM_RE.search(l) and re.search(r"[A-Z]{2}", l) and 8 < len(l) < 60):
            continue
        if any(k in l.upper() for k in ("PERIODE", "KLAIM", "PROMO INI", "PEMBELIAN")):
            continue
        minorder, disc = "", ""
        for k in (1, 2, 3):
            if i + k < len(lines) and len(lines[i + k]) < 16:
                nx = lines[i + k]
                if re.match(r"^[≥>=]+\s*\d+", nx):
                    minorder = re.sub(r"[≥>=\s]+", "", nx)
                md = re.search(r"(add\s*disc\s*\d+%|\d+\s*%|\d+\+\d+)", nx, re.I)
                if md:
                    disc = md.group(1)
        ket = f"Min {minorder} pcs" if minorder else "Beli 1"
        ben = disc if disc else "(diskon per SKU tidak terbaca dari teks -- lihat tabel surat / OCR live)"
        items.append((l, ket, ben))
    # dedup baris identik (tabel kadang terbaca 2x)
    seen, out = set(), []
    for it in items:
        if it[0].upper() in seen:
            continue
        seen.add(it[0].upper()); out.append(it)
    return meta, out


def parse_fonterra_gt():
    """Surat GT Surya Perkasa = program TRADE (nilai transaksi / sewa pajangan /
    hanger), bukan promo per-SKU. Keputusan user 2026-07-19: tetap di-generate,
    SEMUA baris di-flag. Produk yang MEMANG tidak disebut di surat dibiarkan tak
    match (ber-flag) -- jangan diasumsikan "semua produk"."""
    doc = fitz.open(os.path.join(SP, "GT Surya Perkasa - Makassar.pdf"))
    lines = [" ".join(l.split()) for p in doc for l in p.get_text().splitlines() if l.strip()]
    doc.close()

    periode = next((l for l in lines if re.match(r"^\d{2}\s*-\s*\d{2}\s+\w+\s+\d{4}$", l)), "")
    nama_prog = next((l for l in lines if "PROGRAM HANGER PERMANENT (" in l.upper()), "PROMO GT")
    syarat = "; ".join(dict.fromkeys(l for l in lines if "MELAMPIRKAN" in l.upper() or "WAJIB PAKAI SKP" in l.upper()))
    meta = {"principle": "FONTERRA", "surat_program": "F65SP - GT Surya Perkasa - Makassar",
            "nama_program": nama_prog, "periode": periode or "01 - 31 JULI 2025",
            "channel_gtmt": "GT", "syarat_claim": syarat,
            "keterangan": "" if syarat else "SYARAT KLAIM TIDAK DITEMUKAN DI SURAT -- wajib konfirmasi manual"}

    out = []
    for i, l in enumerate(lines):
        u = l.upper()
        nxt = [x for x in lines[i + 1:i + 3] if x.lstrip().startswith(":")]
        disc = " / ".join(x.lstrip(": ").strip() for x in nxt) if nxt else ""

        # a) tier nilai transaksi. Koreksi user: program grosir berlaku utk SELURUH
        # pembelian produk (yang penting nilainya cukup) -> ALL_PRODUCTS, bukan
        # "produk tidak disebut". Sewa pajangan = visibility -> disaring in_scope().
        m = re.search(r"(GROSIR BINTANG[^:(]*|SEWA PAJANGAN[^:(]*)[:(]?\s*(≥\s*[\d.,]+)?", u)
        if m and ("GROSIR BINTANG" in u or "SEWA PAJANGAN" in u) and l.lstrip().startswith(">"):
            trig = m.group(2).strip() if m.group(2) else ""
            ket = f"Min transaksi Rp {trig.lstrip('≥ ').strip()}" if trig else m.group(1).strip().title()
            prod = "SEWA PAJANGAN" if "SEWA" in u else ALL_PRODUCTS
            out.append((prod, ket, disc or "(nilai tidak terbaca -- cek surat)"))
            continue

        # b) hanger/lampion: "PEMBELIAN >= N RENCENG ANLENE & BONEETO SACHET DAPAT POT HARGA ..."
        m = re.search(r"PEMBELIAN\s*[≥>=]+\s*(\d+)\s*RENCENG\s+(.+?)\s+DAPAT\s+(.+)$", u)
        if m:
            qty, prods, benefit = m.group(1), m.group(2), m.group(3)
            # "ANLENE & BONEETO SACHET" = DUA lini produk -> dua baris (surat memang
            # memberlakukan keduanya); jangan digabung jadi satu token-set mustahil.
            kind = "SACHET" if "SACHET" in prods else ""
            merek = [b.strip() for b in re.split(r"&|,", prods.replace("SACHET", "")) if b.strip()]
            for mk in merek or [prods]:
                out.append((f"{mk} {kind}".strip(), f"Min {qty} renceng", benefit.strip()))
            continue

        # c) Pharmacy: "SETIAP PEMBELIAN ALL PRODUK POWDER ( BIB ) > Rp. N,- DISCOUNT X %"
        # Koreksi user: BIB = Box in Box -> seluruh ANLENE kemasan BOX; ambangnya
        # dihitung dari NILAI JUAL (qty x harga), jadi ketentuan berbasis rupiah.
        m = re.search(r"SETIAP PEMBELIAN\s+(.+?)\s*[>≥]\s*RP\.?\s*([\d.,]+).*?DISCOUNT\s*([\d,.]+\s*%)", u)
        if m:
            prod = "ANLENE BOX" if "BIB" in m.group(1) or "POWDER" in m.group(1) else m.group(1).strip()
            out.append((prod, f"Min nilai jual Rp {m.group(2).rstrip('.,')}", f"DISCOUNT {m.group(3)}"))
            continue

        # d) NOO grosir: "MINIMAL TRANSAKSI 5 KARTON PRODUK ANLENE".
        # Koreksi user: penentu NOO = qty 5 karton -> disc 2.5% (BUKAN masuk tier
        # nilai >=800rb, dan bukan insentif salesman yang dicatat sbg benefit).
        m = re.search(r"MINIMAL TRANSAKSI\s+(\d+)\s+KARTON\s+(.+?)\s*\)", u)
        if m:
            out.append((m.group(2).strip(), f"Min {m.group(1)} KRT (NOO)", "DISC. 2.5%"))
            continue
    return meta, out


def parse_adna():
    """Gumindo/ADNA: aturan produk ada di bullet "Mekanisme Program"
    ("Setiap pembelian <produk> (min N ctn) ... disc Rp X/ctn")."""
    doc = fitz.open(os.path.join(SP, "0074-GBM-MKT-V-24-Rev1.pdf"))
    lines = [" ".join(l.split()) for p in doc for l in p.get_text().splitlines() if l.strip()]
    doc.close()

    def after(label):
        for i, l in enumerate(lines):
            if l.strip().rstrip(":").strip().upper() == label.upper():
                for nx in lines[i + 1:i + 3]:
                    v = nx.lstrip(":").strip()
                    if v and v != ":":
                        return v
        return ""

    no = next((l.split(":", 1)[1].strip() for l in lines if l.startswith(":") is False and "/GBM/" in l), "")
    if not no:
        no = next((l.lstrip(": ").strip() for l in lines if "/GBM/" in l), "")
    # syarat klaim = butir bernomor "Mohon dalam klaim mencantumkan" s/d akhir
    try:
        i0 = next(i for i, l in enumerate(lines) if "MOHON DALAM KLAIM" in l.upper())
        i1 = next((i for i, l in enumerate(lines[i0:], i0) if "DEMIKIAN SURAT INI" in l.upper()), len(lines))
        syarat = "; ".join(l for l in lines[i0 + 1:i1] if len(l) > 4 and not l.rstrip().endswith("."))[:600]
    except StopIteration:
        syarat = ""
    meta = {"principle": "ADNA (GUMINDO BOGAMANIS)", "surat_program": no,
            "nama_program": after("Hal"), "periode": after("Berlaku"),
            "channel_gtmt": after("Lokasi"), "syarat_claim": syarat,
            "keterangan": "" if syarat else "SYARAT KLAIM TIDAK DITEMUKAN DI SURAT -- wajib konfirmasi manual"}

    out = []
    for l in lines:
        m = re.search(r"pembelian\s+(.+?)\s*\(\s*min\.?\s*([^)]+?)\s*\)(.*)$", l, re.I)
        if not m:
            continue
        prod, minorder, rest = m.group(1).strip(), m.group(2).strip(), m.group(3)
        mb = re.search(r"(disc[^,;]*)", rest, re.I)
        ket, ben = _ket_ben({"minimal_order": minorder, "discount": mb.group(1).strip() if mb else ""})
        out.append((prod, ket, ben))
    # syarat tambahan (growth) jangan hilang -> ikut ke keterangan surat
    extra = next((l for l in lines if "GROWTH" in l.upper() and "%" in l), "")
    if extra:
        meta["keterangan"] = (meta["keterangan"] + " | " if meta["keterangan"] else "") + \
                             "SYARAT TAMBAHAN: " + extra
    return meta, out


def gen(token, rows):
    return backend.summary_manual_generate(FakeRequest(), token=token, rows_json=json.dumps(rows))


def run(principle, surat_rows_list):
    tok, items = load_master(principle)
    combined, stats, dropped, seen = [], [], [], {}
    for meta, lines in surat_rows_list:
        okc = tot = 0
        for prod, ket, ben in lines:
            ket = norm_unit(ket)          # cs/ctn/dus -> KRT (aturan semua principle)
            if not in_scope(ben, prod):         # gimmick/visibility di luar cakupan
                dropped.append((meta["surat_program"], prod, ket, ben, "di luar cakupan"))
                continue
            # Dedup HANYA dalam surat yang sama -- dua surat berbeda boleh punya baris
            # identik (program bulan/channel lain), itu bukan duplikat.
            sig = (meta.get("surat_program", ""), prod.upper(), ket.upper(),
                   " ".join(ben.upper().split()))
            if sig in seen:
                dropped.append((meta["surat_program"], prod, ket, ben, "duplikat"))
                continue
            seen[sig] = True
            hits = list(items) if prod.strip().upper() == ALL_PRODUCTS else match_line(prod, principle, items)
            combined.append(mkrow(len(combined) + 1, meta, prod, hits, ket, ben))
            tot += 1
            okc += 1 if hits else 0
        stats.append((meta["surat_program"], okc, tot))
    if principle == "FONTERRA":  # keputusan user: seluruh Fonterra wajib review manual
        for r in combined:
            r["keterangan"] = "PERLU REVIEW MANUAL"
    g = gen(tok, combined)
    assert g.get("ok"), g
    outs = shared.MANUAL_OUTPUTS[g["file_id"]]
    pdf = os.path.join(OUT, f"{principle}_Form_Summary.pdf")
    xls = os.path.join(OUT, f"{principle}_Dataset_Diskon.xlsx")
    shutil.copy(outs["form"], pdf); shutil.copy(outs["dataset"], xls)
    print(f"== {principle}: {len(combined)} baris ==")
    for s, ok, tot in stats:
        print(f"   {s[:44]:46s} {ok}/{tot} match")
    if dropped:
        print(f"   -- {len(dropped)} baris TIDAK dimasukkan (dilaporkan, bukan hilang diam-diam):")
        for s, prod, ket, ben, why in dropped:
            print(f"      [{why:14s}] {prod[:38]:40s} | {ket[:14]:16s} | {ben[:34]}")
    print("   ->", pdf); print("   ->", xls)


if __name__ == "__main__":
    fm, fl = parse_fonterra()
    gm, gl = parse_fonterra_gt()
    run("FONTERRA", [(fm, fl), (gm, gl)])
    natur = [parse_natur(f) for f in NATUR_FILES]
    run("NATUR", natur)
    am, al = parse_adna()
    run("ADNA", [(am, al)])
    print("done (0 API)")

