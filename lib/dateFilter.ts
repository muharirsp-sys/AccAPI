/*
 * Tujuan: Normalisasi nilai tanggal tersimpan ke komponen (d,m,y) untuk
 *         pencocokan filter tanggal berbasis kalender (exact match YYYY-MM-DD).
 * Caller: matchExactApiDate pada filter kolom tanggal halaman Payments.
 * Dependensi: Tidak ada.
 * Main Functions: parseAnyDate.
 * Side Effects: Tidak ada (pure utility).
 */

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
