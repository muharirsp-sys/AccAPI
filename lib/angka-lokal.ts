/*
 * Tujuan: Parser angka rupiah ketikan manusia / teks sel (cermin parse_number_strict Python, S6-0c) TANPA dependensi — aman untuk bundel
 *   klien (layar /kasir tidak ikut menarik SheetJS). Aturan lengkap: komentar di lib/insentif-sales-excel.ts (yang mengekspor ulang).
 * Caller: lib/insentif-sales-excel (parseLocaleNumber, ekspor ulang), app/(dashboard)/kasir/bersama (nominalKeTeks, ekspor ulang), isian rupiah
 *   Insentif Sales (Support, Pengaturan) dan OPC (Nilai fix KlaimFinal): satu pengurai rupiah id-ID (audit desain 001 No 122).
 * Dependensi: lib/kasir/rekonsiliasi (keSen — murni).
 * Main Functions: angkaLokalTeks (teks desimal persis, tanpa float), parseLocaleNumber (angka), nominalKeTeks (isian rupiah -> teks server;
 *   opsi `ketat` = titik hanya pemisah ribuan), isianPolos (teks isian saat fokus, tanpa pemisah ribuan),
 *   isianNominal (angka -> teks isian id-ID untuk format sesudah blur).
 * Side Effects: tidak ada.
 */

import { keSen } from "./kasir/rekonsiliasi.ts";

/** Batas panjang teks angka, sama dengan _STRICT_MAX_LEN Python: pagar backtracking regex dan teks catatan. */
const ANGKA_MAKS = 40;
const AMPLOP = /^-?\s*(?:rp\.?|idr)?\s*-?\s*[0-9][0-9.,\s]*(?:,-)?$/i;
const RIBUAN: Record<"." | ",", RegExp> = { ".": /^[1-9]\d{0,2}(?:\.\d{3})+$/, ",": /^[1-9]\d{0,2}(?:,\d{3})+$/ };

/** Badan angka tanpa tanda/prefix (hanya digit . ,) → teks desimal bertitik ("1250000", "1234.56"), atau null bila pengelompokan tidak sah. */
function intiTeks(b: string): string | null {
    if (/^\d+$/.test(b)) return b;
    const titik = b.includes("."), koma = b.includes(",");
    if (titik && koma) {
        const des = b.lastIndexOf(",") > b.lastIndexOf(".") ? "," : ".";
        const grup = des === "," ? "." : ",";
        const i = b.lastIndexOf(des);
        const bulat = b.slice(0, i), pecahan = b.slice(i + 1);
        if (!/^\d+$/.test(pecahan) || !(/^\d+$/.test(bulat) || RIBUAN[grup].test(bulat))) return null;
        return `${bulat.split(grup).join("")}.${pecahan}`;
    }
    const sep = titik ? "." : ",";
    if (RIBUAN[sep].test(b)) return b.split(sep).join("");
    const bagian = b.split(sep);
    return bagian.length === 2 && /^\d+$/.test(bagian[0]) && /^\d+$/.test(bagian[1]) ? `${bagian[0]}.${bagian[1]}` : null;
}

/**
 * Teks → teks desimal PERSIS ("-250.5", "1250000.555", "0"); null = bukan angka. Jumlah desimal terbaca dari teks ini, bukan dari float
 * (float membulatkan "1,0000000000000001" menjadi 1).
 */
export function angkaLokalTeks(text: string): string | null {
    const t = text.trim();
    if (t === "" || t === "-") return "0";
    if (t.length > ANGKA_MAKS || !AMPLOP.test(t) || (t.replace(/,-$/, "").match(/-/g) ?? []).length > 1) return null;
    let b = t.replace(/(rp|idr)\.?/gi, "").replace(/[^0-9.,-]/g, "").replace(/[,.]-+$/, "");
    const negatif = b.startsWith("-");
    if (negatif) b = b.slice(1);
    if (b.includes("-")) return null;
    const v = intiTeks(b);
    return v === null ? null : negatif ? `-${v}` : v;
}

/** Angka dari teks sel; NaN = bukan angka (pemanggil wajib menolak, bukan menjadikannya 0). */
export function parseLocaleNumber(text: string): number {
    const v = angkaLokalTeks(text);
    return v === null ? NaN : Number(v);
}

/** Batas server §8.4 (Rp 100 miliar per kolom). */
export const MAKS_NOMINAL = 100_000_000_000;

export const GALAT_TITIK = "Titik hanya pemisah ribuan (mis. 1.500.000); desimal ditulis dengan koma (mis. 1.500.000,50).";

/**
 * Isian rupiah di layar berformat ribuan id-ID (tinjauan K3 S-1): titik HANYA pemisah ribuan berkelompok 3 digit, koma satu-satunya pemisah
 * desimal. "500.00" (sisa "500.000" yang terhapus satu digit), "50.0000", "1.50" ditolak dengan GALAT_TITIK, bukan dibaca desimal; "1,500" = 1,5.
 * Amplop (Rp, spasi, ",-", tanda) sama dengan angkaLokalTeks. null = bukan angka.
 */
function teksKetat(isian: string): string | { galat: string } | null {
    const t = isian.trim();
    if (t === "" || t === "-") return "0";
    if (t.length > ANGKA_MAKS || !AMPLOP.test(t) || (t.replace(/,-$/, "").match(/-/g) ?? []).length > 1) return null;
    let b = t.replace(/(rp|idr)\.?/gi, "").replace(/[^0-9.,-]/g, "").replace(/[,.]-+$/, "");
    const negatif = b.startsWith("-");
    if (negatif) b = b.slice(1);
    if (b.includes("-")) return null;
    const [bulat, pecahan, ...lebih] = b.split(",");
    if (lebih.length || (pecahan !== undefined && !/^\d+$/.test(pecahan))) return null;
    if (!/^\d+$/.test(bulat) && !RIBUAN["."].test(bulat)) return { galat: GALAT_TITIK };
    const v = `${bulat.split(".").join("")}${pecahan === undefined ? "" : `.${pecahan}`}`;
    return negatif ? `-${v}` : v;
}

/**
 * Isian manusia ("Rp 1.250.000", "1.250.000,50", kosong = 0) -> teks desimal untuk server ("1250000", "1250000.5"); galat bila tidak sah
 * (negatif, > 2 desimal — dihitung dari TEKS, bukan float — atau di luar batas). Sen bulat TEPAT (keSen), teks dibentuk dari sen.
 * `ketat` (isian rupiah Insentif Sales dan Nilai fix OPC): titik hanya pemisah ribuan (teksKetat). Bawaan tidak ketat = perilaku Kasir.
 */
export function nominalKeTeks(isian: string, opsi: { ketat?: boolean } = {}): { teks: string; sen: number } | { galat: string } {
    const baca = opsi.ketat ? teksKetat(isian) : angkaLokalTeks(isian);
    if (baca !== null && typeof baca === "object") return baca;
    const t = baca;
    if (t === null) return { galat: "Isi angka rupiah yang sah, mis. 1.250.000." };
    if (t.startsWith("-") && /[1-9]/.test(t)) return { galat: "Nominal tidak boleh negatif." };
    const pecahan = t.split(".")[1] ?? "";
    if (pecahan.length > 2) return { galat: "Maksimal 2 angka di belakang koma." };
    let sen: number;
    try { sen = Math.abs(keSen(t)); } catch { return { galat: "Nominal maksimal Rp 100.000.000.000." }; }
    if (sen > MAKS_NOMINAL * 100) return { galat: "Nominal maksimal Rp 100.000.000.000." };
    const sisa = sen % 100;
    return { sen, teks: sisa === 0 ? String(sen / 100) : `${Math.trunc(sen / 100)}.${String(sisa).padStart(2, "0").replace(/0$/, "")}` };
}

const ISIAN_FMT = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2, useGrouping: true });
/**
 * Angka (nilai tersimpan / sel Excel) -> teks isian id-ID yang dibaca balik nominalKeTeks ke angka yang SAMA ("1.500.000", "1.250,5").
 * null bila tidak bisa bolak-balik tepat: negatif, > 2 desimal, bukan angka berhingga, atau di atas MAKS_NOMINAL.
 */
export function isianNominal(n: number): string | null {
    if (!Number.isFinite(n) || n < 0 || n > MAKS_NOMINAL || !/^\d+(\.\d{1,2})?$/.test(String(n))) return null;
    return ISIAN_FMT.format(n);
}

/**
 * Teks desimal kanonik ("1500000", "1250000.5") -> teks isian SAAT FOKUS: angka polos tanpa pemisah ribuan, desimal berkoma ("1250000,5").
 * Menyunting "1500000" tidak pernah menghasilkan teks bertitik yang terbaca desimal (tinjauan K3 S-1). Teks lain dikembalikan apa adanya.
 */
export const isianPolos = (kanonik: string) => (/^-?\d+(\.\d+)?$/.test(kanonik) ? kanonik.replace(".", ",") : kanonik);
