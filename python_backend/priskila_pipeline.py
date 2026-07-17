"""
priskila_pipeline.py

Integration glue between the pure, tested deterministic matcher
(``priskila_matcher.py``) and the promo-summary row pipeline.

Given the structure-only surat lines the LLM emits for principle Priskila
(one dict per surat GROUP ITEM line -- see the Task 9 prompt branch in
``routers/summary.py``), this module:

  1. resolves each line to master SKUs via ``resolve_surat_line`` (no
     guessing -- unmatched lines are kept + flagged, never silently dropped),
  2. derives the promo ``tier`` (and benefit) from the surat ``paket`` cell,
  3. MERGES resolved lines that share the same
     ``(channel_gtmt, brand-prefix, tier, benefit)`` into one display row --
     reproducing the old mega-row style e.g. the four Bellagio "Beli 4" lines
     collapsing into one "BLAGIO HM - BODY SPRAY, CLAY, EDP & ROLL ON" row, and
  4. emits each merged row in the exact shape the PDF/Excel renderer consumes
     (``kelompok``, ``variant``, ``gramasi``, ``kode_barangs``, ``ketentuan``,
     ``_matched_items_cache`` ...), so no downstream regroup/V4 step is needed.

Pure stdlib (json/re/uuid) + ``priskila_matcher``. No network calls.

Public API:
    apply_priskila_matching(rows, master, rules=None) -> list[row]
"""

import re
import uuid
from typing import Dict, List, Optional

import priskila_matcher as pm

_MIX_SUFFIX = " Boleh Mix Kelompok dan Gramasi Barang Sama"


def _prefix_of(kelompok: str) -> str:
    """Brand prefix = the kelompok text before the first ' - '
    (e.g. 'BLAGIO HM - EDT' -> 'BLAGIO HM'). Matches the renderer's
    explode-by-prefix grouping."""
    k = str(kelompok or "").strip()
    return k.split(" - ")[0].strip() if " - " in k else k


def _derive_tier_benefit(paket):
    """Map the surat ``paket`` cell to (tier, benefit_type, benefit).

    - "N + M" (bonus qty)  -> ("Beli N", "BONUS_QTY", "M PCS")
    - rupiah cut-price      -> ("Beli 1", "DISC_RP", "<digits>")  (MTI style)
    - empty / unknown       -> ("Beli 1", "", "")
    """
    p = str(paket or "").strip()
    m = re.match(r"^\s*(\d+)\s*\+\s*(\d+)", p)
    if m:
        return f"Beli {m.group(1)}", "BONUS_QTY", f"{m.group(2)} PCS"
    digits = re.sub(r"[^\d]", "", p)
    if digits:
        return "Beli 1", "DISC_RP", digits
    return "Beli 1", "", ""


def _line_qualifier(text: str, rules: Dict) -> Optional[str]:
    """Return the variant qualifier (e.g. 'SPORT') present in the surat line,
    or None. Qualifiers partition a kelompok, so they surface as the Variant
    label instead of the default 'All Variant'."""
    toks = set(pm._norm(text).split())
    for q in rules.get("variant_qualifiers", []):
        if q in toks:
            return q
    return None


def apply_priskila_matching(rows: List[Dict], master: List[Dict], rules: Optional[Dict] = None) -> List[Dict]:
    """Resolve + merge Priskila surat lines into renderer-ready rows.

    ``rows`` are per-surat-line dicts (structure only):
        {channel_gtmt, brand, group_item_text, paket, cr, principle,
         surat_program, nama_program, periode, ...}

    Returns a NEW list of merged rows; input is not mutated. Unmatched lines
    are emitted individually and flagged (``_priskila_unmatched = True``,
    kelompok blank) so nothing is silently dropped.
    """
    if rules is None:
        rules = pm.load_rules()

    merged: "dict" = {}       # key -> accumulator
    order: List = []          # merge keys, first-appearance order
    unmatched_rows: List[Dict] = []

    for row in rows:
        brand = row.get("brand", "") or ""
        text = row.get("group_item_text", "") or row.get("kelompok", "") or ""
        channel = str(row.get("channel_gtmt", "") or "").strip()
        tier, benefit_type, benefit = _derive_tier_benefit(row.get("paket", ""))
        qualifier = _line_qualifier(text, rules)

        res = pm.resolve_surat_line(brand, text, master, rules)
        sku_list = res.get("sku_list", [])

        if not sku_list:
            # Keep + flag; do NOT guess. Preserve passthrough meta.
            ur = dict(row)
            ur["kelompok"] = ""
            ur["kode_barangs"] = ""
            ur["variant"] = row.get("variant", "") or "All Variant"
            ur["gramasi"] = ""
            ur["ketentuan"] = tier
            ur.setdefault("benefit_type", benefit_type)
            ur.setdefault("benefit", benefit)
            ur["_matched_items_cache"] = []
            ur["_priskila_unmatched"] = True
            ur["id"] = row.get("id") or str(uuid.uuid4())
            unmatched_rows.append(ur)
            continue

        # Partition this line's SKUs by brand-prefix so multi-prefix resolves
        # (e.g. Spray Cologne Series -> FM White SR + HM Black SR) split into
        # the correct per-prefix rows, mirroring the renderer's explode logic.
        by_prefix: "dict" = {}
        for it in sku_list:
            pfx = _prefix_of(it.get("kelompok"))
            by_prefix.setdefault(pfx, []).append(it)

        for pfx, its in by_prefix.items():
            # benefit is part of the key so distinct MTI cut-prices under the
            # same (channel, prefix, "Beli 1") never collapse onto one price.
            key = (channel, pfx, tier, benefit_type, benefit)
            acc = merged.get(key)
            if acc is None:
                acc = {
                    "channel_gtmt": channel,
                    "prefix": pfx,
                    "tier": tier,
                    "benefit_type": benefit_type,
                    "benefit": benefit,
                    "kelompoks": [],       # ordered unique
                    "kel_seen": set(),
                    "skus": [],            # ordered unique master items
                    "sku_seen": set(),
                    "qualifiers": set(),
                    "any_plain": False,
                    # passthrough meta from the first contributing line
                    "principle": row.get("principle", ""),
                    "surat_program": row.get("surat_program", ""),
                    "nama_program": row.get("nama_program", ""),
                    "periode": row.get("periode", ""),
                    "promo_group_id": row.get("promo_group_id", ""),
                    "syarat_claim": row.get("syarat_claim", ""),
                    "keterangan": row.get("keterangan", ""),
                }
                merged[key] = acc
                order.append(key)

            if qualifier:
                acc["qualifiers"].add(qualifier)
            else:
                acc["any_plain"] = True

            for it in its:
                k = str(it.get("kelompok", "")).strip()
                if k and k not in acc["kel_seen"]:
                    acc["kel_seen"].add(k)
                    acc["kelompoks"].append(k)
                kb = str(it.get("kode_barang", "")).strip()
                if kb and kb not in acc["sku_seen"]:
                    acc["sku_seen"].add(kb)
                    acc["skus"].append(it)

    out: List[Dict] = []
    for key in order:
        acc = merged[key]
        skus = acc["skus"]

        # Variant: default 'All Variant'; if EVERY contributing line carried the
        # same single qualifier (and none was plain), surface that qualifier.
        if acc["qualifiers"] and not acc["any_plain"] and len(acc["qualifiers"]) == 1:
            variant = next(iter(acc["qualifiers"])).title()
        else:
            variant = "All Variant"

        # Gramasi: unique values in SKU order (renderer re-derives per kelompok,
        # this is the human-visible parse cell).
        gseen, gvals = set(), []
        for it in skus:
            g = str(it.get("gramasi", "")).strip()
            if g and g not in gseen:
                gseen.add(g)
                gvals.append(g)
        gramasi = ",".join(gvals)

        ketentuan = acc["tier"] + (_MIX_SUFFIX if len(skus) > 1 else "")

        out.append({
            "id": str(uuid.uuid4()),
            "no": str(len(out) + 1),
            "principle": acc["principle"],
            "surat_program": acc["surat_program"],
            "nama_program": acc["nama_program"],
            "channel_gtmt": acc["channel_gtmt"],
            "periode": acc["periode"],
            "promo_group_id": acc["promo_group_id"],
            "kelompok": " & ".join(acc["kelompoks"]),
            "variant": variant,
            "gramasi": gramasi,
            "ketentuan": ketentuan,
            "benefit_type": acc["benefit_type"],
            "benefit": acc["benefit"],
            "syarat_claim": acc["syarat_claim"],
            "keterangan": acc["keterangan"],
            "kode_barangs": ",".join(str(it.get("kode_barang", "")).strip() for it in skus),
            "_matched_items_cache": skus,
        })

    # Flagged unmatched lines keep their place at the end so they are visible
    # for manual review but never merged/guessed.
    for ur in unmatched_rows:
        ur["no"] = str(len(out) + 1)
        out.append(ur)

    return out
