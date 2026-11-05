/*
 * Tujuan: Sumber tunggal definisi tipe program OFF (dropdown final) + penjelasan/contoh per tipe, saran tipe dari nama program,
 *   dan normalisasi legacy/typo.
 * Caller: SpvForm/KlaimClm (dropdown + pemilih tipe), mode latihan, route batches (create/update), search normalisasi.
 * Dependensi: Tidak ada; murni fungsi string in-memory.
 * Main Functions: OFF_PROGRAM_TYPES, INFO_TIPE, labelTipe, sarankanTipe, normalizeProgramType, resolveProgramType.
 * Side Effects: Tidak ada.
 *
 * Aturan revisi (owner 3 Nov 2026, dari 3.738 baris form SPV di opc$ + register klaim di clm$):
 * - Dropdown SPV = 11 kelompok program + "Lainnya" (wajib alasan). Nilai tersimpan lama (Display, Visibility, Promo On Store,
 *   Event, Sample) TIDAK diganti namanya supaya data lama tetap cocok; yang berubah hanya label tampilannya (INFO_TIPE).
 * - Tipe CLM (Insentif, Diskon Reguler, Insentif Distributor, Retur) disimpan apa adanya, tidak dinormalisasi ke tipe SPV.
 * - Backend menerima typo lama (Visibilty/visibility/VISIBILITY/Visibilityy) lalu dinormalisasi ke "Visibility".
 * - Data lama yang tidak dikenali -> "Lainnya" (dulu "Sample", yang membuat cashback/listing tercatat sebagai sampel).
 */

export const OFF_PROGRAM_TYPES = [
  "Loyalty & Cashback Toko",
  "Listing & Biaya Ritel Modern",
  "Display",
  "Diskon & Rafaksi",
  "Insentif & Gaji Tenaga Penjual",
  "Promo On Store",
  "Event",
  "Visibility",
  "Sample",
  "Hadiah & Relasi Toko",
  "Retur & Near ED",
  "Lainnya",
] as const;

export type OffProgramType = (typeof OFF_PROGRAM_TYPES)[number];

/** Tipe yang wajib disertai alasan (kolom type_note). */
export const TIPE_LAINNYA: OffProgramType = "Lainnya";

export type InfoTipe = {
  /** Label tampilan; nilai tersimpan tetap kunci OFF_PROGRAM_TYPES. */
  label: string;
  /** Satu kalimat untuk orang awam. */
  jelas: string;
  /** Contoh nama program dari data nyata (tanpa nama principal). */
  contoh: string[];
  /** Jawaban untuk pertanyaan pemilih "Uang ini dipakai untuk apa?". */
  jawaban: string;
  /** Petunjuk beban yang paling sering dipakai pada kelompok ini (data form SPV). */
  catatanBeban?: string;
};

export const INFO_TIPE: Record<OffProgramType, InfoTipe> = {
  "Loyalty & Cashback Toko": {
    label: "Loyalty & Cashback Toko",
    jelas: "Uang untuk toko karena belanjanya mencapai target atau setia ikut program.",
    contoh: ["Cashback loyalty kuartal", "Rebate atau retro bulanan", "Insentif target toko", "Lock volume", "COG"],
    jawaban: "Toko mendapat cashback atau rebate karena mencapai target belanja",
  },
  "Listing & Biaya Ritel Modern": {
    label: "Listing & Biaya Ritel Modern",
    jelas: "Biaya supaya barang bisa masuk dan tetap dijual di toko modern seperti minimarket dan supermarket.",
    contoh: ["Listing fee", "Listing produk baru (NPD)", "Support fee atau DC fee", "Trading term"],
    jawaban: "Membayar biaya pendaftaran barang atau kerja sama di toko modern",
  },
  Display: {
    label: "Display",
    jelas: "Sewa tempat pajang khusus supaya barang mudah dilihat pembeli.",
    contoh: ["Sewa rak, gondola, atau end gondola", "Floor display", "Sewa COC dekat kasir", "Lomba display"],
    jawaban: "Toko dibayar untuk memajang barang di tempat khusus",
  },
  "Diskon & Rafaksi": {
    label: "Diskon & Rafaksi",
    jelas: "Potongan harga untuk toko di luar faktur, termasuk rafaksi atau penggantian selisih harga.",
    contoh: ["Rafaksi", "Potongan harga MTI", "Price protection", "Diskon tambahan"],
    jawaban: "Mengganti selisih harga atau memberi diskon ke toko di luar faktur",
  },
  "Insentif & Gaji Tenaga Penjual": {
    label: "Insentif & Gaji Tenaga Penjual",
    jelas: "Insentif, reward, atau gaji untuk salesman, SPG, motoris, dan tim penjual.",
    contoh: ["Insentif salesman", "Reward SPV dan SF", "Gaji sales eksklusif", "Gaji motoris"],
    jawaban: "Membayar insentif atau gaji tenaga penjual",
    catatanBeban: "Sebagian program ini memakai dana principal di distributor (DM). Periksa surat programnya.",
  },
  "Promo On Store": {
    label: "Promo Konsumen & Bonus Barang",
    jelas: "Potongan harga, voucher, atau bonus barang yang langsung dinikmati pembeli di toko.",
    contoh: ["Voucher potongan harga", "Consumer promo atau promo payday", "Bundling", "Beli 2 gratis 1"],
    jawaban: "Pembeli mendapat potongan harga, voucher, atau bonus barang",
  },
  Event: {
    label: "Event & Aktivasi",
    jelas: "Kegiatan di luar toko untuk mengenalkan produk ke konsumen.",
    contoh: ["Car free day", "Grebek pasar", "Sponsorship acara", "Lomba atau seminar"],
    jawaban: "Membiayai acara atau kegiatan di luar toko",
  },
  Visibility: {
    label: "Visibility & Branding",
    jelas: "Memasang merek di toko: spanduk, stiker, papan nama, atau sewa area visibility.",
    contoh: ["Sewa visibility", "Spanduk, stiker, atau papan nama", "Branding kantin", "Seragam bermerek"],
    jawaban: "Memasang tanda merek di toko",
  },
  Sample: {
    label: "Sampel & Free Drink",
    jelas: "Produk dibagikan gratis supaya dicoba konsumen.",
    contoh: ["Free drink", "Sampling produk baru", "Tester"],
    jawaban: "Membagikan produk gratis untuk dicoba",
  },
  "Hadiah & Relasi Toko": {
    label: "Hadiah & Relasi Toko",
    jelas: "Bingkisan untuk menjaga hubungan baik dengan pemilik toko.",
    contoh: ["Hampers hari raya", "Parcel", "Hajatan pemilik toko"],
    jawaban: "Memberi hadiah atau bingkisan ke pemilik toko",
    catatanBeban: "Hampir separuh program ini memakai dana principal di distributor (DM). Periksa surat programnya.",
  },
  "Retur & Near ED": {
    label: "Retur & Near ED",
    jelas: "Biaya menarik atau menghabiskan barang yang rusak atau hampir kedaluwarsa.",
    contoh: ["Flush out produk musiman", "Pencairan stok near ED", "Retur barang rusak"],
    jawaban: "Menghabiskan atau menarik barang yang rusak atau hampir kedaluwarsa",
  },
  Lainnya: {
    label: "Lainnya",
    jelas: "Tidak cocok dengan pilihan mana pun. Tulis alasannya supaya tim Klaim bisa memeriksa.",
    contoh: [],
    jawaban: "Tidak ada yang cocok",
  },
};

/** Pesan galat alasan "Lainnya"; route membandingkan teks ini untuk menjawab 400. */
export const PESAN_ALASAN_LAINNYA = "Alasan tipe program Lainnya wajib diisi.";

/**
 * Nilai kolom type_note untuk disimpan: alasan (dipangkas, maks 300 huruf) bila tipe "Lainnya"; data lama yang dipaksa ke
 * Lainnya memakai tipe asalnya sebagai alasan. Tipe lain = null. Melempar PESAN_ALASAN_LAINNYA bila Lainnya tanpa alasan.
 */
export function catatanTipeLainnya(tipe: string, alasan: unknown, tipeAsal = "", dipaksa = false): string | null {
  if (tipe !== TIPE_LAINNYA) return null;
  const isi = String(alasan ?? "").trim().slice(0, 300);
  if (isi) return isi;
  if (dipaksa && tipeAsal.trim()) return `Tipe asal: ${tipeAsal.trim()}`;
  throw new Error(PESAN_ALASAN_LAINNYA);
}

/** Label tampilan untuk nilai tipe tersimpan (SPV, CLM, atau nilai lama apa adanya). */
export function labelTipe(value: string | null | undefined): string {
  const v = String(value ?? "").trim();
  return (INFO_TIPE as Record<string, InfoTipe | undefined>)[v]?.label ?? v;
}

/**
 * Tipe program khusus untuk pengajuan versi CLAIM (#1-3).
 * Data ini berasal dari direksi ke divisi Claim, bukan dari Supervisor.
 * No Pengajuan CLM menggunakan format: gelombang/CLM/kode/bulan/tahun.
 */
export const OFF_CLM_PROGRAM_TYPES = [
  "Insentif",
  "Diskon Reguler",
  "Insentif Distributor",
  "Retur",
] as const;

export type OffClmProgramType = (typeof OFF_CLM_PROGRAM_TYPES)[number];

/** Nilai tipe yang sah disimpan: dropdown SPV atau tipe CLM. */
export type OffTipeTersimpan = OffProgramType | OffClmProgramType;

/** Tipe default ketika data lama tidak bisa dipetakan ke dropdown baru. */
export const OFF_PROGRAM_TYPE_FALLBACK: OffProgramType = TIPE_LAINNYA;

/**
 * Saran tipe dari nama program (aturan kata kunci, urutan = prioritas; yang spesifik dulu). Disusun dari 3.738 baris form SPV
 * dan 9.478 baris register klaim (3 Nov 2026); menutup ±99% baris form SPV. Hanya SARAN: Supervisor tetap memilih sendiri.
 * ponytail: daftar kata kunci tetap di kode; pindahkan ke tabel pengaturan bila tim Klaim perlu menambah kata kunci sendiri.
 */
const ATURAN_SARAN: Array<[OffTipeTersimpan, RegExp]> = [
  ["Retur & Near ED", /SHRI?N?G?KAGE|LIKUIDASI|RETUR|RETURN|EXPIRED|\bED\b|BAD ?STOCK|\bBS\b|DAMAGE|RUSAK|FLUSH ?OUT|PEMUSNAHAN|KADALUAR|GANTI BARANG/],
  ["Sample", /SAMPLE|SAMPEL|SAMPLING|TESTER|FREE DRINK|ICIP/],
  ["Insentif & Gaji Tenaga Penjual", /GAJI|SALARY|PENGGAJIAN|MOTORIS|\bSPG\b|\bSPB\b|MERCHANDISER|\bMD\b|SALESMAN|SALES ?FORCE|INSENT\w* (SALES|TEAM|TIM|SPV|SUPERVISOR|ADMIN|AO)\b|INCENTIVE SALES|\bTHR\b|\bBBM\b|\bKAS\b|\bSDM\b|\bJSM\b|REWARD SPV|\bDSS\b|EXC?LUSIVE|HAPPY POINT|FREELANCER/],
  ["Insentif Distributor", /INSENT\w* DISTRIBUTOR|DISTRIBUTOR INCENTIVE|SERVICE FEE|\bDSF\b|SUPPORT DIST|DANA MARKETING|SELMAR|\bSDS\b|CORDIA?L/],
  ["Listing & Biaya Ritel Modern", /LISTING|\bNPD\b|NEW PRODUCT|REGISTRASI|DC ?FEE|TRADING TERM|\bTTS\b|\bMSL\b|ASSORTMENT|SUPPORT ?FEE|PENALTY|PROMOTION INCOME|JASA MANAJEMEN|PEMAKAIAN FASILITAS|BANK GARANSI|DEPOSIT|DEBIT NOTE|ANNIV|VENDOR|IDM CONNECT|PERJANJIAN|REMOVAL|\bB2B\b|\bJBP\b/],
  ["Hadiah & Relasi Toko", /HAMPERS|PARCEL|HAJATAN|ENTERTAIN|UCAPAN|SANTUNAN|SUMBANGAN|DONASI|KARANGAN BUNGA/],
  ["Display", /DISPLAY|DISPLY|GONDOLA|SHELV|SELVING|\bRAK\b|FLOOR|\bCOC\b|PERFECT STORE|PAJANG|CHILLER|SHOWCASE|HANGER|PALLET|ISLAND|DUMBIN|LUCKY TREE|SEWA BLOCK/],
  ["Visibility", /VISIBIL|BRANDING|BRANDDING|SIGNAGE|SHOP ?SIG[NH]|STIKER|STICKER|WOBBLER|SPA?NA?DUK|BANNER|NEON|PAPAN|POSM|PLANO|SERAGAM|KAOS|BAJU|CELEMEK|KATALOG|DRESS UP/],
  ["Event", /EVENT|FAIR|GREBEK|PASAR MURAH|LOMBA|KONTES|SPONSOR|OUTBOUND|FESTIV|PAMERAN|BAZAR|SENAM|ROADSHOW|ACTIVATION|AKTIVASI|KEGIATAN|GATHERING|BERMAIN|LUCKY DIP|TITIK KERAMAIAN|ACTIVITY|NIGHT|CAMPAIGN|CELEBRATION|COOKING|DEMO|SAFARI|JUMATAN|CHALLENGE|CAR FREE|\bCFD\b|SEMINAR|TURNAMEN|TOURNAMENT|FUN ?WALK|JALAN SEHAT|PENSI|PARTY|\bBTL\b|POUNDFIT|DONGENG|COMPETITION|KOMPETISI|BUKBER|BUKA BERSAMA/],
  ["Loyalty & Cashback Toko", /LOYAL|CASH ?BACK|REBATE|REBAT|RABATE|RETRO|REWARD|IKAT TARGET|TARGET|LOCK ?(VOLUME|ORDER)|PROGRAMLOCK|KIBAS|TT[- ]CONDI|\bBDP\b|KOMITMEN|BOOSTER|GO RETAIL|HYBRID|FOKUS|FOKDIS|DISTRIBUSI|DISTRIBUTION|VALUE AO|TUKAR BUNGKUS|SILVER|GOLD|\bCOG\b|INSENT\w*|INCENTIVE/],
  ["Promo On Store", /\d\s*\+\s*\d|\bB\dG\d\b|BONUS|BOGOF|\bBUY\b|GRATIS|HADIAH|GIMMICK|BUNDLING|BANDED|\bPWP\b|VOUCHER|VOUCER|VOCER|CONSUMER|CUSTOMER PROMO|PAYDAY|PROMO ON STORE|IN ?STORE|KUPON/],
  ["Diskon & Rafaksi", /DISK|DISC|POTONG|\bPOT\b|RAF?R?AK|REFAK|RAFASKI|RAKASI|PRICE PRO|CUT PRI[CZ]E|SUBSIDI|STRATA|TEPAT BAYAR|HARGA|SELISIH|%/],
];

/**
 * Saran tipe dari nama program bebas; null bila tidak ada kata kunci yang cocok (Supervisor memilih sendiri).
 * Bisa mengembalikan tipe CLM (mis. "Insentif Distributor"): pemanggil memutuskan cara menampilkannya.
 */
export function sarankanTipe(namaProgram: string | null | undefined): OffTipeTersimpan | null {
  const t = String(namaProgram ?? "").toUpperCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < 3) return null;
  return ATURAN_SARAN.find(([, rx]) => rx.test(t))?.[0] ?? null;
}

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

// Pemetaan eksplisit alias/typo umum untuk tipe CLM — dikembalikan as-is karena
// tersimpan langsung sebagai string (OFF_CLM_PROGRAM_TYPES bukan sub-tipe OffProgramType).
// Normalisasi untuk tipe CLM dilakukan di fungsi terpisah (isOffClmProgramType, normalizeClmProgramType).
export function isOffClmProgramType(value: unknown): value is OffClmProgramType {
  const key = String(value ?? "").trim().toLowerCase();
  return (OFF_CLM_PROGRAM_TYPES as readonly string[]).some(
    (t) => t.toLowerCase() === key,
  );
}

export function normalizeClmProgramType(value: unknown): OffClmProgramType | null {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return null;
  const exact = OFF_CLM_PROGRAM_TYPES.find((t) => t.toLowerCase() === key);
  return exact ?? null;
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
  // Label tampilan (INFO_TIPE) yang terketik/tersalin sebagai nilai.
  "promo konsumen & bonus barang": "Promo On Store",
  "promo konsumen": "Promo On Store",
  "event & aktivasi": "Event",
  "visibility & branding": "Visibility",
  "sampel & free drink": "Sample",
  "free drink": "Sample",
  // Kelompok baru 3 Nov 2026 (ejaan pendek yang lazim di form Excel).
  loyalty: "Loyalty & Cashback Toko",
  cashback: "Loyalty & Cashback Toko",
  listing: "Listing & Biaya Ritel Modern",
  "listing fee": "Listing & Biaya Ritel Modern",
  rafaksi: "Diskon & Rafaksi",
  diskon: "Diskon & Rafaksi",
  hampers: "Hadiah & Relasi Toko",
  lain: "Lainnya",
  "lain-lain": "Lainnya",
};

/**
 * Normalisasi nilai tipe program ke dropdown final.
 * Mengembalikan salah satu OFF_PROGRAM_TYPES, atau null jika kosong/tidak dikenali.
 *
 * Catatan: null berarti "tidak dikenali" sehingga pemanggil bisa memutuskan
 * fallback (mis. Supervisor wajib memilih ulang, atau dipaksa ke Lainnya untuk
 * migrasi legacy). Lihat resolveProgramType untuk perilaku terpadu.
 */
export function normalizeProgramType(value: unknown): OffTipeTersimpan | null {
  const key = canonicalKey(value);
  if (!key) return null;

  // 1. Exact match (case-insensitive) ke dropdown final.
  const exact = OFF_PROGRAM_TYPES.find(
    (type) => canonicalKey(type) === key,
  );
  if (exact) return exact;

  // 2. Alias/typo eksplisit.
  // 2. Tipe CLM persis disimpan apa adanya (dulu jatuh ke fallback karena hanya dibandingkan dengan dropdown SPV).
  const clm = OFF_CLM_PROGRAM_TYPES.find((t) => canonicalKey(t) === key);
  if (clm) return clm;
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
  normalizedType: OffTipeTersimpan;
  /** Nilai asli sebelum normalisasi (audit legacy). */
  originalType: string;
  /** True bila berasal dari data lama (tidak exact match dropdown final). */
  typeIsLegacy: boolean;
  /** True bila tipe asli tidak dikenali sehingga dipaksa ke fallback (Lainnya). */
  forcedToFallback: boolean;
  /** True bila tipe asli sudah cocok persis dengan dropdown final (case-insensitive). */
  isExactNewType: boolean;
};

/**
 * Resolusi terpadu tipe program untuk penyimpanan + audit.
 * - Jika nilai exact dropdown final -> typeIsLegacy=false.
 * - Jika typo/alias dikenali -> normalisasi + typeIsLegacy=true.
 * - Jika tidak dikenali sama sekali -> fallback Lainnya + typeIsLegacy=true + forcedToFallback.
 */
export function resolveProgramType(value: unknown): ResolvedProgramType {
  const originalType = String(value ?? "").trim();
  const exact = [...OFF_PROGRAM_TYPES, ...OFF_CLM_PROGRAM_TYPES].find(
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
 * - Tipe tidak dikenali tetap dipaksa ke fallback (Lainnya) + forcedToFallback.
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
  normalizedType: OffTipeTersimpan;
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
