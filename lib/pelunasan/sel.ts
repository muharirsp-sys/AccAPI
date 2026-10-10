/**
 * Tujuan: pembaca sel baris Excel Pelunasan (keluaran `sheet_to_json`) — dipindah UTUH dari W:275-292
 *   (`app/(dashboard)/api-wrapper/page.tsx`, basis 5d6cc936) tanpa perubahan perilaku (S6e-1).
 * Caller: lib/pelunasan/{parser,retur,alokasi}.ts.
 * Main Functions: getVal, getTextVal, hasMeaningfulCellValue.
 * Side Effects: tidak ada (murni).
 */
// Baris Excel & dokumen Accurate bebas bentuk; bentuknya dikunci uji golden lib/pelunasan/pelunasan.test.ts.
export type Bebas = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- baris Excel/JSON Accurate bebas bentuk (pola sales-receipt-fingerprint.ts)

export const getVal = (row: Bebas, keyMatch: string) => {
    const foundKey = Object.keys(row).find(k => k.trim() === keyMatch);
    return foundKey ? row[foundKey] : undefined;
};

export const getTextVal = (row: Bebas, keyMatch: string) => {
    const rawVal = getVal(row, keyMatch);
    if (rawVal === undefined || rawVal === null) return "";
    const text = String(rawVal).replace(/ /g, " ").trim();
    if (!text || ["nan", "undefined", "null"].includes(text.toLowerCase())) return "";
    return text;
};

export const hasMeaningfulCellValue = (row: Bebas, keyMatch: string) => {
    const rawVal = getVal(row, keyMatch);
    if (rawVal === undefined || rawVal === null) return false;
    const text = String(rawVal).replace(/ /g, " ").trim();
    return !!text && !["nan", "undefined", "null"].includes(text.toLowerCase());
};
