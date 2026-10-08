/**
 * No Claim generation rules.
 *
 * NOTE:
 * This file maps existing DB principleCode to Excel-style No Claim formats.
 * It must not replace existing OFF Program / Claim Workflow business rules.
 * claim_submission.noClaim remains the source of truth.
 * These rules are only used to help staff generate a No Claim preview.
 * Manual override must remain available because some principals use exceptions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoClaimSequenceType = "number" | "text" | "roman";

export type NoClaimYearFormat = "YYYY" | "YY";

export type NoClaimRule = {
  principleCode: string;
  label: string;
  noClaimKey: string | null;
  pattern: string;
  padWidth: number | null;
  sequenceType: NoClaimSequenceType;
  yearFormat: NoClaimYearFormat;
  manualSequence: boolean;
  allowManualOverride: boolean;
  note?: string;
};

export type NoClaimRuleVariant = NoClaimRule & {
  variantKey: string;
};

export type NoClaimRuleConfig =
  | NoClaimRule
  | {
      principleCode: string;
      label: string;
      variants: NoClaimRuleVariant[];
      allowManualOverride: boolean;
      note?: string;
    };

// ---------------------------------------------------------------------------
// Mapping: principleCode (DB) -> No Claim rule
// ---------------------------------------------------------------------------

export const noClaimRuleConfigs: NoClaimRuleConfig[] = [
  // --- GDI (Godrej) ---
  {
    principleCode: "GDI",
    label: "Godrej",
    noClaimKey: "GCPI",
    pattern: "{seq}/SUPER-GCPI/{month}/{year4}",
    padWidth: 2,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- KINO ---
  {
    principleCode: "KINO",
    label: "Kino",
    noClaimKey: "KN",
    pattern: "{seq}/SUPER-KN/{month}/{year4}",
    padWidth: 2,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- URC ---
  {
    principleCode: "URC",
    label: "URC",
    noClaimKey: "RC",
    pattern: "{seq}/SP-RC/{month}/{year2}",
    padWidth: 2,
    sequenceType: "number",
    yearFormat: "YY",
    manualSequence: true,
    allowManualOverride: true,
    note: "Excel uses SP-RC with 2 digit sequence and 2 digit year.",
  },
  // --- RB (Reckitt) ---
  {
    principleCode: "RB",
    label: "Reckitt",
    noClaimKey: null,
    pattern: "{seq}/SP-{month}/{year2}",
    padWidth: 2,
    sequenceType: "number",
    yearFormat: "YY",
    manualSequence: true,
    allowManualOverride: true,
    note: "Reckitt Excel does not include RB in No Claim. Do not support NP_029 sequence for now.",
  },
  // --- ENI (Energizer) ---
  {
    principleCode: "ENI",
    label: "Energizer",
    noClaimKey: "DC",
    pattern: "DC/{seq}/{month}/{year4}",
    padWidth: null,
    sequenceType: "text",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
    note: "Excel uses manual roman-like sequence such as I, II, III. Keep sequence manual text.",
  },
  // --- HEINZ (variants: HZ / BS) ---
  {
    principleCode: "HEINZ",
    label: "Heinz",
    variants: [
      {
        principleCode: "HEINZ",
        label: "Heinz (HZ)",
        variantKey: "HZ",
        noClaimKey: "HZ",
        pattern: "{seq}/SUPER-HZ/{month}/{year4}",
        padWidth: 3,
        sequenceType: "number",
        yearFormat: "YYYY",
        manualSequence: true,
        allowManualOverride: true,
      },
      {
        principleCode: "HEINZ",
        label: "Heinz (BS)",
        variantKey: "BS",
        noClaimKey: "BS",
        pattern: "{seq}/SUPER-BS/{month}/{year4}",
        padWidth: 3,
        sequenceType: "number",
        yearFormat: "YYYY",
        manualSequence: true,
        allowManualOverride: true,
      },
    ],
    allowManualOverride: true,
    note: "Heinz workbook can contain HZ and BS. User must choose key from dropdown.",
  },
  // --- ABC ---
  {
    principleCode: "ABC",
    label: "ABC President",
    noClaimKey: "ABCPI",
    pattern: "{seq}/SUPER-ABCPI/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- CUSSONS ---
  {
    principleCode: "CUSSONS",
    label: "Cussons",
    noClaimKey: "CUS",
    pattern: "{seq}/SUPER-CUS/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- USM ---
  {
    principleCode: "USM",
    label: "Unitama Sari Mas",
    noClaimKey: "USM",
    pattern: "{seq}/SUPER-USM/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- DOLPHIN ---
  {
    principleCode: "DOLPHIN",
    label: "Dolphin",
    noClaimKey: "DLP",
    pattern: "{seq}/SUPER-DLP/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- FKS ---
  {
    principleCode: "FKS",
    label: "FKS Food Sejahtera",
    noClaimKey: "FKS",
    pattern: "{seq}/SUPER-FKS/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- FON (Fonterra) ---
  {
    principleCode: "FON",
    label: "Fonterra",
    noClaimKey: "FON",
    pattern: "{seq}/SUPER-FON/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- FRS (Forisa) ---
  {
    principleCode: "FRS",
    label: "Forisa",
    noClaimKey: "FRS",
    pattern: "{seq}/SUPER-FRS/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- MI (Marketama Indah) ---
  {
    principleCode: "MI",
    label: "Marketama Indah",
    noClaimKey: "MI",
    pattern: "{seq}/SUPER-MI/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- MOTASA ---
  {
    principleCode: "MOTASA",
    label: "Motasa",
    noClaimKey: "MTS",
    pattern: "{seq}/SUPER-MTS/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- MR (Mustika Ratubuana) ---
  {
    principleCode: "MR",
    label: "Mustika Ratubuana",
    noClaimKey: "MRBI",
    pattern: "{seq}/SUPER-MRBI/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- PAS (Primarasa Abadi Sejahtera) ---
  {
    principleCode: "PAS",
    label: "Primarasa Abadi Sejahtera",
    noClaimKey: "PAS",
    pattern: "{seq}/SUPER-PAS/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- PRISKILA ---
  {
    principleCode: "PRISKILA",
    label: "Priskila Prima Makmur",
    noClaimKey: "PR",
    pattern: "{seq}/SUPER-PR/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- UNIBIS (Universal Indofood Product) ---
  {
    principleCode: "UNIBIS",
    label: "Universal Indofood Product",
    noClaimKey: "UN",
    pattern: "{seq}/SUPER-UN/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- VINDA ---
  {
    principleCode: "VINDA",
    label: "Vinda International",
    noClaimKey: "VII",
    pattern: "{seq}/SUPER-VII/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- SHINZUI (Fokus Ritel Nusaprima) ---
  {
    principleCode: "SHINZUI",
    label: "Shinzui (Fokus Ritel)",
    noClaimKey: "MS",
    pattern: "{seq}/SUPER-MS/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- PURATOS ---
  {
    principleCode: "PURATOS",
    label: "Puratos",
    noClaimKey: "PI",
    pattern: "{seq}/SUPER-PI/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
  },
  // --- REBO (Gumindo Bogamanis) ---
  {
    principleCode: "REBO",
    label: "Gumindo Bogamanis",
    noClaimKey: "GUMINDO",
    pattern: "{seq}/SUPER-GUMINDO/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
    note: "Need verify: Excel scan found GUMINDO, ensure it maps to DB principleCode REBO.",
  },
  // --- SPS (Sun Paper Source) ---
  {
    principleCode: "SPS",
    label: "Sun Paper Source",
    noClaimKey: "GTK",
    pattern: "{seq}/SUPER-GTK/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
    note: "Need verify: Excel scan found GTK, ensure it maps to DB principleCode SPS.",
  },
  // --- NATUR (Gondowangi Tradisional Kosmetik) ---
  {
    principleCode: "NATUR",
    label: "Gondowangi (Natur)",
    noClaimKey: "FRN",
    pattern: "{seq}/SUPER-FRN/{month}/{year4}",
    padWidth: 3,
    sequenceType: "number",
    yearFormat: "YYYY",
    manualSequence: true,
    allowManualOverride: true,
    note: "Need verify: Excel scan found FRN, ensure it maps to DB principleCode NATUR.",
  },
];

// ---------------------------------------------------------------------------
// Internal index for fast lookup
// ---------------------------------------------------------------------------

const ruleByPrincipleCode = new Map<string, NoClaimRuleConfig>();
for (const config of noClaimRuleConfigs) {
  ruleByPrincipleCode.set(config.principleCode, config);
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isNoClaimRuleWithVariants(
  rule: NoClaimRuleConfig,
): rule is Extract<NoClaimRuleConfig, { variants: NoClaimRuleVariant[] }> {
  return "variants" in rule;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Get rule config by DB principleCode. Returns undefined if not mapped.
 */
export function getNoClaimRule(
  principleCode: string,
): NoClaimRuleConfig | undefined {
  return ruleByPrincipleCode.get(principleCode);
}

/**
 * Get variant list for a principleCode. Returns empty array if rule has
 * no variants or principleCode is not mapped.
 */
export function getNoClaimRuleVariants(
  principleCode: string,
): NoClaimRuleVariant[] {
  const config = ruleByPrincipleCode.get(principleCode);
  if (!config || !isNoClaimRuleWithVariants(config)) return [];
  return config.variants;
}

/**
 * Resolve a concrete NoClaimRule for a principleCode + optional variantKey.
 * - If rule has no variants, returns the rule directly.
 * - If rule has variants and variantKey is provided, returns the matching variant.
 * - If rule has variants but no variantKey, returns the first variant as default.
 * - Returns undefined if principleCode is not mapped.
 */
export function resolveNoClaimRule(
  principleCode: string,
  variantKey?: string,
): NoClaimRule | undefined {
  const config = ruleByPrincipleCode.get(principleCode);
  if (!config) return undefined;

  if (isNoClaimRuleWithVariants(config)) {
    if (variantKey) {
      return config.variants.find((v) => v.variantKey === variantKey);
    }
    return config.variants[0];
  }

  return config;
}

/**
 * Get the noClaimKey for display/lookup purposes.
 * Returns null if principleCode is not mapped or rule has no noClaimKey (e.g. RB).
 */
export function getNoClaimKey(
  principleCode: string,
  variantKey?: string,
): string | null {
  const rule = resolveNoClaimRule(principleCode, variantKey);
  return rule?.noClaimKey ?? null;
}

// ---------------------------------------------------------------------------
// Sequence formatting
// ---------------------------------------------------------------------------

/**
 * Format sequence value according to rule.
 * - "number": if all digits, pad to padWidth; otherwise keep as-is.
 * - "text" / "roman": trim only, no padding.
 */
export function formatNoClaimSequenceFromRule(
  sequence: string,
  padWidth: number | null,
  sequenceType: NoClaimSequenceType,
): string {
  const trimmed = String(sequence ?? "").trim();
  if (!trimmed) return "";

  if (sequenceType === "number" && /^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 1) return trimmed;
    if (padWidth != null && padWidth > 0) {
      return String(n).padStart(padWidth, "0");
    }
    return String(n);
  }

  // text or roman: keep as-is (trimmed)
  return trimmed;
}

// ---------------------------------------------------------------------------
// Year formatting
// ---------------------------------------------------------------------------

/**
 * Format year according to yearFormat.
 * "YYYY" -> full 4-digit year (e.g. "2026")
 * "YY"   -> last 2 digits (e.g. "26")
 */
export function formatNoClaimYear(
  year: string | number,
  yearFormat: NoClaimYearFormat,
): string {
  const y = String(year ?? "").trim();
  if (!y) return "";
  if (yearFormat === "YY") {
    // Take last 2 digits
    return y.length > 2 ? y.slice(-2) : y;
  }
  // YYYY: ensure 4 digits
  return y.padStart(4, "0");
}

// ---------------------------------------------------------------------------
// Build No Claim string from rule
// ---------------------------------------------------------------------------

export type NoClaimBuildInput = {
  sequence: string;
  month: string;
  year: string | number;
  variantKey?: string;
};

/**
 * Build a No Claim string from rule + input.
 * Replaces tokens: {seq}, {month}, {year4}, {year2}
 * Returns empty string if required parts are missing.
 */
export function buildNoClaimFromRule(
  rule: NoClaimRule,
  input: NoClaimBuildInput,
): string {
  const seq = formatNoClaimSequenceFromRule(
    input.sequence,
    rule.padWidth,
    rule.sequenceType,
  );
  if (!seq) return "";

  const month = String(input.month ?? "").trim();
  if (!/^\d{1,2}$/.test(month)) return "";
  const mm = month.padStart(2, "0");

  const year4 = formatNoClaimYear(input.year, "YYYY");
  const year2 = formatNoClaimYear(input.year, "YY");
  if (!year4) return "";

  return rule.pattern
    .replace(/\{seq\}/g, seq)
    .replace(/\{month\}/g, mm)
    .replace(/\{year4\}/g, year4)
    .replace(/\{year2\}/g, year2);
}

// ---------------------------------------------------------------------------
// Convenience: build from principleCode directly
// ---------------------------------------------------------------------------

/**
 * Build No Claim string by looking up rule from principleCode + optional
 * variantKey, then applying the pattern.
 * Returns null if principleCode is not mapped.
 * Returns empty string if input validation fails (caller can show error).
 */
export function buildNoClaimForPrinciple(
  principleCode: string,
  input: NoClaimBuildInput,
): string | null {
  const rule = resolveNoClaimRule(principleCode, input.variantKey);
  if (!rule) return null;
  return buildNoClaimFromRule(rule, input);
}

// ---------------------------------------------------------------------------
// List helpers (for UI dropdowns)
// ---------------------------------------------------------------------------

/**
 * Get all mapped principleCodes with their labels.
 * Useful for building a filter/dropdown in reports or UI.
 */
export function getAllNoClaimRuleOptions(): Array<{
  principleCode: string;
  label: string;
  hasVariants: boolean;
}> {
  return noClaimRuleConfigs.map((config) => ({
    principleCode: config.principleCode,
    label: config.label,
    hasVariants: isNoClaimRuleWithVariants(config),
  }));
}

// ---------------------------------------------------------------------------
// Templat dari DB (S4b, owner 8 Okt 2026): baris no_claim_template menimpa
// bawaan di atas per (principleCode, variantKey). variantKey "" = tanpa varian.
// ---------------------------------------------------------------------------

export type NoClaimTemplateRow = {
  principleCode: string;
  variantKey: string;
  label: string;
  pattern: string;
  padWidth: number | null;
  sequenceType: string;
};

const NO_CLAIM_TOKEN = /\{(\w+)\}/g;
const NO_CLAIM_TOKENS = new Set(["seq", "month", "year4", "year2"]);

/** Validasi isian templat. Galat berbahasa Indonesia, atau templat yang sudah dirapikan. */
export function validateNoClaimTemplate(
  input: Record<string, unknown>,
): { ok: true; row: NoClaimTemplateRow } | { ok: false; error: string } {
  const principleCode = String(input.principleCode ?? "").trim().toUpperCase();
  const variantKey = String(input.variantKey ?? "").trim().toUpperCase();
  const pattern = String(input.pattern ?? "").trim();
  const label = String(input.label ?? "").trim() || principleCode;
  const sequenceType = String(input.sequenceType ?? "number");
  const padWidth = input.padWidth === null || input.padWidth === undefined || input.padWidth === "" ? null : Number(input.padWidth);
  if (!/^[A-Z0-9_-]{1,20}$/.test(principleCode)) return { ok: false, error: "Kode principal tidak valid." };
  if (!/^[A-Z0-9_-]{0,20}$/.test(variantKey)) return { ok: false, error: "Kode varian tidak valid." };
  if (!pattern || pattern.length > 100) return { ok: false, error: "Pola No Claim wajib diisi (maksimal 100 karakter)." };
  if (!pattern.includes("{seq}")) return { ok: false, error: "Pola No Claim wajib memuat {seq}." };
  const unknown = [...pattern.matchAll(NO_CLAIM_TOKEN)].map((m) => m[1]).filter((t) => !NO_CLAIM_TOKENS.has(t));
  if (unknown.length) return { ok: false, error: `Token tidak dikenal: {${unknown.join("}, {")}}. Pakai {seq}, {month}, {year4}, {year2}.` };
  if (!["number", "text", "roman"].includes(sequenceType)) return { ok: false, error: "Jenis urutan harus number, text, atau roman." };
  if (padWidth !== null && (!Number.isInteger(padWidth) || padWidth < 1 || padWidth > 6))
    return { ok: false, error: "Lebar nomor urut harus 1–6 atau kosong." };
  return { ok: true, row: { principleCode, variantKey, label, pattern, padWidth, sequenceType } };
}

function ruleFromRow(row: NoClaimTemplateRow, base?: NoClaimRule): NoClaimRule {
  return {
    principleCode: row.principleCode,
    label: row.label,
    noClaimKey: base?.noClaimKey ?? (row.variantKey || null),
    pattern: row.pattern,
    padWidth: row.padWidth,
    sequenceType: row.sequenceType as NoClaimSequenceType,
    yearFormat: row.pattern.includes("{year2}") ? "YY" : "YYYY",
    manualSequence: true,
    allowManualOverride: true,
    note: base?.note,
  };
}

/** Bawaan kode ditimpa baris DB; baris DB untuk principal/varian baru ikut ditambahkan. */
export function mergeNoClaimTemplates(
  rows: NoClaimTemplateRow[],
  base: NoClaimRuleConfig[] = noClaimRuleConfigs,
): NoClaimRuleConfig[] {
  const byKey = new Map(rows.map((r) => [`${r.principleCode}|${r.variantKey}`, r]));
  const used = new Set<string>();
  const take = (code: string, variant: string) => {
    const key = `${code}|${variant}`;
    const row = byKey.get(key);
    if (row) used.add(key);
    return row;
  };
  const merged: NoClaimRuleConfig[] = base.map((config) => {
    if (!isNoClaimRuleWithVariants(config)) {
      const row = take(config.principleCode, "");
      return row ? ruleFromRow(row, config) : config;
    }
    const variants = config.variants.map((v) => {
      const row = take(v.principleCode, v.variantKey);
      return row ? { ...ruleFromRow(row, v), variantKey: v.variantKey } : v;
    });
    const extra = rows
      .filter((r) => r.principleCode === config.principleCode && r.variantKey && !used.has(`${r.principleCode}|${r.variantKey}`))
      .map((r) => (used.add(`${r.principleCode}|${r.variantKey}`), { ...ruleFromRow(r), variantKey: r.variantKey }));
    return { ...config, variants: [...variants, ...extra] };
  });
  // ponytail: principal baru tanpa bawaan hanya didukung tanpa varian; varian baru = tambah ke kode dulu.
  for (const r of rows) if (!used.has(`${r.principleCode}|${r.variantKey}`) && !r.variantKey) merged.push(ruleFromRow(r));
  return merged;
}
