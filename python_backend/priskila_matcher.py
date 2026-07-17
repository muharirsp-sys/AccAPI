"""
priskila_matcher.py

Self-contained, OFFLINE deterministic matcher that maps one "surat" (promo
document) line for principle "Priskila" to master SKUs, replacing LLM
guessing. Pure stdlib (json, re, os). No network calls.

Public API:
    load_rules(path=None) -> dict
    extract_gramasi(text) -> str
    brand_prefix(brand, rules) -> str
    candidate_kelompoks(brand, text, master, rules) -> set[str]
    resolve_surat_line(brand, group_item_text, master, rules) -> dict
"""

import json
import os
import re
from typing import Dict, List, Optional

_DIR = os.path.dirname(os.path.abspath(__file__))
_RULES_PATH = os.path.join(_DIR, "priskila_matching.json")


def load_rules(path: Optional[str] = None) -> Dict:
    with open(path or _RULES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _norm(x) -> str:
    return " ".join(str(x or "").strip().split()).upper()


def extract_gramasi(text: str) -> str:
    m = re.search(r"(\d+)\s*(ML|GR)\b", _norm(text))
    return f"{m.group(1)}{m.group(2)}" if m else ""


def brand_prefix(brand: str, rules: Dict) -> str:
    return rules["brand_aliases"].get(_norm(brand), _norm(brand))


def brand_prefix_from_text(text: str, rules: Dict) -> Optional[str]:
    """Derive the master brand prefix by scanning ``text`` for the first known
    brand alias key. Longest keys first so multi-word brands ("MARIE JOSE")
    win before any single word. Returns the aliased prefix, or None if the
    text contains no known brand.

    The surat's separate brand column is unreliable (rowspan → the brand can
    land on the wrong row), but ``group_item_text`` always starts with the
    brand word, so parsing it is the trustworthy source.
    """
    t = _norm(text)
    for key in sorted(rules["brand_aliases"], key=len, reverse=True):
        if re.search(r"\b" + re.escape(key) + r"\b", t):
            return rules["brand_aliases"][key]
    return None


def _resolve_prefix(brand: str, text: str, rules: Dict) -> str:
    """Prefer the brand parsed from the item text; fall back to the (possibly
    wrong) brand argument only when the text carries no known brand."""
    return brand_prefix_from_text(text, rules) or brand_prefix(brand, rules)


# Words that never carry matching signal (brand names / gender codes).
_NOISE_WORDS = {
    "CASABLANCA", "BELLAGIO", "CAMELLIA", "REGAZZA", "REGGAZZA",
    "EXCELLO", "EXCELO", "MARIE", "JOSE", "HM", "FM",
}

# Symmetric token canonicalization. Master naming is inconsistent
# ("B." vs "BODY", "ROL" vs "ROLL", dotted "B.PARFUME"/"B.SPRAY"), so the SAME
# canonicalization is applied to both the surat type-tokens and the master
# kelompok tokens before they are compared.
_PUNCT_TRANS = str.maketrans({c: " " for c in ".,()&"})
_TOKEN_MAP = {"BODY": "B", "ROLL": "ROL"}


def _canon_token(tok: str) -> set:
    """Canonicalize one raw token into a set of comparable words: strip
    punctuation (so "B." → {B}, "B.SPRAY" → {B, SPRAY}), then map
    BODY→B and ROLL→ROL."""
    return {_TOKEN_MAP.get(w, w) for w in tok.translate(_PUNCT_TRANS).split() if w}


def _canon_tokens(tokens) -> set:
    out = set()
    for tok in tokens:
        out |= _canon_token(tok)
    return out


def _apply_type_synonyms(t: str, rules: Dict) -> str:
    """Replace every type synonym in a SINGLE left-to-right pass.

    A sequential ``str.replace`` loop re-scans its own output, so an inserted
    value like "B.PARFUME" gets clobbered by a later "PARFUME"->"EDP" rule.
    ``re.sub`` never re-scans replacement text, and the alternation is ordered
    longest-key-first so multi-word keys ("EAU DE PARFUME") win over the
    single words they contain ("PARFUME").
    """
    syn = rules["type_synonyms"]
    keys = sorted(syn, key=len, reverse=True)
    if not keys:
        return t
    pattern = re.compile("|".join(re.escape(k) for k in keys))
    return pattern.sub(lambda mo: syn[mo.group(0)], t)


def _type_tokens(text, brand_pfx, gramasi, rules) -> set:
    t = _norm(text)
    t = _apply_type_synonyms(t, rules)
    t = re.sub(r"\d+\s*(ML|GR)\b", " ", t)
    drop = set(brand_pfx.split()) | _NOISE_WORDS
    # Drop any token that begins with a digit. Real gramasi ("100ML") is
    # already stripped above; this also discards OCR-truncated remnants like
    # "50M" (a mangled "50ml") that would otherwise leak into the type tokens
    # and break the kelompok subset match. No master type token starts with a
    # digit, so this is safe.
    words = {
        w for w in t.split()
        if w and w not in drop and not w[0].isdigit()
    }
    return _canon_tokens(words)


def _kelompok_tokens(kel, pfx) -> set:
    raw = {
        w for w in kel.replace(" - ", " ").split()
        if w not in pfx.split() and w not in ("HM", "FM")
    }
    return _canon_tokens(raw)


def _best_subset(by_kel, pfx, want) -> set:
    """Kelompoks whose tokens are a superset of `want`, tightest (fewest extra
    tokens) preferred. Empty set if none qualify."""
    best, best_score = set(), None
    for kel in by_kel:
        ktoks = _kelompok_tokens(kel, pfx)
        if not want.issubset(ktoks):
            continue
        score = -len(ktoks - want)
        if best_score is None or score > best_score:
            best, best_score = {kel}, score
        elif score == best_score:
            best.add(kel)
    return best


def candidate_kelompoks(brand, text, master, rules) -> set:
    pfx = _resolve_prefix(brand, text, rules)
    gram = extract_gramasi(text)
    want = _type_tokens(text, pfx, gram, rules)
    want_core = want - {q for q in rules["variant_qualifiers"] if q in want}

    by_kel = {}
    for it in master:
        if not _norm(it.get("kelompok")).startswith(pfx):
            continue
        if gram and _norm(it.get("gramasi")) != gram:
            continue
        by_kel.setdefault(_norm(it.get("kelompok")), []).append(it)

    # Phase 1: match on the FULL want, i.e. treat a qualifier ("SPORT") as a
    # kelompok SELECTOR. This catches a dedicated qualifier kelompok such as
    # "BLAGIO HM - SPORT EDT". If found, use it directly (no partition).
    hit = _best_subset(by_kel, pfx, want)
    if hit:
        return hit
    # Phase 2: no dedicated kelompok -> the qualifier PARTITIONS a shared
    # kelompok (e.g. "REGAZZA FM - EDT" holds both plain and Sport variants).
    # Match on want_core; resolve_surat_line then filters by qualifier.
    return _best_subset(by_kel, pfx, want_core)


def _apply_partition(items, want_qualifiers, all_qualifiers):
    def has(it, q):
        return q in _norm(it.get("principle")).split()

    if want_qualifiers:
        return [it for it in items if all(has(it, q) for q in want_qualifiers)]
    # No qualifier requested: if this pool is a mix of qualified/unqualified
    # SKUs (e.g. REGAZZA EDT has both plain and "Sport" variants under one
    # kelompok), keep only the unqualified ones so a plain request doesn't
    # silently pull in the Sport sub-line.
    if any(any(has(it, q) for q in all_qualifiers) for it in items):
        return [it for it in items if not any(has(it, q) for q in all_qualifiers)]
    return items


def resolve_surat_line(brand: str, group_item_text: str, master: List[Dict], rules: Dict) -> Dict:
    text = group_item_text
    gram = extract_gramasi(text)

    # Series short-circuit: an explicit named "series" phrase resolves to a
    # fixed, curated set of kelompoks (with hard excludes), bypassing the
    # generic token-matching path entirely.
    for phrase, rule in rules.get("series_rules", {}).items():
        if phrase in _norm(text):
            wanted = {_norm(k) for k in rule["resolve_to_kelompok"]}
            excl = {_norm(k) for k in rule["exclude_kelompok"]}
            out, seen = [], set()
            for it in master:
                k = _norm(it.get("kelompok"))
                if k in wanted and k not in excl and "BND" not in _norm(it.get("nama_barang")).split():
                    kb = str(it.get("kode_barang", "")).strip()
                    if kb and kb not in seen:
                        seen.add(kb)
                        out.append(it)
            return {"sku_list": out, "kelompoks": sorted(wanted), "unmatched": None if out else text}

    pfx = _resolve_prefix(brand, text, rules)
    want = _type_tokens(text, pfx, gram, rules)
    want_qual = {q for q in rules["variant_qualifiers"] if q in want}

    kels = candidate_kelompoks(brand, text, master, rules)
    if not kels:
        return {"sku_list": [], "kelompoks": [], "unmatched": text}

    excl = {_norm(k) for k in rules.get("excluded_kelompok", [])}
    pool = [
        it for it in master
        if _norm(it.get("kelompok")) in kels
        and (not gram or _norm(it.get("gramasi")) == gram)
        and "BND" not in _norm(it.get("nama_barang")).split()
        and _norm(it.get("kelompok")) not in excl
    ]
    # Partition only by qualifiers NOT already baked into the selected kelompok
    # name.
    kel_tokens = set()
    for k in kels:
        kel_tokens |= _kelompok_tokens(k, pfx)
    partition_qual = {q for q in want_qual if q not in kel_tokens}
    if want_qual and not partition_qual:
        # The qualifier picked a dedicated kelompok (e.g. "BLAGIO HM - SPORT
        # EDT") -> the whole kelompok IS the qualified line, keep all SKUs.
        pass
    else:
        # want_qual present + not in kelompok -> filter to the qualified subset
        # (Regazza "Sport" inside "REGAZZA FM - EDT"); no qualifier requested ->
        # drop qualified SKUs from a mixed kelompok.
        pool = _apply_partition(pool, partition_qual, rules["variant_qualifiers"])

    out, seen = [], set()
    for it in pool:
        kb = str(it.get("kode_barang", "")).strip()
        if kb and kb not in seen:
            seen.add(kb)
            out.append(it)

    return {"sku_list": out, "kelompoks": sorted(kels), "unmatched": None if out else text}


def _load_master_for_selfcheck() -> List[Dict]:
    path = os.path.join(_DIR, "data", "manual_cache", "master_cache.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    def find_items(obj):
        if isinstance(obj, dict):
            if isinstance(obj.get("items"), list):
                return obj["items"]
            for v in obj.values():
                r = find_items(v)
                if r:
                    return r
        return None

    return find_items(data) or []


if __name__ == "__main__":
    master = _load_master_for_selfcheck()
    r = load_rules()

    def codes(items):
        return {it["kode_barang"] for it in items}

    # 1. Pomade -> HM only
    assert candidate_kelompoks("CASABLANCA", "Casablanca Pomade 50gr", master, r) == {
        "CSBNCA HM - PMD OIL BASED"
    }

    # 2. EDP / EDP Prestige split
    assert candidate_kelompoks(
        "BELLAGIO", "Bellagio Eau De Parfume Prestige 50ml", master, r
    ) == {"BLAGIO HM - EDP - PRESTIGE"}
    assert candidate_kelompoks(
        "BELLAGIO", "Bellagio Eau de Parfume 50ml", master, r
    ) == {"BLAGIO HM - EDP"}

    # 3. All-variant Bellagio EDT
    res = resolve_surat_line("BELLAGIO", "Bellagio Eau de Toilette 100ml", master, r)
    assert codes(res["sku_list"]) == {
        "P2014001010010", "P2014002010010", "P2014003010010",
        "P2014004010010", "P2014005010010", "P2014006010010",
    }

    # 4. Regazza sport partition
    sport = resolve_surat_line("REGAZZA", "Regazza Eau de Toilette Sport 100ml", master, r)
    assert {it["variant"] for it in sport["sku_list"]} == {"AZZURO", "BIANCO", "NERO", "ROSSO"}
    reg = resolve_surat_line("REGAZZA", "Regazza Eau de Toilette 100ml", master, r)
    assert "AZZURO" not in {it["variant"] for it in reg["sku_list"]}
    assert len(reg["sku_list"]) == 6

    # 5. Banded excluded
    res = resolve_surat_line("CASABLANCA", "Casablanca Pomade 50gr", master, r)
    assert len(res["sku_list"]) == 8

    # 6. Spray cologne series (GLASS excluded, sanitizer never leaks)
    res = resolve_surat_line("CASABLANCA", "Casablanca Spray Cologne Series 100ml", master, r)
    kels = {_norm(it["kelompok"]) for it in res["sku_list"]}
    assert kels == {"CSBNCA FM - SPRAY COL - WHITE SR", "CSBNCA HM - SPRAY COLG - BLACK SR"}

    print("priskila_matcher self-check PASSED")
