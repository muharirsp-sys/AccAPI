"""
Tujuan: Helper module untuk normalisasi dan matching nama principle.
Caller: main.py (load_bank_map, import rekening, SPPD submission).
Dependensi: re, unicodedata.
Main Functions: normalize_principle_name, get_principle_match_key, match_principle_by_normalized_name.
Side Effects: None (pure functions).
"""

import re
import unicodedata
from typing import Dict, List, Optional, Tuple


def normalize_principle_name(name: str) -> str:
    """
    Normalisasi nama principle untuk tampilan konsisten.
    Mengikuti format dari file daftar rekening (Excel master).
    Tidak mengubah uppercase/lowercase dari sumber master.
    """
    if not name or not isinstance(name, str):
        return ""
    # Trim dan collapse whitespace
    result = re.sub(r"\s+", " ", name.strip())
    # Normalize ".Tbk" -> " Tbk" dan ". Tbk" -> " Tbk"  
    result = re.sub(r"\.?\s*Tbk", " Tbk", result, flags=re.IGNORECASE)
    # Hapus spasi sebelum/sesudah tanda baca tertentu (kecuali yang sudah di-handle)
    result = re.sub(r"\s*([,])\s*", r"\1 ", result).strip()
    # Collapse whitespace lagi
    result = re.sub(r"\s+", " ", result).strip()
    return result


def get_principle_match_key(name: str) -> str:
    """
    Generate normalized key untuk matching.
    Rules:
    - Case insensitive (lowercase)
    - Hapus tanda baca tidak penting (., - dll)
    - Collapse whitespace
    - Pindahkan PT/CV/TBK prefix/suffix ke posisi standar
    - Hapus suffix (MT), (GT), dll
    - Hapus kata 'Tbk', '.Tbk', 'TBK' untuk key saja (bukan display)
    """
    if not name or not isinstance(name, str):
        return ""

    # Lowercase
    key = name.lower().strip()

    # Normalize unicode
    key = unicodedata.normalize("NFKD", key)

    # Hapus suffix dalam kurung: (MT), (GT), dll
    key = re.sub(r"\s*\([^)]*\)\s*", " ", key)

    # Hapus .tbk, tbk (dengan atau tanpa titik di depan)
    key = re.sub(r"\.?\btbk\b\.?", "", key)

    # Hapus titik dan koma
    key = re.sub(r"[.,;:!?'\"\-/\\]", " ", key)

    # Collapse whitespace
    key = re.sub(r"\s+", " ", key).strip()

    # Extract dan remove PT/CV/UD prefix atau suffix
    prefixes_pattern = r"\b(pt|cv|ud|firma|fa|koperasi|kop|yayasan)\b"
    # Cari prefix entity
    entity_prefix = ""
    match = re.search(prefixes_pattern, key)
    if match:
        entity_prefix = match.group(1)
        key = re.sub(prefixes_pattern, "", key).strip()

    # Collapse whitespace lagi setelah removal
    key = re.sub(r"\s+", " ", key).strip()

    # Prepend entity prefix jika ada (standarisasi: PT selalu di depan)
    if entity_prefix:
        key = f"{entity_prefix} {key}"

    return key


def match_principle_by_normalized_name(
    target_name: str,
    bank_map_keys: Dict[str, str],
) -> Tuple[Optional[str], str]:
    """
    Cari matching principle dari bank_map berdasarkan normalized key.

    Args:
        target_name: Nama principle yang mau di-match (dari payments.json/web)
        bank_map_keys: Dict mapping normalized_key -> original_key (uppercase dari Excel)

    Returns:
        Tuple of (matched_original_key_or_None, status)
        status: "matched", "ambiguous", "unmatched"
    """
    if not target_name:
        return None, "unmatched"

    target_key = get_principle_match_key(target_name)
    if not target_key:
        return None, "unmatched"

    # Exact normalized match
    if target_key in bank_map_keys:
        if bank_map_keys[target_key] == "__AMBIGUOUS__":
            return None, "ambiguous"
        return bank_map_keys[target_key], "matched"

    # Coba substring match yang cukup signifikan (>80% length)
    candidates = []
    target_words = set(target_key.split())

    for norm_key, orig_key in bank_map_keys.items():
        key_words = set(norm_key.split())

        # Jika semua kata penting (tanpa PT/CV) cocok
        target_content = target_words - {"pt", "cv", "ud", "firma", "fa", "koperasi", "kop", "yayasan"}
        key_content = key_words - {"pt", "cv", "ud", "firma", "fa", "koperasi", "kop", "yayasan"}

        if not target_content or not key_content:
            continue

        # Hitung overlap
        overlap = target_content & key_content
        total = target_content | key_content

        if len(total) > 0:
            similarity = len(overlap) / len(total)
            if similarity >= 0.85:
                candidates.append((orig_key, similarity))

    if len(candidates) == 1:
        return candidates[0][0], "matched"
    elif len(candidates) > 1:
        # Sort by similarity descending
        candidates.sort(key=lambda x: x[1], reverse=True)
        # Jika top candidate jauh lebih baik dari yang kedua, ambil itu
        if candidates[0][1] - candidates[1][1] >= 0.1:
            return candidates[0][0], "matched"
        return None, "ambiguous"

    return None, "unmatched"


def build_normalized_key_map(bank_map: Dict[str, Dict[str, str]]) -> Dict[str, str]:
    """
    Dari bank_map (key=UPPERCASE principle, value={principle, bank, rekening, penerima}),
    buat dict normalized_key -> original_uppercase_key.
    Jika ada duplicate normalized key (misal Forisa MT dan GT), simpan sebagai special marker
    agar match_principle bisa mendeteksi ambiguity.
    """
    result = {}
    duplicates = set()
    for upper_key, info in bank_map.items():
        # Gunakan nama asli dari Excel (bukan uppercase key)
        original_name = info.get("principle", upper_key)
        norm_key = get_principle_match_key(original_name)
        if norm_key:
            if norm_key in result:
                # Mark as ambiguous - multiple principles map to same key
                duplicates.add(norm_key)
            result[norm_key] = upper_key
    # Remove duplicates from result - they should trigger ambiguous status
    for dup_key in duplicates:
        result[dup_key] = "__AMBIGUOUS__"
    return result


def find_best_match(
    target_name: str,
    bank_map: Dict[str, Dict[str, str]],
    normalized_keys: Optional[Dict[str, str]] = None,
) -> Tuple[Optional[Dict[str, str]], str]:
    """
    Convenience function: cari info rekening untuk sebuah principle name.

    Returns:
        Tuple of (bank_info_or_None, status)
    """
    if normalized_keys is None:
        normalized_keys = build_normalized_key_map(bank_map)

    # Pertama: coba exact uppercase match (behaviour lama)
    upper_key = target_name.strip().upper() if target_name else ""
    if upper_key in bank_map:
        return bank_map[upper_key], "matched"

    # Kedua: coba normalized matching
    matched_key, status = match_principle_by_normalized_name(target_name, normalized_keys)
    if matched_key and matched_key in bank_map:
        return bank_map[matched_key], status

    return None, status


def generate_import_report(
    bank_map: Dict[str, Dict[str, str]],
    payment_principles: List[str],
) -> Dict[str, List]:
    """
    Generate report pencocokan antara data Excel rekening dan nama principle di web.

    Returns dict with keys:
    - matched: List of {web_name, excel_name, bank, rekening, penerima}
    - unmatched: List of web principle names yang tidak ketemu
    - ambiguous: List of web principle names yang ambigu
    - empty_rekening: List of {principle, bank, reason} dimana rekening kosong
    - skipped: List of {principle, reason} yang di-skip
    """
    normalized_keys = build_normalized_key_map(bank_map)

    matched = []
    unmatched = []
    ambiguous = []
    empty_rekening = []

    seen = set()
    for web_name in payment_principles:
        if not web_name or web_name in seen:
            continue
        seen.add(web_name)

        info, status = find_best_match(web_name, bank_map, normalized_keys)

        if status == "matched" and info:
            entry = {
                "web_name": web_name,
                "excel_name": info["principle"],
                "bank": info["bank"],
                "rekening": info["rekening"],
                "penerima": info["penerima"],
            }
            matched.append(entry)

            # Cek apakah rekening kosong / DF / VA
            bank_val = info["bank"].strip().upper()
            rek_val = info["rekening"].strip()
            if not rek_val and bank_val in ("DF", "VA", ""):
                empty_rekening.append({
                    "principle": info["principle"],
                    "bank": info["bank"],
                    "reason": f"Bank={info['bank']}, rekening kosong (DF/VA - tidak diisi)",
                })
            elif not rek_val:
                empty_rekening.append({
                    "principle": info["principle"],
                    "bank": info["bank"],
                    "reason": "Nomor rekening kosong",
                })
        elif status == "ambiguous":
            ambiguous.append(web_name)
        else:
            unmatched.append(web_name)

    return {
        "matched": matched,
        "unmatched": unmatched,
        "ambiguous": ambiguous,
        "empty_rekening": empty_rekening,
    }
