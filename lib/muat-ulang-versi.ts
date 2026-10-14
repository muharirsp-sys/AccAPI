/*
 * Tujuan: Kenali galat "versi lama" — tab dibuka sebelum deploy lalu memuat berkas JS/CSS build lama yang sudah tidak ada
 *   (ChunkLoadError) — dan izinkan muat ulang halaman otomatis SEKALI. Tanpa ini error boundary menampilkan "Terjadi kesalahan"
 *   dan "Coba lagi" (reset) tidak menolong karena berkasnya tetap tidak ada (kasus Rekapan Nota sesudah rilis #172, 13 Okt 2026).
 * Caller: app/(dashboard)/error.tsx, app/global-error.tsx.
 * Main Functions: galatVersiLama, bolehMuatUlang.
 * Side Effects: bolehMuatUlang menulis cap waktu ke sessionStorage tab ini.
 */

const POLA = /ChunkLoadError|Failed to load chunk|Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;
const KUNCI = "accapi:muat-ulang-versi";

export function galatVersiLama(e: { name?: string; message?: string } | null | undefined): boolean {
    return Boolean(e) && POLA.test(`${e?.name ?? ""} ${e?.message ?? ""}`);
}

// ponytail: paling banyak sekali per 60 dtk per tab supaya tidak berputar bila berkas memang rusak; storage diblokir = tidak
// muat ulang otomatis (tombol "Coba lagi" tetap memuat ulang penuh).
export function bolehMuatUlang(sekarang = Date.now(), simpan?: Pick<Storage, "getItem" | "setItem">): boolean {
    try {
        const s = simpan ?? window.sessionStorage;
        if (sekarang - Number(s.getItem(KUNCI) ?? 0) < 60_000) return false;
        s.setItem(KUNCI, String(sekarang));
        return true;
    } catch {
        return false;
    }
}
