/*
 * Tujuan: Satu sumber format tampilan lintas modul (audit desain 001: No 29 nilai kosong tanpa em dash, No 30 sebab galat
 *   tanpa kode HTTP mentah, No 31 tanggal WITA dd/mm/yyyy). Hanya teks tampilan; tidak menyentuh nilai yang dikirim ke server.
 * Caller: halaman dan helper *-ui yang menampilkan tanggal, nilai kosong, atau pesan gagal.
 * Dependensi: Intl (Asia/Makassar).
 * Main Functions: KOSONG, tanggalWita, waktuWita, hariIniWita, sebabHttp.
 * Side Effects: Tidak ada.
 */

/** Penanda nilai kosong di sel/atribut. Bukan em dash (antislop R-02). */
export const KOSONG = "-";

const ZONA = "Asia/Makassar";
const tanggalFmt = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: ZONA });
const jamFmt = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ZONA });

function keDate(v: string | number | Date | null | undefined): Date | null {
    if (v === null || v === undefined || v === "") return null;
    // ponytail: "yyyy-mm-dd" murni adalah tanggal kalender, bukan waktu UTC; dibaca apa adanya supaya tidak bergeser hari.
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T12:00:00+08:00`);
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** "06/10/2026" menurut WITA; kosong → KOSONG. */
export function tanggalWita(v: string | number | Date | null | undefined): string {
    const d = keDate(v);
    return d ? tanggalFmt.format(d) : KOSONG;
}

/** "06/10/2026 09.40" menurut WITA; kosong → KOSONG. */
export function waktuWita(v: string | number | Date | null | undefined): string {
    const d = keDate(v);
    return d ? `${tanggalFmt.format(d)} ${jamFmt.format(d)}` : KOSONG;
}

/** Tanggal hari ini di WITA sebagai "yyyy-mm-dd" (nilai awal input type=date), bukan jam perangkat. */
export function hariIniWita(now = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ZONA }).format(now);
}

/** Sebab + langkah untuk status gagal, tanpa kode mentah. 0 = tidak ada jawaban (koneksi). */
export function sebabHttp(status: number): string {
    if (status === 0) return "Server tidak menjawab. Periksa koneksi, lalu coba lagi.";
    if (status === 401) return "Sesi login berakhir. Masuk ulang, lalu coba lagi.";
    if (status === 403) return "Akun Anda tidak punya izin untuk tindakan ini.";
    if (status === 404) return "Data tidak ditemukan. Mungkin sudah dihapus atau dipindah.";
    if (status === 409) return "Data sudah diubah orang lain. Muat ulang, lalu periksa lagi.";
    if (status === 413) return "Berkas terlalu besar.";
    if (status === 400 || status === 422) return "Isian belum lengkap atau tidak sesuai menurut server.";
    if (status === 429) return "Terlalu banyak permintaan. Tunggu sebentar, lalu coba lagi.";
    if (status >= 500) return "Server sedang bermasalah. Coba lagi beberapa saat lagi.";
    return "Permintaan gagal diproses.";
}
