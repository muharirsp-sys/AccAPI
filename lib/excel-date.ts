/*
 * Tujuan: Ubah tanggal sel Excel menjadi "YYYY-MM-DD" tanpa meleset satu hari.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (upload progress harian).
 * Dependensi: Tidak ada.
 * Main Functions: excelDateToIso.
 * Side Effects: Tidak ada; fungsi murni.
 */

const HARI_MS = 86_400_000;
/** SheetJS meleset 25 detik; 5 menit memberi ruang tanpa menyentuh jam kerja mana pun. */
const TOLERANSI_MS = 5 * 60_000;

/**
 * SheetJS (`cellDates: true`) mengubah serial tanggal Excel jadi **23:59:35 hari SEBELUMNYA**,
 * bukan 00:00:00 hari itu. Nyata terjadi: nota INV/2607/SZ00036 bertanggal 2026-07-03 di Excel
 * terbaca "Thu Jul 02 2026 23:59:35" (diverifikasi silang dengan openpyxl, 2026-08-26).
 *
 * Akibatnya SELURUH baris harian tersimpan mundur satu hari. Itu bukan cuma kosmetik: karena
 * penggantian data harian bekerja per tanggal, baris upload lama yang bertanggal benar tidak
 * pernah tertimpa, jadi realisasi menumpuk. Kasus M-MC2 Juli 2026: AO 254 di web vs 195 di
 * file, selisih persis 59 dari lima tanggal yang tertinggal.
 *
 * Perbaikannya membulatkan ke tengah malam LOKAL terdekat, jadi 23:59:35 naik ke hari
 * berikutnya (nilai yang benar) dan 00:00:00 tidak bergerak.
 */
export function excelDateToIso(raw: unknown): string | null {
    if (raw === null || raw === undefined || raw === "") return null;
    const d = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(d.getTime())) return null;
    // Geser ke "jam dinding" supaya perhitungan memakai hari lokal, bukan hari UTC.
    const wallClock = d.getTime() - d.getTimezoneOffset() * 60_000;
    const awalHari = Math.floor(wallClock / HARI_MS) * HARI_MS;
    const sisa = wallClock - awalHari;
    // Hanya nilai yang MENEMPEL di tengah malam yang dinaikkan. Membulatkan ke hari terdekat
    // akan melempar transaksi jam 13:00 ke besok, seandainya file closing suatu saat memuat
    // jam sungguhan dan bukan 00:00 seperti sekarang.
    const menempelTengahMalam = HARI_MS - sisa <= TOLERANSI_MS;
    return new Date(menempelTengahMalam ? awalHari + HARI_MS : awalHari).toISOString().slice(0, 10);
}
