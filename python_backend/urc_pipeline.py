"""
urc_pipeline.py

Integration glue between the pure matcher (``urc_matcher.py``) and the
benefit parser (``urc_benefit_parser.py``) for principle URC. Mirrors
``priskila_pipeline.py``'s role but with URC's different letter shape: ONE
benefit applies to the WHOLE surat (parsed once from ``nama_program``),
not a per-row tier, and the matcher already resolves each line to a
SPECIFIC (kelompok, aroma) group rather than a whole kelompok expanded to
"All Variant" -- so rows are merged per KELOMPOK only (no brand-prefix
explode, no variant-qualifier partitioning; those are Priskila-specific
concerns that don't apply here).

Public API:
    apply_urc_matching(rows, master, rules=None) -> list[row]
"""

import uuid
from typing import Dict, List, Optional

import urc_matcher as um
from urc_benefit_parser import parse_program_benefit


def apply_urc_matching(rows: List[Dict], master: List[Dict], rules: Optional[Dict] = None) -> List[Dict]:
    """Resolve + merge URC surat lines into renderer-ready rows.

    ``rows`` are per-item dicts, one per SKU line in the letter's "Details
    SKU" table, each carrying the SAME ``nama_program`` (the letter states
    its benefit once, in the header -- not per row):
        {nama_program, item_description, category, ...}

    Returns a NEW list of merged rows (one per matched kelompok) plus any
    unmatched lines, flagged and never silently dropped -- same safety net
    as Priskila's pipeline.
    """
    if rules is None:
        rules = um.load_rules()

    benefit = None
    merged: Dict = {}
    order: List = []
    unmatched_rows: List[Dict] = []

    for row in rows:
        nama_program = row.get("nama_program", "") or ""
        item_description = row.get("item_description", "") or ""

        if benefit is None:
            benefit = parse_program_benefit(nama_program)

        res = um.resolve_surat_line(item_description, master, rules)

        if res.get("unmatched"):
            ur = dict(row)
            ur["kelompok"] = ""
            ur["kode_barangs"] = ""
            ur["variant"] = ""
            ur["gramasi"] = ""
            ur["ketentuan"] = benefit["tier"]
            ur.setdefault("benefit_type", benefit["benefit_type"])
            ur.setdefault("benefit", benefit["benefit"])
            ur["_matched_items_cache"] = []
            ur["_urc_unmatched"] = True
            ur["id"] = row.get("id") or str(uuid.uuid4())
            unmatched_rows.append(ur)
            continue

        klp = res["kelompok"]
        acc = merged.get(klp)
        if acc is None:
            acc = {
                "kelompok": klp,
                "nama_program": nama_program,
                "aromas": [], "aroma_seen": set(),
                "gramasis": [], "gramasi_seen": set(),
                "skus": [], "sku_seen": set(),
            }
            merged[klp] = acc
            order.append(klp)

        aroma = res.get("aroma") or ""
        if aroma and aroma not in acc["aroma_seen"]:
            acc["aroma_seen"].add(aroma)
            acc["aromas"].append(aroma)

        for it in res.get("rows", []):
            g = str(it.get("gramasi", "")).strip()
            if g and g not in acc["gramasi_seen"]:
                acc["gramasi_seen"].add(g)
                acc["gramasis"].append(g)
            kb = str(it.get("kode_barang", "")).strip()
            if kb and kb not in acc["sku_seen"]:
                acc["sku_seen"].add(kb)
                acc["skus"].append(it)

    if benefit is None:
        benefit = {"tier": "Beli 1", "benefit_type": "", "benefit": ""}

    # Meta surat diambil dari baris pertama (URC: header surat -> nilai sama
    # utk semua baris): surat_program & periode dari kop, channel dari baris
    # "Area Program", syarat_claim dari "Mekanisme Kontrol & klaim".
    _first = rows[0] if rows else {}
    syarat_claim = str(_first.get("syarat_claim", "") or "").strip()
    meta = {
        "principle": _first.get("principle", ""),
        "surat_program": _first.get("surat_program", ""),
        "periode": _first.get("periode", ""),
        "channel_gtmt": _first.get("channel_gtmt", ""),
        "syarat_claim": syarat_claim,
        # Aturan user 2026-07-17: surat TANPA syarat klaim tidak boleh lolos
        # diam-diam -- flag mencolok utk dikonfirmasi manusia.
        "keterangan": "" if syarat_claim else
                      "SYARAT KLAIM TIDAK DITEMUKAN DI SURAT -- wajib konfirmasi manual",
    }

    # Label variant per kelompok: "All Variant" HANYA bila aroma yang di-
    # resolve surat mencakup SEMUA aroma master utk kelompok itu pada
    # gramasi-gramasi yang diklaim; selain itu sebutkan aromanya (jujur,
    # jangan mengklaim lebih luas dari isi surat).
    def _variant_label(acc) -> str:
        klp_canon = um._canon(acc["kelompok"], rules)
        grams = {um._norm_gramasi_value(g) for g in acc["gramasis"]}
        master_aromas = {
            um._canon(m.get("variant", ""), rules)
            for m in master
            if um._canon(m.get("kelompok", ""), rules) == klp_canon
            and um._norm_gramasi_value(m.get("gramasi", "")) in grams
        } - {""}
        got = {um._canon(a, rules) for a in acc["aromas"]} - {""}
        if not master_aromas or got >= master_aromas:
            return "All Variant"
        return ", ".join(acc["aromas"])

    # SATU BARIS PER KELOMPOK (bukan digabung jadi satu mega-baris): Kelompok/
    # Variant/Gramasi/SKU tetap terpisah per kelompok supaya tetap bisa
    # ditelusuri (kalau satu kelompok salah resolve atau OCR kehilangan satu
    # kelompok, itu kelihatan sbg baris tersendiri, bukan tertimbun dalam satu
    # sel gabungan). Kolom yang MEMANG identik di semua baris (Ketentuan,
    # Benefit, Channel, Periode, Surat Program, Syarat Claim -- karena URC
    # menyatakan SATU benefit utk SELURUH surat) di-visual-merge (rowspan) oleh
    # renderer PDF/Excel, bukan oleh pipeline ini (keputusan user 2026-07-17:
    # merge kolom yang sama, pisahkan kolom kelompok yang beda).
    out: List[Dict] = []
    for klp in order:
        acc = merged[klp]
        variant = _variant_label(acc)
        out.append({
            "id": str(uuid.uuid4()),
            "no": str(len(out) + 1),
            "nama_program": acc["nama_program"],
            **meta,
            "kelompok": acc["kelompok"],
            "variant": variant,
            # Lock the renderer to THIS value (routers/summary.py respects
            # these two fields generically, not just for Priskila): without
            # it, the PDF falls back to re-deriving variant names from each
            # matched SKU's RAW master aroma text whenever our computed value
            # isn't exactly "All Variant" -- undoing the aroma synonym merge
            # (e.g. showing "C.CHEESE" and "CREAM CHEESE" as two names for
            # what resolve_surat_line already merged into one product).
            "_priskila_variant_label": True,
            "_priskila_kel_variant": {acc["kelompok"]: variant},
            "gramasi": ",".join(acc["gramasis"]),
            "ketentuan": benefit["tier"],
            "benefit_type": benefit["benefit_type"],
            "benefit": benefit["benefit"],
            "kode_barangs": ",".join(str(it.get("kode_barang", "")).strip() for it in acc["skus"]),
            "_matched_items_cache": acc["skus"],
        })

    for ur in unmatched_rows:
        for _k, _v in meta.items():
            ur.setdefault(_k, _v)
        ur["no"] = str(len(out) + 1)
        out.append(ur)

    return out
