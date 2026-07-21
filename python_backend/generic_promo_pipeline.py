"""
generic_promo_pipeline.py

Matcher deterministik generik (0 API) utk principle FONTERRA & NATUR --
mirror peran ``urc_pipeline.py``/``priskila_pipeline.py`` tapi memakai
matcher token-subset sederhana yang SUDAH disetujui user lewat preview
lokal (``gen_local_preview.py``). LLM di endpoint hanya menyalin STRUKTUR
surat (field ``product_line_text`` verbatim); modul ini yang me-resolve
tiap baris ke master. Baris tak match TIDAK dibuang & TIDAK ditebak --
di-flag ``_urc_unmatched`` + keterangan (aturan inti).

Public API:
    apply_generic_matching(rows, master) -> list[row]
    (rows wajib membawa ``_gen_key`` = "FONTERRA"/"NATUR", distempel router)
"""
import re
import uuid

GRAM_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LTR|L)\b", re.I)
# Sel master kadang memuat DUA gramasi utk kode yang sama (repack), mis.
# "24 PCS X 150ML /135ML" atau "150/135ML" -> keduanya sah, jangan hanya baca yg pertama
# (terbukti: AZALEA Z.OIL ROSEHIP 135ML gagal match padahal ada di master).
GRAM_PAIR_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:KG|GR|G|ML|LTR|L)?\s*/\s*(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LTR|L)\b", re.I)
STOP = {"BELI", "ALL", "VARIANT", "GRATIS", "MUG", "TUMBLER", "BONUS", "GIMMICK", "FON",
        "GR", "KG", "G", "ML", "L", "LTR", "CC", "X", "BOX", "KLG", "PCS", "BTL",
        "DUS", "KRT", "PACK", "SCH", "S", "24'S", "ANTI",
        # kata generik surat ("ALL PRODUK ANLENE") -- tak pernah jadi bagian nama master
        "PRODUK", "SEMUA", "RENCENG", "KARTON"}

RULES = {
    "FONTERRA": {"token_map": {
        "MATERNA": "MATNA",
        # Master menulis "HABATUSSAUDA" (1 B, 2 S), surat "HABBATUSAUDA" -> satukan.
        "HABATUSSAUDA": "HABBATUSAUDA", "HABBATUSSAUDA": "HABBATUSAUDA", "HABBATS": "HABBATUSAUDA",
        "SACHET": "SCH",  # surat GT menulis "SACHET", master "X 120 SCH"
    }, "phrase_map": [],
        # "SCH" biasanya satuan (diabaikan), TAPI di FONTERRA ia membedakan sachet vs
        # box -- surat GT memang menargetkan sachet saja. Token master bertambah, dan
        # karena matching = (token surat) subset (token master), baris surat lama
        # yang tak menyebut sachet tetap cocok seperti sebelumnya.
        "stop_remove": {"SCH"},
        "gram_alias": {"800GR": ["850GR", "825GR"]}},  # koreksi user iter-6
    # NATUR: master & surat pakai singkatan berbeda (master sendiri tak konsisten &
    # ada typo, mis. "BRIGHTENGING", "G.EXRACT"). Peta ini menyatukan KEDUA sisi ke
    # satu bentuk kanonik. Semua alias di bawah DIVERIFIKASI ada padanannya di master
    # (bukan tebakan) -- lihat diagnosa 2026-07-19.
    "NATUR": {"token_map": {
        "HAIR": "H", "SHAMPOO": "SHMP", "SHM": "SHMP", "SHP": "SHMP", "SHAMPO": "SHMP",
        "MEN": "MAN", "ZAITUN": "Z",
        "ROSEHIP": "ROSHIP", "ROSESHIP": "ROSHIP",
        "HABBATS": "HABBATUSAUDA", "HABBATUSSAUDA": "HABBATUSAUDA",
        "ALOEVERA": "ALOE", "ALOVERA": "ALOE", "VERA": "ALOE", "AVERA": "ALOE",
        "OLIVEOIL": "OLIVE", "EXTRACT": "EXT", "EXRACT": "EXT", "EXTRCT": "EXT",
        "FACIAL": "F",
        "ANTIDANDRUFF": "DANDRUFF", "VITE": "VIT",
        # Singkatan varian HG di surat -> bentuk master (nilai boleh multi-token).
        "BRIGHTENGING": "BRIGHT", "BRIGHTENING": "BRIGHT",
        "CLEANSING": "CLEAN", "DEEP": "D",
        "DC": "D CLEAN", "OC": "OIL CONTROL",
    }, "phrase_map": [
        # Master menyingkat Ginseng jadi "G." ("SHMP Z.OIL&G.EXRACT 180ML"). Tak bisa
        # lewat token_map: token "G" bentrok dgn satuan gram yang ada di STOP.
        (r"\bG\.\s*EX+T?RA?C?T\b", "GINSENG EXT"),
        # "HAIR RECOVERY SERUM X" = lini master "H.RECOVERY X" (master sendiri menulis
        # "NTR HAIR RECOVERY SERUM ALMOND & ARGAN OIL" -> SERUM kata deskriptif lini ini,
        # bukan produk berbeda). Dibatasi frasa supaya "NATUR HAIR SERUM" (NTR01) tak kena.
        (r"\bRECOVERY\s+SERUM\b", "RECOVERY"),
        # Surat menulis "2IN1 SHAMPOO & (HAIR) TONIC <varian>"; master cukup "2IN1 <varian>".
        (r"\b2\s*IN\s*1\s+SHAMPOO\s*&?\s*(?:HAIR\s+)?TONIC\b", "2IN1"),
        # HG = lini pria; master menulis "FOR MAN" hanya di shampoo/tonic, tidak di
        # facial wash. "FOR MEN/MAN" karena itu bukan pembeda produk -> buang.
        (r"\bFOR\s+(?:MEN|MAN)\b", " "),
        # Surat menulis "HAIR VIT ALOVERA VIT E", tapi master tak punya kombinasi
        # Aloe Vera + Vit.E (yang ada: ALOE VERA VIT.B5 dan OLIVE OIL VIT.E).
        # Keputusan user 2026-07-19: yang dimaksud = OLIVE OIL VIT.E. Dibatasi ke
        # "VIT E" supaya varian "ALOVERA VIT B5" yang sah tidak ikut dialihkan.
        (r"\bH(?:AIR)?\s*\.?\s*VIT\s+(?:ALOE\s*VERA|ALOVERA|ALOEVERA|AVERA)\s+VIT\.?\s*E\b",
         "HAIR VIT OLIVE OIL VIT E"),
        # "ACNE CR&OC" = master "ACNE & OIL CONTROL"; "CR" tak punya padanan di master.
        # OCR tidak konsisten membaca "&OC" vs "&DC" (terbukti 2 run live berbeda) --
        # aman disatukan karena master HANYA punya SATU F.WASH ber-ACNE.
        (r"\bACNE\s+CR\s*&\s*[OD]C\b", "ACNE OIL CONTROL"),
        (r"\bACNE\s+CR\b", "ACNE"),
    ], "gram_alias": {}},
    # ADNA = principle GUMINDO (Bogamanis). Surat menyebut merek "Kuaci Rebo" +
    # gramasi + "varian apa saja"; master menamai per-varian ("KUACI ORIGINAL 150GR",
    # kelompok "KUACI - REBO"). Buang kata REBO supaya baris surat resolve ke SEMUA
    # varian pada gramasi itu -- persis maksud surat, bukan tebakan.
    "ADNA": {"token_map": {}, "phrase_map": [(r"\bKUACI\s+REBO\b", "KUACI")],
             "gram_alias": {}},
    # FORISA (Pop Ice / Nutrijell / Top Ice dll).
    "FORISA": {"token_map": {
        # Surat memakai nama Inggris, master memakai nama Indonesia (varian master
        # "POP ICE UYU PISANG" -- terverifikasi ada, bukan tebakan).
        "BANANA": "PISANG",
        # "REGULER" tak pernah ditulis di nama master -> buang tokennya, cakupannya
        # ditegakkan lewat exclude_if di bawah.
        "REGULER": "",
    }, "phrase_map": [],
        # Keputusan user 2026-07-19: "NUTRIJELL REGULER" = lini NUTRIJELL polos SAJA
        # (18 SKU), BUKAN Ekonomi/Yoghurt/Balanced Colour. Master tak menandai lini
        # polos, jadi cakupan ditegakkan dgn menolak nama master yang memuat penanda
        # lini lain -- eksplisit, bukan menghapus kata lalu berharap.
        "exclude_if": [(r"\bNUTRIJELL\s+REGULER\b", {"EKONOMI", "YOGHURT", "BALANCED", "COLOUR"})],
        "gram_alias": {}},
}

DEFAULT_RULES = {"token_map": {}, "phrase_map": [], "gram_alias": {}}

META_FIELDS = ("principle", "surat_program", "nama_program", "periode",
               "channel_gtmt", "syarat_claim")

# Koreksi user 2026-07-19 (berlaku SEMUA principle): satuan pembelian di surat harus
# disamakan dgn satuan master barang -- cs/ctn/dus = KRT.
UNIT_MAP = {"CS": "KRT", "CTN": "KRT", "CARTON": "KRT", "KARTON": "KRT",
            "DUS": "KRT", "DOS": "KRT", "CASE": "KRT"}

# Koreksi user 2026-07-19: Summary Promo HANYA memuat program diskon (%/Rp), bonus
# BARANG, dan on-faktur. Program merchandise/visibility (gimmick, spin wheel, tumbler,
# mug, sewa pajangan, hanger) TIDAK dimasukkan -- bukan dibuang diam-diam: jumlah &
# isinya dilaporkan lewat `apply_generic_matching(..., dropped=[])`.
OUT_OF_SCOPE = ("MUG", "TUMBLER", "GIMMICK", "SPIN WHEEL", "SPINWHEEL", "PAYUNG",
                "KAOS", "TOPI", "GELAS", "PIRING", "VOUCHER", "LAMPION", "HANGER",
                "PAJANGAN", "SEWA", "VISIBILITY", "BANDID", "STICKER", "SPANDUK")
IN_SCOPE_HINT = ("%", "RP", "DISC", "GRATIS", "BONUS", "ON FAKTUR", "POT HARGA", "+")
# Penanda "berlaku untuk SELURUH produk principle" (mis. tier grosir Fonterra:
# "yang penting nilai transaksi cukup" -- tidak menyebut SKU tertentu).
ALL_PRODUCTS = "*ALL*"


def norm_unit(text):
    """Samakan satuan surat dgn satuan master (cs/ctn/dus -> KRT)."""
    def _rep(m):
        return UNIT_MAP.get(m.group(0).upper(), m.group(0))
    return re.sub(r"\b(" + "|".join(UNIT_MAP) + r")\b", _rep, str(text or ""), flags=re.I)


def in_scope(benefit, produk=""):
    """True bila baris ini termasuk cakupan Summary Promo (lihat OUT_OF_SCOPE).

    Diperiksa pada benefit DAN produk: "SEWA PAJANGAN" berbenefit "DISC. 1%"
    tetap di luar cakupan karena objeknya jasa display, bukan barang dagangan.

    Benefit yang TIDAK TERBACA bukan alasan membuang: itu ketidaktahuan parser,
    bukan bukti di-luar-cakupan. Baris begitu tetap masuk supaya ter-flag &
    direview manusia (aturan inti: jangan buang, jangan tebak).
    """
    b = " ".join(str(benefit or "").upper().split())
    p = " ".join(str(produk or "").upper().split())
    if any(g in b or g in p for g in OUT_OF_SCOPE):
        return False
    if not b or "TIDAK TERTERA" in b or "TIDAK TERBACA" in b:
        return True
    return any(h in b for h in IN_SCOPE_HINT)


def _fmt_g(num, unit):
    num = num.replace(",", ".")
    if "." in num:
        num = num.rstrip("0").rstrip(".")
    return num + unit.upper()


def norm_g(s):
    """Gramasi UTAMA (pertama) dari sebuah string; "" bila tak ada."""
    m = GRAM_RE.search(s or "")
    return _fmt_g(m.group(1), m.group(2)) if m else ""


def norm_gs(s):
    """SEMUA gramasi yang sah utk string ini: yang pertama + pasangan "A/B unit"."""
    s = s or ""
    out = set()
    g = norm_g(s)
    if g:
        out.add(g)
    for m in GRAM_PAIR_RE.finditer(s):
        out.add(_fmt_g(m.group(1), m.group(3)))
        out.add(_fmt_g(m.group(2), m.group(3)))
    return out


def toks(s, rules_or_tmap):
    # Terima RULES lengkap (punya phrase_map) atau token_map polos (kompatibilitas).
    if isinstance(rules_or_tmap, dict) and "token_map" in rules_or_tmap:
        tmap = rules_or_tmap.get("token_map", {})
        phrases = rules_or_tmap.get("phrase_map", [])
        stop = STOP - set(rules_or_tmap.get("stop_remove", ()))
    else:
        tmap, phrases, stop = rules_or_tmap, [], STOP
    s = (s or "").upper()
    for pat, rep in phrases:
        s = re.sub(pat, rep, s)
    s = re.sub(r"(?<=[A-Z])(?=\d)|(?<=\d)(?=[A-Z])", " ", s)  # pisah glued mis. EXTRACT140ML
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    out = set()
    for w in s.split():
        if w in stop or w.isdigit() or GRAM_RE.fullmatch(w):
            continue
        out.update(tmap.get(w, w).split())  # nilai alias boleh multi-token (mis. OC -> OIL CONTROL)
    return out


def match_line(prod, rules, items):
    """items sudah ber-anotasi _toks/_gs (lihat prepare_items)."""
    want = toks(prod, rules)
    # Baris surat boleh menyebut lebih dari satu gramasi ("Kuaci 150 gr/ 140 gr")
    # -> semuanya sah untuk baris itu.
    grams = set()
    for g in norm_gs(prod):
        grams |= set(rules["gram_alias"].get(g, [g]))
    # Penanda lini yang HARUS ditolak utk baris ini (mis. "NUTRIJELL REGULER"
    # tidak mencakup Ekonomi/Yoghurt/Balanced Colour).
    banned = set()
    _up = (prod or "").upper()
    for pat, bad in rules.get("exclude_if", []):
        if re.search(pat, _up):
            banned |= set(bad)
    return [it for it in items
            if want and want <= it["_toks"] and (not grams or (grams & it["_gs"]))
            and not (banned & it["_toks"])]


def prepare_items(master, rules):
    out = []
    for it in master:
        it2 = dict(it)
        nama = it2.get("nama_barang", "")
        it2["_toks"] = toks(nama, rules)
        it2["_gs"] = norm_gs(nama) or norm_gs(str(it2.get("gramasi", "")))
        it2["_g"] = norm_g(nama) or norm_g(str(it2.get("gramasi", "")))  # label tampilan
        out.append(it2)
    return out


def build_row(no, meta, prod, hits, ketentuan, benefit):
    if not hits:
        return {"id": str(uuid.uuid4()), "no": str(no), **meta,
                "kelompok": prod.upper(), "variant": "", "gramasi": norm_g(prod),
                "ketentuan": ketentuan, "benefit_type": "", "benefit": benefit,
                "kode_barangs": "", "_matched_items_cache": [], "_urc_unmatched": True,
                "keterangan": "UNMATCHED -- tidak ditemukan di master, wajib review manual"}
    kel = hits[0].get("kelompok", "")
    variants = list(dict.fromkeys(str(h.get("variant", "")).strip() for h in hits if str(h.get("variant", "")).strip()))
    # Gramasi yang ditampilkan: yang DIKLAIM surat bila kode master memang melayani
    # gramasi itu (sel master repack "150ML /135ML" -> tampilkan 135ML saat surat 135ML),
    # selain itu gramasi utama master.
    _want_gs = norm_gs(prod)
    grams = list(dict.fromkeys(
        (sorted(_want_gs & h.get("_gs", set()))[0] if (_want_gs & h.get("_gs", set())) else h["_g"])
        for h in hits if h.get("_g") or _want_gs))
    vlabel = ", ".join(variants) if len(variants) <= 3 else "All Variant"
    return {"id": str(uuid.uuid4()), "no": str(no), **meta,
            "kelompok": kel, "variant": vlabel,
            "_priskila_variant_label": True, "_priskila_kel_variant": {kel: vlabel},
            "gramasi": ",".join(grams),
            "ketentuan": ketentuan, "benefit_type": "", "benefit": benefit,
            "kode_barangs": ",".join(str(h.get("kode_barang", "")).strip() for h in hits),
            "_matched_items_cache": [{k: v for k, v in h.items() if not k.startswith("_")} for h in hits]}


def _parse_fonterra_line(body):
    """'> BELI 2 ANMUM MATERNA ... GRATIS MUG' -> (produk, tier, benefit)."""
    body = " ".join(str(body or "").split()).lstrip("> ").strip()
    mt = re.search(r"BELI\s+(\d+)", body, re.I)
    tier = f"Beli {mt.group(1)}" if mt else "Beli 1"
    mb = re.search(r"GRATIS\s+(.+)$", body, re.I)
    benefit = ("GRATIS " + mb.group(1).strip()) if mb else "(benefit tidak tertera di teks surat -- konfirmasi)"
    prod = re.split(r"\bGRATIS\b", body, flags=re.I)[0]
    prod = re.sub(r"^BELI\s+\d+", "", prod, flags=re.I)
    prod = re.sub(r"\bALL\s+VARIANT\b", "", prod, flags=re.I).strip()
    return prod, tier, benefit


def _ket_ben(row):
    """Ketentuan & benefit dari kolom minimal_order/discount surat.
    Satuan surat dipertahankan bila disebut (mis. "2 ctn"); bila hanya angka
    (pola NATUR ">= 6") default ke pcs."""
    mo = re.sub(r"^[≥>=\s]+", "", str(row.get("minimal_order", "") or "").strip()).strip()
    mo = norm_unit(mo)   # cs/ctn/dus -> KRT (samakan dgn master)
    if re.search(r"[A-Za-z]", mo):
        ket = f"Min {' '.join(mo.split())}"
    else:
        d = re.sub(r"[^\d]", "", mo)
        ket = f"Min {d} pcs" if d else "Beli 1"
    disc = " ".join(str(row.get("discount", "") or "").split())
    ben = disc if disc else "(diskon per SKU tidak terbaca dari surat -- review manual)"
    return ket, ben


def apply_generic_matching(rows, master, dropped=None):
    """Structure-only rows (product_line_text + meta) -> renderer-ready rows.

    Baris yang produknya tak ketemu di master TIDAK dibuang -- di-flag UNMATCHED.
    Yang memang di luar cakupan Summary Promo (merchandise/visibility, lihat
    ``in_scope``) dikeluarkan atas permintaan user, dan dicatat ke list
    ``dropped`` supaya tetap bisa dipertanggungjawabkan (bukan hilang diam-diam).
    """
    key = next((r.get("_gen_key") for r in rows if r.get("_gen_key")), "")
    rules = RULES.get(key) or DEFAULT_RULES
    items = prepare_items(master, rules)

    _first = rows[0] if rows else {}
    syarat = str(_first.get("syarat_claim", "") or "").strip()
    meta = {k: _first.get(k, "") for k in META_FIELDS}
    # Aturan user 2026-07-17: surat tanpa syarat klaim tidak boleh lolos diam-diam.
    meta["keterangan"] = "" if syarat else \
        "SYARAT KLAIM TIDAK DITEMUKAN DI SURAT -- wajib konfirmasi manual"

    out, seen = [], {}
    for r in rows:
        line = str(r.get("product_line_text", "") or "")
        if key == "FONTERRA":
            prod, ket, ben = _parse_fonterra_line(line)
        else:
            prod = " ".join(line.split())
            ket, ben = _ket_ben(r)

        # FONTERRA menuliskan program sebagai bullet naratif; bullet yang tidak
        # menyatakan hadiah/diskon sama sekali hanyalah DAFTAR PRODUK peserta
        # mekanisme voucher/spin-wheel -- bukan baris program (koreksi user
        # 2026-07-19). Jalur lokal menyaringnya di parser; jalur live perlu ini
        # karena LLM menyalin semua bullet apa adanya.
        if key == "FONTERRA" and not re.search(r"\bGRATIS\b|\bDISC|%|POT\s+HARGA", line, re.I):
            if dropped is not None:
                dropped.append({"produk": prod, "ketentuan": ket, "benefit": ben,
                                "alasan": "bukan baris promo (bullet tak menyatakan hadiah/diskon)"})
            continue

        if not in_scope(ben, prod):
            if dropped is not None:
                dropped.append({"produk": prod, "ketentuan": ket, "benefit": ben,
                                "alasan": "di luar cakupan (bukan diskon/bonus barang/on-faktur)"})
            continue

        # Baris identik setelah normalisasi satuan = program yang sama ditulis dua
        # kali (mis. surat approval memuat draft+final: "5 dus" & "5 CS" -> "5 KRT").
        sig = (str(r.get("surat_program", "")), prod.upper(), ket.upper(),
               " ".join(ben.upper().split()))
        if sig in seen:
            if dropped is not None:
                dropped.append({"produk": prod, "ketentuan": ket, "benefit": ben,
                                "alasan": "duplikat baris identik (setelah satuan disamakan)"})
            continue
        seen[sig] = True

        hits = list(items) if prod.strip().upper() in (ALL_PRODUCTS, "") else match_line(prod, rules, items)
        out.append(build_row(len(out) + 1, meta, prod if prod.strip() else ALL_PRODUCTS, hits, ket, ben))

    if key == "FONTERRA":  # keputusan user: seluruh FONTERRA wajib review manual
        for r in out:
            # Flag wajib TIDAK boleh menutupi info "tak ketemu di master" -- keduanya ditulis.
            r["keterangan"] = "PERLU REVIEW MANUAL" + (
                " -- TIDAK ADA ITEM COCOK DI MASTER" if r.get("_urc_unmatched") else "")
    return out

