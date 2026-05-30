/*
 * Tujuan: Normalisasi string pencarian OFF Program Control yang konsisten FE/BE.
 * Caller: page.tsx (search monitor), route batches (searchText query).
 * Dependensi: program-type normalizeProgramType untuk dukungan typo Visibility.
 * Main Functions: normalizeSearchText, buildSearchHaystack, matchesSearch.
 * Side Effects: Tidak ada.
 *
 * Aturan revisi (D):
 * - trim, lowercase, hilangkan double spaces.
 * - dukung sebagian kata (substring).
 * - dukung typo ringan khusus Visibility/Visibilty (lewat program-type).
 */

import { normalizeProgramType } from "./program-type";

/** trim + lowercase + collapse multiple spaces. */
export function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Bangun haystack pencarian dari kumpulan field. Nilai null/undefined diabaikan.
 * Jika field mengandung tipe program, tambahkan juga bentuk ternormalisasi agar
 * pencarian "visibilty" tetap menemukan data "Visibility".
 */
export function buildSearchHaystack(parts: Array<unknown>): string {
  const tokens: string[] = [];
  for (const part of parts) {
    const text = normalizeSearchText(part);
    if (!text) continue;
    tokens.push(text);
    const normalizedType = normalizeProgramType(part);
    if (normalizedType) tokens.push(normalizeSearchText(normalizedType));
  }
  return tokens.join(" ");
}

/**
 * Cek apakah haystack cocok dengan query.
 * - Query dipecah jadi term; semua term harus muncul (AND) sebagai substring.
 * - Mendukung typo Visibility: bila sebuah term ternormalisasi ke tipe program,
 *   maka bentuk normalisasi juga dicocokkan.
 */
export function matchesSearch(haystack: string, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const terms = normalizedQuery.split(" ").filter(Boolean);
  return terms.every((term) => {
    if (haystack.includes(term)) return true;
    const normalizedType = normalizeProgramType(term);
    if (normalizedType && haystack.includes(normalizeSearchText(normalizedType))) {
      return true;
    }
    return false;
  });
}
