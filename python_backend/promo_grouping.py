"""Tujuan: Menormalkan grouping dan deduplikasi baris promo lintas model OCR/LLM.

Caller: ``routers.summary.summary_manual_generate`` sebelum penulisan XLSX.
Dependensi: hanya Python standard library.
Main Functions: ``program_identity``, ``consolidation_identity``,
``canonical_promo_text``, ``allows_legacy_master_fallback``,
``propagate_table_benefits``, ``deduplicate_promo_rows``,
``bridge_group_triggers``, ``assign_stable_group_ids``, dan ``stable_sort_promo_rows``.
Side Effects: tidak ada; fungsi mengembalikan salinan/list hasil baru.
"""

from collections import defaultdict
import re
from typing import Any, Dict, Iterable, List, Sequence, Tuple


_SPACE_RE = re.compile(r"\s+")


def _norm(value: Any) -> str:
    return _SPACE_RE.sub(" ", str(value or "").strip()).upper()


def canonical_promo_text(value: Any) -> str:
    """Kanonikkan whitespace/pemisah benefit tanpa mengubah digit."""
    return re.sub(r"\s*([+%])\s*", r"\1", _norm(value))


def _benefit_display(value: Any) -> str:
    return re.sub(r"\s*([+%])\s*", r"\1", _SPACE_RE.sub(" ", str(value or "").strip()))


def consolidation_identity(row: Dict[str, Any]) -> Tuple[str, ...]:
    """Identitas produk stabil untuk konsolidasi sebelum ekspansi master."""
    codes = sorted({part.strip() for part in str(row.get("kode_barangs") or "").split(",") if part.strip()})
    if codes:
        return ("SKU", *codes)
    product_line = _norm(row.get("product_line_text"))
    if product_line:
        return ("PRODUCT", product_line)
    return ("FIELDS", _norm(row.get("kelompok")), _norm(row.get("variant")), _norm(row.get("gramasi")))


def allows_legacy_master_fallback(row: Dict[str, Any]) -> bool:
    """Matcher generik bersifat final; baris review tidak boleh jadi seluruh master."""
    pipeline = _norm(row.get("_gen_key") or row.get("principle"))
    return not any(name in pipeline for name in ("NATUR", "FONTERRA"))


def propagate_table_benefits(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Isi benefit rowspan kosong dari benefit valid sebelumnya dalam program."""
    result: List[Dict[str, Any]] = []
    previous_by_program: Dict[str, Tuple[str, str]] = {}
    for source in rows:
        row = dict(source)
        key = program_identity(row)
        benefit = str(row.get("benefit") or "").strip()
        is_review = not benefit or "TIDAK TERBACA" in _norm(benefit)
        if is_review and key in previous_by_program:
            row["benefit_type"], row["benefit"] = previous_by_program[key]
        elif not is_review:
            benefit = _benefit_display(benefit)
            row["benefit"] = benefit
            previous_by_program[key] = (str(row.get("benefit_type") or ""), benefit)
        result.append(row)
    return result


def program_identity(row: Dict[str, Any]) -> str:
    """Identitas program stabil; nomor surat menang atas label/periode."""
    no_surat = _norm(row.get("surat_program") or row.get("no_surat"))
    if no_surat:
        return f"SURAT:{no_surat}"
    return "PROGRAM:" + "|".join((
        _norm(row.get("nama_program") or row.get("promo_label")),
        _norm(row.get("periode")),
    ))


def _benefit_signature(row: Dict[str, Any]) -> Tuple[str, str, str]:
    return (
        _norm(row.get("benefit_type")), canonical_promo_text(row.get("benefit_text")),
        _norm(row.get("benefit_unit")),
    )


def _trigger_number(value: Any) -> float:
    try:
        return float(str(value or "").replace(",", "."))
    except ValueError:
        return 0.0


def deduplicate_promo_rows(rows: Sequence[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """Deduplikasi hanya di dalam satu program, SKU, dan benefit yang sama."""
    buckets: Dict[Tuple[str, str, str, Tuple[str, str, str]], List[Dict[str, Any]]] = defaultdict(list)
    passthrough: List[Dict[str, Any]] = []
    for source in rows:
        row = dict(source)
        if not row.get("kode_barang"):
            passthrough.append(row)
            continue
        key = (
            str(row.get("program_key") or program_identity(row)),
            _norm(row.get("channel")),
            _norm(row.get("kode_barang")),
            _benefit_signature(row),
        )
        buckets[key].append(row)

    kept: List[Dict[str, Any]] = list(passthrough)
    dropped = 0
    for bucket in buckets.values():
        by_trigger: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
        for row in bucket:
            by_trigger[(_norm(row.get("trig_qty")), _norm(row.get("trig_unit")))].append(row)
        candidates = [items[0] for items in by_trigger.values()]
        has_specific = any(_trigger_number(row.get("trig_qty")) > 1 for row in candidates)
        for row in candidates:
            if has_specific and _trigger_number(row.get("trig_qty")) <= 1:
                dropped += 1
                continue
            kept.append(row)
        dropped += len(bucket) - len(candidates)
    return kept, dropped


def bridge_group_triggers(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Isi trigger generik dari satu-satunya trigger spesifik dalam group."""
    buckets: Dict[Tuple[str, str, str, Tuple[str, str, str]], List[Dict[str, Any]]] = defaultdict(list)
    for source in rows:
        key = (
            str(source.get("program_key") or program_identity(source)), _norm(source.get("channel")),
            _norm(source.get("master_kel")), _benefit_signature(source),
        )
        buckets[key].append(source)
    replacements: Dict[int, Tuple[Any, Any]] = {}
    for bucket in buckets.values():
        specific = {
            (row.get("trig_qty"), row.get("trig_unit"))
            for row in bucket if _trigger_number(row.get("trig_qty")) > 1
        }
        if len(specific) != 1:
            continue
        chosen = next(iter(specific))
        for row in bucket:
            if _trigger_number(row.get("trig_qty")) <= 1:
                replacements[id(row)] = chosen
    result = []
    for source in rows:
        row = dict(source)
        if id(source) in replacements:
            row["trig_qty"], row["trig_unit"] = replacements[id(source)]
        result.append(row)
    return result


def _group_signature(row: Dict[str, Any]) -> Tuple[str, ...]:
    return (
        str(row.get("program_key") or program_identity(row)), _norm(row.get("channel")),
        _norm(row.get("master_kel")),
    )


def assign_stable_group_ids(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Beri group ID kanonik yang tidak bergantung urutan keluaran model."""
    generated = sorted({_group_signature(row) for row in rows if row.get("auto_group_id", True)})
    counters: Dict[str, int] = defaultdict(int)
    mapping: Dict[Tuple[str, ...], str] = {}
    for signature in generated:
        channel = signature[1]
        prefix = "".join(char for char in channel if char.isalnum()) or "RETAIL"
        counters[prefix] += 1
        mapping[signature] = f"{prefix}_{counters[prefix]}"

    result: List[Dict[str, Any]] = []
    for source in rows:
        row = dict(source)
        if row.get("auto_group_id", True):
            row["pg_id"] = mapping[_group_signature(row)]
        result.append(row)
    return result


def stable_sort_promo_rows(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Urutkan dataset secara kanonik agar input model yang teracak tetap identik."""
    return sorted((dict(row) for row in rows), key=lambda row: (
        str(row.get("program_key") or program_identity(row)), _norm(row.get("channel")),
        _norm(row.get("pg_id")), _norm(row.get("kode_barang")), _trigger_number(row.get("trig_qty")),
        _benefit_signature(row), _norm(row.get("nama_barang")),
    ))
