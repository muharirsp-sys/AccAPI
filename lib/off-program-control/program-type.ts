/*
 * Tujuan: Sumber tunggal definisi tipe program OFF (dropdown final) + normalisasi legacy/typo.
 * Caller: page.tsx (Supervisor dropdown), route batches (create/update), search normalisasi.
 * Dependensi: Tidak ada; murni fungsi string in-memory.
 * Main Functions: OFF_PROGRAM_TYPES, normalizeProgramType, resolveProgramType.
 * Side Effects: Tidak ada.
 *
 * Aturan revisi:
 * - Dropdown final: Display, Visibility, Promo On Store, Event, Sample.
 * - UI wajib menampilkan ejaan benar "Visibility".
 * - Backend menerima typo lama (Visibilty/visibility/VISIBILITY/Visibilityy) lalu
 *   dinormalisasi ke "Visibility".
 * - Data lama yang cocok dropdown baru -> valid + badge "Data Lama".
 * - Data lama yang tidak cocok -> otomatis dipetakan ke "Sample".
 */

export const OFF_PROGRAM_TYPES = [
  "Display",
  "Visibility",
  "Promo On Store",
  "Event",
  "Sample",
] as const;

export type OffProgramType = (typeof OFF_PROGRAM_TYPES)[number];

/** Tipe default ketika data lama tidak bisa dipetakan ke dropdown baru. */
export const OFF_PROGRAM_TYPE_FALLBACK: OffProgramType = "Sample";

function canonicalKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Levenshtein sederhana untuk deteksi typo ringan (mis. "Visibilty", "Visibilityy").
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  return prev[n];
}

// Pemetaan eksplisit alias/typo umum ke dropdown final.
const EXPLICIT_ALIASES: Record<string, OffProgramType> = {
  // Visibility + variasi typo
  visibility: "Visibility",
  visibilty: "Visibility",
  visibilyty: "Visibility",
  visibilityy: "Visibility",
  visiblity: "Visibility",
  visibiliti: "Visibility",
  visibilitas: "Visibility",
  "area visibility": "Visibility",
  // Display
  display: "Display",
  "off display": "Display",
  "off-display": "Display",
  endcap: "Display",
  "endcap support": "Display",
  // Promo On Store (hanya bentuk multi-kata; "Promo" telanjang TIDAK dipetakan
  // ke sini agar data lama "Promo" jatuh ke fallback Sample sesuai aturan revisi).
  "promo on store": "Promo On Store",
  "promo onstore": "Promo On Store",
  "promo on-store": "Promo On Store",
  "promo instore": "Promo On Store",
  "promo in store": "Promo On Store",
  // Event
  event: "Event",
  "off event": "Event",
  // Sample / sampling
  sample: "Sample",
  sampling: "Sample",
  "sampling area": "Sample",
  sampel: "Sample",
};

/**
 * Normalisasi nilai tipe program ke dropdown final.
 * Mengembalikan salah satu OFF_PROGRAM_TYPES, atau null jika kosong/tidak dikenali.
 *
 * Catatan: null berarti "tidak dikenali" sehingga pemanggil bisa memutuskan
 * fallback (mis. Supervisor wajib memilih ulang, atau dipaksa ke Sample untuk
 * migrasi legacy). Lihat resolveProgramType untuk perilaku terpadu.
 */
export function normalizeProgramType(value: unknown): OffProgramType | null {
  const key = canonicalKey(value);
  if (!key) return null;

  // 1. Exact match (case-insensitive) ke dropdown final.
  const exact = OFF_PROGRAM_TYPES.find(
    (type) => canonicalKey(type) === key,
  );
  if (exact) return exact;

  // 2. Alias/typo eksplisit.
  if (EXPLICIT_ALIASES[key]) return EXPLICIT_ALIASES[key];

  // 3. Fuzzy typo ringan terhadap dropdown final (jarak edit kecil).
  let best: { type: OffProgramType; distance: number } | null = null;
  for (const type of OFF_PROGRAM_TYPES) {
    const distance = levenshtein(key, canonicalKey(type));
    if (best === null || distance < best.distance) {
      best = { type, distance };
    }
  }
  if (best) {
    const target = canonicalKey(best.type);
    // Toleransi typo: jarak <= 2 dan tidak terlalu jauh dari panjang target.
    const threshold = target.length <= 6 ? 1 : 2;
    if (best.distance <= threshold) return best.type;
  }

  return null;
}

export type ResolvedProgramType = {
  /** Tipe final untuk dropdown/perhitungan. */
  normalizedType: OffProgramType;
  /** Nilai asli sebelum normalisasi (audit legacy). */
  originalType: string;
  /** True bila berasal dari data lama (tidak exact match dropdown final). */
  typeIsLegacy: boolean;
  /** True bila tipe asli tidak dikenali sehingga dipaksa ke fallback (Sample). */
  forcedToFallback: boolean;
  /** True bila tipe asli sudah cocok persis dengan dropdown final (case-insensitive). */
  isExactNewType: boolean;
};

/**
 * Resolusi terpadu tipe program untuk penyimpanan + audit.
 * - Jika nilai exact dropdown final -> typeIsLegacy=false.
 * - Jika typo/alias dikenali -> normalisasi + typeIsLegacy=true.
 * - Jika tidak dikenali sama sekali -> fallback Sample + typeIsLegacy=true + forcedToFallback.
 */
export function resolveProgramType(value: unknown): ResolvedProgramType {
  const originalType = String(value ?? "").trim();
  const exact = OFF_PROGRAM_TYPES.find(
    (type) => canonicalKey(type) === canonicalKey(originalType),
  );
  if (exact) {
    return {
      normalizedType: exact,
      originalType,
      // Data lama yang persis cocok tetap valid; ditandai legacy hanya jika
      // ejaan asli berbeda kapitalisasi/spasi dari kanonik. Untuk konsistensi,
      // anggap exact (termasuk beda kapital) sebagai bukan legacy.
      typeIsLegacy: false,
      forcedToFallback: false,
      isExactNewType: true,
    };
  }

  const normalized = normalizeProgramType(originalType);
  if (normalized) {
    return {
      normalizedType: normalized,
      originalType,
      typeIsLegacy: true,
      forcedToFallback: false,
      isExactNewType: false,
    };
  }

  return {
    normalizedType: OFF_PROGRAM_TYPE_FALLBACK,
    originalType,
    typeIsLegacy: true,
    forcedToFallback: true,
    isExactNewType: false,
  };
}

/** True bila nilai tipe persis salah satu dropdown final (case-insensitive). */
export function isOffProgramType(value: unknown): value is OffProgramType {
  return OFF_PROGRAM_TYPES.some(
    (type) => canonicalKey(type) === canonicalKey(value),
  );
}

/**
 * Resolusi tipe khusus DATA LAMA dari database (migrasi/legacy read).
 *
 * Beda dengan resolveProgramType (untuk input baru dari form):
 * - Untuk data lama, exact match dropdown TETAP ditandai typeIsLegacy=true,
 *   karena data tersebut berasal dari sebelum sistem dropdown ada dan harus
 *   menampilkan badge "Data Lama" + menjaga jejak originalType.
 * - originalType selalu mempertahankan nilai asli dari DB (tidak dihapus).
 * - Tipe tidak dikenali tetap dipaksa ke fallback (Sample) + forcedToFallback.
 *
 * Gunakan helper ini HANYA untuk migrasi/baca data lama, JANGAN untuk input baru
 * agar perilaku form (exact = bukan legacy) tidak rusak.
 */
export function resolveLegacyProgramType(value: unknown): ResolvedProgramType {
  const resolved = resolveProgramType(value);
  return {
    ...resolved,
    // Paksa tandai legacy untuk semua data lama, termasuk yang exact match.
    typeIsLegacy: true,
  };
}

/**
 * Resolusi tipe untuk PENYIMPANAN yang menghormati originalType dari client.
 *
 * Aturan revisi A.10: jangan hilangkan nilai tipe lama. Bila client mengirim
 * originalType (nilai asli sebelum dikoreksi Supervisor), nilai itu dipertahankan
 * apa adanya. typeIsLegacy ditandai true jika:
 *  - resolusi tipe terdeteksi legacy/typo, ATAU
 *  - originalType yang dikirim berbeda dari hasil normalisasi (mis. "OFF Display"
 *    dikoreksi menjadi "Display").
 *
 * @param type Nilai tipe terpilih (dropdown final) atau nilai mentah.
 * @param providedOriginalType Nilai asli dari client (opsional).
 */
export function resolveProgramTypeForSave(
  type: unknown,
  providedOriginalType?: unknown,
): {
  normalizedType: OffProgramType;
  originalType: string;
  typeIsLegacy: boolean;
  forcedToFallback: boolean;
} {
  const providedOriginal = String(providedOriginalType ?? "").trim();
  const resolved = resolveProgramType(type ?? providedOriginalType);
  const originalType =
    providedOriginal || resolved.originalType || resolved.normalizedType;
  const typeIsLegacy =
    resolved.typeIsLegacy ||
    (Boolean(providedOriginal) &&
      canonicalKey(providedOriginal) !== canonicalKey(resolved.normalizedType));
  return {
    normalizedType: resolved.normalizedType,
    originalType,
    typeIsLegacy,
    forcedToFallback: resolved.forcedToFallback,
  };
}
