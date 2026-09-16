"""
urc_matcher.py

Pure, offline deterministic matcher for principle URC. Same isolation
philosophy as ``priskila_matcher.py`` (Approach A) but a DIFFERENT
algorithm: URC's master already differentiates every SKU by exact flavor
(Nama Aroma/Rasa), so one surat line typically resolves to ONE (kelompok,
aroma) group -- not a whole kelompok expanded to "All Variant" as Priskila
does.

Scoring: Jaccard similarity between the surat line's tokens and each
candidate group's (kelompok + aroma) tokens, grouped by gramasi:
  - Phase 1: candidates whose gramasi matches the surat line's gramasi.
  - Phase 2 (fallback, ONLY if phase 1 has no candidate at all): relax the
    gramasi constraint, but require a much higher score bar, since dropping
    the gramasi signal removes a strong disambiguator. Exists because some
    master gramasi values are known-equivalent to what a surat states
    (e.g. "Topmix Assorted 295g" surat vs master "TOP MIX 259G" -- same
    single SKU, confirmed by the user, not a data error).
  - A tie at the top score (two DIFFERENT (kelompok, aroma) groups) is
    treated as ambiguous -> UNMATCHED, never guessed.

Public API:
    load_rules(path=None) -> dict
    resolve_surat_line(item_description, master, rules=None) -> dict
"""

import json
import os
import re
from typing import Dict, List, Optional

_DIR = os.path.dirname(os.path.abspath(__file__))
_RULES_PATH = os.path.join(_DIR, "urc_matching.json")

_PUNCT_TRANS = str.maketrans({c: " " for c in ".,()&"})
_GRAMASI_RE = re.compile(r"(\d+)\s*(ML|GR|G)\b")
# Unit suffix (PC/PCS/BTL/CTN) is OPTIONAL: live OCR of the same letter has
# rendered this as both "208gx12PC" and "208g x 12" (no unit word at all).
# Without the "?", the unitless form leaks stray "X"/"12" tokens into
# _tokenize, which silently breaks exact-match rules like `aroma_default`.
_PACK_SUFFIX_RE = re.compile(r"X\s*\d+\s*(PC|PCS|BTL|CTN)?\b")


def load_rules(path: Optional[str] = None) -> Dict:
    with open(path or _RULES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _norm(x) -> str:
    return " ".join(str(x or "").strip().split()).upper()


def _strip_possessive(t: str) -> str:
    return re.sub(r"[’']S\b", "", t)


def _apply_type_synonyms(t: str, rules: Dict) -> str:
    syn = rules.get("type_synonyms", {})
    keys = sorted(syn, key=len, reverse=True)
    if not keys:
        return t
    pattern = re.compile("|".join(re.escape(k) for k in keys))
    return pattern.sub(lambda mo: syn[mo.group(0)], t)


def _stem(word: str, rules: Dict) -> str:
    """Symmetric canonicalization applied to BOTH surat and master tokens:
    explicit abbreviation map first, then crude plural stripping (safe
    because it's applied identically on both sides -- an incidental
    collision like LEXUS->LEXU never hurts matching, only cosmetic in the
    intermediate token space)."""
    tm = rules.get("token_map", {})
    if word in tm:
        return tm[word]
    if len(word) > 3 and word.endswith("S"):
        return word[:-1]
    return word


def extract_gramasi(text: str) -> str:
    t = _norm(text)
    t = _PACK_SUFFIX_RE.sub("", t)
    m = _GRAMASI_RE.search(t)
    return f"{m.group(1)}G" if m else ""


def _norm_gramasi_value(g) -> str:
    m = _GRAMASI_RE.search(_norm(g))
    return f"{m.group(1)}G" if m else _norm(g)


def _canon(text: str, rules: Dict) -> str:
    """Phrase-level canonical form: normalize, drop possessive 's, apply
    text-level synonyms (e.g. "C.CHEESE" -> "CREAM CHEESE"). Used BOTH as
    the display/group-identity string and as input to tokenization, so two
    master rows naming the same product differently (two SKU codes for one
    flavor) collapse into the same group instead of a false ambiguous tie."""
    t = _norm(text)
    t = _strip_possessive(t)
    return _apply_type_synonyms(t, rules)


def _stem_tokens(canon_text: str, rules: Dict) -> set:
    t = _PACK_SUFFIX_RE.sub("", canon_text)
    t = _GRAMASI_RE.sub(" ", t)
    t = t.translate(_PUNCT_TRANS)
    return {_stem(w, rules) for w in t.split() if w}


def _tokenize(text: str, rules: Dict) -> set:
    return _stem_tokens(_canon(text, rules), rules)


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def _group_master(master: List[Dict], rules: Dict) -> Dict:
    """Group by (kelompok CANON, aroma CANON, gramasi). Canonicalizing the
    key (not just the score) means two master rows naming the same product
    differently -- e.g. "C.CHEESE" vs "CREAM CHEESE" SKU codes for the same
    flavor -- collapse into ONE group (both SKUs returned together) instead
    of a false tie. Gramasi is part of the key so a group never spans more
    than one gramasi (a prior bug grouped by (kelompok, aroma) alone and
    leaked every gramasi variant of a flavor into one match).

    Reads master rows in the SAME shape shared.py's
    ``_parse_master_barang_xlsx`` produces (and priskila_matcher.py already
    consumes): "kelompok" (KLP + Sub KLP + Sub KLP2 already joined with
    " - "), "variant" (= Nama Aroma/Rasa), "gramasi", "kode_barang" -- NOT
    raw "klp"/"aroma" column names, which is a different, matcher-internal
    shape and would silently mismatch every row if fed here."""
    groups: Dict = {}
    for row in master:
        klp = _canon(row.get("kelompok", ""), rules)
        aroma = _canon(row.get("variant", ""), rules)
        gramasi = _norm_gramasi_value(row.get("gramasi", ""))
        key = (klp, aroma, gramasi)
        groups.setdefault(key, []).append(row)
    return groups


def _score_pool(pool, want_tokens: set, rules: Dict) -> List:
    scored = []
    for (klp, aroma, gramasi), rows in pool:
        group_tokens = _stem_tokens(klp, rules) | _stem_tokens(aroma, rules)
        scored.append(((klp, aroma, gramasi), _jaccard(want_tokens, group_tokens), rows))
    return scored


def _tie_break(tied: List, want_tokens: set, rules: Dict) -> Optional[tuple]:
    """Resolve a tie ONLY via an explicit, human-confirmed default -- e.g.
    "a bare 'Chocolate' line means DARK CHOCOLATE" (URC letters never
    qualify it further, and the master happens to also have a distinct
    NUTTY CHOCOLATE flavor that ties on raw token overlap). Never guesses
    beyond what `aroma_default` explicitly states."""
    defaults = rules.get("aroma_default", {})
    if not defaults:
        return None
    klps = {key[0] for key, _, _ in tied}
    if len(klps) != 1:
        return None  # tied groups aren't even the same kelompok -- too different to default
    common_klp_tokens = _stem_tokens(next(iter(klps)), rules)
    residual = want_tokens - common_klp_tokens
    for bare_flavor, preferred_aroma in defaults.items():
        if residual != _stem_tokens(_canon(bare_flavor, rules), rules):
            continue
        preferred_canon = _canon(preferred_aroma, rules)
        matches = [t for t in tied if t[0][1] == preferred_canon]
        if len(matches) == 1:
            return matches[0]
    return None


def _pick_best(scored: List, threshold: float, want_tokens: set, rules: Dict) -> Optional[tuple]:
    passing = [s for s in scored if s[1] >= threshold]
    if not passing:
        return None
    top = max(s[1] for s in passing)
    tied = [s for s in passing if s[1] == top]
    if len(tied) == 1:
        return tied[0]
    return _tie_break(tied, want_tokens, rules)


def resolve_surat_line(item_description: str, master: List[Dict], rules: Optional[Dict] = None) -> Dict:
    rules = rules or load_rules()
    want_gramasi = extract_gramasi(item_description)
    want_tokens = _tokenize(item_description, rules)
    groups = _group_master(master, rules)

    phase1 = [(key, rows) for key, rows in groups.items() if key[2] == want_gramasi]
    phase1_scored = _score_pool(phase1, want_tokens, rules)
    phase1_passing = [s for s in phase1_scored if s[1] >= 0.30]

    if phase1_passing:
        # A candidate exists at this exact gramasi. Resolve it (ties are
        # first tried against an explicit `aroma_default` rule -- e.g. bare
        # "Chocolate" -> DARK CHOCOLATE -- then, failing that, stay
        # UNMATCHED as a real ambiguity). NEVER fall through to the relaxed
        # gramasi pass here -- that would let phase 2 paper over a real
        # ambiguity with an unrelated gramasi's answer.
        best = _pick_best(phase1_scored, threshold=0.30, want_tokens=want_tokens, rules=rules)
    else:
        # No candidate at all at this gramasi -- relax it (e.g. "Topmix
        # Assorted 295g" surat vs master "259G", confirmed same SKU).
        best = _pick_best(_score_pool(list(groups.items()), want_tokens, rules),
                           threshold=0.60, want_tokens=want_tokens, rules=rules)

    if best is None:
        return {"sku_list": [], "kelompok": None, "aroma": None, "unmatched": True, "score": 0.0}

    (klp, aroma, gramasi), score, rows = best
    sku_list = [row.get("kode_barang") for row in rows]
    return {
        "sku_list": sku_list,
        "kelompok": klp,
        "aroma": aroma,
        "gramasi": gramasi,
        "unmatched": False,
        "score": score,
        "rows": rows,
    }
