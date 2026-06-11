/*
 * Tujuan: Pencocokan filter tanggal yang diketik user dengan format DD-MM-YYYY
 *         (tanggal-bulan-tahun), mendukung input bertahap (11 / 11-06 / 11-06-2026).
 * Caller: Filter kolom tanggal di "Engine Filter Kolom Data" halaman Payments.
 * Dependensi: lib/fuzzySearch (fallback bila nilai tersimpan tak bisa di-parse).
 * Main Functions: parseAnyDate, matchDmyDateFilter.
 * Side Effects: Tidak ada (pure utility).
 */

import { fuzzyMatch } from "@/lib/fuzzySearch";

function pad2(value: string | number): string {
    return String(value).padStart(2, "0");
}

export type ParsedDate = { d: string; m: string; y: string };

/**
 * Parse nilai tanggal tersimpan ke komponen ter-normalisasi (d,m 2 digit; y 4 digit).
 * Toleran terhadap beberapa format umum; kembalikan null jika tak dikenali.
 *
 * Didukung:
 *  - YYYY-MM-DD (format penyimpanan utama via formatDateForApi)
 *  - DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY
 *  - fallback Date(value) bila valid
 */
export function parseAnyDate(value: unknown): ParsedDate | null {
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;

    // YYYY-MM-DD (boleh diikuti waktu / pemisah lain)
    const ymd = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (ymd) {
        return { d: pad2(ymd[3]), m: pad2(ymd[2]), y: ymd[1] };
    }

    // DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY
    const dmy = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (dmy) {
        return { d: pad2(dmy[1]), m: pad2(dmy[2]), y: dmy[3] };
    }

    // Fallback: biarkan Date mencoba (mis. "Jun 11 2026", ISO dengan waktu).
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
        return {
            d: pad2(parsed.getDate()),
            m: pad2(parsed.getMonth() + 1),
            y: String(parsed.getFullYear()),
        };
    }

    return null;
}

/**
 * Cocokkan satu segmen query terhadap komponen tanggal (hari/bulan).
 * Mendukung input bertahap dan unpadded:
 *  - "6" / "06" cocok dengan "06"
 *  - "1" cocok awalan "1x" (mis. 10-19) — startsWith
 */
function segmentMatchesDayMonth(component: string, seg: string): boolean {
    if (!seg) return true;
    if (component === pad2(seg)) return true;
    if (component.startsWith(seg)) return true;
    if (Number(component) === Number(seg)) return true;
    return false;
}

/**
 * Cocokkan filter tanggal yang diketik user (format DD-MM-YYYY, bertahap)
 * terhadap nilai tanggal tersimpan.
 *
 * Aturan:
 *  - query kosong  → true (filter mati)
 *  - nilai tak ter-parse → fallback fuzzyMatch (string mentah tetap bisa dicari)
 *  - segmen yang ADA harus cocok semua (AND): seg0=hari, seg1=bulan, seg2=tahun
 *
 * @example
 * matchDmyDateFilter("2026-06-11", "11")          // true (hari 11)
 * matchDmyDateFilter("2026-06-11", "11-06")       // true (11 Juni)
 * matchDmyDateFilter("2026-06-11", "11-06-2026")  // true (persis)
 * matchDmyDateFilter("2026-06-11", "11-07")       // false (bulan beda)
 */
export function matchDmyDateFilter(storedValue: unknown, query: string): boolean {
    if (!query || !query.trim()) return true;

    const parsed = parseAnyDate(storedValue);
    if (!parsed) {
        // Tak bisa di-parse sebagai tanggal → jangan regresi, pakai fuzzy.
        return fuzzyMatch(storedValue, query);
    }

    // Normalisasi query: samakan pemisah ke "-", buang pemisah ganda/tepi.
    const segs = query
        .toLowerCase()
        .replace(/[/.\s]+/g, "-")
        .split("-")
        .filter(Boolean);

    if (segs.length === 0) return true;

    const [segDay, segMonth, segYear] = segs;

    if (segDay && !segmentMatchesDayMonth(parsed.d, segDay)) return false;
    if (segMonth && !segmentMatchesDayMonth(parsed.m, segMonth)) return false;
    if (segYear) {
        // Tahun: dukung pengetikan progresif dari depan (2 / 20 / 202 / 2026)
        // dan akhiran 2 digit (26 → 2026). Hindari `includes` agar fragmen
        // pendek (mis. "2", "0") tidak mencocokkan banyak tahun secara tak terduga.
        const yearOk = parsed.y.startsWith(segYear) || (segYear.length >= 2 && parsed.y.endsWith(segYear));
        if (!yearOk) return false;
    }

    return true;
}
